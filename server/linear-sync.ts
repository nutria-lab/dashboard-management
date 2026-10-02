import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPrismaClient } from "./db.js";
import {
  fetchMetadata,
  fetchOpenTasksPage,
  fetchAllTasksPage,
  fetchTask,
  fetchTaskHistory,
  getLinearTeamId,
  getLinearReviewStateId,
  LinearApiError,
} from "./linear-api.js";
import { resolveTaskSnapshot } from "./linear.js";
import type { LinearTaskData } from "./sync-types.js";
import type { SyncStatus } from "../shared/types.js";

const SYNC_INTERVAL = 5 * 60_000;
const LEASE_DURATION = 90_000;
const WORK_BUDGET = 45_000;

export async function getSyncStatus(
  sprintId?: string | null,
): Promise<SyncStatus> {
  const db = getPrismaClient();
  const teamId = getLinearTeamId();
  const [state, sprint, pendingEvents] = await Promise.all([
    db.linearSyncState.findUnique({ where: { teamId } }),
    sprintId ? db.sprintSync.findUnique({ where: { sprintId } }) : null,
    db.webhookEvent.count({ where: { teamId, processedAt: null } }),
  ]);
  const cooldown = sprint?.lastSyncedAt
    ? new Date(sprint.lastSyncedAt.getTime() + SYNC_INTERVAL)
    : null;
  const retryAt =
    [state?.retryAt, cooldown]
      .filter((date): date is Date => !!date && date.getTime() > Date.now())
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    lastSyncedAt: sprint?.lastSyncedAt?.toISOString() ?? null,
    retryAt: retryAt?.toISOString() ?? null,
    syncing: !!state?.leaseUntil && state.leaseUntil.getTime() > Date.now(),
    pendingEvents,
    importComplete: state?.bootstrapComplete ?? false,
    webhookConfigured: !!process.env.LINEAR_WEBHOOK_SECRET,
    error: state?.lastError ?? null,
  };
}

async function acquireLease(): Promise<string | null> {
  const db = getPrismaClient();
  const teamId = getLinearTeamId();
  await db.linearSyncState.upsert({
    where: { teamId },
    create: { teamId },
    update: {},
  });
  const owner = randomUUID();
  const now = new Date();
  const claimed = await db.linearSyncState.updateMany({
    where: {
      teamId,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        { OR: [{ retryAt: null }, { retryAt: { lte: now } }] },
      ],
    },
    data: {
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + LEASE_DURATION),
    },
  });
  return claimed.count ? owner : null;
}
async function renewLease(owner: string) {
  const result = await getPrismaClient().linearSyncState.updateMany({
    where: { teamId: getLinearTeamId(), leaseOwner: owner },
    data: { leaseUntil: new Date(Date.now() + LEASE_DURATION) },
  });
  if (!result.count) throw new Error("Synchronization lease lost.");
}
async function releaseLease(owner: string) {
  await getPrismaClient().linearSyncState.updateMany({
    where: { teamId: getLinearTeamId(), leaseOwner: owner },
    data: { leaseOwner: null, leaseUntil: null },
  });
}
async function recordFailure(owner: string, error: unknown) {
  const limited = error instanceof LinearApiError && error.rateLimited;
  const retryAt = limited
    ? (error.retryAt ?? new Date(Date.now() + 15 * 60_000))
    : new Date(Date.now() + 60_000);
  await getPrismaClient().linearSyncState.updateMany({
    where: { teamId: getLinearTeamId(), leaseOwner: owner },
    data: {
      retryAt,
      lastError: limited
        ? "Linear rate limit reached. Stored data remains available."
        : "Synchronization failed. Stored data remains available; retry is scheduled.",
    },
  });
}
async function clearFailure(owner: string) {
  await getPrismaClient().linearSyncState.updateMany({
    where: { teamId: getLinearTeamId(), leaseOwner: owner },
    data: { retryAt: null, lastError: null },
  });
}

async function ensureMetadata(owner: string, deadline?: number) {
  const db = getPrismaClient();
  const state = await db.linearSyncState.findUniqueOrThrow({
    where: { teamId: getLinearTeamId() },
  });
  if (
    state.metadataSyncedAt &&
    Date.now() - state.metadataSyncedAt.getTime() < 86_400_000 &&
    state.openStateIds.length
  )
    return state;
  await renewLease(owner);
  const metadata = await fetchMetadata(deadline);
  await renewLease(owner);
  await db.$transaction(async (tx) => {
    for (const sprint of metadata.sprints)
      await tx.sprint.upsert({
        where: { id: sprint.id },
        create: {
          id: sprint.id,
          name: sprint.name,
          startsAt: new Date(sprint.startsAt),
          endsAt: new Date(sprint.endsAt),
        },
        update: {
          name: sprint.name,
          startsAt: new Date(sprint.startsAt),
          endsAt: new Date(sprint.endsAt),
        },
      });
    for (const student of metadata.students)
      await tx.student.upsert({
        where: { id: student.id },
        create: student,
        update: { name: student.name },
      });
  });
  return db.linearSyncState.update({
    where: { teamId: getLinearTeamId() },
    data: { metadataSyncedAt: new Date(), openStateIds: metadata.openStateIds },
  });
}

/** One successful delivery snapshot is immutable, including later rework events. */
export async function storeLinearTask(
  task: LinearTaskData,
  owner: string,
  deadline?: number,
): Promise<void> {
  const db = getPrismaClient();
  if (task.teamId !== getLinearTeamId()) {
    await db.linearTask.updateMany({
      where: { id: task.id, deliveryFrozen: false },
      data: { removed: true },
    });
    return;
  }
  const previous = await db.linearTask.findUnique({ where: { id: task.id } });
  if (previous?.deliveryFrozen) return;
  const updatedAt = new Date(task.updatedAt);
  if (
    previous &&
    previous.linearUpdatedAt.getTime() >= updatedAt.getTime() &&
    !previous.detailPending &&
    !previous.removed
  )
    return;
  const delivered =
    task.stateId === getLinearReviewStateId() || task.stateType === "completed";
  let delivery: {
    deliveredAt: Date | null;
    dueDate: string | null;
    studentId: string | null;
    studentName: string | null;
    sprintId: string | null;
    incompleteReason: string | null;
  } | null = null;
  if (delivered) {
    await renewLease(owner);
    const history = await fetchTaskHistory(task.id, deadline);
    const resolved = resolveTaskSnapshot(
      {
        dueDate: task.dueDate,
        assigneeId: task.assigneeId,
        cycleId: task.sprintId,
        stateId: task.stateId,
        stateType: task.stateType,
        completedAt: task.completedAt,
      },
      history,
      getLinearReviewStateId(),
      new Date(),
    );
    const snapshot = resolved?.snapshot;
    const student = snapshot?.assigneeId
      ? await db.student.findUnique({ where: { id: snapshot.assigneeId } })
      : null;
    delivery = {
      deliveredAt: snapshot ? new Date(snapshot.deliveredAt) : null,
      dueDate: snapshot?.dueDate ?? null,
      studentId: snapshot?.assigneeId ?? null,
      studentName:
        snapshot?.assigneeId === task.assigneeId
          ? task.assigneeName
          : (student?.name ?? null),
      sprintId: snapshot?.cycleId ?? null,
      incompleteReason: snapshot
        ? null
        : "No verified Review transition or completion timestamp is available.",
    };
  }
  await renewLease(owner);
  const values = {
    identifier: task.identifier,
    title: task.title,
    url: task.url,
    teamId: task.teamId,
    sprintId: task.sprintId,
    assigneeId: task.assigneeId,
    assigneeName: task.assigneeName,
    stateId: task.stateId,
    stateName: task.stateName,
    stateType: task.stateType,
    dueDate: task.dueDate,
    linearUpdatedAt: updatedAt,
    completedAt: task.completedAt ? new Date(task.completedAt) : null,
    deliveryFrozen: delivered,
    removed: false,
    detailPending: false,
  };
  await db.$transaction(async (tx) => {
    await tx.linearTask.upsert({
      where: { id: task.id },
      create: { id: task.id, ...values },
      update: values,
    });
    if (delivery)
      await tx.deliveryRecord.createMany({
        data: [{ issueId: task.id, ...delivery }],
        skipDuplicates: true,
      });
  });
}

async function drainEvents(owner: string, deadline: number) {
  const db = getPrismaClient();
  const attempted = new Set<string>();
  while (Date.now() < deadline) {
    const events = await db.webhookEvent.findMany({
      where: {
        teamId: getLinearTeamId(),
        processedAt: null,
        deliveryId: { notIn: [...attempted] },
      },
      orderBy: [{ eventAt: "asc" }, { deliveryId: "asc" }],
      take: 20,
    });
    if (!events.length) break;
    for (const event of events) {
      if (Date.now() >= deadline) break;
      attempted.add(event.deliveryId);
      try {
        const previous = await db.linearTask.findUnique({
          where: { id: event.issueId },
        });
        const payload = event.payload as { data?: { updatedAt?: string } };
        const eventUpdatedAt = payload.data?.updatedAt
          ? new Date(payload.data.updatedAt)
          : event.eventAt;
        const stale =
          previous &&
          (event.action === "remove"
            ? previous.linearUpdatedAt.getTime() > eventUpdatedAt.getTime()
            : previous.linearUpdatedAt.getTime() >= eventUpdatedAt.getTime()) &&
          !previous.detailPending;
        if (!previous?.deliveryFrozen && !stale) {
          await renewLease(owner);
          if (event.action === "remove") {
            await db.linearTask.updateMany({
              where: { id: event.issueId, deliveryFrozen: false },
              data: { removed: true, linearUpdatedAt: eventUpdatedAt },
            });
          } else {
            const task = await fetchTask(event.issueId, deadline);
            if (task) await storeLinearTask(task, owner, deadline);
            else
              await db.linearTask.updateMany({
                where: { id: event.issueId, deliveryFrozen: false },
                data: { removed: true },
              });
          }
        }
        await renewLease(owner);
        await db.webhookEvent.update({
          where: { deliveryId: event.deliveryId },
          data: { processedAt: new Date(), error: null },
        });
      } catch (error) {
        await db.webhookEvent.update({
          where: { deliveryId: event.deliveryId },
          data: {
            error: "Processing failed; the event remains pending for retry.",
          },
        });
        // A bad event must not starve the rest of the inbox. Rate limits and
        // exhausted budgets stop the entire worker so no more API calls start.
        if (
          (error instanceof LinearApiError && error.rateLimited) ||
          Date.now() >= deadline
        )
          throw error;
      }
    }
  }
}

export async function processWebhookEvents(): Promise<void> {
  const deadline = Date.now() + WORK_BUDGET;
  if (
    !(await getPrismaClient().webhookEvent.count({
      where: { teamId: getLinearTeamId(), processedAt: null },
    }))
  )
    return;
  const owner = await acquireLease();
  if (!owner) return;
  try {
    await ensureMetadata(owner, deadline);
    await drainEvents(owner, deadline);
    await clearFailure(owner);
  } catch (error) {
    await recordFailure(owner, error);
  } finally {
    await releaseLease(owner);
  }
}

export async function synchronizeSprint(sprintId: string): Promise<SyncStatus> {
  z.string().uuid().parse(sprintId);
  const owner = await acquireLease();
  if (!owner) return getSyncStatus(sprintId);
  const db = getPrismaClient();
  const deadline = Date.now() + WORK_BUDGET;
  try {
    const state = await ensureMetadata(owner, deadline);
    await drainEvents(owner, deadline);
    const previousSync = await db.sprintSync.findUnique({
      where: { sprintId },
    });
    if (
      !previousSync?.lastSyncedAt ||
      Date.now() - previousSync.lastSyncedAt.getTime() >= SYNC_INTERVAL
    ) {
      const knownOpen = await db.linearTask.findMany({
        where: {
          teamId: getLinearTeamId(),
          sprintId,
          deliveryFrozen: false,
          removed: false,
          stateId: { in: state.openStateIds },
        },
        select: { id: true },
      });
      const openTasks: LinearTaskData[] = [];
      let cursor: string | null = null;
      do {
        if (Date.now() >= deadline)
          throw new Error("Synchronization will continue on the next attempt.");
        await renewLease(owner);
        const page = await fetchOpenTasksPage(
          sprintId,
          state.openStateIds,
          cursor,
          deadline,
        );
        openTasks.push(...page.tasks);
        cursor = page.nextCursor;
      } while (cursor);
      const seen = new Set(openTasks.map((task) => task.id));
      for (const task of openTasks) {
        if (Date.now() >= deadline)
          throw new Error("Synchronization will continue on the next attempt.");
        await storeLinearTask(task, owner, deadline);
      }
      for (const task of knownOpen) {
        if (seen.has(task.id)) continue;
        if (Date.now() >= deadline)
          throw new Error("Synchronization will continue on the next attempt.");
        // Re-check frozen state: the inbox may already have recorded this delivery.
        const stored = await db.linearTask.findUnique({
          where: { id: task.id },
        });
        if (stored?.deliveryFrozen) continue;
        await renewLease(owner);
        const current = await fetchTask(task.id, deadline);
        if (current) await storeLinearTask(current, owner, deadline);
        else
          await db.linearTask.updateMany({
            where: { id: task.id, deliveryFrozen: false },
            data: { removed: true },
          });
      }
      await renewLease(owner);
      await db.sprintSync.upsert({
        where: { sprintId },
        create: { sprintId, lastSyncedAt: new Date() },
        update: { lastSyncedAt: new Date() },
      });
    }
    await clearFailure(owner);
  } catch (error) {
    await recordFailure(owner, error);
  } finally {
    await releaseLease(owner);
  }
  return getSyncStatus(sprintId);
}

export async function importLinearHistory(): Promise<void> {
  const owner = await acquireLease();
  if (!owner)
    throw new Error(
      "Import paused: synchronization is running or Linear is temporarily rate limited.",
    );
  const db = getPrismaClient();
  try {
    let state = await ensureMetadata(owner);
    if (state.bootstrapComplete) return;
    const seenCursors = new Set<string>();
    if (state.bootstrapCursor) seenCursors.add(state.bootstrapCursor);
    while (!state.bootstrapListed) {
      await renewLease(owner);
      const page = await fetchAllTasksPage(state.bootstrapCursor);
      if (page.nextCursor && seenCursors.has(page.nextCursor))
        throw new Error("Linear returned a repeated import cursor.");
      if (page.nextCursor) seenCursors.add(page.nextCursor);
      for (const task of page.tasks) await storeLinearTask(task, owner);
      await renewLease(owner);
      state = await db.linearSyncState.update({
        where: { teamId: getLinearTeamId() },
        data: {
          bootstrapCursor: page.nextCursor,
          bootstrapListed: !page.nextCursor,
        },
      });
      console.log(
        `Historical import: persisted ${page.tasks.length} tasks; ${page.nextCursor ? "more pages remain" : "listing complete"}.`,
      );
    }
    await db.linearSyncState.update({
      where: { teamId: getLinearTeamId() },
      data: { bootstrapComplete: true, retryAt: null, lastError: null },
    });
    console.log(
      "Historical import complete. Re-running the import will not query task histories again.",
    );
  } catch (error) {
    await recordFailure(owner, error);
    throw new Error(
      "Historical import paused. Stored progress is retained; check synchronization status before retrying.",
    );
  } finally {
    await releaseLease(owner);
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearTaskData } from "./sync-types.js";
type Row = Record<string, unknown>;
const mock = vi.hoisted(() => ({
  db: {} as Row,
  open: vi.fn(),
  all: vi.fn(),
  task: vi.fn(),
  history: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock("./db.js", () => ({ getPrismaClient: () => mock.db }));
vi.mock("./linear-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./linear-api.js")>()),
  fetchMetadata: mock.metadata,
  fetchOpenTasksPage: mock.open,
  fetchAllTasksPage: mock.all,
  fetchTask: mock.task,
  fetchTaskHistory: mock.history,
}));
import {
  getSyncStatus,
  importLinearHistory,
  processWebhookEvents,
  storeLinearTask,
  synchronizeSprint,
} from "./linear-sync.js";
import { LinearApiError } from "./linear-api.js";
const teamId = "1334836d-3538-443b-a490-524d01b39f85";
const sprintId = "00000000-0000-4000-8000-000000000001";
const studentId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
let tasks: Map<string, Row>;
let deliveries: Map<string, Row>;
let events: Map<string, Row>;
let controls: Map<string, Row>;
let sprintSyncs: Map<string, Row>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Row[]).every((part) => matches(row, part));
    if (key === "OR")
      return (value as Row[]).some((part) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as Row;
      if (condition.in) return (condition.in as unknown[]).includes(actual);
      if (condition.notIn)
        return !(condition.notIn as unknown[]).includes(actual);
      if (condition.lte instanceof Date)
        return actual instanceof Date && actual <= condition.lte;
      if (condition.not !== undefined) return actual !== condition.not;
    }
    return actual === value;
  });
}
function model(rows: Map<string, Row>, key: string) {
  return {
    findUnique: vi.fn(
      async ({ where }: { where: Row }) => rows.get(String(where[key])) ?? null,
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
      const row = rows.get(String(where[key]));
      if (!row) throw new Error("Not found");
      return row;
    }),
    findMany: vi.fn(
      async ({ where = {}, take }: { where?: Row; take?: number } = {}) =>
        [...rows.values()].filter((row) => matches(row, where)).slice(0, take),
    ),
    count: vi.fn(
      async ({ where = {} }: { where?: Row }) =>
        [...rows.values()].filter((row) => matches(row, where)).length,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Row;
        create: Row;
        update: Row;
      }) => {
        const id = String(where[key]);
        const row = rows.has(id)
          ? { ...rows.get(id), ...update }
          : { ...create };
        rows.set(id, row);
        return row;
      },
    ),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const id = String(where[key]);
      const row = { ...rows.get(id), ...data };
      rows.set(id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const [id, row] of rows)
        if (matches(row, where)) {
          rows.set(id, { ...row, ...data });
          count++;
        }
      return { count };
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const row of data)
        if (!rows.has(String(row[key]))) {
          rows.set(String(row[key]), row);
          count++;
        }
      return { count };
    }),
  };
}
function task(extra: Partial<LinearTaskData> = {}): LinearTaskData {
  return {
    id: issueId,
    identifier: "NUT-1",
    title: "Task",
    url: "https://linear.app/example",
    teamId,
    sprintId,
    assigneeId: studentId,
    assigneeName: "Student",
    stateId: "progress",
    stateName: "In Progress",
    stateType: "started",
    dueDate: "2026-09-30",
    updatedAt: "2026-10-02T17:00:00Z",
    completedAt: null,
    ...extra,
  };
}
function seedTask(extra: Row = {}) {
  const input = task();
  tasks.set(issueId, {
    ...input,
    linearUpdatedAt: new Date(input.updatedAt),
    deliveryFrozen: false,
    removed: false,
    detailPending: false,
    ...extra,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T18:00:00Z"));
  vi.stubEnv("LINEAR_TEAM_ID", teamId);
  vi.stubEnv("LINEAR_REVIEW_STATE_ID", "review");
  vi.clearAllMocks();
  tasks = new Map();
  deliveries = new Map();
  events = new Map();
  sprintSyncs = new Map();
  controls = new Map([
    [
      teamId,
      {
        teamId,
        leaseOwner: null,
        leaseUntil: null,
        retryAt: null,
        lastError: null,
        bootstrapCursor: null,
        bootstrapListed: false,
        bootstrapComplete: false,
        metadataSyncedAt: new Date(),
        openStateIds: ["todo", "progress"],
      },
    ],
  ]);
  mock.db = {
    linearTask: model(tasks, "id"),
    deliveryRecord: model(deliveries, "issueId"),
    webhookEvent: model(events, "deliveryId"),
    linearSyncState: model(controls, "teamId"),
    sprintSync: model(sprintSyncs, "sprintId"),
    student: model(
      new Map([[studentId, { id: studentId, name: "Student" }]]),
      "id",
    ),
    sprint: model(new Map(), "id"),
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(mock.db),
  };
  mock.open.mockResolvedValue({ tasks: [], nextCursor: null });
  mock.history.mockResolvedValue([
    {
      createdAt: "2026-10-01T18:00:00Z",
      fromStateId: "progress",
      toStateId: "review",
    },
  ]);
  mock.task.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("hybrid synchronization", () => {
  it("updates open tasks without histories and coalesces simultaneous sync requests", async () => {
    mock.open.mockResolvedValue({ tasks: [task()], nextCursor: null });
    await Promise.all([
      synchronizeSprint(sprintId),
      synchronizeSprint(sprintId),
    ]);
    expect(mock.open).toHaveBeenCalledOnce();
    expect(mock.history).not.toHaveBeenCalled();
    expect(tasks.get(issueId)?.deliveryFrozen).toBe(false);
    await synchronizeSprint(sprintId);
    expect(mock.open).toHaveBeenCalledOnce();
    expect((await getSyncStatus(sprintId)).lastSyncedAt).toBeTruthy();
  });
  it("detects a missing known task without a webhook and freezes its historical delivery", async () => {
    seedTask();
    mock.task.mockResolvedValue(
      task({
        stateId: "review",
        stateName: "In Review",
        updatedAt: "2026-10-02T18:00:00Z",
      }),
    );
    await synchronizeSprint(sprintId);
    expect(mock.task).toHaveBeenCalledWith(issueId, expect.any(Number));
    expect(mock.history).toHaveBeenCalledOnce();
    expect(deliveries.get(issueId)).toMatchObject({
      dueDate: "2026-09-30",
      sprintId,
      deliveredAt: new Date("2026-10-01T18:00:00Z"),
    });
    vi.advanceTimersByTime(5 * 60_000);
    await synchronizeSprint(sprintId);
    expect(mock.task).toHaveBeenCalledOnce();
    expect(mock.history).toHaveBeenCalledOnce();
    await storeLinearTask(
      task({
        dueDate: "2026-10-10",
        stateId: "done",
        stateType: "completed",
        updatedAt: "2026-10-03T18:00:00Z",
      }),
      "ignored-for-frozen-task",
    );
    expect(deliveries.get(issueId)?.dueDate).toBe("2026-09-30");
  });
  it("does not mistake movement to another sprint or Backlog for delivery", async () => {
    seedTask();
    mock.task.mockResolvedValue(
      task({
        sprintId: "other-sprint",
        stateId: "backlog",
        stateName: "Backlog",
        stateType: "backlog",
        updatedAt: "2026-10-02T18:00:00Z",
      }),
    );
    await synchronizeSprint(sprintId);
    expect(deliveries.size).toBe(0);
    expect(mock.history).not.toHaveBeenCalled();
    expect(tasks.get(issueId)?.sprintId).toBe("other-sprint");
  });
  it("does not infer disappearance from an incomplete paginated listing", async () => {
    seedTask();
    mock.open
      .mockResolvedValueOnce({ tasks: [], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("Network unavailable"));
    await synchronizeSprint(sprintId);
    expect(mock.task).not.toHaveBeenCalled();
    expect(tasks.get(issueId)?.deliveryFrozen).toBe(false);
    expect(sprintSyncs.size).toBe(0);
  });
  it("ignores old and frozen webhook events without individual task requests", async () => {
    seedTask({ deliveryFrozen: true });
    events.set("one", {
      deliveryId: "one",
      issueId,
      teamId,
      action: "update",
      eventAt: new Date(),
      payload: { data: { updatedAt: "2026-10-02T18:00:00Z" } },
      processedAt: null,
    });
    await processWebhookEvents();
    expect(mock.task).not.toHaveBeenCalled();
    expect(events.get("one")?.processedAt).toBeInstanceOf(Date);
    seedTask();
    events.set("two", {
      deliveryId: "two",
      issueId,
      teamId,
      action: "update",
      eventAt: new Date("2026-10-01T18:00:00Z"),
      payload: { data: { updatedAt: "2026-10-01T18:00:00Z" } },
      processedAt: null,
    });
    await processWebhookEvents();
    expect(mock.task).not.toHaveBeenCalled();
  });
  it("retains import progress after failure and skips histories already persisted when resumed", async () => {
    const delivered = task({ stateId: "review", stateName: "In Review" });
    mock.all
      .mockResolvedValueOnce({ tasks: [delivered], nextCursor: "second-page" })
      .mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(importLinearHistory()).rejects.toThrow("paused");
    expect(controls.get(teamId)?.bootstrapCursor).toBe("second-page");
    expect(mock.history).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(61_000);
    mock.all.mockResolvedValue({ tasks: [delivered], nextCursor: null });
    await importLinearHistory();
    expect(mock.all).toHaveBeenLastCalledWith("second-page");
    expect(mock.history).toHaveBeenCalledOnce();
    expect(controls.get(teamId)?.bootstrapComplete).toBe(true);
    mock.all.mockClear();
    await importLinearHistory();
    expect(mock.all).not.toHaveBeenCalled();
  });
  it("honors persistent rate-limit backoff without contacting Linear", async () => {
    controls.set(teamId, {
      ...controls.get(teamId),
      retryAt: new Date(Date.now() + 15 * 60_000),
      lastError: "Linear rate limit reached.",
    });
    const status = await synchronizeSprint(sprintId);
    expect(status.retryAt).toBeTruthy();
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.metadata).not.toHaveBeenCalled();
    expect(mock.task).not.toHaveBeenCalled();
    expect(LinearApiError).toBeDefined();
  });
  it("drains multiple inbox batches and does not let a poison event starve later deliveries", async () => {
    for (let index = 0; index < 25; index++)
      events.set(String(index), {
        deliveryId: String(index),
        issueId: `issue-${index}`,
        teamId,
        action: "update",
        eventAt: new Date(),
        payload: {},
        processedAt: null,
      });
    mock.task.mockRejectedValueOnce(new LinearApiError("Invalid issue"));
    await processWebhookEvents();
    expect(mock.task).toHaveBeenCalledTimes(25);
    expect(events.get("0")?.processedAt).toBeNull();
    expect(events.get("0")?.error).toContain("remains pending");
    expect(
      [...events.values()].filter((event) => event.processedAt),
    ).toHaveLength(24);
  });
  it("shares webhook and sprint leases, then recovers a delivery without another individual request", async () => {
    seedTask();
    events.set("one", {
      deliveryId: "one",
      issueId,
      teamId,
      action: "update",
      eventAt: new Date(),
      payload: {},
      processedAt: null,
    });
    mock.task.mockResolvedValue(
      task({
        stateId: "review",
        stateName: "In Review",
        updatedAt: "2026-10-02T18:00:00Z",
      }),
    );
    await Promise.all([processWebhookEvents(), synchronizeSprint(sprintId)]);
    await synchronizeSprint(sprintId);
    expect(mock.task).toHaveBeenCalledOnce();
    expect(mock.history).toHaveBeenCalledOnce();
    expect(events.get("one")?.processedAt).toBeInstanceOf(Date);
  });
  it("persists a real rate-limit failure and leaves the inbox pending until the reset", async () => {
    const reset = new Date(Date.now() + 900_000);
    events.set("one", {
      deliveryId: "one",
      issueId,
      teamId,
      action: "update",
      eventAt: new Date(),
      payload: {},
      processedAt: null,
    });
    mock.task.mockRejectedValue(
      new LinearApiError("Rate limited", true, reset),
    );
    await processWebhookEvents();
    expect(events.get("one")?.processedAt).toBeNull();
    expect(controls.get(teamId)?.retryAt).toEqual(reset);
    expect(controls.get(teamId)?.leaseOwner).toBeNull();
    await synchronizeSprint(sprintId);
    await processWebhookEvents();
    expect(mock.task).toHaveBeenCalledOnce();
    expect(mock.open).not.toHaveBeenCalled();
  });
});

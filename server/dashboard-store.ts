import type { Deliveries, Sprint } from "../shared/types.js";
import { getPrismaClient } from "./db.js";
import {
  calculateDaysLate,
  getLateBucket,
  isStudentAllowed,
  parseStudentAllowlist,
} from "./linear.js";

type StoredDeliveries = Omit<Deliveries, "justified">;
type DeliveryIssue = StoredDeliveries["issues"][number];
type IncompleteDelivery = StoredDeliveries["incomplete"][number];
type Counts = StoredDeliveries["students"][number]["counts"];

function emptyCounts(): Counts {
  return { one: 0, twoThree: 0, fourFive: 0, overFive: 0 };
}

function incrementCount(counts: Counts, bucket: keyof Counts): void {
  counts[bucket] += 1;
}

function isValidDueDate(value: string): boolean {
  try {
    calculateDaysLate(value, new Date(0));
    return true;
  } catch {
    return false;
  }
}

function incomplete(
  identifier: string,
  reasons: readonly (string | null | undefined)[],
): IncompleteDelivery | null {
  const message = [...new Set(reasons.filter((reason): reason is string => Boolean(reason)))].join(" ");
  return message ? { identifier, reason: message } : null;
}

function orderStudentSummaries(
  students: Map<string, StoredDeliveries["students"][number]>,
): StoredDeliveries["students"] {
  return [...students.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function toSprint(row: {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
}): Sprint | null {
  if (!row.startsAt || !row.endsAt) return null;
  return {
    id: row.id,
    name: row.name,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  };
}

export async function getStoredSprints(): Promise<Sprint[]> {
  const sprints = await getPrismaClient().sprint.findMany({
    where: { startsAt: { not: null }, endsAt: { not: null } },
    orderBy: { startsAt: "asc" },
  });

  return sprints.flatMap((row) => {
    const sprint = toSprint(row);
    return sprint ? [sprint] : [];
  });
}

export async function getStoredDeliveries(
  sprintId: string,
): Promise<StoredDeliveries> {
  if (!sprintId.trim()) throw new Error("Select a sprint.");

  const prisma = getPrismaClient();
  const studentAllowlist = parseStudentAllowlist(
    process.env.LINEAR_STUDENT_IDS,
  );
  const [studentRows, pendingTasks, frozenRecords, frozenSprintTasks] =
    await Promise.all([
      prisma.student.findMany(),
      prisma.linearTask.findMany({
        where: {
          sprintId,
          deliveryFrozen: false,
          removed: false,
          stateType: { notIn: ["canceled", "duplicate"] },
        },
        orderBy: [{ identifier: "asc" }, { id: "asc" }],
      }),
      prisma.deliveryRecord.findMany({
        where: { sprintId },
        orderBy: [{ issueId: "asc" }],
      }),
      prisma.linearTask.findMany({
        where: { sprintId, deliveryFrozen: true, removed: false },
        select: { id: true, identifier: true },
      }),
    ]);
  const missingSprintRecords = frozenSprintTasks.length
    ? await prisma.deliveryRecord.findMany({
        where: {
          issueId: { in: frozenSprintTasks.map((task) => task.id) },
          sprintId: null,
        },
      })
    : [];
  const frozenIssueIds = new Set([
    ...frozenRecords.map((record) => record.issueId),
    ...missingSprintRecords.map((record) => record.issueId),
  ]);

  const roster = new Map<string, StoredDeliveries["students"][number]>();
  for (const student of studentRows) {
    if (!isStudentAllowed(student.id, studentAllowlist)) continue;
    roster.set(student.id, {
      id: student.id,
      name: student.name,
      counts: emptyCounts(),
    });
  }

  const incompleteDeliveries: IncompleteDelivery[] = [];
  const deliveryIssues: DeliveryIssue[] = [];
  const now = new Date();

  for (const task of pendingTasks) {
    if (frozenIssueIds.has(task.id)) continue;
    if (task.assigneeId && !isStudentAllowed(task.assigneeId, studentAllowlist))
      continue;

    const student = task.assigneeId ? roster.get(task.assigneeId) : undefined;
    const reasons: string[] = [];
    if (!task.dueDate || !isValidDueDate(task.dueDate)) {
      reasons.push("No valid due date is set.");
    }
    if (!task.assigneeId) {
      reasons.push("No assignee is set.");
    } else if (!student) {
      reasons.push("The assignee is not available in the student roster.");
    }

    if (reasons.length > 0) {
      incompleteDeliveries.push({
        identifier: task.identifier,
        reason: reasons.join(" "),
      });
      continue;
    }

    const dueDate = task.dueDate!;
    const daysLate = calculateDaysLate(dueDate, now);
    const bucket = getLateBucket(daysLate);
    if (!bucket) continue;

    incrementCount(student!.counts, bucket);
    deliveryIssues.push({
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      url: task.url,
      studentId: student!.id,
      studentName: student!.name,
      deliveredAt: null,
      status: task.stateName,
      pending: true,
      dueDate,
      daysLate,
      bucket,
    });
  }

  const taskIds = [
    ...new Set([
      ...frozenRecords.map((record) => record.issueId),
      ...missingSprintRecords.map((record) => record.issueId),
      ...frozenSprintTasks.map((task) => task.id),
    ]),
  ];
  const taskRows = taskIds.length
    ? await prisma.linearTask.findMany({ where: { id: { in: taskIds } } })
    : [];
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));

  for (const record of frozenRecords) {
    const task = tasksById.get(record.issueId);
    const identifier = task?.identifier ?? record.issueId;
    const reasons: Array<string | null | undefined> = [record.incompleteReason];
    if (!record.deliveredAt) reasons.push("No delivery timestamp was recorded.");
    if (!record.dueDate || !isValidDueDate(record.dueDate))
      reasons.push("No valid due date was recorded at delivery.");
    if (!record.studentId) reasons.push("No student was recorded at delivery.");
    if (!record.studentName)
      reasons.push("No student name was recorded at delivery.");
    if (!record.sprintId) reasons.push("The sprint at delivery was not recorded.");
    if (!task) reasons.push("Task details are unavailable.");

    const studentAllowed = record.studentId
      ? isStudentAllowed(record.studentId, studentAllowlist)
      : true;
    if (!studentAllowed) continue;

    const student = record.studentId ? roster.get(record.studentId) : undefined;
    if (record.studentId && !student)
      reasons.push(
        "The student recorded at delivery is unavailable in the roster.",
      );
    const incompleteEntry = incomplete(identifier, reasons);
    if (incompleteEntry) {
      incompleteDeliveries.push(incompleteEntry);
      continue;
    }

    const daysLate = calculateDaysLate(record.dueDate!, record.deliveredAt!);
    const bucket = getLateBucket(daysLate);
    if (!bucket) continue;

    incrementCount(student!.counts, bucket);
    deliveryIssues.push({
      id: record.issueId,
      identifier: task!.identifier,
      title: task!.title,
      url: task!.url,
      studentId: record.studentId!,
      studentName: record.studentName!,
      deliveredAt: record.deliveredAt!.toISOString(),
      status: task!.stateName,
      pending: false,
      dueDate: record.dueDate!,
      daysLate,
      bucket,
    });
  }

  // A frozen record without a historical sprint can only be flagged when the
  // current task is still associated with the requested sprint. Its current
  // fields are never used to fill in the missing delivery snapshot.
  if (missingSprintRecords.length > 0) {
    const candidateSet = new Set(frozenSprintTasks.map((task) => task.id));
    for (const record of missingSprintRecords) {
      if (!candidateSet.has(record.issueId)) continue;
      const task = tasksById.get(record.issueId);
      if (
        record.studentId &&
        !isStudentAllowed(record.studentId, studentAllowlist)
      ) {
        continue;
      }

      const reasons: Array<string | null | undefined> = [
        record.incompleteReason,
        "The sprint at delivery was not recorded.",
      ];
      if (!record.deliveredAt)
        reasons.push("No delivery timestamp was recorded.");
      if (!record.dueDate || !isValidDueDate(record.dueDate))
        reasons.push("No valid due date was recorded at delivery.");
      if (!record.studentId) reasons.push("No student was recorded at delivery.");
      if (!record.studentName)
        reasons.push("No student name was recorded at delivery.");
      if (record.studentId && !roster.has(record.studentId))
        reasons.push(
          "The student recorded at delivery is unavailable in the roster.",
        );

      const entry = incomplete(task?.identifier ?? record.issueId, reasons);
      if (entry) incompleteDeliveries.push(entry);
    }
  }

  return {
    students: orderStudentSummaries(roster),
    issues: deliveryIssues,
    incomplete: incompleteDeliveries,
  };
}

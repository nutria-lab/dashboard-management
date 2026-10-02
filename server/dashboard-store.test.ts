import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  students: [] as Record<string, unknown>[],
  sprints: [] as Record<string, unknown>[],
  pendingTasks: [] as Record<string, unknown>[],
  frozenTasks: [] as Record<string, unknown>[],
  frozenRecords: [] as Record<string, unknown>[],
  missingSprintRecords: [] as Record<string, unknown>[],
  taskRows: [] as Record<string, unknown>[],
}));

vi.mock("./db.js", () => ({
  getPrismaClient: () => ({
    student: {
      findMany: vi.fn(async () => database.students),
    },
    sprint: {
      findMany: vi.fn(async () => database.sprints),
    },
    linearTask: {
      findMany: vi.fn(async (query: { where?: Record<string, unknown> }) => {
        const where = query.where ?? {};
        if (where.deliveryFrozen === false) return database.pendingTasks;
        if (where.deliveryFrozen === true) return database.frozenTasks;
        if (where.id) return database.taskRows;
        return [];
      }),
    },
    deliveryRecord: {
      findMany: vi.fn(async (query: { where?: Record<string, unknown> }) => {
        const where = query.where ?? {};
        if (where.sprintId === null) return database.missingSprintRecords;
        if (where.sprintId) return database.frozenRecords;
        return [];
      }),
    },
  }),
}));

import { getStoredDeliveries, getStoredSprints } from "./dashboard-store.js";

const student = { id: "student-1", name: "Ada Lovelace" };
const pendingTask = {
  id: "pending-1",
  identifier: "NUT-101",
  title: "Current task",
  url: "https://linear.app/example/NUT-101",
  teamId: "team-1",
  sprintId: "sprint-current",
  assigneeId: student.id,
  assigneeName: student.name,
  stateId: "started",
  stateName: "In Progress",
  stateType: "started",
  dueDate: "2026-09-30",
  linearUpdatedAt: new Date("2026-10-02T20:00:00.000Z"),
  completedAt: null,
  deliveryFrozen: false,
  removed: false,
  detailPending: false,
  updatedAt: new Date("2026-10-02T20:00:00.000Z"),
};
const frozenTask = {
  ...pendingTask,
  id: "frozen-1",
  identifier: "NUT-99",
  title: "Historical task",
  url: "https://linear.app/example/NUT-99",
  sprintId: "sprint-current",
  dueDate: "2026-11-30",
  stateName: "Done",
  stateType: "completed",
  deliveryFrozen: true,
};
const frozenRecord = {
  issueId: frozenTask.id,
  deliveredAt: new Date("2026-09-29T20:00:00.000Z"),
  dueDate: "2026-09-26",
  studentId: student.id,
  studentName: "Ada at delivery",
  sprintId: "sprint-old",
  incompleteReason: null,
};

function resetDatabase() {
  database.students = [{ ...student }, { id: "student-zero", name: "Grace Hopper" }];
  database.sprints = [];
  database.pendingTasks = [];
  database.frozenTasks = [];
  database.frozenRecords = [];
  database.missingSprintRecords = [];
  database.taskRows = [];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T02:30:00.000Z"));
  vi.stubEnv("LINEAR_STUDENT_IDS", "");
  resetDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("getStoredSprints", () => {
  it("returns only sprints with both dates and serializes their dates", async () => {
    database.sprints = [
      {
        id: "complete",
        name: "Complete",
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        endsAt: new Date("2026-09-14T00:00:00.000Z"),
      },
      {
        id: "missing-end",
        name: "Missing end",
        startsAt: new Date("2026-09-15T00:00:00.000Z"),
        endsAt: null,
      },
    ];

    await expect(getStoredSprints()).resolves.toEqual([
      {
        id: "complete",
        name: "Complete",
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-14T00:00:00.000Z",
      },
    ]);
  });
});

describe("getStoredDeliveries", () => {
  it("counts pending work through today's Buenos Aires date", async () => {
    database.pendingTasks = [{ ...pendingTask }];

    const result = await getStoredDeliveries("sprint-current");

    expect(result.issues).toEqual([
      expect.objectContaining({
        id: "pending-1",
        deliveredAt: null,
        pending: true,
        status: "In Progress",
        daysLate: 2,
        bucket: "twoThree",
      }),
    ]);
    expect(result.students[0].counts).toEqual({
      one: 0,
      twoThree: 1,
      fourFive: 0,
      overFive: 0,
    });
  });

  it("uses the frozen historical sprint and snapshot after the task moves", async () => {
    database.frozenRecords = [{ ...frozenRecord }];
    database.taskRows = [{ ...frozenTask }];

    const result = await getStoredDeliveries("sprint-old");

    expect(result.issues).toEqual([
      expect.objectContaining({
        id: "frozen-1",
        identifier: "NUT-99",
        studentName: "Ada at delivery",
        dueDate: "2026-09-26",
        deliveredAt: "2026-09-29T20:00:00.000Z",
        pending: false,
        daysLate: 3,
      }),
    ]);
  });

  it("returns zero-count roster entries when there are no overdue tasks", async () => {
    const result = await getStoredDeliveries("sprint-current");

    expect(result.issues).toEqual([]);
    expect(result.students).toHaveLength(2);
    expect(result.students.map(({ counts }) => counts)).toEqual([
      { one: 0, twoThree: 0, fourFive: 0, overFive: 0 },
      { one: 0, twoThree: 0, fourFive: 0, overFive: 0 },
    ]);
  });

  it("reports missing due dates and never invents a frozen delivery time", async () => {
    database.pendingTasks = [{ ...pendingTask, dueDate: null }];
    database.frozenRecords = [
      {
        ...frozenRecord,
        issueId: "missing-date",
        deliveredAt: null,
        dueDate: null,
      },
    ];
    database.taskRows = [
      { ...frozenTask, id: "missing-date", identifier: "NUT-100" },
    ];

    const result = await getStoredDeliveries("sprint-old");

    expect(result.issues).toEqual([]);
    expect(result.incomplete).toEqual([
      {
        identifier: "NUT-101",
        reason: "No valid due date is set.",
      },
      {
        identifier: "NUT-100",
        reason:
          "No delivery timestamp was recorded. No valid due date was recorded at delivery.",
      },
    ]);
  });

  it("reports frozen rows whose historical sprint snapshot is missing", async () => {
    database.frozenTasks = [{ id: "missing-sprint", identifier: "NUT-102" }];
    database.missingSprintRecords = [
      {
        ...frozenRecord,
        issueId: "missing-sprint",
        sprintId: null,
      },
    ];
    database.taskRows = [
      {
        ...frozenTask,
        id: "missing-sprint",
        identifier: "NUT-102",
        sprintId: "sprint-current",
      },
    ];

    const result = await getStoredDeliveries("sprint-current");

    expect(result.incomplete).toContainEqual({
      identifier: "NUT-102",
      reason: "The sprint at delivery was not recorded.",
    });
  });
});

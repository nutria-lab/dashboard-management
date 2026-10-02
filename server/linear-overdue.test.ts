import { describe, expect, it } from "vitest";
import {
  calculateDaysLate,
  getBuenosAiresCalendarDate,
  getLateBucket,
  resolveTaskSnapshot,
  type IssueHistoryEventLike,
} from "./linear.js";

const reviewStateId = "review";
const now = "2026-10-02T18:00:00.000Z";
const reviewEvent: IssueHistoryEventLike = {
  createdAt: "2026-10-01T18:00:00.000Z",
  fromStateId: "progress",
  toStateId: reviewStateId,
};

describe("delivery snapshots", () => {
  it("uses the current values and current time for open work", () => {
    const result = resolveTaskSnapshot(
      {
        stateId: "progress",
        stateType: "started",
        dueDate: "2026-09-30",
        assigneeId: "student",
        cycleId: "sprint",
      },
      [],
      reviewStateId,
      now,
    );

    expect(result).toEqual({
      snapshot: {
        deliveredAt: now,
        dueDate: "2026-09-30",
        assigneeId: "student",
        cycleId: "sprint",
      },
      pending: true,
    });
    expect(calculateDaysLate(result!.snapshot.dueDate!, result!.snapshot.deliveredAt)).toBe(2);
  });

  it("stops lateness at the first Review transition and rewinds later edits", () => {
    const result = resolveTaskSnapshot(
      {
        stateId: reviewStateId,
        stateType: "started",
        dueDate: "2026-09-30",
        assigneeId: "student-b",
        cycleId: "sprint-2",
      },
      [
        reviewEvent,
        {
          createdAt: "2026-10-02T12:00:00.000Z",
          fromDueDate: "2026-10-01",
          toDueDate: "2026-09-30",
          fromAssigneeId: "student-a",
          toAssigneeId: "student-b",
          fromCycleId: "sprint-1",
          toCycleId: "sprint-2",
        },
      ],
      reviewStateId,
      now,
    );

    expect(result).toEqual({
      snapshot: {
        deliveredAt: reviewEvent.createdAt,
        dueDate: "2026-10-01",
        assigneeId: "student-a",
        cycleId: "sprint-1",
      },
      pending: false,
    });
    expect(calculateDaysLate(result!.snapshot.dueDate!, result!.snapshot.deliveredAt)).toBe(0);
  });

  it("treats reopened work as pending with its current sprint, assignee, and due date", () => {
    const result = resolveTaskSnapshot(
      {
        stateId: "progress",
        stateType: "started",
        dueDate: "2026-09-30",
        assigneeId: "student-b",
        cycleId: "sprint-2",
      },
      [
        reviewEvent,
        {
          createdAt: now,
          fromStateId: reviewStateId,
          toStateId: "progress",
          fromDueDate: "2026-10-01",
          toDueDate: "2026-09-30",
          fromAssigneeId: "student-a",
          toAssigneeId: "student-b",
          fromCycleId: "sprint-1",
          toCycleId: "sprint-2",
        },
      ],
      reviewStateId,
      now,
    );

    expect(result).toEqual({
      snapshot: {
        deliveredAt: now,
        dueDate: "2026-09-30",
        assigneeId: "student-b",
        cycleId: "sprint-2",
      },
      pending: true,
    });
  });

  it("uses the completion timestamp when work went directly to Done", () => {
    const result = resolveTaskSnapshot(
      {
        stateId: "done",
        stateType: "completed",
        dueDate: "2026-09-30",
        assigneeId: "student",
        cycleId: "sprint",
        completedAt: "2026-10-01T18:00:00.000Z",
      },
      [],
      reviewStateId,
      now,
    );

    expect(result).toEqual({
      snapshot: {
        deliveredAt: "2026-10-01T18:00:00.000Z",
        dueDate: "2026-09-30",
        assigneeId: "student",
        cycleId: "sprint",
      },
      pending: false,
    });
    expect(calculateDaysLate(result!.snapshot.dueDate!, result!.snapshot.deliveredAt)).toBe(1);
  });

  it("excludes canceled and duplicate work", () => {
    for (const stateType of ["canceled", "duplicate"]) {
      expect(
        resolveTaskSnapshot(
          { stateId: stateType, stateType, dueDate: "2026-09-30" },
          [],
          reviewStateId,
          now,
        ),
      ).toBeNull();
    }
  });
});

describe("Buenos Aires lateness dates", () => {
  it("uses the local calendar day around UTC midnight", () => {
    const deliveredAt = "2026-10-02T02:30:00.000Z";
    expect(getBuenosAiresCalendarDate(deliveredAt)).toBe("2026-10-01");
    expect(calculateDaysLate("2026-10-01", deliveredAt)).toBe(0);
    expect(calculateDaysLate("2026-09-30", deliveredAt)).toBe(1);
    expect(getLateBucket(calculateDaysLate("2026-09-30", deliveredAt))).toBe("one");
  });
});

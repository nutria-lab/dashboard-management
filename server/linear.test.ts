import { describe, expect, it } from "vitest";
import {
  calculateDaysLate,
  collectAllPages,
  getIncompleteSprintReason,
  getBuenosAiresCalendarDate,
  getLateBucket,
  isStudentAllowed,
  parseStudentAllowlist,
  reconstructDeliverySnapshot,
  type PagedConnection,
} from "./linear.js";

describe("reconstructDeliverySnapshot", () => {
  it("rewinds later due date, assignee, and cycle changes to the first Review entry", () => {
    const snapshot = reconstructDeliverySnapshot(
      {
        dueDate: "2026-02-08",
        assigneeId: "student-b",
        cycleId: "sprint-2",
      },
      [
        {
          createdAt: "2026-02-01T12:00:00.000Z",
          fromStateId: "started",
          toStateId: "review",
        },
        {
          createdAt: "2026-02-03T12:00:00.000Z",
          fromDueDate: "2026-02-10",
          toDueDate: "2026-02-08",
          fromAssigneeId: "student-a",
          toAssigneeId: "student-b",
          fromCycleId: "sprint-1",
          toCycleId: "sprint-2",
        },
        {
          createdAt: "2026-02-02T12:00:00.000Z",
          fromStateId: "review",
          toStateId: "started",
        },
      ],
      "review",
    );

    expect(snapshot).toEqual({
      deliveredAt: "2026-02-01T12:00:00.000Z",
      dueDate: "2026-02-10",
      assigneeId: "student-a",
      cycleId: "sprint-1",
    });
  });

  it("uses the earliest transition into Review and leaves same-event values in place", () => {
    const snapshot = reconstructDeliverySnapshot(
      { dueDate: "2026-02-06", assigneeId: "student-a", cycleId: "sprint-1" },
      [
        {
          createdAt: "2026-02-05T12:00:00.000Z",
          fromStateId: "started",
          toStateId: "review",
        },
        {
          createdAt: "2026-02-01T12:00:00.000Z",
          fromStateId: "started",
          toStateId: "review",
          fromDueDate: "2026-02-10",
          toDueDate: "2026-02-08",
        },
        {
          createdAt: "2026-02-01T12:00:00.000Z",
          fromDueDate: "2026-02-08",
          toDueDate: "2026-02-06",
        },
        {
          createdAt: "2026-02-02T12:00:00.000Z",
          fromStateId: "review",
          toStateId: "started",
        },
      ],
      "review",
    );

    expect(snapshot?.deliveredAt).toBe("2026-02-01T12:00:00.000Z");
    expect(snapshot?.dueDate).toBe("2026-02-08");
  });

  it("returns null when history never shows an entry into Review", () => {
    expect(
      reconstructDeliverySnapshot(
        { dueDate: "2026-02-08", assigneeId: "student-a", cycleId: "sprint-1" },
        [
          {
            createdAt: "2026-02-01T12:00:00.000Z",
            fromStateId: "review",
            toStateId: "review",
          },
        ],
        "review",
      ),
    ).toBeNull();
  });

  it("ignores unrelated null history fields but rewinds fields cleared after delivery", () => {
    const snapshot = reconstructDeliverySnapshot(
      { dueDate: null, assigneeId: null, cycleId: null },
      [
        {
          createdAt: "2026-02-01T12:00:00.000Z",
          fromStateId: "started",
          toStateId: "review",
          fromDueDate: null,
          toDueDate: null,
          fromAssigneeId: null,
          toAssigneeId: null,
          fromCycleId: null,
          toCycleId: null,
        },
        {
          createdAt: "2026-02-02T12:00:00.000Z",
          fromDueDate: "2026-02-10",
          toDueDate: null,
          fromAssigneeId: "student-a",
          toAssigneeId: null,
          fromCycleId: "sprint-1",
          toCycleId: null,
        },
        {
          createdAt: "2026-02-03T12:00:00.000Z",
          fromDueDate: null,
          toDueDate: null,
          fromAssigneeId: null,
          toAssigneeId: null,
          fromCycleId: null,
          toCycleId: null,
        },
      ],
      "review",
    );

    expect(snapshot).toEqual({
      deliveredAt: "2026-02-01T12:00:00.000Z",
      dueDate: "2026-02-10",
      assigneeId: "student-a",
      cycleId: "sprint-1",
    });
  });
});

describe("sprint membership diagnostics", () => {
  it("marks sprint-associated issues with no Review transition as incomplete", () => {
    expect(
      getIncompleteSprintReason(
        null,
        "sprint-2",
        [
          {
            createdAt: "2026-02-01T12:00:00.000Z",
            fromCycleId: "sprint-1",
            toCycleId: "sprint-2",
          },
        ],
        "sprint-1",
      ),
    ).toContain("No transition into In Review");
  });

  it("marks a missing historical sprint at delivery as incomplete", () => {
    expect(
      getIncompleteSprintReason(
        {
          deliveredAt: "2026-02-01T12:00:00.000Z",
          dueDate: "2026-02-10",
          assigneeId: "student-a",
          cycleId: null,
        },
        "sprint-1",
        [],
        "sprint-1",
      ),
    ).toContain("could not be reconstructed");
  });

  it("does not classify an issue with a different reconstructed sprint as incomplete", () => {
    expect(
      getIncompleteSprintReason(
        {
          deliveredAt: "2026-02-01T12:00:00.000Z",
          dueDate: "2026-02-10",
          assigneeId: "student-a",
          cycleId: "sprint-2",
        },
        "sprint-1",
        [{ createdAt: "2026-02-02T12:00:00.000Z", toCycleId: "sprint-1" }],
        "sprint-1",
      ),
    ).toBeNull();
  });
});

describe("Linear pagination", () => {
  it("collects nodes appended from every page", async () => {
    let page = 1;
    const connection: PagedConnection<number> = {
      nodes: [1],
      pageInfo: { hasNextPage: true },
      async fetchNext() {
        if (page === 1) {
          this.nodes.push(2);
          this.pageInfo.hasNextPage = true;
        } else {
          this.nodes.push(3);
          this.pageInfo.hasNextPage = false;
        }
        page += 1;
        return this;
      },
    };

    await expect(collectAllPages(connection)).resolves.toEqual([1, 2, 3]);
  });

  it("fails rather than silently returning a partial result for an empty next page", async () => {
    const connection: PagedConnection<number> = {
      nodes: [1],
      pageInfo: { hasNextPage: true },
      async fetchNext() {
        this.pageInfo.hasNextPage = false;
        return this;
      },
    };

    await expect(collectAllPages(connection)).rejects.toThrow("empty page");
  });
});

describe("student allowlist", () => {
  it("parses comma-separated IDs, trims them, normalizes case, and removes duplicates", () => {
    expect(parseStudentAllowlist(" Student-A, student-b ,STUDENT-A,, ")).toEqual(
      new Set(["student-a", "student-b"]),
    );
    expect(parseStudentAllowlist(" , ")).toEqual(new Set());
  });

  it("allows everyone when unset and only listed IDs when configured", () => {
    expect(isStudentAllowed("instructor-id", parseStudentAllowlist(undefined))).toBe(true);

    const allowlist = parseStudentAllowlist("student-a,student-b");
    expect(isStudentAllowed("STUDENT-A", allowlist)).toBe(true);
    expect(isStudentAllowed("instructor-id", allowlist)).toBe(false);
  });
});

describe("delivery lateness calculations", () => {
  it("uses the Buenos Aires calendar date around UTC midnight", () => {
    const deliveredAt = "2026-10-02T02:30:00.000Z";
    expect(getBuenosAiresCalendarDate(deliveredAt)).toBe("2026-10-01");
    expect(calculateDaysLate("2026-10-01", deliveredAt)).toBe(0);
    expect(calculateDaysLate("2026-09-30", deliveredAt)).toBe(1);
  });

  it("maps calendar-day lateness to the requested buckets", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(getLateBucket)).toEqual([
      null,
      "one",
      "twoThree",
      "twoThree",
      "fourFive",
      "fourFive",
      "overFive",
    ]);
    expect(() =>
      calculateDaysLate("2026-02-30", "2026-03-01T12:00:00.000Z"),
    ).toThrow(RangeError);
  });
});

import { describe, it, expect } from "vitest";
import { applyJustifications } from "./justification-counts.js";
import type { Delivery, TaskJustification } from "../shared/types.js";

describe("justification accountability", () => {
  it("excludes justified pending and delivered tasks while retaining their explanations and zero rows", () => {
    const issue = (
      id: string,
      studentId: string,
      bucket: string,
      pending: boolean,
    ): Delivery => ({
      id,
      identifier: id,
      title: id,
      url: "https://linear.app",
      studentId,
      studentName: studentId,
      deliveredAt: pending ? null : "2026-10-01T18:00:00Z",
      dueDate: "2026-09-30",
      daysLate: 2,
      status: pending ? "In Progress" : "Done",
      pending,
      bucket,
    });
    const data = {
      students: ["a", "b"].map((id) => ({
        id,
        name: id,
        counts: { one: 0, twoThree: 1, fourFive: 0, overFive: 1 },
      })),
      issues: [
        issue("pending", "a", "twoThree", true),
        issue("delivered", "b", "overFive", false),
        issue("counted", "a", "overFive", false),
      ],
      incomplete: [{ identifier: "missing", reason: "No due date." }],
    };
    const records: TaskJustification[] = ["pending", "delivered"].map(
      (issueId) => ({
        issueId,
        reason: "DEPENDENCY",
        explanation: "Blocked by another task",
        createdAt: "2026-10-02T18:00:00Z",
        updatedAt: "2026-10-02T18:00:00Z",
      }),
    );
    const result = applyJustifications(data, records);
    expect(result.issues.map((task) => task.id)).toEqual(["counted"]);
    expect(result.justified.map((task) => task.id)).toEqual([
      "pending",
      "delivered",
    ]);
    expect(result.students.map((student) => student.counts)).toEqual([
      { one: 0, twoThree: 0, fourFive: 0, overFive: 1 },
      { one: 0, twoThree: 0, fourFive: 0, overFive: 0 },
    ]);
    expect(data.students[0].counts.twoThree).toBe(1);
    expect(result.incomplete).toEqual(data.incomplete);
    expect(applyJustifications(data, []).issues).toHaveLength(3);
  });
});

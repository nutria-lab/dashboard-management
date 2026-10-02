import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "./db.js";
import {
  deleteJustification,
  getJustifications,
  saveJustification,
  saveJustificationInputSchema,
} from "./justifications.js";

vi.mock("./db.js", () => ({ getPrismaClient: vi.fn() }));

const issueId = "0199f87e-7a14-7c45-b877-ae098c391234";
const createdAt = new Date("2026-10-02T12:00:00.000Z");
const updatedAt = new Date("2026-10-02T13:30:00.000Z");
const validInput = {
  issueId,
  reason: "DEPENDENCY",
  explanation: "Waiting for another student's task.",
} as const;

const taskJustification = {
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
};

const prismaMock = { taskJustification };

describe("saveJustificationInputSchema", () => {
  it("accepts supported reasons and trims the explanation", () => {
    for (const reason of ["LINEAR_ERROR", "DEPENDENCY", "OTHER"] as const) {
      expect(
        saveJustificationInputSchema.parse({ ...validInput, reason }).reason,
      ).toBe(reason);
    }

    expect(
      saveJustificationInputSchema.parse({
        ...validInput,
        explanation: "  Linear returned an error.  ",
      }).explanation,
    ).toBe("Linear returned an error.");
  });

  it("rejects invalid UUIDs, reasons, explanations, and extra fields", () => {
    for (const value of [
      { ...validInput, issueId: "issue-1" },
      { ...validInput, reason: "LINEAR_TIMEOUT" },
      { ...validInput, explanation: "   " },
      { ...validInput, explanation: "x".repeat(2001) },
      { ...validInput, note: "unexpected" },
    ]) {
      expect(saveJustificationInputSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("task justifications persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrismaClient).mockReturnValue(
      prismaMock as unknown as ReturnType<typeof getPrismaClient>,
    );
    taskJustification.upsert.mockResolvedValue({
      ...validInput,
      createdAt,
      updatedAt,
    });
    taskJustification.findMany.mockResolvedValue([]);
    taskJustification.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("upserts one task-wide justification by issue ID and serializes dates", async () => {
    const result = await saveJustification({
      ...validInput,
      explanation: "  Waiting for another student's task.  ",
    });

    expect(taskJustification.upsert).toHaveBeenCalledWith({
      where: { issueId },
      create: validInput,
      update: {
        reason: "DEPENDENCY",
        explanation: validInput.explanation,
      },
      select: {
        issueId: true,
        reason: true,
        explanation: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(result).toEqual({
      ...validInput,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("reloads justifications for requested tasks as plain ISO records", async () => {
    taskJustification.findMany.mockResolvedValue([
      { ...validInput, createdAt, updatedAt },
    ]);

    await expect(getJustifications([issueId])).resolves.toEqual([
      {
        ...validInput,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
    expect(taskJustification.findMany).toHaveBeenCalledWith({
      where: { issueId: { in: [issueId] } },
      select: {
        issueId: true,
        reason: true,
        explanation: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("returns no records without querying for an empty task list", async () => {
    await expect(getJustifications([])).resolves.toEqual([]);
    expect(taskJustification.findMany).not.toHaveBeenCalled();
  });

  it("deletes by issue ID idempotently", async () => {
    await deleteJustification(issueId);
    await deleteJustification(issueId);

    expect(taskJustification.deleteMany).toHaveBeenCalledTimes(2);
    expect(taskJustification.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { issueId },
    });
  });
});

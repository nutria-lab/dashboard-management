import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "./db.js";
import { saveAttendance, saveAttendanceInputSchema } from "./attendance.js";

vi.mock("./db.js", () => ({ getPrismaClient: vi.fn() }));

const transaction = {
  student: { upsert: vi.fn() },
  sprint: { upsert: vi.fn() },
  classSession: { upsert: vi.fn() },
  attendance: { upsert: vi.fn() },
};

const prismaMock = {
  $transaction: vi.fn(
    async (
      callback: (transactionClient: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  ),
};

const validInput = {
  studentId: "student-1",
  studentName: "Ada Lovelace",
  sprintId: "sprint-1",
  sprintName: "Sprint 1",
  sessionDate: "2026-10-02",
  sessionType: "REGULAR",
  category: "PRESENT",
};

describe("saveAttendanceInputSchema", () => {
  it("accepts all supported sessions with optional notes and attendance values", () => {
    for (const sessionType of [
      "REGULAR",
      "PLANNING",
      "REVIEW",
      "STEERING",
    ] as const) {
      const result = saveAttendanceInputSchema.safeParse({
        ...validInput,
        sessionType,
      });
      expect(result.success).toBe(true);
    }

    for (const category of [
      "PRESENT",
      "REMOTE_JUSTIFIED",
      "REMOTE_UNJUSTIFIED",
      "ABSENT_JUSTIFIED",
      "ABSENT_UNJUSTIFIED",
    ] as const) {
      expect(
        saveAttendanceInputSchema.safeParse({ ...validInput, category })
          .success,
      ).toBe(true);
    }

    const planningAbsence = saveAttendanceInputSchema.parse({
      ...validInput,
      sessionType: "PLANNING",
      category: "REMOTE_UNJUSTIFIED",
    });
    expect(planningAbsence.category).toBe("REMOTE_UNJUSTIFIED");
  });

  it("rejects invalid dates, enums, datetimes, and overlong text", () => {
    expect(
      saveAttendanceInputSchema.safeParse({
        ...validInput,
        sessionDate: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(
      saveAttendanceInputSchema.safeParse({ ...validInput, category: "LATE" })
        .success,
    ).toBe(false);
    expect(
      saveAttendanceInputSchema.safeParse({
        ...validInput,
        sessionType: "REVIEWING",
      }).success,
    ).toBe(false);
    expect(
      saveAttendanceInputSchema.safeParse({ ...validInput, noticeAt: "09:30" })
        .success,
    ).toBe(false);
    expect(
      saveAttendanceInputSchema.safeParse({
        ...validInput,
        noticeAt: "2026-10-02T09:30:00-03:00",
        updateText: "Reviewed sprint progress",
      }).success,
    ).toBe(true);
    expect(
      saveAttendanceInputSchema.safeParse({
        ...validInput,
        updateText: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe("saveAttendance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrismaClient).mockReturnValue(
      prismaMock as unknown as ReturnType<typeof getPrismaClient>,
    );
    transaction.student.upsert.mockResolvedValue({ id: validInput.studentId });
    transaction.sprint.upsert.mockResolvedValue({ id: validInput.sprintId });
    transaction.classSession.upsert.mockResolvedValue({ id: "session-1" });
    transaction.attendance.upsert.mockResolvedValue({
      id: "attendance-1",
      studentId: validInput.studentId,
      sessionId: "session-1",
      category: "PRESENT",
      noticeAt: null,
      justification: null,
      updateText: null,
    });
  });

  it("uses stable composite keys so repeated saves update the same session and attendance", async () => {
    await saveAttendance(validInput);
    await saveAttendance({
      ...validInput,
      category: "ABSENT_JUSTIFIED",
      justification: "Illness",
    });

    const expectedDate = new Date("2026-10-02T00:00:00.000Z");
    expect(transaction.classSession.upsert).toHaveBeenCalledTimes(2);
    expect(transaction.classSession.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          sprintId_date_type: {
            sprintId: "sprint-1",
            date: expectedDate,
            type: "REGULAR",
          },
        },
      }),
    );
    expect(transaction.attendance.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          studentId_sessionId: {
            studentId: "student-1",
            sessionId: "session-1",
          },
        },
        update: expect.objectContaining({
          category: "ABSENT_JUSTIFIED",
          justification: "Illness",
        }),
      }),
    );
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });
});

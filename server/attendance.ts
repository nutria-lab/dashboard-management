import { z } from "zod";
import type {
  AttendanceCategory,
  SessionType,
} from "./generated/prisma/client.js";
import { getPrismaClient } from "./db.js";

const attendanceCategories = [
  "PRESENT",
  "REMOTE_JUSTIFIED",
  "REMOTE_UNJUSTIFIED",
  "ABSENT_JUSTIFIED",
  "ABSENT_UNJUSTIFIED",
] as const;

const sessionTypes = ["REGULAR", "PLANNING", "REVIEW", "STEERING"] as const;

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional();

const isoDateTime = z.string().datetime({ offset: true });
const optionalDateTime = z
  .string()
  .trim()
  .refine(
    (value) => value.length === 0 || isoDateTime.safeParse(value).success,
    {
      message: "noticeAt must be a valid ISO datetime.",
    },
  )
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional();

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export const saveAttendanceInputSchema = z.object({
  studentId: z.string().trim().min(1),
  studentName: z.string().trim().min(1),
  sprintId: z.string().trim().min(1),
  sprintName: z.string().trim().min(1),
  sessionDate: z.string().refine(isValidIsoDate, {
    message: "sessionDate must be a valid ISO date in YYYY-MM-DD format.",
  }),
  sessionType: z.enum(sessionTypes),
  category: z.enum(attendanceCategories),
  noticeAt: optionalDateTime,
  justification: optionalText,
  updateText: optionalText,
});

export type SaveAttendanceInput = z.infer<typeof saveAttendanceInputSchema>;

export interface AttendanceSession {
  id: string;
  date: string;
  type: SessionType;
  sprintId: string;
}

export interface AttendanceRecord {
  id: string;
  studentId: string;
  sessionId: string;
  category: AttendanceCategory;
  noticeAt: string | null;
  justification: string | null;
  updateText: string | null;
}

export interface AttendanceStudent {
  id: string;
  name: string;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toAttendanceRecord(record: {
  id: string;
  studentId: string;
  sessionId: string;
  category: AttendanceCategory;
  noticeAt: string | null;
  justification: string | null;
  updateText: string | null;
}): AttendanceRecord {
  return {
    id: record.id,
    studentId: record.studentId,
    sessionId: record.sessionId,
    category: record.category,
    noticeAt: record.noticeAt,
    justification: record.justification,
    updateText: record.updateText,
  };
}

export async function getAttendance(sprintId: string): Promise<{
  sessions: AttendanceSession[];
  records: AttendanceRecord[];
  students: AttendanceStudent[];
}> {
  const normalizedSprintId = z.string().trim().min(1).parse(sprintId);
  const prisma = getPrismaClient();

  const [sessions, records, students] = await Promise.all([
    prisma.classSession.findMany({
      where: { sprintId: normalizedSprintId },
      select: { id: true, date: true, type: true, sprintId: true },
      orderBy: [{ date: "asc" }, { type: "asc" }, { id: "asc" }],
    }),
    prisma.attendance.findMany({
      where: { session: { sprintId: normalizedSprintId } },
      select: {
        id: true,
        studentId: true,
        sessionId: true,
        category: true,
        noticeAt: true,
        justification: true,
        updateText: true,
      },
      orderBy: [{ session: { date: "asc" } }, { studentId: "asc" }],
    }),
    prisma.student.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    sessions: sessions.map((session) => ({
      ...session,
      date: toIsoDate(session.date),
    })),
    records: records.map(toAttendanceRecord),
    students,
  };
}

export async function saveAttendance(
  input: unknown,
): Promise<AttendanceRecord> {
  const data = saveAttendanceInputSchema.parse(input);
  const prisma = getPrismaClient();
  const sessionDate = new Date(`${data.sessionDate}T00:00:00.000Z`);

  const saved = await prisma.$transaction(async (transaction) => {
    await transaction.student.upsert({
      where: { id: data.studentId },
      create: { id: data.studentId, name: data.studentName },
      update: { name: data.studentName },
    });

    await transaction.sprint.upsert({
      where: { id: data.sprintId },
      create: { id: data.sprintId, name: data.sprintName },
      update: { name: data.sprintName },
    });

    const session = await transaction.classSession.upsert({
      where: {
        sprintId_date_type: {
          sprintId: data.sprintId,
          date: sessionDate,
          type: data.sessionType,
        },
      },
      create: {
        sprintId: data.sprintId,
        date: sessionDate,
        type: data.sessionType,
      },
      update: {},
      select: { id: true },
    });

    return transaction.attendance.upsert({
      where: {
        studentId_sessionId: {
          studentId: data.studentId,
          sessionId: session.id,
        },
      },
      create: {
        studentId: data.studentId,
        sessionId: session.id,
        category: data.category,
        noticeAt: data.noticeAt ?? null,
        justification: data.justification ?? null,
        updateText: data.updateText ?? null,
      },
      update: {
        category: data.category,
        noticeAt: data.noticeAt ?? null,
        justification: data.justification ?? null,
        updateText: data.updateText ?? null,
      },
    });
  });

  return toAttendanceRecord(saved);
}

export async function deleteAttendance(id: string): Promise<void> {
  const attendanceId = z.string().trim().min(1).parse(id);
  await getPrismaClient().attendance.delete({ where: { id: attendanceId } });
}

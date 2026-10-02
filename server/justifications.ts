import { z } from "zod";
import type { TaskJustificationReason } from "./generated/prisma/client.js";
import { getPrismaClient } from "./db.js";

const taskJustificationReasons = [
  "LINEAR_ERROR",
  "DEPENDENCY",
  "OTHER",
] as const;

export const saveJustificationInputSchema = z
  .object({
    issueId: z.string().uuid(),
    reason: z.enum(taskJustificationReasons),
    explanation: z.string().trim().min(1).max(2000),
  })
  .strict();

export type SaveJustificationInput = z.infer<
  typeof saveJustificationInputSchema
>;

export interface TaskJustificationRecord {
  issueId: string;
  reason: TaskJustificationReason;
  explanation: string;
  createdAt: string;
  updatedAt: string;
}

function toTaskJustificationRecord(record: {
  issueId: string;
  reason: TaskJustificationReason;
  explanation: string;
  createdAt: Date;
  updatedAt: Date;
}): TaskJustificationRecord {
  return {
    issueId: record.issueId,
    reason: record.reason,
    explanation: record.explanation,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function getJustifications(
  issueIds: string[],
): Promise<TaskJustificationRecord[]> {
  if (issueIds.length === 0) return [];

  const records = await getPrismaClient().taskJustification.findMany({
    where: { issueId: { in: issueIds } },
    select: {
      issueId: true,
      reason: true,
      explanation: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return records.map(toTaskJustificationRecord);
}

export async function saveJustification(
  input: unknown,
): Promise<TaskJustificationRecord> {
  const data = saveJustificationInputSchema.parse(input);
  const saved = await getPrismaClient().taskJustification.upsert({
    where: { issueId: data.issueId },
    create: data,
    update: {
      reason: data.reason,
      explanation: data.explanation,
    },
    select: {
      issueId: true,
      reason: true,
      explanation: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return toTaskJustificationRecord(saved);
}

export async function deleteJustification(issueId: string): Promise<void> {
  const id = z.string().uuid().parse(issueId);
  await getPrismaClient().taskJustification.deleteMany({ where: { issueId: id } });
}

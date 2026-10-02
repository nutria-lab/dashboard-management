import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { getPrismaClient } from "./db.js";
import { getLinearTeamId } from "./linear-api.js";
import { processWebhookEvents } from "./linear-sync.js";
import type { Prisma } from "./generated/prisma/client.js";

export const MAX_WEBHOOK_BYTES = 256 * 1024;
type Result = { status: number; body: { ok?: boolean; error?: string } };

export async function receiveLinearWebhook(
  raw: Buffer,
  headers: Headers,
): Promise<Result> {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret)
    return {
      status: 503,
      body: { error: "Webhook signing secret is not configured." },
    };
  if (raw.byteLength > MAX_WEBHOOK_BYTES)
    return { status: 413, body: { error: "Webhook payload too large." } };
  const signature = headers.get("linear-signature") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(signature))
    return { status: 401, body: { error: "Invalid webhook signature." } };
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return { status: 401, body: { error: "Invalid webhook signature." } };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "Invalid webhook JSON." } };
  }
  const timestamp = payload.webhookTimestamp;
  if (
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) > 60_000
  )
    return { status: 401, body: { error: "Expired webhook timestamp." } };
  if (payload.type !== "Issue") return { status: 200, body: { ok: true } };
  const parsed = z
    .object({
      action: z.enum(["create", "update", "remove"]),
      createdAt: z.string().datetime({ offset: true }),
      data: z
        .object({ id: z.string().uuid(), teamId: z.string().uuid() })
        .passthrough(),
    })
    .passthrough()
    .safeParse(payload);
  const deliveryId = z
    .string()
    .uuid()
    .safeParse(headers.get("linear-delivery"));
  if (!parsed.success || !deliveryId.success)
    return { status: 400, body: { error: "Invalid webhook fields." } };
  const event = parsed.data;
  if (event.data.teamId !== getLinearTeamId())
    return { status: 200, body: { ok: true } };
  await getPrismaClient().webhookEvent.createMany({
    data: [
      {
        deliveryId: deliveryId.data,
        issueId: event.data.id,
        teamId: event.data.teamId,
        action: event.action,
        eventAt: new Date(event.createdAt),
        payload: payload as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return { status: 200, body: { ok: true } };
}

export function scheduleWebhookProcessing() {
  const work = processWebhookEvents().catch(() =>
    console.error("Webhook processing deferred; event remains stored."),
  );
  if (process.env.VERCEL) waitUntil(work);
  else void work;
}

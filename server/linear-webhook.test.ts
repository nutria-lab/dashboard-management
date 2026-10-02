import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ createMany: vi.fn(), process: vi.fn() }));
vi.mock("./db.js", () => ({
  getPrismaClient: () => ({ webhookEvent: { createMany: state.createMany } }),
}));
vi.mock("./linear-sync.js", () => ({ processWebhookEvents: state.process }));
import {
  receiveLinearWebhook,
  scheduleWebhookProcessing,
} from "./linear-webhook.js";
const secret = "test-signing-secret";
const teamId = "1334836d-3538-443b-a490-524d01b39f85";
const deliveryId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
function request(extra = {}, stringify = JSON.stringify) {
  const raw = Buffer.from(
    stringify({
      type: "Issue",
      action: "update",
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      data: { id: issueId, teamId },
      ...extra,
    }),
  );
  return {
    raw,
    headers: new Headers({
      "linear-delivery": deliveryId,
      "linear-signature": createHmac("sha256", secret)
        .update(raw)
        .digest("hex"),
    }),
  };
}
beforeEach(() => {
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", secret);
  vi.stubEnv("LINEAR_TEAM_ID", teamId);
  vi.stubEnv("VERCEL", "");
  vi.clearAllMocks();
  state.createMany.mockResolvedValue({ count: 1 });
  state.process.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("Linear webhook ingestion", () => {
  it("verifies the original bytes, persists with deduplication, and does not process before receipt succeeds", async () => {
    const input = request({}, (value) => JSON.stringify(value, null, 2));
    expect((await receiveLinearWebhook(input.raw, input.headers)).status).toBe(
      200,
    );
    expect(state.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({ deliveryId, issueId, teamId })],
      }),
    );
    expect(state.process).not.toHaveBeenCalled();
    state.createMany.mockResolvedValue({ count: 0 });
    expect((await receiveLinearWebhook(input.raw, input.headers)).status).toBe(
      200,
    );
    scheduleWebhookProcessing();
    expect(state.process).toHaveBeenCalledOnce();
  });
  it("rejects invalid signatures, modified bodies and expired events before persistence", async () => {
    const input = request();
    const bad = new Headers(input.headers);
    bad.set("linear-signature", "bad");
    expect((await receiveLinearWebhook(input.raw, bad)).status).toBe(401);
    expect(
      (
        await receiveLinearWebhook(
          Buffer.from(input.raw.toString() + " "),
          input.headers,
        )
      ).status,
    ).toBe(401);
    const expired = request({ webhookTimestamp: Date.now() - 61_000 });
    expect(
      (await receiveLinearWebhook(expired.raw, expired.headers)).status,
    ).toBe(401);
    expect(state.createMany).not.toHaveBeenCalled();
  });
  it("acknowledges unrelated events without storing them", async () => {
    const otherType = request({ type: "Comment" });
    const otherTeam = request({
      data: { id: issueId, teamId: "00000000-0000-4000-8000-000000000003" },
    });
    expect(
      (await receiveLinearWebhook(otherType.raw, otherType.headers)).status,
    ).toBe(200);
    expect(
      (await receiveLinearWebhook(otherTeam.raw, otherTeam.headers)).status,
    ).toBe(200);
    expect(state.createMany).not.toHaveBeenCalled();
  });
  it("does not acknowledge success if Neon cannot persist the event", async () => {
    state.createMany.mockRejectedValue(new Error("Database unavailable"));
    const input = request();
    await expect(
      receiveLinearWebhook(input.raw, input.headers),
    ).rejects.toThrow("Database unavailable");
    expect(state.process).not.toHaveBeenCalled();
  });
});

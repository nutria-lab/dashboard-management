import "dotenv/config";
import { consumeLoginAttempt, resetLoginAttempts } from "./login-limiter.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticated,
  hashClientKey,
  constantEqual,
  sameOrigin,
  setSession,
} from "./auth.js";
import {
  demoAttendance,
  demoDelete,
  demoDeliveries,
  demoSave,
  demoSprints,
  demoJustifications,
} from "./demo.js";
import { getStoredDeliveries, getStoredSprints } from "./dashboard-store.js";
import { getSyncStatus, synchronizeSprint } from "./linear-sync.js";
import {
  MAX_WEBHOOK_BYTES,
  receiveLinearWebhook,
  scheduleWebhookProcessing,
} from "./linear-webhook.js";
import { applyJustifications } from "./justification-counts.js";
import {
  getJustifications,
  saveJustification,
  deleteJustification,
  saveJustificationInputSchema,
} from "./justifications.js";
import {
  deleteAttendance,
  getAttendance,
  saveAttendance,
  saveAttendanceInputSchema,
} from "./attendance.js";
const demo = () =>
  process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
async function body(req: IncomingMessage) {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    if (JSON.stringify(parsed).length > 16384)
      throw Object.assign(new Error("Request body too large."), {
        status: 413,
      });
    if (typeof parsed === "string") {
      try {
        return JSON.parse(parsed);
      } catch {
        throw Object.assign(new Error("Invalid JSON."), { status: 400 });
      }
    }
    return parsed;
  }
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384)
      throw Object.assign(new Error("Request body too large."), {
        status: 413,
      });
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
}
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url!, "http://local");
    const route = url.pathname;
    const method = req.method;
    if (route === "/api/webhooks/linear") {
      if (method !== "POST") return send(405, { error: "Method not allowed." });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_WEBHOOK_BYTES)
          return send(413, { error: "Webhook payload too large." });
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const result = await receiveLinearWebhook(Buffer.concat(chunks), headers);
      if (result.status === 200) scheduleWebhookProcessing();
      return send(result.status, result.body);
    }
    if (method !== "GET" && !sameOrigin(req))
      return send(403, { error: "Request origin rejected." });
    if (route === "/api/session") {
      if (method === "GET")
        return send(200, { authenticated: authenticated(req), demo: demo() });
      if (method === "DELETE") {
        setSession(res, true);
        return send(200, { ok: true });
      }
      if (method !== "POST") return send(405, { error: "Method not allowed." });
      const clientIp = String(
        req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown",
      )
        .split(",")[0]
        .trim();
      const key = hashClientKey(clientIp);
      if (!(await consumeLoginAttempt(key)))
        return send(429, {
          error: "Too many sign-in attempts. Try again in 15 minutes.",
        });
      const input = await body(req);
      if (!process.env.DASHBOARD_PASSWORD)
        return send(503, {
          error: "Set DASHBOARD_PASSWORD and SESSION_SECRET on the server.",
        });
      if (
        !input ||
        typeof input.password !== "string" ||
        !constantEqual(input.password, process.env.DASHBOARD_PASSWORD)
      )
        return send(401, { error: "Incorrect password." });
      await resetLoginAttempts(key);
      setSession(res);
      return send(200, { ok: true });
    }
    if (!authenticated(req)) return send(401, { error: "Please sign in." });
    const sprintId = url.searchParams.get("sprintId");
    if (route === "/api/sync") {
      if (method !== "GET" && method !== "POST")
        return send(405, { error: "Method not allowed." });
      if (demo())
        return send(200, {
          lastSyncedAt: new Date().toISOString(),
          retryAt: null,
          syncing: false,
          pendingEvents: 0,
          importComplete: true,
          webhookConfigured: false,
          error: null,
        });
      if (method === "GET") return send(200, await getSyncStatus(sprintId));
      if (!sprintId) return send(400, { error: "Select a sprint." });
      return send(200, await synchronizeSprint(sprintId));
    }
    if (route === "/api/sprints" && method === "GET")
      return send(200, demo() ? demoSprints : await getStoredSprints());
    if (route === "/api/deliveries" && method === "GET") {
      if (!sprintId) return send(400, { error: "Select a sprint." });
      const data = demo()
        ? demoDeliveries(sprintId)
        : await getStoredDeliveries(sprintId);
      const justifications = demo()
        ? [...demoJustifications.values()]
        : await getJustifications(data.issues.map((issue) => issue.id));
      return send(200, applyJustifications(data, justifications));
    }
    if (route === "/api/justifications") {
      if (method === "POST") {
        const input = saveJustificationInputSchema.parse(await body(req));
        if (!demo()) return send(200, await saveJustification(input));
        const previous = demoJustifications.get(input.issueId);
        const record = {
          ...input,
          createdAt: previous?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        demoJustifications.set(input.issueId, record);
        return send(200, record);
      }
      if (method === "DELETE") {
        const issueId = url.searchParams.get("issueId");
        if (!issueId) return send(400, { error: "Task ID is required." });
        if (demo()) demoJustifications.delete(issueId);
        else await deleteJustification(issueId);
        return send(200, { ok: true });
      }
      return send(405, { error: "Method not allowed." });
    }
    if (route === "/api/attendance") {
      if (method === "GET") {
        if (!sprintId) return send(400, { error: "Select a sprint." });
        return send(
          200,
          demo() ? demoAttendance(sprintId) : await getAttendance(sprintId),
        );
      }
      if (method === "POST") {
        const input = saveAttendanceInputSchema.parse(await body(req));
        return send(
          200,
          demo() ? demoSave(input) : await saveAttendance(input),
        );
      }
      if (method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return send(400, { error: "Record ID is required." });
        if (demo()) demoDelete(id);
        else await deleteAttendance(id);
        return send(200, { ok: true });
      }
      return send(405, { error: "Method not allowed." });
    }
    return send(404, { error: "Route not found." });
  } catch (error) {
    const e = error as { message?: string; name?: string; status?: number };
    if (e.name === "ZodError")
      return send(400, {
        error: "Invalid fields. Check dates, reason and required values.",
      });
    if (e.status) return send(e.status, { error: e.message });
    if (e.message?.startsWith("Set ") || e.message?.includes("Missing"))
      return send(503, { error: e.message });
    console.error("API request failed:", e.name ?? "Error");
    return send(502, {
      error:
        "Data service unavailable. Check server configuration and try again.",
    });
  }
}

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  transport: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("./linear-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./linear-api.js")>()),
  fetchMetadata: mock.transport,
  fetchOpenTasksPage: mock.transport,
  fetchAllTasksPage: mock.transport,
  fetchTask: mock.transport,
  fetchTaskHistory: mock.transport,
}));
vi.mock("./linear-sync.js", () => ({
  synchronizeSprint: mock.sync,
  processWebhookEvents: mock.sync,
  getSyncStatus: async () => ({ importComplete: true }),
}));
vi.mock("./dashboard-store.js", () => ({
  getStoredSprints: async () => [
    { id: "stored-sprint", name: "Stored sprint" },
  ],
  getStoredDeliveries: async () => ({
    students: [
      {
        id: "student",
        name: "Student",
        counts: { one: 1, twoThree: 0, fourFive: 0, overFive: 0 },
      },
    ],
    issues: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        identifier: "NUT-1",
        title: "Stored task",
        url: "https://linear.app/example",
        studentId: "student",
        studentName: "Student",
        deliveredAt: null,
        dueDate: "2026-09-30",
        daysLate: 1,
        bucket: "one",
        status: "In Progress",
        pending: true,
      },
    ],
    incomplete: [],
  }),
}));
vi.mock("./justifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./justifications.js")>()),
  getJustifications: async () => mock.records,
  saveJustification: async (input: Record<string, unknown>) => {
    const row = {
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mock.records = [row];
    return row;
  },
  deleteJustification: async () => {
    mock.records = [];
  },
}));
import handler from "./handler.js";
const server = createServer(handler);
let base: string;
let cookie: string;
beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DASHBOARD_PASSWORD", "stored-test-teacher");
  vi.stubEnv(
    "SESSION_SECRET",
    "stored-test-session-secret-at-least-32-characters",
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const res = await fetch(base + "/api/session", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "stored-test-teacher" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0];
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function request(path: string, method = "GET", input?: unknown) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  expect(res.status).toBe(200);
  return res.json();
}
describe("stored dashboard HTTP reads", () => {
  it("reads charts and saves/removes justifications with zero Linear or synchronization calls", async () => {
    expect((await request("/sprints"))[0].name).toBe("Stored sprint");
    const before = await request("/deliveries?sprintId=stored-sprint");
    expect(before.students[0].counts.one).toBe(1);
    await request("/justifications", "POST", {
      issueId: before.issues[0].id,
      reason: "DEPENDENCY",
      explanation: "Blocked by another task.",
    });
    const excluded = await request("/deliveries?sprintId=stored-sprint");
    expect(excluded.students[0].counts.one).toBe(0);
    expect(excluded.justified).toHaveLength(1);
    await request("/justifications?issueId=" + before.issues[0].id, "DELETE");
    expect(
      (await request("/deliveries?sprintId=stored-sprint")).students[0].counts
        .one,
    ).toBe(1);
    expect(mock.transport).not.toHaveBeenCalled();
    expect(mock.sync).not.toHaveBeenCalled();
  });
});

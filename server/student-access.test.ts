import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const writes = vi.hoisted(() => ({
  attendance: vi.fn(),
  justification: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("./attendance.js", async (original) => ({
  ...(await original<typeof import("./attendance.js")>()),
  saveAttendance: writes.attendance,
  deleteAttendance: writes.attendance,
}));
vi.mock("./justifications.js", async (original) => ({
  ...(await original<typeof import("./justifications.js")>()),
  saveJustification: writes.justification,
  deleteJustification: writes.justification,
}));
vi.mock("./linear-sync.js", () => ({
  synchronizeSprint: writes.sync,
  getSyncStatus: vi.fn(),
  processWebhookEvents: writes.sync,
}));
import handler from "./handler.js";
const server = createServer(handler);
let base: string;
let studentCookie: string;
beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DASHBOARD_PASSWORD", "teacher-only");
  vi.stubEnv("STUDENT_DASHBOARD_PASSWORD", "student-only");
  vi.stubEnv(
    "SESSION_SECRET",
    "student-access-test-secret-at-least-32-characters",
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function request(
  path: string,
  method = "GET",
  cookie?: string,
  input?: unknown,
) {
  return fetch(base + "/api" + path, {
    method,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}
describe("student read-only HTTP access", () => {
  it("logs in separately and reads every dashboard resource", async () => {
    const login = await request("/session", "POST", undefined, {
      role: "student",
      password: "student-only",
    });
    expect(login.status).toBe(200);
    expect((await login.json()).role).toBe("student");
    studentCookie = login.headers.get("set-cookie")!.split(";")[0];
    const session = await request("/session", "GET", studentCookie);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      role: "student",
    });
    for (const path of [
      "/sprints",
      "/deliveries?sprintId=demo-2",
      "/attendance?sprintId=demo-2",
      "/sync?sprintId=demo-2",
    ])
      expect((await request(path, "GET", studentCookie)).status).toBe(200);
  });
  it("rejects all student writes before parsing or calling mutations, including sync", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      for (const path of [
        "/attendance",
        "/justifications",
        "/sync?sprintId=demo-2",
      ])
        expect(
          (
            await request(path, method, studentCookie, {
              intentionally: "invalid",
            })
          ).status,
        ).toBe(403);
    expect(writes.attendance).not.toHaveBeenCalled();
    expect(writes.justification).not.toHaveBeenCalled();
    expect(writes.sync).not.toHaveBeenCalled();
    vi.stubEnv("DEMO_MODE", "true");
  });
  it("does not elevate students by claiming teacher and preserves teacher login compatibility", async () => {
    expect(
      (
        await request("/session", "POST", undefined, {
          role: "teacher",
          password: "student-only",
        })
      ).status,
    ).toBe(401);
    const teacher = await request("/session", "POST", undefined, {
      password: "teacher-only",
    });
    expect(teacher.status).toBe(200);
    expect((await teacher.json()).role).toBe("teacher");
    const teacherCookie = teacher.headers.get("set-cookie")!.split(";")[0];
    expect(
      (await request("/sync?sprintId=demo-2", "POST", teacherCookie)).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/sprints",
          "GET",
          studentCookie.replace("student.", "teacher."),
        )
      ).status,
    ).toBe(401);
  });
  it("disables login for identical configured passwords and allows student logout", async () => {
    vi.stubEnv("STUDENT_DASHBOARD_PASSWORD", "teacher-only");
    for (const role of ["teacher", "student"])
      expect(
        (
          await request("/session", "POST", undefined, {
            role,
            password: "teacher-only",
          })
        ).status,
      ).toBe(503);
    vi.stubEnv("STUDENT_DASHBOARD_PASSWORD", "student-only");
    const logout = await request("/session", "DELETE", studentCookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

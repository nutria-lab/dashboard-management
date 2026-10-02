import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import handler from "./handler.js";
const server = createServer(handler);
let origin: string;
let cookie = "";
beforeAll(async () => {
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DASHBOARD_PASSWORD", "teacher-test");
  vi.stubEnv(
    "SESSION_SECRET",
    "integration-test-secret-at-least-32-characters",
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = "http://127.0.0.1:" + address.port;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  auth = true,
  customOrigin = origin,
) {
  return fetch(origin + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: customOrigin,
      ...(auth ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
describe("dashboard HTTP flow", () => {
  it("denies unauthenticated data and foreign write origins", async () => {
    expect((await request("/sprints", "GET", undefined, false)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          "/session",
          "POST",
          { password: "teacher-test" },
          false,
          "https://evil.test",
        )
      ).status,
    ).toBe(403);
  });
  it("sets a signed cookie and reads sprint and delivery data", async () => {
    const login = await request(
      "/session",
      "POST",
      { password: "teacher-test" },
      false,
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await (await request("/sprints")).json()).length).toBe(2);
    const data = await (await request("/deliveries?sprintId=demo-2")).json();
    expect(data.students[0].counts).toEqual({
      one: 2,
      twoThree: 3,
      fourFive: 1,
      overFive: 0,
    });
  });
  it("resets the limiter after every successful sign-in", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await request(
        "/session",
        "POST",
        { password: "teacher-test" },
        false,
      );
      expect(response.status).toBe(200);
    }
  });
  it("validates, saves, updates without duplicates, and deletes attendance", async () => {
    const input = {
      studentId: "demo-0",
      studentName: "Lara",
      sprintId: "demo-2",
      sprintName: "Sprint 2",
      sessionDate: "2026-10-02",
      sessionType: "PLANNING",
      category: "REMOTE_JUSTIFIED",
    };
    expect(
      (await request("/attendance", "POST", { ...input, category: "INVALID" }))
        .status,
    ).toBe(400);
    const first = await (await request("/attendance", "POST", input)).json();
    const second = await (
      await request("/attendance", "POST", {
        ...input,
        category: "ABSENT_JUSTIFIED",
      })
    ).json();
    expect(first.id).toBe(second.id);
    const data = await (await request("/attendance?sprintId=demo-2")).json();
    expect(data.records).toHaveLength(1);
    expect(data.records[0].category).toBe("ABSENT_JUSTIFIED");
    expect((await request("/attendance?id=" + first.id, "DELETE")).status).toBe(
      200,
    );
    expect(
      (await (await request("/attendance?sprintId=demo-2")).json()).records,
    ).toHaveLength(0);
  });
  it("logs out and rejects the expired session", async () => {
    const response = await request("/session", "DELETE");
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect((await request("/sprints")).status).toBe(401);
  });
});

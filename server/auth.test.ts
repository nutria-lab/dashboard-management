import { describe, it, expect, beforeEach } from "vitest";
import {
  authenticated,
  constantEqual,
  sameOrigin,
  setSession,
  sessionRole,
} from "./auth.js";
import type { IncomingMessage, ServerResponse } from "node:http";
beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = "teacher-test";
  process.env.STUDENT_DASHBOARD_PASSWORD = "student-test";
  process.env.SESSION_SECRET = "test-only-secret-at-least-32-characters";
});
describe("teacher session", () => {
  it("rejects tampered and expired cookies", () => {
    let cookie = "";
    setSession({
      setHeader: (_k: string, v: string) => {
        cookie = v;
      },
    } as unknown as ServerResponse);
    const req = { headers: { cookie } } as IncomingMessage;
    expect(authenticated(req)).toBe(true);
    expect(
      authenticated({
        headers: {
          cookie: cookie.replace(
            /lab_session=teacher\.\d+/,
            "lab_session=teacher.1",
          ),
        },
      } as IncomingMessage),
    ).toBe(false);
    expect(
      authenticated({
        headers: { cookie: cookie.replace(/\.[a-zA-Z0-9_-]+;/, ".bad;") },
      } as IncomingMessage),
    ).toBe(false);
  });
  it("checks passwords and request origins", () => {
    expect(constantEqual("one", "two")).toBe(false);
    expect(constantEqual("one", "one")).toBe(true);
    expect(
      sameOrigin({
        headers: { origin: "https://evil.test", host: "app.test" },
      } as IncomingMessage),
    ).toBe(false);
    expect(
      sameOrigin({
        headers: { origin: "https://app.test", host: "app.test" },
      } as IncomingMessage),
    ).toBe(true);
  });
  it("invalidates cookies after password rotation", () => {
    process.env.DASHBOARD_PASSWORD = "first-password";
    let cookie = "";
    setSession({
      setHeader: (_key: string, value: string) => {
        cookie = value;
      },
    } as unknown as ServerResponse);
    expect(authenticated({ headers: { cookie } } as IncomingMessage)).toBe(
      true,
    );
    process.env.DASHBOARD_PASSWORD = "second-password";
    expect(authenticated({ headers: { cookie } } as IncomingMessage)).toBe(
      false,
    );
    delete process.env.DASHBOARD_PASSWORD;
  });
});

describe("role-bound sessions", () => {
  function cookieFor(role: "teacher" | "student") {
    let cookie = "";
    setSession(
      {
        setHeader: (_key: string, value: string) => {
          cookie = value;
        },
      } as unknown as ServerResponse,
      false,
      role,
    );
    return cookie;
  }
  it("binds the role to the signature and rejects legacy or forged sessions", () => {
    const cookie = cookieFor("student");
    expect(sessionRole({ headers: { cookie } } as IncomingMessage)).toBe(
      "student",
    );
    expect(
      sessionRole({
        headers: { cookie: cookie.replace("student.", "teacher.") },
      } as IncomingMessage),
    ).toBeNull();
    expect(
      sessionRole({
        headers: { cookie: cookie.replace("student.", "") },
      } as IncomingMessage),
    ).toBeNull();
  });
  it("rotates only sessions for the changed password and rejects unconfigured student access", () => {
    const teacher = cookieFor("teacher");
    const student = cookieFor("student");
    process.env.STUDENT_DASHBOARD_PASSWORD = "rotated-student";
    expect(
      sessionRole({ headers: { cookie: student } } as IncomingMessage),
    ).toBeNull();
    expect(
      sessionRole({ headers: { cookie: teacher } } as IncomingMessage),
    ).toBe("teacher");
    delete process.env.STUDENT_DASHBOARD_PASSWORD;
    expect(
      sessionRole({ headers: { cookie: student } } as IncomingMessage),
    ).toBeNull();
  });
});

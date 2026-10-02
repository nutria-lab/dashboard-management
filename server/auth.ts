import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRole } from "../shared/types.js";
const COOKIE = "lab_session";
const maxAge = 8 * 60 * 60;
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("Set SESSION_SECRET to at least 32 random characters.");
  return value;
}
export function rolePassword(role: SessionRole) {
  return role === "teacher"
    ? process.env.DASHBOARD_PASSWORD
    : process.env.STUDENT_DASHBOARD_PASSWORD;
}
function sign(value: string, role: SessionRole) {
  return createHmac("sha256", secret())
    .update(rolePassword(role) ?? "")
    .update(value)
    .digest("base64url");
}
export function constantEqual(a: string, b: string) {
  const first = createHmac("sha256", secret()).update(a).digest();
  const second = createHmac("sha256", secret()).update(b).digest();
  return timingSafeEqual(first, second);
}
export function sessionRole(req: IncomingMessage): SessionRole | null {
  const token = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token) return null;
  const [role, expires, nonce, signature, extra] = token.split(".");
  if (
    (role !== "teacher" && role !== "student") ||
    extra ||
    !expires ||
    !nonce ||
    !signature ||
    !/^\d+$/.test(expires) ||
    Number(expires) <= Date.now()
  )
    return null;
  if (!rolePassword(role)) return null;
  if (role === "student" && rolePassword(role) === rolePassword("teacher"))
    return null;
  return constantEqual(signature, sign(`${role}.${expires}.${nonce}`, role))
    ? role
    : null;
}
export function authenticated(req: IncomingMessage) {
  return sessionRole(req) !== null;
}
export function setSession(
  res: ServerResponse,
  logout = false,
  role: SessionRole = "teacher",
) {
  const value = `${role}.${Date.now() + maxAge * 1000}.${randomBytes(16).toString("hex")}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${logout ? "" : `${value}.${sign(value, role)}`}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
}
export function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
export function hashClientKey(value: string) {
  return createHmac("sha256", secret())
    .update("login-ip:")
    .update(value)
    .digest("hex");
}

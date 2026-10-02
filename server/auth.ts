import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
const COOKIE = "lab_session";
const maxAge = 8 * 60 * 60;
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("Set SESSION_SECRET to at least 32 random characters.");
  return value;
}
function sign(value: string) {
  return createHmac("sha256", secret())
    .update(process.env.DASHBOARD_PASSWORD ?? "")
    .update(value)
    .digest("base64url");
}
export function constantEqual(a: string, b: string) {
  const first = createHmac("sha256", secret()).update(a).digest();
  const second = createHmac("sha256", secret()).update(b).digest();
  return timingSafeEqual(first, second);
}
export function authenticated(req: IncomingMessage) {
  const token = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token) return false;
  const [expires, nonce, signature, extra] = token.split(".");
  if (
    extra ||
    !expires ||
    !nonce ||
    !signature ||
    !/^\d+$/.test(expires) ||
    Number(expires) <= Date.now()
  )
    return false;
  return constantEqual(signature, sign(`${expires}.${nonce}`));
}
export function setSession(res: ServerResponse, logout = false) {
  const value = `${Date.now() + maxAge * 1000}.${randomBytes(16).toString("hex")}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${logout ? "" : `${value}.${sign(value)}`}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
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

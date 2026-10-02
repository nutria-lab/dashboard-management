import { getPrismaClient } from "./db.js";

const MAX_ATTEMPTS = 5;
const WINDOW_MILLISECONDS = 15 * 60 * 1000;
const MAX_LOCAL_KEYS = 10_000;
const LOCAL_CLEANUP_BATCH_SIZE = 100;

interface LocalAttemptWindow {
  count: number;
  expiresAt: number;
}

interface LoginAttemptRow {
  attemptCount: number;
}

const localAttempts = new Map<string, LocalAttemptWindow>();

function validateKeyHash(key: string): string {
  // Callers pass an HMAC-SHA-256 digest so raw IP addresses never reach storage.
  const keyHash = typeof key === "string" ? key.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/i.test(keyHash)) {
    throw new Error("A 64-character SHA-256 HMAC login-attempt key is required.");
  }

  return keyHash;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function pruneLocalAttempts(now: number): void {
  let removed = 0;

  for (const [key, attempt] of localAttempts) {
    if (attempt.expiresAt <= now) {
      localAttempts.delete(key);
      removed += 1;
      if (removed >= LOCAL_CLEANUP_BATCH_SIZE) break;
    }
  }
}

function consumeLocalAttempt(keyHash: string, now: number): boolean {
  pruneLocalAttempts(now);

  const attempt = localAttempts.get(keyHash);
  if (attempt && attempt.expiresAt > now) {
    attempt.count = Math.min(attempt.count + 1, MAX_ATTEMPTS + 1);
    return attempt.count <= MAX_ATTEMPTS;
  }

  if (!attempt && localAttempts.size >= MAX_LOCAL_KEYS) return false;

  localAttempts.set(keyHash, {
    count: 1,
    expiresAt: now + WINDOW_MILLISECONDS,
  });
  return true;
}

async function cleanupExpiredAttempts(): Promise<void> {
  await getPrismaClient().$executeRaw`
    WITH expired_attempts AS (
      SELECT "keyHash"
      FROM "LoginAttempt"
      WHERE "expiresAt" <= CURRENT_TIMESTAMP
      ORDER BY "expiresAt" ASC
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "LoginAttempt" AS attempts
    USING expired_attempts
    WHERE attempts."keyHash" = expired_attempts."keyHash"
      AND attempts."expiresAt" <= CURRENT_TIMESTAMP
  `;
}

export async function consumeLoginAttempt(key: string): Promise<boolean> {
  const keyHash = validateKeyHash(key);
  if (!isProduction()) return consumeLocalAttempt(keyHash, Date.now());

  const prisma = getPrismaClient();
  const rows = await prisma.$queryRaw<LoginAttemptRow[]>`
    INSERT INTO "LoginAttempt" ("keyHash", "attemptCount", "windowStartedAt", "expiresAt")
    VALUES (${keyHash}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes')
    ON CONFLICT ("keyHash") DO UPDATE
    SET
      "attemptCount" = CASE
        WHEN "LoginAttempt"."expiresAt" <= CURRENT_TIMESTAMP THEN 1
        ELSE LEAST("LoginAttempt"."attemptCount" + 1, 6)
      END,
      "windowStartedAt" = CASE
        WHEN "LoginAttempt"."expiresAt" <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP
        ELSE "LoginAttempt"."windowStartedAt"
      END,
      "expiresAt" = CASE
        WHEN "LoginAttempt"."expiresAt" <= CURRENT_TIMESTAMP
          THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
        ELSE "LoginAttempt"."expiresAt"
      END
    RETURNING "attemptCount"
  `;

  const attemptCount = rows[0]?.attemptCount;
  if (attemptCount === undefined) {
    throw new Error("The login-attempt counter did not return its updated count.");
  }

  await cleanupExpiredAttempts();
  return attemptCount <= MAX_ATTEMPTS;
}

export async function resetLoginAttempts(key: string): Promise<void> {
  const keyHash = validateKeyHash(key);
  if (!isProduction()) {
    localAttempts.delete(keyHash);
    return;
  }

  await getPrismaClient().loginAttempt.deleteMany({ where: { keyHash } });
}

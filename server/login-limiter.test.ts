import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "./db.js";
import { consumeLoginAttempt, resetLoginAttempts } from "./login-limiter.js";

vi.mock("./db.js", () => ({ getPrismaClient: vi.fn() }));

const prismaMock = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  loginAttempt: { deleteMany: vi.fn() },
};

const originalNodeEnv = process.env.NODE_ENV;
const testSessionSecret = "test-only-secret-at-least-32-characters";
const localKey = createHmac("sha256", testSessionSecret).update("local-client").digest("hex");
const productionKey = createHmac("sha256", testSessionSecret)
  .update("production-client")
  .digest("hex");

describe("local login-attempt limiter", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    await resetLoginAttempts(localKey);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows five attempts and rejects the sixth", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await consumeLoginAttempt(localKey)).toBe(true);
    }
    expect(await consumeLoginAttempt(localKey)).toBe(false);
  });

  it("clears the window after a successful login reset", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await consumeLoginAttempt(localKey)).toBe(true);
    }
    expect(await consumeLoginAttempt(localKey)).toBe(false);

    await resetLoginAttempts(localKey);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await consumeLoginAttempt(localKey)).toBe(true);
    }
  });

  it("starts a fresh window after fifteen minutes", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await consumeLoginAttempt(localKey)).toBe(true);
    }
    expect(await consumeLoginAttempt(localKey)).toBe(false);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(await consumeLoginAttempt(localKey)).toBe(true);
  });

  it("rejects raw IP values instead of storing them", async () => {
    await expect(consumeLoginAttempt("203.0.113.42")).rejects.toThrow(
      "A 64-character SHA-256 HMAC login-attempt key is required.",
    );
  });
});

describe("production login-attempt limiter", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    vi.clearAllMocks();
    vi.mocked(getPrismaClient).mockReturnValue(
      prismaMock as unknown as ReturnType<typeof getPrismaClient>,
    );
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("atomically upserts a parameterized counter and allows the fifth attempt", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ attemptCount: 5 }]);

    await expect(consumeLoginAttempt(productionKey)).resolves.toBe(true);

    const [template, parameter] = prismaMock.$queryRaw.mock.calls[0];
    expect(Array.from(template).join("?")).not.toContain(productionKey);
    expect(parameter).toBe(productionKey);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);

    const [cleanupTemplate] = prismaMock.$executeRaw.mock.calls[0];
    const cleanupSql = Array.from(cleanupTemplate).join(" ").replace(/\s+/g, " ");
    expect(cleanupSql).toContain("LIMIT 100");
    expect(cleanupSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cleanupSql).toContain('attempts."expiresAt" <= CURRENT_TIMESTAMP');
  });

  it("rejects attempts above the five-attempt limit and clears rows on reset", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ attemptCount: 6 }]);
    prismaMock.loginAttempt.deleteMany.mockResolvedValue({ count: 1 });

    await expect(consumeLoginAttempt(productionKey)).resolves.toBe(false);
    await resetLoginAttempts(productionKey);

    expect(prismaMock.loginAttempt.deleteMany).toHaveBeenCalledWith({
      where: { keyHash: productionKey },
    });
  });
});

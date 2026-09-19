import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RedisClient } from "@/redis/index.js";
import type { AdminUserRecord } from "@/repositories/index.js";

const scryptAsync = promisify(scrypt);

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_PREFIX = "notif:session:";

/**
 * Pre-computed dummy hash conforming to salt(16 bytes hex):hash(64 bytes hex).
 * Used during authentication failure to equalize execution time and prevent
 * user enumeration via scrypt timing side-channels.
 */
export const DUMMY_PASSWORD_HASH =
  "00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

export interface AdminSession {
  token: string;
  adminId: string;
  email: string;
  username: string | null;
  role: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Hashes a plaintext password using crypto.scrypt with a random 16-byte salt.
 * Returns salt and hash separated by a colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored salt:hash string using constant-time comparison.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;

  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = (await scryptAsync(password, salt, keyBuffer.length)) as Buffer;

  if (derivedKey.length !== keyBuffer.length) {
    return false;
  }
  return timingSafeEqual(derivedKey, keyBuffer);
}

/**
 * Creates a secure session in Redis for an authenticated admin user.
 */
export async function createAdminSession(
  redis: RedisClient["native"],
  user: AdminUserRecord,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
): Promise<AdminSession> {
  const token = `nk_sess_${randomBytes(32).toString("hex")}`;
  const now = Date.now();
  const session: AdminSession = {
    token,
    adminId: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  await redis.set(`${SESSION_PREFIX}${token}`, JSON.stringify(session), "EX", ttlSeconds);
  return session;
}

/**
 * Retrieves an admin session from Redis if valid and unexpired.
 */
export async function getAdminSession(
  redis: RedisClient["native"],
  token: string,
): Promise<AdminSession | null> {
  if (!token || !token.startsWith("nk_sess_")) return null;
  const raw = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as AdminSession;
    if (session.expiresAt <= Date.now()) {
      await redis.del(`${SESSION_PREFIX}${token}`);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Revokes an active admin session.
 */
export async function revokeAdminSession(
  redis: RedisClient["native"],
  token: string,
): Promise<void> {
  if (!token) return;
  await redis.del(`${SESSION_PREFIX}${token}`);
}

#!/usr/bin/env node
/**
 * Create or update an admin user for the Notifkit Dashboard.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret node scripts/create-admin.mjs
 *   node scripts/create-admin.mjs admin@example.com secret [username] [role]
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { scrypt, randomBytes } from "node:crypto";
import { promisify } from "node:util";

config({ path: resolve(process.cwd(), ".env") });

const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

const email = process.argv[2] || process.env.ADMIN_EMAIL;
const password = process.argv[3] || process.env.ADMIN_PASSWORD;
const username = process.argv[4] || process.env.ADMIN_USERNAME || null;
const role = process.argv[5] || "admin";

if (!email || !password) {
  console.error("Usage: node scripts/create-admin.mjs <email> <password> [username] [role]");
  console.error("Or set ADMIN_EMAIL and ADMIN_PASSWORD in environment.");
  process.exit(1);
}

const databaseUrl =
  process.env.DATABASE_URL || "postgres://platform:platform@localhost:5432/notifkit";
const sql = postgres(databaseUrl);

try {
  const passwordHash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username ? username.trim() : null;

  const rows = await sql`
    INSERT INTO admin_users (email, username, password_hash, role)
    VALUES (${normalizedEmail}, ${normalizedUsername}, ${passwordHash}, ${role})
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        username = COALESCE(EXCLUDED.username, admin_users.username),
        role = EXCLUDED.role,
        updated_at = NOW()
    RETURNING id, email, username, role, created_at, updated_at
  `;

  console.log("\nAdmin user successfully saved:\n");
  console.log(`  ID:       ${rows[0].id}`);
  console.log(`  Email:    ${rows[0].email}`);
  console.log(`  Username: ${rows[0].username || "(none)"}`);
  console.log(`  Role:     ${rows[0].role}\n`);
} catch (err) {
  console.error(`Failed to create admin: ${err.message}`);
  process.exit(1);
} finally {
  await sql.end();
}

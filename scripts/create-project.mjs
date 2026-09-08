#!/usr/bin/env node
/**
 * Create a project and print its API key.
 *
 * Every `/v1/*` route needs a project API key, and a project API key can only
 * be minted with the admin credential, so this is the one bootstrap step
 * between a running server and the first notification.
 *
 *   ADMIN_API_KEY=supersecretkey npm run create-project
 *   ADMIN_API_KEY=supersecretkey npx notifkit-create-project "my-app"
 *
 * ADMIN_API_KEY is the same variable the server reads, so pass the value the
 * server was started with.
 */

const adminKey = process.env.ADMIN_API_KEY;
const baseUrl = (process.env.NOTIFKIT_URL || "http://localhost:3000").replace(/\/$/, "");
const name = process.argv[2] || process.env.PROJECT_NAME || "my-app";

function fail(message) {
  console.error(`create-project: ${message}`);
  process.exit(1);
}

if (!adminKey) {
  fail(
    "no admin credential. Set ADMIN_API_KEY to the same value the server was started with:\n" +
      "  ADMIN_API_KEY=supersecretkey npm run create-project",
  );
}

let res;
try {
  res = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminKey}` },
    body: JSON.stringify({ name }),
  });
} catch (err) {
  fail(`could not reach the server at ${baseUrl} — is it running? (${err.message})`);
}

if (res.status === 401) {
  fail("admin credential rejected. It must match the server's ADMIN_API_KEY exactly.");
}

if (res.status === 403) {
  fail("project management is disabled. Start the server with ADMIN_API_KEY set.");
}

if (!res.ok) {
  fail(`server returned ${res.status}: ${await res.text()}`);
}

const { id, apiKey } = await res.json();

// The server keeps only a hash of the key, so this is the only time the value
// itself exists anywhere. Print it in .env form to make that the obvious move.
console.log(`\nProject "${name}" created. Save the API key now — it is not recoverable.\n`);
console.log(`NOTIFKIT_PROJECT_ID=${id}`);
console.log(`NOTIFKIT_API_KEY=${apiKey}\n`);

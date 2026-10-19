#!/usr/bin/env node
/**
 * The `notifkit` command. Today it has one subcommand, which hands off to
 * create-notifkit so both spellings scaffold the same app:
 *
 *   npx notifkit create my-app
 *   npm create notifkit@latest my-app
 */

import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (command !== "create") {
  console.error(
    "Usage: notifkit create [name] [options]\n\n" +
      "Scaffolds a new notifkit app. Run `notifkit create --help` for options.",
  );
  process.exit(command ? 1 : 0);
}

const npmArgs = [
  "exec",
  "--yes",
  "--package=create-notifkit@latest",
  "--",
  "create-notifkit",
  ...args,
];

// npm is a .cmd shim on Windows, which only runs through a shell.
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
const child =
  process.platform === "win32"
    ? spawn(["npm", ...npmArgs].map(quote).join(" "), { stdio: "inherit", shell: true })
    : spawn("npm", npmArgs, { stdio: "inherit" });

child.on("error", (err) => {
  console.error(`notifkit create: could not run npm (${err.message})`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));

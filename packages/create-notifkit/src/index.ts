#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run, runCommand } from "./cli.js";

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  interactive,
  userAgent: process.env.npm_config_user_agent,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  async prompt(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  install: (dir, pm) => runCommand(pm, ["install"], dir),
});

#!/usr/bin/env node
/**
 * Turns the coverage summary vitest writes into a shields.io endpoint payload.
 *
 * CI publishes the result to the orphan `badges` branch, which the README's
 * badge reads over raw.githubusercontent. Keeping the number in the repo means
 * no third-party coverage service and no secret beyond the built-in token.
 *
 * Usage: node scripts/coverage-badge.mjs [--out <path>] [--metric lines]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SUMMARY = "coverage/coverage-summary.json";

/** Shields renders whatever colour we hand it, so the thresholds live here. */
const colorFor = (pct) =>
  pct >= 90 ? "brightgreen" : pct >= 80 ? "green" : pct >= 70 ? "yellowgreen" : pct >= 60 ? "yellow" : pct >= 50 ? "orange" : "red";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const out = resolve(arg("--out", "coverage-badge.json"));
const metric = arg("--metric", "lines");

let summary;
try {
  summary = JSON.parse(await readFile(SUMMARY, "utf8"));
} catch (err) {
  // Better to fail loudly than publish a stale or invented number.
  console.error(
    `coverage-badge: could not read ${SUMMARY} (${err.code ?? err.message}).\n` +
      `Run the suite with coverage first, and make sure "json-summary" is in\n` +
      `coverage.reporter in vitest.config.ts.`,
  );
  process.exit(1);
}

const total = summary.total?.[metric]?.pct;
if (typeof total !== "number" || Number.isNaN(total)) {
  console.error(`coverage-badge: no numeric total.${metric}.pct in ${SUMMARY}`);
  process.exit(1);
}

// One decimal keeps 74.59 from rounding up to a friendlier-looking 75.
const pct = Math.round(total * 10) / 10;

await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify({ schemaVersion: 1, label: "coverage", message: `${pct}%`, color: colorFor(pct) }, null, 2) + "\n",
);

// The workflow reads this line to label the badge commit.
console.log(`coverage-badge: ${pct}% (${metric}) -> ${out}`);
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_OUTPUT, `pct=${pct}\n`);
}

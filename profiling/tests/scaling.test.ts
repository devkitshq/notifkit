import { runLoadBenchmark, type BenchmarkResult } from "./load.test.js";

export interface CpuScalingTier {
  cpus: string;
  memory: string;
  dbCpus: string;
  dbMemory: string;
  redisCpus: string;
  redisMemory: string;
  workerConcurrency?: number;
  label: string;
}

export interface ScalingBenchmarkOptions {
  tiers?: CpuScalingTier[];
  durationSeconds?: number;
  concurrency?: number;
  providerLatencyMs?: number | string;
}

const DEFAULT_TIERS: CpuScalingTier[] = [
  {
    cpus: "0.5",
    memory: "1G",
    dbCpus: "0.5",
    dbMemory: "512M",
    redisCpus: "0.5",
    redisMemory: "256M",
    workerConcurrency: 25,
    label: "0.5 vCPU",
  },
  {
    cpus: "1.0",
    memory: "2G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 50,
    label: "1.0 vCPU",
  },
  {
    cpus: "2.0",
    memory: "4G",
    dbCpus: "1.5",
    dbMemory: "2G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 100,
    label: "2.0 vCPU",
  },
  {
    cpus: "4.0",
    memory: "6G",
    dbCpus: "2.0",
    dbMemory: "3G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 200,
    label: "4.0 vCPU",
  },
];

function parseArgs(): ScalingBenchmarkOptions {
  const args = process.argv.slice(2);
  let durationSeconds = 10;
  let concurrency = 50;
  let tiers = DEFAULT_TIERS;
  let providerLatencyMs: number | string | undefined = process.env.PROVIDER_LATENCY_MS || "200-300";

  for (const arg of args) {
    if (arg.startsWith("--duration=")) {
      durationSeconds = parseInt(arg.split("=")[1]!, 10);
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parseInt(arg.split("=")[1]!, 10);
    } else if (arg.startsWith("--latency=")) {
      const val = arg.split("=")[1]!;
      providerLatencyMs = val.includes("-") ? val : parseInt(val, 10);
    } else if (arg === "--quick") {
      durationSeconds = 5;
    } else if (arg.startsWith("--cpus=")) {
      const cpusList = arg
        .split("=")[1]!
        .split(",")
        .map((s) => s.trim());
      tiers = cpusList.map((c) => {
        const num = parseFloat(c);
        let mem = "1G";
        let dbC = "0.5";
        let dbM = "512M";
        let redC = "0.5";
        let redM = "256M";

        if (num >= 4) {
          mem = "6G";
          dbC = "2.0";
          dbM = "3G";
          redC = "1.0";
          redM = "1G";
        } else if (num >= 2) {
          mem = "4G";
          dbC = "1.5";
          dbM = "2G";
          redC = "1.0";
          redM = "1G";
        } else if (num >= 1) {
          mem = "2G";
          dbC = "1.0";
          dbM = "1G";
          redC = "0.5";
          redM = "512M";
        }

        return {
          cpus: c,
          memory: mem,
          dbCpus: dbC,
          dbMemory: dbM,
          redisCpus: redC,
          redisMemory: redM,
          label: `${c} vCPU`,
        };
      });
    }
  }

  return { tiers, durationSeconds, concurrency, providerLatencyMs };
}

export async function runCpuScalingBenchmark(options: ScalingBenchmarkOptions = {}) {
  const tiers = options.tiers ?? DEFAULT_TIERS;
  const durationSeconds = options.durationSeconds ?? 10;
  const concurrency = options.concurrency ?? 50;
  const providerLatencyMs = options.providerLatencyMs ?? "200-300";

  console.log(
    "\n==========================================================================================",
  );
  console.log("   🚀 STARTING NOTIFKIT CPU SCALING BENCHMARK SUITE");
  console.log(
    "==========================================================================================",
  );
  console.log(`Evaluated Tiers:       ${tiers.map((t) => t.label).join(", ")}`);
  console.log(`Test Duration/Tier:    ${durationSeconds}s`);
  console.log(`Virtual Users:         ${concurrency}`);
  if (providerLatencyMs && providerLatencyMs !== "0" && providerLatencyMs !== 0) {
    console.log(`Mock Provider Latency: ${providerLatencyMs}ms`);
  }
  console.log(
    "==========================================================================================\n",
  );

  const results: { tier: CpuScalingTier; result: BenchmarkResult }[] = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    console.log(
      `\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`,
    );
    console.log(
      `[Tier ${i + 1}/${tiers.length}] Benchmarking ${tier.label} (${tier.memory} RAM | DB: ${tier.dbCpus} CPU, ${tier.dbMemory} | Redis: ${tier.redisCpus} CPU, ${tier.redisMemory})`,
    );
    console.log(
      `>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`,
    );

    try {
      const result = await runLoadBenchmark({
        serverCpus: tier.cpus,
        serverMemory: tier.memory,
        dbCpus: tier.dbCpus,
        dbMemory: tier.dbMemory,
        redisCpus: tier.redisCpus,
        redisMemory: tier.redisMemory,
        workerConcurrency: tier.workerConcurrency,
        providerLatencyMs,
        durationSeconds,
        concurrency,
      });
      results.push({ tier, result });
    } catch (err) {
      console.error(`❌ Benchmark failed for tier ${tier.label}:`, err);
    }

    if (i < tiers.length - 1) {
      console.log(`\n⏳ Cooling down for 3s before next tier...\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Print comparative summary table
  printScalingSummary(results);
}

function printScalingSummary(results: { tier: CpuScalingTier; result: BenchmarkResult }[]) {
  if (results.length === 0) {
    console.log("\n❌ No benchmark results collected.");
    return;
  }

  const baselineDelivery = results[0]?.result.activeDeliveryRate || 1;

  console.log("\n");
  console.log(
    "===============================================================================================================================================================",
  );
  console.log(
    "                                                    📊 NOTIFKIT SERVER CPU SCALING BENCHMARK SUMMARY 📊",
  );
  console.log(
    "===============================================================================================================================================================",
  );
  console.log(
    [
      "Server Tier".padEnd(12),
      "Server RAM".padEnd(10),
      "DB (CPU/RAM)".padEnd(14),
      "Redis (CPU/RAM)".padEnd(15),
      "Ingestion".padStart(13),
      "Active Deliv".padStart(13),
      "Wall Drain".padStart(12),
      "API p95".padStart(9),
      "Deliv p95".padStart(11),
      "1st Msg".padStart(9),
      "Speedup".padStart(10),
    ].join(" | "),
  );
  console.log("-".repeat(159));

  for (const { tier, result } of results) {
    const speedup = (result.activeDeliveryRate / baselineDelivery).toFixed(2) + "x";
    const dbSpec = `${tier.dbCpus}c / ${tier.dbMemory}`;
    const redisSpec = `${tier.redisCpus}c / ${tier.redisMemory}`;

    console.log(
      [
        tier.label.padEnd(12),
        tier.memory.padEnd(10),
        dbSpec.padEnd(14),
        redisSpec.padEnd(15),
        `${result.ingestionThroughput.toFixed(1)} req/s`.padStart(13),
        `${result.activeDeliveryRate.toFixed(1)} msg/s`.padStart(13),
        `${result.totalDeliveryRate.toFixed(1)} msg/s`.padStart(12),
        `${result.apiP95}ms`.padStart(9),
        `${result.deliveryP95}ms`.padStart(11),
        `+${result.firstDelivOffset.toFixed(2)}s`.padStart(9),
        speedup.padStart(10),
      ].join(" | "),
    );
  }

  console.log(
    "===============================================================================================================================================================\n",
  );

  // Summary takeaways
  console.log("📌 SCALING ANALYSIS & TAKEAWAYS:");
  for (let i = 0; i < results.length; i++) {
    const curr = results[i]!;
    if (i === 0) {
      console.log(
        ` • Baseline (${curr.tier.label}): ${curr.result.activeDeliveryRate.toFixed(1)} msgs/sec delivery, ${curr.result.ingestionThroughput.toFixed(1)} req/sec ingestion.`,
      );
    } else {
      const prev = results[i - 1]!;
      const ingGain = (
        ((curr.result.ingestionThroughput - prev.result.ingestionThroughput) /
          prev.result.ingestionThroughput) *
        100
      ).toFixed(1);
      const delivGain = (
        ((curr.result.activeDeliveryRate - prev.result.activeDeliveryRate) /
          prev.result.activeDeliveryRate) *
        100
      ).toFixed(1);

      console.log(
        ` • ${prev.tier.label} ➔ ${curr.tier.label}: Ingestion ${Number(ingGain) >= 0 ? "+" : ""}${ingGain}%, Active Delivery ${Number(delivGain) >= 0 ? "+" : ""}${delivGain}%.`,
      );
    }
  }

  // Detect plateauing
  if (results.length >= 3) {
    const last = results[results.length - 1]!.result.activeDeliveryRate;
    const secondLast = results[results.length - 2]!.result.activeDeliveryRate;
    const diff = ((last - secondLast) / secondLast) * 100;
    if (diff < 15) {
      console.log(
        `\n⚠️ Noticeable throughput plateau between ${results[results.length - 2]!.tier.label} and ${results[results.length - 1]!.tier.label} (+${diff.toFixed(1)}%).`,
      );
      console.log(
        `   Because Notifkit runs as a single Node.js event loop, adding vCPUs beyond 1-2 cores primarily benefits V8 GC/crypto threads. Core delivery remains limited by single-thread concurrency and batch timer intervals (e.g. 100ms batch flush).`,
      );
    }
  }

  console.log("\n");
}

// Auto-execute if run from CLI
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("scaling.test.ts") || process.argv[1].endsWith("scaling.test.js"));

if (isDirectRun) {
  const options = parseArgs();
  runCpuScalingBenchmark(options).catch((err) => {
    console.error("Scaling benchmark failed:", err);
    process.exit(1);
  });
}

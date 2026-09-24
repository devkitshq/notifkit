import {
  runDistributedBenchmark,
  type DistributedBenchmarkResult,
} from "./distributed-load.test.js";

export interface DistributedTier {
  serverCount: number;
  serverCpus: string;
  serverMemory: string;
  dbCpus: string;
  dbMemory: string;
  redisCpus: string;
  redisMemory: string;
  workerConcurrency: number;
  label: string;
}

const DEFAULT_DISTRIBUTED_TIERS: DistributedTier[] = [
  {
    serverCount: 1,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 50,
    label: "1 Server (1.0 vCPU)",
  },
  {
    serverCount: 2,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 50,
    label: "2 Distributed Servers (2x 1.0 vCPU)",
  },
  {
    serverCount: 3,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 50,
    label: "3 Distributed Servers (3x 1.0 vCPU)",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let durationSeconds = 10;
  let customConcurrency: number | null = null;
  let tiers = DEFAULT_DISTRIBUTED_TIERS;

  for (const arg of args) {
    if (arg.startsWith("--duration=")) {
      durationSeconds = parseInt(arg.split("=")[1]!, 10);
    } else if (arg.startsWith("--concurrency=")) {
      customConcurrency = parseInt(arg.split("=")[1]!, 10);
    } else if (arg === "--quick") {
      durationSeconds = 5;
    } else if (arg.startsWith("--servers=")) {
      const counts = arg
        .split("=")[1]!
        .split(",")
        .map((s) => parseInt(s.trim(), 10));
      tiers = counts.map((count) => ({
        serverCount: count,
        serverCpus: "1.0",
        serverMemory: "1G",
        dbCpus: "2.0",
        dbMemory: "2G",
        redisCpus: "1.5",
        redisMemory: "1G",
        workerConcurrency: 100,
        label: `${count} Server${count > 1 ? "s" : ""} (${count}x 1.0 vCPU)`,
      }));
    }
  }

  return { durationSeconds, customConcurrency, tiers };
}

function printSummaryTable(
  results: Array<{ tier: DistributedTier; res: DistributedBenchmarkResult }>,
) {
  console.log("\n" + "=".repeat(140));
  console.log("                              📊 NOTIFKIT DISTRIBUTED SCALING BENCHMARK SUMMARY 📊");
  console.log("=".repeat(140));

  const headers = [
    "Cluster Topology",
    "Clients",
    "Total vCPU",
    "Ingestion",
    "Active Deliv",
    "Wall Drain",
    "API p95",
    "Deliv p95",
    "Speedup",
  ];

  const colWidths = [36, 9, 12, 14, 15, 14, 11, 12, 10];

  const formatRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(colWidths[idx]!)).join(" | ");

  console.log(formatRow(headers));
  console.log("-".repeat(140));

  const baselineDelivery = results[0]?.res.activeDeliveryRate || 1;

  for (const { tier, res } of results) {
    const totalCpu = `${(tier.serverCount * parseFloat(tier.serverCpus)).toFixed(1)} vCPU`;
    const speedup = (res.activeDeliveryRate / baselineDelivery).toFixed(2) + "x";

    const row = [
      tier.label,
      `${res.concurrency} VUs`,
      totalCpu,
      `${res.ingestionThroughput} req/s`,
      `${res.activeDeliveryRate} msg/s`,
      `${res.totalDeliveryRate} msg/s`,
      `${res.apiP95}ms`,
      `${res.deliveryP95}ms`,
      speedup,
    ];
    console.log(formatRow(row));
  }

  console.log("=".repeat(140) + "\n");
}

async function main() {
  const { durationSeconds, customConcurrency, tiers } = parseArgs();

  console.log("================================================================================");
  console.log("         🚀 STARTING NOTIFKIT DISTRIBUTED HORIZONTAL SCALING BENCHMARK          ");
  console.log("================================================================================");
  console.log(`Window: ${durationSeconds}s per tier | Auto Client Concurrency: 150 VUs/server`);
  console.log(`Tiers to test: ${tiers.map((t) => t.label).join("  ➜  ")}\n`);

  const results: Array<{ tier: DistributedTier; res: DistributedBenchmarkResult }> = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const tierConcurrency = customConcurrency ?? tier.serverCount * 150;
    console.log(
      `\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`,
    );
    console.log(
      `[Tier ${i + 1}/${tiers.length}] Benchmarking ${tier.label} (${tierConcurrency} Virtual Users)`,
    );
    console.log(
      `>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`,
    );

    const res = await runDistributedBenchmark({
      serverCount: tier.serverCount,
      serverCpus: tier.serverCpus,
      serverMemory: tier.serverMemory,
      dbCpus: tier.dbCpus,
      dbMemory: tier.dbMemory,
      redisCpus: tier.redisCpus,
      redisMemory: tier.redisMemory,
      workerConcurrency: tier.workerConcurrency,
      durationSeconds,
      concurrency: tierConcurrency,
    });

    results.push({ tier, res });

    if (i < tiers.length - 1) {
      console.log("⏳ Cooling down for 4s before next tier...");
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  printSummaryTable(results);
}

main().catch((err) => {
  console.error("Distributed benchmark failed:", err);
  process.exit(1);
});

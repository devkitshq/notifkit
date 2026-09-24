import {
  runDistributedBenchmark,
  type DistributedBenchmarkResult,
} from "./distributed-load.test.js";

export interface BudgetTier {
  budget: string;
  monthlyCost: number;
  serverCount: number;
  serverCpus: string;
  serverMemory: string;
  dbCpus: string;
  dbMemory: string;
  redisCpus: string;
  redisMemory: string;
  workerConcurrency: number;
  dbMaxConnections: number;
  concurrency: number;
  description: string;
  serverServices?: string[];
}

const DEFAULT_BUDGET_TIERS: BudgetTier[] = [
  {
    budget: "$20/mo",
    monthlyCost: 20,
    serverCount: 1,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 100,
    dbMaxConnections: 5,
    concurrency: 150,
    description: "1x Monolith (API + Pipeline + Delivery)",
    serverServices: ["api,enricher,engine,delivery,scheduler"],
  },
  {
    budget: "$40/mo",
    monthlyCost: 40,
    serverCount: 2,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "2.0",
    dbMemory: "2G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 200,
    dbMaxConnections: 8,
    concurrency: 300,
    description: "1x API + 1x Worker (Enricher/Engine/Delivery)",
    serverServices: ["api", "enricher,engine,delivery,scheduler"],
  },
  {
    budget: "$60/mo",
    monthlyCost: 60,
    serverCount: 3,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "3.0",
    dbMemory: "3G",
    redisCpus: "1.5",
    redisMemory: "1G",
    workerConcurrency: 300,
    dbMaxConnections: 10,
    concurrency: 300,
    description: "1x API + 1x Pipeline (Engine/Enrich) + 1x Delivery",
    serverServices: ["api", "enricher,engine,scheduler", "delivery"],
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let durationSeconds = 10;
  let providerLatencyMs: number | string | undefined = process.env.PROVIDER_LATENCY_MS || "60-150";
  let tiers = DEFAULT_BUDGET_TIERS;

  for (const arg of args) {
    if (arg.startsWith("--duration=")) {
      durationSeconds = parseInt(arg.split("=")[1]!, 10);
    } else if (arg === "--quick") {
      durationSeconds = 5;
    } else if (arg.startsWith("--latency=")) {
      const val = arg.split("=")[1]!;
      providerLatencyMs = val.includes("-") ? val : parseInt(val, 10);
    } else if (arg.startsWith("--workers=")) {
      const val = parseInt(arg.split("=")[1]!, 10);
      tiers = tiers.map((t) => ({ ...t, workerConcurrency: val }));
    } else if (arg.startsWith("--tiers=")) {
      const requested = arg
        .split("=")[1]!
        .split(",")
        .map((s) => s.trim());
      tiers = DEFAULT_BUDGET_TIERS.filter((t) => requested.includes(t.budget.replace("/mo", "")));
    }
  }

  return { durationSeconds, providerLatencyMs, tiers };
}

function printSummaryTable(results: Array<{ tier: BudgetTier; res: DistributedBenchmarkResult }>) {
  console.log("\n" + "=".repeat(150));
  console.log(
    "                                  💰 NOTIFKIT MONEY / BUDGET SCALING BENCHMARK SUMMARY 💰",
  );
  console.log("=".repeat(150));

  const headers = [
    "Budget Tier",
    "Architecture Topology",
    "Clients",
    "Ingestion",
    "Active Deliv",
    "Wall Drain",
    "API p95",
    "Deliv p95",
    "Cost Efficiency",
  ];

  const colWidths = [13, 44, 9, 14, 15, 14, 10, 11, 15];

  const formatRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(colWidths[idx]!)).join(" | ");

  console.log(formatRow(headers));
  console.log("-".repeat(150));

  for (const { tier, res } of results) {
    const msgsPerDollar = (res.activeDeliveryRate / tier.monthlyCost).toFixed(1) + " msg/s/$";

    const row = [
      tier.budget,
      tier.description,
      `${res.concurrency} VUs`,
      `${res.ingestionThroughput} req/s`,
      `${res.activeDeliveryRate} msg/s`,
      `${res.totalDeliveryRate} msg/s`,
      `${res.apiP95}ms`,
      `${res.deliveryP95}ms`,
      msgsPerDollar,
    ];
    console.log(formatRow(row));
  }

  console.log("=".repeat(150) + "\n");
}

async function main() {
  const { durationSeconds, providerLatencyMs, tiers } = parseArgs();

  console.log(
    "==========================================================================================",
  );
  console.log(
    "              💰 STARTING NOTIFKIT MONEY / BUDGET SCALING BENCHMARK                      ",
  );
  console.log(
    "==========================================================================================",
  );
  console.log(`Window: ${durationSeconds}s per tier | Measuring: $20/mo ➜ $40/mo ➜ $60/mo`);
  console.log(`Tiers to test: ${tiers.map((t) => t.budget).join("  ➜  ")}`);
  if (providerLatencyMs && providerLatencyMs !== "0") {
    console.log(`Mock Provider Latency: ${providerLatencyMs}ms`);
  }
  console.log(
    "==========================================================================================\n",
  );

  const results: Array<{ tier: BudgetTier; res: DistributedBenchmarkResult }> = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    console.log(
      `\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`,
    );
    console.log(`[Tier ${i + 1}/${tiers.length}] Benchmarking Budget Tier: ${tier.budget}`);
    console.log(`Topology: ${tier.description} (${tier.concurrency} Virtual Users)`);
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
      dbMaxConnections: tier.dbMaxConnections,
      serverServices: tier.serverServices,
      providerLatencyMs,
      durationSeconds,
      concurrency: tier.concurrency,
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
  console.error("Money scaling benchmark failed:", err);
  process.exit(1);
});

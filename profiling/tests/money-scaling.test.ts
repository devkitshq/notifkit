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
  servicesCount?: number;
  description: string;
  serverServices?: string[];
  serverNodes?: Array<{ name: string; port: number; services?: string }>;
  awsTopology?: string;
  awsCostDetails?: string;
}

const DEFAULT_BUDGET_TIERS: BudgetTier[] = [
  {
    budget: "$20/mo",
    monthlyCost: 20,
    serverCount: 1,
    serverCpus: "1.5",
    serverMemory: "1.5G",
    dbCpus: "0.5",
    dbMemory: "512M",
    redisCpus: "0.5",
    redisMemory: "256M",
    workerConcurrency: 80,
    dbMaxConnections: 5,
    concurrency: 100,
    servicesCount: 5,
    description: "1x Monolith on EC2 t4g.small",
    awsTopology: "1x EC2 t4g.small (Monolith)",
    awsCostDetails:
      "EC2 t4g.small (2 vCPU/2G: $12.26) + 30GB gp3 ($2.40) + IPv4/Net ($5.34) = ~$20.00/mo",
    serverServices: ["api,enricher,engine,delivery,scheduler"],
    serverNodes: [
      { name: "monolith-server", port: 35678, services: "api,enricher,engine,delivery,scheduler" },
    ],
  },
  {
    budget: "$40/mo",
    monthlyCost: 40,
    serverCount: 2,
    serverCpus: "2.0",
    serverMemory: "2G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 160,
    dbMaxConnections: 8,
    concurrency: 180,
    servicesCount: 6,
    description: "1x API + 1x Worker (RDS db.t4g.micro + ElastiCache)",
    awsTopology: "1x EC2 t4g.small + RDS db.t4g.micro + ElastiCache t4g.micro",
    awsCostDetails:
      "EC2 t4g.small ($13.86) + RDS db.t4g.micro ($13.98) + ElastiCache Valkey ($9.34) + Net ($2.82) = ~$40.00/mo",
    serverServices: ["api", "enricher,engine,delivery,scheduler"],
    serverNodes: [
      { name: "api-server-1", port: 35678, services: "api" },
      { name: "worker-node", port: 35679, services: "enricher,engine,delivery,scheduler" },
    ],
  },
  {
    budget: "$60/mo",
    monthlyCost: 60,
    serverCount: 3,
    serverCpus: "2.0",
    serverMemory: "2G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 220,
    dbMaxConnections: 10,
    concurrency: 240,
    servicesCount: 8,
    description: "1x API + 1x Pipeline + 1x Delivery (Decoupled Compute)",
    awsTopology: "2x EC2 t4g.small + RDS db.t4g.micro + ElastiCache t4g.micro + ALB",
    awsCostDetails:
      "2x EC2 t4g.small ($27.72) + RDS db.t4g.micro ($13.98) + ElastiCache Valkey ($9.34) + ALB/Net ($8.96) = ~$60.00/mo",
    serverServices: ["api", "enricher,engine,scheduler", "delivery"],
    serverNodes: [
      { name: "api-server-1", port: 35678, services: "api" },
      { name: "pipeline-worker", port: 35680, services: "enricher,engine,scheduler" },
      { name: "delivery-worker", port: 35681, services: "delivery" },
    ],
  },
  {
    budget: "$80/mo",
    monthlyCost: 80,
    serverCount: 3,
    serverCpus: "2.0",
    serverMemory: "2G",
    dbCpus: "2.0",
    dbMemory: "2G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 280,
    dbMaxConnections: 15,
    concurrency: 280,
    servicesCount: 8,
    description: "1x API + 1x Pipeline + 1x Delivery (RDS db.t4g.small 2G)",
    awsTopology: "3x EC2 t4g.small + RDS db.t4g.small (2G) + ElastiCache t4g.micro",
    awsCostDetails:
      "3x EC2 t4g.small ($41.58) + RDS db.t4g.small ($27.70) + ElastiCache Valkey ($9.34) + Net ($1.38) = ~$80.00/mo",
    serverServices: ["api", "enricher,engine,scheduler", "delivery"],
    serverNodes: [
      { name: "api-server-1", port: 35678, services: "api" },
      { name: "pipeline-worker", port: 35680, services: "enricher,engine,scheduler" },
      { name: "delivery-worker", port: 35681, services: "delivery" },
    ],
  },
  {
    budget: "$100/mo",
    monthlyCost: 100,
    serverCount: 4,
    serverCpus: "2.0",
    serverMemory: "2G",
    dbCpus: "2.0",
    dbMemory: "2G",
    redisCpus: "1.5",
    redisMemory: "1.5G",
    workerConcurrency: 400,
    dbMaxConnections: 20,
    concurrency: 350,
    servicesCount: 10,
    description: "1x API + 1x Enricher + 1x Engine + 1x Delivery (Decoupled Pipeline)",
    awsTopology: "4x EC2 t4g.small + RDS db.t4g.small + ElastiCache cache.t4g.small",
    awsCostDetails:
      "4x EC2 t4g.small ($53.84) + RDS db.t4g.small ($28.27) + ElastiCache t4g.small ($18.69) = ~$100.80/mo",
    serverServices: ["api", "enricher,scheduler", "engine", "delivery"],
    serverNodes: [
      { name: "api-server-1", port: 35678, services: "api" },
      { name: "enricher-worker", port: 35683, services: "enricher,scheduler" },
      { name: "engine-worker", port: 35684, services: "engine" },
      { name: "delivery-worker", port: 35681, services: "delivery" },
    ],
  },
];

import fs from "node:fs";
import path from "node:path";

export interface MetricStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
}

export interface TierAggregatedStats {
  tier: BudgetTier;
  runs: DistributedBenchmarkResult[];
  ingestionThroughput: MetricStats;
  activeDeliveryRate: MetricStats;
  totalDeliveryRate: MetricStats;
  apiP50: MetricStats;
  apiP95: MetricStats;
  apiP99: MetricStats;
  deliveryP50: MetricStats;
  deliveryP95: MetricStats;
  deliveryP99: MetricStats;
  costEfficiency: MetricStats;
}

export function calculateStats(values: number[]): MetricStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let durationSeconds = 600; // 10 minutes default
  let runs = 3; // 3 runs default
  let providerLatencyMs: number | string | undefined = process.env.PROVIDER_LATENCY_MS || "150-250";
  let tiers = DEFAULT_BUDGET_TIERS;

  for (const arg of args) {
    if (arg.startsWith("--duration=")) {
      durationSeconds = parseInt(arg.split("=")[1]!, 10);
    } else if (arg.startsWith("--runs=") || arg.startsWith("--iterations=")) {
      runs = parseInt(arg.split("=")[1]!, 10);
    } else if (arg === "--quick") {
      durationSeconds = 5;
      runs = 1;
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
      tiers = DEFAULT_BUDGET_TIERS.filter(
        (t) =>
          requested.includes(t.budget.replace("/mo", "")) ||
          requested.includes(t.budget.replace("/mo", "").replace("$", "")),
      );
    }
  }

  return { durationSeconds, runs, providerLatencyMs, tiers };
}

function printTierBreakdown(stat: TierAggregatedStats, runsCount: number) {
  console.log("\n" + "=".repeat(170));
  console.log(
    ` 📊 TIER STATISTICAL BREAKDOWN: ${stat.tier.budget} [${stat.tier.description}] across ${runsCount} Runs (${stat.runs[0]?.durationSec ?? 600}s each)`,
  );
  console.log("=".repeat(170));

  const headers = [
    "Metric",
    ...stat.runs.map((_, i) => `Run ${i + 1}`),
    "Avg (Mean)",
    "Median",
    "Min",
    "Max",
    "StdDev",
  ];

  const colWidths = [32, ...stat.runs.map(() => 14), 14, 14, 14, 14, 12];

  const formatRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(colWidths[idx] ?? 14)).join(" | ");

  console.log(formatRow(headers));
  console.log("-".repeat(170));

  const rows: Array<{ label: string; values: number[]; s: MetricStats; unit: string }> = [
    {
      label: "Ingestion Throughput",
      values: stat.runs.map((r) => r.ingestionThroughput),
      s: stat.ingestionThroughput,
      unit: " req/s",
    },
    {
      label: "Active Delivery Rate",
      values: stat.runs.map((r) => r.activeDeliveryRate),
      s: stat.activeDeliveryRate,
      unit: " msg/s",
    },
    {
      label: "Wall Drain Rate",
      values: stat.runs.map((r) => r.totalDeliveryRate),
      s: stat.totalDeliveryRate,
      unit: " msg/s",
    },
    {
      label: "API Latency p50",
      values: stat.runs.map((r) => r.apiP50),
      s: stat.apiP50,
      unit: "ms",
    },
    {
      label: "API Latency p95",
      values: stat.runs.map((r) => r.apiP95),
      s: stat.apiP95,
      unit: "ms",
    },
    {
      label: "API Latency p99",
      values: stat.runs.map((r) => r.apiP99),
      s: stat.apiP99,
      unit: "ms",
    },
    {
      label: "Delivery Latency p50",
      values: stat.runs.map((r) => r.deliveryP50),
      s: stat.deliveryP50,
      unit: "ms",
    },
    {
      label: "Delivery Latency p95",
      values: stat.runs.map((r) => r.deliveryP95),
      s: stat.deliveryP95,
      unit: "ms",
    },
    {
      label: "Delivery Latency p99",
      values: stat.runs.map((r) => r.deliveryP99),
      s: stat.deliveryP99,
      unit: "ms",
    },
    {
      label: "Cost Efficiency",
      values: stat.runs.map((r) =>
        Number((r.activeDeliveryRate / stat.tier.monthlyCost).toFixed(2)),
      ),
      s: stat.costEfficiency,
      unit: " msg/s/$",
    },
  ];

  for (const row of rows) {
    const cols = [
      row.label,
      ...row.values.map((v) => `${v}${row.unit}`),
      `${row.s.mean}${row.unit}`,
      `${row.s.median}${row.unit}`,
      `${row.s.min}${row.unit}`,
      `${row.s.max}${row.unit}`,
      `${row.s.stdDev}`,
    ];
    console.log(formatRow(cols));
  }

  console.log("=".repeat(170) + "\n");
}

function printSummaryTable(allStats: TierAggregatedStats[], runsCount: number) {
  console.log("\n" + "=".repeat(215));
  console.log(
    `                                      💰 NOTIFKIT AWS BUDGET SCALING BENCHMARK SUMMARY (${runsCount} RUNS AGGREGATED) 💰`,
  );
  console.log("=".repeat(215));

  const headers = [
    "Budget Tier",
    "AWS Architecture & Topology",
    "Ingestion (Avg ± Std)",
    "Active Deliv (Avg / Med / Max)",
    "Wall Drain (Avg)",
    "API p95 (Avg / Med)",
    "Deliv p95 (Avg / Med)",
    "Cost Eff (Avg)",
  ];

  const colWidths = [13, 56, 26, 34, 18, 22, 24, 16];

  const formatRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(colWidths[idx]!)).join(" | ");

  console.log(formatRow(headers));
  console.log("-".repeat(215));

  for (const stat of allStats) {
    const row = [
      stat.tier.budget,
      stat.tier.description,
      `${stat.ingestionThroughput.mean} ± ${stat.ingestionThroughput.stdDev} r/s`,
      `${stat.activeDeliveryRate.mean} / ${stat.activeDeliveryRate.median} / ${stat.activeDeliveryRate.max} m/s`,
      `${stat.totalDeliveryRate.mean} msg/s`,
      `${stat.apiP95.mean}ms / ${stat.apiP95.median}ms`,
      `${stat.deliveryP95.mean}ms / ${stat.deliveryP95.median}ms`,
      `${stat.costEfficiency.mean} msg/s/$`,
    ];
    console.log(formatRow(row));
  }

  console.log("=".repeat(215));

  console.log("\n" + "-".repeat(215));
  console.log(
    "                                      📋 AWS MONTHLY INFRASTRUCTURE PRICING BREAKDOWN",
  );
  console.log("-".repeat(215));
  for (const stat of allStats) {
    console.log(
      `  • ${stat.tier.budget.padEnd(8)} [${stat.tier.awsTopology ?? stat.tier.description}]:`,
    );
    console.log(`    ${stat.tier.awsCostDetails ?? "On-demand AWS components"}`);
  }
  console.log("-".repeat(215) + "\n");
}

async function main() {
  const { durationSeconds, runs, providerLatencyMs, tiers } = parseArgs();

  console.log(
    "==========================================================================================",
  );
  console.log(
    "              💰 STARTING NOTIFKIT MONEY / BUDGET SCALING BENCHMARK                      ",
  );
  console.log(
    "==========================================================================================",
  );
  console.log(
    `Window: ${durationSeconds}s (${(durationSeconds / 60).toFixed(1)} mins) per run | Runs: ${runs} | Total Runs: ${tiers.length * runs}`,
  );
  console.log(`Tiers to test: ${tiers.map((t) => t.budget).join("  ➜  ")}`);
  if (providerLatencyMs && providerLatencyMs !== "0") {
    console.log(`Mock Provider Latency: ${providerLatencyMs}ms`);
  }
  console.log(
    "==========================================================================================\n",
  );

  const allStats: TierAggregatedStats[] = [];

  for (let tIdx = 0; tIdx < tiers.length; tIdx++) {
    const tier = tiers[tIdx]!;
    const tierRuns: DistributedBenchmarkResult[] = [];

    console.log(
      `\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`,
    );
    console.log(
      `[Tier ${tIdx + 1}/${tiers.length}] Budget Tier: ${tier.budget} — Running ${runs} iteration(s)`,
    );
    console.log(
      `Topology: ${tier.description} (${tier.servicesCount ?? 10} Microservices, ${tier.concurrency} In-Flight Workers)`,
    );
    console.log(
      `>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`,
    );

    for (let rIdx = 0; rIdx < runs; rIdx++) {
      console.log(
        `\n--- [Tier ${tier.budget}] Run ${rIdx + 1} of ${runs} (Duration: ${durationSeconds}s) ---`,
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
        serverNodes: tier.serverNodes,
        providerLatencyMs,
        durationSeconds,
        concurrency: tier.concurrency,
        servicesCount: tier.servicesCount,
      });

      tierRuns.push(res);

      if (rIdx < runs - 1) {
        console.log("⏳ Cooling down for 5s before next run...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    const tierStats: TierAggregatedStats = {
      tier,
      runs: tierRuns,
      ingestionThroughput: calculateStats(tierRuns.map((r) => r.ingestionThroughput)),
      activeDeliveryRate: calculateStats(tierRuns.map((r) => r.activeDeliveryRate)),
      totalDeliveryRate: calculateStats(tierRuns.map((r) => r.totalDeliveryRate)),
      apiP50: calculateStats(tierRuns.map((r) => r.apiP50)),
      apiP95: calculateStats(tierRuns.map((r) => r.apiP95)),
      apiP99: calculateStats(tierRuns.map((r) => r.apiP99)),
      deliveryP50: calculateStats(tierRuns.map((r) => r.deliveryP50)),
      deliveryP95: calculateStats(tierRuns.map((r) => r.deliveryP95)),
      deliveryP99: calculateStats(tierRuns.map((r) => r.deliveryP99)),
      costEfficiency: calculateStats(
        tierRuns.map((r) => Number((r.activeDeliveryRate / tier.monthlyCost).toFixed(2))),
      ),
    };

    allStats.push(tierStats);
    printTierBreakdown(tierStats, runs);

    if (tIdx < tiers.length - 1) {
      console.log("⏳ Cooling down for 6s before next tier...");
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  }

  printSummaryTable(allStats, runs);

  // Persist results to JSON
  try {
    const resultsDir = path.resolve(process.cwd(), "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    const outputPath = path.join(resultsDir, `money-scaling-${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(allStats, null, 2), "utf-8");
    console.log(`📁 Detailed statistical benchmark results saved to: ${outputPath}`);
  } catch (err) {
    console.warn("⚠️ Failed to persist results to JSON:", err);
  }
}

main().catch((err) => {
  console.error("Money scaling benchmark failed:", err);
  process.exit(1);
});

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
  awsTopology?: string;
  awsCostDetails?: string;
}

const DEFAULT_BUDGET_TIERS: BudgetTier[] = [
  {
    budget: "$20/mo",
    monthlyCost: 20,
    serverCount: 1,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "0.5",
    dbMemory: "512M",
    redisCpus: "0.5",
    redisMemory: "256M",
    workerConcurrency: 100,
    dbMaxConnections: 5,
    concurrency: 150,
    description: "1x Monolith on EC2 t4g.small",
    awsTopology: "1x EC2 t4g.small (Monolith)",
    awsCostDetails:
      "EC2 t4g.small (2 vCPU/2G: $12.26) + 30GB gp3 ($2.40) + IPv4/Net ($5.34) = ~$20.00/mo",
    serverServices: ["api,enricher,engine,delivery,scheduler"],
  },
  {
    budget: "$40/mo",
    monthlyCost: 40,
    serverCount: 2,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "0.5",
    redisMemory: "512M",
    workerConcurrency: 200,
    dbMaxConnections: 8,
    concurrency: 300,
    description: "1x API + 1x Worker (RDS db.t4g.micro + ElastiCache)",
    awsTopology: "1x EC2 t4g.small + RDS db.t4g.micro + ElastiCache t4g.micro",
    awsCostDetails:
      "EC2 t4g.small ($13.86) + RDS db.t4g.micro ($13.98) + ElastiCache Valkey ($9.34) + Net ($2.82) = ~$40.00/mo",
    serverServices: ["api", "enricher,engine,delivery,scheduler"],
  },
  {
    budget: "$60/mo",
    monthlyCost: 60,
    serverCount: 3,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "1.0",
    dbMemory: "1G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 300,
    dbMaxConnections: 10,
    concurrency: 300,
    description: "1x API + 1x Pipeline + 1x Delivery (Decoupled Compute)",
    awsTopology: "2x EC2 t4g.small + RDS db.t4g.micro + ElastiCache t4g.micro + ALB",
    awsCostDetails:
      "2x EC2 t4g.small ($27.72) + RDS db.t4g.micro ($13.98) + ElastiCache Valkey ($9.34) + ALB/Net ($8.96) = ~$60.00/mo",
    serverServices: ["api", "enricher,engine,scheduler", "delivery"],
  },
  {
    budget: "$80/mo",
    monthlyCost: 80,
    serverCount: 3,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "2.0",
    dbMemory: "2G",
    redisCpus: "1.0",
    redisMemory: "1G",
    workerConcurrency: 400,
    dbMaxConnections: 15,
    concurrency: 400,
    description: "1x API + 1x Pipeline + 1x Delivery (RDS db.t4g.small 2G)",
    awsTopology: "3x EC2 t4g.small + RDS db.t4g.small (2G) + ElastiCache t4g.micro",
    awsCostDetails:
      "3x EC2 t4g.small ($41.58) + RDS db.t4g.small ($27.70) + ElastiCache Valkey ($9.34) + Net ($1.38) = ~$80.00/mo",
    serverServices: ["api", "enricher,engine,scheduler", "delivery"],
  },
  {
    budget: "$100/mo",
    monthlyCost: 100,
    serverCount: 4,
    serverCpus: "1.0",
    serverMemory: "1G",
    dbCpus: "2.0",
    dbMemory: "2G",
    redisCpus: "1.5",
    redisMemory: "1.5G",
    workerConcurrency: 450,
    dbMaxConnections: 20,
    concurrency: 500,
    description: "1x API + 1x Pipeline + 2x Delivery (2x Scaled Workers)",
    awsTopology: "4x EC2 t4g.small + RDS db.t4g.small + ElastiCache cache.t4g.small",
    awsCostDetails:
      "4x EC2 t4g.small ($53.84) + RDS db.t4g.small ($28.27) + ElastiCache t4g.small ($18.69) = ~$100.80/mo",
    serverServices: ["api", "enricher,scheduler", "engine", "delivery"],
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
      tiers = DEFAULT_BUDGET_TIERS.filter(
        (t) =>
          requested.includes(t.budget.replace("/mo", "")) ||
          requested.includes(t.budget.replace("/mo", "").replace("$", "")),
      );
    }
  }

  return { durationSeconds, providerLatencyMs, tiers };
}

function printSummaryTable(results: Array<{ tier: BudgetTier; res: DistributedBenchmarkResult }>) {
  console.log("\n" + "=".repeat(170));
  console.log(
    "                                  💰 NOTIFKIT AWS BUDGET SCALING BENCHMARK SUMMARY 💰",
  );
  console.log("=".repeat(170));

  const headers = [
    "Budget Tier",
    "AWS Architecture & Topology",
    "Clients",
    "Ingestion",
    "Active Deliv",
    "Wall Drain",
    "API p95",
    "Deliv p95",
    "Cost Efficiency",
  ];

  const colWidths = [13, 62, 9, 14, 15, 14, 10, 11, 15];

  const formatRow = (cols: string[]) =>
    cols.map((col, idx) => col.padEnd(colWidths[idx]!)).join(" | ");

  console.log(formatRow(headers));
  console.log("-".repeat(170));

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

  console.log("=".repeat(170));

  console.log("\n" + "-".repeat(170));
  console.log("                                  📋 AWS MONTHLY INFRASTRUCTURE PRICING BREAKDOWN");
  console.log("-".repeat(170));
  for (const { tier } of results) {
    console.log(`  • ${tier.budget.padEnd(8)} [${tier.awsTopology ?? tier.description}]:`);
    console.log(`    ${tier.awsCostDetails ?? "On-demand AWS components"}`);
  }
  console.log("-".repeat(170) + "\n");
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
  console.log(
    `Window: ${durationSeconds}s per tier | Measuring: ${DEFAULT_BUDGET_TIERS.map((t) => t.budget).join(" ➜ ")} (AWS Actual Pricing)`,
  );
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

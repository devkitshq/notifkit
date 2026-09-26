import { DockerComposeEnvironment } from "testcontainers";
import { createDatabase, runMigrations } from "notifkit";
import { setGlobalDispatcher, Agent } from "undici";

// Configure high-concurrency connection pool for client benchmark
setGlobalDispatcher(
  new Agent({
    connections: 2000,
    pipelining: 1,
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 60000,
  }),
);

export interface DistributedLoadTestOptions {
  serverCount?: number;
  durationSeconds?: number;
  concurrency?: number;
  servicesCount?: number;
  adminApiKey?: string;
  dbPort?: number;
  serverCpus?: string;
  serverMemory?: string;
  workerConcurrency?: number;
  dbCpus?: string;
  dbMemory?: string;
  redisCpus?: string;
  redisMemory?: string;
  dbMaxConnections?: number;
  providerLatencyMs?: number | string;
  serverServices?: string[];
  serverNodes?: Array<{ name: string; port: number; services?: string }>;
  quiet?: boolean;
}

export interface DistributedBenchmarkResult {
  serverCount: number;
  serverCpus: string;
  serverMemory: string;
  workerConcurrency: number;
  durationSec: number;
  concurrency: number;
  servicesCount?: number;
  requestsSent: number;
  successCount: number;
  failCount: number;
  ingestionThroughput: number;
  firstDelivOffset: number;
  lastDelivOffset: number;
  deliverySpanSec: number;
  activeDeliveryRate: number;
  totalDeliveryRate: number;
  apiP50: number;
  apiP95: number;
  apiP99: number;
  deliveryP50: number;
  deliveryP95: number;
  deliveryP99: number;
  totalDelivered: number;
}

export async function runDistributedBenchmark(
  options: DistributedLoadTestOptions = {},
): Promise<DistributedBenchmarkResult> {
  const serverCount = options.serverCount ?? 2;
  const durationSec = options.durationSeconds ?? 10;
  const concurrency = options.concurrency ?? serverCount * 75;
  const adminApiKey = options.adminApiKey ?? "perf-admin-key";
  const dbPort = options.dbPort ?? 35432;
  const serverCpus = options.serverCpus ?? "1.0";
  const serverMemory = options.serverMemory ?? "1G";
  const workerConcurrency = options.workerConcurrency ?? 100;
  const providerLatency = options.providerLatencyMs ?? process.env.PROVIDER_LATENCY_MS ?? "200-300";

  const composeEnv: Record<string, string> = {
    SERVER_CPUS: serverCpus,
    SERVER_MEMORY: serverMemory,
    WORKER_CONCURRENCY: String(workerConcurrency),
    PROVIDER_LATENCY_MS: String(providerLatency),
  };
  if (options.dbCpus) composeEnv.DB_CPUS = options.dbCpus;
  if (options.dbMemory) composeEnv.DB_MEMORY = options.dbMemory;
  if (options.redisCpus) composeEnv.REDIS_CPUS = options.redisCpus;
  if (options.redisMemory) composeEnv.REDIS_MEMORY = options.redisMemory;
  if (options.dbMaxConnections) composeEnv.DB_MAX_CONNECTIONS = String(options.dbMaxConnections);

  if (options.serverServices) {
    options.serverServices.forEach((svc, idx) => {
      composeEnv[`SERVER${idx + 1}_SERVICES`] = svc;
    });
  }

  // If explicit serverNodes are provided, use their service names and custom env vars
  const nodes =
    options.serverNodes && options.serverNodes.length > 0
      ? options.serverNodes
      : Array.from({ length: serverCount }, (_, i) => ({
          name: `server${i + 1}`,
          port: 35678 + i,
          services: options.serverServices?.[i],
        }));

  for (const node of nodes) {
    if (node.services) {
      const envKey = `${node.name.toUpperCase().replace(/-/g, "_")}_SERVICES`;
      composeEnv[envKey] = node.services;
    }
  }

  const effectiveServerCount = nodes.length;

  const services = ["db", "redis", ...nodes.map((n) => n.name)];

  console.log(
    `🚀 Booting distributed profiling environment (${effectiveServerCount} Server Instances: [${nodes.map((n) => n.name).join(", ")}] | ${serverCpus} vCPU each, ${serverMemory} RAM | DB: ${composeEnv.DB_CPUS ?? "2.0"} vCPU | Redis: ${composeEnv.REDIS_CPUS ?? "1.5"} vCPU | Provider Latency: ${providerLatency}ms)...`,
  );

  const environment = await new DockerComposeEnvironment(".", "docker-compose.distributed.yml")
    .withEnvironment(composeEnv)
    .withBuild()
    .up(services);

  const serverUrls = nodes.map((n) => `http://localhost:${n.port}`);
  const dbUrl = `postgres://notifkit:password@localhost:${dbPort}/notifkit`;

  const apiLatencies: number[] = [];
  const deliveryLatencies: number[] = [];

  console.log(`⏳ Waiting for ${effectiveServerCount} server instances health checks...`);
  const apiUrls: string[] = [];
  for (const url of serverUrls) {
    let ready = false;
    while (!ready) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) {
          ready = true;
          const body = (await res.json().catch(() => ({}))) as { isWorkerOnly?: boolean };
          if (!body.isWorkerOnly) {
            apiUrls.push(url);
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  const targetApiUrls = apiUrls.length > 0 ? apiUrls : [serverUrls[0]!];

  let firstDeliveryTimestamp: number | null = null;
  let lastDeliveryTimestamp: number | null = null;

  // Hook into container logs of all active servers
  for (const node of nodes) {
    const serverContainer = environment.getContainer(`${node.name}-1`);
    const stream = await serverContainer.logs();
    let logBuffer = "";
    stream.on("data", (chunk) => {
      logBuffer += chunk.toString();
      const lines = logBuffer.split("\n");
      logBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.includes("push delivered (console transport)")) {
          const now = Date.now();
          if (firstDeliveryTimestamp === null) {
            firstDeliveryTimestamp = now;
          }
          lastDeliveryTimestamp = now;

          try {
            const parsed = JSON.parse(line);
            deliveryLatencies.push(typeof parsed.latency === "number" ? parsed.latency : 0);
          } catch {
            deliveryLatencies.push(0);
          }
        }
      }
    });
  }

  console.log("🛠️ Running database migrations...");
  const dbData = createDatabase({ url: dbUrl });
  await runMigrations(dbData.db);

  console.log("🏗️ Provisioning benchmark project and templates...");
  const projectRes = await fetch(`${targetApiUrls[0]}/v1/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Profiling Project" }),
  });
  const project = await projectRes.json();
  const projectApiKey = project.apiKey;

  await dbData.sql`UPDATE projects SET rate_limit_rpm = 10000000`;

  await fetch(`${targetApiUrls[0]}/v1/templates`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${projectApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      templates: [
        {
          id: "perf-email",
          channel: "email",
          topic: ["transactional"],
          content: {
            subject: "Perf Test Email",
            html: "<p>Hello {{name}}</p>",
          },
        },
      ],
    }),
  });

  await fetch(`${targetApiUrls[0]}/v1/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${projectApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: "perf-user-1",
      email: ["perf@example.com"],
    }),
  });

  const MICROSERVICES = [
    { name: "order-service", priority: "critical", event: "order_confirmation" },
    { name: "payments-service", priority: "critical", event: "payment_receipt" },
    { name: "billing-service", priority: "normal", event: "invoice_ready" },
    { name: "auth-service", priority: "critical", event: "password_reset" },
    { name: "shipping-service", priority: "normal", event: "tracking_update" },
    { name: "account-service", priority: "normal", event: "security_alert" },
    { name: "inventory-service", priority: "low", event: "stock_replenished" },
    { name: "fraud-service", priority: "critical", event: "suspicious_login" },
    { name: "marketing-service", priority: "low", event: "promotional_blast" },
    { name: "support-service", priority: "normal", event: "ticket_reply" },
  ];

  const activeServicesCount = options.servicesCount ?? (concurrency <= 10 ? concurrency : 10);
  const activeServices = MICROSERVICES.slice(
    0,
    Math.min(activeServicesCount, MICROSERVICES.length),
  );
  const workersPerService = Math.max(1, Math.round(concurrency / activeServices.length));

  console.log(
    `\n🔥 Starting Distributed Load Generation: ${activeServices.length} microservices blasting concurrently (${concurrency} parallel workers, ~${workersPerService} workers/service) across ${targetApiUrls.length} API ingress node(s) for ${durationSec}s`,
  );

  let requestsSent = 0;
  let successCount = 0;
  let failCount = 0;

  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;

  const progressInterval = setInterval(() => {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const remainingSec = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    const curReqRate = (requestsSent / Math.max(1, Number(elapsedSec))).toFixed(1);
    const curDeliv = deliveryLatencies.length;
    console.log(
      `⚡ Blasting: ${elapsedSec}s elapsed (${remainingSec}s remaining) | Sent: ${requestsSent} (${curReqRate} req/s) | Delivered so far: ${curDeliv} msgs`,
    );
  }, 10000);

  async function worker(workerIndex: number) {
    const targetUrl = targetApiUrls[workerIndex % targetApiUrls.length]!;
    const svc = activeServices[workerIndex % activeServices.length]!;
    while (Date.now() < endTime) {
      requestsSent++;
      try {
        const reqStart = Date.now();
        const res = await fetch(`${targetUrl}/v1/notify`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${projectApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user: "perf-user-1",
            template: "perf-email",
            channels: ["email"],
            priority: svc.priority,
            data: {
              name: "Load Tester",
              service: svc.name,
              event: svc.event,
              requestTime: reqStart,
            },
          }),
        });

        apiLatencies.push(Date.now() - reqStart);

        if (res.status === 202) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }).map((_, i) => worker(i));
  await Promise.all(workers);
  clearInterval(progressInterval);

  const activeWindowSec = durationSec;
  const ingestionThroughput = (requestsSent / activeWindowSec).toFixed(2);

  console.log(
    `\n⏳ Load generation finished (${requestsSent} sent in ${activeWindowSec}s window, ${successCount} accepted). Awaiting queue flush...`,
  );

  const flushStart = Date.now();
  let lastLogged = 0;
  const flushTimeoutMs = Math.max(1800000, durationSec * 3000);

  while (deliveryLatencies.length < successCount) {
    if (Date.now() - flushStart > flushTimeoutMs) {
      console.log(
        `⚠️ Flush timeout! Delivered ${deliveryLatencies.length}/${successCount} messages.`,
      );
      break;
    }
    if (Date.now() - lastLogged > 2000) {
      lastLogged = Date.now();
      const pct = ((deliveryLatencies.length / successCount) * 100).toFixed(1);
      const rate = (deliveryLatencies.length / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(
        `⏳ Flushing: [${deliveryLatencies.length} / ${successCount}] (${pct}%) ~ ${rate} delivered/sec`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const totalElapsed = (Date.now() - startTime) / 1000;
  const firstDelivOffset = firstDeliveryTimestamp ? (firstDeliveryTimestamp - startTime) / 1000 : 0;
  const lastDelivOffset = lastDeliveryTimestamp
    ? (lastDeliveryTimestamp - startTime) / 1000
    : totalElapsed;
  const deliverySpanSec =
    firstDeliveryTimestamp &&
    lastDeliveryTimestamp &&
    lastDeliveryTimestamp > firstDeliveryTimestamp
      ? (lastDeliveryTimestamp - firstDeliveryTimestamp) / 1000
      : totalElapsed;

  const activeDeliveryRate = (deliveryLatencies.length / deliverySpanSec).toFixed(2);
  const totalDeliveryRate = (deliveryLatencies.length / totalElapsed).toFixed(2);

  function percentile(arr: number[], p: number) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[idx];
  }

  console.log("\n=================================");
  console.log("     📊 LOAD TEST RESULTS 📊     ");
  console.log("=================================");
  console.log(`Topology:             ${serverCount} Distributed Servers`);
  console.log(`Generation Window:    ${activeWindowSec}s (${concurrency} microservice callers)`);
  console.log(`Total Ingestion:      ${requestsSent} requests (${ingestionThroughput} req/sec)`);
  console.log(
    `Accepted (202):       ${successCount} (${((successCount / requestsSent) * 100).toFixed(1)}%)`,
  );
  console.log(`Failed / Dropped:     ${failCount}`);
  console.log("---------------------------------");
  console.log(`First Msg Delivered:  +${firstDelivOffset.toFixed(2)}s from test start`);
  console.log(`Last Msg Delivered:   +${lastDelivOffset.toFixed(2)}s from test start`);
  console.log(`Delivery Span (1->N): ${deliverySpanSec.toFixed(2)}s`);
  console.log(`Active Delivery Rate: ${activeDeliveryRate} msgs/sec`);
  console.log(
    `Total Wall Drain Rate:${totalDeliveryRate} msgs/sec (${totalElapsed.toFixed(2)}s total)`,
  );
  console.log("---------------------------------");
  const apiP50 = percentile(apiLatencies, 50);
  const apiP95 = percentile(apiLatencies, 95);
  const apiP99 = percentile(apiLatencies, 99);
  const deliveryP50 = percentile(deliveryLatencies, 50);
  const deliveryP95 = percentile(deliveryLatencies, 95);
  const deliveryP99 = percentile(deliveryLatencies, 99);

  console.log(`API Latency:          p50: ${apiP50}ms | p95: ${apiP95}ms | p99: ${apiP99}ms`);
  console.log(
    `Delivery Latency:     p50: ${deliveryP50}ms | p95: ${deliveryP95}ms | p99: ${deliveryP99}ms`,
  );
  console.log(`Total Delivered:      ${deliveryLatencies.length} / ${successCount}`);
  console.log("=================================\n");

  console.log("🧹 Tearing down test environment...");
  await dbData.sql.end();
  await environment.down();
  console.log("✅ Benchmark completed successfully.");

  return {
    serverCount,
    serverCpus,
    serverMemory,
    workerConcurrency,
    durationSec: activeWindowSec,
    concurrency,
    servicesCount: activeServices.length,
    requestsSent,
    successCount,
    failCount,
    ingestionThroughput: Number(ingestionThroughput),
    firstDelivOffset: Number(firstDelivOffset.toFixed(2)),
    lastDelivOffset: Number(lastDelivOffset.toFixed(2)),
    deliverySpanSec: Number(deliverySpanSec.toFixed(2)),
    activeDeliveryRate: Number(activeDeliveryRate),
    totalDeliveryRate: Number(totalDeliveryRate),
    apiP50,
    apiP95,
    apiP99,
    deliveryP50,
    deliveryP95,
    deliveryP99,
    totalDelivered: deliveryLatencies.length,
  };
}

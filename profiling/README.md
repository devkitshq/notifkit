# Notifkit Profiling & Benchmarking Suite

This folder provides a realistic, container-isolated profiling and benchmarking environment for Notifkit.

---

## 🏗️ Architecture & Resource Constraints

The environment simulates a standard small production node (e.g. $15/mo cloud VM):

- **Server**: 1.0 vCPU, 1 GB RAM (`notifkit` standalone orchestrator)
- **PostgreSQL 15**: 0.5 vCPU, 512 MB RAM
- **Redis 7**: 0.5 vCPU, 256 MB RAM

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd profiling
npm install
```

### 2. Run the Load Test

```bash
npm run test:load
```

The load test will:

1. Boot the isolated 3-container stack (`postgres`, `redis`, `server`) via `testcontainers`.
2. Run database schema migrations and seed project/template data.
3. Fire 50 concurrent virtual users generating notifications against `/v1/notify`.
4. Stream and buffer container logs until 100% of messages are delivered to the transport.
5. Output detailed throughput, p95, and p99 percentiles for both API ingestion and background delivery.
6. Automatically clean up and shut down the containers.

---

### 3. Run the CPU Scaling Benchmark

Evaluate server performance scaling from 0.5 vCPU up to 4.0 vCPUs:

```bash
npm run test:scaling
```

#### CLI Flags & Customization:

```bash
# Rapid test (5s duration per tier)
npm run test:scaling -- --quick

# Specify custom CPU tiers
npm run test:scaling -- --cpus=0.5,1.0,2.0,4.0

# Customize duration and concurrency
npm run test:scaling -- --duration=15 --concurrency=100
```

The scaling benchmark produces an aggregated comparative table with:

- Ingestion Throughput (`req/sec`)
- Active Delivery Throughput (`msgs/sec`)
- Wall Drain Throughput (`msgs/sec`)
- API & Delivery Latencies (`p50`, `p95`, `p99`)
- Speedup vs Baseline & Diminishing Returns Analysis

---

## ➕ Adding New Profiling Tests

To add a new benchmark (e.g. batch delivery, quiet hours queuing, multi-channel fallback):

1. Create a new test file under `tests/` (e.g. `tests/batch.test.ts`).
2. Add a corresponding script to `package.json`:
   ```json
   "test:batch": "tsx tests/batch.test.ts"
   ```
3. Run `npm run test:batch`.

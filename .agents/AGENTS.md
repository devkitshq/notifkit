# Agent Workspace Rules & Developer Guide

Welcome agent! This workspace guidelines file contains the rules for modifying, compiling, and testing the `notifkit` notification engine codebase.

---

## 🏗️ Architecture & Component Map

Notifkit is an event-driven notification dispatch pipeline. Here is where the key components reside:

- **Client SDK (`src/client.ts`)**: The typed `NotifkitClient` exported to other backend microservices.
- **Orchestrator Server (`src/server.ts`)**: The main `NotifkitServer` class used to bootstrap the system.
- **REST API Service (`src/services/api/`)**: Express-like router handling HTTP endpoints (`/v1/notify`, `/health`, etc.).
- **Enricher Worker (`src/services/enricher/`)**: Binds contact data, formats templates, and filters user opt-outs.
- **Decision Engine Worker (`src/services/engine/`)**: Enforces timezone-aware quiet hours deferrals and priority-aware throttling.
- **Scheduler Service (`src/services/scheduler/`)**: Redis Sorted Set polling loop that manages scheduled and deferred deliveries.
- **Delivery Worker (`src/services/delivery/`)**: Controls rate-limiting (sliding window) and dispatches calls to provider transports.

---

## 🛠️ CLI Development Commands

To build and verify the workspace, run these commands in order:

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Build TypeScript bundles**:
   ```bash
   npm run build
   ```
3. **Execute Type check compilation**:
   ```bash
   npm run typecheck
   ```
4. **Run the Vitest integration suite**:
   ```bash
   npm run test -- --run
   ```
5. **Start PostgreSQL & Redis (Docker Compose)**:
   ```bash
   docker compose up -d
   ```
6. **Spin up a local server process**:
   ```bash
   node test-server.js
   ```

---

## 🔑 Implementation Patterns & Rules

- **Auto-migrations**: Auto-migrations run on startup by default. Ensure database schema changes in `src/db/schema.ts` have matching migration files generated via Drizzle.
- **Type Safety**: Maintain zero compilation errors (`tsc --noEmit`).
- **Quiet Hours**: Non-critical messages sent inside recipient quiet hours must be scheduled for the quiet hours end boundary.
- **Test Integrity**: Ensure all modifications are fully covered by unit tests in `tests/workers.test.ts`.

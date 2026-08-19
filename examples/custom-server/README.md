# Custom Server Example

This example demonstrates how to bootstrap the `NotifkitServer` orchestrator with custom notification provider transports, custom concurrency options, and graceful process shutdown handlers.

## Prerequisites

- Node.js >= 22
- Running PostgreSQL and Redis instances (or environment variables `DATABASE_URL` and `REDIS_URL`)

## How to Run

```bash
# Set environment variables (optional if running locally with defaults)
export DATABASE_URL="postgresql://platform:platform@localhost:5432/notifkit"
export REDIS_URL="redis://localhost:6379"

# Run the server example
node index.js
```

# High-Throughput Load Test Example

This example measures request throughput and latency for the Notifkit REST API ingestion pipeline.

## How to Run

```bash
export NOTIFKIT_API_URL="http://localhost:4000"
export ADMIN_API_KEY="your_admin_api_key"
export COUNT=1000
export CONCURRENCY=100

node index.js
```

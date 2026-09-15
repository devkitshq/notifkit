# Notifkit Admin & Observability Dashboard

This is the single-page application (SPA) admin console and real-time delivery observability dashboard for **Notifkit**, built with **Vite**, **React 19**, **React Router**, **Tailwind CSS v4**, and **shadcn/ui**.

## Development

```bash
# Start Vite development server
npm run dev

# Build production bundle to dist/
npm run build

# Preview built production bundle
npm run preview
```

## Features

- **Live Activity Feed**: Real-time SSE streaming of delivery statuses and handoffs.
- **Historical Audit Logs**: Queryable, paginated notification lifecycle trails and payload inspector.
- **System Health**: PostgreSQL and Redis latencies and worker heartbeat monitoring.
- **Analytics & Queues**: Real-time Redis Streams queue depth gauges and delivery SLA metrics.
- **Dead Letter Queue (DLQ)**: Poison message diagnostics with stream replay and purge capabilities.
- **Scheduled Pipeline**: Future dispatch scheduling and quiet hours deferrals.
- **Workflows**: Multi-step notification sequence diagrams and instance step execution tracing.
- **Templates**: Channel bindings, dynamic variables, and prompt previewing.
- **User Directory**: Contact channels and opt-out preferences.
- **Projects & API Keys**: Tenant workspace configuration and scoped token provisioning.

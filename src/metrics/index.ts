import promClient from "prom-client";

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

export const metrics = {
  messagesPublished: new promClient.Counter({
    name: "notifkit_messages_published_total",
    help: "Total messages published to inbound streams",
    labelNames: ["channel", "priority"],
    registers: [register],
  }),
  messagesProcessed: new promClient.Counter({
    name: "notifkit_messages_processed_total",
    help: "Total messages processed by workers",
    labelNames: ["worker", "status"],
    registers: [register],
  }),
  deliverySuccess: new promClient.Counter({
    name: "notifkit_delivery_success_total",
    help: "Total successful deliveries",
    labelNames: ["channel"],
    registers: [register],
  }),
  deliveryFailed: new promClient.Counter({
    name: "notifkit_delivery_failed_total",
    help: "Total failed deliveries",
    labelNames: ["channel", "reason"],
    registers: [register],
  }),
  workerActiveTasks: new promClient.Gauge({
    name: "notifkit_worker_active_tasks",
    help: "Number of currently active tasks per worker",
    labelNames: ["worker"],
    registers: [register],
  }),
  queueSize: new promClient.Gauge({
    name: "notifkit_queue_size",
    help: "Current size of streams",
    labelNames: ["stream"],
    registers: [register],
  }),
  pendingAcks: new promClient.Gauge({
    name: "notifkit_pending_acks",
    help: "Number of pending un-acked messages per group",
    labelNames: ["group"],
    registers: [register],
  }),
};

export function getMetricsRegistry() {
  return register;
}

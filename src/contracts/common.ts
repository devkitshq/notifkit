import { z } from "zod";

export const NotificationChannelSchema = z.enum([
  "email",
  "sms",
  "push",
  "webhook",
  "in-app",
  "telegram",
  "discord",
]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

export const NotificationStatusSchema = z.enum([
  "pending",
  "queued",
  "processing",
  "delivered",
  "failed",
  "bounced",
  "suppressed",
]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

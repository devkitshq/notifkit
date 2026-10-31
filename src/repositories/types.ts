import type { Preferences, ContactChannel } from "@/contracts/index.js";

export interface UserProfile {
  userId: string; // Maps to externalId
  language?: string;
  timezone?: string;
  email?: string | null;
}

export interface UserRecord extends UserProfile {
  segments: string[];
  preferences: Preferences;
}

export interface UserContact {
  id: string; // uuid
  userId: string; // externalId
  channel: ContactChannel;
  target: string;
  preferences: Preferences;
  active: boolean;
}

export interface TemplateRecord {
  id: string;
  channel: string;
  topics: string[];
  content: unknown;
  /** Template-level AI prompts, merged with per-request ones by the engine. */
  aiPrompts?: Record<string, string> | null;
}

/** @deprecated Unused; removed in the next minor version. */
export type DevicePlatform = "fcm" | "apns" | "web";

/** @deprecated Unused; removed in the next minor version. */
export interface DeviceToken {
  id: string;
  userId: string;
  deviceToken: string;
  platform: DevicePlatform;
  active: boolean;
}

export interface NotificationPreference {
  userId: string;
  eventType: string;
  optedIn: boolean;
}

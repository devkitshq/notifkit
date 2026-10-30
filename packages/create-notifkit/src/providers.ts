/**
 * The providers `create-notifkit` can scaffold, and the versions it pins.
 *
 * Versions are baked in rather than resolved at run time so the CLI needs no
 * network round trip before writing files. tests/create-notifkit.test.ts fails
 * when one falls behind its workspace package.json.
 */

export const NOTIFKIT_VERSION = "0.1.14";

export type ProviderId = "console" | "resend" | "twilio" | "fcm";

export interface EnvVar {
  name: string;
  /** One-line comment written above the variable in .env. */
  comment: string;
}

export interface ProviderSpec {
  id: ProviderId;
  /** Shown in the provider prompt. */
  label: string;
  packageName: string;
  version: string;
  className: string;
  channel: "push" | "email" | "sms";
  /** Constructor argument, as source, indented for server.ts. */
  options: string;
  /** Credentials and settings the transport reads. */
  env: EnvVar[];
  /**
   * Where send.ts delivers to: an env var the user fills in, or a fixed
   * target when the provider ignores it.
   */
  target: { env: string; comment: string } | { value: string };
  /** Template content for the welcome notification, as source. */
  content: string;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  console: {
    id: "console",
    label: "Console (prints to the terminal, no account needed)",
    packageName: "@notifkit/provider-console",
    version: "0.1.2",
    className: "ConsoleTransport",
    channel: "push",
    options: "",
    env: [],
    target: { value: "dev-device-token" },
    content: `{ title: "Welcome, {{name}}!", body: "Your notifkit app is working." }`,
  },
  resend: {
    id: "resend",
    label: "Resend (email)",
    packageName: "@notifkit/provider-resend",
    version: "0.1.5",
    className: "ResendTransport",
    channel: "email",
    options: `{
      apiKey: process.env.RESEND_API_KEY!,
      from: process.env.RESEND_FROM!,
    }`,
    env: [
      { name: "RESEND_API_KEY", comment: "From https://resend.com/api-keys" },
      { name: "RESEND_FROM", comment: "Sender address on a domain verified in Resend" },
    ],
    target: { env: "TO_EMAIL", comment: "Where `send` delivers the test email" },
    content: `{ subject: "Welcome, {{name}}!", text: "Your notifkit app is working." }`,
  },
  twilio: {
    id: "twilio",
    label: "Twilio (SMS)",
    packageName: "@notifkit/provider-twilio",
    version: "0.1.2",
    className: "TwilioTransport",
    channel: "sms",
    options: `{
      accountSid: process.env.TWILIO_ACCOUNT_SID!,
      authToken: process.env.TWILIO_AUTH_TOKEN!,
      from: process.env.TWILIO_FROM!,
    }`,
    env: [
      { name: "TWILIO_ACCOUNT_SID", comment: "From https://console.twilio.com" },
      { name: "TWILIO_AUTH_TOKEN", comment: "From https://console.twilio.com" },
      { name: "TWILIO_FROM", comment: "Your Twilio number in E.164 form, e.g. +15550000001" },
    ],
    target: { env: "TO_PHONE", comment: "Where `send` delivers the test SMS, in E.164 form" },
    content: `{ text: "Welcome, {{name}}! Your notifkit app is working." }`,
  },
  fcm: {
    id: "fcm",
    label: "Firebase Cloud Messaging (push)",
    packageName: "@notifkit/provider-fcm",
    version: "0.1.3",
    className: "FcmTransport",
    channel: "push",
    options: `{
      serviceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON!,
    }`,
    env: [
      {
        name: "FCM_SERVICE_ACCOUNT_JSON",
        comment: "Firebase service account key, as one line of JSON",
      },
    ],
    target: { env: "TO_PUSH_TOKEN", comment: "FCM registration token of a test device" },
    content: `{ title: "Welcome, {{name}}!", body: "Your notifkit app is working." }`,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

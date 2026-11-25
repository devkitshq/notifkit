/**
 * The providers `create-notifkit` can scaffold, and the versions it pins.
 *
 * Versions are baked in rather than resolved at run time so the CLI needs no
 * network round trip before writing files. tests/create-notifkit.test.ts fails
 * when one falls behind its workspace package.json.
 */

export const NOTIFKIT_VERSION = "0.1.15";

export type ProviderId =
  | "console"
  | "resend"
  | "smtp"
  | "ses"
  | "twilio"
  | "vonage"
  | "fcm"
  | "slack"
  | "discord"
  | "telegram"
  | "whatsapp";

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
  channel: "push" | "email" | "sms" | "slack" | "discord" | "telegram" | "whatsapp";
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
  smtp: {
    id: "smtp",
    label: "SMTP (email, any server)",
    packageName: "@notifkit/provider-smtp",
    version: "0.1.0",
    className: "SmtpTransport",
    channel: "email",
    options: `{
      smtp: process.env.SMTP_URL!,
      from: process.env.SMTP_FROM!,
    }`,
    env: [
      {
        name: "SMTP_URL",
        comment: "Your server as a URL, e.g. smtps://user:pass@smtp.example.com",
      },
      { name: "SMTP_FROM", comment: "Sender address your server may send as" },
    ],
    target: { env: "TO_EMAIL", comment: "Where `send` delivers the test email" },
    content: `{ subject: "Welcome, {{name}}!", text: "Your notifkit app is working." }`,
  },
  ses: {
    id: "ses",
    label: "Amazon SES (email)",
    packageName: "@notifkit/provider-ses",
    version: "0.1.1",
    className: "SesTransport",
    channel: "email",
    // The AWS SDK reads AWS_REGION and the access key from the environment itself.
    options: `{
      from: process.env.SES_FROM!,
      limits: { limit: Number(process.env.SES_MAX_SEND_RATE || 1), windowSeconds: 1 },
      snsTopicArns: process.env.SES_SNS_TOPIC_ARN ? [process.env.SES_SNS_TOPIC_ARN] : [],
    }`,
    env: [
      { name: "AWS_REGION", comment: "Region of your SES account, e.g. eu-west-1" },
      {
        name: "AWS_ACCESS_KEY_ID",
        comment: "Access key allowed ses:SendEmail. Leave both blank to use your AWS profile",
      },
      { name: "AWS_SECRET_ACCESS_KEY", comment: "Secret of that access key" },
      { name: "SES_FROM", comment: "Sender address on an identity verified in SES" },
      {
        name: "SES_MAX_SEND_RATE",
        comment:
          "Your account's maximum send rate per second, from the SES console (1 in the sandbox)",
      },
      {
        name: "SES_SNS_TOPIC_ARN",
        comment:
          "Optional: SNS topic for bounces and complaints, see the @notifkit/provider-ses README",
      },
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
  vonage: {
    id: "vonage",
    label: "Vonage (SMS)",
    packageName: "@notifkit/provider-vonage",
    version: "0.1.0",
    className: "VonageTransport",
    channel: "sms",
    options: `{
      apiKey: process.env.VONAGE_API_KEY!,
      apiSecret: process.env.VONAGE_API_SECRET!,
      from: process.env.VONAGE_FROM!,
    }`,
    env: [
      { name: "VONAGE_API_KEY", comment: "From https://dashboard.nexmo.com" },
      { name: "VONAGE_API_SECRET", comment: "From https://dashboard.nexmo.com" },
      {
        name: "VONAGE_FROM",
        comment: "Your Vonage number in E.164 form, e.g. +447700900001, or a sender ID",
      },
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
  slack: {
    id: "slack",
    label: "Slack (incoming webhook)",
    packageName: "@notifkit/provider-slack",
    version: "0.1.3",
    className: "SlackTransport",
    channel: "slack",
    // An incoming-webhook URL as the contact target needs no bot token.
    options: "",
    env: [],
    target: {
      env: "TO_SLACK_WEBHOOK_URL",
      comment: "Incoming webhook URL, from https://api.slack.com/apps > Incoming Webhooks",
    },
    content: `{ subject: "Welcome, {{name}}!", text: "Your notifkit app is working." }`,
  },
  discord: {
    id: "discord",
    label: "Discord (webhook)",
    packageName: "@notifkit/provider-discord",
    version: "0.1.4",
    className: "DiscordTransport",
    channel: "discord",
    options: "",
    env: [],
    target: {
      env: "TO_DISCORD_WEBHOOK_URL",
      comment: "Webhook URL, from Server Settings > Integrations > Webhooks",
    },
    content: `{ subject: "Welcome, {{name}}!", text: "Your notifkit app is working." }`,
  },
  telegram: {
    id: "telegram",
    label: "Telegram (bot)",
    packageName: "@notifkit/provider-telegram",
    version: "0.1.3",
    className: "TelegramTransport",
    channel: "telegram",
    options: `{
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
    }`,
    env: [{ name: "TELEGRAM_BOT_TOKEN", comment: "From @BotFather on Telegram" }],
    target: {
      env: "TO_TELEGRAM_CHAT_ID",
      comment: "Chat id of a chat that has messaged your bot",
    },
    content: `{ text: "Welcome, {{name}}! Your notifkit app is working." }`,
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp (Meta Cloud API)",
    packageName: "@notifkit/provider-whatsapp",
    version: "0.1.3",
    className: "WhatsAppTransport",
    channel: "whatsapp",
    options: `{
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    }`,
    env: [
      {
        name: "WHATSAPP_PHONE_NUMBER_ID",
        comment: "From Meta's App Dashboard > WhatsApp > API Setup",
      },
      {
        name: "WHATSAPP_ACCESS_TOKEN",
        comment: "From Meta's App Dashboard > WhatsApp > API Setup",
      },
    ],
    target: {
      env: "TO_PHONE",
      comment:
        "Where `send` delivers the test message, in E.164 form. It must have messaged your number in the last 24h",
    },
    content: `{ text: "Welcome, {{name}}! Your notifkit app is working." }`,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

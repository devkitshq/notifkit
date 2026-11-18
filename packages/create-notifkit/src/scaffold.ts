import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOTIFKIT_VERSION,
  PROVIDERS,
  type EnvVar,
  type ProviderId,
  type ProviderSpec,
} from "./providers.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface RenderOptions {
  name: string;
  /** In the order picked; on a shared channel, that is the fallback order. */
  providers: ProviderId[];
  adminKey: string;
  packageManager?: PackageManager;
}

/** `npm run dev`, `pnpm dev`, … */
export function runScript(pm: PackageManager, script: string): string {
  if (pm === "npm" || pm === "bun") return `${pm} run ${script}`;
  return `${pm} ${script}`;
}

/** Returns why `name` is not a valid npm package name, or undefined if it is. */
export function validateName(name: string): string | undefined {
  if (!name) return "the name cannot be empty";
  if (name.length > 214) return "the name must be 214 characters or fewer";
  if (name !== name.toLowerCase()) return `"${name}" must be lowercase`;
  if (/^[._]/.test(name)) return `"${name}" cannot start with "." or "_"`;
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
    return `"${name}" may only contain lowercase letters, digits, "-", ".", "_" and "~"`;
  }
  return undefined;
}

export function generateAdminKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Every file of a new app, keyed by path relative to the app directory. */
export function renderProject(opts: RenderOptions): Record<string, string> {
  const specs = [...new Set(opts.providers)].map((id) => PROVIDERS[id]);
  const pm = opts.packageManager ?? "npm";
  return {
    "package.json": packageJson(opts.name, specs),
    "tsconfig.json": TSCONFIG,
    ".gitignore": "node_modules\ndist\n.env\n",
    ".env": envFile(specs, opts.adminKey),
    ".env.example": envFile(specs, ""),
    "server.ts": serverTs(specs),
    "setup.ts": setupTs(opts.name, pm),
    "send.ts": sendTs(specs, pm),
    "README.md": readme(opts.name, specs, pm),
  };
}

/** The first provider picked for each channel; the test notification goes through it. */
function perChannel(specs: ProviderSpec[]): ProviderSpec[] {
  const seen = new Set<string>();
  return specs.filter((s) => !seen.has(s.channel) && seen.add(s.channel));
}

/** Env vars the user fills in, each once: resend and smtp share TO_EMAIL. */
function envVars(specs: ProviderSpec[]): EnvVar[] {
  const vars = specs.flatMap((s) =>
    "env" in s.target ? [...s.env, { name: s.target.env, comment: s.target.comment }] : s.env,
  );
  const seen = new Set<string>();
  return vars.filter((v) => !seen.has(v.name) && seen.add(v.name));
}

/**
 * Writes `files` under `dir`, creating it if needed. Refuses a non-empty
 * directory unless `force` is set, so a typo never clobbers an existing app.
 */
export function writeProject(
  dir: string,
  files: Record<string, string>,
  { force = false }: { force?: boolean } = {},
): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    if (!force && readdirSync(dir).length > 0) {
      throw new Error(`${dir} is not empty. Pick another name or pass --force to write into it.`);
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function packageJson(name: string, specs: ProviderSpec[]): string {
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "tsx --env-file=.env server.ts",
      setup: "tsx --env-file=.env setup.ts",
      send: "tsx --env-file=.env send.ts",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      notifkit: `^${NOTIFKIT_VERSION}`,
      ...Object.fromEntries(specs.map((s) => [s.packageName, `^${s.version}`])),
    },
    devDependencies: {
      "@testcontainers/postgresql": "^12.0.4",
      "@testcontainers/redis": "^12.0.4",
      "@types/node": "^22.0.0",
      tsx: "^4.23.1",
      typescript: "^5.8.3",
    },
    engines: { node: ">=22.0.0" },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      },
      include: ["*.ts"],
    },
    null,
    2,
  ) + "\n";

function envFile(specs: ProviderSpec[], adminKey: string): string {
  const lines = [
    "# Admin credential for the admin API, including minting project keys.",
    `ADMIN_API_KEY=${adminKey}`,
    "",
    "# Uncomment to sign in to the dashboard at http://localhost:3000/admin.",
    "# ADMIN_EMAIL=you@example.com",
    "# ADMIN_PASSWORD=change-me",
    "",
    "# Written by `setup`. Your app sends with this key.",
    "NOTIFKIT_API_KEY=",
    "NOTIFKIT_URL=http://localhost:3000",
    "",
    "# Leave unset in development and notifkit starts throwaway containers",
    "# (Docker must be running). Set both in production.",
    "# DATABASE_URL=postgres://user:pass@localhost:5432/notifkit",
    "# REDIS_URL=redis://localhost:6379",
  ];
  for (const v of envVars(specs)) lines.push("", `# ${v.comment}`, `${v.name}=`);
  return lines.join("\n") + "\n";
}

function serverTs(specs: ProviderSpec[]): string {
  const imports = specs.map((s) => `import { ${s.className} } from "${s.packageName}";`);
  const providers = specs.map((s) => `    new ${s.className}(${s.options}),`);
  const fallback =
    perChannel(specs).length < specs.length
      ? "\n  // Providers on the same channel are tried in the order listed: the first\n  // delivers, and the next takes over when it fails."
      : "";
  return `import { NotifkitServer } from "notifkit";
${imports.join("\n")}

// With no DATABASE_URL or REDIS_URL, notifkit starts throwaway PostgreSQL and
// Redis containers for development, so Docker must be running.
const server = new NotifkitServer({
  services: ["all"],
  port: Number(process.env.PORT ?? 3000),${fallback}
  providers: [
${providers.join("\n")}
  ],
});

await server.start();
`;
}

function setupTs(name: string, pm: PackageManager): string {
  return `/**
 * Creates a notifkit project on the running server and saves its API key to
 * .env as NOTIFKIT_API_KEY. Run it once, while \`${runScript(pm, "dev")}\` is up.
 */
import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = process.env.NOTIFKIT_URL || "http://localhost:3000";

if (process.env.NOTIFKIT_API_KEY) {
  console.log("NOTIFKIT_API_KEY is already set in .env. Nothing to do.");
  process.exit(0);
}

const res = await fetch(\`\${baseUrl}/v1/projects\`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${process.env.ADMIN_API_KEY}\`,
  },
  body: JSON.stringify({ name: ${JSON.stringify(name)} }),
}).catch((err: Error) => {
  console.error(\`Could not reach notifkit at \${baseUrl}. Is \\\`${runScript(pm, "dev")}\\\` running? (\${err.message})\`);
  process.exit(1);
});

if (!res.ok) {
  console.error(\`notifkit returned \${res.status}: \${await res.text()}\`);
  process.exit(1);
}

// The server stores only a hash of the key, so this response is the one
// chance to save it.
const { apiKey } = (await res.json()) as { id: string; apiKey: string };
const env = readFileSync(".env", "utf8");
writeFileSync(".env", env.replace(/^NOTIFKIT_API_KEY=.*$/m, \`NOTIFKIT_API_KEY=\${apiKey}\`));
console.log("Project created. Its API key is saved in .env as NOTIFKIT_API_KEY.");
`;
}

function sendTs(specs: ProviderSpec[], pm: PackageManager): string {
  // A template belongs to one channel, so each channel gets its own.
  const channels = perChannel(specs);
  const targetEnvs = [
    ...new Set(channels.flatMap((s) => ("env" in s.target ? [s.target.env] : []))),
  ];
  const check = targetEnvs.length
    ? `
const missing = ${JSON.stringify(targetEnvs).replace(/,/g, ", ")}.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(\`Set \${missing.join(", ")} in .env to where the test notifications should go.\`);
  process.exit(1);
}
`
    : "";
  const templates = channels.map(
    (s) => `    {
      id: "welcome-${s.channel}",
      channel: "${s.channel}",
      content: ${s.content},
    },`,
  );
  const contacts = channels.map((s) => {
    const target =
      "env" in s.target ? `process.env.${s.target.env}!` : JSON.stringify(s.target.value);
    return `  { channel: "${s.channel}", target: ${target} },`;
  });
  const notifies = channels.map(
    (s) => `
const ${s.channel} = await notifkit.notify({
  user: "usr_123",
  template: "welcome-${s.channel}",
  channels: ["${s.channel}"],
  data: { name: "Ada" },
});
console.log(\`Queued ${s.channel} notification \${${s.channel}.notificationId}.\`);`,
  );
  return `import { NotifkitClient } from "notifkit";

const apiKey = process.env.NOTIFKIT_API_KEY;
if (!apiKey) {
  console.error("NOTIFKIT_API_KEY is not set. Run \`${runScript(pm, "setup")}\` first.");
  process.exit(1);
}
${check}
const notifkit = new NotifkitClient({
  baseUrl: process.env.NOTIFKIT_URL || "http://localhost:3000",
  apiKey,
});

await notifkit.syncTemplates({
  templates: [
${templates.join("\n")}
  ],
});

await notifkit.addUser("usr_123", [
${contacts.join("\n")}
]);
${notifies.join("\n")}

console.log("Watch the server terminal for the deliveries.");
`;
}

function readme(name: string, specs: ProviderSpec[], pm: PackageManager): string {
  const fill = envVars(specs).map((v) => v.name);
  const credentials = fill.length
    ? `\nFirst fill in ${fill.map((n) => `\`${n}\``).join(", ")} in \`.env\`.\n`
    : "";
  return `# ${name}

A [notifkit](https://notifkit.dev) app using ${specs.map((s) => s.label).join(", ")}.

You need Node 22+ and Docker running. In development notifkit starts
throwaway PostgreSQL and Redis containers for you.
${credentials}
\`\`\`bash
${runScript(pm, "dev")}     # start the server, leave it running
\`\`\`

In a second terminal:

\`\`\`bash
${runScript(pm, "setup")}   # create a project and save its API key to .env
${runScript(pm, "send")}    # send a test notification
\`\`\`

- \`server.ts\` runs notifkit with your providers.
- \`send.ts\` shows the client: sync a template, add a user, notify them.
- The admin dashboard is at http://localhost:3000/admin. To sign in, uncomment
  \`ADMIN_EMAIL\` and \`ADMIN_PASSWORD\` in \`.env\` and restart the server.

For production you need your own PostgreSQL and Redis, \`NODE_ENV=production\`,
and \`npx notifkit-migrate\` before start. See
[Deployment](https://notifkit.dev/docs/deployment.html).
`;
}

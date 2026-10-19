import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NOTIFKIT_VERSION, PROVIDERS, type ProviderId, type ProviderSpec } from "./providers.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface RenderOptions {
  name: string;
  provider: ProviderId;
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
  const spec = PROVIDERS[opts.provider];
  const pm = opts.packageManager ?? "npm";
  return {
    "package.json": packageJson(opts.name, spec),
    "tsconfig.json": TSCONFIG,
    ".gitignore": "node_modules\ndist\n.env\n",
    ".env": envFile(spec, opts.adminKey),
    ".env.example": envFile(spec, ""),
    "server.ts": serverTs(spec),
    "setup.ts": setupTs(opts.name, pm),
    "send.ts": sendTs(spec, pm),
    "README.md": readme(opts.name, spec, pm),
  };
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

function packageJson(name: string, spec: ProviderSpec): string {
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
      [spec.packageName]: `^${spec.version}`,
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

function envFile(spec: ProviderSpec, adminKey: string): string {
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
  for (const v of spec.env) lines.push("", `# ${v.comment}`, `${v.name}=`);
  if ("env" in spec.target) lines.push("", `# ${spec.target.comment}`, `${spec.target.env}=`);
  return lines.join("\n") + "\n";
}

function serverTs(spec: ProviderSpec): string {
  return `import { NotifkitServer } from "notifkit";
import { ${spec.className} } from "${spec.packageName}";

// With no DATABASE_URL or REDIS_URL, notifkit starts throwaway PostgreSQL and
// Redis containers for development, so Docker must be running.
const server = new NotifkitServer({
  services: ["all"],
  port: Number(process.env.PORT ?? 3000),
  providers: [new ${spec.className}(${spec.options})],
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

function sendTs(spec: ProviderSpec, pm: PackageManager): string {
  const target =
    "env" in spec.target
      ? `
const to = process.env.${spec.target.env};
if (!to) {
  console.error("Set ${spec.target.env} in .env to where the test notification should go.");
  process.exit(1);
}
`
      : "";
  const targetExpr = "env" in spec.target ? "to" : JSON.stringify(spec.target.value);
  return `import { NotifkitClient } from "notifkit";

const apiKey = process.env.NOTIFKIT_API_KEY;
if (!apiKey) {
  console.error("NOTIFKIT_API_KEY is not set. Run \`${runScript(pm, "setup")}\` first.");
  process.exit(1);
}
${target}
const notifkit = new NotifkitClient({
  baseUrl: process.env.NOTIFKIT_URL || "http://localhost:3000",
  apiKey,
});

await notifkit.syncTemplates({
  templates: [
    {
      id: "welcome",
      channel: "${spec.channel}",
      content: ${spec.content},
    },
  ],
});

await notifkit.addUser("usr_123", [{ channel: "${spec.channel}", target: ${targetExpr} }]);

const { notificationId } = await notifkit.notify({
  user: "usr_123",
  template: "welcome",
  channels: ["${spec.channel}"],
  data: { name: "Ada" },
});

console.log(\`Queued notification \${notificationId}. Watch the server terminal for the delivery.\`);
`;
}

function readme(name: string, spec: ProviderSpec, pm: PackageManager): string {
  const fill = [...spec.env.map((v) => v.name), ...("env" in spec.target ? [spec.target.env] : [])];
  const credentials = fill.length
    ? `\nFirst fill in ${fill.map((n) => `\`${n}\``).join(", ")} in \`.env\`.\n`
    : "";
  return `# ${name}

A [notifkit](https://notifkit.dev) app using ${spec.label}.

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

- \`server.ts\` runs notifkit with your provider.
- \`send.ts\` shows the client: sync a template, add a user, notify them.
- The admin dashboard is at http://localhost:3000/admin. To sign in, uncomment
  \`ADMIN_EMAIL\` and \`ADMIN_PASSWORD\` in \`.env\` and restart the server.

For production you need your own PostgreSQL and Redis, \`NODE_ENV=production\`,
and \`npx notifkit-migrate\` before start. See
[Deployment](https://notifkit.dev/docs/deployment.html).
`;
}

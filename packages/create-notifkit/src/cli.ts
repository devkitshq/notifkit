import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId } from "./providers.js";
import {
  generateAdminKey,
  renderProject,
  runScript,
  validateName,
  writeProject,
  type PackageManager,
} from "./scaffold.js";

const DEFAULT_NAME = "notifkit-app";

/** Everything `run` touches outside the file system, so tests can stub it. */
export interface CliIo {
  cwd: string;
  /** Whether the user can answer prompts. */
  interactive: boolean;
  /** `npm_config_user_agent`, set by whichever package manager ran us. */
  userAgent: string | undefined;
  log(message: string): void;
  error(message: string): void;
  prompt(question: string): Promise<string>;
  install(dir: string, pm: PackageManager): Promise<void>;
}

export interface CliArgs {
  name: string | undefined;
  provider: string | undefined;
  install: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string", short: "p" },
      "no-install": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  return {
    name: positionals[0],
    provider: values.provider,
    install: !values["no-install"],
    force: values.force ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

function helpText(): string {
  const providers = PROVIDER_IDS.map((id) => `  ${id.padEnd(9)} ${PROVIDERS[id].label}`);
  return [
    "Usage: create-notifkit [name] [options]",
    "",
    "Scaffolds a notifkit server and client into ./<name>. Use . for the current directory.",
    "",
    "Options:",
    "  -p, --provider <id>  Delivery provider (default: console)",
    "      --no-install     Skip installing dependencies",
    "      --force          Write into a non-empty directory",
    "  -h, --help           Show this help",
    "  -v, --version        Show the version",
    "",
    "Providers:",
    ...providers,
  ].join("\n");
}

function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

async function askProvider(io: CliIo): Promise<string> {
  io.log("Which provider should deliver notifications?");
  PROVIDER_IDS.forEach((id, i) => io.log(`  ${i + 1}. ${PROVIDERS[id].label}`));
  const answer = (await io.prompt(`Provider [1]: `)).trim();
  if (!answer) return "console";
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= PROVIDER_IDS.length) {
    return PROVIDER_IDS[index - 1]!;
  }
  return answer;
}

/** Runs the CLI and returns its exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.error(`${(err as Error).message}\n\n${helpText()}`);
    return 1;
  }
  if (args.help) {
    io.log(helpText());
    return 0;
  }
  if (args.version) {
    io.log(ownVersion());
    return 0;
  }

  let target = args.name;
  if (!target && io.interactive) {
    target = (await io.prompt(`Project name [${DEFAULT_NAME}]: `)).trim();
  }
  target ||= DEFAULT_NAME;

  const inPlace = target === ".";
  const name = inPlace ? path.basename(io.cwd) : target;
  const invalid = validateName(name);
  if (invalid) {
    io.error(`Invalid project name: ${invalid}.`);
    return 1;
  }

  let provider = args.provider;
  if (!provider && io.interactive) provider = await askProvider(io);
  provider ||= "console";
  if (!isProviderId(provider)) {
    io.error(`unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
    return 1;
  }

  // A scoped name like @acme/notify goes in ./notify, not ./@acme/notify.
  const dirName = name.split("/").pop()!;
  const dir = inPlace ? io.cwd : path.resolve(io.cwd, dirName);
  const pm = detectPackageManager(io.userAgent);
  const files = renderProject({
    name,
    provider: provider as ProviderId,
    adminKey: generateAdminKey(),
    packageManager: pm,
  });

  try {
    writeProject(dir, files, { force: args.force });
  } catch (err) {
    io.error((err as Error).message);
    return 1;
  }
  io.log(`\nCreated ${name} with ${PROVIDERS[provider].label} in ${dir}`);

  let installed = false;
  if (args.install) {
    io.log(`\nInstalling dependencies with ${pm}…\n`);
    try {
      await io.install(dir, pm);
      installed = true;
    } catch (err) {
      io.error(`Install failed: ${(err as Error).message}`);
    }
  }

  const steps: string[] = [];
  if (!inPlace) steps.push(`cd ${dirName}`);
  if (!installed) steps.push(`${pm} install`);
  steps.push(`${runScript(pm, "dev")}      # needs Docker running`);
  io.log(["", "Next:", ...steps.map((s) => `  ${s}`)].join("\n"));
  io.log(
    [
      "",
      "Then, in a second terminal:",
      `  ${runScript(pm, "setup")}    # create a project, save its API key to .env`,
      `  ${runScript(pm, "send")}     # send a test notification`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** Runs a command with inherited stdio, rejecting unless it exits 0. */
export function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // npm, pnpm, … are .cmd shims on Windows, which only run through a shell.
    // Passing one quoted string avoids Node's warning about shell + args.
    const child =
      process.platform === "win32"
        ? spawn([cmd, ...args].map(quoteWin).join(" "), { cwd, stdio: "inherit", shell: true })
        : spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function quoteWin(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

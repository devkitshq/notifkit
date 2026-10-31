import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROVIDERS,
  PROVIDER_IDS,
  NOTIFKIT_VERSION,
} from "../packages/create-notifkit/src/providers.js";
import {
  generateAdminKey,
  renderProject,
  validateName,
  writeProject,
} from "../packages/create-notifkit/src/scaffold.js";
import {
  detectPackageManager,
  parseCliArgs,
  run,
  runCommand,
  type CliIo,
} from "../packages/create-notifkit/src/cli.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "create-notifkit-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Whether `^pin` admits `version` (plain x.y.z only; no prereleases). */
function caretAccepts(pin: string, version: string): boolean {
  const [pM, pm, pp] = pin.split(".").map(Number) as [number, number, number];
  const [vM, vm, vp] = version.split(".").map(Number) as [number, number, number];
  if (pM !== vM) return false;
  if (pM === 0) return pm === vm && vp >= pp;
  return vm > pm || (vm === pm && vp >= pp);
}

describe("providers", () => {
  // The versions are baked into the CLI so it needs no network or workspace at
  // run time, and scaffolded as `^version`. A release bumps package.json but
  // not these pins, so they may lag — as long as the caret range still
  // accepts the current version, a fresh app installs the latest release.
  it("pins every package to a caret range that accepts its workspace version", () => {
    const root = readJson(path.resolve(__dirname, "../package.json"));
    expect(caretAccepts(NOTIFKIT_VERSION, root.version)).toBe(true);
    for (const id of PROVIDER_IDS) {
      const spec = PROVIDERS[id];
      const pkg = readJson(path.resolve(__dirname, `../packages/provider-${id}/package.json`));
      expect(spec.packageName).toBe(pkg.name);
      expect(caretAccepts(spec.version, pkg.version), `${pkg.name}@${spec.version}`).toBe(true);
    }
  });

  it("scaffolds apps on a notifkit that has the DST quiet-hours fix", () => {
    // 0.1.15 stops quiet hours releasing early in a DST fall-back hour.
    expect(caretAccepts("0.1.15", NOTIFKIT_VERSION)).toBe(true);
  });

  it("caretAccepts follows npm caret semantics", () => {
    expect(caretAccepts("0.1.14", "0.1.14")).toBe(true);
    expect(caretAccepts("0.1.14", "0.1.15")).toBe(true);
    expect(caretAccepts("0.1.14", "0.2.0")).toBe(false); // 0.x: minor is breaking
    expect(caretAccepts("0.1.15", "0.1.14")).toBe(false); // pin ahead of the release
    expect(caretAccepts("1.2.0", "1.9.3")).toBe(true);
    expect(caretAccepts("1.2.0", "2.0.0")).toBe(false);
  });
});

describe("validateName", () => {
  it.each(["my-app", "app2", "@acme/notify", "a.b_c~d"])("accepts %s", (name) => {
    expect(validateName(name)).toBeUndefined();
  });

  it.each(["", "My-App", "my app", ".hidden", "_x", "a/b", "x".repeat(215)])(
    "rejects %j",
    (name) => {
      expect(validateName(name)).toEqual(expect.any(String));
    },
  );
});

describe("generateAdminKey", () => {
  it("is long, random and URL-safe", () => {
    const a = generateAdminKey();
    const b = generateAdminKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("renderProject", () => {
  it.each(PROVIDER_IDS)("renders a complete app for %s", (id) => {
    const files = renderProject({ name: "my-app", provider: id, adminKey: "k123" });
    expect(Object.keys(files).sort()).toEqual(
      [
        ".env",
        ".env.example",
        ".gitignore",
        "README.md",
        "package.json",
        "send.ts",
        "server.ts",
        "setup.ts",
        "tsconfig.json",
      ].sort(),
    );

    const spec = PROVIDERS[id];
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.name).toBe("my-app");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toEqual({
      notifkit: `^${NOTIFKIT_VERSION}`,
      [spec.packageName]: `^${spec.version}`,
    });
    expect(pkg.devDependencies).toHaveProperty("tsx");
    expect(pkg.devDependencies).toHaveProperty("@testcontainers/postgresql");
    expect(pkg.devDependencies).toHaveProperty("@testcontainers/redis");
    expect(Object.keys(pkg.scripts)).toEqual(
      expect.arrayContaining(["dev", "setup", "send", "typecheck"]),
    );

    expect(files["server.ts"]).toContain(`from "${spec.packageName}"`);
    expect(files["server.ts"]).toContain(`new ${spec.className}(`);
    expect(files["send.ts"]).toContain(`channel: "${spec.channel}"`);
    expect(files["send.ts"]).toContain(`channels: ["${spec.channel}"]`);

    expect(files[".env"]).toMatch(/^ADMIN_API_KEY=k123$/m);
    expect(files[".env.example"]).toMatch(/^ADMIN_API_KEY=$/m);
    for (const v of spec.env) {
      expect(files[".env"]).toContain(`${v.name}=`);
      expect(files[".env.example"]).toContain(`${v.name}=`);
    }
    expect(files[".gitignore"]).toMatch(/^\.env$/m);
    expect(files["README.md"]).toContain("# my-app");
  });

  it("needs no provider credentials for the console provider", () => {
    expect(PROVIDERS.console.env).toEqual([]);
    const files = renderProject({ name: "x", provider: "console", adminKey: "k" });
    expect(files["send.ts"]).not.toContain("process.env.TO_");
  });

  it("uses the package manager in the README commands", () => {
    const files = renderProject({
      name: "x",
      provider: "console",
      adminKey: "k",
      packageManager: "pnpm",
    });
    expect(files["README.md"]).toContain("pnpm dev");
    expect(files["README.md"]).not.toContain("npm run dev");
  });
});

describe("writeProject", () => {
  it("creates the directory and writes every file", () => {
    const dir = path.join(tempDir(), "nested", "app");
    writeProject(dir, { "a.txt": "A", "sub/b.txt": "B" });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(path.join(dir, "sub/b.txt"), "utf8")).toBe("B");
  });

  it("writes into an existing empty directory", () => {
    const dir = tempDir();
    writeProject(dir, { "a.txt": "A" });
    expect(existsSync(path.join(dir, "a.txt"))).toBe(true);
  });

  it("refuses a non-empty directory", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "keep.txt"), "mine");
    expect(() => writeProject(dir, { "a.txt": "A" })).toThrow(/not empty/);
    expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
  });

  it("writes into a non-empty directory with force", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "keep.txt"), "mine");
    writeProject(dir, { "a.txt": "A" }, { force: true });
    expect(readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("mine");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("A");
  });

  it("refuses a path that is a file", () => {
    const file = path.join(tempDir(), "f");
    writeFileSync(file, "");
    expect(() => writeProject(file, {}, { force: true })).toThrow(/not a directory/);
  });
});

describe("parseCliArgs", () => {
  it("reads the name and flags", () => {
    expect(parseCliArgs(["my-app", "--provider", "resend", "--no-install", "--force"])).toEqual({
      name: "my-app",
      provider: "resend",
      install: false,
      force: true,
      help: false,
      version: false,
    });
  });

  it("defaults to installing", () => {
    expect(parseCliArgs([])).toMatchObject({ name: undefined, install: true, force: false });
  });

  it("accepts -p and -h", () => {
    expect(parseCliArgs(["-p", "fcm", "-h"])).toMatchObject({ provider: "fcm", help: true });
  });

  it("throws on unknown flags", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow();
  });
});

describe("detectPackageManager", () => {
  it.each([
    ["pnpm/9.1.0 npm/? node/v22.0.0 win32 x64", "pnpm"],
    ["yarn/4.1.0 npm/? node/v22.0.0", "yarn"],
    ["bun/1.1.0 npm/? node/v22.0.0", "bun"],
    ["npm/10.5.0 node/v22.0.0 darwin arm64", "npm"],
    [undefined, "npm"],
  ])("%s → %s", (ua, pm) => {
    expect(detectPackageManager(ua)).toBe(pm);
  });
});

function makeIo(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: tempDir(),
    interactive: false,
    userAgent: "npm/10.0.0 node/v22.0.0",
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    prompt: vi.fn(async () => ""),
    install: vi.fn(async () => {}),
    ...overrides,
  };
  return { io, out, err };
}

describe("run", () => {
  it("scaffolds with the console provider and installs by default", async () => {
    const { io, out } = makeIo();
    const code = await run(["my-app"], io);
    expect(code).toBe(0);

    const dir = path.join(io.cwd, "my-app");
    expect(readJson(path.join(dir, "package.json")).dependencies).toHaveProperty(
      "@notifkit/provider-console",
    );
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toMatch(/^ADMIN_API_KEY=\S{40,}$/m);
    expect(io.install).toHaveBeenCalledWith(dir, "npm");
    const text = out.join("\n");
    expect(text).toContain("cd my-app");
    expect(text).toContain("npm run dev");
  });

  it("skips install with --no-install and tells the user to install", async () => {
    const { io, out } = makeIo({ userAgent: "pnpm/9.0.0" });
    expect(await run(["app", "--no-install", "-p", "twilio"], io)).toBe(0);
    expect(io.install).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("pnpm install");
    const pkg = readJson(path.join(io.cwd, "app", "package.json"));
    expect(pkg.dependencies).toHaveProperty("@notifkit/provider-twilio");
  });

  it("scaffolds into the current directory with '.'", async () => {
    const { io, out } = makeIo();
    const cwd = path.join(io.cwd, "dot-app");
    mkdirSync(cwd);
    io.cwd = cwd;
    expect(await run([".", "--no-install"], io)).toBe(0);
    expect(readJson(path.join(cwd, "package.json")).name).toBe("dot-app");
    expect(out.join("\n")).not.toContain("cd ");
  });

  it("prompts for the name and provider when interactive", async () => {
    const answers = ["prompted-app", "2"];
    const { io } = makeIo({
      interactive: true,
      prompt: vi.fn(async () => answers.shift()!),
    });
    expect(await run(["--no-install"], io)).toBe(0);
    const pkg = readJson(path.join(io.cwd, "prompted-app", "package.json"));
    expect(pkg.dependencies).toHaveProperty(PROVIDERS[PROVIDER_IDS[1]!].packageName);
  });

  it("uses defaults for blank prompt answers", async () => {
    const { io } = makeIo({ interactive: true, prompt: vi.fn(async () => "") });
    expect(await run(["--no-install"], io)).toBe(0);
    const pkg = readJson(path.join(io.cwd, "notifkit-app", "package.json"));
    expect(pkg.dependencies).toHaveProperty("@notifkit/provider-console");
  });

  it("accepts a provider name at the prompt", async () => {
    const answers = ["x", "fcm"];
    const { io } = makeIo({ interactive: true, prompt: vi.fn(async () => answers.shift()!) });
    expect(await run(["--no-install"], io)).toBe(0);
    expect(readJson(path.join(io.cwd, "x", "package.json")).dependencies).toHaveProperty(
      "@notifkit/provider-fcm",
    );
  });

  it("does not prompt when not interactive", async () => {
    const { io } = makeIo();
    expect(await run(["--no-install"], io)).toBe(0);
    expect(io.prompt).not.toHaveBeenCalled();
    expect(existsSync(path.join(io.cwd, "notifkit-app", "package.json"))).toBe(true);
  });

  it("rejects an unknown provider", async () => {
    const { io, err } = makeIo();
    expect(await run(["app", "-p", "pigeon"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown provider "pigeon"/);
    expect(existsSync(path.join(io.cwd, "app"))).toBe(false);
  });

  it("rejects an unknown provider at the prompt", async () => {
    const answers = ["x", "99"];
    const { io, err } = makeIo({ interactive: true, prompt: vi.fn(async () => answers.shift()!) });
    expect(await run(["--no-install"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown provider "99"/);
  });

  it("rejects an invalid name", async () => {
    const { io, err } = makeIo();
    expect(await run(["My App"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/My App/);
  });

  it("refuses a non-empty directory without --force", async () => {
    const { io, err } = makeIo();
    mkdirSync(path.join(io.cwd, "app"));
    writeFileSync(path.join(io.cwd, "app", "x"), "");
    expect(await run(["app"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/--force/);
    expect(io.install).not.toHaveBeenCalled();
  });

  it("reports a failed install without failing the scaffold", async () => {
    const { io, err, out } = makeIo({
      install: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await run(["app"], io)).toBe(0);
    expect(err.join("\n")).toMatch(/boom/);
    expect(out.join("\n")).toContain("npm install");
  });

  it("prints help", async () => {
    const { io, out } = makeIo();
    expect(await run(["--help"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("create-notifkit");
    for (const id of PROVIDER_IDS) expect(text).toContain(id);
  });

  it("prints the version", async () => {
    const { io, out } = makeIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports bad flags", async () => {
    const { io, err } = makeIo();
    expect(await run(["--nope"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/nope/);
  });
});

describe("runCommand", () => {
  it("resolves on exit 0", async () => {
    await expect(runCommand(process.execPath, ["-e", "0"], tempDir())).resolves.toBeUndefined();
  });

  it("rejects on a non-zero exit", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "process.exit(3)"], tempDir()),
    ).rejects.toThrow(/exited with code 3/);
  });

  it("rejects when the command cannot start", async () => {
    await expect(runCommand("definitely-not-a-command-xyz", [], tempDir())).rejects.toThrow();
  });
});

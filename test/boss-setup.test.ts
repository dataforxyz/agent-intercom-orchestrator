import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyBossSetup, BOSS_READINESS_SCHEMA_VERSION, BOSS_SETUP_SCHEMA_VERSION, inspectBossSetup, inspectTrustedLocalBossReadiness, parseBossPackageSettings, type BossOnboardingInput, type BossSetupReport } from "../src/boss-setup.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

async function resource(agentDir: string, repo: string, name: string, extension: string): Promise<void> {
  const root = join(agentDir, "git", "github.com", "dataforxyz", repo);
  await mkdir(join(root, extension.includes("/") ? extension.slice(0, extension.lastIndexOf("/")) : "."), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  await writeFile(join(root, extension), "export default function extension() {}\n");
  spawnSync("git", ["init", "-q", root]);
  spawnSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  spawnSync("git", ["-C", root, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", root, "add", "."]);
  spawnSync("git", ["-C", root, "commit", "-qm", "fixture"]);
}

test("Boss package settings preserve string and object entries with extension filters", () => {
  const parsed = parseBossPackageSettings({ packages: [
    "git:github.com/dataforxyz/agent-intercom-pi",
    { source: "git:github.com/dataforxyz/pi-extensions", extensions: ["pi-ralph-wiggum/index.ts"] },
    { source: "bad", extensions: [1] },
  ] });
  assert.deepEqual(parsed, [
    { index: 0, source: "git:github.com/dataforxyz/agent-intercom-pi", objectEntry: false },
    { index: 1, source: "git:github.com/dataforxyz/pi-extensions", objectEntry: true, extensions: ["pi-ralph-wiggum/index.ts"] },
    { index: 2, source: "bad", objectEntry: true, extensions: [] },
  ]);
});

test("Boss inventory recognizes the global four-resource stack and monorepo Ralph filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-ready-"));
  const agentDir = join(root, "agent");
  try {
    await Promise.all([
      resource(agentDir, "agent-intercom-pi", "@dataforxyz/agent-intercom-pi", "index.ts"),
      resource(agentDir, "orcboss", "@dataforxyz/orcboss", "src/index.ts"),
      resource(agentDir, "pi-extensions", "pi-extensions", "pi-ralph-wiggum/index.ts"),
      resource(agentDir, "pi-return-on", "pi-return-on", "src/index.ts"),
    ]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [
      "git:github.com/dataforxyz/agent-intercom-pi",
      "git:github.com/dataforxyz/orcboss",
      { source: "git:github.com/dataforxyz/pi-extensions", extensions: ["pi-ralph-wiggum/index.ts"] },
      "git:github.com/dataforxyz/pi-return-on",
    ] }));
    const report = await inspectBossSetup({ agentDir });
    assert.equal(report.version, BOSS_SETUP_SCHEMA_VERSION);
    assert.equal(report.status, "ready");
    assert.ok(report.resources.every((entry) => entry.status === "ready"));
    assert.equal(report.resources.find((entry) => entry.id === "return-on")?.unpublished, true);
    assert.deepEqual(report.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss inventory recognizes npm semver pins as blocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-npm-pin-"));
  const agentDir = join(root, "agent");
  try {
    const packageRoot = join(agentDir, "npm", "node_modules", "@dataforxyz", "agent-intercom-pi");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@dataforxyz/agent-intercom-pi", version: "0.9.3" }));
    await writeFile(join(packageRoot, "index.ts"), "export default function extension() {}\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@dataforxyz/agent-intercom-pi@0.9.3"] }));

    const report = await inspectBossSetup({ agentDir });
    const intercom = report.resources.find((entry) => entry.id === "intercom-pi");
    assert.equal(intercom?.pinned, true);
    assert.equal(intercom?.status, "blocked");
    assert.match(intercom?.diagnostics.join("\n") ?? "", /explicitly pinned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss inventory blocks dirty, pinned, duplicate, filtered, and missing resources without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-blocked-"));
  const agentDir = join(root, "agent");
  try {
    await resource(agentDir, "agent-intercom-pi", "@dataforxyz/agent-intercom-pi", "index.ts");
    await writeFile(join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi", "dirty.txt"), "dirty\n");
    await resource(agentDir, "pi-extensions", "pi-extensions", "pi-ralph-wiggum/index.ts");
    const settings = { theme: "preserve-me", packages: [
      "git:github.com/dataforxyz/agent-intercom-pi",
      "git:github.com/dataforxyz/agent-intercom-pi",
      { source: "git:github.com/dataforxyz/pi-extensions#deadbeef", extensions: ["other.ts"], untouched: true },
    ] };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
    const before = await readFile(join(agentDir, "settings.json"), "utf8");
    const report = await inspectBossSetup({ agentDir });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers.join("\n"), /Multiple matching|dirty|pinned|does not enable/);
    assert.deepEqual(report.changes.map((entry) => entry.resource).sort(), ["orchestrator", "return-on"]);
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const onboarding: BossOnboardingInput = {
  handlePrefix: "team",
  roles: {
    manager: { model: "provider/manager", effort: "high" },
    worker: { model: "provider/worker", effort: "medium" },
    scout: { model: "provider/scout", effort: "low" },
    adversary: { model: "provider/adversary", effort: "xhigh" },
  },
};

test("Boss setup apply installs only missing resources and preserves unrelated config idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-apply-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(join(agentDir, "intercom", "orchestrator"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "keep", packages: [] }));
    const configPath = join(agentDir, "intercom", "orchestrator", "config.json");
    await writeFile(configPath, JSON.stringify({ custom: { keep: true }, boss: { future: "keep" } }));
    const definitions = {
      "git:github.com/dataforxyz/agent-intercom-pi": ["agent-intercom-pi", "@dataforxyz/agent-intercom-pi", "index.ts"],
      "git:github.com/dataforxyz/orcboss": ["orcboss", "@dataforxyz/orcboss", "src/index.ts"],
      "git:github.com/dataforxyz/pi-extensions": ["pi-extensions", "pi-extensions", "pi-ralph-wiggum/index.ts"],
      "git:github.com/dataforxyz/pi-return-on": ["pi-return-on", "pi-return-on", "src/index.ts"],
    } as const;
    const install = async (source: string): Promise<void> => {
      const [repo, name, extension] = definitions[source as keyof typeof definitions];
      await resource(agentDir, repo, name, extension);
      const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      settings.packages.push(source === "git:github.com/dataforxyz/pi-extensions" ? { source, extensions: [extension] } : source);
      await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
    };
    const first = await applyBossSetup({ agentDir, onboarding, install, now: () => new Date("2026-03-21T00:00:00.000Z") });
    assert.deepEqual(first.installed.sort(), ["intercom-pi", "orchestrator", "ralph", "return-on"]);
    assert.equal(first.onboardingChanged, true);
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "keep");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.custom, { keep: true });
    assert.equal(config.boss.future, "keep");
    assert.deepEqual(config.boss.roles, onboarding.roles);
    assert.equal(config.boss.onboarding.completedAt, "2026-03-21T00:00:00.000Z");
    const before = await readFile(configPath, "utf8");
    const second = await applyBossSetup({ agentDir, onboarding, install: async () => { throw new Error("unexpected install"); } });
    assert.deepEqual(second.installed, []);
    assert.equal(second.onboardingChanged, false);
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted-local readiness composes stack, host, Intercom, onboarding, model, and state evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-readiness-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.boss = {
      handlePrefix: onboarding.handlePrefix,
      roles: structuredClone(onboarding.roles),
      worktreeRoot: DEFAULT_CONFIG.boss.worktreeRoot,
      resourceLeaseMinutes: DEFAULT_CONFIG.boss.resourceLeaseMinutes,
      onboarding: { version: "orc.boss-onboarding.v1", completedAt: "2026-03-21T00:00:00.000Z" },
    };
    const setup: BossSetupReport = {
      version: BOSS_SETUP_SCHEMA_VERSION,
      warning: "TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.",
      agentDir: root,
      settingsPath: join(root, "settings.json"),
      status: "ready",
      resources: [],
      changes: [],
      blockers: [],
    };
    const ready = await inspectTrustedLocalBossReadiness({
      agentDir: root,
      config,
      setup,
      host: { systemdAvailable: true, userManagerResponsive: true },
      intercom: { controllerRegistered: true },
      statePaths: [join(root, "state", "boss.json"), join(root, "runtime", "ralph")],
      availablePiModels: Object.values(onboarding.roles).map((role) => role.model),
    });
    assert.equal(ready.version, BOSS_READINESS_SCHEMA_VERSION);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.checks.map((check) => check.id), ["required-stack", "host", "intercom", "onboarding", "models", "state"]);
    const onboardingCheck = ready.checks.find((check) => check.id === "onboarding")!;
    assert.match(onboardingCheck.diagnostics.join("\n"), /independent Pi peers pinned to profile=pi-peer; native Codex\/Claude\/OpenCode subagent topology and per-run model overrides are unavailable/);
    for (const [role, preference] of Object.entries(onboarding.roles)) {
      assert.ok(onboardingCheck.diagnostics.includes(`${role}: harness=pi; profile=pi-peer; model=${preference.model}; effort=${preference.effort}`));
    }

    const invalidProfileConfig = structuredClone(config);
    invalidProfileConfig.profiles["pi-peer"].mode = "one-shot";
    const invalidProfile = await inspectTrustedLocalBossReadiness({
      agentDir: root,
      config: invalidProfileConfig,
      setup,
      host: { systemdAvailable: true, userManagerResponsive: true },
      intercom: { controllerRegistered: true },
      statePaths: [join(root, "state")],
      availablePiModels: Object.values(onboarding.roles).map((role) => role.model),
    });
    assert.equal(invalidProfile.status, "blocked");
    assert.match(invalidProfile.blockers.join("\n"), /Boss participant profile 'pi-peer' must use persistent mode/);

    const readOnlyState = join(root, "read-only-state");
    await writeFile(readOnlyState, "state\n");
    await chmod(readOnlyState, 0o444);
    const unwritable = await inspectTrustedLocalBossReadiness({
      agentDir: root,
      config,
      setup,
      host: { systemdAvailable: true, userManagerResponsive: true },
      intercom: { controllerRegistered: true },
      statePaths: [readOnlyState],
      availablePiModels: Object.values(onboarding.roles).map((role) => role.model),
    });
    assert.equal(unwritable.status, "blocked");
    assert.match(unwritable.blockers.join("\n"), /State path is unwritable/);

    const blocked = await inspectTrustedLocalBossReadiness({
      agentDir: root,
      config,
      setup,
      host: { systemdAvailable: false, userManagerResponsive: false, detail: "no user manager" },
      intercom: { controllerRegistered: false },
      statePaths: [join(root, "state")],
      availablePiModels: [onboarding.roles.manager.model],
    });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockers.join("\n"), /host:|intercom:|Unavailable configured model/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Boss setup apply refuses unsafe existing package state before install or config mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-refuse-"));
  const agentDir = join(root, "agent");
  try {
    await resource(agentDir, "agent-intercom-pi", "@dataforxyz/agent-intercom-pi", "index.ts");
    await writeFile(join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi", "dirty"), "dirty");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/dataforxyz/agent-intercom-pi"] }));
    let installs = 0;
    await assert.rejects(applyBossSetup({ agentDir, onboarding, install: async () => { installs += 1; } }), /BOSS_SETUP_BLOCKED.*dirty/s);
    assert.equal(installs, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packed-style setup launcher emits stable JSON and apply requires onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "boss-setup-cli-"));
  const agentDir = join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const launcher = new URL("../src/boss-setup-cli.mjs", import.meta.url);
    await chmod(launcher, 0o755);
    const checked = spawnSync(process.execPath, [launcher.pathname, "--plan", "--json"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    assert.equal(checked.status, 1);
    const output = JSON.parse(checked.stdout);
    assert.equal(output.mode, "plan");
    assert.equal(output.report.version, BOSS_SETUP_SCHEMA_VERSION);
    assert.equal(output.report.changes.length, 4);
    const applied = spawnSync(process.execPath, [launcher.pathname, "--apply"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    assert.equal(applied.status, 3);
    assert.match(applied.stderr, /BOSS_SETUP_ONBOARDING_REQUIRED/);

    const installedRoot = join(root, "project", "node_modules", "@dataforxyz", "orcboss");
    await mkdir(installedRoot, { recursive: true });
    await cp(new URL("../src", import.meta.url), join(installedRoot, "src"), { recursive: true });
    const installedLauncher = join(installedRoot, "src", "boss-setup-cli.mjs");
    const installed = spawnSync(process.execPath, [installedLauncher, "--check", "--json"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    assert.equal(installed.status, 1, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).report.version, BOSS_SETUP_SCHEMA_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

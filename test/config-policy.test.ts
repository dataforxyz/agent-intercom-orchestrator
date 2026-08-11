import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configMigrationDiagnostics, DEFAULT_CONFIG, isBossOnboardingComplete, mergeConfig, readConfig, readConfigWithDiagnostics, writeConfig, writeConfigDefaults } from "../src/config.ts";

test("policy config merges partial values without dropping typed defaults", () => {
  assert.equal(mergeConfig({}).routing.modelRouting.unmatchedHarness, null);
  const config = mergeConfig({
    disabledHarnesses: ["opencode", "opencode", "not-a-harness"],
    routing: {
      explicitOnly: [],
      profilePreferences: { codex: ["custom", "custom", "codex-safe"] },
      roleRequirements: { builder: { requiresSubagents: true }, invalid: { requiresSubagents: "yes" } },
      modelRouting: {
        unmatchedHarness: "opencode",
        rules: [{ harness: "codex", patterns: ["private/*", "private/*", "bad*pattern", "o2", "o9-*"] }],
        stripPrefixes: { codex: ["private/", "bad*"] },
      },
      fallback: { preserveRoleInstructions: false },
    },
    supervision: { futureGuidance: "ignored by normalized policy" },
  });
  assert.deepEqual(config.disabledHarnesses, ["opencode"]);
  assert.deepEqual(config.routing.explicitOnly, ["opencode"]);
  assert.deepEqual(config.routing.profilePreferences.codex, ["custom", "codex-safe"]);
  assert.deepEqual(config.routing.roleRequirements.builder, { requiresSubagents: true });
  assert.deepEqual(config.routing.roleRequirements.invalid, {});
  assert.equal(config.routing.modelRouting.unmatchedHarness, "opencode");
  assert.equal(mergeConfig({ routing: { modelRouting: { unmatchedHarness: null } } }).routing.modelRouting.unmatchedHarness, null);
  assert.deepEqual(config.routing.modelRouting.rules, [{ harness: "codex", patterns: ["private/*"] }]);
  assert.deepEqual(config.routing.modelRouting.stripPrefixes.codex, ["private/"]);
  assert.equal(config.routing.fallback.preserveRoleInstructions, false);
  assert.deepEqual(config.supervision, {});
});

test("Boss preferences merge only baseline model and effort fields", () => {
  const config = mergeConfig({
    boss: {
      roles: {
        manager: { model: "  provider/manager  ", effort: "high", instructions: "ignored" },
        worker: { model: "provider/worker", effort: "medium" },
        scout: { effort: "low" },
        adversary: { model: "provider/adversary", effort: "max" },
        council: { model: "ignored" },
      },
      handlePrefix: "team-boss",
      onboarding: { version: "orc.boss-onboarding.v1", completedAt: "2026-03-01T12:34:56Z", future: true },
    },
  });
  assert.deepEqual(config.boss, {
    roles: {
      manager: { model: "provider/manager", effort: "high" },
      worker: { model: "provider/worker", effort: "medium" },
      scout: { effort: "low" },
      adversary: { model: "provider/adversary", effort: "max" },
    },
    handlePrefix: "team-boss",
    worktreeRoot: DEFAULT_CONFIG.boss.worktreeRoot,
    resourceLeaseMinutes: DEFAULT_CONFIG.boss.resourceLeaseMinutes,
    onboarding: { version: "orc.boss-onboarding.v1", completedAt: "2026-03-01T12:34:56.000Z" },
  });
  assert.equal(isBossOnboardingComplete(config), true);
  const incomplete = mergeConfig({ boss: { handlePrefix: "Unsafe Prefix!", onboarding: { version: "old", completedAt: "today" } } });
  assert.deepEqual(incomplete.boss, DEFAULT_CONFIG.boss);
  assert.equal(isBossOnboardingComplete(incomplete), false);
});

test("legacy defaultProfiles migrate into ordered fallback without overriding explicit new policy", () => {
  const legacy = mergeConfig({ defaultProfiles: { claude: "team-claude" } });
  assert.deepEqual(legacy.routing.profilePreferences.claude, ["team-claude", "claude-safe", "claude-minimal"]);
  const configured = mergeConfig({
    defaultProfiles: { claude: "team-claude" },
    routing: { profilePreferences: { claude: ["claude-minimal", "team-claude"] } },
  });
  assert.deepEqual(configured.routing.profilePreferences.claude, ["claude-minimal", "team-claude"]);
});

test("default-policy writes preserve unknown config and round-trip policy deltas with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-policy-write-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({
      futureTopLevel: true,
      routing: {
        futureRouting: { keep: true },
        profilePreferences: { futureHarness: ["keep"] },
        modelRouting: { futureModelField: true, stripPrefixes: { futureHarness: ["keep/"] } },
        fallback: { futureFallback: true },
        capabilities: { futureCapability: true },
      },
      supervision: { futureGuidance: "keep" },
      boss: { futureBossField: { keep: true } },
    }), { mode: 0o644 });
    const config = await readConfig(path);
    config.disabledHarnesses = ["opencode"];
    config.routing.explicitOnly = [];
    config.routing.profilePreferences.codex = ["codex-minimal", "codex-safe"];
    config.routing.roleRequirements.builder = { requiresSubagents: true };
    config.routing.modelRouting.unmatchedHarness = "opencode";
    config.routing.modelRouting.rules = [{ harness: "pi", patterns: ["google/*"] }];
    config.routing.modelRouting.stripPrefixes.pi = ["google/"];
    config.routing.fallback.preserveRoleInstructions = false;
    config.boss.roles.manager = { model: "provider/manager", effort: "high" };
    config.boss.handlePrefix = "team-boss";
    config.boss.onboarding = { version: "orc.boss-onboarding.v1", completedAt: "2026-03-01T12:34:56.000Z" };
    await writeConfigDefaults(path, config);

    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.futureTopLevel, true);
    assert.deepEqual(raw.disabledHarnesses, ["opencode"]);
    assert.deepEqual(raw.routing.futureRouting, { keep: true });
    assert.deepEqual(raw.routing.profilePreferences.futureHarness, ["keep"]);
    assert.equal(Object.hasOwn(raw.routing, "explicitOnly"), false);
    assert.deepEqual(raw.routing.profilePreferences.codex, ["codex-minimal", "codex-safe"]);
    assert.deepEqual(raw.routing.roleRequirements.builder, { requiresSubagents: true });
    assert.equal(raw.routing.modelRouting.unmatchedHarness, "opencode");
    assert.deepEqual(raw.routing.modelRouting.rules, [{ harness: "pi", patterns: ["google/*"] }]);
    assert.deepEqual(raw.routing.modelRouting.stripPrefixes.pi, ["google/"]);
    assert.equal(raw.routing.modelRouting.futureModelField, true);
    assert.deepEqual(raw.routing.modelRouting.stripPrefixes.futureHarness, ["keep/"]);
    assert.equal(raw.routing.fallback.preserveRoleInstructions, false);
    assert.equal(raw.routing.fallback.futureFallback, true);
    assert.equal(raw.routing.capabilities.futureCapability, true);
    assert.equal(raw.supervision.futureGuidance, "keep");
    assert.deepEqual(raw.boss.futureBossField, { keep: true });
    assert.deepEqual(raw.boss.roles.manager, { model: "provider/manager", effort: "high" });
    assert.equal(raw.boss.handlePrefix, "team-boss");
    assert.equal(raw.boss.onboarding.version, "orc.boss-onboarding.v1");
    assert.equal(Object.hasOwn(raw.supervision, "recommendRalphForSubstantialWork"), false);
    assert.equal(Object.hasOwn(raw.supervision, "recommendReturnOnAfterSpawn"), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const roundTrip = await readConfig(path);
    assert.deepEqual(roundTrip.disabledHarnesses, config.disabledHarnesses);
    assert.deepEqual(roundTrip.routing.modelRouting, config.routing.modelRouting);
    assert.deepEqual(roundTrip.routing.profilePreferences, config.routing.profilePreferences);
    assert.deepEqual(roundTrip.routing.roleRequirements, config.routing.roleRequirements);
    assert.deepEqual(roundTrip.supervision, config.supervision);
    assert.deepEqual(roundTrip.boss, config.boss);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default writes preserve an explicit default-valued profile order with a custom legacy default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-policy-explicit-profile-order-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({
      defaultProfiles: { codex: "team-codex" },
      routing: { profilePreferences: { codex: DEFAULT_CONFIG.routing.profilePreferences.codex } },
    }));
    const before = await readConfig(path);
    assert.deepEqual(before.routing.profilePreferences.codex, ["codex-safe", "codex-minimal"]);
    await writeConfigDefaults(path, before);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(raw.routing.profilePreferences.codex, ["codex-safe", "codex-minimal"]);
    assert.deepEqual((await readConfig(path)).routing.profilePreferences.codex, before.routing.profilePreferences.codex);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full config writes round-trip all policy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-policy-full-write-"));
  const path = join(directory, "config.json");
  try {
    const config = mergeConfig({
      routing: {
        explicitOnly: ["claude"],
        profilePreferences: { pi: ["pi-peer"] },
        roleRequirements: { researcher: { requiresSubagents: true } },
        modelRouting: { unmatchedHarness: "claude", rules: [], stripPrefixes: { claude: [] } },
        fallback: { preserveRoleInstructions: false },
      },
      supervision: { recommendRalphForSubstantialWork: false, recommendReturnOnAfterSpawn: false },
    });
    await writeConfig(path, config);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.hasOwn(raw.supervision, "recommendRalphForSubstantialWork"), false);
    assert.equal(Object.hasOwn(raw.supervision, "recommendReturnOnAfterSpawn"), false);
    assert.deepEqual(await readConfig(path), config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy supervision fields produce additive diagnostics and disappear on intentional save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-supervision-migration-"));
  const path = join(directory, "config.json");
  try {
    const legacy = {
      futureTopLevel: { keep: true },
      supervision: {
        futureGuidance: "keep",
        recommendRalphForSubstantialWork: true,
        recommendReturnOnAfterSpawn: false,
      },
    };
    assert.deepEqual(configMigrationDiagnostics(legacy).map((item) => item.path), [
      "supervision.recommendRalphForSubstantialWork",
      "supervision.recommendReturnOnAfterSpawn",
    ]);
    await writeFile(path, JSON.stringify(legacy));
    const parsed = await readConfigWithDiagnostics(path);
    assert.deepEqual(parsed.config.supervision, {});
    assert.equal(parsed.diagnostics.length, 2);
    await writeConfigDefaults(path, parsed.config);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.futureTopLevel, { keep: true });
    assert.equal(saved.supervision.futureGuidance, "keep");
    assert.equal(Object.hasOwn(saved.supervision, "recommendRalphForSubstantialWork"), false);
    assert.equal(Object.hasOwn(saved.supervision, "recommendReturnOnAfterSpawn"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config normalization reads only exact own data descriptors", () => {
  let getterCalls = 0;
  const inherited = { defaultHarness: "claude", recommendReturnOnAfterSpawn: true };
  const raw = Object.create(inherited) as Record<string, unknown>;
  Object.defineProperty(raw, "defaultHarness", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "codex";
    },
  });
  const supervision = Object.create(inherited) as Record<string, unknown>;
  Object.defineProperty(supervision, "recommendRalphForSubstantialWork", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  raw.supervision = supervision;
  raw.roles = JSON.parse('{"__proto__":{"harness":"claude"},"safe":{"harness":"codex"}}');
  const accessorArgs: string[] = [];
  Object.defineProperty(accessorArgs, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "--yolo";
    },
  });
  raw.profiles = { accessor: { harness: "codex", command: "coi", args: accessorArgs } };

  const result = mergeConfig(raw);
  assert.equal(getterCalls, 0);
  assert.equal(result.defaultHarness, DEFAULT_CONFIG.defaultHarness);
  assert.equal(Object.hasOwn(result.roles, "__proto__"), false);
  assert.equal(result.roles.safe.harness, "codex");
  assert.equal(result.profiles.accessor.args, undefined);
  assert.deepEqual(configMigrationDiagnostics(raw), []);
});

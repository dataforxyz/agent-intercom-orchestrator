import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import {
  BOSS_SYMBOLIC_PROFILE_NAMES,
  detectHarnessAvailability,
  formatRoutingDecision,
  inferHarnessFromModel,
  isSafeModelPattern,
  modelMatchesPattern,
  normalizeModelForHarness,
  roleInstructionsForHarness,
  roleRequiresSubagents,
  resolveBossSymbolicProfile,
  resolveHarnessRoute,
  type HarnessAvailability,
} from "../src/routing.ts";
import type { Harness } from "../src/types.ts";

function availability(overrides: Partial<Record<Harness, Partial<HarnessAvailability>>> = {}): Record<Harness, HarnessAvailability> {
  return Object.fromEntries((["pi", "codex", "claude", "opencode"] as Harness[]).map((harness) => [harness, {
    harness,
    enabled: true,
    available: true,
    profile: `${harness}-profile`,
    executable: `/bin/${harness}`,
    mode: "persistent",
    supportsSubagents: harness === "codex" || harness === "claude",
    supportedEfforts: harness === "codex" ? ["low", "medium", "high", "xhigh"] : ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    reasons: [`${harness} is installed`],
    ...overrides[harness],
  }])) as Record<Harness, HarnessAvailability>;
}

test("advisory and builder role presets keep their configured first choices", () => {
  const advisor = resolveHarnessRoute({
    role: "advisor",
    defaultHarness: "pi",
    presetHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: availability(),
  });
  const builder = resolveHarnessRoute({
    role: "builder",
    defaultHarness: "pi",
    presetHarness: "codex",
    routing: DEFAULT_CONFIG.routing,
    availability: availability(),
  });
  assert.equal(advisor.selected, "pi");
  assert.equal(builder.selected, "codex");
  assert.match(advisor.candidates[0].source, /role preset/);
});

test("automatic routing falls back by availability and explains every skip", () => {
  const decision = resolveHarnessRoute({
    role: "builder",
    defaultHarness: "pi",
    presetHarness: "codex",
    routing: DEFAULT_CONFIG.routing,
    availability: availability({ codex: { available: false, reasons: ["codex command missing"] } }),
  });
  assert.equal(decision.selected, "claude");
  assert.equal(decision.candidates.find((candidate) => candidate.harness === "codex")?.eligible, false);
  assert.match(formatRoutingDecision(decision), /codex command missing/);
  assert.match(formatRoutingDecision(decision), /claude \[selected\]/);
});

test("subagent-required work excludes Pi and selects direct Codex before Claude", () => {
  const decision = resolveHarnessRoute({
    role: "advisor",
    defaultHarness: "pi",
    presetHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: availability(),
    requiresSubagents: true,
  });
  assert.equal(decision.selected, "codex");
  assert.match(decision.candidates[0].reasons.join(" "), /nested subagents are required/);
});

test("OpenCode remains explicit-only and explicit overrides win", () => {
  const onlyOpenCode = availability({
    pi: { available: false, reasons: ["missing"] },
    codex: { available: false, reasons: ["missing"] },
    claude: { available: false, reasons: ["missing"] },
  });
  const automatic = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: onlyOpenCode,
  });
  const explicit = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: onlyOpenCode,
    explicitHarness: "opencode",
    explicitSource: "profile",
    requiresSubagents: true,
  });
  assert.equal(automatic.selected, undefined);
  assert.match(automatic.candidates.find((candidate) => candidate.harness === "opencode")?.reasons.join(" ") ?? "", /explicit-only/);
  assert.equal(explicit.selected, "opencode");
  assert.equal(explicit.automatic, false);
  assert.equal(explicit.explicitSource, "profile");
  assert.match(explicit.reasons.join(" "), /does not support configured nested subagents/);

  const configuredAutomatic = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: { ...DEFAULT_CONFIG.routing, explicitOnly: [] },
    availability: onlyOpenCode,
  });
  assert.equal(configuredAutomatic.selected, undefined);
  assert.match(configuredAutomatic.candidates.find((candidate) => candidate.harness === "opencode")?.reasons.join(" ") ?? "", /explicit-only/);
});

test("disabled harnesses are excluded from automatic and explicit routing", () => {
  const config = mergeConfig({ disabledHarnesses: ["opencode"] });
  const detected = detectHarnessAvailability(config, {
    supportedEfforts: {},
    resolveCommand: () => "/bin/true",
  });
  assert.equal(detected.opencode.enabled, false);
  assert.equal(detected.opencode.available, false);
  assert.deepEqual(detected.opencode.reasons, ["disabled by configuration"]);

  const automatic = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "opencode",
    routing: { ...config.routing, preference: ["opencode"] },
    availability: detected,
  });
  assert.equal(automatic.selected, undefined);
  assert.match(formatRoutingDecision(automatic), /disabled by configuration/);

  const explicit = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: config.routing,
    availability: detected,
    explicitHarness: "opencode",
    explicitSource: "harness",
  });
  assert.equal(explicit.selected, undefined);
  assert.equal(explicit.automatic, false);
  assert.equal(explicit.candidates[0].eligible, false);
  assert.match(formatRoutingDecision(explicit), /Explicit harness: none/);
  assert.match(formatRoutingDecision(explicit), /disabled by configuration/);
});

test("configured routing preference outranks the legacy default fallback", () => {
  const decision = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: { ...DEFAULT_CONFIG.routing, preference: ["claude", "codex", "pi", "opencode"] },
    availability: availability(),
  });
  assert.equal(decision.selected, "claude");
  assert.match(decision.candidates[0].source, /routing\.preference/);

  const migrated = mergeConfig({ defaultHarness: "claude" });
  assert.deepEqual(migrated.routing.preference.slice(0, 2), ["claude", "pi"]);
});

test("explicit model identifiers select direct Codex or Claude harnesses", () => {
  assert.equal(inferHarnessFromModel("codex/gpt-5.6-sol"), "codex");
  assert.equal(inferHarnessFromModel("openai/gpt-5.4"), "codex");
  assert.equal(inferHarnessFromModel("gpt-5.6-sol"), "codex");
  assert.equal(inferHarnessFromModel("codex-mini-latest"), "codex");
  assert.equal(inferHarnessFromModel("o2"), undefined);
  assert.equal(inferHarnessFromModel("o9-reasoning"), undefined);
  assert.equal(inferHarnessFromModel("o1x"), undefined);
  assert.equal(inferHarnessFromModel("claude/claude-fable-5"), "claude");
  assert.equal(inferHarnessFromModel("anthropic/claude-opus-4-8"), "claude");
  assert.equal(inferHarnessFromModel("opus"), "claude");
  assert.equal(inferHarnessFromModel("google/gemini-3"), undefined);
});

test("Boss symbolic profiles resolve exact deterministic tuples with harness instruction layers", () => {
  assert.deepEqual(BOSS_SYMBOLIC_PROFILE_NAMES, [
    "manager",
    "worker",
    "scout",
    "scout-medium",
    "adversary",
    "council-systems",
    "council-critical",
    "council-alternative",
  ]);
  const expected = {
    manager: ["pi", "codex/gpt-5.6-sol", "high", "manager-restricted"],
    worker: ["codex", "gpt-5.6-sol", "medium", "builder-restricted"],
    scout: ["codex", "gpt-5.6-sol", "low", "review-readonly"],
    "scout-medium": ["codex", "gpt-5.6-sol", "medium", "review-readonly"],
    adversary: ["claude", "claude-opus-5", "xhigh", "review-readonly"],
    "council-systems": ["codex", "gpt-5.6-sol", "xhigh", "review-readonly"],
    "council-critical": ["claude", "claude-opus-5", "xhigh", "review-readonly"],
    "council-alternative": ["claude", "claude-fable-5", "medium", "review-readonly"],
  } as const;
  for (const name of BOSS_SYMBOLIC_PROFILE_NAMES) {
    const first = resolveBossSymbolicProfile(name);
    const second = resolveBossSymbolicProfile(name);
    assert.ok(first);
    assert.deepEqual([first.harness, first.model, first.effort, first.permissionProfile], expected[name]);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.match(first.instructions ?? "", new RegExp(`${first.harness === "pi" ? "Pi" : first.harness === "codex" ? "Codex" : "Claude Code"} harness layer`));
  }
  assert.equal(resolveBossSymbolicProfile("Manager"), undefined);
  assert.equal(resolveBossSymbolicProfile("manager "), undefined);
  assert.equal(resolveBossSymbolicProfile("council"), undefined);
  let coerced = false;
  const hostileName = {
    [Symbol.toPrimitive]() {
      coerced = true;
      return "manager";
    },
  };
  assert.equal(resolveBossSymbolicProfile(hostileName as unknown as string), undefined);
  assert.equal(coerced, false);

  const attemptedOverride = mergeConfig({
    roles: { manager: { harness: "claude", model: "claude-haiku", effort: "minimal", permissionProfile: "trusted" } },
    routing: { roles: { manager: ["claude"] } },
  });
  assert.deepEqual(
    [attemptedOverride.roles.manager.harness, attemptedOverride.roles.manager.model, attemptedOverride.roles.manager.effort, attemptedOverride.roles.manager.permissionProfile],
    expected.manager,
  );
  assert.deepEqual(attemptedOverride.routing.roles.manager, ["pi"]);

  const unavailableManager = resolveHarnessRoute({
    role: "manager",
    defaultHarness: "claude",
    routing: attemptedOverride.routing,
    availability: availability({ pi: { available: false, reasons: ["purpose-built Manager unavailable"] } }),
  });
  assert.equal(unavailableManager.selected, undefined);
  assert.deepEqual(unavailableManager.candidates.map((candidate) => candidate.harness), ["pi"]);
  const explicitOverride = resolveHarnessRoute({
    role: "manager",
    defaultHarness: "pi",
    routing: attemptedOverride.routing,
    availability: availability(),
    explicitHarness: "claude",
    explicitSource: "harness",
  });
  assert.equal(explicitOverride.selected, "claude");
  assert.equal(explicitOverride.automatic, false);
});

test("model routing is ordered, config-driven, normalized, and limited to safe patterns", () => {
  const policy = mergeConfig({
    routing: {
      modelRouting: {
        unmatchedHarness: "opencode",
        rules: [
          { harness: "claude", patterns: ["company/exact", "company/*", "unsafe*middle", "*", "two**"] },
          { harness: "codex", patterns: ["company/special*"] },
        ],
        stripPrefixes: { claude: ["company/", "bad*"], opencode: ["generic/"] },
      },
    },
  }).routing.modelRouting;
  assert.deepEqual(policy.rules, [
    { harness: "claude", patterns: ["company/exact", "company/*"] },
    { harness: "codex", patterns: ["company/special*"] },
  ]);
  assert.equal(inferHarnessFromModel("company/special-model", policy), "claude");
  assert.equal(inferHarnessFromModel("generic/model", policy), "opencode");
  assert.equal(normalizeModelForHarness("claude", "company/Sonnet", policy), "Sonnet");
  assert.equal(normalizeModelForHarness("opencode", "generic/model", policy), "model");
  assert.equal(isSafeModelPattern("gpt-*"), true);
  assert.equal(isSafeModelPattern("gpt-*unsafe"), false);
  assert.equal(modelMatchesPattern("GPT-5.6", "gpt-*"), true);
  assert.equal(modelMatchesPattern("gpt-5.6-extra", "gpt-5.6"), false);
});

test("role requirement defaults and cross-harness instruction fallback honor caller policy", () => {
  const routing = mergeConfig({
    routing: {
      roleRequirements: { builder: { requiresSubagents: true } },
      fallback: { preserveRoleInstructions: false },
    },
  }).routing;
  assert.equal(roleRequiresSubagents(routing, "builder", undefined), true);
  assert.equal(roleRequiresSubagents(routing, "builder", false), false);
  assert.equal(roleRequiresSubagents(routing, "reviewer", undefined), false);
  const preset = { harness: "claude" as const, instructions: "Review carefully." };
  assert.equal(roleInstructionsForHarness({ routing, preset, presetHarness: "claude", selectedHarness: "codex" }), undefined);
  assert.equal(roleInstructionsForHarness({ routing, preset, presetHarness: "claude", selectedHarness: "claude" }), "Review carefully.");
  assert.equal(roleInstructionsForHarness({ routing, preset, presetHarness: "claude", selectedHarness: "codex", explicitInstructions: "Caller mandate." }), "Caller mandate.");
});

test("automatic routing filters unsupported explicit effort while explicit harness reports a warning", () => {
  const automatic = resolveHarnessRoute({
    role: "builder",
    defaultHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: availability(),
    requestedEffort: "max",
  });
  assert.equal(automatic.selected, "claude");
  assert.match(automatic.candidates.find((candidate) => candidate.harness === "codex")?.reasons.join(" ") ?? "", /effort 'max' is unsupported/);

  const explicit = resolveHarnessRoute({
    role: "builder",
    defaultHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: availability(),
    explicitHarness: "codex",
    explicitSource: "harness",
    requestedEffort: "max",
  });
  assert.equal(explicit.selected, "codex");
  assert.match(explicit.reasons.join(" "), /capability warning.*unsupported/);
});

test("zero eligible harnesses returns an explainable preview decision", () => {
  const unavailable = availability({
    pi: { available: false, reasons: ["pi missing"] },
    codex: { available: false, reasons: ["codex missing"] },
    claude: { available: false, reasons: ["claude missing"] },
  });
  const decision = resolveHarnessRoute({
    role: "custom",
    defaultHarness: "pi",
    routing: DEFAULT_CONFIG.routing,
    availability: unavailable,
  });
  assert.equal(decision.selected, undefined);
  assert.match(formatRoutingDecision(decision), /Recommended harness: none/);
  assert.match(formatRoutingDecision(decision), /opencode \[excluded\].*explicit-only/);
});

test("availability requires the selected profile and reports mode, effort, and executable", () => {
  const config = mergeConfig({
    defaultProfiles: { pi: "missing", codex: "attach", claude: "claude-safe" },
    profiles: {
      attach: { harness: "codex", command: "codex", spawnable: false, description: "attach only" },
      "claude-safe": { harness: "claude", command: "claude", mode: "one-shot" },
    },
  });
  const detected = detectHarnessAvailability(config, {
    supportedEfforts: { claude: ["low", "high", "max"] },
    resolveCommand: (command) => command === "claude" ? "/usr/bin/claude" : undefined,
  });
  assert.equal(detected.pi.available, false);
  assert.match(detected.pi.reasons[0], /does not exist/);
  assert.equal(detected.codex.available, false);
  assert.match(detected.codex.reasons[0], /attach only/);
  assert.equal(detected.claude.available, true);
  assert.equal(detected.claude.executable, "/usr/bin/claude");
  assert.equal(detected.claude.mode, "one-shot");
  assert.deepEqual(detected.claude.supportedEfforts, ["low", "high", "max"]);
  assert.match(detected.claude.reasons[0], /one-shot mode/);
});

test("availability follows ordered profile fallback while explicit profiles remain pinned", () => {
  const config = mergeConfig({
    profiles: {
      "codex-first": { harness: "codex", command: "missing-codex" },
      "codex-backup": { harness: "codex", command: "working-codex", mode: "persistent" },
    },
    routing: { profilePreferences: { codex: ["codex-first", "codex-backup"] } },
  });
  const automatic = detectHarnessAvailability(config, {
    supportedEfforts: { codex: ["low", "high"] },
    resolveCommand: (command) => command === "working-codex" ? "/bin/working-codex" : undefined,
  });
  assert.equal(automatic.codex.available, true);
  assert.equal(automatic.codex.profile, "codex-backup");
  assert.deepEqual(automatic.codex.profileCandidates, ["codex-first", "codex-backup", "codex-safe"]);

  const explicit = detectHarnessAvailability(config, {
    profileOverrides: { codex: "codex-first" },
    resolveCommand: () => undefined,
  });
  assert.equal(explicit.codex.available, false);
  assert.equal(explicit.codex.profile, "codex-first");
  assert.deepEqual(explicit.codex.profileCandidates, ["codex-first"]);
});

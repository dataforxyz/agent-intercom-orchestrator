import type { Effort, Harness, LaunchProfile, ModelRoutingConfig, OrchestratorConfig, RolePreset, RoutingConfig } from "./types.ts";

export const ROUTABLE_HARNESSES: Harness[] = ["pi", "codex", "claude", "opencode"];

export const DEFAULT_MODEL_ROUTING: ModelRoutingConfig = {
  unmatchedHarness: null,
  rules: [
    { harness: "codex", patterns: ["codex/*", "openai/*", "codex-*", "gpt-*"] },
    { harness: "claude", patterns: ["claude/*", "anthropic/*", "claude-*", "opus", "opus-*", "sonnet", "sonnet-*", "haiku", "haiku-*", "fable", "fable-*"] },
  ],
  stripPrefixes: {
    codex: ["codex/", "openai/"],
    claude: ["claude/", "anthropic/"],
  },
};

export const BOSS_SYMBOLIC_PROFILE_NAMES = [
  "manager",
  "worker",
  "scout",
  "scout-medium",
  "adversary",
  "council-systems",
  "council-critical",
  "council-alternative",
] as const;

export type BossSymbolicProfileName = typeof BOSS_SYMBOLIC_PROFILE_NAMES[number];

const BOSS_PROFILE_BASE: Record<BossSymbolicProfileName, RolePreset> = {
  manager: {
    harness: "pi",
    permissionProfile: "manager-restricted",
    model: "codex/gpt-5.6-sol",
    effort: "high",
    instructions: "Manage one Boss goal through typed staffing intents, bounded assignments, integration, testing, and revision-bound proof. Do not use fleet mutation authority or perform Worker-owned source edits.",
  },
  worker: {
    harness: "codex",
    permissionProfile: "builder-restricted",
    model: "gpt-5.6-sol",
    effort: "medium",
    instructions: "Implement and test one bounded assignment, report concrete revision-bound evidence, and never declare the overall Boss run complete.",
  },
  scout: {
    harness: "codex",
    permissionProfile: "review-readonly",
    model: "gpt-5.6-sol",
    effort: "low",
    instructions: "Inspect the current state, identify gaps, and report concrete evidence without repairing or editing the work.",
  },
  "scout-medium": {
    harness: "codex",
    permissionProfile: "review-readonly",
    model: "gpt-5.6-sol",
    effort: "medium",
    instructions: "Perform the explicitly escalated deeper diagnosis, identify gaps, and report concrete evidence without repairing or editing the work.",
  },
  adversary: {
    harness: "claude",
    permissionProfile: "review-readonly",
    model: "claude-opus-5",
    effort: "xhigh",
    instructions: "Act as the event-driven Adversary at plan, material-risk, pre-integration, and final-proof gates. Challenge claims and report unresolved objections to both Manager and Boss without editing.",
  },
  "council-systems": {
    harness: "codex",
    permissionProfile: "review-readonly",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    instructions: "Independently review the frozen mature plan as the systems Council advisor. Remain read-only and return a bounded evidence-based verdict.",
  },
  "council-critical": {
    harness: "claude",
    permissionProfile: "review-readonly",
    model: "claude-opus-5",
    effort: "xhigh",
    instructions: "Independently review the frozen mature plan as the critical Council advisor. Remain read-only and return a bounded evidence-based verdict.",
  },
  "council-alternative": {
    harness: "claude",
    permissionProfile: "review-readonly",
    model: "claude-fable-5",
    effort: "medium",
    instructions: "Independently review the frozen mature plan as the alternative Council advisor. Remain read-only and return a bounded evidence-based verdict.",
  },
};

const BOSS_HARNESS_INSTRUCTION_LAYERS: Record<Harness, string> = {
  pi: "Pi harness layer: use only the purpose-built Manager controls and explicit resources; submit staffing through the Controller and never call agent_fleet.",
  codex: "Codex harness layer: keep nested agents within the same-or-tighter permission boundary and include their evidence in the bounded handoff.",
  claude: "Claude Code harness layer: keep subagents within the same-or-tighter read-only boundary and do not use permission-bypass modes.",
  opencode: "OpenCode harness layer: this harness is explicit-only and is not a canonical Boss preset fallback.",
};

/** Resolve one exact, version-pinned Boss role tuple without aliases or environment-dependent fallback. */
export function resolveBossSymbolicProfile(name: string): RolePreset | undefined {
  if (typeof name !== "string" || !Object.hasOwn(BOSS_PROFILE_BASE, name)) return undefined;
  const preset = BOSS_PROFILE_BASE[name as BossSymbolicProfileName];
  const layer = preset.harness ? BOSS_HARNESS_INSTRUCTION_LAYERS[preset.harness] : undefined;
  return {
    ...preset,
    ...(preset.instructions && layer ? { instructions: `${preset.instructions}\n\n${layer}` } : {}),
  };
}

/** Fresh canonical role presets suitable for merging into configuration defaults. */
export function bossSymbolicRolePresets(): Record<BossSymbolicProfileName, RolePreset> {
  return Object.fromEntries(BOSS_SYMBOLIC_PROFILE_NAMES.map((name) => [name, resolveBossSymbolicProfile(name)!])) as Record<BossSymbolicProfileName, RolePreset>;
}

export interface HarnessAvailability {
  harness: Harness;
  /** False when configuration disables this harness regardless of installation state. */
  enabled?: boolean;
  available: boolean;
  profile?: string;
  executable?: string;
  mode?: "persistent" | "one-shot";
  supportsSubagents: boolean;
  supportedEfforts?: Effort[];
  profileCandidates?: string[];
  reasons: string[];
}

export interface RoutingCandidate {
  harness: Harness;
  rank: number;
  source: string;
  eligible: boolean;
  selected: boolean;
  reasons: string[];
}

export interface RoutingDecision {
  selected?: Harness;
  automatic: boolean;
  explicitSource?: "harness" | "profile" | "model";
  role: string;
  requiresSubagents: boolean;
  requestedEffort?: Effort;
  reasons: string[];
  candidates: RoutingCandidate[];
}

export interface RoutingRequest {
  role: string;
  defaultHarness: Harness;
  routing: RoutingConfig;
  availability: Partial<Record<Harness, HarnessAvailability>>;
  presetHarness?: Harness;
  explicitHarness?: Harness;
  explicitSource?: "harness" | "profile" | "model";
  requiresSubagents?: boolean;
  requestedEffort?: Effort;
  candidateEfforts?: Partial<Record<Harness, Effort>>;
}

export interface AvailabilityOptions {
  /** Pinned caller-selected profiles. A pinned profile never falls back. */
  profileOverrides?: Partial<Record<Harness, string>>;
  /** Profiles to try before the configured harness order, such as a role preset. */
  preferredProfiles?: Partial<Record<Harness, string[]>>;
  supportedEfforts?: Partial<Record<Harness, Effort[]>>;
  resolveCommand: (command: string) => string | undefined;
}

function uniqueHarnesses(items: Array<Harness | undefined>): Harness[] {
  return [...new Set(items.filter((item): item is Harness => Boolean(item)))];
}

export function inspectHarnessProfile(
  harness: Harness,
  profileName: string | undefined,
  profile: LaunchProfile | undefined,
  supportsSubagents: boolean,
  supportedEfforts: Effort[] | undefined,
  resolveCommand: AvailabilityOptions["resolveCommand"],
): HarnessAvailability {
  const shared = { harness, supportsSubagents, ...(supportedEfforts ? { supportedEfforts: [...supportedEfforts] } : {}) };
  if (!profileName) {
    return { ...shared, available: false, reasons: ["no launch profile is configured"] };
  }
  if (!profile) {
    return { ...shared, available: false, profile: profileName, reasons: [`profile '${profileName}' does not exist`] };
  }
  const mode = profile.mode ?? "persistent";
  if (profile.harness !== harness) {
    return {
      ...shared,
      available: false,
      profile: profileName,
      mode,
      reasons: [`profile '${profileName}' launches ${profile.harness}, not ${harness}`],
    };
  }
  if (profile.spawnable === false) {
    return {
      ...shared,
      available: false,
      profile: profileName,
      mode,
      reasons: [profile.description || `profile '${profileName}' is attach-only`],
    };
  }
  const executable = resolveCommand(profile.command);
  if (!executable) {
    return {
      ...shared,
      available: false,
      profile: profileName,
      mode,
      reasons: [`profile '${profileName}' (${mode}) command '${profile.command}' is not executable`],
    };
  }
  return {
    ...shared,
    available: true,
    profile: profileName,
    executable,
    mode,
    reasons: [`profile '${profileName}' is spawnable in ${mode} mode at ${executable}`],
  };
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)))];
}

/** Return the exact ordered profiles considered for one harness. */
export function profileCandidatesForHarness(
  config: OrchestratorConfig,
  harness: Harness,
  options: Pick<AvailabilityOptions, "profileOverrides" | "preferredProfiles"> = {},
): string[] {
  const pinned = options.profileOverrides?.[harness]?.trim();
  if (pinned) return [pinned];
  return uniqueStrings([
    ...(options.preferredProfiles?.[harness] ?? []),
    ...(config.routing.profilePreferences[harness] ?? []),
    config.defaultProfiles[harness],
  ]);
}

/**
 * Build a side-effect-free availability snapshot apart from the injected command lookup.
 * Explicit caller profiles stay pinned. Automatic routing tries configured profiles in order
 * and selects the first spawnable profile whose command resolves.
 */
export function detectHarnessAvailability(
  config: OrchestratorConfig,
  options: AvailabilityOptions,
): Record<Harness, HarnessAvailability> {
  const supportsSubagents = new Set(config.routing.capabilities.requiresSubagents);
  return Object.fromEntries(ROUTABLE_HARNESSES.map((harness) => {
    const profileCandidates = profileCandidatesForHarness(config, harness, options);
    if (config.disabledHarnesses.includes(harness)) {
      return [harness, {
        harness,
        enabled: false,
        available: false,
        supportsSubagents: supportsSubagents.has(harness),
        ...(options.supportedEfforts?.[harness] ? { supportedEfforts: [...options.supportedEfforts[harness]!] } : {}),
        profileCandidates,
        reasons: ["disabled by configuration"],
      }];
    }
    const attempts = profileCandidates.map((profileName) => inspectHarnessProfile(
        harness,
        profileName,
        config.profiles[profileName],
        supportsSubagents.has(harness),
        options.supportedEfforts?.[harness],
        options.resolveCommand,
      ));
    const availableIndex = attempts.findIndex((attempt) => attempt.available);
    if (availableIndex >= 0) {
      const available = attempts[availableIndex];
      return [harness, {
        ...available,
        enabled: true,
        profileCandidates,
        reasons: [
          ...attempts.slice(0, availableIndex).flatMap((attempt) => attempt.reasons.map((reason) => `profile fallback: ${reason}`)),
          ...available.reasons,
        ],
      }];
    }
    const shared = {
      harness,
      supportsSubagents: supportsSubagents.has(harness),
      ...(options.supportedEfforts?.[harness] ? { supportedEfforts: [...options.supportedEfforts[harness]!] } : {}),
      profileCandidates,
    };
    if (attempts.length === 0) return [harness, { ...shared, enabled: true, available: false, reasons: ["no launch profile is configured"] }];
    return [harness, {
      ...shared,
      enabled: true,
      available: false,
      profile: attempts[0].profile,
      mode: attempts[0].mode,
      reasons: attempts.flatMap((attempt) => attempt.reasons),
    }];
  })) as Record<Harness, HarnessAvailability>;
}

/** Patterns are exact or contain one trailing `*` after a non-empty prefix. */
export function isSafeModelPattern(pattern: string): boolean {
  const value = pattern.trim();
  if (!value) return false;
  const firstWildcard = value.indexOf("*");
  return firstWildcard < 0 || (firstWildcard === value.length - 1 && firstWildcard > 0);
}

export function modelMatchesPattern(model: string, pattern: string): boolean {
  if (!isSafeModelPattern(pattern)) return false;
  const value = model.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  return normalizedPattern.endsWith("*")
    ? value.startsWith(normalizedPattern.slice(0, -1))
    : value === normalizedPattern;
}

/** Infer the direct harness requested by any explicit model identifier. */
export function inferHarnessFromModel(
  model: string | undefined,
  policy: ModelRoutingConfig = DEFAULT_MODEL_ROUTING,
): Harness | undefined {
  const value = model?.trim().toLowerCase();
  if (!value) return undefined;
  for (const rule of policy.rules) {
    if (rule.patterns.some((pattern) => modelMatchesPattern(value, pattern))) return rule.harness;
  }
  return policy.unmatchedHarness ?? undefined;
}

/** Remove the first configured literal provider prefix for the selected direct harness. */
export function normalizeModelForHarness(
  harness: Harness,
  model: string | undefined,
  policy: ModelRoutingConfig = DEFAULT_MODEL_ROUTING,
): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  for (const prefix of policy.stripPrefixes[harness] ?? []) {
    if (prefix && lower.startsWith(prefix.toLowerCase())) return normalized.slice(prefix.length);
  }
  return normalized;
}

export function roleRequiresSubagents(
  routing: RoutingConfig,
  role: string,
  callerOverride: boolean | undefined,
): boolean {
  return callerOverride ?? routing.roleRequirements[role]?.requiresSubagents ?? false;
}

export function roleInstructionsForHarness(input: {
  routing: RoutingConfig;
  preset?: RolePreset;
  presetHarness?: Harness;
  selectedHarness: Harness;
  explicitInstructions?: string;
}): string | undefined {
  const explicit = input.explicitInstructions?.trim();
  if (explicit) return explicit;
  const presetInstructions = input.preset?.instructions?.trim();
  if (!presetInstructions) return undefined;
  const crossedHarnesses = Boolean(input.presetHarness && input.presetHarness !== input.selectedHarness);
  return crossedHarnesses && !input.routing.fallback.preserveRoleInstructions ? undefined : presetInstructions;
}

function effortReason(availability: HarnessAvailability | undefined, effort: Effort | undefined): string | undefined {
  if (!effort || !availability?.supportedEfforts || availability.supportedEfforts.includes(effort)) return undefined;
  return `effort '${effort}' is unsupported (choose ${availability.supportedEfforts.join(", ") || "a harness default"})`;
}

/** Resolve one harness without reading the filesystem, mutating state, or launching work. */
export function resolveHarnessRoute(request: RoutingRequest): RoutingDecision {
  const role = request.role.trim() || "worker";
  const requiresSubagents = request.requiresSubagents === true;
  const requestedEffort = request.requestedEffort;
  if (request.explicitHarness) {
    const availability = request.availability[request.explicitHarness];
    const source = request.explicitSource ?? "harness";
    if (availability?.enabled === false) {
      const reasons = [`explicit ${source} requested ${request.explicitHarness}`, "excluded because the harness is disabled by configuration"];
      return {
        automatic: false,
        explicitSource: source,
        role,
        requiresSubagents,
        ...(requestedEffort ? { requestedEffort } : {}),
        reasons,
        candidates: [{
          harness: request.explicitHarness,
          rank: 1,
          source: `explicit ${source}`,
          eligible: false,
          selected: false,
          reasons,
        }],
      };
    }
    const effectiveEffort = request.candidateEfforts?.[request.explicitHarness] ?? requestedEffort;
    const warnings = [
      ...(!availability?.available ? availability?.reasons.map((reason) => `availability warning: ${reason}`) ?? ["availability warning: availability was not detected"] : availability.reasons),
      ...(requiresSubagents && !availability?.supportsSubagents ? ["capability warning: explicit harness does not support configured nested subagents"] : []),
      ...(effortReason(availability, effectiveEffort) ? [`capability warning: ${effortReason(availability, effectiveEffort)}`] : []),
    ];
    const reasons = [`explicit ${source} override selected ${request.explicitHarness}`, ...warnings];
    return {
      selected: request.explicitHarness,
      automatic: false,
      explicitSource: source,
      role,
      requiresSubagents,
      ...(requestedEffort ? { requestedEffort } : {}),
      reasons,
      candidates: [{
        harness: request.explicitHarness,
        rank: 1,
        source: `explicit ${source}`,
        eligible: true,
        selected: true,
        reasons,
      }],
    };
  }

  const symbolicPreset = resolveBossSymbolicProfile(role);
  const rolePreferences = request.routing.roles[role] ?? [];
  const ordered = symbolicPreset?.harness
    ? [symbolicPreset.harness]
    : uniqueHarnesses([
      request.presetHarness,
      ...rolePreferences,
      ...request.routing.preference,
      request.defaultHarness,
    ]);
  const sourceFor = (harness: Harness): string => {
    if (symbolicPreset?.harness === harness) return `exact Boss symbolic profile '${role}'`;
    if (harness === request.presetHarness) return `role preset '${role}'`;
    const roleIndex = rolePreferences.indexOf(harness);
    if (roleIndex >= 0) return `routing.roles.${role}[${roleIndex}]`;
    const preferenceIndex = request.routing.preference.indexOf(harness);
    if (preferenceIndex >= 0) return `routing.preference[${preferenceIndex}]`;
    return "legacy defaultHarness fallback";
  };
  // OpenCode has no implicit Orc routing contract. Configuration may add other
  // explicit-only harnesses, but cannot remove this hard boundary.
  const explicitOnly = new Set<Harness>([...request.routing.explicitOnly, "opencode"]);
  const candidates: RoutingCandidate[] = [];
  let selected: Harness | undefined;
  for (const [index, harness] of ordered.entries()) {
    const availability = request.availability[harness];
    const reasons: string[] = [`ranked by ${sourceFor(harness)}`];
    let eligible = true;
    if (explicitOnly.has(harness)) {
      eligible = false;
      reasons.push("excluded from automatic routing (explicit-only)");
    }
    if (requiresSubagents && !availability?.supportsSubagents) {
      eligible = false;
      reasons.push("excluded because nested subagents are required");
    }
    const unsupportedEffort = effortReason(availability, request.candidateEfforts?.[harness] ?? requestedEffort);
    if (unsupportedEffort) {
      eligible = false;
      reasons.push(`excluded because ${unsupportedEffort}`);
    }
    if (!availability?.available) {
      eligible = false;
      reasons.push(...(availability?.reasons ?? ["availability was not detected"]));
    } else {
      reasons.push(...availability.reasons);
    }
    const candidateSelected = eligible && selected === undefined;
    if (candidateSelected) {
      selected = harness;
      reasons.push("selected as the highest-ranked eligible harness");
    } else if (eligible) {
      reasons.push(`skipped because ${selected} ranked higher`);
    }
    candidates.push({ harness, rank: index + 1, source: sourceFor(harness), eligible, selected: candidateSelected, reasons });
  }
  const reasons = selected
    ? [`automatically selected ${selected} for role '${role}'${requiresSubagents ? " with nested subagents required" : ""}`]
    : [`no eligible installed harness for role '${role}'${requiresSubagents ? " with nested subagents required" : ""}`];
  return {
    selected,
    automatic: true,
    role,
    requiresSubagents,
    ...(requestedEffort ? { requestedEffort } : {}),
    reasons,
    candidates,
  };
}

export function formatRoutingDecision(decision: RoutingDecision): string {
  const heading = decision.selected
    ? `${decision.automatic ? "Recommended" : "Explicit"} harness: ${decision.selected}`
    : `${decision.automatic ? "Recommended" : "Explicit"} harness: none`;
  const requirements = `role=${decision.role} requiresSubagents=${decision.requiresSubagents}${decision.requestedEffort ? ` effort=${decision.requestedEffort}` : ""}`;
  const candidates = decision.candidates.map((candidate) => {
    const state = candidate.selected ? "selected" : candidate.eligible ? "eligible" : "excluded";
    return `${candidate.rank}. ${candidate.harness} [${state}] — ${candidate.reasons.join("; ")}`;
  });
  return [heading, requirements, ...decision.reasons, ...candidates].join("\n");
}

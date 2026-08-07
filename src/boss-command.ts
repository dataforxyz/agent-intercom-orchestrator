export const BOSS_COMMAND_ACTIONS = [
  "create",
  "doctor",
  "plan",
  "status",
  "resume",
  "pause",
  "freeze",
  "unfreeze",
  "cancel",
  "proof",
  "approve",
  "reject",
] as const;

export type BossCommandAction = typeof BOSS_COMMAND_ACTIONS[number];

export const BOSS_CREATE_ACCESS_LEVELS = ["read", "write"] as const;
export type BossCreateAccessLevel = typeof BOSS_CREATE_ACCESS_LEVELS[number];

export interface BossCreateRequirements {
  worktree?: BossCreateAccessLevel;
  edit?: boolean;
  tests?: boolean;
  gitTransport?: BossCreateAccessLevel;
}

export type BossCommandRequest =
  | { action: "status"; bossRunId?: string }
  | { action: "doctor" | "plan" }
  | { action: "create"; goal: string; requirements?: BossCreateRequirements }
  | { action: "freeze"; bossRunId: string; expectedAcceptanceRevision: number; expectedDesignRevision: number }
  | { action: "unfreeze"; bossRunId: string; expectedFreezeRevision: number; expectedFingerprintSha256: string }
  | { action: "resume" | "pause" | "cancel" | "proof" | "approve" | "reject"; bossRunId: string; note?: string };

export interface BossCommandContextLike {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
}

const BOSS_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/;

function parseRunId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (!BOSS_RUN_ID.test(id)) {
    throw new Error("Boss run id must be 8-128 characters using letters, numbers, dot, underscore, or dash.");
  }
  return id;
}

export function bossCreateRequest(goal: string | undefined, requirements?: BossCreateRequirements): BossCommandRequest {
  const normalizedGoal = goal?.trim() ?? "";
  if (!normalizedGoal) throw new Error("Boss create requires one explicit goal.");
  if (requirements !== undefined && (requirements === null || typeof requirements !== "object" || Array.isArray(requirements))) {
    throw new Error("Boss create requirements must be a structured object.");
  }
  const keys = Object.keys(requirements ?? {});
  const allowedKeys = new Set(["worktree", "edit", "tests", "gitTransport"]);
  if (keys.some((key) => !allowedKeys.has(key))) throw new Error("Boss create requirements contain an unknown field.");
  if (requirements?.worktree !== undefined && !BOSS_CREATE_ACCESS_LEVELS.includes(requirements.worktree)) throw new Error("Boss worktree requirement must be read or write.");
  if (requirements?.gitTransport !== undefined && !BOSS_CREATE_ACCESS_LEVELS.includes(requirements.gitTransport)) throw new Error("Boss Git transport requirement must be read or write.");
  if (requirements?.edit !== undefined && typeof requirements.edit !== "boolean") throw new Error("Boss edit requirement must be boolean.");
  if (requirements?.tests !== undefined && typeof requirements.tests !== "boolean") throw new Error("Boss tests requirement must be boolean.");
  const normalizedRequirements: BossCreateRequirements = {
    ...(requirements?.worktree ? { worktree: requirements.worktree } : {}),
    ...(requirements?.edit ? { edit: true } : {}),
    ...(requirements?.tests ? { tests: true } : {}),
    ...(requirements?.gitTransport ? { gitTransport: requirements.gitTransport } : {}),
  };
  return {
    action: "create",
    goal: normalizedGoal,
    ...(Object.keys(normalizedRequirements).length ? { requirements: normalizedRequirements } : {}),
  };
}

export function parseBossCommand(input: string): BossCommandRequest {
  const trimmed = input.trim();
  if (!trimmed) return { action: "status" };
  const firstSpace = trimmed.search(/\s/);
  const actionText = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const remainder = firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
  if (!BOSS_COMMAND_ACTIONS.includes(actionText as BossCommandAction)) {
    throw new Error(`Unknown /boss action '${actionText}'. Choose: ${BOSS_COMMAND_ACTIONS.join(", ")}.`);
  }
  const action = actionText as BossCommandAction;
  if (action === "create") {
    if (!remainder) throw new Error("/boss create requires one explicit goal.");
    return bossCreateRequest(remainder);
  }
  if (action === "doctor" || action === "plan") {
    if (remainder) throw new Error(`/boss ${action} does not accept arguments.`);
    return { action };
  }
  if (action === "status") {
    return remainder ? { action, bossRunId: parseRunId(remainder) } : { action };
  }
  const parts = remainder.split(/\s+/).filter(Boolean);
  const id = parseRunId(parts[0]);
  if (action === "freeze") {
    if (parts.length !== 3 || !/^\d+$/.test(parts[1] ?? "") || !/^\d+$/.test(parts[2] ?? "")) throw new Error("/boss freeze requires: <run> <expected-acceptance-revision> <expected-design-revision>.");
    const expectedAcceptanceRevision = Number(parts[1]);
    const expectedDesignRevision = Number(parts[2]);
    if (!Number.isSafeInteger(expectedAcceptanceRevision) || expectedAcceptanceRevision < 1 || !Number.isSafeInteger(expectedDesignRevision) || expectedDesignRevision < 1) throw new Error("/boss freeze revisions must be positive safe integers.");
    return { action, bossRunId: id, expectedAcceptanceRevision, expectedDesignRevision };
  }
  if (action === "unfreeze") {
    if (parts.length !== 3 || !/^\d+$/.test(parts[1] ?? "") || !/^[0-9a-f]{64}$/.test(parts[2] ?? "")) throw new Error("/boss unfreeze requires: <run> <expected-freeze-revision> <expected-fingerprint-sha256>.");
    const expectedFreezeRevision = Number(parts[1]);
    if (!Number.isSafeInteger(expectedFreezeRevision) || expectedFreezeRevision < 1) throw new Error("/boss unfreeze revision must be a positive safe integer.");
    return { action, bossRunId: id, expectedFreezeRevision, expectedFingerprintSha256: parts[2] };
  }
  const note = parts.slice(1).join(" ");
  return { action, bossRunId: id, ...(note ? { note } : {}) };
}

export function assertDirectInteractiveBossCommand(ctx: BossCommandContextLike): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    throw new Error("BOSS_DIRECT_USER_COMMAND_REQUIRED: /boss is accepted only from the authenticated interactive TUI.");
  }
}

export const BOSS_PROTECTED_PREREQUISITES = [
  "protected broker identity/provider/boot/generation attestation",
  "dedicated-UID Controller authority service and Manager-scoped credential",
  "broker-authoritative authority transition and controller-generation projection",
  "coordinated adapter boss-run-v1 readiness and Manager inventory verification",
] as const;

export function bossAuthorityUnavailableMessage(request: BossCommandRequest): string {
  const target = request.action === "create"
    ? "new run"
    : "bossRunId" in request && request.bossRunId
      ? request.bossRunId
      : "current run";
  return [
    `BOSS_AUTHORITY_UNAVAILABLE: cannot ${request.action} ${target}.`,
    "Boss remains dormant and fails closed until every protected prerequisite is authoritative:",
    ...BOSS_PROTECTED_PREREQUISITES.map((item) => `- ${item}`),
    "No run, credential, assignment, transition, or correlation state was created.",
  ].join("\n");
}

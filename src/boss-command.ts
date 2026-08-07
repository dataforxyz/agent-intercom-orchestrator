export const BOSS_COMMAND_ACTIONS = [
  "create",
  "doctor",
  "plan",
  "status",
  "resume",
  "pause",
  "cancel",
  "proof",
  "approve",
  "reject",
] as const;

export type BossCommandAction = typeof BOSS_COMMAND_ACTIONS[number];

export const BOSS_CREATE_NEEDS = ["worktree", "edit", "test", "git-transport"] as const;
export type BossCreateNeed = typeof BOSS_CREATE_NEEDS[number];

export type BossCommandRequest =
  | { action: "status"; bossRunId?: string }
  | { action: "doctor" | "plan" }
  | { action: "create"; goal: string; needs?: BossCreateNeed[] }
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

export function bossCreateRequest(goal: string | undefined, needs?: readonly string[]): BossCommandRequest {
  const normalizedGoal = goal?.trim() ?? "";
  if (!normalizedGoal) throw new Error("Boss create requires one explicit goal.");
  const normalizedNeeds = needs ?? [];
  if (new Set(normalizedNeeds).size !== normalizedNeeds.length) {
    throw new Error("Boss create needs must not contain duplicates.");
  }
  for (const need of normalizedNeeds) {
    if (!BOSS_CREATE_NEEDS.includes(need as BossCreateNeed)) {
      throw new Error(`Unknown Boss create need '${need}'. Choose: ${BOSS_CREATE_NEEDS.join(", ")}.`);
    }
  }
  return {
    action: "create",
    goal: normalizedGoal,
    ...(normalizedNeeds.length ? { needs: [...normalizedNeeds] as BossCreateNeed[] } : {}),
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
  const separator = remainder.search(/\s/);
  const id = parseRunId(separator < 0 ? remainder : remainder.slice(0, separator));
  const note = separator < 0 ? "" : remainder.slice(separator).trim();
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

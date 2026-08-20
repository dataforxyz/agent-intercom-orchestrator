import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TrustedLocalBossAssignmentRole, TrustedLocalBossDynamicGrowthGrant } from "./boss-trusted-local.ts";

// Trusted-local team policy is currently implemented by the Pi Intercom adapter.
// Keep every participant on Pi until coordinated non-Pi adapters implement the
// same exact-ID, role, inbound, and discovery contract.
export const TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS = "pi" as const;
export const TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE = "pi-peer" as const;

export interface TrustedLocalBossTeamIdentity {
  bossRunId: string;
  role: TrustedLocalBossAssignmentRole;
  controllerTarget: string;
  teamTargetSourcePath?: string;
}

export interface TrustedLocalBossTeamTargetSource {
  version: "orc.boss-team-targets.v1";
  bossRunId: string;
  controllerTarget: string;
  managerTarget: string;
  targets: readonly string[];
  updatedAt: string;
}

const BOSS_RUN_ID_PATTERN = /^boss-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function exactTarget(value: string, label: string): string {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be an exact non-empty stable session ID`);
  return value;
}

export function trustedLocalBossTeamTargetSourcePath(agentDir: string, bossRunId: string): string {
  if (!BOSS_RUN_ID_PATTERN.test(bossRunId)) throw new Error("Trusted-local Boss team target source run id is invalid");
  return join(agentDir, "intercom", "orchestrator", "boss-team-targets", `${bossRunId}.json`);
}

export function buildTrustedLocalBossTeamTargetSource(input: Omit<TrustedLocalBossTeamTargetSource, "version">): TrustedLocalBossTeamTargetSource {
  if (!BOSS_RUN_ID_PATTERN.test(input.bossRunId)) throw new Error("Trusted-local Boss team target source run id is invalid");
  const controllerTarget = exactTarget(input.controllerTarget, "Boss Controller target");
  const managerTarget = exactTarget(input.managerTarget, "Boss Manager target");
  const targets = input.targets.map((target) => exactTarget(target, "Boss team target"));
  if (managerTarget === controllerTarget || targets.includes(controllerTarget) || !targets.includes(managerTarget) || new Set(targets).size !== targets.length || targets.length > 260) {
    throw new Error("Trusted-local Boss team target source contains invalid or duplicate target correlation");
  }
  if (!Number.isFinite(Date.parse(input.updatedAt))) throw new Error("Trusted-local Boss team target source updatedAt is invalid");
  return { version: "orc.boss-team-targets.v1", bossRunId: input.bossRunId, controllerTarget, managerTarget, targets: Object.freeze([...targets].sort()), updatedAt: new Date(input.updatedAt).toISOString() };
}

export async function writeTrustedLocalBossTeamTargetSource(path: string, source: TrustedLocalBossTeamTargetSource): Promise<void> {
  const canonical = buildTrustedLocalBossTeamTargetSource(source);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(canonical, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export function trustedLocalBossParticipantTargets(bossRunId: string): readonly string[] {
  const suffix = bossRunId.slice(-12);
  return [
    `boss-manager-${suffix}`,
    `boss-worker-${suffix}`,
    `boss-scout-${suffix}`,
    `boss-adversary-${suffix}`,
  ];
}

export function assertTrustedLocalBossWorkerAdoptionAllowed(worker: { id: string; bossRunId?: string }): void {
  if (worker.bossRunId) throw new Error(`Boss-bound worker ${worker.id} cannot be adopted by another Controller; cancel the owning Boss run instead`);
}

export function buildTrustedLocalBossDelegatedManagerEnvironment(input: {
  workerId: string;
  workerIncarnationId: string;
  workerUnit: string;
  managerSessionId: string;
  rootWorkerIncarnationId: string;
  depth: number;
  hierarchyGrantId?: string;
  growthGrant: TrustedLocalBossDynamicGrowthGrant;
}): Record<string, string> {
  const { growthGrant } = input;
  if (growthGrant.state !== "active"
    || growthGrant.participantWorkerId !== input.workerId
    || growthGrant.participantWorkerIncarnationId !== input.workerIncarnationId
    || growthGrant.delegationGrant.issuedByWorkerIncarnationId !== input.workerIncarnationId) {
    throw new Error("Trusted-local Boss delegated manager binding does not match the exact active participant incarnation");
  }
  if (!input.workerUnit || !input.managerSessionId || !input.rootWorkerIncarnationId || !Number.isInteger(input.depth) || input.depth < 0) {
    throw new Error("Trusted-local Boss delegated manager binding identity is invalid");
  }
  return {
    AGENT_INTERCOM_DELEGATED_FLEET_ENABLED: "1",
    AGENT_INTERCOM_WORKER_ID: input.workerId,
    AGENT_INTERCOM_WORKER_INCARNATION_ID: input.workerIncarnationId,
    AGENT_INTERCOM_SYSTEMD_UNIT: input.workerUnit,
    AGENT_INTERCOM_MANAGER_SESSION_ID: input.managerSessionId,
    AGENT_INTERCOM_ROOT_WORKER_INCARNATION_ID: input.rootWorkerIncarnationId,
    AGENT_INTERCOM_WORKER_DEPTH: String(input.depth),
    ...(input.hierarchyGrantId ? { AGENT_INTERCOM_DELEGATION_GRANT_ID: input.hierarchyGrantId } : {}),
    AGENT_INTERCOM_ACTIVE_DELEGATION_GRANT_ID: growthGrant.delegationGrant.grantId,
    AGENT_INTERCOM_BOSS_RUN_ID: growthGrant.bossRunId,
    AGENT_INTERCOM_BOSS_GROWTH_GRANT_REVISION: String(growthGrant.revision),
  };
}

export function buildTrustedLocalBossTeamEnvironment(identity: TrustedLocalBossTeamIdentity): Record<string, string> {
  const targets = trustedLocalBossParticipantTargets(identity.bossRunId);
  return {
    AGENT_INTERCOM_BOSS_RUN_ID: identity.bossRunId,
    AGENT_INTERCOM_BOSS_ROLE: identity.role,
    AGENT_INTERCOM_BOSS_CONTROLLER_TARGET: identity.controllerTarget,
    AGENT_INTERCOM_BOSS_MANAGER_TARGET: targets[0],
    AGENT_INTERCOM_BOSS_TEAM_TARGETS: JSON.stringify(targets),
    ...(identity.teamTargetSourcePath ? { AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE: identity.teamTargetSourcePath } : {}),
    AGENT_INTERCOM_BOSS_VISIBILITY: "team-only",
    AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "1",
  };
}

export function trustedLocalBossRalphLoopName(identity: Pick<TrustedLocalBossTeamIdentity, "bossRunId" | "role">): string {
  return `boss-${identity.bossRunId.slice(-12)}-${identity.role}`;
}

export function buildTrustedLocalBossSupervisionEnvironment(identity: TrustedLocalBossTeamIdentity, privateRuntimeRoot: string): Record<string, string> {
  return {
    PI_RALPH_STATE_ROOT: join(privateRuntimeRoot, "boss-ralph", identity.bossRunId, identity.role),
    PI_RETURN_ON_STATE_DIR: join(privateRuntimeRoot, "boss-return-on", identity.bossRunId, identity.role),
  };
}

export function buildTrustedLocalBossParticipantPrompt(identity: TrustedLocalBossTeamIdentity, goal: string): string {
  const loopName = trustedLocalBossRalphLoopName(identity);
  const reporting = identity.role === "manager"
    ? [
      "At the start of every Ralph iteration, call intercom_team and verify the exact Worker and Scout are live and ready for this run.",
      "Assign bounded slices with a stable assignment token such as assignment:<slice-id>, and require the participant to acknowledge that exact token before treating later status as assignment-aware.",
      "Send a participant nudge only when its exact assignment acknowledgement or requested evidence is overdue; do not send routine every-iteration nudges after acknowledgement.",
      "Escalation is bounded: after one overdue acknowledgement or stale requested update, nudge once; after a second consecutive stale check, report one aggregated blocker to the Controller and reassign other unblocked work.",
      "Do not report routine staffing, individual Scout findings, assignment sends, acknowledgements, or intermediate slice transitions separately to the Controller. Aggregate them into a concise milestone summary only when a bounded slice completes, a decision is required, a blocker changes safe progress, verification fails, or the run reaches a terminal handoff.",
      "After sending nudges, if the next useful step depends on Worker or Scout reports, stop the turn without calling ralph_done. Let the inbound Intercom report wake you, integrate it, then continue; never queue Ralph continuations merely to poll.",
    ]
    : identity.role === "adversary"
      ? [
        "At the start of every Ralph iteration, check exact team identity with intercom_team before reviewing any proof revision.",
        "Report one exact-revision advisory decision to the Controller when review completes, or report immediately only when a blocker or required Controller decision prevents that review; do not send routine iteration updates.",
      ]
      : [
        "At the start of every Ralph iteration, check exact team readiness with intercom_team.",
        "Acknowledge each new stable assignment token exactly once to the Manager with intercom_send before starting it, then report concrete completion evidence or a material blocker through the same channel.",
        "Do not emit routine heartbeat or unchanged-progress messages; send an update when requested evidence is ready, the assignment materially changes state, or safe progress is blocked.",
      ];
  const checklist = identity.role === "manager"
    ? ["Check exact team liveness and readiness", "Track exact assignment acknowledgements and review participant evidence", "Assign or execute the next unblocked work and report only milestone, decision, blocker, failure, or terminal summaries to the Controller"]
    : identity.role === "worker"
      ? ["Take the next bounded implementation item", "Verify the change with concrete evidence", "Report progress and blockers to the Manager"]
      : identity.role === "scout"
        ? ["Investigate the next dependency, risk, or verification gap", "Capture concrete evidence", "Report findings and blockers to the Manager"]
        : ["Wait for and inspect the exact proof revision", "Challenge claims against concrete evidence", "Report an exact-revision advisory decision to the Controller"];
  const taskContent = [
    `# Trusted-local Boss ${identity.role} loop`,
    "",
    "## Goal",
    `- ${goal}`,
    "",
    "## Checklist",
    ...checklist.map((item) => `- [ ] ${item}`),
    "",
    "## Iteration protocol",
    ...reporting.map((item) => `- ${item}`),
    "- Update this Ralph task file with progress and verification evidence before ending each iteration.",
  ].join("\n");
  return [
    `Immediately start the isolated Ralph loop named ${loopName} with ralph_start.`,
    `Use taskContent exactly as follows: ${JSON.stringify(taskContent)}.`,
    identity.role === "manager"
      ? "Set itemsPerIteration=3, reflectEvery=5, maxIterations=100, and endInstructions to send one aggregated final evidence/blocker handoff to the Controller."
      : identity.role === "adversary"
        ? "Set itemsPerIteration=3, reflectEvery=5, maxIterations=100, and endInstructions to send one exact-revision final advisory decision to the Controller."
        : "Set itemsPerIteration=3, reflectEvery=5, maxIterations=100, and endInstructions to send final evidence and blockers to the Manager only.",
    ...reporting,
    identity.role === "manager"
      ? "After productive work, call ralph_done only when another unblocked iteration should start immediately. When awaiting Worker or Scout reports, stop without ralph_done so inbound Intercom can wake the idle Manager."
      : "After productive work, call ralph_done so the next supervised iteration starts; do not use it to poll or wait.",
  ].join("\n");
}

/** Returns no Boss metadata for ordinary fleet spawns. */
export function buildOptionalTrustedLocalBossTeamEnvironment(identity?: TrustedLocalBossTeamIdentity): Record<string, string> {
  return identity ? buildTrustedLocalBossTeamEnvironment(identity) : {};
}

export function assertTrustedLocalBossControllerTarget(identity: TrustedLocalBossTeamIdentity, managerSessionTarget: string): void {
  if (identity.controllerTarget !== managerSessionTarget) {
    throw new Error("Trusted-local Boss Controller target must equal the exact owning Intercom manager session target");
  }
}

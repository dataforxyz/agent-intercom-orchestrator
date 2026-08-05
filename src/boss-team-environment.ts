import { join } from "node:path";
import type { TrustedLocalBossAssignmentRole } from "./boss-trusted-local.ts";

// Trusted-local team policy is currently implemented by the Pi Intercom adapter.
// Keep every participant on Pi until coordinated non-Pi adapters implement the
// same exact-ID, role, inbound, and discovery contract.
export const TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS = "pi" as const;

export interface TrustedLocalBossTeamIdentity {
  bossRunId: string;
  role: TrustedLocalBossAssignmentRole;
  controllerTarget: string;
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

export function buildTrustedLocalBossTeamEnvironment(identity: TrustedLocalBossTeamIdentity): Record<string, string> {
  const targets = trustedLocalBossParticipantTargets(identity.bossRunId);
  return {
    AGENT_INTERCOM_BOSS_RUN_ID: identity.bossRunId,
    AGENT_INTERCOM_BOSS_ROLE: identity.role,
    AGENT_INTERCOM_BOSS_CONTROLLER_TARGET: identity.controllerTarget,
    AGENT_INTERCOM_BOSS_MANAGER_TARGET: targets[0],
    AGENT_INTERCOM_BOSS_TEAM_TARGETS: JSON.stringify(targets),
    AGENT_INTERCOM_BOSS_VISIBILITY: "team-only",
    AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "1",
  };
}

export function trustedLocalBossRalphLoopName(identity: Pick<TrustedLocalBossTeamIdentity, "bossRunId" | "role">): string {
  return `boss-${identity.bossRunId.slice(-12)}-${identity.role}`;
}

export function buildTrustedLocalBossRalphEnvironment(identity: TrustedLocalBossTeamIdentity, privateRuntimeRoot: string): Record<string, string> {
  return {
    PI_RALPH_STATE_ROOT: join(privateRuntimeRoot, "boss-ralph", identity.bossRunId, identity.role),
  };
}

export function buildTrustedLocalBossParticipantPrompt(identity: TrustedLocalBossTeamIdentity, goal: string): string {
  const loopName = trustedLocalBossRalphLoopName(identity);
  const reporting = identity.role === "manager"
    ? [
      "At the start of every Ralph iteration, call intercom_team and verify the exact Worker and Scout are live and ready for this run.",
      "Every iteration, send bounded progress nudges to both Worker and Scout with intercom_send; never passively wait for updates.",
      "Escalation is bounded: after one missing or stale update, nudge the participant; after two consecutive stale checks, report the blocker to the Controller and reassign other unblocked work.",
      "Integrate evidence, assign the next bounded work, and report a concise team summary to the Controller every iteration.",
      "After sending nudges, if the next useful step depends on Worker or Scout reports, stop the turn without calling ralph_done. Let the inbound Intercom report wake you, integrate it, then continue; never queue Ralph continuations merely to poll.",
    ]
    : identity.role === "adversary"
      ? [
        "At the start of every Ralph iteration, check exact team identity with intercom_team before reviewing any proof revision.",
        "Report findings, blockers, and the exact proof revision to the Controller during every productive iteration.",
      ]
      : [
        "At the start of every Ralph iteration, check exact team readiness with intercom_team.",
        "Report concrete progress, verification evidence, and blockers to the Manager with intercom_send during every iteration.",
        "Do not wait for a status request before reporting progress.",
      ];
  const checklist = identity.role === "manager"
    ? ["Check exact team liveness and readiness", "Nudge Worker and Scout and review their latest evidence", "Assign or execute the next unblocked work and report to the Controller"]
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
    "Set itemsPerIteration=3, reflectEvery=5, maxIterations=100, and endInstructions to report final evidence and blockers to the Manager and Controller.",
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

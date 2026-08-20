import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertTrustedLocalBossControllerTarget, assertTrustedLocalBossWorkerAdoptionAllowed, buildOptionalTrustedLocalBossTeamEnvironment, buildTrustedLocalBossDelegatedManagerEnvironment, buildTrustedLocalBossParticipantPrompt, buildTrustedLocalBossSupervisionEnvironment, buildTrustedLocalBossTeamEnvironment, buildTrustedLocalBossTeamTargetSource, TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS, trustedLocalBossParticipantTargets, trustedLocalBossRalphLoopName, trustedLocalBossTeamTargetSourcePath, writeTrustedLocalBossTeamTargetSource } from "../src/boss-team-environment.ts";
import { buildWorkerEnvironment } from "../src/workers.ts";

test("Boss delegated manager environment binds the exact active growth grant and participant incarnation", () => {
  const growthGrant = {
    version: "orc.boss-dynamic-growth-grant.v1" as const,
    revision: 3,
    bossRunId: "boss-00000000-0000-4000-8000-123456789abc",
    participantRole: "manager" as const,
    participantWorkerId: "boss-manager-123456789abc",
    participantWorkerIncarnationId: "manager-incarnation-1",
    acceptanceRevision: 2,
    designRevision: 4,
    delegationGrant: {
      version: 1 as const, grantId: "growth-grant-3", issuedAt: 1_700_000_000_000, issuedByWorkerIncarnationId: "manager-incarnation-1",
      roles: ["scout"], harnesses: ["pi" as const], profiles: ["boss-dynamic-pi"], permissionProfiles: ["boss-dynamic-scout"],
      cwdRoots: [{ path: "/tmp" }], modelPatterns: ["anthropic/claude-*"], efforts: ["high" as const],
      maxLiveDirectChildren: 1, maxLiveDescendants: 1, maxDepth: 1, canSubdelegate: false,
    },
    state: "active" as const, authorizedBySessionId: "controller-session", authorizedAt: "2023-11-14T22:13:20.000Z",
  };
  const environment = buildTrustedLocalBossDelegatedManagerEnvironment({
    workerId: growthGrant.participantWorkerId, workerIncarnationId: growthGrant.participantWorkerIncarnationId,
    workerUnit: "agent-worker.service", managerSessionId: "controller-session", rootWorkerIncarnationId: "root-incarnation", depth: 0, growthGrant,
  });
  assert.equal(environment.AGENT_INTERCOM_DELEGATED_FLEET_ENABLED, "1");
  assert.equal(environment.AGENT_INTERCOM_ACTIVE_DELEGATION_GRANT_ID, "growth-grant-3");
  assert.equal(environment.AGENT_INTERCOM_BOSS_GROWTH_GRANT_REVISION, "3");
  assert.throws(() => buildTrustedLocalBossDelegatedManagerEnvironment({ workerId: growthGrant.participantWorkerId, workerIncarnationId: "stale", workerUnit: "agent-worker.service", managerSessionId: "controller-session", rootWorkerIncarnationId: "root-incarnation", depth: 0, growthGrant }), /exact active participant incarnation/);
});

test("Boss team environment binds every role to one deterministic Pi team including prospective adversary", () => {
  assert.equal(TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS, "pi");
  const bossRunId = "boss-00000000-0000-4000-8000-123456789abc";
  const targets = [
    "boss-manager-123456789abc",
    "boss-worker-123456789abc",
    "boss-scout-123456789abc",
    "boss-adversary-123456789abc",
  ];
  assert.deepEqual(trustedLocalBossParticipantTargets(bossRunId), targets);
  assert.deepEqual(buildOptionalTrustedLocalBossTeamEnvironment(), {}, "ordinary fleet spawns must receive no Boss metadata");
  assert.doesNotThrow(() => assertTrustedLocalBossControllerTarget({ bossRunId, role: "manager", controllerTarget: "controller-exact-target" }, "controller-exact-target"));
  assert.throws(
    () => assertTrustedLocalBossControllerTarget({ bossRunId, role: "manager", controllerTarget: "stale-controller-target" }, "controller-exact-target"),
    /exact owning Intercom manager session target/,
  );
  assert.doesNotThrow(() => assertTrustedLocalBossWorkerAdoptionAllowed({ id: "ordinary-worker" }));
  assert.throws(
    () => assertTrustedLocalBossWorkerAdoptionAllowed({ id: targets[1], bossRunId }),
    /cannot be adopted by another Controller/,
  );

  for (const role of ["manager", "worker", "scout", "adversary"] as const) {
    const environment = buildTrustedLocalBossTeamEnvironment({ bossRunId, role, controllerTarget: "controller-exact-target" });
    assert.equal(environment.AGENT_INTERCOM_BOSS_RUN_ID, bossRunId);
    assert.equal(environment.AGENT_INTERCOM_BOSS_ROLE, role);
    assert.equal(environment.AGENT_INTERCOM_BOSS_CONTROLLER_TARGET, "controller-exact-target");
    assert.equal(environment.AGENT_INTERCOM_BOSS_MANAGER_TARGET, targets[0]);
    assert.deepEqual(JSON.parse(environment.AGENT_INTERCOM_BOSS_TEAM_TARGETS), targets);
    assert.equal(JSON.parse(environment.AGENT_INTERCOM_BOSS_TEAM_TARGETS).includes("controller-exact-target"), false);
    assert.equal(environment.AGENT_INTERCOM_BOSS_VISIBILITY, "team-only");
    assert.equal(environment.AGENT_INTERCOM_ORCHESTRATOR_DISABLED, "1");
    assert.deepEqual(buildTrustedLocalBossSupervisionEnvironment({ bossRunId, role, controllerTarget: "controller-exact-target" }, "/run/private-worker"), {
      PI_RALPH_STATE_ROOT: `/run/private-worker/boss-ralph/${bossRunId}/${role}`,
      PI_RETURN_ON_STATE_DIR: `/run/private-worker/boss-return-on/${bossRunId}/${role}`,
    });
    for (const harness of ["pi", "codex", "claude", "opencode"] as const) {
      const ordinary = {
        ...buildWorkerEnvironment(harness, targets[1], role, undefined, {
          runId: "worker-run-exact",
          unit: "worker-unit-exact.service",
          managerSessionId: "controller-exact-target",
        }),
        ...buildOptionalTrustedLocalBossTeamEnvironment(),
      };
      assert.equal(Object.keys(ordinary).some((key) => key.startsWith("AGENT_INTERCOM_BOSS_")), false, `${harness} ordinary worker must not receive Boss metadata`);
      const launched = { ...ordinary, ...buildOptionalTrustedLocalBossTeamEnvironment({ bossRunId, role, controllerTarget: "controller-exact-target" }) };
      assert.equal(launched.AGENT_INTERCOM_BOSS_CONTROLLER_TARGET, launched.AGENT_INTERCOM_MANAGER_TARGET, `${harness} Boss Controller target must be the adapter's exact stable manager target`);
      assert.equal(launched.AGENT_INTERCOM_ORCHESTRATOR_DISABLED, "1", `${harness} Boss ${role} must remain unable to orchestrate`);
    }
  }
});

test("Boss team target source is canonical, private, and atomically replaceable", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "boss-team-targets-"));
  const bossRunId = "boss-00000000-0000-4000-8000-123456789abc";
  const path = trustedLocalBossTeamTargetSourcePath(agentDir, bossRunId);
  const source = buildTrustedLocalBossTeamTargetSource({
    bossRunId,
    controllerTarget: "controller-exact-target",
    managerTarget: "boss-manager-123456789abc",
    targets: ["dynamic-scout-target", "boss-manager-123456789abc"],
    updatedAt: "2026-08-19T12:00:00.000Z",
  });
  await writeTrustedLocalBossTeamTargetSource(path, source);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    ...source,
    targets: ["boss-manager-123456789abc", "dynamic-scout-target"],
  });
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(buildTrustedLocalBossTeamEnvironment({ bossRunId, role: "manager", controllerTarget: "controller-exact-target", teamTargetSourcePath: path }).AGENT_INTERCOM_BOSS_TEAM_TARGET_SOURCE, path);
  assert.throws(() => buildTrustedLocalBossTeamTargetSource({ ...source, targets: [source.managerTarget, source.controllerTarget] }), /invalid or duplicate/);
  assert.throws(() => buildTrustedLocalBossTeamTargetSource({ ...source, targets: [source.managerTarget, source.managerTarget] }), /invalid or duplicate/);
});

test("Boss Ralph prompts use deterministic role loops and active bounded supervision", () => {
  const bossRunId = "boss-00000000-0000-4000-8000-123456789abc";
  const controllerTarget = "controller-exact-target";
  const goal = "ship a verified bounded change";
  const names = new Set<string>();

  for (const role of ["manager", "worker", "scout", "adversary"] as const) {
    const identity = { bossRunId, role, controllerTarget };
    const name = trustedLocalBossRalphLoopName(identity);
    const prompt = buildTrustedLocalBossParticipantPrompt(identity, goal);
    names.add(name);
    assert.equal(name, `boss-123456789abc-${role}`);
    assert.match(prompt, new RegExp(`Immediately start the isolated Ralph loop named ${name}`));
    assert.match(prompt, /itemsPerIteration=3, reflectEvery=5, maxIterations=100/);
    assert.match(prompt, /call ralph_done/);
    assert.match(prompt, /intercom_team/);
  }
  assert.equal(names.size, 4, "every role must have isolated deterministic loop state");

  const manager = buildTrustedLocalBossParticipantPrompt({ bossRunId, role: "manager", controllerTarget }, goal);
  assert.match(manager, /stable assignment token such as assignment:<slice-id>/);
  assert.match(manager, /after a second consecutive stale check, report one aggregated blocker to the Controller/);
  assert.match(manager, /Aggregate them into a concise milestone summary only when a bounded slice completes/);
  assert.match(manager, /one aggregated final evidence\/blocker handoff to the Controller/);
  assert.doesNotMatch(manager, /report a concise team summary to the Controller every iteration/);
  assert.doesNotMatch(manager, /Every iteration, send bounded progress nudges/);

  for (const role of ["worker", "scout"] as const) {
    const prompt = buildTrustedLocalBossParticipantPrompt({ bossRunId, role, controllerTarget }, goal);
    assert.match(prompt, /Acknowledge each new stable assignment token exactly once to the Manager with intercom_send/);
    assert.match(prompt, /Do not emit routine heartbeat or unchanged-progress messages/);
    assert.match(prompt, /final evidence and blockers to the Manager only/);
  }

  const adversary = buildTrustedLocalBossParticipantPrompt({ bossRunId, role: "adversary", controllerTarget }, goal);
  assert.match(adversary, /one exact-revision advisory decision to the Controller when review completes/);
  assert.doesNotMatch(adversary, /during every productive iteration/);
});

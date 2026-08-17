import assert from "node:assert/strict";
import test from "node:test";
import { assertTrustedLocalBossControllerTarget, assertTrustedLocalBossWorkerAdoptionAllowed, buildOptionalTrustedLocalBossTeamEnvironment, buildTrustedLocalBossParticipantPrompt, buildTrustedLocalBossSupervisionEnvironment, buildTrustedLocalBossTeamEnvironment, TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS, trustedLocalBossParticipantTargets, trustedLocalBossRalphLoopName } from "../src/boss-team-environment.ts";
import { buildWorkerEnvironment } from "../src/workers.ts";

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
    assert.match(prompt, /Acknowledge each new stable assignment token exactly once/);
    assert.match(prompt, /Do not emit routine heartbeat or unchanged-progress messages/);
    assert.match(prompt, /final evidence and blockers to the Manager only/);
  }

  const adversary = buildTrustedLocalBossParticipantPrompt({ bossRunId, role: "adversary", controllerTarget }, goal);
  assert.match(adversary, /one exact-revision advisory decision to the Controller when review completes/);
  assert.doesNotMatch(adversary, /during every productive iteration/);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { mergeConfig } from "../src/config.ts";
import { WorkerStore } from "../src/store.ts";
import {
  assertDelegatedFleetParameterSurface,
  assertMonotonicChildGrant,
  assertResolvedDelegatedAdmission,
  authenticateDelegatedManager,
  authenticateDelegatedManagerFromState,
  authorizeDelegatedAction,
  delegatedFleetFeatureEnabled,
  delegatedManagerIdentityFromEnvironment,
  delegatedDirectChildForRenewal,
  delegatedSubtreeForgetOrder,
  hierarchySafeTerminalPruneOrder,
  projectWorkerHierarchies,
  delegatedSubtreeStopOrder,
  delegatedSubtreeWorker,
  reserveDelegatedCascadeStop,
  delegatedSubtreeWorkers,
  reserveDelegatedChild,
} from "../src/delegated-fleet-authorization.ts";
import type { WorkerRecordV4 } from "../src/types.ts";

const execFileAsync = promisify(execFile);

const grant = {
  version: 1 as const, grantId: "grant-1", issuedAt: 1, roles: ["scout"], harnesses: ["pi" as const],
  permissionProfiles: ["delegating"], profiles: ["pi-peer"], cwdRoots: [{ path: "/repo" }],
  modelPatterns: ["anthropic/claude-*"], efforts: ["high" as const], maxLiveDirectChildren: 1,
  maxLiveDescendants: 2, maxDepth: 2, canSubdelegate: false,
};

function worker(overrides: Partial<WorkerRecordV4> = {}): WorkerRecordV4 {
  return {
    id: "manager", runId: "inc-1", workerIncarnationId: "inc-1", workerGeneration: 1,
    harness: "pi", backend: "systemd", role: "manager", task: "manage", cwd: "/repo",
    profile: "pi-peer", permissionProfile: "delegating", state: "ready", owned: true,
    managerSessionId: "controller", managerOwner: { context: "pi", principalId: "controller", sessionId: "controller", bindingEpoch: 0 },
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-root", depth: 1, grantId: "grant-1" },
    delegationGrant: grant, unit: "agent-manager.service", createdAt: 1, updatedAt: 1, leaseExpiresAt: 999,
    ...overrides,
  };
}

const identity = delegatedManagerIdentityFromEnvironment({
  AGENT_INTERCOM_WORKER_ID: "manager", AGENT_INTERCOM_RUN_ID: "inc-1",
  AGENT_INTERCOM_SYSTEMD_UNIT: "agent-manager.service", AGENT_INTERCOM_MANAGER_SESSION_ID: "controller",
  AGENT_INTERCOM_ROOT_WORKER_INCARNATION_ID: "inc-root", AGENT_INTERCOM_WORKER_DEPTH: "1",
  AGENT_INTERCOM_ACTIVE_DELEGATION_GRANT_ID: "grant-1",
});

const config = mergeConfig({ permissionProfiles: { delegating: { workspace: "read-only", git: "read-only", allowsDelegation: true } } });

test("delegated manager authentication requires exact durable live identity and permission opt-in", () => {
  assert.equal(authenticateDelegatedManager({ identity, worker: worker(), config, now: 100 }).id, "manager");
  assert.throws(() => authenticateDelegatedManager({ identity, worker: worker({ unit: "replacement.service" }), config, now: 100 }), /stale, revoked, or unauthorized/);
  assert.throws(() => authenticateDelegatedManager({ identity, worker: worker({ delegationGrant: { ...grant, expiresAt: 100 } }), config, now: 100 }), /stale, revoked, or unauthorized/);
  const denied = mergeConfig({ permissionProfiles: { delegating: { workspace: "read-only", git: "read-only" } } });
  assert.throws(() => authenticateDelegatedManager({ identity, worker: worker(), config: denied, now: 100 }), /stale, revoked, or unauthorized/);
});

test("delegated environment parsing fails closed on missing or invalid hierarchy identity", () => {
  assert.equal(delegatedManagerIdentityFromEnvironment({ AGENT_INTERCOM_WORKER_ID: "manager" }), undefined);
  assert.equal(delegatedManagerIdentityFromEnvironment({
    AGENT_INTERCOM_WORKER_ID: "manager", AGENT_INTERCOM_RUN_ID: "inc-1", AGENT_INTERCOM_SYSTEMD_UNIT: "unit",
    AGENT_INTERCOM_MANAGER_SESSION_ID: "controller", AGENT_INTERCOM_ROOT_WORKER_INCARNATION_ID: "root",
    AGENT_INTERCOM_WORKER_DEPTH: "0", AGENT_INTERCOM_ACTIVE_DELEGATION_GRANT_ID: "grant",
  }), undefined);
});

test("hierarchy projection exposes exact parent, direct children, depth, and descendant counts", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", role: "scout", delegationGrant: undefined,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  const grandchild = worker({
    id: "grandchild", runId: "inc-grandchild", workerIncarnationId: "inc-grandchild", role: "scout", delegationGrant: undefined,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "child-grant" },
  });
  const projections = projectWorkerHierarchies([manager, grandchild, child], [manager, child]);
  assert.deepEqual(projections["inc-1"], {
    workerIncarnationId: "inc-1", rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-root",
    depth: 1, directChildIds: ["child"], descendantCount: 2,
  });
  assert.deepEqual(projections["inc-child"], {
    workerIncarnationId: "inc-child", rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1",
    parentId: "manager", depth: 2, directChildIds: ["grandchild"], descendantCount: 1,
  });
});

test("delegated action policy omits global and administrative fleet authority", () => {
  authorizeDelegatedAction("spawn", {});
  authorizeDelegatedAction("status", {});
  assertDelegatedFleetParameterSurface({ action: "list", id: "child", lines: 20 });
  assert.throws(() => authorizeDelegatedAction("update", {}), /forbidden/);
  assert.throws(() => authorizeDelegatedAction("cleanup", { execute: false }), /forbidden/);
  assert.throws(() => authorizeDelegatedAction("list", { all: true }), /global scope/);
  assert.throws(() => assertDelegatedFleetParameterSurface({ action: "list", all: false }), /parameter is forbidden: all/);
  assert.throws(() => assertDelegatedFleetParameterSurface({ action: "forget", acknowledge: true }), /parameter is forbidden: acknowledge/);
});

test("delegated fleet requires explicit enablement and honors the absolute kill switch", () => {
  assert.equal(delegatedFleetFeatureEnabled({}), false);
  assert.equal(delegatedFleetFeatureEnabled({ AGENT_INTERCOM_DELEGATED_FLEET_ENABLED: "1" }), true);
  assert.equal(delegatedFleetFeatureEnabled({
    AGENT_INTERCOM_DELEGATED_FLEET_ENABLED: "1",
    AGENT_INTERCOM_DELEGATED_FLEET_DISABLED: "1",
  }), false);
});

test("resolved admission enforces allowlists, canonical cwd containment, and Git worktree identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "delegated-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  const outside = join(root, "outside");
  await mkdir(repository);
  await mkdir(outside);
  await execFileAsync("git", ["-C", repository, "init"]);
  const common = await realpath(join(repository, ".git"));
  const canonicalRepo = await realpath(repository);
  const manager = worker({ delegationGrant: { ...grant, cwdRoots: [{ path: canonicalRepo, gitCommonDir: common, gitWorktreeRoot: canonicalRepo }] } });
  const accepted = await assertResolvedDelegatedAdmission(manager, {
    role: "scout", harness: "pi", profile: "pi-peer", permissionProfile: "delegating",
    model: "anthropic/claude-sonnet", effort: "high", cwd: repository,
  });
  assert.equal(accepted.cwd, canonicalRepo);
  assert.equal(accepted.hierarchy.parentWorkerIncarnationId, "inc-1");
  await assert.rejects(assertResolvedDelegatedAdmission(manager, {
    role: "builder", harness: "pi", profile: "pi-peer", permissionProfile: "delegating",
    model: "anthropic/claude-sonnet", effort: "high", cwd: repository,
  }), /exceeds delegated authority/);
  await assert.rejects(assertResolvedDelegatedAdmission(manager, {
    role: "scout", harness: "pi", profile: "pi-peer", permissionProfile: "delegating",
    model: "anthropic/claude-sonnet", effort: "high", cwd: outside,
  }), /outside delegated workspace/);
  const alias = join(root, "alias");
  await symlink(outside, alias);
  await assert.rejects(assertResolvedDelegatedAdmission(manager, {
    role: "scout", harness: "pi", profile: "pi-peer", permissionProfile: "delegating",
    model: "anthropic/claude-sonnet", effort: "high", cwd: alias,
  }), /outside delegated workspace/);
});

test("subdelegation is a monotonic subset including model patterns, budgets, expiry, and issuer", () => {
  const parent = { ...grant, canSubdelegate: true, maxDepth: 4, expiresAt: 500, cwdRoots: [{ path: "/repo" }] };
  const child = {
    ...parent, grantId: "child-grant", issuedByWorkerIncarnationId: "inc-1", expiresAt: 400,
    modelPatterns: ["anthropic/claude-sonnet*"], maxLiveDirectChildren: 1, maxLiveDescendants: 1, maxDepth: 3,
  };
  assert.doesNotThrow(() => assertMonotonicChildGrant(parent, child, 2));
  assert.throws(() => assertMonotonicChildGrant(parent, { ...child, modelPatterns: ["anthropic/*"] }, 2), /model authority/);
  assert.throws(() => assertMonotonicChildGrant(parent, { ...child, expiresAt: undefined }, 2), /outlives/);
  assert.throws(() => assertMonotonicChildGrant(parent, { ...child, issuedByWorkerIncarnationId: undefined }, 2), /identify its issuer/);
});

test("lock-held reservation atomically enforces direct-child and descendant budgets", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", delegationGrant: undefined,
    role: "scout", model: "anthropic/claude-sonnet", effort: "high",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  const state = { version: 4 as const, generation: 1, workers: [manager], workerGenerations: [] };
  reserveDelegatedChild(state, manager, child);
  assert.equal(state.workers.length, 2);
  assert.throws(() => reserveDelegatedChild(state, manager, { ...child, id: "child-2", runId: "inc-child-2", workerIncarnationId: "inc-child-2" }), /direct-child budget/);
  assert.throws(() => reserveDelegatedChild(state, { ...manager, delegationGrant: { ...grant, grantId: "revoked" } }, child), /authority changed/);
  const narrowedState = structuredClone(state);
  narrowedState.workers[0].delegationGrant = { ...grant, roles: ["reviewer"] };
  assert.throws(() => reserveDelegatedChild(narrowedState, manager, { ...child, id: "child-3" }), /launch authority changed/);
  const expiringState = structuredClone(state);
  expiringState.workers[0].delegationGrant = { ...grant, expiresAt: 100 };
  assert.throws(() => reserveDelegatedChild(expiringState, manager, { ...child, id: "child-4" }, 100), /authority expired/);
  const stoppingState = structuredClone(state);
  stoppingState.workers[0].stateReason = "stop_in_progress";
  assert.throws(() => reserveDelegatedChild(stoppingState, manager, { ...child, id: "child-5" }), /authority changed/);

  const subdelegatingManager = worker({ delegationGrant: { ...grant, canSubdelegate: true, maxDepth: 4 } });
  const childGrant = {
    ...grant, grantId: "child-grant", issuedByWorkerIncarnationId: "inc-1", canSubdelegate: false,
    maxLiveDirectChildren: 1, maxLiveDescendants: 1, maxDepth: 2,
  };
  const delegatedChild = { ...child, delegationGrant: childGrant };
  const subdelegationState = { version: 4 as const, generation: 1, workers: [subdelegatingManager], workerGenerations: [] };
  assert.doesNotThrow(() => reserveDelegatedChild(subdelegationState, subdelegatingManager, delegatedChild));
  const narrowedSubdelegationState = {
    version: 4 as const, generation: 1,
    workers: [{ ...subdelegatingManager, delegationGrant: { ...subdelegatingManager.delegationGrant!, canSubdelegate: false } }],
    workerGenerations: [],
  };
  assert.throws(
    () => reserveDelegatedChild(narrowedSubdelegationState, subdelegatingManager, { ...delegatedChild, id: "child-grant-race" }),
    /does not permit subdelegation/,
  );
});

test("parallel WorkerStore admissions serialize budget checks with exactly one winner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "delegated-concurrency-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "workers.json");
  const firstStore = new WorkerStore(path);
  const secondStore = new WorkerStore(path);
  const manager = worker({ delegationGrant: { ...grant, grantId: "manager-grant", issuedByWorkerIncarnationId: "inc-root" } });
  const rootWorker = worker({
    id: "root", runId: "inc-root", workerIncarnationId: "inc-root", state: "stopped", delegationGrant: grant,
    hierarchy: { rootWorkerIncarnationId: "inc-root", depth: 0 },
  });
  await firstStore.mutate((state) => {
    state.workers.push(rootWorker, manager);
  });
  const child = (id: string): WorkerRecordV4 => worker({
    id, runId: `inc-${id}`, workerIncarnationId: `inc-${id}`, delegationGrant: undefined,
    role: "scout", model: "anthropic/claude-sonnet", effort: "high",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "manager-grant" },
  });
  const results = await Promise.allSettled([
    firstStore.mutate((state) => reserveDelegatedChild(state as import("../src/types.ts").WorkerStateFileV4, manager, child("child-a"))),
    secondStore.mutate((state) => reserveDelegatedChild(state as import("../src/types.ts").WorkerStateFileV4, manager, child("child-b"))),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.match(String(rejected?.reason), /direct-child budget/);
  const persisted = await firstStore.read();
  assert.equal(delegatedSubtreeWorkers(persisted.workers, manager).filter((candidate) => candidate.state === "ready").length, 1);
});

test("delegated forget requires a terminal subtree and plans deepest-first deletion", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", state: "stopped", stoppedAt: 10,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  const grandchild = worker({
    id: "grandchild", runId: "inc-grandchild", workerIncarnationId: "inc-grandchild", state: "failed", stoppedAt: 11,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "child-grant" },
  });
  assert.deepEqual(delegatedSubtreeForgetOrder([manager, child, grandchild], manager, "child").map((entry) => entry.id), ["grandchild", "child"]);
  assert.throws(() => delegatedSubtreeForgetOrder([manager, { ...child, state: "ready" }, grandchild], manager, "child"), /stop the entire subtree/);
  assert.throws(() => delegatedSubtreeForgetOrder([manager, child, { ...grandchild, state: "ready" }], manager, "child"), /stop the entire subtree/);
  assert.deepEqual(hierarchySafeTerminalPruneOrder([manager, child, grandchild], () => true).map((entry) => entry.id), ["grandchild", "child", "manager"]);
  assert.deepEqual(hierarchySafeTerminalPruneOrder([manager, child, grandchild], (entry) => entry.id !== "grandchild").map((entry) => entry.id), [], "an ineligible descendant must retain every ancestor");
  assert.deepEqual(hierarchySafeTerminalPruneOrder([manager, child, grandchild], (entry) => entry.id === "grandchild").map((entry) => entry.id), ["grandchild"], "an eligible leaf can be pruned independently");
});

test("delegated renewal is limited to one exact live direct child", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", delegationGrant: undefined,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  const grandchild = worker({
    id: "grandchild", runId: "inc-grandchild", workerIncarnationId: "inc-grandchild", delegationGrant: undefined,
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "grant-1" },
  });
  const state = { version: 4 as const, generation: 1, workers: [manager, child, grandchild], workerGenerations: [] };
  assert.equal(delegatedDirectChildForRenewal(state, manager, "child", 100), child);
  assert.throws(() => delegatedDirectChildForRenewal(state, manager, "grandchild", 100), /direct child/);
  manager.delegationGrant = { ...grant, expiresAt: 100 };
  assert.throws(() => delegatedDirectChildForRenewal(state, manager, "child", 100), /authority changed/);
  manager.delegationGrant = grant;
  child.state = "blocked";
  child.stateReason = "stop_in_progress";
  assert.throws(() => delegatedDirectChildForRenewal(state, manager, "child", 100), /cannot be renewed/);
});

test("cascade stop atomically marks the complete live subtree before shutdown", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", unit: "agent-child.service",
    delegationGrant: { ...grant, grantId: "child-grant", maxDepth: 3 },
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  const grandchild = worker({
    id: "grandchild", runId: "inc-grandchild", workerIncarnationId: "inc-grandchild", unit: "agent-grandchild.service",
    delegationGrant: undefined, role: "scout", model: "anthropic/claude-sonnet", effort: "high",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "child-grant" },
  });
  const state = { version: 4 as const, generation: 1, workers: [manager, child, grandchild], workerGenerations: [] };
  const order = reserveDelegatedCascadeStop(state, manager, "child", 200);
  assert.deepEqual(order.map((candidate) => candidate.id), ["grandchild", "child"]);
  for (const candidate of state.workers.slice(1)) {
    assert.equal(candidate.state, "blocked");
    assert.equal(candidate.stateReason, "stop_in_progress");
    assert.equal(candidate.stopRequestedAt, 200);
  }
  const lateChild = worker({
    id: "late", runId: "inc-late", workerIncarnationId: "inc-late", delegationGrant: undefined,
    role: "scout", model: "anthropic/claude-sonnet", effort: "high",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "child-grant" },
  });
  assert.throws(() => reserveDelegatedChild(state, child, lateChild), /authority changed/);
  assert.throws(() => reserveDelegatedCascadeStop(state, { ...manager, unit: "stale.service" }, "child"), /authority changed/);
});

test("parallel descendant spawn and cascade stop cannot leave a late live child", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "delegated-stop-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "workers.json");
  const spawnStore = new WorkerStore(path);
  const stopStore = new WorkerStore(path);
  const manager = worker({ delegationGrant: { ...grant, issuedByWorkerIncarnationId: "inc-root", maxLiveDirectChildren: 2, maxLiveDescendants: 3 } });
  const rootWorker = worker({
    id: "root", runId: "inc-root", workerIncarnationId: "inc-root", state: "stopped", delegationGrant: grant,
    hierarchy: { rootWorkerIncarnationId: "inc-root", depth: 0 },
  });
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child",
    delegationGrant: { ...grant, grantId: "child-grant", issuedByWorkerIncarnationId: "inc-1", maxDepth: 3 },
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2, grantId: "grant-1" },
  });
  await spawnStore.mutate((state) => { state.workers.push(rootWorker, manager, child); });
  const late = worker({
    id: "late", runId: "inc-late", workerIncarnationId: "inc-late", delegationGrant: undefined,
    role: "scout", model: "anthropic/claude-sonnet", effort: "high",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3, grantId: "child-grant" },
  });
  await Promise.allSettled([
    spawnStore.mutate((state) => reserveDelegatedChild(state as import("../src/types.ts").WorkerStateFileV4, child, late)),
    stopStore.mutate((state) => reserveDelegatedCascadeStop(state as import("../src/types.ts").WorkerStateFileV4, manager, "child", 200)),
  ]);
  const persisted = await spawnStore.read();
  const descendants = delegatedSubtreeWorkers(persisted.workers, child);
  assert.ok(descendants.length <= 1);
  assert.ok(descendants.every((candidate) => candidate.stateReason === "stop_in_progress"));
  assert.equal(persisted.workers.find((candidate) => candidate.id === "child")?.stateReason, "stop_in_progress");
});

test("state authentication selects the exact incarnation and subtree projection follows parent incarnations", () => {
  const manager = worker();
  const child = worker({
    id: "child", runId: "inc-child", workerIncarnationId: "inc-child", unit: "agent-child.service",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-1", depth: 2 },
    delegationGrant: undefined,
  });
  const grandchild = worker({
    id: "grandchild", runId: "inc-grandchild", workerIncarnationId: "inc-grandchild", unit: "agent-grandchild.service",
    hierarchy: { rootWorkerIncarnationId: "inc-root", parentWorkerIncarnationId: "inc-child", depth: 3 },
    delegationGrant: undefined,
  });
  const unrelated = worker({
    id: "unrelated", runId: "inc-other", workerIncarnationId: "inc-other", unit: "agent-other.service",
    hierarchy: { rootWorkerIncarnationId: "other-root", parentWorkerIncarnationId: "other-parent", depth: 2 },
    delegationGrant: undefined,
  });
  const state = {
    version: 4 as const, generation: 1, workers: [unrelated, grandchild, child, manager],
    workerGenerations: [manager, child, grandchild, unrelated].map((candidate) => ({ workerId: candidate.id, generation: 1 })),
  };
  assert.equal(authenticateDelegatedManagerFromState({ identity, state, config, now: 100 }), manager);
  assert.deepEqual(delegatedSubtreeWorkers(state.workers, manager).map((candidate) => candidate.id), ["child", "grandchild"]);
  assert.equal(delegatedSubtreeWorker(state.workers, manager, "grandchild"), grandchild);
  assert.deepEqual(delegatedSubtreeStopOrder(state.workers, manager, "child").map((candidate) => candidate.id), ["grandchild", "child"]);
  assert.throws(() => delegatedSubtreeStopOrder(state.workers, manager, "unrelated"), /outside.*subtree/);
  assert.throws(() => delegatedSubtreeStopOrder([...state.workers, { ...child, runId: "inc-child-2", workerIncarnationId: "inc-child-2" }], manager, "child"), /ambiguous/);
  assert.throws(() => delegatedSubtreeWorker(state.workers, manager, "unrelated"), /outside.*subtree/);
  assert.throws(() => authenticateDelegatedManagerFromState({
    identity: identity && { ...identity, workerIncarnationId: "stale" }, state, config, now: 100,
  }), /authority is unavailable/);
});

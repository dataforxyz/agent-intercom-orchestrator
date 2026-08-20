import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DelegationGrantV1, Effort, Harness, OrchestratorConfig, WorkerHierarchy, WorkerRecordV4, WorkerStateFileV4 } from "./types.ts";
import { isSafeModelPattern, modelMatchesPattern } from "./routing.ts";
import { isLiveState, isTerminalState } from "./workers.ts";

const execFileAsync = promisify(execFile);

export const DELEGATED_FLEET_ACTIONS = [
  "spawn", "route", "list", "history", "status", "stop", "logs", "renew", "forget",
  "capabilities", "profiles", "permissions", "models", "variants",
] as const;

export type DelegatedFleetAction = typeof DELEGATED_FLEET_ACTIONS[number];

const DELEGATED_ACTION_SET = new Set<string>(DELEGATED_FLEET_ACTIONS);

export const DELEGATED_FLEET_PARAMETER_KEYS = [
  "action", "id", "harness", "role", "task", "cwd", "profile", "permissionProfile",
  "model", "effort", "instructions", "subagents", "requiresSubagents", "fresh", "childGrant", "lines",
] as const;

const DELEGATED_PARAMETER_SET = new Set<string>(DELEGATED_FLEET_PARAMETER_KEYS);

export function delegatedFleetFeatureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENT_INTERCOM_DELEGATED_FLEET_ENABLED === "1"
    && environment.AGENT_INTERCOM_DELEGATED_FLEET_DISABLED !== "1";
}

export interface DelegatedManagerIdentity {
  workerId: string;
  workerIncarnationId: string;
  systemdUnit: string;
  managerSessionId: string;
  rootWorkerIncarnationId: string;
  depth: number;
  grantId: string;
}

export function delegatedManagerIdentityFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DelegatedManagerIdentity | undefined {
  const workerId = environment.AGENT_INTERCOM_WORKER_ID;
  const workerIncarnationId = environment.AGENT_INTERCOM_RUN_ID;
  const systemdUnit = environment.AGENT_INTERCOM_SYSTEMD_UNIT;
  const managerSessionId = environment.AGENT_INTERCOM_MANAGER_SESSION_ID;
  const rootWorkerIncarnationId = environment.AGENT_INTERCOM_ROOT_WORKER_INCARNATION_ID;
  const grantId = environment.AGENT_INTERCOM_ACTIVE_DELEGATION_GRANT_ID;
  const rawDepth = environment.AGENT_INTERCOM_WORKER_DEPTH;
  if (!workerId || !workerIncarnationId || !systemdUnit || !managerSessionId || !rootWorkerIncarnationId || !grantId || rawDepth === undefined) return undefined;
  const depth = Number(rawDepth);
  if (!Number.isSafeInteger(depth) || depth < 0) return undefined;
  return { workerId, workerIncarnationId, systemdUnit, managerSessionId, rootWorkerIncarnationId, depth, grantId };
}

export function authenticateDelegatedManager(input: {
  identity: DelegatedManagerIdentity | undefined;
  worker: WorkerRecordV4 | undefined;
  config: Pick<OrchestratorConfig, "permissionProfiles">;
  now?: number;
}): WorkerRecordV4 {
  const { identity, worker, config } = input;
  const now = input.now ?? Date.now();
  if (!identity || !worker) throw new Error("Delegated fleet authority is unavailable");
  const incarnation = worker.workerIncarnationId ?? worker.runId;
  const profile = worker.permissionProfile ? config.permissionProfiles[worker.permissionProfile] : undefined;
  if (!worker.owned || worker.harness !== "pi" || !isLiveState(worker.state)
    || worker.id !== identity.workerId || incarnation !== identity.workerIncarnationId
    || worker.unit !== identity.systemdUnit || worker.managerOwner.sessionId !== identity.managerSessionId
    || worker.hierarchy.rootWorkerIncarnationId !== identity.rootWorkerIncarnationId
    || worker.hierarchy.depth !== identity.depth
    || worker.delegationGrant?.grantId !== identity.grantId
    || (worker.delegationGrant.expiresAt !== undefined && worker.delegationGrant.expiresAt <= now)
    || profile?.allowsDelegation !== true) {
    throw new Error("Delegated fleet identity or grant is stale, revoked, or unauthorized");
  }
  return worker;
}

export function authorizeDelegatedAction(action: string, params: { all?: boolean; execute?: boolean }): asserts action is DelegatedFleetAction {
  if (!DELEGATED_ACTION_SET.has(action)) throw new Error(`Delegated fleet action is forbidden: ${action}`);
  if (params.all) throw new Error("Delegated fleet access cannot request global scope");
  if (action === "forget" && params.execute) throw new Error("Delegated forget does not accept global execution controls");
}

export function assertDelegatedFleetParameterSurface(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (!DELEGATED_PARAMETER_SET.has(key)) throw new Error(`Delegated fleet parameter is forbidden: ${key}`);
  }
}

export function authenticateDelegatedManagerFromState(input: {
  identity: DelegatedManagerIdentity | undefined;
  state: WorkerStateFileV4;
  config: Pick<OrchestratorConfig, "permissionProfiles">;
  now?: number;
}): WorkerRecordV4 {
  const worker = input.identity
    ? input.state.workers.find((candidate) => candidate.id === input.identity!.workerId
      && (candidate.workerIncarnationId ?? candidate.runId) === input.identity!.workerIncarnationId)
    : undefined;
  return authenticateDelegatedManager({ ...input, worker });
}

export function delegatedSubtreeWorkers(workers: WorkerRecordV4[], manager: WorkerRecordV4): WorkerRecordV4[] {
  const managerIncarnation = manager.workerIncarnationId ?? manager.runId;
  const allowedParents = new Set([managerIncarnation]);
  const descendants: WorkerRecordV4[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const worker of workers) {
      const incarnation = worker.workerIncarnationId ?? worker.runId;
      if (allowedParents.has(incarnation)) continue;
      if (worker.hierarchy.rootWorkerIncarnationId !== manager.hierarchy.rootWorkerIncarnationId) continue;
      const parent = worker.hierarchy.parentWorkerIncarnationId;
      if (!parent || !allowedParents.has(parent)) continue;
      allowedParents.add(incarnation);
      descendants.push(worker);
      changed = true;
    }
  }
  return descendants;
}

export function delegatedSubtreeWorker(workers: WorkerRecordV4[], manager: WorkerRecordV4, id: string): WorkerRecordV4 {
  const matches = delegatedSubtreeWorkers(workers, manager).filter((worker) => worker.id === id);
  if (matches.length !== 1) throw new Error(`Worker ${id} is outside the delegated manager subtree or is ambiguous`);
  return matches[0];
}

export interface WorkerHierarchyProjection {
  workerIncarnationId: string;
  rootWorkerIncarnationId: string;
  parentWorkerIncarnationId?: string;
  parentId?: string;
  depth: number;
  directChildIds: string[];
  descendantCount: number;
}

export function projectWorkerHierarchy(workers: WorkerRecordV4[], worker: WorkerRecordV4): WorkerHierarchyProjection {
  const incarnation = worker.workerIncarnationId ?? worker.runId;
  const sameRoot = workers.filter((candidate) => candidate.hierarchy.rootWorkerIncarnationId === worker.hierarchy.rootWorkerIncarnationId);
  const parent = worker.hierarchy.parentWorkerIncarnationId
    ? sameRoot.find((candidate) => (candidate.workerIncarnationId ?? candidate.runId) === worker.hierarchy.parentWorkerIncarnationId)
    : undefined;
  const directChildIds = sameRoot
    .filter((candidate) => candidate.hierarchy.parentWorkerIncarnationId === incarnation)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => candidate.id);
  return {
    workerIncarnationId: incarnation,
    rootWorkerIncarnationId: worker.hierarchy.rootWorkerIncarnationId,
    ...(worker.hierarchy.parentWorkerIncarnationId ? { parentWorkerIncarnationId: worker.hierarchy.parentWorkerIncarnationId } : {}),
    ...(parent ? { parentId: parent.id } : {}),
    depth: worker.hierarchy.depth,
    directChildIds,
    descendantCount: delegatedSubtreeWorkers(sameRoot, worker).length,
  };
}

export function projectWorkerHierarchies(workers: WorkerRecordV4[], visible: WorkerRecordV4[]): Record<string, WorkerHierarchyProjection> {
  return Object.fromEntries(visible.map((worker) => [worker.workerIncarnationId ?? worker.runId, projectWorkerHierarchy(workers, worker)]));
}

export function hierarchySafeTerminalPruneOrder(
  workers: WorkerRecordV4[],
  eligible: (worker: WorkerRecordV4) => boolean,
): WorkerRecordV4[] {
  const eligibleIncarnations = new Set(workers.filter(eligible).map((worker) => worker.workerIncarnationId ?? worker.runId));
  const retainedParentIncarnations = new Set<string>();
  for (const worker of workers) {
    if (eligibleIncarnations.has(worker.workerIncarnationId ?? worker.runId)) continue;
    let parent = worker.hierarchy.parentWorkerIncarnationId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      retainedParentIncarnations.add(parent);
      const parentWorker = workers.find((candidate) => (candidate.workerIncarnationId ?? candidate.runId) === parent);
      parent = parentWorker?.hierarchy.parentWorkerIncarnationId;
    }
  }
  return workers.filter((worker) => eligible(worker) && !retainedParentIncarnations.has(worker.workerIncarnationId ?? worker.runId))
    .sort((left, right) => right.hierarchy.depth - left.hierarchy.depth
      || left.id.localeCompare(right.id)
      || (left.workerIncarnationId ?? left.runId).localeCompare(right.workerIncarnationId ?? right.runId));
}

export function delegatedSubtreeForgetOrder(
  workers: WorkerRecordV4[],
  manager: WorkerRecordV4,
  id: string,
): WorkerRecordV4[] {
  const target = delegatedSubtreeWorker(workers, manager, id);
  const subtree = [...delegatedSubtreeWorkers(workers, target), target];
  const nonterminal = subtree.find((worker) => !isTerminalState(worker.state));
  if (nonterminal) throw new Error(`Worker ${nonterminal.id} is ${nonterminal.state}; stop the entire subtree before forgetting it`);
  return subtree.sort((left, right) => right.hierarchy.depth - left.hierarchy.depth
    || left.id.localeCompare(right.id)
    || (left.workerIncarnationId ?? left.runId).localeCompare(right.workerIncarnationId ?? right.runId));
}

export function delegatedSubtreeStopOrder(
  workers: WorkerRecordV4[],
  manager: WorkerRecordV4,
  id: string,
): WorkerRecordV4[] {
  const target = delegatedSubtreeWorker(workers, manager, id);
  const descendants = delegatedSubtreeWorkers(workers, target).filter((worker) => isLiveState(worker.state));
  descendants.sort((left, right) => right.hierarchy.depth - left.hierarchy.depth
    || left.id.localeCompare(right.id)
    || (left.workerIncarnationId ?? left.runId).localeCompare(right.workerIncarnationId ?? right.runId));
  if (!isLiveState(target.state)) throw new Error(`Worker ${id} is ${target.state}; only a live subtree can be stopped`);
  if (descendants.some((worker) => worker.hierarchy.rootWorkerIncarnationId !== target.hierarchy.rootWorkerIncarnationId)) {
    throw new Error(`Worker ${id} subtree has inconsistent root identity`);
  }
  return [...descendants, target];
}

function currentDelegatedManager(
  state: WorkerStateFileV4,
  manager: WorkerRecordV4,
  now: number,
  operation: string,
): WorkerRecordV4 {
  const current = state.workers.find((worker) =>
    worker.id === manager.id
    && (worker.workerIncarnationId ?? worker.runId) === (manager.workerIncarnationId ?? manager.runId));
  if (!current || current.unit !== manager.unit
    || current.managerOwner.sessionId !== manager.managerOwner.sessionId
    || current.hierarchy.rootWorkerIncarnationId !== manager.hierarchy.rootWorkerIncarnationId
    || current.hierarchy.depth !== manager.hierarchy.depth
    || current.delegationGrant?.grantId !== manager.delegationGrant?.grantId
    || (current.delegationGrant?.expiresAt !== undefined && current.delegationGrant.expiresAt <= now)
    || !isLiveState(current.state) || current.stateReason === "stop_in_progress") {
    throw new Error(`Delegated manager authority changed before ${operation}`);
  }
  return current;
}

export function delegatedDirectChildForRenewal(
  state: WorkerStateFileV4,
  manager: WorkerRecordV4,
  id: string,
  now = Date.now(),
): WorkerRecordV4 {
  const currentManager = currentDelegatedManager(state, manager, now, "renewal");
  const managerIncarnation = currentManager.workerIncarnationId ?? currentManager.runId;
  const matches = state.workers.filter((worker) => worker.id === id
    && worker.hierarchy.parentWorkerIncarnationId === managerIncarnation
    && worker.hierarchy.rootWorkerIncarnationId === currentManager.hierarchy.rootWorkerIncarnationId);
  if (matches.length !== 1) throw new Error(`Worker ${id} is not an unambiguous direct child of the delegated manager`);
  const child = matches[0];
  if (!child.owned || !isLiveState(child.state) || child.stateReason === "stop_in_progress") {
    throw new Error(`Worker ${id} cannot be renewed in state ${child.state}`);
  }
  return child;
}

export function reserveDelegatedCascadeStop(
  state: WorkerStateFileV4,
  manager: WorkerRecordV4,
  id: string,
  now = Date.now(),
): WorkerRecordV4[] {
  const currentManager = currentDelegatedManager(state, manager, now, "cascade stop");
  const order = delegatedSubtreeStopOrder(state.workers, currentManager, id);
  for (const worker of order) {
    worker.state = "blocked";
    worker.stateReason = "stop_in_progress";
    worker.stopReason = "delegated-manager-requested";
    worker.stopRequestedAt = now;
    worker.updatedAt = now;
  }
  return structuredClone(order);
}

export interface ResolvedDelegatedSpawn {
  role: string;
  harness: Harness;
  profile: string;
  permissionProfile: string;
  model: string;
  effort: Effort;
  cwd: string;
  childGrant?: DelegationGrantV1;
}

function containsPath(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !resolve(root, suffix).startsWith(`${resolve(root)}${sep}..${sep}`));
}

function patternIsSubset(child: string, parent: string): boolean {
  if (!isSafeModelPattern(child) || !isSafeModelPattern(parent)) return false;
  if (!child.endsWith("*")) return modelMatchesPattern(child, parent);
  if (!parent.endsWith("*")) return false;
  return child.slice(0, -1).startsWith(parent.slice(0, -1));
}

function arraySubset<T>(child: readonly T[], parent: readonly T[]): boolean {
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

export function assertDelegationGrantSubset(parent: DelegationGrantV1, child: DelegationGrantV1): void {
  if (!arraySubset(child.roles, parent.roles) || !arraySubset(child.harnesses, parent.harnesses)
    || !arraySubset(child.permissionProfiles, parent.permissionProfiles) || !arraySubset(child.profiles, parent.profiles)
    || !arraySubset(child.efforts, parent.efforts)) throw new Error("Delegation grant widens an allowlist");
  if (!child.modelPatterns.every((pattern) => parent.modelPatterns.some((allowed) => patternIsSubset(pattern, allowed)))) {
    throw new Error("Delegation grant widens model authority");
  }
  if (child.maxLiveDirectChildren > parent.maxLiveDirectChildren || child.maxLiveDescendants > parent.maxLiveDescendants
    || child.maxDepth > parent.maxDepth) throw new Error("Delegation grant widens worker budgets or depth");
  if (child.canSubdelegate && !parent.canSubdelegate) throw new Error("Delegation grant widens subdelegation authority");
  if (parent.expiresAt !== undefined && (child.expiresAt === undefined || child.expiresAt > parent.expiresAt)) {
    throw new Error("Delegation grant outlives its parent");
  }
  for (const root of child.cwdRoots) {
    const enclosing = parent.cwdRoots.find((candidate) => containsPath(candidate.path, root.path));
    if (!enclosing || (enclosing.gitCommonDir && root.gitCommonDir !== enclosing.gitCommonDir)
      || (enclosing.gitWorktreeRoot && root.gitWorktreeRoot !== enclosing.gitWorktreeRoot)) {
      throw new Error("Delegation grant widens workspace authority");
    }
  }
}

export function assertMonotonicChildGrant(parent: DelegationGrantV1, child: DelegationGrantV1, childDepth: number): void {
  if (!parent.canSubdelegate) throw new Error("Delegation grant does not permit subdelegation");
  if (child.issuedByWorkerIncarnationId === undefined) throw new Error("Child delegation grant must identify its issuer");
  if (childDepth >= parent.maxDepth) throw new Error("Child delegation depth exceeds the parent grant");
  assertDelegationGrantSubset(parent, child);
}

export async function assertResolvedDelegatedAdmission(
  manager: WorkerRecordV4,
  request: ResolvedDelegatedSpawn,
): Promise<{ cwd: string; hierarchy: WorkerHierarchy }> {
  const grant = manager.delegationGrant;
  if (!grant) throw new Error("Delegated manager grant is unavailable");
  if (!grant.roles.includes(request.role) || !grant.harnesses.includes(request.harness)
    || !grant.profiles.includes(request.profile) || !grant.permissionProfiles.includes(request.permissionProfile)
    || !grant.efforts.includes(request.effort) || !grant.modelPatterns.some((pattern) => modelMatchesPattern(request.model, pattern))) {
    throw new Error("Resolved child launch exceeds delegated authority");
  }
  const cwd = await realpath(request.cwd);
  let matched = false;
  for (const root of grant.cwdRoots) {
    const canonicalRoot = await realpath(root.path).catch(() => undefined);
    if (!canonicalRoot || !containsPath(canonicalRoot, cwd)) continue;
    if (root.gitCommonDir || root.gitWorktreeRoot) {
      const [{ stdout: commonOut }, { stdout: worktreeOut }] = await Promise.all([
        execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
        execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel"]),
      ]);
      const common = await realpath(commonOut.trim());
      const worktree = await realpath(worktreeOut.trim());
      if ((root.gitCommonDir && common !== await realpath(root.gitCommonDir))
        || (root.gitWorktreeRoot && worktree !== await realpath(root.gitWorktreeRoot))) continue;
    }
    matched = true;
    break;
  }
  if (!matched) throw new Error("Resolved child cwd is outside delegated workspace authority");
  const managerIncarnation = manager.workerIncarnationId ?? manager.runId;
  const depth = manager.hierarchy.depth + 1;
  if (depth > grant.maxDepth) throw new Error("Resolved child depth exceeds delegated authority");
  if (request.childGrant) {
    if (request.childGrant.issuedByWorkerIncarnationId !== managerIncarnation) throw new Error("Child delegation grant issuer is invalid");
    assertMonotonicChildGrant(grant, request.childGrant, depth);
  }
  return { cwd, hierarchy: { rootWorkerIncarnationId: manager.hierarchy.rootWorkerIncarnationId, parentWorkerIncarnationId: managerIncarnation, depth, grantId: grant.grantId } };
}

export function reserveDelegatedChild(
  state: WorkerStateFileV4,
  manager: WorkerRecordV4,
  child: WorkerRecordV4,
  now = Date.now(),
): void {
  const current = state.workers.find((worker) => (worker.workerIncarnationId ?? worker.runId) === (manager.workerIncarnationId ?? manager.runId));
  if (!current || current.id !== manager.id || current.unit !== manager.unit
    || current.managerOwner.sessionId !== manager.managerOwner.sessionId
    || current.hierarchy.rootWorkerIncarnationId !== manager.hierarchy.rootWorkerIncarnationId
    || current.hierarchy.depth !== manager.hierarchy.depth
    || current.delegationGrant?.grantId !== manager.delegationGrant?.grantId || !isLiveState(current.state)
    || current.stateReason === "stop_in_progress") {
    throw new Error("Delegated manager authority changed before reservation");
  }
  const grant = current.delegationGrant!;
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) throw new Error("Delegated manager authority expired before reservation");
  if (!grant.roles.includes(child.role) || !grant.harnesses.includes(child.harness)
    || !child.profile || !grant.profiles.includes(child.profile)
    || !child.permissionProfile || !grant.permissionProfiles.includes(child.permissionProfile)
    || !child.model || !grant.modelPatterns.some((pattern) => modelMatchesPattern(child.model!, pattern))
    || !child.effort || !grant.efforts.includes(child.effort)
    || !grant.cwdRoots.some((root) => containsPath(root.path, child.cwd))) {
    throw new Error("Resolved child launch authority changed before reservation");
  }
  if (state.runtimeCleanupClaims?.some((claim) => claim.workerId === child.id)) throw new Error(`Worker ${child.id} has runtime cleanup in progress`);
  const existing = state.workers.find((worker) => worker.id === child.id);
  if (existing && isLiveState(existing.state)) throw new Error(`Worker ${child.id} is already ${existing.state}`);
  const descendants = delegatedSubtreeWorkers(state.workers, current).filter((worker) => isLiveState(worker.state));
  const currentIncarnation = current.workerIncarnationId ?? current.runId;
  const direct = descendants.filter((worker) => worker.hierarchy.parentWorkerIncarnationId === currentIncarnation);
  if (direct.length >= grant.maxLiveDirectChildren) throw new Error("Delegated manager live direct-child budget is exhausted");
  if (descendants.length >= grant.maxLiveDescendants) throw new Error("Delegated manager live descendant budget is exhausted");
  if (child.hierarchy.parentWorkerIncarnationId !== currentIncarnation || child.hierarchy.grantId !== grant.grantId) {
    throw new Error("Delegated child hierarchy does not match the active grant");
  }
  if (child.delegationGrant) {
    if (child.delegationGrant.issuedByWorkerIncarnationId !== currentIncarnation) {
      throw new Error("Child delegation grant issuer changed before reservation");
    }
    assertMonotonicChildGrant(grant, child.delegationGrant, child.hierarchy.depth);
  }
  if (existing) state.workers[state.workers.indexOf(existing)] = child;
  else state.workers.push(child);
}

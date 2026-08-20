# Delegated managers

OrcBoss can give an explicitly selected **Pi** coworker a durable, restricted `agent_fleet` surface for managing a bounded subtree of Agent Intercom coworkers. Delegation is off by default. A grant is tied to one worker incarnation and is revalidated from the WorkerStore on every operation.

## Controller spawn example

```json
{
  "action": "spawn",
  "harness": "pi",
  "role": "advisor",
  "task": "Coordinate bounded review scouts",
  "cwd": "/home/alice/worktrees/app-review",
  "profile": "pi-delegated-manager",
  "permissionProfile": "delegated-manager-restricted",
  "model": "anthropic/claude-opus-4-6",
  "effort": "high",
  "delegationGrant": {
    "version": 1,
    "roles": ["scout", "reviewer"],
    "harnesses": ["pi"],
    "profiles": ["pi-peer"],
    "permissionProfiles": ["review-readonly"],
    "cwdRoots": [
      { "path": "/home/alice/worktrees/app-review" }
    ],
    "modelPatterns": [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-*"
    ],
    "efforts": ["high", "xhigh"],
    "maxLiveDirectChildren": 2,
    "maxLiveDescendants": 3,
    "maxDepth": 1,
    "canSubdelegate": false
  }
}
```

The Controller supplies policy, but OrcBoss creates the immutable `grantId` and binds `issuedByWorkerIncarnationId` to the launched incarnation. `cwdRoots` are canonicalized and retain Git identity where applicable.

### Model allowlists

Each `modelPatterns` item is either:

- an exact model identifier, such as `anthropic/claude-sonnet-4-6`; or
- one prefix with a single trailing `*`, such as `anthropic/claude-opus-*`.

Substring matching, regular expressions, interior wildcards, and multiple wildcards are rejected. OrcBoss checks the **resolved** routed model, harness, launch profile, permission profile, effort, and cwd before reserving a child.

A delegated manager can then request a child only within its grant:

```json
{
  "action": "spawn",
  "harness": "pi",
  "role": "scout",
  "task": "Audit the authorization boundary",
  "cwd": "/home/alice/worktrees/app-review",
  "profile": "pi-peer",
  "permissionProfile": "review-readonly",
  "model": "anthropic/claude-opus-4-6",
  "effort": "xhigh"
}
```

The delegated tool omits Controller-only actions such as adoption, updates, cleanup, and configuration mutation. It exposes only subtree-scoped route/spawn/list/status/logs/renew/stop/forget plus read-only capability discovery.

## Boss dynamic-growth authorization

Trusted-local Boss participants remain non-delegating unless their owning Controller issues an exact run- and revision-bound growth authorization. The typed Controller request is:

```json
{
  "action": "authorize-growth",
  "bossRunId": "boss-01234567-89ab-4cde-8fab-0123456789ab",
  "participantRole": "manager",
  "participantWorkerId": "boss-manager-0123456789ab",
  "participantWorkerIncarnationId": "worker-incarnation-exact-id",
  "expectedAcceptanceRevision": 3,
  "expectedDesignRevision": 5,
  "delegationGrant": {
    "version": 1,
    "grantId": "controller-generated-growth-grant-id",
    "issuedAt": 1730000000000,
    "issuedByWorkerIncarnationId": "worker-incarnation-exact-id",
    "roles": ["scout", "reviewer"],
    "harnesses": ["pi"],
    "profiles": ["boss-dynamic-pi"],
    "permissionProfiles": ["boss-dynamic-scout"],
    "cwdRoots": [
      { "path": "/home/alice/worktrees/boss-run" }
    ],
    "modelPatterns": ["anthropic/claude-opus-*"],
    "efforts": ["high", "xhigh"],
    "maxLiveDirectChildren": 2,
    "maxLiveDescendants": 2,
    "maxDepth": 1,
    "canSubdelegate": false
  }
}
```

Revoke with the exact active growth-grant revision:

```json
{
  "action": "revoke-growth",
  "bossRunId": "boss-01234567-89ab-4cde-8fab-0123456789ab",
  "expectedGrowthGrantRevision": 1
}
```

Authorization and revocation are Controller-only, stale revisions fail closed, new grants may only narrow prior authority, and active assignments count against both direct-child and descendant limits. Released assignments remain in the durable audit record but stop consuming capacity.

> **Current safety fence:** the durable Boss authorization, assignment, environment-binding, and revocation schemas are implemented, but real Boss participant dynamic spawning remains disabled until participant relaunch/rebind, dual-store reservation compensation, systemd launch rollback, and successful-launch target publication are composed. The APIs do not silently grant partial authority.

## Failure and lifecycle rules

- Missing, expired, revoked, foreign, stale-incarnation, or malformed grants deny mutation.
- Admission is serialized under the WorkerStore lock, so concurrent requests cannot overrun budgets.
- A parent cannot be forgotten while descendants reference it; subtree shutdown is descendant-first.
- Harness-native subagents are separate from these durable Agent Intercom coworkers and do not consume or inherit delegation authority.
- Boss team target files are Controller-owned, reread at operation boundaries, and deny all on missing, malformed, or unexpected ownership.

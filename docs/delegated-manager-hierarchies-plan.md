# Delegated manager hierarchies implementation plan

## Status and scope

This plan introduces an explicit, bounded grant that lets an ordinary **Pi** fleet worker manage durable Agent Intercom coworkers beneath itself. Existing workers, other harnesses, and Boss participants remain non-delegating unless the Controller explicitly supplies a grant. The initial rollout proves the general fleet substrate before Boss uses it.

This is trusted-local orchestration with strong fail-closed authorization and lifecycle invariants. It is not a hostile-code security boundary; the existing permission-profile caveats still apply.

## Current architecture and enforcement inventory

### Tool registration and caller identity

- `src/index.ts` registers one process-wide `agent_fleet` tool with the complete schema and action set.
- Caller ownership is currently derived from `ctx.sessionManager` by `managerSessionId(ctx)`; there is no durable relationship between the calling manager session and a worker record other than `managerOwner`/`managerSessionId` on each direct worker.
- `buildWorkerEnvironment` currently sets `AGENT_INTERCOM_ORCHESTRATOR_DISABLED=1` for **every** Pi fleet worker (`src/workers.ts`), and `src/index.ts` returns before constructing `WorkerStore` or registering any fleet tool. Boss participants add a separate `pi-peer` `--exclude-tools agent_fleet` fence.
- Hardened Pi profiles also pass explicit `--tools` allowlists from `src/permissions.ts`; none currently names a delegated fleet tool. Thus delegated registration requires three deliberate changes: an absolute kill switch for ordinary/Boss workers, a delegated-only registration mode for granted workers, and an allowlisted delegated tool name. An environment flag alone never grants authority.

### Spawn routing and reservation

- `resolveRouting` and `resolveSpawn` select role, harness, profile, permission profile, model, effort, instructions, and a path resolved relative to `ctx.cwd`.
- `spawnWorker` performs profile/systemd/runtime checks, creates the record, and calls `store.mutate(state => reserveWorkerRecord(...))` before launching the unit.
- `reserveWorkerRecord` currently prevents same-ID reuse and cleanup-claim conflicts only. It does not enforce hierarchy budgets.
- Routing occurs before reservation, so all authority-relevant resolved values must be revalidated during a single locked admission mutation. The reservation must atomically count live direct children and all live descendants and then persist the child identity/grant.

### Permissions and tool injection

- Permission profiles are configured centrally and applied to harness args, systemd properties, environment filtering, runtime roots, and workspace mounts.
- Hardened Pi workers receive explicit `--tools` allowlists. Add the delegated tool only when the Controller launches a worker with a durable grant and a permission profile whose new `allowsDelegation` flag is true.
- Introduce `AGENT_INTERCOM_ORCHESTRATOR_MODE=delegated` (or equivalent) so `src/index.ts` registers only the restricted schema after durable incarnation authentication. `AGENT_INTERCOM_ORCHESTRATOR_DISABLED=1` remains an absolute kill switch for all non-delegated workers and Boss participants until the Boss phase. Revise the assertions in `test/core.test.ts` and `test/disabled-extension.test.ts` without weakening the default fence.

### Ownership, lifecycle, cleanup, and adoption

- List/status/renew/stop/forget/adopt scope by exact `managerSessionId`; `all=true`, global cleanup, update, config, and cross-owner diagnostics are available to ordinary top-level managers.
- Stop is one worker at a time and `stopWorker` enforces exact `expectedManagerSessionId`. `session_shutdown` selects direct children only. Both must become subtree-aware or depth-two descendants are orphaned. Cleanup is global and retention-driven. Adoption rebinds a direct record and currently has no descendant semantics.
- Runtime cleanup claims and WorkerStore generation/CAS/lock behavior already provide the correct serialization boundary for hierarchy admission and lifecycle mutations.
- WorkerStore recovery authenticates live units against durable worker identity and systemd environment. Hierarchy fields must join that recovery identity without allowing old units to manufacture grants.

### Intercom topology

- Workers are launched with their manager target, but `intercom_team` lives in the separate `dataforxyz/agent-intercom-pi` repository. Its current `managerSessionId` logic shows a delegated manager its siblings, denies child-inbox access, and uses stale live-state names. Fleet ownership is not yet projected as a durable local hierarchy.
- The fleet hierarchy should be authoritative in WorkerStore. Intercom parent bindings must be reconciled from the same exact worker incarnation and never be treated as the source of fleet authority.

### Boss

- Boss runs are Controller-owned and provision fixed Manager/Worker/Scout/Adversary participants through the ordinary spawn substrate.
- Participants currently cannot call `boss` or recursively create fleet workers. Dynamic growth must remain a Controller mutation that issues or revises a run-bounded grant; participants may then use only their restricted delegated fleet surface.

## Data model

### Canonical delegation grant

Add a new canonical type, stored inline on the grantee worker record:

```ts
interface DelegationGrantV1 {
  version: 1;
  grantId: string;                  // random immutable identity
  issuedByWorkerIncarnationId?: string; // absent only for Controller-issued root grant
  issuedAt: number;
  roles: string[];                  // exact role names
  harnesses: Harness[];
  permissionProfiles: string[];     // exact configured names
  profiles: string[];               // exact launch-profile names
  cwdRoots: DelegationCwdRoot[];
  modelPatterns: string[];          // exact or one trailing '*'
  efforts: Effort[];
  maxLiveDirectChildren: number;
  maxLiveDescendants: number;
  maxDepth: number;                 // absolute depth below hierarchy root
  canSubdelegate: boolean;
  expiresAt?: number;
}

interface DelegationCwdRoot {
  path: string;                     // canonical absolute realpath
  gitCommonDir?: string;            // canonical identity when Git-backed
  gitWorktreeRoot?: string;         // exact accepted worktree root
}
```

Validation rules:

- Arrays are non-empty where necessary, unique, sorted on canonicalization, and bounded in length.
- Model entries are exact identifiers or a literal prefix followed by exactly one trailing `*`. Reject bare `*`, embedded/multiple stars, regex syntax, and control characters. An entry may be provider-qualified or an exact member/pattern of the configured routing vocabulary (`opus`, `gpt-*`, `fable*`, etc.). Reuse `isSafeModelPattern` and `modelMatchesPattern` from `src/routing.ts` so case semantics cannot diverge.
- Counts/depth are positive safe integers with configured hard implementation caps. `maxLiveDirectChildren <= maxLiveDescendants`.
- Expired grants are unusable. Grant IDs and issuer identity are immutable.
- A subgrant is a monotonic subset: roles, harnesses, permission profiles, launch profiles, and efforts are subsets; every child model pattern is covered by a parent pattern; each cwd root is contained by a parent root and has compatible Git identity; numeric budgets/depth do not exceed the parent's remaining/absolute bounds; `canSubdelegate` requires the parent capability.
- Phase 1 permits only Pi and Codex child harnesses. Claude and OpenCode remain excluded until equivalent harness-argument enforcement exists.

### Worker hierarchy identity

Extend canonical worker records with:

```ts
hierarchy?: {
  rootWorkerIncarnationId: string;
  parentWorkerIncarnationId?: string; // absent for Controller-owned top-level workers
  depth: number;                      // top-level = 0
  grantId?: string;                   // grant authorizing creation of this worker
};
delegationGrant?: DelegationGrantV1;  // authority held by this worker
```

The stable relation uses incarnation IDs, not reusable worker IDs or session display names. The manager owner binding remains the immediate controlling session and must agree with the parent worker's authenticated Intercom/session identity for delegated children.

### Store migration and feature fencing

- Introduce WorkerStore v4 rather than silently extending v3 strict-key validation. The version bump is the single downgrade fence; do **not** also add an active feature marker whose support plumbing could make the writer reject its own file.
- Migrate v1/v2/v3 workers to `hierarchy = { rootWorkerIncarnationId: workerIncarnationId, depth: 0 }` with no grant. This preserves existing behavior.
- Canonical v4 validation rejects missing parents, cycles, duplicate incarnation IDs, root/depth mismatches, grants whose issuer is inconsistent, children authorized by absent grants, and Boss hierarchy metadata inconsistent with its run.
- Because `src/store.ts` rebuilds and exact-validates records, add `hierarchy` and `delegationGrant` to the v4 stored/API key sets, explicitly parse and reattach them in `parseWorkerCommon` and `parseVersionedWorker`, and preserve them in `storedWorker`. A read → no-op mutate → read round-trip test must prove both authority fields survive exactly while unknown keys remain rejected.
- Recovery snapshots preserve the complete hierarchy. Live-unit recovery may recover identity but never synthesize a grant. A recovered unit lacking exact durable parent/root/grant identity is quarantined/degraded for hierarchy mutations.
- Add hierarchy identity (parent/root/depth/grant ID) to the systemd unit environment and recovery verifier. In `src/systemd.ts` these fields are optional for pre-upgrade units; `src/worker-registry-recovery.ts` requires/compares them only for durable delegated records. Environment values corroborate the record; they cannot create authority. A mixed pre/post-upgrade fleet must remain recoverable.

## Public API

### Controller-facing grant input

Add optional `delegationGrant` to `spawn` (and a later explicit `grant`/`revoke-grant` action if runtime revision is needed). Omission means no delegation. The Controller-facing schema accepts exact arrays and limits; canonical cwd identity is resolved internally.

A child subdelegation request uses the same field but is checked as a subset of the caller's grant. The resulting canonical grant receives a new immutable `grantId` and issuer incarnation.

### Delegated tool surface

Register a separate schema/description for an authenticated delegated Pi manager. Allowed actions:

- `spawn`, `route`
- `list`, `history`, `status`, `logs` within own subtree
- `stop`, `renew` for own subtree
- `forget` only for terminal records in own subtree, with acknowledgment
- `capabilities`, `profiles`, `permissions`, `models`, `variants` filtered to grant-eligible values

Forbidden regardless of parameters:

- `all=true`
- `doctor`, `versions`, `update`, `config`
- global `cleanup` or `prune`
- unrelated `adopt`
- Boss actions or run mutation
- grant revision/revocation beyond monotonic subgrant at spawn

The tool should omit forbidden actions from its TypeBox enum, not merely reject them at execution. Execution still re-authenticates and re-authorizes every call to prevent stale tool registration from surviving grant revocation or worker adoption.

## Authentication and authorization pipeline

1. Launcher supplies exact worker ID, incarnation ID, unit, and manager binding in the private worker environment already used for readiness/recovery.
2. On extension initialization, delegated registration reads those values and performs a WorkerStore read.
3. It requires an exact live Pi worker record, matching systemd/recovery identity, matching current Intercom/session identity, non-expired grant, and a permission profile whose new `allowsDelegation?: boolean` field is true. Add that field to `PermissionProfile`, config parsing, and defaults; it defaults false everywhere.
4. Each tool execution repeats the durable lookup and grant-expiry/revocation check.
5. Resolve routing without widening caller values.
6. Define `requestedModel` as the fully resolved model after caller/preset/default selection and immediately before `normalizeModelForHarness`; omitted caller input therefore authorizes the effective preset/default. Preserve it separately from the harness-normalized launch model.
7. Canonicalize/verify cwd and Git identity.
8. Under the WorkerStore writer lock, revalidate caller identity, parent grant, resolved child fields, subgrant monotonicity, depth, direct live count, total live descendant count, ID availability, cleanup claims, and Boss run bounds; reserve the record atomically.
9. Launch as today. Failure leaves an auditable terminal failed record and releases live-budget consumption because only live states count.

Authorization helpers should be pure and unit-tested (`modelPatternCovers`, `grantContains`, `isDescendant`, `authorizeDelegatedAction`, `canonicalizeDelegatedCwd`), while model syntax/matching reuses the exported routing helpers rather than duplicating semantics.

## Model and effort policy

- Store both `requestedModel` (the fully resolved configured authority identity, provider-qualified or configured alias) and the existing harness launch `model` if normalization strips a prefix. Authorization always uses `requestedModel`, including when the caller omitted `model`.
- Exact/trailing-star semantics and case handling reuse `src/routing.ts`'s `isSafeModelPattern` and `modelMatchesPattern`. `modelPatternCovers` must use the same canonical comparison semantics.
- Pattern subset examples: `anthropic/claude-*` covers `anthropic/claude-opus-4-8` and `anthropic/claude-opus-*`; an exact parent does not cover a wildcard child; `anthropic/*` is valid only if explicitly granted, while bare `*` is rejected.
- Efforts use explicit allowlists. A child grant's effort set must be a subset. The effective routed effort, including defaults/presets, is checked, not only the caller input.

## Workspace containment

- Reuse/generalize the proven canonical resource identity machinery in `src/boss-candidate-fingerprint.ts`: `realpath` + `resolve`, canonical `git rev-parse --show-toplevel` / `--absolute-git-dir` / `--path-format=absolute --git-common-dir`, escape rejection, and pre-use identity-drift recheck.
- For Git-backed roots, require child cwd to remain within the exact allowed worktree root and preserve the expected common-dir identity.
- Do not authorize a sibling worktree merely because it shares a Git common directory.
- For a proposed subgrant cwd root, repeat canonicalization and require containment under one parent root.
- Recheck canonical cwd immediately before launch after locked admission; if it changed, fail the reserved spawn and do not launch.

## Atomic budgets and concurrency

Add a `WorkerStore.admitDelegatedChild` mutation or equivalent single `mutate` callback. It must:

- identify the parent by exact incarnation;
- compute ancestry from canonical records and reject cycles/inconsistency;
- count live direct children and live descendants using canonical live-state semantics, including provisioning/registering;
- enforce both parent grant limits and any ancestor total-descendant ceilings;
- assign parent/root/depth/grant identity and next worker generation;
- reserve the child in the same commit.

Concurrent spawns from the same or different delegated managers serialize on the existing kernel writer lock. Tests must prove only the allowed number commits and losers fail before systemd submission.

## Lifecycle, cleanup, adoption, and revocation

- `stop(parent)` defaults to cascading post-order stop of all live descendants. Replace the direct-session stop check with `mayStop(callerSessionId, worker) = direct ownership || worker is a descendant of a root directly owned by the caller`; subtree membership is derived from durable incarnation links. A non-cascading stop is rejected while descendants are live.
- Record stop intent for the whole subtree atomically before stopping units so queued launches cannot orphan descendants.
- Cleanup selects expired parents with their descendants as a subtree and stops descendants first. `session_shutdown` expands every directly owned root to its full live subtree and stops post-order, both for a delegated parent shutdown and Controller shutdown. Retention pruning/forget refuses a parent record while any descendant record still references it.
- Grant expiry/revocation blocks new spawn immediately but does not kill children by default; Controller may request `revokeMode: "cascade-stop"`. Document this distinction.
- Ordinary delegated managers cannot adopt. Controller adoption of a parent transfers the entire subtree atomically and preserves hierarchy. Adopting only a descendant requires an explicit `transfer-subtree` operation, a new parent grant that contains the subtree's effective grants/resources, Intercom reparenting success, and rollback/fail-closed behavior. Never detach a single node and orphan its children.
- Boss-bound descendants cannot transfer outside their run, building on existing `assertTrustedLocalBossWorkerAdoptionAllowed`. Controller cancellation cascades through all dynamic descendants.
- Intercom adoption/reparenting follows the WorkerStore transaction using an explicit pending-transfer record if cross-store atomicity is unavailable. Until reconciled, both old and new managers are denied mutations except safe cascade stop.

## Cross-repository dependency: Agent Intercom

Before hierarchy projection ships, update `dataforxyz/agent-intercom-pi` (`team.ts`) to derive direct children from durable `hierarchy.parentWorkerIncarnationId`, fix its live-state vocabulary to canonical ready/working/waiting states, and authorize `resolveManagedInboxSession` for the delegated manager's direct children. This is an authority change, not only display logic. Re-pin `package.json` to the reviewed Agent Intercom revision. Slice 5 cannot ship before that dependency is available.

## Intercom and UI projection

- Extend `intercom_team` so a delegated manager sees its immediate parent and direct live children; the Controller sees its direct workers. Siblings are not exposed as managed children.
- Fleet list/status details include `parentWorkerId/incarnation`, `root`, `depth`, `directChildren`, `liveDescendants`, grant summary, expiry, and remaining budgets.
- `/agents` renders indentation/tree connectors and grant/budget badges. Default Controller views include its whole owned hierarchy; delegated views include only their subtree.
- Status counts aggregate live descendants without double-counting and clearly mark expired/revoked grants.

## Boss phased integration

After the general mechanism and tests pass:

1. Add a Controller-only Boss action to authorize dynamic growth for an exact run role and acceptance/design revision.
2. Store the canonical run grant and revision in Boss state; bind grants to `bossRunId` and allowed participant incarnation(s).
3. Controller provisions/revises the participant grant. Add a Boss-specific participant launch profile (distinct from `pi-peer`) that keeps `boss` excluded but permits only the restricted delegated fleet tool. Replace static `AGENT_INTERCOM_BOSS_TEAM_TARGETS` with a Controller-owned run-scoped target source under `<agentDir>/intercom/orchestrator/` that `dataforxyz/agent-intercom-pi` re-reads at call time; do not require participant restarts merely to discover dynamic children. The source must never appear in participant `ReadWritePaths`, must pass expected-owner checks when read, and `readBossTeamScope` must return the existing deny-all scope when it is missing, malformed, or unexpectedly owned—never fall back to the environment or unrestricted visibility. Test that a participant cannot widen its own team targets.
4. Every child inherits `bossRunId`; admission checks both the worker grant and current Boss run grant/revision. Extend `TrustedLocalBossRun` with `dynamicAssignments` keyed by worker ID, worker incarnation, grant ID, and parent incarnation. `findOrphanedWorkers` treats those entries as correlated. Dynamic IDs use a collision-safe run/parent/counter-or-random scheme rather than fixed-role `expectedWorkerId`.
5. Pause/freeze/cancel fences dynamic spawn. Cancel cascades through dynamic descendants before canonical resource cleanup.
6. Boss proof/status includes the full dynamic topology, grant revisions, and lifecycle evidence.

No Boss behavior changes when no dynamic-growth authorization exists.

## Threat model and fail-closed decisions

Threats addressed:

- A normal worker accidentally or deliberately invoking global fleet actions.
- Environment spoofing, stale sessions, reusable worker IDs, or adoption races.
- Model policy bypass through aliases, provider stripping, substring/regex confusion, routing defaults, or subgrant widening.
- Concurrent budget oversubscription.
- Cwd escape through `..`, symlinks, replaced path components, or sibling Git worktrees.
- Parent termination, cleanup, transfer, or registry recovery creating orphan descendants.
- Boss participants mutating other runs or exceeding a Controller grant.

Fail-closed rules:

- No valid durable grant means no delegated tool and no delegated mutation.
- Any identity, ancestry, grant, workspace, schema-feature, or recovery ambiguity blocks spawn/adopt/cleanup mutation; safe exact-unit subtree stop remains available to the Controller.
- Intercom topology cannot grant fleet authority.
- Permission profiles remain defense in depth, not a hostile sandbox claim.

## Migration and rollout

1. Land v4 types, validators, migration, strict record round-tripping, optional recovery identity, pure policy helpers, and tests with no tool behavior change.
2. Add Controller-issued grants and authenticated restricted registration behind an opt-in config feature flag defaulting false.
3. Add atomic admission and workspace checks.
4. Add hierarchy lifecycle and UI/Intercom projections.
5. Enable the general feature by explicit per-worker grant (global flag may become unnecessary after soak).
6. Add Controller-authorized Boss dynamic growth behind a separate Boss flag/action.
7. Publish upgrade notes: downgrade is blocked while hierarchy feature state exists; revoke/stop/flatten through the new version before downgrade. Record that `WorkerStoreOptions.supportedFeatures` remains legacy live machinery with an empty default and must not be reused for hierarchy fencing without explicitly threading support through every store constructor and testing self-read plus downgrade behavior.

## Test matrix

### Schema and migration

- v1/v2/v3 to v4 produces root depth-zero/no-grant records.
- Strict key/type/limit checks; v4 downgrade refusal; snapshot and predecessor recovery preserve hierarchy.
- Read → no-op mutate → read preserves hierarchy and grant byte-for-byte; unknown keys remain rejected.
- Missing parent, cycle, root/depth mismatch, issuer mismatch, duplicate incarnation, invalid Boss binding are rejected.

### Grant/model policy

- Exact and trailing-star positive/negative cases, provider-qualified and configured-alias preservation, routing-helper case semantics, bare/embedded star rejection.
- Every set/numeric/cwd/model subgrant subset relation, expiry, revocation, and default-routed effective field.
- Model normalization cannot bypass requested authority identity; omitted caller model checks the fully resolved preset/default.

### Authentication/action scope

- No grant, wrong incarnation, wrong session/unit/context, terminal worker, expired/revoked grant: tool absent or execution denied.
- Each allowed action succeeds only in subtree; every forbidden action/`all`/foreign ID fails.
- Stale registered tool fails after revocation/adoption.

### Workspace

- Plain directory containment, `..`, absolute escape, symlink at each component, replaced symlink race.
- Git worktree root/subdirectory accepted; sibling worktree and mismatched common-dir rejected.
- Subgrant cwd containment and prelaunch recheck.

### Admission/concurrency/recovery

- Direct, descendant, depth, ancestor-budget limits.
- Parallel processes/WorkerStore instances race at each boundary; exactly N reservations win and no rejected launch reaches systemd.
- Spawn failure frees live capacity but preserves audit record.
- Recovery with exact hierarchy succeeds; missing/mismatched identity degrades and blocks mutation; a mixed fleet containing a pre-upgrade root unit without hierarchy env and a delegated unit remains recoverable.

### Lifecycle

- Post-order cascade stop, queued-unit fence, partial stop retry, cleanup grouping, retention ordering.
- Controller shutdown leaves zero live descendants; delegated parent shutdown cascades through depth >= 2.
- Controller whole-subtree adoption and explicit transfer; rollback/pending reconciliation; no orphan paths.
- Grant revoke preserve-vs-cascade modes.

### Intercom/UI

- Exact parent/direct child projection, sibling exclusion, adoption update, tree formatting, budget counts.

### Boss

- No authorization preserves fixed behavior.
- Exact-run/revision grant, dynamic spawn bounds, freeze/pause/cancel fences, cross-run denial, proof topology.
- Dynamic child remains correlated and survives `synchronizeTrustedLocalBossWorkers` across session restart; run-scoped Intercom ACL includes it.

### Verification gates

- Focused schema/policy/admission/lifecycle tests.
- Typecheck.
- Full serial test suite.
- Concurrency stress run repeated enough to exercise writer-lock contention.
- Diff/security review and independent Opus-class review with no blocking conditions.

## Expected implementation slices

1. `types.ts` + `store.ts`: v4 schema/migration/validation, exact key/parser/storage round-trip, and hierarchy helpers.
2. New `delegation.ts`: grant canonicalization, routing-helper-backed matching, subset, ancestry, authorization, and reused cwd/Git identity validation.
3. `index.ts` + `workers.ts` + `permissions.ts` + `config.ts`: Controller grant input, `allowsDelegation`, delegated-only registration mode/tool allowlist, atomic admission, and optional launch recovery identity. Preserve the absolute default/Boss kill switches.
4. Lifecycle/cleanup/adoption subtree operations, `mayStop`, shutdown cascade, and mixed-fleet recovery verification.
5. First land/re-pin the `dataforxyz/agent-intercom-pi` hierarchy/team/inbox change; then add `/agents` hierarchy UI.
6. Boss dynamic assignments, Boss-specific delegated profile, run-scoped Intercom target source, orphan correlation, and API integration.
7. Documentation, examples, changelog, upgrade notes, exhaustive verification.

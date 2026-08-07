# `/boss` V1 — trusted-local orchestration

Status: implementation track approved by the user. Hardened protected authority is deferred to GitHub issue [#29](https://github.com/dataforxyz/agent-intercom-orchestrator/issues/29).

## Purpose

V1 delivers a useful Boss workflow using the required public trusted-local stack: Agent Intercom Pi, Agent Intercom Orchestrator, Ralph, and Return On. It is intended to help build, test, and eventually harden V2. Installation and versioned role onboarding are documented in [`boss-installation.md`](boss-installation.md).

## Threat model

V1 trusts:

- the current OS user account and user-owned filesystem;
- the installed Orchestrator and coordinated adapter packages;
- Pi, Codex, Claude Code, OpenCode, and other participating local agents;
- the local Intercom broker and same-user lifecycle services.

A same-user process may be able to inspect, alter, impersonate, interrupt, or replace V1 state and processes. Consequently, V1 evidence, reviews, approvals, and proof packets are **advisory rather than tamper-proof**.

Every V1 status/proof surface must display this warning:

> TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.

V1 must never describe itself as protected, attested, independently verified, hostile-agent-resistant, or privileged.

## Initial functionality

The current slice provides persistent direct-TUI commands and the equivalent top-level Controller `boss` tool actions:

- `/boss plan` — read-only required-stack inventory and exact setup preview
- `/boss doctor` — read-only composed live readiness report
- `/boss create <goal>`
- `/boss status [handle-or-run-id]`
- `/boss pause <handle-or-run-id> [note]`
- `/boss resume <handle-or-run-id> [note]`
- `/boss cancel <handle-or-run-id> [note]`
- `/boss proof <handle-or-run-id>` to create an explicitly advisory, revisioned proof packet
- `/boss approve <handle-or-run-id> <note>` and `/boss reject <handle-or-run-id> <note>` after an assigned adversary is bound to the latest proof revision

Only the authenticated interactive TUI can invoke the slash command. The LLM-callable tool is available only to a top-level Pi Controller and is deliberately absent from orchestration-disabled Manager, Worker, Scout, and Adversary participants. A Controller can own multiple concurrent nonterminal runs. Every persisted run receives a deterministic handle derived from its exact run ID and the configured lowercase `boss.handlePrefix`; lookup accepts either value, while mutation results and durable correlations retain the exact ID.

Before create mutates trusted-local state, it enforces the same composed readiness report exposed by `doctor`: the four required global package resources and entrypoints, a responsive systemd user manager, an active Controller Intercom identity, completed versioned onboarding with explicit model/effort choices for all four roles, live Pi model-catalog evidence when available, and writable Boss/worker/Ralph/Return On state roots. Unavailable model enumeration is an explicit warning, not fabricated proof; an enumerated catalog that omits a selected role model is blocking. Setup refuses dirty, pinned, duplicate, filtered, missing, or identity-mismatched resources rather than silently replacing them.

The LLM-callable create surface may additionally declare structured `requirements` for worktree access (`read` or `write`), edit access, tests, and Git transport (`read` or `write`). Nothing is inferred from the goal. Only explicit requirements are assessed. The check runs before run persistence and staffing and reports `verified`, `configured`, or `gap`: `/usr/bin/git` must verify exact linked-worktree identity and administrative relationships, while Worker read/write/edit remains modeled permission-policy configuration rather than a Controller-derived effective-access claim. Read-only profiles block write/edit. Custom path or systemd properties that may alter the target fail closed when unmodeled, and a nested cwd cannot establish whole-worktree writability. Project-specific tests and Git transport remain gaps when no exact probe establishes them; configured tools and Git read-only inspection are not promoted to test or transport proof. Any requested gap returns a normal `BOSS_CAPABILITY_GAP` result with `created: false`, machine-readable requested/probe/gap evidence, and no trusted-local state. Successful results use the same report shape with `created: true` and no gaps. These are create-time findings only and do not replace the runtime and communication fields exposed by status. The interactive slash grammar remains goal-only and cannot express this structured contract.

Creating a run creates durable Manager, Worker, and Scout assignment revision 1 records and launches that baseline team through the ordinary same-user `agent_fleet` worker-start path. All baseline roles currently launch as independent Pi peers because Pi implements the exact Boss team contract; their selected model identifiers may use any provider exposed by Pi. Each participant receives verified Intercom, Orchestrator, Ralph, and Return On extensions. Return On state is isolated per run and role through `PI_RETURN_ON_STATE_DIR`. Each resulting worker record is correlated with `bossRunId` and its exact WorkerStore incarnation. Successful readiness records an advisory `launch-mandate` delivery and accepted assignment result; these records describe the local launch path and are not an authenticated worker acknowledgement. Manager launch failure terminates the run without claiming successful staffing, while Worker or Scout launch failure remains visible as a failed assignment.

The first proof request creates one durable adversary assignment and launches it through the same ordinary fleet path; it does not create a reviewable packet before that worker is assigned. A transient adversary launch failure is retryable: the next proof request advances the same assignment to a new requested revision, clears its prior launch error/identity, and re-enters ordinary fleet staffing rather than dead-ending the run. After assignment, the owning TUI creates a proof revision that binds the exact Manager/adversary assignment identities, current assignment states, delivery/result state, and bounded lifecycle ledger to a SHA-256 advisory snapshot, then dispatches that exact proof ID/revision/digest through the ordinary local relay and records the relay outcome. Approval or rejection requires an explicit note, the owning Manager session, an assigned adversary worker, successful delivery of the exact latest proof, an eligible current run state, and an unchanged snapshot digest. Any intervening lifecycle, assignment, control, or run-state mutation requires a fresh proof; terminal failure cannot be overwritten by a stale decision. The resulting decision durably records the proof ID/revision, reviewer assignment/worker, deciding TUI session, outcome, and note. These records are same-user advisory evidence, not independent attestation.

Boss state consumes complete WorkerStore lifecycle snapshots at command handling, session startup, and ordinary lifecycle heartbeats. It records only state transitions, changed failure details, or new authenticated communication evidence, caps retained observations, treats a missing exact assigned incarnation as advisory `lost`, and marks an unexpectedly failed, lost, or stopped active-run participant as a failed run. Status labels WorkerStore `ready` and related lifecycle values as process/transport state, never as proof of productive work. For each exact owned assignment it exposes separate assignment-acknowledgement, authenticated-communication, and substantive-checkpoint fields. The current WorkerStore signal supplies only a dedicated authenticated inbound Intercom timestamp after sender/owner verification, so it proves communication and nothing more; acknowledgement and substantive typed checkpoint fields remain `unavailable`. General lease activity remains separate: manual `renew`, adoption, and lifecycle initialization cannot satisfy the authenticated-communication deadline. Any authenticated timestamp already present when staffing binds is retained only as a baseline; a later timestamp from that same incarnation satisfies the ten-minute communication deadline. An active assignment with no later timestamp becomes `authenticated_communication_stale`; new assignments anchor the deadline to an immutable durable worker-bind timestamp so lifecycle pruning and pause/resume controls cannot reset it. Compatible legacy records without that anchor report `deadline_unavailable` rather than inventing a mutable deadline. Intercom traffic does not prove source edits, tool calls, assignment acceptance, or substantive output.

Any live Boss-bound WorkerStore incarnation that is not represented by one exact assigned Boss record is an orphan, including a worker whose referenced Boss run record has been lost or deleted: current-process assignment bindings are fenced in memory, while restart-visible orphans are passed through a dedicated terminal-generation-safe exact owned unit-stop/absence path on every retry regardless of their cached WorkerStore lifecycle label, and are de-correlated only after that verification succeeds; repeated stop refusal preserves the Boss binding and remains error-visible without attempting to reopen a terminal worker generation. Successful containment is recorded as failed staffing when a run/role record still exists instead of ignored. A worker whose ID collides with an assigned record but whose incarnation differs is not erased as an orphan; it remains an explicit identity conflict that blocks cancellation settlement. No assignment can start after the run becomes terminal. Lifecycle history prunes only its oldest observation before any launch or synchronization write would exceed the 256-record bound, preserving late staffing liveness. This is advisory same-user observation, not an authenticated lifecycle notice or protected delivery claim.

Multiple nonterminal trusted-local runs may coexist. Run lookup is exact by deterministic handle or run ID, and mutations are restricted to the exact Controller session that created the selected run. Cancellation records a pending action, resolves every exact assigned Boss-bound worker incarnation from WorkerStore, invokes the existing owned-worker stop path using the persisted owning-session fence, and durably records aggregate success or failure. Any failed stop leaves the aggregate action failed and does not mark assignments cancelled; it can be retried idempotently. Startup/lifecycle reconciliation settles a crash-interrupted pending cancellation once every exact target is terminal or absent. Late launch completion after a terminal or assignment-binding race uses the same terminal-safe exact containment path: failed stop retains `bossRunId` and the visible containment error for later reconciliation, while only verified successful stop may remove correlation.

Pause and resume now emit best-effort ordinary Agent Intercom lifecycle notices to every exact live Boss-bound assignment. Each attempt increments that assignment revision and records a delivered/failed advisory delivery plus accepted/failed local result. Event-relay acceptance is not a typed worker acknowledgement, and a failed notice does not fabricate a worker state transition.

Every mutation is validated against the same closed persisted-state parser before atomic replacement, so command input or ledger growth cannot write state that the next read rejects. Bounded delivery/result history prunes correlated oldest pairs to reserve capacity for required exact proof delivery, and a failed proof relay retries the same current proof revision rather than accumulating undeliverable revisions. Subsequent V1 slices add reviewer report ingestion rather than TUI-recorded decisions, richer proof artifacts, completion policy, and stronger delivery/result correlation using ordinary same-user fleet facilities.

## V2 separation

The existing protected preflight, authority stores, adapter provider candidates, protected-service Rust contracts, and Revision 17–20 governance records are retained. They are not deleted or silently bypassed.

V2 activation remains independently gated by privileged service installation, protected identities, production trust roots, signed release verification, transparency/witness state, authenticated providers, canary/rollback proof, and explicit opt-in.

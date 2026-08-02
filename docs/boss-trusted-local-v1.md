# `/boss` V1 — trusted-local orchestration

Status: implementation track approved by the user. Hardened protected authority is deferred to GitHub issue [#29](https://github.com/dataforxyz/agent-intercom-orchestrator/issues/29).

## Purpose

V1 delivers a useful Boss workflow using the Agent Intercom adapters and Orchestrator already installed for the current user. It is intended to help build, test, and eventually harden V2.

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

The current slices provide persistent direct-TUI commands:

- `/boss create <goal>`
- `/boss status [run]`
- `/boss pause <run>`
- `/boss resume <run>`
- `/boss cancel <run>`
- `/boss proof <run>` to create an explicitly advisory, revisioned proof packet
- `/boss approve <run> <note>` and `/boss reject <run> <note>` after an assigned adversary is bound to the latest proof revision

Creating a run creates durable Manager, Worker, and Scout assignment revision 1 records and launches that baseline team through the ordinary same-user `agent_fleet` routing and worker-start path. Each resulting worker record is correlated with `bossRunId` and its exact WorkerStore incarnation. Successful readiness records an advisory `launch-mandate` delivery and accepted assignment result; these records describe the local launch path and are not an authenticated worker acknowledgement. Manager launch failure terminates the run without claiming successful staffing, while Worker or Scout launch failure remains visible as a failed assignment.

The first proof request creates one durable adversary assignment and launches it through the same ordinary fleet path; it does not create a reviewable packet before that worker is assigned. A transient adversary launch failure is retryable: the next proof request advances the same assignment to a new requested revision, clears its prior launch error/identity, and re-enters ordinary fleet staffing rather than dead-ending the run. After assignment, the owning TUI creates a proof revision that binds the exact Manager/adversary assignment identities, current assignment states, delivery/result state, and bounded lifecycle ledger to a SHA-256 advisory snapshot, then dispatches that exact proof ID/revision/digest through the ordinary local relay and records the relay outcome. Approval or rejection requires an explicit note, the owning Manager session, an assigned adversary worker, successful delivery of the exact latest proof, an eligible current run state, and an unchanged snapshot digest. Any intervening lifecycle, assignment, control, or run-state mutation requires a fresh proof; terminal failure cannot be overwritten by a stale decision. The resulting decision durably records the proof ID/revision, reviewer assignment/worker, deciding TUI session, outcome, and note. These records are same-user advisory evidence, not independent attestation.

Boss state consumes complete WorkerStore lifecycle snapshots at command handling, session startup, and ordinary lifecycle heartbeats. It records only state transitions or changed failure details, caps retained observations, treats a missing exact assigned incarnation as advisory `lost`, and marks an unexpectedly failed, lost, or stopped active-run participant as a failed run. Any live Boss-bound WorkerStore incarnation that is not represented by one exact assigned Boss record is an orphan, including a worker whose referenced Boss run record has been lost or deleted: current-process assignment bindings are fenced in memory, while restart-visible orphans are passed through a dedicated terminal-generation-safe exact owned unit-stop/absence path on every retry regardless of their cached WorkerStore lifecycle label, and are de-correlated only after that verification succeeds; repeated stop refusal preserves the Boss binding and remains error-visible without attempting to reopen a terminal worker generation. Successful containment is recorded as failed staffing when a run/role record still exists instead of ignored. A worker whose ID collides with an assigned record but whose incarnation differs is not erased as an orphan; it remains an explicit identity conflict that blocks cancellation settlement. No assignment can start after the run becomes terminal. Lifecycle history prunes only its oldest observation before any launch or synchronization write would exceed the 256-record bound, preserving late staffing liveness. This is advisory same-user observation, not an authenticated lifecycle notice or protected delivery claim.

Only one nonterminal trusted-local run is allowed initially. Run mutations are restricted to the direct TUI session that created the run. Cancellation records a pending action, resolves every exact assigned Boss-bound worker incarnation from WorkerStore, invokes the existing owned-worker stop path using the persisted owning-session fence, and durably records aggregate success or failure. Any failed stop leaves the aggregate action failed and does not mark assignments cancelled; it can be retried idempotently. Startup/lifecycle reconciliation settles a crash-interrupted pending cancellation once every exact target is terminal or absent. Late launch completion after a terminal or assignment-binding race uses the same terminal-safe exact containment path: failed stop retains `bossRunId` and the visible containment error for later reconciliation, while only verified successful stop may remove correlation.

Pause and resume now emit best-effort ordinary Agent Intercom lifecycle notices to every exact live Boss-bound assignment. Each attempt increments that assignment revision and records a delivered/failed advisory delivery plus accepted/failed local result. Event-relay acceptance is not a typed worker acknowledgement, and a failed notice does not fabricate a worker state transition.

Every mutation is validated against the same closed persisted-state parser before atomic replacement, so command input or ledger growth cannot write state that the next read rejects. Bounded delivery/result history prunes correlated oldest pairs to reserve capacity for required exact proof delivery, and a failed proof relay retries the same current proof revision rather than accumulating undeliverable revisions. Subsequent V1 slices add reviewer report ingestion rather than TUI-recorded decisions, richer proof artifacts, completion policy, and stronger delivery/result correlation using ordinary same-user fleet facilities.

## V2 separation

The existing protected preflight, authority stores, adapter provider candidates, protected-service Rust contracts, and Revision 17–20 governance records are retained. They are not deleted or silently bypassed.

V2 activation remains independently gated by privileged service installation, protected identities, production trust roots, signed release verification, transparency/witness state, authenticated providers, canary/rollback proof, and explicit opt-in.

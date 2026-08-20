# Changelog

## Unreleased

- Replace free-form model entry in `/agents-config` with a live per-harness model selector using the exact identifiers accepted by each harness, while retaining an explicit manual-entry escape hatch.
- Add explicit, durable, incarnation-bound delegated Pi manager grants with strict resolved model/profile/permission/cwd allowlists, atomic hierarchy budgets, subtree-scoped lifecycle operations, and fail-closed recovery.
- Add Controller-only trusted-local Boss dynamic-growth grants and released assignment audit retention, while keeping real Boss dynamic spawning fenced off until participant rebind and cross-store launch compensation are complete.
- Project delegated parent/direct-child relationships through Agent Intercom and reread Controller-owned Boss target sources at operation boundaries.

## 0.12.0 - 2026-08-18

- Reduce Boss Controller message noise with milestone-only Manager summaries, stable assignment-token acknowledgements, bounded stale retries, and role-specific final reporting.
- Allow strict-schema Boss callers to declare `gitTransport: "none"` for Controller-provisioned local-worktree runs, without claiming or probing remote Git authority.
- Add an explicit non-executed `testCommand` argv probe that verifies the configured shell, executable toolchain, and package script when applicable before admitting `tests: true`.
- Recover an accidentally emptied global worker registry from its durable predecessor snapshot only after exact live-unit identity verification, atomically refresh recovered cleanup deadlines, and enter a diagnostic read-only degraded mode when recovery evidence is missing, corrupt, transitional, or conflicting.

## 0.11.0 - 2026-08-13

- Treat a verified live WorkerStore owner PID as authoritative regardless of lock-directory age, with bounded exponential contender backoff, so long-lived owners never churn through the reclaim guard or risk live-lock recovery attempts.
- Keep high-volume WorkerStore timing telemetry opt-in behind `AGENT_INTERCOM_ORCHESTRATOR_METRICS=1` instead of writing every operation to the interactive Pi terminal by default.
- Admit worker submission while unrelated systemd user jobs remain queued below the hard 33-job cap, while continuing to fail closed on manager timeouts, command failures, malformed job output, and exact-unit readiness/fencing failures.
- Make fleet cleanup singular and bounded with a crash-released nonblocking run lock, a foreground `Type=exec` service capped at ten minutes with exact control-group killing, deferred-work reporting, and durable content-free last-run diagnostics in fleet status/doctor output.
- Reduce WorkerStore lock convoys with live-owner backoff, token-confirmed atomic release tombstones, replacement-safe failed-claim cleanup, and age-gated tombstone collection while preserving the canonical mixed-version lock protocol.

- Reduce global WorkerStore bandwidth with poison-guarded lock-free canonical reads, conditional no-op mutations, commit-linearized snapshots, and cheaper uncontended lock ownership while preserving serialized durable writers and guarded stale-lock recovery.
- Gate every typed Boss call on exact-session Orchestrator initialization, so deferred/reloaded RPC Controllers establish the Intercom event bridge before `doctor` readiness or create/mutation dispatch instead of falsely reporting the connected Controller as unregistered.
- Add an explicit absolute Boss create `sourcePath` for worktree-provisioned runs, so a stable umbrella-level Controller can select and Git-verify the intended clean source repository while Boss creates a fresh run-owned canonical worktree and never implicitly attaches the source or another existing worktree.
- Make typed Boss action dispatch ignore strict-schema placeholders that are irrelevant to `doctor`, `plan`, and status-all, rather than reconstructing interactive command arguments from every populated field; action-specific authority fields remain validated only for their owning action.
- Make the global worker registry more resilient under many concurrent Pi managers: extend bounded acquisition from 10 to 30 seconds, add randomized retry jitter to reduce synchronized contention, and include the last observed owner PID, liveness, and lock age in timeout errors.
- Prevent live-process worker and Boss state lock leaks when the short-lived mutation guard is contended: normal acquisition remains bounded, while correctness-critical owned-lock release now waits for the kernel guard instead of abandoning a lock that stale recovery cannot reclaim.
- Improve harness-toggle follow-through: disabled explicit spawns now explain the actual exclusion, `/agents-config` warns before saving no-enabled/disabled-default/disabled-role configurations, the bundled Agent Skill documents `disabledHarnesses`, and tests cover re-enabling, model browsing, spawn errors, and non-OpenCode automatic exclusion.
- Add `/agents-config` harness enable/disable controls backed by `disabledHarnesses`; disabled harnesses are removed from interactive choices and excluded from automatic routing, explicit profile/model/harness selection, model browsing, and variant lookup.
- Defer heavy orchestration startup for known-empty RPC discovery sessions, then initialize exactly once for the stable Pi session identity before the first real turn even though Pi creates fresh lifecycle context objects.
- Keep `agent_fleet status` process ownership diagnostics compact and context-safe: report bounded PID/executable summaries while omitting full command arguments, worker prompts, and multiline shell snapshots; retain the complete PID set internally for cgroup cleanup verification.
- Restore strict-schema Boss compatibility by accepting `requirements: null` as explicit absence for non-create actions, pin every Boss role to the structurally verified persistent `pi-peer` profile, report the fixed independent-Pi-peer role topology and configured role model/effort in `doctor`, clarify that native harness subagents/per-run overrides are unavailable, and expose the additive `pendingDecision` through tool details.
- Add an additive trusted-local Boss `pendingDecision` status projection with explicit owner, reason, freshness, exact assignment target, and source timestamp for persisted control gates; report ownership as unavailable rather than inferring work or productivity from process/communication evidence.
- Teach restricted read-only coworkers and managers to bypass cache-writing package runners such as `uv run` only when a trusted pinned environment already exists, using direct `.venv` entry points with explicit disclosure rather than widening permissions or misreporting runner success.
- Make browser-dependent coworker delegation honest: manager guidance and launch mandates now require separate verification of browser control, executable availability, and artifact write access; capability output discloses that visual capture is currently unmodeled; and docs describe explicit system-Chromium fallback plus manager-side capture when a read-only reviewer cannot produce screenshots.
- Add an explicit structured Boss create requirements contract for worktree read/write, edit, tests, and Git transport, with real Git-linked-worktree verification, honest verified/configured/gap evidence, fail-closed custom-profile handling, machine-readable gaps, and no inference from goal text.
- Version WorkerStore persistence as schema v3 before retaining authenticated inbound Intercom activity timestamps. Legacy v1/v2 reads migrate without promoting timestamp-shaped fields to evidence, explicit migration makes v3 durable, and newer schemas remain untouched and unquarantined behind the downgrade gate.
- Distinguish Boss participant process/transport readiness, assignment acknowledgement, authenticated communication, and substantive typed checkpoints. The exact-owned WorkerStore Intercom timestamp proves communication only; launch baselines, manual renewals, and adoption do not satisfy the bounded ten-minute communication deadline, and unavailable acknowledgement/checkpoint/source/tool telemetry remains explicit.
- Make Orc Boss onboarding preview-first and fail-closed with the packaged `agent-intercom-boss-setup` CLI, required-stack inventory for Intercom Pi, Orchestrator, Ralph, and Return On, explicit Manager/Worker/Scout/Adversary model and effort preferences, deterministic handle prefixes, atomic field-preserving config writes, and dirty/pinned/duplicate/filtered install refusal.
- Gate trusted-local Boss creation on a composed readiness report covering the required stack, responsive systemd user manager, active Controller Intercom identity, completed versioned onboarding, live Pi model-catalog evidence when available, and writable Boss/worker/Ralph/Return On state roots; expose read-only `plan` and `doctor` actions through `/boss` and the `boss` tool.
- Support concurrent trusted-local Boss runs with deterministic persisted handles accepted as aliases, inject the verified public Ralph and Return On extensions into Pi participants, and isolate Return On state per run and role.
- Correct package runtime boundaries for Pi-owned peer dependencies, keep Agent Intercom Core exact-commit-pinned and bundled, and package the setup launcher, public installation guide, updated Agent Skill, and preview-only onboarding example.
- Add an LLM-callable `boss` tool for top-level Pi Controllers, sharing the exact `/boss` lifecycle implementation and returning exact run/status data while remaining unavailable to orchestration-disabled Boss participants.
- Scope each manager's periodic lifecycle heartbeat to its attached workers, avoid no-op worker-store commits, and fast-path managers with no live workers; startup, explicit cross-manager actions, and the persistent 15-minute cleanup timer retain global reconciliation and fail-closed convergence.
- Replace the legacy `/agents` text editor with the compact graphical browser, scoped to the current Pi by default with `/agents history` and `/agents all` views; keep it aligned with the canonical worker lifecycle and render it on an opaque padded background so chat text cannot bleed through it.
- Make worker startup fail closed across systemd submission, queued activation, stable PID verification, and exact-run Intercom readiness; add durable stop fencing, late-unit reconciliation, honest unverified adapter states, user-manager backlog protection, and serialized systemd integration tests.
- Add a compact colored read-only coworker overlay with live/all views, refresh, short default summaries, and Enter-to-expand task, path, process, lifecycle, and manager details.
- Harden runtime cleanup with durable same-ID claims, fail-closed systemd/cgroup revalidation, symlink-safe contained paths, atomic quarantine and crash recovery, isolated candidate failures, and a configurable 60-minute grace period for unregistered runtimes.
- Add an explicit non-prompting `claude-trusted` launch profile for headless Claude Code work paired with the broad `trusted` permission profile, and give `claude-minimal` accurate final-response relay instructions because minimal mode intentionally removes MCP tools.
- Seed restricted `codex-minimal` workers from the dedicated `.codex-i-m` home selected by the `coim` wrapper instead of preparing an unused `.codex` directory.
- Keep the supervised and nested harness PID namespaces compatible with Bubblewrap by avoiding systemd's locked `ProtectKernelTunables` procfs submounts; the rootless user namespace, empty capabilities, no-new-privileges policy, and read-only host boundary continue to prevent host kernel-tunable writes.
- Put the supervised harness in a nested PID namespace instead of hiding the supervisor with a locked `/proc/<pid>` submount, preserving the broker-source boundary while allowing Codex and other nested Bubblewrap sandboxes to mount private procfs without `VFS: Mount too revealing` kernel warnings.
- Bound retained worker history: default `list` now shows live and recently terminal workers with an older-history count, while `history` exposes the full manager-scoped record set. Cleanup now previews and prunes retention-expired terminal workers after 7 days, extends dirty-worker retention to 30 days, removes disposable per-worker package caches on stop, deletes private runtime directories that have no worker record, and provides an acknowledged manager-scoped `prune` action for bulk deletion.
- Add capability-aware automatic harness routing for omitted-harness spawns, with pure explainable ranking, ordered spawnable-profile fallback including verified Pi runtime support, persistence mode and effort reporting, per-role capability defaults, and a non-spawning `route` preview action. Add strict-schema-safe `auto` sentinels for harness, effort, and nested-subagent constraints so generated placeholder values cannot silently become explicit overrides.
- Add typed merge-safe policy for ordered explicit-model routing, safe exact/trailing-`*` patterns, optional unmatched-model harness fallback, direct-CLI prefix stripping, config-authoritative `explicitOnly`, portable role-instruction fallback, and independently configurable Ralph/`return_on` guidance. Preserve explicit caller harness/profile/permission/instruction precedence, migrate legacy default harness/profile preferences, and keep security and lifecycle contracts unchanged.
- Update the locked Pi development dependency family from 0.80.6 to 0.82.1 as a complete dependency-tree upgrade.
- Launch workers using the manager's verified concrete Pi runtime when the built-in `pi-peer` profile is unchanged, avoiding unpinned `npx` cold bootstraps and version drift while preserving custom profile commands.
- Report that same verified manager Pi command, package version, and runtime source through `agent_fleet` `versions`, without invoking a working-directory-sensitive Pi wrapper; preserve configured commands for custom and fallback profiles.
- Replace manager-heartbeat lease extension with activity-gated renewal: only manager-received worker Intercom traffic or explicit `renew` extends a worker, and renewal is capped at the configured idle deadline.
- Request and retry checkpoints before idle expiry, preserve a grace/adoption window, and install a persistent systemd user timer that stops only exact expired owned cgroups even when no manager is running.
- Preserve stopped worker records with stop/dirty-state evidence and require explicit manager `acknowledge: true` before `forget` removes a record.
- Guide managers to use `intercom_send` for assignments and progress/status checkpoints, reserving `intercom_ask` for blocking decisions.
- Require managers to create sandboxed builder worktrees before spawn and pass the worktree as `cwd`.
- Reserve worker IDs atomically before launch, patch stop/renew/adopt/forget state inside the store lock, and reclaim dead-process locks without stale-snapshot resurrection or orphaned duplicate units.
- Reconcile service state before automatic lease renewal, retry persistent OpenCode startup on early port-bind exits, and reset failed systemd units even when stop escalation reports surviving descendants.
- Add named `review-readonly`, `builder-restricted`, and `trusted` permission profiles selectable per worker and configurable per role.
- Apply rootless systemd hardening, a read-only host filesystem with explicit assigned-workspace and per-worker harness-state write allowances, read-only Git metadata mounts, user/system D-Bus masking, PID isolation, common credential path masking, and an allowlisted launch environment to restricted workers across all harnesses.
- Mask rootful and rootless host container/VM daemon sockets and host-mutating systemd Varlink, udev, polkit, and Tailscale endpoints for restricted workers, preventing `PrivateUsers=self` supplementary-group remapping from preserving accidental host control access.
- Add private per-worker homes and harness configuration, clean-host state bootstrapping, and a supervised short-path Intercom broker proxy so restricted workers retain communication without sharing writable harness state.
- Add packaged cross-harness `git`, `gh`, GitLab `glab`, and Forgejo `tea` guards plus a Pi `tool_call` policy hook so read-only Git profiles allow explicitly recognized inspection while blocking repository and hosting-service mutations.
- Harden Git, GitHub, and Forgejo guards against host-qualified targets, command-level credential overrides, browser/debug leakage, untrusted executables, and Node preload injection; add an npm registry guard and help/version-only cloud-control guards.
- Mask SSH/GPG/password-manager agent sockets, project and home package-registry credentials, and expanded Google Cloud, Cloudflare, and Cloud Foundry configuration for restricted workers.
- Resolve Node from the controlled worker PATH in Node-backed guard launchers instead of assuming `/usr/bin/node`, preserving policy behavior on hosted and non-FHS installations.
- Isolate restricted workers from host desktop/session IPC, including Hyprland, Wayland, compositor, terminal, audio, accessibility, launcher, and speech sockets, while preserving a private XDG runtime and Intercom broker mount.
- Report permission profiles and managed-user-namespace helper readiness through `agent_fleet` discovery and doctor output.
- Propagate `fresh: true` to harness launchers so Codex workers discard persisted bridge thread state instead of reusing the prior rollout under a new systemd run.

## 0.10.0 - 2026-07-16

- Put the manager Intercom target in every worker environment and standing prompt, and direct coworkers to the read-only `intercom_team` tool.
- Add `versions` and source-aware `update` actions for the coordinated adapter family, including preview-by-default execution, dirty/pinned Git safeguards, harness CLI reporting, and doctor drift warnings.
- Stop advertising `minimal` reasoning for persistent Codex coworkers because the current app-server tool set rejects that effort before a turn can run; `low` is the lowest supported level.

## 0.9.3 - 2026-07-15

- Scope `agent_fleet` list and unqualified status results to the current manager session by default, with `all: true` for explicit cross-manager diagnostics.
- Return and document direct `intercomTarget` routing so managers can message owned workers without rediscovering them through the global Intercom list.
- Update manager guidance to the split `intercom_send`, `intercom_ask`, `intercom_list`, and `intercom_status` tools.
- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.

- Add CI for branches and pull requests.
- Make the OpenCode plugin doctor assertion portable to clean hosted runners.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-orchestrator`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.2.0 - 2026-07-14

- Changed the current project license from MIT to `AGPL-3.0-or-later`. Versions already published under MIT remain available under their original terms.

---
name: agent-intercom-orchestrator
description: Create and manage owned independent Pi, Codex, Claude Code, and OpenCode coworkers from Pi or an opt-in OpenCode manager, with capability-aware routing, model/variant selection, durable OpenCode session resume, and lifecycle cleanup through the shared agent_fleet tool. Use when the user says “orc work”, “orchestrate this”, or “use coworkers”; when delegating persistent work; when creating advisors or builder/challenger pairs; or when inspecting, configuring, or cleaning workers.
---

# Agent Intercom Orchestrator

Use `agent_fleet` instead of launching persistent harness processes directly.

## Installation

For a Pi manager, install the Intercom control plane and this package, then restart Pi or run `/reload`:

```bash
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/orcboss
```

Verify with `pi list`, then call `agent_fleet({ action: "doctor" })`. The package automatically loads both this Agent Skill and the Pi extension that provides `agent_fleet` plus `/agents*`. Linux systemd user services are required.

Orc Boss additionally requires global Pi installs of `dataforxyz/pi-extensions` with `pi-ralph-wiggum/index.ts` enabled and `dataforxyz/pi-return-on`. Use the packaged `agent-intercom-boss-setup --plan` before `--apply`; never replace a dirty or pinned install to satisfy setup. Boss onboarding requires explicit Manager, Worker, Scout, and Adversary model/effort choices and a lowercase handle prefix.

## Core rules

- Coworkers are independent Agent Intercom peers. A Pi advisor is not a child subagent.
- The manager owns creation, leases, stopping, and cleanup.
- Use unique worker ids and give each coworker an exclusive scope and explicit role.
- All harnesses start inside systemd user services so MCP servers, sidecars, browsers, and other descendants stop with the owned cgroup.
- `agent_fleet` spawn and list results include each owned worker's `intercomTarget`. For Pi, Codex, and Claude, deliver the assignment with `intercom_send`; reserve `intercom_ask` for a later question that blocks the manager's next step. Progress/status checkpoints also use `intercom_send`. Do not call `intercom_list` merely to rediscover a managed worker. Spawn verifies a cleared systemd job, stable active unit, and nonzero main PID. Pi workers created by an interactive Pi manager then complete an exact-run Intercom probe/ack; headless/OpenCode-manager Pi workers remain honestly process-stable `registering` because those managers lack the in-process control-event bridge. Built-in Codex and Claude profiles wait for their coordinated adapter's post-connect marker to write exact-run readiness health. Custom persistent profiles remain `registering` after process stability unless they adopt a compatible readiness contract. OpenCode receives its initial task at launch after its existing plugin/session handshake.
- Create feature worktrees before spawning sandboxed builders such as `codex-safe`, and pass the worktree as `cwd`. A workspace-write worker generally cannot create a sibling under `~/worktrees` when its writable root is the shared checkout.
- Every owned worker is told its manager target. Coworkers use `intercom_team({})` to get the current manager and live same-manager coworkers; this follows adoption dynamically and does not grant fleet mutation authority.
- Use `capabilities`, `profiles`, `permissions`, `models`, `variants`, `versions`, or `config` instead of guessing options, permission policy, or installed package state. OpenCode variants are model-specific.
- For UI audits or other browser-dependent assignments, explicitly plan three separate requirements: live browser automation, screenshot capture, and permission to write artifacts. The fleet capability report does not currently verify these. Probe the selected worker/profile before relying on capture, or deliberately split the work into a read-only coworker code audit and manager-side browser capture. If Playwright reports a missing bundled browser, probe `chromium`, `chromium-browser`, `google-chrome`, or `google-chrome-stable` and use an explicit `executablePath`. If no usable browser or writable artifact directory exists, report capture as unavailable; never treat source inspection as visual evidence.
- Read-only workers may find that `uv run` or another package runner fails solely because it tries to create caches or update environment metadata. If the repository already contains a trusted pinned environment and the task needs no dependency synchronization, direct the worker to its immutable entry points—for example `.venv/bin/python` or `.venv/bin/pytest`. The worker must report that it bypassed `uv`; it must not claim `uv run` passed. Never widen workspace permissions for this convenience. If the pinned environment is missing, stale, or requires writes, report verification as blocked.
- When the caller did not explicitly choose routing constraints, send `harness: "auto"`, `effort: "auto"`, and `subagents: "auto"` (or omit them when the client preserves optional fields). Automatic routing checks configured ordered profiles, executable/runtime availability, effort, and capability requirements. Never invent `pi`, `off`, or `false` placeholders; explicit caller harness/profile choices always win. Explicit models use the configured ordered model rules and unmatched-model harness. Treat `explicitOnly`, profile order, role requirements, instruction fallback, and supervision recommendations as configuration—inspect them instead of assuming the defaults.
- Preview an automatic choice with `agent_fleet({ action: "route", ... })`; the explanation lists ranking, availability, capability exclusions, and the selected profile without spawning.
- Built-in advisor, researcher, and challenger roles use `review-readonly`; builders and custom roles use `builder-restricted`. Select `trusted` only when broad host and Git authority is intentional.
- Preview update and cleanup before executing them. Never replace a detected Git install with npm, and never kill or forget sessions the orchestrator does not own.

## Discover options

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "update" }) // source-aware preview
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "profiles" })
agent_fleet({ action: "profiles", harness: "pi" })
agent_fleet({ action: "permissions" })
agent_fleet({ action: "models", harness: "pi" })
agent_fleet({ action: "models", harness: "opencode" })
agent_fleet({ action: "variants", model: "anthropic/claude-fable-5" })
agent_fleet({ action: "config" })
agent_fleet({ action: "route", role: "advisor" })
agent_fleet({ action: "route", role: "builder", requiresSubagents: true })
agent_fleet({ action: "list" }) // current manager's live and recently terminal workers
agent_fleet({ action: "history" }) // current manager's complete retained history
agent_fleet({ action: "list", all: true }) // explicit cross-manager diagnostics
```

Normalized effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `capabilities` reports the subset supported by each harness.

## Orc Boss

Use the Controller-owned `boss` tool only when the user asks to create or manage a Boss run. Do not ask the user to type `/boss`; the slash command is the direct-user alternative.

```typescript
boss({ action: "plan" }) // read-only package/setup preview
boss({ action: "doctor" }) // read-only live readiness report
boss({ action: "create", goal: "Implement and independently verify the requested change" })
boss({ action: "status" })
boss({ action: "proof", bossRunId: "<handle-or-exact-run-id>" })
boss({ action: "approve", bossRunId: "<handle-or-exact-run-id>", note: "Evidence reviewed" })
boss({ action: "cancel", bossRunId: "<handle-or-exact-run-id>", note: "Stop requested" })
```

Rules:

- **TRUSTED LOCAL MODE:** same-user agents and files are trusted; evidence is advisory, never tamper-proof or hostile-agent-resistant.
- `plan` and `doctor` are read-only. `create` fails before run-state mutation unless the required Intercom Pi, Orchestrator, Ralph, and Return On stack, host, Controller identity, onboarding, known model catalog, and writable state roots pass readiness.
- If model enumeration is unavailable, report the explicit warning; do not claim the configured models were verified. If a live catalog omits a chosen role model, treat that as blocking.
- Boss currently launches Manager, Worker, Scout, and Adversary as independent Pi peers with orchestration disabled. Their configured model identifiers may use any provider exposed by Pi. Ordinary fleet routing remains cross-harness.
- Multiple runs may coexist. Use the deterministic handle returned by status for convenience, but retain the exact `bossRunId` from mutation results for durable correlation.
- Return On is isolated per run and role. Do not point participants at a shared `PI_RETURN_ON_STATE_DIR`.
- Only the exact creating top-level Controller can inspect or mutate a run. Manager, Worker, Scout, and Adversary participants cannot call `boss` or recursively create fleet workers.
- Approval and rejection are advisory decisions bound to the latest unchanged proof revision and require explicit notes.

## Automatic routing and lifecycle

Omit `harness` and `profile` only when the routing policy should decide. Role preset harnesses remain leading preferences. `routing.profilePreferences` tries spawnable profiles in order, while a caller profile stays pinned. `requiresSubagents` uses the caller value when supplied and otherwise the per-role requirement. A configured `routing.preference` is the base order; legacy default harness/profile settings remain compatibility fallbacks. Pass an explicit harness or profile when the user has chosen one.

Every explicit model chooses a direct harness through ordered model rules. Patterns are exact or use one trailing `*`; unmatched identifiers use the configured fallback harness, and literal provider stripping occurs only after harness selection. OpenCode is always explicit-only for automatic routing; an explicit harness, profile, or matching explicit model may still select it. Harness-specific role profile/model/effort settings never cross a harness fallback. Portable role instructions cross only when configured; caller instructions always survive.

## Persistent Pi advisor

```typescript
agent_fleet({
  action: "spawn",
  harness: "pi",
  profile: "pi-peer",
  permissionProfile: "review-readonly",
  id: "architecture-advisor",
  role: "advisor",
  model: "claude/claude-opus-4-8",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Challenge the architecture plan and inspect evidence. Do not edit unless asked."
})
```

The Pi coworker has its own named Pi session, transcript, model, thinking effort, systemd cgroup, and Intercom identity. It stays idle between messages until stopped or its lease/runtime expires.

## Other harnesses

```typescript
agent_fleet({
  action: "spawn",
  requiresSubagents: true,
  permissionProfile: "builder-restricted",
  id: "codex-build-api",
  role: "builder",
  model: "gpt-5.6-sol",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Implement the approved API plan and report evidence."
})

agent_fleet({
  action: "spawn",
  harness: "claude",
  profile: "claude-safe",
  permissionProfile: "review-readonly",
  id: "claude-challenge-api",
  role: "challenger",
  model: "opus",
  effort: "max",
  cwd: "/path/to/worktree",
  task: "Find defects or missing proof in the builder's completion claim."
})

// Broad host access must be doubly explicit. This profile omits --safe so a
// headless Claude Code worker cannot stall on permission prompts.
agent_fleet({
  action: "spawn",
  harness: "claude",
  profile: "claude-trusted",
  permissionProfile: "trusted",
  id: "claude-trusted-maintenance",
  role: "builder",
  model: "opus",
  effort: "max",
  cwd: "/path/to/worktree",
  task: "Perform the explicitly trusted maintenance task and report evidence."
})

agent_fleet({
  action: "spawn",
  harness: "opencode",
  profile: "opencode-peer",
  permissionProfile: "review-readonly",
  id: "opencode-check-api",
  role: "tester",
  model: "anthropic/claude-fable-5",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Run the smoke checks and report evidence through Intercom."
})
```

Because this builder spawn uses automatic routing rather than an explicit harness, the resolver prefers an available direct Codex profile, then direct Claude. Use `action: "route"` first when the choice needs review.

Persistent OpenCode spawn waits for broker/plugin/session readiness and records the OpenCode session ID. Reusing a persistent OpenCode or Codex worker ID resumes its harness session/thread; pass `fresh: true` only when you intentionally want clean context.

## OpenCode as primary manager

Install or link the orchestrator package bin, then start exactly one primary OpenCode manager with:

```bash
OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

The OpenCode `agent_fleet` tool invokes the packaged `agent-intercom-fleet` CLI and uses the same state, ownership, leases, readiness, and systemd cleanup as Pi. Owned workers suppress recursive fleet registration by default.

## Updates and lifecycle

`versions` checks the coordinated Pi, Codex, Claude, OpenCode, and orchestrator adapter packages and reports detected harness CLI versions. `update` previews exact commands for the detected Pi/npm/Git source; `execute: true` applies only recognized safe commands and refuses dirty or pinned Git sources.

```typescript
agent_fleet({ action: "update", execute: true })
agent_fleet({ action: "status", id: "codex-build-api" }) // includes its systemd cgroup process tree
agent_fleet({ action: "logs", id: "codex-build-api", lines: 100 })
agent_fleet({ action: "renew", id: "codex-build-api" })
agent_fleet({ action: "adopt", id: "codex-build-api" }) // after an intentional manager restart
agent_fleet({ action: "stop", id: "codex-build-api" })
agent_fleet({ action: "cleanup", execute: false }) // expired live workers plus retention-expired terminal records
agent_fleet({ action: "cleanup", execute: true })
agent_fleet({ action: "prune", acknowledge: true }) // bulk-delete this manager's terminal history
agent_fleet({ action: "forget", id: "codex-build-api", acknowledge: true })
```

## Pi commands

- `/agents` — open the compact, colored, read-only coworker overlay for this Pi; Enter expands the selected worker
- `/agents history` — browse complete retained history for this manager
- `/agents all` — browse the explicit cross-manager inventory
- `/agents-new` — interactive role, harness, launch profile, permission profile, model, effort, cwd, id, and task wizard
- `/agents-config` — edit per-harness defaults, lifecycle settings, and role presets
- `/agents-models [pi|codex|claude|opencode]` — browse available models
- `/agents-cleanup [execute]` — preview or execute expired-live-worker, retained-history, and disposable-cache cleanup

Configuration is stored at `~/.pi/agent/intercom/orchestrator/config.json` unless `PI_CODING_AGENT_DIR` changes the Pi agent directory. By default, manager-received worker Intercom traffic or explicit `renew` extends a lease, but never beyond 60 minutes since the last worker activity. The manager begins checkpoint requests 10 minutes before that idle deadline and retries every 5 minutes while available; cleanup waits another 15 minutes, then stops the exact owned cgroup. A persistent systemd user timer checks every 15 minutes even when no manager is running. Default `list` output includes 6 hours of terminal history; `history` exposes all retained records. Cleanup prunes clean terminal records after 7 days and dirty records after 30 days, deletes private runtime directories that remain unregistered for 60 minutes, and successful stops discard disposable package caches while retaining harness session state. Deletion is fenced by durable cleanup claims, rejects symlinked path ancestors, atomically quarantines selected paths, and fails closed unless same-ID systemd units and cgroups are verified absent. Configure this with `recentStoppedWorkerHours`, `stoppedWorkerRetentionDays`, `dirtyStoppedWorkerRetentionDays`, `orphanRuntimeRetentionMinutes`, `pruneStoppedWorkersOnCleanup`, and `pruneRuntimeCachesOnStop`. `stop` is always allowed; `forget` and bulk `prune` require explicit `acknowledge: true`.

Routing configuration lives under `routing`: `preference` and `roles` order harnesses, `explicitOnly` controls automatic exclusions (with OpenCode always explicit-only), `profilePreferences` orders launch-profile fallback, `roleRequirements` supplies capability defaults, `modelRouting` controls model inference and normalization (including an optional unmatched-model harness), `fallback` controls portable role instructions, and `capabilities` describes actual harness support. Existing defaults, role presets, and explicit spawn fields remain supported.

## Current limitations

- Interactive-Pi-manager persistent Pi and built-in Codex/Claude profile registration is run-ID acknowledged before spawn reports `ready`. Headless/OpenCode-manager Pi workers remain process-stable `registering` until a transport-independent readiness bridge is available. Codex and Claude readiness depends on the coordinated adapter's post-connect marker; version drift that changes or omits the marker fails closed rather than returning a false success. Custom persistent Codex/Claude profiles are reported as process-stable `registering`, not falsely ready. If the first assignment delivery nevertheless fails, inspect `agent_fleet status` and `agent_fleet logs`; it is a post-readiness disconnect, not a normal startup delay. Use `intercom_list` only as a readiness diagnostic or to discover peers not managed by this fleet session. `claude-minimal` intentionally removes MCP tools, so it relays the final response to each wake and cannot send in-turn progress through `intercom_send`; select `claude-safe` when that reporting channel is required.
- A newly started manager must explicitly `adopt` live workers created by an older manager session before it can stop or renew them. Expired leases remain eligible for orchestrator-wide garbage collection.
- `opencode-peer` owns a headless OpenCode server and initialized session for wakeable follow-up turns, and retries early server bind/startup exits on a fresh port. `opencode-run` remains available for cheaper one-shot assignments.
- Manager heartbeat alone does not renew workers. Only manager-received worker Intercom traffic or explicit `renew` resets the idle budget; broker acknowledgements, process existence, and manager messages to the worker do not count. A hung or silent worker therefore reaches checkpoint, grace, and exact-unit cleanup automatically.
- Pi managers record worker activity through the Intercom extension event bridge. The opt-in OpenCode manager renews the exact worker when its runtime receives that worker's message and runs the same internal lifecycle heartbeat for checkpoint warnings.
- Model enumeration is authoritative for Pi and OpenCode. Codex and Claude discovery uses models exposed by the manager Pi plus configured defaults because their top-level CLIs do not provide an equivalent complete list.
- Permission profiles are guardrails for ordinary coding-agent mistakes, not a hostile-code container. Restricted workers retain writable private temp and isolated per-worker harness state, a restricted builder can still damage files inside its assigned workspace, and direct absolute invocation of host binaries can bypass the PATH-level `git`/`gh`/`glab`/`tea`/`npm` and cloud-control guards. Systemd's read-only host/Git mounts, private worker runtime, hidden hosting/package/cloud configuration, scrubbed inherited credentials, masked SSH/GPG/password-manager agents, masked compositor/terminal/audio/accessibility session IPC, and explicit host container/VM daemon and host-mutating systemd/polkit socket masks are defense in depth—not a claim that hostile code cannot supply another credential, use raw network egress, or reach a separately network-exposed daemon API. Provider authentication intentionally copied into a private harness home is necessarily readable by that worker, while unrelated manager environment variables and host credential paths are excluded.
- Browser and screenshot capability is not inferred from a harness or launch profile. A read-only worker may be able to inspect UI code while lacking browser MCP, a browser executable, or artifact write access. Verify all three separately before assigning visual evidence. Playwright, browsers, MCP servers, and ordinary descendants that are available remain contained and verified through the worker cgroup. Detached systemd services, containers, remote browsers, and cloud jobs require explicit manager ownership and recorded resource IDs.
- Linux systemd user services are the only process backend in this draft.

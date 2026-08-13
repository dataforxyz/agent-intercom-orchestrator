# Orc Boss

Orc Boss is the trusted-local Boss workflow and cross-harness Agent Intercom Orchestrator for independent coding agents.

Use independent coding agents to keep each other working after one of them says the task is done.

One agent builds and tries to prove the work is finished. Another agent challenges that claim, looks for what was missed, and forces another pass. Using different models and harnesses creates more possible answers and makes instant self-agreement less likely.

A manager controls the agents, evidence, limits, context resets, and stopping rule so the useful disagreement does not turn into an endless argument.

> **Status:** The orchestrator provides one `agent_fleet` lifecycle implementation for Pi and opt-in OpenCode managers, with systemd-cgroup cleanup, leases, adoption, durable OpenCode readiness/session resume, model and variant selection, diagnostics, enumeration, and interactive Pi defaults. Pi, Codex, Claude, and OpenCode can all run as persistent Intercom peers; OpenCode also has a one-shot profile.

## Install the Pi plugin

The orchestrator is a Pi package containing both the `agent_fleet` extension and its Agent Skill. It requires Linux with a working systemd user manager. For ordinary fleet use, install the Pi Intercom adapter first so managed coworkers can communicate with the manager:

```bash
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/orcboss
```

Use release tags matching the version you intend to run for Git-pinned installs; do not copy the obsolete `v0.9.3` pins from older documentation. Dirty or explicitly pinned Git installs are never replaced automatically.

Orc Boss additionally requires the public Ralph and Return On extensions. Follow the preview-first [Orc Boss installation and onboarding guide](docs/boss-installation.md), which preserves unrelated Pi settings and Orchestrator configuration.

Restart Pi, or run `/reload` in every already-open Pi session. Confirm the packages are installed:

```bash
pi list
```

Then verify the extension, coordinated adapter versions, and local harness dependencies inside Pi:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "capabilities" })
```

You should also have `/agents`, `/agents-new`, `/agents-config`, `/agents-models`, and `/agents-cleanup`. `/agents` opens a compact, colored, read-only overlay scoped to coworkers attached to the current Pi: select with the arrow keys and press Enter to expand full task, path, process, lifecycle, and manager details. `/agents history` opens retained history for this Pi, and `/agents all` opens the cross-manager inventory. Install the Codex, Claude, and OpenCode adapters before spawning those harnesses; the [worker guide](docs/creating-and-supervising-worker-agents.md#install-the-adapters) has the complete commands.

To check and update the complete adapter family without replacing Git installs with npm installs:

```typescript
agent_fleet({ action: "update" }) // preview exact source-aware commands
agent_fleet({ action: "update", execute: true }) // apply recognized safe updates
```

`versions` reports all five Agent Intercom packages plus detected Pi, Codex, Claude, and OpenCode CLI versions. For the unchanged built-in `pi-peer` profile, its Pi line identifies the verified manager runtime's exact command, package version, and `manager-runtime` source instead of invoking a working-directory-sensitive wrapper; custom and fallback profiles report their configured command with source `profile`. Dirty or pinned Git sources are reported rather than overwritten. After updating, restart affected coworkers and run `/reload` in Pi.

For a one-run checkout test without installing:

```bash
pi -e ./src/index.ts
```

Start with:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "route", role: "builder", requiresSubagents: true }) // preview only
agent_fleet({ action: "permissions" })
agent_fleet({ action: "models", harness: "pi" })
agent_fleet({ action: "list" }) // live and recently terminal workers owned by this manager
agent_fleet({ action: "history" }) // full retained history for this manager
```

## Trusted-local Boss runs

Before the first run, install and onboard the required Intercom Pi, Orchestrator, Ralph, and Return On stack. Preview setup with `agent-intercom-boss-setup --plan`, apply only after reviewing the exact changes, reload Pi, then inspect live readiness with `/boss doctor`. Setup requires explicit Manager, Worker, Scout, and Adversary model/effort choices plus a lowercase handle prefix; it preserves unrelated Pi settings and Orchestrator configuration and refuses dirty, pinned, duplicate, filtered, or identity-mismatched installs. See [Orc Boss installation](docs/boss-installation.md).

A top-level Pi Controller can create and manage concurrent logical Boss teams through the LLM-callable `boss` tool. `doctor` and `plan` are read-only. Every persisted run receives a deterministic handle such as `boss-k3m7...`; commands accept that handle or the exact run ID, while mutation results retain the exact ID. Exact-run status also projects a structured `pendingDecision` from persisted control state and explicit communication deadlines, naming the Controller or participant role that owns the next known control decision. When no typed checkpoint or blocker establishes ownership, it reports `owner: "unavailable"` instead of inferring productivity or next action from process state or authenticated traffic.

```typescript
boss({ action: "plan" })
boss({ action: "doctor" })
boss({ action: "create", goal: "Implement and verify the requested feature" })
boss({ action: "create", goal: "Implement in the assigned worktree", requirements: { worktree: "write", edit: true } })
boss({ action: "status" })
boss({ action: "status", bossRunId: "<handle-or-exact-run-id>" })
boss({ action: "pause", bossRunId: "<handle-or-exact-run-id>", note: "Hold while CI is investigated" })
boss({ action: "resume", bossRunId: "<handle-or-exact-run-id>" })
boss({ action: "proof", bossRunId: "<handle-or-exact-run-id>" })
boss({ action: "approve", bossRunId: "<handle-or-exact-run-id>", note: "Reviewed evidence is sufficient" })
boss({ action: "reject", bossRunId: "<handle-or-exact-run-id>", note: "Missing required smoke evidence" })
boss({ action: "cancel", bossRunId: "<handle-or-exact-run-id>" })
```

The interactive `/boss` command remains available for direct user control. The tool uses the calling top-level Pi session as the exact creating Controller and is absent from Manager, Worker, Scout, and Adversary participants because they launch with orchestration disabled. Only the creating Controller can inspect or mutate its runs. Boss participants currently use independent Pi peers pinned to the `pi-peer` launch profile for the exact team contract, even when mutable ordinary fleet routing prefers another Pi profile or their configured model identifiers route to different providers; ordinary `agent_fleet` continues to support Pi, Codex, Claude, and OpenCode coworkers. Boss readiness blocks if that pinned profile is missing, non-Pi, non-persistent, or non-spawnable. Boss `doctor` reports this fixed topology plus every pre-onboarded role model and effort. There are no per-run topology/model overrides and Boss is not a Codex/Claude/OpenCode harness with native subagents. Strict-schema tool clients may send `requirements: null` for non-create actions; null is explicit absence and grants no create-time capability requirement.

Tool-based create accepts an optional structured `requirements` object: `worktree` and `gitTransport` take `read` or `write`, while `edit` and `tests` are booleans. A create with a worktree requirement may also provide an explicit absolute `sourcePath`, allowing one stable Controller to select a clean source repository without changing its own cwd. Boss canonicalizes and Git-verifies that source, resolves the exact base SHA, and provisions a fresh run-owned linked worktree under the configured Boss worktree root; `sourcePath` is never treated as the participant cwd or as implicit attachment of an existing worktree. Boss never infers these requirements from free-form goal text. Requested requirements are checked after general readiness but before any run is persisted or participant is launched. The report distinguishes `verified`, `configured`, and `gap`: `/usr/bin/git` must verify canonical linked-worktree top-level, admin/common relationship, and worktree inventory; read also requires R|X on that root, while write requires the canonical assigned cwd to equal the root plus R|W|X. Worker read/write/edit access is only configured policy evidence, never Controller-access proof. A read-only Worker profile visibly blocks write/edit. Custom `inaccessiblePaths`, `writablePaths`, or `systemdProperties` that can alter the target fail closed when the preflight cannot model them, and nested-cwd configuration never establishes whole-worktree writability. Boss does not create worktrees. Project-specific tests and Git transport remain gaps unless an exact future probe establishes them; configured shell or Git read-only inspection policy alone is not test/transport proof. Any requested gap returns a normal `BOSS_CAPABILITY_GAP` result with `details.created: false`, creates no run, and exposes machine-readable `capabilityReport.requested`, `capabilityReport.probes`, and `capabilityReport.gaps` entries whose evidence explains every result. Successful requested checks return `details.created: true` and the same report shape with no gaps. Later status continues to report runtime/communication evidence and does not reinterpret create-time preflight as completed work. The interactive `/boss create` grammar remains goal-only, so use the tool when structured requirements matter.

Boss status treats `ready` as process/transport lifecycle evidence, not productive work. Detailed status exposes a ten-minute authenticated-communication deadline per exact assigned worker and marks communication stale until WorkerStore observes later authenticated inbound Intercom traffic. Manual lease renewal and adoption do not satisfy this deadline. Assignment acknowledgement, authenticated communication, and substantive typed checkpoints are separate fields: authenticated traffic proves communication only, while acknowledgement and substantive-checkpoint telemetry remain explicitly unavailable until Orc observes those typed events.

Every Boss participant receives the verified Intercom, Orchestrator, Ralph, and Return On extensions. Return On state is isolated per run and role, and Ralph/Return On state roots are checked for writability before create. Model catalog evidence is live when Pi exposes enumeration; an unavailable catalog is reported as a warning rather than fabricated as proof, while a known catalog missing a selected model blocks create.

**TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.** Team metadata provides logical trusted-local scoping, not hostile-agent-resistant authority.

Pi, Codex, Claude, and OpenCode coworkers launch in transient systemd user services with `KillMode=control-group`, a maximum runtime, an activity-bounded lease, and an owned worker record. Stopping the unit stops the harness, MCP servers, Playwright browsers, sidecars, and every descendant that remains in its cgroup; stop escalates, verifies that the cgroup is empty, and resets failed unit state even when escalation reports surviving descendants. Worker IDs are reserved atomically before launch, lifecycle actions patch the current run inside the store lock, and dead-process locks are reclaimed without stealing live mutations. Manager heartbeats no longer renew idle workers merely because their processes exist: only manager-received worker Intercom traffic or an explicit `renew` extends the lease, and renewal is capped at the configured idle deadline. The manager requests a save/commit/handoff checkpoint before that deadline, preserves a grace period for recovery or adoption, and installs a persistent systemd user cleanup timer so exact expired owned cgroups are stopped even when no manager is running. Legacy live records receive a complete idle window when first migrated. `agent_fleet({ action: "status", id: "..." })` includes lifecycle deadlines and a bounded PID/executable cgroup summary without copying full command arguments, worker prompts, or shell snapshots into manager context. Pi coworkers are independent RPC-mode Pi sessions with their own transcript, model, thinking effort, session name, and Intercom identity—not child subagents. When the built-in `pi-peer` command is unchanged, the orchestrator verifies Pi's active package entry point and launches workers with that same concrete runtime, avoiding an unpinned `npx` wrapper bootstrap and manager/worker version drift. Configure a custom Pi profile or override `pi-peer.command` when wrapper-provided environment or flags must be preserved. The persistent OpenCode profile owns a headless server plus an initialized session and retries early port-bind/startup exits on a fresh ephemeral port; `opencode-run` remains available for one-shot work.

Spawn submission is not treated as readiness. The orchestrator first verifies that the systemd start job has cleared, the exact unit remains active with a nonzero `MainPID`, and the process stays stable across a bounded interval. Persistent Pi peers created by an interactive Pi manager additionally complete an invisible Intercom probe/ack bound to the exact run ID. Headless/OpenCode managers currently lack the in-process control-event bridge, so their persistent Pi workers remain honestly process-stable `registering` rather than being falsely marked ready. Built-in persistent Codex and Claude profiles wrap the coordinated adapters and wait for their post-connect marker to produce run-ID-keyed health; a marker change or adapter exit fails closed. Custom persistent adapter profiles preserve compatibility by reporting process-stable `registering` unless they adopt a future explicit readiness contract. Persistent OpenCode peers retain their plugin/session health handshake. A durable stop intent fences the exact unit, and reconciliation stops a queued unit that materializes after the manager requested stop. `doctor` reports user-manager responsiveness and queued jobs; spawn refuses submission while that manager is unresponsive or excessively backlogged.

When `spawn` omits `harness` and `profile`—or a strict-schema client sends `harness: "auto"`—the orchestrator uses a pure, explainable routing policy over configured roles, ordered spawnable profiles, requested effort, and nested-agent capability. Advisory, research, review, and challenge work prefers Pi. Builder work and nested-subagent requirements prefer direct Codex, then direct Claude. Strict-schema clients use `effort: "auto"` and `subagents: "auto"` when those constraints were not explicitly selected, preventing generated `off`/`false` placeholders from overriding policy. A caller-supplied harness or profile always wins. Explicit models matching an ordered `routing.modelRouting.rules` entry select that direct harness; an optional `unmatchedHarness` can force all other explicit models to a chosen harness, while `null` preserves normal role routing. Provider prefixes are stripped for direct CLIs by `stripPrefixes`. Model patterns are deliberately limited to exact strings or one trailing `*` prefix wildcard. OpenCode is always explicit-only for automatic routing; an explicit harness, profile, or matching explicit model may still select it. `agent_fleet({ action: "route", ... })` previews the exact selection, profile/mode, permission profile, ranking, warnings, and exclusions without launching a worker. Role preset harnesses remain leading preferences, `routing.roleRequirements` supplies capability defaults when the caller omits them, and `routing.profilePreferences` tries named profiles in order while an explicit caller profile remains pinned. Legacy `defaultHarness` and `defaultProfiles` values seed compatibility fallbacks. Harness-specific role profile/model/effort values never leak across fallback; portable role instructions do so only when `routing.fallback.preserveRoleInstructions` is enabled, and explicit caller instructions always survive.

Built-in roles now select named permission profiles. `review-readonly` makes the host and assigned workspace read-only except for private temp and harness runtime state, limits Pi to inspection/Intercom tools, hides common credential paths, and blocks Git, GitHub, GitLab, and Forgejo mutations. `builder-restricted` makes only the assigned workspace and harness runtime state writable, mounts Git metadata read-only, and applies the same credential and remote-write guards. `trusted` preserves broad host access. Custom roles default to `builder-restricted` unless `trusted` is selected explicitly. Claude Code uses `claude-safe`/`claude-minimal` with restricted permission profiles; `claude-trusted` is the explicit non-prompting launch profile for `permissionProfile: "trusted"`, avoiding unserviceable headless permission prompts when broad authority is intentional. Minimal Claude mode deliberately has no MCP tools and relays each wake's final response instead of supporting in-turn `intercom_send`; choose `claude-safe` when progress messages are required. Hardened profiles also rebuild the worker environment from an allowlist, give each worker a private home, private `XDG_RUNTIME_DIR`, and isolated harness state, proxy Intercom through a short private broker socket, mask SSH/GPG/password-manager agents, package-manager and cloud credentials, user/system D-Bus, host-mutating systemd Varlink/polkit endpoints, host container/VM daemon control sockets, and host desktop/session IPC. The session boundary hides Hyprland, Sway/i3, Niri, Wayland, Alacritty, kitty, WezTerm, Ghostty, PipeWire/PulseAudio, accessibility, launcher, speech, and related runtime sockets while preserving the worker's private Intercom mount. PID isolation prevents workers from delegating an unsandboxed service to the host user manager or controlling Docker, Podman, containerd, BuildKit, LXD/Incus, CRI-O, libvirt, or the host compositor through Unix sockets. Nested namespaces remain available for harness sandboxes such as Codex, but inherit the outer read-only mounts and cannot recover the masked host control or desktop-session sockets. Hardened profiles require systemd 257+ and `/usr/bin/bwrap`; the supervisor uses a nested mount namespace to hide the source Intercom directory after opening the private broker proxy. The systemd filesystem restrictions and packaged `git`/`gh`/`glab`/`tea`/`npm` PATH guards apply across harnesses; restricted profiles also expose help/version-only guards for `gcloud`, Cloudflare (`wrangler`/`cloudflared`), and Cloud Foundry (`cf`). Pi rejects matching remote writes, registry-account changes, and cloud-control commands in its `tool_call` hook. These filesystem and IPC controls are not a general network firewall; restricted workers still require external policy when raw network egress or cloud metadata access must be denied.

Use `/agents-new` for an interactive spawn wizard including permission selection, `/agents-config` to set per-harness defaults, idle/checkpoint/grace timing, and role presets, and `/agents-models [harness]` to browse models. The default lifecycle is a 30-minute lease capped by a 60-minute idle budget, checkpoint requests beginning 10 minutes before the idle deadline and retrying every 5 minutes while the manager remains available, a 15-minute cleanup grace, and a managerless cleanup timer every 15 minutes. `stop` always remains available and records best-effort dirty-worktree evidence for writable workers. Disposable npm, pip, uv, and pnpm caches are removed from the retained private runtime after a successful stop without deleting harness session state; periodic cleanup also removes those caches from already-stopped legacy runtimes and deletes private runtime directories that have remained unregistered for 60 minutes. Runtime deletion fails closed when same-ID systemd units or cgroups cannot be proven absent, rejects symlinked path ancestors, and uses durable cleanup claims plus atomic quarantine renames so crashes can be recovered without racing a same-ID respawn. One unsafe candidate does not prevent independent cleanup candidates from running. Default `list` output includes live workers and terminal workers from the last 6 hours; `history` shows the complete retained manager-scoped history. Cleanup prunes clean terminal records after 7 days and dirty terminal records after 30 days. These periods, orphan retention, and cache pruning are configurable. `prune` bulk-deletes terminal records and private harness state only with `acknowledge: true`; `forget` provides the equivalent single-worker operation. Reusing a persistent Codex or OpenCode worker ID resumes its harness context; `fresh: true` discards that persisted context before launch. The Pi footer, `/agents`, and `agent_fleet({ action: "list" })` show only coworkers attached to the current manager session. Use `agent_fleet({ action: "history" })` for older records, and `/agents all` or `agent_fleet({ action: "list", all: true })` only for explicit cross-manager diagnostics. Spawn and list results include each worker's `intercomTarget`. Deliver Pi, Codex, and Claude assignments with `intercom_send`; use `intercom_ask` only when the manager's next step truly depends on a reply, never for routine progress/status checkpoints. Create sandboxed builder worktrees before spawning and pass the worktree as `cwd`. Every worker is also told its manager target and can call `intercom_team({})` to get the current manager plus live same-manager coworkers without searching globally. Team resolution reads the worker store dynamically, so adoption changes the visible manager without restarting the worker. After an intentional manager restart, `agent_fleet({ action: "adopt", id: "..." })` transfers a live owned coworker to the new manager session before stop or renew operations. `doctor` also checks adapter version drift and whether the OpenCode Intercom server plugin is visible in OpenCode's resolved configuration.

See [`examples/orchestrator-config.json`](examples/orchestrator-config.json) and the bundled Agent Skill for the current API and limitations.

## Start Here

- [I Got Tired of AI Saying It Was Done When It Wasn't](docs/why-cross-harness-orchestration.md) — how the idea started with detailed corrections, then `fix it`, and eventually literally `lol` or `:(`.
- [Orc Boss Installation and Onboarding](docs/boss-installation.md) — required stack, preview/apply setup, role preferences, diagnostics, and first-run smoke.
- [Trusted-local Boss V1](docs/boss-trusted-local-v1.md) — current behavior, evidence boundary, concurrency, handles, and proof lifecycle.
- [Creating and Supervising Worker Agents](docs/creating-and-supervising-worker-agents.md) — installation, harness restrictions, aliases, worker setup, permissions, evidence, and cleanup.
- [Example Manager Prompt](docs/example-manager-prompt.md) — a reusable prompt for a Pi manager supervising builders, challengers, and proof advisors.

## Agent Intercom Harnesses

| Harness | Repository | Current best use |
|---|---|---|
| Pi | [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) | Primary manager and proof advisor |
| OpenCode | [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode) | Primary manager with opt-in fleet tools, or persistent worker |
| Codex | [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex) | Wakeable builder through `coi` |
| Claude Code | [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude) | Wakeable challenger or worker through `cci` |

The [worker guide](docs/creating-and-supervising-worker-agents.md#install-the-adapters) contains the complete installation instructions for all four harnesses, including enabling OpenCode as the primary manager.

## Pi and OpenCode manager parity

Pi and OpenCode now use the same worker store and lifecycle implementation. Pi exposes it through the extension tool, scoped footer, and `/agents*` commands. OpenCode exposes it through an opt-in native tool that invokes the packaged `agent-intercom-fleet` CLI.

```bash
npm install -g @dataforxyz/orcboss

OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

Only the chosen primary OpenCode manager should receive `OPENCODE_INTERCOM_FLEET=1`. See [`examples/opencode-manager-env.sh`](examples/opencode-manager-env.sh) for a reusable launcher. Owned workers suppress recursive fleet creation by default. Operational parity includes spawn, readiness, persistent OpenCode session resume, list/status/logs, leases, adoption, stop/forget, cleanup, cgroup verification, model enumeration, and model-specific OpenCode variants. Pi still has richer native menus and footer presentation; OpenCode provides the same ownership operations as tools rather than copying Pi's TUI.

## The Basic Loop

1. The manager defines the task, evidence, limits, and worker ownership.
2. A builder implements the task and claims it is finished.
3. A challenger tries to prove that it is not finished.
4. The builder fixes the objection or proves it wrong.
5. The manager repeats the exchange while it is still improving the work.
6. The manager verifies the evidence and either finishes or starts another bounded assignment/review pass.

The builder saying `done` starts the review. It does not end the run.

## Origin and Thanks

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). Thank you to Nico and the original contributors for creating the foundation this work builds on.

## Releasing

Releases are automated from version tags. Before changing the version, complete the documented typecheck, focused/full tests, package-content validation, clean-install smoke, live trusted-local Boss smoke, and independent final review. Update `package.json`, the lockfile when present, and `CHANGELOG.md` together on `main`; verify `npm pack --dry-run --json` includes the bundled exact-commit Core runtime plus Boss setup/docs assets. Then push an annotated tag that exactly matches the package version:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow verifies that the tag points into `main`, runs typecheck and
tests, publishes the public npm package with trusted OIDC provenance, and creates
the GitHub Release. Existing npm versions and GitHub Releases are skipped safely
when a workflow is rerun.

## License

Agent Intercom Orchestrator is licensed under the [GNU Affero General Public
License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). If you modify this
software and make the modified version available to users over a network, the
AGPL requires you to offer those users the corresponding source code. Versions
already published under MIT remain available under their original terms. See
[LICENSE_TRANSITION.md](LICENSE_TRANSITION.md) for the exact commit and tag boundary.

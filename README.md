# Agent Intercom Orchestrator

Use independent coding agents to keep each other working after one of them says the task is done.

One agent builds and tries to prove the work is finished. Another agent challenges that claim, looks for what was missed, and forces another pass. Using different models and harnesses creates more possible answers and makes instant self-agreement less likely.

A manager controls the agents, evidence, limits, context resets, and stopping rule so the useful disagreement does not turn into an endless argument.

> **Status:** The orchestrator provides one `agent_fleet` lifecycle implementation for Pi and opt-in OpenCode managers, with systemd-cgroup cleanup, leases, adoption, durable OpenCode readiness/session resume, model and variant selection, diagnostics, enumeration, and interactive Pi defaults. Pi, Codex, Claude, and OpenCode can all run as persistent Intercom peers; OpenCode also has a one-shot profile.

## Install the Pi plugin

The orchestrator is a Pi package containing both the `agent_fleet` extension and its Agent Skill. It requires Linux with a working systemd user manager. Install the Pi Intercom adapter first so managed coworkers can communicate with the manager:

```bash
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/agent-intercom-orchestrator
```

For Git-pinned installs, use `git:github.com/dataforxyz/agent-intercom-pi@v0.9.3` and `git:github.com/dataforxyz/agent-intercom-orchestrator@v0.9.3` instead.

Restart Pi, or run `/reload` in every already-open Pi session. Confirm both packages are installed:

```bash
pi list
```

Then verify the extension, coordinated adapter versions, and local harness dependencies inside Pi:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "capabilities" })
```

You should also have `/agents`, `/agents-new`, `/agents-config`, `/agents-models`, and `/agents-cleanup`. Install the Codex, Claude, and OpenCode adapters before spawning those harnesses; the [worker guide](docs/creating-and-supervising-worker-agents.md#install-the-adapters) has the complete commands.

To check and update the complete adapter family without replacing Git installs with npm installs:

```typescript
agent_fleet({ action: "update" }) // preview exact source-aware commands
agent_fleet({ action: "update", execute: true }) // apply recognized safe updates
```

`versions` reports all five Agent Intercom packages plus detected Pi, Codex, Claude, and OpenCode CLI versions. Dirty or pinned Git sources are reported rather than overwritten. After updating, restart affected coworkers and run `/reload` in Pi.

For a one-run checkout test without installing:

```bash
pi -e ./src/index.ts
```

Start with:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "permissions" })
agent_fleet({ action: "models", harness: "pi" })
agent_fleet({ action: "list" }) // workers owned by this manager, including Intercom targets
```

Pi, Codex, Claude, and OpenCode coworkers launch in transient systemd user services with `KillMode=control-group`, a maximum runtime, an activity-bounded lease, and an owned worker record. Stopping the unit stops the harness, MCP servers, Playwright browsers, sidecars, and every descendant that remains in its cgroup; stop escalates, verifies that the cgroup is empty, and resets failed unit state even when escalation reports surviving descendants. Worker IDs are reserved atomically before launch, lifecycle actions patch the current run inside the store lock, and dead-process locks are reclaimed without stealing live mutations. Manager heartbeats no longer renew idle workers merely because their processes exist: only manager-received worker Intercom traffic or an explicit `renew` extends the lease, and renewal is capped at the configured idle deadline. The manager requests a save/commit/handoff checkpoint before that deadline, preserves a grace period for recovery or adoption, and installs a persistent systemd user cleanup timer that operates across manager ownership. The timer stops exact expired owned cgroups, prunes disposable caches from terminal workers after 60 minutes, removes full terminal private runtimes and records after 7 days, and removes unregistered runtime directories unchanged for 60 minutes. Terminal records and primary harness state remain resumable until the full-retention cutoff. Runtime deletion uses a durable phased claim, verifies exact and same-ID unit/cgroup absence outside the global lock, persists the contained path mapping, atomically renames those paths into a private quarantine under a second short lock, then performs slow recursive deletion after releasing it. The claim remains until deletion completes, so same-ID respawn stays fenced without blocking other managers or heartbeats. After a crash, an interrupted move is rolled back while a committed move resumes deletion; orphan runtimes use the same durable protocol. Automatic startup/timer cleanup uses metadata-only eligibility checks; explicit previews perform byte sizing. `cleanup` is preview-only unless `execute: true`; its structured details distinguish `stop`, `cache`, `full`, and `orphan` actions and report estimated bytes. Legacy live records receive a complete idle window when first migrated. `agent_fleet({ action: "status", id: "..." })` includes the current cgroup process tree and lifecycle deadlines. Pi coworkers are independent RPC-mode Pi sessions with their own transcript, model, thinking effort, session name, and Intercom identity—not child subagents. The persistent OpenCode profile owns a headless server plus an initialized session and retries early port-bind/startup exits on a fresh ephemeral port; `opencode-run` remains available for one-shot work.

Built-in roles now select named permission profiles. `review-readonly` makes the host and assigned workspace read-only except for private temp and harness runtime state, limits Pi to inspection/Intercom tools, hides common credential paths, and blocks Git, GitHub, GitLab, and Forgejo mutations. `builder-restricted` makes only the assigned workspace and harness runtime state writable, mounts Git metadata read-only, and applies the same credential and remote-write guards. `trusted` preserves broad host access. Custom roles default to `builder-restricted` unless `trusted` is selected explicitly. Hardened profiles also rebuild the worker environment from an allowlist, give each worker a private home, private `XDG_RUNTIME_DIR`, and isolated harness state, proxy Intercom through a short private broker socket, mask SSH/GPG/password-manager agents, package-manager and cloud credentials, user/system D-Bus, host-mutating systemd Varlink/polkit endpoints, host container/VM daemon control sockets, and host desktop/session IPC. The session boundary hides Hyprland, Sway/i3, Niri, Wayland, Alacritty, kitty, WezTerm, Ghostty, PipeWire/PulseAudio, accessibility, launcher, speech, and related runtime sockets while preserving the worker's private Intercom mount. PID isolation prevents workers from delegating an unsandboxed service to the host user manager or controlling Docker, Podman, containerd, BuildKit, LXD/Incus, CRI-O, libvirt, or the host compositor through Unix sockets. Nested namespaces remain available for harness sandboxes such as Codex, but inherit the outer read-only mounts and cannot recover the masked host control or desktop-session sockets. Hardened profiles require systemd 257+ and `/usr/bin/bwrap`; the supervisor uses a nested mount namespace to hide the source Intercom directory after opening the private broker proxy. The systemd filesystem restrictions and packaged `git`/`gh`/`glab`/`tea`/`npm` PATH guards apply across harnesses; restricted profiles also expose help/version-only guards for `gcloud`, Cloudflare (`wrangler`/`cloudflared`), and Cloud Foundry (`cf`). Pi rejects matching remote writes, registry-account changes, and cloud-control commands in its `tool_call` hook. These filesystem and IPC controls are not a general network firewall; restricted workers still require external policy when raw network egress or cloud metadata access must be denied.

Use `/agents-new` for an interactive spawn wizard including permission selection, `/agents-config` to set per-harness defaults, idle/checkpoint/grace and runtime-retention timing, and role presets, and `/agents-models [harness]` to browse models. The default lifecycle is a 30-minute lease capped by a 60-minute idle budget, checkpoint requests beginning 10 minutes before the idle deadline and retrying every 5 minutes while the manager remains available, a 15-minute cleanup grace, and a managerless cleanup timer every 15 minutes. Retention is configurable with `terminalCacheRetentionMinutes`, `terminalRuntimeRetentionMinutes`, and `orphanRuntimeRetentionMinutes`. `stop` always remains available and records best-effort dirty-worktree evidence for writable workers; `forget` requires a stopped worker plus `acknowledge: true`. Reusing a persistent Codex or OpenCode worker ID resumes its harness context; `fresh: true` discards that persisted context before launch. The Pi footer, `/agents`, and `agent_fleet({ action: "list" })` show only coworkers attached to the current manager session. Use `/agents all` or `agent_fleet({ action: "list", all: true })` only for explicit cross-manager diagnostics. Spawn and list results include each worker's `intercomTarget`. Deliver Pi, Codex, and Claude assignments with `intercom_send`; use `intercom_ask` only when the manager's next step truly depends on a reply, never for routine progress/status checkpoints. Create sandboxed builder worktrees before spawning and pass the worktree as `cwd`. Every worker is also told its manager target and can call `intercom_team({})` to get the current manager plus live same-manager coworkers without searching globally. Team resolution reads the worker store dynamically, so adoption changes the visible manager without restarting the worker. After an intentional manager restart, `agent_fleet({ action: "adopt", id: "..." })` transfers a live owned coworker to the new manager session before stop or renew operations. `doctor` also checks adapter version drift and whether the OpenCode Intercom server plugin is visible in OpenCode's resolved configuration.

See [`examples/orchestrator-config.json`](examples/orchestrator-config.json) and the bundled Agent Skill for the current API and limitations.

## Start Here

- [I Got Tired of AI Saying It Was Done When It Wasn't](docs/why-cross-harness-orchestration.md) — how the idea started with detailed corrections, then `fix it`, and eventually literally `lol` or `:(`.
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
npm install -g @dataforxyz/agent-intercom-orchestrator

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
6. The manager verifies the evidence, rewrites the run notes, and either finishes or starts another Ralph-style context loop.

The builder saying `done` starts the review. It does not end the run.

## Origin and Thanks

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). Thank you to Nico and the original contributors for creating the foundation this work builds on.

## Releasing

Releases are automated from version tags. Update `package.json`, the lockfile when
present, and `CHANGELOG.md` on `main`, then push an annotated tag that exactly
matches the package version:

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

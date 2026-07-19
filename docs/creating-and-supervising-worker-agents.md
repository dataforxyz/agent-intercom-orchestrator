# Creating and supervising Agent Intercom workers

This guide explains how to install each Agent Intercom adapter, choose a manager harness, create persistent workers, define ownership and permissions, require proof, and clean up safely.

For a copyable prompt that turns these rules into instructions for a Pi manager, see [Example Manager Prompt](example-manager-prompt.md).

## Recommended manager order

For the current implementations:

1. **Pi or an explicitly configured OpenCode manager** — shared lifecycle and ownership implementation
2. **Codex through `coi`** — capable manager, strongest as a wakeable worker
3. **Claude Code through `cci`** — capable worker and advisor, with more host-level wake limitations

This ranking is about the present Agent Intercom integrations, not overall model quality.

### Why Pi remains the default manager UI

Pi exposes the integration natively as an extension. It has:

- an `intercom` tool with `list`, `send`, `ask`, `reply`, `pending`, and `status`
- unsolicited inbound messages rendered directly in the transcript
- native turn triggering after safe idle boundaries
- durable inbox and outbox handling
- native `/intercom` and `/intercom-id` commands
- native **Alt+M** and **Alt+I** shortcuts
- automatic lifecycle status such as `idle`, `thinking`, and `tool:<name>`
- a normal coding-agent shell that can create worktrees, launch tmux sessions, inspect processes, and stop workers
- no wrapper requirement for intercom behavior

Those properties make Pi well suited to owning worker lifecycle, assigning lanes, receiving progress, resolving asks, and deciding when the run is complete.

### Why OpenCode is now an operational peer

OpenCode has equivalent manager and persistent-worker operations where its public APIs permit them:

- server plugin with native Intercom tools
- separate TUI plugin with `/intercom`, `/intercom-id`, **Alt+M**, and **Alt+I**
- durable inbound persistence before acknowledgement, restart replay, unresolved-ask recovery, and duplicate-turn suppression
- busy-session follow-up through `session.promptAsync`
- run-specific readiness and health metadata
- stable OpenCode session capture and `--session` resume after worker restart
- model-specific variant enumeration and validation
- opt-in native `agent_fleet` backed by the same orchestrator store, leases, adoption, systemd cgroups, logs, and cleanup as Pi

Pi remains the default recommendation when its scoped footer and interactive `/agents*` menus are useful. OpenCode exposes equivalent lifecycle operations as model-callable tools and requires separate server/TUI plugin installation. The difference is presentation and host API shape, not a weaker ownership backend.

### Why Codex works but is less ideal as manager

A normal Codex MCP session can use intercom tools, but MCP alone cannot create native Codex slash commands, keybindings, or unsolicited visible turns.

The `coi` launcher closes much of that gap by:

- starting a Codex app-server sidecar
- maintaining a wakeable thread
- starting turns when messages arrive
- refreshing the attached remote TUI after a completed external turn
- providing **Alt+M** and **Alt+I** through the wrapper

This makes Codex an effective persistent worker. It is less seamless as the primary manager because the wake and terminal behavior belong to the wrapper/app-server arrangement rather than a native Codex extension surface. A plain `codex` session with only MCP queues messages and requires `intercom_pending` to inspect them.

### Why Claude Code works but has the most constraints

A normal Claude Code MCP session can list, send, ask, and read pending messages, but it cannot receive a normal unsolicited visible turn through MCP alone.

The Claude adapter offers two wake strategies:

- `cci`/`ccim` headless workers run resumable `claude -p` turns when a message arrives
- `cci --tui` uses Claude Code's Monitor mechanism to wake a live interactive session

Important limitations:

- Claude Code does not expose plugin keybinding registration, so terminal shortcuts require the `cci`/`ccim` wrapper
- plugin slash commands are namespaced, such as `/claude-intercom:intercom`
- live TUI wake depends on Monitor availability
- Monitor may be unavailable when telemetry/nonessential traffic is disabled or on some managed provider backends
- headless workers show results in the wrapper console, while the full conversation is resumed separately with `claude --resume`

Claude remains useful as an independent challenger, reviewer, or implementation worker, especially when paired with a manager from another provider.

## Install the adapters

All adapters share the same local broker and runtime directory. A session can only discover peers using the same `PI_CODING_AGENT_DIR` value.

### Pi

```bash
pi install npm:@dataforxyz/agent-intercom-pi
```

Restart Pi or run `/reload` in every already-open Pi session after an update.

No alias is required. Start Pi normally:

```bash
pi
```

Verify:

```typescript
intercom_status({})
intercom_list({})
```

### Orchestrator Pi plugin

Install the orchestrator as a Pi package after `agent-intercom-pi`:

```bash
pi install npm:@dataforxyz/agent-intercom-orchestrator
```

This package loads two resources automatically:

- `src/index.ts` — the Pi extension that registers `agent_fleet`, the `/agents*` commands, and the scoped worker footer
- `skills/agent-intercom-orchestrator/SKILL.md` — manager guidance for choosing profiles and safely owning coworkers

Restart Pi or run `/reload`. Confirm installation and runtime support:

```bash
pi list
```

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "versions" })
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "profiles" })
agent_fleet({ action: "permissions" })
```

The plugin requires Linux systemd user services. `doctor` reports missing harness commands, adapter drift, and unsafe package sources. Install only the harnesses you intend to spawn, but keep `agent-intercom-pi` installed for the manager's Intercom control plane.

Preview updates for all five coordinated adapters with:

```typescript
agent_fleet({ action: "update" })
```

The preview detects Pi package sources, npm-global packages, active Git-linked binaries, and the configured OpenCode plugin path. It prints exact commands without replacing Git installs with npm. Apply only recognized safe commands with `agent_fleet({ action: "update", execute: true })`; dirty or version-pinned Git sources remain blocked. After updating, restart affected workers, run `/reload`, and call `doctor` again. For a temporary checkout test without modifying Pi settings, use `pi -e ./src/index.ts` from the orchestrator repository.

### Full Pi manager stack

Installing only `agent-intercom-pi` gives Pi the Intercom tools. The manager setup used for this workflow also includes Ralph loops, background return conditions, compaction helpers, usage/cost tools, prompt templates, MCP support, and the `/mobile` persona switch.

The important pieces are:

| Package | Purpose |
|---|---|
| [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) | Native Intercom tools, inbound turns, status, and UI |
| [`agent-intercom-orchestrator`](https://github.com/dataforxyz/agent-intercom-orchestrator) | Owned cross-harness coworker lifecycle, models, effort, defaults, and cleanup |
| [`pi-extensions`](https://github.com/dataforxyz/pi-extensions) | Ralph loop plus the selected UI, guidance, recap, and usage extensions |
| [`pi-return-on`](https://github.com/dataforxyz/pi-return-on) | Wake the manager when a timer, process, file, port, URL, or other condition is ready |
| [`phone-pi`](https://github.com/a2ajinkya/phone-pi) | Provides the `mobile-persona.ts` extension with `/mobile` and `/default` |
| [`pi-spend`](https://github.com/dataforxyz/pi-spend) | Usage and spend visibility |
| [`pi-openai-fast`](https://github.com/dataforxyz/pi-openai-fast) | Optional custom OpenAI/Codex provider behavior used by this setup |
| [`pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) | Reduces noisy tool output |
| [`pi-must-have-extension`](https://www.npmjs.com/package/pi-must-have-extension) | General Pi workflow utilities |
| [`pi-prompt-template-model`](https://www.npmjs.com/package/pi-prompt-template-model) | Prompt templates with model selection and orchestration features |
| [`pi-safe-compact`](https://www.npmjs.com/package/pi-safe-compact) | Safer context compaction behavior |
| [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) | MCP server integration |

The following is a portable copy of the package and Return On portion of the manager's `~/.pi/agent/settings.json`. The same configuration is available as [`examples/pi-manager-settings.json`](../examples/pi-manager-settings.json). Merge it with your existing model, provider, theme, and authentication settings rather than replacing those values blindly:

```json
{
  "packages": [
    "git:github.com/MasuRii/pi-rtk-optimizer",
    "npm:pi-must-have-extension",
    "git:github.com/dataforxyz/pi-return-on",
    {
      "source": "git:github.com/dataforxyz/pi-extensions",
      "extensions": [
        "agent-guidance/agent-guidance.ts",
        "code-actions/index.ts",
        "files-widget/index.ts",
        "raw-paste/index.ts",
        "pi-ralph-wiggum/index.ts",
        "session-recap/index.ts",
        "tab-status/tab-status.ts",
        "usage-extension/index.ts"
      ]
    },
    "git:github.com/dataforxyz/pi-spend",
    "npm:pi-prompt-template-model",
    "npm:@dataforxyz/agent-intercom-pi",
    "npm:@dataforxyz/agent-intercom-orchestrator",
    "npm:pi-safe-compact",
    "npm:pi-mcp-adapter",
    "git:github.com/dataforxyz/pi-openai-fast@e0917469c325afceba93fc15e363721539cb9f19",
    {
      "source": "git:github.com/a2ajinkya/phone-pi",
      "extensions": [
        "extensions/mobile-persona.ts"
      ],
      "skills": []
    }
  ],
  "returnOn": {
    "defaultTimeout": "10m",
    "maxTimeout": "2h",
    "defaultDeliveryMode": "wake",
    "defaultDeliveryNotify": "summary",
    "triggerParentOnSummary": false
  }
}
```

Review third-party package code before installing it because Pi extensions run with the same machine access as Pi. Install any package that is not already present, then keep the filtered object entries above in `settings.json`:

```bash
pi install git:github.com/MasuRii/pi-rtk-optimizer
pi install npm:pi-must-have-extension
pi install git:github.com/dataforxyz/pi-return-on
pi install git:github.com/dataforxyz/pi-extensions
pi install git:github.com/dataforxyz/pi-spend
pi install npm:pi-prompt-template-model
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/agent-intercom-orchestrator
pi install npm:pi-safe-compact
pi install npm:pi-mcp-adapter
pi install git:github.com/dataforxyz/pi-openai-fast@e0917469c325afceba93fc15e363721539cb9f19
pi install git:github.com/a2ajinkya/phone-pi
```

`pi install` initially adds an unfiltered package entry. After installation, restore the filtered `pi-extensions` and `phone-pi` objects from the JSON example so Pi loads only the listed resources. Then restart Pi and verify the package list:

```bash
pi list
```

#### `/mobile` and `/default`

The `/mobile` command comes from [`a2ajinkya/phone-pi`](https://github.com/a2ajinkya/phone-pi), specifically [`extensions/mobile-persona.ts`](https://github.com/a2ajinkya/phone-pi/blob/master/extensions/mobile-persona.ts).

The extension switches Pi to a user-supplied mobile system prompt stored at:

```text
~/.pi/agent/SYSTEM-mobile.md
```

Create that file with the instructions you want Pi to use on a phone or constrained terminal. A copyable version is included at [`examples/SYSTEM-mobile.md`](../examples/SYSTEM-mobile.md). For example:

```markdown
You are running in a mobile terminal. Keep responses compact, avoid wide tables,
prefer short commands, minimize output, and ask before starting long interactive
or resource-heavy operations.
```

Use:

```text
/mobile   enable the mobile persona
/default  return to Pi's normal system prompt
```

The setting persists through `~/.pi/agent/.mobile-persona` until `/default` removes it. If `SYSTEM-mobile.md` does not exist, enabling `/mobile` will leave the next agent start without a prompt file to load, so create the file before using the command.

### OpenCode

Install the adapter under OpenCode's configuration directory:

```bash
mkdir -p ~/.config/opencode
cd ~/.config/opencode
npm install @dataforxyz/agent-intercom-opencode
```

Add the server plugin to `~/.config/opencode/opencode.json`, using your absolute home path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/home/you/.config/opencode/node_modules/@dataforxyz/agent-intercom-opencode/dist/plugin.mjs"
  ]
}
```

Add the TUI plugin separately in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/you/.config/opencode/node_modules/@dataforxyz/agent-intercom-opencode/dist/tui.mjs"
  ]
}
```

Do not put `dist/tui.mjs` in `opencode.json`; OpenCode uses separate server and TUI plugin loaders. Restart OpenCode after changing either file.

No wrapper alias is required for ordinary worker sessions. Once both plugins are loaded, normal `opencode` sessions have the integration.

To make one OpenCode session the primary fleet manager, install the orchestrator CLI:

```bash
npm install -g @dataforxyz/agent-intercom-orchestrator
```

Start the manager with a stable Intercom identity and explicit fleet opt-in:

```bash
OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

For a source checkout instead, set:

```bash
AGENT_INTERCOM_FLEET_COMMAND=/absolute/path/to/agent-intercom-orchestrator/src/agent-fleet-cli.mjs
```

Do not put `OPENCODE_INTERCOM_FLEET=1` in a machine-wide environment inherited by every session. Owned workers suppress nested fleet registration through `AGENT_INTERCOM_OWNED=1`, but explicit manager configuration keeps ownership understandable.

### Codex

Install globally:

```bash
npm install -g @dataforxyz/agent-intercom-codex
```

Register the MCP server:

```bash
codex mcp add codex-intercom -- codex-intercom-mcp
```

A normal `codex` session now has intercom MCP tools, but it is not automatically wakeable. Use `coi` for persistent wakeable workers:

```bash
coi --name worker-a --id worker-a
```

Run without an attached TUI:

```bash
coi --no-tui --name worker-a --id worker-a --cwd /path/to/repo
```

### Claude Code

Install globally:

```bash
npm install -g @dataforxyz/agent-intercom-claude
```

Register the MCP server:

```bash
claude mcp add claude-intercom -- claude-intercom-mcp
```

Start a wakeable attached worker:

```bash
cci --safe --name worker-a --id worker-a --cwd /path/to/repo
```

Start the minimal profile:

```bash
ccim --safe --name worker-a --id worker-a --cwd /path/to/repo
```

Start experimental live TUI wake mode:

```bash
cci --tui --name worker-a --id worker-a --cwd /path/to/repo
```

Without `--safe`, `cci` defaults to `--dangerously-skip-permissions` so a headless worker is not blocked by permission prompts. Use that only when full machine access is intentional.

## Why aliases are a good idea

Aliases are optional for Pi and OpenCode because their integrations load natively with the normal host command. They are strongly recommended for Codex and Claude Code because a plain host launch is not equivalent to a wakeable intercom launch.

A good alias or shell function:

- makes the wakeable wrapper the normal launch path
- applies a stable worker name and ID
- selects a safe or trusted permission policy deliberately
- selects a dedicated minimal home/config
- sets the expected model and provider environment
- avoids repeatedly typing long paths and flags
- reduces the chance of starting plain `codex` or `claude` and assuming it can be woken

Aliases should not hide dangerous defaults. Give safe and yolo modes visibly different names.

### Suggested Codex aliases

Basic wakeable launch:

```bash
alias codex-intercom='coi'
```

A minimal profile is a dedicated `CODEX_HOME` plus the `coi` launcher. `coim` is a useful local function name, but it is a profile convention rather than a separate requirement of Agent Intercom:

```bash
coim() {
  local home="${CODEX_MIN_HOME:-$HOME/.codex-min-intercom}"
  CODEX_HOME="$home" coi \
    --sandbox workspace-write \
    --ask-for-approval on-request \
    "$@"
}

coim-yolo() {
  local home="${CODEX_MIN_HOME:-$HOME/.codex-min-intercom}"
  CODEX_HOME="$home" coi \
    --dangerously-bypass-approvals-and-sandbox \
    "$@"
}
```

Use `coim` for repo-limited work. Use `coim-yolo` only for trusted work where broader authority is intentional.

### Suggested Claude aliases

```bash
alias claude-intercom='cci --safe'
alias claude-intercom-min='ccim --safe'
alias claude-intercom-yolo='cci'
```

The alias does more than shorten a command: it communicates the permission profile every time the worker is launched.

## Instance ownership rule

Only the primary manager should create or terminate persistent Pi, OpenCode, `coi`, `cci`, tmux, sidecar, or intercom instances.

A worker may use built-in subagents inside its assigned harness, but it must not recursively create more persistent Agent Intercom peers unless the manager explicitly delegates instance ownership.

After an intentional manager restart, the new Pi session can take responsibility for an existing live worker explicitly:

```typescript
agent_fleet({ action: "adopt", id: "architecture-advisor" })
```

Stop and renew refuse live workers owned by another manager session until this handoff occurs. `adopt` is an explicit transfer and does not try to prove that the previous manager is offline, so coordinate it rather than using it to steal a coworker from another live manager.

The Pi footer, `/agents`, and `agent_fleet({ action: "list" })` are scoped by `managerSessionId`, following the same parent-session idea used by `pi-subagents`: each manager sees only coworkers it spawned or adopted. Use `/agents all` or `agent_fleet({ action: "list", all: true })` when you intentionally need the global owned-worker inventory.

Leases are activity-bounded rather than manager-heartbeat-bounded. A manager-received worker Intercom message or explicit `renew` extends the lease, capped at the configured idle deadline; process existence, broker acknowledgements, and messages sent by the manager do not count. The manager requests a commit/checkpoint/handoff before the deadline, cleanup preserves a grace period for recovery or adoption, and a persistent systemd user timer stops only the exact expired owned cgroup even when no manager session is running. Startup cleanup and `/agents-cleanup` use the same race-safe deadline check. Completed one-shot units are retired automatically after reconciliation so their retained exit status does not accumulate in systemd.

Stopping preserves the worker record and supported harness session state for resume. `stop` is always available and records best-effort dirty-worktree evidence for writable workers; it never refuses the safety operation because of Git state. `forget` is a distinct terminal action and requires a stopped worker plus explicit manager `acknowledge: true`.

This prevents:

- duplicate workers
- overlapping file ownership
- orphaned tmux sessions and sidecars
- uncontrolled resource use
- workers replacing each other without a handoff
- unclear responsibility for stopping the system

## Start an owned coworker

Install the orchestrator package in the manager Pi, then use `agent_fleet`. It creates a durable ownership record and launches the complete harness process tree inside a transient systemd user service. Do not use tmux when `agent_fleet` can own the lifecycle.

### Independent Pi advisor

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
  task: "Challenge the architecture and inspect the evidence. Do not edit unless asked."
})
```

This is a separate named Pi session running in RPC mode with stdin held open by the owned launcher. It has its own transcript, model, thinking effort, Intercom identity, lease, and systemd cgroup. It is a coworker, not a child subagent.

The worker ID is also its stable Pi session ID. Reusing an ID intentionally resumes that coworker's transcript and prior mandate; choose a new worker ID when the new assignment should start with clean context.

### Wakeable Codex builder

```typescript
agent_fleet({
  action: "spawn",
  harness: "codex",
  profile: "codex-safe",
  permissionProfile: "builder-restricted",
  id: "codex-builder",
  role: "builder",
  model: "gpt-5.6-sol",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Implement the approved scope and report evidence."
})
```

### Wakeable Claude challenger

```typescript
agent_fleet({
  action: "spawn",
  harness: "claude",
  profile: "claude-safe",
  permissionProfile: "review-readonly",
  id: "claude-challenger",
  role: "challenger",
  model: "opus",
  effort: "max",
  cwd: "/path/to/worktree",
  task: "Try to disprove the builder's completion claim."
})
```

### Persistent OpenCode coworker

```typescript
agent_fleet({
  action: "spawn",
  harness: "opencode",
  profile: "opencode-peer",
  permissionProfile: "review-readonly",
  id: "opencode-advisor",
  role: "advisor",
  model: "anthropic/claude-fable-5",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Review the plan, then remain available for follow-up turns through Intercom."
})
```

The owned launcher starts an authenticated `opencode serve` on a private loopback port, initializes or resumes a stable session through `opencode run --attach --session`, and keeps the server alive. Spawn does not report success until the plugin publishes matching run-specific health with an Intercom connection and active OpenCode session ID. Inbound messages are persisted before acknowledgement and replayed after restart.

Reusing `id: "opencode-advisor"` resumes its OpenCode session. Pass `fresh: true` to intentionally discard the saved session for that worker ID. Use `agent_fleet({ action: "variants", model: "anthropic/claude-fable-5" })` before selecting effort; known-invalid variants are rejected before a unit is created. Use profile `opencode-run` when a cheaper one-shot assignment is preferable.

## Long instructions belong in files

Do not maintain a large shell-escaped prompt inline. Store it under the project’s agent scratch directory:

```text
.agent/prompts/<worker-id>.md
```

Then have the manager read and send it, or load it into the worker instructions using a small launcher script. Keep scratch prompts and run notes under `.agent/`, not loose at the repository root.

## Verify registration before assigning work

`agent_fleet` spawn and list results include the owned worker's `intercomTarget`. Use that target directly instead of calling the global Intercom list to rediscover it:

```typescript
intercom_send({
  to: "worker-id",
  message: "Start now. First report your plan, ownership boundary, and current worktree status."
})
```

Pi, Codex, and Claude registration is not automatically awaited. If the first delivery reports that the target is not connected yet, wait briefly and retry. Use `intercom_list({})` only as a readiness diagnostic or to discover independently launched peers. Orchestrator-owned persistent OpenCode peers are the exception: spawn waits for run-specific plugin, Intercom, and session readiness before returning.

For independent/manual sessions, still check that the process is alive, the reported cwd is correct, the identity is unique, and the worktree is intended:

```bash
tmux has-session -t <worker-id>
```

```typescript
intercom_list({})
```

Do not confuse worker registration with task execution.

## Coworkers can find their manager

Every spawned worker receives its manager target in both the standing instructions and `AGENT_INTERCOM_MANAGER_TARGET`. The normal model-facing path is deliberately simpler:

```typescript
intercom_team({})
```

The result names the manager and live same-manager coworkers with direct Intercom targets. It reads the orchestrator worker store on every call, validates the worker/run identity, and therefore follows `adopt` without requiring a worker restart. Owned workers still do not receive fleet mutation authority; they use `intercom_send` or `intercom_ask` with the returned targets.

## Worker preflight

Every worker should inspect and report inherited state before editing:

```bash
git -C <repo> status --short --branch
git -C <repo> log --oneline -5
```

The report should identify:

- current branch and worktree
- existing commits
- uncommitted or untracked files
- inherited work from another agent
- whether the worker can proceed without overwriting anything

## Goals, checklists, and built-in subagents

For substantial assignments, require the worker to:

- state the goal and acceptance criteria before editing
- maintain a checklist with done, active, blocked, and deferred items
- update the checklist when evidence changes the plan
- use built-in subagents for non-overlapping research, implementation, or QA when useful
- report every subagent’s role and scope
- retain one primary worker accountable for integration
- close or explicitly disposition every checklist item
- avoid persistent child instances unless the manager authorized them

Reusable instruction:

```text
Manage this assignment with an explicit goal, acceptance criteria, and a
maintained checklist. Use built-in subagents when they add value, with
non-overlapping ownership for research, implementation, and independent QA.
Report their roles and scopes. You remain responsible for integration,
verification, and closing or clearly dispositioning every item. Do not launch
additional persistent intercom, tmux, sidecar, Pi, Codex, Claude, or OpenCode
instances.
```

## Exclusive ownership

Use one primary worker per repository, worktree, or explicitly non-overlapping file lane.

```markdown
| Worker | Repo/worktree | Exclusive scope | Status |
|---|---|---|---|
| `codex-build-api` | `~/worktrees/app-api` | API implementation | active |
| `claude-review-api` | same repo, read-only | Review and proof only | active |
```

Two writing workers should not share a file lane. A read-only challenger may inspect a builder’s worktree, but it should not silently fix the code it is supposed to review.

Before replacing a worker:

1. stop the old instance
2. inspect its process and worktree
3. record or commit valid inherited work
4. verify it disappeared from tmux and intercom
5. launch the replacement with a new unique ID

## Permission profiles

The orchestrator ships three named guardrail profiles:

- `review-readonly` — the host and assigned workspace are read-only except for private temporary storage and harness runtime state; Pi receives only inspection and Intercom tools.
- `builder-restricted` — only the assigned workspace, private temporary storage, and harness runtime state are writable. The repository's Git metadata (including linked-worktree common metadata) is mounted read-only, common credential paths and environment variables are hidden, and the packaged `git`/`gh`/`glab`/`tea` guards allow explicitly recognized inspection commands but block mutations and remote writes. Project-local npm/Yarn/pnpm/Bun credential files are hidden, and the packaged `npm` guard uses empty private configuration with the public npm registry for local development commands while blocking login, token, ownership, publish, unpublish, and registry-configuration operations. Private registries require an explicitly trusted worker.
- `trusted` — preserves broad host and Git access for explicitly trusted work.

Built-in advisor, researcher, and challenger roles use `review-readonly`; the builder role uses `builder-restricted`. Custom roles also default to `builder-restricted` unless `trusted` is selected explicitly. Hardened profiles rebuild the environment from an allowlist, create private per-worker homes and harness state, and proxy the shared Intercom broker through a short private socket. They mask user/system D-Bus control sockets and isolate PIDs, preventing `systemd-run --user`, `systemctl --user`, `busctl`, or `machinectl` from delegating an unsandboxed process to the host user manager. They also apply optional `InaccessiblePaths` masks to rootful and rootless Docker, Podman, containerd, BuildKit, LXD/Incus, CRI-O, LXC, QEMU/Firecracker, and libvirt control endpoints. Direct host-mutating systemd Varlink sockets—including login/shutdown, manager, import, factory-reset, hostname, sysext, boot/repartition/PCR, credential, and storage-provider endpoints—plus udev control, polkit authorization-helper, and Tailscale control paths are masked too. Journal output, name resolution, user lookup, and the private Intercom broker remain available. The rootless paths are derived from the uid that launches the worker, while the private Intercom broker mount remains available. `PrivateUsers=self` preserves the worker uid but maps unrelated host uids, gids, and supplementary groups to `nobody`. A host socket owned by `root:docker`, `root:libvirt`, or another privileged group can therefore appear as `nobody:nobody` while the worker also has a mapped `nobody` supplementary group; filesystem mode checks alone are not a safe boundary. The explicit daemon-socket masks close that path. Nested `bwrap` or `unshare` sandboxes remain usable by harnesses such as Codex, but inherit the outer read-only mounts and masked host control sockets. Hardened profiles require systemd 257+ and `/usr/bin/bwrap`; the supervisor opens the broker proxy first, then masks the source Intercom directory inside the harness mount namespace. The systemd filesystem policy and Git/hosting CLI PATH guards apply to every harness. Host SSH/GPG agents, desktop keyring and PKCS#11 brokers, 1Password/Bitwarden/KeePassXC agent paths, Google Cloud, Cloudflare, Cloud Foundry, and package-registry credentials are masked or scrubbed. Restricted workers receive a private `XDG_RUNTIME_DIR`; host Hyprland, Sway/i3, Niri, Wayland, Alacritty, kitty, WezTerm, Ghostty, tmux/Zellij, PipeWire/PulseAudio, accessibility, launcher, speech, Flatpak Wayland, and related session sockets are explicitly hidden, and their target environment variables are cleared. This prevents a headless worker from querying desktop state or asking a host compositor or terminal process to execute outside the worker cgroup while leaving the private Intercom broker and harness runtime mounted. The `gcloud`, `wrangler`, `cloudflared`, and `cf` PATH entries permit help/version inspection only in restricted profiles. Pi additionally blocks matching `bash`, `edit`, and `write` calls in a `tool_call` hook, including ordinary absolute-path hosting, npm-registry, and cloud-control commands. Restricted profiles hide host GitHub, Forgejo, and GitLab configuration. The GitHub and Tea wrappers validate repository/server targets, clear command-level hosting credentials and host overrides, disable browser/debug/token-display paths, and use private temporary configuration. Authenticated private-forge inspection therefore requires an explicitly trusted worker. Restricted profiles also hide host and project-local glab configuration and scrub GitLab/CI token, host, and TLS-path variables. The glab wrapper uses a mode-`0600` empty configuration in private `/tmp` for each allowed invocation, removes it afterward, and clears config, host, debug, pager, browser, GitLab token, and CI credential overrides before launching the real CLI. Restricted glab inspection is therefore intentionally unauthenticated; use an explicitly trusted worker when private-project credentials are required. The `glab api` guard permits only narrowly validated GET/HEAD requests and rejects GraphQL, encoded or external endpoints, host overrides, request bodies, headers, and ambiguous forms. These profiles limit ordinary agent mistakes; they are not hostile-code containers, and a restricted builder can still damage files inside its assigned writable workspace. PATH guards can be bypassed by hostile code invoking or supplying another binary, and the profiles do not provide a general egress firewall. On cloud hosts, blocking workload metadata services requires an external network policy. A worker that is explicitly given a credential can still use custom code to reach an external API; use `trusted` only when that authority is intentional.

Use `agent_fleet({ action: "permissions" })` to inspect the active definitions and pass `permissionProfile` explicitly to override a role default.

## Access boundaries

Every assignment must state:

- files and repositories the worker may read
- files and repositories it may modify
- sandbox or permission mode
- whether network or browser access is allowed
- forbidden credentials, private exports, SSH configuration, and production systems
- whether commits, pushes, deployments, issues, or other external writes are allowed

Example:

```text
Modify only the assigned worktree. Do not read credential files, private
exports, SSH configuration, or production data. Do not push, deploy, file
issues, or submit real forms. Ask the manager for a sanitized fact if one is
required.
```

## Communication rules

Use `send` for delegation and progress that does not require an immediate answer:

```typescript
intercom_send({ to: "worker", message: "Begin task 2." })
```

Use `ask` only for a decision that blocks the sender:

```typescript
intercom_ask({
  to: "manager",
  message: "The migration changes the public error shape. Approve that change?"
})
```

An ask has a bounded foreground wait. If the recipient is busy, the request may continue asynchronously and a late reply arrives as a new message. Do not assume that sending an ask instantly interrupts an active model turn.

## Completion evidence

Never accept “done” without artifact-level evidence.

Require, as applicable:

- changed files and commit hashes
- build, typecheck, lint, and test results
- coverage, route, API, or migration disposition
- browser screenshots and smoke-test results
- known gaps and blockers
- final worktree status
- confirmation that no secrets or private data were included

Compact report:

```markdown
- Scope/files/commits:
- Build/typecheck/lint/tests:
- Browser, API, or coverage evidence:
- Objections resolved:
- Known gaps/blockers:
- Final worktree status:
- Secret/private-data confirmation:
```

## Independent proof advisor

For high-impact or multi-worker tasks, start an independent advisor that reviews proof but does not implement the work.

Pi is the preferred advisor harness because it can receive messages natively and inspect multiple workers without a wrapper.

Minimal advisor prompt:

```markdown
You are an independent proof advisor, not an implementation worker.
Maintain `.agent/PROOF_REVIEW.md`. Inspect artifacts rather than trusting
summaries. Cite paths, commands, screenshots, reports, tests, and commits.
Challenge unsupported claims and request missing proof. Do not modify
implementation code or request private credentials. Use these verdicts:
NOT REVIEWED, INSUFFICIENT, CONDITIONAL, or APPROVED.
```

For critical work, completion requires approval from both the primary manager and proof advisor. A disagreement returns the missing evidence or defect to the responsible worker.

## Browser and visual tasks

Use full `coi` when Codex’s normal-profile browser or computer-use capabilities are required. Minimal Codex workers can still run Playwright or Chromium through shell commands when installed and permitted.

For visual work, require:

- read-only reference inspection
- matching desktop and mobile captures
- written comparison against the source
- console and request checks
- navigation, form, image, and overflow checks
- no real payments, orders, emails, or production-mutating submissions

## Blockers and issue waivers

Filing an issue does not automatically make incomplete work acceptable.

A worker proposing deferment must provide:

```markdown
- Blocked task and impact:
- Attempts and evidence:
- Why it cannot be completed safely now:
- Target repository and proposed issue:
- Dependencies:
- Testable acceptance criteria:
```

A fixable code, content, test, route, asset, or visual defect should not be waived merely to close the loop. The manager and proof advisor must agree that the blocker is real and that the filed issue fully captures it.

## Stop and clean up

For an orchestrator-owned worker, inspect and stop the exact cgroup:

```typescript
agent_fleet({ action: "status", id: "opencode-visual-review" }) // includes the live cgroup process tree
agent_fleet({ action: "stop", id: "opencode-visual-review" })
agent_fleet({ action: "forget", id: "opencode-visual-review", acknowledge: true })
```

Normal descendants—including Playwright browsers, Chromium renderers, MCP servers, language servers, build watchers, and shell grandchildren—inherit the worker's systemd cgroup. Stop uses `KillMode=control-group`, escalates remaining members with `SIGKILL`, and verifies that the cgroup is empty before declaring success.

Detached resources can escape process-tree ownership: a worker-created systemd service, `docker run -d` container, Kubernetes job, remote browser, cloud task, or process handed to a shared daemon. Workers receive ownership environment variables (`AGENT_INTERCOM_WORKER_ID`, `AGENT_INTERCOM_RUN_ID`, `AGENT_INTERCOM_SYSTEMD_UNIT`, and `AGENT_INTERCOM_MANAGER_SESSION_ID`) and are instructed to report external resource IDs. Do not permit detached resources unless the manager explicitly records and owns their cleanup.

Stop an ordinary tmux worker:

```bash
tmux kill-session -t <worker-id>
```

For a private tmux socket:

```bash
tmux -S <socket> kill-session -t <worker-id>
```

Then verify:

- tmux session is gone
- process or process group is gone
- intercom no longer lists the worker
- queued late messages are treated as stale until verified
- the worktree contains no hidden or unreviewed changes
- no sidecar or duplicate identity remains

When process inspection is required:

```bash
ps -eo pid,ppid,tty,lstart,cmd
```

Prefer exact session names, PIDs, and process groups. Avoid broad `pkill` patterns.

Use unique IDs such as:

- `pi-manager-app`
- `codex-build-api`
- `claude-challenge-api`
- `opencode-visual-review`
- `pi-proof-advisor`

Do not reuse an ID while stale processes or queued messages may still exist.

## Supervisor checklist

```markdown
- [ ] Primary manager and proof authority selected
- [ ] Unique worker IDs and exclusive lanes assigned
- [ ] Worktrees inspected before edits
- [ ] Sandbox and access boundaries defined
- [ ] Tmux process and intercom cwd verified
- [ ] Explicit start messages sent
- [ ] Worker goals and plans reviewed
- [ ] Built-in subagent scopes reported
- [ ] Completion evidence inspected directly
- [ ] Proof advisor used when warranted
- [ ] Blocker proposals reviewed
- [ ] Commits and final worktree states verified
- [ ] Required approvals received
- [ ] Workers stopped or intentionally retained
- [ ] No duplicate sessions, sidecars, or stale identities remain
```

## Common pitfalls

- Starting plain `codex` and assuming it has `coi` wake behavior
- Starting plain Claude MCP and expecting unsolicited visible turns
- Forgetting OpenCode’s separate server and TUI plugin files
- Treating worker registration as proof that work started
- Using yolo mode without making that authority explicit
- Letting workers recursively create persistent peer instances
- Giving two writers the same file lane
- Accepting summaries instead of artifacts
- Using `ask` for routine progress and creating unnecessary wait edges
- Assuming an urgent message can interrupt every harness mid-turn
- Reusing stale worker IDs
- Ending the run without checking worktrees and processes

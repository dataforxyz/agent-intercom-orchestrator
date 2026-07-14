# Creating and supervising Agent Intercom workers

This guide explains how to install each Agent Intercom adapter, choose a manager harness, create persistent workers, define ownership and permissions, require proof, and clean up safely.

For a copyable prompt that turns these rules into instructions for a Pi manager, see [Example Manager Prompt](example-manager-prompt.md).

## Recommended manager order

For the current implementations:

1. **Pi** — best primary manager
2. **OpenCode** — strong second choice
3. **Codex through `coi`** — capable manager, strongest as a wakeable worker
4. **Claude Code through `cci`** — capable worker and advisor, with more host-level wake limitations

This ranking is about the present Agent Intercom integrations, not overall model quality.

### Why Pi is the best manager

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

### Why OpenCode is second

OpenCode also has a native-feeling integration:

- server plugin with intercom tools
- separate TUI plugin with `/intercom`, `/intercom-id`, **Alt+M**, and **Alt+I**
- inbound prompt injection into the active session
- busy-session follow-up through `session.promptAsync`
- receiver acknowledgement only after injection succeeds
- no wrapper alias required once both plugins are configured

It ranks behind Pi because delivery depends on OpenCode's plugin and session APIs, and the server and TUI integrations must be installed separately. Pi's extension has more direct control over transcript rendering, lifecycle status, and turn triggering.

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
pi install git:github.com/dataforxyz/agent-intercom-pi
```

Restart Pi or run `/reload` in every already-open Pi session after an update.

No alias is required. Start Pi normally:

```bash
pi
```

Verify:

```typescript
intercom({ action: "status" })
intercom({ action: "list" })
```

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
    "git:github.com/dataforxyz/agent-intercom-pi",
    "git:github.com/dataforxyz/agent-intercom-orchestrator",
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
pi install git:github.com/dataforxyz/agent-intercom-pi
pi install git:github.com/dataforxyz/agent-intercom-orchestrator
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

Clone and build the adapter:

```bash
git clone https://github.com/dataforxyz/agent-intercom-opencode.git
cd agent-intercom-opencode
npm install
npm run build
```

Add the server plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/absolute/path/to/agent-intercom-opencode/dist/plugin.mjs"
  ]
}
```

Add the TUI plugin separately in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/absolute/path/to/agent-intercom-opencode/dist/tui.mjs"
  ]
}
```

Do not put `dist/tui.mjs` in `opencode.json`; OpenCode uses separate server and TUI plugin loaders. Restart OpenCode after changing either file.

No wrapper alias is required. Once both plugins are loaded, normal `opencode` sessions have the integration.

### Codex

Install globally:

```bash
npm install -g github:dataforxyz/agent-intercom-codex
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
npm install -g github:dataforxyz/agent-intercom-claude
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

Leases are the final garbage-collection boundary: startup cleanup and `/agents-cleanup` may stop any orchestrator-owned worker after its lease expires, even when its original manager session is gone. Completed one-shot units are retired automatically after reconciliation so their retained exit status does not accumulate in systemd.

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
  id: "opencode-advisor",
  role: "advisor",
  model: "anthropic/claude-fable-5",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Review the plan, then remain available for follow-up turns through Intercom."
})
```

The owned launcher starts `opencode serve` on a private loopback port, creates an initialized session through `opencode run --attach`, and keeps the server alive. The OpenCode Intercom plugin injects later messages into that same session, so it behaves much more like the persistent Pi, Codex, and Claude peers. Use profile `opencode-run` when a cheaper one-shot assignment is preferable.

## Long instructions belong in files

Do not maintain a large shell-escaped prompt inline. Store it under the project’s agent scratch directory:

```text
.agent/prompts/<worker-id>.md
```

Then have the manager read and send it, or load it into the worker instructions using a small launcher script. Keep scratch prompts and run notes under `.agent/`, not loose at the repository root.

## Verify registration before assigning work

Launching a process does not prove that it registered correctly, and a `--no-tui` worker may wait silently until it receives a message.

Check:

1. the tmux session exists
2. the worker process is alive
3. intercom lists the expected name and ID
4. the reported cwd is correct
5. there is only one session with that identity
6. the worktree is the intended one

```bash
tmux has-session -t <worker-id>
```

```typescript
intercom({ action: "list" })
```

Then send an explicit start message:

```typescript
intercom({
  action: "send",
  to: "worker-id",
  message: "Start now. First report your plan, ownership boundary, and current worktree status."
})
```

Do not confuse worker registration with task execution.

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
intercom({ action: "send", to: "worker", message: "Begin task 2." })
```

Use `ask` only for a decision that blocks the sender:

```typescript
intercom({
  action: "ask",
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

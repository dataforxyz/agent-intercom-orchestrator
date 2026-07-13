# Agent Intercom Orchestrator

Use independent coding agents to keep each other working after one of them says the task is done.

One agent builds and tries to prove the work is finished. Another agent challenges that claim, looks for what was missed, and forces another pass. Using different models and harnesses creates more possible answers and makes instant self-agreement less likely.

A manager controls the agents, evidence, limits, context resets, and stopping rule so the useful disagreement does not turn into an endless argument.

> **Status:** A first-draft Pi extension now provides an `agent_fleet` tool for owned worker lifecycle, systemd-cgroup cleanup, leases, diagnostics, and optional `pi-subagents` RPC. Codex and Claude receive tasks through Intercom after registration; one-shot OpenCode runs receive the task at launch.

## First Draft

Install from the checkout while developing:

```bash
pi -e ./src/index.ts
```

Or install the Git package after it is published:

```bash
pi install git:github.com/dataforxyz/agent-intercom-orchestrator
pi install npm:pi-subagents
```

`pi-subagents` is required only when the orchestrator should create Pi child agents. Codex and Claude lifecycle management does not depend on it.

Start with:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "list" })
```

External Codex, Claude, and one-shot OpenCode workers launch in transient systemd user services with `KillMode=control-group`, a maximum runtime, a renewable lease, and an owned worker record. Stopping the unit stops the wrapper, MCP servers, sidecars, browsers, and other descendants that remain in its cgroup. Pi workers delegate to `pi-subagents` through its in-process RPC API when that package is installed. A permanently idle, wakeable OpenCode server remains future work.

See [`examples/orchestrator-config.json`](examples/orchestrator-config.json) and the bundled Agent Skill for the current API and limitations.

## Start Here

- [I Got Tired of AI Saying It Was Done When It Wasn't](docs/why-cross-harness-orchestration.md) — how the idea started with detailed corrections, then `fix it`, and eventually literally `lol` or `:(`.
- [Creating and Supervising Worker Agents](docs/creating-and-supervising-worker-agents.md) — installation, harness restrictions, aliases, worker setup, permissions, evidence, and cleanup.
- [Example Manager Prompt](docs/example-manager-prompt.md) — a reusable prompt for a Pi manager supervising builders, challengers, and proof advisors.

## Agent Intercom Harnesses

| Harness | Repository | Current best use |
|---|---|---|
| Pi | [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) | Primary manager and proof advisor |
| OpenCode | [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode) | Secondary manager or worker |
| Codex | [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex) | Wakeable builder through `coi` |
| Claude Code | [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude) | Wakeable challenger or worker through `cci` |

The [worker guide](docs/creating-and-supervising-worker-agents.md#install-the-adapters) contains the complete installation instructions for all four harnesses.

## The Basic Loop

1. The manager defines the task, evidence, limits, and worker ownership.
2. A builder implements the task and claims it is finished.
3. A challenger tries to prove that it is not finished.
4. The builder fixes the objection or proves it wrong.
5. The manager repeats the exchange while it is still improving the work.
6. The manager verifies the evidence, rewrites the run notes, and either finishes or starts another Ralph-style context loop.

The builder saying `done` starts the review. It does not end the run.

## Origin and Thanks

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom), and the Pi worker driver uses the public RPC API from Nico's [`pi-subagents`](https://github.com/nicobailon/pi-subagents). Thank you to Nico and the original contributors for creating both foundations.

## License

MIT

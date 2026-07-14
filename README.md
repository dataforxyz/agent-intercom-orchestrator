# Agent Intercom Orchestrator

Use independent coding agents to keep each other working after one of them says the task is done.

One agent builds and tries to prove the work is finished. Another agent challenges that claim, looks for what was missed, and forces another pass. Using different models and harnesses creates more possible answers and makes instant self-agreement less likely.

A manager controls the agents, evidence, limits, context resets, and stopping rule so the useful disagreement does not turn into an endless argument.

> **Status:** A first-draft Pi extension now provides an `agent_fleet` tool for owned coworker lifecycle, systemd-cgroup cleanup, leases, model and effort selection, diagnostics, enumeration, and interactive defaults. Pi, Codex, Claude, and OpenCode can all run as persistent Intercom peers; OpenCode also has a one-shot profile.

## First Draft

Install from the checkout while developing:

```bash
pi -e ./src/index.ts
```

Or install the Git package after it is published:

```bash
pi install git:github.com/dataforxyz/agent-intercom-orchestrator
```

Start with:

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "models", harness: "pi" })
agent_fleet({ action: "list" })
```

Pi, Codex, Claude, and OpenCode coworkers launch in transient systemd user services with `KillMode=control-group`, a maximum runtime, a renewable lease, and an owned worker record. Stopping the unit stops the harness, MCP servers, sidecars, browsers, and every descendant that remains in its cgroup. Pi coworkers are independent RPC-mode Pi sessions with their own transcript, model, thinking effort, session name, and Intercom identity—not child subagents. The persistent OpenCode profile owns a headless server plus an initialized session; `opencode-run` remains available for one-shot work.

Use `/agents-new` for an interactive spawn wizard, `/agents-config` to set per-harness defaults and role presets, and `/agents-models [harness]` to browse models. After an intentional manager restart, `agent_fleet({ action: "adopt", id: "..." })` transfers a live owned coworker to the new manager session before stop/forget operations.

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

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). Thank you to Nico and the original contributors for creating the foundation this work builds on.

## License

MIT

# Agent Intercom Orchestrator

Use independent coding agents to keep each other working after one of them says the task is done.

One agent builds and tries to prove the work is finished. Another agent challenges that claim, looks for what was missed, and forces another pass. Using different models and harnesses creates more possible answers and makes instant self-agreement less likely.

A manager controls the agents, evidence, limits, context resets, and stopping rule so the useful disagreement does not turn into an endless argument.

> **Status:** The Agent Intercom harness adapters work today. The automated orchestrator CLI is still being designed. The documented workflow can already be run manually with Pi, tmux, and the wakeable adapters.

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

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). Thank you to Nico and the original contributors for creating the Pi extension and the foundation this work builds on.

## License

MIT

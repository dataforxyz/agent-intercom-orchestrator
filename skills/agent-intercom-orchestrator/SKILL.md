---
name: agent-intercom-orchestrator
description: Create and manage owned Pi, Codex, Claude Code, and OpenCode workers with lifecycle cleanup through the agent_fleet tool. Use when delegating persistent work, creating builder/challenger pairs, inspecting worker status, stopping workers, or cleaning expired workers.
---

# Agent Intercom Orchestrator

Use `agent_fleet` instead of launching persistent harness processes directly.

## Core rules

- The manager owns creation and cleanup.
- Use unique worker ids.
- Give each worker an exclusive scope and explicit role.
- External workers start inside systemd user services so their MCP servers, sidecars, browsers, and other descendants can be stopped as one cgroup.
- After Codex or Claude is spawned, wait until its id appears in `intercom({ action: "list" })`, then send the recorded task with `intercom({ action: "send", ... })` or `ask`. OpenCode run workers receive the task as their initial prompt.
- Use `send` for assignments and progress. Use `ask` only for blocking decisions.
- Preview cleanup before executing it.
- Never kill or forget sessions the orchestrator does not own.

## Common actions

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "list" })

agent_fleet({
  action: "spawn",
  harness: "codex",
  profile: "codex-safe",
  id: "codex-build-api",
  role: "builder",
  cwd: "/path/to/worktree",
  task: "Implement the approved API plan and report evidence."
})

agent_fleet({
  action: "spawn",
  harness: "claude",
  profile: "claude-safe",
  id: "claude-challenge-api",
  role: "challenger",
  cwd: "/path/to/worktree",
  task: "Review the builder's completion claim and find missing proof or defects."
})

agent_fleet({ action: "status", id: "codex-build-api" })
agent_fleet({ action: "logs", id: "codex-build-api", lines: 100 })
agent_fleet({ action: "stop", id: "codex-build-api" })
agent_fleet({ action: "cleanup", execute: false })
agent_fleet({ action: "cleanup", execute: true })
```

For Pi children, the first draft delegates to the `pi-subagents` in-process RPC API:

```typescript
agent_fleet({
  action: "spawn",
  harness: "pi",
  agent: "reviewer",
  id: "pi-proof-review",
  role: "proof-advisor",
  task: "Inspect the actual evidence and challenge unsupported claims."
})
```

## First-draft limitations

- Codex and Claude task delivery is still a separate Intercom `send` after registration.
- OpenCode spawning is one-shot through `opencode run`; a permanently idle, wakeable OpenCode server still needs a lifecycle driver.
- Automatic registration checks need a general Agent Intercom event-bus RPC API.
- Linux systemd user services are the only external process backend in this draft.

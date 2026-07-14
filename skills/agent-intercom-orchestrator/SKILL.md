---
name: agent-intercom-orchestrator
description: Create and manage owned independent Pi, Codex, Claude Code, and OpenCode coworkers with model/effort selection and lifecycle cleanup through the agent_fleet tool. Use when delegating persistent work, creating advisors or builder/challenger pairs, inspecting worker status, choosing models, editing defaults, or cleaning expired workers.
---

# Agent Intercom Orchestrator

Use `agent_fleet` instead of launching persistent harness processes directly.

## Core rules

- Coworkers are independent Agent Intercom peers. A Pi advisor is not a child subagent.
- The manager owns creation, leases, stopping, and cleanup.
- Use unique worker ids and give each coworker an exclusive scope and explicit role.
- All harnesses start inside systemd user services so MCP servers, sidecars, browsers, and other descendants stop with the owned cgroup.
- After Pi, Codex, or Claude is spawned, wait for its id in `intercom({ action: "list" })`, then send the task with `intercom({ action: "send", ... })` or `ask`. OpenCode receives its initial task at launch; persistent OpenCode peers remain wakeable afterward.
- Use `capabilities`, `profiles`, `models`, or `config` instead of guessing options.
- Preview cleanup before executing it. Never kill or forget sessions the orchestrator does not own.

## Discover options

```typescript
agent_fleet({ action: "doctor" })
agent_fleet({ action: "capabilities" })
agent_fleet({ action: "profiles" })
agent_fleet({ action: "profiles", harness: "pi" })
agent_fleet({ action: "models", harness: "pi" })
agent_fleet({ action: "config" })
agent_fleet({ action: "list" })
```

Normalized effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `capabilities` reports the subset supported by each harness.

## Persistent Pi advisor

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
  task: "Challenge the architecture plan and inspect evidence. Do not edit unless asked."
})
```

The Pi coworker has its own named Pi session, transcript, model, thinking effort, systemd cgroup, and Intercom identity. It stays idle between messages until stopped or its lease/runtime expires.

## Other harnesses

```typescript
agent_fleet({
  action: "spawn",
  harness: "codex",
  profile: "codex-safe",
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
  id: "claude-challenge-api",
  role: "challenger",
  model: "opus",
  effort: "max",
  cwd: "/path/to/worktree",
  task: "Find defects or missing proof in the builder's completion claim."
})

agent_fleet({
  action: "spawn",
  harness: "opencode",
  profile: "opencode-peer",
  id: "opencode-check-api",
  role: "tester",
  model: "opencode/claude-sonnet-5",
  effort: "high",
  cwd: "/path/to/worktree",
  task: "Run the smoke checks and report evidence through Intercom."
})
```

## Lifecycle

```typescript
agent_fleet({ action: "status", id: "codex-build-api" })
agent_fleet({ action: "logs", id: "codex-build-api", lines: 100 })
agent_fleet({ action: "renew", id: "codex-build-api" })
agent_fleet({ action: "adopt", id: "codex-build-api" }) // after an intentional manager restart
agent_fleet({ action: "stop", id: "codex-build-api" })
agent_fleet({ action: "cleanup", execute: false })
agent_fleet({ action: "cleanup", execute: true })
agent_fleet({ action: "forget", id: "codex-build-api" })
```

## Pi commands

- `/agents` — inspect managed coworkers
- `/agents-new` — interactive role, harness, profile, model, effort, cwd, id, and task wizard
- `/agents-config` — edit per-harness defaults, lifecycle settings, and role presets
- `/agents-models [pi|codex|claude|opencode]` — browse available models
- `/agents-cleanup [execute]` — preview or execute expired-lease cleanup

Configuration is stored at `~/.pi/agent/intercom/orchestrator/config.json` unless `PI_CODING_AGENT_DIR` changes the Pi agent directory.

## Current limitations

- Pi, Codex, and Claude registration is not automatically awaited; send the assignment after the target appears in Intercom.
- A newly started manager must explicitly `adopt` live workers created by an older manager session before it can stop or renew them. Expired leases remain eligible for orchestrator-wide garbage collection.
- `opencode-peer` owns a headless OpenCode server and initialized session for wakeable follow-up turns. `opencode-run` remains available for cheaper one-shot assignments.
- Model enumeration is authoritative for Pi and OpenCode. Codex and Claude discovery uses models exposed by the manager Pi plus configured defaults because their top-level CLIs do not provide an equivalent complete list.
- Linux systemd user services are the only process backend in this draft.

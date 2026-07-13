# Agent Intercom Orchestrator

Cross-harness orchestration for wakeable coding agents using the Agent Intercom family.

> **Status:** design and early implementation. The repository currently defines the orchestration model and planned CLI.

## Documentation

- [Why cross-harness agent orchestration works](docs/why-cross-harness-orchestration.md) — the original working notes rewritten as an evidence-driven design rationale.
- [Creating and supervising worker agents](docs/creating-and-supervising-worker-agents.md) — installation for Pi, OpenCode, Codex, and Claude Code; manager selection; aliases; persistent workers; permissions; proof requirements; and cleanup.

### Current manager recommendation

| Rank | Harness | Manager suitability |
|---|---|---|
| 1 | Pi | Best native intercom lifecycle, inbound turn delivery, status, UI, and process supervision |
| 2 | OpenCode | Strong native plugin and prompt-injection support; separate server/TUI setup required |
| 3 | Codex with `coi` | Excellent wakeable worker; manager behavior depends on the app-server wrapper |
| 4 | Claude Code with `cci` | Valuable independent worker/reviewer; MCP, Monitor, and wrapper constraints make management less seamless |

This ranking describes the current Agent Intercom adapters, not the general quality of the models or harnesses.

## Install the harness adapters

The orchestrator will coordinate the existing Agent Intercom adapters. Install the adapters for the harnesses you want to connect.

### Pi

```bash
pi install git:github.com/dataforxyz/agent-intercom-pi
```

Repository: [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi)

### OpenCode

```bash
git clone https://github.com/dataforxyz/agent-intercom-opencode.git
cd agent-intercom-opencode
npm install
npm run build
```

OpenCode requires the built server plugin in `opencode.json` and the separate TUI plugin in `tui.json`. See the [complete setup guide](docs/creating-and-supervising-worker-agents.md#opencode).

Repository: [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode)

### Codex

```bash
npm install -g github:dataforxyz/agent-intercom-codex
codex mcp add codex-intercom -- codex-intercom-mcp
```

Use `coi`, rather than plain `codex`, when the session must be wakeable.

Repository: [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex)

### Claude Code

```bash
npm install -g github:dataforxyz/agent-intercom-claude
claude mcp add claude-intercom -- claude-intercom-mcp
```

Use `cci` or `ccim`, rather than plain Claude Code with MCP alone, when the session must be wakeable.

Repository: [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude)

Restart or reload already-running harness sessions after installing or updating an adapter. All peers must use the same `PI_CODING_AGENT_DIR` to join the same local broker.

## How agents should use it

Agent Intercom Orchestrator is intended to enforce a clear operating protocol, not merely start several chat sessions.

1. **One manager owns the run.** The manager creates and stops persistent peers, assigns identities and exclusive lanes, resolves conflicts, and owns the final decision.
2. **Give every peer a role.** Typical roles are builder, challenger, verifier, or proof advisor. A role includes scope, permissions, acceptance criteria, and forbidden actions.
3. **Inspect inherited state first.** Before editing, workers report their branch, worktree status, existing commits, uncommitted files, and ownership boundary.
4. **Use independent evidence.** Builders attach tests, commands, files, commits, screenshots, or other artifacts to completion claims. Challengers identify concrete missing proof or defects rather than offering vague disagreement.
5. **Use `send` for work and progress.** Use `ask` only when the sender is blocked on a decision. An ask does not guarantee an immediate mid-turn interruption in every harness.
6. **Do not recursively create persistent peers.** Workers may use built-in subagents, but only the designated manager creates Pi, OpenCode, `coi`, `cci`, tmux, sidecar, or other persistent intercom instances unless ownership is explicitly delegated.
7. **Keep writing lanes exclusive.** Multiple agents may inspect the same work, but two implementation workers should not silently edit the same files or worktree.
8. **Maintain compact durable notes.** Rewrite the current goal, evidence, objections, decisions, and risks as the run evolves. Do not rely on an endlessly appended transcript surviving repeated compaction.
9. **Bound the loop.** Configure round, time, cost, and permission limits. Stop when the evidence contract passes, a real blocker is escalated, or a configured limit is reached.
10. **Clean up deliberately.** Verify worker processes, tmux sessions, sidecars, identities, queued messages, and worktree state before declaring the orchestration complete.

A minimal assignment should tell the worker:

```text
Role: builder | challenger | verifier
Goal and acceptance criteria: ...
Owned repository/worktree/files: ...
Allowed tools and access: ...
Forbidden reads/writes/external actions: ...
Required evidence: ...
Communication target: ...
Stopping or escalation rule: ...
```

The complete operational protocol, aliases, safe/yolo profiles, launch commands, proof-advisor pattern, and supervisor checklist are in [Creating and supervising Agent Intercom workers](docs/creating-and-supervising-worker-agents.md).

## What this is

Agent Intercom Orchestrator will launch and coordinate independent coding-agent sessions—initially Claude Code and Codex—through their wakeable Agent Intercom adapters.

Instead of making one model generate, review, and approve its own work, the orchestrator gives separate agents opposing responsibilities:

- a **builder** claims the task is complete
- a **challenger** looks for missing evidence, incomplete work, regressions, and unjustified claims
- an optional **verifier** runs the final checks and evaluates the artifacts
- the orchestrator keeps the exchange bounded, records decisions, and decides when the evidence satisfies the completion contract

The agents can use different model families, model versions, harnesses, prompts, and context histories. Those differences create useful variation and reduce the chance that one agent simply agrees with its own assumptions.

## Why cross-harness pairing

Subagents are useful for parallel work, but they still operate inside the parent harness and often inherit its framing, authority structure, and assumptions. Independent wakeable sessions are peers instead:

- each session has its own context and transcript
- either harness can wake the other after the user leaves
- a challenger can directly reject a builder's completion claim
- different model providers and harness behavior increase review diversity
- work can continue across several normal context compactions

The goal is not endless argument. The goal is to turn the tendency to answer, defend, correct, and seek the final word into additional verification pressure—then stop according to explicit limits and evidence.

## Planned loop

```text
1. Turn a task into a completion contract.
2. Launch or attach a wakeable builder.
3. Launch or attach a wakeable challenger.
4. Builder implements and submits a claim with evidence.
5. Challenger accepts the claim or returns concrete objections.
6. Builder fixes the work or disproves each objection.
7. Repeat until the evidence gate passes or a configured limit is reached.
8. Run an independent final verification step.
9. Produce a concise handoff containing results, remaining risks, and commands run.
```

An objection must be actionable. A completion claim must include evidence. Neither agent wins merely by replying last.

## Relationship to Ralph-style loops

This complements rather than replaces a Ralph loop.

A Ralph loop provides paced iteration, durable task notes, context resets, and periodic reflection inside a development process. Agent Intercom Orchestrator adds independent cross-harness pressure between those checkpoints. A future integration can run a challenger or cleanup pass between Ralph iterations or after a group of compactions.

Durable notes should be rewritten as the understanding improves rather than endlessly appended. That gives newly resumed agents a compact statement of the current task, evidence, objections, and unresolved risks.

## Prompt variation

The system should support controlled variation in:

- model provider and model version
- harness
- role instructions
- review order
- wording and tone
- context and note summaries

The working hypothesis is that variation can expose different failure modes. This repository will treat that as an engineering strategy to test, not as a guarantee about model psychology. Outcomes should be judged by reproducible checks and artifact quality.

## Urgency and interruption

Normal intercom messages may wait until a busy recipient reaches an idle point. The orchestrator should eventually support message priority and explicit checkpoints such as:

- `normal` — deliver at the next safe turn boundary
- `urgent` — surface immediately and request the earliest safe interruption
- `stop` — cancel or pause the current orchestration step

Harnesses differ in whether they can truly interrupt an active model turn. The orchestrator must report the actual delivery state rather than pretending an interruption occurred.

## Proposed CLI

The exact interface is still being designed. A likely shape is:

```bash
agent-intercom-orchestrator pair \
  --builder codex \
  --challenger claude \
  --task FEAT.md \
  --max-rounds 6

agent-intercom-orchestrator status
agent-intercom-orchestrator pause
agent-intercom-orchestrator resume
agent-intercom-orchestrator stop
```

Potential short command: `aio`.

## Safety and stopping rules

Every run should have explicit bounds:

- maximum rounds
- maximum elapsed time
- maximum model or token budget
- commands that require user approval
- a concrete completion contract
- escalation when agents remain deadlocked
- cancellation that reaches every managed worker

The orchestrator should stop when evidence passes—not when agents merely agree, and not only when one of them runs out of objections.

## Agent Intercom family

| Harness | Repository |
|---|---|
| Pi | [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode) |

The first implementation will target the wakeable Codex and Claude Code adapters. Pi and OpenCode support can follow through the same broker protocol.

## Origin and thanks

The Agent Intercom family grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness work builds on.

## Initial roadmap

- [ ] Define a versioned orchestration state format
- [ ] Define completion contracts, claims, objections, and evidence
- [ ] Detect installed Agent Intercom adapters
- [ ] Configure or launch wakeable Codex and Claude Code workers
- [ ] Implement bounded builder/challenger rounds
- [ ] Persist compact run notes across restarts and compactions
- [ ] Add independent verification commands
- [ ] Add pause, resume, cancellation, timeout, and budget controls
- [ ] Expose real delivery and interruption status
- [ ] Add Ralph-loop checkpoint integration
- [ ] Test same-model, cross-version, and cross-provider pairings

## Name

`agent-intercom-orchestrator` is intentionally broader than `debate` or `loop`: the project is responsible for setup, roles, wake behavior, evidence, lifecycle, limits, and future multi-harness workflows—not just agent argument.

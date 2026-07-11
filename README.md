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

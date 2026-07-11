# Why cross-harness agent orchestration works

This document turns the original working notes behind Agent Intercom Orchestrator into a testable engineering model. Some of the ideas began as observations from repeated use rather than formal claims about model behavior. The system should therefore measure results and require evidence instead of assuming the theory is always correct.

## The problem with one agent reviewing itself

A single coding agent can plan, implement, test, review, and declare its own work complete. That is convenient, but every phase shares much of the same framing:

- the same conversation history
- the same interpretation of the task
- the same model tendencies
- the same harness behavior
- the same mistakes carried through compaction summaries
- an incentive to reconcile new evidence with its earlier conclusion

Self-review still catches defects, but it is not independent review. Asking the same session to “double-check” often produces another explanation of why its existing answer is acceptable.

Built-in subagents improve parallelism, but they usually remain children of the same harness and parent workflow. The parent assigns their scope, receives their results, and decides what to trust. A child may challenge the parent, but the structure still encourages cooperation with the parent’s framing rather than sustained peer-level disagreement.

## Independent peers create useful pressure

Agent Intercom connects independent sessions as peers. Each can have its own:

- harness
- model provider and model version
- context window and compaction history
- system instructions and role
- repository view or worktree
- tools and permission boundaries
- completion criteria

The important property is not merely “multiple agents.” It is **independent responsibility**.

A builder is responsible for producing a working result. A challenger is responsible for finding unsupported claims, missing cases, regressions, and incomplete proof. Neither is subordinate to the other, and neither can close the task merely by asserting that it is done.

## Using the desire to respond

In practice, coding models tend to respond when another participant says that something is missing, incorrect, or insufficiently proven. The exact wording often matters less than creating a credible unresolved disagreement.

This can be useful:

1. The builder claims completion.
2. The challenger rejects a specific claim or asks for proof.
3. The builder either fixes the issue or produces stronger evidence.
4. The challenger inspects that evidence and looks for the next unsupported assumption.
5. The loop continues until an external completion contract is satisfied.

Different model providers or model versions often produce more varied objections than two copies of the same model. Different harnesses add another source of variation because they expose different tools, context, prompts, session mechanics, and interaction patterns.

This is a working hypothesis, not a scientific guarantee. The orchestrator should compare outcomes across pairings and record which objections led to real fixes.

## Why wording variation can matter

Models respond not only to the literal request but also to its framing, tone, ordering, and linguistic shape. Repeating the same polished review prompt can produce highly correlated answers. Variation may expose other continuations and therefore other checks.

Useful controlled variation includes:

- direct versus skeptical review language
- formal acceptance criteria versus conversational objections
- different ordering of evidence
- different model or provider families
- deliberate separation of context
- fresh summaries rewritten from the current evidence

The system does not need intentionally bad spelling to function, and it should not treat unusual wording as magic. The broader lesson is that prompt diversity can be an experimental input. Artifact quality, tests, and reproducible observations remain the output that matters.

## Why the loop must be bounded

The same tendency to continue responding can create an endless argument. More turns are not automatically better. Eventually agents can repeat objections, optimize for winning the exchange, or consume context without improving the work.

Every run therefore needs explicit bounds:

- maximum challenge rounds
- elapsed-time limit
- model/token/cost budget
- a completion contract
- evidence requirements
- a deadlock rule
- a human escalation path
- pause and cancellation controls

The system stops because the contract passes or a configured bound is reached—not because one model got the last word.

## Evidence beats agreement

Agreement is weak proof. Two agents can confidently agree on the same incorrect assumption.

A completion claim should cite artifacts such as:

- changed files and commit hashes
- clean worktree state
- tests, typechecks, builds, and lint output
- browser screenshots or exported sessions
- API responses and route coverage
- reproduction and regression checks
- known limitations and unverified areas

A challenger’s objection should also be concrete. “This seems wrong” is not enough. It should identify a claim, missing artifact, failing command, untested path, contradiction, or risk that can be investigated.

## Context compaction and durable notes

Long-running sessions eventually compact their context. Repeated compaction can distort priorities, preserve obsolete assumptions, or lose the reason behind a decision.

A Ralph-style loop helps by creating paced iterations, explicit task state, context resets, and periodic reflection. Agent Intercom Orchestrator should complement that structure rather than replace it.

A strong combined workflow is:

1. Run several bounded builder/challenger exchanges.
2. Rewrite—not merely append—the durable task notes.
3. Record current goals, accepted evidence, open objections, decisions, and risks.
4. Start the next Ralph iteration or context window from those notes.
5. Optionally use a different model or harness for a cleanup/review pass between iterations.

Rewriting notes matters because an endlessly appended log eventually becomes another noisy context. The durable document should represent the best current understanding.

## Why cross-harness peers differ from subagents

Built-in subagents remain valuable. They are excellent for scoped research, parallel implementation, and independent test execution inside one worker. They should not, however, be confused with persistent peer supervisors.

| Built-in subagent | Intercom peer |
|---|---|
| Created and controlled by a parent harness | Independent session with its own lifecycle |
| Usually scoped to one delegated result | Can maintain a long-running role and history |
| Parent decides how to interpret the result | Can directly challenge and message other peers |
| Shares more framing with the parent | Can use another harness, provider, or model |
| Good for parallel task execution | Good for supervision, challenge, and proof review |

The recommended pattern is hierarchical only at the instance boundary:

- the primary manager creates persistent peer instances
- each worker may use its own built-in subagents
- workers do not recursively create more persistent intercom workers
- one manager remains responsible for lifecycle, ownership, and stopping

## Interruptions and urgency

A message is not always an immediate interruption. A harness may be:

- idle and ready for a new turn
- busy in a tool call
- busy generating
- unable to inject into an active turn
- limited to a pending-message queue

Intercom must report actual delivery state. Future orchestration should distinguish:

- `normal`: deliver at the next safe turn boundary
- `urgent`: visibly request the earliest safe interruption
- `stop`: pause or cancel managed work

No adapter should claim it interrupted a model if the host only queued the message. The orchestrator can add more safe checkpoints, but host capabilities determine whether a true mid-turn interruption is possible.

## The intended outcome

The objective is not to make agents argue for entertainment. It is to increase the probability that incomplete work receives another serious pass before the user accepts it.

A successful run produces:

- a completed task or a precise blocker
- independent objections and their dispositions
- reproducible evidence
- explicit remaining risks
- a compact durable handoff
- no orphaned workers or hidden open items

That is the foundation for Agent Intercom Orchestrator: independent peers, controlled variation, evidence-driven disagreement, and bounded execution.

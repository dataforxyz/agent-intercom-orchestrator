# Why this works

AI models tend to keep going when someone tells them they are wrong, stopped early, missed something, or have not proved they are finished.

One agent says the work is done. Another says it is not. The first now has a reason to check again, defend the result, find proof, or make another attempt. The second has a reason to inspect that answer and respond again.

That pressure can carry the work past the point where one agent would normally stop.

## How I got to this understanding

I did not start with a multi-agent theory. I started by noticing that agents stopped before the work was actually finished.

At first I responded by explaining exactly what the agent had done wrong. I pointed out the missing work, the bad assumption, the check it had skipped, or the reason its claim of completion was false. The agent would respond to the criticism, inspect the task again, and often find or fix more work.

After doing that repeatedly, I started shortening the message. Instead of writing the full explanation again, I would say things such as:

- fix it
- you did not finish
- please finish
- you stopped early

Those shorter commands still made the agent continue.

Then I reduced it even further. I replied with literally `lol` or `:(`. I also tried swearing and other tiny signals that I did not accept the answer. Even when I did not explain the defect again, the agent would often reopen the problem, inspect its work, and find what it had skipped.

That progression changed how I understood what was happening. I went from a detailed explanation of the mistake, to a simple command to fix it, to almost no semantic instruction at all. The response still worked because the agent could tell that its answer had not been accepted and there was still something unresolved.

The model wanted to explain itself, correct the objection, prove it was finished, or have the last word. The detailed correction could help direct it, but the pressure to continue did not depend on the correction being long or carefully written.

I also noticed that wording changes the possible response. My normal typing includes strange punctuation, misspellings, and accidental splits such as `get sis` instead of `gets is`. The model would be unlikely to generate that exact wording for itself. That difference can push its next response onto another path.

Bad spelling is not magic, and prompts do not need to be unreadable. The point is that polished wording matters less than I first thought, and variation should not automatically be removed. We are trying to increase the possible outcomes in the right direction.

The next step was replacing my manual nudges with another agent. If one agent is trying to say the work is finished and another keeps saying it is not, they can create the same pressure for each other.

Testing that idea exposed the rest:

- the same model is more likely to agree with itself
- different model versions create more distance
- different model creators create more distance again
- different harnesses change behavior through their prompts, tools, context, and permissions
- built-in subagents do not challenge their creator in the same way
- long contexts eventually become unreliable, so Ralph-style resets are still needed

The orchestrator comes from that sequence. It automates the part that worked: keep useful disagreement alive long enough to force another real pass, then stop or reset before it becomes noise.

## Why different models and harnesses help

Two copies of the same model have similar tendencies and are more likely to agree. Different versions add some distance. Different providers add more.

Harnesses add another difference. Claude Code, Codex, Pi, and OpenCode give models different system instructions, tools, contexts, permissions, and session histories. Even the same underlying model can take another path in another harness.

More difference means more possible responses and a better chance that one agent notices what the other keeps missing.

## Why subagents are not the same

A subagent knows the parent created it to help with the parent’s task. The parent remains in charge, receives the result, and decides what to accept. That is useful for parallel work, but it does not create the same pressure as an independent peer.

A separate Claude, Codex, Pi, or OpenCode session has its own context and its own desire to answer. It can keep rejecting another agent’s claim instead of acting like a temporary helper.

Built-in subagents should still handle parallel research and implementation. They just do not replace an independent challenger.

## Give the agents opposing jobs

The simplest pairing is:

- the builder is trying to prove the work is finished
- the challenger is trying to prove that it is not

The builder supplies the result and evidence. The challenger looks for a missing case, weak claim, untested path, or reason the proof is not enough.

If the challenger is right, the builder returns to work. If the objection is wrong, the builder proves it. Either way, the work receives another serious check. The manager should not stop merely because the builder says `done`.

## Ralph is still needed

After enough context compactions, agents can become confused, repeat themselves, or lose the reasons behind decisions. Two agents arguing forever inside growing contexts does not solve that.

A better pattern is:

1. Let the agents challenge each other for several rounds.
2. Rewrite the notes with the current goal, evidence, objections, and decisions.
3. Remove stale explanations instead of endlessly appending messages.
4. Start the next Ralph context from those rewritten notes.
5. Optionally let another model perform cleanup between loops.

Ralph provides the resets. Intercom adds cross-model pressure between them.

## A manager controls the pressure

The desire to answer can also create a pointless endless argument. A manager must own the task, roles, proof, limits, and stopping rule.

Pi is currently the best manager because intercom is native and Pi can supervise messages, processes, worktrees, and other harnesses directly. OpenCode is next. Codex and Claude work well as workers and challengers, but their wake behavior relies more on wrappers, sidecars, headless turns, or Monitor.

## Intercom still needs better urgency

An agent can send an `ask` and wait while the receiver takes too long to notice it. The sender is held up even though the other agent has not reacted.

Intercom needs clearer priority:

- normal — wait for the next safe turn
- urgent — show it at the earliest possible point
- stop — pause or cancel the work

Not every harness supports a true mid-turn interruption. Queued, displayed, injected, and acted on are different states and should be reported honestly.

## The whole idea

1. One model says the work is done.
2. Another says it is not.
3. Both now have a reason to continue.
4. Different models and harnesses increase the possible responses.
5. More useful attempts create more chances to catch what was missed.
6. A manager and Ralph-style resets stop the process from becoming endless context garbage.

The system captures the model’s desire to answer and have the last word, then controls how long that pressure continues and whether it is still improving the work.

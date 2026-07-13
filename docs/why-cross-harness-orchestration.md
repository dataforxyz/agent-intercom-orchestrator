# I Got Tired of AI Saying It Was Done When It Wasn't

This whole thing started because AI kept stopping early.

It would do most of the task, then tell me it was finished. Codex would say would you like me to more. claude would say i finished and its the best. 

So I would explain what it did wrong. I would point out the part it skipped, the thing it didn't check, or why what it said was done was not actually done.

Then it would go back and usually find more work.

At first, I thought the explanation was what made it work. Like I had to understand the problem and write a good correction so the AI knew exactly what to fix.

But after doing this over and over, I got lazy. Instead of explaining everything again, I started queing stuff like:

- Fix it
- You didn't finish
- Finish the rest
- You stopped early

And that still worked.

Then I got even lazier and started saying literally `lol` or `:(`.

And somehow that worked too.

It would look at the work again. Sometimes it would explain why it thought it was done. Sometimes it would notice what it missed. Sometimes it would run another test or actually finish the part it skipped.

That is when I realized the exact thing I said was not always the important part.

The important part was that I did not accept the answer.

There was still something unresolved, and the AI wanted to respond to it. It wanted to explain itself, prove it was right, fix the problem, or just have the last word.

## So What If Another AI Does That Instead of Me?

Once I noticed this, I started thinking about how to keep it going without me dumb queing `lol` every time an agent stopped early.

One AI is trying to say the work is done. Another AI is trying to say no, it isn't.

Now they both have a reason to keep going.

One has to prove it finished. The other has to find what is still wrong. If the second one finds something, then the first goes back to work. If the second one is wrong, then the first still has to prove that.

Really, either answer is useful because it forces another pass.

This is not about making two agents politely agree with each other. Agreeing too fast is the problem.

We want one trying to finish and one refusing to believe it without proof.

So one agent is told this will be wrong get proof if it is right. The other is told this doesnt exsist or is broken make it work. 

## Using the Same Model Is Not as Interesting

If you use the same model against itself, it is probably more likely to agree with itself. It has the same habits and keeps reaching for the same kinds of answers.

Using different versions helps. 5.4 and 5.5 are not exactly the same, so there is at least some distance between the possible answers.

Using models from different creators should create even more distance. Claude and Codex are less likely to make the exact same choices for the exact same reasons.

Then the harness changes things again.

The same model inside Pi is not exactly the same as that model inside Codex, Claude Code, or OpenCode. The tools are different. The system prompts are different. The context is different. The permissions and project instructions are different. Even being in another project changes what the model is likely to do.

All of those differences increase the number of possible outcomes.

We don't need every answer to be correct. We less chance they are wrong the same way.

## Subagents Don't Do the Same Thing

Subagents are useful, but they know who is in charge.

The main agent created them and gave them a job. They report back to it. Even if they find something wrong, the main agent gets to summarize what they said and decide if it matters.

That is not the same as a completely separate Claude or Codex session that has its own context and wants to answer for itself.

A subagent helps its creator. A separate agent can keep telling the other agent it is wrong.

We should still use subagents for research and parallel work. They just don't replace the outside agent that is there to challenge the result.

## The Weird Way I Write Might Actually Help

This also made me think differently about spelling and punctuation.

I don't write like an AI. Sometimes I misspell stuff, don't use punctuation, or spli ta word in a we ird place.

An AI would probably never create that exact message for itself.

That means it changes the probability of what comes next. Even a tiny weird input can move the answer toward a path the model was not already going to choose.

I'm not saying bad spelling is magic. I'm saying we probably should not clean every prompt until every agent is talking in the same perfect AI voice.

What you say matters, but the way you say it also changes the possible answer.

## Ralph Is Still Better When This Gets Really Long

There is a limit to this.

After enough compactions, agents start getting weird. They forget why something happened, repeat old ideas, or get stuck inside a bad summary. Letting two giant contexts argue forever will eventually make both of them worse.

Ralph is still better for the long loop because it resets the context. A couple compactions in a single loop is just fine. I find 5-10 compactions when things start to get weird.

Intercom can be used between those resets. Let the agents go back and forth for a while. Then rewrite the notes with what is actually true now. Keep the goal, the proof, and the things that are still wrong. Remove the old garbage. Then start the next Ralph loop from that.

Another thing I want to test is having a different model do a cleanup between Ralph loops. Again, the point is to add another possible path before the next context starts.

## Somebody Still Has to Be the Manager

If both models want the last word, they can also argue forever about nothing. So you cant have them talk directly as if its the user. It has to be a tool call cause then they can both have the last word after talling each other they are done. 

So there still needs to be a manager that decides:

- What the actual task is
- Who is trying to finish it
- Who is trying to prove it is not finished
- What counts as proof
- When to make them stop
- When to rewrite the notes and start another loop

Right now, Pi is the best manager for this. Intercom is native, and incoming messages can become real visible turns. Pi can also watch the workers and the worktrees and stop things when they need to stop.

OpenCode is probably second because its plugin can inject the messages back into the session.

Claude and Codex work, but their implementations have more stuff in the middle. Codex needs the `coi` wrapper and App Server. Claude needs `cci`, headless `claude -p`, or the Monitor setup. They are still good workers and challengers. They just are not as clean for being the main manager.

## That Is the Idea

AI wants to answer.

If another AI says it is wrong, then it wants to answer even more.

Different models and different harnesses make it less likely they instantly agree with each other.

That creates more attempts, more possible outcomes, and more chances that one of them notices the work is not actually done.

Then the manager and the Ralph resets keep it from turning into endless garbage.

That's what I want the orchestrator to capture.

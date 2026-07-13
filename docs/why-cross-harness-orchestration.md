# i got tired of ai saying it was done when it wasnt

this whole thing started because ai kept stopping early.

it would do most of the task then tell me it was finished. so i would explain what it did wrong. i would point out the part it skipped or the thing it didnt check or why what it said was done was not actually done.

then it would go back and usually find more work.

at first i thought the explanation was what made it work. like i had to understand the problem and write a good correction so the ai knew exactly what to fix.

but after doing this over and over i got lazy. instead of explaining everything again i started saying stuff like:

- fix it
- you didnt finish
- finish the rest
- you stopped early

and that still worked.

then i got even lazier and started saying literally `lol` or `:(`.

and somehow that worked too.

it would look at the work again. sometimes it would explain why it thought it was done. sometimes it would notice what it missed. sometimes it would run another test or actually finish the part it skipped.

that is when i realized the exact thing i said was not always the important part.

the important part was that i did not accept the answer.

there was still something unresolved and the ai wanted to respond to it. it wanted to explain itself or prove it was right or fix the problem or just have the last word.

## so what if another ai does that instead of me

once i noticed this i started thinking about how to keep it going without me sitting there typing `lol` every time an agent stopped early.

one ai is trying to say the work is done. another ai is trying to say no it isnt.

now they both have a reason to keep going.

one has to prove it finished. the other has to find what is still wrong. if the second one finds something then the first goes back to work. if the second one is wrong then the first still has to prove that.

really either answer is useful because it forces another pass.

this is not about making two agents politely agree with each other. agreeing too fast is the problem.

we want one trying to finish and one refusing to believe it without proof.

## using the same model is not as interesting

if you use the same model against itself it is probably more likely to agree with itself. it has the same habits and keeps reaching for the same kinds of answers.

using different versions helps. 5.4 and 5.5 are not exactly the same so there is at least some distance between the possible answers.

using models from different creators should create even more distance. claude and codex are less likely to make the exact same choices for the exact same reasons.

then the harness changes things again.

the same model inside pi is not exactly the same as that model inside codex or claude code or opencode. the tools are different. the system prompts are different. the context is different. the permissions and project instructions are different. even being in another project changes what the model is likely to do.

all of those differences increase the number of possible outcomes.

we dont need every answer to be correct. we need more chances for one of the answers to find the thing everybody else missed.

## subagents dont do the same thing

subagents are useful but they know who is in charge.

the main agent created them and gave them a job. they report back to it. even if they find something wrong the main agent gets to summarize what they said and decide if it matters.

that is not the same as a completely separate claude or codex session that has its own context and wants to answer for itself.

a subagent helps its creator. a separate agent can keep telling the other agent it is wrong.

we should still use subagents for research and parallel work. they just dont replace the outside agent that is there to challenge the result.

## the weird way i write might actually help

this also made me think differently about spelling and punctuation.

i dont write like an ai. sometimes i misspell stuff or dont use punctuation or split a word in a weird place. i might type `get sis` when i meant `gets is`.

an ai would probably never create that exact message for itself.

that means it changes the probability of what comes next. even a tiny weird input can move the answer toward a path the model was not already going to choose.

im not saying bad spelling is magic. im saying we probably should not clean every prompt until every agent is talking in the same perfect ai voice.

what you say matters but the way you say it also changes the possible answer.

## ralph is still better when this gets really long

there is a limit to this.

after enough compactions agents start getting weird. they forget why something happened or repeat old ideas or get stuck inside a bad summary. letting two giant contexts argue forever will eventually make both of them worse.

ralph is still better for the long loop because it resets the context.

intercom can be used between those resets. let the agents go back and forth for a while. then rewrite the notes with what is actually true now. keep the goal and the proof and the things that are still wrong. remove the old garbage. then start the next ralph loop from that.

another thing i want to test is having a different model do a cleanup between ralph loops. again the point is to add another possible path before the next context starts.

## somebody still has to be the manager

if both models want the last word they can also argue forever about nothing.

so there still needs to be a manager that decides:

- what the actual task is
- who is trying to finish it
- who is trying to prove it is not finished
- what counts as proof
- when to make them stop
- when to rewrite the notes and start another loop

right now pi is the best manager for this. intercom is native and incoming messages can become real visible turns. pi can also watch the workers and the worktrees and stop things when they need to stop.

opencode is probably second because its plugin can inject the messages back into the session.

claude and codex work but their implementations have more stuff in the middle. codex needs the `coi` wrapper and app server. claude needs `cci`, headless `claude -p`, or the monitor setup. they are still good workers and challengers. they just are not as clean for being the main manager.

## intercom still has one problem here

sometimes an agent sends an `ask` then gets held up while the other agent takes forever to even know there is a message.

there should be more stop points and some way to say this message is urgent.

normal can wait for the next safe point. urgent should show up as soon as the harness can do it. stop should tell the worker to pause or cancel what it is doing.

not every harness can really interrupt the middle of a turn. that is fine but intercom should be clear about the difference between a message being queued and the agent actually seeing it.

## that is the idea

ai wants to answer.

if another ai says it is wrong then it wants to answer even more.

different models and different harnesses make it less likely they instantly agree with each other.

that creates more attempts and more possible outcomes and more chances that one of them notices the work is not actually done.

then the manager and the ralph resets keep it from turning into endless garbage.

thats what i want the orchestrator to capture.

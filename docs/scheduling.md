# How dates are planned and checked

Every job is a chain of steps. Each step has an owner and an estimate in hours. The tools server works out every date
and every Health value and writes them. The Delivery Planner, an AI agent in ClickUp, asks the server for them, calls
the server's write tools and explains the result in a comment. Its Instructions and Skills say it writes values only
through the Makers tools, never with ClickUp's own tools.

## Planning a new request

When a request reaches Delivery review, Rule 5b starts the Delivery Planner on its Skill "Plan the work". The agent
calls Plan new work. The server places each step in its owner's free time: their weekly capacity less the work already
booked on Intake and Projects. It fills at most 80% of each person's day and week. The other 20% is left unplanned for
rework and slips (the rework reserve).

- A step starts the working day after the step it waits on.
- A production step gets a window long enough that it takes at most half its owner's day.
- The send is the day the files go out: the start of the Deliver step.
- The Feasible date is the send plus two working days. The two days are the buffer.

Plan new work returns the plan with a plan key. The agent passes the key to Write plan. Write plan works the plan out
again and writes it only if it is the same plan: each step's start and due date, its estimate where the plan's differs,
an owner where the step has none, and the Feasible date on the card. It writes a first plan only. The agent then posts
one comment that explains the plan.

The Due date is the date promised to the client. People set it. No tool and no agent changes it.

## Once work has started

Steps stay on their planned days. Reschedule Dependencies is off in the Space, so changing one step's date moves only
that step.

## When the Health check starts

- Every Monday at 8:00 AM, on every project and retainer piece In progress and every approved job at To do. This is
  the Delivery Planner's schedule.
- When a step's due date changes (the Projects rule "Step due date changed: run the Health check").
- On a step's due date, when the step is still To do or Ready ("Step due today, not started: run the Health check").
- When the account lead changes Accepted overrun on a card ("Accepted overrun changed: run the Health check").
- When someone mentions the Delivery Planner on a card, or sends it a direct message, and asks for it.

## What the check does

The agent calls Forecast delivery. The server takes the open steps as they are on the cards and plays them forward,
in order, into each person's real free time, using the whole day. A step that has not started is placed no earlier
than its planned start. The server then compares that forecast with the cards and with the Due date.

## Health

Health is On track, At risk or Off track. Three things make it At risk or Off track:

1. **The send would miss the Due date.** The buffer is gone (the planned send is past the Due date), the forecast send
   lands after the Due date, the remaining work cannot be re-planned to fit, or the card is past its Due date and not
   yet delivered.
2. **A step has no owner, no dates, or is overdue.** A Team step counts as having no owner when no person is on it and
   it starts within two working days or has already passed its start.
3. **Headroom is under 10% of Budget.** Headroom below zero is Off track.

Rounds used and the client's sign-off wait are shown in the reading. They do not change Health.

The agent writes Health and Health reason with Set health. Set health reads each card again just before writing. A
card whose reading has changed since is not written; the agent calls Forecast delivery again for it.

## What the check says

- **Nothing.** The forecast matches the cards and the send lands by the Due date. A slip that fits inside the reserve
  is absorbed without a comment.
- **A Watch comment.** A step cannot happen on its planned day, but the send still lands by the Due date. There are
  three reasons: the owner's day is over-full, the owner has no room on the planned days, or the step is planned
  before the step it waits on ends. The comment names each step that must move, from which day to which day, and says
  "No date at risk." Health does not change. The server gives one Watch comment per job, covering every over-full
  day and person; the Health check Skill tells the agent to post it once for each over-full day and person.
- **A warning, with a fix.** The send would miss the Due date, or another of the three Health triggers holds. The
  agent posts a comment when Health gets worse or its reason changes. For lateness the comment names the job, the send
  against the Due date, the step that slips first, and the fix.

## The fix

Where jobs share a person's days, the server gives those hours first to the job with the least slack: the one whose
forecast send is closest to, or past, its Due date. Jobs with slack wait. A move is kept only if the job it saves then
sends by its Due date and no job that was on time goes late. The fix is given as the moves a person would make: each
card and step, from which day to which day.

For a late job that no reshuffle saves, the fallback gives its step to someone else on the step's Team. When nothing
works, the comment says so and the delivery lead decides.

## Who moves a date

The agent does not move a date on its own. Each fix Forecast delivery or Test a fix proposes is stored under a Fix
ref, derived from the card and every move, and the agent's warning or Watch comment carries that reference on its own
line. When the card's Delivery lead or a workspace owner replies "@Delivery Planner apply" to that comment, the agent
calls Apply fix with the Fix ref.

Apply fix reads that reply itself from ClickUp, looking through every comment on the card the fix is for. The reply
counts only on the agent's own comment that carries the Fix ref, and only when its words, trimmed and in any case, are
exactly "apply" or "@Delivery Planner apply"; a reply such as "do not apply" does not. It then checks that every stored
step still starts and ends on the days its move is from. If one does not, the cards have changed since the fix was
proposed and it writes nothing. Otherwise it writes each stored step's start and due date, by step id, and nothing
else, then writes the card's Health again. The agent posts the confirmation from its answer.

A rework chain is dated the same way: Plan rework works out the plan and Write rework plan writes the rework steps'
dates only if the plan is still the same.

## Situations people ask about

- **A step finishes late and nobody changes its date.** Nothing moves. The next step goes Ready when the late step
  completes. If a step is still not started on its due date, the check starts on that job.
- **A step finishes early.** The next step goes Ready sooner. No check starts.
- **Someone drags a step onto a full day.** Its due date changes, so the check starts. The Watch comment names the step
  that must move, or a warning gives the fix if the send would now miss the Due date.
- **Two jobs need the same days.** The fix works least slack first, as above, and lists every step move.
- **The delivery lead disagrees with the fix.** Nothing is applied. The lead moves steps by hand. Each due-date change
  starts the check again.

## Settings

These numbers are settings in the code. The Delivery Planner's Skills state several of them too; change both places
together.

| Setting | Value | Where it is changed |
| --- | --- | --- |
| Planning cap | 80% of each person's day and week | Written in several places: `tools-server/engine.js` (the plan default), `tools-server/tools.js` (Plan new work's `cap_pct` default, Capacity what-if's `capPct` default, the re-plan, and the tool text agents read). Change all of them together. |
| Buffer | 2 working days from the send to the Feasible date | `tools-server/engine.js`, `BUFFER_DAYS` |
| No owner window | 2 working days | `tools-server/tools.js`, `NO_OWNER_DAYS` |
| Client sign-off allowance | 3 working days, held in the Deliver step's window | `tools-server/data.js`, `SIGN_OFF_ALLOWANCE` |
| Headroom line | 10% of Budget | `tools-server/tools.js`, `HEADROOM_RISK` |
| Weekly hours of step work per person | Copywriter 40, Studio 40, Creative lead 22, Account lead 16 | `tools-server/data.js`, `CAPACITY` |
| Holidays | the dates listed | `tools-server/data.js`, `HOLIDAYS` |
| Time zone for counting days | Europe/London | `tools-server/wrangler.toml`, `TIME_ZONE`. The Monday client figures job checks for 07:30 in Europe/London directly (`tools-server/jobs.js`, `isRefreshTime`), and its crons in `tools-server/wrangler.toml` are set for London; changing `TIME_ZONE` does not move that job. |

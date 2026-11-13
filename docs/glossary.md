# Glossary

Terms the README, `docs/` and `agents/` use. Field names are the workspace's custom fields; `docs/workspace.md` lists
each with its type.

**Card.** A ClickUp task. A request is a card in the Intake List. A project card is a card at the top of the Projects
List. A Client card is a client's card in the Clients List.

**Step.** A subtask of a job that is one piece of delivery work: Write copy, Review copy, Design, Package files,
Internal review, Deliver; for video, Write script, Review script, Produce video (`STEP_NAMES` in
`tools-server/data.js`).

**Stage subtask.** One of the subtasks Confirm brief and scope, Verify delivery, Confirm and approve and Kick off
delivery (`STAGE_NAMES` in `tools-server/data.js`). They carry the sign-off checklists, not delivery work.

**Job.** Delivery work with its own Due date: a project card, a retainer piece or a change card.

**Retainer piece, month card.** A retainer client's work is grouped by month. A month card (task type Retainer month)
holds the month's money. Each piece of work under it is a retainer piece.

**Change card.** A request to change an existing project (Request kind Change), placed under that project.

**The send.** The day the files go out to the client: the start of the Deliver step.

**Re-walk, replay, recovery.** The open steps re-planned from today on their remaining hours in people's free time,
using the whole day, to see when the files would go out. Forecast delivery, Test a fix and Plan rework work this way.

**Headroom.** Budget plus Accepted overrun, minus the forecast cost (hours at the Rate plus Supplier cost). The server
works the forecast out task by task (`tools-server/tools.js`).

**Accepted overrun.** A money field on a project card. The account lead sets it to accept cost above Budget. It adds
to headroom. A change to it starts the Health check.

**Rework, Client rework, Internal rework, rework chain.** Rework is work redone. Client rework is a revision the client
asked for; its estimated hours at the Rate are added to the job's Budget once. Internal rework is the agency fixing its
own mistake; it stays a cost. The Rework field on a card says which (Client or Internal), and time entries carry the
tag `rework: client` or `rework: internal`. A rework chain is a rework card and the steps under it.

**Workload, Workload's method.** Workload is ClickUp's capacity view. Its method spreads a step's estimate evenly over
the working days from its start date to its due date. The server books hours the same way (`tools-server/data.js`).

**Team.** A ClickUp user group: Copy, Studio. A step can be assigned to a Team, and its hours count on the members'
time.

**Assignment role.** A dropdown on a step naming which lead on the card owns it: Creative lead or Account lead.

**Request kind, Agreement type, Job type.** Dropdowns on a request. Request kind: New project or Change. Agreement
type: Retainer, Fixed fee or Not sure. Job type: Launch, Social, Print, Web, Email or Video.

**The agency.** The outside design agency Makers buys design work from. Its packages, fees and turnaround are in the
Supplier operating agreement Doc.

**Turnaround, revision turnaround.** As the Supplier operating agreement states them: the working days from a complete
brief to final files, and the working days for one revision round.

**Project card fields.**

- *Original committed date*: the Due date at approval. Rule 8 sets it; Freeze baseline fills it when empty; Rule R1
  sets it on a month card.
- *Initial forecast*: the forecast cost at approval. Freeze baseline fills it when empty.
- *Delivered on*: set once by Rule E4a, when the card reaches Delivered.
- *Accepted on*: set once by Rule E4b, when the card reaches Complete.
- *Late by*: a formula, Delivered on less Original committed date, in days.
- *Sign-off days*: a formula, Accepted on less Delivered on, in days.
- *Days remaining*: a formula, the Due date less today, in days.
- *Rounds included*: the revision rounds the agreement includes. The Intake Advisor writes it.
- *Rounds used*: the revision rounds used so far. No rule, agent or tool writes it.

**Staff comment.** A comment posted from a person's account rather than by an agent.

**Plan key.** A fingerprint of a plan. Write plan and Write rework plan write only if a fresh calculation gives the
same fingerprint.

**Fix ref.** The reference of a fix a tool proposed: eight hex characters derived from the card the fix is for and
every step move in it. Forecast delivery and Test a fix store the fix under it for 14 days; Apply fix writes exactly
that fix, and only on an "apply" reply to the Delivery Planner's comment that carries the reference.

**The catch. In Stage flow, the working day before a rework's first step starts.

**Capacity Doc, the capacity tool.** The Delivery Planner's Skills name "the capacity tool, or the Capacity Doc". The
capacity tool is ClickUp's Get user schedule and capacity, on the Delivery Planner's profile. The workspace has no Doc
named Capacity. The server reads weekly hours from `CAPACITY` in `tools-server/data.js`.

**Pilot rollout.** A List holding the agency's own tasks for changes to how it works. No code, rule or agent reads it.

**Super Agent, Autopilot agent, Skill.** A Super Agent is a ClickUp AI agent with its own instructions and tools,
started by a mention, a direct message, a schedule or a rule. An Autopilot agent is an AI action inside one automation
rule. A Skill is a named set of instructions an agent follows, stored as a task in the Skills List.

**MCP, Brain.** MCP (Model Context Protocol) is the standard way an AI agent calls an outside tool. Brain is ClickUp's
AI feature set.

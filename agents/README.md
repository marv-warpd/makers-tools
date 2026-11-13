# The agents

Four AI agents work inside ClickUp. Two are Super Agents (AI → All Agents): ClickUp AI agents with their own
instructions and tools, started by a mention, a direct message, a schedule or a rule. Two are Autopilot agents: an AI
action inside one automation rule. `docs/glossary.md` defines the other terms used here. They are configured by hand in ClickUp. The files in this folder are copies of their text as it reads
in ClickUp. Editing a file here changes nothing in ClickUp.

Each `instructions.txt` is the agent's Instructions box. Each `skill-*.md` is a Skill. A Skill is stored as a task in
the workspace's Skills List; the file holds that task's description as the API returns it.

## Delivery Planner (Super Agent)

Description in ClickUp: "Plans delivery at Delivery review: hours, step dates and owners, the feasible date. Through
delivery, checks each live project's health. Advises the delivery lead."

| Part | Setting |
| --- | --- |
| Instructions | `delivery-planner/instructions.txt` |
| Skills | Plan the work (`skill-plan-the-work.md`), Health check (`skill-health-check.md`) |
| Manual triggers | Mention: on. Direct Message: on. Assign task: off. Meeting Notes shared: off. |
| Schedule | Weekly on Monday at 8:00 AM: "Run the Health check on every project and every retainer piece in the Projects List whose status is In progress, and the forecast on every approved job at To do." |
| Automations that start it | Rule 5b: Delivery review, run the Delivery Planner (Intake). Accepted overrun changed, Step due today not started, Step due date changed (Projects). See `docs/rules.md`. |
| ClickUp tools | Default tools, Post task comment, Get user schedule and capacity |
| Makers tools (17) | Apply fix, Capacity what-if, Client record, Estimate accuracy, Forecast delivery, Margin by client, On time rate, Plan new work, Plan rework, Price and terms, Retainer usage, Rework by cause, Set health, Test a fix, Time by step, Write plan, Write rework plan |
| Writes | Its Instructions and Skills say it writes values only through the Makers tools: the first plan through Write plan, a rework plan through Write rework plan, Health and Health reason through Set health, and a fix through Apply fix. Everything else it posts as a comment. |
| Knowledge | Lists: Intake, Projects, Clients. Doc: Supplier operating agreement. Chat: Clients. |
| Visibility | Public to all members |

## Intake Advisor (Super Agent)

Description in ClickUp: "Checks new requests at Intake review: inputs, scope, client, account lead, supplier cost and
advises the account lead."

| Part | Setting |
| --- | --- |
| Instructions | `intake-advisor/instructions.txt` |
| Skills | Scope and inputs check (`skill-scope-and-inputs-check.md`) |
| Manual triggers | Mention: on. Direct Message: on. Assign task: off. Meeting Notes shared: off. |
| Schedule | None |
| Automations that start it | Rule 4: Intake review, run the Intake Advisor (Intake) |
| ClickUp tools | Default tools, Post task comment, Update task |
| Makers tools (3) | Link client, Retainer usage, Price and terms |
| Knowledge | Lists: Intake, Projects, Clients. Docs: Supplier operating agreement, Makers price list. Chat: Clients. Web Search and ClickUp Help Center: off. |
| Memory | Recent, Preferences and Intelligence: off |
| Visibility | Public to all members |

## Handover Writer (Autopilot agent)

It lives inside the Projects rule named "Handover Writer".

| Part | Setting |
| --- | --- |
| Instructions | `handover-writer/instructions.txt` |
| Trigger | An existing task is moved to the Projects List (Tasks), and Request kind is New project |
| Knowledge | Projects, Intake |
| Tools | Edit tasks, Default tools |
| Starting point | The event service records the project's starting point at approval (Freeze baseline, through `POST /approved`; see the main `README.md`). The agent's first housekeeping job fills Initial forecast only if it is still empty. |

## Design Brief Writer (Autopilot agent)

It lives inside the Supplier briefs: staging rule named "Design Brief Writer".

| Part | Setting |
| --- | --- |
| Instructions | `design-brief-writer/instructions.txt` |
| Trigger | A task is created in Supplier briefs: staging (Tasks), source: Automations |
| Agent condition | "Act only on a task in this List whose Deliverables field is empty. Do nothing for any other task." |
| Knowledge | Projects, Supplier briefs: staging |
| Tools | Edit tasks, Default tools |

## What the server reads from the agents

Two pilot measures read the Super Agents' comments by display name. The names are set in `tools-server/data.js`
(`AGENTS`). Renaming an agent in ClickUp, or changing how it words a comment, changes those measures. See
`docs/tools.md`, Days of warning and Requests arriving complete.

The Skill texts state some of the same numbers the server uses: the two-working-day buffer, the 80% planning cap, the
three-working-day sign-off allowance, the 10% headroom line and the two-working-day No owner window. A change to one
of these numbers is made in both places: the constant in `tools-server` and the Skill in ClickUp.

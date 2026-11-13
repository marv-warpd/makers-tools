# Tool reference

The tools server (the Cloudflare Worker `makers-tools`, folder `tools-server/`) has 26 tools: 20 that read and 6 that
write. This page is written from the code. Each section names what a tool reads in ClickUp, what it returns, and one
example call. Terms such as card, step, job, headroom and re-walk are defined in [`glossary.md`](glossary.md).

## Calling the server

- **Address:** `POST https://makers-tools.<your-subdomain>.workers.dev/mcp`. Any other path gets 404.
- **Key:** `Authorization: Bearer <key>` or `X-API-Key: <key>`, compared with the `MCP_API_KEY` secret. Anything
  else gets 401, and so does every call while `MCP_API_KEY` is not set.
- **Methods:** after the key check, a request that is not `POST` gets 405. The server answers the JSON-RPC methods
  `initialize`, `ping`, `tools/list` and `tools/call`. A notification (no `id`) gets HTTP 202 with no body. A batch
  (a JSON array) gets an array of answers. An unknown method gets error `-32601`; an unknown tool gets `-32602`;
  a body that is not JSON gets `-32700`.
- **Protocol:** `initialize` answers with the protocol version the caller asked for when it is one of
  `2025-11-25`, `2025-06-18`, `2025-03-26` or `2024-11-05`, and `2025-06-18` otherwise.
- **Every answer is plain JSON.** The server opens no event stream.

## What every result holds

Every tool result has two parts, built by `result()` in `tools.js`.

- **The text** (`content[0].text`): the tool's readable lines, then `Basis: <how the figures are worked out>`, then
  `As of <date and time>`, then one closing sentence that ends with the tool's name in brackets, for example
  `(retainer usage)`. The closing sentence can be quoted as it stands.
- **The structured part** (`structuredContent`): the tool's own fields (listed per tool below), plus `cards` (the
  ids of the cards the answer is about, at most 100), `basis`, `as_of` and `summary` (the closing sentence).

The text names cards and steps by name. Ids appear in the structured part.

## Naming a card or a client

A tool that takes a client, project, request or rework card in words matches it with `matchOne` (`data.js`):

1. The card id, or a ClickUp reference to it (`task:<id>`, `#<id>`, or a task link).
2. The exact name.
3. The name, ignoring case.
4. A name that contains the words given, ignoring case.

The first step with exactly one match wins. More than one match at a step stops the call with
`"<words>" matches N <kind>s (<up to five names>); name one`. No match stops it with `No <kind> matches "<words>"`.

Two write tools use their own matching:

- **Apply fix** (`writes.js`) reads the Projects List only. It finds the card and steps of a fix by the ids stored
  under its Fix ref, never by name. A card named beside the Fix ref must be that card, by its id or its exact name.
  The moves given as a cross-check are read by `cardOf`: an id counts when it names a card at the top of the List;
  otherwise, among the open jobs on the List ([Test] cards left out), the exact name ignoring case, then a name that
  contains the words given, ignoring case. Exactly one match, or the call stops with `"<words>" matches more than one
  card; nothing was written` or `"<words>" is not a live card on the Projects List; nothing was written`.
- **Link client** (see its section).

## Pages

Four tools return a long list 25 rows at a time: On time rate (the late jobs), Rework by cause and Margin by client
(the rows) and Days of warning (the warnings).

- `page` asks for one page, from 0.
- The answer gives `page`, `pages`, `next_page` (null on the last page), the full count (`late_total`, `rows_total`
  or `flagged_total`) and `list_version`.
- `list_version` is a fingerprint of the whole list. It is the same on every page while the data does not change, so
  a reader of every page can tell when the list changed between pages.
- Every row is a complete total for its group. The text shows only the rows of the page asked for.

## [Test] cards

The [Test] limits and the preview switch below stay in the live server because they let a change be tried on test
cards, or on a preview of the cards, without touching real work.

A card whose name contains `[Test]` (any case) is not a job to the tools. It and everything under it are left out of
every list, count and per-job figure (`makeTree`, `data.js`). Link client leaves [Test] Client cards out of matching.

Time entries are treated in two ways:

- **Rework by cause, Reserve use and Work mix** leave out time logged on a task named [Test], on a [Test] card, or on
  anything under one (`onTest`, `data.js`). A time entry keeps its task's name, so an entry on a task named [Test]
  stays left out after that task is deleted.
- **The other tools** add each hour to the job it was logged under. Time on a step named [Test] under a job whose name
  lacks [Test] counts toward that job. Retainer usage and a retainer month card's margin count every hour on the month
  card and on every task under it, a [Test] piece included.

A [Test] card named by its id or its exact name can still be read by Forecast delivery, Test a fix, Plan new work and the
write tools that use them, so a write can be tried on it. Its dated steps book people's time like any card's.

## When a call fails

- **The server is busy.** At most `MAX_AT_ONCE` (6) calls work at once in one copy of the server. A call that cannot
  start within `TURN_WAIT_MS` (25 seconds), a call that waits more than `WAIT_MS` (25 seconds) for a shared read, and
  a call that meets ClickUp's rate limit (HTTP 429) get: `Makers tools are busy with other calls just now, so there
  is no answer yet; call again in a minute (<tool>).`
- **ClickUp fails.** Any other error reading or writing ClickUp gets: `Makers tools could not read ClickUp just now,
  so there is no figure; try again in a minute (<tool>).`
- **The call cannot be answered as asked** (a bad date, a name that matches two cards, a write refused): the text is
  the reason, followed by the tool's name in brackets.

Each of these comes back with `isError: true`.

## Older names

Three older tool names still answer and are not listed: `plan_request` (Plan new work), `project_health_inputs`
(Forecast delivery) and `rewalk_chain` (Test a fix). They are in `RENAMED` in `worker.js`.

## Shared reads

Calls that arrive together share one ClickUp read of each List, Doc and time-entry window. A read is kept for
`SHARE_MS` (30 seconds) in `data.js`. Set health, Write plan and Write rework plan clear the shared reads before they
read, so they see the cards as they are.

## Settings in the code

Each figure below is a setting. It is changed in the file named, and takes effect on the next deploy. Where a Skill in
ClickUp states the same figure, change the Skill too.

| Setting | Value | Where |
| --- | --- | --- |
| Weekly hours of step work per person (a Team is its members' hours) | Copywriter 40, Studio 40, Creative lead 22, Account lead 16, Delivery lead 0 | `CAPACITY`, `data.js` |
| A person's day | a fifth of the weekly hours | `dailyCapacity`, `data.js` |
| The client's sign-off allowance | 3 working days | `SIGN_OFF_ALLOWANCE`, `data.js` |
| Holidays (no step is planned on them) | a list of dates | `HOLIDAYS`, `data.js` |
| Workspace, Lists and Docs read | ids | `WS`, `LISTS`, `DOCS`, `data.js` |
| The agents' display names the pilot measures read | Delivery Planner, Intake Advisor | `AGENTS`, `data.js` |
| How long a shared read is kept; how long a call waits for one | 30 seconds; 25 seconds | `SHARE_MS`, `WAIT_MS`, `data.js` |
| The time zone days are counted in | Europe/London | `TIME_ZONE`, `wrangler.toml` `[vars]` |
| When the weekly client figures are written | Mondays 07:30 London | `isRefreshTime` in `jobs.js` checks 07:30 in Europe/London, written there and not read from `TIME_ZONE`; the two UTC crons in `wrangler.toml` `[triggers]` are the UTC times of 07:30 London |
| The Feasible date after the send (the buffer) | 2 working days | `BUFFER_DAYS`, `engine.js` |
| Hours short of a day's room that still count as fitting | 0.25 hours | `SLACK`, `engine.js`; `SLACK_H`, `tools.js` |
| The No owner window | 2 working days | `NO_OWNER_DAYS`, `tools.js` |
| The Cost check's At risk line | 10% of Budget | `HEADROOM_RISK`, `tools.js` |
| The rework reserve reported against | 20% of each week | `RESERVE`, `tools.js` |
| The planning cap | 80% of each day and week | written in several places, all changed together: the plan default in `engine.js` (`capPct`, 80 for plan, 100 for recovery); in `tools.js`, Plan new work's `cap_pct` default (`planRequestCore`), Capacity what-if's `capPct` default (`capacityReplay`) and the re-plan (`replanLive`); and the text the agents read in Plan new work's and Capacity what-if's descriptions and answers, Test a fix's `cap_pct` description and Reserve use's basis |
| The Rate used when a card has none | $65 an hour | `forecastOf`, `reworkByCause` and `marginByClient`, `tools.js` |
| The working day used to turn hours into days | 8 hours | `clientRecord`, `timeByStep` and `signOffFor`, `tools.js` |
| Rows a page | 25 | `PAGE_SIZE`, `tools.js` |
| The history the reads cover | 1 January 2026 to 60 days after today | `ALL_TIME`, `tools.js` |
| Too little history for the pilot measures | under 5 warnings; under 10 requests | `ENOUGH`, `tools.js` |
| The words that mark an input as not in | missing, not attached, not received | `MISSING`, `tools.js` |
| Job types the tools accept | Launch, Social, Print, Web, Email, Video | `JOB_TYPES`, `tools.js` |
| Calls that work at once; how long a call waits for its turn | 6; 25 seconds | `MAX_AT_ONCE`, `TURN_WAIT_MS`, `worker.js` |

A test switch, off unless set: three environment variables, none of them in `wrangler.toml` (`loadLive`, `tools.js`).

- `PREVIEW_REPLAN` set to `"1"`: every tool that reads live work reads the cards as a re-plan would leave them
  (`replanLive`) instead of as they are.
- `PREVIEW_REPLAN_MODE` set to `"rule"`, with `PREVIEW_REPLAN` on: the cards as the smallest move that puts each step
  after the one it waits on would leave them (`ruleFix`).
- `PREVIEW_DUE`, with `PREVIEW_REPLAN` on: a JSON object of card id to a Due date (YYYY-MM-DD) read in place of the
  card's own.

The write tools read the same state: Set health, Write plan and Write rework plan work out their figures through the
same read (`liveWork`), so with the switch on they would write values worked out on the preview.

---

## Planning and forecasting

### forecast_delivery (Forecast delivery)

Every Health check reading for one job, or for every live job at once.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `project` | string | with no `all_live` | The job, by card id or the words in its name | |
| `all_live` | boolean | no | True: every card In progress (projects and retainer month cards) and every approved job at To do | false |

**Reads:** the Projects and Intake Lists with their subtasks, the workspace's Teams and their members, the Clients
List, and the Supplier operating agreement Doc. For a retainer month card, the time entries.

**The checks.** Each check has a level: `clear`, `At risk`, `Off track`, `note`, `not scored` or `not checked`.

- **Buffer:** the planned send (the Deliver step's start) against the card's Due date. Past the Due date: At risk.
- **Forecast:** the open steps played forward on each person's free hours, day by day, at 100%. A forecast send after
  the Due date: At risk, with the first step that breaks.
- **No owner:** a step still on its Team with no person whose start date is today or past, or falls within
  `NO_OWNER_DAYS` working days: At risk. The check reads the start date, not whether work has begun.
- **No dates:** an open step with no start or due date on a card In progress: At risk.
- **Overdue step:** a step past its due date and not Complete, or due today with no time tracked and not In
  progress. While the send still fits by the Due date with the buffer intact it is a note. It is At risk when the
  buffer is gone, and also when the buffer is intact but the forecast send misses the Due date; in both cases its
  detail ends "the buffer is gone".
- **Recovery re-walk:** worked out when the buffer is gone or a step is overdue or unstarted on its due day. The
  files go out after the Due date: Off track. They go out by it with the buffer gone: At risk, with the recovery plan.
  They go out by it with the buffer intact: a note.
- **Cost:** on a fixed-fee card and a retainer month card. Headroom below zero: Off track. Headroom under
  `HEADROOM_RISK` (10%) of Budget: At risk. A retainer piece is not scored: its money is on its month card.
- **Overdue:** the card is past its Due date and not Delivered or Complete: Off track.

An approved job at To do (or Ready) is read for the Buffer and the Forecast only.

**Health by the checks:** Off track if any check is Off track, else At risk if any is At risk, else On track. Health
is At risk or Off track only when the send would miss the Due date, a step has no owner, no dates or is overdue, or
headroom is under 10% of Budget. Rounds used, rounds included and the client's sign-off wait are figures in the
reading. They are not Health.

**The fix it suggests (least slack first).** Where jobs late on the forecast share a person's days with other live
jobs, those jobs are played forward together, the job with the least slack first, no step before its planned start.
A late job is kept in the reshuffle only if it then sends by its Due date and no job that was on time goes late. A
late job left out: its step that breaks is given to someone else on the step's Team, one job after another. When
nothing works, the answer says no reshuffle saves it and the Delivery lead decides. The reshuffle is given as the
drags a person makes on the cards: card, step, from day to day.

**The Fix ref.** A fix this tool proposes is stored so Apply fix can write exactly it: for each late job the reshuffle
saves, the reshuffle's drags; for a job with a Watch comment, that comment's moves. Each is stored for 14 days in the
Workers KV namespace bound as `FIXES` (`fixes.js`) under a Fix ref, eight hex characters derived from the job's card
and every move (card id, step id, from start, from due, to start, to due). The same fix proposed again keeps its Fix
ref and its 14 days restart; a different fix gets a different one. The text gives the Fix ref with the moves it
covers. Without the `FIXES` binding the answer is the same, with no Fix ref and the reason.

**The Watch comment.** When the send still lands by the Due date but a step cannot happen on its planned day (its
owner's day is over-full, there is no room on its planned days, or it is planned before the step it waits on ends),
the answer carries a Watch comment. It names each step that must move, from which day to which day, then "No date
at risk." and "Tidy this in Workload so new work is planned against real days." Health is not changed by it.

**Returns, one job:** `card`, `id`, `status`, `client`, `agreement`, `kind` (project or retainer piece; `month_card`
for a piece), `forecast_only`, `delivery_lead`, `health_by_the_checks`, `tripped` (the checks At risk or Off track),
`checks` (each `check`, `level`, `detail`), `notes`, `watch` (its `comment`, `overfull` and `steps`, or null),
`step_days` and `step_lines` (each remaining step's planned day against the replay's), `due_date`,
`original_committed_date`, `planned_send`, `buffer_gone`, `buffer_working_days`, `deliver_due`, `days_remaining`,
`rewalk` (the send, the Feasible date, the first step that breaks, the verdict, and `recovery_plan` when a trigger
fired), `steps`, `rounds_used`, `rounds_included`, `rework`, `money`, `suggestion`, `least_slack_first` (its `drags`
carry `card_id` and `step_id`), `fix_ref` (or null) and `fix_moves`. A retainer
month card returns its Cost check, `money` (with the allowance hours) and `pieces`.

**Returns, all live:** `projects` (one record a job, the worst first: a short record when On track; what tripped, the
suggestion and the step lines when not; `watch_comment` and `fix_ref` where there is one), `least_slack_first`, and `team_weeks`
(each person's next four weeks, hours booked against capacity).

**Example:**

```json
{ "project": "Client W winter coats" }
```

### test_a_fix (Test a fix)

What a change (another owner for a step, or new dates) would do to a job's send and to every other live job. It
changes nothing in ClickUp. A change of dates only (no new owner, each step once) is stored as a fix under a Fix ref,
as Forecast delivery stores its fixes, so Apply fix can write exactly it.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `project` | string | yes | The job, by card id or the words in its name | |
| `what_if_step` | string | no | The step to change | |
| `what_if_owner` | string | no | The person to give it to | |
| `what_if_start` | string | no | The day it moves to start, YYYY-MM-DD; its due date moves with it | |
| `changes` | array | no | Up to three changes tried together: each `step`, and optional `project`, `owner`, `start`, `due` | |
| `from_date` | string | no | Start the forecast on this date, YYYY-MM-DD | today |
| `cap_pct` | number | no | Share of each person's week that can be booked, 10 to 100 | 100 |

The change is made to a copy of the cards. A moved step keeps its working days. A step given to someone is taken off
its Team. Only the steps named change: the steps that wait on a moved step keep their dates. The forecast is then
worked out on the copy the same way Forecast delivery works it out. An owner must be a person in `CAPACITY` with
hours. A month card is refused: name one of its pieces.

**Reads:** the Projects and Intake Lists with their subtasks, the Teams, and the Supplier operating agreement Doc.

**Returns:** `project`, `id`, `cap_pct`, `changes` (each change as made), `as_is` and `what_if` (each the send, the
Feasible date, the days past the Due date, the first step that breaks and every step's dates with its reason), and
`other_jobs` (`jobs_checked`, `made_late`, `brought_back`, `sends_moved`), `fix_ref` and `fix_moves` (the stored
moves), or `fix_ref` null and `no_fix_ref` (why: a new owner, or a step changed twice). With no change asked for, it
returns the job's re-walk from today (`as_is`).

**Example:**

```json
{ "project": "Client W winter coats", "what_if_step": "Package files", "what_if_owner": "Creative lead" }
```

### plan_new_work (Plan new work)

A plan for a new request's steps on the team's free time, and its Feasible date. It changes nothing.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `request` | string | yes | The request, by card id or the words in its name | |
| `start_date` | string | no | Plan from this date, YYYY-MM-DD | today |
| `cap_pct` | number | no | Share of each person's day and week to plan to, 10 to 100 | 80 |
| `keep_estimates` | boolean | no | Use the estimates on the card instead of sizing from finished jobs | false |

The rules (the Skill Plan the work):

- Each step starts the working day after the step it waits on finishes, in its owner's free time each day, at no more
  than the cap's share of the day and of the week.
- A production step's window is long enough that it takes no more than half its owner's day. A review takes one
  working day.
- The agency's window is one working day to release the brief plus the package's turnaround from the Supplier
  operating agreement. The package is the one whose price equals the card's Supplier cost.
- Deliver's window is the files going out (the send), then the 3-day sign-off allowance.
- The Feasible date is the send plus two working days.
- Step hours: the average logged on that step across at least three finished jobs of the same job type at the same
  price, else of the same job type, rounded to a quarter hour; else the estimate on the card.
- The client's average sign-off time over its last six finished projects is given as advice. It changes no date.

The request is matched among the open cards in Intake and the open cards in Projects.

**Reads:** the Projects and Intake Lists with their subtasks, the Teams, the time entries, and the Supplier operating
agreement Doc.

**Returns:** `request`, `id`, `plan_key`, `cap_pct`, `start`, `meets_requested`, `client_sign_off`, and the plan:
`send`, `planned_send`, `feasible_date`, `sign_off_ends`, `due_date`, `requested`, `working_days_send_past_due_date`,
`working_days_feasible_past_requested`, `first_step_that_breaks`, `send_moves_working_days`, and `steps` (each
`step`, `owner`, `hours`, `size`, `start`, `due`, `planned_start`, `planned_due`, `late`, `reason`). The text ends
with the plan key to pass to Write plan.

**Example:**

```json
{ "request": "Client B spring launch" }
```

### plan_rework (Plan rework)

A plan for a rework card's steps with the project's other open steps, and whether the project's Due date still
holds. It changes nothing.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `rework` | string | yes | The rework card, by card id or the words in its name | |

The rework card is an open card under a project, with "rework" in its name and steps under it. The plan works from
today on the remaining hours in people's actual free time, day by day, at up to 100%. A rework's Design step takes the
agency's revision turnaround for the job's size from the Supplier operating agreement.

**Reads:** the Projects and Intake Lists with their subtasks, the Teams, and the Supplier operating agreement Doc.

**Returns:** `rework`, `id`, `plan_key`, `project`, `project_id`, `rework_done_by`, `due_date_holds`, and the plan
fields listed under Plan new work. The text ends with the plan key to pass to Write rework plan.

**Example:**

```json
{ "rework": "Internal rework: web" }
```

### capacity_what_if (Capacity what-if)

What changes if a person or a Team works different weekly hours.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `who` | string | yes | A Team (for example "Studio") or a person (for example "Copywriter") | |
| `hours` | number | yes | Weekly hours, 0 to 80: the person's, or each member's for a Team | |

Every live job (In progress, and approved at To do) is played forward twice: with today's weekly hours and with the
hours asked for. A person must be in `CAPACITY` with hours; a Team is matched by name among the workspace's Teams.

**Reads:** the Projects and Intake Lists with their subtasks, the Teams, and the Supplier operating agreement Doc.

**Returns:** `who`, `owners`, `hours`, `hours_now`, `jobs_moved` (each job whose send moves: `send_before`,
`send_after`, `working_days`, `due_date`, `late_before`, `late_after`), `weeks` (the next eight weeks: hours booked,
hours now, hours asked, and the new work that fits at the 80% cap), `new_work_fits_hours` and
`new_work_fits_hours_now`.

**Example:**

```json
{ "who": "Studio", "hours": 32 }
```

---

## Client and money figures

### retainer_usage (Retainer usage)

Hours logged in a month on a retainer client's work, against the allowance on its Client card.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | yes | The client, by the name on its Client card or the card id | |
| `month` | string | no | The month, YYYY-MM | this month |
| `add_hours` | number | no | A new request's estimated hours, to see where the month would land | |

The month card (`Retainer month: <client>, <month>`, matched by its due date) holds the month. Every hour logged on it
and on the pieces under it counts, whenever it was logged. Still planned: the estimates on the open steps under it.
Hours on steps under an Internal rework chain are left out and counted apart. With no month card, the hours dated in
the month on the client's retainer pieces count, and the answer says so. The trend is the last three finished months'
average usage minus the three before, in points; there is none with fewer than six finished months. A client with no
Allowance gets an answer saying so.

**Reads:** the Clients List, the Projects List with its subtasks, and the time entries.

**Returns:** `client`, `month`, `allowance`, `hours_logged`, `used_pct`, `hours_over`, `planned_open_hours`,
`expected_month_hours`, `internal_rework_hours_left_out`, `with_request_hours`, `basis_used` (month card or entry
dates), `month_card`, `pieces`, `trend`, `finished_months`.

**Example:**

```json
{ "client": "Client B", "month": "2026-10" }
```

### client_record (Client record)

A client's last finished projects: on time or late, sign-off days, revision rounds and rework.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | yes | The client, by the name on its Client card or the card id | |
| `job_type` | string | no | Only this job type | |
| `last` | integer | no | How many finished projects to read, newest first, 2 to 12 | 6 |

Only finished projects with a Late by value count. Sign-off days: the card's Sign-off days field, else the Deliver
step's window less its own work at 8 hours a day. With fewer than two finished projects there is no record yet, and
the answer says so.

**Reads:** the Clients List and the Projects List with its subtasks.

**Returns:** `client`, `job_type`, `projects` (each `card`, `id`, `job_type`, `delivered`, `late_by`,
`sign_off_days`, `rounds_used`, `rounds_included`, `rework`, `reworked`), `on_time`, `late`,
`average_sign_off_days`, `sign_off_allowance_days`, and `flags` (`slow_sign_off`, `rounds_used_up_on_most`).

**Example:**

```json
{ "client": "Client G" }
```

### on_time_rate (On time rate)

How often finished projects landed on the date agreed with the client.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | no | One client | all clients |
| `job_type` | string | no | Only this job type | |
| `from`, `to` | string | no | YYYY-MM-DD, by the day the work was delivered | |
| `group_by` | string | no | `month`, `client` or `job_type` | `month` |
| `page` | integer | no | Which page of the late jobs | 0 |

On time means the card's Late by is zero or less. A project is dated by Delivered on, else the day it was closed.

**Reads:** the Projects List with its subtasks; the Clients List when a client is named.

**Returns:** `client`, `job_type`, `group_by`, `rows` (every group: `group`, `on_time`, `finished`, `share`,
`late_jobs`, `late_days`), `on_time`, `finished`, `late` (this page's late jobs: `card`, `id`, `client`, `late_by`),
`late_total`, `page`, `pages`, `next_page`, `list_version`.

**Example:**

```json
{ "group_by": "client", "page": 0 }
```

### rework_by_cause (Rework by cause)

Rework hours and their cost, split into client revisions and internal rework.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | no | One client | all clients |
| `step` | string | no | One step, for example "Package files" | |
| `job_type` | string | no | Only this job type | |
| `from`, `to` | string | no | YYYY-MM-DD, by the day the hours were logged | |
| `group_by` | string | no | `client`, `step` or `job_type` | `client`, or `step` when one client is named |
| `page` | integer | no | Which page of rows | 0 |

Hours count when the time entry carries a tag starting "rework" (`rework: client` or `rework: internal`). They are
costed at the project's Rate, $65 where none is set. Hours on [Test] cards are left out (see [Test] cards).
Completeness: the rework steps (named "Rework: ...", or under a Client or Internal rework card) with time logged, and
how many have no entry with a cause tag.

**Reads:** the Projects List with its subtasks and the time entries; the Clients List when a client is named.

**Returns:** `client`, `job_type`, `step`, `group_by`, `completeness` (`rework_steps_with_time`,
`without_cause_tag`, `untagged_hours`), `totals` (`client_h`, `client_usd`, `internal_h`, `internal_usd`), `rows`
(the same four figures per group), `rows_total`, `page`, `pages`, `next_page`, `list_version`.

**Example:**

```json
{ "client": "Client K" }
```

### margin_by_client (Margin by client)

Price, cost and margin by client, job type or agreement type, lowest margin first.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | no | One client | all clients |
| `from`, `to` | string | no | YYYY-MM-DD | |
| `state` | string | no | `live`, `finished` or `all` | `all` |
| `group_by` | string | no | `client`, `job_type` or `agreement_type` | `client` |
| `page` | integer | no | Which page of rows | 0 |

Fixed-fee projects with a Price: Price against the hours logged on the project and its steps at its Rate ($65 where
none is set), plus Supplier cost. Retainer clients: their month cards that have pieces under them, the month's Price
against the same cost. From and to read a project by its Delivered on date and a month card by its due date.

**Reads:** the Projects List with its subtasks and the time entries; the Clients List when a client is named.

**Returns:** `client`, `state`, `group_by`, `rows` (each `group`, `projects`, `retainer_months`, `price`, `cost`,
`margin`, `margin_pct`; `client` when grouped by client), `rows_total`, `page`, `pages`, `next_page`,
`list_version`, `total` (`price`, `cost`).

**Example:**

```json
{ "state": "finished", "group_by": "job_type" }
```

### estimate_accuracy (Estimate accuracy)

The first forecast at approval against the cost at close, on finished work.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `job_type` | string | no | Only this job type | |
| `client` | string | no | One client | all clients |
| `from`, `to` | string | no | YYYY-MM-DD, by the day the work was delivered | |

Finished projects with an Initial forecast and a Rate count. Cost at close: every hour logged on the project and its
steps at its Rate, plus Supplier cost. A positive gap is an overrun.

**Reads:** the Projects List with its subtasks and the time entries; the Clients List when a client is named.

**Returns:** `client`, `job_type`, `projects`, `average_gap_pct`, `by_job_type`, `by_month` (each `group`,
`projects`, `average_gap`), `largest_overruns` (the five largest: `card`, `id`, `job_type`, `month`,
`initial_forecast`, `cost_at_close`, `gap`).

**Example:**

```json
{ "job_type": "Launch" }
```

### estimate_accuracy_by_step (Estimate accuracy by step)

Hours estimated against hours tracked on every step that has both, grouped, worst first.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `client` | string | no | One client | all clients |
| `step` | string | no | One step | |
| `job_type` | string | no | Only this job type | |
| `from`, `to` | string | no | YYYY-MM-DD, by the step's last day of logged time, else the day it closed, else its due date | |
| `group_by` | string | no | `kind`, `job_type`, `step`, `client`, `owner` or `month` | `kind` |

The figures are each step's own Time estimate and Time tracked. Kind of work: the step's Rework label (Client: client
revisions; Internal: internal rework), else a parent with Request kind Change (changes), else a retainer piece, else
new projects. Owner: the person on the step, else its Team. Stage subtasks and retainer month cards are left out.

**Reads:** the Projects List with its subtasks and the time entries; the Clients List when a client is named.

**Returns:** `client`, `job_type`, `step`, `group_by`, `totals` and `rows` (up to 25; each `group`, `steps`,
`hours_estimated`, `hours_tracked`, `gap_hours`, `gap_pct`).

**Example:**

```json
{ "group_by": "step", "from": "2026-03-01", "to": "2026-03-31" }
```

### time_by_step (Time by step)

Hours logged against hours estimated on finished work, step by step, and how long each step waits.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `job_type` | string | no | Only this job type | |
| `client` | string | no | One client | all clients |
| `from`, `to` | string | no | YYYY-MM-DD, by the day the work was delivered | |

A step's wait is the days it was given minus the days its estimate needed, at 8 hours a day.

**Reads:** the Projects List with its subtasks and the time entries; the Clients List when a client is named.

**Returns:** `client`, `job_type`, `rows` (each `step`, `hours_logged`, `hours_estimated`, `steps`,
`average_wait_days`).

**Example:**

```json
{ "job_type": "Launch", "client": "Client B" }
```

---

## Leadership and pilot measures

### reserve_use (Reserve use)

Rework hours as a share of each person's and Team's week, month by month, against the 20% held back for it.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `from_month` | string | no | The first month, YYYY-MM | six months to the last |
| `to_month` | string | no | The last month, YYYY-MM | this month |

Rework hours are time entries with a tag starting "rework". Hours on [Test] cards are left out (see [Test] cards).
Each person's capacity is their `CAPACITY` hours over the month's working days. A Team is its members together.

**Reads:** the time entries, the Teams and the Projects List with its subtasks (to find the [Test] cards).

**Returns:** `months` (`from`, `to`), `reserve_pct`, `overall_pct`, `overall_by_month`, `people` and `teams` (each
`name`, `members`, `team`, `rework_hours`, `capacity_hours`, `share_pct`, `last_three_months_pct`, `peak_month`,
`peak_pct`, `months`).

**Example:**

```json
{ "from_month": "2026-05", "to_month": "2026-10" }
```

### work_mix (Work mix)

Where each person's and Team's logged hours go: new projects, changes, retainer pieces, client revisions and internal
rework.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `from_month` | string | no | The first month, YYYY-MM | six months to the last |
| `to_month` | string | no | The last month, YYYY-MM | this month |

Kind of work: a `rework: client` tag is client revisions and any other rework tag internal rework; else work under a
retainer month card, or on a Retainer card, is retainer pieces; else work under a card with Request kind Change is
changes; else new projects. Hours on [Test] cards are left out (see [Test] cards). Hours on tasks outside the
Projects List are counted apart.

**Reads:** the time entries, the Teams and the Projects List with its subtasks.

**Returns:** `months`, `kinds`, `people` and `teams` (each `name`, `members`, `team`, `total_hours`, `kinds` with
`hours` and `share_pct`), `hours_not_placed`.

**Example:**

```json
{ "from_month": "2026-10", "to_month": "2026-10" }
```

### stage_flow (Stage flow)

Where work waits, step by step, on finished projects and the finished changes under them.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `job_type` | string | no | Only this job type | |
| `from`, `to` | string | no | YYYY-MM-DD, by the day the work was delivered | |

A step can start the working day after the step before it finishes. Review copy (and Review script, counted as Review
copy) can start the same day. Internal review is an ordinary step. Its wait is the working days from then to its
start. This is Stage flow's rule only: planning starts every step, reviews included, the working day after the step
it waits on. The bottleneck is the Makers step where the most work waits two working days or more;
Design is the agency's window and Deliver ends in the client's sign-off, so neither counts as a Makers step. Rework
pace: finished rework cards, working days from the catch to the last fix. Delivery days: working days from kick-off
(the first step's start, or the day the Kick off delivery subtask closed if earlier) to Delivered on, by job type.
Retainer pieces are left out.

**Reads:** the Projects List with its subtasks, the time entries, and the comments on the step with the longest
single wait and on its card.

**Returns:** `job_type`, `projects`, `steps` (each `step`, `steps`, `waits_2_plus_pct`, `median_wait_working_days`,
`median_elapsed_working_days`, `median_hours`, `kind`), `rework_pace`, `bottleneck`, `delivery_days_by_job_type`,
`longest_wait` (with the first comment written during it as `cause`, or null).

**Example:**

```json
{ "job_type": "Launch" }
```

### days_of_warning (Days of warning)

A pilot measure: how far ahead of the Due date the Health check warned, warning by warning, and how long each warning
took to clear.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `from`, `to` | string | no | YYYY-MM-DD, by the day each warning opened | |
| `page` | integer | no | Which page of the warnings | 0 |

The cards read are every job with Health set. A warning opens on a comment or thread reply by the Delivery Planner
(the name in `AGENTS`) that carries At risk or Off track, "will send N working days late", or "sends <date>, N
working days after the <date> promise", and does not say the job is now or back On track. It closes on the Planner's
first later comment saying the job is On track. A flag after that opens a new warning. Days to clear: working days
from the warning to the clear, or to the send (Deliver's start) if the files went out first; none while still open. A
staff comment counts as the Planner's when it opens with "Health check, <day> <month> <year>:", and is read on that
date. Each finished job counts once for "still sent on time". Below 5 warnings the answer says there is too little
history.

**Reads:** the Projects List with its subtasks, and each scored card's comments (the latest 25 top-level comments and
their replies).

**Returns:** `jobs_scored`, `from`, `to`, `flagged` (this page: `card`, `id`, `episode`, `flagged_on`, `due_date`,
`days_of_warning`, `back_on_track_on`, `send_date`, `days_to_clear`, `outcome`, `finished`, `on_time`),
`flagged_total`, `jobs_flagged`, `page`, `pages`, `next_page`, `list_version`, `median_working_days_of_warning`,
`median_working_days_to_clear`, `outcomes`, `flagged_finished`, `still_sent_on_time`, `share_still_on_time_pct`,
`enough_history`, `enough_history_to_clear`.

**Example:**

```json
{ "from": "2026-03-01", "to": "2026-03-31" }
```

### requests_arriving_complete (Requests arriving complete)

A pilot measure: of the requests each month, how many the Intake Advisor's first comment found complete.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `month` | string | no | One month, YYYY-MM | every month |

The requests are every card in Intake and every card at the top of Projects, live or finished. A request is complete
when no line of the Intake Advisor's first comment on it says "missing", "not attached" or "not received". A request
counts in the month of that comment. A staff comment counts as the Advisor's when it opens with "Received <day>
<month> <year>:", and is read on that date. Below 10 requests the answer says there is too little history.

**Reads:** the Projects and Intake Lists with their subtasks, the Teams, and each request's comments (the latest 25
top-level comments and their replies).

**Returns:** `month`, `rows` (each `month`, `complete`, `requests`, `share_pct`), `complete`, `requests`,
`enough_history`, `by_request` (up to 25).

**Example:**

```json
{ "month": "2026-10" }
```

### monthly_review (Monthly review)

The month's leadership review in one answer, each section with its sentence and the calls its figures came from.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `month` | string | no | The month, YYYY-MM | last month |

It calls the other read tools for the month and returns their answers together:

- **On time:** On time rate by month over six months, and by job type for the month.
- **Margin, finished work:** Margin by client, by client, job type and agreement type.
- **Rework:** Rework by cause, by client, step and job type, with the completeness count.
- **Estimate accuracy:** Estimate accuracy by step, by kind, job type and step.
- **Delivery days** and **Where work waits:** Stage flow.
- **Reserve use** and **Work mix.**
- **Retainer usage:** Retainer usage for every client with an Allowance.
- **Pilot KPIs:** share delivered on time; days of warning; days to clear; internal rework share of hours; client
  revision share of hours (shown as an estimates figure, not as rework); margin known while the job is live (live
  jobs with a Budget and a Rate, or a month card with a Budget); requests arriving complete.

**Reads:** the Projects List with its subtasks and the Clients List, plus what each tool it calls reads.

**Returns:** `month`, `from`, `to`, `sections` (each `section`, `sentence`, `sources` (the tool and arguments
behind it), `figures`).

**Example:**

```json
{ "month": "2026-10" }
```

---

## Reference

### price_and_terms (Price and terms)

What Makers charges for a job type and size, and what the agency charges for its part.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `job_type` | string | yes | Launch, Social, Print, Web, Email or Video | |
| `size` | string | no | Small, Medium or Large | all sizes |

The two Docs are read as Markdown tables (`tables`, `tools.js`):

- **Makers price list:** the first table whose header has both Job type and Price. Columns read: Job type, Size, What
  the client gets, Price, Our hours (guide), Client rounds.
- **Supplier operating agreement:** the first table whose header has Turnaround. Columns read: Work type (one or more
  job types, separated by commas), Size, Price, What the agency designs, Turnaround, Rounds. Then a section headed
  `## Revisions`, read for the first three "Small N", "Medium N" and "Large N" (N working days for one revision round).
  The planning tools read the same table for the agency's turnaround.

A package priced $0, or sized "None", means the work is made in-house. With no table that can be read, Price and terms
answers `The Makers price list Doc has no price table that can be read` or `The Supplier operating agreement Doc has no
price table that can be read`. A table without a column the code reads (Work type, for example) stops the call with
the ClickUp failure answer, `Makers tools could not read ClickUp just now, so there is no figure; try again in a
minute (price and terms).`

**Reads:** the Makers price list Doc and the Supplier operating agreement Doc.

**Returns:** `job_type`, `size`, `rows` (each `job_type`, `size`, `what_the_client_gets`, `price`, `guide_hours`,
`client_rounds`, and `agency` with `package`, `fee`, `turnaround`, `rounds`, `revision_turnaround_working_days`, or
null).

**Example:**

```json
{ "job_type": "Launch", "size": "Medium" }
```

---

## Write tools

### The pattern the Delivery Planner's four writes share

Set health, Write plan, Write rework plan and Apply fix work the same way:

1. **Recalculate.** Before it writes, the tool reads the cards again and works out once more what the read tool gave
   (each clears the shared reads first). Apply fix reads the fix stored under its Fix ref, then the cards and the
   go-ahead fresh.
2. **Write only if nothing has shifted.** Set health writes a card only when its reading is the same Health that was
   passed in. Write plan and Write rework plan write only when the plan works out to the same plan key. Apply fix
   writes only when every stored step still starts and ends on the days its move is from.
3. **Write exactly that.** Each writes the fields named in its section and nothing else.
4. **Log it.** Each returns `changed`, the list of what it wrote. The Worker log records it with the call.

Apply fix also needs a go-ahead on the card the fix is for: a reply that reads exactly "apply" or "@Delivery Planner
apply", from the card's Delivery lead or a workspace owner, on the Delivery Planner's own comment that carries the
fix's Fix ref.

None of the four posts a comment. The Delivery Planner posts its own.

### set_health (Set health)

Writes Health and Health reason on job cards, as Forecast delivery scored them.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `cards` | array, 1 to 100 | yes | Each `card` (id or name), `health` and `reason` | |

- **Allowed values:** `health` is On track, At risk or Off track. `reason` is one line of 1 to 100 characters.
- **Writes:** the Health dropdown and the Health reason field, each only where its value differs. Nothing else.
- **Which cards:** the job cards Forecast delivery reads (a project, a retainer piece or a retainer month card).

Refusals:

- `"<value>" is not a Health; use On track, At risk or Off track; nothing was written`
- `The Health reason for <card> must be one line of 1 to 100 characters; nothing was written` (checked before
  anything is read)
- A card whose reading now differs is not written, and the answer lists it with what it now reads. When no card is
  written or already as asked: `The reading has changed since: <card> now reads <Health>, not <Health>. Nothing was
  written; call Forecast delivery again`
- `<card> has no Health or Health reason field to write; nothing more was written`

**Returns:** `written` (each `card`, `id`, `health`, `reason`, `was`), `kept` (already as asked), `not_written`,
`changed`.

**Example:**

```json
{ "cards": [ { "card": "Client W winter coats", "health": "At risk", "reason": "Forecast 2 working days late" } ] }
```

### write_plan (Write plan)

Writes a new request's first plan exactly as Plan new work gave it.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `request` | string | yes | The request, as given to Plan new work | |
| `plan_key` | string | yes | The `plan_key` Plan new work returned | |
| `keep_estimates`, `start_date`, `cap_pct` | | no | As given to Plan new work | |

- **Writes:** on each step in the plan, its start and due date (as dates with no time), its estimate where the plan's
  hours (rounded to a quarter hour) differ, and its owner where the step has no person and no Team. Then the card's
  Feasible date.
- **Which cards:** an open request in Intake, or an open card in Projects that is not In progress.

Refusals (nothing is written):

- No plan key: `No plan_key was given: call Plan new work first and pass the plan_key it returns`
- `<card> is In progress; Write plan writes a new request's first plan only`
- `The plan for <card> has changed since Plan new work gave it (the cards or the team's time moved); call Plan new
  work again`
- Not a first plan: the card already has a Feasible date, or a step in the plan already has a start or due date.
  The answer says to give new figures as suggestions.
- `The plan for <card> has no Feasible date (no Deliver step)`
- If the card has no Feasible date field, the steps are written and the answer says the Feasible date was not.

**Returns:** `request`, `id`, `written` (each `step`, `id`, `start`, `due`, and `hours`, `was_hours`, `owner` where
written), `feasible_date`, `send`, `changed`.

**Example:**

```json
{ "request": "Client B spring launch", "plan_key": "<the plan_key Plan new work returned>" }
```

### write_rework_plan (Write rework plan)

Writes the dates on a rework card's steps exactly as Plan rework gave them.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `rework` | string | yes | The rework card, as given to Plan rework | |
| `plan_key` | string | yes | The `plan_key` Plan rework returned | |

- **Writes:** each open step under the rework card, its start and due date. The rework card gets the project's
  Delivery lead added as assignee where they are not on it. The project's other steps are never written.
- **Which cards:** an open rework card in Projects.

Refusals (nothing is written):

- No plan key: `No plan_key was given: call Plan rework first and pass the plan_key it returns`
- `The plan for <rework card> has changed since Plan rework gave it; call Plan rework again`
- `<rework card> has no open steps to date`

**Returns:** `rework`, `id`, `project`, `project_id`, `written`, `assigned`, `rework_done_by`, `changed`.

**Example:**

```json
{ "rework": "Internal rework: web", "plan_key": "<the plan_key Plan rework returned>" }
```

### apply_fix (Apply fix)

Writes a fix Forecast delivery or Test a fix proposed, by its Fix ref, once the go-ahead is on the card it is for.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `fix_ref` | string | yes | The Fix ref on the Delivery Planner's comment, eight hex characters ("Fix ref: 7f3a9c1d" is read too) | |
| `project` | string | no | The card the fix was posted on, by id or exact name; it must be the card the fix is for | |
| `moves` | array | no | A cross-check: each `step`, `from` and `to` (YYYY-MM-DD), and optional `card` and `to_due`, as the comment lists them; it must be exactly the stored moves | |

- **What it writes:** the moves stored under the Fix ref (see Forecast delivery, "The Fix ref"): each step's start and
  due date, by step id, and nothing else. A step with the same name on another card is never written.
- **Which cards:** the card the fix is for and the cards its moves name, each still a live card at the top of the
  Projects List, each step still open under its card. A [Test] card counts when the fix stored it by id, as the tools
  that propose a fix read one named exactly.
- **The go-ahead:** read fresh from ClickUp, from every comment on the card the fix is for, page by page. A reply from
  the card's Delivery lead or a workspace owner (the owner role, read from the workspace's members), on the Delivery
  Planner's own comment on that card that carries the Fix ref ("Fix ref" and the reference, in any case). The reply's
  words, trimmed and in any case, must be exactly "apply" or "@Delivery Planner apply" (the agent's name from
  `AGENTS`, `data.js`), read from the reply's parts in order; a reply that only contains the word, such as "do not
  apply" or "apply now", does not count. An "apply" on any other comment does not count.
- **Unchanged cards:** every stored step must still start and end on the days its move is from. A fix already
  written fails this, so a second "apply" changes nothing.
- **After the moves:** it reads the card's Health again, as Forecast delivery reads it, and writes Health and Health
  reason through Set health. The moves stand if that write fails, and the answer says so. It posts no comment; the
  answer gives the confirmation lines the Delivery Planner posts.
- A step whose due date changes starts the Projects automation "Step due date changed: run the Health check".

Refusals (nothing is written):

- `No Fix ref was given`, or a value that is not a Fix ref.
- `No fix is stored under Fix ref <ref>: it was never proposed, or it was proposed more than 14 days ago`. A server
  with no `FIXES` binding refuses every call.
- The card the fix is for is no longer a live card on the Projects List, or a different card is named.
- `<card>'s <step> starts <day>, not <day>` (or `ends`): `the cards have changed since the fix was proposed`; or a
  stored step is no longer open on its card.
- A move to a day already past.
- `The moves given are not the fix stored under Fix ref <ref>`, when the cross-check differs.
- No go-ahead, each with its reason: `the Delivery Planner has no comment on <card> that carries Fix ref <ref>`;
  `the "apply" from <Delivery lead> or a workspace owner on <card> is on a different comment, not on the Delivery
  Planner's comment that carries Fix ref <ref>`; `there is no reply from <Delivery lead> or a workspace owner that
  reads "apply" or "@Delivery Planner apply" on the Delivery Planner's comment that carries Fix ref <ref> on <card>`.
  A card with no Delivery lead in a workspace with no owner is refused too.

**Returns:** `project`, `id`, `fix_ref`, `written` (each `card`, `step`, `from`, `from_due`, `to`, `to_due`), `sends`
(each job touched, the day its files then go out against its Due date, worked out on the cards as the writes leave
them), `go_ahead` (the comment and reply ids), `health` (the Health and reason written, or absent with the reason in
the text), `confirmation_lines` ("The fix is applied.", each move, the card's send), `changed`.

**Example:**

```json
{ "fix_ref": "7f3a9c1d" }
```

### link_client (Link client)

Links a new request to its Client card from the client name on it, and sets the account lead from that card.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `request` | string | yes | The request card id | |

- **Which cards:** a card in the Intake List only. Any other card: `<card> is not a request in the Intake List; this
  tool links new requests only, so nothing was changed`. A card with no Client or Client name field is refused.
- **Matching:** the Client name field, else a "Client name:" line in the description, against the Clients List
  ([Test] cards left out): exact, then ignoring case, then either name containing the other. Exactly one match.
  None, or more than one, changes nothing, and the answer gives the count.
- **Writes, only where empty:** the Client relationship; then, from the Client card's first assignee, Account lead,
  and the card's assignee when it has none. A request already linked is left as it is.
- **Comment:** when it changes something, one line on the card: `Makers tools linked this request to <client> from
  the client name on it`, with the account lead named when it set one.
- **The event service's path** (the `Writes` entrypoint in `worker.js`): the same function, with no comment.

**Returns:** `request`, `typed`, `client`, `client_id`, `matches` (when not one), `changed`.

**Example:**

```json
{ "request": "869abc123" }
```

### freeze_baseline (Freeze baseline)

Records a project's starting point. The event service is its only caller: it records each project's starting point
at approval. No agent has this tool.

| Input | Type | Required | Meaning | Default |
| --- | --- | --- | --- | --- |
| `project` | string | yes | The project card id | |

- **Writes, only where empty:** Initial forecast (the time estimate on the card and everything under it × Rate +
  Supplier cost) and Original committed date (the card's Due date). With no Rate, or no Due date, that field is left
  empty and the answer says so.
- **Which cards:** called by an agent, a card whose name contains [Test] only. Any other card: `<card> is not marked
  [Test]; this tool changes only cards marked [Test], so nothing was changed`. A card with no Initial forecast or
  Original committed date field is refused.
- **Comment:** when it changes something, one line on the card: `Makers tools recorded this project's starting
  point: <what>`.
- **The event service's path** (the `Writes` entrypoint in `worker.js`, at approval): the same function, on any card,
  with no [Test] guard and no comment.

**Returns:** `project`, `initial_forecast`, `changed`.

**Example:**

```json
{ "project": "869abc123" }
```

## The Writes entrypoint

`worker.js` exports a second entrypoint, `Writes`, for the event service. Only a Worker with a service binding to it
can call it; it is not on the internet. It offers four calls:

| Call | What it does |
| --- | --- |
| `linkClient` | Link client, with no comment |
| `freezeBaseline` | Freeze baseline, on any card, with no comment |
| `copyStepFields` | Writes the job's Agreement type, Job type, Rate, Account lead, Delivery lead, Creative lead and Job due (its Due date) onto every step under it (`stepfields.js`) |
| `liftReworkBudget` | For a Client rework card, raises its job's Budget by the chain's estimated hours × Rate, once per chain, recorded in one comment on the rework card |

A refusal comes back as `{ ok: true, skipped: <reason> }`. A ClickUp failure comes back as `{ ok: false, error }`, which
the event service answers with HTTP 502 so the automation retries.

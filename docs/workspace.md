# What the workspace must contain

The code, the agents and the rules find things in ClickUp by name. This page lists those names as they are in the
Makers Marketing Co. workspace, read from it through the ClickUp API. A workspace set up for this system needs the
same names. Ids are not listed: the code holds its own (`tools-server/data.js`, `WS`, `LISTS`, `DOCS`).

## Space, Folders and Lists

Space: **Makers Marketing Co.**.

| Folder | List | Statuses, in order (type) |
| --- | --- | --- |
| Work | Intake | to do (open); intake review (custom); waiting on client (brief) (custom); delivery review (custom); final review (custom); waiting on client (date) (custom); declined (done); complete (closed) |
| Work | Projects | to do (open); ready (custom); in progress (custom); delivered (custom); complete (closed) |
| Suppliers | Supplier briefs: staging | briefed (open); in design (custom); proof ready (custom); approved (custom); changes requested (custom); final delivered (done); accepted (closed) |
| Suppliers | Design Agency | briefed (open); in design (custom); proof ready (custom); approved (custom); changes requested (custom); final delivered (done); accepted (closed) |
| (none) | Clients | onboarding (open); active (custom); on hold (custom); former (closed) |
| (none) | Pilot rollout | to do (open); ready (custom); in progress (custom); delivered (custom); complete (closed) |

The code reads Intake, Projects and Clients, and writes to Intake, Projects and Clients. Supplier briefs: staging and
Design Agency are used by the rules and the Design Brief Writer. Pilot rollout holds the agency's own tasks for
changes to how it works; no code, rule or agent reads it.

## Custom fields

Every custom field on the five work Lists, with its type and where it appears. A field on several Lists is one field
set on the Folder or Space. In a formula, `{Name}` is another field.

| Field | Type | Lists | Options, formula or setting |
| --- | --- | --- | --- |
| Accepted on | Date | Intake, Projects |  |
| Accepted overrun | Money | Intake, Projects | USD, 2 decimals |
| Account health | Dropdown | Clients | Options: Healthy, Watch, At risk |
| Account lead | People | Intake, Projects | One person |
| Agency contact | People | Supplier briefs: staging, Design Agency | One person |
| Agency late by | Formula | Supplier briefs: staging, Design Agency | Formula: `DAYS({Final delivered on}, {Agreed deadline})` |
| Agency rounds | Number | Supplier briefs: staging, Design Agency |  |
| Agreed deadline | Date | Supplier briefs: staging, Design Agency |  |
| Agreement type | Dropdown | Intake, Projects | Options: Retainer, Fixed fee, Not sure |
| Allowance | Number | Clients |  |
| Assignment role | Dropdown | Intake, Projects | Options: Creative lead, Account lead |
| Average rounds | Number | Clients |  |
| Brand files | Dropdown | Intake, Projects | Options: On file, Sending new |
| Budget | Money | Intake, Projects | USD, 2 decimals |
| Budget used % | Formula | Intake, Projects | Formula: `IF({Budget}>0, CONCATENATE(ROUND({Cost}/{Budget}*100, 0), "%"), "")` |
| Client | Relationship | Intake, Projects | Links to a task |
| Client approver | Short text | Intake, Projects |  |
| Client name | Short text | Intake, Projects |  |
| Client revision hrs | Number | Clients |  |
| Cost | Formula | Intake, Projects | Formula: `TASK_TIME_TRACKED_HOURS*{Rate}+{Supplier cost}` |
| Creative lead | People | Intake, Projects, Supplier briefs: staging, Design Agency | One person |
| Days remaining | Formula | Intake, Projects | Formula: `DAYS(TASK_DUE_DATE, TODAY())` |
| Deliverables | Short text | Supplier briefs: staging, Design Agency |  |
| Delivered on | Date | Intake, Projects |  |
| Delivery lead | People | Intake, Projects | One person |
| Estimate accuracy % | Formula | Intake, Projects | Formula: `IF(TASK_TIME_ESTIMATED_HOURS>0, ROUND(TASK_TIME_TRACKED_HOURS/TASK_TIME_ESTIMATED_HOURS*100, 0), "")` |
| Feasible date | Date | Intake, Projects |  |
| Fees to date | Money | Clients | USD, 2 decimals |
| Figures as of | Date | Clients |  |
| Final delivered on | Date | Supplier briefs: staging, Design Agency |  |
| Forecast | Formula | Intake, Projects | Formula: `TASK_TIME_TRACKED_HOURS*{Rate}+{Supplier cost}+IF(TASK_TIME_ESTIMATED_HOURS-TASK_TIME_TRACKED_HOURS>0,TASK_TIME_ESTIMATED_HOURS-TASK_TIME_TRACKED_HOURS,0)*{Rate}` |
| Forecast drift | Formula | Intake, Projects | Formula: `IF({Initial forecast}>0, {Forecast}-{Initial forecast}, "")` |
| Headroom | Formula | Intake, Projects | Formula: `{Budget}+{Accepted overrun}-{Forecast}` |
| Health | Dropdown | Intake, Projects | Options: On track, At risk, Off track |
| Health | Dropdown | Clients | Options: On track, At risk, Off track |
| Health reason | Short text | Intake, Projects, Clients |  |
| Hours allowed | Number | Projects |  |
| Hours remaining | Formula | Intake, Projects | Formula: `TASK_TIME_ESTIMATED_HOURS-TASK_TIME_TRACKED_HOURS` |
| Initial forecast | Money | Intake, Projects | USD, 2 decimals |
| Internal rework hrs | Number | Clients |  |
| Job due | Date | Projects |  |
| Job type | Dropdown | Intake, Projects, Supplier briefs: staging, Design Agency | Options: Launch, Social, Print, Web, Email, Video |
| Late by | Formula | Intake, Projects | Formula: `DAYS({Delivered on}, {Original committed date})` |
| Late days | Number | Clients |  |
| Margin | Formula | Intake, Projects | Formula: `IF({Price}>0, {Price}-{Cost}, "")` |
| Margin | Money | Clients | USD, 2 decimals |
| Margin % | Formula | Intake, Projects | Formula: `IF({Price}>0, ROUND(({Price}-{Cost})/{Price}*100, 0), "")` |
| Margin % | Number | Clients |  |
| On time % | Number | Clients |  |
| Original committed date | Date | Intake, Projects |  |
| Pace | Formula | Intake, Projects | Formula: `IF(AND(TASK_TIME_ESTIMATED_HOURS>0, DAYS(TASK_DUE_DATE, TASK_START_DATE)>0), ROUND((TASK_TIME_TRACKED_HOURS/TASK_TIME_ESTIMATED_HOURS-DAYS(TODAY(), TASK_START_DATE)/DAYS(TASK_DUE_DATE, TASK_START_DATE))*100, 0), "")` |
| Price | Money | Intake, Projects | USD, 2 decimals |
| Project | Relationship | Intake, Projects, Supplier briefs: staging, Design Agency | Links to a task |
| Project name | Short text | Intake, Projects |  |
| Promise gap | Formula | Intake, Projects | Formula: `DAYS({Feasible date}, {Requested date})` |
| Rate | Money | Intake, Projects | USD, 2 decimals |
| Request kind | Dropdown | Intake, Projects | Options: New project, Change |
| Requested date | Date | Intake, Projects |  |
| Requester email | Email | Intake, Projects |  |
| Requester name | Short text | Intake, Projects |  |
| Retainer trend % | Number | Clients |  |
| Retainer usage % | Number | Clients |  |
| Rework | Labels | Intake, Projects | Labels: Client, Internal |
| Round | Number | Supplier briefs: staging, Design Agency |  |
| Rounds included | Number | Intake, Projects |  |
| Rounds used | Number | Intake, Projects |  |
| Schedule slip | Formula | Intake, Projects | Formula: `DAYS(TASK_DUE_DATE, {Original committed date})` |
| Sign-off days | Formula | Intake, Projects | Formula: `DAYS({Accepted on}, {Delivered on})` |
| Still to come | Text | Intake, Projects |  |
| Supplier cost | Money | Intake, Projects | USD, 2 decimals |
| Why | Text | Clients |  |

## Task types

Custom task types (ClickUp's built-in types are not listed):

| Task type | Used for |
| --- | --- |
| Retainer month | A retainer client's month: the code finds it by this type (`RETAINER_MONTH_TYPE` in `tools-server/data.js` holds its id) |

## Step and stage names

The code knows a step by its name (`STEP_NAMES` and `STAGE_NAMES` in `tools-server/data.js`). The templates create them.

- Delivery steps: Write copy, Review copy, Design, Package files, Internal review, Deliver; for video, Write script,
  Review script, Produce video.
- Stage subtasks: Confirm brief and scope, Verify delivery, Confirm and approve, Kick off delivery.

## Teams

ClickUp user groups. A step can be assigned to a Team; the code plans a Team step on its members' hours.

| Team | Members (usernames) |
| --- | --- |
| Copy | Copywriter |
| Studio | Studio |

## People and capacity

`CAPACITY` in `tools-server/data.js` gives each person's weekly hours of step work, keyed by ClickUp username. A
person whose username is not in it is planned with no hours. The usernames it expects: Copywriter (40), Studio (40),
Creative lead (22), Account lead (16), Delivery lead (0).

Workspace members, by username and role:

| Username | Role |
| --- | --- |
| Account lead | Member |
| Copywriter | Member |
| Creative lead | Member |
| Delivery lead | Member |
| Design Agency | Guest |
| (the workspace owner) | Owner |
| Studio | Member |

## Time tracking tags

Rework hours are found by these tags on time entries: `rework: client`, `rework: internal`.

## Task templates

Task templates in the workspace: Agency task, Client rework: launch, Client rework: video, Internal rework: launch, Internal rework: video, Kick off delivery, Request: change stages, Request: new project stages, Steps: launch, Steps: video.

- Applied by rules (`docs/rules.md`): Request: new project stages, Request: change stages, Steps: launch, Steps:
  video, Kick off delivery and Agency task. The checklist template Inputs: launch is applied by Rules 1a, 1b, 1e and 1f.
- Applied by hand: Client rework: launch, Client rework: video, Internal rework: launch and Internal rework: video. A
  lead applies one to start a rework chain.

## Docs

- **Makers price list**: read by Price and terms (`DOCS.prices`).
- **Supplier operating agreement**: read by Price and terms and by the tools that plan or forecast, for the agency's
  turnaround (`DOCS.supplier`).

What each Doc's tables must hold: `docs/tools.md`, Price and terms.

## Skills

The Skills List holds: Call prep, Health check, Plan the work, Scope and inputs check. Each Skill is a task; its description is the Skill's text.

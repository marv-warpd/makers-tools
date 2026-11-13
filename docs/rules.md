# The automation rules

The rules are ClickUp automations. They are made and changed by hand in ClickUp; this file is a record of them, and
editing it changes nothing. Each rule's name is given as it reads in ClickUp.

Where to find them: open the List, then Automations (the robot icon and count in the List's header), then Manage.
Manage shows active rules; its status filter also shows inactive ones. The Activity tab lists each time a rule fired,
with its result. The Webhooks tab lists the webhooks the rules call.

Scope in brackets after a trigger is the rule's Tasks or Subtasks setting, where it was read. Where a rule adds an
assignee, it adds the person in a People field of the card that fired it (for example the card's Delivery lead).

## Intake

| Rule | Trigger | Condition | Action |
| --- | --- | --- | --- |
| Rule 0: Request arrives, link the client | Task created (Tasks), source Form submissions | None | Call webhook "Link client on arrival" (event service `/intake`) |
| Rule 1a: New launch | Task created | Request kind is New project; Job type is Launch | Apply task templates Request: new project stages and Steps: launch; apply checklist template Inputs: launch; set status Intake review |
| Rule 1b: Change launch | Task created | Request kind is Change; Job type is Launch | Apply Request: change stages and Steps: launch; apply Inputs: launch; set status Intake review |
| Rule 1c: New other | Task created | Request kind is New project; Job type is not Launch and not Video | Apply Request: new project stages; set status Intake review |
| Rule 1d: Change other | Task created | Request kind is Change; Job type is not Launch and not Video | Apply Request: change stages; set status Intake review |
| Rule 1e: New video | Task created | Request kind is New project; Job type is Video | Apply Request: new project stages and Steps: video; apply Inputs: launch; set status Intake review |
| Rule 1f: Change video | Task created | Request kind is Change; Job type is Video | Apply Request: change stages and Steps: video; apply Inputs: launch; set status Intake review |
| Rule 2a: Intake review checklist complete | All checklists resolved on a subtask | Task name is Confirm brief and scope | Set the subtask's status to Complete |
| Rule 3: Client replied, back to Intake review | Comment added | Status is Waiting on client (brief) | Set status Intake review |
| Rule 3b: Client replied, back to Final review | Comment added | Status is Waiting on client (date) | Set status Final review |
| Rule 4: Intake review, run the Intake Advisor | Status changes to Intake review (Tasks) | None | Launch the Intake Advisor with "Run the Scope and inputs check on this request." |
| Rule 5: Delivery review, assign the Delivery lead | Status changes to Delivery review (Tasks) | None | Remove all assignees; add the card's Delivery lead |
| Rule 5b: Delivery review, run the Delivery Planner | Status changes to Delivery review (Tasks) | None | Launch the Delivery Planner with "Plan the work on this request." |
| Rule 6a: Final review, assign the Account lead | Status changes to Final review (Tasks) | None | Remove all assignees; add the card's Account lead |
| Rule 6b: Delivery review checklist complete | All checklists resolved on a subtask | Task name is Verify delivery | Set the subtask's status to Complete |
| Rule 7a: Final review checklist complete | All checklists resolved on a subtask | Task name is Confirm and approve | Set the subtask's status to Complete |
| Rule 8: Complete, handover to Projects | Status changes to Complete (Tasks) | None | Set Original committed date to the Due date; remove all assignees; add the Delivery lead; create the subtask Kick off delivery from the template Kick off delivery; set status To do; move the card to Projects |
| Rule 8b: Complete, run the approval script | Status changes to Complete (Tasks) | None | Call webhook "Approval script" (event service `/approved`) |
| Rule 9: Declined, archive the card | Status changes to Declined | None | Archive the card |

Rules 8 and 8b fire on the same status change. ClickUp sets no order between rules with the same trigger. The event
service reads the card itself by its id, wherever it is. Freeze baseline then adds up the estimated hours under the
card from the listing of the List the card is in, which can be up to 30 seconds old and can lag a few seconds behind a
move. If Rule 8 has just moved the card to Projects, steps can be missing from that listing and Initial forecast is
then too low. The step fields copy reads the card and its steps one by one and does not depend on the listing.

## Projects

| Rule | Trigger | Condition | Action |
| --- | --- | --- | --- |
| Handover Writer | An existing task is moved to this List (Tasks) | Request kind is New project | Start the Handover Writer, an Autopilot agent (`agents/handover-writer/`) |
| Next delivery chain step 'ready' and waiting | Subtask unblocked (Subtasks) | None | Set status Ready |
| E2a: Kick off checklist done, close the subtask | All checklists resolved on a subtask | Task name is Kick off delivery | Set the subtask's status to Complete |
| E3: Review copy complete (no rework), create the agency brief shell in staging | Subtask unblocked (Subtasks) | Task name is Design; Rework is not set | Create the task "Design brief" in Supplier briefs: staging from the template Agency task, with the Design step's start and due dates, assigned to the Creative lead, linked to the Design step, with Agency rounds set |
| E4: all steps done, card Complete (not month cards) | All subtasks resolved | Task name does not contain Retainer month | Set status Complete |
| E4a: Delivered, stamp Delivered on once | Status changes to Delivered | Delivered on is empty | Set Delivered on |
| E4b: Complete, stamp Accepted on once | Status changes to Complete | Accepted on is empty; task type is not Retainer month | Set Accepted on |
| R1: Retainer month created, promise date and In progress | Task created | Task name contains Retainer month | Set status In progress; set Original committed date |
| Rework label set: copy the job's fields | Rework changes, any value to any value (Tasks or subtasks) | None | Call webhook "Rework label set: copy the job's fields" (event service `/step-fields`) |
| Accepted overrun changed: run the Health check | Accepted overrun changes (Tasks) | None | Launch the Delivery Planner with "The account lead has recorded an accepted overrun on this project: run the Health check and re-walk it." |
| Step due today, not started: run the Health check | Due date arrives (Subtasks) | Status is To do or Ready | Launch the Delivery Planner with "A step on this project is due today and has not started: run the Health check and re-walk it." |
| Step due date changed: run the Health check | Due date changed (Subtasks) | None | Launch the Delivery Planner with "A step's due date moved on this project: run the Health check." |

## Supplier briefs: staging

| Rule | Trigger | Condition | Action |
| --- | --- | --- | --- |
| Add Design Agency contact | Task created | None | Set Agency contact |
| Design Brief Writer | Task created (Tasks), source Automations | Agent condition: "Act only on a task in this List whose Deliverables field is empty. Do nothing for any other task." | Start the Design Brief Writer, an Autopilot agent (`agents/design-brief-writer/`) |

## Design Agency

| Rule | Trigger | Condition | Action |
| --- | --- | --- | --- |
| A0: brief lands in Design Agency, assign the Agency contact | An existing task is moved to this List (Tasks) | None | Remove all assignees; add the task's Agency contact |
| A1: proof ready, assign the Creative lead | Status changes to Proof ready (Tasks) | None | Remove all assignees; add the task's Creative lead |
| A2: changes requested, assign the Agency contact | Status changes to Changes requested (Tasks) | None | Remove all assignees; add the task's Agency contact |
| A2b: Proof approved, assign the Agency to produce finals | Status changes to Approved (Tasks) | None | Remove all assignees; add the task's Agency contact |
| A3: finals delivered, assign the Creative lead | Status changes to Accepted (Tasks) | None | Remove all assignees; add the task's Creative lead |
| A3b: first Final delivered, stamp Final delivered on | Status changes to Accepted | Final delivered on is empty | Set Final delivered on |

## Lists with no active rules

Clients, Pilot rollout.

## Templates the rules apply

The templates are made and saved by hand in ClickUp. What each adds, as cards in the workspace carry it:

| Template | Kind | Applied by | What it adds |
| --- | --- | --- | --- |
| Request: new project stages | Task template | Rules 1a, 1c, 1e | The stage subtasks Confirm brief and scope, Verify delivery and Confirm and approve |
| Request: change stages | Task template | Rules 1b, 1d, 1f | The stage subtasks for a change request (no change request in the workspace has them, so their names were not read from a card) |
| Steps: launch | Task template | Rules 1a, 1b | The steps Write copy, Review copy, Design, Package files, Internal review and Deliver |
| Steps: video | Task template | Rules 1e, 1f | The steps Write script, Review script, Produce video, Internal review and Deliver |
| Inputs: launch | Checklist template | Rules 1a, 1b, 1e, 1f | A checklist of four inputs on the request card |
| Kick off delivery | Task template | Rule 8 | The subtask Kick off delivery, with its checklist |
| Agency task | Task template | E3 | The task Design brief in Supplier briefs: staging |

A template saved from an archived task adds no subtasks when a rule applies it, although the rule's Activity shows
Success. To change such a template: unarchive the task it is saved from, save the template again, archive the task.

`docs/workspace.md` lists every template in the workspace, including the four rework templates people apply by hand.

## Webhooks

Three webhooks, listed in the Webhooks tab of the Automations window. Each is a `POST` to the event service with the
header `X-Webhook-Secret` set to the event service's secret (`WEBHOOK_SECRET`).

| Webhook | Address | Called by |
| --- | --- | --- |
| Link client on arrival | `https://makers-approval.<your-subdomain>.workers.dev/intake` | Rule 0 (Intake) |
| Approval script | `https://makers-approval.<your-subdomain>.workers.dev/approved` | Rule 8b (Intake) |
| Rework label set: copy the job's fields | `https://makers-approval.<your-subdomain>.workers.dev/step-fields` | Rework label set: copy the job's fields (Projects) |

The event service answers 401 to a wrong or missing secret, and 502 when ClickUp fails or limits its calls.

## The agents' other triggers

Rules are not the only thing that starts an agent. The Delivery Planner also starts on its weekly schedule, Mondays at
8:00 AM, and when someone mentions it or sends it a direct message. The Intake Advisor starts when mentioned or sent a
direct message. See `agents/README.md`.

// The Makers tools: the read tools. Each result is readable lines, the basis, the time, and last one plain sentence
// an agent can quote as it stands, the tool's name in brackets.
// Nothing on ClickUp is changed.
import {
  LISTS, DOCS, DAY_MS, HOUR_MS, SIGN_OFF_ALLOWANCE, STEP_NAMES, STAGE_NAMES, CAPACITY, STEP_WORK_HOURS, UserError, sharedRead,
  allTasks, timeEntries, docPages, teamMembers, bookings, bookingsBy, without, withoutBy, dailyCapacity, freeHours, clickup, taskComments, AGENTS,
  makeTree, matchOne, isFor, isTest, onTest, isMonth, clientName, delivered, cardRef,
  dayNumber, today, days, monthOf, monthBounds, monthLabel, isoDay, dayText, dateText, stamp, period,
  isWorkingDay, workingDaysBetween, nextWorkingDay, addWorkingDays,
  num, sum, round1, fmt, money, pct, signedPct,
} from './data.js';
import { schedule, against, shape, planLines, kindOf } from './engine.js';
import { proposeFix, moveOf } from './fixes.js';

const ALL_TIME = () => [Date.UTC(2026, 0, 1), Date.now() + 60 * DAY_MS]; // the span the weekly numbers read
const JOB_TYPES = ['Launch', 'Social', 'Print', 'Web', 'Email', 'Video'];

export function result(tool, env, { lines, data, cards = [], sentence }) {
  const asOf = stamp(env);
  const text = [...lines, `Basis: ${tool.basis}`, `As of ${asOf}.`, sentence].join('\n');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ...data, cards: [...new Set(cards)].slice(0, 100), basis: tool.basis, as_of: asOf, summary: sentence },
    isError: false,
  };
}

// Pages of 25. A long list comes back a page at a time, page 0 first, with next_page while more remain
// (null on the last page). Every row is a complete total for its group; the lines an agent reads show only that
// page. list_version is a fingerprint of the whole list, the same on every page while the data holds still, so a
// reader of every page can tell the list changed between pages. The client figures job reads every page (jobs.js).
export const PAGE_SIZE = 25;
export function pageOf(list, page) {
  const p = Math.max(0, Math.floor(num(page) ?? 0));
  return { items: list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), page: p, pages: Math.max(1, Math.ceil(list.length / PAGE_SIZE)),
    next_page: (p + 1) * PAGE_SIZE < list.length ? p + 1 : null, version: versionOf(list) };
}
function versionOf(list) {
  const text = JSON.stringify(list);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
// The line under a paged list saying which rows these are, when there is more than one page.
function pageLine(pg, total, what) {
  if (pg.pages <= 1) return [];
  const a = Math.min(total, pg.page * PAGE_SIZE + 1);
  const b = Math.min(total, (pg.page + 1) * PAGE_SIZE);
  return [`${what} ${a} to ${b} of ${total}${pg.next_page !== null ? `; ask for page ${pg.next_page} for the next ${PAGE_SIZE}` : ''}.`];
}

export function def(name, title, description, properties, required = []) {
  return {
    name, title, description,
    inputSchema: { type: 'object', properties, required },
    annotations: { title, readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  };
}

const P = {
  page: (what) => ({ type: 'integer', minimum: 0, description: `Optional: which page of ${what}, ${PAGE_SIZE} a page, from 0. The answer gives next_page while more remain.` }),
  client: (eg = 'Client B') => ({ type: 'string', description: `The client, by the name on its Client card (for example "${eg}") or the card id. Leave out for all clients.` }),
  jobType: { type: 'string', enum: JOB_TYPES, description: 'Optional: only this job type.' },
  from: { type: 'string', description: 'Optional: from this date (YYYY-MM-DD), by the day the work was delivered.' },
  to: { type: 'string', description: 'Optional: to this date (YYYY-MM-DD).' },
  project: { type: 'string', description: 'The project, by its card id or the words in its name (for example "Client W winter coats").' },
};

// --- shared readings ---------------------------------------------------------------------------------------

// The Projects tree, shared by calls that arrive together (data.js, sharedRead).
function projects(env) { return sharedRead('tree:projects', async () => makeTree(await allTasks(env, LISTS.projects, true))); }

function finished(tree) { return tree.units.filter((t) => t.closed); }

function filterUnits(units, { client, jobType, per }, env) {
  return units.filter((t) => (!client || isFor(t, client))
    && (!jobType || (t.f['Job type'] || '').toLowerCase() === jobType.toLowerCase())
    && (!per || (per.from === null && per.to === null) || per.has(delivered(t) ? dayNumber(delivered(t), env) : null)));
}

async function optionalClient(env, typed) {
  if (!typed) return null;
  return matchOne(await allTasks(env, LISTS.clients, false), typed);
}

function jobTypeArg(v) {
  if (!v) return null;
  const found = JOB_TYPES.find((j) => j.toLowerCase() === String(v).toLowerCase());
  if (!found) throw new UserError(`"${v}" is not a job type; use one of ${JOB_TYPES.join(', ')}`);
  return found;
}

function scopeWords(client, jobType, per) {
  return `${client ? client.name : 'All clients'}${jobType ? `, ${jobType} work` : ''}${per.label}`;
}

// The card's money worked out from its tasks (the API returns stale values for formulas that read time estimates,
// time tracked or today's date). Forecast reads what is spent, not what was planned: people log time and never
// edit estimates, so task by task a finished task counts the hours logged on it and an open one the larger of
// its logged and estimated hours; at the Rate, plus Supplier cost. A step that ran over counts what it took, and the
// steps behind it keep their estimates. Headroom = Budget + Accepted overrun − Forecast (the account lead's recorded
// acceptance of an internal rework's cost; empty reads 0). The card's own Forecast field (Cost, plus Hours remaining
// at the Rate when above zero) nets the job's hours across its steps, so a finished step's over-run can hide behind
// the hours still to go; this figure cannot. Every tool that reports a forecast or headroom reads this one.
function forecastOf(tree, card) {
  const tasks = [card, ...tree.descendants(card.id)];
  const live = (x) => (x.closed ? x.tracked || 0 : Math.max(x.tracked || 0, x.estimate || 0));
  const hours = sum(tasks.map(live));
  const rate = num(card.f.Rate) || 65;
  const forecast = hours * rate + (num(card.f['Supplier cost']) || 0);
  const budget = num(card.f.Budget);
  const accepted = num(card.f['Accepted overrun']) || 0;
  const headroom = budget === null ? null : budget + accepted - forecast;
  return { estimated_hours: round1(sum(tasks.map((x) => x.estimate || 0))), logged_hours: round1(sum(tasks.map((x) => x.tracked || 0))),
    forecast_hours: round1(hours), forecast: Math.round(forecast), budget, ...(accepted ? { accepted_overrun: accepted } : {}),
    headroom: headroom === null ? null : Math.round(headroom), headroom_pct: budget ? Math.round((100 * headroom) / budget) : null };
}

// The Cost check on a card's money: Headroom as it stands. A client rework's included round is paid for by the Budget
// lift the event service makes when the Rework label is set (writes.js, liftReworkBudget), so the rework chain is
// not taken off the headroom here; an internal rework stays a cost.
export function costCheck(money) {
  const lv = money.headroom < 0 ? 'Off track' : money.headroom < HEADROOM_RISK * money.budget ? 'At risk' : 'clear';
  const accepted = money.accepted_overrun ? `, with ${moneyText(money.accepted_overrun)} accepted overrun` : '';
  return { level: lv, detail: `Forecast ${moneyText(money.forecast)} against a ${moneyText(money.budget)} Budget, Headroom ${moneyText(money.headroom)} (${money.headroom_pct}% of the Budget${accepted})` };
}

// The tasks under an Internal rework chain: a card labeled Rework Internal (or named "Internal rework …") and every
// task under it. The agency's own redo, not the client's hours.
export function internalReworkIds(tree) {
  const ids = new Set();
  for (const t of tree.byId.values()) {
    if (!t.parent || !((t.f.Rework || []).includes('Internal') || /^internal rework\b/i.test(t.name))) continue;
    ids.add(t.id);
    for (const x of tree.descendants(t.id)) ids.add(x.id);
  }
  return ids;
}

// A retainer client's month on its month card: every hour logged on the month card and the pieces
// under it, whenever it was logged, and the estimates on their open steps still planned. A month without a month
// card falls back to the hours dated in the month on the client's retainer pieces, and says so. Usage is the client's
// hours: hours and estimates on steps under an Internal rework chain are left out of both, and counted
// apart; the month card's cost against its Budget stays gross (forecastOf).
export async function retainerFigures(env, tree, client, month, entries = null) {
  const all = entries ?? await timeEntries(env, ...ALL_TIME());
  const monthCard = tree.months.find((m) => isFor(m, client) && m.due && monthOf(m.due, env) === month) || null;
  const internal = internalReworkIds(tree);
  const logged = new Map(); // piece -> hours
  let planned = 0;
  let internalHours = 0;
  if (monthCard) {
    const ids = new Set([monthCard.id, ...tree.descendants(monthCard.id).map((x) => x.id)]);
    for (const e of all) {
      if (!e.task || !ids.has(e.task)) continue;
      if (internal.has(e.task)) { internalHours += e.hours; continue; }
      const piece = tree.unitOf(e.task) ?? monthCard.id;
      logged.set(piece, (logged.get(piece) || 0) + e.hours);
    }
    for (const t of tree.descendants(monthCard.id)) if (!t.closed && t.estimate && !tree.hasKids(t.id) && !internal.has(t.id)) planned += t.estimate;
  } else {
    const ids = new Set(tree.units.filter((t) => isFor(t, client) && t.f['Agreement type'] === 'Retainer').map((p) => p.id));
    for (const e of all) {
      const unit = e.task && tree.unitOf(e.task);
      if (!unit || !ids.has(unit) || monthOf(e.start, env) !== month) continue;
      if (internal.has(e.task)) { internalHours += e.hours; continue; }
      logged.set(unit, (logged.get(unit) || 0) + e.hours);
    }
    for (const t of tree.byId.values()) {
      if (!t.parent || t.closed || !t.estimate || tree.hasKids(t.id) || ids.has(t.id) || internal.has(t.id)) continue;
      const unit = tree.unitOf(t.id);
      if (!ids.has(unit)) continue;
      const due = t.due ?? tree.byId.get(unit)?.due;
      if (due && monthOf(due, env) === month) planned += t.estimate;
    }
  }
  return {
    basis: monthCard ? 'month card' : 'entry dates', hours: sum([...logged.values()]), planned, monthCard, internal_hours: internalHours,
    pieces: [...logged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([id, h]) => ({ card: tree.byId.get(id)?.name ?? id, id, hours: round1(h) })),
  };
}

// --- the tools ---------------------------------------------------------------------------------------------

export const TOOLS = {
  retainer_usage: {
    label: 'retainer usage',
    basis: "The month card basis: every hour logged on the client's month card for the month (Retainer month: " +
      'client, month; matched by its due date) and the pieces under it, whenever it was logged, against Allowance on ' +
      'the Client card. Still planned: estimates on the open steps under the month card. Hours and estimates on steps ' +
      "under an Internal rework chain are left out (the agency's own redo, not the client's hours) and counted apart; the " +
      "month card's cost against its Budget stays gross. A month with no month card: " +
      "hours on time entries dated in the month on the client's retainer pieces, and the result says so. The usage " +
      "trend: the last three finished months' (closed month cards') average usage of the allowance minus the three " +
      'before, in points; none with fewer than six finished months.',
    def: def('retainer_usage', 'Retainer usage',
      "Hours logged this month on a retainer client's work against the allowance on their Client card, with the work still planned and where the month is heading.",
      {
        client: { type: 'string', description: 'The client, by the name on its Client card (for example "Client B") or the card id.' },
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'The month as YYYY-MM. Leave out for this month.' },
        add_hours: { type: 'number', minimum: 0, description: "Optional: a new request's estimated hours, to see where the month would land with it." },
      }, ['client']),
    run: retainerUsage,
  },
  client_record: {
    label: 'client record',
    basis: 'Finished pieces of work in Projects, newest first (a retainer piece under its month card counts as ' +
      "the piece). Late by: the card's field. Sign-off days: the card's field where it is filled; otherwise the " +
      "Deliver step's window less its own work, at 8 hours a day. Lateness is not split by whose wait: by design a " +
      "client-caused delay moves the date and sign-off is the client's clock after the send.",
    def: def('client_record', 'Client record',
      "A client's last six finished projects: whether each landed on the agreed date, how long the client took to sign off, revision rounds used, and any rework, with the patterns that repeat.",
      {
        client: { type: 'string', description: 'The client, by the name on its Client card (for example "Client G") or the card id.' },
        job_type: P.jobType,
        last: { type: 'integer', minimum: 2, maximum: 12, description: 'How many finished projects to read, newest first. Default 6.' },
      }, ['client']),
    run: clientRecord,
  },
  on_time_rate: {
    label: 'on time rate',
    basis: "On time means delivered on or before the date last agreed with the client (the card's Late by is zero " +
      'or less; the date is set at approval and moved only when the client agreed a change). By the month of ' +
      'Delivered on, or the close date where it is empty.',
    def: def('on_time_rate', 'On time rate',
      'How often finished projects landed on the date agreed with the client, by month, client or job type, with the late ones listed.',
      { client: P.client('Client R'), job_type: P.jobType, from: P.from, to: P.to,
        group_by: { type: 'string', enum: ['month', 'client', 'job_type'], description: 'How to break the figures down. Default month.' },
        page: P.page('the late jobs') }),
    run: onTimeRate,
  },
  rework_by_cause: {
    label: 'rework by cause',
    basis: 'Hours on time entries labeled rework: client or rework: internal, costed at the project\'s Rate ($65 ' +
      'where none is set). The step is the one the hours were logged on. By the day the hours were logged. ' +
      'Completeness: rework steps (named "Rework: ...", or under a Client or Internal rework card) with time logged in ' +
      'the period, and how many have no entry carrying a cause tag.',
    def: def('rework_by_cause', 'Rework by cause',
      'Rework hours and what they cost, split into client revisions and our own redo, by client, step or job type.',
      { client: P.client('Client K'), step: { type: 'string', description: 'Optional: one step, for example "Package files".' },
        job_type: P.jobType, from: { ...P.from, description: 'Optional: from this date (YYYY-MM-DD), by the day the hours were logged.' }, to: P.to,
        group_by: { type: 'string', enum: ['client', 'step', 'job_type'], description: 'How to break the figures down. Default client, or step when one client is named.' },
        page: P.page('rows') }),
    run: reworkByCause,
  },
  time_by_step: {
    label: 'time by step',
    basis: "On finished work: hours logged on each step against the hours estimated for it, and each step's " +
      'average wait: the days the step was given minus the days its estimate needed, at 8 hours a day.',
    def: def('time_by_step', 'Time by step',
      'Where the hours go on finished work, step by step: hours logged against hours estimated, and how long each step waits beyond what its work needs.',
      { job_type: P.jobType, client: P.client('Client B'), from: P.from, to: P.to }),
    run: timeByStep,
  },
  estimate_accuracy: {
    label: 'estimate accuracy',
    basis: 'On finished work with an Initial forecast and a Rate: cost at close (all hours on the project and its ' +
      'steps at its Rate, plus Supplier cost) against the Initial forecast frozen at approval. A positive gap is ' +
      'an overrun.',
    def: def('estimate_accuracy', 'Estimate accuracy',
      'How our first forecast at approval compares with the actual cost at close, by job type and by month closed.',
      { job_type: P.jobType, client: P.client('Client K'), from: P.from, to: P.to }),
    run: estimateAccuracy,
  },
  estimate_accuracy_by_step: {
    label: 'estimate accuracy by step',
    basis: "Every step with a time estimate and time tracked (the steps' own Time estimate and Time tracked; [Test] " +
      "cards left out), its hours tracked against its hours estimated. Kind of work: the step's Rework label (Client: " +
      'client revisions; Internal: internal rework), else a parent with Request kind Change (changes), else a ' +
      'retainer piece (retainer pieces), else new projects. Owner: the person on the step, else its Team. Month: the last ' +
      'day time was logged on the step, else when it was closed, else its due date; from and to read the same day. A ' +
      'positive gap is hours over the estimate.',
    def: def('estimate_accuracy_by_step', 'Estimate accuracy by step',
      'How the hours estimated on each step compare with the hours tracked, by kind of work, job type, step, client, owner or month, worst first.',
      { client: P.client('Client K'), step: { type: 'string', description: 'Optional: one step, for example "Package files".' },
        job_type: P.jobType, from: { ...P.from, description: 'Optional: from this date (YYYY-MM-DD), by the day the step was closed (else its due date).' }, to: P.to,
        group_by: { type: 'string', enum: ['kind', 'job_type', 'step', 'client', 'owner', 'month'], description: 'How to break the figures down. Default kind of work.' } }),
    run: estimateAccuracyByStep,
  },
  margin_by_client: {
    label: 'margin by client',
    basis: 'Fixed-fee projects: Price against committed cost (hours logged on the project and its steps at its ' +
      'Rate, plus Supplier cost). Retainer clients: their month cards, Price (the month\'s fee) against Cost. From and ' +
      'to read a project by its Delivered on date and a month card by the month it covers. By client, job type (the ' +
      "card's Job type) or agreement type.",
    def: def('margin_by_client', 'Margin by client',
      'Price, cost and margin by client across fixed-fee projects, live and finished, so the least and most profitable accounts stand out.',
      { client: P.client('Client K'), from: P.from, to: P.to,
        state: { type: 'string', enum: ['live', 'finished', 'all'], description: 'Which projects. Default all.' },
        group_by: { type: 'string', enum: ['client', 'job_type', 'agreement_type'], description: 'How to break the figures down. Default client.' },
        page: P.page('rows') }),
    run: marginByClient,
  },
  monthly_review: {
    label: 'monthly review',
    basis: 'One call that runs the leadership reads for a month and returns them together, each section with the calls ' +
      'its figures came from: on time (on_time_rate by month over six months, and by job type for the month); margin ' +
      'on work finished in the month (margin_by_client by client, job type and agreement type); rework (rework_by_cause ' +
      'by client, step and job type, with the completeness count); estimate accuracy (estimate_accuracy_by_step by ' +
      'kind, job type and step); delivery days and where work waits (stage_flow); reserve use and work mix (reserve_use, ' +
      'work_mix); every retainer client\'s usage in the month (retainer_usage); and the pilot KPIs (days to clear beside days of warning).',
    def: def('monthly_review', 'Monthly review',
      "The month's leadership review in one answer: on time, margin, rework, estimate accuracy, delivery days, where work waits, reserve use, work mix, retainer usage and the pilot KPIs, each with a sentence and the read it came from.",
      { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'The month as YYYY-MM. Default last month.' } }),
    run: monthlyReview,
  },
  days_of_warning: {
    label: 'days of warning',
    basis: 'A pilot measure. Every job the Health check has scored (Health set on its card), warning by warning: a comment ' +
      '(or thread reply) by the Delivery Planner that flags it (carrying At risk or Off track, "sends <date>, N working days ' +
      'after the <date> promise", or "will send N working days ' +
      'late", and not saying it is now or back On track; a plan comment or an "is now on time" note is not a flag) opens a ' +
      'warning, against the job\'s Due date in working days; flags before the next all-clear are the same warning, and a ' +
      'flag after an all-clear starts a fresh count. Days to clear: working days from the warning to the Planner\'s first ' +
      'later comment saying the job is On track (and not At risk or Off track), or to the send (Deliver\'s start) if it was ' +
      'never cleared before sending; none while still open. A warning opened on or after the send counts 0. Of the flagged ' +
      'jobs that have finished, the share that still sent by the Due date (Late by zero or less), each job once. From and ' +
      'to choose warnings by the day they opened. A staff comment counts as the Planner\'s when it opens with the Planner\'s dated form ("Health check, 12 ' +
      'June 2026:"), as imported history does, and is read on that date. With fewer than five, it says there is too ' +
      'little history to mean anything.',
    def: def('days_of_warning', 'Days of warning',
      'How far ahead of the Due date the Health check warned, warning by warning (a new warning after an all-clear starts a fresh count), how many working days each took to clear (back On track, or sent), and of the flagged jobs that finished, the share that still sent on time.',
      { from: { type: 'string', description: 'Optional: from this date (YYYY-MM-DD), by the day each warning opened.' },
        to: { type: 'string', description: 'Optional: to this date (YYYY-MM-DD), by the day each warning opened.' },
        page: P.page('the flagged jobs') }),
    run: daysOfWarning,
  },
  requests_arriving_complete: {
    label: 'requests arriving complete',
    basis: 'A pilot measure. Every request the Intake Advisor commented on (the Intake List, and every card at the top of ' +
      'Projects, live or finished): its first comment counts as complete when no line in it says "missing", "not attached" ' +
      'or "not received". By the month of that comment. A staff comment counts as the Advisor\'s when it opens with the ' +
      'Advisor\'s dated form ("Received 3 June 2026:"), as imported history does, and is read on that date. ' +
      'With fewer than ten requests, it says there is too little history to mean anything.',
    def: def('requests_arriving_complete', 'Requests arriving complete',
      "Of the requests that arrived each month, how many the Intake Advisor's first comment found complete (nothing missing, not attached or not received).",
      { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Optional: one month, YYYY-MM. Default every month.' } }),
    run: requestsArrivingComplete,
  },
  capacity_what_if: {
    label: 'capacity what-if',
    basis: 'Every live job (In progress, and approved at To do) played forward as Forecast delivery does, once with ' +
      "today's weekly hours and once with the hours asked for, for the person or for each member of the Team named. " +
      "The weeks: that person's or Team's booked hours (every open dated step, Workload's method) against the hours " +
      'asked for, for the next eight weeks from this week. New work that fits: in each of those weeks, the hours at the ' +
      'planning cap (80%) less what is booked, summed; beside it, the same with today\'s hours.',
    def: def('capacity_what_if', 'Capacity what-if',
      'What changes if a person or a Team works different weekly hours: which live jobs send earlier or later and by how much, their weeks against the new hours, and how many hours of new work fit in the next eight weeks.',
      { who: { type: 'string', description: 'A Team (for example "Studio") or a person (for example "Copywriter").' },
        hours: { type: 'number', minimum: 0, maximum: 80, description: "Weekly hours: a person's own, or each member's for a Team." } }, ['who', 'hours']),
    run: capacityWhatIf,
  },
  forecast_delivery: {
    label: 'forecast delivery',
    basis: "The Health check's rules (the Delivery Planner's Skill Health check), each check read from the " +
      'card and its open steps with the level the rules give it, and Health by the checks: Off track if any check ' +
      "is, else At risk if any is. Free hours: each owner's weekly capacity (Copywriter and Studio 40, Creative lead " +
      '22, Account lead 16) over working days, less their other booked steps on Intake and Projects (Workload\'s ' +
      "method). Remaining work: each open step's estimate, never less time tracked. The re-walk (recovery): the open " +
      "steps from today on their remaining hours in people's actual free time day by day at 100%, the agency's " +
      'turnaround and the client\'s sign-off held fixed. Buffer: the planned send (the Deliver ' +
      "step's start) against the card's Due date. Forecast: that re-walk's send against the Due date, every run: after " +
      'it is At risk. Least slack first: where jobs late on the forecast share a person\'s days with other live jobs, ' +
      'those jobs played forward together, no step before its planned start, the least slack placed first; the ' +
      'reshuffle is partial: the late jobs, least slack first, each kept in it only if it then sends by its Due date and ' +
      'no job that was on time goes late. A late job left out: its step that breaks given to someone else on the ' +
      "step's Team, one job after another; when nothing works, no reshuffle saves it and the Delivery lead decides. " +
      "The recovery re-walk runs when the buffer is gone or a step is " +
      'overdue or unstarted on its due day: At risk with the recovery plan when the files still go out by the Due ' +
      'date, Off track when they do not; an overdue step while the send still fits inside the buffer is noted, not ' +
      'scored. Cost: fixed-fee cards and retainer month ' +
      "cards (hours on the month card basis); a retainer piece's money is on its month card. Thresholds as the Skill " +
      'sets them: 2 working days; 10% of Budget. Rounds used and the client\'s sign-off wait are not Health. ' +
      "Fix ref: the reshuffle's moves for a late job it saves, or a Watch comment's moves, stored for 14 days under a " +
      'reference derived from the card and every move (card, step, from start and due, to start and due).',
    def: def('forecast_delivery', 'Forecast delivery',
      "Everything the Health check needs for a job In progress or approved at To do, in one result: each check's reading with its figures (Buffer, Forecast, No owner, No dates, Overdue step, Recovery re-walk, Cost, Overdue), the least-slack-first reshuffle (or the fallback) when jobs clash on a person's days, the card's Delivery lead, and, when the buffer is gone or a step is overdue, the recovery plan: each remaining step's dates and owner on hours from today, the day the files go out against the Due date, and the first step that breaks. When it proposes step moves (the reshuffle for a late job it saves, or a Watch comment's moves), it gives a Fix ref: Apply fix writes exactly those moves under that reference, after an \"apply\" reply on the comment that carries it.",
      { project: { ...P.project, description: 'The project, by its card id or the words in its name. Leave out with all_live.' },
        all_live: { type: 'boolean', description: 'True for the Monday forecast: every card In progress (projects and retainer month cards) and every approved job at To do, worst first, and the team\'s next four weeks.' } }),
    run: projectHealthInputs,
  },
  test_a_fix: {
    label: 'test a fix',
    basis: 'The change made to a copy of the cards as the drag or the reassignment would leave them (a step moved keeps ' +
      'its working days; a step given to someone takes it off its Team), and the forecast run on that copy the same ' +
      'way Forecast delivery runs it, beside the forecast on the cards as they are: each live job (In progress and ' +
      "approved at To do) played forward on its remaining hours in people's actual free time day by day, everyone " +
      "else's work as booked on the cards. A job on time before and late after is named, and a job late before and on " +
      'time after. Up to three changes at once. Changes nothing in ClickUp. A change of dates only (no new owner) is ' +
      'stored as a fix for 14 days under a Fix ref derived from the card and every move.',
    def: def('test_a_fix', 'Test a fix',
      'Tries a change a person suggests on a live job (another owner for a step, or a different start date) and says the day the files then go out against the Due date, beside today\'s forecast, and any other job the change makes late. Use it when someone asks what a change would do, or to compare options before suggesting one. Changes nothing in ClickUp. A change of dates only gives a Fix ref: Apply fix writes exactly those moves under that reference, after an "apply" reply on the comment that carries it.',
      { project: P.project,
        from_date: { type: 'string', description: 'Optional: start the forecast on this date (YYYY-MM-DD; default today).' },
        what_if_step: { type: 'string', description: 'Optional: the step to change, for example "Package files".' },
        what_if_owner: { type: 'string', description: 'Optional: the person to give that step to, for example "Creative lead".' },
        what_if_start: { type: 'string', description: 'Optional: the date (YYYY-MM-DD) that step moves to start on; its due date moves with it, as a drag does.' },
        changes: { type: 'array', maxItems: 3, description: 'Optional: up to three changes tried together, for example a step moved and the step after it moved back.',
          items: { type: 'object', properties: {
            step: { type: 'string', description: 'The step, for example "Internal review".' },
            project: { type: 'string', description: 'Optional: another live job the step is on (default the project above).' },
            owner: { type: 'string', description: 'Optional: the person to give it to.' },
            start: { type: 'string', description: 'Optional: its new start date (YYYY-MM-DD); its due date moves with it.' },
            due: { type: 'string', description: 'Optional: its new due date (YYYY-MM-DD).' } }, required: ['step'] } },
        cap_pct: { type: 'number', minimum: 10, maximum: 100, description: "Share of each person's week that can be booked. Default 100; Plan the work plans to 80." } },
      ['project']),
    run: rewalkChain,
  },
  plan_new_work: {
    label: 'plan new work',
    basis: "The rules of the Skill Plan the work, for new work: each step after the step it waits on, in its owner's free time each " +
      'day (capacity less booked work on Intake and Projects, Workload\'s method), at no more than 80% of the day and ' +
      'of the week by default; a production step\'s window long enough that it takes no more than half its owner\'s day ' +
      '(hours ÷ half their daily hours, rounded up, at least one day), its hours spread evenly over it; a ' +
      'review takes one working day, starting the working day after the writing it reviews finishes; the agency\'s window is one ' +
      "day to release the brief plus the package's turnaround; Deliver's window is the files going out (the send) and " +
      "the 3-day sign-off allowance (the client's average sign-off time is given as advice; it changes no number); the " +
      'Feasible date is the send plus two working days (the buffer); working days only, the workspace\'s ' +
      'holidays skipped. Step hours: the average logged on that step across finished jobs of the same job type at the ' +
      'same price, else of the job type (three at least), else the estimate on the card.',
    def: def('plan_new_work', 'Plan new work',
      "Plans a new request's steps on the team's real free time: each step's hours from finished jobs like it, its owner, start and due date with the reason, the earliest day the files can go out, and the Feasible date two working days after it, against the date the client asked for. Changes nothing.",
      { request: { type: 'string', description: 'The request, by its card id or the words in its name.' },
        start_date: { type: 'string', description: 'Optional: plan from this date (YYYY-MM-DD; default today).' },
        cap_pct: { type: 'number', minimum: 10, maximum: 100, description: "Share of each person's week to plan to. Default 80, the rework reserve kept free." },
        keep_estimates: { type: 'boolean', description: 'Optional: use the estimates already on the card instead of sizing from finished jobs.' } },
      ['request']),
    run: (args, env) => planRequest(args, env),
  },
  plan_rework: {
    label: 'plan rework',
    basis: "Recovery, shared with the re-walk: the rework card's steps and the project's other open " +
      "steps from today on their remaining hours in people's actual free time day by day, at up to 100% (the rework " +
      "reserve), each after the step it waits on; a design fix takes the agency's revision turnaround for the job's " +
      "size (Supplier operating agreement); the agency's other windows and the client's sign-off held fixed; " +
      'working days only, holidays skipped.',
    def: def('plan_rework', 'Plan rework',
      "Plans a rework card's steps with the project's other open steps on their remaining hours in people's actual free time at up to 100%, with the agency's revision turnaround for a design fix, and says when the rework can be done and whether the project's Due date still holds. Changes nothing.",
      { rework: { type: 'string', description: 'The rework card, by its card id or the words in its name (for example "Internal rework: web").' } },
      ['rework']),
    run: (args, env) => planRework(args, env),
  },
  reserve_use: {
    label: 'reserve use',
    basis: 'Rework hours (time entries labeled rework: client or rework: internal) as a share of each person\'s ' +
      'capacity for step work (the same week as planning: copywriter and studio 40 h a week, creative lead 22, account lead 16), ' +
      'by the month the hours were logged, working days only, holidays skipped; a Team is its members together. ' +
      'Against the 20% of each week Plan the work holds back (it plans to 80%).',
    def: def('reserve_use', 'Reserve use',
      "How much of each person's and Team's week rework takes, month by month, against the 20% the plan holds back for it.",
      { from_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Optional: the first month, YYYY-MM. Default: six months to the last.' },
        to_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Optional: the last month, YYYY-MM. Default: this month.' } }),
    run: reserveUse,
  },
  work_mix: {
    label: 'work mix',
    basis: 'Hours on time entries by the person who logged them, sorted by kind of work: client revisions (labeled ' +
      'rework: client), internal rework (rework: internal), retainer pieces (work under a retainer month card), ' +
      'changes (under a card whose Request kind is Change) and new projects (the rest); by the month the hours were ' +
      'logged. A Team is its members together.',
    def: def('work_mix', 'Work mix',
      "Where each person's and Team's hours go: new projects, changes, retainer pieces, client revisions and internal rework.",
      { from_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Optional: the first month, YYYY-MM. Default: six months to the last.' },
        to_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Optional: the last month, YYYY-MM. Default: this month.' } }),
    run: workMix,
  },
  stage_flow: {
    label: 'stage flow',
    basis: 'Finished projects and the changes under them (retainer pieces left out), step by step, by the steps\' start and due dates: a step can ' +
      'start the working day after the step before it finishes (a review the same day); the wait is the working days ' +
      'from then to its start. Elapsed: working days from start to due, against the hours logged on the step. Rework ' +
      'pace: finished rework cards, working days from the catch (the working day before the rework\'s first step ' +
      'starts) to the last fix. The bottleneck: the Makers step where most work waits two working days or more ' +
      '(Design is the agency\'s window, Deliver ends in the client\'s sign-off). Delivery days: working days from ' +
      'kick-off (the first step\'s start, or the day the Kick off delivery subtask closed if earlier) to the send (Delivered on), ' +
      'by job type, median and mean. The longest single wait, with the first comment on its step or card written during it.',
    def: def('stage_flow', 'Stage flow',
      'Where work waits, step by step on finished projects: how often each step waits two working days or more to start, its elapsed days against its hours, how fast rework goes from catch to fix, and the bottleneck stage.',
      { job_type: P.jobType, from: P.from, to: P.to }),
    run: stageFlow,
  },
  price_and_terms: {
    label: 'price and terms',
    basis: "The Makers price list Doc (price, guide hours, the client's rounds) and the Supplier operating " +
      'agreement Doc (the package, its fee, turnaround and revision turnaround), read as they stand now.',
    def: def('price_and_terms', 'Price and terms',
      'What Makers charges for a job type and size, with the guide hours and revision rounds, and what the agency charges for it, with its turnaround.',
      { job_type: { type: 'string', enum: JOB_TYPES, description: 'The job type.' },
        size: { type: 'string', enum: ['Small', 'Medium', 'Large'], description: 'Optional: the size; all sizes if left out.' } },
      ['job_type']),
    run: priceAndTerms,
  },
};

// --- retainer usage ----------------------------------------------------------------------------------------

// The usage trend: the last three finished months' average usage of the allowance minus the three before,
// in points. months: [{ month, used_pct }] for the finished months, oldest first; fewer than six, no trend.
export function usageTrend(months) {
  if (months.length < 6) return null;
  const avg = (xs) => xs.reduce((a, b) => a + b.used_pct, 0) / xs.length;
  const last = months.slice(-3);
  const before = months.slice(-6, -3);
  return { points: round1(round1(avg(last)) - round1(avg(before))), last_three_avg_pct: round1(avg(last)), previous_three_avg_pct: round1(avg(before)),
    last_three: last.map((m) => m.month), previous_three: before.map((m) => m.month) };
}

async function retainerUsage(args, env) {
  const tool = TOOLS.retainer_usage;
  const month = args.month ?? monthOf(Date.now(), env);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new UserError(`"${month}" is not a month; use YYYY-MM`);
  const addHours = args.add_hours === undefined || args.add_hours === null ? null : Number(args.add_hours);
  const [clients, tree] = await Promise.all([allTasks(env, LISTS.clients, false), projects(env)]);
  const client = matchOne(clients, args.client);
  const allowance = num(client.f.Allowance);
  const label = monthLabel(month, env);
  if (allowance === null) {
    return result(tool, env, {
      lines: [`${client.name}: no Allowance on the Client card.`], data: { client: client.name, month, allowance: null }, cards: [client.id],
      sentence: `${client.name} has no retainer allowance on its Client card, so there are no retainer hours to report (${tool.label}).`,
    });
  }
  const entries = await timeEntries(env, ...ALL_TIME());
  const r = await retainerFigures(env, tree, client, month, entries);
  // The trend over the client's finished months (closed month cards), each month's hours against the allowance.
  const finishedMonths = tree.months.filter((m) => isFor(m, client) && m.closed && m.due).map((m) => monthOf(m.due, env)).sort();
  const usage = [];
  for (const mo of finishedMonths) usage.push({ month: mo, used_pct: (100 * (await retainerFigures(env, tree, client, mo, entries)).hours) / allowance });
  const trend = usageTrend(usage);
  const over = r.hours - allowance;
  const expected = r.hours + r.planned;
  let sentence = `${client.name} has used ${fmt(r.hours)} of ${fmt(allowance)} retainer hours ${label}`;
  if (over > 0) sentence += `, ${fmt(over)} over the allowance`;
  if (r.planned > 0) {
    sentence += `, with ${fmt(r.planned)} more planned`;
    if (over <= 0 && expected > allowance) sentence += `, which would take it ${fmt(expected - allowance)} over`;
  }
  if (addHours !== null) {
    const withRequest = expected + addHours;
    sentence += `; this request's ${fmt(addHours)} hours would bring the month to ${fmt(withRequest)}` +
      (withRequest > allowance ? `, ${fmt(withRequest - allowance)} over` : '');
  }
  sentence += ` (${tool.label}).`;
  const mc = r.monthCard;
  return result(tool, env, {
    lines: [
      `${client.name}, ${label}: ${fmt(r.hours)} h logged of a ${fmt(allowance)} h allowance (${pct(r.hours, allowance)}).`,
      r.monthCard ? `Still planned on open steps under ${r.monthCard.name}: ${fmt(r.planned)} h. Expected month total: ${fmt(expected)} h.`
        : `No month card for ${client.name} ${label}: hours dated in the month on its retainer pieces. Still planned on open retainer work due ${label}: ${fmt(r.planned)} h. Expected month total: ${fmt(expected)} h.`,
      ...(addHours !== null ? [`With this request (${fmt(addHours)} h): ${fmt(expected + addHours)} h.`] : []),
      ...(mc ? [(() => { const m = forecastOf(tree, mc); return `Month card: ${mc.name}: Price ${money(num(mc.f.Price) || 0)}, Budget ${money(m.budget ?? 0)}, Forecast ${money(m.forecast)}, Headroom ${money(m.headroom ?? 0)}.`; })()] : []),
      `Pieces with hours${r.monthCard ? ` on ${r.monthCard.name}` : ` ${label}`}: ` + (r.pieces.length ? r.pieces.map((p) => `${p.card} ${fmt(p.hours)} h`).join('; ') : 'none') + '.',
      ...(r.internal_hours ? [`Left out: ${fmt(r.internal_hours)} h logged on internal rework (the agency's own redo, not the client's hours).`] : []),
      trend ? `Usage trend: the last three finished months (${trend.last_three.join(', ')}) averaged ${fmt(trend.last_three_avg_pct)}% of the allowance, the three before ${fmt(trend.previous_three_avg_pct)}%: ${trend.points > 0 ? '+' : ''}${fmt(trend.points)} points.`
        : `Usage trend: ${finishedMonths.length} finished month${finishedMonths.length === 1 ? '' : 's'}, fewer than six, so no trend yet.`,
    ],
    data: {
      client: client.name, month, allowance, hours_logged: round1(r.hours), used_pct: Math.round((100 * r.hours) / allowance),
      hours_over: round1(Math.max(0, over)), planned_open_hours: round1(r.planned), expected_month_hours: round1(expected),
      internal_rework_hours_left_out: round1(r.internal_hours),
      with_request_hours: addHours === null ? null : round1(expected + addHours), basis_used: r.basis, month_card: mc ? mc.id : null, pieces: r.pieces,
      trend, finished_months: usage.map((u) => ({ month: u.month, used_pct: round1(u.used_pct) })),
    },
    cards: [client.id, ...(mc ? [mc.id] : []), ...r.pieces.map((p) => p.id)],
    sentence,
  });
}

// --- client record -----------------------------------------------------------------------------------------

async function clientRecord(args, env) {
  const tool = TOOLS.client_record;
  const last = Math.min(12, Math.max(2, Math.round(Number(args.last ?? 6)) || 6));
  const jobType = jobTypeArg(args.job_type);
  const [clients, tree] = await Promise.all([allTasks(env, LISTS.clients, false), projects(env)]);
  const client = matchOne(clients, args.client);
  const done = filterUnits(finished(tree), { client, jobType }, env)
    .filter((t) => num(t.f['Late by']) !== null)
    .sort((a, b) => (delivered(b) || 0) - (delivered(a) || 0))
    .slice(0, last);
  const scope = jobType ? ` ${jobType}` : '';
  if (done.length < 2) {
    const n = done.length;
    return result(tool, env, {
      lines: [`${client.name}: ${n} finished${scope} project${n === 1 ? '' : 's'} on record.`],
      data: { client: client.name, job_type: jobType, projects: done.map((t) => t.id) }, cards: [client.id, ...done.map((t) => t.id)],
      sentence: `${client.name} has ${n === 0 ? 'no' : 'only one'} finished${scope} project${n === 1 ? '' : 's'}, so there is no client record yet (${tool.label}).`,
    });
  }
  const rows = done.map((t) => {
    const kids = tree.kids(t.id);
    const lateBy = num(t.f['Late by']);
    const deliver = kids.find((s) => s.name === 'Deliver');
    const field = num(t.f['Sign-off days']);
    const signOff = field !== null ? field
      : deliver?.start && deliver?.due ? days(deliver.start, deliver.due, env) - (deliver.estimate || 0) / 8 : null;
    const labels = Array.isArray(t.f.Rework) ? t.f.Rework : [];
    return {
      card: t.name, id: t.id, job_type: t.f['Job type'] || null, delivered: dateText(delivered(t), env),
      late_by: lateBy,
      sign_off_days: signOff === null ? null : round1(signOff),
      rounds_used: num(t.f['Rounds used']), rounds_included: num(t.f['Rounds included']),
      rework: labels, reworked: labels.length > 0 || tree.descendants(t.id).some((s) => /^rework\b/i.test(s.name)),
    };
  });
  const late = rows.filter((r) => r.late_by > 0);
  const onTime = rows.length - late.length;
  const signOffs = rows.map((r) => r.sign_off_days).filter((v) => v !== null);
  const avgSignOff = signOffs.length ? sum(signOffs) / signOffs.length : null;
  const withRounds = rows.filter((r) => r.rounds_included > 0);
  const usedUp = withRounds.filter((r) => r.rounds_used >= r.rounds_included);
  const reworked = rows.filter((r) => r.reworked);
  const flags = {
    slow_sign_off: avgSignOff !== null && avgSignOff > SIGN_OFF_ALLOWANCE,
    rounds_used_up_on_most: withRounds.length > 0 && usedUp.length > withRounds.length / 2,
  };
  let sentence = `${client.name}'s last ${rows.length} finished${scope} projects: ${onTime} on the agreed date`;
  if (late.length) {
    const lo = Math.min(...late.map((r) => r.late_by));
    const hi = Math.max(...late.map((r) => r.late_by));
    sentence += `, ${late.length} late by ${lo === hi ? lo : `${lo} to ${hi}`} day${hi === 1 ? '' : 's'}`;
  }
  if (avgSignOff !== null) sentence += `; sign-off averaged ${fmt(avgSignOff)} days against the ${SIGN_OFF_ALLOWANCE}-day allowance`;
  if (usedUp.length) sentence += `; every revision round used on ${usedUp.length} of ${withRounds.length}`;
  sentence += reworked.length ? `; rework on ${reworked.length}` : '; no rework';
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [
      `${client.name}, last ${rows.length} finished${scope} projects, newest first:`,
      ...rows.map((r) => `- ${r.card}, ${r.job_type || 'no job type'}, delivered ${r.delivered || 'date not set'}: ` +
        (r.late_by > 0
          ? `${r.late_by} day${r.late_by === 1 ? '' : 's'} late`
          : 'on the agreed date') +
        `; sign-off ${r.sign_off_days === null ? 'not dated' : `${fmt(r.sign_off_days)} days`}` +
        `; rounds ${r.rounds_used ?? '-'} of ${r.rounds_included ?? '-'}` +
        `; ${r.reworked ? `rework${r.rework.length ? ` (${r.rework.join(', ')})` : ''}` : 'no rework'}.`),
      `Patterns: sign-off ${flags.slow_sign_off ? 'slower than' : 'within'} the ${SIGN_OFF_ALLOWANCE}-day allowance` +
        `; rounds used up on ${usedUp.length} of ${withRounds.length}.`,
    ],
    data: {
      client: client.name, job_type: jobType,
      projects: rows,
      on_time: onTime, late: late.length, average_sign_off_days: avgSignOff === null ? null : round1(avgSignOff),
      sign_off_allowance_days: SIGN_OFF_ALLOWANCE, flags,
    },
    cards: [client.id, ...rows.map((r) => r.id)],
    sentence,
  });
}

// --- on time rate ------------------------------------------------------------------------------------------

async function onTimeRate(args, env) {
  const tool = TOOLS.on_time_rate;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const groupBy = args.group_by || 'month';
  const [client, tree] = await Promise.all([optionalClient(env, args.client), projects(env)]);
  const done = filterUnits(finished(tree), { client, jobType, per }, env).filter((t) => num(t.f['Late by']) !== null);
  const key = (t) => groupBy === 'client' ? clientName(t) : groupBy === 'job_type' ? (t.f['Job type'] || '(none)')
    : (delivered(t) ? monthOf(delivered(t), env) : '(no date)');
  const groups = new Map();
  for (const t of done) {
    const g = groups.get(key(t)) || { on: 0, n: 0, late: 0, days: 0 };
    g.n += 1;
    if (num(t.f['Late by']) <= 0) g.on += 1;
    else { g.late += 1; g.days += num(t.f['Late by']); }
    groups.set(key(t), g);
  }
  // Every group, each with its complete late jobs and late days; the lines show the first 25.
  const rows = [...groups.entries()].map(([k, g]) => ({ group: k, on_time: g.on, finished: g.n, share: Math.round((100 * g.on) / g.n), late_jobs: g.late, late_days: g.days }))
    .sort((a, b) => groupBy === 'month' ? a.group.localeCompare(b.group) : groupBy === 'client' ? (b.finished - b.on_time) - (a.finished - a.on_time) : a.group.localeCompare(b.group));
  const on = sum(rows.map((r) => r.on_time));
  const n = sum(rows.map((r) => r.finished));
  // Every late job, latest first (then by name, so the pages hold still), a page at a time.
  const lateAll = done.filter((t) => num(t.f['Late by']) > 0).sort((a, b) => num(b.f['Late by']) - num(a.f['Late by']) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pg = pageOf(lateAll, args.page);
  const late = pg.items;
  const scope = scopeWords(client, jobType, per);
  let sentence = `${scope}: ${on} of ${n} finished projects landed on the agreed date, ${pct(on, n)}`;
  const real = rows.filter((r) => r.finished >= 3 && !r.group.startsWith('('));
  if (real.length > 1) {
    const lo = real.reduce((a, b) => (b.share < a.share ? b : a));
    const hi = real.reduce((a, b) => (b.share > a.share ? b : a));
    const name = (r) => groupBy === 'month' ? monthLabel(r.group, env).replace(/^in /, '') : r.group;
    sentence += `; by ${groupBy.replace('_', ' ')}, from ${lo.share}% (${name(lo)}) to ${hi.share}% (${name(hi)})`;
  }
  if (n === 0) sentence = `${scope}: no finished projects to count`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [
      `${scope}, on the agreed date by ${groupBy.replace('_', ' ')}:`,
      ...rows.slice(0, PAGE_SIZE).map((r) => `- ${r.group}: ${r.on_time} of ${r.finished} (${r.share}%)`),
      ...(rows.length > PAGE_SIZE ? [`... and ${rows.length - PAGE_SIZE} more ${groupBy.replace('_', ' ')} rows in the data.`] : []),
      `All: ${on} of ${n} (${pct(on, n)}).`,
      `Late (${lateAll.length}): ` + late.map((t) => `${t.name} ${num(t.f['Late by'])} d`).join('; ') + '.',
      ...pageLine(pg, lateAll.length, 'Late jobs'),
    ],
    data: { client: client?.name ?? null, job_type: jobType, group_by: groupBy, rows, on_time: on, finished: n,
      late: late.map((t) => ({ card: t.name, id: t.id, client: clientName(t), late_by: num(t.f['Late by']) })),
      late_total: lateAll.length, page: pg.page, pages: pg.pages, next_page: pg.next_page, list_version: pg.version },
    cards: [...(client ? [client.id] : []), ...late.map((t) => t.id)],
    sentence,
  });
}

// --- rework by cause ---------------------------------------------------------------------------------------

// Rework tag completeness: rework steps (named "Rework: ...", or under a Client or Internal rework card)
// with time logged, and of those the ones where no entry carries a cause tag (rework: client or rework: internal).
// steps: [{ id, entries: [{ hours, labels }] }].
export function reworkCompleteness(steps) {
  const timed = steps.filter((s) => s.entries.length);
  const untagged = timed.filter((s) => !s.entries.some((e) => e.labels.some((l) => /^rework/i.test(l))));
  return { rework_steps_with_time: timed.length, without_cause_tag: untagged.length,
    untagged_hours: round1(sum(untagged.flatMap((s) => s.entries.map((e) => e.hours)))) };
}

async function reworkByCause(args, env) {
  const tool = TOOLS.rework_by_cause;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const [client, tree, entries] = await Promise.all([optionalClient(env, args.client), projects(env), timeEntries(env, ...ALL_TIME())]);
  const groupBy = args.group_by || (client ? 'step' : 'client');
  const groups = new Map();
  const tot = { client_h: 0, client_usd: 0, internal_h: 0, internal_usd: 0 };
  for (const e of entries) {
    const labels = e.labels.filter((l) => l.toLowerCase().startsWith('rework'));
    if (!labels.length || !e.task || !per.has(dayNumber(e.start, env)) || onTest(e, tree)) continue;
    const unitId = tree.unitOf(e.task);
    const card = unitId ? tree.byId.get(unitId) : null;
    if (client && !(card && isFor(card, client))) continue;
    if (jobType && (card?.f['Job type'] || '') !== jobType) continue;
    const task = tree.byId.get(e.task);
    const step = task && task.id !== unitId ? task.name.replace(/^Rework: /, '') : '(card)';
    if (args.step && step.toLowerCase() !== String(args.step).toLowerCase()) continue;
    const rate = num(card?.f.Rate) || 65;
    const cause = labels[0].toLowerCase().includes('client') ? 'client' : 'internal';
    const k = groupBy === 'step' ? step : groupBy === 'job_type' ? (card?.f['Job type'] || '(none)') : (card ? clientName(card) : '(unknown)');
    const g = groups.get(k) || { group: k, client_h: 0, client_usd: 0, internal_h: 0, internal_usd: 0, cards: new Set() };
    g[`${cause}_h`] += e.hours; g[`${cause}_usd`] += e.hours * rate;
    tot[`${cause}_h`] += e.hours; tot[`${cause}_usd`] += e.hours * rate;
    if (unitId) g.cards.add(unitId);
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => (b.client_h + b.internal_h) - (a.client_h + a.internal_h) || a.group.localeCompare(b.group));
  const pg = pageOf(rows, args.page);
  // Completeness: the rework steps in scope with time logged in the period, and whether any entry names a cause.
  const onStep = new Map();
  for (const e of entries) if (e.task && per.has(dayNumber(e.start, env))) onStep.set(e.task, [...(onStep.get(e.task) || []), e]);
  const inChain = (t) => /^Rework: /.test(t.name) || (t.parent && /^(client|internal) rework\b/i.test(tree.byId.get(t.parent)?.name || ''));
  const reworkSteps = [...tree.byId.values()].filter((t) => t.parent && !tree.hasKids(t.id) && inChain(t)).filter((t) => {
    const card = tree.byId.get(tree.unitOf(t.id));
    if (!card || isTest(card) || (client && !isFor(card, client)) || (jobType && (card.f['Job type'] || '') !== jobType)) return false;
    return !args.step || t.name.replace(/^Rework: /, '').toLowerCase() === String(args.step).toLowerCase();
  }).map((t) => ({ id: t.id, entries: onStep.get(t.id) || [] }));
  const completeness = reworkCompleteness(reworkSteps);
  const scope = `${scopeWords(client, jobType, per)}${args.step ? `, ${args.step}` : ''}`;
  let sentence = `${scope}: ${fmt(tot.client_h)} hours of client revisions (${money(tot.client_usd)}) and ${fmt(tot.internal_h)} hours of our own redo (${money(tot.internal_usd)})`;
  if (rows.length > 1) sentence += `; the most on ${rows[0].group}, ${fmt(rows[0].client_h + rows[0].internal_h)} hours`;
  if (completeness.rework_steps_with_time) sentence += `; ${completeness.without_cause_tag} of ${completeness.rework_steps_with_time} rework steps with time logged carry no cause tag`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [
      `${scope}, rework by ${groupBy.replace('_', ' ')}:`,
      ...pg.items.map((r) => `- ${r.group}: client ${fmt(r.client_h)} h (${money(r.client_usd)}), internal ${fmt(r.internal_h)} h (${money(r.internal_usd)})`),
      ...pageLine(pg, rows.length, 'Rows'),
      `All: client ${fmt(tot.client_h)} h (${money(tot.client_usd)}), internal ${fmt(tot.internal_h)} h (${money(tot.internal_usd)}).`,
      `Completeness: ${completeness.without_cause_tag} of ${completeness.rework_steps_with_time} rework steps with time logged carry no cause tag (${fmt(completeness.untagged_hours)} h untagged).`,
    ],
    data: { client: client?.name ?? null, job_type: jobType, step: args.step ?? null, group_by: groupBy, completeness,
      totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, round1(v)])),
      rows: pg.items.map(({ cards, ...r }) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round1(v) : v]))),
      rows_total: rows.length, page: pg.page, pages: pg.pages, next_page: pg.next_page, list_version: pg.version },
    cards: pg.items.slice(0, 5).flatMap((r) => [...r.cards].slice(0, 6)),
    sentence,
  });
}

// --- time by step ------------------------------------------------------------------------------------------

async function timeByStep(args, env) {
  const tool = TOOLS.time_by_step;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const [client, tree, entries] = await Promise.all([optionalClient(env, args.client), projects(env), timeEntries(env, ...ALL_TIME())]);
  const done = filterUnits(finished(tree), { client, jobType, per }, env);
  const doneIds = new Set(done.map((t) => t.id));
  const onTask = new Map();
  for (const e of entries) if (e.task && doneIds.has(tree.unitOf(e.task))) onTask.set(e.task, (onTask.get(e.task) || 0) + e.hours);
  const steps = new Map();
  for (const card of done) {
    for (const s of tree.kids(card.id)) {
      const base = s.name.replace(/^Rework: /, '');
      if (!STEP_NAMES.includes(base)) continue;
      const g = steps.get(base) || { step: base, hours_logged: 0, hours_estimated: 0, steps: 0, waits: [] };
      g.hours_logged += onTask.get(s.id) || 0;
      g.hours_estimated += s.estimate || 0;
      if (s.start && s.due) { g.waits.push(days(s.start, s.due, env) - (s.estimate || 0) / 8); g.steps += 1; }
      steps.set(base, g);
    }
  }
  const rows = [...steps.values()].map((g) => ({ step: g.step, hours_logged: round1(g.hours_logged), hours_estimated: round1(g.hours_estimated),
    steps: g.steps, average_wait_days: g.waits.length ? round1(sum(g.waits) / g.waits.length) : null }))
    .sort((a, b) => b.hours_logged - a.hours_logged);
  const scope = scopeWords(client, jobType, per);
  const waits = rows.filter((r) => r.average_wait_days !== null).sort((a, b) => b.average_wait_days - a.average_wait_days);
  let sentence = `${scope}, finished work: `;
  if (waits.length >= 2) sentence += `${waits[0].step} waits ${fmt(waits[0].average_wait_days)} days beyond its estimate and ${waits[1].step} ${fmt(waits[1].average_wait_days)}; `;
  sentence += rows.length ? `the most hours go to ${rows[0].step}, ${fmt(rows[0].hours_logged)} logged against ${fmt(rows[0].hours_estimated)} estimated` : 'no steps to count';
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`${scope}, finished work, by step:`,
      ...rows.map((r) => `- ${r.step}: ${fmt(r.hours_logged)} h logged, ${fmt(r.hours_estimated)} h estimated, ${r.steps} steps, average wait ${r.average_wait_days === null ? '-' : `${fmt(r.average_wait_days)} days`}`)],
    data: { client: client?.name ?? null, job_type: jobType, rows },
    cards: client ? [client.id] : [],
    sentence,
  });
}

// --- estimate accuracy -------------------------------------------------------------------------------------

async function estimateAccuracy(args, env) {
  const tool = TOOLS.estimate_accuracy;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const [client, tree, entries] = await Promise.all([optionalClient(env, args.client), projects(env), timeEntries(env, ...ALL_TIME())]);
  const done = filterUnits(finished(tree), { client, jobType, per }, env).filter((t) => num(t.f['Initial forecast']) && num(t.f.Rate));
  const hours = new Map();
  for (const e of entries) {
    const u = e.task && tree.unitOf(e.task);
    if (u) hours.set(u, (hours.get(u) || 0) + e.hours);
  }
  const gaps = done.map((t) => {
    const f0 = num(t.f['Initial forecast']);
    const cost = (hours.get(t.id) || 0) * num(t.f.Rate) + (num(t.f['Supplier cost']) || 0);
    return { card: t.name, id: t.id, job_type: t.f['Job type'] || '(none)', month: delivered(t) ? monthOf(delivered(t), env) : '(no date)',
      initial_forecast: f0, cost_at_close: Math.round(cost), gap: (cost - f0) / f0 };
  });
  const group = (k) => {
    const m = new Map();
    for (const g of gaps) m.set(g[k], [...(m.get(g[k]) || []), g.gap]);
    return [...m.entries()].map(([key, v]) => ({ group: key, projects: v.length, average_gap: Math.round(100 * sum(v) / v.length) }))
      .sort((a, b) => a.group.localeCompare(b.group));
  };
  const byJob = group('job_type');
  const byMonth = group('month');
  const all = gaps.length ? sum(gaps.map((g) => g.gap)) / gaps.length : 0;
  const worst = [...gaps].sort((a, b) => b.gap - a.gap).slice(0, 5);
  const scope = scopeWords(client, jobType, per);
  let sentence = gaps.length ? `${scope}: finished work ran ${signedPct(all).replace('+', '')} ${all >= 0 ? 'over' : 'under'} its first forecast on average across ${gaps.length} projects` : `${scope}: no finished projects with a first forecast`;
  if (byJob.length > 1) {
    const far = byJob.reduce((a, b) => (Math.abs(b.average_gap) > Math.abs(a.average_gap) ? b : a));
    sentence += `; ${far.group} furthest out at ${Math.abs(far.average_gap)}% ${far.average_gap >= 0 ? 'over' : 'under'}`;
  }
  const months = byMonth.filter((m) => !m.group.startsWith('(') && m.projects >= 3);
  if (months.length > 1) sentence += `; ${Math.abs(months[0].average_gap)}% in ${monthLabel(months[0].group, env).replace(/^in /, '')}, ${Math.abs(months.at(-1).average_gap)}% in ${monthLabel(months.at(-1).group, env).replace(/^in /, '').replace('this month', 'this month so far')}`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`${scope}, cost at close against the first forecast:`,
      'By job type: ' + byJob.map((r) => `${r.group} ${r.projects} projects ${signedPct(r.average_gap / 100)}`).join('; ') + '.',
      'By month delivered: ' + byMonth.map((r) => `${r.group} ${r.projects} projects ${signedPct(r.average_gap / 100)}`).join('; ') + '.',
      'Largest overruns: ' + worst.map((g) => `${g.card} ${signedPct(g.gap)}`).join('; ') + '.'],
    data: { client: client?.name ?? null, job_type: jobType, projects: gaps.length, average_gap_pct: Math.round(100 * all), by_job_type: byJob, by_month: byMonth,
      largest_overruns: worst.map((g) => ({ ...g, gap: Math.round(100 * g.gap) })) },
    cards: worst.map((g) => g.id),
    sentence,
  });
}

// --- estimate accuracy by step ------------------------------------------------------------------------------

// A step's kind of work, from its own Rework label and its parents, in work mix's words (MIX_KINDS).
export function stepKind(step, tree) {
  const labels = Array.isArray(step.f?.Rework) ? step.f.Rework : [];
  if (labels.includes('Client')) return 'client revisions';
  if (labels.includes('Internal')) return 'internal rework';
  const unitId = tree.unitOf(step.id);
  for (let cur = tree.byId.get(step.parent); cur; cur = cur.parent ? tree.byId.get(cur.parent) : null) {
    if (cur.f['Request kind'] === 'Change') return 'changes';
    if (cur.id === unitId) break;
  }
  const unit = tree.byId.get(unitId);
  if (unit && ((unit.parent && isMonth(tree.byId.get(unit.parent) || {})) || unit.f['Agreement type'] === 'Retainer')) return 'retainer pieces';
  return 'new projects';
}

const BY_STEP_WORDS = { kind: 'kind of work', job_type: 'job type', step: 'step', client: 'client', owner: 'owner', month: 'month' };
// Hours estimated against hours tracked on every step that has both, grouped and sorted worst first (the largest
// overrun in percent, then in hours).
// lastDay: Map(step id -> the last day time was logged on it), the step's finish; else its close date, else its due date.
export function accuracyByStep(tree, { groupBy = 'kind', client = null, jobType = null, step = null, per = null, lastDay = null } = {}, env) {
  const groups = new Map();
  const tot = { steps: 0, est: 0, tracked: 0 };
  for (const s of tree.byId.values()) {
    if (!s.parent || !(s.estimate > 0) || !(s.tracked > 0) || STAGE_NAMES.has(s.name) || tree.hasKids(s.id)) continue;
    const unitId = tree.unitOf(s.id);
    const unit = unitId && unitId !== s.id ? tree.byId.get(unitId) : null;
    if (!unit || isTest(unit) || isMonth(unit)) continue;
    if (client && !isFor(unit, client)) continue;
    if (jobType && (unit.f['Job type'] || '') !== jobType) continue;
    const name = s.name.replace(/^Rework: /, '');
    if (step && name.toLowerCase() !== String(step).toLowerCase()) continue;
    const logged = lastDay?.get(s.id) ?? null;
    const when = logged !== null ? logged * DAY_MS + 12 * 3_600_000 : (s.closedOn ?? s.due ?? null);
    if (per && (per.from !== null || per.to !== null) && !per.has(when === null ? null : dayNumber(when, env))) continue;
    const k = groupBy === 'kind' ? stepKind(s, tree) : groupBy === 'job_type' ? (unit.f['Job type'] || '(none)')
      : groupBy === 'step' ? name : groupBy === 'client' ? clientName(unit)
        : groupBy === 'owner' ? (s.people.length ? s.people.join(', ') : s.teams.length ? `the ${s.teams[0]} Team` : '(no owner)')
          : when === null ? '(no date)' : monthOf(when, env);
    const g = groups.get(k) || { group: k, steps: 0, est: 0, tracked: 0, cards: new Set() };
    g.steps += 1; g.est += s.estimate; g.tracked += s.tracked; g.cards.add(unit.id);
    groups.set(k, g);
    tot.steps += 1; tot.est += s.estimate; tot.tracked += s.tracked;
  }
  const row = (g) => ({ steps: g.steps, hours_estimated: round1(g.est), hours_tracked: round1(g.tracked), gap_hours: round1(g.tracked - g.est),
    gap_pct: g.est ? Math.round((100 * (g.tracked - g.est)) / g.est) : null });
  const rows = [...groups.values()].map((g) => ({ group: g.group, ...row(g), cards: [...g.cards] }))
    .sort((a, b) => b.gap_pct - a.gap_pct || b.gap_hours - a.gap_hours || String(a.group).localeCompare(String(b.group)));
  return { rows, totals: row(tot) };
}

async function estimateAccuracyByStep(args, env) {
  const tool = TOOLS.estimate_accuracy_by_step;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const groupBy = args.group_by || 'kind';
  if (!BY_STEP_WORDS[groupBy]) throw new UserError(`"${groupBy}" is not a grouping; use one of ${Object.keys(BY_STEP_WORDS).join(', ')}`);
  const [client, tree, entries] = await Promise.all([optionalClient(env, args.client), projects(env), timeEntries(env, ...ALL_TIME())]);
  const lastDay = new Map();
  for (const e of entries) if (e.task) lastDay.set(e.task, Math.max(lastDay.get(e.task) ?? -Infinity, dayNumber(e.start, env)));
  const { rows, totals } = accuracyByStep(tree, { groupBy, client, jobType, step: args.step ?? null, per, lastDay }, env);
  const scope = `${scopeWords(client, jobType, per)}${args.step ? `, ${args.step}` : ''}`;
  const over = (p) => `${Math.abs(p)}% ${p >= 0 ? 'over' : 'under'}`;
  const hrs = (h) => `${fmt(Math.abs(h))} hour${Math.abs(h) === 1 ? '' : 's'} ${h >= 0 ? 'over' : 'under'}`;
  const signed = (h) => `${h > 0 ? '+' : ''}${fmt(h)}`;
  let sentence;
  if (!totals.steps) sentence = `${scope}: no steps with both a time estimate and time tracked (${tool.label}).`;
  else {
    sentence = `${scope}: ${totals.steps} steps tracked ${fmt(totals.hours_tracked)} hours against ${fmt(totals.hours_estimated)} estimated, ${over(totals.gap_pct)}`;
    if (rows.length > 1) {
      const w = rows[0];
      sentence += w.gap_pct > 0 ? `; by ${BY_STEP_WORDS[groupBy]}, ${w.group} runs furthest over, ${w.gap_pct}% (${hrs(w.gap_hours)} across ${w.steps} steps)`
        : `; by ${BY_STEP_WORDS[groupBy]}, none runs over, ${w.group} comes closest at ${over(w.gap_pct)}`;
    }
    sentence += ` (${tool.label}).`;
  }
  return result(tool, env, {
    lines: [`${scope}, hours tracked against hours estimated on each step, by ${BY_STEP_WORDS[groupBy]}, worst first:`,
      ...rows.slice(0, 25).map((r) => `- ${r.group}: ${fmt(r.hours_tracked)} h tracked against ${fmt(r.hours_estimated)} h estimated, ${signed(r.gap_hours)} h (${signedPct(r.gap_pct / 100)}), ${r.steps} steps`),
      `All: ${fmt(totals.hours_tracked)} h tracked against ${fmt(totals.hours_estimated)} h estimated, ${signed(totals.gap_hours)} h (${signedPct((totals.gap_pct ?? 0) / 100)}), ${totals.steps} steps.`],
    data: { client: client?.name ?? null, job_type: jobType, step: args.step ?? null, group_by: groupBy, totals,
      rows: rows.slice(0, 25).map(({ cards, ...r }) => r) },
    cards: rows.slice(0, 5).flatMap((r) => r.cards.slice(0, 6)),
    sentence,
  });
}

// --- margin by client --------------------------------------------------------------------------------------

// Margin rows from priced items ({ id, client, job_type, agreement, kind: 'projects' | 'retainer_months', price, cost }),
// grouped by client, job type or agreement type, lowest margin first. A client grouping keeps the client field.
const MARGIN_GROUPS = { client: 'client', job_type: 'job type', agreement_type: 'agreement type' };
export function marginGroups(items, groupBy = 'client') {
  const rows = new Map();
  for (const it of items) {
    const g = groupBy === 'client' ? it.client : groupBy === 'job_type' ? (it.job_type || '(no job type)') : it.agreement;
    const r = rows.get(g) || { group: g, ...(groupBy === 'client' ? { client: g } : {}), projects: 0, retainer_months: 0, price: 0, cost: 0, cards: [] };
    r[it.kind] += 1; r.price += it.price; r.cost += it.cost; r.cards.push(it.id);
    rows.set(g, r);
  }
  return [...rows.values()].map((r) => ({ ...r, margin: Math.round(r.price - r.cost), margin_pct: r.price ? Math.round((100 * (r.price - r.cost)) / r.price) : null }))
    .sort((a, b) => a.margin_pct - b.margin_pct || String(a.group).localeCompare(String(b.group)));
}

async function marginByClient(args, env) {
  const tool = TOOLS.margin_by_client;
  const per = period(args);
  const state = args.state || 'all';
  const [client, tree, entries] = await Promise.all([optionalClient(env, args.client), projects(env), timeEntries(env, ...ALL_TIME())]);
  const hours = new Map();
  for (const e of entries) {
    const u = e.task && tree.unitOf(e.task);
    if (u) hours.set(u, (hours.get(u) || 0) + e.hours);
  }
  const inState = (t) => state === 'all' || (state === 'finished' ? t.closed : !t.closed);
  const fixed = tree.units.filter((t) => t.f['Agreement type'] === 'Fixed fee' && num(t.f.Price) && inState(t)
    && (!client || isFor(t, client)) && ((per.from === null && per.to === null) || per.has(delivered(t) ? dayNumber(delivered(t), env) : null)));
  // A month card counts once it has pieces under it; an empty one (no work nested yet) would read as 100% margin.
  // A month card counts by the month it covers (its due date) when a period is asked for, as in a month's review.
  const months = tree.months.filter((m) => num(m.f.Price) && inState(m) && (!client || isFor(m, client)) && tree.kids(m.id).length > 0
    && ((per.from === null && per.to === null) || per.has(m.due ? dayNumber(m.due, env) : null)));
  const groupBy = args.group_by || 'client';
  if (!MARGIN_GROUPS[groupBy]) throw new UserError(`"${groupBy}" is not a grouping; use client, job_type or agreement_type`);
  const items = [];
  for (const t of fixed) items.push({ id: t.id, client: clientName(t), job_type: t.f['Job type'] || null, agreement: 'Fixed fee', kind: 'projects',
    price: num(t.f.Price), cost: (hours.get(t.id) || 0) * (num(t.f.Rate) || 65) + (num(t.f['Supplier cost']) || 0) });
  const onTask = new Map();
  for (const e of entries) if (e.task) onTask.set(e.task, (onTask.get(e.task) || 0) + e.hours);
  for (const m of months) {
    const h = [m, ...tree.descendants(m.id)].reduce((a, x) => a + (onTask.get(x.id) || 0), 0);
    items.push({ id: m.id, client: clientName(m), job_type: m.f['Job type'] || null, agreement: 'Retainer', kind: 'retainer_months',
      price: num(m.f.Price), cost: h * (num(m.f.Rate) || 65) + (num(m.f['Supplier cost']) || 0) });
  }
  const list = marginGroups(items, groupBy);
  const pg = pageOf(list, args.page);
  const total = { price: sum(list.map((r) => r.price)), cost: sum(list.map((r) => r.cost)) };
  const scope = `${client ? client.name : 'All clients'}${state === 'all' ? '' : `, ${state} work`}${per.label}`;
  const across = (r) => `${r.projects} fixed-fee project${r.projects === 1 ? '' : 's'}${r.retainer_months ? ` and ${r.retainer_months} retainer month${r.retainer_months === 1 ? '' : 's'}` : ''}`;
  let sentence;
  if (!list.length) sentence = `${scope}: no priced work to count (${tool.label}).`;
  else if ((client && groupBy === 'client') || list.length === 1) {
    const r = list[0];
    sentence = `${r.group}: margin ${r.margin_pct}% (${money(r.margin)} on ${money(r.price)}) across ${across(r)} (${tool.label}).`;
  } else {
    const sized = list.filter((r) => r.projects + r.retainer_months >= 2);
    const lo = (sized.length ? sized : list)[0];
    sentence = `${lo.group} has the lowest margin, ${lo.margin_pct}% on ${money(lo.price)} across ${across(lo)}; across all ${MARGIN_GROUPS[groupBy]}s the margin is ${pct(total.price - total.cost, total.price)} (${tool.label}).`;
  }
  return result(tool, env, {
    lines: [`${scope}, margin by ${MARGIN_GROUPS[groupBy]}, lowest first:`,
      ...pg.items.map((r) => `- ${r.group}: price ${money(r.price)}, cost ${money(r.cost)}, margin ${money(r.margin)} (${r.margin_pct}%); ${r.projects} fixed-fee project${r.projects === 1 ? '' : 's'}${r.retainer_months ? `, ${r.retainer_months} retainer month${r.retainer_months === 1 ? '' : 's'}` : ''}`),
      ...pageLine(pg, list.length, 'Rows'),
      `All: price ${money(total.price)}, cost ${money(total.cost)}, margin ${pct(total.price - total.cost, total.price)}.`,
      'Retainer pieces carry no price of their own: a retainer client\'s money is on its month cards.'],
    data: { client: client?.name ?? null, state, group_by: groupBy, rows: pg.items.map(({ cards, ...r }) => ({ ...r, price: Math.round(r.price), cost: Math.round(r.cost) })),
      rows_total: list.length, page: pg.page, pages: pg.pages, next_page: pg.next_page, list_version: pg.version,
      total: { price: Math.round(total.price), cost: Math.round(total.cost) } },
    cards: pg.items.slice(0, 3).flatMap((r) => r.cards.slice(0, 5)),
    sentence,
  });
}

// --- the live project and the scheduling engine ------------------------------------------------------------

// Everything open and dated on both Lists, for the bookings; each step named by its client and step for the
// competing-work line ("Client Q's Write copy"), or by its card where it has no client.
// Shared by calls that arrive together, with a store for the forecasts and the reshuffle worked out from it.
function liveWork(env) { return sharedRead('live', () => loadLive(env)); }
async function loadLive(env) {
  const [tree, intake, members] = await Promise.all([projects(env), allTasks(env, LISTS.intake, true), teamMembers(env)]);
  if (env.PREVIEW_REPLAN !== '1') return buildLive(env, tree, makeTree(intake), members);
  // Preview mode, only when the variable PREVIEW_REPLAN is "1" (wrangler.toml does not set it): the cards read as the
  // re-plan would leave them (with PREVIEW_REPLAN_MODE "rule", as the rule fix would), with any Due dates in
  // PREVIEW_DUE moved, so the tools can be tried on that state before anything is written to ClickUp.
  const due = JSON.parse(env.PREVIEW_DUE || '{}');
  const moved = makeTree([...tree.byId.values()].map((x) => (due[x.id] ? { ...x, due: dateArg(due[x.id], 'PREVIEW_DUE') * DAY_MS + 12 * HOUR_MS } : x)));
  const base = buildLive(env, moved, makeTree(intake), members);
  const r = env.PREVIEW_REPLAN_MODE === 'rule' ? ruleFix(base, env) : replanLive(base, env, await supplierTerms(env));
  return Object.assign(r.live, { replan: r.rows, dueOverrides: due });
}
// The live picture from the two trees: every open, dated step's booked hours (Workload's method), by person and by
// step. Test a fix builds one from the cards as a change would leave them.
export function buildLive(env, tree, intakeTree, members) {
  const isStep = (t, tr) => t.parent && !t.closed && !STAGE_NAMES.has(t.name) && !isMonth(t) && !tr.hasKids(t.id) && tr.unitOf(t.id) !== t.id;
  const unitOfStep = new Map();
  const steps = [];
  for (const tr of [tree, intakeTree]) {
    for (const t of tr.byId.values()) {
      if (!isStep(t, tr)) continue;
      steps.push(t);
      unitOfStep.set(t.id, tr.byId.get(tr.unitOf(t.id)) || null);
    }
  }
  const labelOf = (s) => {
    const unit = unitOfStep.get(s.id);
    const who = !unit ? null : clientName(unit) === '(no client)' ? unit.name : clientName(unit);
    return who ? `${who}'s ${s.name}` : s.name;
  };
  return { tree, intakeTree, members, steps, unitOfStep, booked: bookings(steps, env, members), bookedBy: bookingsBy(steps, env, members, labelOf),
    walks: new Map(), reshuffles: new Map() };
}

function openSteps(tree, unitId) {
  return tree.descendants(unitId).filter((s) => !s.closed && !STAGE_NAMES.has(s.name) && !tree.hasKids(s.id))
    .sort((a, b) => (a.start ?? a.due ?? Infinity) - (b.start ?? b.due ?? Infinity) || (a.due ?? Infinity) - (b.due ?? Infinity));
}

function findProject(tree, typed) {
  const live = [...tree.units.filter((t) => !t.closed), ...tree.months.filter((m) => !m.closed)];
  try { return matchOne(live, typed, 'live project'); } catch (e) {
    if (!String(e.message).startsWith('No live project')) throw e;
    try { return matchOne([...tree.units, ...tree.months], typed, 'project'); } catch (e2) {
      const test = testCard(tree, typed);
      if (test) return test;
      throw e2;
    }
  }
}

// A [Test] card named by its id or its exact name. The tools leave [Test] cards out of every list and
// count; one named exactly can still be read, so a write can be tried on it. Its dated steps book time like any card's.
export function testCard(tree, typed) {
  const id = cardRef(typed);
  const top = (t) => !!t && isTest(t) && !t.closed && (!t.parent || isMonth(tree.byId.get(t.parent) || {}));
  if (top(tree.byId.get(id))) return tree.byId.get(id);
  const name = String(typed ?? '').trim().toLowerCase();
  const named = [...tree.byId.values()].filter((t) => top(t) && t.name.trim().toLowerCase() === name);
  return named.length === 1 ? named[0] : null;
}

// A fingerprint of a plan as a tool calculated it: the write tool that writes it calculates it again
// and writes only when the two fingerprints are the same, so nothing that moved since is written.
export const planKeyOf = (parts) => versionOf(parts);

// Whose time a step uses: the person on it; else the lead its Assignment role names on the card; else the Team
// saved on it (its members' time); else the segments of the Skill Plan the work (copy to Copy, files to Studio, reviews and
// Design to the creative lead, Internal review and Deliver to the account lead).
const SEGMENT_OWNER = { 'Write copy': ['team', 'Copy'], 'Write script': ['team', 'Copy'], 'Package files': ['team', 'Studio'],
  'Produce video': ['team', 'Studio'], 'Review copy': ['role', 'Creative lead'], 'Review script': ['role', 'Creative lead'],
  Design: ['role', 'Creative lead'], 'Internal review': ['role', 'Account lead'], Deliver: ['role', 'Account lead'] };
// The Team a step belongs to: the Team saved on it, else its segment's (Write copy and Write script to Copy, Package
// files and Produce video to Studio); a review, Design, Internal review and Deliver belong to one role, not a Team.
function teamOf(s) {
  if (s.teams.length) return s.teams[0];
  const seg = SEGMENT_OWNER[s.name.replace(/^Rework: /, '')];
  return seg?.[0] === 'team' ? seg[1] : null;
}
function stepOwners(s, card, members) {
  if (s.people.length) return { owners: s.people, label: s.people.join(', ') };
  const lead = (role) => (Array.isArray(card.f[role]) ? card.f[role].map((x) => x.name).filter(Boolean) : []);
  const role = s.f['Assignment role'];
  if (role && lead(role).length) return { owners: lead(role), label: lead(role).join(', ') };
  const team = (t) => ({ owners: members.get(t) || [], label: `the ${t} Team${(members.get(t) || []).length ? ` (${members.get(t).join(', ')})` : ''}` });
  if (s.teams.length) return team(s.teams[0]);
  const seg = SEGMENT_OWNER[s.name.replace(/^Rework: /, '')];
  if (seg?.[0] === 'team') return team(seg[1]);
  if (seg?.[0] === 'role' && lead(seg[1]).length) return { owners: lead(seg[1]), label: lead(seg[1]).join(', ') };
  return { owners: [], label: 'no owner' };
}

// The engine's steps for a card's open steps; `fill(s)` adds a step's sizes and windows.
function engineSteps(tree, card, live, env, fill = () => ({})) {
  const steps = openSteps(tree, card.id);
  const ids = new Set(steps.map((s) => s.id));
  const resolve = (id) => (ids.has(id) ? [id] : tree.descendants(id).filter((x) => ids.has(x.id)).map((x) => x.id));
  const anyLinks = steps.some((s) => s.waitsOn.length);
  const order = [...steps].sort((a, b) => STEP_NAMES.indexOf(a.name.replace(/^Rework: /, '')) - STEP_NAMES.indexOf(b.name.replace(/^Rework: /, '')));
  return steps.map((s) => {
    const { owners, label } = stepOwners(s, card, live.members);
    let waitsOn = [...new Set(s.waitsOn.flatMap(resolve))].filter((w) => w !== s.id);
    if (!anyLinks) { const i = order.indexOf(s); waitsOn = i > 0 ? [order[i - 1].id] : []; } // no links on the card: the usual order
    return {
      id: s.id, name: s.name, owners, ownerLabel: label, hours: s.estimate || 0, sizeNote: null,
      plannedStart: s.start ? dayNumber(s.start, env) : null, plannedDue: s.due ? dayNumber(s.due, env) : null,
      waitsOn, ...fill(s),
    };
  });
}

// Recovery's fixed windows for a step with no dates: Design gets one day to release the brief plus the package's
// turnaround (Supplier operating agreement), Deliver the client's sign-off time (their record). A dated Design or
// Deliver keeps its planned window with the agency or the client (the engine's default).
// Approved and not started: To do, or Ready (the step before is done and nobody has started; it is
// someone's turn). Only steps are set Ready, but a retainer piece is a step of its month card, so a job can read Ready.
export const notStarted = (t) => ['to do', 'ready'].includes(String(t.status || '').toLowerCase());
const isLive = (t) => String(t.status || '').toLowerCase() === 'in progress' || notStarted(t);

// A step not yet started: To do or Ready, with no time logged.
const started = (s) => !/^(to do|ready)$/i.test(String(s.status || '')) || (s.tracked || 0) > 0;

function recoveryFill(tree, unit, env, terms) {
  return (s) => {
    if (s.start && s.due) return {};
    const base = s.name.replace(/^Rework: /, '');
    if (base === 'Design') {
      const agency = agencyFor(terms, unit.f['Job type'], num(unit.f['Supplier cost']));
      return agency?.turnaround
        ? { agencyDays: 1 + agency.turnaround, agencyNote: `one working day to release the brief and the agency's ${agency.turnaround}-working-day turnaround for the ${agency.size.toLowerCase()} package (Supplier operating agreement)` }
        : { agencyNote: 'no dates and no package in the Supplier operating agreement matches the card\'s Supplier cost: one working day' };
    }
    if (base === 'Deliver') {
      const so = signOffFor(tree, unit, env);
      return { signOffDays: so.days, signOffNote: so.average === null ? so.note : `${so.note} (advice only: ${so.advice})` };
    }
    return {};
  };
}

// The engine's input for a live card in recovery mode: its open steps from today on their
// remaining hours in people's actual free time day by day, at 100% unless asked otherwise; other work as booked.
function recoveryInput(live, unit, env, { fromDn = null, whatIf = null, capPct = 100, terms = null, fill = null } = {}) {
  const steps = openSteps(live.tree, unit.id);
  const own = bookings(steps, env, live.members);
  const fixed = recoveryFill(live.tree, unit, env, terms);
  return {
    mode: 'recovery', today: Math.max(today(env), fromDn ?? today(env)), capPct, capacity: CAPACITY,
    booked: without(live.booked, own), bookedBy: withoutBy(live.bookedBy, new Set(steps.map((s) => s.id))),
    // A step not started is replayed no earlier than its planned start, and the steps after it wait at least for its
    // planned due date, so a step pushed past the one that waits on it shows there; a started step plays
    // on from today.
    steps: engineSteps(live.tree, unit, live, env, (s) => ({ ...fixed(s), ...(fill ? fill(s) : {}),
      ...(!started(s) && s.start ? { floor: dayNumber(s.start, env), floorWhy: 'its planned start (not started yet)' } : {}),
      ...(!started(s) && s.due ? { holdDue: dayNumber(s.due, env) } : {}) })),
    promise: unit.due ? dayNumber(unit.due, env) : null, whatIf,
    // An approved job at To do (or Ready) has not kicked off: its steps keep their planned starts. A job In progress
    // is played forward from today.
    keepStarts: notStarted(unit),
  };
}

export function rewalk(live, unit, env, opts = {}) { return schedule(recoveryInput(live, unit, env, opts)); }

// The smallest change that makes the cards follow the rule: on every live job, each open step not yet started whose
// planned start falls on or before the card due date of the step it waits on moves, keeping its working days, to the
// working day after; the steps are taken in chain order, so a step is checked against where
// the one before it now ends. Nothing else moves.
export function ruleFix(live, env) {
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const started = (s) => !/^(to do|ready)$/i.test(String(s.status || '')) || (s.tracked || 0) > 0;
  const changes = [];
  const rows = [];
  for (const u of live.tree.units.filter(isLive)) {
    const steps = engineSteps(live.tree, u, live, env);
    const at = new Map(steps.map((s) => [s.id, { start: s.plannedStart, due: s.plannedDue }]));
    const done = new Set();
    const left = [...steps];
    const row = { card: u.name, id: u.id, due_date: u.due ? isoDay(dn(u.due)) : null, steps: [] };
    while (left.length) {
      let i = left.findIndex((s) => s.waitsOn.every((w) => done.has(w) || !at.has(w)));
      if (i < 0) i = 0;
      const s = left.splice(i, 1)[0];
      done.add(s.id);
      const d = at.get(s.id);
      const task = live.tree.byId.get(s.id);
      if (d.start === null || d.due === null || started(task)) continue;
      const ends = s.waitsOn.map((w) => at.get(w)?.due).filter((x) => x !== null && x !== undefined);
      if (!ends.length || d.start > Math.max(...ends)) continue;
      const start = nextWorkingDay(Math.max(...ends) + 1);
      const due = addWorkingDays(start, Math.max(1, workingDaysBetween(d.start, d.due)) - 1);
      row.steps.push({ step: s.name, before: [isoDay(d.start), isoDay(d.due)], after: [isoDay(start), isoDay(due)] });
      at.set(s.id, { start, due });
      changes.push({ unit: u, step: task, owner: null, start, due });
    }
    const dl = steps.find((s) => s.name === 'Deliver');
    row.send_before = dl?.plannedStart != null ? isoDay(dl.plannedStart) : null;
    row.send_after = dl ? (at.get(dl.id).start === null ? null : isoDay(at.get(dl.id).start)) : null;
    row.late_after = row.due_date !== null && row.send_after !== null && row.send_after > row.due_date;
    if (row.steps.length) rows.push(row);
  }
  return { live: buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members), rows, changes };
}

// The re-plan of every In-progress job's open steps: each job's steps not yet started are planned again
// from today as the Planner plans new work (plan mode, 80%, every step the working day after the one it waits on),
// the jobs taken in the order they kicked off, each on the hours the ones before it left. Complete and started steps
// keep their dates; a step waiting on a started one starts no earlier than the working day after that step's card due
// date. Returns the cards as the re-plan would leave them, and per job the send before and after.
export function replanLive(live, env, terms) {
  const t0 = today(env);
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const started = (s) => !/^(to do|ready)$/i.test(String(s.status || '')) || (s.tracked || 0) > 0;
  const kickoff = (u) => Math.min(...live.tree.descendants(u.id).map((x) => dn(x.start) ?? dn(x.due) ?? Infinity));
  const jobs = live.tree.units.filter((u) => String(u.status || '').toLowerCase() === 'in progress')
    .sort((a, b) => kickoff(a) - kickoff(b) || (a.due ?? Infinity) - (b.due ?? Infinity) || a.id.localeCompare(b.id));
  const unstarted = new Map(jobs.map((u) => [u.id, openSteps(live.tree, u.id).filter((s) => !started(s))]));
  const all = [...unstarted.values()].flat();
  let booked = without(live.booked, bookings(all, env, live.members));
  let bookedBy = withoutBy(live.bookedBy, new Set(all.map((s) => s.id)));
  const changes = [];
  const rows = [];
  for (const u of jobs) {
    const mine = unstarted.get(u.id);
    const deliver = live.tree.kids(u.id).find((s) => s.name === 'Deliver' && !s.closed);
    const row = { card: u.name, id: u.id, due_date: u.due ? isoDay(dn(u.due)) : null, send_before: deliver?.start ? isoDay(dn(deliver.start)) : null, send_after: null, steps: [] };
    rows.push(row);
    if (!mine.length) { row.send_after = row.send_before; continue; }
    const ids = new Set(mine.map((s) => s.id));
    const steps = engineSteps(live.tree, u, live, env, recoveryFill(live.tree, u, env, terms)).filter((s) => ids.has(s.id)).map((s) => {
      const ends = s.waitsOn.filter((w) => !ids.has(w)).map((w) => dn(live.tree.byId.get(w)?.due)).filter((d) => d !== null);
      return ends.length ? { ...s, floor: nextWorkingDay(Math.max(...ends) + 1) } : s;
    });
    const r = schedule({ mode: 'plan', today: t0, capPct: 80, capacity: CAPACITY, booked, bookedBy, self: jobName(u), steps, promise: dn(u.due) });
    booked = plus(booked, r.placed);
    bookedBy = plusBy(bookedBy, r.placed_by);
    for (const p of r.plan) {
      changes.push({ unit: u, step: live.tree.byId.get(p.id), owner: null, start: p.start, due: p.due });
      row.steps.push({ step: p.step, owner: p.owner, before: [p.plannedStart, p.plannedDue].map((d) => (d === null ? null : isoDay(d))), after: [isoDay(p.start), isoDay(p.due)] });
    }
    row.send_after = r.send !== null ? isoDay(r.send) : row.send_before;
  }
  for (const row of rows) row.late_after = row.due_date !== null && row.send_after !== null && row.send_after > row.due_date;
  return { live: buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members), rows, changes };
}

// The send (the day the files go out) against the card's Due date, for a sentence.
function sendWords(w) {
  if (w.send === null) return w.lands === null ? 'there is no open step to place' : `the last step ends ${dayText(w.lands)}; there is no Deliver step`;
  if (w.promise === null) return `the files would go out ${dayText(w.send)}`;
  return `the files go out ${dayText(w.send)}, ${against(w.send_past_due, w.promise, 'the Due date')}`;
}

// The recovery re-walk's verdict in words: the send on hours from today against
// the card's Due date, the step that breaks, or the send brought back inside the Due date.
function verdictWords(w) {
  if (w.send === null) return w.lands === null ? 'the re-walk has no open step to place' : `on hours from today the last step ends ${dayText(w.lands)}; there is no Deliver step to send`;
  if (w.promise === null) return `on hours from today the files go out ${dayText(w.send)}; the card has no Due date to check`;
  if (w.send_past_due > 0) {
    return `on hours from today the files go out ${dayText(w.send)}, ${wd(w.send_past_due)} after the Due date of ${dayText(w.promise)}; ` +
      (w.first_break ? `${w.first_break.step} is the first step that breaks` : 'no step is behind its plan: the plan itself sends after the Due date');
  }
  const back = w.planned_send !== null && w.planned_send > w.promise;
  return `on hours from today the files go out ${dayText(w.send)}, ${w.send_past_due === 0 ? 'on the Due date' : `${wd(-w.send_past_due)} before the Due date of ${dayText(w.promise)}`}` +
    (back ? ': the recovery plan brings the send back inside the Due date' : '');
}
// Each remaining step's planned day against where the replay places it. "could sit earlier" when the
// replay is before the plan; "must move" when the plan starts on or before the day the step it waits on ends (on the
// card or in the replay, whichever is later), sits on a day over-full for its owner (booked past their day on the
// cards, Workload's view), or ends before the replay can finish it. Deliver is compared on its send (its start); the
// agency's window is never over-full for Makers' people. A step with no dates is left to the No dates check.
const SLACK_H = 0.25; // hours over a day's capacity that still count as fitting, as the engine's slack
// One capacity rule everywhere: the room a person has on a day is what the replay gives a step there,
// their whole day less the hours booked on the cards that day, and never more than is left of their week. A step fits
// its days when its owners have room for its hours there: a one-day step's on that day, any other step's across its
// days. Deliver's card start is the day its work starts (the files go out when its hours are done), so it fits a day on
// which its owner has any room. The Health check's "must move" and the fix's choice of day both read it, so a day a
// fix chooses is never called over-full by the next check.
function roomOn(booked, owners, day) {
  const mon = day - ((new Date(day * DAY_MS).getUTCDay() + 6) % 7);
  return owners.reduce((a, o) => {
    const cap = dailyCapacity(o);
    const used = (d) => booked.get(o)?.get(d) || 0;
    let week = 0;
    for (let x = mon; x < mon + 5; x++) if (isWorkingDay(x)) week += cap - used(x);
    return a + Math.max(0, Math.min(cap - used(day), week));
  }, 0);
}
function fitsDays(booked, owners, kind, start, due, hours) {
  if (kind === 'agency' || !owners.length || hours <= 0) return true; // the agency's window takes none of Makers' days
  if (kind === 'deliver') return roomOn(booked, owners, start) > 0; // Deliver's work starts on its day if there is room
  if (start === due) return roomOn(booked, owners, start) + SLACK_H >= hours;
  let room = 0;
  for (let d = start; d <= due; d++) if (isWorkingDay(d)) room += roomOn(booked, owners, d);
  return room + SLACK_H >= hours && roomOn(booked, owners, start) > 0;
}
// Where a step can sit, from day `from` on: the first day on which it fits its owners' room on the cards, keeping its
// working days (one capacity rule). Returns its days and the bookings with it on them. A Watch line, a warning's step
// line and a fix all name this day, so the plan they leave is one the next check reads as it stands.
export function seatOn(live, env, booked, unit, task, from) {
  const s0 = dayNumber(task.start ?? task.due, env);
  const d0 = dayNumber(task.due ?? task.start, env);
  const len = Math.max(1, workingDaysBetween(s0, d0));
  const owners = stepOwners(task, unit, live.members).owners;
  const kind = kindOf(task.name);
  const rest = without(booked, bookings([task], env, live.members));
  let start = nextWorkingDay(from);
  for (let guard = 0; guard < 120; guard++) {
    const due = addWorkingDays(start, len - 1);
    if (fitsDays(rest, owners, kind, start, due, task.estimate || 0)) {
      const moved = { ...task, start: start * DAY_MS + 12 * HOUR_MS, due: due * DAY_MS + 12 * HOUR_MS };
      return { start, due, booked: plus(rest, bookings([moved], env, live.members)) };
    }
    start = nextWorkingDay(start + 1);
  }
  const start0 = nextWorkingDay(from);
  return { start: start0, due: addWorkingDays(start0, len - 1), booked };
}

export function stepDaysOf(w, live, unit, env) {
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const span = (a, b) => (a === b ? dayText(a) : `${dayText(a)} through ${dayText(b)}`);
  const inPlan = new Map(w.plan.map((p) => [p.id, p]));
  const moved = new Map(); // step id -> the day it ends once it moves as named
  let booked = live.booked;
  return w.plan.map((p) => {
    const deliver = p.kind === 'deliver';
    const row = { step: p.step, id: p.id, owner: p.owner, planned_start: p.plannedStart === null ? null : isoDay(p.plannedStart),
      planned_due: p.plannedDue === null ? null : isoDay(p.plannedDue), replay_start: isoDay(p.start), replay_due: isoDay(p.due),
      move_start: null, move_due: null, flag: null, reason: null, line: null };
    if (p.plannedStart === null || p.plannedDue === null) return row;
    const task = live.tree.byId.get(p.id);
    // The step it waits on that ends last: where it moves to, else its card day or its replay, whichever is later.
    let pred = null;
    for (const id of task?.waitsOn || []) {
      const q = inPlan.get(id);
      const x = live.tree.byId.get(id);
      const end = moved.has(id) ? moved.get(id) : q ? Math.max(q.plannedDue ?? -Infinity, q.due) : x && !x.closed ? dn(x.due) : null;
      if (end !== null && end !== -Infinity && (!pred || end > pred.end)) pred = { name: q ? q.step : x.name, end };
    }
    const chain = pred !== null && p.plannedStart <= pred.end;
    const owners = task ? stepOwners(task, unit, live.members).owners : [];
    const rest = task ? without(booked, bookings([task], env, live.members)) : booked;
    const full = task && !fitsDays(rest, owners, p.kind, p.plannedStart, p.plannedDue, task.estimate || 0) ? p.plannedStart : null;
    const begins = deliver ? p.workStart : p.start; // Deliver: the day its work starts
    const later = deliver ? begins > p.plannedStart : p.start > p.plannedStart || p.due > p.plannedDue;
    const planned = deliver ? dayText(p.plannedStart) : span(p.plannedStart, p.plannedDue);
    if (task && (chain || full !== null || later)) {
      // The move named: the first day from the replay's on which the step fits, after the step before it ends.
      const from = Math.max(begins, chain ? nextWorkingDay(pred.end + 1) : begins);
      const seat = seatOn(live, env, booked, unit, task, from);
      if (seat.start !== p.plannedStart || seat.due !== p.plannedDue) {
        booked = seat.booked;
        moved.set(p.id, seat.due);
        row.move_start = isoDay(seat.start);
        row.move_due = isoDay(seat.due);
        row.flag = 'must move';
        row.reason = chain ? { kind: 'chain', after: pred.name } : full !== null ? { kind: 'full', day: isoDay(full), owner: bare(p.owner) } : { kind: 'room', owner: bare(p.owner) };
        const why = chain ? `it is planned before ${pred.name} ends` : full !== null ? `${bare(p.owner)} is over-full on ${dayText(full)}`
          : `${bare(p.owner)} has no room for it on its planned days`;
        row.line = `${p.step} must move from ${planned} to ${deliver ? dayText(seat.start) : span(seat.start, seat.due)}, ${why}.`;
        row._full = full;
        return row;
      }
    }
    if (begins < p.plannedStart) {
      row.flag = 'could sit earlier';
      row.line = `${p.step} could sit earlier, ${deliver ? dayText(begins) : span(p.start, p.due)} instead of ${planned}.`;
    }
    return row;
  });
}

// The Watch comment: a step must move while the send still lands by the Due date.
// The first line says why (an over-full day and the person, or a step planned before the step it waits on ends), then
// one line per step whose planned day and replay day differ, the move named. Null when no step must move (a step that
// could only sit earlier is quiet) or the send is past the Due date (then the Forecast check warns). Health is not
// changed.
function watchOf(w, days) {
  if (w.send === null || w.send_past_due === null || w.send_past_due > 0) return null;
  const must = days.filter((r) => r.flag === 'must move');
  if (!must.length) return null;
  const parts = [];
  const full = must.filter((r) => r.reason.kind === 'full');
  for (const o of [...new Set(full.map((r) => r.reason.owner))]) {
    const ds = [...new Set(full.filter((r) => r.reason.owner === o).map((r) => r._full))].sort((a, b) => a - b);
    parts.push(`${andList(ds.map(dayText))} ${ds.length === 1 ? 'is' : 'are'} over-full for ${o}`);
  }
  for (const r of must.filter((x) => x.reason.kind === 'room')) parts.push(`${r.reason.owner} has no room for ${r.step} on its planned days`);
  for (const r of must.filter((x) => x.reason.kind === 'chain')) parts.push(`${r.step} is planned before ${r.reason.after} ends`);
  const lead = andList(parts);
  const listed = days.filter((r) => r.line);
  return {
    overfull: full.map((r) => ({ day: r.reason.day, owner: r.reason.owner, step: r.step })),
    steps: listed.map(({ _full, ...r }) => r),
    comment: [`${lead.charAt(0).toUpperCase()}${lead.slice(1)}.`, ...listed.map((r, i) => `${i + 1}. ${r.line}`), 'No date at risk.',
      'Tidy this in Workload so new work is planned against real days.'].join('\n'),
  };
}
const wd = (n) => `${n} working day${n === 1 ? '' : 's'}`;
const andList =(xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// Health from the checks' levels (the Delivery Planner's Health check Skill): Off track if any check says Off track,
// At risk if any says At risk, otherwise On track. A check not checked or not scored does not count.
const worst = (checks) => {
  const lv = Math.max(...checks.map((c) => (c.level === 'At risk' ? 1 : c.level === 'Off track' ? 2 : 0)));
  return ['On track', 'At risk', 'Off track'][lv];
};
const NO_OWNER_DAYS = 2; // [2 working days]
const HEADROOM_RISK = 0.1; // [10%] of Budget

// Retainer hours for a month card, read once per client and month in a call.
async function usageFor(ctx, env, tree, client, month) {
  const key = `${client.id}:${month}`;
  if (!ctx.retainer.has(key)) ctx.retainer.set(key, ctx.entries().then((entries) => retainerFigures(env, tree, client, month, entries)));
  return ctx.retainer.get(key);
}

// One project's Health check, every check read from the card, its open steps and the re-walk. Exported for its
// tests (test/health.test.mjs).
export async function healthOf(unit, tree, live, env, ctx) {
  const approved = notStarted(unit);
  const t0 = today(env);
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const iso = (d) => (d === null || d === undefined ? null : isoDay(d));
  const steps = openSteps(tree, unit.id);
  const w = rewalk(live, unit, env, { terms: ctx.terms });
  ctx.walks?.set(unit.id, w);
  const walked = new Map(w.plan.map((p) => [p.id, p]));
  const stepDays = stepDaysOf(w, live, unit, env);
  // Each open step on the card and in the re-walk: overdue (its due date passed, not Complete) or unstarted on its
  // due day (due today, not In progress, nothing tracked).
  const rows = [...steps].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)).map((s) => {
    const { label } = stepOwners(s, unit, live.members);
    const start = dn(s.start);
    const due = dn(s.due);
    const p = walked.get(s.id);
    return { step: s.name, id: s.id, owner: label, team_only: !s.people.length && s.teams.length > 0, status: s.status,
      estimate: round1(s.estimate), tracked: round1(s.tracked), start: iso(start), due: iso(due), _start: start, _due: due,
      overdue: due !== null && due < t0, overdue_working_days: due !== null && due < t0 ? workingDaysBetween(due + 1, t0) : 0,
      unstarted_on_due_day: due === t0 && !/progress/i.test(s.status) && !s.tracked,
      rewalk_start: p ? iso(p.start) : null, rewalk_due: p ? iso(p.due) : null, held_by_the_chain: p ? p.heldByChain : false };
  });
  const kids = tree.kids(unit.id);
  const deliver = kids.find((s) => s.name === 'Deliver');
  const promise = dn(unit.due);
  const deliverDue = dn(deliver?.due);
  const plannedSend = deliver && !deliver.closed ? dn(deliver.start) : null; // the send on the card: Deliver's start
  const bufferGone = plannedSend !== null && promise !== null && plannedSend > promise;
  const status = String(unit.status || '').toLowerCase();
  const isDelivered = status === 'delivered';
  const checks = [];
  const add = (check, level, detail) => checks.push({ check, level, detail });

  // Buffer: the planned send against the card's Due date; slips eat the two days of buffer first.
  if (promise === null) add('Buffer', 'not checked', 'the card has no Due date');
  else if (plannedSend === null) add('Buffer', 'not checked', deliver?.closed ? 'the Deliver step is Complete' : 'the Deliver step has no start date (the planned send)');
  else if (!bufferGone) {
    const left = workingDaysBetween(plannedSend + 1, promise);
    add('Buffer', 'clear', `the planned send, ${dayText(plannedSend)}, is ${left ? `${wd(left)} inside the Due date of ${dayText(promise)}` : `on the Due date of ${dayText(promise)}, no buffer left`}`);
  } else add('Buffer', 'At risk', `the planned send, ${dayText(plannedSend)}, is ${wd(workingDaysBetween(promise + 1, plannedSend))} past the Due date of ${dayText(promise)}: the buffer is gone`);

  // Forecast: the job's remaining steps played forward on each person's real free
  // hours, day by day; a forecast send after the Due date is At risk, with no date moved and nothing overdue.
  if (promise === null) add('Forecast', 'not checked', 'the card has no Due date');
  else if (w.send === null) add('Forecast', 'not checked', 'no open Deliver step to send');
  else if (w.send_past_due > 0) {
    const b = w.first_break;
    add('Forecast', 'At risk', `the forecast send, ${dayText(w.send)}, is ${wd(w.send_past_due)} after the Due date of ${dayText(promise)}` +
      (b ? `; ${b.step} (${bare(b.owner)}) is the first step that breaks` : ''));
  } else add('Forecast', 'clear', `the forecast send, ${dayText(w.send)}, is ${w.send_past_due === 0 ? `on the Due date of ${dayText(promise)}` : `${wd(-w.send_past_due)} inside the Due date of ${dayText(promise)}`}`);

  // No owner: still on its Team with no person, starting within two working days or already started.
  const unowned = rows.filter((r) => r.team_only && r._start !== null && (r._start <= t0 || workingDaysBetween(t0 + 1, r._start) <= NO_OWNER_DAYS));
  add('No owner', unowned.length ? 'At risk' : 'clear', unowned.length
    ? unowned.map((r) => `${r.step} is still on ${r.owner.replace(/ \(.*\)$/, '')} with no person, starting ${dayText(r._start)}`).join('; ')
    : 'every step starting within two working days has a person');

  // No dates.
  const undated = rows.filter((r) => r._start === null || r._due === null);
  add('No dates', undated.length && status === 'in progress' ? 'At risk' : 'clear', undated.length
    ? `${andList(undated.map((r) => r.step))} ${undated.length === 1 ? 'has' : 'have'} no ${undated.every((r) => r._start === null && r._due === null) ? 'start or due' : undated.every((r) => r._due === null) ? 'due' : 'start'} date`
    : 'every open step has a start and a due date');

  // Overdue step and the recovery re-walk: a step overdue, or unstarted on its due
  // day, runs the recovery re-walk; while the send still fits by the Due date with the buffer intact it is only
  // noted in the reason; once the buffer is gone it scores as the Buffer check does. The re-walk also runs when the
  // buffer is gone on the card. The send fits by the Due date: At risk, with the recovery plan for the delivery lead
  // to adopt by hand; it does not: Off track.
  const overdue = rows.filter((r) => r.overdue || r.unstarted_on_due_day);
  const overdueWords = (r) => r.overdue ? `${r.step} (${bare(r.owner)}) was due ${dayText(r._due)} and is not Complete` : `${r.step} (${bare(r.owner)}) is due today and has not started`;
  const sendFits = promise !== null && w.send_past_due !== null && w.send_past_due <= 0;
  if (!overdue.length) add('Overdue step', 'clear', 'no step is past its due date or unstarted on its due day');
  else if (promise === null) add('Overdue step', 'not checked', `${overdue.map(overdueWords).join('; ')}; the card has no Due date to re-walk against`);
  else if (sendFits && !bufferGone) add('Overdue step', 'note', `${overdue.map(overdueWords).join('; ')}: on hours the files still go out ${dayText(w.send)}, inside the buffer (noted, not scored)`);
  else add('Overdue step', 'At risk', `${overdue.map(overdueWords).join('; ')}: the buffer is gone`);

  const triggers = [...(bufferGone ? ['the buffer is gone'] : []),
    ...(overdue.length ? [`${andList(overdue.map((r) => r.step))} ${overdue.some((r) => r.overdue) ? (overdue.length === 1 ? 'is overdue' : 'are overdue or unstarted on their due day') : (overdue.length === 1 ? 'is unstarted on its due day' : 'are unstarted on their due day')}`] : [])];
  if (!triggers.length) add('Recovery re-walk', 'clear', `not needed (${verdictWords(w)})`);
  else if (promise === null) add('Recovery re-walk', 'not checked', `${andList(triggers)}; the card has no Due date to re-walk against`);
  else if (!sendFits) add('Recovery re-walk', 'Off track', `${andList(triggers)}: ${verdictWords(w)}`);
  else if (!bufferGone) add('Recovery re-walk', 'note', `${andList(triggers)}: ${verdictWords(w)}, so the buffer holds (noted, not scored)`);
  else add('Recovery re-walk', 'At risk', `${andList(triggers)}: ${verdictWords(w)}; the recovery plan is for the delivery lead to adopt by hand`);

  // Cost: a fixed-fee card; a retainer piece's money is on its month card.
  const agreement = unit.f['Agreement type'] || null;
  let money = null;
  if (agreement === 'Fixed fee') {
    money = { kind: 'fixed fee', ...forecastOf(tree, unit) };
    if (money.budget === null) add('Cost', 'not checked', 'no Budget on the card');
    else {
      const c = costCheck(money);
      add('Cost', c.level, c.detail);
    }
  } else if (agreement === 'Retainer') {
    const parent = unit.parent ? tree.byId.get(unit.parent) : null;
    const monthCard = parent && isMonth(parent) ? parent : null;
    money = { kind: 'retainer piece', month_card: monthCard ? { id: monthCard.id, name: monthCard.name, ...forecastOf(tree, monthCard) } : null };
    add('Cost', 'not scored', `a retainer piece: its money is on its month card${monthCard ? `, ${monthCard.name}` : ''}`);
  } else add('Cost', 'not checked', 'no Agreement type on the card');

  // Rounds used and the client's sign-off wait are not Health: Health is At risk or Off track only when
  // the send would miss the Due date, a step has no owner, no dates or is overdue, or headroom is under 10% of Budget.
  // The rounds stay in the reading as figures.
  const used = num(unit.f['Rounds used']);
  const included = num(unit.f['Rounds included']);

  // Overdue: past the card's Due date and not Delivered or Complete; the step holding it.
  const daysRemaining = promise === null ? null : promise - t0;
  const holding = overdue[0] || (w.plan[0] ? rows.find((r) => r.id === w.plan[0].id) : null);
  if (daysRemaining === null) add('Overdue', 'not checked', 'the card has no Due date');
  else add('Overdue', daysRemaining < 0 && !isDelivered && !unit.closed ? 'Off track' : 'clear', daysRemaining < 0 && !isDelivered && !unit.closed
    ? `${-daysRemaining} day${daysRemaining === -1 ? '' : 's'} past the Due date of ${dayText(promise)}${holding ? `; ${holding.step} (${bare(holding.owner)}) holds it` : ''}`
    : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining`);

  // Notes, not scored.
  const notes = checks.filter((c) => c.level === 'note').map((c) => `${c.check}: ${c.detail}`);
  const reworkLabels = Array.isArray(unit.f.Rework) ? unit.f.Rework : [];
  if (reworkLabels.length) notes.push(`Rework set: ${reworkLabels.join(', ')}`);
  const committed = num(unit.f['Original committed date']);
  if (committed && promise !== null && promise > dayNumber(committed, env)) notes.push(`the Due date has moved from the Original committed date of ${dayText(dayNumber(committed, env))} to ${dayText(promise)}`);

  // An approved job at To do is read for the forecast only: the Buffer and the Forecast.
  if (approved) checks.splice(0, checks.length, ...checks.filter((c) => c.check === 'Buffer' || c.check === 'Forecast'));
  const tripped = checks.filter((c) => c.level === 'At risk' || c.level === 'Off track');
  return {
    card: unit.name, id: unit.id, status: unit.status, client: clientName(unit), agreement, forecast_only: approved,
    ...(() => { const up = unit.parent ? tree.byId.get(unit.parent) : null; return up && isMonth(up) ? { kind: 'retainer piece', month_card: up.name } : { kind: 'project' }; })(),
    delivery_lead: Array.isArray(unit.f['Delivery lead']) ? unit.f['Delivery lead'].map((x) => x.name).filter(Boolean)[0] ?? null : null,
    health_by_the_checks: worst(checks), tripped: tripped.map((c) => c.check), checks, notes, watch: watchOf(w, stepDays),
    // Each remaining step's planned day against the replay's, and the lines for the comment.
    step_days: stepDays.map(({ _full, ...r }) => r), step_lines: stepDays.filter((r) => r.line).map((r) => r.line),
    due_date: iso(promise), original_committed_date: committed ? iso(dayNumber(committed, env)) : null,
    planned_send: iso(plannedSend), buffer_gone: promise === null || plannedSend === null ? null : bufferGone,
    buffer_working_days: promise === null || plannedSend === null ? null : bufferGone ? -workingDaysBetween(promise + 1, plannedSend) : workingDaysBetween(plannedSend + 1, promise),
    deliver_due: iso(deliverDue), days_remaining: daysRemaining,
    rewalk: { triggered: triggers.length > 0, triggers, ...(({ steps: _s, ...v }) => v)(shape(w)), verdict: verdictWords(w),
      // The recovery plan, when a trigger fired: each remaining step's dates and owner, for the delivery lead to adopt.
      recovery_plan: triggers.length ? w.plan.map((p) => ({ step: p.step, owner: p.owner, hours: p.hours, start: iso(p.start), due: iso(p.due), planned_start: iso(p.plannedStart), planned_due: iso(p.plannedDue) })) : null },
    steps: rows.map(({ _start, _due, owners, agency, ...r }) => r),
    rounds_used: used, rounds_included: included, rework: reworkLabels, money,
    _walk: w,
  };
}

// A retainer month card: the Cost check (Headroom), with its hours against the allowance (the month card basis).
// What every Health reading reads: the cards, the Client cards, the supplier's terms, time entries when asked.
async function healthContext(env) {
  const [live, clients, terms] = await Promise.all([liveWork(env), allTasks(env, LISTS.clients, false), supplierTerms(env)]);
  let entries = null;
  const ctx = { clientsById: new Map(clients.map((c) => [c.id, c])), retainer: new Map(), terms, walks: live.walks,
    entries: () => (entries ??= timeEntries(env, ...ALL_TIME())) };
  return { live, ctx };
}

// Health by the checks for each named job, read as Forecast delivery reads it (Set health reads it again before it
// writes). A project or retainer piece by its checks; a retainer month card for its money.
export async function healthReadings(env, refs) {
  const { live, ctx } = await healthContext(env);
  const out = [];
  for (const ref of refs) {
    const unit = findProject(live.tree, ref);
    const h = isMonth(unit) ? await monthHealthOf(unit, live.tree, env, ctx) : await healthOf(unit, live.tree, live, env, ctx);
    const first = (h.checks || []).find((c) => (h.tripped || []).includes(c.check));
    out.push({ ref, id: unit.id, card: unit.name, health: h.health_by_the_checks,
      reason: first ? `${first.check}: ${first.detail || first.level}` : 'All checks clear' });
  }
  return out;
}

async function monthHealthOf(m, tree, env, ctx) {
  const money = forecastOf(tree, m);
  const ref = (m.f.Client || [])[0];
  const client = ref ? ctx.clientsById.get(ref.id) : null;
  const month = m.due ? monthOf(m.due, env) : null;
  const allowance = client ? num(client.f.Allowance) : null;
  const usage = client && allowance && month ? await usageFor(ctx, env, tree, client, month) : null;
  const pieces = tree.kids(m.id).filter((k) => !isTest(k));
  const hoursWords = usage ? `; ${fmt(usage.hours)} of ${fmt(allowance)} allowance hours logged, ${fmt(usage.planned)} h still planned` : '; the allowance in hours could not be read from the Client card';
  let check;
  if (money.budget === null) check = { check: 'Cost', level: 'not checked', detail: 'no Budget on the month card' };
  else {
    const c = costCheck(money);
    check = { check: 'Cost', level: c.level, detail: `${c.detail}${hoursWords}` };
  }
  return {
    card: m.name, id: m.id, status: m.status, client: clientName(m), agreement: 'Retainer month', kind: 'month card',
    health_by_the_checks: worst([check]), tripped: check.level === 'At risk' || check.level === 'Off track' ? ['Cost'] : [], checks: [check],
    money: { kind: 'month card', price: num(m.f.Price), ...money, allowance_hours: allowance, hours_logged: usage ? round1(usage.hours) : null,
      planned_open_hours: usage ? round1(usage.planned) : null },
    pieces: pieces.map((p) => ({ card: p.name, id: p.id, status: p.status })),
  };
}

const moneyText = (x) => money(x ?? 0);
// The reshuffle as a record: the jobs at risk or moved by it, each with the steps that go first or move.
function brief({ ids, head, order, suggestion, short, fix_moves: _f, ...r }) {
  return { ...r, jobs: order.filter((o) => o.at_risk || !o.sends_by_due_date || o.steps.some((x) => x.working_days_later > 0))
    .map((o) => ({ ...o, steps: o.at_risk ? o.steps : o.steps.filter((x) => x.working_days_later > 0) })) };
}
// The reshuffle for a set of jobs, worked out once per shared data load.
function reshuffleOf(live, env, ctx, units) {
  const key = units.map((u) => u.id).sort().join(',');
  if (!live.reshuffles.has(key)) live.reshuffles.set(key, leastSlackFirst(live, env, ctx, units));
  return live.reshuffles.get(key);
}
// One job's suggestion: a job the reshuffle saves, or that moves for it, reads the reshuffle; a late job left out
// reads its own fallback only.
function suggestionFor(r, id) {
  if (r.short[id]) return r.short[id];
  const f = r.fallback.find((x) => x.id === id);
  if (!f) return r.head;
  return f.to ? `No reshuffle saves ${f.name}; ${f.words}` : `No reshuffle saves ${f.name}; the Delivery lead decides`;
}
// The fix a job's comment can list, stored under its Fix ref for Apply fix: for a late job the reshuffle
// saves, the reshuffle's drags; for a job with a Watch comment, the Watch comment's moves. Null when there is neither.
export async function fixOf(env, live, reshuffle, h, unit) {
  const day = (ms) => isoDay(dayNumber(ms, env));
  let source = null;
  let moves = [];
  if (reshuffle?.short?.[unit.id] && reshuffle.fix_moves.length) {
    source = 'least slack first';
    moves = reshuffle.fix_moves;
  } else if (h.watch) {
    source = 'watch';
    moves = h.step_days.filter((r) => r.flag === 'must move' && r.move_start).map((r) => moveOf(unit, live.tree.byId.get(r.id), r.move_start, r.move_due, day));
  }
  if (!moves.length) return null;
  return { ...(await proposeFix(env, { project: unit, source, moves })), source, moves };
}
// The tested change as a fix Apply fix can write: every change a new start or due date with no new owner,
// each step once.
async function testedFixOf(env, unit, changes) {
  const source = 'test a fix';
  if (changes.some((c) => c.owner)) return { ref: null, why: 'a new owner is not a step move, and Apply fix writes step dates only', source, moves: [] };
  if (new Set(changes.map((c) => c.step.id)).size !== changes.length) return { ref: null, why: 'the same step is changed more than once', source, moves: [] };
  const day = (ms) => isoDay(dayNumber(ms, env));
  const moves = changes.map((c) => moveOf(c.unit, c.step, isoDay(c.movedStart), isoDay(c.movedDue), day));
  return { ...(await proposeFix(env, { project: unit, source, moves })), source, moves };
}
// The Fix ref line in the text an agent reads.
function fixLines(fix) {
  if (!fix) return [];
  if (!fix.ref) return [`No Fix ref: ${fix.why}.`];
  const n = `${fix.moves.length} step move${fix.moves.length === 1 ? '' : 's'}`;
  const what = { watch: `the Watch comment's ${n}`, 'test a fix': `the tested change, ${n}`, 'least slack first': `the reshuffle's ${n}` }[fix.source];
  return [`Fix ref: ${fix.ref}, for ${what}: ` +
    `${fix.moves.map((m) => `${m.card}'s ${m.step} from ${m.from ?? 'no date'} to ${m.to}${m.to_due !== m.to ? `, ending ${m.to_due}` : ''}`).join('; ')}. ` +
    'Apply fix writes exactly these moves, and only after the delivery lead or a workspace owner replies "apply" to the Delivery Planner\'s comment that carries this Fix ref.'];
}
// The sweep's words for least slack first and its fallback.
function fallbackWords(r) {
  const n = r.saved.length + r.not_saved.length;
  const gave = r.fallback.filter((f) => f.to);
  const none = r.fallback.filter((f) => !f.to);
  const parts = [];
  if (r.saved.length) parts.push(r.not_saved.length ? `least slack first saves ${r.saved.length} of the ${n} late jobs` : 'least slack first lets every late job send by its Due date');
  if (gave.length) parts.push(`${gave.length} more ${gave.length === 1 ? 'goes' : 'go'} to someone else on ${gave.length === 1 ? 'its' : 'their'} Team`);
  if (none.length) parts.push(`no reshuffle saves ${andList(none.map((f) => f.name))}: the Delivery lead decides`);
  return parts.join('; ');
}
// Bookings added together: person -> day -> hours, and the same by step.
function plus(a, b) {
  const out = new Map([...a].map(([o, m]) => [o, new Map(m)]));
  for (const [o, m] of b) { const t = out.get(o) || new Map(); for (const [d, h] of m) t.set(d, (t.get(d) || 0) + h); out.set(o, t); }
  return out;
}
function minus(a, b) {
  const out = new Map([...a].map(([o, m]) => [o, new Map(m)]));
  for (const [o, m] of b) { const t = out.get(o); if (t) for (const [d, h] of m) t.set(d, Math.max(0, (t.get(d) || 0) - h)); }
  return out;
}
function plusBy(a, b) {
  const out = new Map([...a].map(([o, m]) => [o, new Map(m)]));
  for (const [o, m] of b) { const t = out.get(o) || new Map(); for (const [d, xs] of m) t.set(d, [...(t.get(d) || []), ...xs]); out.set(o, t); }
  return out;
}
const jobName = (u) => (clientName(u) === '(no client)' ? u.name : clientName(u));
// Names for a list of jobs: the client, or the card where the client has two jobs in the list.
const jobNames = (us) => { const n = us.map(jobName); return us.map((u, i) => (n.indexOf(n[i]) !== n.lastIndexOf(n[i]) ? u.name : n[i])); };
const span = (from, to) => (from === to ? `on ${dayText(from)}` : `from ${dayText(from)} to ${dayText(to)}`);
const dates = (a, b) => (a === b ? dayText(a) : `${dayText(a)} to ${dayText(b)}`);

// Least slack first. Where jobs whose forecast send is past their Due date share an owner's days with other live jobs,
// those jobs are played forward together on the owners' real free hours, the job with the least slack (forecast send
// closest to, or past, its Due date) placed first and jobs with slack after them; no step starts before its planned
// start, so work moves on the same days or later, never earlier. The reshuffle is partial: the late jobs are taken one
// at a time, least slack first, and each is kept in it only if it then sends by its Due date, every job kept before
// it still does, and no job that was on time goes late; so one job can never cancel the fix for the others. In each
// play the jobs being saved go first, the on-time jobs next, and the other late jobs last. A late job left out: the
// fallback gives its step that breaks to someone else on the step's Team (one job after another, so no two take the
// same hours); when nothing works, no reshuffle saves it and the Delivery lead decides.
export function leastSlackFirst(live, env, ctx, units) {
  // The fix seats each step it moves the way the Health check names a move (seatOn, one capacity rule).
  const seatStep = (booked, unit, task, from) => seatOn(live, env, booked, unit, task, from);

  const walkOf = (u) => {
    if (!ctx.walks.has(u.id)) ctx.walks.set(u.id, rewalk(live, u, env, { terms: ctx.terms }));
    return ctx.walks.get(u.id);
  };
  const liveOwners = (u, stepId) => {
    const st = live.tree.byId.get(stepId);
    return st ? stepOwners(st, u, live.members).owners : [];
  };
  const liveById = new Map(units.map((u) => [u.id, u]));
  const late = units.filter((u) => walkOf(u).promise !== null && walkOf(u).send_past_due > 0)
    .sort((a, b) => walkOf(b).send_past_due - walkOf(a).send_past_due || (a.due ?? Infinity) - (b.due ?? Infinity) || a.id.localeCompare(b.id));
  if (!late.length) return null;
  const lateIds = new Set(late.map((u) => u.id));

  // The late jobs, the on-time jobs whose booked hours share the days the late jobs' steps waited or ran over, and
  // those owners and days.
  const clashOf = (chosen) => {
    const jobs = new Map(chosen.map((u) => [u.id, u]));
    const owners = new Set();
    let from = Infinity; let to = -Infinity;
    for (const u of chosen) {
      const w = walkOf(u);
      const own = new Set(w.plan.map((p) => p.id));
      for (const p of w.plan.filter((x) => x.clash && x.clash.to >= x.clash.from)) {
        p.clash.owners.forEach((o) => owners.add(o));
        from = Math.min(from, p.clash.from); to = Math.max(to, p.clash.to);
        for (const o of p.clash.owners) for (let d = p.clash.from; d <= p.clash.to; d++) {
          for (const b of live.bookedBy.get(o)?.get(d) || []) {
            const other = own.has(b.id) ? null : live.unitOfStep.get(b.id);
            if (other && liveById.has(other.id)) jobs.set(other.id, other);
          }
        }
      }
    }
    return { jobs: [...jobs.values()], owners, from, to };
  };
  // Least slack first over a set of jobs, worked out afresh after each is placed: every job not yet placed is played
  // forward on what is left, and the one whose send then lands closest to, or furthest past, its Due date goes next.
  const all = clashOf(late);
  const play = (chosen) => {
    const { jobs, owners, from, to } = all;
    const saving = new Set(chosen.map((u) => u.id));
    const tier = (u) => (saving.has(u.id) ? 0 : lateIds.has(u.id) ? 2 : 1); // saved first, on time next, other late last
    const theirSteps = jobs.flatMap((u) => openSteps(live.tree, u.id));
    let shared = without(live.booked, bookings(theirSteps, env, live.members));
    let sharedBy = withoutBy(live.bookedBy, new Set(theirSteps.map((x) => x.id)));
    const rows = [];
    const left = [...jobs];
    while (left.length) {
      const tries = left.map((u) => ({ u, r: schedule({ ...recoveryInput(live, u, env, { terms: ctx.terms }), booked: shared, bookedBy: sharedBy, self: jobName(u), keepStarts: true }) }));
      const lack = (t) => (t.r.promise === null || t.r.send_past_due === null ? -99 : t.r.send_past_due); // larger: less slack
      tries.sort((a, b) => tier(a.u) - tier(b.u) || lack(b) - lack(a) || (a.u.due ?? Infinity) - (b.u.due ?? Infinity) || a.u.id.localeCompare(b.u.id));
      const { u, r } = tries[0];
      left.splice(left.indexOf(u), 1);
      shared = plus(shared, r.placed);
      sharedBy = plusBy(sharedBy, r.placed_by);
      const before = walkOf(u);
      const clashed = new Set(before.plan.filter((p) => p.clash).map((p) => p.id));
      const moves = r.plan.filter((p) => p.kind !== 'agency' && liveOwners(u, p.id).some((o) => owners.has(o))
        && (lateIds.has(u.id) ? clashed.has(p.id) : true)).map((p) => ({
        id: p.id, step: p.step, start: p.start, due: p.due, plannedStart: p.plannedStart, plannedDue: p.plannedDue,
        later: p.plannedDue === null || p.due <= p.plannedDue ? 0 : workingDaysBetween(p.plannedDue + 1, p.due) }));
      rows.push({ unit: u, name: jobName(u), atRisk: lateIds.has(u.id), saved: saving.has(u.id), before, after: r, moves,
        fits: r.promise === null || (r.send_past_due !== null && r.send_past_due <= 0) });
    }
    return { rows, shared, sharedBy, owners, from, to };
  };
  // The reshuffle as drags a person can make: each step a job with slack moves later in the play is dragged from its
  // planned start by the working days it moved. Nothing else moves with it (Reschedule Dependencies is off). The drags are tested with Test a fix's calculation, the forecast run on the cards as the drags leave them:
  // every job being saved sends by its Due date and no job on time goes late. Tried as found, then each drag a working
  // day further.
  const onTime = (w) => w.promise === null || (w.send_past_due !== null && w.send_past_due <= 0);
  const dragsFor = (tried, saving) => {
    const savingIds = new Set(saving.map((u) => u.id));
    const firsts = tried.rows.filter((x) => !savingIds.has(x.unit.id)).map((x) => ({ x, m: x.moves.find((y) => y.later > 0) })).filter((y) => y.m && y.m.plannedStart !== null);
    if (!firsts.length) return null;
    // Each move goes to the first day, from the day the play found, on which the step fits its owners' whole days on
    // the cards (one capacity rule), keeping its working days; the steps that wait on it, and on those,
    // follow to the working day after the step before them ends, each seated the same way. Nothing else moves.
    const main = (extra) => {
      let booked = live.booked;
      const out = [];
      for (const { x, m } of firsts) {
        const ends = new Map(); // step id -> its due day once moved
        const first = seatStep(booked, x.unit, live.tree.byId.get(m.id), shiftBy(m.plannedStart, m.later + extra));
        booked = first.booked;
        ends.set(m.id, first.due);
        out.push({ unit: x.unit, step: live.tree.byId.get(m.id), owner: null, start: first.start, due: first.due, from: m.plannedStart, fromDue: m.plannedDue, follows: null });
        for (const s of engineSteps(live.tree, x.unit, live, env)) {
          const task = live.tree.byId.get(s.id);
          if (ends.has(s.id) || started(task) || !task.start || !task.due) continue;
          const after = s.waitsOn.filter((w) => ends.has(w)).map((w) => ends.get(w));
          if (!after.length) continue;
          const from = dayNumber(task.start, env);
          if (from > Math.max(...after)) continue;
          const seat = seatStep(booked, x.unit, task, nextWorkingDay(Math.max(...after) + 1));
          booked = seat.booked;
          ends.set(s.id, seat.due);
          out.push({ unit: x.unit, step: task, owner: null, start: seat.start, due: seat.due, from, fromDue: dayNumber(task.due, env), follows: m.step });
        }
      }
      return out;
    };
    for (const attempt of [main(0), main(1)]) {
      const changes = attempt.map((c) => ({ ...c }));
      const world = buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members);
      const results = units.map((u) => ({ u, before: walkOf(u), after: rewalk(world, world.tree.byId.get(u.id), env, { terms: ctx.terms }) }));
      const saves = saving.every((u) => onTime(results.find((r) => r.u.id === u.id).after));
      const harms = results.some((r) => onTime(r.before) && !onTime(r.after));
      if (!saves || harms) continue;
      // The full set: the saved jobs' own steps that the forecast places later than their card days move
      // to those days too, so the plan the moves leave is the one the next check reads, and it comes back quiet.
      const own = [];
      for (const u of saving) {
        for (const p of results.find((r) => r.u.id === u.id).after.plan) {
          if (p.plannedStart === null || p.plannedDue === null || p.kind === 'agency') continue;
          const begins = p.kind === 'deliver' ? p.workStart : p.start;
          if (!(p.kind === 'deliver' ? begins > p.plannedStart : p.start > p.plannedStart || p.due > p.plannedDue)) continue;
          const seat = seatStep(world.booked, u, live.tree.byId.get(p.id), begins);
          own.push({ unit: u, step: live.tree.byId.get(p.id), owner: null, start: seat.start, due: seat.due, from: p.plannedStart, fromDue: p.plannedDue, follows: null, own: true });
        }
      }
      if (!own.length) return { changes, sends: new Map(results.map((r) => [r.u.id, r.after])), checked: results.length };
      const all = [...changes, ...own].map((c) => ({ ...c }));
      const world2 = buildLive(env, changedTree(live.tree, all, env), live.intakeTree, live.members);
      const results2 = units.map((u) => ({ u, before: walkOf(u), after: rewalk(world2, world2.tree.byId.get(u.id), env, { terms: ctx.terms }) }));
      if (saving.every((u) => onTime(results2.find((r) => r.u.id === u.id).after)) && !results2.some((r) => onTime(r.before) && !onTime(r.after))) {
        return { changes: all, sends: new Map(results2.map((r) => [r.u.id, r.after])), checked: results2.length };
      }
      return { changes, sends: new Map(results.map((r) => [r.u.id, r.after])), checked: results.length };
    }
    return null;
  };
  // The partial reshuffle: each late job, least slack first, kept only if every job in the play then sends in time and
  // its drags test well on the cards.
  const kept = [];
  let best = null;
  let drags = null;
  for (const u of late) {
    const tried = play([...kept, u]);
    if (!tried.rows.every((x) => (x.atRisk && !x.saved) || x.fits)) continue;
    const d = dragsFor(tried, [...kept, u]);
    if (!d) continue;
    kept.push(u); best = tried; drags = d;
  }
  const left = late.filter((u) => !kept.includes(u));
  const rows = best ? best.rows : [];
  let shared = best ? best.shared : live.booked;
  let sharedBy = best ? best.sharedBy : live.bookedBy;
  const owners = all.owners;
  const names = new Map([...rows.map((x) => [x.unit.id, x.unit]), ...left.map((u) => [u.id, u])]);
  const nameList = jobNames([...names.values()]);
  const nameOf = new Map([...names.keys()].map((id, i) => [id, nameList[i]]));
  for (const x of rows) x.name = nameOf.get(x.unit.id);
  const who = andList([...owners]);
  // The fallback for a late job left out: its step that breaks to someone else on the step's Team, on the bookings
  // the reshuffle and the fallbacks before it left.
  const fallback = left.map((u) => {
    const before = walkOf(u);
    const name = nameOf.get(u.id);
    const b = before.first_break || before.plan.find((p) => p.clash);
    const task = b ? live.tree.byId.get(b.id) : null;
    const team = task ? teamOf(task) : null;
    const stepOwnersNow = b ? liveOwners(u, b.id) : [];
    const teammates = team ? (live.members.get(team) || []).filter((p) => !stepOwnersNow.includes(p) && (CAPACITY[p] ?? 0) > 0) : [];
    const own = openSteps(live.tree, u.id);
    const inPlay = rows.find((x) => x.unit.id === u.id);
    const booked = inPlay ? minus(shared, inPlay.after.placed) : without(shared, bookings(own, env, live.members));
    const bookedBy = withoutBy(sharedBy, new Set(own.map((t) => t.id)));
    const found = teammates.map((p) => ({ person: p, w: schedule({ ...recoveryInput(live, u, env, { terms: ctx.terms }), booked, bookedBy, self: jobName(u), whatIf: { step: b.step, owner: p, start: null } }) }))
      .filter((t) => t.w.send !== null && t.w.send_past_due !== null && t.w.send_past_due <= 0)
      .sort((a, c) => a.w.send - c.w.send || a.person.localeCompare(c.person))[0];
    if (found) { shared = plus(booked, found.w.placed); sharedBy = plusBy(bookedBy, found.w.placed_by); }
    return { card: u.name, id: u.id, name, step: b ? b.step : null, team, to: found ? found.person : null, send: found ? isoDay(found.w.send) : null,
      words: found ? `give ${name}'s ${b.step} to ${found.person} on the ${team} Team: the files go out ${dayText(found.w.send)}, ${against(found.w.send_past_due, found.w.promise, 'its Due date')}`
        : `no reshuffle saves ${name}; the Delivery lead decides` };
  });
  const first = rows.filter((x) => x.saved);
  const dragged = (drags?.changes || []).map((c) => ({ card: c.unit.name, unit: c.unit, name: nameOf.get(c.unit.id) ?? jobName(c.unit), step: c.step.name, stepId: c.step.id,
    from: c.from, fromDue: c.fromDue ?? null, to: c.start, toDue: c.due ?? null, follows: c.follows ?? null, own: !!c.own }));
  // Each move with the steps that follow it, in one sentence: "Move Client K's Package files from Fri, Mar 20 to Tue,
  // Mar 24; its Internal review and Deliver follow, …; Client K's Fri, Apr 3 Due date stays safe".
  const moveWords = dragged.filter((d) => !d.follows).map((d) => {
    const after = dragged.filter((f) => f.follows === d.step && f.card === d.card);
    const due = d.unit.due ? dayNumber(d.unit.due, env) : null;
    return `${d.name}'s ${d.step} from ${dayText(d.from)} to ${dayText(d.to)}` +
      (after.length ? `; its ${andList(after.map((f) => f.step))} follow${after.length === 1 ? 's' : ''}, ${andList(after.map((f) => `${f.step} from ${dayText(f.from)} to ${dayText(f.to)}`))}` : '') +
      (due === null || d.own ? '' : onTime(drags.sends.get(d.unit.id)) ? `; ${d.name}'s ${dayText(due)} Due date stays safe`
        : `; ${d.name} then sends ${dayText(drags.sends.get(d.unit.id).send)}, ${against(drags.sends.get(d.unit.id).send_past_due, due, 'its Due date')}`);
  });
  const sendOf = (x) => drags.sends.get(x.unit.id);
  const head = !first.length ? '' : `Least slack first on ${who}'s time: ` +
    `${andList(first.map((x) => `${x.name}'s ${x.moves.length ? x.moves[0].step : 'work'}`))} ${first.length === 1 ? 'goes' : 'go'} first. ` +
    `Move ${moveWords.join('. Then move ')}. ` +
    `Tested on the cards as the moves leave them: ${andList(first.map((x) => `${x.name} sends ${dayText(sendOf(x).send)}, ${against(sendOf(x).send_past_due, sendOf(x).promise, 'its Due date')}`))}; no other job goes late`;
  const gave = fallback.filter((f) => f.to);
  const none = fallback.filter((f) => !f.to);
  const rest = [...gave.map((f) => f.words), ...(none.length ? [`no reshuffle saves ${andList(none.map((f) => f.name))}; the Delivery lead decides`] : [])];
  let suggestion = [head, ...rest].filter(Boolean).join('; ');
  suggestion = suggestion.charAt(0).toUpperCase() + suggestion.slice(1);
  const iso = (d) => (d === null || d === undefined ? null : isoDay(d));
  return {
    owners: [...owners], from: best ? iso(best.from) : null, to: best ? iso(best.to) : null, head,
    reshuffle_suggested: kept.length > 0, saved: kept.map((u) => u.name), not_saved: left.map((u) => u.name),
    every_job_sends_by_due_date: none.length === 0, suggestion, fallback, short: Object.fromEntries(first.map((x) => [x.unit.id, head])),
    // Every step move, each with from and to (start and due), and the step it follows, if any.
    drags: dragged.map((d) => ({ card: d.card, card_id: d.unit.id, step: d.step, step_id: d.stepId, from: iso(d.from), from_due: iso(d.fromDue), to: iso(d.to), to_due: iso(d.toDue), follows: d.follows })),
    // The drags as one fix Apply fix can write, each step from its dates on the card.
    fix_moves: (drags?.changes || []).map((c) => moveOf(c.unit, c.step, iso(c.start), iso(c.due), (ms) => isoDay(dayNumber(ms, env)))),
    sends_after_drags: first.map((x) => ({ card: x.unit.name, send: iso(sendOf(x).send), due_date: iso(sendOf(x).promise) })),
    drags_tested_on_jobs: drags ? drags.checked : 0,
    order: rows.map((x) => ({ card: x.unit.name, id: x.unit.id, at_risk: x.atRisk, saved: x.saved, slack_working_days: x.before.send_past_due === null ? null : -x.before.send_past_due,
      send_before: iso(x.before.send), send_after: iso(x.after.send), due_date: iso(x.after.promise), sends_by_due_date: x.fits,
      steps: x.moves.map((m) => ({ step: m.step, start: iso(m.start), due: iso(m.due), planned_start: iso(m.plannedStart), planned_due: iso(m.plannedDue), working_days_later: m.later })) })),
    ids: [...names.keys()],
  };
}
// --- monthly review ------------------------------------------------------------------------------------------

// Margin known while the job runs: a live fixed-fee job's card has a Budget and a Rate (so Forecast and Headroom
// work out); a live retainer piece's month card has a Budget.
export function marginKnown(tree) {
  const live = tree.units.filter(isLive);
  const known = live.filter((u) => {
    if (u.f['Agreement type'] === 'Fixed fee') return num(u.f.Budget) !== null && num(u.f.Rate) !== null;
    const parent = u.parent ? tree.byId.get(u.parent) : null;
    return !!parent && isMonth(parent) && num(parent.f.Budget) !== null;
  });
  return { known: known.length, live: live.length };
}

// The review, from `call(name, args)` (a tool's structured answer) and the extras read directly (the retainer clients,
// the live cards' margin). Every section keeps the calls its figures came from.
export async function reviewOf(month, call, { retainerClients = [], margin_known = null } = {}) {
  const [y, m] = month.split('-').map(Number);
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = iso(new Date(Date.UTC(y, m - 1, 1)));
  const to = iso(new Date(Date.UTC(y, m, 0)));
  const sixFrom = iso(new Date(Date.UTC(y, m - 6, 1)));
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const ask = async (tool, args) => ({ source: { tool, args }, answer: await call(tool, args) });
  const [onMonths, onJob, ...rest] = await Promise.all([
    ask('on_time_rate', { group_by: 'month', from: sixFrom, to }), ask('on_time_rate', { group_by: 'job_type', from, to }),
    ...['client', 'job_type', 'agreement_type'].map((g) => ask('margin_by_client', { state: 'finished', from, to, group_by: g })),
    ...['client', 'step', 'job_type'].map((g) => ask('rework_by_cause', { from, to, group_by: g })),
    ...['kind', 'job_type', 'step'].map((g) => ask('estimate_accuracy_by_step', { from, to, group_by: g })),
    ask('stage_flow', { from, to }), ask('reserve_use', { from_month: month, to_month: month }), ask('work_mix', { from_month: month, to_month: month }),
    ask('days_of_warning', { from, to }), ask('requests_arriving_complete', { month }),
    ...retainerClients.map((c) => ask('retainer_usage', { client: c, month })),
  ]);
  const [mClient, mJob, mAgree, rClient, rStep, rJob, aKind, aJob, aStep, flow, reserve, mix, warning, requests, ...retainers] = rest;
  const top = (rows, n = 10) => (rows || []).slice(0, n);
  const sources = (...xs) => xs.map((x) => x.source);
  const sections = [];
  const add = (section, sentence, srcs, figures) => sections.push({ section, sentence, sources: srcs, figures });
  add('On time', onJob.answer.summary, sources(onMonths, onJob),
    { by_month: onMonths.answer.rows, by_job_type: onJob.answer.rows, on_time: onJob.answer.on_time, finished: onJob.answer.finished });
  add('Margin, finished work', mClient.answer.summary, sources(mClient, mJob, mAgree),
    { by_client: top(mClient.answer.rows), by_job_type: mJob.answer.rows, by_agreement_type: mAgree.answer.rows, total: mClient.answer.total });
  add('Rework', rClient.answer.summary, sources(rClient, rStep, rJob),
    { by_client: top(rClient.answer.rows), by_step: rStep.answer.rows, by_job_type: rJob.answer.rows, totals: rClient.answer.totals, completeness: rClient.answer.completeness });
  add('Estimate accuracy', aKind.answer.summary, sources(aKind, aJob, aStep),
    { by_kind: aKind.answer.rows, by_job_type: aJob.answer.rows, by_step: top(aStep.answer.rows), totals: aKind.answer.totals });
  const dd = flow.answer.delivery_days_by_job_type || [];
  const slow = dd.length ? dd.reduce((a, b) => ((b.median_working_days ?? 0) > (a.median_working_days ?? 0) ? b : a)) : null;
  add('Delivery days', dd.length
    ? `${name}, kick-off to the send on finished jobs: ${dd.map((r) => `${r.job_type} a median ${fmt(r.median_working_days)} working days (n ${r.jobs})`).join(', ')}; the longest is ${slow.job_type} (stage flow).`
    : `${name}: no finished job to count kick-off to the send (stage flow).`, sources(flow), { by_job_type: dd });
  add('Where work waits', flow.answer.summary, sources(flow),
    { steps: flow.answer.steps, bottleneck: flow.answer.bottleneck, rework_pace: flow.answer.rework_pace, longest_wait: flow.answer.longest_wait });
  add('Reserve use', reserve.answer.summary, sources(reserve), { overall_pct: reserve.answer.overall_pct, teams: reserve.answer.teams, people: reserve.answer.people });
  add('Work mix', mix.answer.summary, sources(mix), { teams: mix.answer.teams, people: mix.answer.people });
  const usage = retainers.map((r) => ({ client: r.answer.client, allowance: r.answer.allowance, hours_logged: r.answer.hours_logged, used_pct: r.answer.used_pct }));
  add('Retainer usage', usage.length
    ? `${name}, retainer hours used against the allowance: ${usage.map((u) => `${u.client} ${u.used_pct}% (${fmt(u.hours_logged)} of ${fmt(u.allowance)} h)`).join(', ')} (retainer usage).`
    : `${name}: no retainer client (retainer usage).`, sources(...retainers), { clients: usage });
  // The pilot KPIs, each from the read named beside it; days to clear beside days of warning.
  const people = mix.answer.people || [];
  const hoursOf = (kind) => sum(people.map((p) => (p.kinds.find((k) => k.kind === kind) || {}).hours || 0));
  const allHours = sum(people.map((p) => p.total_hours || 0));
  // Internal rework is the rework measure: our own mistakes. Client revisions are not in it; they sit under estimates,
  // an accuracy and pricing figure, shown beside it.
  const share = (h) => (allHours ? Math.round((1000 * h) / allHours) / 10 : null);
  const internalH = hoursOf('internal rework');
  const clientH = hoursOf('client revisions');
  const onPct = onJob.answer.finished ? Math.round((100 * onJob.answer.on_time) / onJob.answer.finished) : null;
  const kpis = [
    { kpi: '% delivered on time', value: onPct, unit: '%', detail: `${onJob.answer.on_time} of ${onJob.answer.finished} finished jobs on the agreed date`, source: onJob.source },
    { kpi: 'days of warning', value: warning.answer.median_working_days_of_warning, unit: 'working days (median)',
      detail: `${warning.answer.flagged_total ?? warning.answer.flagged?.length ?? 0} warnings on ${warning.answer.jobs_flagged ?? warning.answer.flagged_total ?? 0} jobs; ${warning.answer.still_sent_on_time} of ${warning.answer.flagged_finished} finished still sent on time`,
      enough_history: warning.answer.enough_history, source: warning.source },
    { kpi: 'days to clear', value: warning.answer.median_working_days_to_clear ?? null, unit: 'working days (median)',
      detail: (({ outcomes: o = {} }) => `${o[OUTCOMES.cleared] ?? 0} cleared before the send, ${(o[OUTCOMES.sentOnTime] ?? 0) + (o[OUTCOMES.sentLate] ?? 0)} sent without clearing, ${o[OUTCOMES.open] ?? 0} still open`)(warning.answer),
      enough_history: warning.answer.enough_history_to_clear, source: warning.source },
    { kpi: 'internal rework share of hours', value: share(internalH), unit: '%', detail: `${fmt(internalH)} of ${fmt(allHours)} h logged`, source: mix.source },
    { kpi: 'client revision share of hours (under estimates)', value: share(clientH), unit: '%',
      detail: `${fmt(clientH)} of ${fmt(allHours)} h logged: the client's changes, an estimate and pricing figure, not counted as rework`, source: mix.source },
    { kpi: 'margin known while the job runs (live jobs today)', value: margin_known && margin_known.live ? Math.round((100 * margin_known.known) / margin_known.live) : null, unit: '%',
      detail: margin_known ? `${margin_known.known} of ${margin_known.live} live jobs` : 'not read', source: { tool: 'the live cards', args: { budget_and_rate: true } } },
    { kpi: 'requests arriving complete', value: requests.answer.requests ? Math.round((100 * requests.answer.complete) / requests.answer.requests) : null, unit: '%',
      detail: `${requests.answer.complete} of ${requests.answer.requests} requests`, enough_history: requests.answer.enough_history, source: requests.source },
  ];
  const kv = (k) => (k.value === null || k.value === undefined ? 'no figure' : `${fmt(k.value)}${k.unit === '%' ? '%' : ` ${k.value === 1 ? k.unit.replace(/^working days/, 'working day') : k.unit}`}`) + (k.enough_history === false ? ' (too little history)' : '');
  add('Pilot KPIs', `${name}, the pilot KPIs: ${kpis.map((k) => `${k.kpi} ${kv(k)}`).join('; ')} (monthly review).`, kpis.map((k) => k.source), { kpis });
  return { month, from, to, sections };
}

async function monthlyReview(args, env) {
  const tool = TOOLS.monthly_review;
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new UserError(`"${args.month}" is not a month; use YYYY-MM`);
  const t0 = today(env);
  const firstOfThis = t0 - (Number(isoDay(t0).slice(8, 10)) - 1);
  const month = args.month || isoDay(firstOfThis - 1).slice(0, 7);
  const [tree, clients] = await Promise.all([projects(env), allTasks(env, LISTS.clients, false)]);
  const retainerClients = clients.filter((c) => !c.parent && num(c.f.Allowance) !== null).map((c) => c.name).sort();
  const call = async (name, a) => (await TOOLS[name].run(a, env)).structuredContent;
  const r = await reviewOf(month, call, { retainerClients, margin_known: marginKnown(tree) });
  return result(tool, env, {
    lines: [`The monthly review for ${month} (${r.from} to ${r.to}), one sentence a section:`, ...r.sections.map((x) => `- ${x.section}: ${x.sentence}`)],
    data: { month, from: r.from, to: r.to, sections: r.sections },
    sentence: `The monthly review for ${month}: ${r.sections.length} sections, each with the reads its figures came from (${tool.label}).`,
  });
}

// --- the pilot reads from the comments ---------------------------------------------------------------------

const ENOUGH = { warning: 5, requests: 10 }; // below these, too little history to mean anything
// An input the Advisor's first comment says is not in: missing, not attached or not received.
const MISSING = /\b(missing|not attached|not received)\b/i;
// A flag: a Planner comment carrying At risk or Off track, or the Health check Skill's own lateness line
// "will send N working day(s) late" (its Line 1 carries no verdict word), and not saying the job is now or back On
// track. "Late" alone is not a flag: a plan comment or an "is now on time" note that mentions it is not a warning.
// The warning's own first sentence is a flag too: "<job> sends <date>, N working day(s) after the <date>
// promise", with N in figures or words ("sends Tue, Mar 3, one working day after the Mon, Mar 2 promise"; also "would
// send on" and "is forecast to send"). A plan comment's "N working days after the requested <date>" is not one.
const COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)';
const FLAG = new RegExp('\\b(at risk|off track)\\b|\\bwill send \\d+ (working )?days? late\\b' +
  `|\\bsends?\\b[^.\\n]{0,40}?,\\s*${COUNT} working days? after the\\b[^.\\n]{0,40}?\\bpromise\\b`, 'i');
const CLEARED = /\b(is|now|back|remains?)\s+(now\s+|back\s+)?on track\b/i;
// The comments of many cards, a few at a time.
async function commentsFor(env, ids) {
  const out = new Map();
  const queue = [...ids];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) { const id = queue.shift(); out.set(id, await taskComments(env, id).catch(() => [])); }
  }));
  return out;
}
// A comment's date: the date its text opens with ("Health check, 12 June 2026:", "Received 3 June 2026:"), for
// history imported with its comments; otherwise when it was posted. The
// opening is a short label of words, then the date and a colon, so a sentence that mentions a date later never
// counts. The agents' own comments never open with one, so their posting date is read.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const OPENING_DATE = new RegExp(`^\\s*(?:[A-Za-z][A-Za-z ]{0,30}?,?\\s+)?(\\d{1,2}) (${MONTH_NAMES.join('|')}) (\\d{4})\\s*:`, 'i');
export function commentTime(m) {
  const head = String(m.comment_text || '').match(OPENING_DATE);
  return head ? Date.UTC(Number(head[3]), MONTH_NAMES.indexOf(head[2].toLowerCase()), Number(head[1]), 12) : Number(m.date);
}
const oldestFirst = (cs) => [...cs].sort((a, b) => commentTime(a) - commentTime(b));
// The agents' dated forms: a comment posted by a staff account counts as the agent's when it opens with a
// date in the agent's own form, as imported history does: "Health check, 12 June 2026:" for the Delivery Planner,
// "Received 3 June 2026:" for the Intake Advisor. Any other staff comment is not counted.
const datedForm = (label) => new RegExp(`^\\s*${label},?\\s+\\d{1,2} (${MONTH_NAMES.join('|')}) \\d{4}\\s*:`, 'i');
const PLANNER_FORM = datedForm('Health check');
const ADVISOR_FORM = datedForm('Received');
const countsAs = (agent, form) => (m) => m.user?.username === agent || form.test(m.comment_text || '');

// A clear: a Planner comment saying the job is On track and not saying At risk or Off track ("Health
// check: On track", "Health improved to On track", "is back on track", "is On track").
const ON_TRACK = /\bon track\b/i;
const NOT_ON_TRACK = /\b(at risk|off track)\b/i;
export const OUTCOMES = { cleared: 'cleared before send', sentOnTime: 'never cleared, sent on time', sentLate: 'never cleared, sent late', open: 'still open' };

// cards: [{ id, name, due (ms), send (Deliver's start, ms, or null), closed, closedOn, f }]; commentsById: Map(id ->
// comments). per: the window on the first flag's day; todayDn: today (a test passes its own).
export function warningOf(cards, commentsById, env, { agent = AGENTS.planner, per = null, todayDn = today(env) } = {}) {
  const flagged = [];
  const span = (from, to) => (to <= from ? 0 : workingDaysBetween(from + 1, to)); // working days after from, up to to
  const isFlag = (m) => FLAG.test(m.comment_text || '') && !CLEARED.test(m.comment_text || '');
  const isClear = (m) => ON_TRACK.test(m.comment_text || '') && !NOT_ON_TRACK.test(m.comment_text || '');
  for (const c of cards) {
    if (!c.due) continue;
    const mine = oldestFirst(commentsById.get(c.id) || []).filter(countsAs(agent, PLANNER_FORM));
    // Warning episodes: a flag opens one, the first later On track closes it, and a flag after that
    // opens the next. Flags with no clear between them are one episode.
    const episodes = [];
    let open = null;
    for (const m of mine) {
      if (!open && isFlag(m)) open = { flag: m, clear: null };
      else if (open && isClear(m)) { open.clear = m; episodes.push(open); open = null; }
    }
    if (open) episodes.push(open);
    const due = dayNumber(c.due, env);
    const lateBy = num(c.f['Late by']);
    const finished = c.closed || num(c.f['Delivered on']) !== null;
    const sendMs = c.send ?? num(c.f['Delivered on']) ?? (c.closed ? c.closedOn : null);
    const sendDn = sendMs ? dayNumber(sendMs, env) : null;
    const sent = sendDn !== null && sendDn <= todayDn;
    episodes.forEach((e, i) => {
      const on = dayNumber(commentTime(e.flag), env);
      if (per && !per.has(on)) return;
      const days = on < due ? workingDaysBetween(on + 1, due) : on === due ? 0 : -workingDaysBetween(due + 1, on);
      // Days to clear: to the clear, or to the send (Deliver's start) if it went out first; open otherwise.
      const clearDn = e.clear ? dayNumber(commentTime(e.clear), env) : null;
      let outcome;
      let end = null;
      if (clearDn !== null && (!sent || clearDn <= sendDn)) { outcome = OUTCOMES.cleared; end = clearDn; }
      else if (sent) { outcome = (lateBy !== null ? lateBy > 0 : sendDn > due) ? OUTCOMES.sentLate : OUTCOMES.sentOnTime; end = sendDn; }
      else outcome = OUTCOMES.open;
      flagged.push({ card: c.name, id: c.id, episode: i + 1, flagged_on: isoDay(on), due_date: isoDay(due), days_of_warning: days,
        back_on_track_on: clearDn !== null ? isoDay(clearDn) : null, send_date: sendDn !== null ? isoDay(sendDn) : null,
        days_to_clear: end === null ? null : span(on, end), outcome, finished,
        on_time: finished ? (lateBy !== null ? lateBy <= 0 : dayNumber(num(c.f['Delivered on']) ?? c.closedOn, env) <= due) : null });
    });
  }
  flagged.sort((a, b) => a.flagged_on.localeCompare(b.flagged_on) || a.card.localeCompare(b.card) || a.episode - b.episode);
  // Still on time is a job's: each finished job with a warning in the window counts once, however many it had.
  const jobs = [...new Map(flagged.map((x) => [x.id, x])).values()];
  const done = jobs.filter((x) => x.finished);
  const toClear = flagged.filter((x) => x.days_to_clear !== null);
  return { flagged, jobs: jobs.length, median_working_days: median(flagged.map((x) => x.days_of_warning)), median_days_to_clear: median(toClear.map((x) => x.days_to_clear)),
    outcomes: Object.fromEntries(Object.values(OUTCOMES).map((o) => [o, flagged.filter((x) => x.outcome === o).length])),
    finished: done.length, still_on_time: done.filter((x) => x.on_time).length,
    share_on_time: done.length ? Math.round((100 * done.filter((x) => x.on_time).length) / done.length) : null,
    enough: { days: flagged.length >= ENOUGH.warning, share: done.length >= ENOUGH.warning, clear: toClear.length >= ENOUGH.warning } };
}

async function daysOfWarning(args, env) {
  const tool = TOOLS.days_of_warning;
  const per = period(args);
  const tree = await projects(env);
  const sendOf = (card) => tree.descendants(card.id).find((s) => /^deliver$/i.test(s.name.trim()))?.start ?? null; // the send: Deliver's start
  const cards = [...tree.units, ...tree.months].filter((t) => t.f.Health).map((t) => ({ ...t, send: sendOf(t) }));
  const r = warningOf(cards, await commentsFor(env, cards.map((c) => c.id)), env, { per });
  const pg = pageOf(r.flagged, args.page);
  const n = r.flagged.length;
  const o = r.outcomes;
  const wd = (x) => `${fmt(x)} working day${x === 1 ? '' : 's'}`;
  let sentence = n
    ? `The Health check raised ${n} warning${n === 1 ? '' : 's'} on ${r.jobs} job${r.jobs === 1 ? '' : 's'}${per.label}, a median ${wd(r.median_working_days)} before the Due date`
    : `The Health check has flagged no job${per.label} yet`;
  if (n) {
    sentence += r.median_days_to_clear !== null ? `; a median ${wd(r.median_days_to_clear)} to clear` : '; none has cleared or sent yet';
    sentence += ` (${o[OUTCOMES.cleared]} cleared before the send, ${o[OUTCOMES.sentOnTime] + o[OUTCOMES.sentLate]} sent without clearing, ${o[OUTCOMES.open]} still open)`;
    sentence += r.finished ? `; ${r.still_on_time} of the ${r.finished} that finished still sent on time` : '; none of them has finished yet';
  }
  const short = [!r.enough.days && 'warnings', r.enough.days && !r.enough.clear && 'warnings with days to clear', r.enough.days && !r.enough.share && 'flagged jobs finished'].filter(Boolean);
  if (short.length) sentence += `; too little history to mean anything yet (fewer than ${ENOUGH.warning} ${short.join(' or ')})`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`Warnings the Health check raised${per.label}, each against the Due date, and the working days to clear (${cards.length} jobs scored; a new warning after an all-clear starts a fresh count):`,
      ...(n ? pg.items.map((x) => `- ${x.card}${x.episode > 1 ? ` (warning ${x.episode})` : ''}: flagged ${x.flagged_on}, Due ${x.due_date}, ${wd(x.days_of_warning)} of warning; ${x.outcome}` +
        `${x.days_to_clear !== null ? `, ${wd(x.days_to_clear)} to clear` : ''}${x.finished ? `; finished, ${x.on_time ? 'on time' : 'late'}` : ''}`) : ['- none yet']),
      ...pageLine(pg, n, 'Warnings')],
    data: { jobs_scored: cards.length, from: per.from === null ? null : isoDay(per.from), to: per.to === null ? null : isoDay(per.to),
      flagged: pg.items, flagged_total: n, jobs_flagged: r.jobs, page: pg.page, pages: pg.pages, next_page: pg.next_page, list_version: pg.version,
      median_working_days_of_warning: r.median_working_days, median_working_days_to_clear: r.median_days_to_clear, outcomes: r.outcomes,
      flagged_finished: r.finished, still_sent_on_time: r.still_on_time, share_still_on_time_pct: r.share_on_time,
      enough_history: r.enough.days && r.enough.share, enough_history_to_clear: r.enough.clear },
    cards: pg.items.map((x) => x.id),
    sentence,
  });
}

// The requests the read counts: every request card in Intake, and every project card at the top of Projects, live or
// finished. [Test] cards are not in either tree's units.
export function requestCards(intakeTree, tree) {
  return [...intakeTree.units, ...tree.units.filter((u) => !u.parent)];
}

// cards: [{ id, name }]; complete when the Advisor's first comment has no line saying "missing".
export function completeOf(cards, commentsById, env, agent = AGENTS.advisor) {
  const byMonth = new Map();
  const requests = [];
  for (const c of cards) {
    const first = oldestFirst(commentsById.get(c.id) || []).find(countsAs(agent, ADVISOR_FORM));
    if (!first) continue;
    const complete = !String(first.comment_text || '').split('\n').some((l) => MISSING.test(l));
    const month = monthOf(commentTime(first), env);
    const g = byMonth.get(month) || { month, complete: 0, requests: 0 };
    g.requests += 1; if (complete) g.complete += 1;
    byMonth.set(month, g);
    requests.push({ card: c.name, id: c.id, month, complete });
  }
  const rows = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((g) => ({ ...g, share_pct: Math.round((100 * g.complete) / g.requests) }));
  return { rows, requests, enough: requests.length >= ENOUGH.requests };
}

async function requestsArrivingComplete(args, env) {
  const tool = TOOLS.requests_arriving_complete;
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new UserError(`"${args.month}" is not a month; use YYYY-MM`);
  const live = await liveWork(env);
  const cards = requestCards(live.intakeTree, live.tree);
  const r = completeOf(cards, await commentsFor(env, cards.map((c) => c.id)), env);
  const rows = args.month ? r.rows.filter((x) => x.month === args.month) : r.rows;
  const complete = sum(rows.map((x) => x.complete));
  const n = sum(rows.map((x) => x.requests));
  const scope = args.month ? monthLabel(args.month, env).replace(/^in /, '').replace(/^./, (c) => c.toUpperCase()) : 'All months';
  let sentence = n ? `${scope}: ${complete} of ${n} request${n === 1 ? '' : 's'} arrived complete, the Intake Advisor's first comment naming nothing missing (${pct(complete, n)})`
    : `${scope}: no request with an Intake Advisor comment`;
  if (!r.enough) sentence += `; too little history to mean anything yet (fewer than ${ENOUGH.requests} requests)`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`Requests by the month of the Intake Advisor's first comment (complete: no line says "missing", "not attached" or "not received"):`,
      ...(rows.length ? rows.map((x) => `- ${x.month}: ${x.complete} of ${x.requests} complete (${x.share_pct}%)`) : ['- none']),
      ...r.requests.filter((x) => !args.month || x.month === args.month).slice(0, 25).map((x) => `  ${x.card}: ${x.complete ? 'complete' : 'something missing'}`)],
    data: { month: args.month ?? null, rows, complete, requests: n, enough_history: r.enough,
      by_request: r.requests.filter((x) => !args.month || x.month === args.month).slice(0, 25) },
    cards: r.requests.slice(0, 25).map((x) => x.id),
    sentence,
  });
}

// --- capacity what-if ---------------------------------------------------------------------------------------

// Every live job played forward with today's capacity and with `hours` for each of `owners`; the jobs whose send
// moves; the owners' weeks against the new hours; the hours of new work that fit at the planning cap.
export function capacityReplay(live, env, { owners, hours, terms = null, weeks = 8, capPct = 80, from = today(env) }) {
  const after = { ...CAPACITY, ...Object.fromEntries(owners.map((o) => [o, hours])) };
  const moved = [];
  for (const u of live.tree.units.filter(isLive)) {
    const input = recoveryInput(live, u, env, { terms });
    const b = schedule(input);
    const a = schedule({ ...input, capacity: after });
    if (b.send === null || a.send === null || a.send === b.send) continue;
    moved.push({ card: u.name, id: u.id, send_before: isoDay(b.send), send_after: isoDay(a.send),
      working_days: a.send > b.send ? workingDaysBetween(b.send + 1, a.send) : -workingDaysBetween(a.send + 1, b.send),
      due_date: b.promise === null ? null : isoDay(b.promise), late_before: (b.send_past_due ?? 0) > 0, late_after: (a.send_past_due ?? 0) > 0 });
  }
  moved.sort((x, y) => x.working_days - y.working_days || x.card.localeCompare(y.card));
  const monday = from - ((new Date(from * DAY_MS).getUTCDay() + 6) % 7);
  const rows = [];
  let fitBefore = 0;
  let fitAfter = 0;
  for (let w = 0; w < weeks; w++) {
    let booked = 0; let before = 0; let afterH = 0;
    for (let d = monday + 7 * w; d < monday + 7 * w + 5; d++) {
      if (!isWorkingDay(d)) continue;
      for (const o of owners) { booked += live.booked.get(o)?.get(d) || 0; before += (CAPACITY[o] ?? 0) / 5; afterH += hours / 5; }
    }
    const freeBefore = Math.max(0, (before * capPct) / 100 - booked);
    const freeAfter = Math.max(0, (afterH * capPct) / 100 - booked);
    fitBefore += freeBefore; fitAfter += freeAfter;
    rows.push({ week_of: isoDay(monday + 7 * w), booked: round1(booked), hours_now: round1(before), hours_asked: round1(afterH),
      fits_at_cap_now: round1(freeBefore), fits_at_cap_asked: round1(freeAfter) });
  }
  return { moved, weeks: rows, fits_now: round1(fitBefore), fits_asked: round1(fitAfter) };
}

async function capacityWhatIf(args, env) {
  const tool = TOOLS.capacity_what_if;
  const [live, terms] = await Promise.all([liveWork(env), supplierTerms(env)]);
  const who = String(args.who ?? '').trim().replace(/^the\s+/i, '').replace(/\s+team$/i, '');
  const hours = Number(args.hours);
  if (!who) throw new UserError('Name a Team or a person');
  if (!Number.isFinite(hours) || hours < 0 || hours > 80) throw new UserError('Give the weekly hours, from 0 to 80');
  const team = [...live.members.keys()].find((t) => t.toLowerCase() === who.toLowerCase());
  const person = Object.keys(CAPACITY).find((p) => p.toLowerCase() === who.toLowerCase() && CAPACITY[p] > 0);
  const owners = team ? live.members.get(team) : person ? [person] : null;
  if (!owners || !owners.length) {
    throw new UserError(`"${args.who}" is not a Team or a person with hours on record (Teams: ${[...live.members.keys()].join(', ')}; people: ${Object.keys(CAPACITY).filter((p) => CAPACITY[p] > 0).join(', ')})`);
  }
  const label = team ? `the ${team} Team (${owners.join(', ')})` : person;
  const now = owners.map((o) => CAPACITY[o] ?? 0);
  const r = capacityReplay(live, env, { owners, hours, terms });
  const earlier = r.moved.filter((m) => m.working_days < 0);
  const later = r.moved.filter((m) => m.working_days > 0);
  const saved = r.moved.filter((m) => m.late_before && !m.late_after);
  const made = r.moved.filter((m) => !m.late_before && m.late_after);
  let sentence = `With ${label} at ${fmt(hours)} h a week${team && owners.length > 1 ? ' each' : ''} (now ${now.map(fmt).join(', ')} h): `;
  sentence += r.moved.length ? `${earlier.length} live job${earlier.length === 1 ? '' : 's'} send${earlier.length === 1 ? 's' : ''} earlier and ${later.length} later` : 'no live job\'s send moves';
  if (saved.length) sentence += `, bringing ${andList(saved.map((m) => m.card))} back inside ${saved.length === 1 ? 'its' : 'their'} Due date${saved.length === 1 ? '' : 's'}`;
  if (made.length) sentence += `, making ${andList(made.map((m) => m.card))} late`;
  sentence += `; over the next eight weeks ${fmt(r.fits_asked)} h of new work fit${r.fits_asked === 1 ? 's' : ''} at the 80% planning cap, against ${fmt(r.fits_now)} h now (${tool.label}).`;
  return result(tool, env, {
    lines: [`${label} at ${fmt(hours)} h a week, every live job played forward again:`,
      ...(r.moved.length ? r.moved.slice(0, 25).map((m) => `- ${m.card}: sends ${m.send_after} instead of ${m.send_before} (${m.working_days > 0 ? '+' : ''}${m.working_days} working days)${m.due_date ? `; Due ${m.due_date}` : ''}${m.late_before !== m.late_after ? (m.late_after ? ', now late' : ', now on time') : ''}`) : ['- no live job\'s send moves']),
      'The next eight weeks (booked against the hours; new work that fits at the 80% cap, now and as asked):',
      ...r.weeks.map((w) => `- week of ${w.week_of}: ${fmt(w.booked)} h booked against ${fmt(w.hours_asked)} h (now ${fmt(w.hours_now)}); fits ${fmt(w.fits_at_cap_asked)} h (now ${fmt(w.fits_at_cap_now)})`)],
    data: { who: label, owners, hours, hours_now: now, jobs_moved: r.moved.slice(0, 25), weeks: r.weeks, new_work_fits_hours: r.fits_asked, new_work_fits_hours_now: r.fits_now },
    cards: r.moved.slice(0, 25).map((m) => m.id),
    sentence,
  });
}

// The checks that tripped, in words.
function trippedWords(h) {
  return h.checks.filter((c) => c.level === 'At risk' || c.level === 'Off track').map((c) => `${c.check}: ${c.detail}`);
}
const verdictSaid = (h) => h.checks.some((c) => (c.check === 'Recovery re-walk' || c.check === 'Forecast') && (c.level === 'At risk' || c.level === 'Off track'));
const bare = (label) => String(label).replace(/ \(.*\)$/, '');
// The reshuffle's line in the text: its own words carry the label when they start with it.
const labelled = (words) => (/^Least slack first/.test(words) ? words : `Least slack first: ${words}`);

async function projectHealthInputs(args, env) {
  const tool = TOOLS.forecast_delivery;
  const { live, ctx } = await healthContext(env);
  const levelRank = { 'Off track': 2, 'At risk': 1, 'On track': 0 };
  const liveJobs = live.tree.units.filter(isLive);
  if (args.all_live || args.all_in_progress) {
    const rows = [];
    for (const u of liveJobs) rows.push(await healthOf(u, live.tree, live, env, ctx));
    for (const m of live.tree.months.filter((t) => t.status === 'in progress')) rows.push(await monthHealthOf(m, live.tree, env, ctx));
    rows.sort((a, b) => levelRank[b.health_by_the_checks] - levelRank[a.health_by_the_checks]
      || (b.rewalk?.working_days_send_past_due_date ?? -99) - (a.rewalk?.working_days_send_past_due_date ?? -99) || a.card.localeCompare(b.card));
    const weeks = teamWeeks(live, env);
    const count = (h) => rows.filter((r) => r.health_by_the_checks === h).length;
    const gone = rows.filter((r) => r.buffer_gone);
    const late = rows.filter((r) => r.checks.some((c) => c.check === 'Forecast' && c.level === 'At risk'));
    const reshuffle = reshuffleOf(live, env, ctx, liveJobs);
    // The suggestion on the cards late on the forecast; the other jobs in the reshuffle are marked and read it below.
    for (const r of rows) {
      r.in_least_slack_first = !!reshuffle && reshuffle.ids.includes(r.id);
      r.suggestion = r.in_least_slack_first && r.checks.some((c) => c.check === 'Forecast' && c.level === 'At risk') ? suggestionFor(reshuffle, r.id) : null;
    }
    for (const r of rows) if (r.step_days) r.fix = await fixOf(env, live, reshuffle, r, live.tree.byId.get(r.id));
    const overdue = rows.filter((r) => r.checks.some((c) => c.check === 'Overdue step' && c.level !== 'clear'));
    const cost = rows.filter((r) => r.checks.some((c) => c.check === 'Cost' && c.level === 'Off track'));
    const approvedWaiting = rows.filter((r) => r.forecast_only).length;
    const of = (k, st) => rows.filter((r) => r.kind === k && (st === 'to do' ? r.forecast_only : !r.forecast_only)).length;
    const counts = andList([[of('project', 'in progress'), 'project'], [of('retainer piece', 'in progress'), 'retainer piece'], [of('month card', 'in progress'), 'month card']]
      .filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`));
    const sentence = `${rows.length} jobs to check: ${counts} In progress, and ${approvedWaiting} approved at To do (${andList([[of('project', 'to do'), 'project'], [of('retainer piece', 'to do'), 'retainer piece']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`))}); ${count('Off track')} Off track, ${count('At risk')} At risk and ${count('On track')} On track by the checks; ` +
      `${late.length} would send after the Due date on the forecast${late.length ? ` (${andList(jobNames(late.map((r) => live.tree.byId.get(r.id))))})` : ''}, ` +
      `${gone.length} with the buffer gone, ${overdue.length} with an overdue step and ${cost.length} over budget` +
      (reshuffle ? `; ${fallbackWords(reshuffle)}` : '') + ` (${tool.label}).`;
    const short = (r) => trippedWords(r).join(' | ');
    return result(tool, env, {
      lines: [`Every job to check this run, the worst first (${rows.length}): each project and each retainer piece is its own job; a retainer month card is checked for its money only; an approved job at To do for the Buffer and the Forecast only. Write Health and Health reason on each.`,
        ...rows.map((r) => `- ${r.card} (${r.kind === 'retainer piece' ? `retainer piece of ${r.month_card}` : r.kind}${r.forecast_only ? ', To do' : ''}): ${r.health_by_the_checks}${r.tripped.length ? `: ${short(r)}` : ''}` +
          `${r.rewalk && !verdictSaid(r) ? `; ${r.rewalk.verdict}` : ''}${r.notes?.length ? `; note: ${r.notes.join('; ')}` : ''}${r.watch ? `; Watch (Health unchanged): ${r.watch.comment.split('\n')[0]}` : ''}` +
          `${r.fix?.ref ? `; Fix ref ${r.fix.ref}` : ''}`),
        ...(reshuffle ? [`${labelled(reshuffle.suggestion)}.`] : []),
        `The team, hours booked of capacity, weeks of ${weeks[0].weeks.map((x) => dayText(dateArg(x.week_of, 'week')).replace(/^\w+, /, '')).join(', ')}:`,
        ...weeks.map((p) => `- ${p.person}: ${p.weeks.map((x) => `${fmt(x.booked)}/${fmt(x.capacity)}`).join(', ')}`)],
      // One record a card: a short one when it is On track, what tripped and the suggestion when it is not; the
      // single-project call has the rest.
      data: { projects: rows.map((r) => {
        const short = { card: r.card, id: r.id, kind: r.kind, ...(r.month_card ? { month_card: r.month_card } : {}), health_by_the_checks: r.health_by_the_checks, due_date: r.due_date ?? null, forecast_send: r.rewalk?.send ?? null,
          ...(r.forecast_only ? { forecast_only: true } : {}), ...(r.watch ? { watch_comment: r.watch.comment } : {}), ...(r.fix?.ref ? { fix_ref: r.fix.ref } : {}) };
        if (!r.tripped.length) return r.notes?.length ? { ...short, notes: r.notes } : short;
        return { ...short, status: r.status, working_days_send_past_due_date: r.rewalk?.working_days_send_past_due_date ?? null, client: r.client, delivery_lead: r.delivery_lead ?? null, planned_send: r.planned_send ?? null, buffer_gone: r.buffer_gone ?? null,
          tripped: r.checks.filter((c) => c.level === 'At risk' || c.level === 'Off track'), notes: r.notes ?? [], suggestion: r.suggestion ?? null,
          step_lines: r.step_lines ?? [],
          first_step_that_breaks: r.rewalk?.first_step_that_breaks ?? null };
      }),
        least_slack_first: reshuffle ? brief(reshuffle) : null, team_weeks: weeks,
        ...(live.replan ? { replan: live.replan, due_overrides: live.dueOverrides } : {}) },
      cards: rows.map((r) => r.id),
      sentence,
    });
  }
  if (!args.project) throw new UserError('Name a project, or ask for all projects In progress');
  const unit = findProject(live.tree, args.project);
  if (isMonth(unit)) {
    const h = await monthHealthOf(unit, live.tree, env, ctx);
    const sentence = `${unit.name}: ${h.health_by_the_checks} by the checks; ${h.checks[0].detail} (${tool.label}).`;
    return result(tool, env, {
      lines: [`${unit.name}, ${unit.status}: Price ${moneyText(h.money.price)}, Budget ${moneyText(h.money.budget)}, ${fmt(h.money.estimated_hours)} h estimated, Forecast ${moneyText(h.money.forecast)}, Headroom ${moneyText(h.money.headroom)} (${h.money.headroom_pct ?? '-'}%).`,
        `Cost: ${h.checks[0].level}: ${h.checks[0].detail}.`,
        'Pieces: ' + (h.pieces.length ? h.pieces.map((p) => `${p.card} ${p.status}`).join('; ') : 'none yet') + '.'],
      data: h,
      cards: [unit.id, ...h.pieces.map((p) => p.id)],
      sentence,
    });
  }
  const h = await healthOf(unit, live.tree, live, env, ctx);
  const reshuffle = reshuffleOf(live, env, ctx, liveJobs.some((u) => u.id === unit.id) ? liveJobs : [...liveJobs, unit]);
  h.suggestion = reshuffle && reshuffle.ids.includes(unit.id) ? suggestionFor(reshuffle, unit.id) : null;
  const fix = await fixOf(env, live, reshuffle, h, unit);
  const tripped = trippedWords(h);
  const sentence = `${h.card}: ${h.health_by_the_checks} by the checks; ` + (tripped.length ? tripped.join('; ') : 'all checks clear') +
    (verdictSaid(h) ? '' : `; ${h.rewalk.verdict}`) + (h.suggestion && h.tripped.includes('Forecast') ? `. ${h.suggestion}` : '') + ` (${tool.label}).`;
  return result(tool, env, {
    lines: [
      `${h.card}, ${h.status}, ${h.agreement ?? 'no agreement type'}: Due date ${h.due_date ?? '-'}; planned send (Deliver's start) ${h.planned_send ?? '-'}; Deliver due ${h.deliver_due ?? '-'}; ${h.days_remaining ?? '-'} days remaining.`,
      `By the checks: ${h.health_by_the_checks}.`,
      ...h.checks.map((c) => `- ${c.check}: ${c.level}: ${c.detail}.`),
      ...(h.notes.length ? [`Notes (not scored): ${h.notes.join('; ')}.`] : []),
      ...(h.watch ? ['Watch comment (a step must move off its planned day, the send still lands by the Due date; Health is not changed), to post after the @mention as it stands:', ...h.watch.comment.split('\n')] : []),
      ...(h.step_lines.length ? ['Step lines, one per step whose planned day and replay day differ (a warning carries them as they stand):', ...h.step_lines] : []),
      'Each remaining step, its planned day against the replay:',
      ...h.step_days.map((r) => `- ${r.step}: planned ${r.planned_start === null ? 'no dates' : r.planned_start === r.planned_due ? r.planned_start : `${r.planned_start} to ${r.planned_due}`}; replay ${r.replay_start === r.replay_due ? r.replay_start : `${r.replay_start} to ${r.replay_due}`}${r.flag ? `; ${r.flag}` : ''}`),
      'Open steps, by due date:',
      ...h.steps.map((s) => `- ${s.step}: ${s.owner}; ${s.status}; ${fmt(s.estimate)} h estimated, ${fmt(s.tracked)} h tracked; planned ${s.start ?? '-'} to ${s.due ?? 'no due date'}` +
        `${s.rewalk_due ? `; re-walk ${s.rewalk_start} to ${s.rewalk_due}` : ''}${s.held_by_the_chain ? '; held by the step it waits on' : ''}${s.overdue ? '; overdue' : s.unstarted_on_due_day ? '; due today, not started' : ''}`),
      `Re-walk from today (recovery: on the remaining hours at 100%, the agency's turnaround and the client's sign-off fixed)${h.rewalk.triggered ? `, triggered because ${andList(h.rewalk.triggers)}; the recovery plan` : ', not triggered'}:`,
      ...planLines(h._walk),
      ...(h.suggestion ? [`${labelled(h.suggestion)}.`] : []),
      ...fixLines(fix),
    ],
    data: { ...(({ _walk, ...r }) => r)(h), least_slack_first: h.suggestion ? brief(reshuffle) : null, fix_ref: fix?.ref ?? null, fix_moves: fix?.moves ?? [] },
    cards: [h.id, ...h.steps.map((s) => s.id)].slice(0, 40),
    sentence,
  });
}

// The next four weeks from this one, Monday to Friday, per person with capacity: hours booked and free
// (Workload's method).
function teamWeeks(live, env) {
  const t0 = today(env);
  const monday = t0 - ((new Date(t0 * DAY_MS).getUTCDay() + 6) % 7);
  return Object.keys(CAPACITY).filter((p) => CAPACITY[p] > 0).map((person) => {
    const m = live.booked.get(person) || new Map();
    const weeks = [0, 1, 2, 3].map((w) => {
      let booked = 0; let capacity = 0; let free = 0;
      for (let d = monday + 7 * w; d < monday + 7 * w + 5; d++) {
        if (!isWorkingDay(d)) continue;
        capacity += dailyCapacity(person);
        booked += m.get(d) || 0;
        free += Math.max(0, dailyCapacity(person) - (m.get(d) || 0));
      }
      return { week_of: isoDay(monday + 7 * w), capacity: round1(capacity), booked: round1(booked), free: round1(free) };
    });
    return { person, weeks };
  });
}

async function rewalkChain(args, env) {
  const tool = TOOLS.test_a_fix;
  const [live, terms] = await Promise.all([liveWork(env), supplierTerms(env)]);
  const unit = findProject(live.tree, args.project);
  if (isMonth(unit)) throw new UserError(`${unit.name} is a month card; name one of its pieces`);
  const fromDn = dateArg(args.from_date, 'from_date');
  const capPct = Math.min(100, Math.max(10, Number(args.cap_pct ?? 100) || 100));
  const changes = changesArg(args, live, unit);
  const ctx = { terms, walks: fromDn === null && capPct === 100 ? live.walks : new Map() };
  const walk = (lv, u) => {
    if (lv === live && ctx.walks.has(u.id)) return ctx.walks.get(u.id);
    const w = rewalk(lv, u, env, { fromDn, capPct, terms });
    if (lv === live) ctx.walks.set(u.id, w);
    return w;
  };
  const base = walk(live, unit);
  if (!changes.length) {
    let sentence = `${unit.name}: on hours from today, ${sendWords(base)}`;
    if (base.first_break) sentence += `, and ${base.first_break.step} is the first step that breaks`;
    if (base.planned_send !== null && base.promise !== null && base.planned_send > base.promise && base.send_past_due !== null && base.send_past_due <= 0) sentence += ', so the recovery plan brings the send back inside the Due date';
    sentence += ` (${tool.label}).`;
    return result(tool, env, {
      lines: [`${unit.name}, re-walked from ${dayText(Math.max(today(env), fromDn ?? today(env)))} on the remaining hours at ${capPct}% of each day (recovery: no windows, the agency's turnaround and the client's sign-off fixed):`, ...planLines(base)],
      data: { project: unit.name, id: unit.id, cap_pct: capPct, as_is: shape(base), what_if: null, other_jobs: null },
      cards: [unit.id], sentence,
    });
  }
  // The change made to a copy of the cards, as the drag or the reassignment would leave them, and the forecast run on
  // that copy the same way Forecast delivery runs it: so a what-if matches the forecast after the change is made.
  const after = buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members);
  const jobs = live.tree.units.filter(isLive);
  if (!jobs.some((u) => u.id === unit.id)) jobs.push(unit);
  const names = jobNames(jobs);
  const rows = jobs.map((u, i) => ({ unit: u, name: names[i], before: walk(live, u), after: walk(after, after.tree.byId.get(u.id)) }))
    .filter((x) => x.before.promise !== null && x.before.send !== null);
  const mine = rows.find((x) => x.unit.id === unit.id) || { before: base, after: walk(after, after.tree.byId.get(unit.id)) };
  const others = rows.filter((x) => x.unit.id !== unit.id);
  const onTime = (w) => w.send_past_due !== null && w.send_past_due <= 0;
  const late = others.filter((x) => onTime(x.before) && !onTime(x.after));
  const back = others.filter((x) => !onTime(x.before) && onTime(x.after));
  const moved = others.filter((x) => x.after.send !== x.before.send);
  const said = changes.map((c) => changeWords(c, unit));
  let sentence = `${unit.name}: with ${andList(said)}, ${sendWords(mine.after)}; today's forecast: ${mine.before.send === null ? 'no send' : dayText(mine.before.send)}` +
    (mine.before.first_break ? `, ${mine.before.first_break.step} breaking first` : '') + '; ' +
    (late.length ? `it makes ${late.length === 1 ? 'one other job' : `${late.length} other jobs`} late: ${andList(late.map((x) => `${x.name}, the files out ${dayText(x.after.send)}, after its Due date of ${dayText(x.after.promise)}`))}`
      : `no other job goes late (${others.length} live jobs checked)`);
  if (back.length) sentence += `; it brings ${andList(back.map((x) => `${x.name} back inside its Due date (the files out ${dayText(x.after.send)}, against ${dayText(x.before.send)} today)`))}`;
  sentence += ` (${tool.label}).`;
  const fix = await testedFixOf(env, unit, changes);
  const iso = (d) => (d === null || d === undefined ? null : isoDay(d));
  const jobRow = (x) => ({ card: x.unit.name, id: x.unit.id, send_before: iso(x.before.send), send_after: iso(x.after.send), due_date: iso(x.after.promise),
    on_time_before: onTime(x.before), on_time_after: onTime(x.after) });
  return result(tool, env, {
    lines: [`${unit.name}, today's forecast (on the remaining hours from ${dayText(Math.max(today(env), fromDn ?? today(env)))}, at ${capPct}% of each day):`, ...planLines(mine.before),
      `With ${andList(said)}, the forecast after the change:`, ...planLines(mine.after),
      `What it does to the other live jobs (${others.length} checked): ` +
        (moved.length ? moved.map((x) => `${x.name} sends ${dayText(x.after.send)} instead of ${dayText(x.before.send)} (Due ${dayText(x.after.promise)}${!onTime(x.after) && onTime(x.before) ? ', now late' : onTime(x.after) && !onTime(x.before) ? ', now on time' : ''})`).join('; ') : 'no other job\'s send moves') + '.',
      ...fixLines(fix)],
    data: { project: unit.name, id: unit.id, cap_pct: capPct, changes: changes.map((c) => ({ project: c.unit.name, step: c.step.name, owner: c.owner ?? null, start: iso(c.start), due: iso(c.due),
      pushed: (c.pushed || []).map((p) => ({ step: p.step, start: iso(p.start), due: iso(p.due), working_days: p.shift })) })),
      as_is: shape(mine.before), what_if: { change: andList(said), ...shape(mine.after) },
      other_jobs: { jobs_checked: others.length, made_late: late.map(jobRow), brought_back: back.map(jobRow), sends_moved: moved.map(jobRow) },
      fix_ref: fix.ref ?? null, fix_moves: fix.moves, ...(fix.ref ? {} : { no_fix_ref: fix.why }) },
    cards: [unit.id, ...moved.map((x) => x.unit.id)],
    sentence,
  });
}

// The changes asked for: up to three, each a step on the named job (or another live job) with a new owner, a new
// start date (its due date moved with it, the step keeping its working days, as a drag does) or new dates. The single
// what_if_step / what_if_owner / what_if_start inputs are one change.
function changesArg(args, live, unit) {
  const asked = Array.isArray(args.changes) ? args.changes : [];
  if (args.what_if_step) asked.unshift({ step: args.what_if_step, owner: args.what_if_owner, start: args.what_if_start });
  if (asked.length > 3) throw new UserError('Try at most three changes at once');
  return asked.map((c, i) => {
    const job = c.project ? findProject(live.tree, c.project) : unit;
    const steps = openSteps(live.tree, job.id);
    const step = steps.find((x) => x.name.toLowerCase() === String(c.step ?? '').trim().toLowerCase());
    if (!step) throw new UserError(`${job.name} has no open step called "${c.step ?? ''}"`);
    if (c.owner && !(CAPACITY[c.owner] > 0)) {
      throw new UserError(`"${c.owner}" is not a person with capacity on record (${Object.keys(CAPACITY).filter((p) => CAPACITY[p] > 0).join(', ')})`);
    }
    const start = dateArg(c.start, `change ${i + 1}'s start`);
    const due = dateArg(c.due, `change ${i + 1}'s due date`);
    if (!c.owner && start === null && due === null) throw new UserError(`Change ${i + 1} (${step.name}) names no new owner or date`);
    return { unit: job, step, owner: c.owner || null, start, due };
  });
}

function changeWords(c, unit) {
  const whose = c.unit.id === unit.id ? '' : `${jobName(c.unit)}'s `;
  const dated = c.start !== null || c.due !== null;
  const span = (a, b) => (a !== null && b !== null && a !== b ? `${dayText(a)} to ${dayText(b)}` : dayText(a ?? b));
  const later = (c.pushed || [])[0]?.shift > 0;
  const pushed = (c.pushed || []).length
    ? ` (which ${later ? 'pushes' : 'brings'} ${andList(c.pushed.map((p) => `${p.step}${later ? '' : ' back'} to ${span(p.start, p.due)}`))}, as ClickUp's dependency rescheduling does)` : '';
  return `${whose}${c.step.name}${c.owner ? ` given to ${c.owner}` : ''}${c.owner && dated ? ' and' : ''}` +
    (dated ? ` moved to ${span(c.start, c.due)}` : '') + pushed;
}

// The Projects tree with the changed steps as the change would leave them on the cards: a new start moves the due
// date with it, the step keeping its working days; a new owner takes the step (its Team cleared). Only the step moved
// changes: Reschedule Dependencies is off, so the steps that wait on it keep their dates and the Health
// check names any that must move (c.pushed stays empty). The changes are made in the order given, each from where the
// ones before it left the cards. Copies; the shared cards never change.
export function changedTree(tree, changes, env) {
  const changed = new Map();
  const now = (id) => changed.get(id) || tree.byId.get(id);
  const at = (dn) => dn * DAY_MS + 12 * HOUR_MS; // midday UTC: the same calendar day in the workspace's time zone
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  for (const c of changes) {
    const t = { ...now(c.step.id) };
    c.pushed = [];
    if (c.start !== null || c.due !== null) {
      const s0 = dn(t.start);
      const d0 = dn(t.due);
      const length = s0 !== null && d0 !== null ? Math.max(1, workingDaysBetween(s0, d0)) : 1;
      const start = c.start ?? (c.due !== null && s0 !== null && s0 <= c.due ? s0 : c.due);
      const due = c.due ?? addWorkingDays(start, length - 1);
      t.start = at(start);
      t.due = at(due);
      c.movedStart = start; // where the change puts the step, for its fix
      c.movedDue = due;
    }
    if (c.owner) { t.people = [c.owner]; t.teams = []; }
    changed.set(t.id, t);
  }
  return makeTree([...tree.byId.values()].map((t) => changed.get(t.id) || t));
}
// Working days from one day to another (later positive); a day moved by that many working days.
const wdShift = (from, to) => (to === from ? 0 : to > from ? workingDaysBetween(from + 1, to) : -workingDaysBetween(to + 1, from));
function shiftBy(day, k) {
  let d = day;
  for (let i = 0; i < Math.abs(k); i++) {
    d += Math.sign(k);
    while (!isWorkingDay(d)) d += Math.sign(k);
  }
  return d;
}

function dateArg(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new UserError(`"${v}" is not a date for ${name}; use YYYY-MM-DD`);
  return Date.UTC(...String(v).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / DAY_MS;
}

// Step hours from finished jobs like this one: the average hours logged on that step across finished jobs of
// the same job type at the same price (the same package), else of the same job type; three jobs at least.
function historySizes(tree, entries, jobType, price) {
  const onTask = new Map();
  for (const e of entries) if (e.task) onTask.set(e.task, (onTask.get(e.task) || 0) + e.hours);
  const pool = (samePrice) => {
    const sizes = new Map();
    for (const u of tree.units) {
      if (!u.closed || isTest(u) || u.f['Job type'] !== jobType || (samePrice && num(u.f.Price) !== price)) continue;
      for (const k of tree.kids(u.id)) {
        if (!STEP_NAMES.includes(k.name)) continue;
        const h = onTask.get(k.id) || 0;
        if (h > 0) sizes.set(k.name, [...(sizes.get(k.name) || []), h]);
      }
    }
    return sizes;
  };
  const exact = price ? pool(true) : new Map();
  const broad = pool(false);
  const out = new Map();
  for (const name of STEP_NAMES) {
    const a = exact.get(name) || [];
    const b = broad.get(name) || [];
    if (a.length >= 3) out.set(name, { hours: Math.round(4 * sum(a) / a.length) / 4, note: `the average of ${a.length} finished ${jobType} jobs at ${money(price)}` });
    else if (b.length >= 3) out.set(name, { hours: Math.round(4 * sum(b) / b.length) / 4, note: `the average of ${b.length} finished ${jobType} jobs` });
  }
  return out;
}

// Deliver's sign-off window is always the 3-day allowance: the client's record is advice only and never changes a
// number. The client's average sign-off time over its last six finished projects is given as advice.
export function signOffFor(tree, card, env) {
  const ref = (card.f.Client || [])[0];
  const name = ref?.name ?? 'the client';
  const done = ref ? tree.units.filter((u) => u.closed && !isTest(u) && isFor(u, { id: ref.id }))
    .sort((a, b) => (delivered(b) || 0) - (delivered(a) || 0)).slice(0, 6) : [];
  const days = done.map((u) => {
    const field = num(u.f['Sign-off days']);
    if (field !== null) return field;
    const d = tree.kids(u.id).find((s) => s.name === 'Deliver');
    return d?.start && d?.due ? days_(d.start, d.due, env) - (d.estimate || 0) / 8 : null;
  }).filter((x) => x !== null);
  const allowance = `the ${SIGN_OFF_ALLOWANCE}-day allowance`;
  if (days.length < 2) return { days: SIGN_OFF_ALLOWANCE, note: allowance, advice: `no client record yet for ${name}`, average: null, projects: days.length };
  const avg = sum(days) / days.length;
  const longer = avg > SIGN_OFF_ALLOWANCE;
  return { days: SIGN_OFF_ALLOWANCE, note: allowance, average: round1(avg), projects: days.length, longer,
    advice: `${name} averages ${fmt(avg)} days to sign off on its last ${days.length} finished projects${longer ? `, longer than ${allowance}` : ''}` };
}
const days_ = (a, b, env) => dayNumber(b, env) - dayNumber(a, env);

// The agency's package for a card: the row of the Supplier operating agreement for its job type whose price is
// the card's Supplier cost; its turnaround and the revision turnaround for its size.
function agencyFor(terms, jobType, supplierCost) {
  if (!terms || !supplierCost) return null;
  const row = terms.supplier.rows.find((r) => r['Work type'].toLowerCase().split(/,\s*/).includes(String(jobType).toLowerCase())
    && Number(String(r.Price).replace(/[^0-9.]/g, '')) === Number(supplierCost));
  if (!row) return null;
  const size = row.Size.split(' ')[0];
  return { size, turnaround: Number(String(row.Turnaround).replace(/[^0-9]/g, '')) || null, revision: terms.revisions[size.toLowerCase()] ?? null, package: row['What the agency designs'] };
}

async function supplierTerms(env) {
  const pages = await docPages(env, DOCS.supplier);
  const text = pages.map((p) => p.content || '').join('\n');
  const supplier = tables(text).find((t) => t.head.includes('Turnaround'));
  if (!supplier) return null;
  const rev = text.slice(text.indexOf('## Revisions'));
  return { supplier, revisions: Object.fromEntries([...rev.matchAll(/\b(Small|Medium|Large)\s+(\d+)/g)].slice(0, 3).map((m) => [m[1].toLowerCase(), Number(m[2])])) };
}

// The plan for a new request, as Plan new work gives it and as Write plan writes it (one calculation).
export async function planRequestCore(args, env) {
  const [live, entries, terms] = await Promise.all([liveWork(env), timeEntries(env, ...ALL_TIME()), supplierTerms(env)]);
  const pool = [...live.intakeTree.units.filter((u) => !u.closed), ...live.tree.units.filter((u) => !u.closed)];
  let card;
  try { card = matchOne(pool, args.request, 'open request or project'); } catch (e) {
    card = testCard(live.intakeTree, args.request) || testCard(live.tree, args.request);
    if (!card) throw e;
  }
  const tree = live.intakeTree.byId.has(card.id) ? live.intakeTree : live.tree;
  const capPct = Math.min(100, Math.max(10, Number(args.cap_pct ?? 80) || 80));
  const start = Math.max(today(env), dateArg(args.start_date, 'start_date') ?? today(env));
  const jobType = card.f['Job type'] || null;
  const sizes = args.keep_estimates || !jobType ? new Map() : historySizes(live.tree, entries, jobType, num(card.f.Price));
  const agency = agencyFor(terms, jobType, num(card.f['Supplier cost']));
  const signOff = signOffFor(live.tree, card, env);
  const ownSteps = openSteps(tree, card.id);
  const own = bookings(ownSteps, env, live.members);
  const steps = engineSteps(tree, card, live, env, (s) => {
    const sz = sizes.get(s.name);
    const fill = sz ? { hours: sz.hours, sizeNote: `${sz.note}; the card had ${fmt(s.estimate || 0)} h` }
      : s.estimate ? { sizeNote: args.keep_estimates ? 'the estimate on the card' : 'the estimate on the card; no comparable history' }
        : { hours: 0, sizeNote: 'no estimate and no history: a production estimate is needed' };
    if (s.name === 'Design') {
      if (agency?.turnaround) Object.assign(fill, { agencyDays: 1 + agency.turnaround, agencyNote: `one working day to release the brief and the agency's ${agency.turnaround}-working-day turnaround for the ${agency.size.toLowerCase()} package (Supplier operating agreement)` });
      else Object.assign(fill, { agencyNote: 'no package in the Supplier operating agreement matches the card\'s Supplier cost: the step\'s own window' });
    }
    if (s.name === 'Deliver') Object.assign(fill, { signOffDays: signOff.days, signOffNote: signOff.note });
    return fill;
  });
  if (!steps.length) throw new UserError(`${card.name} has no open delivery steps to plan`);
  const requested = num(card.f['Requested date']) !== null ? dayNumber(num(card.f['Requested date']), env) : null;
  const r = schedule({ mode: 'plan', today: start, capPct, capacity: CAPACITY, booked: without(live.booked, own),
    bookedBy: withoutBy(live.bookedBy, new Set(ownSteps.map((s) => s.id))), self: 'this request', steps, requested });
  const key = planKeyOf([card.id, isoDay(start), capPct, !!args.keep_estimates, r.feasible,
    r.plan.map((p) => [p.id, p.start, p.due, p.hours, p.owner])]);
  return { card, tree, live, start, capPct, signOff, agency, requested, r, key };
}

async function planRequest(args, env) {
  const tool = TOOLS.plan_new_work;
  const { card, start, capPct, signOff, agency, requested, r, key } = await planRequestCore(args, env);
  const vs = r.feasible_past_requested === null ? '' : r.feasible_past_requested > 0 ? `, ${against(r.feasible_past_requested, requested, 'the requested date')}, so the requested date cannot be met`
    : `, ${against(r.feasible_past_requested, requested, 'the requested date')}`;
  const sentence = r.send === null
    ? `${card.name}: the plan has no Deliver step; its last step ends ${dayText(r.lands)} (${tool.label}).`
    : `${card.name}: the files can go out ${dayText(r.send)} at the earliest; with two working days of buffer the Feasible date is ${dayText(r.feasible)}${vs} (${tool.label}).`;
  return result(tool, env, {
    lines: [`${card.name}, planned from ${dayText(start)} at ${capPct}% of each person's day and week${args.keep_estimates ? ', with the estimates on the card' : ''}:`,
      ...planLines(r),
      `Deliver's window: the files going out, then ${signOff.note} for the client's sign-off.`,
      `The client's record, advice only (it changes no number in the plan): ${signOff.advice}.`,
      ...(agency ? [`The agency's package: ${agency.package}.`] : []),
      `Plan key ${key}: give it to Write plan, with the same settings, to write this plan.`],
    data: { request: card.name, id: card.id, plan_key: key, cap_pct: capPct, start: isoDay(start), meets_requested: r.feasible_past_requested === null ? null : r.feasible_past_requested <= 0,
      client_sign_off: { average_days: signOff.average, finished_projects: signOff.projects, longer_than_allowance: signOff.longer ?? null, advice: signOff.advice }, ...shape(r) },
    cards: [card.id],
    sentence,
  });
}

// The plan for a rework card, as Plan rework gives it and as Write rework plan writes it (one calculation).
export async function planReworkCore(args, env) {
  const [live, terms] = await Promise.all([liveWork(env), supplierTerms(env)]);
  const reworkCards = [...live.tree.byId.values()].filter((t) => t.parent && !t.closed && /rework/i.test(t.name) && live.tree.hasKids(t.id));
  const rework = matchOne(reworkCards, args.rework, 'open rework card');
  const unit = live.tree.byId.get(live.tree.unitOf(rework.id));
  if (!unit) throw new UserError(`${rework.name} is not under a project`);
  const reworkIds = new Set(live.tree.descendants(rework.id).map((x) => x.id));
  const agency = agencyFor(terms, unit.f['Job type'], num(unit.f['Supplier cost']));
  const r = rewalk(live, unit, env, { terms, fill: (s) => {
    if (!reworkIds.has(s.id)) return {};
    const fill = { sizeNote: s.estimate ? 'its estimate' : 'no estimate: a production estimate is needed' };
    if (s.name.replace(/^Rework: /, '') === 'Design') {
      if (agency?.revision) Object.assign(fill, { agencyDays: agency.revision, agencyNote: `the agency's ${agency.revision}-working-day revision turnaround for a ${agency.size.toLowerCase()} job (Supplier operating agreement)` });
      else Object.assign(fill, { agencyNote: 'no revision turnaround found for this job: the step\'s own window' });
    }
    return fill;
  } });
  const mine = r.plan.filter((p) => reworkIds.has(p.id));
  const key = planKeyOf([rework.id, mine.map((p) => [p.id, p.start, p.due])]);
  return { live, rework, unit, reworkIds, r, mine, key };
}

async function planRework(args, env) {
  const tool = TOOLS.plan_rework;
  const { rework, unit, r, mine, key } = await planReworkCore(args, env);
  const doneBy = mine.length ? Math.max(...mine.map((p) => p.due)) : null;
  const holds = r.send_past_due === null ? null : r.send_past_due <= 0;
  const sentence = `${rework.name} on ${unit.name}: ${doneBy === null ? 'the rework card has no open steps to plan' : `the rework can be done by ${dayText(doneBy)}`}; ` +
    (holds === null ? 'the project has no Due date to check' : holds ? `the project's Due date of ${dayText(r.promise)} still holds: ${sendWords(r)}` : `the project's Due date of ${dayText(r.promise)} does not hold: ${sendWords(r)}`) + ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`${rework.name} on ${unit.name}, planned with the project's other open steps from ${dayText(today(env))} on their remaining hours at 100% of each day (recovery: no windows, the agency's turnaround and the client's sign-off fixed):`,
      ...planLines(r),
      `Plan key ${key}: give it to Write rework plan to write the rework card's dates.`],
    data: { rework: rework.name, id: rework.id, plan_key: key, project: unit.name, project_id: unit.id, rework_done_by: doneBy !== null ? isoDay(doneBy) : null, due_date_holds: holds, ...shape(r) },
    cards: [rework.id, unit.id],
    sentence,
  });
}

// --- the leadership reads: reserve use, work mix, stage flow ------------------------------------------------

const RESERVE = 0.2; // the share of each week Plan the work holds back for rework (it plans to 80%)
const shiftMonth = (m, n) => {
  let [y, mo] = m.split('-').map(Number);
  mo += n;
  while (mo < 1) { mo += 12; y -= 1; }
  while (mo > 12) { mo -= 12; y += 1; }
  return `${y}-${String(mo).padStart(2, '0')}`;
};
const monthName = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 15)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
const monthSpan = (ms) => (ms.length === 1 ? monthName(ms[0]) : `${monthName(ms[0])} to ${monthName(ms.at(-1))}`);
const pc = (x, digits = 0) => `${(100 * x).toFixed(digits)}%`;
const the = (person) => `the ${person.toLowerCase()}`;

function monthsArg(args, env) {
  const check = (m, name) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m))) throw new UserError(`"${m}" is not a month for ${name}; use YYYY-MM`);
    return String(m);
  };
  const now = monthOf(Date.now(), env);
  const asked = args.from_month ? check(args.from_month, 'from_month') : null;
  const to = args.to_month ? check(args.to_month, 'to_month') : asked && asked > now ? asked : now;
  const from = asked ?? shiftMonth(to, -5);
  if (from > to) throw new UserError(`${from} is after ${to}`);
  const out = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}
export function monthCapacity(person, month) {
  const [a, b] = monthBounds(month);
  return ((STEP_WORK_HOURS[person] ?? 0) / 5) * workingDaysBetween(a / DAY_MS, b / DAY_MS - 1);
}
const isRework = (e) => e.labels.some((l) => /^rework/i.test(l));
// Teams and the people outside a Team, each as one group: [{ name, members, team }].
function groups(members, people) {
  const inTeam = new Set();
  const out = [];
  for (const [team, ms] of members) {
    const mine = ms.filter((p) => people.includes(p));
    if (!mine.length) continue;
    mine.forEach((p) => inTeam.add(p));
    out.push({ name: `the ${team} Team`, members: mine, team });
  }
  for (const p of people) if (!inTeam.has(p)) out.push({ name: p, members: [p], team: null });
  return out;
}

async function reserveUse(args, env) {
  const tool = TOOLS.reserve_use;
  const months = monthsArg(args, env);
  const [a] = monthBounds(months[0]);
  const [, b] = monthBounds(months.at(-1));
  const [logged, members, tree] = await Promise.all([timeEntries(env, a - 2 * DAY_MS, b + 2 * DAY_MS), teamMembers(env), projects(env)]);
  const entries = logged.filter((e) => !onTest(e, tree));
  const people = Object.keys(STEP_WORK_HOURS).filter((p) => entries.some((e) => e.person === p));
  const rw = new Map(); // person|month -> rework hours
  for (const e of entries) {
    const m = monthOf(e.start, env);
    if (!e.person || !months.includes(m) || !isRework(e)) continue;
    rw.set(`${e.person}|${m}`, (rw.get(`${e.person}|${m}`) || 0) + e.hours);
  }
  const share = (ps, ms) => {
    const h = sum(ps.flatMap((p) => ms.map((m) => rw.get(`${p}|${m}`) || 0)));
    const c = sum(ps.flatMap((p) => ms.map((m) => monthCapacity(p, m))));
    return { hours: h, capacity: c, share: c ? h / c : 0 };
  };
  const recent = months.slice(-3);
  const rowOf = (name, ps, team = null) => {
    const all = share(ps, months);
    const byMonth = months.map((m) => ({ month: m, ...share(ps, [m]) }));
    const peak = byMonth.reduce((x, y) => (y.share > x.share ? y : x));
    return { name, members: ps, team, rework_hours: round1(all.hours), capacity_hours: round1(all.capacity), share_pct: Math.round(1000 * all.share) / 10,
      last_three_months_pct: Math.round(1000 * share(ps, recent).share) / 10, peak_month: peak.month, peak_pct: Math.round(1000 * peak.share) / 10,
      months: byMonth.map((x) => ({ month: x.month, rework_hours: round1(x.hours), capacity_hours: round1(x.capacity), share_pct: Math.round(1000 * x.share) / 10 })),
      _all: all.share, _last: byMonth.at(-1).share };
  };
  const personRows = people.map((p) => rowOf(p, [p], [...members].find(([, ms]) => ms.includes(p))?.[0] ?? null));
  const teamRows = groups(members, people).filter((g) => g.team).map((g) => rowOf(g.name, g.members, g.team));
  const overall = share(people, months);
  const last = months.at(-1);
  const hi = personRows.reduce((x, y) => (y._last > x._last ? y : x));
  const lo = personRows.reduce((x, y) => (y._all < x._all ? y : x));
  const sentence = `Rework uses ${pc(overall.share, 1)} of the week against the ${pc(RESERVE)} held back (${monthSpan(months)}); ` +
    `${the(hi.name)}'s ran at ${pc(hi._last)} in ${monthName(last)}` + (lo !== hi ? `, ${the(lo.name)}'s at ${pc(lo._all)} over the ${months.length === 1 ? 'month' : `${['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][months.length] || months.length} months`}` : '') +
    ` (${tool.label}).`;
  const strip = ({ _all, _last, ...r }) => r;
  return result(tool, env, {
    lines: [
      `Rework as a share of the week, ${monthSpan(months)}: ${pc(overall.share, 1)} of ${fmt(overall.capacity)} h of step work (${fmt(overall.hours)} h), against the ${pc(RESERVE)} held back.`,
      'By person (capacity for step work a week): the period; the last three months; month by month:',
      ...personRows.map((r) => `- ${r.name}${r.team ? ` (the ${r.team} Team)` : ''}, ${STEP_WORK_HOURS[r.name]} h: ${r.share_pct}%; ${monthSpan(recent)} ${r.last_three_months_pct}%; ` +
        r.months.map((x) => `${monthName(x.month).slice(0, 3)} ${x.share_pct}%`).join(', ')),
      ...(teamRows.length ? [`Teams: ${teamRows.map((t) => `${t.name} (${t.members.join(', ')}) ${t.share_pct}%, ${monthName(last)} ${t.months.at(-1).share_pct}%`).join('; ')}.`] : []),
      `All, month by month: ${months.map((m) => `${monthName(m).slice(0, 3)} ${pc(share(people, [m]).share, 1)}`).join(', ')}.`,
    ],
    data: { months: { from: months[0], to: last }, reserve_pct: 100 * RESERVE, overall_pct: Math.round(1000 * overall.share) / 10,
      overall_by_month: months.map((m) => ({ month: m, share_pct: Math.round(1000 * share(people, [m]).share) / 10 })),
      people: personRows.map(strip), teams: teamRows.map(strip) },
    sentence,
  });
}

const MIX_KINDS = ['new projects', 'changes', 'retainer pieces', 'client revisions', 'internal rework'];
export function kindOfEntry(e, tree) {
  const label = e.labels.find((l) => /^rework/i.test(l));
  if (label) return /client/i.test(label) ? 'client revisions' : 'internal rework';
  const unitId = e.task && tree.unitOf(e.task);
  if (!unitId) return null;
  const unit = tree.byId.get(unitId);
  if ((unit.parent && isMonth(tree.byId.get(unit.parent) || {})) || unit.f['Agreement type'] === 'Retainer') return 'retainer pieces';
  for (let cur = tree.byId.get(e.task); cur; cur = cur.parent ? tree.byId.get(cur.parent) : null) {
    if (cur.f['Request kind'] === 'Change') return 'changes';
    if (cur.id === unitId) break;
  }
  return 'new projects';
}

async function workMix(args, env) {
  const tool = TOOLS.work_mix;
  const months = monthsArg(args, env);
  const [a] = monthBounds(months[0]);
  const [, b] = monthBounds(months.at(-1));
  const [logged, members, tree] = await Promise.all([timeEntries(env, a - 2 * DAY_MS, b + 2 * DAY_MS), teamMembers(env), projects(env)]);
  const entries = logged.filter((e) => !onTest(e, tree));
  const people = Object.keys(STEP_WORK_HOURS).filter((p) => entries.some((e) => e.person === p));
  const hours = new Map(); // person|kind -> hours
  let unplaced = 0;
  for (const e of entries) {
    if (!e.person || !months.includes(monthOf(e.start, env))) continue;
    const k = kindOfEntry(e, tree);
    if (!k) { unplaced += e.hours; continue; }
    hours.set(`${e.person}|${k}`, (hours.get(`${e.person}|${k}`) || 0) + e.hours);
  }
  const rowOf = (name, ps, team = null) => {
    const by = Object.fromEntries(MIX_KINDS.map((k) => [k, sum(ps.map((p) => hours.get(`${p}|${k}`) || 0))]));
    const total = sum(Object.values(by));
    return { name, members: ps, team, total_hours: round1(total),
      kinds: MIX_KINDS.map((k) => ({ kind: k, hours: round1(by[k]), share_pct: total ? Math.round(1000 * by[k] / total) / 10 : 0 })),
      _share: Object.fromEntries(MIX_KINDS.map((k) => [k, total ? by[k] / total : 0])) };
  };
  const personRows = people.map((p) => rowOf(p, [p], [...members].find(([, ms]) => ms.includes(p))?.[0] ?? null));
  const teamRows = groups(members, people).filter((g) => g.team).map((g) => rowOf(g.name, g.members, g.team));
  // The sentence: the largest share any person gives to work other than new projects, then client revisions' spread.
  const big = personRows.flatMap((r) => MIX_KINDS.filter((k) => k !== 'new projects').map((k) => ({ r, k, v: r._share[k] })))
    .reduce((x, y) => (y.v > x.v ? y : x));
  const cr = personRows.map((r) => ({ r, v: Math.round(100 * r._share['client revisions']) }));
  const hiV = Math.max(...cr.map((x) => x.v));
  const loV = Math.min(...cr.map((x) => x.v));
  const named = (v) => andList(cr.filter((x) => x.v === v).map((x) => `${the(x.r.name)}'s`));
  let sentence = `${monthSpan(months)}: ${pc(big.v)} of ${the(big.r.name)}'s hours go to ${big.k}`;
  if (big.k !== 'client revisions' && hiV > 0) sentence += `; client revisions take ${hiV}% of ${named(hiV)} hours${loV < hiV ? ` and ${loV}% of ${named(loV)}` : ''}`;
  sentence += ` (${tool.label}).`;
  const strip = ({ _share, ...r }) => r;
  return result(tool, env, {
    lines: [`Hours by kind of work, ${monthSpan(months)} (share of each person's logged hours):`,
      ...personRows.map((r) => `- ${r.name}${r.team ? ` (the ${r.team} Team)` : ''}, ${fmt(r.total_hours)} h: ` + r.kinds.map((k) => `${k.kind} ${k.share_pct}%`).join(', ')),
      ...(teamRows.length ? [`Teams: ${teamRows.map((t) => `${t.name}: ${t.kinds.filter((k) => k.hours > 0).map((k) => `${k.kind} ${k.share_pct}%`).join(', ')}`).join('; ')}.`] : []),
      ...(unplaced > 0 ? [`${fmt(unplaced)} h logged on tasks outside the Projects List are not counted.`] : [])],
    data: { months: { from: months[0], to: months.at(-1) }, kinds: MIX_KINDS, people: personRows.map(strip), teams: teamRows.map(strip), hours_not_placed: round1(unplaced) },
    sentence,
  });
}

const FLOW_ORDER = ['Write copy', 'Review copy', 'Design', 'Package files', 'Internal review', 'Deliver'];
const FLOW_ALIAS = { 'Write script': 'Write copy', 'Review script': 'Review copy', 'Produce video': 'Package files' };
const median = (xs) => {
  if (!xs.length) return null;
  const v = [...xs].sort((x, y) => x - y);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

// One finished project's steps in order ({ name, start, due, days: the days hours were logged }): each step's wait
// (working days from when it could start, the working day after the step before it finished or, for a review, that
// day, to its start) and its elapsed working days. A step before it that ran again later (reopened for a slip) is
// read as finished on the last day it logged hours before this step started.
export function flowOf(steps) {
  return steps.map((s, i) => {
    let wait = null;
    if (i > 0) {
      const prev = steps[i - 1];
      let end = prev.due;
      const ranOn = s.name === 'Review copy' ? end > s.start : end >= s.start; // a review starts the day the writing ends
      if (ranOn) { const before = (prev.days || []).filter((d) => d < s.start); if (before.length) end = Math.max(...before); }
      const workable = s.name === 'Review copy' ? end : nextWorkingDay(end + 1);
      wait = s.start >= workable ? workingDaysBetween(workable, s.start) - 1 : 0;
      return { name: s.name, wait, elapsed: workingDaysBetween(s.start, s.due), from: workable };
    }
    return { name: s.name, wait, elapsed: workingDaysBetween(s.start, s.due), from: null };
  });
}
// A finished rework card's pace: the catch is the working day before its first step starts (the fix starts the
// working day after the catch), the fix its last step's due date; working days from one to the other, both counted.
export function paceOf(steps) {
  const first = Math.min(...steps.map((k) => k.start));
  let caught = first - 1;
  while (!isWorkingDay(caught)) caught -= 1;
  const fix = Math.max(...steps.map((k) => k.due));
  return { caught, fix, days: workingDaysBetween(caught, fix) };
}

// Delivery days: working days from kick-off to the send on each finished job, by job type, median and
// mean. jobs: [{ job_type, kickoff, send }] in day numbers.
export function deliveryDays(jobs) {
  const by = new Map();
  for (const j of jobs) {
    if (j.kickoff === null || j.send === null || j.send < j.kickoff) continue;
    const days = j.send > j.kickoff ? workingDaysBetween(j.kickoff + 1, j.send) : 0;
    by.set(j.job_type || '(no job type)', [...(by.get(j.job_type || '(no job type)') || []), days]);
  }
  return [...by].map(([job_type, xs]) => ({ job_type, jobs: xs.length, median_working_days: median(xs), mean_working_days: round1(sum(xs) / xs.length) }))
    .sort((a, b) => a.job_type.localeCompare(b.job_type));
}
// The comments on a card dated inside a span of days, oldest first (the cause of a wait, where one was written).
export function commentsInWindow(comments, from, to, env) {
  return comments.map((c) => ({ text: String(c.comment_text || '').trim(), by: c.user?.username ?? null, day: dayNumber(Number(c.date), env) }))
    .filter((c) => c.text && c.day >= from && c.day <= to).sort((a, b) => a.day - b.day);
}

async function stageFlow(args, env) {
  const tool = TOOLS.stage_flow;
  const jobType = jobTypeArg(args.job_type);
  const per = period(args);
  const [tree, entries] = await Promise.all([projects(env), timeEntries(env, ...ALL_TIME())]);
  const onTask = new Map();
  const daysOn = new Map();
  for (const e of entries) {
    if (!e.task) continue;
    onTask.set(e.task, (onTask.get(e.task) || 0) + e.hours);
    daysOn.set(e.task, [...(daysOn.get(e.task) || []), dayNumber(e.start, env)]);
  }
  const dn = (ms) => dayNumber(ms, env);
  // Finished projects and the finished changes under them (each runs its own steps); retainer pieces left out.
  const changes = [...tree.byId.values()].filter((t) => t.parent && t.closed && t.f['Request kind'] === 'Change' && !isTest(t));
  const done = filterUnits([...finished(tree), ...changes], { jobType, per }, env)
    .filter((u) => !(u.parent && isMonth(tree.byId.get(u.parent) || {})) && u.f['Agreement type'] !== 'Retainer');
  const by = new Map(); // step -> { waits, elapsed, hours }
  const deliveries = []; // { job_type, kickoff, send }
  let longest = null; // the longest single wait: { unit, step, wait, from, start }
  for (const u of done) {
    const steps = tree.kids(u.id).filter((k) => STEP_NAMES.includes(k.name) && k.start && k.due)
      .map((k) => ({ k, name: FLOW_ALIAS[k.name] || k.name, start: dn(k.start), due: dn(k.due), days: daysOn.get(k.id) || [] }))
      .sort((x, y) => x.start - y.start || FLOW_ORDER.indexOf(x.name) - FLOW_ORDER.indexOf(y.name));
    flowOf(steps).forEach((f, i) => {
      const g = by.get(f.name) || { waits: [], elapsed: [], hours: [] };
      g.elapsed.push(f.elapsed);
      g.hours.push(onTask.get(steps[i].k.id) || 0);
      if (f.wait !== null) g.waits.push(f.wait);
      by.set(f.name, g);
      if (f.wait !== null && (!longest || f.wait > longest.wait)) longest = { unit: u, step: steps[i].k, wait: f.wait, from: f.from, start: steps[i].start };
    });
    // Kick-off: the first step's start, or the day the kick-off subtask closed if that was earlier (a subtask closed
    // after the work started, as in imported history, does not move it); the send: Delivered on.
    const kick = tree.kids(u.id).find((k) => k.name === 'Kick off delivery');
    const starts = [...(steps.length ? [steps[0].start] : []), ...(kick?.closedOn ? [dn(kick.closedOn)] : [])];
    const kickoff = starts.length ? Math.min(...starts) : null;
    deliveries.push({ job_type: u.f['Job type'] || null, kickoff, send: delivered(u) ? dn(delivered(u)) : null });
  }
  const deliveryRows = deliveryDays(deliveries);
  // The cause of the longest wait: the first comment on the step or its card written during the wait.
  let cause = null;
  if (longest && longest.wait > 0) {
    const [onStep, onCard] = await Promise.all([clickup(env, `/task/${longest.step.id}/comment`).catch(() => ({ comments: [] })),
      clickup(env, `/task/${longest.unit.id}/comment`).catch(() => ({ comments: [] }))]);
    cause = commentsInWindow([...(onStep.comments || []), ...(onCard.comments || [])], longest.from, longest.start, env)[0] ?? null;
  }
  const longestRow = longest ? { card: longest.unit.name, id: longest.unit.id, step: FLOW_ALIAS[longest.step.name] || longest.step.name, working_days: longest.wait,
    could_start: isoDay(longest.from), started: isoDay(longest.start), cause: cause ? { said: cause.text.slice(0, 300), by: cause.by, on: isoDay(cause.day) } : null } : null;
  const rows = FLOW_ORDER.filter((n) => by.has(n)).map((n) => {
    const g = by.get(n);
    return { step: n, steps: g.elapsed.length, waits_2_plus_pct: g.waits.length ? Math.round(1000 * g.waits.filter((w) => w >= 2).length / g.waits.length) / 10 : null,
      median_wait_working_days: median(g.waits), median_elapsed_working_days: median(g.elapsed), median_hours: round1(median(g.hours) ?? 0),
      kind: n === 'Design' ? "the agency's window" : n === 'Deliver' ? "the files out, then the client's sign-off" : 'Makers' };
  });
  // Rework pace: finished rework cards, catch to the last fix, by kind and by the step the fix starts on.
  const pace = { Internal: [], Client: [] };
  const byLand = new Map();
  for (const c of tree.byId.values()) {
    if (!c.parent || !c.closed || !/rework/i.test(c.name) || !tree.hasKids(c.id)) continue;
    const unit = tree.byId.get(tree.unitOf(c.id));
    if (unit && jobType && unit.f['Job type'] !== jobType) continue;
    const st = tree.kids(c.id).filter((k) => k.start && k.due);
    if (!st.length) continue;
    const kind = (Array.isArray(c.f.Rework) && c.f.Rework[0]) || (/^client/i.test(c.name) ? 'Client' : 'Internal');
    const { fix, days } = paceOf(st.map((k) => ({ start: dn(k.start), due: dn(k.due) })));
    if ((per.from !== null || per.to !== null) && !per.has(fix)) continue;
    (pace[kind] || (pace[kind] = [])).push(days);
    const land = st.reduce((x, y) => (dn(y.start) < dn(x.start) ? y : x)).name.replace(/^Rework: /, '');
    byLand.set(FLOW_ALIAS[land] || land, [...(byLand.get(FLOW_ALIAS[land] || land) || []), days]);
  }
  const makers = rows.filter((r) => r.kind === 'Makers' && r.waits_2_plus_pct !== null);
  const neck = makers.length ? makers.reduce((x, y) => (y.waits_2_plus_pct > x.waits_2_plus_pct ? y : x)) : null;
  const others = makers.filter((r) => r !== neck);
  const otherMax = others.length ? Math.max(...others.map((r) => r.waits_2_plus_pct)) : null;
  const design = rows.find((r) => r.step === 'Design');
  const deliver = rows.find((r) => r.step === 'Deliver');
  const mi = median(pace.Internal);
  const mc = median(pace.Client);
  const scope = scopeWords(null, jobType, per).replace(/^All clients/, 'Finished projects and changes');
  let sentence = `${scope}: `;
  sentence += neck ? `${neck.step} is the bottleneck, where ${Math.round(neck.waits_2_plus_pct)}% of jobs wait two working days or more to start, against ${otherMax === null || Math.round(otherMax) === 0 ? 'almost none at any other Makers step' : `at most ${Math.round(otherMax)}% at any other Makers step`}` : 'no Makers step to read';
  if (design || deliver) sentence += `; the long waits are outside Makers: ${[design ? `the agency's Design window, a median ${fmt(design.median_elapsed_working_days)} working days` : null, deliver ? `Deliver with the client's sign-off, ${fmt(deliver.median_elapsed_working_days)}` : null].filter(Boolean).join(', and ')}`;
  if (mi !== null && mc !== null) sentence += `; our own redos take a median ${fmt(mi)} working days from catch to fix, a client's changes ${fmt(mc)}`;
  if (longestRow && longestRow.working_days > 0) sentence += `; the longest single wait was ${longestRow.step} on ${longestRow.card}, ${longestRow.working_days} working days${longestRow.cause ? ` (a comment then: "${longestRow.cause.said.slice(0, 120)}")` : ', with no comment giving a cause'}`;
  sentence += ` (${tool.label}).`;
  return result(tool, env, {
    lines: [`${scope}, ${done.length} of them, step by step (the wait: working days from when a step could start to its start):`,
      ...rows.map((r) => `- ${r.step} (${r.kind}), ${r.steps} steps: ${r.waits_2_plus_pct === null ? 'first step' : `${r.waits_2_plus_pct}% wait 2+ working days (median ${fmt(r.median_wait_working_days)})`}; ` +
        `median ${fmt(r.median_elapsed_working_days)} working days elapsed for a median ${fmt(r.median_hours)} h logged`),
      `Rework pace, catch to the last fix (working days, median): internal ${mi === null ? '-' : fmt(mi)} (n ${pace.Internal.length}), client ${mc === null ? '-' : fmt(mc)} (n ${pace.Client.length}); ` +
        `by the step the fix starts on: ${[...byLand].map(([k, v]) => `${k} ${fmt(median(v))} (n ${v.length})`).join(', ')}.`,
      ...(neck ? [`The bottleneck: ${neck.step}, ${neck.waits_2_plus_pct}% of steps wait 2+ working days.`] : []),
      'Kick-off to the send, working days, by job type: ' + (deliveryRows.map((r) => `${r.job_type} median ${fmt(r.median_working_days)}, mean ${fmt(r.mean_working_days)} (n ${r.jobs})`).join('; ') || 'no finished jobs') + '.',
      ...(longestRow ? [`The longest single wait: ${longestRow.step} on ${longestRow.card}, ${longestRow.working_days} working days (could start ${longestRow.could_start}, started ${longestRow.started}); ${longestRow.cause ? `a comment then, by ${longestRow.cause.by} on ${longestRow.cause.on}: "${longestRow.cause.said}"` : 'no comment on the step or its card gives a cause'}.`] : [])],
    data: { job_type: jobType, projects: done.length, steps: rows,
      rework_pace: { internal: { median_working_days: mi, n: pace.Internal.length }, client: { median_working_days: mc, n: pace.Client.length },
        by_step: [...byLand].map(([step, v]) => ({ step, median_working_days: median(v), n: v.length })) },
      bottleneck: neck ? neck.step : null, delivery_days_by_job_type: deliveryRows, longest_wait: longestRow },
    sentence,
  });
}

// --- price and terms ---------------------------------------------------------------------------------------

function tables(markdown) {
  const out = [];
  let cur = null;
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) { cur = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^-*$/.test(c))) continue;
    if (!cur) { cur = { head: cells, rows: [] }; out.push(cur); continue; }
    cur.rows.push(Object.fromEntries(cur.head.map((h, i) => [h, cells[i] ?? ''])));
  }
  return out;
}

async function priceAndTerms(args, env) {
  const tool = TOOLS.price_and_terms;
  const jobType = jobTypeArg(args.job_type);
  if (!jobType) throw new UserError('Name a job type');
  const size = args.size ? String(args.size).toLowerCase() : null;
  const [pricePages, supplierPages] = await Promise.all([docPages(env, DOCS.prices), docPages(env, DOCS.supplier)]);
  const prices = tables(pricePages.map((p) => p.content || '').join('\n')).find((t) => t.head.includes('Price') && t.head.includes('Job type'));
  const supplierText = supplierPages.map((p) => p.content || '').join('\n');
  const supplier = tables(supplierText).find((t) => t.head.includes('Turnaround'));
  if (!prices) throw new UserError('The Makers price list Doc has no price table that can be read');
  if (!supplier) throw new UserError('The Supplier operating agreement Doc has no price table that can be read');
  const revSection = supplierText.slice(supplierText.indexOf('## Revisions'));
  const revisions = Object.fromEntries([...revSection.matchAll(/\b(Small|Medium|Large)\s+(\d+)/g)].slice(0, 3).map((m) => [m[1].toLowerCase(), Number(m[2])]));
  const ours = prices.rows.filter((r) => r['Job type'].toLowerCase() === jobType.toLowerCase() && (!size || r.Size.toLowerCase().startsWith(size)));
  if (!ours.length) throw new UserError(`The Makers price list has no ${size ? `${size} ` : ''}${jobType} row`);
  const rows = ours.map((r) => {
    const sz = r.Size.split(' ')[0];
    const agency = supplier.rows.find((s) => s['Work type'].toLowerCase().split(/,\s*/).includes(jobType.toLowerCase())
      && (s.Size.toLowerCase().startsWith(sz.toLowerCase()) || s.Size.toLowerCase() === 'none'));
    const inHouse = !agency || agency.Size.toLowerCase() === 'none' || /^\$?0$/.test(agency.Price);
    return {
      job_type: jobType, size: sz, what_the_client_gets: r['What the client gets'], price: r.Price, guide_hours: Number(r['Our hours (guide)']) || null,
      client_rounds: Number(r['Client rounds']) || null,
      agency: inHouse ? null : { package: agency['What the agency designs'], fee: agency.Price, turnaround: agency.Turnaround, rounds: Number(agency.Rounds) || null,
        revision_turnaround_working_days: revisions[sz.toLowerCase()] ?? null },
    };
  });
  let sentence;
  if (rows.length === 1) {
    const r = rows[0];
    sentence = `${r.size} ${jobType.toLowerCase()}: we charge ${r.price} for ${r.guide_hours} guide hours and ${r.client_rounds} client round${r.client_rounds === 1 ? '' : 's'}; ` +
      (r.agency ? `the agency's part costs ${r.agency.fee} with a ${r.agency.turnaround.replace(/^(\d+) days?$/, '$1-working-day')} turnaround` : 'made in-house, so no agency fee') + ` (${tool.label}).`;
  } else {
    const list = (f) => rows.map((r) => `${f(r)} (${r.size.toLowerCase()})`).join(', ').replace(/, ([^,]*)$/, ' and $1');
    sentence = `${jobType}: we charge ${list((r) => r.price)}; ` + (rows.some((r) => r.agency) ? `the agency's part costs ${list((r) => (r.agency ? r.agency.fee : 'nothing'))}` : 'made in-house, so no agency fee') + ` (${tool.label}).`;
  }
  return result(tool, env, {
    lines: rows.map((r) => `${r.job_type}, ${r.size}: ${r.what_the_client_gets}. We charge ${r.price}; guide hours ${r.guide_hours}; client rounds ${r.client_rounds}. ` +
      (r.agency ? `Agency: ${r.agency.package}; fee ${r.agency.fee}; turnaround ${r.agency.turnaround}; ${r.agency.rounds} rounds; a revision round ${r.agency.revision_turnaround_working_days ?? '-'} working days.` : 'Made in-house: no agency fee.')),
    data: { job_type: jobType, size: args.size ?? null, rows },
    sentence,
  });
}

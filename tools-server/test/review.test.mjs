// Unit tests for the leadership reporting reads: margin by group, delivery days and the longest wait,
// the capacity what-if, rework tag completeness, the two pilot reads from the comments, and the monthly review.
// Hand-built cards and answers with known results; no ClickUp.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { marginGroups, deliveryDays, commentsInWindow, capacityReplay, reworkCompleteness, warningOf, completeOf, marginKnown, reviewOf, accuracyByStep, usageTrend, OUTCOMES, commentTime, retainerFigures, requestCards } from '../tools.js';
import { makeTree, today, nextWorkingDay, addWorkingDays, bookings, bookingsBy, isoDay, period, DAY_MS } from '../data.js';

const env = { TIME_ZONE: 'UTC' };
const D = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;
const at = (y, m, d) => Date.UTC(y, m - 1, d, 12);

test('margin by client, job type or agreement type, lowest margin first; the client field only when grouped by client', () => {
  const items = [
    { id: 'a', client: 'Client K', job_type: 'Print', agreement: 'Fixed fee', kind: 'projects', price: 1000, cost: 600 },
    { id: 'b', client: 'Client K', job_type: 'Web', agreement: 'Fixed fee', kind: 'projects', price: 2000, cost: 800 },
    { id: 'c', client: 'Client Q', job_type: 'Print', agreement: 'Fixed fee', kind: 'projects', price: 1000, cost: 300 },
    { id: 'm', client: 'Client B', job_type: null, agreement: 'Retainer', kind: 'retainer_months', price: 2600, cost: 1300 },
  ];
  assert.deepEqual(marginGroups(items, 'client').map((r) => [r.client, r.margin, r.margin_pct, r.projects, r.retainer_months]),
    [['Client K', 1600, 53, 2, 0], ['Client B', 1300, 50, 0, 1], ['Client Q', 700, 70, 1, 0]].sort((a, b) => a[2] - b[2]));
  assert.deepEqual(marginGroups(items, 'job_type').map((r) => [r.group, r.margin_pct]), [['(no job type)', 50], ['Print', 55], ['Web', 60]]);
  assert.deepEqual(marginGroups(items, 'agreement_type').map((r) => [r.group, r.margin_pct]), [['Retainer', 50], ['Fixed fee', 58]]);
  assert.equal('client' in marginGroups(items, 'job_type')[0], false);
});

test('delivery days: working days from kick-off to the send, by job type, median and mean; a send before kick-off is left out', () => {
  const rows = deliveryDays([
    { job_type: 'Print', kickoff: D(2026, 11, 2), send: D(2026, 11, 13) }, // Tue 3 to Fri 13: 9
    { job_type: 'Print', kickoff: D(2026, 11, 2), send: D(2026, 11, 6) }, // 4
    { job_type: 'Print', kickoff: D(2026, 11, 20), send: D(2026, 11, 30) }, // Mon 23, Tue 24, Wed 25, Mon 30 (26 and 27 holidays): 4
    { job_type: 'Web', kickoff: D(2026, 11, 2), send: D(2026, 11, 2) }, // the same day: 0
    { job_type: 'Web', kickoff: D(2026, 11, 9), send: D(2026, 11, 2) }, // a send before its kick-off: left out
  ]);
  assert.deepEqual(rows, [{ job_type: 'Print', jobs: 3, median_working_days: 4, mean_working_days: 5.7 }, { job_type: 'Web', jobs: 1, median_working_days: 0, mean_working_days: 0 }]);
});

test('the cause of a wait: the comments written during it, oldest first', () => {
  const c = (text, y, m, d, by = 'Account lead') => ({ comment_text: text, user: { username: by }, date: String(at(y, m, d)) });
  const got = commentsInWindow([c('after it', 2026, 10, 20), c('Waiting on the client for the final logo', 2026, 10, 7), c('before it', 2026, 9, 1),
    c('Logo arrived', 2026, 10, 9, 'Creative lead')], D(2026, 10, 5), D(2026, 10, 12), env);
  assert.deepEqual(got.map((x) => [x.text, x.by, isoDay(x.day)]), [['Waiting on the client for the final logo', 'Account lead', '2026-10-07'], ['Logo arrived', 'Creative lead', '2026-10-09']]);
});

// A live picture on hand-built cards, dated from today (the replay reads today's date).
const t0 = nextWorkingDay(today(env));
const job = (id, client, due, status = 'to do') => ({ id, name: `${client}: launch`, parent: null, type: 0, status, closed: false, start: null, due: due * DAY_MS,
  estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f: { Client: [{ id: `c${id}`, name: client }], 'Agreement type': 'Fixed fee', Budget: 2000, Rate: 65 } });
const st = (id, parent, name, owner, hours, start, due, waitsOn = []) => ({ id, name, parent, type: 0, status: 'to do', closed: false, start: start * DAY_MS, due: due * DAY_MS,
  estimate: hours, tracked: 0, people: [owner], teams: [], waitsOn, f: {} });
const liveOf = (tasks) => {
  const tree = makeTree(tasks);
  const steps = tasks.filter((t) => t.parent);
  const label = (s) => `${tree.byId.get(s.parent).f.Client[0].name}'s ${s.name}`;
  return { tree, intakeTree: makeTree([]), members: new Map(), steps, unitOfStep: new Map(steps.map((s) => [s.id, tree.byId.get(s.parent)])),
    booked: bookings(steps, env, new Map()), bookedBy: bookingsBy(steps, env, new Map(), label) };
};

test('the capacity what-if: more studio hours bring a job\'s send earlier; the weeks and the new work that fits, now and as asked', () => {
  // A's and B's 8 h of files are both planned on day d: at 40 h a week (8 h a day) one waits a day; at 80 h both fit d.
  const d = addWorkingDays(t0, 3);
  const tasks = [job('a', 'Client A', addWorkingDays(d, 1)), job('b', 'Client B', addWorkingDays(d, 1)),
    st('apf', 'a', 'Package files', 'Studio', 8, d, d), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['apf']),
    st('bpf', 'b', 'Package files', 'Studio', 8, d, d), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['bpf'])];
  const r = capacityReplay(liveOf(tasks), env, { owners: ['Studio'], hours: 80, weeks: 2 });
  assert.deepEqual(r.moved.map((m) => [m.card, m.working_days, m.late_before, m.late_after]), [['Client A: launch', -1, true, false], ['Client B: launch', -1, true, false]]);
  assert.equal(r.weeks.length, 2);
  const booked = r.weeks.reduce((a, w) => a + w.booked, 0);
  assert.equal(booked, 16);
  const days = r.weeks.reduce((a, w) => a + w.hours_now, 0) / 8; // working days in the two weeks
  assert.equal(r.fits_now, Math.round((days * 8 * 0.8 - 16) * 10) / 10);
  assert.equal(r.fits_asked, Math.round((days * 16 * 0.8 - 16) * 10) / 10);
});

test('rework tag completeness: rework steps with time logged, and those with no entry carrying a cause tag', () => {
  const e = (hours, ...labels) => ({ hours, labels });
  assert.deepEqual(reworkCompleteness([{ id: 'a', entries: [e(2, 'rework: client')] }, { id: 'b', entries: [e(1.5), e(0.5)] }, { id: 'c', entries: [] },
    { id: 'd', entries: [e(1), e(1, 'rework: internal')] }]), { rework_steps_with_time: 3, without_cause_tag: 1, untagged_hours: 2 });
});

const comment = (by, text, y, m, d) => ({ user: { username: by }, comment_text: text, date: String(at(y, m, d)) });

test('days of warning: the Planner\'s first flag (At risk, Off track, or "will send N working days late") against the Due date; the share of finished flagged jobs still on time; too little history said', () => {
  const card = (id, due, extra = {}) => ({ id, name: `Client ${id}: job`, due: at(...due), closed: false, f: {}, ...extra });
  const cards = [card('P', [2026, 11, 19]), card('Q', [2026, 11, 5], { closed: true, f: { 'Late by': 0 } }), card('R', [2026, 11, 10], { closed: true, f: { 'Late by': 2 } }), card('S', [2026, 11, 20]),
    card('T', [2026, 11, 25])];
  const comments = new Map([
    // the Health check Skill's Line 1 for a late job carries no verdict word: its lateness phrase is a flag
    ['P', [comment('Delivery Planner', '@Delivery lead, Client P will send 1 working day late (Fri 20 Nov, due Thu 19 Nov): Package files waits on Studio.', 2026, 11, 2),
      comment('Delivery Planner', 'Client P is back On track.', 2026, 11, 3)]],
    ['Q', [comment('Account lead', 'At risk? I think not.', 2026, 10, 20), comment('Delivery Planner', 'At risk: Write copy is due today.', 2026, 10, 29)]],
    ['R', [comment('Delivery Planner', 'Client R remains Off track on cost.', 2026, 11, 2)]],
    ['S', [comment('Delivery Planner', 'Client S is now On track: nothing goes late.', 2026, 11, 2)]],
    // "late" alone is not a flag: a plan comment and an "is now on time" note
    ['T', [comment('Delivery Planner', 'Plan, first run. The send is Fri 20 Nov; Package files would run late if Studio slips.', 2026, 11, 2),
      comment('Delivery Planner', 'Client T is now on time: the earlier late forecast is clear.', 2026, 11, 3)]],
  ]);
  const r = warningOf(cards, comments, env);
  assert.deepEqual(r.flagged.map((x) => [x.card, x.flagged_on, x.days_of_warning, x.finished, x.on_time]), [
    ['Client Q: job', '2026-10-29', 5, true, true], ['Client P: job', '2026-11-02', 13, false, null], ['Client R: job', '2026-11-02', 6, true, false]]);
  assert.equal(r.median_working_days, 6);
  assert.deepEqual([r.finished, r.still_on_time, r.share_on_time], [2, 1, 50]);
  assert.deepEqual(r.enough, { days: false, share: false, clear: false });
});

test('days to clear: from the first flag to the first later On track, or to the send if it went out first; none while still open', () => {
  const P = 'Delivery Planner';
  const card = (id, due, send, extra = {}) => ({ id, name: `Client ${id}: job`, due: at(...due), send: at(...send), closed: false, f: {}, ...extra });
  const cards = [
    card('A', [2026, 11, 19], [2026, 11, 17]),
    card('B', [2026, 11, 12], [2026, 11, 10], { f: { 'Late by': 0 } }),
    card('C', [2026, 11, 5], [2026, 11, 9]),
    card('E', [2026, 12, 4], [2026, 12, 2]),
  ];
  const comments = new Map([
    // cleared before the send: back On track Thu 5 Nov, three working days after the flag (a later At risk is no clear)
    ['A', [comment(P, 'At risk: Package files waits on Studio.', 2026, 11, 2), comment(P, 'Health check: At risk. Still waiting on Studio.', 2026, 11, 3),
      comment(P, 'Health improved to On track; the earlier flag is clear.', 2026, 11, 5)]],
    // never cleared before the send (On track came the day after it), sent on time by Late by: flag to the send, six working days
    ['B', [comment(P, 'Off track on cost: headroom -$240.', 2026, 11, 2), comment(P, 'Client B remains Off track on cost.', 2026, 11, 4),
      comment(P, 'Health check: On track.', 2026, 11, 11)]],
    // never cleared, sent Mon 9 Nov after its Thu 5 Nov Due date: late, five working days to the send
    ['C', [comment(P, 'Off track: Client C will send 2 working days late.', 2026, 11, 2)]],
    // still open: not cleared, its send still ahead
    ['E', [comment(P, 'At risk: no owner on Write copy.', 2026, 11, 16)]],
  ]);
  const r = warningOf(cards, comments, env, { todayDn: D(2026, 11, 20) });
  assert.deepEqual(r.flagged.map((x) => [x.card, x.flagged_on, x.days_of_warning, x.back_on_track_on, x.send_date, x.days_to_clear, x.outcome]), [
    ['Client A: job', '2026-11-02', 13, '2026-11-05', '2026-11-17', 3, OUTCOMES.cleared],
    ['Client B: job', '2026-11-02', 8, '2026-11-11', '2026-11-10', 6, OUTCOMES.sentOnTime],
    ['Client C: job', '2026-11-02', 3, null, '2026-11-09', 5, OUTCOMES.sentLate],
    ['Client E: job', '2026-11-16', 12, null, '2026-12-02', null, OUTCOMES.open]]); // the send still planned
  assert.deepEqual([r.median_working_days, r.median_days_to_clear], [10, 5]); // 3, 8, 12, 13; and 3, 5, 6
  assert.deepEqual(r.outcomes, { [OUTCOMES.cleared]: 1, [OUTCOMES.sentOnTime]: 1, [OUTCOMES.sentLate]: 1, [OUTCOMES.open]: 1 });
  assert.equal(r.enough.clear, false); // three jobs with days to clear: too little history
  // from and to choose jobs by the day of their first flag
  assert.deepEqual(warningOf(cards, comments, env, { todayDn: D(2026, 11, 20), per: period({ from: '2026-11-10' }) }).flagged.map((x) => x.card), ['Client E: job']);
});

test('requests arriving complete: the Intake Advisor\'s first comment, complete when no line says "missing", by month', () => {
  const comments = new Map([
    ['a', [comment('Intake Advisor', 'Client: Client D.\nInputs: product photos present; usage rights present.', 2026, 10, 30), comment('Intake Advisor', 'Still missing nothing.', 2026, 11, 2)]],
    ['b', [comment('Intake Advisor', 'Client: Client J.\nInputs: brand files missing; photos promised Fri.', 2026, 11, 2)]],
    ['c', [comment('Account lead', 'Missing the logo?', 2026, 11, 2)]],
    ['d', [comment('Intake Advisor', 'Client: Client B.\nInputs: all present.', 2026, 11, 3)]],
    ['e', [comment('Intake Advisor', 'Client: Client D.\nBrand files: new files not attached.', 2026, 11, 3)]],
    ['f', [comment('Intake Advisor', 'Client: Client J.\nInputs: usage rights not received yet.', 2026, 11, 4)]],
  ]);
  const r = completeOf(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: `Request ${id}` })), comments, env);
  // "missing", "not attached" and "not received" all count as something missing
  assert.deepEqual(r.rows, [{ month: '2026-10', complete: 1, requests: 1, share_pct: 100 }, { month: '2026-11', complete: 1, requests: 4, share_pct: 25 }]);
  assert.equal(r.enough, false);
});

test('margin known while the job runs: live fixed-fee jobs with a Budget and a Rate; live retainer pieces whose month card has a Budget', () => {
  const card = (id, extra) => ({ id, name: id, parent: null, type: 0, status: 'in progress', closed: false, start: null, due: null, estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f: {}, ...extra });
  const tree = makeTree([card('a', { f: { 'Agreement type': 'Fixed fee', Budget: 1000, Rate: 65 } }), card('b', { f: { 'Agreement type': 'Fixed fee', Budget: null, Rate: 65 } }),
    card('m', { name: 'Retainer month: Client B, November 2026', f: { Budget: 2600 } }), card('p', { parent: 'm', f: { 'Agreement type': 'Retainer' } }),
    card('x', { status: 'complete', closed: true, f: { 'Agreement type': 'Fixed fee' } })]);
  assert.deepEqual(marginKnown(tree), { known: 2, live: 3 });
});

test('estimate accuracy by step dates a step by the last day time was logged on it, before its close date', () => {
  const s = (id, closedOn) => ({ id, name: 'Write copy', parent: 'u', type: 0, status: 'complete', closed: true, start: null, due: null, closedOn, estimate: 2, tracked: 3, people: ['Copywriter'], teams: [], waitsOn: [], f: {} });
  const tree = makeTree([{ id: 'u', name: 'Client A: job', parent: null, type: 0, status: 'complete', closed: true, start: null, due: null, estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f: { Client: [{ id: 'ca', name: 'Client A' }] } },
    s('w1', at(2026, 10, 28)), s('w2', at(2026, 10, 28))]);
  const lastDay = new Map([['w1', D(2026, 9, 15)]]); // w1 was worked in September and closed on the day its history was imported
  const oct = accuracyByStep(tree, { groupBy: 'month', per: period({ from: '2026-10-01', to: '2026-10-31' }), lastDay }, env);
  assert.equal(oct.totals.steps, 1);
  assert.deepEqual(accuracyByStep(tree, { groupBy: 'month', lastDay }, env).rows.map((r) => r.group).sort(), ['2026-09', '2026-10']);
});

test('the monthly review: every section with its sentence and the calls its figures came from, and the five pilot KPIs', async () => {
  const calls = [];
  const answers = {
    on_time_rate: (a) => (a.group_by === 'month' ? { rows: [{ group: '2026-10', on_time: 9, finished: 10, share: 90 }], summary: 'months' }
      : { rows: [{ group: 'Print', on_time: 9, finished: 10, share: 90 }], on_time: 9, finished: 10, summary: 'October: 9 of 10 on time (on time rate).' }),
    margin_by_client: (a) => ({ rows: [{ group: a.group_by, margin_pct: 50 }], total: { price: 10, cost: 5 }, summary: `margin by ${a.group_by} (margin by client).` }),
    rework_by_cause: (a) => ({ rows: [{ group: a.group_by }], totals: {}, completeness: { rework_steps_with_time: 4, without_cause_tag: 1 }, summary: `rework by ${a.group_by} (rework by cause).` }),
    estimate_accuracy_by_step: (a) => ({ rows: [{ group: a.group_by }], totals: {}, summary: `accuracy by ${a.group_by} (estimate accuracy by step).` }),
    stage_flow: () => ({ steps: [], bottleneck: 'Package files', delivery_days_by_job_type: [{ job_type: 'Print', jobs: 2, median_working_days: 15, mean_working_days: 15 }], longest_wait: null, summary: 'waits (stage flow).' }),
    reserve_use: () => ({ overall_pct: 8.6, teams: [], people: [], summary: 'reserve (reserve use).' }),
    work_mix: () => ({ teams: [], people: [{ total_hours: 100, kinds: [{ kind: 'client revisions', hours: 6 }, { kind: 'internal rework', hours: 4 }] }], summary: 'mix (work mix).' }),
    days_of_warning: () => ({ flagged: [{}, {}], flagged_total: 2, median_working_days_of_warning: 13, median_working_days_to_clear: 4, flagged_finished: 1, still_sent_on_time: 1,
      outcomes: { [OUTCOMES.cleared]: 1, [OUTCOMES.sentOnTime]: 0, [OUTCOMES.sentLate]: 0, [OUTCOMES.open]: 1 }, enough_history: false, enough_history_to_clear: false, summary: 'warning' }),
    requests_arriving_complete: () => ({ complete: 3, requests: 4, enough_history: false, summary: 'requests' }),
    retainer_usage: (a) => ({ client: a.client, allowance: 40, hours_logged: 30, used_pct: 75, summary: 'usage' }),
  };
  const call = async (name, a) => { calls.push([name, a]); return answers[name](a); };
  const r = await reviewOf('2026-10', call, { retainerClients: ['Client B'], margin_known: { known: 9, live: 10 } });
  assert.deepEqual([r.from, r.to], ['2026-10-01', '2026-10-31']);
  // the pilot's warnings are the month's: every warning opened in it
  assert.deepEqual(calls.find(([n]) => n === 'days_of_warning')[1], { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.sections.map((s) => s.section), ['On time', 'Margin, finished work', 'Rework', 'Estimate accuracy', 'Delivery days', 'Where work waits',
    'Reserve use', 'Work mix', 'Retainer usage', 'Pilot KPIs']);
  assert.equal(r.sections[0].sentence, 'October: 9 of 10 on time (on time rate).');
  assert.deepEqual(r.sections[0].sources, [{ tool: 'on_time_rate', args: { group_by: 'month', from: '2026-05-01', to: '2026-10-31' } },
    { tool: 'on_time_rate', args: { group_by: 'job_type', from: '2026-10-01', to: '2026-10-31' } }]);
  assert.deepEqual(r.sections[1].sources.map((s) => s.args.group_by), ['client', 'job_type', 'agreement_type']);
  assert.equal(r.sections[1].sources[0].args.state, 'finished');
  assert.deepEqual(r.sections[2].figures.completeness, { rework_steps_with_time: 4, without_cause_tag: 1 });
  assert.equal(r.sections[4].sentence, 'October, kick-off to the send on finished jobs: Print a median 15 working days (n 2); the longest is Print (stage flow).');
  assert.equal(r.sections[8].sentence, 'October, retainer hours used against the allowance: Client B 75% (30 of 40 h) (retainer usage).');
  assert.deepEqual(r.sections[9].figures.kpis.map((k) => [k.kpi, k.value]), [['% delivered on time', 90], ['days of warning', 13], ['days to clear', 4],
    ['internal rework share of hours', 4], ['client revision share of hours (under estimates)', 6], ['margin known while the job runs (live jobs today)', 90],
    ['requests arriving complete', 75]]);
  assert.match(r.sections[9].figures.kpis[4].detail, /^6 of 100 h logged: the client's changes, an estimate and pricing figure, not counted as rework$/);
  assert.match(r.sections[9].sentence, /days of warning 13 working days \(median\) \(too little history\); days to clear 4 working days \(median\) \(too little history\)/);
  assert.equal(r.sections[9].figures.kpis[2].detail, '1 cleared before the send, 0 sent without clearing, 1 still open');
  assert.equal(calls.length, 2 + 3 + 3 + 3 + 1 + 1 + 1 + 1 + 1 + 1); // every read once, the retainer client's usage included
});

test('the retainer usage trend: the last three finished months\' average usage minus the three before, in points; none under six months', () => {
  const months = [['2026-04', 40], ['2026-05', 70], ['2026-06', 75], ['2026-07', 78], ['2026-08', 90], ['2026-09', 95], ['2026-10', 94.5]].map(([month, used_pct]) => ({ month, used_pct }));
  const t = usageTrend(months);
  assert.deepEqual(t, { points: 18.9, last_three_avg_pct: 93.2, previous_three_avg_pct: 74.3, last_three: ['2026-08', '2026-09', '2026-10'], previous_three: ['2026-05', '2026-06', '2026-07'] });
  assert.equal(usageTrend(months.slice(0, 5)), null);
});

test('a comment that opens with a date is read on that date (imported history); any other on the day it was posted', () => {
  const posted = (text) => comment('Delivery Planner', text, 2026, 10, 28); // the day the history was imported
  assert.equal(new Date(commentTime(posted('Health check, 12 June 2026: At risk.'))).toISOString().slice(0, 10), '2026-06-12');
  assert.equal(new Date(commentTime(posted('Received 3 June 2026: Inputs: all present.'))).toISOString().slice(0, 10), '2026-06-03');
  for (const text of ['@Delivery lead, Client P will send 1 working day late (Fri 20 November 2026): Package files.', 'At risk: Write copy is due 12 June 2026: today.', 'At risk: headroom 4%.']) {
    assert.equal(commentTime(posted(text)), at(2026, 10, 28), text); // the agents' own wording: the posting date
  }
});

test('days of warning and requests arriving complete read imported history on its own dates; live comments on their posting dates', () => {
  // Imported history, all posted on the day it was imported, in reverse order: the opening dates decide the order
  // and the days.
  const card = (id, due, extra = {}) => ({ id, name: `Client ${id}: job`, due: at(...due), send: null, closed: false, f: {}, ...extra });
  const P = 'Delivery Planner';
  const imported = new Map([['H', [comment(P, 'Health check, 22 June 2026: On track; the files go out Thu 25 June.', 2026, 10, 28),
    comment(P, 'Health check, 15 June 2026: At risk: Package files waits on Studio.', 2026, 10, 28)]]]);
  const h = warningOf([card('H', [2026, 6, 26])], imported, env, { todayDn: D(2026, 11, 5) }).flagged[0];
  assert.deepEqual([h.flagged_on, h.days_of_warning, h.back_on_track_on, h.days_to_clear], ['2026-06-15', 9, '2026-06-22', 5]);
  // A live flag on the day it was posted.
  const live = warningOf([card('L', [2026, 11, 19])], new Map([['L', [comment(P, 'At risk: no owner on Write copy.', 2026, 11, 2)]]]), env, { todayDn: D(2026, 11, 5) }).flagged[0];
  assert.equal(live.flagged_on, '2026-11-02');
  // Requests: an imported first comment counts in the month it opens with; a live one in the month it was posted.
  const A = 'Intake Advisor';
  const r = completeOf([{ id: 's', name: 'Imported' }, { id: 'n', name: 'Live' }], new Map([
    ['s', [comment(A, 'Received 3 June 2026: Inputs: brand files missing.', 2026, 10, 28)]],
    ['n', [comment(A, 'Client: Client B.\nInputs: all present.', 2026, 11, 3)]]]), env);
  assert.deepEqual(r.rows, [{ month: '2026-06', complete: 0, requests: 1, share_pct: 0 }, { month: '2026-11', complete: 1, requests: 1, share_pct: 100 }]);
});

test('retainer usage is the client\'s hours: a month\'s internal rework chain is left out of used and planned hours, a client rework chain is not', async () => {
  // Client B's October month card: a social calendar piece with 10 h logged on its steps and 2 h still planned; a client
  // rework chain under it (3 h logged, 1 h planned) and an internal rework chain (4 h logged, 2 h planned).
  const monthCard = { id: 'm', name: 'Retainer month: Client B, October 2026', parent: null, type: 1001, status: 'in progress', closed: false,
    due: at(2026, 10, 31), estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f: { Client: [{ id: 'cb', name: 'Client B' }] } };
  const t = (id, name, parent, extra = {}) => ({ id, name, parent, type: 0, status: 'to do', closed: false, start: null, due: null, estimate: 0, tracked: 0,
    people: [], teams: [], waitsOn: [], f: {}, ...extra });
  const tree = makeTree([monthCard,
    t('p', 'Client B: social calendar, October', 'm', { f: { 'Agreement type': 'Retainer', 'Request kind': 'New project' } }),
    t('s1', 'Write copy', 'p', { closed: true, status: 'complete' }), t('s2', 'Design', 'p', { estimate: 2 }),
    t('cr', 'Client rework: social', 'p', { f: { Rework: ['Client'] } }), t('cr1', 'Rework: Design', 'cr', { estimate: 1 }),
    t('ir', 'Internal rework: social', 'p', { f: { Rework: ['Internal'] } }), t('ir1', 'Rework: Design', 'ir', { estimate: 2 }), t('ir2', 'Rework: Package files', 'ir', { closed: true, status: 'complete' })]);
  const e = (task, hours) => ({ task, hours, start: at(2026, 10, 10), labels: [] });
  const r = await retainerFigures(env, tree, { id: 'cb', name: 'Client B' }, '2026-10', [e('s1', 10), e('cr1', 3), e('ir1', 1), e('ir2', 3)]);
  assert.deepEqual([r.hours, r.planned, r.internal_hours], [13, 3, 4]); // 10 + 3 client; 2 + 1 planned; the internal 4 h apart
});

test('a staff comment in the agent\'s dated form counts as the agent\'s; any other staff comment does not; finished requests are read as well as live ones', () => {
  const card = (id, due) => ({ id, name: `Client ${id}: job`, due: at(...due), send: null, closed: false, f: {} });
  // Imported history posted by a staff account: the Planner's dated form counts, flag and clear; a plain staff note does not.
  const staff = 'Studio manager';
  const w = warningOf([card('H', [2026, 6, 26]), card('N', [2026, 6, 26])], new Map([
    ['H', [comment(staff, 'Health check, 15 June 2026: At risk: Package files waits on Studio.', 2026, 10, 28),
      comment(staff, 'Health check, 22 June 2026: On track; the files go out Thu 25 June.', 2026, 10, 28)]],
    ['N', [comment('Account lead', 'At risk? I think the studio is full that week.', 2026, 6, 15)]]]), env, { todayDn: D(2026, 11, 5) });
  assert.deepEqual(w.flagged.map((x) => [x.card, x.flagged_on, x.back_on_track_on]), [['Client H: job', '2026-06-15', '2026-06-22']]);
  // The Advisor's dated form from a staff account counts; a staff note that is not in it is passed over for the Advisor's own.
  const A = 'Intake Advisor';
  const r = completeOf([{ id: 's', name: 'Imported' }, { id: 'm', name: 'Mixed' }], new Map([
    ['s', [comment(staff, 'Received 3 June 2026: Inputs: all present.', 2026, 10, 28)]],
    ['m', [comment('Account lead', 'Received the logo, thanks.', 2026, 11, 1), comment(A, 'Client: Client B.\nInputs: brand files missing.', 2026, 11, 2)]]]), env);
  assert.deepEqual(r.requests.map((x) => [x.card, x.month, x.complete]), [['Imported', '2026-06', true], ['Mixed', '2026-11', false]]);
  // Finished requests too: a closed project card at the top of Projects is read; a retainer piece and a [Test] card are not.
  const p = (id, extra = {}) => ({ id, name: `Client ${id}: job`, parent: null, type: 0, status: 'complete', closed: true, start: null, due: null, estimate: 0,
    tracked: 0, people: [], teams: [], waitsOn: [], f: {}, ...extra });
  const month = p('mo', { name: 'Retainer month: Client B, October 2026', type: 1001 });
  const tree = makeTree([p('done'), p('live', { status: 'in progress', closed: false }), month, p('piece', { parent: 'mo' }), p('t', { name: '[Test] Client Z: job' })]);
  assert.deepEqual(requestCards(makeTree([p('req', { status: 'intake review', closed: false })]), tree).map((c) => c.id), ['req', 'done', 'live']);
});

test('warning episodes: a new warning after an all-clear starts a fresh count; each has its own days of warning and days to clear; a period takes the warnings opened in it; still on time counts each job once', () => {
  const P = 'Delivery Planner';
  const card = (id, due, send, extra = {}) => ({ id, name: `Client ${id}: job`, due: at(...due), send: at(...send), closed: false, f: {}, ...extra });
  // As Client U: Off track 1 Nov, back On track 3 Nov; Off track again 5 Nov (a second warning), back On track the same
  // day once the account lead records the accepted overrun.
  const cards = [card('U', [2026, 11, 25], [2026, 11, 16]), card('F', [2026, 11, 12], [2026, 11, 10], { closed: true, f: { 'Late by': 0 } })];
  const comments = new Map([
    ['U', [comment(P, 'Client U remains Off track on cost: headroom -$240.', 2026, 11, 1), comment(P, 'Client U is On track: all checks clear.', 2026, 11, 3),
      comment(P, 'Client U is Off track on cost: headroom -$240 (-15%).', 2026, 11, 5), comment(P, 'Still Off track on cost.', 2026, 11, 5),
      comment(P, 'Client U is back On track; the accepted $520 overrun leaves $280 headroom.', 2026, 11, 5)]],
    // two warnings on a finished job: still on time counts the job once
    ['F', [comment(P, 'At risk: Design waits on the Creative lead.', 2026, 11, 2), comment(P, 'Client F is back On track.', 2026, 11, 3),
      comment(P, 'At risk again: Package files waits on Studio.', 2026, 11, 4)]],
  ]);
  const r = warningOf(cards, comments, env, { todayDn: D(2026, 11, 20) });
  assert.deepEqual(r.flagged.map((x) => [x.card, x.episode, x.flagged_on, x.days_of_warning, x.back_on_track_on, x.days_to_clear, x.outcome]), [
    ['Client U: job', 1, '2026-11-01', 18, '2026-11-03', 2, OUTCOMES.cleared], // a Sunday flag: 18 working days to Wed 25 Nov
    ['Client F: job', 1, '2026-11-02', 8, '2026-11-03', 1, OUTCOMES.cleared],
    ['Client F: job', 2, '2026-11-04', 6, null, 4, OUTCOMES.sentOnTime],
    ['Client U: job', 2, '2026-11-05', 14, '2026-11-05', 0, OUTCOMES.cleared]]);
  assert.deepEqual([r.jobs, r.finished, r.still_on_time], [2, 1, 1]);
  // a period takes the warnings opened in it: from 4 Nov, F's second and U's second
  const later = warningOf(cards, comments, env, { todayDn: D(2026, 11, 20), per: period({ from: '2026-11-04' }) });
  assert.deepEqual(later.flagged.map((x) => [x.card, x.episode]), [['Client F: job', 2], ['Client U: job', 2]]);
});

test('the warning\'s own wording is a flag: "<job> sends <date>, N working day(s) after the <date> promise", N in figures or words; the old forms still count; a plan comment\'s "after the requested date" does not', () => {
  const P = 'Delivery Planner';
  const card = (id, due, send) => ({ id, name: `Client ${id}: job`, due: at(...due), send: at(...send), closed: false, f: {} });
  const cards = [card('P', [2026, 11, 30], [2026, 12, 1]), card('Q', [2026, 11, 30], [2026, 12, 1]), card('R', [2026, 11, 19], [2026, 11, 20]),
    card('S', [2026, 12, 18], [2026, 12, 16]), card('T', [2026, 11, 30], [2026, 11, 25])];
  const comments = new Map([
    // the Planner's warning in its current wording, in full
    ['P', [comment(P, '@Delivery lead Client P\'s new delivery area launch is forecast to send Tue, Dec 1, one working day after the Mon, Nov 30 promise.\n\nPackage files is first to slip because Mon, Nov 23 has 9.25 hours booked of the studio\'s 40-hour week.\n\nNo reshuffle saves it by Mon, Nov 30, so the delivery lead must decide whether to secure more Studio capacity or reset the client promise.', 2026, 11, 6)]],
    // two earlier wordings of the same warning
    ['Q', [comment(P, '@Delivery lead Client P sends Tue, Dec 1, one working day after the Mon, Nov 30 promise.', 2026, 11, 5)]],
    ['R', [comment(P, '@Delivery lead Client P\'s new delivery area launch would send on Fri, Nov 20, 2 working days after the Thu, Nov 19 promise.', 2026, 11, 5)]],
    // not flags: a plan comment's requested date, and a fix that brings the send back
    ['S', [comment(P, 'Files go out Wed Dec 16 and Feasible is Fri Dec 18, 14 working days after the requested Mon Nov 30.', 2026, 11, 6)]],
    ['T', [comment(P, 'That tested reshuffle brings Client P\'s send back to Mon, Nov 30, on its promise, and no other job goes late.', 2026, 11, 6)]],
  ]);
  const r = warningOf(cards, comments, env, { todayDn: D(2026, 11, 6) });
  assert.deepEqual(r.flagged.map((x) => [x.card, x.flagged_on, x.days_of_warning, x.outcome]), [
    // working days to the Mon, Nov 30 promise, the 26 and 27 Nov holidays out
    ['Client Q: job', '2026-11-05', 15, OUTCOMES.open], ['Client R: job', '2026-11-05', 10, OUTCOMES.open], ['Client P: job', '2026-11-06', 14, OUTCOMES.open]]);
  // the earlier wordings still count
  const old = warningOf([card('O', [2026, 11, 19], [2026, 11, 20])], new Map([['O', [comment(P, 'Client P will send 1 working day late (Fri 20 Nov, due Thu 19 Nov).', 2026, 11, 2)]]]), env, { todayDn: D(2026, 11, 6) });
  assert.equal(old.flagged.length, 1);
});

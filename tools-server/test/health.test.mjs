// Unit tests for the rules of the Delivery Planner's Health check Skill in Forecast delivery: hand-built cards, dated
// from today.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { healthOf } from '../tools.js';
import { makeTree, today, isWorkingDay, nextWorkingDay, addWorkingDays, isoDay, dayText, DAY_MS } from '../data.js';

const env = { TIME_ZONE: 'UTC' };
const t0 = nextWorkingDay(today(env));
const before = (d) => { let x = d - 1; while (!isWorkingDay(x)) x--; return x; };
const ms = (d) => d * DAY_MS;
const ctx = { terms: null, clientsById: new Map(), retainer: new Map(), entries: async () => [] };
const card = (due) => ({ id: 'u', name: 'Client Z: spring launch', parent: null, type: 0, status: 'in progress', closed: false,
  start: null, due: ms(due), estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [],
  f: { Client: [{ id: 'c', name: 'Client Z' }], 'Agreement type': 'Fixed fee', Budget: 2000, Rate: 65, 'Rounds included': 2, 'Rounds used': 0 } });
const stepOf = (id, name, owner, hours, start, due, waitsOn = []) => ({ id, name, parent: 'u', type: 0, status: 'to do', closed: false,
  start: ms(start), due: ms(due), estimate: hours, tracked: 0, people: [owner], teams: [], waitsOn, f: {} });
const check = (h, name) => h.checks.find((c) => c.check === name);
const run = (tasks, booked = new Map()) => {
  const tree = makeTree(tasks);
  return healthOf(tree.byId.get('u'), tree, { tree, members: new Map(), booked, bookedBy: new Map() }, env, ctx);
};

test('rounds used up and a long wait on the client are not Health', async () => {
  const due = addWorkingDays(t0, 10);
  const steps = [stepOf('w', 'Write copy', 'Copywriter', 4, addWorkingDays(t0, 1), addWorkingDays(t0, 1)),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 8), ['w'])];
  const spent = { ...card(due), f: { ...card(due).f, 'Rounds included': 2, 'Rounds used': 2 } };
  const h = await run([spent, ...steps]);
  assert.equal(h.health_by_the_checks, 'On track');
  assert.equal(check(h, 'Revisions'), undefined);
  assert.equal(check(h, 'Client'), undefined);
  const waiting = { ...card(due), status: 'delivered', f: { ...card(due).f, 'Delivered on': ms(addWorkingDays(t0, -12)) } };
  const w = await run([waiting, ...steps]);
  assert.equal(w.tripped.includes('Client'), false);
  assert.equal(w.checks.some((c) => /sign-off|rounds used/.test(c.detail)), false);
});

test('an overdue step while the send still fits inside the buffer is noted, not scored', async () => {
  const due = addWorkingDays(t0, 10);
  const h = await run([card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, before(before(t0)), before(t0)),
    stepOf('pf', 'Package files', 'Studio', 2, addWorkingDays(t0, 6), addWorkingDays(t0, 6), ['w']),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), due, ['pf'])]);
  assert.equal(check(h, 'Buffer').level, 'clear');
  assert.equal(check(h, 'Overdue step').level, 'note');
  assert.equal(check(h, 'Recovery re-walk').level, 'note');
  assert.equal(h.health_by_the_checks, 'On track');
  assert.match(h.notes.join(' '), /Write copy \(Copywriter\) was due .* inside the buffer \(noted, not scored\)/);
  assert.ok(h.rewalk.recovery_plan.length === 3);
});

test('an overdue step that pushes the send past the Due date: the buffer is gone, Off track', async () => {
  const due = addWorkingDays(t0, 1);
  const h = await run([card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, before(before(t0)), before(t0)),
    stepOf('pf', 'Package files', 'Studio', 2, t0, t0, ['w']),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, t0, due, ['pf'])]);
  assert.equal(check(h, 'Overdue step').level, 'At risk');
  assert.equal(check(h, 'Recovery re-walk').level, 'Off track');
  assert.equal(h.health_by_the_checks, 'Off track');
  assert.ok(h.rewalk.working_days_send_past_due_date > 0);
});

test('the buffer gone on the card: steps not started keep their planned days, so the re-walk confirms the late send: Off track', async () => {
  const due = addWorkingDays(t0, 3);
  const h = await run([card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, addWorkingDays(t0, 2), addWorkingDays(t0, 3)),
    stepOf('pf', 'Package files', 'Studio', 2, addWorkingDays(t0, 4), addWorkingDays(t0, 4), ['w']),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 7), ['pf'])]);
  assert.equal(check(h, 'Buffer').level, 'At risk');
  assert.match(check(h, 'Buffer').detail, /the buffer is gone/);
  assert.equal(check(h, 'Recovery re-walk').level, 'Off track');
  // the copy no earlier than its planned start, the files after its planned end, the send on Deliver's planned day
  assert.equal(h.rewalk.send, isoDay(addWorkingDays(t0, 5)));
  assert.equal(h.health_by_the_checks, 'Off track');
});

test('a step due today and not started runs the re-walk too', async () => {
  const due = addWorkingDays(t0, 10);
  const day = today(env); // today itself, a working day or not
  const h = await run([card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, day, day),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), due, ['w'])]);
  assert.equal(check(h, 'Overdue step').level, 'note');
  assert.match(check(h, 'Overdue step').detail, /Write copy \(Copywriter\) is due today and has not started/);
  assert.equal(h.rewalk.triggered, true);
});

// --- least slack first ---
import { leastSlackFirst } from '../tools.js';
import { bookings, bookingsBy } from '../data.js';

// Two live jobs on Studio's days: A's files are planned on the same two days as B's, and Studio has room for one.
const job = (id, client, due) => ({ id, name: `${client}: launch`, parent: null, type: 0, status: 'in progress', closed: false,
  start: null, due: ms(due), estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [],
  f: { Client: [{ id: `c${id}`, name: client }], 'Agreement type': 'Fixed fee', Budget: 2000, Rate: 65 } });
const st = (id, parent, name, owner, hours, start, due, waitsOn = []) => ({ id, name, parent, type: 0, status: 'to do', closed: false,
  start: ms(start), due: ms(due), estimate: hours, tracked: 0, people: [owner], teams: [], waitsOn, f: {} });
const liveOf = (tasks, members = new Map()) => {
  const tree = makeTree(tasks);
  const steps = tasks.filter((t) => t.parent);
  const unitOfStep = new Map(steps.map((s) => [s.id, tree.byId.get(s.parent)]));
  const label = (s) => `${tree.byId.get(s.parent).f.Client[0].name}'s ${s.name}`;
  return { tree, intakeTree: makeTree([]), members, steps, unitOfStep, booked: bookings(steps, env, members), bookedBy: bookingsBy(steps, env, members, label) };
};

test('least slack first: the job past its Due date takes the double-booked days, the job with slack waits and still sends in time', () => {
  const d1 = addWorkingDays(t0, 3); const d2 = addWorkingDays(t0, 4);
  // Each job's copy (20 h) runs to the day before d1, so its 12 h of files cannot start before d1; both files are
  // planned on d1-d2, double-booking Studio. A sends the day after (its Due date: no slack); B sends eight days on.
  const tasks = [job('a', 'Client A', addWorkingDays(t0, 5)), job('b', 'Client B', addWorkingDays(t0, 14)),
    st('aw', 'a', 'Write copy', 'Copywriter', 10, t0, addWorkingDays(t0, 2)), st('bw', 'b', 'Write copy', 'Copywriter', 10, t0, addWorkingDays(t0, 2)),
    st('apf', 'a', 'Package files', 'Studio', 12, d1, d2, ['aw']), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 7), ['apf']),
    st('bpf', 'b', 'Package files', 'Studio', 12, d1, d2, ['bw']), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), addWorkingDays(t0, 10), ['bpf'])];
  const live = liveOf(tasks);
  const ctx2 = { ...ctx, walks: new Map() };
  const units = [live.tree.byId.get('a'), live.tree.byId.get('b')];
  const r = leastSlackFirst(live, env, ctx2, units);
  assert.ok(r, 'Client A is at risk on the forecast');
  assert.equal(r.reshuffle_suggested, true);
  assert.equal(r.every_job_sends_by_due_date, true);
  assert.equal(r.order[0].card, 'Client A: launch'); // the least slack goes first
  // B's files move later, to the first days they fit the studio's whole days on the cards (one capacity rule); B's
  // Deliver is already after them and stays; the forecast on the cards as the move leaves them has A on time.
  assert.deepEqual(r.drags, [
    { card: 'Client B: launch', card_id: 'b', step: 'Package files', step_id: 'bpf', from: isoDay(d1), from_due: isoDay(d2), to: isoDay(addWorkingDays(t0, 5)), to_due: isoDay(addWorkingDays(t0, 6)), follows: null }]);
  assert.deepEqual(r.sends_after_drags, [{ card: 'Client A: launch', send: isoDay(addWorkingDays(t0, 5)), due_date: isoDay(addWorkingDays(t0, 5)) }]);
  assert.match(r.suggestion, /^Least slack first on Studio's time: Client A's Package files goes first\. Move Client B's Package files from [^,]+, [^,]+ to [^,]+, [^;]+; Client B's [^,]+, [^ ]+ [0-9]+ Due date stays safe\. Tested on the cards as the moves leave them: Client A sends .*, on its Due date; no other job goes late$/);
});

test('least slack first: the fallback goes to someone else on the step\'s Team, one job after another', () => {
  // Three approved jobs (To do: forecast from their planned starts) each have 12 h of files on d1-d2 and send on d3,
  // their Due date. The Studio Team here is Studio and Copywriter. A goes first; B's files go to the copywriter; C
  // then finds the copywriter's days taken by B's files: no reshuffle saves it, and the Delivery lead decides.
  const d1 = addWorkingDays(t0, 1); const d2 = addWorkingDays(t0, 2); const d3 = addWorkingDays(t0, 3);
  const queued = (id, client) => ({ ...job(id, client, d3), status: 'to do' });
  const tasks = [queued('a', 'Client A'), queued('b', 'Client B'), queued('c', 'Client C')];
  for (const k of ['a', 'b', 'c']) {
    tasks.push(st(`${k}pf`, k, 'Package files', 'Studio', 12, d1, d2), st(`${k}dl`, k, 'Deliver', 'Account lead', 0.5, d3, addWorkingDays(t0, 5), [`${k}pf`]));
  }
  const live = liveOf(tasks, new Map([['Studio', ['Studio', 'Copywriter']]]));
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, ['a', 'b', 'c'].map((k) => live.tree.byId.get(k)));
  assert.equal(r.reshuffle_suggested, true);
  assert.deepEqual(r.saved, ['Client A: launch']);
  assert.equal(r.fallback.length, 2);
  assert.equal(r.fallback[0].card, 'Client B: launch');
  assert.equal(r.fallback[0].to, 'Copywriter');
  assert.equal(r.fallback[1].card, 'Client C: launch');
  assert.equal(r.fallback[1].to, null); // the copywriter's days now hold B's files
  assert.match(r.suggestion, /give Client B's Package files to Copywriter on the Studio Team: the files go out .*; no reshuffle saves Client C; the Delivery lead decides$/);
  assert.doesNotMatch(r.suggestion, /contractor|new date/);
  assert.equal(r.every_job_sends_by_due_date, false);
});

test('least slack first: the partial reshuffle saves the late jobs it can, and one it cannot save does not cancel the fix', () => {
  // A's files (after its copy) clash with B's on d1-d2 (t0+3, t0+4): A goes first and B, with slack, moves a day. D's
  // files (after the agency, due t0+5) clash with E's on t0+6 and t0+7; E, with nothing before it, forecasts early,
  // but held to its planned days it would send late if D went first: D is left out, and A is still saved.
  const d1 = addWorkingDays(t0, 3); const d2 = addWorkingDays(t0, 4);
  const e1 = addWorkingDays(t0, 6); const e2 = addWorkingDays(t0, 7);
  const tasks = [job('a', 'Client A', addWorkingDays(t0, 5)), job('b', 'Client B', addWorkingDays(t0, 14)),
    job('d', 'Client D', addWorkingDays(t0, 8)), job('e', 'Client E', addWorkingDays(t0, 8)),
    st('aw', 'a', 'Write copy', 'Copywriter', 10, t0, addWorkingDays(t0, 2)), st('bw', 'b', 'Write copy', 'Copywriter', 10, t0, addWorkingDays(t0, 2)),
    st('apf', 'a', 'Package files', 'Studio', 12, d1, d2, ['aw']), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 7), ['apf']),
    st('bpf', 'b', 'Package files', 'Studio', 12, d1, d2, ['bw']), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), addWorkingDays(t0, 10), ['bpf']),
    st('dds', 'd', 'Design', 'Creative lead', 0, t0 - 1, addWorkingDays(t0, 5)),
    st('dpf', 'd', 'Package files', 'Studio', 12, e1, e2, ['dds']), st('ddl', 'd', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), addWorkingDays(t0, 10), ['dpf']),
    st('epf', 'e', 'Package files', 'Studio', 12, e1, e2), st('edl', 'e', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 8), addWorkingDays(t0, 10), ['epf'])];
  const live = liveOf(tasks);
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, ['a', 'b', 'd', 'e'].map((k) => live.tree.byId.get(k)));
  // E is held to its planned days, so it is late too; A and D are saved, E is not, and the suggestion says what
  // the moves do to E.
  assert.deepEqual(r.saved, ['Client A: launch', 'Client D: launch']);
  assert.deepEqual(r.not_saved, ['Client E: launch']);
  assert.deepEqual(r.drags.map((x) => [x.card, x.step, x.follows]), [['Client B: launch', 'Package files', null], ['Client B: launch', 'Deliver', 'Package files'],
    ['Client E: launch', 'Package files', null], ['Client E: launch', 'Deliver', 'Package files']]);
  assert.match(r.suggestion, /^Least slack first on Studio's time: Client A's Package files and Client D's Package files go first\. Move Client B's Package files .*; its Deliver follows, .*; Client B's .* Due date stays safe\. Then move Client E's Package files .*; Client E then sends .* after its Due date .*\. Tested on the cards as the moves leave them: Client A sends .*, on its Due date and Client D sends .*, on its Due date; no other job goes late; no reshuffle saves Client E; the Delivery lead decides$/);
});

test('least slack first: a job already late may be moved later to save another, and the suggestion says what that does to it', () => {
  const d1 = addWorkingDays(t0, 3); const d2 = addWorkingDays(t0, 4);
  // A's files wait for its copy until d1 and clash with C's on d1-d2. Both are held to their planned days, so both are
  // late; the reshuffle saves A by moving C's files and Deliver later, and says C then sends later still.
  const tasks = [job('a', 'Client A', addWorkingDays(t0, 5)), job('c', 'Client C', addWorkingDays(t0, 5)),
    st('aw', 'a', 'Write copy', 'Copywriter', 20, t0, addWorkingDays(t0, 2)),
    st('apf', 'a', 'Package files', 'Studio', 12, d1, d2, ['aw']), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 7), ['apf']),
    st('cpf', 'c', 'Package files', 'Studio', 12, d1, d2), st('cdl', 'c', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), addWorkingDays(t0, 7), ['cpf'])];
  const live = liveOf(tasks);
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, [live.tree.byId.get('a'), live.tree.byId.get('c')]);
  assert.deepEqual(r.saved, ['Client A: launch']);
  assert.deepEqual(r.not_saved, ['Client C: launch']);
  assert.match(r.suggestion, /Move Client C's Package files from .*; its Deliver follows, Deliver from .* to .*; Client C then sends .*, 2 working days after its Due date .*; no reshuffle saves Client C; the Delivery lead decides$/);
  assert.doesNotMatch(r.suggestion, /Client C's .* Due date stays safe/);
});

// --- Test a fix: the change made to a copy of the cards, the forecast run on it ---
import { rewalk, buildLive, changedTree } from '../tools.js';
import { dayNumber } from '../data.js';

test('Test a fix: moving a step moves its booking, so the what-if matches the forecast after the drag', () => {
  // B (as Client P) can start its 8 h of files only on day d (the agency until d-1) and must send on d+1; A's 8 h of
  // files (as Client K) are booked on d too, so B waits and sends late. Moving A's files to d+1 frees d for B.
  const d = addWorkingDays(t0, 3);
  const tasks = [job('a', 'Client A', addWorkingDays(t0, 10)), job('b', 'Client B', addWorkingDays(d, 1)),
    st('apf', 'a', 'Package files', 'Studio', 8, d, d), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['apf']),
    st('bds', 'b', 'Design', 'Creative lead', 0, t0 - 1, before(d)),
    st('bpf', 'b', 'Package files', 'Studio', 8, d, d, ['bds']), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['bpf'])];
  const live = liveOf(tasks);
  const a = live.tree.byId.get('a');
  const asIs = rewalk(live, live.tree.byId.get('b'), env, {});
  assert.ok(asIs.send_past_due > 0); // B is late as the cards stand
  const changes = [{ unit: a, step: live.tree.byId.get('apf'), owner: null, start: addWorkingDays(d, 1), due: null }];
  const tree = changedTree(live.tree, changes, env);
  assert.equal(dayNumber(tree.byId.get('apf').start, env), addWorkingDays(d, 1));
  assert.equal(dayNumber(tree.byId.get('apf').due, env), addWorkingDays(d, 1)); // the due date moves with it
  assert.equal(dayNumber(live.tree.byId.get('apf').start, env), d); // the shared card is not changed
  const after = buildLive(env, tree, makeTree([]), live.members);
  const b = rewalk(after, after.tree.byId.get('b'), env, {});
  assert.ok(b.send_past_due <= 0); // B sends on time once A's booking has moved
  // the same as building the picture from cards dated that way to begin with
  const dragged = liveOf(tasks.map((t) => (t.id === 'apf' ? { ...t, start: ms(addWorkingDays(d, 1)), due: ms(addWorkingDays(d, 1)) } : t)));
  assert.equal(b.send, rewalk(dragged, dragged.tree.byId.get('b'), env, {}).send);
});

test('Test a fix: a step moved keeps its working days, across a weekend; a new owner takes it off its Team', () => {
  const tasks = [job('a', 'Client A', addWorkingDays(t0, 20)), { ...st('aw', 'a', 'Write copy', 'Copywriter', 8, t0, addWorkingDays(t0, 1)), people: [], teams: ['Copy'] }];
  const live = liveOf(tasks);
  const fri = (() => { let x = addWorkingDays(t0, 5); while (new Date(x * DAY_MS).getUTCDay() !== 5) x += 1; return x; })();
  const tree = changedTree(live.tree, [{ unit: live.tree.byId.get('a'), step: live.tree.byId.get('aw'), owner: 'Studio', start: fri, due: null }], env);
  const t = tree.byId.get('aw');
  assert.equal(dayNumber(t.start, env), fri);
  assert.equal(dayNumber(t.due, env), addWorkingDays(fri, 1)); // two working days: Friday and Monday
  assert.deepEqual(t.people, ['Studio']);
  assert.deepEqual(t.teams, []);
});

test('Test a fix: only the step moved changes; the steps that wait on it keep their dates (Reschedule Dependencies off)', () => {
  // Files, then Internal review, then Deliver, each waiting on the one before. Moving the files a working day later
  // leaves the review and Deliver where they are on the cards; the Health check names any that must move.
  const fri = (() => { // a Friday with a working Thursday before it and a working Monday after
    let x = addWorkingDays(t0, 3);
    while (new Date(x * DAY_MS).getUTCDay() !== 5 || !isWorkingDay(x) || !isWorkingDay(x - 1) || !isWorkingDay(x + 3)) x += 1;
    return x;
  })();
  const mon = addWorkingDays(fri, 1);
  const tasks = [job('k', 'Client K', addWorkingDays(fri, 8)),
    st('kpf', 'k', 'Package files', 'Studio', 3, fri - 1, fri - 1), st('kir', 'k', 'Internal review', 'Account lead', 1, fri, fri, ['kpf']),
    st('kdl', 'k', 'Deliver', 'Account lead', 1.5, mon, addWorkingDays(mon, 3), ['kir'])];
  const live = liveOf(tasks);
  const k = live.tree.byId.get('k');
  const one = [{ unit: k, step: live.tree.byId.get('kpf'), owner: null, start: fri, due: null }];
  const t1 = changedTree(live.tree, one, env);
  assert.equal(dayNumber(t1.byId.get('kpf').start, env), fri);
  assert.equal(dayNumber(t1.byId.get('kir').start, env), fri); // the review stays on Friday, now the files' day
  assert.equal(dayNumber(t1.byId.get('kdl').start, env), mon);
  assert.equal(dayNumber(t1.byId.get('kdl').due, env), addWorkingDays(mon, 3));
  assert.deepEqual(one[0].pushed, []);
  assert.equal(dayNumber(live.tree.byId.get('kpf').start, env), fri - 1); // the shared cards are not changed
});

// --- the reshuffle as drags; the client's record as advice only ---
test('least slack first: the reshuffle is the drags a person makes, nothing else moving with them, tested on the cards', () => {
  // As Clients P and K: both jobs' 8 h of files are planned on a Friday, then an Internal review on Monday and Deliver.
  // P sends on Tuesday, its Due date; K has slack. P's files go first; K's files are dragged to Monday, and nothing
  // moves with them unless listed (Reschedule Dependencies off); on the cards as the drags leave them P sends on time.
  const fri = (() => {
    let x = addWorkingDays(t0, 3);
    while (new Date(x * DAY_MS).getUTCDay() !== 5 || !isWorkingDay(x) || !isWorkingDay(x + 3)) x += 1;
    return x;
  })();
  const mon = addWorkingDays(fri, 1); const tue = addWorkingDays(mon, 1);
  const queued = (id, client, due) => ({ ...job(id, client, due), status: 'to do' });
  const tasks = [queued('p', 'Client P', tue), queued('k', 'Client K', addWorkingDays(fri, 8)),
    st('ppf', 'p', 'Package files', 'Studio', 8, fri, fri), st('pir', 'p', 'Internal review', 'Account lead', 1, mon, mon, ['ppf']),
    st('pdl', 'p', 'Deliver', 'Account lead', 0.5, tue, addWorkingDays(tue, 2), ['pir']),
    st('kpf', 'k', 'Package files', 'Studio', 8, fri, fri), st('kir', 'k', 'Internal review', 'Account lead', 1, mon, mon, ['kpf']),
    st('kdl', 'k', 'Deliver', 'Account lead', 0.5, addWorkingDays(mon, 2), addWorkingDays(mon, 4), ['kir'])];
  const live = liveOf(tasks);
  const units = [live.tree.byId.get('p'), live.tree.byId.get('k')];
  assert.ok(rewalk(live, units[0], env, {}).send_past_due > 0); // P is late as the cards stand
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, units);
  assert.deepEqual(r.saved, ['Client P: launch']);
  // K's review was on Monday too, so it is listed to follow the files to Tuesday.
  assert.deepEqual(r.drags, [
    { card: 'Client K: launch', card_id: 'k', step: 'Package files', step_id: 'kpf', from: isoDay(fri), from_due: isoDay(fri), to: isoDay(mon), to_due: isoDay(mon), follows: null },
    { card: 'Client K: launch', card_id: 'k', step: 'Internal review', step_id: 'kir', from: isoDay(mon), from_due: isoDay(mon), to: isoDay(tue), to_due: isoDay(tue), follows: 'Package files' }]);
  assert.deepEqual(r.sends_after_drags, [{ card: 'Client P: launch', send: isoDay(tue), due_date: isoDay(tue) }]);
  assert.match(r.suggestion, /^Least slack first on Studio's time: Client P's Package files goes first\. Move Client K's Package files from [^,]+, [^,]+ to [^,]+, [^;]+; its Internal review follows, Internal review from [^,]+, [^,]+ to [^,]+, [^;]+; Client K's [^,]+, [^ ]+ [0-9]+ Due date stays safe\. Tested on the cards as the moves leave them: Client P sends .*, on its Due date; no other job goes late$/);
  // The same drags put to Test a fix's calculation give the same send, and K stays inside its Due date.
  const changes = r.drags.map((x) => ({ unit: live.tree.byId.get('k'), step: tasks.find((t) => t.parent === 'k' && t.name === x.step), owner: null, start: dayNumber(Date.parse(x.to), env), due: null }));
  const world = buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members);
  assert.equal(isoDay(rewalk(world, world.tree.byId.get('p'), env, {}).send), isoDay(tue));
  assert.ok(rewalk(world, world.tree.byId.get('k'), env, {}).send_past_due <= 0);
});

// --- Fix refs: the fix a comment lists, stored for Apply fix ---
import { fixOf } from '../tools.js';

// Workers KV as these calls use it.
const fakeFixes = () => {
  const held = new Map();
  return { held, get: async (k) => (held.has(k) ? JSON.parse(held.get(k)) : null), put: async (k, v) => { held.set(k, v); } };
};

test('Fix ref: the reshuffle for the late job it saves is stored as its fix, each step by id from its card dates; a job it does not save gets none', async () => {
  const fri = (() => {
    let x = addWorkingDays(t0, 3);
    while (new Date(x * DAY_MS).getUTCDay() !== 5 || !isWorkingDay(x) || !isWorkingDay(x + 3)) x += 1;
    return x;
  })();
  const mon = addWorkingDays(fri, 1); const tue = addWorkingDays(mon, 1);
  const todo = (id, client, due) => ({ ...job(id, client, due), status: 'to do' });
  const tasks = [todo('p', 'Client P', tue), todo('k', 'Client K', addWorkingDays(fri, 8)),
    st('ppf', 'p', 'Package files', 'Studio', 8, fri, fri), st('pir', 'p', 'Internal review', 'Account lead', 1, mon, mon, ['ppf']),
    st('pdl', 'p', 'Deliver', 'Account lead', 0.5, tue, addWorkingDays(tue, 2), ['pir']),
    st('kpf', 'k', 'Package files', 'Studio', 8, fri, fri), st('kir', 'k', 'Internal review', 'Account lead', 1, mon, mon, ['kpf']),
    st('kdl', 'k', 'Deliver', 'Account lead', 0.5, addWorkingDays(mon, 2), addWorkingDays(mon, 4), ['kir'])];
  const live = liveOf(tasks);
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, [live.tree.byId.get('p'), live.tree.byId.get('k')]);
  const store = fakeFixes();
  const fix = await fixOf({ ...env, FIXES: store }, live, r, {}, live.tree.byId.get('p'));
  assert.equal(fix.source, 'least slack first');
  assert.match(fix.ref, /^[0-9a-f]{8}$/);
  assert.deepEqual(fix.moves, [
    { card_id: 'k', card: 'Client K: launch', step_id: 'kpf', step: 'Package files', from: isoDay(fri), from_due: isoDay(fri), to: isoDay(mon), to_due: isoDay(mon) },
    { card_id: 'k', card: 'Client K: launch', step_id: 'kir', step: 'Internal review', from: isoDay(mon), from_due: isoDay(mon), to: isoDay(tue), to_due: isoDay(tue) }]);
  const held = JSON.parse(store.held.get(`fix:${fix.ref}`));
  assert.deepEqual([held.project_id, held.project, held.moves], ['p', 'Client P: launch', fix.moves]);
  assert.equal(await fixOf({ ...env, FIXES: store }, live, r, {}, live.tree.byId.get('k')), null); // K moves for P; it has no fix of its own
});

test('Fix ref: a Watch comment\'s moves are stored as the job\'s fix, each step from its planned days to the replay\'s', async () => {
  const d = addWorkingDays(t0, 3);
  const due = addWorkingDays(t0, 8);
  const tasks = [card(due), stepOf('w', 'Write copy', 'Copywriter', 4, addWorkingDays(t0, 1), addWorkingDays(t0, 1)),
    stepOf('pf', 'Package files', 'Studio', 6, d, d, ['w']), stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), due, ['pf'])];
  const studio = new Map([[t0, 8], [addWorkingDays(t0, 1), 8], [addWorkingDays(t0, 2), 8], [d, 4 + 6]]);
  const tree = makeTree(tasks);
  const h = await healthOf(tree.byId.get('u'), tree, { tree, members: new Map(), booked: new Map([['Studio', studio]]), bookedBy: new Map() }, env, ctx);
  assert.ok(h.watch);
  const fix = await fixOf({ ...env, FIXES: fakeFixes() }, { tree }, null, h, tree.byId.get('u'));
  assert.equal(fix.source, 'watch');
  assert.deepEqual(fix.moves, [{ card_id: 'u', card: 'Client Z: spring launch', step_id: 'pf', step: 'Package files',
    from: isoDay(d), from_due: isoDay(d), to: isoDay(addWorkingDays(d, 1)), to_due: isoDay(addWorkingDays(d, 1)) }]);
  assert.match(fix.ref, /^[0-9a-f]{8}$/);
});

import { signOffFor } from '../tools.js';

test('Deliver\'s sign-off window is the 3-day allowance; the client\'s average is advice, never a number in the plan', () => {
  const done = (id, signOff) => ({ ...job(id, 'Client T', t0 - 20), status: 'complete', closed: true,
    f: { ...job(id, 'Client T', t0).f, Client: [{ id: 'cT', name: 'Client T' }], 'Sign-off days': signOff, 'Delivered on': ms(t0 - 20) } });
  const req = { ...job('r', 'Client T', addWorkingDays(t0, 20)), f: { ...job('r', 'Client T', t0).f, Client: [{ id: 'cT', name: 'Client T' }] } };
  const slow = makeTree([done('d1', 9), done('d2', 9), done('d3', 9), req]);
  const so = signOffFor(slow, slow.byId.get('r'), env);
  assert.equal(so.days, 3);
  assert.equal(so.average, 9);
  assert.match(so.advice, /^Client T averages 9 days to sign off on its last 3 finished projects, longer than the 3-day allowance$/);
  const fresh = makeTree([done('d1', 9), req]);
  const none = signOffFor(fresh, fresh.byId.get('r'), env);
  assert.equal(none.days, 3);
  assert.equal(none.advice, 'no client record yet for Client T');
});

// --- the Cost check reads Headroom as it stands; a client round is in the Budget through the lift ---

test('the Cost check scores Headroom as it stands: a rework chain on the card is not taken off the shortfall', async () => {
  // As Client U: Budget $1,600, Supplier cost $800, 8 h of the original steps and 8 h on an Internal rework card, all
  // at $65: Forecast $1,840, Headroom -$240. Internal rework is a cost; a client round is paid for by the Budget lift at
  // the Rework label (writes.js), so nothing is netted here: Off track.
  const due = addWorkingDays(t0, 15);
  const u = { ...card(due), f: { ...card(due).f, Budget: 1600, Rate: 65, 'Supplier cost': 800, Rework: ['Internal'] } };
  // a finished step has its hours logged (here what it was estimated at), and Forecast counts them
  const done = (id, name, owner, hours) => ({ ...stepOf(id, name, owner, hours, before(before(t0)), before(t0)), status: 'complete', closed: true, tracked: hours });
  const open = (id, name, owner, hours, k, waitsOn = []) => stepOf(id, name, owner, hours, addWorkingDays(t0, k), addWorkingDays(t0, k), waitsOn);
  const base = [u, done('w', 'Write copy', 'Copywriter', 3.5), done('rc', 'Review copy', 'Creative lead', 0.5), done('ds', 'Design', 'Creative lead', 2),
    done('pf', 'Package files', 'Studio', 1), open('ir', 'Internal review', 'Account lead', 0.5, 6), open('dl', 'Deliver', 'Account lead', 0.5, 7, ['ir'])];
  const rework = [{ ...card(due), id: 'r', name: 'Internal rework: web', parent: 'u', f: { Rework: ['Internal'] } },
    { ...done('rw', 'Rework: Write copy', 'Copywriter', 3), parent: 'r' }, { ...open('rr', 'Rework: Review copy', 'Creative lead', 1, 1), parent: 'r' },
    { ...open('rd', 'Rework: Design', 'Creative lead', 2, 2, ['rr']), parent: 'r' }, { ...open('rp', 'Rework: Package files', 'Studio', 2, 5, ['rd']), parent: 'r' }];
  const h = await run([...base, ...rework]);
  assert.equal(h.money.headroom, -240);
  assert.equal('headroom_netted' in h.money, false);
  assert.equal(check(h, 'Cost').level, 'Off track');
  assert.equal(check(h, 'Cost').detail, 'Forecast $1,840 against a $1,600 Budget, Headroom -$240 (-15% of the Budget)');
  // a Budget lifted by the client round's hours (as the event service does) clears it: +$520 makes Headroom +$280, 13%
  const lifted = await run([{ ...u, f: { ...u.f, Budget: 2120 } }, ...base.slice(1), ...rework]);
  assert.equal(lifted.money.headroom, 280);
  assert.equal(check(lifted, 'Cost').level, 'clear');
  // an internal rework's cost recorded in Accepted overrun (the account lead's decision) counts in Headroom; the Budget
  // stays: $1,600 + $520 - $1,840 = $280, 18% of the Budget, clear
  const accepted = await run([{ ...u, f: { ...u.f, 'Accepted overrun': 520 } }, ...base.slice(1), ...rework]);
  assert.equal(accepted.money.budget, 1600);
  assert.equal(accepted.money.headroom, 280);
  assert.equal(check(accepted, 'Cost').level, 'clear');
  assert.equal(check(accepted, 'Cost').detail, 'Forecast $1,840 against a $1,600 Budget, Headroom $280 (18% of the Budget, with $520 accepted overrun)');
});

import { notStarted, marginKnown } from '../tools.js';

test('Ready is approved and not started, as To do: the same planned starts, the same reshuffle, and live for the measures', () => {
  assert.deepEqual(['To do', 'ready', 'Ready', 'in progress', 'complete'].map((s) => notStarted({ status: s })), [true, true, true, false, false]);
  // The least slack first fallback above, run with the three jobs at To do and again at Ready: the same answer.
  const d1 = addWorkingDays(t0, 1); const d2 = addWorkingDays(t0, 2); const d3 = addWorkingDays(t0, 3);
  const run = (status) => {
    const tasks = ['a', 'b', 'c'].map((k, i) => ({ ...job(k, `Client ${'ABC'[i]}`, d3), status }));
    for (const k of ['a', 'b', 'c']) {
      tasks.push(st(`${k}pf`, k, 'Package files', 'Studio', 12, d1, d2), st(`${k}dl`, k, 'Deliver', 'Account lead', 0.5, d3, addWorkingDays(t0, 5), [`${k}pf`]));
    }
    const live = liveOf(tasks, new Map([['Studio', ['Studio', 'Copywriter']]]));
    const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, ['a', 'b', 'c'].map((k) => live.tree.byId.get(k)));
    return { saved: r.saved, fallback: r.fallback.map((f) => [f.card, f.to]), margin: marginKnown(live.tree).live };
  };
  const ready = run('ready');
  assert.deepEqual(ready, run('to do'));
  assert.deepEqual(ready.saved, ['Client A: launch']);
  assert.equal(ready.margin, 3); // three live jobs, Ready ones included
});

// --- Forecast reads what is spent, not what was planned ---
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('Forecast reads what is spent: a first step that ran over, with five open steps behind it; the card nets it away, the Cost check flags it', async () => {
  // Budget $2,000 at $100 an hour, no supplier. Write copy was estimated at 4 h, took 9 h and is finished; five open
  // steps of 2 h each are still to come, none started. Planned: 14 h, $1,400.
  const due = addWorkingDays(t0, 15);
  const job = { ...card(due), f: { ...card(due).f, Budget: 2000, Rate: 100, 'Supplier cost': 0 } };
  const ran = { ...stepOf('w', 'Write copy', 'Copywriter', 4, before(before(t0)), before(t0)), status: 'complete', closed: true, tracked: 9 };
  const ahead = ['Review copy', 'Design', 'Package files', 'Internal review', 'Deliver'].map((n, i) => stepOf(`s${i}`, n, 'Studio', 2, addWorkingDays(t0, i + 1), addWorkingDays(t0, i + 1)));
  const tasks = [job, ran, ...ahead];
  // The card's Forecast field: Cost (9 h, $900) plus Hours remaining (14 - 9 = 5 h) at the Rate when above zero:
  // $1,400, Headroom $600 (30%). The over-run on Write copy is netted against the open steps' hours.
  const est = sum(tasks.map((x) => x.estimate || 0)), logged = sum(tasks.map((x) => x.tracked || 0));
  const cardForecast = logged * 100 + Math.max(0, est - logged) * 100;
  assert.deepEqual([cardForecast, 2000 - cardForecast], [1400, 600]);
  // The check, task by task: Write copy's 9 h logged plus the five open steps' 10 h: 19 h, $1,900, Headroom $100 (5%).
  const h = await run(tasks);
  assert.deepEqual([h.money.forecast_hours, h.money.forecast, h.money.headroom, h.money.headroom_pct], [19, 1900, 100, 5]);
  assert.equal(check(h, 'Cost').level, 'At risk');
  assert.equal(check(h, 'Cost').detail, 'Forecast $1,900 against a $2,000 Budget, Headroom $100 (5% of the Budget)');
  // an open step that has run past its estimate counts what it has taken so far
  const stillGoing = await run([job, { ...ran, status: 'in progress', closed: false, tracked: 12 }, ...ahead]);
  assert.equal(stillGoing.money.forecast, 2200); // 12 h + 10 h
  assert.equal(check(stillGoing, 'Cost').level, 'Off track');
});

test('Watch: a step spills past its planned day from an over-full day, the send still lands by the Due date; Health is not changed', async () => {
  const d = addWorkingDays(t0, 3); // Package files' planned day
  const due = addWorkingDays(t0, 8);
  const tasks = () => [card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, addWorkingDays(t0, 1), addWorkingDays(t0, 1)),
    stepOf('pf', 'Package files', 'Studio', 6, d, d, ['w']),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 5), due, ['pf'])];
  // The studio's booked hours, this job's 6 included (the re-walk takes them off): other work fills its days up to the
  // planned day and leaves 4 of its 8 hours on it.
  const studio = new Map([[t0, 8], [addWorkingDays(t0, 1), 8], [addWorkingDays(t0, 2), 8], [d, 4 + 6]]);
  const quiet = await run(tasks());
  const full = await run(tasks(), new Map([['Studio', studio]]));
  assert.equal(quiet.watch, null); // nothing spilled, no comment
  assert.equal(full.watch.comment, [ // one line per step whose planned day and replay day differ, the move named
    `${dayText(d)} is over-full for Studio.`,
    `1. Package files must move from ${dayText(d)} to ${dayText(addWorkingDays(d, 1))}, Studio is over-full on ${dayText(d)}.`, // the first day it fits whole
    'No date at risk.',
    'Tidy this in Workload so new work is planned against real days.'].join('\n'));
  assert.deepEqual(full.watch.overfull, [{ day: isoDay(d), owner: 'Studio', step: 'Package files' }]);
  assert.ok(full.rewalk.working_days_send_past_due_date <= 0);
  assert.equal(full.health_by_the_checks, quiet.health_by_the_checks);
  assert.deepEqual(full.checks.map((c) => c.level), quiet.checks.map((c) => c.level));
});

test('step days: a step planned before the step it waits on ends must move; a plan in order is quiet', async () => {
  const due = addWorkingDays(t0, 10);
  const steps = (copyEnds) => [card(due),
    stepOf('w', 'Write copy', 'Copywriter', 4, addWorkingDays(t0, 1), copyEnds),
    stepOf('rc', 'Review copy', 'Creative lead', 1, addWorkingDays(t0, 2), addWorkingDays(t0, 2), ['w']),
    stepOf('dl', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 6), due, ['rc'])];
  // Write copy slipped on the card to end after Review copy's planned day, and nothing moved with it.
  const slipped = await run(steps(addWorkingDays(t0, 3)));
  const rc = slipped.step_days.find((r) => r.step === 'Review copy');
  assert.equal(rc.flag, 'must move');
  // Write copy has not started, so the review waits for its planned end (Thu) and goes the working day after.
  assert.equal(rc.line, `Review copy must move from ${dayText(addWorkingDays(t0, 2))} to ${dayText(addWorkingDays(t0, 4))}, it is planned before Write copy ends.`);
  assert.equal(slipped.watch.comment, [
    'Review copy is planned before Write copy ends.',
    `1. ${rc.line}`,
    'No date at risk.',
    'Tidy this in Workload so new work is planned against real days.'].join('\n'));
  assert.equal(slipped.health_by_the_checks, 'On track');
  // The same card in order: no step must move, and no comment.
  const inOrder = await run(steps(addWorkingDays(t0, 1)));
  assert.deepEqual(inOrder.step_days.map((r) => r.flag), [null, null, null]);
  assert.equal(inOrder.watch, null);
  assert.deepEqual(inOrder.checks.map((c) => c.level), slipped.checks.map((c) => c.level));
});

import { replanLive } from '../tools.js';

test('the re-plan of open steps: started steps keep their dates; the rest are planned from today, each the working day after the one it waits on', () => {
  const due = addWorkingDays(t0, 10);
  const tasks = [job('k', 'Client K', due),
    { ...st('kds', 'k', 'Design', 'Creative lead', 0, before(t0), addWorkingDays(t0, 2)), status: 'in progress' },
    st('kpf', 'k', 'Package files', 'Studio', 2, addWorkingDays(t0, 3), addWorkingDays(t0, 3), ['kds']),
    st('kir', 'k', 'Internal review', 'Account lead', 1, addWorkingDays(t0, 3), addWorkingDays(t0, 3), ['kpf']), // the same day on the card
    st('kdl', 'k', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 6), addWorkingDays(t0, 8), ['kir'])];
  const live = liveOf(tasks);
  const r = replanLive(live, env, null);
  const day = (id, f) => dayNumber(r.live.tree.byId.get(id)[f], env);
  assert.equal(day('kds', 'due'), addWorkingDays(t0, 2)); // started: untouched
  assert.equal(day('kpf', 'start'), addWorkingDays(t0, 3)); // the working day after Design's card due date
  assert.equal(day('kir', 'start'), addWorkingDays(t0, 4)); // no longer the same day as the files
  assert.equal(day('kdl', 'start'), addWorkingDays(t0, 5)); // the send, a working day earlier than planned
  assert.deepEqual(r.rows.map((x) => [x.send_before, x.send_after, x.late_after]), [[isoDay(addWorkingDays(t0, 6)), isoDay(addWorkingDays(t0, 5)), false]]);
  assert.ok(!r.changes.some((c) => c.step.id === 'kds'));
});

test('one capacity rule: a move goes to the first day it fits the owner\'s whole day on the cards, and the next check calls none of the moved steps over-full', async () => {
  const fri = (() => {
    let x = addWorkingDays(t0, 3);
    while (new Date(x * DAY_MS).getUTCDay() !== 5 || !isWorkingDay(x) || !isWorkingDay(x + 3) || !isWorkingDay(x + 4)) x += 1;
    return x;
  })();
  const mon = addWorkingDays(fri, 1); const tue = addWorkingDays(mon, 1);
  const queued = (id, client, due) => ({ ...job(id, client, due), status: 'to do' });
  // As P and K, with a third job's 5 h of studio work on Monday: K's 8 h of files cannot also go on Monday.
  const tasks = [queued('p', 'Client P', tue), queued('k', 'Client K', addWorkingDays(fri, 8)), queued('m', 'Client M', addWorkingDays(fri, 9)),
    st('ppf', 'p', 'Package files', 'Studio', 8, fri, fri), st('pir', 'p', 'Internal review', 'Account lead', 1, mon, mon, ['ppf']),
    st('pdl', 'p', 'Deliver', 'Account lead', 0.5, tue, addWorkingDays(tue, 2), ['pir']),
    st('kpf', 'k', 'Package files', 'Studio', 8, fri, fri), st('kir', 'k', 'Internal review', 'Account lead', 1, addWorkingDays(mon, 2), addWorkingDays(mon, 2), ['kpf']),
    st('kdl', 'k', 'Deliver', 'Account lead', 0.5, addWorkingDays(mon, 3), addWorkingDays(mon, 5), ['kir']),
    st('mpf', 'm', 'Package files', 'Studio', 5, mon, mon)];
  const live = liveOf(tasks);
  const r = leastSlackFirst(live, env, { ...ctx, walks: new Map() }, ['p', 'k', 'm'].map((x) => live.tree.byId.get(x)));
  const kpf = r.drags.find((x) => x.step === 'Package files' && x.card === 'Client K: launch');
  assert.equal(kpf.to, isoDay(tue)); // Monday holds M's 5 h; 8 h more would pass the studio's 8 h day
  // The moves made on the cards, start and due as listed; then K's check.
  const changes = r.drags.map((x) => ({ unit: live.tree.byId.get('k'), step: tasks.find((t) => t.parent === 'k' && t.name === x.step), owner: null,
    start: dayNumber(Date.parse(x.to), env), due: dayNumber(Date.parse(x.to_due), env) }));
  const world = buildLive(env, changedTree(live.tree, changes, env), live.intakeTree, live.members);
  const h = await healthOf(world.tree.byId.get('k'), world.tree, world, env, { ...ctx, walks: new Map() });
  for (const x of r.drags) assert.notEqual(h.step_days.find((s) => s.step === x.step)?.reason?.kind, 'full', `${x.step} called over-full`);
  assert.ok(rewalk(world, world.tree.byId.get('p'), env, {}).send_past_due <= 0);
});

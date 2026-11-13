// Scenario tests for the Makers tools: one hard case per test, its answer worked out by hand. A test marked
// expectFailure states the answer the engine should give and does not give yet: it passes while the engine gives the
// wrong answer and fails once the defect is fixed, when the mark is removed.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, against } from '../engine.js';
import { leastSlackFirst, buildLive, changedTree, rewalk, healthOf } from '../tools.js';
import { makeTree, today, isWorkingDay, nextWorkingDay, addWorkingDays, isoDay, dayNumber, bookings, bookingsBy, DAY_MS } from '../data.js';

// --- the engine on its own: fixed days in November 2026 (Mon 2, Fri 6, Mon 9 ... Thu 26 and Fri 27 are holidays) ---
const D = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;
const NOV = (d) => D(2026, 11, d);
const CAP = { Copywriter: 40, Studio: 40, 'Creative lead': 22, 'Account lead': 16 };
const step = (id, name, owners, hours, extra = {}) => ({
  id, name, owners, ownerLabel: owners.join(', ') || 'no owner', hours, sizeNote: null,
  plannedStart: null, plannedDue: null, waitsOn: [], ...extra,
});
const bookedEvery = (person, from, to, hoursPerDay, into = new Map()) => {
  const m = into.get(person) || new Map();
  for (let d = from; d <= to; d++) m.set(d, hoursPerDay);
  into.set(person, m);
  return into;
};
const plan = (steps, extra = {}) => schedule({ mode: 'plan', today: NOV(2), capacity: CAP, booked: new Map(), steps, ...extra });
const recover = (steps, extra = {}) => schedule({ mode: 'recovery', today: NOV(2), capacity: CAP, booked: new Map(), steps, ...extra });
const get = (r, id) => r.plan.find((p) => p.id === id);
// No working days either side: the engine gives -0 for a day on its target, which prints and compares as 0.
const zero = (x) => assert.ok(x === 0, `expected 0 working days, got ${x}`);
const datesOf = (r) => Object.fromEntries(r.plan.map((p) => [p.id, [p.start, p.due]]));

// --- the tools on hand-built cards, dated from today (the tools read today's date) ---
const env = { TIME_ZONE: 'UTC' };
const t0 = nextWorkingDay(today(env));
const ms = (d) => d * DAY_MS;
const ctx = { terms: null, clientsById: new Map(), retainer: new Map(), entries: async () => [] };
const job = (id, client, due, status = 'in progress') => ({ id, name: `${client}: launch`, parent: null, type: 0, status, closed: false,
  start: null, due: ms(due), estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [],
  f: { Client: [{ id: `c${id}`, name: client }], 'Agreement type': 'Fixed fee', Budget: 2000, Rate: 65 } });
const st = (id, parent, name, owner, hours, start, due, waitsOn = [], extra = {}) => ({ id, name, parent, type: 0, status: 'to do', closed: false,
  start: ms(start), due: ms(due), estimate: hours, tracked: 0, people: owner ? [owner] : [], teams: [], waitsOn, f: {}, ...extra });
const liveOf = (tasks, members = new Map()) => {
  const tree = makeTree(tasks);
  const steps = tasks.filter((t) => t.parent);
  const unitOfStep = new Map(steps.map((s) => [s.id, tree.byId.get(s.parent)]));
  const label = (s) => `${tree.byId.get(s.parent).f.Client[0].name}'s ${s.name}`;
  return { tree, intakeTree: makeTree([]), members, steps, unitOfStep, booked: bookings(steps, env, members), bookedBy: bookingsBy(steps, env, members, label) };
};
const reshuffle = (live, ids) => leastSlackFirst(live, env, { ...ctx, walks: new Map() }, ids.map((k) => live.tree.byId.get(k)));

// 1. No slack at all.
test('no slack: a send that lands exactly on its Due date is on time, and a half hour more of other work makes it a day late', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 8, { plannedStart: NOV(2), plannedDue: NOV(2) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['w'], plannedStart: NOV(3), plannedDue: NOV(5) })];
  const exact = recover(steps, { promise: NOV(3) });
  assert.equal(exact.send, NOV(3));
  zero(exact.send_past_due);
  assert.equal(exact.first_break, null);
  assert.equal(against(exact.send_past_due, exact.promise, 'its Due date'), 'on its Due date');
  // a quarter hour of other work still fits the day (the engine's quarter-hour rule); a half hour does not
  zero(recover(steps, { promise: NOV(3), booked: bookedEvery('Copywriter', NOV(2), NOV(2), 0.25) }).send_past_due);
  const over = recover(steps, { promise: NOV(3), booked: bookedEvery('Copywriter', NOV(2), NOV(2), 0.5) });
  assert.equal(over.send, NOV(4));
  assert.equal(over.send_past_due, 1);
  assert.equal(over.first_break.step, 'Write copy');
});

test('no slack: an owner booked to the cap every day for three weeks pushes the step to the first free week, and the reason says the week is full', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 4, { plannedStart: NOV(2), plannedDue: NOV(3) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['w'], plannedStart: NOV(4), plannedDue: NOV(6) })];
  const r = recover(steps, { promise: NOV(6), booked: bookedEvery('Copywriter', NOV(2), NOV(20), 8) });
  assert.equal(get(r, 'w').start, NOV(23));
  assert.equal(get(r, 'w').due, NOV(23));
  assert.match(get(r, 'w').reason, /waits for Copywriter until Mon, Nov 23: Copywriter's week of Mon, Nov 2 is full, 40 h booked of 40 h at 100%/);
  assert.equal(r.send, NOV(24));
  assert.equal(r.first_break.step, 'Write copy');
  assert.ok(get(r, 'w').clash); // the reshuffle can see where the step met other work
});

test('no slack, ever: an owner with no free hour in the engine\'s whole horizon does not show the step starting today', { expectFailure: 'known limit: an owner with no free hour in the 500-working-day horizon is shown starting the step today' }, () => {
  const r = recover([step('w', 'Write copy', ['Copywriter'], 4, { plannedStart: NOV(2), plannedDue: NOV(3) })],
    { booked: bookedEvery('Copywriter', NOV(2), NOV(2) + 1000, 8) });
  assert.match(get(r, 'w').reason, /not enough free time in the next 500 working days/);
  assert.doesNotMatch(get(r, 'w').reason, /starts Mon, Nov 2, today/); // no hour of it fits Mon, Nov 2
  assert.ok(get(r, 'w').start > NOV(2));
});

// 2. The step with the least slack is not the one that breaks first.
test('least slack is not what breaks: the step that ends exactly on its planned due date holds, the one with two days in hand breaks', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 8, { plannedStart: NOV(2), plannedDue: NOV(2) }), // no slack
    step('pf', 'Package files', ['Studio'], 4, { waitsOn: ['w'], plannedStart: NOV(3), plannedDue: NOV(5) }), // two days in hand
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf'], plannedStart: NOV(6), plannedDue: NOV(10) })];
  const r = recover(steps, { promise: NOV(6), booked: bookedEvery('Studio', NOV(3), NOV(6), 8) });
  assert.equal(get(r, 'w').due, NOV(2));
  assert.equal(get(r, 'w').late, false);
  assert.equal(get(r, 'pf').start, NOV(9));
  assert.equal(r.first_break.step, 'Package files');
});

test('a slip the chain absorbs is not the step that breaks: the step that makes the send late is named', { expectFailure: 'known limit: the first late step is named, not the step whose wait makes the send late' }, () => {
  // Write copy runs a day past its planned due date, but Package files has a day in hand and catches up; the send
  // goes late only because the account lead's days are full when Internal review is due.
  const steps = [step('w', 'Write copy', ['Copywriter'], 12, { plannedStart: NOV(2), plannedDue: NOV(2) }),
    step('pf', 'Package files', ['Studio'], 4, { waitsOn: ['w'], plannedStart: NOV(5), plannedDue: NOV(5) }),
    step('ir', 'Internal review', ['Account lead'], 1, { waitsOn: ['pf'], plannedStart: NOV(6), plannedDue: NOV(6) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['ir'], plannedStart: NOV(9), plannedDue: NOV(11) })];
  const control = recover(steps, { promise: NOV(9) });
  assert.equal(get(control, 'w').late, true); // the copy is a day over ...
  assert.ok(control.send_past_due <= 0); // ... and the send is still on time: the slip is absorbed
  const r = recover(steps, { promise: NOV(9), booked: bookedEvery('Account lead', NOV(5), NOV(13), 3.2) });
  assert.ok(r.send_past_due > 0);
  assert.equal(get(r, 'ir').start, NOV(16));
  assert.equal(r.first_break.step, 'Internal review'); // the engine names Write copy
});

// 3. Two jobs late on the same person: saving one makes the other late.
test('two jobs late on the studio\'s one day: the reshuffle saves one, says no reshuffle saves the other, and claims no more', () => {
  // A's and B's 8 h of files are both planned on day d, a full studio day each; each sends on d+1, its Due date.
  // On the forecast each waits for the other and both send a day late. Only one can have day d.
  const d = addWorkingDays(t0, 3);
  const tasks = [job('a', 'Client A', addWorkingDays(d, 1), 'to do'), job('b', 'Client B', addWorkingDays(d, 1), 'to do'),
    st('apf', 'a', 'Package files', 'Studio', 8, d, d), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['apf']),
    st('bpf', 'b', 'Package files', 'Studio', 8, d, d), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['bpf'])];
  const live = liveOf(tasks);
  for (const k of ['a', 'b']) assert.equal(rewalk(live, live.tree.byId.get(k), env, {}).send_past_due, 1);
  const r = reshuffle(live, ['a', 'b']);
  assert.deepEqual(r.saved, ['Client A: launch']); // the same slack and Due date: the tie goes the same way every time
  assert.deepEqual(r.not_saved, ['Client B: launch']);
  assert.equal(r.every_job_sends_by_due_date, false);
  assert.deepEqual(r.drags.map((x) => [x.card, x.step, x.from, x.to, x.follows]), [ // its Deliver follows it
    ['Client B: launch', 'Package files', isoDay(d), isoDay(addWorkingDays(d, 1)), null],
    ['Client B: launch', 'Deliver', isoDay(addWorkingDays(d, 1)), isoDay(addWorkingDays(d, 2)), 'Package files']]);
  assert.deepEqual(r.sends_after_drags, [{ card: 'Client A: launch', send: isoDay(addWorkingDays(d, 1)), due_date: isoDay(addWorkingDays(d, 1)) }]);
  assert.match(r.suggestion, /Client A sends .*, on its Due date; no other job goes late; no reshuffle saves Client B; the Delivery lead decides$/);
  assert.doesNotMatch(r.suggestion, /Client B sends/);
  // B, already a day late, is no later once the drags are made
  const world = buildLive(env, changedTree(live.tree, r.drags.map((x) => ({ unit: live.tree.byId.get('b'),
    step: tasks.find((t) => t.parent === 'b' && t.name === x.step), owner: null, start: dayNumber(Date.parse(x.to), env), due: null })), env), live.intakeTree, live.members);
  assert.equal(rewalk(world, world.tree.byId.get('b'), env, {}).send_past_due, 1);
  assert.ok(rewalk(world, world.tree.byId.get('a'), env, {}).send_past_due <= 0);
});

// 4. A Team step where every member is booked.
test('a Team step with every member booked waits for the Team\'s first free day and names the full week', () => {
  const team = ['Studio', 'Copywriter']; // a two-person Studio Team for this case
  const booked = bookedEvery('Copywriter', NOV(2), NOV(6), 8, bookedEvery('Studio', NOV(2), NOV(6), 8));
  const r = recover([step('pf', 'Package files', team, 6, { ownerLabel: 'the Studio Team (Studio, Copywriter)', plannedStart: NOV(2), plannedDue: NOV(2) })], { booked });
  assert.equal(get(r, 'pf').start, NOV(9));
  assert.equal(get(r, 'pf').due, NOV(9));
  assert.match(get(r, 'pf').reason, /waits for the Studio Team until Mon, Nov 9: Studio and Copywriter's week of Mon, Nov 2 is full, 80 h booked of 80 h at 100%/);
});

test('a Team step with one member full and one free books its hours on the free member only', { expectFailure: 'known limit: a Team step\'s hours are split evenly across its members, whatever each has free' }, () => {
  const team = ['Studio', 'Copywriter'];
  const r = recover([step('pf', 'Package files', team, 8, { ownerLabel: 'the Studio Team (Studio, Copywriter)', plannedStart: NOV(2), plannedDue: NOV(2) })],
    { booked: bookedEvery('Studio', NOV(2), NOV(2), 8) });
  assert.equal(get(r, 'pf').due, NOV(2)); // the copywriter's free day takes all 8 h
  assert.equal(r.placed.get('Copywriter')?.get(NOV(2)) ?? 0, 8);
  assert.equal(r.placed.get('Studio')?.get(NOV(2)) ?? 0, 0); // the engine books 4 h here, on a day already at 8 h
});

// 5. A requested date before the earliest feasible date.
test('a requested date before the earliest Feasible date is reported as missed by the working days, and the plan is not squeezed to meet it', () => {
  // 12 h of copy in a three-day window, Mon to Wed; the files out Thu 5; the Feasible date Mon 9
  const steps = [step('w', 'Write copy', ['Copywriter'], 12), step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['w'] })];
  const free = plan(steps);
  assert.equal(free.send, NOV(5));
  assert.equal(free.feasible, NOV(9));
  const asked = plan(steps, { requested: NOV(4) });
  assert.equal(asked.feasible_past_requested, 3); // Thu, Fri, Mon
  assert.equal(against(asked.feasible_past_requested, asked.requested, 'the requested date'), '3 working days after the requested date (Wed, Nov 4)');
  assert.deepEqual(datesOf(asked), datesOf(free)); // the same plan with or without the request
  assert.equal(plan(steps, { requested: D(2026, 10, 30) }).feasible_past_requested, 6); // a requested date already past
  zero(plan(steps, { requested: NOV(9) }).feasible_past_requested);
  assert.equal(plan(steps, { requested: NOV(10) }).feasible_past_requested, -1);
});

// 6. A step with zero hours and a step with no owner.
test('a step with zero hours books nothing and holds a day; a step with no owner holds its planned window; the chain still sends', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 0, { plannedStart: NOV(2), plannedDue: NOV(3) }),
    step('pf', 'Package files', [], 4, { waitsOn: ['w'], plannedStart: NOV(4), plannedDue: NOV(5) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf'], plannedStart: NOV(6), plannedDue: NOV(10) })];
  const r = recover(steps, { promise: NOV(6) });
  assert.deepEqual([get(r, 'w').start, get(r, 'w').due], [NOV(2), NOV(2)]);
  assert.match(get(r, 'w').reason, /no hours to place: held one working day/);
  assert.deepEqual([get(r, 'pf').start, get(r, 'pf').due], [NOV(3), NOV(4)]); // its two planned days, from the day after the copy
  assert.match(get(r, 'pf').reason, /no owner on record, so no capacity to read: held its planned window/);
  assert.equal(r.send, NOV(5));
  assert.deepEqual([...r.placed.keys()], ['Account lead']); // only Deliver's half hour is booked
});

test('the Health check flags a step left on its Team with no person, starting today', async () => {
  const unit = job('u', 'Client Z', addWorkingDays(t0, 10));
  const tasks = [unit, st('pf', 'u', 'Package files', null, 4, t0, t0, [], { teams: ['Studio'] }),
    st('dl', 'u', 'Deliver', 'Account lead', 0.5, addWorkingDays(t0, 1), addWorkingDays(t0, 3), ['pf'])];
  const live = liveOf(tasks, new Map([['Studio', ['Studio']]]));
  const h = await healthOf(live.tree.byId.get('u'), live.tree, live, env, ctx);
  const check = h.checks.find((c) => c.check === 'No owner');
  assert.equal(check.level, 'At risk');
  assert.match(check.detail, /^Package files is still on the Studio Team with no person, starting /);
});

// 7. The 80% cap at a week's edge.
test('the 80% cap at the week\'s edge: hours that fit Friday\'s day but not what is left of the week go to the next week', () => {
  // 7.5 h of other copy Mon to Thu: 30 h of the copywriter's 32 h week at 80%, so Friday's 6.4 h day has 2 h of week left
  const booked = () => bookedEvery('Copywriter', NOV(2), NOV(5), 7.5);
  const three = plan([step('w', 'Write copy', ['Copywriter'], 3)], { booked: booked() });
  assert.equal(get(three, 'w').start, NOV(9)); // 3 h fit Friday's day, not the week
  const two = plan([step('w', 'Write copy', ['Copywriter'], 2)], { booked: booked() });
  assert.equal(get(two, 'w').start, NOV(6)); // 2 h fit both
  const at100 = plan([step('w', 'Write copy', ['Copywriter'], 3)], { booked: booked(), capPct: 100 });
  assert.equal(get(at100, 'w').start, NOV(6)); // at 100% the week has 10 h left
});

// 8. The 100% recovery mode uses the reserve.
test('the recovery plan at 100% uses the 20% held back to bring the send inside the Due date, and never books past the day', () => {
  // The copywriter's days are booked to 80% (6.4 h) for two weeks. New work at 80% has no room until Mon 16; the
  // re-walk at 100% fits the 4 h into the 1.6 h a day held back.
  const booked = () => bookedEvery('Copywriter', NOV(2), NOV(13), 6.4);
  const steps = [step('w', 'Write copy', ['Copywriter'], 4, { plannedStart: NOV(2), plannedDue: NOV(3) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['w'], plannedStart: NOV(4), plannedDue: NOV(6) })];
  const asNew = plan(steps.map((s) => ({ ...s, plannedStart: null, plannedDue: null })), { booked: booked(), promise: NOV(6) });
  assert.equal(get(asNew, 'w').start, NOV(16));
  assert.ok(asNew.send_past_due > 0);
  const r = recover(steps, { booked: booked(), promise: NOV(6) });
  assert.deepEqual([get(r, 'w').start, get(r, 'w').due], [NOV(2), NOV(4)]); // 1.6 h Mon, 1.6 h Tue, 0.8 h Wed
  assert.equal(r.send, NOV(5));
  assert.equal(r.send_past_due, -1);
  for (const [d, h] of r.placed.get('Copywriter')) assert.ok(6.4 + h <= 8 + 1e-9, `day ${isoDay(d)} booked past 8 h`);
});

// 9. Deliver and the buffer across a weekend and Thanksgiving.
test('the buffer across a weekend and the 26 and 27 Nov holidays: Friday, Wednesday before, and a send that would fall on the holiday', () => {
  const dl = [step('dl', 'Deliver', ['Account lead'], 0.5, { signOffDays: 3 })];
  const fri = plan(dl, { today: NOV(20), capPct: 100 });
  assert.equal(fri.send, NOV(20));
  assert.equal(fri.feasible, NOV(24)); // Mon 23, Tue 24
  assert.equal(fri.lands, NOV(24));
  const wed = plan(dl, { today: NOV(25), capPct: 100 });
  assert.equal(wed.feasible, D(2026, 12, 1)); // Thu 26 and Fri 27 skipped, the weekend, Mon 30, Tue 1
  assert.equal(wed.lands, D(2026, 12, 1));
  assert.match(get(wed, 'dl').reason, /skips Thu, Nov 26 and Fri, Nov 27 \(holidays\)/);
  const onHoliday = plan(dl, { today: NOV(27), capPct: 100 });
  assert.equal(onHoliday.send, NOV(30)); // files never go out on a holiday
  // files finished Wed 25: Deliver the next working day, Mon 30, one working day past a Due date of Fri 27
  const chain = recover([step('pf', 'Package files', ['Studio'], 8), step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf'], signOffDays: 3 })],
    { today: NOV(25), promise: NOV(27) });
  assert.equal(chain.send, NOV(30));
  assert.equal(chain.feasible, D(2026, 12, 2));
  assert.equal(chain.send_past_due, 1);
});

// 10. A what-if that gives a step to someone off its Team.
test('a what-if that gives the studio\'s files to the copywriter, off the Studio Team, moves the booking to the copywriter and brings the job back', () => {
  // J, approved at To do (held to its planned starts), has 6 h of files on day d on the Studio Team; Studio's d and
  // d+1 are full with O's files, so J sends late; the copywriter is free.
  const d = addWorkingDays(t0, 3);
  const tasks = [job('j', 'Client J', addWorkingDays(d, 1), 'to do'), job('o', 'Client O', addWorkingDays(d, 10)),
    st('jpf', 'j', 'Package files', null, 6, d, d, [], { teams: ['Studio'] }), st('jdl', 'j', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['jpf']),
    st('opf', 'o', 'Package files', 'Studio', 16, d, addWorkingDays(d, 1)), st('odl', 'o', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 4), addWorkingDays(d, 6), ['opf'])];
  const members = new Map([['Studio', ['Studio']], ['Copy', ['Copywriter']]]);
  const live = liveOf(tasks, members);
  const asIs = rewalk(live, live.tree.byId.get('j'), env, {});
  assert.ok(asIs.send_past_due > 0);
  const changes = [{ unit: live.tree.byId.get('j'), step: live.tree.byId.get('jpf'), owner: 'Copywriter', start: null, due: null }];
  const tree = changedTree(live.tree, changes, env);
  assert.deepEqual([tree.byId.get('jpf').people, tree.byId.get('jpf').teams], [['Copywriter'], []]); // off the Studio Team
  const world = buildLive(env, tree, live.intakeTree, live.members);
  assert.equal(world.booked.get('Copywriter').get(d), 6);
  assert.equal(world.booked.get('Studio').get(d), 8); // only O's files left on Studio's day
  const j = rewalk(world, world.tree.byId.get('j'), env, {});
  assert.equal(j.plan.find((p) => p.id === 'jpf').owner, 'Copywriter');
  assert.ok(j.send_past_due <= 0);
  assert.equal(rewalk(world, world.tree.byId.get('o'), env, {}).send, rewalk(live, live.tree.byId.get('o'), env, {}).send); // O unchanged
});

test('the engine alone holds a step given to someone with no hours on record on its planned days, so Test a fix refuses such an owner', () => {
  // Not a defect: test_a_fix rejects an owner with no capacity before the engine runs (tools.js, the changes'
  // check), because the engine would otherwise show the slip as fixed.
  const steps = [step('pf', 'Package files', ['Studio'], 6, { plannedStart: NOV(2), plannedDue: NOV(2) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf'], plannedStart: NOV(3), plannedDue: NOV(5) })];
  const booked = bookedEvery('Studio', NOV(2), NOV(6), 8);
  assert.ok(recover(steps, { booked, promise: NOV(3) }).send_past_due > 0);
  const tried = recover(steps, { booked, promise: NOV(3), whatIf: { step: 'Package files', owner: 'Delivery lead', start: null } });
  assert.match(get(tried, 'pf').reason, /no capacity on record for Delivery lead: held its planned window/);
  zero(tried.send_past_due);
});

// 11. A loop in the waits-on links.
test('a loop in the waits-on links: the plan still finishes, every step is placed once, and the same input gives the same plan', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 4, { waitsOn: ['pf'] }), step('pf', 'Package files', ['Studio'], 4, { waitsOn: ['w'] }),
    step('self', 'Internal review', ['Account lead'], 1, { waitsOn: ['self', 'pf'] }), step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['self'] })];
  for (const run of [plan, recover]) {
    const r = run(steps);
    assert.deepEqual(r.plan.map((p) => p.id).sort(), ['dl', 'pf', 'self', 'w']);
    assert.ok(get(r, 'pf').start > get(r, 'w').due); // the loop broken at the first step in order, then the links hold
    assert.ok(get(r, 'dl').start > get(r, 'self').due);
    assert.equal(JSON.stringify(datesOf(run(steps))), JSON.stringify(datesOf(r)));
  }
});

test('a loop in the waits-on links: Test a fix moves only the step moved and the re-walk still places the chain', () => {
  const d = addWorkingDays(t0, 3);
  const tasks = [job('k', 'Client K', addWorkingDays(d, 8)),
    st('kpf', 'k', 'Package files', 'Studio', 3, d, d, ['kir']), st('kir', 'k', 'Internal review', 'Account lead', 1, addWorkingDays(d, 1), addWorkingDays(d, 1), ['kpf']),
    st('kdl', 'k', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 2), addWorkingDays(d, 4), ['kir'])];
  const live = liveOf(tasks);
  const changes = [{ unit: live.tree.byId.get('k'), step: live.tree.byId.get('kpf'), owner: null, start: addWorkingDays(d, 1), due: null }];
  const tree = changedTree(live.tree, changes, env);
  assert.deepEqual(changes[0].pushed, []); // Reschedule Dependencies off: nothing else moves
  assert.equal(dayNumber(tree.byId.get('kpf').start, env), addWorkingDays(d, 1));
  assert.equal(dayNumber(tree.byId.get('kir').start, env), addWorkingDays(d, 1));
  const w = rewalk(buildLive(env, tree, live.intakeTree, live.members), tree.byId.get('k'), env, {});
  assert.ok(w.send !== null);
});

// 12. The same plan from inputs given in a different order.
test('the same plan from inputs in a different order: the steps and the other work shuffled give the same dates', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 12, { plannedStart: NOV(3), plannedDue: NOV(5) }),
    step('rc', 'Review copy', ['Creative lead'], 1, { waitsOn: ['w'] }),
    step('ds', 'Design', ['Creative lead'], 2, { waitsOn: ['rc'], agencyDays: 7 }), step('pf', 'Package files', ['Studio'], 3, { waitsOn: ['ds'] }),
    step('ir', 'Internal review', ['Account lead'], 1, { waitsOn: ['pf'] }), step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['ir'], signOffDays: 3 })];
  const booked1 = bookedEvery('Studio', NOV(16), NOV(18), 6, bookedEvery('Copywriter', NOV(2), NOV(13), 5));
  const booked2 = new Map([...bookedEvery('Copywriter', NOV(2), NOV(13), 5, bookedEvery('Studio', NOV(16), NOV(18), 6))].reverse()
    .map(([p, m]) => [p, new Map([...m].reverse())]));
  for (const run of [plan, recover]) {
    const a = run(steps, { booked: booked1, promise: NOV(27) });
    const b = run([...steps].reverse(), { booked: booked2, promise: NOV(27) });
    assert.deepEqual(datesOf(b), datesOf(a));
    assert.deepEqual([b.send, b.feasible, b.send_past_due], [a.send, a.feasible, a.send_past_due]);
  }
});

test('the same reshuffle from cards and jobs given in a different order', () => {
  const d = addWorkingDays(t0, 3);
  const tasks = [job('a', 'Client A', addWorkingDays(d, 1), 'to do'), job('b', 'Client B', addWorkingDays(d, 1), 'to do'),
    st('apf', 'a', 'Package files', 'Studio', 8, d, d), st('adl', 'a', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['apf']),
    st('bpf', 'b', 'Package files', 'Studio', 8, d, d), st('bdl', 'b', 'Deliver', 'Account lead', 0.5, addWorkingDays(d, 1), addWorkingDays(d, 3), ['bpf'])];
  const one = reshuffle(liveOf(tasks), ['a', 'b']);
  const two = reshuffle(liveOf([...tasks].reverse()), ['b', 'a']);
  for (const k of ['suggestion', 'saved', 'not_saved', 'drags', 'sends_after_drags']) assert.deepEqual(two[k], one[k], k);
});

test('the same plan from steps in a different order when two steps share an owner and a planned start', { expectFailure: 'known limit: two steps with the same owner and planned start are placed in the order they are listed' }, () => {
  // Package files and Produce video, both the studio's, both planned from Mon 2, neither waiting on the other: the
  // order the steps arrive in should not decide which one the studio does first.
  const steps = [step('pf', 'Package files', ['Studio'], 8, { plannedStart: NOV(2), plannedDue: NOV(3) }),
    step('pv', 'Produce video', ['Studio'], 8, { plannedStart: NOV(2), plannedDue: NOV(3) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf', 'pv'], plannedStart: NOV(4), plannedDue: NOV(6) })];
  const a = recover(steps);
  const b = recover([steps[1], steps[0], steps[2]]);
  assert.equal(b.send, a.send); // with Deliver waiting on both, the send agrees
  // with Deliver waiting on the files only, the send itself moves: Tue 3 with the files first in the list, Wed 4 without
  const filesOnly = { ...steps[2], waitsOn: ['pf'] };
  assert.equal(recover([steps[1], steps[0], filesOnly]).send, recover([steps[0], steps[1], filesOnly]).send);
  assert.deepEqual(datesOf(b), datesOf(a)); // whichever step comes first in the list goes Monday
});

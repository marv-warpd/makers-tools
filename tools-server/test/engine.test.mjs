// Unit tests for the scheduling engine: one test per rule, on small hand-built cases with known answers.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../engine.js';
import { bookings, bookingsBy, withoutBy, ownersOf, DAY_MS, dayText } from '../data.js';

const D = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS; // a calendar day as the engine's day number
const CAP = { Copywriter: 40, Studio: 40, 'Creative lead': 22, 'Account lead': 16 };
const step = (id, name, owners, hours, extra = {}) => ({
  id, name, owners, ownerLabel: owners.join(', ') || 'no owner', hours, sizeNote: null,
  plannedStart: null, plannedDue: null, waitsOn: [], ...extra,
});
const bookedEvery = (person, from, to, hoursPerDay) => {
  const m = new Map();
  for (let d = from; d <= to; d++) m.set(d, hoursPerDay);
  return new Map([[person, m]]);
};
const run = (steps, extra = {}) => schedule({ mode: 'plan', today: D(2026, 11, 2), capPct: 100, capacity: CAP, booked: new Map(), steps, ...extra });
const recover = (steps, extra = {}) => schedule({ mode: 'recovery', today: D(2026, 11, 2), capacity: CAP, booked: new Map(), steps, ...extra });
const get = (r, id) => r.plan.find((p) => p.id === id);

test('weekend: a step running past Friday picks up on Monday', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 12)], { today: D(2026, 11, 5) }); // Thu 5 Nov, a 3-day window
  assert.equal(get(r, 'w').start, D(2026, 11, 5));
  assert.equal(get(r, 'w').due, D(2026, 11, 9)); // Thu, Fri, Mon
});

test('holiday: Thanksgiving and the day after are skipped, and the reason says so', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 8)], { today: D(2026, 11, 25) }); // a 2-day window
  assert.equal(get(r, 'w').due, D(2026, 11, 30));
  assert.match(get(r, 'w').reason, /skips Thu, Nov 26 and Fri, Nov 27 \(holidays\)/);
});

test('Veterans Day (11 Nov) is a working day', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 8)], { today: D(2026, 11, 10) }); // a 2-day window: Tue, Wed
  assert.equal(get(r, 'w').due, D(2026, 11, 11));
});

test('a Team-owned step: its hours book on the Team member, and every mode plans it on the member\'s free time that day', () => {
  const members = new Map([['Copy', ['Copywriter']], ['Studio', ['Studio']]]);
  const teamStep = { people: [], teams: ['Copy'], estimate: 8, start: D(2026, 11, 2) * DAY_MS, due: D(2026, 11, 3) * DAY_MS };
  const b = bookings([teamStep], { TIME_ZONE: 'UTC' }, members);
  assert.equal(b.get('Copywriter').get(D(2026, 11, 2)), 4);
  assert.deepEqual(ownersOf(teamStep, members), ['Copywriter']);
  // other work fills the Copywriter's Monday: a new plan and the re-walk both start the Team's step on Tuesday
  // (one rule for every mode: each day's free time)
  const busyMonday = bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 2), 8);
  const planned = run([step('t', 'Write copy', ownersOf(teamStep, members), 8, { ownerLabel: 'the Copy Team (Copywriter)' })], { booked: busyMonday });
  assert.equal(get(planned, 't').start, D(2026, 11, 3));
  assert.match(get(planned, 't').reason, /the Copy Team \(Copywriter\)/);
  const walked = recover([step('t', 'Write copy', ['Copywriter'], 8, { plannedStart: D(2026, 11, 2), plannedDue: D(2026, 11, 2) })], { booked: busyMonday });
  assert.equal(walked.plan[0].start, D(2026, 11, 3));
  assert.equal(walked.plan[0].due, D(2026, 11, 3));
});

test('a fully booked owner: the step waits for the next week with room, and the reason gives the load', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 4)],
    { capPct: 80, booked: bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 6), 8) });
  assert.equal(get(r, 'w').start, D(2026, 11, 9));
  assert.match(get(r, 'w').reason, /waits for Copywriter until Mon, Nov 9: Copywriter's week of Mon, Nov 2 is full, 40 h booked of 32 h at 80%: 40 h of other work is booked in Copywriter's time that week/);
});

test('the agency window: the working day after the review, one day to release plus the turnaround', () => {
  const r = run([
    step('rc', 'Review copy', ['Creative lead'], 1),
    step('ds', 'Design', ['Creative lead'], 2, { waitsOn: ['rc'], agencyDays: 11, agencyNote: 'one working day to release the brief and 10 days' }),
  ], { today: D(2026, 11, 4) });
  assert.equal(get(r, 'rc').due, D(2026, 11, 4));
  assert.equal(get(r, 'ds').start, D(2026, 11, 5)); // the working day after the review
  assert.equal(get(r, 'ds').due, D(2026, 11, 19)); // 11 working days: Thu 5 to Thu 19
  assert.match(get(r, 'ds').reason, /the agency's window, 11 working days/);
});

test('the window rule: a production step takes no more than half its owner\'s day; a review one day', () => {
  // Write copy 5.5 h -> 2 days; Package files 2 h -> 1 day; the review one day, the working day after the writing ends
  // (no same-day review)
  const r = run([step('w', 'Write copy', ['Copywriter'], 5.5), step('rc', 'Review copy', ['Creative lead'], 1, { waitsOn: ['w'] }),
    step('pf', 'Package files', ['Studio'], 2, { waitsOn: ['rc'] })], { capPct: 80 });
  assert.equal(get(r, 'w').start, D(2026, 11, 2));
  assert.equal(get(r, 'w').due, D(2026, 11, 3));
  assert.equal(get(r, 'rc').start, D(2026, 11, 4));
  assert.equal(get(r, 'rc').due, D(2026, 11, 4));
  assert.equal(get(r, 'pf').start, D(2026, 11, 5));
  assert.equal(get(r, 'pf').due, D(2026, 11, 5));
  // a busy owner: the window moves to where each of its days has room for its share (2.75 h)
  const busy = run([step('w', 'Write copy', ['Copywriter'], 5.5)], { capPct: 80, booked: bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 3), 5) });
  assert.equal(get(busy, 'w').start, D(2026, 11, 4)); // Mon and Tue have 1.4 h free at 80%
  assert.equal(get(busy, 'w').due, D(2026, 11, 5));
});

test('missing estimates: a step with no hours holds one working day and says so', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 0)]);
  assert.equal(get(r, 'w').start, get(r, 'w').due);
  assert.match(get(r, 'w').reason, /no hours to place: held one working day/);
});

test('a step with no owner on record holds its window and says so', () => {
  const r = run([step('w', 'Write copy', [], 6)]);
  assert.match(get(r, 'w').reason, /no owner on record/);
});

test('80% against 100%: the same work finishes later at the 80% cap', () => {
  const steps = [step('w', 'Write copy', ['Copywriter'], 16)];
  const booked = bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 6), 4); // 20 of 40 h already booked
  const at80 = run(steps, { capPct: 80, booked });
  const at100 = run(steps, { capPct: 100, booked });
  assert.equal(at100.plan[0].due, D(2026, 11, 5)); // 4 h free a day: the 4-day window Mon to Thu, 4 h a day
  assert.equal(at80.plan[0].due, D(2026, 11, 10)); // 2.4 h free a day: a 7-day window, 2.29 h a day, Mon 2 to Tue 10
  assert.ok(at80.plan[0].due > at100.plan[0].due);
});

test('Deliver: the files go out, then the client\'s sign-off time, counted from that day', () => {
  const r = run([step('dl', 'Deliver', ['Account lead'], 0.5, { signOffDays: 5, signOffNote: 'Client G averages 6 working days' })]);
  assert.equal(get(r, 'dl').start, D(2026, 11, 2));
  assert.equal(get(r, 'dl').due, D(2026, 11, 6)); // five working days, Mon to Fri
  assert.equal(r.lands, D(2026, 11, 6));
});

test('a review starts the working day after the writing it reviews finishes, as every step does', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 4), step('rc', 'Review copy', ['Creative lead'], 1, { waitsOn: ['w'] })]);
  assert.equal(get(r, 'w').due, D(2026, 11, 2));
  assert.equal(get(r, 'rc').start, D(2026, 11, 3)); // no same-day overlap of the writing and its review
  assert.equal(get(r, 'rc').due, D(2026, 11, 3));
  assert.match(get(r, 'rc').reason, /the working day after Write copy finishes/);
});

test('every other handoff: the working day after the step it waits on finishes', () => {
  const r = run([step('pf', 'Package files', ['Studio'], 2), step('ir', 'Internal review', ['Account lead'], 0.5, { waitsOn: ['pf'] }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['ir'], signOffDays: 3 })]);
  assert.equal(get(r, 'pf').due, D(2026, 11, 2));
  assert.equal(get(r, 'ir').start, D(2026, 11, 3));
  assert.equal(get(r, 'dl').start, D(2026, 11, 4));
  assert.equal(get(r, 'dl').due, D(2026, 11, 6));
});

test('a quarter hour short of a day\'s room still fits that day', () => {
  // the Account lead's day is 3.2 h; at 80%, 2.56 h; 1.1 h of other work leaves 1.46 h for a 1.5 h step
  const r = run([step('dl', 'Deliver', ['Account lead'], 1.5, { signOffDays: 3 })],
    { capPct: 80, booked: bookedEvery('Account lead', D(2026, 11, 2), D(2026, 11, 2), 1.1) });
  assert.equal(get(r, 'dl').start, D(2026, 11, 2));
});

test('the requested date: met or not, in working days', () => {
  const r = run([step('w', 'Write copy', ['Copywriter'], 12)], { requested: D(2026, 11, 3) });
  assert.equal(r.feasible_past_requested, 1); // no Deliver step, so the last step: Wed 4 Nov, one working day after Tue 3 Nov
});

// --- recovery: rework and the re-walk on hours, not windows ---

test('recovery plans rework on hours, not windows: at 100% from today, the review the working day after, the revision turnaround fixed', () => {
  // A rework chain: 7 h of copy, 1 h of review, a design fix at the agency's 3-day revision turnaround, then the
  // project's own Package files (planned Thu 12 to Fri 13 Nov, a 2-day window) with 3 h of work.
  const steps = [
    step('rw', 'Rework: Write copy', ['Copywriter'], 7),
    step('rr', 'Rework: Review copy', ['Creative lead'], 1, { waitsOn: ['rw'] }),
    step('rd', 'Rework: Design', ['Creative lead'], 0.5, { waitsOn: ['rr'], agencyDays: 3, agencyNote: "the agency's 3-working-day revision turnaround" }),
    step('pf', 'Package files', ['Studio'], 3, { waitsOn: ['rd'], plannedStart: D(2026, 11, 12), plannedDue: D(2026, 11, 13) }),
  ];
  const r = recover(steps);
  assert.equal(get(r, 'rw').due, D(2026, 11, 2)); // 7 h fit Monday's 8 h at 100%
  assert.equal(get(r, 'rr').start, D(2026, 11, 3)); // the review the working day after the writing finishes, on its 1 hour
  assert.equal(get(r, 'rd').start, D(2026, 11, 4));
  assert.equal(get(r, 'rd').due, D(2026, 11, 6)); // the revision turnaround, held fixed: Wed to Fri
  assert.equal(get(r, 'pf').start, D(2026, 11, 9)); // on its hours the working day after, ahead of its planned window
  assert.equal(get(r, 'pf').due, D(2026, 11, 9)); // 3 h in one day, not its planned two-day window
  assert.match(get(r, 'pf').reason, /4 working days before its planned due date of Fri, Nov 13/);
  assert.match(get(r, 'rw').reason, /at 100%/);
  // the same chain as new work: the copy's window is two days (7 h at no more than half the copywriter's day), so it
  // all lands later
  const asNew = schedule({ mode: 'plan', today: D(2026, 11, 2), capacity: CAP, booked: new Map(), steps: steps.map((s) => ({ ...s, plannedStart: null, plannedDue: null })) });
  assert.equal(get(asNew, 'rw').due, D(2026, 11, 3));
  assert.equal(get(asNew, 'pf').due, D(2026, 11, 10));
  assert.match(get(asNew, 'rw').reason, /a 2 working days window, 3\.5 h a day: no more than half Copywriter's 8 h day/);
});

test('recovery: an agency step already with the agency keeps its due date', () => {
  const r = recover([step('ds', 'Design', ['Creative lead'], 1, { plannedStart: D(2026, 10, 26), plannedDue: D(2026, 11, 9) })]);
  assert.equal(get(r, 'ds').start, D(2026, 10, 26));
  assert.equal(get(r, 'ds').due, D(2026, 11, 9));
  assert.match(get(r, 'ds').reason, /the agency's due date of Mon, Nov 9 holds/);
});

test('the buffer gone on the calendar, and the recovery plan on hours brings the send back inside the Due date', () => {
  // The calendar slid: Write copy's window was pushed to Wed 4 to Mon 9 Nov and Deliver (the send) to Tue 10 Nov,
  // past the Due date of Mon 9 Nov: the buffer is gone. The hours left are 8 h of copy, 3 h of files and 0.5 h of
  // Deliver, and the people are free, so on hours from Mon 2 Nov the files go out Wed 4 Nov.
  const promise = D(2026, 11, 9);
  const steps = [
    step('w', 'Write copy', ['Copywriter'], 8, { plannedStart: D(2026, 11, 4), plannedDue: D(2026, 11, 9) }),
    step('pf', 'Package files', ['Studio'], 3, { waitsOn: ['w'], plannedStart: D(2026, 11, 9), plannedDue: D(2026, 11, 9) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['pf'], plannedStart: D(2026, 11, 10), plannedDue: D(2026, 11, 12) }),
  ];
  const r = recover(steps, { promise });
  assert.ok(r.planned_send > promise); // the calendar: the buffer is gone
  assert.equal(get(r, 'w').due, D(2026, 11, 2));
  assert.equal(get(r, 'pf').due, D(2026, 11, 3));
  assert.equal(r.send, D(2026, 11, 4));
  assert.equal(r.send_past_due, -3); // three working days inside the Due date
  assert.equal(r.first_break, null);
  assert.equal(r.send_moves, -4); // the send moves four working days earlier
  assert.equal(r.lands, D(2026, 11, 6)); // the client's sign-off after it, its planned window held: Tue 10 to Thu 12, three working days
  // the same chain with the copywriter booked solid that week: the send is past the Due date and a step breaks
  const late = recover(steps, { promise, booked: bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 6), 8) });
  assert.equal(late.send, D(2026, 11, 11)); // copy Mon 9, files Tue 10, the send Wed 11
  assert.equal(late.send_past_due, 2);
  assert.equal(late.first_break.step, 'Package files');
});

test('the Feasible date is the send plus two working days, holidays skipped, whatever the client\'s sign-off time', () => {
  // the files go out Tue 24 Nov; two working days on, with Thanksgiving and the day after skipped, the Feasible date
  // is Mon 30 Nov; the client's 7-day sign-off runs on to Fri 4 Dec, the client's clock
  const r = run([step('dl', 'Deliver', ['Account lead'], 0.5, { signOffDays: 7 })], { today: D(2026, 11, 24), requested: D(2026, 11, 27) });
  assert.equal(r.send, D(2026, 11, 24));
  assert.equal(r.feasible, D(2026, 11, 30));
  assert.equal(r.lands, D(2026, 12, 4));
  assert.equal(r.feasible_past_requested, 1); // Mon 30 Nov is one working day after the requested Fri 27 Nov (a holiday)
});

test('the re-walk names the competing work booked in the owner\'s time', () => {
  // Client Q's and Client K's copy book the Copywriter's Monday to Thursday; this project's 6 h of copy waits until Friday.
  const env = { TIME_ZONE: 'UTC' };
  const members = new Map();
  const others = [
    { id: 'q', name: 'Write copy', people: ['Copywriter'], teams: [], estimate: 20, start: D(2026, 11, 2) * DAY_MS, due: D(2026, 11, 5) * DAY_MS },
    { id: 'k', name: 'Write copy', people: ['Copywriter'], teams: [], estimate: 12, start: D(2026, 11, 2) * DAY_MS, due: D(2026, 11, 5) * DAY_MS },
  ];
  const label = { q: "Client Q's Write copy", k: "Client K's Write copy" };
  const booked = bookings(others, env, members);
  const bookedBy = bookingsBy(others, env, members, (s) => label[s.id]);
  const steps = [step('w', 'Write copy', ['Copywriter'], 6, { plannedStart: D(2026, 11, 2), plannedDue: D(2026, 11, 3) }),
    step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['w'], plannedStart: D(2026, 11, 4), plannedDue: D(2026, 11, 6) })];
  const r = recover(steps, { booked, bookedBy, promise: D(2026, 11, 6) });
  assert.equal(get(r, 'w').start, D(2026, 11, 6));
  assert.match(get(r, 'w').reason, /waits for Copywriter until Fri, Nov 6: Client Q's Write copy \(20 h\) and Client K's Write copy \(12 h\) also book Copywriter's time before Fri, Nov 6/);
  assert.equal(r.first_break.step, 'Write copy');
  assert.ok(r.send_past_due > 0);
  // a project's own steps are left out of what competes with it
  const mine = withoutBy(bookedBy, new Set(['q']));
  const r2 = recover(steps, { booked, bookedBy: mine });
  assert.match(get(r2, 'w').reason, /Client K's Write copy \(12 h\) books Copywriter's time before Fri, Nov 6/);
  assert.doesNotMatch(get(r2, 'w').reason, /Client Q/);
});

test('a full week is not free on its quiet day: the re-walk names the week\'s work, and the hours that miss the due date', () => {
  // Studio's week of 9 Nov (40 h) holds 40 h of other files Mon to Thu, so Friday looks free but
  // the week is full; this project's 2 h of Package files, able to start Fri 13 Nov, waits until Mon 16.
  const env = { TIME_ZONE: 'UTC' };
  const others = [
    { id: 'x', name: 'Package files', people: ['Studio'], teams: [], estimate: 20, start: D(2026, 11, 9) * DAY_MS, due: D(2026, 11, 12) * DAY_MS },
    { id: 'f', name: 'Package files', people: ['Studio'], teams: [], estimate: 20, start: D(2026, 11, 9) * DAY_MS, due: D(2026, 11, 12) * DAY_MS },
  ];
  const label = { x: "Client X's Package files", f: "Client F's Package files" };
  const booked = bookings(others, env, new Map());
  const bookedBy = bookingsBy(others, env, new Map(), (o) => label[o.id]);
  const steps = [
    step('ds', 'Design', ['Creative lead'], 0, { plannedStart: D(2026, 10, 28), plannedDue: D(2026, 11, 12) }),
    step('pf', 'Package files', ['Studio'], 2, { waitsOn: ['ds'], plannedStart: D(2026, 11, 13), plannedDue: D(2026, 11, 13) }),
    step('ir', 'Internal review', ['Account lead'], 1, { waitsOn: ['pf'], plannedStart: D(2026, 11, 16), plannedDue: D(2026, 11, 16) }),
  ];
  const r = recover(steps, { booked, bookedBy, today: D(2026, 11, 2) });
  assert.equal(get(r, 'pf').start, D(2026, 11, 16));
  assert.match(get(r, 'pf').reason, /Studio's week of Mon, Nov 9 is full, 40 h booked of 40 h at 100%: Client F's Package files \(20 h\) and Client X's Package files \(20 h\) also book Studio's time that week/);
  assert.equal(get(r, 'pf').shortHours, 2); // all its hours miss its due date though it could start on it
  assert.equal(get(r, 'ir').late, true);
  assert.equal(get(r, 'ir').shortHours, 0); // late from the chain, not short of the account lead's hours
  assert.equal(get(r, 'ir').heldByChain, true);
});

test('the what-if: moving a step to someone with room recovers the slip', () => {
  const steps = [step('pf', 'Package files', ['Studio'], 6, { plannedStart: D(2026, 11, 2), plannedDue: D(2026, 11, 2) })];
  const booked = bookedEvery('Studio', D(2026, 11, 2), D(2026, 11, 6), 8);
  const base = recover(steps, { booked });
  const tried = recover(steps, { booked, whatIf: { step: 'Package files', owner: 'Copywriter', start: null } });
  assert.ok(base.plan[0].due > D(2026, 11, 2));
  assert.equal(tried.plan[0].due, D(2026, 11, 2));
});

test('the same input twice gives the same plan, in both modes', () => {
  const input = (mode) => ({ mode, today: D(2026, 11, 2), capacity: CAP,
    booked: bookedEvery('Copywriter', D(2026, 11, 2), D(2026, 11, 13), 5),
    steps: [step('w', 'Write copy', ['Copywriter'], 12, { plannedStart: D(2026, 11, 3), plannedDue: D(2026, 11, 5) }),
      step('rc', 'Review copy', ['Creative lead'], 1, { waitsOn: ['w'] }),
      step('ds', 'Design', ['Creative lead'], 2, { waitsOn: ['rc'], agencyDays: 7 }), step('pf', 'Package files', ['Studio'], 3, { waitsOn: ['ds'] }),
      step('ir', 'Internal review', ['Account lead'], 1, { waitsOn: ['pf'] }), step('dl', 'Deliver', ['Account lead'], 0.5, { waitsOn: ['ir'], signOffDays: 3 })],
    promise: D(2026, 11, 27) });
  for (const mode of ['plan', 'recovery']) {
    assert.equal(JSON.stringify(schedule(input(mode))), JSON.stringify(schedule(input(mode))));
    assert.equal(dayText(schedule(input(mode)).lands), dayText(schedule(input(mode)).lands));
  }
});

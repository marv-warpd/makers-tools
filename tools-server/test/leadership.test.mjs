// Unit tests for the leadership reads (reserve use, work mix, stage flow): the pieces
// underneath, on hand-built cases with known answers.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthCapacity, kindOfEntry, flowOf, paceOf } from '../tools.js';
import { makeTree, DAY_MS } from '../data.js';

const D = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;

test('capacity for step work by month: working days, the history\'s holidays skipped', () => {
  // May 2026: 21 weekdays less Memorial Day (25 May) = 20; the copywriter's 40 h a week is 8 h a day
  assert.equal(monthCapacity('Copywriter', '2026-05'), 160);
  assert.equal(monthCapacity('Studio', '2026-05'), 160);
  assert.equal(Math.round(monthCapacity('Creative lead', '2026-05') * 10) / 10, 88); // 4.4 h a day
  // July 2026: 23 weekdays less 3 July (Independence Day observed) = 22
  assert.equal(monthCapacity('Copywriter', '2026-07'), 176);
  assert.equal(monthCapacity('Delivery lead', '2026-07'), 0); // no step work
});

test('work mix: each entry sorted into one kind of work', () => {
  const t = (id, name, parent, f = {}, type = 0) => ({ id, name, parent, type, status: 'complete', closed: true, start: null, due: null,
    estimate: 0, tracked: 0, people: [], teams: [], waitsOn: [], f });
  const tree = makeTree([
    t('p', 'Client A: launch', null, { 'Request kind': 'New project', 'Agreement type': 'Fixed fee' }), t('pw', 'Write copy', 'p'),
    t('ch', 'Client A: launch video', 'p', { 'Request kind': 'Change' }), t('chw', 'Write script', 'ch'),
    t('m', 'Retainer month: Client B, October 2026', null, {}, 1001), t('r', 'Client B: newsletter, October', 'm', { 'Agreement type': 'Retainer' }), t('rp', 'Package files', 'r'),
  ]);
  const e = (task, labels = []) => ({ task, labels, hours: 1 });
  assert.equal(kindOfEntry(e('pw'), tree), 'new projects');
  assert.equal(kindOfEntry(e('chw'), tree), 'changes');
  assert.equal(kindOfEntry(e('rp'), tree), 'retainer pieces');
  assert.equal(kindOfEntry(e('pw', ['rework: client']), tree), 'client revisions');
  assert.equal(kindOfEntry(e('rp', ['rework: internal']), tree), 'internal rework'); // the label first, even on a retainer piece
  assert.equal(kindOfEntry(e('nowhere'), tree), null);
});

test('stage flow: the wait from when a step could start to its start', () => {
  const f = flowOf([
    { name: 'Write copy', start: D(2026, 11, 2), due: D(2026, 11, 3) },
    { name: 'Review copy', start: D(2026, 11, 3), due: D(2026, 11, 3) }, // a review starts the day the writing ends
    { name: 'Design', start: D(2026, 11, 4), due: D(2026, 11, 13) },
    { name: 'Package files', start: D(2026, 11, 19), due: D(2026, 11, 19) }, // could start Mon 16: waits Mon, Tue, Wed
    { name: 'Internal review', start: D(2026, 11, 20), due: D(2026, 11, 20) },
  ]);
  assert.deepEqual(f.map((x) => x.wait), [null, 0, 0, 3, 0]);
  assert.equal(f[2].elapsed, 8); // Wed 4 to Fri 13: 4, 5, 6, 9, 10, 11, 12, 13
  // a holiday inside a wait does not count: files could start Wed 25 Nov, start Mon 30 Nov: one working day waited
  assert.equal(flowOf([{ name: 'Design', start: D(2026, 11, 10), due: D(2026, 11, 24) }, { name: 'Package files', start: D(2026, 11, 30), due: D(2026, 11, 30) }])[1].wait, 1);
});

test('stage flow: a step before that ran again later is read as finished on its last logged day before', () => {
  // Package files ran 2 Nov, waited, Internal review started 9 Nov; Package files was reopened for a slip on 12 Nov,
  // so its due date is 12 Nov. Its first run ended 2 Nov: Internal review could start 3 Nov and waited four days.
  const f = flowOf([
    { name: 'Package files', start: D(2026, 11, 2), due: D(2026, 11, 12), days: [D(2026, 11, 2), D(2026, 11, 12)] },
    { name: 'Internal review', start: D(2026, 11, 9), due: D(2026, 11, 13) },
  ]);
  assert.equal(f[1].wait, 4);
});

test('rework pace: from the catch (the working day before the fix starts) to the last fix', () => {
  assert.deepEqual(paceOf([{ start: D(2026, 11, 3), due: D(2026, 11, 4) }, { start: D(2026, 11, 5), due: D(2026, 11, 5) }]),
    { caught: D(2026, 11, 2), fix: D(2026, 11, 5), days: 4 });
  // a fix starting on a Monday was caught the Friday before
  assert.equal(paceOf([{ start: D(2026, 11, 9), due: D(2026, 11, 9) }]).caught, D(2026, 11, 6));
});

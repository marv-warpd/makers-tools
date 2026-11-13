// Unit tests for Estimate accuracy by step: each step's hours estimated against hours tracked, by kind
// of work, job type, step, client, owner or month, worst first; on a hand-built set of cards with known answers.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepKind, accuracyByStep } from '../tools.js';
import { makeTree, period, DAY_MS } from '../data.js';

const env = { TIME_ZONE: 'UTC' };
const at = (y, m, d) => Date.UTC(y, m - 1, d) + 12 * 3600e3;
const card = (id, name, extra = {}) => ({ id, name, parent: null, type: 0, status: 'complete', closed: true, start: null, due: null,
  estimate: 0, tracked: 0, closedOn: null, people: [], teams: [], waitsOn: [], f: {}, ...extra });
const step = (id, parent, name, estimate, tracked, extra = {}) => card(id, name, { parent, estimate, tracked, ...extra });
const A = { id: 'ca', name: 'Client A' };
const B = { id: 'cb', name: 'Client B' };

// Client A's print brochure: copy over its estimate, files on it, a client revision under a rework card, and an
// internal redo logged on the original step. Client B's web page with a change under it. A retainer piece. Steps
// with no estimate or no tracked time, a stage subtask and a [Test] card are left out.
const tasks = [
  card('p1', 'Client A: brochure', { f: { Client: [A], 'Job type': 'Print', 'Request kind': 'New project' } }),
  step('w1', 'p1', 'Write copy', 4, 6, { people: ['Copywriter'], closedOn: at(2026, 9, 10) }),
  step('f1', 'p1', 'Package files', 2, 2, { people: ['Studio'], closedOn: at(2026, 9, 14) }),
  step('f2', 'p1', 'Package files', 1.5, 3, { teams: ['Studio'], due: at(2026, 10, 2), f: { Rework: ['Internal'] } }),
  card('r1', 'Client rework: print', { parent: 'p1', f: { Rework: ['Client'] } }),
  step('rf', 'r1', 'Rework: Package files', 1, 3, { people: ['Studio'], closedOn: at(2026, 10, 5), f: { Rework: ['Client'] } }),
  step('s1', 'p1', 'Confirm brief and scope', 1, 1),
  step('n1', 'p1', 'Internal review', 1, 0),
  step('n2', 'p1', 'Deliver', 0, 1),
  card('p2', 'Client B: landing page', { f: { Client: [B], 'Job type': 'Web' } }),
  step('w2', 'p2', 'Write copy', 5, 4, { people: ['Copywriter'], closedOn: at(2026, 10, 20) }),
  card('c2', 'Client B: landing page, extra section', { parent: 'p2', f: { Client: [B], 'Job type': 'Web', 'Request kind': 'Change' } }),
  step('cw', 'c2', 'Write copy', 2, 3, { people: ['Copywriter'], closedOn: at(2026, 10, 22) }),
  card('m1', 'Retainer month: Client B, October 2026', { f: { Client: [B] } }),
  card('rp', 'Client B: newsletter, October', { parent: 'm1', f: { Client: [B], 'Job type': 'Email' } }),
  step('rw', 'rp', 'Write copy', 2, 2, { people: ['Copywriter'], closedOn: at(2026, 10, 8) }),
  card('t1', '[Test] Client A: flyer', { f: { Client: [A], 'Job type': 'Print' } }),
  step('tw', 't1', 'Write copy', 1, 9, { people: ['Copywriter'], closedOn: at(2026, 10, 1) }),
];
const tree = makeTree(tasks);

test('estimate accuracy by step: each step\'s kind of work from its own Rework label and its parents', () => {
  const kind = (id) => stepKind(tree.byId.get(id), tree);
  assert.equal(kind('w1'), 'new projects');
  assert.equal(kind('rf'), 'client revisions'); // a step under a client rework card, labeled Client
  assert.equal(kind('f2'), 'internal rework'); // the redo logged on the original step, labeled Internal
  assert.equal(kind('cw'), 'changes'); // under a card whose Request kind is Change
  assert.equal(kind('rw'), 'retainer pieces'); // a retainer piece's step
});

test('estimate accuracy by step: by kind of work, hours tracked against estimated, the gap in hours and percent, worst first', () => {
  const { rows, totals } = accuracyByStep(tree, { groupBy: 'kind' }, env);
  assert.deepEqual(rows.map((r) => [r.group, r.steps, r.hours_estimated, r.hours_tracked, r.gap_hours, r.gap_pct]), [
    ['client revisions', 1, 1, 3, 2, 200],
    ['internal rework', 1, 1.5, 3, 1.5, 100],
    ['changes', 1, 2, 3, 1, 50],
    ['new projects', 3, 11, 12, 1, 9],
    ['retainer pieces', 1, 2, 2, 0, 0],
  ]);
  // only steps with both an estimate and time tracked; no stage subtask, no [Test] card
  assert.deepEqual(totals, { steps: 7, hours_estimated: 17.5, hours_tracked: 23, gap_hours: 5.5, gap_pct: 31 });
});

test('estimate accuracy by step: by step name (a rework step counts as its step), owner, job type and month', () => {
  const by = (groupBy) => Object.fromEntries(accuracyByStep(tree, { groupBy }, env).rows.map((r) => [r.group, [r.steps, r.hours_estimated, r.hours_tracked]]));
  assert.deepEqual(by('step'), { 'Package files': [3, 4.5, 8], 'Write copy': [4, 13, 15] });
  assert.deepEqual(by('owner'), { Copywriter: [4, 13, 15], Studio: [2, 3, 5], 'the Studio Team': [1, 1.5, 3] });
  assert.deepEqual(by('job_type'), { Print: [4, 8.5, 14], Web: [2, 7, 7], Email: [1, 2, 2] });
  assert.deepEqual(by('month'), { '2026-09': [2, 6, 8], '2026-10': [5, 11.5, 15] }); // closed, else the due date
  assert.equal(accuracyByStep(tree, { groupBy: 'step' }, env).rows[0].group, 'Package files'); // +78% before +15%
});

test('estimate accuracy by step: filters by client, job type, step and dates', () => {
  const tot = (opts) => accuracyByStep(tree, opts, env).totals;
  assert.equal(tot({ client: A }).steps, 4);
  assert.equal(tot({ client: B }).steps, 3);
  assert.equal(tot({ jobType: 'Web' }).hours_tracked, 7);
  assert.equal(tot({ step: 'package files' }).steps, 3);
  assert.equal(tot({ per: period({ from: '2026-10-01', to: '2026-10-10' }) }).steps, 3); // f2 (due Oct 2), rf (Oct 5), rw (Oct 8)
  assert.deepEqual(tot({ client: { id: 'none' } }), { steps: 0, hours_estimated: 0, hours_tracked: 0, gap_hours: 0, gap_pct: null });
});

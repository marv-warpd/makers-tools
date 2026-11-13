// Tests for hours on [Test] cards, which count in no figure: Rework by cause, Reserve use and Work mix leave out an
// entry on a [Test] card, on a step under one, on a step named [Test] under a real job, and on a [Test] card since
// deleted.
// ClickUp is a stand-in (fetch replaced) serving one real job and those [Test] hours.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../tools.js';
import { LISTS, WS, forgetShared, onTest, makeTree } from '../data.js';

const HOUR = 3_600_000;
const day = (d) => String(Date.UTC(2026, 9, d, 12)); // October 2026
const client = { name: 'Client', type: 'tasks', value: [{ id: 'c1', name: 'Client A' }] };
const fixedFee = { name: 'Agreement type', type: 'drop_down', type_config: { options: [{ id: 'ff', name: 'Fixed fee', orderindex: 0 }] }, value: 0 };
const rate = { name: 'Rate', type: 'currency', value: 65 };
const card = (id, name, extra = {}) => ({ id, name, status: { status: 'complete', type: 'closed' }, date_closed: day(20), custom_fields: [client, fixedFee, rate], ...extra });
const step = (id, name, parent) => ({ id, name, parent, status: { status: 'complete', type: 'closed' }, custom_fields: [] });
const projects = [
  card('p1', 'Client A: autumn brochure'), step('p1s', 'Design', 'p1'), step('p1x', '[Test] Design', 'p1'),
  card('t1', '[Test] Client A: autumn brochure'), step('t1s', 'Design', 't1'),
];
const entry = (task, name, d, hours, tag) => ({ task: { id: task, name }, start: day(d), duration: String(hours * HOUR), tags: tag ? [{ name: tag }] : [], user: { username: 'Studio' } });
const entries = [
  entry('p1s', 'Design', 5, 10), entry('p1s', 'Design', 6, 2, 'rework: client'), // the real job: 10 h of work, 2 h of client revisions
  entry('t1s', 'Design', 7, 5), entry('t1s', 'Design', 8, 3, 'rework: internal'), // under a [Test] card
  entry('p1x', '[Test] Design', 9, 4, 'rework: client'), // a [Test] step under the real job
  entry('gone', '[Test] Client A: spring brochure', 12, 6, 'rework: internal'), // a [Test] card since deleted
];

function serve() {
  forgetShared();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v2', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (path === `/list/${LISTS.projects}/task`) return ok({ tasks: u.searchParams.get('page') === '0' ? projects : [] });
    if (path === '/team') return ok({ teams: [{ id: WS, members: [{ user: { id: 1 } }] }] });
    if (path === `/team/${WS}/time_entries`) return ok({ data: entries });
    return ok({});
  };
}
const env = { CLICKUP_TOKEN: 'test', TIME_ZONE: 'Europe/London' };
const ask = async (name, args) => (await TOOLS[name].run(args, env)).structuredContent;

test('an entry is on a [Test] card when its task, or any card above it, is named [Test], or its task was a [Test] card since deleted', () => {
  const tree = makeTree(projects.map((t) => ({ id: t.id, name: t.name, parent: t.parent ?? null })));
  const on = (task, taskName) => onTest({ task, taskName }, tree);
  assert.deepEqual([on('p1s', 'Design'), on('p1', 'Client A: autumn brochure'), on(null, null)], [false, false, false]);
  assert.deepEqual([on('t1s', 'Design'), on('t1', '[Test] Client A: autumn brochure'), on('p1x', '[Test] Design'), on('gone', '[Test] old card')], [true, true, true, true]);
});

test('Rework by cause leaves out [Test] hours: 2 h of client revisions, none of our own redo', async () => {
  serve();
  const r = await ask('rework_by_cause', { from: '2026-10-01', to: '2026-10-31', group_by: 'client' });
  assert.deepEqual([r.totals.client_h, r.totals.internal_h], [2, 0]);
  assert.deepEqual(r.rows.map((x) => [x.group, x.client_h, x.internal_h]), [['Client A', 2, 0]]);
});

test('Reserve use leaves out [Test] hours: the studio\'s rework is its 2 h on the real job', async () => {
  serve();
  const r = await ask('reserve_use', { from_month: '2026-10', to_month: '2026-10' });
  assert.deepEqual(r.people.map((p) => [p.name, p.rework_hours]), [['Studio', 2]]);
});

test('Work mix leaves out [Test] hours: the studio\'s 12 h, 10 on new projects and 2 on client revisions', async () => {
  serve();
  const r = await ask('work_mix', { from_month: '2026-10', to_month: '2026-10' });
  const studio = r.people.find((p) => p.name === 'Studio');
  assert.equal(studio.total_hours, 12);
  assert.deepEqual(studio.kinds.filter((k) => k.hours).map((k) => [k.kind, k.hours]), [['new projects', 10], ['client revisions', 2]]);
  assert.equal(r.hours_not_placed, 0);
});

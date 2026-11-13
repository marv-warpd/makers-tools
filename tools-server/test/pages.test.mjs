// Tests for reading a workspace of any size: Margin by client, Rework by cause and On time rate's late
// jobs come a page of 25 at a time, and the Monday client figures job reads every page. ClickUp is a stand-in (fetch
// replaced) serving a made-up workspace: 26 clients, 101 clients, and a client with 26 late jobs.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, pageOf, PAGE_SIZE } from '../tools.js';
import { refreshClientFigures, allPages } from '../jobs.js';
import { LISTS, WS, forgetShared } from '../data.js';

const HOUR = 3_600_000;
const day = (m, d) => Date.UTC(2026, m - 1, d, 12);
const name = (i) => `Client ${String(i).padStart(3, '0')}`;
const AGREEMENT = { name: 'Agreement type', type: 'drop_down', type_config: { options: [{ id: 'ff', name: 'Fixed fee', orderindex: 0 }, { id: 'rt', name: 'Retainer', orderindex: 1 }] }, value: 0 };
const HEALTH = [{ id: 'h0', name: 'Healthy', orderindex: 0 }, { id: 'h1', name: 'Watch', orderindex: 1 }, { id: 'h2', name: 'At risk', orderindex: 2 }];
const CARD_FIELDS = ['Margin', 'Margin %', 'Fees to date', 'On time %', 'Late days', 'Client revision hrs', 'Internal rework hrs', 'Average rounds',
  'Retainer usage %', 'Retainer trend %', 'Allowance', 'Figures as of'];

// A made-up workspace: each client has two finished fixed-fee jobs (one a day late), 10 hours logged on each and one
// hour of client revisions; lateJobs gives a client that many more finished jobs, each late.
function workspace(clients, lateJobs = {}) {
  const projects = [];
  const entries = [];
  const job = (i, k, lateBy) => {
    const id = `p${i}-${k}`;
    projects.push({ id, name: `${name(i)}: job ${k}`, status: { status: 'complete', type: 'closed' }, date_closed: String(day(10, 1)),
      custom_fields: [{ name: 'Client', type: 'tasks', value: [{ id: `c${i}`, name: name(i) }] }, AGREEMENT,
        { name: 'Price', type: 'currency', value: 2000 + i }, { name: 'Rate', type: 'currency', value: 65 }, { name: 'Late by', type: 'number', value: lateBy },
        { name: 'Rounds used', type: 'number', value: 1 }] });
    entries.push({ task: { id }, start: String(day(9, 15)), duration: String(10 * HOUR), tags: [] },
      { task: { id }, start: String(day(9, 16)), duration: String(HOUR), tags: [{ name: 'rework: client' }] });
  };
  for (let i = 1; i <= clients; i++) {
    job(i, 'a', 0); job(i, 'b', 1);
    for (let k = 0; k < (lateJobs[name(i)] || 0); k++) job(i, `late${k}`, k + 1);
  }
  const cards = Array.from({ length: clients }, (_, j) => ({ id: `c${j + 1}`, name: name(j + 1), status: { status: 'active', type: 'open' },
    custom_fields: [...CARD_FIELDS.map((n) => ({ name: n, type: 'number', value: null })), { name: 'Account health', type: 'drop_down', type_config: { options: HEALTH }, value: null }] }));
  const fields = [...CARD_FIELDS.map((n, i) => ({ id: `f${i}`, name: n, type: 'number' })), { id: 'fah', name: 'Account health', type: 'drop_down', type_config: { options: HEALTH } }];
  return { projects, entries, cards, fields };
}

function serve(ws) {
  forgetShared();
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v2', '');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    const page = (list) => list.slice(Number(u.searchParams.get('page')) * 100, (Number(u.searchParams.get('page')) + 1) * 100);
    if ((init.method || 'GET') !== 'GET') {
      writes.push({ card: path.split('/')[2], field: ws.fields.find((f) => f.id === path.split('/')[4]).name, value: JSON.parse(init.body).value });
      return ok({});
    }
    if (path === `/list/${LISTS.projects}/task`) return ok({ tasks: page(ws.projects) });
    if (path === `/list/${LISTS.clients}/task`) return ok({ tasks: page(ws.cards) });
    if (path === `/list/${LISTS.clients}/field`) return ok({ fields: ws.fields });
    if (path === '/team') return ok({ teams: [{ id: WS, members: [{ user: { id: 1 } }] }] });
    if (path === `/team/${WS}/time_entries`) return ok({ data: ws.entries });
    return ok({});
  };
  return writes;
}
const env = { CLICKUP_TOKEN: 'test', TIME_ZONE: 'Europe/London' };
const ask = async (name, args) => (await TOOLS[name].run(args, env)).structuredContent;
const written = (writes, card, field) => writes.find((w) => w.card === card && w.field === field)?.value;

test('a list comes a page of 25 at a time: 26 rows are two pages, 101 are five; past the end is empty', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => i);
  assert.equal(PAGE_SIZE, 25);
  assert.deepEqual([pageOf(rows(26), 0).items.length, pageOf(rows(26), 0).next_page, pageOf(rows(26), 1).items, pageOf(rows(26), 1).next_page], [25, 1, [25], null]);
  const p = pageOf(rows(101), 4);
  assert.deepEqual([p.items, p.pages, p.next_page, pageOf(rows(101), 3).next_page], [[100], 5, null, 4]);
  assert.deepEqual([pageOf(rows(101), 9).items, pageOf(rows(101), 9).next_page, pageOf(rows(3)).pages], [[], null, 1]);
});

test('26 clients: Margin by client and Rework by cause give 25 rows then 1, each a complete client total, with the count', async () => {
  serve(workspace(26));
  const m0 = await ask('margin_by_client', { state: 'finished' });
  const m1 = await ask('margin_by_client', { state: 'finished', page: 1 });
  assert.deepEqual([m0.rows.length, m0.rows_total, m0.next_page, m1.rows.length, m1.next_page], [25, 26, 1, 1, null]);
  const all = [...m0.rows, ...m1.rows];
  assert.equal(new Set(all.map((r) => r.client)).size, 26);
  assert.equal(all.find((r) => r.client === name(26)).price, 2 * (2000 + 26)); // both jobs, not a sample
  const r0 = await ask('rework_by_cause', { group_by: 'client' });
  const r1 = await ask('rework_by_cause', { group_by: 'client', page: 1 });
  assert.deepEqual([r0.rows.length, r0.rows_total, r1.rows.length, r1.next_page], [25, 26, 1, null]);
  assert.ok([...r0.rows, ...r1.rows].every((r) => r.client_h === 2));
});

test('26 clients: the Monday job writes the figures of every client, the 26th included', async () => {
  const writes = serve(workspace(26));
  const r = await refreshClientFigures(env, { now: day(11, 9) });
  assert.equal(r.cards, 26);
  for (let i = 1; i <= 26; i++) assert.equal(written(writes, `c${i}`, 'Fees to date'), 2 * (2000 + i), name(i));
  assert.equal(written(writes, 'c26', 'Client revision hrs'), 2);
  assert.equal(written(writes, 'c26', 'Late days'), 1);
});

test('101 clients: every card refreshed, read over five pages of each list', async () => {
  const writes = serve(workspace(101));
  const calls = [];
  const original = TOOLS.margin_by_client.run;
  TOOLS.margin_by_client.run = (args, e) => { calls.push(args.page); return original(args, e); };
  try {
    const r = await refreshClientFigures(env, { now: day(11, 9) });
    assert.equal(r.cards, 101);
  } finally { TOOLS.margin_by_client.run = original; }
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  assert.equal(new Set(writes.filter((w) => w.field === 'Margin').map((w) => w.card)).size, 101);
  assert.equal(written(writes, 'c101', 'Fees to date'), 2 * (2000 + 101));
  assert.equal(written(writes, 'c101', 'Account health'), 'h0'); // Healthy (on time 50% with 1 late day meets no condition), written by its option id
});

test('a client with 26 late jobs: On time rate pages its late jobs and totals them; the job writes every late day', async () => {
  const writes = serve(workspace(3, { [name(2)]: 26 }));
  const p0 = await ask('on_time_rate', { group_by: 'client' });
  const p1 = await ask('on_time_rate', { group_by: 'client', page: 1 });
  assert.deepEqual([p0.late.length, p0.late_total, p0.next_page, p1.late.length, p1.next_page], [25, 29, 1, 4, null]);
  // the client's row carries its complete late jobs and late days: 27 late (its own one day plus 1 to 26)
  const row = p0.rows.find((x) => x.group === name(2));
  assert.deepEqual([row.late_jobs, row.late_days], [27, 1 + (26 * 27) / 2]);
  await refreshClientFigures(env, { now: day(11, 9) });
  assert.equal(written(writes, 'c2', 'Late days'), 1 + (26 * 27) / 2);
  assert.equal(written(writes, 'c1', 'Late days'), 1);
});

test('a list that changes between pages stops the job with nothing written, even when the count still adds up', async () => {
  let n = 0;
  const shifting = async (name, { page }) => {
    n += 1;
    const rows = Array.from({ length: 30 }, (_, i) => ({ client: `C${i + (n > 1 ? 1 : 0)}` })); // a row drops in between
    const pg = pageOf(rows, page);
    return { rows: pg.items, rows_total: 30, next_page: pg.next_page, list_version: pg.version };
  };
  await assert.rejects(() => allPages(shifting, 'margin_by_client', {}, { list: 'rows', total: 'rows_total', id: (r) => r.client }), /changed while its pages were read/);
  const steady = async (name, { page }) => {
    const pg = pageOf(Array.from({ length: 30 }, (_, i) => ({ client: `C${i}` })), page);
    return { rows: pg.items, rows_total: 30, next_page: pg.next_page, list_version: pg.version };
  };
  assert.equal((await allPages(steady, 'margin_by_client', {}, { list: 'rows', total: 'rows_total', id: (r) => r.client })).rows.length, 30);
});

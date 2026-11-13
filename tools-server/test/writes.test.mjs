// Unit tests for the shared writes: the event service calls the tools server's link_client and freeze_baseline.
// ClickUp is a stand-in (fetch replaced) that records every write.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeBaseline, internalWrite } from '../writes.js';
import { approve, linkClient as approvalLink } from '../../event-service/worker.js';
import { LISTS, UserError } from '../data.js';

const HOUR = 3_600_000;
const field = (id, name, value = null) => ({ id, name, value });
// One request in Intake, approved: two steps (5 h and 3 h) at $65 with $400 of supplier cost: Initial forecast $920.
const REQUEST = { id: 'req', name: 'Client Z: spring launch', parent: null, list: { id: LISTS.intake }, status: { status: 'complete', type: 'closed' },
  time_estimate: 0, due_date: String(Date.UTC(2026, 11, 4, 4)), assignees: [], description: 'Client name: Client Z',
  custom_fields: [field('fi', 'Initial forecast'), field('fc', 'Original committed date', String(Date.UTC(2026, 11, 4, 4))), field('fr', 'Rate', '65'),
    field('fs', 'Supplier cost', '400'), field('fcl', 'Client', []), field('fn', 'Client name', 'Client Z'), field('fa', 'Account lead', [])],
  subtasks: [{ id: 's1', name: 'Confirm and approve', status: { status: 'to do', type: 'open' } }, { id: 's2', name: 'Write copy', status: { status: 'to do', type: 'open' } }] };
const raw = (id, name, parent, hours) => ({ id, name, parent, status: { status: 'to do', type: 'open' }, time_estimate: hours * HOUR, custom_fields: [], assignees: [], group_assignees: [] });
const LIST_TASKS = [{ ...REQUEST, custom_fields: [] }, raw('s2', 'Write copy', 'req', 5), raw('s3', 'Package files', 'req', 3)];
const CLIENTS = [{ id: 'cz', name: 'Client Z', parent: null, status: { status: 'active', type: 'open' }, custom_fields: [], assignees: [{ id: 7, username: 'Account lead' }] }];

function fakeClickUp({ fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (fail) return new Response('{"err":"outage"}', { status: 500 });
    if (method === 'GET' && /\/task\/req$/.test(u.pathname)) return ok(u.searchParams.get('include_subtasks') ? REQUEST : { ...REQUEST, subtasks: undefined });
    if (method === 'GET' && /\/task\/plain$/.test(u.pathname)) return ok({ ...REQUEST, id: 'plain' });
    if (method === 'GET' && /\/task\/cz$/.test(u.pathname)) return ok(CLIENTS[0]);
    if (method === 'GET' && u.pathname.endsWith(`/list/${LISTS.intake}/task`)) return ok({ tasks: u.searchParams.get('page') === '0' ? LIST_TASKS : [] });
    if (method === 'GET' && u.pathname.endsWith(`/list/${LISTS.clients}/task`)) return ok({ tasks: u.searchParams.get('page') === '0' ? CLIENTS : [] });
    return ok({});
  };
  return calls;
}
const writes = (calls) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path.replace('/api/v2', ''), c.body]);
const stepWrites = (calls) => writes(calls).filter(([m]) => m === 'PUT'); // the moves, not the Health write
const env = { CLICKUP_TOKEN: 'test', TIME_ZONE: 'Europe/London' };

test('an agent\'s freeze_baseline still changes only [Test] cards; the event service\'s call works on the real card, with no comment', async () => {
  fakeClickUp();
  await assert.rejects(() => freezeBaseline({ project: 'req' }, env), (e) => e instanceof UserError && /not marked \[Test\]/.test(e.message));
  const calls = fakeClickUp();
  const r = await internalWrite('freeze_baseline', { project: 'req' }, env);
  assert.equal(r.ok, true);
  assert.deepEqual(writes(calls), [['POST', '/task/req/field/fi', { value: 920 }]]); // Initial forecast only: the committed date was set by rule 8
  assert.match(r.sentence, /Initial forecast \$920/);
});

test('the event service\'s /approved: the baseline from makers-tools, then the open stage subtasks to Complete', async () => {
  const calls = fakeClickUp();
  const order = [];
  const MAKERS = { freezeBaseline: (args) => { order.push('baseline'); return internalWrite('freeze_baseline', args, env); },
    copyStepFields: async (args) => { order.push(`steps ${args.job}`); return { ok: true, sentence: 'copied', changed: ['Rate on 2 steps'] }; } };
  const r = await approve('req', { ...env, MAKERS });
  assert.deepEqual(order, ['baseline', 'steps req']); // the step fields after the baseline (stepfields.test.mjs covers the copy)
  assert.deepEqual(r.steps.changed, ['Rate on 2 steps']);
  assert.deepEqual(r.closed, ['Confirm and approve']);
  assert.deepEqual(r.baseline.changed, ['Initial forecast $920 (8 h × $65 + $400)']);
  assert.deepEqual(writes(calls).map(([m, p]) => `${m} ${p}`), ['POST /task/req/field/fi', 'PUT /task/s1']);
});

test('the event service\'s /intake: link_client from makers-tools sets Client, Account lead and the assignee, with no comment', async () => {
  const calls = fakeClickUp();
  const MAKERS = { linkClient: (args) => internalWrite('link_client', args, env) };
  const r = await approvalLink('req', { ...env, MAKERS });
  assert.deepEqual(r.changed, ['Client Client Z', 'Account lead Account lead', 'assignee Account lead']);
  assert.deepEqual(writes(calls), [['POST', '/task/req/field/fcl', { value: { add: ['cz'] } }], ['POST', '/task/req/field/fa', { value: { add: [7] } }],
    ['PUT', '/task/req', { assignees: { add: [7] } }]]);
});

test('a ClickUp outage is a failure the event service answers 502 (so the automation retries); a card that is not a project is an answer', async () => {
  fakeClickUp({ fail: true });
  const r = await internalWrite('freeze_baseline', { project: 'other' }, env);
  assert.equal(r.ok, false);
  await assert.rejects(() => approve('other', { ...env, MAKERS: { freezeBaseline: async () => r } }), /HTTP 500/);
  const skipped = { ok: true, skipped: 'Client Z: spring launch has no Initial forecast or Original committed date field, so it is not a project card', changed: [] };
  fakeClickUp();
  const a = await approve('req', { ...env, MAKERS: { freezeBaseline: async () => skipped, copyStepFields: async () => ({ ok: true, changed: [] }) } });
  assert.match(a.baseline.skipped, /not a project card/);
});

// --- apply_fix, by its Fix ref ---
import { applyFix, saysApply } from '../writes.js';
import { proposeFix, FIX_DAYS } from '../fixes.js';
import { today as todayOf, addWorkingDays as addWD, isoDay as isoOf, DAY_MS as DAY, dayText, forgetShared } from '../data.js';

const env0 = { TIME_ZONE: 'Europe/London' };
const d = (n) => addWD(todayOf(env0) + 1, n);
const at = (dn) => String(dn * DAY + 4 * HOUR);
const K = 'Client K: travel kit launch';
const P = 'Client P: new delivery area launch';

// The fix store, as Workers KV behaves for these calls: get (as JSON) and put with expirationTtl. expires: false keeps
// every plan whatever its age, so the server's own 14-day check is what refuses an old one.
function fakeFixes({ expires = true } = {}) {
  const held = new Map();
  return {
    held,
    async get(key, type) {
      const v = held.get(key);
      if (!v || (expires && v.until <= Date.now())) return null;
      return type === 'json' ? JSON.parse(v.value) : v.value;
    },
    async put(key, value, opts = {}) { held.set(key, { value, until: Date.now() + (opts.expirationTtl ?? Infinity) * 1000 }); },
  };
}
// A stored move: card, step, from start and due, to start and due.
const move = (card, cardName, step, stepName, from, fromDue, to, toDue) => ({ card_id: card, card: cardName, step_id: step, step: stepName,
  from: isoOf(from), from_due: isoOf(fromDue), to: isoOf(to), to_due: isoOf(toDue) });
// The fix least slack first gives P: K's files and review a day later, so P's files go first.
const K_FOR_P = [move('k', K, 'kpf', 'Package files', d(4), d(4), d(5), d(5)), move('k', K, 'kir', 'Internal review', d(5), d(5), d(6), d(6))];

// Who replies, and how. The card's Delivery lead (9), a workspace owner (7), the account lead (5, a member).
const lead = (id, text = '@Delivery Planner apply') => ({ id, user: { id: 9, username: 'Delivery lead' }, comment_text: text });
const owner = (id) => ({ id, user: { id: 7, username: 'Owner' }, comment_text: '@Delivery Planner apply' });
const accountLead = (id) => ({ id, user: { id: 5, username: 'Account lead' }, comment_text: 'apply' });
// A comment on a card, newest first in the list given: the Planner's unless by is given, with its thread replies.
const said = (id, text, replies = [], by = { id: -7, username: 'Delivery Planner' }) => ({ id, text, replies, by });
const fixComment = (id, ref, replies) => said(id, `Client P will send late.\n1. Move Client K's Package files from ${dayText(d(4))} to ${dayText(d(5))}.\nFix ref: ${ref}\nReply "apply" and the server writes these dates.`, replies);

// Two live jobs on the Projects List: K's files, review and Deliver, and P's files. Dates from today, at 4 a.m. London.
// comments: card id -> its comments, newest first; older: that many newer Planner comments above P's. changed: step
// id -> [start, due] where a card has changed since the fix was proposed. extra: more cards, each [id, name, steps].
function fakeProjects({ comments = {}, older = 0, changed = {}, extra = [] } = {}) {
  const card = (id, name) => ({ id, name, parent: null, list: { id: LISTS.projects }, status: { status: 'in progress', type: 'custom' }, time_estimate: 0,
    due_date: at(d(15)), custom_fields: [{ id: 'fdl', name: 'Delivery lead', type: 'users', value: [{ id: 9, username: 'Delivery lead' }] }], assignees: [], group_assignees: [] });
  const step = (id, name, parent, s, e, hours) => ({ id, name, parent, list: { id: LISTS.projects }, status: { status: 'to do', type: 'open' },
    start_date: at(changed[id]?.[0] ?? s), due_date: at(changed[id]?.[1] ?? e), time_estimate: hours * HOUR, custom_fields: [], assignees: [{ id: 1, username: 'Studio' }], group_assignees: [] });
  const tasks = [card('k', K), card('p', P),
    step('kpf', 'Package files', 'k', d(4), d(4), 5), step('kir', 'Internal review', 'k', d(5), d(5), 1), step('kdl', 'Deliver', 'k', d(6), d(9), 1),
    step('ppf', 'Package files', 'p', d(4), d(4), 4),
    ...extra.flatMap(([id, name, steps]) => [card(id, name), ...steps.map(([sid, sname, s, e, h]) => step(sid, sname, id, s, e, h))])];
  const listed = Object.fromEntries(Object.entries(comments).map(([id, cs]) => [id, [
    ...(id === 'p' ? Array.from({ length: older }, (_, i) => said(`n${i}`, 'All checks clear.')) : []), ...cs]
    .map((c, i) => ({ id: c.id, date: String(9000 - i), user: c.by, reply_count: c.replies.length, comment_text: c.text, replies: c.replies }))]));
  const calls = [];
  forgetShared(); // the cards as this case has them, not a read shared from the case before
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, query: u.search, body: init.body ? JSON.parse(init.body) : null });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method === 'GET' && u.pathname.endsWith(`/list/${LISTS.projects}/task`)) return ok({ tasks: u.searchParams.get('page') === '0' ? tasks : [] });
    if (method === 'GET' && u.pathname.endsWith(`/list/${LISTS.intake}/task`)) return ok({ tasks: [] });
    const onCard = u.pathname.match(/\/task\/([^/]+)\/comment$/);
    if (method === 'GET' && onCard) {
      const all = (listed[onCard[1]] || []).map(({ replies, ...c }) => c);
      // newest first, 25 a page; the next page starts after the comment named by start and start_id
      const from = u.searchParams.get('start_id') ? all.findIndex((c) => c.id === u.searchParams.get('start_id')) + 1 : 0;
      return ok({ comments: all.slice(from, from + 25) });
    }
    const thread = u.pathname.match(/\/comment\/([^/]+)\/reply$/);
    if (method === 'GET' && thread) return ok({ comments: Object.values(listed).flat().find((c) => c.id === thread[1])?.replies || [] });
    // the workspace: one owner (role 1), the account lead a member (role 3)
    if (method === 'GET' && u.pathname.endsWith('/team')) {
      return ok({ teams: [{ id: 'w', members: [{ user: { id: 7, username: 'Owner', role: 1 } }, { user: { id: 5, username: 'Account lead', role: 3 } }] }] });
    }
    return ok({});
  };
  return { calls };
}
// The env with a fix store, and the reference of P's fix in it.
async function withFix({ moves = K_FOR_P, project = { id: 'p', name: P }, store = fakeFixes() } = {}) {
  const envF = { ...env, FIXES: store };
  const { ref } = await proposeFix(envF, { project, source: 'least slack first', moves });
  return { envF, ref, store };
}
const refused = (pattern) => (e) => e instanceof UserError && pattern.test(e.message);

test('a fix is stored under a reference derived from its card and every move; the same plan keeps it, another plan gets another', async () => {
  const { envF, ref, store } = await withFix();
  assert.match(ref, /^[0-9a-f]{8}$/);
  assert.equal((await proposeFix(envF, { project: { id: 'p', name: P }, source: 'least slack first', moves: K_FOR_P })).ref, ref);
  assert.equal((await withFix()).ref, ref); // derived, not drawn: a fresh store gives the same reference
  const later = [K_FOR_P[0], { ...K_FOR_P[1], to_due: isoOf(d(7)) }];
  assert.notEqual((await proposeFix(envF, { project: { id: 'p', name: P }, source: 'least slack first', moves: later })).ref, ref);
  assert.notEqual((await proposeFix(envF, { project: { id: 'k', name: K }, source: 'least slack first', moves: K_FOR_P })).ref, ref);
  const held = JSON.parse(store.held.get(`fix:${ref}`).value);
  assert.deepEqual([held.project_id, held.moves], ['p', K_FOR_P]);
  assert.equal(Math.round((store.held.get(`fix:${ref}`).until - Date.now()) / DAY), FIX_DAYS);
  assert.deepEqual(await proposeFix(env, { project: { id: 'p', name: P }, source: 'test a fix', moves: K_FOR_P }), // no store: no reference
    { ref: null, why: 'this server has no fix store (the FIXES binding), so Apply fix cannot write it' });
});

test('apply_fix writes exactly the moves stored under the Fix ref, on the go-ahead on the Planner\'s comment that carries it, and nothing else', async () => {
  const { envF, ref } = await withFix();
  // c1 carries this Fix ref, with the delivery lead's "apply"; c0, an earlier fix with its own reference, has an "apply" too.
  const { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [accountLead('r0'), lead('r1')]), fixComment('c0', '0badcafe', [lead('r9', 'apply')])] } });
  const r = await applyFix({ fix_ref: ref }, envF);
  assert.deepEqual(stepWrites(calls), [
    ['PUT', '/task/kpf', { start_date: Number(at(d(5))), due_date: Number(at(d(5))), start_date_time: false, due_date_time: false }],
    ['PUT', '/task/kir', { start_date: Number(at(d(6))), due_date: Number(at(d(6))), start_date_time: false, due_date_time: false }]]);
  const data = r.structuredContent;
  assert.equal(data.fix_ref, ref);
  assert.deepEqual([data.go_ahead.comment, data.go_ahead.reply], ['c1', 'r1']);
  assert.deepEqual(data.written.map((w) => [w.card, w.step, w.from, w.to, w.to_due]), [
    [K, 'Package files', isoOf(d(4)), isoOf(d(5)), isoOf(d(5))], [K, 'Internal review', isoOf(d(5)), isoOf(d(6)), isoOf(d(6))]]);
  assert.deepEqual(data.sends.map((s) => s.card), [P, K]);
  assert.match(data.summary, /^Applied the fix on Client P: new delivery area launch: 2 step moves written; /);
  // The card named, the Fix ref written as the comment shows it, and the moves as the comment lists them: the same fix.
  const again = fakeProjects({ comments: { p: [fixComment('c1', ref, [lead('r1')])] } });
  await applyFix({ fix_ref: `Fix ref: ${ref.toUpperCase()}`, project: P, moves: [
    { card: K, step: 'Package files', from: isoOf(d(4)), to: isoOf(d(5)) },
    { card: 'k', step: 'Internal review', from: isoOf(d(5)), to: isoOf(d(6)), to_due: isoOf(d(6)) }] }, envF);
  assert.equal(stepWrites(again.calls).length, 2);
});

test('an "apply" on Client K\'s fix never applies Client P\'s same-named step: each fix is its own card\'s, by its Fix ref', async () => {
  // The approval is on K: the Planner's comment on K carries K's fix (K's Package files a day later) and the delivery
  // lead's "apply". P has its own fix for its own Package files, on a comment with no reply.
  const store = fakeFixes();
  const { envF, ref: kRef } = await withFix({ store, project: { id: 'k', name: K }, moves: [K_FOR_P[0]] });
  const { ref: pRef } = await withFix({ store, moves: [move('p', P, 'ppf', 'Package files', d(4), d(4), d(5), d(5))] });
  const comments = { k: [fixComment('ck', kRef, [lead('rk')])], p: [fixComment('cp', pRef, [])] };
  let { calls } = fakeProjects({ comments });
  await assert.rejects(() => applyFix({ fix_ref: pRef }, envF), refused(/no reply from Delivery lead or a workspace owner .* on the Delivery Planner's comment that carries Fix ref [0-9a-f]{8} on Client P: new delivery area launch, so nothing was written/));
  await assert.rejects(() => applyFix({ fix_ref: kRef, project: 'p' }, envF), refused(/Fix ref [0-9a-f]{8} was proposed for Client K: travel kit launch, not for "p"; nothing was written/));
  await assert.rejects(() => applyFix({ fix_ref: kRef, moves: [{ card: 'p', step: 'Package files', from: isoOf(d(4)), to: isoOf(d(5)) }] }, envF),
    refused(/The moves given are not the fix stored under Fix ref [0-9a-f]{8}: Client P: new delivery area launch's Package files is not one of its moves; nothing was written/));
  // the moves alone are not a fix: no reference, nothing written
  await assert.rejects(() => applyFix({ project: 'k', moves: [{ card: 'p', step: 'Package files', from: isoOf(d(4)), to: isoOf(d(5)) }] }, envF), refused(/^No Fix ref was given/));
  assert.deepEqual(writes(calls), []);
  // K's own fix, applied by its reference, writes K's step and only K's
  ({ calls } = fakeProjects({ comments }));
  await applyFix({ fix_ref: kRef }, envF);
  assert.deepEqual(stepWrites(calls).map(([, path]) => path), ['/task/kpf']);
});

test('apply_fix writes a fix stored for a [Test] card by its id, as the tools that proposed it read one named exactly', async () => {
  const T = '[Test] Client Z: winter menu flyer';
  const { envF, ref } = await withFix({ project: { id: 't', name: T }, moves: [move('t', T, 'tpf', 'Package files', d(4), d(4), d(5), d(5))] });
  const { calls } = fakeProjects({ comments: { t: [fixComment('ct', ref, [lead('rt')])] }, extra: [['t', T, [['tpf', 'Package files', d(4), d(4), 3]]]] });
  const r = await applyFix({ fix_ref: ref }, envF);
  assert.deepEqual(stepWrites(calls).map(([, path]) => path), ['/task/tpf']);
  assert.equal(r.structuredContent.project, T);
});

test('apply_fix writes nothing for a stale fix: one proposed more than 14 days ago, even with an "apply" on its comment', async () => {
  const realNow = Date.now;
  for (const expires of [true, false]) { // gone from the store, or still there but too old
    Date.now = () => realNow() - (FIX_DAYS + 1) * DAY;
    const { envF, ref } = await withFix({ store: fakeFixes({ expires }) });
    Date.now = realNow;
    const { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [lead('r1')])] } });
    await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(/^No fix is stored under Fix ref [0-9a-f]{8}: it was never proposed, or it was proposed more than 14 days ago; run the Health check again for a fresh fix\. Nothing was written$/));
    assert.deepEqual(writes(calls), [], `expires: ${expires}`);
  }
  const { envF } = await withFix();
  await assert.rejects(() => applyFix({ fix_ref: 'abcdef12' }, envF), refused(/^No fix is stored under Fix ref abcdef12/)); // never proposed
  await assert.rejects(() => applyFix({ fix_ref: 'P-12' }, envF), refused(/is not a Fix ref/));
  await assert.rejects(() => applyFix({ fix_ref: 'abcdef12' }, env), refused(/no fix store/)); // a server with no store
});

test('apply_fix writes nothing when a step no longer starts or ends on the day its move is from, so a second "apply" changes nothing', async () => {
  const { envF, ref } = await withFix();
  const comments = { p: [fixComment('c1', ref, [lead('r1')])] };
  for (const [changed, pattern] of [
    [{ kir: [d(4), d(4)] }, /Client K: travel kit launch's Internal review starts .*, not .*: the cards have changed since the fix was proposed, so nothing was written/],
    [{ kpf: [d(4), d(5)] }, /Client K: travel kit launch's Package files ends .*, not .*: the cards have changed since the fix was proposed, so nothing was written/],
    [{ kpf: [d(5), d(5)], kir: [d(6), d(6)] }, /Package files starts .*: the cards have changed since the fix was proposed/]]) { // applied already
    const { calls } = fakeProjects({ comments, changed });
    await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(pattern));
    assert.deepEqual(writes(calls), []);
  }
});

test('apply_fix writes nothing when no reply, or no comment, goes with the Fix ref, and says which', async () => {
  const { envF, ref } = await withFix();
  let { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [])] } });
  await assert.rejects(() => applyFix({ fix_ref: ref }, envF),
    refused(/^there is no reply from Delivery lead or a workspace owner that reads "apply" or "@Delivery Planner apply" on the Delivery Planner's comment that carries Fix ref [0-9a-f]{8} on Client P: new delivery area launch, so nothing was written$/));
  assert.deepEqual(writes(calls), []);
  ({ calls } = fakeProjects({ comments: { p: [said('c1', 'All checks clear.', [lead('r1')])] } }));
  await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(/^the Delivery Planner has no comment on Client P: new delivery area launch that carries Fix ref [0-9a-f]{8}, so nothing was written$/));
  assert.deepEqual(writes(calls), []);
});

test('apply_fix writes nothing when the "apply" is on a different comment from the one that carries the Fix ref', async () => {
  const { envF, ref } = await withFix();
  const { calls } = fakeProjects({ comments: { p: [said('c2', 'Client P is now On track.', [lead('r2')]), fixComment('c1', ref, [])] } });
  await assert.rejects(() => applyFix({ fix_ref: ref }, envF),
    refused(/^the "apply" from Delivery lead or a workspace owner on Client P: new delivery area launch is on a different comment, not on the Delivery Planner's comment that carries Fix ref [0-9a-f]{8}, so nothing was written$/));
  assert.deepEqual(writes(calls), []);
});

test('apply_fix writes nothing on an "apply" from someone without the authority, or on a comment that is not the Planner\'s', async () => {
  const { envF, ref } = await withFix();
  let { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [accountLead('r0')])] } }); // the account lead is not the Delivery lead or an owner
  await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(/no reply from Delivery lead or a workspace owner/));
  assert.deepEqual(writes(calls), []);
  const copied = { ...fixComment('c3', ref, [lead('r3')]), by: { id: 5, username: 'Account lead' } }; // the reference copied into someone else's comment
  ({ calls } = fakeProjects({ comments: { p: [copied] } }));
  await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(/the Delivery Planner has no comment on .* that carries Fix ref/));
  assert.deepEqual(writes(calls), []);
});

test('the go-ahead is a reply of exactly "apply" or "@Delivery Planner apply", trimmed; one that only contains the word does not count', () => {
  const tag = { type: 'tag', user: { id: -7, username: 'Delivery Planner' }, text: '@Delivery Planner' };
  for (const yes of ['apply', '  Apply \n', '@Delivery Planner apply', '@delivery planner  APPLY']) assert.equal(saysApply({ comment_text: yes }), true, yes);
  // as ClickUp stores a reply typed with the @mention first: the parts in order, comment_text with the mention last
  assert.equal(saysApply({ comment: [tag, { text: ' apply' }], comment_text: ' apply@Delivery Planner' }), true);
  assert.equal(saysApply({ comment: [tag, { text: ' apply' }, { text: '\n', attributes: {} }] }), true);
  for (const no of ['do not apply', "don't apply", 'apply now', 'please apply', 'apply.', 'yes, apply', 'reapply', '', '@Delivery lead apply'])
    assert.equal(saysApply({ comment_text: no }), false, no);
  assert.equal(saysApply({ comment: [tag, { text: ' do not apply' }] }), false);
  assert.equal(saysApply({ comment: [{ type: 'tag', user: { id: 9, username: 'Delivery lead' } }, { text: ' apply' }] }), false);
});

test('apply_fix writes nothing when the delivery lead\'s reply only contains the word "apply"', async () => {
  const { envF, ref } = await withFix();
  for (const leadSays of ['do not apply', '@Delivery Planner do not apply', 'apply this next week']) {
    const { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [lead('r1', leadSays)])] } });
    await assert.rejects(() => applyFix({ fix_ref: ref }, envF), refused(/that reads "apply" or "@Delivery Planner apply".*so nothing was written/));
    assert.deepEqual(writes(calls), [], leadSays);
  }
});

test('apply_fix finds the comment that carries the Fix ref past the latest 25: it reads every page of the card\'s comments', async () => {
  const { envF, ref } = await withFix();
  const { calls } = fakeProjects({ older: 30, comments: { p: [fixComment('c1', ref, [lead('r1')])] } }); // 30 newer comments above it
  const r = await applyFix({ fix_ref: ref }, envF);
  assert.deepEqual([r.structuredContent.go_ahead.comment, r.structuredContent.go_ahead.reply], ['c1', 'r1']);
  assert.equal(stepWrites(calls).length, 2);
  const pages = calls.filter((c) => c.method === 'GET' && c.path.endsWith('/task/p/comment')).map((c) => c.query);
  assert.deepEqual(pages, ['', '?start=8976&start_id=n24']); // the second page starts from the oldest comment on the first
});

test('apply_fix also takes the go-ahead from a workspace owner', async () => {
  const { envF, ref } = await withFix();
  const { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [accountLead('r0'), owner('r2')])] } }); // the account lead's does not count
  const r = await applyFix({ fix_ref: ref }, envF);
  assert.equal(r.structuredContent.go_ahead.reply, 'r2');
  assert.equal(stepWrites(calls).length, 2);
});

test('apply_fix posts no comment; it returns the confirmation for the Planner to post: "The fix is applied.", each move, the new send', async () => {
  const { envF, ref } = await withFix({ moves: [K_FOR_P[0], { ...K_FOR_P[1], to_due: isoOf(d(7)) }] });
  const { calls } = fakeProjects({ comments: { p: [fixComment('c1', ref, [lead('r1')])] } });
  const r = await applyFix({ fix_ref: ref }, envF);
  assert.equal(writes(calls).filter(([m, path]) => m === 'POST' && /\/comment$/.test(path)).length, 0);
  const lines = r.structuredContent.confirmation_lines;
  assert.equal(lines[0], 'The fix is applied.');
  assert.equal(lines[1], `Client K: travel kit launch's Package files moves from ${dayText(d(4))} to ${dayText(d(5))}.`);
  assert.equal(lines[2], `Client K: travel kit launch's Internal review moves from ${dayText(d(5))} to ${dayText(d(6))}, ending ${dayText(d(7))}.`);
  assert.match(lines[3], /^Client P: new delivery area launch (sends|has no send)/);
  assert.match(r.structuredContent.summary, /Post the confirmation on the card: The fix is applied\./);
});

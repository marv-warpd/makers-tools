// Unit tests for the three write tools the Delivery Planner writes through: set_health, write_plan and
// write_rework_plan. Each calculates again what a read tool gave, writes only when it is
// the same, and writes exactly that. ClickUp is a stand-in (fetch replaced) that records every write.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITES } from '../writes.js';
import { TOOLS } from '../tools.js';
import { LISTS, WS, DAY_MS, UserError, forgetShared, today as todayOf, addWorkingDays, isoDay } from '../data.js';

const HOUR = 3_600_000;
const env = { CLICKUP_TOKEN: 'test', TIME_ZONE: 'Europe/London' };
const env0 = { TIME_ZONE: 'Europe/London' };
const d = (n) => addWorkingDays(todayOf(env0) + 1, n);
const at = (dn) => String(dn * DAY_MS + 4 * HOUR);
const users = (...xs) => xs.map(([id, username]) => ({ id, username }));
const LEADS = [
  { id: 'fal', name: 'Account lead', type: 'users', value: users([5, 'Account lead']) },
  { id: 'fcl', name: 'Creative lead', type: 'users', value: users([6, 'Creative lead']) },
  { id: 'fdl', name: 'Delivery lead', type: 'users', value: users([9, 'Delivery lead']) },
];
const HEALTH = { id: 'fh', name: 'Health', type: 'drop_down', type_config: { options: [
  { id: 'h0', name: 'On track', orderindex: 0 }, { id: 'h1', name: 'At risk', orderindex: 1 }, { id: 'h2', name: 'Off track', orderindex: 2 }] } };
const step = (id, name, parent, list, { s = null, e = null, hours = 1, people = [], teams = [], status = 'to do' } = {}) => ({
  id, name, parent, list: { id: list }, status: { status, type: 'open' }, start_date: s === null ? null : at(s), due_date: e === null ? null : at(e),
  time_estimate: hours * HOUR, custom_fields: [], assignees: people, group_assignees: teams.map((name) => ({ name })) });

// A request at Delivery review on Intake, with no dates yet; a project In progress on Projects with a rework card.
function workspace({ feasible = null, health = null, reason = null, requestStatus = 'delivery review', reworkDated = false } = {}) {
  const request = { id: 'rq', name: 'Client Z: spring flyer', parent: null, list: { id: LISTS.intake }, status: { status: requestStatus, type: 'custom' },
    time_estimate: 0, assignees: [], group_assignees: [],
    custom_fields: [...LEADS, { id: 'fjt', name: 'Job type', type: 'drop_down', value: null }, { id: 'ffd', name: 'Feasible date', type: 'date', value: feasible },
      { id: 'frq', name: 'Requested date', type: 'date', value: at(d(20)) }] };
  const project = { id: 'pj', name: 'Client Z: summer launch', parent: null, list: { id: LISTS.projects }, status: { status: 'in progress', type: 'custom' },
    due_date: at(d(30)), time_estimate: 0, assignees: [], group_assignees: [],
    custom_fields: [...LEADS, { ...HEALTH, value: health }, { id: 'fhr', name: 'Health reason', type: 'short_text', value: reason }] };
  const intake = [request,
    step('rwc', 'Write copy', 'rq', LISTS.intake, { hours: 1.5, teams: ['Copy'] }),
    step('rrc', 'Review copy', 'rq', LISTS.intake, { hours: 0.5, people: users([6, 'Creative lead']) }),
    step('rpf', 'Package files', 'rq', LISTS.intake, { hours: 1, teams: ['Studio'] }),
    step('rir', 'Internal review', 'rq', LISTS.intake, { hours: 0.5 }), // no owner yet: the plan names the account lead
    step('rdl', 'Deliver', 'rq', LISTS.intake, { hours: 0.5, people: users([5, 'Account lead']) })];
  const projects = [project,
    step('pwc', 'Write copy', 'pj', LISTS.projects, { s: d(1), e: d(1), hours: 2, teams: ['Copy'], status: 'complete' }),
    step('ppf', 'Package files', 'pj', LISTS.projects, { s: d(8), e: d(8), hours: 1, teams: ['Studio'] }),
    step('pdl', 'Deliver', 'pj', LISTS.projects, { s: d(9), e: d(12), hours: 0.5, people: users([5, 'Account lead']) }),
    { ...step('rw', 'Internal rework: copy', 'pj', LISTS.projects, { hours: 0 }), assignees: [] },
    step('rws', 'Write copy', 'rw', LISTS.projects, reworkDated ? { s: d(2), e: d(2), hours: 1, teams: ['Copy'] } : { hours: 1, teams: ['Copy'] })];
  projects[1].status = { status: 'complete', type: 'closed' };
  const calls = [];
  forgetShared();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname.replace(/^\/api\/v[23]/, ''), body: init.body ? JSON.parse(init.body) : null });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (method !== 'GET') return ok({});
    const page = u.searchParams.get('page');
    if (u.pathname.endsWith(`/list/${LISTS.intake}/task`)) return ok({ tasks: page === '0' ? intake : [] });
    if (u.pathname.endsWith(`/list/${LISTS.projects}/task`)) return ok({ tasks: page === '0' ? projects : [] });
    if (u.pathname.endsWith('/task/rq')) return ok(request);
    if (u.pathname.endsWith('/task/pj')) return ok(project);
    if (u.pathname.endsWith('/team')) {
      return ok({ teams: [{ id: WS, members: [[5, 'Account lead'], [6, 'Creative lead'], [9, 'Delivery lead'], [1, 'Copywriter'], [2, 'Studio']]
        .map(([id, username]) => ({ user: { id, username, role: 3 } })) }] });
    }
    if (u.pathname.endsWith('/group')) return ok({ groups: [{ name: 'Copy', members: [{ username: 'Copywriter' }] }, { name: 'Studio', members: [{ username: 'Studio' }] }] });
    if (u.pathname.includes('/time_entries')) return ok({ data: [] });
    if (u.pathname.includes('/docs/')) return ok({ pages: [] });
    return ok({ tasks: [] });
  };
  return calls;
}
const writes = (calls) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);
const run = async (name, args) => (await (WRITES[name] || TOOLS[name]).run(args, env)).structuredContent;
const dateOnly = (iso) => Date.parse(`${iso}T04:00:00Z`); // 4 a.m. London in winter: a date with no time

test('write_plan writes the first plan exactly as Plan new work gave it: dates, the estimate only where it differs, an owner only where none, the Feasible date', async () => {
  let calls = workspace();
  const plan = await run('plan_new_work', { request: 'rq', keep_estimates: true });
  assert.ok(plan.plan_key);
  workspace();
  const text = (await TOOLS.plan_new_work.run({ request: 'rq', keep_estimates: true }, env)).content[0].text;
  assert.match(text, new RegExp(`Plan key ${plan.plan_key}: give it to Write plan`)); // the agent reads the text
  calls = workspace();
  const r = await run('write_plan', { request: 'rq', plan_key: plan.plan_key, keep_estimates: true });
  const w = writes(calls);
  const byId = Object.fromEntries(plan.steps.map((s) => [s.step, s]));
  const ids = { 'Write copy': 'rwc', 'Review copy': 'rrc', 'Package files': 'rpf', 'Internal review': 'rir', Deliver: 'rdl' };
  for (const [name, id] of Object.entries(ids)) {
    const put = w.find(([m, p]) => m === 'PUT' && p === `/task/${id}`);
    assert.ok(put, `${name} written`);
    assert.equal(put[2].start_date, dateOnly(byId[name].start));
    assert.equal(put[2].due_date, dateOnly(byId[name].due));
    assert.equal(put[2].start_date_time, false);
    assert.equal('time_estimate' in put[2], false, `${name}: the estimate is kept`);
  }
  // the one step with no person and no Team takes the plan's owner; the others keep theirs
  assert.deepEqual(w.find(([, p]) => p === '/task/rir')[2].assignees, { add: [5] });
  assert.equal('assignees' in w.find(([, p]) => p === '/task/rwc')[2], false);
  assert.deepEqual(w.at(-1), ['POST', '/task/rq/field/ffd', { value: dateOnly(plan.feasible_date), value_options: { time: false } }]);
  assert.equal(w.length, 6); // five steps and the Feasible date, nothing else
  assert.equal(r.feasible_date, plan.feasible_date);
  assert.equal(r.changed.length, 6);
});

test('write_plan writes nothing when the plan has changed since, on a card In progress, or when a plan was written before', async () => {
  let calls = workspace();
  await assert.rejects(() => run('write_plan', { request: 'rq', plan_key: 'not-this-plan', keep_estimates: true }),
    (e) => e instanceof UserError && /has changed since Plan new work gave it/.test(e.message));
  assert.deepEqual(writes(calls), []);
  calls = workspace({ requestStatus: 'in progress' });
  await assert.rejects(() => run('write_plan', { request: 'rq', plan_key: 'x' }), (e) => e instanceof UserError && /is In progress/.test(e.message));
  assert.deepEqual(writes(calls), []);
  calls = workspace({ feasible: String(Date.UTC(2026, 11, 20, 4)) });
  const plan = await run('plan_new_work', { request: 'rq', keep_estimates: true });
  calls = workspace({ feasible: String(Date.UTC(2026, 11, 20, 4)) });
  await assert.rejects(() => run('write_plan', { request: 'rq', plan_key: plan.plan_key, keep_estimates: true }),
    (e) => e instanceof UserError && /already has a Feasible date/.test(e.message));
  assert.deepEqual(writes(calls), []);
  await assert.rejects(() => run('write_plan', { request: 'rq' }), (e) => e instanceof UserError && /No plan_key/.test(e.message));
});

test('write_rework_plan dates the rework card\'s steps as Plan rework gave them and assigns the card to the Delivery lead; nothing else', async () => {
  let calls = workspace();
  const plan = await run('plan_rework', { rework: 'rw' });
  workspace();
  assert.match((await TOOLS.plan_rework.run({ rework: 'rw' }, env)).content[0].text, new RegExp(`Plan key ${plan.plan_key}: give it to Write rework plan`));
  const mine = plan.steps.find((s) => s.step === 'Write copy' && s.planned_start === null);
  calls = workspace();
  const r = await run('write_rework_plan', { rework: 'rw', plan_key: plan.plan_key });
  const w = writes(calls);
  assert.deepEqual(w, [
    ['PUT', '/task/rws', { start_date: dateOnly(mine.start), due_date: dateOnly(mine.due), start_date_time: false, due_date_time: false }],
    ['PUT', '/task/rw', { assignees: { add: [9] } }]]);
  assert.deepEqual(r.assigned, ['Delivery lead']);
  // a plan that moved since writes nothing
  calls = workspace();
  await assert.rejects(() => run('write_rework_plan', { rework: 'rw', plan_key: 'old' }), (e) => e instanceof UserError && /has changed since Plan rework gave it/.test(e.message));
  assert.deepEqual(writes(calls), []);
});

test('set_health writes Health and Health reason as Forecast delivery reads the card, only where they differ; a changed reading is not written', async () => {
  let calls = workspace();
  const read = await run('forecast_delivery', { project: 'pj' });
  const health = read.health_by_the_checks;
  calls = workspace({ health: health === 'At risk' ? 0 : 1 });
  const r = await run('set_health', { cards: [{ card: 'pj', health, reason: 'All checks clear' }] });
  assert.deepEqual(writes(calls), [
    ['POST', '/task/pj/field/fh', { value: ({ 'On track': 'h0', 'At risk': 'h1', 'Off track': 'h2' })[health] }],
    ['POST', '/task/pj/field/fhr', { value: 'All checks clear' }]]);
  assert.equal(r.written.length, 1);
  // already as asked: nothing written
  calls = workspace({ health: ({ 'On track': 0, 'At risk': 1, 'Off track': 2 })[health], reason: 'All checks clear' });
  const again = await run('set_health', { cards: [{ card: 'pj', health, reason: 'All checks clear' }] });
  assert.deepEqual(writes(calls), []);
  assert.equal(again.kept.length, 1);
  // a reading that differs from the one asked: refused, nothing written
  calls = workspace();
  const other = health === 'Off track' ? 'On track' : 'Off track';
  await assert.rejects(() => run('set_health', { cards: [{ card: 'pj', health: other, reason: 'Stale' }] }),
    (e) => e instanceof UserError && new RegExp(`now reads ${health}, not ${other}`).test(e.message));
  assert.deepEqual(writes(calls), []);
  // a reason that is not one short line is refused before anything is read
  await assert.rejects(() => run('set_health', { cards: [{ card: 'pj', health, reason: 'x'.repeat(101) }] }), /one line of 1 to 100 characters/);
});

// --- Fix refs: Test a fix stores a change of dates as a fix for Apply fix ---
test('Test a fix gives a Fix ref for a change of dates and stores exactly that move; the same change keeps it; a new owner gets none', async () => {
  const calls = workspace();
  const held = new Map();
  const envF = { ...env, FIXES: { get: async (k) => (held.has(k) ? JSON.parse(held.get(k)) : null), put: async (k, v) => { held.set(k, v); } } };
  const tryIt = async (args) => (await TOOLS.test_a_fix.run({ project: 'pj', ...args }, envF));
  const r = await tryIt({ what_if_step: 'Package files', what_if_start: isoDay(d(7)) });
  const data = r.structuredContent;
  assert.match(data.fix_ref, /^[0-9a-f]{8}$/);
  assert.deepEqual(data.fix_moves, [{ card_id: 'pj', card: 'Client Z: summer launch', step_id: 'ppf', step: 'Package files',
    from: isoDay(d(8)), from_due: isoDay(d(8)), to: isoDay(d(7)), to_due: isoDay(d(7)) }]);
  assert.deepEqual(JSON.parse(held.get(`fix:${data.fix_ref}`)).moves, data.fix_moves);
  assert.match(r.content[0].text, new RegExp(`Fix ref: ${data.fix_ref}, for the tested change, 1 step move: Client Z: summer launch's Package files from ${isoDay(d(8))} to ${isoDay(d(7))}\\.`));
  assert.equal((await tryIt({ changes: [{ step: 'Package files', start: isoDay(d(7)) }] })).structuredContent.fix_ref, data.fix_ref);
  const owner = (await tryIt({ what_if_step: 'Package files', what_if_owner: 'Studio', what_if_start: isoDay(d(7)) })).structuredContent;
  assert.equal(owner.fix_ref, null);
  assert.match(owner.no_fix_ref, /a new owner is not a step move/);
  assert.equal(held.size, 1);
  assert.deepEqual(writes(calls), []); // nothing written to ClickUp
});

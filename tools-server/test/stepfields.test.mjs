// Tests for the step fields: a job's Agreement type, Job type, Rate, Account lead, Delivery lead,
// Creative lead and Job due copied onto every step under it, on each path that writes them: approval (the event
// service's /approved), the Rework label (the event service's /step-fields), and a change card (its own job, under its
// project); plan_rework only reads. ClickUp
// is a stand-in (fetch replaced) that applies each write, so a second run shows nothing left to write.
//   cd tools-server && node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepFieldWrites, copyStepFields, jobOf, COPIED, JOB_DUE } from '../stepfields.js';
import { internalWrite } from '../writes.js';
import { TOOLS } from '../tools.js';
import worker, { approve, stepFields } from '../../event-service/worker.js';
import { LISTS, WS, makeTree, forgetShared, allTasks } from '../data.js';

const DUE = Date.UTC(2026, 11, 4, 12);
const CHANGE_DUE = Date.UTC(2026, 11, 18, 12);
const opts = (...names) => names.map((name, orderindex) => ({ id: `opt-${name}`, name, orderindex }));
const FIELDS = [
  { id: 'f-kind', name: 'Request kind', type: 'drop_down', type_config: { options: opts('New project', 'Change') } },
  { id: 'f-agree', name: 'Agreement type', type: 'drop_down', type_config: { options: opts('Fixed fee', 'Retainer') } },
  { id: 'f-jobtype', name: 'Job type', type: 'drop_down', type_config: { options: opts('Launch', 'Video') } },
  { id: 'f-rate', name: 'Rate', type: 'currency', type_config: {} },
  { id: 'f-al', name: 'Account lead', type: 'users', type_config: {} },
  { id: 'f-dl', name: 'Delivery lead', type: 'users', type_config: {} },
  { id: 'f-cl', name: 'Creative lead', type: 'users', type_config: {} },
  { id: 'f-due', name: 'Job due', type: 'date', type_config: {} },
  { id: 'f-budget', name: 'Budget', type: 'currency', type_config: {} },
  { id: 'f-rework', name: 'Rework', type: 'labels', type_config: { options: [{ id: 'lab-client', label: 'Client' }, { id: 'lab-internal', label: 'Internal' }] } },
];
const user = (id) => ({ id, username: `user ${id}` });
const pick = (name, label) => FIELDS.find((f) => f.name === name).type_config.options.find((o) => o.name === label).orderindex;

// A made-up Projects List: a launch job with two steps (one holding a different Rate and Delivery lead), a stage
// subtask, a rework card with a step, and a change card (its own agreement, type, rate and Due date) with a step.
function workspace() {
  const card = (id, name, parent, values = {}, extra = {}) => ({ id, name, parent, status: { status: 'to do', type: 'open' },
    custom_fields: FIELDS.map((f) => ({ ...f, value: values[f.name] ?? null })), assignees: [], ...extra });
  const job = { 'Request kind': 0, 'Agreement type': pick('Agreement type', 'Fixed fee'), 'Job type': pick('Job type', 'Launch'), Rate: 65,
    'Account lead': [user(7)], 'Delivery lead': [user(8)], 'Creative lead': [user(9)] };
  return [
    card('J1', 'Client Z: spring launch', null, job, { due_date: String(DUE) }),
    card('S1', 'Write copy', 'J1'),
    card('S2', 'Design', 'J1', { Rate: 80, 'Account lead': [user(7)], 'Delivery lead': [user(10)] }),
    card('ST', 'Confirm and approve', 'J1'),
    card('R', 'Internal rework: web', 'J1'),
    card('R1', 'Rework: Design', 'R', {}, { start_date: String(Date.UTC(2026, 10, 23, 12)), due_date: String(Date.UTC(2026, 10, 24, 12)), time_estimate: String(4 * 3_600_000) }),
    card('C', 'Client Z: spring launch video', 'J1', { 'Request kind': 1, 'Agreement type': pick('Agreement type', 'Retainer'), 'Job type': pick('Job type', 'Video'), Rate: 70,
      'Account lead': [user(7)], 'Delivery lead': [user(8)], 'Creative lead': [user(9)] }, { due_date: String(CHANGE_DUE) }),
    card('C1', 'Write copy: video', 'C'),
  ];
}

// The stand-in ClickUp: serves the List and applies each field write to the card, as ClickUp would.
const reads = [];
const comments = new Map(); // task -> comments posted
function serve(tasks, { listed = tasks } = {}) {
  forgetShared();
  reads.length = 0;
  comments.clear();
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/\/api\/v[23]/, '');
    const method = init.method || 'GET';
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    const m = path.match(/^\/task\/([^/]+)\/field\/([^/]+)$/);
    if (method === 'POST' && m) {
      const body = JSON.parse(init.body);
      const t = tasks.find((x) => x.id === m[1]);
      const f = t.custom_fields.find((x) => x.id === m[2]);
      writes.push({ task: m[1], field: f.name, value: body.value, value_options: body.value_options });
      if (f.type === 'drop_down') f.value = f.type_config.options.find((o) => o.id === body.value).orderindex;
      else if (f.type === 'users') f.value = [...(f.value || []).filter((x) => !body.value.rem.includes(x.id)), ...body.value.add.map(user)];
      else f.value = body.value;
      return ok({});
    }
    const said = path.match(/^\/task\/([^/]+)\/comment$/);
    if (said && method === 'POST') { comments.set(said[1], [...(comments.get(said[1]) || []), { comment_text: JSON.parse(init.body).comment_text }]); return ok({}); }
    if (said) return ok({ comments: comments.get(said[1]) || [] });
    if (method === 'PUT') { // a status change, applied as ClickUp would
      const body = JSON.parse(init.body);
      writes.push({ task: path.split('/')[2], put: body });
      const t = tasks.find((x) => x.id === path.split('/')[2]);
      if (t && body.status) t.status = { status: body.status, type: body.status === 'complete' ? 'closed' : 'open' };
      return ok({});
    }
    const page = Number(u.searchParams.get('page') || 0);
    if (path === `/list/${LISTS.projects}/task`) return ok({ tasks: page === 0 ? listed : [] });
    if (path === `/list/${LISTS.projects}/field`) return ok({ fields: FIELDS });
    if (path === `/list/${LISTS.intake}/task`) return ok({ tasks: [] });
    if (path === '/team') return ok({ teams: [{ id: WS, members: [{ user: { id: 7, username: 'Studio' } }] }] });
    const one = path.match(/^\/task\/([^/]+)$/);
    if (one) { // a direct read: the card, and its own subtasks (one level) when asked for, as ClickUp gives them
      const t = tasks.find((x) => x.id === one[1]);
      reads.push(one[1]);
      return ok({ ...t, ...(u.searchParams.get('include_subtasks') ? { subtasks: tasks.filter((x) => x.parent === one[1]) } : {}) });
    }
    return ok({});
  };
  return writes;
}
const env = { CLICKUP_TOKEN: 'test', TIME_ZONE: 'UTC' };

test('which steps take which job\'s fields: every task under the job at any depth, down to a change card, which is its own job', async () => {
  const tasks = workspace();
  serve(tasks);
  const tree = makeTree(await allTasks(env, LISTS.projects, true));
  assert.equal(jobOf(tree, 'R1').id, 'J1'); // a rework step's job is the project
  assert.equal(jobOf(tree, 'C1').id, 'C'); // a change step's job is the change card
  const plan = stepFieldWrites(tree, tree.byId.get('J1'), FIELDS, env);
  assert.equal(plan.steps, 5); // S1, S2, the stage subtask, the rework card and its step; not the change card or its step
  assert.deepEqual([...new Set(plan.writes.map((w) => w.task))].sort(), ['R', 'R1', 'S1', 'S2', 'ST']);
  const on = (task, name) => plan.writes.find((w) => w.task === task && w.name === name);
  assert.deepEqual(on('S2', 'Rate').value, 65); // a different Rate is brought into line
  assert.equal(on('S2', 'Account lead'), undefined); // the same value is not written again
  assert.deepEqual(on('S2', 'Delivery lead').value, { add: [8], rem: [10] });
  assert.deepEqual(on('S1', 'Agreement type').value, 'opt-Fixed fee'); // a dropdown by its option's id
  assert.deepEqual([on('S1', JOB_DUE).value, on('S1', JOB_DUE).value_options], [DUE, { time: false }]);
  assert.equal(plan.writes.length, 5 * (COPIED.length + 1) - 1); // 35 less S2's Account lead
  assert.deepEqual(plan.missing, []);
});

test('the approval path: /approved copies the job\'s fields onto its steps after the baseline; a second approval writes nothing', async () => {
  const tasks = workspace();
  const writes = serve(tasks);
  const MAKERS = { freezeBaseline: async () => ({ ok: true, skipped: 'baseline already set', changed: [] }),
    copyStepFields: (args) => internalWrite('copy_step_fields', args, env) };
  const r = await approve('J1', { ...env, MAKERS });
  assert.deepEqual(r.steps.changed, ['Agreement type on 5 steps', 'Job type on 5 steps', 'Rate on 5 steps', 'Account lead on 4 steps',
    'Delivery lead on 5 steps', 'Creative lead on 5 steps', 'Job due on 5 steps']);
  assert.deepEqual(r.closed, ['Confirm and approve']);
  assert.equal(writes.filter((w) => w.field).length, 34);
  assert.equal(writes.some((w) => w.task === 'C' || w.task === 'C1'), false); // the change card keeps its own
  const again = serve(tasks);
  const r2 = await approve('J1', { ...env, MAKERS });
  assert.deepEqual([r2.steps.changed, again.filter((w) => w.field).length], [[], 0]);
});

test('the change card path: its steps take the change card\'s own agreement, type, rate and Due date, as at its approval', async () => {
  const tasks = workspace();
  const writes = serve(tasks);
  const r = await copyStepFields({ job: 'C' }, env);
  assert.equal(r.steps, 1);
  const c1 = Object.fromEntries(writes.filter((w) => w.task === 'C1').map((w) => [w.field, w.value]));
  assert.deepEqual(c1, { 'Agreement type': 'opt-Retainer', 'Job type': 'opt-Video', Rate: 70, 'Account lead': { add: [7], rem: [] },
    'Delivery lead': { add: [8], rem: [] }, 'Creative lead': { add: [9], rem: [] }, 'Job due': CHANGE_DUE });
  // a later copy on the project leaves the change card's steps alone
  const later = serve(tasks);
  await copyStepFields({ job: 'J1' }, env);
  assert.equal(later.some((w) => w.task === 'C1'), false);
});

test('plan_rework only reads: planning a rework card writes nothing', async () => {
  const tasks = workspace();
  const writes = serve(tasks);
  const r = (await TOOLS.plan_rework.run({ rework: 'R' }, env)).structuredContent;
  assert.equal(r.rework, 'Internal rework: web');
  assert.deepEqual(writes, []);
});

test('the Rework label path: /step-fields gives the rework card and its steps the project\'s fields, and only them; a second pass takes a step added late', async () => {
  const tasks = workspace();
  const writes = serve(tasks);
  let calls = 0;
  const MAKERS = { liftReworkBudget: (args) => internalWrite('lift_rework_budget', args, env), copyStepFields: async (args) => {
    const r = await internalWrite('copy_step_fields', args, env);
    if (++calls === 1) tasks.push({ ...tasks.find((t) => t.id === 'R1'), id: 'R2', name: 'Rework: Package files', custom_fields: tasks.find((t) => t.id === 'S1').custom_fields.map((f) => ({ ...f, value: null })) });
    return r;
  } };
  const r = await stepFields('R', { ...env, MAKERS }, null, 0);
  assert.deepEqual(new Set(writes.filter((w) => w.field).map((w) => w.task)), new Set(['R', 'R1', 'R2'])); // not S1, S2 or the stage subtask
  assert.deepEqual(r.steps.changed, ['Agreement type on 2 steps', 'Job type on 2 steps', 'Rate on 2 steps', 'Account lead on 2 steps',
    'Delivery lead on 2 steps', 'Creative lead on 2 steps', 'Job due on 2 steps']); // the first pass: the card and its one step
  const r2 = Object.fromEntries(writes.filter((w) => w.task === 'R2').map((w) => [w.field, w.value]));
  assert.deepEqual([r2.Rate, r2['Job due']], [65, DUE]);
});

test('the route: /step-fields takes the webhook\'s task id behind the secret, and runs its second pass after answering', async () => {
  const tasks = workspace();
  const writes = serve(tasks);
  const later = [];
  const MAKERS = { copyStepFields: (args) => internalWrite('copy_step_fields', args, env), liftReworkBudget: (args) => internalWrite('lift_rework_budget', args, env) };
  const call = (secret) => worker.fetch(new Request('https://x/step-fields', { method: 'POST', headers: { 'X-Webhook-Secret': secret },
    body: JSON.stringify({ payload: { id: 'R1' } }) }), { ...env, WEBHOOK_SECRET: 's', MAKERS }, { waitUntil: (p) => later.push(p) });
  assert.equal((await call('wrong')).status, 401);
  const res = await call('s');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).steps.changed.length, 7);
  assert.equal(later.length, 1); // the second pass is left to run after the answer
  assert.deepEqual([...new Set(writes.filter((w) => w.field).map((w) => w.task))], ['R1']); // a step: itself only
});

test('a field the job has no value for is left alone on its steps and named', async () => {
  const tasks = workspace();
  tasks[0].custom_fields.find((f) => f.name === 'Rate').value = null;
  const writes = serve(tasks);
  const r = await copyStepFields({ job: 'J1' }, env);
  assert.deepEqual(r.missing, ['Rate']);
  assert.equal(writes.some((w) => w.field === 'Rate'), false); // S2 keeps its 80
  assert.match(r.summary, /the job has no Rate, so its steps keep theirs/);
});

test('the copy reads the job card by card, so a card the List does not list yet (just moved by Rule 8) is still copied', async () => {
  const tasks = workspace();
  const writes = serve(tasks, { listed: [] }); // the List's listing lags behind the move
  const r = await copyStepFields({ job: 'J1' }, env);
  assert.equal(r.written, 34);
  assert.equal(writes.filter((w) => w.field).length, 34);
  assert.equal(reads.includes('C'), false); // the change card, a job of its own, is not read into
});

test('the Budget lift: a client chain raises its job\'s Budget by its estimated hours × Rate once, with one comment; an internal chain changes no money', async () => {
  const tasks = workspace();
  const job = tasks.find((t) => t.id === 'J1');
  job.custom_fields.find((f) => f.name === 'Budget').value = 3000;
  const label = (which) => FIELDS.map((f) => ({ ...f, value: f.name === 'Rework' ? [`lab-${which}`] : null }));
  const hours = (h) => String(h * 3_600_000);
  tasks.find((t) => t.id === 'R').custom_fields = label('internal'); // the workspace's Internal rework: web, its step 4 h
  tasks.push({ ...tasks.find((t) => t.id === 'R'), id: 'CR', name: 'Client rework: web', custom_fields: label('client') },
    { ...tasks.find((t) => t.id === 'R1'), id: 'CR1', parent: 'CR', time_estimate: hours(3) }, { ...tasks.find((t) => t.id === 'R1'), id: 'CR2', name: 'Rework: Package files', parent: 'CR', time_estimate: hours(2) });
  const writes = serve(tasks);
  const MAKERS = { copyStepFields: (args) => internalWrite('copy_step_fields', args, env), liftReworkBudget: (args) => internalWrite('lift_rework_budget', args, env) };
  await stepFields('CR', { ...env, MAKERS }, null, 0);
  const budget = () => writes.filter((w) => w.field === 'Budget');
  assert.deepEqual(budget().map((w) => [w.task, w.value]), [['J1', 3325]]); // 5 h × $65 on the job, not on the rework card
  assert.deepEqual(comments.get('CR').map((c) => c.comment_text), ['Budget +$325 for the included round: 5 h at $65']);
  await stepFields('CR', { ...env, MAKERS }, null, 0); // the label set again: never lifted twice
  assert.equal(budget().length, 1);
  assert.equal(comments.get('CR').length, 1);
  const internal = await internalWrite('lift_rework_budget', { task: 'R' }, env);
  assert.match(internal.sentence, /an internal rework changes no money/);
  assert.equal(budget().length, 1);
  assert.equal(comments.has('R'), false);
});

test('the Budget lift happens once per chain: the template labels the chain\'s steps too, and the label rule calls /step-fields for each; only the rework card lifts', async () => {
  const tasks = workspace();
  tasks.find((t) => t.id === 'J1').custom_fields.find((f) => f.name === 'Budget').value = 3000;
  tasks.find((t) => t.id === 'C').custom_fields.find((f) => f.name === 'Budget').value = 1000;
  const client = () => FIELDS.map((f) => ({ ...f, value: f.name === 'Rework' ? ['lab-client'] : null }));
  const hours = (h) => String(h * 3_600_000);
  const step = (id, parent, h) => ({ ...tasks.find((t) => t.id === 'R1'), id, parent, time_estimate: hours(h), custom_fields: client() });
  // a client chain on the project: the card and both its steps labeled, and a step under a step (labeled as well)
  tasks.push({ ...tasks.find((t) => t.id === 'R'), id: 'CR', name: 'Client rework: web', custom_fields: client() },
    step('CR1', 'CR', 3), step('CR2', 'CR', 2), step('CR2a', 'CR2', 0.5),
    // a client chain under the change card, its own job: lifts the change card's Budget at the change card's Rate
    { ...tasks.find((t) => t.id === 'R'), id: 'CC', name: 'Client rework: video', parent: 'C', custom_fields: client() }, step('CC1', 'CC', 2));
  const writes = serve(tasks);
  const MAKERS = { copyStepFields: (args) => internalWrite('copy_step_fields', args, env), liftReworkBudget: (args) => internalWrite('lift_rework_budget', args, env) };
  // the label rule fires for every labeled task, steps first or card first: the order does not matter
  for (const id of ['CR1', 'CR2a', 'CR', 'CR2', 'CC1', 'CC', 'CR']) await stepFields(id, { ...env, MAKERS }, null, 0);
  const budget = writes.filter((w) => w.field === 'Budget');
  assert.deepEqual(budget.map((w) => [w.task, w.value]), [['J1', 3357.5], ['C', 1140]]); // 5.5 h × $65; 2 h × $70
  assert.deepEqual(comments.get('CR').map((c) => c.comment_text), ['Budget +$357.50 for the included round: 5.5 h at $65']);
  assert.deepEqual(comments.get('CC').map((c) => c.comment_text), ['Budget +$140 for the included round: 2 h at $70']);
  for (const id of ['CR1', 'CR2', 'CR2a', 'CC1']) assert.equal(comments.has(id), false, `${id} carries no lift`);
  const said = await internalWrite('lift_rework_budget', { task: 'CR2a' }, env);
  assert.match(said.sentence, /a step under the rework card; only the rework card lifts its chain/);
});

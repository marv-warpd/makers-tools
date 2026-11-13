// The event service: three routes that ClickUp automations call by webhook, each behind the X-Webhook-Secret header,
// each safe to repeat. The writes run in the makers-tools Worker (writes.js, stepfields.js), called over the service
// binding env.MAKERS (wrangler.toml), so their logic exists once.
//   POST /approved     An Intake automation calls it when a card reaches Complete. (1) freeze_baseline fills an empty
//                      Initial forecast (the estimated hours on the card and under it × Rate + Supplier cost) and an
//                      empty Original committed date (the Due date); (2) copy_step_fields writes the job's Agreement
//                      type, Job type, Rate, Account lead, Delivery lead and Creative lead, and Job due (its Due date),
//                      onto every step under it; (3) any open stage subtask (Confirm brief and scope, Verify delivery,
//                      Confirm and approve) is set to Complete. It never touches an assignee.
//   POST /step-fields  A Projects automation calls it when a card's Rework label is set. copy_step_fields finds the
//                      card's nearest job (a project, a retainer piece or a change card) and writes its Agreement type,
//                      Job type, Rate, Account lead, Delivery lead, Creative lead and Job due onto the card and every
//                      step under it; again 15 seconds later, for any step a template adds after the label, and then
//                      lift_rework_budget: for a Client rework, the nearest job's Budget goes up by the chain's
//                      estimated hours × Rate, once per chain, recorded in a comment on the rework card.
//   POST /intake       An Intake automation calls it when the Form creates a task. link_client matches the request's
//                      typed client name to one Client card, sets the Client relationship and, if Account lead is
//                      empty, sets Account lead and the assignee from the Client card. No match, or more than one:
//                      changes nothing, and the answer and the log say so.
// freeze_baseline and link_client change no field that already has a value, and on this path post no comment.
const API = 'https://api.clickup.com/api/v2';
const STAGES = new Set(['Confirm brief and scope', 'Verify delivery', 'Confirm and approve']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = { '/approved': approve, '/intake': linkClient, '/step-fields': stepFields }[url.pathname];
    if (request.method !== 'POST' || !route) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Webhook-Secret') !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    let body = {};
    try { body = await request.json(); } catch { /* an empty or non-JSON test call */ }
    const taskId = body?.payload?.id ?? body?.task_id ?? body?.id;
    if (!taskId) {
      console.log(JSON.stringify({ route: url.pathname, note: 'no task id in payload', keys: Object.keys(body || {}) }));
      return json({ ok: true, note: 'no task id in payload' });
    }
    try {
      const result = await route(String(taskId), env, ctx);
      console.log(JSON.stringify({ route: url.pathname, taskId, ...result }));
      return json({ ok: true, taskId, ...result });
    } catch (err) {
      // A ClickUp outage or rate limit, here or in makers-tools: answer 502 so the automation retries (it retries for
      // 1 h 15 min).
      console.log(JSON.stringify({ route: url.pathname, taskId, error: String(err) }));
      return json({ ok: false, taskId, error: String(err) }, 502);
    }
  },
};

// The makers-tools answer: ok with what changed (or why nothing did), or a failure that should be retried.
function answer(r) {
  if (!r.ok) throw new Error(r.error);
  return r.skipped ? { skipped: r.skipped } : { changed: r.changed, said: r.sentence };
}

export async function approve(taskId, env) {
  const baseline = answer(await env.MAKERS.freezeBaseline({ project: taskId }));
  const steps = answer(await env.MAKERS.copyStepFields({ job: taskId }));
  const got = await clickup(env, 'GET', `/task/${taskId}?include_subtasks=true`);
  if (got.status >= 400 && got.status < 500) return { baseline, steps, skipped: `task not readable (HTTP ${got.status})` };
  const closed = [];
  for (const sub of got.data.subtasks || []) {
    const name = (sub.name || '').trim();
    const done = sub.status?.type === 'closed' || (sub.status?.status || '').toLowerCase() === 'complete';
    if (STAGES.has(name) && !done) {
      await clickup(env, 'PUT', `/task/${sub.id}`, { status: 'complete' }, true);
      closed.push(name);
    }
  }
  return { baseline, steps, closed };
}

// The job's fields onto a card and what is under it: now, and once more after `later` ms, for a step a template adds
// after it sets the label (the second pass writes only what still differs, and its outcome goes to the log).
export async function stepFields(taskId, env, ctx, later = 15_000) {
  const now = answer(await env.MAKERS.copyStepFields({ task: taskId }));
  const again = (async () => {
    await new Promise((r) => setTimeout(r, later));
    const r = await env.MAKERS.copyStepFields({ task: taskId });
    // The Budget lift for a client rework: here, once the template has added the chain's steps and their hours.
    const lift = await env.MAKERS.liftReworkBudget({ task: taskId });
    const said = (x) => (x.ok ? (x.skipped ? { skipped: x.skipped } : { changed: x.changed, said: x.sentence }) : { error: x.error });
    console.log(JSON.stringify({ route: '/step-fields', taskId, second_pass: said(r), budget: said(lift) }));
    return { copy: r, lift };
  })();
  if (ctx?.waitUntil) ctx.waitUntil(again); else await again;
  return { steps: now };
}

export async function linkClient(taskId, env) {
  return answer(await env.MAKERS.linkClient({ request: taskId }));
}

async function clickup(env, method, path, data, mustSucceed = false) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await res.text();
  if (res.status >= 500 || res.status === 429 || (mustSucceed && !res.ok)) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

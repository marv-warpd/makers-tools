// Step fields. Every step carries its job's Agreement type, Job type, Rate, Account lead, Delivery lead and Creative
// lead, and "Job due", the job's Due date. Step views need the job's agreement, type, rate, leads and promise date,
// and Rate on the step makes step-level cost formulas possible.
// A job is a card carrying Request kind: a project, a retainer piece, or a change card. A step takes the fields of its
// nearest job, so a change card under a project keeps its own (its agreement can differ from the project's). Steps
// are every task under the job at any depth (stage and kick-off subtasks, rework cards and their steps included),
// down to, not into, a job nested under it.
// Called by the event service through the Writes entrypoint: at approval for the whole job (/approved), and for one
// card and what is under it when its Rework label is set (/step-fields, a Projects automation). Only values that
// differ are written; a field the job has no value for is left alone on its steps and named in the answer.
import { LISTS, UserError, clickup, clickupWrite, compact, makeTree, dayNumber, num, cardRef } from './data.js';

export const COPIED = ['Agreement type', 'Job type', 'Rate', 'Account lead', 'Delivery lead', 'Creative lead'];
export const JOB_DUE = 'Job due';

export const isJob = (t) => !!(t && t.f && t.f['Request kind']);

// The job a task belongs to: itself if it is a job, else its nearest ancestor that is one.
export function jobOf(tree, id) {
  let cur = tree.byId.get(String(id));
  for (let i = 0; cur && i < 12; i++) {
    if (isJob(cur)) return cur;
    cur = cur.parent ? tree.byId.get(cur.parent) : null;
  }
  return null;
}

// The steps of a job: every task under it at any depth, down to (not into) another job under it.
export function stepsOf(tree, job) {
  const out = [];
  const walk = (id) => {
    for (const k of tree.kids(id)) {
      if (isJob(k)) continue;
      out.push(k);
      walk(k.id);
    }
  };
  walk(job.id);
  return out;
}

// The tasks a copy covers: every step of the job, or, given a card under the job, that card and what is under it
// (down to, not into, a job nested inside).
export function targetsOf(tree, job, under = null) {
  if (!under || String(under) === String(job.id)) return stepsOf(tree, job);
  const card = tree.byId.get(String(under));
  return [card, ...stepsOf(tree, card)];
}

// The writes that bring a job's steps (or one card and what is under it) into line. fields: the List's field
// definitions ({ id, name, type, type_config }). Returns { steps, writes: [{ task, step, name, field, value,
// value_options? }], missing }.
export function stepFieldWrites(tree, job, fields, env, under = null) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const steps = targetsOf(tree, job, under);
  const writes = [];
  const missing = [];
  for (const name of [...COPIED, JOB_DUE]) {
    const def = byName.get(name);
    if (!def) { missing.push(`${name} (no such field on the List)`); continue; }
    const want = name === JOB_DUE ? job.due ?? null : job.f[name] ?? null;
    if (want === null || (Array.isArray(want) && !want.length)) { missing.push(name); continue; }
    for (const s of steps) {
      const w = writeFor(def, want, s.f[name] ?? null, env);
      if (w) writes.push({ task: s.id, step: s.name, name, field: def.id, ...w });
    }
  }
  return { steps: steps.length, writes, missing };
}

// One field's write, or null when the step already holds the job's value.
function writeFor(def, want, have, env) {
  if (def.type === 'drop_down') {
    if (have === want) return null;
    const option = (def.type_config?.options || []).find((o) => o.name === want);
    if (!option) throw new UserError(`${def.name} has no option named ${want}; nothing written`);
    return { value: option.id };
  }
  if (def.type === 'users') {
    const ids = (xs) => (xs || []).map((u) => String(u.id));
    const add = ids(want).filter((x) => !ids(have).includes(x));
    const rem = ids(have).filter((x) => !ids(want).includes(x));
    return add.length || rem.length ? { value: { add: add.map(Number), rem: rem.map(Number) } } : null;
  }
  if (def.type === 'date') {
    if (num(have) !== null && dayNumber(num(have), env) === dayNumber(Number(want), env)) return null;
    return { value: Number(want), value_options: { time: false } };
  }
  return num(have) === num(want) ? null : { value: num(want) }; // currency, number
}

// The job and every task under it, from direct reads of the cards. A direct read sees a card the moment it moves; the
// List's listing can lag a few seconds behind a move, so a card just moved at approval can be missing from it. Up
// from the card to its job, then down a level at a time; a job nested inside is not read into.
export async function jobTree(env, id, concurrency = 4) {
  const read = async (path) => {
    try { return await clickup(env, path); } catch (e) {
      if (/HTTP 4\d\d/.test(String(e.message))) throw new UserError(`No card with the id "${id}" can be read`);
      throw e;
    }
  };
  let job = await read(`/task/${encodeURIComponent(id)}`);
  for (let i = 0; i < 12 && !isJob(compact(job)) && job.parent; i++) job = await read(`/task/${job.parent}`);
  if (!isJob(compact(job))) throw new UserError(`${job.name} is not under a job (no card above it carries Request kind)`);
  const tasks = [job];
  let level = [job.id];
  while (level.length) {
    const next = [];
    const queue = [...level];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const t = await read(`/task/${queue.shift()}?include_subtasks=true`);
        for (const s of t.subtasks || []) {
          tasks.push(s);
          if (!isJob(compact(s))) next.push(s.id);
        }
      }
    }));
    level = next;
  }
  return { tree: makeTree(tasks.map(compact)), jobId: String(job.id) };
}

// Apply them: args.job (the approved card: every step under it) or args.task (one card, a rework card for instance:
// that card and what is under it, with its nearest job's fields).
export async function copyStepFields(args, env, { concurrency = 4 } = {}) {
  const id = cardRef(args.job ?? args.task);
  if (!id) throw new UserError('No card was named');
  const [{ tree, jobId }, fieldList] = await Promise.all([jobTree(env, id, concurrency), clickup(env, `/list/${LISTS.projects}/field`)]);
  const job = tree.byId.get(jobId);
  const plan = stepFieldWrites(tree, job, fieldList.fields || [], env, args.job ? null : id);
  const queue = [...plan.writes];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const w = queue.shift();
      await clickupWrite(env, 'POST', `/task/${w.task}/field/${w.field}`, { value: w.value, ...(w.value_options ? { value_options: w.value_options } : {}) });
    }
  }));
  const byField = {};
  for (const w of plan.writes) byField[w.name] = (byField[w.name] || 0) + 1;
  const touched = new Set(plan.writes.map((w) => w.task)).size;
  const summary = `${job.name}: ${plan.writes.length} field value${plan.writes.length === 1 ? '' : 's'} written on ${touched} of its ${plan.steps} steps` +
    `${plan.missing.length ? `; the job has no ${plan.missing.join(', ')}, so its steps keep theirs` : ''} (step fields).`;
  return { job: job.name, job_id: job.id, steps: plan.steps, steps_touched: touched, written: plan.writes.length, by_field: byField, missing: plan.missing,
    changed: Object.entries(byField).map(([k, n]) => `${k} on ${n} step${n === 1 ? '' : 's'}`), summary };
}

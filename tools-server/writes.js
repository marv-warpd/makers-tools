// The write tools: link_client, freeze_baseline, apply_fix, set_health, write_plan and write_rework_plan.
// link_client and freeze_baseline never change a value
// that is already set, so running twice changes nothing. link_client works on requests in the Intake List only; an
// agent's freeze_baseline writes only to cards whose name carries [Test]. When either changes something it says so in
// a comment on the card; a call that changes nothing posts nothing. The event service (event-service/worker.js) calls
// the same two functions through worker.js's Writes entrypoint, with no [Test] guard on the baseline and no comment,
// so the logic exists once; it also calls copy_step_fields (stepfields.js) and lift_rework_budget (below).
// apply_fix writes the fix stored under a Fix ref once the go-ahead is on the Delivery Planner's comment that
// carries it, and posts no comment. set_health, write_plan and write_rework_plan are further down.
// Each call is in the Worker log with what it changed.
import {
  LISTS, HOUR_MS, DAY_MS, UserError, clickup, clickupWrite, allTasks, makeTree, isTest, num, round1, money, dayText, dayNumber, cardRef, fmt, sum,
  teamMembers, today, isoDay, workingDaysBetween, addWorkingDays, isWorkingDay, AGENTS, forgetShared, allComments,
} from './data.js';
import { result, def, buildLive, changedTree, rewalk, planRequestCore, planReworkCore, healthReadings, testCard } from './tools.js';
import { copyStepFields, jobTree, stepsOf } from './stepfields.js';
import { FIX_DAYS, storedFix } from './fixes.js';

const WRITE_HINTS = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false };

export const WRITES = {
  link_client: {
    label: 'link client',
    basis: 'The client name on the request (its Client name field, or a "Client name:" line in its description) ' +
      'matched to one card in the Clients List: exact, then ignoring case, then one name containing the other; ' +
      'exactly one match. Account lead and the assignee come from the Client card, only where they are empty.',
    def: {
      ...def('link_client', 'Link client',
        'Links a new request in Intake to its Client card from the client name on it, and sets the account lead from that card when the request has none. Never changes a value that is already set.',
        { request: { type: 'string', description: 'The request card id.' } }, ['request']),
      annotations: { title: 'Link client', ...WRITE_HINTS },
    },
    run: linkClient,
  },
  freeze_baseline: {
    label: 'freeze baseline',
    basis: "Initial forecast takes the card's Forecast, worked out as the formula does: time estimate on the card " +
      'and everything under it × Rate + Supplier cost. Original committed date takes the Due date. Each only ' +
      'where it is empty.',
    def: {
      ...def('freeze_baseline', 'Freeze baseline',
        "Records a project's starting point: copies Forecast into Initial forecast and the Due date into Original committed date, only where they are empty.",
        { project: { type: 'string', description: 'The project card id.' } }, ['project']),
      annotations: { title: 'Freeze baseline', ...WRITE_HINTS },
    },
    run: freezeBaseline,
  },
  apply_fix: {
    label: 'apply fix',
    basis: 'The fix stored under its Fix ref when Forecast delivery or Test a fix proposed it (the card it is for and ' +
      "every step move: card, step, from start and due, to start and due), written exactly as stored and nothing else: " +
      "each step's start and due date. Only on an \"apply\" from the card's Delivery lead or a workspace owner replying to the " +
      "Delivery Planner's own comment on that card that carries the Fix ref, and only while every step still starts and " +
      'ends on the days its move is from; otherwise nothing is written.',
    def: {
      ...def('apply_fix', 'Apply fix',
        'Writes a fix the delivery lead approved, by its Fix ref: exactly the step moves Forecast delivery or Test a fix stored under that reference (each step\'s start and due date) and nothing else. It writes only when the card\'s Delivery lead or a workspace owner has replied exactly "apply" or "@Delivery Planner apply" to the Delivery Planner\'s own comment on that card that carries the Fix ref, and every step still starts and ends on the days its move is from; otherwise nothing is written and it says why. Returns what it wrote and the day each job\'s files then go out.',
        {
          fix_ref: { type: 'string', description: 'The Fix ref on the Delivery Planner\'s comment (eight letters and digits), as Forecast delivery or Test a fix gave it.' },
          project: { type: 'string', description: 'Optional: the card the fix was posted on, its id or name. If given, it must be the card the fix was proposed for.' },
          moves: {
            type: 'array', description: 'Optional, a cross-check: every step move as the comment lists it. If given, it must be exactly the moves stored under the Fix ref, or nothing is written.',
            items: {
              type: 'object',
              properties: {
                card: { type: 'string', description: "The step's card, id or name; the project when left out." },
                step: { type: 'string', description: "The step's name on that card." },
                from: { type: 'string', description: 'The day the step starts now, YYYY-MM-DD.' },
                to: { type: 'string', description: 'The day it moves to, YYYY-MM-DD.' },
                to_due: { type: 'string', description: 'Its new due date, YYYY-MM-DD; left out, it keeps its working days.' },
              },
              required: ['step', 'from', 'to'],
            },
          },
        }, ['fix_ref']),
      annotations: { title: 'Apply fix', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    run: applyFix,
  },
  set_health: {
    label: 'set health',
    basis: "Health as Forecast delivery reads it, read again for each card just before the write: a card whose reading " +
      'has changed since the Health check read it is not written. Health reason as the Health check words it, one line. ' +
      'Each card only where a value differs; nothing else on the card.',
    def: {
      ...def('set_health', 'Set health',
        "Writes Health and Health reason on job cards, as the Health check scored them from Forecast delivery. Before writing it reads each card again the same way; a card whose reading has changed since is not written, and it says so. Writes nothing else.",
        {
          cards: {
            type: 'array', minItems: 1, maxItems: 100, description: 'Each card to write, with the Health Forecast delivery gave it and the Health reason.',
            items: {
              type: 'object',
              properties: {
                card: { type: 'string', description: 'The job card: its id or name.' },
                health: { type: 'string', enum: ['On track', 'At risk', 'Off track'], description: 'Health by the checks, as Forecast delivery gave it.' },
                reason: { type: 'string', description: 'Health reason: one line, under 100 characters; "All checks clear" when On track.' },
              },
              required: ['card', 'health', 'reason'],
            },
          },
        }, ['cards']),
      annotations: { title: 'Set health', readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    run: setHealth,
  },
  write_plan: {
    label: 'write plan',
    basis: "Plan new work's plan for the request, calculated again just before the write with the same settings: written " +
      'only when it is the plan that was given (the same plan_key). Each step: start and due date as dates, the estimate ' +
      "where the plan's hours differ, the owner where the step has no person or Team; the card's Feasible date. A first " +
      'plan only: a card In progress, or a request with a Feasible date or a dated step, is refused.',
    def: {
      ...def('write_plan', 'Write plan',
        "Writes a new request's first plan exactly as Plan new work gave it: each step's start and due date, its estimate where the plan's differs, its owner where the step has none, and the Feasible date. Pass the plan_key Plan new work returned and the same settings; if the plan has changed since, nothing is written. Refuses a card In progress and a request that already has a plan.",
        {
          request: { type: 'string', description: 'The request, by its card id or name, as given to Plan new work.' },
          plan_key: { type: 'string', description: 'The plan_key Plan new work returned for this plan.' },
          keep_estimates: { type: 'boolean', description: 'As given to Plan new work.' },
          start_date: { type: 'string', description: 'As given to Plan new work, if it was (YYYY-MM-DD).' },
          cap_pct: { type: 'number', minimum: 10, maximum: 100, description: 'As given to Plan new work, if it was.' },
        }, ['request', 'plan_key']),
      annotations: { title: 'Write plan', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    run: writePlan,
  },
  write_rework_plan: {
    label: 'write rework plan',
    basis: "Plan rework's plan for the rework card, calculated again just before the write: written only when it is the " +
      "plan that was given (the same plan_key). The rework card's steps' start and due dates, as dates, and the rework " +
      "card assigned to the project's Delivery lead; the project's other steps are never written.",
    def: {
      ...def('write_rework_plan', 'Write rework plan',
        "Writes the dates on a rework card's steps exactly as Plan rework gave them, and assigns the rework card to the project's Delivery lead. Pass the plan_key Plan rework returned; if the plan has changed since, nothing is written. Never changes the project's other steps.",
        {
          rework: { type: 'string', description: 'The rework card, by its card id or name, as given to Plan rework.' },
          plan_key: { type: 'string', description: 'The plan_key Plan rework returned for this plan.' },
        }, ['rework', 'plan_key']),
      annotations: { title: 'Write rework plan', readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    run: writeReworkPlan,
  },
};

async function readCard(env, id, what, guard) {
  const typed = cardRef(id);
  if (!typed) throw new UserError(`No ${what} was named`);
  let task;
  try { task = await clickup(env, `/task/${encodeURIComponent(typed)}`); } catch (e) {
    if (/HTTP 4\d\d/.test(String(e.message))) throw new UserError(`No card with the id "${typed}" can be read`);
    throw e;
  }
  if (guard === 'test' && !isTest({ name: task.name || '' })) {
    throw new UserError(`${task.name} is not marked [Test]; this tool changes only cards marked [Test], so nothing was changed`);
  }
  if (guard === 'intake' && String(task.list?.id) !== LISTS.intake) {
    throw new UserError(`${task.name} is not a request in the Intake List; this tool links new requests only, so nothing was changed`);
  }
  const fields = Object.fromEntries((task.custom_fields || []).map((f) => [f.name, f]));
  return { task, fields };
}

const isEmpty = (f) => !f || f.value === undefined || f.value === null || f.value === '' || (Array.isArray(f.value) && f.value.length === 0);

async function comment(env, taskId, text, opts) {
  if (opts.comment === false) return;
  await clickupWrite(env, 'POST', `/task/${taskId}/comment`, { comment_text: text, notify_all: false });
}

// --- link client -------------------------------------------------------------------------------------------

// opts (the event service's calls, through worker.js Writes): comment: false posts no comment. An agent's call (MCP)
// takes the defaults.
export async function linkClient(args, env, opts = {}) {
  const tool = WRITES.link_client;
  const { task, fields } = await readCard(env, args.request, 'request', 'intake');
  const clientField = fields.Client;
  const nameField = fields['Client name'];
  if (!clientField || !nameField) throw new UserError(`${task.name} has no Client or Client name field, so it is not a request`);
  const done = (lines, data, sentence) => result(tool, env, { lines, data, cards: [task.id, ...(data.client_id ? [data.client_id] : [])], sentence });
  if (!isEmpty(clientField)) {
    const name = clientField.value[0]?.name ?? 'a Client card';
    return done([`${task.name}: Client is already ${name}.`], { request: task.id, changed: [] },
      `${task.name} is already linked to ${name}; nothing changed (${tool.label}).`);
  }
  let typed = String(nameField.value ?? '').trim();
  if (!typed) typed = ((task.description || '').match(/client name\s*[:\-]\s*([^\n]+)/i)?.[1] ?? '').trim();
  if (!typed) {
    return done([`${task.name}: no client name on the request.`], { request: task.id, changed: [] },
      `${task.name} has no client name to match, so nothing changed; the account lead sets Client by hand (${tool.label}).`);
  }
  const cards = (await allTasks(env, LISTS.clients, false)).filter((c) => !isTest(c));
  const norm = (s) => s.trim().toLowerCase();
  let match = cards.filter((c) => c.name.trim() === typed);
  if (match.length !== 1) match = cards.filter((c) => norm(c.name) === norm(typed));
  if (match.length !== 1) match = cards.filter((c) => norm(c.name).includes(norm(typed)) || norm(typed).includes(norm(c.name)));
  if (match.length !== 1) {
    return done([`${task.name}: "${typed}" matches ${match.length} Client cards${match.length ? ` (${match.slice(0, 5).map((c) => c.name).join(', ')})` : ''}.`],
      { request: task.id, typed, matches: match.length, changed: [] },
      `"${typed}" matches ${match.length === 0 ? 'no Client card' : `${match.length} Client cards`}, so nothing changed on ${task.name}; the account lead sets Client by hand (${tool.label}).`);
  }
  const client = match[0];
  const changed = [];
  await clickupWrite(env, 'POST', `/task/${task.id}/field/${clientField.id}`, { value: { add: [client.id] } });
  changed.push(`Client ${client.name}`);
  const clientCard = await clickup(env, `/task/${client.id}`);
  const owner = (clientCard.assignees || [])[0];
  const lead = fields['Account lead'];
  if (lead && isEmpty(lead) && owner) {
    await clickupWrite(env, 'POST', `/task/${task.id}/field/${lead.id}`, { value: { add: [owner.id] } });
    changed.push(`Account lead ${owner.username}`);
    if (!(task.assignees || []).length) {
      await clickupWrite(env, 'PUT', `/task/${task.id}`, { assignees: { add: [owner.id] } });
      changed.push(`assignee ${owner.username}`);
    }
  }
  const leadWords = changed.some((c) => c.startsWith('Account lead')) ? `, and set the account lead to ${owner.username} from the Client card` : '';
  await comment(env, task.id, `Makers tools linked this request to ${client.name} from the client name on it${leadWords}.`, opts);
  return done([`${task.name}: "${typed}" matched ${client.name}.`, `Changed: ${changed.join('; ')}.`],
    { request: task.id, typed, client: client.name, client_id: client.id, changed },
    `Linked ${task.name} to ${client.name}${leadWords} (${tool.label}).`);
}

// --- freeze baseline ---------------------------------------------------------------------------------------

// opts (the event service's call at approval): guard: null works on any card; an agent's call keeps the [Test]
// guard. comment: false posts no comment.
export async function freezeBaseline(args, env, opts = {}) {
  const tool = WRITES.freeze_baseline;
  const { task, fields } = await readCard(env, args.project, 'project', 'guard' in opts ? opts.guard : 'test');
  const initial = fields['Initial forecast'];
  const committed = fields['Original committed date'];
  if (!initial || !committed) throw new UserError(`${task.name} has no Initial forecast or Original committed date field, so it is not a project card`);
  const changed = [];
  const notes = [];
  let forecast = null;
  if (isEmpty(initial)) {
    const listId = task.list?.id;
    const tree = makeTree(await allTasks(env, listId === LISTS.intake ? LISTS.intake : LISTS.projects, true));
    const hours = (Number(task.time_estimate) || 0) / HOUR_MS + tree.descendants(String(task.id)).reduce((a, x) => a + (x.estimate || 0), 0);
    const rate = num(fields.Rate?.value);
    if (rate === null) {
      notes.push('Initial forecast left empty: the card has no Rate');
    } else {
      forecast = Math.round((hours * rate + (num(fields['Supplier cost']?.value) || 0)) * 100) / 100;
      await clickupWrite(env, 'POST', `/task/${task.id}/field/${initial.id}`, { value: forecast });
      changed.push(`Initial forecast ${money(forecast)} (${round1(hours)} h × ${money(rate)} + ${money(num(fields['Supplier cost']?.value) || 0)})`);
    }
  }
  if (isEmpty(committed)) {
    if (!task.due_date) {
      notes.push('Original committed date left empty: the card has no Due date');
    } else {
      await clickupWrite(env, 'POST', `/task/${task.id}/field/${committed.id}`, { value: Number(task.due_date), value_options: { time: false } });
      changed.push(`Original committed date ${dayText(dayNumber(Number(task.due_date), env))}`);
    }
  }
  if (!changed.length) {
    return result(tool, env, {
      lines: [`${task.name}: Initial forecast ${isEmpty(initial) ? 'empty' : money(num(initial.value))}; Original committed date ${isEmpty(committed) ? 'empty' : 'set'}.`, ...notes],
      data: { project: task.id, changed: [] }, cards: [task.id],
      sentence: `${task.name} already has its baseline${notes.length ? ` (${notes.join('; ')})` : ''}; nothing changed (${tool.label}).`,
    });
  }
  const words = changed.map((c) => c.replace(/ \(.*\)$/, '')).join(' and ');
  await comment(env, task.id, `Makers tools recorded this project's starting point: ${words}.`, opts);
  return result(tool, env, {
    lines: [`${task.name}: changed ${changed.join('; ')}.`, ...notes],
    data: { project: task.id, initial_forecast: forecast, changed }, cards: [task.id],
    sentence: `Recorded the starting point on ${task.name}: ${words}${notes.length ? `; ${notes.join('; ')}` : ''} (${tool.label}).`,
  });
}

// --- apply a fix on the go-ahead, by its Fix ref -----------------------------------------------------------

// Forecast delivery and Test a fix store each fix they propose under a Fix ref (fixes.js); the Delivery Planner's
// warning or Watch comment carries it on its own line ("Fix ref: 7f3a9c1d"). When the delivery lead or a workspace
// owner replies "apply" to that comment, the Planner calls this with the Fix ref. It writes exactly the stored moves,
// each step's start and due date, and nothing else: no other step, no card's Due date, no other field. It reads the
// steps by id, so a step with the same name on another card is never written. Every step must still start and end on
// the days its move is from; if any does not (the cards changed since the fix was proposed, or it was applied
// already), nothing is written. A step whose due date changes fires the Projects rule "Step due date changed: run the
// Health check".
const dayArg = (v, name) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''))) throw new UserError(`"${v}" is not a date for ${name}; use YYYY-MM-DD`);
  return Date.UTC(...String(v).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / DAY_MS;
};
// A date with no time, as the workspace stores one: 4 a.m. in its time zone.
function dateOnly(dn, env) {
  const noon = new Date(dn * DAY_MS + 12 * HOUR_MS);
  const hour = Number(noon.toLocaleString('en-GB', { timeZone: env.TIME_ZONE || 'UTC', hour: '2-digit', hour12: false }));
  return dn * DAY_MS + (4 - (hour - 12)) * HOUR_MS;
}
function cardOf(tree, typed) {
  const id = cardRef(typed);
  if (id && tree.byId.has(id) && !tree.byId.get(id).parent) return tree.byId.get(id);
  const units = tree.units.filter((u) => !u.closed);
  const exact = units.filter((u) => u.name.toLowerCase() === String(typed).trim().toLowerCase());
  if (exact.length === 1) return exact[0];
  const near = units.filter((u) => u.name.toLowerCase().includes(String(typed).trim().toLowerCase()));
  if (near.length === 1) return near[0];
  throw new UserError(`"${typed}" ${near.length ? 'matches more than one card' : 'is not a live card on the Projects List'}; nothing was written`);
}

// The go-ahead: a reply of "apply" from the card's Delivery lead or a workspace owner, on the
// Delivery Planner's own comment on the card the fix is for that carries its Fix ref. An "apply" on any other comment
// does not count. Every comment on the card is read, fresh from ClickUp, not the latest 25 and not the shared store.
// The reply's words, trimmed, are exactly "apply" or "@Delivery Planner apply", in any case; a reply
// that only contains the word ("do not apply") does not count. Read from the reply's parts in order: ClickUp's
// comment_text puts an @mention after the words.
export function saysApply(reply) {
  const parts = Array.isArray(reply?.comment) && reply.comment.length ? reply.comment : [{ text: reply?.comment_text || '' }];
  const words = parts.map((p) => (p.type === 'tag' ? `@${p.user?.username ?? String(p.text || '').replace(/^@/, '')}` : String(p.text ?? '')))
    .join('').replace(/\s+/g, ' ').trim().toLowerCase();
  return words === 'apply' || words === `@${AGENTS.planner.toLowerCase()} apply`;
}
const textOf = (c) => c.comment_text || (Array.isArray(c.comment) ? c.comment.map((p) => p.text ?? '').join('') : '');
async function goAheadOf(env, card, ref) {
  const leads = Array.isArray(card.f['Delivery lead']) ? card.f['Delivery lead'] : [];
  const owners = ((await clickup(env, '/team')).teams || []).flatMap((w) => w.members || [])
    .filter((m) => Number(m.user?.role) === 1).map((m) => m.user);
  const ids = new Set([...leads, ...owners].map((x) => String(x.id)));
  if (!ids.size) return { ok: false, why: `${card.name} has no Delivery lead and the workspace has no owner to give the go-ahead` };
  const carries = (c) => new RegExp(`fix ref\\W{0,3}${ref}\\b`, 'i').test(textOf(c));
  const mine = (await allComments(env, card.id)).filter((x) => x.user?.username === AGENTS.planner);
  const approved = async (c) => Number(c.reply_count) > 0 &&
    ((await clickup(env, `/comment/${c.id}/reply`)).comments || []).find((r) => ids.has(String(r.user?.id)) && saysApply(r));
  for (const c of mine.filter(carries)) {
    const yes = await approved(c);
    if (yes) return { ok: true, comment: String(c.id), reply: String(yes.id) };
  }
  const who = leads.length ? `${leads[0].name} or a workspace owner` : 'a workspace owner';
  if (!mine.some(carries)) return { ok: false, why: `the Delivery Planner has no comment on ${card.name} that carries Fix ref ${ref}` };
  for (const c of mine.filter((x) => !carries(x))) {
    if (await approved(c)) return { ok: false, why: `the "apply" from ${who} on ${card.name} is on a different comment, not on the Delivery Planner's comment that carries Fix ref ${ref}` };
  }
  return { ok: false, why: `there is no reply from ${who} that reads "apply" or "@${AGENTS.planner} apply" on the Delivery Planner's comment that carries Fix ref ${ref} on ${card.name}` };
}

// The moves given beside the Fix ref, read as before (each card and step by name), must be exactly the stored ones.
function crossCheck(moves, plan, tree, project, ref, env) {
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const differ = (why) => new UserError(`The moves given are not the fix stored under Fix ref ${ref}: ${why}; nothing was written`);
  if (moves.length !== plan.length) throw differ(`${moves.length} move${moves.length === 1 ? '' : 's'} given, ${plan.length} stored`);
  const seen = new Set();
  for (const m of moves) {
    const unit = m.card ? cardOf(tree, m.card) : project;
    const named = tree.descendants(unit.id).filter((s) => !s.closed && s.name.toLowerCase() === String(m.step || '').trim().toLowerCase());
    if (named.length !== 1) throw differ(`${unit.name} has ${named.length ? 'more than one' : 'no'} open step named "${m.step}"`);
    const p = plan.find((x) => x.step.id === named[0].id);
    if (!p || seen.has(p.step.id)) throw differ(`${unit.name}'s ${named[0].name} is not one of its moves`);
    seen.add(p.step.id);
    const from = dayArg(m.from, 'from');
    const to = dayArg(m.to, 'to');
    const s0 = dn(named[0].start);
    const d0 = dn(named[0].due);
    const due = m.to_due ? dayArg(m.to_due, 'to_due') : addWorkingDays(to, Math.max(1, s0 !== null && d0 !== null ? workingDaysBetween(s0, d0) : 1) - 1);
    if (from !== p.from || to !== p.to || due !== p.due) {
      throw differ(`${unit.name}'s ${p.step.name} is stored from ${dayText(p.from)} to ${dayText(p.to)}, ending ${dayText(p.due)}`);
    }
  }
}

export async function applyFix(args, env) {
  const tool = WRITES.apply_fix;
  const typed = String(args.fix_ref ?? '').trim();
  if (!typed) {
    throw new UserError('No Fix ref was given: Apply fix writes only a fix Forecast delivery or Test a fix proposed, by the Fix ref on the Delivery Planner\'s comment; nothing was written');
  }
  const ref = typed.replace(/^fix ref\W*/i, '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(ref)) throw new UserError(`"${typed}" is not a Fix ref (eight letters and digits, as Forecast delivery or Test a fix gave it); nothing was written`);
  const fix = await storedFix(env, ref);
  if (!fix) {
    throw new UserError(`No fix is stored under Fix ref ${ref}: it was never proposed, or it was proposed more than ${FIX_DAYS} days ago; run the Health check again for a fresh fix. Nothing was written`);
  }
  forgetShared(); // the cards as they are now, not a shared read from before
  const [projects, intake, members] = await Promise.all([allTasks(env, LISTS.projects, true), allTasks(env, LISTS.intake, true),
    teamMembers(env).catch(() => new Map())]);
  const tree = makeTree(projects);
  // A live card by the id the fix stored; a [Test] card counts too, as the tools that proposed the fix read one named
  // exactly.
  const live = (id) => tree.units.find((u) => u.id === String(id) && !u.closed) || testCard(tree, String(id));
  const project = live(fix.project_id);
  if (!project) throw new UserError(`${fix.project}, the card Fix ref ${ref} was proposed for, is no longer a live card on the Projects List; nothing was written`);
  if (args.project && cardRef(args.project) !== project.id && String(args.project).trim().toLowerCase() !== project.name.toLowerCase()) {
    throw new UserError(`Fix ref ${ref} was proposed for ${project.name}, not for "${args.project}"; nothing was written`);
  }
  const t0 = today(env);
  const dn = (ms) => (ms ? dayNumber(ms, env) : null);
  const day = (v) => (v === null ? null : dayArg(v, 'the stored fix'));
  const changed = (what) => new UserError(`${what}: the cards have changed since the fix was proposed, so nothing was written`);
  const plan = fix.moves.map((m) => {
    const unit = live(m.card_id);
    const step = tree.byId.get(String(m.step_id));
    if (!unit || !step || step.closed || !tree.descendants(unit.id).some((s) => s.id === step.id)) throw changed(`${m.card}'s ${m.step} is no longer an open step on that card`);
    const [from, fromDue, to, due] = [day(m.from), day(m.from_due), day(m.to), day(m.to_due)];
    const s0 = dn(step.start);
    const d0 = dn(step.due);
    if (s0 !== from) throw changed(`${unit.name}'s ${step.name} starts ${s0 === null ? 'with no date' : dayText(s0)}, not ${from === null ? 'with no date' : dayText(from)}`);
    if (d0 !== fromDue) throw changed(`${unit.name}'s ${step.name} ends ${d0 === null ? 'with no date' : dayText(d0)}, not ${fromDue === null ? 'with no date' : dayText(fromDue)}`);
    if (to < t0) throw new UserError(`${unit.name}'s ${step.name} cannot move to ${dayText(to)}, a day already past; run the Health check again for a fresh fix. Nothing was written`);
    return { unit, step, from, fromDue: d0, to, due };
  });
  if (Array.isArray(args.moves) && args.moves.length) crossCheck(args.moves, plan, tree, project, ref, env);
  // Only on the go-ahead given on the Planner's comment that carries this Fix ref, on the card itself.
  const go = await goAheadOf(env, project, ref);
  if (!go.ok) throw new UserError(`${go.why}, so nothing was written`);
  for (const m of plan) {
    await clickupWrite(env, 'PUT', `/task/${m.step.id}`, { start_date: dateOnly(m.to, env), due_date: dateOnly(m.due, env), start_date_time: false, due_date_time: false });
  }
  // The day each job touched, and the project, then sends: the forecast on the cards as the writes leave them.
  const after = buildLive(env, changedTree(tree, plan.map((m) => ({ unit: m.unit, step: m.step, owner: null, start: m.to, due: m.due })), env),
    makeTree(intake), members);
  const jobs = [...new Map([project, ...plan.map((m) => m.unit)].map((u) => [u.id, u])).values()];
  const sends = jobs.map((u) => {
    const w = rewalk(after, after.tree.byId.get(u.id), env, {});
    return { card: u.name, id: u.id, send: w.send === null ? null : isoDay(w.send), due_date: w.promise === null ? null : isoDay(w.promise),
      working_days_send_past_due_date: w.send_past_due };
  });
  const span = (a, b) => (a === b ? dayText(a) : `${dayText(a)} to ${dayText(b)}`);
  const written = plan.map((m) => ({ card: m.unit.name, step: m.step.name, from: isoDay(m.from), from_due: m.fromDue === null ? null : isoDay(m.fromDue), to: isoDay(m.to), to_due: isoDay(m.due) }));
  const mine = sends.find((s) => s.id === project.id);
  const sendWords = (s) => (s.send === null ? `${s.card} has no send` : `${s.card} sends ${dayText(dayArg(s.send, 'send'))}` +
    (s.working_days_send_past_due_date === null ? '' : s.working_days_send_past_due_date > 0 ? `, after its Due date of ${dayText(dayArg(s.due_date, 'due'))}`
      : `, by its Due date of ${dayText(dayArg(s.due_date, 'due'))}`));
  // Then the card's Health check, written through Set health. The server posts no comment: the Planner posts the
  // confirmation from this result. The moves stand if the Health write fails; the result says so.
  const after_ = await checkHealth(env, project);
  return result(tool, env, {
    lines: [`Written, Fix ref ${ref}, ${plan.length} step move${plan.length === 1 ? '' : 's'}:`,
      ...plan.map((m) => `- ${m.unit.name}'s ${m.step.name}: ${span(m.from, m.fromDue ?? m.from)} to ${span(m.to, m.due)}`),
      'Then, on the cards as they now stand:', ...sends.map((s) => `- ${sendWords(s)}`),
      after_.health ? `Health on ${project.name}: ${after_.health.health}, "${after_.health.reason}".` : `Health was not written: ${after_.health_error}.`,
      'The confirmation to post on the card, as it stands:', ...confirmationLines(plan, mine, sendWords)],
    data: { project: project.name, id: project.id, fix_ref: ref, written, sends, go_ahead: { comment: go.comment, reply: go.reply },
      health: after_.health, confirmation_lines: confirmationLines(plan, mine, sendWords),
      changed: [...written.map((w) => `${w.card}'s ${w.step}: ${w.from} to ${w.to}`),
        ...(after_.health ? [`${project.name}: Health ${after_.health.health}, "${after_.health.reason}"`] : [])] },
    cards: [...new Set([project.id, ...plan.map((m) => m.step.id)])],
    sentence: `Applied the fix on ${project.name}: ${plan.length} step move${plan.length === 1 ? '' : 's'} written; ${sendWords(mine)}; ` +
      `${after_.health ? `Health ${after_.health.health}` : 'Health not written'}. Post the confirmation on the card: ${confirmationLines(plan, mine, sendWords).join(' ')} (${tool.label}).`,
  });
}

function confirmationLines(plan, mine, sendWords) {
  return ['The fix is applied.',
    ...plan.map((m) => `${m.unit.name}'s ${m.step.name} moves from ${dayText(m.from)} to ${dayText(m.to)}${m.due !== m.to ? `, ending ${dayText(m.due)}` : ''}.`),
    `${sendWords(mine)}.`];
}

async function checkHealth(env, project) {
  const out = {};
  try {
    forgetShared();
    const [reading] = await healthReadings(env, [project.name]);
    const reason = String(reading.reason || 'All checks clear').replace(/\s+/g, ' ').trim().slice(0, 100);
    await setHealth({ cards: [{ card: project.name, health: reading.health, reason }] }, env);
    out.health = { health: reading.health, reason };
  } catch (e) { out.health_error = String(e.message || e).slice(0, 160); }
  return out;
}

// --- the Delivery Planner's writes ------------------------------------------------------------------------
// Health, the first plan and the rework plan are written through these three tools, in apply_fix's pattern. Each calculates again what a read tool just gave, writes only when it is
// the same, writes exactly that and nothing else, and says what it wrote (the Worker log keeps `changed`).
const HEALTHS = ['On track', 'At risk', 'Off track'];
const optionOf = (field, name) => (field?.type_config?.options || []).find((o) => o.name === name) || null;
const optionName = (field) => {
  const v = field?.value;
  if (v === null || v === undefined || v === '') return null;
  const o = (field.type_config?.options || []).find((x) => x.id === v || x.orderindex === Number(v) || String(x.orderindex) === String(v));
  return o ? o.name : null;
};
const fieldNamed = (task, name) => (task.custom_fields || []).find((f) => f.name === name) || null;

async function setHealth(args, env) {
  const tool = WRITES.set_health;
  const asked = Array.isArray(args.cards) ? args.cards : [];
  if (!asked.length) throw new UserError('No cards were given; nothing was written');
  for (const c of asked) {
    if (!HEALTHS.includes(c.health)) throw new UserError(`"${c.health}" is not a Health; use On track, At risk or Off track; nothing was written`);
    const reason = String(c.reason ?? '').trim();
    if (!reason || reason.length > 100 || /\n/.test(reason)) throw new UserError(`The Health reason for ${c.card} must be one line of 1 to 100 characters; nothing was written`);
  }
  forgetShared(); // read the cards as they are now, not a shared read from before
  const readings = await healthReadings(env, asked.map((c) => c.card));
  const written = [];
  const kept = [];
  const refused = [];
  for (const [i, c] of asked.entries()) {
    const now = readings[i];
    if (now.health !== c.health) {
      refused.push({ card: now.card, id: now.id, asked: c.health, reads: now.health });
      continue;
    }
    const task = await clickup(env, `/task/${now.id}`);
    const hf = fieldNamed(task, 'Health');
    const rf = fieldNamed(task, 'Health reason');
    if (!hf || !rf || !optionOf(hf, c.health)) throw new UserError(`${now.card} has no Health or Health reason field to write; nothing more was written`);
    const reason = String(c.reason).trim();
    const was = { health: optionName(hf), reason: rf.value ?? null };
    if (was.health === c.health && was.reason === reason) { kept.push({ card: now.card, id: now.id, health: c.health }); continue; }
    if (was.health !== c.health) await clickupWrite(env, 'POST', `/task/${now.id}/field/${hf.id}`, { value: optionOf(hf, c.health).id });
    if (was.reason !== reason) await clickupWrite(env, 'POST', `/task/${now.id}/field/${rf.id}`, { value: reason });
    written.push({ card: now.card, id: now.id, health: c.health, reason, was });
  }
  if (!written.length && !kept.length) {
    throw new UserError(`The reading has changed since: ${refused.map((x) => `${x.card} now reads ${x.reads}, not ${x.asked}`).join('; ')}. Nothing was written; call Forecast delivery again`);
  }
  const changed = written.map((w) => `${w.card}: Health ${w.was.health ?? 'blank'} to ${w.health}; Health reason "${w.reason}"`);
  return result(tool, env, {
    lines: [`Written on ${written.length} card${written.length === 1 ? '' : 's'}${kept.length ? `, ${kept.length} already as asked` : ''}${refused.length ? `, ${refused.length} not written` : ''}:`,
      ...written.map((w) => `- ${w.card}: ${w.health}, "${w.reason}"${w.was.health !== w.health ? ` (was ${w.was.health ?? 'blank'})` : ''}`),
      ...refused.map((x) => `- ${x.card}: not written; it now reads ${x.reads}, not ${x.asked}; call Forecast delivery again for it`)],
    data: { written, kept, not_written: refused, changed },
    cards: [...written, ...kept, ...refused].map((x) => x.id),
    sentence: `Health written on ${written.length} card${written.length === 1 ? '' : 's'}${refused.length ? `; ${refused.length} not written because the reading changed` : ''} (${tool.label}).`,
  });
}

async function writePlan(args, env) {
  const tool = WRITES.write_plan;
  if (!args.plan_key) throw new UserError('No plan_key was given: call Plan new work first and pass the plan_key it returns; nothing was written');
  forgetShared();
  const { card, tree, r, key } = await planRequestCore({ request: args.request, keep_estimates: args.keep_estimates, start_date: args.start_date, cap_pct: args.cap_pct }, env);
  if (String(card.status || '').toLowerCase() === 'in progress') {
    throw new UserError(`${card.name} is In progress; Write plan writes a new request's first plan only, so nothing was written`);
  }
  if (key !== String(args.plan_key)) {
    throw new UserError(`The plan for ${card.name} has changed since Plan new work gave it (the cards or the team's time moved); call Plan new work again. Nothing was written`);
  }
  if (num(card.f['Feasible date']) !== null) {
    throw new UserError(`${card.name} already has a Feasible date, so a plan was written before; give new figures as suggestions in your comment. Nothing was written`);
  }
  const dated = r.plan.map((p) => tree.byId.get(p.id)).filter((s) => s && (s.start || s.due));
  if (dated.length) {
    throw new UserError(`${card.name}'s ${dated.map((s) => s.name).join(', ')} already ${dated.length === 1 ? 'has' : 'have'} dates, so this is not a first plan; give new figures as suggestions. Nothing was written`);
  }
  if (r.feasible === null || r.feasible === undefined) throw new UserError(`The plan for ${card.name} has no Feasible date (no Deliver step); nothing was written`);
  const team = ((await clickup(env, '/team')).teams || []).flatMap((w) => w.members || []).map((m) => m.user);
  const userNamed = (name) => team.find((u) => (u.username || '').toLowerCase() === String(name).toLowerCase()) || null;
  const written = [];
  for (const p of r.plan) {
    const s = tree.byId.get(p.id);
    const body = { start_date: dateOnly(p.start, env), due_date: dateOnly(p.due, env), start_date_time: false, due_date_time: false };
    const hours = Math.round(p.hours * 4) / 4;
    const estimateChanged = Math.round((s.estimate || 0) * 4) / 4 !== hours;
    if (estimateChanged) body.time_estimate = Math.round(hours * HOUR_MS);
    const owner = !s.people.length && !s.teams.length ? userNamed(p.owner) : null;
    if (owner) body.assignees = { add: [owner.id] };
    await clickupWrite(env, 'PUT', `/task/${s.id}`, body);
    written.push({ step: s.name, id: s.id, start: isoDay(p.start), due: isoDay(p.due), ...(estimateChanged ? { hours, was_hours: s.estimate || 0 } : {}), ...(owner ? { owner: owner.username } : {}) });
  }
  const fresh = await clickup(env, `/task/${card.id}`);
  const ff = fieldNamed(fresh, 'Feasible date');
  if (!ff) throw new UserError(`${card.name} has no Feasible date field; the steps were written, the Feasible date was not`);
  await clickupWrite(env, 'POST', `/task/${card.id}/field/${ff.id}`, { value: dateOnly(r.feasible, env), value_options: { time: false } });
  const changed = [...written.map((w) => `${card.name}'s ${w.step}: ${w.start} to ${w.due}${w.hours !== undefined ? `, ${w.hours} h` : ''}${w.owner ? `, ${w.owner}` : ''}`),
    `${card.name}: Feasible date ${isoDay(r.feasible)}`];
  return result(tool, env, {
    lines: [`Written on ${card.name}, the plan as Plan new work gave it:`,
      ...written.map((w) => `- ${w.step}: ${dayText(dayArg(w.start, 'start'))}${w.due !== w.start ? ` to ${dayText(dayArg(w.due, 'due'))}` : ''}${w.hours !== undefined ? `; estimate ${fmt(w.hours)} h (was ${fmt(w.was_hours)} h)` : ''}${w.owner ? `; owner ${w.owner}` : ''}`),
      `- Feasible date: ${dayText(r.feasible)}`],
    data: { request: card.name, id: card.id, written, feasible_date: isoDay(r.feasible), send: r.send === null ? null : isoDay(r.send), changed },
    cards: [card.id, ...written.map((w) => w.id)],
    sentence: `Wrote the first plan on ${card.name}: ${written.length} step${written.length === 1 ? '' : 's'} dated, the files go out ${dayText(r.send)} and the Feasible date is ${dayText(r.feasible)} (${tool.label}).`,
  });
}

async function writeReworkPlan(args, env) {
  const tool = WRITES.write_rework_plan;
  if (!args.plan_key) throw new UserError('No plan_key was given: call Plan rework first and pass the plan_key it returns; nothing was written');
  forgetShared();
  const { rework, unit, mine, key } = await planReworkCore({ rework: args.rework }, env);
  if (key !== String(args.plan_key)) {
    throw new UserError(`The plan for ${rework.name} has changed since Plan rework gave it; call Plan rework again. Nothing was written`);
  }
  if (!mine.length) throw new UserError(`${rework.name} has no open steps to date; nothing was written`);
  const written = [];
  for (const p of mine) {
    await clickupWrite(env, 'PUT', `/task/${p.id}`, { start_date: dateOnly(p.start, env), due_date: dateOnly(p.due, env), start_date_time: false, due_date_time: false });
    written.push({ step: p.step, id: p.id, start: isoDay(p.start), due: isoDay(p.due) });
  }
  const leads = (Array.isArray(unit.f['Delivery lead']) ? unit.f['Delivery lead'] : []).filter((x) => !(rework.people || []).includes(x.name));
  if (leads.length) await clickupWrite(env, 'PUT', `/task/${rework.id}`, { assignees: { add: leads.map((x) => Number(x.id)) } });
  const doneBy = Math.max(...mine.map((p) => p.due));
  const changed = [...written.map((w) => `${rework.name}'s ${w.step}: ${w.start} to ${w.due}`), ...leads.map((x) => `${rework.name}: assigned to ${x.name}`)];
  return result(tool, env, {
    lines: [`Written on ${rework.name} (${unit.name}), the rework plan as Plan rework gave it:`,
      ...written.map((w) => `- ${w.step}: ${dayText(dayArg(w.start, 'start'))}${w.due !== w.start ? ` to ${dayText(dayArg(w.due, 'due'))}` : ''}`),
      ...(leads.length ? [`- the rework card assigned to ${leads.map((x) => x.name).join(', ')}`] : [])],
    data: { rework: rework.name, id: rework.id, project: unit.name, project_id: unit.id, written, assigned: leads.map((x) => x.name), rework_done_by: isoDay(doneBy), changed },
    cards: [rework.id, ...written.map((w) => w.id)],
    sentence: `Wrote the rework plan on ${rework.name}: ${written.length} step${written.length === 1 ? '' : 's'} dated, done by ${dayText(doneBy)} (${tool.label}).`,
  });
}

// --- the Budget lift for a client rework ------------------------------------------------------------------

// A client rework card (Rework label Client) is the client's included round: its nearest job's Budget goes up by the
// chain's estimated hours (the card and every step under it) × the job's Rate, so the Cost check reads Headroom as it
// stands (tools.js, costCheck). An internal rework changes no money. Once per chain: the lift is recorded in one
// comment on the rework card, "Budget +$X for the included round: N h at $Rate", and a card carrying it is never
// lifted again. On a retainer the job is the piece, never the month card. A chain with no estimated hours yet is not
// lifted, and says so. The event service's /step-fields route calls it on its second pass, 15 seconds after the
// first, once the template has added the chain's steps. Only the rework card itself lifts: the labelled task whose
// parent is its job (a project, a change card or a retainer piece). The template labels the chain's steps too, and
// the label rule calls /step-fields for each of them; a step under the rework card is never a chain of its own, so a
// chain lifts once.
export async function liftReworkBudget(args, env) {
  const id = cardRef(args.task);
  if (!id) throw new UserError('No card was named');
  const { tree, jobId } = await jobTree(env, id);
  const card = tree.byId.get(id);
  const job = tree.byId.get(jobId);
  const none = (why) => ({ summary: `${card.name}: ${why}; no Budget changed (rework budget).`, changed: [], lifted: 0 });
  if (card.id === job.id) return none('it is the job itself, not a rework card');
  if (String(card.parent) !== String(job.id)) return none('it is a step under the rework card; only the rework card lifts its chain');
  const labels = card.f.Rework || [];
  if (!labels.includes('Client')) return none(labels.includes('Internal') ? 'an internal rework changes no money' : 'it carries no Client rework label');
  const comments = (await clickup(env, `/task/${id}/comment`)).comments || [];
  if (comments.some((c) => /^\s*Budget \+\$/.test(c.comment_text || ''))) return none('the lift for this chain is already recorded on it');
  const hours = Math.round(sum([card, ...stepsOf(tree, card)].map((t) => t.estimate || 0)) * 100) / 100;
  if (!hours) return none('the chain has no estimated hours yet');
  const rate = num(job.f.Rate);
  if (rate === null) return none(`${job.name} has no Rate`);
  const budgetField = ((await clickup(env, `/list/${LISTS.projects}/field`)).fields || []).find((f) => f.name === 'Budget');
  if (!budgetField) throw new UserError('No Budget field on the Projects List');
  const lift = Math.round(hours * rate * 100) / 100;
  // Cents when the lift has them (a half hour at $65 is $32.50), so the record says what the Budget gained.
  const cash = (x) => (Number.isInteger(x) ? money(x) : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const before = num(job.f.Budget) ?? 0;
  const after = Math.round((before + lift) * 100) / 100;
  await clickupWrite(env, 'POST', `/task/${job.id}/field/${budgetField.id}`, { value: after });
  await clickupWrite(env, 'POST', `/task/${card.id}/comment`, { comment_text: `Budget +${cash(lift)} for the included round: ${fmt(hours)} h at ${money(rate)}`, notify_all: false });
  return { summary: `${job.name}: Budget ${cash(before)} to ${cash(after)} for ${card.name}'s included round, ${fmt(hours)} h at ${money(rate)} (rework budget).`,
    changed: [`Budget +${cash(lift)} on ${job.name}`], lifted: lift };
}

// The event service's calls (worker.js, the Writes entrypoint, over a service binding: not reachable from the
// internet). A UserError is an answer, not a failure (the card is not a request, the client is ambiguous); anything
// else is a failure the event service answers 502, so ClickUp's automation retries.
const INTERNAL = {
  link_client: (args, env) => linkClient(args, env, { comment: false }),
  freeze_baseline: (args, env) => freezeBaseline(args, env, { guard: null, comment: false }),
  copy_step_fields: (args, env) => copyStepFields(args, env), // the job's six fields and Job due onto its steps (stepfields.js)
  lift_rework_budget: (args, env) => liftReworkBudget(args, env), // a client rework's included round onto its job's Budget
};
export async function internalWrite(name, args, env) {
  try {
    const r = await INTERNAL[name](args, env);
    const a = r.structuredContent ?? r;
    return { ok: true, sentence: a.summary ?? null, changed: a.changed ?? [] };
  } catch (e) {
    return e instanceof UserError ? { ok: true, skipped: e.message, changed: [] } : { ok: false, error: String(e.message || e) };
  }
}

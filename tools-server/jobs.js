// The weekly client figures on the Client cards. Every Monday at 07:30 London the worker calls the same tool
// functions the agents call (margin_by_client, on_time_rate, rework_by_cause, retainer_usage) and writes the Client
// card fields that differ, with Account health and Why from them; "Figures as of" says when. A client with no finished
// work yet is skipped; nothing is written when a client with finished work has no Client card.
import { TOOLS } from './tools.js';
import { LISTS, UserError, clickup, clickupWrite, allTasks, makeTree, num, today, dayNumber } from './data.js';

// Cloudflare's cron runs on UTC; London is UTC in winter and UTC+1 in summer, so both crons are set and the job runs
// on the one that is 07:30 in London (wrangler.toml).
export const CRONS = ['30 6 * * MON', '30 7 * * MON'];
export function isRefreshTime(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return parts.weekday === 'Mon' && parts.hour === '07' && parts.minute === '30';
}

// The margin call: every finished job and finished retainer month, no date window.
export const MARGIN_ARGS = { state: 'finished' };

// Average rounds: the mean of Rounds used across each client's finished and live fixed-fee jobs (the project
// cards at the top of Projects, [Test] cards left out), to one decimal, a half rounded up (15 rounds on 12 jobs: 1.3).
export function roundsAverage(tree) {
  const per = new Map();
  for (const u of tree.units) {
    if (u.parent || u.f['Agreement type'] !== 'Fixed fee') continue;
    const used = num(u.f['Rounds used']);
    if (used === null) continue;
    const name = (u.f.Client || [])[0]?.name ?? '(none)';
    per.set(name, [...(per.get(name) || []), used]);
  }
  return new Map([...per].map(([name, xs]) => [name, Math.round((xs.reduce((a, b) => a + b, 0) * 10) / xs.length) / 10]));
}

// ===== Account health settings =====================================================================================
// These are starting values. Check them against your own past figures and change them here.
// Each figure is read from the Client card: Margin % in percent, Late days in working days, Client revision hrs in
// hours, Retainer usage % in percent of the monthly allowance.
// At risk when any At risk condition holds. Otherwise Watch when any Watch condition holds. Otherwise Healthy.
// A blank figure meets no condition. Only the conditions below count: On time %, Internal rework hrs, Average rounds
// and Retainer trend % meet none.
export const ACCOUNT_HEALTH = {
  atRisk: {
    // Margin % under marginBelow, with Late days at or above lateDaysFrom.
    marginLate: { marginBelow: 48, lateDaysFrom: 10 },
    // Retainer usage % above this.
    usageAbove: 110,
  },
  watch: {
    // Margin % under this.
    marginBelow: 48,
    // Late days at or above this.
    lateDaysFrom: 20,
    // Client revision hrs above this.
    revisionHoursAbove: 25,
    // Retainer usage % above this.
    usageAbove: 100,
  },
  // The Why names at most this many of the conditions met: At risk's first, then Watch's, in the order above.
  whyNamesAtMost: 2,
};
// ====================================================================================================================

// Account health from the card's figures, by the settings above.
const HEALTH_FIGURES = ['Margin %', 'On time %', 'Late days', 'Client revision hrs', 'Internal rework hrs', 'Average rounds',
  'Retainer trend %', 'Retainer usage %'];
export function healthConditions(values) {
  const [margin, onTime, late, revisions, redo, rounds, trend, usage] = HEALTH_FIGURES.map((k) => num(values[k]));
  const set = (...xs) => xs.every((x) => x !== null);
  const { atRisk: r, watch: w } = ACCOUNT_HEALTH;
  // in the order the Why sentence names them: At risk's, then Watch's
  const atRisk = [
    ['marginLate', set(margin, late) && margin < r.marginLate.marginBelow && late >= r.marginLate.lateDaysFrom],
    ['usage', set(usage) && usage > r.usageAbove],
  ];
  const watch = [
    ['margin', set(margin) && margin < w.marginBelow],
    ['late', set(late) && late >= w.lateDaysFrom],
    ['revisions', set(revisions) && revisions > w.revisionHoursAbove],
    ['usage', set(usage) && usage > w.usageAbove],
  ];
  const met = (list) => list.filter(([, ok]) => ok).map(([k]) => k);
  return { atRisk: met(atRisk), watch: met(watch), figures: { margin, onTime, late, revisions, redo, rounds, trend, usage } };
}
export function accountHealth(values) {
  const c = healthConditions(values);
  return c.atRisk.length ? 'At risk' : c.watch.length ? 'Watch' : 'Healthy';
}

// The Why on the Client card: written by this job, one plain sentence naming only the conditions met, in the
// settings' order, at most whyNamesAtMost of them, and never the same figure twice, for example "At risk: 44% margin
// with 12 late days; 50.8 client revision hours." Healthy names the margin and the on-time rate.
const shown = (x) => String(Math.round(x * 10) / 10);
const days = (n) => `${shown(n)} late day${n === 1 ? '' : 's'}`;
export function healthWhy(values) {
  const health = accountHealth(values);
  const { atRisk, watch, figures: f } = healthConditions(values);
  if (health === 'Healthy') {
    const parts = [f.margin !== null && `${shown(f.margin)}% margin`, f.onTime !== null && `${shown(f.onTime)}% on time`].filter(Boolean);
    return `Healthy: ${parts.length ? parts.join(', ') : 'no figure meets a Watch or At risk condition'}.`;
  }
  // each condition's words, and the figures they name
  const said = {
    marginLate: [`${shown(f.margin)}% margin with ${days(f.late)}`, ['margin', 'late']],
    margin: [`${shown(f.margin)}% margin`, ['margin']],
    late: [days(f.late), ['late']],
    revisions: [`${shown(f.revisions)} client revision hours`, ['revisions']],
    usage: [`retainer use at ${shown(f.usage)}% of the allowance`, ['usage']],
  };
  const parts = [];
  const named = new Set();
  for (const k of [...atRisk, ...watch]) {
    const [words, figs] = said[k];
    if (figs.some((x) => named.has(x))) continue;
    parts.push(words);
    figs.forEach((x) => named.add(x));
    if (parts.length === ACCOUNT_HEALTH.whyNamesAtMost) break;
  }
  return `${health}: ${parts.join('; ')}.`;
}

// A stored value differs from the new one: blank, or another number, or (a dropdown) another option name.
const differs = (stored, v) => stored === null || stored === undefined || (typeof v === 'string' ? String(stored) !== v : Number(stored) !== Number(v));

// Each Client card's figures from the tools' answers, and the fields that differ from what the card holds.
// cards: [{ id, name, values: { field name: stored value or null } }]; fields the card does not carry are left out.
// usage: Map(client -> { used_pct, trend }) for the retainer clients; trend null with fewer than six finished months.
export function clientFigures({ margins, onTime, rework, rounds, usage, cards }) {
  const late = new Map();
  for (const j of onTime.late) late.set(j.client, (late.get(j.client) || 0) + j.late_by);
  const timeliness = new Map(onTime.rows.map((r) => [r.group, r]));
  const redo = new Map(rework.rows.map((r) => [r.group, r]));
  const byName = new Map(cards.map((c) => [c.name, c]));
  // A client with no finished work yet is skipped and its card left as it is. A client with finished work but no
  // Client card stops the run: its figures would have nowhere to go.
  const noCard = [...new Set(margins.map((m) => m.client))].filter((n) => !byName.has(n));
  if (noCard.length) {
    throw new UserError(`Client coverage differs: ${noCard.join(', ')} ${noCard.length === 1 ? 'has' : 'have'} finished work but no Client card; nothing written`);
  }
  return margins.map((m) => {
    const card = byName.get(m.client);
    if (m.retainer_months && m.projects) throw new UserError(`Mixed agreement types on ${m.client}; review the margin basis before refreshing`);
    const r = redo.get(m.client) || {};
    const values = {
      'Margin': m.margin, 'Margin %': m.margin_pct, 'Fees to date': m.price, 'Late days': late.get(m.client) || 0,
      'Client revision hrs': r.client_h ?? 0, 'Internal rework hrs': r.internal_h ?? 0,
    };
    if (timeliness.has(m.client)) values['On time %'] = timeliness.get(m.client).share;
    else if (card.values['On time %'] !== null && card.values['On time %'] !== undefined) {
      throw new UserError(`${m.client} has a stored on-time rate but no finished jobs to rate`);
    }
    if (rounds.has(m.client)) values['Average rounds'] = rounds.get(m.client); // blank with no fixed-fee job
    if (usage.has(m.client)) { // blank without a retainer
      values['Retainer usage %'] = usage.get(m.client).used_pct;
      if (usage.get(m.client).trend) values['Retainer trend %'] = usage.get(m.client).trend.points; // blank under six finished months
    }
    values['Account health'] = accountHealth(values);
    values.Why = healthWhy(values);
    const changes = Object.fromEntries(Object.entries(values).filter(([k, v]) => k in card.values && differs(card.values[k], v)));
    return { card: card.name, id: card.id, values, changes };
  });
}

const run = async (env, name, args) => (await TOOLS[name].run(args, env)).structuredContent;

// Every page of a read: page 0, then next_page until none remain, so a workspace of any size is read
// in full. list: the paged list's key; total: the key of its full count; id: what names one entry. Every page must
// carry the first page's list_version, and the entries must add up to the count with each named once; otherwise the
// data moved between pages and nothing is written.
export async function allPages(call, name, args, { list, total, id }) {
  const items = [];
  let first = null;
  for (let page = 0, n = 0; page !== null; n += 1) {
    if (n > 10_000) throw new UserError(`${name} kept giving pages; nothing written`);
    const r = await call(name, { ...args, page });
    first ??= r;
    if (r.list_version !== first.list_version) throw new UserError(`${name} changed while its pages were read; nothing written`);
    items.push(...r[list]);
    page = r.next_page;
  }
  const named = new Set(items.map(id));
  if (items.length !== first[total] || named.size !== items.length) {
    throw new UserError(`${name} changed while its pages were read (${items.length} rows, ${named.size} distinct, ${first[total]} expected); nothing written`);
  }
  return { ...first, [list]: items, page: null, next_page: null };
}

// The refresh: read, work out, write what differs, and "Figures as of" on every card that changed or is not dated
// today. write: false gives the changes without writing.
export async function refreshClientFigures(env, { write = true, now = Date.now() } = {}) {
  const call = (name, args) => run(env, name, args);
  const [margin, onTime, rework, projects, clientTasks, fieldList] = await Promise.all([
    allPages(call, 'margin_by_client', MARGIN_ARGS, { list: 'rows', total: 'rows_total', id: (r) => r.client }),
    allPages(call, 'on_time_rate', { group_by: 'client' }, { list: 'late', total: 'late_total', id: (j) => j.id }),
    allPages(call, 'rework_by_cause', { group_by: 'client' }, { list: 'rows', total: 'rows_total', id: (r) => r.group }),
    allTasks(env, LISTS.projects, true), allTasks(env, LISTS.clients, false), clickup(env, `/list/${LISTS.clients}/field`)]);
  const fieldId = new Map(fieldList.fields.map((f) => [f.name, f.id]));
  // a dropdown is written by its option's id; the card reads back the option's name
  const optionId = new Map(fieldList.fields.filter((f) => f.type === 'drop_down').map((f) => [f.name, new Map(f.type_config.options.map((o) => [o.name, o.id]))]));
  const valueFor = (k, v) => {
    if (!optionId.has(k)) return v;
    if (!optionId.get(k).has(v)) throw new UserError(`${k} has no option named ${v}; nothing written`);
    return optionId.get(k).get(v);
  };
  const carried = [...fieldId.keys()];
  const cards = clientTasks.filter((t) => !t.parent).map((t) => ({ id: t.id, name: t.name, values: Object.fromEntries(carried.map((n) => [n, t.f[n] ?? null])) }));
  const finished = new Set(margin.rows.map((m) => m.client));
  const skipped = cards.filter((c) => !finished.has(c.name)).map((c) => c.name); // no finished work yet
  const usage = new Map();
  for (const c of cards.filter((x) => finished.has(x.name) && num(x.values.Allowance) !== null)) {
    const u = await run(env, 'retainer_usage', { client: c.name });
    usage.set(c.name, { used_pct: u.used_pct, trend: u.trend });
  }
  const rows = clientFigures({ margins: margin.rows, onTime, rework, rounds: roundsAverage(makeTree(projects)), usage, cards });
  const stampDay = (c) => (c.values['Figures as of'] ? dayNumber(Number(c.values['Figures as of']), env) : null);
  for (const r of rows) {
    const card = cards.find((c) => c.id === r.id);
    const changes = { ...r.changes };
    if (Object.keys(changes).length || stampDay(card) !== today(env)) changes['Figures as of'] = now;
    r.changes = changes;
    r.sends = Object.entries(changes).map(([k, v]) => [k, valueFor(k, v)]); // every option checked before any write
  }
  let written = 0;
  for (const r of write ? rows : []) {
    for (const [k, v] of r.sends) {
      await clickupWrite(env, 'POST', `/task/${r.id}/field/${fieldId.get(k)}`, { value: v });
      written += 1;
    }
  }
  return { cards: rows.length, changed: rows.filter((r) => Object.keys(r.changes).some((k) => k !== 'Figures as of')).length, written, skipped, rows };
}

// The scheduled handler's work (worker.js): the refresh on the cron that is 07:30 in London, else nothing. "run-now"
// runs it at once; only a local trigger (wrangler dev --test-scheduled) can send it, never Cloudflare's cron.
export async function scheduledRun(event, env) {
  const due = event.cron === 'run-now' || (CRONS.includes(event.cron) && isRefreshTime(event.scheduledTime));
  if (!due) {
    console.log(JSON.stringify({ job: 'client figures', cron: event.cron, skipped: 'not 07:30 on a Monday in London' }));
    return null;
  }
  try {
    const r = await refreshClientFigures(env, { now: event.scheduledTime });
    console.log(JSON.stringify({ job: 'client figures', cron: event.cron, cards: r.cards, changed: r.changed, written: r.written, skipped: r.skipped }));
    return r;
  } catch (e) {
    console.log(JSON.stringify({ job: 'client figures', cron: event.cron, error: String(e.message || e) }));
    throw e;
  }
}

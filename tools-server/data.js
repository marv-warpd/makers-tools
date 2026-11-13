// Reading ClickUp for Makers tools: the Lists, time entries and Docs; the card tree; names; dates and capacity.
// Read only. Days are counted in TIME_ZONE (wrangler.toml): date-only values are stored at 4 a.m. in the time
// zone of the person who set them, so another zone can move them a day.
export const API = 'https://api.clickup.com/api/v2';
export const WS = '90122179287';
export const LISTS = { intake: '901223511353', projects: '901223511354', clients: '901223511314', agency: '901223511390' };
export const DOCS = { prices: '2kxv6mpq-1532', supplier: '2kxv6mpq-1112' };
// The agents whose comments the pilot measures read, by their display names in the workspace.
export const AGENTS = { planner: 'Delivery Planner', advisor: 'Intake Advisor' };
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const SIGN_OFF_ALLOWANCE = 3; // working days the client has to sign off (as the Skill Plan the work states it)
export const RETAINER_MONTH_TYPE = 1001; // the custom task type "Retainer month"
export const STEP_NAMES = ['Write copy', 'Review copy', 'Design', 'Package files', 'Internal review', 'Deliver',
  'Write script', 'Review script', 'Produce video'];
export const STAGE_NAMES = new Set(['Confirm brief and scope', 'Verify delivery', 'Confirm and approve', 'Kick off delivery']);
// Hours a week of step work per person, by ClickUp username, for planning and the forecast. A Team is its members'
// hours.
export const CAPACITY = { Copywriter: 40, Studio: 40, 'Creative lead': 22, 'Account lead': 16, 'Delivery lead': 0 };
// Hours a week of step work for the leadership reads: CAPACITY's, so planning and leadership use the same week;
// the people with no step work are left out.
export const STEP_WORK_HOURS = Object.fromEntries(Object.entries(CAPACITY).filter(([, h]) => h > 0));
// The workspace's holidays (YYYY-MM-DD): no step is planned on them and they add no capacity. Veterans Day is not
// on the list: it is a working day. ClickUp's capacity tool reports a week's nominal capacity and does not take
// holidays off.
export const HOLIDAYS = new Set(['2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-11-27',
  '2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01']);

export class UserError extends Error {}
// The server is busy with other calls and this one could not start in time: the caller is told to call again.
export class BusyError extends Error {}

// --- reads shared by calls that arrive together --------------------------------------------------------------
// Calls that arrive together share one ClickUp data load, so many calls at once do not each load their own copy and
// run the Worker out of memory. Each read is kept SHARE_MS and handed to every call in that time; a call that finds a load
// under way waits for it, checking every quarter second (waiting on another call's unfinished load can hang a call in
// Workers), and is told the server is busy after WAIT_MS. The values are shared: callers never change them.
const SHARE_MS = 30_000;
const WAIT_MS = 25_000;
const store = new Map(); // key -> { at, value } or { at, loading: true }
// Forget every shared read (the tests, which serve a new workspace each time).
export function forgetShared() { store.clear(); }
export async function sharedRead(key, load) {
  const started = Date.now();
  for (;;) {
    const hit = store.get(key);
    if (hit && 'value' in hit && Date.now() - hit.at < SHARE_MS) return hit.value;
    if (!hit || !hit.loading || Date.now() - hit.at > WAIT_MS) break;
    if (Date.now() - started > WAIT_MS) throw new BusyError('waited too long for a shared load');
    await new Promise((r) => setTimeout(r, 250));
  }
  store.set(key, { at: Date.now(), loading: true });
  try {
    const value = await load();
    store.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    store.delete(key);
    throw e;
  }
}

// --- ClickUp reads -----------------------------------------------------------------------------------------

export async function clickup(env, path, v3 = false) {
  const base = v3 ? 'https://api.clickup.com/api/v3' : API;
  const res = await fetch(base + path, { headers: { Authorization: env.CLICKUP_TOKEN } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// A card's comments: the top-level ones (the latest 25 the API gives) and the threaded replies under them (an agent
// answering an @mention replies in the thread), shared like the other reads.
export function taskComments(env, id) {
  return sharedRead(`comments:${id}`, async () => {
    const top = (await clickup(env, `/task/${id}/comment`)).comments || [];
    const replies = await Promise.all(top.filter((c) => Number(c.reply_count) > 0)
      .map((c) => clickup(env, `/comment/${c.id}/reply`).then((r) => r.comments || []).catch(() => [])));
    return [...top, ...replies.flat()];
  });
}

// Every top-level comment on a card, newest first. The API gives 25 at a time; the next page starts from the oldest
// comment seen, by its date and id.
export async function allComments(env, id) {
  const out = [];
  const seen = new Set();
  for (let path = `/task/${id}/comment`; ;) {
    const page = (await clickup(env, path)).comments || [];
    const fresh = page.filter((c) => !seen.has(String(c.id)));
    fresh.forEach((c) => seen.add(String(c.id)));
    out.push(...fresh);
    if (!fresh.length || page.length < 25) return out;
    const last = page.at(-1);
    path = `/task/${id}/comment?start=${last.date}&start_id=${last.id}`;
  }
}

// A write: used by the write tools (writes.js), the step fields (stepfields.js) and the weekly client figures
// (jobs.js).
export async function clickupWrite(env, method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { Authorization: env.CLICKUP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Every task in a List, 100 a page. Pages are read together, as many as the List held last time plus two
// (Projects with its steps is about 27 pages; a List of cards only, a few), so a call waits for one round.
const pagesSeen = new Map();
export function allTasks(env, list, subtasks) {
  return sharedRead(`tasks:${list}:${subtasks}`, () => loadTasks(env, list, subtasks));
}
async function loadTasks(env, list, subtasks) {
  const out = [];
  const width = (pagesSeen.get(`${list}:${subtasks}`) ?? (subtasks && list === LISTS.projects ? 28 : 3)) + 2;
  for (let page = 0; ; page += width) {
    const pages = await Promise.all(Array.from({ length: width }, (_, i) =>
      clickup(env, `/list/${list}/task?include_closed=true&subtasks=${subtasks}&page=${page + i}`)));
    for (const p of pages) out.push(...(p.tasks || []).map(compact));
    const short = pages.findIndex((p) => (p.tasks || []).length < 100);
    if (short >= 0) {
      pagesSeen.set(`${list}:${subtasks}`, page + short + 1);
      return out;
    }
  }
}

// Every time entry in the window, for every member and guest of the Workspace (an admin key sees them all).
// The window is widened to whole days (UTC), so calls asking for nearly the same window share one read.
export function timeEntries(env, from, to) {
  const a = Math.floor(from / DAY_MS) * DAY_MS;
  const b = Math.ceil(to / DAY_MS) * DAY_MS;
  return sharedRead(`entries:${a}:${b}`, () => loadEntries(env, a, b));
}
async function loadEntries(env, from, to) {
  const team = (await sharedRead('team', () => clickup(env, '/team'))).teams.find((t) => String(t.id) === WS);
  const ids = (team?.members || []).map((m) => m.user.id).join(',');
  const data = (await clickup(env, `/team/${WS}/time_entries?start_date=${from}&end_date=${to}&assignee=${ids}`)).data || [];
  return data.map((e) => ({
    task: e.task?.id ? String(e.task.id) : null, taskName: e.task?.name ?? null, start: Number(e.start), hours: Number(e.duration || 0) / HOUR_MS,
    labels: (e.tags || []).map((t) => t.name), person: e.user?.username ?? null,
  }));
}

// The pages of a Doc as Markdown.
export function docPages(env, docId) {
  return sharedRead(`doc:${docId}`, () => loadDoc(env, docId));
}
async function loadDoc(env, docId) {
  const got = await clickup(env, `/workspaces/${WS}/docs/${docId}/pages?content_format=text/md&max_page_depth=-1`, true);
  return Array.isArray(got) ? got : got.pages || [];
}

export function compact(t) {
  return {
    id: String(t.id), name: t.name || '', parent: t.parent ? String(t.parent) : null,
    type: Number(t.custom_item_id || 0), status: t.status?.status || '', closed: t.status?.type === 'closed',
    start: t.start_date ? Number(t.start_date) : null, due: t.due_date ? Number(t.due_date) : null,
    estimate: t.time_estimate ? Number(t.time_estimate) / HOUR_MS : 0,
    tracked: t.time_spent ? Number(t.time_spent) / HOUR_MS : 0,
    closedOn: t.date_closed ? Number(t.date_closed) : null,
    people: (t.assignees || []).map((a) => a.username).filter(Boolean),
    teams: (t.group_assignees || []).map((g) => g.name).filter(Boolean),
    waitsOn: (t.dependencies || []).filter((x) => String(x.task_id) === String(t.id)).map((x) => String(x.depends_on)),
    f: Object.fromEntries((t.custom_fields || []).map((f) => [f.name, fieldValue(f)])),
  };
}

function fieldValue(f) {
  const v = f.value;
  if (v === undefined || v === null || v === '') return null;
  const options = f.type_config?.options || [];
  if (f.type === 'drop_down') {
    const o = options.find((o) => o.orderindex === Number(v) || o.id === v);
    return o ? o.name : String(v);
  }
  if (f.type === 'labels') return (Array.isArray(v) ? v : []).map((id) => options.find((o) => o.id === id)?.label ?? id);
  if (f.type === 'tasks' || f.type === 'users') {
    return Array.isArray(v) ? v.map((x) => ({ id: String(x.id), name: x.name ?? x.username })) : null;
  }
  if (['currency', 'number', 'formula', 'date'].includes(f.type)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

// --- the card tree -----------------------------------------------------------------------------------------
// A unit of work is a project card at the top of Projects, or a retainer piece under its month card. Month
// cards carry a retainer client's money for the month; steps, stage subtasks and rework cards sit below a unit.

export function isMonth(t) { return t.type === RETAINER_MONTH_TYPE || /^retainer month/i.test(t.name); }
export function isTest(t) { return /\[test\]/i.test(t.name); }
// A time entry on a [Test] card, or on a step or card under one, counts in no figure: the entry's own task name, then
// each card above it on the tree.
export function onTest(e, tree) {
  if (e.taskName && isTest({ name: e.taskName })) return true;
  for (let cur = e.task ? tree.byId.get(e.task) : null, i = 0; cur && i < 8; cur = cur.parent ? tree.byId.get(cur.parent) : null, i++) {
    if (isTest(cur)) return true;
  }
  return false;
}

export function makeTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map();
  for (const t of tasks) if (t.parent) children.set(t.parent, [...(children.get(t.parent) || []), t]);
  const isUnit = (t) => !!t && !isMonth(t) && (!t.parent || isMonth(byId.get(t.parent) || {}));
  const unitOf = (id) => {
    let cur = byId.get(id);
    for (let i = 0; i < 6 && cur && !isUnit(cur); i++) cur = byId.get(cur.parent);
    return isUnit(cur) ? cur.id : null;
  };
  const descendants = (id) => (children.get(id) || []).flatMap((c) => [c, ...descendants(c.id)]);
  const units = tasks.filter((t) => isUnit(t) && !isTest(t));
  const months = tasks.filter((t) => isMonth(t) && !t.parent && !isTest(t));
  return { byId, units, months, unitOf, descendants, kids: (id) => children.get(id) || [], hasKids: (id) => children.has(id) };
}

// A card named by ClickUp's own reference, as agents pass it: "task:869fmxwph", a task link (…/t/869fmxwph, or with
// the Workspace id before it) or "#869fmxwph". Anything else is returned as it was typed.
export function cardRef(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^(?:task:|#)([a-z0-9]+)$/i) || t.match(/\/t\/(?:\d+\/)?([a-z0-9]+)\/?(?:[?#].*)?$/i);
  return m ? m[1] : t;
}

// A client or project named in words or by its card id: exact, then case-insensitive, then contains; exactly one
// match, or say what matched.
export function matchOne(cards, text, what = 'Client card') {
  const typed = cardRef(text);
  if (!typed) throw new UserError(`No ${what === 'Client card' ? 'client' : 'project'} was named`);
  const byId = cards.find((c) => c.id === typed);
  if (byId) return byId;
  const norm = (s) => s.trim().toLowerCase();
  for (const test of [(n) => n.trim() === typed, (n) => norm(n) === norm(typed), (n) => norm(n).includes(norm(typed))]) {
    const found = cards.filter((c) => test(c.name));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new UserError(`"${typed}" matches ${found.length} ${what}s (${found.slice(0, 5).map((c) => c.name).join(', ')}${found.length > 5 ? ', and more' : ''}); name one`);
    }
  }
  throw new UserError(`No ${what} matches "${typed}"`);
}

export function isFor(card, client) { return (card.f.Client || []).some((c) => c.id === client.id); }
export function clientName(card) { return (card.f.Client || [])[0]?.name ?? '(no client)'; }
export function delivered(t) { return num(t.f['Delivered on']) ?? t.closedOn; }

// --- dates -------------------------------------------------------------------------------------------------

function parts(ms, env) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: env.TIME_ZONE || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const get = (type) => Number(p.find((x) => x.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
export function dayNumber(ms, env) { const { y, m, d } = parts(ms, env); return Date.UTC(y, m - 1, d) / DAY_MS; }
export function today(env) { return dayNumber(Date.now(), env); }
export function days(fromMs, toMs, env) { return dayNumber(toMs, env) - dayNumber(fromMs, env); }
export function monthOf(ms, env) { const { y, m } = parts(ms, env); return `${y}-${String(m).padStart(2, '0')}`; }
export function isoDay(dn) { return new Date(dn * DAY_MS).toISOString().slice(0, 10); }
export function isWorkingDay(dn) {
  const wd = new Date(dn * DAY_MS).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(isoDay(dn));
}
export function workingDaysBetween(fromDn, toDn) { // fromDn to toDn, both included
  let n = 0;
  for (let d = fromDn; d <= toDn; d++) if (isWorkingDay(d)) n++;
  return n;
}
export function nextWorkingDay(dn) { let d = dn; while (!isWorkingDay(d)) d++; return d; }
export function addWorkingDays(dn, n) { // the nth working day after dn (n = 0: dn itself if working)
  let d = nextWorkingDay(dn);
  for (let i = 0; i < n; i++) d = nextWorkingDay(d + 1);
  return d;
}
export function dayText(dn) {
  return new Date(dn * DAY_MS).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}
export function dateText(ms, env) {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString('en-US', { timeZone: env.TIME_ZONE || 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}
export function monthLabel(month, env) {
  if (month === monthOf(Date.now(), env)) return 'this month';
  const [y, m] = month.split('-').map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return y === parts(Date.now(), env).y ? `in ${name}` : `in ${name} ${y}`;
}
export function stamp(env) {
  return new Date().toLocaleString('en-US', { timeZone: env.TIME_ZONE || 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
// A from/to filter on a day number; dates as YYYY-MM-DD.
export function period(args) {
  const parse = (s, name) => {
    if (s === undefined || s === null || s === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new UserError(`"${s}" is not a date for ${name}; use YYYY-MM-DD`);
    return Date.UTC(...String(s).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / DAY_MS;
  };
  const from = parse(args.from, 'from');
  const to = parse(args.to, 'to');
  return { from, to, has: (dn) => dn !== null && (from === null || dn >= from) && (to === null || dn <= to),
    label: from === null && to === null ? '' : ` from ${from === null ? 'the start' : isoDay(from)} to ${to === null ? 'today' : isoDay(to)}` };
}

// --- capacity (Workload's method) --------------------------------------------------------------------------
// A step's estimate is spread evenly over the working days from its start to its due date (its due date alone
// when it has no start). A person's booked hours on a day are the sum over their open steps; a Team step counts
// on its members' rows, split between them (Workload, "Group in Workload"). Free hours = the day's share of the
// week's capacity, less what is booked.

export function teamMembers(env) {
  return sharedRead('groups', () => loadGroups(env));
}
async function loadGroups(env) {
  const groups = (await clickup(env, `/group?team_id=${WS}`)).groups || [];
  return new Map(groups.map((g) => [g.name, (g.members || []).map((m) => m.username)]));
}

// Whose hours a step uses: its assigned people, or the members of its Team when no person has it yet.
export function ownersOf(step, members) {
  if (step.people.length) return step.people;
  return step.teams.flatMap((t) => members.get(t) || []);
}
export function ownerLabel(step) {
  if (step.people.length) return step.people.join(', ');
  return step.teams.length ? `${step.teams.join(', ')} Team (no person yet)` : 'no owner';
}

// The working days a step's estimate is spread over: its start to its due date (its due date alone without a start).
function spreadDays(s, env) {
  const end = dayNumber(s.due, env);
  const start = s.start ? Math.min(dayNumber(s.start, env), end) : end;
  const workDays = [];
  for (let d = start; d <= end; d++) if (isWorkingDay(d)) workDays.push(d);
  if (!workDays.length) workDays.push(end);
  return workDays;
}

export function bookings(steps, env, members) {
  const out = new Map(); // person -> Map(day -> hours)
  for (const s of steps) {
    const owners = ownersOf(s, members);
    if (!s.estimate || !s.due || !owners.length) continue;
    const workDays = spreadDays(s, env);
    const per = s.estimate / workDays.length;
    for (const owner of owners) {
      const m = out.get(owner) || new Map();
      for (const d of workDays) m.set(d, (m.get(d) || 0) + per / owners.length);
      out.set(owner, m);
    }
  }
  return out;
}

// The same bookings by step, so a plan can name the work competing for a person's time ("Client Q's Write
// copy"). person -> Map(day -> [{ id, label, hours }]).
export function bookingsBy(steps, env, members, labelOf) {
  const out = new Map();
  for (const s of steps) {
    const owners = ownersOf(s, members);
    if (!s.estimate || !s.due || !owners.length) continue;
    const workDays = spreadDays(s, env);
    const per = s.estimate / workDays.length / owners.length;
    const label = labelOf(s);
    for (const owner of owners) {
      const m = out.get(owner) || new Map();
      for (const d of workDays) m.set(d, [...(m.get(d) || []), { id: s.id, label, hours: per }]);
      out.set(owner, m);
    }
  }
  return out;
}

// bookingsBy less a set of steps (a project's own).
export function withoutBy(all, ownIds) {
  const out = new Map();
  for (const [owner, days] of all) out.set(owner, new Map([...days].map(([d, xs]) => [d, xs.filter((x) => !ownIds.has(x.id))])));
  return out;
}

// Booked hours less a set of steps' own bookings (so a project's free time is read without its own work).
export function without(all, own) {
  const out = new Map();
  for (const [owner, days] of all) {
    const mine = own.get(owner) || new Map();
    out.set(owner, new Map([...days].map(([d, h]) => [d, Math.max(0, h - (mine.get(d) || 0))])));
  }
  return out;
}

export function dailyCapacity(owner) { return (CAPACITY[owner] ?? 0) / 5; }

export function freeHours(owner, fromDn, toDn, booked, capPct = 100) {
  const cap = dailyCapacity(owner) * (capPct / 100);
  const m = booked.get(owner) || new Map();
  let free = 0;
  for (let d = fromDn; d <= toDn; d++) if (isWorkingDay(d)) free += Math.max(0, cap - (m.get(d) || 0));
  return free;
}

// --- numbers -----------------------------------------------------------------------------------------------

export function num(v) { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }
export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
// One decimal, a half to the even digit (18.25 -> 18.2).
export function round1(x) {
  const y = x * 10;
  const r = Math.abs(y % 1) === 0.5 ? 2 * Math.round(y / 2) : Math.round(y);
  return r / 10;
}
export function fmt(x) { return String(round1(x)); }
export function money(x) { return `${x < 0 ? '-' : ''}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`; }
export function pct(a, b) { return b ? `${Math.round((100 * a) / b)}%` : '-'; }
export function signedPct(x) { return `${x >= 0 ? '+' : ''}${Math.round(100 * x)}%`; }

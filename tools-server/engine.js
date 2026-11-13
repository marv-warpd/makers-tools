// The Delivery Planner's scheduling engine: one set of rules in two modes. Pure and deterministic: it reads nothing
// and writes nothing; the same input always gives the same plan. The tools in tools.js read ClickUp, build the
// input, and return the plan for the agent to write.
//
//   plan      new work (plan_new_work): every step planned from its first day, in windows at the 80% cap
//             (the Delivery Planner's Skill Plan the work).
//   recovery  live work (plan_rework, test_a_fix, forecast_delivery): from today, on hours, not windows: each
//             open step's remaining hours fitted into people's actual free time day by day at 100%, as early as
//             the steps it waits on allow; the agency's turnaround and the client's sign-off held fixed. A step
//             can land before its planned due date as well as after it, so the recovery plan can bring the send
//             back inside the Due date.
//
// Rules in both modes (the Skill Plan the work): working days only, the workspace's holidays skipped (data.js
// HOLIDAYS); every step, a review included, starts the working day after the step it waits on finishes; a step's
// hours go into its owners' free time each day (capacity less the work already booked that day, Workload's
// method), no more than the cap's share of the day or of the week; a Team's step uses its members' time; the
// agency's window is one day to release the brief plus the turnaround (a rework's Design: the revision
// turnaround); Deliver is the files going out (the send), then the client's sign-off time; the Feasible date is
// the send plus two working days (the buffer). When a step waits for its owner, or runs past its planned due date,
// its reason names the work booked in that owner's time ("Client Q's Write copy (6 h) and Client K's Write copy
// (4 h) also book Copywriter's time before Fri, Mar 6").
import { DAY_MS, isWorkingDay, nextWorkingDay, addWorkingDays, workingDaysBetween, isoDay, dayText } from './data.js';

const KIND_ORDER = { production: 0, review: 1, agency: 2, deliver: 3 };
const SLACK = 0.25; // hours: a step this little short of a day's room is placed that day anyway
const BUFFER_DAYS = 2; // working days from the send to the Feasible date (the buffer)

export function kindOf(name) {
  const base = String(name).replace(/^Rework: /, '');
  if (base === 'Design') return 'agency';
  if (base === 'Deliver') return 'deliver';
  if (/^(Review copy|Review script|Internal review)$/.test(base)) return 'review';
  return 'production';
}

const mondayOf = (d) => d - ((new Date(d * DAY_MS).getUTCDay() + 6) % 7);
const holidaysIn = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d++) {
    const wd = new Date(d * DAY_MS).getUTCDay();
    if (wd !== 0 && wd !== 6 && !isWorkingDay(d)) out.push(d);
  }
  return out;
};
const r2 = (x) => Math.round(x * 100) / 100;
const hrs = (x) => `${r2(x)} h`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const bare = (label) => label.replace(/ \(.*\)$/, ''); // "the Studio Team (Studio)" -> "the Studio Team"
const wdays = (n) => `${n} working day${n === 1 ? '' : 's'}`;

/**
 * input: {
 *   mode: 'plan' | 'recovery', today: day number, capPct (default: plan 80, recovery 100),
 *   capacity: { person: weekly hours }, booked: Map(person -> Map(day -> hours)) of other work,
 *   bookedBy: the same by step, Map(person -> Map(day -> [{ id, label, hours }])) (optional: names the work),
 *   self: how this card's own steps are named in a reason (default "this project"),
 *   steps: [{ id, name, owners: [person], ownerLabel, hours, sizeNote, plannedStart, plannedDue, waitsOn: [step id],
 *             agencyDays, agencyNote, signOffDays, signOffNote }],
 *   promise, requested: day numbers or null, whatIf: { step, owner, start } or null,
 *   keepStarts: true for no step before its planned start (the least-slack-first reshuffle)
 * }
 */
export function schedule(input) {
  const { today, capacity } = input;
  const recovery = input.mode === 'recovery';
  const capPct = input.capPct ?? (recovery ? 100 : 80);
  const booked = input.booked || new Map();
  const bookedBy = input.bookedBy || null;
  const self = input.self || 'this project';
  const steps = input.steps.map((s, i) => ({ ...s, index: i, kind: kindOf(s.name) }));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const placed = new Map(); // person -> Map(day -> hours), this plan's own hours
  const placedBy = new Map(); // person -> Map(day -> [{ label, hours }]), the same by step
  const dayCap = (o) => ((capacity[o] ?? 0) / 5) * (capPct / 100);
  const used = (o, d) => (booked.get(o)?.get(d) || 0) + (placed.get(o)?.get(d) || 0);
  const weekRoom = (o, d) => {
    let room = 0;
    for (let x = mondayOf(d); x < mondayOf(d) + 5; x++) if (isWorkingDay(x)) room += dayCap(o) - used(o, x);
    return room;
  };
  // Every mode reads each day's free time, within what is left of the week.
  const room = (owners, d) => owners.reduce((a, o) => a + Math.max(0, Math.min(dayCap(o) - used(o, d), weekRoom(o, d))), 0);
  const book = (owners, d, h, label, id) => {
    for (const o of owners) {
      const m = placed.get(o) || new Map();
      m.set(d, (m.get(d) || 0) + h / owners.length);
      placed.set(o, m);
      const mb = placedBy.get(o) || new Map();
      mb.set(d, [...(mb.get(d) || []), { id, label, hours: h / owners.length }]);
      placedBy.set(o, mb);
    }
  };
  // Hours into the owners' free time from day `from`, day by day: the first and last day used.
  const placeHours = (owners, from, need, label, id) => {
    let d = nextWorkingDay(from);
    let first = null;
    let left = need;
    const used = []; // [day, hours]
    for (let guard = 0; guard < 500; guard++) {
      const r = room(owners, d);
      const take = left - r <= SLACK && r > 0 ? left : Math.min(left, r); // a quarter hour short still fits the day
      if (take > 1e-9) { book(owners, d, take, label, id); left -= take; used.push([d, take]); if (first === null) first = d; }
      if (left <= 1e-9) return { first: first ?? d, last: d, placedAll: true, used };
      d = nextWorkingDay(d + 1);
    }
    return { first: first ?? from, last: d, placedAll: false, used };
  };
  // New work: a production step's window is long enough that it takes no more than half its owners'
  // day (hours ÷ half their daily hours, rounded up, at least one day), its hours spread evenly over the window as
  // Workload shows them. The window goes where each of its days has room for its daily share, ending as early as it
  // can; a longer window is used only when no window of the shortest length fits by then.
  const placeWindow = (owners, from, need, label, id) => {
    const half = owners.reduce((a, o) => a + (capacity[o] ?? 0) / 5, 0) / 2;
    const nMin = Math.max(1, Math.ceil(need / half - 1e-9));
    const fits = (win, per) => owners.every((o) => {
      const share = per / owners.length;
      const tol = SLACK / win.length;
      if (win.some((x) => share > dayCap(o) - used(o, x) + tol)) return false;
      const weeks = new Map();
      for (const x of win) weeks.set(mondayOf(x), (weeks.get(mondayOf(x)) || 0) + share);
      return [...weeks].every(([mon, h]) => h <= weekRoom(o, mon) + SLACK);
    });
    const days = [];
    let d = nextWorkingDay(from);
    for (let guard = 0; guard < 400; guard++) {
      days.push(d);
      for (let n = nMin; n <= Math.min(days.length, nMin + 20); n++) {
        const win = days.slice(days.length - n);
        const per = need / n;
        if (fits(win, per)) {
          for (const x of win) book(owners, x, per, label, id);
          return { first: win[0], last: win.at(-1), placedAll: true, used: win.map((x) => [x, per]), n, nMin, per, half };
        }
      }
      d = nextWorkingDay(d + 1);
    }
    return { ...placeHours(owners, from, need, label, id), nMin, half };
  };
  // New work: a review takes one working day, the first with room for its hours.
  const placeOneDay = (owners, from, need, label, id) => {
    if (need > owners.reduce((a, o) => a + dayCap(o), 0) + SLACK) return placeHours(owners, from, need, label, id);
    let d = nextWorkingDay(from);
    for (let guard = 0; guard < 400; guard++) {
      if (room(owners, d) + SLACK >= need) { book(owners, d, need, label, id); return { first: d, last: d, placedAll: true, used: [[d, need]] }; }
      d = nextWorkingDay(d + 1);
    }
    return placeHours(owners, from, need, label, id);
  };
  // The work booked in the owners' time from day `from` to day `to`, largest first, by card and step, leaving out
  // the step itself (`mine`); the words end with `span` ("before Fri, Mar 6"). Empty when nothing is booked then.
  const competing = (owners, from, to, span, mine) => {
    if (to < from) return '';
    const sums = new Map();
    let total = 0;
    for (const o of owners) {
      for (let d = from; d <= to; d++) {
        const xs = [...(bookedBy?.get(o)?.get(d) || []), ...(placedBy.get(o)?.get(d) || [])];
        for (const b of xs) if (b.label !== mine) { sums.set(b.label, (sums.get(b.label) || 0) + b.hours); total += b.hours; }
        if (!bookedBy) total += booked.get(o)?.get(d) || 0;
      }
    }
    if (total < 0.05) return '';
    const who = `${list(owners)}'s time`;
    const top = [...sums.entries()].filter(([, h]) => h >= 0.05).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!top.length) return `${hrs(total)} of other work is booked in ${who} ${span}`;
    const shown = top.slice(0, 3);
    const rest = top.length - shown.length;
    const named = shown.map(([l, h]) => `${l} (${hrs(h)})`);
    if (rest > 0) named.push(`${rest} other step${rest === 1 ? '' : 's'}`);
    return `${list(named)} ${named.length === 1 ? 'books' : 'also book'} ${who} ${span}`;
  };

  // Why a step waits for its owners from `earliest` to `start`: the week full (its hours booked past the cap's
  // share of the week, so a free-looking day is not free), naming that week's work; or the days before it filled.
  const waitWords = (owners, earliest, start, mine) => {
    const mon = mondayOf(earliest);
    if (mondayOf(start) > mon && owners.every((o) => weekRoom(o, earliest) <= 1e-9)) {
      let load = 0; let cap = 0;
      for (let x = mon; x < mon + 5; x++) if (isWorkingDay(x)) for (const o of owners) { load += used(o, x); cap += dayCap(o); }
      const busy = competing(owners, mon, mon + 4, 'that week', mine);
      clash = { owners, from: mon, to: Math.min(mon + 4, start - 1) };
      return `${list(owners)}'s week of ${dayText(mon)} is full, ${hrs(load)} booked of ${hrs(cap)} at ${capPct}%${busy ? `: ${busy}` : ''}`;
    }
    clash = { owners, from: earliest, to: start - 1 };
    return competing(owners, earliest, start - 1, `before ${dayText(start)}`, mine);
  };
  let clash = null; // where the step last met other work: its owners and the days

  // The order: a step after everything it waits on; ties by its planned start, then the usual step order, then id.
  const order = [];
  const done = new Set();
  const pending = [...steps].sort((a, b) => (a.plannedStart ?? Infinity) - (b.plannedStart ?? Infinity)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.index - b.index || String(a.id).localeCompare(String(b.id)));
  while (pending.length) {
    let i = pending.findIndex((s) => s.waitsOn.every((w) => done.has(w) || !byId.has(w)));
    if (i < 0) i = 0; // a loop in the links: take the next in order
    const s = pending.splice(i, 1)[0];
    order.push(s);
    done.add(s.id);
  }

  const out = new Map();
  const whatIf = input.whatIf && input.whatIf.step ? input.whatIf : null;
  for (const s of order) {
    const changed = !!whatIf && s.name.toLowerCase() === String(whatIf.step).toLowerCase();
    let owners = s.owners;
    let ownerLabel = s.ownerLabel;
    if (changed && whatIf.owner) { owners = [whatIf.owner]; ownerLabel = whatIf.owner; }
    const label = `${self}'s ${s.name}`;
    // A step waits for the day the step before it ends; a step before it that has not started ends no earlier than its
    // planned due date (s.holdDue), so a step pushed past the one that waits on it shows there.
    const waits = s.waitsOn.filter((w) => out.has(w)).map((w) => ({ name: byId.get(w).name, due: Math.max(out.get(w).due, byId.get(w).holdDue ?? -Infinity) }));
    const last = waits.length ? waits.reduce((a, b) => (b.due > a.due ? b : a)) : null;
    const why = [];
    const window = s.plannedStart !== null && s.plannedDue !== null ? Math.max(1, workingDaysBetween(s.plannedStart, s.plannedDue)) : null;

    // The earliest day the step can start: the first day (today, in recovery), after the steps it waits on.
    let earliest = today;
    let earliestWhy = recovery ? 'today' : 'the first day of the plan';
    // Every step, reviews included, starts the working day after the step it waits on finishes.
    if (last) {
      const handoff = nextWorkingDay(last.due + 1);
      if (handoff > earliest) {
        earliest = handoff;
        earliestWhy = `the working day after ${last.name} finishes`;
      }
    }
    // A reshuffle keeps each step's planned start as its floor (input.keepStarts): work moves later, never earlier.
    if (input.keepStarts && s.plannedStart !== null && s.plannedStart > earliest) { earliest = s.plannedStart; earliestWhy = 'its planned start'; }
    // A step waiting on one that has started and is not part of this plan starts no earlier than the working day after
    // that step's card due date (s.floor, set by the re-plan of open steps).
    if (s.floor !== null && s.floor !== undefined && s.floor > earliest) { earliest = s.floor; earliestWhy = s.floorWhy || 'the working day after the step it waits on finishes on its card'; }
    if (changed && whatIf.start !== null && whatIf.start !== undefined && whatIf.start > earliest) { earliest = whatIf.start; earliestWhy = 'the start tried'; }
    earliest = nextWorkingDay(earliest);

    let start; let due; let waited = false; let placedDays = []; let windowWords = null; let workStart = null;
    clash = null;
    const hours = s.hours || 0;
    const canPlace = owners.length > 0 && owners.every((o) => (capacity[o] ?? 0) > 0);
    if (s.kind === 'agency') {
      const underWay = recovery && s.plannedStart !== null && s.plannedDue !== null && s.plannedStart <= today && (!last || last.due < s.plannedStart);
      if (underWay) {
        start = s.plannedStart;
        due = nextWorkingDay(Math.max(s.plannedDue, today));
        why.push(`with the agency since ${dayText(start)}`, s.plannedDue < today
          ? `the agency's due date of ${dayText(s.plannedDue)} has passed: taken as finishing ${dayText(due)}`
          : `the agency's due date of ${dayText(s.plannedDue)} holds (its turnaround is fixed)`);
      } else {
        const days = s.agencyDays || window || 1;
        start = earliest;
        due = addWorkingDays(start, days - 1);
        why.push(`starts ${dayText(start)}, ${earliestWhy}`, `the agency's window, ${wdays(days)}: ${s.agencyNote || (s.agencyDays ? "the agency's turnaround" : "its planned window with the agency, held fixed")}`);
      }
      if (hours > 0 && owners.length) { // the creative lead's coordination hours, spread over the window
        const ds = []; for (let d = start; d <= due; d++) if (isWorkingDay(d)) ds.push(d);
        for (const d of ds) book(owners, d, hours / ds.length, label, s.id);
      }
    } else if (s.kind === 'deliver') {
      let filesOut = earliest;
      if (canPlace && hours > 0) {
        const p = placeHours(owners, earliest, hours, label, s.id);
        filesOut = p.last;
        placedDays = p.used;
        workStart = p.first;
        if (p.first > earliest) {
          waited = true;
          const busy = waitWords(owners, earliest, p.first, label);
          why.push(`waits for ${bare(ownerLabel)} until ${dayText(p.first)}${busy ? `: ${busy}` : ''}`);
        }
      }
      const days = s.signOffDays || window || 3;
      start = filesOut;
      due = addWorkingDays(start, days - 1);
      why.unshift(filesOut === earliest ? `the files go out ${dayText(start)}, ${earliestWhy}` : `the files go out ${dayText(start)}`);
      why.push(`then ${wdays(days)} for the client's sign-off: ${s.signOffNote || (s.signOffDays ? 'the sign-off allowance' : window ? "its planned sign-off window, held fixed" : 'the 3-day allowance')}`);
    } else if (!canPlace) {
      const days = recovery ? (window || 1) : 1;
      start = earliest;
      due = addWorkingDays(start, days - 1);
      why.push(`starts ${dayText(start)}, ${earliestWhy}`, owners.length
        ? `no capacity on record for ${ownerLabel}: held ${recovery && window ? 'its planned window' : 'one working day'}`
        : `no owner on record, so no capacity to read: held ${recovery && window ? 'its planned window' : 'one working day'}`);
    } else if (hours <= 0) {
      start = earliest; due = earliest;
      why.push(`starts ${dayText(start)}, ${earliestWhy}`, 'no hours to place: held one working day');
    } else {
      const p = recovery ? placeHours(owners, earliest, hours, label, s.id)
        : s.kind === 'production' ? placeWindow(owners, earliest, hours, label, s.id) : placeOneDay(owners, earliest, hours, label, s.id);
      start = p.first; due = p.last; placedDays = p.used;
      if (p.n) windowWords = `a ${wdays(p.n)} window, ${hrs(p.per)} a day: no more than half ${list(owners)}'s ${hrs(2 * p.half)} day${p.n > p.nMin ? ` (${p.n - p.nMin} day${p.n - p.nMin === 1 ? '' : 's'} longer than the shortest, ${wdays(p.nMin)}, to fit the free time)` : ''}`;
      if (start > earliest) {
        waited = true;
        const busy = waitWords(owners, earliest, start, label);
        why.push(`waits for ${bare(ownerLabel)} until ${dayText(start)}${busy ? `: ${busy}` : ''}`);
      } else {
        why.push(`starts ${dayText(start)}, ${earliestWhy}`);
      }
      const n = workingDaysBetween(start, due);
      why.push(windowWords || (s.kind === 'review' && n === 1 ? `${hrs(hours)} in one working day`
        : `${hrs(hours)} over ${wdays(n)}, no more than ${hrs(owners.reduce((a, o) => a + dayCap(o), 0))} a day at ${capPct}%`));
      if (!p.placedAll) why.push('not enough free time in the next 500 working days to place it all');
    }
    const late = s.plannedDue !== null && due > s.plannedDue;
    // Its own hours that do not fit its owners' free time before its planned due date (Deliver's: before its planned
    // start, the day the files go out), counted only when it could start by then: a step held by what it waits on
    // is late from the chain, not short of hours.
    const ownBy = s.kind === 'deliver' ? s.plannedStart : s.plannedDue;
    const heldByChain = ownBy !== null && earliest > ownBy;
    const shortHours = ownBy === null || heldByChain ? 0 : r2(placedDays.filter(([d]) => d > ownBy).reduce((a, [, h]) => a + h, 0));
    if (recovery && s.plannedDue !== null && due !== s.plannedDue) {
      if (late) {
        why.push(`${wdays(workingDaysBetween(s.plannedDue + 1, due))} after its planned due date of ${dayText(s.plannedDue)}`);
        // Started in time but its hours did not fit by then: name what else is booked in that time.
        if (!waited && shortHours > 0 && placedDays.length) {
          const busy = competing(owners, placedDays[0][0], ownBy, `up to ${dayText(ownBy)}`, label);
          clash = { owners, from: placedDays[0][0], to: ownBy };
          if (busy) why.push(busy);
        }
      } else {
        why.push(`${wdays(workingDaysBetween(due + 1, s.plannedDue))} before its planned due date of ${dayText(s.plannedDue)}`);
      }
    }
    const hol = holidaysIn(start, due);
    if (hol.length) why.push(`skips ${list(hol.map(dayText))} (holiday${hol.length === 1 ? '' : 's'})`);
    out.set(s.id, {
      id: s.id, step: s.name, kind: s.kind, owner: ownerLabel, hours: r2(hours), sizeNote: s.sizeNote || null,
      start, due, earliest, plannedStart: s.plannedStart, plannedDue: s.plannedDue, late, changed, waited, heldByChain, shortHours,
      // Deliver: the day its hours start (the files go out when they are done), the day its card start stands for.
      workStart: workStart ?? start,
      clash: waited || shortHours > 0 ? clash : null,
      reason: `${s.name}${hours ? `, ${hrs(hours)}${s.sizeNote ? ` (${s.sizeNote})` : ''}` : ''}, ${ownerLabel}: ${why.filter(Boolean).join('; ')}.`,
    });
  }

  const plan = order.map((s) => out.get(s.id));
  // The send is the day the files go out (the Deliver step's start); the Feasible date, and so the Due date the
  // client agrees, is the send plus two working days (the buffer); the client's sign-off after the send is their
  // clock. Every verdict on the Due date is the send's.
  const delivers = plan.filter((p) => p.kind === 'deliver');
  const sendStep = delivers.length ? delivers.reduce((a, b) => (b.start > a.start ? b : a)) : null;
  const endStep = sendStep || plan.reduce((a, b) => (!a || b.due > a.due ? b : a), null);
  const send = sendStep ? sendStep.start : null;
  const plannedSend = sendStep ? sendStep.plannedStart : null;
  const feasible = send === null ? null : addWorkingDays(send, BUFFER_DAYS);
  const lands = endStep ? endStep.due : null;
  const vs = (day, target) => (target === null || target === undefined || day === null ? null
    : day > target ? workingDaysBetween(target + 1, day) : -workingDaysBetween(day + 1, target));
  const sendPastDue = vs(send ?? lands, input.promise);
  return {
    plan, send, planned_send: plannedSend, feasible, lands, promise: input.promise ?? null, requested: input.requested ?? null,
    // This plan's own hours, by person and day, and by step, so plans can be played forward together.
    placed, placed_by: placedBy,
    send_past_due: sendPastDue, feasible_past_requested: vs(feasible ?? lands, input.requested),
    // When the send is past the Due date: the first step, in order, that finishes after its planned due date, else
    // the first that waited for its owner.
    first_break: sendPastDue !== null && sendPastDue > 0 ? plan.find((p) => p.late) || plan.find((p) => p.waited) || null : null,
    // How far the plan moves the send from the send on the card (working days; negative is earlier).
    send_moves: vs(send, plannedSend),
  };
}

// Plain words for a day against a date ("2 working days after the Due date (Thu, Mar 19)").
export function against(days, target, what) {
  if (days === null) return '';
  if (days > 0) return `${wdays(days)} after ${what} (${dayText(target)})`;
  if (days === 0) return `on ${what}`;
  return `${wdays(-days)} before ${what} (${dayText(target)})`;
}

export function planLines(result) {
  return result.plan.map((p) => `- ${p.reason}`);
}

export function shape(result) {
  const iso = (d) => (d === null || d === undefined ? null : isoDay(d));
  return {
    send: iso(result.send), planned_send: iso(result.planned_send), feasible_date: iso(result.feasible), sign_off_ends: iso(result.lands),
    due_date: iso(result.promise), requested: iso(result.requested),
    working_days_send_past_due_date: result.send_past_due, working_days_feasible_past_requested: result.feasible_past_requested,
    first_step_that_breaks: result.first_break?.step ?? null, send_moves_working_days: result.send_moves,
    steps: result.plan.map((p) => ({ step: p.step, owner: p.owner, hours: p.hours, size: p.sizeNote, start: iso(p.start), due: iso(p.due),
      planned_start: iso(p.plannedStart), planned_due: iso(p.plannedDue), late: p.late, reason: p.reason })),
  };
}

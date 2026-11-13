// Fix references: a fix a tool proposes (Forecast delivery's reshuffle or Watch moves, a change Test a fix
// tried) is stored under a short reference derived from the card it is for and its full move list, so Apply fix writes
// exactly the moves that were proposed and approved, and nothing else (writes.js). The store is the Workers KV
// namespace bound as FIXES; each plan expires 14 days after it was last proposed.
import { DAY_MS, UserError } from './data.js';

export const FIX_DAYS = 14;
const keyOf = (ref) => `fix:${ref}`;

// What the reference is derived from: the card the fix is for, then every move in order, each as card id, step id,
// from start, from due, to start, to due (YYYY-MM-DD, or null for a step with no date).
function identity(projectId, moves) {
  return JSON.stringify([String(projectId), moves.map((m) => [String(m.card_id), String(m.step_id), m.from, m.from_due, m.to, m.to_due])]);
}
async function hex8(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// The reference for a plan, eight hex characters. Another plan already holding a reference moves this one to the next
// candidate (n = 1, 2, 3), so a stored plan is never replaced by a different one.
const candidate = (id, n) => hex8(n ? `${id}#${n}` : id);

// Stores the plan and gives its reference: { ref }, or { ref: null, why } when it cannot be stored. The same plan
// proposed again keeps its reference; its 14 days restart at most once a day. Never throws: a read tool still answers.
export async function proposeFix(env, { project, source, moves }) {
  if (!moves.length) return null;
  if (!env.FIXES) return { ref: null, why: 'this server has no fix store (the FIXES binding), so Apply fix cannot write it' };
  const id = identity(project.id, moves);
  try {
    for (let n = 0; n < 4; n++) {
      const ref = await candidate(id, n);
      const held = await env.FIXES.get(keyOf(ref), 'json');
      if (held && identity(held.project_id, held.moves) !== id) continue;
      const now = Date.now();
      if (!held || !(now - Date.parse(held.made) < DAY_MS)) {
        await env.FIXES.put(keyOf(ref), JSON.stringify({ ref, made: new Date(now).toISOString(), source, project_id: String(project.id),
          project: project.name, moves }), { expirationTtl: FIX_DAYS * 86400 });
      }
      return { ref };
    }
    return { ref: null, why: 'no free reference for this fix' };
  } catch {
    return { ref: null, why: 'the fix store could not be reached just now' };
  }
}

// The plan stored under a reference, read fresh; null when there is none, or when it was proposed more than 14 days
// ago. A plan whose moves no longer give its reference is not used.
export async function storedFix(env, ref) {
  if (!env.FIXES) throw new UserError('This server has no fix store (the FIXES binding), so no fix can be applied; nothing was written');
  const held = await env.FIXES.get(keyOf(ref), 'json');
  if (!held || !Array.isArray(held.moves) || !(Date.now() - Date.parse(held.made) < FIX_DAYS * DAY_MS)) return null;
  const id = identity(held.project_id, held.moves);
  for (let n = 0; n < 4; n++) if (await candidate(id, n) === ref) return held;
  return null;
}

// A step move in the stored form: from the step's start and due date as the card holds them now to where the fix puts
// them (to and toDue, YYYY-MM-DD). day: a card timestamp as YYYY-MM-DD.
export function moveOf(unit, task, to, toDue, day) {
  const at = (ms) => (ms ? day(ms) : null);
  return { card_id: String(unit.id), card: unit.name, step_id: String(task.id), step: task.name,
    from: at(task.start), from_due: at(task.due), to, to_due: toDue };
}

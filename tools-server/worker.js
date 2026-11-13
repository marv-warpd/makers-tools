// Makers tools: an MCP server that Super Agents, Brain and Autopilot agents call by name. MCP over streamable HTTP
// at /mcp; every POST is answered with plain JSON (no event stream). The read tools are in tools.js, the write
// tools in writes.js; the ClickUp reads, dates and capacity in data.js.
//
// Key: `Authorization: Bearer <key>` or `X-API-Key: <key>`; anything else gets 401. Every request is logged with
// its header names, the Accept, MCP-Protocol-Version and User-Agent values, and which of the two headers carried
// the key (never the key itself).
// Every tool result ends with one plain sentence an agent can quote as it stands, the tool's name in brackets.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { TOOLS as READS } from './tools.js';
import { WRITES, internalWrite } from './writes.js';
import { scheduledRun } from './jobs.js';
import { UserError, BusyError } from './data.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'makers-tools', title: 'Makers tools', version: '0.7.0' };
// At most MAX_AT_ONCE calls work at once in one copy of the server, so many calls at once do not run it out of
// memory; the rest wait their turn, checking every fifth of a second. A call that cannot start within TURN_WAIT_MS,
// or that waits too long for a shared ClickUp read, is told the server is busy and to call again, instead of failing.
const MAX_AT_ONCE = 6;
const TURN_WAIT_MS = 25_000;
let working = 0;
async function turn() {
  const started = Date.now();
  while (working >= MAX_AT_ONCE) {
    if (Date.now() - started > TURN_WAIT_MS) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  working += 1;
  return true;
}
const busy = (tool) => ({ content: [{ type: 'text', text: `Makers tools are busy with other calls just now, so there is no answer yet; call again in a minute (${tool.label}).` }], isError: true });
const RENAMED = { plan_request: 'plan_new_work', project_health_inputs: 'forecast_delivery', rewalk_chain: 'test_a_fix' };
const TOOLS = { ...READS, ...WRITES };

// The event service (event-service/worker.js) calls link_client, freeze_baseline, copy_step_fields and
// lift_rework_budget here, so their logic exists once. An RPC entrypoint: only a Worker with a service binding to it
// can call it.
export class Writes extends WorkerEntrypoint {
  async linkClient(args) { return internalWrite('link_client', args, this.env); }
  async freezeBaseline(args) { return internalWrite('freeze_baseline', args, this.env); }
  async copyStepFields(args) { return internalWrite('copy_step_fields', args, this.env); }
  async liftReworkBudget(args) { return internalWrite('lift_rework_budget', args, this.env); }
}

export default {
  // The client figures on the Client cards, Mondays 07:30 London (jobs.js; wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledRun(event, env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const started = Date.now();
    const log = {
      method: request.method, path: url.pathname, headers: [...request.headers.keys()].sort(),
      accept: request.headers.get('accept'), protocol: request.headers.get('mcp-protocol-version'),
      agent: request.headers.get('user-agent'),
    };
    const done = (response, extra = {}) => {
      console.log(JSON.stringify({ ...log, ...extra, status: response.status, ms: Date.now() - started }));
      return response;
    };
    if (url.pathname !== '/mcp') return done(new Response('Not found', { status: 404 }));
    const key = checkKey(request, env);
    log.key = key.how;
    if (!key.ok) {
      const why = key.how === 'refused: server key not set'
        ? 'The key was refused: this server has no key set (the MCP_API_KEY secret).'
        : 'The key was refused. Send the key as "Authorization: Bearer <key>" or "X-API-Key: <key>".';
      return done(new Response(why, { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    }
    if (request.method !== 'POST') {
      return done(new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } }));
    }
    let body;
    try { body = await request.json(); } catch {
      return done(json(rpcError(null, -32700, 'Parse error')), { rpc: 'unparsable' });
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies = [];
    const calls = [];
    for (const m of messages) {
      const reply = await handle(m, env, calls);
      if (reply) replies.push(reply);
    }
    const extra = { rpc: messages.map((m) => m?.method).join(','), calls };
    if (!replies.length) return done(new Response(null, { status: 202 }), extra);
    return done(json(Array.isArray(body) ? replies : replies[0]), extra);
  },
};

// --- the key -----------------------------------------------------------------------------------------------

function checkKey(request, env) {
  if (!env.MCP_API_KEY) return { ok: false, how: 'refused: server key not set' };
  const authz = request.headers.get('authorization');
  const xkey = request.headers.get('x-api-key');
  const bearer = authz && /^Bearer\s+/i.test(authz) ? authz.replace(/^Bearer\s+/i, '').trim() : null;
  if (bearer && same(bearer, env.MCP_API_KEY)) return { ok: true, how: 'authorization-bearer' };
  if (xkey && same(xkey.trim(), env.MCP_API_KEY)) return { ok: true, how: 'x-api-key' };
  // Name the scheme only when it is a known word, so a raw key sent as the header is never logged.
  const scheme = authz ? (/^(Bearer|Basic|Token)\b/i.exec(authz)?.[1] ?? 'other') : 'absent';
  return { ok: false, how: `refused: authorization ${scheme}, x-api-key ${xkey ? 'wrong' : 'absent'}` };
}

function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

// --- MCP ---------------------------------------------------------------------------------------------------

async function handle(m, env, calls) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcError(m?.id ?? null, -32600, 'Invalid request');
  if (m.id === undefined || m.id === null) return null; // a notification, such as notifications/initialized
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return rpcResult(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: "Makers' numbers, worked out the same way every time from the Projects and Clients Lists " +
          'and their time entries. Each result ends with one sentence that can be quoted as it stands.',
      });
    }
    case 'ping':
      return rpcResult(m.id, {});
    case 'tools/list':
      return rpcResult(m.id, { tools: Object.values(TOOLS).map((t) => t.def) });
    case 'tools/call': {
      // Three earlier tool names still answer (not listed), so an agent that still carries one keeps working.
      const tool = TOOLS[m.params?.name] ?? TOOLS[RENAMED[m.params?.name]];
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${m.params?.name}`);
      const started = Date.now();
      const call = { tool: tool.def.name, args: m.params?.arguments ?? {} };
      let out;
      if (!(await turn())) {
        out = busy(tool);
        call.busy = true;
      } else {
        try {
          out = await tool.run(m.params?.arguments ?? {}, env);
        } catch (err) {
          call.error = String(err.message || err).slice(0, 300);
          if (err instanceof BusyError || /HTTP 429/.test(call.error)) {
            out = busy(tool);
            call.busy = true;
          } else {
            const sentence = err instanceof UserError
              ? `${err.message} (${tool.label}).`
              : `Makers tools could not read ClickUp just now, so there is no figure; try again in a minute (${tool.label}).`;
            out = { content: [{ type: 'text', text: sentence }], isError: true };
          }
        } finally {
          working -= 1;
        }
      }
      if (out.structuredContent?.changed) call.changed = out.structuredContent.changed;
      calls.push({ ...call, ms: Date.now() - started, chars: out.content[0].text.length, isError: !!out.isError });
      return rpcResult(m.id, out);
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

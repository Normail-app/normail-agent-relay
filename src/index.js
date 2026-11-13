// Normail agent relay. Runs in the customer's own Cloudflare account, holds the Claude trigger token there, and starts the
// customer's Claude scheduled task when Normail says an agent has work. No dependencies.
//
// POST /  the wake: a body signed by Normail. Verified, then ONE call to the trigger address.
// GET  /  a plain status page (which settings are present, never a value).
// All else: 404 / 405.
//
// Never in any answer or log: the token, the trigger address, Claude's answer body, or anything the caller sent.

const MAX_BODY = 16 * 1024;
const WINDOW_S = 300;
const FIRE_TIMEOUT_MS = 8000;
const TRIGGER_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]{1,128}\/fire$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BETA = 'experimental-cc-routine-2026-04-01';
const VERSION = '2023-06-01';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
const refused = () => json(401, { error: 'unauthorized' });

const present = (v) => typeof v === 'string' && v.trim() !== '';
// A setting as pasted: a trailing space or newline is not part of it.
const setting = (v) => (typeof v === 'string' ? v.trim() : '');

// Constant-time comparison of two strings of equal length (a different length is not secret: the signature has a fixed shape).
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sign(secret, timestamp, bytes) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = enc.encode(`${timestamp}.`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix, 0);
  all.set(bytes, prefix.length);
  return hex(await crypto.subtle.sign('HMAC', key, all));
}

// The body, or null when it is larger than the cap. Stops reading at the cap.
async function readCapped(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* the body is being dropped */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const MAX_BOARDS = 20;

/**
 * The one paragraph sent to the agent, built only from the verified agent id, count and board ids and counts: the same words
 * Normail's own cloud fire uses. Without a boards list (an older notice) it names only the count.
 */
export function noticeText(agentId, count, boards = [], moreBoards = 0) {
  if (!boards.length) {
    return `Normail agent ${agentId} has ${count} ${count === 1 ? 'event' : 'events'} waiting. Call next_events on the Normail server until it returns nothing.`;
  }
  const named = boards.map((b) => `board ${b.board_id} (${b.count} waiting)`).join(', ');
  const more = moreBoards > 0 ? ` and ${moreBoards} more boards` : '';
  return `Normail agent ${agentId} has events waiting on ${named}${more}. Call next_events on the Normail server for each board listed.`;
}

// The boards of a verified notice, or null when the list is not exactly ids and numbers.
function boardsOf(body) {
  if (body.boards === undefined) return { boards: [], more: 0 };
  if (!Array.isArray(body.boards) || body.boards.length > MAX_BOARDS) return null;
  const more = body.more_boards === undefined ? 0 : body.more_boards;
  if (!Number.isInteger(more) || more < 0 || more > 1000000) return null;
  const boards = [];
  for (const b of body.boards) {
    if (!b || typeof b.board_id !== 'string' || !UUID.test(b.board_id) || !Number.isInteger(b.count) || b.count < 1 || b.count > 1000000) return null;
    boards.push({ board_id: b.board_id.toLowerCase(), count: b.count });
  }
  return { boards, more };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function statusPage(origin, env) {
  const row = (label, ok) => `<tr><td>${label}</td><td>${ok ? 'present' : 'missing'}</td></tr>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Normail agent relay</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input{background:#222;color:#eee}}
table{border-collapse:collapse;margin:1rem 0}td{padding:.25rem 1.5rem .25rem 0}
input{width:100%;font:inherit;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem;margin-top:.5rem}
</style></head><body>
<h1>This relay is running</h1>
<table>
${row('Signing secret', present(env.NORMAIL_SIGNING_SECRET))}
${row('Trigger address', present(env.CLAUDE_TRIGGER_URL))}
${row('Trigger token', present(env.CLAUDE_TRIGGER_TOKEN))}
</table>
<p>This relay's address</p>
<input id="addr" readonly value="${esc(origin)}">
<button type="button" id="copy">Copy</button>
<p>Paste this address into Normail</p>
<script>
document.getElementById('copy').addEventListener('click',function(){var b=this,i=document.getElementById('addr');i.select();
(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).then(function(){b.textContent='Copied'},function(){document.execCommand('copy');b.textContent='Copied'})});
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * @param request a Request
 * @param env     { NORMAIL_SIGNING_SECRET, CLAUDE_TRIGGER_URL, CLAUDE_TRIGGER_TOKEN }
 * @param deps    { fetch, now (ms), timeoutMs } for tests
 */
export async function handle(request, env, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const timeoutMs = deps.timeoutMs || FIRE_TIMEOUT_MS;
  const url = new URL(request.url);

  if (url.pathname !== '/') return json(404, { error: 'not_found' });
  if (request.method === 'GET') return statusPage(url.origin, env || {});
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });

  const signingSecret = setting(env && env.NORMAIL_SIGNING_SECRET);
  if (!signingSecret) return json(500, { error: 'relay_secret_missing' });

  // 1. Who sent it: timestamp, signature and size, all before anything else is believed.
  const timestamp = request.headers.get('x-normail-timestamp');
  const signature = request.headers.get('x-normail-signature');
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return refused();
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > WINDOW_S) return refused();
  const bytes = await readCapped(request);
  if (!bytes) return refused();
  const expected = await sign(signingSecret, timestamp, bytes);
  if (!sameText(expected, signature.slice(7).toLowerCase())) return refused();

  // 2. What it says: only an id and a count are used.
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
  if (!body || body.event !== 'agent.events.pending' || typeof body.agent_id !== 'string' || !UUID.test(body.agent_id)
    || !Number.isInteger(body.count) || body.count < 1 || body.count > 1000000) {
    return json(400, { error: 'bad_request' });
  }
  const listed = boardsOf(body);
  if (!listed) return json(400, { error: 'bad_request' });

  // 3. Where it goes: only a Claude task trigger, and only if all of it is set.
  const triggerUrl = setting(env.CLAUDE_TRIGGER_URL);
  const triggerToken = setting(env.CLAUDE_TRIGGER_TOKEN);
  if (!TRIGGER_URL.test(triggerUrl) || !triggerToken) {
    return json(500, { error: 'relay_not_configured' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(triggerUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${triggerToken}`,
        'anthropic-version': VERSION,
        'anthropic-beta': BETA,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: noticeText(body.agent_id.toLowerCase(), body.count, listed.boards, listed.more) }),
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // The request left and nothing came back: a session may exist. Answer success so Normail does not send it again.
    return json(200, { fired: 'unknown' });
  } finally {
    clearTimeout(timer);
  }
  try { await res.body?.cancel(); } catch { /* the answer is not used */ }

  if (res.status >= 200 && res.status < 300) return json(200, { fired: true });
  const after = res.headers.get('retry-after');
  return json(502, { fired: false, anthropic_status: res.status }, after && /^\d{1,6}$/.test(after.trim()) ? { 'retry-after': after.trim() } : {});
}

export default { fetch: (request, env) => handle(request, env) };

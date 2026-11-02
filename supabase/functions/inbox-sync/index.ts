// Marsa (مرسى) — G6b unified inbox Edge Function (docs/online/G6B_SPEC.md § Edge Function).
// SOURCE ONLY — NOT DEPLOYED. Until the owner deploys it (and sets a schedule), staging jobs stay `queued`
// («في الانتظار — لم يُشغَّل العامل»).
//
// - Accepts only POST with `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (constant-time comparison).
// - Routes:
//     POST /run                    → msg_schedule + worker.runOnce({limit: 5})
//     POST /webhook/<channel_id>   → MOCK ONLY and only when MARSA_INBOX_ALLOW_MOCK=1: body {messages:[raw]} is normalized
//                                    (adapters.normalizeInbound) and passed to msg_ingest_messages. Live webhook signature
//                                    verification (X-Hub-Signature-256 / provider push) is an open issue: no live route exists.
// - Uses a supabase-js service client for the service RPCs only: msg_schedule, msg_claim_jobs, msg_renew_lease,
//   msg_complete_job, msg_ingest_messages, msg_mock_load, msg_mock_save.
// - adapterFor(channel): `mock` → the DB-backed fake mailbox / WhatsApp number (msg_mock_mailboxes), ONLY when
//   MARSA_INBOX_ALLOW_MOCK=1; `live_pending` → createLiveEmailAdapter / createLiveWhatsAppAdapter, which throw
//   `not_configured` (no network).
// - AI: the deterministic rule provider (ai-mock.js). No LLM is called; settings.ai_provider='llm_pending' makes the
//   worker use createLlmProvider(), which throws not_configured.
// - No credential is read anywhere in G6b. A future live credential would be read here, server side only, from
//   Supabase Vault (`vault.secrets`: msg_email_credential:<channel_id>, msg_whatsapp_token:<channel_id>,
//   msg_webhook_secret:<channel_id>) — never from a table readable by staff or clients.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './adapters.js';
import './mock-email.js';
import './mock-whatsapp.js';
import './ai-mock.js';
import './pipeline.js';
import './worker.js';

// deno-lint-ignore no-explicit-any
const M: any = (globalThis as any).MarsaInbox;

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i % (ea.length || 1)] ?? 0) ^ (eb[i % (eb.length || 1)] ?? 0);
  return diff === 0 && ea.length > 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!serviceKey || !url || !constantTimeEqual(bearer, serviceKey)) return json({ error: 'unauthorized' }, 401);
  if (!M || typeof M.createWorker !== 'function' || typeof M.createRuleProvider !== 'function') return json({ error: 'worker_not_loaded' }, 500);

  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };
  const allowMock = Deno.env.get('MARSA_INBOX_ALLOW_MOCK') === '1';
  const route = new URL(req.url).pathname.replace(/^\/inbox-sync/, '').replace(/\/+$/, '') || '/run';

  /* ---------------------------------------------------------------- webhook (mock only) */
  if (route.startsWith('/webhook/')) {
    const channelId = route.slice('/webhook/'.length);
    if (!UUID_RE.test(channelId)) return json({ error: 'bad_channel' }, 400);
    if (!allowMock) return json({ error: 'not_configured', message: 'live webhooks are not configured in G6b (mock only)' }, 501);
    // deno-lint-ignore no-explicit-any
    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const kind = body?.kind === 'whatsapp' ? 'whatsapp' : 'email';
    const raws = Array.isArray(body?.messages) ? body.messages.slice(0, 50) : [];
    try {
      // deno-lint-ignore no-explicit-any
      const messages = raws.map((r: any) => M.normalizeInbound(r, { kind }));
      const r = await rpc('msg_ingest_messages', { p_channel: channelId, p_messages: messages });
      return json({ ingested: r });
    } catch (e) {
      return json({ error: 'ingest_failed', message: M.scrubText(String((e as Error).message ?? e)).slice(0, 300) }, 422);
    }
  }
  if (route !== '/run') return json({ error: 'not_found' }, 404);

  /* ---------------------------------------------------------------- worker run */
  const clock = () => new Date().toISOString();
  // deno-lint-ignore no-explicit-any
  const mocks = new Map<string, { adapter: any; version: number }>();
  // deno-lint-ignore no-explicit-any
  const adapterFor = async (channel: any) => {
    if (channel?.mode === 'mock') {
      if (!allowMock) return channel?.kind === 'whatsapp' ? M.createLiveWhatsAppAdapter({}) : M.createLiveEmailAdapter({});   // throws not_configured
      const hit = mocks.get(channel.id);
      if (hit) return hit.adapter;
      const loaded = await rpc('msg_mock_load', { p_channel: channel.id });
      const state = loaded?.state && Object.keys(loaded.state).length ? loaded.state : null;
      const make = channel.kind === 'whatsapp' ? M.createMockWhatsApp : M.createMockEmail;
      const adapter = make({ channelAddress: channel.address_norm, state, clock, deps: M });
      mocks.set(channel.id, { adapter, version: Number(loaded?.version ?? 0) });
      return adapter;
    }
    return channel?.kind === 'whatsapp' ? M.createLiveWhatsAppAdapter({}) : M.createLiveEmailAdapter({});
  };

  // The fake mailbox is saved right after each channel job and BEFORE its completion commits the job's effects
  // (G5 As built 17). A concurrent run that moved it (MRS_BAD_TRANSITION 'mock_version') turns the job into a 'retry'
  // with nothing applied; the cached mock is dropped and reloaded next time.
  const saved: Record<string, string> = {};
  // deno-lint-ignore no-explicit-any
  const beforeComplete = async (ctx: any, result: any) => {
    const chId = ctx?.channel?.id;
    const m = chId ? mocks.get(chId) : undefined;
    if (!m || !['probe', 'poll', 'send', 'status'].includes(ctx?.job?.kind)) return result;
    try {
      const r = await rpc('msg_mock_save', { p_channel: chId, p_state: m.adapter.control.state(), p_version: m.version });
      m.version = Number(r?.version ?? m.version + 1);
      saved[chId] = 'ok';
      return result;
    } catch (e) {
      mocks.delete(chId);
      saved[chId] = String((e as Error).message ?? e).slice(0, 200);
      if (ctx?.job?.kind === 'send') {
        // the mock already recorded the send: the result is unknown, never a blind retry
        return { outcome: 'unknown', calls: result?.calls ?? [], effects: { outbound_id: ctx?.send?.outbound_id },
          error: { kind: 'mock_version', code: 'mock_version', message: 'mock mailbox moved by another run', applied: 'unknown' } };
      }
      return { outcome: 'retry', calls: result?.calls ?? [], effects: {},
        error: { kind: 'mock_version', code: 'mock_version', message: 'mock mailbox moved by another run: nothing applied', applied: 'no' } };
    }
  };

  const worker = M.createWorker({ rpc, adapterFor, beforeComplete, provider: M.createRuleProvider({ clock }), deps: M, clock,
    workerId: `edge:${crypto.randomUUID().slice(0, 8)}` });

  try {
    const scheduled = await rpc('msg_schedule', { p_limit: 50 });
    const counts = await worker.runOnce({ limit: 5 });
    delete counts.results;
    const failedSaves = Object.values(saved).filter((v) => v !== 'ok').length;
    return json({ scheduled, counts, mock_saved: saved }, failedSaves > 0 ? 207 : 200);
  } catch (e) {
    return json({ error: 'worker_failed', message: M.scrubText(String((e as Error).message ?? e)).slice(0, 300) }, 500);
  }
});

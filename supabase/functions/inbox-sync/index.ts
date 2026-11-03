// Marsa (مرسى) — G6b unified inbox Edge Function (docs/online/G6B_SPEC.md § Edge Function).
// SOURCE ONLY — NOT DEPLOYED. Until the owner deploys it (and sets a schedule), staging jobs stay `queued`
// («في الانتظار — لم يُشغَّل العامل»).
//
// - Accepts only POST with `Authorization: Bearer <service_role key>`: the injected SUPABASE_SERVICE_ROLE_KEY (constant-time),
//   or a legacy service_role JWT of this project, then used as the DB key so PostgREST verifies it (serviceToken).
// - Routes:
//     POST /run                    → msg_schedule + worker.runOnce({limit: 1}) in a loop: at most 5 jobs and no new job
//                                    after 80 s (G6c review C3: 2 s CPU / 150 s wall clock per request)
//     POST /webhook/<channel_id>   → MOCK ONLY and only when MARSA_INBOX_ALLOW_MOCK=1: body {messages:[raw]} is normalized
//                                    (adapters.normalizeInbound) and passed to msg_ingest_messages. Live webhook signature
//                                    verification (X-Hub-Signature-256 / provider push) is an open issue: no live route exists.
// - Uses a supabase-js service client for the service RPCs only: msg_schedule, msg_claim_jobs, msg_renew_lease,
//   msg_complete_job, msg_ingest_messages, msg_mock_load, msg_mock_save.
// - adapterFor(channel): `mock` → the DB-backed fake mailbox / WhatsApp number (msg_mock_mailboxes), ONLY when
//   MARSA_INBOX_ALLOW_MOCK=1; `live_pending` → createLiveEmailAdapter / createLiveWhatsAppAdapter, which throw
//   `not_configured` (no network). G6c: `live` + e-mail → the IMAP 993 / SMTP 465 adapter (email-live.js over
//   denoConnect = Deno.connectTls) ONLY for the one channel id in MARSA_EMAIL_LIVE_CHANNEL whose address_norm equals
//   MARSA_EMAIL_FROM_ADDRESS, with both logins present and ports exactly 993 / 465; any other `live` channel gets the stub.
// - AI: the deterministic rule provider (ai-mock.js). No LLM is called; settings.ai_provider='llm_pending' makes the
//   worker use createLlmProvider(), which throws not_configured.
// - G6c live e-mail secrets (owner-entered Edge Function secrets, read here only, never logged, never returned, never
//   passed to the worker or SQL): MARSA_EMAIL_IMAP_USER / _PASSWORD, MARSA_EMAIL_SMTP_USER / _PASSWORD. Other env:
//   MARSA_EMAIL_LIVE_CHANNEL, MARSA_EMAIL_FROM_ADDRESS (the channel alias = From), MARSA_EMAIL_FROM_NAME,
//   MARSA_EMAIL_IMAP_HOST / _PORT, MARSA_EMAIL_SMTP_HOST / _PORT, MARSA_EMAIL_IMAP_SENT_FOLDER, MARSA_EMAIL_MSGID_DOMAIN,
//   MARSA_EMAIL_AUTHSERV_ID, MARSA_EMAIL_DSN_DKIM_DOMAIN (the provider's DKIM signing domain for bounces: without it and
//   the authserv-id no DSN is trusted), MARSA_EMAIL_POLL_BATCH, MARSA_EMAIL_APPEND_SENT, MARSA_EMAIL_FAULT (honoured only
//   when MARSA_ENV=staging). Per-channel credentials in Supabase Vault (msg_email_credential:<channel_id>,
//   msg_whatsapp_token:<channel_id>, msg_webhook_secret:<channel_id>) are phase 2 — never in a table readable by staff
//   or clients.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './adapters.js';
import './mock-email.js';
import './mock-whatsapp.js';
import './ai-mock.js';
import './pipeline.js';
import './worker.js';
import './email-mime.js';
import './email-live.js';

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

// The key the caller (pg_cron via Vault) presents. Accepted when it equals the injected SUPABASE_SERVICE_ROLE_KEY, or
// when it is a legacy JWT whose claims say role = service_role for THIS project: on projects that moved to the new API
// keys the injected legacy variable can differ from the dashboard's legacy key (seen on staging 2026-11-03). The token is
// then used as the database key itself, so PostgREST verifies its signature on the first RPC: a forged token reaches
// nothing (every RPC this function calls is granted to service_role only).
function serviceToken(bearer: string, url: string): string | null {
  const injected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (injected && constantTimeEqual(bearer, injected)) return injected;
  const parts = bearer.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')), c => c.charCodeAt(0))));
    const ref = new URL(url).hostname.split('.')[0];
    return claims && claims.role === 'service_role' && claims.ref === ref ? bearer : null;
  } catch (_) { return null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------- G6c live e-mail */
const LIVE_IMAP_PORT = 993;                 // implicit TLS only; 587 / STARTTLS is blocked on Supabase and refused here
const LIVE_SMTP_PORT = 465;
const LIVE_DEADLINE_MS = 45000;             // the adapter's own per-method deadline (it refuses DATA with < 15 s left)
const CALL_TIMEOUT_MS = 55000;              // the worker's timer: above the adapter deadline, so the adapter decides `applied`
// no new job after this: a job started at the edge still ends (worker timer + claim / lease / complete RPCs) inside the
// 150 s wall clock (review C3, correctness review L10: 150 − 55 − 15 = 80 s)
const RUN_BUDGET_MS = 150000 - CALL_TIMEOUT_MS - 15000;
const RUN_MAX_JOBS = 5;

type Sock = { read(): Promise<Uint8Array | null>; write(b: Uint8Array): Promise<void>; close(): void };

// connect(host, port, {timeoutMs}) for email-live.js: Deno.connectTls with a connect timeout and an idle timeout per
// read / write (the socket is closed on expiry). Errors carry fixed messages only (never host replies or payloads).
function denoConnect(host: string, port: number, opts?: { timeoutMs?: number }): Promise<Sock> {
  const connectMs = Math.max(1, Math.min(60000, Number(opts?.timeoutMs) || 10000));
  const ioMs = 60000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('tls connect timeout')); }, connectMs);
    Deno.connectTls({ hostname: host, port }).then((conn) => {
      clearTimeout(timer);
      if (settled) { try { conn.close(); } catch { /* already closed */ } return; }
      settled = true;
      let closed = false;
      const close = () => { if (!closed) { closed = true; try { conn.close(); } catch { /* already closed */ } } };
      const idle = <T>(p: Promise<T>, what: string): Promise<T> => {
        let t: number | undefined;
        const to = new Promise<T>((_, rej) => { t = setTimeout(() => { close(); rej(new Error(what + ' idle timeout')); }, ioMs); });
        return Promise.race([p, to]).finally(() => clearTimeout(t));
      };
      const buf = new Uint8Array(65536);
      resolve({
        read: async () => {
          if (closed) return null;
          try {
            const n = await idle(conn.read(buf), 'tls read');
            return n === null ? null : buf.slice(0, n);
          } catch { close(); return null; }
        },
        write: async (b: Uint8Array) => {
          if (closed) throw new Error('tls socket closed');
          let off = 0;
          try {
            while (off < b.length) off += await idle(conn.write(b.subarray(off)), 'tls write');
          } catch { close(); throw new Error('tls write failed'); }
        },
        close,
      });
    }).catch(() => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error('tls connect failed')); } });
  });
}

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const portOf = (k: string, d: number) => { const v = env(k); return v === '' ? d : (/^\d{1,5}$/.test(v) ? Number(v) : -1); };
const intEnv = (k: string, d: number, lo: number, hi: number) => { const n = Number(env(k)); return Number.isInteger(n) && n >= lo && n <= hi && env(k) !== '' ? n : d; };

// the live adapter for this channel, or a refusal reason (a fixed code: no secret, no host reply)
// deno-lint-ignore no-explicit-any
function liveEmailFor(channel: any): { adapter?: any; refused?: string } {
  const liveId = env('MARSA_EMAIL_LIVE_CHANNEL').toLowerCase();
  if (!liveId || !UUID_RE.test(liveId)) return { refused: 'no_live_channel' };
  if (String(channel?.id ?? '').toLowerCase() !== liveId) return { refused: 'not_the_live_channel' };
  const fromAddress = env('MARSA_EMAIL_FROM_ADDRESS').toLowerCase();
  if (!fromAddress || fromAddress !== String(channel?.address_norm ?? '').toLowerCase()) return { refused: 'from_address_mismatch' };
  const imap = { host: env('MARSA_EMAIL_IMAP_HOST'), port: portOf('MARSA_EMAIL_IMAP_PORT', LIVE_IMAP_PORT),
    user: env('MARSA_EMAIL_IMAP_USER'), password: Deno.env.get('MARSA_EMAIL_IMAP_PASSWORD') ?? '',
    sentFolder: env('MARSA_EMAIL_IMAP_SENT_FOLDER') || undefined };
  const smtp = { host: env('MARSA_EMAIL_SMTP_HOST'), port: portOf('MARSA_EMAIL_SMTP_PORT', LIVE_SMTP_PORT),
    user: env('MARSA_EMAIL_SMTP_USER'), password: Deno.env.get('MARSA_EMAIL_SMTP_PASSWORD') ?? '' };
  if (!imap.host || !imap.user || !imap.password || !smtp.host || !smtp.user || !smtp.password) return { refused: 'credentials_missing' };
  if (imap.port !== LIVE_IMAP_PORT) return { refused: 'imap_port' };
  if (smtp.port !== LIVE_SMTP_PORT) return { refused: 'smtp_port' };
  if (typeof M.createImapSmtpEmail !== 'function' || typeof M.parseMessage !== 'function') return { refused: 'adapter_not_loaded' };
  const staging = env('MARSA_ENV') === 'staging';
  const adapter = M.createLiveEmailAdapter({
    impl: M.createImapSmtpEmail, deps: M, connect: denoConnect, imap, smtp, fromAddress,
    fromName: env('MARSA_EMAIL_FROM_NAME') || undefined, msgidDomain: env('MARSA_EMAIL_MSGID_DOMAIN').toLowerCase() || undefined,
    authservId: env('MARSA_EMAIL_AUTHSERV_ID') || null, dsnDkimDomain: env('MARSA_EMAIL_DSN_DKIM_DOMAIN').toLowerCase() || null,
    batch: intEnv('MARSA_EMAIL_POLL_BATCH', 10, 1, 50),
    appendSent: env('MARSA_EMAIL_APPEND_SENT') !== '0', deadlineMs: LIVE_DEADLINE_MS, timeouts: { connect: 10000, cmd: 20000 },
    fault: staging && env('MARSA_EMAIL_FAULT') === 'drop_after_dot' ? 'drop_after_dot' : undefined,
    clock: () => new Date(),
  });
  return { adapter };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const serviceKey = url ? serviceToken(bearer, url) : null;
  if (!serviceKey) return json({ error: 'unauthorized' }, 401);
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
  const liveRefused: Record<string, string> = {};   // channel id → fixed refusal code (the job then fails not_configured)
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
    if (channel?.mode === 'live' && channel?.kind === 'email') {
      const live = liveEmailFor(channel);
      if (live.adapter) return live.adapter;
      liveRefused[String(channel?.id ?? '').slice(0, 36)] = live.refused ?? 'refused';
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
    callTimeoutMs: CALL_TIMEOUT_MS, workerId: `edge:${crypto.randomUUID().slice(0, 8)}` });

  try {
    const t0 = Date.now();
    const scheduled = await rpc('msg_schedule', { p_limit: 50 });
    // one job per claim, so a job is never claimed (lease running) while it cannot start before the budget ends
    const counts: Record<string, number> = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, errors: 0 };
    for (let i = 0; i < RUN_MAX_JOBS && Date.now() - t0 < RUN_BUDGET_MS; i++) {
      const c = await worker.runOnce({ limit: 1 });
      delete c.results;
      for (const k of Object.keys(c)) counts[k] = (counts[k] ?? 0) + (Number(c[k]) || 0);
      if (!c.claimed) break;
    }
    const failedSaves = Object.values(saved).filter((v) => v !== 'ok').length;
    const out: Record<string, unknown> = { scheduled, counts, mock_saved: saved };
    if (Object.keys(liveRefused).length) out.live_refused = liveRefused;
    return json(out, failedSaves > 0 ? 207 : 200);
  } catch (e) {
    return json({ error: 'worker_failed', message: M.scrubText(String((e as Error).message ?? e)).slice(0, 300) }, 500);
  }
});

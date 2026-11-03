// Marsa (مرسى) — G5 Daftra sync Edge Function (docs/online/G5_SPEC.md § index.ts; G5b live: docs/online/G5B_DAFTRA_LIVE_AR.md).
// SOURCE ONLY — NOT DEPLOYED. Until the owner deploys it (and sets a schedule), staging jobs stay `queued`.
//
// - Accepts only POST with `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (constant-time comparison).
// - Uses a supabase-js service client (SUPABASE_URL + service key from the function env) for the service RPCs only:
//   daftra_schedule_pulls, daftra_claim_jobs, daftra_renew_lease (write fencing), daftra_complete_job,
//   daftra_mock_load, daftra_mock_save (per job, before its completion).
// - adapterFor(connection): `mock` → the DB-backed fake account (daftra_mock_accounts), ONLY when
//   MARSA_DAFTRA_ALLOW_MOCK=1; `live_pending` → createRealAdapter, which throws `not_configured` (no network).
//   G5b: `live` → the real Daftra API v2 adapter (daftra-live.js over fetchHttp below) ONLY for the one org id in
//   MARSA_DAFTRA_LIVE_ORG whose connection subdomain equals MARSA_DAFTRA_SUBDOMAIN, with an API key present; any other
//   `live` connection gets the not_configured stub (refusal code in the response, no secret).
// - G5b secrets (owner-entered Edge Function secrets, read here only, never logged, never returned, never passed to the
//   worker or SQL): MARSA_DAFTRA_API_KEY — the Daftra API key. FALLBACK: the owner first stored the key as a secret
//   named "Marsa"; it is read ONLY when MARSA_DAFTRA_API_KEY is empty (rename it to MARSA_DAFTRA_API_KEY, then delete
//   "Marsa"). Other env: MARSA_DAFTRA_SUBDOMAIN (^[a-z0-9-]{1,63}$ → https://<sub>.daftra.com/api2),
//   MARSA_DAFTRA_LIVE_ORG (the one org UUID), MARSA_DAFTRA_TAX_MAP (optional JSON {"15": <tax id>, "0": 0}).
// - Marsa only creates / updates DRAFTS: daftra-live.js refuses every path outside its allowlist, update_draft (issuing)
//   and any invoice write with draft !== 1. Probe jobs are read-only.
// - Run budget (2 s CPU / 150 s wall clock per request): one job per claim, at most 5 jobs, no new job after 80 s, and a
//   hard run deadline (start + 130 s) passed to the live adapter: no Daftra write starts unless it can finish (write
//   timeout + 5 s) before it, no read after it — a job is never killed with a write in flight.
// - Intended trigger: a Supabase scheduled function every minute (pg_cron + pg_net, docs/online/G5B_DAFTRA_LIVE_AR.md).

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './adapter.js';
import './mock-adapter.js';
import './worker.js';
import './daftra-live.js';

// deno-lint-ignore no-explicit-any
const D: any = (globalThis as any).MarsaDaftra;

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
const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;

/* ---------------------------------------------------------------- G5b live Daftra */
const LIVE_DEADLINE_MS = 45000;             // the adapter's own per-method deadline (it never starts a write it cannot wait for)
const CALL_TIMEOUT_MS = 55000;              // the worker's timer: above the adapter deadline, so the adapter decides `applied`
const RUN_BUDGET_MS = 150000 - CALL_TIMEOUT_MS - 15000;
const RUN_MAX_JOBS = 5;
const RUN_HARD_DEADLINE_MS = 130000;        // from the request start; the platform kills the function at 150 s

type HttpReq = { method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs: number };
type HttpRes = { status: number; headers: Record<string, string>; text: string };

// http(req) for daftra-live.js: fetch with an AbortSignal timeout, no redirects followed. Errors carry fixed messages
// only (never the URL, headers or body: the API key travels in a header).
async function fetchHttp(req: HttpReq): Promise<HttpRes> {
  const fail = (timeout: boolean) => {
    const e = new Error(timeout ? 'daftra request timed out' : 'daftra request failed');
    e.name = timeout ? 'TimeoutError' : 'NetworkError';
    return e;
  };
  const isTimeout = (e: unknown) => ['TimeoutError', 'AbortError'].includes(String((e as Error)?.name ?? ''));
  const signal = AbortSignal.timeout(Math.max(1, Math.min(60000, Number(req.timeoutMs) || 15000)));
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal });
  } catch (e) { throw fail(isTimeout(e)); }
  let text = '';
  try { text = await res.text(); } catch (e) { throw fail(isTimeout(e)); }
  return { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' }, text };
}

const env = (k: string) => (Deno.env.get(k) ?? '').trim();

// the live adapter for this org, or a refusal reason (a fixed code: no secret, no Daftra reply)
// deno-lint-ignore no-explicit-any
function liveDaftraFor(connection: any, orgId: string, runDeadline: number): { adapter?: any; refused?: string } {
  const liveOrg = env('MARSA_DAFTRA_LIVE_ORG').toLowerCase();
  if (!liveOrg || !UUID_RE.test(liveOrg)) return { refused: 'no_live_org' };
  if (String(orgId ?? '').toLowerCase() !== liveOrg) return { refused: 'not_the_live_org' };
  const sub = env('MARSA_DAFTRA_SUBDOMAIN').toLowerCase();
  if (!SUBDOMAIN_RE.test(sub)) return { refused: 'subdomain_invalid' };
  if (String(connection?.subdomain ?? '').toLowerCase() !== sub) return { refused: 'subdomain_mismatch' };
  // MARSA_DAFTRA_API_KEY first; the legacy secret "Marsa" only when the first is empty
  const apiKey = env('MARSA_DAFTRA_API_KEY') || env('Marsa');
  if (!apiKey) return { refused: 'key_missing' };
  let taxMap: Record<string, unknown> | undefined;
  const tm = env('MARSA_DAFTRA_TAX_MAP');
  if (tm) {
    try {
      const v = JSON.parse(tm);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { refused: 'tax_map_invalid' };
      taxMap = v;
    } catch { return { refused: 'tax_map_invalid' }; }
  }
  if (typeof D.createDaftraLive !== 'function') return { refused: 'adapter_not_loaded' };
  const adapter = D.createRealAdapter({
    impl: D.createDaftraLive, deps: D, http: fetchHttp, apiKey, baseUrl: `https://${sub}.daftra.com/api2`, taxMap,
    deadlineMs: LIVE_DEADLINE_MS, runDeadline, timeouts: { read: 15000, write: 25000 }, clock: () => new Date().toISOString(),
  });
  return { adapter };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const runStart = Date.now();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!serviceKey || !url || !constantTimeEqual(token, serviceKey)) return json({ error: 'unauthorized' }, 401);
  if (!D || typeof D.createWorker !== 'function') return json({ error: 'worker_not_loaded' }, 500);

  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  };

  const allowMock = Deno.env.get('MARSA_DAFTRA_ALLOW_MOCK') === '1';
  // deno-lint-ignore no-explicit-any
  const mocks = new Map<string, { adapter: any; version: number }>();
  // deno-lint-ignore no-explicit-any
  const lives = new Map<string, any>();             // one live adapter per org and run (its tax list is cached)
  const liveRefused: Record<string, string> = {};   // org id → fixed refusal code (the job then fails not_configured)

  // deno-lint-ignore no-explicit-any
  const adapterFor = async (connection: any, orgId: string) => {
    if (connection?.mode === 'mock') {
      if (!allowMock) return D.createRealAdapter({ mode: 'mock_disabled' }); // throws not_configured
      const hit = mocks.get(orgId);
      if (hit) return hit.adapter;
      const loaded = await rpc('daftra_mock_load', { p_org: orgId });
      const adapter = D.createMockAdapter({ orgId, deps: D, state: loaded?.state && Object.keys(loaded.state).length ? loaded.state : null,
        clock: () => new Date().toISOString() });
      mocks.set(orgId, { adapter, version: Number(loaded?.version ?? 0) });
      return adapter;
    }
    if (connection?.mode === 'live') {
      const hit = lives.get(orgId);
      if (hit) return hit;
      const live = liveDaftraFor(connection, orgId, runStart + RUN_HARD_DEADLINE_MS);
      if (live.adapter) { lives.set(orgId, live.adapter); return live.adapter; }
      liveRefused[String(orgId ?? '').slice(0, 36)] = live.refused ?? 'refused';
    }
    // live_pending, a refused live connection (or anything else): the documented stub, every method throws not_configured
    return D.createRealAdapter({ subdomain: connection?.subdomain ?? null });
  };

  // The fake account is saved right after each job and BEFORE its completion commits the job's effects, so the DB never
  // points at mock objects the persisted account lacks. A concurrent invocation that moved the account (optimistic
  // version check: MRS_BAD_TRANSITION 'mock_version') turns the job into a 'retry' with nothing applied; the cached
  // account is dropped and reloaded on the next run. Overlapping invocations are therefore safe, only slower.
  const saved: Record<string, string> = {};
  // deno-lint-ignore no-explicit-any
  const beforeComplete = async (ctx: any, result: any) => {
    const orgId = ctx?.job?.org_id;
    const m = orgId ? mocks.get(orgId) : undefined;
    if (!m) return result;
    try {
      const r = await rpc('daftra_mock_save', { p_org: orgId, p_state: m.adapter.control.state(), p_version: m.version });
      m.version = Number(r?.version ?? m.version + 1);
      saved[orgId] = 'ok';
      return result;
    } catch (e) {
      mocks.delete(orgId);
      saved[orgId] = String((e as Error).message ?? e).slice(0, 200);
      return { outcome: 'retry', calls: result?.calls ?? [], effects: {},
        error: { kind: 'mock_version', code: 'mock_version', message: 'mock account moved by another run: nothing applied', http_status: null } };
    }
  };

  const worker = D.createWorker({ rpc, adapterFor, beforeComplete, workerId: `edge:${crypto.randomUUID().slice(0, 8)}`, deps: D,
    callTimeoutMs: CALL_TIMEOUT_MS, clock: () => new Date().toISOString() });

  try {
    const t0 = runStart;
    const scheduled = await rpc('daftra_schedule_pulls', { p_limit: 50 });
    // one job per claim, so a job is never claimed (lease running) while it cannot start before the budget ends
    const counts: Record<string, number> = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, frozen: 0, errors: 0 };
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
    return json({ error: 'worker_failed', message: D.scrubText(String((e as Error).message ?? e)).slice(0, 300) }, 500);
  }
});

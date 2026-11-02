// Marsa (مرسى) — G5 Daftra sync Edge Function (docs/online/G5_SPEC.md § index.ts).
// SOURCE ONLY — NOT DEPLOYED. Until the owner deploys it (and sets a schedule), staging jobs stay `queued`.
//
// - Accepts only POST with `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (constant-time comparison).
// - Uses a supabase-js service client (SUPABASE_URL + service key from the function env) for the service RPCs only:
//   daftra_schedule_pulls, daftra_claim_jobs, daftra_renew_lease (write fencing), daftra_complete_job,
//   daftra_mock_load, daftra_mock_save (per job, before its completion).
// - adapterFor(connection): `mock` → the DB-backed fake account (daftra_mock_accounts), ONLY when
//   MARSA_DAFTRA_ALLOW_MOCK=1; `live_pending` → createRealAdapter, which throws `not_configured` (no network).
// - No Daftra key is read anywhere in G5. A future live key would be read here, server side only, from
//   Supabase Vault (`vault.secrets`, name `daftra_api_key:<org_id>`) or Edge Function secrets — never from a table
//   readable by staff or clients (open issue: secret storage design).
// - Intended trigger: a Supabase scheduled function every minute (not set up).

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './adapter.js';
import './mock-adapter.js';
import './worker.js';

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

Deno.serve(async (req: Request): Promise<Response> => {
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
    // live_pending (or anything else): the documented stub, every method throws not_configured
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
    clock: () => new Date().toISOString() });

  try {
    const scheduled = await rpc('daftra_schedule_pulls', { p_limit: 50 });
    const counts = await worker.runOnce({ limit: 5 });
    const failedSaves = Object.values(saved).filter((v) => v !== 'ok').length;
    delete counts.results;
    return json({ scheduled, counts, mock_saved: saved }, failedSaves > 0 ? 207 : 200);
  } catch (e) {
    return json({ error: 'worker_failed', message: String((e as Error).message ?? e).slice(0, 300) }, 500);
  }
});

/*
  Marsa (مرسى) — G6b inbox worker (docs/online/G6B_SPEC.md § worker.js, Worker / ingest RPC contract). Server-side only.
  Plain classic script (no import / export, no require). Every dependency is passed explicitly as `deps`
  (the merged API of adapters.js + pipeline.js; ai-mock.js provides the rule provider).

  createWorker({ rpc, adapterFor, provider, workerId, clock, deps, beforeComplete, fenceWrites, callTimeoutMs }):
    rpc(name, args)               → Promise<jsonb>   (Deno: supabase-js service client; tests: PGlite as service_role)
    adapterFor(channel, orgId)    → channel adapter (one adapter per channel, built from that channel's row only)
    provider                      → the AI provider (rule mock); settings.ai_provider='llm_pending' → deps.createLlmProvider()
    runOnce({limit})              → {claimed, ok, retry, failed, unknown, conflict, errors, results}
  runJob(ctx, adapter, {deps, provider, clock, beforeWrite, callTimeoutMs}) → p_result for msg_complete_job:
    {outcome, error, calls, effects}

  Binding rules implemented here:
    - the claim context is the ONLY input; effects are typed (SQL re-validates every field) and carry no recipient,
      attachment, approval, owner, setting or link decision;
    - send: request id = provider_request_id (idempotent at the provider); the lease is renewed right before the call;
      a lost response is outcome 'unknown', never retried blindly: previous_status 'unknown' → lookupSend first
      (found → adopt; not found → send again with the SAME request id; lookup unsupported → stays unknown for a human);
    - calls are recorded redacted, bodies / subjects / addresses / file names replaced by {chars, sha256};
    - the worker is given no fetch and calls nothing but rpc() and the adapter.
*/
(function () {
  'use strict';

  const MAX_CALLS = 50;
  const MAX_CALLS_BYTES = 262144;
  const DEFAULT_CALL_TIMEOUT_MS = 60000;
  const CHANNEL_KINDS = ['probe', 'poll', 'send', 'status'];
  const TEXT_KEYS = ['body_text', 'text', 'html', 'body', 'subject', 'extracted_text', 'file_name', 'filename', 'name', 'display_name'];
  const ADDR_KEYS = ['from', 'to', 'cc', 'address', 'address_norm', 'wa_to', 'from_address', 'phone', 'in_reply_to', 'references', 'message_id'];

  class LeaseLost extends Error { constructor(m) { super(m || 'lease lost'); this.lease_lost = true; } }
  class Outcome extends Error {
    constructor(outcome, effects, error) { super(outcome); this.outcome = outcome; this.effects = effects || {}; this.error = error || null; }
  }

  function errJson(A, e) {
    if (!e) return null;
    return { kind: String(e.kind || 'worker').slice(0, 40), code: A.scrubText(String(e.code || e.kind || 'worker')).slice(0, 60),
      message: A.scrubText(String(e.message || e)).slice(0, 500), applied: ['no', 'unknown', 'yes'].includes(e.applied) ? e.applied : 'no' };
  }

  // privacy: text and addresses never reach the attempt log — only their length and hash
  async function digest(A, v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return { chars: A.cpLen(s), sha256: await A.sha256Hex(s) };
  }
  async function safe(A, x, depth) {
    const d = depth || 0;
    if (d > 12) return null;
    if (Array.isArray(x)) { const out = []; for (const v of x.slice(0, 100)) out.push(await safe(A, v, d + 1)); return out; }
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x)) {
        if (x[k] === undefined) continue;
        if ((TEXT_KEYS.includes(k) || ADDR_KEYS.includes(k)) && x[k] !== null) o[k] = await digest(A, x[k]);
        else o[k] = await safe(A, x[k], d + 1);
      }
      return A.redact(o);
    }
    if (typeof x === 'string') return A.redact(x).slice(0, 300);
    return x === undefined ? null : x;
  }
  async function summarizeResponse(A, op, r) {
    if (r === null || r === undefined) return null;
    if (op === 'fetchInbound') {
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      return { messages: msgs.length, provider_message_ids: msgs.slice(0, 50).map(m => String((m && (m.id || m.provider_message_id)) || '').slice(0, 200)), next_cursor: r.next_cursor === undefined ? null : String(r.next_cursor) };
    }
    if (op === 'fetchStatusEvents') return { events: Array.isArray(r.events) ? r.events.length : 0, next_cursor: r.next_cursor === undefined ? null : String(r.next_cursor) };
    return safe(A, r);
  }

  function withTimeout(p, ms, A, op) {
    if (!(ms > 0)) return p;
    let timer = null;
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new A.AdapterError('timeout', op + ' timed out after ' + ms + ' ms',
        { applied: A.WRITE_METHODS.includes(op) ? 'unknown' : 'no' })), ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  function recorder(adapter, A, clock, opts) {
    const o = opts || {};
    const calls = [];
    const rec = {};
    const timeoutMs = o.callTimeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : o.callTimeoutMs;
    for (const op of A.CHANNEL_METHODS) {
      rec[op] = async function (...args) {
        if (A.WRITE_METHODS.includes(op) && typeof o.beforeWrite === 'function') {
          try { await o.beforeWrite(op); }
          catch (e) { throw new LeaseLost(String((e && e.message) || e).slice(0, 300)); }
        }
        const entry = { op, at: clock(), ms: 0, request: await safe(A, args.length === 1 ? args[0] : args), response: null, error: null, applied: 'no' };
        calls.push(entry);
        const t0 = Date.now();
        try {
          if (!adapter || typeof adapter[op] !== 'function') throw new A.AdapterError('not_configured', 'adapter lacks ' + op, { applied: 'no' });
          const r = await withTimeout(Promise.resolve().then(() => adapter[op](...args)), timeoutMs, A, op);
          entry.response = await summarizeResponse(A, op, r === undefined ? null : r);
          entry.applied = A.WRITE_METHODS.includes(op) ? 'yes' : 'no';
          return r;
        } catch (e) {
          entry.error = errJson(A, A.isAdapterError(e) ? e : { kind: 'worker', code: 'exception', message: e && e.message });
          // review fix (G6b-15): a write that failed with a plain exception may have reached the provider → 'unknown', never 'no'
          entry.applied = A.isAdapterError(e) ? (e.applied || 'no') : (A.WRITE_METHODS.includes(op) ? 'unknown' : 'no');
          throw e;
        } finally {
          entry.ms = Math.max(0, Date.now() - t0);
        }
      };
    }
    return { api: rec, calls };
  }

  function boundCalls(calls) {
    let out = calls.slice(0, MAX_CALLS);
    if (calls.length > MAX_CALLS) out[MAX_CALLS - 1] = { op: 'truncated', at: null, ms: 0, request: { dropped: calls.length - MAX_CALLS + 1 }, response: null, error: null, applied: 'no' };
    const size = () => (typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(out)).length : JSON.stringify(out).length * 3);
    if (size() > MAX_CALLS_BYTES) out = out.map(c => Object.assign({}, c, { response: c.response === null ? null : { truncated: true } }));
    if (size() > MAX_CALLS_BYTES) out = out.map(c => Object.assign({}, c, { request: { truncated: true } }));
    return out;
  }

  function mapAdapterError(A, e) {
    if (A.isAdapterError(e)) {
      const error = errJson(A, e);
      if (e.applied === 'unknown' || e.applied === 'yes') return { outcome: 'unknown', error };
      if (A.RETRYABLE_KINDS.includes(e.kind)) return { outcome: 'retry', error };
      if (e.kind === 'conflict') return { outcome: 'conflict', error };
      return { outcome: 'failed', error };                     // validation, not_found, not_configured, window_closed
    }
    return { outcome: 'retry', error: { kind: 'worker', code: 'exception', message: A.scrubText(String((e && e.message) || e)).slice(0, 500), applied: 'no' } };
  }

  /* ================================================================ per-kind algorithms */
  const DELIVERY_STATUSES = ['accepted', 'sent', 'delivered', 'read', 'failed', 'bounced'];
  const okStatus = s => (s === 'delivered' || s === 'read' ? 'delivered' : 'accepted');

  async function probeJob(R, ctx, A) {
    const r = await R.probe();
    const caps = {};
    for (const k of A.CAPABILITY_KEYS) {
      const v = r && r.capabilities && r.capabilities[k];
      caps[k] = { supported: !!(v && v.supported === true), evidence: v && v.evidence != null ? String(v.evidence).slice(0, 300) : null };
    }
    return { outcome: 'ok', effects: { capabilities: caps, account: { address: r && r.account && r.account.address ? String(r.account.address).slice(0, 254) : null } } };
  }

  async function pollJob(R, ctx, A) {
    const ch = ctx.channel || {};
    const r = await R.fetchInbound({ cursor: ch.poll_cursor || null, limit: A.LIMITS.batch });
    const messages = [];
    const skipped = [];
    for (const raw of (r && Array.isArray(r.messages) ? r.messages : []).slice(0, A.LIMITS.batch)) {
      try { messages.push(A.normalizeInbound(raw, { kind: ch.kind })); }
      catch (e) { skipped.push({ provider_message_id: String((raw && raw.id) || '').slice(0, 200), code: (e && e.code) || 'invalid' }); }
    }
    if (skipped.length) R.calls.push({ op: 'normalize', at: null, ms: 0, request: { skipped: skipped.length }, response: { skipped }, error: null, applied: 'no' });
    return { outcome: 'ok', effects: { messages, next_cursor: r && r.next_cursor !== undefined && r.next_cursor !== null ? String(r.next_cursor).slice(0, 200) : (ch.poll_cursor || null) } };
  }

  async function statusJob(R, ctx) {
    const ch = ctx.channel || {};
    const r = await R.fetchStatusEvents({ cursor: ch.status_cursor || null });
    const events = (r && Array.isArray(r.events) ? r.events : []).filter(e => e && DELIVERY_STATUSES.includes(e.status)).slice(0, 100).map(e => {
      const o = { provider_event_id: String(e.provider_event_id || '').slice(0, 200), status: e.status, at: e.at || null };
      if (e.provider_message_id) o.provider_message_id = String(e.provider_message_id).slice(0, 200);
      if (e.provider_request_id) o.provider_request_id = String(e.provider_request_id).slice(0, 200);
      if (e.error_code) o.error_code = String(e.error_code).slice(0, 60);
      return o;
    });
    return { outcome: 'ok', effects: { events, next_cursor: r && r.next_cursor !== undefined && r.next_cursor !== null ? String(r.next_cursor).slice(0, 200) : (ch.status_cursor || null) } };
  }

  async function sendJob(R, ctx, A) {
    const s = ctx.send;
    if (!s || !s.outbound_id || !s.provider_request_id) {
      throw new Outcome('failed', s && s.outbound_id ? { outbound_id: s.outbound_id, applied: 'no' } : {}, { kind: 'validation', code: 'send_context', message: 'no send context', applied: 'no' });
    }
    const base = { outbound_id: s.outbound_id };
    if (ctx.job && ctx.job.previous_status === 'unknown') {
      // reconcile first: never a blind re-send
      let lk;
      try { lk = await R.lookupSend(s.provider_request_id); }
      catch (e) {
        if (e instanceof LeaseLost) throw e;
        const unsupported = A.isAdapterError(e) && e.kind === 'validation' && e.code === 'unsupported';
        throw new Outcome('unknown', base, { kind: unsupported ? 'validation' : ((e && e.kind) || 'worker'), code: unsupported ? 'lookup_unsupported' : 'lookup_failed',
          message: unsupported ? 'the provider cannot look up a send: human resolution required' : 'lookup failed: result still unknown', applied: 'unknown' });
      }
      if (lk && lk.found) {
        return { outcome: 'ok', effects: { outbound_id: s.outbound_id, provider_message_id: String(lk.provider_message_id).slice(0, 200), status: okStatus(lk.status), found_by: 'lookup' } };
      }
      // not found and the adapter proves "not received" → send again with the SAME request id
    }
    const req = {
      request_id: s.provider_request_id, from: s.from, to: s.to || [], cc: s.cc || [], subject: s.subject || '', body_text: s.body_text || '',
      in_reply_to: s.in_reply_to || null, references: s.references || null, attachments: s.attachments || []
    };
    if (s.wa_to) req.wa_to = s.wa_to;
    let r;
    try { r = await R.send(req); }
    catch (e) {
      if (e instanceof LeaseLost) throw e;
      // review fix (G6b-15): only an AdapterError can prove "not applied"; anything else after the call started is unknown
      if (!A.isAdapterError(e)) {
        throw new Outcome('unknown', base, { kind: 'worker', code: 'exception', message: A.scrubText(String((e && e.message) || e)).slice(0, 500), applied: 'unknown' });
      }
      const m = mapAdapterError(A, e);
      if (m.outcome === 'unknown') throw new Outcome('unknown', base, m.error);
      throw new Outcome(m.outcome === 'conflict' ? 'failed' : m.outcome, { outbound_id: s.outbound_id, applied: 'no' }, m.error);
    }
    // review fix: the call returned, so it applied — a malformed result is 'unknown' (reconcile by lookup), never a blind retry
    if (!r || typeof r.provider_message_id !== 'string' || !r.provider_message_id.trim()) {
      throw new Outcome('unknown', base, { kind: 'worker', code: 'bad_send_result', message: 'send returned no provider message id', applied: 'unknown' });
    }
    return { outcome: 'ok', effects: { outbound_id: s.outbound_id, provider_message_id: String(r.provider_message_id).slice(0, 200), status: okStatus(r.status), found_by: 'sent' } };
  }
  // a write the recorder saw applied (or could not tell) — the job result must then be 'unknown'
  const wroteAny = (A, calls) => (calls || []).some(c => c && A.WRITE_METHODS.includes(c.op) && c.applied !== 'no');

  function providerFor(ctx, opts, A) {
    const p = (ctx.settings && ctx.settings.ai_provider) || 'rule_mock';
    if (p !== 'rule_mock') return A.createLlmProvider();         // every method throws not_configured
    if (!opts.provider) throw new A.AdapterError('not_configured', 'no rule provider given', { applied: 'no', code: 'not_configured' });
    return opts.provider;
  }

  function targetOf(ctx) {
    const k = ctx && ctx.job && ctx.job.kind;
    if (k === 'send' && ctx.send && ctx.send.outbound_id) return { outbound_id: ctx.send.outbound_id };
    if (k === 'process' && ctx.message && ctx.message.id) return { message_id: ctx.message.id };
    return {};
  }

  async function runJob(ctx, adapter, opts) {
    const o = opts || {};
    const A = o.deps;
    if (!A || typeof A.normalizeInbound !== 'function' || typeof A.processMessage !== 'function') throw new Error('runJob: deps (adapters + pipeline API) required');
    const clock = typeof o.clock === 'function' ? o.clock : () => new Date().toISOString();
    const R = recorder(adapter, A, clock, { beforeWrite: o.beforeWrite, callTimeoutMs: o.callTimeoutMs });
    const kind = ctx && ctx.job && ctx.job.kind;
    let res;
    try {
      if (kind === 'probe') res = await probeJob(R.api, ctx, A);
      else if (kind === 'poll') res = await pollJob(Object.assign({ calls: R.calls }, R.api), ctx, A);
      else if (kind === 'status') res = await statusJob(R.api, ctx, A);
      else if (kind === 'send') res = await sendJob(R.api, ctx, A);
      else if (kind === 'process') res = { outcome: 'ok', effects: await A.processMessage(ctx, providerFor(ctx, o, A), A) };
      else if (kind === 'draft') res = { outcome: 'ok', effects: await A.buildDraft(ctx, providerFor(ctx, o, A), A) };
      else res = { outcome: 'failed', effects: {}, error: { kind: 'validation', code: 'job_kind', message: 'unknown job kind ' + kind, applied: 'no' } };
    } catch (e) {
      if (e instanceof Outcome) res = { outcome: e.outcome, effects: e.effects || {}, error: e.error };
      else if (e instanceof LeaseLost) {
        const wrote = R.calls.some(c => A.WRITE_METHODS.includes(c.op) && c.applied !== 'no');
        res = { outcome: wrote ? 'unknown' : 'retry', effects: kind === 'send' ? Object.assign(targetOf(ctx), wrote ? {} : { applied: 'no' }) : targetOf(ctx),
          error: { kind: 'lease_lost', code: 'lease_lost', message: 'write not sent: ' + A.scrubText(e.message), applied: wrote ? 'unknown' : 'no' } };
      } else if (wroteAny(A, R.calls)) {
        // review fix (G6b-15): an exception after an applied / unknown write never becomes 'retry, applied:no'
        res = { outcome: 'unknown', effects: targetOf(ctx),
          error: { kind: 'worker', code: 'exception_after_write', message: A.scrubText(String((e && e.message) || e)).slice(0, 500), applied: 'unknown' } };
      } else {
        const m = mapAdapterError(A, e);
        res = { outcome: m.outcome, error: m.error, effects: targetOf(ctx) };
      }
    }
    const out = { outcome: res.outcome, calls: boundCalls(R.calls), effects: res.effects || {} };
    if (res.error) out.error = res.error;
    return out;
  }

  function createWorker(cfg) {
    const c = cfg || {};
    if (typeof c.rpc !== 'function') throw new Error('createWorker: rpc required');
    if (typeof c.adapterFor !== 'function') throw new Error('createWorker: adapterFor required');
    const A = c.deps;
    if (!A || typeof A.normalizeInbound !== 'function' || typeof A.processMessage !== 'function') throw new Error('createWorker: deps (adapters + pipeline API) required');
    const workerId = String(c.workerId || 'inbox-sync').slice(0, 80);
    const clock = typeof c.clock === 'function' ? c.clock : () => new Date().toISOString();

    async function runOnce(o) {
      const limit = Math.max(1, Math.min(20, (o && o.limit) || 5));
      const counts = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, errors: 0, results: [] };
      const ctxs = (await c.rpc('msg_claim_jobs', { p_worker: workerId, p_limit: limit })) || [];
      counts.claimed = ctxs.length;
      for (const ctx of ctxs) {
        let result;
        try {
          const adapter = CHANNEL_KINDS.includes(ctx.job.kind) ? await c.adapterFor(ctx.channel || {}, ctx.job.org_id) : null;
          const beforeWrite = c.fenceWrites === false ? null : () => c.rpc('msg_renew_lease', { p_attempt: ctx.attempt_id });
          result = await runJob(ctx, adapter, { deps: A, provider: c.provider, clock, beforeWrite, callTimeoutMs: c.callTimeoutMs });
        } catch (e) {
          const m = mapAdapterError(A, e);
          result = { outcome: m.outcome, error: m.error, calls: [], effects: targetOf(ctx) };
        }
        if (typeof c.beforeComplete === 'function') {
          try { result = (await c.beforeComplete(ctx, result)) || result; }
          catch (e) {
            const wrote = wroteAny(A, result.calls);
            result = { outcome: wrote ? 'unknown' : 'retry', calls: result.calls || [], effects: targetOf(ctx),
              error: { kind: 'worker', code: 'before_complete', message: String((e && e.message) || e).slice(0, 500), applied: wrote ? 'unknown' : 'no' } };
          }
        }
        try {
          const done = await c.rpc('msg_complete_job', { p_attempt: ctx.attempt_id, p_result: result });
          counts[result.outcome] = (counts[result.outcome] || 0) + 1;
          counts.results.push({ job_id: ctx.job.id, kind: ctx.job.kind, org_id: ctx.job.org_id, outcome: result.outcome, job_status: done && done.job_status, applied: done && done.applied });
        } catch (e) {
          counts.errors++;
          counts.results.push({ job_id: ctx.job.id, kind: ctx.job.kind, org_id: ctx.job.org_id, outcome: result.outcome, complete_error: String((e && e.message) || e).slice(0, 300) });
        }
      }
      return counts;
    }
    return { runOnce, workerId };
  }

  const API = { createWorker, runJob, mapAdapterError };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();

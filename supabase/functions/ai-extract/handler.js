/*
  Marsa (مرسى) — the request path of the ai-extract Edge Function (migration 20261114000100_ai_documents.sql), as a
  plain classic script (no import / export, no require), ES2020, so the Node tests run it with mocked clients.
  index.ts loads it by side-effect import and calls globalThis.MarsaAiExtract.handleRequest(req, deps).

  This file never reads a key or the environment, never calls fetch and never touches Deno / process.env: every client
  is built by index.ts and handed in through `deps`:
    deps.configured        boolean: SUPABASE_URL + anon key + service key present
    deps.isAnonKey(t)      true when the bearer token is the project's anon / publishable key
    deps.userClient(t)     supabase-js client acting as the caller (their access token)
    deps.serviceClient()   supabase-js service client (ai_reserve / ai_settle only)
    deps.modelConfigured   boolean: the Anthropic key is set (the key itself stays in index.ts)
    deps.claudeClient()    an Anthropic SDK client (maxRetries 0, timeout inside the wall clock)
    deps.sdk               the Anthropic class (typed error classes for classifyCallError)
    deps.log(text)         fixed-text log line (never a token, a key, an error message or document content)
    deps.X                 optional: the extract.js API (default globalThis.MarsaAiExtract)
  → {status, headers, body} (body: a JSON string or null); index.ts turns it into a Response.

  Flow: CORS / method → bearer → content-length → auth.getUser → body (read with a byte limit, also when chunked) →
  validateRequest → ai_access (caller's RLS / MFA) → transaction under RLS → key present → ai_reserve (service) →
  [v3 only: dedupe — the file's SHA-256 already read with ai-doc-v3 and saved as a live extraction the caller can see →
  that reading is returned (reused: true), nothing reserved, no Claude call, no charge; also any other live reading of
  the same file (OCR / v2) in the scope a save would collide with (document_extractions_dedupe_uidx: same transaction,
  or unlinked) → returned as itself (its own engine, reused: true), since a new reading could not be saved there] →
  [v3 only: ai_bind_source — the SHA-256 of the bytes sent to Claude bound to the reservation; a v3 reading can only be
  saved under it] → Claude → ai_settle (always, once). Settle status: ok / refused / error with the reported tokens per attempt, or
  'unknown' when the call failed after it may have been billed (timeout, connection lost, 5xx / 529): ai_settle then
  charges the held amount. Errors are fixed codes ({error: '<code>'}); upstream / SDK messages are never echoed.
*/
(function () {
  'use strict';

  const PROD_ORIGIN = 'https://marsacloud.com';
  const DEV_ORIGIN_RE = /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/;
  const MAX_BODY = 7 * 1024 * 1024 + 4096;         // base64 of a 5 MB image (~6.7 MB) …
  const MAX_BODY_PDF = 14 * 1024 * 1024 + 4096;    // … or of a 10 MB PDF (~13.4 MB) + the JSON envelope

  function allowedOrigin(origin) {
    if (!origin) return null;
    return origin === PROD_ORIGIN || DEV_ORIGIN_RE.test(origin) ? origin : null;
  }
  function json(body, status, origin) {
    const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin' };
    if (origin) h['access-control-allow-origin'] = origin;
    return { status, headers: h, body: JSON.stringify(body) };
  }
  const fail = (code, status, origin) => json({ error: code }, status, origin);

  // PostgREST error → the MRS_* code raised by app.fail (message), else null
  function mrs(error) {
    const m = error && typeof error.message === 'string' ? error.message : '';
    return /^MRS_[A-Z_]+$/.test(m) ? m : null;
  }

  // the request body as text, at most `max` bytes; null when larger (the stream is cancelled), throws when unreadable.
  // Counts bytes as they arrive, so a chunked body without content-length cannot be buffered past the limit.
  async function readBody(req, max) {
    const stream = req && req.body;
    if (!stream || typeof stream.getReader !== 'function') return '';
    const reader = stream.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const chunk = r.value;
      n += chunk.byteLength;
      if (n > max) { try { await reader.cancel(); } catch (e) { /* already closed */ } return null; }
      parts.push(chunk);
    }
    const all = new Uint8Array(n);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  }

  // SHA-256 of the decoded base64 file → 64 hex chars (document_extractions.source_sha256 of the same bytes)
  async function sha256Hex(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let out = '';
    for (let i = 0; i < h.length; i++) out += (h[i] < 16 ? '0' : '') + h[i].toString(16);
    return out;
  }
  const DEDUPE_COLS = 'id,org_id,transaction_id,doc_type,engine,ai_usage_id,ai_detail,extracted_fields,line_items,raw_text,' +
    'mean_confidence,review_status,source_sha256,created_at';
  // dedupe-before-call (legacy findExistingDocumentByFingerprint_): a live (not voided) ai-doc-v3 reading of the same bytes
  // that the caller can read under RLS — the requested transaction's first, then an unlinked one, then any (no transaction
  // asked). Otherwise a live reading of any engine (OCR / v2) in the scope the new reading would be saved in (same
  // transaction, or unlinked when none is asked: document_extractions_dedupe_uidx) — a fresh reading could not be saved
  // there, so it is returned instead of charging a call whose result would be thrown away. null when none / the lookup
  // fails (the read then goes ahead normally). v3 rows are trusted: the extraction trigger only accepts a v3 row whose
  // source_sha256 is the hash bound to its usage (ai_bind_source).
  async function findReading(userDb, v, sha, X) {
    try {
      const r = await userDb.from('document_extractions').select(DEDUPE_COLS).eq('org_id', v.org_id).eq('source_sha256', sha)
        .is('voided_at', null).order('created_at', { ascending: false }).limit(20);
      if (!r || r.error || !Array.isArray(r.data)) return null;
      const live = r.data.filter(x => x && x.id);
      const rows = live.filter(x => x.engine === X.ENGINE && x.ai_detail && x.ai_detail.prompt_version === X.PROMPT_VERSION_V3 && x.ai_usage_id);
      const pick = f => rows.find(f) || null;
      const v3 = v.transaction_id
        ? (pick(x => x.transaction_id === v.transaction_id) || pick(x => !x.transaction_id))
        : (pick(x => !x.transaction_id) || pick(() => true));
      if (v3) return v3;
      return live.find(x => (x.transaction_id || null) === (v.transaction_id || null)) || null;
    } catch (e) { return null; }
  }
  // a stored reading → the response body of a fresh read (fields rebuilt from extracted_fields + ai_detail.fields). The
  // engine / prompt version are the row's own: an OCR / v2 reading is never presented as an ai-doc-v3 Claude reading.
  function reusedBody(row, X) {
    const det = row.ai_detail || {};
    const isV3 = row.engine === X.ENGINE && det.prompt_version === X.PROMPT_VERSION_V3;
    const meta = {};
    (Array.isArray(det.fields) ? det.fields : []).forEach(f => { if (f && typeof f.name === 'string') meta[f.name] = f; });
    const ex = row.extracted_fields && typeof row.extracted_fields === 'object' ? row.extracted_fields : {};
    const fields = Object.keys(ex).filter(k => typeof ex[k] === 'string').map(k => ({ name: k, value: ex[k],
      confidence: meta[k] && Number.isFinite(meta[k].confidence) ? meta[k].confidence : 0, page: meta[k] ? meta[k].page || null : null,
      valid: meta[k] ? meta[k].valid !== false : true }));
    return {
      usage_id: row.ai_usage_id || null, engine: row.engine || null, model: row.engine === X.ENGINE ? X.MODEL : null,
      prompt_version: isV3 ? X.PROMPT_VERSION_V3 : (row.engine === X.ENGINE ? X.PROMPT_VERSION : null),
      doc_type: det.doc_type || row.doc_type, detected_type: det.detected_type || row.doc_type, kind: row.doc_type,
      transaction_id: row.transaction_id || null, fields, extracted_fields: ex, line_items: Array.isArray(row.line_items) ? row.line_items : [],
      containers: Array.isArray(det.containers) ? det.containers : [], warnings: Array.isArray(det.warnings) ? det.warnings : [],
      detected_documents: Array.isArray(det.detected_documents) ? det.detected_documents : [det.detected_type || row.doc_type],
      mean_confidence: row.mean_confidence == null ? null : Number(row.mean_confidence), raw_text: row.raw_text || '',
      ai_detail: det, source_sha256: row.source_sha256, reused: true, extraction_id: row.id, review_status: row.review_status,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
    };
  }

  async function handleRequest(req, deps) {
    const d = deps || {};
    const X = d.X || globalThis.MarsaAiExtract;          // extract.js (Deno: globalThis; Node tests: require())
    const log = typeof d.log === 'function' ? d.log : () => {};
    const hdr = name => (req.headers && typeof req.headers.get === 'function' ? req.headers.get(name) : null);
    const rawOrigin = hdr('origin');
    const origin = allowedOrigin(rawOrigin);
    if (rawOrigin && !origin) return fail('origin_not_allowed', 403, null);
    if (req.method === 'OPTIONS') {
      return { status: 204, body: null, headers: {
        'access-control-allow-origin': origin || PROD_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-max-age': '600',
        vary: 'Origin' } };
    }
    if (req.method !== 'POST') return fail('method_not_allowed', 405, origin);
    if (!X || typeof X.validateRequest !== 'function') return fail('internal', 500, origin);
    if (!d.configured) return fail('not_configured', 503, origin);

    const auth = hdr('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || d.isAnonKey(token)) return fail('unauthorized', 401, origin);

    const lenHdr = hdr('content-length');
    const len = lenHdr === null ? NaN : Number(lenHdr);
    if (Number.isFinite(len) && len > MAX_BODY_PDF) return fail('too_large', 413, origin);

    /* -------------------------------------------------------------- who is calling */
    const userDb = d.userClient(token);
    const who = await userDb.auth.getUser(token);
    const user = who && who.data && who.data.user;
    if (!who || who.error || !user || !user.id) return fail('unauthorized', 401, origin);

    /* -------------------------------------------------------------- the request */
    let raw;
    try { raw = await readBody(req, MAX_BODY_PDF); } catch (e) { return fail('bad_request', 400, origin); }
    if (raw === null) return fail('too_large', 413, origin);
    let v;
    try {
      const body = JSON.parse(raw);
      // a non-PDF body above the image envelope is refused before the base64 is decoded
      if (raw.length > MAX_BODY && !(body && body.file && body.file.media_type === 'application/pdf')) throw new X.AiError('too_large', 413);
      v = X.validateRequest(body);
    } catch (e) {
      const isAi = e && e.name === 'AiError';
      return fail(isAi ? e.code : 'bad_request', isAi ? e.status : 400, origin);
    }
    raw = '';

    /* -------------------------------------------------------------- membership, role, MFA, org switch */
    const acc = await userDb.rpc('ai_access', { p_org: v.org_id });
    if (acc.error) {
      const c = mrs(acc.error);
      if (c === 'MRS_MFA_REQUIRED') return fail('mfa_required', 403, origin);
      if (c === 'MRS_FORBIDDEN' || c === 'MRS_AUTH_REQUIRED') return fail('forbidden', 403, origin);
      return fail('internal', 500, origin);
    }
    if (!acc.data || acc.data.can_use !== true) return fail('ai_disabled', 403, origin);
    if (v.transaction_id) {
      const tx = await userDb.from('transactions').select('id').eq('id', v.transaction_id).eq('org_id', v.org_id).maybeSingle();
      if (tx.error || !tx.data) return fail('transaction_not_found', 404, origin);
    }
    /* -------------------------------------------------------------- v3: same file already read → reuse, no charge */
    const v3 = v.prompt_version === X.PROMPT_VERSION_V3;
    let sha = null;
    if (v3) {
      try { sha = await sha256Hex(v.data_b64); } catch (e) { return fail('bad_request', 400, origin); }
      const prior = await findReading(userDb, v, sha, X);
      if (prior) {
        v.data_b64 = '';
        log('ai-extract: reading reused (no charge)');
        return json(reusedBody(prior, X), 200, origin);
      }
    }
    if (!d.modelConfigured) return fail('not_configured', 503, origin);

    /* -------------------------------------------------------------- reserve */
    const svc = d.serviceClient();
    const res = await svc.rpc('ai_reserve', { p_org: v.org_id, p_user: user.id, p_purpose: 'doc_extract',
      p_est_usd: X.estimateHoldUsd(v.media_type, v.bytes, v.pages) });
    if (res.error || typeof res.data !== 'string') {
      const c = mrs(res.error);
      if (c === 'MRS_AI_DISABLED') return fail('ai_disabled', 403, origin);
      if (c === 'MRS_AI_DAILY_CAP') return fail('daily_cap', 429, origin);
      if (c === 'MRS_AI_BUDGET') return fail('budget', 429, origin);
      if (c === 'MRS_FORBIDDEN') return fail('forbidden', 403, origin);
      return fail('internal', 500, origin);
    }
    const reservation = res.data;

    /* -------------------------------------------------------------- v3: bind the file's hash to the reservation */
    if (v3) {
      let bound = null;
      try { bound = await svc.rpc('ai_bind_source', { p_reservation: reservation, p_sha256: sha }); } catch (e) { bound = null; }
      if (!bound || bound.error) {
        // nothing was sent to Claude: settle at no cost
        log('ai-extract: source bind failed');
        try { await svc.rpc('ai_settle', { p_reservation: reservation, p_input_tokens: 0, p_output_tokens: 0, p_status: 'error',
          p_model: X.MODEL, p_attempts: null }); } catch (e) { log('ai-extract: settle failed'); }
        v.data_b64 = '';
        return fail('internal', 500, origin);
      }
    }

    /* -------------------------------------------------------------- Claude */
    // settle defaults to 'unknown' (charge the hold): only a proven outcome lowers it
    let settle = { status: 'unknown', model: X.MODEL, input: 0, output: 0, attempts: null };
    let out = null;
    let errCode = 'upstream_error', errStatus = 502;
    let msg = null;
    try {
      const params = X.buildRequest(v);
      v.data_b64 = '';
      try {
        msg = await X.callClaude(d.claudeClient(), params);
      } catch (e) {
        const c = X.classifyCallError(e, d.sdk);
        errCode = c.code; errStatus = c.status;
        settle = { status: c.settle, model: X.MODEL, input: 0, output: 0, attempts: null };
        log('ai-extract: claude call failed (' + c.code + ', ' + c.settle + ')');
      }
      if (msg) {
        const parsed = X.parseMessage(msg, v.prompt_version);
        settle = { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens, model: parsed.model,
          attempts: parsed.usage.attempts, status: parsed.ok ? 'ok' : (parsed.code === 'refused' ? 'refused' : 'error') };
        if (parsed.ok) {
          try { out = X.postProcess(parsed.data, v.doc_type, v.prompt_version); }
          catch (e) { settle.status = 'error'; errCode = 'internal'; errStatus = 500; log('ai-extract: post-processing failed'); }
        } else if (parsed.code === 'refused') { errCode = 'refused'; errStatus = 422; }
        else if (parsed.code === 'truncated') { errCode = 'truncated'; errStatus = 422; }
        else { errCode = 'bad_output'; errStatus = 502; }
      }
    } catch (e) {
      // building the request failed: nothing was sent
      settle = { status: 'error', model: X.MODEL, input: 0, output: 0, attempts: null };
      errCode = 'internal'; errStatus = 500;
      log('ai-extract: request build failed');
    }

    /* -------------------------------------------------------------- settle (always, once) */
    let st = null;
    try {
      st = await svc.rpc('ai_settle', { p_reservation: reservation, p_input_tokens: settle.input, p_output_tokens: settle.output,
        p_status: settle.status, p_model: settle.model, p_attempts: settle.attempts });
      if (st.error) log('ai-extract: settle failed');
    } catch (e) { log('ai-extract: settle failed'); }
    if (!out) return fail(errCode, errStatus, origin);

    const body = {
      usage_id: reservation, engine: X.ENGINE, model: settle.model, prompt_version: v3 ? X.PROMPT_VERSION_V3 : X.PROMPT_VERSION,
      doc_type: out.doc_type, detected_type: out.detected_type, kind: out.kind, transaction_id: v.transaction_id,
      fields: out.fields, extracted_fields: out.extracted_fields, line_items: out.line_items, warnings: out.warnings,
      mean_confidence: out.mean_confidence, raw_text: out.raw_text,
      usage: { input_tokens: settle.input, output_tokens: settle.output, cost_usd: st && st.data ? st.data.cost_usd : null }
    };
    if (v3) {
      body.containers = out.containers; body.ai_detail = out.ai_detail; body.source_sha256 = sha;
      body.detected_documents = out.detected_documents;
      body.reused = false; body.extraction_id = null;
    }
    return json(body, 200, origin);
  }

  const API = { handleRequest, readBody, allowedOrigin, sha256Hex, MAX_BODY, MAX_BODY_PDF, PROD_ORIGIN };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaAiExtract = Object.assign(globalThis.MarsaAiExtract || {}, API));
})();

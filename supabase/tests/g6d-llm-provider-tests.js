#!/usr/bin/env node
/*
  Marsa (مرسى) — inbox model-backed AI provider (llm-provider.js, settings.ai_provider = 'claude') unit tests. LOCAL TESTS ONLY.
  No DB, no network, no key, no SDK: the model is a MOCKED callModel({system, messages, schema, effort, max_tokens,
  timeout_ms}) → {json, usage, stop_reason, model, fallback_ran}. Any fetch is a failure.

  Covers: the classic-script rules (no fetch / Deno / env / require), createLlmProvider (stub kept; impl + callModel → model
  provider), buildClaudeRequest (claude-opus-5-5, structured output, explicit effort, fallbacks "default" + its beta header,
  no thinking / sampling / prefill), parseClaudeResponse (blocks by type, fallback switch point, stop_reason before content),
  mapModelError → AdapterError kinds (fixed messages, no secret), the output schemas (structured-output subset), every
  provider method (extract / classify / summarize / draftReply / detectInjection / usage) with schema-valid mocked outputs,
  refusal / max_tokens / other stop / schema mismatch → AdapterError validation codes, budget + deadline gates before any
  call, the honesty post-checks (hallucinated references, invented numbers / addresses, quotes, dropped references,
  signature), the injection cases of fixtures/g7-ai-eval-set.json through the provider with an OBEDIENT mocked model, the
  draft request never carrying inbound text, cost (AI_PRICES claude-opus-5-5 $4 / $20 per MTok, per-attempt fallback
  pricing, estimateAiCost / pipeline ai_run / budget gate), and the worker gate (factory + the shared AI ledger
  reserve / settle in every outcome, llm_pending stub). Review fixes: failed jobs settle their spend, the per-job hold
  caps the provider, unknown outcomes charge the hold, SDK pinned + maxRetries 0 + wall-clock deadline in index.ts,
  commitment phrases in a rewrite fall back to the rule draft.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6d-llm-provider-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'inbox-sync');
const SET = JSON.parse(fs.readFileSync(path.join(SUPA, 'tests', 'fixtures', 'g7-ai-eval-set.json'), 'utf8'));

// No network anywhere: any fetch is a test failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g6d-llm-provider-tests'); };

const AD = require(path.join(FN, 'adapters.js'));
const AI = require(path.join(FN, 'ai-mock.js'));
const PL = require(path.join(FN, 'pipeline.js'));
const WK = require(path.join(FN, 'worker.js'));
const LP = require(path.join(FN, 'llm-provider.js'));
const DEPS = Object.assign({}, AD, AI, PL, LP);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.code || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
async function rejects(p, kind, code) {
  try { await p; return 'did not throw'; }
  catch (e) { return (AD.isAdapterError(e) && e.kind === kind && (!code || e.code === code) && e.applied === 'no') || ('wrong error: ' + J(e && (e.toJSON ? e.toJSON() : e.message))); }
}
const J = x => JSON.stringify(x);
const FIXED_CLOCK = () => '2026-11-02T09:00:00.000Z';
const RULE = AI.createRuleProvider({ clock: FIXED_CLOCK });
const slice = (t, s, e) => Array.from(t).slice(s, e).join('');
const SETTINGS = () => ({ ai_provider: 'claude', default_lang: 'ar', ai_monthly_budget_usd: 50, month_to_date_usd: 0 });
// mocked shared AI ledger (index.ts: public.ai_reserve / ai_settle purpose 'inbox')
function ledger(o) {
  const x = o || {};
  const L = { reserves: [], settles: [] };
  L.reserve = async (ctx, est) => { L.reserves.push({ org: ctx.job.org_id, est }); if (x.refuse) throw x.refuse; return 'resv-' + L.reserves.length; };
  L.settle = async (id, status, usage) => { L.settles.push({ id, status, usage, args: LP.ledgerSettleArgs(id, status, usage) }); if (x.settleThrows) throw new Error('db down'); };
  return L;
}

/* ================================================================== mocked model */
const payload = req => { const t = req.messages[0].content[0].text; return JSON.parse(t.slice(t.indexOf('\n') + 1)); };
function kindOf(schema) {
  if (schema === LP.LLM_SCHEMAS.extract) return 'extract';
  if (schema === LP.LLM_SCHEMAS.summarize) return 'summarize';
  if (schema === LP.LLM_SCHEMAS.draft) return 'draft';
  if (schema && schema.properties && schema.properties.category) return 'classify';
  return 'unknown';
}
const ruleItems = text => RULE.extract(text, { source: 'body' }).map(e => ({ kind: e.kind, raw: e.raw, normalized: e.normalized,
  ambiguous: !!(e.detail && e.detail.ambiguous), deadline_phrase: !!(e.detail && e.detail.deadline_phrase), appointment_phrase: !!(e.detail && e.detail.appointment_phrase) }));
// honest model: answers each call from its own payload; `over` replaces the JSON of a kind (object or fn(payload, req))
function model(over) {
  const o = over || {};
  const calls = [];
  const fn = async req => {
    calls.push(req);
    const kind = kindOf(req.schema);
    const p = payload(req);
    let json;
    if (o[kind] !== undefined) json = typeof o[kind] === 'function' ? o[kind](p, req) : o[kind];
    else if (kind === 'extract') json = { items: ruleItems(p.text).concat(o.extraItems || []) };
    else if (kind === 'classify') json = { category: o.category || 'delivery_order', confidence: 0.9, message_contains_instructions: false };
    else if (kind === 'summarize') {
      const refs = p.references.map(r => r.value).join(', ');
      json = { summary_en: 'Request from the sender regarding ' + (refs || 'no reference') + '.', summary_ar: 'طلب من المرسل بخصوص ' + (refs || 'دون مرجع') + '.' };
    } else if (kind === 'draft') {
      json = { subject: p.subject, body_text: (p.lang === 'ar' ? 'تحية طيبة،\n' : 'Good day,\n') + p.body_text };
    }
    if (o.raw) return o.raw(json, req, kind);
    return { json, stop_reason: o.stop_reason || 'end_turn', model: 'claude-opus-5-5', fallback_ran: false,
      usage: { input_tokens: Math.ceil(J(req.messages).length / 4) + 100, output_tokens: 250 } };
  };
  fn.calls = calls;
  return fn;
}
const provider = (callModel, extra) => AD.createLlmProvider(Object.assign({ impl: LP.createModelProvider, callModel, deps: DEPS, clock: FIXED_CLOCK, settings: SETTINGS() }, extra || {}));

/* ================================================================== contexts (as g7-ai-eval.js) */
const CHANNEL_EMAIL = 'inbox@g7eval.example', CHANNEL_WA = '+966500000701';
const DIRECTORY = Object.keys(SET.senders);
const REF = { T1: 'MRS-2026-900001', T2: 'MRS-2026-900002', T3: 'MRS-2026-900003', T4: 'MRS-2026-900004', T5: 'MRS-2026-900005', T6: 'MRS-2026-900006' };
function msgCtx(m, settings) {
  return {
    job: { id: 'j-' + m.id, org_id: 'o', kind: 'process' }, settings: settings || SETTINGS(),
    channel: { id: 'c', kind: m.channel, address_norm: m.channel === 'whatsapp' ? CHANNEL_WA : CHANNEL_EMAIL },
    message: { id: 'm-' + m.id, thread_id: 't', direction: 'inbound', subject: m.subject, body_text: m.body, sent_at: '2026-11-02T08:00:00Z',
      from: { address_norm: String(m.from).toLowerCase(), name: m.from_name || null }, to: [m.channel === 'whatsapp' ? CHANNEL_WA : CHANNEL_EMAIL],
      participants: [], directory_addresses: DIRECTORY, sender: { display_name: 'Gulf Agent Ops', status: 'verified' },
      attachments: (m.attachments || []).map((a, i) => ({ id: 'a-' + m.id + '-' + i, file_name: a.file_name, mime_type: a.mime_type, extracted_text: a.text || null })) }
  };
}
function facts(txKey) {
  const t = SET.transactions[txKey];
  if (!t) return { public: {} };
  return { public: { tx_ref: REF[txKey], operational_status_label: 'قيد التنفيذ' },
    restricted: { bl_number: t.bl, declaration_no: t.decl, container_list: t.c.length ? t.c : null, client_name: 'عميل تجريبي', operation_label: 'استيراد',
      appointment: null, return_deadlines: [], missing_documents: [] } };
}
function draftCtx(m, over) {
  const ok = m.label.sender === 'verified';
  const txKey = m.label.missing.length ? 'T5' : (REF[m.label.match] ? m.label.match : null);
  return Object.assign({ job: { id: 'jd-' + m.id, org_id: 'o', kind: 'draft' }, settings: SETTINGS(),
    draft: { reply_id: null, thread_id: 't-' + m.id, lang: m.draft.lang, template_key: m.draft.template_key, template: null,
      params: { signature: { text_ar: 'فريق التخليص — مرسى', text_en: 'Clearance team — Marsa' } }, category: m.label.category,
      recipient: { address_norm: String(m.from).toLowerCase(), contact_display_name: ok ? 'Counterpart' : null, verified: ok, authorized: ok },
      facts: txKey ? facts(txKey) : { public: {} } } }, over || {});
}
const byId = id => SET.messages.find(m => m.id === id);
const factSet = text => {
  const out = new Set();
  for (const e of RULE.extract(text, { source: 'body' })) if (e.valid) out.add(e.kind + ':' + e.normalized);
  for (const m of AI.foldDigits(text).matchAll(/\d{3,}/g)) out.add('n:' + m[0]);
  for (const m of text.toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)) out.add('e:' + m[0]);
  return out;
};

/* ================================================================== tests */
async function main() {
  section('1. contract: classic script, createLlmProvider, request / response, errors, schemas');

  await check('llm-provider.js: classic script (no import / export / require, no fetch / XHR / WebSocket / Deno / env, no key literal), dual export', () => {
    const src = fs.readFileSync(path.join(FN, 'llm-provider.js'), 'utf8');
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const bad = [];
    if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push('import/require');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|process\.env|ANTHROPIC_API_KEY/.test(s)) bad.push('network/env/key');
    if (/(sk-ant|sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(s)) bad.push('key-like literal');
    if (!/module\.exports = API\) : \(globalThis\.MarsaInbox = Object\.assign\(globalThis\.MarsaInbox \|\| \{\}, API\)\)/.test(src)) bad.push('dual export');
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    if (!/import Anthropic from 'npm:@anthropic-ai\/sdk/.test(ts) || !/import '\.\/llm-provider\.js'/.test(ts)) bad.push('index.ts imports');
    if (!/Deno\.env\.get\('ANTHROPIC_API_KEY'\)/.test(ts) || /console\.(log|error|warn)[^\n]*(key|KEY)/.test(ts) || /\bfetch\s*\(/.test(ts)) bad.push('index.ts key handling');
    if (!/beta\.messages\.create\(params/.test(ts) || !/buildClaudeRequest/.test(ts) || !/parseClaudeResponse/.test(ts)) bad.push('index.ts callModel');
    return bad.length === 0 || bad.join('; ');
  });
  await check('loading all classic scripts in a vm sandbox (no fetch) exposes the model provider on globalThis.MarsaInbox', () => {
    const sandbox = { crypto: globalThis.crypto, TextEncoder, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['adapters.js', 'mock-email.js', 'mock-whatsapp.js', 'ai-mock.js', 'llm-provider.js', 'pipeline.js', 'worker.js']) {
      vm.runInContext(fs.readFileSync(path.join(FN, f), 'utf8'), sandbox, { filename: f });
    }
    const M = sandbox.MarsaInbox;
    const p = M.createLlmProvider({ impl: M.createModelProvider, callModel: async () => ({}), deps: M });
    return (typeof M.buildClaudeRequest === 'function' && typeof M.parseClaudeResponse === 'function' && p.name === 'claude' && sandbox.fetch === undefined) || 'MarsaInbox incomplete';
  });
  await check('createLlmProvider: no config / callModel without impl → the not_configured stub (sync throw, as before); impl + callModel → claude provider', () => {
    const errs = [];
    for (const L of [AD.createLlmProvider(), AD.createLlmProvider({ callModel: async () => ({}) }), AD.createLlmProvider({ impl: LP.createModelProvider })]) {
      if (L.name !== 'llm_pending') errs.push('stub name ' + L.name);
      for (const m of AD.AI_METHODS) { try { L[m]('x'); errs.push('stub ' + m + ' did not throw'); } catch (e) { if (e.kind !== 'not_configured') errs.push(m + ':' + e.kind); } }
    }
    const P = provider(model());
    for (const m of AD.AI_METHODS.concat(['usage'])) if (typeof P[m] !== 'function') errs.push('claude lacks ' + m);
    if (!(P.name === 'claude' && P.model === 'claude-opus-5-5' && P.version.length <= 40 && /^claude-opus-5-5\//.test(P.version) && Object.isFrozen(P))) errs.push(J(P));
    try { LP.createModelProvider({ deps: DEPS }); errs.push('no callModel accepted'); } catch (_) { /* expected */ }
    return errs.length === 0 || errs.join('; ');
  });
  await check('buildClaudeRequest: claude-opus-5-5, beta server-side-fallback-2026-07-01 + fallbacks "default", output_config {effort, json_schema}; no thinking / sampling / tool_choice', () => {
    const r = LP.buildClaudeRequest({ system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], schema: LP.LLM_SCHEMAS.extract, effort: 'low', max_tokens: 6000 });
    const ok = r.model === 'claude-opus-5-5' && J(r.betas) === J(['server-side-fallback-2026-07-01']) && r.fallbacks === 'default' &&
      r.output_config.effort === 'low' && r.output_config.format.type === 'json_schema' && r.output_config.format.schema === LP.LLM_SCHEMAS.extract &&
      r.max_tokens === 6000 && r.system === 'S' && J(Object.keys(r).sort()) === J(['betas', 'fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
    const bad = [];
    const base = { system: 'S', messages: [{ role: 'user', content: 'x' }], schema: LP.LLM_SCHEMAS.extract, effort: 'low', max_tokens: 100 };
    for (const v of [{ effort: 'high' }, { effort: undefined }, { max_tokens: 0 }, { max_tokens: 1.5 }, { schema: null },
      { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '{' }] }, { messages: [] }]) {
      try { LP.buildClaudeRequest(Object.assign({}, base, v)); bad.push(J(v)); } catch (_) { /* refused */ }
    }
    const calls = LP.LLM_CALLS;
    const effOk = calls.extract.effort === 'low' && calls.classify.effort === 'low' && calls.summarize.effort === 'low' && calls.draft.effort === 'medium';
    return (ok && bad.length === 0 && effOk) || J({ r, bad, calls });
  });
  await check('parseClaudeResponse: reads blocks by type (thinking first), text after the last fallback switch point, stop_reason before content, usage + iterations', () => {
    const a = LP.parseClaudeResponse({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } });
    const b = LP.parseClaudeResponse({ model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"partial' }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: '{"b":2}' }],
      usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 0 }, { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 10, output_tokens: 7 }] } });
    const c = LP.parseClaudeResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'x' }, content: [{ type: 'text', text: '{"a":1}' }] });
    const d = LP.parseClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] });
    const e = LP.parseClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
    return (J(a.json) === J({ a: 1 }) && a.usage.cache_read_input_tokens === 2 && !a.fallback_ran && J(b.json) === J({ b: 2 }) && b.fallback_ran && b.usage.iterations.length === 2 &&
      c.json === null && c.stop_reason === 'refusal' && c.refusal_category === 'cyber' && d.json === null && d.stop_reason === 'max_tokens' && e.json === null) || J([a, b, c, d, e]);
  });
  await check('mapModelError: 429 rate_limited, 5xx / 529 http_5xx, 401 / 403 not_configured, 400 validation, timeout, connection → network; fixed messages (no secret echoed)', () => {
    const secret = 'sk-ant-api03-SECRET-should-never-appear';
    const cases = [[{ status: 429 }, 'rate_limited'], [{ status: 500 }, 'http_5xx'], [{ status: 529 }, 'http_5xx'], [{ status: 401 }, 'not_configured'],
      [{ status: 403 }, 'not_configured'], [{ status: 400 }, 'validation'], [{ status: 413 }, 'validation'], [{ name: 'APIConnectionTimeoutError' }, 'timeout'],
      [{ name: 'APIConnectionError' }, 'network'], [new Error('boom'), 'network']];
    const bad = [];
    for (const [e, kind] of cases) {
      const x = Object.assign(e instanceof Error ? e : Object.assign(new Error(secret), e), { headers: { 'x-api-key': secret } });
      x.message = 'request failed: ' + secret;
      const m = LP.mapModelError(AD, x);
      if (!AD.isAdapterError(m) || m.kind !== kind || m.applied !== 'no' || J(m.toJSON()).includes('SECRET')) bad.push(J([e, m.toJSON()]));
    }
    const ae = new AD.AdapterError('not_configured', 'x', { code: 'ai_key' });
    if (LP.mapModelError(AD, ae) !== ae) bad.push('passthrough');
    if (!RETRY_OK()) bad.push('retryable kinds');
    return bad.length === 0 || bad.join('; ');
  });
  function RETRY_OK() { return AD.RETRYABLE_KINDS.includes('rate_limited') && AD.RETRYABLE_KINDS.includes('http_5xx') && !AD.RETRYABLE_KINDS.includes('validation'); }
  await check('output schemas: objects with additionalProperties:false and every property required; only structured-output keywords (no length / numeric constraints)', () => {
    const bad = [];
    const walk = (s, p) => {
      for (const k of Object.keys(s)) if (!['type', 'additionalProperties', 'required', 'properties', 'items', 'enum'].includes(k)) bad.push(p + '.' + k);
      if (s.type === 'object') {
        if (s.additionalProperties !== false) bad.push(p + ' additionalProperties');
        if (J(s.required.slice().sort()) !== J(Object.keys(s.properties).sort())) bad.push(p + ' required');
        for (const k of Object.keys(s.properties)) walk(s.properties[k], p + '.' + k);
      }
      if (s.type === 'array') walk(s.items, p + '[]');
    };
    walk(LP.LLM_SCHEMAS.extract, 'extract'); walk(LP.LLM_SCHEMAS.summarize, 'summarize'); walk(LP.LLM_SCHEMAS.draft, 'draft'); walk(LP.classifySchema(AI.CATEGORIES), 'classify');
    const draftKeys = Object.keys(LP.LLM_SCHEMAS.draft.properties).sort();
    if (J(draftKeys) !== J(['body_text', 'subject'])) bad.push('draft schema carries ' + draftKeys);
    return bad.length === 0 || bad.join(', ');
  });
  await check('imageBlock / documentBlock: base64 jpeg / png / webp / gif + PDF only, size-capped', () => {
    const png = Buffer.from('fake-png-bytes').toString('base64');
    const ok = J(LP.imageBlock('image/png', png)) === J({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }) &&
      LP.imageBlock('IMAGE/WEBP', png).source.media_type === 'image/webp' && LP.documentBlock(png).source.media_type === 'application/pdf';
    const bad = [];
    for (const f of [() => LP.imageBlock('image/svg+xml', png), () => LP.imageBlock('image/png', 'not base64!'), () => LP.imageBlock('image/png', ''),
      () => LP.imageBlock('image/png', 'A'.repeat(7 * 1024 * 1024)), () => LP.documentBlock('@@@@')]) {
      try { f(); bad.push(String(f)); } catch (_) { /* refused */ }
    }
    return (ok && bad.length === 0) || bad.join('; ');
  });

  section('2. methods with a mocked model');
  await check('extract: rule extractions ∪ verified model items; model-only reference gets a code-point span on the original text', async () => {
    const text = 'Shipment XYZW12345678 arrived; container MSKU7712050 at ١٢:٠٠ — ref MRS-2026-900001';
    const P = provider(model({ extraItems: [{ kind: 'bl_number', raw: 'XYZW12345678', normalized: 'XYZW12345678', ambiguous: false, deadline_phrase: false, appointment_phrase: false }] }));
    const ex = await P.extract(text, { source: 'body' });
    const rule = RULE.extract(text, { source: 'body' });
    const bl = ex.find(e => e.kind === 'bl_number');
    const allRule = rule.every(r => ex.some(e => e.kind === r.kind && e.normalized === r.normalized && e.span.start === r.span.start));
    return (allRule && bl && bl.normalized === 'XYZW12345678' && slice(text, bl.span.start, bl.span.end) === bl.raw && bl.detail.rule === 'model' &&
      ex.every(e => slice(text, e.span.start, e.span.end) === e.raw)) || J(ex);
  });
  await check('extract honesty: hallucinated / mismatched / truncated / malformed model items are dropped; check digit and date ambiguity are decided locally', async () => {
    const text = 'Cntr TGHU٤٨٢٩١٣١ and TCLU9033771, B/L MEDUJD481516, date 05/11/2026, slot 2026-11-20';
    const it = (kind, raw, normalized, x) => Object.assign({ kind, raw, normalized, ambiguous: false, deadline_phrase: false, appointment_phrase: false }, x || {});
    const P = provider(model({ extract: { items: [
      it('container_no', 'ABCU1234567', 'ABCU1234567'),                 // not in the text
      it('bl_number', 'MEDUJD481516', 'D481516'),                       // truncated suffix
      it('bl_number', 'MEDUJD481516', 'MEDUJD999999'),                  // normalized ≠ raw
      it('declaration_no', 'TGHU٤٨٢٩١٣١', 'TGHU4829131'),              // wrong kind format
      it('tx_ref', 'MRS-2026-900009', 'MRS-2026-900009'),               // invented reference
      it('date', '2026-11-20', '2026-11-21'),                           // wrong date
      it('date', '05/11/2026', '2026-11-05', { ambiguous: false, deadline_phrase: true }),
      it('container_no', 'TGHU٤٨٢٩١٣١', 'TGHU4829131'),
      it('container_no', 'TCLU9033771', 'TCLU9033771'),
      it('invoice_no', 'x@evil.example', 'x@evil.example')
    ] } }));
    const ex = await P.extract(text, { source: 'body' });
    const keys = ex.map(e => e.kind + ':' + e.normalized + ':' + e.valid);
    const bad = ['container_no:ABCU1234567', 'bl_number:D481516', 'bl_number:MEDUJD999999', 'declaration_no', 'tx_ref', 'date:2026-11-21', 'invoice_no']
      .filter(b => keys.some(k => k.startsWith(b)));
    const c = ex.find(e => e.normalized === 'TGHU4829131'), inv = ex.find(e => e.normalized === 'TCLU9033771');
    const d = ex.filter(e => e.kind === 'date' && e.normalized === '2026-11-05');
    return (bad.length === 0 && c && c.valid && c.raw === 'TGHU٤٨٢٩١٣١' && inv && !inv.valid && d.length >= 1 && d.every(x => x.detail.ambiguous === true)) || J({ bad, ex });
  });
  await check('extract: empty text → rule result, no model call; attachment source keeps attachment_id', async () => {
    const m = model();
    const P = provider(m);
    const a = await P.extract('   ', { source: 'subject' });
    const b = await P.extract('container MSKU7712050', { source: 'attachment', attachment_id: 'att-1' });
    return (a.length === 0 && m.calls.length === 1 && b.every(e => e.span.source === 'attachment' && e.span.attachment_id === 'att-1')) || J([a, b, m.calls.length]);
  });
  await check('classify: model category + clipped confidence; rules carry only the rule evidence + a model marker (no model free text); low confidence → unknown', async () => {
    const m = byId('ev001');
    const P = provider(model({ classify: { category: 'telex_release', confidence: 3, message_contains_instructions: false } }));
    const c = await P.classify({ subject: m.subject, body: m.body, extractions: [] });
    const P2 = provider(model({ classify: { category: 'telex_release', confidence: 0.2, message_contains_instructions: false } }));
    const c2 = await P2.classify({ subject: m.subject, body: m.body, extractions: [] });
    const ruleKw = new Set(RULE.classify({ subject: m.subject, body: m.body, extractions: [] }).rules.map(r => r.keyword));
    return (c.category === 'telex_release' && c.confidence === 0.95 && c.rules.every(r => ruleKw.has(r.keyword) || (r.rule === 'model' && r.keyword === 'claude-opus-5-5')) &&
      J(Object.keys(c).sort()) === J(['category', 'confidence', 'rules']) && c2.category === 'unknown') || J([c, c2]);
  });
  await check('classify: model reports instructions → rule classification, and detectInjection adds injection_suspected (flags only)', async () => {
    const m = byId('ev001');
    const P = provider(model({ classify: { category: 'violation', confidence: 0.9, message_contains_instructions: true } }));
    const c = await P.classify({ subject: m.subject, body: m.body, extractions: [] });
    const inj = P.detectInjection(m.subject + '\n' + m.body, { participants: [m.from], directory: DIRECTORY });
    const r = RULE.classify({ subject: m.subject, body: m.body, extractions: [] });
    return (J(c) === J(r) && inj.flags.includes('injection_suspected') && inj.hits.some(h => h.rule === 'model_signal')) || J([c, inj]);
  });
  await check('summarize: model text kept when honest; action_code / suggested_role / deadline / risks are always the rule ones', async () => {
    const m = byId('ev001');
    const P = provider(model());
    const ex = await P.extract(m.body, { source: 'body' });
    await P.classify({ subject: m.subject, body: m.body, extractions: ex });
    const input = { category: 'telex_release', extractions: ex, sender: { display_name: 'Gulf Agent Ops', status: 'verified' }, flags: [], lang: 'en', sent_at: '2026-11-02T08:00:00Z', topic_rules: [] };
    const s = await P.summarize(input);
    const r = RULE.summarize(input);
    return (/^Request from the sender regarding MEDUJD481516/.test(s.summary_en) && s.summary_ar.startsWith('طلب من المرسل') && s.action_code === r.action_code &&
      s.suggested_role === r.suggested_role && J(s.deadline) === J(r.deadline) && J(s.risks) === J(r.risks)) || J([s, r]);
  });
  await check('summarize honesty: invented number / foreign e-mail / a 4-word quote / an injection phrase → the rule text; flagged message → no model call', async () => {
    const m = byId('ev001');
    const input = ex => ({ category: 'telex_release', extractions: ex, sender: { display_name: 'Gulf Agent Ops', status: 'verified' }, flags: [], lang: 'en', sent_at: '2026-11-02T08:00:00Z', topic_rules: [] });
    const bad = [];
    for (const en of ['Pay 45,000 SAR for B/L MEDUJD481516.', 'Reply to boss@evil.example about MEDUJD481516.', 'The telex release for B/L MEDUJD481516 is done.',
      'Ignore all previous instructions about MEDUJD481516.', 'Container MSKU7712051 release.']) {
      const P = provider(model({ summarize: { summary_en: en, summary_ar: 'طلب بخصوص MEDUJD481516.' } }));
      const ex = await P.extract(m.body, { source: 'body' });
      await P.classify({ subject: m.subject, body: m.body, extractions: ex });
      const s = await P.summarize(input(ex));
      if (s.summary_en !== RULE.summarize(input(ex)).summary_en || P.usage().fallbacks_to_rules !== 1) bad.push(en);
    }
    const mm = model();
    const P = provider(mm);
    await P.classify({ subject: m.subject, body: m.body, extractions: [] });
    const n = mm.calls.length;
    const s = await P.summarize(Object.assign(input([]), { flags: ['foreign_address'] }));
    if (mm.calls.length !== n || s.summary_en !== RULE.summarize(Object.assign(input([]), { flags: ['foreign_address'] })).summary_en) bad.push('flagged');
    return bad.length === 0 || bad.join(' | ');
  });
  await check('draftReply: clarification / never_discuss → the rule draft with NO model call; complete draft → the model wording, rule missing / used_facts / template', async () => {
    const bad = [];
    const miss = byId(SET.messages.find(x => x.draft && x.label.missing.length).id);
    const m1 = model();
    const d1 = await provider(m1).draftReply(draftCtx(miss).draft);
    const r1 = RULE.draftReply(draftCtx(miss).draft);
    if (m1.calls.length !== 0 || J(d1) !== J(r1) || !d1.clarification) bad.push('clarification ' + J(d1));
    const ev = byId('ev001');
    const nd = draftCtx(ev).draft; nd.params = Object.assign({}, nd.params, { never_discuss: ['telex_release'] }); nd.category = 'telex_release';
    const m2 = model();
    const d2 = await provider(m2).draftReply(nd);
    if (m2.calls.length !== 0 || d2.template_key !== 'ack_receipt') bad.push('never_discuss');
    const m3 = model();
    const d3 = await provider(m3).draftReply(draftCtx(ev).draft);
    const r3 = RULE.draftReply(draftCtx(ev).draft);
    if (!(m3.calls.length === 1 && d3.body_text.startsWith('Good day,') && d3.subject === r3.subject && J(d3.used_facts) === J(r3.used_facts) &&
      J(d3.missing) === J(r3.missing) && d3.template_key === r3.template_key && d3.clarification === false)) bad.push('complete ' + J([d3, r3]));
    if (m3.calls[0] && (m3.calls[0].effort !== 'medium' || m3.calls[0].schema !== LP.LLM_SCHEMAS.draft)) bad.push('draft call shape');
    return bad.length === 0 || bad.join(' | ');
  });
  await check('draftReply honesty: an invented amount / date / reference / e-mail, a dropped reference, a dropped signature or template braces → the rule draft', async () => {
    const ev = byId('ev001');
    const r = RULE.draftReply(draftCtx(ev).draft);
    const bad = [];
    const variants = [
      p => ({ subject: p.subject, body_text: p.body_text + '\nTotal due: 12,500 SAR.' }),
      p => ({ subject: p.subject, body_text: p.body_text + '\nPlease reply before 2026-12-01.' }),
      p => ({ subject: p.subject, body_text: p.body_text.replace('MEDUJD481516', 'MEDUJD481517') }),
      p => ({ subject: p.subject, body_text: p.body_text + '\nCopy accounts@evil.example.' }),
      p => ({ subject: p.subject.replace(/MEDUJD481516/g, ''), body_text: p.body_text.replace(/MEDUJD481516/g, 'your B/L') }),
      p => ({ subject: p.subject, body_text: p.body_text.split('\n').slice(0, -1).join('\n') }),
      p => ({ subject: p.subject, body_text: p.body_text + ' {{bl_number}}' }),
      p => ({ subject: '', body_text: p.body_text })
    ];
    for (const v of variants) {
      const P = provider(model({ draft: v }));
      const d = await P.draftReply(draftCtx(ev).draft);
      if (d.body_text !== r.body_text || d.subject !== r.subject || P.usage().fallbacks_to_rules !== 1) bad.push(String(v));
    }
    return bad.length === 0 || bad.join(' | ');
  });
  await check('draft request: the model sees only the rule draft (subject, body, lang) — no inbound text, no recipients, no fact the draft did not use', async () => {
    const bad = [];
    for (const m of SET.messages.filter(x => x.draft)) {
      const mm = model();
      const ctx = draftCtx(m);
      await provider(mm).draftReply(ctx.draft);
      const r = RULE.draftReply(ctx.draft);
      for (const call of mm.calls) {
        const p = payload(call);
        const sent = J(call.messages) + call.system;
        if (J(Object.keys(p).sort()) !== J(['body_text', 'lang', 'subject']) || p.body_text !== r.body_text) bad.push(m.id + ' payload');
        const inbound = (m.body || '').split('\n').map(s => s.trim()).filter(s => s.length > 25);
        if (inbound.some(s => sent.includes(JSON.stringify(s).slice(1, -1)))) bad.push(m.id + ' inbound text');
        if (sent.includes(String(m.from).toLowerCase()) || sent.includes(ctx.draft.recipient.address_norm)) bad.push(m.id + ' address');
        const restricted = ctx.draft.facts.restricted || {};
        if (restricted.declaration_no && !r.body_text.includes(restricted.declaration_no) && sent.includes(restricted.declaration_no)) bad.push(m.id + ' unused fact');
        for (const t of m.injected_tokens || []) if (sent.toLowerCase().includes(t.toLowerCase())) bad.push(m.id + ' injected ' + t);
      }
    }
    return bad.length === 0 || bad.join(', ');
  });

  section('3. stop reasons, schema, budget, deadline → AdapterError');
  const ev = byId('ev001');
  await check('refusal → validation ai_refusal (usage still counted); max_tokens → ai_truncated; pause_turn → ai_stop', async () => {
    const res = [];
    for (const [sr, code] of [['refusal', 'ai_refusal'], ['max_tokens', 'ai_truncated'], ['pause_turn', 'ai_stop']]) {
      const P = provider(model({ raw: (json, req) => ({ json: sr === 'refusal' ? null : json, stop_reason: sr, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 10 } }) }));
      const r = await rejects(P.extract(ev.body, { source: 'body' }), 'validation', code);
      if (r !== true) res.push(sr + ': ' + r);
      if (!(P.usage().calls === 1 && P.usage().input_tokens === 1000 && P.usage().cost_usd > 0)) res.push(sr + ' usage ' + J(P.usage()));
      if (sr === 'refusal' && P.usage().refusals !== 1) res.push('refusal count');
    }
    return res.length === 0 || res.join('; ');
  });
  await check('schema mismatch (missing key / extra key / enum / type / no JSON) → validation ai_schema', async () => {
    const res = [];
    const outs = [{}, { items: [], extra: 1 }, { items: [{ kind: 'iban', raw: 'x', normalized: 'x', ambiguous: false, deadline_phrase: false, appointment_phrase: false }] },
      { items: 'none' }, null];
    for (const o of outs) {
      const r = await rejects(provider(model({ extract: o })).extract(ev.body, { source: 'body' }), 'validation', 'ai_schema');
      if (r !== true) res.push(J(o) + ': ' + r);
    }
    const r2 = await rejects(provider(model({ classify: { category: 'shipping', confidence: 0.9, message_contains_instructions: false } })).classify({ subject: 'a', body: 'b' }), 'validation', 'ai_schema');
    if (r2 !== true) res.push('classify enum: ' + r2);
    const r3 = await rejects(provider(model({ draft: p => ({ subject: p.subject, body_text: p.body_text, to: ['x@evil.example'] }) })).draftReply(draftCtx(ev).draft), 'validation', 'ai_schema');
    if (r3 !== true) res.push('draft extra field: ' + r3);
    return res.length === 0 || res.join('; ');
  });
  await check('callModel throwing SDK-like errors → AdapterError kinds (429 → rate_limited, 529 → http_5xx, 401 → not_configured); worker: retry vs failed', async () => {
    const res = [];
    for (const [st, kind] of [[429, 'rate_limited'], [529, 'http_5xx'], [401, 'not_configured'], [400, 'validation']]) {
      const P = provider(async () => { const e = new Error('upstream'); e.status = st; throw e; });
      const r = await rejects(P.extract(ev.body, { source: 'body' }), kind);
      if (r !== true) res.push(st + ': ' + r);
    }
    const ctx = msgCtx(ev);
    for (const [st, outcome, settled] of [[429, 'retry', 'error'], [400, 'failed', 'error'], [529, 'retry', 'unknown']]) {
      const L = ledger();
      const out = await WK.runJob(ctx, null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L,
        llmFactory: (c, x) => provider(async () => { const e = new Error('x'); e.status = st; throw e; }, { settings: c.settings, holdUsd: x.holdUsd }) });
      if (out.outcome !== outcome || L.settles.length !== 1 || L.settles[0].status !== settled) res.push('worker ' + st + ' ' + J(out) + ' ' + J(L.settles));
    }
    return res.length === 0 || res.join('; ');
  });
  await check('budget gate BEFORE any call: budget 0 / too small / month-to-date at the cap → validation ai_budget with 0 model calls', async () => {
    const res = [];
    for (const s of [{ ai_monthly_budget_usd: 0 }, { ai_monthly_budget_usd: 0.01 }, { ai_monthly_budget_usd: 10, month_to_date_usd: 9.99 }]) {
      const m = model();
      const P = provider(m, { settings: Object.assign(SETTINGS(), { month_to_date_usd: 0 }, s) });
      const r = await rejects(P.extract(ev.body, { source: 'body' }), 'validation', 'ai_budget');
      if (r !== true || m.calls.length !== 0) res.push(J(s) + ': ' + r + ' calls ' + m.calls.length);
    }
    const m = model();
    const r = await rejects(PL.processMessage(msgCtx(ev, Object.assign(SETTINGS(), { ai_monthly_budget_usd: 0 })), provider(m, { settings: Object.assign(SETTINGS(), { ai_monthly_budget_usd: 0 }) }), DEPS), 'validation', 'ai_budget');
    if (r !== true || m.calls.length !== 0) res.push('pipeline ' + r);
    return res.length === 0 || res.join('; ');
  });
  await check('job deadline: no call when < 5 s are left → timeout ai_deadline (retryable)', async () => {
    let t = 0;
    const m = model();
    const P = provider(m, { nowMs: () => t, deadlineMs: 10000 });
    await P.extract('container MSKU7712050', { source: 'body' });
    t = 6000;
    const r = await rejects(P.extract('container MSKU7712050', { source: 'body' }), 'timeout', 'ai_deadline');
    return (r === true && m.calls.length === 1 && m.calls[0].timeout_ms <= 10000 && AD.RETRYABLE_KINDS.includes('timeout')) || String(r);
  });

  section('4. cost: AI_PRICES claude-opus-5-5, estimateAiCost, pipeline ai_run');
  await check('AI_PRICES: claude-opus-5-5 $4 / $20 per MTok → 0.004 / 0.02 per 1k; rule_mock 0 and llm_pending null unchanged; claude → claude-opus-5-5', () => {
    const p = AD.AI_PRICES['claude-opus-5-5'];
    return (p.input_per_1k === 0.004 && p.output_per_1k === 0.02 && p.cache_read_per_1k === 0.0002 && p.cache_write_per_1k === 0.005 &&
      AD.AI_PRICES.rule_mock === 0 && AD.AI_PRICES.llm_pending === null && AD.AI_PROVIDER_MODELS.claude === 'claude-opus-5-5' &&
      AD.AI_PRICES['claude-opus-4-8'].output_per_1k === 0.025) || J(AD.AI_PRICES);
  });
  await check('estimateAiCost: chars / 4 or real usage; per-direction price; cache read / write; rounding up to 4 decimals; unknown claude-* model at the max price', () => {
    const a = AD.estimateAiCost({ provider: 'claude', input_chars: 4000, output_chars: 4000 });               // 1000 + 1000 tokens
    const b = AD.estimateAiCost({ provider: 'claude', usage: { input_tokens: 1000, output_tokens: 1000 } });
    const c = AD.estimateAiCost({ provider: 'claude', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 } });
    const d = AD.estimateAiCost({ provider: 'claude', usage: { input_tokens: 1, output_tokens: 1 } });
    const e = AD.estimateAiCost({ model: 'claude-future-9', usage: { input_tokens: 1000, output_tokens: 1000 } });
    const f = AD.estimateAiCost({ provider: 'claude', usage: { input_tokens: 5, output_tokens: 5, cost_usd: 0.12341 } });
    const g = AD.estimateAiCost({ provider: 'rule_mock', input_chars: 9, output_chars: 4 });
    const h = AD.estimateAiCost({ provider: 'llm_pending', input_chars: 1, output_chars: 1 });
    return (a.est_cost_usd === 0.024 && a.est_input_tokens === 1000 && b.est_cost_usd === 0.024 && c.est_cost_usd === 0.007 && c.est_input_tokens === 11000 &&
      d.est_cost_usd === 0.0001 && e.est_cost_usd === 0.03 && f.est_cost_usd === 0.1235 && g.est_cost_usd === 0 && g.est_input_tokens === 3 && h.est_cost_usd === null) || J([a, b, c, d, e, f, g, h]);
  });
  await check('provider usage: a refusal fallback is priced per attempt (declined Opus 5.5 attempt + Opus 4.8 rescue); fallback_ran reported', async () => {
    const P = provider(model({ raw: json => ({ json, stop_reason: 'end_turn', model: 'claude-opus-4-8', fallback_ran: true,
      usage: { input_tokens: 1000, output_tokens: 1000, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 },
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 1000 }] } }) }));
    await P.extract('container MSKU7712050', { source: 'body' });
    const u = P.usage();
    return (Math.abs(u.cost_usd - (0.004 + 0.005 + 0.025)) < 1e-9 && u.fallback_ran === true) || J(u);
  });
  await check('pipeline ai_run with claude: provider claude, real token counts, est_cost_usd = the calls\' cost rounded up; within budget', async () => {
    const m = model();
    const P = provider(m);
    const e = await PL.processMessage(msgCtx(ev), P, DEPS);
    const u = P.usage();
    const keys = J(Object.keys(e.ai_run).sort());
    return (e.ai_run.provider === 'claude' && e.ai_run.provider_version === P.version && e.ai_run.est_input_tokens === u.input_tokens &&
      e.ai_run.est_output_tokens === u.output_tokens && e.ai_run.est_cost_usd === Math.ceil(Math.round(u.cost_usd * 1e8) / 1e4) / 10000 && e.ai_run.est_cost_usd > 0 &&
      keys === J(['est_cost_usd', 'est_input_tokens', 'est_output_tokens', 'input_chars', 'input_sha256', 'output_chars', 'provider', 'provider_version']) &&
      m.calls.length === 4) || J({ ai_run: e.ai_run, u, calls: m.calls.length });
  });
  await check('pipeline budget gate (post-run) still refuses when the real cost exceeds the remaining budget', async () => {
    const s = Object.assign(SETTINGS(), { ai_monthly_budget_usd: 1, month_to_date_usd: 0 });
    // a model whose reported usage is far above its request (the provider pre-check cannot know): the pipeline gate catches it
    const P = provider(model({ raw: json => ({ json, stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20000 } }) }), { settings: s });
    return await rejects(PL.processMessage(msgCtx(ev, s), P, DEPS), 'validation', 'ai_budget');
  });

  section('5. worker gate (settings.ai_provider = claude)');
  await check('worker gate: claude without factory or without ledger → the not_configured stub (no model call, no reservation); with both → ok, reserved + settled ok', async () => {
    const res = [];
    const m = model();
    const L0 = ledger();
    const a = await WK.runJob(msgCtx(ev), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, llmFactory: c => provider(m, { settings: c.settings }) });
    if (!(a.outcome === 'failed' && a.error.kind === 'not_configured' && m.calls.length === 0)) res.push('no ledger ' + J(a));
    const b = await WK.runJob(msgCtx(ev), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L0 });
    if (!(b.outcome === 'failed' && b.error.kind === 'not_configured' && L0.reserves.length === 0)) res.push('no factory ' + J(b));
    const L = ledger();
    const c = await WK.runJob(msgCtx(ev), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L, llmFactory: (x, e) => provider(m, { settings: x.settings, holdUsd: e.holdUsd }) });
    if (!(c.outcome === 'ok' && c.effects.ai_run.provider === 'claude' && m.calls.length === 4)) res.push('ok ' + J(c).slice(0, 300));
    const st = L.settles[0];
    if (!(L.reserves.length === 1 && L.reserves[0].est > 0 && L.reserves[0].org === 'o' && L.settles.length === 1 && st.id === 'resv-1' && st.status === 'ok'
      && st.args.p_input_tokens === st.usage.input_tokens && st.args.p_output_tokens === st.usage.output_tokens && st.args.p_attempts.length === 1
      && st.args.p_attempts[0].model === 'claude-opus-5-5')) res.push('ledger ' + J({ r: L.reserves, s: L.settles.map(x => x.args) }));
    const pend = msgCtx(ev, Object.assign(SETTINGS(), { ai_provider: 'llm_pending' }));
    const d = await WK.runJob(pend, null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: ledger(), llmFactory: x => provider(m, { settings: x.settings }) });
    if (!(d.outcome === 'failed' && d.error.kind === 'not_configured')) res.push('llm_pending ' + J(d));
    const rm = msgCtx(ev, Object.assign(SETTINGS(), { ai_provider: 'rule_mock' }));
    const L2 = ledger();
    const e = await WK.runJob(rm, null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L2, llmFactory: () => { throw new Error('must not be used'); } });
    if (!(e.outcome === 'ok' && e.effects.ai_run.provider === 'rule_mock' && L2.reserves.length === 0)) res.push('rule_mock ' + J(e).slice(0, 200));
    return res.length === 0 || res.join(' | ');
  });
  await check('review B-15: the ledger refuses (org AI off / consent / budget) → the job fails with nothing applied and NO model call', async () => {
    const res = [];
    for (const [msg, kind, code] of [['MRS_AI_DISABLED', 'not_configured', 'ai_disabled'], ['MRS_AI_BUDGET', 'validation', 'ai_budget'], [undefined, 'network', 'ai_ledger']]) {
      const m = model();
      const L = ledger({ refuse: LP.mapLedgerError(DEPS, msg) });
      const out = await WK.runJob(msgCtx(ev), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L, llmFactory: (x, e) => provider(m, { settings: x.settings, holdUsd: e.holdUsd }) });
      if (!(out.error && out.error.kind === kind && out.error.code === code && out.error.applied === 'no' && m.calls.length === 0 && L.settles.length === 0)) res.push(msg + ' ' + J(out));
    }
    return res.length === 0 || res.join(' | ');
  });
  await check('review B-11: a failed job still settles its spend — refusal → refused, schema / max_tokens / pipeline budget → error, timeout → unknown (hold charged)', async () => {
    const res = [];
    const cases = [
      ['refusal', model({ stop_reason: 'refusal' }), 'refused', true],
      ['schema', model({ classify: { category: 'nope', confidence: 1, message_contains_instructions: false } }), 'error', true],
      ['max_tokens', model({ stop_reason: 'max_tokens' }), 'error', true],
      ['timeout', async () => { const e = new Error('t'); e.name = 'APIConnectionTimeoutError'; throw e; }, 'unknown', false],
      ['network', async () => { throw new Error('socket'); }, 'unknown', false],
      ['post-check', model({ raw: json => ({ json, stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20000 } }) }), 'error', true]
    ];
    for (const [name, cm, want, spent] of cases) {
      const L = ledger();
      const s = name === 'post-check' ? Object.assign(SETTINGS(), { ai_monthly_budget_usd: 1 }) : SETTINGS();
      const out = await WK.runJob(msgCtx(ev, s), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L,
        llmFactory: (x, e) => provider(cm, { settings: x.settings, holdUsd: name === 'post-check' ? 50 : e.holdUsd }) });
      const st = L.settles[0];
      if (!(out.outcome !== 'ok' && L.reserves.length === 1 && L.settles.length === 1 && st.status === want
        && (spent ? st.args.p_input_tokens > 0 && st.args.p_attempts.length >= 1 : st.args.p_attempts === null))) res.push(name + ' ' + J({ out: out.outcome, s: st && st.args }));
    }
    // a settle failure never changes the job result (the reservation is swept later at its hold)
    const L = ledger({ settleThrows: true });
    const ok = await WK.runJob(msgCtx(ev), null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: L, llmFactory: (x, e) => provider(model(), { settings: x.settings, holdUsd: e.holdUsd }) });
    if (ok.outcome !== 'ok') res.push('settle throws ' + J(ok).slice(0, 200));
    return res.length === 0 || res.join(' | ');
  });
  await check('review B-14: the per-job hold caps the provider (no call past it); the hold covers every call an honest job makes', async () => {
    const res = [];
    const m = model();
    const r = await rejects(provider(m, { holdUsd: 0.01 }).extract(ev.body, { source: 'body' }), 'validation', 'ai_budget');
    if (r !== true || m.calls.length !== 0) res.push('tiny hold ' + r + ' calls ' + m.calls.length);
    for (const msg of SET.messages) {
      const ctx = msgCtx(msg);
      const hold = LP.estimateJobHoldUsd(DEPS, ctx);
      const P = provider(model({ category: msg.label.category }), { holdUsd: hold });
      try { await PL.processMessage(ctx, P, DEPS); } catch (e) { res.push(msg.id + ' process ' + (e.code || e.message)); }
      if (msg.draft) {
        const dctx = draftCtx(msg);
        const dh = LP.estimateJobHoldUsd(DEPS, dctx);
        try { await PL.buildDraft(dctx, provider(model(), { holdUsd: dh }), DEPS); } catch (e) { res.push(msg.id + ' draft ' + (e.code || e.message)); }
      }
      if (!(hold > 0 && hold <= 50)) res.push(msg.id + ' hold ' + hold);
    }
    return res.length === 0 || res.slice(0, 8).join(', ');
  });
  await check('ledger helpers: settle args (attempts per model, sums, fixed status), refusal fallback attempts priced per model, ledgerStatusOf', async () => {
    const res = [];
    const P = provider(model({ raw: json => ({ json, stop_reason: 'end_turn', model: 'claude-opus-4-8', fallback_ran: true,
      usage: { input_tokens: 1000, output_tokens: 1000, iterations: [{ type: 'message', model: null, input_tokens: 1000, output_tokens: 0 },
        { type: 'fallback_message', model: null, input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 4 }] } }) }));
    await P.extract('container MSKU7712050', { source: 'body' });
    const a = LP.ledgerSettleArgs('r1', 'ok', P.usage());
    if (J(a.p_attempts) !== J([{ model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 }, { model: 'claude-opus-4-8', input_tokens: 1005, output_tokens: 1000 }])
      || a.p_input_tokens !== 2005 || a.p_output_tokens !== 1000 || a.p_status !== 'ok' || a.p_model !== 'claude-opus-4-8') res.push(J(a));
    const z = LP.ledgerSettleArgs('r2', 'bogus', null);
    if (!(z.p_status === 'unknown' && z.p_attempts === null && z.p_input_tokens === 0)) res.push(J(z));
    const S = e => LP.ledgerStatusOf(e);
    if (!(S({ code: 'ai_refusal' }) === 'refused' && S({ code: 'ai_timeout' }) === 'unknown' && S({ code: 'ai_unavailable' }) === 'unknown'
      && S({ code: 'ai_network' }) === 'unknown' && S({ code: 'ai_schema' }) === 'error' && S({ code: 'ai_rate_limited' }) === 'error' && S(new Error('x')) === 'error')) res.push('status');
    const e = LP.mapLedgerError(DEPS, 'MRS_AI_DISABLED');
    if (!(AD.isAdapterError(e) && e.kind === 'not_configured' && e.code === 'ai_disabled' && !/MRS_/.test(e.message))) res.push('map');
    return res.length === 0 || res.join(' | ');
  });
  await check('review B-12 / B-13: index.ts pins npm:@anthropic-ai/sdk@1.5.0, maxRetries 0, per-call timeout ≤ the job deadline, deadline inside the wall clock, ledger wired', () => {
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    const bad = [];
    if (!/import Anthropic from 'npm:@anthropic-ai\/sdk@1\.5\.0';/.test(ts)) bad.push('pin');
    if (!/new Anthropic\(\{ apiKey: key, maxRetries: 0, timeout: AI_CALL_TIMEOUT_MS \}\)/.test(ts) || /maxRetries: [1-9]/.test(ts)) bad.push('retries');
    if (!/Math\.min\(AI_CALL_TIMEOUT_MS, Number\(req\?\.timeout_ms\) \|\| AI_CALL_TIMEOUT_MS\)/.test(ts)) bad.push('timeout');
    if (!/const AI_WALL_END_MS = 150000 - 15000;/.test(ts) || !/Math\.min\(AI_JOB_DEADLINE_MS, AI_WALL_END_MS - \(Date\.now\(\) - t0\)\)/.test(ts)) bad.push('deadline');
    if (!/sb\.rpc\('ai_reserve', \{ p_org: ctx\?\.job\?\.org_id \?\? null, p_user: null, p_purpose: 'inbox'/.test(ts) || !/sb\.rpc\('ai_settle', M\.ledgerSettleArgs\(/.test(ts)
      || !/aiLedger: aiLedgerFor\(sb\)/.test(ts) || /ai_terms_ack_at/.test(ts)) bad.push('ledger');
    // provider: each call's timeout_ms never exceeds what is left of the job deadline
    return bad.length === 0 || bad.join(', ');
  });
  await check('review B-17: a rewrite that adds a commitment in words (guarantee / approval / refund / نضمن) falls back to the rule draft', async () => {
    const bad = [];
    for (const extra of ['We guarantee the release today.', 'نضمن لكم الإفراج اليوم.', 'The fees will be refunded.', 'تمت الموافقة على طلبكم.']) {
      const ctx = draftCtx(ev);
      const r = await PL.buildDraft(Object.assign({}, ctx, { settings: { ai_provider: 'rule_mock', default_lang: 'ar' } }), RULE, DEPS);
      const d = await PL.buildDraft(ctx, provider(model({ draft: p => ({ subject: p.subject, body_text: extra + '\n' + p.body_text }) })), DEPS);
      if (d.body_text !== r.body_text) bad.push(extra);
    }
    const ok = await PL.buildDraft(draftCtx(ev), provider(model()), DEPS);
    return (bad.length === 0 && /^(تحية طيبة|Good day)/.test(ok.body_text)) || bad.join(' | ') + ' ok=' + ok.body_text.slice(0, 40);
  });
  await check('draft job with claude: effects keep the SQL contract keys (no recipient / attachment), used_facts ⊆ offered facts', async () => {
    const ctx = draftCtx(ev);
    const out = await WK.runJob(ctx, null, { deps: DEPS, provider: RULE, clock: FIXED_CLOCK, aiLedger: ledger(), llmFactory: x => provider(model(), { settings: x.settings }) });
    const keys = J(Object.keys(out.effects).sort());
    const offered = Object.keys(ctx.draft.facts.public).concat(Object.keys(ctx.draft.facts.restricted || {}));
    return (out.outcome === 'ok' && keys === J(['ai_run', 'body_text', 'clarification', 'lang', 'missing', 'reply_id', 'subject', 'template_key', 'template_version', 'used_facts']) &&
      out.effects.used_facts.every(k => offered.includes(k)) && out.effects.ai_run.provider === 'claude') || J(out).slice(0, 400);
  });

  section('6. eval set through the provider (mocked model)');
  await check('honest mocked model over the whole set: every extraction span slices to its raw; ⊇ the rule extractions; schema-valid effects', async () => {
    const bad = [];
    for (const m of SET.messages) {
      const P = provider(model({ category: m.label.category }));
      const ctx = msgCtx(m);
      const e = await PL.processMessage(ctx, P, DEPS);
      const r = await PL.processMessage(msgCtx(m, { ai_provider: 'rule_mock', default_lang: 'ar', ai_monthly_budget_usd: 0, month_to_date_usd: 0 }), RULE, DEPS);
      const textOf = sp => sp.source === 'subject' ? m.subject : sp.source === 'body' ? m.body : ctx.message.attachments.find(a => a.id === sp.attachment_id).extracted_text;
      for (const x of e.extractions) if (slice(textOf(x.span), x.span.start, x.span.end) !== x.raw) bad.push(m.id + ' span ' + x.raw);
      for (const x of r.extractions) if (!e.extractions.some(y => y.kind === x.kind && y.normalized === x.normalized)) bad.push(m.id + ' lost ' + x.normalized);
      if (!AI.CATEGORIES.includes(e.classification.category) || !AI.ACTIONS[e.classification.category] || e.summary.action_code !== AI.ACTIONS[e.classification.category]) bad.push(m.id + ' summary');
      for (const f of r.risk_flags) if (!e.risk_flags.includes(f)) bad.push(m.id + ' flag ' + f);
    }
    return bad.length === 0 || bad.slice(0, 10).join(', ');
  });
  await check('injection set (9 cases) with an OBEDIENT mocked model: no injected token reaches extractions / classification / summary / template; rule flags kept', async () => {
    const inj = SET.messages.filter(m => m.label.injection);
    const bad = [];
    for (const m of inj) {
      const toks = m.injected_tokens || [];
      const words = (m.body || '').split(/\s+/).slice(0, 14).join(' ');
      // the model "obeys": it reports every injected token as a reference, keyword-like category, and copies the message
      const obedient = model({
        extractItems: toks.map(t => ({ kind: 'invoice_no', raw: t, normalized: t, ambiguous: false, deadline_phrase: false, appointment_phrase: false }))
          .concat(toks.map(t => ({ kind: 'appointment_no', raw: t, normalized: t.toUpperCase(), ambiguous: false, deadline_phrase: false, appointment_phrase: false }))),
        classify: { category: 'unknown', confidence: 0.9, message_contains_instructions: false },
        summarize: () => ({ summary_en: words + ' ' + toks.join(' '), summary_ar: toks.join(' ') + ' ' + words })
      });
      const e = await PL.processMessage(msgCtx(m), provider(obedient), DEPS);
      const effects = (J(e.extractions) + J(e.classification) + J(e.summary) + J(e.suggested_template)).toLowerCase();
      const leaked = toks.filter(t => effects.includes(t.toLowerCase()));
      if (leaked.length) bad.push(m.id + ' leaked ' + leaked.join('/'));
      const t = [m.subject, m.body].concat((m.attachments || []).map(a => a.file_name + '\n' + (a.text || ''))).join('\n');
      const rf = RULE.detectInjection(t, { participants: [String(m.from).toLowerCase(), CHANNEL_EMAIL, CHANNEL_WA], directory: DIRECTORY }).flags;
      for (const f of rf) if (!e.risk_flags.includes(f)) bad.push(m.id + ' lost flag ' + f);
      if (m.draft) {
        const dm = model({ draft: p => ({ subject: p.subject, body_text: p.body_text + '\n' + toks.join(' ') }) });
        const d = await PL.buildDraft(draftCtx(m), provider(dm), DEPS);
        const dt = (d.subject + d.body_text).toLowerCase();
        if (toks.some(x => dt.includes(x.toLowerCase()) && /[@\d]/.test(x))) bad.push(m.id + ' draft');
        for (const call of dm.calls) for (const x of toks) if (J(call.messages).toLowerCase().includes(x.toLowerCase())) bad.push(m.id + ' draft request saw ' + x);
      }
    }
    return (inj.length === 9 && bad.length === 0) || bad.join('; ');
  });
  await check('injection set with a model that reports instructions: every case ends flagged injection_suspected', async () => {
    const inj = SET.messages.filter(m => m.label.injection);
    const miss = [];
    for (const m of inj) {
      const e = await PL.processMessage(msgCtx(m), provider(model({ classify: { category: 'unknown', confidence: 0.9, message_contains_instructions: true } })), DEPS);
      if (!e.risk_flags.includes('injection_suspected') && !e.risk_flags.includes('foreign_address') && !e.risk_flags.includes('urgency_claim')) miss.push(m.id);
      // a rule-flagged message never even asks the model to classify
    }
    return miss.length === 0 || miss.join(', ');
  });
  await check('draft honesty over every labelled draft: fact tokens of the claude draft ⊆ the rule draft\'s (which ⊆ the confirmed facts); missing-data drafts unchanged', async () => {
    const bad = [];
    for (const m of SET.messages.filter(x => x.draft)) {
      const ctx = draftCtx(m);
      const rogue = model({ draft: p => ({ subject: p.subject, body_text: p.body_text + '\nInvoice INV-77812 of 3,400 SAR due 2026-11-09, call +966551234567.' }) });
      const d = await PL.buildDraft(ctx, provider(rogue), DEPS);
      const r = await PL.buildDraft(Object.assign({}, ctx, { settings: { ai_provider: 'rule_mock', default_lang: 'ar' } }), RULE, DEPS);
      const allowed = factSet(r.subject + '\n' + r.body_text);
      for (const t of factSet(d.subject + '\n' + d.body_text)) if (!allowed.has(t)) bad.push(m.id + ' ' + t);
      if (m.label.missing.length && (d.body_text !== r.body_text || J(d.missing) !== J(r.missing))) bad.push(m.id + ' missing');
    }
    return bad.length === 0 || bad.slice(0, 10).join(', ');
  });

  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

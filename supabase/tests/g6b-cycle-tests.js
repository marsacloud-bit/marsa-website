#!/usr/bin/env node
/*
  Marsa (مرسى) — G6b step ٢٥ end-to-end messaging cycle (docs/online/G6B_SPEC.md § Tests). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no mailbox, no WhatsApp account,
  no LLM, no keys: the REAL worker.js + pipeline.js + ai-mock.js + mock-email.js + mock-whatsapp.js drive PGlite through
  the service RPCs (as service_role); staff actions go through the staff RPCs (as authenticated, distinct users);
  time is moved by a superuser UPDATE msg_jobs SET next_run_at = now().

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql → fixtures.

  Exit gate (plan step ٢٥): «صفر إرسال غير مصرح وربط موثق».

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6b-cycle-tests.js [/path/to/marsa-website] [--quiet] [--unit]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const UNIT_ONLY = args.includes('--unit');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'inbox-sync');
const G6B_MIGRATION = '20261107000100_g6b_inbox.sql';
const FILES = ['adapters.js', 'mock-email.js', 'mock-whatsapp.js', 'ai-mock.js', 'pipeline.js', 'worker.js'];

// No network anywhere: any fetch is a test failure (the worker is given no fetch).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g6b-cycle-tests'); };

const AD = require(path.join(FN, 'adapters.js'));
const ME = require(path.join(FN, 'mock-email.js'));
const MW = require(path.join(FN, 'mock-whatsapp.js'));
const AI = require(path.join(FN, 'ai-mock.js'));
const PL = require(path.join(FN, 'pipeline.js'));
const WK = require(path.join(FN, 'worker.js'));
const DEPS = Object.assign({}, AD, AI, PL);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
const J = x => JSON.stringify(x);
const FIXED_CLOCK = () => '2026-11-02T09:00:00.000Z';
const cps = s => Array.from(s);
const slice = (s, a, b) => cps(s).slice(a, b).join('');

/* ================================================================== 0. unit checks (no DB) */
async function unitChecks() {
  section('0. unit checks: adapters, mocks, rule provider, pipeline, worker (no DB)');
  const P = AI.createRuleProvider({ clock: FIXED_CLOCK });

  await check('the six scripts expose the spec API', () => {
    const need = {
      adapters: [AD, ['CHANNEL_METHODS', 'CAPABILITY_KEYS', 'AdapterError', 'normalizeInbound', 'normalizeAddress', 'redact', 'scrubText', 'sha256Hex', 'estimateAiCost',
        'AI_PRICES', 'createLiveEmailAdapter', 'createLiveWhatsAppAdapter', 'createLlmProvider', 'LIVE_ENDPOINTS_TO_VERIFY']],
      'mock-email': [ME, ['createMockEmail', 'EMAIL_FIXTURES']], 'mock-whatsapp': [MW, ['createMockWhatsApp', 'WA_FIXTURES']],
      'ai-mock': [AI, ['createRuleProvider', 'RULES', 'DEFAULT_TEMPLATES', 'ACTIONS', 'iso6346CheckDigit', 'foldDigits', 'PROVIDER_VERSION']],
      pipeline: [PL, ['processMessage', 'buildDraft', 'PIPELINE_VERSION']], worker: [WK, ['createWorker', 'runJob']]
    };
    const miss = [];
    for (const k of Object.keys(need)) for (const n of need[k][1]) if (!(n in need[k][0])) miss.push(k + '.' + n);
    return miss.length === 0 || 'missing ' + miss.join(', ');
  });
  await check('classic scripts: no import / export / require, no fetch / XHR / WebSocket, no key literal, G5 dual export', () => {
    const bad = [];
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(FN, f), 'utf8');
      const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
      if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push(f + ': import/require');
      if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|process\.env/.test(s)) bad.push(f + ': network/env');
      if (/(sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(s)) bad.push(f + ': key-like literal');
      if (!/module\.exports = API\) : \(globalThis\.MarsaInbox = Object\.assign\(globalThis\.MarsaInbox \|\| \{\}, API\)\)/.test(src)) bad.push(f + ': dual export');
    }
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    if (!/MARSA_INBOX_ALLOW_MOCK/.test(ts) || !/constantTimeEqual/.test(ts)) bad.push('index.ts: mock gate / constant-time auth');
    if (/\bfetch\s*\(/.test(ts)) bad.push('index.ts: fetch');
    return bad.length === 0 || bad.join('; ');
  });
  await check('loading the scripts as classic scripts fills globalThis.MarsaInbox in the spec load order', () => {
    const vm = require('vm');
    const sandbox = { crypto: globalThis.crypto, TextEncoder, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(FN, f), 'utf8'), sandbox, { filename: f });
    const M = sandbox.MarsaInbox;
    return (M && typeof M.createWorker === 'function' && typeof M.createRuleProvider === 'function' && typeof M.createMockEmail === 'function' &&
      typeof M.processMessage === 'function' && typeof M.normalizeInbound === 'function') || 'MarsaInbox incomplete';
  });

  // ---------------------------------------------------------------- ISO 6346, folding, addresses
  await check('ISO 6346: valid / invalid / spaced / dashed', () => {
    const ok = AI.iso6346CheckDigit('CSQU305438') === 3 && AI.iso6346Valid('CSQU3054383') && !AI.iso6346Valid('CSQU3054384') &&
      AI.iso6346Valid('MSKU 771205 0') && AI.iso6346Valid('TGHU-482913-1') && !AI.iso6346Valid('TCLU9033771') && AI.iso6346CheckDigit('TCLU903377') === 0;
    const ex = P.extract('cntr MSKU 771205 0, TGHU-482913-1 and TCLU9033771', { source: 'body' }).filter(e => e.kind === 'container_no');
    return (ok && ex.length === 3 && ex[0].normalized === 'MSKU7712050' && ex[0].valid && ex[1].normalized === 'TGHU4829131' && ex[1].valid && !ex[2].valid) || J(ex);
  });
  await check('digit folding: Arabic-Indic + Persian → western; offsets refer to the original text', () => {
    const t = 'الحاوية TGHU٤٨٢٩١٣١ بتاريخ ۲۰۲۶-۱۱-۰۴';
    const ex = P.extract(t, { source: 'body' });
    const c = ex.find(e => e.kind === 'container_no'), d = ex.find(e => e.kind === 'date');
    return (AI.foldDigits('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹') === '01234567890123456789' && c && c.normalized === 'TGHU4829131' && c.raw === 'TGHU٤٨٢٩١٣١' &&
      slice(t, c.span.start, c.span.end) === c.raw && d && d.normalized === '2026-11-04' && slice(t, d.span.start, d.span.end) === d.raw) || J(ex);
  });
  await check('normalizeAddress mirrors app.msg_norm_address (e-mail + WhatsApp)', () => {
    const n = AD.normalizeAddress;
    const cases = [
      [n('email', '  Ops@Gulf-Agent.Example '), 'ops@gulf-agent.example'], [n('email', 'not-an-address'), null],
      [n('whatsapp', '٠٥٥١٢٣٤٥٦٧'), '+966551234567'], [n('whatsapp', '00966 55-123-4567'), '+966551234567'],
      [n('whatsapp', '(+966) 55 123 4567'), '+966551234567'], [n('whatsapp', '12345'), null], [n('fax', 'x'), null]
    ];
    const bad = cases.filter(c => c[0] !== c[1]);
    return bad.length === 0 || J(bad);
  });

  // ---------------------------------------------------------------- dates
  await check('dates: ymd, dmy (day first), ambiguous, invalid, English / Arabic / Levantine month names, relative words never dates', () => {
    const t = 'a 2026-11-04 b 25/12/2026 c 05/11/2026 d 31/02/2026 e 4 November 2026 f 7 نوفمبر 2026 g 9 تشرين الثاني 2026 h tomorrow غدًا ASAP';
    const ds = P.extract(t, { source: 'body' }).filter(e => e.kind === 'date');
    const by = r => ds.find(d => d.raw === r) || {};
    const ok = by('2026-11-04').normalized === '2026-11-04' && by('2026-11-04').detail.date_format === 'ymd' &&
      by('25/12/2026').normalized === '2026-12-25' && by('25/12/2026').detail.ambiguous === false &&
      by('05/11/2026').normalized === '2026-11-05' && by('05/11/2026').detail.ambiguous === true &&
      by('31/02/2026').valid === false &&
      by('4 November 2026').normalized === '2026-11-04' && by('7 نوفمبر 2026').normalized === '2026-11-07' &&
      by('9 تشرين الثاني 2026').normalized === '2026-11-09' && ds.length === 7;
    const flags = P.detectInjection(t, {}).flags;
    return (ok && flags.includes('urgency_claim')) || J(ds.map(d => [d.raw, d.normalized, d.valid, d.detail]));
  });
  await check('deadline only from a valid, non-ambiguous date after a deadline phrase (never invented)', () => {
    const s1 = P.summarize({ category: 'empty_return', extractions: P.extract('return before 2026-11-03 please', { source: 'body' }), sender: {} });
    const s2 = P.summarize({ category: 'empty_return', extractions: P.extract('return before 05/11/2026 please', { source: 'body' }), sender: {} });
    const s3 = P.summarize({ category: 'delivery_order', extractions: P.extract('issued on 2026-11-03', { source: 'body' }), sender: {} });
    const s4 = P.summarize({ category: 'empty_return', extractions: P.extract('return the empty tomorrow', { source: 'body' }), sender: {} });
    return (s1.deadline && s1.deadline.extraction_index === 0 && s1.risks.includes('deadline_soon') && s2.deadline === null && s3.deadline === null && s4.deadline === null) || J([s1, s2, s3, s4]);
  });

  // ---------------------------------------------------------------- references
  await check('references: B/L (keyword ar / en + carrier prefix), declaration, invoice, tx_ref, appointment', () => {
    const t = 'B/L No. MEDUJD481516; رقم البوليصة: JED-778812; COSU6412345678; البيان الجمركي 2611004567; invoice no. INV-2026/0045; ' +
      'رقم الفاتورة 7781; MRS-2026-000123; appointment ref APT-55120; bill of lading and the invoice copies';
    const ex = P.extract(t, { source: 'body' });
    const has = (k, v) => ex.some(e => e.kind === k && e.normalized === v && slice(t, e.span.start, e.span.end) === e.raw);
    const ok = has('bl_number', 'MEDUJD481516') && has('bl_number', 'JED778812') && has('bl_number', 'COSU6412345678') && has('declaration_no', '2611004567') &&
      has('invoice_no', 'INV-2026/0045') && has('invoice_no', '7781') && has('tx_ref', 'MRS-2026-000123') && has('appointment_no', 'APT-55120') &&
      !ex.some(e => e.kind === 'bl_number' && /AND/.test(e.normalized));
    return ok || J(ex.map(e => [e.kind, e.normalized, e.raw]));
  });
  await check('a valid container with a carrier prefix is not a B/L; spans count code points (emoji / astral text)', () => {
    const t = '🚢📦 MSCU1234566 B/L 𝐀 MEDUJD481516 ✅';
    const ex = P.extract(t, { source: 'body' });
    const bl = ex.filter(e => e.kind === 'bl_number');
    const allSpans = ex.every(e => slice(t, e.span.start, e.span.end) === e.raw);
    const c = ex.find(e => e.kind === 'container_no');
    return (AI.iso6346Valid('MSCU1234566') && c && c.span.start === 3 && bl.length === 1 && bl[0].normalized === 'MEDUJD481516' && allSpans) || J(ex);
  });

  // ---------------------------------------------------------------- classification
  await check('keyword classifier per category, Arabic + English', () => {
    const cases = [
      ['telex_release', 'Telex release', 'please confirm the telex release and surrender'], ['telex_release', 'طلب تلكس', 'نرجو تأكيد الإفراج'],
      ['delivery_order', 'D/O ready', 'the delivery order is ready'], ['delivery_order', 'إذن تسليم', 'نرجو إصدار إذن تسليم'],
      ['freight_charges', 'Local charges', 'freight invoice'], ['freight_charges', 'رسوم الشحن', 'رسوم محلية مستحقة'],
      ['appointment', 'Appointment', 'booking slot confirmed'], ['appointment', 'حجز موعد', 'تم حجز موعد الفسح'],
      ['missing_documents', 'Missing documents', 'please send the pending documents'], ['missing_documents', 'نواقص', 'المستندات المطلوبة للمعاملة'],
      ['violation', 'Violation', 'a penalty may apply'], ['violation', 'مخالفة', 'غرامة تأخير'],
      ['empty_return', 'Empty return', 'return the empty to the depot'], ['empty_return', 'إرجاع الفارغ', 'إلى ساحة الفوارغ'],
      ['general_inquiry', 'Inquiry', 'what is the status?'], ['general_inquiry', 'استفسار', 'ما حالة المعاملة؟'],
      ['unknown', 'Hello', 'thanks'], ['unknown', 'مرحبا', 'شكرا لكم']
    ];
    const bad = cases.filter(([cat, s, b]) => P.classify({ subject: s, body: b, extractions: [] }).category !== cat)
      .map(([cat, s, b]) => cat + ' ← ' + s + ' → ' + J(P.classify({ subject: s, body: b, extractions: [] })));
    const u = P.classify({ subject: 'x', body: 'telex and delivery order', extractions: [] });
    return (bad.length === 0 && u.category === 'unknown' && u.confidence <= 0.4) || (bad.join('; ') + ' tie:' + J(u));
  });
  await check('classification context: a valid container + "empty" → empty_return; rules carry keywords only', () => {
    const body = 'Container MSKU7712050 is empty now.';
    const ex = P.extract(body, { source: 'body' });
    const c = P.classify({ subject: '', body, extractions: ex });
    return (c.category === 'empty_return' && c.rules.every(r => Object.keys(r).sort().join() === 'keyword,lang,rule')) || J(c);
  });

  // ---------------------------------------------------------------- injection + determinism
  const msgCtx = (key, kind) => {
    const f = kind === 'whatsapp' ? MW.WA_FIXTURES[key] : ME.EMAIL_FIXTURES[key];
    const subj = kind === 'whatsapp' ? '' : f.subject;
    return {
      job: { id: 'j-' + key, org_id: 'o', kind: 'process' }, settings: { ai_provider: 'rule_mock', default_lang: 'ar', ai_monthly_budget_usd: 0, month_to_date_usd: 0 },
      channel: { id: 'c', kind: kind || 'email', address_norm: 'inbox@blue-sea.example' },
      message: { id: 'm-' + key, thread_id: 't', direction: 'inbound', subject: subj, body_text: f.text,
        from: { address_norm: kind === 'whatsapp' ? f.from : f.from.address, name: f.name || (f.from && f.from.name) },
        to: [kind === 'whatsapp' ? '+966500000101' : 'inbox@blue-sea.example'], participants: [], directory_addresses: [],
        attachments: (f.attachments || []).map(a => ({ id: a.id, file_name: a.filename, mime_type: a.contentType, extracted_text: a.text || null })) }
    };
  };
  const sameCore = (a, b) => J(a.extractions.map(e => [e.kind, e.normalized, e.valid, e.span])) === J(b.extractions.map(e => [e.kind, e.normalized, e.valid, e.span])) &&
    J(a.classification) === J(b.classification) && a.summary.action_code === b.summary.action_code && J(a.summary.deadline) === J(b.summary.deadline);
  for (const [k, kind] of [['inj_en', 'email'], ['inj_ar', 'email'], ['inj_att', 'email'], ['inj_file', 'email'], ['inj_wa', 'whatsapp']]) {
    await check('injection fixture ' + k + ': flags injection_suspected + foreign_address; extractions / category / action identical to the clean twin', async () => {
      const a = await PL.processMessage(msgCtx(k, kind), P, DEPS);
      const b = await PL.processMessage(msgCtx(k + '_clean', kind), P, DEPS);
      const evil = J(a.extractions) + J(a.classification) + J(a.summary) + J(a.suggested_template);
      return (a.risk_flags.includes('injection_suspected') && a.risk_flags.includes('foreign_address') && !b.risk_flags.includes('injection_suspected') &&
        sameCore(a, b) && !/evil|447700900123/i.test(evil)) || J({ a: [a.risk_flags, a.classification, a.extractions.length], b: [b.risk_flags, b.classification, b.extractions.length] });
    });
  }
  await check('determinism: the same fixtures give byte-identical process effects; rule_mock cost 0', async () => {
    const keys = Object.keys(ME.EMAIL_FIXTURES);
    const run = async () => { const o = []; for (const k of keys) o.push(await PL.processMessage(msgCtx(k, 'email'), AI.createRuleProvider({ clock: FIXED_CLOCK }), DEPS)); return J(o); };
    const r1 = await run(), r2 = await run();
    const a = JSON.parse(r1);
    return (r1 === r2 && a.every(x => x.ai_run.provider === 'rule_mock' && x.ai_run.est_cost_usd === 0 && /^[0-9a-f]{64}$/.test(x.ai_run.input_sha256))) || 'differs or cost';
  });
  await check('process effects: agent D/O e-mail → delivery_order, ≥ 3 extractions with exact spans (subject / body / attachment), action issue_do', async () => {
    const ctx = msgCtx('agent_do', 'email');
    const e = await PL.processMessage(ctx, P, DEPS);
    const m = ctx.message;
    const srcText = x => x.span.source === 'subject' ? m.subject : x.span.source === 'body' ? m.body_text : m.attachments.find(a => a.id === x.span.attachment_id).extracted_text;
    const spansOk = e.extractions.every(x => slice(srcText(x), x.span.start, x.span.end) === x.raw);
    const kinds = new Set(e.extractions.map(x => x.kind + ':' + x.normalized));
    return (e.classification.category === 'delivery_order' && e.extractions.length >= 3 && spansOk && kinds.has('bl_number:MEDUJD481516') &&
      kinds.has('container_no:MSKU7712050') && kinds.has('container_no:TGHU4829131') && e.extractions.some(x => x.span.source === 'attachment') &&
      e.summary.action_code === 'issue_do' && e.suggested_template === 'delivery_order' && e.risk_flags.length === 0) || J(e);
  });
  await check('summary is template text: no free text copied from the body', async () => {
    const ctx = msgCtx('inj_en', 'email');
    const e = await PL.processMessage(ctx, P, DEPS);
    return (!/Ignore|instructions|Dear team|evil/i.test(e.summary.summary_en + e.summary.summary_ar) && /MEDUJD481516/.test(e.summary.summary_en)) || J(e.summary);
  });
  await check('an invalid check digit flags invalid_check_digit; an ambiguous date flags ambiguous_date', async () => {
    const e = await PL.processMessage(msgCtx('invalid_container', 'email'), P, DEPS);
    return (e.risk_flags.includes('invalid_check_digit') && e.risk_flags.includes('ambiguous_date') && e.summary.deadline === null) || J(e.risk_flags);
  });

  // ---------------------------------------------------------------- drafts
  const draftCtx = (o) => ({
    job: { id: 'jd', org_id: 'o', kind: 'draft' }, settings: { ai_provider: 'rule_mock', default_lang: 'ar' },
    draft: Object.assign({ reply_id: null, thread_id: 't', lang: 'ar', template_key: 'delivery_order', template: null, params: {}, category: 'delivery_order',
      recipient: { address_norm: 'ops@gulf-agent.example', contact_display_name: 'Gulf Shipping Agency', verified: true, authorized: true },
      facts: { public: { tx_ref: 'MRS-2026-000901', operational_status_label: 'قيد التنفيذ' },
        restricted: { bl_number: 'MEDUJD481516', declaration_no: null, container_list: ['MSKU7712050', 'TGHU4829131'], client_name: 'عميل', operation_label: 'استيراد',
          appointment: null, return_deadlines: [], missing_documents: [] } } }, o || {})
  });
  await check('draft (ar): template filled from confirmed facts only; used_facts ⊆ context keys; no clarification', async () => {
    const e = await PL.buildDraft(draftCtx(), P, DEPS);
    const keys = ['tx_ref', 'operational_status_label', 'bl_number', 'declaration_no', 'container_list', 'client_name', 'operation_label', 'appointment', 'return_deadlines', 'missing_documents'];
    return (!e.clarification && /MEDUJD481516/.test(e.subject + e.body_text) && /MSKU7712050/.test(e.body_text) && /MRS-2026-000901/.test(e.body_text) &&
      e.used_facts.every(k => keys.includes(k)) && e.used_facts.includes('bl_number') && !('to' in e) && !('attachments' in e) && e.template_key === 'delivery_order') || J(e);
  });
  await check('draft for an unverified / unauthorized recipient = clarification + recipient_verification, no restricted fact', async () => {
    const c = draftCtx({ recipient: { address_norm: 'someone@unknown-trading.example', contact_display_name: null, verified: false, authorized: false },
      facts: { public: { tx_ref: 'MRS-2026-000901' } } });
    const e = await PL.buildDraft(c, P, DEPS);
    return (e.clarification && e.missing.includes('recipient_verification') && !/MEDUJD481516|MSKU7712050|MRS-2026-000901/.test(e.body_text + e.subject) && e.used_facts.length === 0) || J(e);
  });
  await check('draft with a missing confirmed B/L asks for exactly that (never guesses)', async () => {
    const c = draftCtx({ lang: 'en' });
    c.draft.facts.restricted.bl_number = null;
    const e = await PL.buildDraft(c, P, DEPS);
    return (e.clarification && J(e.missing) === J(['bl_number']) && /bill of lading number/.test(e.body_text) && e.lang === 'en') || J(e);
  });
  await check('an approved org template is used as given (plain substitution, unknown placeholder → empty)', async () => {
    const c = draftCtx({ template: { key: 'delivery_order', version: 3, lang: 'ar', subject_tpl: 'إذن {{bl_number}}', body_tpl: 'نص {{container_list}} {{evil_expr}} {{signature}}', status: 'approved' },
      params: { signature: { text_ar: 'فريق مرسى', text_en: 'Marsa team' } } });
    const e = await PL.buildDraft(c, P, DEPS);
    return (e.subject === 'إذن MEDUJD481516' && /^نص MSKU7712050، TGHU4829131  فريق مرسى/.test(e.body_text) && e.template_version === 3) || J(e);
  });
  await check('every DEFAULT_TEMPLATES key exists in ar + en and uses only allowed placeholders', () => {
    const keys = ['telex_release', 'delivery_order', 'freight_charges', 'empty_return_instructions', 'missing_documents', 'violation_response', 'clarification', 'ack_receipt'];
    const bad = [];
    for (const k of keys) for (const l of ['ar', 'en']) {
      const t = AI.DEFAULT_TEMPLATES[k] && AI.DEFAULT_TEMPLATES[k][l];
      if (!t) { bad.push(k + '.' + l); continue; }
      for (const p of AI.placeholdersOf(t.subject_tpl + t.body_tpl)) if (!AI.PLACEHOLDERS.includes(p)) bad.push(k + '.' + l + ':' + p);
    }
    const noMoney = !/\d+(\.\d+)?\s*(SAR|ريال)/.test(J(AI.DEFAULT_TEMPLATES));
    return (bad.length === 0 && noMoney) || bad.join(', ');
  });

  // ---------------------------------------------------------------- AI cost, LLM + live stubs
  await check('estimateAiCost: tokens = ceil(chars / 4); rule_mock 0; llm_pending unknown (null)', () => {
    const a = AD.estimateAiCost({ provider: 'rule_mock', input_chars: 9, output_chars: 4 });
    const b = AD.estimateAiCost({ provider: 'llm_pending', input_chars: 1, output_chars: 1 });
    return (a.est_input_tokens === 3 && a.est_output_tokens === 1 && a.est_cost_usd === 0 && b.est_cost_usd === null && AD.AI_PRICES.rule_mock === 0) || J([a, b]);
  });
  await check('live adapters and the LLM provider throw not_configured (no network); llm_pending settings fail the AI job', async () => {
    const errs = [];
    for (const a of [AD.createLiveEmailAdapter({}), AD.createLiveWhatsAppAdapter({})]) {
      for (const m of AD.CHANNEL_METHODS) { try { await a[m]({}); errs.push(m + ' did not throw'); } catch (e) { if (e.kind !== 'not_configured' || e.applied !== 'no') errs.push(m + ':' + e.kind); } }
    }
    const L = AD.createLlmProvider();
    for (const m of AD.AI_METHODS) { try { L[m]('x'); errs.push('llm ' + m); } catch (e) { if (e.kind !== 'not_configured') errs.push('llm ' + m + ':' + e.kind); } }
    const ctx = msgCtx('agent_do', 'email'); ctx.settings.ai_provider = 'llm_pending';
    const r = await WK.runJob(ctx, null, { deps: DEPS, provider: P, clock: FIXED_CLOCK });
    if (!(r.outcome === 'failed' && r.error.kind === 'not_configured')) errs.push('llm job ' + J(r));
    if (AD.LIVE_ENDPOINTS_TO_VERIFY.length < 10) errs.push('endpoints list');
    return errs.length === 0 || errs.join('; ');
  });

  // ---------------------------------------------------------------- normalizeInbound + mocks
  await check('normalizeInbound: HTML → text, canonical e-mail + WhatsApp shapes, raw without bodies, limits', () => {
    const m = ME.createMockEmail({ channelAddress: 'inbox@blue-sea.example', clock: FIXED_CLOCK, deps: AD });
    const raw = m.control.deliverInbound('agent_do', { html: '<p>Hello <b>D/O</b></p><script>alert(1)</script><img src=x onerror=alert(1)>' });
    const c = AD.normalizeInbound(raw, { kind: 'email' });
    const w = MW.createMockWhatsApp({ channelAddress: '+966500000101', clock: FIXED_CLOCK, deps: AD });
    const wc = AD.normalizeInbound(w.control.deliverInbound('appointment'), { kind: 'whatsapp' });
    let tooMany = false;
    try { AD.normalizeInbound(Object.assign({}, raw, { attachments: Array.from({ length: 21 }, (_, i) => ({ id: 'a' + i, size: 1 })) }), { kind: 'email' }); }
    catch (e) { tooMany = e.kind === 'validation'; }
    const keys = 'attachments,auth,body_text,cc,from,headers,kind,provider_message_id,raw,sent_at,subject,to';
    return (c.body_text === 'Hello D/O' && Object.keys(c).sort().join() === keys && c.headers.message_id === '<em-1@mock-mail.invalid>' &&
      c.auth.spf === 'pass' && c.attachments[0].file_name === 'DO-request.pdf' && !J(c.raw).includes('Hello') && !J(c.raw).includes('Delivery Order request') &&
      wc.kind === 'whatsapp' && wc.from.address === '+966551234567' && wc.provider_message_id === 'wamid.1' && /TGHU٤٨٢٩١٣١/.test(wc.body_text) && wc.wa_context &&
      tooMany) || J([c, wc]);
  });
  await check('mock send is idempotent by request_id (a repeat returns the first result, one sent item)', async () => {
    const m = ME.createMockEmail({ channelAddress: 'inbox@blue-sea.example', clock: FIXED_CLOCK, deps: AD });
    const req = { request_id: 'MRSO-0123456789ABCDEF', to: [{ address_norm: 'ops@gulf-agent.example' }], subject: 's', body_text: 'b' };
    const a = await m.send(req), b = await m.send(req);
    m.control.loseResponse('send');
    let lost = null;
    try { await m.send(Object.assign({}, req, { request_id: 'MRSO-1111111111111111' })); } catch (e) { lost = e; }
    const lk = await m.lookupSend('MRSO-1111111111111111');
    m.control.disableLookup();
    let unsup = null;
    try { await m.lookupSend('MRSO-1111111111111111'); } catch (e) { unsup = e; }
    return (a.provider_message_id === b.provider_message_id && m.control.count('sent', s => s.request_id === req.request_id) === 1 &&
      lost && lost.applied === 'unknown' && lk.found && unsup && unsup.code === 'unsupported') || J([a, b, lost, lk]);
  });
  await check('WhatsApp mock enforces the 24-hour window (window_closed)', async () => {
    let now = '2026-11-02T09:00:00.000Z';
    const w = MW.createMockWhatsApp({ channelAddress: '+966500000101', clock: () => now, deps: AD });
    w.control.deliverInbound('appointment', { sent_at: '2026-11-02T08:00:00.000Z' });
    const ok = await w.send({ request_id: 'MRSO-AAAAAAAAAAAAAAAA', to: ['+966551234567'], body_text: 'x' });
    now = '2026-11-03T09:00:01.000Z';
    let closed = null;
    try { await w.send({ request_id: 'MRSO-BBBBBBBBBBBBBBBB', to: ['+966551234567'], body_text: 'x' }); } catch (e) { closed = e; }
    return (ok.status === 'accepted' && closed && closed.kind === 'window_closed' && closed.applied === 'no') || J(closed);
  });
  await check('worker runJob (send): unknown → lookup adopts, no second send; calls carry no body / subject / address', async () => {
    const m = ME.createMockEmail({ channelAddress: 'inbox@blue-sea.example', clock: FIXED_CLOCK, deps: AD });
    const ctx = { job: { id: 'j', org_id: 'o', kind: 'send', previous_status: 'queued' }, channel: { id: 'c', kind: 'email', mode: 'mock' },
      send: { outbound_id: 'ob-1', provider_request_id: 'MRSO-00000000000000AB', from: 'inbox@blue-sea.example', to: [{ address_norm: 'ops@gulf-agent.example' }], cc: [],
        subject: 'Secret subject line', body_text: 'Body with B/L MEDUJD481516', attachments: [] } };
    m.control.loseResponse('send');
    const r1 = await WK.runJob(ctx, m, { deps: DEPS, clock: FIXED_CLOCK });
    const r2 = await WK.runJob(Object.assign({}, ctx, { job: Object.assign({}, ctx.job, { previous_status: 'unknown' }) }), m, { deps: DEPS, clock: FIXED_CLOCK });
    const callsText = J(r1.calls) + J(r2.calls);
    return (r1.outcome === 'unknown' && r2.outcome === 'ok' && r2.effects.found_by === 'lookup' && m.control.count('sent') === 1 && m.control.count('send_calls') === 1 &&
      !/Secret subject|MEDUJD481516|gulf-agent|blue-sea/.test(callsText) && /"sha256":"[0-9a-f]{64}"/.test(callsText)) || J([r1, r2]);
  });
  await check('worker runJob (send): failed applied:no → retry; validation → failed; lookup unsupported → unknown (human)', async () => {
    const m = ME.createMockEmail({ channelAddress: 'inbox@blue-sea.example', clock: FIXED_CLOCK, deps: AD });
    const ctx = pid => ({ job: { id: 'j', org_id: 'o', kind: 'send', previous_status: 'queued' }, channel: { id: 'c', kind: 'email', mode: 'mock' },
      send: { outbound_id: 'ob-' + pid, provider_request_id: 'MRSO-00000000000000' + pid, from: 'inbox@blue-sea.example', to: [{ address_norm: 'ops@gulf-agent.example' }], cc: [], subject: 's', body_text: 'b', attachments: [] } });
    m.control.failNext('send', 'network', { applied: 'no' });
    const a = await WK.runJob(ctx('C1'), m, { deps: DEPS, clock: FIXED_CLOCK });
    const v = await WK.runJob(Object.assign(ctx('C2'), {}), m, { deps: DEPS, clock: FIXED_CLOCK });
    const bad = ctx('C3'); bad.send.to = [];
    const f = await WK.runJob(bad, m, { deps: DEPS, clock: FIXED_CLOCK });
    m.control.disableLookup();
    const u = ctx('C4'); u.job.previous_status = 'unknown';
    const x = await WK.runJob(u, m, { deps: DEPS, clock: FIXED_CLOCK });
    return (a.outcome === 'retry' && a.effects.applied === 'no' && v.outcome === 'ok' && f.outcome === 'failed' && f.effects.applied === 'no' &&
      x.outcome === 'unknown' && x.error.code === 'lookup_unsupported' && m.control.count('send_calls') === 3) || J([a, v, f, x]);
  });
  await check('worker lease fencing: a failed renewal sends nothing (retry, applied no)', async () => {
    const m = ME.createMockEmail({ channelAddress: 'inbox@blue-sea.example', clock: FIXED_CLOCK, deps: AD });
    const ctx = { job: { id: 'j', org_id: 'o', kind: 'send', previous_status: 'queued' }, channel: { id: 'c', kind: 'email' },
      send: { outbound_id: 'ob', provider_request_id: 'MRSO-00000000000000FF', to: [{ address_norm: 'ops@gulf-agent.example' }], subject: 's', body_text: 'b' } };
    const r = await WK.runJob(ctx, m, { deps: DEPS, clock: FIXED_CLOCK, beforeWrite: async () => { throw new Error('MRS_BAD_TRANSITION lease_lost'); } });
    return (r.outcome === 'retry' && r.error.kind === 'lease_lost' && m.control.count('sent') === 0) || J(r);
  });
}

/* ================================================================== DB harness */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';     // branch A1
const DMM = '0b5e0000-0000-4000-8000-000000000012';     // branch A2
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102';
const B = 'c6b00000-0000-4000-8000-0000000000b1';
const B_BR = 'c6b00000-0000-4000-8000-0000000000b2';
const B_CL = 'c6b00000-0000-4000-8000-0000000000b3';
const TX1 = 'c6b00000-0000-4000-8000-000000000201';
const TX2 = 'c6b00000-0000-4000-8000-000000000202';
const TXB = 'c6b00000-0000-4000-8000-000000000205';
const AGENT_P = 'c6b00000-0000-4000-8000-000000000401';
const PORT_P = 'c6b00000-0000-4000-8000-000000000402';
const DOC_BL = 'c6b00000-0000-4000-8000-000000000501';
const DOC_DO = 'c6b00000-0000-4000-8000-000000000502';
const DOC_INV = 'c6b00000-0000-4000-8000-000000000503';
const U = {
  adminA: 'c6b00000-0000-4000-8000-000000000001', opsA: 'c6b00000-0000-4000-8000-000000000002', brA: 'c6b00000-0000-4000-8000-000000000003',
  supA: 'c6b00000-0000-4000-8000-000000000004', clrA: 'c6b00000-0000-4000-8000-000000000005', clrA2: 'c6b00000-0000-4000-8000-000000000006',
  trnA: 'c6b00000-0000-4000-8000-000000000007', clientA: 'c6b00000-0000-4000-8000-000000000008', adminB: 'c6b00000-0000-4000-8000-000000000009',
  opsB: 'c6b00000-0000-4000-8000-00000000000a'
};
const CH = { email: 'inbox@blue-sea.example', wa: '+966500000101', bEmail: 'inbox@org-b.example' };
const EVIL = 'x@evil.example';
let keySeq = 0;
const newKey = () => `0e6b0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (!U[who]) throw new Error('unknown user ' + who);
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ service rpc for the worker (PGlite as service_role) */
const SVC_TYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_channel: 'uuid', p_state: 'jsonb', p_version: 'int', p_messages: 'jsonb', p_events: 'jsonb' };
const SERVICE_RPCS = ['msg_ingest_messages', 'msg_record_delivery', 'msg_claim_jobs', 'msg_complete_job', 'msg_renew_lease', 'msg_schedule', 'msg_mock_load', 'msg_mock_save'];
const claimed = [];         // every claim context handed to the worker
const completions = [];     // {ctx kind, result}
async function svc(name, argsObj) {
  if (!SERVICE_RPCS.includes(name)) throw new Error('worker may call only msg_* service RPCs, got ' + name);
  const keys = Object.keys(argsObj || {});
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${SVC_TYPES[k] || 'text'}`).join(', ')}) r`;
  const vals = keys.map(k => (SVC_TYPES[k] === 'jsonb' ? JSON.stringify(argsObj[k]) : argsObj[k]));
  const r = await asService(async () => (await q(sql, vals))[0].r);
  if (name === 'msg_claim_jobs') for (const c of (r || [])) claimed.push(c);
  if (name === 'msg_complete_job') completions.push({ attempt: argsObj.p_attempt, result: argsObj.p_result, done: r });
  return r;
}

/* ------------------------------------------------------------------ mocks and worker */
const mocks = {};            // channel id → adapter
const mockOrg = {};          // channel id → org id
const adapterUse = [];       // {job_org, channel_org}
function adapterFor(channel, orgId) {
  const m = mocks[channel.id];
  if (!m) throw new Error('no mock for channel ' + channel.id);
  if (channel.mode === 'live_pending') return channel.kind === 'whatsapp' ? AD.createLiveWhatsAppAdapter({}) : AD.createLiveEmailAdapter({});
  adapterUse.push({ job_org: orgId, channel_org: mockOrg[channel.id] });
  return m;
}
const CLOCK = () => new Date().toISOString();   // the mocks follow the real clock (PGlite now()): the WhatsApp window and dates agree with SQL
let worker;
async function runAll(max) {
  const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, errors: 0, results: [] };
  for (let i = 0; i < (max || 30); i++) {
    const r = await worker.runOnce({ limit: 5 });
    for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
    tot.results.push(...r.results);
    if (!r.claimed) break;
  }
  if (tot.errors) throw new Error('complete_job errors: ' + J(tot.results.filter(x => x.complete_error)));
  return tot;
}
const wake = () => q(`UPDATE public.msg_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);
const schedule = async () => { await q(`UPDATE public.msg_channels SET last_poll_at = now() - interval '5 minutes'`); return svc('msg_schedule', { p_limit: 50 }); };
async function pollAndProcess() { await schedule(); await wake(); return runAll(); }

/* ------------------------------------------------------------------ staff RPC shortcuts */
const S = {
  saveChannel: (who, org, p) => rpc(who, `SELECT public.save_msg_channel($1, $2, $3) r`, [org, p, newKey()]),
  probe: (who, ch) => rpc(who, `SELECT public.request_msg_channel_probe($1, $2) r`, [ch, newKey()]),
  saveContact: (who, org, p) => rpc(who, `SELECT public.save_msg_contact($1, $2, $3) r`, [org, p, newKey()]),
  addAddress: (who, c, p) => rpc(who, `SELECT public.add_msg_contact_address($1, $2, $3) r`, [c, p, newKey()]),
  verify: (who, a) => rpc(who, `SELECT public.verify_msg_contact_address($1, 'callback', 'تم التحقق هاتفيًا من الرقم الرسمي') r`, [a]),
  grant: (who, c, p, note) => rpc(who, `SELECT public.grant_msg_authorization($1, $2, $3) r`, [c, p, note || 'تفويض رسمي بخطاب الوكيل']),
  thread: (who, id) => rpc(who, `SELECT public.get_msg_thread($1) r`, [id]),
  threads: (who, org, f) => rpc(who, `SELECT public.list_msg_threads($1, $2) r`, [org, f || {}]),
  link: (who, t, tx, note) => rpc(who, `SELECT public.link_msg_thread($1, $2, $3) r`, [t, tx, note || null]),
  review: (who, id, d, v, note) => rpc(who, `SELECT public.review_msg_extraction($1, $2, $3, $4) r`, [id, d, v || null, note || null]),
  draft: (who, t, p) => rpc(who, `SELECT public.request_msg_draft($1, $2, $3) r`, [t, p || {}, newKey()]),
  saveReply: (who, id, p) => rpc(who, `SELECT public.save_msg_reply($1, $2, $3) r`, [id, p, newKey()]),
  suggestions: (who, id) => rpc(who, `SELECT public.msg_attachment_suggestions($1) r`, [id]),
  setAtt: (who, id, docs) => rpc(who, `SELECT public.set_msg_reply_attachments($1, $2::uuid[]) r`, [id, docs]),
  submit: (who, id) => rpc(who, `SELECT public.submit_msg_reply($1) r`, [id]),
  decide: (who, id, v, d, note, ack) => rpc(who, `SELECT public.decide_msg_reply($1, $2, $3, $4, $5) r`, [id, v, d, note || null, !!ack]),
  send: (who, id, key) => rpc(who, `SELECT public.send_msg_reply($1, $2) r`, [id, key || newKey()]),
  retrySend: (who, ob) => rpc(who, `SELECT public.retry_msg_send($1) r`, [ob]),
  resolve: (who, ob, d, note) => rpc(who, `SELECT public.resolve_msg_send_unknown($1, $2, $3) r`, [ob, d, note]),
  txMessages: (who, tx) => rpc(who, `SELECT public.tx_messages($1) r`, [tx])
};
const threadOfMsg = async pid => one(`SELECT t.* FROM public.msg_messages m JOIN public.msg_threads t ON t.id = m.thread_id WHERE m.provider_message_id = $1`, [pid]);
const msgRow = pid => one(`SELECT * FROM public.msg_messages WHERE provider_message_id = $1`, [pid]);
const replyRow = id => one(`SELECT * FROM public.msg_replies WHERE id = $1`, [id]);
const outRow = id => one(`SELECT * FROM public.msg_outbound WHERE id = $1`, [id]);
const replyOf = r => (r && r.reply) ? r.reply : r;
const idOf = r => (r && (r.id || (r.reply && r.reply.id) || (r.thread && r.thread.id))) || r;
async function latestVersion(replyId) { return one(`SELECT * FROM public.msg_reply_versions WHERE reply_id = $1 ORDER BY version_no DESC LIMIT 1`, [replyId]); }
async function replyOfThread(t) { return one(`SELECT * FROM public.msg_replies WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`, [t]); }

/* ================================================================== fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g6bcycle.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'org-b-g6b', 'مؤسسة ب التجريبية', 'OBB');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.opsA}', '${A}', NULL, 'operations_manager'), ('${U.brA}', '${A}', '${JED}', 'branch_manager'),
      ('${U.supA}', '${A}', NULL, 'supervisor'), ('${U.clrA}', '${A}', '${JED}', 'clearance_staff'), ('${U.clrA2}', '${A}', '${DMM}', 'clearance_staff'),
      ('${U.trnA}', '${A}', NULL, 'transport_staff'), ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.adminB}', '${B}', NULL, 'admin'), ('${U.opsB}', '${B}', NULL, 'operations_manager');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.parties (id, org_id, kinds, name_ar, name_en) VALUES
      ('${AGENT_P}', '${A}', ARRAY['shipping_agent'], 'وكالة الخليج للشحن', 'Gulf Shipping Agency'),
      ('${PORT_P}', '${A}', ARRAY['terminal_operator'], 'إشعارات الميناء', 'Port Authority Notices');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description, bl_number, declaration_no) VALUES
      ('${TX1}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 2, 'أجهزة', 'MEDUJD481516', '2611004567'),
      ('${TX2}', '${A}', '${JED}', '${CL102}', 'import', 'sea', 1, 'مواد غذائية', NULL, NULL),
      ('${TXB}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 1, 'ملابس', 'MEDUJD481516', NULL);
    -- the G3 mirror created the B/L row + primary link from transactions.bl_number: name its shipping agent
    UPDATE public.bills_of_lading SET shipping_agent_id = '${AGENT_P}' WHERE org_id = '${A}' AND bl_number = 'MEDUJD481516';
    INSERT INTO public.containers (org_id, transaction_id, container_no, container_type, return_deadline) VALUES
      ('${A}', '${TX1}', 'MSKU7712050', '40hc', DATE '2026-11-20'), ('${A}', '${TX1}', 'TGHU4829131', '40hc', DATE '2026-11-20'),
      ('${A}', '${TX2}', 'CAIU5603185', '20ft', DATE '2026-11-15'), ('${B}', '${TXB}', 'MSKU7712050', '40hc', NULL);
    INSERT INTO public.documents (id, org_id, transaction_id, kind, classification, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by) VALUES
      ('${DOC_BL}', '${A}', '${TX1}', 'bill_of_lading', 'bill_of_lading', '${A}/${TX1}/${DOC_BL}/bl.pdf', repeat('a', 64), 'bl.pdf', 'application/pdf', 1000, '${U.clrA}'),
      ('${DOC_DO}', '${A}', '${TX1}', 'delivery_order', 'delivery_order', '${A}/${TX1}/${DOC_DO}/do.pdf', repeat('b', 64), 'do.pdf', 'application/pdf', 1000, '${U.clrA}'),
      ('${DOC_INV}', '${A}', '${TX1}', 'commercial_invoice', 'commercial_invoice', '${A}/${TX1}/${DOC_INV}/inv.pdf', repeat('c', 64), 'inv.pdf', 'application/pdf', 1000, '${U.clrA}');
  `);
}

/* ================================================================== the cycle */
const C = {};
const toAI = s => String(s).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
const isoDate = d => d.toISOString().slice(0, 10);
const ago = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
const extrOf = msgId => q(`SELECT * FROM public.msg_extractions WHERE message_id = $1 ORDER BY source, span_start, kind`, [msgId]);
const clsOf = msgId => one(`SELECT * FROM public.msg_classifications WHERE message_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [msgId]);
const lastLink = t => one(`SELECT * FROM public.msg_thread_links WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [t]);
const strongKinds = basis => [...new Set(((basis && basis.signals) || []).filter(s => s.strength === 'strong').map(s => s.kind))];

// a reply on thread t: created by `author`, submitted by `author`, approved by `approver`; → reply row
async function approvedReply(t, author, approver, body) {
  const r = await S.saveReply(author, null, { thread_id: t, lang: 'en', subject: 'Re: follow-up', body_text: body || 'Follow-up from the clearance team.' });
  const id = r.id;
  await S.submit(author, id);
  const v = (await replyRow(id)).current_version_id;
  await S.decide(approver, id, v, 'approve', null, false);
  return replyRow(id);
}
async function sendAndRun(who, replyId) {
  const s = await S.send(who, replyId);
  const res = await runAll();
  return { send: s, outbound: await outRow(s.outbound.id), run: res };
}

async function cycle() {
  section('1. setup: channels (mock), probe → connected, contacts + verified agent + authorization');
  C.chA = await step('admin A: e-mail channel (branch A1, ingest + send, provider terms acknowledged)', () => S.saveChannel('adminA', A,
    { kind: 'email', name: 'بريد العمليات', address: CH.email, default_branch_id: JED, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }));
  C.chW = await step('admin A: WhatsApp channel (org-wide)', () => S.saveChannel('adminA', A,
    { kind: 'whatsapp', name: 'واتساب العمليات', address: '0500000101', default_branch_id: null, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }));
  C.chB = await step('admin B: e-mail channel of org B', () => S.saveChannel('adminB', B,
    { kind: 'email', name: 'بريد ب', address: CH.bEmail, default_branch_id: B_BR, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }));
  await expectErr('one provider account belongs to one org: org B cannot register org A address (address_taken)',
    () => S.saveChannel('adminB', B, { kind: 'email', name: 'نسخة', address: 'INBOX@blue-sea.example', mode: 'mock' }), /MRS_INVALID.*address_taken/);
  await expectErr('a non-admin cannot add a channel', () => S.saveChannel('opsA', A, { kind: 'email', name: 'x', address: 'x@blue-sea.example' }), /MRS_FORBIDDEN/);
  mocks[C.chA.id] = ME.createMockEmail({ channelAddress: CH.email, clock: CLOCK, deps: AD }); mockOrg[C.chA.id] = A;
  mocks[C.chW.id] = MW.createMockWhatsApp({ channelAddress: CH.wa, clock: CLOCK, deps: AD }); mockOrg[C.chW.id] = A;
  mocks[C.chB.id] = ME.createMockEmail({ channelAddress: CH.bEmail, clock: CLOCK, deps: AD }); mockOrg[C.chB.id] = B;
  C.MA = mocks[C.chA.id]; C.MW = mocks[C.chW.id]; C.MB = mocks[C.chB.id];
  await check('the WhatsApp channel address is normalized (05… → +9665…)', async () => (await one(`SELECT address_norm FROM public.msg_channels WHERE id = $1`, [C.chW.id])).address_norm === CH.wa);
  await expectErr('ingest refused before the probe (channel not connected)',
    () => svc('msg_ingest_messages', { p_channel: C.chA.id, p_messages: [AD.normalizeInbound(ME.createMockEmail({ channelAddress: CH.email, deps: AD }).control.deliverInbound('agent_do'), { kind: 'email' })] }),
    /channel_not_connected/);
  for (const ch of [C.chA, C.chW]) await S.probe('adminA', ch.id);
  await S.probe('adminB', C.chB.id);
  const pr = await step('worker: three probes → connected', () => runAll());
  await check('all three channels connected with mock capabilities', async () => {
    const rows = await q(`SELECT status, capabilities_source, capabilities FROM public.msg_channels ORDER BY created_at`);
    return (rows.length === 3 && rows.every(r => r.status === 'connected' && r.capabilities_source === 'mock' && r.capabilities.send.supported === true) && pr.ok === 3) || J(rows);
  });

  C.agent = await step('ops A: contact «Gulf Shipping Agency» (party = shipping agent of TX-1)', () => S.saveContact('opsA', A,
    { display_name: 'Gulf Shipping Agency', entity_type: 'party', party_id: AGENT_P, role_label: 'مسؤول إذن التسليم', lang: 'en' }));
  C.agentAddr = await step('ops A: agent address added', () => S.addAddress('opsA', C.agent.id, { kind: 'email', address: 'Ops@Gulf-Agent.example' }));
  await expectErr('clearance staff cannot verify an address (msg_verify)', () => S.verify('clrA', C.agentAddr.id), /MRS_FORBIDDEN/);
  await step('ops A: verifies the agent address (callback)', () => S.verify('opsA', C.agentAddr.id));
  await step('ops A: authorization (party scope, may receive delivery_order + bill_of_lading)', () => S.grant('opsA', C.agent.id,
    { scope_type: 'party', party_id: AGENT_P, may_receive_kinds: ['delivery_order', 'bill_of_lading'], may_discuss: ['telex_release', 'delivery_order', 'freight_charges', 'appointment', 'missing_documents', 'violation', 'empty_return', 'general_inquiry', 'unknown'] }));
  C.port = await step('ops A: contact «Port Authority Notices» (known, not verified)', () => S.saveContact('opsA', A,
    { display_name: 'Port Authority Notices', entity_type: 'party', party_id: PORT_P, lang: 'en' }));
  await step('ops A: port authority address (unverified)', () => S.addAddress('opsA', C.port.id, { kind: 'email', address: 'notices@port-authority.example' }));
  C.client = await step('ops A: client contact of TX-1 (unverified)', () => S.saveContact('opsA', A,
    { display_name: 'شركة الاختبار الأولى — المشتريات', entity_type: 'client', client_id: CL101, lang: 'ar' }));

  await check('ai-mock DEFAULT_TEMPLATES mirror app.msg_default_templates() (ar + en, every key)', async () => {
    const rows = await q(`SELECT template_key, lang, subject_tpl, body_tpl FROM app.msg_default_templates()`);
    const bad = rows.filter(r => !AI.DEFAULT_TEMPLATES[r.template_key] || AI.DEFAULT_TEMPLATES[r.template_key][r.lang].subject_tpl !== r.subject_tpl ||
      AI.DEFAULT_TEMPLATES[r.template_key][r.lang].body_tpl !== r.body_tpl).map(r => r.template_key + '.' + r.lang);
    return (rows.length === 16 && bad.length === 0) || bad.join(', ');
  });

  /* ------------------------------------------------------------ 2 */
  section('2. valid agent e-mail: poll → process → auto_linked → AI draft → edit → four-eyes → approve → send → delivered');
  C.raw1 = C.MA.control.deliverInbound('agent_do', { sent_at: ago(1) });
  const r2 = await step('poll + process', () => pollAndProcess());
  C.m1 = await msgRow('em-1');
  C.t1 = await threadOfMsg('em-1');
  await check('one inbound copy, recipient = the channel address, sender verified, SPF/DKIM pass', () =>
    (C.m1 && C.m1.direction === 'inbound' && C.m1.recipient_address_norm === CH.email && C.m1.sender_status === 'verified' && C.m1.auth_results.spf === 'pass' &&
     /^[0-9a-f]{64}$/.test(C.m1.body_sha256) && r2.failed === 0) || J([C.m1 && C.m1.sender_status, r2]));
  await check('attachment metadata stored, bytes not fetched (storage_status not_fetched, bucket messages)', async () => {
    const a = await q(`SELECT * FROM public.msg_attachments WHERE message_id = $1`, [C.m1.id]);
    return (a.length === 1 && a[0].file_name === 'DO-request.pdf' && a[0].storage_status === 'not_fetched' && a[0].storage_bucket === 'messages') || J(a);
  });
  await check('≥ 3 extractions whose spans equal the exact source slice (SQL substr, code points)', async () => {
    const ex = await extrOf(C.m1.id);
    const bad = [];
    for (const e of ex) {
      const src = e.source === 'subject' ? C.m1.subject : e.source === 'body' ? C.m1.body_text
        : (await one(`SELECT extracted_text FROM public.msg_attachments WHERE id = $1`, [e.attachment_id])).extracted_text;
      if (slice(src, e.span_start, e.span_end) !== e.raw) bad.push(e.kind);
    }
    const kinds = new Set(ex.map(e => e.kind + ':' + e.normalized));
    return (ex.length >= 3 && bad.length === 0 && kinds.has('bl_number:MEDUJD481516') && kinds.has('container_no:MSKU7712050') && kinds.has('container_no:TGHU4829131')) || J([ex.length, bad]);
  });
  await check('classification delivery_order (ai suggestion); summary action issue_do', async () => {
    const c = await clsOf(C.m1.id);
    const s = await one(`SELECT * FROM public.msg_summaries WHERE message_id = $1`, [C.m1.id]);
    return (c.category === 'delivery_order' && c.source === 'ai' && C.t1.category === 'delivery_order' && s.action_code === 'issue_do' && !/Please collect/.test(s.summary_en)) || J([c, s]);
  });
  await check('auto_linked to TX-1 with a documented basis (B/L + container, verified related sender), branch = TX-1 branch', async () => {
    const l = await lastLink(C.t1.id);
    const sk = strongKinds(l.basis);
    return (C.t1.match_status === 'auto_linked' && C.t1.transaction_id === TX1 && C.t1.branch_id === JED && l.action === 'auto_link' && l.method === 'auto' &&
      l.actor === null && sk.includes('bl_number') && sk.includes('container_no') && l.basis.sender.status === 'verified' && l.basis.rule === 'two_strong_single') || J([C.t1.match_status, l]);
  });
  await check('event thread_linked on TX-1 without body / subject / address', async () => {
    const ev = await q(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'message' AND payload ->> 'op' = 'thread_linked'`, [TX1]);
    return (ev.length === 1 && !/gulf|D\/O ready|MEDU|collect/i.test(J(ev))) || J(ev);
  });
  await check('only a process job was created by the ingest (no draft / send job)', async () =>
    (await num(`SELECT count(*) n FROM public.msg_jobs WHERE thread_id = $1 AND kind <> 'process'`, [C.t1.id])) === 0);

  const dr = await step('clearance staff: request an Arabic draft (delivery_order)', () => S.draft('clrA', C.t1.id, { lang: 'ar', template_key: 'delivery_order' }));
  await check('the draft job stays queued until the worker runs (worker_note)', () => (dr.job && dr.job.status === 'queued' && !dr.reply) || J(dr));
  await step('worker: draft job', () => runAll());
  C.rep1 = await replyOfThread(C.t1.id);
  await check('AI version: template filled from confirmed data only, recipient = the sender, nothing attached, no clarification', async () => {
    const v = await latestVersion(C.rep1.id);
    return (v.author_kind === 'ai_mock' && v.author_id === null && v.requested_by === U.clrA && !v.clarification && /MEDUJD481516/.test(v.subject + v.body_text) &&
      /MSKU7712050/.test(v.body_text) && /TGHU4829131/.test(v.body_text) && !/Please collect|Dear Marsa/.test(v.body_text) && v.to_addresses.length === 1 && v.to_addresses[0].address_norm === 'ops@gulf-agent.example' && v.to_addresses[0].contact_id === C.agent.id &&
      v.template_version === 0 && !/السادة السادة/.test(v.body_text) &&
      J(v.attachments) === '[]' && v.used_facts.includes('bl_number') && C.rep1.status === 'draft') || J(v);
  });
  await check('attachment suggestions (delivery_order → B/L + D/O docs) carry can_share; nothing attached by the suggestion', async () => {
    const s = await S.suggestions('clrA', C.rep1.id);
    const ids = s.items.map(i => i.document_id).sort();
    const v = await latestVersion(C.rep1.id);
    return (J(ids) === J([DOC_BL, DOC_DO].sort()) && s.items.every(i => i.can_share === true) && s.items.find(i => i.document_id === DOC_BL).sensitive === true && J(v.attachments) === '[]') || J(s);
  });
  await expectErr('a commercial invoice is refused for the agent (kind_not_authorized)', () => S.setAtt('clrA', C.rep1.id, [DOC_INV]), /recipient_not_authorized/);
  await step('clearance staff: attaches D/O + B/L (staff action)', () => S.setAtt('clrA', C.rep1.id, [DOC_DO, DOC_BL]));
  await expectErr('recipient outside directory / participants refused (never taken from a body)',
    () => S.saveReply('clrA', C.rep1.id, { to: ['x@evil.example'] }), /MRS_INVALID.*recipient/);
  await step('branch manager: edits the body (new staff version)', () => S.saveReply('brA', C.rep1.id, { body_text: 'نرجو التكرم بإصدار إذن التسليم للبوليصة MEDUJD481516 والحاويتين MSKU7712050 و TGHU4829131.\nمع الشكر' }));
  await step('branch manager: submits', () => S.submit('brA', C.rep1.id));
  let v1 = (await replyRow(C.rep1.id)).current_version_id;
  await expectErr('four-eyes: the author / submitter cannot approve', () => S.decide('brA', C.rep1.id, v1, 'approve', 'ok', true), /four_eyes/);
  await expectErr('clearance staff cannot approve (role)', () => S.decide('clrA', C.rep1.id, v1, 'approve'), /MRS_FORBIDDEN/);
  await expectErr('send before approval refused (not_approved)', () => S.send('clrA', C.rep1.id), /not_approved/);
  await expectErr('a sensitive original (B/L) needs sensitive_ack', () => S.decide('opsA', C.rep1.id, v1, 'approve', null, false), /sensitive_ack/);
  await step('operations manager: approves with sensitive acknowledgement + note', () => S.decide('opsA', C.rep1.id, v1, 'approve', 'تمت مراجعة المرفقات الحساسة', true));
  await expectErr('a supervisor cannot send (msg_send)', () => S.send('supA', C.rep1.id), /MRS_FORBIDDEN/);
  C.s1 = await step('clearance staff: sends the approved reply', () => S.send('clrA', C.rep1.id));
  await check('a second send returns the same outbound (deduplicated)', async () => {
    const again = await S.send('clrA', C.rep1.id);
    return (again.deduplicated === true && again.outbound.id === C.s1.outbound.id) || J(again);
  });
  await check('outbound frozen copy: request id MRSO-…, approval and requester recorded, job queued', async () => {
    const o = await outRow(C.s1.outbound.id);
    return (/^MRSO-[0-9A-F]{16}$/.test(o.provider_request_id) && o.requested_by === U.clrA && o.approval_id && o.state === 'queued' && C.s1.job.status === 'queued') || J(o);
  });
  await step('worker: send job', () => runAll());
  await check('mock accepted exactly one send for that request id; outbound accepted, reply sent, outbound copy in the thread', async () => {
    const o = await outRow(C.s1.outbound.id);
    const r = await replyRow(C.rep1.id);
    const copy = await q(`SELECT * FROM public.msg_messages WHERE outbound_id = $1`, [o.id]);
    const t = await one(`SELECT * FROM public.msg_threads WHERE id = $1`, [C.t1.id]);
    const sent = C.MA.control.sentByRequest(o.provider_request_id);
    return (C.MA.control.count('sent', s => s.request_id === o.provider_request_id) === 1 && sent[0].attachments.length === 2 && o.state === 'accepted' && r.status === 'sent' &&
      copy.length === 1 && copy[0].direction === 'outbound' && copy[0].ingest_source === 'send' && t.status === 'awaiting_external' && J(sent[0].to) === J(['ops@gulf-agent.example'])) || J([o.state, r.status, copy.length, t.status, sent]);
  });
  C.MA.control.deliverLater(C.s1.outbound.provider_request_id, 'delivered');
  await step('status job (schedule) → delivered', async () => { await schedule(); await wake(); return runAll(); });
  await check('outbound delivered; delivery events (send_result + status_poll); event reply_delivered', async () => {
    const o = await outRow(C.s1.outbound.id);
    const ev = await q(`SELECT status, source FROM public.msg_delivery_events WHERE outbound_id = $1 ORDER BY created_at`, [o.id]);
    const te = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'reply_delivered'`, [TX1]);
    return (o.state === 'delivered' && ev.some(e => e.source === 'send_result') && ev.some(e => e.status === 'delivered' && e.source === 'status_poll') && te === 1) || J([o.state, ev]);
  });
  await check('a repeated status event is idempotent (duplicates counted, state unchanged)', async () => {
    const evs = C.MA.control.state().events.map(e => ({ provider_event_id: e.provider_event_id, provider_request_id: e.provider_request_id, status: e.status, at: e.at }));
    const r = await svc('msg_record_delivery', { p_channel: C.chA.id, p_events: evs });
    return (r.applied === 0 && r.duplicates === evs.length && (await outRow(C.s1.outbound.id)).state === 'delivered') || J(r);
  });

  /* ------------------------------------------------------------ 3 */
  section('3. WhatsApp appointment (Arabic-Indic digits): date span, deadline, suggested → staff link, English draft, 24 h window');
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const apptText = 'السلام عليكم، تم حجز موعد الفسح للحاوية TGHU' + toAI('4829131') + ' يوم ' + toAI(isoDate(tomorrow)) + ' الساعة ١٠ صباحاً.';
  C.MW.control.deliverInbound('appointment', { text: apptText, sent_at: ago(30) });
  await step('poll + process (WhatsApp)', () => pollAndProcess());
  C.mW = await msgRow('wamid.1');
  C.tW = await threadOfMsg('wamid.1');
  await check('category appointment; container + date extracted with exact spans of the Arabic-Indic text', async () => {
    const ex = await extrOf(C.mW.id);
    const d = ex.find(e => e.kind === 'date'), c = ex.find(e => e.kind === 'container_no');
    return ((await clsOf(C.mW.id)).category === 'appointment' && d && d.normalized === isoDate(tomorrow) && slice(C.mW.body_text, d.span_start, d.span_end) === d.raw &&
      c && c.normalized === 'TGHU4829131' && /[٠-٩]/.test(c.raw)) || J(ex);
  });
  await check('summary deadline from the date extraction (spanned), priority high (appointment ≤ 2 days)', async () => {
    const s = await one(`SELECT * FROM public.msg_summaries WHERE message_id = $1`, [C.mW.id]);
    return (s.deadline_date && isoDate(new Date(s.deadline_date)) === isoDate(tomorrow) && s.deadline_extraction_id && C.tW.priority === 'high' && s.risks.includes('deadline_soon')) || J([s, C.tW.priority]);
  });
  await check('one strong signal + unknown number → suggested (single_signal), not linked; NULL branch (org-wide)', () =>
    (C.tW.match_status === 'suggested' && C.tW.transaction_id === null && C.tW.branch_id === null && C.mW.sender_status === 'unknown' && C.tW.risk_flags.includes('sender_unverified')) || J(C.tW));
  await check('a branch-scoped user does not see the org-wide (NULL branch) thread', async () => {
    try { await S.thread('clrA', C.tW.id); return 'visible'; } catch (e) { return /MRS_NOT_FOUND/.test(errText(e)) || errText(e); }
  });
  await step('ops manager: links to TX-1 (top candidate)', () => S.link('opsA', C.tW.id, TX1, 'تأكيد هاتفي مع السائق'));
  await check('link history: staff link with basis signals; thread moved to TX-1 branch', async () => {
    const l = await lastLink(C.tW.id);
    const t = await one(`SELECT * FROM public.msg_threads WHERE id = $1`, [C.tW.id]);
    return (l.action === 'link' && l.method === 'staff' && l.actor === U.opsA && l.basis.signals.length >= 1 && t.match_status === 'linked' && t.branch_id === JED) || J(l);
  });
  await step('ops manager: English draft', () => S.draft('opsA', C.tW.id, { lang: 'en', template_key: 'clarification' }));
  await step('worker: draft', () => runAll());
  C.repW = await replyOfThread(C.tW.id);
  await check('English draft, recipient = the thread number only', async () => {
    const v = await latestVersion(C.repW.id);
    return (C.repW.lang === 'en' && J(v.to_addresses.map(x => x.address_norm)) === J(['+966551234567']) && /[A-Za-z]/.test(v.body_text)) || J(v);
  });
  await step('ops manager submits; supervisor approves (standard level)', async () => {
    await S.submit('opsA', C.repW.id);
    await S.decide('supA', C.repW.id, (await replyRow(C.repW.id)).current_version_id, 'approve');
  });
  await expectErr('send outside the 24-hour window refused (wa_window_closed)', () => S.send('clrA', C.repW.id), /wa_window_closed/);
  await check('no WhatsApp send reached the mock', () => C.MW.control.count('sent') === 0 && C.MW.control.count('send_calls') === 0);

  /* ------------------------------------------------------------ 4 */
  section('4. unknown sender asking for all documents: clarification only, nothing shareable');
  C.MA.control.deliverInbound('unknown_docs', { sent_at: ago(1) });
  await step('poll + process', () => pollAndProcess());
  C.mU = await msgRow('em-2');
  C.tU = await threadOfMsg('em-2');
  await check('sender unknown → risk flag sender_unverified; single B/L → suggested', () =>
    (C.mU.sender_status === 'unknown' && C.mU.risk_flags.includes('sender_unverified') && C.tU.match_status === 'suggested' && C.tU.transaction_id === null) || J([C.mU.sender_status, C.mU.risk_flags, C.tU.match_status]));
  await step('clearance staff: links to TX-1 (top candidate)', () => S.link('clrA', C.tU.id, TX1, null));
  await step('clearance staff: draft (missing_documents)', async () => { await S.draft('clrA', C.tU.id, { lang: 'en', template_key: 'missing_documents' }); return runAll(); });
  C.repU = await replyOfThread(C.tU.id);
  await check('draft = clarification / verification request; no restricted fact (no B/L, containers, tx ref)', async () => {
    const v = await latestVersion(C.repU.id);
    return (v.clarification === true && v.missing.includes('recipient_verification') && !/MEDUJD481516|MSKU7712050|TGHU4829131|2611004567/.test(v.subject + v.body_text) &&
      J(v.used_facts) === '[]') || J(v);
  });
  await check('the draft context offered only public facts (restricted withheld for an unverified recipient)', () => {
    const ctx = claimed.filter(c => c.job.kind === 'draft' && c.draft && c.draft.thread_id === C.tU.id).pop();
    return (ctx && ctx.draft.recipient.verified === false && !ctx.draft.facts.restricted) || J(ctx && ctx.draft);
  });
  await check('every attachment suggestion has can_share = false; app.msg_can_share refuses every TX-1 document (recipient_unverified)', async () => {
    const s = await S.suggestions('clrA', C.repU.id);
    const docs = [DOC_BL, DOC_DO, DOC_INV];
    const res = [];
    for (const d of docs) res.push((await one(`SELECT app.msg_can_share($1, $2) r`, [C.repU.id, d])).r);
    return (s.items.every(i => i.can_share === false) && res.every(r => r.ok === false && r.reasons.includes('recipient_unverified'))) || J([s, res]);
  });
  await expectErr('set_msg_reply_attachments refused (recipient_not_authorized)', () => S.setAtt('clrA', C.repU.id, [DOC_BL]), /recipient_not_authorized/);

  /* ------------------------------------------------------------ 5 */
  section('5. repeated violation: urgent, management approval level');
  C.MA.control.deliverInbound('violation_1', { sent_at: ago(24 * 10) });
  C.MA.control.deliverInbound('violation_2', { sent_at: ago(1) });
  await step('poll + process both notices', () => pollAndProcess());
  C.tV1 = await threadOfMsg('em-3'); C.tV2 = await threadOfMsg('em-4');
  C.mV2 = await msgRow('em-4');
  await check('second notice: repeated_violation on the summary + thread, priority urgent; first: high', async () => {
    const s2 = await one(`SELECT * FROM public.msg_summaries WHERE message_id = $1`, [C.mV2.id]);
    const t1 = await one(`SELECT * FROM public.msg_threads WHERE id = $1`, [C.tV1.id]);
    return (C.tV2.category === 'violation' && s2.risks.includes('repeated_violation') && C.tV2.risk_flags.includes('repeated_violation') && C.tV2.priority === 'urgent' &&
      t1.priority === 'high' && C.tV1.id !== C.tV2.id) || J([s2 && s2.risks, C.tV2.priority, t1.priority]);
  });
  await step('clearance staff: reply on the second notice + submit', async () => {
    const r = await S.saveReply('clrA', null, { thread_id: C.tV2.id, lang: 'en', subject: 'Re: violation notice', body_text: 'We acknowledge receipt and request the violation details for review.' });
    C.repV = r; await S.submit('clrA', r.id);
  });
  await check('approval level management for violation', async () => (await S.thread('clrA', C.tV2.id)).approval_level === 'management');
  await expectErr('operations manager refused at management level', () => S.decide('opsA', C.repV.id, C.repV.current_version_id || C.repV.current_version.id, 'approve'), /MRS_FORBIDDEN/);
  await step('branch manager approves (management)', async () => S.decide('brA', C.repV.id, (await replyRow(C.repV.id)).current_version_id, 'approve'));

  /* ------------------------------------------------------------ 6 */
  section('6. conflicting references: review (conflict), no link; staff chooses TX-2 with a note');
  C.MA.control.deliverInbound('conflict', { sent_at: ago(1) });
  await step('poll + process', () => pollAndProcess());
  C.tC = await threadOfMsg('em-5');
  await check('review (conflict), no link, no thread_linked event, history row action review', async () => {
    const l = await lastLink(C.tC.id);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE event_type = 'message' AND payload ->> 'thread_id' = $1`, [C.tC.id]);
    const txs = (C.tC.match_candidates || []).map(c => c.transaction_id).sort();
    return (C.tC.match_status === 'review' && C.tC.match_reason === 'conflict' && C.tC.transaction_id === null && ev === 0 && l && l.action === 'review' &&
      J(txs) === J([TX1, TX2].sort())) || J([C.tC.match_status, C.tC.match_reason, txs, ev]);
  });
  await expectErr('a staff link against review needs a note', () => S.link('clrA', C.tC.id, TX2, null), /MRS_NOTE_REQUIRED/);
  await step('clearance staff: links TX-2 with a note', () => S.link('clrA', C.tC.id, TX2, 'الحاوية تخص المعاملة الثانية حسب الوكيل'));
  await check('link history keeps both candidates and the note', async () => {
    const l = await lastLink(C.tC.id);
    return (l.action === 'link' && l.transaction_id === TX2 && l.note && l.basis.candidates.length === 2 && l.basis.previous_status === 'review') || J(l);
  });

  /* ------------------------------------------------------------ 7 */
  section('7. duplicates (poll + webhook) and threading');
  const dupRaw = C.MA.control.duplicateNext();
  await step('poll with a re-delivered provider id', () => pollAndProcess());
  await check('the re-delivered message is not stored twice', async () => (await num(`SELECT count(*) n FROM public.msg_messages WHERE provider_message_id = 'em-5'`)) === 1);
  await check('webhook path with the same provider id → duplicate:true, nothing changes', async () => {
    const before = await num(`SELECT count(*) n FROM public.msg_messages`);
    const r = await svc('msg_ingest_messages', { p_channel: C.chA.id, p_messages: [AD.normalizeInbound(dupRaw, { kind: 'email' })] });
    return (r.items[0].duplicate === true && r.items[0].thread_id === C.tC.id && (await num(`SELECT count(*) n FROM public.msg_messages`)) === before) || J(r);
  });
  await check('a batch with the same id twice stores one copy', async () => {
    const raw = ME.createMockEmail({ channelAddress: CH.email, deps: AD }).control.deliverInbound('agent_reply', { id: 'em-batch-1', sent_at: ago(1) });
    const n = AD.normalizeInbound(raw, { kind: 'email' });
    const r = await svc('msg_ingest_messages', { p_channel: C.chA.id, p_messages: [n, n] });
    return (r.items[0].duplicate === false && r.items[1].duplicate === true && r.items[0].message_id === r.items[1].message_id) || J(r);
  });
  await wake(); await runAll();
  C.MA.control.deliverInbound('agent_reply', { in_reply_to: C.m1.headers.message_id, sent_at: ago(0.5) });
  await step('poll the reply-in-thread e-mail', () => pollAndProcess());
  await check('In-Reply-To → the thread of the referenced message (no subject heuristic)', async () => {
    const m = await msgRow('em-6');
    return (m.thread_id === C.t1.id) || J([m.thread_id, C.t1.id]);
  });
  C.MW.control.deliverInbound('status_question', { sent_at: ago(2) });
  await step('poll a second WhatsApp message of the same number', () => pollAndProcess());
  await check('WhatsApp: the open thread of the same number (7 days) is reused', async () => (await msgRow('wamid.2')).thread_id === C.tW.id);

  /* ------------------------------------------------------------ 8 */
  section('8. delivery robustness: retry, lost response + lookup, no lookup + human resolution, bounce');
  C.rA = await step('reply A approved (thread 1)', () => approvedReply(C.t1.id, 'clrA', 'opsA', 'Reply A'));
  C.MA.control.failNext('send', 'network', { applied: 'no' });
  const sA = await S.send('clrA', C.rA.id);
  await step('send A: network failure (applied no) → retry', () => runAll());
  await check('outbound A still sending, job queued for retry, nothing sent', async () => {
    const o = await outRow(sA.outbound.id);
    const j = await one(`SELECT * FROM public.msg_jobs WHERE outbound_id = $1`, [o.id]);
    return (o.state === 'sending' && j.status === 'queued' && C.MA.control.count('sent', s => s.request_id === o.provider_request_id) === 0) || J([o.state, j.status]);
  });
  await wake();
  await step('retry run → accepted', () => runAll());
  C.oA = await outRow(sA.outbound.id);
  await check('A: accepted after the retry; one send for the request id', () =>
    (C.oA.state === 'accepted' && C.MA.control.count('sent', s => s.request_id === C.oA.provider_request_id) === 1) || C.oA.state);

  C.rB = await step('reply B approved', () => approvedReply(C.t1.id, 'clrA', 'opsA', 'Reply B'));
  C.MA.control.loseResponse('send');
  const sB = await S.send('clrA', C.rB.id);
  await step('send B: response lost', () => runAll());
  await check('B: outbound unknown, reply send_unknown (never re-sent blindly)', async () => {
    const o = await outRow(sB.outbound.id); const r = await replyRow(C.rB.id);
    return (o.state === 'unknown' && r.status === 'send_unknown') || J([o.state, r.status]);
  });
  await wake();
  await step('reconcile run: lookup by request id', () => runAll());
  await check('B: adopted by lookup (found_by lookup), no second send', async () => {
    const o = await outRow(sB.outbound.id);
    const last = completions.filter(c => c.result.effects && c.result.effects.outbound_id === o.id).pop();
    const sends = C.MA.control.sentByRequest(o.provider_request_id);
    return (o.state === 'accepted' && last.result.effects.found_by === 'lookup' && sends.length === 1 && sends[0].repeats === 0) || J([o.state, last && last.result]);
  });

  C.rC = await step('reply C approved', () => approvedReply(C.t1.id, 'clrA', 'opsA', 'Reply C'));
  C.MA.control.disableLookup(true);
  C.MA.control.loseResponse('send');
  const sC = await S.send('clrA', C.rC.id);
  await step('send C: response lost, provider without lookup', () => runAll());
  await wake();
  await step('reconcile run: lookup unsupported → stays unknown', () => runAll());
  await check('C: outbound unknown awaiting a human decision', async () => (await outRow(sC.outbound.id)).state === 'unknown');
  await expectErr('resolution needs a note', () => S.resolve('opsA', sC.outbound.id, 'confirmed_not_sent', null), /MRS_NOTE_REQUIRED/);
  await expectErr('clearance staff cannot resolve (msg_approve)', () => S.resolve('clrA', sC.outbound.id, 'confirmed_not_sent', 'x'), /MRS_FORBIDDEN/);
  await step('ops manager: confirmed_not_sent → re-queued with the same request id', () => S.resolve('opsA', sC.outbound.id, 'confirmed_not_sent', 'لم يظهر في البريد المرسل'));
  await step('resend run', () => runAll());
  await check('C: accepted; the mock holds ONE sent item for the request id (provider idempotency)', async () => {
    const o = await outRow(sC.outbound.id);
    return (o.state === 'accepted' && o.provider_request_id === sC.outbound.provider_request_id && o.unknown_resolution === 'confirmed_not_sent' &&
      C.MA.control.count('sent', s => s.request_id === o.provider_request_id) === 1) || J(o);
  });
  C.MA.control.disableLookup(false);
  C.MA.control.bounce(C.oA.provider_request_id);
  await step('status run: bounce of A', async () => { await schedule(); await wake(); return runAll(); });
  await check('A: bounced → outbound failed, reply send_failed, no re-send', async () => {
    const o = await outRow(C.oA.id); const r = await replyRow(C.rA.id);
    return (o.state === 'failed' && r.status === 'send_failed' && C.MA.control.count('sent', s => s.request_id === o.provider_request_id) === 1) || J([o.state, r.status]);
  });
  await expectErr('retry_msg_send refused after an accepted-then-bounced send (not_retryable)', () => S.retrySend('clrA', C.oA.id), /not_retryable/);

  /* ------------------------------------------------------------ 9 */
  section('9. injection fixtures: flags only — same category / extractions / match as the clean twin; nothing sent');
  const pairs = [['inj_en', 'email'], ['inj_ar', 'email'], ['inj_att', 'email'], ['inj_file', 'email'], ['inj_wa', 'whatsapp']];
  C.inj = {};
  let waN = 0;
  for (const [k, kind] of pairs) {
    for (const key of [k, k + '_clean']) {
      if (kind === 'email') C.inj[key] = C.MA.control.deliverInbound(key, { sent_at: ago(0.2) }).id;
      else C.inj[key] = C.MW.control.deliverInbound(key, { from: '+96655200000' + (++waN), sent_at: ago(0.2) }).id;
    }
  }
  const jobsBefore = await num(`SELECT count(*) n FROM public.msg_jobs WHERE kind IN ('draft','send')`);
  const outBefore = await num(`SELECT count(*) n FROM public.msg_outbound`);
  const apprBefore = await num(`SELECT count(*) n FROM public.msg_reply_approvals`);
  await step('poll + process the injection set', () => pollAndProcess());
  for (const [k] of pairs) {
    await check(k + ': injection_suspected + foreign_address; category, extractions and match decision identical to the clean twin', async () => {
      const a = await msgRow(C.inj[k]), b = await msgRow(C.inj[k + '_clean']);
      const ta = await one(`SELECT * FROM public.msg_threads WHERE id = $1`, [a.thread_id]), tb = await one(`SELECT * FROM public.msg_threads WHERE id = $1`, [b.thread_id]);
      const ea = (await extrOf(a.id)).map(e => [e.kind, e.normalized, e.source, e.span_start, e.span_end, e.valid]);
      const eb = (await extrOf(b.id)).map(e => [e.kind, e.normalized, e.source, e.span_start, e.span_end, e.valid]);
      const ca = (await clsOf(a.id)).category, cb = (await clsOf(b.id)).category;
      const flags = ta.risk_flags;
      return (flags.includes('injection_suspected') && flags.includes('foreign_address') && !tb.risk_flags.includes('injection_suspected') && J(ea) === J(eb) && ca === cb &&
        ta.match_status === tb.match_status && ta.transaction_id === tb.transaction_id && !J(ea).includes('evil')) || J({ flags, ca, cb, ma: ta.match_status, mb: tb.match_status, ea, eb });
    });
  }
  await check('the injection set created no draft / send job, no outbound, no approval', async () =>
    (await num(`SELECT count(*) n FROM public.msg_jobs WHERE kind IN ('draft','send')`)) === jobsBefore &&
    (await num(`SELECT count(*) n FROM public.msg_outbound`)) === outBefore && (await num(`SELECT count(*) n FROM public.msg_reply_approvals`)) === apprBefore);
  C.tInj = (await msgRow(C.inj.inj_en)).thread_id;
  await step('clearance staff: draft on the English injection thread', async () => { await S.draft('clrA', C.tInj, { lang: 'en' }); return runAll(); });
  await check('reply recipients = the sender only; x@evil.example appears in no recipient, suggestion, draft or outbound', async () => {
    const r = await replyOfThread(C.tInj);
    const v = await latestVersion(r.id);
    const s = await S.suggestions('clrA', r.id);
    const blob = J(await q(`SELECT to_addresses, cc_addresses, body_text, subject, attachments FROM public.msg_reply_versions`)) + J(await q(`SELECT * FROM public.msg_outbound`)) + J(s) +
      J(await q(`SELECT address_norm FROM public.msg_contact_addresses`));
    return (J(v.to_addresses.map(x => x.address_norm)) === J(['ops@gulf-agent.example']) && !blob.includes(EVIL) && !blob.includes('447700900123')) || J(v.to_addresses);
  });
  await check('the review screen data carries the injection flag (get_msg_thread risk_flags)', async () =>
    (await S.thread('clrA', C.tInj)).thread.risk_flags.includes('injection_suspected'));

  /* ------------------------------------------------------------ 10 */
  section('10. two orgs: separate mocks, contexts and data');
  C.MB.control.deliverInbound('agent_do', { sent_at: ago(1) });
  await step('org B poll + process', () => pollAndProcess());
  await check('org B thread: candidates only org B transactions (TX-B), never TX-1', async () => {
    const t = await one(`SELECT t.* FROM public.msg_threads t WHERE t.org_id = $1`, [B]);
    const txs = (t.match_candidates || []).map(c => c.transaction_id);
    return (t && txs.includes(TXB) && !txs.includes(TX1) && !txs.includes(TX2)) || J(t);
  });
  await check('every adapter call used the channel of the job org; org B mock never received org A traffic', () => {
    const bad = adapterUse.filter(u => u.job_org !== u.channel_org);
    const bSent = C.MB.control.count('sent'), bIn = C.MB.control.count('inbound');
    return (bad.length === 0 && bSent === 0 && bIn === 1) || J([bad.length, bSent, bIn]);
  });
  await check('org B worker contexts contain no org A id', async () => {
    const aIds = [A, TX1, TX2, C.chA.id, C.chW.id, C.t1.id, C.m1.id, JED, DMM];
    const bCtx = J(claimed.filter(c => c.job.org_id === B));
    return (bCtx.length > 2 && !aIds.some(id => bCtx.includes(id))) || 'leak';
  });
  await check('one running job per channel: attempts of a channel never overlap', async () => (await num(`
    SELECT count(*) n FROM public.msg_job_attempts a JOIN public.msg_jobs j ON j.id = a.job_id
      JOIN public.msg_job_attempts b ON b.id <> a.id JOIN public.msg_jobs k ON k.id = b.job_id AND k.channel_id = j.channel_id
     WHERE a.started_at < coalesce(b.finished_at, now()) AND b.started_at < coalesce(a.finished_at, now()) AND a.started_at <= b.started_at AND a.id < b.id`)) === 0);
  await expectErr('org B staff cannot read org A threads', () => S.threads('opsB', A, {}), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await expectErr('org B staff cannot open an org A thread', () => S.thread('opsB', C.t1.id), /MRS_NOT_FOUND/);
  await expectErr('branch A2 staff cannot open a branch A1 thread', () => S.thread('clrA2', C.t1.id), /MRS_NOT_FOUND/);
  await expectErr('a client user cannot list threads', () => S.threads('clientA', A, {}), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await check('a client user sees 0 rows of every G6b table', async () => {
    const tabs = ['msg_threads', 'msg_messages', 'msg_attachments', 'msg_extractions', 'msg_replies', 'msg_reply_versions', 'msg_outbound', 'msg_channels', 'msg_contacts'];
    const out = [];
    for (const t of tabs) { const n = Number((await as('clientA', `SELECT count(*) n FROM public.${t}`))[0].n); if (n) out.push(t + ':' + n); }
    return out.length === 0 || out.join(',');
  });
  await check('tx_messages(TX-1) lists the linked threads with their basis', async () => {
    const r = await S.txMessages('opsA', TX1);
    return ((r.threads || []).length >= 3) || J(r);
  });

  /* ------------------------------------------------------------ 11 */
  section('11. exit gate: zero unauthorized sends, documented linking, privacy, AI cost 0');
  await check('(a) every mock send ↔ exactly one outbound with a valid approval (level, ≠ author / submitter, same hash) requested by a msg_send user', async () => {
    const allSent = [];
    for (const id of Object.keys(mocks)) for (const s of mocks[id].control.state().sent) allSent.push(s.request_id);
    const distinct = new Set(allSent);
    const rows = await q(`
      SELECT o.provider_request_id, o.content_sha256 = v.content_sha256 AND a.content_sha256 = v.content_sha256 AS hash_ok,
             a.decision, a.actor, coalesce(v.author_id, v.requested_by) AS author, r.submitted_by,
             EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = a.actor AND m.org_id = o.org_id AND m.role = ANY (app.msg_level_roles(a.level))) AS level_ok,
             EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = o.requested_by AND m.org_id = o.org_id AND m.role = ANY (app.msg_send_roles())) AS send_ok
        FROM public.msg_outbound o JOIN public.msg_reply_versions v ON v.id = o.reply_version_id
        JOIN public.msg_reply_approvals a ON a.id = o.approval_id JOIN public.msg_replies r ON r.id = o.reply_id
       WHERE o.accepted_at IS NOT NULL`);
    const bad = rows.filter(x => !(x.hash_ok && x.decision === 'approve' && x.level_ok && x.send_ok && x.actor !== x.author && x.actor !== x.submitted_by));
    const ids = new Set(rows.map(x => x.provider_request_id));
    const match = allSent.length === distinct.size && distinct.size === rows.length && [...distinct].every(x => ids.has(x));
    return (bad.length === 0 && match) || J({ bad, sent: allSent.length, distinct: distinct.size, outbound: rows.length });
  });
  await check('(a) no send for the threads of steps 4 and 9; auto-reply policies all disabled', async () => {
    const injThreads = [];
    for (const k of Object.keys(C.inj)) injThreads.push((await msgRow(C.inj[k])).thread_id);
    const n = await num(`SELECT count(*) n FROM public.msg_outbound WHERE thread_id = ANY ($1::uuid[])`, [[C.tU.id, ...injThreads]]);
    const en = await num(`SELECT count(*) n FROM public.msg_auto_reply_policies WHERE enabled`);
    return (n === 0 && en === 0) || J([n, en]);
  });
  await check('(b) every linked thread: last link row auto_link | link with basis.signals (auto: ≥ 2 strong kinds); staff links against review carry a note', async () => {
    const rows = await q(`SELECT t.id, t.transaction_id, l.action, l.method, l.basis, l.note, l.actor FROM public.msg_threads t
      JOIN LATERAL (SELECT * FROM public.msg_thread_links x WHERE x.thread_id = t.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) l ON true
      WHERE t.transaction_id IS NOT NULL`);
    const bad = rows.filter(r => !(['auto_link', 'link'].includes(r.action) && (r.basis.signals || []).length > 0 &&
      (r.action !== 'auto_link' || (strongKinds(r.basis).length >= 2 && r.actor === null)) && (r.action !== 'link' || r.actor !== null) &&
      (r.basis.previous_status !== 'review' || r.note)));
    const single = await num(`SELECT count(*) n FROM public.msg_thread_links WHERE action = 'auto_link' AND (SELECT count(DISTINCT s ->> 'kind') FROM jsonb_array_elements(basis -> 'signals') s WHERE s ->> 'strength' = 'strong') < 2`);
    return (rows.length >= 5 && bad.length === 0 && single === 0) || J({ n: rows.length, bad, single });
  });
  await check('(c) no body / subject / address in transaction_events, msg_ai_runs, attempt calls, msg_threads audit; no body in audit_log', async () => {
    const SECRET = ['gulf-agent', 'unknown-trading', 'port-authority', '966551234567', 'evil.example', 'Please collect', 'Following up', 'D/O ready', 'تجاهل', 'السلام عليكم', 'Body with'];
    const BODY = ['Please collect', 'Following up', 'تجاهل التعليمات', 'السلام عليكم', 'A second violation'];
    const te = J(await q(`SELECT payload FROM public.transaction_events WHERE event_type = 'message'`));
    const ai = J(await q(`SELECT * FROM public.msg_ai_runs`));
    const calls = J(await q(`SELECT calls, error FROM public.msg_job_attempts`));
    const au = J(await q(`SELECT old_data, new_data FROM public.audit_log WHERE table_name LIKE 'msg_%'`));
    const hits = [];
    for (const s of SECRET) { if (te.includes(s)) hits.push('events:' + s); if (ai.includes(s)) hits.push('ai_runs:' + s); if (calls.includes(s)) hits.push('calls:' + s); }
    for (const s of BODY) if (au.includes(s)) hits.push('audit:' + s);
    // review fix: thread audit rows carry no subject / counterpart address either (WhatsApp numbers included)
    const auT = J(await q(`SELECT old_data, new_data FROM public.audit_log WHERE table_name = 'msg_threads'`));
    for (const s of SECRET) if (auT.includes(s)) hits.push('audit msg_threads:' + s);
    return hits.length === 0 || hits.join(', ');
  });
  await check('(d) every AI run: provider rule_mock, est_cost_usd 0; the worker made no fetch; live stubs not_configured', async () => {
    const r = await one(`SELECT count(*) n, count(*) FILTER (WHERE provider = 'rule_mock' AND est_cost_usd = 0) ok FROM public.msg_ai_runs`);
    let stub = false;
    try { await AD.createLiveEmailAdapter({}).send({}); } catch (e) { stub = e.kind === 'not_configured'; }
    return (Number(r.n) > 10 && Number(r.n) === Number(r.ok) && fetchCalls === 0 && stub) || J(r);
  });
  await check('mock mailbox persistence (msg_mock_save / load, optimistic version)', async () => {
    const s1 = await svc('msg_mock_save', { p_channel: C.chA.id, p_state: C.MA.control.state(), p_version: 0 });
    const l = await svc('msg_mock_load', { p_channel: C.chA.id });
    const re = ME.createMockEmail({ channelAddress: CH.email, state: l.state, deps: AD });
    let stale = null;
    try { await svc('msg_mock_save', { p_channel: C.chA.id, p_state: {}, p_version: 0 }); } catch (e) { stale = errText(e); }
    return (s1.version === 1 && l.version === 1 && re.control.count('sent') === C.MA.control.count('sent') && /mock_version/.test(stale || '')) || J([s1, l.version, stale]);
  });
}

async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(G6B_MIGRATION)) { fail('G6b migration present', G6B_MIGRATION + ' not found (DB agent writes it)'); return; }
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return;
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  try { await fixtures(); pass('fixtures: staff users A + B, org B, TX-1 (B/L + 2 containers + agent party), TX-2, TX-B, documents'); }
  catch (e) { fail('fixtures', errText(e)); return; }
  worker = WK.createWorker({ rpc: svc, adapterFor, provider: AI.createRuleProvider({ clock: CLOCK }), workerId: 'g6b-cycle-worker', clock: CLOCK, deps: DEPS });
  try { await cycle(); }
  catch (e) { fail('cycle', errText(e)); }
}


function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

async function main() {
  await unitChecks();
  if (UNIT_ONLY) return finish();
  await dbMain();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });

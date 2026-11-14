#!/usr/bin/env node
/*
  Marsa (مرسى) — «القراءة السريعة» (quick reading, 2026-11-14): ai-extract reading_mode 'quick' (extract.js QUICK_KEYS /
  QUICK_ITEM_KEYS / buildRequestQuick, handler.js reuse rule) and its UI (ocr.html, ocr.js, ocr-match.js, supa.js, i18n, css).
  No network, no DB (the DB checks of a quick reading are in legacy-docs-sql-tests: extraction_detail_ok / items_ok / a save).

  Covers: request validation of reading_mode; full mode byte-identical to the code before the feature (golden hashes of
  buildRequest for every doc type / version / language, of postProcess and of the whole handler answer + the reserve /
  settle calls, computed from the previous extract.js / handler.js); the quick request (keys, compact schema ≤ 16 unions,
  effort low, max_tokens, betas / fallbacks kept, the focused prompt, declaration rules); postProcess with compact items;
  the handler (quick answer, hold, 400 retry, reuse: full ↔ quick); doc-match with compact items; UI static + vm checks.

  usage: NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/ai-quick-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..');
const QUIET = args.includes('--quiet');
const FN = path.join(ROOT, 'supabase', 'functions', 'ai-extract');
const X = require(path.join(FN, 'extract.js'));
const H = require(path.join(FN, 'handler.js'));
const E = require(path.join(ROOT, 'assets', 'js', 'doc-match.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const J = JSON.stringify;
const h16 = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
globalThis.fetch = async () => { throw new Error('network forbidden in ai-quick-tests'); };

let nPass = 0, nFail = 0;
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
    else { nFail++; console.log('FAIL  ' + name + '\n        ' + String(r).slice(0, 600)); }
  } catch (e) { nFail++; console.log('FAIL  ' + name + '\n        threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); }
}
function unions(s) {
  if (!s || typeof s !== 'object') return 0;
  if (Array.isArray(s)) return s.reduce((n, x) => n + unions(x), 0);
  let n = (Array.isArray(s.type) || s.anyOf || s.oneOf) ? 1 : 0;
  Object.keys(s).forEach(k => { n += unions(s[k]); });
  return n;
}
const TX = '0b5e0000-0000-4000-8000-0000000000aa';
const SHIP = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'customs_declaration', 'supplier_invoice', 'auto'];
const bodyOf = (o) => Object.assign({ org_id: '0b5e0000-0000-4000-8000-000000000001', doc_type: 'auto', lang: 'ar', prompt_version: 'ai-doc-v3',
  file: { media_type: 'image/png', data_b64: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64') } }, o || {});
const vr = b => { try { return X.validateRequest(b); } catch (e) { return e.code + ':' + e.status; } };

/* ------------------------------------------------------------------ golden values of the code before the feature */
// sha256(JSON.stringify(buildRequest(validateRequest(body))))[0..16] — computed from extract.js before reading_mode existed
const GOLDEN_REQ = {"ai-doc-v2|bill_of_lading|ar":"1e6622e3dba81121","ai-doc-v2|bill_of_lading|en":"52803e1f2657b939","ai-doc-v2|commercial_invoice|ar":"71e80087af6072c5","ai-doc-v2|commercial_invoice|en":"ce0e1ac1b529fa83","ai-doc-v2|customs_declaration|ar":"a19c6a05e6d14721","ai-doc-v2|customs_declaration|en":"b8c5b35b9cea7d6c","ai-doc-v2|supplier_invoice|ar":"cd93694da1ae3202","ai-doc-v2|supplier_invoice|en":"60dc885c399e420c","ai-doc-v2|auto|ar":"a67d5c01dd421e04","ai-doc-v2|auto|en":"3031cbcebb4ca8ea","ai-doc-v3|bill_of_lading|ar":"0a41fe6675894d59","ai-doc-v3|bill_of_lading|en":"03e91d0a5931db77","ai-doc-v3|commercial_invoice|ar":"75162ecd23a09d13","ai-doc-v3|commercial_invoice|en":"a77f64b773a720da","ai-doc-v3|packing_list|ar":"f723b5777a9c03ca","ai-doc-v3|packing_list|en":"58ea6dc95b1dfb7d","ai-doc-v3|customs_declaration|ar":"0db2432e9838448f","ai-doc-v3|customs_declaration|en":"1bca3eaf35e2f6ff","ai-doc-v3|supplier_invoice|ar":"99e7f86c3c1d24f8","ai-doc-v3|supplier_invoice|en":"dcb84799f81d9584","ai-doc-v3|auto|ar":"938e607236d899cd","ai-doc-v3|auto|en":"2add82a7dce828a8","ai-doc-v3|appointment_ticket|ar":"fa9649d6f67739e2","ai-doc-v3|appointment_ticket|en":"253e3431c61553c7","ai-doc-v3|empty_return_receipt|ar":"1cac121a12544046","ai-doc-v3|empty_return_receipt|en":"9c1176b141c4573f","ai-doc-v3|appointment_invoice|ar":"d893eaac202c201d","ai-doc-v3|appointment_invoice|en":"bb663d884ed4d01d","ai-doc-v3|payment_proof|ar":"cc87030a0991b8a0","ai-doc-v3|payment_proof|en":"80fc6d1fd3fb5b54"};
// sha256(JSON.stringify(postProcess(fixture)))[0..16] — the code before the feature
const GOLDEN_PP = {"inv-v3-auto":"c3edf02befdacef5","inv-v3":"c3edf02befdacef5","decl-v3":"7e2ae1f653545e77","combo-v3-auto":"c566aad7260a4b37","combo-v3-bl":"c566aad7260a4b37","inv-v2":"dee2b842ba4a8b4a"};
// handler answer: status : sha256(body) : sha256(reserve / bind / settle calls) — the code before the feature
const GOLDEN_H = {"inv-v3-auto":"200:60447ed551a150a7:71f9ca0e","inv-v3":"200:60447ed551a150a7:71f9ca0e","decl-v3":"200:df12eeab196734f5:71f9ca0e","combo-v3-auto":"200:d4167999a1bf014c:71f9ca0e","combo-v3-bl":"200:d4167999a1bf014c:71f9ca0e","inv-v2":"200:0e9401d67e13b8f4:93716783"};

function fixtures() {
  const item = n => ({ description: 'COTTON T-SHIRT STYLE ' + n, hs_code: '6109.10', quantity: 100 + n, unit_price: 2.5, amount: (100 + n) * 2.5,
    unit: 'PCS', scientific_name: '', origin_country: 'CN', net_weight: 50, gross_weight: 55, packages: 10, container_number: 'MSCU1234565', seal_number: 'S1', notes: '' });
  const f = (name, value, document) => ({ name, value, confidence: 0.93, page: 1, document });
  const inv = { doc_type: 'commercial_invoice', detected_documents: ['commercial_invoice'],
    fields: [f('invoice_number', 'INV-77', 'commercial_invoice'), f('invoice_date', '2026-10-01', 'commercial_invoice'), f('supplier_name', 'NINGBO TEXTILE CO', 'commercial_invoice'),
      f('supplier_vat', '300000000000003', 'commercial_invoice'), f('buyer_name', 'AL BAHR TRADING', 'commercial_invoice'), f('currency', 'USD', 'commercial_invoice'),
      f('subtotal', '765.00', 'commercial_invoice'), f('total', '765.00', 'commercial_invoice'), f('hs_codes', '6109.10', 'commercial_invoice'), f('payment_terms', 'T/T 30 DAYS', 'commercial_invoice'),
      f('consignee', 'AL BAHR TRADING\nP.O. BOX 1 JEDDAH', 'commercial_invoice'), f('gross_weight', '165', 'commercial_invoice'), f('container_numbers', 'MSCU1234565', 'commercial_invoice')],
    line_items: [item(1), item(2), item(3)],
    containers: [{ container_number: 'MSCU1234565', seal_number: 'S1', size_type: '40hc', packages_count: 30, net_weight: 150, gross_weight: 165 }], warnings: ['scan is faint'] };
  const decl = { doc_type: 'customs_declaration', detected_documents: ['customs_declaration'],
    fields: [f('declaration_number', '3001234', 'customs_declaration'), f('declaration_type', 'استيراد', 'customs_declaration'), f('declaration_date_hijri', '1448/05/10', 'customs_declaration'),
      f('declaration_date', '2026-10-21', 'customs_declaration'), f('bl_number', 'MEDU1234567', 'customs_declaration'), f('importer_name_ar', 'شركة البحر', 'customs_declaration'),
      f('broker_name', 'مخلص', 'customs_declaration'), f('total', '765', 'customs_declaration'), f('vat_amount', '114.75', 'customs_declaration')],
    line_items: [item(1)], containers: [{ container_number: 'MSCU1234565', seal_number: '', size_type: '', packages_count: null, net_weight: null, gross_weight: null }],
    declaration: { declaration_type_evidence: 'بيان استيراد', bl_candidates: ['MEDU1234567'], bl_rtl_affected: false }, warnings: [] };
  const combo = { doc_type: 'bill_of_lading', detected_documents: ['bill_of_lading', 'packing_list'],
    fields: [f('bl_number', 'MEDU1234567', 'bill_of_lading'), f('gross_weight', '165', 'bill_of_lading'), f('gross_weight', '166', 'packing_list'),
      f('packages_count', '30', 'packing_list'), f('notify_party', 'SAME AS CONSIGNEE', 'bill_of_lading'), f('vessel', 'MSC ANNA', 'bill_of_lading')],
    line_items: [item(4)], containers: [{ container_number: 'MSCU1234565', seal_number: 'S1', size_type: '40HC', packages_count: 30, net_weight: null, gross_weight: 165 }], warnings: [] };
  const v2 = { doc_type: 'commercial_invoice', fields: inv.fields.slice(0, 8).map(x => ({ name: x.name, value: x.value, confidence: x.confidence, page: x.page })),
    line_items: [{ description: 'X', hs_code: '6109.10', quantity: 1, unit_price: 2, amount: 2 }], warnings: [] };
  return [['inv-v3-auto', inv, 'auto', 'ai-doc-v3'], ['inv-v3', inv, 'commercial_invoice', 'ai-doc-v3'], ['decl-v3', decl, 'customs_declaration', 'ai-doc-v3'],
    ['combo-v3-auto', combo, 'auto', 'ai-doc-v3'], ['combo-v3-bl', combo, 'bill_of_lading', 'ai-doc-v3'], ['inv-v2', v2, 'commercial_invoice', 'ai-doc-v2']];
}
const ORG = '0b5e0000-0000-4000-8000-000000000001', USER = 'a1d00000-0000-4000-8000-000000000002', RES = 'c0de0000-0000-4000-8000-000000000001';
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
async function runHandler(X, H, o) {
  o = o || {};
  const log = { calls: [], rpc: [], lines: [] };
  const rows = o.rows || [];
  const q = { select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, limit() { return Promise.resolve({ data: rows, error: null }); },
    maybeSingle() { return Promise.resolve({ data: { id: 'x' }, error: null }); } };
  const userDb = { auth: { getUser: () => Promise.resolve({ data: { user: { id: USER } }, error: null }) },
    rpc: name => Promise.resolve(name === 'ai_access' ? { data: { can_use: true }, error: null } : { data: null, error: { message: 'x' } }),
    from: () => q };
  const svc = { rpc: (name, args) => { log.rpc.push([name, args]); return Promise.resolve(name === 'ai_reserve' ? { data: RES, error: null }
    : name === 'ai_settle' ? { data: { cost_usd: 0.0123 }, error: null } : { data: true, error: null }); } };
  let n = 0;
  const claude = { beta: { messages: { stream: (params) => { log.calls.push(params); n++;
    if (o.reject400 && n === 1) { const e = new Error('bad'); e.status = 400; return { finalMessage: () => Promise.reject(e) }; }
    return { finalMessage: () => Promise.resolve({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'text', text: JSON.stringify(o.answer) }] }) }; } } } };
  const body = Object.assign({ org_id: ORG, doc_type: 'auto', lang: 'ar', prompt_version: 'ai-doc-v3', file: { media_type: 'image/png', data_b64: PNG_B64 } }, o.body || {});
  Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k]; });
  const raw = JSON.stringify(body);
  const req = { method: 'POST', headers: { get: h => (h === 'authorization' ? 'Bearer user-token' : h === 'content-length' ? String(raw.length) : null) },
    body: { getReader() { let done = false; return { read: () => Promise.resolve(done ? { done: true } : (done = true, { done: false, value: new TextEncoder().encode(raw) })), cancel: () => Promise.resolve() }; } } };
  const res = await H.handleRequest(req, { configured: true, isAnonKey: () => false, userClient: () => userDb, serviceClient: () => svc, modelConfigured: true,
    claudeClient: () => claude, now: () => 1000, sdk: {}, log: t => log.lines.push(t), X });
  return { res, body: res.body ? JSON.parse(res.body) : null, log };
}

/* ------------------------------------------------------------------ helpers */
const quickInvoiceAnswer = () => ({ doc_type: 'commercial_invoice', detected_documents: ['commercial_invoice'],
  fields: [
    { name: 'invoice_number', value: 'INV-77', confidence: 0.95, page: 1, document: 'commercial_invoice' },
    { name: 'buyer_name', value: 'AL BAHR TRADING', confidence: 0.95, page: 1, document: 'commercial_invoice' },
    { name: 'supplier_vat', value: '300000000000003', confidence: 0.95, page: 1, document: 'commercial_invoice' },   // not a quick key → dropped
    { name: 'payment_terms', value: 'T/T', confidence: 0.95, page: 1, document: 'commercial_invoice' },             // not a quick key → dropped
    { name: 'subtotal', value: '765.00', confidence: 0.95, page: 1, document: 'commercial_invoice' },
    { name: 'total', value: '765.00', confidence: 0.95, page: 1, document: 'commercial_invoice' },
    { name: 'currency', value: 'USD', confidence: 0.95, page: 1, document: 'commercial_invoice' }],
  line_items: [{ description: 'COTTON T-SHIRT', hs_code: '6109.10', quantity: 306, unit: 'PCS', amount: 765,
    unit_price: 2.5, notes: 'x', origin_country: 'CN' }],    // columns outside the compact set (a model that ignored the schema) are not kept
  containers: [{ container_number: 'MSCU1234566', size_type: '40hc', seal_number: 'SL1001' }], warnings: [] });
const msgOf = d => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: J(d) }] });
const quickMark = () => Object.assign({}, X.QUICK_WARNING);
const savedRow = (o) => Object.assign({ id: 'e0000000-0000-4000-8000-000000000001', org_id: ORG, transaction_id: null, doc_type: 'commercial_invoice',
  engine: 'claude-opus-5-5', ai_usage_id: 'c0de0000-0000-4000-8000-0000000000ff', extracted_fields: { invoice_number: 'INV-77' }, line_items: [],
  raw_text: 'x', mean_confidence: 95, review_status: 'pending', source_sha256: 'abc', created_at: '2026-11-14T10:00:00Z',
  ai_detail: { prompt_version: 'ai-doc-v3', detected_type: 'commercial_invoice', doc_type: 'commercial_invoice', containers: [],
    fields: [{ name: 'invoice_number', confidence: 0.95, page: 1, valid: true }], warnings: [] } }, o || {});

(async () => {
  console.log('== 1. request validation');
  await check('reading_mode: absent → full; full allowed for every type / version; quick only for v3 shipping documents + auto; any other value → bad_request', async () => {
    const got = {
      none: vr(bodyOf()).reading_mode, full: vr(bodyOf({ reading_mode: 'full' })).reading_mode,
      v2full: vr(bodyOf({ prompt_version: undefined, reading_mode: 'full' })).reading_mode,
      opsFull: vr(bodyOf({ doc_type: 'appointment_ticket', transaction_id: TX, reading_mode: 'full' })).reading_mode,
      quick: SHIP.map(t => vr(bodyOf({ doc_type: t, reading_mode: 'quick' })).reading_mode).join(','),
      v2quick: vr(Object.assign(bodyOf({ reading_mode: 'quick' }), { prompt_version: undefined })),
      opsQuick: ['appointment_ticket', 'empty_return_receipt', 'appointment_invoice', 'payment_proof']
        .map(t => vr(bodyOf({ doc_type: t, transaction_id: TX, reading_mode: 'quick' }))).join(','),
      bad: ['fast', 'QUICK', '', 1, true, {}, ['quick']].map(m => vr(bodyOf({ reading_mode: m }))).join(','),
      nul: vr(bodyOf({ reading_mode: null })).reading_mode
    };
    const want = { none: 'full', full: 'full', v2full: 'full', opsFull: 'full', quick: SHIP.map(() => 'quick').join(','), v2quick: 'bad_request:400',
      opsQuick: 'bad_request:400,bad_request:400,bad_request:400,bad_request:400', bad: Array(7).fill('bad_request:400').join(','), nul: 'full' };
    Object.keys(want).forEach(k => { if (got[k] === undefined) delete got[k]; });
    return J(got) === J(want) || J(got);
  });

  console.log('== 2. full mode unchanged (byte for byte)');
  await check('buildRequest: every doc type × version × language, with no reading_mode AND with reading_mode full = the request of the code before the feature', async () => {
    const bad = [];
    Object.keys(GOLDEN_REQ).forEach(key => {
      const [ver, t, lang] = key.split('|');
      [undefined, 'full'].forEach(m => {
        const b = bodyOf({ doc_type: t, lang, transaction_id: TX, reading_mode: m });
        if (ver === 'ai-doc-v2') delete b.prompt_version;
        if (m === undefined) delete b.reading_mode;
        const got = h16(J(X.buildRequest(X.validateRequest(b))));
        if (got !== GOLDEN_REQ[key]) bad.push(key + '/' + m);
      });
    });
    return bad.length === 0 || bad.join(' ');
  });
  await check('postProcess (no mode / full) of the fixtures (v3 invoice, auto, declaration, combined file, v2) = the output before the feature; no reading_mode, no quick mark', async () => {
    const bad = [];
    fixtures().forEach(([n, d, t, v]) => {
      [undefined, 'full'].forEach(m => {
        const r = X.postProcess(JSON.parse(J(d)), t, v, m);
        if (h16(J(r)) !== GOLDEN_PP[n] || 'reading_mode' in r || r.warnings.some(w => w.code === 'quick_reading')) bad.push(n + '/' + m);
      });
    });
    return bad.length === 0 || bad.join(' ');
  });
  await check('handler: the whole full answer (body) and the reserve / bind / settle calls = the code before the feature (v3 typed / auto / declaration / combined, v2)', async () => {
    const out = {};
    for (const [n, d, t, v] of fixtures()) {
      const r = await runHandler(X, H, { answer: d, body: { doc_type: t, prompt_version: v === 'ai-doc-v3' ? v : undefined } });
      out[n] = r.res.status + ':' + h16(r.res.body) + ':' + crypto.createHash('sha256').update(J(r.log.rpc)).digest('hex').slice(0, 8);
    }
    return J(out) === J(GOLDEN_H) || J(out);
  });
  await check('maxTokensFor / estimateHoldUsd: unchanged without a mode (32000 shipping, 16000 card / EIR / payment); quick → MAX_TOKENS_QUICK', async () => {
    const a = [X.maxTokensFor('auto', 'ai-doc-v3'), X.maxTokensFor('auto', 'ai-doc-v3', 'full'), X.maxTokensFor('appointment_ticket', 'ai-doc-v3'),
      X.maxTokensFor('payment_proof', 'ai-doc-v3', 'quick'), X.maxTokensFor('auto', 'ai-doc-v2', 'quick'), X.maxTokensFor('auto', 'ai-doc-v3', 'quick'),
      X.maxTokensFor('customs_declaration', 'ai-doc-v3', 'quick')];
    return (J(a) === J([32000, 32000, 16000, 16000, 32000, X.MAX_TOKENS_QUICK, X.MAX_TOKENS_QUICK]) && X.MAX_TOKENS_QUICK === 10000
      && X.estimateHoldUsd('image/png', 1000, 1, X.MAX_TOKENS_QUICK) < X.estimateHoldUsd('image/png', 1000, 1, 32000)) || J(a);
  });

  console.log('== 3. quick request: keys, schema, prompt');
  await check('QUICK_KEYS: per type = QUICK_BASE ∩ KEYS_FOR_V3[type] (+ declaration type / Hijri date / Arabic importer on a declaration and auto), every key a DB key, order of KEYS_FOR_V3 kept', async () => {
    const bad = [];
    SHIP.forEach(t => {
      const want = X.KEYS_FOR_V3[t].filter(k => X.QUICK_BASE.indexOf(k) !== -1 || ((t === 'customs_declaration' || t === 'auto') && X.QUICK_DECL.indexOf(k) !== -1));
      if (J(X.QUICK_KEYS[t]) !== J(want)) bad.push(t);
      if (!X.QUICK_KEYS[t].every(k => X.ALL_KEYS_V3.indexOf(k) !== -1)) bad.push(t + ' db');
      if (X.QUICK_KEYS[t].length > X.KEYS_FOR_V3[t].length) bad.push(t + ' longer than full');   // 2026-11-14: a packing list's quick keys may equal its full keys
    });
    // nothing outside the base list, and no invented key (no B/L date / item count key exists)
    if (!X.QUICK_BASE.concat(X.QUICK_DECL).every(k => X.ALL_KEYS_V3.indexOf(k) !== -1)) bad.push('base');
    if (J(X.QUICK_TYPES) !== J(SHIP)) bad.push('types');
    return bad.length === 0 || bad.join(' ');
  });
  await check('QUICK_KEYS cover every key the document match (doc-match.js FIELDS) compares for the slot, when the full reading asks for it', async () => {
    const SLOT = { invoice: 'commercial_invoice', bl: 'bill_of_lading', declaration: 'customs_declaration', packing: 'packing_list' };
    const miss = [];
    E.FIELDS.forEach(f => Object.keys(f.keys || {}).forEach(slot => (f.keys[slot] || []).forEach(k => {
      [SLOT[slot], 'auto'].forEach(t => { if (X.KEYS_FOR_V3[t].indexOf(k) !== -1 && X.QUICK_KEYS[t].indexOf(k) === -1) miss.push(t + ':' + k); });
    })));
    return miss.length === 0 || miss.join(' ');
  });
  await check('quick schema: fields enum = QUICK_KEYS, line_items exactly the compact columns (description, hs_code, quantity, unit, amount), containers number / size / seal, ≤ 16 union-typed parameters (every type)', async () => {
    const bad = [];
    SHIP.forEach(t => {
      const sc = X.outputSchema(t, 'ai-doc-v3', 'quick');
      const it = sc.properties.line_items.items, ct = sc.properties.containers.items, fe = sc.properties.fields.items.properties.name.enum;
      if (J(fe) !== J(X.QUICK_KEYS[t])) bad.push(t + ' enum');
      if (J(Object.keys(it.properties)) !== J(X.QUICK_ITEM_KEYS) || J(it.required) !== J(X.QUICK_ITEM_KEYS) || it.additionalProperties !== false) bad.push(t + ' items');
      if (J(Object.keys(ct.properties).sort()) !== J(X.QUICK_CONTAINER_KEYS.slice().sort()) || J(ct.required) !== J(X.QUICK_CONTAINER_KEYS)) bad.push(t + ' containers');
      if (unions(sc) > 16) bad.push(t + ' unions ' + unions(sc));
      if (!!sc.properties.declaration !== (t === 'customs_declaration' || t === 'auto')) bad.push(t + ' declaration');
      if (unions(sc) >= unions(X.outputSchema(t, 'ai-doc-v3'))) bad.push(t + ' not smaller');
    });
    // the mode never changes a v2 or a card / payment schema
    ['appointment_ticket', 'empty_return_receipt', 'appointment_invoice', 'payment_proof'].forEach(t => {
      if (J(X.outputSchema(t, 'ai-doc-v3', 'quick')) !== J(X.outputSchema(t, 'ai-doc-v3'))) bad.push(t + ' ops');
    });
    if (J(X.outputSchema('auto', 'ai-doc-v2', 'quick')) !== J(X.outputSchema('auto', 'ai-doc-v2'))) bad.push('v2');
    return bad.length === 0 || bad.join(' ');
  });
  await check('quick request: effort low, max_tokens 10000, betas / fallbacks kept, same model, SYSTEM_V3_QUICK, the file first, the focused instruction', async () => {
    const res = [];
    SHIP.forEach(t => {
      const p = X.buildRequest(X.validateRequest(bodyOf({ doc_type: t, reading_mode: 'quick' })));
      const full = X.buildRequest(X.validateRequest(bodyOf({ doc_type: t })));
      const txt = p.messages[0].content[1].text;
      const ok = p.model === 'claude-opus-5-5' && p.output_config.effort === 'low' && X.EFFORT_QUICK === 'low' && p.max_tokens === 10000
        && J(p.betas) === J(X.BETAS) && p.fallbacks === X.FALLBACKS && p.system === X.SYSTEM_V3_QUICK && p.messages[0].content[0].type === 'image'
        && J(p.output_config.format.schema) === J(X.outputSchema(t, 'ai-doc-v3', 'quick'))
        && /QUICK READING: look ONLY for the facts listed below/.test(txt) && /at most 60 characters/.test(txt) && /at\smost 60 rows/.test(txt) && /different products are NEVER merged together/.test(txt)
        && /One row per PRODUCT/.test(txt) && /still add up\nto the printed total/.test(txt)
        && X.QUICK_KEYS[t].every(k => txt.indexOf('\n- ' + k + ': ') !== -1)
        && X.KEYS_FOR_V3[t].filter(k => X.QUICK_KEYS[t].indexOf(k) === -1).every(k => txt.indexOf('\n- ' + k + ': ') === -1)
        && txt.length < full.messages[0].content[1].text.length + 1200
        && /Write warnings in Arabic\.$/.test(txt) && full.output_config.effort === 'medium';
      if (!ok) res.push(t);
    });
    return res.length === 0 || res.join(' ');
  });
  await check('quick system prompt: the classification / per-document rules of SYSTEM_V3 kept, the wide container / item columns (packages, weights, scientific name) not asked', async () => {
    const q = X.SYSTEM_V3_QUICK, f = X.SYSTEM_V3;
    return (q.indexOf(X.SYSTEM) === 0 && /detected_documents/.test(q) && /give a\nfield once PER document/.test(q) && /consignee_name is the name only/.test(q)
      && !/scientific/.test(q) && !/packages and net/.test(q) && /scientific_name/.test(f) && /packages and net/.test(f)) || 'prompt';
  });
  await check('quick declaration: the Fasah rules (type from the title, both dates, every container, B/L exactly as printed + candidates) kept; the item columns compact', async () => {
    const t = X.buildRequest(X.validateRequest(bodyOf({ doc_type: 'customs_declaration', reading_mode: 'quick' }))).messages[0].content[1].text;
    const tf = X.buildRequest(X.validateRequest(bodyOf({ doc_type: 'customs_declaration' }))).messages[0].content[1].text;
    return (/declaration_type comes from the title of the form only/.test(t) && /bl_candidates/.test(t) && /list every container/.test(t)
      && /declaration_date_hijri/.test(t) && !/origin_country/.test(t) && /origin_country, net \/ gross weight in kg/.test(tf)) || t.slice(-600);
  });

  console.log('== 4. quick answer: parse + postProcess');
  await check('postProcess quick: only QUICK_KEYS kept, compact items (unit kept; unit_price / notes / origin dropped), containers normalised (packages / weights kept, 2026-11-14), quick mark first, reading_mode quick, raw_text says quick', async () => {
    const p = X.parseMessage(msgOf(quickInvoiceAnswer()), 'ai-doc-v3', 'auto');
    if (!p.ok) return 'parse ' + p.code;
    const r = X.postProcess(p.data, 'auto', 'ai-doc-v3', 'quick');
    const names = r.fields.map(f => f.name);
    const ok = r.reading_mode === 'quick' && r.doc_type === 'commercial_invoice' && names.indexOf('supplier_vat') === -1
      && names.indexOf('invoice_number') !== -1 && names.indexOf('buyer_name') !== -1
      && J(r.line_items) === J([{ description: 'COTTON T-SHIRT', hs_code: '6109.10', quantity: 306, amount: 765, unit: 'PCS' }])
      && r.containers.length === 1 && r.containers[0].container_number === 'MSCU1234566' && r.containers[0].seal_number === 'SL1001' && r.containers[0].size_type === '40HC'
      && ['packages_count', 'net_weight', 'gross_weight'].every(k => r.containers[0][k] === null || typeof r.containers[0][k] === 'number')
      && r.warnings[0].code === 'quick_reading' && r.warnings[0].source === 'server' && X.isQuickDetail(r.ai_detail) && X.isQuickDetail(r)
      && !('reading_mode' in r.ai_detail) && /^\[claude-opus-5-5 · ai-doc-v3 · quick\] commercial_invoice/.test(r.raw_text)
      && /1\. COTTON T-SHIRT \| 6109\.10 \| 306 \| PCS \| 765/.test(r.raw_text);
    return ok || J(r).slice(0, 600);
  });
  await check('postProcess quick: the server checks still run (totals, ISO 6346, net > gross) and a full postProcess of the same answer has no quick mark', async () => {
    const d = quickInvoiceAnswer();
    d.fields.push({ name: 'vat_amount', value: '1', confidence: 0.9, page: 1, document: 'commercial_invoice' });   // not a quick key: ignored
    d.fields.push({ name: 'net_weight', value: '200', confidence: 0.9, page: 1, document: 'commercial_invoice' }, { name: 'gross_weight', value: '100', confidence: 0.9, page: 1, document: 'commercial_invoice' });
    d.containers.push({ container_number: 'MSCU1234565', size_type: '', seal_number: '' });   // fails the ISO 6346 check digit
    const r = X.postProcess(X.parseMessage(msgOf(d), 'ai-doc-v3', 'auto').data, 'auto', 'ai-doc-v3', 'quick');
    const f = X.postProcess(X.parseMessage(msgOf(quickInvoiceAnswer()), 'ai-doc-v3', 'auto').data, 'auto', 'ai-doc-v3');
    const codes = r.warnings.map(w => w.code);
    return (codes.indexOf('net_over_gross') !== -1 && codes.indexOf('container_check_digit') !== -1 && codes.indexOf('totals_mismatch') === -1
      && !X.isQuickDetail(f.ai_detail) && !('reading_mode' in f)) || J(codes);
  });
  await check('postProcess quick, combined file: by_document still built per document within the quick keys', async () => {
    const d = { doc_type: 'bill_of_lading', detected_documents: ['bill_of_lading', 'packing_list'],
      fields: [{ name: 'bl_number', value: 'MEDU1234567', confidence: 0.9, page: 1, document: 'bill_of_lading' },
        { name: 'gross_weight', value: '165', confidence: 0.9, page: 1, document: 'bill_of_lading' },
        { name: 'gross_weight', value: '166', confidence: 0.9, page: 2, document: 'packing_list' },
        { name: 'notify_party', value: 'SAME AS CONSIGNEE', confidence: 0.9, page: 1, document: 'bill_of_lading' },
        { name: 'freight_terms', value: 'PREPAID', confidence: 0.9, page: 1, document: 'bill_of_lading' }],
      line_items: [], containers: [], warnings: [] };
    const r = X.postProcess(d, 'auto', 'ai-doc-v3', 'quick');
    const bd = r.by_document || {};
    return (bd.bill_of_lading && bd.packing_list && bd.packing_list.some(x => x.name === 'gross_weight' && x.value === '166')
      && bd.bill_of_lading.some(x => x.name === 'freight_terms') && bd.bill_of_lading.some(x => x.name === 'notify_party')) || J(bd);
  });

  console.log('== 5. handler: quick answer, hold, retry, reuse');
  await check('handler quick: the quick request is sent (effort low, 10000, quick schema), the hold uses 10000, the answer says reading_mode quick', async () => {
    const r = await runHandler(X, H, { answer: quickInvoiceAnswer(), body: { reading_mode: 'quick' } });
    const p = r.log.calls[0], reserve = r.log.rpc.find(x => x[0] === 'ai_reserve');
    return (r.res.status === 200 && r.body.reading_mode === 'quick' && r.body.reused === false && p.output_config.effort === 'low' && p.max_tokens === 10000
      && reserve[1].p_est_usd === X.estimateHoldUsd('image/png', 16, 1, 10000) && X.isQuickDetail(r.body.ai_detail)
      && r.body.line_items.every(it => Object.keys(it).every(k => X.QUICK_ITEM_KEYS.indexOf(k) !== -1))) || J({ s: r.res.status, b: r.body && r.body.reading_mode, l: r.log.lines });
  });
  await check('handler quick: the 400 retry (no fallback beta) keeps the quick request (effort low, quick schema, 10000)', async () => {
    const r = await runHandler(X, H, { answer: quickInvoiceAnswer(), body: { reading_mode: 'quick' }, reject400: true });
    const [a, b] = r.log.calls;
    return (r.res.status === 200 && r.log.calls.length === 2 && a.betas && !b.betas && !b.fallbacks && b.output_config.effort === 'low' && b.max_tokens === 10000
      && J(b.output_config.format.schema) === J(a.output_config.format.schema) && r.body.reading_mode === 'quick') || J(r.log.lines);
  });
  await check('reuse: a saved FULL v3 reading answers a quick request (a superset; no call, no charge, no reading_mode)', async () => {
    const r = await runHandler(X, H, { answer: quickInvoiceAnswer(), body: { reading_mode: 'quick' }, rows: [savedRow()] });
    return (r.body.reused === true && r.log.calls.length === 0 && !('reading_mode' in r.body) && !r.log.rpc.length) || J(r.body);
  });
  await check('reuse: a saved QUICK reading answers a quick request (reading_mode quick) but never a full one — that one is read in full (also when it is the only reading in the save scope)', async () => {
    const qrow = savedRow({ ai_detail: Object.assign(savedRow().ai_detail, { warnings: [quickMark()] }) });
    const a = await runHandler(X, H, { answer: quickInvoiceAnswer(), body: { reading_mode: 'quick' }, rows: [qrow] });
    const b = await runHandler(X, H, { answer: fixtures()[1][1], body: { doc_type: 'commercial_invoice' }, rows: [qrow] });
    const c = await runHandler(X, H, { answer: fixtures()[1][1], body: { doc_type: 'commercial_invoice', reading_mode: 'full' }, rows: [qrow, savedRow({ id: 'e0000000-0000-4000-8000-000000000002' })] });
    return (a.body.reused === true && a.body.reading_mode === 'quick' && a.log.calls.length === 0
      && b.body.reused === false && b.log.calls.length === 1 && b.log.calls[0].output_config.effort === 'medium' && !('reading_mode' in b.body)
      && c.body.reused === true && c.body.extraction_id === 'e0000000-0000-4000-8000-000000000002' && c.log.calls.length === 0) || J({ a: a.body.reused, b: b.body.reused, c: c.body.extraction_id });
  });
  await check('reuse: an OCR / v2 reading in the same scope still answers a quick request as itself (unchanged rule)', async () => {
    const ocr = savedRow({ engine: 'tesseract.js@5.1.1', ai_usage_id: null, ai_detail: null });
    const r = await runHandler(X, H, { answer: quickInvoiceAnswer(), body: { reading_mode: 'quick' }, rows: [ocr] });
    return (r.body.reused === true && r.body.engine === 'tesseract.js@5.1.1' && r.body.prompt_version === null && !('reading_mode' in r.body)) || J(r.body);
  });

  console.log('== 6. comparison with quick readings');
  await check('doc-match: compact items (no unit_price) group by HS / description and sum to the invoice total like full items', async () => {
    const inv = { fields: { invoice_number: { value: 'INV-77' }, subtotal: { value: '765.00' }, total: { value: '765.00' }, currency: { value: 'USD' } },
      items: [{ description: 'COTTON T-SHIRT', hs_code: '6109.10', quantity: 306, unit: 'PCS', amount: 765 }] };
    const bl = { fields: { invoice_number: { value: 'INV-77' } }, items: [] };
    const decl = { fields: { invoice_number: { value: 'INV-77' }, total: { value: '765' }, currency: { value: 'USD' } },
      items: [{ description: 'تي شيرت قطن', hs_code: '610910000000', quantity: 306, unit: 'PCS', amount: 765 }] };
    const R = E.compare({ invoice: inv, bl, declaration: decl });
    const it = R.items;
    return (it.totals && it.totals.status === 'match' && it.groups.length === 1 && it.groups[0].status === 'match' && it.groups[0].quantity.declaration === 306) || J(it);
  });

  console.log('== 7. front end');
  const html = read('ocr.html'), ocr = read('assets/js/ocr.js'), mx = read('assets/js/ocr-match.js'), supa = read('assets/js/supa.js'), css = read('assets/css/pages/ocr.css');
  await check('ocr.html: «قراءة سريعة» switch ON by default in the AI engine group and in the matching section (one hint each, described-by)', async () => {
    const eng = html.slice(html.indexOf('id="ocr-engine-group"'), html.indexOf('</fieldset>', html.indexOf('id="ocr-engine-group"')));
    const sec = html.slice(html.indexOf('id="ocr-match-section"'), html.indexOf('id="ocr-match-slots"'));
    return (/<input type="checkbox" id="ocr-quick" checked aria-describedby="ocr-quick-hint">/.test(eng) && /id="ocr-quick-hint"/.test(eng) && /id="ocr-quick-wrap" hidden/.test(eng)
      && /<input type="checkbox" id="ocr-match-quick" checked aria-describedby="ocr-match-quick-hint">/.test(sec) && /id="ocr-match-quick-hint"/.test(sec)
      && (html.match(/قراءة سريعة \(البيانات المهمة فقط — أسرع\)/g) || []).length === 2) || 'markup';
  });
  await check('i18n: quick_label / quick_hint / quick_badge / quick_full_btn / quick_full_confirm / quick_full_started in ar and en', async () => {
    let reg = null;
    const ctx = { window: { MarsaI18n: { register: (n, o) => { reg = o; } } } };
    vm.createContext(ctx); vm.runInContext(read('assets/i18n/ocr.js'), ctx);
    const keys = ['quick_label', 'quick_hint', 'quick_badge', 'quick_full_btn', 'quick_full_confirm', 'quick_full_started'];
    return (keys.every(k => typeof reg.ar[k] === 'string' && reg.ar[k] && typeof reg.en[k] === 'string' && reg.en[k])
      && reg.ar.quick_label === 'قراءة سريعة (البيانات المهمة فقط — أسرع)' && reg.ar.quick_badge === 'قراءة سريعة' && reg.ar.quick_full_btn === 'اقرأ المستند كاملًا') || 'i18n';
  });
  await check('ocr.js QUICK_FIELD_KEYS = extract.js QUICK_BASE + QUICK_DECL; supa.js AI_QUICK_TYPES = QUICK_TYPES', async () => {
    const m = ocr.match(/var QUICK_FIELD_KEYS = (\[[\s\S]*?\]);/), s = supa.match(/var AI_QUICK_TYPES = (\[[\s\S]*?\]);/);
    const a = m && vm.runInNewContext(m[1]), b = s && vm.runInNewContext(s[1]);
    return (J(a) === J(X.QUICK_BASE.concat(X.QUICK_DECL)) && J(b) === J(X.QUICK_TYPES)) || J({ a, b });
  });
  await check('preference (vm, ocr.js + ocr-match.js): one key marsa.ocr.quick; default ON; "0" → OFF; a throwing localStorage → ON and no throw', async () => {
    const run = (src, from, to, storage) => {
      const i = src.indexOf(from), j = src.indexOf(to, i);
      const ctx = { window: { localStorage: storage }, document: { getElementById: () => null }, $: () => null };
      vm.createContext(ctx); vm.runInContext(src.slice(i, j) + ';this.quickPref = quickPref; this.setQuickPref = setQuickPref; this.quickOn = quickOn;', ctx);
      return ctx;
    };
    const mem = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
    const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const out = [];
    [[ocr, '    var QUICK_PREF', '    function isQuickJob'], [mx, '    var QUICK_PREF', '    function isQuickRes']].forEach(([src, a, b]) => {
      const st = mem(), c = run(src, a, b, st);
      const d = c.quickPref(); c.setQuickPref(false); const off = c.quickPref(); const key = Object.keys(st.m).join();
      c.setQuickPref(true); const on = c.quickPref();
      const c2 = run(src, a, b, boom); let thr = false; try { c2.setQuickPref(false); } catch (e) { thr = true; }
      out.push(d === true && off === false && on === true && key === 'marsa.ocr.quick' && c2.quickPref() === true && !thr && c.quickOn() === true);
    });
    return out.every(Boolean) || J(out);
  });
  await check('ocr.js: a job is read quick when the switch is on unless «اقرأ المستند كاملًا» forced a full read; only then is readingMode sent; the quick mark is not listed as a warning', async () => {
    return (/j\.readingMode = mode === 'ai' && !j\.forceFull && quickOn\(\) \? 'quick' : 'full';/.test(ocr)
      && /if \(j\.readingMode === 'quick'\) q\.readingMode = 'quick';/.test(ocr)
      && /var quick = res\.reading_mode === 'quick';/.test(ocr) && /w\.source === 'server' && w\.code === 'quick_reading'/.test(ocr)
      && /j\.forceFull = false;/.test(ocr)) || 'ocr.js wiring';
  });
  await check('ocr.js (vm): rereadFull asks first only when a field / item was edited, then forces a full read of the same job', async () => {
    const i = ocr.indexOf('    function rereadFull(j) {'), j = ocr.indexOf('    function startAiReread(j) {');
    const mk = (yes) => {
      const c = { running: false, asked: 0, started: [], said: [], $: () => ({}), T: k => k, announce: m => c.said.push(m),
        ask: () => { c.asked++; return Promise.resolve(yes); }, startAiReread: jb => c.started.push(jb.forceFull) };
      vm.createContext(c); vm.runInContext(ocr.slice(i, j) + ';this.rereadFull = rereadFull;', c); return c;
    };
    const base = () => ({ file: {}, fields: { a: { value: '1', source: 'ai' } }, items: [{ description: 'x' }], machineItems: [{ description: 'x' }] });
    const a = mk(true); a.rereadFull(base());
    const b = mk(false); const jb = base(); jb.fields.a.source = 'manual'; b.rereadFull(jb);
    const c = mk(true); const jc = base(); jc.items[0].description = 'y'; c.rereadFull(jc);
    await new Promise(r => setImmediate(r));
    return (a.asked === 0 && J(a.started) === '[true]' && b.asked === 1 && b.started.length === 0 && c.asked === 1 && J(c.started) === '[true]') || J({ a: a.started, b: b.started, c: c.started });
  });
  await check('ocr.js renderMeta: «قراءة سريعة» badge + «اقرأ المستند كاملًا» (not for a saved or reused reading, disabled while reading) built with el() / textContent; quick results do not flag keys a quick reading never returns', async () => {
    const i = ocr.indexOf('      if (isQuickJob(j)) {'), blk = ocr.slice(i, ocr.indexOf('\n      }\n', i));
    return (i > 0 && /badge\('badge-warning ocr-quick-badge', T\('quick_badge'\)\)/.test(blk) && /if \(j\.file && !j\.saved && !j\.ai\.reused && aiAvailable\(\)\)/.test(blk)
      && /fb\.disabled = running;/.test(blk) && !/innerHTML/.test(blk) && /function needKeys\(j\)/.test(ocr) && /needKeys\(j\)\.indexOf\(def\.key\)/.test(ocr)) || blk;
  });
  await check('ocr-match.js: slots read quick with the switch (not after «اقرأ المستند كاملًا»), badge + button per quick slot (not saved / reused / bridged), the quick mark not listed, the two switches mirror each other', async () => {
    return (/if \(q\.promptVersion === 'ai-doc-v3' && !s\.forceFull && quickOn\(\)\) q\.readingMode = 'quick';/.test(mx)
      && /if \(s\.file && !s\.bridged && !s\.res\.reused && !S\.saved\.extractions\[k\] && !S\.running\)/.test(mx)
      && /T\('quick_badge'\)/.test(mx) && /fb\.setAttribute\('data-full', k\)/.test(mx)
      && /if \(w\.source === 'server' && w\.code === 'quick_reading'\) return;/.test(mx)
      && /var o = \$\('ocr-quick'\); if \(o\) o\.checked = c\.checked;/.test(mx) && /var m = \$\('ocr-match-quick'\); if \(m\) m\.checked = c\.checked;/.test(ocr)
      && /s\.forceFull = false;/.test(mx)) || 'ocr-match wiring';
  });
  await check('ocr-match.js (vm): readFull asks only when a value was corrected, then re-reads just that slot in full', async () => {
    const i = mx.indexOf('    function readFull(k) {'), j = mx.indexOf('\n    }\n', i) + 6;
    const mk = (yes, corrected) => {
      const c = { asked: 0, runs: 0, SLOTS: ['invoice', 'bl'], T: k => k, renderSlot() {}, syncRun() {}, run() { c.runs++; },
        ask: () => { c.asked++; return Promise.resolve(yes); }, isQuickRes: r => !!(r && r.reading_mode === 'quick'),
        S: { running: false, slots: { invoice: { file: {}, status: 'done', res: { reading_mode: 'quick' }, fields: { total: { value: '1', corrected: corrected } } } } } };
      vm.createContext(c); vm.runInContext(mx.slice(i, j) + ';this.readFull = readFull;', c); return c;
    };
    const a = mk(true, false); a.readFull('invoice');
    const b = mk(false, true); b.readFull('invoice');
    const c = mk(true, true); c.readFull('invoice');
    await new Promise(r => setImmediate(r));
    const sa = a.S.slots.invoice;
    return (a.asked === 0 && a.runs === 1 && sa.forceFull === true && sa.status === 'ready' && b.asked === 1 && b.runs === 0 && c.runs === 1) || J({ a: a.runs, b: b.runs, c: c.runs });
  });
  await check('supa.js aiExtract: reading_mode sent only for readingMode quick on a v3 shipping document / auto (a full request body is unchanged)', async () => {
    return /if \(v3 && o\.readingMode === 'quick' && AI_QUICK_TYPES\.indexOf\(docType\) !== -1\) body\.reading_mode = 'quick';/.test(supa) || 'supa';
  });
  await check('browser code stays ES5 (no arrow / let / const / template literal in ocr.js, ocr-match.js); css has the quick rules (hidden in print)', async () => {
    const es6 = src => /=>|`|^\s*(let|const)\s/m.test(src);
    return (!es6(ocr) && !es6(mx) && /\.ocr-quick \{/.test(css) && /@media print \{ \.ocr-quick, \.ocr-quick-full \{ display: none !important; \} \}/.test(css)) || 'es5/css';
  });

  console.log('\n' + (nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})();

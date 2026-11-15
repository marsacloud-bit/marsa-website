#!/usr/bin/env node
/*
  Marsa (مرسى) — ocr.html matching: automatic save of every comparison + reopening a saved one (#match=<id>), 2026-11-15.
  LOCAL TESTS ONLY. Runs the real page (ocr.html + i18n + doc-match.js + fasah-sheet.js + ocr-match.js) in jsdom against a
  recording MarsaApi mock. No database, no network (fetch throws). Invented data only.

  Covers: readings brought from the single reader (compareReadings) → saved automatically once (readings reused, one
  unlinked match, «حُفظت تلقائيًا» message, the save button + transaction picker stay usable, the draft box is not blocked);
  a corrected value → one new automatic match that voids the old one; «حفظ في النظام» with a transaction → the readings are
  linked (reviewExtraction transaction_id), a match on the transaction, the automatic one voided; «حفظ» without a transaction
  after an automatic save → nothing new; #match-tx / a reopened match → never saved automatically; reopening: ticks, the
  approval note, the transaction, the info message; a voided match / a different result → not bound (saved again as new).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/match-autosave-dom-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try { const r = await fn(); if (typeof r === 'string') fail(name, r); else if (!r) fail(name, 'assertion false'); else pass(name); }
  catch (e) { fail(name, 'threw: ' + (e && e.stack || e)); }
}
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORG = 'd7c40000-0000-4000-8000-0000000000aa';
const TX = 'd7c40000-0000-4000-8000-0000000000b1';
const EX = { invoice: 'd7c40000-0000-4000-8000-000000000101', bl: 'd7c40000-0000-4000-8000-000000000102' };
const OLD = 'd7c40000-0000-4000-8000-000000000201';
let matchSeq = 0;

/* ------------------------------------------------------------------ page */
function page(opts) {
  opts = opts || {};
  const html = rd('ocr.html').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '');
  const dom = new JSDOM(html, { url: 'https://marsa.test/ocr.html' + (opts.hash || ''), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = globalThis.fetch;
  w.confirm = () => true; w.prompt = () => 'سبب';
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [];
  const rec = (n, a) => calls.push({ n, a });
  const ok = d => Promise.resolve({ data: d, error: null });
  const extRow = (id, slot) => ({ id, doc_type: slot === 'bl' ? 'bill_of_lading' : 'commercial_invoice', source_name: slot + '.pdf', transaction_id: null, document_id: null,
    extracted_fields: slot === 'bl' ? { bl_number: 'MEDU1234567', gross_weight_kg: '1000', packages_count: '10' } : { bl_number: 'MEDU1234567', gross_weight_kg: '1000', packages_count: '10', invoice_number: 'INV-1' },
    reviewed_fields: null, line_items: [], mean_confidence: 90 });
  const saved = opts.saved || null;
  w.MarsaApi = {
    isOnline: () => true,
    getSession: () => ok({ user: { id: 'u1', email: 'staff@example.com' } }),
    isStaff: () => ok(true),
    activeOrgId: () => ok(ORG),
    aiAccess: () => ok({ can_use: true, daily_remaining: 50 }),
    aiExtract: () => Promise.reject(new Error('no AI in tests')),
    onAuth: () => {},
    saveExtraction: r => { rec('saveExtraction', r); return ok(Object.assign({ id: 'd7c40000-0000-4000-8000-0000000003' + String(calls.length).padStart(2, '0') }, r)); },
    findExtractionBySource: o => { rec('findExtractionBySource', o); return ok(opts.dupOnLink && o.transactionId ? { id: 'd7c40000-0000-4000-8000-0000000009' + (o.sha256 === 'a'.repeat(64) ? '01' : '02'), doc_type: 'commercial_invoice' } : null); },
    reviewExtraction: (id, p) => {
      rec('reviewExtraction', { id, p });
      if (opts.dupOnLink && p.transaction_id) return Promise.resolve({ data: null, error: { code: 'MRS_EXTRACTION_DUPLICATE', message: 'dup' } });
      return ok({ id });
    },
    attachExtractionDocument: (id, o) => { rec('attachExtractionDocument', { id, tx: o.transactionId }); return ok({ id }); },
    saveDocumentMatch: o => { if (opts.failMatch) { rec('saveDocumentMatch', o); return Promise.resolve({ data: null, error: { code: 'MRS_FORBIDDEN', message: 'forbidden' } }); } if (opts.delay) { const d = opts.delay; opts.delay = 0; return new Promise(r => setTimeout(r, d)).then(() => w.MarsaApi.saveDocumentMatch(o)); } const id = 'd7c40000-0000-4000-8000-0000000004' + String(++matchSeq).padStart(2, '0'); rec('saveDocumentMatch', Object.assign({ _id: id }, o)); return ok({ id, status: 'saved', created_at: '2026-11-15T09:00:00Z' }); },
    reviewDocumentMatch: (id, rows, note) => { rec('reviewDocumentMatch', { id, rows, note }); return ok({ id, status: 'reviewed' }); },
    voidDocumentMatch: (id, reason) => { rec('voidDocumentMatch', { id, reason }); return ok({ id }); },
    listDocumentMatches: () => { rec('listDocumentMatches'); return ok(opts.recent || []); },
    getDocumentMatch: id => { rec('getDocumentMatch', id); return ok(saved); },
    getExtraction: id => { rec('getExtraction', id); return ok(extRow(id, id === EX.bl ? 'bl' : 'invoice')); },
    listExtractions: () => ok([]),
    listTransactions: () => ok([{ id: TX, ref: 'MRS-2026-000009', bl_number: 'MEDU1234567', clients: { name_ar: 'عميل تجريبي' } }]),
    util: { uuid: () => 'd7c40000-0000-4000-8000-0000000005' + String(calls.length).padStart(2, '0') }
  };
  ['assets/js/i18n.js', 'assets/i18n/ocr.js', 'assets/i18n/decl.js', 'assets/js/doc-match.js', 'assets/js/ops/fasah-sheet.js', 'assets/js/ocr-match.js']
    .forEach(f => { try { w.eval(rd(f) + '\n//# sourceURL=' + f); } catch (e) { throw new Error(f + ': ' + e.message); } });
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, calls, extRow, $: id => w.document.getElementById(id), n: name => calls.filter(c => c.n === name) };
}
// readings of the single reader that it already saved (no file / no AI call needed): reused, never inserted
const bridged = P => [P.extRow(EX.invoice, 'invoice'), P.extRow(EX.bl, 'bl')].map((row, i) => {
  const slot = i ? 'bl' : 'invoice';
  const fields = {}; Object.keys(row.extracted_fields).forEach(k => { fields[k] = { value: row.extracted_fields[k], score: 0.9 }; });
  return { slot, label: row.source_name, fileName: row.source_name, fields, items: [],
    res: { fields: Object.keys(fields).map(k => ({ name: k, value: fields[k].value })), doc_type: row.doc_type, kind: row.doc_type },
    saved: { id: row.id, doc_type: row.doc_type, transaction_id: null, document_id: null } };
});
const msg = P => (P.$('ocr-match-save-msg-text') || P.$('ocr-match-save-msg') || {}).textContent || '';

async function main() {
  /* 1. auto save */
  let P = page();
  await sleep(50);
  const opened = P.w.MarsaOcrMatch && P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await check('the page loads in jsdom and compareReadings shows a report', () => (opened === true && !P.$('ocr-match-result').hidden) || J({ opened }));
  await sleep(1600);
  await check('auto save: one unlinked match with the two reused readings, no reading inserted', () => {
    const m = P.n('saveDocumentMatch');
    return (m.length === 1 && !m[0].a.transactionId && m[0].a.invoiceExtractionId === EX.invoice && m[0].a.blExtractionId === EX.bl
      && P.n('saveExtraction').length === 0) || J(P.calls.map(c => c.n));
  });
  await check('auto save: «حُفظت تلقائيًا» message; save button + transaction picker still usable', () =>
    (/تلقائيًا/.test(msg(P)) && !P.$('ocr-match-save-btn').disabled && !P.$('ocr-match-tx').disabled && !P.$('ocr-match-tx-search').disabled) || J({ m: msg(P), b: P.$('ocr-match-save-btn').disabled, t: P.$('ocr-match-tx').disabled }));
  await check('auto save: the recent list is refreshed', () => P.n('listDocumentMatches').length >= 1 || 'no refresh');
  const autoId = P.n('saveDocumentMatch').length ? P.n('saveDocumentMatch')[0].a._id : null;
  await check('draft box: not blocked by the automatic save (no «محفوظة» block text)', () => {
    const t = (P.w.document.querySelector('.ocr-mx-draft') || P.w.document.body).textContent;
    return !/احفظ المطابقة بعد|مطابقة محفوظة بالفعل/.test(t) || t.slice(0, 200);
  });
  await sleep(1500);
  await check('no second automatic save without a change', () => P.n('saveDocumentMatch').length === 1 || P.n('saveDocumentMatch').length);

  /* 2. «حفظ» without a transaction → nothing new */
  P.$('ocr-match-save-btn').click();
  await sleep(50);
  await check('«حفظ في النظام» without a transaction after the automatic save: nothing new, «محفوظة تلقائيًا بالفعل»', () =>
    (P.n('saveDocumentMatch').length === 1 && /بالفعل/.test(msg(P))) || J({ n: P.n('saveDocumentMatch').length, m: msg(P) }));

  /* 3. save on a transaction → readings linked, new match, auto voided */
  const sel = P.$('ocr-match-tx');
  const o = P.w.document.createElement('option'); o.value = TX; o.textContent = 'MRS-2026-000009'; sel.appendChild(o); sel.value = TX;
  const bc = P.$('ocr-match-batch'); if (bc) bc.checked = false;
  P.$('ocr-match-save-btn').click();
  await sleep(200);
  await check('save on a transaction: both readings linked, a match on the transaction, the automatic one voided', () => {
    const m = P.n('saveDocumentMatch'), links = P.n('reviewExtraction').filter(c => c.a.p.transaction_id === TX).map(c => c.a.id).sort();
    const v = P.n('voidDocumentMatch');
    return (m.length === 2 && m[1].a.transactionId === TX && J(links) === J([EX.invoice, EX.bl].sort()) && v.length === 1 && v[0].a.id === autoId
      && P.$('ocr-match-save-btn').disabled) || J({ m: m.map(x => x.a.transactionId), links, v, b: P.$('ocr-match-save-btn').disabled });
  });
  await sleep(1500);
  await check('after the save on a transaction: no further automatic save', () => P.n('saveDocumentMatch').length === 2 || P.n('saveDocumentMatch').length);

  /* 4. a corrected value after an automatic save → replaced */
  P = page();
  await sleep(50);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await sleep(1600);
  const inp = P.w.document.querySelector('#ocr-match-tbody input[type="text"], #ocr-match-tbody [data-edit], #ocr-match-tbody input:not([type="checkbox"])');
  if (inp) { inp.value = '999'; inp.dispatchEvent(new P.w.Event('input', { bubbles: true })); inp.dispatchEvent(new P.w.Event('change', { bubbles: true })); }
  await sleep(1800);
  await check('a corrected value after an automatic save → one new automatic match, the old one voided (no warning)', () => {
    const m = P.n('saveDocumentMatch'), v = P.n('voidDocumentMatch');
    if (!inp) return 'no editable cell found';
    return (m.length === 2 && !m[1].a.transactionId && v.length === 1 && v[0].a.id === m[0].a._id && !/عدّلت قيمة بعد الحفظ/.test(msg(P))) || J({ m: m.length, v, msg: msg(P) });
  });

  /* 5. reopen a saved match */
  const savedRow = r => Object.assign({ id: OLD, org_id: ORG, transaction_id: TX, transaction_ref: 'MRS-2026-000009', invoice_extraction_id: EX.invoice, bl_extraction_id: EX.bl,
    declaration_extraction_id: null, packing_extraction_id: null, mode: 'two_way', status: 'reviewed', reviewed_rows: ['bl_number'], note: 'ملاحظة الحفظ\n[مستوى التدقيق: تدقيق شديد]',
    review_note: 'ملاحظة الاعتماد', created_at: '2026-11-14T09:15:00Z' }, r);
  P = page({ hash: '#match=' + OLD, saved: savedRow({}) });
  await sleep(100);
  // the counts it was saved with = what the page computes now (read them from the report)
  const R0 = P.w.document.querySelectorAll('#ocr-match-tbody tr').length;
  await check('reopen: getDocumentMatch + one getExtraction per reading; report shown', () =>
    (P.n('getDocumentMatch').length === 1 && P.n('getExtraction').length === 2 && !P.$('ocr-match-result').hidden && R0 > 0) || J({ g: P.n('getDocumentMatch').length, e: P.n('getExtraction').length, R0 }));
  await check('reopen: the approval note (review_note), the transaction, the tick on bl_number', () => {
    const cb = P.w.document.querySelector('#ocr-match-tbody input[data-review="bl_number"]');
    return (P.$('ocr-match-note-text').value === 'ملاحظة الاعتماد' && P.$('ocr-match-tx').value === TX && cb && cb.checked) || J({ n: P.$('ocr-match-note-text').value, t: P.$('ocr-match-tx').value, cb: cb && cb.checked });
  });
  await sleep(1600);
  await check('reopen: never saved automatically', () => P.n('saveDocumentMatch').length === 0 && P.n('saveExtraction').length === 0 || J(P.calls.map(c => c.n)));

  P = page({ hash: '#match=' + OLD, saved: savedRow({ status: 'voided' }) });
  await sleep(150);
  await check('reopen a voided match: «ملغاة» warning, not bound (save usable), never auto-saved', async () => {
    await sleep(1500);
    return (/ملغاة/.test(msg(P)) && !P.$('ocr-match-save-btn').disabled && P.n('saveDocumentMatch').length === 0) || J({ m: msg(P), b: P.$('ocr-match-save-btn').disabled });
  });
  P = page({ hash: '#match=' + OLD, saved: savedRow({ status: 'saved', overall: 'match', counts: { match: 99, partial: 0, missing: 0, mismatch: 0 } }) });
  await sleep(150);
  await check('reopen with a different result now: «نتيجة مختلفة» warning, not bound (save usable)', () =>
    (/مختلفة/.test(msg(P)) && !P.$('ocr-match-save-btn').disabled) || J({ m: msg(P), b: P.$('ocr-match-save-btn').disabled }));

  /* 6. recent list: a click shows the summary (files + only the differences) under the item */
  P = page({ recent: [savedRow({ status: 'saved', id: OLD, overall: 'mismatch', counts: { match: 1, partial: 0, missing: 0, mismatch: 1 } })],
    saved: savedRow({ status: 'saved', rows: [
      { key: 'invoice_number', label_ar: 'رقم الفاتورة', status: 'match', values: { invoice: 'INV-1', bl: 'INV-1' } },
      { key: 'consignee', label_ar: 'المستلم', status: 'mismatch', critical: true, detail_ar: 'اسم مختلف', values: { invoice: 'شركة أ', bl: 'شركة ب' } },
      { key: 'vessel', label_ar: 'الباخرة', status: 'info', values: { invoice: null, bl: 'MSC X' } }] }) });
  P.w.MarsaApi.listExtractionNames = ids => { P.calls.push({ n: 'listExtractionNames', a: ids }); return Promise.resolve({ data: [{ id: EX.invoice, source_name: 'invoice-1.pdf', source_pages: 2 }, { id: EX.bl, source_name: 'bl-1.jpg' }], error: null }); };
  await sleep(100);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));   // shows the section → loadRecent
  await sleep(200);
  const btn = P.w.document.querySelector('#ocr-match-recent button.ocr-mx-recent-open');
  await check('recent list: the title is a button (no hash change)', () => (btn && btn.getAttribute('aria-expanded') === 'false') || (P.$('ocr-match-recent') || {}).innerHTML);
  const g0 = P.n('getExtraction').length;
  btn && btn.click();
  await sleep(150);
  const box = P.w.document.querySelector('#ocr-match-recent .ocr-mx-rs');
  await check('summary under the item: the 2 files by name, only the 1 difference (mismatch, not match / info), «حقل أساسي»', () => {
    const t = box ? box.textContent : '';
    const diffs = box ? box.querySelectorAll('.ocr-mx-rs-diffs li').length : -1;
    return (box && !box.hidden && /invoice-1\.pdf/.test(t) && /bl-1\.jpg/.test(t) && /2 صفحة/.test(t) && diffs === 1 && /المستلم/.test(t) && /شركة أ/.test(t) && /شركة ب/.test(t)
      && /حقل أساسي/.test(t) && /اسم مختلف/.test(t) && !/الباخرة/.test(t) && !/رقم الفاتورة/.test(t) && btn.getAttribute('aria-expanded') === 'true') || J({ t, diffs });
  });
  await check('summary: no full readings loaded (only the names), the hash unchanged', () =>
    (P.n('getExtraction').length === g0 && P.n('listExtractionNames').length === 1 && !/match=/.test(P.w.location.hash)) || J({ e: P.n('getExtraction').length - g0, h: P.w.location.hash }));
  btn && btn.click();
  await check('a second click hides it (no reload)', () => (box.hidden && btn.getAttribute('aria-expanded') === 'false' && P.n('getDocumentMatch').filter(Boolean).length >= 1) || 'still shown');
  btn && btn.click();
  const full = [...box.querySelectorAll('button')].find(b => /المراجعة كاملة/.test(b.textContent));
  full && full.click();
  await sleep(250);
  await check('«فتح المراجعة كاملة» → #match=<id> and the review opens', () =>
    (full && P.w.location.hash === '#match=' + OLD && !P.$('ocr-match-result').hidden) || J({ f: !!full, h: P.w.location.hash }));

  /* 7. review fixes */
  // idempotency: the match on the transaction gets its own key
  P = page();
  await sleep(50);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await sleep(1600);
  { const sel2 = P.$('ocr-match-tx'); const o2 = P.w.document.createElement('option'); o2.value = TX; sel2.appendChild(o2); sel2.value = TX; const b2 = P.$('ocr-match-batch'); if (b2) b2.checked = false; }
  P.$('ocr-match-save-btn').click();
  await sleep(200);
  await check('the match saved on a transaction uses a new idempotency key (not the automatic one)', () => {
    const m = P.n('saveDocumentMatch');
    return (m.length === 2 && m[0].a.idempotencyKey && m[1].a.idempotencyKey && m[0].a.idempotencyKey !== m[1].a.idempotencyKey) || J(m.map(x => x.a.idempotencyKey));
  });
  // a correction while the automatic save is running → saved again after it, the first one voided
  P = page({ delay: 600 });
  await sleep(50);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await sleep(1400);   // the automatic save is in flight now
  { const i2 = P.w.document.querySelector('#ocr-match-tbody input:not([type="checkbox"])');
    if (i2) { i2.value = '777'; i2.dispatchEvent(new P.w.Event('input', { bubbles: true })); i2.dispatchEvent(new P.w.Event('change', { bubbles: true })); } }
  await sleep(2600);
  await check('a correction while the automatic save runs → a second automatic save after it, the first voided', () => {
    const m = P.n('saveDocumentMatch'), v = P.n('voidDocumentMatch');
    return (m.length === 2 && v.length === 1 && v[0].a.id === m[0].a._id) || J({ m: m.length, v: v.map(x => x.a.id) });
  });
  // «حفظ» clicked while the automatic save runs → done right after it (on the transaction)
  P = page({ delay: 600 });
  await sleep(50);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await sleep(1400);
  { const sel3 = P.$('ocr-match-tx'); const o3 = P.w.document.createElement('option'); o3.value = TX; sel3.appendChild(o3); sel3.value = TX; const b3 = P.$('ocr-match-batch'); if (b3) b3.checked = false; }
  const busy = P.$('ocr-match-save-btn').disabled;
  await sleep(1500);
  const free = !P.$('ocr-match-save-btn').disabled;
  P.$('ocr-match-save-btn').click();
  await sleep(300);
  await check('«حفظ» is disabled while the automatic save runs, usable right after it, then saves on the transaction', () => {
    const m = P.n('saveDocumentMatch');
    return (busy && free && m.length === 2 && m[1].a.transactionId === TX && P.n('voidDocumentMatch').length === 1) || J({ busy, free, m: m.map(x => x.a.transactionId) });
  });
  // the transaction already has a reading of the same file → that reading is used for the match
  P = page({ dupOnLink: true });
  await sleep(50);
  const br = bridged(P); br[0].sha256 = 'a'.repeat(64); br[1].sha256 = 'b'.repeat(64);
  P.w.MarsaOcrMatch.compareReadings(br);
  await sleep(1600);
  { const sel4 = P.$('ocr-match-tx'); const o4 = P.w.document.createElement('option'); o4.value = TX; sel4.appendChild(o4); sel4.value = TX; const b4 = P.$('ocr-match-batch'); if (b4) b4.checked = false; }
  P.$('ocr-match-save-btn').click();
  await sleep(300);
  await check('link refused as a duplicate on the transaction → findExtractionBySource on it; the match uses that reading when found', () => {
    const f = P.n('findExtractionBySource').filter(c => c.a.transactionId === TX), m = P.n('saveDocumentMatch');
    return (f.length === 2 && m.length === 2 && m[1].a.transactionId === TX && m[1].a.invoiceExtractionId === 'd7c40000-0000-4000-8000-000000000901'
      && m[1].a.blExtractionId === EX.bl) || J({ f: f.length, m: m.map(x => [x.a.transactionId, x.a.invoiceExtractionId, x.a.blExtractionId]) });
  });

  // a failing automatic save is not retried for the same report
  P = page({ failMatch: true });
  await sleep(50);
  P.w.MarsaOcrMatch.compareReadings(bridged(P));
  await sleep(5000);
  await check('a failing automatic save: one attempt only (no retry loop), a warning, «حفظ» usable', () =>
    (P.n('saveDocumentMatch').length === 1 && /تعذّر الحفظ التلقائي/.test(msg(P)) && !P.$('ocr-match-save-btn').disabled) || J({ n: P.n('saveDocumentMatch').length, m: msg(P) }));
  // corrections reach the reading found on the transaction
  P = page({ dupOnLink: true });
  await sleep(50);
  { const br2 = bridged(P); br2[0].sha256 = 'a'.repeat(64); br2[1].sha256 = 'b'.repeat(64); P.w.MarsaOcrMatch.compareReadings(br2); }
  await sleep(300);
  { const i3 = P.w.document.querySelector('#ocr-match-tbody input:not([type="checkbox"])');
    if (i3) { i3.value = '555'; i3.dispatchEvent(new P.w.Event('input', { bubbles: true })); i3.dispatchEvent(new P.w.Event('change', { bubbles: true })); } }
  await sleep(1800);
  { const sel5 = P.$('ocr-match-tx'); const o5 = P.w.document.createElement('option'); o5.value = TX; sel5.appendChild(o5); sel5.value = TX; const b5 = P.$('ocr-match-batch'); if (b5) b5.checked = false; }
  P.$('ocr-match-save-btn').click();
  await sleep(400);
  await check('a corrected value reaches the reading found on the transaction (reviewExtraction reviewed_fields on it)', () => {
    const r = P.n('reviewExtraction').filter(c => c.a.id === 'd7c40000-0000-4000-8000-000000000901' && c.a.p.reviewed_fields);
    return r.length === 1 || J(P.n('reviewExtraction').map(c => [c.a.id, Object.keys(c.a.p)]));
  });

  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

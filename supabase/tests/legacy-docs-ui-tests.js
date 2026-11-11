#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 3 UI tests: assets/js/doc-batch.js (MarsaDocBatch, ocr.html shipment batch + pending
  drafts), assets/js/ops/tx-docs.js (MarsaOps.txDocs, the #tx/<id> section), assets/i18n/docb.js and the page wiring
  (ocr.html / admin.html / sw.js / ocr.css / ops.css). Pure Node, no database, no network, no dependencies (vm + window
  shim, like legacy-tx-ui-tests.js).

  Covers: classic-script wrapper + ES5 source + no innerHTML; the 'docb' dictionary (ar = en keys; every literal and
  every dynamic key family the code builds exists); the draft contract = app.doc_batch_draft_check of 20261119000100
  (section keys, numbers, negatives, dates, ISO container shape, row limits); normalizeDraft / parseNum / normDate;
  fieldSources (merge rule: slot order, last non-empty wins; supplier_name → seller; reviewed fields; confidences);
  flaggedPaths (comparison conflicts, missing codes, merge conflicts); the wrong-slot guard = attach_doc_batch_document
  (detected type, supplier → operator, reused readings keep their kind); dedupe (reused → attach by extraction_id, the
  same file in the batch is never read); extractionRow ⊆ supa.js EXT_INSERT with ai_detail; batchActions = the
  lifecycle table; approvePayload / approveKey (the approve_doc_batch payload, idempotency per request); matchView;
  filterBatches / parseHash / approveSummary / pool; tx-docs shipmentRows ⊆ transaction_shipment_data columns; static
  wiring (script order, precache, VERSION, hidden staff section, approval only behind the confirm dialog).

  usage:  node supabase/tests/legacy-docs-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const J = JSON.stringify;

let pass = 0, fail = 0;
const fails = [];
let sec = '';
function section(t) { sec = t; if (!QUIET) console.log('\n== ' + t); }
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r !== true && r && typeof r === 'object') { try { JSON.stringify(r); } catch (e) { r = 'got a non-true value (' + (r.tagName || typeof r) + ')'; } }
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }

/* ------------------------------------------------------------ load as a browser would */
const dicts = { ar: {}, en: {} };
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts.ar[key] != null ? dicts.ar[key] : key;
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  lang() { return 'ar'; }
};
const win = { MarsaI18n: I18N };
const ctx = { window: win, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
vm.createContext(ctx);
vm.runInContext(rd('assets/i18n/docb.js'), ctx, { filename: 'docb.js' });
vm.runInContext(rd('assets/js/doc-batch.js'), ctx, { filename: 'doc-batch.js' });
vm.runInContext(rd('assets/js/ops/tx-sections.js'), ctx, { filename: 'tx-sections.js' });
vm.runInContext(rd('assets/js/ops/tx-docs.js'), ctx, { filename: 'tx-docs.js' });
const DB = win.MarsaDocBatch;
const P = DB && DB.pure;
const TXD = win.MarsaOps && win.MarsaOps.txDocs;
const MIG = rd('supabase/migrations/20261119000100_legacy_docs.sql');
const SUPA = rd('assets/js/supa.js');
const SRC = rd('assets/js/doc-batch.js'), TXSRC = rd('assets/js/ops/tx-docs.js'), DICT = rd('assets/i18n/docb.js');
const sqlArr = name => {
  const m = new RegExp(name + " text\\[\\] := ARRAY\\[([^\\]]*)\\]").exec(MIG);
  return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : null;
};
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333';

/* ================================================================ wrapper */
section('wrapper / source');
check('classic script sets MarsaDocBatch with the pure helpers (no DOM needed)', () => !!(DB && DB.VERSION === 'docb-ui-1' && P && typeof P.normalizeDraft === 'function') || 'missing');
check('tx-docs.js registers the shipment_docs section (order 35) next to the G3 sections', () => {
  const s = win.MarsaOps.txSections, m = s.filter(x => x.id === 'shipment_docs');
  return (m.length === 1 && m[0].order === 35 && s.some(x => x.id === 'bls') && TXD && TXD.VERSION === 'docb-tx-1') || J(s.map(x => x.id));
});
check('loading tx-docs.js twice keeps one section', () => {
  vm.runInContext(TXSRC, ctx, { filename: 'tx-docs.js#2' });
  return win.MarsaOps.txSections.filter(x => x.id === 'shipment_docs').length === 1 || 'duplicated';
});
const NEW_JS = ['assets/js/doc-batch.js', 'assets/js/ops/tx-docs.js', 'assets/i18n/docb.js', 'sw.js'];
NEW_JS.forEach(f => check(f + ': ES5 (no let / const / arrow / template / class)', () => {
  const src = rd(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const bad = [/\blet\s/, /\bconst\s/, /=>/, /`/, /\bclass\s+[A-Z]/, /\basync\s+function/, /\bawait\s/].filter(r => r.test(src));
  return !bad.length || bad.map(String).join(' ');
}));
['assets/js/doc-batch.js', 'assets/js/ops/tx-docs.js', 'assets/i18n/docb.js'].forEach(f =>
  check(f + ': no innerHTML / insertAdjacentHTML / document.write', () => !/innerHTML|insertAdjacentHTML|document\.write/.test(rd(f)) || 'found'));
check('doc-batch.js: no eval / new Function / external URL', () => !/\beval\(|new Function|https?:\/\//.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')) || 'found');

/* ================================================================ dictionary */
section('docb dictionary');
const arK = Object.keys(dicts.ar).filter(k => k.startsWith('docb.')).sort(), enK = Object.keys(dicts.en).filter(k => k.startsWith('docb.')).sort();
check('ar and en have the same docb keys', () => J(arK) === J(enK) || ('ar-only ' + J(arK.filter(k => !enK.includes(k))) + ' en-only ' + J(enK.filter(k => !arK.includes(k)))));
check('no empty strings', () => arK.concat(enK).every(k => String(dicts.ar[k] || dicts.en[k]).trim() && String(dicts.en[k]).trim()) || 'empty');
check('every literal T(\'key\') of doc-batch.js and tx-docs.js exists', () => {
  const keys = new Set();
  (SRC + TXSRC).replace(/\bT\('([a-z0-9_]+)'/g, (m, k) => { keys.add(k); return m; });
  const miss = [...keys].filter(k => !('docb.' + k in dicts.ar) && !/_$/.test(k));
  return !miss.length || J(miss);
});
const has = k => ('docb.' + k) in dicts.ar && ('docb.' + k) in dicts.en;
const fam = (prefix, list) => list.filter(x => !has(prefix + x));
check('slot_ / sec_ / st_ / ls_ families', () => {
  const m = fam('slot_', P.SLOTS).concat(fam('sec_', P.SECTIONS), fam('st_', P.STATUSES), fam('ls_', P.LIST_STATUSES));
  return !m.length || J(m);
});
check('cmp_ (comparison fields) / miss_ (missing codes) / meth_ (client methods) / match_state_', () => {
  const m = fam('cmp_', P.COMPARE_FIELDS).concat(fam('miss_', P.MISSING_CODES), fam('meth_', P.CLIENT_METHODS),
    fam('match_state_', ['suggested', 'review', 'conflict', 'none']));
  return !m.length || J(m);
});
check('every draft field has a label (f_<section>_<key> or f_<key>)', () => {
  const m = [];
  P.SECTIONS.forEach(s => { const d = P.FIELDS[s]; d.text.concat(d.num, d.arr).forEach(k => { if (!has('f_' + s + '_' + k) && !has('f_' + k)) m.push(s + '.' + k); }); });
  return !m.length || J(m);
});
check('every table column has a c_ label', () => {
  const cols = new Set(P.CONTAINER.text.concat(P.CONTAINER.num, P.INV_ITEM.text, P.INV_ITEM.num, P.PACK_ITEM.text, P.PACK_ITEM.num));
  const m = [...cols].filter(c => !has('c_' + c));
  return !m.length || J(m);
});
check('q_ (queue states) / kind_ / rev_ / agent_ / ap_need_ / ap_r_bl_ / ap_r_alias_ / target_ / operation_ / mode_', () => {
  const m = fam('q_', ['queued', 'sending', 'reading', 'saving', 'attaching', 'done', 'reused', 'skipped', 'wrong', 'error'])
    .concat(fam('kind_', ['bill_of_lading', 'commercial_invoice', 'packing_list', 'customs_declaration', 'operator_invoice', 'supplier_invoice', 'other']),
      fam('rev_', ['unreviewed', 'reviewed', 'rejected']), fam('agent_', ['name', 'alias', 'contains']),
      fam('ap_need_', ['version', 'target', 'transaction', 'client', 'draft']), fam('ap_r_bl_', ['created', 'existing', 'none']),
      fam('ap_r_alias_', ['approved', 'suggested']), fam('target_', ['existing', 'new']), fam('operation_', ['import', 'export']),
      fam('mode_', ['sea', 'air', 'land']), fam('new_', ['operation', 'mode']));
  return !m.length || J(m);
});
check('review statuses = the document_extractions CHECK', () => /review_status IN \('unreviewed','reviewed','rejected'\)/.test(rd('supabase/migrations/20261101000100_document_extractions.sql')) || 'changed');
check('ocr.html data-i18n="docb.*" keys exist', () => {
  const ks = (rd('ocr.html').match(/data-i18n="docb\.([a-z0-9_]+)"/g) || []).map(s => s.slice(16, -1));
  return (ks.length >= 3 && ks.every(has)) || J(ks.filter(k => !has(k)));
});
check('placeholders: ar and en use the same {vars}', () => {
  const bad = arK.filter(k => { const v = s => (String(s).match(/\{[a-z]+\}/g) || []).sort().join(); return v(dicts.ar[k]) !== v(dicts.en[k]); });
  return !bad.length || J(bad);
});

/* ================================================================ contract */
section('draft contract = app.doc_batch_draft_check (20261119000100)');
eq('shipment text keys', P.FIELDS.shipment.text, sqlArr('s_text'));
eq('shipment number keys', P.FIELDS.shipment.num, sqlArr('s_num'));
eq('invoice text keys', P.FIELDS.invoice.text, sqlArr('i_text'));
eq('packing text keys', P.FIELDS.packing.text, sqlArr('p_text'));
eq('invoice item text / number keys', [P.INV_ITEM.text, P.INV_ITEM.num], [sqlArr('ii_text'), sqlArr('ii_num')]);
eq('packing item text / number keys', [P.PACK_ITEM.text, P.PACK_ITEM.num], [sqlArr('pi_text'), sqlArr('pi_num')]);
check('invoice: total + container_numbers / seal_numbers; packing totals', () =>
  (/'draft\.invoice', i_text, ARRAY\['total'\], ARRAY\['container_numbers','seal_numbers'\]/.test(MIG)
    && /ARRAY\['total_packages','total_net_weight','total_gross_weight'\]/.test(MIG)
    && J(P.FIELDS.invoice.num) === J(['total']) && J(P.FIELDS.packing.num) === J(['total_packages', 'total_net_weight', 'total_gross_weight'])) || 'changed');
check('container keys = the SQL row check', () => /ARRAY\['container_number','seal_number','size_type'\],\s*ARRAY\['packages_count','net_weight','gross_weight'\]/.test(MIG)
  && J(P.CONTAINER) === J({ text: ['container_number', 'seal_number', 'size_type'], num: ['packages_count', 'net_weight', 'gross_weight'] }) || 'changed');
check('missing codes = doc_batch_compare order', () => {
  const got = (MIG.slice(MIG.indexOf('the required-fields checklist')).match(/array_append\(v_missing, '([a-z_]+)'\)/g) || []).map(s => s.split("'")[1]);
  return J(got) === J(P.MISSING_CODES) || J(got);
});
check('comparison fields = doc_batch_compare rows', () => {
  const got = (MIG.match(/app\.doc_cmp_row\('([a-z_]+)'/g) || []).map(s => s.split("'")[1]);
  return J(got) === J(P.COMPARE_FIELDS) || J(got);
});
check('statuses = the doc_batches CHECK; slots + limits = attach_doc_batch_document', () =>
  (/status IN \('draft','approved','discarded','archived'\)/.test(MIG) && J(P.STATUSES) === J(['draft', 'approved', 'discarded', 'archived'])
    && /v_slot NOT IN \('bill_of_lading','commercial_invoice','packing_list','customs_declaration'\)/.test(MIG)
    && /v_max := CASE WHEN v_slot IN \('bill_of_lading','customs_declaration'\) THEN 1 ELSE 10 END/.test(MIG)
    && J(P.SLOT_MAX) === J({ bill_of_lading: 1, commercial_invoice: 10, packing_list: 10, customs_declaration: 1 })) || 'changed');
check('list statuses = list_pending_doc_batches filter', () => /'draft','approved','discarded','archived','open'|'open'/.test(MIG.slice(MIG.indexOf('FUNCTION public.list_pending_doc_batches'), MIG.indexOf('FUNCTION public.discard_doc_batch'))) || 'no open');

/* ================================================================ normalizeDraft */
section('parseNum / normDate / normalizeDraft');
eq('parseNum: plain, thousands, Arabic digits, Arabic decimal, empty, junk', [P.parseNum('1200'), P.parseNum('1,250.5'), P.parseNum('١٢٣٫٥'),
  P.parseNum('  '), P.parseNum(null), isNaN(P.parseNum('12 kg')), P.parseNum(-3), P.parseNum('-18')], [1200, 1250.5, 123.5, null, null, true, -3, -18]);
eq('normDate: ISO kept, d/m/yyyy, invalid', [P.normDate('2026-11-05'), P.normDate('5/11/2026'), P.normDate('31/02/2026'), P.normDate('nov 5'), P.normDate('')],
  ['2026-11-05', '2026-11-05', null, null, '']);
check('typed strings → numbers, lists, ISO containers; empties and unknown keys dropped', () => {
  const r = P.normalizeDraft({
    shipment: { bl_number: ' MEDU123 ', net_weight: '1,200.5', gross_weight: '', temperature_c: '-18', vessel: '  ', junk: 'x',
      containers: [{ container_number: 'msku 123456-7', seal_number: 'SL1' }, {}, { container_number: '', seal_number: '' }] },
    invoice: { invoice_date: '5/11/2026', total: '٣٠٠', container_numbers: 'msku1234567, MSKU1234567 ;TGHU7654321', seal_numbers: 'S1 S2',
      items: [{ description: 'Dates', quantity: '10', unit: 'carton' }, { description: '' }] },
    packing: { total_packages: 40, items: [] }, declaration: { declaration_number: '' }, unknown: { a: 1 }, source_notes: [' n1 ', 3, '']
  });
  const want = {
    shipment: { bl_number: 'MEDU123', net_weight: 1200.5, temperature_c: -18, containers: [{ container_number: 'MSKU1234567', seal_number: 'SL1' }] },
    invoice: { invoice_date: '2026-11-05', total: 300, container_numbers: ['MSKU1234567', 'TGHU7654321'], seal_numbers: ['S1', 'S2'],
      items: [{ description: 'Dates', unit: 'carton', quantity: 10 }] },
    packing: { total_packages: 40, items: [] }, source_notes: ['n1']
  };
  return (J(r.draft) === J(want) && r.errors.length === 0) || J(r);
});
check('errors: negative weight, bad date, bad container, non-number, long seal', () => {
  const r = P.normalizeDraft({ shipment: { net_weight: '-5', packages_count: 'ten', containers: [{ container_number: 'ABC123' }, { container_number: 'MSKU1234567', seal_number: 'x'.repeat(31) }] },
    invoice: { invoice_date: '2026-13-40' }, packing: { items: [{ net_weight: '-1' }] } });
  const want = ['shipment.packages_count', 'shipment.net_weight', 'shipment.containers.0.container_number', 'shipment.containers.1.seal_number',
    'invoice.invoice_date', 'packing.items.0.net_weight'];
  return J(r.errors.slice().sort()) === J(want.slice().sort()) || J(r.errors);
});
check('only temperature_c may be negative (= NEGATIVE keys of the SQL check)', () => /ARRAY\['temperature_c'\]\);/.test(MIG) && P.normalizeDraft({ shipment: { measurement_cbm: '-1', temperature_c: '-25.5' } }).errors.join() === 'shipment.measurement_cbm' || 'changed');
check('rows over the limits are reported (300 containers, 500 items)', () => {
  const c = []; for (let i = 0; i < 301; i++) c.push({ container_number: 'MSKU' + String(1000000 + i) });
  const it = []; for (let i = 0; i < 501; i++) it.push({ description: 'x' + i });
  const r = P.normalizeDraft({ shipment: { containers: c }, invoice: { items: it } });
  return (r.errors.includes('shipment.containers') && r.errors.includes('invoice.items') && r.draft.shipment.containers.length === 300 && r.draft.invoice.items.length === 500) || J(r.errors);
});
check('normalized output only uses keys the SQL check accepts', () => {
  const r = P.normalizeDraft({ shipment: { shipper: 'A', containers: [{ container_number: 'MSKU1234567', size_type: '40HC', gross_weight: '1' }] },
    invoice: { seller: 'B', items: [{ supplier_hs_code: '0804', total: '5' }] }, packing: { items: [{ container_number: 'MSKU1234567', packages: '2' }] } });
  const ok = (o, def) => Object.keys(o).every(k => def.text.concat(def.num, def.arr || []).includes(k) || k === 'containers' || k === 'items');
  return (ok(r.draft.shipment, P.FIELDS.shipment) && ok(r.draft.invoice, P.FIELDS.invoice) && ok(r.draft.packing, P.FIELDS.packing)
    && ok(r.draft.shipment.containers[0], P.CONTAINER) && ok(r.draft.invoice.items[0], P.INV_ITEM) && ok(r.draft.packing.items[0], P.PACK_ITEM)) || J(r.draft);
});
eq('draftEmpty / getPath / setPath', [P.draftEmpty({}), P.draftEmpty({ shipment: {} }), P.draftEmpty({ invoice: { total: 1 } }),
  P.getPath({ a: { b: [{ c: 3 }] } }, 'a.b.0.c'), J(P.setPath({}, 'shipment.containers.0.seal_number', 'S'))],
  [true, true, false, 3, J({ shipment: { containers: [{ seal_number: 'S' }] } })]);

/* ================================================================ sources + flags */
section('fieldSources / flaggedPaths');
const docs = [
  { id: 'd3', slot: 'commercial_invoice', seq: 2, extraction_id: 'e3', source_name: 'inv2.pdf', mean_confidence: 70 },
  { id: 'd1', slot: 'bill_of_lading', seq: 1, extraction_id: 'e1', source_name: 'bl.pdf', mean_confidence: 90 },
  { id: 'd2', slot: 'commercial_invoice', seq: 1, extraction_id: 'e2', source_name: 'inv1.pdf', mean_confidence: 80 },
  { id: 'd4', slot: 'packing_list', seq: 1, extraction_id: 'e4', source_name: 'pl.pdf', mean_confidence: null }
];
const readings = {
  e1: P.readingOf({ extracted_fields: { bl_number: 'MEDU1', consignee: 'ACME TRADING\nRIYADH' }, fields: [{ name: 'bl_number', confidence: 0.97 }] }),
  e2: P.readingOf({ extracted_fields: { supplier_name: 'Seller One', invoice_number: 'INV-1' }, reviewed_fields: { invoice_number: 'INV-1A' } }),
  e3: P.readingOf({ extracted_fields: { supplier_name: 'Seller Two', buyer_name: '' }, ai_detail: { fields: [{ name: 'supplier_name', confidence: 0.4 }] } }),
  e4: P.readingOf({ extracted_fields: { packages_count: '40', gross_weight: '1000' } })
};
const SRCS = P.fieldSources(docs, readings);
eq('B/L field with its own confidence', [SRCS['shipment.bl_number'].slot, SRCS['shipment.bl_number'].confidence, SRCS['shipment.bl_number'].source_name], ['bill_of_lading', 0.97, 'bl.pdf']);
eq('consignee_name falls back to the consignee block (as app.doc_reading_section)', SRCS['shipment.consignee_name'] && SRCS['shipment.consignee_name'].field, 'consignee');
eq('seller = supplier_name; the later invoice wins (slot order, then seq) with its field confidence', [SRCS['invoice.seller'].seq, SRCS['invoice.seller'].confidence], [2, 0.4]);
eq('a staff-reviewed field is marked; no field confidence → the document mean / 100', [SRCS['invoice.invoice_number'].reviewed, SRCS['invoice.invoice_number'].confidence], [true, 0.8]);
eq('packing totals come from packages_count / gross_weight; no mean → null', [SRCS['packing.total_packages'].field, SRCS['packing.total_gross_weight'].confidence], ['packages_count', null]);
check('an empty value is never a source; unknown readings are skipped', () => !SRCS['invoice.buyer'] && !P.fieldSources([{ slot: 'bill_of_lading', extraction_id: 'zz' }], readings)['shipment.bl_number'] || 'source');
check('SRC_KEY mapping = app.doc_reading_section', () => /'seller', f -> 'supplier_name'/.test(MIG) && /'buyer', coalesce\(f -> 'buyer_name', f -> 'consignee_name'\)/.test(MIG)
  && /'total_packages', f -> 'packages_count'/.test(MIG) && /'total_net_weight', f -> 'net_weight'/.test(MIG) && /'total_gross_weight', f -> 'gross_weight'/.test(MIG) || 'changed');
check('flaggedPaths: conflicts → every compared path, missing → its field, merge conflicts → section.field', () => {
  const f = P.flaggedPaths({ conflicts: [{ field: 'gross_weight', status: 'conflict' }], matches: [{ field: 'bl_number' }], missing_fields: ['invoice_date', 'packing_items'] },
    [{ section: 'invoice', field: 'seller', values: [] }, { section: 'invoice', field: 'items_truncated' }]);
  return (J(Object.keys(f).sort()) === J(['invoice.invoice_date', 'invoice.seller', 'packing.items', 'packing.total_gross_weight', 'shipment.gross_weight'])
    && f['invoice.seller'][0].kind === 'merge' && f['packing.items'][0].kind === 'missing') || J(f);
});
check('every COMPARE_PATHS / missing path is a draft field, containers or items', () => {
  const ok = p => { const [s, k] = p.split('.'); const d = P.FIELDS[s]; return !!d && (d.text.concat(d.num, d.arr).includes(k) || k === 'containers' || k === 'items'); };
  const all = [].concat(...Object.values(P.COMPARE_PATHS));
  const miss = P.MISSING_CODES.map(m => P.flaggedPaths({ missing_fields: [m] }));
  return (all.every(ok) && miss.every(x => Object.keys(x).length === 1 && Object.keys(x).every(ok))) || 'bad path';
});

/* ================================================================ wrong slot + dedupe */
section('wrong-slot guard / dedupe-before-call');
eq('matching reading → save', P.readingAction('packing_list', { detected_type: 'packing_list', kind: 'packing_list' }), { action: 'save' });
eq('an invoice read in the packing slot → wrong slot, move target = commercial_invoice',
  P.readingAction('packing_list', { detected_type: 'commercial_invoice', kind: 'packing_list' }), { action: 'wrong_slot', detected: 'commercial_invoice', target: 'commercial_invoice' });
eq('supplier_invoice detection = operator_invoice (no slot to move to)', P.slotCheck('commercial_invoice', { detected_type: 'supplier_invoice', kind: 'commercial_invoice' }),
  { ok: false, detected: 'operator_invoice', saved: 'commercial_invoice', target: null });
eq('detected other → refused (the server compares other with the slot too)', P.slotCheck('bill_of_lading', { detected_type: 'other', kind: 'bill_of_lading' }).ok, false);
eq('reused reading in its own slot → attach by extraction_id (no save, no charge)', P.readingAction('bill_of_lading', { reused: true, extraction_id: U1, kind: 'bill_of_lading', detected_type: 'bill_of_lading' }),
  { action: 'attach', extractionId: U1 });
eq('reused reading saved as an invoice, dropped in the B/L slot → move to the invoice slot', P.slotCheck('bill_of_lading', { reused: true, extraction_id: U1, kind: 'commercial_invoice', detected_type: 'commercial_invoice' }).target, 'commercial_invoice');
eq('reused reading whose saved kind ≠ detected → cannot be moved', P.slotCheck('bill_of_lading', { reused: true, extraction_id: U1, kind: 'packing_list', detected_type: 'commercial_invoice' }).target, null);
check('the rule mirrors attach_doc_batch_document (supplier → operator, doc_type and detected both checked)', () =>
  /WHEN e\.ai_detail ->> 'detected_type' = 'supplier_invoice' THEN 'operator_invoice'/.test(MIG) && /IF e\.doc_type <> v_slot OR v_det <> v_slot THEN/.test(MIG) || 'changed');
const H = 'a'.repeat(64);
eq('inBatch: same SHA-256 already attached; bad hash → null', [P.inBatch([{ slot: 'packing_list', source_sha256: H }], H).slot, P.inBatch([{ source_sha256: H }], 'x')], ['packing_list', null]);
eq('slotRoom: B/L full, invoices 10 minus attached and queued', [P.slotRoom([{ slot: 'bill_of_lading' }], 'bill_of_lading', 0),
  P.slotRoom([{ slot: 'commercial_invoice' }, { slot: 'commercial_invoice' }], 'commercial_invoice', 3)], [0, 5]);
check('extractionRow: v3 fields + ai_detail, keys ⊆ supa.js EXT_INSERT', () => {
  const row = P.extractionRow({ res: { usage_id: U2, mean_confidence: 88.4, raw_text: 'x', extracted_fields: { bl_number: 'B1' }, line_items: [{ description: 'a' }],
    fields: [{ name: 'bl_number', page: 3 }], ai_detail: { prompt_version: 'ai-doc-v3', detected_type: 'bill_of_lading' } },
    file: { name: 'bl.pdf', size: 1000 }, sha256: H, mime: 'application/pdf', docType: 'bill_of_lading', orgId: U1, transactionId: U3 });
  const ins = (/var EXT_INSERT = \[([\s\S]*?)\];/.exec(SUPA) || [])[1] || '';
  const allowed = (ins.match(/'([a-z0-9_]+)'/g) || []).map(s => s.slice(1, -1));
  const extra = Object.keys(row).filter(k => !allowed.includes(k));
  return (!extra.length && row.engine === 'claude-opus-5-5' && row.ai_usage_id === U2 && row.ai_detail.prompt_version === 'ai-doc-v3' && row.doc_type === 'bill_of_lading'
    && row.source_pages === 3 && row.transaction_id === U3 && row.org_id === U1 && row.source_sha256 === H) || J({ extra, row });
});
check('doc-batch.js reads with prompt ai-doc-v3, skips files already in the batch before calling, never saves a reused reading', () => {
  const read = SRC.slice(SRC.indexOf('function readOne('), SRC.indexOf('function placeReading('));
  const place = SRC.slice(SRC.indexOf('function placeReading('), SRC.indexOf('function moveQueued('));
  return (/promptVersion: 'ai-doc-v3'/.test(read) && read.indexOf('inBatch(') < read.indexOf('API.aiExtract(')
    && /if \(res\.reused && isUuid\(res\.extraction_id\)\) \{\s*idP = Promise\.resolve\(res\.extraction_id\);/.test(place)
    && place.indexOf('API.saveExtraction(') > place.indexOf('} else {')) || 'flow changed';
});
check('a remaining-quota counter is not decreased for a reused (free) reading', () => /if \(!res\.reused && S\.remaining != null\)/.test(SRC) || 'missing');

/* ================================================================ review fixes (regressions) */
section('review fixes: combined file, queue dedupe, batch size, error text, alias name, alias status, tx-docs precision');
eq('review: a combined file (detected_documents) is accepted in the slot of any type it holds; one without it is still wrong',
  [P.slotCheck('commercial_invoice', { detected_type: 'bill_of_lading', detected_documents: ['bill_of_lading', 'commercial_invoice'], kind: 'commercial_invoice' }).ok,
   P.readingAction('packing_list', { detected_type: 'bill_of_lading', ai_detail: { detected_documents: ['bill_of_lading', 'packing_list'] }, kind: 'packing_list' }).action,
   P.slotCheck('commercial_invoice', { detected_type: 'bill_of_lading', kind: 'commercial_invoice' }).ok],
  [true, 'save', false]);
check('review: the client rule mirrors the server (detected_documents ? slot in attach_doc_batch_document)', () =>
  /\(e\.ai_detail -> 'detected_documents'\) \? v_slot/.test(MIG) && /detectedDocs\(res\)\.indexOf\(slot\) !== -1/.test(SRC) || 'changed');
check('review: the same file queued twice → the later copy is a duplicate (skipped before any AI call); a removed / failed copy does not count', () => {
  const H2 = 'b'.repeat(64);
  const q1 = { id: 1, sha: H2, status: 'queued', slot: 'commercial_invoice' }, q2 = { id: 2, sha: H2, status: 'queued', slot: 'packing_list' };
  const q0 = { id: 0, sha: H2, status: 'removed' }, q3 = { id: 3, sha: 'c'.repeat(64), status: 'queued' };
  return (P.queueDup([q1, q2, q3], q2) === q1 && P.queueDup([q1, q2], q1) === null && P.queueDup([q0, q3], q3) === null && P.queueDup([q0, q2], q2) === null
    && P.queueDup([q1, { id: 5, sha: '', status: 'queued' }], { id: 5, sha: '' }) === null) || 'dup';
});
check('review: readOne checks the queue duplicate BEFORE aiExtract; addFiles flags it as soon as the hash is known', () => {
  const read = SRC.slice(SRC.indexOf('function readOne('), SRC.indexOf('function placeReading('));
  const add = SRC.slice(SRC.indexOf('function addFiles('), SRC.indexOf('function readAll('));
  return (read.indexOf('queueDup(S.queue, q)') !== -1 && read.indexOf('queueDup(S.queue, q)') < read.indexOf('API.aiExtract(') && /queueDup\(S\.queue, q\)/.test(add)) || 'order';
});
eq('review: batch total (inventory 25 MB per batch): queued + in-flight files count, read / failed ones do not',
  [P.BATCH_MAX_BYTES, P.queuedBytes([{ file: { size: 10 }, status: 'queued' }, { file: { size: 5 }, status: 'reading' }, { file: { size: 99 }, status: 'done' }, { file: { size: 7 }, status: 'error' }])],
  [25 * 1024 * 1024, 15]);
check('review: addFiles refuses a file that would take the waiting files over 25 MB (err_batch_total); cancel + 90 s hint wired', () =>
  /queuedBytes\(S\.queue\) \+ \(Number\(f\.size\) \|\| 0\) > BATCH_MAX_BYTES\) \{ q\.status = 'error'; q\.error = T\('err_batch_total'\)/.test(SRC)
  && /setTimeout\(function \(\) \{ if \(S\.running\) \{ S\.slow = true;[\s\S]{0,80}\}, 90000\)/.test(SRC) && /pool\(todo, 3, readOne, function \(\) \{ return S\.cancel; \}\)/.test(SRC)
  && /T\('read_cancel'\)/.test(SRC) || 'missing');
(function () {
  let started = 0;
  let stop = false;
  P.pool([1, 2, 3, 4, 5, 6], 2, x => { started++; if (x === 2) stop = true; return x; }, () => stop).then(out => {
    check('review: pool stops starting new items once cancelled (items in flight finish)', () => (started < 6 && out[0] === 1 && out[5] === undefined) || J({ started, out }));
  });
})();
// the REAL supa.js errorMessage (the mock above only echoes codes): a message built in doc-batch.js must not become the generic text
const supaCtx = (() => {
  const g = {};
  g.window = g; g.location = { hostname: 'localhost', href: 'http://localhost/', protocol: 'http:', search: '', hash: '', pathname: '/' };
  g.document = { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, getElementsByTagName() { return []; },
    documentElement: { getAttribute() { return 'ar'; }, setAttribute() {}, lang: 'ar', classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
    createElement() { return { setAttribute() {}, appendChild() {} }; }, head: { appendChild() {} } };
  g.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  g.navigator = { onLine: true, userAgent: 'node' };
  Object.assign(g, { console, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, parseFloat, isFinite, isNaN, Promise, setTimeout, clearTimeout,
    encodeURIComponent, decodeURIComponent, RegExp, Error, TypeError, Symbol, Map, Set, URL, URLSearchParams, TextEncoder, TextDecoder });
  vm.createContext(g);
  try { vm.runInContext(SUPA, g, { filename: 'supa.js' }); } catch (e) { g.__err = e.message; }
  return g;
})();
check('review: errorText — UI-built precondition / move errors keep their own message with the REAL supa.js errorMessage; API errors keep theirs', () => {
  const A = supaCtx.MarsaApi;
  if (!A || typeof A.errorMessage !== 'function') return 'supa.js not loaded: ' + supaCtx.__err;
  const am = e => A.errorMessage(e);
  const need = dicts.ar['docb.ap_need_client'];
  const generic = A.errorMessage({ code: 'MRS_REQUIRED', message: need });
  const wrong = new Error('محتواه بيان تعبئة'); wrong.code = 'MRS_DOC_WRONG_SLOT';
  const apiErr = A.errorMessage({ code: 'MRS_DOC_BATCH_STALE', message: 'MRS_DOC_BATCH_STALE', raw: null });
  return (need && generic !== need && P.errorText({ code: 'MRS_REQUIRED', message: need }, am, 'G') === need
    && P.errorText({ code: 'MRS_INVALID', message: dicts.ar['docb.ap_save_first'] }, am, 'G') === dicts.ar['docb.ap_save_first']
    && P.errorText(wrong, am, 'G') === 'محتواه بيان تعبئة' && P.errorText({ code: 'MRS_DOC_BATCH_STALE', message: 'MRS_DOC_BATCH_STALE', raw: null }, am, 'G') === apiErr
    && P.errorText(null, am, 'G') === 'G') || J({ need, generic });
});
check('review: the confirmation label / dialog name the alias the server learns (saved importer_name, else the draft consignee) — never the match-search text', () => {
  const fn = SRC.slice(SRC.indexOf('function aliasName('), SRC.indexOf('function targetClientName('));
  return (/S\.batch\.importer_name/.test(fn) && /consigneeName\(S\.draft\)/.test(fn) && !/matchName/.test(fn)
    && /T\('client_confirm', \{ name: aliasName\(\)/.test(SRC) && /T\('ap_c_alias', \{ name: aliasName\(\)/.test(SRC)
    && !/client_confirm', \{ name: S\.matchName/.test(SRC) && /app\.consignee_identity_name\(v_draft #>> '\{invoice,buyer\}'\)\), 160\)/.test(MIG)) || 'alias name';
});
check('review: every alias status client_alias_learn can return has a text (approved / suggested / rejected) + a fallback; merged_previous shown', () =>
  ['approved', 'suggested', 'rejected', 'other'].every(k => dicts.ar['docb.ap_r_alias_' + k] && dicts.en['docb.ap_r_alias_' + k])
  && /if \(r\.merged_previous\) li\(T\('ap_r_merged'/.test(SRC) && !!dicts.ar['docb.ap_r_merged'] && !!dicts.ar['docb.ap_c_merge'] || 'keys');
check('review: candidate reasons are shown through rsn_* texts (incl. suggested_alias / phonetic_name of match_client_v2)', () =>
  ['english_name', 'alias', 'arabic_name', 'vat_number', 'cr_number', 'similar_name', 'suggested_alias', 'phonetic_name'].every(k => dicts.ar['docb.rsn_' + k] && dicts.en['docb.rsn_' + k])
  && ['suggested_alias', 'phonetic_name', 'similar_name'].every(k => MIG.includes("'" + k + "'")) || 'rsn');
check('review: tx-docs keeps the stored precision (unit price numeric(18,4), weights numeric(…,3)) instead of 2 decimals', () => {
  const plain = [TXD.pure.num(null, '0.0035'), TXD.pure.num(null, '0.1250'), TXD.pure.num(null, '125.0000'), TXD.pure.num(null, '1000.500'), TXD.pure.num(null, null)];
  const seen = [];
  I18N.fmtNumber = (n, o) => { seen.push(o && o.digits); return n.toFixed(o && o.digits != null ? o.digits : 2); };
  const viaI18n = TXD.pure.num(null, '0.0035');
  delete I18N.fmtNumber;
  return (J(plain.slice(0, 4)) === J(['0.0035', '0.125', '125', '1000.5']) && plain[4] === dicts.ar['docb.none'] && viaI18n === '0.0035' && seen[0] === 4) || J({ plain, viaI18n, seen });
});

/* ================================================================ lifecycle + approve */
section('batchActions / approvePayload / approveKey');
eq('draft: everything for a writer; nothing for a reader', [P.batchActions('draft', true), P.batchActions('draft', false)],
  [{ edit: true, approve: true, discard: true, archive: true, attach: true }, { edit: false, approve: false, discard: false, archive: false, attach: false }]);
eq('approved frozen, discarded → archive only, archived final', [P.batchActions('approved', true), P.batchActions('discarded', true).archive, P.batchActions('archived', true)],
  [{ edit: false, approve: false, discard: false, archive: false, attach: false }, true, { edit: false, approve: false, discard: false, archive: false, attach: false }]);
eq('batch tied to a transaction: only the version (+ agent / confirm)', P.approvePayload({ version: 4, batchTx: U1, target: 'new', clientId: U2, shippingAgentId: U3, confirmClient: true }),
  { o: { version: 4, shippingAgentId: U3, confirmClient: true } });
eq('existing transaction', P.approvePayload({ version: 1, target: 'existing', transactionId: U1 }), { o: { version: 1, transactionId: U1 } });
eq('new transaction: client + import / sea defaults; bad mode → sea', P.approvePayload({ version: 2, target: 'new', clientId: U2, mode: 'rail' }),
  { o: { version: 2, newTransaction: { clientId: U2, operation: 'import', mode: 'sea' } } });
eq('errors: version, transaction, client, target', [P.approvePayload({ target: 'existing' }).error, P.approvePayload({ version: 1, target: 'existing' }).error,
  P.approvePayload({ version: 1, target: 'new' }).error, P.approvePayload({ version: 1 }).error], ['version', 'transaction', 'client', 'target']);
check('approvePayload options = supa.js approveDocBatch (o.version, transactionId, newTransaction{clientId, operation, mode}, shippingAgentId, confirmClient, idemKey)', () => {
  const f = SUPA.slice(SUPA.indexOf('function approveDocBatch('), SUPA.indexOf('function getTransactionShipment('));
  return ['o.version', 'o.transactionId', 'o.newTransaction.clientId', 'o.newTransaction.operation', 'o.newTransaction.mode', 'o.shippingAgentId', 'o.confirmClient', 'o.idemKey']
    .every(k => f.includes(k)) || 'supa changed';
});
check('the payload keys = approve_doc_batch only_keys (via supa.js mapping)', () =>
  /only_keys\(p, ARRAY\['version','transaction_id','new_transaction','shipping_agent_id','confirm_client','idempotencyKey'\]\)/.test(MIG)
  && /only_keys\(v_new, ARRAY\['client_id','operation','mode'\]\)/.test(MIG) && /v_mode NOT IN \('sea','air','land'\)/.test(MIG) || 'changed');
check('approveKey: same version + request → same key (replay); a new version or request → new key', () => {
  let n = 0; const gen = () => 'k' + (++n);
  const a = P.approveKey(null, 3, { transactionId: U1 }, gen), b = P.approveKey(a, 3, { transactionId: U1 }, gen),
    c = P.approveKey(b, 4, { transactionId: U1 }, gen), d = P.approveKey(c, 4, { transactionId: U1, confirmClient: true }, gen);
  return (a.key === 'k1' && b.key === 'k1' && c.key === 'k2' && d.key === 'k3') || J([a, b, c, d]);
});
check('approval only behind the confirm dialog, only from the approve button (nothing automatic)', () => {
  const calls = SRC.match(/API\.approveDocBatch\(/g) || [];
  const f = SRC.slice(SRC.indexOf('function approve()'), SRC.indexOf('function focusApprove('));
  return (calls.length === 1 && f.includes('API.approveDocBatch(') && f.indexOf('askConfirm(') < f.indexOf('API.approveDocBatch(')
    && /btn\(S\.approving \? T\('approving'\) : T\('approve'\), 'btn-primary btn-lg', approve\)/.test(SRC) && !/confirmClientMatch\(/.test(SRC)) || 'approval path changed';
});
check('the approve button is shown only to ops writers (Shell.R.opsWriter) and a draft batch', () =>
  /Shell\.R && Shell\.R\.opsWriter/.test(SRC) && /if \(!S\.writer\) \{ box\.appendChild\(alertBox\('info', T\('approve_role'\)\)\); return box; \}/.test(SRC)
  && /if \(b\.status === 'draft'\) \{[\s\S]{0,200}renderApprove\(\)/.test(SRC) || 'gate changed');
check('duplicate-guard error (MRS_DUPLICATE_TX) gets its own explanation; stale → reload', () =>
  /code === 'MRS_DUPLICATE_TX'\) text = T\('ap_dup_tx'\)/.test(SRC) && /MRS_DOC_BATCH_STALE[\s\S]{0,120}reloadStale/.test(SRC) || 'missing');
check('every save / approve sends the version read', () => /version: S\.version, draft: n\.draft/.test(SRC) && /approvePayload\(\{ version: S\.version/.test(SRC) || 'missing');

/* ================================================================ client match + list */
section('matchView / consigneeName / filterBatches / parseHash / approveSummary');
const mres = { candidates: [{ client_id: U2, confidence: 72 }, { client_id: U1, confidence: 95 }], best: { client_id: U1, confidence: 95 }, suggested: true, conflict: false, thresholds: { suggest: 90, review: 70 } };
eq('suggested → preselect best, candidates sorted', [P.matchView(mres).state, P.matchView(mres).preselect, P.matchView(mres).candidates[0].client_id], ['suggested', U1, U1]);
eq('review / conflict / none never preselect', [P.matchView({ candidates: [{ client_id: U1, confidence: 80 }], suggested: false }).state,
  P.matchView(Object.assign({}, mres, { conflict: true })).preselect, P.matchView({ candidates: [] }).state, P.matchView(null).preselect], ['review', null, 'none', null]);
eq('consigneeName: identity name, else first line of the block, else buyer', [P.consigneeName({ shipment: { consignee_name: 'ACME', consignee: 'X' } }),
  P.consigneeName({ shipment: { consignee: 'ACME TRADING CO\nP.O. BOX 1' } }), P.consigneeName({ invoice: { buyer: 'Buyer Ltd' } }), P.consigneeName({})],
  ['ACME', 'ACME TRADING CO', 'Buyer Ltd', '']);
const L = [{ id: 'a', branch_id: 'b1', transaction_ref: 'TX-1', client_name: 'Acme' }, { id: 'b', branch_id: 'b2', bl_number: 'MEDU9' }];
eq('filterBatches: branch + text', [P.filterBatches(L, { branchId: 'b2' }).map(x => x.id), P.filterBatches(L, { q: 'acme' }).map(x => x.id), P.filterBatches(L, {}).length], [['b'], ['a'], 2]);
eq('parseHash', [P.parseHash('#batch=' + U1), P.parseHash('#tx=' + U2.toUpperCase()), P.parseHash('#batch=nope'), P.parseHash('')], [{ batch: U1 }, { tx: U2 }, {}, {}]);
eq('approveSummary', P.approveSummary({ ref: 'T-9', created_transaction: true, bl: { created: false }, containers: { added: ['A', 'B'], updated: ['C'], unchanged: [] },
  invoice_items: 3, packing_items: 2, extractions_linked: 4, tx_filled: ['vessel'], tx_kept: ['bl_number'], client_alias: { status: 'suggested' }, conflicts: [{}], missing_fields: [], replayed: true }),
  { ref: 'T-9', created: true, replayed: true, bl: 'existing', added: 2, updated: 1, unchanged: 0, invoiceItems: 3, packingItems: 2, linked: 4,
    filled: ['vessel'], kept: ['bl_number'], alias: 'suggested', conflicts: 1, missing: 0 });

/* ================================================================ tx-docs */
section('tx-docs (#tx/<id> section)');
check('shipmentRows: only filled values, columns of transaction_shipment_data', () => {
  const g = TXD.pure.shipmentRows({ bl_number: 'MEDU1', vessel: '', net_weight_kg: 10, invoice_number: 'I1', total_value: 0, packing_total_packages: 4, junk: 1 });
  const cols = (MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.transaction_shipment_data'), MIG.indexOf('COMMENT ON TABLE public.transaction_shipment_data'))
    .match(/^\s{2}([a-z_]+)\s+(text|numeric|date)/gm) || []).map(s => s.trim().split(/\s+/)[0]);
  const used = (TXSRC.match(/\['f_[a-z_]+', '([a-z_]+)'/g) || []).map(s => s.split("'")[3]);
  const bad = used.filter(c => !cols.includes(c));
  return (!bad.length && J(g.shipment.map(r => r[1])) === J(['MEDU1', '10']) && J(g.invoice.map(r => r[1])) === J(['I1', '0']) && g.packing.length === 1) || J({ bad, g });
});
eq('links', [TXD.pure.docsLink(U1), TXD.pure.batchLink(U2)], ['ocr.html#tx=' + U1, 'ocr.html#batch=' + U2]);
check('the read link is only for ops writers of the branch on a live transaction; data via getTransactionShipment', () =>
  /var canWrite = !api\.cancelled && api\.can\('opsWriter', tx\.branch_id\);/.test(TXSRC) && /call\(api, 'getTransactionShipment', tx\.id\)/.test(TXSRC) || 'changed');

/* ================================================================ wiring */
section('page wiring (static)');
const OCR = rd('ocr.html'), ADMIN_HTML = rd('admin.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/ocr.css'), OPSCSS = rd('assets/css/pages/ops.css');
const pos = (h, f) => h.indexOf('src="' + f + '"');
check('ocr.html: i18n.js → i18n/docb.js; supa.js → app-shell.js → doc-batch.js (after ocr-match.js)', () => {
  const a = pos(OCR, 'assets/js/i18n.js'), b = pos(OCR, 'assets/i18n/docb.js'), c = pos(OCR, 'assets/js/supa.js'), d = pos(OCR, 'assets/js/app-shell.js'),
    e = pos(OCR, 'assets/js/ocr-match.js'), f = pos(OCR, 'assets/js/doc-batch.js');
  return (a > 0 && a < b && c < d && d < f && e < f) || J([a, b, c, d, e, f]);
});
check('ocr.html: #docb-section hidden by default (staff only), #docb-root, #docb-pending, live region', () =>
  /id="docb-section"[^>]*hidden/.test(OCR) && /id="docb-root"/.test(OCR) && /id="docb-pending"/.test(OCR) && /id="docb-live" role="status"/.test(OCR) || 'markup');
check('admin.html: i18n/docb.js before admin.js; tx-legacy.js → tx-docs.js → admin.js', () => {
  const a = pos(ADMIN_HTML, 'assets/i18n/docb.js'), b = pos(ADMIN_HTML, 'assets/js/ops/tx-legacy.js'), c = pos(ADMIN_HTML, 'assets/js/ops/tx-docs.js'), d = pos(ADMIN_HTML, 'assets/js/admin.js');
  return (a > 0 && a < d && b < c && c < d) || J([a, b, c, d]);
});
check('sw.js precaches doc-batch.js, ops/tx-docs.js, i18n/docb.js; VERSION ≥ 2026-11-19.1', () => {
  const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';/m.exec(SW) || [])[1] || '';
  return (["'assets/js/doc-batch.js'", "'assets/js/ops/tx-docs.js'", "'assets/i18n/docb.js'"].every(f => SW.includes(f))
    && v.localeCompare('2026-11-19.1', 'en', { numeric: true }) >= 0) || v;
});
check('every MarsaApi function the UI calls is exported by supa.js', () => {
  const names = new Set();
  (SRC + TXSRC).replace(/API\.([a-zA-Z]+)\(/g, (m, n) => { names.add(n); return m; });
  (TXSRC).replace(/call\(api, '([a-zA-Z]+)'/g, (m, n) => { names.add(n); return m; });
  const ex = SUPA.slice(SUPA.indexOf('  var api = {'), SUPA.indexOf('window.MarsaApi = api'));
  const miss = [...names].filter(n => !new RegExp('\\b' + n + ':').test(ex) && !new RegExp('\\b' + n + ': function').test(SUPA));
  return !miss.length || J(miss);
});
check('375px: the batch tables scroll in their own box; one-column slots / fields under 640px', () =>
  /\.docb-table-wrap \{ max-height: 60vh; overflow: auto; \}/.test(CSS) && /@media \(max-width: 640px\) \{\s*\.docb-slot-grid \{ grid-template-columns: 1fr; \}\s*\.docb-grid \{ grid-template-columns: 1fr; \}/.test(CSS)
  && (SRC.match(/'table-wrap docb-table-wrap'/g) || []).length >= 2 && /'table-wrap adm-table-wrap'/.test(TXSRC) && /\.docb-tx-dl/.test(OPSCSS) || 'css');
check('untrusted values only via textContent / value (el(tag, cls, text) helper)', () => /n\.textContent = text;/.test(SRC) && !/\.innerText\s*=/.test(SRC) || 'helper changed');
check('docs: LEGACY_DOCS_AR.md names the UI files', () => { const d = rd('docs/online/LEGACY_DOCS_AR.md'); return (d.includes('assets/js/doc-batch.js') && d.includes('assets/js/ops/tx-docs.js')) || 'docs'; });

/* ================================================================ DOM flow (fake DOM + mocked MarsaApi, no network) */
const { makeDom } = require('./lib/fake-dom.js');
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 30); i++) await tick(); }
const ORG = '0000000a-0000-4000-8000-00000000000a', BR = '0000000b-0000-4000-8000-00000000000b', C1 = '0000000c-0000-4000-8000-00000000000c';
const TX = '0000000d-0000-4000-8000-00000000000d', AG = '0000000e-0000-4000-8000-00000000000e';
let idn = 100;
const nid = () => '00000000-0000-4000-8000-' + String(++idn).padStart(12, '0');
function mockApi(opts) {
  opts = opts || {};
  const calls = [];
  const db = { batches: {}, ext: {} };
  const rec = (n, a) => calls.push({ n, a: JSON.parse(JSON.stringify(a === undefined ? null : a)) });
  const full = b => JSON.parse(JSON.stringify(Object.assign({}, b, { document_count: b.documents.length })));
  const ok = d => Promise.resolve({ data: d, error: null });
  const err = (code, field) => Promise.resolve({ data: null, error: { code, field, message: code + (field ? ':' + field : '') } });
  // a reused reading already saved for the org (the server's dedupe-before-call)
  const REUSED = nid();
  db.ext[REUSED] = { id: REUSED, doc_type: 'commercial_invoice', source_sha256: 'f'.repeat(64), extracted_fields: { invoice_number: 'INV-OLD', supplier_name: 'Old Seller' }, line_items: [] };
  const api = {
    isOnline: () => true,
    getSession: () => ok({ user: { email: 'staff@example.test' } }),
    isStaff: () => ok(true),
    activeOrgId: () => ok(ORG),
    aiAccess: () => ok({ can_use: true, daily_remaining: 10 }),
    listBranches: () => ok([{ id: BR, name_ar: 'الفرع الرئيسي', is_active: true }]),
    listPendingDocBatches: o => { rec('listPendingDocBatches', o); return ok(Object.values(db.batches).filter(b => !o.transactionId || b.transaction_id === o.transactionId)
      .filter(b => o.status === 'open' ? ['draft', 'discarded'].includes(b.status) : b.status === (o.status || 'draft')).map(full)); },
    createDocBatch: o => { rec('createDocBatch', o); const b = { id: nid(), org_id: ORG, branch_id: BR, kind: 'shipment', status: 'draft', version: 1, transaction_id: o.transactionId || null,
      documents: [], draft: {}, comparison: { engine: 'batch-v1', matches: [], conflicts: [], missing_fields: [] }, created_by_name: 'Staff', created_at: '2026-11-11T08:00:00Z' };
      db.batches[b.id] = b; return ok(full(b)); },
    getDocBatch: id => { rec('getDocBatch', id); return db.batches[id] ? ok(full(db.batches[id])) : err('MRS_NOT_FOUND', 'doc_batch'); },
    getTransaction: id => ok({ id, ref: 'TX-1', client_id: C1, clients: { name_ar: 'أكمي' } }),
    getExtraction: id => db.ext[id] ? ok(db.ext[id]) : err('MRS_NOT_FOUND'),
    aiExtract: o => {
      rec('aiExtract', { docType: o.docType, promptVersion: o.promptVersion, media: o.file.media_type, tx: o.transactionId || null });
      const name = o.__name;
      if (o.docType === 'commercial_invoice' && opts.reuseInvoice !== false && api.__nextReused) {
        api.__nextReused = false;
        return ok({ reused: true, extraction_id: REUSED, kind: 'commercial_invoice', doc_type: 'commercial_invoice', detected_type: 'commercial_invoice',
          fields: [{ name: 'invoice_number', value: 'INV-OLD', confidence: 0.9 }], extracted_fields: db.ext[REUSED].extracted_fields, line_items: [], usage: { cost_usd: 0 } });
      }
      const det = o.docType === 'packing_list' ? 'commercial_invoice' : o.docType;
      const ef = o.docType === 'bill_of_lading' ? { bl_number: 'MEDU1234567', consignee: 'ACME TRADING CO\nRIYADH', consignee_name: 'ACME TRADING CO', gross_weight: '100', shipping_line: 'MSC' }
        : { invoice_number: 'INV-9', supplier_name: 'Seller Co' };
      return ok({ usage_id: nid(), engine: 'claude-opus-5-5', prompt_version: 'ai-doc-v3', doc_type: o.docType, detected_type: det, kind: o.docType,
        fields: Object.keys(ef).map(k => ({ name: k, value: ef[k], confidence: k === 'gross_weight' ? 0.42 : 0.93, page: 1 })), extracted_fields: ef, line_items: [],
        mean_confidence: 91, raw_text: 'x', containers: [], ai_detail: { prompt_version: 'ai-doc-v3', detected_type: det, doc_type: o.docType }, reused: false, extraction_id: null,
        usage: { cost_usd: 0.01 } });
    },
    saveExtraction: row => { rec('saveExtraction', { doc_type: row.doc_type, ai_detail: !!row.ai_detail, engine: row.engine, org_id: row.org_id, tx: row.transaction_id || null });
      const id = nid(); db.ext[id] = Object.assign({ id }, row); return ok({ id }); },
    findExtractionBySource: () => ok(null),
    attachDocBatchDocument: (bid, eid, slot) => {
      rec('attachDocBatchDocument', { slot, eid });
      const b = db.batches[bid], e = db.ext[eid];
      if (e.doc_type !== slot) return err('MRS_DOC_WRONG_SLOT', slot + ':' + e.doc_type);
      const seq = b.documents.filter(d => d.slot === slot).length + 1;
      const d = { id: nid(), slot, seq, extraction_id: eid, detected_type: slot, doc_type: e.doc_type, source_name: e.source_name || 'old.pdf',
        source_sha256: e.source_sha256, mean_confidence: e.mean_confidence == null ? 80 : e.mean_confidence, review_status: 'unreviewed' };
      b.documents.push(d); return ok({ document: d, already_attached: false, batch: full(b) });
    },
    detachDocBatchDocument: () => ok({}),
    mergeDocBatch: id => {
      rec('mergeDocBatch', id);
      const b = db.batches[id], draft = {};
      b.documents.forEach(d => { const e = db.ext[d.extraction_id].extracted_fields;
        if (d.slot === 'bill_of_lading') draft.shipment = { bl_number: e.bl_number, consignee: e.consignee, consignee_name: e.consignee_name, gross_weight: Number(e.gross_weight), shipping_line: e.shipping_line, containers: [] };
        if (d.slot === 'commercial_invoice') draft.invoice = Object.assign(draft.invoice || {}, { invoice_number: e.invoice_number, seller: e.supplier_name, items: [] });
      });
      return ok({ draft, merge_conflicts: b.documents.filter(d => d.slot === 'commercial_invoice').length > 1
        ? [{ section: 'invoice', field: 'invoice_number', values: [{ slot: 'commercial_invoice', seq: 1, value: 'INV-OLD' }, { slot: 'commercial_invoice', seq: 2, value: 'INV-9' }] }] : [],
        comparison: { engine: 'batch-v1', matches: [{ field: 'bl_number', status: 'match', values: { bl: 'MEDU1234567' } }],
          conflicts: [{ field: 'gross_weight', status: 'conflict', values: { bl: 100, packing: 120 } }], missing_fields: ['invoice_date', 'packing_items'] }, version: b.version });
    },
    saveDocBatchDraft: (id, o) => {
      rec('saveDocBatchDraft', o);
      const b = db.batches[id];
      if (opts.stale) return err('MRS_DOC_BATCH_STALE');
      if (o.version !== b.version) return err('MRS_DOC_BATCH_STALE');
      b.version += 1; if (o.draft) b.draft = o.draft; if (o.clientId !== undefined) b.client_id = o.clientId; b.client_match = o.clientMatch;
      b.comparison = { engine: 'batch-v1', matches: [], conflicts: [{ field: 'gross_weight', status: 'conflict', values: { bl: 100, packing: 120 } }], missing_fields: ['invoice_date'] };
      return ok(full(b));
    },
    matchClientV2: o => { rec('matchClientV2', o); return ok({ source_name: o.name, candidates: [{ client_id: C1, name_ar: 'أكمي', name_en: 'ACME TRADING CO', confidence: 96, method: 'english_name', reasons: ['exact'] }],
      best: { client_id: C1, confidence: 96, method: 'english_name' }, suggested: true, conflict: false, thresholds: { suggest: 90, review: 70 } }); },
    matchShippingAgent: name => { rec('matchShippingAgent', name); return ok([{ party_id: AG, name_ar: 'وكيل MSC', name_en: 'MSC', match: 'name' }]); },
    listTransactions: o => { rec('listTransactions', o); return ok([{ id: TX, ref: 'TX-1', bl_number: 'MEDU1234567', client_id: C1, clients: { name_ar: 'أكمي' } }]); },
    listClients: () => ok([]),
    approveDocBatch: (id, o) => {
      rec('approveDocBatch', o);
      if (opts.dupTx) return err('MRS_DUPLICATE_TX', 'container');
      const b = db.batches[id];
      if (o.version !== b.version) return err('MRS_DOC_BATCH_STALE');
      b.status = 'approved'; b.transaction_id = TX; b.transaction_ref = 'TX-NEW'; b.approved_at = '2026-11-11T09:00:00Z';
      b.approve_result = { batch_id: id, status: 'approved', transaction_id: TX, ref: 'TX-NEW', created_transaction: !!o.newTransaction, client_id: C1,
        bl: { id: nid(), bl_number: 'MEDU1234567', created: true, existing: false }, containers: { added: [], updated: [], unchanged: [] }, invoice_items: 0, packing_items: 0,
        extractions_linked: b.documents.length, tx_filled: ['vessel'], tx_kept: [], client_alias: { alias_id: nid(), status: o.confirmClient ? 'approved' : 'suggested' }, conflicts: [], missing_fields: [] };
      return ok(b.approve_result);
    },
    rejectClientAlias: () => ok({}),
    discardDocBatch: (id, r) => { rec('discardDocBatch', r); db.batches[id].status = 'discarded'; return ok(full(db.batches[id])); },
    archiveDocBatch: (id, r) => { rec('archiveDocBatch', r); db.batches[id].status = 'archived'; return ok(full(db.batches[id])); },
    errorMessage: e => e && (e.code + (e.field ? ':' + e.field : '')),
    util: { uuid: () => nid(), sha256Hex: f => Promise.resolve(f.__sha) }
  };
  return { api, calls, db };
}
function pageContext(api, shellExtra) {
  const { document } = makeDom();
  const mk = (tag, id, parent) => { const n = document.createElement(tag); n.id = id; (parent || document.body).appendChild(n); return n; };
  const sec = mk('section', 'docb-section'); sec.hidden = true;
  mk('h2', 'docb-title', sec); mk('p', 'docb-live', sec); mk('div', 'docb-root', sec); mk('div', 'docb-pending', sec);
  const toasts = [], confirms = [], prompts = [];
  const winListeners = {};
  const location = { hash: '', pathname: '/ocr.html', search: '' };
  const w = {
    MarsaI18n: I18N, MarsaApi: api,
    MarsaShell: Object.assign({ ready: Promise.resolve({}), orgId: () => ORG, can: () => true, R: { opsWriter: ['clearance_staff'] },
      toast: (m, t) => toasts.push([t, m]), confirm: o => { confirms.push(o); return Promise.resolve(true); } }, shellExtra || {}),
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    prompt: (q) => { prompts.push(q); return 'سبب الاختبار'; }, confirm: () => true,
    location
  };
  class FileReader { readAsDataURL() { setTimeout(() => { this.result = 'data:application/pdf;base64,QUJD'; this.onload && this.onload(); }, 0); } }
  const c = { window: w, document, location, history: { replaceState: (a, b, u) => { location.hash = u.slice(u.indexOf('#')) || ''; } }, FileReader, console,
    Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
  vm.createContext(c);
  vm.runInContext(SRC, c, { filename: 'doc-batch.js (page)' });
  const fire = t => (winListeners[t] || []).forEach(f => f({ type: t }));
  return { document, w, sec, toasts, confirms, prompts, fire, location };
}
const fileOf = (name, sha) => ({ name, size: 2048, type: 'application/pdf', __sha: sha });
const btnByText = (root, re) => root.querySelectorAll('button').filter(b => re.test(b.textContent))[0] || null;
async function domFlow() {
  section('DOM flow: batch → parallel reading → wrong slot → merge → edit → client → approve');
  const M = mockApi(), A = M.api;
  // aiExtract does not see the File; the mock decides by slot: B/L ok, packing → detected invoice (wrong slot), 2nd invoice → reused
  const P1 = pageContext(A);
  await settle();
  const D = P1.document, root = D.getElementById('docb-root'), pend = D.getElementById('docb-pending');
  check('staff + online: the section shows; the pending list asks for drafts', () =>
    (P1.sec.hidden === false && M.calls.some(c => c.n === 'listPendingDocBatches' && c.a.status === 'draft') && /لا توجد حزم/.test(pend.textContent)) || J({ hidden: P1.sec.hidden, t: pend.textContent }));
  D.getElementById('docb-new-btn').click();
  await settle();
  check('new batch: createDocBatch (idempotency key) → 4 slots', () =>
    (M.calls.some(c => c.n === 'createDocBatch' && c.a.idempotencyKey) && root.querySelectorAll('[data-slot]').length === 4 && /^#batch=/.test(P1.location.hash)) || J(M.calls.map(c => c.n)));
  const input = slot => root.querySelector('[data-slot="' + slot + '"] input');
  const add = (slot, files) => { const i = input(slot); i.files = files; i.dispatch('change'); };
  add('bill_of_lading', [fileOf('bl.pdf', '1'.repeat(64))]);
  add('packing_list', [fileOf('pl-really-invoice.pdf', '2'.repeat(64))]);
  add('commercial_invoice', [fileOf('inv.pdf', '3'.repeat(64)), fileOf('inv-old.pdf', 'f'.repeat(64))]);
  check('B/L slot takes one file (no more input once queued)', () => !input('bill_of_lading') || 'bl input still there');
  await settle(5);
  // the second invoice is answered as a reused reading by the server
  let n = 0; const orig = A.aiExtract; A.aiExtract = o => { if (o.docType === 'commercial_invoice' && ++n === 2) A.__nextReused = true; return orig(o); };
  btnByText(root, /اقرأ الملفات المضافة \(4\)/).click();
  await settle(60);
  const ai = M.calls.filter(c => c.n === 'aiExtract');
  check('4 parallel readings, all ai-doc-v3', () => (ai.length === 4 && ai.every(c => c.a.promptVersion === 'ai-doc-v3')) || J(ai));
  const saves = M.calls.filter(c => c.n === 'saveExtraction');
  check('saved only the fresh, matching readings (B/L + 1 invoice), with ai_detail; the reused and the wrong-slot ones are not saved', () =>
    (saves.length === 2 && saves.every(s => s.a.ai_detail && s.a.engine === 'claude-opus-5-5' && s.a.org_id === ORG) && J(saves.map(s => s.a.doc_type).sort()) === J(['bill_of_lading', 'commercial_invoice'])) || J(saves));
  const att = M.calls.filter(c => c.n === 'attachDocBatchDocument');
  check('3 attached; the reused one by its extraction_id', () => (att.length === 3 && att.some(c => c.a.eid === Object.keys(M.db.ext)[0])) || J(att));
  const wrong = root.querySelector('.is-wrong');
  check('wrong slot: held back with the detected kind and a move button', () =>
    (wrong && /الخانة الخطأ/.test(wrong.textContent) && /فاتورة تجارية/.test(wrong.textContent) && !!btnByText(wrong, /نقله إلى خانة «الفواتير التجارية»/)) || (wrong ? wrong.textContent : 'none'));
  check('reused reading says it cost nothing', () => /لم تُحتسب أي تكلفة/.test(root.textContent) || 'no reuse note');
  check('merged + saved: draft form with source badge and confidence', () => {
    const inp = root.querySelector('[data-path="shipment.bl_number"]');
    const g = root.querySelector('[data-field="shipment.bl_number"]');
    return (M.calls.some(c => c.n === 'mergeDocBatch') && M.calls.some(c => c.n === 'saveDocBatchDraft') && inp && inp.value === 'MEDU1234567'
      && /بوليصة الشحن · 93%/.test(g.textContent)) || (g ? g.textContent : 'no form');
  });
  check('low-confidence source flagged; conflict + missing fields highlighted', () => {
    const gw = root.querySelector('[data-field="shipment.gross_weight"]'), idt = root.querySelector('[data-field="invoice.invoice_date"]');
    return (gw.classList.contains('is-conflict') && gw.querySelector('.is-low') && idt.classList.contains('is-missing')) || [gw.className, idt.className].join(' | ');
  });
  check('merge conflict between two invoices offers both values', () => /قيم مختلفة بين مستندات من النوع نفسه/.test(root.textContent) && btnByText(root, /INV-OLD/) && btnByText(root, /INV-9/) ? true : 'no chooser');
  check('comparison table inside its own scroll box', () => !!root.querySelector('.docb-table-wrap table') || 'no table');
  // move the wrong-slot reading: saved as an invoice, attached to the invoice slot (no new AI call)
  const aiBefore = M.calls.filter(c => c.n === 'aiExtract').length;
  btnByText(wrong, /نقله إلى خانة/).click();
  await settle(40);
  const mv = M.calls.filter(c => c.n === 'saveExtraction').slice(-1)[0], mva = M.calls.filter(c => c.n === 'attachDocBatchDocument').slice(-1)[0];
  check('move: saved with doc_type commercial_invoice, attached there, no new reading', () =>
    (mv.a.doc_type === 'commercial_invoice' && mva.a.slot === 'commercial_invoice' && M.calls.filter(c => c.n === 'aiExtract').length === aiBefore) || J([mv, mva]));
  // inline correction + save with the version read
  let inp = root.querySelector('[data-path="shipment.net_weight"]');
  inp.value = '1,500'; inp.dispatch('input');
  const vBefore = M.db.batches[Object.keys(M.db.batches)[0]].version;
  btnByText(root, /^حفظ المسودة$/).click();
  await settle(20);
  const sv = M.calls.filter(c => c.n === 'saveDocBatchDraft').slice(-1)[0];
  check('save: the typed "1,500" goes as the number 1500 with the version read', () => (sv.a.draft.shipment.net_weight === 1500 && sv.a.version === vBefore) || J(sv.a));
  // invalid container → not sent, field marked
  btnByText(root, /^إضافة صف$/).click();
  const cin = root.querySelector('[data-path="shipment.containers.0.container_number"]');
  cin.value = 'BAD1'; cin.dispatch('input');
  const nSaves = M.calls.filter(c => c.n === 'saveDocBatchDraft').length;
  btnByText(root, /^حفظ المسودة$/).click();
  await settle(10);
  check('an invalid container number is marked and not sent', () =>
    (M.calls.filter(c => c.n === 'saveDocBatchDraft').length === nSaves && root.querySelector('[data-path="shipment.containers.0.container_number"]').classList.contains('is-invalid')
      && /صحّح الحقول المعلَّمة/.test(root.textContent)) || 'sent or not marked');
  inp = root.querySelector('[data-path="shipment.containers.0.container_number"]');
  inp.value = 'msku 1234567'; inp.dispatch('input');
  btnByText(root, /^حفظ المسودة$/).click();
  await settle(20);
  const sv2 = M.calls.filter(c => c.n === 'saveDocBatchDraft').slice(-1)[0];
  check('fixed container is normalised (MSKU1234567)', () => J(sv2.a.draft.shipment.containers) === J([{ container_number: 'MSKU1234567' }]) || J(sv2.a.draft.shipment));
  // client matching on the consignee name
  check('the consignee identity name is prefilled for matching', () => D.getElementById('docb-match-name').value === 'ACME TRADING CO' || D.getElementById('docb-match-name').value);
  btnByText(root, /ابحث عن العميل المطابق/).click();
  await settle(20);
  const mc = M.calls.filter(c => c.n === 'matchClientV2').slice(-1)[0];
  check('matchClientV2 on the consignee name; the 96% suggestion is preselected (a choice, not an approval)', () => {
    const r = root.querySelector('[data-slot]') && root.querySelectorAll('input').filter(x => x.type === 'radio' && x.value === C1)[0];
    return (mc.a.name === 'ACME TRADING CO' && r && r.checked && /مطابقة قوية مقترحة/.test(root.textContent)) || J(mc);
  });
  check('shipping agent suggested from the shipping line', () => (M.calls.some(c => c.n === 'matchShippingAgent' && c.a === 'MSC') && D.getElementById('docb-agent').value === AG) || D.getElementById('docb-agent').value);
  // target: a new transaction for the chosen client; confirm the alias
  root.querySelectorAll('input').filter(x => x.type === 'radio' && x.value === 'new')[0].click();
  await settle(5);
  const cc = D.getElementById('docb-confirm-client'); cc.checked = true; cc.dispatch('change');
  await settle(5);
  D.getElementById('docb-approve-btn').click();
  await settle(40);
  const ap = M.calls.filter(c => c.n === 'approveDocBatch');
  check('approve: confirm dialog first, then approveDocBatch with version + new transaction + agent + confirmClient + idemKey', () => {
    const o = ap[0] && ap[0].a, b = M.db.batches[Object.keys(M.db.batches)[0]];
    return (P1.confirms.length === 1 && ap.length === 1 && J(o.newTransaction) === J({ clientId: C1, operation: 'import', mode: 'sea' }) && o.shippingAgentId === AG
      && o.confirmClient === true && !!o.idemKey && typeof o.version === 'number' && b.status === 'approved') || J({ ap, confirms: P1.confirms.length });
  });
  check('approved: result panel (transaction link, approved alias) and a read-only draft', () => {
    const link = root.querySelectorAll('a').filter(a => a.href === 'admin.html#tx/' + TX)[0];
    const inputs = root.querySelectorAll('[data-path]');
    return (link && /حُفظ اسم المستلم اسمًا بديلًا معتمدًا/.test(root.textContent) && inputs.length && inputs.every(i => i.disabled) && !D.getElementById('docb-approve-btn')) || 'not frozen';
  });

  section('DOM flow: duplicate guard, stale draft, pending list, #tx deep link, readers');
  const M2 = mockApi({ dupTx: true }), P2 = pageContext(M2.api);
  await settle();
  P2.document.getElementById('docb-new-btn').click(); await settle();
  const r2 = P2.document.getElementById('docb-root');
  const i2 = r2.querySelector('[data-slot="bill_of_lading"] input'); i2.files = [fileOf('bl.pdf', '4'.repeat(64))]; i2.dispatch('change');
  await settle(5);
  btnByText(r2, /اقرأ الملفات المضافة/).click(); await settle(60);
  r2.querySelectorAll('input').filter(x => x.type === 'radio' && x.value === 'existing')[0].click(); await settle(5);
  btnByText(r2.querySelector('#docb-target'), /^بحث$/).click(); await settle(10);
  const sel = P2.document.getElementById('docb-tx'); sel.value = TX; sel.dispatch('change');
  P2.document.getElementById('docb-approve-btn').click(); await settle(40);
  const ap2 = M2.calls.filter(c => c.n === 'approveDocBatch')[0];
  check('existing transaction: approveDocBatch({transactionId}) (listTransactions excludes cancelled)', () =>
    (ap2 && ap2.a.transactionId === TX && !ap2.a.newTransaction && M2.calls.some(c => c.n === 'listTransactions' && c.a.cancelled === 'exclude')) || J(ap2));
  check('MRS_DUPLICATE_TX: clear explanation, nothing written, draft still editable', () => {
    const msg = P2.document.getElementById('docb-approve-msg');
    return (msg && /فحص التكرار أوقف الاعتماد/.test(msg.textContent) && M2.db.batches[Object.keys(M2.db.batches)[0]].status === 'draft'
      && r2.querySelectorAll('[data-path]').some(x => !x.disabled)) || (msg ? msg.textContent : 'no msg');
  });
  // discard from the head (reason prompt)
  btnByText(r2, /^تجاهل$/).click(); await settle(20);
  check('discard asks a reason and calls discardDocBatch', () => (P2.prompts.length === 1 && M2.calls.some(c => c.n === 'discardDocBatch' && c.a === 'سبب الاختبار')) || J(P2.prompts));
  // stale draft
  const M3 = mockApi({ stale: true }), P3 = pageContext(M3.api);
  await settle();
  P3.document.getElementById('docb-new-btn').click(); await settle();
  const r3 = P3.document.getElementById('docb-root');
  const i3 = r3.querySelector('[data-slot="bill_of_lading"] input'); i3.files = [fileOf('bl.pdf', '5'.repeat(64))]; i3.dispatch('change');
  await settle(5);
  btnByText(r3, /اقرأ الملفات المضافة/).click(); await settle(60);
  check('MRS_DOC_BATCH_STALE on save: reload banner, approve disabled', () =>
    (/عدّل شخص آخر هذه المسودة/.test(r3.textContent) && btnByText(r3, /^إعادة التحميل$/) && P3.document.getElementById('docb-approve-btn').disabled) || 'no stale banner');
  // the transaction link: #tx=<id> with no open draft → offer a batch for it
  P3.location.hash = '#tx=' + TX; P3.fire('hashchange'); await settle(20);
  check('#tx=<id>: looks for the transaction’s draft; none → "new batch for transaction"', () =>
    (M3.calls.some(c => c.n === 'listPendingDocBatches' && c.a.transactionId === TX) && /حزمة جديدة للمعاملة TX-1/.test(r3.textContent)) || r3.textContent.slice(0, 200));
  P3.document.getElementById('docb-new-btn').click(); await settle();
  check('…and the new batch is created for that transaction', () => M3.calls.filter(c => c.n === 'createDocBatch').slice(-1)[0].a.transactionId === TX || 'no tx');
  // a reader (not an ops writer): no create / approve controls
  const M4 = mockApi(), P4 = pageContext(M4.api, { can: () => false });
  await settle();
  check('a non-writer sees no "new batch" button and a read-only note', () =>
    (!P4.document.getElementById('docb-new-btn') && /يمكنك عرض الحزم فقط/.test(P4.document.getElementById('docb-root').textContent)) || 'controls shown');
  // signed out / not staff → hidden
  const M5 = mockApi(); M5.api.isStaff = () => Promise.resolve({ data: false, error: null });
  const P5 = pageContext(M5.api); await settle();
  check('not staff → the section stays hidden and nothing is listed', () => (P5.sec.hidden === true && !M5.calls.some(c => c.n === 'listPendingDocBatches')) || 'shown');
}
async function txDocsRender() {
  section('DOM: transaction page section (tx-docs.js)');
  const { document } = makeDom();
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v); else n.setAttribute(k, v); });
    [].concat(kids == null ? [] : kids).forEach(c => { if (c == null) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
  const sd = { transaction_id: TX, bl_number: 'MEDU1234567', vessel: 'MSC ANNA', invoice_number: 'INV-9', packing_total_packages: 40, approved_at: '2026-11-11T09:00:00Z',
    containers: [{ container_number: 'MSKU1234567', seal_number: 'SL1' }], conflicts: [{}], missing_fields: [] };
  const api = { el, can: () => true, cancelled: false, fmtDate: v => String(v), fmtNumber: v => String(v), errText: e => e.code,
    MarsaApi: { getTransactionShipment: () => Promise.resolve({ data: { transaction_id: TX, shipment_data: sd, invoice_items: [{ line_no: 1, description: 'Dates', supplier_hs_code: '0804' }],
      packing_items: [], batches: [{ id: U1, status: 'approved', created_by_name: 'Staff' }] }, error: null }) } };
  const host = document.createElement('div'); document.body.appendChild(host);
  const s = win.MarsaOps.txSections.filter(x => x.id === 'shipment_docs')[0];
  await s.render(host, { id: TX, branch_id: BR }, api);
  const link = host.querySelectorAll('a').filter(a => a.href === 'ocr.html#tx=' + TX)[0];
  check('the read link, the «بيانات فسح» header, containers, items, batches', () =>
    (link && /قراءة مستندات الشحنة/.test(link.textContent) && /MSC ANNA/.test(host.textContent) && /MSKU1234567/.test(host.textContent) && /Dates/.test(host.textContent)
      && host.querySelectorAll('a').some(a => a.href === 'ocr.html#batch=' + U1) && host.querySelectorAll('.table-wrap').length === 3) || host.textContent.slice(0, 300));
  const host2 = document.createElement('div');
  await s.render(host2, { id: TX, branch_id: BR }, Object.assign({}, api, { cancelled: true }));
  check('a cancelled transaction has no read link', () => !host2.querySelectorAll('a').some(a => a.href === 'ocr.html#tx=' + TX) || 'link shown');
  const host3 = document.createElement('div');
  await s.render(host3, { id: TX }, Object.assign({}, api, { MarsaApi: { getTransactionShipment: () => Promise.resolve({ data: { shipment_data: null, invoice_items: [], packing_items: [], batches: [] }, error: null }) } }));
  check('nothing approved yet → a plain note', () => /لم تُعتمد بيانات شحنة/.test(host3.textContent) || host3.textContent);
}

/* ================================================================ async: pool */
(async function () {
  section('pool (parallel reading, 3 at a time)');
  let live = 0, peak = 0;
  const out = await P.pool([1, 2, 3, 4, 5, 6, 7], 3, x => new Promise(r => { live++; peak = Math.max(peak, live); setTimeout(() => { live--; r(x * 2); }, 5); }));
  eq('all done in order, at most 3 at once', [out, peak], [[2, 4, 6, 8, 10, 12, 14], 3]);
  const out2 = await P.pool([1, 2], 3, x => { if (x === 1) throw new Error('boom'); return x; });
  check('a failing item does not stop the others', () => (out2[0] instanceof Error && out2[1] === 2) || J(out2));
  eq('empty list', await P.pool([], 3, x => x), []);

  await domFlow();
  await txDocsRender();

  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();

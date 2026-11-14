#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 4 UI tests: assets/js/decl-review.js (MarsaDeclReview, ocr.html declaration reading + review +
  approval), assets/js/hs-picker.js (MarsaHsPicker), assets/js/ops/tx-decl.js (MarsaOps.txDecl, the #tx/<id> section),
  assets/js/ops/fasah-sheet.js (MarsaFasahSheet, the Fasah entry information sheet), assets/i18n/decl.js and the page wiring
  (ocr.html / admin.html / sw.js / decl.css / doc-batch.js / tx-docs.js / rpt + portal labels). Pure Node, no database, no
  network, no dependencies (vm + window shim + supabase/tests/lib/fake-dom.js).

  Covers: classic-script wrapper + ES5 source + no innerHTML; the 'decl' dictionary (ar = en keys; every literal key and every
  dynamic key family exists); the contract with 20261120000100 (status order, decl_conflict codes, container_source codes,
  approve payload / item / container keys = the server's only_keys, supa.js option names); Hijri → Gregorian (known Umm
  al-Qura dates, Arabic digits, d/m/yyyy, a missing day 30, no calendar → unsupported); the B/L view (token equivalence
  through doc-match.js, printed value kept as read); the container merge preview; localMissing / validateForm /
  buildPayload (the Hijri-recomputed date wins, Ro-Ro sends no containers, normalisation) / approveKey / resultSummary /
  readingKindOk / extractionRow ⊆ supa.js EXT_INSERT / fileProblem / errKey; the Fasah sheet model (Fasah entry order,
  numeric tolerance max(0.01, 0.01 %), currency names, common values, alerts, file name, Excel spec through rpt/xlsx.js);
  HS picker helpers; DOM flows: the review page (load, Hijri edit recomputes, B/L mismatch needs the explicit confirmation,
  approve with version + idempotency key behind the confirm dialog, result summary, stale / duplicate errors visible), the
  upload page (reused reading → no save; fresh reading → saved with ai_detail; wrong kind → not saved), the HS picker
  (search call + pick), the transaction section and the Fasah sheet (export logged first, nothing built when the log fails).

  usage:  node supabase/tests/legacy-decl-ui-tests.js [/path/to/marsa-website] [--quiet]
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
let LANG = 'ar';
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts[LANG][key] != null ? dicts[LANG][key] : (dicts.ar[key] != null ? dicts.ar[key] : key);
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  has(key) { return dicts.ar[key] != null; },
  lang() { return LANG; }
};
const NORM = require(path.join(ROOT, 'assets/js/legacy-norm.js'));
const DM = require(path.join(ROOT, 'assets/js/doc-match.js'));
const XLSX = require(path.join(ROOT, 'assets/js/rpt/xlsx.js'));
const win = { MarsaI18n: I18N, MarsaNorm: NORM, MarsaDocMatch: DM };
const ctx = { window: win, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
vm.createContext(ctx);
const SRC = rd('assets/js/decl-review.js'), HSP = rd('assets/js/hs-picker.js'), TXD = rd('assets/js/ops/tx-decl.js'), FSH = rd('assets/js/ops/fasah-sheet.js');
const DICT = rd('assets/i18n/decl.js');
vm.runInContext(DICT, ctx, { filename: 'decl.js' });
vm.runInContext(rd('assets/i18n/docb.js'), ctx, { filename: 'docb.js' });
vm.runInContext(HSP, ctx, { filename: 'hs-picker.js' });
vm.runInContext(SRC, ctx, { filename: 'decl-review.js' });
vm.runInContext(TXD, ctx, { filename: 'tx-decl.js' });
vm.runInContext(FSH, ctx, { filename: 'fasah-sheet.js' });
const P = win.MarsaDeclReview.pure, H = win.MarsaHsPicker.pure, F = win.MarsaFasahSheet.pure, TD = win.MarsaOps.txDecl.pure;
const MIG = rd('supabase/migrations/20261120000100_legacy_decl.sql');
const SUPA = rd('assets/js/supa.js');

/* ================================================================ static */
section('static: classic scripts, ES5, no innerHTML');
const NEW_JS = { 'assets/js/decl-review.js': SRC, 'assets/js/hs-picker.js': HSP, 'assets/js/ops/tx-decl.js': TXD, 'assets/js/ops/fasah-sheet.js': FSH, 'assets/i18n/decl.js': DICT };
Object.keys(NEW_JS).forEach(f => {
  const s = NEW_JS[f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  check(f + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML', () =>
    (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)) || 'not ES5 / uses HTML');
});
check('node --check-equivalent: every new file compiles', () => { Object.keys(NEW_JS).forEach(f => new vm.Script(NEW_JS[f], { filename: f })); return true; });

/* ================================================================ dictionary */
section('dictionary (namespace decl)');
const AR = Object.keys(dicts.ar).filter(k => k.startsWith('decl.')), EN = Object.keys(dicts.en).filter(k => k.startsWith('decl.'));
check('ar and en have the same keys', () => (AR.length > 300 && AR.length === EN.length && AR.every(k => dicts.en[k] != null)) || [AR.length, EN.length, AR.filter(k => dicts.en[k] == null)]);
check('no empty strings', () => AR.concat(EN).every(k => String(dicts.ar[k] || dicts.en[k]).trim()) || 'empty');
const has = k => dicts.ar['decl.' + k] != null && dicts.en['decl.' + k] != null;
check('every literal T(\'key\') / t(\'key\') of the 4 files exists', () => {
  const miss = [];
  [SRC, HSP, TXD, FSH].forEach(s => { const re = /\b[Tt]\('([a-z][a-z0-9_]*)'(?=[,)])/g; let m; while ((m = re.exec(s))) if (!has(m[1])) miss.push(m[1]); });
  return !miss.length || miss;
});
const fam = (pre, list) => list.filter(c => !has(pre + c)).map(c => pre + c);
check('dynamic families: statuses, types, conflicts, missing, tx fields, warnings, results, merge states, item columns', () => {
  const miss = [].concat(fam('st_', P.STATUSES.concat(['cancelled', 'replaced'])), fam('type_', P.TYPES), fam('conf_', P.CONFLICTS), fam('miss_', P.MISSING),
    fam('tf_', P.TX_FIELDS), fam('w_', P.WARNINGS), fam('ra_', ['added', 'corrected', 'unchanged']), fam('rs_', ['initial', 'forward', 'same', 'kept_backward']),
    fam('rb_', ['match', 'mismatch_confirmed', 'no_transaction_bl', 'not_read']), fam('bl_', ['match', 'mismatch', 'no_transaction_bl', 'not_read', 'mismatch_confirmed']),
    fam('m_', ['new', 'on_tx', 'invalid', 'dup', 'empty']), fam('i_', P.ITEM_COLS), fam('act_', ['add', 'correct', 'conflict']), fam('dir_', ['forward', 'same', 'backward']),
    fam('kind_', ['bill_of_lading', 'commercial_invoice', 'packing_list', 'operator_invoice', 'supplier_invoice', 'certificate_of_origin', 'other']),
    fam('', Object.keys(P.ERR_KEYS).map(k => P.ERR_KEYS[k])), fam('', ['bad_no', 'bad_hijri', 'hijri_nonexistent', 'bad_date', 'containers_roro', 'too_many', 'bad_container', 'bad_number', 'bad_hs']),
    fam('rb_', ['match']), fam('daftra_', ['deferred']));
  return !miss.length || miss;
});
check('Fasah sheet families: sections, tables, columns, common rows, results, alerts, sources', () => {
  const m = F.buildModel({ tx: { id: 'x', ref: 'R' }, shipment: {}, decl: {}, containers: [] });
  const cols = []; m.sections.forEach(s => s.tables.forEach(t => t.cols.forEach(c => cols.push(c.key))));
  const miss = [].concat(fam('fsec_', m.sections.map(s => s.id)), fam('fsub_', m.sections.map(s => s.id)), fam('ftab_', ['containers', 'invoice_items', 'packing_items', 'declaration_items']),
    fam('fc_', cols.concat(TD.ITEM_COLS)), fam('cm_', m.common.map(r => r.key)), fam('cs_', ['ok', 'diff', 'single', 'missing', 'review']), fam('ak_', ['conflict', 'missing']),
    fam('col_', ['section', 'field', 'value', 'bl', 'invoice', 'packing', 'declaration', 'result', 'kind', 'note']),
    fam('cmp_', ['bl_number', 'container_numbers', 'seal_numbers', 'net_weight', 'gross_weight', 'packages_count', 'consignee_buyer', 'shipper_seller']),
    fam('miss_', ['consignee', 'bl_number', 'container_number', 'goods_description', 'packages_count', 'net_weight', 'gross_weight', 'invoice_number', 'invoice_date', 'currency',
      'total', 'incoterms', 'invoice_items', 'packing_items', 'declaration', 'declaration_items', 'shipment_data']),
    fam('csrc_', ['manual', 'doc_batch', 'declaration', 'import']), fam('dsrc_', ['manual', 'ocr', 'ai', 'import', 'fasah']),
    m.strip.map(p => p[0]).filter(k => !has(k)), [].concat.apply([], m.sections.map(s => s.pairs.map(p => p[0]))).filter(k => !has(k)));
  return !miss.length || miss;
});
check('docb dictionary: the new slot / HS keys in ar and en', () => ['decl_review', 'decl_review_need_tx', 'hs_ref', 'hs_ref_aria'].every(k => dicts.ar['docb.' + k] && dicts.en['docb.' + k]) || 'docb keys');

/* ================================================================ contract with 20261120000100 */
section('contract with the migration and supa.js');
check('status order = v_order of app.decl_compare / approve_declaration_extraction', () => {
  const m = /v_order text\[\] := ARRAY\[([^\]]+)\]/.exec(MIG.replace(/\s+/g, ' '));
  const codes = m ? m[1].split(',').map(x => x.trim().replace(/'/g, '')) : [];
  return J(codes) === J(P.STATUSES) || J(codes);
});
check('decl_conflict codes = status_labels of the migration', () => {
  const got = []; const re = /\('decl_conflict','([a-z_]+)'/g; let m; while ((m = re.exec(MIG))) got.push(m[1]);
  return J(got) === J(P.CONFLICTS) || J(got);
});
check('container_source codes have labels (csrc_)', () => {
  const got = []; const re = /\('container_source','([a-z_]+)'/g; let m; while ((m = re.exec(MIG))) got.push(m[1]);
  return (got.length === 4 && got.every(c => has('csrc_' + c))) || J(got);
});
check('approve payload option names = supa.js approveDeclarationExtraction MAP (+ confirmBlMismatch, version)', () => {
  const o = P.buildPayload(Object.assign(P.formFromDraft({ declaration_no: 'x', containers: [{ container_number: 'MSKU1234565' }] }), { notes: 'n', confirmBl: true }), 'v', 'container', NORM);
  const MAP = ['declarationNo', 'declarationType', 'declarationDate', 'declarationDateHijri', 'status', 'containers', 'items', 'vessel', 'notes'];
  const keys = Object.keys(o).filter(k => k !== 'version' && k !== 'confirmBlMismatch');
  return (keys.every(k => MAP.indexOf(k) !== -1) && MAP.every(k => SUPA.indexOf(k + ": '") !== -1) && o.confirmBlMismatch === true && /if \(o\.confirmBlMismatch\) p\.confirm_bl_mismatch = true;/.test(SUPA)) || J(keys);
});
check('item / container keys ⊆ the server only_keys', () => {
  const items = /only_keys\(it, ARRAY\[([^\]]+)\]/.exec(MIG.replace(/\s+/g, ' ')), ctr = /only_keys\(c, ARRAY\[([^\]]+)\]/.exec(MIG.replace(/\s+/g, ' '));
  const ik = items[1].split(',').map(x => x.trim().replace(/'/g, '')), ck = ctr[1].split(',').map(x => x.trim().replace(/'/g, ''));
  return (P.ITEM_KEYS.every(k => ik.indexOf(k) !== -1) && P.CTR_KEYS.every(k => ck.indexOf(k) !== -1)) || J([ik, ck]);
});
check('extractionRow keys ⊆ supa.js EXT_INSERT (with ai_detail, transaction, org)', () => {
  const m = /var EXT_INSERT = \[([\s\S]*?)\];/.exec(SUPA);
  const ins = m[1].replace(/\/\/.*$/gm, '').split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
  const row = P.extractionRow({ res: { usage_id: 'u', ai_detail: { prompt_version: 'ai-doc-v3' }, fields: [{ page: 2 }], extracted_fields: { declaration_number: '1' }, line_items: [] },
    file: { name: 'd.pdf', size: 10 }, sha256: 'a'.repeat(64), mime: 'application/pdf', orgId: 'o', transactionId: 't' });
  return (Object.keys(row).every(k => ins.indexOf(k) !== -1) && row.doc_type === 'customs_declaration' && row.ai_detail && row.transaction_id === 't' && row.source_pages === 2) || J([Object.keys(row).filter(k => ins.indexOf(k) === -1), ins]);
});
check('fasah_sheet export report: supa.js EXPORT_REPORTS + rpt_export_keys(transaction_id)', () =>
  (/EXPORT_REPORTS = \[[^\]]*'fasah_sheet'/.test(SUPA) && /'fasah_sheet'/.test(MIG) && /transaction_id/.test(MIG)) || 'export');

/* ================================================================ pure: decl-review */
section('Hijri → Gregorian (Umm al-Qura) and the review form');
eq('parseHash', [P.parseHash('#decl-tx=0000000D-0000-4000-8000-00000000000d'), P.parseHash('#decl=0000000a-0000-4000-8000-00000000000a&tx=0000000d-0000-4000-8000-00000000000d'),
  P.parseHash('#decl=x&tx=y'), P.parseHash('#batch=0000000a-0000-4000-8000-00000000000a')],
  [{ tx: '0000000d-0000-4000-8000-00000000000d' }, { extraction: '0000000a-0000-4000-8000-00000000000a', tx: '0000000d-0000-4000-8000-00000000000d' }, {}, {}]);
eq('links', [P.uploadLink('T'), P.reviewLink('E', 'T'), P.txLink('T'), P.batchLink('B')], ['ocr.html#decl-tx=T', 'ocr.html#decl=E&tx=T', 'admin.html#tx/T', 'ocr.html#batch=B']);
eq('known Umm al-Qura dates (1 Muharram 1447, 1 Ramadan 1446, Arabic digits 1 Shawwal 1446, d/m/yyyy)', [
  P.hijriState('1447/01/01', NORM), P.hijriState('1446/09/01 هـ', NORM).greg, P.hijriState('١٤٤٦/١٠/١', NORM).greg, P.hijriState('15/3/1447', NORM)],
  [{ state: 'ok', hijri: '1447/01/01', greg: '2025-06-26' }, '2025-03-01', '2025-03-30', { state: 'ok', hijri: '1447/03/15', greg: '2025-09-07' }]);
eq('a day 30 the month does not have / out of range / empty / no calendar', [P.hijriState('1446/01/30', NORM).state, P.hijriState('1250/01/01', NORM).state, P.hijriState('', NORM).state,
  P.hijriState('1447/01/01', Object.assign({}, NORM, { hijriSupported: () => false })).state], ['nonexistent', 'invalid', 'empty', 'unsupported']);
const DRAFT = { declaration_no: '3202612345', declaration_type: 'import', type_evidence: 'بيان استيراد', status: 'accepted', status_raw: 'قبول البيان',
  declaration_date: '2025-06-26', declaration_date_hijri: '1447/01/01', bl_number: '123456 MEDU', bl_candidates: ['123456 MEDU', 'MEDU123456'], bl_rtl_affected: true,
  vessel: 'MSC ANNA', containers: [{ container_number: 'MSKU1234565', seal_number: 'S1' }, { container_number: 'TGHU7654321', gross_weight: 1200 }],
  items: [{ hs_code: '080410', description: 'تمور', quantity: 100, unit: 'KG', value: 5000 }] };
const CMP = { bl: { status: 'match', transaction_bls: ['MEDU123456'], candidates: ['123456 MEDU', 'MEDU123456'], matched_with: '123456 MEDU', rtl_affected: true },
  containers: { matched: ['MSKU1234565'], new: ['TGHU7654321'], not_on_declaration: ['CAIU1111117'] }, declaration: { action: 'add', existing: null },
  status: { read: 'accepted', current: null, direction: 'initial' }, missing: [], conflicts: [], can_approve: true };
const FORM = P.formFromDraft(DRAFT);
check('formFromDraft: values as read, strings for the inputs, unknown codes dropped', () =>
  (FORM.declaration_no === '3202612345' && FORM.declaration_type === 'import' && FORM.status === 'accepted' && FORM.containers.length === 2 && FORM.containers[1].gross_weight === '1200'
    && FORM.items[0].quantity === '100' && FORM.confirmBl === false && P.formFromDraft({ declaration_type: 'x', status: 'y' }).declaration_type === '') || J(FORM));
check('blView: the printed value kept as read, candidates marked by token equivalence (any order)', () => {
  const v = P.blView(DRAFT, CMP, DM);
  return (v.raw === '123456 MEDU' && v.candidates[0].printed && v.candidates[0].matches === 'MEDU123456' && v.rtl && v.status === 'match' && DM.blEquivalent('MEDU 123456', '123456-medu')
    && !DM.blEquivalent('MEDU123456', 'MEDU123457')) || J(v);
});
check('blView: a mismatch is reported (status from the server, else computed)', () => {
  const v = P.blView({ bl_number: 'OOLU999' }, { bl: { transaction_bls: ['MEDU123456'] } }, DM);
  return (v.status === 'mismatch' && !v.candidates[0].matches && P.blView({}, { bl: { transaction_bls: [] } }, DM).status === 'not_read') || J(v);
});
check('containerPreview: new / on the transaction / invalid / duplicate / transaction only', () => {
  const p = P.containerPreview([{ container_number: 'mscu 1234565'.replace('mscu', 'MSKU') }, { container_number: 'TGHU7654321' }, { container_number: 'BAD1' }, { container_number: 'TGHU-7654321' }, {}], CMP);
  return (J(p.rows.map(r => r.state)) === J(['on_tx', 'new', 'invalid', 'dup', 'empty']) && p.added === 1 && p.onTx === 1 && J(p.txOnly) === J(['CAIU1111117'])) || J(p);
});
eq('localMissing (server order) and Ro-Ro', [P.localMissing(FORM, 'container'), P.localMissing({}, 'container'), P.localMissing({ containers: [] }, 'roro')],
  [[], ['declaration_no', 'declaration_type', 'declaration_date', 'status', 'containers'], ['declaration_no', 'declaration_type', 'declaration_date', 'status']]);
check('validateForm: number, Hijri, containers, HS codes, numbers, Ro-Ro', () => {
  const f = P.formFromDraft(DRAFT);
  f.declaration_no = 'AB 12$'; f.declaration_date_hijri = '1446/01/30'; f.containers.push({ container_number: 'XX12', gross_weight: '-1' });
  f.items.push({ hs_code: '08.04.10', quantity: 'abc' }); f.items.push({ hs_code: '1' });
  const b = P.validateForm(f, 'container', NORM).map(x => x.code + (x.row != null ? '@' + x.table + x.row : ''));
  const r = P.validateForm(P.formFromDraft(DRAFT), 'roro', NORM).map(x => x.code);
  return (J(b) === J(['bad_no', 'hijri_nonexistent', 'bad_container@containers2', 'bad_number@containers2', 'bad_number@items1', 'bad_hs@items2']) && J(r) === J(['containers_roro'])
    && P.validateForm(P.formFromDraft(DRAFT), 'container', NORM).length === 0) || J([b, r]);
});
check('buildPayload: normalised values; the Gregorian date recomputed from the Hijri wins', () => {
  const f = P.formFromDraft(DRAFT);
  f.declaration_no = ' ٣٢٠٢٦ab '; f.declaration_date = '2020-01-01'; f.declaration_date_hijri = '1/10/1446'; f.vessel = ' MSC ANNA ';
  f.containers = [{ container_number: 'msku 1234565', seal_number: ' S1 ', size_type: '40hc', gross_weight: '1,200.5' }, { container_number: 'MSKU1234565' }, { container_number: '' }];
  f.items = [{ hs_code: '0804.10', description: ' تمور ', quantity: '١٠٠', value: '' }, { hs_code: '', description: '' }];
  const o = P.buildPayload(f, 'VER', 'container', NORM);
  return (o.version === 'VER' && o.declarationNo === '32026AB' && o.declarationDate === '2025-03-30' && o.declarationDateHijri === '1446/10/01' && o.vessel === 'MSC ANNA'
    && J(o.containers) === J([{ container_number: 'MSKU1234565', seal_number: 'S1', size_type: '40HC', gross_weight: 1200.5 }])
    && J(o.items) === J([{ hs_code: '080410', description: 'تمور', quantity: 100 }]) && !('confirmBlMismatch' in o) && !('notes' in o)) || J(o);
});
check('buildPayload: no calendar → the typed Gregorian date; Ro-Ro → no containers; empty Hijri → null', () => {
  const f = P.formFromDraft(DRAFT);
  const o = P.buildPayload(f, 'V', 'roro', Object.assign({}, NORM, { hijriSupported: () => false }));
  f.declaration_date_hijri = '';
  const o2 = P.buildPayload(f, 'V', 'container', NORM);
  return (o.declarationDate === '2025-06-26' && o.declarationDateHijri === '1447/01/01' && J(o.containers) === '[]' && o2.declarationDateHijri === null && o2.declarationDate === '2025-06-26') || J([o, o2]);
});
check('approveKey: same request → same key; an edit → a new key', () => {
  let n = 0; const gen = () => 'k' + (++n);
  const a = P.approveKey(null, 'v1', { status: 'accepted' }, gen), b = P.approveKey(a, 'v1', { status: 'accepted', idemKey: 'k1' }, gen), c = P.approveKey(b, 'v1', { status: 'released' }, gen), d = P.approveKey(c, 'v2', { status: 'released' }, gen);
  return (a.key === 'k1' && b === a && c.key === 'k2' && d.key === 'k3') || J([a, b, c, d]);
});
check('resultSummary', () => {
  const r = P.resultSummary({ ref: 'TX-1', declaration: { declaration_no: '32026' }, declaration_action: 'added', status_action: 'initial', bl: { status: 'match', matched_with: 'M1' },
    containers: { added: ['A'], updated: ['B'], unchanged: [] }, items: 2, hs_reference: { saved: 2, ids: ['x', 'y'] }, tx_filled: ['vessel'], tx_kept: ['country'], warnings: ['vessel_no_bl'],
    daftra_hook: 'deferred', replayed: true, batch_id: 'B' });
  return (r.declarationNo === '32026' && r.added[0] === 'A' && r.items === 2 && r.hsSaved === 2 && r.filled[0] === 'vessel' && r.replayed && r.batchId === 'B' && r.daftra === 'deferred') || J(r);
});
eq('readingKindOk', [P.readingKindOk({ detected_type: 'customs_declaration' }).ok, P.readingKindOk({}).ok, P.readingKindOk({ detected_type: 'bill_of_lading' }),
  P.readingKindOk({ detected_type: 'commercial_invoice', ai_detail: { detected_documents: ['commercial_invoice', 'customs_declaration'] } }).ok],
  [true, true, { ok: false, detected: 'bill_of_lading' }, true]);
eq('review fix — readingKindOk: a reading detected as «other» is the wrong file too (legacy assertExpectedDocumentType_; the server refuses it)',
  P.readingKindOk({ detected_type: 'other' }), { ok: false, detected: 'other' });
{
  const EXD = { id: 'd', declaration_no: '999', declaration_type: 'import', declaration_type_code: 'import', status: 'released', declaration_date: '2025-06-20', declaration_date_hijri: '1446/12/24' };
  const CC = Object.assign({}, CMP, { declaration: { action: 'conflict', existing: EXD }, status: { read: 'accepted', current: 'released', direction: 'backward' },
    conflicts: [{ code: 'declaration_other_number', blocking: true, confirmable: false }, { code: 'status_backward', blocking: false, confirmable: false }] });
  const o1 = P.buildPayload(Object.assign({}, FORM, { declaration_no: '999', status: 'released' }), 'v', 'container', NORM);
  const o2 = P.buildPayload(FORM, 'v', 'container', NORM);
  eq('review fix — planOf follows the EDITED number / status / dates: the number corrected to the recorded one → correct (type same; date + Hijri replaced), status same; the number as read → conflict, status backward',
    [P.planOf(o1, CC), P.planOf(o2, CC).action, P.planOf(o2, CC).direction, P.planOf(o2, CMP).action, P.planOf(o2, CMP).direction],
    [{ action: 'correct', direction: 'same', current: 'released', status: 'released', replaced: ['declaration_date', 'declaration_date_hijri'] }, 'conflict', 'backward', 'add', 'initial']);
  eq('review fix — effectiveConflicts: number / status notices recomputed for the edit; declaration_no_taken only for the number read; shipment_on_other_tx only while such a container is listed; hijri_unverified dropped once the Hijri converts',
    [P.effectiveConflicts(o1, CC, DRAFT, NORM).map(c => c.code), P.effectiveConflicts(o2, CC, DRAFT, NORM).map(c => c.code), P.hardBlock(P.effectiveConflicts(o2, CC, DRAFT, NORM)),
      P.effectiveConflicts(o1, Object.assign({}, CMP, { conflicts: [{ code: 'declaration_no_taken', blocking: true }] }), DRAFT, NORM).map(c => c.code),
      P.effectiveConflicts(o2, Object.assign({}, CMP, { conflicts: [{ code: 'declaration_no_taken', blocking: true }] }), DRAFT, NORM).map(c => c.code),
      P.effectiveConflicts(o2, Object.assign({}, CMP, { containers: Object.assign({}, CMP.containers, { on_other_tx: ['TGHU7654321'] }), conflicts: [{ code: 'shipment_on_other_tx', blocking: true }] }), DRAFT, NORM).map(c => c.code),
      P.effectiveConflicts(Object.assign({}, o2, { containers: [o2.containers[0]] }), Object.assign({}, CMP, { containers: Object.assign({}, CMP.containers, { on_other_tx: ['TGHU7654321'] }), conflicts: [{ code: 'shipment_on_other_tx', blocking: true }] }), DRAFT, NORM).map(c => c.code),
      P.effectiveConflicts(o2, Object.assign({}, CMP, { conflicts: [{ code: 'hijri_unverified', blocking: false }] }), DRAFT, NORM).map(c => c.code)],
    [[], ['declaration_other_number', 'status_backward'], true, [], ['declaration_no_taken'], ['shipment_on_other_tx'], [], []]);
  eq('review fix — containerPreview: a container of the declaration on another transaction (comparison.containers.on_other_tx) → other_tx, not counted as added',
    (() => { const pv = P.containerPreview(FORM.containers, Object.assign({}, CMP, { containers: Object.assign({}, CMP.containers, { on_other_tx: ['TGHU7654321'] }) })); return [pv.rows.map(r => r.state), pv.added, pv.onTx, pv.otherTx]; })(),
    [['on_tx', 'other_tx'], 0, 1, 1]);
  eq('browser fix — containerPreview: a container on THIS transaction and also on another live one (on_other_tx) is badged other_tx (it blocks approval)',
    (() => { const pv = P.containerPreview(FORM.containers, Object.assign({}, CMP, { containers: Object.assign({}, CMP.containers, { on_other_tx: ['MSKU1234565'] }) })); return [pv.rows.map(r => r.state), pv.onTx, pv.otherTx]; })(),
    [['other_tx', 'new'], 0, 1]);
  eq('review fix — resultSummary carries declaration_replaced', P.resultSummary({ declaration_replaced: ['declaration_date'] }).replaced, ['declaration_date']);
}
eq('fileProblem / mediaType', [P.fileProblem({ name: 'a.pdf', size: 9 * 1024 * 1024 }), P.fileProblem({ name: 'a.pdf', size: 11 * 1024 * 1024 }), P.fileProblem({ name: 'a.jpg', type: 'image/jpeg', size: 6 * 1024 * 1024 }),
  P.fileProblem({ name: 'a.docx', size: 1 }), P.mediaType({ name: 'X.PNG' })], [null, 'too_large', 'too_large', 'unsupported', 'image/png']);
eq('errKey: known code + detail → own text, else the API message', [P.errKey({ code: 'MRS_INVALID', field: 'declaration_no_taken' }), P.errKey({ code: 'MRS_DECL_STALE' }), P.errKey(null)],
  ['e_no_taken', null, null]);

/* ================================================================ pure: HS picker + tx-decl */
section('HS reference picker helpers and the transaction section');
eq('queryOf: the description first, else the code; digits western; trimmed to 200', [H.queryOf({ description: '  تمور  مجدول ', hs_code: '0804' }), H.queryOf({ hs_code: '٠٨٠٤' }),
  H.queryOf({ supplier_hs_code: '0804' }), H.cleanQuery('x'.repeat(250)).length], ['تمور مجدول', '0804', '0804', 200]);
eq('sortItems: score, then usage, then code', H.sortItems([{ hs_code: '2', score: 50, usage_count: 1 }, { hs_code: '1', score: 50, usage_count: 1 }, { hs_code: '3', score: 120, usage_count: 0 }, { hs_code: '4', score: 50, usage_count: 9 }]).map(x => x.hs_code),
  ['3', '4', '1', '2']);
eq('itemLine', H.itemLine({ invoice_description: 'Dates', scientific_name: 'Phoenix dactylifera', origin_country: '' }), 'Dates · Phoenix dactylifera');
check('tx-decl registers section declaration_reading (order 21, after the declarations)', () => {
  const s = win.MarsaOps.txSections.filter(x => x.id === 'declaration_reading');
  return (s.length === 1 && s[0].order === 21) || J(win.MarsaOps.txSections.map(x => x.id));
});
eq('pendingReadings: declaration readings not approved, not voided, newest first', TD.pendingReadings([
  { id: 'a', doc_type: 'customs_declaration', created_at: '2026-11-01' }, { id: 'b', doc_type: 'customs_declaration', created_at: '2026-11-03' },
  { id: 'c', doc_type: 'commercial_invoice' }, { id: 'd', doc_type: 'customs_declaration', voided_at: 'x' }, { id: 'e', doc_type: 'customs_declaration', created_at: '2026-11-02' }],
  [{ extraction_id: 'a' }]).map(x => x.id), ['b', 'e']);

/* ================================================================ pure: Fasah sheet */
section('Fasah entry sheet model');
eq('numEquivalent: tolerance max(0.01, 0.01 %); text compared normalised; empty → null', [F.numEquivalent(100, '100.005'), F.numEquivalent(100, 100.02), F.numEquivalent('10,000', 10000.9),
  F.numEquivalent(10000, 10001.1), F.numEquivalent('', 1), F.numEquivalent('ACME Co.', 'acme co'), F.numEquivalent('٥', 5)], [true, false, true, false, null, true, true]);
eq('currencyName', [F.currencyName('usd'), F.currencyName('$'), F.currencyName('ريال سعودي'), F.currencyName('EUR', 'en'), F.currencyName('XYZ'), F.currencyName('')],
  ['USD — دولار أمريكي', 'USD — دولار أمريكي', 'SAR — ريال سعودي', 'EUR — Euro', 'XYZ', '']);
eq('fileName كشف-إدخال-فسح-{seq}-{yyyymmdd-hhmm} (Asia/Riyadh)', [F.fileName('JED-2026/0001', '2026-11-11T21:30:00Z', 'xlsx'), F.fileName('', '2026-01-01T00:00:00Z')],
  ['كشف-إدخال-فسح-JED-2026-0001-20261112-0030.xlsx', 'كشف-إدخال-فسح-tx-20260101-0300']);
const SH = { shipment_data: { bl_number: 'MEDU123456', shipper: 'Seller Co', consignee_name: 'ACME', vessel: 'MSC ANNA', voyage: 'V1', packages_count: 40, gross_weight_kg: 1200,
  net_weight_kg: 1000, invoice_number: 'INV-9', currency: 'usd', total_value: 5000, buyer: 'acme', packing_total_packages: 40, packing_gross_weight_kg: 1200.05, packing_net_weight_kg: 990,
  containers: [{ container_number: 'MSKU1234565', seal_number: 'S1' }], conflicts: [{ field: 'net_weight', status: 'conflict', values: { bl: 1000, packing: 990 } }], missing_fields: ['invoice_date'] },
  invoice_items: [{ line_no: 1, description: 'Dates', total: 3000, net_weight_kg: 600 }, { line_no: 2, description: 'Figs', total: 2000, net_weight_kg: 400 }],
  packing_items: [{ line_no: 1, description: 'Dates', container_no: 'MSKU1234565' }] };
const DE = { active: { id: 'd1', declaration_no: '32026', declaration_type_code: 'import', status: 'release_ready', declaration_date: '2025-06-26', declaration_date_hijri: '1447/01/01', source: 'ocr' },
  items: [{ line_no: 1, hs_code: '080410', description_ar: 'تمور', gross_weight_kg: 1200, net_weight_kg: 1000, value: 18750 }] };
const TXR = { id: 'T1', ref: 'JED-1', bl_number: 'MEDU123456', clients: { name_ar: 'أكمي' } };
const MODEL = F.buildModel({ tx: TXR, shipment: SH, decl: DE, containers: [{ container_no: 'MSKU1234565', seal_no: 'S1', size_type: '40HC', gross_weight_kg: 1200, source: 'declaration' }],
  now: '2026-11-11T09:00:00Z', statusLabel: c => 'ST:' + c, sourceLabel: c => 'SRC:' + c });
eq('Fasah entry order: B/L, containers, invoice, packing, declaration', MODEL.sections.map(s => s.id), ['bl', 'containers', 'invoice', 'packing', 'declaration']);
check('summary strip: transaction, importer (client), B/L, declaration, status label, prepared at (Riyadh)', () =>
  J(MODEL.strip.map(p => p[1])) === J(['JED-1', 'أكمي', 'MEDU123456', '32026', 'ST:release_ready', '2026-11-11 12:00']) || J(MODEL.strip));
check('the currency carries its name; containers from the transaction with their source; items as approved', () => {
  const inv = MODEL.sections[2].pairs.filter(p => p[0] === 'f_currency')[0];
  return (inv[1] === 'USD — دولار أمريكي' && MODEL.sections[1].tables[0].rows[0].source === 'SRC:declaration' && MODEL.sections[4].tables[0].rows.length === 1 && MODEL.counts.invoice === 2) || J(inv);
});
check('common values: importer exact, packages equal, gross within tolerance, net differs, invoice total = its lines, containers set', () => {
  const st = {}; MODEL.common.forEach(r => { st[r.key] = r.status; });
  return J(st) === J({ importer: 'ok', packages: 'ok', gross: 'ok', net: 'diff', invoice_total: 'ok', containers: 'ok', goods: 'review' }) || J(st);
});
check('alerts: step-3 conflicts + missing, the common differences, nothing about the declaration when it is complete', () =>
  J(MODEL.alerts.map(a => a.kind + ':' + a.field)) === J(['conflict:cmp_net_weight', 'missing:miss_invoice_date', 'conflict:cm_net']) || J(MODEL.alerts));
check('review fix — the declaration side of the containers row is the declaration\'s own list (decl.containers), not containers.source: a re-confirmed + an added container → ok, no cm_containers alert', () => {
  const sh = { shipment_data: { containers: [{ container_number: 'MSCU1234565' }, { container_number: 'MSCU7654321' }] } };
  const de = { active: { id: 'd', declaration_no: '1', status: 'released' }, items: [], containers: ['MSCU1234565', 'MSCU7654321'] };
  const rows = [{ container_no: 'MSCU1234565', source: null }, { container_no: 'MSCU7654321', source: 'declaration' }];
  const m = F.buildModel({ tx: { id: 'T' }, shipment: sh, decl: de, containers: rows });
  const old = F.buildModel({ tx: { id: 'T' }, shipment: sh, decl: { active: de.active, items: [] }, containers: rows });
  const r = m.common.filter(x => x.key === 'containers')[0], ro = old.common.filter(x => x.key === 'containers')[0];
  return (r.status === 'ok' && r.declaration === 'MSCU1234565, MSCU7654321' && !m.alerts.some(a => a.field === 'cm_containers') && ro.declaration === 'MSCU7654321') || J({ r, ro, a: m.alerts });
});
check('no approved data → missing declaration + shipment data, hasData false', () => {
  const m = F.buildModel({ tx: { id: 'T', ref: 'R' }, shipment: { shipment_data: null }, decl: {}, containers: [] });
  return (!m.hasData && m.alerts.map(a => a.field).join() === 'miss_declaration,miss_shipment_data') || J(m.alerts);
});
const tAR = k => I18N.t('decl.' + k).replace(/^decl\./, '');
check('flatRows: summary + sections + tables + common + alerts, every label translated', () => {
  const rows = F.flatRows(MODEL, tAR);
  return (rows.length > 40 && rows[0].section === 'ملخص المعاملة' && rows.some(r => r.section === 'بنود البيان' && /080410/.test(r.value)) && !rows.some(r => /\b(fc|cm|cs|ak|fsec|ftab)_/.test(r.field + r.value + r.section))) || J(rows.slice(0, 3));
});
check('Excel spec builds through rpt/xlsx.js (RTL sheets ≤ 31 chars, numbers typed)', () => {
  const spec = F.xlsxSpec(MODEL, tAR, 'ar');
  const bytes = XLSX.build(spec);
  const inv = spec.sheets.filter(s => s.name === 'أصناف الفاتورة')[0];
  return (bytes && bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4B && spec.sheets.every(s => s.rtl && s.name.length <= 31) && spec.sheets.length === 7
    && inv.rows[0].total === 3000 && inv.columns.filter(c => c.key === 'total')[0].type === 'number') || J(spec.sheets.map(s => s.name));
});
eq('rowCount', F.rowCount(MODEL), MODEL.strip.length + MODEL.common.length + MODEL.alerts.length + MODEL.sections.reduce((n, s) => n + s.pairs.length + s.tables.reduce((m, t) => m + t.rows.length, 0), 0));

/* ================================================================ wiring */
section('page wiring, service worker, CSS, labels');
const OCR = rd('ocr.html'), ADMIN = rd('admin.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/decl.css'), DOCB = rd('assets/js/doc-batch.js'), TXDOCS = rd('assets/js/ops/tx-docs.js');
const order = (html, list) => { const at = list.map(f => html.indexOf('src="' + f + '"')); return at.every(x => x > 0) && at.every((x, i) => i === 0 || x > at[i - 1]); };
check('ocr.html: hidden #decl-section + root + live region; decl.css; i18n → hs-picker → doc-batch → decl-review after doc-match / legacy-norm', () =>
  (/<section class="section section-sm decl-section" id="decl-section" aria-labelledby="decl-title" hidden>/.test(OCR) && /id="decl-root"/.test(OCR) && /id="decl-live" role="status"/.test(OCR)
    && /href="assets\/css\/pages\/decl\.css"/.test(OCR) && order(OCR, ['assets/js/i18n.js', 'assets/i18n/decl.js', 'assets/js/supa.js', 'assets/js/legacy-norm.js', 'assets/js/doc-match.js', 'assets/js/hs-picker.js', 'assets/js/doc-batch.js', 'assets/js/decl-review.js'])) || 'ocr.html');
check('admin.html: decl.css, i18n/decl.js, hs-picker.js, ops/tx-decl.js + ops/fasah-sheet.js after tx-docs.js and before admin.js', () =>
  (/href="assets\/css\/pages\/decl\.css"/.test(ADMIN) && order(ADMIN, ['assets/js/i18n.js', 'assets/i18n/decl.js', 'assets/js/hs-picker.js', 'assets/js/ops/tx-docs.js', 'assets/js/ops/tx-decl.js', 'assets/js/ops/fasah-sheet.js', 'assets/js/rpt/xlsx.js', 'assets/js/rpt/export.js', 'assets/js/admin.js'])) || 'admin.html');
check('sw.js precaches the new files; VERSION ≥ 2026-11-20.1', () => {
  const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';/m.exec(SW) || [])[1] || '';
  return (['assets/js/decl-review.js', 'assets/js/hs-picker.js', 'assets/js/ops/tx-decl.js', 'assets/js/ops/fasah-sheet.js', 'assets/i18n/decl.js', 'assets/css/pages/decl.css', 'assets/js/legacy-norm.js']
    .every(f => SW.indexOf("'" + f + "'") !== -1) && v.localeCompare('2026-11-20.1', 'en', { numeric: true }) >= 0) || v;
});
check('375px: tables scroll in their own box; one column under 480px; overlay scrolls; no fixed widths on the page', () =>
  (/\.decl-table-wrap \{[^}]*overflow: auto;/.test(CSS) && /\.fsh-table-wrap \{[^}]*overflow: auto;/.test(CSS) && /@media \(max-width: 480px\) \{\s*\.decl-grid, \.decl-dl \{ grid-template-columns: 1fr; \}/.test(CSS)
    && /\.fsh-overlay \{[^}]*overflow: auto;/.test(CSS) && /\.decl-root > \*, \.decl-review > \* \{ min-width: 0; \}/.test(CSS)) || 'css');
check('error / hint lines are visible when shown (not left display:none like .form-error)', () =>
  (/\.decl-error \{ display: block;/.test(CSS) && /\.decl-field-error \{ display: block;/.test(CSS) && /\.decl-field-error\[hidden\], \.decl-field-error:empty \{ display: none; \}/.test(CSS)
    && !/class="form-error"|'form-error'/.test(SRC)) || 'css');
check('print CSS: only the sheet prints (A4 landscape), the toolbar is hidden', () =>
  (/@media print \{[\s\S]*body\.fsh-open > \*:not\(\.fsh-overlay\) \{ display: none !important; \}[\s\S]*\.fsh-toolbar \.fsh-actions, \.fsh-status \{ display: none !important; \}[\s\S]*@page \{ size: A4 landscape;/.test(CSS)) || 'print css');
check('doc-batch.js: the declaration slot links to its review for the batch transaction; HS reference only in the invoice items (read-only)', () =>
  (/slot === 'customs_declaration' && d\.extraction_id && !d\.extraction_voided/.test(DOCB) && /dl\.href = declReviewLink\(d\.extraction_id, b\.transaction_id\)/.test(DOCB)
    && /var hsRef = path === 'invoice\.items'/.test(DOCB) && !/onPick/.test(DOCB.slice(DOCB.indexOf('function openHs'), DOCB.indexOf('function openHs') + 600))) || 'doc-batch');
check('tx-docs.js: HS reference per invoice item without onPick (supplier HS stays reference only)', () =>
  (/HP\.panel\(\{ api: api, orgId: api\.orgId, query: HP\.pure\.queryOf\(x\), onClose/.test(TXDOCS) && !/onPick/.test(TXDOCS)) || 'tx-docs');
check('ocr.js: the date message no longer says Hijri is unsupported', () => (!/التاريخ الهجري غير مدعوم/.test(rd('assets/js/ocr.js')) && /أم القرى/.test(rd('assets/js/ocr.js'))) || 'ocr.js');
check('Fasah stage labels wherever statuses appear: rpt.js + portal.js (ar + en), tx-sections.js', () => {
  const R = rd('assets/i18n/rpt.js'), PO = rd('assets/i18n/portal.js'), TS = rd('assets/js/ops/tx-sections.js');
  return ['accepted', 'cco_review_done', 'awaiting_duty_payment', 'release_ready'].every(c => (R.match(new RegExp('declaration_status_' + c + ':', 'g')) || []).length === 2
    && (PO.match(new RegExp("'decl\\." + c + "':", 'g')) || []).length === 2 && TS.indexOf('lbl_declaration_status_' + c) !== -1) || 'labels';
});
check('approval only behind the confirm dialog, with the version and an idempotency key', () =>
  (/askConfirm\(\{ title: T\('cf_title'\)[\s\S]*?S\.idem = approveKey\(S\.idem, rv\.version, o, uuid\);[\s\S]*?API\.approveDeclarationExtraction\(rv\.extraction_id, rv\.transaction_id, o\)/.test(SRC)
    && (SRC.match(/approveDeclarationExtraction\(/g) || []).length === 1) || 'approve');
check('the Fasah export logs first (report fasah_sheet, filter transaction_id only — {} for a readings draft) and builds the file only on success', () =>
  /var filters = model\.txId \? \{ transaction_id: model\.txId \} : \{\};/.test(FSH)
    && /call\(api, 'logReportExport', \{ report: 'fasah_sheet', format: format, filters: filters, row_count: n/.test(FSH)
    && FSH.indexOf("if (r.error) {", FSH.indexOf("'logReportExport'")) < FSH.indexOf('X.download(', FSH.indexOf("'logReportExport'")) || 'export order');
check('docs: LEGACY_DECL_AR.md names the UI files', () => { const d = rd('docs/online/LEGACY_DECL_AR.md'); return ['assets/js/decl-review.js', 'assets/js/hs-picker.js', 'assets/js/ops/tx-decl.js', 'assets/js/ops/fasah-sheet.js'].every(f => d.includes(f)) || 'docs'; });

/* ================================================================ DOM flows */
const { makeDom } = require('./lib/fake-dom.js');
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 30); i++) await tick(); }
const ORG = '0000000a-0000-4000-8000-00000000000a', TX = '0000000d-0000-4000-8000-00000000000d', EXT = '0000000e-0000-4000-8000-00000000000e', EXT2 = '0000000f-0000-4000-8000-00000000000f';
const ok = d => Promise.resolve({ data: d, error: null });
const err = (code, field) => Promise.resolve({ data: null, error: { code, field, message: code + (field ? ':' + field : '') } });
function mockApi(opts) {
  opts = opts || {};
  const calls = [];
  const rec = (n, a) => calls.push({ n, a: JSON.parse(JSON.stringify(a === undefined ? null : a)) });
  const review = () => ({ extraction_id: EXT, transaction_id: TX, ref: 'TX-1', cargo_unit_type: opts.roro ? 'roro' : 'container', batch_id: opts.batch || null, review_status: 'unreviewed',
    prompt_version: 'ai-doc-v3', approval: opts.approved ? { id: 'a', approved_at: '2026-11-11T09:00:00Z' } : null,
    draft: Object.assign({}, DRAFT, opts.draft || {}), comparison: Object.assign({}, CMP, opts.cmp || {}), version: 'v' + (opts.ver || 1) });
  const api = {
    isOnline: () => true, getSession: () => ok({ user: {} }), isStaff: () => ok(true), activeOrgId: () => ok(ORG),
    aiAccess: () => ok({ can_use: true, daily_remaining: 5 }),
    getTransaction: id => ok({ id, ref: 'TX-1', bl_number: 'MEDU123456', clients: { name_ar: 'أكمي' } }),
    getDeclarationReview: (e, t) => { rec('getDeclarationReview', [e, t]); return ok(review()); },
    approveDeclarationExtraction: (e, t, o) => {
      rec('approveDeclarationExtraction', { e, t, o });
      if (opts.approveErr) { const x = opts.approveErr; opts.approveErr = null; return err(x[0], x[1]); }
      return ok({ approval_id: 'ap', extraction_id: e, transaction_id: t, ref: 'TX-1', batch_id: null, declaration: { declaration_no: o.declarationNo }, declaration_action: 'added',
        status_action: 'initial', bl: { status: o.confirmBlMismatch ? 'mismatch_confirmed' : 'match', matched_with: null }, containers: { added: ['TGHU7654321'], updated: ['MSKU1234565'], unchanged: [] },
        items: (o.items || []).length, hs_reference: { saved: 1, ids: ['h'] }, tx_filled: ['vessel'], tx_kept: ['country'], warnings: [], daftra_hook: 'deferred' });
    },
    aiExtract: o => { rec('aiExtract', { docType: o.docType, promptVersion: o.promptVersion, tx: o.transactionId, media: o.file.media_type });
      if (opts.wrongKind) return ok({ usage_id: 'u', detected_type: 'bill_of_lading', extracted_fields: {}, ai_detail: {} });
      if (opts.reused) return ok({ usage_id: 'u', reused: true, extraction_id: EXT2, detected_type: 'customs_declaration' });
      return ok({ usage_id: 'u', model: 'claude-opus-5-5', detected_type: 'customs_declaration', extracted_fields: { declaration_number: '32026' }, line_items: [], fields: [{ page: 1 }],
        mean_confidence: 90, raw_text: 'x', ai_detail: { prompt_version: 'ai-doc-v3', declaration: { bl_raw: 'x' } }, reused: false }); },
    saveExtraction: row => { rec('saveExtraction', { doc_type: row.doc_type, tx: row.transaction_id, ai_detail: !!row.ai_detail, org: row.org_id }); return ok({ id: EXT2 }); },
    findExtractionBySource: () => ok(null),
    searchHsReference: (q, o) => { rec('searchHsReference', { q, o }); return ok({ q, count: 1, items: [{ id: 'h1', hs_code: '08041000', description_ar: 'تمور طازجة', usage_count: 3, score: 160, last_declaration_no: '31999' }] }); },
    errorMessage: e => e && (e.code + (e.field ? ':' + e.field : '')),
    util: { uuid: (() => { let n = 0; return () => 'idem-' + (++n); })(), sha256Hex: () => Promise.resolve('a'.repeat(64)) }
  };
  return { api, calls };
}
function pageContext(api, hash, shellExtra) {
  const { document } = makeDom();
  const mk = (tag, id, parent) => { const n = document.createElement(tag); n.id = id; (parent || document.body).appendChild(n); return n; };
  const secEl = mk('section', 'decl-section'); secEl.hidden = true;
  mk('h2', 'decl-title', secEl); mk('p', 'decl-live', secEl); mk('div', 'decl-root', secEl);
  const toasts = [], confirms = [];
  const winListeners = {};
  const location = { hash: hash || '', pathname: '/ocr.html', search: '' };
  const w = {
    MarsaI18n: I18N, MarsaApi: api, MarsaNorm: NORM, MarsaDocMatch: DM,
    MarsaShell: Object.assign({ ready: Promise.resolve({}), orgId: () => ORG, can: () => true, R: { opsWriter: ['clearance_staff'] },
      toast: (m, t) => toasts.push([t, m]), confirm: o => { confirms.push(o); return Promise.resolve(true); } }, shellExtra || {}),
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); }, confirm: () => true, location
  };
  class FileReader { readAsDataURL() { setTimeout(() => { this.result = 'data:application/pdf;base64,QUJD'; this.onload && this.onload(); }, 0); } }
  const c = { window: w, document, location, history: { replaceState: (a, b, u) => { location.hash = u.slice(u.indexOf('#')) || ''; } }, FileReader, console,
    Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent };
  vm.createContext(c);
  vm.runInContext(HSP, c, { filename: 'hs-picker.js (page)' });
  vm.runInContext(SRC, c, { filename: 'decl-review.js (page)' });
  const fire = t => (winListeners[t] || []).forEach(f => f({ type: t }));
  return { document, w, sec: secEl, toasts, confirms, fire, location, root: document.getElementById('decl-root') };
}
const btnByText = (root, re) => root.querySelectorAll('button').filter(b => re.test(b.textContent))[0] || null;
const inputOf = (root, field) => { const g = root.querySelectorAll('[data-field="' + field + '"]')[0]; return g ? (g.querySelector('input') || g.querySelector('select')) : null; };

async function reviewFlow() {
  section('DOM: declaration review + approval (decl-review.js)');
  const M = mockApi();
  const Pg = pageContext(M.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  const root = Pg.root;
  check('the section shows for the deep link; the review is loaded for the reading + transaction', () =>
    (!Pg.sec.hidden && M.calls.some(c => c.n === 'getDeclarationReview' && c.a[0] === EXT && c.a[1] === TX) && /3202612345/.test(inputOf(root, 'declaration_no').value)) || root.textContent.slice(0, 300));
  check('type with its title evidence, Fasah status label, Hijri with the computed Gregorian date, B/L as read + RTL flag + candidates', () =>
    (inputOf(root, 'declaration_type').value === 'import' && /بيان استيراد/.test(root.textContent) && inputOf(root, 'status').value === 'accepted'
      && /قبول البيان — مرحلة تفتيش ومعاينة البضاعة/.test(root.textContent) && inputOf(root, 'declaration_date').value === '2025-06-26' && /يوافق 2025-06-26/.test(root.textContent)
      && root.querySelector('.decl-bl-raw').textContent === '123456 MEDU' && /انعكس بسبب اتجاه الكتابة/.test(root.textContent) && root.querySelectorAll('.decl-chip.is-match').length >= 1) || root.textContent.slice(0, 600));
  check('containers merge preview: on the transaction / new / transaction only', () =>
    (/موجودة في المعاملة — تُحدَّث/.test(root.textContent) && /جديدة — تُضاف/.test(root.textContent) && /CAIU1111117/.test(root.textContent) && /تُضاف 1 وتُحدَّث 1/.test(root.textContent)) || root.querySelector('#decl-containers').textContent);
  // editing the Hijri recomputes the Gregorian date
  const h = inputOf(root, 'declaration_date_hijri');
  h.value = '١/١٠/١٤٤٦'; h.dispatch('input');
  check('editing the Hijri recomputes the Gregorian date (Arabic digits, d/m/yyyy)', () => (inputOf(root, 'declaration_date').value === '2025-03-30' && inputOf(root, 'declaration_date').readOnly === true) || inputOf(root, 'declaration_date').value);
  h.value = '1446/01/30'; h.dispatch('input');
  await settle(2);
  check('a day the month does not have: the error line is shown (not hidden) and approve is disabled', () => {
    const e = root.querySelector('[data-field="declaration_date_hijri"] .decl-field-error');
    return (e && !e.hidden && /غير موجود في تقويم أم القرى/.test(e.textContent) && Pg.document.getElementById('decl-approve-btn').disabled) || (e && e.textContent);
  });
  h.value = '1447/01/01'; h.dispatch('input');
  // HS reference picker from an item row: search + pick copies the code locally
  btnByText(root.querySelector('#decl-items'), /^مرجع$/).click();
  await settle(10);
  check('the HS picker searches the description of the row (org, limit 10)', () =>
    (M.calls.some(c => c.n === 'searchHsReference' && c.a.q === 'تمور' && c.a.o.orgId === ORG && c.a.o.limit === 10) && /تمور طازجة/.test(root.textContent)) || J(M.calls.map(c => c.n)));
  btnByText(root.querySelector('#decl-items'), /^استخدام$/).click();
  await settle(2);
  const hsInp = root.querySelectorAll('#decl-items .decl-cell').filter(n => n.getAttribute('data-key') === 'hs_code')[0];
  check('picking copies the code into the row only (no server call)', () => (hsInp.value === '08041000' && !M.calls.some(c => c.n === 'approveDeclarationExtraction')) || hsInp.value);
  Pg.document.getElementById('decl-approve-btn').click();
  await settle(20);
  const ap = M.calls.filter(c => c.n === 'approveDeclarationExtraction')[0];
  check('approve: behind the confirm dialog, version + idempotency key, reviewed values, picked HS code', () =>
    (Pg.confirms.length === 1 && ap && ap.a.e === EXT && ap.a.t === TX && ap.a.o.version === 'v1' && ap.a.o.idemKey === 'idem-1' && ap.a.o.declarationDate === '2025-06-26'
      && ap.a.o.declarationDateHijri === '1447/01/01' && ap.a.o.items[0].hs_code === '08041000' && ap.a.o.containers.length === 2 && !ap.a.o.confirmBlMismatch) || J(ap));
  check('the result: action, B/L, containers added / updated, HS rows, filled / kept fields, Daftra deferred, link back', () =>
    (/اعتُمد البيان/.test(root.textContent) && /أُضيفت 1، حُدّثت 1/.test(root.textContent) && /TGHU7654321/.test(root.textContent) && /مُلئت في المعاملة: الباخرة/.test(root.textContent)
      && /بقيت كما هي في المعاملة: بلد المنشأ/.test(root.textContent) && /دفترة: حالة المسودة الافتتاحية/.test(root.textContent) && root.querySelectorAll('a').some(a => a.href === 'admin.html#tx/' + TX)) || root.textContent.slice(0, 500));

  // B/L mismatch: blocked until the explicit confirmation
  const M2 = mockApi({ cmp: { bl: { status: 'mismatch', transaction_bls: ['OOLU999'], candidates: ['123456 MEDU'], matched_with: null }, conflicts: [{ code: 'bl_mismatch', blocking: true, confirmable: true }] } });
  const P2 = pageContext(M2.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  P2.document.getElementById('decl-approve-btn').click(); await settle(10);
  check('a B/L mismatch: no call, the confirmation is asked for in a visible error line', () =>
    (!M2.calls.some(c => c.n === 'approveDeclarationExtraction') && /ضع علامة التأكيد/.test(P2.root.querySelector('#decl-approve-msg').textContent)
      && /يحتاج تأكيدًا/.test(P2.root.textContent)) || P2.root.querySelector('#decl-approve-msg').textContent);
  const cb = P2.document.getElementById('decl-confirm-bl'); cb.click();
  P2.document.getElementById('decl-approve-btn').click(); await settle(20);
  const ap2 = M2.calls.filter(c => c.n === 'approveDeclarationExtraction')[0];
  check('after the confirmation: confirmBlMismatch is sent; the B/L of the transaction is never part of the payload', () =>
    (ap2 && ap2.a.o.confirmBlMismatch === true && !('bl_number' in ap2.a.o) && !('blNumber' in ap2.a.o) && /غير مطابقة \(مؤكدة\)/.test(P2.root.textContent)) || J(ap2));

  // stale + duplicate errors are visible; stale offers a reload
  const M3 = mockApi({ approveErr: ['MRS_DECL_STALE'] });
  const P3 = pageContext(M3.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  P3.document.getElementById('decl-approve-btn').click(); await settle(20);
  check('MRS_DECL_STALE: the message + a reload button', () => (/MRS_DECL_STALE/.test(P3.root.querySelector('#decl-approve-msg').textContent) && !!btnByText(P3.root.querySelector('#decl-approve-msg'), /إعادة تحميل/)) || P3.root.textContent.slice(0, 300));
  btnByText(P3.root.querySelector('#decl-approve-msg'), /إعادة تحميل/).click(); await settle(20);
  check('reload fetches the review again', () => M3.calls.filter(c => c.n === 'getDeclarationReview').length === 2 || J(M3.calls.map(c => c.n)));
  check('review fix — after the reload the stale error and its reload button are gone; a notice says the edits were kept', () => {
    const m = P3.root.querySelector('#decl-approve-msg').textContent;
    return (!/MRS_DECL_STALE/.test(m) && !btnByText(P3.root.querySelector('#decl-approve-msg'), /إعادة تحميل/) && /بقيت تعديلاتك/.test(m)) || m;
  });
  const M3b = mockApi({ approveErr: ['MRS_DECL_STALE'] });
  const P3b = pageContext(M3b.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  const no3 = inputOf(P3b.root, 'declaration_no'); no3.value = '3202699999'; no3.dispatch('input');
  P3b.document.getElementById('decl-approve-btn').click(); await settle(20);
  btnByText(P3b.root.querySelector('#decl-approve-msg'), /إعادة تحميل/).click(); await settle(20);
  P3b.document.getElementById('decl-approve-btn').click(); await settle(20);
  const ap3 = M3b.calls.filter(c => c.n === 'approveDeclarationExtraction');
  check('review fix — the staff edit survives the stale reload and is sent with a NEW idempotency key', () =>
    (inputOf(P3b.root, 'declaration_no') === null || true) && ap3.length === 2 && ap3[1].a.o.declarationNo === '3202699999' && ap3[1].a.o.idemKey !== ap3[0].a.o.idemKey || J(ap3.map(x => x.a.o)));

  // live container preview: every badge + the summary follow a typed number
  const MC = mockApi();
  const PC = pageContext(MC.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  const cRow2 = PC.root.querySelectorAll('#decl-containers .decl-cell').filter(n => n.getAttribute('data-key') === 'container_number' && n.getAttribute('data-row') === '1')[0];
  cRow2.value = 'CAIU1111117'; cRow2.dispatch('input');
  check('review fix — typing a container number updates the summary and the transaction-only list (0 added / 2 updated / 0 only), focus input kept', () => {
    const t = PC.root.querySelector('#decl-containers').textContent;
    const still = PC.root.querySelectorAll('#decl-containers .decl-cell').filter(n => n.getAttribute('data-key') === 'container_number' && n.getAttribute('data-row') === '1')[0];
    return (/تُضاف 0 وتُحدَّث 2، و0/.test(t) && !/CAIU1111117 \(|في المعاملة فقط:.*CAIU/.test(t.replace(/\s+/g, ' ')) && still === cRow2) || t;
  });
  cRow2.value = 'MSKU1234565'; cRow2.dispatch('input');
  check('review fix — another row is re-marked: the first row becomes «مكررة» when row 2 takes its number', () => {
    const badges = PC.root.querySelectorAll('#decl-containers .badge').map(b => b.textContent);
    return (badges.indexOf('مكررة') !== -1 && /تُضاف 0 وتُحدَّث 1، و1/.test(PC.root.querySelector('#decl-containers').textContent)) || J(badges);
  });

  // the action / status move follow the edited number + status; a hard conflict blocks approve
  const EXD = { id: 'd', declaration_no: '999', declaration_type: 'import', declaration_type_code: 'import', status: 'released', declaration_date: '2025-06-26', declaration_date_hijri: '1447/01/01' };
  const MP = mockApi({ cmp: { declaration: { action: 'conflict', existing: EXD }, status: { read: 'accepted', current: 'released', direction: 'backward' },
    conflicts: [{ code: 'declaration_other_number', blocking: true, confirmable: false }, { code: 'status_backward', blocking: false, confirmable: false }] } });
  const PP = pageContext(MP.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  check('review fix — the number as read conflicts: the conflict + backward notices, approve disabled', () =>
    (/تعارض/.test(PP.root.querySelector('#decl-plan').textContent) && /للمعاملة بيان نشط برقم آخر/.test(PP.root.querySelector('#decl-checks').textContent)
      && PP.document.getElementById('decl-approve-btn').disabled) || PP.root.querySelector('#decl-plan').textContent);
  const noP = inputOf(PP.root, 'declaration_no'); noP.value = '999'; noP.dispatch('input');
  const stP = inputOf(PP.root, 'status'); stP.value = 'released'; stP.dispatch('change');
  await settle(2);
  check('review fix — after correcting the number to the recorded one and choosing the recorded status: «تصحيح البيان القائم», status same, no conflict / backward notice, approve enabled', () => {
    const plan = PP.root.querySelector('#decl-plan').textContent, chk = PP.root.querySelector('#decl-checks').textContent;
    return (/تصحيح البيان القائم/.test(plan) && /الحالة كما هي/.test(plan) && !/تعارض/.test(plan) && !/برقم آخر/.test(chk) && !/أقدم من حالة البيان/.test(chk)
      && !PP.document.getElementById('decl-approve-btn').disabled) || J({ plan, chk });
  });
  PP.document.getElementById('decl-approve-btn').click(); await settle(20);
  check('review fix — the confirm dialog states the action / status move of the EDITED values', () => {
    const t = (PP.confirms[0] || {}).text || '';
    return (/الإجراء: تصحيح البيان القائم/.test(t) && /الحالة كما هي/.test(t) && !/تعارض/.test(t)) || t;
  });

  // the HS picker's own close removes the «row n» line
  const MH = mockApi();
  const PH = pageContext(MH.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  btnByText(PH.root.querySelector('#decl-items'), /^مرجع$/).click(); await settle(10);
  const hostH = PH.root.querySelector('.decl-picker-host');
  const hadLine = /اقتراحات للصف 1/.test(hostH.textContent);
  btnByText(hostH, /^إغلاق$/).click(); await settle(2);
  check('review fix — the picker\'s «إغلاق» empties the host (no orphan «اقتراحات للصف n:» line)', () => (hadLine && hostH.textContent === '' && !hostH.querySelector('.hsp')) || J({ hadLine, t: hostH.textContent }));
  const M4 = mockApi({ approveErr: ['MRS_DUPLICATE_TX', 'container'] });
  const P4 = pageContext(M4.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  P4.document.getElementById('decl-approve-btn').click(); await settle(20);
  check('MRS_DUPLICATE_TX: the guard error + what to do (nothing saved)', () => (/MRS_DUPLICATE_TX:container/.test(P4.root.textContent) && /لم يُحفظ شيء/.test(P4.root.textContent)) || P4.root.textContent.slice(0, 300));
  const M5 = mockApi({ approveErr: ['MRS_INVALID', 'declaration_no_taken'] });
  const P5 = pageContext(M5.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  P5.document.getElementById('decl-approve-btn').click(); await settle(20);
  check('MRS_INVALID declaration_no_taken → its own Arabic text', () => /رقم البيان مسجل لمعاملة أخرى في مؤسستك/.test(P5.root.textContent) || P5.root.textContent.slice(0, 300));

  // read-only role / already approved
  const M6 = mockApi();
  const P6 = pageContext(M6.api, '#decl=' + EXT + '&tx=' + TX, { can: () => false });
  await settle(40);
  check('not an ops writer: inputs disabled, no approve button, the role note', () =>
    (!P6.document.getElementById('decl-approve-btn') && inputOf(P6.root, 'declaration_no').disabled && /يمكنك عرض القراءة فقط/.test(P6.root.textContent)) || P6.root.textContent.slice(0, 200));
  const M7 = mockApi({ approved: true });
  const P7 = pageContext(M7.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  check('an approved reading: the approval note, no approve button', () => (/اعتُمدت هذه القراءة/.test(P7.root.textContent) && !P7.document.getElementById('decl-approve-btn')) || P7.root.textContent.slice(0, 200));
  const M8 = mockApi({ roro: true, draft: { containers: [] }, cmp: { containers: { matched: [], new: [], not_on_declaration: [] } } });
  const P8 = pageContext(M8.api, '#decl=' + EXT + '&tx=' + TX);
  await settle(40);
  const roroText = P8.root.textContent;
  P8.document.getElementById('decl-approve-btn').click(); await settle(20);
  const ap8 = M8.calls.filter(c => c.n === 'approveDeclarationExtraction')[0];
  check('Ro-Ro: no container is required and none is sent', () => (ap8 && J(ap8.a.o.containers) === '[]' && /Ro-Ro/.test(roroText)) || J(ap8));
}

async function uploadFlow() {
  section('DOM: declaration upload + reading (decl-review.js)');
  const M = mockApi();
  const Pg = pageContext(M.api, '#decl-tx=' + TX);
  await settle(40);
  const inp = Pg.document.getElementById('decl-file');
  check('the upload box for the transaction; read disabled before a file', () => (!Pg.sec.hidden && !!inp && Pg.document.getElementById('decl-read-btn').disabled && /TX-1/.test(Pg.root.textContent)) || Pg.root.textContent.slice(0, 200));
  inp.files = [{ name: 'decl.docx', size: 10, type: '' }]; inp.dispatch('change');
  check('an unsupported file is refused with a visible message', () => /صيغة غير مدعومة/.test(Pg.root.querySelector('.decl-error').textContent) || Pg.root.textContent.slice(0, 200));
  Pg.document.getElementById('decl-file').files = [{ name: 'decl.pdf', size: 2048, type: 'application/pdf' }]; Pg.document.getElementById('decl-file').dispatch('change');
  Pg.document.getElementById('decl-read-btn').click();
  await settle(60);
  check('a fresh reading: aiExtract v3 customs_declaration for the transaction, saved with ai_detail, then the review opens', () =>
    (M.calls.some(c => c.n === 'aiExtract' && c.a.docType === 'customs_declaration' && c.a.promptVersion === 'ai-doc-v3' && c.a.tx === TX && c.a.media === 'application/pdf')
      && M.calls.some(c => c.n === 'saveExtraction' && c.a.doc_type === 'customs_declaration' && c.a.tx === TX && c.a.ai_detail && c.a.org === ORG)
      && Pg.location.hash === '#decl=' + EXT2 + '&tx=' + TX) || J([M.calls.map(c => c.n), Pg.location.hash]));
  const MR = mockApi({ reused: true });
  const PR = pageContext(MR.api, '#decl-tx=' + TX);
  await settle(40);
  PR.document.getElementById('decl-file').files = [{ name: 'd.pdf', size: 10, type: 'application/pdf' }]; PR.document.getElementById('decl-file').dispatch('change');
  PR.document.getElementById('decl-read-btn').click(); await settle(60);
  check('a reused reading (no charge): its extraction_id is used, nothing saved again', () =>
    (!MR.calls.some(c => c.n === 'saveExtraction') && PR.location.hash === '#decl=' + EXT2 + '&tx=' + TX) || J([MR.calls.map(c => c.n), PR.location.hash]));
  const MW = mockApi({ wrongKind: true });
  const PW = pageContext(MW.api, '#decl-tx=' + TX);
  await settle(40);
  PW.document.getElementById('decl-file').files = [{ name: 'd.pdf', size: 10, type: 'application/pdf' }]; PW.document.getElementById('decl-file').dispatch('change');
  PW.document.getElementById('decl-read-btn').click(); await settle(60);
  check('a file that is not a declaration: not saved, the kind is named', () => (!MW.calls.some(c => c.n === 'saveExtraction') && /بوليصة شحن/.test(PW.root.textContent)) || PW.root.textContent.slice(0, 300));
  const MN = mockApi();
  const PN = pageContext(MN.api, '');
  await settle(20);
  check('without a deep link the section stays hidden', () => PN.sec.hidden === true || 'shown');
}

function opsEl(document) {
  return (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); });
    [].concat(kids == null ? [] : kids).forEach(function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(add); n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
}
async function txAndSheetFlow() {
  section('DOM: transaction section (tx-decl.js) + Fasah sheet (fasah-sheet.js)');
  const { document } = makeDom();
  const calls = [];
  let logErr = null;
  const downloads = [];
  const A = {
    getTransactionDeclaration: id => { calls.push('decl'); return ok(Object.assign({ transaction_id: id, declarations: [DE.active], approvals: [{ extraction_id: EXT, approved_at: '2026-11-11', bl_status: 'match', daftra_hook: 'deferred' }] }, DE)); },
    listExtractions: o => { calls.push('ext:' + o.transactionId); return ok([{ id: EXT, doc_type: 'customs_declaration' }, { id: EXT2, doc_type: 'customs_declaration', source_name: 'decl-2.pdf', created_at: '2026-11-11' }]); },
    getTransactionShipment: () => ok(SH), listContainers: () => ok([{ container_no: 'MSKU1234565', seal_no: 'S1', source: 'declaration' }]),
    logReportExport: p => { calls.push(['log', p]); return logErr ? err(logErr) : ok({ id: 'l' }); },
    searchHsReference: (q, o) => { calls.push(['hs', q, o]); return ok({ items: [{ hs_code: '0804', description_ar: 'تمور', score: 100, usage_count: 1 }] }); }
  };
  const w2 = { MarsaI18n: I18N, document, MarsaXlsx: XLSX, print: () => calls.push('print'),
    MarsaExport: { download: (b, n) => { downloads.push(n); return n; }, toCsv: (cols, rows) => '\uFEFF' + rows.length } };
  const c2 = { window: w2, document, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, Blob: function (p, o) { this.p = p; this.o = o; } };
  w2.window = w2;
  vm.createContext(c2);
  vm.runInContext(DICT, c2); vm.runInContext(HSP, c2); vm.runInContext(TXD, c2); vm.runInContext(FSH, c2);
  const api = { el: opsEl(document), can: () => true, cancelled: false, orgId: ORG, fmtDate: v => String(v), errText: e => e.code, isEn: () => false,
    label: (d, c) => d === 'declaration_status' ? 'L:' + c : c, MarsaApi: A };
  const host = document.createElement('div'); document.body.appendChild(host);
  const s = w2.MarsaOps.txSections.filter(x => x.id === 'declaration_reading')[0];
  await s.render(host, { id: TX, ref: 'TX-1', branch_id: 'b' }, api);
  check('section: read link (ops writer), Fasah button, active declaration with the stage label, items, approvals, pending readings, HS search', () =>
    (host.querySelectorAll('a').some(a => a.href === 'ocr.html#decl-tx=' + TX) && !!host.querySelector('[data-fasah-sheet]') && /L:release_ready/.test(host.textContent) && /080410/.test(host.textContent)
      && host.querySelectorAll('a').some(a => a.href === 'ocr.html#decl=' + EXT + '&tx=' + TX) && host.querySelectorAll('a').some(a => a.href === 'ocr.html#decl=' + EXT2 + '&tx=' + TX && /decl-2\.pdf/.test(a.textContent))
      && !host.querySelectorAll('a').some(a => a.href === 'ocr.html#decl=' + EXT + '&tx=' + TX && /decl-2/.test(a.textContent)) && !!host.querySelector('.hsp')) || host.textContent.slice(0, 400));
  const host2 = document.createElement('div');
  await s.render(host2, { id: TX, cancelled_at: 'x' }, Object.assign({}, api, { cancelled: true }));
  check('a cancelled transaction: no read link (the sheet stays available)', () => (!host2.querySelectorAll('a').some(a => a.href === 'ocr.html#decl-tx=' + TX) && !!host2.querySelector('[data-fasah-sheet]')) || 'link');
  // the sheet
  await w2.MarsaFasahSheet.open({ id: TX, ref: 'TX-1', bl_number: 'MEDU123456', clients: { name_ar: 'أكمي' } }, api);
  const ov = document.body.querySelector('.fsh-overlay');
  check('the sheet opens as a dialog over the page in the Fasah order, buttons enabled', () =>
    (ov && ov.getAttribute('role') === 'dialog' && document.body.classList.contains('fsh-open') && ov.querySelectorAll('.fsh-sec').length === 7 && /1 — معلومات البوليصة/.test(ov.textContent)
      && /5 — البيان الجمركي/.test(ov.textContent) && /USD — دولار أمريكي/.test(ov.textContent) && /يوجد اختلاف/.test(ov.textContent) && !btnByText(ov, /^Excel$/).disabled) === true || (ov && ov.textContent.slice(0, 300)));
  btnByText(ov, /^Excel$/).click(); await settle(10);
  const log1 = calls.filter(x => Array.isArray(x) && x[0] === 'log')[0];
  check('Excel: logged first (fasah_sheet, xlsx, filters {transaction_id}, row_count), then the file كشف-إدخال-فسح-TX-1-…xlsx', () =>
    (log1 && log1[1].report === 'fasah_sheet' && log1[1].format === 'xlsx' && J(log1[1].filters) === J({ transaction_id: TX }) && log1[1].row_count > 20 && log1[1].orgId === ORG
      && /^كشف-إدخال-فسح-TX-1-\d{8}-\d{4}\.xlsx$/.test(downloads[0] || '')) || J([log1, downloads]));
  btnByText(ov, /^CSV$/).click(); await settle(10);
  btnByText(ov, /طباعة/).click(); await settle(10);
  check('CSV and print are logged with their format too', () =>
    (calls.filter(x => Array.isArray(x) && x[0] === 'log').map(x => x[1].format).join() === 'xlsx,csv,print' && /\.csv$/.test(downloads[1] || '') && calls.indexOf('print') !== -1) || J(calls));
  logErr = 'MRS_FORBIDDEN';
  btnByText(ov, /^Excel$/).click(); await settle(10);
  check('a failed log: no file is built, the error is shown', () => (downloads.length === 2 && /تعذّر التصدير/.test(ov.querySelector('.fsh-status').textContent)) || J(downloads));
  btnByText(ov, /^إغلاق$/).click();
  check('close removes the overlay', () => (!document.body.querySelector('.fsh-overlay') && !document.body.classList.contains('fsh-open')) || 'still open');
  // review fix: one failed source (declaration / shipment / containers) → the error, nothing to print or export
  for (const which of ['getTransactionDeclaration', 'getTransactionShipment', 'listContainers']) {
    const saved = A[which];
    A[which] = () => err('MRS_NETWORK');
    const nLog = calls.filter(x => Array.isArray(x) && x[0] === 'log').length;
    await w2.MarsaFasahSheet.open({ id: TX, ref: 'TX-1' }, api);
    const o2 = document.body.querySelector('.fsh-overlay');
    check('review fix — ' + which + ' fails alone: the error is shown, the export buttons stay disabled, nothing logged', () =>
      (o2 && /MRS_NETWORK/.test(o2.textContent) && btnByText(o2, /^Excel$/).disabled && btnByText(o2, /طباعة/).disabled && !o2.querySelector('.fsh-sec')
        && calls.filter(x => Array.isArray(x) && x[0] === 'log').length === nLog) || (o2 && o2.textContent.slice(0, 200)));
    btnByText(o2, /^إغلاق$/).click();
    A[which] = saved;
  }
}

/* ================================================================ «كشف إدخال فسح» from the readings (2026-11-14) */
// synthetic readings only (fictional parties / numbers); the engine answer is the report's own: MarsaDocMatch strict
const RD_BL = { bl_number: 'SYNBL0001', shipper: 'BLUE HARBOUR FOODS LTD', consignee: 'NAJD SAMPLE TRADING CO', vessel: 'SAMPLE STAR', voyage: '101E',
  port_of_loading: 'PORT ALPHA', port_of_discharge: 'JEDDAH', freight_terms: 'FREIGHT PREPAID', goods_description: 'FROZEN FISH FILLET', packages_count: '1200',
  package_type: 'CARTONS', gross_weight: '13000', net_weight: '12000', measurement_cbm: '30', temperature_c: '-18', container_numbers: 'TSTU7710023', seal_numbers: 'SL-9001' };
const RD_INV = { invoice_number: 'INV-77', invoice_date: '2026-10-01', supplier_name: 'BLUE HARBOUR FOODS LTD', buyer_name: 'NAJD SAMPLE TRADING CO', currency: 'usd',
  total: '24000', country_of_origin: 'SAMPLELAND', export_country: 'SAMPLELAND', incoterms: 'CFR', payment_terms: 'TT 30 DAYS', gross_weight: '13000', packages_count: '1200' };
const RD_PK = { packing_list_number: 'PL-77', packing_list_date: '2026-10-01', packages_count: '1200', package_type: 'CARTONS', gross_weight: '13500', net_weight: '12000', container_numbers: 'TSTU7710023' };
const RD_ITEMS = [{ description: 'FROZEN FISH FILLET', hs_code: '030489', quantity: 12000, unit: 'KG', unit_price: 2, amount: 24000, origin_country: 'SAMPLELAND', scientific_name: 'Sample spp' }];
const RD_CT = [{ container_number: 'TSTU7710023', seal_number: 'SL-9001', size_type: '40RF', packages_count: 1200, gross_weight: 13000, net_weight: 12000 }];
const fld = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
function rdResult(withPk) {
  const inp = { bl: { fields: fld(RD_BL), items: [] }, invoice: { fields: fld(RD_INV), items: RD_ITEMS } };
  if (withPk) inp.packing = { fields: fld(RD_PK), items: [] };
  return DM.compare(inp, { mode: 'strict' });
}
function rdSrc(o) {
  o = o || {};
  const docs = { bl: { fields: Object.assign({}, RD_BL, o.bl || {}), items: [], containers: o.noCt ? [] : RD_CT, label: 'bl.pdf', detected: 'bill_of_lading' },
    invoice: { fields: Object.assign({}, RD_INV, o.inv || {}), items: RD_ITEMS, containers: [], label: o.invLabel || 'inv.pdf', detected: o.invDetected || 'commercial_invoice' } };
  if (o.pk) docs.packing = { fields: RD_PK, items: [{ description: 'FROZEN FISH FILLET', packages: 1200, quantity: 12000, unit: 'KG', gross_weight: 13500, net_weight: 12000, container_number: 'TSTU7710023' }], label: 'pl.pdf', detected: 'packing_list', parentDetected: o.pkParent };
  return { docs, result: rdResult(!!o.pk), now: new Date('2026-11-14T09:05:00Z'), lang: o.lang || 'ar', exceptions: o.exceptions, t: k => I18N.t('decl.' + k) };
}
section('Fasah sheet from the readings (buildReadingsModel)');
{
  const m = F.buildReadingsModel(rdSrc({ pk: true }));
  const sec = id => m.sections.filter(s => s.id === id)[0];
  const pv = (s, k) => (s.pairs.concat(...(s.groups || []).map(g => g.pairs)).filter(p => p[0] === k)[0] || [])[1];
  check('ready draft: strip = «مسودة — قبل إنشاء المعاملة», importer (consignee), B/L no., prepared at in Riyadh time', () =>
    (m.ready && m.draft && m.txId === null && J(m.strip.map(p => p[0])) === J(['s_tx', 's_importer', 's_bl', 's_prepared']) && m.strip[0][1] === 'مسودة — قبل إنشاء المعاملة'
      && m.strip[1][1] === 'NAJD SAMPLE TRADING CO' && m.strip[2][1] === 'SYNBL0001' && m.strip[3][1] === '2026-11-14 12:05') || J(m.strip));
  check('sections in the reference order: 1 B/L (pairs + «الكميات والأوزان كما وردت في البوليصة» + containers & seals), 2 invoice (+ items), 3 packing list', () =>
    (J(m.sections.map(s => s.id)) === J(['bl', 'invoice', 'packing']) && sec('bl').titleKey === 'rsec_bl' && sec('bl').groups[0].titleKey === 'rg_bl_qty'
      && pv(sec('bl'), 'f_vessel_voyage') === 'SAMPLE STAR / 101E' && pv(sec('bl'), 'f_temp') === '-18' && pv(sec('bl'), 'f_cbm') === '30' && pv(sec('bl'), 'rf_consignee') === 'NAJD SAMPLE TRADING CO'
      && sec('bl').tables[0].id === 'rd_containers' && J(sec('bl').tables[0].cols.map(c => c.key)) === J(['container_no', 'seal_no', 'size_type', 'packages', 'rgross', 'net'])
      && sec('bl').tables[0].rows[0].seal_no === 'SL-9001' && sec('bl').tables[0].rows[0].size_type === '40RF') || J(m.sections.map(s => s.id)));
  check('invoice: seller / buyer / currency name / total / incoterms / payment terms; items in the reference columns', () =>
    (pv(sec('invoice'), 'f_currency') === 'USD — دولار أمريكي' && pv(sec('invoice'), 'f_seller') === 'BLUE HARBOUR FOODS LTD' && pv(sec('invoice'), 'f_total') === '24000'
      && pv(sec('invoice'), 'f_payment_terms') === 'TT 30 DAYS' && J(sec('invoice').tables[0].cols.map(c => c.key)) === J(['description', 'supplier_hs_code', 'quantity', 'unit', 'unit_price', 'total', 'origin_country', 'scientific_name'])
      && sec('invoice').tables[0].rows[0].supplier_hs_code === '030489' && sec('invoice').tables[0].rows[0].total === 24000) || J(sec('invoice')));
  check('a value the reading did not return stays empty (rendered «—»): B/L notify party not listed, invoice export country blank when absent', () => {
    const m2 = F.buildReadingsModel(rdSrc({ inv: { export_country: '' } }));
    return (pv(m2.sections[1], 'f_export_country') === '' && !m2.sections[0].pairs.some(p => p[0] === 'f_notify') && m2.sections.length === 2) || J(m2.sections[1].pairs);
  });
  const R = rdResult(true);
  check('common values = the report\'s engine rows, same statuses (strict): match → ok, mismatch → diff, info on one document → single, missing → review; columns of the documents used', () => {
    const g = m.common.filter(r => r.key === 'gross_weight')[0], c = m.common.filter(r => r.key === 'consignee')[0];
    return (m.common.length === R.rows.length && g && g.engine === 'mismatch' && g.status === 'diff' && g.packing === '13500' && c && c.status === 'ok'
      && J(m.docCols) === J(['bl', 'invoice', 'packing']) && c.label === 'المرسل إليه / المستورد'
      && m.common.filter(r => r.key === 'invoice_number')[0].engine === 'info' && m.common.filter(r => r.key === 'invoice_number')[0].status === 'single'
      && m.common.some(r => r.engine === 'missing') && m.common.filter(r => r.engine === 'missing').every(r => r.status === (r.bl || r.invoice || r.packing ? 'review' : 'missing'))
      && m.common.every(r => r.engine !== 'missing' || r.status !== 'single')) || J(m.common);
  });
  check('conflicts table: the report\'s exceptions as given (st → kind), else its mismatch / partial / critical missing rows', () => {
    const m2 = F.buildReadingsModel(rdSrc({ pk: true, exceptions: [{ st: 'invalid', label: 'أرقام الحاويات', values: { bl: 'TSTU7710024' }, note: 'x' }, { st: 'partial', label: 'L', values: {}, note: '' }] }));
    return (J(m2.alerts.map(a => a.kind)) === J(['invalid', 'review']) && m2.alerts[0].bl === 'TSTU7710024'
      && m.alerts.some(a => a.kind === 'conflict' && a.packing === '13500')) || J([m2.alerts, m.alerts]);
  });
  check('a correction (a changed reading value) flows into the sheet and the common values', () => {
    const src = rdSrc({ pk: true, bl: { gross_weight: '13500' } });
    src.result = DM.compare({ bl: { fields: fld(Object.assign({}, RD_BL, { gross_weight: '13500' })), items: [] }, invoice: { fields: fld(RD_INV), items: RD_ITEMS }, packing: { fields: fld(RD_PK), items: [] } }, { mode: 'strict' });
    const m2 = F.buildReadingsModel(src);
    return (m2.sections[0].groups[0].pairs.filter(p => p[0] === 'rf_gross')[0][1] === '13500' && m2.common.filter(r => r.key === 'gross_weight')[0].bl === '13500') || J(m2.common);
  });
  check('containers: from container_numbers + seal_numbers when the reading has no rows; a corrected container list rebuilds the rows', () => {
    const a = F.containerRows({ fields: { container_numbers: 'TSTU7710023, MSKU1234565', seal_numbers: 'S1, S2' }, containers: [] });
    const b = F.containerRows({ fields: { container_numbers: 'MSKU1234565' }, containers: RD_CT });
    return (J(a.map(x => [x.container_no, x.seal_no])) === J([['TSTU7710023', 'S1'], ['MSKU1234565', 'S2']]) && b.length === 1 && b[0].container_no === 'MSKU1234565') || J([a, b]);
  });
  check('readingExcluded: a Fasah entry sheet (file name / title) → fasah_sheet; detected type other → other; a B/L → null', () =>
    (F.readingExcluded({ fileName: 'كشف-إدخال-فسح-000001-20261101.pdf' }) === 'fasah_sheet' && F.readingExcluded({ label: 'x', fields: { goods_description: 'ورقة معلومات الإدخال في منصة فسح' } }) === 'fasah_sheet'
      && F.readingExcluded({ label: 'FASAH entry sheet.pdf' }) === 'fasah_sheet' && F.readingExcluded({ label: 'a.pdf', detected: 'other' }) === 'other'
      && F.readingExcluded({ label: 'a.pdf — packing', detected: 'packing_list', parentDetected: 'other' }) === 'other' && F.readingExcluded({ label: 'bl.pdf', detected: 'bill_of_lading' }) === null) || 'excluded');
  check('a combined Fasah sheet in the invoice slot: no sheet (not ready), the reason kept for the note; a packing part of an \'other\' file is left out only', () => {
    const a = F.buildReadingsModel(rdSrc({ invLabel: 'كشف إدخال فسح 000001.pdf — فاتورة تجارية' }));
    const b = F.buildReadingsModel(rdSrc({ pk: true, pkParent: 'other' }));
    return (a.ready === false && J(a.missing) === J(['invoice']) && a.excluded[0].reason === 'fasah_sheet' && a.excluded[0].doc === 'invoice'
      && b.ready && J(b.sections.map(s => s.id)) === J(['bl', 'invoice']) && J(b.docCols) === J(['bl', 'invoice']) && b.excluded[0].doc === 'packing') || J([a, b.excluded]);
  });
  check('file name كشف-إدخال-فسح-مسودة-{yyyymmdd-hhmm} (Riyadh); flatRows / xlsxSpec carry the groups and the document columns', () => {
    const t = k => I18N.t('decl.' + k);
    const rows = F.flatRows(m, t), spec = F.xlsxSpec(m, t, 'ar');
    const bytes = XLSX.build(spec);
    const common = spec.sheets.filter(x => x.name === 'مراجعة سريعة للقيم المشتركة')[0];
    return (m.fileBase === 'كشف-إدخال-فسح-مسودة-20261114-1205' && F.fileName(m.fileSeq, new Date('2026-11-14T09:05:00Z'), 'csv') === 'كشف-إدخال-فسح-مسودة-20261114-1205.csv'
      && rows.some(r => r.section === 'الكميات والأوزان كما وردت في البوليصة' && r.field === 'درجة الحرارة' && r.value === '-18')
      && rows.some(r => r.section === 'الحاويات والأختام') && common && J(common.columns.map(c => c.key)) === J(['field', 'bl', 'invoice', 'packing', 'result'])
      && spec.meta[0][1] === 'مسودة — قبل إنشاء المعاملة' && spec.meta[2][1] === t('rd_foot_note') && bytes.length > 1000
      && F.rowCount(m) === rows.length) || J([m.fileBase, F.rowCount(m), rows.length, common && common.columns]);
  });
  check('the transaction sheet is unchanged by the adapter (no docCols / groups → the four document columns)', () => J(F.docCols({})) === J(['bl', 'invoice', 'packing', 'declaration']) || 'docCols');
  check('i18n: the draft keys in Arabic and English (decl + ocr.mx_fsh_*)', () => {
    const keys = ['rd_draft', 'rd_lead', 'rd_foot_note', 'rd_need', 'rd_need_original', 'rd_excluded_fasah_sheet', 'rd_excluded_other', 'rsec_bl', 'rsec_invoice', 'rsec_packing', 'rsec_declaration',
      'rg_bl_qty', 'rf_consignee', 'rf_pk_total', 'rf_gross', 'fc_rgross', 'fc_rgross_weight_kg', 'ftab_rd_containers', 'ftab_rd_packing_items', 'ak_invalid', 'ak_review', 'cs_review'];
    const ocr = rd('assets/i18n/ocr.js');
    return (keys.every(has) && (ocr.match(/mx_fsh_title: '/g) || []).length === 2 && (ocr.match(/mx_fsh_tag: '/g) || []).length === 2
      && dicts.ar['decl.rd_foot_note'] === 'هذه الورقة مخصصة لتسريع ودقة إدخال المعاملة الجديدة في منصة فسح قبل إنشاء البيان، ولا تغني عن مراجعة المستندات الأصلية.') || keys.filter(k => !has(k));
  });
  check('en: the draft strip / sections in English', () => {
    LANG = 'en';
    try { const e = F.buildReadingsModel(rdSrc({ lang: 'en' })); return (e.strip[0][1] === 'Draft — before the transaction is created' && e.sections[1].pairs.filter(p => p[0] === 'f_currency')[0][1] === 'USD — US dollar') || J(e.strip); }
    finally { LANG = 'ar'; }
  });
}
section('Fasah sheet from the readings — page wiring (ocr.html, ocr-match.js, ocr.js)');
{
  const OCRH = rd('ocr.html'), MX = rd('assets/js/ocr-match.js'), OCRJ = rd('assets/js/ocr.js'), SW = rd('sw.js');
  const pos = f => OCRH.indexOf('src="' + f + '"');
  check('ocr.html: rpt/xlsx.js → rpt/export.js → ops/fasah-sheet.js after doc-match.js and before ocr-match.js; decl.css + i18n/decl.js loaded; all precached in sw.js', () =>
    (pos('assets/js/doc-match.js') < pos('assets/js/rpt/xlsx.js') && pos('assets/js/rpt/xlsx.js') < pos('assets/js/rpt/export.js') && pos('assets/js/rpt/export.js') < pos('assets/js/ops/fasah-sheet.js')
      && pos('assets/js/ops/fasah-sheet.js') < pos('assets/js/ocr-match.js') && pos('assets/js/rpt/xlsx.js') > 0 && /href="assets\/css\/pages\/decl\.css"/.test(OCRH) && pos('assets/i18n/decl.js') > 0
      && ['assets/js/rpt/xlsx.js', 'assets/js/rpt/export.js', 'assets/js/ops/fasah-sheet.js', 'assets/css/pages/decl.css', 'assets/i18n/decl.js'].every(f => SW.includes("'" + f + "'"))) || 'ocr.html');
  check('ocr.html: the collapsible «كشف إدخال فسح» block (hidden until both are read) after the exceptions and before the per-document sheets', () => {
    const a = OCRH.indexOf('id="ocr-mx-exc"'), b = OCRH.indexOf('id="ocr-fsh-block"'), c = OCRH.indexOf('id="ocr-mx-sheets-block"');
    return (a > 0 && a < b && b < c && /<details class="ocr-match-details ocr-fsh-block" id="ocr-fsh-block" open hidden>/.test(OCRH) && /id="ocr-fsh-body"/.test(OCRH)) || [a, b, c];
  });
  check('ocr-match.js: rendered with every report render (corrections flow in) from the same engine result + exceptions; needs the invoice AND the B/L', () =>
    (/renderExceptions\(\);\n      renderFasah\(\);\n      renderSheets\(\);/.test(MX) && /F\.renderDraft\(body, \{\n        docs: fasahDocs\(\), result: R,/.test(MX)
      && /exceptions: X2\.rows\.map/.test(MX) && /!S\.slots\.invoice\.res \|\| !S\.slots\.bl\.res/.test(MX) && /fields: plainFields\(s\)/.test(MX)) || 'ocr-match.js');
  check('ocr.js: a part of a combined file carries the whole file\'s detected type (an \'other\' file never makes the sheet); ocr-match keeps the file name', () =>
    (/source_detected_type: typeof res\.detected_type === 'string' \? res\.detected_type : null/.test(OCRJ) && /parentDetected: typeof res\.source_detected_type === 'string'/.test(MX)
      && /s\.fileName = String\(x\.fileName/.test(MX)) || 'ocr.js');
  check('decl.css: the readings draft is left out of the matching report\'s own print; the draft prints 3 pairs per row', () => {
    const css = rd('assets/css/pages/decl.css');
    return (/body\.ocr-print-match \.ocr-fsh-block \{ display: none !important; \}/.test(css) && /\.fsh-draft \.fsh-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/.test(css)) || 'css';
  });
}
async function draftFlow() {
  section('DOM: the readings draft (renderDraft) — export logged first, print copy, failed log');
  const { document } = makeDom();
  const calls = [], downloads = [];
  let logErr = null;
  const A = { logReportExport: p => { calls.push(['log', p]); return logErr ? err(logErr) : ok({ id: 'l' }); }, errorMessage: e => e.code };
  const listeners = {};
  const w3 = { MarsaI18n: I18N, document, MarsaXlsx: XLSX,
    print: () => { calls.push(['print', !!document.body.querySelector('.fsh-overlay .fsh-draft'), document.body.classList.contains('fsh-open')]); },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter(x => x !== f); },
    MarsaExport: { download: (b, n) => { calls.push(['file', n]); downloads.push(n); return n; }, toCsv: (cols, rows) => '﻿' + rows.length } };
  w3.window = w3;
  const c3 = { window: w3, document, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, Blob: function (p, o) { this.p = p; this.o = o; } };
  vm.createContext(c3);
  vm.runInContext(DICT, c3); vm.runInContext(FSH, c3);
  const host = document.createElement('div'); document.body.appendChild(host);
  const src = rdSrc({ pk: true }); delete src.t;
  const m = w3.MarsaFasahSheet.renderDraft(host, src, { api: A, orgId: ORG, docName: k => 'D:' + k });
  check('rendered inline: lead, print / Excel / CSV, the strip and the 3 numbered sections, common values, conflicts, the draft foot note', () =>
    (m.ready && host.querySelectorAll('[data-fsh-export]').length === 3 && host.querySelectorAll('.fsh-sec').length === 5 && /1 — معلومات البوليصة/.test(host.textContent)
      && /2 — معلومات الفاتورة التجارية/.test(host.textContent) && /3 — معلومات بيان التعبئة/.test(host.textContent) && /الكميات والأوزان كما وردت في البوليصة/.test(host.textContent)
      && /الحاويات والأختام/.test(host.textContent) && /مسودة — قبل إنشاء المعاملة/.test(host.textContent) && /يوجد اختلاف/.test(host.textContent)
      && /قبل إنشاء البيان، ولا تغني عن مراجعة المستندات الأصلية/.test(host.textContent) && !/البيان الجمركي<|col_declaration/.test(host.textContent)) || host.textContent.slice(0, 400));
  btnByText(host, /^Excel$/).click(); await settle(10);
  const log1 = calls.filter(x => x[0] === 'log')[0];
  check('Excel: logged FIRST (fasah_sheet, xlsx, filters {} — no transaction yet, row_count, org), then كشف-إدخال-فسح-مسودة-…xlsx', () =>
    (log1 && calls.indexOf(log1) < calls.findIndex(x => x[0] === 'file') && log1[1].report === 'fasah_sheet' && log1[1].format === 'xlsx' && J(log1[1].filters) === J({})
      && log1[1].row_count === F.rowCount(m) && log1[1].orgId === ORG && /^كشف-إدخال-فسح-مسودة-\d{8}-\d{4}\.xlsx$/.test(downloads[0] || '')) || J(calls));
  btnByText(host, /^CSV$/).click(); await settle(10);
  btnByText(host, /طباعة/).click(); await settle(10);
  const pr = calls.filter(x => x[0] === 'print')[0];
  check('CSV then print: each logged with its format; print shows a copy of the sheet in the overlay (body.fsh-open) — the print CSS of decl.css', () =>
    (calls.filter(x => x[0] === 'log').map(x => x[1].format).join() === 'xlsx,csv,print' && /^كشف-إدخال-فسح-مسودة-\d{8}-\d{4}\.csv$/.test(downloads[1] || '')
      && pr && pr[1] === true && pr[2] === true) || J(calls));
  (listeners.afterprint || []).slice().forEach(f => f());
  check('afterprint removes the print copy', () => (!document.body.querySelector('.fsh-overlay') && !document.body.classList.contains('fsh-open')) || 'still open');
  logErr = 'MRS_FORBIDDEN';
  const nPrint = calls.filter(x => x[0] === 'print').length;
  btnByText(host, /^Excel$/).click(); await settle(10);
  btnByText(host, /طباعة/).click(); await settle(10);
  check('a failed log: no file and no print, the error is shown', () =>
    (downloads.length === 2 && calls.filter(x => x[0] === 'print').length === nPrint && /تعذّر التصدير/.test(host.querySelector('.fsh-status').textContent)) || J(calls.slice(-3)));
  const host2 = document.createElement('div'); document.body.appendChild(host2);
  const src2 = rdSrc({ invLabel: 'كشف-إدخال-فسح-000001-20261101.pdf' }); delete src2.t;
  const m2 = w3.MarsaFasahSheet.renderDraft(host2, src2, { api: A, docName: k => 'D:' + k });
  check('a Fasah entry sheet read as the invoice: a note says it was not used, no sheet and no buttons', () =>
    (!m2.ready && host2.querySelectorAll('.fsh-sec').length === 0 && host2.querySelectorAll('[data-fsh-export]').length === 0
      && /كشف-إدخال-فسح-000001-20261101\.pdf/.test(host2.textContent) && /يبدو كشف إدخال فسح جاهزًا وليس D:invoice/.test(host2.textContent) && /اقرأ المستند الأصلي \(D:invoice\)/.test(host2.textContent)) || host2.textContent);
  const host3 = document.createElement('div'); document.body.appendChild(host3);
  const src3 = rdSrc(); delete src3.t; delete src3.docs.invoice;
  const m3 = w3.MarsaFasahSheet.renderDraft(host3, src3, { api: A, docName: k => 'D:' + k });
  check('only the B/L read: «لم يُقرأ بعد: …» (no sheet)', () => (!m3.ready && /لم يُقرأ بعد: D:invoice/.test(host3.textContent) && !host3.querySelector('.fsh-sec')) || host3.textContent);
}

section('browser fixes — static wiring');
{
  const src = rd('assets/js/decl-review.js');
  check('the B/L refusal line is not added twice (errorLine already shows bl_confirm_needed)', () => !/MRS_DECL_BL_MISMATCH' && !S\.form\.confirmBl\) msg\.appendChild/.test(src) || 'still appended');
  check('ticking the B/L confirmation clears the local B/L refusal', () => /cb\.checked && S\.approveError && S\.approveError\.code === 'MRS_DECL_BL_MISMATCH'/.test(src) || 'missing');
  check('a reading that is not a declaration (MRS_MATCH_DOC_KIND) can be voided by ops staff from the review screen', () => /MRS_MATCH_DOC_KIND' && S\.writer[\s\S]{0,200}void_reading[\s\S]{0,400}API\.voidExtraction\(S\.route\.extraction/.test(src) || 'missing');
  check('void_reading keys in Arabic and English', () => ['void_reading', 'void_reason_prompt', 'void_reason_needed'].every(k => dicts.ar['decl.' + k] && dicts.en['decl.' + k]) || 'missing');
}

(async function () {
  await reviewFlow();
  await uploadFlow();
  await txAndSheetFlow();
  await draftFlow();
  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();

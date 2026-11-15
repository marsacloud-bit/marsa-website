#!/usr/bin/env node
/*
  Marsa (مرسى) — ocr.html «آخر المطابقات المحفوظة»: a click on an item shows a short summary under it — the files read and
  only the differences found (2026-11-15). LOCAL TESTS ONLY: no database, no network.
  usage: node supabase/tests/match-summary-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let nPass = 0, nFail = 0; const fails = [];
const J = x => JSON.stringify(x);
function check(name, fn) {
  try { const r = fn(); if (typeof r === 'string' || !r) { nFail++; fails.push(name + ' — ' + (r || 'false')); console.log('FAIL  ' + name + '\n        ' + r); } else { nPass++; if (!QUIET) console.log('PASS  ' + name); } }
  catch (e) { nFail++; fails.push(name + ' — threw ' + e); console.log('FAIL  ' + name + ' threw ' + (e && e.stack)); }
}
const eq = (name, got, want) => check(name, () => J(got) === J(want) || 'got ' + J(got) + ' want ' + J(want));
let fetchCalls = 0; globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden'); };
const ctx = { window: {}, document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
  Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, RegExp };
ctx.window.window = ctx.window; ctx.window.document = ctx.document;
vm.createContext(ctx);
vm.runInContext(rd('assets/js/ocr-match.js'), ctx, { filename: 'ocr-match.js' });
const P = ctx.window.MarsaOcrMatchPure;
const U1 = 'd7c30000-0000-4000-8000-0000000000a1', U2 = 'd7c30000-0000-4000-8000-0000000000a2', U3 = 'd7c30000-0000-4000-8000-0000000000a3';
const row = (key, status, values, extra) => Object.assign({ key, label_ar: 'ح ' + key, label_en: 'F ' + key, status, values, detail_ar: 'تفصيل ' + key, detail_en: 'detail ' + key }, extra || {});
const M = { invoice_extraction_id: U1, bl_extraction_id: U2.toUpperCase(), declaration_extraction_id: null,
  rows: [row('a', 'match', { invoice: 'X', bl: 'X' }), row('b', 'info', { invoice: null, bl: 'Y' }), row('c', 'missing', { invoice: null, bl: 'Z' }),
    row('d', 'partial', { invoice: 'P1', bl: 'P2' }), row('e', 'mismatch', { invoice: 'A', bl: 'B' }), row('f', 'mismatch', { invoice: 'C', bl: 'D' }, { critical: true }),
    row('g', 'partial', { invoice: [{ desc: 'x' }, 'y'], bl: 'line\n  two' })] };
const N = [{ id: U1, doc_type: 'invoice', source_name: 'inv.pdf', source_pages: 2 }, { id: U2, doc_type: 'bill_of_lading', source_name: 'bl.jpg', source_pages: null }];

check('MarsaOcrMatchPure.savedSummary exists', () => typeof P.savedSummary === 'function');
const S = P.savedSummary(M, N);
eq('files: slot order, names joined by id (case-insensitive), pages', S.files, [{ doc: 'invoice', name: 'inv.pdf', pages: 2 }, { doc: 'bl', name: 'bl.jpg', pages: null }]);
eq('diffs: only mismatch / partial / missing — critical first within a status, then saved order', S.diffs.map(d => d.key + ':' + d.status), ['f:mismatch', 'e:mismatch', 'd:partial', 'g:partial', 'c:missing']);
eq('diff values per file as short text (objects / arrays / whitespace)', S.diffs.find(d => d.key === 'g').values, { invoice: '{"desc":"x"}، y', bl: 'line two' });
eq('diff carries labels / detail / critical', (({ label_ar, label_en, detail_ar, critical }) => ({ label_ar, label_en, detail_ar, critical }))(S.diffs[0]),
  { label_ar: 'ح f', label_en: 'F f', detail_ar: 'تفصيل f', critical: true });
eq('missing value → empty text', S.diffs.find(d => d.key === 'c').values.invoice, '');
eq('names missing → files without name', P.savedSummary(M, null).files.map(f => f.name), ['', '']);
eq('null match → empty summary', P.savedSummary(null, N), { files: [], diffs: [] });
eq('no differences → []', P.savedSummary({ invoice_extraction_id: U1, bl_extraction_id: U3, rows: [row('a', 'match', {}), row('b', 'info', {})] }, []).diffs, []);
check('a long value is cut to 160 characters', () => P.savedSummary({ invoice_extraction_id: U1, bl_extraction_id: U2, rows: [row('x', 'mismatch', { invoice: 'q'.repeat(400), bl: '' })] }, []).diffs[0].values.invoice.length === 160);

const SU = rd('assets/js/supa.js');
check('supa.listExtractionNames: only id / doc_type / source_name / source_pages, .in(id), ≤10 uuids, exported', () =>
  (/select\('id,doc_type,source_name,source_pages'\)\.in\('id', list\)/.test(SU) && /filter\(isUuid\)\.slice\(0, 10\)/.test(SU) && /listExtractionNames: listExtractionNames/.test(SU)) || 'missing');
const I = rd('assets/i18n/ocr.js');
check('labels: mx_rs_* in Arabic and English', () => {
  const keys = ['mx_rs_hint', 'mx_rs_loading', 'mx_rs_files', 'mx_rs_noname', 'mx_rs_pages', 'mx_rs_diffs', 'mx_rs_none', 'mx_rs_critical', 'mx_rs_open_full'];
  const n = k => (I.match(new RegExp('\\b' + k + ': \'', 'g')) || []).length;
  return keys.every(k => n(k) === 2) || J(keys.map(n));
});
check('ocr.css: summary styles', () => /\.ocr-mx-rs \{/.test(rd('assets/css/pages/ocr.css')) && /\.ocr-mx-rs-diffs li\.is-mismatch/.test(rd('assets/css/pages/ocr.css')));

console.log('\n' + '-'.repeat(70));
if (fetchCalls) { nFail++; fails.push('network: ' + fetchCalls); }
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
process.exit(nFail ? 1 : 0);

#!/usr/bin/env node
/*
  Marsa (مرسى) — ocr.html «آخر المطابقات المحفوظة»: a saved match opens its review again (ocr.html#match=<id>), 2026-11-15.
  LOCAL TESTS ONLY. No database, no network (fetch throws). ocr-match.js runs in a vm without a DOM (its pure helpers).

  Covers: parseMatchId (only #match=<uuid>, lower-cased; #match-tx= is not taken), matchLink; noteOfSaved (drops only the
  check-level line savedNote() appends); savedMatchIds (the 2–4 readings, bad ids skipped); savedDiff (equal → null, any
  overall / count change → saved vs now); the page wiring (routeHash handles #match= before #match-tx=, openSavedMatch loads
  getDocumentMatch + getExtraction per reading, compareReadings with saved:true and the saved date, restores ticks / note /
  transaction, marks the list item); labels in Arabic and English; the CSS for the link / current item.

  usage:
    node supabase/tests/saved-match-open-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
const J = x => JSON.stringify(x);
function check(name, fn) {
  try { const r = fn(); if (typeof r === 'string') fail(name, r); else if (!r) fail(name, 'assertion false'); else pass(name); }
  catch (e) { fail(name, 'threw: ' + (e && e.stack || e)); }
}
const eq = (name, got, want) => check(name, () => J(got) === J(want) || 'got ' + J(got) + ' want ' + J(want));
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden'); };

const ctx = { window: {}, document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
  Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, RegExp };
ctx.window.window = ctx.window; ctx.window.document = ctx.document;
vm.createContext(ctx);
vm.runInContext(rd('assets/js/ocr-match.js'), ctx, { filename: 'ocr-match.js' });
const P = ctx.window.MarsaOcrMatchPure;
const U1 = 'd7c30000-0000-4000-8000-000000000001', U2 = 'd7c30000-0000-4000-8000-000000000002',
  U3 = 'd7c30000-0000-4000-8000-000000000003', U4 = 'd7c30000-0000-4000-8000-000000000004';

check('MarsaOcrMatchPure exposes the five helpers', () =>
  !!P && ['parseMatchId', 'matchLink', 'noteOfSaved', 'savedMatchIds', 'savedDiff'].every(k => typeof P[k] === 'function') || 'missing');

eq('parseMatchId: #match=<uuid> (with / without #, upper → lower); anything else → null',
  [P.parseMatchId('#match=' + U1), P.parseMatchId('match=' + U1.toUpperCase()), P.parseMatchId('#match-tx=' + U1), P.parseMatchId('#match=' + U1 + '&x=1'),
    P.parseMatchId('#match=nope'), P.parseMatchId(''), P.parseMatchId(null)],
  [U1, U1, null, null, null, null, null]);
eq('parseMatchTx does not take #match=<uuid> (the two routes stay apart)', P.parseMatchTx('#match=' + U1), null);
eq('matchLink: #match=<id lower>; a bad id → empty', [P.matchLink(U1.toUpperCase()), P.matchLink('x'), P.matchLink(null)], ['#match=' + U1, '', '']);
eq('matchLink round-trips through parseMatchId', P.parseMatchId(P.matchLink(U2)), U2);

eq('noteOfSaved: drops the check-level line only; keeps other bracketed text; null → empty',
  [P.noteOfSaved('راجعت الوزن\n[مستوى التدقيق: تدقيق شديد]'), P.noteOfSaved('[مستوى التدقيق: تدقيق شديد]'), P.noteOfSaved('سطر [ليس آخر] هنا'),
    P.noteOfSaved('أول\n[ملاحظة]\nآخر'), P.noteOfSaved(null), P.noteOfSaved('  نص  ')],
  ['راجعت الوزن', '', 'سطر [ليس آخر] هنا', 'أول\n[ملاحظة]\nآخر', '', 'نص']);

eq('savedMatchIds: invoice + B/L (+ declaration, + packing) in slot order; null / bad ids skipped',
  [P.savedMatchIds({ invoice_extraction_id: U1, bl_extraction_id: U2 }),
    P.savedMatchIds({ invoice_extraction_id: U1, bl_extraction_id: U2, declaration_extraction_id: U3, packing_extraction_id: U4 }),
    P.savedMatchIds({ invoice_extraction_id: U1, bl_extraction_id: 'bad', declaration_extraction_id: null }), P.savedMatchIds(null)],
  [[['invoice', U1], ['bl', U2]], [['invoice', U1], ['bl', U2], ['declaration', U3], ['packing', U4]], [['invoice', U1]], []]);

const C = (m, p, x, mm) => ({ match: m, partial: p, missing: x, mismatch: mm });
eq('savedDiff: same overall + counts → null', P.savedDiff({ overall: 'mismatch', counts: C(5, 1, 2, 3) }, { overall: 'mismatch', counts: C(5, 1, 2, 3) }), null);
eq('savedDiff: a count changed → saved vs now text',
  P.savedDiff({ overall: 'mismatch', counts: C(5, 1, 2, 3) }, { overall: 'mismatch', counts: C(6, 1, 2, 2) }), { saved: 'mismatch 5/1/2/3', now: 'mismatch 6/1/2/2' });
eq('savedDiff: overall changed', P.savedDiff({ overall: 'review', counts: C(1, 0, 0, 0) }, { overall: 'match', counts: C(1, 0, 0, 0) }),
  { saved: 'review 1/0/0/0', now: 'match 1/0/0/0' });
eq('savedDiff: missing input → null', [P.savedDiff(null, {}), P.savedDiff({}, null)], [null, null]);

/* page wiring (the code path the browser runs) */
const M = rd('assets/js/ocr-match.js');
const fnBody = name => { const a = M.indexOf('function ' + name + '('); if (a < 0) return ''; const b = M.indexOf('\n    }\n', a); return M.slice(a, b); };
check('routeHash: #match=<id> first (opens unless that match is already on screen), then #match-tx', () => {
  const b = fnBody('routeHash');
  return (b.indexOf('parseMatchId') >= 0 && b.indexOf('parseMatchId') < b.indexOf('parseMatchTx') && /openSavedMatch\(id\)/.test(b)
    && /S\.saved\.match\.id === id && S\.result/.test(b)) || b;
});
check('openSavedMatch: getDocumentMatch → getExtraction per reading → readingOf → compareReadings(saved, saved date, org)', () => {
  const b = fnBody('openSavedMatch');
  return (/API\.getDocumentMatch\(id\)/.test(b) && /P\.savedMatchIds\(m\)/.test(b) && /API\.getExtraction\(x\[1\]\)/.test(b) && /P\.readingOf\(e\.data, x\[0\]\)/.test(b)
    && /compareReadings\(x\.entries, \{ saved: true, readAt: m\.created_at/.test(b) && /seq !== smSeq/.test(b)) || 'missing steps';
});
check('openSavedMatch: restores the saved match id / status, ticks (only rows that exist), note, transaction; warns when voided / different', () => {
  const b = fnBody('openSavedMatch');
  return (/S\.saved\.match = \{ id: m\.id/.test(b) && /keys\[k\]\) S\.reviewed\[k\] = true/.test(b) && /P\.noteOfSaved\(m\.status === .reviewed. && m\.review_note \? m\.review_note : m\.note\)/.test(b)
    && /sel\.value = m\.transaction_id/.test(b) && /mx_sm_voided/.test(b) && /P\.savedDiff\(m, S\.result\)/.test(b) && /markRecent\(\)/.test(b)) || 'missing restore';
});
check('openSavedMatch needs getDocumentMatch + getExtraction (feature-detected) and staff online', () =>
  /has\('getDocumentMatch'\) \|\| !has\('getExtraction'\)/.test(fnBody('openSavedMatch')) || 'no guard');
check('recentItem: the title is a link to #match=<id> (re-click on the same hash reopens), data-match-id for the mark', () => {
  const b = fnBody('recentItem');
  return (/P\.matchLink\(m\.id\)/.test(b) && /a\.href = href/.test(b) && /openSavedMatch\(m\.id\)/.test(b) && /data-match-id/.test(b)) || 'missing link';
});
check('loadRecent marks the open match; markRecent sets is-current + aria-current', () =>
  (/markRecent\(\);/.test(fnBody('loadRecent')) && /is-current/.test(fnBody('markRecent')) && /aria-current/.test(fnBody('markRecent'))) || 'missing');

const I = rd('assets/i18n/ocr.js');
check('labels: the 7 mx_sm_* keys in Arabic and English, placeholders kept', () => {
  const keys = ['mx_sm_open_hint', 'mx_sm_loaded', 'mx_sm_changed', 'mx_sm_voided', 'mx_sm_st_voided', 'mx_sm_missing', 'mx_sm_failed'];
  const n = k => (I.match(new RegExp('\\b' + k + ': \'', 'g')) || []).length;
  const ph = (I.match(/mx_sm_loaded: '[^']*\{date\}[^']*\{tx\}[^']*\{status\}/g) || []).length === 2
    && (I.match(/mx_sm_changed: '[^']*\{saved\}[^']*\{now\}/g) || []).length === 2;
  return (keys.every(k => n(k) === 2) && ph) || J(keys.map(n).concat([ph]));
});
check('ocr.css: link + current item styles', () => {
  const c = rd('assets/css/pages/ocr.css');
  return (/\.ocr-mx-recent-open \{/.test(c) && /\.ocr-history li\.is-current \{/.test(c)) || 'missing css';
});

console.log('\n' + '-'.repeat(70));
if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
process.exit(nFail ? 1 : 0);

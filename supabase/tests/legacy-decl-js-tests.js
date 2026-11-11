#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 4, the browser / Edge helpers (no database): the Umm al-Qura Hijri converter
  (assets/js/legacy-norm.js MarsaNorm and its copy in supabase/functions/ai-extract/extract.js), its use in
  assets/js/ocr-parse.js normalizeDate, the graceful fallback when the runtime has no Umm al-Qura calendar, and the B/L
  token equivalence of assets/js/doc-match.js (legacy billReferenceEquivalent_, = SQL app.bl_equivalent).
  LOCAL TESTS ONLY. No network.

  usage: node supabase/tests/legacy-decl-js-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const MN = require(path.join(ROOT, 'assets', 'js', 'legacy-norm.js'));
const DM = require(path.join(ROOT, 'assets', 'js', 'doc-match.js'));
const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
const X = require(path.join(ROOT, 'supabase', 'functions', 'ai-extract', 'extract.js'));

let nPass = 0, nFail = 0;
const fails = [];
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.message); }
  if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
  else { nFail++; fails.push(name + ' — ' + r); console.log('FAIL  ' + name + '\n        ' + r); }
}
const J = x => JSON.stringify(x);
globalThis.fetch = () => { throw new Error('network forbidden'); };

// known Umm al-Qura dates (official Umm al-Qura calendar)
const KNOWN = [
  ['1447/01/01', '2025-06-26'],   // 1 Muharram 1447
  ['1446/09/01', '2025-03-01'],   // 1 Ramadan 1446
  ['1446/10/01', '2025-03-30'],   // 1 Shawwal 1446 (Eid al-Fitr)
  ['1446/12/10', '2025-06-06'],   // 10 Dhu al-Hijjah 1446 (Eid al-Adha)
  ['1445/01/01', '2023-07-19'],   // 1 Muharram 1445
  ['1447/03/15', '2025-09-07'],
  ['1448/01/01', '2026-06-16']    // 1 Muharram 1448
];

console.log('\n== 1. Umm al-Qura converter (MarsaNorm, extract.js copy)');
check('the runtime has the islamic-umalqura calendar (Node ICU)', () => MN.hijriSupported() === true && X.hijriSupported() === true || 'no calendar');
check('known dates: Hijri → Gregorian (' + KNOWN.length + ' dates) in MarsaNorm and extract.js', () => {
  const bad = KNOWN.filter(([h, g]) => MN.hijriToGregorian(h) !== g || X.hijriToGregorian(h) !== g);
  return bad.length === 0 || J(bad.map(([h, g]) => [h, g, MN.hijriToGregorian(h), X.hijriToGregorian(h)]));
});
check('known dates: Gregorian → Hijri (MarsaNorm.gregorianToHijri) round-trips', () => {
  const bad = KNOWN.filter(([h, g]) => MN.gregorianToHijri(g) !== h);
  return bad.length === 0 || J(bad);
});
check('accepted forms: Arabic / Persian digits, d/m/yyyy, separators, هـ / AH; out of range (year 1300–1700, month 1–12, day 1–30) → \'\'', () => {
  const ok = ['١٥/٣/١٤٤٧', '۱۴۴۷/۰۳/۱۵', '15-3-1447', '1447.3.15', '1447/03/15 هـ', '15/03/1447هـ', '1447/3/15 AH'].every(v => MN.normalizeHijri(v) === '1447/03/15' && X.normalizeHijri(v) === '1447/03/15');
  const no = ['1299/12/30', '1701/01/01', '1447/13/01', '1447/01/31', '2025-09-07', ''].every(v => MN.normalizeHijri(v) === '' && X.normalizeHijri(v) === '');
  return (ok && no) || 'forms';
});
check('a day 30 that the month does not have → \'\' (verified hit, never the next month)', () => {
  // Safar 1447 has 29 days in Umm al-Qura (1 Rabi I 1447 = 2025-08-24)
  return (MN.hijriToGregorian('1447/03/01') === '2025-08-24' && MN.hijriToGregorian('1447/02/30') === '' && X.hijriToGregorian('1447/02/30') === '') || J([MN.hijriToGregorian('1447/03/01'), MN.hijriToGregorian('1447/02/30')]);
});
check('graceful fallback: without the Umm al-Qura calendar (Intl.DateTimeFormat throws) the converter returns \'\' and hijriSupported() false', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'legacy-norm.js'), 'utf8');
  const sandbox = { Intl: { DateTimeFormat: function () { throw new RangeError('no calendar'); } }, module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  const N = sandbox.module.exports;
  const xsrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'ai-extract', 'extract.js'), 'utf8');
  const xs = { Intl: { DateTimeFormat: function () { return { resolvedOptions: () => ({ calendar: 'gregory' }), formatToParts: () => [] }; } }, module: { exports: {} }, TextEncoder, TextDecoder, Buffer, console };
  xs.globalThis = xs;
  vm.runInNewContext(xsrc, xs);
  const XX = xs.module.exports;
  return (N.hijriSupported() === false && N.hijriToGregorian('1447/03/15') === '' && N.normalizeHijri('1447/03/15') === '1447/03/15'
    && XX.hijriSupported() === false && XX.hijriToGregorian('1447/03/15') === '') || 'fallback';
});

console.log('\n== 2. ocr-parse.js normalizeDate uses the converter');
check('Hijri with a marker or a Hijri-range year → the Umm al-Qura Gregorian date; Gregorian unchanged', () => {
  const r = { a: P.normalizeDate('15/03/1447هـ'), b: P.normalizeDate('1447/01/01'), c: P.normalizeDate('١٤٤٦/٠٩/٠١ هـ'), d: P.normalizeDate('2026-10-15'),
    e: P.normalizeDate('15/10/2026'), f: P.normalizeDate('Oct 15, 2026'), g: P.normalizeDate('1447/02/30 هـ'), h: P.normalizeDate('1447هـ') };
  return (r.a === '2025-09-07' && r.b === '2025-06-26' && r.c === '2025-03-01' && r.d === '2026-10-15' && r.e === '2026-10-15' && r.f === '2026-10-15'
    && r.g === '' && r.h === '') || J(r);
});
check('a date pair «الموافق»: the first date found is used (the Hijri one, converted)', () => {
  const r = P.normalizeDate('01/01/1447هـ الموافق 26/06/2025م');
  return r === '2025-06-26' || r;
});

console.log('\n== 3. B/L equivalence (doc-match.js, legacy billReferenceEquivalent_)');
const CASES = [['MEDU 123456', '123456MEDU', true], ['MEDU123456', 'medu-123456', true], ['MEDU 123 456', '456 MEDU 123', true], ['ABC123', 'ABC124', false],
  ['MEDU١٢٣', '123 MEDU', true], ['ABC123', 'ABC123X', false], ['', 'ABC', false], [null, null, false], ['شحنة', 'بضاعة', false],
  ['HLCU-JEA-2501234', '2501234 JEA HLCU', true], ['SHA/1234', '1234 SHA 1', false], ['abc 12', 'ABC 12', true]];
check('blEquivalent: ' + CASES.length + ' cases (any token order, Arabic digits, separators, case; token-less texts never match)', () => {
  const bad = CASES.filter(([a, b, w]) => DM.blEquivalent(a, b) !== w || DM.blEquivalent(b, a) !== w);
  return bad.length === 0 || J(bad);
});
check('blTokens: letter / digit runs, upper case, western digits, sorted', () => J(DM.blTokens('medu-١٢ ab 3')) === J(['12', '3', 'AB', 'MEDU']) || J(DM.blTokens('medu-١٢ ab 3')));
check('doc-match.js stays ES5 (no arrow functions / let / const / template literals in the new helpers)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'doc-match.js'), 'utf8');
  const part = src.slice(src.indexOf('function blSearchKey'), src.indexOf('  return {\n    VERSION'));
  return (part.length > 100 && !/=>|\blet\b|\bconst\b|`/.test(part)) || 'not ES5';
});

console.log('\n' + '-'.repeat(70));
if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('OK — ' + nPass + ' passed, 0 failed');

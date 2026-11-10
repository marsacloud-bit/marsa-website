#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy value normalisation tests: assets/js/legacy-norm.js (window.MarsaNorm).
  Pure Node, no database, no network, no dependencies.

  Covers: the classic-script wrapper (vm + window shim), ES5 / purity of the source; Arabic folding
  (legacy normalizeSearch_, app.norm_name mirror); Hijri normalisation (Arabic / Persian digits,
  d/m/yyyy, separators, legacy JS-date text, Date cells, ranges); Umm al-Qura conversion (official
  fixed dates, binary search == the legacy linear scan, round trips across 1300-1700, day 30 of a
  29-day month, unsupported runtime); declaration status (Fasah stages → codes) and type; TAS;
  Saudi phones; chassis; containers (compact / display / ISO 6346); the 7 approved ports; the
  15-agent dictionary and legal-suffix stripping; transaction domains; robustness and determinism.

  usage:  node supabase/tests/legacy-norm-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const FILE = path.join(ROOT, 'assets', 'js', 'legacy-norm.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const J = JSON.stringify;

// load exactly as a browser would: a classic script with a window object
const win = {};
const ctx = { window: win, Intl: Intl, Date: Date, Math: Math, String: String, Object: Object, parseInt: parseInt, isFinite: isFinite, isNaN: isNaN };
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: 'legacy-norm.js' });
const M = win.MarsaNorm;

let pass = 0, fail = 0;
const fails = [];
let sec = '';
function section(t) { sec = t; if (!QUIET) console.log('\n== ' + t); }
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }
const VEC = {}; // fn → [input, expected] pairs (single text argument) reused by the SQL parity section
function table(fnName, rows) {
  rows.forEach(r => { if (r.length === 2 && (r[0] === null || typeof r[0] === 'string')) (VEC[fnName] = VEC[fnName] || []).push(r[0]); });
  rows.forEach(r => eq(fnName + '(' + J(r[0]) + (r.length > 2 ? ', ' + J(r[2]) : '') + ')', M[fnName].apply(null, [r[0]].concat(r.length > 2 ? [r[2]] : [])), r[1])); }

/* ================================================================ wrapper */
section('wrapper / source');
check('classic script sets window.MarsaNorm', () => !!(M && typeof M.normTas === 'function' && M.VERSION === 'norm-v1') || 'missing');
check('Node require gives the same API', () => {
  const N = require(FILE);
  return J(Object.keys(N).sort()) === J(Object.keys(M).sort()) || 'keys differ';
});
check('API surface', () => {
  const want = ['hijriToGregorian', 'gregorianToHijri', 'normalizeHijri', 'normDeclarationStatus', 'normDeclarationType',
    'normShippingAgentShort', 'normChassis', 'normTas', 'normSaPhone', 'normContainerNo', 'formatContainerNo', 'normPortCode',
    'searchKey', 'foldArabic', 'normName', 'western', 'isHijriFormat', 'isValidHijri', 'hijriSupported'];
  const miss = want.filter(k => typeof M[k] !== 'function');
  return !miss.length || miss.join(',');
});
check('source: no DOM / network / eval / storage', () => !/document\.|fetch\(|XMLHttpRequest|eval\(|new Function|innerHTML|localStorage|sessionStorage/.test(SRC) || 'impure');
check('source: ES5 style (no let/const/arrow/class/template literals)', () => {
  const s = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return !/\b(let|const|class)\s|=>|`/.test(s) || 'es6 syntax';
});
check('source: no String.prototype.padStart / includes / Array.from (old browsers)', () => !/\.padStart\(|\.includes\(|Array\.from|Object\.assign/.test(SRC) || 'es2015+ builtins');
check('source: header documents the shared SQL spec', () => ['app.norm_declaration_status', 'app.norm_tas', 'app.norm_sa_phone', 'app.norm_chassis'].every(k => SRC.indexOf(k) !== -1) || 'spec');
check('Umm al-Qura is supported in this runtime', () => M.hijriSupported() === true || 'no umalqura');

/* ================================================================ text */
section('Arabic folding');
table('western', [['٠١٢٣٤٥٦٧٨٩', '0123456789'], ['۰۱۲۳۴۵۶۷۸۹', '0123456789'], ['A١B۲', 'A1B2'], [null, ''], [12, '12']]);
table('searchKey', [
  ['أحمد', 'احمد'], ['إبراهيم', 'ابراهيم'], ['آمنة', 'امنه'], ['مستشفى', 'مستشفي'], ['  فسح  كلي ', 'فسحكلي'],
  ['T.S. Lines', 'tslines'], ['Hapag-Lloyd', 'hapaglloyd'], ['a_b/c\\d', 'abcd'], ['ABC', 'abc'], [null, ''], ['', ''],
  ['جاهز لطباعة إشعار الفسح الإلكتروني', 'جاهزلطباعهاشعارالفسحالالكتروني']
]);
table('foldArabic', [
  ['مُحَمَّد', 'محمد'], ['شـركة', 'شركه'], ['مؤسسة', 'موسسه'], ['هيئة', 'هييه'], ['  جدة   الإسلامي ', 'جده الاسلامي'], ['ABC ١٢', 'abc 12'], [undefined, '']
]);
table('normName', [
  ['شركة مرسى للتجارة', 'مرسي للتجاره'], ['Marsa Trading Co. Ltd.', 'marsa trading'], ['مؤسسة الأمل', 'الامل'],
  ['ABC LLC', 'abc'], ['  ', ''], [null, ''], ['شركة', ''], ['Al-Noor Est.', 'al noor'], ['محمد ٣', 'محمد 3'], ['Company Limited', '']
]);

/* ================================================================ Hijri normalisation */
section('normalizeHijri');
table('normalizeHijri', [
  ['1447/03/15', '1447/03/15'], ['1447/3/5', '1447/03/05'], ['1447-03-15', '1447/03/15'], ['1447.03.15', '1447/03/15'],
  ['15/03/1447', '1447/03/15'], ['5/3/1447', '1447/03/05'], ['15-3-1447', '1447/03/15'], ['١٤٤٧/٠٣/١٥', '1447/03/15'],
  ['۱۴۴۷/۰۳/۱۵', '1447/03/15'], ['١٥/٣/١٤٤٧', '1447/03/15'], [' 1447 / 03 / 15 ', '1447/03/15'], ['1447/03/15 هـ', '1447/03/15'],
  ['1447/03/15هـ', '1447/03/15'], ['1447/03/15 ه', '1447/03/15'], ['1447/03/15 AH', '1447/03/15'],
  ['1300/01/01', '1300/01/01'], ['1700/12/30', '1700/12/30'], ['1299/12/30', ''], ['1701/01/01', ''], ['1447/13/01', ''],
  ['1447/00/10', ''], ['1447/01/00', ''], ['1447/01/31', ''], ['1447/01', ''], ['1447/01/01/01', ''], ['abc', ''], ['', ''],
  [null, ''], [undefined, ''], ['2025-09-07', ''], ['07/09/2025', ''], ['14470315', ''], ['147/03/15', ''], ['1447/003/15', ''],
  ['Thu Jun 03 1447 00:00:00 GMT+0300 (Arabian Standard Time)', '1447/06/03'], ['Sun Jan 1 1446 00:00:00 GMT+0300', '1446/01/01'],
  ['Dec 30 1446', '1446/12/30'], ['Thu Jun 31 1447 00:00:00', ''], ['Thu Jun 03 2025 00:00:00 GMT+0300', ''], ['sat feb 29 1445', '1445/02/29']
]);
check('Date cell with a Hijri year (sheet stored 1447 as a Gregorian year)', () => M.normalizeHijri(new Date(Date.UTC(1447, 2, 14, 21))) === '1447/03/15' || M.normalizeHijri(new Date(Date.UTC(1447, 2, 14, 21))));
check('Date cell with a modern year → ""', () => M.normalizeHijri(new Date(Date.UTC(2025, 8, 7))) === '');
check('invalid Date → ""', () => M.normalizeHijri(new Date(NaN)) === '');
table('isHijriFormat', [['1447/03/15', true], ['1447/3/15', false], ['1299/01/01', false], ['1447/12/30', true], ['', false], [null, false]]);
// the SQL CHECK the other half of step 1 writes: ^\d{4}/\d{2}/\d{2}$ with year 1300-1700, month 1-12, day 1-30
check('every normalised value satisfies the declaration_date_hijri CHECK', () => {
  const bad = [];
  ['1447/3/5', '5/3/1447', '١٤٤٧-٠٣-٠٥', '1300/1/1', '1700/12/30', 'Thu Jun 03 1447'].forEach(v => {
    const n = M.normalizeHijri(v);
    const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(n);
    if (!m || +m[1] < 1300 || +m[1] > 1700 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 30) bad.push(v + '→' + n);
  });
  return !bad.length || bad.join(' ');
});

/* ================================================================ Umm al-Qura */
section('Umm al-Qura conversion');
// official Umm al-Qura calendar dates
const FIXED = [
  ['1446/01/01', '2024-07-07'], ['1445/09/01', '2024-03-11'], ['1445/10/01', '2024-04-10'], ['1446/09/01', '2025-03-01'],
  ['1446/10/01', '2025-03-30'], ['1446/12/10', '2025-06-06'], ['1447/01/01', '2025-06-26'], ['1445/01/01', '2023-07-19'],
  ['1444/09/01', '2023-03-23'], ['1444/10/01', '2023-04-21'], ['1443/09/01', '2022-04-02'], ['1440/01/01', '2018-09-11'],
  ['1442/01/01', '2020-08-20'], ['1420/01/01', '1999-04-17'], ['1448/05/30', '2026-11-10']
];
FIXED.forEach(r => {
  eq('hijriToGregorian(' + r[0] + ')', M.hijriToGregorian(r[0]), r[1]);
  eq('gregorianToHijri(' + r[1] + ')', M.gregorianToHijri(r[1]), r[0]);
});
table('hijriToGregorian', [
  ['١٤٤٦/٠١/٠١', '2024-07-07'], ['1/1/1446', '2024-07-07'], ['1446-1-1', '2024-07-07'], ['1446/01/01 هـ', '2024-07-07'],
  ['', ''], [null, ''], ['abc', ''], ['1299/12/29', ''], ['1701/01/01', ''], ['1447/13/01', ''], ['2024-07-07', '']
]);
table('gregorianToHijri', [
  ['2024-07-07', '1446/01/01'], ['2024/07/07', '1446/01/01'], ['07/07/2024', '1446/01/01'], ['7-7-2024', '1446/01/01'],
  ['٢٠٢٤-٠٧-٠٧', '1446/01/01'], ['2024-07-07T10:00:00Z', '1446/01/01'], ['2024-02-30', ''], ['2023-02-29', ''], ['2024-13-01', ''],
  ['', ''], [null, ''], ['abc', ''], ['1800-01-01', ''], ['2300-01-01', '']
]);
check('Date object is read as the Asia/Riyadh calendar day', () => {
  const a = M.gregorianToHijri(new Date(Date.UTC(2024, 6, 6, 21, 30))); // 00:30 on 7 Jul in Riyadh
  const b = M.gregorianToHijri(new Date(Date.UTC(2024, 6, 6, 20, 30))); // 23:30 on 6 Jul in Riyadh
  return (a === '1446/01/01' && b === '1445/12/30') || J([a, b]);
});
check('a timestamp number is accepted', () => M.gregorianToHijri(Date.UTC(2024, 6, 7, 9)) === '1446/01/01' || M.gregorianToHijri(Date.UTC(2024, 6, 7, 9)));
check('invalid Date → ""', () => M.gregorianToHijri(new Date(NaN)) === '');

// the legacy convertHijriToGregorianUmmAlQura_ (linear scan over 1100 days from Jan 1 of approx year - 1)
const LEGACY_FMT = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Riyadh' });
function legacyH2G(y, m, d) {
  const approximateYear = Math.floor(y * 0.970224 + 621.5774);
  const start = Date.UTC(approximateYear - 1, 0, 1, 12);
  for (let i = 0; i < 1100; i += 1) {
    const date = new Date(start + i * 86400000);
    const v = {};
    LEGACY_FMT.formatToParts(date).forEach(p => { if (p.type === 'year' || p.type === 'month' || p.type === 'day') v[p.type] = Number(p.value); });
    if (v.year === y && v.month === m && v.day === d) {
      const r = new Date(date.getTime() + 3 * 3600000);
      return r.getUTCFullYear() + '-' + String(r.getUTCMonth() + 1).padStart(2, '0') + '-' + String(r.getUTCDate()).padStart(2, '0');
    }
  }
  return '';
}
let seed = 1447;
function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; }
const SAMPLES = [];
for (let i = 0; i < 160; i++) SAMPLES.push([1300 + rnd(401), 1 + rnd(12), 1 + rnd(30)]);
[[1300, 1, 1], [1700, 12, 29], [1446, 12, 30], [1445, 12, 30], [1446, 9, 30], [1446, 8, 30], [1600, 1, 1], [1356, 5, 30], [1500, 6, 15]].forEach(x => SAMPLES.push(x));
SAMPLES.forEach(s => {
  const h = String(s[0]) + '/' + String(s[1]).padStart(2, '0') + '/' + String(s[2]).padStart(2, '0');
  eq('binary search == legacy scan ' + h, M.hijriToGregorian(h), legacyH2G(s[0], s[1], s[2]));
});
check('day 30 of a 29-day month → "" and isValidHijri false', () => {
  // find a 29-day month in 1446 from the calendar itself
  for (let m = 1; m <= 12; m++) {
    const h = '1446/' + String(m).padStart(2, '0') + '/30';
    const next = m === 12 ? '1447/01/01' : '1446/' + String(m + 1).padStart(2, '0') + '/01';
    const g29 = M.hijriToGregorian('1446/' + String(m).padStart(2, '0') + '/29');
    const gNext = M.hijriToGregorian(next);
    if ((Date.parse(gNext) - Date.parse(g29)) === 86400000) return (M.hijriToGregorian(h) === '' && M.isValidHijri(h) === false) || h;
  }
  return 'no 29-day month found';
});
// round trips: every 37th day from 1882-11-12 (1300/01/01) to 2271 + every day of 2024-2026
(function () {
  const start = Date.parse('1882-11-12T00:00:00Z'), end = Date.parse('2271-12-03T00:00:00Z');
  let n = 0, bad = [];
  for (let t = start; t <= end; t += 37 * 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const h = M.gregorianToHijri(iso);
    if (!h || M.hijriToGregorian(h) !== iso) bad.push(iso + '→' + h);
    n++;
  }
  check('round trip Gregorian→Hijri→Gregorian on ' + n + ' days over 1300-1700', () => !bad.length || bad.slice(0, 5).join(' '));
  for (let y = 2024; y <= 2026; y++) {
    for (let mo = 0; mo < 12; mo++) {
      bad = [];
      for (let d = 1; d <= 31; d++) {
        const dt = new Date(Date.UTC(y, mo, d));
        if (dt.getUTCMonth() !== mo) break;
        const iso = dt.toISOString().slice(0, 10);
        const h = M.gregorianToHijri(iso);
        if (!h || M.hijriToGregorian(h) !== iso) bad.push(iso + '→' + h);
      }
      check('round trip every day of ' + y + '-' + String(mo + 1).padStart(2, '0'), () => !bad.length || bad.join(' '));
    }
  }
})();
check('Hijri days are consecutive (no gap / no repeat) across 1446-1447', () => {
  let prev = null, t = Date.parse('2024-07-07T00:00:00Z');
  for (let i = 0; i < 720; i++, t += 86400000) {
    const h = M.gregorianToHijri(new Date(t).toISOString().slice(0, 10));
    const p = h.split('/').map(Number);
    if (prev) {
      const ok = (p[0] === prev[0] && p[1] === prev[1] && p[2] === prev[2] + 1) ||
        (p[2] === 1 && prev[2] >= 29 && ((p[1] === prev[1] + 1 && p[0] === prev[0]) || (p[1] === 1 && prev[1] === 12 && p[0] === prev[0] + 1)));
      if (!ok) return J([prev, p]);
    }
    prev = p;
  }
  return true;
});
check('runtime without Umm al-Qura → "" (no wrong civil fallback)', () => {
  const fakeIntl = { DateTimeFormat: function () { return { resolvedOptions: () => ({ calendar: 'gregory' }), formatToParts: () => [] }; } };
  const w = {}; const c = { window: w, Intl: fakeIntl }; vm.createContext(c); vm.runInContext(SRC, c);
  return (w.MarsaNorm.hijriSupported() === false && w.MarsaNorm.hijriToGregorian('1446/01/01') === '' && w.MarsaNorm.gregorianToHijri('2024-07-07') === ''
    && w.MarsaNorm.normalizeHijri('1446/1/1') === '1446/01/01') || 'fallback';
});
check('runtime without Intl at all → ""', () => {
  const w = {}; const c = { window: w }; vm.createContext(c); vm.runInContext('var Intl = undefined;\n' + SRC, c);
  return (w.MarsaNorm.hijriSupported() === false && w.MarsaNorm.hijriToGregorian('1446/01/01') === '') || 'no intl';
});

/* ================================================================ declaration status / type */
section('declaration status (Fasah stages)');
table('normDeclarationStatus', [
  ['قبول البيان ـ مرحلة تفتيش ومعاينة البضاعة', 'accepted'], ['قبول البيان', 'accepted'], ['مرحلة تفتيش ومعاينة البضاعة', 'accepted'],
  ['تفتيش ومعاينة', 'accepted'], ['تم قبول البيان', 'accepted'], ['قبول  البيان', 'accepted'], ['قبول-البيان', 'accepted'],
  ['انتهاء مراجعة مركز العمليات الجمركية', 'cco_review_done'], ['انتهت مراجعة مركز العمليات الجمركية', 'cco_review_done'],
  ['انتهاء مراجعة مركز العمليات الجمركيه', 'cco_review_done'],
  ['مرحلة انتظار تحصيل الرسوم الجمركية', 'awaiting_duty_payment'], ['انتظار تحصيل الرسوم الجمركية', 'awaiting_duty_payment'],
  ['بانتظار السداد', 'awaiting_duty_payment'], ['انتظار السداد', 'awaiting_duty_payment'], ['الرسوم الجمركية غير مسددة', 'awaiting_duty_payment'],
  ['البيان بانتظار السداد', 'awaiting_duty_payment'],
  ['جاهز لطباعة إشعار الفسح الإلكتروني', 'release_ready'], ['جاهز لطباعة اشعار الفسح الالكتروني', 'release_ready'],
  ['طباعة إشعار الفسح', 'release_ready'], ['جاهز لطباعة أشعار الفسح الإلكتروني', 'release_ready'],
  ['فسح كلي', 'released'], ['تم الفسح', 'released'], ['مفسوح', 'released'], ['تم الفسح كليا', 'released'], ['تم الفسح كلياً', 'released'],
  ['  فسح كلي  ', 'released'], ['فسح  كلي', 'released'],
  ['draft', 'draft'], ['submitted', 'submitted'], ['under_inspection', 'under_inspection'], ['accepted', 'accepted'],
  ['cco_review_done', 'cco_review_done'], ['awaiting_duty_payment', 'awaiting_duty_payment'], ['release_ready', 'release_ready'],
  ['released', 'released'], ['Released', 'released'], [' RELEASED ', 'released'], ['cancelled', 'cancelled'], ['replaced', 'replaced'],
  ['', ''], [null, ''], [undefined, ''], ['حالة غير معروفة', ''], ['تحت الإجراء', ''], ['release', ''], ['فسح', ''], ['   ', '']
]);
check('legacy order: «جاهز لطباعة إشعار الفسح» is release_ready, not released', () => M.normDeclarationStatus('جاهز لطباعة إشعار الفسح الإلكتروني - فسح كلي') === 'release_ready');
check('legacy order: a text with both «قبول البيان» and «فسح كلي» → accepted (first group wins)', () => M.normDeclarationStatus('قبول البيان ثم فسح كلي') === 'accepted');
check('isReleasedStatus', () => M.isReleasedStatus('تم الفسح') && !M.isReleasedStatus('جاهز لطباعة إشعار الفسح الإلكتروني') && !M.isReleasedStatus('') || 'released');
check('DECL_STATUS_CODES keeps the existing Marsa codes', () => ['draft', 'submitted', 'under_inspection', 'released', 'cancelled', 'replaced'].every(c => M.DECL_STATUS_CODES.indexOf(c) !== -1) || J(M.DECL_STATUS_CODES));
check('DECL_STATUS_AR has the legacy canonical Arabic for the five stages', () => M.DECL_STATUS_AR.released === 'فسح كلي' && M.DECL_STATUS_AR.accepted.indexOf('قبول البيان') === 0 && Object.keys(M.DECL_STATUS_AR).length === 5 || J(M.DECL_STATUS_AR));
check('every canonical Arabic stage normalises to its own code', () => Object.keys(M.DECL_STATUS_AR).every(k => M.normDeclarationStatus(M.DECL_STATUS_AR[k]) === k) || 'canon');

section('declaration type');
table('normDeclarationType', [
  ['استيراد', 'import'], ['بيان استيراد', 'import'], ['import', 'import'], ['Import', 'import'], [' IMPORT ', 'import'],
  ['تصدير', 'export'], ['بيان تصدير', 'export'], ['تصدر', 'export'], ['export', 'export'], ['إعادة تصدير', 'export'],
  ['تصفية', 'clearance'], ['تصفيه', 'clearance'], ['بيان تصفية', 'clearance'], ['clearance', 'clearance'],
  ['', ''], [null, ''], ['عبور', ''], ['imports', ''], ['transit', '']
]);
check('DECL_TYPE_AR', () => M.DECL_TYPE_AR.import === 'استيراد' && M.DECL_TYPE_AR.export === 'تصدير' && M.DECL_TYPE_AR.clearance === 'تصفية' || J(M.DECL_TYPE_AR));

/* ================================================================ transaction domains */
section('transaction domains');
table('normTransactionType', [['إعادة تصدير', 're_export'], ['إعادة صادر', 're_export'], ['اعادة تصدير', 're_export'], ['معاملة إعادة تصدير', 're_export'],
  ['re_export', 're_export'], ['عادية', 'normal'], ['', 'normal'], [null, 'normal'], ['تصدير', 'normal']]);
table('normCargoUnitType', [['حاوية', 'container'], ['', 'container'], [null, 'container'], ['مركبة Ro-Ro', 'roro'], ['RoRo', 'roro'], ['ro-ro', 'roro'],
  ['مركبة', 'roro'], ['شاحنة', 'roro'], ['براد', 'roro'], ['roro', 'roro'], ['container', 'container']]);
table('normTransportMode', [['شركة نقل', 'carrier_order'], ['أمر نقل لشركة نقل', 'carrier_order'], ['company', 'carrier_order'], ['carrier_order', 'carrier_order'],
  ['نقل بالسائق', 'driver'], ['موعد ونقل بواسطة سائق', 'driver'], ['driver', 'driver'], ['', ''], ['نقل', ''], [null, '']]);
table('normTransportOrderNo', [[' tasto 123 ', 'TASTO123'], ['TASTO١٢٣', 'TASTO123'], ['', '']]);
table('isTransportOrderNo', [['TASTO123', true], ['tasto 0099', true], ['TASTO', false], ['TAS123', false], ['TASTO12A', false], ['', false]]);

/* ================================================================ TAS */
section('TAS appointment number');
table('normTas', [
  ['TAS12345678', 'TAS12345678'], ['tas12345678', 'TAS12345678'], ['TAS 1234 5678', 'TAS12345678'], ['TAS-12345678', 'TAS12345678'],
  ['TAS_12345678', 'TAS12345678'], ['TAS/12345678', 'TAS12345678'], ['TAS.12345678', 'TAS12345678'], ['TAS\\12345678', 'TAS12345678'],
  ['12345678TAS', 'TAS12345678'], ['12345678 TAS', 'TAS12345678'], ['TAS١٢٣٤٥٦٧٨', 'TAS12345678'], ['TAS۱۲۳۴۵۶۷۸', 'TAS12345678'],
  ['‏TAS12345678‎', 'TAS12345678'], ['‫TAS‬12345678', 'TAS12345678'], ['⁧TAS12345678⁩', 'TAS12345678'],
  ['Booking ref: TAS2026110512', 'TAS2026110512'], ['TAS123456789012', 'TAS123456789012'], ['رقم الموعد TAS12345678', 'TAS12345678'],
  ['TAS1234567', ''], ['1234567TAS', ''], ['TA S12345678', 'TAS12345678'], ['TASX12345678', ''], ['FP12345678', ''], ['12345678', ''],
  ['', ''], [null, ''], [undefined, ''], ['TAS', ''], ['TAS12345678 TAS87654321', 'TAS12345678'], ['87654321TAS TAS12345678', 'TAS12345678'],
  ['TASTO12345678', ''], [12345678, '']
]);

/* ================================================================ phones */
section('Saudi phone');
table('normSaPhone', [
  ['0551234567', '0551234567'], ['551234567', '0551234567'], ['+966551234567', '0551234567'], ['00966551234567', '0551234567'],
  ['966551234567', '0551234567'], ['+966 55 123 4567', '0551234567'], ['055-123-4567', '0551234567'], ['(055) 123 4567', '0551234567'],
  ['٠٥٥١٢٣٤٥٦٧', '0551234567'], ['۰۵۵۱۲۳۴۵۶۷', '0551234567'], ['+٩٦٦٥٥١٢٣٤٥٦٧', '0551234567'], ['055/1234567', '0551234567'],
  ['‎+966 50 000 0000', '0500000000'], ['0591234567', '0591234567'],
  ['0112345678', ''], ['0112345678', '0112345678', true], ['+966112345678', '0112345678', true], ['0182345678', '', true],
  ['055123456', ''], ['05512345678', ''], ['0451234567', ''], ['+971501234567', ''], ['12345', ''], ['', ''], [null, ''], ['abc', ''],
  ['966 0551234567', ''], [551234567, '0551234567']
]);
table('phoneE164', [['0551234567', '+966551234567'], ['0112345678', '+966112345678'], ['bad', '']]);

/* ================================================================ chassis */
section('chassis');
table('normChassis', [
  ['1HGCM82633A004352', '1HGCM82633A004352'], ['1hgcm82633a004352', '1HGCM82633A004352'], ['1HG-CM8 2633/A004352', '1HGCM82633A004352'],
  [' jt2 bf22k 1w0123456 ', 'JT2BF22K1W0123456'], ['١HGCM٨٢٦٣٣A٠٠٤٣٥٢', '1HGCM82633A004352'], ['WDB.123.456', 'WDB123456'],
  ['‏WDB123‎', 'WDB123'], ['شاسيه ABC123', 'ABC123'], ['', ''], [null, ''], ['---', ''], [123, '123']
]);

/* ================================================================ containers */
section('containers');
table('normContainerNo', [
  ['MSCU1234566', 'MSCU1234566'], ['mscu1234566', 'MSCU1234566'], ['MSCU 1234566', 'MSCU1234566'], ['MSCU-123456-6', 'MSCU1234566'],
  [' msku 123 4566 ', 'MSKU1234566'], ['MSCU١٢٣٤٥٦٦', 'MSCU1234566'], ['MSC1234566', ''], ['MSCU123456', ''], ['MSCU12345678', ''],
  ['1234MSCU566', ''], ['', ''], [null, ''], ['MSCU 1234566 / TGHU 7654321', '']
]);
table('formatContainerNo', [
  ['MSCU1234566', 'MSCU 1234566'], ['mscu-1234566', 'MSCU 1234566'], ['MSCU 1234566', 'MSCU 1234566'], ['MSCU123', 'MSCU123'], ['', ''], [null, '']
]);
table('containerCheckDigitOk', [['CSQU3054383', true], ['MSCU1234566', true], ['MSKU1234565', true], ['MSCU1234567', false], ['MSKU1234560', false], ['TGHU7654321', false], ['ABCD', false], ['', false]]);
check('containerCheckDigitOk agrees with doc-match.js iso6346Valid', () => {
  const D = require(path.join(ROOT, 'assets', 'js', 'doc-match.js'));
  if (typeof D.iso6346Valid !== 'function') return true;
  const list = ['CSQU3054383', 'MSCU1234566', 'MSKU1234565', 'TGHU7654321', 'MAEU1234567', 'HLXU1234560', 'CMAU3456789', 'OOLU1234565'];
  const bad = list.filter(c => !!D.iso6346Valid(c) !== M.containerCheckDigitOk(c));
  return !bad.length || bad.join(',');
});
check('containerList: dedupe, normalise, accepts objects and text', () => {
  const a = M.containerList(['MSCU 1234566', 'mscu1234566', { containerNo: 'TGHU-7654321' }, 'bad']);
  const b = M.containerList('MSCU1234566, TGHU7654321 ، MSCU1234566');
  return (J(a) === J(['MSCU1234566', 'TGHU7654321']) && J(b) === J(['MSCU1234566', 'TGHU7654321'])) || J([a, b]);
});

/* ================================================================ ports */
section('approved ports');
check('exactly the 7 approved legacy ports', () => {
  const ar = M.PORTS.map(p => p.name_ar);
  const want = ['ميناء جدة الإسلامي', 'ميناء الملك عبدالعزيز بالدمام', 'ميناء الملك عبدالله (رابغ)', 'ميناء الرياض الجاف',
    'مطار الملك عبدالعزيز الدولي بجدة', 'مطار الملك فهد الدولي بالدمام', 'مطار الملك خالد الدولي بالرياض'];
  return (M.PORTS.length === 7 && J(ar) === J(want)) || J(ar);
});
check('port codes unique, kinds sea/air/dry', () => {
  const codes = M.PORTS.map(p => p.code);
  return (new Set(codes).size === 7 && M.PORTS.every(p => ['sea', 'air', 'dry'].indexOf(p.kind) !== -1) &&
    M.PORTS.filter(p => p.kind === 'air').length === 3 && M.PORTS.filter(p => p.kind === 'dry').length === 1) || J(codes);
});
check('sea / dry codes are the UN/LOCODEs doc-match.js uses', () => {
  const m = {}; M.PORTS.forEach(p => { m[p.name_ar] = p.code; });
  return (m['ميناء جدة الإسلامي'] === 'SAJED' && m['ميناء الملك عبدالعزيز بالدمام'] === 'SADMM' && m['ميناء الملك عبدالله (رابغ)'] === 'SAKAC' && m['ميناء الرياض الجاف'] === 'SARUH') || J(m);
});
check('every port normalises from its code, Arabic name, English name and Daftra value', () => {
  const bad = [];
  M.PORTS.forEach(p => [p.code, p.code.toLowerCase(), p.name_ar, p.name_en, p.daftra_value].concat(p.aliases).forEach(v => { if (v && M.normPortCode(v) !== p.code) bad.push(v + '→' + M.normPortCode(v)); }));
  return !bad.length || bad.join(' | ');
});
table('normPortCode', [
  ['ميناء جدة الاسلامي', 'SAJED'], ['ميناء جده الإسلامي', 'SAJED'], ['جمرك ميناء جدة الإسلامي', 'SAJED'], ['جمرك جدة الإسلامي', 'SAJED'],
  ['JEDDAH ISLAMIC PORT, KSA', 'SAJED'], ['Jeddah, Saudi Arabia', 'SAJED'], ['jeddah', 'SAJED'], ['JED', 'SAJED'], ['SA JED', 'SAJED'], ['جدة', 'SAJED'],
  ['ميناء الملك عبدالعزيز بالدمام', 'SADMM'], ['ميناء الملك عبد العزيز بالدمام', 'SADMM'], ['ميناء الملك عبدالعزيز - الدمام', 'SADMM'],
  ['الدمام', 'SADMM'], ['DAMMAM', 'SADMM'], ['King Abdulaziz Port Dammam', 'SADMM'], ['جمرك ميناء الملك عبدالعزيز', 'SADMM'], ['ميناء الملك عبدالعزيز البحري الدمام', 'SADMM'],
  ['ميناء الملك عبدالله (رابغ)', 'SAKAC'], ['ميناء الملك عبدالله', 'SAKAC'], ['رابغ', 'SAKAC'], ['King Abdullah Port', 'SAKAC'], ['RABIGH', 'SAKAC'], ['الملك عبدالله رابغ', 'SAKAC'],
  ['ميناء الرياض الجاف', 'SARUH'], ['الميناء الجاف', 'SARUH'], ['جمرك الرياض - الميناء الجاف', 'SARUH'], ['Riyadh Dry Port', 'SARUH'], ['الرياض', 'SARUH'], ['RIYADH', 'SARUH'],
  ['مطار الملك عبدالعزيز الدولي بجدة', 'SAJED-AIR'], ['مطار الملك عبدالعزيز', 'SAJED-AIR'], ['جمرك مطار الملك عبدالعزيز الدولي', 'SAJED-AIR'],
  ['مطار جدة', 'SAJED-AIR'], ['King Abdulaziz International Airport', 'SAJED-AIR'], ['Jeddah Airport', 'SAJED-AIR'], ['الملك عبدالعزيز جوي جدة', 'SAJED-AIR'],
  ['مطار الملك فهد الدولي بالدمام', 'SADMM-AIR'], ['مطار الملك فهد', 'SADMM-AIR'], ['جمرك مطار الملك فهد الدولي', 'SADMM-AIR'], ['King Fahd International Airport', 'SADMM-AIR'], ['مطار الدمام', 'SADMM-AIR'],
  ['مطار الملك خالد الدولي بالرياض', 'SARUH-AIR'], ['مطار الملك خالد', 'SARUH-AIR'], ['جمرك مطار الملك خالد الدولي', 'SARUH-AIR'], ['King Khalid International Airport', 'SARUH-AIR'], ['مطار الرياض', 'SARUH-AIR'],
  ['sajed', 'SAJED'], ['sadmm-air', 'SADMM-AIR'], [' SARUH ', 'SARUH'],
  ['ميناء ينبع', ''], ['الجبيل', ''], ['Ningbo', ''], ['جمرك مطار الأمير محمد بن عبدالعزيز', ''], ['مطار', ''], ['ميناء', ''], ['', ''], [null, ''], ['KSA', ''], ['SAJUB', '']
]);
check('portByCode returns the record, null for unknown', () => (M.portByCode('SAJED').name_en === 'Jeddah Islamic Port' && M.portByCode('ميناء الرياض الجاف').code === 'SARUH' && M.portByCode('XX') === null) || 'portByCode');
check('PORTS / AGENTS are frozen copies: a caller cannot change them for the others (nor the dictionary)', () => {
  const tries = [() => { M.PORTS[0].code = 'HACK'; }, () => { M.PORTS.push({ code: 'X' }); }, () => { M.PORTS[0].aliases.push('x'); }, () => { M.AGENTS[0] = 'X'; }];
  const threw = tries.filter(f => { try { f(); return false; } catch (e) { return !!e && e.name === 'TypeError'; } }).length;
  return (threw === 4 && M.PORTS[0].code === 'SAJED' && M.PORTS.length === 7 && M.AGENTS[0] === 'Hapag-Lloyd' && Object.isFrozen(M.PORTS[0])
    && M.normPortCode('Jeddah Islamic Port') === 'SAJED') || 'mutable: ' + threw;
});

/* ================================================================ shipping agents */
section('shipping agents');
table('normShippingAgentShort', [
  ['Hapag-Lloyd AG', 'Hapag-Lloyd'], ['HAPAG LLOYD', 'Hapag-Lloyd'], ['Lloyd', 'Hapag-Lloyd'], ['هاباغ لويد', 'Hapag-Lloyd'], ['هابغ', 'Hapag-Lloyd'], ['هباج لويد', 'Hapag-Lloyd'],
  ['Mediterranean Shipping Company S.A.', 'MSC'], ['MSC', 'MSC'], ['msc', 'MSC'], ['إم إس سي', 'MSC'], ['ام اس سي', 'MSC'],
  ['Ocean Network Express Pte. Ltd.', 'ONE'], ['ONE', 'ONE'], ['one', 'ONE'],
  ['Wan Hai Lines Ltd.', 'Wan Hai'], ['WANHAI', 'Wan Hai'],
  ['Orient Overseas Container Line', 'OOCL'], ['OOCL', 'OOCL'], ['او او سي ال', 'OOCL'],
  ['CMA CGM S.A.', 'CMA CGM'], ['CMA-CGM', 'CMA CGM'], ['CMA', 'CMA CGM'],
  ['Maersk Line', 'Maersk'], ['A.P. Moller - Maersk', 'Maersk'], ['ميرسك', 'Maersk'],
  ['Pacific International Lines', 'PIL'], ['PIL', 'PIL'],
  ['Milaha', 'Milaha'], ['Qatar Navigation (Milaha)', 'Milaha'], ['ملاحة', 'ملاحة'],
  ['Regional Container Lines', 'RCL'], ['RCL', 'RCL'],
  ['T.S. Lines', 'T.S. Lines'], ['TS LINES LTD', 'T.S. Lines'], ['TS Line', 'T.S. Lines'], ['TSL', 'T.S. Lines'],
  ['Yang Ming Marine Transport Corp.', 'Yang Ming'], ['YANGMING', 'Yang Ming'],
  ['Ignazio Messina & C. S.p.A.', 'Messina Line'], ['Messina Line', 'Messina Line'], ['MESSINA', 'Messina Line'],
  ['Emirates Shipping Line', 'ESL'], ['ESL', 'ESL'],
  ['Kenzy International Marine', 'Kenzy'], ['Kenzy Marine', 'Kenzy'], ['KENZY', 'Kenzy'],
  // unknown agents: legal suffixes removed, the name kept, no invented abbreviation
  ['Gold Star Line Ltd.', 'Gold Star Line'], ['Global Feeder Shipping LLC', 'Global Feeder Shipping'], ['Sea Lead Shipping Pte Ltd', 'Sea Lead Shipping'],
  ['Unifeeder FZE', 'Unifeeder'], ['Arkas Line S.P.A.', 'Arkas Line'], ['Zim Integrated Shipping Services Inc.', 'Zim Integrated Shipping Services'],
  ['Evergreen Marine Corporation', 'Evergreen Marine'], ['COSCO Shipping Lines Co., Ltd.', 'COSCO Shipping Lines Co'],
  ['Emirates Line Company Limited', 'Emirates Line'], ['ABC Corp.', 'ABC'], ['L.L.C.', 'L.L.C.'],
  ['البحري', 'البحري'], ['  الوكالة السعودية للملاحة البحرية  ', 'الوكالة السعودية للملاحة البحرية'], ['Evergreen', 'Evergreen'], ['ZIM', 'ZIM'], ['LTD', 'LTD'],
  ['', ''], [null, ''], ['   ', '']
]);
check('AGENTS = the 15 legacy short names', () => M.AGENTS.length === 15 && new Set(M.AGENTS).size === 15 || J(M.AGENTS));
check('every short name is a fixed point', () => M.AGENTS.every(a => M.normShippingAgentShort(a) === a) || M.AGENTS.filter(a => M.normShippingAgentShort(a) !== a).join(','));
check('unknown agent is never shortened to an abbreviation not in its own text', () => {
  const names = ['Gold Star Line Ltd.', 'Sea Lead Shipping Pte Ltd', 'Arkas Line S.P.A.', 'Some New Carrier Co. Ltd.'];
  return names.every(n => { const s = M.normShippingAgentShort(n); return n.indexOf(s) === 0 && s.length >= 3; }) || 'abbrev';
});

/* ================================================================ robustness */
section('Unicode spaces (NBSP, narrow NBSP, em space, ideographic space, BOM) — review fix, checked against SQL below');
{
  const NB = '\u00A0', NNB = '\u202F', EM = '\u2003', IDS = '\u3000', BOM = '\uFEFF';
  table('searchKey', [['TEST' + NB + 'X', 'testx'], ['ABC' + EM + 'DEF', 'abcdef'], ['فسح' + NB + 'كلي', 'فسحكلي'], [NB + IDS, ''], [BOM + 'Ro' + NNB + '-Ro', 'roro']]);
  table('normDeclarationStatus', [['قبول' + NB + 'البيان', 'accepted'], ['تم' + NB + 'الفسح', 'released'], ['released' + NB, 'released'],
    [NNB + 'draft' + EM, 'draft'], ['بانتظار' + IDS + 'السداد', 'awaiting_duty_payment'], [NB + NB, '']]);
  table('normDeclarationType', [['استيراد' + NB, 'import'], [NB + 'export' + NB, 'export'], ['تصفية' + IDS, 'clearance'], ['بيان' + NB + 'تصدير', 'export']]);
  table('normTas', [['TAS' + NB + '12345678', 'TAS12345678'], ['TAS' + NNB + '1234' + EM + '5678', 'TAS12345678'], [BOM + 'TAS12345678', 'TAS12345678'],
    ['12345678' + NB + 'TAS', 'TAS12345678']]);
  table('normalizeHijri', [['1447/3/15' + NB + 'هـ', '1447/03/15'], ['1446' + NB + '/05/12', '1446/05/12'], [NB + '1447/03/05' + NB, '1447/03/05'],
    ['15' + NNB + '/' + NNB + '3' + NNB + '/' + NNB + '1447', '1447/03/15'], ['1447/03/15' + IDS + 'AH', '1447/03/15']]);
}

section('robustness / determinism');
const WEIRD = [null, undefined, '', ' ', 0, 1, -1, NaN, Infinity, true, false, {}, [], ['x'], { toString: () => 'TAS12345678' }, '\u0000', '٠', 'ـــ', 'x'.repeat(5000), '١'.repeat(500)];
['normDeclarationStatus', 'normDeclarationType', 'normShippingAgentShort', 'normChassis', 'normTas', 'normSaPhone', 'normContainerNo', 'formatContainerNo',
  'normPortCode', 'normalizeHijri', 'hijriToGregorian', 'gregorianToHijri', 'searchKey', 'foldArabic', 'normName', 'normTransactionType', 'normCargoUnitType',
  'normTransportMode', 'containerCheckDigitOk', 'isHijriFormat', 'isValidHijri'].forEach(fn => {
  check(fn + ': never throws, returns a string/boolean on weird input', () => {
    for (const w of WEIRD) { const r = M[fn](w); if (typeof r !== 'string' && typeof r !== 'boolean') return J(w) + '→' + typeof r; }
    return true;
  });
});
check('object with toString is read as text (TAS)', () => M.normTas({ toString: () => 'TAS12345678' }) === 'TAS12345678');
check('deterministic: same inputs → same outputs twice', () => {
  const inputs = ['1446/1/1', 'تم الفسح', 'TAS 1234 5678', '+966551234567', 'mscu 1234566', 'ميناء جدة الإسلامي', 'Gold Star Line Ltd.'];
  const run = () => inputs.map(v => [M.hijriToGregorian(v), M.normDeclarationStatus(v), M.normTas(v), M.normSaPhone(v), M.normContainerNo(v), M.normPortCode(v), M.normShippingAgentShort(v)]);
  return J(run()) === J(run()) || 'nondeterministic';
});
check('idempotent: norm(norm(x)) = norm(x)', () => {
  const fns = ['normChassis', 'normTas', 'normSaPhone', 'normContainerNo', 'normPortCode', 'normalizeHijri', 'normDeclarationStatus', 'normDeclarationType', 'normShippingAgentShort', 'normName'];
  const vals = ['1hg-cm8', 'TAS 1234 5678', '+966 55 123 4567', 'mscu 1234566', 'Jeddah Islamic Port, KSA', '5/3/1447', 'تم الفسح', 'بيان استيراد', 'Gold Star Line Ltd.', 'شركة مرسى'];
  const bad = [];
  fns.forEach(f => vals.forEach(v => { const a = M[f](v); if (M[f](a) !== a) bad.push(f + '(' + v + ')'); }));
  // declaration type / status codes are fixed points too
  return !bad.length || bad.join(' ');
});
check('hijriToGregorian is fast enough (200 conversions < 2s)', () => {
  const t = Date.now();
  for (let i = 0; i < 200; i++) M.hijriToGregorian('14' + String(10 + (i % 60)) + '/' + String(1 + (i % 12)).padStart(2, '0') + '/15');
  return (Date.now() - t) < 2000 || ((Date.now() - t) + 'ms');
});

/* ================================================================ SQL parity (optional) */
// When the step-1 migration with the app.norm_* helpers is present and PGlite is available, the SQL
// helpers must give the same answers as this file on every vector above (SQL NULL == JS '').
const PARITY = [['normDeclarationStatus', 'app.norm_declaration_status'], ['normTas', 'app.norm_tas'],
  ['normSaPhone', 'app.norm_sa_phone'], ['normChassis', 'app.norm_chassis'],
  // review fix: the three helpers whose SQL comment claims MarsaNorm parity
  ['searchKey', 'app.legacy_search_key'], ['normDeclarationType', 'app.norm_declaration_type'], ['normalizeHijri', 'app.norm_hijri_date']];
// app.norm_hijri_date reads numeric text only; the JS also reads the text of a Date cell ('Thu Jun 03 1447 …'), left out here
const PARITY_SKIP = { normalizeHijri: v => typeof v === 'string' && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v) };
async function sqlParity() {
  section('SQL parity');
  const MIG = path.join(ROOT, 'supabase', 'migrations');
  const files = fs.readdirSync(MIG).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const all = files.map(f => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
  const present = PARITY.filter(p => new RegExp('FUNCTION\\s+' + p[1].replace('.', '\\.') + '\\s*\\(', 'i').test(all));
  if (!present.length) { console.log('  SQL parity: skipped (no app.norm_* helper in supabase/migrations yet)'); return; }
  let PGlite;
  try { PGlite = require('@electric-sql/pglite').PGlite; } catch (e) { console.log('  SQL parity: skipped (PGlite not installed)'); return; }
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'tests', 'shim.sql'), 'utf8'));
  for (const f of files) await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  for (const p of present) {
    const skip = PARITY_SKIP[p[0]] || (() => false);
    const ins = (VEC[p[0]] || []).filter(v => !skip(v)).concat(['', null, '   ', '\u00A0', '\u00A0\u3000\uFEFF']);
    const rows = (await db.query('SELECT i, ' + p[1] + '(v) AS r FROM unnest($1::text[]) WITH ORDINALITY AS u(v, i) ORDER BY i', [ins])).rows;
    const bad = [];
    rows.forEach((row, k) => { const js = M[p[0]](ins[k]); const sq = row.r === null ? '' : row.r; if (js !== sq) bad.push(J(ins[k]) + ' js=' + J(js) + ' sql=' + J(row.r)); });
    check(p[1] + ' == MarsaNorm.' + p[0] + ' on ' + ins.length + ' vectors', () => !bad.length || bad.slice(0, 8).join(' | '));
  }
  const missing = PARITY.filter(p => present.indexOf(p) === -1).map(p => p[1]);
  if (missing.length) check('all ' + PARITY.length + ' SQL helpers exist (' + missing.join(', ') + ')', () => 'missing in migrations');
  // the platform port table, when present, must carry the same 7 codes and Arabic names
  const hasPorts = (await db.query(`SELECT to_regclass('public.customs_ports') IS NOT NULL AS x`)).rows[0].x;
  if (hasPorts) {
    const rows = (await db.query('SELECT * FROM public.customs_ports ORDER BY 1')).rows;
    const sqlMap = {}; rows.forEach(r => { sqlMap[r.code] = r.name_ar; });
    const bad = M.PORTS.filter(p => sqlMap[p.code] !== p.name_ar).map(p => p.code + ' sql=' + J(sqlMap[p.code]));
    check('customs_ports carries the 7 MarsaNorm.PORTS codes / name_ar', () => !bad.length || (bad.join(' | ') + ' ; sql codes ' + J(Object.keys(sqlMap))));
  }
  await db.close();
}

/* ----------------------------------------------------------------- summary */
(async () => {
  try { await sqlParity(); } catch (e) { check('SQL parity ran', () => 'threw: ' + (e && e.message || e)); }
console.log('\nMarsa — legacy-norm tests: ' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' checks)');
if (fail) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
})();

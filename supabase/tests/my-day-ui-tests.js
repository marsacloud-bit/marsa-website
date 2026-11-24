#!/usr/bin/env node
/*
  «مهامي اليوم» (owner, 23 Nov 2026, suggestion ق5): the staff dashboard opens on the employee's day. LOCAL, static.
  Covers: the 'today' tab first and the default for every staff member (the role tabs kept); renderToday reads only the
  existing APIs (stats, alerts, today's appointments, open transactions), one main action, data through el() (no
  innerHTML); the menu / view label «مهامي اليوم»; its texts in Arabic and English; its styles.
  usage: node supabase/tests/my-day-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
let nPass = 0, nFail = 0; const fails = [];
function check(name, fn) {
  let r; try { r = fn(); } catch (e) { r = 'threw: ' + e.message; }
  if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); } else { nFail++; fails.push(name + ' — ' + r); console.log('FAIL  ' + name + '\n        ' + r); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const admin = read('assets/js/admin.js');
const fn = admin.slice(admin.indexOf('function renderToday('), admin.indexOf('function renderOverview('));
check('tabs: «مهامي اليوم» first and the default; overview / role tabs kept', () =>
  (/var tabs = \['today', 'overview', 'ops'\]/.test(admin) && /function dashDefaultTab\(\) \{\n    return 'today';/.test(admin)
    && /if \(tab === 'today'\) return renderToday\(strip\);/.test(admin) && /function renderOverview\(strip\)/.test(admin)) || 'tabs');
check('renderToday: the existing reads only; one main action (new transaction by reading); no innerHTML', () =>
  (fn.length > 500 && /call\('listAlerts'/.test(fn) && /call\('listAppointments'/.test(fn) && /api\.listTransactions\(/.test(fn) && /dashboardStats/.test(fn)
    && (fn.match(/btn btn-primary/g) || []).length === 1 && /ocr\.html#new-tx/.test(fn) && !/innerHTML|\.rpc\(/.test(fn)) || 'renderToday');
check('a count that could not be read shows «—» (fmtCount), meaning colours always with a word', () =>
  (/fmtCount\(o\.value\)/.test(fn) && /todayChip\(tone, t\('tdy_sev_' \+ tone\)\)/.test(fn)) || 'tones');
check('menu and view label «مهامي اليوم» (ar) / «My day» (en)', () => {
  const ai = read('assets/i18n/admin.js'), app = read('assets/i18n/app.js');
  return (/view_dashboard: 'مهامي اليوم'/.test(ai) && /view_dashboard: 'My day'/.test(ai) && /pnav_dashboard: 'مهامي اليوم'/.test(app) && /pnav_dashboard: 'My day'/.test(app)
    && /dashboard: 'مهامي اليوم'/.test(admin)) || 'labels';
});
check('every tdy_* text used exists in Arabic and English', () => {
  const ai = read('assets/i18n/admin.js');
  const used = [...new Set([...fn.matchAll(/t\('(tdy_[a-z_]+)'/g)].map(m => m[1]))].concat(['tdy_sev_bad', 'tdy_sev_warn', 'tdy_sev_info', 'tdy_appt_requested', 'tdy_appt_confirmed', 'tdy_appt_completed', 'tdy_appt_missed']);
  const miss = used.filter(k => !/_$/.test(k)).filter(k => (ai.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('styles: tiles, lists, chips, the table; four tiles fold to two / one on small screens', () => {
  const c = read('assets/css/pages/admin.css');
  return (/\.tdy-tiles \{ display: grid; grid-template-columns: repeat\(4/.test(c) && /\.tdy-chip/.test(c) && /\.tdy-table/.test(c) && /max-width: 520px/.test(c)) || 'css';
});
console.log('\n' + '-'.repeat(70));
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
process.exit(nFail ? 1 : 0);

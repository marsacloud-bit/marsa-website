#!/usr/bin/env node
/*
  Client page (portal.html) in the new calm design (owner, 23 Nov 2026). LOCAL, static.
  Covers: <html class="portal-v2"> + portal-v2.css after portal.css (precached); the top bar (office brand via
  site-profile.js, back to the site, the language button); its texts in Arabic and English; every view / tab / form /
  hook portal.js uses is still there; the office-site header / footer hidden by CSS, not deleted; info notes not blue.
  usage: node supabase/tests/portal-v2-tests.js [/path/to/marsa-website] [--quiet]
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
const html = read('portal.html'), css = read('assets/css/pages/portal-v2.css'), dict = read('assets/i18n/portal.js'), sw = read('sw.js');

check('portal.html: class portal-v2, portal-v2.css after portal.css, site-profile.js after supa.js and before portal.js', () =>
  (/<html[^>]*class="no-js portal-v2"/.test(html) && html.indexOf('pages/portal.css') < html.indexOf('pages/portal-v2.css')
    && html.indexOf('js/supa.js') < html.indexOf('js/site-profile.js') && html.indexOf('js/site-profile.js') < html.indexOf('js/portal.js')) || 'html');
check('top bar: office brand (data-site-brand / data-site-logo), back to the site, one language button', () =>
  (/class="pt-top"/.test(html) && /class="pt-brand"[^>]*data-site-brand/.test(html) && /<img data-site-logo/.test(html)
    && /class="pt-back" href="office.html"/.test(html) && (html.match(/data-lang-toggle/g) || []).length === 1) || 'top bar');
check('every view, tab, form and hook portal.js uses is kept', () => {
  const hooks = ['data-portal-view="demo"', 'data-portal-view="loading"', 'data-portal-view="error"', 'data-portal-view="app"', 'data-portal-name',
    'data-portal-email', 'data-sign-out', 'data-sign-out-all', 'data-staff-note', 'data-notlinked-note', 'data-tx-list', 'data-tx-detail',
    'data-ctr-panel', 'data-inv-panel', 'data-req-list', 'data-req-detail', 'id="link-form"', 'id="profile-form"', 'id="password-form"',
    'data-shell-title', 'data-shell-org', 'data-shell-search', 'id="page-title"'];
  ['tx', 'containers', 'invoices', 'req', 'link', 'profile'].forEach(t => hooks.push('data-portal-tab="' + t + '"', 'data-count="' + t + '"'));
  const miss = hooks.filter(x => !/data-count="(link|profile)"/.test(x)).filter(x => !html.includes(x));
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('the office-site chrome is hidden by CSS, not deleted', () =>
  (/class="site-header"/.test(html) && /class="site-footer"/.test(html) && /\.portal-v2 \.site-header/.test(css) && /\.portal-v2 \.site-footer/.test(css)
    && /display: none !important/.test(css)) || 'chrome');
check('new texts exist in Arabic and English', () => {
  const miss = ['v2Back', 'v2Kicker'].filter(k => (dict.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('one accent: segmented tabs, info notes on the accent tint (not blue), meaning colours untouched', () =>
  (/\.portal-tabs \.tab\[aria-selected="true"\]/.test(css) && /--info-bg: var\(--accent-soft\)/.test(css)
    && !/alert-(success|warning|danger) \{/.test(css) && !/#0B3A6E|#1673B8/i.test(css)) || 'css');
check('sw.js precaches portal-v2.css', () => /'assets\/css\/pages\/portal-v2\.css'/.test(sw) || 'sw');

// step 2: the stage line («خط سير المعاملة»)
const pjs = read('assets/js/portal.js');
const lineFn = pjs.slice(pjs.indexOf('function stagesFor('), pjs.indexOf('function renderStages('));
check('stage line: stages from the configured chain (status_labels), no stage list written in the code', () =>
  (lineFn.length > 500 && /state\.labels\.operational_status/.test(lineFn) && !/'customs_declaration'|'transport'|'appointment'/.test(lineFn)) || 'source');
check('stage line: the empty-container return only when the transaction has containers (or is at that stage)', () =>
  (/hasCtr \|\| s\.code !== 'empty_return' \|\| s\.code === tx\.operational_status/.test(lineFn)) || 'empty_return');
check('stage line: on top of the transaction; a cancelled one keeps its box; the old list hidden by CSS, not deleted', () =>
  (/var line = tx\.cancelled_at \? null : renderStageLine\(tx\)/.test(pjs) && /stagePanel\.setAttribute\('data-stage-panel', 'line'\)/.test(pjs)
    && /function renderStages\(tx\)/.test(pjs) && /\[data-stage-panel="line"\] \{ display: none; \}/.test(css)) || 'placement');
check('stage line: done / current / not started marked with text for screen readers, not colour only; data through h() (no innerHTML)', () =>
  (/tx-step is-' \+ st/.test(lineFn) && /msg\('step_' \+ st\)/.test(lineFn) && /aria-current/.test(lineFn) && !/innerHTML/.test(lineFn)) || 'a11y');
check('the list: «المرحلة n من t» under the stage badge (not for a cancelled transaction)', () =>
  (/txBadge\(tx\), tx\.cancelled_at \? null : stageMini\(tx\)/.test(pjs) && /\.tx-mini-bar/.test(css)) || 'list');
check('stage line texts exist in Arabic and English', () => {
  const miss = ['lineTitle', 'lineNow', 'stepOf', 'step_done', 'step_current', 'step_todo'].filter(k => (dict.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('stage line: vertical on narrow screens', () => (/@media \(max-width: 760px\)[\s\S]*\.tx-steps \{ grid-auto-flow: row;/.test(css)) || 'mobile');
check('main.js animates numeric counters only (the tab counts data-count="tx" are not reset to 0)', () =>
  (/qsa\('\[data-count\]'\)\.filter\(function \(el\) \{ return isFinite\(parseFloat\(el\.getAttribute\('data-count'\)\)\); \}\)/.test(read('assets/js/main.js'))) || 'main.js');

console.log('\n' + '-'.repeat(70));
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
process.exit(nFail ? 1 : 0);

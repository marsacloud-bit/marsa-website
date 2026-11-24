#!/usr/bin/env node
/*
  Platform chrome (owner, 23 Nov 2026): the platform has its own top bar + right-hand menu on every platform page,
  separate from the office websites' menu. LOCAL TESTS ONLY, static (no browser, no network).
  Covers: the five platform pages carry .plat-v2, plat-v2.css and plat-chrome.js (before app-shell.js); the office
  website pages do not; sw.js precaches both files; every menu group / label has its ar + en text; the groups only
  name real NAV items and every staff NAV item has a group (search / help live in the top bar); the chrome writes
  data with textContent only; the old site chrome is hidden by CSS, not removed from the pages.
  usage: node supabase/tests/plat-chrome-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
let nPass = 0, nFail = 0; const fails = [];
function check(name, fn) {
  let r; try { r = fn(); } catch (e) { r = 'threw: ' + e.message; }
  if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
  else { nFail++; fails.push(name + ' — ' + r); console.log('FAIL  ' + name + '\n        ' + r); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PLATFORM = ['admin', 'ocr', 'bulk-upload', 'help', 'platform'];
const SITE = ['office', 'index', 'blog', 'consult', 'about', 'contact'];   // office.html = the office website (moved 2026-11-24); index.html = the platform home page
const chrome = read('assets/js/plat-chrome.js');
const css = read('assets/css/plat-v2.css');

for (const p of PLATFORM) {
  const h = read(p + '.html');
  check(p + '.html: .plat-v2, plat-v2.css, plat-chrome.js before app-shell.js; site header kept in the markup', () => {
    const b = /<body data-page="[^"]+" class="[^"]*\bplat-v2\b[^"]*">/.test(h);
    const c = h.indexOf('assets/css/plat-v2.css') > h.indexOf('assets/css/app.css');
    const s1 = h.indexOf('<script src="assets/js/plat-chrome.js"'), s2 = h.indexOf('<script src="assets/js/app-shell.js"');
    return (b && c && s1 > 0 && s2 > s1 && /class="site-header"/.test(h)) || JSON.stringify({ b, c, s1, s2 });
  });
}
for (const p of SITE) {
  check(p + '.html (office website): no platform chrome', () => {
    const h = read(p + '.html');
    return (!/plat-v2|plat-chrome/.test(h)) || 'platform chrome on a website page';
  });
}
check('sw.js precaches plat-v2.css and plat-chrome.js', () => {
  const s = read('sw.js');
  return (/'assets\/css\/plat-v2\.css'/.test(s) && /'assets\/js\/plat-chrome\.js'/.test(s)) || 'precache';
});
check('plat-v2.css hides the website chrome of these pages (display:none), never removes it', () =>
  (/\.plat-v2 > \.site-header/.test(css) && /\.plat-v2 > \.site-footer/.test(css) && /display: none !important/.test(css)) || 'css');
check('plat-chrome.js: data only through textContent (no innerHTML)', () =>
  (!/innerHTML/.test(chrome) && /textContent/.test(chrome)) || 'unsafe');

// groups vs NAV (app-shell.js) and texts (i18n/app.js)
const groups = JSON.parse(chrome.match(/var GROUPS = (\[[\s\S]*?\n  \]);/)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
const shell = read('assets/js/app-shell.js');
const navIds = [...shell.slice(shell.indexOf('var NAV = ['), shell.indexOf('// admin.js detail routes')).matchAll(/\{ id: '([a-z_]+)', (?:key: '[^']+', )?href:/g)].map(m => m[1]);
check('the menu groups name only NAV items', () => {
  const bad = groups.flatMap(g => g.items).filter(id => navIds.indexOf(id) === -1);
  return bad.length === 0 || 'unknown: ' + bad.join(', ');
});
check('every NAV item has a menu group (search / help in the top bar, the platform panel in the user menu)', () => {
  const named = new Set(groups.flatMap(g => g.items).concat(['search', 'help', 'platform']));
  const miss = navIds.filter(id => !named.has(id));
  return miss.length === 0 || 'no group: ' + miss.join(', ');
});
check('every group label and the chrome texts exist in Arabic and English', () => {
  const ctx = { window: {} }; vm.runInNewContext(read('assets/i18n/app.js'), ctx);
  const D = ctx.window.MarsaAppDict;
  const keys = groups.map(g => 'pl_grp_' + g.id).concat(['pl_grp_more', 'pl_tagline', 'pl_menu_aria', 'pl_fold', 'pl_open_menu', 'pl_today',
    'pl_security', 'pl_preview', 'pl_preview_site', 'pl_preview_portal', 'pnav_register', 'pnav_billing', 'pnav_daftra']);
  const miss = keys.filter(k => !D.ar[k] || !D.en[k]);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('owner labels: «المعاملات», «الفوترة», «الربط المحاسبي» (no program name in the menu)', () => {
  const ctx = { window: {} }; vm.runInNewContext(read('assets/i18n/app.js'), ctx);
  const a = ctx.window.MarsaAppDict.ar;
  return (a.pnav_register === 'المعاملات' && a.pnav_billing === 'الفوترة' && a.pnav_daftra === 'الربط المحاسبي') || JSON.stringify(a);
});

check('two panels: platform.html has its own menu (its sections), the office menu has no «platform» item', () => {
  const pf = read('platform.html');
  const ids = [...chrome.matchAll(/\['pf_[a-z]+', '(pf-[a-z]+-title)'/g)].map(m => m[1]);
  const miss = ids.filter(id => pf.indexOf('id="' + id + '"') === -1);
  return (ids.length === 7 && miss.length === 0 && groups.every(g => g.items.indexOf('platform') === -1)) || JSON.stringify({ ids, miss });
});

console.log('\n' + '-'.repeat(70));
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
process.exit(nFail ? 1 : 0);

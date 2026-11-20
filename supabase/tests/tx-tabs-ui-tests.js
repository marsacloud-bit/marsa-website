#!/usr/bin/env node
/* Owner reorg (20 Nov 2026): the transaction page (#tx/<id>) in tabs — static checks.
   Every registered transaction section has a tab, admin.js' own cards are marked for their tab, the strings exist in
   ar + en, the flags come from the storage / driver sections, sw.js is bumped.
   Usage: node supabase/tests/tx-tabs-ui-tests.js <repo root> [--quiet] */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');
const QUIET = process.argv.includes('--quiet');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = String(e && e.stack || e); }
  if (r === true) { pass++; if (!QUIET) console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (r ? ' — ' + r : '')); }
}

const admin = rd('assets/js/admin.js');
const tabsLine = (admin.match(/var TX_TABS = \[([^\]]+)\]/) || [])[1] || '';
const TABS = tabsLine.split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
const mapSrc = (admin.match(/var TX_TAB_OF = \{([\s\S]*?)\};/) || [])[1] || '';
const MAP = {};
mapSrc.replace(/'?([a-z_-]+)'?\s*:\s*'([a-z]+)'/g, (m, k, v) => { MAP[k] = v; return m; });

check('seven tabs in timeline order', () => TABS.join(',') === 'summary,docs,containers,transport,return,finance,log' || TABS.join(','));
check('every TX_TAB_OF target is a tab', () => Object.keys(MAP).every(k => TABS.includes(MAP[k])) || JSON.stringify(MAP));

// every transaction section registered anywhere in the front end has a tab (no long «الملخص» by accident)
const files = [];
(function walk(d) {
  fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach(e => {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p);
  });
})('assets/js');
const ids = new Set();
files.forEach(f => {
  const s = rd(f);
  if (!/txSections/.test(s)) return;
  (s.match(/id: '([a-z_-]+)',\s*order: \d+(?!, placement: 'top')/g) || []).forEach(m => {
    if (/placement: 'top'/.test(m)) return;
    ids.add(m.match(/id: '([a-z_-]+)'/)[1]);
  });
  // audit-diff registers over two lines
  (s.match(/id: '([a-z_-]+)', order: \d+, placement: 'top'/g) || []).forEach(m => ids.delete(m.match(/id: '([a-z_-]+)'/)[1]));
});
['draft_approval', 'readiness'].forEach(x => ids.delete(x));
ids.delete('custody');   // a client-page section (clientSections), not a transaction one
if (/id: 'audit-trail'/.test(rd('assets/js/rpt/audit-diff.js'))) ids.add('audit-trail');
check('every transaction section is mapped to a tab (' + ids.size + ')', () => {
  const missing = [...ids].filter(id => !MAP[id]);
  return (ids.size >= 18 && !missing.length) || 'missing: ' + missing.join(', ');
});
check('admin.js marks its own cards and calls txTabs after the sections', () =>
  (['adm-txc-summary', 'adm-txc-docs', 'adm-txc-log'].every(c => admin.includes("'" + c + "'") || admin.includes(c + '">'))
    && (admin.match(/'adm-txc-containers'/g) || []).length >= 2
    && /renderTxSections\(sections, t\);\n\s*txTabs\(out, t, sections\);/.test(admin)) || 'markers');
check('tabs are accessible: tablist / tab / tabpanel, aria-selected, arrow keys', () =>
  (/role: 'tablist'/.test(admin) && /role: 'tab'/.test(admin) && /role: 'tabpanel'/.test(admin) && /aria-selected/.test(admin) && /ArrowLeft/.test(admin)) || 'aria');
check('the opening tab follows the stage; the choice is kept per transaction (sessionStorage, guarded)', () =>
  (/TX_TAB_OF_STAGE = \{[^}]*appointment: 'transport'/.test(admin) && /sessionStorage/.test(admin) && /try \{ if \(v === undefined\)/.test(admin)) || 'stage');

const i18n = rd('assets/i18n/admin.js');
check('tab strings in ar + en', () => TABS.concat(['aria', 'flag_danger', 'flag_warning']).every(k => (i18n.match(new RegExp('txtab_' + k + ':', 'g')) || []).length === 2) || 'i18n');
check('flags: storage red / yellow, unclassified driver yellow', () =>
  (/data-tab-flag', v\.blocked \? 'danger' : 'warning'/.test(rd('assets/js/ops/tx-storage.js')) && /'data-tab-flag': 'warning'/.test(rd('assets/js/ops/drivers.js'))) || 'flags');
check('css for tabs and flags', () => (/\.adm-txtab\.is-active/.test(rd('assets/css/pages/admin.css')) && /\.adm-txtab-flag\.is-danger/.test(rd('assets/css/pages/admin.css'))) || 'css');
check('sw.js VERSION bumped for the tabs', () => /var VERSION = '[^']+';\s+\/\/ owner reorg: the transaction page in tabs/.test(rd('sw.js')) || 'sw');

console.log((fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

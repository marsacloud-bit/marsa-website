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
check('sw.js VERSION bumped for the tabs and the documents tab', () => /var VERSION = '[^']+';\s+\/\/ [^\n]*owner reorg: «إضافة مستند آخر»[^;]*; owner reorg: the transaction page in tabs/.test(rd('sw.js')) || 'sw');

// the «المستندات» tab: the upload folded as «إضافة مستند آخر» (a later document), the payment attachments listed there
check('documents card: the upload form is folded under «إضافة مستند آخر» with the hint', () =>
  (/<details class="adm-upload-more"><summary class="btn btn-sm btn-secondary">' \+ icon\('plus'\) \+ esc\(tl\('txdoc_add_other'\)\)/.test(admin)
    && /tl\('txdoc_add_hint'\)/.test(admin) && /ذكر السبب\.<\/p><\/details>';/.test(admin)
    && ['txdoc_add_other', 'txdoc_add_hint'].every(k => (i18n.match(new RegExp(k + ':', 'g')) || []).length === 2)
    && /\.adm-upload-more > summary/.test(rd('assets/css/pages/admin.css'))) || 'fold');
const FIN = rd('assets/js/fin/tx-fin.js');
check('payment attachments: a finance-reader section in the documents tab, no amounts', () =>
  (MAP['fin-pay-docs'] === 'docs' && /\{ id: 'fin-pay-docs', order: 79, render: renderPayDocs \}/.test(FIN)
    && /function renderPayDocs\(root, tx, api\) \{\n\s+if \(!api\.can\('finRead', tx\.branch_id\)\) return null;/.test(FIN)
    && !/money|share/.test(FIN.slice(FIN.indexOf('function renderPayDocs'), FIN.indexOf('var MINE = [')))
    && ['pdoc_title', 'pdoc_hint', 'pdoc_open'].every(k => (FIN.match(new RegExp(k + ':', 'g')) || []).length === 2)) || 'section');
{
  const vm = require('vm');
  const a = FIN.indexOf('function payDocRows('), b = FIN.indexOf('\n  function renderPayDocs');
  const box = {}; vm.createContext(box); vm.runInContext(FIN.slice(a, b) + '\nthis.f = payDocRows;', box);
  const items = [{ id: 'p1', ref: 'PAY-1', allocation_id: 'a1', paid_at: '2026-11-01' }, { id: 'p2', ref: 'PAY-2', allocation_id: 'a9', paid_at: '2026-11-02' }];
  const det = {
    p1: { documents: [{ id: 'd1', original_name: 'sadad.pdf', role: 'payment_proof', storage_path: 'o/b/1', allocation_id: null },
      { id: 'd2', original_name: 'old.pdf', role: 'extra', storage_path: 'o/b/2', removed_at: '2026-11-03' },
      { id: 'd3', original_name: 'void.pdf', role: 'extra', storage_path: null }] },
    p2: { documents: [{ id: 'd4', original_name: 'mine.pdf', role: 'entity_invoice', storage_path: 'o/b/4', allocation_id: 'a9' },
      { id: 'd5', original_name: 'other-tx.pdf', role: 'entity_invoice', storage_path: 'o/b/5', allocation_id: 'a2' }] }
  };
  const rows = box.f(items, det);
  check('payDocRows: live files only, a shared payment shows only the line of this transaction', () =>
    rows.map(r => r.id).join(',') === 'd1,d4' && rows[0].payRef === 'PAY-1' && rows[1].role === 'entity_invoice' || JSON.stringify(rows));
  check('payDocRows: a payment whose details did not load is skipped', () => box.f(items, { p2: det.p2 }).map(r => r.id).join(',') === 'd4' || 'skip');
}

// review fixes (batch 2): static checks for the shortcuts / toggle / notes
check('checklist «رفع»: opens the tab of the upload form, then the <details> fold, before the focus', () => {
  const sec = rd('assets/js/ops/tx-sections.js');
  const b = sec.slice(sec.indexOf('function uploadShortcut'), sec.indexOf('function classifyShortcut'));
  const iR = b.indexOf('api.revealInTab(form)'), iD = b.indexOf('fold.open = true'), iF = b.indexOf('f.focus()');
  return (iR > 0 && iD > iR && iF > iD) || [iR, iD, iF].join(',');
});
check('readiness «إثباتات إعادة الفارغ»: opens the «إرجاع الفارغ» tab before scrolling', () => {
  const ap = rd('assets/js/ops/tx-appt.js');
  const i = ap.indexOf("api.revealInTab(d)"), j = ap.indexOf("d.scrollIntoView({ behavior: 'smooth', block: 'start' })");
  return (i > 0 && j > i && MAP.empty_return === 'return') || [i, j].join(',');
});
check('admin.js: txOpsApi gives revealInTab; route() runs the view teardown before a new render', () =>
  (/a\.revealInTab = revealInTxTab;/.test(admin) && /runViewTeardown\(\);[^\n]*\n\s+view\.setAttribute\('aria-busy', 'true'\);/.test(admin)
    && /onViewTeardown\(stop\);/.test(admin)) || 'wiring');
check('drivers toggle: never guesses or forces a class — sends no driver_class / carrier_id (save_driver keeps them), no edit dialog', () => {
  const dr = rd('assets/js/ops/drivers.js');
  const b = dr.slice(dr.indexOf('function toggle(d)'), dr.indexOf('return load();', dr.indexOf('function toggle(d)')));
  const tr = dr.slice(dr.indexOf('function toggleRow('), dr.indexOf('// pure: does a directory row match'));
  return (/var row = toggleRow\(d, !off\);/.test(b) && !/drv2_toggle_need_class|edit\(d\)|'individual'|'company'/.test(b)
    && /delete row\.driver_class; delete row\.carrier_id; delete row\.truck_plate;/.test(tr)) || 'toggle';
});
check('#new-tx: the importer check failing shows «failed» (ar + en), the client list gets the focus back', () => {
  const om = rd('assets/js/ocr-match.js'), io = rd('assets/i18n/ocr.js');
  return (/if \(!m\) return D\.matchFailed \? 'failed' : 'pending';/.test(om) && /if \(!r \|\| r\.error \|\| !r\.data\) \{ D\.matchFailed = true; return; \}/.test(om)
    && /var again = \$\('ocr-nt-client'\);/.test(om) && (io.match(/nt_match_failed:/g) || []).length === 2) || 'new-tx';
});
check('nav icons: every app-shell NAV icon exists in ICONS («السائقون» no longer falls back to info)', () => {
  const sh = rd('assets/js/app-shell.js');
  const ic = sh.slice(sh.indexOf('var ICONS = {'), sh.indexOf('function icon(name'));
  const keys = new Set((ic.match(/^    ([a-z_]+):/gm) || []).map(x => x.trim().slice(0, -1)));
  const used = (sh.match(/href: '[^']+', icon: '([a-z_]+)'/g) || []).map(x => x.match(/icon: '([a-z_]+)'/)[1]);
  const missing = used.filter(u => !keys.has(u));
  return (used.length > 10 && !missing.length) || 'missing: ' + missing.join(',');
});
check('register «+N»: the list opens upwards in the last rows of a longer table', () =>
  /tbody tr:nth-last-child\(-n\+3\):not\(:nth-child\(-n\+3\)\) \.lrpt-ctr-pop \{ inset-block-start: auto; inset-block-end: calc\(100% \+ 4px\);/.test(rd('assets/css/pages/lrpt.css')) || 'css');

// txTabs in a real DOM (jsdom): the observer settles (no self-triggered loop), stops when the view leaves the page,
// arrow keys skip hidden tabs, revealInTxTab opens the tab of a node
let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { /* NODE_PATH without jsdom */ }
const pick = (name) => {
  const a = admin.indexOf('  function ' + name + '(');
  if (a === -1) throw new Error('no ' + name);
  const b = admin.indexOf('\n  }\n', a);
  return admin.slice(a, b + 4);
};
const pickVar = (re) => (admin.match(re) || [''])[0];
async function domTests() {
  if (!JSDOM) { check('jsdom available for the txTabs DOM checks', () => 'jsdom missing (NODE_PATH)'); return; }
  const dom = new JSDOM('<!doctype html><html dir="rtl"><body><main id="view"></main></body></html>', { pretendToBeVisual: true });
  const w = dom.window;
  const src = [
    pickVar(/var TX_TABS = \[[^\]]+\];/), pickVar(/var TX_TAB_OF = \{[\s\S]*?\};/), pickVar(/var TX_TAB_OF_STAGE = \{[^}]+\};/),
    pick('txTabStore'), pick('txTabs'), pick('revealInTxTab'),
    'var VIEW_TEARDOWN = [];', pick('onViewTeardown'), pick('runViewTeardown'),
    'this.txTabs = txTabs; this.reveal = revealInTxTab; this.teardown = runViewTeardown; this.count = function () { return VIEW_TEARDOWN.length; };'
  ].join('\n');
  const ctx = {
    BOOL: { hidden: true },
    el(tag, attrs, kids) {
      const n = w.document.createElement(tag);
      Object.keys(attrs || {}).forEach(k => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
        else if (k === 'hidden') n.hidden = true; else n.setAttribute(k, v === true ? '' : String(v));
      });
      (kids || []).forEach(c => c && n.appendChild(c));
      return n;
    },
    tl: (k) => k, OPS: { txSections: [{ id: 'storage', render() {} }, { id: 'empty_return', render() {} }, { id: 'checklist', render() {} }] }
  };
  const fn = new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', 'el', 'tl', 'OPS',
    src + '\nreturn this;').call({}, w, w.document, w.MutationObserver, w.setTimeout.bind(w), w.clearTimeout.bind(w), ctx.el, ctx.tl, ctx.OPS);
  const sleep = (ms) => new Promise(r => w.setTimeout(r, ms));
  // one transaction page: summary + docs cards, a storage section (flagged), an empty-return section, an empty checklist box
  const out = w.document.createDocumentFragment();
  const mk = (cls, text) => { const d = w.document.createElement('div'); d.className = cls; d.textContent = text; return d; };
  out.appendChild(mk('adm-txc-summary', 'summary'));
  out.appendChild(mk('adm-txc-docs', 'docs'));
  out.appendChild(mk('adm-txc-log', 'log'));
  const sections = w.document.createElement('div'); sections.className = 'ops-tx-sections'; out.appendChild(sections);
  const box = (id) => { const b = w.document.createElement('div'); b.setAttribute('data-section', id); sections.appendChild(b); return b; };
  const st = box('storage'); st.innerHTML = '<p data-tab-flag="danger">unpaid</p>';
  const er = box('empty_return'); er.innerHTML = '<section id="tx-empty-return">proofs</section>';
  box('checklist');
  fn.txTabs(out, { id: 't1', operational_status: 'new' }, sections);
  const view = w.document.getElementById('view');
  view.appendChild(out);
  const wrap = view.querySelector('.adm-txtabs-wrap');
  let records = 0;
  new w.MutationObserver((l) => { records += l.length; }).observe(wrap, { subtree: true, childList: true, attributes: true, characterData: true });
  st.querySelector('p').setAttribute('data-tab-flag', 'warning');   // one real change
  await sleep(250);
  const settled = records;
  await sleep(400);
  check('txTabs observer settles: no mutations while nothing changes (no self-triggered loop)', () => (records === settled) || ('still mutating: ' + settled + ' → ' + records));
  const cflag = wrap.querySelector('#txtab-containers .adm-txtab-flag');
  check('txTabs flag follows a real change (danger → warning)', () => (cflag.textContent === '!' && !cflag.hidden && /is-warning/.test(cflag.className)) || cflag.outerHTML);
  check('empty tabs hide (transport / finance), the opening tab follows the stage (docs)', () =>
    (wrap.querySelector('#txtab-transport').hidden && wrap.querySelector('#txtab-finance').hidden
      && wrap.querySelector('#txtab-docs').getAttribute('aria-selected') === 'true') || 'tabs');
  // arrow keys skip the hidden tabs: from «المستندات» (docs) the next shown in RTL ArrowLeft is «الحاويات» then «إرجاع الفارغ»
  const press = (k) => { const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true }); w.document.activeElement.dispatchEvent(e); return w.document.activeElement.getAttribute('data-txtab'); };
  wrap.querySelector('#txtab-docs').focus();
  const a1 = press('ArrowLeft'), a2 = press('ArrowLeft'), a3 = press('ArrowLeft'), a4 = press('End'), a5 = press('ArrowLeft');
  check('arrow keys skip hidden tabs (docs → containers → return → log; End = log; wraps to summary)', () =>
    [a1, a2, a3, a4, a5].join(',') === 'containers,return,log,log,summary' || [a1, a2, a3, a4, a5].join(','));
  // revealInTxTab: the empty-return section is in a hidden panel → its tab opens
  wrap.querySelector('#txtab-summary').click();
  const target = w.document.getElementById('tx-empty-return');
  const shownBefore = !target.closest('[data-txtab-panel]').hidden;
  const ok = fn.reveal(target);
  check('revealInTxTab opens the «إرجاع الفارغ» tab of a node in a hidden panel', () =>
    (!shownBefore && ok === true && wrap.querySelector('#txtab-return').getAttribute('aria-selected') === 'true') || 'reveal');
  await sleep(150);
  // teardown: the view registered its stop; route() → runViewTeardown disconnects; later mutations change nothing
  check('txTabs registers a view teardown', () => fn.count() === 1 || String(fn.count()));
  fn.teardown();
  view.textContent = '';
  st.querySelector('p').setAttribute('data-tab-flag', 'danger');
  await sleep(150);
  check('after the teardown the observer is disconnected (a later change is not re-checked)', () => cflag.textContent === '!' || cflag.textContent);
  // without route(): a tree that left the page stops by itself on its next mutation
  const out2 = w.document.createDocumentFragment();
  out2.appendChild(mk('adm-txc-summary', 'summary'));
  const sec2 = w.document.createElement('div'); out2.appendChild(sec2);
  const s2 = w.document.createElement('div'); s2.setAttribute('data-section', 'storage'); s2.innerHTML = '<p data-tab-flag="danger">x</p>'; sec2.appendChild(s2);
  fn.txTabs(out2, { id: 't2', operational_status: 'new' }, sec2);
  view.appendChild(out2);
  const wrap2 = view.querySelector('.adm-txtabs-wrap');
  await sleep(120);
  view.removeChild(wrap2);
  s2.querySelector('p').setAttribute('data-tab-flag', 'warning');
  await sleep(150);
  check('a detached tab tree stops watching itself (no flags() on a removed view)', () =>
    wrap2.querySelector('#txtab-containers .adm-txtab-flag').textContent === '✗' || 'still running');
  fn.teardown();
  w.close();
}

domTests().catch(e => check('txTabs DOM checks ran', () => String(e && e.stack || e))).then(() => {
  console.log((fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});

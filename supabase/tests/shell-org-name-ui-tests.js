#!/usr/bin/env node
/*
  Marsa (مرسى) — item 13 UI tests: the active organisation name in the staff dashboard header (assets/js/app-shell.js
  renderOrgNameSlots + assets/css/app.css .shell-org-name). Pure Node, no database, no network (vm + window shim +
  supabase/tests/lib/fake-dom.js; the real app-shell.js is loaded against a fake MarsaApi).

  Covers: the shell adds one [data-shell-orgname] slot right after admin.html's #adm-me-name (never twice), shows the
  active org (Arabic name, English name in English, the switched org for a multi-org user, slug fallback), text only
  (no innerHTML of server data; a "<img onerror>" name stays text), hidden while signed out / demo, no logo element
  (logo_path has no storage bucket yet), ES5 only in the new code, and the CSS keeps it on a phone (wrap, min-width 0).

  usage:  node supabase/tests/shell-org-name-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeDom } = require('./lib/fake-dom.js');

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
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }
const settle = (ms) => new Promise(r => setTimeout(r, ms || 0));

const SHELL = rd('assets/js/app-shell.js');
const CSS = rd('assets/css/app.css');
const DICT_SRC = rd('assets/i18n/app.js');

/* ------------------------------------------------------------ harness */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
function ctxFor(orgs) {
  return {
    profile: { full_name: 'موظف تجريبي', email: 'staff@example.test' },
    memberships: orgs.map(o => ({ org_id: o.id, org_slug: o.slug, org_name_ar: o.ar, org_name_en: o.en, role: 'clearance_staff', branch_id: null })),
    organizations: [], is_platform_admin: false
  };
}
function boot(opts) {
  const { document, Node } = makeDom();
  if (!Object.getOwnPropertyDescriptor(Node.prototype, 'nextSibling')) {
    Object.defineProperty(Node.prototype, 'nextSibling', { get() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; } });
  }
  if (!Node.prototype.removeChild) Node.prototype.removeChild = function (n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; };
  const htmlEl = new Node('html');
  htmlEl.setAttribute('lang', opts.lang || 'ar'); htmlEl.setAttribute('dir', opts.lang === 'en' ? 'ltr' : 'rtl');
  document.documentElement = htmlEl;
  document.title = 'لوحة الموظفين';
  // admin.html .adm-me
  const app = document.createElement('div'); app.id = 'adm-app';
  const me = document.createElement('div'); me.className = 'adm-me';
  const box = document.createElement('div');
  const strong = document.createElement('strong'); strong.id = 'adm-me-name'; strong.textContent = 'موظف تجريبي';
  const roles = document.createElement('span'); roles.id = 'adm-me-roles'; roles.className = 'text-xs text-muted';
  box.appendChild(strong); box.appendChild(roles); me.appendChild(box); app.appendChild(me);
  document.body.appendChild(app);
  if (opts.extraSlot) { const s = document.createElement('span'); s.setAttribute('data-shell-orgname', ''); s.id = 'extra'; document.body.appendChild(s); }

  const listeners = {};
  const state = { active: opts.active || ORG_A };
  const ok = d => Promise.resolve({ data: d, error: null });
  const api = opts.online === false ? { isOnline: () => false } : {
    isOnline: () => true,
    getSession: () => ok(opts.signedOut ? null : { user: { id: 'u1', email: 'staff@example.test' } }),
    myContext: () => ok(ctxFor(opts.orgs)),
    activeOrgId: () => ok(state.active),
    setActiveOrg: (id) => { state.active = id; win.dispatchEvent({ type: 'marsa:orgchange', detail: { orgId: id } }); return ok(id); },
    onAuth: () => {}, unreadAlertCount: () => ok(0), alertsOpenCount: () => ok(0)
  };
  const store = {};
  const win = {
    document, MarsaApi: api,
    MarsaI18n: { lang: () => opts.lang || 'ar' },
    MarsaAppDict: null,
    navigator: { platform: 'Linux', userAgent: 'node' },
    location: { pathname: '/admin.html', hash: '', search: '', href: 'https://example.test/admin.html', replace() {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach(f => f(e)); return true; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Event: function (type) { this.type = type; },
    console, Promise, Date, Math, JSON, Object, Array, String, Number, RegExp, Error, encodeURIComponent, isNaN
  };
  win.window = win; win.self = win;
  document.documentElement.addEventListener = () => {};
  // the shell's English / Arabic strings come from assets/i18n/app.js (window.MarsaAppDict)
  const dctx = vm.createContext(win);
  vm.runInContext(DICT_SRC, dctx, { filename: 'app.js' });
  vm.runInContext(SHELL, dctx, { filename: 'app-shell.js' });
  return { win, document, slot: () => document.body.querySelectorAll('[data-shell-orgname]') };
}
function textOf(n) { let s = ''; (function w(x) { if (x.tagName === '#TEXT') s += x._text; else if (x.children.length) x.children.forEach(w); else s += x.textContent || ''; })(n); return s; }

(async function main() {
  section('static: ES5, text only, wiring');
  const fn = (SHELL.match(/function renderOrgNameSlots\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  check('renderOrgNameSlots exists and is called from renderSlots', () => !!fn && /function renderSlots\(\) \{[^}]*renderOrgNameSlots\(\)/.test(SHELL) || 'missing');
  check('new code is ES5 (no let/const/arrow/template)', () => !/\b(let|const)\s|=>|`/.test(fn) || 'ES6 found');
  check('new code puts no data through innerHTML', () => !/innerHTML/.test(fn) || 'innerHTML used');
  check('label reuses the existing app.org_switch key (ar + en)', () => /org_switch: 'المؤسسة النشطة'/.test(DICT_SRC) && /org_switch: 'Active organization'/.test(DICT_SRC) && /t\('org_switch'\)/.test(fn) || 'key missing');
  check('CSS: .shell-org-name wraps on a phone (min-width 0, overflow-wrap) and hides with [hidden]', () =>
    /\.shell-org-name \{[^}]*min-width: 0/.test(CSS) && /\.shell-org-name-text \{[^}]*overflow-wrap: anywhere/.test(CSS)
    && /\.shell-org-name\[hidden\] \{ display: none; \}/.test(CSS) && /\.adm-me > div \{ min-width: 0; \}/.test(CSS) || 'css rules missing');
  check('CSS: no physical left/right in the new rules (RTL-safe)', () => {
    const block = (CSS.match(/\/\* \[data-shell-orgname\][\s\S]*?\.adm-me > div \{ min-width: 0; \}/) || [''])[0];
    return !!block && !/(margin|padding)-(left|right)|\b(left|right):/.test(block) || 'physical side found';
  });

  section('single org, Arabic');
  {
    const b = boot({ orgs: [{ id: ORG_A, slug: 'demo-a', ar: 'مؤسسة التجربة', en: 'Demo Org' }] });
    await settle(20);
    const s = b.slot();
    eq('one slot added', s.length, 1);
    const sl = s[0];
    check('slot sits right after #adm-me-name', () => { const p = sl.parentNode; return p.children.indexOf(sl) === p.children.indexOf(b.document.getElementById('adm-me-name')) + 1 || 'wrong place'; });
    eq('visible', sl.hidden, false);
    eq('shows the Arabic name in a <bdi>', (sl.querySelector('bdi') || {}).textContent, 'مؤسسة التجربة');
    eq('title names it as the active org', sl.getAttribute('title'), 'المؤسسة النشطة: مؤسسة التجربة');
    check('no logo <img> (no storage path for logo_path yet)', () => !sl.querySelector('img') || 'img found');
    b.win.dispatchEvent({ type: 'marsa:langchange' });
    eq('re-render does not duplicate the slot', b.slot().length, 1);
  }

  section('English + slug fallback + escaping');
  {
    const b = boot({ lang: 'en', orgs: [{ id: ORG_A, slug: 'demo-a', ar: 'مؤسسة التجربة', en: 'Demo Org' }] });
    await settle(20);
    eq('English name in English', (b.slot()[0].querySelector('bdi') || {}).textContent, 'Demo Org');
  }
  {
    const b = boot({ orgs: [{ id: ORG_A, slug: 'demo-a', ar: '', en: '' }] });
    await settle(20);
    eq('no names → slug', (b.slot()[0].querySelector('bdi') || {}).textContent, 'demo-a');
  }
  {
    const evil = '<img src=x onerror=alert(1)>';
    const b = boot({ orgs: [{ id: ORG_A, slug: 'demo-a', ar: evil, en: '' }] });
    await settle(20);
    const bdi = b.slot()[0].querySelector('bdi');
    eq('markup in a name stays text', bdi && bdi.textContent, evil);
    check('no element built from the name', () => !b.slot()[0].querySelector('img') && bdi.children.length === 0 || 'element created');
  }

  section('multi-org: the active org, follows a switch');
  {
    const b = boot({ active: ORG_B, extraSlot: true, orgs: [{ id: ORG_A, slug: 'demo-a', ar: 'مؤسسة أ', en: 'Org A' }, { id: ORG_B, slug: 'demo-b', ar: 'مؤسسة ب', en: 'Org B' }] });
    await settle(20);
    eq('declared [data-shell-orgname] slot + the added one', b.slot().length, 2);
    eq('shows the active org (B)', b.slot().map(n => (n.querySelector('bdi') || {}).textContent), ['مؤسسة ب', 'مؤسسة ب']);
    b.win.MarsaShell.switchOrg(ORG_A);
    await settle(20);
    eq('after switching: org A', b.slot().map(n => (n.querySelector('bdi') || {}).textContent), ['مؤسسة أ', 'مؤسسة أ']);
  }

  section('hidden when not signed in');
  {
    const b = boot({ signedOut: true, orgs: [] });
    await settle(20);
    eq('signed out: slot hidden and empty', [b.slot()[0].hidden, b.slot()[0].children.length], [true, 0]);
  }
  {
    const b = boot({ online: false, orgs: [] });
    await settle(20);
    eq('demo mode: slot hidden', b.slot()[0].hidden, true);
  }

  console.log((fail ? 'FAILED' : 'OK') + ' shell-org-name-ui-tests: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/*
  Marsa (مرسى) — staff dashboard shell: the org logo in the header, «شعار المؤسسة» (org settings) and the «القائمة»
  side menu. LOCAL TESTS ONLY: runs admin.html (scripts stripped) + i18n.js + i18n/admin.js + i18n/app.js +
  app-shell.js + admin.js in jsdom against a recording MarsaApi mock. No database, no network (fetch throws).
  Invented data only.

  Covers:
    * header logo (app-shell.js): MarsaApi.orgLogoPathOf → orgLogoUrl(path, 3600) once per path (cached for the page,
      re-render / language change do not ask again); the <img> stays hidden until it loaded, then replaces the building
      icon; an image error drops it (name only, no broken icon) and that path is not asked again; no path / a URL error →
      name only; an org switch shows the other org's logo; 'marsa:orglogochange' re-reads my_context.
    * «شعار المؤسسة» (admin.js #org): preview from orgLogoUrl, the free-text logo_path field is gone and the settings
      save no longer sends logo_path; client checks (no file / type / empty / > 1 MB) in Arabic without a call;
      uploadOrgLogo(org, file) → toast + 'marsa:orglogochange'; MRS_LOGO_TOO_LARGE / MRS_UPLOAD in Arabic; remove asks,
      then removeOrgLogo(org) + event.
    * «القائمة» (app-shell.js): button first in .adm-topbar-actions with aria-controls, aria-pressed (wide: layout) /
      aria-expanded (phone: drawer); drawer open = role=dialog + aria-modal, the page outside inert; default = the
      horizontal bar (no class, nothing stored); toggle → side menu, stored per device ('marsa_nav_layout'), restored
      on the next load, toggles back; a throwing localStorage keeps the default; every nav item / data-nav-id is the
      same in both layouts; phone width: overlay drawer + backdrop, focus moves in, Esc / backdrop / item click /
      close button close it, focus goes back to the button; widening the window closes it.
    * static: ES5 in the new code, localStorage only inside try, ar + en for every new key, RTL-safe CSS (logical
      sides only), the 375px rules (drawer ≤ 86vw, wrapping side menu).

  usage:  NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/shell-sidebar-logo-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const J = x => JSON.stringify(x);

let nPass = 0, nFail = 0;
const fails = [];
async function check(name, fn) {
  let r;
  try { r = await fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r === true) { nPass++; if (!QUIET) console.log('  ok  ' + name); }
  else { nFail++; const why = typeof r === 'string' ? r : J(r); fails.push(name + ' → ' + why); console.log('  FAIL ' + name + ' → ' + why); }
}
function section(t) { if (!QUIET) console.log('\n== ' + t); }
globalThis.fetch = async () => { throw new Error('network forbidden'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settle(ms) { await sleep(ms || 40); }

const ORG_A = 'f0a00000-0000-4000-8000-0000000000a1';
const ORG_B = 'f0a00000-0000-4000-8000-0000000000b2';
const U1 = 'f0a00000-0000-4000-8000-0000000000c1';
const LOGO_A = ORG_A + '/logo-1763290000000.png';
const LOGO_B = ORG_B + '/logo-1763290000001.webp';
const BASE = 'https://proj.supabase.test/storage/v1/object/sign/org-assets/';

const SHELL = rd('assets/js/app-shell.js'), CSS = rd('assets/css/app.css'), APP_DICT = rd('assets/i18n/app.js');
const ADMIN = rd('assets/js/admin.js'), ADMIN_DICT = rd('assets/i18n/admin.js');

/* ------------------------------------------------------------------ page */
function page(opts) {
  opts = opts || {};
  const html = rd('admin.html').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '');
  const dom = new JSDOM(html, { url: 'https://marsa.test/admin.html' + (opts.hash || '#dashboard'), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = globalThis.fetch;
  w.confirm = () => true;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  // controllable (max-width: 767px)
  const mq = { matches: !!opts.narrow, fns: [], addEventListener(t, f) { this.fns.push(f); }, removeEventListener() {} };
  w.matchMedia = q => (/max-width: 767px/.test(q) ? mq : { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  if (opts.store) Object.keys(opts.store).forEach(k => w.localStorage.setItem(k, opts.store[k]));
  if (opts.badStorage) {
    Object.defineProperty(w, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  }
  const calls = [], toasts = [], events = [];
  const rec = (n, a) => calls.push({ n, a });
  const ok = d => Promise.resolve({ data: d, error: null });
  const state = { active: opts.active || ORG_A, logoA: opts.logoA === undefined ? LOGO_A : opts.logoA, ctxReads: 0 };
  function ctx() {
    const orgs = [{ id: ORG_A, slug: 'org-a', ar: 'مؤسسة الاختبار', en: 'Test Org', logo: state.logoA }];
    if (opts.multi) orgs.push({ id: ORG_B, slug: 'org-b', ar: 'مؤسسة ثانية', en: 'Second Org', logo: LOGO_B });
    return {
      user_id: U1, profile: { full_name: 'منى الاختبار' }, is_platform_admin: false, clients: [],
      memberships: orgs.map(o => ({ org_id: o.id, org_slug: o.slug, org_name_ar: o.ar, org_name_en: o.en, role: opts.role || 'admin', branch_id: null, org_logo_path: o.logo })),
      organizations: orgs.map(o => ({ org_id: o.id, slug: o.slug, name_ar: o.ar, name_en: o.en, logo_path: o.logo }))
    };
  }
  const orgRow = () => ({ id: state.active, slug: 'org-a', name_ar: 'مؤسسة الاختبار', name_en: 'Test Org', ref_prefix: 'TST', environment: 'staging',
    public_intake_enabled: true, default_locale: 'ar', is_active: true, settings: state.logoA ? { logo_path: state.logoA, brand_color: '#0b3a6e' } : { brand_color: '#0b3a6e' } });
  const qb = { select() { return qb; }, eq() { return qb; }, order() { return qb; }, limit() { return qb; }, maybeSingle() { return Promise.resolve({ data: orgRow(), error: null }); } };
  const known = {
    isOnline: () => true,
    ready: () => ok(true),
    client: { from: () => qb },
    getSession: () => ok({ user: { id: U1, email: 'mona@example.test' } }),
    myContext: () => { state.ctxReads++; return ok(ctx()); },
    activeOrgId: () => ok(state.active),
    setActiveOrg: id => { state.active = id; w.dispatchEvent(new w.CustomEvent('marsa:orgchange', { detail: { orgId: id } })); return ok(id); },
    onAuth: () => {},
    orgLogoPathOf: (c, oid) => {
      const rows = [].concat(c.organizations || []).map(o => [o.org_id, o.logo_path]).concat([].concat(c.memberships || []).map(m => [m.org_id, m.org_logo_path]));
      const hit = rows.find(r => r[0] === oid && typeof r[1] === 'string' && r[1]);
      return hit ? hit[1] : null;
    },
    orgLogoUrl: (p, secs) => {
      rec('orgLogoUrl', { p, secs });
      if (opts.urlErr) return Promise.resolve({ data: null, error: { code: 'MRS_INVALID', message: 'bad' } });
      return ok(p ? BASE + p + '?token=t' + calls.length : null);
    },
    uploadOrgLogo: (oid, f) => {
      rec('uploadOrgLogo', { oid, name: f && f.name, type: f && f.type, size: f && f.size });
      if (opts.uploadErr) return Promise.resolve({ data: null, error: opts.uploadErr });
      state.logoA = ORG_A + '/logo-1763290009999.png';
      return ok({ logo_path: state.logoA, org: orgRow() });
    },
    removeOrgLogo: oid => { rec('removeOrgLogo', { oid }); state.logoA = null; return ok({ logo_path: null, org: orgRow() }); },
    updateOrg: (oid, payload) => { rec('updateOrg', { oid, payload }); return ok(orgRow()); },
    listBranches: () => ok([]),
    statusLabels: () => ok([]),
    errorMessage: e => (e && e.message) || 'error'
  };
  w.MarsaApi = new Proxy(known, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && !/^(then|toJSON)$/.test(k) ? () => ok([]) : undefined)) });
  w.Marsa = { toast: (m, t) => toasts.push({ m, t }) };
  w.addEventListener('marsa:orglogochange', e => events.push(e.detail));
  const errors = [];
  w.addEventListener('error', e => errors.push(String(e.message)));
  ['assets/js/i18n.js', 'assets/i18n/admin.js', 'assets/i18n/app.js', 'assets/js/app-shell.js', 'assets/js/admin.js'].forEach(f => {
    try { w.eval(rd(f) + '\n//# sourceURL=' + f); } catch (e) { errors.push(f + ': ' + e.message); }
  });
  // shell toasts land in the DOM; collect their text too
  const toastText = () => Array.prototype.map.call(w.document.querySelectorAll('.toast-text'), n => n.textContent).concat(toasts.map(x => x.m));
  return { dom, w, d: w.document, mq, calls, events, errors, state, toastText, of: n => calls.filter(c => c.n === n) };
}
const slots = P => Array.prototype.slice.call(P.d.querySelectorAll('[data-shell-orgname]'));
const headerSlot = P => P.d.getElementById('adm-me-name').parentNode.querySelector('[data-shell-orgname]');
function key(P, k) { P.d.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }

(async function main() {
  /* ================================================================ static */
  section('static');
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const es6 = src => /\b(let|const|class)\s+[A-Za-z_$]/.test(src) || /=>/.test(src) || /`/.test(src);
  const shellNew = (SHELL.match(/\/\* Org logo: MarsaApi\.orgLogoPathOf[\s\S]*?\n  var MAC = /) || [''])[0];
  const adminNew = (ADMIN.match(/\/\/ ORG LOGO \(20261202000100\): «شعار المؤسسة»[\s\S]*?\n  var EMAIL_RE/) || [''])[0];
  await check('new app-shell.js code (logo + nav layout) found and ES5', () => (shellNew.length > 2000 && !es6(strip(shellNew))) || 'missing or ES6');
  await check('new admin.js code («شعار المؤسسة») found and ES5', () => (adminNew.length > 1500 && !es6(strip(adminNew))) || 'missing or ES6');
  await check('whole files stay ES5 (app-shell.js, admin.js, i18n/app.js, i18n/admin.js)', () => {
    const bad = [['app-shell.js', SHELL], ['admin.js', ADMIN], ['i18n/app.js', APP_DICT], ['i18n/admin.js', ADMIN_DICT]].filter(x => es6(strip(x[1]))).map(x => x[0]);
    return !bad.length || bad.join(', ');
  });
  await check('new code builds no markup from data (no innerHTML in the logo / nav / logo-card code)', () => !/innerHTML/.test(shellNew) && !/innerHTML/.test(adminNew) || 'innerHTML');
  await check('every localStorage access of the nav layout sits inside try { }', () => {
    const lines = shellNew.split('\n').filter(l => /localStorage\./.test(l));
    return (lines.length >= 2 && lines.every(l => /try \{/.test(l))) || J(lines);
  });
  const appKeys = ['nav_menu', 'nav_layout_side', 'nav_layout_top', 'nav_drawer_open', 'nav_drawer_close'];
  const admKeys = ['org_logo_title', 'org_logo_alt', 'org_logo_none', 'org_logo_loading', 'org_logo_unavailable', 'org_logo_file', 'org_logo_hint',
    'org_logo_upload', 'org_logo_remove', 'org_logo_saved', 'org_logo_removed', 'org_logo_remove_title', 'org_logo_remove_text',
    'org_logo_err_required', 'org_logo_err_type', 'org_logo_err_empty', 'org_logo_err_size', 'org_logo_err_upload'];
  await check('i18n: every new key has Arabic + English (app.* and admin.*)', () => {
    const P = page();
    const I = P.w.MarsaI18n, miss = [];
    appKeys.map(k => 'app.' + k).concat(admKeys.map(k => 'admin.' + k)).forEach(k => {
      I.setLang && I.setLang('ar'); const ar = I.t(k);
      I.setLang && I.setLang('en'); const en = I.t(k);
      if (!ar || ar === k || !/[\u0600-\u06FF]/.test(ar) || !en || en === k || /[\u0600-\u06FF]/.test(en) || ar === en) miss.push(k);
    });
    I.setLang && I.setLang('ar');
    return !miss.length || miss.join(', ');
  });
  await check('«القائمة» label is exactly القائمة / Menu', () => /nav_menu: 'القائمة'/.test(APP_DICT) && /nav_menu: 'Menu'/.test(APP_DICT) || 'label');
  await check('«شعار المؤسسة» title wording', () => /org_logo_title: 'شعار المؤسسة'/.test(ADMIN_DICT) || 'title');
  const cssNew = (CSS.match(/\/\* \[data-shell-orgname\] org logo[\s\S]*?\.shell-nav-backdrop \{[^}]*\}/) || [''])[0];
  await check('CSS: new rules found and RTL-safe (logical sides only)', () =>
    (cssNew.length > 1000 && !/(margin|padding|border)-(left|right)|[^-]\b(left|right)\s*:|text-align:\s*(left|right)/.test(cssNew)) || 'physical side or missing');
  await check('CSS: drawer on the start side, ≤ 86vw, backdrop, phone hides the side menu until opened', () =>
    /@media \(max-width: 767px\)[\s\S]*\.adm-app\.shell-nav-side \.adm-nav \{ display: none; \}/.test(cssNew)
    && /\.adm-app\.shell-nav-open \.adm-nav \{[^}]*position: fixed;[^}]*inset-inline-start: 0;[^}]*width: min\(300px, 86vw\)/.test(cssNew)
    && /overflow-x: hidden/.test(cssNew) && /\.shell-nav-backdrop \{ position: fixed; inset: 0;/.test(cssNew) || 'drawer rules');
  await check('CSS: side menu wraps (white-space normal, min-width 0 view column) and the default bar is untouched', () =>
    /white-space: normal/.test(cssNew) && /grid-template-columns: minmax\(190px, 240px\) minmax\(0, 1fr\)/.test(cssNew)
    && /\.adm-app\.shell-nav-side:not\(\[hidden\]\)/.test(cssNew)
    && !/^\.adm-nav(-list|-link)? \{/m.test(cssNew) || 'side rules');
  await check('CSS: header logo has a bounded size, hidden until loaded, replaces the icon', () =>
    /\.shell-org-logo \{[^}]*height: 22px;[^}]*max-width: 72px/.test(cssNew) && /\.shell-org-logo\[hidden\] \{ display: none; \}/.test(cssNew)
    && /\.shell-org-name\.has-logo > \.icon \{ display: none; \}/.test(cssNew) || 'logo css');
  await check('org settings form no longer has the free-text logo_path field / sends logo_path', () =>
    !/name: 'logo_path'/.test(ADMIN) && !/logo_path: v\('logo_path'\)/.test(ADMIN) || 'still there');
  await check('no aal2 / MFA requirement added by this change', () => !/aal2|mfaState|MRS_MFA/.test(shellNew + adminNew) || 'mfa reference');

  /* ================================================================ header logo */
  section('header logo');
  {
    const P = page();
    await settle(80);
    const s = headerSlot(P);
    await check('page booted without errors', () => !P.errors.length || J(P.errors));
    await check('name slot visible with the org name', () => (s && !s.hidden && s.querySelector('bdi').textContent === 'مؤسسة الاختبار') || (s && s.textContent));
    const img = s.querySelector('img.shell-org-logo');
    await check('orgLogoUrl asked once for the active path, 3600 s', () => J(P.of('orgLogoUrl').map(c => c.a)) === J([{ p: LOGO_A, secs: 3600 }]) || J(P.of('orgLogoUrl')));
    await check('<img> is inserted hidden (no broken icon before load), alt empty + aria-hidden, before the name', () =>
      (img && img.hidden && img.getAttribute('alt') === '' && img.getAttribute('aria-hidden') === 'true' && s.firstChild === img
        && img.getAttribute('src').indexOf(BASE + LOGO_A) === 0 && !s.classList.contains('has-logo')) || (img ? img.outerHTML : 'no img'));
    img.dispatchEvent(new P.w.Event('load'));
    await check('after load: shown and the building icon is replaced (.has-logo)', () => (!img.hidden && s.classList.contains('has-logo')) || 'not shown');
    P.w.dispatchEvent(new P.w.CustomEvent('marsa:langchange'));
    await settle(20);
    await check('a re-render reuses the cached URL (no new orgLogoUrl call), same src', () => {
      const i2 = headerSlot(P).querySelector('img.shell-org-logo');
      return (P.of('orgLogoUrl').length === 1 && i2 && i2.getAttribute('src') === img.getAttribute('src')) || P.of('orgLogoUrl').length;
    });
    const i2 = headerSlot(P).querySelector('img.shell-org-logo');
    i2.dispatchEvent(new P.w.Event('error'));
    await check('image error: img removed, name only', () => (!headerSlot(P).querySelector('img') && !headerSlot(P).classList.contains('has-logo') && headerSlot(P).querySelector('bdi').textContent === 'مؤسسة الاختبار') || 'img left');
    P.w.dispatchEvent(new P.w.CustomEvent('marsa:langchange'));
    await settle(20);
    await check('a failed path is not tried again on this page', () => (P.of('orgLogoUrl').length === 1 && !headerSlot(P).querySelector('img')) || P.of('orgLogoUrl').length);
    const before = P.state.ctxReads;
    P.state.logoA = ORG_A + '/logo-1763290005555.png';
    P.w.dispatchEvent(new P.w.CustomEvent('marsa:orglogochange', { detail: { orgId: ORG_A, logo_path: P.state.logoA } }));
    await settle(60);
    await check("'marsa:orglogochange' re-reads my_context and asks for the new path", () =>
      (P.state.ctxReads > before && P.of('orgLogoUrl').map(c => c.a.p).indexOf(P.state.logoA) !== -1 && !!headerSlot(P).querySelector('img.shell-org-logo')) || J(P.of('orgLogoUrl')));
  }
  {
    const P = page({ logoA: null });
    await settle(80);
    await check('no logo_path: name only, no URL request, no img', () => (!P.of('orgLogoUrl').length && !headerSlot(P).querySelector('img') && !headerSlot(P).hidden) || 'unexpected');
  }
  {
    const P = page({ urlErr: true });
    await settle(80);
    await check('orgLogoUrl error: name only, no img', () => (P.of('orgLogoUrl').length === 1 && !headerSlot(P).querySelector('img') && !!headerSlot(P).querySelector('bdi')) || 'img');
  }
  {
    const P = page({ multi: true });
    await settle(80);
    P.w.MarsaShell.switchOrg(ORG_B);
    await settle(80);
    await check('org switch: the other org name + its own logo path', () => {
      const s = headerSlot(P), img = s.querySelector('img.shell-org-logo');
      return (s.querySelector('bdi').textContent === 'مؤسسة ثانية' && img && img.getAttribute('src').indexOf(BASE + LOGO_B) === 0
        && P.of('orgLogoUrl').map(c => c.a.p).join() === [LOGO_A, LOGO_B].join()) || J(P.of('orgLogoUrl'));
    });
    P.w.MarsaShell.switchOrg(ORG_A);
    await settle(80);
    await check('switching back reuses the cached URL of org A', () => (P.of('orgLogoUrl').length === 2 && headerSlot(P).querySelector('img').getAttribute('src').indexOf(BASE + LOGO_A) === 0) || P.of('orgLogoUrl').length);
  }

  /* ================================================================ «شعار المؤسسة» */
  section('«شعار المؤسسة» (admin.js #org)');
  {
    const P = page({ hash: '#org' });
    await settle(120);
    const view = P.d.getElementById('adm-view');
    const card = Array.prototype.find.call(view.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
    await check('card «شعار المؤسسة» is rendered in the org view', () => !!card || view.textContent.slice(0, 300));
    const pImg = card.querySelector('img.adm-logo-img');
    await check('preview asks orgLogoUrl for the stored path and stays hidden until it loaded', () =>
      (P.of('orgLogoUrl').some(c => c.a.p === LOGO_A) && pImg && pImg.hidden && pImg.getAttribute('src').indexOf(BASE + LOGO_A) === 0 && pImg.getAttribute('alt') === 'شعار المؤسسة الحالي') || (pImg && pImg.outerHTML));
    pImg.dispatchEvent(new P.w.Event('load'));
    await check('preview shown after load', () => !pImg.hidden || 'hidden');
    await check('the settings form has no logo_path text field', () => !view.querySelector('[name="logo_path"]') || 'field present');
    const file = card.querySelector('input[type="file"]');
    await check('file input accepts png / jpeg / webp, labelled', () => (file && file.getAttribute('accept') === 'image/png,image/jpeg,image/webp' && !!card.querySelector('label[for="' + file.id + '"]')) || 'input');
    const btns = Array.prototype.slice.call(card.querySelectorAll('button'));
    const up = btns.find(b => b.textContent === 'رفع الشعار'), rm = btns.find(b => b.textContent === 'إزالة الشعار');
    const err = card.querySelector('.form-error');
    await check('upload + remove buttons present', () => (!!up && !!rm) || btns.map(b => b.textContent).join('|'));
    const setFile = f => { Object.defineProperty(file, 'files', { configurable: true, get: () => (f ? [f] : []) }); file.dispatchEvent(new P.w.Event('change')); };
    up.click(); await settle(20);
    await check('no file chosen → Arabic error, no call', () => (!err.hidden && /اختر ملف الشعار/.test(err.textContent) && !P.of('uploadOrgLogo').length) || err.textContent);
    setFile(new P.w.File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));
    await check('a GIF → type error on change (Arabic)', () => (!err.hidden && /PNG أو JPG أو WEBP/.test(err.textContent)) || err.textContent);
    up.click(); await settle(20);
    await check('… and the upload is blocked without a call', () => !P.of('uploadOrgLogo').length || 'called');
    setFile(new P.w.File([], 'empty.png', { type: 'image/png' }));
    up.click(); await settle(20);
    await check('an empty file → Arabic error, no call', () => (/فارغ/.test(err.textContent) && !P.of('uploadOrgLogo').length) || err.textContent);
    setFile(new P.w.File([new Uint8Array(1048577)], 'big.png', { type: 'image/png' }));
    up.click(); await settle(20);
    await check('> 1 MB → Arabic size error, no call', () => (/أكبر من 1 ميغابايت/.test(err.textContent) && !P.of('uploadOrgLogo').length) || err.textContent);
    setFile(new P.w.File([new Uint8Array(2048)], 'logo.png', { type: 'image/png' }));
    await check('a valid file clears the error', () => err.hidden || err.textContent);
    const addr = view.querySelector('form.adm-org-form [name="address_ar"]'), color = view.querySelector('form.adm-org-form [name="brand_color"]');
    addr.value = 'عنوان لم يُحفظ بعد'; color.value = '#123456';
    up.click(); await settle(120);
    await check('valid PNG → uploadOrgLogo(active org, file)', () => J(P.of('uploadOrgLogo').map(c => c.a)) === J([{ oid: ORG_A, name: 'logo.png', type: 'image/png', size: 2048 }]) || J(P.of('uploadOrgLogo')));
    await check("success → toast + 'marsa:orglogochange' with the new path (the header follows)", () =>
      (P.toastText().some(x => /حُفظ شعار المؤسسة/.test(x)) && P.events.length === 1 && P.events[0].orgId === ORG_A && P.events[0].logo_path === ORG_A + '/logo-1763290009999.png') || J([P.toastText(), P.events]));
    await check('the header asked for the new logo after the event', () => P.of('orgLogoUrl').some(c => c.a.p === ORG_A + '/logo-1763290009999.png') || J(P.of('orgLogoUrl')));
    await check('no updateOrg from the logo flow (MarsaApi does it)', () => !P.of('updateOrg').length || 'updateOrg called');
    await check('after the upload only the logo card is rebuilt: unsaved settings edits are kept, the card previews the new path', () => {
      const f2 = view.querySelector('form.adm-org-form');
      const c2 = Array.prototype.find.call(view.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
      const i2 = c2 && c2.querySelector('img.adm-logo-img');
      return (f2 && f2.querySelector('[name="address_ar"]') === addr && addr.value === 'عنوان لم يُحفظ بعد' && color.value === '#123456'
        && c2 !== card && !card.parentNode && i2 && (i2.getAttribute('src') || '').indexOf(BASE + ORG_A + '/logo-1763290009999.png') === 0
        && view.querySelectorAll('#adg-logo-file').length === 1) || J({ a: addr.value, c: color.value, src: i2 && i2.getAttribute('src') });
    });
  }
  {
    const P = page({ hash: '#org', uploadErr: { code: 'MRS_LOGO_TOO_LARGE', message: 'x' } });
    await settle(120);
    const card = Array.prototype.find.call(P.d.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
    const file = card.querySelector('input[type="file"]');
    Object.defineProperty(file, 'files', { configurable: true, get: () => [new P.w.File([new Uint8Array(10)], 'l.webp', { type: 'image/webp' })] });
    Array.prototype.find.call(card.querySelectorAll('button'), b => b.textContent === 'رفع الشعار').click();
    await settle(80);
    const err = card.querySelector('.form-error');
    await check('server MRS_LOGO_TOO_LARGE → Arabic size message, no event', () => (!err.hidden && /أكبر من 1 ميغابايت/.test(err.textContent) && !P.events.length) || err.textContent);
  }
  {
    const P = page({ hash: '#org', uploadErr: { code: 'MRS_UPLOAD', message: 'x' } });
    await settle(120);
    const card = Array.prototype.find.call(P.d.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
    const file = card.querySelector('input[type="file"]');
    Object.defineProperty(file, 'files', { configurable: true, get: () => [new P.w.File([new Uint8Array(10)], 'l.jpg', { type: 'image/jpeg' })] });
    Array.prototype.find.call(card.querySelectorAll('button'), b => b.textContent === 'رفع الشعار').click();
    await settle(80);
    await check('MRS_UPLOAD → «تعذّر رفع الشعار»', () => /تعذّر رفع الشعار/.test(card.querySelector('.form-error').textContent) || card.querySelector('.form-error').textContent);
  }
  {
    const P = page({ hash: '#org' });
    await settle(120);
    const card = Array.prototype.find.call(P.d.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
    Array.prototype.find.call(card.querySelectorAll('button'), b => b.textContent === 'إزالة الشعار').click();
    await settle(40);
    const dlg = P.d.querySelector('.app-modal');
    await check('remove asks first (shell confirm, danger)', () => (dlg && /إزالة شعار المؤسسة؟/.test(dlg.textContent) && !P.of('removeOrgLogo').length) || 'no dialog');
    Array.prototype.find.call(dlg.querySelectorAll('button'), b => b.textContent === 'إزالة الشعار').click();
    await settle(120);
    await check("confirmed → removeOrgLogo(org) + toast + event (logo_path null)", () =>
      (J(P.of('removeOrgLogo').map(c => c.a)) === J([{ oid: ORG_A }]) && P.toastText().some(x => /أُزيل شعار المؤسسة/.test(x)) && P.events.length === 1 && P.events[0].logo_path === null) || J([P.of('removeOrgLogo'), P.events]));
    await check('after removal: the header shows the name only', () => (!headerSlot(P).querySelector('img') && headerSlot(P).querySelector('bdi').textContent === 'مؤسسة الاختبار') || 'img');
    const card2 = Array.prototype.find.call(P.d.querySelectorAll('.adm-card'), c => /شعار المؤسسة/.test(c.querySelector('h3').textContent));
    await check('after removal: the card says there is no logo and offers no remove button', () =>
      (card2 && /لا يوجد شعار بعد/.test(card2.textContent) && !Array.prototype.some.call(card2.querySelectorAll('button'), b => b.textContent === 'إزالة الشعار')) || (card2 && card2.textContent));
  }
  {
    const P = page({ hash: '#org' });
    await settle(120);
    const form = P.d.querySelector('form.adm-org-form');
    form.dispatchEvent(new P.w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(60);
    await check('saving the settings form does not send settings.logo_path (kept by admin_update_org)', () => {
      const u = P.of('updateOrg')[0];
      return (u && u.a.payload.settings && !('logo_path' in u.a.payload.settings)) || J(P.of('updateOrg'));
    });
  }

  /* ================================================================ «القائمة» */
  section('«القائمة» side menu');
  const navIds = P => Array.prototype.map.call(P.d.querySelectorAll('#adm-nav [data-nav-id]'), a => a.getAttribute('data-nav-id') + '|' + a.getAttribute('href'));
  {
    const P = page();
    await settle(80);
    const app = P.d.getElementById('adm-app'), wrap = P.d.getElementById('adm-nav').parentNode;
    const btn = P.d.querySelector('.shell-nav-toggle');
    await check('button «القائمة» is first in .adm-topbar-actions, type=button', () =>
      (btn && btn.parentNode.classList.contains('adm-topbar-actions') && btn.parentNode.firstElementChild === btn && btn.type === 'button' && btn.textContent.trim() === 'القائمة') || (btn && btn.outerHTML));
    await check('aria-controls names the nav container (given an id); wide: aria-pressed=false, no aria-expanded (nothing is hidden)', () =>
      (wrap.id && btn.getAttribute('aria-controls') === wrap.id && btn.getAttribute('aria-pressed') === 'false' && !btn.hasAttribute('aria-expanded')) || btn.outerHTML);
    await check('default = horizontal bar: no layout class, nothing stored', () =>
      (!app.classList.contains('shell-nav-side') && !app.classList.contains('shell-nav-open') && P.w.localStorage.getItem('marsa_nav_layout') === null) || app.className);
    const before = navIds(P);
    await check('nav has its items (admin role)', () => before.length > 10 || J(before));
    btn.click();
    await check('click → side menu (.shell-nav-side), aria-pressed=true, stored per device', () =>
      (app.classList.contains('shell-nav-side') && btn.getAttribute('aria-pressed') === 'true' && !btn.hasAttribute('aria-expanded') && P.w.localStorage.getItem('marsa_nav_layout') === 'side') || app.className);
    await check('same nav items + hrefs in the side menu', () => J(navIds(P)) === J(before) || J(navIds(P)));
    await check('no backdrop / drawer on a wide screen', () => !P.d.querySelector('.shell-nav-backdrop') && !app.classList.contains('shell-nav-open') || 'drawer opened');
    P.w.MarsaShell.setBadge('transactions', 7);
    await check('badges still paint in the side menu', () => {
      const a = P.d.querySelector('#adm-nav [data-nav-id="transactions"] .nav-count');
      return (a && a.textContent === '7') || 'no badge';
    });
    btn.click();
    await check('click again → back to the horizontal bar, stored value removed', () =>
      (!app.classList.contains('shell-nav-side') && btn.getAttribute('aria-pressed') === 'false' && P.w.localStorage.getItem('marsa_nav_layout') === null) || app.className);
    P.w.MarsaI18n.setLang && P.w.MarsaI18n.setLang('en');
    await settle(20);
    await check('English: the button says Menu (one button only)', () => (P.d.querySelectorAll('.shell-nav-toggle').length === 1 && P.d.querySelector('.shell-nav-toggle').textContent.trim() === 'Menu') || P.d.querySelector('.shell-nav-toggle').textContent);
  }
  {
    const P = page({ store: { marsa_nav_layout: 'side' } });
    await settle(80);
    await check('stored side layout is restored on load', () => (P.d.getElementById('adm-app').classList.contains('shell-nav-side') && P.d.querySelector('.shell-nav-toggle').getAttribute('aria-pressed') === 'true') || 'not restored');
  }
  {
    const P = page({ badStorage: true });
    await settle(80);
    const btn = P.d.querySelector('.shell-nav-toggle'), app = P.d.getElementById('adm-app');
    await check('blocked localStorage: page boots, default bar', () => (!P.errors.length && btn && !app.classList.contains('shell-nav-side')) || J(P.errors));
    btn.click();
    await check('blocked localStorage: toggle still works for this view', () => app.classList.contains('shell-nav-side') || 'no toggle');
  }
  {
    const P = page({ narrow: true });
    await settle(80);
    const app = P.d.getElementById('adm-app'), wrap = P.d.getElementById('adm-nav').parentNode;
    const btn = P.d.querySelector('.shell-nav-toggle');
    btn.focus();
    btn.click();
    await settle(20);
    const bd = P.d.querySelector('.shell-nav-backdrop');
    await check('phone: the button opens the drawer (.shell-nav-open + backdrop), aria-expanded=true, layout not stored', () =>
      (app.classList.contains('shell-nav-open') && bd && btn.getAttribute('aria-expanded') === 'true' && P.w.localStorage.getItem('marsa_nav_layout') === null) || app.className);
    await check('phone: no aria-pressed; the open drawer is a modal dialog (role=dialog, aria-modal, labelled by the nav aria-label)', () =>
      (!btn.hasAttribute('aria-pressed') && wrap.getAttribute('role') === 'dialog' && wrap.getAttribute('aria-modal') === 'true' && !!wrap.getAttribute('aria-label')) || wrap.outerHTML.slice(0, 200));
    await check('phone: everything outside the drawer is inert (topbar, #adm-view, header), the backdrop is not', () => {
      const view = P.d.getElementById('adm-view'), top = app.querySelector('.adm-topbar');
      const outside = Array.prototype.filter.call(P.d.body.children, n => !n.contains(wrap) && n !== bd && !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName) && !n.classList.contains('toast-stack'));
      return (view.closest('[inert]') && top.closest('[inert]') && !wrap.closest('[inert]') && !bd.hasAttribute('inert') && outside.every(n => n.hasAttribute('inert'))) || 'not inert';
    });
    await check('phone: focus moves into the drawer', () => wrap.contains(P.d.activeElement) || (P.d.activeElement && P.d.activeElement.outerHTML));
    await check('phone: page scroll locked while open', () => P.d.documentElement.classList.contains('app-lock') || 'no lock');
    const close = wrap.querySelector('.shell-nav-close');
    await check('close button in the drawer has an Arabic label', () => (close && close.getAttribute('aria-label') === 'إغلاق قائمة الأقسام') || (close && close.outerHTML));
    key(P, 'Escape');
    await settle(10);
    await check('Escape closes, focus back on «القائمة», lock released', () =>
      (!app.classList.contains('shell-nav-open') && !P.d.querySelector('.shell-nav-backdrop') && P.d.activeElement === btn && btn.getAttribute('aria-expanded') === 'false'
        && !P.d.documentElement.classList.contains('app-lock')) || [app.className, P.d.activeElement && P.d.activeElement.className].join(' / '));
    await check('closed: role / aria-modal removed, nothing left inert', () =>
      (!wrap.hasAttribute('role') && !wrap.hasAttribute('aria-modal') && !P.d.querySelector('[inert]')) || (P.d.querySelector('[inert]') || wrap).outerHTML.slice(0, 200));
    btn.click(); await settle(10);
    P.d.querySelector('.shell-nav-backdrop').click();
    await check('backdrop click closes', () => (!app.classList.contains('shell-nav-open') && !P.d.querySelector('.shell-nav-backdrop')) || app.className);
    btn.click(); await settle(10);
    const link = wrap.querySelector('a.adm-nav-link[href="#transactions"]');
    link.click();
    await settle(20);
    await check('item click closes the drawer and navigates', () => (!app.classList.contains('shell-nav-open') && P.w.location.hash === '#transactions') || [app.className, P.w.location.hash].join(' '));
    btn.click(); await settle(10);
    close.click();
    await check('close button closes', () => !app.classList.contains('shell-nav-open') || app.className);
    btn.click(); await settle(10);
    key(P, 'Tab');
    await check('Tab stays inside the open drawer', () => wrap.contains(P.d.activeElement) || (P.d.activeElement && P.d.activeElement.outerHTML));
    P.mq.matches = false; P.mq.fns.forEach(f => f());
    await check('widening the window closes the drawer', () => (!app.classList.contains('shell-nav-open') && !P.d.querySelector('.shell-nav-backdrop')) || app.className);
  }
  {
    const P = page({ narrow: true, store: { marsa_nav_layout: 'side' } });
    await settle(80);
    const app = P.d.getElementById('adm-app');
    await check('phone + stored side layout: drawer stays closed until asked', () => (app.classList.contains('shell-nav-side') && !app.classList.contains('shell-nav-open') && P.d.querySelector('.shell-nav-toggle').getAttribute('aria-expanded') === 'false') || app.className);
  }
  {
    // the role rules are untouched: a clearance officer gets no «المؤسسة» item in either layout
    const P = page({ role: 'clearance_staff', store: { marsa_nav_layout: 'side' } });
    await settle(80);
    const ids = navIds(P).map(x => x.split('|')[0]);
    await check('permissions unchanged in the side menu (clearance staff: no org / members items)', () => (ids.length && ids.indexOf('org') === -1 && ids.indexOf('members') === -1 && ids.indexOf('transactions') !== -1) || J(ids));
  }

  console.log('\nshell-sidebar-logo-ui-tests: ' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);   // app-shell.js arms its badge timers (a page lifetime)
})().catch(e => { console.error(e); process.exit(1); });

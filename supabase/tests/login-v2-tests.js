#!/usr/bin/env node
/*
  Sign-in page in the new calm design (owner, 23 Nov 2026). LOCAL, static.
  Covers: <html class="login-v2"> + login-v2.css after login.css (precached); the top bar (office brand via
  site-profile.js, back to the site, the language button); the welcome panel texts in Arabic and English; every
  form / id the sign-in code uses is still there; the office-site header / footer hidden by CSS, not deleted.
  Three office tiers (owner, 15 Dec 2026): «دخول المؤسسة» #org / «دخول الإدارة» #management / «دخول الموظفين» #staff share
  the staff form, a small client link under them opens the client panel (#client, #signup); auth.js routeByRole(expectTier):
  the right tier → admin.html#team (org) or #dashboard (mgmt / staff), a ?next= still wins; the wrong tier → signed out +
  a message naming the right tab with a button to it. A tier is enforced only after a tab click / keyboard selection or on
  the new #org / #management links — the legacy #staff link, no hash and the e-mail code login route by the user's own tiers;
  the tier check runs after the two-step step (aal2); userTiers trusts my_context's is_owner (fallback only when absent). Static checks + login.html / main.js / auth.js in jsdom (fake MarsaApi).
  usage: NODE_PATH=<deps>/node_modules node supabase/tests/login-v2-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
let nPass = 0, nFail = 0; const fails = [];
function record(name, r) {
  if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); } else { nFail++; fails.push(name + ' — ' + r); console.log('FAIL  ' + name + '\n        ' + r); }
}
function check(name, fn) {
  let r; try { r = fn(); } catch (e) { r = 'threw: ' + e.message; }
  record(name, r);
}
async function acheckTop(name, fn) {
  let r; try { r = await fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  record(name, r);
}
const J = JSON.stringify;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('login.html'), css = read('assets/css/pages/login-v2.css'), dict = read('assets/i18n/login.js'), sw = read('sw.js');

check('login.html: class login-v2, login-v2.css after login.css, site-profile.js loaded after auth.js', () =>
  (/<html[^>]*class="no-js login-v2"/.test(html) && html.indexOf('pages/login.css') < html.indexOf('pages/login-v2.css')
    && html.indexOf('js/auth.js') < html.indexOf('js/site-profile.js')) || 'html');
check('top bar: office brand (data-site-brand / data-site-logo), back to the site, one language button', () =>
  (/class="lg-top"/.test(html) && /class="lg-brand"[^>]*data-site-brand/.test(html) && /<img data-site-logo/.test(html)
    && /class="lg-back" href="office.html"/.test(html) && (html.match(/data-lang-toggle/g) || []).length === 1) || 'top bar');
check('every sign-in form and field id the code uses is kept', () => {
  const ids = ['client-signin-form', 'client-signup-form', 'staff-signin-form', 'otp-request-form', 'otp-verify-form', 'forgot-form', 'reset-form',
    'invite-signin-form', 'invite-signup-form', 'ci-email', 'ci-password', 'st-email', 'st-password', 'tab-org', 'tab-management', 'tab-staff',
    'client-link', 'client', 'staff', 'page-title'];
  const miss = ids.filter(id => !html.includes('id="' + id + '"'));
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('the office-site chrome is hidden by CSS, not deleted', () =>
  (/class="site-header"/.test(html) && /class="site-footer"/.test(html) && /\.login-v2 \.site-header/.test(css) && /\.login-v2 \.site-footer/.test(css)
    && /display: none !important/.test(css)) || 'chrome');
check('welcome-panel texts exist in Arabic and English', () => {
  const keys = ['v2Back', 'v2Kicker', 'v2Hello', 'v2Lead', 'v2Pt1', 'v2Pt2', 'v2Pt3'];
  const miss = keys.filter(k => (dict.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('layout: two halves, one column on small screens, start-aligned text, sticky panel', () =>
  (/grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css) && /max-width: 900px/.test(css) && /text-align: start/.test(css) && /position: sticky/.test(css)) || 'css');
check('sw.js precaches login-v2.css', () => /'assets\/css\/pages\/login-v2\.css'/.test(sw) || 'sw');

/* ------------------------------------------------------------------ the three office tiers: static */
const auth = read('assets/js/auth.js');
const TIER_KEYS = ['tierOrgTab', 'tierMgmtTab', 'tierStaffTab', 'tierOrgLead', 'tierMgmtLead', 'clientLink', 'teamLink', 'tierMismatch', 'tierGoTo'];
function dictionaries() {
  let reg = null;
  require('vm').runInNewContext(dict, { window: { MarsaI18n: { register: (ns, d) => { reg = d; } } } });
  return reg;
}
const D = dictionaries();
check('three tier tabs in order (org, management, staff), each a tab of the shared staff panel with its #hash; the staff tab selected by default', () => {
  const m = html.match(/<button class="tab"[^>]*role="tab"[^>]*>/g) || [];
  const ids = m.map(t => (/id="([^"]+)"/.exec(t) || [])[1]);
  const ok = J(ids) === J(['tab-org', 'tab-management', 'tab-staff'])
    && /id="tab-org"[^>]*aria-controls="staff" data-tab-hash="org" data-tier="org" data-i18n="login.tierOrgTab">دخول المؤسسة</.test(html)
    && /id="tab-management"[^>]*aria-controls="staff" data-tab-hash="management" data-tier="mgmt" data-i18n="login.tierMgmtTab">دخول الإدارة</.test(html)
    && /id="tab-staff" aria-selected="true" aria-controls="staff" data-tab-hash="staff" data-tier="staff" data-i18n="login.tierStaffTab">دخول الموظفين</.test(html)
    && !/id="tab-client"/.test(html);
  return ok || J(ids);
});
check('the client link under the tiers opens the client panel; the way back to the tiers exists (hidden at first)', () => {
  const tabs = html.indexOf('id="tab-staff"'), staff = html.indexOf('id="staff"'), link = html.indexOf('id="client-link"'), forgot = html.indexOf('data-auth-view="forgot"');
  return (link > staff && staff > tabs && link < forgot
    && /id="client-link" data-go-client aria-controls="client" data-i18n="login.clientLink">عميل لدى المكتب؟ ادخل من بوابة العملاء</.test(html)
    && /<p class="lg-client-link" data-team-link-row hidden>\s*<button class="link-btn" type="button" data-go-team/.test(html)
    && /role="region" id="client" aria-labelledby="client-title" hidden/.test(html)) || 'markup';
});
check('the e-mail code block stays inside the staff panel (auth.js shows it on the staff tier only)', () => {
  const i = html.indexOf('data-otp hidden'), staff = html.indexOf('id="staff"'), link = html.indexOf('id="client-link"');
  return (i > staff && i < link && /otpBox\.hidden = currentTier !== 'staff'/.test(auth)) || 'otp';
});
check('the shared panel texts swap per tier (data-tier-title / -lead / -btn), the message has one optional action button', () =>
  (/data-tier-title data-i18n="login\.staffTitle"/.test(html) && /data-tier-lead data-i18n="login\.staffLead"/.test(html)
    && /data-tier-btn data-i18n="login\.staffBtn"/.test(html) && /data-auth-msg-action hidden/.test(html)) || 'markup');
check('dictionary: every new tier text in ar and en; {chosen} / {right} in the mismatch texts', () => {
  const miss = TIER_KEYS.filter(k => !D.ar[k] || !D.en[k] || (dict.match(new RegExp('\\n    ' + k + ': ', 'g')) || []).length !== 2);
  const v = ['ar', 'en'].every(l => D[l].tierMismatch.includes('{chosen}') && D[l].tierMismatch.includes('{right}') && D[l].tierGoTo.includes('{right}'));
  return (miss.length === 0 && v && D.ar.tierOrgTab === 'دخول المؤسسة' && D.ar.tierMgmtTab === 'دخول الإدارة' && D.ar.tierStaffTab === 'دخول الموظفين'
    && D.ar.clientLink === 'عميل لدى المكتب؟ ادخل من بوابة العملاء') || J(miss);
});
check('auth.js: the Arabic fallback equals the dictionary for the tier texts; preferStaff is gone', () => {
  const keys = TIER_KEYS.filter(k => k !== 'clientLink' && k !== 'teamLink').concat(['staffTitle', 'staffLead', 'staffBtn']);
  const bad = keys.filter(k => { const m = new RegExp('\\n    ' + k + ": '([^']*)',").exec(auth); return !m || m[1] !== D.ar[k]; });
  return (bad.length === 0 && !/preferStaff/.test(auth) && /function routeByRole\(expectTier\)/.test(auth)) || J(bad);
});
check('ES5 only in auth.js and the login dictionary', () => {
  const bad = [['auth', auth], ['dict', dict]].filter(([, src]) => /=>|`|\blet\s|\bconst\s/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")));
  return bad.length === 0 || bad.map(b => b[0]).join(', ');
});
check('css: three equal tier tabs that wrap their text (375 px), the client link row, no physical left/right in the new rules (mirrors in English)', () => {
  const i = css.indexOf('/* the three office tiers'), part = css.slice(i, css.indexOf('/* tablets / phones'));
  return (i > 0 && /\.auth-tiers \.tab \{ flex: 1 1 0; min-width: 0;[^}]*white-space: normal/.test(part) && /\.lg-client-link \{/.test(part)
    && /\.lg-client-link\[hidden\] \{ display: none; \}/.test(part) && /\.lg-msg-action\[hidden\]/.test(part)
    && !/\b(left|right)\s*:|margin-(left|right)|padding-(left|right)|text-align: (left|right)/.test(part)
    && /@media \(max-width: 480px\) \{[\s\S]{0,160}\.login-v2 \.auth-tiers \.tab \{ font-size/.test(css)) || 'css';
});

/* ------------------------------------------------------------------ the three office tiers: login.html + main.js + auth.js in jsdom */
const A = '0b5e0000-0000-4000-8000-000000000001';
const ROLES = {
  owner: [{ org_id: A, role: 'admin', branch_id: null, is_owner: true }],
  admin: [{ org_id: A, role: 'admin', branch_id: null, is_owner: false }, { org_id: A, role: 'accountant', branch_id: null, is_owner: false }],
  legacyAdmin: [{ org_id: A, role: 'admin', branch_id: null }],
  branchAdmin: [{ org_id: A, role: 'admin', branch_id: 'b1', is_owner: false }],
  bm: [{ org_id: A, role: 'branch_manager', branch_id: 'b1', is_owner: false }],
  sup: [{ org_id: A, role: 'supervisor', branch_id: null, is_owner: false }],
  clerk: [{ org_id: A, role: 'clearance_staff', branch_id: null, is_owner: false }],
  orgAdmin: [{ org_id: A, role: 'admin', branch_id: null, is_owner: false }],
  ownerTwoOrgs: [{ org_id: A, role: 'admin', branch_id: null, is_owner: true }, { org_id: 'o2', role: 'clearance_staff', branch_id: null, is_owner: false }],
  client: [{ org_id: A, role: 'client', branch_id: null, is_owner: false }],
  none: []
};
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }
// ORDER 'browser': deferred scripts run while readyState is 'interactive' → main.js binds its tabs before auth.js runs;
// ORDER 'late': main.js initialises on DOMContentLoaded, after auth.js (both orders must give the same page)
let ORDER = 'browser';
function boot(o) {
  o = o || {};
  const dom = new JSDOM(html, { url: 'https://marsa.test/login.html' + (o.search || '') + (o.hash || ''), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = { replace: [], signIn: [], signOut: 0, ctx: 0 };
  try { if (o.lang === 'en') w.localStorage.setItem('marsa_lang', 'en'); } catch (e) { /* ignore */ }
  w.MARSA_CONFIG = {};
  w.MarsaApi = {
    isOnline: () => true, isMisconfigured: () => false, onAuth: () => () => {},
    ready: () => Promise.resolve({ data: {}, error: null }),
    getSession: () => Promise.resolve({ data: null, error: null }),
    signIn: (e) => { calls.signIn.push(e); return Promise.resolve({ data: { user: { email: e } }, error: null }); },
    signOut: () => { calls.signOut++; return Promise.resolve({ data: null, error: null }); },
    myContext: () => { calls.ctx++; return Promise.resolve({ data: { memberships: o.memberships || [], is_platform_admin: !!o.platform }, error: null }); },
    mfaAal: () => Promise.resolve({ data: o.mfa && !calls.mfaDone ? { current: 'aal1', next: 'aal2' } : { current: o.mfa ? 'aal2' : 'aal1', next: o.mfa ? 'aal2' : 'aal1' }, error: null }),
    mfaState: () => ({ required: !!o.mfa, satisfied: !o.mfa || !!calls.mfaDone, enrolled: !!o.mfa }),
    otpGate: () => Promise.resolve({ data: { allowed: true, reason: 'password' }, error: null }),
    emailOtpEnabled: () => !!o.otpOn, requestEmailOtp: () => Promise.resolve({ data: {}, error: null }), verifyEmailOtp: () => Promise.resolve({ data: {}, error: null }),
    sessionMaxHours: () => 12, errorMessage: e => (e && e.code) || 'err'
  };
  // location.replace cannot be spied on in jsdom: auth.js gets a stand-in that reads the real location
  w.__loc = {
    get hash() { return w.location.hash; }, get search() { return w.location.search; }, get pathname() { return w.location.pathname; },
    get origin() { return w.location.origin; }, get href() { return w.location.href; }, replace: u => { calls.replace.push(u); }
  };
  if (o.mfa) w.MarsaMfa = { renderChallenge: (host, opts) => { calls.challenge = (calls.challenge || 0) + 1; calls.mfaOpts = opts; }, renderEnroll: () => { calls.enroll = 1; } };
  const errors = [];
  if (ORDER === 'browser') Object.defineProperty(w.document, 'readyState', { configurable: true, get: () => 'interactive' });
  for (const f of ['assets/js/i18n.js', 'assets/i18n/login.js', 'assets/js/main.js']) {
    try { w.eval(read(f) + '\n//# sourceURL=' + f); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  try { w.eval('(function (location) {' + auth + '\n})(window.__loc);\n//# sourceURL=auth.js'); } catch (e) { errors.push('auth.js: ' + e.message); }
  const d = w.document, $ = s => d.querySelector(s);
  return {
    w, d, $, calls, errors,
    settle: (ms) => new Promise(r => setTimeout(r, ms || 30)),
    selected: () => (d.querySelector('[role="tab"][aria-selected="true"]') || {}).id,
    vis: s => { const e = $(s); return !!e && !e.hidden && !e.closest('[hidden]'); },
    msg: () => $('[data-auth-msg-text]').textContent,
    async clickTab(id) { $('#' + id).click(); await this.settle(5); },
    async signInStaff(email) {
      $('#st-email').value = email || 'person@example.com'; $('#st-password').value = 'Secret123';
      $('#staff-signin-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
      await this.settle(40);
    }
  };
}
async function secDom() {
  if (!JSDOM) { record('jsdom available (NODE_PATH=<deps>/node_modules)', 'jsdom not found'); return; }
  const acheck = (name, fn) => acheckTop('[' + ORDER + '] ' + name, fn);
  await acheck('loads without script errors; no hash → the staff tier, the shared panel visible, the client panel hidden', async () => {
    const p = boot(); await p.settle();
    return (p.errors.length === 0 && p.selected() === 'tab-staff' && p.vis('#staff') && !p.vis('#client') && p.vis('[data-client-link-row]')
      && !p.vis('[data-team-link-row]') && p.$('[data-tier-title]').textContent === 'دخول الموظفين') || J({ e: p.errors, s: p.selected() });
  });
  await acheck('#org → the organisation tab, its title / lead / button; the code login hidden there even when it is on', async () => {
    const p = boot({ hash: '#org', otpOn: true }); await p.settle();
    return (p.selected() === 'tab-org' && p.vis('#staff') && !p.vis('#client') && p.$('[data-tier-title]').textContent === 'دخول المؤسسة'
      && p.$('[data-tier-lead]').textContent === D.ar.tierOrgLead && p.$('[data-tier-btn]').textContent === 'دخول المؤسسة'
      && p.$('#staff').getAttribute('aria-labelledby') === 'tab-org' && p.$('[data-otp]').hidden) || J({ s: p.selected(), t: p.$('[data-tier-title]').textContent });
  });
  await acheck('#management → the management tab; #staff with the code login on → the code block shown on the staff tier only', async () => {
    const a = boot({ hash: '#management' }), b = boot({ hash: '#staff', otpOn: true }); await a.settle(); await b.settle();
    const shownStaff = !b.$('[data-otp]').hidden;
    b.$('#tab-org').click(); await b.settle();
    return (a.selected() === 'tab-management' && a.$('[data-tier-title]').textContent === 'دخول الإدارة' && shownStaff && b.$('[data-otp]').hidden
      && b.vis('#staff') && b.w.location.hash === '#org') || J({ a: a.selected(), shownStaff, h: b.w.location.hash });
  });
  await acheck('clicking a tier tab: the shared panel stays visible (main.js toggles it per tab), the #hash follows', async () => {
    const p = boot(); await p.settle();
    const r = [];
    for (const id of ['tab-org', 'tab-management', 'tab-staff', 'tab-org']) { p.$('#' + id).click(); await p.settle(5); r.push(p.vis('#staff') + ':' + p.w.location.hash + ':' + p.$('[data-tier-title]').textContent); }
    return J(r) === J(['true:#org:دخول المؤسسة', 'true:#management:دخول الإدارة', 'true:#staff:دخول الموظفين', 'true:#org:دخول المؤسسة']) || J(r);
  });
  await acheck('keyboard (main.js arrows, no click): the panel and title follow the newly selected tier', async () => {
    const p = boot(); await p.settle();
    p.$('#tab-staff').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await p.settle(5);
    return (p.selected() === 'tab-org' && p.vis('#staff') && p.$('[data-tier-title]').textContent === 'دخول المؤسسة' && p.w.location.hash === '#org') || J({ s: p.selected(), v: p.vis('#staff') });
  });
  await acheck('old #client and #signup still open the client panel (sign-in / sign-up); the tiers hidden, the way back shown', async () => {
    const a = boot({ hash: '#client' }), b = boot({ hash: '#signup' }); await a.settle(); await b.settle();
    return (a.vis('#client') && !a.vis('#staff') && !a.vis('[data-tiers]') && a.vis('[data-client-sub="signin"]') && !a.vis('[data-client-link-row]') && a.vis('[data-team-link-row]')
      && b.vis('#client') && b.vis('[data-client-sub="signup"]') && !b.vis('[data-client-sub="signin"]')) || 'client panel';
  });
  await acheck('the client link opens the client panel (#client); «back» returns to the last tier; hashchange to #client / #org works', async () => {
    const p = boot({ hash: '#management' }); await p.settle();
    p.$('[data-go-client]').click(); await p.settle(5);
    const c = p.vis('#client') && !p.vis('#staff') && p.w.location.hash === '#client';
    p.$('[data-go-team]').click(); await p.settle(5);
    const back = p.vis('#staff') && !p.vis('#client') && p.selected() === 'tab-management';
    p.w.location.hash = '#client'; await p.settle(10);
    const hc = p.vis('#client');
    p.w.location.hash = '#org'; await p.settle(10);
    return (c && back && hc && p.vis('#staff') && p.selected() === 'tab-org') || J({ c, back, hc, s: p.selected() });
  });
  await acheck('the owner on #org → admin.html#team (one my_context call, no sign-out)', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.owner }); await p.settle(); await p.signInStaff();
    return (J(p.calls.replace) === J(['admin.html#team']) && p.calls.signOut === 0 && p.calls.ctx === 1) || J(p.calls);
  });
  await acheck('the owner on #management → admin.html#dashboard (an owner is an admin too)', async () => {
    const p = boot({ hash: '#management', memberships: ROLES.owner }); await p.settle(); await p.signInStaff();
    return J(p.calls.replace) === J(['admin.html#dashboard']) || J(p.calls);
  });
  await acheck('management roles (admin, branch_manager, supervisor) on #management → #dashboard; employees on #staff → #dashboard', async () => {
    const out = [];
    for (const [k, h] of [['admin', '#management'], ['bm', '#management'], ['sup', '#management'], ['clerk', '#staff'], ['admin', '#staff']]) {
      const p = boot({ hash: h, memberships: ROLES[k] }); await p.settle(); await p.signInStaff(); out.push(k + h + '=' + p.calls.replace.join(','));
    }
    return J(out) === J(['admin#management=admin.html#dashboard', 'bm#management=admin.html#dashboard', 'sup#management=admin.html#dashboard',
      'clerk#staff=admin.html#dashboard', 'admin#staff=admin.html#dashboard']) || J(out);
  });
  await acheck('legacy: an org-wide admin with no owner flag seen on #org → admin.html#team; a branch-scoped admin is not the owner', async () => {
    const a = boot({ hash: '#org', memberships: ROLES.legacyAdmin }); await a.settle(); await a.signInStaff();
    const b = boot({ hash: '#org', memberships: ROLES.branchAdmin }); await b.settle(); await b.signInStaff();
    return (J(a.calls.replace) === J(['admin.html#team']) && b.calls.replace.length === 0 && b.calls.signOut === 1) || J([a.calls, b.calls]);
  });
  await acheck('an employee on #org → signed out, the message names «دخول الموظفين», a button to it; the e-mail kept, the password cleared', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.clerk }); await p.settle(); await p.signInStaff('clerk@example.com');
    const btn = p.$('[data-auth-msg-action]');
    const want = 'هذا الحساب لا يدخل من «دخول المؤسسة». بحسب صلاحياتك ادخل من «دخول الموظفين» بالبريد وكلمة المرور نفسيهما.';
    const first = p.calls.signOut === 1 && p.calls.replace.length === 0 && p.msg() === want && !btn.hidden && btn.textContent === 'الانتقال إلى «دخول الموظفين»'
      && p.$('[data-auth-msg]').className === 'alert alert-warning mb-3' && p.selected() === 'tab-org' && p.$('#st-email').value === 'clerk@example.com' && p.$('#st-password').value === '';
    btn.click(); await p.settle(5);
    return (first && p.selected() === 'tab-staff' && p.w.location.hash === '#staff' && p.$('[data-auth-msg]').hidden && p.$('#st-email').value === 'clerk@example.com'
      && p.d.activeElement === p.$('#st-password')) || J({ first, m: p.msg(), s: p.selected(), c: p.calls });
  });
  await acheck('after the switch, signing in again on the right tab routes (no second sign-out)', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.clerk }); await p.settle(); await p.signInStaff('clerk@example.com');
    p.$('[data-auth-msg-action]').click(); await p.settle(5);
    await p.signInStaff('clerk@example.com');
    return (p.calls.signOut === 1 && J(p.calls.replace) === J(['admin.html#dashboard'])) || J(p.calls);
  });
  await acheck('a click on «دخول الموظفين»: a branch manager → «دخول الإدارة», an owner → «دخول المؤسسة»; an employee on #management → «دخول الموظفين»', async () => {
    const out = [];
    for (const [k, h, click] of [['bm', '#staff', true], ['clerk', '#management', false], ['legacyAdmin', '', true]]) {
      const p = boot({ hash: h, memberships: ROLES[k] }); await p.settle(); if (click) await p.clickTab('tab-staff'); await p.signInStaff();
      out.push(p.calls.signOut + ':' + (/من «([^»]+)» بالبريد/.exec(p.msg()) || [])[1]);
    }
    return J(out) === J(['1:دخول الإدارة', '1:دخول الموظفين', '1:دخول المؤسسة']) || J(out);
  });
  await acheck('English: the mismatch message and its button in English, the page left-to-right', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.sup, lang: 'en' }); await p.settle(); await p.signInStaff();
    return (p.d.documentElement.getAttribute('dir') === 'ltr'
      && p.msg() === 'This account does not sign in through “Organisation sign-in”. Based on your permissions, use “Management sign-in” with the same e-mail and password.'
      && p.$('[data-auth-msg-action]').textContent === 'Go to “Management sign-in”' && p.$('#tab-org').textContent === 'Organisation sign-in') || p.msg();
  });
  await acheck('a safe ?next= still wins for the right tier; an unsafe one is ignored', async () => {
    const a = boot({ search: '?next=admin.html%23transactions', hash: '#org', memberships: ROLES.owner }); await a.settle(); await a.signInStaff();
    const b = boot({ search: '?next=https%3A%2F%2Fevil.example%2F', hash: '#org', memberships: ROLES.owner }); await b.settle(); await b.signInStaff();
    return (J(a.calls.replace) === J(['admin.html#transactions']) && J(b.calls.replace) === J(['admin.html#team'])) || J([a.calls.replace, b.calls.replace]);
  });
  await acheck('no tier picked (default tab, no hash): never a mismatch — the user\'s own highest tier (owner → #team, clerk / bm → #dashboard)', async () => {
    const out = [];
    for (const k of ['owner', 'clerk', 'bm', 'ownerTwoOrgs']) { const p = boot({ memberships: ROLES[k] }); await p.settle(); await p.signInStaff(); out.push(p.calls.signOut + ':' + p.calls.replace.join(',')); }
    return J(out) === J(['0:admin.html#team', '0:admin.html#dashboard', '0:admin.html#dashboard', '0:admin.html#team']) || J(out);
  });
  await acheck('the legacy #staff link enforces no tier: an org-wide non-owner admin, a branch manager, the owner → routed by role, no sign-out', async () => {
    const out = [];
    for (const k of ['orgAdmin', 'bm', 'owner', 'clerk']) { const p = boot({ hash: '#staff', memberships: ROLES[k] }); await p.settle(); await p.signInStaff(); out.push(k + '=' + p.calls.signOut + ':' + p.calls.replace.join(',')); }
    return J(out) === J(['orgAdmin=0:admin.html#dashboard', 'bm=0:admin.html#dashboard', 'owner=0:admin.html#team', 'clerk=0:admin.html#dashboard']) || J(out);
  });
  await acheck('a hashchange to #staff (e.g. the header link) does not pick a tier; a hashchange to #org does', async () => {
    const a = boot({ hash: '#client', memberships: ROLES.bm }); await a.settle();
    a.w.location.hash = '#staff'; await a.settle(10); await a.signInStaff();
    const b = boot({ memberships: ROLES.bm }); await b.settle();
    b.w.location.hash = '#org'; await b.settle(10); await b.signInStaff();
    return (a.selected() === 'tab-staff' && a.calls.signOut === 0 && J(a.calls.replace) === J(['admin.html#dashboard'])
      && b.calls.signOut === 1 && b.calls.replace.length === 0 && /«دخول الإدارة»/.test(b.msg())) || J([a.calls, b.calls]);
  });
  await acheck('an org-wide non-owner admin (server is_owner false) on #org → signed out, pointed to «دخول الإدارة»', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.orgAdmin }); await p.settle(); await p.signInStaff();
    return (p.calls.signOut === 1 && p.calls.replace.length === 0 && /من «دخول المؤسسة»/.test(p.msg()) && /ادخل من «دخول الإدارة»/.test(p.msg())
      && p.$('[data-auth-msg-action]').textContent === 'الانتقال إلى «دخول الإدارة»') || J({ c: p.calls, m: p.msg() });
  });
  await acheck('userTiers trusts the server: is_owner true on an org-wide admin → #team; the key absent (old server) → the browser fallback', async () => {
    const a = boot({ hash: '#org', memberships: ROLES.owner }); await a.settle(); await a.signInStaff();
    const b = boot({ hash: '#org', memberships: ROLES.legacyAdmin }); await b.settle(); await b.signInStaff();
    const c = boot({ hash: '#org', memberships: [{ org_id: A, role: 'admin', branch_id: null, is_owner: false }, { org_id: 'o2', role: 'admin', branch_id: null, is_owner: false }] }); await c.settle(); await c.signInStaff();
    return (J(a.calls.replace) === J(['admin.html#team']) && J(b.calls.replace) === J(['admin.html#team']) && c.calls.signOut === 1) || J([a.calls, b.calls, c.calls]);
  });
  await acheck('the tier check runs after the two-step step: the code screen first (no sign-out), the mismatch only after aal2', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.bm, mfa: true }); await p.settle(); await p.signInStaff();
    const before = p.calls.challenge === 1 && p.calls.signOut === 0 && p.calls.replace.length === 0;
    p.calls.mfaDone = true; p.calls.mfaOpts.onDone(); await p.settle(40);
    return (before && p.calls.signOut === 1 && p.calls.replace.length === 0 && /«دخول الإدارة»/.test(p.msg())) || J({ before, c: p.calls });
  });
  await acheck('two-step then the right tier: the owner on #org → challenge, then admin.html#team', async () => {
    const p = boot({ hash: '#org', memberships: ROLES.owner, mfa: true }); await p.settle(); await p.signInStaff();
    const before = p.calls.challenge === 1 && p.calls.replace.length === 0;
    p.calls.mfaDone = true; p.calls.mfaOpts.onDone(); await p.settle(40);
    return (before && p.calls.signOut === 0 && J(p.calls.replace) === J(['admin.html#team'])) || J(p.calls);
  });
  await acheck('e-mail code sign-in enforces no tier: a branch manager after the code → #dashboard, no sign-out (even after a click on «دخول الموظفين»)', async () => {
    const p = boot({ hash: '#staff', memberships: ROLES.bm, otpOn: true }); await p.settle(); await p.clickTab('tab-staff');
    p.$('#otp-email').value = 'bm@example.com';
    p.$('#otp-request-form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await p.settle(20);
    p.$('#otp-code').value = '123456';
    p.$('#otp-verify-form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await p.settle(40);
    return (p.calls.signOut === 0 && J(p.calls.replace) === J(['admin.html#dashboard'])) || J({ c: p.calls, m: p.msg() });
  });
  await acheck('a system redirect onto #staff (?expired=1, ?signedout=1) is not a tier choice: an owner is let in (next kept)', async () => {
    const a = boot({ search: '?expired=1&next=admin.html%23transactions', hash: '#staff', memberships: ROLES.owner }); await a.settle(); await a.signInStaff();
    const b = boot({ search: '?signedout=1', hash: '#staff', memberships: ROLES.owner }); await b.settle(); await b.signInStaff();
    return (a.calls.signOut === 0 && J(a.calls.replace) === J(['admin.html#transactions']) && b.calls.signOut === 0 && J(b.calls.replace) === J(['admin.html#team'])) || J([a.calls, b.calls]);
  });
  await acheck('client routing unchanged: a client-only account on #staff → the «not staff» notice, then portal.html; platform-only on #org → platform.html', async () => {
    const a = boot({ hash: '#staff', memberships: ROLES.client }); await a.settle(); await a.signInStaff();
    const noticed = a.msg() === D.ar.notStaff && a.calls.signOut === 0;
    await a.settle(1900);
    const b = boot({ hash: '#org', memberships: ROLES.none, platform: true }); await b.settle(); await b.signInStaff();
    return (noticed && J(a.calls.replace) === J(['portal.html']) && J(b.calls.replace) === J(['platform.html']) && b.calls.signOut === 0) || J([a.calls, b.calls, a.msg()]);
  });
  await acheck('the client form is never tier-checked: staff signing in there → admin by tier, a client → portal.html', async () => {
    const out = [];
    for (const k of ['clerk', 'client', 'owner']) {
      const p = boot({ hash: '#client', memberships: ROLES[k] }); await p.settle();
      p.$('#ci-email').value = 'x@example.com'; p.$('#ci-password').value = 'Secret123';
      p.$('#client-signin-form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await p.settle(40);
      out.push(p.calls.signOut + ':' + p.calls.replace.join(','));
    }
    return J(out) === J(['0:admin.html#dashboard', '0:portal.html', '0:admin.html#team']) || J(out);
  });
}

(async () => {
  for (const o of ['browser', 'late']) { ORDER = o; await secDom(); }
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})();

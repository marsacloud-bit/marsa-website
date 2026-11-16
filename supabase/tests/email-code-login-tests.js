#!/usr/bin/env node
/*
  Marsa (مرسى) — the e-mail code login switches + the session-cap notice on login.html
  (docs/online/EMAIL_CODE_LOGIN_AR.md). LOCAL TESTS ONLY: PGlite (real Postgres 16 in memory) + node:vm with a fake DOM.
  Never points at Supabase or Daftra; no network (fetch throws). Invented data only.

  Covers:
    1. login.html / auth.js in a vm (fake DOM + fake MarsaApi): ?expired=1 → the warning notice with
       api.sessionMaxHours() hours (ar + en; 0 → the text without a number), only ?expired leaves the address (next + the
       hash stay), no notice when a session exists; the code forms show «valid for a limited time» + the session length,
       re-rendered on a language change; the code block stays hidden while the platform switch is off; the
       anti-enumeration message (otpSent) unchanged; ES5 only in auth.js / login.js.
    2. the dictionaries: the 4 new keys in ar and en (same keys), the exact Arabic notice of the owner.
    3. the org switch with MFA off (all migrations): the org-wide admin at aal1 — also in an e-mail code session — reads
       can_edit and turns email_otp_login on / off with a reason (no MRS_MFA_REQUIRED); supervisor / branch manager /
       client still refused; otp_session_check allows a staff code session once it is on, mfa_pending false;
       rules.js still draws the toggle (reason required, data-act otp-toggle).
    4. the runbook docs/online/EMAIL_CODE_LOGIN_AR.md (rebuild, org admin, Supabase settings + the Arabic template with
       {{ .Token }}, test, turn off; owner steps never automatic) and the config templates.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/email-code-login-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const J = x => JSON.stringify(x);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + ((e && (e.message + ' ' + (e.detail || ''))) || String(e))); }
}
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in email-code-login-tests'); };

const SRC = { auth: rd('assets/js/auth.js'), dict: rd('assets/i18n/login.js'), html: rd('login.html'), css: rd('assets/css/pages/login.css') };
const AR_NOTICE = 'انتهت مدة الجلسة (12 ساعة). سجّل الدخول من جديد.';

/* ------------------------------------------------------------------ the login dictionary, as i18n.js would serve it */
function dictionaries() {
  let reg = null;
  vm.runInNewContext(SRC.dict, { window: { MarsaI18n: { register: (ns, d) => { reg = d; } } } });
  return reg;
}
function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s; }

/* ------------------------------------------------------------------ a fake DOM: only the elements auth.js needs here */
function el(attrs) {
  const e = {
    hidden: !!(attrs && attrs.hidden), textContent: (attrs && attrs.text) || '', value: '', disabled: false, className: '',
    attrs: Object.assign({}, attrs || {}), listeners: {}, kids: {},
    addEventListener(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k] != null ? e.attrs[k] : null; },
    removeAttribute(k) { delete e.attrs[k]; }, focus() {}, click() {}, reset() {},
    querySelector(s) { return e.kids[s] || null; }, querySelectorAll() { return []; }, closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
  return e;
}
function runLogin(o) {
  o = o || {};
  const msgText = el();
  const msg = el({ hidden: true }); msg.kids['[data-auth-msg-text]'] = msgText;
  const notes = [el({ text: 'الرمز صالح لمدة محدودة ولمرة واحدة فقط.' }), el({ text: 'الرمز صالح لمدة محدودة ولمرة واحدة فقط.' })];
  const one = {
    '[data-auth-msg]': msg, '[data-otp]': el({ hidden: true }), '#otp-request-form': el({ hidden: true }), '#otp-verify-form': el({ hidden: true }),
    '[data-otp-open]': el()
  };
  const VIEWS = ['loading', 'tabs', 'forgot', 'reset', 'session', 'demo', 'invite', 'mfa', 'security'];
  VIEWS.forEach(v => { one['[data-auth-view="' + v + '"]'] = el({ hidden: true }); });
  const all = { '[data-otp-note]': notes };
  const winL = {};
  const history = [];
  const doc = {
    title: '', documentElement: el(),
    querySelector: s => one[s] || null, querySelectorAll: s => all[s] || [], getElementById: () => null
  };
  const lang = { v: o.lang || 'ar' };
  const D = dictionaries();
  const I18N = { lang: () => lang.v, t: (k, vars) => { const key = k.replace(/^login\./, ''); const s = D[lang.v][key]; return s == null ? k : interp(s, vars); } };
  const session = o.session || null;
  const api = {
    isOnline: () => true, isMisconfigured: () => false, onAuth: () => () => {},
    ready: () => Promise.resolve({ data: {}, error: null }),
    getSession: () => Promise.resolve({ data: session, error: null }),
    otpGate: () => Promise.resolve({ data: { allowed: true, reason: 'password' }, error: null }),
    emailOtpEnabled: () => !!o.otpOn, requestEmailOtp: () => Promise.resolve({ data: {}, error: null }),
    verifyEmailOtp: () => Promise.resolve({ data: {}, error: null }), signOut: () => Promise.resolve({ data: null, error: null }),
    myContext: () => Promise.resolve({ data: { memberships: [] }, error: null }),
    errorMessage: e => (e && e.code) || 'err'
  };
  if (o.hours !== undefined) api.sessionMaxHours = () => o.hours;
  const loc = { pathname: '/login.html', search: o.search || '', hash: o.hash || '', origin: 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/login.html' };
  const win = {
    MarsaApi: api, Marsa: {}, MarsaI18n: I18N, MARSA_CONFIG: {},
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); }
  };
  const sb = {
    window: win, document: doc, location: loc, console,
    history: { replaceState: (a, b, url) => { history.push(url); } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, Date, JSON, Math, Object, Array, String, Number, RegExp,
    encodeURIComponent, decodeURIComponent, isFinite
  };
  vm.runInNewContext(SRC.auth, sb, { filename: 'auth.js' });
  return {
    msg, msgText, notes, one, history, lang,
    fire: t => (winL[t] || []).forEach(f => f()),
    settle: () => new Promise(r => setTimeout(r, 20))
  };
}

async function secPage() {
  section('1. login.html / auth.js: the ?expired=1 notice, the code-form note (vm, fake DOM)');
  await check('?expired=1, 12 h: a warning with the owner\'s exact Arabic text; next + #staff kept, only ?expired dropped', async () => {
    const p = runLogin({ search: '?expired=1&next=admin.html%23transactions', hash: '#staff', hours: 12 });
    await p.settle();
    const url = p.history[p.history.length - 1] || '';
    return (!p.msg.hidden && p.msg.className === 'alert alert-warning mb-3' && p.msgText.textContent === AR_NOTICE
      && url === '/login.html?next=admin.html%23transactions#staff' && !/expired/.test(url)) || J({ m: p.msgText.textContent, c: p.msg.className, h: p.history });
  });
  await check('?expired=1 in English, 8 h (MARSA_CONFIG.sessionMaxHours through api.sessionMaxHours())', async () => {
    const p = runLogin({ search: '?expired=1', hash: '#client', hours: 8, lang: 'en' });
    await p.settle();
    return p.msgText.textContent === 'Your session has ended (8-hour limit). Sign in again.' || p.msgText.textContent;
  });
  await check('?expired=1 with the cap off (0) or no sessionMaxHours(): the notice without a number', async () => {
    const a = runLogin({ search: '?expired=1', hours: 0 }), b = runLogin({ search: '?expired=1' });
    await a.settle(); await b.settle();
    return (a.msgText.textContent === 'انتهت مدة الجلسة. سجّل الدخول من جديد.' && b.msgText.textContent === a.msgText.textContent) || J([a.msgText.textContent, b.msgText.textContent]);
  });
  await check('?expired=1 while a session exists again (another tab): no notice, ?expired dropped', async () => {
    const p = runLogin({ search: '?expired=1', hours: 12, session: { user: { email: 'staff@example.com' } } });
    await p.settle();
    return (p.msg.hidden && p.history.some(u => u === '/login.html')) || J({ hidden: p.msg.hidden, h: p.history });
  });
  await check('no ?expired: no notice', async () => {
    const p = runLogin({ search: '', hours: 12 });
    await p.settle();
    return p.msg.hidden || p.msgText.textContent;
  });
  await check('code login ON: both code forms say «valid for a limited time» + the session length (12 h); English after a language change', async () => {
    const p = runLogin({ otpOn: true, hours: 12, hash: '#staff' });
    await p.settle();
    const ar = p.notes.map(n => n.textContent);
    p.lang.v = 'en'; p.fire('marsa:langchange');
    const en = p.notes.map(n => n.textContent);
    return (!p.one['[data-otp]'].hidden
      && ar.every(t => t === 'الرمز صالح لمدة محدودة ولمرة واحدة فقط. بعد الدخول تبقى الجلسة 12 ساعة، ثم يلزم تسجيل الدخول من جديد.')
      && en.every(t => t === 'The code is valid for a limited time and works once. After sign-in the session lasts 12 h, then you sign in again.')) || J({ ar, en });
  });
  await check('code login ON with the cap off (0): only «valid for a limited time»', async () => {
    const p = runLogin({ otpOn: true, hours: 0 });
    await p.settle();
    return p.notes.every(n => n.textContent === 'الرمز صالح لمدة محدودة ولمرة واحدة فقط.') || J(p.notes.map(n => n.textContent));
  });
  await check('code login OFF (platform switch false): the code block stays hidden, notes untouched', async () => {
    const p = runLogin({ otpOn: false, hours: 12 });
    await p.settle();
    return (p.one['[data-otp]'].hidden && p.notes.every(n => n.textContent === 'الرمز صالح لمدة محدودة ولمرة واحدة فقط.')) || 'shown';
  });
  await check('login.html: a data-otp-note in each code form (inside the hidden block), the code field described by it; no data-i18n on the notes', () => {
    const i = SRC.html.indexOf('data-otp hidden'), j = SRC.html.indexOf('<!-- ===== FORGOT PASSWORD');
    const block = SRC.html.slice(i, j);
    const notes = block.match(/<p class="auth-otp-note text-xs text-muted"[^>]*data-otp-note>/g) || [];
    return (notes.length === 2 && !/data-otp-note[^>]*data-i18n|data-i18n[^>]*data-otp-note/.test(block)
      && /id="otp-code"[^>]*aria-describedby="otp-note-verify"/.test(block) && /id="otp-note-verify" data-otp-note/.test(block)
      && block.indexOf('data-otp-note') > block.indexOf('id="otp-request-form"') && block.lastIndexOf('data-otp-note') > block.indexOf('id="otp-verify-form"'))
      || J(notes);
  });
  await check('login.css: .auth-otp-note wraps long text (no horizontal scroll at 375 px), logical margins only', () =>
    /\.auth-otp-note \{ margin-block: 0 12px; overflow-wrap: anywhere; \}/.test(SRC.css) || 'css');
  await check('anti-enumeration: otpSent is unchanged (ar + en) and is the only text after a code request', () => {
    const D = dictionaries();
    return (D.ar.otpSent === 'إن كان هذا البريد لحساب موظف يُسمح له بالدخول بالرمز فستصله رسالة فيها رمز صالح لمدة محدودة. أدخل الرمز هنا.'
      && D.en.otpSent === 'If this address belongs to a staff account that may sign in with a code, a message with a short-lived code is on its way. Enter the code here.'
      && /var sent = \$\('\[data-otp-sent\]'\); if \(sent\) sent\.textContent = tr\('otpSent'\);\n\s*showMsg\(tr\('otpSent'\), 'info'\);/.test(SRC.auth)) || 'otpSent';
  });
  await check('ES5 only in auth.js and assets/i18n/login.js (no arrow functions, let / const, template strings)', () => {
    const bad = ['auth', 'dict'].filter(k => /=>|`|\blet\s|\bconst\s/.test(SRC[k].replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")));
    return bad.length === 0 || bad.join(', ');
  });
}

async function secDict() {
  section('2. the login dictionary');
  const D = dictionaries();
  const KEYS = ['otpValidity', 'otpValidityNoCap', 'sessionExpired', 'sessionExpiredNoCap'];
  await check('the 4 new keys in ar and en, {h} in the two with a number', () => {
    const miss = KEYS.filter(k => !D.ar[k] || !D.en[k] || (SRC.dict.match(new RegExp('\\n    ' + k + ': ', 'g')) || []).length !== 2);
    const h = ['otpValidity', 'sessionExpired'].every(k => D.ar[k].includes('{h}') && D.en[k].includes('{h}'));
    return (miss.length === 0 && h) || J(miss);
  });
  await check('the Arabic fallback in auth.js equals the dictionary (same 4 keys)', () => {
    const bad = KEYS.filter(k => { const m = new RegExp('\\n    ' + k + ": '([^']*)',").exec(SRC.auth); return !m || m[1] !== D.ar[k]; });
    return bad.length === 0 || J(bad);
  });
  await check('MFA is off: the code-form lead (ar, en, login.html) no longer says two-step verification is still required', () =>
    (!/التحقق بخطوتين/.test(D.ar.otpLead) && !/Two-step/i.test(D.en.otpLead) && SRC.html.includes('data-i18n="login.otpLead">' + D.ar.otpLead + '</p>')) || J([D.ar.otpLead, D.en.otpLead]));
  await check('the owner\'s notice: «انتهت مدة الجلسة (12 ساعة). سجّل الدخول من جديد.» with h = 12', () => interp(D.ar.sessionExpired, { h: 12 }) === AR_NOTICE || D.ar.sessionExpired);
}

/* ------------------------------------------------------------------ 3. the org switch with MFA off */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const JED = '0b5e0000-0000-4000-8000-000000000011';
const U = {
  owner: 'e0c10000-0000-4000-8000-000000000001', sup: 'e0c10000-0000-4000-8000-000000000002', bm: 'e0c10000-0000-4000-8000-000000000003',
  clr: 'e0c10000-0000-4000-8000-000000000004', portal: 'e0c10000-0000-4000-8000-000000000005'
};
let db;
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
async function as(who, extra, sql, params) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [J(Object.assign({ sub: U[who], role: 'authenticated', aal: 'aal1' }, extra || {}))]);
  await db.exec('SET ROLE authenticated');
  try { return (await q(sql, params))[0].r; } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function code(fn) { try { await fn(); return 'ok'; } catch (e) { return String(e.message || '').split('\n')[0] + (e.detail ? ' ' + e.detail : ''); } }
const OTP = { amr: [{ method: 'otp', timestamp: 1 }] };

async function secDb() {
  section('3. the org switch «قواعد المتابعة» with MFA off (every migration)');
  let PGlite;
  try { PGlite = require('@electric-sql/pglite').PGlite; } catch (e) { fail('load PGlite', 'NODE_PATH=/tmp/pgtest/node_modules needed'); return; }
  db = new PGlite();
  try {
    await db.exec(rd('supabase/tests/shim.sql'));
    for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    await db.exec(rd('supabase/seed.sql'));
    const users = Object.keys(U).map(k => `('${U[k]}', '${k}@otp-login.example.com', now())`).join(', ');
    await db.exec(`
      INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
      INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@otp-login.example.com'
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
        ('${U.owner}', '${A}', NULL, 'admin'), ('${U.sup}', '${A}', NULL, 'supervisor'), ('${U.bm}', '${A}', '${JED}', 'branch_manager'),
        ('${U.clr}', '${A}', '${JED}', 'clearance_staff'), ('${U.portal}', '${A}', NULL, 'client');
    `);
    pass('loaded: shim, every migration, seed, invented users');
  } catch (e) { fail('load', e.message); return; }
  try {
    await check('the switch is OFF by default; the org-wide admin at aal1 (MFA off) gets can_edit', async () => {
      const r = await as('owner', null, `SELECT public.get_status_aging_rules($1) r`, [A]);
      return (r.email_otp_login === false && r.can_edit === true) || J({ e: r.email_otp_login, c: r.can_edit });
    });
    await check('a staff code session is refused while it is OFF (org_disabled), mfa_pending false', async () => {
      const r = await as('clr', OTP, `SELECT public.otp_session_check() r`);
      return (r.otp_session === true && r.allowed === false && r.reason === 'org_disabled' && r.mfa_pending === false) || J(r);
    });
    await check('the org-wide admin at aal1 turns it ON with a reason (no MRS_MFA_REQUIRED)', async () => {
      const r = await as('owner', null, `SELECT public.set_email_otp_login($1, true, $2) r`, [A, 'تجربة الدخول بالرمز (اختبار)']);
      const s = (await q(`SELECT settings ->> 'email_otp_login' e, settings ->> 'email_otp_login_reason' w FROM public.organizations WHERE id = $1`, [A]))[0];
      return (r.email_otp_login === true && s.e === 'true' && s.w === 'تجربة الدخول بالرمز (اختبار)') || J({ r: r.email_otp_login, s });
    });
    await check('ON: a staff code session allowed (ok), mfa_pending false; a portal-only code session never (no_staff_membership)', async () => {
      const a = await as('clr', OTP, `SELECT public.otp_session_check() r`), p = await as('portal', OTP, `SELECT public.otp_session_check() r`);
      return (a.allowed === true && a.reason === 'ok' && a.mfa_pending === false && p.allowed === false && p.reason === 'no_staff_membership') || J({ a, p });
    });
    await check('the owner signed in WITH a code (aal1, amr otp) can still turn it off and on (MFA off: no aal2 step)', async () => {
      const off = await as('owner', OTP, `SELECT public.set_email_otp_login($1, false, 'إيقاف مؤقت') r`, [A]);
      const on = await as('owner', OTP, `SELECT public.set_email_otp_login($1, true, 'إعادة التفعيل') r`, [A]);
      return (off.email_otp_login === false && on.email_otp_login === true) || J({ off, on });
    });
    await check('still refused: supervisor / branch manager (owner_only), client, no reason, enabled null', async () => {
      const e = [await code(() => as('sup', null, `SELECT public.set_email_otp_login($1, false, 'x') r`, [A])),
        await code(() => as('bm', null, `SELECT public.set_email_otp_login($1, false, 'x') r`, [A])),
        await code(() => as('portal', null, `SELECT public.set_email_otp_login($1, false, 'x') r`, [A])),
        await code(() => as('owner', null, `SELECT public.set_email_otp_login($1, false, '   ') r`, [A])),
        await code(() => as('owner', null, `SELECT public.set_email_otp_login($1, NULL, 'x') r`, [A]))];
      return (e[0].startsWith('MRS_FORBIDDEN') && e[0].includes('owner_only') && e[1].includes('owner_only') && e[2].startsWith('MRS_')
        && e[2] !== 'ok' && e[3].startsWith('MRS_NOTE_REQUIRED') && e[4].startsWith('MRS_REQUIRED')) || J(e);
    });
    await check('turned OFF again with a reason: a staff code session refused again', async () => {
      const r = await as('owner', null, `SELECT public.set_email_otp_login($1, false, 'نهاية التجربة') r`, [A]);
      const c = await as('clr', OTP, `SELECT public.otp_session_check() r`);
      return (r.email_otp_login === false && c.allowed === false && c.reason === 'org_disabled') || J({ r: r.email_otp_login, c });
    });
  } finally { await db.close(); }
  await check('rules.js draws the toggle: both switches shown, owner only (can_edit), reason required, data-act otp-toggle, setEmailOtpLogin(!org, reason)', () => {
    const s = rd('assets/js/rpt/rules.js');
    return (/function otpCard\(d, can\)/.test(s) && /platform = cfg\.emailOtpLogin === true, org = d\.email_otp_login === true/.test(s)
      && /if \(can && K\.hasFn\(api, 'setEmailOtpLogin'\)\)/.test(s) && /lt\('rules_reason_required'\)/.test(s)
      && /U\.call\(api, 'setEmailOtpLogin', !org, String\(reason\.value\)\.trim\(\)\)/.test(s) && /'data-act': 'otp-toggle'/.test(s)) || 'rules.js';
  });
}

async function secDocs() {
  section('4. the runbook + the config templates');
  const P = 'docs/online/EMAIL_CODE_LOGIN_AR.md';
  const doc = fs.existsSync(path.join(ROOT, P)) ? rd(P) : '';
  await check(P + ': the five steps (rebuild, org admin, Supabase settings, test, turn off)', () => {
    const want = [/PROD_EMAIL_OTP_LOGIN=1/, /scripts\/build-release\.sh/, /«قواعد المتابعة»/, /سبب/, /Email OTP Expiration|OTP expiry|Email OTP expiry/i, /\b600\b/,
      /Magic Link/, /\{\{ \.Token \}\}/, /PROD_SESSION_MAX_HOURS/, /الاختبار|اختبار/, /الإيقاف|إيقاف/];
    const miss = want.filter(r => !r.test(doc)).map(String);
    return (doc && miss.length === 0) || 'missing: ' + miss.join(' ');
  });
  await check(P + ': steps (b) and (c) are done by the owner (or with explicit approval), never automatically', () =>
    (/المالك/.test(doc) && /موافقة صريحة/.test(doc) && /تلقائي/.test(doc)) || 'owner wording');
  await check(P + ': a ready Arabic template — RTL HTML, the code large, valid 10 minutes, no link ({{ .ConfirmationURL }} absent from the template)', () => {
    const m = /```html\n([\s\S]*?)```/.exec(doc);
    const t = m ? m[1] : '';
    return (t && /dir="rtl"/.test(t) && /lang="ar"/.test(t) && /\{\{ \.Token \}\}/.test(t) && /font-size:\s*(2[4-9]|[3-9]\d)px/.test(t)
      && /10 دقائق/.test(t) && !/ConfirmationURL|<a\s/i.test(t)) || 'template';
  });
  await check(P + ': MFA stays off (no aal2 step asked), the anti-enumeration message is kept', () =>
    (!/aal2 مطلوب|فعّل التحقق بخطوتين/.test(doc) && /رسالة واحدة|الرسالة نفسها/.test(doc)) || 'mfa / enumeration wording');
  await check('config.production.example.js: sessionMaxHours 12 and emailOtpLogin false, documented with their PROD_* variables', () => {
    const c = rd('assets/js/config.production.example.js'), w = {};
    vm.runInNewContext(c, { window: w });
    return (w.MARSA_CONFIG.sessionMaxHours === 12 && w.MARSA_CONFIG.emailOtpLogin === false && /PROD_SESSION_MAX_HOURS → sessionMaxHours/.test(c)
      && /PROD_EMAIL_OTP_LOGIN   → emailOtpLogin/.test(c)) || J(w.MARSA_CONFIG);
  });
  await check('build-release.sh: PROD_EMAIL_OTP_LOGIN / PROD_SESSION_MAX_HOURS in the header, validated by the python helper before anything is written', () => {
    const s = rd('scripts/build-release.sh');
    const val = s.indexOf('SWITCHES="$(pyl switches)" || exit 1'), mk = s.indexOf('mkdir -p "$OUT" "$SITE"');
    return (/#   export PROD_EMAIL_OTP_LOGIN=1/.test(s) && /#   export PROD_SESSION_MAX_HOURS=12/.test(s) && val > 0 && mk > val
      && /  sessionMaxHours: \$SESSION_HOURS,\n  emailOtpLogin: \$EMAIL_OTP\n\};/.test(s)) || 'build-release.sh';
  });
}

async function main() {
  for (const s of [secPage, secDict, secDb, secDocs]) {
    try { await s(); } catch (e) { fail(s.name, (e && e.stack) || String(e)); }
  }
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main();

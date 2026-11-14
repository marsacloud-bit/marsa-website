#!/usr/bin/env node
/*
  Marsa (مرسى) — empty-container return deadline → extension request: UI tests (20261128000100).
  assets/js/ops/tx-return.js («طلب تمديد المهلة» block of the transaction page), assets/js/ops/alerts.js (the alert action),
  assets/js/admin.js (the dashboard counter), assets/js/rpt/rules.js (the rule card), the dictionaries (appt / ops / lrpt /
  admin). Pure Node, no database, no network (vm + window shim + supabase/tests/lib/fake-dom.js).

  Covers: ES5 + no innerHTML in the changed files; the rx_* keys (ar = en, same {vars}, every literal key, status / outcome
  families); the mailto builder (encoding of Arabic + CRLF, the length fallback without the body, the subject on one line);
  the prepare / decide form payloads; DOM: the block hidden without the RPC, the requests list (status chips, period, server
  text as text only), the new-request form (default containers, days / date, e-mail) → prepareReturnExtension with an
  idempotency key, missing e-mail warning, several agents → the agent picker, «فتح في البريد» = a mailto: link with the edited
  values, a long body copied to the clipboard, «نسخ النص», «تم الإرسال» behind a confirm (saves the edits first), the agent
  e-mail saved to the registry only after a confirm, «تسجيل رد الوكيل» → decideReturnExtension (outcome / date / note), cancel
  with a reason, the read-only role, #alerts → pendingFocus opens the form; the program never sends (no send call exists).

  usage:  node supabase/tests/return-extension-ui-tests.js [/path/to/marsa-website] [--quiet]
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

/* ------------------------------------------------------------ dictionaries */
const dicts = { ar: {}, en: {} };
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts.ar[key] != null ? dicts.ar[key] : key;
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  has(key) { return dicts.ar[key] != null; }, lang() { return 'ar'; }
};
const TXR = rd('assets/js/ops/tx-return.js'), TXA = rd('assets/js/ops/tx-appt.js'), DICT = rd('assets/i18n/appt.js');
const ALERTS = rd('assets/js/ops/alerts.js'), RULES = rd('assets/js/rpt/rules.js'), ADMIN = rd('assets/js/admin.js'), SUPA = rd('assets/js/supa.js');
const OPSD = rd('assets/i18n/ops.js'), LRPT = rd('assets/i18n/lrpt.js'), ADMD = rd('assets/i18n/admin.js');
const MIG = rd('supabase/migrations/20261128000100_return_extension.sql');
{
  const c = { window: { MarsaI18n: I18N } }; c.window.window = c.window; vm.createContext(c);
  [[DICT, 'appt.js'], [OPSD, 'ops.js'], [LRPT, 'lrpt.js'], [ADMD, 'admin.js']].forEach(x => { try { vm.runInContext(x[0], c, { filename: x[1] }); } catch (e) { /* checked below */ } });
}

section('static: ES5, no innerHTML, the program never sends');
// alerts.js: only the RX part (the file itself predates this step and is covered by the G3 / legacy-reports suites)
const ALERTS_RX = ALERTS.slice(ALERTS.indexOf('  var RX_KINDS = '), ALERTS.indexOf('  var AF = '));
const FILES = { 'assets/js/ops/tx-return.js': TXR, 'assets/js/rpt/rules.js': RULES, 'assets/i18n/appt.js': DICT, 'alerts.js (RX part)': '(function () {\n\'use strict\';\n' + ALERTS_RX + '\n})();' };
Object.keys(FILES).forEach(f => {
  const s = FILES[f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  check(f + ': IIFE + strict, ES5 only, no innerHTML / outerHTML / insertAdjacentHTML / document.write', () =>
    (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)) || 'not ES5 / uses HTML');
});
check('no send path: tx-return.js never calls an inbox / SMTP send, only mailto: + the user\'s «تم الإرسال» statement', () =>
  (!/sendMsgReply|send_msg_reply|saveMsgReply|requestMsgDraft|smtp/i.test(TXR) && /'markReturnExtensionSent'/.test(TXR) && /mailto:/.test(TXR)
    && (TXR.match(/call\(api, 'markReturnExtensionSent'/g) || []).length === 1) || 'send path');
check('«تم الإرسال» only behind the confirm dialog; the registry e-mail only behind its own confirm', () =>
  (/api\.confirm\(\{ title: T\('rx_sent_title'\)[\s\S]{0,700}call\(api, 'markReturnExtensionSent'/.test(TXR)
    && /api\.confirm\(\{ title: T\('rx_keep_title'\)[\s\S]{0,400}call\(api, 'saveParty'/.test(TXR)) || 'confirm');
check('supa.js wrappers exist and are exported; the alert kind list of alerts.js = the migration CHECK', () => {
  const names = ['prepareReturnExtension', 'updateReturnExtension', 'markReturnExtensionSent', 'decideReturnExtension', 'cancelReturnExtension',
    'listReturnExtensions', 'getEmptyReturnRules', 'setEmptyReturnRules', 'setReturnExtensionTemplate'];
  const miss = names.filter(n => !new RegExp('function ' + n + '\\(').test(SUPA) || !new RegExp(n + ': ' + n).test(SUPA));
  const m = /operational_alerts_kind_check\s+CHECK \(kind IN \(([^)]+)\)\)/.exec(MIG);
  const kinds = m ? m[1].replace(/\s+/g, '').split(',').map(x => x.replace(/'/g, '')) : [];
  const k2 = /var KINDS = \[([^\]]+)\]/.exec(ALERTS);
  const js = k2 ? k2[1].replace(/\/\/.*$/gm, '').match(/'[a-z_]+'/g).map(x => x.replace(/'/g, '')) : [];
  return (miss.length === 0 && J(kinds.slice().sort()) === J(js.slice().sort()) && kinds.includes('empty_return_no_deadline')) || J({ miss, kinds, js });
});
check('dashboard: the «بانتظار رد الوكيل» counter counts status sent (RLS-scoped head count) and links to #alerts', () =>
  (/need\('rxSent', cnt\('return_extension_requests', function \(q\) \{ return q\.eq\('status', 'sent'\); \}\)\);/.test(ADMIN)
    && /attn\.push\(\{ title: t\('attn_rx_sent'\), href: '#alerts'/.test(ADMIN) && !!dicts.ar['admin.attn_rx_sent'] && !!dicts.en['admin.attn_rx_sent']) || 'dashboard');

section('dictionaries');
const AR = Object.keys(dicts.ar).filter(k => /^appt\.rx/.test(k)), EN = Object.keys(dicts.en).filter(k => /^appt\.rx/.test(k));
check('appt rx_* keys: ar = en, no empty strings, same {vars}', () => {
  const vs = s => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();
  const bad = AR.filter(k => dicts.en[k] == null || !String(dicts.ar[k]).trim() || vs(dicts.ar[k]) !== vs(dicts.en[k]));
  return (AR.length > 80 && AR.length === EN.length && bad.length === 0) || J({ ar: AR.length, en: EN.length, bad });
});
check('every literal T(\'rx…\') of tx-return.js exists; status / outcome / error families', () => {
  const miss = [];
  const re = /\bT\('(rx[a-z0-9_]*)'(?=[,)])/g; let m;
  while ((m = re.exec(TXR))) if (dicts.ar['appt.' + m[1]] == null) miss.push(m[1]);
  const re2 = /'(rx_e_[a-z_]+)'/g;
  while ((m = re2.exec(TXR))) if (dicts.ar['appt.' + m[1]] == null) miss.push(m[1]);
  ['draft', 'sent', 'approved', 'partially_approved', 'rejected', 'cancelled'].forEach(s => { if (!dicts.ar['appt.rxs_' + s] || !dicts.en['appt.rxs_' + s]) miss.push('rxs_' + s); });
  ['approved', 'partially_approved', 'rejected'].forEach(s => { if (!dicts.ar['appt.rxo_' + s]) miss.push('rxo_' + s); });
  return miss.length === 0 || miss;
});
check('ops / lrpt / admin: the alert kind + actions, the rules card strings (ar + en)', () => {
  const need = ['ops.alert_kind_empty_return_no_deadline', 'ops.al_rx_prepare', 'ops.al_rx_open', 'ops.al_rx_deadline'];
  const re = /\blt\('(rx_[a-z_]+)'/g; let m;
  while ((m = re.exec(RULES))) need.push('lrpt.' + m[1]);
  const miss = need.filter(k => dicts.ar[k] == null || dicts.en[k] == null);
  return miss.length === 0 || miss;
});
check('the rule says the program does not send and names ops@marsacloud.com (ar + en)', () =>
  (/البرنامج لا يرسل البريد/.test(dicts.ar['appt.rx_rule']) && /ops@marsacloud\.com/.test(dicts.ar['appt.rx_rule']) && /does not send it/.test(dicts.en['appt.rx_rule'])) || 'rule');

/* ------------------------------------------------------------ load tx-return.js + alerts.js */
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 30); i++) await tick(); }
const ORG = '0000000a-0000-4000-8000-00000000000a', TX = '0000000d-0000-4000-8000-00000000000d';
const C1 = '000000c1-0000-4000-8000-0000000000c1', C2 = '000000c2-0000-4000-8000-0000000000c2', C3 = '000000c3-0000-4000-8000-0000000000c3';
const R1 = '000000e1-0000-4000-8000-0000000000e1', R2 = '000000e2-0000-4000-8000-0000000000e2', AG = '000000a9-0000-4000-8000-0000000000a9';
const ok = d => Promise.resolve({ data: d, error: null });
const err = (code, field) => Promise.resolve({ data: null, error: { code, field, message: code + (field ? ':' + field : '') } });
function opsEl(document) {
  return (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); });
    [].concat(kids == null ? [] : kids).forEach(function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(add); n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
}
function txContext() {
  const { document } = makeDom();
  const clip = [];
  const w2 = { MarsaI18n: I18N, document, open: () => null, navigator: { clipboard: { writeText: t => { clip.push(t); return Promise.resolve(); } } } };
  const c2 = { window: w2, document, navigator: w2.navigator, FileReader: function () {}, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN,
    Promise, setTimeout, clearTimeout, encodeURIComponent };
  w2.window = w2;
  vm.createContext(c2);
  vm.runInContext(DICT, c2); vm.runInContext(TXA, c2); vm.runInContext(TXR, c2);
  return { document, w2, clip };
}
function txApi(document, A, extra) {
  const log = { toasts: [], confirms: [], refresh: 0, answer: true };
  let k = 0;
  const api = Object.assign({ el: opsEl(document), can: () => true, cancelled: false, orgId: ORG, fmtDate: v => String(v), errText: e => e.code + (e.field ? ':' + e.field : ''), isEn: () => false,
    label: (d, c) => c, MarsaApi: A, toast: (m, t) => log.toasts.push([t, m]), confirm: o => { log.confirms.push(o); return Promise.resolve(log.answer); },
    refresh: () => { log.refresh++; }, newIdemKey: () => 'key-' + (++k) }, extra || {});
  return { api, log };
}
const base = txContext();
const TR = base.w2.MarsaOps.txReturn.pure;

section('pure helpers (tx-return.js)');
check('mailtoHref: to / subject / body encoded (Arabic, CRLF line breaks), the subject on one line', () => {
  const m = TR.mailtoHref('agent@line.example.com', 'طلب تمديد\nB/L 1', 'السلام عليكم\nسطر 2', 1800);
  return (m.full === true && m.href.indexOf('mailto:agent@line.example.com?subject=') === 0 && m.href.includes('&body=') && decodeURIComponent(m.href.split('&body=')[1]) === 'السلام عليكم\r\nسطر 2'
    && decodeURIComponent(m.href.split('?subject=')[1].split('&body=')[0]) === 'طلب تمديد B/L 1') || J(m);
});
check('mailtoHref: a body over the limit → the link carries the subject only (full false)', () => {
  const m = TR.mailtoHref('a@b.example.com', 'S', 'x'.repeat(3000));
  return (m.full === false && !m.href.includes('&body=') && /subject=S$/.test(m.href) && TR.MAILTO_MAX === 1800) || J(m);
});
check('isEmail / rxActive', () => (TR.isEmail('a@b.co') && !TR.isEmail('a@b') && !TR.isEmail('a b@c.com') && TR.rxActive({ status: 'sent' }) && !TR.rxActive({ status: 'approved' })) || 'email');
check('rxPreparePayload: containers required, until wins over days, days 1..60, e-mail validated + lower-cased, the agent', () => {
  const a = TR.rxPreparePayload({ containerIds: [] }), b = TR.rxPreparePayload({ containerIds: [C1], days: '٧' });
  const c = TR.rxPreparePayload({ containerIds: [C1, C2], days: '5', until: '2026-12-20', to: 'A@B.example.com', agentPartyId: AG });
  const d = TR.rxPreparePayload({ containerIds: [C1], days: '61' }), e = TR.rxPreparePayload({ containerIds: [C1], to: 'x' }), f = TR.rxPreparePayload({ containerIds: [C1], until: '20-12-2026' });
  return (a.error === 'rx_e_containers' && J(b) === J({ containerIds: [C1], requestedDays: 7 }) && J(c) === J({ containerIds: [C1, C2], requestedUntil: '2026-12-20', toAddress: 'a@b.example.com', agentPartyId: AG })
    && d.error === 'rx_e_days' && e.error === 'rx_e_email' && f.error === 'rx_e_until') || J({ a, b, c, d, e, f });
});
check('rxDecidePayload: outcome, a new date after the current deadline, a note for rejected / a draft answered by phone', () => {
  const req = { status: 'sent', current_deadline: '2026-12-10' };
  const a = TR.rxDecidePayload({}, req), b = TR.rxDecidePayload({ outcome: 'approved' }, req), c = TR.rxDecidePayload({ outcome: 'approved', until: '2026-12-10' }, req);
  const d = TR.rxDecidePayload({ outcome: 'approved', until: '2026-12-17', note: ' تم ' }, req), e = TR.rxDecidePayload({ outcome: 'rejected' }, req);
  const f = TR.rxDecidePayload({ outcome: 'rejected', note: 'لا' }, req), g = TR.rxDecidePayload({ outcome: 'approved', until: '2026-12-17' }, { status: 'draft', current_deadline: '2026-12-10' });
  return (a.error === 'rx_e_outcome' && b.error === 'rx_e_new_date' && c.error === 'rx_e_new_date_after' && J(d) === J({ outcome: 'approved', decidedUntil: '2026-12-17', note: 'تم' })
    && e.error === 'rx_e_note' && J(f) === J({ outcome: 'rejected', note: 'لا' }) && g.error === 'rx_e_note_phone') || J({ a, b, c, d, e, f, g });
});

/* ------------------------------------------------------------ DOM */
const tx = { id: TX, ref: 'MRS-2026-000099', branch_id: 'b', operational_status: 'empty_return' };
const CTRS = [{ id: C1, container_no: 'MSKU1234565', return_status: 'pending', return_deadline: '2026-11-16' },
  { id: C2, container_no: 'TGHU7654321', return_status: 'pending', return_deadline: '2026-11-17' },
  { id: C3, container_no: 'TCLU1111110', return_status: 'returned_verified', return_deadline: '2026-11-10' }];
function draftReq(o) {
  return Object.assign({ id: R1, transaction_id: TX, status: 'draft', container_ids: [C1, C2], containers: CTRS.slice(0, 2), current_deadline: '2026-11-16',
    requested_days: 7, requested_until: '2026-11-23', to_address: null, agent_party_id: AG, agent_name: '<img src=x onerror=alert(1)> وكيل', agent_email: null,
    subject: 'طلب تمديد / Detention extension request — MRS-2026-000099', body: 'السادة الوكيل\nDear agent', text_edited: false }, o || {});
}
function mkA(rc, state) {
  return {
    listEmptyReturnProofs: () => ok({ proofs: [], readiness: {} }), listContainers: () => ok(CTRS), listDocuments: () => ok([]), aiAccess: () => ok({ can_use: false }),
    listReturnExtensions: f => { rc.push(['list', f]); return ok({ items: state.items, total: state.items.length }); },
    prepareReturnExtension: (id, o) => { rc.push(['prepare', id, o]); if (state.prepareErr) { const e = state.prepareErr; state.prepareErr = null; return err(e[0], e[1]); } const r = draftReq({ missing_email: true }); state.items = [r]; return ok(r); },
    updateReturnExtension: (id, o) => { rc.push(['update', id, o]); const r = Object.assign({}, state.items[0], { to_address: o.toAddress !== undefined ? o.toAddress : state.items[0].to_address, subject: o.subject || state.items[0].subject, body: o.body || state.items[0].body }); state.items = [r]; return ok(r); },
    markReturnExtensionSent: (id, n) => { rc.push(['sent', id, n]); return ok(Object.assign({}, state.items[0], { status: 'sent' })); },
    decideReturnExtension: (id, o) => { rc.push(['decide', id, o]); return ok({ id, status: o.outcome, updated: [{}, {}], skipped: [{}], demurrage_hint: true }); },
    cancelReturnExtension: (id, r) => { rc.push(['cancel', id, r]); return ok({ id, status: 'cancelled' }); },
    saveParty: p => { rc.push(['party', p]); return ok(p); },
    listParties: f => { rc.push(['parties', f]); return ok([{ id: AG, name_ar: 'وكيل أ' }, { id: 'ag2', name_ar: 'وكيل ب' }]); }
  };
}
const SEC = ctx => ctx.w2.MarsaOps.txSections.filter(x => x.id === 'empty_return')[0];

(async function () {
  section('DOM: the block (tx-return.js)');
  {
    const ctx = txContext(), D = ctx.document;
    const A0 = mkA([], { items: [] });
    delete A0.listReturnExtensions;
    const h0 = D.createElement('div'); D.body.appendChild(h0);
    await SEC(ctx).render(h0, tx, txApi(D, A0).api); await settle(10);
    check('without the RPC (server before 20261128000100) the block is hidden; the proofs section renders as before', () =>
      (!h0.querySelector('#tx-rx') && !!h0.querySelector('#tx-empty-return')) || h0.textContent.slice(0, 200));
  }
  const ctx = txContext(), D = ctx.document, rc = [], state = { items: [] };
  const A = mkA(rc, state);
  const host = D.createElement('div'); D.body.appendChild(host);
  const T1 = txApi(D, A);
  await SEC(ctx).render(host, tx, T1.api); await settle(10);
  check('empty: the rule (the program does not send), «لا توجد طلبات», the «تجهيز طلب تمديد» button; listReturnExtensions({transactionId})', () =>
    (!!host.querySelector('#tx-rx') && /البرنامج لا يرسل البريد/.test(host.textContent) && /لا توجد طلبات تمديد/.test(host.textContent)
      && !!host.querySelector('[data-rx-new]') && rc.some(c => c[0] === 'list' && c[1].transactionId === TX)) || host.textContent.slice(0, 300));
  host.querySelector('[data-rx-new]').click(); await settle(5);
  check('the form: the open containers with a deadline checked (not the returned one), days / date / e-mail inputs', () =>
    (host.querySelectorAll('[data-rx-ctr]').length === 2 && host.querySelectorAll('[data-rx-ctr]').every(c => c.checked) && !host.querySelector('[data-rx-ctr="' + C3 + '"]')
      && !!D.getElementById('appt-rx-days') && !!D.getElementById('appt-rx-until') && !!D.getElementById('appt-rx-to')) || host.textContent.slice(0, 300));
  D.getElementById('appt-rx-days').value = '61';
  D.getElementById('appt-rx-prepare').click(); await settle(5);
  check('a bad day count is refused locally (no call)', () => (!rc.some(c => c[0] === 'prepare') && /عدد الأيام من 1 إلى 60/.test(host.textContent)) || J(rc));
  D.getElementById('appt-rx-days').value = '10';
  host.querySelector('[data-rx-ctr="' + C2 + '"]').click();
  state.prepareErr = ['MRS_REQUIRED', 'bl_id'];
  D.getElementById('appt-rx-prepare').click(); await settle(10);
  check('several agents (MRS_REQUIRED bl_id) → the agent picker (listParties shipping_agent) + a warning', () =>
    (rc.some(c => c[0] === 'parties' && c[1].kind === 'shipping_agent') && !!D.getElementById('appt-rx-agent') && /أكثر من بوليصة بوكلاء/.test(host.textContent)) || host.textContent.slice(0, 400));
  D.getElementById('appt-rx-agent').value = AG;
  D.getElementById('appt-rx-agent').dispatch('change');
  D.getElementById('appt-rx-prepare').click(); await settle(10);
  const pr = rc.filter(c => c[0] === 'prepare');
  check('prepare → prepareReturnExtension(tx, {containerIds (only the checked), requestedDays, agentPartyId, idemKey}); missing e-mail warning', () =>
    (pr.length === 2 && pr[1][1] === TX && J(pr[1][2].containerIds) === J([C1]) && pr[1][2].requestedDays === 10 && pr[1][2].agentPartyId === AG && /^key-/.test(pr[1][2].idemKey)
      && /لا يوجد بريد للوكيل الملاحي/.test(host.textContent)) || J(pr));
  check('the draft: status chip, the period, the agent name as TEXT (no element injected), the editor', () =>
    (!!host.querySelector('[data-rx="' + R1 + '"]') && /جاهز للإرسال|draft/.test(host.textContent) && /الحالية 2026-11-16 ← المطلوبة 2026-11-23 \(7 يومًا\)/.test(host.textContent)
      && host.textContent.includes('<img src=x onerror=alert(1)> وكيل') && host.querySelectorAll('img').length === 0
      && !!D.getElementById('appt-rx-body-' + R1) && !!D.getElementById('appt-rx-keep-' + R1)) || host.textContent.slice(0, 500));
  const mail = host.querySelector('[data-rx-mail="' + R1 + '"]');
  D.getElementById('appt-rx-to-' + R1).value = 'ops@agent.example.com';
  D.getElementById('appt-rx-to-' + R1).dispatch('input');
  check('«فتح في البريد» is a mailto: link with the edited recipient, subject and body', () => {
    const h = mail.getAttribute('href');
    return (/^mailto:ops@agent\.example\.com\?subject=/.test(h) && decodeURIComponent(h.split('&body=')[1]) === 'السادة الوكيل\r\nDear agent' && mail.tagName === 'A') || h;
  });
  D.getElementById('appt-rx-body-' + R1).value = 'ن'.repeat(900);
  D.getElementById('appt-rx-body-' + R1).dispatch('input');
  mail.click(); await settle(5);
  check('a long body: the link has the subject only and the body is copied to the clipboard (toast tells to paste)', () =>
    (!mail.getAttribute('href').includes('&body=') && ctx.clip[ctx.clip.length - 1] === 'ن'.repeat(900) && /طويلة على رابط البريد/.test(T1.log.toasts[T1.log.toasts.length - 1][1])) || J({ h: mail.getAttribute('href').slice(0, 80), clip: ctx.clip.length }));
  host.querySelector('[data-rx-copy="' + R1 + '"]').click(); await settle(5);
  check('«نسخ النص»: to + subject + body copied', () => (/^إلى: ops@agent\.example\.com\nالموضوع: طلب تمديد/.test(ctx.clip[ctx.clip.length - 1]) && /نُسخت الرسالة/.test(T1.log.toasts[T1.log.toasts.length - 1][1])) || ctx.clip[ctx.clip.length - 1]);
  D.getElementById('appt-rx-body-' + R1).value = 'نص معدل';
  D.getElementById('appt-rx-keep-' + R1).click();
  host.querySelector('[data-rx-sent="' + R1 + '"]').click(); await settle(20);
  const up = rc.filter(c => c[0] === 'update'), se = rc.filter(c => c[0] === 'sent'), pa = rc.filter(c => c[0] === 'party');
  check('«تم الإرسال»: confirm first; the edits saved (to + body), the agent e-mail saved to the registry after its own confirm, then markReturnExtensionSent; page refresh', () =>
    (T1.log.confirms.some(c => c.title === 'تأكيد إرسال طلب التمديد' && /ops@agent\.example\.com/.test(c.text)) && T1.log.confirms.some(c => c.title === 'حفظ بريد الوكيل الملاحي')
      && up.length === 1 && J(up[0][2]) === J({ toAddress: 'ops@agent.example.com', body: 'نص معدل' }) && pa.length === 1 && J(pa[0][1]) === J({ id: AG, email: 'ops@agent.example.com' })
      && se.length === 1 && se[0][1] === R1 && T1.log.refresh === 1) || J({ up, se, pa, c: T1.log.confirms.map(x => x.title) }));

  section('DOM: a sent request — answer / cancel / read-only / focus');
  const ctx2 = txContext(), D2 = ctx2.document, rc2 = [], st2 = { items: [draftReq({ id: R2, status: 'sent', to_address: 'ops@agent.example.com', agent_email: 'ops@agent.example.com', sent_at: '2026-11-14T10:00:00Z' })] };
  const A2 = mkA(rc2, st2);
  const h2 = D2.createElement('div'); D2.body.appendChild(h2);
  const T2 = txApi(D2, A2);
  await SEC(ctx2).render(h2, tx, T2.api); await settle(10);
  check('sent: the text as a read-only preview, «فتح في البريد» / «نسخ النص» / answer / cancel, no «تم الإرسال», no new-request button while every container is in it', () =>
    (!h2.querySelector('[data-rx-sent]') && !!h2.querySelector('[data-rx-mail="' + R2 + '"]') && !!h2.querySelector('[data-rx-decide="' + R2 + '"]') && !!h2.querySelector('.appt-rx-preview')
      && !D2.getElementById('appt-rx-body-' + R2) && !h2.querySelector('[data-rx-new]')) || h2.textContent.slice(0, 300));
  h2.querySelector('[data-rx-decide="' + R2 + '"]').click(); await settle(5);
  D2.getElementById('appt-rx-out-' + R2).value = 'approved';
  D2.getElementById('appt-rx-new-' + R2).value = '2026-11-16';
  h2.querySelector('[data-rx-decide-go="' + R2 + '"]').click(); await settle(5);
  check('answer: a new date not after the current deadline is refused locally', () => (!rc2.some(c => c[0] === 'decide') && /بعد المهلة الحالية/.test(h2.textContent)) || J(rc2));
  D2.getElementById('appt-rx-new-' + R2).value = '2026-11-30';
  D2.getElementById('appt-rx-note-' + R2).value = 'وافق بالبريد';
  h2.querySelector('[data-rx-decide-go="' + R2 + '"]').click(); await settle(10);
  const dc = rc2.filter(c => c[0] === 'decide');
  check('answer → confirm → decideReturnExtension(id, {outcome, decidedUntil, note, idemKey}); toast: updated / skipped / the demurrage hint; refresh', () =>
    (dc.length === 1 && dc[0][1] === R2 && dc[0][2].outcome === 'approved' && dc[0][2].decidedUntil === '2026-11-30' && dc[0][2].note === 'وافق بالبريد' && /^key-/.test(dc[0][2].idemKey)
      && /حُدّث موعد الإرجاع لـ 2 حاوية إلى 2026-11-30/.test(T2.log.toasts[0][1]) && /تُركت 1 حاوية/.test(T2.log.toasts[0][1]) && /غرامات تأخير مفتوحة/.test(T2.log.toasts[0][1]) && T2.log.refresh === 1) || J({ dc, t: T2.log.toasts }));
  h2.querySelector('[data-rx-cancel="' + R2 + '"]').click(); await settle(5);
  h2.querySelector('[data-rx-cancel-go="' + R2 + '"]').click(); await settle(5);
  check('cancel without a reason → refused locally', () => (!rc2.some(c => c[0] === 'cancel') && /اكتب سبب الإلغاء/.test(h2.textContent)) || J(rc2));
  D2.getElementById('appt-rx-why-' + R2).value = 'مدّد الوكيل تلقائيًا';
  h2.querySelector('[data-rx-cancel-go="' + R2 + '"]').click(); await settle(10);
  check('cancel → cancelReturnExtension(id, reason)', () => (rc2.some(c => c[0] === 'cancel' && c[1] === R2 && c[2] === 'مدّد الوكيل تلقائيًا')) || J(rc2));
  const h3 = D2.createElement('div'); D2.body.appendChild(h3);
  await SEC(ctx2).render(h3, tx, txApi(D2, A2, { can: () => false }).api); await settle(10);
  check('a read-only role: the list and the mail / copy links only — no answer / cancel / new request', () =>
    (!!h3.querySelector('[data-rx="' + R2 + '"]') && !h3.querySelector('[data-rx-decide]') && !h3.querySelector('[data-rx-cancel]') && !h3.querySelector('[data-rx-new]')
      && !!h3.querySelector('[data-rx-mail]')) || h3.textContent.slice(0, 200));
  // #alerts → pendingFocus
  const ctx4 = txContext(), D4 = ctx4.document;
  ctx4.w2.MarsaOps.pendingFocus = { tx: TX, section: 'empty_return', open: 'rx' };
  const h4 = D4.createElement('div'); D4.body.appendChild(h4);
  await SEC(ctx4).render(h4, tx, txApi(D4, mkA([], { items: [] })).api); await settle(10);
  check('opened from #alerts (MarsaOps.pendingFocus for this transaction): the new-request form is open, the hint is consumed', () =>
    (!!D4.getElementById('appt-rx-prepare') && ctx4.w2.MarsaOps.pendingFocus === null) || h4.textContent.slice(0, 200));

  section('alerts.js: the action of the empty-return alerts');
  {
    const { document } = makeDom();
    const w = { MarsaI18n: I18N, document, addEventListener() {}, dispatchEvent() {} }; w.window = w;
    const c = { window: w, document, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, CustomEvent: function () {} };
    vm.createContext(c);
    let loaded = true;
    try { vm.runInContext(OPSD, c); vm.runInContext(ALERTS, c); } catch (e) { loaded = String(e); }
    const P = loaded === true && w.MarsaOps.views.alerts._pure;
    check('rxAction: due / overdue without a request → «تجهيز طلب تمديد»; with a request in the title → «متابعة طلب التمديد»; no deadline → «إدخال موعد الإرجاع»; other kinds / resolved → none', () =>
      (P && P.rxAction({ kind: 'empty_return_due', status: 'open', transaction_id: TX, title_ar: 'موعد … — اطلب تمديدًا من الوكيل الملاحي' }) === 'al_rx_prepare'
        && P.rxAction({ kind: 'empty_return_overdue', status: 'acknowledged', transaction_id: TX, title_ar: 'تأخر … — طلب التمديد مُرسَل بانتظار رد الوكيل الملاحي' }) === 'al_rx_open'
        && P.rxAction({ kind: 'empty_return_due', status: 'open', transaction_id: TX, title_en: 'Empty return due X — extension request prepared, not sent yet' }) === 'al_rx_open'
        && P.rxAction({ kind: 'empty_return_no_deadline', status: 'open', transaction_id: TX }) === 'al_rx_deadline'
        && P.rxAction({ kind: 'docs_missing', status: 'open', transaction_id: TX }) === null && P.rxAction({ kind: 'empty_return_due', status: 'resolved', transaction_id: TX }) === null) || String(loaded));
    check('the action sets MarsaOps.pendingFocus {tx, section empty_return, open rx} and goes to #tx/<id>', () =>
      /Ops\.pendingFocus = \{ tx: a\.transaction_id, section: 'empty_return', open: 'rx' \};\s*U\.go\(api, '#tx\/' \+ a\.transaction_id\);/.test(ALERTS) || 'focus');
  }
  await settle(20);
  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();

#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy gaps (20261201000100), staff console: the new-transaction form and the client directory
  (assets/js/admin.js + assets/i18n/admin.js). LOCAL TESTS ONLY: runs admin.html + i18n.js + i18n/admin.js + admin.js
  in jsdom against a recording MarsaApi mock. No database, no network (fetch throws). Invented data only.

  Covers: the importer typeahead (2+ letters or a code-like token → matchClient; 1 letter → nothing); a picked match shows
  its Daftra code read-only and prefills the client category; the follow-up employee select (current user by default,
  list_assignable_staff for the chosen branch) → createTransaction(row.responsible_user_id); seal no. + size/type rows
  per container (upper case, no spaces) → addContainer; a too-long seal blocks the save; the category changed on the
  form → setClientLegacyFields after the create (unchanged → no call; a failure → warning, transaction kept);
  «تفريغ النموذج» (no question when nothing was typed, asks and resets everything when something was); the
  transaction edit dialog changes responsible_user_id only; #clients shows the Daftra code + category, the client
  page shows both, the edit dialog validates the code and sends only changed keys before updateClient (an error stops
  the save); ES5 + ar/en parity of the new i18n keys.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-gaps-txform-tests.js [/path/to/marsa-website] [--quiet]
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
globalThis.fetch = async () => { throw new Error('network forbidden'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORG = 'e1a00000-0000-4000-8000-0000000000aa';
const BR = 'e1a00000-0000-4000-8000-0000000000b1';
const U1 = 'e1a00000-0000-4000-8000-0000000000c1';
const U2 = 'e1a00000-0000-4000-8000-0000000000c2';
const CL = 'e1a00000-0000-4000-8000-0000000000d1';
const TX = 'e1a00000-0000-4000-8000-0000000000e1';

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
  const calls = [], toasts = [];
  const rec = (n, a) => calls.push({ n, a });
  const ok = d => Promise.resolve({ data: d, error: null, count: Array.isArray(d) ? d.length : null });
  const client = Object.assign({ id: CL, org_id: ORG, name_ar: 'شركة الاختبار للتجارة', name_en: 'Test Trading Co', client_type: 'business', is_active: true,
    cr_number: '1010000001', vat_number: null, national_address: {}, daftra_client_code: 'C-100', port_category: 'port' }, opts.client || {});
  const tx = { id: TX, org_id: ORG, branch_id: BR, ref: 'TX-0001', client_id: CL, operation: 'import', mode: 'sea', operational_status: 'new',
    financial_status: 'not_started', created_at: '2026-11-10T08:00:00Z', container_count: 0, responsible_user_id: U1,
    clients: { id: CL, name_ar: client.name_ar }, branches: { name_ar: 'فرع الاختبار' }, containers: [] };
  const known = {
    isOnline: () => true,
    getSession: () => ok({ user: { id: U1 } }),
    myContext: () => ok({ user_id: U1, profile: { full_name: 'منى الاختبار' },
      memberships: [{ org_id: ORG, org_slug: 'test', org_name_ar: 'مؤسسة الاختبار', role: 'clearance_staff', branch_id: null }] }),
    activeOrgId: () => ok(ORG),
    listBranches: () => ok([{ id: BR, org_id: ORG, code: 'TST', name_ar: 'فرع الاختبار', is_active: true }]),
    statusLabels: () => ok([]),
    matchClient: (p, o) => { rec('matchClient', p); return ok({ candidates: [{ client_id: CL, name_ar: client.name_ar, name_en: client.name_en, cr_number: client.cr_number,
      is_active: true, match: 'strong', score: 1, reasons: ['daftra_code'], daftra_client_code: 'C-100', port_category: 'port' }], conflict: false, linked: false }); },
    listAssignableStaff: o => { rec('listAssignableStaff', o); return ok({ rows: [{ user_id: U1, full_name: 'منى الاختبار' },
      { user_id: U2, full_name: 'سالم التجربة' }] }); },
    createTransaction: row => { rec('createTransaction', row); return ok(Object.assign({}, tx, row, { id: TX, ref: 'TX-0002' })); },
    addContainer: (id, row) => { rec('addContainer', row); return ok(Object.assign({ id: 'e1a00000-0000-4000-8000-0000000000f1' }, row)); },
    setClientLegacyFields: (id, p) => { rec('setClientLegacyFields', { id, p }); return opts.legacyErr ? Promise.resolve({ data: null, error: opts.legacyErr }) : ok({ client_id: id, changed: true }); },
    getClient: id => { rec('getClient', id); return ok(client); },
    listClients: o => { rec('listClients', o); return ok([client]); },
    updateClient: (id, row) => { rec('updateClient', { id, row }); return ok(Object.assign({}, client, row)); },
    getTransaction: id => ok(tx),
    updateTransaction: (id, patch) => { rec('updateTransaction', { id, patch }); return ok(Object.assign({}, tx, patch)); },
    listTransactions: () => ok([]),
    listClientAliases: () => ok([]),
    errorMessage: e => (e && e.message) || 'error'
  };
  // anything else the page asks for answers "nothing" ({ data: [], error: null })
  w.MarsaApi = new Proxy(known, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && !/^(then|toJSON)$/.test(k) ? () => ok([]) : undefined)) });
  w.Marsa = { toast: (m, t) => toasts.push({ m, t }) };
  const errors = [];
  w.addEventListener('error', e => errors.push(String(e.message)));
  // opts.lx: also the legacy transaction module (tx-legacy.js fields + Ro-Ro toggles) as admin.html loads it
  const files = opts.lx ? ['assets/js/i18n.js', 'assets/i18n/admin.js', 'assets/i18n/ops.js', 'assets/js/legacy-norm.js', 'assets/js/ops/tx-sections.js', 'assets/js/ops/tx-legacy.js', 'assets/js/admin.js']
    : ['assets/js/i18n.js', 'assets/i18n/admin.js', 'assets/js/admin.js'];
  files.forEach(f => {
    try { w.eval(rd(f) + '\n//# sourceURL=' + f); } catch (e) { errors.push(f + ': ' + e.message); }
  });
  return { dom, w, d: w.document, calls, toasts, errors, of: n => calls.filter(c => c.n === n) };
}
async function settle(ms) { await sleep(ms || 30); }
function fire(w, n, type) { n.dispatchEvent(new w.Event(type, { bubbles: true })); }
function setVal(w, n, v) { n.value = v; fire(w, n, 'input'); fire(w, n, 'change'); }
async function openTxNew(P) {
  P.w.location.hash = '#transactions';
  await settle(80);
  const btn = Array.prototype.find.call(P.d.querySelectorAll('button'), b => /معاملة جديدة/.test(b.textContent));
  if (!btn) throw new Error('no «معاملة جديدة» button; errors: ' + J(P.errors) + ' gate: ' + P.d.getElementById('adm-gate').hidden + ' ' + P.d.getElementById('adm-gate').textContent.trim().slice(0, 200) + ' view: ' + P.d.getElementById('adm-view').textContent.slice(0, 300));
  btn.click();
  await settle(40);
  return P.d.getElementById('adm-dialog-body');
}
function submit(P) { P.d.getElementById('adm-dialog-form').dispatchEvent(new P.w.Event('submit', { bubbles: true, cancelable: true })); }

(async function main() {
  if (!QUIET) console.log('\n== static');
  const ADMIN = rd('assets/js/admin.js'), I18N = rd('assets/i18n/admin.js');
  await check('admin.js / i18n/admin.js: ES5 (no let / const / arrow / template / class)', () => {
    const bad = [];
    [['admin.js', ADMIN], ['i18n/admin.js', I18N]].forEach(([f, src0]) => {
      const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      if (/\b(let|const|class)\s+[A-Za-z_$]/.test(src) || /=>/.test(src) || /`/.test(src)) bad.push(f);
    });
    return !bad.length || bad.join(', ');
  });
  const keys = ['txnew_client_typing', 'match_code', 'match_reason_daftra_code', 'match_reason_daftra_code_prefix', 'match_reason_name_prefix',
    'client_port_category', 'client_cat_none', 'client_daftra_code', 'client_daftra_code_hint', 'client_bad_daftra_code', 'client_legacy_failed',
    'client_classification_internal', 'col_daftra_code', 'col_port_category', 'txnew_code_none', 'txnew_cat_hint', 'txnew_warn_cat', 'tx_responsible',
    'tx_responsible_hint', 'txnew_responsible_none', 'txnew_responsible_hint', 'staff_load_failed', 'txnew_ctr_details', 'txnew_ctr_no', 'txnew_ctr_seal',
    'txnew_ctr_size', 'txnew_ctr_details_hint', 'txnew_bad_seal', 'txnew_bad_size', 'txnew_clear', 'txnew_clear_title', 'txnew_clear_confirm', 'txnew_cleared'];
  await check('i18n/admin.js: every new key has Arabic + English; English category labels', () => {
    let d = null;
    const win = { MarsaI18n: { register: (ns, x) => { d = x; } } };
    new Function('window', I18N)(win);
    const miss = keys.filter(k => !d.ar[k] || !d.en[k]).concat(['airport', 'port', 'shared'].map(k => 'lbl_client_port_category_' + k).filter(k => !d.en[k]));
    return !miss.length || miss.join(', ');
  });
  await check("admin.js loads the 'client_port_category' label domain (fallback مطار / ميناء / مشترك)", () =>
    (/'movement_status', 'client_port_category'\]/.test(ADMIN) && /client_port_category: \{ airport: 'مطار', port: 'ميناء', shared: 'مشترك' \}/.test(ADMIN)) || 'missing');

  if (!QUIET) console.log('\n== new transaction form');
  {
    const P = page();
    await settle(60);
    const b = await openTxNew(P);
    const q = s => b.querySelector(s);
    await check('dialog opens with the clear button, the category select, the read-only Daftra code and the employee select', () => {
      const cat = q('[name=port_category]'), code = q('#adg-client_daftra_code'), staff = q('[name=responsible_user_id]');
      const opts = cat ? Array.prototype.map.call(cat.options, o => o.value) : null;
      return (!!q('[data-txnew-clear]') && J(opts) === J(['', 'airport', 'port', 'shared']) && code && code.readOnly && staff && staff.value === U1 && !P.errors.length)
        || J({ opts, code: !!code, staff: staff && staff.value, errors: P.errors });
    });
    await check('employee list asked for the chosen branch; both staff members listed, the current user selected', () => {
      const c = P.of('listAssignableStaff'), s = q('[name=responsible_user_id]');
      const vals = Array.prototype.map.call(s.options, o => o.value);
      return (c.length >= 1 && c[c.length - 1].a.branchId === BR && J(vals) === J(['', U1, U2]) && s.value === U1) || J({ c: c.map(x => x.a), vals, v: s.value });
    });
    const name = q('[name=client_name]');
    await check('typeahead: 1 letter → no match call', async () => {
      setVal(P.w, name, 'ش'); await sleep(550);
      return P.of('matchClient').length === 0 || J(P.of('matchClient'));
    });
    await check('typeahead: 2 letters → matchClient({ name })', async () => {
      setVal(P.w, name, 'شر'); await sleep(550);
      const c = P.of('matchClient');
      return (c.length === 1 && c[0].a.name === 'شر') || J(c);
    });
    await check('typeahead: a Daftra code typed as the name → matchClient; the candidate shows its code', async () => {
      setVal(P.w, name, 'C-1'); await sleep(550);
      const c = P.of('matchClient');
      return (c.length === 2 && c[1].a.name === 'C-1' && /C-100/.test(q('.adm-match-list').textContent)) || J({ c, t: q('.adm-match-list').textContent });
    });
    await check('the candidate\'s Daftra code / CR sit in <bdi dir="ltr"> (no reordering in the Arabic line)', () => {
      const bd = Array.prototype.map.call(q('.adm-match-list').querySelectorAll('.adm-mini-sub bdi[dir=ltr]'), x => x.textContent);
      const sub = q('.adm-match-list .adm-mini-sub').textContent;
      return (J(bd) === J(['C-100', '1010000001']) && /دفترة C-100 · س\.ت 1010000001 — /.test(sub)) || J({ bd, sub });
    });
    await check('the client select lists a client\'s Daftra code inside Unicode isolates (LRI … PDI)', async () => {
      const sel = q('[name=client_id]');
      sel.dispatchEvent(new P.w.Event('focus')); await settle();
      const o = Array.prototype.find.call(sel.options, x => x.value === CL);
      return (o && o.text === 'شركة الاختبار للتجارة' + ' — \u2066C-100\u2069') || J(o && o.text);
    });
    await check('picking the match: client selected, Daftra code shown read-only, category prefilled (port)', async () => {
      const pick = Array.prototype.find.call(q('.adm-match-list').querySelectorAll('button'), x => /اختيار/.test(x.textContent));
      pick.click(); await settle();
      return (q('[name=client_id]').value === CL && q('#adg-client_daftra_code').value === 'C-100' && q('[name=port_category]').value === 'port')
        || J({ c: q('[name=client_id]').value, code: q('#adg-client_daftra_code').value, cat: q('[name=port_category]').value });
    });
    await check('seal / size rows appear per valid container number', async () => {
      setVal(P.w, q('[name=containers]'), 'MSCU1234567, TGHU7654321'); await settle();
      const s1 = q('[name=ctr_seal_MSCU1234567]'), z1 = q('[name=ctr_size_MSCU1234567]'), s2 = q('[name=ctr_seal_TGHU7654321]');
      return (!!(s1 && z1 && s2) && s1.getAttribute('maxlength') === '30' && z1.getAttribute('maxlength') === '10') || 'rows missing';
    });
    await check('a seal no. over 30 characters blocks the save (nothing created)', async () => {
      q('[name=ctr_seal_MSCU1234567]').value = 'S'.repeat(31);
      submit(P); await settle(60);
      const err = P.d.getElementById('adm-dialog-error');
      return (P.of('createTransaction').length === 0 && !err.hidden && /30/.test(err.textContent)) || J({ n: P.of('createTransaction').length, e: err.textContent });
    });
    await check('save: responsible_user_id, seal / size (upper case, no spaces) per container, category change sent after the create', async () => {
      q('[name=ctr_seal_MSCU1234567]').value = 'ab 12 34';
      q('[name=ctr_size_MSCU1234567]').value = '40hc';
      const staff = q('[name=responsible_user_id]'); staff.value = U2; fire(P.w, staff, 'change');
      const cat = q('[name=port_category]'); cat.value = 'airport'; fire(P.w, cat, 'change');
      submit(P); await settle(120);
      const ct = P.of('createTransaction'), ac = P.of('addContainer').map(c => c.a), lg = P.of('setClientLegacyFields');
      const okRow = ct.length === 1 && ct[0].a.responsible_user_id === U2 && ct[0].a.client_id === CL && ct[0].a.container_count === 2;
      const okCtr = J(ac) === J([{ container_no: 'MSCU1234567', seal_no: 'AB1234', size_type: '40HC' }, { container_no: 'TGHU7654321' }]);
      const okCat = lg.length === 1 && lg[0].a.id === CL && J(lg[0].a.p) === J({ port_category: 'airport' });
      const last = P.toasts[P.toasts.length - 1] || {};
      return (okRow && okCtr && okCat && last.t === 'success') || J({ ct: ct.map(c => c.a), ac, lg: lg.map(c => c.a), last });
    });
  }
  {
    const P = page();
    await settle(60);
    const b = await openTxNew(P);
    const q = s => b.querySelector(s);
    await check('category untouched → no setClientLegacyFields; responsible defaults to the current user', async () => {
      setVal(P.w, q('[name=client_name]'), 'C-100'); await sleep(550);
      Array.prototype.find.call(q('.adm-match-list').querySelectorAll('button'), x => /اختيار/.test(x.textContent)).click(); await settle();
      submit(P); await settle(120);
      const ct = P.of('createTransaction');
      return (ct.length === 1 && ct[0].a.responsible_user_id === U1 && P.of('setClientLegacyFields').length === 0) || J({ ct: ct.map(c => c.a), lg: P.of('setClientLegacyFields') });
    });
  }
  {
    const P = page({ legacyErr: { code: 'MRS_FORBIDDEN', message: 'forbidden' } });
    await settle(60);
    const b = await openTxNew(P);
    const q = s => b.querySelector(s);
    await check('a failed category update → warning toast, the transaction stays created', async () => {
      setVal(P.w, q('[name=client_name]'), 'C-100'); await sleep(550);
      Array.prototype.find.call(q('.adm-match-list').querySelectorAll('button'), x => /اختيار/.test(x.textContent)).click(); await settle();
      const cat = q('[name=port_category]'); cat.value = 'shared'; fire(P.w, cat, 'change');
      submit(P); await settle(120);
      const last = P.toasts[P.toasts.length - 1] || {};
      return (P.of('createTransaction').length === 1 && P.of('setClientLegacyFields').length === 1 && last.t === 'warning' && /تصنيف العميل/.test(last.m))
        || J({ last, n: P.of('createTransaction').length });
    });
  }
  {
    const P = page();
    await settle(60);
    const b = await openTxNew(P);
    const q = s => b.querySelector(s);
    await check('«تفريغ النموذج» with nothing typed: no question', async () => {
      q('[data-txnew-clear]').click(); await settle();
      return !P.d.querySelector('.adm-dlg-confirm') || 'asked';
    });
    await check('«تفريغ النموذج» after typing: asks; confirming resets every field (name, containers + rows, category, employee, checkbox)', async () => {
      setVal(P.w, q('[name=client_name]'), 'C-100'); await sleep(550);
      Array.prototype.find.call(q('.adm-match-list').querySelectorAll('button'), x => /اختيار/.test(x.textContent)).click(); await settle();
      setVal(P.w, q('[name=containers]'), 'MSCU1234567'); await settle();
      q('[name=ctr_seal_MSCU1234567]').value = 'X1';
      const staff = q('[name=responsible_user_id]'); staff.value = U2; fire(P.w, staff, 'change');
      q('[name=save_alias]').checked = false;
      q('[name=bl_number]').value = 'MEDU0000001';
      q('[data-txnew-clear]').click(); await settle();
      const strip = P.d.querySelector('.adm-dlg-confirm');
      if (!strip) return 'no confirmation';
      strip.querySelector('.btn-danger, .btn-primary').click(); await settle(60);
      const r = { name: q('[name=client_name]').value, ctr: q('[name=containers]').value, rows: q('[data-ctr-details]').children.length,
        client: q('[name=client_id]').value, code: q('#adg-client_daftra_code').value, cat: q('[name=port_category]').value,
        staff: q('[name=responsible_user_id]').value, alias: q('[name=save_alias]').checked, bl: q('[name=bl_number]').value, match: q('.adm-match-list').textContent };
      return (r.name === '' && r.ctr === '' && r.rows === 0 && r.client === '' && r.code === '' && r.cat === '' && r.staff === U1 && r.alias === true && r.bl === '' && r.match === '') || J(r);
    });
  }

  {
    const P = page({ lx: true });
    await settle(60);
    const b = await openTxNew(P);
    const q = s => b.querySelector(s);
    await check('with tx-legacy.js loaded: the clear button resets the legacy fields too (Ro-Ro back to container, no page errors)', async () => {
      const unit = q('[name=cargo_unit_type]');
      if (!unit) return 'no cargo_unit_type field';
      const was = unit.value;
      unit.value = 'roro'; fire(P.w, unit, 'change');
      setVal(P.w, q('[name=client_name]'), 'اختبار'); await sleep(550);
      q('[data-txnew-clear]').click(); await settle();
      const strip = P.d.querySelector('.adm-dlg-confirm');
      if (!strip) return 'no confirmation';
      strip.querySelector('.btn-danger, .btn-primary').click(); await settle(60);
      return (unit.value === was && q('[name=client_name]').value === '' && !P.errors.length) || J({ unit: unit.value, was, errors: P.errors });
    });
  }

  if (!QUIET) console.log('\n== transaction edit: follow-up employee');
  {
    const P = page({ hash: '#tx/' + TX });
    await settle(150);
    await check('detail page shows «الموظف المتابع»', () => /الموظف المتابع/.test(P.d.getElementById('adm-view').textContent) || P.errors.join(' | ') || 'missing');
    await check('edit dialog: employee select (branch list); changing it sends only responsible_user_id', async () => {
      const btn = P.d.querySelector('[data-act=tx-edit]');
      if (!btn) return 'no edit button';
      btn.click(); await settle(60);
      const s = P.d.querySelector('#adm-dialog-body [name=responsible_user_id]');
      if (!s || s.value !== U1) return 'select ' + (s && s.value);
      const c = P.of('listAssignableStaff');
      s.value = U2; fire(P.w, s, 'change');
      submit(P); await settle(80);
      const u = P.of('updateTransaction');
      return (c.length && c[c.length - 1].a.branchId === BR && u.length === 1 && J(u[0].a.patch) === J({ responsible_user_id: U2 })) || J({ u: u.map(x => x.a), c: c.map(x => x.a) });
    });
  }

  if (!QUIET) console.log('\n== client directory');
  {
    const P = page({ hash: '#clients' });
    await settle(120);
    await check('#clients: Daftra code + category columns and values', () => {
      const v = P.d.getElementById('adm-view').textContent;
      return (/كود دفترة/.test(v) && /C-100/.test(v) && /ميناء/.test(v)) || v.slice(0, 400);
    });
  }
  {
    const P = page({ hash: '#client/' + CL });
    await settle(120);
    await check('client page: Daftra code + category shown', () => {
      const v = P.d.getElementById('adm-view').textContent;
      return (/كود العميل في دفترة/.test(v) && /C-100/.test(v) && /تصنيف العميل/.test(v) && /ميناء/.test(v)) || v.slice(0, 400);
    });
    const openEdit = async () => { P.d.querySelector('[data-act=client-edit]').click(); await settle(40); return P.d.getElementById('adm-dialog-body'); };
    await check('edit dialog: prefilled; a malformed code is refused before any write', async () => {
      const b = await openEdit();
      const code = b.querySelector('[name=daftra_client_code]'), cat = b.querySelector('[name=port_category]');
      if (!code || code.value !== 'C-100' || cat.value !== 'port') return J({ code: code && code.value, cat: cat && cat.value });
      code.value = 'bad code!';
      submit(P); await settle(60);
      const err = P.d.getElementById('adm-dialog-error');
      return (!err.hidden && P.of('setClientLegacyFields').length === 0 && P.of('updateClient').length === 0) || J({ e: err.textContent });
    });
    await check('edit dialog: only the changed key → setClientLegacyFields, then updateClient', async () => {
      const b = P.d.getElementById('adm-dialog-body');
      b.querySelector('[name=daftra_client_code]').value = 'C-200';
      submit(P); await settle(80);
      const lg = P.of('setClientLegacyFields'), up = P.of('updateClient');
      const order = P.calls.findIndex(c => c.n === 'setClientLegacyFields') < P.calls.findIndex(c => c.n === 'updateClient');
      return (lg.length === 1 && J(lg[0].a) === J({ id: CL, p: { daftra_client_code: 'C-200' } }) && up.length === 1 && order) || J({ lg: lg.map(x => x.a), up: up.length });
    });
    await check('edit dialog: a code typed in Arabic-Indic digits (١٠٠١) is accepted and sent as 1001', async () => {
      const b = await openEdit();
      b.querySelector('[name=daftra_client_code]').value = '١٠٠١';
      const n0 = P.of('setClientLegacyFields').length;
      submit(P); await settle(80);
      const lg = P.of('setClientLegacyFields'), err = P.d.getElementById('adm-dialog-error');
      return (lg.length === n0 + 1 && J(lg[lg.length - 1].a.p) === J({ daftra_client_code: '1001' })) || J({ lg: lg.map(x => x.a), e: err && !err.hidden && err.textContent });
    });
  }
  {
    const P = page({ hash: '#client/' + CL, legacyErr: { code: 'MRS_INVALID', message: 'كود العميل في دفترة مستخدم لعميل آخر في مؤسستك.' } });
    await settle(120);
    await check('edit dialog: a taken code → the error is shown and updateClient is not called', async () => {
      P.d.querySelector('[data-act=client-edit]').click(); await settle(40);
      const b = P.d.getElementById('adm-dialog-body');
      b.querySelector('[name=port_category]').value = '';
      submit(P); await settle(80);
      const err = P.d.getElementById('adm-dialog-error'), lg = P.of('setClientLegacyFields');
      return (!err.hidden && /مستخدم/.test(err.textContent) && lg.length === 1 && J(lg[0].a.p) === J({ port_category: null }) && P.of('updateClient').length === 0)
        || J({ e: err.textContent, lg: lg.map(x => x.a), up: P.of('updateClient').length });
    });
  }

  console.log('\nMarsa — legacy-gaps tx form / clients UI tests: ' + nPass + ' passed, ' + nFail + ' failed (' + (nPass + nFail) + ' checks)');
  if (nFail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();

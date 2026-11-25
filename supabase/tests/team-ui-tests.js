#!/usr/bin/env node
/*
  Marsa — «الفريق» (#team) in the staff panel: three sign-in tiers (owner decision; migration
  20261215000100_team_tiers.sql). LOCAL TESTS ONLY: runs admin.html (scripts stripped) + i18n.js + i18n/admin.js +
  i18n/app.js + app-shell.js + admin.js in jsdom against a recording MarsaApi mock. No database, no network.
  Invented data only.

  Covers:
    * #team is the team view, #members opens the same view (hash normalised to #team), one menu item «الفريق»;
    * header card names the organisation owner (owner badge in the admins list);
    * the OWNER: «إضافة مسؤول» (invite dialog with role admin only → invite(role admin)), activate / deactivate on
      other admins (never on the owner row / itself), «نقل الملكية» dialog → confirm → ownerTransfer(org, membership),
      MRS_FORBIDDEN owner_only shown in clear words;
    * a NON-OWNER admin: admins list read-only + the note «إضافة المسؤولين من صلاحية صاحب المؤسسة», no transfer, the
      employees panel keeps «دعوة موظف» (no admin role in it) and deactivate buttons; admin invitations without
      revoke / reissue; MRS_FORBIDDEN owner on a deactivation in clear words;
    * panels by tier: «الإدارة» = admins + branch_manager + supervisor, «الموظفون» = the five employee roles only
      (its invite dialog offers exactly those), «دعوة مدير فرع أو مشرف» for the owner and the admins;
    * LEGACY org (no owner flagged; database without the flag): every org-wide admin acts as the owner (my_context's
      is_owner is the EFFECTIVE value, as the server sends it) — each one sees «إضافة مسؤول», nobody «نقل الملكية»
      (owner_transfer needs a real flagged owner); a flagged but deactivated owner row is named as deactivated;
    * branch manager: no owner card / no false "no owner set" note, employees panel scoped by the server's
      can_manage; supervisor: read-only;
    * static: ES5 in the new admin.js code, ar + en for every team_* key, supa.js ownerTransfer wrapper.

  usage:  NODE_PATH=/path/to/node_modules node supabase/tests/team-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
async function settle(ms) { await sleep(ms || 60); }

const ORG = 'f0b00000-0000-4000-8000-0000000000a1';
const BR = 'f0b00000-0000-4000-8000-0000000000b1';
const U_OWNER = 'f0b00000-0000-4000-8000-0000000000c1';
const U_ADMIN2 = 'f0b00000-0000-4000-8000-0000000000c2';
const U_ADMIN3 = 'f0b00000-0000-4000-8000-0000000000c3';
const U_BM = 'f0b00000-0000-4000-8000-0000000000c4';
const U_CLR = 'f0b00000-0000-4000-8000-0000000000c5';
const U_SUP = 'f0b00000-0000-4000-8000-0000000000c6';
const M = n => 'f0b00000-0000-4000-8000-0000000001' + String(n).padStart(2, '0');
const EMPLOYEES = ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager'];

// invented team: owner, two more admins, a branch manager, a clearance officer, a supervisor
function team(opts) {
  const legacy = opts.legacy, noFlag = opts.noFlag, inactiveOwner = opts.inactiveOwner;
  const row = (id, uid, name, email, role, branch, owner, active) => {
    const r = { id, user_id: uid, email, full_name: name, phone: '0500000000', role, branch_id: branch || null, branch_code: branch ? 'JED' : null,
      branch_name_ar: branch ? 'فرع جدة التجريبي' : null, is_active: active !== false, created_at: '2026-11-01T08:00:00Z', is_me: uid === opts.me };
    if (!noFlag) r.is_owner = !legacy && !!owner;
    return r;
  };
  return [
    row(M(1), U_OWNER, 'تجريبي — صاحب المكتب', 'owner@example.test', 'admin', null, true, !inactiveOwner),
    row(M(2), U_ADMIN2, 'تجريبي — مسؤول ثان', 'admin2@example.test', 'admin', null, false),
    row(M(3), U_ADMIN3, 'تجريبي — مسؤول موقوف', 'admin3@example.test', 'admin', null, false, false),
    row(M(4), U_BM, 'تجريبي — مدير فرع', 'bm@example.test', 'branch_manager', BR, false),
    row(M(5), U_CLR, 'تجريبي — مخلص', 'clr@example.test', 'clearance_staff', BR, false),
    row(M(6), U_SUP, 'تجريبي — مشرف', 'sup@example.test', 'supervisor', null, false)
  ];
}
// the EFFECTIVE owner status of `me` as the server computes it (app.is_org_owner / my_context is_owner): the active
// flagged owner row, or — LEGACY — any org-wide admin while the org has no ACTIVE owner row
function effectiveOwner(me, rows) {
  if (me.role !== 'admin' || me.branch) return false;
  const mine = rows.find(x => x.user_id === me.uid && x.role === 'admin' && !x.branch_id);
  return !!(mine && mine.is_owner === true && mine.is_active) || !rows.some(x => x.is_owner === true && x.is_active);
}
// what the server would answer for can_manage (app.can_manage_member, 20261215000100)
function serverCanManage(me, r, rows) {
  if (r.user_id === me.uid) return false;
  const isOwner = effectiveOwner(me, rows);
  if (r.is_owner) return false;
  if (r.role === 'admin') return isOwner;
  if (me.role === 'admin') return true;
  if (me.role === 'branch_manager') return ['clearance_staff', 'transport_staff', 'accountant'].indexOf(r.role) !== -1 && r.branch_id === BR;
  return false;
}

/* ------------------------------------------------------------------ page */
function page(opts) {
  opts = opts || {};
  const me = opts.me || { uid: U_OWNER, role: 'admin', branch: null, owner: true };
  const html = rd('admin.html').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '');
  const dom = new JSDOM(html, { url: 'https://marsa.test/admin.html' + (opts.hash || '#team'), runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = globalThis.fetch;
  w.confirm = () => true;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  const calls = [];
  const rec = (n, a) => calls.push({ n, a });
  const ok = d => Promise.resolve({ data: d, error: null });
  const state = {};
  let rows = team({ me: me.uid, legacy: opts.legacy, noFlag: opts.noFlag, inactiveOwner: opts.inactiveOwner });
  const listRows = () => {
    let out = rows.map(r => Object.assign({}, r, { can_manage: serverCanManage(me, r, rows) }));
    // admin_list_members: org admins see every row; a branch manager only its manageable rows + itself
    if (me.role === 'branch_manager') out = out.filter(r => r.can_manage || r.user_id === me.uid);
    return out;
  };
  function ctx() {
    const m = { org_id: ORG, org_slug: 'org-test', org_name_ar: 'مؤسسة الاختبار', org_name_en: 'Test Org', role: me.role, branch_id: me.branch || null, is_active: true };
    // my_context sends the EFFECTIVE value (20261215000100): true for every org-wide admin while no active owner
    if (!opts.noFlag) m.is_owner = effectiveOwner(me, rows);
    return { user_id: me.uid, profile: { full_name: 'تجريبي — مستخدم' }, is_platform_admin: false, clients: [], memberships: [m],
      organizations: [{ org_id: ORG, slug: 'org-test', name_ar: 'مؤسسة الاختبار', name_en: 'Test Org' }] };
  }
  const qb = {
    _sel: '', select(s) { this._sel = s || ''; return this; }, eq() { return this; }, order() { return this; }, limit() { return this; }, in() { return this; }, not() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    then(res, rej) {
      // supervisor's read-only list (memberships table, RLS): the flat rows with nested profiles
      const data = rows.map(r => ({ id: r.id, user_id: r.user_id, org_id: ORG, branch_id: r.branch_id, role: r.role, is_active: r.is_active, is_owner: r.is_owner, created_at: r.created_at,
        profiles: { full_name: r.full_name, phone: r.phone } }));
      if (/is_owner/.test(this._sel) && opts.noFlag) return Promise.resolve({ data: null, error: { code: '42703', message: 'column memberships.is_owner does not exist' } }).then(res, rej);
      return Promise.resolve({ data: /memberships|is_owner|profiles/.test(this._sel) ? data : null, error: null, count: 0 }).then(res, rej);
    }
  };
  const known = {
    isOnline: () => true,
    ready: () => ok(true),
    client: { from: () => { qb._sel = ''; return qb; } },
    getSession: () => ok({ user: { id: me.uid, email: 'me@example.test' } }),
    myContext: () => ok(ctx()),
    activeOrgId: () => ok(ORG),
    setActiveOrg: id => ok(id),
    onAuth: () => {},
    listBranches: () => ok([{ id: BR, org_id: ORG, code: 'JED', name_ar: 'فرع جدة التجريبي', is_active: true }]),
    statusLabels: () => ok([]),
    errorMessage: e => (e && e.message) || 'error',
    listMembers: oid => { rec('listMembers', { oid }); return ok(listRows()); },
    listMemberships: oid => { rec('listMemberships', { oid }); return ok(rows.map(r => ({ id: r.id, user_id: r.user_id, role: r.role, branch_id: r.branch_id, is_active: r.is_active, created_at: r.created_at, profiles: { full_name: r.full_name, phone: r.phone } }))); },
    listInvitations: oid => { rec('listInvitations', { oid }); return ok([
      { id: M(50), email: 'newadmin@example.test', role: 'admin', branch_id: null, created_at: '2026-11-20T08:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
      { id: M(51), email: 'newclr@example.test', role: 'clearance_staff', branch_id: BR, created_at: '2026-11-20T08:00:00Z', expires_at: '2099-01-01T00:00:00Z' }
    ]); },
    invite: (oid, payload) => { rec('invite', { oid, payload }); return ok({ invitation_id: M(60), email: payload.email, role: payload.role, expires_at: '2099-01-01T00:00:00Z', token: 'tok-test' }); },
    setMembershipActive: (id, active) => {
      rec('setMembershipActive', { id, active });
      if (opts.toggleErr) return Promise.resolve({ data: null, error: opts.toggleErr });
      rows = rows.map(r => r.id === id ? Object.assign({}, r, { is_active: active }) : r);
      return ok({ id, is_active: active });
    },
    ownerTransfer: (oid, mid) => {
      rec('ownerTransfer', { oid, mid });
      if (opts.transferErr) return Promise.resolve({ data: null, error: opts.transferErr });
      rows = rows.map(r => Object.assign({}, r, { is_owner: r.id === mid }));
      return ok({ org_id: oid, owner_membership: mid });
    },
    listClients: () => ok([])
  };
  w.MarsaApi = new Proxy(known, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && !/^(then|toJSON)$/.test(k) ? () => ok([]) : undefined)) });
  const toasts = [];
  w.Marsa = { toast: (m, t) => toasts.push({ m, t }) };
  const errors = [];
  w.addEventListener('error', e => errors.push(String(e.message)));
  ['assets/js/i18n.js', 'assets/i18n/admin.js', 'assets/i18n/app.js', 'assets/js/app-shell.js', 'assets/js/admin.js'].forEach(f => {
    try { w.eval(rd(f) + '\n//# sourceURL=' + f); } catch (e) { errors.push(f + ': ' + e.message); }
  });
  const d = w.document;
  const P = {
    w, d, calls, errors, state,
    of: n => calls.filter(c => c.n === n),
    toastText: () => Array.prototype.map.call(d.querySelectorAll('.toast-text'), n => n.textContent).concat(toasts.map(x => x.m)),
    card: cls => d.querySelector('#adm-view .' + cls),
    btn: (root, sel) => (root || d).querySelector(sel),
    rowOf: id => d.querySelector('#adm-view [data-member-row="' + id + '"]'),
    // the shell's confirm modal: answer yes without the UI (admin.js holds the same MarsaShell object)
    autoYes: () => { if (w.MarsaShell) w.MarsaShell.confirm = () => Promise.resolve(true); }
  };
  return P;
}
const text = n => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

(async () => {
  section('owner');
  {
    const P = page();
    await settle(120);
    P.autoYes();
    const view = P.d.getElementById('adm-view');
    await check('boots without errors on #team, title «الفريق»', () => (!P.errors.length && text(view.querySelector('.adm-title')) === 'الفريق') || J(P.errors.concat([text(view.querySelector('.adm-title'))])));
    await check('one «الفريق» menu item (settings), no «الأعضاء والدعوات» item', () =>
      (!!P.d.querySelector('#adm-nav [data-nav-group="settings"] [data-nav-id="team"]') && !P.d.querySelector('#adm-nav [data-nav-id="members"]')) || 'nav');
    const ownerCard = P.card('adm-team-owner-card');
    await check('header card names the owner', () => (ownerCard && /صاحب المؤسسة/.test(text(ownerCard)) && /تجريبي — صاحب المكتب/.test(text(ownerCard))) || text(ownerCard));
    const admins = P.card('adm-team-admins'), staff = P.card('adm-team-staff');
    await check('«الإدارة» lists the 3 admins + branch manager + supervisor, owner badge on the owner row only', () =>
      (/الإدارة/.test(text(admins.querySelector('.card-header h3'))) && admins.querySelectorAll('tbody tr[data-member-row]').length === 5
        && [M(1), M(2), M(3), M(4), M(6)].every(id => admins.contains(P.rowOf(id)))
        && !!P.rowOf(M(1)).querySelector('.adm-owner-badge') && admins.querySelectorAll('.adm-owner-badge').length === 1) || text(admins));
    await check('owner sees «إضافة مسؤول», «دعوة مدير فرع أو مشرف» and «نقل الملكية», no read-only note', () =>
      (!!P.btn(admins, '[data-team="add-admin"]') && !!P.btn(admins, '[data-team="invite-mgmt"]') && !!P.btn(admins, '[data-team="transfer"]')
        && !P.btn(admins, '[data-team="admins-note"]')) || text(admins));
    await check('owner card: no legacy / inactive note when the owner row is flagged and active', () =>
      (!P.d.querySelector('#adm-view [data-team="owner-legacy"]') && !P.d.querySelector('#adm-view [data-team="owner-inactive"]')) || text(ownerCard));
    await check('owner: deactivate on another admin, activate on the stopped one, nothing on the own (owner) row', () =>
      (text(P.rowOf(M(2)).querySelector('[data-member]')) === 'إيقاف' && text(P.rowOf(M(3)).querySelector('[data-member]')) === 'تفعيل'
        && !P.rowOf(M(1)).querySelector('[data-member]')) || 'buttons');
    await check('«الموظفون»: the clearance officer only + «دعوة موظف»; deactivate on the employee and on the bm / supervisor rows', () =>
      (staff.querySelectorAll('tbody tr[data-member-row]').length === 1 && staff.contains(P.rowOf(M(5))) && !!P.btn(staff, '[data-team="invite-staff"]')
        && [M(4), M(5), M(6)].every(id => !!P.rowOf(id).querySelector('[data-member]'))) || text(staff));
    await check('pending invitations card stays (admin invitation with re-issue / revoke for the owner)', () => {
      const inv = Array.prototype.find.call(P.d.querySelectorAll('#adm-view .adm-card'), c => text(c.querySelector('.card-header h3')) === 'الدعوات');
      return (inv && inv.querySelectorAll('tbody tr').length === 2 && inv.querySelectorAll('tbody tr')[0].querySelectorAll('button').length === 2) || (inv ? text(inv) : 'no card');
    });

    // add admin
    P.btn(admins, '[data-team="add-admin"]').click();
    await settle(30);
    const dlg = P.d.getElementById('adm-dialog');
    const roleSel = P.d.querySelector('#adm-dialog [name="role"]');
    await check('«إضافة مسؤول» opens the invite dialog with role admin only', () =>
      (dlg.open && text(P.d.getElementById('adm-dialog-title')) === 'إضافة مسؤول جديد' && roleSel && roleSel.options.length === 1 && roleSel.value === 'admin') || (roleSel ? J([].map.call(roleSel.options, o => o.value)) : 'no select'));
    P.d.querySelector('#adm-dialog [name="email"]').value = 'NewAdmin@Example.test';
    P.d.getElementById('adm-dialog-form').dispatchEvent(new P.w.Event('submit', { cancelable: true }));
    await settle(30);
    const okBtn = P.d.querySelector('.adm-dlg-confirm .btn-primary, .adm-dlg-confirm .btn-danger');
    if (okBtn) okBtn.click();
    await settle(60);
    await check('… submit → confirm → invite(role admin, lower-cased e-mail, no branch)', () => {
      const c = P.of('invite')[0];
      return (c && c.a.oid === ORG && c.a.payload.role === 'admin' && c.a.payload.email === 'newadmin@example.test' && !c.a.payload.branch_id) || J(P.of('invite'));
    });
    await check('… the one-time link is shown', () => /tok-test/.test(P.d.querySelector('#adm-dialog .adm-link-input') ? P.d.querySelector('#adm-dialog .adm-link-input').value : '') || 'no link');
    P.d.querySelector('#adm-dialog [data-dialog-cancel]').click();
    await settle(60);

    // employees invite: no admin role there
    P.btn(P.card('adm-team-staff'), '[data-team="invite-staff"]').click();
    await settle(30);
    const roles2 = [].map.call(P.d.querySelectorAll('#adm-dialog [name="role"] option'), o => o.value);
    await check('«دعوة موظف» dialog: exactly the five employee roles (no admin / management / client)', () =>
      J(roles2.slice().sort()) === J(EMPLOYEES.slice().sort()) || J(roles2));
    P.d.querySelector('#adm-dialog [data-dialog-cancel]').click();
    await settle(30);
    P.btn(P.card('adm-team-admins'), '[data-team="invite-mgmt"]').click();
    await settle(30);
    const roles3 = [].map.call(P.d.querySelectorAll('#adm-dialog [name="role"] option'), o => o.value);
    await check('«دعوة مدير فرع أو مشرف» dialog: branch_manager + supervisor only', () => J(roles3.slice().sort()) === J(['branch_manager', 'supervisor']) || J(roles3));
    P.d.querySelector('#adm-dialog [data-dialog-cancel]').click();
    await settle(30);

    // deactivate an employee
    P.rowOf(M(5)).querySelector('[data-member]').click();
    await settle(60);
    await check('employee deactivate → setMembershipActive(id, false)', () => J(P.of('setMembershipActive').map(c => c.a)) === J([{ id: M(5), active: false }]) || J(P.of('setMembershipActive')));

    // transfer ownership
    P.btn(P.card('adm-team-admins'), '[data-team="transfer"]').click();
    await settle(30);
    const tsel = P.d.querySelector('#adm-dialog [name="target"]');
    const tOpts = tsel ? [].map.call(tsel.options, o => o.value) : [];
    await check('«نقل الملكية» dialog: warning + only the other ACTIVE org-wide admin as target', () =>
      (text(P.d.getElementById('adm-dialog-title')) === 'نقل ملكية المؤسسة' && J(tOpts) === J(['', M(2)]) && !!P.d.querySelector('#adm-dialog .alert-warning')) || J(tOpts));
    P.d.getElementById('adm-dialog-form').dispatchEvent(new P.w.Event('submit', { cancelable: true }));
    await settle(30);
    await check('… no target picked → clear message, no call', () =>
      (!P.d.getElementById('adm-dialog-error').hidden && /اختر المسؤول/.test(P.d.getElementById('adm-dialog-error').textContent) && !P.of('ownerTransfer').length) || P.d.getElementById('adm-dialog-error').textContent);
    tsel.value = M(2);
    P.d.getElementById('adm-dialog-form').dispatchEvent(new P.w.Event('submit', { cancelable: true }));
    await settle(30);
    const ask = P.d.querySelector('.adm-dlg-confirm');
    await check('… asks to confirm with the new owner\'s name, nothing sent yet', () => (ask && /تجريبي — مسؤول ثان/.test(text(ask)) && !P.of('ownerTransfer').length) || (ask ? text(ask) : 'no confirm'));
    ask.querySelector('.btn-danger, .btn-primary').click();
    await settle(120);
    await check('… confirmed → ownerTransfer(org, membership), dialog closed, toast', () =>
      (J(P.of('ownerTransfer').map(c => c.a)) === J([{ oid: ORG, mid: M(2) }]) && !P.d.getElementById('adm-dialog').open && P.toastText().some(x => /تم نقل الملكية/.test(x))) || J([P.of('ownerTransfer'), P.toastText()]));
    const admins2 = P.card('adm-team-admins');
    await check('… after the transfer: no «إضافة مسؤول» any more, the read-only note, still «دعوة مدير فرع أو مشرف», the badge on the new owner', () =>
      (admins2 && !P.btn(admins2, '[data-team="add-admin"]') && !P.btn(admins2, '[data-team="transfer"]') && !!P.btn(admins2, '[data-team="admins-note"]')
        && !!P.btn(admins2, '[data-team="invite-mgmt"]')
        && !!P.rowOf(M(2)).querySelector('.adm-owner-badge')) || (admins2 ? text(admins2) : 'no card'));
  }
  {
    const P = page({ transferErr: { code: 'MRS_FORBIDDEN', field: 'owner_only', message: 'x' } });
    await settle(120);
    P.btn(P.card('adm-team-admins'), '[data-team="transfer"]').click();
    await settle(30);
    P.d.querySelector('#adm-dialog [name="target"]').value = M(2);
    P.d.getElementById('adm-dialog-form').dispatchEvent(new P.w.Event('submit', { cancelable: true }));
    await settle(30);
    P.d.querySelector('.adm-dlg-confirm .btn-danger, .adm-dlg-confirm .btn-primary').click();
    await settle(60);
    await check('MRS_FORBIDDEN owner_only → «… من صلاحية صاحب المؤسسة فقط» in the dialog', () =>
      /من صلاحية صاحب المؤسسة فقط/.test(P.d.getElementById('adm-dialog-error').textContent) || P.d.getElementById('adm-dialog-error').textContent);
  }
  {
    const P = page({ hash: '#members' });
    await settle(120);
    await check('#members opens the same team view, hash normalised to #team', () =>
      (P.w.location.hash === '#team' && !!P.card('adm-team-admins') && text(P.d.querySelector('#adm-view .adm-title')) === 'الفريق') || P.w.location.hash);
  }

  section('non-owner admin');
  {
    const P = page({ me: { uid: U_ADMIN2, role: 'admin', branch: null, owner: false }, toggleErr: null });
    await settle(120);
    P.autoYes();
    const admins = P.card('adm-team-admins'), staff = P.card('adm-team-staff');
    await check('admins list read-only: no add / transfer, the note «إضافة المسؤولين من صلاحية صاحب المؤسسة»', () =>
      (!P.btn(admins, '[data-team="add-admin"]') && !P.btn(admins, '[data-team="transfer"]')
        && text(P.btn(admins, '[data-team="admins-note"]')) === 'إضافة المسؤولين من صلاحية صاحب المؤسسة.'
        && [M(1), M(2), M(3)].every(id => !P.rowOf(id).querySelector('[data-member]'))) || text(admins));
    await check('non-owner admin: «دعوة مدير فرع أو مشرف» kept (admin_invite allows it), deactivate on the bm / supervisor rows', () =>
      (!!P.btn(admins, '[data-team="invite-mgmt"]') && [M(4), M(6)].every(id => !!P.rowOf(id).querySelector('[data-member]'))) || text(admins));
    await check('owner card still names the owner', () => /تجريبي — صاحب المكتب/.test(text(P.card('adm-team-owner-card'))) || text(P.card('adm-team-owner-card')));
    await check('employees panel: «دعوة موظف» + deactivate on the employee row', () =>
      (!!P.btn(staff, '[data-team="invite-staff"]') && !!P.rowOf(M(5)).querySelector('[data-member]')) || text(staff));
    P.btn(staff, '[data-team="invite-staff"]').click();
    await settle(30);
    const roles = [].map.call(P.d.querySelectorAll('#adm-dialog [name="role"] option'), o => o.value);
    await check('invite dialog: the five employee roles, without the admin role', () => (J(roles.slice().sort()) === J(EMPLOYEES.slice().sort())) || J(roles));
    P.d.querySelector('#adm-dialog [data-dialog-cancel]').click();
    await settle(30);
    const inv = Array.prototype.find.call(P.d.querySelectorAll('#adm-view .adm-card'), c => text(c.querySelector('.card-header h3')) === 'الدعوات');
    await check('admin invitation: no re-issue / revoke for a non-owner; the employee one keeps both', () => {
      const trs = inv ? inv.querySelectorAll('tbody tr') : [];
      return (trs.length === 2 && trs[0].querySelectorAll('button').length === 0 && trs[1].querySelectorAll('button').length === 2) || (inv ? text(inv) : 'no card');
    });
  }
  {
    const P = page({ me: { uid: U_ADMIN2, role: 'admin', branch: null, owner: false }, toggleErr: { code: 'MRS_FORBIDDEN', field: 'owner', message: 'x' } });
    await settle(120);
    P.autoYes();
    P.rowOf(M(5)).querySelector('[data-member]').click();
    await settle(60);
    await check('MRS_FORBIDDEN owner on a deactivation → «لا يمكن إيقاف حساب صاحب المؤسسة…»', () =>
      P.toastText().some(x => /لا يمكن إيقاف حساب صاحب المؤسسة/.test(x)) || J(P.toastText()));
  }

  section('legacy org, branch manager, supervisor, English');
  for (const who of [{ uid: U_OWNER, row: M(1), other: M(2), name: 'first' }, { uid: U_ADMIN2, row: M(2), other: M(1), name: 'second' }]) {
    const P = page({ me: { uid: who.uid, role: 'admin', branch: null, owner: false }, legacy: true });
    await settle(120);
    const admins = P.card('adm-team-admins');
    await check('legacy 2 admins (' + who.name + '): my_context is_owner is the effective true', () =>
      P.w.MarsaApi.myContext().then(r => r.data.memberships[0].is_owner === true || J(r.data.memberships)));
    await check('legacy 2 admins (' + who.name + '): «إضافة مسؤول» shown, legacy note in the header card, the legacy subtitle', () =>
      (!!P.btn(admins, '[data-team="add-admin"]') && !!P.d.querySelector('#adm-view [data-team="owner-legacy"]')
        && /لم يُحدَّد صاحب المؤسسة بعد/.test(text(P.card('adm-team-owner-card'))) && /نقل الملكية يحتاج صاحبًا محدَّدًا/.test(text(P.d.querySelector('#adm-view'))))
        || text(P.d.getElementById('adm-view')).slice(0, 400));
    await check('legacy 2 admins (' + who.name + '): «نقل الملكية» NOT offered (owner_transfer refuses without a flagged owner)', () =>
      !P.d.querySelector('#adm-view [data-team="transfer"]') || text(admins));
    await check('legacy 2 admins (' + who.name + '): may deactivate the other admin, not itself; no owner badge anywhere', () =>
      (!!P.rowOf(who.other).querySelector('[data-member]') && !P.rowOf(who.row).querySelector('[data-member]') && !P.d.querySelector('#adm-view .adm-owner-badge')) || text(admins));
  }
  {
    const P = page({ me: { uid: U_ADMIN2, role: 'admin', branch: null, owner: false }, inactiveOwner: true });
    await settle(120);
    const oc = P.card('adm-team-owner-card');
    await check('flagged owner row deactivated: the owner card names it, says it is deactivated (admin wording)', () =>
      (/تجريبي — صاحب المكتب/.test(text(oc)) && /موقوف/.test(text(oc)) && /حساب صاحب المؤسسة موقوف حاليًا، فيُعامَل/.test(text(P.btn(oc, '[data-team="owner-inactive"]')))
        && !P.btn(oc, '[data-team="owner-legacy"]')) || text(oc));
    await check('… no active owner: the admin acts as owner (add admin) but no «نقل الملكية»', () =>
      (!!P.btn(P.card('adm-team-admins'), '[data-team="add-admin"]') && !P.d.querySelector('#adm-view [data-team="transfer"]')) || text(P.card('adm-team-admins')));
  }
  {
    const P = page({ me: { uid: U_ADMIN2, role: 'admin', branch: null, owner: false }, noFlag: true });
    await settle(120);
    await check('database without the owner flag yet: today\'s behaviour (every org admin may add admins)', () => !!P.btn(P.card('adm-team-admins'), '[data-team="add-admin"]') || text(P.card('adm-team-admins')));
  }
  {
    const P = page({ me: { uid: U_BM, role: 'branch_manager', branch: BR, owner: false } });
    await settle(120);
    const staff = P.card('adm-team-staff');
    const mg = P.card('adm-team-admins');
    await check('branch manager: no owner card and no false "no owner set" note (its list never holds the owner row)', () =>
      (!P.card('adm-team-owner-card') && !/لم يُحدَّد صاحب المؤسسة/.test(text(P.d.getElementById('adm-view'))) && !P.d.querySelector('#adm-view [data-team="owner-legacy"]'))
        || text(P.d.getElementById('adm-view')).slice(0, 300));
    await check('branch manager: «الإدارة» holds only itself, no add-admin / management invite / note', () =>
      (mg && mg.querySelectorAll('tbody tr[data-member-row]').length === 1 && !P.rowOf(M(4)).querySelector('[data-member]')
        && !P.btn(mg, '[data-team="add-admin"]') && !P.btn(mg, '[data-team="invite-mgmt"]') && !P.btn(mg, '[data-team="admins-note"]')) || (mg ? text(mg) : 'no card'));
    await check('branch manager: its branch employee with deactivate, «دعوة موظف»', () => {
      const rowsShown = staff ? staff.querySelectorAll('tbody tr[data-member-row]').length : 0;
      return (rowsShown === 1 && !!P.rowOf(M(5)).querySelector('[data-member]') && !!P.btn(staff, '[data-team="invite-staff"]')) || (staff ? text(staff) : 'no staff card');
    });
    P.btn(staff, '[data-team="invite-staff"]').click();
    await settle(30);
    const bmRoles = [].map.call(P.d.querySelectorAll('#adm-dialog [name="role"] option'), o => o.value);
    await check('branch manager: «دعوة موظف» offers its branch roles only (no client there)', () =>
      J(bmRoles.slice().sort()) === J(['accountant', 'clearance_staff', 'transport_staff']) || J(bmRoles));
    P.d.querySelector('#adm-dialog [data-dialog-cancel]').click();
    await settle(30);
    await check('branch manager: client invitations from the clients card', () => !!P.d.querySelector('#adm-view .adm-team-clients [data-team="invite-client"]') || 'no invite-client');
  }
  {
    const P = page({ me: { uid: U_SUP, role: 'supervisor', branch: null, owner: false } });
    await settle(120);
    await check('supervisor: read only (no action buttons, no invitations), owner named from the flag', () =>
      (!P.d.querySelector('#adm-view [data-member]') && !P.d.querySelector('#adm-view [data-team="invite-staff"]') && !P.d.querySelector('#adm-view [data-team="add-admin"]')
        && !P.d.querySelector('#adm-view [data-team="invite-mgmt"]') && !P.d.querySelector('#adm-view [data-team="invite-client"]')
        && !P.of('listInvitations').length && !P.of('listMembers').length && /تجريبي — صاحب المكتب/.test(text(P.card('adm-team-owner-card')))) || text(P.d.getElementById('adm-view')));
  }
  {
    const P = page();
    await settle(120);
    P.w.MarsaI18n.setLang && P.w.MarsaI18n.setLang('en');
    await settle(80);
    await check('English: Team / Management / Employees / Add admin / Transfer ownership', () => {
      const v = text(P.d.getElementById('adm-view'));
      return (/Team/.test(v) && /Management/.test(v) && /Employees/.test(v) && /Add admin/.test(v) && /Transfer ownership/.test(v)) || v.slice(0, 300);
    });
  }

  section('static');
  {
    const adm = rd('assets/js/admin.js');
    const block = adm.slice(adm.indexOf('«الفريق» (#team; the old #members'), adm.indexOf('function inviteStatus(i)'));
    await check('new admin.js team code is ES5 (no arrow / let / const / template strings)', () => (block.length > 1000 && !/=>|\blet\s|\bconst\s|`/.test(block)) || 'es6 in block');
    const ctx = { window: { MarsaI18n: { register(n, d) { ctx.dict = d; } } } };
    vm.runInNewContext(rd('assets/i18n/admin.js'), ctx);
    const used = Array.from(new Set((adm.match(/t\('(team_[a-z_]*[a-z])'/g) || []).map(s => s.slice(3, -1))));
    await check('every team_* key used by admin.js exists in ar and en', () => {
      const miss = used.concat(['team_err_owner_only', 'team_err_owner', 'view_team', 'team_sub_owner', 'team_sub_legacy', 'team_sub_admin', 'team_sub_bm',
        'team_sub_read', 'team_add_admin_title', 'team_invite_mgmt_title', 'team_invite_staff_title', 'team_invite_client_title']).filter(k => !ctx.dict.ar[k] || !ctx.dict.en[k]);
      return (used.length > 15 && miss.length === 0) || 'missing: ' + miss.join(', ');
    });
    const supa = rd('assets/js/supa.js');
    await check('supa.js: ownerTransfer(orgId, membershipId) → rpc owner_transfer(p_org, p_membership), exported', () =>
      (/function ownerTransfer\(oid, membershipId\) \{ return rpc\('owner_transfer', \{ p_org: oid, p_membership: membershipId \}\); \}/.test(supa) && /ownerTransfer: ownerTransfer/.test(supa)) || 'wrapper');
    const css = rd('assets/css/pages/admin.css');
    const teamCss = css.slice(css.indexOf('«الفريق» (#team)'));
    await check('team CSS uses logical sides only', () => (teamCss.length > 100 && !/(margin|padding)-(left|right)|\b(left|right):/.test(teamCss)) || 'physical sides');
    const teamCssOnly = teamCss.slice(0, (teamCss.indexOf('\n/* ', 10) + 1 || teamCss.length + 1) - 1);
    await check('team CSS: existing tokens only (no --bg-soft, no var() with a hex fallback)', () =>
      (!/--bg-soft/.test(css) && !/var\(--[a-z-]+,\s*#/.test(teamCssOnly)) || 'token');
    await check('no dead tier constants: TEAM_EMPLOYEES and TEAM_MANAGEMENT are used beyond their declaration', () =>
      ((adm.match(/\bTEAM_EMPLOYEES\b/g) || []).length >= 3 && (adm.match(/\bTEAM_MANAGEMENT\b/g) || []).length >= 2) || 'unused');
  }

  console.log('\nteam-ui-tests: ' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);   // jsdom timers (shell badges / clock) would keep node alive
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });

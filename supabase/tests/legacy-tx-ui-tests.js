#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 2 UI tests: assets/js/ops/tx-legacy.js (MarsaOps.legacyTx) and the page wiring
  (admin.html / admin.js / tx-sections.js / portal.js / tracking.js / sw.js / supa.js / i18n).
  Pure Node, no database, no network, no dependencies (vm + window shim, like legacy-norm-tests.js).

  Covers: the classic-script wrapper and ES5 source of the changed files; the 'opslx' dictionary (ar = en keys);
  legacyPatch (Ro-Ro ⇔ chassis, plate only on Ro-Ro, container_count 0, TASTO order only on carrier_order,
  re-export, port / terminal pass-through, a transaction with containers cannot become Ro-Ro); dupMessages
  (block vs warn, hidden / other-branch refs); cancelBlock (roles, senior after customs_declaration, billed,
  closed, cancelled) and cancelErrText (every MRS_BAD_TRANSITION detail of cancel_transaction has a text);
  movementPayload (required driver / phone / truck, Saudi phone, container on container cargo, never on Ro-Ro,
  reschedule needs a reason, delivered needs destination + amounts, money only for finance roles, only the
  keys save_movement accepts); hijriInfo through MarsaNorm; the static wiring (script order, precache,
  VERSION, status label domains, Hijri column, «ملغاة» in portal / tracking, the cancelled filter).

  usage:  node supabase/tests/legacy-tx-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

/* ------------------------------------------------------------ load as a browser would */
const dicts = { ar: {}, en: {} };
let LANG = 'ar';
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts[LANG][key] != null ? dicts[LANG][key] : (dicts.ar[key] != null ? dicts.ar[key] : key);
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  lang() { return LANG; }
};
const win = { MarsaI18n: I18N };
const ctx = { window: win, Intl, Date, Math, String, Object, Array, JSON, Number, parseInt, isFinite, isNaN, Promise, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(rd('assets/js/legacy-norm.js'), ctx, { filename: 'legacy-norm.js' });
vm.runInContext(rd('assets/js/ops/tx-sections.js'), ctx, { filename: 'tx-sections.js' });
vm.runInContext(rd('assets/js/ops/tx-legacy.js'), ctx, { filename: 'tx-legacy.js' });
const LX = win.MarsaOps && win.MarsaOps.legacyTx;
const P = LX && LX.pure;
const MIG = rd('supabase/migrations/20261118000100_legacy_tx.sql');
const CORE = rd('supabase/migrations/20261117000100_legacy_core.sql');

/* ================================================================ wrapper */
section('wrapper / source');
check('classic script sets MarsaOps.legacyTx with the pure helpers', () => !!(LX && LX.VERSION === 'lx-ui-1' && P && typeof P.legacyPatch === 'function') || 'missing');
check('registers the movements section (order 55) next to the G3 sections', () => {
  const s = win.MarsaOps.txSections, m = s.filter(x => x.id === 'movements');
  return (m.length === 1 && m[0].order === 55 && s.some(x => x.id === 'declarations')) || J(s.map(x => x.id));
});
check('loading twice keeps one movements section', () => {
  vm.runInContext(rd('assets/js/ops/tx-legacy.js'), ctx, { filename: 'tx-legacy.js#2' });
  return win.MarsaOps.txSections.filter(x => x.id === 'movements').length === 1 || 'duplicated';
});
const CHANGED_JS = ['assets/js/ops/tx-legacy.js', 'assets/js/ops/tx-sections.js', 'assets/js/admin.js', 'assets/js/portal.js',
  'assets/js/tracking.js', 'assets/js/supa.js', 'assets/js/i18n.js', 'assets/i18n/portal.js', 'sw.js'];
CHANGED_JS.forEach(f => check(f + ': ES5 (no let / const / arrow / template / class)', () => {
  const src = rd(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const bad = [/(^|[^\w.$])(let|const)\s+[A-Za-z_$]/m, /=>/, /`/, /(^|[^\w.$])class\s+[A-Z]/m].filter(r => r.test(src)).map(String);
  return !bad.length || bad.join(' ');
}));
check('tx-legacy.js: server data only through textContent / createElement (no innerHTML)', () => !/innerHTML/.test(rd('assets/js/ops/tx-legacy.js')) || 'innerHTML');

/* ================================================================ dictionary */
section('opslx dictionary');
const keysOf = l => Object.keys(dicts[l]).filter(k => k.startsWith('opslx.')).sort();
check('ar and en have the same opslx keys', () => {
  const a = keysOf('ar'), e = keysOf('en');
  const miss = a.filter(k => !e.includes(k)).concat(e.filter(k => !a.includes(k)));
  return (a.length > 100 && !miss.length) || ('diff ' + J(miss) + ' n=' + a.length);
});
check('opstx: the Hijri + Fasah keys exist in ar and en', () => {
  const want = ['dec_hijri', 'dec_hijri_ok', 'dec_hijri_filled', 'dec_hijri_bad', 'dec_hijri_unsupported', 'dec_greg_hijri', 'dec_hijri_mismatch',
    'lbl_declaration_status_accepted', 'lbl_declaration_status_cco_review_done', 'lbl_declaration_status_awaiting_duty_payment', 'lbl_declaration_status_release_ready'];
  const miss = [];
  want.forEach(k => ['ar', 'en'].forEach(l => { if (dicts[l]['opstx.' + k] == null) miss.push(l + ':' + k); }));
  return !miss.length || J(miss);
});
check('every cancel_transaction MRS_BAD_TRANSITION detail has a cancel_err_ text', () => {
  const at = CORE.indexOf('CREATE OR REPLACE FUNCTION public.cancel_transaction'), body = CORE.slice(at, CORE.indexOf('END $$;', at));
  const det = []; body.replace(/app\.fail\('MRS_BAD_TRANSITION', '([a-z_]+)'\)/g, (m, d) => { if (!det.includes(d)) det.push(d); return m; });
  const miss = det.filter(d => dicts.ar['opslx.cancel_err_' + d] == null || dicts.en['opslx.cancel_err_' + d] == null);
  return (det.length >= 10 && !miss.length) || ('details ' + J(det) + ' missing ' + J(miss));
});
check('movement_status / transaction_state fallbacks = the status_labels rows of the migration', () => {
  const rows = []; MIG.replace(/\('(movement_status|transaction_state)','([a-z_]+)',\d+,'([^']+)','([^']+)'/g, (m, d, c, ar, en) => { rows.push([d, c, ar, en]); return m; });
  const bad = rows.filter(r => dicts.ar['opslx.lbl_' + r[0] + '_' + r[1]] !== r[2] || dicts.en['opslx.lbl_' + r[0] + '_' + r[1]] !== r[3]);
  return (rows.length === 5 && !bad.length) || ('rows ' + rows.length + ' bad ' + J(bad));
});

/* ================================================================ legacyPatch */
section('legacyPatch (transaction columns)');
const LP = (v, tx) => J(P.legacyPatch(v, tx || null));
eq('defaults: normal / container / driver, nothing else', P.legacyPatch({}).patch,
  { transaction_type: 'normal', cargo_unit_type: 'container', chassis_no: null, vehicle_plate_no: null, port_code: null, terminal_party_id: null,
    transport_mode: 'driver', transport_party_id: null, transport_order_no: null, transport_order_date: null, declaration_notes: null });
eq('re-export + port + terminal + notes pass through (trimmed)', (function () {
  const p = P.legacyPatch({ transaction_type: 're_export', port_code: 'SAJED', terminal_party_id: 'T1', declaration_notes: '  note  ' }).patch;
  return [p.transaction_type, p.port_code, p.terminal_party_id, p.declaration_notes];
})(), ['re_export', 'SAJED', 'T1', 'note']);
eq('an unknown type / unit / mode falls back to the defaults', (function () {
  const p = P.legacyPatch({ transaction_type: 'x', cargo_unit_type: 'y', transport_mode: 'z' }).patch;
  return [p.transaction_type, p.cargo_unit_type, p.transport_mode];
})(), ['normal', 'container', 'driver']);
eq('Ro-Ro without chassis → err_chassis_required', P.legacyPatch({ cargo_unit_type: 'roro' }).error, 'err_chassis_required');
eq('Ro-Ro chassis normalised (Arabic digits, dashes, lower case) + container_count 0', (function () {
  const r = P.legacyPatch({ cargo_unit_type: 'roro', chassis_no: ' jt-dbr٣٢e ٦٠٠ ', vehicle_plate_no: 'abc 123' });
  return [r.error, r.patch.chassis_no, r.patch.vehicle_plate_no, r.patch.container_count];
})(), [null, 'JTDBR32E600', 'ABC 123', 0]);
eq('Ro-Ro chassis too short → err_chassis_bad', P.legacyPatch({ cargo_unit_type: 'roro', chassis_no: 'a-1' }).error, 'err_chassis_bad');
eq('Ro-Ro plate of 1 char → err_plate_bad', P.legacyPatch({ cargo_unit_type: 'roro', chassis_no: 'ABCD1234', vehicle_plate_no: 'A' }).error, 'err_plate_bad');
eq('container cargo drops chassis + plate (Ro-Ro ⇔ chassis)', (function () {
  const p = P.legacyPatch({ cargo_unit_type: 'container', chassis_no: 'ABCD1234', vehicle_plate_no: 'AB12' }).patch;
  return [p.chassis_no, p.vehicle_plate_no, 'container_count' in p];
})(), [null, null, false]);
eq('a transaction with containers cannot become Ro-Ro', P.legacyPatch({ cargo_unit_type: 'roro', chassis_no: 'ABCD1234' }, { containers: [{ id: 'c' }] }).error, 'roro_has_containers');
eq('carrier_order: TASTO number normalised, company + date kept', (function () {
  const p = P.legacyPatch({ transport_mode: 'carrier_order', transport_order_no: ' tasto ١٢٣ ', transport_party_id: 'P1', transport_order_date: '2026-11-10' }).patch;
  return [p.transport_order_no, p.transport_party_id, p.transport_order_date];
})(), ['TASTO123', 'P1', '2026-11-10']);
eq('carrier_order: a non-TASTO number → err_order_no', P.legacyPatch({ transport_mode: 'carrier_order', transport_order_no: 'ORD-9' }).error, 'err_order_no');
eq('driver mode clears the order fields (transactions_transport_order_chk)', (function () {
  const p = P.legacyPatch({ transport_mode: 'driver', transport_order_no: 'TASTO1', transport_party_id: 'P', transport_order_date: '2026-01-01' }).patch;
  return [p.transport_order_no, p.transport_party_id, p.transport_order_date];
})(), [null, null, null]);
check('the TASTO rule = the SQL CHECK (^TASTO[0-9]{1,20}$)', () => /transport_order_no ~ '\^TASTO\[0-9\]\{1,20\}\$'/.test(CORE) || 'CHECK changed');
check('the chassis rule = the SQL CHECK (^[A-Z0-9]{4,30}$)', () => /chassis_no ~ '\^\[A-Z0-9\]\{4,30\}\$'/.test(CORE) || 'CHECK changed');
check('legacyPatch keys are only the writable legacy columns (+ container_count)', () => {
  const allowed = ['transaction_type', 'cargo_unit_type', 'chassis_no', 'vehicle_plate_no', 'port_code', 'terminal_party_id', 'transport_mode',
    'transport_party_id', 'transport_order_no', 'transport_order_date', 'declaration_notes', 'container_count'];
  const k = Object.keys(P.legacyPatch({ cargo_unit_type: 'roro', chassis_no: 'ABCD1234', transport_mode: 'carrier_order' }).patch);
  const extra = k.filter(x => !allowed.includes(x));
  return !extra.length && !k.includes('cancelled_at') || J(extra);
});
void LP;

/* ================================================================ duplicates */
section('dupMessages (check_tx_duplicates result)');
check('a duplicate container blocks and names the ref (+ other branch)', () => {
  const m = P.dupMessages({ duplicates: [{ kind: 'container', unit: 'MSCU1234567', transaction_id: 't', ref: 'TX-2026-000001', other_branch: true }], container_elsewhere: [] });
  return (m.block.length === 1 && m.warn.length === 0 && m.block[0].includes('MSCU1234567') && m.block[0].includes('TX-2026-000001') && m.block[0].includes('فرع آخر')) || J(m);
});
check('a hidden duplicate (no ref) still blocks', () => {
  const m = P.dupMessages({ duplicates: [{ kind: 'chassis', unit: 'JTD123', transaction_id: null, ref: null }] });
  return (m.block.length === 1 && m.block[0].includes('JTD123') && m.block[0].includes('الشاسيه')) || J(m);
});
check('the same container under another B/L only warns; the edited transaction itself is ignored', () => {
  const m = P.dupMessages({ duplicates: [], container_elsewhere: [{ container_no: 'A', transaction_id: 'x', ref: 'R1' }, { container_no: 'B', transaction_id: 'me', ref: 'R2' }] }, { id: 'me' });
  return (m.block.length === 0 && m.warn.length === 1 && m.warn[0].includes('R1')) || J(m);
});
check('English texts', () => {
  LANG = 'en';
  const m = P.dupMessages({ duplicates: [{ kind: 'container', unit: 'U', ref: 'R' }] });
  LANG = 'ar';
  return /^Cannot save: container U/.test(m.block[0]) || m.block[0];
});

/* ================================================================ cancel */
section('cancelBlock / cancelErrText');
const roles = set => list => list.some(r => set.includes(r));
const clerk = roles(['clearance_staff']), opsMgr = roles(['operations_manager']), transport = roles(['transport_staff']);
eq('clearance staff at new → allowed', P.cancelBlock({ operational_status: 'new', financial_status: 'none' }, clerk), null);
eq('clearance staff at customs_declaration → allowed', P.cancelBlock({ operational_status: 'customs_declaration' }, clerk), null);
eq('clearance staff after customs_declaration → senior', P.cancelBlock({ operational_status: 'appointment' }, clerk), 'senior');
eq('operations manager at transport → allowed', P.cancelBlock({ operational_status: 'transport' }, opsMgr), null);
eq('transport staff (not an ops writer) → hidden', P.cancelBlock({ operational_status: 'new' }, transport), 'hidden');
eq('already cancelled → hidden', P.cancelBlock({ operational_status: 'closed', cancelled_at: '2026-11-10T10:00:00Z' }, opsMgr), 'hidden');
eq('under_billing → billed', P.cancelBlock({ operational_status: 'under_billing' }, opsMgr), 'billed');
eq('invoiced financial status → billed', P.cancelBlock({ operational_status: 'operationally_complete', financial_status: 'invoiced' }, opsMgr), 'billed');
eq('closed → closed', P.cancelBlock({ operational_status: 'closed' }, opsMgr), 'closed');
check('the senior rule = app.senior_ops_roles() and the stage = customs_declaration in cancel_transaction', () =>
  (/code_sort\('operational_status', v_tx\.operational_status\) > app\.code_sort\('operational_status', 'customs_declaration'\)/.test(CORE)
    && /app\.senior_ops_roles\(\)/.test(CORE)) || 'SQL changed');
eq('cancelErrText: open_appointments', P.cancelErrText({ code: 'MRS_BAD_TRANSITION', field: 'open_appointments' }), dicts.ar['opslx.cancel_err_open_appointments']);
eq('cancelErrText: raw.details form', P.cancelErrText({ code: 'MRS_BAD_TRANSITION', raw: { details: 'open_returns' } }), dicts.ar['opslx.cancel_err_open_returns']);
eq('cancelErrText: forbidden', P.cancelErrText({ code: 'MRS_FORBIDDEN', field: 'role' }), dicts.ar['opslx.cancel_err_role']);
eq('cancelErrText: other codes → null (generic message)', P.cancelErrText({ code: 'MRS_NOT_FOUND', field: 'transaction' }), null);

/* ================================================================ movements */
section('movementPayload (save_movement)');
const TX = { id: 'tx1', cargo_unit_type: 'container' }, RORO = { id: 'tx2', cargo_unit_type: 'roro' };
const base = { container_id: 'c1', driver_name: 'سالم', driver_phone: '٠٥٥١٢٣٤٥٦٧', truck_plate: 'abc 123', appointment_no: 'TAS 12345678' };
const AT = '2026-11-12T08:00:00.000Z';
check('a new container movement: keys, normalised phone / plate, registered', () => {
  const r = P.movementPayload(Object.assign({}, base, { destination: 'جدة' }), { tx: TX, canFin: false, isoAt: AT });
  const p = r.payload;
  return (p && p.transaction_id === 'tx1' && p.container_id === 'c1' && p.appointment_at === AT && p.driver_phone === '0551234567'
    && p.truck_plate === 'ABC 123' && p.movement_status === 'registered' && p.appointment_status === undefined && !('cost_amount' in p)) || J(r);
});
eq('container cargo without container → required', P.movementPayload(Object.assign({}, base, { container_id: '' }), { tx: TX, isoAt: AT }).error, 'required');
eq('new container movement without time → required', P.movementPayload(base, { tx: TX, isoAt: null }).error, 'required');
check('Ro-Ro: no container key, no return plan, time optional', () => {
  const r = P.movementPayload(Object.assign({}, base, { return_deadline: '2026-12-01', return_location: 'x' }), { tx: RORO, isoAt: null });
  return (r.payload && !('container_id' in r.payload) && !('appointment_at' in r.payload) && !('return_deadline' in r.payload)) || J(r);
});
['driver_name', 'driver_phone', 'truck_plate'].forEach(k => eq('missing ' + k + ' → required', P.movementPayload(Object.assign({}, base, { [k]: ' ' }), { tx: TX, isoAt: AT }).error, 'required'));
eq('a landline / foreign phone → mv_bad_phone', P.movementPayload(Object.assign({}, base, { driver_phone: '0112345678' }), { tx: TX, isoAt: AT }).error, 'mv_bad_phone');
eq('+966 form accepted', P.movementPayload(Object.assign({}, base, { driver_phone: '+966 55 123 4567' }), { tx: TX, isoAt: AT }).payload.driver_phone, '0551234567');
check('money only for finance roles; negative → mv_bad_amount', () => {
  const a = P.movementPayload(Object.assign({}, base, { cost_amount: '150', sell_amount: '200' }), { tx: TX, canFin: false, isoAt: AT }).payload;
  const b = P.movementPayload(Object.assign({}, base, { cost_amount: '150', sell_amount: '٢٠٠' }), { tx: TX, canFin: true, isoAt: AT }).payload;
  const c = P.movementPayload(Object.assign({}, base, { cost_amount: '-1' }), { tx: TX, canFin: true, isoAt: AT }).error;
  return (!('cost_amount' in a) && b.cost_amount === 150 && b.sell_amount === 200 && c === 'mv_bad_amount') || J([a, b, c]);
});
eq('delivered without destination → mv_deliver_need', P.movementPayload(Object.assign({}, base, { movement_status: 'delivered' }), { tx: TX, canFin: true, isoAt: AT }).error, 'mv_deliver_need');
eq('delivered (finance) without amounts → mv_deliver_need', P.movementPayload(Object.assign({}, base, { movement_status: 'delivered', destination: 'X' }), { tx: TX, canFin: true, isoAt: AT }).error, 'mv_deliver_need');
check('delivered with destination + amounts + time', () => {
  const r = P.movementPayload(Object.assign({}, base, { movement_status: 'delivered', destination: 'X', cost_amount: '1', sell_amount: '2' }),
    { tx: TX, canFin: true, isoAt: AT, isoDelivered: '2026-11-12T10:00:00.000Z' });
  return (r.payload && r.payload.movement_status === 'delivered' && r.payload.delivered_at === '2026-11-12T10:00:00.000Z') || J(r);
});
const M0 = { appointment_id: 'a1', trip_id: 'r1', container_id: 'c1', appointment_at: AT, appointment_status: 'confirmed', destination: 'D', cost_amount: 5, sell_amount: 6 };
check('edit: appointment_id, unchanged time and status are not sent', () => {
  const r = P.movementPayload(Object.assign({}, base, { appointment_status: 'confirmed' }), { tx: TX, movement: M0, isoAt: AT });
  return (r.payload && r.payload.appointment_id === 'a1' && !('trip_id' in r.payload) && !('appointment_at' in r.payload) && !('appointment_status' in r.payload)) || J(r);
});
eq('edit: a new time without reason → mv_need_reason', P.movementPayload(base, { tx: TX, movement: M0, isoAt: '2026-11-13T08:00:00.000Z' }).error, 'mv_need_reason');
check('edit: a new time with reason = reschedule', () => {
  const r = P.movementPayload(Object.assign({}, base, { reason: 'تأخر السفينة' }), { tx: TX, movement: M0, isoAt: '2026-11-13T08:00:00.000Z' });
  return (r.payload && r.payload.appointment_at === '2026-11-13T08:00:00.000Z' && r.payload.reason === 'تأخر السفينة') || J(r);
});
check('edit: delivered with the destination / amounts already on the trip', () => {
  const r = P.movementPayload(Object.assign({}, base, { movement_status: 'delivered' }), { tx: TX, movement: M0, canFin: true, isoAt: AT });
  return (r.payload && r.payload.movement_status === 'delivered') || J(r);
});
check('a trip-only movement is edited by trip_id', () => {
  const r = P.movementPayload(base, { tx: RORO, movement: { trip_id: 'r9' }, isoAt: null });
  return (r.payload && r.payload.trip_id === 'r9' && !('appointment_id' in r.payload)) || J(r);
});
check('payload keys ⊆ the save_movement only_keys list', () => {
  const body = MIG.slice(MIG.indexOf('FUNCTION public.save_movement'));
  const m = /app\.only_keys\(v_p, ARRAY\[([\s\S]*?)\]\)/.exec(body);
  const allowed = m ? m[1].replace(/\s+/g, '').split(',').map(s => s.replace(/'/g, '')) : [];
  const p = P.movementPayload(Object.assign({}, base, { terminal_party_id: 't', carrier_id: 'c', origin: 'o', destination: 'd', notes: 'n', window_minutes: '60',
    appointment_status: 'confirmed', cost_amount: '1', sell_amount: '2', movement_status: 'delivered', return_deadline: '2026-12-01', return_location: 'l',
    return_yard_party_id: 'y', reason: 'r' }), { tx: TX, canFin: true, isoAt: AT, isoDelivered: AT }).payload;
  const extra = Object.keys(p).filter(k => !allowed.includes(k));
  return (allowed.length > 20 && !extra.length) || ('extra ' + J(extra) + ' allowed ' + allowed.length);
});

/* ================================================================ Hijri */
section('hijriInfo (MarsaNorm, Umm al-Qura)');
const hasUQ = win.MarsaNorm.hijriSupported();
eq('empty', P.hijriInfo('  ').state, 'empty');
eq('out of range → bad', P.hijriInfo('1447/13/01').state, 'bad');
check('Arabic digits + d/m/yyyy → normalised + Gregorian', () => {
  const r = P.hijriInfo('١/٩/١٤٤٧');
  if (!hasUQ) return r.state === 'unsupported' || J(r);
  return (r.state === 'ok' && r.hijri === '1447/09/01' && /^2026-02-1[78]$/.test(r.iso)) || J(r);
});
check('round trip through gregorianToHijri', () => {
  if (!hasUQ) return true;
  const r = P.hijriInfo('1447/06/15');
  return LX.gregorianToHijri(r.iso) === '1447/06/15' || J(r);
});

/* ================================================================ wiring */
section('page wiring (static)');
const ADMIN_HTML = rd('admin.html'), ADMIN = rd('assets/js/admin.js'), SECT = rd('assets/js/ops/tx-sections.js'), SW = rd('sw.js');
check('admin.html: legacy-norm.js → tx-sections.js → tx-legacy.js → admin.js', () => {
  const pos = f => ADMIN_HTML.indexOf('src="' + f + '"');
  const a = pos('assets/js/legacy-norm.js'), b = pos('assets/js/ops/tx-sections.js'), c = pos('assets/js/ops/tx-legacy.js'), d = pos('assets/js/admin.js');
  return (a > 0 && a < b && b < c && c < d) || J([a, b, c, d]);
});
check('sw.js precaches tx-legacy.js and legacy-norm.js; VERSION ≥ 2026-11-18.1', () => {
  const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';/m.exec(SW) || [])[1] || '';
  return (SW.includes("'assets/js/ops/tx-legacy.js'") && SW.includes("'assets/js/legacy-norm.js'") && v.localeCompare('2026-11-18.1', 'en', { numeric: true }) >= 0) || v;
});
check('admin.js loads the new status label domains', () => ['transaction_type', 'cargo_unit_type', 'transport_mode', 'transaction_state', 'movement_status']
  .every(d => new RegExp("'" + d + "'").test(ADMIN.slice(ADMIN.indexOf('function loadLabels'), ADMIN.indexOf('function loadLabels') + 900))) || 'missing');
check('admin.js: cancelled filter → listTransactions({cancelled}); «ملغاة» via transaction_state', () =>
  (/cancelled: f\.cancelled \|\| null/.test(ADMIN) && /\['exclude', LX\.t\('f_cancelled_exclude'\)\], \['only', LX\.t\('f_cancelled_only'\)\]/.test(ADMIN)
    && /opsLabel\('transaction_state', 'cancelled'\)/.test(ADMIN)) || 'missing');
check('admin.js: new transaction runs the duplicate guard before createTransaction and blocks on duplicates', () => {
  const s = ADMIN.slice(ADMIN.indexOf('function txNew'), ADMIN.indexOf('function branchOpts'));
  return (s.indexOf('LX.dupCheck(') !== -1 && s.indexOf('LX.dupCheck(') < s.indexOf('api.createTransaction(') && /if \(g\.block && g\.block\.length\) return g\.block\.join/.test(s)) || 'order';
});
check('admin.js: the edit dialog refuses a cancelled transaction; write sets are off for cancelled sections', () =>
  (/if \(t\.cancelled_at\) return toast\(/.test(ADMIN) && /function txOpsApi\(tx\)/.test(ADMIN) && /s\.render\(box, tx, txOpsApi\(tx\)\)/.test(ADMIN)) || 'missing');
check('tx-sections.js: Hijri field + DEC_SETTABLE = the set_declaration_status order of 20261117000100', () => {
  const m = /v_order text\[\] := ARRAY\[([^\]]+)\]/.exec(CORE);
  const sqlOrder = m ? m[1].replace(/\s+/g, '').split(',').map(s => s.replace(/'/g, '')) : [];
  const js = /var DEC_SETTABLE = \[([^\]]+)\]/.exec(SECT)[1].replace(/\s+/g, '').split(',').map(s => s.replace(/'/g, ''));
  return (/name: 'declaration_date_hijri'/.test(SECT) && J(js) === J(sqlOrder.filter(c => js.includes(c))) && js.length === 8) || J([js, sqlOrder]);
});
check('tx-sections.js: Ro-Ro has no containers / empty-return section', () => /if \(tx && tx\.cargo_unit_type === 'roro'\) return null;/.test(SECT) || 'missing');
check('supa.js: declarations select declaration_date_hijri; same_status message', () => {
  const s = rd('assets/js/supa.js');
  return (/var DECL_COLS = '[^']*declaration_date_hijri/.test(s) && /'MRS_BAD_TRANSITION:same_status'/.test(s)) || 'missing';
});
check('i18n.js: same_status detail in ar and en', () => (rd('assets/js/i18n.js').match(/cdetail_MRS_BAD_TRANSITION_same_status/g) || []).length === 2 || 'count');
check('portal.js: «ملغاة» badge in list + detail, transaction_state label domain', () => {
  const s = rd('assets/js/portal.js');
  return (/transaction_state: \['cancelled'\]/.test(s) && (s.match(/txBadge\(tx\)/g) || []).length >= 2 && /tx\.cancelled_at/.test(s)) || 'missing';
});
check('i18n/portal.js: cancelledNote + lbl.transaction_state.cancelled in ar and en', () => {
  const s = rd('assets/i18n/portal.js');
  return ((s.match(/cancelledNote:/g) || []).length === 2 && (s.match(/'lbl\.transaction_state\.cancelled'/g) || []).length === 2) || 'missing';
});
check('tracking.js: cancelled → red badge, no progress bar', () => {
  const s = rd('assets/js/tracking.js');
  return (/var cancelled = !!\(tx && tx\.cancelled\);/.test(s) && /tx && !cancelled && tx\.stage_index != null/.test(s) && /cancelled \? 'badge-danger' : 'badge-teal'/.test(s)) || 'missing';
});
check('public_track returns cancelled + cancelled_at (the tracking page reads them)', () => /'cancelled', /.test(MIG) && /'cancelled_at'/.test(MIG) || 'missing');

/* ----------------------------------------------------------------- review regressions */
section('review regressions');
{
  const P = LX.pure;
  check('stepper: next in_progress and container operationally_complete are manual; Ro-Ro operationally_complete and transport stay automatic', () =>
    (P.nextManual({ next: { code: 'in_progress', manual: false }, cargo_unit_type: 'container' }) === true
      && P.nextManual({ next: { code: 'operationally_complete', manual: false }, cargo_unit_type: 'container' }) === true
      && P.nextManual({ next: { code: 'operationally_complete', manual: false }, cargo_unit_type: 'roro' }) === false
      && P.nextManual({ next: { code: 'transport', manual: false }, cargo_unit_type: 'container' }) === false
      && P.nextManual({ next: { code: 'under_billing', manual: true } }) === true && P.nextManual({ next: null }) === false) || 'manual');
  check('SQL tx_lifecycle: manual covers in_progress and container operationally_complete', () =>
    (/'manual', v_next IN \('in_progress','under_billing','closed'\)/.test(MIG) && /v_next = 'operationally_complete' AND coalesce\(v_tx\.cargo_unit_type, 'container'\) <> 'roro'/.test(MIG)) || 'missing');

  check('stepper: Ro-Ro skipped stages render is-skipped + «لا تنطبق» (SQL state skipped)', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'assets/js/ops/tx-legacy.js'), 'utf8');
    return (/s\.state === 'skipped' \? 'is-skipped'/.test(SRC) && /class: 'lx-na', text: T\('lc_na'\)/.test(SRC)
      && dicts.ar['opslx.lc_na'] === 'لا تنطبق' && dicts.en['opslx.lc_na'] === 'N/A'
      && /THEN 'skipped'/.test(MIG) && /NOT \(v_tx\.cargo_unit_type = 'roro' AND l\.code IN \('appointment','empty_return'\)\)/.test(MIG)) || 'missing';
  });
  check('admin.css: dialog + settings-form errors become visible (.form-error is display:none by default)', () => {
    const CSS = fs.readFileSync(path.join(ROOT, 'assets/css/pages/admin.css'), 'utf8');
    return (/\.adm-dialog-error:not\(\[hidden\]\) \{ display: block; \}/.test(CSS) && /\.adm-org-form > \.form-error:not\(\[hidden\]\) \{ display: block; \}/.test(CSS)) || 'missing';
  });

  // a tiny DOM: enough for txFields (selects, options, groups) — the edit dialog must never clear a stored value
  class N {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.hidden = false; this._v = undefined; this.type = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(c) { if (c != null) this.children.push(c); return c; }
    addEventListener() {}
    set textContent(t) { this.children = []; this._text = t; }
    get textContent() { return this._text || ''; }
    all() { const out = []; const walk = n => n.children.forEach(c => { if (c instanceof N) { out.push(c); walk(c); } }); walk(this); return out; }
    opts() { return this.all().filter(x => x.tagName === 'OPTION'); }
    get value() {
      if (this.tagName !== 'SELECT') return this._v == null ? '' : this._v;
      const o = this.opts();
      if (this._v !== undefined) { const m = o.filter(x => x.attrs.value === this._v)[0]; return m ? this._v : ''; }
      return o.length ? o[0].attrs.value : '';
    }
    set value(v) { this._v = v == null ? '' : String(v); }
    match(sel) {
      let m = /^\[([a-z_-]+)(?:=([^\]]+))?\]$/.exec(sel);
      if (m) return m[2] === undefined ? this.getAttribute(m[1]) !== null : this.getAttribute(m[1]) === m[2];
      m = /^([a-z]+)\[([a-z_-]+)=([^\]]+)\]$/.exec(sel);
      if (m) return this.tagName === m[1].toUpperCase() && this.getAttribute(m[2]) === m[3];
      return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) { return this.all().filter(x => x.match(sel))[0] || null; }
    querySelectorAll(sel) { return this.all().filter(x => x.match(sel)); }
  }
  const el = (tag, at, kids) => {
    const n = new N(tag);
    Object.keys(at || {}).forEach(k => {
      const v = at[k]; if (v == null || v === false) return;
      if (k === 'text') n.textContent = v; else if (k === 'value') { n.attrs.value = String(v); n._v = String(v); }
      else if (k === 'type') { n.type = v; n.attrs.type = v; } else n.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(kids) ? kids : (kids == null ? [] : [kids])).forEach(c => { if (c instanceof N) n.appendChild(c); });
    if (n.tagName === 'SELECT') n._v = undefined;
    return n;
  };
  const never = () => new Promise(() => {});
  let partiesCalls = 0;
  const api = { el, orgId: 'org-review', labels: {},
    MarsaApi: { listCustomsPorts: never, portOperators: never, listParties: () => { partiesCalls++; return Promise.resolve({ data: null, error: { message: 'down' } }); } } };
  const tx = { id: 'tx1', containers: [{ id: 'c1' }], cargo_unit_type: 'container', transaction_type: 'normal', port_code: 'SAJED',
    terminal_party_id: '11111111-1111-4111-8111-111111111111', transport_mode: 'carrier_order', transport_party_id: '22222222-2222-4222-8222-222222222222' };
  const f = LX.txFields(api, tx);
  const body = el('form', null, f.nodes);
  body.elements = new Proxy({}, { get: (_, k) => body.querySelector('[name=' + String(k) + ']') });
  f.bind(body);
  const before = f.collect(body).patch;
  check('edit dialog: saving before the port / terminal / carrier lookups answer keeps the stored values (no silent clear)', () =>
    (before.port_code === 'SAJED' && before.terminal_party_id === tx.terminal_party_id && before.transport_party_id === tx.transport_party_id) || J(before));
  // let the failed listParties settle
  Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
    const after = f.collect(body).patch;
    check('edit dialog: a failed listParties keeps the stored carrier selected', () =>
      (partiesCalls === 1 && after.transport_party_id === tx.transport_party_id) || J({ partiesCalls, after }));
    finish();
  });
}
check('admin.js txNew: a failed duplicate pre-check blocks the save; legacy required fields (B/L, port, ≥1 container on sea)', () => {
  const s = ADMIN.slice(ADMIN.indexOf('function txNew'), ADMIN.indexOf('function branchOpts'));
  return (/if \(g\.error\) return LX\.t\('dup_failed_block'/.test(s) && /LX\.t\('req_bl'\)/.test(s) && /LX\.t\('req_port'\)/.test(s)
    && /LX\.t\('req_containers'\)/.test(s) && s.indexOf("LX.t('req_bl')") < s.indexOf('api.createTransaction(')) || 'missing';
});
check('admin.js txNew: a server MRS_DUPLICATE_TX after the row exists voids it through cancelTransaction (no plain-number fallback)', () => {
  const s = ADMIN.slice(ADMIN.indexOf('function txNew'), ADMIN.indexOf('function branchOpts'));
  return (/if \(isDup\(br\.error\)\) \{ dupHit = br\.error; return null; \}/.test(s) && /call\('cancelTransaction', tx\.id, /.test(s)
    && /if \(isDup\(r\.error\)\) dupHit = r\.error/.test(s)) || 'missing';
});
check('supa.js / i18n.js: no generic MRS_NOTE_REQUIRED:reason override; MRS_FORBIDDEN:cost has ar + en; cancelled detail is neutral', () => {
  const sp = rd('assets/js/supa.js'), i = rd('assets/js/i18n.js');
  return (!/'MRS_NOTE_REQUIRED:reason'/.test(sp) && /'MRS_FORBIDDEN:cost'/.test(sp) && (i.match(/cdetail_MRS_FORBIDDEN_cost:/g) || []).length === 2
    && !/The transaction or movement is cancelled/.test(i) && /This record is cancelled/.test(i)) || 'missing';
});

/* ----------------------------------------------------------------- summary */
function finish() {
  console.log('\nMarsa — legacy-tx UI tests: ' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' checks)');
  if (fail) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
}

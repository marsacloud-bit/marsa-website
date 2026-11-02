#!/usr/bin/env node
/*
  Marsa (مرسى) — G3.17 end-to-end clearance + transport cycle (docs/online/G3_SPEC.md). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea". seed.sql runs AFTER the migrations, so the org gets its default document
  requirements here through app.seed_document_requirements (on staging the migration seeds it).
  Users: clrJ clearance_staff JED · trJ transport_staff JED · opsJ operations_manager JED ·
         accA accountant (org-wide) · clientC portal user of the client created by the conversion.

  Scenario (one transaction, every step through the RPCs / RLS the UI uses):
    1. service request (B/L + 3 containers) → match_client (never links) → convert (idempotent)
    2. B/L enriched (save_bl), containers tied to it
    3. documents uploaded (unreviewed) — the gate refuses customs_declaration — then classified
    4. declaration added, cancelled and replaced (auto exception)
    5. appointments incl. a reschedule (old row kept), confirmations visible to the client (time only)
    6. two transport legs (cost visible to ops / finance only)
    7. empty return: container 1 valid receipt, container 2 only a Return Note (refused, later a receipt),
       container 3 waived; exceptions (demurrage) raised and resolved
    8. alerts appear and auto-resolve; the transaction reaches operationally_complete
    9. every record compared: nothing lost, no duplicates

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g3-cycle-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const REQ = 'c7c10000-0000-4000-8000-000000000401';
const U = {
  clrJ: 'c7c10000-0000-4000-8000-000000000001',
  trJ: 'c7c10000-0000-4000-8000-000000000002',
  opsJ: 'c7c10000-0000-4000-8000-000000000003',
  accA: 'c7c10000-0000-4000-8000-000000000004',
  clientC: 'c7c10000-0000-4000-8000-000000000005'
};
const BL = 'MEDU1234567';
const CTRS = ['MSCU1000001', 'MSCU1000002', 'MSCU1000003'];
let keySeq = 0;
const newKey = () => `0e3c0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
let docSeq = 0;
const hrs = h => new Date(Date.now() + h * 3600e3).toISOString();
const day = d => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ helpers (same style as rls-tests.js) */
let db;
async function asRole(who, fn) {
  if (!U[who]) throw new Error('unknown user ' + who);
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || ''))) || String(e);
const count = async (sql, params) => (await q(sql, params))[0].n;
const one = async (sql, params) => (await q(sql, params))[0];

async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
// a step that must succeed; its value is kept for the next steps (an exception aborts the cycle)
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
// upload as a staff member (unreviewed, the uploader's declared kind = a claim)
async function upload(who, tx, kind) {
  const id = `d0c70000-0000-4000-8000-${(++docSeq).toString(16).padStart(12, '0')}`;
  await as(who, `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, $8)`,
    [id, A, tx, kind, `${A}/${tx}/${id}/${kind}.pdf`, docSeq.toString(16).padStart(64, 'a'), kind + '.pdf', U[who]]);
  return id;
}
const classify = (who, id, kind) => as(who, `UPDATE public.documents SET classification = $2, classification_status = 'confirmed' WHERE id = $1`, [id, kind]);
const status = (who, tx, st, note, key) => rpc(who, `SELECT public.set_transaction_status($1, $2, $3, $4) r`, [tx, st, note || null, key || null]);
const refresh = () => one(`SELECT app.refresh_alerts_core($1) r`, [A]).then(x => x.r);
const openAlerts = tx => q(`SELECT kind, dedupe_key, status FROM public.operational_alerts WHERE transaction_id = $1 AND status <> 'resolved' ORDER BY kind`, [tx]);

/* ------------------------------------------------------------------ fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@cycle.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.clrJ}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.trJ}',  '${A}', '${JED}', 'transport_staff'),
      ('${U.opsJ}', '${A}', '${JED}', 'operations_manager'),
      ('${U.accA}', '${A}', NULL, 'accountant');
    INSERT INTO public.service_requests (id, org_id, ref, status, source, tracking_token_hash, client_type, full_name, company, phone, email,
                                         cr_number, vat_number, direction, service, mode, country, port, goods, container_type,
                                         container_numbers, declared_count, count_kind, bl_number, shipping_line, terms_accepted_at)
    VALUES ('${REQ}', '${A}', app.next_ref('${A}', 'request'), 'new', 'web', app.hash_token('cycle-test-token'), 'business', 'سالم المستورد', 'شركة دورة الاختبار للتجارة',
            '0501112222', 'cycle@example.com', '7000000077', '300000000000777', 'import', 'clearance', 'sea', 'الصين',
            'ميناء جدة الإسلامي', 'أجهزة منزلية', '40ft', ARRAY['${CTRS.join("','")}'], 3, 'containers', '${BL}', 'MSC', now());
  `);
  return one(`SELECT app.seed_document_requirements($1) n`, [A]);
}

/* ------------------------------------------------------------------ the cycle */
const C = {};   // ids collected along the way (compared at the end)

async function cycle() {
  section('1. request → transaction from a B/L with 3 containers');
  await check('match_client before conversion: at most weak look-alikes (VAT differs), nothing linked', async () => {
    const r = await rpc('clrJ', `SELECT public.match_client($1, $2) r`, [A, { name: 'شركة دورة الاختبار للتجارة', vat_number: '300000000000777' }]);
    return (r.linked === false && r.candidates.every(c => c.match === 'weak' && c.reasons.includes('vat_differs'))) || JSON.stringify(r);
  });
  const KC = newKey();
  const conv = await step('convert_request_to_transaction (JED, idempotency key)', () =>
    rpc('clrJ', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [REQ, JED, KC]));
  C.tx = conv.transaction_id;
  C.client = conv.client_id;
  await check('replaying the conversion returns the same transaction (no second one)', async () => {
    const r = await rpc('clrJ', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [REQ, JED, KC]);
    return (r.transaction_id === C.tx && r.replayed === true
      && (await count(`SELECT count(*)::int n FROM public.transactions WHERE request_id = $1`, [REQ])) === 1) || JSON.stringify(r);
  });
  await check('3 containers, a new client, the B/L adopted as the primary link', async () => {
    const ct = await q(`SELECT id, container_no, visit_ref FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [C.tx]);
    C.ct = ct.map(x => x.id);
    const l = await q(`SELECT b.id, b.bl_number, tb.is_primary FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                        WHERE tb.transaction_id = $1`, [C.tx]);
    C.bl = l[0] && l[0].id;
    return (ct.length === 3 && conv.client_created === true && l.length === 1 && l[0].bl_number === BL && l[0].is_primary) || JSON.stringify({ ct, l, conv });
  });
  await check('match_client after conversion: the new client is a strong candidate, still nothing linked', async () => {
    const r = await rpc('clrJ', `SELECT public.match_client($1, $2) r`, [A, { name: 'دورة الاختبار', vat_number: '300000000000777' }]);
    return (r.linked === false && r.candidates[0].client_id === C.client && r.candidates[0].match === 'strong') || JSON.stringify(r);
  });
  await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, C.client, U.clientC]);
  await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.clientC, A]);

  section('2. B/L details + containers tied to it');
  await step('save_bl: type master, vessel, voyage (same record, no duplicate)', async () => {
    const r = await rpc('clrJ', `SELECT public.save_bl($1) r`, [{ id: C.bl, bl_type: 'master', vessel: 'MSC AURORA', voyage: '045E',
      port_of_loading: 'Shanghai', packages: 120, gross_weight_kg: 54000 }]);
    if (r.id !== C.bl || r.bl_type !== 'master') throw new Error(JSON.stringify(r));
  });
  await step('containers: B/L, seal, size type, at_port (transport staff)', async () => {
    for (let i = 0; i < 3; i++) {
      await as('trJ', `UPDATE public.containers SET bl_id = $2, seal_no = $3, size_type = '45G1', operational_state = 'at_port' WHERE id = $1`,
        [C.ct[i], C.bl, 'SEAL' + (i + 1)]);
    }
  });
  await step('hs code completed on the transaction (ops writer)', () => as('clrJ', `UPDATE public.transactions SET hs_code = '841810' WHERE id = $1`, [C.tx]));

  section('3. documents uploaded, gate, classification');
  await step('in_progress', () => status('clrJ', C.tx, 'in_progress'));
  C.docs = {};
  for (const k of ['bill_of_lading', 'commercial_invoice', 'packing_list']) C.docs[k] = await upload('clrJ', C.tx, k);
  await check('alerts: docs_missing for customs_declaration appears', async () => {
    await refresh();
    return (await openAlerts(C.tx)).some(a => a.dedupe_key === `docs_missing:${C.tx}:customs_declaration`) || JSON.stringify(await openAlerts(C.tx));
  });
  await expectErr('uploaded but unreviewed documents do not pass the gate', () => status('clrJ', C.tx, 'customs_declaration'),
    /MRS_DOCS_MISSING[\s\S]*bill_of_lading,commercial_invoice,packing_list/);
  await step('staff confirm the classification of the 3 documents', async () => {
    for (const k of Object.keys(C.docs)) await classify('clrJ', C.docs[k], k);
  });
  await check('checklist: customs_declaration items satisfied, certificate of origin optional, delivery order still missing', async () => {
    const r = await rpc('clrJ', `SELECT public.tx_checklist($1) r`, [C.tx]);
    const m = Object.fromEntries(r.items.map(i => [i.document_kind, i]));
    return (m.bill_of_lading.status === 'satisfied' && m.packing_list.status === 'satisfied' && m.certificate_of_origin.optional
      && m.delivery_order.status === 'missing' && JSON.stringify(r.blocking_next) === '[]') || JSON.stringify(r);
  });
  await step('customs_declaration (no override needed)', async () => {
    const r = await status('clrJ', C.tx, 'customs_declaration');
    if (r.docs_override !== null) throw new Error(JSON.stringify(r));
  });
  await check('the docs_missing alert auto-resolves', async () => {
    await refresh();
    const a = await one(`SELECT status, resolution FROM public.operational_alerts WHERE dedupe_key = $1`, [`docs_missing:${C.tx}:customs_declaration`]);
    return (a.status === 'resolved' && a.resolution === 'auto') || JSON.stringify(a);
  });

  section('4. declaration added, cancelled and replaced');
  const KD = newKey();
  const d1 = await step('add_declaration (idempotent)', () => rpc('clrJ', `SELECT public.add_declaration($1, $2, $3) r`,
    [C.tx, { declaration_no: 'CYC-0001', declaration_type: 'import', declaration_date: day(0) }, KD]));
  C.d1 = d1.id;
  await check('add_declaration replay → same declaration', async () => {
    const r = await rpc('clrJ', `SELECT public.add_declaration($1, $2, $3) r`, [C.tx, { declaration_no: 'CYC-0001', declaration_type: 'import', declaration_date: day(0) }, KD]);
    return (r.id === C.d1 && r.replayed === true) || JSON.stringify(r);
  });
  const canc = await step('cancel_declaration + replacement CYC-0002 in one call', () =>
    rpc('clrJ', `SELECT public.cancel_declaration($1, 'خطأ في البند الجمركي', $2) r`, [C.d1, { declaration_no: 'CYC-0002', declaration_type: 'import' }]));
  C.d2 = canc.replacement.id;
  C.excDecl = canc.exception_id;
  await check('old declaration replaced → new one active, mirrored on the transaction, exception opened', async () => {
    const t = await one(`SELECT declaration_no FROM public.transactions WHERE id = $1`, [C.tx]);
    const x = await one(`SELECT kind, source, status FROM public.operational_exceptions WHERE id = $1`, [C.excDecl]);
    return (canc.cancelled.status === 'replaced' && canc.cancelled.replaced_by_id === C.d2 && t.declaration_no === 'CYC-0002'
      && x.kind === 'declaration_cancelled' && x.source === 'system' && x.status === 'open') || JSON.stringify({ canc, t, x });
  });
  await step('replacement moves to released', async () => {
    await rpc('clrJ', `SELECT public.set_declaration_status($1, 'under_inspection') r`, [C.d2]);
    await rpc('clrJ', `SELECT public.set_declaration_status($1, 'released') r`, [C.d2]);
  });

  section('5. appointments incl. a reschedule');
  await step('terminal + yard parties (directory)', async () => {
    C.terminal = (await as('trJ', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['terminal_operator'], 'محطة دورة الاختبار') RETURNING id`, [A]))[0].id;
    C.yard = (await as('trJ', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['yard'], 'ساحة دورة الاختبار') RETURNING id`, [A]))[0].id;
    C.carrier = (await as('trJ', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'ناقل دورة الاختبار') RETURNING id`, [A]))[0].id;
    C.driver = (await as('trJ', `INSERT INTO public.drivers (org_id, carrier_id, full_name, national_id_last4) VALUES ($1, $2, 'سائق الدورة', '1234') RETURNING id`, [A, C.carrier]))[0].id;
    C.truck = (await as('trJ', `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, 'CYC 1001') RETURNING id`, [A, C.carrier]))[0].id;
  });
  await expectErr('appointment stage needs the delivery order', () => status('trJ', C.tx, 'appointment'), /MRS_DOCS_MISSING[\s\S]*delivery_order/);
  await step('delivery order uploaded + confirmed → appointment stage', async () => {
    C.docs.delivery_order = await upload('clrJ', C.tx, 'delivery_order');
    await classify('clrJ', C.docs.delivery_order, 'delivery_order');
    await status('trJ', C.tx, 'appointment');
  });
  const KA = newKey();
  const pA = { transaction_id: C.tx, container_id: C.ct[0], terminal_party_id: C.terminal, appointment_at: hrs(5), window_minutes: 120,
    driver_id: C.driver, truck_id: C.truck };
  const a1 = await step('appointment 1 (containers 1) requested', () => rpc('trJ', `SELECT public.create_appointment($1, $2) r`, [pA, KA]));
  C.a1 = a1.id;
  await check('create_appointment replay → same row', async () => {
    const r = await rpc('trJ', `SELECT public.create_appointment($1, $2) r`, [pA, KA]);
    return (r.id === C.a1 && r.replayed === true) || JSON.stringify(r);
  });
  await check('alerts: appointment_soon (unconfirmed → warning) appears', async () => {
    await refresh();
    const a = await one(`SELECT severity, status FROM public.operational_alerts WHERE dedupe_key = $1`, ['appointment_soon:' + C.a1]);
    return (a && a.severity === 'warning' && a.status === 'open') || JSON.stringify(a);
  });
  const rs = await step('terminal moves the slot: reschedule with a reason (new row, old kept)', () =>
    rpc('trJ', `SELECT public.reschedule_appointment($1, $2, 'المحطة غيّرت الموعد', $3) r`, [C.a1, { appointment_at: hrs(8), status: 'confirmed', appointment_no: 'T-778' }, newKey()]));
  C.a2 = rs.appointment.id;
  await check('reschedule chain a1 → a2, a2 confirmed and inherits container / driver / truck', async () =>
    (JSON.stringify(rs.chain) === JSON.stringify([C.a1, C.a2]) && rs.appointment.status === 'confirmed' && rs.appointment.container_id === C.ct[0]
      && rs.appointment.driver_id === C.driver && rs.rescheduled.status === 'rescheduled') || JSON.stringify(rs));
  C.a3 = (await step('appointment for containers 2 + 3 confirmed', () => rpc('trJ', `SELECT public.create_appointment($1) r`,
    [{ transaction_id: C.tx, terminal_party_id: C.terminal, appointment_at: hrs(9), status: 'confirmed' }]))).id;
  await check('alerts: a1\'s soon alert auto-resolved; a2 / a3 soon alerts are info (confirmed)', async () => {
    await refresh();
    const r = await q(`SELECT dedupe_key, severity, status, resolution FROM public.operational_alerts WHERE kind = 'appointment_soon' AND transaction_id = $1 ORDER BY dedupe_key`, [C.tx]);
    const m = Object.fromEntries(r.map(x => [x.dedupe_key.split(':')[1], x]));
    return (m[C.a1].status === 'resolved' && m[C.a1].resolution === 'auto' && m[C.a2].severity === 'info' && m[C.a3].status === 'open') || JSON.stringify(r);
  });
  await step('both appointments completed', async () => {
    await rpc('trJ', `SELECT public.set_appointment_status($1, 'completed') r`, [C.a2]);
    await rpc('trJ', `SELECT public.set_appointment_status($1, 'completed') r`, [C.a3]);
  });
  await check('client sees two confirmed appointment times (then completed) and nothing else about appointments', async () => {
    const r = await as('clientC', `SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment' ORDER BY id`, [C.tx]);
    const rows = await as('clientC', `SELECT count(*)::int n FROM public.port_appointments`);
    const keys = ['op', 'appointment_ref', 'appointment_at', 'window_minutes', 'container_no'];
    const ops = r.map(x => x.payload.op).sort().join(',');
    return (r.length === 4 && ops === 'completed,completed,confirmed,confirmed'
      && r.every(x => Object.keys(x.payload).every(k => keys.includes(k))) && rows[0].n === 0) || JSON.stringify({ r, rows });
  });

  section('6. two transport legs');
  await step('transport stage', async () => {
    for (const id of C.ct) await as('trJ', `UPDATE public.containers SET operational_state = 'released' WHERE id = $1`, [id]);
    await status('trJ', C.tx, 'transport');
  });
  const KT = newKey();
  const leg1p = { transaction_id: C.tx, container_id: C.ct[0], carrier_id: C.carrier, driver_id: C.driver, truck_id: C.truck,
    origin: 'ميناء جدة الإسلامي', destination: 'مستودع العميل', planned_at: hrs(10) };
  C.t1 = (await step('leg 1 port → warehouse', () => rpc('trJ', `SELECT public.create_trip($1, $2) r`, [leg1p, KT]))).id;
  await check('create_trip replay → same leg', async () => (await rpc('trJ', `SELECT public.create_trip($1, $2) r`, [leg1p, KT])).id === C.t1);
  C.t2 = (await step('leg 2 warehouse → empty yard', () => rpc('trJ', `SELECT public.create_trip($1) r`,
    [{ transaction_id: C.tx, container_id: C.ct[0], carrier_id: C.carrier, origin: 'مستودع العميل', destination: 'ساحة دورة الاختبار' }]))).id;
  await step('operations manager records cost / sell of both legs', async () => {
    await rpc('opsJ', `SELECT public.update_trip($1, '{"cost_amount":900,"sell_amount":1200,"cost_basis":"agreed"}') r`, [C.t1]);
    await rpc('opsJ', `SELECT public.update_trip($1, '{"cost_amount":400,"sell_amount":550,"cost_basis":"estimated"}') r`, [C.t2]);
  });
  await step('both legs dispatched → loaded → delivered', async () => {
    for (const id of [C.t1, C.t2]) {
      await rpc('trJ', `SELECT public.set_trip_status($1, 'dispatched') r`, [id]);
      await rpc('trJ', `SELECT public.set_trip_status($1, 'loaded', $2) r`, [id, hrs(-1)]);
      await rpc('trJ', `SELECT public.set_trip_status($1, 'delivered') r`, [id]);
    }
    for (const id of C.ct) await as('trJ', `UPDATE public.containers SET operational_state = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
  });
  await check('cost / sell: ops manager and accountant see them; transport staff and the client do not', async () => {
    const o = await rpc('opsJ', `SELECT public.trip_finance($1) r`, [[C.t1, C.t2]]);
    const f = await rpc('accA', `SELECT public.trip_finance($1) r`, [[C.t1, C.t2]]);
    const t = await rpc('trJ', `SELECT public.trip_finance($1) r`, [[C.t1, C.t2]]);
    const c = await rpc('clientC', `SELECT public.trip_finance($1) r`, [[C.t1, C.t2]]);
    return (Number(o[C.t1].sell_amount) === 1200 && Number(f[C.t2].cost_amount) === 400 && Object.keys(t).length === 0
      && Object.keys(c).length === 0) || JSON.stringify({ o, f, t, c });
  });

  section('7. empty return: valid receipt / Return Note only (refused) / waived + exceptions');
  await step('empty_return stage', () => status('trJ', C.tx, 'empty_return'));
  C.docs.return_note = await upload('trJ', C.tx, 'empty_return_note');
  await classify('clrJ', C.docs.return_note, 'empty_return_note');
  await step('return plan for all 3: yard, instruction (Return Note), deadline (container 2 already overdue)', async () => {
    for (let i = 0; i < 3; i++) {
      await rpc('trJ', `SELECT public.set_container_return($1, $2) r`, [C.ct[i], {
        return_yard_party_id: C.yard, return_instruction_document_id: C.docs.return_note, return_deadline: i === 1 ? day(-1) : day(7) }]);
    }
  });
  await check('alerts: empty_return_overdue (critical) for container 2', async () => {
    await refresh();
    const a = await one(`SELECT severity, status FROM public.operational_alerts WHERE dedupe_key = $1`, ['empty_return_overdue:' + C.ct[1]]);
    return (a && a.severity === 'critical' && a.status === 'open') || JSON.stringify(a);
  });
  await step('container 1: empty-return receipt uploaded, confirmed, verified', async () => {
    C.docs.receipt1 = await upload('trJ', C.tx, 'empty_return_receipt');
    await classify('clrJ', C.docs.receipt1, 'empty_return_receipt');
    await as('trJ', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'returned_verified' WHERE id = $1`, [C.ct[0], C.docs.receipt1]);
  });
  await expectErr('container 2: the Return Note alone is refused as proof', () => as('trJ',
    `UPDATE public.containers SET evidence_document_id = $2, return_status = 'returned_verified' WHERE id = $1`, [C.ct[1], C.docs.return_note]), /MRS_EVIDENCE_INVALID/);
  await expectErr('container 2: the Return Note cannot be marked empty_returned either', () => as('trJ',
    `UPDATE public.containers SET operational_state = 'empty_returned' WHERE id = $1`, [C.ct[1]]), /MRS_EVIDENCE_INVALID/);
  await expectErr('transport staff cannot waive container 3', () => as('trJ',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'x' WHERE id = $1`, [C.ct[2]]), /MRS_FORBIDDEN/);
  await step('container 3: operations manager waives with a reason', () => as('opsJ',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'الحاوية مملوكة للعميل (SOC)' WHERE id = $1`, [C.ct[2]]));
  await expectErr('completion refused while container 2 is not returned', () => status('clrJ', C.tx, 'operationally_complete'), /MRS_CONTAINERS_NOT_RETURNED/);
  C.excDem = (await step('demurrage exception for container 2 (amount)', () => rpc('trJ', `SELECT public.create_exception($1, $2) r`,
    [{ transaction_id: C.tx, container_id: C.ct[1], kind: 'demurrage', reason: 'تأخر إرجاع الحاوية يومًا', amount: 350 }, newKey()]))).id;
  await check('alerts: exception_open for both exceptions', async () => {
    await refresh();
    const r = await q(`SELECT dedupe_key FROM public.operational_alerts WHERE kind = 'exception_open' AND transaction_id = $1 AND status = 'open'`, [C.tx]);
    return r.length === 2 || JSON.stringify(r);
  });
  await step('container 2: the real receipt arrives → evidence_submitted → verified', async () => {
    C.docs.receipt2 = await upload('trJ', C.tx, 'empty_return_receipt');
    await as('trJ', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'evidence_submitted' WHERE id = $1`, [C.ct[1], C.docs.receipt2]);
    await classify('clrJ', C.docs.receipt2, 'empty_return_receipt');
    await as('trJ', `UPDATE public.containers SET return_status = 'returned_verified' WHERE id = $1`, [C.ct[1]]);
  });
  await step('exceptions resolved (demurrage paid, declaration replaced)', async () => {
    await rpc('trJ', `SELECT public.resolve_exception($1, 'resolved', 'سُددت الأرضيات') r`, [C.excDem]);
    await rpc('clrJ', `SELECT public.resolve_exception($1, 'resolved', 'استُبدل البيان CYC-0002') r`, [C.excDecl]);
  });

  section('8. completion + alerts auto-resolved');
  await step('operationally_complete (no override needed)', async () => {
    const r = await status('clrJ', C.tx, 'operationally_complete', null, newKey());
    if (r.to !== 'operationally_complete' || r.docs_override !== null) throw new Error(JSON.stringify(r));
  });
  await check('refresh: no alert of the transaction is left open; every one resolved automatically', async () => {
    await refresh();
    const open = await openAlerts(C.tx);
    const all = await q(`SELECT kind, resolution FROM public.operational_alerts WHERE transaction_id = $1`, [C.tx]);
    return (open.length === 0 && all.length >= 6 && all.every(a => a.resolution === 'auto')) || JSON.stringify({ open, all });
  });
  await check('staff "refresh now" works (and is rate-limited right after)', async () => {
    const a = await rpc('clrJ', `SELECT public.refresh_alerts($1) r`, [A]);
    const b = await rpc('trJ', `SELECT public.refresh_alerts($1) r`, [A]);
    return (a.refreshed && !b.refreshed && b.rate_limited) || JSON.stringify({ a, b });
  });
}

/* ------------------------------------------------------------------ final comparison */
async function compare() {
  section('9. every record compared: nothing lost, no duplicates');
  const tx = C.tx;
  await check('one transaction for the request, at operationally_complete, B/L + active declaration mirrored', async () => {
    const t = await q(`SELECT operational_status, bl_number, declaration_no, container_count FROM public.transactions WHERE request_id = $1`, [REQ]);
    const r = await one(`SELECT status FROM public.service_requests WHERE id = $1`, [REQ]);
    return (t.length === 1 && t[0].operational_status === 'operationally_complete' && t[0].bl_number === BL
      && t[0].declaration_no === 'CYC-0002' && t[0].container_count === 3 && r.status === 'converted') || JSON.stringify({ t, r });
  });
  await check('one client created, no duplicate from the second match', async () =>
    (await count(`SELECT count(*)::int n FROM public.clients WHERE org_id = $1 AND vat_number = '300000000000777'`, [A])) === 1);
  await check('containers: exactly 3 visits, unique visit_refs, all tied to the B/L, final states as expected', async () => {
    const r = await q(`SELECT container_no, visit_ref, bl_id, return_status, operational_state, evidence_document_id, evidence_received_at
                         FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [tx]);
    const st = r.map(x => x.return_status + '/' + x.operational_state).join(',');
    return (r.length === 3 && new Set(r.map(x => x.visit_ref)).size === 3 && r.every(x => x.bl_id === C.bl)
      && JSON.stringify(r.map(x => x.container_no)) === JSON.stringify(CTRS)
      && st === 'returned_verified/empty_returned,returned_verified/empty_returned,waived/delivered'
      && r[0].evidence_document_id === C.docs.receipt1 && r[1].evidence_document_id === C.docs.receipt2
      && !!r[0].evidence_received_at && !!r[1].evidence_received_at) || JSON.stringify(r);
  });
  await check('B/L: one record (org-wide), one primary link, no duplicate by number', async () => {
    const b = await count(`SELECT count(*)::int n FROM public.bills_of_lading WHERE org_id = $1 AND bl_number = $2`, [A, BL]);
    const l = await q(`SELECT is_primary FROM public.transaction_bls WHERE transaction_id = $1`, [tx]);
    return (b === 1 && l.length === 1 && l[0].is_primary) || JSON.stringify({ b, l });
  });
  await check('declarations: 2 rows kept (replaced → released), chain intact, one active number', async () => {
    const r = await q(`SELECT id, declaration_no, status, replaced_by_id, cancel_reason FROM public.customs_declarations WHERE transaction_id = $1 ORDER BY created_at`, [tx]);
    return (r.length === 2 && r[0].id === C.d1 && r[0].status === 'replaced' && r[0].replaced_by_id === C.d2 && r[0].cancel_reason
      && r[1].id === C.d2 && r[1].status === 'released') || JSON.stringify(r);
  });
  await check('documents: every upload kept, none voided, none duplicated', async () => {
    const r = await q(`SELECT id, voided_at FROM public.documents WHERE transaction_id = $1`, [tx]);
    return (r.length === Object.keys(C.docs).length && r.every(x => !x.voided_at)
      && Object.values(C.docs).every(id => r.some(x => x.id === id))) || JSON.stringify({ n: r.length, docs: Object.keys(C.docs) });
  });
  await check('appointments: 3 rows (rescheduled, completed, completed), the old slot kept and linked', async () => {
    const r = await q(`SELECT id, status, rescheduled_from_id, status_reason FROM public.port_appointments WHERE transaction_id = $1 ORDER BY created_at`, [tx]);
    return (r.length === 3 && r[0].id === C.a1 && r[0].status === 'rescheduled' && r[0].status_reason
      && r[1].id === C.a2 && r[1].rescheduled_from_id === C.a1 && r[1].status === 'completed'
      && r[2].id === C.a3 && r[2].status === 'completed') || JSON.stringify(r);
  });
  await check('trips: 2 legs (1, 2) delivered with load / unload times, no duplicate from the replay', async () => {
    const r = await q(`SELECT id, leg_no, status, loaded_at, unloaded_at FROM public.transport_trips WHERE transaction_id = $1 ORDER BY leg_no`, [tx]);
    return (r.length === 2 && r[0].id === C.t1 && r[1].id === C.t2 && r[0].leg_no === 1 && r[1].leg_no === 2
      && r.every(x => x.status === 'delivered' && x.loaded_at && x.unloaded_at)) || JSON.stringify(r);
  });
  await check('exceptions: 2 (declaration_cancelled system + demurrage), both resolved with a note', async () => {
    const r = await q(`SELECT kind, source, status, resolution_note FROM public.operational_exceptions WHERE transaction_id = $1 ORDER BY created_at`, [tx]);
    return (r.length === 2 && r[0].kind === 'declaration_cancelled' && r[0].source === 'system' && r[1].kind === 'demurrage'
      && r.every(x => x.status === 'resolved' && x.resolution_note)) || JSON.stringify(r);
  });
  await check('alerts: one row per cause (no duplicate dedupe_key), all resolved', async () => {
    const r = await q(`SELECT dedupe_key, count(*)::int n, bool_and(status = 'resolved') ok FROM public.operational_alerts
                        WHERE transaction_id = $1 GROUP BY 1`, [tx]);
    return (r.length >= 6 && r.every(x => x.n === 1 && x.ok)) || JSON.stringify(r);
  });
  await check('status timeline: 6 forward moves in order, each a client-visible event, no override used', async () => {
    const r = (await q(`SELECT from_status, to_status FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'operational_status' ORDER BY id`, [tx]))
      .map(x => x.from_status + '>' + x.to_status);
    const ov = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'docs_override'`, [tx]);
    return (JSON.stringify(r) === JSON.stringify(['new>in_progress', 'in_progress>customs_declaration', 'customs_declaration>appointment',
      'appointment>transport', 'transport>empty_return', 'empty_return>operationally_complete']) && ov === 0) || JSON.stringify({ r, ov });
  });
  await check('every appointment / trip / exception / declaration row has its own event (nothing silent)', async () => {
    const miss = await q(`
      SELECT 'appointment' t, a.id::text FROM public.port_appointments a WHERE a.transaction_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.transaction_events e WHERE e.event_type = 'appointment' AND e.payload->>'appointment_id' = a.id::text)
      UNION ALL SELECT 'trip', t.id::text FROM public.transport_trips t WHERE t.transaction_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.transaction_events e WHERE e.event_type = 'trip' AND e.payload->>'trip_id' = t.id::text)
      UNION ALL SELECT 'exception', x.id::text FROM public.operational_exceptions x WHERE x.transaction_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.transaction_events e WHERE e.event_type = 'exception' AND e.payload->>'exception_id' = x.id::text)
      UNION ALL SELECT 'declaration', d.id::text FROM public.customs_declarations d WHERE d.transaction_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.transaction_events e WHERE e.event_type = 'declaration' AND e.payload->>'declaration_id' = d.id::text)`, [tx]);
    return miss.length === 0 || JSON.stringify(miss);
  });
  await check('audit trail holds every new row (appointments, trips, exceptions, declarations, containers)', async () => {
    const r = await one(`SELECT
      (SELECT count(DISTINCT row_id) FROM public.audit_log WHERE table_name = 'port_appointments' AND action = 'INSERT' AND row_id = ANY ($1))::int a,
      (SELECT count(DISTINCT row_id) FROM public.audit_log WHERE table_name = 'transport_trips' AND action = 'INSERT' AND row_id = ANY ($2))::int t,
      (SELECT count(DISTINCT row_id) FROM public.audit_log WHERE table_name = 'operational_exceptions' AND action = 'INSERT' AND row_id = ANY ($3))::int x,
      (SELECT count(DISTINCT row_id) FROM public.audit_log WHERE table_name = 'customs_declarations' AND action = 'INSERT' AND row_id = ANY ($4))::int d`,
      [[C.a1, C.a2, C.a3], [C.t1, C.t2], [C.excDecl, C.excDem], [C.d1, C.d2]]);
    return (r.a === 3 && r.t === 2 && r.x === 2 && r.d === 2) || JSON.stringify(r);
  });
  await check('client portal view: the transaction, 3 containers, both declaration numbers + statuses, the B/L — no internal data', async () => {
    const t = await as('clientC', `SELECT operational_status FROM public.transactions WHERE id = $1`, [tx]);
    const c = await as('clientC', `SELECT operational_state, return_status, return_deadline FROM public.containers WHERE transaction_id = $1`, [tx]);
    const d = await as('clientC', `SELECT declaration_no, status FROM public.customs_declarations WHERE transaction_id = $1 ORDER BY created_at`, [tx]);
    const b = await as('clientC', `SELECT bl_number FROM public.bills_of_lading`);
    const hidden = [];
    for (const s of [`SELECT 1 FROM public.transport_trips`, `SELECT 1 FROM public.operational_exceptions`, `SELECT 1 FROM public.operational_alerts`,
      `SELECT 1 FROM public.port_appointments`, `SELECT 1 FROM public.drivers`, `SELECT cost_amount FROM public.transport_trips`]) {
      try { const r = await as('clientC', s); if (r.length) hidden.push(s); } catch (e) { /* permission denied = hidden */ }
    }
    const ev = (await as('clientC', `SELECT DISTINCT event_type FROM public.transaction_events WHERE transaction_id = $1 ORDER BY 1`, [tx])).map(x => x.event_type);
    return (t.length === 1 && t[0].operational_status === 'operationally_complete' && c.length === 3
      && JSON.stringify(d.map(x => x.declaration_no + ':' + x.status)) === '["CYC-0001:replaced","CYC-0002:released"]'
      && b.length === 1 && b[0].bl_number === BL && hidden.length === 0
      && JSON.stringify(ev) === '["appointment","container_return","created","operational_status"]') || JSON.stringify({ t, c, d, b, hidden, ev });
  });
}

/* ------------------------------------------------------------------ runner */
async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  try { const r = await fixtures(); r.n === 15 ? pass('fixtures: users, service request (3 containers), org A default requirements')
                                                : fail('fixtures', 'requirements seeded: ' + r.n); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  try { await cycle(); await compare(); }
  catch (e) { fail('cycle', errText(e)); }
  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

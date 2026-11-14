#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 5 (appointment cards and the empty return): migration 20261121000100_legacy_appt.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs + the owner decisions in the plan; preflight, re-run on itself
  (identical catalog), catalog delta; the card / EIR keys (= extract.js ALL_KEYS_V3) and ai_detail (extract.js postProcess
  output saved, bad shapes refused); app.appt_ts (a date alone refused, Riyadh time); the draft lifecycle (create, open one
  per transaction, autosave review + version / stale, discard / restore, the same file kept once, 20 cards / 25 MB, reading /
  document checks, cost in a review = trip-finance only, restore with get, cancel releases the cards); approval card by card
  (saved through save_movement with the card fields on the appointment and the party on the trip, already existed, skipped
  empty entry, failed: container not in the transaction / no party / no time; partial then approved; idempotent replay;
  approved / partial batches cannot be cancelled or moved); the re-read rules (fingerprint across the org, pending in
  another transaction → move, a cancelled appointment / transaction releases the card, a reschedule keeps the link);
  move by transaction number (whole batch, or merged into the target's open batch); the empty-return proofs (create from an
  EIR reading / manually, never applied automatically, date without time refused, 8 MB, verify writes the container return
  through the evidence path, void reverts only when no other approved proof, locked after operational completion, deadline
  save, list); the TASTO carrier order (format, stage, uniqueness, idempotent, audit note, no bypass of the empty-return
  gate); tx_readiness; RLS / column grants / branch scoping / function privileges / conversion lists / audit; supa.js
  wrappers and i18n messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-appt-sql-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261121000100_legacy_appt.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const XJS = require(path.join(SUPA, 'functions', 'ai-extract', 'extract.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-appt-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'a99d0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'a99d0000-0000-4000-8000-0000000000b1';
const CL_B = 'a99d0000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'a99e0000-0000-4000-8000-000000000001',    // admin of A (org-wide; trip finance)
  acc: 'a99e0000-0000-4000-8000-000000000002',      // accountant of A (staff, not a transport writer)
  jed: 'a99e0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only (transport writer, no trip finance)
  dmm: 'a99e0000-0000-4000-8000-000000000006',      // clearance_staff of A, DMM only
  trn: 'a99e0000-0000-4000-8000-000000000007',      // transport_staff of A, JED
  portal: 'a99e0000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  stranger: 'a99e0000-0000-4000-8000-000000000009', // no membership
  staffB: 'a99e0000-0000-4000-8000-00000000000a'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
let roleLock = Promise.resolve();
async function asRole(who, fn, aal) {
  const prev = roleLock;
  let release;
  roleLock = new Promise(r => { release = r; });
  await prev;
  try { return await asRoleNow(who, fn, aal); } finally { release(); }
}
async function asRoleNow(who, fn, aal) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: aal || 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params, aal) => asRole(who, () => q(sql, params), aal);
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await one(sql, params)).n);
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e) + '\n        ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    let x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
    x = m.match(/duplicate key value violates unique constraint "([^"]+)"/); if (x) return 'uniq:' + x[1];
    if (/row-level security/.test(m)) return 'rls';
    if (/permission denied/.test(m)) return 'perm';
    return errText(e);
  }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
let keySeq = 0;
const newKey = () => 'a99daaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'e');
const ctr = p => p + XJS.iso6346CheckDigit(p);
let ctrSeq = 0;
const nextCtr = () => ctr('APTU' + String(100000 + (++ctrSeq)));
let minSeq = 0;
// a distinct appointment slot (Riyadh local time) per card
const nextAt = () => { const m = ++minSeq; return '2026-12-' + String(1 + Math.floor(m / 600) % 28).padStart(2, '0') + 'T' + String(6 + Math.floor(m / 60) % 10).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const idx = (await q(`SELECT indexname || ':' || md5(indexdef) x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || md5(pg_get_constraintdef(oid)) x FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace ORDER BY 1`)).map(x => x.x);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const grants = (await q(`SELECT table_name || ':' || grantee || ':' || privilege_type x FROM information_schema.role_table_grants
                            WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1`)).map(x => x.x);
  const colgrants = (await q(`SELECT table_name || '.' || column_name || ':' || grantee || ':' || privilege_type x FROM information_schema.column_privileges
                               WHERE table_schema = 'public' AND grantee IN ('anon','authenticated') ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, grants, colgrants, labels };
}
const NEW_TABLES = ['public.appointment_draft_cards', 'public.appointment_drafts', 'public.empty_return_proofs'];
const NEW_FNS = ['app.appointment_fingerprint_state', 'app.appt_card_approve', 'app.appt_card_json', 'app.appt_card_val', 'app.appt_draft_json',
  'app.appt_draft_lock', 'app.appt_review_check', 'app.appt_ts', 'app.empty_return_blocks_billing', 'app.erp_json', 'app.extraction_appt_detail_ok',
  'app.extraction_appt_section_ok', 'app.extraction_eir_detail_ok', 'app.tg_appointments_card_link', 'app.tg_legacy_appt_guard',
  'app.tg_transactions_appt_drafts', 'app.tx_readiness_of', 'public.appointment_card_state', 'public.approve_appointment_draft',
  'public.cancel_appointment_draft', 'public.create_empty_return_proof', 'public.get_appointment_draft', 'public.list_empty_return_proofs',
  'public.move_appointment_draft', 'public.save_appointment_draft', 'public.save_empty_return_deadline', 'public.save_transport_carrier_order',
  'public.tx_readiness', 'public.verify_empty_return_proof', 'public.void_empty_return_proof'];
const RECREATED = ['app.convert_delete_guards', 'app.convert_delete_tables', 'app.extraction_detail_ok', 'app.extraction_field_keys', 'app.movement_json'];
const RPCS = ['appointment_card_state', 'approve_appointment_draft', 'cancel_appointment_draft', 'create_empty_return_proof', 'get_appointment_draft',
  'list_empty_return_proofs', 'move_appointment_draft', 'save_appointment_draft', 'save_empty_return_deadline', 'save_transport_carrier_order',
  'tx_readiness', 'verify_empty_return_proof', 'void_empty_return_proof'];
const CODES = ['MRS_APPT_DRAFT_EXISTS', 'MRS_APPT_DRAFT_CLOSED', 'MRS_APPT_DRAFT_APPROVED', 'MRS_APPT_DRAFT_STALE', 'MRS_APPT_DRAFT_LIMIT',
  'MRS_APPT_CARD_DUPLICATE', 'MRS_APPT_CONTAINER_NOT_IN_TX', 'MRS_APPT_PARTY_REQUIRED', 'MRS_DATETIME_REQUIRED', 'MRS_EMPTY_RETURN_CLOSED',
  'MRS_EMPTY_RETURN_LOCKED', 'MRS_EMPTY_RETURN_FILE', 'MRS_TASTO_INVALID', 'MRS_TASTO_TAKEN', 'MRS_TASTO_STAGE'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@legacyappt.example.com', now()), ('${U.acc}', 'acc@legacyappt.example.com', now()),
    ('${U.jed}', 'jed@legacyappt.example.com', now()), ('${U.dmm}', 'dmm@legacyappt.example.com', now()),
    ('${U.trn}', 'trn@legacyappt.example.com', now()), ('${U.portal}', 'portal@legacyappt.example.com', now()),
    ('${U.stranger}', 'stranger@legacyappt.example.com', now()), ('${U.staffB}', 'staffb@legacyappt.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.trn}', 'trn'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacyappt-org-b', 'مؤسسة ب', 'Legacy appt org B', 'LAB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.trn}', '${A}', '${JED}', 'transport_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
// a transaction (owner SQL) with n containers; status set by the owner (no event trail needed here)
async function mkTx(o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, n: 1, status: 'customs_declaration', count: 0 }, o || {});
  const tx = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count)
                       VALUES ($1, $2, $3, 'import', 'sea', $4) RETURNING id, ref`, [x.org, x.branch, x.client, x.count]))[0];
  if (x.status !== 'new') await q(`UPDATE public.transactions SET operational_status = $2 WHERE id = $1`, [tx.id, x.status]);
  const ctrs = [];
  for (let i = 0; i < x.n; i++) {
    const c = nextCtr();
    ctrs.push((await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3) RETURNING id, container_no`, [x.org, tx.id, c]))[0]);
  }
  return { id: tx.id, ref: tx.ref, ctrs, org: x.org };
}
// a stored document of the transaction (owner SQL)
async function mkDoc(t, o) {
  const x = Object.assign({ sha: sha(), size: 120000, mime: 'application/pdf', kind: 'other' }, o || {});
  const id = crypto.randomUUID();
  await q(`INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'proof.pdf', $7, $8, $9)`,
    [id, t.org, t.id, x.kind, t.org + '/' + t.id + '/' + id + '/proof.pdf', x.sha, x.mime, x.size, U.jed]);
  return { id, sha: x.sha };
}
// a saved AI reading (owner SQL, the hash bound to its usage like the Edge Function does)
async function mkExt(o) {
  const x = Object.assign({ org: A, tx: null, kind: 'appointment', out: null, by: 'jed', sha: sha() }, o || {});
  const usage = (await q(`INSERT INTO app.ai_usage (org_id, user_id, purpose, status, model, reserved_usd, cost_usd, input_tokens, output_tokens, settled_at, source_sha256)
                          VALUES ($1, $2, 'doc_extract', 'ok', 'claude-opus-5-5', 0.48, 0.01, 10, 10, now(), $3) RETURNING id`, [x.org, U[x.by], x.sha]))[0].id;
  const id = (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages,
                     raw_text, extracted_fields, line_items, created_by, ai_usage_id, ai_detail)
                   VALUES ($1, $2, $3, 'card.pdf', $4, 'claude-opus-5-5', 'auto', $5, $6, '[]', $7, $8, $9) RETURNING id`,
    [x.org, x.tx, x.kind, x.sha, x.out.raw_text, J(x.out.extracted_fields), U[x.by], usage, J(x.out.ai_detail)]))[0].id;
  return id;
}
const SEC0 = { location: null, bl_number: null, declaration_number: null, container_number: null, cargo_type: null, purpose: null };
// the model output of a card (extract.js input)
function cardOut(o) {
  const x = Object.assign({ ctr: nextCtr(), at: nextAt(), booking: 'TAS' + String(20000000 + (++shaSeq)), entry: false, docType: 'appointment_ticket' }, o || {});
  const sec = { location: 'Terminal 1', bl_number: 'MEDU123456', declaration_number: '3012345', container_number: x.ctr, cargo_type: 'FCL', purpose: 'Import' };
  return { doc_type: x.docType, document_title: 'Appointment Confirmation Ticket', invoice_signals: [],
    fields: [{ name: 'appointment_booking_ref', value: x.booking, confidence: 0.95, page: null },
      { name: 'appointment_ticket_no', value: 'OP-' + shaSeq, confidence: 0.9, page: null }, { name: 'appointment_operator', value: 'Test Terminal Operator', confidence: 0.9, page: null },
      { name: 'appointment_at', value: x.at, confidence: 0.93, page: null }, { name: 'vehicle_plate', value: 'ABC ' + (1000 + shaSeq % 9000), confidence: 0.8, page: null },
      { name: 'driver_name', value: 'Test Driver ' + (shaSeq % 7), confidence: 0.9, page: null },
      { name: 'driver_phone', value: '0' + '5' + String(10000000 + shaSeq % 7).slice(0, 8), confidence: 0.9, page: null },
      { name: 'appointment_zone_gate', value: 'Zone B / Gate 4', confidence: 0.8, page: null }, { name: 'appointment_barcode', value: 'BC' + shaSeq, confidence: 0.7, page: null }],
    entry: x.entry ? sec : SEC0, exit: x.entry ? SEC0 : sec, warnings: [] };
}
const cardRead = o => XJS.postProcess(cardOut(o), 'appointment_ticket', 'ai-doc-v3');
// a card of a save_appointment_draft payload from a reading (the UI keeps the reading as the AI returned it)
const cardIn = (P, o) => Object.assign({ source_sha256: sha(), file_name: 'card.pdf', file_size: 200000, media_type: 'application/pdf',
  reading: { appointment: P.appointment, fields: P.fields, warnings: P.warnings }, review: { party_type: 'direct' } }, o || {});
const saveDraft = (who, tx, p) => rpc(who || 'jed', `SELECT public.save_appointment_draft($1, $2) r`, [tx, p]);
const getDraft = (who, tx, b) => rpc(who || 'jed', `SELECT public.get_appointment_draft($1, $2) r`, [tx, b || null]);
const approveDraft = (who, b, p) => rpc(who || 'jed', `SELECT public.approve_appointment_draft($1, $2) r`, [b, p || {}]);
const cancelDraft = (who, b, r) => rpc(who || 'jed', `SELECT public.cancel_appointment_draft($1, $2) r`, [b, r]);
const moveDraft = (who, b, ref, r) => rpc(who || 'jed', `SELECT public.move_appointment_draft($1, $2, $3) r`, [b, ref, r || null]);
const cardState = (who, tx, shas) => rpc(who || 'jed', `SELECT public.appointment_card_state($1, $2, $3) r`, [A, tx, shas]);
const eirOut = o => {
  const x = Object.assign({ ctr: null, at: '2026-11-06 09:15', depot: 'Test Empty Depot', movement: 'empty_return' }, o || {});
  return { doc_type: 'empty_return_receipt', document_title: 'EIR', movement: x.movement, time_printed: true,
    fields: [x.ctr ? { name: 'container_numbers', value: x.ctr, confidence: 0.96, page: null } : null,
      x.at ? { name: 'return_delivered_at', value: x.at, confidence: 0.82, page: null } : null,
      x.depot ? { name: 'return_depot', value: x.depot, confidence: 0.9, page: null } : null].filter(Boolean), warnings: [] };
};
const createProof = (who, tx, p) => rpc(who || 'jed', `SELECT public.create_empty_return_proof($1, $2) r`, [tx, p]);
const verifyProof = (who, id, p) => rpc(who || 'jed', `SELECT public.verify_empty_return_proof($1, $2) r`, [id, p || {}]);
const voidProof = (who, id, r) => rpc(who || 'jed', `SELECT public.void_empty_return_proof($1, $2) r`, [id, r]);
const readiness = (who, tx) => rpc(who || 'jed', `SELECT public.tx_readiness($1) r`, [tx]);
const tasto = (who, tx, p) => rpc(who || 'jed', `SELECT public.save_transport_carrier_order($1, $2) r`, [tx, p]);
const fp = s => one(`SELECT app.appointment_fingerprint_state($1, $2) x`, [A, s]).then(r => r.x);

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs, the owner decisions');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261120000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h) && !/FUNCTION app\.(extraction_field_keys)\(/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261120000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261121000100', 'legacy_appt'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail(\'MRS_*\') only (no RAISE EXCEPTION besides the guard / preflight)', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY APPT preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 60 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ raises: raises.length, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; the new codes are exactly the 15 of the header', () => {
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    const newOnes = used.filter(c => /^MRS_(APPT_|DATETIME_|EMPTY_RETURN_|TASTO_)/.test(c));
    return (missing.length === 0 && J(newOnes.sort()) === J(CODES.slice().sort()) && CODES.every(c => src.slice(0, 9000).includes(c))) || 'missing: ' + missing.join(', ') + ' new: ' + newOnes;
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name copied from the legacy code (no e-mail, phone number, real org name)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)) || 'personal data');
  await check('the owner decisions are in the code: no automatic verification, the TASTO order never bypasses, set_transaction_status untouched', () =>
    (!/set_transaction_status\s*\(/i.test(src.replace(/--.*$/gm, '').replace(/'under_billing'/g, '')) && /'bypasses_empty_return', false/.test(src)
      && /SELECT true\n\$\$/.test(src) && !/CREATE OR REPLACE FUNCTION public\.set_transaction_status/.test(src)) || 'decisions');
  // later phases may follow this file (20261122000100 legacy_pay: re-creates the conversion lists)
  const LATER_PHASES = ['20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql', '20261128000100_return_extension.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 14000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_APPT_AR.md exists and names the migration, every RPC, the error codes, ai-doc-v3 and the draft / proof rules', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_APPT_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'ai-doc-v3', 'appointment_ticket', 'empty_return_receipt', 'appointment_drafts', 'appointment_draft_cards', 'empty_return_proofs',
      'wrong_document_type', 'TASTO', 'مسودة', 'لا يُعتمد آليًا'].concat(RPCS, CODES).filter(x => !d.includes(x));
    return miss.length === 0 || 'missing: ' + miss.join(', ');
  });
  await check('LEGACY_PORT_PLAN_AR.md records the owner decision of 2026-11-11 (TASTO does not bypass the empty-return proof)', () => {
    const d = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_PORT_PLAN_AR.md'), 'utf8');
    return (/2026-11-11/.test(d) && /TASTO[^\n]*لا يتجاوز/.test(d)) || 'no decision line';
  });
}

/* ================================================================== 2. preflight, re-run, catalog */
async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261120000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_decl: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY APPT preflight: apply legacy_decl first (schema_versions lacks 20261120000100 legacy_decl)')
          && (await one(`SELECT to_regclass('public.empty_return_proofs') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261120000100', 'legacy_decl')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r3 = await tryErr(() => db.exec(src));
      await check('applies, then re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, policies, constraints, columns, grants, column grants, labels); no data', async () =>
        (r1 === 'ok' && r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261121000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1) || J({ r1, r3 }));
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions and tables; the re-created ones listed (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)).sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        const tbl = C1.tables.filter(t => !C0.tables.includes(t)).sort();
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && keep && J(tbl) === J(NEW_TABLES)) || J({ added, changed, tbl });
      });
      await check('catalog: the only new columns outside the 3 tables are the 8 card columns of port_appointments and the 3 party columns of transport_trips; save_movement / set_transaction_status / set_container_return untouched', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c) && !NEW_TABLES.some(t => c.startsWith(t.split('.')[1] + '.'))).sort();
        const same = ['public.save_movement', 'public.set_transaction_status', 'public.set_container_return', 'app.advance_tx_status']
          .every(n => C1.fns.filter(f => f.sig.startsWith(n + '(')).every(f => s0.get(f.sig) && s0.get(f.sig).h === f.h));
        return (J(cols) === J(['port_appointments.barcode', 'port_appointments.booking_ref', 'port_appointments.extraction_id', 'port_appointments.movement_type', 'port_appointments.operator_name',
          'port_appointments.operator_ticket_no', 'port_appointments.source_document_id', 'port_appointments.zone_gate', 'transport_trips.party_name',
          'transport_trips.party_type', 'transport_trips.transport_order_no']) && same) || J({ cols, same });
      });
      await check('catalog: anon / authenticated table grants on the new tables are SELECT for authenticated (drafts, proofs); the cards by column (no review); the trip party columns readable, cost / sell still not', () => {
        const g = C1.grants.filter(x => !C0.grants.includes(x));
        const api = g.filter(x => !/:service_role:/.test(x));
        const cg = C1.colgrants.filter(x => !C0.colgrants.includes(x));
        return (api.length === 2 && api.every(x => /:authenticated:SELECT$/.test(x)) && !api.some(x => /^appointment_draft_cards:/.test(x))
          && cg.some(x => x === 'appointment_draft_cards.source_sha256:authenticated:SELECT') && !cg.some(x => /^appointment_draft_cards\.review:/.test(x))
          && ['party_type', 'party_name', 'transport_order_no'].every(c => cg.includes('transport_trips.' + c + ':authenticated:SELECT'))
          && !C1.colgrants.some(x => /^transport_trips\.(cost_amount|sell_amount):/.test(x))) || J({ api, cg: cg.slice(0, 5) });
      });
      await check('catalog: the new labels are the 6 domains (22 rows); existing labels unchanged', () => {
        const add = C1.labels.filter(x => !C0.labels.includes(x));
        const gone = C0.labels.filter(x => !C1.labels.includes(x));
        return (gone.length === 0 && add.length === 22 && add.every(x => /^(appt_draft_status|appt_card_status|appt_movement_type|transport_party_type|empty_return_proof_status|empty_return_proof_source)\./.test(x))) || J({ add, gone });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. readings */
async function secReadings() {
  section('3. readings: the card / EIR keys, ai_detail.appointment / empty_return, app.appt_ts');
  await check('app.extraction_field_keys() = extract.js ALL_KEYS_V3 (66 keys: the 50 of steps 3–4 first, then the 16 card / EIR keys)', async () => {
    const k = (await one(`SELECT app.extraction_field_keys() k`)).k;
    return (J(k) === J(XJS.ALL_KEYS_V3) && k.length === 66 && J(k.slice(50)) === J(XJS.APPT_KEYS.concat(XJS.EIR_KEYS))) || J(k);
  });
  await check('a card reading and an EIR reading (extract.js output) save as AI readings (doc types appointment / empty_return_receipt) with their detail', async () => {
    const P = cardRead(), E = XJS.postProcess(eirOut({ ctr: nextCtr() }), 'empty_return_receipt', 'ai-doc-v3');
    const a = await mkExt({ out: P }), b = await mkExt({ out: E, kind: 'empty_return_receipt' });
    const r = await q(`SELECT doc_type, ai_detail ? 'appointment' a, ai_detail ? 'empty_return' e FROM public.document_extractions WHERE id IN ($1, $2) ORDER BY doc_type`, [a, b]);
    return (r.length === 2 && r[0].doc_type === 'appointment' && r[0].a && r[1].doc_type === 'empty_return_receipt' && r[1].e) || J(r);
  });
  await check('ai_detail: unknown appointment / empty_return keys, a bad movement type, a confidence outside 0..1, a non-object section → refused (CHECK)', async () => {
    const t = async v => (await one(`SELECT app.extraction_detail_ok($1) x`, [J(Object.assign({ prompt_version: 'ai-doc-v3' }, v))])).x;
    const r = await Promise.all([t({ appointment: { x: 1 } }), t({ appointment: { movement_type: 'up' } }), t({ appointment: { entry: [1] } }),
      t({ empty_return: { confidence: 2 } }), t({ empty_return: { time_printed: 'y' } }), t({ detected_type: 'appointment_invoice' }), t({ detected_type: 'menu' })]);
    return J(r) === J([false, false, false, false, false, true, false]) || J(r);
  });
  await check('app.appt_ts: a date AND a time; no offset = Riyadh (+03:00); a date alone → MRS_DATETIME_REQUIRED; nonsense → MRS_INVALID', async () => {
    const a = (await one(`SELECT to_char(app.appt_ts('{"t":"2026-11-06 09:15"}', 't') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') x`)).x;
    const b = (await one(`SELECT to_char(app.appt_ts('{"t":"2026-11-06T09:15:00Z"}', 't') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') x`)).x;
    const c = await code(() => q(`SELECT app.appt_ts('{"t":"2026-11-06"}', 't')`));
    const d = await code(() => q(`SELECT app.appt_ts('{"t":"16/11/2026"}', 't')`));
    const e = await code(() => q(`SELECT app.appt_ts('{"t":"tomorrow"}', 't')`));
    const iso = v => v;
    return (iso(a) === '2026-11-06T06:15' && iso(b) === '2026-11-06T09:15' && c === 'MRS_DATETIME_REQUIRED t' && d === 'MRS_DATETIME_REQUIRED t' && e === 'MRS_INVALID t') || J({ a, b, c, d, e });
  });
  await check('app.empty_return_blocks_billing: true (the read-only policy flag of this step)', async () =>
    (await one(`SELECT app.empty_return_blocks_billing($1) x`, [A])).x === true);
}

/* ================================================================== 4. drafts */
let T1, D1, P1, P2, S1, S2;
async function secDrafts() {
  section('4. appointment drafts: create, one open per transaction, autosave, discard / restore, limits, checks, restore, cancel');
  T1 = await mkTx({ n: 3 });
  P1 = cardRead({ ctr: T1.ctrs[0].container_no }); P2 = cardRead({ ctr: T1.ctrs[1].container_no });
  S1 = sha(); S2 = sha();
  await check('save_appointment_draft (new): an open batch with the cards in order, status pending, version 1, the transaction containers, total bytes', async () => {
    D1 = await saveDraft('jed', T1.id, { note: 'دفعة', cards: [cardIn(P1, { source_sha256: S1 }), cardIn(P2, { source_sha256: S2, file_size: 300000 })] });
    return (D1.status === 'pending' && D1.version === 1 && D1.cards.length === 2 && D1.cards[0].seq === 1 && D1.cards[1].seq === 2 && D1.total_bytes === 500000
      && D1.containers.length === 3 && D1.cards[0].reading.appointment.booking_ref === P1.appointment.booking_ref && D1.can_edit === true && D1.ref === T1.ref
      && D1.counts.pending === 2 && D1.limits.cards === 20) || J(D1);
  });
  await check('a second new batch on the same transaction → MRS_APPT_DRAFT_EXISTS (restore the open one); get_appointment_draft restores it without a re-read', async () => {
    const a = await code(() => saveDraft('jed', T1.id, { cards: [] }));
    const g = await getDraft('jed', T1.id);
    return (a === 'MRS_APPT_DRAFT_EXISTS' && g.id === D1.id && g.cards.length === 2 && g.cards[1].reading.appointment.container_no === T1.ctrs[1].container_no) || J({ a, g: g && g.id });
  });
  await check('autosave: a review replaces the card review, version + 1; a stale version → MRS_APPT_DRAFT_STALE; no version = last write wins', async () => {
    const c1 = D1.cards[0].id;
    const r = await saveDraft('jed', T1.id, { batch_id: D1.id, version: 1, cards: [{ card_id: c1, review: { party_type: 'company', party_name: 'Test Haulage Co', notes: 'بوابة 4' } }] });
    const st = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, version: 1, cards: [{ card_id: c1, review: { party_type: 'direct' } }] }));
    const r2 = await saveDraft('jed', T1.id, { batch_id: D1.id, cards: [] });
    return (r.version === 2 && r.cards[0].review.party_name === 'Test Haulage Co' && st === 'MRS_APPT_DRAFT_STALE' && r2.version === 3) || J({ v: r.version, st, v2: r2.version });
  });
  await check('review checks: an unknown key / a bad movement type / a bad uuid → MRS_INVALID review.*; cost in a review by a non-finance role → MRS_FORBIDDEN cost; admin may (and sees it), jed does not see it', async () => {
    const c1 = D1.cards[0].id;
    const a = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: c1, review: { price: 5 } }] }));
    const b = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: c1, review: { movement_type: 'up' } }] }));
    const c = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: c1, review: { container_id: 'x' } }] }));
    const d = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: c1, review: { party_type: 'direct', cost_amount: 300 } }] }));
    const ad = await saveDraft('admin', T1.id, { batch_id: D1.id, cards: [{ card_id: c1, review: { party_type: 'company', party_name: 'Test Haulage Co', cost_amount: 300, sell_amount: 450 } }] });
    const jg = await getDraft('jed', T1.id);
    return (a === 'MRS_INVALID review.price' && b === 'MRS_INVALID review.movement_type' && c === 'MRS_INVALID review.container_id' && d === 'MRS_FORBIDDEN cost'
      && ad.cards[0].review.cost_amount === 300 && !('cost_amount' in jg.cards[0].review) && jg.cards[0].review.party_name === 'Test Haulage Co') || J({ a, b, c, d });
  });
  await check('the same file twice in this batch is kept once; reading / document of another file → MRS_INVALID; a card cannot change its file or reading', async () => {
    const r = await saveDraft('jed', T1.id, { batch_id: D1.id, cards: [cardIn(P1, { source_sha256: S1 })] });
    const ext = await mkExt({ out: P1, tx: T1.id });                   // another hash
    const doc = await mkDoc(T1);
    const a = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [cardIn(P1, { extraction_id: ext })] }));
    const b = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [cardIn(P1, { document_id: doc.id })] }));
    const c = await code(() => saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: r.cards[0].id, reading: {} }] }));
    const e2 = await mkExt({ out: P1, tx: T1.id, sha: S2 });
    const d2 = await mkDoc(T1, { sha: S2 });
    const ok = await saveDraft('jed', T1.id, { batch_id: D1.id, cards: [{ card_id: r.cards[1].id, extraction_id: e2, document_id: d2.id }] });
    return (r.cards.length === 2 && a === 'MRS_INVALID extraction_id' && b === 'MRS_INVALID document_id' && c === 'MRS_IMMUTABLE card'
      && ok.cards[1].extraction_id === e2 && ok.cards[1].document_id === d2.id) || J({ n: r.cards.length, a, b, c });
  });
  await check('limits: 20 live cards (MRS_APPT_DRAFT_LIMIT cards) and 25 MB (MRS_APPT_DRAFT_LIMIT size); a discarded card does not count; nothing written on a refusal', async () => {
    const t = await mkTx({ n: 1 });
    const many = Array.from({ length: 21 }, () => cardIn(P1, { file_size: 1000 }));
    const a = await code(() => saveDraft('jed', t.id, { cards: many }));
    const big = Array.from({ length: 3 }, () => cardIn(P1, { file_size: 9 * 1024 * 1024 }));
    const b = await code(() => saveDraft('jed', t.id, { cards: big }));
    const none = await num(`SELECT count(*) n FROM public.appointment_drafts WHERE transaction_id = $1`, [t.id]);
    const ok = await saveDraft('jed', t.id, { cards: many.slice(0, 20).concat([Object.assign(cardIn(P1, { file_size: 1000 }), { status: 'discarded' })]) });
    const c = await code(() => saveDraft('jed', t.id, { batch_id: ok.id, cards: [{ card_id: ok.cards[20].id, status: 'pending' }] }));
    const fsz = await code(() => saveDraft('jed', t.id, { batch_id: ok.id, cards: [cardIn(P1, { file_size: 11 * 1024 * 1024 })] }));
    return (a === 'MRS_APPT_DRAFT_LIMIT cards' && b === 'MRS_APPT_DRAFT_LIMIT size' && none === 0 && ok.cards.length === 21 && ok.counts.discarded === 1
      && c === 'MRS_APPT_DRAFT_LIMIT cards' && fsz === 'MRS_INVALID file_size') || J({ a, b, none, c, fsz });
  });
  await check('roles / scope: acc (not a transport writer) → MRS_FORBIDDEN role; dmm / staffB / portal → MRS_NOT_FOUND transaction; get by dmm → MRS_NOT_FOUND', async () => {
    const x = [];
    for (const w of ['acc', 'dmm', 'staffB', 'portal']) x.push(await code(() => saveDraft(w, T1.id, { batch_id: D1.id, cards: [] })));
    const g = await code(() => getDraft('dmm', T1.id));
    const acc = await getDraft('acc', T1.id);
    return (x[0] === 'MRS_FORBIDDEN role' && x.slice(1).every(v => v === 'MRS_NOT_FOUND transaction') && g === 'MRS_NOT_FOUND transaction' && acc.id === D1.id && acc.can_edit === false) || J({ x, g });
  });
  await check('cancel: the reason is required; the cards are released (state released) and may be read again in a new batch; a cancelled batch is closed', async () => {
    const t = await mkTx({ n: 1 });
    const s = sha();
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s })] });
    const before = (await fp(s)).state;
    const a = await code(() => cancelDraft('jed', d.id, ' '));
    const c = await cancelDraft('jed', d.id, 'قراءة خاطئة');
    const after = (await fp(s)).state;
    const again = await code(() => cancelDraft('jed', d.id, 'x'));
    const edit = await code(() => saveDraft('jed', t.id, { batch_id: d.id, cards: [] }));
    const d2 = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s })] });
    return (before === 'pending' && a === 'MRS_NOTE_REQUIRED reason' && c.status === 'cancelled' && c.released_cards === 1 && c.cards[0].status === 'cancelled'
      && after === 'released' && again === 'MRS_APPT_DRAFT_CLOSED cancelled' && edit === 'MRS_APPT_DRAFT_CLOSED cancelled' && d2.cards.length === 1) || J({ before, a, after, again, edit });
  });
}

/* ================================================================== 5. approve */
async function secApprove() {
  section('5. approval card by card through save_movement: saved / already existed / skipped / failed, partial, idempotent');
  const t = await mkTx({ n: 3 });
  const cA = cardRead({ ctr: t.ctrs[0].container_no });                       // full exit → saved
  const cE = cardRead({ ctr: t.ctrs[1].container_no, entry: true });          // empty entry → skipped
  const cX = cardRead({ ctr: nextCtr() });                                    // container of no transaction → failed
  const cP = cardRead({ ctr: t.ctrs[2].container_no });                       // no party → failed, then fixed
  const doc = await mkDoc(t, { sha: sha() });
  const ext = await mkExt({ out: cA, tx: t.id, sha: doc.sha });
  let d = await saveDraft('jed', t.id, { cards: [cardIn(cA, { source_sha256: doc.sha, document_id: doc.id, extraction_id: ext,
      review: { party_type: 'company', party_name: 'Test Haulage Co', transport_order_no: 'PO-77', destination: 'مستودع العميل' } }),
    cardIn(cE), cardIn(cX), cardIn(cP, { review: {} })] });
  let R;
  await check('approve: card 1 saved (movement: appointment with booking ref / ticket / zone / barcode / full_exit / file / reading, trip with the party), card 2 skipped (empty entry), cards 3–4 failed (container not in the transaction, no party) → partial', async () => {
    R = await approveDraft('jed', d.id, { version: d.version, idempotencyKey: newKey() });
    const o = R.results.map(x => x.outcome + ':' + (x.code || ''));
    const a = await one(`SELECT a.booking_ref, a.appointment_no, a.operator_ticket_no, a.zone_gate, a.barcode, a.movement_type, a.source_document_id, a.extraction_id,
                                a.container_id, a.status, r.party_type, r.party_name, r.transport_order_no, r.destination, r.notes
                           FROM public.port_appointments a JOIN public.transport_trips r ON r.appointment_id = a.id WHERE a.id = $1`, [R.results[0].appointment_id]);
    const ex = await one(`SELECT review_status FROM public.document_extractions WHERE id = $1`, [ext]);
    const st = (await one(`SELECT operational_status s FROM public.transactions WHERE id = $1`, [t.id])).s;
    return (J(o) === J(['saved:', 'skipped:', 'failed:MRS_APPT_CONTAINER_NOT_IN_TX', 'failed:MRS_APPT_PARTY_REQUIRED']) && R.status === 'partial'
      && R.counts.saved === 1 && R.counts.skipped === 1 && R.counts.failed === 2 && a.booking_ref === cA.appointment.booking_ref && a.appointment_no === cA.appointment.booking_ref
      && a.operator_ticket_no === cA.appointment.operator_ticket_no && a.zone_gate === 'Zone B / Gate 4' && a.movement_type === 'full_exit' && a.source_document_id === doc.id
      && a.extraction_id === ext && a.container_id === t.ctrs[0].id && a.party_type === 'company' && a.party_name === 'Test Haulage Co' && a.transport_order_no === 'PO-77'
      && a.destination === 'مستودع العميل' && /المنطقة\/البوابة: Zone B \/ Gate 4/.test(a.notes) && ex.review_status === 'reviewed' && st === 'transport'
      && R.readiness.pending_count === 3 && R.batch.counts.approved === 1) || J({ o, a, st, ex });
  });
  await check('the idempotent replay returns the same result (replayed), nothing written twice; a reused key with another payload → MRS_IDEMPOTENCY_CONFLICT', async () => {
    const k = newKey();
    const t2 = await mkTx({ n: 1 });
    const d2 = await saveDraft('jed', t2.id, { cards: [cardIn(cardRead({ ctr: t2.ctrs[0].container_no }))] });
    const a = await approveDraft('jed', d2.id, { idempotencyKey: k });
    const b = await approveDraft('jed', d2.id, { idempotencyKey: k });
    const c = await code(() => approveDraft('jed', d2.id, { idempotencyKey: k, version: 99 }));
    const n = await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1`, [t2.id]);
    return (a.status === 'approved' && b.replayed === true && b.results[0].appointment_id === a.results[0].appointment_id && n === 1 && c === 'MRS_IDEMPOTENCY_CONFLICT idempotency_key') || J({ a: a.status, b: b.replayed, c, n });
  });
  await check('a failed card stays editable: fix the review (party; a container of the transaction) and approve the rest → approved; the batch is closed', async () => {
    const cards = R.batch.cards;
    d = await saveDraft('jed', t.id, { batch_id: d.id, cards: [{ card_id: cards[2].id, status: 'discarded' }, { card_id: cards[3].id, review: { party_type: 'direct' } }] });
    const R2 = await approveDraft('jed', d.id, {});
    const tr = await one(`SELECT r.party_type, r.party_name FROM public.transport_trips r WHERE r.appointment_id = $1`, [R2.results[0].appointment_id]);
    return (R2.status === 'approved' && R2.results.length === 1 && R2.results[0].outcome === 'saved' && tr.party_type === 'direct' && tr.party_name === cP.appointment.driver_name
      && R2.batch.closed_at && R2.batch.can_edit === false) || J({ s: R2.status, r: R2.results, tr });
  });
  await check('approved / partial batches can neither be cancelled nor moved (MRS_APPT_DRAFT_APPROVED); an approved one is closed for approve / save (MRS_APPT_DRAFT_CLOSED)', async () => {
    const t3 = await mkTx({ n: 2 });
    const d3 = await saveDraft('jed', t3.id, { cards: [cardIn(cardRead({ ctr: t3.ctrs[0].container_no })), cardIn(cardRead({ ctr: nextCtr() }))] });
    const p = await approveDraft('jed', d3.id, {});
    const a = await code(() => cancelDraft('jed', d3.id, 'x'));
    const b = await code(() => moveDraft('jed', d3.id, T1.ref));
    const c = await code(() => cancelDraft('jed', d.id, 'x'));
    const e = await code(() => approveDraft('jed', d.id, {}));
    const f = await code(() => saveDraft('jed', t.id, { batch_id: d.id, cards: [] }));
    return (p.status === 'partial' && a === 'MRS_APPT_DRAFT_APPROVED' && b === 'MRS_APPT_DRAFT_APPROVED' && c === 'MRS_APPT_DRAFT_APPROVED'
      && e === 'MRS_APPT_DRAFT_CLOSED approved' && f === 'MRS_APPT_DRAFT_CLOSED approved') || J({ a, b, c, e, f });
  });
  await check('already existed: the same slot already saved as a movement (same container, minute, TAS ref) → already_existed, linked to that appointment, no second one', async () => {
    const t4 = await mkTx({ n: 1 });
    const c = cardRead({ ctr: t4.ctrs[0].container_no });
    await rpc('jed', `SELECT public.save_movement($1, NULL) r`, [{ transaction_id: t4.id, container_id: t4.ctrs[0].id, appointment_at: c.appointment.appointment_at,
      appointment_no: c.appointment.booking_ref, driver_name: 'Other Driver', driver_phone: '0' + '512345670', truck_plate: 'XYZ 9' }]);
    const d4 = await saveDraft('jed', t4.id, { cards: [cardIn(c)] });
    const r = await approveDraft('jed', d4.id, {});
    const n = await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1`, [t4.id]);
    const a = await one(`SELECT booking_ref FROM public.port_appointments WHERE transaction_id = $1`, [t4.id]);
    return (r.results[0].outcome === 'already_existed' && r.status === 'approved' && n === 1 && a.booking_ref === c.appointment.booking_ref
      && (await fp(d4.cards[0].source_sha256)).state === 'approved') || J({ r: r.results, n });
  });
  await check('failed without a time / with a phone that is not Saudi: the save_movement refusal is the card result (MRS_REQUIRED appointment_at, MRS_INVALID driver_phone)', async () => {
    const t5 = await mkTx({ n: 2 });
    const d5 = await saveDraft('jed', t5.id, { cards: [cardIn(cardRead({ ctr: t5.ctrs[0].container_no }), { review: { party_type: 'direct', appointment_at: null } }),
      cardIn(cardRead({ ctr: t5.ctrs[1].container_no }), { review: { party_type: 'direct', driver_phone: '12345' } })] });
    const r = await approveDraft('jed', d5.id, {});
    return (J(r.results.map(x => x.code + ' ' + (x.detail || ''))) === J(['MRS_REQUIRED appointment_at', 'MRS_INVALID driver_phone']) && r.status === 'pending'
      && (await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1`, [t5.id])) === 0) || J(r.results);
  });
  await check('approve roles / scope: acc → MRS_FORBIDDEN role; dmm / staffB → MRS_NOT_FOUND appointment_draft', async () => {
    const t6 = await mkTx({ n: 1 });
    const d6 = await saveDraft('jed', t6.id, { cards: [cardIn(cardRead({ ctr: t6.ctrs[0].container_no }))] });
    const x = [];
    for (const w of ['acc', 'dmm', 'staffB']) x.push(await code(() => approveDraft(w, d6.id, {})));
    return J(x) === J(['MRS_FORBIDDEN role', 'MRS_NOT_FOUND appointment_draft', 'MRS_NOT_FOUND appointment_draft']) || J(x);
  });
}

/* ================================================================== 6. re-read rules, move */
async function secReread() {
  section('6. re-read rules (fingerprint across the org) and move by transaction number');
  await check('appointment_card_state: free / pending (same transaction) / pending elsewhere (can_move) / approved; another branch\'s transaction hidden (no ref); > 20 hashes / bad hash refused', async () => {
    const t = await mkTx({ n: 1 }), tOther = await mkTx({ n: 1 }), tDmm = await mkTx({ n: 1, branch: DMM });
    const s1 = sha(), s2 = sha(), s3 = sha(), sFree = sha();
    await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s1 })] });
    await saveDraft('dmm', tDmm.id, { cards: [cardIn(cardRead({ ctr: tDmm.ctrs[0].container_no }), { source_sha256: s3 })] });
    const r = await cardState('jed', tOther.id, [sFree, s1, s3]);
    const r2 = await cardState('jed', t.id, [s1]);
    const big = await code(() => cardState('jed', t.id, Array.from({ length: 21 }, () => sha())));
    const bad = await code(() => cardState('jed', t.id, ['x']));
    const port = await code(() => cardState('portal', null, [s1]));
    void s2;
    return (r[0].state === 'free' && r[1].state === 'pending' && r[1].can_move === true && r[1].ref === t.ref && r[1].same_transaction === false
      && r[2].state === 'pending' && r[2].ref === null && r[2].can_move === false && r2[0].same_transaction === true && r2[0].can_move === false
      && big === 'MRS_APPT_DRAFT_LIMIT cards' && bad === 'MRS_INVALID sha256' && /^MRS_FORBIDDEN/.test(port)) || J({ r, r2, big, bad, port });
  });
  await check('a file pending in another transaction\'s batch → MRS_APPT_CARD_DUPLICATE pending_other; approved anywhere → MRS_APPT_CARD_DUPLICATE approved', async () => {
    const t = await mkTx({ n: 1 }), t2 = await mkTx({ n: 1 });
    const s = sha();
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s })] });
    const a = await code(() => saveDraft('jed', t2.id, { cards: [cardIn(cardRead(), { source_sha256: s })] }));
    await approveDraft('jed', d.id, {});
    const b = await code(() => saveDraft('jed', t2.id, { cards: [cardIn(cardRead(), { source_sha256: s })] }));
    return (a === 'MRS_APPT_CARD_DUPLICATE pending_other' && b === 'MRS_APPT_CARD_DUPLICATE approved') || J({ a, b });
  });
  await check('a cancelled appointment voids the card link → released, the card can be read again; a reschedule keeps the link on the new slot', async () => {
    const t = await mkTx({ n: 2 });
    const s1 = sha(), s2 = sha();
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s1 }),
      cardIn(cardRead({ ctr: t.ctrs[1].container_no }), { source_sha256: s2 })] });
    const r = await approveDraft('jed', d.id, {});
    const a1 = r.results[0].appointment_id, a2 = r.results[1].appointment_id;
    await rpc('jed', `SELECT public.set_appointment_status($1, 'cancelled', 'الموعد ألغي') r`, [a1]);
    const st1 = await fp(s1);
    const card1 = await one(`SELECT link_voided_at IS NOT NULL v, link_void_reason r, status FROM public.appointment_draft_cards WHERE source_sha256 = $1`, [s1]);
    const re = await rpc('jed', `SELECT public.reschedule_appointment($1, $2, 'تأجيل') r`, [a2, { appointment_at: '2026-12-30T10:00:00+03:00' }]);
    const st2 = await fp(s2);
    const t2 = await mkTx({ n: 1 });
    const again = await saveDraft('jed', t2.id, { cards: [cardIn(cardRead({ ctr: t2.ctrs[0].container_no }), { source_sha256: s1 })] });
    return (st1.state === 'released' && card1.v && card1.r === 'appointment_cancelled' && card1.status === 'approved' && st2.state === 'approved'
      && st2.appointment_id === re.appointment.id && again.cards.length === 1) || J({ st1, card1, st2 });
  });
  await check('a cancelled transaction cancels its open batch (cards released); a card approved on a cancelled transaction is released too', async () => {
    const t = await mkTx({ n: 1 });
    const s = sha();
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }), { source_sha256: s })] });
    await rpc('jed', `SELECT public.cancel_transaction($1, 'معاملة مكررة') r`, [t.id]);
    const g = await getDraft('admin', t.id, d.id);
    return (g.status === 'cancelled' && g.close_reason === 'transaction_cancelled' && g.cards[0].status === 'cancelled' && (await fp(s)).state === 'released') || J({ g: g.status, s: await fp(s) });
  });
  await check('move by transaction number: the whole batch goes (moved_from kept, the reviewed container cleared, events on both); unknown / same / other-branch number refused', async () => {
    const t = await mkTx({ n: 1 }), target = await mkTx({ n: 1 }), tDmm = await mkTx({ n: 1, branch: DMM });
    const c = cardRead({ ctr: target.ctrs[0].container_no });
    const d = await saveDraft('jed', t.id, { cards: [cardIn(c, { review: { party_type: 'direct', container_id: t.ctrs[0].id } })] });
    const x = [await code(() => moveDraft('jed', d.id, 'NOPE-1')), await code(() => moveDraft('jed', d.id, t.ref)), await code(() => moveDraft('jed', d.id, tDmm.ref))];
    const m = await moveDraft('jed', d.id, target.ref.toLowerCase(), 'رُفعت على معاملة خاطئة');
    const ev = await q(`SELECT transaction_id, payload ->> 'op' op FROM public.transaction_events WHERE payload ->> 'op' IN ('draft_moved_out','draft_moved_in')
                         AND (transaction_id = $1 OR transaction_id = $2) ORDER BY 2`, [t.id, target.id]);
    const r = await approveDraft('jed', m.id, {});
    return (J(x) === J(['MRS_NOT_FOUND transaction', 'MRS_INVALID same_transaction', 'MRS_NOT_FOUND transaction']) && m.id === d.id && m.transaction_id === target.id
      && m.moved_from_transaction_id === t.id && !('container_id' in m.cards[0].review) && ev.length === 2 && r.results[0].outcome === 'saved'
      && (await getDraft('jed', t.id)) === null) || J({ x, m: m && m.transaction_id, ev, r: r && r.results });
  });
  await check('move into a transaction that already has an open batch: the cards join it (renumbered), this batch closes as moved; over 20 cards → MRS_APPT_DRAFT_LIMIT', async () => {
    const t = await mkTx({ n: 1 }), target = await mkTx({ n: 1 });
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead()), cardIn(cardRead())] });
    const open = await saveDraft('jed', target.id, { cards: [cardIn(cardRead())] });
    const m = await moveDraft('jed', d.id, target.ref);
    const old = await getDraft('jed', t.id, d.id);
    const t2 = await mkTx({ n: 1 }), target2 = await mkTx({ n: 1 });
    const d2 = await saveDraft('jed', t2.id, { cards: Array.from({ length: 2 }, () => cardIn(cardRead())) });
    await saveDraft('jed', target2.id, { cards: Array.from({ length: 19 }, () => cardIn(cardRead(), { file_size: 1000 })) });
    const lim = await code(() => moveDraft('jed', d2.id, target2.ref));
    return (m.id === open.id && m.cards.length === 3 && J(m.cards.map(c => c.seq)) === J([1, 2, 3]) && old.status === 'moved' && old.moved_to_batch_id === open.id
      && lim === 'MRS_APPT_DRAFT_LIMIT cards') || J({ m: m.cards.map(c => c.seq), old: old.status, lim });
  });
}

/* ================================================================== 7. empty-return proofs */
async function secProofs() {
  section('7. empty-return proofs: register (never automatic), verify by staff, void, deadline, list');
  const t = await mkTx({ n: 2, status: 'transport' });
  const c0 = t.ctrs[0], c1 = t.ctrs[1];
  let P, P2, P3;
  await check('create from an EIR reading: pending_review, values from the reading (container matched, Riyadh time, depot, confidence); the container is NOT touched', async () => {
    const doc = await mkDoc(t, { mime: 'image/jpeg' });
    const E = XJS.postProcess(eirOut({ ctr: c0.container_no }), 'empty_return_receipt', 'ai-doc-v3');
    const ext = await mkExt({ out: E, kind: 'empty_return_receipt', sha: doc.sha, tx: t.id });
    P = await createProof('jed', t.id, { document_id: doc.id, extraction_id: ext, idempotencyKey: newKey() });
    const c = await one(`SELECT return_status, evidence_document_id FROM public.containers WHERE id = $1`, [c0.id]);
    return (P.status === 'pending_review' && P.source === 'ai' && P.container_id === c0.id && P.container_matched === true && new Date(P.delivered_at).toISOString() === '2026-11-06T06:15:00.000Z'
      && P.depot === 'Test Empty Depot' && Number(P.confidence) === 0.82 && P.match_notes === null && c.return_status === 'pending' && c.evidence_document_id === null) || J({ P, c });
  });
  await check('browser fix — the same EIR file again (new idempotency key) returns the existing open proof, no duplicate row', async () => {
    const again = await createProof('jed', t.id, { document_id: P.document_id, idempotencyKey: newKey() });
    const n = await one(`SELECT count(*)::int n FROM public.empty_return_proofs WHERE document_id = $1`, [P.document_id]);
    return (again.id === P.id && again.existing === true && n.n === 1) || J({ again, n });
  });
  await check('create: a date without a time → MRS_DATETIME_REQUIRED; a file over 8 MB / not PDF-image → MRS_EMPTY_RETURN_FILE; another transaction\'s document → MRS_INVALID document_id; no document → MRS_REQUIRED', async () => {
    const doc = await mkDoc(t);
    const a = await code(() => createProof('jed', t.id, { document_id: doc.id, container_id: c1.id, delivered_at: '2026-11-06' }));
    const big = await mkDoc(t, { size: 9 * 1024 * 1024 });
    const b = await code(() => createProof('jed', t.id, { document_id: big.id }));
    const txt = await mkDoc(t, { mime: 'text/plain' });
    const c = await code(() => createProof('jed', t.id, { document_id: txt.id }));
    const other = await mkTx({ n: 1 });
    const od = await mkDoc(other);
    const d = await code(() => createProof('jed', t.id, { document_id: od.id }));
    const e = await code(() => createProof('jed', t.id, {}));
    return (a === 'MRS_DATETIME_REQUIRED delivered_at' && b === 'MRS_EMPTY_RETURN_FILE size' && c === 'MRS_EMPTY_RETURN_FILE type' && d === 'MRS_INVALID document_id' && e === 'MRS_REQUIRED document_id') || J({ a, b, c, d, e });
  });
  await check('create manually with what is known: a container number not on the transaction / no time / no depot → match notes, container_id null; unreadable flag → unreadable', async () => {
    const doc = await mkDoc(t);
    const x = await createProof('jed', t.id, { document_id: doc.id, container_no: nextCtr() });
    const doc2 = await mkDoc(t);
    const u = await createProof('jed', t.id, { document_id: doc2.id, unreadable: true, source: 'ai' });
    return (x.status === 'pending_review' && x.container_id === null && /container_not_in_transaction/.test(x.match_notes) && /delivery_time_missing/.test(x.match_notes)
      && /depot_missing/.test(x.match_notes) && u.status === 'unreadable' && /container_not_read/.test(u.match_notes)) || J({ x, u });
  });
  await check('verify (staff): needs container + date AND time + depot; writes the container return through the evidence path (returned_verified, the document confirmed as an empty return receipt, returned_at = the delivery time, the verifier); lifecycle → empty_return', async () => {
    const doc = await mkDoc(t);
    P2 = await createProof('jed', t.id, { document_id: doc.id, container_id: c1.id });
    const a = await code(() => verifyProof('jed', P2.id, {}));
    const b = await code(() => verifyProof('jed', P2.id, { delivered_at: '2026-11-07' }));
    const c = await code(() => verifyProof('jed', P2.id, { delivered_at: '2026-11-07 10:00' }));
    const v = await verifyProof('trn', P.id, { idempotencyKey: newKey() });
    const k = await one(`SELECT c.return_status, c.evidence_document_id, c.returned_at, c.verified_by, c.operational_state, d.classification, d.classification_status
                           FROM public.containers c JOIN public.documents d ON d.id = c.evidence_document_id WHERE c.id = $1`, [c0.id]);
    const st = (await one(`SELECT operational_status s FROM public.transactions WHERE id = $1`, [t.id])).s;
    return (a === 'MRS_DATETIME_REQUIRED delivered_at' && b === 'MRS_DATETIME_REQUIRED delivered_at' && c === 'MRS_REQUIRED depot' && v.status === 'approved' && v.verified_by === U.trn
      && k.return_status === 'returned_verified' && k.evidence_document_id === P.document_id && new Date(k.returned_at).toISOString() === '2026-11-06T06:15:00.000Z'
      && k.verified_by === U.trn && k.operational_state === 'empty_returned' && k.classification === 'empty_return_receipt' && k.classification_status === 'confirmed'
      && st === 'empty_return' && v.readiness.pending_count === 1 && v.container_already_returned === false) || J({ a, b, c, k, st });
  });
  await check('verify again → MRS_EMPTY_RETURN_CLOSED approved; a second proof of a returned container is approved without touching the container (container_already_returned)', async () => {
    const again = await code(() => verifyProof('jed', P.id, {}));
    const doc = await mkDoc(t);
    P3 = await createProof('jed', t.id, { document_id: doc.id, container_id: c0.id, delivered_at: '2026-11-06T10:00:00+03:00', depot: 'Depot 2' });
    const v = await verifyProof('jed', P3.id, {});
    const k = await one(`SELECT evidence_document_id FROM public.containers WHERE id = $1`, [c0.id]);
    return (again === 'MRS_EMPTY_RETURN_CLOSED approved' && v.status === 'approved' && v.container_already_returned === true && k.evidence_document_id === P.document_id) || J({ again, v: v.container_already_returned });
  });
  await check('void (soft): reason required; the approved proof the return rests on → the other approved proof takes over (document / time); the last one → the container return reverted (pending)', async () => {
    const a = await code(() => voidProof('jed', P.id, ''));
    const v1 = await voidProof('jed', P.id, 'إثبات مكرر');
    const k1 = await one(`SELECT return_status, evidence_document_id, returned_at FROM public.containers WHERE id = $1`, [c0.id]);
    const v2 = await voidProof('jed', P3.id, 'خطأ في الحاوية');
    const k2 = await one(`SELECT return_status, evidence_document_id, returned_at, operational_state, verified_by FROM public.containers WHERE id = $1`, [c0.id]);
    const again = await code(() => voidProof('jed', P3.id, 'x'));
    const frozen = await code(() => q(`UPDATE public.empty_return_proofs SET depot = 'x' WHERE id = $1`, [P3.id]));
    return (a === 'MRS_NOTE_REQUIRED reason' && v1.status === 'voided' && v1.container_reverted === false && v1.replaced_by_proof_id === P3.id && k1.return_status === 'returned_verified'
      && k1.evidence_document_id === P3.document_id && v2.container_reverted === true && k2.return_status === 'pending' && k2.evidence_document_id === null && k2.returned_at === null
      && k2.verified_by === null && k2.operational_state !== 'empty_returned' && again === 'MRS_EMPTY_RETURN_CLOSED voided' && /MRS_IMMUTABLE/.test(frozen)) || J({ a, v1, k1, v2: v2.container_reverted, k2, again });
  });
  await check('void after operational completion: reverting the return is refused (MRS_EMPTY_RETURN_LOCKED); a pending proof can still be voided', async () => {
    const t2 = await mkTx({ n: 1, status: 'transport' });
    const doc = await mkDoc(t2);
    const p = await createProof('jed', t2.id, { document_id: doc.id, container_id: t2.ctrs[0].id, delivered_at: '2026-11-06 08:00', depot: 'D' });
    await verifyProof('jed', p.id, {});
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [t2.id]);
    const a = await code(() => voidProof('jed', p.id, 'x'));
    const doc2 = await mkDoc(t2);
    const p2 = await createProof('jed', t2.id, { document_id: doc2.id });
    const b = await voidProof('jed', p2.id, 'لا يخص الحاوية');
    return (a === 'MRS_EMPTY_RETURN_LOCKED operationally_complete' && b.status === 'voided') || J({ a, b: b.status });
  });
  await check('deadline-only save through set_container_return (return plan event); NULL clears; a returned container → MRS_BAD_TRANSITION; dmm → MRS_NOT_FOUND', async () => {
    const t3 = await mkTx({ n: 1 });
    const a = await rpc('jed', `SELECT public.save_empty_return_deadline($1, $2) r`, [t3.ctrs[0].id, '2026-11-30']);
    const b = await rpc('jed', `SELECT public.save_empty_return_deadline($1, NULL) r`, [t3.ctrs[0].id]);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'return_plan'`, [t3.id]);
    const c = await code(() => rpc('dmm', `SELECT public.save_empty_return_deadline($1, $2) r`, [t3.ctrs[0].id, '2026-11-30']));
    const d = await code(() => rpc('jed', `SELECT public.save_empty_return_deadline($1, $2) r`, [c1.id, '2026-11-30']));
    await q(`UPDATE public.containers SET return_status = 'waived', waiver_reason = 'test' WHERE id = $1`, [t3.ctrs[0].id]);
    const e = await code(() => rpc('jed', `SELECT public.save_empty_return_deadline($1, $2) r`, [t3.ctrs[0].id, '2026-11-30']));
    return (a.return_deadline === '2026-11-30' && b.return_deadline === null && ev === 2 && c === 'MRS_NOT_FOUND' && d === 'ok' && e === 'MRS_BAD_TRANSITION waived') || J({ a: a.return_deadline, b: b.return_deadline, ev, c, d, e });
  });
  await check('list_empty_return_proofs: every proof of the transaction (voided included), newest first, + the readiness; dmm / portal → MRS_NOT_FOUND transaction', async () => {
    const l = await rpc('jed', `SELECT public.list_empty_return_proofs($1) r`, [t.id]);
    const x = [await code(() => rpc('dmm', `SELECT public.list_empty_return_proofs($1) r`, [t.id])), await code(() => rpc('portal', `SELECT public.list_empty_return_proofs($1) r`, [t.id]))];
    return (l.proofs.length >= 5 && l.proofs.some(p => p.status === 'voided') && l.readiness.transaction_id === t.id && x.every(v => v === 'MRS_NOT_FOUND transaction')) || J({ n: l.proofs.length, x });
  });
  await check('proof roles: acc (not a transport writer) cannot create / verify / void (MRS_FORBIDDEN role)', async () => {
    const doc = await mkDoc(t);
    const p = await createProof('jed', t.id, { document_id: doc.id });
    const x = [await code(() => createProof('acc', t.id, { document_id: doc.id })), await code(() => verifyProof('acc', p.id, {})), await code(() => voidProof('acc', p.id, 'x'))];
    return x.every(v => v === 'MRS_FORBIDDEN role') || J(x);
  });
}

/* ================================================================== 8. TASTO, readiness */
async function secTasto() {
  section('8. TASTO carrier order (no bypass of the empty-return proof) and tx_readiness');
  const t = await mkTx({ n: 1, status: 'transport' });
  let R;
  await check('format / stage / required: TASTO + digits only (MRS_TASTO_INVALID), not from new / in_progress (MRS_TASTO_STAGE), order date and company required', async () => {
    const tNew = await mkTx({ n: 1, status: 'in_progress' });
    const x = [await code(() => tasto('jed', t.id, { order_no: 'TAS123', order_date: '2026-11-10', company_name: 'Test Carrier Co' })),
      await code(() => tasto('jed', t.id, { order_no: 'TASTO12A', order_date: '2026-11-10', company_name: 'Test Carrier Co' })),
      await code(() => tasto('jed', tNew.id, { order_no: 'TASTO1', order_date: '2026-11-10', company_name: 'Test Carrier Co' })),
      await code(() => tasto('jed', t.id, { order_no: 'TASTO1', company_name: 'Test Carrier Co' })),
      await code(() => tasto('jed', t.id, { order_no: 'TASTO1', order_date: '2026-11-10' }))];
    return J(x) === J(['MRS_TASTO_INVALID order_no', 'MRS_TASTO_INVALID order_no', 'MRS_TASTO_STAGE in_progress', 'MRS_REQUIRED order_date', 'MRS_REQUIRED company_name']) || J(x);
  });
  await check('saved: carrier_order + the company (a new carrier party) + number (normalised) + date; an internal note event; the stage is NOT moved; readiness still blocked', async () => {
    R = await tasto('jed', t.id, { order_no: 'tasto 2026 1110 0001', order_date: '2026-11-10', company_name: 'Test Carrier Co', idempotencyKey: newKey() });
    const tx = await one(`SELECT transport_mode, transport_order_no, transport_order_date::text d, operational_status, transport_party_id FROM public.transactions WHERE id = $1`, [t.id]);
    const ev = await one(`SELECT note, visible_to_client v, payload FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'carrier_order'`, [t.id]);
    const pa = await one(`SELECT kinds FROM public.parties WHERE id = $1`, [tx.transport_party_id]);
    return (R.order_no === 'TASTO202611100001' && tx.transport_mode === 'carrier_order' && tx.transport_order_no === 'TASTO202611100001'
      && tx.d === '2026-11-10' && tx.operational_status === 'transport' && R.party_created === true && R.already_exists === false && J(pa.kinds) === J(['carrier'])
      && /^تسجيل أمر نقل شركة: Test Carrier Co — TASTO202611100001 — 2026-11-10$/.test(ev.note) && ev.v === false && ev.payload.bypasses_empty_return === false
      && R.readiness.billing_gate_open === false && R.readiness.carrier_order.bypasses_empty_return === false) || J({ R, tx, ev });
  });
  await check('idempotent: the same order again → already_exists, no second event; another number → edited (تعديل) event; the number of another live transaction → MRS_TASTO_TAKEN <ref>', async () => {
    const a = await tasto('jed', t.id, { order_no: 'TASTO202611100001', order_date: '2026-11-10', party_id: R.party_id });
    const n1 = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'carrier_order'`, [t.id]);
    const t2 = await mkTx({ n: 1, status: 'transport' });
    const b = await code(() => tasto('jed', t2.id, { order_no: 'TASTO202611100001', order_date: '2026-11-10', party_id: R.party_id }));
    const c = await tasto('jed', t.id, { order_no: 'TASTO202611100002', order_date: '2026-11-11', party_id: R.party_id });
    const ev = await q(`SELECT note FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'carrier_order' ORDER BY created_at`, [t.id]);
    return (a.already_exists === true && n1 === 1 && b === 'MRS_TASTO_TAKEN ' + t.ref && c.already_exists === false && ev.length === 2 && /^تعديل أمر نقل شركة/.test(ev[1].note)) || J({ a: a.already_exists, n1, b, ev });
  });
  await check('a party that is not a carrier → MRS_INVALID; roles: acc → MRS_FORBIDDEN role; dmm → MRS_NOT_FOUND transaction', async () => {
    const pid = (await q(`INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['yard'], 'ساحة اختبار للتسليم') RETURNING id`, [A]))[0].id;
    const t3 = await mkTx({ n: 1, status: 'transport' });
    const x = [await code(() => tasto('jed', t3.id, { order_no: 'TASTO9', order_date: '2026-11-10', party_id: pid })),
      await code(() => tasto('jed', t3.id, { order_no: 'TASTO9', order_date: '2026-11-10', company_name: 'ساحة اختبار للتسليم' })),
      await code(() => tasto('acc', t3.id, { order_no: 'TASTO9', order_date: '2026-11-10', party_id: R.party_id })),
      await code(() => tasto('dmm', t3.id, { order_no: 'TASTO9', order_date: '2026-11-10', party_id: R.party_id }))];
    return J(x) === J(['MRS_INVALID party_id', 'MRS_INVALID company_name', 'MRS_FORBIDDEN role', 'MRS_NOT_FOUND transaction']) || J(x);
  });
  await check('OWNER DECISION: the TASTO order does not bypass the gate — set_transaction_status under_billing → MRS_CONTAINERS_NOT_RETURNED until the carrier\'s EIR is verified; then readiness opens', async () => {
    const a = await code(() => rpc('admin', `SELECT public.set_transaction_status($1, 'under_billing', 'فوترة') r`, [t.id]));
    const doc = await mkDoc(t);
    const p = await createProof('jed', t.id, { document_id: doc.id, container_id: t.ctrs[0].id, delivered_at: '2026-11-06 08:00', depot: 'Carrier depot' });
    const before = await readiness('jed', t.id);
    await verifyProof('jed', p.id, {});
    const after = await readiness('jed', t.id);
    return (a === 'MRS_CONTAINERS_NOT_RETURNED 1' && before.billing_gate_open === false && before.blocking === 'containers_not_returned'
      && before.pending_containers[0].proofs_pending === 1 && after.billing_gate_open === true && after.blocking === null && after.pending_count === 0) || J({ a, before, after });
  });
  await check('tx_readiness: policy {empty_return_blocks_billing: true, switchable: false}; declared containers not registered count (declared_missing); overdue deadline flagged; staff only', async () => {
    const t4 = await mkTx({ n: 1, count: 3 });
    await q(`UPDATE public.containers SET return_deadline = current_date - 2 WHERE id = $1`, [t4.ctrs[0].id]);
    const r = await readiness('jed', t4.id);
    const x = [await code(() => readiness('dmm', t4.id)), await code(() => readiness('portal', t4.id)), await code(() => readiness('staffB', t4.id))];
    return (r.policy.empty_return_blocks_billing === true && r.policy.switchable === false && r.declared_missing === 2 && r.pending_count === 1 && r.pending_containers[0].overdue === true
      && r.billing_gate_open === false && r.carrier_order === null && x.every(v => v === 'MRS_NOT_FOUND transaction')) || J({ r, x });
  });
}

/* ================================================================== 8b. review fixes (regressions) */
async function secFixes() {
  section('8b. review fixes: cost kept on autosave, extraction scope, unknown movement type, TASTO stage, operator / notes, move files, re-read');
  await check('a non-finance autosave keeps the cost / sell a trip-finance user entered (amounts_hidden for jed); jed cannot approve that card (MRS_FORBIDDEN cost), admin can (trip cost / sell saved)', async () => {
    const t = await mkTx({ n: 1 });
    const d = await saveDraft('jed', t.id, { cards: [cardIn(cardRead({ ctr: t.ctrs[0].container_no }))] });
    const c1 = d.cards[0].id;
    await saveDraft('admin', t.id, { batch_id: d.id, cards: [{ card_id: c1, review: { party_type: 'direct', cost_amount: 300, sell_amount: 450 } }] });
    const jg = await getDraft('jed', t.id);
    await saveDraft('jed', t.id, { batch_id: d.id, version: jg.version, cards: [{ card_id: c1, review: Object.assign({}, jg.cards[0].review, { notes: 'x' }) }] });
    const stored = (await one(`SELECT review FROM public.appointment_draft_cards WHERE id = $1`, [c1])).review;
    const ag = await getDraft('admin', t.id), jg2 = await getDraft('jed', t.id);
    const rj = await approveDraft('jed', d.id, {});
    const ra = await approveDraft('admin', d.id, {});
    const trip = await one(`SELECT cost_amount::float8 c, sell_amount::float8 s FROM public.transport_trips WHERE id = $1`, [ra.results[0] && ra.results[0].trip_id]);
    return (stored.cost_amount === 300 && stored.sell_amount === 450 && stored.notes === 'x' && jg.cards[0].amounts_hidden === true
      && !('cost_amount' in jg2.cards[0].review) && jg2.cards[0].review.notes === 'x' && ag.cards[0].amounts_hidden === false && ag.cards[0].review.cost_amount === 300
      && rj.results[0].outcome === 'failed' && rj.results[0].code === 'MRS_FORBIDDEN' && ra.results[0].outcome === 'saved' && trip && trip.c === 300 && trip.s === 450)
      || J({ stored, h: jg.cards[0].amounts_hidden, rj: rj.results, ra: ra.results, trip });
  });
  await check('a reading of another transaction (another branch) → MRS_INVALID extraction_id; a card linked to one anyway is approved without marking / linking that reading', async () => {
    const tDmm = await mkTx({ n: 1, branch: DMM }), t = await mkTx({ n: 1 });
    const P = cardRead({ ctr: t.ctrs[0].container_no }), s = sha();
    const ext = await mkExt({ out: P, tx: tDmm.id, sha: s, by: 'dmm' });
    const vis = (await as('jed', `SELECT count(*)::int n FROM public.document_extractions WHERE id = $1`, [ext]))[0].n;
    const x = await code(() => saveDraft('jed', t.id, { cards: [cardIn(P, { source_sha256: s, extraction_id: ext })] }));
    const d = await saveDraft('jed', t.id, { cards: [cardIn(P, { source_sha256: s })] });
    await q(`UPDATE public.appointment_draft_cards SET extraction_id = $2 WHERE id = $1`, [d.cards[0].id, ext]);
    const r = await approveDraft('jed', d.id, {});
    const e = await one(`SELECT review_status FROM public.document_extractions WHERE id = $1`, [ext]);
    const a = await one(`SELECT extraction_id FROM public.port_appointments WHERE id = $1`, [r.results[0].appointment_id]);
    return (vis === 0 && x === 'MRS_INVALID extraction_id' && r.results[0].outcome === 'saved' && e.review_status === 'unreviewed' && a.extraction_id === null)
      || J({ vis, x, r: r.results, e, a });
  });
  await check('a card with an unknown movement type (empty Entry / Exit sections) fails with MRS_REQUIRED movement_type and stays editable; reviewed as full_exit it is saved; the batch closes only then', async () => {
    const t = await mkTx({ n: 1 });
    const out = cardOut({ ctr: t.ctrs[0].container_no }); out.exit = SEC0; out.entry = SEC0;
    const P = XJS.postProcess(out, 'appointment_ticket', 'ai-doc-v3');
    const d = await saveDraft('jed', t.id, { cards: [cardIn(P)] });
    const r1 = await approveDraft('jed', d.id, {});
    const g = await getDraft('jed', t.id);
    await saveDraft('jed', t.id, { batch_id: d.id, cards: [{ card_id: d.cards[0].id, review: { party_type: 'direct', movement_type: 'full_exit', container_id: t.ctrs[0].id } }] });
    const r2 = await approveDraft('jed', d.id, {});
    return (!P.rejected && P.appointment.movement_type === null && r1.results[0].outcome === 'failed' && r1.results[0].code === 'MRS_REQUIRED'
      && r1.results[0].detail === 'movement_type' && r1.status === 'pending' && g && g.cards[0].status === 'failed' && r2.results[0].outcome === 'saved' && r2.status === 'approved')
      || J({ rj: P.rejected, mt: P.appointment.movement_type, r1: r1.results, s1: r1.status, r2: r2.results, s2: r2.status });
  });
  await check('TASTO: refused at customs_declaration too (legacy «نشطة»: before the customs release) → MRS_TASTO_STAGE; allowed from the appointment stage', async () => {
    const t1 = await mkTx({ n: 1, status: 'customs_declaration' }), t2 = await mkTx({ n: 1, status: 'appointment' });
    const a = await code(() => tasto('jed', t1.id, { order_no: 'TASTO7001', order_date: '2026-11-10', company_name: 'Test Carrier Co' }));
    const b = await tasto('jed', t2.id, { order_no: 'TASTO7002', order_date: '2026-11-10', company_name: 'Test Carrier Co' });
    return (a === 'MRS_TASTO_STAGE customs_declaration' && b.order_no === 'TASTO7002') || J({ a, b });
  });
  await check('the card reads gate instructions / driver licence / vehicle ref + serial IDs (a vehicle ID alone is an operational signal); approval saves the operator, merges them into the notes; list_movements shows the card and party fields', async () => {
    const t = await mkTx({ n: 1 });
    const out = cardOut({ ctr: t.ctrs[0].container_no });
    out.fields.push({ name: 'appointment_gate_instructions', value: 'Enter by gate 4 only', confidence: 0.9, page: null },
      { name: 'driver_license', value: 'lic 778', confidence: 0.9, page: null }, { name: 'vehicle_ref_id', value: 'VR-11', confidence: 0.9, page: null },
      { name: 'vehicle_serial_id', value: 'SN 22', confidence: 0.9, page: null });
    const P = XJS.postProcess(out, 'appointment_ticket', 'ai-doc-v3');
    const only = cardOut(); only.exit = SEC0; only.fields = only.fields.filter(f => ['appointment_booking_ref', 'appointment_at'].includes(f.name))
      .concat([{ name: 'vehicle_ref_id', value: 'VR-12', confidence: 0.9, page: null }]);
    const P2 = XJS.postProcess(only, 'appointment_ticket', 'ai-doc-v3');
    const ext = await mkExt({ out: P, tx: t.id });
    const d = await saveDraft('jed', t.id, { cards: [cardIn(P, { review: { party_type: 'company', party_name: 'Test Haulage Co', transport_order_no: 'PO-9' } })] });
    const r = await approveDraft('jed', d.id, {});
    const a = await one(`SELECT a.operator_name, r.notes FROM public.port_appointments a JOIN public.transport_trips r ON r.appointment_id = a.id WHERE a.id = $1`, [r.results[0].appointment_id]);
    const mv = (await rpc('jed', `SELECT public.list_movements($1) r`, [t.id]))[0];
    return (P.appointment.gate_instructions === 'Enter by gate 4 only' && P.appointment.driver_license === 'LIC778' && P.appointment.vehicle_ref_id === 'VR-11'
      && P.appointment.vehicle_serial_id === 'SN22' && !!ext && !P2.rejected && P2.appointment.structural.ok === true && a.operator_name === 'Test Terminal Operator'
      && /تعليمات البوابة: Enter by gate 4 only/.test(a.notes) && /رخصة السائق: LIC778/.test(a.notes) && /مرجع المركبة: VR-11/.test(a.notes)
      && /الرقم التسلسلي للمركبة: SN22/.test(a.notes) && mv.booking_ref === P.appointment.booking_ref && mv.operator_name === 'Test Terminal Operator'
      && mv.movement_type === 'full_exit' && mv.party_type === 'company' && mv.party_name === 'Test Haulage Co' && mv.transport_order_no === 'PO-9' && 'zone_gate' in mv)
      || J({ ap: P.appointment, rj: P2.rejected, st: P2.appointment && P2.appointment.structural, a, mv });
  });
  await check('move: a card file stays on the transaction it was read on (storage path bound to it); approval on the target still links that file and reading (origin); the same file already on the target → the card points at that document', async () => {
    const t = await mkTx({ n: 1 }), target = await mkTx({ n: 1 });
    const P = cardRead({ ctr: target.ctrs[0].container_no });
    const doc = await mkDoc(t, { kind: 'appointment' });
    const ext = await mkExt({ out: P, tx: t.id, sha: doc.sha });
    const d = await saveDraft('jed', t.id, { cards: [cardIn(P, { source_sha256: doc.sha, document_id: doc.id, extraction_id: ext })] });
    const m = await moveDraft('jed', d.id, target.ref);
    const dt = await one(`SELECT transaction_id FROM public.documents WHERE id = $1`, [doc.id]);
    const r = await approveDraft('jed', m.id, {});
    const a = await one(`SELECT source_document_id, extraction_id FROM public.port_appointments WHERE id = $1`, [r.results[0].appointment_id]);
    const er = await one(`SELECT review_status FROM public.document_extractions WHERE id = $1`, [ext]);
    const t2 = await mkTx({ n: 1 }), target2 = await mkTx({ n: 1 });
    const doc2 = await mkDoc(t2, { kind: 'appointment' }), same = await mkDoc(target2, { sha: doc2.sha, kind: 'appointment' });
    const d2 = await saveDraft('jed', t2.id, { cards: [cardIn(cardRead({ ctr: target2.ctrs[0].container_no }), { source_sha256: doc2.sha, document_id: doc2.id })] });
    const m2 = await moveDraft('jed', d2.id, target2.ref);
    const imm = await code(() => q(`UPDATE public.appointment_draft_cards SET origin_transaction_id = $2 WHERE id = $1`, [m2.cards[0].id, target2.id]));
    return (dt.transaction_id === t.id && m.cards[0].origin_transaction_id === t.id && r.results[0].outcome === 'saved' && a.source_document_id === doc.id
      && a.extraction_id === ext && er.review_status === 'reviewed' && m2.cards[0].document_id === same.id && /MRS_IMMUTABLE/.test(imm))
      || J({ dt, o: m.cards[0].origin_transaction_id, r: r.results, a, er, m2: m2.cards[0].document_id, imm });
  });
  await check('re-read: a file released by a cancelled appointment can be read again into the same partial batch, and a draft holding it merges into that batch (no raw unique error); a discarded card there gives way', async () => {
    const t1 = await mkTx({ n: 2 }), sA = sha();
    const d1 = await saveDraft('jed', t1.id, { cards: [cardIn(cardRead({ ctr: t1.ctrs[0].container_no }), { source_sha256: sA }), cardIn(cardRead({ ctr: t1.ctrs[1].container_no }), { review: {} })] });
    const r1 = await approveDraft('jed', d1.id, {});
    await rpc('jed', `SELECT public.set_appointment_status($1, 'cancelled', 'الموعد ألغي') r`, [r1.results[0].appointment_id]);
    const t2 = await mkTx({ n: 1 });
    const d2 = await saveDraft('jed', t2.id, { cards: [cardIn(cardRead({ ctr: t1.ctrs[0].container_no }), { source_sha256: sA })] });
    const m = await moveDraft('jed', d2.id, t1.ref);
    const live = m.cards.filter(c => c.source_sha256 === sA).map(c => c.status).sort();
    // the same in one batch: a second partial batch, its released file read again into it
    const t3 = await mkTx({ n: 2 }), sB = sha();
    const d3 = await saveDraft('jed', t3.id, { cards: [cardIn(cardRead({ ctr: t3.ctrs[0].container_no }), { source_sha256: sB }), cardIn(cardRead({ ctr: t3.ctrs[1].container_no }), { review: {} })] });
    const r3 = await approveDraft('jed', d3.id, {});
    await rpc('jed', `SELECT public.set_appointment_status($1, 'cancelled', 'الموعد ألغي') r`, [r3.results[0].appointment_id]);
    const again = await saveDraft('jed', t3.id, { batch_id: d3.id, cards: [cardIn(cardRead({ ctr: t3.ctrs[0].container_no }), { source_sha256: sB })] });
    // a discarded card of the target gives way to the moved one
    const t4 = await mkTx({ n: 1 }), t5 = await mkTx({ n: 1 }), sC = sha();
    const d4 = await saveDraft('jed', t4.id, { cards: [cardIn(cardRead(), { source_sha256: sC, status: 'discarded' })] });
    const d5 = await saveDraft('jed', t5.id, { cards: [cardIn(cardRead(), { source_sha256: sC })] });
    const m5 = await moveDraft('jed', d5.id, t4.ref);
    const c5 = m5.cards.filter(c => c.source_sha256 === sC).map(c => c.status).sort();
    return (r1.status === 'partial' && m.id === d1.id && J(live) === J(['approved', 'pending']) && again.cards.filter(c => c.source_sha256 === sB).length === 2
      && m5.id === d4.id && J(c5) === J(['cancelled', 'pending'])) || J({ s: r1.status, live, again: again.cards.map(c => c.status), c5 });
  });
}

/* ================================================================== 9. RLS, privileges, conversion */
async function secRls() {
  section('9. RLS on the new tables, column grants, branch scoping, function privileges, conversion lists, audit');
  const T = ['appointment_drafts', 'appointment_draft_cards', 'empty_return_proofs'];
  await check('RLS enabled on the 3 tables; SELECT for authenticated (cards by column, without review); nothing for anon', async () => {
    const r = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY ($1) AND relnamespace = 'public'::regnamespace`, [T]);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name = ANY ($1) AND grantee IN ('anon','authenticated')`, [T]);
    const cols = (await q(`SELECT column_name c FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'appointment_draft_cards'
                            AND grantee = 'authenticated' AND privilege_type = 'SELECT'`)).map(x => x.c);
    return (r.length === 3 && r.every(x => x.relrowsecurity) && g.length === 2 && g.every(x => x.grantee === 'authenticated' && x.privilege_type === 'SELECT')
      && !cols.includes('review') && ['id', 'batch_id', 'source_sha256', 'status', 'reading'].every(c => cols.includes(c))) || J({ r, g, cols });
  });
  await check('direct writes are refused (permission denied) for an admin on the 3 tables; owner DELETE → MRS_APPEND_ONLY', async () => {
    const r = [];
    for (const t of T) {
      r.push(await code(() => as('admin', `UPDATE public.${t} SET org_id = org_id`)));
      r.push(await code(() => as('admin', `DELETE FROM public.${t}`)));
    }
    r.push(await code(() => as('admin', `SELECT review FROM public.appointment_draft_cards LIMIT 1`)));
    const del = await code(() => q(`DELETE FROM public.empty_return_proofs WHERE org_id = $1`, [A]));
    return (r.every(x => x === 'perm') && /MRS_APPEND_ONLY/.test(del)) || J({ r, del });
  });
  await check('SELECT: jed sees the JED rows; dmm none of them; staffB / portal nothing of A; anon permission denied', async () => {
    const cnt = async (who, t) => Number((await as(who, `SELECT count(*) n FROM public.${t}`))[0].n);
    const jed = await cnt('jed', 'appointment_drafts');
    const allJed = await num(`SELECT count(*) n FROM public.appointment_drafts d JOIN public.transactions t ON t.id = d.transaction_id WHERE t.branch_id = $1`, [JED]);
    const dmmProofs = await cnt('dmm', 'empty_return_proofs');
    const jedCards = await cnt('jed', 'appointment_draft_cards').catch(() => -1);
    const others = [];
    for (const t of T) { others.push(await cnt('staffB', t).catch(() => -2)); others.push(await cnt('portal', t).catch(() => -2)); }
    const an = await code(() => as('anon', `SELECT 1 FROM public.empty_return_proofs`));
    return (jed === allJed && jed > 0 && dmmProofs === 0 && others.every(x => x === 0 || x === -2) && an === 'perm' && jedCards !== 0) || J({ jed, allJed, dmmProofs, others, an, jedCards });
  });
  await check('function privileges: the 13 RPCs executable by authenticated only; internal helpers / triggers by nobody; the policy flag not by anon', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const h = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                         AND p.proname IN ('appt_ts','appt_review_check','appt_card_val','appointment_fingerprint_state','appt_card_json','appt_draft_json',
                                           'appt_draft_lock','appt_card_approve','erp_json','tx_readiness_of','tg_appointments_card_link',
                                           'tg_transactions_appt_drafts','tg_legacy_appt_guard')
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))`);
    const f = await one(`SELECT has_function_privilege('anon', 'app.empty_return_blocks_billing(uuid)', 'EXECUTE') a`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && h.length === 0 && f.a === false) || J({ r, h, f });
  });
  await check('conversion lists: the 3 tables in app.convert_delete_tables (83 with the 4 tables of 20261122000100 and the 5 of 20261123000100), their no-delete guards in app.convert_delete_guards (44), every table classified', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const g = (await one(`SELECT app.convert_delete_guards() g`)).g;
    const keep = (await one(`SELECT app.convert_keep_tables() k`)).k;
    const all = (await q(`SELECT 'public.' || relname n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).map(x => x.n);
    const un = all.filter(x => !t.includes(x) && !keep.includes(x) && !['public.status_labels', 'public.schema_versions', 'public.organizations',
      'public.profiles', 'public.platform_admins', 'public.plans', 'public.customs_ports', 'public.daftra_mock_accounts'].includes(x));
    return (T.every(x => t.includes('public.' + x) && g.includes('public.' + x + ':trg_no_delete')) && g.length === 44 && t.length === 83 + 2 + 1 /* + legacy_import_rows, legacy_import_runs (20261125000100), return_extension_requests (20261128000100) */ && un.length === 0
      && t.indexOf('public.appointment_drafts') > t.indexOf('public.port_appointments')) || J({ g: g.length, t: t.length, un });
  });
  await check('the trail: drafts / cards / proofs are audited without the document content (reading, review, result, depot, notes)', async () => {
    const r = await q(`SELECT table_name, new_data FROM public.audit_log WHERE table_name IN ('appointment_drafts','appointment_draft_cards','empty_return_proofs') LIMIT 200`);
    const tables = [...new Set(r.map(x => x.table_name))].sort();
    return (J(tables) === J(T.slice().sort()) && r.every(x => !['reading', 'review', 'result', 'depot', 'match_notes', 'note', 'file_name'].some(k => k in (x.new_data || {})))) || J(tables);
  });
}

/* ================================================================== 10. front end (static) */
async function secStatic() {
  section('10. supa.js wrappers, i18n');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name; the approvals / proofs / TASTO through the idempotent path', () => {
    const W = { appointmentCardState: 'appointment_card_state', saveAppointmentDraft: 'save_appointment_draft', getAppointmentDraft: 'get_appointment_draft',
      cancelAppointmentDraft: 'cancel_appointment_draft', moveAppointmentDraft: 'move_appointment_draft', approveAppointmentDraft: 'approve_appointment_draft',
      createEmptyReturnProof: 'create_empty_return_proof', verifyEmptyReturnProof: 'verify_empty_return_proof', voidEmptyReturnProof: 'void_empty_return_proof',
      saveEmptyReturnDeadline: 'save_empty_return_deadline', listEmptyReturnProofs: 'list_empty_return_proofs', saveTransportCarrierOrder: 'save_transport_carrier_order',
      txReadiness: 'tx_readiness' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    const idem = ['approve_appointment_draft', 'create_empty_return_proof', 'verify_empty_return_proof', 'save_transport_carrier_order'].filter(n => !new RegExp("idemRpc\\('" + n + "'").test(supa));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join() && idem.length === 0) || 'missing: ' + miss.join(', ') + ' idem: ' + idem.join(', ');
  });
}

/* ================================================================== main */
async function main() {
  await secFile();
  await secPreflight();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  pass('database ready');
  await secReadings();
  await secDrafts();
  await secApprove();
  await secReread();
  await secProofs();
  await secTasto();
  await secFixes();
  await secRls();
  await secStatic();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 step ٨ restore drill: database + storage objects (docs/online/G7_SPEC.md § g7-restore-tests.js). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.
  (Same approach as restore-drill.js, own file; restore-drill.js stays the G2 drill.)

  1. Build:   shim.sql → supabase/migrations/*.sql (sorted) → seed.sql → two orgs (A = seed, B = «org-g7r») with G2–G7 data
              through the real RPCs, PLUS object bytes: every storage.objects row of the buckets documents / finance /
              messages gets deterministic synthetic bytes in a temp object store (os.tmpdir()/marsa-g7-restore-*, removed at the
              end), and the DB sha256 / size_bytes of documents, finance_documents and msg_attachments equal those bytes.
  2. Backup:  db.dumpDataDir() + a copy of the object store + manifest.json ([{bucket, path, size, sha256}], sorted, plus the
              manifest sha256).
  3. Restore: a new PGlite (loadDataDir) + a new object directory.
  4. Verify:  per-table count + md5 (public / app / auth / storage) + sequences + catalog; every manifest entry present with
              equal size and sha256; DB row ↔ object 1:1 (no orphan object, no row without object except msg_attachments with
              storage_status 'not_fetched'); every FK / composite FK holds (generic anti-join over pg_constraint); usage counters =
              app.g7_recount result; RLS sanity subset; one enforced create (MRS_PLAN_LIMIT) and one allowed create.
  5. Self-test: three tamper modes on fresh restores — a flipped object byte, a dropped object, an altered row — must each be
              detected (in-process). --tamper-object / --drop-object / --tamper-row apply the tamper to the main restore: the
              run must then FAIL.

  Offline owner mode (no DB, no network): verifies a real downloaded object set against a manifest
    node supabase/tests/g7-restore-tests.js --verify-manifest <manifest.json> --objects <dir>
    (<dir>/<bucket>/<path>; the manifest may be the JSON array produced by the SQL in BACKUP_RESTORE_AR.md §8, or the
     {entries, entries_sha256} object written by this drill.)

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-restore-tests.js [/path/to/marsa-website] [--quiet] [--tamper-object|--drop-object|--tamper-row] [--keep]
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const argVal = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const VALUE_ARGS = new Set([argVal('--verify-manifest'), argVal('--objects')].filter(Boolean));
const ROOT = args.find(a => !a.startsWith('--') && !VALUE_ARGS.has(a)) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const KEEP = args.includes('--keep');
const MAIN_TAMPER = ['--tamper-object', '--drop-object', '--tamper-row'].find(a => args.includes(a)) || null;
const SUPA = path.join(ROOT, 'supabase');
const G6B_MIGRATION = '20261107000100_g6b_inbox.sql';
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';
const BUCKETS = ['documents', 'finance', 'messages'];

// No network anywhere: any fetch is a test failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-restore-tests'); };

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
const J = x => JSON.stringify(x);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* ================================================================== object store + manifest (shared with offline mode) */
function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
function canonicalEntries(entries) {
  return entries.map(e => ({ bucket: String(e.bucket), path: String(e.path), size: Number(e.size), sha256: String(e.sha256).toLowerCase() }))
    .sort((a, b) => (a.bucket + '/' + a.path) < (b.bucket + '/' + b.path) ? -1 : (a.bucket + '/' + a.path) > (b.bucket + '/' + b.path) ? 1 : 0);
}
const entriesSha = entries => sha(J(canonicalEntries(entries)));
function safeJoin(dir, bucket, p) {
  if (!BUCKETS.includes(bucket) && !/^[a-z0-9_-]{1,63}$/.test(bucket)) return null;
  if (/(^|\/)\.\.(\/|$)|\\|^\//.test(p) || /%2e%2e/i.test(p)) return null;
  const full = path.resolve(dir, bucket, ...p.split('/'));
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}
// → {problems: [{kind, key, detail}], checked}
function verifyObjects(manifest, dir, opts) {
  const problems = [];
  const raw = Array.isArray(manifest) ? manifest : (manifest && manifest.entries) || [];
  const entries = canonicalEntries(raw);
  if (!Array.isArray(manifest) && manifest && manifest.entries_sha256 && manifest.entries_sha256 !== entriesSha(raw)) {
    problems.push({ kind: 'manifest_sha256', key: 'manifest', detail: 'entries_sha256 does not match the entries' });
  }
  const seen = new Set();
  for (const e of entries) {
    const key = e.bucket + '/' + e.path;
    if (seen.has(key)) { problems.push({ kind: 'manifest_duplicate', key }); continue; }
    seen.add(key);
    const f = safeJoin(dir, e.bucket, e.path);
    if (!f) { problems.push({ kind: 'unsafe_path', key }); continue; }
    if (!fs.existsSync(f)) { problems.push({ kind: 'missing_object', key }); continue; }
    const b = fs.readFileSync(f);
    if (b.length !== e.size) problems.push({ kind: 'size_mismatch', key, detail: e.size + ' ≠ ' + b.length });
    if (sha(b) !== e.sha256) problems.push({ kind: 'sha256_mismatch', key });
  }
  if (!(opts && opts.allowExtra)) for (const rel of walk(dir, dir)) if (!seen.has(rel)) problems.push({ kind: 'extra_object', key: rel });
  return { problems, checked: entries.length };
}

/* ================================================================== offline owner mode */
if (args.includes('--verify-manifest')) {
  const mf = argVal('--verify-manifest'), od = argVal('--objects');
  if (!mf || !od) { console.error('usage: --verify-manifest <manifest.json> --objects <dir>'); process.exit(2); }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { console.error('cannot read manifest: ' + e.message); process.exit(2); }
  const r = verifyObjects(manifest, od, { allowExtra: args.includes('--allow-extra') });
  for (const p of r.problems) console.log('FAIL  ' + p.kind + '  ' + p.key + (p.detail ? '  (' + p.detail + ')' : ''));
  console.log((r.problems.length ? 'MANIFEST CHECK FAILED' : 'MANIFEST CHECK PASS') + ` — ${r.checked} entries, ${r.problems.length} problem(s)`);
  process.exit(r.problems.length ? 1 : 0);
}

/* ================================================================== ids (spec prefix «c7r0…» is not hex: restore uses c7d0…) */
const ID = n => 'c7d00000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const TX1 = '0b5e0000-0000-4000-8000-000000000201';
const B = ID(0xb1), B_BR = ID(0xb2), B_CL = ID(0xb3), B_TX = ID(0xb4);
const U = { adminA: ID(1), staffA: ID(2), clientA: ID(3), adminB: ID(4), staffB: ID(5), platform: ID(6) };
let keySeq = 0;
const newKey = () => `c7d0aaaa-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

/* ================================================================== DB helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}

/* ================================================================== deterministic bytes */
function bytesFor(key, size) {
  const out = Buffer.alloc(size);
  let block = crypto.createHash('sha256').update('marsa-g7-restore|' + key).digest();
  for (let i = 0; i < size; i += 32) { block.copy(out, i, 0, Math.min(32, size - i)); block = crypto.createHash('sha256').update(block).digest(); }
  return out;
}
const store = {};   // 'bucket/path' → Buffer (source of truth while building)
function putObject(dir, bucket, p, buf) {
  const f = safeJoin(dir, bucket, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
}

/* ================================================================== build the source */
let hasG7 = false;
const R = {};
async function buildSource(srcDir) {
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g7restore.example.com', now())`).join(', ')};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, public_intake_enabled) VALUES ('${B}', 'org-g7r', 'مؤسسة الاستعادة التجريبية', 'TSR', true);
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RST', 'فرع الاستعادة');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, notes) VALUES ('${B_CL}', '${B}', 'business', 'عميل الاستعادة ب', '0509999998', 'ملاحظة ب');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.staffA}', '${A}', NULL, 'clearance_staff'), ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.adminB}', '${B}', NULL, 'admin'), ('${U.staffB}', '${B}', NULL, 'clearance_staff');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.platform}', 'g7 restore drill');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number) VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'RSTBL0000B1');
    INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ('${B}', '${B_TX}', 'RSTU0000001');
  `);
  // G2: public request → conversion; invitation; client error
  const req = await rpc('anon', `SELECT public.submit_service_request($1) r`, [{ fullName: 'زائر الاستعادة', company: 'شركة زائر', phone: '0559100001', email: 'v@example.com',
    clientType: 'business', crNumber: '7000000101', direction: 'import', service: 'clearance', mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي',
    goods: 'بضاعة اختبار الاستعادة G7', containerType: '40ft', containerNumbers: 'TSTU0000031', count: 1, blNumber: 'RSTBLG7001', terms: true, idempotencyKey: newKey() }]);
  const reqId = (await one(`SELECT id FROM public.service_requests WHERE ref = $1`, [req.ref])).id;
  const conv = await rpc('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [reqId, JED, newKey()]);
  R.convTx = conv.transaction_id || (conv.transaction && conv.transaction.id) || null;
  await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'new.staff@g7restore.example.com', role: 'clearance_staff', branch_id: JED, idempotencyKey: newKey() }]);
  await rpc('staffB', `SELECT public.log_client_error($1) r`, [{ orgId: B, message: 'g7 restore drill error B', code: 'E_B' }]);
  // G3
  await q(`SELECT app.seed_document_requirements($1)`, [A]);
  const carrier = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier','terminal_operator'], 'ناقل استعادة G7') RETURNING id`, [A]))[0].id;
  await rpc('staffA', `SELECT public.save_bl($1, $2) r`, [{ transaction_id: TX1, bl_number: 'RSTBL-G7-1', bl_type: 'house' }, newKey()]);
  await rpc('staffA', `SELECT public.create_appointment($1, $2) r`, [{ transaction_id: TX1, terminal_party_id: carrier, appointment_at: '2026-12-01T08:00:00Z', status: 'confirmed' }, newKey()]);
  // documents (bucket documents): staff INSERT with the sha256 / size of the bytes, then the storage object
  R.docs = [];
  const docPlan = [['staffA', A, TX1, 'bill_of_lading', 'bl.pdf', 2400, 'internal'], ['staffA', A, TX1, 'commercial_invoice', 'inv.pdf', 3100, 'client'],
    ['staffA', A, TX1, 'packing_list', 'pl.pdf', 1800, 'internal'], ['staffB', B, B_TX, 'commercial_invoice', 'inv-b.pdf', 2700, 'internal'], ['staffB', B, B_TX, 'bill_of_lading', 'bl-b.pdf', 1500, 'internal']];
  let i = 0;
  for (const [who, org, tx, kind, name, size, vis] of docPlan) {
    const id = ID(0x500 + (++i));
    const p = `${org}/${tx}/${id}/${name}`;
    const buf = bytesFor('documents/' + p, size);
    await as(who, `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, visibility)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', $8, $9)`, [id, org, tx, kind, p, sha(buf), name, size, vis]);
    await q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('documents', $1, $2, $3)`, [p, U[who], { size, mimetype: 'application/pdf' }]);
    putObject(srcDir, 'documents', p, buf); store['documents/' + p] = buf;
    R.docs.push({ id, org, path: p });
  }
  // finance documents (bucket finance) through register_finance_document; G4 supplier invoice on A
  R.fin = [];
  for (const [who, org, br, size] of [['adminA', A, JED, 4100], ['adminB', B, B_BR, 3300]]) {
    const key = 'finance/' + org + '/' + size;
    const pre = bytesFor(key, size);
    const fd = await rpc(who, `SELECT public.register_finance_document($1, $2) r`, [{ branch_id: br, kind: 'supplier_invoice', original_name: 'supplier-inv.pdf',
      mime_type: 'application/pdf', size_bytes: size, sha256: sha(pre) }, newKey()]);
    await q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('finance', $1, $2, $3)`, [fd.storage_path, U[who], { size, mimetype: 'application/pdf' }]);
    putObject(srcDir, 'finance', fd.storage_path, pre); store['finance/' + fd.storage_path] = pre;
    R.fin.push({ id: fd.id, org, path: fd.storage_path });
  }
  const inv = await rpc('adminA', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: JED, supplier_id: carrier, invoice_number: 'RST-G7-INV-1',
    invoice_date: '2026-11-01', subtotal: 800, vat_amount: 120, finance_document_id: R.fin[0].id,
    lines: [{ description: 'نقل حاوية (استعادة G7)', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' }] }, newKey()]);
  R.inv = inv.id;
  const ch = await rpc('adminA', `SELECT public.create_client_charge($1) r`, [{ transaction_id: TX1, kind: 'service', description: 'رسوم تخليص (استعادة G7)', unit_price: 1500 }]);
  await rpc('adminA', `SELECT public.set_charge_status($1, 'approved', NULL) r`, [ch.id]);
  // G5: mock Daftra connection; G6a: export log
  await rpc('adminA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock', subdomain: 'marsa-g7-restore', sync_enabled: true }]);
  await rpc('adminA', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'transactions', format: 'xlsx', filters: {}, row_count: 3 }]);
  // G6b: one mock channel per org, probe by a handcrafted worker identity, an inbound message with two attachments each:
  // one "stored" (bytes in bucket messages, sha256 set once by the owner = the live worker's job), one not_fetched
  const work = async () => {
    for (let round = 0; round < 6; round++) {
      const ctxs = await rpc('service', `SELECT public.msg_claim_jobs('g7-restore-worker', 20) r`);
      if (!ctxs || !ctxs.length) return;
      for (const c of ctxs) {
        let res;
        if (c.job.kind === 'probe') res = { outcome: 'ok', effects: { capabilities: { send: { supported: true, evidence: 'mock' } }, account: { address: c.channel.address_norm } } };
        else if (c.job.kind === 'process') res = { outcome: 'ok', effects: { message_id: c.message.id, extractions: [],
          classification: { category: 'general_inquiry', confidence: 0.5, rules: [] },
          summary: { summary_ar: 'استفسار', summary_en: 'Inquiry', action_code: 'answer_inquiry', suggested_role: 'clearance_staff', deadline: null, risks: [] },
          risk_flags: [], ai_run: { provider: 'rule_mock', provider_version: 'g7-restore-1', input_sha256: 'a'.repeat(64), input_chars: 10, output_chars: 5,
            est_input_tokens: 3, est_output_tokens: 1, est_cost_usd: 0 } } };
        else res = { outcome: 'ok', effects: c.job.kind === 'poll' ? { messages: [], next_cursor: 'c1' } : { events: [], next_cursor: 's1' } };
        await rpc('service', `SELECT public.msg_complete_job($1, $2) r`, [c.attempt_id, JSON.stringify(res)]);
      }
    }
  };
  R.att = [];
  for (const [who, org, addr] of [['adminA', A, 'inbox@g7restore-a.example'], ['adminB', B, 'inbox@g7restore-b.example']]) {
    const chn = await rpc(who, `SELECT public.save_msg_channel($1, $2, $3) r`, [org, { kind: 'email', name: 'Inbox', address: addr, ingest_enabled: true, send_enabled: false, provider_terms_ack: true }, newKey()]);
    await rpc(who, `SELECT public.request_msg_channel_probe($1, NULL) r`, [chn.id]);
    await work();
    const sizes = [2048, 900];
    const inbound = { provider_message_id: 'g7r-' + addr, kind: 'email', from: { address: 'agent@g7restore-agent.example', name: 'Agent' }, to: [{ address: addr }],
      cc: [], sent_at: '2026-11-02T08:00:00Z', subject: 'Documents', body_text: 'Please find the documents attached.',
      headers: { message_id: '<g7r-' + addr + '>' }, auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      attachments: [{ provider_attachment_id: 'a1', file_name: 'scan.pdf', mime_type: 'application/pdf', size_bytes: sizes[0] },
        { provider_attachment_id: 'a2', file_name: 'later.pdf', mime_type: 'application/pdf', size_bytes: sizes[1] }], raw: { provider: 'mock' } };
    const ing = (await rpc('service', `SELECT public.msg_ingest_messages($1, $2) r`, [chn.id, JSON.stringify([inbound])])).items[0];
    await work();
    const atts = await q(`SELECT id, storage_path, size_bytes FROM public.msg_attachments WHERE message_id = $1 ORDER BY provider_attachment_id`, [ing.message_id]);
    const a1 = atts[0];
    const buf = bytesFor('messages/' + a1.storage_path, Number(a1.size_bytes));
    await q(`UPDATE public.msg_attachments SET storage_status = 'stored', sha256 = $2 WHERE id = $1`, [a1.id, sha(buf)]);
    await q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('messages', $1, NULL, $2)`, [a1.storage_path, { size: buf.length }]);
    putObject(srcDir, 'messages', a1.storage_path, buf); store['messages/' + a1.storage_path] = buf;
    R.att.push({ stored: a1.id, not_fetched: atts[1].id, org });
  }
  // G7: org B on the basic plan (platform admin), counters recounted
  if (hasG7) {
    await rpc('platform', `SELECT public.platform_set_org_plan($1, $2, $3) r`, [B, { plan_code: 'basic', status: 'active', period_start: '2026-11-01', reason: 'اختبار الاستعادة: باقة أساسية' }, newKey()]);
    for (const o of [A, B]) await q(`SELECT app.g7_recount($1)`, [o]);
  }
}

/* ================================================================== manifest from the DB rows */
async function dbObjectRows() {
  return q(`SELECT 'documents' bucket, storage_path path, size_bytes::bigint size, sha256, 'documents' src, id::text id FROM public.documents
            UNION ALL SELECT 'finance', storage_path, size_bytes::bigint, sha256, 'finance_documents', id::text FROM public.finance_documents
            UNION ALL SELECT storage_bucket, storage_path, size_bytes::bigint, sha256, 'msg_attachments', id::text FROM public.msg_attachments WHERE storage_status = 'stored'
            ORDER BY 1, 2`);
}
async function buildManifest() {
  const rows = await dbObjectRows();
  const entries = canonicalEntries(rows.map(r => ({ bucket: r.bucket, path: r.path, size: Number(r.size), sha256: r.sha256 })));
  return { version: 1, generated_by: 'g7-restore-tests.js', entries, entries_sha256: entriesSha(entries) };
}

/* ================================================================== snapshot (as restore-drill.js) */
const SCHEMAS = ['public', 'app', 'auth', 'storage'];
async function snapshot() {
  const tables = await q(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relkind IN ('r','p') AND n.nspname = ANY ($1) ORDER BY 1, 2`, [SCHEMAS]);
  const out = {};
  for (const { s, t } of tables) {
    const r = await one(`SELECT count(*)::int n, coalesce(md5(string_agg(x.r, E'\\n' ORDER BY x.r)), '-') h FROM (SELECT t::text r FROM ${s}."${t}" t) x`);
    out[`${s}.${t}`] = r;
  }
  for (const r of await q(`SELECT schemaname || '.' || sequencename k, coalesce(last_value, 0)::text v FROM pg_sequences WHERE schemaname = ANY ($1)`, [SCHEMAS])) out['seq ' + r.k] = { n: 1, h: r.v };
  const cat = await one(`SELECT
      (SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || p.prosecdef || coalesce(array_to_string(p.proacl, ','), ''), ',' ORDER BY 1))
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY ($1)) f,
      (SELECT md5(string_agg(schemaname || tablename || policyname || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY 1)) FROM pg_policies WHERE schemaname = ANY ($1)) p,
      (SELECT md5(string_agg(n.nspname || c.relname || c.relrowsecurity || coalesce(array_to_string(c.relacl, ','), ''), ',' ORDER BY 1))
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY ($1) AND c.relkind IN ('r','p','v')) r,
      (SELECT md5(string_agg(tgrelid::regclass::text || tgname, ',' ORDER BY 1)) FROM pg_trigger WHERE NOT tgisinternal) t`, [SCHEMAS]);
  out['catalog functions'] = { n: 1, h: cat.f }; out['catalog policies'] = { n: 1, h: cat.p };
  out['catalog tables/RLS/grants'] = { n: 1, h: cat.r }; out['catalog triggers'] = { n: 1, h: cat.t };
  return out;
}
function compareSnapshots(before, after) {
  const problems = [];
  let tables = 0;
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[k], b = after[k];
    if (!k.startsWith('seq ') && !k.startsWith('catalog')) tables++;
    if (!a || !b) { problems.push({ kind: 'table_presence', key: k }); continue; }
    if (k.startsWith('seq ') && BigInt(b.h) >= BigInt(a.h) && BigInt(b.h) - BigInt(a.h) <= 32n) continue;   // WAL-logged sequences may jump forward
    if (a.n !== b.n || a.h !== b.h) problems.push({ kind: 'table_mismatch', key: k, detail: `n ${a.n}→${b.n}` });
  }
  return { problems, tables };
}

/* ================================================================== verification of one restore */
async function fkProblems() {
  const fks = await q(`SELECT c.conname, c.conrelid::regclass::text child, c.confrelid::regclass::text parent,
                              array_agg(a.attname ORDER BY k.n) ccols, array_agg(af.attname ORDER BY k.n) pcols
                         FROM pg_constraint c
                         JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY k(ck, pk, n) ON true
                         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck
                         JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.pk
                         JOIN pg_namespace ns ON ns.oid = c.connamespace
                        WHERE c.contype = 'f' AND ns.nspname IN ('public','storage')
                        GROUP BY c.conname, c.conrelid, c.confrelid ORDER BY 2, 1`);
  const problems = [];
  for (const f of fks) {
    const cc = f.ccols, pc = f.pcols;
    const sql = `SELECT count(*)::int n FROM ${f.child} c WHERE ${cc.map(x => `c."${x}" IS NOT NULL`).join(' AND ')}
                   AND NOT EXISTS (SELECT 1 FROM ${f.parent} p WHERE ${cc.map((x, i) => `p."${pc[i]}" = c."${x}"`).join(' AND ')})`;
    const n = (await one(sql)).n;
    if (n) problems.push({ kind: 'fk_violation', key: f.child + '.' + f.conname, detail: n + ' row(s)' });
  }
  return { problems, count: fks.length };
}
async function rowObjectProblems(dir) {
  const problems = [];
  const rows = await dbObjectRows();
  const objs = await q(`SELECT bucket_id, name FROM storage.objects WHERE bucket_id = ANY ($1)`, [BUCKETS]);
  const objSet = new Set(objs.map(o => o.bucket_id + '/' + o.name));
  const rowSet = new Set(rows.map(r => r.bucket + '/' + r.path));
  for (const r of rows) {
    const key = r.bucket + '/' + r.path;
    if (!objSet.has(key)) problems.push({ kind: 'row_without_object_row', key });
    const f = safeJoin(dir, r.bucket, r.path);
    if (!f || !fs.existsSync(f)) { problems.push({ kind: 'row_without_object_bytes', key }); continue; }
    const b = fs.readFileSync(f);
    if (b.length !== Number(r.size) || sha(b) !== r.sha256) problems.push({ kind: 'row_object_mismatch', key, detail: r.src });
  }
  for (const o of objSet) if (!rowSet.has(o)) problems.push({ kind: 'orphan_object_row', key: o });
  for (const rel of walk(dir, dir)) if (!objSet.has(rel)) problems.push({ kind: 'orphan_object_file', key: rel });
  // not_fetched attachments: no object expected and none present
  for (const a of await q(`SELECT storage_bucket, storage_path FROM public.msg_attachments WHERE storage_status = 'not_fetched'`)) {
    const k = a.storage_bucket + '/' + a.storage_path;
    if (objSet.has(k) || fs.existsSync(safeJoin(dir, a.storage_bucket, a.storage_path) || '/nonexistent')) problems.push({ kind: 'not_fetched_has_object', key: k });
  }
  return { problems, rows: rows.length, objects: objSet.size };
}
async function counterProblems() {
  if (!hasG7) return { problems: [], skipped: true };
  const snap = async () => J(await q(`SELECT org_id, metric, period_start::text, value::text FROM public.org_usage_counters ORDER BY 1, 2, 3`));
  const before = await snap();
  await q('BEGIN');
  try {
    for (const o of (await q(`SELECT id FROM public.organizations ORDER BY id`))) await q(`SELECT app.g7_recount($1)`, [o.id]);
    const after = await snap();
    return { problems: before === after ? [] : [{ kind: 'counter_mismatch', key: 'org_usage_counters', detail: 'recount changed the restored counters' }] };
  } finally { await q('ROLLBACK'); }
}
async function verifyRestore(before, manifest, dir) {
  const after = await snapshot();
  const t = compareSnapshots(before, after);
  const o = verifyObjects(manifest, dir);
  const ro = await rowObjectProblems(dir);
  const fk = await fkProblems();
  const ct = await counterProblems();
  return { problems: [...t.problems, ...o.problems, ...ro.problems, ...fk.problems, ...ct.problems], tables: t.tables, manifest: o.checked, rows: ro.rows,
    objects: ro.objects, fks: fk.count, counters: !ct.skipped };
}

/* ================================================================== tampers */
function firstEntry(manifest, bucket) { return manifest.entries.find(e => !bucket || e.bucket === bucket); }
async function applyTamper(mode, manifest, dir) {
  if (mode === '--tamper-object') {
    const e = firstEntry(manifest, 'finance');
    const f = safeJoin(dir, e.bucket, e.path);
    const b = fs.readFileSync(f); b[0] = b[0] ^ 0xff; fs.writeFileSync(f, b);
    return 'flipped byte 0 of ' + e.bucket + '/' + e.path;
  }
  if (mode === '--drop-object') {
    const e = firstEntry(manifest, 'messages');
    fs.unlinkSync(safeJoin(dir, e.bucket, e.path));
    return 'deleted ' + e.bucket + '/' + e.path;
  }
  await q(`UPDATE public.clients SET notes = 'tampered after restore' WHERE id = $1`, [CL101]);
  return 'altered clients.notes of ' + CL101;
}
const EXPECT = { '--tamper-object': ['sha256_mismatch', 'row_object_mismatch'], '--drop-object': ['missing_object', 'row_without_object_bytes'], '--tamper-row': ['table_mismatch'] };

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const rel of walk(src, src)) { const t = path.join(dst, ...rel.split('/')); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(path.join(src, ...rel.split('/')), t); }
}
async function restoreInto(dump, objectsSrc, dir) {
  const { PGlite } = require('@electric-sql/pglite');
  const d = new PGlite({ loadDataDir: dump });
  await d.waitReady;
  copyDir(objectsSrc, dir);
  return d;
}

/* ================================================================== sanity on the restored DB */
async function sanity(manifest) {
  await check('health_check reports the latest schema version on the restored DB', async () => {
    const r = await rpc('anon', `SELECT public.health_check() r`);
    const migs = fs.readdirSync(path.join(SUPA, 'migrations')).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    return (r.ok && r.schema_version === migs[migs.length - 1].split('_')[0]) || J(r);
  });
  await check('RLS still on for every public table', async () => {
    const r = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    return r.length === 0 || r.map(x => x.relname).join(', ');
  });
  await check('staffB cannot read org A documents / finance documents / attachments / storage objects; anon reads nothing', async () => {
    for (const [who, sql, p] of [['staffB', `SELECT 1 FROM public.documents WHERE org_id = $1`, [A]], ['staffB', `SELECT 1 FROM public.finance_documents WHERE org_id = $1`, [A]],
      ['staffB', `SELECT 1 FROM public.msg_attachments WHERE org_id = $1`, [A]], ['staffB', `SELECT 1 FROM storage.objects WHERE name LIKE $1`, [A + '/%']],
      ['anon', `SELECT 1 FROM public.documents`, []], ['anon', `SELECT 1 FROM storage.objects`, []]]) {
      const d = await denied(who, sql, p);
      if (d !== true) return who + ': ' + sql + ' → ' + d;
    }
    return true;
  });
  await check('clientA sees only the client-visible document of its own transaction', async () => {
    const r = await as('clientA', `SELECT id FROM public.documents`);
    const vis = R.docs.filter(d => d.org === A).length;
    return (r.length === 1 && vis === 3) || J(r);
  });
  await check('staffA reads its own org objects (documents bucket) through storage RLS', async () => {
    const r = await as('staffA', `SELECT name FROM storage.objects WHERE bucket_id = 'documents'`);
    return (r.length === 3 && r.every(x => x.name.startsWith(A + '/'))) || J(r);
  });
  await check('allowed create after restore: org A (pilot) staff inserts a document whose bytes match', async () => {
    const id = ID(0x5ff);
    const p = `${A}/${TX1}/${id}/after.pdf`;
    const buf = bytesFor('after/' + p, 1200);
    await as('staffA', `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes)
                        VALUES ($1, $2, $3, 'other', $4, $5, 'after.pdf', 'application/pdf', 1200)`, [id, A, TX1, p, sha(buf)]);
    return (await one(`SELECT count(*)::int n FROM public.documents WHERE id = $1`, [id])).n === 1;
  });
  if (hasG7) {
    await check('enforced create after restore: org B at its transactions_month limit → MRS_PLAN_LIMIT, nothing saved', async () => {
      const used = Number((await one(`SELECT coalesce(max(value), 0) v FROM public.org_usage_counters WHERE org_id = $1 AND metric = 'transactions_month' AND period_start = app.g7_period(now())`, [B])).v);
      await rpc('platform', `SELECT public.platform_set_org_plan($1, $2, $3) r`, [B, { limit_overrides: { transactions_month: used }, reason: 'اختبار الحد بعد الاستعادة' }, newKey()]);
      const n0 = (await one(`SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [B])).n;
      try {
        await as('staffB', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea')`, [B, B_BR, B_CL]);
        return 'insert succeeded over the limit';
      } catch (e) {
        const n1 = (await one(`SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [B])).n;
        return (/MRS_PLAN_LIMIT/.test(errText(e)) && /transactions_month/.test(errText(e)) && n1 === n0) || errText(e);
      }
    });
  } else fail('enforced create after restore', 'G7 migration ' + G7_MIGRATION + ' absent');
  void manifest;
}

/* ================================================================== main */
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marsa-g7-restore-'));
  const dirs = { source: path.join(tmp, 'source'), backup: path.join(tmp, 'backup', 'objects'), restored: path.join(tmp, 'restored') };
  const { PGlite } = require('@electric-sql/pglite');
  try {
    db = new PGlite();
    section('1. build the source (G2–G7 data for two orgs + object bytes)');
    const migDir = path.join(SUPA, 'migrations');
    const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    if (!migFiles.includes(G6B_MIGRATION)) { fail('G6b migration present', G6B_MIGRATION + ' not found'); return; }
    if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
    for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return;
    if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
    hasG7 = !!(await one(`SELECT to_regclass('public.org_usage_counters') IS NOT NULL AND to_regprocedure('app.g7_recount(uuid)') IS NOT NULL ok`)).ok;
    if (hasG7) pass('catalog: G7 objects present (org_usage_counters, app.g7_recount, platform_set_org_plan)');
    else fail('catalog: G7 objects present', G7_MIGRATION + ' absent — counters / enforced-create checks cannot run');
    try { await buildSource(dirs.source); pass(`source built: ${R.docs.length} documents, ${R.fin.length} finance documents, ${R.att.length * 2} message attachments (${R.att.length} stored)`); }
    catch (e) { fail('build source', errText(e)); return; }
    await check('source is not vacuous: both orgs have objects in every bucket; the not_fetched attachments have no object', async () => {
      const r = await q(`SELECT bucket_id, split_part(name, '/', 1) org, count(*)::int n FROM storage.objects WHERE bucket_id = ANY ($1) GROUP BY 1, 2 ORDER BY 1, 2`, [BUCKETS]);
      const ok = BUCKETS.every(b => [A, B].every(o => r.some(x => x.bucket_id === b && x.org === o)));
      return ok || J(r);
    });
    const manifest = await buildManifest();
    await check('source consistent before the backup: DB rows = objects = bytes (manifest built from the DB rows)', async () => {
      const ro = await rowObjectProblems(dirs.source);
      const o = verifyObjects(manifest, dirs.source);
      return (ro.problems.length === 0 && o.problems.length === 0 && manifest.entries.length === Object.keys(store).length) || J([ro.problems, o.problems]);
    });
    if (hasG7) {
      await check('G7 counters in the source = app.g7_recount (storage bytes include the object sizes)', async () => {
        const c = await counterProblems();
        const sb = await one(`SELECT value::bigint v FROM public.org_usage_counters WHERE org_id = $1 AND metric = 'storage_bytes'`, [B]);
        const expect = await one(`SELECT (SELECT coalesce(sum(size_bytes),0) FROM public.documents WHERE org_id = $1) + (SELECT coalesce(sum(size_bytes),0) FROM public.finance_documents WHERE org_id = $1)
                                       + (SELECT coalesce(sum(size_bytes),0) FROM public.msg_attachments WHERE org_id = $1) v`, [B]);
        return (c.problems.length === 0 && sb && Number(sb.v) === Number(expect.v)) || J({ c, sb, expect });
      });
    }
    const before = await snapshot();

    section('2. backup: dumpDataDir + object store copy + manifest.json');
    let dump;
    try { dump = await db.dumpDataDir('gzip'); pass(`dumpDataDir ${(dump.size / 1048576).toFixed(1)} MB; manifest ${manifest.entries.length} objects, sha256 ${manifest.entries_sha256.slice(0, 12)}…`); }
    catch (e) { fail('dumpDataDir', errText(e)); return; }
    copyDir(dirs.source, dirs.backup);
    const mfFile = path.join(tmp, 'backup', 'manifest.json');
    fs.writeFileSync(mfFile, J(manifest));
    await db.close();
    await check('offline checker (--verify-manifest) accepts the backup copy', () => {
      const r = verifyObjects(JSON.parse(fs.readFileSync(mfFile, 'utf8')), dirs.backup);
      return r.problems.length === 0 || J(r.problems);
    });
    await check('offline checker accepts the SQL-shaped manifest (plain array, no entries_sha256) and rejects ../ paths', () => {
      const arr = manifest.entries.map(e => ({ bucket: e.bucket, path: e.path, size: e.size, sha256: e.sha256 }));
      const ok = verifyObjects(arr, dirs.backup).problems.length === 0;
      const bad = verifyObjects([{ bucket: 'documents', path: '../../etc/passwd', size: 1, sha256: 'a'.repeat(64) }], dirs.backup, { allowExtra: true }).problems;
      return (ok && bad.length === 1 && bad[0].kind === 'unsafe_path') || J({ ok, bad });
    });

    section('3. restore into a new PGlite + a new object directory');
    try { db = await restoreInto(dump, dirs.backup, dirs.restored); await q('SELECT 1'); pass('restored database opens; objects copied to a new directory'); }
    catch (e) { fail('restore', errText(e)); return; }
    let tamperNote = null;
    if (MAIN_TAMPER) tamperNote = await applyTamper(MAIN_TAMPER, manifest, dirs.restored);
    if (tamperNote) console.log('  ' + MAIN_TAMPER + ': ' + tamperNote + ' (this run must FAIL)');

    section('4. verify the restore');
    const v = await verifyRestore(before, manifest, dirs.restored);
    const byKind = k => v.problems.filter(p => p.kind === k || (Array.isArray(k) && k.includes(p.kind)));
    await check(`${v.tables} tables + sequences + catalog identical (count + md5)`, () => byKind(['table_mismatch', 'table_presence']).length === 0 || J(byKind(['table_mismatch', 'table_presence'])));
    await check(`every manifest entry present with equal size and sha256 (${v.manifest} objects)`, () =>
      byKind(['missing_object', 'size_mismatch', 'sha256_mismatch', 'manifest_sha256', 'extra_object', 'unsafe_path', 'manifest_duplicate']).length === 0 ||
      J(byKind(['missing_object', 'size_mismatch', 'sha256_mismatch', 'manifest_sha256', 'extra_object'])));
    await check(`DB row ↔ object 1:1 (${v.rows} rows, ${v.objects} object rows): no orphan, no row without bytes (not_fetched excepted)`, () =>
      byKind(['row_without_object_row', 'row_without_object_bytes', 'row_object_mismatch', 'orphan_object_row', 'orphan_object_file', 'not_fetched_has_object']).length === 0 ||
      J(byKind(['row_without_object_row', 'row_without_object_bytes', 'row_object_mismatch', 'orphan_object_row', 'orphan_object_file', 'not_fetched_has_object'])));
    await check(`every FK / composite FK holds after restore (${v.fks} constraints, anti-join per constraint)`, () => byKind('fk_violation').length === 0 || J(byKind('fk_violation')));
    if (hasG7) await check('usage counters on the restored DB = app.g7_recount result', () => byKind('counter_mismatch').length === 0 || J(byKind('counter_mismatch')));
    await check('the owner SQL of BACKUP_RESTORE_AR.md §8 produces exactly this manifest on the restored DB', async () => {
      const doc = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'BACKUP_RESTORE_AR.md'), 'utf8');
      const sec = doc.slice(doc.indexOf('## 8)'));
      const m = sec.match(/```sql\n([\s\S]*?AS manifest[\s\S]*?)```/);
      if (!m) return 'SQL block not found in §8';
      const got = (await one(m[1])).manifest;
      return J(canonicalEntries(got)) === J(manifest.entries) || 'differs: ' + J(got).slice(0, 300);
    });
    section('5. sanity on the restored database (RLS subset, allowed + enforced create)');
    await sanity(manifest);
    await db.close();

    section('6. self-test: each tamper mode must be detected (fresh restore each)');
    for (const mode of ['--tamper-object', '--drop-object', '--tamper-row']) {
      const dir = path.join(tmp, 'tamper' + mode);
      db = await restoreInto(dump, dirs.backup, dir);
      const note = await applyTamper(mode, manifest, dir);
      const r = await verifyRestore(before, manifest, dir);
      const kinds = [...new Set(r.problems.map(p => p.kind))];
      await check(`${mode} (${note}) is detected: ${kinds.join(', ') || 'nothing'}`, () => EXPECT[mode].every(k => kinds.includes(k)) || 'expected ' + EXPECT[mode].join(' + '));
      if (mode !== '--tamper-row') {
        const off = verifyObjects(manifest, dir).problems.map(p => p.kind);
        await check(`${mode}: the offline manifest checker also fails`, () => off.length > 0 || 'offline checker passed a tampered set');
      }
      await db.close();
    }
  } finally {
    if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)'); else pass('no network call (fetch trap untouched)');
    if (KEEP) console.log('  kept ' + tmp);
    else fs.rmSync(tmp, { recursive: true, force: true });
    if (!KEEP) await check('temp object store removed', () => !fs.existsSync(tmp) || 'still there: ' + tmp);
  }
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'G7 RESTORE DRILL FAILED' : 'G7 RESTORE DRILL PASS') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().then(finish).catch(e => { console.error(e); process.exit(1); });

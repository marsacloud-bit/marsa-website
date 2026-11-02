#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 step ٩ performance + cost indicators (docs/online/G7_SPEC.md § g7-perf.js). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory, single connection, WASM). Never point it at Supabase.
  PGlite numbers are INDICATORS, NOT SLAs (decision G7-16). A real load test on the Supabase staging tier is OWNER-PENDING.

  1. Load shim.sql → supabase/migrations/*.sql (sorted) → seed.sql → fixtures (org A = seed, org B = synthetic «org-g7p»).
  2. Synthetic volume by superuser bulk SQL (generate_series), per org at --scale=1:
       5 000 transactions, 20 000 containers, 10 000 threads / 50 000 messages, ~15 000 transaction events (+ the trigger
       events), 10 000 document metadata rows, 500 supplier invoices (+ the audit rows every trigger writes).
     --quick = --scale=0.1 (CI). The real triggers stay on (refs, events, audit, G3 mirrors, G7 counters when present).
  3. Measured RPC throughput: 500 convert_request_to_transaction (requests seeded by SQL), 1 000 inbound messages through
     msg_ingest_messages (batches of 50, service role, mock channel), 500 document inserts (staff, PostgREST-style INSERT).
  4. Latency (20 runs each; p50 / p95 / max) as org admin and as a branch user: search_records, report_transactions,
     report_containers, report_trips, dash_ops, dash_finance, dash_management, list_msg_threads, get_msg_thread,
     tx_checklist, margin_report; platform_list_subscriptions as platform admin (G7).
  5. EXPLAIN (FORMAT JSON) on the core org-filtered predicates (transactions, containers, msg_threads, msg_messages,
     transaction_events, audit_log): hard FAIL on a Seq Scan of those tables (at --scale ≥ 1; WARN below that, where the
     planner may legitimately prefer a scan of a tiny table). Soft: p95 ≤ 2 000 ms (WARN).
  6. Storage bytes per entity (pg_total_relation_size / rows) → the cost model (docs/online/G7_COST_MODEL_AR.md).
  --write → docs/online/G7_PERF_RESULTS.md (environment line, volumes, throughput, latency, plan verdicts, bytes/entity).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-perf.js [/path/to/marsa-website] [--quiet] [--quick] [--scale=<f>] [--runs=<n>] [--write]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const QUICK = args.includes('--quick');
const WRITE = args.includes('--write');
const argVal = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const SCALE = Number(argVal('scale', QUICK ? '0.1' : '1'));
const RUNS = Math.max(3, Number(argVal('runs', '20')));
const SUPA = path.join(ROOT, 'supabase');
const G6B_MIGRATION = '20261107000100_g6b_inbox.sql';
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';
const P95_SOFT_MS = 2000;

// No network anywhere: any fetch is a test failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-perf'); };

let nPass = 0, nFail = 0, nWarn = 0;
const fails = [], warns = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function warn(name, why) { nWarn++; warns.push(name + ' — ' + why); console.log('WARN  ' + name + '\n        ' + why); }
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

/* ================================================================== ids (spec prefix «c7p0…» is not hex: perf uses c7f0…, "f" = perf) */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const ID = n => 'c7f00000-0000-4000-8000-' + n.toString(16).padStart(12, '0');   // 'c7p0' is not hex: the perf prefix is c7f0 ("f" = perf)
const ORG_B = ID(0xb1), B_BR1 = ID(0xb2), B_BR2 = ID(0xb3);
const U = {
  adminA: ID(1), branchA: ID(2), adminB: ID(3), branchB: ID(4), platform: ID(5), clrA: ID(6)
};
const ORGS = [
  { key: 'A', id: A, br: [JED, DMM], admin: 'adminA', branch: 'branchA', prefix: 'MRS' },
  { key: 'B', id: ORG_B, br: [B_BR1, B_BR2], admin: 'adminB', branch: 'branchB', prefix: 'TSP' }
];

/* ================================================================== helpers */
let db;
async function asRole(who, fn) {
  if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const now = () => Number(process.hrtime.bigint()) / 1e6;
function stats(ms) {
  const s = ms.slice().sort((a, b) => a - b);
  const rank = p => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, p50: rank(0.5), p95: rank(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const f1 = x => (x === null || x === undefined) ? '—' : (Math.round(x * 10) / 10).toFixed(1);
const N = x => Math.max(1, Math.round(x * SCALE));

/* ================================================================== fixtures + bulk volume */
const VOL = {
  tx: N(5000), containers: N(20000), threads: N(10000), messages: N(50000), events_extra: N(15000), documents: N(10000), invoices: N(500), clients: N(200)
};
const timings = {};   // phase → ms
async function timed(label, fn) { const t = now(); const r = await fn(); timings[label] = now() - t; if (!QUIET) console.log(`  ${label}: ${f1(timings[label])} ms`); return r; }

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g7perf.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${ORG_B}', 'org-g7p', 'مؤسسة الأداء التجريبية', 'TSP');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR1}', '${ORG_B}', 'PR1', 'فرع أداء ١'), ('${B_BR2}', '${ORG_B}', 'PR2', 'فرع أداء ٢');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.branchA}', '${A}', '${JED}', 'branch_manager'), ('${U.clrA}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.adminB}', '${ORG_B}', NULL, 'admin'), ('${U.branchB}', '${ORG_B}', '${B_BR1}', 'branch_manager');
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.platform}', 'g7 perf');
  `);
}

async function bulk() {
  for (const o of ORGS) {
    const [b1, b2] = o.br;
    await timed(`org ${o.key}: clients ×${VOL.clients}`, () => q(`
      INSERT INTO public.clients (org_id, client_type, name_ar, name_en, phone)
      SELECT $1, 'business', 'عميل أداء ' || g, 'Perf client ' || g, '05' || lpad((10000000 + g)::text, 8, '0')
        FROM generate_series(1, $2) g`, [o.id, VOL.clients]));
    await timed(`org ${o.key}: parties (suppliers) ×20`, () => q(`
      INSERT INTO public.parties (org_id, kinds, name_ar) SELECT $1, ARRAY['carrier','shipping_agent'], 'مورد أداء ' || g FROM generate_series(1, 20) g`, [o.id]));
    // transactions: ref by the trigger; created_at spread over 12 months; statuses spread; bl + declaration unique per org
    await timed(`org ${o.key}: transactions ×${VOL.tx}`, () => q(`
      WITH cl AS (SELECT array_agg(id ORDER BY id) a FROM public.clients WHERE org_id = $1)
      INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, service, port_of_discharge, country, goods_description,
                                       bl_number, declaration_no, container_count, eta, operational_status, financial_status, created_at, status_changed_at)
      SELECT $1, CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END, cl.a[1 + (g % array_length(cl.a, 1))],
             CASE WHEN g % 5 = 0 THEN 'export' ELSE 'import' END, CASE WHEN g % 7 = 0 THEN 'air' ELSE 'sea' END, 'clearance',
             'ميناء جدة الإسلامي', 'الصين', 'بضاعة أداء ' || g, 'PRFBL' || lpad(g::text, 8, '0'), 'PD' || lpad(g::text, 8, '0'), 4,
             (date '2026-01-01' + (g % 300)),
             (ARRAY['new','in_progress','customs_declaration','appointment','transport','empty_return','operationally_complete','under_billing','billed','closed'])[1 + (g % 10)],
             (ARRAY['not_started','estimate_only','draft_pending','invoiced','settled'])[1 + (g % 5)],
             timestamptz '2025-11-01 08:00+03' + (g % 365) * interval '1 day', timestamptz '2025-11-01 08:00+03' + (g % 365) * interval '1 day'
        FROM generate_series(1, $4) g, cl`, [o.id, b1, b2, VOL.tx]));
    await timed(`org ${o.key}: containers ×${VOL.containers}`, () => q(`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM public.transactions WHERE org_id = $1), nt AS (SELECT count(*) c FROM t)
      INSERT INTO public.containers (org_id, transaction_id, container_no, container_type, return_deadline, return_status)
      SELECT $1, t.id, 'PRFU' || lpad(g::text, 7, '0'), '40hc', date '2026-01-01' + (g % 330),
             CASE WHEN g % 4 = 0 THEN 'waived' ELSE 'pending' END
        FROM generate_series(1, $2) g JOIN nt ON true JOIN t ON t.rn = 1 + (g % nt.c)`, [o.id, VOL.containers]).catch(async e => {
      // a waived container needs a reason (constraint): retry with reasons
      if (!/waiver/.test(errText(e))) throw e;
      return q(`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM public.transactions WHERE org_id = $1), nt AS (SELECT count(*) c FROM t)
      INSERT INTO public.containers (org_id, transaction_id, container_no, container_type, return_deadline, return_status, waiver_reason)
      SELECT $1, t.id, 'PRFU' || lpad(g::text, 7, '0'), '40hc', date '2026-01-01' + (g % 330),
             CASE WHEN g % 4 = 0 THEN 'waived' ELSE 'pending' END, CASE WHEN g % 4 = 0 THEN 'perf waiver' END
        FROM generate_series(1, $2) g JOIN nt ON true JOIN t ON t.rn = 1 + (g % nt.c)`, [o.id, VOL.containers]);
    }));
    await timed(`org ${o.key}: transaction_events ×${VOL.events_extra} (+ trigger events)`, () => q(`
      WITH t AS (SELECT id, created_at, row_number() OVER (ORDER BY id) rn FROM public.transactions WHERE org_id = $1), nt AS (SELECT count(*) c FROM t)
      INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, payload, created_at)
      SELECT $1, t.id, 'operational_status', 'new',
             (ARRAY['in_progress','customs_declaration','appointment','transport','operationally_complete','closed'])[1 + (g % 6)],
             g % 2 = 0, '{"perf":true}', t.created_at + (g % 20) * interval '1 day'
        FROM generate_series(1, $2) g JOIN nt ON true JOIN t ON t.rn = 1 + (g % nt.c)`, [o.id, VOL.events_extra]));
    await timed(`org ${o.key}: documents ×${VOL.documents}`, () => q(`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM public.transactions WHERE org_id = $1), nt AS (SELECT count(*) c FROM t),
           ids AS (SELECT g, gen_random_uuid() id FROM generate_series(1, $2) g)
      INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by, visibility)
      SELECT ids.id, $1, t.id, (ARRAY['bill_of_lading','commercial_invoice','packing_list','delivery_order'])[1 + (ids.g % 4)],
             $1::text || '/' || t.id || '/' || ids.id || '/f' || ids.g || '.pdf', encode(sha256(convert_to('perf-doc-' || $1::text || ids.g, 'UTF8')), 'hex'),
             'f' || ids.g || '.pdf', 'application/pdf', 150000 + (ids.g % 200) * 1000, $3, CASE WHEN ids.g % 3 = 0 THEN 'client' ELSE 'internal' END
        FROM ids JOIN nt ON true JOIN t ON t.rn = 1 + (ids.g % nt.c)`, [o.id, VOL.documents, U['admin' + o.key]]));
    await timed(`org ${o.key}: supplier_invoices ×${VOL.invoices}`, () => q(`
      WITH s AS (SELECT array_agg(id ORDER BY id) a FROM public.parties WHERE org_id = $1)
      INSERT INTO public.supplier_invoices (org_id, branch_id, supplier_id, invoice_number, number_norm, invoice_date, subtotal, vat_amount, total_amount, status)
      SELECT $1, CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END, s.a[1 + (g % array_length(s.a, 1))], 'PINV-' || g, 'PINV' || g,
             date '2026-01-01' + (g % 300), 1000 + g, round((1000 + g) * 0.15, 2), 1000 + g + round((1000 + g) * 0.15, 2),
             (ARRAY['received','under_review','approved'])[1 + (g % 3)]
        FROM generate_series(1, $4) g, s`, [o.id, b1, b2, VOL.invoices]));
  }
}

/* ------------------------------------------------------------------ messaging: channels via the real RPCs + a handcrafted probe */
const CH = {};
async function workProbe() {
  for (let round = 0; round < 5; round++) {
    const ctxs = await rpc('service', `SELECT public.msg_claim_jobs('g7-perf-worker', 20) r`);
    if (!ctxs || !ctxs.length) return;
    for (const c of ctxs) {
      const res = c.job.kind === 'probe'
        ? { outcome: 'ok', effects: { capabilities: { send: { supported: true, evidence: 'mock' } }, account: { address: c.channel.address_norm } } }
        : { outcome: 'ok', effects: c.job.kind === 'poll' ? { messages: [], next_cursor: 'c1' } : { events: [], next_cursor: 's1' } };
      if (c.job.kind === 'process' || c.job.kind === 'draft' || c.job.kind === 'send') continue;   // perf never runs them
      await rpc('service', `SELECT public.msg_complete_job($1, $2) r`, [c.attempt_id, JSON.stringify(res)]);
    }
  }
}
async function channels() {
  for (const o of ORGS) {
    const ch = await rpc(o.admin, `SELECT public.save_msg_channel($1, $2, NULL) r`, [o.id, { kind: 'email', name: 'بريد الأداء', address: 'inbox-' + o.key.toLowerCase() + '@g7perf.example',
      default_branch_id: o.br[0], mode: 'mock', ingest_enabled: true, send_enabled: false, provider_terms_ack: true }]);
    CH[o.key] = ch.id;
    await rpc(o.admin, `SELECT public.request_msg_channel_probe($1, NULL) r`, [ch.id]);
  }
  await workProbe();
}
async function bulkMessages() {
  for (const o of ORGS) {
    const [b1, b2] = o.br;
    await timed(`org ${o.key}: msg_threads ×${VOL.threads}`, () => q(`
      WITH t AS (SELECT id, branch_id, row_number() OVER (ORDER BY id) rn FROM public.transactions WHERE org_id = $1), nt AS (SELECT count(*) c FROM t)
      INSERT INTO public.msg_threads (org_id, channel_id, branch_id, kind, subject, counterpart_address_norm, status, priority, category, transaction_id, match_status,
                                      message_count, unread_count, last_message_at, last_inbound_at, created_at)
      SELECT $1, $2, CASE WHEN g % 3 = 0 THEN NULL WHEN g % 3 = 1 THEN $3::uuid ELSE $4::uuid END, 'email', 'Perf thread ' || g, 'agent' || (g % 300) || '@perf-agent.example',
             (ARRAY['new','in_progress','awaiting_external','awaiting_internal','resolved'])[1 + (g % 5)], 'normal',
             (ARRAY['telex_release','delivery_order','freight_charges','appointment','missing_documents','violation','empty_return','general_inquiry','unknown'])[1 + (g % 9)],
             CASE WHEN g % 2 = 0 THEN t.id END, CASE WHEN g % 2 = 0 THEN 'linked' ELSE 'unmatched' END,
             5, g % 3, timestamptz '2025-11-01 08:00+03' + (g % 365) * interval '1 day', timestamptz '2025-11-01 08:00+03' + (g % 365) * interval '1 day',
             timestamptz '2025-11-01 08:00+03' + (g % 365) * interval '1 day'
        FROM generate_series(1, $5) g JOIN nt ON true JOIN t ON t.rn = 1 + (g % nt.c)`, [o.id, CH[o.key], b1, b2, VOL.threads]));
    // the linked threads' branch must equal the transaction's branch (the G6b link invariant): align them
    await q(`UPDATE public.msg_threads h SET branch_id = t.branch_id FROM public.transactions t WHERE h.transaction_id = t.id AND h.org_id = $1 AND h.branch_id IS DISTINCT FROM t.branch_id`, [o.id])
      .catch(e => warn('align linked thread branches (org ' + o.key + ')', errText(e)));
    await timed(`org ${o.key}: msg_messages ×${VOL.messages}`, () => q(`
      WITH h AS (SELECT id, created_at, row_number() OVER (ORDER BY id) rn FROM public.msg_threads WHERE org_id = $1), nh AS (SELECT count(*) c FROM h)
      INSERT INTO public.msg_messages (org_id, thread_id, channel_id, direction, provider_message_id, from_address, from_address_norm, to_addresses, recipient_address_norm,
                                       sent_at, received_at, subject, body_text, body_sha256, ingest_source, created_at)
      SELECT $1, h.id, $2, 'inbound', 'perf-' || $1::text || '-' || g, 'agent' || (g % 300) || '@perf-agent.example', 'agent' || (g % 300) || '@perf-agent.example',
             '["inbox@g7perf.example"]', 'inbox@g7perf.example', h.created_at + (g % 5) * interval '1 hour', h.created_at + (g % 5) * interval '1 hour',
             'Perf thread', 'Please confirm the status of container PRFU' || lpad((g % 99999)::text, 7, '0') || ' and B/L PRFBL' || lpad((g % 5000)::text, 8, '0') || '. Thanks.',
             encode(sha256(convert_to('perf-msg-' || g, 'UTF8')), 'hex'), 'poll', h.created_at + (g % 5) * interval '1 hour'
        FROM generate_series(1, $3) g JOIN nh ON true JOIN h ON h.rn = 1 + (g % nh.c)`, [o.id, CH[o.key], VOL.messages]));
  }
}

/* ================================================================== measured RPC throughput */
const THR = {};
async function throughput() {
  const nConv = QUICK ? 100 : 500, nIngest = QUICK ? 200 : 1000, nDocs = QUICK ? 100 : 500;
  // 1. convert_request_to_transaction — requests seeded by SQL (the public rate guard is not involved)
  await q(`INSERT INTO public.service_requests (org_id, ref, status, source, tracking_token_hash, client_type, full_name, phone, direction, mode, port, goods, created_at)
           SELECT $1, 'PRQ-2026-' || lpad(g::text, 6, '0'), 'under_review', 'web', encode(sha256(convert_to('perf-req-' || g, 'UTF8')), 'hex'), 'business',
                  'طالب أداء ' || g, '05' || lpad((20000000 + g)::text, 8, '0'), 'import', 'sea', 'ميناء جدة الإسلامي', 'بضاعة طلب أداء ' || g, now()
             FROM generate_series(1, $2) g`, [A, nConv]);
  const reqs = (await q(`SELECT id FROM public.service_requests WHERE org_id = $1 AND ref LIKE 'PRQ-2026-%' ORDER BY ref`, [A])).map(r => r.id);
  const cl = (await one(`SELECT id FROM public.clients WHERE org_id = $1 ORDER BY id LIMIT 1`, [A])).id;
  let ms = [], t0 = now(), errs = 0, firstErr = null;
  for (const id of reqs) {
    const t = now();
    try { await rpc('adminA', `SELECT public.convert_request_to_transaction($1, $2, $3, NULL) r`, [id, JED, cl]); }
    catch (e) { errs++; firstErr = firstErr || errText(e); }
    ms.push(now() - t);
  }
  THR.convert = { label: 'convert_request_to_transaction (staff, one call each)', n: reqs.length, errors: errs, total_ms: now() - t0, stats: stats(ms), firstErr };
  // 2. msg_ingest_messages — batches of 50 (service role)
  ms = []; t0 = now(); errs = 0; firstErr = null;
  for (let b = 0; b < nIngest / 50; b++) {
    const batch = [];
    for (let i = 0; i < 50; i++) {
      const n = b * 50 + i;
      batch.push({ provider_message_id: 'perf-ingest-' + n, kind: 'email', from: { address: 'agent' + (n % 40) + '@perf-agent.example', name: 'Agent' },
        to: [{ address: 'inbox-a@g7perf.example' }], cc: [], sent_at: '2026-11-02T08:00:00Z', subject: 'Status ' + n,
        body_text: 'Please confirm container PRFU' + String(n).padStart(7, '0') + ' status for B/L PRFBL' + String(n % 5000).padStart(8, '0') + '.',
        headers: { message_id: '<perf-' + n + '@perf-agent.example>' }, auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [], raw: { provider: 'mock' } });
    }
    const t = now();
    try { await rpc('service', `SELECT public.msg_ingest_messages($1, $2) r`, [CH.A, JSON.stringify(batch)]); }
    catch (e) { errs++; firstErr = firstErr || errText(e); }
    ms.push(now() - t);
  }
  THR.ingest = { label: 'msg_ingest_messages (service role, batch of 50)', n: nIngest, batches: ms.length, errors: errs, total_ms: now() - t0, stats: stats(ms), firstErr };
  // 3. document inserts — staff, PostgREST-style INSERT (RLS + triggers)
  const txs = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 AND branch_id = $2 ORDER BY id LIMIT $3`, [A, JED, nDocs])).map(r => r.id);
  ms = []; t0 = now(); errs = 0; firstErr = null;
  for (let i = 0; i < txs.length; i++) {
    const id = ID(0x100000 + i);
    const t = now();
    try {
      await as('clrA', `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes)
                        VALUES ($1, $2, $3, 'packing_list', $4, $5, 'pl.pdf', 'application/pdf', 120000)`,
        [id, A, txs[i], `${A}/${txs[i]}/${id}/pl.pdf`, require('crypto').createHash('sha256').update('perf-ins-' + i).digest('hex')]);
    } catch (e) { errs++; firstErr = firstErr || errText(e); }
    ms.push(now() - t);
  }
  THR.docs = { label: 'documents INSERT (clearance staff, RLS)', n: txs.length, errors: errs, total_ms: now() - t0, stats: stats(ms), firstErr };
  for (const k of Object.keys(THR)) {
    const x = THR[k];
    const rate = x.n / (x.total_ms / 1000);
    x.per_sec = rate;
    if (x.errors) fail('throughput ' + x.label, x.errors + ' error(s), first: ' + x.firstErr);
    else pass(`throughput ${x.label}: ${x.n} in ${f1(x.total_ms)} ms (${f1(rate)}/s; call p50 ${f1(x.stats.p50)} p95 ${f1(x.stats.p95)} ms)`);
  }
}

/* ================================================================== latency */
const LAT = [];
let hasG7 = false;
async function latency() {
  const txA = (await one(`SELECT id FROM public.transactions WHERE org_id = $1 AND branch_id = $2 ORDER BY created_at DESC LIMIT 1`, [A, JED])).id;
  const thA = (await one(`SELECT id FROM public.msg_threads WHERE org_id = $1 AND branch_id = $2 ORDER BY message_count DESC, id LIMIT 1`, [A, JED])).id;
  const period = { from: '2026-01-01', to: '2026-10-31' };
  const CASES = [
    ['search_records', 'org', `SELECT public.search_records($1, $2) r`, o => [o.id, { q: 'PRFBL00000123' }]],
    ['search_records (empty filter)', 'org', `SELECT public.search_records($1, '{}') r`, o => [o.id]],
    ['report_transactions', 'org', `SELECT public.report_transactions($1, $2) r`, o => [o.id, period]],
    ['report_containers', 'org', `SELECT public.report_containers($1, $2) r`, o => [o.id, period]],
    ['report_trips (empty path: no trips generated)', 'org', `SELECT public.report_trips($1, $2) r`, o => [o.id, period], 'empty'],
    ['dash_ops', 'org', `SELECT public.dash_ops($1, '{}') r`, o => [o.id]],
    ['dash_finance', 'org', `SELECT public.dash_finance($1, '{"currency":"SAR"}') r`, o => [o.id]],
    ['dash_management', 'org', `SELECT public.dash_management($1, $2) r`, o => [o.id, period]],
    ['list_msg_threads', 'org', `SELECT public.list_msg_threads($1, '{}') r`, o => [o.id]],
    ['get_msg_thread', 'org', `SELECT public.get_msg_thread($1) r`, () => [thA]],
    ['tx_checklist (early path: no requirements configured for the generated transactions)', 'org', `SELECT public.tx_checklist($1) r`, () => [txA], 'empty'],
    ['margin_report', 'org', `SELECT public.margin_report($1, $2) r`, o => [o.id, period]]
  ];
  const o = ORGS[0];
  // review fix: only these finance views may refuse a branch manager by role; any other refusal is a FAIL
  const ROLE_REFUSABLE = new Set(['margin_report', 'dash_finance']);
  // review fix: a latency number must describe the RPC under volume, not an early exit: the first result must carry data
  // (some non-empty array or some positive number anywhere in the JSON), except the documented empty-path case
  const hasData = v => Array.isArray(v) ? v.length > 0 || v.some(hasData)
    : (v && typeof v === 'object') ? Object.values(v).some(hasData) : (typeof v === 'number' ? v > 0 : (typeof v === 'string' && /^[0-9.]+$/.test(v) ? Number(v) > 0 : false));
  for (const [name, , sql, argf, shape] of CASES) {
    for (const who of ['adminA', 'branchA']) {
      const ms = [];
      let err = null, first;
      for (let i = 0; i < RUNS; i++) {
        const t = now();
        try { const r = await rpc(who, sql, argf(o)); if (i === 0) first = r; } catch (e) { err = err || errText(e); }
        ms.push(now() - t);
      }
      const role = who === 'adminA' ? 'org admin' : 'branch manager (JED)';
      if (err && !(who === 'branchA' && ROLE_REFUSABLE.has(name) && /MRS_FORBIDDEN/.test(err))) { fail(`latency ${name} as ${role}`, err); continue; }
      if (!err && shape !== 'empty' && !hasData(first)) { fail(`latency ${name} as ${role}: result carries data`, 'empty / trivial result: ' + J(first).slice(0, 160)); continue; }
      const st = stats(ms);
      LAT.push({ rpc: name, role, refused: !!err, ...st });
      if (err) { pass(`latency ${name} as ${role}: refused by role (MRS_FORBIDDEN), ${RUNS} runs p50 ${f1(st.p50)} ms`); continue; }
      if (st.p95 > P95_SOFT_MS) warn(`latency ${name} as ${role}`, `p95 ${f1(st.p95)} ms > ${P95_SOFT_MS} ms (PGlite indicator)`);
      else pass(`latency ${name} as ${role}: p50 ${f1(st.p50)} / p95 ${f1(st.p95)} / max ${f1(st.max)} ms`);
    }
  }
  if (hasG7) {
    const ms = []; let err = null;
    for (let i = 0; i < RUNS; i++) { const t = now(); try { await rpc('platform', `SELECT public.platform_list_subscriptions() r`); } catch (e) { err = err || errText(e); } ms.push(now() - t); }
    if (err) fail('latency platform_list_subscriptions as platform admin', err);
    else {
      const st = stats(ms);
      LAT.push({ rpc: 'platform_list_subscriptions', role: 'platform admin', refused: false, ...st });
      if (st.p95 > P95_SOFT_MS) warn('latency platform_list_subscriptions', `p95 ${f1(st.p95)} ms`); else pass(`latency platform_list_subscriptions as platform admin: p50 ${f1(st.p50)} / p95 ${f1(st.p95)} ms`);
    }
  } else if (!QUIET) console.log('  (platform_list_subscriptions not measured: G7 migration absent — see catalog check)');
}

/* ================================================================== EXPLAIN plan verdicts */
const PLANS = [];
function scans(node, acc) {
  acc = acc || [];
  if (!node) return acc;
  if (node['Node Type']) acc.push({ type: node['Node Type'], rel: node['Relation Name'] || null, index: node['Index Name'] || null, filter: node['Filter'] || null });
  for (const k of ['Plans']) if (Array.isArray(node[k])) for (const c of node[k]) scans(c, acc);
  return acc;
}
const BIG = ['transactions', 'containers', 'msg_threads', 'msg_messages', 'transaction_events', 'audit_log'];
async function plans() {
  const tx = (await one(`SELECT id FROM public.transactions WHERE org_id = $1 AND branch_id = $2 ORDER BY id LIMIT 1`, [A, JED])).id;
  const th = (await one(`SELECT id FROM public.msg_threads WHERE org_id = $1 ORDER BY id LIMIT 1`, [A])).id;
  const P = [
    ['transactions: org + branch + status (queues, dash_ops)', 'transactions', `SELECT id FROM public.transactions WHERE org_id = $1 AND branch_id = $2 AND operational_status = 'in_progress'`, [A, JED]],
    ['transactions: org + created_at month (report_transactions period)', 'transactions', `SELECT id FROM public.transactions WHERE org_id = $1 AND created_at >= '2026-03-01' AND created_at < '2026-04-01'`, [A]],
    ['transactions: org + ref (search exact ref)', 'transactions', `SELECT id FROM public.transactions WHERE org_id = $1 AND ref = 'MRS-2026-000123'`, [A]],
    ['transactions: org + bl_number (matching / search)', 'transactions', `SELECT id FROM public.transactions WHERE org_id = $1 AND bl_number = 'PRFBL00000123'`, [A]],
    ['transactions: org + eta range', 'transactions', `SELECT id FROM public.transactions WHERE org_id = $1 AND eta BETWEEN '2026-05-01' AND '2026-05-07'`, [A]],
    ['containers: by transaction (tx detail, tx_checklist)', 'containers', `SELECT id FROM public.containers WHERE transaction_id = $1`, [tx]],
    ['containers: org + container_no (matching / search)', 'containers', `SELECT id FROM public.containers WHERE org_id = $1 AND container_no = 'PRFU0000123'`, [A]],
    ['containers: org + open return deadline (alerts, dash_ops)', 'containers', `SELECT id FROM public.containers WHERE org_id = $1 AND return_status IN ('pending','evidence_submitted','disputed') AND return_deadline < '2026-01-15'`, [A]],
    ['msg_threads: org + branch + status, newest first (list_msg_threads)', 'msg_threads', `SELECT id FROM public.msg_threads WHERE org_id = $1 AND branch_id = $2 AND status = 'new' ORDER BY last_message_at DESC LIMIT 50`, [A, JED]],
    ['msg_threads: by transaction (tx_messages)', 'msg_threads', `SELECT id FROM public.msg_threads WHERE transaction_id = $1`, [tx]],
    ['msg_threads: org + match review queue', 'msg_threads', `SELECT id FROM public.msg_threads WHERE org_id = $1 AND match_status IN ('suggested','review')`, [A]],
    ['msg_messages: by thread (get_msg_thread)', 'msg_messages', `SELECT id FROM public.msg_messages WHERE thread_id = $1 ORDER BY received_at`, [th]],
    ['msg_messages: org + sender (sender history / matching)', 'msg_messages', `SELECT id FROM public.msg_messages WHERE org_id = $1 AND from_address_norm = 'agent7@perf-agent.example'`, [A]],
    ['transaction_events: by transaction (timeline, portal)', 'transaction_events', `SELECT id FROM public.transaction_events WHERE transaction_id = $1 ORDER BY created_at`, [tx]],
    ['transaction_events: org + to_status + period (dash_management)', 'transaction_events', `SELECT transaction_id FROM public.transaction_events WHERE org_id = $1 AND event_type = 'operational_status' AND to_status = 'closed' AND created_at >= '2026-03-01' AND created_at < '2026-04-01'`, [A]],
    ['audit_log: org, newest first (admin_audit_log)', 'audit_log', `SELECT id FROM public.audit_log WHERE org_id = $1 ORDER BY at DESC LIMIT 50`, [A]],
    ['audit_log: org + period (admin_audit_log from/to)', 'audit_log', `SELECT id FROM public.audit_log WHERE org_id = $1 AND at >= now() - interval '1 day' ORDER BY at DESC LIMIT 50`, [A]],
    ['audit_log: by row (record history)', 'audit_log', `SELECT id FROM public.audit_log WHERE table_name = 'transactions' AND row_id = $1`, [tx]]
  ];
  // advisory (not a hard gate): monthly counts the G7 recount runs per org (rare, platform-admin action)
  const ADV = [
    ['ADVISORY msg_messages: org + month (G7 recount messages_month)', 'msg_messages', `SELECT count(*) FROM public.msg_messages WHERE org_id = $1 AND received_at >= '2026-03-01' AND received_at < '2026-04-01'`, [A]],
    ['ADVISORY transactions: org + month count (G7 recount transactions_month)', 'transactions', `SELECT count(*) FROM public.transactions WHERE org_id = $1 AND created_at >= '2026-03-01' AND created_at < '2026-04-01'`, [A]]
  ];
  const hard = SCALE >= 1;
  for (const [label, table, sql, params, advisory] of P.concat(ADV.map(x => x.concat([true])))) {
    let plan;
    try { plan = (await q('EXPLAIN (FORMAT JSON) ' + sql, params))[0]['QUERY PLAN'][0].Plan; }
    catch (e) { fail('EXPLAIN ' + label, errText(e)); continue; }
    const sc = scans(plan);
    const seq = sc.filter(s => s.type === 'Seq Scan' && BIG.includes(s.rel));
    const idx = [...new Set(sc.filter(s => s.index).map(s => s.index))];
    const verdict = seq.length ? 'Seq Scan' : 'index';
    const residual = sc.some(s => s.index && s.filter);
    PLANS.push({ label, table, verdict, indexes: idx, node: plan['Node Type'], cost: plan['Total Cost'], advisory: !!advisory, residual });
    const desc = `${verdict}${idx.length ? ' (' + idx.join(', ') + ')' : ''}`;
    if (!seq.length) pass(`plan ${label}: ${desc}`);
    else if (advisory) warn(`plan ${label}`, `${desc} — advisory, reported in open issues`);
    else if (hard) fail(`plan ${label}`, `Seq Scan on ${seq.map(s => s.rel).join(', ')} at scale ${SCALE} — missing index (report to DB agent, never added here)`);
    else warn(`plan ${label}`, `Seq Scan on ${seq.map(s => s.rel).join(', ')} at scale ${SCALE} (< 1: tiny tables may be scanned; hard gate only at full scale)`);
  }
}

/* ================================================================== storage bytes per entity */
const BYTES = [];
async function bytesPerEntity() {
  const tables = ['transactions', 'containers', 'transaction_events', 'documents', 'msg_threads', 'msg_messages', 'audit_log', 'supplier_invoices', 'clients',
    'service_requests', 'bills_of_lading', 'transaction_bls', 'msg_jobs', 'org_usage_counters'];
  for (const t of tables) {
    const r = await one(`SELECT to_regclass('public.' || $1) IS NOT NULL ok`, [t]);
    if (!r.ok) continue;
    const x = await one(`SELECT count(*)::bigint n, pg_total_relation_size('public.' || $1)::bigint total, pg_relation_size('public.' || $1)::bigint heap FROM public.${t}`, [t]);
    const n = Number(x.n);
    BYTES.push({ table: t, rows: n, total: Number(x.total), heap: Number(x.heap), per_row: n ? Number(x.total) / n : null });
  }
  // G7 counters: one row per org / metric / month is UPDATEd by every counted insert (hot row) → dead tuples until VACUUM
  if ((await one(`SELECT to_regclass('public.org_usage_counters') IS NOT NULL ok`)).ok) {
    const b0 = Number((await one(`SELECT pg_total_relation_size('public.org_usage_counters')::bigint s`)).s);
    await db.exec('VACUUM public.org_usage_counters');
    const b1 = Number((await one(`SELECT pg_total_relation_size('public.org_usage_counters')::bigint s`)).s);
    const n = Number((await one(`SELECT count(*)::bigint n FROM public.org_usage_counters`)).n);
    BYTES.counters = { before: b0, after: b1, rows: n };
    pass(`org_usage_counters: ${n} rows, ${f1(b0 / 1024)} KB before VACUUM → ${f1(b1 / 1024)} KB after (per-insert UPDATE of one hot row per org / metric / month)`);
  }
  const tot = await one(`SELECT pg_database_size(current_database())::bigint s`);
  BYTES.db_size = Number(tot.s);
  pass(`storage bytes per entity measured for ${BYTES.length} tables (database ${f1(BYTES.db_size / 1048576)} MB)`);
}

/* ================================================================== result document */
function writeDoc(env) {
  const L = [];
  L.push('# G7 — نتائج الأداء على PGlite (G7_PERF_RESULTS)');
  L.push('');
  L.push('> **ملف مُولَّد** بواسطة `supabase/tests/g7-perf.js --write` — لا يُحرَّر يدويًا. الأرقام **مؤشرات لا اتفاقيات مستوى خدمة** (القرار G7-16).');
  L.push('> اختبار الحمل الفعلي على Supabase (staging tier): **قيد انتظار المالك (OWNER-PENDING)**.');
  L.push('');
  L.push('## البيئة');
  L.push('');
  L.push('- **PGlite in Node, single connection — indicator only** (Postgres 16 مُجمَّع WASM، اتصال واحد، بلا شبكة، بلا تزامن حقيقي).');
  L.push(`- Run at: ${env.runAt} · Node ${process.version} · ${os.platform()} ${os.arch()} · CPU: ${env.cpu}`);
  L.push(`- Scale: ${SCALE}${QUICK ? ' (--quick)' : ''} · latency runs per RPC: ${RUNS} · G7 migration: ${hasG7 ? 'present' : 'ABSENT'}`);
  L.push(`- Build time: migrations ${f1(env.loadMs / 1000)} s · bulk volume ${f1(env.bulkMs / 1000)} s · whole run ${f1(env.totalMs / 1000)} s`);
  L.push('');
  L.push('## الحجم المُولَّد (لكل مؤسسة × 2)');
  L.push('');
  L.push('| الكيان | لكل مؤسسة (مطلوب) | الإجمالي الفعلي في القاعدة |');
  L.push('|---|---:|---:|');
  for (const [k, label, t] of [['tx', 'transactions', 'transactions'], ['containers', 'containers', 'containers'], ['threads', 'msg_threads', 'msg_threads'],
    ['messages', 'msg_messages', 'msg_messages'], ['events_extra', 'transaction_events (extra; + trigger events)', 'transaction_events'], ['documents', 'documents', 'documents'],
    ['invoices', 'supplier_invoices', 'supplier_invoices']]) {
    const b = BYTES.find(x => x.table === t);
    L.push(`| ${label} | ${VOL[k]} | ${b ? b.rows : '—'} |`);
  }
  const al = BYTES.find(x => x.table === 'audit_log');
  L.push(`| audit_log (triggers) | — | ${al ? al.rows : '—'} |`);
  L.push('');
  L.push('## الإنتاجية المقاسة (RPC throughput)');
  L.push('');
  L.push('| العملية | العدد | الأخطاء | الزمن الكلي (ms) | المعدل (/s) | p50 للنداء (ms) | p95 (ms) | max (ms) |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of Object.keys(THR)) {
    const x = THR[k];
    L.push(`| ${x.label} | ${x.n} | ${x.errors} | ${f1(x.total_ms)} | ${f1(x.per_sec)} | ${f1(x.stats.p50)} | ${f1(x.stats.p95)} | ${f1(x.stats.max)} |`);
  }
  L.push('');
  L.push(`## زمن الاستجابة (${RUNS} تشغيلًا لكل حالة)`);
  L.push('');
  L.push(`الحد المرن: p95 ≤ ${P95_SOFT_MS} ms على PGlite (WARN لا FAIL).`);
  L.push('');
  L.push('| RPC | الدور | p50 (ms) | p95 (ms) | max (ms) | الحكم |');
  L.push('|---|---|---:|---:|---:|---|');
  for (const x of LAT) {
    const v = x.refused ? 'مرفوض بالدور (MRS_FORBIDDEN) — سلوك موثق' : x.p95 > P95_SOFT_MS ? 'WARN' : 'ضمن الحد';
    L.push(`| ${x.rpc} | ${x.role} | ${f1(x.p50)} | ${f1(x.p95)} | ${f1(x.max)} | ${v} |`);
  }
  if (!hasG7) L.push('| platform_list_subscriptions | platform admin | — | — | — | لم يُقس: ترحيل G7 غير موجود |');
  L.push('');
  L.push('ملاحظات: `report_trips` لا رحلات في الحجم المُولَّد (قائمة الحجم في المواصفة لا تشملها) فهو يقيس كلفة المسار الفارغ فقط، و`tx_checklist` بلا متطلبات مستندات مُعدّة للمعاملات المولَّدة فيقيس المسار المبكر فقط (كلاهما موسوم في الجدول)؛ كل حالة أخرى يُتحقق أن نتيجتها تحمل بيانات، ولا يُقبل رفض بالدور إلا لـ `margin_report` و`dash_finance`؛ `platform_list_subscriptions` على مؤسستين فقط؛ «branch manager» مقيد بفرع JED (نصف معاملات المؤسسة تقريبًا).');
  L.push('');
  L.push('## خطط التنفيذ (EXPLAIN FORMAT JSON)');
  L.push('');
  L.push(`بوابة صلبة: لا Seq Scan على الجداول الكبيرة للمسندات الأساسية المفلترة بالمؤسسة${SCALE >= 1 ? '' : ' — **هذا التشغيل أصغر من الحجم الكامل؛ البوابة تُطبَّق كتحذير فقط**'}.`);
  L.push('');
  L.push('| المسند | الجدول | الحكم | الفهارس المستخدمة | ترشيح بعد الفهرس | عقدة الجذر |');
  L.push('|---|---|---|---|---|---|');
  for (const p of PLANS) L.push(`| ${p.label} | ${p.table} | ${p.verdict === 'index' ? 'index' : (p.advisory ? 'Seq Scan (استشاري)' : 'Seq Scan')} | ${p.indexes.join(', ') || '—'} | ${p.residual ? 'نعم (الفهرس يغطي جزءًا من المسند)' : 'لا'} | ${p.node} |`);
  L.push('');
  L.push('## بايتات التخزين لكل كيان (تغذي نموذج التكلفة)');
  L.push('');
  L.push('`pg_total_relation_size` (الجدول + الفهارس + TOAST) ÷ عدد الصفوف. على Postgres المُدار تختلف القيم قليلًا (fillfactor، bloat، WAL).');
  L.push('');
  L.push('| الجدول | الصفوف | الحجم الكلي (KB) | الجدول فقط (KB) | بايت/صف (شامل الفهارس) |');
  L.push('|---|---:|---:|---:|---:|');
  for (const b of BYTES) L.push(`| ${b.table} | ${b.rows} | ${f1(b.total / 1024)} | ${f1(b.heap / 1024)} | ${b.per_row === null ? '—' : Math.round(b.per_row)} |`);
  L.push('');
  L.push(`حجم القاعدة الكلي بعد التشغيل: ${f1(BYTES.db_size / 1048576)} MB.`);
  if (BYTES.counters) {
    L.push('');
    L.push(`ملاحظة G7: \`org_usage_counters\` (${BYTES.counters.rows} صفًا) بلغ ${f1(BYTES.counters.before / 1024)} KB قبل VACUUM و ${f1(BYTES.counters.after / 1024)} KB بعده — كل إدراج محسوب يحدّث صفًا واحدًا لكل مؤسسة / مقياس / شهر (صف ساخن)، فتتراكم نسخ ميتة؛ VACUUM العادي يجعل المساحة قابلة لإعادة الاستخدام ولا يصغّر الملف (لذا الرقمان متقاربان)، والنمو يتوقف بعد autovacuum. وتتسلسل الإدراجات المتزامنة على قفل ذلك الصف (البند المفتوح ٢ في G7_SPEC). قيمة «بايت/صف» أعلاه لهذا الجدول لا تُستخدم في نموذج التكلفة.`);
  }
  L.push('');
  L.push('## الأحكام');
  L.push('');
  L.push(`- ${nPass} passed, ${nFail} failed, ${nWarn} warnings.`);
  for (const f of fails) L.push(`- FAIL: ${f}`);
  for (const w of warns) L.push(`- WARN: ${w}`);
  L.push('');
  L.push('## ما لا تثبته هذه الأرقام');
  L.push('');
  L.push('- لا تزامن: PGlite اتصال واحد؛ قفل عدادات الباقات (G7) وتنافس الكتابة لا يظهران هنا.');
  L.push('- لا شبكة ولا PostgREST ولا Edge Functions: زمن الشبكة وحدود Supabase (connections، compute tier) غير مقاسة.');
  L.push('- اختبار الحمل على staging وتسعير الطبقة: **قيد انتظار المالك (OWNER-PENDING)** — الإجراء في `G7_COST_MODEL_AR.md`.');
  L.push('');
  const file = path.join(ROOT, 'docs', 'online', 'G7_PERF_RESULTS.md');
  fs.writeFileSync(file, L.join('\n'));
  console.log('  wrote ' + path.relative(ROOT, file));
}

/* ================================================================== main */
async function main() {
  const T0 = now();
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section(`load shim + migrations + seed (scale ${SCALE}${QUICK ? ', --quick' : ''})`);
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(G6B_MIGRATION)) { fail('G6b migration present', G6B_MIGRATION + ' not found'); return finish(); }
  const tl = now();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  const loadMs = now() - tl;
  section('0. catalog check (G7 objects)');
  hasG7 = !!(await one(`SELECT to_regprocedure('public.platform_list_subscriptions()') IS NOT NULL ok`)).ok;
  if (hasG7) pass('G7 migration loaded (platform_list_subscriptions present)');
  else fail('G7 migration loaded', G7_MIGRATION + ' absent: platform_list_subscriptions not measured (report clearly; the rest of the suite runs)');
  try { await fixtures(); pass('fixtures: org B «org-g7p», 2 branches, admins, branch managers, clearance staff, platform admin'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }

  section(`1. synthetic volume (per org: ${VOL.tx} tx, ${VOL.containers} containers, ${VOL.threads} threads, ${VOL.messages} messages, ${VOL.documents} documents)`);
  const tb = now();
  try {
    await bulk();
    await channels();
    await bulkMessages();
    if (hasG7) await timed('g7_recount (all orgs)', () => q(`SELECT app.g7_recount(id) FROM public.organizations`));
    await timed('ANALYZE', () => db.exec('ANALYZE'));
  } catch (e) { fail('synthetic volume', errText(e)); return finish(); }
  const bulkMs = now() - tb;
  await check('volume reached: transactions / containers / messages per org', async () => {
    const r = await q(`SELECT o.id, (SELECT count(*) FROM public.transactions t WHERE t.org_id = o.id)::int tx,
                              (SELECT count(*) FROM public.containers c WHERE c.org_id = o.id)::int c,
                              (SELECT count(*) FROM public.msg_messages m WHERE m.org_id = o.id)::int m
                         FROM public.organizations o WHERE o.id IN ($1, $2) ORDER BY o.id`, [A, ORG_B]);
    return r.every(x => x.tx >= VOL.tx && x.c >= VOL.containers && x.m >= VOL.messages) || J(r);
  });
  await check('isolation sanity under volume: branch manager B sees no org A transaction; admin A sees only org A', async () => {
    const b = (await as('branchB', `SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [A]))[0].n;
    const a = (await as('adminA', `SELECT count(DISTINCT org_id)::int n FROM public.transactions`))[0].n;
    return (b === 0 && a === 1) || J({ b, a });
  });

  section('2. measured RPC throughput');
  try { await throughput(); } catch (e) { fail('throughput', errText(e)); }
  await db.exec('ANALYZE');

  section(`3. latency (${RUNS} runs, org admin + branch manager)`);
  try { await latency(); } catch (e) { fail('latency', errText(e)); }

  section('4. EXPLAIN plan verdicts');
  try { await plans(); } catch (e) { fail('plans', errText(e)); }

  section('5. storage bytes per entity');
  try { await bytesPerEntity(); } catch (e) { fail('bytes per entity', errText(e)); }

  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)'); else pass('no network call (fetch trap untouched)');
  if (WRITE) writeDoc({ runAt: new Date().toISOString(), cpu: (os.cpus()[0] || {}).model || 'unknown', loadMs, bulkMs, totalMs: now() - T0 });
  console.log(`\n  total runtime ${f1((now() - T0) / 1000)} s`);
  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  if (warns.length) { console.log('WARNINGS:'); warns.forEach(w => console.log('  - ' + w)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed, ${nWarn} warnings`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

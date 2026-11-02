/*
  Marsa (مرسى) — G7 shared operational-cycle step library (docs/online/G7_SPEC.md § Tests). LOCAL TESTS ONLY.
  Used by g7-e2e-tests.js (steps ٣ + ٤) and g7-second-org-tests.js (step ٢). PGlite only: never Supabase.

  The suites own the harness (helper block copied from g6b-cycle-tests.js) and pass it in as H:
    H = { q, one, num, rpc, as, asService, step, check, expectErr, pass, fail, section, errText, J, newKey, users }
  This module only builds on those helpers. It calls the same RPCs the UI calls (as authenticated users),
  the REAL daftra-sync worker + mock adapter and the REAL inbox-sync worker + mocks (as service_role).
  Superuser SQL is used only for: auth users (seed-style), reading results, and moving time / queues
  (next_run_at, enqueueing a poll for ONE org's channel so another org's state is never touched).

  Org context (built by the suite):
    { key, id, slug, prefix, br1, br2, users: {admin, ops, clr, trn, acc, mgr, bm, client}, tag, d: {} }
    users.* are keys of H.users (the suite's U map). `d` collects ids along the cycle.
*/
'use strict';
const fs = require('fs');
const path = require('path');

const DAY = 86400e3;
const day = d => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const hrs = h => new Date(Date.now() + h * 3600e3).toISOString();
const N = x => (x === null || x === undefined) ? x : Number(x);
const cents = x => Math.round(Number(x || 0) * 100);

/* ------------------------------------------------------------------ ISO 6346 container numbers (valid check digit) */
const ISO_MAP = (() => {
  const m = {}; let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (v % 11 === 0) v++; m[ch] = v++; }
  for (let i = 0; i < 10; i++) m[String(i)] = i;
  return m;
})();
function isoContainer(owner4, serial6) {
  const base = owner4.slice(0, 4).toUpperCase() + String(serial6).padStart(6, '0');
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += ISO_MAP[base[i]] * Math.pow(2, i);
  return base + String((sum % 11) % 10);
}

/* ------------------------------------------------------------------ tenant tables (for per-org state hashes) */
async function tenantTables(H) {
  const r = await H.q(`SELECT c.table_name FROM information_schema.columns c
                         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
                        WHERE c.table_schema = 'public' AND c.column_name = 'org_id' ORDER BY 1`);
  return ['organizations'].concat(r.map(x => x.table_name));
}
// count + md5 per tenant table filtered by org (organizations: by id)
async function stateHash(H, orgId, tables) {
  const out = {};
  for (const t of tables) {
    const col = t === 'organizations' ? 'id' : 'org_id';
    const r = await H.one(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM public.${t} x WHERE x.${col} = $1`, [orgId]);
    out[t] = r.n + ':' + r.h;
  }
  return out;
}
function hashDiff(a, b) {
  const d = [];
  for (const k of Object.keys(Object.assign({}, a, b))) if (a[k] !== b[k]) d.push(k + ' ' + (a[k] || '-').split(':')[0] + '→' + (b[k] || '-').split(':')[0]);
  return d;
}
// catalog fingerprint: functions (name, args, body), policies, triggers, tables / columns — "no DDL" proof
async function catalogFingerprint(H) {
  const r = await H.one(`SELECT
    (SELECT md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || md5(p.prosrc) || p.prosecdef::text || coalesce(array_to_string(p.proconfig, ','), ''), '|' ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','app','storage','auth')) f,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','app')) fn,
    (SELECT md5(string_agg(schemaname || '.' || tablename || '.' || policyname || cmd || coalesce(qual, '') || coalesce(with_check, '') || roles::text, '|' ORDER BY schemaname, tablename, policyname)) FROM pg_policies) p,
    (SELECT count(*)::int FROM pg_policies) pn,
    (SELECT md5(string_agg(c.relname || '.' || t.tgname || t.tgenabled::text || pg_get_triggerdef(t.oid), '|' ORDER BY c.relname, t.tgname)) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal) t,
    (SELECT count(*)::int FROM pg_trigger t WHERE NOT t.tgisinternal) tn,
    (SELECT md5(string_agg(table_schema || '.' || table_name || '.' || column_name || data_type || coalesce(column_default, ''), '|' ORDER BY table_schema, table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema IN ('public','app','storage')) c,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_schema IN ('public','app','storage')) tb`);
  return r;
}

/* ------------------------------------------------------------------ workers (real daftra-sync + inbox-sync, mocks) */
function createWorkers(H, root) {
  const SUPA = path.join(root, 'supabase');
  const DF = path.join(SUPA, 'functions', 'daftra-sync');
  const IN = path.join(SUPA, 'functions', 'inbox-sync');
  const DAD = require(path.join(DF, 'adapter.js'));
  const { createMockAdapter } = require(path.join(DF, 'mock-adapter.js'));
  const DWK = require(path.join(DF, 'worker.js'));
  const AD = require(path.join(IN, 'adapters.js'));
  const ME = require(path.join(IN, 'mock-email.js'));
  const MW = require(path.join(IN, 'mock-whatsapp.js'));
  const AI = require(path.join(IN, 'ai-mock.js'));
  const PL = require(path.join(IN, 'pipeline.js'));
  const IWK = require(path.join(IN, 'worker.js'));
  const DEPS = Object.assign({}, AD, AI, PL);
  const FIXED_CLOCK = () => '2026-11-02T09:00:00.000Z';
  const CLOCK = () => new Date().toISOString();

  /* daftra */
  const DTYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_org: 'uuid', p_state: 'jsonb', p_version: 'int' };
  async function dsvc(name, argsObj) {
    if (!/^daftra_[a-z_]+$/.test(name)) throw new Error('daftra worker may call only daftra_* service RPCs, got ' + name);
    const keys = Object.keys(argsObj || {});
    const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${DTYPES[k] || 'text'}`).join(', ')}) r`;
    const vals = keys.map(k => (DTYPES[k] === 'jsonb' ? JSON.stringify(argsObj[k]) : argsObj[k]));
    return H.asService(async () => (await H.q(sql, vals))[0].r);
  }
  const dmocks = {};
  const dUse = [];
  function dAdapterFor(connection, orgId) {
    const m = dmocks[orgId];
    if (!m) throw new Error('no Daftra mock for org ' + orgId);
    if (connection && connection.mode === 'live_pending') return DAD.createRealAdapter({});
    dUse.push({ job_org: orgId, adapter_org: m.orgId });
    return m;
  }
  const dworker = DWK.createWorker({ rpc: dsvc, adapterFor: dAdapterFor, workerId: 'g7-daftra-worker', clock: FIXED_CLOCK, deps: DAD });
  async function drunAll(max) {
    const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, frozen: 0, errors: 0, results: [] };
    for (let i = 0; i < (max || 20); i++) {
      const r = await dworker.runOnce({ limit: 5 });
      for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
      tot.results.push(...r.results);
      if (!r.claimed) break;
    }
    if (tot.errors) throw new Error('daftra complete_job errors: ' + JSON.stringify(tot.results.filter(x => x.complete_error)));
    return tot;
  }
  function daftraMock(orgId) { if (!dmocks[orgId]) dmocks[orgId] = createMockAdapter({ orgId, deps: DAD, clock: FIXED_CLOCK }); return dmocks[orgId]; }

  /* inbox */
  const ITYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_channel: 'uuid', p_state: 'jsonb', p_version: 'int', p_messages: 'jsonb', p_events: 'jsonb' };
  const ISVC = ['msg_ingest_messages', 'msg_record_delivery', 'msg_claim_jobs', 'msg_complete_job', 'msg_renew_lease', 'msg_schedule', 'msg_mock_load', 'msg_mock_save'];
  const claimed = [];
  async function isvc(name, argsObj) {
    if (!ISVC.includes(name)) throw new Error('inbox worker may call only msg_* service RPCs, got ' + name);
    const keys = Object.keys(argsObj || {});
    const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${ITYPES[k] || 'text'}`).join(', ')}) r`;
    const vals = keys.map(k => (ITYPES[k] === 'jsonb' ? JSON.stringify(argsObj[k]) : argsObj[k]));
    const r = await H.asService(async () => (await H.q(sql, vals))[0].r);
    if (name === 'msg_claim_jobs') for (const c of (r || [])) claimed.push(c);
    return r;
  }
  const imocks = {}, imockOrg = {};
  const iUse = [];
  function iAdapterFor(channel, orgId) {
    const m = imocks[channel.id];
    if (!m) throw new Error('no inbox mock for channel ' + channel.id);
    if (channel.mode === 'live_pending') return channel.kind === 'whatsapp' ? AD.createLiveWhatsAppAdapter({}) : AD.createLiveEmailAdapter({});
    iUse.push({ job_org: orgId, channel_org: imockOrg[channel.id] });
    return m;
  }
  const iworker = IWK.createWorker({ rpc: isvc, adapterFor: iAdapterFor, provider: AI.createRuleProvider({ clock: CLOCK }), workerId: 'g7-inbox-worker', clock: CLOCK, deps: DEPS });
  async function irunAll(max) {
    const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, errors: 0, results: [] };
    for (let i = 0; i < (max || 30); i++) {
      const r = await iworker.runOnce({ limit: 5 });
      for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
      tot.results.push(...r.results);
      if (!r.claimed) break;
    }
    if (tot.errors) throw new Error('inbox complete_job errors: ' + JSON.stringify(tot.results.filter(x => x.complete_error)));
    return tot;
  }
  function inboxMock(channel, orgId, address) {
    imocks[channel.id] = channel.kind === 'whatsapp'
      ? MW.createMockWhatsApp({ channelAddress: address, clock: CLOCK, deps: AD })
      : ME.createMockEmail({ channelAddress: address, clock: CLOCK, deps: AD });
    imockOrg[channel.id] = orgId;
    return imocks[channel.id];
  }
  // poll ONE org's channels: the job is enqueued for that org only (msg_schedule would poll every org's channels)
  async function pollOrg(orgId) {
    const ch = await H.q(`SELECT id FROM public.msg_channels WHERE org_id = $1 AND status = 'connected' AND ingest_enabled ORDER BY created_at`, [orgId]);
    for (const c of ch) await H.q(`SELECT app.msg_enqueue($1, 'poll', $2, NULL, NULL, NULL, NULL, '{}'::jsonb, NULL)`, [orgId, c.id]);
    await H.q(`UPDATE public.msg_jobs SET next_run_at = now() WHERE org_id = $1 AND status IN ('queued','unknown')`, [orgId]);
    return irunAll();
  }
  const dwake = orgId => H.q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE org_id = $1 AND status IN ('queued','unknown')`, [orgId]);

  return { DAD, AD, ME, MW, AI, PL, DEPS, dmocks, dUse, drunAll, dwake, daftraMock, imocks, imockOrg, iUse, irunAll, inboxMock, pollOrg, claimed,
    fetchFree: true };
}

/* ------------------------------------------------------------------ evidence snapshots */
async function snapshot(H, orgId) {
  const ev = await H.q(`SELECT id::text id FROM public.transaction_events WHERE org_id = $1`, [orgId]);
  const au = await H.q(`SELECT id::text id FROM public.audit_log WHERE org_id = $1`, [orgId]);
  const bj = await H.q(`SELECT id::text id FROM public.billing_sync_jobs WHERE org_id = $1`, [orgId]);
  const mj = await H.q(`SELECT id::text id FROM public.msg_jobs WHERE org_id = $1`, [orgId]);
  return { ev: new Set(ev.map(x => x.id)), au: new Set(au.map(x => x.id)), bj: new Set(bj.map(x => x.id)), mj: new Set(mj.map(x => x.id)) };
}
const maskRef = s => String(s).replace(/\b([A-Z]{2,5})-(\d{4})-(\d{6})\b/g, '$1-YYYY-$3');
async function evidenceSince(H, orgId, snap) {
  const ev = (await H.q(`SELECT id::text id, event_type, from_status, to_status, visible_to_client, payload ->> 'op' op FROM public.transaction_events WHERE org_id = $1 ORDER BY id`, [orgId]))
    .filter(x => !snap.ev.has(x.id));
  const au = (await H.q(`SELECT id::text id, table_name, action FROM public.audit_log WHERE org_id = $1 ORDER BY id`, [orgId])).filter(x => !snap.au.has(x.id));
  const bj = (await H.q(`SELECT id::text id, kind, status FROM public.billing_sync_jobs WHERE org_id = $1 ORDER BY created_at, id`, [orgId])).filter(x => !snap.bj.has(x.id));
  const mj = (await H.q(`SELECT id::text id, kind, status FROM public.msg_jobs WHERE org_id = $1 ORDER BY created_at, id`, [orgId])).filter(x => !snap.mj.has(x.id));
  const agg = rows => { const m = {}; for (const r of rows) m[r] = (m[r] || 0) + 1; return Object.keys(m).sort().map(k => k + (m[k] > 1 ? ' ×' + m[k] : '')); };
  return {
    events: agg(ev.map(e => e.event_type + (e.op ? ':' + e.op : '') + (e.from_status || e.to_status ? ' ' + (e.from_status || '∅') + '→' + (e.to_status || '∅') : '') + (e.visible_to_client ? ' [client]' : ''))),
    audit: agg(au.map(a => a.table_name + ' ' + a.action)),
    jobs: agg(bj.map(j => 'billing ' + j.kind + ' ' + j.status).concat(mj.map(j => 'msg ' + j.kind + ' ' + j.status))),
    n: { events: ev.length, audit: au.length, jobs: bj.length + mj.length }
  };
}

/* ------------------------------------------------------------------ staff helpers bound to an org */
let docSeq = 0;   // module-wide: document sha256 values stay unique across every orgApi() of a run
function orgApi(H, o) {
  const u = o.users;
  const R = (who, sql, p) => H.rpc(u[who] || who, sql, p);
  async function upload(who, tx, kind, size) {
    const id = (await H.one(`SELECT gen_random_uuid()::text id`)).id;
    docSeq++;
    const sha = (o.tag + docSeq.toString(16)).padStart(64, '0').slice(-64).replace(/[^0-9a-f]/g, '0');
    await H.as(u[who] || who, `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, o.id, tx, kind, `${o.id}/${tx}/${id}/${kind}.pdf`, sha, kind + '.pdf', size || 1000, H.users[u[who] || who]]);
    return id;
  }
  const classify = (who, id, kind) => H.as(u[who] || who, `UPDATE public.documents SET classification = $2, classification_status = 'confirmed' WHERE id = $1`, [id, kind]);
  const status = (who, tx, st, note) => R(who, `SELECT public.set_transaction_status($1, $2, $3, $4) r`, [tx, st, note || null, H.newKey()]);
  const refresh = () => H.one(`SELECT app.refresh_alerts_core($1) r`, [o.id]).then(x => x.r);
  return { R, upload, classify, status, refresh };
}

/* ------------------------------------------------------------------ setup (channels, Daftra, parties) — per org */
async function setupOrg(H, W, o) {
  const A = orgApi(H, o);
  const u = o.users;
  o.d = o.d || {};
  await H.step(`[${o.key}] Daftra connection (mock) saved by the accounts manager + probe`, async () => {
    W.daftraMock(o.id);
    await A.R('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [o.id, { mode: 'mock', subdomain: 'g7-' + o.tag, sync_enabled: true }]);
    await A.R('mgr', `SELECT public.request_daftra_probe($1, $2) r`, [o.id, H.newKey()]);
    await W.dwake(o.id);
    const r = await W.drunAll();
    const c = await H.one(`SELECT status FROM public.daftra_connections WHERE org_id = $1`, [o.id]);
    if (c.status !== 'connected' || r.ok < 1) throw new Error('daftra connection ' + c.status + ' ' + JSON.stringify(r));
  });
  await H.step(`[${o.key}] message channels (mock e-mail + mock WhatsApp, own addresses) saved by the admin + probe`, async () => {
    o.d.chE = await A.R('admin', `SELECT public.save_msg_channel($1, $2, $3) r`, [o.id,
      { kind: 'email', name: 'بريد العمليات', address: o.email, default_branch_id: o.br1, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }, H.newKey()]);
    o.d.chW = await A.R('admin', `SELECT public.save_msg_channel($1, $2, $3) r`, [o.id,
      { kind: 'whatsapp', name: 'واتساب العمليات', address: o.wa, default_branch_id: null, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }, H.newKey()]);
    o.d.ME = W.inboxMock(o.d.chE, o.id, o.email);
    o.d.MW = W.inboxMock(o.d.chW, o.id, o.waNorm);
    for (const ch of [o.d.chE, o.d.chW]) await A.R('admin', `SELECT public.request_msg_channel_probe($1, $2) r`, [ch.id, H.newKey()]);
    await H.q(`UPDATE public.msg_jobs SET next_run_at = now() WHERE org_id = $1 AND status = 'queued'`, [o.id]);
    const r = await W.irunAll();
    const rows = await H.q(`SELECT status FROM public.msg_channels WHERE org_id = $1`, [o.id]);
    if (rows.length !== 2 || !rows.every(x => x.status === 'connected') || r.failed) throw new Error(JSON.stringify(rows) + JSON.stringify(r));
  });
  await H.step(`[${o.key}] directory parties: terminal, yard, carrier (+ driver, truck), port services supplier`, async () => {
    const ins = async (kinds, name) => (await H.as(u.trn, `INSERT INTO public.parties (org_id, kinds, name_ar, vat_number) VALUES ($1, $2, $3, $4) RETURNING id`,
      [o.id, kinds, name, kinds.includes('supplier') ? null : null]))[0].id;
    o.d.terminal = await ins(['terminal_operator'], 'محطة الحاويات ' + o.key);
    o.d.yard = await ins(['yard'], 'ساحة الفوارغ ' + o.key);
    o.d.carrier = await ins(['carrier'], 'شركة النقل ' + o.key);
    o.d.supplier = await ins(['supplier', 'shipping_agent'], 'خدمات الميناء ' + o.key);
    o.d.driver = (await H.as(u.trn, `INSERT INTO public.drivers (org_id, carrier_id, full_name, national_id_last4) VALUES ($1, $2, $3, '4321') RETURNING id`, [o.id, o.d.carrier, 'سائق ' + o.key]))[0].id;
    o.d.truck = (await H.as(u.trn, `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, $3) RETURNING id`, [o.id, o.d.carrier, o.tag.toUpperCase() + ' 7001']))[0].id;
  });
}

/* ------------------------------------------------------------------ the operational cycle (plan step ٣) */
// returns [{id, title, run}] — each run() throws on failure; checks inside count as PASS / FAIL.
function cycleSteps(H, W, o, opts) {
  const A = orgApi(H, o);
  const u = o.users;
  const d = o.d = o.d || {};
  const c = d.cycle = d.cycle || {};
  const pre = `[${o.key}] `;
  const nk = () => H.newKey();
  const opt = opts || {};

  return [
    { id: 'request', title: 'public request (submit_service_request, anon)', run: async () => {
      const p = { orgSlug: o.slug, fullName: 'مستورد ' + o.key + ' التجريبي', phone: o.phone, email: 'importer@' + o.tag + '.example', company: 'شركة ' + o.key + ' للاستيراد',
        clientType: 'business', taxId: o.vat, crNumber: o.cr, direction: 'import', service: 'clearance', mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي',
        goods: 'أجهزة كهربائية منزلية', containerType: '40ft', containerNumbers: o.containers.slice(0, 2), count: 2, blNumber: o.bl, shippingLine: 'خط تجريبي', terms: true,
        idempotencyKey: nk() };
      const r = await H.rpc('anon', `SELECT public.submit_service_request($1) r`, [p]);
      if (!r.ref || !/^[0-9a-f]{64}$/.test(r.tracking_token || '')) throw new Error(H.J(r));
      c.reqRef = r.ref; c.token = r.tracking_token;
      c.req = (await H.one(`SELECT id, org_id FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [r.ref, o.id])) || {};
      if (!c.req.id) throw new Error('request not stored in org ' + o.key);
    } },
    { id: 'review', title: 'review (set_request_status under_review)', run: async () => {
      await A.R('ops', `SELECT public.set_request_status($1, 'under_review', $2) r`, [c.req.id, 'مراجعة الطلب']);
      const s = await H.one(`SELECT status FROM public.service_requests WHERE id = $1`, [c.req.id]);
      if (s.status !== 'under_review') throw new Error(s.status);
    } },
    { id: 'convert', title: 'transaction (convert_request_to_transaction, branch 1, idempotent)', run: async () => {
      const k = nk();
      const r = await A.R('clr', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [c.req.id, o.br1, k]);
      const again = await A.R('clr', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [c.req.id, o.br1, k]);
      c.tx = r.transaction_id; c.client = r.client_id;
      const t = await H.one(`SELECT ref, org_id, branch_id FROM public.transactions WHERE id = $1`, [c.tx]);
      c.txRef = t.ref;
      c.ct = (await H.q(`SELECT id, container_no FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [c.tx]));
      c.bl = (await H.one(`SELECT b.id FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id WHERE tb.transaction_id = $1 AND tb.is_primary`, [c.tx]) || {}).id;
      if (again.transaction_id !== c.tx || !again.replayed || t.org_id !== o.id || t.branch_id !== o.br1 || c.ct.length !== 2 || !c.bl || !t.ref.startsWith(o.prefix + '-'))
        throw new Error(H.J({ r, again, t, ct: c.ct.length, bl: c.bl }));
      if (o.attachClient) await o.attachClient(c.client);
    } },
    { id: 'documents', title: 'documents + gate (MRS_DOCS_MISSING, then satisfied)', run: async () => {
      await A.status('clr', c.tx, 'in_progress');
      c.docs = {};
      for (const k of ['bill_of_lading', 'commercial_invoice', 'packing_list']) c.docs[k] = await A.upload('clr', c.tx, k);
      await H.expectErr(pre + 'gate: unreviewed documents refused (MRS_DOCS_MISSING)', () => A.status('clr', c.tx, 'customs_declaration'), /MRS_DOCS_MISSING/);
      for (const k of Object.keys(c.docs)) await A.classify('clr', c.docs[k], k);
      const chk = await A.R('clr', `SELECT public.tx_checklist($1) r`, [c.tx]);
      if (H.J(chk.blocking_next) !== '[]') throw new Error('checklist ' + H.J(chk.blocking_next));
      const r = await A.status('clr', c.tx, 'customs_declaration');
      if (r.to !== 'customs_declaration' || r.docs_override !== null) throw new Error(H.J(r));
    } },
    { id: 'declaration', title: 'declaration (add_declaration, set_declaration_status → released)', run: async () => {
      const r = await A.R('clr', `SELECT public.add_declaration($1, $2, $3) r`, [c.tx, { declaration_no: o.key + 'D-' + o.tag.toUpperCase() + '-0001', declaration_type: 'import', declaration_date: day(0) }, nk()]);
      c.decl = r.id;
      await A.R('clr', `SELECT public.set_declaration_status($1, 'under_inspection') r`, [c.decl]);
      await A.R('clr', `SELECT public.set_declaration_status($1, 'released') r`, [c.decl]);
      const t = await H.one(`SELECT declaration_no FROM public.transactions WHERE id = $1`, [c.tx]);
      if (t.declaration_no !== o.key + 'D-' + o.tag.toUpperCase() + '-0001') throw new Error(H.J(t));
    } },
    { id: 'bl', title: 'B/L enriched + 2 containers tied to it', run: async () => {
      const r = await A.R('clr', `SELECT public.save_bl($1) r`, [{ id: c.bl, bl_type: 'master', vessel: 'VESSEL ' + o.key, voyage: '07' + o.key, port_of_loading: 'Shanghai', packages: 40, gross_weight_kg: 24000 }]);
      if (r.id !== c.bl) throw new Error(H.J(r));
      for (let i = 0; i < c.ct.length; i++)
        await H.as(u.trn, `UPDATE public.containers SET bl_id = $2, seal_no = $3, size_type = '45G1', operational_state = 'at_port' WHERE id = $1`, [c.ct[i].id, c.bl, 'S' + o.key + (i + 1)]);
      const n = await H.num(`SELECT count(*) n FROM public.containers WHERE transaction_id = $1 AND bl_id = $2`, [c.tx, c.bl]);
      if (n !== 2) throw new Error('containers tied ' + n);
    } },
    { id: 'appointment', title: 'appointment (create_appointment, confirm, complete)', run: async () => {
      c.docs.delivery_order = await A.upload('clr', c.tx, 'delivery_order');
      await A.classify('clr', c.docs.delivery_order, 'delivery_order');
      await A.status('trn', c.tx, 'appointment');
      const a = await A.R('trn', `SELECT public.create_appointment($1, $2) r`, [{ transaction_id: c.tx, terminal_party_id: d.terminal, appointment_at: hrs(5), window_minutes: 120,
        driver_id: d.driver, truck_id: d.truck }, nk()]);
      c.appt = a.id;
      await A.R('trn', `SELECT public.set_appointment_status($1, 'confirmed') r`, [c.appt]);
      await A.R('trn', `SELECT public.set_appointment_status($1, 'completed') r`, [c.appt]);
      const s = await H.one(`SELECT status FROM public.port_appointments WHERE id = $1`, [c.appt]);
      if (s.status !== 'completed') throw new Error(s.status);
    } },
    { id: 'trip', title: 'trips (create_trip with agreed cost, set_trip_status → delivered)', run: async () => {
      for (const x of c.ct) await H.as(u.trn, `UPDATE public.containers SET operational_state = 'released' WHERE id = $1`, [x.id]);
      await A.status('trn', c.tx, 'transport');
      c.trips = [];
      for (const x of c.ct) {
        const t = await A.R('ops', `SELECT public.create_trip($1, $2) r`, [{ transaction_id: c.tx, container_id: x.id, carrier_id: d.carrier, driver_id: d.driver, truck_id: d.truck,
          origin: 'ميناء جدة الإسلامي', destination: 'مستودع العميل', planned_at: hrs(6), cost_amount: 800, sell_amount: 1100, cost_basis: 'agreed' }, nk()]);
        c.trips.push(t.id);
      }
      for (const id of c.trips) {
        await A.R('trn', `SELECT public.set_trip_status($1, 'dispatched') r`, [id]);
        await A.R('trn', `SELECT public.set_trip_status($1, 'loaded', $2) r`, [id, hrs(-1)]);
        await A.R('trn', `SELECT public.set_trip_status($1, 'delivered') r`, [id]);
      }
      for (const x of c.ct) await H.as(u.trn, `UPDATE public.containers SET operational_state = 'delivered', delivered_at = now() WHERE id = $1`, [x.id]);
      const acc = await H.q(`SELECT status FROM public.cost_accruals WHERE transaction_id = $1`, [c.tx]);
      if (acc.length !== 2 || !acc.every(x => x.status === 'open')) throw new Error('accruals ' + H.J(acc));
    } },
    { id: 'empty_return', title: 'empty return with valid evidence (set_container_return, receipt, returned_verified)', run: async () => {
      await A.status('trn', c.tx, 'empty_return');
      c.docs.return_note = await A.upload('trn', c.tx, 'empty_return_note');
      await A.classify('clr', c.docs.return_note, 'empty_return_note');
      c.receipts = [];
      for (const x of c.ct) {
        await A.R('trn', `SELECT public.set_container_return($1, $2) r`, [x.id, { return_yard_party_id: d.yard, return_instruction_document_id: c.docs.return_note, return_deadline: day(7) }]);
        const rid = await A.upload('trn', c.tx, 'empty_return_receipt');
        await A.classify('clr', rid, 'empty_return_receipt');
        await H.as(u.trn, `UPDATE public.containers SET evidence_document_id = $2, return_status = 'returned_verified' WHERE id = $1`, [x.id, rid]);
        c.receipts.push(rid);
      }
      const r = await H.q(`SELECT return_status, operational_state FROM public.containers WHERE transaction_id = $1`, [c.tx]);
      if (!r.every(x => x.return_status === 'returned_verified')) throw new Error(H.J(r));
    } },
    { id: 'complete', title: 'operationally complete', run: async () => {
      const r = await A.status('clr', c.tx, 'operationally_complete');
      if (r.to !== 'operationally_complete') throw new Error(H.J(r));
    } },
    { id: 'supplier_invoice', title: 'supplier invoice (create_supplier_invoice, lines, allocate_invoice_line, approve_allocations, approve)', run: async () => {
      const doc = await A.R('acc', `SELECT public.register_finance_document($1, $2) r`, [{ branch_id: o.br1, kind: 'supplier_invoice', original_name: 'carrier.pdf', mime_type: 'application/pdf',
        size_bytes: 4096, sha256: (o.tag + 'f1').padStart(64, 'e').replace(/[^0-9a-f]/g, 'e') }, nk()]);
      const inv = await A.R('acc', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: o.br1, supplier_id: d.carrier, invoice_number: o.key + '-CAR-001', invoice_date: day(0),
        subtotal: 1600, vat_amount: 240, finance_document_id: doc.id, reference: 'نقل الحاويات',
        lines: c.ct.map(x => ({ description: 'نقل الحاوية ' + x.container_no, quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport', container_no_hint: x.container_no })) }, nk()]);
      c.inv = inv.id; c.invLines = inv.lines.map(l => l.id);
      const accr = await H.q(`SELECT id, trip_id FROM public.cost_accruals WHERE transaction_id = $1`, [c.tx]);
      c.allocs = [];
      for (let i = 0; i < c.ct.length; i++) {
        const ac = accr.find(x => x.trip_id === c.trips[i]);
        const r = await A.R('acc', `SELECT public.allocate_invoice_line($1, $2, $3) r`, [c.invLines[i],
          JSON.stringify([{ transaction_id: c.tx, container_id: c.ct[i].id, trip_id: c.trips[i], accrual_id: ac.id, amount: 800 }]), nk()]);
        c.allocs.push(r.allocations[0].id);
      }
      await A.R('mgr', `SELECT public.approve_allocations($1::uuid[], $2) r`, [c.allocs, 'مطابقة فاتورة الناقل']);
      await A.R('acc', `SELECT public.set_supplier_invoice_status($1, 'under_review', NULL) r`, [c.inv]);
      await A.R('mgr', `SELECT public.set_supplier_invoice_status($1, 'approved', NULL) r`, [c.inv]);
      const m = await A.R('acc', `SELECT public.tx_margin($1) r`, [c.tx]);
      const sar = (m.currencies || []).find(x => x.currency === 'SAR') || {};
      if (N(sar.cost_confirmed) !== 1600 || N(sar.cost_estimated) !== 0) throw new Error('margin ' + H.J(sar));
    } },
    { id: 'client_charges', title: 'client charges (suggest_client_charges, create_client_charge, approve)', run: async () => {
      c.suggest = await A.R('acc', `SELECT public.suggest_client_charges($1) r`, [c.tx]);
      const s = await A.R('acc', `SELECT public.create_client_charge($1, $2) r`, [{ transaction_id: c.tx, kind: 'service', description: 'أتعاب التخليص الجمركي', unit_price: 2500, service_code: 'customs_clearance' }, nk()]);
      const t = await A.R('acc', `SELECT public.create_client_charge($1, $2) r`, [{ transaction_id: c.tx, kind: 'service', description: 'نقل الحاويات', unit_price: 2200, service_code: 'transport' }, nk()]);
      c.charges = [s.id, t.id];
      for (const id of c.charges) await A.R('mgr', `SELECT public.set_charge_status($1, 'approved') r`, [id]);
      const n = await H.num(`SELECT count(*) n FROM public.client_charges WHERE transaction_id = $1 AND status = 'approved'`, [c.tx]);
      if (n !== 2) throw new Error('approved charges ' + n);
    } },
    { id: 'billing_intent', title: 'billing intent (create_billing_intent final, add_billing_lines)', run: async () => {
      const i = await A.R('acc', `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: c.tx, purpose: 'final', currency: 'SAR', add_eligible: false }, nk()]);
      c.intent = (i.intent || i).id;
      const r = await A.R('acc', `SELECT public.add_billing_lines($1, NULL, $2) r`, [c.intent, nk()]);
      const ls = await H.q(`SELECT charge_id FROM public.billing_intent_lines WHERE intent_id = $1 AND state <> 'removed'`, [c.intent]);
      if (ls.length !== 2 || !c.charges.every(id => ls.some(l => l.charge_id === id))) throw new Error(H.J({ r, ls }));
    } },
    { id: 'push', title: 'request_billing_push → real daftra-sync worker + mock: draft', run: async () => {
      await A.R('acc', `SELECT public.request_billing_push($1, $2) r`, [c.intent, nk()]);
      await W.dwake(o.id);
      await W.drunAll();
      const i = await H.one(`SELECT status, sync_state, external_invoice_id, operational_ref FROM public.billing_intents WHERE id = $1`, [c.intent]);
      const inv = W.dmocks[o.id].control.invoice(i.external_invoice_id);
      if (i.status !== 'draft' || i.sync_state !== 'synced' || !inv || inv.status !== 'draft') throw new Error(H.J({ i, inv }));
      c.ext = i.external_invoice_id; c.opRef = i.operational_ref;
    } },
    { id: 'issue', title: 'issue in Daftra (mock) → request_billing_pull → issued', run: async () => {
      W.dmocks[o.id].control.issueInvoice(c.ext);
      await A.R('acc', `SELECT public.request_billing_pull($1) r`, [c.intent]);
      await W.dwake(o.id);
      await W.drunAll();
      const i = await H.one(`SELECT status, daftra_number FROM public.billing_intents WHERE id = $1`, [c.intent]);
      const ch = await H.q(`SELECT status FROM public.client_charges WHERE id = ANY ($1::uuid[])`, [c.charges]);
      if (i.status !== 'issued' || !i.daftra_number || !ch.every(x => x.status === 'invoiced')) throw new Error(H.J({ i, ch }));
      c.issuedSnapshot = H.J(W.dmocks[o.id].control.invoice(c.ext));
    } },
    { id: 'financial_status', title: 'financial status (invoiced)', run: async () => {
      const f = await H.one(`SELECT financial_status FROM public.transactions WHERE id = $1`, [c.tx]);
      if (f.financial_status !== 'invoiced') throw new Error(f.financial_status);
    } },
    { id: 'reports', title: 'reports / export totals = Σ underlying rows (report_transactions, margin_report, cost_report, dash_finance, log_report_export)', run: async () => {
      const bad = [];
      const rt = await A.R('admin', `SELECT public.report_transactions($1, $2) r`, [o.id, { limit: 500 }]);
      const nTx = await H.num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [o.id]);
      const nCt = await H.num(`SELECT count(*) n FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id WHERE t.org_id = $1`, [o.id]);
      if (rt.totals.count !== nTx || rt.total !== nTx || rt.totals.containers !== nCt) bad.push('report_transactions ' + H.J(rt.totals) + ' vs ' + nTx + '/' + nCt);
      const mr = await A.R('acc', `SELECT public.margin_report($1, '{}') r`, [o.id]);
      const tm = await A.R('acc', `SELECT public.tx_margin($1) r`, [c.tx]);
      const items = mr.items || mr.rows || [];
      const row = items.find(x => x.transaction_id === c.tx && (x.currency || 'SAR') === 'SAR');
      const tms = (tm.currencies || []).find(x => x.currency === 'SAR') || {};
      if (!row || cents(row.cost_confirmed) !== cents(tms.cost_confirmed) || cents(row.charges_service) !== cents(tms.charges_service)) bad.push('margin_report ' + H.J(row) + ' vs ' + H.J(tms));
      const cr = await A.R('acc', `SELECT public.cost_report($1, '{"group_by":"transaction"}') r`, [o.id]);
      const sumItems = await H.one(`SELECT coalesce(sum(amount), 0)::numeric s FROM app.fin_cost_items($1)`, [o.id]);
      const crTot = cr.totals_by_currency ? cr.totals_by_currency.SAR : (cr.totals && cr.totals.SAR);
      // cost_report splits Σ cost items by level: confirmed + estimated + pass_through + unknown + client_paid_direct
      const crSum = crTot && ['confirmed', 'estimated', 'pass_through', 'unknown_amount', 'client_paid_direct'].reduce((s, k) => s + Number(crTot[k] || 0), 0);
      if (cents(crSum) !== cents(sumItems.s)) bad.push('cost_report ' + H.J(cr.totals_by_currency || cr.totals) + ' vs Σ ' + sumItems.s);
      const df = await A.R('admin', `SELECT public.dash_finance($1, '{}') r`, [o.id]);
      const iss = await H.one(`SELECT count(*)::int n, coalesce(sum(remote_total), 0)::numeric t FROM public.billing_intents WHERE org_id = $1 AND status = 'issued' AND currency = 'SAR'`, [o.id]);
      const off = df.official.by_currency.SAR || {};
      if (off.issued_count !== iss.n || cents(off.total) !== cents(iss.t)) bad.push('dash_finance ' + H.J(off) + ' vs ' + H.J(iss));
      const lg = await A.R('admin', `SELECT public.log_report_export($1, $2) r`, [o.id, { report: 'transactions', format: 'csv', filters: {}, row_count: rt.total }]);
      const ex = await H.one(`SELECT row_count FROM public.report_exports WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id]);
      if (!lg || !ex || ex.row_count !== nTx) bad.push('log_report_export ' + H.J(ex));
      c.reportTotals = { transactions: nTx, containers: nCt, issued_sar: Number(iss.t), cost_items_sar: Number(sumItems.s) };
      if (bad.length) throw new Error(bad.join('; '));
    } },
    { id: 'inbound_mail', title: 'inbound mock e-mail through the real inbox-sync worker, linked to the transaction', run: async () => {
      const ME = d.ME;
      ME.control.deliverInbound({ from: { address: 'ops@agent-' + o.tag + '.example', name: 'Agent ' + o.key }, auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
        subject: 'D/O ready — B/L ' + o.bl,
        text: 'Dear team,\nThe delivery order for B/L No. ' + o.bl + ' is ready.\nContainers: ' + o.containers.slice(0, 2).join(' and ') + '.\nRegards', attachments: [] },
        { sent_at: new Date(Date.now() - 3600e3).toISOString() });
      const r = await W.pollOrg(o.id);
      if (r.failed) throw new Error('worker ' + H.J(r));
      const t = await H.one(`SELECT t.* FROM public.msg_threads t WHERE t.org_id = $1 ORDER BY t.created_at DESC LIMIT 1`, [o.id]);
      if (!t) throw new Error('no thread');
      c.thread = t.id;
      const cands = (t.match_candidates || []).map(x => x.transaction_id);
      if (t.transaction_id !== c.tx) {
        if (!cands.includes(c.tx)) throw new Error('tx not among candidates ' + H.J({ st: t.match_status, cands }));
        await A.R('ops', `SELECT public.link_msg_thread($1, $2, $3) r`, [t.id, c.tx, 'مطابقة البوليصة والحاويات']);
      }
      const t2 = await H.one(`SELECT transaction_id, match_status FROM public.msg_threads WHERE id = $1`, [t.id]);
      const ev = await H.num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'message' AND payload ->> 'op' = 'thread_linked'`, [c.tx]);
      if (t2.transaction_id !== c.tx || ev < 1) throw new Error(H.J({ t2, ev }));
      c.matchStatus = t.match_status;
    } },
    { id: 'portal', title: 'client portal: only client-visible events, no internal data', run: async () => {
      const bad = [];
      const tx = await H.as(u.client, `SELECT id FROM public.transactions`);
      if (tx.length !== 1 || tx[0].id !== c.tx) bad.push('transactions ' + H.J(tx));
      const ev = await H.as(u.client, `SELECT id::text id, visible_to_client FROM public.transaction_events WHERE transaction_id = $1`, [c.tx]);
      const vis = await H.num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND visible_to_client`, [c.tx]);
      if (ev.length !== vis || !ev.every(x => x.visible_to_client)) bad.push('events ' + ev.length + ' vs visible ' + vis);
      for (const t of ['transport_trips', 'operational_exceptions', 'supplier_invoices', 'cost_allocations', 'billing_intents', 'msg_threads', 'msg_messages', 'audit_log']) {
        try { const r = await H.as(u.client, `SELECT 1 FROM public.${t}`); if (r.length) bad.push(t + ':' + r.length); } catch (e) { /* permission denied = hidden */ }
      }
      const pt = await H.rpc('anon', `SELECT public.public_track($1, $2) r`, [c.reqRef, c.token]);
      if (!pt || /audit|cost_amount|supplier/.test(H.J(pt))) bad.push('public_track ' + H.J(pt).slice(0, 200));
      c.portalEvents = ev.length;
      if (bad.length) throw new Error(bad.join('; '));
    } }
  ].map(s => Object.assign(s, { title: pre + s.title }));
}

/* ------------------------------------------------------------------ an org built ONLY through RPCs (platform admin → invitations) */
// opts: {platform: <H.users key of a platform admin>, email: key → e-mail, name_ar, name_en, branch1: {...}, branch2: {...}}
// o.users.* must exist in H.users with auth.users rows whose e-mail = opts.email(key) (sign-up rows). Sets o.id, o.br1, o.br2.
async function createOrgViaRpcs(H, o, opts) {
  const u = o.users;
  const cr = await H.step(`platform admin: platform_create_org (${o.slug}, prefix ${o.prefix}, branch ${opts.branch1.code}, admin invitation)`, () =>
    H.rpc(opts.platform, `SELECT public.platform_create_org($1) r`, [{ slug: o.slug, name_ar: opts.name_ar, name_en: opts.name_en, ref_prefix: o.prefix, default_locale: 'ar',
      branch: opts.branch1, admin_email: opts.email(u.admin), idempotencyKey: H.newKey() }]));
  o.id = cr.org_id; o.br1 = cr.branch_id;
  await H.check(`[${o.key}] staging environment forced, default document requirements seeded (15), pilot subscription created by the G7 trigger`, async () => {
    const r = await H.one(`SELECT environment, ref_prefix, is_active FROM public.organizations WHERE id = $1`, [o.id]);
    const n = await H.num(`SELECT count(*) n FROM public.document_requirements WHERE org_id = $1`, [o.id]);
    let sub = null;
    try { sub = await H.one(`SELECT plan_code, status FROM public.org_subscriptions WHERE org_id = $1`, [o.id]); } catch (e) { sub = { error: H.errText(e) }; }
    return (r.environment === 'staging' && r.ref_prefix === o.prefix && r.is_active && n === 15 && sub && sub.plan_code === 'pilot' && sub.status === 'active') || H.J({ r, n, sub });
  });
  await H.step(`[${o.key}] first admin: accept_invitation`, async () => {
    const r = await H.rpc(u.admin, `SELECT public.accept_invitation($1) r`, [cr.token]);
    if (r.org_id !== o.id || r.role !== 'admin') throw new Error(H.J(r));
  });
  await H.expectErr(`[${o.key}] a branch code reused inside the org is refused (code_taken)`, () =>
    H.rpc(u.admin, `SELECT public.admin_create_branch($1, $2) r`, [o.id, { code: opts.branch1.code, name_ar: 'نسخة' }]), /code_taken/);
  const b2 = await H.step(`[${o.key}] admin_create_branch ${opts.branch2.code} (second branch)`, () => H.rpc(u.admin, `SELECT public.admin_create_branch($1, $2) r`, [o.id, opts.branch2]));
  o.br2 = b2.id;
  const roles = [['ops', 'operations_manager', null], ['clr', 'clearance_staff', 'br1'], ['trn', 'transport_staff', 'br1'],
    ['acc', 'accountant', null], ['mgr', 'accounts_manager', null], ['bm', 'branch_manager', 'br1']].concat(opts.extraRoles || []);
  for (const [k, role, br] of roles) {
    await H.step(`[${o.key}] admin_invite ${role}${br ? ' (' + br + ')' : ''} + accept_invitation`, async () => {
      const inv = await H.rpc(u.admin, `SELECT public.admin_invite($1, $2) r`, [o.id, { email: opts.email(u[k]), role, branch_id: br ? o[br] : null, idempotencyKey: H.newKey() }]);
      const r = await H.rpc(u[k], `SELECT public.accept_invitation($1) r`, [inv.token]);
      if (r.org_id !== o.id || r.role !== role) throw new Error(H.J(r));
    });
  }
  await H.check(`[${o.key}] ${roles.length + 1} active staff memberships, all created through invitations (created_by = the org admin)`, async () => {
    const r = await H.q(`SELECT role, created_by FROM public.memberships WHERE org_id = $1 AND is_active`, [o.id]);
    return (r.length === roles.length + 1 && r.filter(x => x.role !== 'admin').every(x => x.created_by === H.users[u.admin])) || H.J(r);
  });
  return cr;
}

/* ------------------------------------------------------------------ static scan ("no code path knows the seed org") */
// Known legacy defaults (G2): the public intake falls back to the seed slug when the caller sends no orgSlug.
// They are listed (never silently skipped) and verified to be fallbacks only; any other hit is a FAIL.
const KNOWN_SLUG_DEFAULTS = [
  { file: 'assets/js/config.js', re: /orgSlug:\s*'blue-sea'|\('blue-sea'\)/, why: 'deployment config: tenant of the public site (configuration, not code)' },
  { file: 'assets/js/config.example.js', re: /orgSlug:\s*'blue-sea'/, why: 'deployment config template' },
  { file: 'assets/js/supa.js', re: /cfg\.orgSlug \|\| 'blue-sea'/, why: 'fallback when config.js has no orgSlug (G2)' },
  { file: 'supabase/migrations/20261031000400_rpc.sql', re: /coalesce\(nullif\(payload ->> 'orgSlug', ''\), 'blue-sea'\)/, why: 'public intake default slug (G2, superseded by 0300)' },
  { file: 'supabase/migrations/20261102000300_ops_observability.sql', re: /coalesce\(nullif\(payload ->> 'orgSlug', ''\), 'blue-sea'\)/, why: 'public intake default slug (G2)' }
];
function scanSeedOrg(root, seedId, slug) {
  const dirs = ['assets/js', 'supabase/functions', 'supabase/migrations'];
  const hits = [];
  const walk = rel => {
    const abs = path.join(root, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (/\.(js|ts|sql|json|mjs)$/.test(e.name)) {
        const lines = fs.readFileSync(path.join(root, r), 'utf8').split('\n');
        lines.forEach((ln, i) => { if (ln.includes(seedId) || ln.includes(slug)) hits.push({ file: r.split(path.sep).join('/'), line: i + 1, text: ln.trim().slice(0, 160) }); });
      }
    }
  };
  for (const d of dirs) walk(d);
  const known = [], unknown = [];
  for (const h of hits) {
    const k = KNOWN_SLUG_DEFAULTS.find(x => x.file === h.file && x.re.test(h.text) && !h.text.includes(seedId));
    if (k) known.push(Object.assign({ why: k.why }, h)); else if (/^\s*(\/\/|\*|--|\/\*)/.test(h.text) && /config\.js$/.test(h.file)) known.push(Object.assign({ why: 'comment in deployment config' }, h)); else unknown.push(h);
  }
  return { hits, known, unknown };
}

module.exports = { day, hrs, N, cents, isoContainer, tenantTables, stateHash, hashDiff, catalogFingerprint, createWorkers, snapshot, evidenceSince, maskRef,
  orgApi, setupOrg, cycleSteps, createOrgViaRpcs, scanSeedOrg, KNOWN_SLUG_DEFAULTS };

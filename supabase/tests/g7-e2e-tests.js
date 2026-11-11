#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 steps ٣ + ٤ (+ ١٠ template check §0): end-to-end operating cycle and exceptions
  (docs/online/G7_SPEC.md § Tests "g7-e2e-tests.js"). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no Daftra, no mailbox, no LLM,
  no keys: the REAL daftra-sync worker + mock adapter and the REAL inbox-sync worker + mocks drive PGlite through the
  service RPCs (as service_role); every staff action goes through the RPCs / RLS the UI uses (as authenticated).

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql → fixtures.
  Org A = seed "blue-sea" (staging seed, fictional). Users are seed-style SQL rows (auth.users + memberships).
  Shared step library: supabase/tests/lib/g7-cycle.js (also used by g7-second-org-tests.js).

  Sections:
    0. import template headers (step ١٠, no DB): docs/import-templates/*.csv vs README + bulk-upload synonyms
    1. setup: Daftra mock connection, mock channels, directory
    2. cycle (step ٣): request → review → transaction → documents + gate → declaration → B/L + containers →
       appointment → trips → empty return → complete → supplier invoice → allocation → client charges →
       billing intent → push (real worker) → extra fee after billing → issue → financial status →
       late supplier invoice after the issue (supplementary, issued invoice never mutated) → reports →
       inbound e-mail (real inbox worker) linked → client portal
    3. exceptions (step ٤) on a second transaction: declaration cancel + replacement, 3 containers (one waived,
       one late → alert + demurrage case), completion gate, cost source correction (reverse + re-allocate)
    4. gate: no lost history, no doubled amounts, every correction has a reason and an event

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-e2e-tests.js [/path/to/marsa-website] [--quiet] [--write]
    --write  regenerates docs/online/G7_E2E_EVIDENCE.md from this run (deterministic: no ids, no timestamps)
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const WRITE = args.includes('--write');
const SUPA = path.join(ROOT, 'supabase');
const G6B_MIGRATION = '20261107000100_g6b_inbox.sql';

// No network anywhere: any fetch is a test failure (the workers are given no fetch).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-e2e-tests'); };

const L = require(path.join(SUPA, 'tests', 'lib', 'g7-cycle.js'));

/* ------------------------------------------------------------------ helper block (g6b-cycle-tests.js) */
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
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
const J = x => JSON.stringify(x);

/* ------------------------------------------------------------------ ids (prefix c7e0…) */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const U = {
  A_admin: 'c7e00000-0000-4000-8000-000000000001', A_ops: 'c7e00000-0000-4000-8000-000000000002', A_clr: 'c7e00000-0000-4000-8000-000000000003',
  A_trn: 'c7e00000-0000-4000-8000-000000000004', A_acc: 'c7e00000-0000-4000-8000-000000000005', A_mgr: 'c7e00000-0000-4000-8000-000000000006',
  A_bm: 'c7e00000-0000-4000-8000-000000000007', A_client: 'c7e00000-0000-4000-8000-000000000008', A_client2: 'c7e00000-0000-4000-8000-000000000009'
};
let keySeq = 0;
const newKey = () => `c7e0e000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const H = { q, one, num, rpc, as, asService, step, check, expectErr, pass, fail, section, errText, J, newKey, users: U };

/* ================================================================== 0. import templates (step ١٠) */
function loadBulkUploadFields() {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'bulk-upload.js'), 'utf8');
  const grab = (startRe, endRe) => { const a = src.search(startRe); const b = src.indexOf(endRe, a); if (a < 0 || b < 0) throw new Error('bulk-upload.js: ' + startRe); return src.slice(a, b + endRe.length); };
  const code = [grab(/function toWestern\(/, '\n    }'), grab(/function normAr\(/, '\n    }'),
    grab(/var SYN_CURRENCY = /, ';'), grab(/var SYN_HS = /, ';'), grab(/var SYN_COUNTRY = /, ';'), grab(/var FIELDS = \{/, '\n    };')].join('\n');
  const vm = require('vm');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(code + '\n;Object.keys(FIELDS).forEach(function (t) { FIELDS[t].forEach(function (f) { f.nsyn = f.syn.concat([f.key, f.label]).map(normAr).filter(Boolean); }); });' +
    '\nthis.FIELDS = FIELDS; this.normAr = normAr;', sb);
  return { FIELDS: sb.FIELDS, normAr: sb.normAr };
}
function parseCsvHeader(buf) {
  let s = buf.toString('utf8');
  const bom = s.charCodeAt(0) === 0xFEFF;
  if (bom) s = s.slice(1);
  const line = s.split(/\r?\n/)[0];
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return { bom, header: out };
}
async function templateChecks() {
  section('0. import templates (step ١٠): docs/import-templates/*.csv');
  const dir = path.join(ROOT, 'docs', 'import-templates');
  const NAMES = ['clients', 'transactions', 'containers'];
  if (!fs.existsSync(dir)) { fail('docs/import-templates/ exists', 'missing (DOCS agent deliverable: clients / transactions / containers .csv + .xlsx + README_AR.md)'); return; }
  const readme = fs.existsSync(path.join(dir, 'README_AR.md')) ? fs.readFileSync(path.join(dir, 'README_AR.md'), 'utf8') : null;
  await check('README_AR.md present and names every template', () => (readme !== null && NAMES.every(n => readme.includes(n + '.csv'))) || (readme === null ? 'README_AR.md missing' : 'README does not name ' + NAMES.filter(n => !readme.includes(n + '.csv')).join(',')));
  let BU = null;
  try { BU = loadBulkUploadFields(); pass('bulk-upload.js field synonyms loaded (shipments: ' + BU.FIELDS.shipments.length + ' fields)'); }
  catch (e) { fail('bulk-upload.js field synonyms loaded', errText(e)); }
  for (const n of NAMES) {
    const f = path.join(dir, n + '.csv');
    if (!fs.existsSync(f)) { fail(n + '.csv exists', 'missing'); continue; }
    const { bom, header } = parseCsvHeader(fs.readFileSync(f));
    await check(`${n}.csv: UTF-8 BOM, non-empty unique header`, () => (bom && header.length >= 2 && header.every(Boolean) && new Set(header).size === header.length) || J({ bom, header }));
    await check(`${n}.csv: every header column is documented in README_AR.md`, () => {
      const miss = readme ? header.filter(h => !readme.includes(h)) : header;
      return miss.length === 0 || 'undocumented: ' + miss.join(', ');
    });
    await check(`${n}.xlsx exists next to the CSV`, () => fs.existsSync(path.join(dir, n + '.xlsx')) || 'missing ' + n + '.xlsx');
    if (n === 'transactions' && BU) {
      await check('transactions.csv (shipments): every header is an exact bulk-upload synonym of a distinct shipments field', () => {
        const map = {}, bad = [];
        for (const h of header) {
          const nh = BU.normAr(h);
          const fld = BU.FIELDS.shipments.find(x => x.nsyn.includes(nh));
          if (!fld) bad.push(h + ' → (no field)'); else if (map[fld.key]) bad.push(h + ' → ' + fld.key + ' (twice)'); else map[fld.key] = h;
        }
        const req = BU.FIELDS.shipments.filter(x => x.req).map(x => x.key).filter(k => !map[k]);
        return (bad.length === 0) || ('not accepted: ' + bad.join('; ') + (req.length ? ' | required fields without a column: ' + req.join(',') : ''));
      });
    }
  }
}

/* ================================================================== fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase().replace('_', '.')}@g7e2e.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.A_admin}', '${A}', NULL, 'admin'), ('${U.A_ops}', '${A}', NULL, 'operations_manager'), ('${U.A_clr}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.A_trn}', '${A}', '${JED}', 'transport_staff'), ('${U.A_acc}', '${A}', NULL, 'accountant'), ('${U.A_mgr}', '${A}', NULL, 'accounts_manager'),
      ('${U.A_bm}', '${A}', '${JED}', 'branch_manager');
  `);
  // G3 cycle note: seed.sql runs AFTER the migrations, so org A gets its default document requirements here
  return one(`SELECT app.seed_document_requirements($1) n`, [A]);
}
const ORG = {
  key: 'A', id: A, slug: 'blue-sea', prefix: 'MRS', br1: JED, br2: DMM, tag: 'a7e',
  users: { admin: 'A_admin', ops: 'A_ops', clr: 'A_clr', trn: 'A_trn', acc: 'A_acc', mgr: 'A_mgr', bm: 'A_bm', client: 'A_client' },
  email: 'inbox@g7-a.example', wa: '0500000701', waNorm: '+966500000701', phone: '0501117001', vat: '300000000700003', cr: '7000000701',
  bl: 'MEDUA7E0001', containers: [L.isoContainer('MSCU', 700001), L.isoContainer('MSCU', 700002), L.isoContainer('MSCU', 700003)],
  attachClient: async (clientId) => {
    await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, clientId, U.A_client]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.A_client, A]);
  },
  d: {}
};

/* ================================================================== evidence + history monotonicity */
const EVID = [];
const HIST_TABLES = ['transaction_events', 'audit_log', 'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items', 'billing_intent_lines',
  'msg_messages', 'msg_jobs', 'msg_job_attempts', 'msg_thread_links', 'customs_declarations', 'port_appointments', 'cost_allocations', 'documents'];
const histSeries = [];
async function histCounts() {
  const r = {};
  for (const t of HIST_TABLES) r[t] = await num(`SELECT count(*) n FROM public.${t}`);
  return r;
}
// review fix: the evidence each step must produce (spec §g7-e2e "evidence = the transaction_events / audit_log / G5 job rows
// it produced") — asserted, not only written to the doc. Substrings of the aggregated evidence lines; empty:true = the step
// is read-only and must write nothing.
const EXPECT = {
  request: { audit: ['service_requests INSERT'], exactEventsEmpty: true },
  review: { audit: ['service_requests UPDATE'], exactEventsEmpty: true },
  convert: { events: ['created ∅→new', 'request_converted'], audit: ['transactions INSERT', 'service_requests UPDATE'] },
  documents: { events: ['operational_status new→in_progress', 'document:insert'], audit: ['documents INSERT', 'transactions UPDATE'] },
  declaration: { events: ['declaration:added', 'declaration:status under_inspection→released'], audit: ['customs_declarations INSERT'] },
  bl: { events: ['bl:updated'], audit: ['bills_of_lading UPDATE'] },
  appointment: { events: ['appointment:created', 'appointment:confirmed'], audit: [] },
  trip: { events: ['trip:created', 'trip:status loaded→delivered'], audit: ['containers UPDATE'] },
  empty_return: { events: ['container_return pending→returned_verified'], audit: ['containers UPDATE', 'documents INSERT'] },
  complete: { events: ['operational_status empty_return→operationally_complete'], audit: ['transactions UPDATE'] },
  supplier_invoice: { events: ['finance:allocation_proposed', 'finance:allocation_approved'], audit: ['cost_allocations INSERT', 'finance_documents INSERT'] },
  client_charges: { events: ['finance:charge_created', 'finance:charge_status draft→approved'], audit: ['client_charges INSERT'] },
  billing_intent: { events: ['billing:intent_created', 'billing:lines_added'], audit: ['billing_intents INSERT', 'billing_intent_lines INSERT'] },
  push: { events: ['billing:push_requested', 'billing:draft_synced', 'financial_status not_started→draft_pending'], audit: ['billing_sync_jobs INSERT'], jobs: ['billing invoice_push done'] },
  issue: { events: ['billing:issued', 'financial_status draft_pending→invoiced'], jobs: ['billing invoice_pull done'] },
  financial_status: { empty: true },
  reports: { empty: true },
  inbound_mail: { events: ['message:thread_linked'], audit: ['msg_threads INSERT'], jobs: ['msg process done'] },
  portal: { empty: true },
  x_extra_fee: { events: ['finance:charge_created', 'billing:lines_added', 'billing:push_requested'], audit: ['billing_intent_lines INSERT'] },
  x_late_invoice: { events: ['billing:review_resolved', 'billing:intent_created'], audit: [] },
  x_second_request: { events: ['created ∅→new', 'request_converted'], audit: ['containers INSERT'] },
  x_decl_cancel: { events: ['declaration:cancelled', 'declaration:replaced', 'exception:created'], audit: ['operational_exceptions INSERT'] },
  x_cost_correction: { events: ['finance:allocation_reversed approved→reversed'], audit: ['cost_allocations UPDATE'] },
  x_appt_transport: { events: ['operational_status appointment→transport', 'operational_status transport→empty_return'], audit: ['containers UPDATE'] },
  x_multi_container: { events: ['container_return pending→waived', 'container_return pending→returned_verified'], audit: ['containers UPDATE'] },
  x_late_return: { events: ['finance:demurrage_created', 'exception:created'], audit: ['demurrage_cases INSERT'] },
  x_late_receipt: { events: ['exception:status open→resolved', 'operational_status empty_return→operationally_complete'], audit: [] }
};
async function evStep(group, s, fn, expect) {
  const snap = await L.snapshot(H, A);
  await step(s.title, fn || s.run);
  const e = await L.evidenceSince(H, A, snap);
  EVID.push({ group, title: s.title.replace(/^\[A\] /, ''), e });
  histSeries.push({ title: s.title, c: await histCounts() });
  const x = expect || (s.id && EXPECT[s.id]);
  if (!x) { fail(s.title + ': evidence', 'no expected-evidence spec for this step'); return; }
  await check(s.title + ': evidence ' + (x.empty ? 'is empty (read-only step)' : 'contains the expected event / audit / job rows'), () => {
    if (x.empty) return (e.n.events === 0 && e.n.audit === 0 && e.n.jobs === 0) || J(e);
    const miss = [];
    for (const k of ['events', 'audit', 'jobs']) for (const want of (x[k] || [])) if (!e[k].some(line => line.includes(want))) miss.push(k + ': ' + want);
    if (x.exactEventsEmpty && e.n.events !== 0) miss.push('events: expected none, got ' + e.events.join(', '));
    return miss.length === 0 || J({ miss, got: e });
  });
}

/* ================================================================== 2. cycle (+ extra fee, late invoice) */
const C = ORG.d;
async function cycle(W) {
  section('2. operating cycle (step ٣) — org A');
  const steps = L.cycleSteps(H, W, ORG);
  const by = id => steps.find(s => s.id === id);
  const api = L.orgApi(H, ORG);
  for (const id of ['request', 'review', 'convert', 'documents', 'declaration', 'bl', 'appointment', 'trip', 'empty_return', 'complete',
    'supplier_invoice', 'client_charges', 'billing_intent', 'push']) await evStep('cycle', by(id));
  const c = C.cycle;
  await check('[A] ref numbering: request + transaction refs use the org prefix / sequence', () =>
    (/^MRS-\d{4}-\d{6}$/.test(c.txRef)) || J({ tx: c.txRef, req: c.reqRef }));
  await check('[A] Daftra mock draft lines = intent lines (line_refs)', async () => {
    const inv = W.dmocks[A].control.invoice(c.ext);
    const ls = await q(`SELECT line_ref FROM public.billing_intent_lines WHERE intent_id = $1 AND state <> 'removed' ORDER BY line_ref`, [c.intent]);
    return J(inv.lines.map(l => l.line_ref).sort()) === J(ls.map(l => l.line_ref)) || J({ inv: inv.lines.map(l => l.line_ref), ls });
  });

  // ---- exception: extra fees after billing (new charge → new intent line, no double)
  await evStep('exceptions', { id: 'x_extra_fee', title: '[A] extra fee after billing: new approved charge → one new intent line, re-push, no double' }, async () => {
    const ch = await api.R('acc', `SELECT public.create_client_charge($1, $2) r`, [{ transaction_id: c.tx, kind: 'service', description: 'رسوم مستندات إضافية', unit_price: 300, service_code: 'documentation' }, newKey()]);
    await api.R('mgr', `SELECT public.set_charge_status($1, 'approved') r`, [ch.id]);
    c.extraCharge = ch.id;
    await api.R('acc', `SELECT public.add_billing_lines($1, $2::uuid[], $3) r`, [c.intent, [ch.id], newKey()]);
    // a second add (double click, other key) must not add it twice
    try { await api.R('acc', `SELECT public.add_billing_lines($1, $2::uuid[], $3) r`, [c.intent, [ch.id], newKey()]); } catch (e) { if (!/MRS_/.test(errText(e))) throw e; }
    const n = await num(`SELECT count(*) n FROM public.billing_intent_lines WHERE intent_id = $1 AND charge_id = $2 AND state <> 'removed'`, [c.intent, ch.id]);
    if (n !== 1) throw new Error('lines for the extra charge: ' + n);
    await api.R('acc', `SELECT public.request_billing_push($1, $2) r`, [c.intent, newKey()]);
    await W.dwake(A); await W.drunAll();
    const inv = W.dmocks[A].control.invoice(c.ext);
    const refs = inv.lines.map(l => l.line_ref);
    const st = W.dmocks[A].control.state();
    if (inv.lines.length !== 3 || new Set(refs).size !== 3 || st.invoices.filter(x => x.reference === c.opRef).length !== 1) throw new Error(J({ refs, n: st.invoices.length }));
    c.charges.push(ch.id);
  });
  for (const id of ['issue', 'financial_status']) await evStep('cycle', by(id));

  // ---- exception: late supplier invoice AFTER the Daftra issue → review → supplementary intent; the issued invoice is never mutated
  await evStep('exceptions', { id: 'x_late_invoice', title: '[A] late supplier invoice after the Daftra issue → late_charge review → supplementary intent; issued invoice untouched' }, async () => {
    const mock = W.dmocks[A];
    const updBefore = mock.control.calls.filter(x => x.op === 'updateDraftInvoice').length;
    const doc = await api.R('acc', `SELECT public.register_finance_document($1, $2) r`, [{ branch_id: JED, kind: 'supplier_invoice', original_name: 'storage.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: 'a7e5'.padStart(64, 'c') }, newKey()]);
    const inv = await api.R('acc', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: JED, supplier_id: C.terminal, invoice_number: 'A-STO-LATE-1', invoice_date: L.day(0),
      subtotal: 300, vat_amount: 45, finance_document_id: doc.id, lines: [{ description: 'أرضيات متأخرة', quantity: 1, unit_price: 300, net_amount: 300, vat_rate: 15, service_code: 'storage', container_no_hint: c.ct[0].container_no }] }, newKey()]);
    c.lateInv = inv.id;
    const al = await api.R('acc', `SELECT public.allocate_invoice_line($1, $2, $3) r`, [inv.lines[0].id, J([{ transaction_id: c.tx, container_id: c.ct[0].id, amount: 300 }]), newKey()]);
    c.lateAlloc = al.allocations[0].id;
    await api.R('mgr', `SELECT public.approve_allocations($1::uuid[], $2) r`, [[c.lateAlloc], 'تكلفة متأخرة']);
    await api.R('acc', `SELECT public.set_supplier_invoice_status($1, 'under_review', NULL) r`, [inv.id]);
    await api.R('mgr', `SELECT public.set_supplier_invoice_status($1, 'approved', NULL) r`, [inv.id]);
    const ch = await api.R('acc', `SELECT public.create_client_charge($1, $2) r`, [{ transaction_id: c.tx, kind: 'reimbursable', description: 'أرضيات (مبلغ مسترد)', source: 'from_cost', cost_allocation_id: c.lateAlloc }, newKey()]);
    await api.R('mgr', `SELECT public.set_charge_status($1, 'approved') r`, [ch.id]);
    c.lateCharge = ch.id;
    const rv = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge' AND status = 'open'`, [ch.id]);
    if (!rv) throw new Error('no late_charge review item');
    await expectErr('[A] the issued final intent refuses a push (intent_issued)', () => api.R('acc', `SELECT public.request_billing_push($1, $2) r`, [c.intent, newKey()]), /intent_issued/);
    const s1 = await api.R('acc', `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: c.tx, purpose: 'supplementary', currency: 'SAR', add_eligible: false }, newKey()]);
    c.supp = (s1.intent || s1).id;
    await api.R('mgr', `SELECT public.resolve_billing_review($1, 'supplementary', $2, $3) r`, [rv.id, 'فاتورة إضافية للأرضيات المتأخرة', c.supp]);
    await api.R('acc', `SELECT public.request_billing_push($1, $2) r`, [c.supp, newKey()]);
    await W.dwake(A); await W.drunAll();
    const si = await one(`SELECT status, external_invoice_id, operational_ref FROM public.billing_intents WHERE id = $1`, [c.supp]);
    const sl = await q(`SELECT charge_id FROM public.billing_intent_lines WHERE intent_id = $1 AND state <> 'removed'`, [c.supp]);
    const updAfter = mock.control.calls.filter(x => x.op === 'updateDraftInvoice').length;
    const issuedNow = J(mock.control.invoice(c.ext));
    if (si.status !== 'draft' || !si.external_invoice_id || si.external_invoice_id === c.ext || sl.length !== 1 || sl[0].charge_id === undefined || sl[0].charge_id !== ch.id ||
        !/\/S1$/.test(si.operational_ref) || issuedNow !== c.issuedSnapshot || updAfter !== updBefore) throw new Error(J({ si, sl, upd: [updBefore, updAfter], same: issuedNow === c.issuedSnapshot }));
    c.charges.push(ch.id);
  });
  for (const id of ['reports', 'inbound_mail', 'portal']) await evStep('cycle', by(id));
}

/* ================================================================== 3. exceptions on a second transaction */
async function exceptions(W) {
  section('3. exceptions (step ٤) — second transaction, 3 containers');
  const api = L.orgApi(H, ORG);
  const x = C.ex = {};
  const st = (who, s) => api.status(who, x.tx, s);
  await evStep('exceptions', { id: 'x_second_request', title: '[A] second request (3 containers) → transaction' }, async () => {
    const r = await rpc('anon', `SELECT public.submit_service_request($1) r`, [{ orgSlug: 'blue-sea', fullName: 'مستورد الاستثناءات', phone: '0501117002', email: 'ex@a7e.example',
      company: 'شركة الاستثناءات', clientType: 'business', taxId: '300000000700013', direction: 'import', service: 'clearance', mode: 'sea', country: 'الهند', port: 'ميناء جدة الإسلامي',
      goods: 'مواد غذائية مجمدة', containerType: '40ft', containerNumbers: ORG.containers.concat([L.isoContainer('TGHU', 700004)]).slice(1), count: 3, blNumber: 'MEDUA7E0002', terms: true, idempotencyKey: newKey() }]);
    x.reqRef = r.ref;
    const req = await one(`SELECT id FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [r.ref, A]);
    const cv = await api.R('clr', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [req.id, JED, newKey()]);
    x.tx = cv.transaction_id;
    x.ct = await q(`SELECT id, container_no FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [x.tx]);
    if (x.ct.length !== 3) throw new Error('containers ' + x.ct.length);
    await st('clr', 'in_progress');
    for (const k of ['bill_of_lading', 'commercial_invoice', 'packing_list']) { const id = await api.upload('clr', x.tx, k); await api.classify('clr', id, k); }
    await st('clr', 'customs_declaration');
  });
  await evStep('exceptions', { id: 'x_decl_cancel', title: '[A] declaration cancelled + replacement (cancel_declaration): history kept, exception opened' }, async () => {
    const d1 = await api.R('clr', `SELECT public.add_declaration($1, $2, $3) r`, [x.tx, { declaration_no: 'AEX-0001', declaration_type: 'import', declaration_date: L.day(0) }, newKey()]);
    const cn = await api.R('clr', `SELECT public.cancel_declaration($1, $2, $3) r`, [d1.id, 'خطأ في البند الجمركي', { declaration_no: 'AEX-0002', declaration_type: 'import' }]);
    x.d1 = d1.id; x.d2 = cn.replacement.id; x.excDecl = cn.exception_id;
    await api.R('clr', `SELECT public.set_declaration_status($1, 'released') r`, [x.d2]);
    const rows = await q(`SELECT id, status, replaced_by_id, cancel_reason FROM public.customs_declarations WHERE transaction_id = $1 ORDER BY created_at`, [x.tx]);
    const t = await one(`SELECT declaration_no FROM public.transactions WHERE id = $1`, [x.tx]);
    if (rows.length !== 2 || rows[0].status !== 'replaced' || rows[0].replaced_by_id !== x.d2 || !rows[0].cancel_reason || rows[1].status !== 'released' || t.declaration_no !== 'AEX-0002' || !x.excDecl)
      throw new Error(J({ rows, t }));
  });
  await evStep('exceptions', { id: 'x_cost_correction', title: '[A] cost source correction: allocation to the wrong container reversed with a reason, re-allocated (reverse_allocation)' }, async () => {
    const doc = await api.R('acc', `SELECT public.register_finance_document($1, $2) r`, [{ branch_id: JED, kind: 'supplier_invoice', original_name: 'port.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: 'a7e6'.padStart(64, 'c') }, newKey()]);
    const inv = await api.R('acc', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: JED, supplier_id: C.supplier, invoice_number: 'A-PORT-EX-1', invoice_date: L.day(0),
      subtotal: 1000, vat_amount: 150, finance_document_id: doc.id, lines: [{ description: 'رسوم مناولة', quantity: 1, unit_price: 1000, net_amount: 1000, vat_rate: 15, service_code: 'port_charges' }] }, newKey()]);
    x.inv = inv.id; x.line = inv.lines[0].id;
    const wrong = await api.R('acc', `SELECT public.allocate_invoice_line($1, $2, $3) r`, [x.line, J([{ transaction_id: x.tx, container_id: x.ct[0].id, amount: 1000 }]), newKey()]);
    await api.R('mgr', `SELECT public.approve_allocations($1::uuid[], $2) r`, [[wrong.allocations[0].id], null]);
    await expectErr('[A] the full line is allocated: a second allocation refused (MRS_OVER_ALLOCATED)', () =>
      api.R('acc', `SELECT public.allocate_invoice_line($1, $2, $3) r`, [x.line, J([{ transaction_id: x.tx, amount: 1 }]), newKey()]), /MRS_OVER_ALLOCATED/);
    await expectErr('[A] reversal needs a reason', () => api.R('mgr', `SELECT public.reverse_allocation($1, $2) r`, [wrong.allocations[0].id, null]), /MRS_NOTE_REQUIRED|MRS_REQUIRED/);
    await api.R('mgr', `SELECT public.reverse_allocation($1, $2) r`, [wrong.allocations[0].id, 'التخصيص على حاوية خاطئة']);
    const right = await api.R('acc', `SELECT public.allocate_invoice_line($1, $2, $3) r`, [x.line, J([{ transaction_id: x.tx, container_id: x.ct[1].id, share_pct: 60 }, { transaction_id: x.tx, container_id: x.ct[2].id, share_pct: 40 }]), newKey()]);
    await api.R('mgr', `SELECT public.approve_allocations($1::uuid[], $2) r`, [right.allocations.map(a => a.id), 'تصحيح التخصيص']);
    await api.R('acc', `SELECT public.set_supplier_invoice_status($1, 'under_review', NULL) r`, [x.inv]);
    await api.R('mgr', `SELECT public.set_supplier_invoice_status($1, 'approved', NULL) r`, [x.inv]);
    x.wrongAlloc = wrong.allocations[0].id;
    const al = await q(`SELECT status, amount, reverse_reason FROM public.cost_allocations WHERE line_id = $1 ORDER BY created_at`, [x.line]);
    const live = al.filter(a => a.status !== 'reversed' && a.status !== 'rejected').reduce((s, a) => s + L.cents(a.amount), 0);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance' AND payload ->> 'op' = 'allocation_reversed'`, [x.tx]);
    const evAny = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance'`, [x.tx]);
    if (al.length !== 3 || al[0].status !== 'reversed' || !al[0].reverse_reason || live !== 100000 || evAny < 1) throw new Error(J({ al, live, ev, evAny }));
    x.reversedEventOp = ev;
  });
  await evStep('exceptions', { id: 'x_appt_transport', title: '[A] appointment + transport stages' }, async () => {
    const id = await api.upload('clr', x.tx, 'delivery_order'); await api.classify('clr', id, 'delivery_order');
    await st('trn', 'appointment');
    for (const ct of x.ct) await as('A_trn', `UPDATE public.containers SET operational_state = 'released' WHERE id = $1`, [ct.id]);
    await st('trn', 'transport');
    for (const ct of x.ct) await as('A_trn', `UPDATE public.containers SET operational_state = 'delivered', delivered_at = now() WHERE id = $1`, [ct.id]);
    await st('trn', 'empty_return');
  });
  await evStep('exceptions', { id: 'x_multi_container', title: '[A] multi-container: one returned, one late (deadline passed → alert), one waived with a reason' }, async () => {
    x.note = await api.upload('trn', x.tx, 'empty_return_note'); await api.classify('clr', x.note, 'empty_return_note');
    for (let i = 0; i < 3; i++)
      await api.R('trn', `SELECT public.set_container_return($1, $2) r`, [x.ct[i].id, { return_yard_party_id: C.yard, return_instruction_document_id: x.note, return_deadline: i === 1 ? L.day(-2) : L.day(7) }]);
    const r1 = await api.upload('trn', x.tx, 'empty_return_receipt'); await api.classify('clr', r1, 'empty_return_receipt');
    await as('A_trn', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'returned_verified' WHERE id = $1`, [x.ct[0].id, r1]);
    await expectErr('[A] the Return Note alone is refused as proof (MRS_EVIDENCE_INVALID)', () =>
      as('A_trn', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'returned_verified' WHERE id = $1`, [x.ct[1].id, x.note]), /MRS_EVIDENCE_INVALID/);
    await expectErr('[A] transport staff cannot waive a container (MRS_FORBIDDEN)', () =>
      as('A_trn', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'x' WHERE id = $1`, [x.ct[2].id]), /MRS_FORBIDDEN/);
    await as('A_ops', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'حاوية مملوكة للعميل (SOC)' WHERE id = $1`, [x.ct[2].id]);
    await api.refresh();
    const a = await one(`SELECT severity, status FROM public.operational_alerts WHERE dedupe_key = $1`, ['empty_return_overdue:' + x.ct[1].id]);
    if (!a || a.severity !== 'critical' || a.status !== 'open') throw new Error('overdue alert ' + J(a));
  });
  await evStep('exceptions', { id: 'x_late_return', title: '[A] late empty return: demurrage case (create_demurrage_case) + operational exception; completion gate refuses' }, async () => {
    x.dem = await api.R('acc', `SELECT public.create_demurrage_case($1, $2) r`, [{ transaction_id: x.tx, container_id: x.ct[1].id, kind: 'demurrage', operator_id: C.yard, estimated_amount: 450,
      free_until: L.day(-2), charged_until: L.day(0) }, newKey()]);
    x.exc = (await api.R('trn', `SELECT public.create_exception($1, $2) r`, [{ transaction_id: x.tx, container_id: x.ct[1].id, kind: 'demurrage', reason: 'تأخر إرجاع الحاوية الفارغة', amount: 450 }, newKey()])).id;
    await expectErr('[A] completion refused while container 2 is not returned (MRS_CONTAINERS_NOT_RETURNED)', () => st('clr', 'operationally_complete'), /MRS_CONTAINERS_NOT_RETURNED/);
  });
  await evStep('exceptions', { id: 'x_late_receipt', title: '[A] late receipt verified, exceptions resolved with notes, transaction completed' }, async () => {
    const r2 = await api.upload('trn', x.tx, 'empty_return_receipt');
    await as('A_trn', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'evidence_submitted' WHERE id = $1`, [x.ct[1].id, r2]);
    await api.classify('clr', r2, 'empty_return_receipt');
    await as('A_trn', `UPDATE public.containers SET return_status = 'returned_verified' WHERE id = $1`, [x.ct[1].id]);
    await api.R('trn', `SELECT public.resolve_exception($1, 'resolved', 'سُددت رسوم التأخير') r`, [x.exc]);
    await api.R('clr', `SELECT public.resolve_exception($1, 'resolved', 'استُبدل البيان AEX-0002') r`, [x.excDecl]);
    const r = await st('clr', 'operationally_complete');
    if (r.to !== 'operationally_complete') throw new Error(J(r));
    await api.refresh();
    const a = await one(`SELECT status, resolution FROM public.operational_alerts WHERE dedupe_key = $1`, ['empty_return_overdue:' + x.ct[1].id]);
    if (!a || a.status !== 'resolved') throw new Error('overdue alert not resolved ' + J(a));
  });
}

/* ================================================================== 4. gate */
async function gate(W) {
  section('4. gate: no lost history, no doubled amounts, every correction has a reason and an event');
  const c = C.cycle, x = C.ex;
  await check('no lost history: per-table row counts never decrease across the run (' + HIST_TABLES.length + ' tables, ' + histSeries.length + ' points)', () => {
    const bad = [];
    for (let i = 1; i < histSeries.length; i++) for (const t of HIST_TABLES) if (histSeries[i].c[t] < histSeries[i - 1].c[t]) bad.push(t + ' @ ' + histSeries[i].title);
    return bad.length === 0 || bad.join('; ');
  });
  await check('zero DELETE audit rows on business tables (nothing hard-deleted)', async () => {
    const r = await q(`SELECT table_name, count(*)::int n FROM public.audit_log WHERE action = 'DELETE' GROUP BY 1`);
    return r.length === 0 || J(r);
  });
  await check('every invoice line: Σ live allocations ≤ net amount', async () => {
    const r = await q(`SELECT l.id, l.net_amount, coalesce(sum(a.amount) FILTER (WHERE a.status IN ('proposed','approved')), 0) s
                         FROM public.supplier_invoice_lines l LEFT JOIN public.cost_allocations a ON a.line_id = l.id
                        WHERE l.org_id = $1 GROUP BY l.id, l.net_amount HAVING coalesce(sum(a.amount) FILTER (WHERE a.status IN ('proposed','approved')), 0) > l.net_amount`, [A]);
    return r.length === 0 || J(r);
  });
  await check('per transaction: Σ billed intent lines = Σ approved / invoiced client charges (no charge billed twice)', async () => {
    const r = await q(`
      WITH b AS (SELECT l.transaction_id t, sum(l.total_amount) s, count(*) n, count(DISTINCT l.charge_id) d FROM public.billing_intent_lines l
                   JOIN public.billing_intents i ON i.id = l.intent_id WHERE l.org_id = $1 AND l.state <> 'removed' AND i.status <> 'cancelled' GROUP BY 1),
           ch AS (SELECT transaction_id t, sum(total_amount) s FROM public.client_charges WHERE org_id = $1 AND status IN ('approved','invoiced') GROUP BY 1)
      SELECT coalesce(b.t, ch.t) t, b.s bs, ch.s cs, b.n, b.d FROM b FULL JOIN ch ON ch.t = b.t
       WHERE coalesce(b.s, 0) <> coalesce(ch.s, 0) OR b.n <> b.d`, [A]);
    const any = await num(`SELECT count(*) n FROM public.billing_intent_lines WHERE org_id = $1`, [A]);
    return (r.length === 0 && any >= 4) || J({ r, any });
  });
  await check('Daftra mock document totals = intent line totals (every pushed intent)', async () => {
    const ins = await q(`SELECT i.id, i.external_invoice_id, (SELECT sum(l.total_amount) FROM public.billing_intent_lines l WHERE l.intent_id = i.id AND l.state <> 'removed') s
                           FROM public.billing_intents i WHERE i.org_id = $1 AND i.external_invoice_id IS NOT NULL`, [A]);
    const bad = ins.filter(i => { const m = W.dmocks[A].control.invoice(i.external_invoice_id); return !m || L.cents(m.totals.total) !== L.cents(i.s); })
      .map(i => ({ id: i.id, s: i.s, m: (W.dmocks[A].control.invoice(i.external_invoice_id) || {}).totals }));
    return (ins.length === 2 && bad.length === 0) || J({ n: ins.length, bad });
  });
  await check('one Daftra invoice per operational reference (no duplicate document)', () => {
    const st = W.dmocks[A].control.state();
    const refs = st.invoices.map(i => i.reference);
    return (refs.length === 2 && new Set(refs).size === refs.length) || J(refs);
  });
  await check('report totals = row sums (captured in the reports step)', () => {
    const t = c.reportTotals;
    return (t && t.transactions >= 4 && t.issued_sar > 0 && t.cost_items_sar > 0) || J(t);
  });
  await check('corrections carry a reason and an event: replaced declaration (cancel_reason + declaration event)', async () => {
    const d = await one(`SELECT cancel_reason FROM public.customs_declarations WHERE id = $1`, [x.d1]);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE event_type = 'declaration' AND payload ->> 'declaration_id' = $1`, [x.d1]);
    return (!!d.cancel_reason && ev >= 1) || J({ d, ev });
  });
  await check('corrections carry a reason and an event: reversed allocation (reverse_reason + finance event allocation_reversed)', async () => {
    const a = await one(`SELECT reverse_reason, status FROM public.cost_allocations WHERE id = $1`, [x.wrongAlloc]);
    const ev = await q(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance'`, [x.tx]);
    const hit = ev.filter(e => J(e.payload).includes('allocation_reversed') || J(e.payload).includes(x.wrongAlloc));
    return (a.status === 'reversed' && !!a.reverse_reason && hit.length >= 1) || J({ a, ops: ev.map(e => e.payload.op || e.payload.kind) });
  });
  await check('corrections carry a reason and an event: waived container (waiver_reason + container_return event)', async () => {
    const ct = await one(`SELECT waiver_reason FROM public.containers WHERE id = $1`, [x.ct[2].id]);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'container_return'`, [x.tx]);
    return (!!ct.waiver_reason && ev >= 1) || J({ ct, ev });
  });
  await check('corrections carry a reason and an event: exceptions resolved with a note (+ exception events)', async () => {
    const r = await q(`SELECT id, status, resolution_note FROM public.operational_exceptions WHERE transaction_id = $1`, [x.tx]);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'exception'`, [x.tx]);
    return (r.length === 2 && r.every(e => e.status === 'resolved' && e.resolution_note) && ev >= 4) || J({ r, ev });
  });
  await check('corrections carry a reason and an event: late charge review resolved with a note', async () => {
    const r = await one(`SELECT status, resolution_note, resolved_by FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge'`, [c.lateCharge]);
    return (r && r.status !== 'open' && !!(r.resolution_note || r.resolved_by)) || J(r);
  });
  await check('the issued Daftra invoice was never mutated after issue (content identical)', () => J(W.dmocks[A].control.invoice(c.ext)) === c.issuedSnapshot || 'changed');
  await check('no amount in transaction_events (finance events: ids and codes only, internal)', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE visible_to_client)::int v,
                                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(payload) k WHERE k ~* 'amount|price|total|vat'))::int k
                           FROM public.transaction_events WHERE event_type = 'finance'`);
    return (r.n > 5 && r.v === 0 && r.k === 0) || J(r);
  });
  await check('every worker adapter call used the job org (Daftra + inbox)', () =>
    (W.dUse.every(x => x.job_org === x.adapter_org) && W.iUse.every(x => x.job_org === x.channel_org) && W.dUse.length > 0 && W.iUse.length > 0) || 'cross-org adapter use');
  await check('no network: zero fetch calls', () => fetchCalls === 0 || fetchCalls + ' fetch call(s)');
}

/* ================================================================== evidence file */
function writeEvidence() {
  const lines = [];
  lines.push('# G7 — دليل تشغيل الدورة والاستثناءات (E2E evidence)');
  lines.push('');
  lines.push('> **مُولَّد آليًا** بواسطة `supabase/tests/g7-e2e-tests.js --write` على PGlite (Postgres 16 في الذاكرة) — لا تعدّله يدويًا.');
  lines.push('> بيانات تجريبية فقط (مؤسسة البذرة على بيئة الاختبار)، عامل Daftra حقيقي مع محوّل وهمي، وعامل البريد حقيقي مع صندوق وهمي، بلا شبكة.');
  lines.push('> لا معرّفات ولا طوابع زمنية في هذا الملف (حتمي)؛ السنة في المراجع مُقنّعة `YYYY`.');
  lines.push('> التكرار اليدوي للدورة على بيئة staging أثناء التجربة: **قيد انتظار المالك (OWNER-PENDING)**.');
  lines.push('');
  lines.push(`النتيجة: **${nPass} passed, ${nFail} failed** (${EVID.length} خطوة موثّقة).`);
  lines.push('');
  for (const g of ['cycle', 'exceptions']) {
    lines.push(g === 'cycle' ? '## الدورة التشغيلية (الخطوة ٣)' : '## الاستثناءات (الخطوة ٤)');
    lines.push('');
    lines.push('| # | الخطوة | أحداث المعاملة (transaction_events) | سجل التدقيق (audit_log) | مهام G5 / G6b |');
    lines.push('|---|---|---|---|---|');
    EVID.filter(e => e.group === g).forEach((e, i) => {
      const cell = a => (a.length ? a.join('<br>') : '—').replace(/\|/g, '\\|');
      lines.push(`| ${i + 1} | ${L.maskRef(e.title).replace(/\|/g, '\\|')} | ${cell(e.e.events)} | ${cell(e.e.audit)} | ${cell(e.e.jobs)} |`);
    });
    lines.push('');
  }
  lines.push('## البوابة (Gate)');
  lines.push('');
  lines.push('- لا فقد للسجل: أعداد صفوف ' + HIST_TABLES.map(t => '`' + t + '`').join('، ') + ' لا تنقص بين أي خطوتين.');
  lines.push('- صفر صفوف تدقيق `DELETE` على جداول الأعمال.');
  lines.push('- لا مبالغ مضاعفة: Σ التخصيصات ≤ صافي كل سطر فاتورة مورد؛ Σ أسطر الفوترة = Σ الرسوم المعتمدة لكل معاملة؛ مجاميع مستندات Daftra الوهمية = مجاميع نوايا الفوترة؛ مجاميع التقارير = مجموع الصفوف.');
  lines.push('- كل تصحيح يحمل سببًا وحدثًا (إلغاء البيان واستبداله، عكس التخصيص، التنازل عن حاوية، حل الاستثناءات، مراجعة الرسم المتأخر).');
  lines.push('');
  const out = path.join(ROOT, 'docs', 'online', 'G7_E2E_EVIDENCE.md');
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log('  wrote ' + path.relative(ROOT, out));
}

/* ================================================================== runner */
async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(G6B_MIGRATION)) { fail('G6b migration present', G6B_MIGRATION + ' not found'); return; }
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return;
  // legacy step 7 (20261123000100): the owner decisions default to HF5 (no edit of an existing Daftra draft) and resolve-only
  // products (never created); this suite drives the G5 billing cycle, so its connections start with the G5 write policy
  await db.exec(`ALTER TABLE public.daftra_connections ALTER COLUMN allow_draft_update SET DEFAULT true, ALTER COLUMN allow_product_create SET DEFAULT true`);
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  try { const r = await fixtures(); r.n === 15 ? pass('fixtures: org A staff users (seed-style), default document requirements') : fail('fixtures', 'requirements seeded: ' + r.n); }
  catch (e) { fail('fixtures', errText(e)); return; }
  await check('ISO 6346 helper: CSQU305438 → check digit 3 (fixture container numbers are valid)', () => L.isoContainer('CSQU', 305438) === 'CSQU3054383' || L.isoContainer('CSQU', 305438));
  const W = L.createWorkers(H, ROOT);
  try {
    section('1. setup — org A');
    await L.setupOrg(H, W, ORG);
    histSeries.push({ title: 'setup', c: await histCounts() });
    await cycle(W);
    await exceptions(W);
  } catch (e) { fail('cycle', errText(e)); }
  try { await gate(W); } catch (e) { fail('gate', errText(e)); }
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (WRITE) { try { writeEvidence(); } catch (e) { fail('write evidence', errText(e)); } }
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

async function main() {
  await templateChecks();
  await dbMain();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/*
  Marsa (مرسى) — G4 step ١٣ end-to-end costs cycle (docs/online/G4_SPEC.md). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea". Users: accA accountant (org-wide) · mgrA accounts_manager (org-wide) ·
  opsA operations_manager (org-wide; trips, costs) · clientA portal user of client 101 (TX-A).

  Scenario (every step through the RPCs / RLS the UI uses):
    1. TX-A (2 containers, 2 trips 800 + 800 SAR agreed) and TX-B (1 trip 500): 3 open accruals, margin estimated
    2. carrier invoice C1 (800 / 800 / 500 + 15 % VAT) allocated to the trips (accrual_id) and approved:
       accruals matched, TX-A cost 1600 confirmed — not 3200
    3. duplicate: C1 re-entered as "inv 1" → invoice_number_taken; a near copy → possible duplicate →
       duplicate_invoice adjustment approved → the copy is void, costs unchanged
    4. shared port invoice P1 (1000) 60 % TX-A / 40 % TX-B; 0.01 more refused; Σ exactly 1000
    5. C1 paid 50 % → partial, then the rest → paid; payables tiles separate; overpay refused
    6. storage invoice S1 (TX-B, demurrage case) paid directly by the client: client_paid_direct, not company
       cash nor confirmed cost; reimbursable charge refused; tracker: paid_by_client_to_operator, paid_to_operator 0
    7. trip cost 800 → 950 after match: variance (pending 950), cost stays 800; keep_amount → matched;
       cancelling a matched trip → variance, never a negative or doubled cost
    8. TX-A charges: service 2500 + reimbursable P1 share at cost, approved; a collection; exact margin, gap 0
    9. gate: invariants, nothing auto-created, no amount in events, the client sees nothing

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g4-cycle-tests.js [/path/to/marsa-website] [--quiet]
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
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102';
const TXA = 'c4c40000-0000-4000-8000-000000000201';
const TXB = 'c4c40000-0000-4000-8000-000000000202';
const CA1 = 'c4c40000-0000-4000-8000-000000000301';
const CA2 = 'c4c40000-0000-4000-8000-000000000302';
const CB1 = 'c4c40000-0000-4000-8000-000000000303';
const PK = 'c4c40000-0000-4000-8000-0000000000a1';   // carrier
const PT = 'c4c40000-0000-4000-8000-0000000000a2';   // terminal operator
const PP = 'c4c40000-0000-4000-8000-0000000000a3';   // port services supplier
const U = {
  accA: 'c4c40000-0000-4000-8000-000000000001',
  mgrA: 'c4c40000-0000-4000-8000-000000000002',
  opsA: 'c4c40000-0000-4000-8000-000000000003',
  clientA: 'c4c40000-0000-4000-8000-000000000004'
};
const G4_TABLES = ['finance_documents', 'supplier_invoices', 'supplier_invoice_lines', 'cost_allocations', 'cost_accruals',
  'supplier_payments', 'client_charges', 'charge_collections', 'demurrage_cases', 'cost_adjustments'];
let keySeq = 0;
const newKey = () => `0e4c0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(64, 'd');
const today = () => new Date().toISOString().slice(0, 10);
const N = x => (x === null || x === undefined) ? x : Number(x);

/* ------------------------------------------------------------------ helpers */
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
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
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
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const margin = (who, tx) => rpc(who, `SELECT public.tx_margin($1) r`, [tx]);
const sar = m => m.currencies.find(c => c.currency === 'SAR') || {};
const doc = (who, branch, kind) => rpc(who, `SELECT public.register_finance_document($1, $2) r`,
  [{ branch_id: branch, kind: kind || 'supplier_invoice', original_name: 'original.pdf', mime_type: 'application/pdf', size_bytes: 4096, sha256: newSha() }, newKey()]);
const invoice = (who, p) => rpc(who, `SELECT public.create_supplier_invoice($1, $2) r`, [p, newKey()]);
const alloc = (who, line, targets) => rpc(who, `SELECT public.allocate_invoice_line($1, $2, $3) r`, [line, JSON.stringify(targets), newKey()]);
const approve = (who, ids, note) => rpc(who, `SELECT public.approve_allocations($1::uuid[], $2) r`, [ids, note || null]);
const invSt = (who, id, st, note) => rpc(who, `SELECT public.set_supplier_invoice_status($1, $2, $3) r`, [id, st, note || null]);
const pay = (who, p) => rpc(who, `SELECT public.record_supplier_payment($1, $2) r`, [p, newKey()]);
const payables = who => rpc(who, `SELECT public.list_supplier_payments($1, '{}') r`, [A]).then(r => r.totals_by_currency.SAR);
const txItemsSum = tx => one(`SELECT coalesce(sum(amount), 0)::numeric s, count(*)::int n FROM app.fin_cost_items($1, $2)`, [A, tx]).then(r => N(r.s));
const accrualsOf = tx => q(`SELECT * FROM public.cost_accruals WHERE transaction_id = $1 ORDER BY created_at`, [tx]);

/* ------------------------------------------------------------------ fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g4cycle.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.accA}', '${A}', NULL, 'accountant'), ('${U.mgrA}', '${A}', NULL, 'accounts_manager'),
      ('${U.opsA}', '${A}', NULL, 'operations_manager'), ('${U.clientA}', '${A}', NULL, 'client');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description) VALUES
      ('${TXA}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 2, 'أجهزة'),
      ('${TXB}', '${A}', '${DMM}', '${CL102}', 'import', 'sea', 1, 'مواد غذائية');
    INSERT INTO public.containers (id, org_id, transaction_id, container_no) VALUES
      ('${CA1}', '${A}', '${TXA}', 'CYCU4000001'), ('${CA2}', '${A}', '${TXA}', 'CYCU4000002'), ('${CB1}', '${A}', '${TXB}', 'CYCU4000003');
    INSERT INTO public.parties (id, org_id, kinds, name_ar, vat_number) VALUES
      ('${PK}', '${A}', ARRAY['carrier'], 'شركة النقل البري', '300000000000444'),
      ('${PT}', '${A}', ARRAY['terminal_operator'], 'محطة الحاويات', '300000000000555'),
      ('${PP}', '${A}', ARRAY['supplier','shipping_agent'], 'خدمات الميناء', NULL);
  `);
}

/* ------------------------------------------------------------------ the cycle */
const C = {};

async function cycle() {
  section('1. two transactions, three trips with agreed costs');
  C.ta1 = await step('TX-A trip 1 (container 1, 800 SAR agreed)', () => rpc('opsA', `SELECT public.create_trip($1) r`,
    [{ transaction_id: TXA, container_id: CA1, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed' }]));
  C.ta2 = await step('TX-A trip 2 (container 2, 800 SAR agreed)', () => rpc('opsA', `SELECT public.create_trip($1) r`,
    [{ transaction_id: TXA, container_id: CA2, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed' }]));
  C.tb1 = await step('TX-B trip (500 SAR agreed)', () => rpc('opsA', `SELECT public.create_trip($1) r`,
    [{ transaction_id: TXB, container_id: CB1, carrier_id: PK, cost_amount: 500, cost_basis: 'agreed' }]));
  await check('3 open accruals (agreed), one per trip', async () => {
    const r = await q(`SELECT id, trip_id, status, basis, amount FROM public.cost_accruals WHERE transaction_id IN ($1, $2)`, [TXA, TXB]);
    C.acc = {};
    for (const x of r) C.acc[x.trip_id] = x;
    return (r.length === 3 && r.every(x => x.status === 'open' && x.basis === 'agreed')
            && N(C.acc[C.ta1.id].amount) === 800 && N(C.acc[C.tb1.id].amount) === 500) || JSON.stringify(r);
  });
  await check('tx_margin TX-A: estimated, cost_estimated 1600, nothing confirmed', async () => {
    const m = await margin('accA', TXA); const c = sar(m);
    return (m.level === 'estimated' && N(c.cost_estimated) === 1600 && N(c.cost_confirmed) === 0
            && m.pending.filter(p => p.type === 'open_accrual').length === 2) || JSON.stringify(m);
  });

  section('2. carrier invoice C1 matched to the trips');
  const d1 = await step('original of C1 registered (finance bucket path)', () => doc('accA', JED));
  C.c1 = await step('C1 INV-0001: 3 lines 800 / 800 / 500 + 15 % VAT', () => invoice('accA', {
    branch_id: JED, supplier_id: PK, invoice_number: 'INV-0001', invoice_date: today(), subtotal: 2100, vat_amount: 315,
    finance_document_id: d1.id, reference: 'نقل الحاويات',
    lines: [
      { description: 'نقل الحاوية CYCU4000001', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' },
      { description: 'نقل الحاوية CYCU4000002', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' },
      { description: 'نقل الحاوية CYCU4000003', quantity: 1, unit_price: 500, net_amount: 500, vat_rate: 15, service_code: 'transport' }] }));
  await check('C1: total 2415, lines ok, no discrepancy', async () =>
    (N(C.c1.total_amount) === 2415 && C.c1.lines.every(l => l.review_status === 'ok') && N(C.c1.discrepancy.total) === 0) || JSON.stringify(C.c1));
  const [l1, l2, l3] = C.c1.lines.map(l => l.id);
  C.a = [];
  C.a.push((await step('line 1 → TX-A trip 1 (accrual_id)', () => alloc('accA', l1, [{ transaction_id: TXA, container_id: CA1, trip_id: C.ta1.id, accrual_id: C.acc[C.ta1.id].id, amount: 800 }]))).allocations[0]);
  C.a.push((await step('line 2 → TX-A trip 2 (accrual_id)', () => alloc('accA', l2, [{ transaction_id: TXA, container_id: CA2, trip_id: C.ta2.id, accrual_id: C.acc[C.ta2.id].id, amount: 800 }]))).allocations[0]);
  C.a.push((await step('line 3 → TX-B trip (accrual_id)', () => alloc('accA', l3, [{ transaction_id: TXB, container_id: CB1, trip_id: C.tb1.id, accrual_id: C.acc[C.tb1.id].id, amount: 500 }]))).allocations[0]);
  await step('allocations approved by the accounts manager (four eyes)', () => approve('mgrA', C.a.map(x => x.id), 'مطابقة فاتورة الناقل'));
  await step('C1 under review → approved', async () => { await invSt('accA', C.c1.id, 'under_review'); return invSt('mgrA', C.c1.id, 'approved'); });
  await check('all three accruals matched', async () => {
    const r = await q(`SELECT status, matched_amount, amount FROM public.cost_accruals WHERE transaction_id IN ($1, $2)`, [TXA, TXB]);
    return r.every(x => x.status === 'matched' && N(x.matched_amount) === N(x.amount)) || JSON.stringify(r);
  });
  await check('TX-A cost = 1600 confirmed, NOT 3200 (accrual + invoice never both counted)', async () => {
    const m = await margin('accA', TXA); const c = sar(m);
    const s = await txItemsSum(TXA);
    return (N(c.cost_confirmed) === 1600 && N(c.cost_estimated) === 0 && s === 1600) || JSON.stringify({ c, s });
  });

  section('3. duplicate invoice');
  await expectErr('C1 re-entered as "inv 1" (same number_norm INV1) → invoice_number_taken', () => invoice('accA', {
    branch_id: JED, supplier_id: PK, invoice_number: 'inv 1', invoice_date: today(), subtotal: 2100, vat_amount: 315 }), /MRS_INVALID invoice_number_taken/);
  C.dup = await step('the copy registered under a slightly different number (INV-0001A, same total / date)', () => invoice('accA', {
    branch_id: JED, supplier_id: PK, invoice_number: 'INV-0001A', invoice_date: today(), subtotal: 2100, vat_amount: 315,
    lines: [{ description: 'نقل 3 حاويات', quantity: 1, unit_price: 2100, net_amount: 2100, vat_rate: 15, service_code: 'transport' }] }));
  await check('possible_duplicates reports C1 (same supplier, total, date)', async () =>
    C.dup.possible_duplicates.some(p => p.id === C.c1.id && p.reasons.includes('same_supplier_total_date')) || JSON.stringify(C.dup.possible_duplicates));
  const dj = await step('duplicate_invoice adjustment proposed (the copy → C1)', () => rpc('accA', `SELECT public.create_cost_adjustment($1, $2) r`,
    [{ kind: 'duplicate_invoice', supplier_invoice_id: C.dup.id, related_invoice_id: C.c1.id, reason: 'نسخة مكررة من INV-0001' }, newKey()]));
  await step('approved by the accounts manager', () => rpc('mgrA', `SELECT public.review_cost_adjustment($1, 'approved', 'مكررة') r`, [dj.id]));
  await check('the copy is void (duplicate_of_id = C1), its line kept; TX-A cost unchanged (1600)', async () => {
    const v = await one(`SELECT status, duplicate_of_id, void_reason FROM public.supplier_invoices WHERE id = $1`, [C.dup.id]);
    const n = await count(`SELECT count(*)::int n FROM public.supplier_invoice_lines WHERE supplier_invoice_id = $1`, [C.dup.id]);
    const s = await txItemsSum(TXA);
    const items = await count(`SELECT count(*)::int n FROM app.fin_cost_items($1) WHERE supplier_invoice_id = $2`, [A, C.dup.id]);
    return (v.status === 'void' && v.duplicate_of_id === C.c1.id && n === 1 && s === 1600 && items === 0) || JSON.stringify({ v, n, s, items });
  });

  section('4. shared port invoice');
  const d2 = await step('original of P1', () => doc('accA', JED));
  C.p1 = await step('P1: one line 1000 port charges + VAT', () => invoice('accA', {
    branch_id: JED, supplier_id: PP, invoice_number: 'P-2026-77', invoice_date: today(), subtotal: 1000, vat_amount: 150, finance_document_id: d2.id,
    lines: [{ description: 'رسوم مناولة مشتركة', quantity: 1, unit_price: 1000, net_amount: 1000, vat_rate: 15, service_code: 'port_charges' }] }));
  const pa = await step('allocated by share: 60 % TX-A, 40 % TX-B', () => alloc('accA', C.p1.lines[0].id, [{ transaction_id: TXA, share_pct: 60 }, { transaction_id: TXB, share_pct: 40 }]));
  C.pA = pa.allocations[0]; C.pB = pa.allocations[1];
  await expectErr('a third allocation of 0.01 → MRS_OVER_ALLOCATED', () => alloc('accA', C.p1.lines[0].id, [{ transaction_id: TXA, amount: 0.01 }]), /MRS_OVER_ALLOCATED/);
  await check('600 + 400 = exactly 1000', async () => (N(C.pA.amount) === 600 && N(C.pB.amount) === 400 && N(pa.remaining) === 0) || JSON.stringify(pa));
  await step('P1 allocations + invoice approved', async () => {
    await approve('mgrA', [C.pA.id, C.pB.id]); await invSt('accA', C.p1.id, 'under_review'); return invSt('mgrA', C.p1.id, 'approved');
  });
  await check('costs: TX-A 2200 confirmed, TX-B 900 confirmed', async () => {
    const a = sar(await margin('accA', TXA)); const b = sar(await margin('accA', TXB));
    return (N(a.cost_confirmed) === 2200 && N(b.cost_confirmed) === 900) || JSON.stringify({ a, b });
  });

  section('5. partial and full payment of C1');
  const pv = await step('payment evidence registered', () => doc('accA', JED, 'payment_evidence'));
  const pay1 = await step('C1 paid 50 % (1207.50)', () => pay('accA', { supplier_invoice_id: C.c1.id, amount: 1207.5, paid_at: today(), method: 'bank_transfer', evidence_document_id: pv.id }));
  await check('C1 partial', async () => pay1.invoice.payment_status === 'partial' || JSON.stringify(pay1));
  await check('payables: due / paid shown separately (due 1150 P1 + 1207.50 C1; paid 1207.50)', async () => {
    const t = await payables('mgrA');
    return (N(t.due_approved_unpaid) === 2357.5 && N(t.paid_by_company) === 1207.5 && N(t.paid_by_client_direct) === 0) || JSON.stringify(t);
  });
  const pay2 = await step('the rest (1207.50) → paid', () => pay('accA', { supplier_invoice_id: C.c1.id, amount: 1207.5, method: 'bank_transfer', reference: 'TRF-2' }));
  await check('C1 paid', async () => pay2.invoice.payment_status === 'paid' || JSON.stringify(pay2));
  await expectErr('an overpay attempt (0.01) → MRS_OVERPAID', () => pay('accA', { supplier_invoice_id: C.c1.id, amount: 0.01, method: 'cash', reference: 'x' }), /MRS_OVERPAID/);
  await check('payables after: due 1150 (P1), paid by company 2415', async () => {
    const t = await payables('mgrA');
    return (N(t.due_approved_unpaid) === 1150 && N(t.paid_by_company) === 2415) || JSON.stringify(t);
  });

  section('6. storage invoice paid directly by the client');
  C.dc = await step('demurrage case on TX-B (storage, terminal, estimate 400)', () => rpc('accA', `SELECT public.create_demurrage_case($1, $2) r`,
    [{ transaction_id: TXB, container_id: CB1, kind: 'storage', operator_id: PT, estimated_amount: 400, free_until: '2026-10-20', charged_until: '2026-10-28' }, newKey()]));
  const d3 = await step('original of S1', () => doc('accA', DMM));
  C.s1 = await step('S1: storage 400 + VAT 60', () => invoice('accA', {
    branch_id: DMM, supplier_id: PT, invoice_number: 'ST-5501', invoice_date: today(), subtotal: 400, vat_amount: 60, finance_document_id: d3.id,
    lines: [{ description: 'أرضيات 8 أيام', quantity: 8, unit_price: 50, net_amount: 400, vat_rate: 15, service_code: 'storage', container_no_hint: 'CYCU4000003' }] }));
  const sa = await step('S1 line → the demurrage case (its accrual matched automatically)', () => alloc('accA', C.s1.lines[0].id, [{ transaction_id: TXB, container_id: CB1, demurrage_case_id: C.dc.id, amount: 400 }]));
  C.sA = sa.allocations[0];
  await step('approved (allocation + invoice)', async () => { await approve('mgrA', [C.sA.id]); await invSt('accA', C.s1.id, 'under_review'); return invSt('mgrA', C.s1.id, 'approved'); });
  const cev = await step('client payment evidence (transfer slip from the client)', () => doc('accA', DMM, 'payment_evidence'));
  const cp = await step('S1 paid by the client directly (payer client, evidence)', () => pay('accA', { supplier_invoice_id: C.s1.id, amount: 460, method: 'bank_transfer',
    payer: 'client', client_id: CL102, evidence_document_id: cev.id }));
  await check('S1 paid_directly_by_client', async () => cp.invoice.payment_status === 'paid_directly_by_client' || JSON.stringify(cp));
  await check('TX-B: client_paid_direct = 400 (S1 net); cost confirmed excludes S1 (900); company paid excludes S1', async () => {
    const b = sar(await margin('accA', TXB)); const t = await payables('mgrA');
    return (N(b.client_paid_direct) === 400 && N(b.cost_confirmed) === 900 && N(t.paid_by_company) === 2415 && N(t.paid_by_client_direct) === 460)
      || JSON.stringify({ b, t });
  });
  await expectErr('a reimbursable charge on S1 → MRS_INVALID paid_by_client', () => rpc('accA', `SELECT public.create_client_charge($1, $2) r`,
    [{ transaction_id: TXB, kind: 'reimbursable', description: 'أرضيات', source: 'from_cost', cost_allocation_id: C.sA.id }, newKey()]), /MRS_INVALID paid_by_client/);
  await check('tracker: paid_by_client_to_operator 460, paid_to_operator 0, nothing left to pay the operator', async () => {
    const r = await rpc('accA', `SELECT public.list_demurrage($1, $2) r`, [A, { transaction_id: TXB }]);
    const f = r.items[0].figures;
    return (N(f.paid_by_client_to_operator) === 460 && N(f.paid_to_operator) === 0 && N(f.operator_due) === 460 && N(f.remaining.to_pay_operator) === 0
            && N(f.charged_to_client) === 0) || JSON.stringify(f);
  });

  section('7. trip cost changed after matching; a matched trip cancelled');
  await step('TX-A trip 1 cost 800 → 950 (finance edit on the trip)', () => rpc('opsA', `SELECT public.update_trip($1, $2) r`, [C.ta1.id, { cost_amount: 950 }]));
  await check('accrual → variance, pending 950; the counted cost stays 800 (invoice)', async () => {
    const a = await one(`SELECT * FROM public.cost_accruals WHERE trip_id = $1 AND status <> 'void'`, [C.ta1.id]);
    const m = sar(await margin('accA', TXA));
    return (a.status === 'variance' && N(a.pending_amount) === 950 && N(a.amount) === 800 && a.variance_reason === 'trip_cost_changed_after_match'
            && N(m.cost_confirmed) === 2200 && N(m.cost_estimated) === 0) || JSON.stringify({ a, m });
  });
  await step('review keep_amount (the agreed price stands)', () => rpc('mgrA', `SELECT public.review_accrual_variance($1, 'keep_amount', 'السعر المتفق عليه 800') r`,
    [C.acc[C.ta1.id].id]));
  await check('→ matched again', async () => (await one(`SELECT status FROM public.cost_accruals WHERE id = $1`, [C.acc[C.ta1.id].id])).status === 'matched');
  await step('TX-A trip 2 (matched) cancelled', () => rpc('opsA', `SELECT public.set_trip_status($1, 'cancelled', NULL, 'ألغى العميل التسليم الثاني') r`, [C.ta2.id]));
  await check('its accrual → variance (trip_cancelled_after_match); cost stays 2200, never negative or doubled', async () => {
    const a = await one(`SELECT status, variance_reason FROM public.cost_accruals WHERE id = $1`, [C.acc[C.ta2.id].id]);
    const m = sar(await margin('accA', TXA));
    const neg = await count(`SELECT count(*)::int n FROM app.fin_cost_items($1) WHERE amount < 0`, [A]);
    return (a.status === 'variance' && a.variance_reason === 'trip_cancelled_after_match' && N(m.cost_confirmed) === 2200
            && N(m.cost_estimated) === 0 && neg === 0 && await txItemsSum(TXA) === 2200) || JSON.stringify({ a, m, neg });
  });

  section('8. client charges and a collection for TX-A');
  C.chS = await step('service charge 2500 (manual, VAT 15 %)', () => rpc('accA', `SELECT public.create_client_charge($1, $2) r`,
    [{ transaction_id: TXA, kind: 'service', description: 'أتعاب التخليص والنقل', unit_price: 2500, service_code: 'customs_clearance' }, newKey()]));
  C.chR = await step('reimbursable: TX-A share of P1 at cost (600, VAT 0)', () => rpc('accA', `SELECT public.create_client_charge($1, $2) r`,
    [{ transaction_id: TXA, kind: 'reimbursable', description: 'رسوم الميناء (حصة المعاملة)', source: 'from_cost', cost_allocation_id: C.pA.id }, newKey()]));
  await check('reimbursable priced from the cost (600), linked once', async () =>
    (N(C.chR.unit_price) === 600 && N(C.chR.vat_rate) === 0 && C.chR.cost_allocation_id === C.pA.id && N(C.chS.total_amount) === 2875) || JSON.stringify(C.chR));
  await step('both approved', async () => {
    await rpc('mgrA', `SELECT public.set_charge_status($1, 'approved') r`, [C.chS.id]);
    return rpc('mgrA', `SELECT public.set_charge_status($1, 'approved') r`, [C.chR.id]);
  });
  C.col = await step('collection of 1000 recorded on the service charge (evidence of payment, not a receipt)', () => rpc('accA', `SELECT public.record_charge_collection($1, $2) r`,
    [{ charge_id: C.chS.id, amount: 1000, method: 'bank_transfer', reference: 'COLL-1' }, newKey()]));
  await check('tx_margin TX-A: service 2500, cost confirmed 1600 (P1 share is pass-through), margin 900, reimbursable gap 0', async () => {
    const m = await margin('accA', TXA); const c = sar(m);
    return (N(c.charges_service) === 2500 && N(c.cost_confirmed) === 1600 && N(c.margin_confirmed) === 900 && N(c.margin_expected) === 900
            && N(c.reimbursable_charged) === 600 && N(c.pass_through_cost) === 600 && N(c.reimbursable_gap) === 0
            && !m.pending.some(p => p.type === 'reimbursable_gap') && m.analytical === true) || JSON.stringify(m);
  });

  section('9. gate (exit criteria)');
  await check('for every invoice: Σ cost items = Σ non-excluded net (void invoices: none)', async () => {
    const r = await q(`
      SELECT i.id, i.status, coalesce((SELECT sum(l.net_amount) FROM public.supplier_invoice_lines l WHERE l.supplier_invoice_id = i.id AND l.review_status <> 'excluded'), 0) net,
             coalesce((SELECT sum(x.amount) FROM app.fin_cost_items($1) x WHERE x.supplier_invoice_id = i.id), 0) items
        FROM public.supplier_invoices i WHERE i.org_id = $1`, [A]);
    const bad = r.filter(x => (x.status === 'void' ? N(x.items) !== 0 : N(x.items) !== N(x.net)));
    return (bad.length === 0 && r.length === 4) || JSON.stringify(r);
  });
  await check('for every transaction: Σ cost items = the expected numbers (TX-A 2200, TX-B 1300)', async () => {
    const a = await txItemsSum(TXA); const b = await txItemsSum(TXB);
    return (a === 2200 && b === 1300) || JSON.stringify({ a, b });
  });
  await check('no trip has both an accrual item and an allocation item counted', async () => {
    const r = await q(`SELECT x.trip_id FROM app.fin_cost_items($1) i JOIN public.cost_accruals x ON x.id = i.ref_id
                        WHERE i.source = 'accrual' AND x.trip_id IS NOT NULL
                          AND EXISTS (SELECT 1 FROM app.fin_cost_items($1) j JOIN public.cost_allocations a ON a.id = j.ref_id
                                       WHERE j.source = 'allocation' AND a.trip_id = x.trip_id)`, [A]);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('nothing auto-created: 3 payments, 1 collection, 2 charges = the recorded actions', async () => {
    const r = await one(`SELECT (SELECT count(*)::int FROM public.supplier_payments) p, (SELECT count(*)::int FROM public.charge_collections) k,
                                (SELECT count(*)::int FROM public.client_charges) c`);
    return (r.p === 3 && r.k === 1 && r.c === 2) || JSON.stringify(r);
  });
  await check('Σ payments ≤ invoice totals; Σ collections ≤ charge totals', async () => {
    const p = await count(`SELECT count(*)::int n FROM public.supplier_invoices i
                            WHERE (SELECT coalesce(sum(amount), 0) FROM public.supplier_payments s WHERE s.supplier_invoice_id = i.id AND s.status = 'recorded') > i.total_amount`);
    const k = await count(`SELECT count(*)::int n FROM public.client_charges c
                            WHERE (SELECT coalesce(sum(amount), 0) FROM public.charge_collections k WHERE k.charge_id = c.id AND k.status = 'recorded') > c.total_amount`);
    return (p === 0 && k === 0) || JSON.stringify({ p, k });
  });
  await check('no amount appears in transaction_events (finance events: ids and codes only, internal)', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE visible_to_client)::int v,
                                count(*) FILTER (WHERE jsonb_path_exists(payload, '$.** ? (@.type() == "number")'))::int num,
                                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(payload) k WHERE k ~* 'amount|price|total|vat'))::int k
                           FROM public.transaction_events WHERE event_type = 'finance'`);
    return (r.n > 10 && r.v === 0 && r.num === 0 && r.k === 0) || JSON.stringify(r);
  });
  await check('transactions.financial_status untouched by G4', async () => {
    const r = await q(`SELECT financial_status FROM public.transactions WHERE id IN ($1, $2)`, [TXA, TXB]);
    return r.every(x => x.financial_status === 'not_started') || JSON.stringify(r);
  });
  for (const t of G4_TABLES) {
    await check(`client sees 0 rows of ${t}`, async () => {
      try { const r = await as('clientA', `SELECT 1 FROM public.${t}`); return r.length === 0 || r.length + ' rows'; }
      catch (e) { return /permission denied/.test(errText(e)) || errText(e); }
    });
  }
  for (const [name, sql, params] of [
    ['tx_margin', `SELECT public.tx_margin($1) r`, [TXA]], ['tx_costs', `SELECT public.tx_costs($1) r`, [TXA]],
    ['list_client_charges', `SELECT public.list_client_charges($1) r`, [TXA]], ['suggest_client_charges', `SELECT public.suggest_client_charges($1) r`, [TXA]],
    ['list_supplier_invoices', `SELECT public.list_supplier_invoices($1) r`, [A]], ['margin_report', `SELECT public.margin_report($1) r`, [A]],
    ['cost_report', `SELECT public.cost_report($1, '{"group_by":"transaction"}') r`, [A]], ['list_demurrage', `SELECT public.list_demurrage($1) r`, [A]],
    ['get_supplier_invoice', `SELECT public.get_supplier_invoice($1) r`, [C.c1.id]]]) {
    await expectErr(`client: ${name} returns nothing (MRS_NOT_FOUND / MRS_FORBIDDEN)`, () => rpc('clientA', sql, params), /MRS_NOT_FOUND|MRS_FORBIDDEN/);
  }
  await check('client sees no finance events in the timeline', async () =>
    (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'finance'`))[0].n === 0);
}

async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: finance users, TX-A (2 containers, JED), TX-B (1 container, DMM), carrier / terminal / port parties'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  try { await cycle(); }
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

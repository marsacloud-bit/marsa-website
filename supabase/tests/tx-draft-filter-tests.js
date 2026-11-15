#!/usr/bin/env node
/*
  Marsa (مرسى) — transactions list: «الاعتماد» filter (drafts only / approved only), 2026-11-15.
  LOCAL TESTS ONLY. No database, no network (fetch throws). supa.js runs in a vm against a recording query builder.

  Covers: listTransactions({draft}) → the PostgREST filter (is_draft = true / false / none), combined with the other
  filters; a database without is_draft (42703 on the first read) → 'only' returns nothing, 'approved' adds no filter;
  admin.js wires the select (default '', options '' / only / approved, passed as draft) inside the legacy block;
  the labels exist in Arabic and English.

  usage:
    node supabase/tests/tx-draft-filter-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (!r) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + (e && e.stack || e)); }
}
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in tx-draft-filter-tests'); };

/* ------------------------------------------------------------------ recording client */
const reads = [];          // one entry per from('transactions') chain: { select, ops: [[method, ...args]] }
let failFirstOnDraft = false;
function builder(table) {
  const rec = { table, ops: [] };
  if (table === 'transactions') reads.push(rec);
  const result = () => {
    const sel = (rec.ops.find(o => o[0] === 'select') || [])[1] || '';
    if (table === 'transactions' && failFirstOnDraft && /is_draft/.test(sel)) {
      failFirstOnDraft = false;
      return { data: null, count: null, error: { code: '42703', message: 'column transactions.is_draft does not exist', details: '' } };
    }
    return { data: [], count: 0, error: null };
  };
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then') return (res, rej) => Promise.resolve(result()).then(res, rej);
      return (...a) => { rec.ops.push([k].concat(a)); return p; };
    }
  });
  return p;
}
const client = {
  from: t => builder(t),
  rpc: () => Promise.resolve({ data: null, error: null }),
  auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'd7c20000-0000-4000-8000-000000000001' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }
};
function loadApi() {
  const win = { MARSA_CONFIG: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' },
    supabase: { createClient: () => client }, addEventListener() {}, dispatchEvent() {},
    location: { origin: 'http://127.0.0.1:8000', pathname: '/admin.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/admin.html' } };
  const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
      documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { onLine: true }, location: win.location, console, setTimeout, clearTimeout, Promise, CustomEvent: function () {},
    crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
  win.window = win;
  vm.createContext(ctx); vm.runInContext(rd('assets/js/supa.js'), ctx);
  return win.MarsaApi;
}
const ORG = '0b5e0000-0000-4000-8000-000000000001';
const draftOps = r => r.ops.filter(o => (o[0] === 'eq' && o[1] === 'is_draft') || (o[0] === 'is' && o[1] === 'id'));
async function list(api, o) { reads.length = 0; await api.listTransactions(Object.assign({ orgId: ORG, limit: 50, offset: 0 }, o)); return reads.slice(); }

async function main() {
  let api = null;
  try { api = loadApi(); } catch (e) { fail('supa.js loads in a vm', String(e)); }
  if (!api || typeof api.listTransactions !== 'function') { fail('MarsaApi.listTransactions', 'not loaded'); return finish(); }

  await check('no draft option → no is_draft filter (is_draft still selected)', async () => {
    const r = await list(api, {});
    const sel = (r[0].ops.find(o => o[0] === 'select') || [])[1] || '';
    return (r.length === 1 && draftOps(r[0]).length === 0 && /is_draft/.test(sel)) || J(r.map(x => x.ops));
  });
  await check("draft: 'only' → eq(is_draft, true), once", async () => {
    const r = await list(api, { draft: 'only' });
    return (r.length === 1 && J(draftOps(r[0])) === J([['eq', 'is_draft', true]])) || J(r.map(x => x.ops));
  });
  await check("draft: 'approved' → eq(is_draft, false), once", async () => {
    const r = await list(api, { draft: 'approved' });
    return (r.length === 1 && J(draftOps(r[0])) === J([['eq', 'is_draft', false]])) || J(r.map(x => x.ops));
  });
  await check("an unknown draft value → no filter", async () => {
    const r = await list(api, { draft: 'yes' });
    return draftOps(r[0]).length === 0 || J(r[0].ops);
  });
  await check("combined with cancelled 'exclude' + status: all three filters on the same query", async () => {
    const r = await list(api, { draft: 'only', cancelled: 'exclude', status: 'new' });
    const o = r[0].ops;
    return (o.some(x => x[0] === 'eq' && x[1] === 'is_draft' && x[2] === true) && o.some(x => x[0] === 'is' && x[1] === 'cancelled_at' && x[2] === null)
      && o.some(x => x[0] === 'eq' && x[1] === 'operational_status' && x[2] === 'new') && o.some(x => x[0] === 'eq' && x[1] === 'org_id' && x[2] === ORG)) || J(o);
  });
  await check("DB without is_draft: 'only' → retried without the column, returns nothing (is(id, null)), no is_draft filter", async () => {
    failFirstOnDraft = true;
    const r = await list(api, { draft: 'only' });
    const sel2 = (r[1] && (r[1].ops.find(o => o[0] === 'select') || [])[1]) || '';
    return (r.length === 2 && !/is_draft/.test(sel2) && J(draftOps(r[1])) === J([['is', 'id', null]])) || J(r.map(x => x.ops));
  });
  await check("DB without is_draft: 'approved' → retried, no draft filter (every transaction is active)", async () => {
    failFirstOnDraft = true;
    const r = await list(api, { draft: 'approved' });
    return (r.length === 2 && draftOps(r[1]).length === 0) || J(r.map(x => x.ops));
  });

  const ADMIN = rd('assets/js/admin.js');
  await check("admin.js: default filter state has draft: ''", () => /transactions: \{[^}]*\bdraft: ''/.test(ADMIN) || 'missing default');
  await check('admin.js: renderTransactions passes draft: f.draft || null', () => /draft: f\.draft \|\| null/.test(ADMIN) || 'missing');
  await check("admin.js: the select (''/only/approved) sits in the legacy block next to the cancelled filter", () => {
    const i = ADMIN.indexOf("filterSelect('transactions', 'draft'"), c = ADMIN.indexOf("filterSelect('transactions', 'cancelled'");
    const line = ADMIN.slice(i, ADMIN.indexOf('\n', i));
    return (i > c && c > 0 && i - c < 600 && /\['', LX\.t\('f_draft_all'\)\], \['only', LX\.t\('f_draft_only'\)\], \['approved', LX\.t\('f_draft_approved'\)\]/.test(line)) || line;
  });
  await check('labels: f_draft_label / _all / _only / _approved in Arabic and English (tx-legacy.js)', () => {
    const s = rd('assets/js/ops/tx-legacy.js');
    const keys = ['f_draft_label', 'f_draft_all', 'f_draft_only', 'f_draft_approved'];
    const n = k => (s.match(new RegExp('\\b' + k + ': \'', 'g')) || []).length;
    return (keys.every(k => n(k) === 2) && /f_draft_only: 'المسودات فقط'/.test(s) && /f_draft_only: 'Drafts only'/.test(s)) || J(keys.map(n));
  });
  finish();
}
function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main();

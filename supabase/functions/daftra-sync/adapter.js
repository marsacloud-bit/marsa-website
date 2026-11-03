/*
  Marsa (مرسى) — G5 Daftra provider adapter interface (docs/online/G5_SPEC.md § Edge Function).
  STAGING ONLY. Plain classic script (no import / export, no require), ES2020, no dependencies:
  node tests require() it, Deno loads it by side-effect import and reads globalThis.MarsaDaftra.

  This file defines:
    - ADAPTER_METHODS / CAPABILITY_KEYS — the provider contract every adapter implements;
    - AdapterError — the only error type an adapter throws (kind + applied);
    - canonicalInvoice / contentHash — THE single definition of the invoice content hash
      (SQL never computes it; it only stores and compares the strings);
    - normalizeClient / normalizeName — shared normalisation for client snapshots and product names;
    - createRealAdapter — G5b: the REAL Daftra adapter (daftra-live.js createDaftraLive) only when the config carries
      http + apiKey + baseUrl AND an explicit factory (config.impl, passed by index.ts and the tests; the globalThis
      lookup is the Deno fallback only), else the documented stub: every method throws AdapterError('not_configured').
      This file never reads a key and never calls fetch (HTTP is injected by index.ts);
    - REAL_ENDPOINTS_TO_VERIFY — data only: the endpoints and what is verified on the account (2026-11-03) vs documented
      only. Nothing here is ever called.
*/
(function () {
  'use strict';

  const ADAPTER_METHODS = Object.freeze([
    'probe',
    'findClientByRef', 'findClientsByVat', 'getClient', 'createClient', 'updateClient',
    'findProductByCode', 'findProductsByName', 'createProduct',
    'findInvoiceByReference', 'getInvoice', 'createDraftInvoice', 'updateDraftInvoice', 'listPayments'
  ]);
  // methods that change the remote account (a lost response on these is "unknown", never "failed")
  const WRITE_METHODS = Object.freeze(['createClient', 'updateClient', 'createProduct', 'createDraftInvoice', 'updateDraftInvoice']);

  const CAPABILITY_KEYS = Object.freeze([
    'clients.search_by_ref', 'clients.read', 'clients.create', 'clients.update',
    'products.search_by_code', 'products.search_by_name', 'products.create',
    'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference', 'invoices.update_draft',
    'invoices.line_reference_field', 'invoices.version_token', 'invoices.multi_currency',
    'invoices.issue', 'payments.read', 'credit_notes.create'
  ]);
  // required by request_billing_push (G5 §2 push gate)
  const PUSH_REQUIRED_CAPABILITIES = Object.freeze([
    'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference', 'invoices.update_draft',
    'clients.search_by_ref', 'clients.create', 'products.search_by_code', 'products.create'
  ]);

  const ERROR_KINDS = Object.freeze(['timeout', 'network', 'http_5xx', 'rate_limited', 'validation', 'not_found', 'conflict', 'not_configured']);
  const APPLIED = Object.freeze(['no', 'unknown', 'yes']);

  class AdapterError extends Error {
    constructor(kind, message, opts) {
      const o = opts || {};
      super(message || kind);
      this.name = 'AdapterError';
      this.kind = ERROR_KINDS.includes(kind) ? kind : 'network';
      this.code = o.code ? String(o.code).slice(0, 60) : this.kind;
      this.http_status = Number.isInteger(o.http_status) ? o.http_status : null;
      this.applied = APPLIED.includes(o.applied) ? o.applied : 'no';
    }
    toJSON() { return { kind: this.kind, code: this.code, message: String(this.message).slice(0, 500), http_status: this.http_status }; }
  }
  const isAdapterError = e => !!e && (e instanceof AdapterError || e.name === 'AdapterError') && typeof e.kind === 'string';

  /* ---------------------------------------------------------------- formatting */
  // fixed-point decimal string, half away from zero, robust to binary noise (2.675 → "2.68")
  function fixed(v, dp) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const f = Math.pow(10, dp);
    const r = Math.round(Math.abs(n) * f + 1e-7) / f;
    const s = r.toFixed(dp);
    return (n < 0 && r !== 0) ? '-' + s : s;
  }
  const money = v => fixed(v, 2);

  // key-sorted JSON (stable across engines and key insertion order)
  function stableStringify(x) {
    if (x === null || x === undefined) return 'null';
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    if (typeof x === 'object') {
      return '{' + Object.keys(x).filter(k => x[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
    }
    if (typeof x === 'number' && !Number.isFinite(x)) return 'null';
    return JSON.stringify(x);
  }

  /* ---------------------------------------------------------------- canonical content */
  // {client_id, currency, lines:[{line_ref|null, product_id, description, quantity (3 dp), unit_price (2 dp), tax_rate (2 dp)}]}
  // owned lines sorted by line_ref, foreign lines (no ref) after, sorted by their JSON. Totals, dates, numbers,
  // ids and version tokens are excluded.
  function canonicalLine(l) {
    const ref = (l && typeof l.line_ref === 'string' && l.line_ref.trim()) ? l.line_ref.trim() : null;
    return {
      line_ref: ref,
      product_id: (l && l.product_id !== undefined && l.product_id !== null) ? String(l.product_id) : null,
      description: (l && l.description !== undefined && l.description !== null) ? String(l.description).replace(/\s+/g, ' ').trim() : null,
      quantity: fixed(l && l.quantity, 3),
      unit_price: fixed(l && l.unit_price, 2),
      tax_rate: fixed(l && (l.tax_rate !== undefined ? l.tax_rate : l.vat_rate), 2)
    };
  }
  function canonicalInvoice(inv) {
    const i = inv || {};
    const lines = (Array.isArray(i.lines) ? i.lines : []).map(canonicalLine);
    const owned = lines.filter(l => l.line_ref !== null).sort((a, b) => (a.line_ref < b.line_ref ? -1 : a.line_ref > b.line_ref ? 1 : 0));
    const foreign = lines.filter(l => l.line_ref === null).map(l => [stableStringify(l), l])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(x => x[1]);
    return {
      client_id: (i.client_id !== undefined && i.client_id !== null) ? String(i.client_id) : null,
      currency: i.currency ? String(i.currency).toUpperCase() : null,
      lines: owned.concat(foreign)
    };
  }

  function utf8(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    // eslint-disable-next-line no-undef
    return Uint8Array.from(Buffer.from(s, 'utf8'));
  }
  // lowercase hex SHA-256 of the key-sorted JSON (globalThis.crypto.subtle: Deno and node >= 19)
  async function contentHash(x) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('crypto.subtle unavailable');
    const buf = await subtle.digest('SHA-256', utf8(stableStringify(x)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const invoiceHash = inv => contentHash(canonicalInvoice(inv));

  /* ---------------------------------------------------------------- normalisation */
  const CLIENT_FIELDS = Object.freeze(['name', 'name_en', 'vat_number', 'cr_number', 'address_short', 'address', 'email', 'phone']);
  function clean(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
  }
  // the app.bill_client_snapshot shape, trimmed, empty → null
  function normalizeClient(c) {
    const o = {};
    for (const k of CLIENT_FIELDS) o[k] = clean(c ? c[k] : null);
    return o;
  }
  // product / client name comparison key: trim, collapse spaces, Arabic letter folding (like app.fin_norm_no letters),
  // diacritics + tatweel removed, Latin lower-cased
  function normalizeName(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }
  // normalised remote state: draft | issued | cancelled
  function remoteState(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'draft') return 'draft';
    if (s === 'cancelled' || s === 'canceled' || s === 'void') return 'cancelled';
    return 'issued';
  }

  /* ---------------------------------------------------------------- real adapter */
  // Data only — never called. G5b status per item: VERIFIED = answered 200 with the documented shape from Supabase staging
  // on 2026-11-03 (GET clients / products / invoices / taxes / site_info .json, header APIKEY, envelope
  // {result, code, data:[…], pagination:{…}}, site_info: data.Site); DOCUMENTED = official API reference
  // (docs.daftara.dev), not exercised by Marsa yet; UNVERIFIED = open (docs/online/G5B_DAFTRA_LIVE_AR.md).
  const REAL_ENDPOINTS_TO_VERIFY = Object.freeze([
    { capability: 'auth', method: '-', path: 'header APIKEY', note: 'VERIFIED: APIKEY header (no Authorization header with it); key in Edge secret MARSA_DAFTRA_API_KEY (fallback secret "Marsa"), read by index.ts only; 401 bad key, 403 key role refuses the entity' },
    { capability: 'auth', method: '-', path: 'https://<subdomain>.daftra.com/api2/…', note: 'VERIFIED base URL (MARSA_DAFTRA_SUBDOMAIN, ^[a-z0-9-]{1,63}$); rate limits UNVERIFIED (no 429 documented: backoff via retry)' },
    { capability: 'clients.search_by_ref', method: 'GET', path: '/api2/clients.json?keywords=<MRSC-…>', note: 'DOCUMENTED: keywords covers client number (fuzzy) → exact client_number match client-side; no client_number filter on api2' },
    { capability: 'clients.search_by_ref', method: 'GET', path: '/api2/clients.json?keywords=<vat>', note: 'UNVERIFIED: bn1 (VAT) not in the keywords field list → exact bn1 match, then a bounded full scan' },
    { capability: 'clients.read', method: 'GET', path: '/api2/clients/{id}.json', note: 'DOCUMENTED data.Client: business_name, bn1 (VAT), bn2 (CR), address1/2, email, phone1, client_number; no English-name field' },
    { capability: 'clients.create', method: 'POST', path: '/api2/clients.json', note: 'DOCUMENTED {"Client":{…}} → HTTP 202 {id, client_number}; 402 = clients plan limit' },
    { capability: 'clients.update', method: 'PUT', path: '/api2/clients/{id}.json', note: 'DOCUMENTED partial update (only sent fields change; business_name never emptied)' },
    { capability: 'products.search_by_code', method: 'GET', path: '/api2/products.json?product_code=<MRS-…>', note: 'DOCUMENTED exact filter (+ exact match client-side, keywords fallback)' },
    { capability: 'products.search_by_name', method: 'GET', path: '/api2/products.json?keywords=<…>', note: 'DOCUMENTED keywords (name, code, barcode, tags); normalized name match client-side' },
    { capability: 'products.create', method: 'POST', path: '/api2/products.json', note: 'DOCUMENTED {"Product":{…}} → 202 id; tax1/tax2 = Daftra TAX IDS (rate → id: one active exclusive tax of that value, or MARSA_DAFTRA_TAX_MAP)' },
    { capability: 'invoices.create_draft', method: 'POST', path: '/api2/invoices.json', note: 'DOCUMENTED Invoice.draft = 1 (+ is_offline = 1) → 202 id; Marsa NEVER calls update_draft/{id}/0 (issuing) — refused by the request guard' },
    { capability: 'invoices.search_by_reference', method: 'GET', path: '/api2/invoices.json?po_number=<operational_ref>', note: 'DOCUMENTED po_number filter (only when PO numbers are enabled: UNVERIFIED otherwise) → keywords → API-invoice scan (external_source=api, sort=id DESC; documented, untried); notes [MARSA-REF:] fallback; an unprovable "none" refuses (reference_lookup_incomplete)' },
    { capability: 'invoices.line_reference_field', method: '-', path: 'InvoiceItem.item', note: 'item = "<line text> [MRSL-…]" marker (item is DOCUMENTED on read; description is not); tax1/tax2 always sent (missing = inherits the product taxes)' },
    { capability: 'invoices.read', method: 'GET', path: '/api2/invoices/{id}.json', note: 'DOCUMENTED draft, no, summary_subtotal / _discount / _total, InvoiceItem[], InvoicePayment[], modified' },
    { capability: 'invoices.update_draft', method: 'PUT', path: '/api2/invoices/{id}.json', note: 'DOCUMENTED full payload: items REPLACED; always draft = 1; Marsa re-reads first (draft, modified, no payments)' },
    { capability: 'invoices.version_token', method: '-', path: 'Invoice.modified', note: 'DOCUMENTED "YYYY-MM-DD HH:MM:SS" (second granularity)' },
    { capability: 'invoices.multi_currency', method: '-', path: 'Invoice.currency_code', note: 'DOCUMENTED; defaults to the account currency' },
    { capability: 'payments.read', method: 'GET', path: '/api2/invoices/{id}.json InvoicePayment[]', note: 'DOCUMENTED (no invoice_id filter on invoice_payments.json); status 1 completed / 4 overpaid counted' }
  ]);

  // the documented stub: every method throws not_configured (no key read, no network)
  function stub() {
    const a = { mode: 'live' };
    for (const m of ADAPTER_METHODS) {
      a[m] = async function () {
        throw new AdapterError('not_configured', 'Daftra live adapter not configured (G5 staging: mock only)', { applied: 'no', code: 'not_configured' });
      };
    }
    return Object.freeze(a);
  }
  // G5b: the factory is passed explicitly (config.impl) so node tests reach the real path; the call-time globalThis lookup
  // is the Deno fallback only. Without http + apiKey + baseUrl + a factory → the not_configured stub.
  function createRealAdapter(config) {
    const c = config || {};
    const g = typeof globalThis === 'object' && globalThis.MarsaDaftra ? globalThis.MarsaDaftra.createDaftraLive : null;
    const impl = typeof c.impl === 'function' ? c.impl : (typeof g === 'function' ? g : null);
    if (!impl || typeof c.http !== 'function' || typeof c.apiKey !== 'string' || !c.apiKey || typeof c.baseUrl !== 'string' || !c.baseUrl) return stub();
    const cfg = Object.assign({}, c);
    delete cfg.impl;
    if (!cfg.deps) cfg.deps = API;
    return impl(cfg);
  }

  const API = {
    ADAPTER_METHODS, WRITE_METHODS, CAPABILITY_KEYS, PUSH_REQUIRED_CAPABILITIES, ERROR_KINDS, CLIENT_FIELDS,
    AdapterError, isAdapterError,
    canonicalInvoice, canonicalLine, contentHash, invoiceHash, stableStringify, fixed, money,
    normalizeClient, normalizeName, remoteState,
    createRealAdapter, REAL_ENDPOINTS_TO_VERIFY
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

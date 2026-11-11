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
    'findInvoiceByReference', 'getInvoice', 'createDraftInvoice', 'updateDraftInvoice', 'listPayments',
    // legacy port step 7 (docs/online/LEGACY_DAFTRA_AR.md «عقد المهام»): read-only lookups + the purchase draft
    'findProductsByCodeNorm', 'listProducts', 'listClients', 'findInvoicesByNumber', 'listInvoices',
    'searchSuppliers', 'findPurchaseByReference', 'getPurchase', 'createPurchaseDraft',
    // review: the account profile read again right before a write (GET site_info + taxes; read only)
    'getAccountProfile'
  ]);
  // methods that change the remote account (a lost response on these is "unknown", never "failed")
  const WRITE_METHODS = Object.freeze(['createClient', 'updateClient', 'createProduct', 'createDraftInvoice', 'updateDraftInvoice', 'createPurchaseDraft']);
  // step 7: the job kinds that may write to Daftra (the KSA account guard runs before each, in SQL at the claim and here)
  const WRITE_KINDS = Object.freeze(['invoice_push', 'purchase_push', 'client_ensure', 'client_push', 'item_ensure']);
  const READ_ONLY_KINDS = Object.freeze(['probe', 'invoice_pull', 'client_refresh', 'product_match', 'client_import', 'invoice_lookup', 'legacy_scan', 'supplier_search']);

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

  /* ---------------------------------------------------------------- step 7 helpers (legacy port) */
  // a Daftra product / client code compared without leading zeros (mirror of app.daftra_code_norm: 000186 = 186; Arabic
  // digits → western; letters upper-cased; blank → null)
  function toWestern(t) {
    return String(t).replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0));
  }
  // review: like the legacy normalizeDaftraProductCode_, a leading '#' and every whitespace are ignored (#000186 = 000 186 = 186)
  function codeNorm(v) {
    if (v === null || v === undefined) return null;
    const t = toWestern(String(v)).replace(/^\s*#/, '').replace(/\s+/g, '');
    if (t === '') return null;
    if (/^[0-9]+$/.test(t)) return t.replace(/^0+/, '') || '0';
    return t.toUpperCase();
  }
  // today in Asia/Riyadh as YYYY-MM-DD (never UTC, never the host zone): Intl, from an ISO clock value or a Date
  function riyadhDate(at) {
    const d = at instanceof Date ? at : new Date(at === undefined || at === null ? Date.now() : at);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = k => (parts.find(p => p.type === k) || {}).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  // a Daftra date (YYYY-MM-DD[ hh:mm:ss], YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY) → YYYY-MM-DD, or null (legacy normalizeDaftraInvoiceDate_)
  function normalizeDate(v) {
    const t = v === null || v === undefined ? '' : toWestern(String(v)).trim();
    let y, m, d, x;
    if ((x = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:$|[ T])/.exec(t))) { d = +x[1]; m = +x[2]; y = +x[3]; }
    else return null;
    const c = new Date(Date.UTC(y, m - 1, d));
    if (isNaN(c.getTime()) || c.getUTCFullYear() !== y || c.getUTCMonth() + 1 !== m || c.getUTCDate() !== d) return null;
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  // the KSA account guard on the probe's account profile (connection.account = app.daftra_account_check): SAR, Saudi Arabia,
  // an active 15 % VAT. Fail closed: no account / ok !== true → blocked; an enforced (live) account must also show the three
  // values; a mock account is blocked by any contradiction it reports. → null (may write) or the reason.
  const KSA_COUNTRIES = Object.freeze(['sa', 'sau', 'ksa', 'saudi arabia', 'kingdom of saudi arabia', 'السعودية', 'المملكة العربية السعودية']);
  function ksaBlock(account) {
    const a = account && typeof account === 'object' ? account : null;
    if (!a) return 'not_checked';
    if (a.ok !== true) return String(a.reason || 'not_ksa').slice(0, 40);
    const cur = a.currency === null || a.currency === undefined || a.currency === '' ? null : String(a.currency).trim().toUpperCase();
    const ctry = a.country === null || a.country === undefined || a.country === '' ? null : String(a.country).trim().toLowerCase();
    if (a.enforced === true) {
      if (cur !== 'SAR') return 'currency';
      if (!ctry || !KSA_COUNTRIES.includes(ctry)) return 'country';
      if (a.vat_15 !== true) return 'vat_rate';
      return null;
    }
    if (cur !== null && cur !== 'SAR') return 'currency';
    if (ctry !== null && !KSA_COUNTRIES.includes(ctry)) return 'country';
    if (a.vat_15 === false && Array.isArray(a.vat_rates) && a.vat_rates.length) return 'vat_rate';
    return null;
  }
  // review: the KSA check on an account profile read just now (getAccountProfile → {currency, country, taxes:[{value, active}]}),
  // the mirror of app.daftra_account_check for a live account: SAR + Saudi Arabia + an active 15 % tax (a tax without an
  // active flag counts as active, as in SQL). → null (may write) or the reason (currency | country | vat_rate | not_checked)
  function accountCheck(p) {
    const a = p && typeof p === 'object' ? p : null;
    if (!a) return 'not_checked';
    const cur = a.currency === null || a.currency === undefined ? '' : String(a.currency).trim().toUpperCase();
    const ctry = a.country === null || a.country === undefined ? '' : String(a.country).trim().toLowerCase();
    if (cur !== 'SAR') return 'currency';
    if (!KSA_COUNTRIES.includes(ctry)) return 'country';
    const ok = (Array.isArray(a.taxes) ? a.taxes : []).some(t => t && Number(t.value) === 15
      && !(t.active === false || t.active === 0 || t.active === '0' || t.is_active === false || t.is_active === 0 || t.is_active === '0'));
    return ok ? null : 'vat_rate';
  }
  // the write policy of the org (connection.policy). Fail closed: anything but an explicit true is false (HF5 / resolve only)
  function writePolicy(p) {
    const o = p && typeof p === 'object' ? p : {};
    return { allow_draft_update: o.allow_draft_update === true, allow_product_create: o.allow_product_create === true };
  }
  // the CustomModel body of a new draft (legacy buildDaftraCustomModelPayload_, proven on the account 2026-08-11):
  // {CustomModel: {<key>: [value]}, plus a date field as a single DD/MM/YYYY value with 'type_CustomModel.<key>': 'date'}
  const CUSTOM_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
  function customModel(payload, dateKeys) {
    const out = {};
    const dates = new Set(Array.isArray(dateKeys) ? dateKeys : []);
    const model = {};
    for (const k of Object.keys(payload || {})) {
      if (!CUSTOM_KEY_RE.test(k)) throw new AdapterError('validation', 'custom field key malformed', { applied: 'no', code: 'custom_field_key' });
      const v = payload[k] === null || payload[k] === undefined ? '' : String(payload[k]).replace(/\s+/g, ' ').trim().slice(0, 1000);
      model[k] = dates.has(k) ? v : [v];
    }
    if (!Object.keys(model).length) return out;
    out.CustomModel = model;
    for (const k of dates) if (Object.prototype.hasOwnProperty.call(model, k)) out['type_CustomModel.' + k] = 'date';
    return out;
  }
  // a container / chassis text of an invoice custom field → the compact identifiers (legacy parseDaftraContainerSetR12110HF2_):
  // ISO container numbers (4 letters + 7 digits) when present; else the parts split on ، , ; | newline, a Ro-Ro "chassis / plate"
  // part reduced to its chassis
  function containerSet(text) {
    const t = toWestern(String(text === null || text === undefined ? '' : text)).toUpperCase();
    const found = [];
    const re = /([A-Z]{4})\s*[-_/]?\s*(\d{7})/g;
    let m;
    while ((m = re.exec(t)) !== null) if (!found.includes(m[1] + m[2])) found.push(m[1] + m[2]);
    if (found.length) return found.slice(0, 300);
    // review: the legacy Ro-Ro value «Ro-Ro — شاسيه <chassis> — لوحة <plate>» → the chassis (buildDaftraInvoiceCustomFields_)
    const ch = /شاسيه\s*:?\s*([A-Z0-9][A-Z0-9 -]{2,40}?)(?=\s*(?:—|-\s|\/|،|,|;|\||لوحة|$))/.exec(t);
    if (ch) { const c = ch[1].replace(/[^A-Z0-9]/g, ''); if (c) return [c]; }
    for (const part of t.split(/[،,;|\n]+/)) {
      const head = part.split(/\s+\/\s+|\s+—\s+/)[0];
      const c = head.replace(/[^A-Z0-9]/g, '');
      if (c && !found.includes(c)) found.push(c);
    }
    return found.slice(0, 300);
  }
  // the worker error codes → the Arabic / English dictionary (status_labels domain 'daftra_error'); a code outside it falls
  // back to its kind (validation / timeout / network / http_5xx / rate_limited / not_found / not_configured), else 'worker'
  const DAFTRA_ERROR_CODES = Object.freeze(['account_not_ksa', 'custom_required', 'unmapped_product', 'product_not_found', 'client_not_linked',
    'client_suspended', 'client_inactive', 'draft_update_disabled', 'product_create_disabled', 'date_mismatch', 'readback_mismatch',
    'client_mismatch', 'empty_result', 'reference_lookup_incomplete', 'vat_scan_incomplete', 'auth_failed', 'forbidden', 'account_mismatch',
    'not_configured', 'validation', 'not_found', 'rate_limited', 'http_5xx', 'timeout', 'network', 'lease_lost', 'tax_map_invalid',
    'invoice_issued', 'supplier_not_linked', 'worker', 'setting_disabled', 'purchase_review']);
  const ERROR_ALIASES = Object.freeze({ draft_update_refused: 'draft_update_disabled', product_create_refused: 'product_create_disabled',
    tax_unmapped: 'tax_map_invalid', tax_ambiguous: 'tax_map_invalid', intent_issued: 'invoice_issued', not_draft: 'invoice_issued',
    redirect: 'not_configured', mock_disabled: 'not_configured', offline: 'network', bad_response: 'network', no_id: 'network',
    run_deadline: 'timeout', deadline: 'timeout', lease_expired: 'lease_lost', exception: 'worker', before_complete: 'worker', internal: 'worker',
    plan_limit: 'validation', item_unmapped: 'unmapped_product' });
  function errorCode(e) {
    const code = e && e.code ? String(e.code) : '';
    if (DAFTRA_ERROR_CODES.includes(code)) return code;
    if (ERROR_ALIASES[code]) return ERROR_ALIASES[code];
    if (/^config_/.test(code)) return 'not_configured';
    const kind = e && e.kind ? String(e.kind) : '';
    if (DAFTRA_ERROR_CODES.includes(kind)) return kind;
    if (kind === 'conflict') return 'validation';
    return 'worker';
  }
  // the field names an error message carries ("… (fields: a, b)") for the dictionary's {fields}
  function errorFields(e) {
    const m = /\(fields: ([^)]{0,400})\)/.exec(String(e && e.message || ''));
    return m ? m[1].split(',').map(x => x.trim()).filter(Boolean).slice(0, 20) : [];
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
    { capability: 'payments.read', method: 'GET', path: '/api2/invoices/{id}.json InvoicePayment[]', note: 'DOCUMENTED (no invoice_id filter on invoice_payments.json); status 1 completed / 4 overpaid counted' },
    // legacy port step 7 (the legacy Apps Script used these on the account; not exercised by Marsa yet)
    { capability: 'step7.custom_fields', method: 'POST', path: '/api2/invoices.json CustomModel', note: 'LEGACY-PROVEN 2026-08-11: {CustomModel:{<key>:[value]}}, a date field as one DD/MM/YYYY value + "type_CustomModel.<key>":"date", in the create POST only (never a PUT); keys are per-org configuration' },
    { capability: 'step7.products_by_code', method: 'GET', path: '/api2/products.json?product_code=<code>', note: 'codes compared without leading zeros (000186 = 186): exact filter, then keywords + client-side match; never POST products under resolve-only' },
    { capability: 'step7.suppliers', method: 'GET', path: '/api2/suppliers.json?name=<q>', note: 'LEGACY-USED: data[].Supplier {id, business_name, supplier_number, suspend}' },
    { capability: 'step7.purchase_draft', method: 'POST', path: '/api2/purchase_invoices.json?send=draft', note: 'LEGACY-USED: {PurchaseOrder:{supplier_id, currency_code, date}, PurchaseOrderItem:[{item, description, unit_price, quantity, tax1:0, tax2:0, product_id}]}; Marsa adds draft = 1 and a [MARSA-REF:MRSP-…] notes marker; UNVERIFIED: the marker searchable by keywords' },
    { capability: 'step7.clients_page', method: 'GET', path: '/api2/clients.json?page=&limit=', note: 'LEGACY-USED for the client import (read only; never a delete)' },
    { capability: 'step7.invoice_view', method: '-', path: 'https://<subdomain>.daftra.com/owner/invoices/view/<id>', note: 'UNVERIFIED path of the owner view link stored as billing_intents.daftra_url' },
    { capability: 'step7.account_recheck', method: 'GET', path: '/api2/site_info.json + /api2/taxes.json', note: 'review: re-read right before the first write of a live job (shapes as the probe); country_code / currency_code field names as the probe' },
    { capability: 'step7.redirect_after_write', method: 'POST', path: '/api2/*.json → 3xx', note: 'review: UNVERIFIED whether a 302 after a POST means the record was written; treated as possibly applied (unknown), reconciled by reference' }
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
    ADAPTER_METHODS, WRITE_METHODS, WRITE_KINDS, READ_ONLY_KINDS, CAPABILITY_KEYS, PUSH_REQUIRED_CAPABILITIES, ERROR_KINDS, CLIENT_FIELDS,
    AdapterError, isAdapterError,
    canonicalInvoice, canonicalLine, contentHash, invoiceHash, stableStringify, fixed, money,
    normalizeClient, normalizeName, remoteState,
    codeNorm, riyadhDate, normalizeDate, ksaBlock, accountCheck, KSA_COUNTRIES, writePolicy, customModel, containerSet, CUSTOM_KEY_RE,
    DAFTRA_ERROR_CODES, errorCode, errorFields,
    createRealAdapter, REAL_ENDPOINTS_TO_VERIFY
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

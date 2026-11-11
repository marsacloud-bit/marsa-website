/*
  Marsa (مرسى) — G5b LIVE Daftra adapter (Daftra API v2, https://<subdomain>.daftra.com/api2; docs/online/G5B_DAFTRA_LIVE_AR.md).
  Plain classic script (no import / export, no require), ES2020, no dependencies: node tests require() it, Deno loads it by
  side-effect import and reads globalThis.MarsaDaftra. The adapter API is passed explicitly as `deps` (adapter.js).

  createDaftraLive({ deps, http, apiKey, baseUrl, taxMap?, timeouts?, deadlineMs?, runDeadline?, limits?, clock?, allowLoopback?,
                     expectSubdomain? })
    http(req) → Promise<{status, headers, text}>    req = {method, url, headers, body (JSON string | undefined), timeoutMs}
      injected by index.ts (fetch + AbortSignal timeout) or by the tests (node http to a loopback fake server). A rejection
      with name 'TimeoutError' / 'AbortError' is a timeout; `phase: 'connect'` on the error means nothing was sent.
    apiKey   the Daftra API key: sent ONLY as the `APIKEY` header (never with an Authorization header, docs § auth), never
             logged, never returned, never part of an error message.
    baseUrl  'https://<subdomain>.daftra.com/api2' (subdomain ^[a-z0-9-]{1,63}$); 'http://127.0.0.1:<port>/api2' only with
             allowLoopback (tests).
    taxMap   optional {"<rate>": <Daftra tax id | 0>} (MARSA_DAFTRA_TAX_MAP). Without an entry a rate maps to the ONE active,
             price-exclusive Daftra tax with that value; 0 % maps to "no tax" (tax1 = 0). Anything else → validation, before
             any write.
    runDeadline  optional absolute epoch ms (index.ts: run start + 130 s, under the 150 s wall clock): no write starts unless
             its full timeout + 5 s fit before it, no read starts after it (timeout run_deadline, applied 'no').
  Implements every adapter.js ADAPTER_METHODS method with the shapes worker.js expects (the mock-adapter.js views).

  Binding rules implemented here:
    - drafts only: every invoice POST / PUT carries Invoice.draft = 1 (and is_offline = 1); guardDaftraRequest refuses any
      path with update_draft (the issuing endpoint), any path outside the allowlist, any invoice write whose draft !== 1 and
      any payment / deposit / reminder object. Marsa never issues, never sends to ETA / ZATCA, never e-mails, never pays;
    - references: client_number = our client ref, Product.product_code = our product code, Invoice.po_number = the
      operational_ref (+ a "[MARSA-REF:<ref>]" line in notes as fallback), InvoiceItem.item = "<line text> [MRSL-…]" (the
      line_ref marker rides in `item`, the documented read field; `description` is not in the read schema). Every lookup
      is an EXACT client-side match on those fields (filters are fuzzy). A reference lookup that cannot prove "none"
      (bounded scan incomplete, po_number not proven kept) refuses (reference_lookup_incomplete) instead of returning [];
      so does a VAT duplicate scan that hit its bound (vat_scan_incomplete);
    - updateDraftInvoice re-reads first and refuses (conflict) a non-draft, a moved version (Invoice.modified) or a draft
      with payments; the PUT sends the full item list (Daftra replaces items) keeping every other line verbatim, with
      tax1 / tax2 ALWAYS sent (0 for none: an item without them inherits the product's taxes). No network call sits
      between the re-read and the PUT (taxes are cached first); Daftra has no conditional PUT, so an issue by the
      accountant inside that gap is the one residual race (G5B_DAFTRA_LIVE_AR.md § 8);
    - errors: fixed messages + HTTP status only (validation_errors field NAMES only); a write whose response is lost
      (timeout, dropped connection, 5xx, unreadable 2xx) is applied:'unknown', never 'no';
    - probe() is READ-ONLY: GET site_info, taxes, one page of clients / products / invoices, one page of API invoices.

  Legacy port step 7 (docs/online/LEGACY_DAFTRA_AR.md «عقد المهام»):
    - config.policy = connection.policy (fail closed): unless allow_draft_update === true the guard refuses EVERY write on
      an existing invoice (PUT invoices/{id}: draft_update_refused) and updateDraftInvoice refuses before any request;
      unless allow_product_create === true it refuses POST products (product_create_refused);
    - a new draft carries the CustomModel custom fields (legacy: {CustomModel: {<key>: [value]}}, a date field as one
      DD/MM/YYYY value + 'type_CustomModel.<key>': 'date'), po_number, the Riyadh date; a line with item_name sends
      item = "<product name> [MRSL-…]" and description = the Daftra description (TAS only / empty clearance);
    - reads: invoices with their custom fields, client name and the https view URL; clients with suspend / secondary
      name / city; products by code without leading zeros (000186 = 186: product_code filter, then keywords + exact
      zero-insensitive match); paged listings; invoices by number; suppliers (GET suppliers.json?name=);
    - purchase drafts (legacy R12TransportPurchases): POST purchase_invoices.json?send=draft with PurchaseOrder.draft = 1,
      every item tax1 = tax2 = 0 (the guard refuses anything else), the "[MARSA-REF:MRSP-…]" marker in notes; looked up
      by that marker first (keywords, then a bounded id DESC scan). Never a PUT on a purchase invoice.
*/
(function () {
  'use strict';

  const DEFAULT_TIMEOUTS = Object.freeze({ read: 15000, write: 25000 });
  const DEFAULT_DEADLINE_MS = 45000;              // per adapter method; the worker's own timer stays above it (index.ts)
  const DEFAULT_LIMITS = Object.freeze({ searchPages: 2, searchLimit: 100, scanPages: 3, scanLimit: 500, invoiceScanPages: 2,
    invoiceScanLimit: 100, maxLines: 200 });
  const ID_RE = /^[0-9]{1,18}$/;
  const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,79}$/;
  const LINE_REF_RE = /^MRSL-[0-9A-F]{16}$/;
  const LINE_MARK_RE = /\[(MRSL-[0-9A-F]{16})\]/;
  const REF_MARK_RE = /\[MARSA-REF:([A-Za-z0-9][A-Za-z0-9_./-]{0,79})\]/;
  const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;
  const FIELD_RE = /^[A-Za-z0-9_.[\]-]{1,60}$/;

  /* ---------------------------------------------------------------- the request guard (hard rule, tested) */
  // the only (method, path) pairs this adapter may ever send; paths are relative to /api2, without query
  const DAFTRA_LIVE_ALLOWED = Object.freeze([
    ['GET', /^site_info\.json$/], ['GET', /^taxes\.json$/],
    ['GET', /^clients\.json$/], ['GET', /^clients\/[0-9]{1,18}\.json$/], ['POST', /^clients\.json$/], ['PUT', /^clients\/[0-9]{1,18}\.json$/],
    ['GET', /^products\.json$/], ['POST', /^products\.json$/],
    ['GET', /^invoices\.json$/], ['GET', /^invoices\/[0-9]{1,18}\.json$/], ['POST', /^invoices\.json$/], ['PUT', /^invoices\/[0-9]{1,18}\.json$/],
    // step 7: suppliers (read only) and purchase drafts (create + read; never a PUT)
    ['GET', /^suppliers\.json$/], ['GET', /^purchase_invoices\.json$/], ['GET', /^purchase_invoices\/[0-9]{1,18}\.json$/], ['POST', /^purchase_invoices\.json$/]
  ]);
  const PAYMENT_KEYS = ['Payment', 'InvoicePayment', 'Deposit', 'InvoiceReminder', 'PurchaseOrderPayment'];
  // null = allowed; else a fixed refusal code. Never issues (update_draft), never a non-draft invoice write, never a payment.
  // Step 7: policy = the org's write policy (fail closed: anything but an explicit true is refused) — no write on an existing
  // invoice (HF5) unless allow_draft_update, no product create unless allow_product_create; a purchase draft only with
  // ?send=draft, PurchaseOrder.draft = 1 and zero taxes on every item.
  function guardDaftraRequest(method, path, body, query, policy) {
    const p = String(path === undefined || path === null ? '' : path);
    const q = String(query === undefined || query === null ? '' : query);
    if (/update_draft/i.test(p) || /update_draft/i.test(q)) return 'issue_refused';
    if (/[?#\\]|\.\.|\/\//.test(p) || /^\//.test(p)) return 'path_refused';
    const m = String(method || '').toUpperCase();
    if (!DAFTRA_LIVE_ALLOWED.some(a => a[0] === m && a[1].test(p))) return 'path_refused';
    if (m !== 'GET' && /^invoices/.test(p)) {
      const inv = body && typeof body === 'object' ? body.Invoice : null;
      if (!inv || typeof inv !== 'object' || inv.draft !== 1) return 'draft_required';
      for (const k of ['Payment', 'InvoicePayment', 'Deposit', 'InvoiceReminder']) if (body[k] !== undefined) return 'payment_refused';
      for (const k of ['Payment', 'InvoicePayment', 'Deposit', 'InvoiceReminder']) if (inv[k] !== undefined) return 'payment_refused';
    }
    const pol = policy && typeof policy === 'object' ? policy : {};
    if (m !== 'GET' && /^invoices\/[0-9]/.test(p) && pol.allow_draft_update !== true) return 'draft_update_refused';
    if (m === 'POST' && /^products/.test(p) && pol.allow_product_create !== true) return 'product_create_refused';
    if (m !== 'GET' && /^purchase_invoices/.test(p)) {
      if (!/(^|[?&])send=draft(&|$)/.test(q)) return 'draft_required';
      const po = body && typeof body === 'object' ? body.PurchaseOrder : null;
      if (!po || typeof po !== 'object' || po.draft !== 1) return 'draft_required';
      for (const k of PAYMENT_KEYS) if (body[k] !== undefined || po[k] !== undefined) return 'payment_refused';
      const items = Array.isArray(body.PurchaseOrderItem) ? body.PurchaseOrderItem : null;
      if (!items || !items.length) return 'body_required';
      if (items.some(it => !it || typeof it !== 'object' || Number(it.tax1) !== 0 || Number(it.tax2) !== 0)) return 'tax_refused';
    }
    if (m !== 'GET' && (body === null || typeof body !== 'object')) return 'body_required';
    return null;
  }

  /* ---------------------------------------------------------------- small helpers */
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  function s(v) {
    if (v === null || v === undefined) return null;
    const t = String(v).replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
  }
  const idOf = v => (v === null || v === undefined || v === '' || String(v) === '0') ? null : String(v);
  const truthy01 = v => v === 1 || v === true || v === '1' || v === 'true';
  const unwrap = (x, k) => (x && typeof x === 'object' && x[k] && typeof x[k] === 'object') ? x[k] : (x || {});
  function parseJson(text) {
    if (typeof text !== 'string' || text === '') return null;
    try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
  }
  function qs(query) {
    const parts = [];
    for (const k of Object.keys(query || {})) {
      const v = query[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }
  // validation_errors → sorted field NAMES only (values may echo what was sent)
  function fieldNames(parsed) {
    const ve = parsed && parsed.validation_errors;
    let names = [];
    if (Array.isArray(ve)) names = ve.map(x => (x && typeof x === 'object') ? (x.field || x.name) : null);
    else if (ve && typeof ve === 'object') names = Object.keys(ve);
    return Array.from(new Set(names.filter(n => typeof n === 'string' && FIELD_RE.test(n)))).sort().slice(0, 10);
  }

  function configProblem(c) {
    if (!c.deps || typeof c.deps.AdapterError !== 'function' || typeof c.deps.fixed !== 'function') return 'deps';
    if (typeof c.http !== 'function') return 'http';
    if (typeof c.apiKey !== 'string' || c.apiKey.trim() === '' || /[\r\n]/.test(c.apiKey)) return 'api_key';
    const u = String(c.baseUrl || '');
    const live = /^https:\/\/([a-z0-9-]{1,63})\.daftra\.com\/api2$/.exec(u);
    const loop = c.allowLoopback === true && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/api2$/.test(u);
    if (!(live && SUBDOMAIN_RE.test(live[1])) && !loop) return 'base_url';
    return null;
  }

  /* ---------------------------------------------------------------- the adapter */
  function createDaftraLive(config) {
    const c = config || {};
    const bad = configProblem(c);
    if (bad) {
      // a broken configuration never reaches the network: every method throws not_configured (fixed message, no value)
      const E = (c.deps && typeof c.deps.AdapterError === 'function') ? c.deps.AdapterError : null;
      const methods = (c.deps && c.deps.ADAPTER_METHODS) || [];
      const a = { mode: 'live' };
      for (const m of methods) {
        a[m] = async function () {
          if (E) throw new E('not_configured', 'Daftra live adapter configuration invalid: ' + bad, { applied: 'no', code: 'config_' + bad });
          throw new Error('Daftra live adapter configuration invalid: ' + bad);
        };
      }
      return Object.freeze(a);
    }
    const A = c.deps;
    const { AdapterError, ADAPTER_METHODS, WRITE_METHODS, CAPABILITY_KEYS, normalizeName, fixed, money } = A;
    const http = c.http;
    const apiKey = c.apiKey;
    const baseUrl = String(c.baseUrl);
    // the account the probe must find (identity binding): the base URL's subdomain, or expectSubdomain (index.ts, tests)
    const hostSub = (/^https:\/\/([a-z0-9-]{1,63})\.daftra\.com\//.exec(baseUrl) || [])[1]
      || (typeof c.expectSubdomain === 'string' && SUBDOMAIN_RE.test(c.expectSubdomain) ? c.expectSubdomain : null);
    const T = Object.assign({}, DEFAULT_TIMEOUTS, c.timeouts || {});
    const L = Object.assign({}, DEFAULT_LIMITS, c.limits || {});
    const deadlineMs = Number(c.deadlineMs) > 0 ? Number(c.deadlineMs) : DEFAULT_DEADLINE_MS;
    const runDeadline = Number(c.runDeadline) > 0 ? Number(c.runDeadline) : null;
    const RUN_WRITE_MARGIN_MS = 5000;
    const clock = typeof c.clock === 'function' ? c.clock : () => new Date().toISOString();
    const now = typeof c.now === 'function' ? c.now : () => Date.now();
    const taxMap = {};
    for (const k of Object.keys(c.taxMap || {})) {
      const r = fixed(k, 2);
      const v = c.taxMap[k];
      if (r !== null && (v === 0 || v === '0' || ID_RE.test(String(v)))) taxMap[r] = String(v);
    }
    let taxCache = null;
    // step 7: the org's write policy (connection.policy), fail closed
    const policy = typeof A.writePolicy === 'function' ? A.writePolicy(c.policy) : { allow_draft_update: false, allow_product_create: false };
    const codeNorm = A.codeNorm;

    const err = (kind, message, code, o) => new AdapterError(kind, message, Object.assign({ applied: 'no', code }, o || {}));
    const invalid = (message, code) => err('validation', message, code || 'validation');

    /* ------------------------------------------------------------ transport */
    // one request; ctx = {deadline}. Returns the parsed JSON body (or {} for an empty 2xx).
    async function call(ctx, method, path, query, body) {
      const write = method !== 'GET';
      const qstr = qs(query);
      const refusal = guardDaftraRequest(method, path, body, qstr, policy);
      if (refusal) throw err('validation', 'request refused by the Marsa Daftra guard: ' + refusal, refusal);
      const want = write ? T.write : T.read;
      if (runDeadline !== null) {
        // the run's wall clock (index.ts): a write that could still be in flight when the function is killed is never started
        const r = runDeadline - now();
        if (r < (write ? T.write + RUN_WRITE_MARGIN_MS : 1000)) throw err('timeout', 'Daftra call not started: run deadline reached', 'run_deadline');
      }
      const left = Math.min(ctx.deadline, runDeadline === null ? Infinity : runDeadline) - now();
      if (left < (write ? want : 1000)) {
        // a write is never started without its full timeout ahead: nothing is sent, so applied stays 'no'
        throw err('timeout', 'Daftra call not started: method deadline reached', 'deadline');
      }
      const headers = { APIKEY: apiKey, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await http({ method, url: baseUrl + '/' + path + qstr, headers, body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: Math.max(1, Math.min(want, left)) });
      } catch (e) {
        const isTimeout = !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'timeout');
        const notSent = !!e && e.phase === 'connect';
        throw err(isTimeout ? 'timeout' : 'network', isTimeout ? 'Daftra did not answer in time' : 'Daftra connection failed',
          isTimeout ? 'timeout' : 'network', { applied: write && !notSent ? 'unknown' : 'no' });
      }
      const status = Number(res && res.status);
      const parsed = parseJson(res && res.text);
      if (status >= 200 && status < 300) {
        if (parsed === null && !(res && (res.text === '' || res.text === undefined))) {
          // the remote accepted something we cannot read: a write may have landed
          throw err('network', 'Daftra answered HTTP ' + status + ' with an unreadable body', 'bad_response',
            { http_status: status, applied: write ? 'unknown' : 'no' });
        }
        if (parsed && (parsed.result === 'failed' || (Number.isInteger(parsed.code) && parsed.code >= 400))) {
          throw statusError(Number.isInteger(parsed.code) ? parsed.code : 400, parsed, write);
        }
        return parsed || {};
      }
      throw statusError(status, parsed, write);
    }

    function statusError(status, parsed, write) {
      const o = { http_status: Number.isInteger(status) ? status : null };
      if (status === 400 || status === 422) {
        const f = fieldNames(parsed);
        return err('validation', 'Daftra rejected the request (HTTP ' + status + ')' + (f.length ? ': fields ' + f.join(', ') : ''), 'validation', o);
      }
      if (status === 401) return err('not_configured', 'Daftra refused the API key (HTTP 401)', 'auth_failed', o);
      if (status === 402) return err('validation', 'Daftra plan limit reached (HTTP 402)', 'plan_limit', o);
      if (status === 403) return err('not_configured', 'Daftra refused access for this API key (HTTP 403)', 'forbidden', o);
      if (status === 404) return err('not_found', 'Daftra item not found (HTTP 404)', 'not_found', o);
      if (status === 409) return err('conflict', 'Daftra reported a conflict (HTTP 409)', 'conflict', o);
      if (status === 429) return err('rate_limited', 'Daftra rate limit (HTTP 429)', 'rate_limited', o);
      if (status >= 500 && status <= 599) {
        return err('http_5xx', 'Daftra server error (HTTP ' + status + ')', 'http_5xx', Object.assign(o, { applied: write ? 'unknown' : 'no' }));
      }
      // review: a 3xx to a WRITE may follow a server error after the record was written (the account answers 302 →
      // /error500.php): possibly applied, reconciled by reference before any retry — never «definitely not applied»
      if (status >= 300 && status <= 399) return err('not_configured', 'Daftra redirected the request (HTTP ' + status + '): check the subdomain', 'redirect',
        Object.assign(o, { applied: write ? 'unknown' : 'no' }));
      return err('network', 'Daftra answered HTTP ' + (Number.isFinite(status) ? status : '?'), 'http_' + (Number.isFinite(status) ? status : 'none'),
        Object.assign(o, { applied: write ? 'unknown' : 'no' }));
    }

    const dataList = (parsed, key) => (Array.isArray(parsed && parsed.data) ? parsed.data : []).map(x => unwrap(x, key));
    function morePages(parsed, page) {
      const p = parsed && parsed.pagination;
      if (!p || typeof p !== 'object') return false;
      const count = Number(p.page_count);
      if (Number.isFinite(count)) return page < count;
      return !!p.next;
    }
    // GET a listing page by page (bounded); stop(list) may end it early
    async function listPages(ctx, path, query, key, maxPages, limit) {
      const out = [];
      let total = null;
      for (let page = 1; page <= maxPages; page++) {
        const parsed = await call(ctx, 'GET', path, Object.assign({}, query, { page, limit }));
        const items = dataList(parsed, key);
        if (parsed && parsed.pagination && Number.isFinite(Number(parsed.pagination.total_results))) total = Number(parsed.pagination.total_results);
        out.push(...items);
        if (!items.length || !morePages(parsed, page)) return { items: out, complete: true, total };
      }
      return { items: out, complete: false, total };
    }
    const byId = (a, b) => (Number(a.id) || 0) - (Number(b.id) || 0);
    // the bounded invoice scan: ALL invoices, newest id first. The documented external_source=api filter is not used:
    // on the real account (2026-11-03) it answers 302 → /error500.php; Marsa's invoices are told apart by the notes marker.
    const INVOICE_SCAN_QUERY = Object.freeze({ sort: 'id', direction: 'DESC' });
    const INVOICE_SCAN_QUERY_PAGE1 = limit => Object.assign({}, INVOICE_SCAN_QUERY, { page: 1, limit });
    // po_number is proven kept when one of Marsa's invoices (notes marker) carries the same value in po_number
    function poKeptOn(list) {
      return list.map(x => unwrap(x, 'Invoice')).some(h => {
        const m = REF_MARK_RE.exec(String(h.notes || ''));
        return !!m && s(h.po_number) === m[1];
      });
    }

    /* ------------------------------------------------------------ taxes */
    async function taxes(ctx) {
      if (taxCache) return taxCache;
      const parsed = await call(ctx, 'GET', 'taxes.json', {});
      taxCache = dataList(parsed, 'Tax').map(t => ({ id: idOf(t.id), name: s(t.name), value: fixed(t.value, 2),
        included: truthy01(t.included), active: !(t.is_active === 0 || t.is_active === '0' || t.is_active === false) }))
        .filter(t => t.id !== null);
      return taxCache;
    }
    // a rate → the Daftra tax id to send (0 = no tax). Throws validation before any write.
    async function taxIdFor(ctx, rate) {
      const r = fixed(rate, 2);
      if (r === null || Number(r) < 0 || Number(r) > 100) throw invalid('tax rate missing or out of range', 'tax_rate');
      if (has(taxMap, r)) {
        if (taxMap[r] === '0') return 0;
        const t = (await taxes(ctx)).find(x => x.id === taxMap[r]);
        if (!t || !t.active || t.included || t.value !== r) throw invalid('MARSA_DAFTRA_TAX_MAP entry for ' + r + ' is not an active exclusive tax of that value', 'tax_map_invalid');
        return Number(t.id);
      }
      if (Number(r) === 0) return 0;
      const hits = (await taxes(ctx)).filter(t => t.active && !t.included && t.value === r);
      if (hits.length === 1) return Number(hits[0].id);
      throw invalid((hits.length ? 'several' : 'no') + ' active exclusive Daftra taxes for rate ' + r, hits.length ? 'tax_ambiguous' : 'tax_unmapped');
    }
    // tax ids on a read → the rate (sum of tax1 + tax2); an unknown id or a price-INCLUSIVE tax → null (Marsa prices are
    // net and never use inclusive taxes: a switch to one must show as a difference, never read as the same rate)
    function rateOf(t1, t2) {
      let sum = 0;
      for (const id of [idOf(t1), idOf(t2)]) {
        if (id === null) continue;
        const t = (taxCache || []).find(x => x.id === id);
        if (!t || t.value === null || t.included) return null;
        sum += Number(t.value);
      }
      return fixed(sum, 2);
    }
    function taxMapView(list) {
      const out = {};
      const vals = Array.from(new Set(list.filter(t => t.active && !t.included && t.value !== null).map(t => t.value)));
      for (const v of vals.concat(Object.keys(taxMap))) {
        if (has(taxMap, v)) { out[v] = taxMap[v] === '0' ? 'none (map)' : taxMap[v] + ' (map)'; continue; }
        const hits = list.filter(t => t.active && !t.included && t.value === v);
        out[v] = hits.length === 1 ? hits[0].id : 'ambiguous:' + hits.map(h => h.id).join('|');
      }
      if (!has(out, '0.00')) out['0.00'] = 'none (tax1 = 0)';
      return out;
    }

    /* ------------------------------------------------------------ views (mock-adapter.js shapes) */
    function viewClient(raw) {
      const x = unwrap(raw, 'Client');
      // name_en has no documented Daftra client field: reported null (open issue in G5B_DAFTRA_LIVE_AR.md)
      // step 7: + suspended (Client.suspend), the secondary name, the city (client import, suspended-client refusal)
      return { id: idOf(x.id), ref: s(x.client_number), name: s(x.business_name) || s([x.first_name, x.last_name].filter(Boolean).join(' ')),
        name_en: null, vat_number: s(x.bn1), cr_number: s(x.bn2),
        address_short: s(x.address2), address: s(x.address1), email: s(x.email), phone: s(x.phone1) || s(x.phone2),
        secondary_name: s(x.secondary_name), city: s(x.city), suspended: truthy01(x.suspend) };
    }
    function viewSupplier(raw) {
      const x = unwrap(raw, 'Supplier');
      return { id: idOf(x.id), name: s(x.business_name) || s([x.first_name, x.last_name].filter(Boolean).join(' ')) || s(x.secondary_name),
        secondary_name: s(x.secondary_name), supplier_number: s(x.supplier_number), suspended: truthy01(x.suspend) };
    }
    // the custom fields of an invoice read (CustomModel / custom_data / InvoiceCustomField …, legacy collectDaftraCustomFieldPairs_)
    // → {<key>: text} (bounded; Daftra does not always return them: the lookups then read the invoice in full)
    const CF_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
    function customFieldsOf(d, inv) {
      const raw = [d && d.CustomModel, inv && inv.CustomModel, d && d.custom_model, d && d.custom_data, d && d.InvoiceCustomField,
        d && d.invoice_custom_fields, d && d.custom_fields, inv && inv.custom_fields].find(x => x && typeof x === 'object');
      const out = {};
      if (!raw) return out;
      const text = v => {
        if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object') ? text(x) : s(x)).filter(Boolean).join('، ');
        if (v && typeof v === 'object') return s(v.value !== undefined ? v.value : v.field_value !== undefined ? v.field_value : v.custom_value !== undefined ? v.custom_value : v.text);
        return s(v);
      };
      const put = (k, v) => {
        if (Object.keys(out).length >= 50 || typeof k !== 'string' || !CF_KEY_RE.test(k)) return;
        const t = text(v);
        if (t !== null && t !== '') out[k] = String(t).slice(0, 1000);
      };
      if (Array.isArray(raw)) {
        for (const it of raw) {
          if (!it || typeof it !== 'object') continue;
          const k = s(it.key || it.field_key || it.field || it.slug || it.name) || (it.field_id !== undefined ? 'field_' + it.field_id : null);
          put(k, it.value !== undefined ? it.value : it.field_value !== undefined ? it.field_value : it.custom_value !== undefined ? it.custom_value : it.text);
        }
      } else {
        for (const k of Object.keys(raw)) put(k, raw[k]);
      }
      return out;
    }
    // the Daftra owner view of an invoice / a purchase invoice (https on the account's own host only; never a URL Daftra returns)
    const viewUrl = (kind, id) => (hostSub && id && ID_RE.test(String(id))) ? 'https://' + hostSub + '.daftra.com/owner/' + kind + '/view/' + id : null;
    function viewProduct(raw) {
      const x = unwrap(raw, 'Product');
      return { id: idOf(x.id), code: s(x.product_code), name_ar: s(x.name), name_en: s(x.description), tax_code: null,
        vat_rate: taxCache ? rateOf(x.tax1, x.tax2) : null };
    }
    function lineRefOf(it) {
      for (const f of [it.item, it.description]) {
        const m = LINE_MARK_RE.exec(String(f === null || f === undefined ? '' : f));
        if (m) return m[1];
      }
      return null;
    }
    const stripMark = t => s(String(t === null || t === undefined ? '' : t).replace(LINE_MARK_RE, ' '));
    function referenceOf(inv) {
      const po = s(inv.po_number);
      if (po) return po;
      const m = REF_MARK_RE.exec(String(inv.notes || ''));
      return m ? m[1] : null;
    }
    function viewInvoice(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const inv = unwrap(d, 'Invoice');
      const items = Array.isArray(d.InvoiceItem) ? d.InvoiceItem : (Array.isArray(inv.InvoiceItem) ? inv.InvoiceItem : []);
      const draft = truthy01(inv.draft);
      const lines = items.map(r => unwrap(r, 'InvoiceItem')).map(it => {
        const ref = lineRefOf(it);
        const text = stripMark(it.item) !== null ? stripMark(it.item) : stripMark(it.description);
        return { id: idOf(it.id), line_ref: ref, product_id: idOf(it.product_id), description: text === null ? '' : text,
          quantity: fixed(it.quantity, 3), unit_price: fixed(it.unit_price, 2), tax_rate: rateOf(it.tax1, it.tax2) };
      });
      const sub = Number(inv.summary_subtotal), disc = Number(inv.summary_discount || 0), tot = Number(inv.summary_total);
      let totals;
      if (Number.isFinite(sub) && Number.isFinite(tot)) {
        totals = { net: money(sub - disc), vat: money(tot - sub + disc), total: money(tot) };
      } else {
        let net = 0, vat = 0;
        for (const l of lines) { const n = Number(money(Number(l.quantity) * Number(l.unit_price))); net += n; vat += Number(money(n * Number(l.tax_rate || 0) / 100)); }
        totals = { net: money(net), vat: money(vat), total: money(net + vat) };
      }
      const notes = s(String(inv.notes || '').replace(REF_MARK_RE, ' '));
      return { id: idOf(inv.id), reference: referenceOf(inv), client_id: idOf(inv.client_id), currency: s(inv.currency_code), date: s(inv.date),
        notes, status: draft ? 'draft' : 'issued', number: draft ? null : s(inv.no), version: s(inv.modified), lines, totals,
        client_name: s(inv.client_business_name) || s(d.Client && d.Client.business_name), custom_fields: customFieldsOf(d, inv),
        url: viewUrl('invoices', idOf(inv.id)) };
    }
    // a listing / lookup row: the view + the Daftra number of a draft too (lookups match the number the staff types)
    function viewHead(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const v = viewInvoice(d.Invoice ? d : { Invoice: d });
      v.number = s(unwrap(d, 'Invoice').no);
      delete v.lines;
      return v;
    }
    function viewPurchase(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const po = unwrap(d, 'PurchaseOrder');
      const m = REF_MARK_RE.exec(String(po.notes || ''));
      const draft = po.draft === undefined || po.draft === null ? true : (truthy01(po.draft) || String(po.draft).toLowerCase() === 'draft');
      // review: a non-zero tax Daftra stored (item tax1 / tax2 / summary_tax) — legacy re-read after the POST
      const its = (Array.isArray(d.PurchaseOrderItem) ? d.PurchaseOrderItem : (Array.isArray(po.PurchaseOrderItem) ? po.PurchaseOrderItem : [])).map(x => unwrap(x, 'PurchaseOrderItem'));
      const nz = v => v !== undefined && v !== null && v !== '' && Number(v) !== 0 && Number.isFinite(Number(v));
      const taxNonzero = its.some(x => nz(x.tax1) || nz(x.tax2) || nz(x.summary_tax1) || nz(x.summary_tax2)) || nz(po.summary_tax);
      return { id: idOf(po.id), reference: m ? m[1] : null, supplier_id: idOf(po.supplier_id), currency: s(po.currency_code), date: s(po.date),
        status: draft ? 'draft' : 'issued', number: s(po.no), url: viewUrl('purchase_invoices', idOf(po.id)), tax_nonzero: taxNonzero };
    }
    function paymentsOf(d) {
      const inv = unwrap(d, 'Invoice');
      const list = Array.isArray(d && d.InvoicePayment) ? d.InvoicePayment : (Array.isArray(inv.InvoicePayment) ? inv.InvoicePayment : []);
      return list.map(p => unwrap(p, 'InvoicePayment'));
    }

    /* ------------------------------------------------------------ payloads */
    const SNAP_TO_DAFTRA = [['name', 'business_name'], ['vat_number', 'bn1'], ['cr_number', 'bn2'], ['address', 'address1'],
      ['address_short', 'address2'], ['email', 'email'], ['phone', 'phone1']];
    function clientPayload(d, partial) {
      const o = {};
      for (const [k, f] of SNAP_TO_DAFTRA) {
        if (!has(d, k) || d[k] === undefined) continue;
        const v = s(d[k]);
        if (v === null) { if (partial && k !== 'name') o[f] = ''; continue; }   // business_name can never be emptied
        o[f] = v;
      }
      if (o.bn1) o.bn1_label = 'VAT';
      if (o.bn2) o.bn2_label = 'CR';
      return o;
    }
    function checkRef(ref, what) {
      if (typeof ref !== 'string' || !REF_RE.test(ref)) throw invalid(what + ' reference missing or malformed', what + '_ref');
      return ref;
    }
    function checkId(id, what) {
      const v = id === null || id === undefined ? '' : String(id);
      if (!ID_RE.test(v)) throw err('not_found', what + ' id is not a Daftra id', 'bad_id');
      return v;
    }
    async function itemOf(ctx, l) {
      if (!l || typeof l !== 'object') throw invalid('line must be an object', 'line');
      const q = Number(l.quantity), up = Number(l.unit_price);
      if (!(q > 0) || !(up >= 0) || !Number.isFinite(q + up)) throw invalid('line figures', 'line_figures');
      // step 7: a line naming its product (item_name) keeps the Daftra description apart (TAS only / empty for clearance)
      const named = l.item_name !== undefined && l.item_name !== null && s(l.item_name) !== null;
      const desc = String(s(named ? l.daftra_description : l.description) || '');
      const text = named ? String(s(l.item_name)) : desc;
      const out = { item: text.slice(0, 500), unit_price: Number(fixed(up, 2)), quantity: Number(fixed(q, 3)),
        tax1: await taxIdFor(ctx, l.tax_rate), tax2: 0, discount: 0, discount_type: 2 };
      if (named) out.description = desc.slice(0, 900);
      if (l.line_ref !== undefined && l.line_ref !== null) {
        if (!LINE_REF_RE.test(String(l.line_ref))) throw invalid('line_ref malformed', 'line_ref');
        // the marker rides in `item` (documented on read); the text is cut first so the marker itself is never truncated
        const mark = ' [' + l.line_ref + ']';
        out.item = (text.slice(0, 500 - mark.length) + mark).trim();
      }
      if (l.product_id !== undefined && l.product_id !== null) {
        if (!ID_RE.test(String(l.product_id))) throw invalid('product id is not a Daftra id', 'product_id');
        out.product_id = Number(l.product_id);
      }
      return out;
    }
    // the remote item as it may be re-sent verbatim (Daftra replaces the item list on PUT). tax1 / tax2 are ALWAYS sent:
    // an item without them inherits the product's taxes (docs), so a "no tax" line (null / '' / 0) is re-sent as 0
    const ITEM_KEEP = ['item', 'description', 'unit_price', 'quantity', 'product_id', 'discount', 'discount_type',
      'store_id', 'col_3', 'col_4', 'col_5', 'lot', 'expiry_date', 'serials'];
    function keepItem(raw) {
      const o = {};
      for (const k of ITEM_KEEP) if (raw[k] !== undefined && raw[k] !== null) o[k] = raw[k];
      for (const k of ['tax1', 'tax2']) o[k] = (raw[k] === undefined || raw[k] === null || raw[k] === '') ? 0 : raw[k];
      return o;
    }
    const HEAD_KEEP = ['client_id', 'date', 'issue_date', 'currency_code', 'po_number', 'notes', 'html_notes', 'terms', 'due_after',
      'invoice_layout_id', 'sales_person_id', 'cost_center_id', 'store_id', 'language_id'];

    /* ------------------------------------------------------------ the remote operations */
    const ops = {
      async probe(ctx) {
        const site = unwrap((await call(ctx, 'GET', 'site_info.json', {})).data, 'Site');
        // site_info may give the bare label or the full host ("<sub>.daftra.com"): compare the first label only
        const siteSub = s(site.subdomain).toLowerCase().replace(/^https?:\/\//, '').split(/[./]/)[0];
        if (hostSub && siteSub && siteSub !== hostSub) {
          throw err('not_configured', 'Daftra account does not match the configured subdomain', 'account_mismatch');
        }
        taxCache = null;
        const tx = await taxes(ctx);
        const cl = await call(ctx, 'GET', 'clients.json', { page: 1, limit: 1 });
        const pr = await call(ctx, 'GET', 'products.json', { page: 1, limit: 1 });
        const iv = await call(ctx, 'GET', 'invoices.json', { page: 1, limit: 5, recursive: 1 });
        // the API-created invoices, newest id first: what findInvoiceByReference's bounded scan walks
        const ia = await call(ctx, 'GET', 'invoices.json', INVOICE_SCAN_QUERY_PAGE1(20));
        const total = p => (p && p.pagination && Number.isFinite(Number(p.pagination.total_results))) ? Number(p.pagination.total_results) : null;
        const invs = Array.isArray(iv.data) ? iv.data : [];
        const heads = invs.map(x => unwrap(x, 'Invoice'));
        const items = [];
        for (const x of invs) for (const it of (Array.isArray(x && x.InvoiceItem) ? x.InvoiceItem : [])) items.push(unwrap(it, 'InvoiceItem'));
        const poSeen = heads.some(h => has(h, 'po_number'));
        const poKept = poKeptOn(dataList(ia, 'Invoice'));
        const itemSeen = items.some(it => has(it, 'item'));
        const modSeen = heads.some(h => has(h, 'modified'));
        const curs = Array.from(new Set(heads.map(h => s(h.currency_code)).filter(Boolean))).sort();
        const nCl = total(cl), nPr = total(pr), nIv = total(iv), nApi = total(ia);
        const scanCap = L.scanPages * L.scanLimit;
        const invScanCap = L.invoiceScanPages * L.invoiceScanLimit;
        // "none found" is provable only by a complete scan of the API invoices, or by a po_number filter on an account that
        // is seen to keep po_number on Marsa's invoices (findInvoiceByReference refuses otherwise)
        const refOk = poKept || (nApi !== null && nApi <= invScanCap);
        // the [MRSL-…] marker rides in InvoiceItem.item: unsupported when sample items exist and none carries `item`
        const lineOk = !items.length || itemSeen;
        const ev = {
          'clients.search_by_ref': 'GET clients.json?keywords (documented to cover client number) + exact client_number match; listing 200' + (nCl !== null ? ' (' + nCl + ' clients)' : ''),
          'clients.read': 'GET clients/{id}.json (documented); clients listing 200 on this account',
          'clients.create': 'POST clients.json {Client} → 202 id (documented); client_number = Marsa ref; not exercised by the read-only probe',
          'clients.update': 'PUT clients/{id}.json partial update (documented); not exercised by the read-only probe',
          'products.search_by_code': 'GET products.json?product_code exact filter (documented) + exact match; listing 200' + (nPr !== null ? ' (' + nPr + ' products)' : ''),
          'products.search_by_name': 'GET products.json?keywords (name / code / barcode) + exact normalized name match',
          'products.create': 'POST products.json {Product} → 202 id (documented); tax1 = mapped tax id; not exercised by the read-only probe',
          'invoices.create_draft': 'POST invoices.json with Invoice.draft = 1, is_offline = 1 (documented); never issued by Marsa',
          'invoices.read': 'GET invoices/{id}.json (documented); invoices listing 200' + (nIv !== null ? ' (' + nIv + ' invoices)' : ''),
          'invoices.search_by_reference': 'po_number filter + keywords + API-invoice scan (id DESC, ' + invScanCap + ' max), exact match on po_number / notes [MARSA-REF:]; '
            + (poKept ? 'po_number kept on Marsa\'s invoices' : 'po_number ' + (poSeen ? 'field present but not proven kept' : 'NOT seen in the sample'))
            + '; ' + (nApi === null ? 'API invoice count unknown' : nApi + ' API invoices') + (refOk ? '' : ': lookup cannot prove "none" (enable PO numbers)'),
          'invoices.update_draft': 'PUT invoices/{id}.json full payload (items replaced) with draft = 1, after a re-read (draft + modified check)',
          'invoices.line_reference_field': 'InvoiceItem.item = "<text> [MRSL-…]" marker; item '
            + (itemSeen ? 'returned on this account\'s items' : (items.length ? 'NOT seen on sample items: line markers cannot be read back' : 'not observable (no sample items): verify on the first draft')),
          'invoices.version_token': 'Invoice.modified ' + (modSeen ? 'returned on this account' : '(documented; not seen in the sample)'),
          'invoices.multi_currency': 'Invoice.currency_code (documented); account currency ' + (s(site.currency_code) || s(site.currency) || 'unknown')
            + (curs.length ? '; sample currencies ' + curs.join(',') : ''),
          'invoices.issue': 'not used by policy: Marsa never issues (update_draft refused by the request guard)',
          'payments.read': 'InvoicePayment[] in GET invoices/{id}.json (documented); read only',
          'credit_notes.create': 'not implemented and never used'
        };
        const off = ['invoices.issue', 'credit_notes.create'].concat(refOk ? [] : ['invoices.search_by_reference'], lineOk ? [] : ['invoices.line_reference_field']);
        const capabilities = {};
        for (const k of CAPABILITY_KEYS) capabilities[k] = { supported: !off.includes(k), evidence: String(ev[k] || 'not reported').slice(0, 300) };
        const account = {
          name: s(site.business_name) || s(site.site_name) || s(site.name), currency: s(site.currency_code) || s(site.currency),
          country: s(site.country_code) || s(site.country), subdomain: siteSub || hostSub, date_format: s(site.date_format),
          counts: { clients: nCl, products: nPr, invoices: nIv, api_invoices: nApi, vat_scan_cap: scanCap, invoice_scan_cap: invScanCap },
          taxes: tx.slice(0, 50).map(t => ({ id: t.id, name: t.name, value: t.value, included: t.included, active: t.active })),
          tax_map: taxMapView(tx)
        };
        return { capabilities, account };
      },

      async findClientByRef(ctx, ref) {
        checkRef(ref, 'client');
        const r = await listPages(ctx, 'clients.json', { keywords: ref }, 'Client', L.searchPages, L.searchLimit);
        const hits = r.items.filter(x => s(x.client_number) === ref).sort(byId);
        return hits.length ? viewClient(hits[0]) : null;
      },
      async findClientsByVat(ctx, vat) {
        const v = s(vat) ? s(vat).replace(/\s+/g, '') : null;
        if (!v) return [];
        const same = x => s(x.bn1) !== null && s(x.bn1).replace(/\s+/g, '') === v;
        // keywords are not documented to cover bn1: an exact keyword hit is used, else a bounded full scan
        const r = await listPages(ctx, 'clients.json', { keywords: v }, 'Client', L.searchPages, L.searchLimit);
        let hits = r.items.filter(same);
        if (!hits.length) {
          const scan = await listPages(ctx, 'clients.json', {}, 'Client', L.scanPages, L.scanLimit);
          hits = scan.items.filter(same);
          // a bounded scan that found nothing proves nothing: refuse (staff may choose force_create) rather than duplicate
          if (!hits.length && !scan.complete) throw err('validation', 'Daftra VAT duplicate scan incomplete (account too large)', 'vat_scan_incomplete');
        }
        const seen = new Set();
        return hits.sort(byId).filter(x => !seen.has(String(x.id)) && seen.add(String(x.id))).slice(0, 10).map(viewClient);
      },
      async getClient(ctx, id) {
        const parsed = await call(ctx, 'GET', 'clients/' + checkId(id, 'client') + '.json', {});
        const v = viewClient(parsed.data);
        if (!v.id) throw err('not_found', 'Daftra item not found', 'not_found');
        return v;
      },
      async createClient(ctx, d) {
        if (!d || !s(d.name)) throw invalid('client name required', 'client_name');
        const ref = checkRef(d.ref, 'client');
        const body = { Client: Object.assign(clientPayload(d, false), { client_number: ref, type: 3 }) };
        const parsed = await call(ctx, 'POST', 'clients.json', undefined, body);
        const id = idOf(parsed.id);
        if (!id) throw err('network', 'Daftra create answered without an id', 'no_id', { applied: 'unknown' });
        // a client Daftra renumbered (auto client numbers) EXISTS: it is returned so the worker links it by external_id (the
        // next push skips a linked client), never thrown away to be created again; ref_kept tells the caller
        const kept = parsed.client_number === undefined || s(parsed.client_number) === ref;
        return Object.assign({ id, ref: kept ? ref : (s(parsed.client_number) || ref), ref_kept: kept }, A.normalizeClient(d), { name_en: null });
      },
      async updateClient(ctx, id, d) {
        const cid = checkId(id, 'client');
        const body = { Client: clientPayload(d || {}, true) };
        await call(ctx, 'PUT', 'clients/' + cid + '.json', undefined, body);
        return { id: cid, updated: true };
      },

      async findProductByCode(ctx, code) {
        checkRef(code, 'product');
        let r = await listPages(ctx, 'products.json', { product_code: code }, 'Product', 1, 20);
        let hits = r.items.filter(x => s(x.product_code) === code);
        if (!hits.length) {
          r = await listPages(ctx, 'products.json', { keywords: code }, 'Product', L.searchPages, L.searchLimit);
          hits = r.items.filter(x => s(x.product_code) === code);
        }
        return hits.length ? viewProduct(hits.sort(byId)[0]) : null;
      },
      async findProductsByName(ctx, name) {
        const n = normalizeName(name);
        if (!n) return [];
        const same = x => normalizeName(x.name) === n || (s(x.description) && normalizeName(x.description) === n);
        // keywords are a plain contains-match: the full name first, then its two longest words (spelling variants such as
        // أ / ا or ة / ه in the other words still match after normalisation)
        const words = String(name).replace(/[\u064B-\u0652\u0640]/g, '').split(/\s+/).filter(w => w.length >= 3).sort((a, b) => b.length - a.length).slice(0, 2);
        const seen = new Map();
        for (const kw of [String(s(name))].concat(words)) {
          const r = await listPages(ctx, 'products.json', { keywords: kw }, 'Product', L.searchPages, L.searchLimit);
          for (const x of r.items.filter(same)) seen.set(String(x.id), x);
          if (seen.size) break;
        }
        return Array.from(seen.values()).sort(byId).slice(0, 10).map(viewProduct);
      },
      async createProduct(ctx, d) {
        if (!policy.allow_product_create) throw invalid('Marsa never creates Daftra products (allow_product_create is off)', 'product_create_refused');
        if (!d || !s(d.code) || !s(d.name_ar)) throw invalid('product code and name required', 'product');
        const code = checkRef(d.code, 'product');
        const rate = d.vat_rate === undefined || d.vat_rate === null ? 0 : d.vat_rate;
        const tax1 = await taxIdFor(ctx, rate);
        const body = { Product: { name: String(s(d.name_ar)).slice(0, 255), product_code: code, type: 2, tax1, tax2: 0 } };
        if (s(d.name_en)) body.Product.description = String(s(d.name_en)).slice(0, 500);
        const parsed = await call(ctx, 'POST', 'products.json', undefined, body);
        const id = idOf(parsed.id);
        if (!id) throw err('network', 'Daftra create answered without an id', 'no_id', { applied: 'unknown' });
        return { id, code, name_ar: s(d.name_ar), name_en: s(d.name_en), tax_code: d.tax_code || null, vat_rate: fixed(rate, 2) };
      },

      async findInvoiceByReference(ctx, ref) {
        checkRef(ref, 'invoice');
        await taxes(ctx);
        const exact = list => list.map(x => unwrap(x, 'Invoice')).filter(h => referenceOf(h) === ref);
        // 1. po_number filter (needs PO numbers enabled), 2. keywords ("order number"), 3. the API-created invoices, newest
        // id first (a lost create is the newest; the default list order is invoice DATE, which a back-dated draft escapes)
        const tries = [
          [{ po_number: ref }, L.searchPages, 50],
          [{ keywords: ref }, L.searchPages, 50],
          [INVOICE_SCAN_QUERY, L.invoiceScanPages, L.invoiceScanLimit]
        ];
        const results = [];
        for (const [q, pages, limit] of tries) {
          const r = await listPages(ctx, 'invoices.json', q, 'Invoice', pages, limit);
          results.push(r);
          const hits = exact(r.items);
          if (hits.length) {
            const seen = new Set();
            return hits.sort(byId).filter(h => !seen.has(String(h.id)) && seen.add(String(h.id))).map(h => viewInvoice({ Invoice: h }));
          }
        }
        // no hit. "None" is proven only by a complete scan, or by a po_number filter that was applied (every row it returned
        // carries the ref) on an account seen to keep po_number on Marsa's invoices. Otherwise refuse: a [] here makes the
        // worker create a second draft after a lost create.
        const [r1, , r3] = results;
        if (r3.complete) return [];
        const filtered = r1.complete && r1.items.map(x => unwrap(x, 'Invoice')).every(h => String(s(h.po_number) || '').toLowerCase().includes(ref.toLowerCase()));
        if (filtered && poKeptOn(r3.items)) return [];
        throw err('validation', 'Daftra reference lookup incomplete (cannot prove no invoice carries the reference)', 'reference_lookup_incomplete');
      },
      async getInvoice(ctx, id) {
        const iid = checkId(id, 'invoice');
        await taxes(ctx);
        const parsed = await call(ctx, 'GET', 'invoices/' + iid + '.json', {});
        const v = viewInvoice(parsed.data);
        if (!v.id) throw err('not_found', 'Daftra item not found', 'not_found');
        return v;
      },
      async createDraftInvoice(ctx, d) {
        if (!d || typeof d !== 'object') throw invalid('invoice payload required', 'invoice');
        const ref = checkRef(d.reference, 'invoice');
        if (!ID_RE.test(String(d.client_id === null || d.client_id === undefined ? '' : d.client_id))) throw invalid('client id is not a Daftra id', 'client_id');
        const cur = String(d.currency || '');
        if (!/^[A-Z]{3}$/.test(cur)) throw invalid('currency', 'currency');
        const date = d.date ? String(d.date).slice(0, 10) : String(clock()).slice(0, 10);
        if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) throw invalid('date', 'date');
        const lines = Array.isArray(d.lines) ? d.lines : null;
        if (!lines || lines.length > L.maxLines) throw invalid('lines', 'lines');
        const items = [];
        for (const l of lines) items.push(await itemOf(ctx, l));
        const notes = (s(d.notes) ? String(d.notes).trim().slice(0, 2000) + '\n' : '') + '[MARSA-REF:' + ref + ']';
        const body = { Invoice: { client_id: Number(d.client_id), date, currency_code: cur, draft: 1, is_offline: 1, po_number: ref, notes },
          InvoiceItem: items };
        // step 7: the custom fields ride in the same POST (CustomModel; never a later PUT)
        if (d.custom_fields && typeof d.custom_fields === 'object' && Object.keys(d.custom_fields).length) {
          Object.assign(body, A.customModel(d.custom_fields, d.custom_date_keys));
        }
        const parsed = await call(ctx, 'POST', 'invoices.json', undefined, body);
        const id = idOf(parsed.id);
        if (!id) throw err('network', 'Daftra create answered without an id', 'no_id', { applied: 'unknown' });
        return { id, reference: ref, client_id: String(d.client_id), currency: cur, status: 'draft', url: viewUrl('invoices', id) };
      },
      async updateDraftInvoice(ctx, id, d) {
        // step 7 (HF5): refused before any request unless the owner allowed draft updates
        if (!policy.allow_draft_update) throw invalid('editing an existing Daftra draft is not allowed (HF5)', 'draft_update_refused');
        const iid = checkId(id, 'invoice');
        await taxes(ctx);
        // re-read first: never a PUT on a non-draft, a moved version or a draft that already carries payments
        const parsed = await call(ctx, 'GET', 'invoices/' + iid + '.json', {});
        const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
        const inv = unwrap(data, 'Invoice');
        if (!idOf(inv.id)) throw err('not_found', 'Daftra item not found', 'not_found');
        if (!truthy01(inv.draft)) throw err('conflict', 'Daftra invoice is not a draft', 'not_draft', { http_status: 409 });
        const ev = d && d.expected_version;
        if (ev !== undefined && ev !== null && String(ev) !== String(s(inv.modified))) {
          throw err('conflict', 'Daftra invoice changed since it was read (modified)', 'version', { http_status: 409 });
        }
        if (paymentsOf(data).length) throw err('conflict', 'Daftra draft carries payments: not updated by Marsa', 'has_payments', { http_status: 409 });
        const rawItems = (Array.isArray(data.InvoiceItem) ? data.InvoiceItem : (Array.isArray(inv.InvoiceItem) ? inv.InvoiceItem : [])).map(r => unwrap(r, 'InvoiceItem'));
        const rawById = new Map(rawItems.filter(r => idOf(r.id)).map(r => [String(r.id), r]));
        const lines = d && Array.isArray(d.lines) ? d.lines : null;
        if (!lines || lines.length > L.maxLines) throw invalid('lines', 'lines');
        const items = [];
        for (const l of lines) {
          const rid = l && l.id !== undefined && l.id !== null ? String(l.id) : null;
          if (rid !== null && !rawById.has(rid)) throw err('conflict', 'Daftra invoice lines changed since they were read', 'version', { http_status: 409 });
          if (rid !== null && !(l.line_ref)) { items.push(keepItem(rawById.get(rid))); continue; }       // foreign line: verbatim
          if (rid !== null) {
            // an owned line Marsa does not change is re-sent verbatim too (its exact tax ids, discount, columns)
            const was = viewInvoice({ Invoice: { id: iid }, InvoiceItem: [rawById.get(rid)] }).lines[0];
            if (A.stableStringify(A.canonicalLine(was)) === A.stableStringify(A.canonicalLine(l))) { items.push(keepItem(rawById.get(rid))); continue; }
          }
          const fresh = await itemOf(ctx, l);
          items.push(rid !== null ? Object.assign(keepItem(rawById.get(rid)), fresh) : fresh);
        }
        const head = {};
        for (const k of HEAD_KEEP) if (inv[k] !== undefined && inv[k] !== null && inv[k] !== '') head[k] = inv[k];
        if (Number(inv.discount) > 0) head.discount = inv.discount;
        else if (Number(inv.discount_amount) > 0) head.discount_amount = inv.discount_amount;
        const body = { Invoice: Object.assign(head, { draft: 1, is_offline: 1 }), InvoiceItem: items };
        await call(ctx, 'PUT', 'invoices/' + iid + '.json', undefined, body);
        return { id: iid, updated: true, lines: items.length };
      },
      async listPayments(ctx, invoiceId) {
        const iid = checkId(invoiceId, 'invoice');
        const parsed = await call(ctx, 'GET', 'invoices/' + iid + '.json', {});
        const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
        if (!idOf(unwrap(data, 'Invoice').id)) throw err('not_found', 'Daftra item not found', 'not_found');
        // completed (1) and overpaid (4) payments only; pending / failed / draft payments are not money received
        return paymentsOf(data).filter(p => p.status === undefined || p.status === null || ['1', '4'].includes(String(p.status)))
          .map(p => ({ amount: money(p.amount), date: s(p.date) ? String(s(p.date)).slice(0, 10) : null }));
      },

      /* ---------------------------------------------------------- step 7: read-only lookups */
      // products whose code equals the given one without leading zeros (000186 = 186): the exact product_code filter (as
      // given, then without zeros), then keywords (contains) + the zero-insensitive comparison client-side
      async findProductsByCodeNorm(ctx, code) {
        const raw = s(code);
        if (raw === null || !REF_RE.test(raw)) throw invalid('product code missing or malformed', 'product_ref');
        const n = codeNorm(raw);
        const seen = new Map();
        const tries = [[{ product_code: raw }, 1, 20]];
        if (n !== raw) tries.push([{ product_code: n }, 1, 20]);
        tries.push([{ keywords: n }, L.searchPages, L.searchLimit]);
        for (const [q, pages, limit] of tries) {
          const r = await listPages(ctx, 'products.json', q, 'Product', pages, limit);
          for (const x of r.items) if (idOf(x.id) && codeNorm(x.product_code) === n) seen.set(String(x.id), x);
          if (seen.size) break;
        }
        return Array.from(seen.values()).sort(byId).slice(0, 10).map(viewProduct);
      },
      async listProducts(ctx, q) {
        const page = Math.max(1, Number(q && q.page) || 1), limit = Math.max(1, Math.min(500, Number(q && q.limit) || 100));
        const parsed = await call(ctx, 'GET', 'products.json', { page, limit });
        const total = parsed && parsed.pagination && Number.isFinite(Number(parsed.pagination.total_results)) ? Number(parsed.pagination.total_results) : null;
        return { items: dataList(parsed, 'Product').filter(x => idOf(x.id)).map(viewProduct), more: morePages(parsed, page), total };
      },
      async listClients(ctx, q) {
        const page = Math.max(1, Number(q && q.page) || 1), limit = Math.max(1, Math.min(500, Number(q && q.limit) || 100));
        const parsed = await call(ctx, 'GET', 'clients.json', { page, limit });
        const total = parsed && parsed.pagination && Number.isFinite(Number(parsed.pagination.total_results)) ? Number(parsed.pagination.total_results) : null;
        return { items: dataList(parsed, 'Client').filter(x => idOf(x.id)).map(viewClient), more: morePages(parsed, page), total };
      },
      // invoices (and drafts) by their Daftra number: keywords, then a bounded scan newest id first; exact (letters / digits)
      async findInvoicesByNumber(ctx, no) {
        const key = String(s(no) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!key || key.length > 60) throw invalid('invoice number missing or malformed', 'number');
        await taxes(ctx);
        const exact = list => list.map(x => unwrap(x, 'Invoice')).filter(h => String(s(h.no) || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === key);
        for (const [q, pages, limit] of [[{ keywords: String(s(no)) }, L.searchPages, 50], [INVOICE_SCAN_QUERY, L.invoiceScanPages, L.invoiceScanLimit]]) {
          const r = await listPages(ctx, 'invoices.json', q, 'Invoice', pages, limit);
          const hits = exact(r.items);
          if (hits.length) {
            const seen = new Set();
            return hits.sort(byId).filter(h => !seen.has(String(h.id)) && seen.add(String(h.id))).slice(0, 10).map(h => viewHead({ Invoice: h }));
          }
        }
        return [];
      },
      // one page of invoices, id ascending (stable cursor for the legacy scan) or descending; optional client / keywords filter
      async listInvoices(ctx, q) {
        const o = q || {};
        await taxes(ctx);
        const page = Math.max(1, Number(o.page) || 1), limit = Math.max(1, Math.min(500, Number(o.limit) || 100));
        const query = { sort: 'id', direction: String(o.direction || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC', page, limit };
        if (o.client_id !== undefined && o.client_id !== null) query.client_id = checkId(o.client_id, 'client');
        if (s(o.keywords)) query.keywords = String(s(o.keywords)).slice(0, 80);
        const parsed = await call(ctx, 'GET', 'invoices.json', query);
        const list = (Array.isArray(parsed && parsed.data) ? parsed.data : []).filter(x => idOf(unwrap(x, 'Invoice').id));
        let items = list.map(viewHead);
        if (query.client_id) items = items.filter(h => h.client_id === query.client_id);     // the filter is not trusted blindly
        return { items, more: morePages(parsed, page), total: parsed && parsed.pagination ? Number(parsed.pagination.total_results) || null : null };
      },
      async searchSuppliers(ctx, q) {
        const text = s(q);
        if (!text || text.length > 120) throw invalid('supplier name missing or too long', 'q');
        let r = await listPages(ctx, 'suppliers.json', { name: text }, 'Supplier', 1, 50);
        if (!r.items.length) r = await listPages(ctx, 'suppliers.json', { keywords: text }, 'Supplier', 1, 50);
        return r.items.map(viewSupplier).filter(x => x.id).slice(0, 50);
      },
      // a purchase draft by Marsa's reference marker in notes: keywords, then a bounded scan newest id first → {hits, complete}
      async findPurchaseByReference(ctx, ref) {
        checkRef(ref, 'purchase');
        const exact = list => list.map(x => unwrap(x, 'PurchaseOrder')).filter(h => { const m = REF_MARK_RE.exec(String(h.notes || '')); return !!m && m[1] === ref; });
        let complete = false;
        for (const [q, pages, limit] of [[{ keywords: ref }, L.searchPages, 50], [INVOICE_SCAN_QUERY, L.invoiceScanPages, L.invoiceScanLimit]]) {
          const r = await listPages(ctx, 'purchase_invoices.json', q, 'PurchaseOrder', pages, limit);
          const hits = exact(r.items);
          if (hits.length) {
            const seen = new Set();
            return { hits: hits.sort(byId).filter(h => !seen.has(String(h.id)) && seen.add(String(h.id))).map(h => viewPurchase({ PurchaseOrder: h })), complete: true };
          }
          if (q === INVOICE_SCAN_QUERY) complete = r.complete;
        }
        return { hits: [], complete };
      },
      // review: the account profile right before a write (read only): GET site_info + taxes (fresh, not the cached list)
      async getAccountProfile(ctx) {
        const site = unwrap((await call(ctx, 'GET', 'site_info.json', {})).data, 'Site');
        taxCache = null;
        const tx = await taxes(ctx);
        return { currency: s(site.currency_code) || s(site.currency), country: s(site.country_code) || s(site.country),
          taxes: tx.map(t => ({ value: t.value, active: t.active })) };
      },
      async getPurchase(ctx, id) {
        const pid = checkId(id, 'purchase');
        const parsed = await call(ctx, 'GET', 'purchase_invoices/' + pid + '.json', {});
        const v = viewPurchase(parsed.data);
        if (!v.id) throw err('not_found', 'Daftra item not found', 'not_found');
        return v;
      },

      /* ---------------------------------------------------------- step 7: the purchase draft (write) */
      async createPurchaseDraft(ctx, d) {
        if (!d || typeof d !== 'object') throw invalid('purchase payload required', 'purchase');
        const ref = checkRef(d.reference, 'purchase');
        if (!ID_RE.test(String(d.supplier_id === null || d.supplier_id === undefined ? '' : d.supplier_id))) throw invalid('supplier id is not a Daftra id', 'supplier_id');
        const cur = String(d.currency || 'SAR');
        if (!/^[A-Z]{3}$/.test(cur)) throw invalid('currency', 'currency');
        const date = d.date ? String(d.date).slice(0, 10) : String(clock()).slice(0, 10);
        if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) throw invalid('date', 'date');
        const lines = Array.isArray(d.lines) ? d.lines : [];
        if (!lines.length || lines.length > L.maxLines) throw invalid('lines', 'lines');
        const items = lines.map(l => {
          const q = Number(l.quantity), up = Number(l.unit_price);
          if (!(q > 0) || !(up > 0) || !Number.isFinite(q + up)) throw invalid('line figures', 'line_figures');
          if (Number(l.tax_rate || 0) !== 0) throw invalid('purchase drafts carry no tax', 'tax_refused');
          if (!ID_RE.test(String(l.product_id === null || l.product_id === undefined ? '' : l.product_id))) throw invalid('product id is not a Daftra id', 'product_id');
          const o = { item: String(s(l.item_name) || s(l.description) || '').slice(0, 250), description: String(s(l.description) || '').slice(0, 900),
            unit_price: Number(fixed(up, 2)), quantity: Number(fixed(q, 3)), tax1: 0, tax2: 0, product_id: Number(l.product_id) };
          return o;
        });
        const body = { PurchaseOrder: { supplier_id: Number(d.supplier_id), currency_code: cur, date, draft: 1, notes: '[MARSA-REF:' + ref + ']' },
          PurchaseOrderItem: items };
        const parsed = await call(ctx, 'POST', 'purchase_invoices.json', { send: 'draft' }, body);
        const id = idOf(parsed.id !== undefined ? parsed.id : (parsed.data && parsed.data.id));
        if (!id) throw err('network', 'Daftra create answered without an id', 'no_id', { applied: 'unknown' });
        return { id, reference: ref, supplier_id: String(d.supplier_id), currency: cur, status: 'draft', url: viewUrl('purchase_invoices', id) };
      }
    };

    /* ------------------------------------------------------------ the adapter */
    const adapter = { mode: 'live' };
    for (const m of ADAPTER_METHODS) {
      adapter[m] = async function (...args) {
        const ctx = { deadline: now() + deadlineMs };
        try {
          return await ops[m](ctx, ...args);
        } catch (e) {
          if (e && e.name === 'AdapterError') throw e;
          // an unexpected local error: a write may already have been sent
          throw err('network', 'Daftra adapter internal error', 'internal', { applied: WRITE_METHODS.includes(m) ? 'unknown' : 'no' });
        }
      };
    }
    return Object.freeze(adapter);
  }

  const API = { createDaftraLive, guardDaftraRequest, DAFTRA_LIVE_ALLOWED };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

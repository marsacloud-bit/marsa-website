/*
  Marsa (مرسى) — G5b fake Daftra API v2 server (docs/online/G5B_DAFTRA_LIVE_AR.md § Tests). LOCAL TESTS ONLY.
  Plain HTTP on 127.0.0.1, an in-memory account emulating the DOCUMENTED endpoints and shapes (api-research): envelope
  {result, code, data:[{Client|Product|Invoice|Tax: {...}}], pagination:{prev, next, page, page_count, total_results}},
  single reads {data:{Client}} / {data:{Invoice, InvoiceItem[], InvoicePayment[]}}, site_info {data:{Site}},
  creates → HTTP 202 {result, code:202, id}, edits → 200, errors {result:'failed', code, message, validation_errors}.
  No real Daftra, no real key, no network beyond the loopback interface.

  createFakeDaftraServer({apiKey, site, taxes, clientLimit, keywordsCoverBn1, poNumbers, renumberClients, forbidden,
                          echoItemDescription, inheritProductTax, clock}) → server
    inheritProductTax  an item sent WITHOUT tax1 / tax2 takes the product's taxes (the documented Daftra rule; null / 0 = none)
    invoices.json      default order: invoice date DESC (documented); sort=id + direction honoured; external_source → 302 /error500.php like the real account; was: keeps
                       the invoices created through POST (control.addInvoice adds UI ones)
    summary            inclusive taxes are carved out of the line amount (not added on top)
    server.start() → {port, baseUrl};  server.stop()
    server.state                          {clients, products, invoices:[{Invoice, items, payments}], taxes, seq}
    server.requests                       every request: {method, path, query, apikey (bool: header present + equal),
                                          authorization (bool), body (parsed JSON), status}
    server.faults                         [{method, path (RegExp), status?, body?, delayMs?, drop:'before'|'after', apply?}]
                                          first match is consumed: drop 'before' = socket destroyed, nothing applied;
                                          'after' = applied, then destroyed (a lost response); status + apply:true = applied
                                          then that status is answered; delayMs = answered late
    server.control                        accountant actions: issue(id), editItem(id, idx, patch), addItem(id, item),
                                          addPayment(id, amount, status), deleteInvoice(id), touch(id)
    server.reset()                        clears requests and faults (the account stays)
  createNodeHttp({onRequest}) → http(req) for daftra-live.js (node http to 127.0.0.1) + .stats {requests}
    rejects with name 'TimeoutError' on its own timer, `phase: 'connect'` when the connection never opened.
*/
'use strict';
const http = require('http');

const ok = data => ({ result: 'successful', code: 200, data });
const failed = (code, message, extra) => Object.assign({ result: 'failed', code, message }, extra || {});
const lc = v => String(v === null || v === undefined ? '' : v).toLowerCase();

function createFakeDaftraServer(opts) {
  const o = opts || {};
  const apiKey = o.apiKey || 'test-key-not-real';
  const cfg = {
    keywordsCoverBn1: !!o.keywordsCoverBn1,
    poNumbers: o.poNumbers !== false,                 // false: the PO-number setting is off (po_number dropped, filter ignored)
    renumberClients: !!o.renumberClients,             // true: client_number from the request is ignored
    clientLimit: Number.isInteger(o.clientLimit) ? o.clientLimit : null,
    forbidden: o.forbidden || [],                     // entity names refused with 403 (API key role)
    echoItemDescription: o.echoItemDescription !== false,
    inheritProductTax: !!o.inheritProductTax
  };
  let tick = 0;
  const stamp = () => {
    const d = new Date(Date.parse('2026-11-03T09:00:00Z') + (++tick) * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  const S = {
    site: Object.assign({ business_name: 'Fake Logistics Co', subdomain: 'marsa-fake', currency_code: 'SAR', country_code: 'SA', date_format: 'd/m/Y' }, o.site || {}),
    taxes: (o.taxes || [
      { id: 1, name: 'VAT', value: 15, included: 0, is_active: 1 },
      { id: 2, name: 'VAT inclusive', value: 15, included: 1, is_active: 1 },
      { id: 3, name: 'Old VAT', value: 5, included: 0, is_active: 0 }
    ]).map(t => Object.assign({ description: null, site_id: 1, created: '2018-05-10 00:42:00', modified: '2018-05-10 00:42:00' }, t)),
    clients: [], products: [], invoices: [], seq: { client: 100, product: 200, invoice: 2400, item: 9000, payment: 500, number: 0, client_number: 714 }
  };
  const requests = [];
  const faults = [];

  /* ------------------------------------------------------------ helpers */
  function page(list, query, key) {
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 20));
    const p = Math.max(1, Number(query.page) || 1);
    const count = Math.max(1, Math.ceil(list.length / limit));
    const items = list.slice((p - 1) * limit, p * limit).map(x => (typeof key === 'function' ? key(x) : { [key]: x }));
    return Object.assign(ok(items), { pagination: { prev: p > 1 ? '/api2/?page=' + (p - 1) : null, next: p < count ? '/api2/?page=' + (p + 1) : null,
      page: p, page_count: count, total_results: list.length } });
  }
  const findInv = id => S.invoices.find(x => String(x.Invoice.id) === String(id));
  function invoiceOut(x) {
    return { Invoice: Object.assign({}, x.Invoice), InvoiceItem: x.items.map(i => Object.assign({}, i)), InvoicePayment: x.payments.map(p => Object.assign({}, p)) };
  }
  function summary(x) {
    let sub = 0, tax = 0;
    for (const it of x.items) {
      const n = Math.round(Number(it.quantity) * Number(it.unit_price) * 100) / 100;
      let lineSub = n;
      for (const t of [it.tax1, it.tax2]) {
        const tx = S.taxes.find(z => String(z.id) === String(t));
        if (!tx) continue;
        if (Number(tx.included) === 1) {
          // price-inclusive: the tax is inside the amount
          const inc = Math.round(n * Number(tx.value) / (100 + Number(tx.value)) * 100) / 100;
          tax += inc; lineSub -= inc;
        } else tax += Math.round(n * Number(tx.value)) / 100;
      }
      sub += lineSub;
    }
    const paid = x.payments.filter(p => [1, 4].includes(Number(p.status))).reduce((a, p) => a + Number(p.amount), 0);
    Object.assign(x.Invoice, { summary_subtotal: sub.toFixed(2), summary_discount: '0.00', summary_total: (sub + tax).toFixed(2),
      summary_paid: paid.toFixed(2), summary_unpaid: (sub + tax - paid).toFixed(2) });
  }
  function storeItems(x, items) {
    x.items = (items || []).map(it => {
      const prod = it.product_id === undefined || it.product_id === null ? null : S.products.find(p => String(p.id) === String(it.product_id));
      const inh = k => (cfg.inheritProductTax && it[k] === undefined && prod && prod[k] !== undefined) ? prod[k] : (it[k] === undefined ? null : it[k]);
      const o2 = { id: String(++S.seq.item), invoice_id: x.Invoice.id, item: it.item === undefined ? null : it.item,
        unit_price: String(it.unit_price), quantity: String(it.quantity), tax1: inh('tax1'), tax2: inh('tax2'),
        product_id: it.product_id === undefined ? null : String(it.product_id), discount: it.discount || 0, discount_type: it.discount_type || 2,
        created: stamp(), modified: stamp() };
      if (cfg.echoItemDescription) o2.description = it.description === undefined ? null : it.description;
      for (const k of ['col_3', 'col_4', 'col_5', 'store_id']) if (it[k] !== undefined) o2[k] = it[k];
      return o2;
    });
  }
  const isDraft = v => v === 1 || v === true || v === '1';

  /* ------------------------------------------------------------ routes */
  function route(method, path, query, body) {
    const entity = (/^(clients|products|invoices|taxes|site_info)/.exec(path) || [])[1];
    const ent = { clients: 'client', products: 'product', invoices: 'invoice', taxes: 'tax', site_info: 'site' }[entity];
    if (ent && cfg.forbidden.includes(ent)) return [403, failed(403, 'Forbidden')];
    let m;
    if (method === 'GET' && path === 'site_info.json') return [200, ok({ Site: Object.assign({}, S.site) })];
    if (method === 'GET' && path === 'taxes.json') return [200, ok(S.taxes.slice().sort((a, b) => b.is_active - a.is_active).map(t => ({ Tax: Object.assign({}, t) })))];

    /* clients */
    if (method === 'GET' && path === 'clients.json') {
      let list = S.clients.slice();
      if (query.keywords) {
        const k = lc(query.keywords);
        const fields = ['id', 'client_number', 'business_name', 'first_name', 'last_name', 'email', 'phone1', 'phone2'].concat(cfg.keywordsCoverBn1 ? ['bn1'] : []);
        list = list.filter(c => fields.some(f => lc(c[f]).includes(k)));
      }
      return [200, page(list, query, 'Client')];
    }
    if (method === 'GET' && (m = /^clients\/(\d+)\.json$/.exec(path))) {
      const c = S.clients.find(x => String(x.id) === m[1]);
      return c ? [200, ok({ Client: Object.assign({}, c) })] : [404, failed(404, 'Item not found')];
    }
    if (method === 'POST' && path === 'clients.json') {
      const c = body && body.Client;
      if (!c || !c.business_name) return [400, failed(400, 'Bad Request', { validation_errors: { business_name: 'Business name is required "' + JSON.stringify(c || {}).slice(0, 40) + '"' } })];
      if (cfg.clientLimit !== null && S.clients.length >= cfg.clientLimit) return [402, { message: 'You have reached your clients limit.' }];
      const id = String(++S.seq.client);
      const num = (!cfg.renumberClients && c.client_number) ? String(c.client_number) : String(++S.seq.client_number).padStart(7, '0');
      S.clients.push(Object.assign({ id, staff_id: 1, is_offline: c.email ? 0 : 1, created: stamp(), modified: stamp() }, c, { id, client_number: num }));
      return [202, { result: 'successful', code: 202, id, client_number: num }];
    }
    if (method === 'PUT' && (m = /^clients\/(\d+)\.json$/.exec(path))) {
      const c = S.clients.find(x => String(x.id) === m[1]);
      if (!c) return [404, failed(404, 'Item not found')];
      const d = (body && body.Client) || {};
      if (d.business_name !== undefined && !d.business_name) return [400, failed(400, 'Bad Request', { validation_errors: { business_name: 'required' } })];
      Object.assign(c, d, { modified: stamp() });
      return [200, { code: 200, result: 'successful' }];
    }

    /* products */
    if (method === 'GET' && path === 'products.json') {
      let list = S.products.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (query.product_code) list = list.filter(p => String(p.product_code) === String(query.product_code));
      if (query.keywords) { const k = lc(query.keywords); list = list.filter(p => ['name', 'product_code', 'barcode', 'tags'].some(f => lc(p[f]).includes(k))); }
      return [200, page(list, query, 'Product')];
    }
    if (method === 'POST' && path === 'products.json') {
      const p = body && body.Product;
      if (!p || !p.name) return [400, failed(400, 'Bad Request', { validation_errors: { name: 'required' } })];
      const id = String(++S.seq.product);
      S.products.push(Object.assign({ id, type: 1, status: 0, created: stamp(), modified: stamp() }, p, { id }));
      return [202, { result: 'successful', code: 202, id }];
    }

    /* invoices */
    if (method === 'GET' && path === 'invoices.json') {
      let list = S.invoices.slice().sort((a, b) => (a.Invoice.date < b.Invoice.date ? 1 : a.Invoice.date > b.Invoice.date ? -1 : Number(b.Invoice.id) - Number(a.Invoice.id)));
      if (query.sort === 'id') list.sort((a, b) => (Number(a.Invoice.id) - Number(b.Invoice.id)) * (String(query.direction).toUpperCase() === 'DESC' ? -1 : 1));
      // the real account (2026-11-03) answers the documented external_source filter with 302 → /error500.php
      if (query.external_source) return [302, ''];
      if (query.po_number && cfg.poNumbers) list = list.filter(x => String(x.Invoice.po_number || '') === String(query.po_number));
      if (query.keywords) {
        const k = lc(query.keywords);
        list = list.filter(x => [x.Invoice.no, cfg.poNumbers ? x.Invoice.po_number : null, x.Invoice.client_business_name].some(v => lc(v).includes(k)));
      }
      if (String(query.draft) === '1') list = list.filter(x => isDraft(x.Invoice.draft));
      const rec = String(query.recursive) === '1';
      return [200, page(list, query, x => rec ? { Invoice: Object.assign({}, x.Invoice), InvoiceItem: x.items.map(i => Object.assign({}, i)) } : { Invoice: Object.assign({}, x.Invoice) })];
    }
    if (method === 'GET' && (m = /^invoices\/(\d+)\.json$/.exec(path))) {
      const x = findInv(m[1]);
      return x ? [200, ok(invoiceOut(x))] : [404, failed(404, 'Item not found')];
    }
    if (method === 'GET' && (m = /^invoices\/update_draft\/(\d+)\/0\.json$/.exec(path))) {
      // the ISSUING endpoint: present so the tests can prove Marsa never calls it
      const x = findInv(m[1]);
      if (!x) return [404, failed(404, 'Item not found')];
      x.Invoice.draft = 0; x.Invoice.no = String(++S.seq.number).padStart(6, '0'); x.Invoice.modified = stamp();
      return [200, { code: 200, result: 'successful' }];
    }
    if (method === 'POST' && path === 'invoices.json') {
      const inv = body && body.Invoice;
      if (!inv || !inv.client_id) return [400, failed(400, 'Bad Request', { validation_errors: { 'Invoice.client_id': 'required' } })];
      const cl = S.clients.find(c => String(c.id) === String(inv.client_id));
      if (!cl) return [400, failed(400, 'Bad Request', { validation_errors: { 'Invoice.client_id': 'invalid' } })];
      if (inv.date && !/^\d{4}-\d{2}-\d{2}$/.test(inv.date)) return [400, failed(400, 'Bad Request', { validation_errors: { 'Invoice.date': 'format' } })];
      const id = String(++S.seq.invoice);
      const draft = isDraft(inv.draft) ? 1 : 0;
      const head = Object.assign({}, inv, { id, client_id: String(inv.client_id), draft, type: 0, currency_code: inv.currency_code || S.site.currency_code,
        date: inv.date || '2026-11-03', no: draft ? 'D-' + id : String(++S.seq.number).padStart(6, '0'), payment_status: draft ? -1 : 0,
        client_business_name: cl.business_name, external_source: 'api', created: stamp(), modified: stamp() });
      if (!cfg.poNumbers) delete head.po_number;
      const x = { Invoice: head, items: [], payments: [] };
      storeItems(x, body.InvoiceItem);
      summary(x);
      S.invoices.push(x);
      return [202, { code: 202, result: 'successful', id }];
    }
    if (method === 'PUT' && (m = /^invoices\/(\d+)\.json$/.exec(path))) {
      const x = findInv(m[1]);
      if (!x) return [404, failed(404, 'Item not found')];
      if (!isDraft(x.Invoice.draft)) return [400, failed(400, 'Bad Request', { validation_errors: { Invoice: 'issued invoice in a closed period' } })];
      const inv = (body && body.Invoice) || {};
      const head = Object.assign({}, inv);
      if (!cfg.poNumbers) delete head.po_number;
      Object.assign(x.Invoice, head, { id: x.Invoice.id, draft: isDraft(inv.draft) ? 1 : 0, modified: stamp() });
      if (!isDraft(inv.draft)) { x.Invoice.no = String(++S.seq.number).padStart(6, '0'); x.Invoice.payment_status = 0; }
      storeItems(x, body && body.InvoiceItem);
      summary(x);
      return [200, { code: 200, result: 'successful' }];
    }
    return [404, failed(404, 'Item not found')];
  }

  /* ------------------------------------------------------------ server */
  let server = null;
  let port = null;
  function handle(req, res) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const path = u.pathname.replace(/^\/api2\//, '');
      const query = {};
      for (const [k, v] of u.searchParams) query[k] = v;
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) { try { body = JSON.parse(text); } catch (_) { body = { __unparsed: true }; } }
      const entry = { method: req.method, path, query, apikey: req.headers.apikey === apiKey, apikeyHeader: req.headers.apikey !== undefined,
        authorization: req.headers.authorization !== undefined, body, status: null };
      requests.push(entry);
      const send = (status, obj) => {
        entry.status = status;
        const out = obj === undefined ? '' : (typeof obj === 'string' ? obj : JSON.stringify(obj));
        const hdr = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(out) };
        if (status === 302) hdr.location = '/error500.php';
        res.writeHead(status, hdr);
        res.end(out);
      };
      if (!u.pathname.startsWith('/api2/')) return send(404, failed(404, 'Item not found'));
      if (req.headers.apikey !== apiKey) return send(401, failed(401, 'Unauthorized'));
      const fi = faults.findIndex(f => (!f.method || f.method === req.method) && (!f.path || f.path.test(path)));
      const f = fi >= 0 ? faults.splice(fi, 1)[0] : null;
      const run = () => {
        if (f && f.drop === 'before') { entry.status = 'dropped'; req.socket.destroy(); return; }
        if (f && f.status && !f.apply) return send(f.status, f.body === undefined ? failed(f.status, 'fault') : f.body);
        let r;
        try { r = route(req.method, path, query, body); } catch (e) { r = [500, failed(500, 'Internal Server Error')]; }
        if (f && f.drop === 'after') { entry.status = 'dropped_after'; entry.applied = r[0] < 300; req.socket.destroy(); return; }
        if (f && f.status && f.apply) return send(f.status, f.body === undefined ? failed(f.status, 'fault') : f.body);
        if (f && f.rawText !== undefined) return send(r[0], f.rawText);
        send(r[0], r[1]);
      };
      if (f && f.delayMs) setTimeout(run, f.delayMs); else run();
    });
  }

  const control = {
    issue(id) { const x = findInv(id); x.Invoice.draft = 0; x.Invoice.no = String(++S.seq.number).padStart(6, '0'); x.Invoice.payment_status = 0; x.Invoice.modified = stamp(); },
    editItem(id, idx, patch) { const x = findInv(id); Object.assign(x.items[idx], patch, { modified: stamp() }); x.Invoice.modified = stamp(); summary(x); },
    addItem(id, item) {
      const x = findInv(id);
      x.items.push(Object.assign({ id: String(++S.seq.item), invoice_id: x.Invoice.id, item: 'manual', description: 'accountant line', unit_price: '10', quantity: '1',
        tax1: null, tax2: null, product_id: null, discount: 0, discount_type: 2, col_3: 'kept' }, item || {}));
      x.Invoice.modified = stamp(); summary(x);
    },
    addPayment(id, amount, status) {
      const x = findInv(id);
      x.payments.push({ id: String(++S.seq.payment), invoice_id: x.Invoice.id, payment_method: 'bank', amount: String(amount), date: '2026-11-04 00:00:00',
        status: status === undefined ? 1 : status, currency_code: x.Invoice.currency_code, created: stamp(), modified: stamp() });
      summary(x);
    },
    // an invoice as if created in the Daftra UI (or via the API with external_source 'api'): {date, po_number, notes, api, draft}
    addInvoice(h) {
      const id = String(++S.seq.invoice);
      const head = Object.assign({ id, client_id: '1', draft: 1, type: 0, currency_code: 'SAR', date: '2026-11-03', no: 'D-' + id, payment_status: -1,
        notes: null, created: stamp(), modified: stamp() }, h || {}, { id });
      if (head.api) head.external_source = 'api';
      delete head.api;
      if (!cfg.poNumbers) delete head.po_number;
      const x = { Invoice: head, items: [], payments: [] };
      summary(x);
      S.invoices.push(x);
      return id;
    },
    deleteInvoice(id) { const k = S.invoices.findIndex(x => String(x.Invoice.id) === String(id)); if (k >= 0) S.invoices.splice(k, 1); },
    touch(id) { findInv(id).Invoice.modified = stamp(); }
  };

  return {
    state: S, requests, faults, control, config: cfg,
    async start() {
      server = http.createServer(handle);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      port = server.address().port;
      return { port, baseUrl: 'http://127.0.0.1:' + port + '/api2' };
    },
    async stop() { if (server) await new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }); server = null; },
    reset() { requests.length = 0; faults.length = 0; }
  };
}

// http(req) → {status, headers, text} over node http (loopback only)
function createNodeHttp(o) {
  const opts = o || {};
  const stats = { requests: 0 };
  const fn = function (req) {
    stats.requests++;
    if (typeof opts.onRequest === 'function') opts.onRequest(req);
    return new Promise((resolve, reject) => {
      const u = new URL(req.url);
      if (u.hostname !== '127.0.0.1') { const e = new Error('loopback only'); e.phase = 'connect'; reject(e); return; }
      let connected = false;
      let done = false;
      const finish = (fnx, v) => { if (!done) { done = true; clearTimeout(timer); fnx(v); } };
      const r = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers || {}, agent: false }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => { const e = new Error('response aborted'); finish(reject, e); });
      });
      r.on('socket', s => { s.on('connect', () => { connected = true; }); if (!s.connecting) connected = true; });
      r.on('error', () => { const e = new Error('request failed'); if (!connected) e.phase = 'connect'; finish(reject, e); });
      const timer = setTimeout(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; finish(reject, e); r.destroy(); }, Math.max(1, req.timeoutMs || 15000));
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
  };
  fn.stats = stats;
  return fn;
}

module.exports = { createFakeDaftraServer, createNodeHttp };

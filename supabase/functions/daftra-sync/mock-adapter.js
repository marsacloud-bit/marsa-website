/*
  Marsa (مرسى) — G5 MOCK Daftra adapter (docs/online/G5_SPEC.md § mock-adapter.js). STAGING / TESTS ONLY.
  A deterministic fake Daftra account: clients, products, invoice drafts, issued invoices, accountant manual
  edits, lost responses / timeouts and payments. No network, no keys. Plain classic script (no import / export,
  no require): the adapter API is passed explicitly as `deps` (node: createMockAdapter({ deps: require('./adapter.js') })).

  Like an API we have not verified, the mock does NOT enforce unique references: duplicates are possible and
  countable (control.count), so the tests prove that the WORKER prevents them.

  Legacy port step 7 (docs/online/LEGACY_DAFTRA_AR.md «عقد المهام») — the mock also simulates:
    - the account profile the probe reports (control.setAccount: e.g. the Egypt-configured account EGP / EG / 14 %);
    - products whose code carries leading zeros (control.addProduct({code: '000186'})) for the zero-insensitive lookup;
    - suspended clients (control.suspendClient / addClient({suspended})), paged client / product / invoice listings;
    - invoices made in the Daftra UI with a number, custom fields (CustomModel) and another client (control.addInvoice);
    - a draft whose date Daftra stores differently from the one sent (control.storeDateAs);
    - suppliers (control.addSupplier, searchSuppliers) and purchase drafts (createPurchaseDraft, findPurchaseByReference).
  The custom fields and the item name sent with a draft are kept on it (control.invoice(id).custom_fields / .lines[].item).
*/
(function () {
  'use strict';

  const DEFAULT_CLOCK_ISO = '2026-11-02T09:00:00.000Z';
  const CAPS_UNSUPPORTED = ['invoices.issue', 'credit_notes.create'];
  const KSA_ACCOUNT = { currency: 'SAR', country: 'SA', taxes: [{ id: '1', value: '15.00', active: true, included: false }] };

  function emptyState() {
    return { seq: { client: 0, product: 0, invoice: 0, line: 0, number: 0, payment: 0, supplier: 0, purchase: 0, purchase_number: 0 },
      clients: [], products: [], invoices: [], payments: [], suppliers: [], purchases: [],
      account: JSON.parse(JSON.stringify(KSA_ACCOUNT)), store_date_as: null };
  }
  const copy = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  function createMockAdapter(opts) {
    const o = opts || {};
    const A = o.deps;
    if (!A || typeof A.AdapterError !== 'function') throw new Error('createMockAdapter: deps (adapter API) required');
    const { AdapterError, ADAPTER_METHODS, CAPABILITY_KEYS, normalizeName, money, fixed } = A;
    const codeNorm = typeof A.codeNorm === 'function' ? A.codeNorm : (v => (v === null || v === undefined ? null : String(v)));
    const clock = typeof o.clock === 'function' ? o.clock : () => DEFAULT_CLOCK_ISO;
    const orgId = o.orgId || null;
    let S = o.state ? copy(o.state) : emptyState();
    const E0 = emptyState();
    for (const k of Object.keys(E0)) if (S[k] === undefined) S[k] = E0[k];
    for (const k of Object.keys(E0.seq)) if (!Number.isInteger(S.seq[k])) S.seq[k] = 0;
    if (o.account) S.account = copy(o.account);

    const calls = [];
    const failQueue = [];          // [{op, kind, applied, message}]
    const loseQueue = [];          // [op]
    let isOffline = false;

    const nextId = (k, p) => p + '-' + (++S.seq[k]);
    const notFound = (what, id) => new AdapterError('not_found', what + ' not found: ' + id, { applied: 'no', http_status: 404 });
    const invalid = (msg) => new AdapterError('validation', msg, { applied: 'no', http_status: 422, code: 'validation' });
    const today = () => String(clock()).slice(0, 10);

    /* ------------------------------------------------------------ views (deep copies out) */
    function totalsOf(inv) {
      let net = 0, vat = 0;
      for (const l of inv.lines) {
        const n = Number(money(Number(l.quantity) * Number(l.unit_price)));
        net += n;
        vat += Number(money(n * Number(l.tax_rate) / 100));
      }
      return { net: money(net), vat: money(vat), total: money(net + vat) };
    }
    function paymentOf(inv, totals) {
      const ps = S.payments.filter(p => p.invoice_id === inv.id);
      const paid = ps.reduce((s, p) => s + Number(p.amount), 0);
      const total = Number(totals.total);
      const last = ps.reduce((m, p) => (!m || p.date > m ? p.date : m), null);
      let status = 'unpaid';
      if (paid > 0 && paid + 0.005 >= total) status = 'paid';
      else if (paid > 0) status = 'partial';
      return { status, paid_amount: money(paid), last_payment_at: last };
    }
    const clientName = id => { const c = S.clients.find(x => x.id === id); return c ? c.name : null; };
    function viewInvoice(inv) {
      const t = totalsOf(inv);
      return copy({
        id: inv.id, reference: inv.reference, client_id: inv.client_id, currency: inv.currency, date: inv.date, notes: inv.notes,
        status: inv.status, number: inv.number || null, version: String(inv.version),
        lines: inv.lines.map(l => ({ id: l.id, line_ref: l.line_ref || null, product_id: l.product_id, description: l.description,
          quantity: fixed(l.quantity, 3), unit_price: fixed(l.unit_price, 2), tax_rate: fixed(l.tax_rate, 2) })),
        totals: t, payment: paymentOf(inv, t),
        client_name: clientName(inv.client_id), custom_fields: inv.custom_fields || {}, url: null
      });
    }
    // step 7: an invoice as a listing / lookup returns it (the head + custom fields; a draft number is D-<id> like Daftra's)
    function viewHead(inv) {
      const v = viewInvoice(inv);
      delete v.lines;
      delete v.payment;
      if (!v.number && inv.status === 'draft') v.number = 'D-' + inv.id;
      return v;
    }
    const viewClient = c => { const v = copy(c); v.suspended = !!c.suspended; return v; };
    const viewProduct = p => copy(p);
    const viewSupplier = x => copy({ id: x.id, name: x.name, secondary_name: x.secondary_name || null, supplier_number: x.supplier_number || null, suspended: !!x.suspended });
    function viewPurchase(p) {
      return copy({ id: p.id, reference: p.reference, supplier_id: p.supplier_id, currency: p.currency, date: p.date, status: p.status,
        number: p.number || null, lines: p.lines, total: money(p.lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price), 0)), url: null,
        tax_nonzero: p.lines.some(l => Number(l.tax_rate) !== 0) });
    }
    function pageOf(list, q) {
      const limit = Math.max(1, Math.min(1000, Number(q && q.limit) || 100));
      const p = Math.max(1, Number(q && q.page) || 1);
      return { items: list.slice((p - 1) * limit, p * limit), more: p * limit < list.length, total: list.length };
    }

    /* ------------------------------------------------------------ internals */
    const findInv = id => S.invoices.find(i => i.id === id);
    function normLines(lines, existing) {
      if (!Array.isArray(lines)) throw invalid('lines must be an array');
      if (lines.length > 500) throw invalid('too many lines');
      const keep = new Map((existing || []).map(l => [l.id, l]));
      return lines.map(l => {
        if (!l || typeof l !== 'object') throw invalid('line must be an object');
        if (!S.products.some(p => p.id === l.product_id)) throw invalid('unknown product ' + l.product_id);
        const q = Number(l.quantity), up = Number(l.unit_price), tr = Number(l.tax_rate);
        if (!(q > 0) || !(up >= 0) || !(tr >= 0) || !Number.isFinite(q + up + tr)) throw invalid('line figures');
        const id = (l.id && keep.has(l.id)) ? l.id : nextId('line', 'l');
        const out = { id, line_ref: l.line_ref ? String(l.line_ref) : null, product_id: String(l.product_id),
          description: String(l.description || ''), quantity: fixed(q, 3), unit_price: fixed(up, 2), tax_rate: fixed(tr, 2) };
        // step 7: a named line (item = product name, description = TAS / empty) reads back as its item, like Daftra's item field
        if (l.item_name !== undefined && l.item_name !== null && l.item_name !== '') {
          out.item = String(l.item_name);
          out.daftra_description = l.daftra_description === undefined || l.daftra_description === null ? '' : String(l.daftra_description);
          out.description = String(l.item_name);
        }
        return out;
      });
    }

    /* ------------------------------------------------------------ the remote operations */
    const ops = {
      async probe() {
        const capabilities = {};
        for (const k of CAPABILITY_KEYS) capabilities[k] = { supported: !CAPS_UNSUPPORTED.includes(k), evidence: 'mock' };
        return { capabilities, account: copy(S.account || KSA_ACCOUNT) };
      },
      async getAccountProfile() {
        const a = copy(S.account || KSA_ACCOUNT);
        return { currency: a.currency, country: a.country, taxes: a.taxes || [] };
      },
      async findClientByRef(ref) {
        const c = S.clients.find(x => x.ref === ref);
        return c ? viewClient(c) : null;
      },
      async findClientsByVat(vat) {
        if (!vat) return [];
        return S.clients.filter(x => x.vat_number && x.vat_number === String(vat).trim()).map(viewClient);
      },
      async getClient(id) {
        const c = S.clients.find(x => x.id === id);
        if (!c) throw notFound('client', id);
        return viewClient(c);
      },
      async createClient(d) {
        if (!d || !d.name) throw invalid('client name required');
        const c = { id: nextId('client', 'c'), ref: d.ref || null };
        for (const k of A.CLIENT_FIELDS) c[k] = d[k] === undefined ? null : d[k];
        c.created_at = clock();
        S.clients.push(c);
        return viewClient(c);
      },
      async updateClient(id, d) {
        const c = S.clients.find(x => x.id === id);
        if (!c) throw notFound('client', id);
        for (const k of A.CLIENT_FIELDS) if (d && d[k] !== undefined) c[k] = d[k];
        return viewClient(c);
      },
      async findProductByCode(code) {
        const p = S.products.find(x => x.code === code);
        return p ? viewProduct(p) : null;
      },
      async findProductsByName(name) {
        const n = normalizeName(name);
        if (!n) return [];
        return S.products.filter(x => normalizeName(x.name_ar) === n || (x.name_en && normalizeName(x.name_en) === n)).map(viewProduct);
      },
      async createProduct(d) {
        if (!d || !d.code || !d.name_ar) throw invalid('product code and name required');
        const p = { id: nextId('product', 'p'), code: String(d.code), name_ar: String(d.name_ar), name_en: d.name_en || null,
          tax_code: d.tax_code || null, vat_rate: fixed(d.vat_rate === undefined ? 0 : d.vat_rate, 2), created_at: clock() };
        S.products.push(p);
        return viewProduct(p);
      },
      async findInvoiceByReference(ref) {
        return S.invoices.filter(i => i.reference === ref).map(viewInvoice);
      },
      async getInvoice(id) {
        const i = findInv(id);
        if (!i) throw notFound('invoice', id);
        return viewInvoice(i);
      },
      async createDraftInvoice(d) {
        if (!d || !d.reference) throw invalid('reference required');
        if (!S.clients.some(c => c.id === d.client_id)) throw invalid('unknown client ' + (d && d.client_id));
        if (!/^[A-Z]{3}$/.test(String(d.currency || ''))) throw invalid('currency');
        const sent = d.date || today();
        // a draft whose date Daftra stores differently from the one sent (step 7: the read-back date check)
        const stored = S.store_date_as || sent;
        S.store_date_as = null;
        const inv = { id: nextId('invoice', 'inv'), reference: String(d.reference), client_id: String(d.client_id), currency: String(d.currency),
          date: stored, notes: d.notes || null, status: 'draft', number: null, version: 1, lines: [], created_at: clock(),
          custom_fields: d.custom_fields && typeof d.custom_fields === 'object' ? copy(d.custom_fields) : {} };
        inv.lines = normLines(d.lines || [], []);
        S.invoices.push(inv);
        return viewInvoice(inv);
      },
      async updateDraftInvoice(id, d) {
        const inv = findInv(id);
        if (!inv) throw notFound('invoice', id);
        if (inv.status !== 'draft') throw new AdapterError('conflict', 'not a draft', { applied: 'no', http_status: 409, code: 'not_draft' });
        if (d && d.expected_version !== undefined && d.expected_version !== null && String(d.expected_version) !== String(inv.version)) {
          throw new AdapterError('conflict', 'version', { applied: 'no', http_status: 409, code: 'version' });
        }
        inv.lines = normLines((d && d.lines) || [], inv.lines);   // replace semantics; kept ids for lines that carry one
        inv.version += 1;
        return viewInvoice(inv);
      },
      async listPayments(invoiceId) {
        if (!findInv(invoiceId)) throw notFound('invoice', invoiceId);
        return S.payments.filter(p => p.invoice_id === invoiceId).map(p => ({ amount: p.amount, date: p.date }));
      },

      /* ---------------------------------------------------------- step 7 */
      async findProductsByCodeNorm(code) {
        const n = codeNorm(code);
        if (!n) return [];
        return S.products.filter(x => codeNorm(x.code) === n).slice(0, 10).map(viewProduct);
      },
      async listProducts(q) {
        const r = pageOf(S.products.slice().sort((a, b) => (a.id < b.id ? -1 : 1)), q);
        return { items: r.items.map(viewProduct), more: r.more, total: r.total };
      },
      async listClients(q) {
        const r = pageOf(S.clients.slice(), q);
        return { items: r.items.map(viewClient), more: r.more, total: r.total };
      },
      async findInvoicesByNumber(no) {
        const key = String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!key) return [];
        return S.invoices.map(viewHead).filter(h => String(h.number || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === key);
      },
      async listInvoices(q) {
        const x = q || {};
        let list = S.invoices.slice();
        if (x.client_id) list = list.filter(i => i.client_id === String(x.client_id));
        if (x.keywords) {
          const k = String(x.keywords).toLowerCase();
          list = list.filter(i => [i.number, i.reference].concat(Object.values(i.custom_fields || {}).map(v => Array.isArray(v) ? v.join(' ') : v))
            .some(v => String(v === null || v === undefined ? '' : v).toLowerCase().includes(k)));
        }
        const seq = id => Number(String(id).replace(/^\D+/, '')) || 0;
        list.sort((a, b) => (seq(a.id) - seq(b.id)) * (String(x.direction || 'ASC').toUpperCase() === 'DESC' ? -1 : 1));
        const r = pageOf(list, x);
        return { items: r.items.map(viewHead), more: r.more, total: r.total };
      },
      async searchSuppliers(q) {
        const n = normalizeName(q);
        if (!n) return [];
        return S.suppliers.filter(x => normalizeName(x.name).includes(n) || normalizeName(x.secondary_name || '').includes(n)).slice(0, 50).map(viewSupplier);
      },
      async findPurchaseByReference(ref) {
        return { hits: S.purchases.filter(p => p.reference === ref).map(viewPurchase), complete: true };
      },
      async getPurchase(id) {
        const p = S.purchases.find(x => x.id === id);
        if (!p) throw notFound('purchase', id);
        return viewPurchase(p);
      },
      async createPurchaseDraft(d) {
        if (!d || !d.reference) throw invalid('reference required');
        if (!S.suppliers.some(x => x.id === String(d.supplier_id))) throw invalid('unknown supplier ' + (d && d.supplier_id));
        const lines = (d.lines || []).map(l => {
          if (!S.products.some(p => p.id === String(l.product_id))) throw invalid('unknown product ' + l.product_id);
          if (Number(l.tax_rate || 0) !== 0) throw invalid('purchase drafts carry no tax');
          return { product_id: String(l.product_id), item: l.item_name || null, description: String(l.description || ''), quantity: fixed(l.quantity, 3),
            unit_price: fixed(l.unit_price, 2), tax_rate: '0.00' };
        });
        const as = S.store_purchase_as || null;
        S.store_purchase_as = null;
        if (as && as.tax_rate !== undefined) for (const l of lines) l.tax_rate = fixed(as.tax_rate, 2);
        const p = { id: nextId('purchase', 'pur'), reference: String(d.reference), supplier_id: String(d.supplier_id), currency: String(d.currency || 'SAR'),
          date: d.date || today(), status: as && as.status ? String(as.status) : 'draft', number: null, lines, created_at: clock() };
        S.purchases.push(p);
        return viewPurchase(p);
      }
    };

    /* ------------------------------------------------------------ the adapter (fault injection around every op) */
    const adapter = { mode: 'mock', orgId };
    for (const m of ADAPTER_METHODS) {
      adapter[m] = async function (...args) {
        calls.push({ op: m, args: copy(args) });
        if (isOffline) throw new AdapterError('network', 'mock offline', { applied: 'no', code: 'offline' });
        const fi = failQueue.findIndex(f => f.op === m);
        if (fi >= 0) {
          const f = failQueue.splice(fi, 1)[0];
          if (f.applied === 'unknown' || f.applied === 'yes') {
            await ops[m](...copy(args));          // the remote applied it, the response is lost
          }
          throw new AdapterError(f.kind, f.message || ('mock ' + f.kind), { applied: f.applied || 'no', code: f.code || f.kind });
        }
        const li = loseQueue.indexOf(m);
        if (li >= 0) {
          loseQueue.splice(li, 1);
          await ops[m](...copy(args));            // applied, then the response is lost
          throw new AdapterError('timeout', 'mock: response lost after send', { applied: 'unknown', code: 'timeout' });
        }
        if (typeof ops[m] !== 'function') throw new AdapterError('not_configured', 'mock lacks ' + m, { applied: 'no', code: 'not_configured' });
        return ops[m](...copy(args));
      };
    }

    /* ------------------------------------------------------------ control: test / demo hooks */
    const control = {
      calls,
      failNext(op, kind, o2) {
        if (!ADAPTER_METHODS.includes(op)) throw new Error('unknown op ' + op);
        failQueue.push({ op, kind: kind || 'timeout', applied: (o2 && o2.applied) || 'no', message: o2 && o2.message, code: o2 && o2.code });
      },
      offline(v) { isOffline = !!v; },
      loseResponse(op) {
        if (!ADAPTER_METHODS.includes(op)) throw new Error('unknown op ' + op);
        loseQueue.push(op);
      },
      // accountant actions inside "Daftra"
      editInvoice(id, mutate) {
        const inv = findInv(id);
        if (!inv) throw new Error('editInvoice: no invoice ' + id);
        if (inv.status !== 'draft') throw new Error('editInvoice: not a draft');
        const draft = copy({ client_id: inv.client_id, notes: inv.notes, lines: inv.lines });
        const r = mutate(draft);
        const out = r || draft;
        inv.lines = normLines(out.lines, inv.lines);
        if (out.client_id) inv.client_id = String(out.client_id);
        if (out.notes !== undefined) inv.notes = out.notes;
        inv.version += 1;
        return viewInvoice(inv);
      },
      issueInvoice(id) {
        const inv = findInv(id);
        if (!inv) throw new Error('issueInvoice: no invoice ' + id);
        if (inv.status !== 'draft') throw new Error('issueInvoice: not a draft');
        inv.status = 'issued';
        inv.number = 'INV-' + String(++S.seq.number).padStart(6, '0');
        inv.issued_at = clock();
        inv.version += 1;
        return viewInvoice(inv);
      },
      cancelInvoice(id) {
        const inv = findInv(id);
        if (!inv) throw new Error('cancelInvoice: no invoice ' + id);
        inv.status = 'cancelled';
        inv.version += 1;
        return viewInvoice(inv);
      },
      deleteDraft(id) {
        const k = S.invoices.findIndex(i => i.id === id);
        if (k < 0) throw new Error('deleteDraft: no invoice ' + id);
        if (S.invoices[k].status !== 'draft') throw new Error('deleteDraft: not a draft');
        S.invoices.splice(k, 1);
      },
      addPayment(id, amount, date) {
        if (!findInv(id)) throw new Error('addPayment: no invoice ' + id);
        S.payments.push({ id: 'pay-' + (++S.seq.payment), invoice_id: id, amount: money(amount), date: date || clock().slice(0, 10) });
      },
      renameClient(id, name) {
        const c = S.clients.find(x => x.id === id);
        if (!c) throw new Error('renameClient: no client ' + id);
        c.name = name;
      },
      /* step 7 */
      // the account the probe reports, e.g. {currency:'EGP', country:'EG', taxes:[{value:14, active:true}]} (the Egypt account)
      setAccount(acc) { S.account = copy(acc); },
      addProduct(d) {
        const p = { id: nextId('product', 'p'), code: String(d.code), name_ar: String(d.name_ar || d.name || d.code), name_en: d.name_en || null,
          tax_code: null, vat_rate: fixed(d.vat_rate === undefined ? 15 : d.vat_rate, 2), created_at: clock() };
        S.products.push(p);
        return viewProduct(p);
      },
      addClient(d) {
        const c = { id: nextId('client', 'c'), ref: d.ref || null };
        for (const k of A.CLIENT_FIELDS) c[k] = d[k] === undefined ? null : d[k];
        c.suspended = !!d.suspended;
        c.secondary_name = d.secondary_name || null;
        c.city = d.city || null;
        c.created_at = clock();
        S.clients.push(c);
        return viewClient(c);
      },
      suspendClient(id, v) {
        const c = S.clients.find(x => x.id === id);
        if (!c) throw new Error('suspendClient: no client ' + id);
        c.suspended = v === undefined ? true : !!v;
      },
      // an invoice created in the Daftra UI: {client_id, number?, status ('draft'|'issued'), date, currency, reference?, custom_fields, total?}
      addInvoice(h) {
        const x = h || {};
        const inv = { id: nextId('invoice', 'inv'), reference: x.reference || null, client_id: String(x.client_id), currency: x.currency || 'SAR',
          date: x.date || today(), notes: null, status: x.status || 'issued', number: x.number || null, version: 1, lines: [], created_at: clock(),
          custom_fields: copy(x.custom_fields || {}) };
        if (x.total !== undefined) {
          let p = S.products[0];
          if (!p) p = control.addProduct({ code: 'UI-1', name_ar: 'بند' });
          inv.lines = normLines([{ product_id: p.id, description: 'ui', quantity: 1, unit_price: x.total, tax_rate: 0 }], []);
        }
        if (inv.status !== 'draft' && !inv.number) inv.number = 'INV-' + String(++S.seq.number).padStart(6, '0');
        S.invoices.push(inv);
        return viewHead(inv);
      },
      // the next created draft is stored with this date (Daftra kept another date than the one sent)
      storeDateAs(date) { S.store_date_as = date; },
      addSupplier(d) {
        const x = { id: nextId('supplier', 'sup'), name: String(d.name), secondary_name: d.secondary_name || null, supplier_number: d.supplier_number || null, suspended: !!d.suspended };
        S.suppliers.push(x);
        return viewSupplier(x);
      },
      // inspection
      state() { return copy(S); },
      invoice(id) { const i = findInv(id); return i ? Object.assign(viewInvoice(i), { lines_raw: copy(i.lines) }) : null; },
      purchase(id) { const p = S.purchases.find(x => x.id === id); return p ? viewPurchase(p) : null; },
      // review: Daftra stores the next purchase draft with a product tax / not as a draft (what the re-read must catch)
      storePurchaseAs(x) { S.store_purchase_as = copy(x || null); },
      count(kind, pred) {
        const match = (x, keys) => typeof pred === 'function' ? !!pred(x) : (pred === undefined || pred === null) ? true : keys.some(k => x[k] === pred);
        switch (kind) {
          case 'client': return S.clients.filter(x => match(x, ['ref', 'id'])).length;
          case 'product': return S.products.filter(x => match(x, ['code', 'id'])).length;
          case 'invoice': return S.invoices.filter(x => match(x, ['reference', 'id'])).length;
          case 'line': {
            let n = 0;
            for (const i of S.invoices) for (const l of i.lines) if (match(l, ['line_ref', 'id'])) n++;
            return n;
          }
          case 'payment': return S.payments.filter(x => match(x, ['invoice_id'])).length;
          case 'purchase': return S.purchases.filter(x => match(x, ['reference', 'id'])).length;
          case 'supplier': return S.suppliers.filter(x => match(x, ['name', 'id'])).length;
          case 'call': return calls.filter(x => match(x, ['op'])).length;
          default: throw new Error('count: unknown kind ' + kind);
        }
      },
      reset() { calls.length = 0; failQueue.length = 0; loseQueue.length = 0; isOffline = false; }
    };
    adapter.control = control;
    return adapter;
  }

  const API = { createMockAdapter, MOCK_EMPTY_STATE: emptyState };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

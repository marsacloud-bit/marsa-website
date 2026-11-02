/*
  Marsa (مرسى) — G5 Daftra sync worker (docs/online/G5_SPEC.md § worker.js). Server-side only.
  Plain classic script (no import / export, no require). The adapter API is passed explicitly as `deps`.

  createWorker({ rpc, adapterFor, workerId, clock, deps }):
    rpc(name, args)              → Promise<jsonb>  (Deno: supabase-js service client; tests: PGlite as service_role)
    adapterFor(connection, org)  → adapter         (one adapter per org, built from that org's connection only)
    runOnce({limit})             → {claimed, ok, retry, failed, unknown, conflict, frozen, errors}
  runJob(ctx, adapter, {deps, clock}) → p_result for daftra_complete_job: {outcome, error, calls, effects, expected_hash}

  Binding rules implemented here:
    - lookup before every create (client by ref, product by code, invoice by operational_ref);
    - VAT / name hits → conflict with candidates (never a silent second record, never a silent adoption);
    - a lost response (applied:'unknown') is outcome 'unknown', never failed / retry;
    - read before every update; a remote edit → conflict, no update is sent; foreign lines are never touched;
    - a non-draft remote invoice is never updated (outcome 'frozen' → pull effects);
    - the worker is given no fetch and calls nothing but rpc() and the adapter.
*/
(function () {
  'use strict';

  const MAX_CALLS = 50;
  const MAX_CALLS_BYTES = 262144;
  const DEFAULT_CALL_TIMEOUT_MS = 60000;          // every adapter call, well under the 5-minute lease
  // mirror of app.bill_secret_key / app.bill_scrub_text (SQL): key names and secrets inside string values
  const SECRET_RE = /(api[_-]?key|secret|token|password|passwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)/i;
  const SECRET_EXACT_RE = /^\s*(pass|pwd|auth|bearer|x-auth)\s*$/i;
  const LINKED = ['linked', 'drift'];
  const isSecretKey = k => SECRET_RE.test(k) || SECRET_EXACT_RE.test(k);

  function scrubText(t) {
    if (typeof t !== 'string') return t;
    return t
      .replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/gi, '$1?[redacted]')
      .replace(/(bearer|basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
      .replace(/([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)[A-Za-z0-9_.-]*)(\s*[=:]\s*"?)[^\s&"',;]+/gi, '$1$2[redacted]');
  }

  // mirror of app.bill_redact: drop secret-like keys, mask [name, value] header pairs, scrub string values, cap long strings
  function redact(x, depth) {
    const d = depth || 0;
    if (d > 20) return null;
    if (Array.isArray(x)) {
      if (x.length === 2 && typeof x[0] === 'string' && isSecretKey(x[0])) return [x[0], '[redacted]'];
      return x.map(v => redact(v, d + 1));
    }
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x)) if (!isSecretKey(k) && x[k] !== undefined) o[k] = redact(x[k], d + 1);
      return o;
    }
    if (typeof x === 'string') return scrubText(x).slice(0, 4000);
    return x === undefined ? null : x;
  }

  function errJson(e) {
    if (!e) return null;
    return { kind: String(e.kind || 'worker').slice(0, 40), code: scrubText(String(e.code || e.kind || 'worker')).slice(0, 60),
      message: scrubText(String(e.message || e)).slice(0, 500), http_status: Number.isInteger(e.http_status) ? e.http_status : null };
  }

  // a call that does not answer in time: a write may have been applied ('unknown'), a read was not
  function withTimeout(p, ms, A, op) {
    if (!(ms > 0)) return p;
    let timer = null;
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new A.AdapterError('timeout', op + ' timed out after ' + ms + ' ms',
        { applied: A.WRITE_METHODS.includes(op) ? 'unknown' : 'no' })), ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  // fencing failure: this worker no longer holds the job, nothing is written
  class LeaseLost extends Error { constructor(m) { super(m || 'lease lost'); this.lease_lost = true; } }

  // records every adapter call as {op, at, ms, request, response, error, applied};
  // opts.beforeWrite(op) runs right before every WRITE (lease renewal); a failure there sends nothing
  function recorder(adapter, A, clock, opts) {
    const o = opts || {};
    const calls = [];
    const rec = {};
    const timeoutMs = o.callTimeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : o.callTimeoutMs;
    for (const op of A.ADAPTER_METHODS) {
      rec[op] = async function (...args) {
        if (A.WRITE_METHODS.includes(op) && typeof o.beforeWrite === 'function') {
          try { await o.beforeWrite(op); }
          catch (e) { throw new LeaseLost(String((e && e.message) || e).slice(0, 300)); }
        }
        const at = clock();
        const t0 = Date.now();
        const entry = { op, at, ms: 0, request: redact(args.length === 1 ? args[0] : args), response: null, error: null, applied: 'no' };
        calls.push(entry);
        try {
          if (typeof adapter[op] !== 'function') throw new A.AdapterError('not_configured', 'adapter lacks ' + op, { applied: 'no' });
          const r = await withTimeout(Promise.resolve().then(() => adapter[op](...args)), timeoutMs, A, op);
          entry.response = redact(r === undefined ? null : r);
          entry.applied = A.WRITE_METHODS.includes(op) ? 'yes' : 'no';
          return r;
        } catch (e) {
          entry.error = errJson(A.isAdapterError(e) ? e : { kind: 'worker', code: 'exception', message: e && e.message });
          entry.applied = (A.isAdapterError(e) && e.applied) || 'no';
          throw e;
        } finally {
          entry.ms = Math.max(0, Date.now() - t0);
        }
      };
    }
    return { api: rec, calls };
  }

  // keep the call log inside the attempt limits (≤ 50 entries, ≤ 256 KiB)
  function boundCalls(calls) {
    let out = calls.slice(0, MAX_CALLS);
    if (calls.length > MAX_CALLS) out[MAX_CALLS - 1] = { op: 'truncated', at: null, ms: 0, request: { dropped: calls.length - MAX_CALLS + 1 }, response: null, error: null, applied: 'no' };
    const size = () => (typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(out)).length : JSON.stringify(out).length * 3);
    if (size() > MAX_CALLS_BYTES) out = out.map(c => Object.assign({}, c, { response: c.response === null ? null : { truncated: true } }));
    if (size() > MAX_CALLS_BYTES) out = out.map(c => Object.assign({}, c, { request: { truncated: true } }));
    return out;
  }

  /* ================================================================ per-kind algorithms */
  class Outcome extends Error {
    constructor(outcome, effects, error, extra) { super(outcome); this.outcome = outcome; this.effects = effects; this.error = error || null; this.extra = extra || {}; }
  }

  function makeCtx(A) {
    const remoteSnapshotClient = c => A.normalizeClient(c);
    const productSnapshot = p => p ? { id: p.id, code: p.code, name_ar: p.name_ar, name_en: p.name_en || null, tax_code: p.tax_code || null, vat_rate: p.vat_rate === undefined ? null : p.vat_rate } : null;
    const candidateClient = c => ({ external_id: String(c.id), name: c.name || null, vat_number: c.vat_number || null });
    const candidateProduct = p => ({ external_id: String(p.id), external_product_id: String(p.id), name: p.name_ar || null, code: p.code || null });

    // §3 ensure algorithm. Returns a client effect; throws Outcome('conflict') with candidates.
    async function ensureClient(R, c, opts) {
      const o = opts || {};
      if (!c || !c.link_id) throw new Outcome('failed', {}, { kind: 'validation', code: 'client', message: 'no client link', http_status: null });
      if (!o.force && c.external_id && (LINKED.includes(c.status) || c.status === 'pending')) return null;   // linked (or manually linked, verified by client_refresh): never a second client
      const data = A.normalizeClient(c.data || {});
      const byRef = await R.findClientByRef(c.client_ref);
      if (byRef) {
        const snap = remoteSnapshotClient(byRef);
        return { client_link_id: c.link_id, external_id: String(byRef.id), found_by: 'ref', remote_snapshot: snap, pushed_snapshot: c.pushed_snapshot || snap };
      }
      if (!o.forceCreate && data.vat_number) {
        const hits = await R.findClientsByVat(data.vat_number);
        if (hits && hits.length) {
          throw new Outcome('conflict', { client_link_id: c.link_id, candidates: hits.slice(0, 10).map(candidateClient) },
            { kind: 'conflict', code: 'client_review', message: 'Daftra clients with the same VAT number exist', http_status: null });
        }
      }
      const created = await R.createClient(Object.assign({ ref: c.client_ref }, data));
      const back = await R.getClient(created.id);
      return { client_link_id: c.link_id, external_id: String(back.id), found_by: 'created', remote_snapshot: remoteSnapshotClient(back), pushed_snapshot: data };
    }

    // §4 ensure algorithm for one item key
    async function ensureItem(R, it) {
      if (!it || !it.link_id) throw new Outcome('failed', {}, { kind: 'validation', code: 'item', message: 'no item link', http_status: null });
      if (it.external_product_id && it.status === 'linked') return null;
      const byCode = await R.findProductByCode(it.product_code);
      if (byCode) {
        if (it.external_product_id && String(byCode.id) !== String(it.external_product_id)) {
          throw new Outcome('conflict', { item_link_id: it.link_id, candidates: [candidateProduct(byCode)] },
            { kind: 'conflict', code: 'item_review', message: 'product code maps to another Daftra product', http_status: null });
        }
        return { item_link_id: it.link_id, external_product_id: String(byCode.id), found_by: 'ref', remote_snapshot: productSnapshot(byCode) };
      }
      const hits = ((await R.findProductsByName(it.name_ar)) || []).filter(p => p.code !== it.product_code);
      if (it.external_product_id) {
        // a manual mapping (save_daftra_item): verified by name when visible, never re-created
        const h = hits.find(p => String(p.id) === String(it.external_product_id));
        return { item_link_id: it.link_id, external_product_id: String(it.external_product_id), found_by: 'manual', remote_snapshot: h ? productSnapshot(h) : { id: String(it.external_product_id) } };
      }
      if (hits.length) {
        throw new Outcome('conflict', { item_link_id: it.link_id, candidates: hits.slice(0, 10).map(candidateProduct) },
          { kind: 'conflict', code: 'item_review', message: 'Daftra products with the same name and another code exist', http_status: null });
      }
      const p = await R.createProduct({ code: it.product_code, name_ar: it.name_ar, name_en: it.name_en || null, tax_code: it.tax_code || null, vat_rate: it.default_vat_rate });
      return { item_link_id: it.link_id, external_product_id: String(p.id), found_by: 'created', remote_snapshot: productSnapshot(p) };
    }

    function remoteTotals(inv) {
      const t = (inv && inv.totals) || {};
      return { net: A.money(t.net || 0), vat: A.money(t.vat || 0), total: A.money(t.total || 0) };
    }
    function invoiceSnapshot(inv) {
      return {
        id: String(inv.id), reference: inv.reference || null, client_id: inv.client_id === undefined ? null : inv.client_id,
        currency: inv.currency || null, status: inv.status || null, number: inv.number || null, version: inv.version === undefined ? null : String(inv.version),
        lines: (inv.lines || []).map(l => ({ id: l.id === undefined ? null : String(l.id), line_ref: l.line_ref || null, product_id: l.product_id === undefined ? null : String(l.product_id),
          description: l.description === undefined ? null : l.description, quantity: A.fixed(l.quantity, 3), unit_price: A.fixed(l.unit_price, 2), tax_rate: A.fixed(l.tax_rate, 2) })),
        totals: remoteTotals(inv)
      };
    }
    function paymentOf(inv, payments) {
      const list = Array.isArray(payments) ? payments : [];
      const paid = list.reduce((s, p) => s + Number(p.amount || 0), 0);
      const total = Number(remoteTotals(inv).total);
      const last = list.reduce((m, p) => (p.date && (!m || p.date > m) ? p.date : m), null);
      let status = 'unpaid';
      if (paid > 0 && paid + 0.005 >= total) status = 'paid';
      else if (paid > 0) status = 'partial';
      return { status, paid_amount: A.money(paid), last_payment_at: last ? String(last) : null };
    }
    // dc = {it, productOf}: when the remote differs from what Marsa pushed, the per-line diff goes with the effects
    // (a draft → conflict diff; an issued invoice → the issued_mismatch review item's diff, step ١٠)
    async function pullEffects(R, intentId, inv, dc) {
      const payments = await R.listPayments(inv.id);
      const e = {
        intent_id: intentId, external_invoice_id: String(inv.id), daftra_number: inv.number || null, daftra_status: String(inv.status || '').slice(0, 40),
        remote_state: A.remoteState(inv.status), remote_hash: await A.invoiceHash(inv), remote_snapshot: invoiceSnapshot(inv),
        remote_totals: remoteTotals(inv), payment: paymentOf(inv, payments)
      };
      if (e.daftra_number === null) delete e.daftra_number;
      if (dc && dc.it && dc.it.pushed_hash && e.remote_hash !== dc.it.pushed_hash) e.diff = diffOf(dc.it, inv, dc.productOf);
      return e;
    }

    // the Marsa-intended remote line of a local line
    function marsaLine(l, productOf) {
      return { line_ref: l.line_ref, product_id: productOf(l.item_key), description: l.description,
        quantity: A.fixed(l.quantity, 3), unit_price: A.fixed(l.unit_price, 2), tax_rate: A.fixed(l.vat_rate, 2) };
    }
    const sameLine = (a, b) => A.stableStringify(A.canonicalLine(a)) === A.stableStringify(A.canonicalLine(b));

    // diff of Marsa's pushed lines vs the remote draft, per line_ref / field
    function diffOf(it, remote, productOf) {
      const diff = [];
      const byRef = new Map((remote.lines || []).filter(l => l.line_ref).map(l => [l.line_ref, l]));
      const owned = new Set();
      for (const l of it.lines || []) {
        owned.add(l.line_ref);
        if (!l.pushed) continue;
        const want = A.canonicalLine(marsaLine(l, productOf));
        const r = byRef.get(l.line_ref);
        if (!r) { diff.push({ line_ref: l.line_ref, field: 'line', pushed: 'present', remote: null }); continue; }
        const got = A.canonicalLine(r);
        for (const f of ['product_id', 'description', 'quantity', 'unit_price', 'tax_rate']) {
          if (want[f] !== got[f]) diff.push({ line_ref: l.line_ref, field: f, pushed: want[f], remote: got[f] });
        }
      }
      for (const r of remote.lines || []) {
        if (!r.line_ref) diff.push({ line_ref: null, field: 'foreign_line', pushed: null, remote: String(r.description || '').slice(0, 200) });
        else if (!owned.has(r.line_ref)) diff.push({ line_ref: r.line_ref, field: 'line', pushed: null, remote: 'present' });
      }
      const cl = it.client && it.client.external_id;
      if (cl && remote.client_id !== undefined && String(remote.client_id) !== String(cl)) diff.push({ line_ref: null, field: 'client_id', pushed: String(cl), remote: String(remote.client_id) });
      return diff.slice(0, 200);
    }

    // adopting a remote invoice with no baseline (found by reference): every Marsa line on it must be exactly Marsa's,
    // and nothing else may be on it — an accountant edit is never absorbed silently (step ٩)
    function adoptDiff(it, remote, productOf) {
      const diff = [];
      const live = new Map((it.lines || []).map(l => [l.line_ref, l]));
      for (const r of remote.lines || []) {
        if (!r.line_ref) { diff.push({ line_ref: null, field: 'foreign_line', pushed: null, remote: String(r.description || '').slice(0, 200) }); continue; }
        const l = live.get(r.line_ref);
        if (!l) { diff.push({ line_ref: r.line_ref, field: 'line', pushed: null, remote: 'present' }); continue; }
        const want = A.canonicalLine(marsaLine(l, productOf));
        const got = A.canonicalLine(r);
        for (const f of ['product_id', 'description', 'quantity', 'unit_price', 'tax_rate']) {
          if (want[f] !== got[f]) diff.push({ line_ref: l.line_ref, field: f, pushed: want[f], remote: got[f] });
        }
      }
      return diff.slice(0, 200);
    }

    // a reference hit is adopted only when it is billed to this intent's Daftra client, in its currency
    function identityDiff(itc, remote) {
      const d = [];
      const want = itc.client && itc.client.external_id != null ? String(itc.client.external_id) : null;
      const rc = remote.client_id == null ? null : String(remote.client_id);
      const rcur = remote.currency == null ? null : String(remote.currency).toUpperCase();
      if (rc !== want) d.push({ line_ref: null, field: 'client_id', pushed: want, remote: rc });
      if (rcur !== String(itc.currency || '').toUpperCase()) d.push({ line_ref: null, field: 'currency', pushed: itc.currency || null, remote: rcur });
      return d;
    }

    // the new remote line list: remote lines with Marsa's operations applied (foreign lines verbatim)
    function mergeLines(it, remote, productOf, overwrite) {
      const live = new Map((it.lines || []).map(l => [l.line_ref, l]));
      const out = [];
      const seen = new Set();
      for (const r of remote.lines || []) {
        const keep = { id: r.id, line_ref: r.line_ref || null, product_id: r.product_id, description: r.description, quantity: r.quantity, unit_price: r.unit_price, tax_rate: r.tax_rate };
        if (!r.line_ref) { out.push(keep); continue; }                    // foreign (accountant) line: never touched
        const l = live.get(r.line_ref);
        if (!l) { out.push(keep); continue; }                             // not a live Marsa line: never removed blindly
        if (seen.has(r.line_ref)) { out.push(keep); continue; }            // a duplicate we did not create: left for review
        seen.add(r.line_ref);
        if (l.state === 'pending_remove') continue;                       // only that line_ref is dropped
        out.push(overwrite ? Object.assign({ id: r.id }, marsaLine(l, productOf)) : keep);
      }
      for (const l of it.lines || []) {
        if (seen.has(l.line_ref) || l.state === 'pending_remove') continue;
        if (l.state === 'pending_add' || overwrite) out.push(marsaLine(l, productOf));
      }
      return out;
    }

    function lineResults(it, remote) {
      const byRef = new Map();
      for (const r of remote.lines || []) if (r.line_ref && !byRef.has(r.line_ref)) byRef.set(r.line_ref, r);
      const res = [];
      for (const l of it.lines || []) {
        const r = byRef.get(l.line_ref);
        if (r) res.push({ line_id: l.line_id, state: 'synced', remote_line_id: r.id === undefined || r.id === null ? null : String(r.id) });
        else if (l.state === 'pending_remove') res.push({ line_id: l.line_id, state: 'removed', remote_line_id: null });
      }
      return res;
    }

    async function pushOk(it, back, foundBy, inline) {
      const h = await A.invoiceHash(back);
      const e = {
        intent_id: it.id, external_invoice_id: String(back.id), found_by: foundBy, daftra_status: String(back.status || '').slice(0, 40),
        remote_state: A.remoteState(back.status), daftra_number: back.number || null, remote_version: back.version === undefined || back.version === null ? null : String(back.version),
        remote_hash: h, pushed_hash: h, remote_snapshot: invoiceSnapshot(back), remote_totals: remoteTotals(back),
        line_results: lineResults(it, back), clients: inline.clients, items: inline.items
      };
      if (e.daftra_number === null) delete e.daftra_number;
      if (e.remote_version === null) delete e.remote_version;
      return e;
    }

    async function invoicePush(R, ctx) {
      const it = ctx.intent;
      const job = ctx.job || {};
      const opt = job.options || {};
      if (!it) throw new Outcome('failed', {}, { kind: 'validation', code: 'intent', message: 'no intent in context', http_status: null });
      const inline = { clients: [], items: [] };
      const base = { intent_id: it.id };
      if (it.status === 'issued' || it.status === 'cancelled') {
        throw new Outcome('failed', base, { kind: 'validation', code: 'intent_' + it.status, message: 'intent is ' + it.status, http_status: null });
      }

      // 1. client + items, inline (same lookups as the dedicated jobs)
      let clientExt = it.client && it.client.external_id;
      try {
        const ce = await ensureClient(R, it.client, {});
        if (ce) { inline.clients.push(ce); clientExt = ce.external_id; }
      } catch (e) {
        if (e instanceof Outcome && e.outcome === 'conflict') {
          throw new Outcome('conflict', Object.assign({}, base, { reason: 'client_review', clients: [e.effects] }), e.error);
        }
        throw e;
      }
      const productIds = {};
      for (const item of it.items || []) {
        if (item.external_product_id && item.status === 'linked') { productIds[item.item_key] = String(item.external_product_id); continue; }
        try {
          const ie = await ensureItem(R, item);
          if (ie) { inline.items.push(ie); productIds[item.item_key] = ie.external_product_id; }
        } catch (e) {
          if (e instanceof Outcome && e.outcome === 'conflict') {
            throw new Outcome('conflict', Object.assign({}, base, { reason: 'item_review', clients: inline.clients, items: inline.items.concat([e.effects]) }), e.error);
          }
          throw e;
        }
      }
      const productOf = k => {
        if (!productIds[k]) throw new Outcome('failed', Object.assign({}, base, inline), { kind: 'validation', code: 'item_unmapped', message: 'no Daftra product for ' + k, http_status: null });
        return productIds[k];
      };
      const itc = Object.assign({}, it, { client: Object.assign({}, it.client || {}, { external_id: clientExt }) });
      const safeProductOf = k => productIds[k] || null;
      const dcx = { it: itc, productOf: safeProductOf };

      // 2. identity: reference lookup before every create (first push, retry, reconcile, recreate)
      let extId = opt.recreate ? null : (it.external_invoice_id || null);
      let foundBy = 'existing';
      if (job.previous_status === 'unknown' || !extId) {
        const hits = (await R.findInvoiceByReference(it.operational_ref)) || [];
        const others = extId ? hits.filter(h => String(h.id) !== String(extId)) : hits;
        if (hits.length > 1 || (extId && others.length > 0)) {
          throw new Outcome('conflict', Object.assign({}, base, {
            reason: 'external_in_use', remote_hash: null, remote_snapshot: { hits: hits.map(h => String(h.id)) }, external_ids: hits.map(h => String(h.id)),
            diff: hits.map(h => ({ line_ref: null, field: 'external_invoice_id', pushed: extId, remote: String(h.id) }))
          }));
        }
        if (hits.length === 1) {
          extId = String(hits[0].id);
          foundBy = it.external_invoice_id && String(it.external_invoice_id) === extId ? 'existing' : 'ref';
        } else if (!extId) {
          // 0 hits: create the draft with every pending_add + synced line
          const lines = (it.lines || []).filter(l => l.state === 'pending_add' || l.state === 'synced').map(l => marsaLine(l, productOf));
          const payload = { reference: it.operational_ref, client_id: clientExt, currency: it.currency, date: it.invoice_date, notes: it.notes || null, lines };
          const expected = await A.contentHash(A.canonicalInvoice(payload));
          let created;
          try { created = await R.createDraftInvoice(payload); }
          catch (e) {
            if (A.isAdapterError(e) && e.applied === 'unknown') throw new Outcome('unknown', Object.assign({}, base, inline), errJson(e), { expected_hash: expected });
            throw e;
          }
          const back = await R.getInvoice(created.id);
          return { outcome: 'ok', effects: await pushOk(itc, back, 'created', inline) };
        }
      }

      // 3. read before update
      let remote;
      try { remote = await R.getInvoice(extId); }
      catch (e) {
        if (A.isAdapterError(e) && e.kind === 'not_found') {
          throw new Outcome('conflict', Object.assign({}, base, { reason: 'remote_missing', remote_hash: null, remote_snapshot: null, diff: [], external_invoice_id: String(extId) }));
        }
        throw e;
      }
      if (foundBy === 'ref') {
        // never adopt (nor mark issued from) another client's / currency's invoice that reuses the reference
        const idd = identityDiff(itc, remote);
        if (idd.length) {
          throw new Outcome('conflict', Object.assign({}, base, {
            reason: 'external_in_use', remote_hash: null, remote_snapshot: { hits: [String(extId)] }, external_ids: [String(extId)], diff: idd
          }));
        }
      }
      if (A.remoteState(remote.status) !== 'draft') {
        const pe = await pullEffects(R, it.id, remote, dcx);
        throw new Outcome('frozen', pe);
      }
      const rh = await A.invoiceHash(remote);
      let baseline = it.pushed_hash || null;
      const editedConflict = d => new Outcome('conflict', Object.assign({}, base, { reason: 'remote_edited', remote_hash: rh, remote_snapshot: invoiceSnapshot(remote), diff: d, external_invoice_id: String(extId) }));
      // what this run would leave on the remote (Marsa's pending operations applied to it)
      const appliedAsDesired = async () => {
        const d0 = mergeLines(itc, remote, productOf, !!opt.overwrite);
        return (await A.contentHash(A.canonicalInvoice({ client_id: remote.client_id, currency: remote.currency, lines: d0 }))) === rh;
      };
      if (job.expected_hash && rh === job.expected_hash) {
        baseline = rh;                                                  // the lost operation was applied
      } else if (!baseline) {
        // adopted with no baseline (found by reference, or a remote id without a pushed hash): only Marsa's own lines, unchanged
        const d = adoptDiff(itc, remote, productOf);
        if (d.length && !opt.overwrite) throw editedConflict(d);
        baseline = rh;
      } else if (rh !== baseline && job.previous_status === 'unknown' && await appliedAsDesired()) {
        // an earlier attempt (lost response, crashed / reclaimed worker) applied exactly this run's update: nothing to send
        return { outcome: 'ok', effects: await pushOk(itc, remote, foundBy, inline) };
      }
      if (rh !== baseline && !opt.overwrite) {
        throw new Outcome('conflict', Object.assign({}, base, { reason: 'remote_edited', remote_hash: rh, remote_snapshot: invoiceSnapshot(remote), diff: diffOf(itc, remote, productOf), external_invoice_id: String(extId) }));
      }
      const desired = mergeLines(itc, remote, productOf, !!opt.overwrite);
      const desiredCanon = A.canonicalInvoice({ client_id: remote.client_id, currency: remote.currency, lines: desired });
      const dh = await A.contentHash(desiredCanon);
      if (dh === rh) {
        return { outcome: 'ok', effects: await pushOk(itc, remote, foundBy, inline) };      // no-op: nothing sent
      }
      try { await R.updateDraftInvoice(extId, { lines: desired, expected_version: remote.version }); }
      catch (e) {
        if (A.isAdapterError(e) && e.applied === 'unknown') {
          throw new Outcome('unknown', Object.assign({}, base, inline, { external_invoice_id: String(extId) }), errJson(e), { expected_hash: dh });
        }
        throw e;
      }
      const back = await R.getInvoice(extId);
      if (A.remoteState(back.status) !== 'draft') throw new Outcome('frozen', await pullEffects(R, it.id, back, dcx));
      return { outcome: 'ok', effects: await pushOk(itc, back, foundBy, inline) };
    }

    async function invoicePull(R, ctx) {
      const it = ctx.intent;
      if (!it || !it.external_invoice_id) throw new Outcome('failed', { intent_id: it && it.id }, { kind: 'validation', code: 'no_external_invoice', message: 'nothing to pull', http_status: null });
      let inv;
      try { inv = await R.getInvoice(it.external_invoice_id); }
      catch (e) {
        if (A.isAdapterError(e) && e.kind === 'not_found') {
          throw new Outcome('conflict', { intent_id: it.id, reason: 'remote_missing', remote_hash: null, remote_snapshot: null, diff: [], external_invoice_id: String(it.external_invoice_id) });
        }
        throw e;
      }
      // a manual edit seen on pull (draft → conflict, step ٩; issued → issued_mismatch, step ١٠): the diff goes with it
      const pids = {};
      for (const item of it.items || []) if (item.external_product_id) pids[item.item_key] = String(item.external_product_id);
      const e = await pullEffects(R, it.id, inv, { it, productOf: k => pids[k] || null });
      return { outcome: 'ok', effects: e };
    }

    async function clientJob(R, ctx) {
      const c = ctx.client;
      const kind = ctx.job.kind;
      const opt = ctx.job.options || {};
      if (!c) throw new Outcome('failed', {}, { kind: 'validation', code: 'client', message: 'no client in context', http_status: null });
      if (kind === 'client_ensure') {
        const e = await ensureClient(R, c, { force: true, forceCreate: !!opt.force_create });
        return { outcome: 'ok', effects: e };
      }
      if (!c.external_id) throw new Outcome('failed', { client_link_id: c.link_id }, { kind: 'validation', code: 'external_id', message: 'link has no external id', http_status: null });
      if (kind === 'client_refresh') {
        let r;
        try { r = await R.getClient(c.external_id); }
        catch (e) {
          if (A.isAdapterError(e) && e.kind === 'not_found') throw new Outcome('failed', { client_link_id: c.link_id }, errJson(e));
          throw e;
        }
        return { outcome: 'ok', effects: { client_link_id: c.link_id, external_id: String(r.id), found_by: 'manual', remote_snapshot: A.normalizeClient(r) } };
      }
      // client_push: update the Daftra client with the local snapshot (explicit fin_approve decision)
      const data = A.normalizeClient(c.data || {});
      try { await R.updateClient(c.external_id, data); }
      catch (e) {
        if (A.isAdapterError(e) && e.applied === 'unknown') throw new Outcome('unknown', { client_link_id: c.link_id }, errJson(e));
        throw e;
      }
      const back = await R.getClient(c.external_id);
      return { outcome: 'ok', effects: { client_link_id: c.link_id, external_id: String(back.id), found_by: 'pushed', remote_snapshot: A.normalizeClient(back), pushed_snapshot: data } };
    }

    async function itemJob(R, ctx) {
      const it = ctx.item;
      if (!it) throw new Outcome('failed', {}, { kind: 'validation', code: 'item', message: 'no item in context', http_status: null });
      const e = await ensureItem(R, Object.assign({}, it, { status: 'pending' }));
      return { outcome: 'ok', effects: e };
    }

    async function probeJob(R) {
      const p = await R.probe();
      const caps = {};
      for (const k of A.CAPABILITY_KEYS) {
        const c = p && p.capabilities && p.capabilities[k];
        caps[k] = { supported: !!(c && c.supported === true), evidence: String((c && c.evidence) || 'not reported').slice(0, 300) };
      }
      return { outcome: 'ok', effects: { capabilities: caps, account: (p && p.account) || {} } };
    }

    return { ensureClient, ensureItem, invoicePush, invoicePull, clientJob, itemJob, probeJob };
  }

  // target effects for an error outcome (so completion stamps last_error_* on the right row)
  function targetOf(ctx) {
    const k = ctx && ctx.job && ctx.job.kind;
    if (k === 'invoice_push' || k === 'invoice_pull') return ctx.intent ? { intent_id: ctx.intent.id } : {};
    if (k && k.startsWith('client_')) return ctx.client ? { client_link_id: ctx.client.link_id } : {};
    if (k === 'item_ensure') return ctx.item ? { item_link_id: ctx.item.link_id } : {};
    return {};
  }

  function mapAdapterError(A, e) {
    if (!A.isAdapterError(e)) return { outcome: 'retry', error: { kind: 'worker', code: 'exception', message: String((e && e.message) || e).slice(0, 500), http_status: null } };
    if (e.applied === 'unknown') return { outcome: 'unknown', error: errJson(e) };
    if (['timeout', 'network', 'http_5xx', 'rate_limited'].includes(e.kind)) return { outcome: 'retry', error: errJson(e) };
    if (e.kind === 'conflict') return { outcome: 'retry', error: errJson(e) };     // the remote moved between read and update: re-read next run
    return { outcome: 'failed', error: errJson(e) };                                 // validation, not_configured, unhandled not_found
  }

  async function runJob(ctx, adapter, opts) {
    const o = opts || {};
    const A = o.deps;
    if (!A || typeof A.canonicalInvoice !== 'function') throw new Error('runJob: deps (adapter API) required');
    const clock = typeof o.clock === 'function' ? o.clock : () => new Date().toISOString();
    const R = recorder(adapter, A, clock, { beforeWrite: o.beforeWrite, callTimeoutMs: o.callTimeoutMs });
    const K = makeCtx(A);
    let res;
    try {
      const kind = ctx && ctx.job && ctx.job.kind;
      if (kind === 'probe') res = await K.probeJob(R.api);
      else if (kind === 'invoice_push') res = await K.invoicePush(R.api, ctx);
      else if (kind === 'invoice_pull') res = await K.invoicePull(R.api, ctx);
      else if (kind === 'client_ensure' || kind === 'client_refresh' || kind === 'client_push') res = await K.clientJob(R.api, ctx);
      else if (kind === 'item_ensure') res = await K.itemJob(R.api, ctx);
      else res = { outcome: 'failed', error: { kind: 'validation', code: 'job_kind', message: 'unknown job kind ' + kind, http_status: null }, effects: {} };
    } catch (e) {
      if (e instanceof Outcome) {
        res = { outcome: e.outcome, effects: e.effects || {}, error: e.error };
        if (e.extra && e.extra.expected_hash) res.expected_hash = e.extra.expected_hash;
      } else if (e instanceof LeaseLost) {
        // fencing refused the next write: nothing more was sent. An earlier write of this run may have landed → unknown.
        const wrote = R.calls.some(c => A.WRITE_METHODS.includes(c.op) && c.applied !== 'no');
        res = { outcome: wrote ? 'unknown' : 'retry', effects: targetOf(ctx),
          error: { kind: 'lease_lost', code: 'lease_lost', message: 'write not sent: ' + e.message, http_status: null } };
      } else {
        const m = mapAdapterError(A, e);
        res = { outcome: m.outcome, error: m.error, effects: targetOf(ctx) };
      }
    }
    const out = { outcome: res.outcome, calls: boundCalls(R.calls), effects: redact(res.effects || {}) };
    // the probe's capability record is keyed by the fixed CAPABILITY_KEYS (SQL re-validates every key and value);
    // redaction would drop 'invoices.version_token' (it contains "token"), so it is rebuilt from the fixed list only
    if (res.effects && res.effects.capabilities && typeof res.effects.capabilities === 'object') {
      const caps = {};
      for (const k of A.CAPABILITY_KEYS) {
        const v = res.effects.capabilities[k];
        if (v && typeof v === 'object') caps[k] = { supported: v.supported === true, evidence: v.evidence == null ? null : String(v.evidence).slice(0, 300) };
      }
      out.effects.capabilities = caps;
    }
    if (res.error) out.error = res.error;
    if (res.expected_hash) out.expected_hash = res.expected_hash;
    if (out.outcome !== 'ok' && out.outcome !== 'frozen' && out.effects && Object.keys(out.effects).length === 0) out.effects = targetOf(ctx);
    return out;
  }

  function createWorker(cfg) {
    const c = cfg || {};
    if (typeof c.rpc !== 'function') throw new Error('createWorker: rpc required');
    if (typeof c.adapterFor !== 'function') throw new Error('createWorker: adapterFor required');
    const A = c.deps;
    if (!A || typeof A.canonicalInvoice !== 'function') throw new Error('createWorker: deps (adapter API) required');
    const workerId = String(c.workerId || 'daftra-sync').slice(0, 80);
    const clock = typeof c.clock === 'function' ? c.clock : () => new Date().toISOString();

    async function runOnce(o) {
      const limit = Math.max(1, Math.min(20, (o && o.limit) || 5));
      const counts = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, frozen: 0, errors: 0, results: [] };
      const ctxs = (await c.rpc('daftra_claim_jobs', { p_worker: workerId, p_limit: limit })) || [];
      counts.claimed = ctxs.length;
      for (const ctx of ctxs) {
        let result;
        try {
          const adapter = await c.adapterFor(ctx.connection || {}, ctx.job.org_id);
          // write fencing: the lease is renewed (and checked) right before every adapter write
          const beforeWrite = c.fenceWrites === false ? null : () => c.rpc('daftra_renew_lease', { p_attempt: ctx.attempt_id });
          result = await runJob(ctx, adapter, { deps: A, clock, beforeWrite, callTimeoutMs: c.callTimeoutMs });
        } catch (e) {
          const m = mapAdapterError(A, e);
          result = { outcome: m.outcome, error: m.error, calls: [], effects: targetOf(ctx) };
        }
        // host hook before the completion (index.ts persists the DB-backed mock account here, per job)
        if (typeof c.beforeComplete === 'function') {
          try { result = (await c.beforeComplete(ctx, result)) || result; }
          catch (e) { result = { outcome: 'retry', calls: result.calls || [], effects: targetOf(ctx),
            error: { kind: 'worker', code: 'before_complete', message: String((e && e.message) || e).slice(0, 500), http_status: null } }; }
        }
        try {
          const done = await c.rpc('daftra_complete_job', { p_attempt: ctx.attempt_id, p_result: result });
          counts[result.outcome] = (counts[result.outcome] || 0) + 1;
          counts.results.push({ job_id: ctx.job.id, kind: ctx.job.kind, org_id: ctx.job.org_id, outcome: result.outcome, job_status: done && done.job_status, applied: done && done.applied });
        } catch (e) {
          counts.errors++;
          counts.results.push({ job_id: ctx.job.id, kind: ctx.job.kind, org_id: ctx.job.org_id, outcome: result.outcome, complete_error: String((e && e.message) || e).slice(0, 300) });
        }
      }
      return counts;
    }
    return { runOnce, workerId };
  }

  const API = { createWorker, runJob, redactCalls: redact, scrubText };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

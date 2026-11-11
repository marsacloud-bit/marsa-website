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

  Legacy port step 7 (docs/online/LEGACY_DAFTRA_AR.md «عقد المهام»), on top:
    - KSA account guard: a write kind (invoice_push, purchase_push, client_ensure, client_push, item_ensure) whose
      connection.account is not a checked KSA account (SAR, Saudi Arabia, an active 15 % VAT) fails 'account_not_ksa'
      before ANY adapter call (fail closed: no account → refused);
    - write policy (connection.policy, fail closed): allow_draft_update !== true (HF5) → updateDraftInvoice is never
      sent (the recorder refuses it: draft_update_disabled) and an existing draft is never changed; allow_product_create
      !== true → products are resolved by code without leading zeros (000186 = 186) and createProduct is never sent;
      a read-only kind can send no write at all;
    - invoice_push: required custom fields missing → custom_required, an inactive / Daftra-suspended client →
      client_inactive / client_suspended, before any write; the new draft carries the Riyadh invoice date, po_number,
      the CustomModel custom fields and the opening zero line; it is read back (date / client / total / line count →
      read_back) and its https view URL is reported;
    - the new kinds product_match, client_import, invoice_lookup, legacy_scan, supplier_search (GET only) and
      purchase_push (a new zero-tax purchase draft, looked up by reference first).
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
  // review: the account read again right before the first write is not KSA (nothing was sent)
  class AccountBlocked extends Error { constructor(r) { super('account not KSA: ' + r); this.reason = r; } }

  // records every adapter call as {op, at, ms, request, response, error, applied};
  // opts.beforeWrite(op) runs right before every WRITE (lease renewal); a failure there sends nothing
  // step 7: opts.policy (A.writePolicy) refuses updateDraftInvoice under HF5 and createProduct under resolve-only, and
  // opts.readOnly refuses every write, BEFORE anything is sent (logged with applied 'no')
  function recorder(adapter, A, clock, opts) {
    const o = opts || {};
    const calls = [];
    const rec = {};
    const timeoutMs = o.callTimeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : o.callTimeoutMs;
    const pol = o.policy || null;
    let gated = false;
    const refusal = op => {
      if (o.readOnly && A.WRITE_METHODS.includes(op)) return ['read_only_kind', 'a read-only job never writes to Daftra'];
      if (pol && op === 'updateDraftInvoice' && !pol.allow_draft_update) return ['draft_update_disabled', 'editing an existing Daftra draft is not allowed (HF5): change it by hand in Daftra'];
      if (pol && op === 'createProduct' && !pol.allow_product_create) return ['product_create_disabled', 'Marsa never creates Daftra products: map the product code'];
      return null;
    };
    for (const op of A.ADAPTER_METHODS) {
      rec[op] = async function (...args) {
        const no = refusal(op);
        if (no) {
          const e = new A.AdapterError('validation', no[1], { applied: 'no', code: no[0] });
          calls.push({ op, at: clock(), ms: 0, request: null, response: null, error: errJson(e), applied: 'no' });
          throw e;
        }
        // review: opts.accountGate() (a live account) re-reads the account profile ONCE, right before the first write of the job
        if (A.WRITE_METHODS.includes(op) && typeof o.accountGate === 'function' && !gated) {
          gated = true;
          const why = await o.accountGate(rec);
          if (why) throw new AccountBlocked(why);
        }
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
    async function ensureItem(R, it, opts) {
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
      if (opts && opts.noCreate) {
        // step 7 resolve-only: Marsa never creates Daftra products (the code is mapped by a human: save_daftra_product_code)
        throw new Outcome('failed', { item_link_id: it.link_id }, { kind: 'validation', code: 'product_create_disabled',
          message: 'no Daftra product for this item and Marsa never creates products (fields: ' + it.item_key + ')', http_status: null });
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

    // the Marsa-intended remote line of a local line. Step 7: a line with a Daftra description rule (daftra_description: the
    // TAS number only for an appointment fee, empty for the clearance line) names its product in Daftra's item field
    // (legacy: item = product name, description = TAS / empty): item_name + daftra_description go to the adapter, and its
    // canonical description is the product name (what the item field reads back as, mock and live alike)
    function marsaLine(l, productOf) {
      const named = l.item_name !== undefined && l.item_name !== null && l.item_name !== '';
      const out = { line_ref: l.line_ref, product_id: productOf(l.item_key), description: named ? l.item_name : l.description,
        quantity: A.fixed(l.quantity, 3), unit_price: A.fixed(l.unit_price, 2), tax_rate: A.fixed(l.vat_rate, 2) };
      if (named) { out.item_name = l.item_name; out.daftra_description = l.daftra_description; }
      return out;
    }
    // the intent with its lines' item_name (the item's Arabic name) where a Daftra description rule applies
    function withNames(it) {
      if (!it || !Array.isArray(it.lines)) return it;
      const names = new Map((it.items || []).map(x => [x.item_key, x.name_ar || null]));
      return Object.assign({}, it, { lines: it.lines.map(l => (l && l.daftra_description !== undefined && l.daftra_description !== null && names.get(l.item_key))
        ? Object.assign({}, l, { item_name: names.get(l.item_key) }) : l) });
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

    async function pushOk(it, back, foundBy, inline, extra) {
      const h = await A.invoiceHash(back);
      const e = {
        intent_id: it.id, external_invoice_id: String(back.id), found_by: foundBy, daftra_status: String(back.status || '').slice(0, 40),
        remote_state: A.remoteState(back.status), daftra_number: back.number || null, remote_version: back.version === undefined || back.version === null ? null : String(back.version),
        remote_hash: h, pushed_hash: h, remote_snapshot: invoiceSnapshot(back), remote_totals: remoteTotals(back),
        line_results: lineResults(it, back), clients: inline.clients, items: inline.items
      };
      if (e.daftra_number === null) delete e.daftra_number;
      if (e.remote_version === null) delete e.remote_version;
      // step 7: the Daftra view link (https only) and, for a draft just created, what Daftra stored (date / client / total / lines)
      const url = urlOf(back);
      if (url) e.daftra_url = url;
      if (extra && extra.readBack) {
        e.read_back = { date: A.normalizeDate(back.date), client_id: back.client_id === undefined || back.client_id === null ? null : String(back.client_id),
          total: remoteTotals(back).total, line_count: (back.lines || []).length };
      }
      return e;
    }
    const urlOf = x => (x && typeof x.url === 'string' && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9_./?=&%-]*)?$/.test(x.url) && x.url.length <= 500) ? x.url : null;

    /* ---------------------------------------------------------------- step 7 helpers */
    const failed = (base, code, message, fields) => new Outcome('failed', base || {},
      { kind: 'validation', code, message: message + (fields && fields.length ? ' (fields: ' + fields.join(', ') + ')' : ''), http_status: null });

    // a product by its configured code, compared without leading zeros (legacy resolveDaftraProductByCode_); never created.
    // → {external_product_id}; failed unmapped_product (no code) / product_not_found (none); conflict item_review (several)
    async function resolveItem(R, item, base) {
      if (!item) throw failed(base, 'unmapped_product', 'no Daftra product mapping in context');
      if (item.external_product_id && item.status === 'linked') return String(item.external_product_id);
      const code = item.remote_product_code;
      if (!code || !A.codeNorm(code)) throw failed(base, 'unmapped_product', 'service item without a confirmed Daftra product code', [item.item_key]);
      const n = A.codeNorm(code);
      const hits = ((await R.findProductsByCodeNorm(code)) || []).filter(p => p && p.id && A.codeNorm(p.code) === n);
      if (hits.length === 1) return String(hits[0].id);
      if (!hits.length) throw failed(base, 'product_not_found', 'no Daftra product with the configured code', [String(code)]);
      throw new Outcome('conflict', Object.assign({}, base, { reason: 'item_review', items: [{ item_link_id: item.link_id,
        candidates: hits.slice(0, 10).map(candidateProduct) }] }),
        { kind: 'conflict', code: 'item_review', message: 'several Daftra products carry the configured code', http_status: null });
    }
    // the Daftra client of a new draft must not be suspended (legacy verifyDaftraClientForInvoice_)
    async function checkClientActive(R, ext, base) {
      let c;
      try { c = await R.getClient(ext); }
      catch (e) {
        if (A.isAdapterError(e) && e.kind === 'not_found') throw failed(base, 'client_not_linked', 'the linked Daftra client does not exist');
        throw e;
      }
      if (c && c.id !== undefined && c.id !== null && String(c.id) !== String(ext)) throw failed(base, 'client_not_linked', 'Daftra answered another client');
      if (c && c.suspended === true) throw failed(base, 'client_suspended', 'the Daftra client is suspended');
    }
    // the invoice date: the Riyadh date the claim pinned (billing_intents.invoice_date = app.rpt_today()), else today in
    // Asia/Riyadh from the worker clock (Intl) — never UTC, never the host zone
    function invoiceDate(it, clock, conn) {
      return A.normalizeDate(it && it.invoice_date) || A.normalizeDate(conn && conn.today) || A.riyadhDate(clock());
    }
    // the custom fields of the draft: {payload, dateKeys} from intent.custom_fields (app.daftra_custom_fields)
    function customOf(it) {
      const cf = it && it.custom_fields && typeof it.custom_fields === 'object' ? it.custom_fields : null;
      if (!cf) return { payload: null, dateKeys: [] };
      const payload = cf.payload && typeof cf.payload === 'object' && !Array.isArray(cf.payload) ? cf.payload : {};
      const dateKeys = (Array.isArray(cf.fields) ? cf.fields : []).filter(f => f && f.name === 'declaration_date' && f.key).map(f => String(f.key));
      return { payload, dateKeys };
    }

    async function invoicePush(R, ctx, env) {
      const it = withNames(ctx.intent);
      const job = ctx.job || {};
      const opt = job.options || {};
      const pol = (env && env.policy) || A.writePolicy(null);
      const hf5 = !pol.allow_draft_update;
      const resolveOnly = !pol.allow_product_create;
      const clock = (env && env.clock) || (() => new Date().toISOString());
      if (!it) throw new Outcome('failed', {}, { kind: 'validation', code: 'intent', message: 'no intent in context', http_status: null });
      const inline = { clients: [], items: [] };
      const base = { intent_id: it.id };
      if (it.status === 'issued' || it.status === 'cancelled') {
        throw new Outcome('failed', base, { kind: 'validation', code: 'intent_' + it.status, message: 'intent is ' + it.status, http_status: null });
      }
      // step 7, before any call: required custom fields, the Marsa client, the opening's linked client
      const cf = it.custom_fields && typeof it.custom_fields === 'object' ? it.custom_fields : null;
      if (cf && Array.isArray(cf.missing) && cf.missing.length) {
        throw failed(base, 'custom_required', 'required Daftra custom fields have no value; nothing was sent', cf.missing.map(String).slice(0, 20));
      }
      if (it.client && it.client.active === false) throw failed(base, 'client_inactive', 'the client is inactive in Marsa; nothing was sent');
      const opening = it.origin === 'opening' || opt.opening === true;
      if (opening && !(it.client && it.client.external_id && LINKED.includes(it.client.status))) {
        throw failed(base, 'client_not_linked', 'an opening draft needs a client linked to Daftra');
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
      const names = {};
      for (const item of it.items || []) {
        names[item.item_key] = item.name_ar || null;
        if (item.external_product_id && item.status === 'linked') { productIds[item.item_key] = String(item.external_product_id); continue; }
        if (resolveOnly) { productIds[item.item_key] = await resolveItem(R, item, base); continue; }
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
        if (!productIds[k]) throw failed(Object.assign({}, base, inline), resolveOnly ? 'unmapped_product' : 'item_unmapped', 'no Daftra product for an item', [k]);
        return productIds[k];
      };
      const nameOf = k => names[k] || null;
      const itc = Object.assign({}, it, { client: Object.assign({}, it.client || {}, { external_id: clientExt }) });
      const safeProductOf = k => productIds[k] || null;
      const dcx = { it: itc, productOf: safeProductOf };

      // 2. identity: reference lookup before every create (first push, retry, reconcile, recreate)
      const reference = it.po_number || it.operational_ref;
      let extId = opt.recreate ? null : (it.external_invoice_id || null);
      let foundBy = 'existing';
      if (job.previous_status === 'unknown' || !extId) {
        const hits = (await R.findInvoiceByReference(reference)) || [];
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
          // 0 hits: create the draft with every pending_add + synced line (+ the opening zero line)
          const lines = (it.lines || []).filter(l => (l.state === 'pending_add' || l.state === 'synced') && !l.manual_in_daftra)
            .map(l => marsaLine(l, productOf));
          const ol = it.opening_line && typeof it.opening_line === 'object' ? it.opening_line : null;
          if (ol) {
            const on = nameOf(ol.item_key);
            lines.push({ line_ref: null, product_id: productOf(ol.item_key), description: on || '', item_name: on || null,
              daftra_description: ol.description === undefined || ol.description === null ? '' : String(ol.description), quantity: A.fixed(ol.quantity === undefined ? 1 : ol.quantity, 3), unit_price: A.fixed(ol.unit_price || 0, 2),
              tax_rate: A.fixed(ol.vat_rate === undefined || ol.vat_rate === null ? 15 : ol.vat_rate, 2) });
          }
          if (!lines.length) throw failed(base, 'validation', 'nothing to put on the draft', ['lines']);
          // the Daftra client of a new draft must exist and not be suspended (a client created just now is fresh)
          if (!inline.clients.some(c => c.found_by === 'created')) await checkClientActive(R, clientExt, base);
          const cm = customOf(it);
          const payload = { reference, client_id: clientExt, currency: it.currency, date: invoiceDate(it, clock, ctx.connection), notes: it.notes || null, lines };
          if (cm.payload && Object.keys(cm.payload).length) { payload.custom_fields = cm.payload; payload.custom_date_keys = cm.dateKeys; }
          const expected = await A.contentHash(A.canonicalInvoice(payload));
          let created;
          try { created = await R.createDraftInvoice(payload); }
          catch (e) {
            if (A.isAdapterError(e) && e.applied === 'unknown') throw new Outcome('unknown', Object.assign({}, base, inline), errJson(e), { expected_hash: expected });
            throw e;
          }
          const back = await R.getInvoice(created.id);
          if (!back.url && created.url) back.url = created.url;
          return { outcome: 'ok', effects: await pushOk(itc, back, 'created', inline, { readBack: true }) };
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
      if (hf5) {
        // HF5 (allow_draft_update false): an existing draft is NEVER changed by Marsa. A draft found by reference (a lost
        // create) is adopted as it is; the lines still missing on it become the manual_in_daftra review item in SQL.
        if (foundBy === 'ref' || (job.expected_hash && rh === job.expected_hash)) {
          return { outcome: 'ok', effects: await pushOk(itc, remote, foundBy, inline) };
        }
        const d0 = mergeLines(itc, remote, safeProductOf, false);
        const same = (await A.contentHash(A.canonicalInvoice({ client_id: remote.client_id, currency: remote.currency, lines: d0 }))) === rh;
        if (same) return { outcome: 'ok', effects: await pushOk(itc, remote, foundBy, inline) };
        throw failed(Object.assign({}, base, inline, { external_invoice_id: String(extId) }), 'draft_update_disabled',
          'the Daftra draft exists and editing it is not allowed (HF5): change it by hand in Daftra; nothing was sent');
      }
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
      const it = withNames(ctx.intent);
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
      // step 7: the Daftra client of the invoice (client_mismatch in SQL when it is not the linked one)
      if (inv.client_id !== undefined && inv.client_id !== null && String(inv.client_id) !== '') e.remote_client_id = String(inv.client_id);
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

    async function itemJob(R, ctx, env) {
      const it = ctx.item;
      if (!it) throw new Outcome('failed', {}, { kind: 'validation', code: 'item', message: 'no item in context', http_status: null });
      const pol = (env && env.policy) || A.writePolicy(null);
      const e = await ensureItem(R, Object.assign({}, it, { status: 'pending' }), { noCreate: !pol.allow_product_create });
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

    /* ================================================================ step 7 kinds (read-only, except purchase_push) */
    const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const cut = (v, n) => { if (v === null || v === undefined) return null; const t = String(v).replace(/\s+/g, ' ').trim(); return t === '' ? null : t.slice(0, n); };
    const idSeq = id => Number(String(id === null || id === undefined ? '' : id).replace(/^\D+/, '')) || 0;
    const hasArabic = t => /[؀-ۿ]/.test(String(t || ''));
    const runOf = ctx => (ctx && ctx.run && typeof ctx.run === 'object') ? ctx.run : {};
    const keyOf = (map, name) => {
      const f = map && map.fields && map.fields[name];
      return f && typeof f === 'object' && typeof f.key === 'string' && A.CUSTOM_KEY_RE.test(f.key) ? f.key : null;
    };
    const fieldText = v => Array.isArray(v) ? v.map(x => (x === null || x === undefined ? '' : String(x))).filter(Boolean).join('، ') : (v === null || v === undefined ? '' : String(v));
    // the composite keys of a Daftra invoice from its custom fields (the org's custom_field_map keys)
    function fieldsOf(inv, map) {
      const cf = inv && inv.custom_fields && typeof inv.custom_fields === 'object' ? inv.custom_fields : {};
      const val = name => { const k = keyOf(map, name); return k && cf[k] !== undefined ? cut(fieldText(cf[k]), 1000) : null; };
      const ctr = val('containers');
      const f = { declaration_no: cut(val('declaration_no'), 60), bl: cut(val('bl'), 80) };
      if (ctr) f.containers = A.containerSet(ctr);
      return f;
    }
    const hasFields = (inv, map) => {
      const cf = inv && inv.custom_fields && typeof inv.custom_fields === 'object' ? inv.custom_fields : {};
      return ['declaration_no', 'bl', 'containers'].some(n => { const k = keyOf(map, n); return k && cf[k] !== undefined && fieldText(cf[k]) !== ''; });
    };
    function invoiceRow(inv, map) {
      const t = (inv && inv.totals) || {};
      return {
        external_invoice_id: String(inv.id), daftra_number: cut(inv.number, 60), daftra_status: cut(inv.status, 40), remote_state: A.remoteState(inv.status),
        date: A.normalizeDate(inv.date), currency: inv.currency && /^[A-Za-z]{3}$/.test(String(inv.currency)) ? String(inv.currency).toUpperCase() : null,
        total: t.total === undefined || t.total === null ? null : A.money(t.total),
        client_id: inv.client_id === undefined || inv.client_id === null || inv.client_id === '' ? null : cut(inv.client_id, 64),
        client_name: cut(inv.client_name, 300), po_number: cut(inv.reference, 80), fields: fieldsOf(inv, map)
      };
    }
    // a listing row without its custom fields is read in full (GET invoices/{id}), within a per-job budget
    async function withFields(R, inv, map, budget) {
      if (hasFields(inv, map) || budget.left <= 0) return inv;
      budget.left--;
      try {
        const full = await R.getInvoice(inv.id);
        return Object.assign({}, inv, { custom_fields: full.custom_fields || {}, client_id: full.client_id === undefined ? inv.client_id : full.client_id,
          client_name: inv.client_name || full.client_name || null, totals: inv.totals || full.totals });
      } catch (e) {
        if (A.isAdapterError(e) && e.kind === 'not_found') return inv;
        throw e;
      }
    }

    // product_match: the configured codes against the Daftra products (zero-insensitive), name hits for the others; nothing linked
    async function productMatchJob(R, ctx) {
      const run = runOf(ctx);
      const prods = Array.isArray(ctx.products) ? ctx.products : [];
      const size = clamp(run.page_size, 20, 500, 100);
      const pages = clamp(run.pages_per_job, 1, 10, 5);
      const remote = [];
      let complete = false;
      for (let p = 1; p <= pages; p++) {
        const r = (await R.listProducts({ page: p, limit: size })) || {};
        const items = Array.isArray(r.items) ? r.items : [];
        remote.push(...items);
        if (!items.length || !r.more) { complete = true; break; }
      }
      let targeted = 0;
      const out = [];
      for (const pr of prods.slice(0, 500)) {
        const n = A.codeNorm(pr.remote_product_code);
        let hits = n ? remote.filter(x => A.codeNorm(x.code) === n) : [];
        if (n && !hits.length && !complete && targeted < 30) {
          targeted++;
          hits = ((await R.findProductsByCodeNorm(pr.remote_product_code)) || []).filter(x => A.codeNorm(x.code) === n);
        }
        const nm = A.normalizeName(pr.name_ar);
        const byName = nm ? remote.filter(x => !hits.includes(x) && (A.normalizeName(x.name_ar) === nm || (x.name_en && A.normalizeName(x.name_en) === nm))) : [];
        const seen = new Set();
        const cands = hits.concat(byName).filter(x => x && x.id && !seen.has(String(x.id)) && seen.add(String(x.id))).slice(0, 10)
          .map(x => ({ external_product_id: cut(x.id, 64), code: cut(x.code, 40), name: cut(x.name_ar, 300) }));
        out.push({ item_key: pr.item_key, candidates: cands });
      }
      return { outcome: 'ok', effects: { run_id: run.id, scanned: remote.length, products: out } };
    }

    // client_import: GET client pages from the run cursor (never a write, never a delete); next_cursor schedules the rest
    function importRow(c) {
      const primary = cut(c.name, 300);
      const secondary = cut(c.secondary_name, 300);
      let name = primary || secondary, en = null;
      if (hasArabic(primary)) { name = primary; if (secondary && !hasArabic(secondary)) en = secondary; }
      else if (hasArabic(secondary)) { name = secondary; en = primary; }
      else if (secondary && secondary !== name) en = secondary;
      return { external_id: cut(c.id, 64), client_number: cut(c.ref, 40), name: cut(name, 160), name_en: cut(en || c.name_en, 160),
        vat_number: cut(c.vat_number, 40), cr_number: cut(c.cr_number, 40), phone: cut(c.phone, 40), email: cut(c.email, 160), city: cut(c.city, 80),
        suspended: c.suspended === true };
    }
    async function clientImportJob(R, ctx) {
      const run = runOf(ctx);
      const cur = run.cursor && typeof run.cursor === 'object' ? run.cursor : {};
      const size = clamp(run.page_size, 1, 500, 100);
      const pages = clamp(run.pages_per_job, 1, Math.max(1, Math.floor(500 / size)), 5);
      let page = clamp(cur.page, 1, 100000, 1);
      const rows = [];
      let next = null;
      for (let i = 0; i < pages; i++) {
        const r = (await R.listClients({ page, limit: size })) || {};
        const items = Array.isArray(r.items) ? r.items : [];
        for (const c of items) if (c && c.id !== undefined && c.id !== null) rows.push(importRow(c));
        if (!items.length || !r.more) { next = null; break; }     // the end (an empty page ends the run: 0 rows in all → aborted in SQL)
        page++;
        next = { page };
      }
      return { outcome: 'ok', effects: { run_id: run.id, rows: rows.slice(0, 500), next_cursor: next } };
    }

    // invoice_lookup: by number, or the composite candidates (declaration keywords + the client's invoices); SQL decides
    async function invoiceLookupJob(R, ctx) {
      const t = ctx.transaction || {};
      const lk = ctx.lookup || {};
      const map = (ctx.connection && ctx.connection.custom_field_map) || {};
      const budget = { left: 40 };
      const base = { transaction_id: t.id };
      let heads = [];
      if (lk.mode === 'composite') {
        const byId = new Map();
        const add = list => { for (const h of list || []) if (h && h.id !== undefined && h.id !== null && !byId.has(String(h.id))) byId.set(String(h.id), h); };
        for (const d of (Array.isArray(t.declaration_nos) ? t.declaration_nos : []).slice(0, 5)) {
          if (!cut(d, 60)) continue;
          add(((await R.listInvoices({ keywords: d, page: 1, limit: 50, direction: 'DESC' })) || {}).items);
        }
        if (t.client_external_id) {
          for (let p = 1; p <= 2; p++) {
            const r = (await R.listInvoices({ client_id: t.client_external_id, page: p, limit: 100, direction: 'DESC' })) || {};
            add(r.items);
            if (!r.more) break;
          }
        }
        heads = Array.from(byId.values());
      } else {
        if (!cut(lk.number, 60)) throw failed(base, 'validation', 'an invoice number is needed', ['number']);
        heads = ((await R.findInvoicesByNumber(lk.number)) || []).slice(0, 10);
      }
      const norm = v => String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const decl = new Set((t.declaration_nos || []).map(norm).filter(Boolean));
      const bls = new Set((t.bl_numbers || []).map(norm).filter(Boolean));
      const ctrs = new Set((t.containers || []).map(norm).filter(Boolean));
      const score = r => (r.fields.declaration_no && decl.has(norm(r.fields.declaration_no)) ? 1 : 0) + (r.fields.bl && bls.has(norm(r.fields.bl)) ? 1 : 0)
        + ((r.fields.containers || []).some(c => ctrs.has(norm(c))) ? 1 : 0);
      const rows = [];
      for (const h of heads) {
        const full = await withFields(R, h, map, budget);
        rows.push(invoiceRow(full, map));
      }
      const out = lk.mode === 'composite' ? rows.filter(r => score(r) > 0).sort((a, b) => score(b) - score(a)) : rows;
      return { outcome: 'ok', effects: { transaction_id: t.id, invoices: out.slice(0, 50) } };
    }

    // legacy_scan: one resumable batch of older invoices (id ascending, GET only); the cursor {page, last_id} resumes it
    async function legacyScanJob(R, ctx) {
      const run = runOf(ctx);
      const map = (ctx.connection && ctx.connection.custom_field_map) || {};
      const cur = run.cursor && typeof run.cursor === 'object' ? run.cursor : {};
      const size = clamp(run.page_size, 1, 500, 100);
      const pages = clamp(run.pages_per_job, 1, Math.max(1, Math.floor(500 / size)), 5);
      const budget = { left: 40 };
      let page = clamp(cur.page, 1, 1000000, 1);
      let lastId = cur.last_id === undefined || cur.last_id === null ? null : String(cur.last_id);
      const out = [];
      let next = null;
      let ended = false;
      for (let i = 0; i < pages && !ended; i++) {
        const r = (await R.listInvoices({ page, limit: size, direction: 'ASC' })) || {};
        const items = Array.isArray(r.items) ? r.items : [];
        let stopped = false;
        for (const h of items) {
          if (!h || h.id === undefined || h.id === null) continue;
          if (lastId !== null && idSeq(h.id) <= idSeq(lastId)) continue;            // already reported by an earlier batch
          if (!hasFields(h, map) && budget.left <= 0) { stopped = true; break; }       // the detail budget is spent: resume here
          out.push(invoiceRow(await withFields(R, h, map, budget), map));
          lastId = String(h.id);
        }
        if (stopped) { next = { page, last_id: lastId }; ended = true; break; }
        if (!items.length || !r.more) { next = null; ended = true; break; }
        page++;
        next = { page, last_id: lastId };
      }
      if (next && next.last_id === null) delete next.last_id;
      return { outcome: 'ok', effects: { run_id: run.id, invoices: out.slice(0, 500), next_cursor: next } };
    }

    // supplier_search: GET suppliers by name (a suspended supplier is never offered); SQL links only a unique exact name
    async function supplierSearchJob(R, ctx) {
      const run = runOf(ctx);
      const q = cut(run.params && run.params.q, 120);
      if (!q) throw failed({ run_id: run.id }, 'validation', 'a supplier name is needed', ['q']);
      const list = ((await R.searchSuppliers(q)) || []).filter(x => x && x.id !== undefined && x.id !== null && cut(x.name, 300) && x.suspended !== true);
      const seen = new Set();
      const suppliers = list.filter(x => !seen.has(String(x.id)) && seen.add(String(x.id))).slice(0, 50)
        .map(x => { const o = { external_supplier_id: cut(x.id, 64), name: cut(x.name, 300), supplier_number: cut(x.supplier_number, 60) };
          if (cut(x.secondary_name, 300)) o.secondary_name = cut(x.secondary_name, 300);      // review: legacy exact match on the secondary name too
          return o; });
      return { outcome: 'ok', effects: { run_id: run.id, suppliers } };
    }

    // purchase_push: ONE new zero-tax purchase draft per trip (legacy ensureMovementPurchaseDraftR12_): a known id is only
    // read, never re-created; the reference is looked up first; the id is reported as soon as it is known
    async function purchasePush(R, ctx, env) {
      const p = ctx.purchase;
      const job = ctx.job || {};
      const clock = (env && env.clock) || (() => new Date().toISOString());
      if (!p) throw new Outcome('failed', {}, { kind: 'validation', code: 'purchase', message: 'no purchase in context', http_status: null });
      const base = { purchase_id: p.id };
      if (p.status === 'cancelled') throw failed(base, 'validation', 'the purchase draft is cancelled', ['status']);
      if (!p.supplier_external_id) throw failed(base, 'supplier_not_linked', 'the transport party is not linked to a Daftra supplier');
      const viewOk = (x, by) => {
        const e = { purchase_id: p.id, external_purchase_id: String(x.id), found_by: by };
        if (x.number) e.daftra_number = cut(x.number, 60);
        const url = urlOf(x);
        if (url) e.daftra_url = url;
        return e;
      };
      if (p.external_purchase_id) {
        let x;
        try { x = await R.getPurchase(p.external_purchase_id); }
        catch (e) {
          if (A.isAdapterError(e) && e.kind === 'not_found') throw failed(Object.assign({}, base, { external_purchase_id: String(p.external_purchase_id) }), 'not_found',
            'the saved Daftra purchase draft is missing; no second draft is created');
          throw e;
        }
        return { outcome: 'ok', effects: viewOk(x, 'ref') };
      }
      if (!cut(p.reference, 80)) throw failed(base, 'validation', 'purchase reference missing', ['reference']);
      const item = p.item && typeof p.item === 'object' ? p.item : null;
      const productId = await resolveItem(R, item, base);
      const look = (await R.findPurchaseByReference(p.reference)) || { hits: [], complete: false };
      const hits = Array.isArray(look.hits) ? look.hits : [];
      if (hits.length === 1) return { outcome: 'ok', effects: viewOk(hits[0], 'ref') };
      if (hits.length > 1) {
        throw new Outcome('conflict', Object.assign({}, base, { external_ids: hits.map(h => String(h.id)).slice(0, 10) }),
          { kind: 'conflict', code: 'reference_conflict', message: 'several Daftra purchase drafts carry this reference', http_status: null });
      }
      if (!look.complete && job.previous_status === 'unknown') {
        throw failed(base, 'reference_lookup_incomplete', 'cannot prove that no purchase draft carries this reference; nothing was sent');
      }
      const lines = (Array.isArray(p.lines) ? p.lines : []).map(l => ({ product_id: productId, item_name: (item && item.name_ar) || null,
        description: cut(l.description, 900) || '', quantity: A.fixed(l.quantity === undefined ? 1 : l.quantity, 3), unit_price: A.fixed(l.unit_price, 2), tax_rate: '0.00' }));
      if (!lines.length || lines.some(l => !(Number(l.unit_price) > 0))) throw failed(base, 'validation', 'the trip cost is not a positive amount', ['amount']);
      const payload = { reference: p.reference, supplier_id: String(p.supplier_external_id), currency: p.currency || 'SAR',
        date: A.normalizeDate(p.invoice_date) || A.riyadhDate(clock()), lines };
      let created;
      try { created = await R.createPurchaseDraft(payload); }
      catch (e) {
        if (A.isAdapterError(e) && e.applied === 'unknown') {
          const eff = Object.assign({}, base);
          if (e.external_id) eff.external_purchase_id = String(e.external_id);
          throw new Outcome('unknown', eff, errJson(e));
        }
        throw e;
      }
      let back = created, unread = false;
      try { back = Object.assign({}, created, await R.getPurchase(created.id)); } catch (_) { back = created; unread = true; }   // the id is kept even if the read fails
      // review (legacy re-read after the POST): Daftra applied a tax, or the record is no longer a draft → flagged for a human
      const eff = viewOk(back, 'created');
      eff.checks = { tax_nonzero: back.tax_nonzero === true, not_draft: !unread && !!back.status && back.status !== 'draft', unread };
      return { outcome: 'ok', effects: eff };
    }

    return { ensureClient, ensureItem, invoicePush, invoicePull, clientJob, itemJob, probeJob,
      productMatchJob, clientImportJob, invoiceLookupJob, legacyScanJob, supplierSearchJob, purchasePush };
  }

  // target effects for an error outcome (so completion stamps last_error_* on the right row)
  function targetOf(ctx) {
    const k = ctx && ctx.job && ctx.job.kind;
    if (k === 'invoice_push' || k === 'invoice_pull') return ctx.intent ? { intent_id: ctx.intent.id } : {};
    if (k && k.startsWith('client_')) return ctx.client ? { client_link_id: ctx.client.link_id } : {};
    if (k === 'item_ensure') return ctx.item ? { item_link_id: ctx.item.link_id } : {};
    if (k === 'purchase_push') return ctx.purchase ? { purchase_id: ctx.purchase.id } : {};
    if (k === 'invoice_lookup') return ctx.transaction ? { transaction_id: ctx.transaction.id } : {};
    if (['product_match', 'client_import', 'legacy_scan', 'supplier_search'].includes(k)) return ctx.run ? { run_id: ctx.run.id } : {};
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
    const kind = ctx && ctx.job && ctx.job.kind;
    const conn = (ctx && ctx.connection) || {};
    // step 7: the org's write policy (fail closed) and the read-only kinds, enforced on every adapter call
    const policy = A.writePolicy(conn.policy);
    // review: a live (enforced) account is read again right before the first write (GET site_info + taxes, read only): the
    // probe's cached profile may be stale (the account switched back to Egypt after the last probe); fail closed on any doubt
    const enforced = A.WRITE_KINDS.includes(kind) && conn.account && conn.account.enforced === true;
    const R = recorder(adapter, A, clock, { beforeWrite: o.beforeWrite, callTimeoutMs: o.callTimeoutMs, policy,
      readOnly: !A.WRITE_KINDS.includes(kind),
      accountGate: enforced ? async rec => A.accountCheck(await rec.getAccountProfile()) : null });
    const K = makeCtx(A);
    const env = { policy, clock };
    let res;
    try {
      // step 7: the KSA account guard before ANY call of a write kind (the Daftra account must be SAR / Saudi Arabia / 15 %)
      const acc = A.WRITE_KINDS.includes(kind) ? A.ksaBlock(conn.account) : null;
      if (acc) {
        res = { outcome: 'failed', effects: targetOf(ctx), error: { kind: 'validation', code: 'account_not_ksa',
          message: 'the Daftra account is not a KSA account (SAR, Saudi Arabia, 15 % VAT); nothing was sent (fields: ' + acc + ')', http_status: null } };
      }
      else if (kind === 'probe') res = await K.probeJob(R.api);
      else if (kind === 'invoice_push') res = await K.invoicePush(R.api, ctx, env);
      else if (kind === 'invoice_pull') res = await K.invoicePull(R.api, ctx);
      else if (kind === 'client_ensure' || kind === 'client_refresh' || kind === 'client_push') res = await K.clientJob(R.api, ctx);
      else if (kind === 'item_ensure') res = await K.itemJob(R.api, ctx, env);
      else if (kind === 'product_match') res = await K.productMatchJob(R.api, ctx);
      else if (kind === 'client_import') res = await K.clientImportJob(R.api, ctx);
      else if (kind === 'invoice_lookup') res = await K.invoiceLookupJob(R.api, ctx);
      else if (kind === 'legacy_scan') res = await K.legacyScanJob(R.api, ctx);
      else if (kind === 'supplier_search') res = await K.supplierSearchJob(R.api, ctx);
      else if (kind === 'purchase_push') res = await K.purchasePush(R.api, ctx, env);
      else res = { outcome: 'failed', error: { kind: 'validation', code: 'job_kind', message: 'unknown job kind ' + kind, http_status: null }, effects: {} };
    } catch (e) {
      if (e instanceof Outcome) {
        res = { outcome: e.outcome, effects: e.effects || {}, error: e.error };
        if (e.extra && e.extra.expected_hash) res.expected_hash = e.extra.expected_hash;
      } else if (e instanceof AccountBlocked) {
        res = { outcome: 'failed', effects: targetOf(ctx), error: { kind: 'validation', code: 'account_not_ksa',
          message: 'the Daftra account read before the write is not a KSA account (SAR, Saudi Arabia, 15 % VAT); nothing was sent (fields: ' + e.reason + ')', http_status: null } };
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
  // the UI's dictionary key of a job error (status_labels domain 'daftra_error') + its {fields}: A.errorCode / A.errorFields
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));
})();

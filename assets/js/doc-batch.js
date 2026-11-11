/* ==========================================================================
   مرسى | MARSA — ocr.html: shipment document batch + pending drafts (legacy step 3 UI)
   Contract: docs/online/LEGACY_DOCS_AR.md (backend 20261119000100). Plain IIFE, ES5, no library.
   Depends on window.MarsaApi (supa.js), optional window.MarsaShell (app-shell.js) and
   window.MarsaI18n (strings 'docb.*', assets/i18n/docb.js).

   - One batch = the documents of one shipment: B/L ×1, commercial invoices ≤10, packing lists ≤10,
     customs declaration ×1 (optional). Each file is read by Claude (aiExtract, prompt ai-doc-v3, in
     parallel, 3 at a time); a file already in the batch is skipped before any call, a file the server
     already read comes back reused:true (no charge) and is attached by its extraction_id, never saved
     twice. A reading whose detected type does not match its slot is held back ("wrong slot") and can be
     moved to the right slot or removed; the server checks again on attach (MRS_DOC_WRONG_SLOT).
   - Review: the server merge (mergeDocBatch) becomes the working draft; every field shows its source
     document + confidence, merge / comparison conflicts are highlighted, values are corrected inline
     and saved with the version read (autosave; MRS_DOC_BATCH_STALE → reload). Containers / seals,
     invoice items and packing items are editable tables (each scrolls in its own box).
   - Client: matchClientV2 on the consignee name; the staff picks the client, and "confirm" asks the
     approval to store the name as an approved alias (otherwise it stays only suggested).
   - Approve (ops writers only, confirmed in a dialog): into the batch's / a chosen transaction, or a new
     one for the chosen client. Nothing is approved automatically; every AI value is a draft until then.
   - Pending drafts list (listPendingDocBatches): status + branch filter, open, discard (reason), archive.
   - Deep links: ocr.html#batch=<id> opens a batch, ocr.html#tx=<transaction id> opens the transaction's
     draft (or offers a new batch for it) — the link of the transaction page (assets/js/ops/tx-docs.js).
   - Untrusted values (readings, file names, server rows) only via textContent / value.
   Pure helpers: window.MarsaDocBatch.pure (supabase/tests/legacy-docs-ui-tests.js).
   ========================================================================== */
(function () {
  'use strict';

  /* ==================================================================
     Pure helpers (no DOM)
     ================================================================== */
  var SLOTS = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'customs_declaration'];
  var SLOT_MAX = { bill_of_lading: 1, commercial_invoice: 10, packing_list: 10, customs_declaration: 1 };
  var SECTIONS = ['shipment', 'invoice', 'packing', 'declaration'];
  var SECTION_SLOT = { shipment: 'bill_of_lading', invoice: 'commercial_invoice', packing: 'packing_list', declaration: 'customs_declaration' };
  // the keys of app.doc_batch_draft_check (20261119000100)
  var FIELDS = {
    shipment: {
      text: ['shipper', 'consignee', 'consignee_name', 'notify_party', 'booking_number', 'bl_number', 'vessel', 'voyage',
        'port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery', 'freight_terms', 'goods_description',
        'package_type', 'shipping_line'],
      num: ['packages_count', 'net_weight', 'gross_weight', 'measurement_cbm', 'temperature_c'], arr: []
    },
    invoice: {
      text: ['invoice_number', 'invoice_date', 'seller', 'buyer', 'currency', 'country_of_origin', 'export_country',
        'incoterms', 'payment_terms', 'bl_number', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge'],
      num: ['total'], arr: ['container_numbers', 'seal_numbers']
    },
    packing: {
      text: ['packing_list_number', 'packing_list_date', 'package_type', 'bl_number', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge'],
      num: ['total_packages', 'total_net_weight', 'total_gross_weight'], arr: ['container_numbers', 'seal_numbers']
    },
    declaration: { text: ['declaration_number'], num: [], arr: [] }
  };
  var NEGATIVE_OK = ['temperature_c'];
  var DATE_KEYS = ['invoice_date', 'packing_list_date'];
  var LONG_KEYS = ['shipper', 'consignee', 'notify_party', 'goods_description', 'seller', 'buyer'];
  var CONTAINER = { text: ['container_number', 'seal_number', 'size_type'], num: ['packages_count', 'net_weight', 'gross_weight'] };
  var INV_ITEM = { text: ['description', 'scientific_name', 'supplier_hs_code', 'unit', 'origin_country', 'notes', 'invoice_number'],
    num: ['quantity', 'unit_price', 'total', 'net_weight', 'gross_weight'] };
  var PACK_ITEM = { text: ['description', 'unit', 'container_number', 'seal_number', 'notes', 'packing_list_number'],
    num: ['packages', 'quantity', 'net_weight', 'gross_weight'] };
  var INV_ITEM_COLS = ['description', 'scientific_name', 'supplier_hs_code', 'quantity', 'unit', 'unit_price', 'total', 'origin_country',
    'net_weight', 'gross_weight', 'notes', 'invoice_number'];
  var PACK_ITEM_COLS = ['description', 'packages', 'quantity', 'unit', 'net_weight', 'gross_weight', 'container_number', 'seal_number',
    'notes', 'packing_list_number'];
  var CONTAINER_COLS = ['container_number', 'seal_number', 'size_type', 'packages_count', 'net_weight', 'gross_weight'];
  var MAX_NUM = 99999999999;
  // the reading field a draft key comes from (app.doc_reading_section); absent = the same name
  var SRC_KEY = {
    shipment: { consignee_name: ['consignee_name', 'consignee'] },
    invoice: { seller: ['supplier_name'], buyer: ['buyer_name', 'consignee_name'] },
    packing: { total_packages: ['packages_count'], total_net_weight: ['net_weight'], total_gross_weight: ['gross_weight'] }
  };
  // comparison field (engine batch-v1) → the draft paths it reads
  var COMPARE_PATHS = {
    bl_number: ['shipment.bl_number', 'invoice.bl_number', 'packing.bl_number'],
    container_numbers: ['shipment.containers', 'invoice.container_numbers', 'packing.container_numbers'],
    seal_numbers: ['shipment.containers', 'invoice.seal_numbers', 'packing.seal_numbers'],
    net_weight: ['shipment.net_weight', 'packing.total_net_weight', 'invoice.items'],
    gross_weight: ['shipment.gross_weight', 'packing.total_gross_weight'],
    packages_count: ['shipment.packages_count', 'packing.total_packages', 'invoice.items'],
    consignee_buyer: ['shipment.consignee', 'shipment.consignee_name', 'invoice.buyer'],
    shipper_seller: ['shipment.shipper', 'invoice.seller']
  };
  var COMPARE_FIELDS = ['bl_number', 'container_numbers', 'seal_numbers', 'net_weight', 'gross_weight', 'packages_count', 'consignee_buyer', 'shipper_seller'];
  var MISSING_CODES = ['consignee', 'bl_number', 'container_number', 'goods_description', 'packages_count', 'net_weight', 'gross_weight',
    'invoice_number', 'invoice_date', 'currency', 'total', 'incoterms', 'invoice_items', 'packing_items'];
  var MISSING_PATH = {
    consignee: 'shipment.consignee', bl_number: 'shipment.bl_number', container_number: 'shipment.containers',
    goods_description: 'shipment.goods_description', packages_count: 'shipment.packages_count', net_weight: 'shipment.net_weight',
    gross_weight: 'shipment.gross_weight', invoice_number: 'invoice.invoice_number', invoice_date: 'invoice.invoice_date',
    currency: 'invoice.currency', total: 'invoice.total', incoterms: 'invoice.incoterms', invoice_items: 'invoice.items', packing_items: 'packing.items'
  };
  var STATUSES = ['draft', 'approved', 'discarded', 'archived'];
  var LIST_STATUSES = ['draft', 'open', 'approved', 'discarded', 'archived'];
  var STATUS_TONE = { draft: 'warning', approved: 'success', discarded: 'muted', archived: 'muted' };
  var CLIENT_METHODS = ['english_name', 'alias', 'arabic_name', 'vat_number', 'cr_number', 'similar'];

  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.replace(/\s+/g, '')); }
  // Arabic-Indic / Persian digits → ASCII; Arabic decimal / thousands separators
  function asciiDigits(s) {
    return String(s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); })
      .replace(/٫/g, '.').replace(/[٬  ]/g, ',');
  }
  // '' / null → null · a plain number (thousands separators allowed) → number · anything else → NaN
  function parseNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = asciiDigits(v).replace(/\s+/g, '');
    if (!s) return null;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  // 'YYYY-MM-DD' kept; 'D/M/YYYY' or 'D-M-YYYY' → 'YYYY-MM-DD'; anything else → null (invalid)
  function normDate(v) {
    var s = asciiDigits(String(v == null ? '' : v)).trim();
    if (!s) return '';
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) || null, y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(s);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }
  function normContainer(v) { return String(v == null ? '' : v).toUpperCase().replace(/[\s\-_.\/]+/g, ''); }
  function splitList(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    return String(v == null ? '' : v).split(/[,;\s،]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  // one object of the draft (section / container / item) → cleaned copy; errors get '<path>.<key>'
  function cleanObj(src, def, path, errors, opts) {
    var out = {}, any = false;
    opts = opts || {};
    (def.text || []).forEach(function (k) {
      if (!own(src, k) || blank(src[k])) return;
      var s = String(src[k]).trim();
      if (DATE_KEYS.indexOf(k) !== -1) {
        var d = normDate(s);
        if (d === null) { errors.push(path + '.' + k); return; }
        s = d;
      }
      if (k === 'container_number' && opts.container) s = normContainer(s);
      if (s.length > (opts.max && opts.max[k] ? opts.max[k] : 2000)) { errors.push(path + '.' + k); return; }
      out[k] = s; any = true;
    });
    (def.num || []).forEach(function (k) {
      if (!own(src, k)) return;
      var n = parseNum(src[k]);
      if (n === null) return;
      if (isNaN(n) || Math.abs(n) > MAX_NUM || (n < 0 && NEGATIVE_OK.indexOf(k) === -1)) { errors.push(path + '.' + k); return; }
      out[k] = Math.round(n * 10000) / 10000; any = true;
    });
    (def.arr || []).forEach(function (k) {
      if (!own(src, k)) return;
      var a = splitList(src[k]);
      if (k === 'container_numbers') a = a.map(normContainer);
      var seen = {};
      a = a.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; });
      if (!a.length) return;
      if (a.length > 300 || a.some(function (x) { return x.length > 40; })) { errors.push(path + '.' + k); return; }
      out[k] = a; any = true;
    });
    return any ? out : null;
  }
  // the working draft (strings typed by staff, numbers from the server) → the contract shape
  // → { draft, errors: ['shipment.net_weight', 'shipment.containers.2.container_number', …] }
  function normalizeDraft(d) {
    d = d && typeof d === 'object' ? d : {};
    var out = {}, errors = [];
    SECTIONS.forEach(function (sec) {
      var src = d[sec];
      if (!src || typeof src !== 'object') return;
      var o = cleanObj(src, FIELDS[sec], sec, errors) || {};
      if (sec === 'shipment' && Array.isArray(src.containers)) {
        var rows = [];
        src.containers.forEach(function (c, i) {
          if (!c || typeof c !== 'object') return;
          var r = cleanObj(c, CONTAINER, 'shipment.containers.' + i, errors, { container: true, max: { seal_number: 30, size_type: 10 } });
          if (!r) return;
          if (!/^[A-Z]{4}[0-9]{7}$/.test(r.container_number || '')) { errors.push('shipment.containers.' + i + '.container_number'); return; }
          rows.push(r);
        });
        if (rows.length > 300) errors.push('shipment.containers');
        o.containers = rows.slice(0, 300);
      }
      if ((sec === 'invoice' || sec === 'packing') && Array.isArray(src.items)) {
        var items = [];
        src.items.forEach(function (it, i) {
          if (!it || typeof it !== 'object') return;
          var r = cleanObj(it, sec === 'invoice' ? INV_ITEM : PACK_ITEM, sec + '.items.' + i, errors,
            { container: true, max: { seal_number: 30, notes: 500 } });
          if (r) items.push(r);
        });
        if (items.length > 500) errors.push(sec + '.items');
        o.items = items.slice(0, 500);
      }
      if (Object.keys(o).length) out[sec] = o;
    });
    if (Array.isArray(d.source_notes)) {
      var notes = d.source_notes.filter(function (n) { return typeof n === 'string' && n.trim(); })
        .map(function (n) { return n.trim().slice(0, 500); }).slice(0, 50);
      if (notes.length) out.source_notes = notes;
    }
    return { draft: out, errors: errors };
  }
  function draftEmpty(d) {
    if (!d || typeof d !== 'object') return true;
    return !SECTIONS.some(function (s) { return d[s] && typeof d[s] === 'object' && Object.keys(d[s]).length; });
  }
  // value at 'shipment.net_weight' / 'invoice.items'
  function getPath(d, path) {
    var p = String(path).split('.'), v = d;
    for (var i = 0; i < p.length; i++) { if (!v || typeof v !== 'object') return undefined; v = v[p[i]]; }
    return v;
  }
  function setPath(d, path, value) {
    var p = String(path).split('.'), v = d;
    for (var i = 0; i < p.length - 1; i++) {
      if (!v[p[i]] || typeof v[p[i]] !== 'object') v[p[i]] = /^\d+$/.test(p[i + 1]) ? [] : {};
      v = v[p[i]];
    }
    v[p[p.length - 1]] = value;
    return d;
  }
  // a saved reading / an aiExtract response → { fields {name: value}, conf {name: 0..1}, reviewed {name: true} }
  function readingOf(x) {
    var fields = {}, conf = {}, reviewed = {};
    if (!x || typeof x !== 'object') return { fields: fields, conf: conf, reviewed: reviewed };
    var ex = x.extracted_fields && typeof x.extracted_fields === 'object' ? x.extracted_fields : {};
    var rv = x.reviewed_fields && typeof x.reviewed_fields === 'object' ? x.reviewed_fields : {};
    Object.keys(ex).forEach(function (k) { if (typeof ex[k] === 'string' && ex[k].trim()) fields[k] = ex[k]; });
    Object.keys(rv).forEach(function (k) { if (typeof rv[k] === 'string' && rv[k].trim()) { fields[k] = rv[k]; reviewed[k] = true; } });
    var meta = Array.isArray(x.fields) ? x.fields : (x.ai_detail && Array.isArray(x.ai_detail.fields) ? x.ai_detail.fields : []);
    meta.forEach(function (f) {
      if (!f || typeof f.name !== 'string') return;
      var c = Number(f.confidence);
      if (isFinite(c) && c >= 0 && c <= 1) conf[f.name] = c;
      if (!own(fields, f.name) && typeof f.value === 'string' && f.value.trim()) fields[f.name] = f.value;
    });
    return { fields: fields, conf: conf, reviewed: reviewed };
  }
  // where each draft field came from (the merge rule: slot order, then attach order; the last non-empty value wins)
  // documents: the batch's documents [{id, slot, seq, extraction_id, source_name, mean_confidence}]
  // readings: {extraction_id: readingOf(...)} → { 'invoice.seller': {slot, seq, document_id, extraction_id, source_name, field,
  //   confidence 0..1 | null, reviewed} }
  function fieldSources(documents, readings) {
    var out = {};
    var docs = (Array.isArray(documents) ? documents : []).slice().sort(function (a, b) {
      return (SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)) || ((a.seq || 0) - (b.seq || 0));
    });
    SECTIONS.forEach(function (sec) {
      var def = FIELDS[sec], keys = def.text.concat(def.num, def.arr);
      docs.forEach(function (doc) {
        if (doc.slot !== SECTION_SLOT[sec]) return;
        var rd = readings && readings[doc.extraction_id];
        if (!rd) return;
        keys.forEach(function (k) {
          var src = (SRC_KEY[sec] && SRC_KEY[sec][k]) || [k];
          for (var i = 0; i < src.length; i++) {
            var f = src[i];
            if (own(rd.fields, f) && !blank(rd.fields[f])) {
              var c = own(rd.conf, f) ? rd.conf[f] : (doc.mean_confidence != null && isFinite(Number(doc.mean_confidence)) ? Number(doc.mean_confidence) / 100 : null);
              out[sec + '.' + k] = { slot: doc.slot, seq: doc.seq || 1, document_id: doc.id || null, extraction_id: doc.extraction_id,
                source_name: doc.source_name || '', field: f, confidence: c, reviewed: !!(rd.reviewed && rd.reviewed[f]) };
              return;
            }
          }
        });
      });
    });
    return out;
  }
  // draft paths to highlight → { path: [{kind:'conflict'|'merge'|'missing', field}] }
  function flaggedPaths(comparison, mergeConflicts) {
    var out = {};
    function add(p, x) { (out[p] = out[p] || []).push(x); }
    var cmp = comparison && typeof comparison === 'object' ? comparison : {};
    (Array.isArray(cmp.conflicts) ? cmp.conflicts : []).forEach(function (c) {
      (COMPARE_PATHS[c && c.field] || []).forEach(function (p) { add(p, { kind: 'conflict', field: c.field }); });
    });
    (Array.isArray(cmp.missing_fields) ? cmp.missing_fields : []).forEach(function (m) {
      if (MISSING_PATH[m]) add(MISSING_PATH[m], { kind: 'missing', field: m });
    });
    (Array.isArray(mergeConflicts) ? mergeConflicts : []).forEach(function (m) {
      if (m && m.section && m.field && m.field !== 'items_truncated') add(m.section + '.' + m.field, { kind: 'merge', field: m.field });
    });
    return out;
  }
  // the type the server will compare with the slot (attach_doc_batch_document): detected (supplier → operator), else the kind
  function detectedKind(res) {
    if (!res) return null;
    var d = res.detected_type || (res.ai_detail && res.ai_detail.detected_type) || null;
    if (d === 'supplier_invoice') d = 'operator_invoice';
    return d || res.kind || res.doc_type || null;
  }
  // an aiExtract (v3) answer for a slot → { ok, detected, saved, target (slot to move to | null) }
  // the document types found in a combined file (ai-doc-v3 detected_documents; supplier → operator), the main one first
  function detectedDocs(res) {
    var l = (res && (res.detected_documents || (res.ai_detail && res.ai_detail.detected_documents))) || [];
    return (Array.isArray(l) ? l : []).map(function (t) { return t === 'supplier_invoice' ? 'operator_invoice' : t; });
  }
  function slotCheck(slot, res) {
    var det = detectedKind(res);
    var saved = res && res.reused ? (res.kind || res.doc_type || null) : slot;
    // a combined file is accepted in the slot of any document type it holds (server: attach_doc_batch_document)
    if (det !== slot && detectedDocs(res).indexOf(slot) !== -1) det = slot;
    var ok = saved === slot && det === slot;
    var target = null;
    if (!ok && SLOTS.indexOf(det) !== -1) target = res && res.reused ? (saved === det ? det : null) : det;
    return { ok: ok, detected: det, saved: saved, target: target };
  }
  // what to do with a reading: reuse the saved extraction (no charge, never saved again) or save a new one
  function readingAction(slot, res) {
    var chk = slotCheck(slot, res);
    if (!chk.ok) return { action: 'wrong_slot', detected: chk.detected, target: chk.target };
    if (res && res.reused && isUuid(res.extraction_id)) return { action: 'attach', extractionId: res.extraction_id };
    return { action: 'save' };
  }
  // the same file queued twice (same SHA-256): the later copy is skipped before any AI call
  function queueDup(queue, q) {
    if (!q || !/^[0-9a-f]{64}$/.test(String(q.sha || ''))) return null;
    return (Array.isArray(queue) ? queue : []).filter(function (x) {
      return x && x !== q && x.id < q.id && x.sha === q.sha && ['error', 'removed', 'skipped'].indexOf(x.status) === -1;
    })[0] || null;
  }
  // the batch total of the files waiting to be read (inventory rule: 25 MB per batch)
  var BATCH_MAX_BYTES = 25 * 1024 * 1024;
  function queuedBytes(queue) {
    return (Array.isArray(queue) ? queue : []).reduce(function (n, x) {
      return n + (x && x.file && ['queued', 'sending', 'reading', 'saving', 'attaching'].indexOf(x.status) !== -1 ? Number(x.file.size) || 0 : 0);
    }, 0);
  }
  // a file already in the batch (same SHA-256) is not read again
  function inBatch(documents, sha) {
    if (!/^[0-9a-f]{64}$/.test(String(sha || ''))) return null;
    return (Array.isArray(documents) ? documents : []).filter(function (d) { return d && d.source_sha256 === sha; })[0] || null;
  }
  function slotCount(documents, slot) {
    return (Array.isArray(documents) ? documents : []).filter(function (d) { return d && d.slot === slot; }).length;
  }
  function slotRoom(documents, slot, queued) { return Math.max(0, SLOT_MAX[slot] - slotCount(documents, slot) - (queued || 0)); }
  // the extraction row saved for a fresh v3 reading (document_extractions insert, supa.js EXT_INSERT)
  function extractionRow(o) {
    var res = o.res || {}, file = o.file || {};
    var maxPage = 0;
    (res.fields || []).forEach(function (f) { if (f && f.page > maxPage) maxPage = f.page; });
    var row = {
      doc_type: o.docType, source_name: String(file.name || o.docType).slice(0, 255), source_sha256: o.sha256 || res.source_sha256 || '',
      source_mime: o.mime || null, source_size: file.size != null ? file.size : null,
      source_pages: maxPage ? Math.min(Math.max(maxPage, 1), 200) : null,
      engine: o.engine || 'claude-opus-5-5', languages: 'auto',
      mean_confidence: res.mean_confidence == null ? null : Math.min(100, Math.max(0, Number(res.mean_confidence))),
      raw_text: String(res.raw_text || '').slice(0, 200000),
      extracted_fields: res.extracted_fields && typeof res.extracted_fields === 'object' ? res.extracted_fields : {},
      qr_payload: null, line_items: Array.isArray(res.line_items) ? res.line_items.slice(0, 500) : [],
      ai_usage_id: res.usage_id
    };
    if (res.ai_detail && typeof res.ai_detail === 'object') row.ai_detail = res.ai_detail;
    if (o.orgId) row.org_id = o.orgId;
    if (o.transactionId) row.transaction_id = o.transactionId;
    return row;
  }
  // allowed actions for a batch status (the lifecycle table of LEGACY_DOCS_AR.md)
  function batchActions(status, writer) {
    var a = { edit: false, approve: false, discard: false, archive: false, attach: false };
    if (!writer) return a;
    if (status === 'draft') { a.edit = a.approve = a.discard = a.archive = a.attach = true; }
    else if (status === 'discarded') a.archive = true;
    return a;
  }
  // the approval request → { o (approveDocBatch options) } | { error: 'version' | 'target' | 'transaction' | 'client' }
  // st = { version, batchTx, target: 'existing' | 'new', transactionId, clientId, operation, mode, shippingAgentId, confirmClient, idemKey }
  function approvePayload(st) {
    st = st || {};
    if (typeof st.version !== 'number' || !isFinite(st.version)) return { error: 'version' };
    var o = { version: st.version };
    if (isUuid(st.batchTx)) {
      // the batch is tied to its transaction: nothing else may be sent
    } else if (st.target === 'existing') {
      if (!isUuid(st.transactionId)) return { error: 'transaction' };
      o.transactionId = st.transactionId;
    } else if (st.target === 'new') {
      if (!isUuid(st.clientId)) return { error: 'client' };
      o.newTransaction = { clientId: st.clientId, operation: st.operation === 'export' ? 'export' : 'import',
        mode: ['sea', 'air', 'land'].indexOf(st.mode) !== -1 ? st.mode : 'sea' };
    } else return { error: 'target' };
    if (isUuid(st.shippingAgentId)) o.shippingAgentId = st.shippingAgentId;
    if (st.confirmClient) o.confirmClient = true;
    if (st.idemKey) o.idemKey = st.idemKey;
    return { o: o };
  }
  // one idempotency key per (version, request): a retry of the same approval replays, a changed request is a new one
  function approveKey(prev, version, o, gen) {
    var sig = JSON.stringify([version, o && o.transactionId || null, o && o.newTransaction || null, o && o.shippingAgentId || null, !!(o && o.confirmClient)]);
    if (prev && prev.sig === sig && prev.key) return prev;
    return { sig: sig, key: typeof gen === 'function' ? gen() : null };
  }
  // client matching result → { candidates (sorted), preselect client_id | null, state 'suggested' | 'review' | 'conflict' | 'none' }
  function matchView(res) {
    var c = res && Array.isArray(res.candidates) ? res.candidates.slice() : [];
    c.sort(function (a, b) { return (Number(b.confidence) || 0) - (Number(a.confidence) || 0); });
    var state = 'none', pre = null;
    if (res && res.conflict) state = 'conflict';
    else if (res && res.suggested && res.best && isUuid(res.best.client_id)) { state = 'suggested'; pre = res.best.client_id; }
    else if (c.length && (Number(c[0].confidence) || 0) >= ((res && res.thresholds && res.thresholds.review) || 70)) state = 'review';
    return { candidates: c, preselect: pre, state: state };
  }
  // the consignee name to match: the identity name first, then the consignee block / the invoice buyer
  function consigneeName(draft) {
    var s = (draft && draft.shipment) || {}, iv = (draft && draft.invoice) || {};
    var v = [s.consignee_name, s.consignee, iv.buyer].filter(function (x) { return !blank(x); })[0];
    return v == null ? '' : String(v).split(/\r?\n/)[0].trim().slice(0, 300);
  }
  // pending list filter (the server already limits to the caller's branches)
  function filterBatches(list, f) {
    f = f || {};
    return (Array.isArray(list) ? list : []).filter(function (b) {
      if (!b) return false;
      if (f.branchId && b.branch_id !== f.branchId) return false;
      if (f.q) {
        var q = String(f.q).toLowerCase();
        var hay = [b.transaction_ref, b.bl_number, b.client_name, b.importer_name, b.note, b.created_by_name].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }
  // the deep link of ocr.html → { batch: id } | { tx: id } | {}
  function parseHash(h) {
    var s = String(h || '').replace(/^#/, ''), m;
    if ((m = /^batch=([0-9a-f-]{36})$/i.exec(s)) && isUuid(m[1])) return { batch: m[1].toLowerCase() };
    if ((m = /^tx=([0-9a-f-]{36})$/i.exec(s)) && isUuid(m[1])) return { tx: m[1].toLowerCase() };
    return {};
  }
  // approve result → numbers for the summary
  function approveSummary(r) {
    r = r || {};
    var c = r.containers || {};
    return {
      ref: r.ref || '', created: !!r.created_transaction, replayed: !!r.replayed,
      bl: r.bl ? (r.bl.created ? 'created' : 'existing') : 'none',
      added: Array.isArray(c.added) ? c.added.length : 0, updated: Array.isArray(c.updated) ? c.updated.length : 0,
      unchanged: Array.isArray(c.unchanged) ? c.unchanged.length : 0,
      invoiceItems: Number(r.invoice_items) || 0, packingItems: Number(r.packing_items) || 0, linked: Number(r.extractions_linked) || 0,
      filled: Array.isArray(r.tx_filled) ? r.tx_filled.slice() : [], kept: Array.isArray(r.tx_kept) ? r.tx_kept.slice() : [],
      alias: r.client_alias && r.client_alias.status ? r.client_alias.status : null,
      conflicts: Array.isArray(r.conflicts) ? r.conflicts.length : 0, missing: Array.isArray(r.missing_fields) ? r.missing_fields.length : 0
    };
  }
  // the text of an error: a message built in this file (no raw API error behind it: precondition / move errors) is shown
  // as it is — supa.js errorMessage would turn it into the generic «unexpected error»; an API error goes through
  // errorMessage (its own localized MRS_* text)
  function errorText(e, apiMessage, generic) {
    if (!e) return generic;
    if (e.raw === undefined && typeof e.message === 'string' && e.message && !/^MRS_[A-Z_]+$/.test(e.message)) return e.message;
    if (typeof apiMessage === 'function') { try { var m = apiMessage(e); if (m) return m; } catch (x) { /* fall back */ } }
    return e.message || generic;
  }
  // run fn over items, n at a time (parallel reading)
  function pool(items, n, fn, stop) {
    var i = 0, out = new Array(items.length);
    function next() {
      if (i >= items.length || (stop && stop())) return Promise.resolve();
      var k = i++;
      return Promise.resolve().then(function () { return fn(items[k], k); }).then(function (v) { out[k] = v; }, function (e) { out[k] = e; }).then(next);
    }
    var workers = [];
    for (var w = 0; w < Math.max(1, Math.min(n, items.length)); w++) workers.push(next());
    return Promise.all(workers).then(function () { return out; });
  }

  var PURE = {
    SLOTS: SLOTS, SLOT_MAX: SLOT_MAX, SECTIONS: SECTIONS, SECTION_SLOT: SECTION_SLOT, FIELDS: FIELDS, CONTAINER: CONTAINER,
    INV_ITEM: INV_ITEM, PACK_ITEM: PACK_ITEM, COMPARE_FIELDS: COMPARE_FIELDS, COMPARE_PATHS: COMPARE_PATHS, MISSING_CODES: MISSING_CODES,
    STATUSES: STATUSES, LIST_STATUSES: LIST_STATUSES, CLIENT_METHODS: CLIENT_METHODS,
    parseNum: parseNum, normDate: normDate, normContainer: normContainer, splitList: splitList, normalizeDraft: normalizeDraft,
    draftEmpty: draftEmpty, getPath: getPath, setPath: setPath, readingOf: readingOf, fieldSources: fieldSources,
    flaggedPaths: flaggedPaths, detectedKind: detectedKind, slotCheck: slotCheck, readingAction: readingAction, inBatch: inBatch,
    slotCount: slotCount, slotRoom: slotRoom, extractionRow: extractionRow, batchActions: batchActions, approvePayload: approvePayload,
    approveKey: approveKey, matchView: matchView, consigneeName: consigneeName, queueDup: queueDup, queuedBytes: queuedBytes, errorText: errorText,
    BATCH_MAX_BYTES: BATCH_MAX_BYTES, detectedDocs: detectedDocs, filterBatches: filterBatches, parseHash: parseHash,
    approveSummary: approveSummary, pool: pool, isUuid: isUuid
  };
  window.MarsaDocBatch = { VERSION: 'docb-ui-1', pure: PURE };

  /* ==================================================================
     Page UI (ocr.html only: #docb-section)
     ================================================================== */
  function ready(fn) {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var section = document.getElementById('docb-section');
    var root = document.getElementById('docb-root');
    var pendRoot = document.getElementById('docb-pending');
    if (!section || !root || !pendRoot) return;
    var API = window.MarsaApi || null;
    var Shell = window.MarsaShell || null;
    var I18N = window.MarsaI18n || null;
    var M = window.Marsa || {};
    var toast = Shell && typeof Shell.toast === 'function' ? function (m, t) { Shell.toast(m, t); }
      : (M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } });

    function T(key, vars) {
      var k = 'docb.' + key;
      return I18N && typeof I18N.t === 'function' && (!I18N.has || I18N.has(k)) ? I18N.t(k, vars) : key;
    }
    function lang() { return I18N && typeof I18N.lang === 'function' && I18N.lang() === 'en' ? 'en' : 'ar'; }
    function has(fn) { return !!(API && typeof API[fn] === 'function'); }
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function btn(text, cls, fn) {
      var b = el('button', 'btn btn-sm ' + (cls || 'btn-ghost'), text);
      b.type = 'button';
      if (fn) b.addEventListener('click', function (e) { e.preventDefault(); fn(b); });
      return b;
    }
    function bdi(text) { var b = el('bdi', null, text); b.dir = 'auto'; return b; }
    function ltr(text) { var b = el('bdi', 'num', text); b.dir = 'ltr'; return b; }
    function alertBox(type, text) {
      var a = el('div', 'alert alert-' + type + ' docb-alert');
      a.setAttribute('role', type === 'danger' ? 'alert' : 'status');
      a.appendChild(el('span', null, text));
      return a;
    }
    function errMsg(e) {
      return errorText(e, API && typeof API.errorMessage === 'function' ? function (x) { return API.errorMessage(x); } : null, T('err_generic'));
    }
    function fmtDate(iso) {
      if (!iso) return '';
      try {
        if (I18N && I18N.fmtDate) return I18N.fmtDate(iso, { time: true });
        return new Date(iso).toLocaleString(lang() === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory');
      } catch (e) { return String(iso); }
    }
    function pct(c) { return c == null || !isFinite(Number(c)) ? '' : Math.round(Number(c) * 100) + '%'; }
    function uuid() { return API && API.util && API.util.uuid ? API.util.uuid() : null; }
    function announce(msg) { var s = document.getElementById('docb-live'); if (s) s.textContent = msg; }
    function askConfirm(o) {
      if (Shell && typeof Shell.confirm === 'function') {
        // confirmDialog prefers text over body: hand it the line-per-fact body when there is one
        if (o.body && o.body.nodeType) { var c = {}; for (var k in o) if (k !== 'text') c[k] = o[k]; return Shell.confirm(c); }
        return Shell.confirm(o);
      }
      return Promise.resolve(window.confirm((o.title ? o.title + '\n\n' : '') + (o.text || '')));
    }
    function slotName(s) { return T('slot_' + s); }
    function kindName(k) { return T('kind_' + k) === 'kind_' + k ? String(k || T('kind_other')) : T('kind_' + k); }
    function statusName(s) { return T('st_' + s); }
    function listSep() { return window.MarsaI18n && typeof window.MarsaI18n.lang === 'function' && window.MarsaI18n.lang() === 'en' ? ', ' : '، '; }
    function txColName(c) {
      var k = 'txcol_' + c;
      if (T(k) !== k) return T(k);
      return T('f_' + c) !== 'f_' + c ? T('f_' + c) : String(c);
    }
    function fieldLabel(sec, k) {
      var spec = 'f_' + sec + '_' + k;
      return T(spec) !== spec ? T(spec) : T('f_' + k);
    }
    function fileB64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
        fr.onerror = function () { reject(new Error('read')); };
        fr.readAsDataURL(file);
      });
    }
    function sha256(file) {
      if (API && API.util && API.util.sha256Hex) return API.util.sha256Hex(file).catch(function () { return ''; });
      if (!(window.crypto && crypto.subtle)) return Promise.resolve('');
      return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return ''; });
    }
    var AI_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
    function mediaType(f) {
      var t = String(f.type || '').toLowerCase();
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1) return t;
      var n = String(f.name || ''), i = n.lastIndexOf('.');
      return i > 0 ? AI_MEDIA[n.slice(i + 1).toLowerCase()] || null : null;
    }
    function fmtSize(b) { return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB'; }

    /* ---------------------------------------------------------------
       State
       --------------------------------------------------------------- */
    var ONLINE = !!(API && API.isOnline && API.isOnline());
    var S = {
      staff: false, writer: false, ai: false, remaining: null, orgId: null, branches: [],
      batch: null, version: null, draft: null, comparison: null, mergeConflicts: [], readings: {}, queue: [], running: false,
      dirty: false, userEdited: false, saving: false, saveTimer: null, saveAgain: false, stale: false, invalid: [],
      newDocs: false, match: null, matchName: '', clientId: null, clientName: '', confirmClient: false,
      target: 'existing', txId: null, txLabel: '', txClientId: null, txClientName: '', operation: 'import', mode: 'sea',
      agents: [], agentId: null, agentFor: null, approving: false, idem: null, approveError: null,
      list: [], listStatus: 'draft', listBranch: '', listQ: '', loadSeq: 0, pendingTx: null, needBranch: false
    };
    var qid = 0;

    function shellOrg() {
      if (!Shell || typeof Shell.orgId !== 'function') return null;
      try { var o = Shell.orgId(); return typeof o === 'string' && o ? o : null; } catch (e) { return null; }
    }
    function orgP() {
      if (S.orgId) return Promise.resolve(S.orgId);
      var o = shellOrg();
      if (o) { S.orgId = o; return Promise.resolve(o); }
      if (!API || !API.activeOrgId) return Promise.resolve(null);
      return API.activeOrgId().then(function (r) { S.orgId = r && !r.error ? r.data || null : null; return S.orgId; }, function () { return null; });
    }
    function branchName(id) {
      var b = S.branches.filter(function (x) { return x.id === id; })[0];
      return b ? (lang() === 'en' && b.name_en ? b.name_en : b.name_ar || b.code || '') : '';
    }

    /* ---------------------------------------------------------------
       Access gate
       --------------------------------------------------------------- */
    function init() {
      if (!ONLINE || !API || !has('createDocBatch') || !has('listPendingDocBatches')) { section.hidden = true; return; }
      var shellReady = Shell && Shell.ready && typeof Shell.ready.then === 'function' ? Shell.ready : Promise.resolve(null);
      shellReady.then(function () {
        return API.getSession();
      }).then(function (s) {
        if (!s || s.error || !s.data) return false;
        return API.isStaff().then(function (r) { return !r.error && !!r.data; });
      }).then(function (staff) {
        S.staff = !!staff;
        if (!S.staff) { section.hidden = true; return null; }
        var R = Shell && Shell.R && Shell.R.opsWriter;
        S.writer = Shell && typeof Shell.can === 'function' && R ? !!Shell.can(R) : true;
        section.hidden = false;
        return orgP().then(function (oid) {
          var a = has('aiAccess') ? API.aiAccess(oid || undefined).then(function (r) {
            S.ai = !!(r && !r.error && r.data && r.data.can_use === true);
            S.remaining = S.ai && r.data.daily_remaining != null ? Number(r.data.daily_remaining) : null;
          }, function () { S.ai = false; }) : Promise.resolve();
          var b = has('listBranches') ? API.listBranches(oid || undefined).then(function (r) {
            S.branches = r && !r.error && Array.isArray(r.data) ? r.data.filter(function (x) { return x.is_active !== false; }) : [];
          }, function () { /* names only */ }) : Promise.resolve();
          return Promise.all([a, b]);
        });
      }).then(function () {
        if (!S.staff) return;
        render();
        loadList();
        route();
      }).catch(function () { section.hidden = true; });
    }
    window.addEventListener('hashchange', function () { if (S.staff) route(); });
    // unsaved draft edits: the browser asks before leaving (the autosave normally runs within 1.5 s)
    window.addEventListener('beforeunload', function (e) {
      if (!(S.dirty || S.saving) || !S.batch || S.batch.status !== 'draft') return;
      e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('marsa:orgchange', function () {
      S.orgId = null; S.batch = null; S.draft = null; S.queue = []; S.list = [];
      if (S.staff) { render(); loadList(); }
    });
    function route() {
      var h = parseHash(location.hash);
      if (h.batch) { if (!S.batch || S.batch.id !== h.batch) openBatch(h.batch); focusSection(); }
      else if (h.tx) { openForTx(h.tx); focusSection(); }
    }
    function focusSection() {
      var t = document.getElementById('docb-title');
      if (t) { try { t.focus({ preventScroll: false }); } catch (e) { t.focus(); } }
    }

    /* ---------------------------------------------------------------
       Batch: create / open / reload
       --------------------------------------------------------------- */
    function setHash(id) {
      var want = '#batch=' + id;
      if (location.hash === want) return;
      try { history.replaceState(null, '', location.pathname + location.search + want); } catch (e) { location.hash = want; }
    }
    function resetBatchState() {
      if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
      S.batch = null; S.version = null; S.draft = null; S.comparison = null; S.mergeConflicts = []; S.queue = [];
      S.dirty = false; S.userEdited = false; S.stale = false; S.invalid = []; S.newDocs = false;
      S.match = null; S.matchName = ''; S.clientId = null; S.clientName = ''; S.confirmClient = false;
      S.target = 'existing'; S.txId = null; S.txLabel = ''; S.txClientId = null; S.txClientName = '';
      S.agents = []; S.agentId = null; S.agentFor = null; S.idem = null; S.approveError = null; S.pendingTx = null; S.needBranch = false;
      S.txClientFor = null; S.txQuery = ''; S.approveResult = null; S.approving = false;
    }
    function createBatch(txId) {
      if (!S.writer) { toast(T('err_writer'), 'warning'); return; }
      var branchSel = document.getElementById('docb-new-branch');
      var o = { orgId: S.orgId || undefined, idempotencyKey: uuid() || undefined };
      if (txId) o.transactionId = txId;
      if (branchSel && branchSel.value) o.branchId = branchSel.value;
      setBusy('docb-new-btn', true);
      API.createDocBatch(o).then(function (r) {
        setBusy('docb-new-btn', false);
        if (r.error) {
          if (r.error.code === 'MRS_REQUIRED' && r.error.field === 'branch_id') { S.needBranch = true; renderHead(); toast(T('need_branch'), 'warning'); return; }
          toast(errMsg(r.error), 'error'); return;
        }
        resetBatchState();
        takeBatch(r.data);
        setHash(r.data.id);
        render();
        loadList();
        toast(T('created'), 'success');
      }, function (e) { setBusy('docb-new-btn', false); toast(errMsg(e), 'error'); });
    }
    function setBusy(id, on) { var b = document.getElementById(id); if (b) b.disabled = !!on; }
    function openForTx(txId) {
      orgP().then(function (oid) {
        return API.listPendingDocBatches({ orgId: oid || undefined, status: 'draft', transactionId: txId, limit: 5 });
      }).then(function (r) {
        if (r && !r.error && Array.isArray(r.data) && r.data.length) { openBatch(r.data[0].id); return; }
        resetBatchState();
        S.pendingTx = { id: txId, ref: '' };
        render();
        if (has('getTransaction')) API.getTransaction(txId).then(function (t) {
          if (t && !t.error && t.data && S.pendingTx && S.pendingTx.id === txId) { S.pendingTx.ref = t.data.ref || ''; renderHead(); }
        }, function () { /* the id is enough */ });
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function openBatch(id) {
      var seq = ++S.loadSeq;
      API.getDocBatch(id).then(function (r) {
        if (seq !== S.loadSeq) return;
        if (r.error) { toast(errMsg(r.error), 'error'); return; }
        resetBatchState();
        takeBatch(r.data);
        setHash(id);
        S.userEdited = !draftEmpty(r.data.draft);
        render();
        loadReadings().then(function () {
          if (seq !== S.loadSeq) return;
          if (S.batch && S.batch.status === 'draft' && (r.data.documents || []).length) {
            return merge({ keepDraft: !draftEmpty(r.data.draft), silent: true });
          }
          renderReview();
        });
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function reloadBatch() {
      if (!S.batch) return Promise.resolve(null);
      var id = S.batch.id;
      return API.getDocBatch(id).then(function (r) {
        if (r.error) { toast(errMsg(r.error), 'error'); return null; }
        if (!S.batch || S.batch.id !== id) return null;
        takeBatch(r.data);
        return r.data;
      });
    }
    // a full batch from the server → state (the draft only when the caller asks: edits in progress stay)
    function takeBatch(b, withDraft) {
      S.batch = b;
      S.version = typeof b.version === 'number' ? b.version : Number(b.version);
      S.comparison = b.comparison || S.comparison;
      if (withDraft !== false && (S.draft == null)) S.draft = clone(b.draft) || {};
      if (b.client_id && !S.clientId) { S.clientId = b.client_id; S.clientName = b.client_name || ''; }
      var cm = b.client_match && typeof b.client_match === 'object' ? b.client_match : null;
      if (cm && !S.match) {
        if (cm.source_name) S.matchName = String(cm.source_name);
        if (cm.result && typeof cm.result === 'object') S.match = cm.result;
        if (cm.confirmed) S.confirmClient = true;
        if (cm.target === 'new' || cm.target === 'existing') S.target = cm.target;
        if (cm.operation) S.operation = cm.operation;
        if (cm.mode) S.mode = cm.mode;
      }
      if (b.transaction_id) { S.target = 'existing'; S.txId = b.transaction_id; S.txLabel = b.transaction_ref || ''; }
    }
    // the saved readings of the documents (for the field sources); in-session readings are already cached
    function loadReadings() {
      var docs = (S.batch && S.batch.documents) || [];
      var need = docs.filter(function (d) { return d.extraction_id && !S.readings[d.extraction_id]; });
      if (!need.length || !has('getExtraction')) return Promise.resolve();
      return pool(need, 4, function (d) {
        return API.getExtraction(d.extraction_id).then(function (r) {
          if (r && !r.error && r.data) S.readings[d.extraction_id] = readingOf(r.data);
        }, function () { /* the source badge falls back to the document */ });
      });
    }

    /* ---------------------------------------------------------------
       Upload + parallel reading
       --------------------------------------------------------------- */
    function queuedFor(slot) { return S.queue.filter(function (q) { return q.slot === slot && ['done', 'reused', 'skipped', 'removed'].indexOf(q.status) === -1; }).length; }
    function addFiles(slot, files) {
      if (!S.batch || S.batch.status !== 'draft' || !S.writer) return;
      var list = Array.prototype.slice.call(files || []);
      list.forEach(function (f) {
        var room = slotRoom(S.batch.documents, slot, queuedFor(slot));
        if (room <= 0) { toast(T('slot_full', { slot: slotName(slot) }), 'warning'); return; }
        var mt = mediaType(f);
        var q = { id: ++qid, slot: slot, file: f, mime: mt, sha: '', status: 'queued', error: '', res: null, target: null, detected: null };
        if (!mt) { q.status = 'error'; q.error = T('err_unsupported'); }
        else if (f.size > (mt === 'application/pdf' ? 10 : 5) * 1024 * 1024) { q.status = 'error'; q.error = T('err_too_large'); }
        else if (queuedBytes(S.queue) + (Number(f.size) || 0) > BATCH_MAX_BYTES) { q.status = 'error'; q.error = T('err_batch_total'); }
        S.queue.push(q);
        if (q.status === 'queued') sha256(f).then(function (h) {
          q.sha = h;
          var d = queueDup(S.queue, q);
          if (d && q.status === 'queued') { setQ(q, 'skipped', T('q_dup_queue', { slot: slotName(d.slot) })); renderSlots(); }
        });
      });
      renderSlots();
    }
    function readAll() {
      if (S.running || !S.batch) return;
      if (!S.ai) { toast(T('ai_off'), 'warning'); return; }
      var todo = S.queue.filter(function (q) { return q.status === 'queued' || q.status === 'error' && q.retry; });
      if (!todo.length) return;
      if (S.remaining != null && S.remaining <= 0) { toast(T('err_quota'), 'warning'); return; }
      S.running = true; S.cancel = false; S.slow = false;
      if (S.slowTimer) clearTimeout(S.slowTimer);
      // legacy: a hint after 90 s, the reading can be cancelled (files not yet sent stay queued; a file already with the
      // AI finishes and is kept, since it is charged)
      S.slowTimer = setTimeout(function () { if (S.running) { S.slow = true; renderSlots(); announce(T('read_slow')); } }, 90000);
      renderSlots();
      announce(T('reading_n', { n: todo.length }));
      pool(todo, 3, readOne, function () { return S.cancel; }).then(function () {
        S.running = false; S.slow = false;
        if (S.slowTimer) { clearTimeout(S.slowTimer); S.slowTimer = null; }
        if (S.cancel) announce(T('read_cancelled'));
        return reloadBatch();
      }).then(function () {
        return loadReadings();
      }).then(function () {
        render();
        var got = todo.filter(function (q) { return q.status === 'done' || q.status === 'reused'; }).length;
        announce(T('read_done_n', { n: got, total: todo.length }));
        if (got) {
          if (!S.userEdited) return merge({ silent: true });
          S.newDocs = true; renderReview();
        }
      }).catch(function (e) {
        S.running = false; S.slow = false;
        if (S.slowTimer) { clearTimeout(S.slowTimer); S.slowTimer = null; }
        render(); toast(errMsg(e), 'error');
      });
    }
    function cancelRead() {
      if (!S.running || S.cancel) return;
      S.cancel = true;
      renderSlots();
    }
    function setQ(q, status, error) { q.status = status; q.error = error || ''; renderQueueItem(q); }
    function readOne(q) {
      var batch = S.batch;
      var hashP = q.sha ? Promise.resolve(q.sha) : sha256(q.file).then(function (h) { q.sha = h; return h; });
      if (S.cancel) return Promise.resolve(null);
      return hashP.then(function (h) {
        if (S.cancel) return null;
        // dedupe before any call: the same file already in this batch, or queued twice in this run
        var dup = inBatch(batch.documents, h);
        if (dup) { setQ(q, 'skipped', T('q_in_batch', { slot: slotName(dup.slot) })); return null; }
        var dq = queueDup(S.queue, q);
        if (dq) { setQ(q, 'skipped', T('q_dup_queue', { slot: slotName(dq.slot) })); return null; }
        setQ(q, 'sending');
        return fileB64(q.file).then(function (b64) {
          setQ(q, 'reading');
          return API.aiExtract({ orgId: S.orgId || undefined, docType: q.slot, file: { media_type: q.mime, data_b64: b64 },
            transactionId: batch.transaction_id || undefined, lang: lang(), promptVersion: 'ai-doc-v3' });
        }).then(function (r) {
          if (!r || r.error || !r.data) throw (r && r.error) || new Error(T('err_generic'));
          var res = r.data;
          q.res = res;
          if (!res.reused && S.remaining != null) S.remaining = Math.max(0, S.remaining - 1);
          var act = readingAction(q.slot, res);
          if (act.action === 'wrong_slot') {
            q.detected = act.detected; q.target = act.target;
            setQ(q, 'wrong', T('q_wrong', { slot: slotName(q.slot), kind: kindName(act.detected) }));
            return null;
          }
          return placeReading(q, q.slot);
        });
      }).catch(function (e) { q.retry = true; setQ(q, 'error', errMsg(e)); return null; });
    }
    // save (fresh reading) or reuse (reused:true), then attach to the slot
    function placeReading(q, slot) {
      var res = q.res, batch = S.batch;
      var idP;
      if (res.reused && isUuid(res.extraction_id)) {
        idP = Promise.resolve(res.extraction_id);
      } else {
        setQ(q, 'saving');
        var row = extractionRow({ res: res, file: q.file, sha256: q.sha, mime: q.mime, docType: slot, orgId: S.orgId,
          transactionId: batch.transaction_id || null });
        idP = API.saveExtraction(row).then(function (r) {
          if (!r.error) return r.data.id;
          if (r.error.code !== 'MRS_EXTRACTION_DUPLICATE' || !has('findExtractionBySource')) throw r.error;
          // the same file was saved before (e.g. by a v2 reading): reuse it when it is the same kind
          return API.findExtractionBySource({ orgId: S.orgId || undefined, sha256: row.source_sha256, transactionId: row.transaction_id || null }).then(function (f) {
            if (f.error || !f.data) throw r.error;
            if (f.data.doc_type !== slot) { var e = new Error(T('q_dup_kind', { kind: kindName(f.data.doc_type) })); e.code = 'MRS_DOC_WRONG_SLOT'; throw e; }
            q.reusedSaved = true;
            return f.data.id;
          });
        });
      }
      return idP.then(function (extId) {
        q.extractionId = extId;
        S.readings[extId] = readingOf(res);
        setQ(q, 'attaching');
        return API.attachDocBatchDocument(batch.id, extId, slot);
      }).then(function (a) {
        if (a.error) throw a.error;
        if (a.data && a.data.batch && S.batch && S.batch.id === batch.id) {
          // summary only: the documents list comes with the reload after the run
          if (a.data.batch.transaction_id && !S.batch.transaction_id) { S.batch.transaction_id = a.data.batch.transaction_id; S.batch.transaction_ref = a.data.batch.transaction_ref; }
        }
        q.slot = slot;
        setQ(q, res.reused || q.reusedSaved ? 'reused' : 'done', res.reused ? T('q_reused_free') : '');
        return true;
      });
    }
    function moveQueued(q) {
      if (!q.target || !q.res) return;
      if (slotRoom(S.batch.documents, q.target, queuedFor(q.target) - (q.slot === q.target ? 1 : 0)) <= 0) { toast(T('slot_full', { slot: slotName(q.target) }), 'warning'); return; }
      var to = q.target;
      placeReading(q, to).then(function () {
        return reloadBatch();
      }).then(function () {
        render();
        if (!S.userEdited) merge({ silent: true }); else { S.newDocs = true; renderReview(); }
      }).catch(function (e) { setQ(q, 'wrong', errMsg(e)); });
    }
    function removeQueued(q) {
      S.queue = S.queue.filter(function (x) { return x !== q; });
      renderSlots();
    }
    function detachDoc(doc) {
      askConfirm({ title: T('detach_title'), text: T('detach_text', { name: doc.source_name || slotName(doc.slot) }), okText: T('detach'), danger: true }).then(function (yes) {
        if (!yes) return;
        API.detachDocBatchDocument(doc.id, T('detach_reason')).then(function (r) {
          if (r.error) { toast(errMsg(r.error), 'error'); return; }
          reloadBatch().then(function () {
            render();
            if (!S.userEdited) merge({ silent: true }); else { S.newDocs = true; renderReview(); }
          });
        }, function (e) { toast(errMsg(e), 'error'); });
      });
    }

    /* ---------------------------------------------------------------
       Merge + draft save
       --------------------------------------------------------------- */
    function merge(o) {
      o = o || {};
      if (!S.batch) return Promise.resolve();
      var id = S.batch.id;
      return API.mergeDocBatch(id).then(function (r) {
        if (!S.batch || S.batch.id !== id) return null;
        if (r.error) { toast(errMsg(r.error), 'error'); return null; }
        var m = r.data || {};
        S.mergeConflicts = Array.isArray(m.merge_conflicts) ? m.merge_conflicts : [];
        if (o.keepDraft) {
          renderReview();
          return null;
        }
        S.draft = clone(m.draft) || {};
        S.comparison = m.comparison || S.comparison;
        if (typeof m.version === 'number') S.version = m.version;
        S.userEdited = false; S.newDocs = false; S.invalid = [];
        if (!S.matchName) S.matchName = consigneeName(S.draft);
        renderReview();
        if (S.batch.status === 'draft' && S.writer && !draftEmpty(S.draft)) { S.dirty = true; return saveNow(); }
        return null;
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function remerge() {
      if (!S.userEdited) { merge(); return; }
      askConfirm({ title: T('remerge_title'), text: T('remerge_text'), okText: T('remerge'), danger: true }).then(function (y) { if (y) merge(); });
    }
    function clientMatchState() {
      return { source_name: S.matchName || null, client_id: S.clientId || null, confirmed: !!S.confirmClient, target: S.target,
        operation: S.operation, mode: S.mode, result: S.match ? { candidates: (S.match.candidates || []).slice(0, 10), best: S.match.best || null,
          suggested: !!S.match.suggested, conflict: !!S.match.conflict, thresholds: S.match.thresholds || null } : null };
    }
    function scheduleSave() {
      S.dirty = true;
      renderSaveState();
      if (S.saveTimer) clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(function () { S.saveTimer = null; saveNow(); }, 1500);
    }
    // → Promise<boolean> (true = the server has the current draft)
    function saveNow() {
      if (!S.batch || S.batch.status !== 'draft' || !S.writer) return Promise.resolve(false);
      if (S.stale) return Promise.resolve(false);
      if (S.saving) { S.saveAgain = true; return S.savingP; }
      if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
      var n = normalizeDraft(S.draft);
      S.invalid = n.errors;
      markInvalid();
      if (n.errors.length) { renderSaveState(); return Promise.resolve(false); }
      S.saving = true; S.saveAgain = false; S.dirty = false;
      renderSaveState();
      var id = S.batch.id, payload = { version: S.version, draft: n.draft, clientMatch: clientMatchState() };
      if (S.clientId !== (S.batch.client_id || null)) payload.clientId = S.clientId || null;
      S.savingP = API.saveDocBatchDraft(id, payload).then(function (r) {
        S.saving = false;
        if (!S.batch || S.batch.id !== id) return false;
        if (r.error) {
          S.dirty = true;
          if (r.error.code === 'MRS_DOC_BATCH_STALE') { S.stale = true; renderReview(); return false; }
          renderSaveState(errMsg(r.error));
          return false;
        }
        takeBatch(r.data, false);
        S.comparison = r.data.comparison || S.comparison;
        renderComparison(); markFlags(); renderSaveState(); renderHead();
        if (S.saveAgain || S.dirty) { S.saveAgain = false; return saveNow(); }
        return true;
      }, function (e) { S.saving = false; S.dirty = true; renderSaveState(errMsg(e)); return false; });
      return S.savingP;
    }
    function reloadStale() {
      var id = S.batch && S.batch.id;
      if (!id) return;
      S.batch = null;
      openBatch(id);
    }

    /* ---------------------------------------------------------------
       Render: head + slots
       --------------------------------------------------------------- */
    function render() {
      renderHead();
      renderSlots();
      renderReview();
      renderPending();
    }
    function renderHead() {
      var box = document.getElementById('docb-head');
      if (!box) { box = el('div', 'docb-head'); box.id = 'docb-head'; root.appendChild(box); }
      box.textContent = '';
      var tools = el('div', 'docb-head-tools');
      if (S.writer) {
        var nb = btn(S.pendingTx ? T('new_for_tx', { ref: S.pendingTx.ref || '' }) : T('new_batch'), 'btn-primary', function () { createBatch(S.pendingTx ? S.pendingTx.id : null); });
        nb.id = 'docb-new-btn';
        tools.appendChild(nb);
        if (S.needBranch && S.branches.length > 1) {
          var lab = el('label', 'docb-inline');
          lab.appendChild(el('span', null, T('branch')));
          var sel = el('select', 'form-control'); sel.id = 'docb-new-branch';
          S.branches.forEach(function (b) { var o = el('option', null, b.name_ar || b.code || b.id); o.value = b.id; sel.appendChild(o); });
          lab.appendChild(sel);
          tools.appendChild(lab);
        }
      } else tools.appendChild(el('p', 'text-sm text-muted mb-0', T('read_only_role')));
      box.appendChild(tools);
      if (S.pendingTx && !S.batch) box.appendChild(alertBox('info', T('tx_no_draft', { ref: S.pendingTx.ref || '' })));
      if (!S.ai) box.appendChild(alertBox('warning', T('ai_off')));
      else if (S.remaining != null) box.appendChild(el('p', 'text-sm text-muted mb-0', T('ai_remaining', { n: S.remaining })));
      var b = S.batch;
      if (!b) return;
      var card = el('div', 'docb-meta');
      var t = el('div', 'docb-meta-title');
      t.appendChild(el('span', 'badge badge-sm badge-' + (STATUS_TONE[b.status] || 'muted'), statusName(b.status)));
      t.appendChild(el('strong', null, ' ' + T('batch_no', { id: String(b.id).slice(0, 8) })));
      card.appendChild(t);
      var dl = el('dl', 'docb-dl');
      function row(k, v) { if (v == null || v === '') return; var d = el('div'); d.appendChild(el('dt', null, k)); var dd = el('dd'); if (typeof v === 'string') dd.appendChild(bdi(v)); else dd.appendChild(v); d.appendChild(dd); dl.appendChild(d); }
      if (b.transaction_id) {
        var a = el('a', null, b.transaction_ref || String(b.transaction_id).slice(0, 8)); a.href = 'admin.html#tx/' + b.transaction_id; a.dir = 'ltr';
        row(T('m_tx'), a);
      } else row(T('m_tx'), T('m_tx_none'));
      row(T('m_branch'), branchName(b.branch_id));
      row(T('m_bl'), b.bl_number || '');
      row(T('m_client'), b.client_name || '');
      row(T('m_docs'), String(b.document_count != null ? b.document_count : (b.documents || []).length));
      row(T('m_version'), String(b.version));
      row(T('m_created'), [b.created_by_name, fmtDate(b.created_at)].filter(Boolean).join(' · '));
      if (b.approved_at) row(T('m_approved'), fmtDate(b.approved_at));
      if (b.closed_at) row(T('m_closed'), fmtDate(b.closed_at) + (b.close_reason ? ' — ' + b.close_reason : ''));
      card.appendChild(dl);
      var acts = batchActions(b.status, S.writer), at = el('div', 'docb-head-tools');
      if (acts.discard) at.appendChild(btn(T('discard'), 'btn-ghost docb-danger', function () { discard(b); }));
      if (acts.archive) at.appendChild(btn(T('archive'), 'btn-ghost', function () { archive(b); }));
      at.appendChild(btn(T('close_batch'), 'btn-ghost', function () { resetBatchState(); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ } render(); }));
      card.appendChild(at);
      card.appendChild(el('p', 'text-sm text-muted mb-0', T('draft_rule')));
      box.appendChild(card);
    }
    function renderSlots() {
      var box = document.getElementById('docb-slots');
      if (!box) { box = el('div', 'docb-slots'); box.id = 'docb-slots'; root.appendChild(box); }
      box.textContent = '';
      var b = S.batch;
      box.hidden = !b;
      if (!b) return;
      var canAttach = batchActions(b.status, S.writer).attach;
      var grid = el('div', 'docb-slot-grid');
      SLOTS.forEach(function (slot) {
        var docs = (b.documents || []).filter(function (d) { return d.slot === slot; });
        var card = el('div', 'docb-slot');
        card.setAttribute('data-slot', slot);
        var h = el('div', 'docb-slot-head');
        h.appendChild(el('span', 'docb-slot-title', slotName(slot)));
        h.appendChild(el('span', 'badge badge-sm ' + (slot === 'customs_declaration' ? 'badge-muted' : 'badge-navy'),
          slot === 'customs_declaration' ? T('optional') : (slot === 'bill_of_lading' ? T('required') : T('up_to', { n: SLOT_MAX[slot] }))));
        h.appendChild(el('span', 'docb-slot-count num', docs.length + ' / ' + SLOT_MAX[slot]));
        card.appendChild(h);
        var ul = el('ul', 'docb-doc-list');
        docs.forEach(function (d) {
          var li = el('li', 'docb-doc');
          var main = el('div', 'docb-doc-main');
          main.appendChild(el('span', 'docb-doc-name', d.source_name || slotName(slot)));
          var sub = el('span', 'docb-doc-sub');
          var bits = [];
          if (SLOT_MAX[slot] > 1) bits.push('#' + d.seq);
          if (d.mean_confidence != null) bits.push(T('conf', { n: Math.round(Number(d.mean_confidence)) }));
          if (d.prompt_version) bits.push(d.prompt_version);
          if (d.review_status) bits.push(T('rev_' + d.review_status) === 'rev_' + d.review_status ? d.review_status : T('rev_' + d.review_status));
          sub.textContent = bits.join(' · ');
          main.appendChild(sub);
          if (d.extraction_voided) main.appendChild(el('span', 'badge badge-sm badge-danger', T('voided_reading')));
          li.appendChild(main);
          if (canAttach) li.appendChild(btn(T('detach'), 'btn-ghost', function () { detachDoc(d); }));
          ul.appendChild(li);
        });
        S.queue.filter(function (q) { return q.slot === slot || (q.status === 'wrong' && q.slot === slot); }).forEach(function (q) { ul.appendChild(queueItem(q)); });
        card.appendChild(ul);
        if (canAttach && slotRoom(b.documents, slot, queuedFor(slot)) > 0) {
          var drop = el('label', 'dropzone docb-drop');
          var inp = el('input'); inp.type = 'file'; inp.accept = '.jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf';
          inp.multiple = SLOT_MAX[slot] > 1; inp.className = 'docb-file'; inp.disabled = S.running;
          inp.setAttribute('aria-label', T('add_file_aria', { slot: slotName(slot) }));
          inp.addEventListener('change', function () { addFiles(slot, this.files); this.value = ''; });
          drop.appendChild(inp);
          drop.appendChild(el('span', 'dropzone-title', SLOT_MAX[slot] > 1 ? T('drop_many') : T('drop_one')));
          drop.appendChild(el('span', 'dropzone-sub', T('formats')));
          ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-dragover'); }); });
          ['dragleave', 'dragend'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('is-dragover'); }); });
          drop.addEventListener('drop', function (e) {
            e.preventDefault(); drop.classList.remove('is-dragover');
            if (e.dataTransfer && e.dataTransfer.files) addFiles(slot, e.dataTransfer.files);
          });
          card.appendChild(drop);
        }
        grid.appendChild(card);
      });
      box.appendChild(grid);
      var waiting = S.queue.filter(function (q) { return q.status === 'queued' || (q.status === 'error' && q.retry); }).length;
      var bar = el('div', 'docb-read-bar');
      if (canAttach) {
        var rb = btn(S.running ? T('reading') : T('read_all', { n: waiting }), 'btn-primary', readAll);
        rb.disabled = S.running || !waiting || !S.ai;
        bar.appendChild(rb);
        if (S.running) {
          var cb = btn(S.cancel ? T('read_cancelling') : T('read_cancel'), 'btn-ghost', cancelRead);
          cb.disabled = !!S.cancel;
          bar.appendChild(cb);
        }
      }
      if (S.running && S.slow) bar.appendChild(el('span', 'docb-q-msg', T('read_slow')));
      bar.appendChild(el('span', 'text-sm text-muted', T('dedupe_hint')));
      box.appendChild(bar);
    }
    function queueItem(q) {
      var li = el('li', 'docb-doc docb-q is-' + q.status);
      li.setAttribute('data-q', String(q.id));
      fillQueueItem(li, q);
      return li;
    }
    function renderQueueItem(q) {
      var li = root.querySelector('[data-q="' + q.id + '"]');
      if (li) { li.className = 'docb-doc docb-q is-' + q.status; li.textContent = ''; fillQueueItem(li, q); }
    }
    function fillQueueItem(li, q) {
      var main = el('div', 'docb-doc-main');
      main.appendChild(el('span', 'docb-doc-name', q.file ? q.file.name : ''));
      var sub = el('span', 'docb-doc-sub', [q.file ? fmtSize(q.file.size) : '', T(q.status === 'wrong' ? 'q_wrong_short' : 'q_' + q.status)].filter(Boolean).join(' · '));
      main.appendChild(sub);
      if (q.error) main.appendChild(el('span', 'docb-q-msg', q.error));
      li.appendChild(main);
      var tools = el('div', 'docb-q-tools');
      if (q.status === 'wrong') {
        if (q.target) tools.appendChild(btn(T('move_to', { slot: slotName(q.target) }), 'btn-secondary', function () { moveQueued(q); }));
        tools.appendChild(btn(T('remove'), 'btn-ghost', function () { removeQueued(q); }));
      } else if (['queued', 'error', 'skipped', 'done', 'reused'].indexOf(q.status) !== -1 && !S.running) {
        tools.appendChild(btn(['done', 'reused', 'skipped'].indexOf(q.status) !== -1 ? T('dismiss') : T('remove'), 'btn-ghost', function () { removeQueued(q); }));
      }
      li.appendChild(tools);
    }

    /* ---------------------------------------------------------------
       Render: review (draft, comparison, client, target, approve)
       --------------------------------------------------------------- */
    function renderReview() {
      var box = document.getElementById('docb-review');
      if (!box) { box = el('div', 'docb-review'); box.id = 'docb-review'; root.appendChild(box); }
      box.textContent = '';
      var b = S.batch;
      box.hidden = !b;
      if (!b) return;
      var editable = batchActions(b.status, S.writer).edit;
      box.appendChild(el('h3', 'docb-h3', T('review_title')));
      if (S.stale) {
        var st = alertBox('warning', T('stale'));
        st.appendChild(btn(T('reload'), 'btn-secondary', reloadStale));
        box.appendChild(st);
      }
      if (S.newDocs && editable) {
        var nd = alertBox('info', T('new_docs'));
        nd.appendChild(btn(T('remerge'), 'btn-secondary', remerge));
        box.appendChild(nd);
      }
      if (b.status === 'approved') box.appendChild(renderApproved());
      if (!(b.documents || []).length && draftEmpty(S.draft)) { box.appendChild(el('p', 'text-muted', T('no_docs_yet'))); return; }
      // merge conflicts (two documents of the same kind disagree)
      var mc = S.mergeConflicts.filter(function (m) { return m && m.field; });
      if (mc.length) {
        var mb = el('div', 'docb-merge');
        mb.appendChild(el('h4', 'docb-h4', T('merge_title', { n: mc.length })));
        var ul = el('ul', 'docb-merge-list');
        mc.forEach(function (m) {
          var li = el('li');
          if (m.field === 'items_truncated') { li.appendChild(el('span', null, T('items_truncated', { section: T('sec_' + m.section) }))); ul.appendChild(li); return; }
          li.appendChild(el('strong', null, T('sec_' + m.section) + ' · ' + fieldLabel(m.section, m.field) + ': '));
          (m.values || []).forEach(function (v) {
            var label = slotName(v.slot) + (v.seq ? ' #' + v.seq : '') + ': ' + (v.value == null ? '—' : String(v.value));
            if (editable) {
              var cb = btn(label, 'btn-ghost docb-pick', function () {
                setPath(S.draft, m.section + '.' + m.field, v.value);
                var inp = root.querySelector('[data-path="' + m.section + '.' + m.field + '"]');
                if (inp) inp.value = v.value == null ? '' : String(v.value);
                S.userEdited = true; scheduleSave();
                toast(T('picked'), 'success');
              });
              cb.title = T('use_value');
              li.appendChild(cb);
            } else li.appendChild(el('span', 'docb-chip', label));
          });
          ul.appendChild(li);
        });
        mb.appendChild(ul);
        box.appendChild(mb);
      }
      var cmp = el('div', 'docb-cmp'); cmp.id = 'docb-cmp';
      box.appendChild(cmp);
      renderComparison();
      box.appendChild(renderDraftForm(editable));
      var ss = el('div', 'docb-save-state'); ss.id = 'docb-save-state';
      box.appendChild(ss);
      renderSaveState();
      if (b.status === 'draft') {
        box.appendChild(renderClient(editable));
        box.appendChild(renderTarget(editable));
        box.appendChild(renderApprove());
      }
      markFlags();
      markInvalid();
    }
    function renderComparison() {
      var box = document.getElementById('docb-cmp');
      if (!box) return;
      box.textContent = '';
      var c = S.comparison || {};
      var rows = (Array.isArray(c.conflicts) ? c.conflicts : []).concat(Array.isArray(c.matches) ? c.matches : []);
      var head = el('div', 'docb-cmp-head');
      head.appendChild(el('h4', 'docb-h4', T('cmp_title')));
      var counts = el('div', 'docb-cmp-counts');
      counts.appendChild(el('span', 'docb-chip is-conflict', T('cmp_conflicts', { n: (c.conflicts || []).length })));
      counts.appendChild(el('span', 'docb-chip is-match', T('cmp_matches', { n: (c.matches || []).length })));
      counts.appendChild(el('span', 'docb-chip is-missing', T('cmp_missing', { n: (c.missing_fields || []).length })));
      head.appendChild(counts);
      box.appendChild(head);
      if (rows.length) {
        var wrap = el('div', 'table-wrap docb-table-wrap');
        var tbl = el('table', 'table docb-table');
        var cap = el('caption', 'sr-only', T('cmp_title')); tbl.appendChild(cap);
        var th = el('thead'), tr = el('tr');
        [T('col_field'), slotName('bill_of_lading'), slotName('commercial_invoice'), slotName('packing_list'), T('col_status')].forEach(function (h) { var x = el('th', null, h); x.scope = 'col'; tr.appendChild(x); });
        th.appendChild(tr); tbl.appendChild(th);
        var tb = el('tbody');
        rows.forEach(function (r) {
          var row = el('tr', 'is-' + (r.status === 'conflict' ? 'conflict' : 'match'));
          var f = el('th', null, T('cmp_' + r.field) === 'cmp_' + r.field ? String(r.field) : T('cmp_' + r.field)); f.scope = 'row';
          row.appendChild(f);
          ['bl', 'invoice', 'packing'].forEach(function (k) {
            var v = r.values ? r.values[k] : undefined;
            var td = el('td');
            td.appendChild(v === undefined || v === null ? el('span', 'text-muted', '—') : bdi(Array.isArray(v) ? v.join(', ') : String(v)));
            row.appendChild(td);
          });
          var tdS = el('td');
          tdS.appendChild(el('span', 'docb-chip ' + (r.status === 'conflict' ? 'is-conflict' : 'is-match'), r.status === 'conflict' ? T('st_conflict') : T('st_match')));
          row.appendChild(tdS);
          tb.appendChild(row);
        });
        tbl.appendChild(tb); wrap.appendChild(tbl); box.appendChild(wrap);
      } else box.appendChild(el('p', 'text-sm text-muted', T('cmp_none')));
      var miss = Array.isArray(c.missing_fields) ? c.missing_fields : [];
      if (miss.length) {
        var mp = el('p', 'docb-missing');
        mp.appendChild(el('strong', null, T('missing_title') + ' '));
        miss.forEach(function (m) { mp.appendChild(el('span', 'docb-chip is-missing', T('miss_' + m) === 'miss_' + m ? String(m) : T('miss_' + m))); });
        box.appendChild(mp);
      }
    }
    function srcBadge(path) {
      var src = fieldSources((S.batch && S.batch.documents) || [], S.readings)[path];
      if (!src) return null;
      var s = el('span', 'docb-src' + (src.confidence != null && src.confidence < 0.6 ? ' is-low' : ''));
      var txt = slotName(src.slot) + (SLOT_MAX[src.slot] > 1 ? ' #' + src.seq : '');
      if (src.confidence != null) txt += ' · ' + pct(src.confidence);
      if (src.reviewed) txt += ' · ' + T('src_reviewed');
      s.textContent = txt;
      s.title = src.source_name || '';
      return s;
    }
    function inputFor(path, value, o) {
      o = o || {};
      var inp;
      if (o.long) { inp = el('textarea', 'form-control docb-in'); inp.rows = 2; }
      else { inp = el('input', 'form-control docb-in'); inp.type = 'text'; }
      inp.value = value == null ? '' : (Array.isArray(value) ? value.join(', ') : String(value));
      inp.setAttribute('data-path', path);
      inp.dir = o.num || o.code ? 'ltr' : 'auto';
      if (o.num) inp.inputMode = 'decimal';
      inp.maxLength = o.max || 2000;
      inp.disabled = !o.editable;
      if (o.label) inp.setAttribute('aria-label', o.label);
      inp.addEventListener('input', function () {
        setPath(S.draft, path, inp.value);   // typed text; numbers / lists are parsed by normalizeDraft on save
        S.userEdited = true;
        inp.classList.add('is-edited');
        scheduleSave();
      });
      return inp;
    }
    var CODE_KEYS = ['bl_number', 'booking_number', 'invoice_number', 'packing_list_number', 'declaration_number', 'invoice_date', 'packing_list_date',
      'currency', 'container_numbers', 'seal_numbers', 'container_number', 'seal_number', 'size_type', 'supplier_hs_code'];
    function renderDraftForm(editable) {
      var wrap = el('div', 'docb-draft');
      wrap.appendChild(el('h4', 'docb-h4', T('draft_title')));
      wrap.appendChild(el('p', 'text-sm text-muted', T('draft_hint')));
      SECTIONS.forEach(function (sec) {
        var det = el('details', 'docb-sec');
        det.open = sec !== 'declaration' || !!(S.draft && S.draft.declaration);
        var sum = el('summary', null, T('sec_' + sec));
        det.appendChild(sum);
        var grid = el('div', 'docb-grid');
        var def = FIELDS[sec];
        def.text.concat(def.num, def.arr).forEach(function (k) {
          var path = sec + '.' + k, g = el('div', 'form-group docb-field');
          g.setAttribute('data-field', path);
          var id = 'docb-f-' + sec + '-' + k;
          var lab = el('label', 'form-label', fieldLabel(sec, k)); lab.htmlFor = id;
          g.appendChild(lab);
          var inp = inputFor(path, getPath(S.draft, path), { editable: editable, num: def.num.indexOf(k) !== -1, arr: def.arr.indexOf(k) !== -1,
            long: LONG_KEYS.indexOf(k) !== -1, code: CODE_KEYS.indexOf(k) !== -1 });
          inp.id = id;
          if (def.num.indexOf(k) !== -1) inp.placeholder = k === 'temperature_c' ? '-18' : '0';
          if (DATE_KEYS.indexOf(k) !== -1) inp.placeholder = 'YYYY-MM-DD';
          if (def.arr.indexOf(k) !== -1) inp.placeholder = T('list_ph');
          g.appendChild(inp);
          var sb = srcBadge(path);
          if (sb) g.appendChild(sb);
          grid.appendChild(g);
        });
        det.appendChild(grid);
        if (sec === 'shipment') det.appendChild(rowsTable('shipment.containers', CONTAINER_COLS, CONTAINER, T('containers_title'), editable, 300));
        if (sec === 'invoice') det.appendChild(rowsTable('invoice.items', INV_ITEM_COLS, INV_ITEM, T('inv_items_title'), editable, 500));
        if (sec === 'packing') det.appendChild(rowsTable('packing.items', PACK_ITEM_COLS, PACK_ITEM, T('pack_items_title'), editable, 500));
        wrap.appendChild(det);
      });
      if (S.draft && Array.isArray(S.draft.source_notes) && S.draft.source_notes.length) {
        var notes = el('details', 'docb-sec');
        notes.appendChild(el('summary', null, T('source_notes')));
        var ul = el('ul', 'docb-notes');
        S.draft.source_notes.forEach(function (n) { ul.appendChild(el('li', null, String(n))); });
        notes.appendChild(ul);
        wrap.appendChild(notes);
      }
      return wrap;
    }
    // an editable table of rows (containers / items); scrolls inside its own box at 375px
    function rowsTable(path, cols, def, title, editable, max) {
      var box = el('div', 'docb-rows');
      box.setAttribute('data-field', path);
      var head = el('div', 'docb-rows-head');
      var rows = getPath(S.draft, path);
      if (!Array.isArray(rows)) rows = [];
      head.appendChild(el('h5', 'docb-h5', title + ' (' + rows.length + ')'));
      box.appendChild(head);
      var wrap = el('div', 'table-wrap docb-table-wrap');
      var tbl = el('table', 'table docb-table docb-edit-table');
      tbl.appendChild(el('caption', 'sr-only', title));
      var th = el('thead'), tr = el('tr');
      tr.appendChild(el('th', 'num', '#'));
      cols.forEach(function (c) { var x = el('th', null, T('c_' + c)); x.scope = 'col'; tr.appendChild(x); });
      if (editable) tr.appendChild(el('th', null, ''));
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el('tbody');
      function paint() {
        tb.textContent = '';
        rows = getPath(S.draft, path);
        if (!Array.isArray(rows)) rows = [];
        if (!rows.length) {
          var e = el('tr'); var td = el('td', 'text-muted', T('rows_empty')); td.colSpan = cols.length + 2; e.appendChild(td); tb.appendChild(e);
        }
        rows.forEach(function (r, i) {
          var row = el('tr');
          row.appendChild(el('td', 'num', String(i + 1)));
          cols.forEach(function (c) {
            var td = el('td');
            var inp = inputFor(path + '.' + i + '.' + c, r ? r[c] : null, { editable: editable, num: def.num.indexOf(c) !== -1, code: CODE_KEYS.indexOf(c) !== -1,
              max: c === 'seal_number' ? 30 : c === 'size_type' ? 10 : c === 'container_number' ? 11 : 2000, label: T('c_' + c) + ' #' + (i + 1) });
            inp.classList.add('docb-cell');
            if (c === 'description' || c === 'notes') inp.classList.add('is-wide');
            td.appendChild(inp);
            row.appendChild(td);
          });
          if (editable) {
            var tdx = el('td');
            tdx.appendChild(btn(T('row_remove'), 'btn-ghost docb-danger', function () {
              var list = getPath(S.draft, path);
              list.splice(i, 1);
              S.userEdited = true; paint(); head.firstChild.textContent = title + ' (' + list.length + ')'; scheduleSave();
            }));
            row.appendChild(tdx);
          }
          tb.appendChild(row);
        });
        markInvalid();
      }
      paint();
      tbl.appendChild(tb); wrap.appendChild(tbl); box.appendChild(wrap);
      if (editable) {
        var add = btn(T('row_add'), 'btn-ghost', function () {
          var list = getPath(S.draft, path);
          if (!Array.isArray(list)) { list = []; setPath(S.draft, path, list); }
          if (list.length >= max) { toast(T('rows_max', { n: max }), 'warning'); return; }
          list.push({});
          S.userEdited = true; paint(); head.firstChild.textContent = title + ' (' + list.length + ')';
          var last = tb.querySelector('tr:last-child input'); if (last) last.focus();
        });
        box.appendChild(add);
      }
      return box;
    }
    function markFlags() {
      var flags = flaggedPaths(S.comparison, S.mergeConflicts);
      Array.prototype.forEach.call(root.querySelectorAll('[data-field]'), function (g) {
        var f = flags[g.getAttribute('data-field')] || [];
        g.classList.toggle('is-conflict', f.some(function (x) { return x.kind === 'conflict' || x.kind === 'merge'; }));
        g.classList.toggle('is-missing', f.some(function (x) { return x.kind === 'missing'; }));
      });
    }
    function markInvalid() {
      var bad = {};
      S.invalid.forEach(function (p) { bad[p] = 1; });
      Array.prototype.forEach.call(root.querySelectorAll('[data-path]'), function (inp) {
        var on = !!bad[inp.getAttribute('data-path')];
        inp.classList.toggle('is-invalid', on);
        if (on) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      });
    }
    function renderSaveState(err) {
      var box = document.getElementById('docb-save-state');
      if (!box) return;
      box.textContent = '';
      var b = S.batch;
      if (!b || b.status !== 'draft' || !S.writer) return;
      var msg, cls = 'text-sm';
      if (err) { msg = T('save_failed', { e: err }); cls += ' docb-err'; }
      else if (S.invalid.length) { msg = T('save_invalid', { n: S.invalid.length }); cls += ' docb-err'; }
      else if (S.saving) msg = T('saving');
      else if (S.dirty) msg = T('unsaved');
      else msg = T('saved_v', { v: S.version });
      box.appendChild(el('span', cls, msg));
      var tools = el('div', 'docb-head-tools');
      var sv = btn(T('save_draft'), 'btn-secondary', function () { saveNow(); });
      sv.disabled = S.saving || S.stale;
      tools.appendChild(sv);
      tools.appendChild(btn(T('remerge'), 'btn-ghost', remerge));
      box.appendChild(tools);
    }

    /* ---- client matching ---- */
    function renderClient(editable) {
      var box = el('div', 'docb-block'); box.id = 'docb-client';
      box.appendChild(el('h4', 'docb-h4', T('client_title')));
      box.appendChild(el('p', 'text-sm text-muted', T('client_hint')));
      var row = el('div', 'docb-inline-form');
      var inp = el('input', 'form-control'); inp.type = 'search'; inp.dir = 'auto'; inp.maxLength = 300; inp.id = 'docb-match-name';
      inp.value = S.matchName || consigneeName(S.draft);
      inp.setAttribute('aria-label', T('client_name'));
      inp.disabled = !editable;
      inp.addEventListener('input', function () { S.matchName = inp.value; });
      row.appendChild(inp);
      var mb = btn(T('client_match'), 'btn-secondary', function () { runMatch(inp.value); });
      mb.disabled = !editable;
      row.appendChild(mb);
      box.appendChild(row);
      var res = el('div', 'docb-match'); res.id = 'docb-match';
      box.appendChild(res);
      paintMatch(editable);
      return box;
    }
    function runMatch(name) {
      name = String(name || '').trim();
      S.matchName = name;
      if (!name) { toast(T('client_need_name'), 'warning'); return; }
      orgP().then(function (oid) { return API.matchClientV2({ orgId: oid || undefined, name: name, limit: 10 }); }).then(function (r) {
        if (r.error) { toast(errMsg(r.error), 'error'); return; }
        S.match = r.data || null;
        var v = matchView(S.match);
        if (v.preselect && !S.clientId) pickClient(v.preselect, (v.candidates.filter(function (c) { return c.client_id === v.preselect; })[0] || {}).name_ar || '');
        paintMatch(true);
        scheduleSave();
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function pickClient(id, name) {
      S.clientId = id || null; S.clientName = name || '';
      paintMatch(true);
      paintTarget();
    }
    function paintMatch(editable) {
      var box = document.getElementById('docb-match');
      if (!box) return;
      box.textContent = '';
      var v = matchView(S.match);
      if (S.match) {
        box.appendChild(el('p', 'text-sm', T('match_state_' + v.state)));
        if (v.candidates.length) {
          var ul = el('ul', 'docb-cands');
          v.candidates.forEach(function (c) {
            var li = el('li', 'docb-cand' + (c.client_id === S.clientId ? ' is-picked' : ''));
            var lab = el('label', 'check');
            var r = el('input'); r.type = 'radio'; r.name = 'docb-client'; r.value = c.client_id; r.checked = c.client_id === S.clientId; r.disabled = !editable;
            r.addEventListener('change', function () { if (r.checked) { pickClient(c.client_id, c.name_ar || c.name_en || ''); scheduleSave(); } });
            lab.appendChild(r);
            var t = el('span', 'docb-cand-main');
            t.appendChild(bdi([c.name_ar, c.name_en].filter(Boolean).join(' · ')));
            var sub = el('span', 'docb-doc-sub', T('cand_conf', { n: Math.round(Number(c.confidence) || 0) }) + ' · ' + T('meth_' + c.method)
              + (c.review ? ' · ' + T('cand_review') : ''));
            t.appendChild(sub);
            if (Array.isArray(c.reasons) && c.reasons.length) {
              t.appendChild(el('span', 'docb-doc-sub', c.reasons.slice(0, 3).map(function (x) {
                return T('rsn_' + x) === 'rsn_' + x ? String(x) : T('rsn_' + x);
              }).join(' · ')));
            }
            lab.appendChild(t);
            li.appendChild(lab);
            ul.appendChild(li);
          });
          box.appendChild(ul);
        }
      }
      // manual pick when the matcher found nothing useful
      if (editable && has('listClients')) {
        var row = el('div', 'docb-inline-form');
        var q = el('input', 'form-control'); q.type = 'search'; q.dir = 'auto'; q.placeholder = T('client_search_ph'); q.setAttribute('aria-label', T('client_search_ph'));
        var sel = el('select', 'form-control'); sel.setAttribute('aria-label', T('client_pick'));
        var o0 = el('option', null, T('client_pick')); o0.value = ''; sel.appendChild(o0);
        var go = btn(T('search'), 'btn-ghost', function () {
          orgP().then(function (oid) { return API.listClients({ orgId: oid || undefined, search: q.value.trim(), limit: 15 }); }).then(function (r) {
            sel.textContent = ''; sel.appendChild(o0);
            if (r.error) { toast(errMsg(r.error), 'error'); return; }
            (r.data || []).forEach(function (c) { var o = el('option', null, [c.name_ar, c.name_en].filter(Boolean).join(' · ')); o.value = c.id; sel.appendChild(o); });
            if ((r.data || []).length) sel.focus();
          });
        });
        sel.addEventListener('change', function () {
          if (!sel.value) return;
          pickClient(sel.value, sel.options[sel.selectedIndex].textContent);
          scheduleSave();
        });
        row.appendChild(q); row.appendChild(go); row.appendChild(sel);
        box.appendChild(row);
      }
      if (S.clientId) {
        var pk = el('p', 'docb-picked');
        pk.appendChild(el('strong', null, T('client_chosen') + ' '));
        pk.appendChild(bdi(S.clientName || String(S.clientId).slice(0, 8)));
        box.appendChild(pk);
      }
      // confirm = the approval stores the consignee name as an approved alias (else only suggested)
      var cl = el('label', 'check docb-confirm');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!S.confirmClient; cb.disabled = !editable || !(S.clientId || S.txClientId || (S.batch && S.batch.transaction_id));
      cb.id = 'docb-confirm-client';
      cb.addEventListener('change', function () { S.confirmClient = cb.checked; scheduleSave(); });
      cl.appendChild(cb);
      cl.appendChild(el('span', null, T('client_confirm', { name: aliasName() || '—', client: targetClientName() || '—' })));
      box.appendChild(cl);
      box.appendChild(el('p', 'text-sm text-muted', T('client_confirm_hint')));
      var warn = clientWarning();
      if (warn) box.appendChild(alertBox('warning', warn));
    }
    // the name approve_doc_batch stores as the alias: the saved draft's identity name (batch.importer_name, the server's
    // own rule), else — with unsaved edits — the draft's consignee name; never the free match-search text
    function aliasName() {
      if (!S.dirty && S.batch && S.batch.importer_name) return String(S.batch.importer_name);
      return consigneeName(S.draft);
    }
    function targetClientName() {
      if (S.target === 'existing' && (S.txId || (S.batch && S.batch.transaction_id))) return S.txClientName || (S.batch && S.batch.client_name) || '';
      return S.clientName || '';
    }
    function clientWarning() {
      if (S.target !== 'existing' || !S.txClientId || !S.clientId || S.txClientId === S.clientId) return '';
      return T('client_differs', { tx: S.txClientName || '', client: S.clientName || '' });
    }

    /* ---- target transaction + shipping agent ---- */
    function renderTarget(editable) {
      var box = el('div', 'docb-block'); box.id = 'docb-target';
      box.appendChild(el('h4', 'docb-h4', T('target_title')));
      var body = el('div'); body.id = 'docb-target-body';
      box.appendChild(body);
      paintTarget(editable);
      loadTxClient();
      loadAgents();
      return box;
    }
    function loadTxClient() {
      var id = (S.batch && S.batch.transaction_id) || S.txId;
      if (!id || !has('getTransaction') || S.txClientFor === id) return;
      S.txClientFor = id;
      API.getTransaction(id).then(function (r) {
        if (!r || r.error || !r.data) return;
        S.txClientId = r.data.client_id || null;
        S.txClientName = (r.data.clients && r.data.clients.name_ar) || '';
        if (!S.txLabel) S.txLabel = r.data.ref || '';
        paintTarget(); paintMatch(batchActions(S.batch && S.batch.status, S.writer).edit);
      }, function () { /* label only */ });
    }
    function paintTarget(editable) {
      var body = document.getElementById('docb-target-body');
      if (!body) return;
      if (editable == null) editable = batchActions(S.batch && S.batch.status, S.writer).edit;
      body.textContent = '';
      var b = S.batch;
      if (b && b.transaction_id) {
        var p = el('p');
        p.appendChild(el('span', null, T('target_fixed') + ' '));
        var a = el('a', null, b.transaction_ref || S.txLabel || String(b.transaction_id).slice(0, 8)); a.href = 'admin.html#tx/' + b.transaction_id; a.dir = 'ltr';
        p.appendChild(a);
        if (S.txClientName) { p.appendChild(el('span', null, ' · ' + T('target_client') + ' ')); p.appendChild(bdi(S.txClientName)); }
        body.appendChild(p);
        body.appendChild(el('p', 'text-sm text-muted', T('target_fill_rule')));
      } else {
        var fs = el('div', 'docb-radios');
        ['existing', 'new'].forEach(function (k) {
          var lab = el('label', 'check');
          var r = el('input'); r.type = 'radio'; r.name = 'docb-target'; r.value = k; r.checked = S.target === k; r.disabled = !editable;
          r.addEventListener('change', function () { if (r.checked) { S.target = k; paintTarget(); paintMatch(editable); scheduleSave(); } });
          lab.appendChild(r); lab.appendChild(el('span', null, T('target_' + k)));
          fs.appendChild(lab);
        });
        body.appendChild(fs);
        if (S.target === 'existing') {
          var row = el('div', 'docb-inline-form');
          var q = el('input', 'form-control'); q.type = 'search'; q.dir = 'ltr'; q.placeholder = T('tx_search_ph'); q.setAttribute('aria-label', T('tx_search_ph'));
          q.value = S.txQuery || (S.draft && S.draft.shipment && S.draft.shipment.bl_number) || '';
          var sel = el('select', 'form-control'); sel.id = 'docb-tx'; sel.setAttribute('aria-label', T('tx_pick'));
          var o0 = el('option', null, T('tx_pick')); o0.value = ''; sel.appendChild(o0);
          if (S.txId) { var oc = el('option', null, S.txLabel || String(S.txId).slice(0, 8)); oc.value = S.txId; oc.selected = true; sel.appendChild(oc); }
          sel.disabled = !editable;
          var go = btn(T('search'), 'btn-ghost', function () {
            S.txQuery = q.value.trim();
            orgP().then(function (oid) { return API.listTransactions({ orgId: oid || undefined, search: S.txQuery, limit: 15, cancelled: 'exclude' }); }).then(function (r) {
              sel.textContent = ''; sel.appendChild(o0);
              if (r.error) { toast(errMsg(r.error), 'error'); return; }
              (r.data || []).forEach(function (t) {
                var o = el('option', null, [t.ref, t.bl_number, t.clients && t.clients.name_ar].filter(Boolean).join(' — '));
                o.value = t.id; o.setAttribute('data-client', t.client_id || ''); o.setAttribute('data-client-name', (t.clients && t.clients.name_ar) || '');
                o.setAttribute('data-ref', t.ref || '');
                sel.appendChild(o);
              });
              announce((r.data || []).length ? T('tx_found', { n: r.data.length }) : T('tx_none_found'));
              if ((r.data || []).length) sel.focus();
            });
          });
          go.disabled = !editable;
          sel.addEventListener('change', function () {
            var o = sel.options[sel.selectedIndex];
            S.txId = sel.value || null;
            S.txLabel = o ? (o.getAttribute('data-ref') || o.textContent) : '';
            S.txClientId = o ? o.getAttribute('data-client') || null : null;
            S.txClientName = o ? o.getAttribute('data-client-name') || '' : '';
            S.txClientFor = S.txId;
            paintMatch(editable);
            var w = document.getElementById('docb-target-warn'); if (w) w.textContent = clientWarning();
          });
          row.appendChild(q); row.appendChild(go); row.appendChild(sel);
          body.appendChild(row);
          var tw = el('p', 'text-sm docb-err'); tw.id = 'docb-target-warn'; tw.textContent = clientWarning();
          body.appendChild(tw);
          body.appendChild(el('p', 'text-sm text-muted', T('target_fill_rule')));
        } else {
          var grid = el('div', 'docb-grid');
          var cg = el('div', 'form-group');
          cg.appendChild(el('span', 'form-label', T('target_client')));
          cg.appendChild(S.clientId ? bdi(S.clientName || String(S.clientId).slice(0, 8)) : el('span', 'docb-err', T('target_need_client')));
          grid.appendChild(cg);
          [['operation', ['import', 'export']], ['mode', ['sea', 'air', 'land']]].forEach(function (pair) {
            var g = el('div', 'form-group'), id = 'docb-new-' + pair[0];
            var lab = el('label', 'form-label', T('new_' + pair[0])); lab.htmlFor = id; g.appendChild(lab);
            var sel2 = el('select', 'form-control'); sel2.id = id; sel2.disabled = !editable;
            pair[1].forEach(function (v) { var o = el('option', null, T(pair[0] + '_' + v)); o.value = v; o.selected = S[pair[0]] === v; sel2.appendChild(o); });
            sel2.addEventListener('change', function () { S[pair[0]] = sel2.value; scheduleSave(); });
            g.appendChild(sel2); grid.appendChild(g);
          });
          body.appendChild(grid);
          body.appendChild(el('p', 'text-sm text-muted', T('target_new_rule')));
        }
      }
      // shipping agent (B/L): suggestions from match_shipping_agent(shipping_line)
      var ag = el('div', 'form-group docb-agent');
      var al = el('label', 'form-label', T('agent')); al.htmlFor = 'docb-agent'; ag.appendChild(al);
      var as = el('select', 'form-control'); as.id = 'docb-agent'; as.disabled = !editable;
      var n0 = el('option', null, T('agent_none')); n0.value = ''; as.appendChild(n0);
      S.agents.forEach(function (a) {
        var o = el('option', null, [a.name_ar, a.name_en].filter(Boolean).join(' · ') + ' (' + T('agent_' + a.match) + ')');
        o.value = a.party_id; o.selected = S.agentId === a.party_id; as.appendChild(o);
      });
      as.addEventListener('change', function () { S.agentId = as.value || null; });
      ag.appendChild(as);
      ag.appendChild(el('span', 'form-hint', S.agents.length ? T('agent_hint') : T('agent_none_found')));
      body.appendChild(ag);
    }
    function loadAgents() {
      var line = S.draft && S.draft.shipment && S.draft.shipment.shipping_line;
      line = line ? String(line).trim() : '';
      if (!has('matchShippingAgent') || !line || S.agentFor === line) return;
      S.agentFor = line;
      API.matchShippingAgent(line, { orgId: S.orgId || undefined }).then(function (r) {
        if (S.agentFor !== line) return;
        S.agents = r && !r.error && Array.isArray(r.data) ? r.data.slice(0, 10) : [];
        var exact = S.agents.filter(function (a) { return a.match === 'name' || a.match === 'alias'; });
        if (!S.agentId && exact.length === 1) S.agentId = exact[0].party_id;
        paintTarget();
      }, function () { /* optional */ });
    }

    /* ---- approve ---- */
    function renderApprove() {
      var box = el('div', 'docb-block docb-approve'); box.id = 'docb-approve';
      box.appendChild(el('h4', 'docb-h4', T('approve_title')));
      box.appendChild(el('p', 'text-sm text-muted', T('approve_hint')));
      var msg = el('div'); msg.id = 'docb-approve-msg';
      box.appendChild(msg);
      if (S.approveError) msg.appendChild(approveErrorBox(S.approveError));
      if (!S.writer) { box.appendChild(alertBox('info', T('approve_role'))); return box; }
      var ab = btn(S.approving ? T('approving') : T('approve'), 'btn-primary btn-lg', approve);
      ab.id = 'docb-approve-btn';
      ab.classList.remove('btn-sm');
      ab.disabled = S.approving || S.stale;
      box.appendChild(ab);
      return box;
    }
    function approveErrorBox(e) {
      var code = e && e.code;
      var text = errMsg(e);
      if (code === 'MRS_DUPLICATE_TX') text = T('ap_dup_tx') + ' ' + text;
      else if (code === 'MRS_DOC_BATCH_STALE') text = T('stale');
      else if (code === 'MRS_INVALID' && e.field === 'containers_roro') text = T('ap_roro') + ' ' + text;
      var a = alertBox('danger', text);
      if (code === 'MRS_DOC_BATCH_STALE') a.appendChild(btn(T('reload'), 'btn-secondary', reloadStale));
      return a;
    }
    function approve() {
      if (S.approving || !S.batch) return;
      if (!S.writer) { toast(T('approve_role'), 'warning'); return; }
      S.approveError = null;
      var flush = S.dirty || S.saveTimer || S.saving ? saveNow() : Promise.resolve(true);
      flush.then(function (ok) {
        if (ok === false && (S.dirty || S.invalid.length || S.stale)) {
          S.approveError = S.stale ? { code: 'MRS_DOC_BATCH_STALE' } : { code: 'MRS_INVALID', message: T('ap_save_first') };
          renderReview(); return;
        }
        if (draftEmpty(S.batch.draft)) { S.approveError = { code: 'MRS_REQUIRED', field: 'draft', message: T('ap_need_draft') }; renderReview(); return; }
        var p = approvePayload({ version: S.version, batchTx: S.batch.transaction_id, target: S.target, transactionId: S.txId, clientId: S.clientId,
          operation: S.operation, mode: S.mode, shippingAgentId: S.agentId, confirmClient: S.confirmClient });
        if (p.error) { S.approveError = { code: 'MRS_REQUIRED', message: T('ap_need_' + p.error) }; renderReview(); return; }
        var cmp = S.comparison || {};
        var lines = [
          T('ap_c_target', { t: S.batch.transaction_id || S.target === 'existing' ? (S.batch.transaction_ref || S.txLabel || '') : T('target_new') }),
          T('ap_c_docs', { n: (S.batch.documents || []).length }),
          T('ap_c_cmp', { c: (cmp.conflicts || []).length, m: (cmp.missing_fields || []).length }),
          S.confirmClient ? T('ap_c_alias', { name: aliasName() || '—' }) : T('ap_c_alias_suggest'),
          T('ap_c_rule')
        ];
        var txFor = S.batch.transaction_id || (S.target === 'existing' ? S.txId : null);
        var prevP = txFor && has('getTransactionShipment')
          ? API.getTransactionShipment(txFor).then(function (g) { return !!(g && !g.error && g.data && g.data.shipment_data); }, function () { return false; })
          : Promise.resolve(false);
        return prevP.then(function (prev) {
          if (prev) lines.splice(lines.length - 1, 0, T('ap_c_merge'));
          var body = document.createElement('div');
          lines.forEach(function (ln) { body.appendChild(el('p', 'docb-confirm-line', ln)); });
          return askConfirm({ title: T('ap_confirm_title'), text: lines.join('\n'), body: body, okText: T('approve'), danger: false });
        }).then(function (yes) {
          if (!yes) return;
          S.idem = approveKey(S.idem, S.version, p.o, uuid);
          if (S.idem.key) p.o.idemKey = S.idem.key;
          S.approving = true; renderReview();
          var id = S.batch.id;
          return API.approveDocBatch(id, p.o).then(function (r) {
            S.approving = false;
            if (r.error) { S.approveError = r.error; if (r.error.code === 'MRS_DOC_BATCH_STALE') S.stale = true; renderReview(); focusApprove(); return; }
            S.approveResult = r.data;
            toast(T('ap_done', { ref: (r.data && r.data.ref) || '' }), 'success');
            S.draft = null;
            return API.getDocBatch(id).then(function (g) {
              if (g && !g.error) { takeBatch(g.data); }
              render(); loadList();
            });
          }, function (e) { S.approving = false; S.approveError = e; renderReview(); focusApprove(); });
        });
      });
    }
    function focusApprove() { var m = document.getElementById('docb-approve-msg'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center' }); }
    function renderApproved() {
      var b = S.batch, r = S.approveResult || b.approve_result || {};
      var s = approveSummary(r);
      var box = el('div', 'docb-block docb-result');
      box.appendChild(el('h4', 'docb-h4', T('ap_result_title')));
      var ul = el('ul', 'docb-result-list');
      function li(text) { ul.appendChild(el('li', null, text)); }
      var txLi = el('li');
      txLi.appendChild(el('span', null, (s.created ? T('ap_r_created') : T('ap_r_tx')) + ' '));
      var txId = r.transaction_id || b.transaction_id;
      if (txId) { var a = el('a', null, s.ref || b.transaction_ref || String(txId).slice(0, 8)); a.href = 'admin.html#tx/' + txId; a.dir = 'ltr'; txLi.appendChild(a); }
      ul.appendChild(txLi);
      if (s.replayed) li(T('ap_r_replayed'));
      li(T('ap_r_bl_' + s.bl, { n: r.bl && r.bl.bl_number || '' }));
      li(T('ap_r_containers', { a: s.added, u: s.updated, s: s.unchanged }));
      li(T('ap_r_items', { i: s.invoiceItems, p: s.packingItems }));
      li(T('ap_r_linked', { n: s.linked }));
      if (s.filled.length) li(T('ap_r_filled', { list: s.filled.map(txColName).join(listSep()) }));
      if (s.kept.length) li(T('ap_r_kept', { list: s.kept.map(txColName).join(listSep()) }));
      if (r.port_code) li(T('ap_r_port', { p: r.port_code }));
      if (s.alias) li(T('ap_r_alias_' + s.alias) === 'ap_r_alias_' + s.alias ? T('ap_r_alias_other') : T('ap_r_alias_' + s.alias));
      if (r.merged_previous) li(T('ap_r_merged', { i: r.merged_previous.invoice_items_kept ? T('ap_r_kept_yes') : T('ap_r_kept_no'),
        p: r.merged_previous.packing_items_kept ? T('ap_r_kept_yes') : T('ap_r_kept_no') }));
      li(T('ap_r_cmp', { c: s.conflicts, m: s.missing }));
      box.appendChild(ul);
      if (s.alias === 'suggested' && r.client_alias && r.client_alias.alias_id && has('rejectClientAlias') && S.writer) {
        box.appendChild(btn(T('alias_reject'), 'btn-ghost docb-danger', function (bt) {
          var why = window.prompt(T('alias_reject_reason'), '');
          if (why == null) return;
          bt.disabled = true;
          API.rejectClientAlias(r.client_alias.alias_id, why.trim().slice(0, 500) || null).then(function (x) {
            if (x.error) { bt.disabled = false; toast(errMsg(x.error), 'error'); return; }
            toast(T('alias_rejected'), 'success'); bt.remove();
          });
        }));
      }
      return box;
    }

    /* ---------------------------------------------------------------
       Discard / archive
       --------------------------------------------------------------- */
    function discard(b) {
      var why = window.prompt(T('discard_reason'), '');
      if (why == null) return;
      why = why.trim();
      if (!why) { toast(T('reason_required'), 'warning'); return; }
      API.discardDocBatch(b.id, why.slice(0, 500)).then(function (r) {
        if (r.error) { toast(errMsg(r.error), 'error'); return; }
        toast(T('discarded'), 'success');
        afterClose(b.id);
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function archive(b) {
      var why = window.prompt(T('archive_reason'), '');
      if (why == null) return;
      API.archiveDocBatch(b.id, why.trim().slice(0, 500) || null).then(function (r) {
        if (r.error) { toast(errMsg(r.error), 'error'); return; }
        toast(T('archived'), 'success');
        afterClose(b.id);
      }, function (e) { toast(errMsg(e), 'error'); });
    }
    function afterClose(id) {
      loadList();
      if (S.batch && S.batch.id === id) { S.batch = null; openBatch(id); }
    }

    /* ---------------------------------------------------------------
       Pending drafts list
       --------------------------------------------------------------- */
    var listSeq = 0;
    function loadList() {
      if (!S.staff) return;
      var seq = ++listSeq;
      orgP().then(function (oid) { return API.listPendingDocBatches({ orgId: oid || undefined, status: S.listStatus, limit: 100 }); }).then(function (r) {
        if (seq !== listSeq) return;
        S.listError = r && r.error ? errMsg(r.error) : '';
        S.list = r && !r.error && Array.isArray(r.data) ? r.data : [];
        renderPending();
      }, function (e) { S.listError = errMsg(e); renderPending(); });
    }
    function renderPending() {
      pendRoot.textContent = '';
      var tools = el('div', 'docb-list-tools');
      var st = el('select', 'form-control'); st.setAttribute('aria-label', T('list_status'));
      LIST_STATUSES.forEach(function (s) { var o = el('option', null, T('ls_' + s)); o.value = s; o.selected = S.listStatus === s; st.appendChild(o); });
      st.addEventListener('change', function () { S.listStatus = st.value; loadList(); });
      tools.appendChild(st);
      var ids = {};
      S.list.forEach(function (b) { if (b.branch_id) ids[b.branch_id] = 1; });
      var bl = Object.keys(ids);
      if (bl.length > 1 || S.listBranch) {
        var bs = el('select', 'form-control'); bs.setAttribute('aria-label', T('list_branch'));
        var b0 = el('option', null, T('all_branches')); b0.value = ''; bs.appendChild(b0);
        bl.forEach(function (id) { var o = el('option', null, branchName(id) || String(id).slice(0, 8)); o.value = id; o.selected = S.listBranch === id; bs.appendChild(o); });
        bs.addEventListener('change', function () { S.listBranch = bs.value; renderPending(); });
        tools.appendChild(bs);
      }
      var q = el('input', 'form-control'); q.type = 'search'; q.value = S.listQ; q.placeholder = T('list_q'); q.setAttribute('aria-label', T('list_q'));
      q.addEventListener('input', function () { S.listQ = q.value; paintList(); });
      tools.appendChild(q);
      tools.appendChild(btn(T('refresh'), 'btn-ghost', loadList));
      pendRoot.appendChild(tools);
      var ul = el('ul', 'ocr-history docb-list'); ul.id = 'docb-list';
      pendRoot.appendChild(ul);
      var empty = el('p', 'text-sm text-muted'); empty.id = 'docb-list-empty';
      pendRoot.appendChild(empty);
      paintList();
    }
    function paintList() {
      var ul = document.getElementById('docb-list'), empty = document.getElementById('docb-list-empty');
      if (!ul) return;
      ul.textContent = '';
      var rows = filterBatches(S.list, { branchId: S.listBranch, q: S.listQ });
      rows.forEach(function (b) {
        var li = el('li', S.batch && S.batch.id === b.id ? 'is-current' : null);
        li.appendChild(el('span', 'badge badge-sm badge-' + (STATUS_TONE[b.status] || 'muted'), statusName(b.status)));
        var main = el('div', 'ocr-h-main');
        var title = b.transaction_ref ? T('li_tx', { ref: b.transaction_ref }) : (b.bl_number ? T('li_bl', { bl: b.bl_number }) : T('li_new', { id: String(b.id).slice(0, 8) }));
        main.appendChild(el('span', 'ocr-h-name', title));
        var sub = el('div', 'ocr-h-sub');
        if (b.client_name || b.importer_name) sub.appendChild(bdi(b.client_name || b.importer_name));
        if (b.branch_id && branchName(b.branch_id)) sub.appendChild(el('span', null, branchName(b.branch_id)));
        var sl = b.slots || {};
        sub.appendChild(el('span', 'num', T('li_docs', { b: sl.bill_of_lading || 0, i: sl.commercial_invoice || 0, p: sl.packing_list || 0, d: sl.customs_declaration || 0 })));
        if (b.container_count) sub.appendChild(el('span', null, T('li_containers', { n: b.container_count })));
        if (b.conflicts_count) sub.appendChild(el('span', 'docb-chip is-conflict', T('cmp_conflicts', { n: b.conflicts_count })));
        if (b.missing_count) sub.appendChild(el('span', 'docb-chip is-missing', T('cmp_missing', { n: b.missing_count })));
        sub.appendChild(el('span', null, [b.created_by_name, fmtDate(b.updated_at || b.created_at)].filter(Boolean).join(' · ')));
        if (b.close_reason) sub.appendChild(el('span', null, T('li_reason', { r: b.close_reason })));
        main.appendChild(sub);
        li.appendChild(main);
        var tools = el('div', 'ocr-h-tools');
        tools.appendChild(btn(T('open'), 'btn-secondary', function () {
          if (location.hash === '#batch=' + b.id) { openBatch(b.id); focusSection(); } else location.hash = 'batch=' + b.id;
        }));
        var acts = batchActions(b.status, S.writer);
        if (acts.discard) tools.appendChild(btn(T('discard'), 'btn-ghost docb-danger', function () { discard(b); }));
        if (acts.archive) tools.appendChild(btn(T('archive'), 'btn-ghost', function () { archive(b); }));
        li.appendChild(tools);
        ul.appendChild(li);
      });
      empty.textContent = S.listError ? T('list_failed', { e: S.listError }) : (rows.length ? '' : T('list_empty'));
      empty.hidden = !empty.textContent;
    }

    init();
  });
})();

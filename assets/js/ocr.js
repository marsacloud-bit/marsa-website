/* =====================================================================
   مرسى | MARSA — ocr.html (قراءة الفواتير والمستندات)
   Plain IIFE, no modules. Depends on window.Marsa (main.js), window.MarsaApi
   (supa.js), window.XlsxLite (xlsx-lite.js) and window.MarsaOcrParse
   (ocr-parse.js: all text → field parsing lives there).
   - Files are decoded, pre-processed and read IN THE BROWSER. The OCR
     libraries are loaded on demand, pinned, only when the user starts:
       Tesseract.js 5.1.1 (jsDelivr; it fetches its worker, core and the
       ara/eng language data), pdf.js 3.11.174 (cdnjs), jsQR 1.4.0 (jsDelivr).
   - A PDF page with a real text layer is used as-is (no OCR).
   - ZATCA e-invoice QR (base64 TLV) values are higher-trust and prefill fields.
   - AI reading (Claude, 20261114000100): a second engine shown only online, to
     signed-in staff, when MarsaApi.aiAccess says the org admin enabled it. The
     file is then sent (base64) to the Edge Function ai-extract
     (MarsaApi.aiExtract) and from there to Anthropic; the page says so before
     the user picks it. Fields come back with a confidence 0..1 and server
     warnings (ISO 6346, VAT, totals); saving uses the same flow with engine
     'claude-opus-5-5' + ai_usage_id (+ ai_detail). When the AI reading is available
     (online, staff, enabled, quota not used up) it is the default engine; Tesseract
     stays the alternative (kept when the user picks it in this page session).
     The reading uses prompt 'ai-doc-v3' and doc type 'auto' (the widest key list
     of extract.js: every B/L, invoice and packing key) — only «بيان جمركي» is sent
     typed (its declaration hints); the detected kind then sets the type. Every
     returned field is shown (unknown keys under «حقول أخرى»), line items with their
     extra columns and the per-container rows; only the keys of
     app.extraction_field_keys() (MarsaOcrParse.DB_FIELD_KEYS) are saved.
   - Compare (2026-11-12): after a run, 2+ AI readings for different documents (invoice / B/L / declaration /
     packing list), or one file holding several documents (by_document), open the matching report of ocr-match.js
     (MarsaOcrMatch.compareReadings: no new AI call); «قارن هذه المستندات» re-opens it.
   - Save: signed-in staff (online) → MarsaApi.saveExtraction (+ optional
     transaction link and original upload); otherwise the local history
     "marsa_extractions" (MarsaApi.localExtractions).
   - "Use in request" → sessionStorage "marsa_ocr_prefill" → request.html?from=ocr
   - Original page layout (site header / page-hero / footer from main.js).
     app-shell.js (window.MarsaShell, classic helper) only adds the Ctrl/⌘K
     palette, the [data-shell-org] switcher and the toast / confirm dialogs;
     without it Marsa.toast / window.confirm are used. The tool keeps working
     for visitors and in demo mode with the local history. Server history and
     the transaction picker follow the active organization (marsa:orgchange).
   Untrusted OCR text is only ever written with textContent / value.
   ===================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var M = window.Marsa || {};
    var X = window.XlsxLite;
    var P = window.MarsaOcrParse;
    var API = window.MarsaApi || null;
    var $ = function (id) { return document.getElementById(id); };
    var qsa = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
    var Shell = window.MarsaShell || null;
    var toast = Shell && typeof Shell.toast === 'function' ? function (m, t) { Shell.toast(m, t); }
      : (M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } });
    // Promise<boolean>: the shell dialog when present, else the browser's
    function ask(o) {
      if (Shell && typeof Shell.confirm === 'function') return Promise.resolve(Shell.confirm(o)).then(function (v) { return !!v; });
      return Promise.resolve(window.confirm(o.text || o.title));
    }
    // the static page-hero breadcrumb / title stay as in the markup; only mark the nav item (no-op without one)
    if (Shell && typeof Shell.setActive === 'function') Shell.setActive('ocr');

    var card = $('ocr-card');
    if (!card || !P) return;

    var ONLINE = !!(API && API.isOnline && API.isOnline());
    qsa('[data-show-mode]').forEach(function (n) {
      n.hidden = n.getAttribute('data-show-mode') !== (ONLINE ? 'online' : 'demo');
    });

    /* ---------------------------------------------------------------
       Constants
       --------------------------------------------------------------- */
    var LIB = {
      tesseract: { src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', global: 'Tesseract' },
      pdf: { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', global: 'pdfjsLib' },
      jsqr: { src: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', global: 'jsQR' }
    };
    var PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    var ENGINE_OCR = 'tesseract.js@5.1.1', ENGINE_PDF = 'pdf.js@3.11.174';
    var MAX_FILE = 25 * 1024 * 1024;
    var MAX_FILES = 20;
    var MAX_PAGES = 20;
    var MAX_TEXT = 200000;
    var LOW_CONF = 70;
    var PREFILL_KEY = 'marsa_ocr_prefill';
    var IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'heic', 'heif'];
    // AI reading (Claude): what the Edge Function accepts
    var ENGINE_AI = 'claude-opus-5-5';
    var AI_MAX_FILE = 10 * 1024 * 1024;           // PDF
    var AI_MAX_IMAGE = 5 * 1024 * 1024;           // image (the API's per-image limit)
    var AI_MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
    // page doc type → the AI doc type (the others are detected: 'auto')
    var AI_DOC = { commercial_invoice: 'commercial_invoice', operator_invoice: 'supplier_invoice', bill_of_lading: 'bill_of_lading',
      customs_declaration: 'customs_declaration' };
    var AI_PROMPT = 'ai-doc-v3';
    // the doc type sent to ai-extract (v3). extract.js KEYS_FOR_V3: a typed request only asks for (and only keeps) the keys
    // of that type — a B/L picked as «فاتورة تجارية» would lose notify / booking / place of receipt / freight / CBM /
    // shipping line, and a typed B/L the invoice money keys. 'auto' asks for SHIP_KEYS_V3 (every B/L, invoice, packing and
    // declaration key, the declaration keys kept only on a declaration) and the detected kind sets the type. Only the
    // customs declaration stays typed: it has its own hints (declared value as total, the B/L exactly as printed, every
    // container) that 'auto' would not send.
    function aiRequestType(t) { return t === 'customs_declaration' ? 'customs_declaration' : 'auto'; }
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var I18N = window.MarsaI18n || null;
    function T(key, vars) {
      var k = 'ocr.' + key;
      return I18N && typeof I18N.t === 'function' && (!I18N.has || I18N.has(k)) ? I18N.t(k, vars) : key;
    }

    var DOC_TYPES = [
      ['commercial_invoice', 'فاتورة تجارية'], ['operator_invoice', 'فاتورة مشغل / مورد'], ['bill_of_lading', 'بوليصة شحن'],
      ['customs_declaration', 'بيان جمركي'], ['packing_list', 'قائمة تعبئة'], ['certificate_of_origin', 'شهادة منشأ'], ['other', 'أخرى']
    ];
    var LANG_LABEL = { 'ara+eng': 'العربية والإنجليزية', eng: 'الإنجليزية', ara: 'العربية' };
    // kind → validation/normalisation; ltr = Latin/number field
    var FIELD_DEFS = [
      { key: 'invoice_number', label: 'رقم الفاتورة', kind: 'id', ltr: true },
      { key: 'invoice_date', label: 'تاريخ الفاتورة', kind: 'date', ltr: true, ph: 'YYYY-MM-DD' },
      { key: 'supplier_name', label: 'اسم المورد / البائع', kind: 'text' },
      { key: 'supplier_vat', label: 'الرقم الضريبي للمورد', kind: 'vat', ltr: true, ph: '3xxxxxxxxxxxxx3' },
      { key: 'buyer_name', label: 'اسم العميل / المشتري', kind: 'text' },
      { key: 'buyer_vat', label: 'الرقم الضريبي للعميل', kind: 'vat', ltr: true, ph: '3xxxxxxxxxxxxx3' },
      { key: 'currency', label: 'العملة', kind: 'currency', ltr: true, ph: 'SAR' },
      { key: 'subtotal', label: 'المجموع قبل الضريبة', kind: 'amount', ltr: true },
      { key: 'vat_amount', label: 'ضريبة القيمة المضافة', kind: 'amount', ltr: true },
      { key: 'total', label: 'الإجمالي شامل الضريبة', kind: 'amount', ltr: true },
      { key: 'bl_number', label: 'رقم البوليصة', kind: 'id', ltr: true },
      { key: 'container_numbers', label: 'أرقام الحاويات', kind: 'containers', ltr: true, ph: 'MSCU1234565, …' },
      { key: 'declaration_number', label: 'رقم البيان الجمركي', kind: 'digits', ltr: true },
      { key: 'hs_codes', label: 'رموز HS', kind: 'hs', ltr: true, ph: '8708.30, …' },
      { key: 'country_of_origin', label: 'بلد المنشأ', kind: 'text' },
      { key: 'iban', label: 'رقم الآيبان (IBAN)', kind: 'iban', ltr: true },
      // B/L / shipping keys (AI reading, and the text parser since fields v2); FX_LAYOUT decides where they show
      { key: 'vessel', label: T('f_vessel'), kind: 'text', ai: true },
      { key: 'voyage', label: T('f_voyage'), kind: 'id', ltr: true, ai: true },
      { key: 'port_of_loading', label: T('f_port_of_loading'), kind: 'text', ai: true },
      { key: 'port_of_discharge', label: T('f_port_of_discharge'), kind: 'text', ai: true },
      { key: 'shipper', label: T('f_shipper'), kind: 'text', ai: true },
      { key: 'consignee', label: T('f_consignee'), kind: 'text', ai: true },
      // AI reading v2 (ai-doc-v2): weights in kg, packages, goods, delivery term
      { key: 'gross_weight', label: T('f_gross_weight'), kind: 'text', ltr: true, ai: true },
      { key: 'net_weight', label: T('f_net_weight'), kind: 'text', ltr: true, ai: true },
      { key: 'packages_count', label: T('f_packages_count'), kind: 'text', ltr: true, ai: true },
      { key: 'package_type', label: T('f_package_type'), kind: 'text', ltr: true, ai: true },
      { key: 'goods_description', label: T('f_goods_description'), kind: 'text', ai: true },
      { key: 'incoterms', label: T('f_incoterms'), kind: 'text', ltr: true, ai: true },
      // AI reading v3 (ai-doc-v3, 20261119000100): the extended shipping keys
      { key: 'seal_numbers', label: T('f_seal_numbers'), kind: 'list', ltr: true, ai: true },
      { key: 'consignee_name', label: T('f_consignee_name'), kind: 'text', ai: true },
      { key: 'notify_party', label: T('f_notify_party'), kind: 'text', ai: true },
      { key: 'booking_number', label: T('f_booking_number'), kind: 'id', ltr: true, ai: true },
      { key: 'place_of_receipt', label: T('f_place_of_receipt'), kind: 'text', ai: true },
      { key: 'place_of_delivery', label: T('f_place_of_delivery'), kind: 'text', ai: true },
      { key: 'freight_terms', label: T('f_freight_terms'), kind: 'text', ai: true },
      { key: 'measurement_cbm', label: T('f_measurement_cbm'), kind: 'text', ltr: true, ai: true },
      { key: 'temperature_c', label: T('f_temperature_c'), kind: 'text', ltr: true, ai: true },
      { key: 'shipping_line', label: T('f_shipping_line'), kind: 'text', ai: true },
      { key: 'export_country', label: T('f_export_country'), kind: 'text', ai: true },
      { key: 'payment_terms', label: T('f_payment_terms'), kind: 'text', ai: true },
      { key: 'packing_list_number', label: T('f_packing_list_number'), kind: 'id', ltr: true, ai: true },
      { key: 'packing_list_date', label: T('f_packing_list_date'), kind: 'date', ltr: true, ph: 'YYYY-MM-DD', ai: true },
      // declaration reading (20261120000100): returned on a customs declaration only
      { key: 'declaration_type', label: T('f_declaration_type'), kind: 'text', ai: true },
      { key: 'declaration_status', label: T('f_declaration_status'), kind: 'text', ai: true },
      { key: 'declaration_date', label: T('f_declaration_date'), kind: 'date', ltr: true, ph: 'YYYY-MM-DD', ai: true },
      { key: 'declaration_date_hijri', label: T('f_declaration_date_hijri'), kind: 'text', ltr: true, ph: 'yyyy/mm/dd', ai: true },
      { key: 'importer_name_ar', label: T('f_importer_name_ar'), kind: 'text', ai: true },
      { key: 'broker_name', label: T('f_broker_name'), kind: 'text', ai: true },
      { key: 'local_value', label: T('f_local_value'), kind: 'amount', ltr: true, ai: true },
      { key: 'payment_method', label: T('f_payment_method'), kind: 'text', ai: true }
    ];
    // a key a reading returned that has no definition here: shown under «حقول أخرى» with a label made from the key
    var EXTRA_DEFS = Object.create(null);
    function humanKey(k) { var x = String(k || '').replace(/_+/g, ' ').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) : String(k); }
    function extraDef(k) {
      if (!EXTRA_DEFS[k]) EXTRA_DEFS[k] = { key: k, label: humanKey(k), kind: 'text', extra: true };
      return EXTRA_DEFS[k];
    }
    // the keys saved (app.extraction_field_keys of the live schema); the others are display-only
    var SAVE_KEYS = P && P.DB_FIELD_KEYS ? P.DB_FIELD_KEYS : (P ? P.FIELD_KEYS : []);
    var FIELD_LABEL = {};
    FIELD_DEFS.forEach(function (d) { FIELD_LABEL[d.key] = d.label; });
    var CONF_LABEL = { high: 'ثقة عالية', medium: 'ثقة متوسطة', low: 'ثقة منخفضة — راجعه', manual: 'معدّل يدويًا' };
    var STATUS_LABEL = { unreviewed: 'لم تتم المراجعة', reviewed: 'تمت المراجعة', rejected: 'مرفوض' };
    var TESS_STATUS = {
      'loading tesseract core': 'تنزيل محرك القراءة…', 'initializing tesseract': 'تهيئة محرك القراءة…',
      'initialized tesseract': 'تهيئة محرك القراءة…', 'loading language traineddata': 'تنزيل ملفات اللغة…',
      'loading language traineddata (from cache)': 'تحميل ملفات اللغة…', 'loaded language traineddata': 'تحميل ملفات اللغة…',
      'initializing api': 'تهيئة اللغة…', 'initialized api': 'تهيئة اللغة…', 'recognizing text': 'قراءة النص…'
    };

    var ICON = {
      file: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
      pdf: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h2a1.5 1.5 0 0 1 0 3H8v-3zM8 16v2M13 13v5h1.5a1.5 1.5 0 0 0 1.5-1.5v-2a1.5 1.5 0 0 0-1.5-1.5z"/></svg>',
      rotL: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
      rotR: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
      play: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
      eye: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      x: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    };

    /* ---------------------------------------------------------------
       Small helpers
       --------------------------------------------------------------- */
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function iconBtn(html, label, cls) {
      var b = el('button', 'ocr-icon-btn' + (cls ? ' ' + cls : ''));
      b.type = 'button'; b.innerHTML = html;            // static, trusted icon markup only
      b.setAttribute('aria-label', label); b.title = label;
      return b;
    }
    function fmtSize(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
      return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function ext(name) { var i = String(name || '').lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''; }
    function isPdf(f) { return f.type === 'application/pdf' || ext(f.name) === 'pdf'; }
    function isImage(f) { return /^image\//.test(f.type || '') || IMG_EXT.indexOf(ext(f.name)) !== -1; }
    function uid() { return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function baseName(n) { return String(n || 'document').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'document'; }
    function fmtDate(iso) {
      try { return new Date(iso).toLocaleString('ar-SA-u-nu-latn-ca-gregory', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return String(iso || ''); }
    }
    function announce(msg) { var s = $('ocr-status'); if (s) s.textContent = msg; }
    function errMsg(err) { return (err && err.message) || (API && API.errorMessage ? API.errorMessage(err) : 'حدث خطأ غير متوقع. حاول مرة أخرى.'); }

    function loadLib(name) {
      var lib = LIB[name];
      if (window[lib.global]) return Promise.resolve(window[lib.global]);
      if (lib.p) return lib.p;
      lib.p = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = lib.src; s.async = true; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
        s.onload = function () { window[lib.global] ? resolve(window[lib.global]) : reject(new Error('lib')); };
        s.onerror = function () { reject(new Error('lib')); };
        document.head.appendChild(s);
      }).catch(function (e) {
        lib.p = null;     // allow a retry
        var err = new Error('تعذّر تنزيل مكتبة القراءة. تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى (تحتاج القراءة إلى الإنترنت عند أول استخدام).');
        err.cause = e;
        throw err;
      });
      return lib.p;
    }
    function sha256(file) {
      if (API && API.util && API.util.sha256Hex) return API.util.sha256Hex(file).catch(function () { return ''; });
      if (!(window.crypto && crypto.subtle)) return Promise.resolve('');
      return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return ''; });
    }
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
      }
      return Promise.resolve(legacyCopy(text));
    }
    function legacyCopy(text) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var okc = document.execCommand('copy');
        document.body.removeChild(ta);
        return okc;
      } catch (e) { return false; }
    }
    function download(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    /* ---------------------------------------------------------------
       State
       --------------------------------------------------------------- */
    // job = { id, file|null, name, size, mime, rotation, status, progress, statusText, error, thumbUrl,
    //         docType, langs, text, confidence, engine, pages, pageCount, truncated, qr, qrOther,
    //         fields {key:{value,confidence,source,alt?}}, items [], extracted {}, sha256,
    //         saved: { id, where:'server'|'local', row } | null }
    var jobs = [];
    var currentId = null;
    var running = false, cancelRequested = false;
    // Tesseract's terminate() leaves a running recognize() pending forever, so every
    // engine call is raced against this per-run cancel promise.
    var cancelGate = null;
    function newGate() {
      var g = {};
      g.p = new Promise(function (resolve, reject) { g.reject = reject; });
      g.p.catch(function () {});
      return g;
    }
    function gated(p) { return cancelGate ? Promise.race([p, cancelGate.p]) : p; }
    var worker = null, workerLangs = '', logSink = null;
    var STAFF = false;
    var AI = { enabled: false, remaining: null };     // ai_access of the active org (staff, online)

    var queueEl = $('ocr-queue');
    var fileInput = $('ocr-file');
    var camInput = $('ocr-camera');
    var dz = $('ocr-dropzone');

    function job(id) { return jobs.filter(function (j) { return j.id === id; })[0] || null; }
    function current() { return job(currentId); }

    /* ---------------------------------------------------------------
       Adding files
       --------------------------------------------------------------- */
    function addFiles(list) {
      var files = Array.prototype.slice.call(list || []);
      var added = 0;
      files.forEach(function (f) {
        if (jobs.length >= MAX_FILES) { toast('الحد الأقصى ' + MAX_FILES + ' مستندًا في المرة الواحدة.', 'warning'); return; }
        // the same file twice in the queue = two readings (and two AI charges) of one document: skipped
        var dup = jobs.some(function (o) { return o.file && o.file.name === f.name && o.file.size === f.size && o.file.lastModified === f.lastModified; });
        if (dup) { toast(T('fx_dup_file', { name: f.name || '' }), 'info'); return; }
        var j = { id: uid(), file: f, name: f.name || 'camera.jpg', size: f.size, mime: f.type || '', rotation: 0, status: 'queued',
          progress: 0, statusText: 'بانتظار القراءة', error: '', thumbUrl: '', saved: null };
        if (f.size > MAX_FILE) { j.status = 'error'; j.error = 'حجم الملف أكبر من 25 ميغابايت.'; }
        else if (!isPdf(f) && !isImage(f)) { j.status = 'error'; j.error = 'صيغة غير مدعومة. استخدم صورة (JPG / PNG / WEBP) أو ملف PDF.'; }
        else if (isImage(f)) { try { j.thumbUrl = URL.createObjectURL(f); } catch (e) { j.thumbUrl = ''; } }
        jobs.push(j); added++;
      });
      if (added) { renderQueue(); announce('أضيف ' + added + ' مستند إلى القائمة.'); }
    }
    fileInput.addEventListener('change', function () { addFiles(this.files); this.value = ''; });
    camInput.addEventListener('change', function () { addFiles(this.files); this.value = ''; });
    $('ocr-camera-btn').addEventListener('click', function () { camInput.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-dragover'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.remove('is-dragover'); }); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) { if (!e.target.closest || !e.target.closest('.dropzone')) e.preventDefault(); });
    });

    /* ---------------------------------------------------------------
       Queue rendering
       --------------------------------------------------------------- */
    function renderQueue() {
      queueEl.textContent = '';
      jobs.forEach(function (j, idx) {
        var li = el('li', 'file-item' + (j.status === 'error' ? ' is-error' : '') + (j.id === currentId ? ' is-current' : ''));
        li.setAttribute('data-job', j.id);
        var th = el('div', 'ocr-thumb');
        if (j.thumbUrl) {
          var img = el('img'); img.alt = ''; img.src = j.thumbUrl;
          if (!j.processedThumb) img.style.transform = 'rotate(' + j.rotation + 'deg)';
          th.appendChild(img);
        } else th.innerHTML = j.file && isPdf(j.file) ? ICON.pdf : ICON.file;
        li.appendChild(th);

        var body = el('div', 'ocr-q-body');
        var nm = el('span', 'ocr-q-name', j.name); nm.title = j.name;
        body.appendChild(nm);
        var meta = el('div', 'ocr-q-meta');
        if (j.size != null) meta.appendChild(el('span', 'num', fmtSize(j.size)));
        if (j.pageCount) meta.appendChild(el('span', null, 'الصفحات: ' + Math.min(j.pageCount, MAX_PAGES) + (j.truncated ? ' من ' + j.pageCount : '')));
        if (j.rotation) meta.appendChild(el('span', null, 'تدوير ' + j.rotation + '°'));
        if (!j.file && j.saved) meta.appendChild(el('span', null, 'من السجل'));
        var st = el('span', 'ocr-q-status' + (j.status === 'error' ? ' is-error' : j.status === 'done' ? ' is-done' : ''),
          j.status === 'error' ? j.error : j.status === 'done' ? doneLabel(j) : j.statusText);
        meta.appendChild(st);
        body.appendChild(meta);
        if (j.status === 'running') {
          var pr = el('div', 'progress ocr-mini-progress');
          pr.setAttribute('role', 'progressbar'); pr.setAttribute('aria-label', 'تقدّم قراءة ' + j.name);
          pr.setAttribute('aria-valuemin', '0'); pr.setAttribute('aria-valuemax', '100'); pr.setAttribute('aria-valuenow', String(Math.round(j.progress)));
          var bar = el('div', 'progress-bar'); bar.style.width = Math.round(j.progress) + '%';
          pr.appendChild(bar); body.appendChild(pr);
        }
        li.appendChild(body);

        var tools = el('div', 'ocr-q-tools');
        var busy = running;
        if (j.file && j.status !== 'error') {
          var rl = iconBtn(ICON.rotL, 'تدوير ' + j.name + ' 90° عكس عقارب الساعة'); rl.setAttribute('data-act', 'rotl');
          var rr = iconBtn(ICON.rotR, 'تدوير ' + j.name + ' 90° مع عقارب الساعة'); rr.setAttribute('data-act', 'rotr');
          rl.disabled = rr.disabled = busy;
          tools.appendChild(rr); tools.appendChild(rl);
          if (j.status === 'done' || j.status === 'cancelled') {
            var re = iconBtn(ICON.play, 'إعادة قراءة ' + j.name); re.setAttribute('data-act', 'rerun'); re.disabled = busy;
            tools.appendChild(re);
          }
        }
        if (j.status === 'done') {
          var vw = iconBtn(ICON.eye, 'عرض نتيجة ' + j.name); vw.setAttribute('data-act', 'view');
          if (j.id === currentId) vw.setAttribute('aria-pressed', 'true');
          tools.appendChild(vw);
        }
        var rm = iconBtn(ICON.x, 'إزالة ' + j.name + ' من القائمة', 'is-danger'); rm.setAttribute('data-act', 'remove');
        rm.disabled = busy && j.status === 'running';
        tools.appendChild(rm);
        li.appendChild(tools);
        li.setAttribute('aria-label', 'المستند ' + (idx + 1) + ': ' + j.name);
        queueEl.appendChild(li);
      });
      var pending = jobs.filter(function (j) { return j.status === 'queued' || j.status === 'cancelled'; }).length;
      $('ocr-queue-actions').hidden = !jobs.length;
      $('ocr-start').disabled = running || !pending;
      $('ocr-start-count').textContent = pending ? '(' + pending + ')' : '';
      $('ocr-cancel').hidden = !running;
      $('ocr-clear').disabled = running;
    }
    function doneLabel(j) {
      var s = 'تمت القراءة';
      if (j.confidence != null) s += ' — الدقة ' + Math.round(j.confidence) + '%';
      if (j.qr) s += ' — رمز QR ✓';
      return s;
    }
    queueEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var li = b.closest('[data-job]'), j = li && job(li.getAttribute('data-job'));
      if (!j) return;
      var act = b.getAttribute('data-act');
      if (act === 'rotl' || act === 'rotr') {
        j.rotation = (j.rotation + (act === 'rotr' ? 90 : 270)) % 360;
        if (j.processedThumb && j.file && isImage(j.file)) { try { j.thumbUrl = URL.createObjectURL(j.file); } catch (er) { /* keep */ } j.processedThumb = false; }
        if (j.status === 'done') j.statusText = 'تغيّر التدوير — أعد القراءة لتطبيقه';
        renderQueue();
        focusTool(j.id, act);
        announce('التدوير الآن ' + j.rotation + '°.');
      } else if (act === 'rerun') {
        j.status = 'queued'; j.statusText = 'بانتظار القراءة';
        renderQueue(); runQueue();
      } else if (act === 'view') {
        showResult(j.id, true);
      } else if (act === 'remove') {
        if (j.status === 'running') return;
        if (j.thumbUrl && /^blob:/.test(j.thumbUrl)) { try { URL.revokeObjectURL(j.thumbUrl); } catch (er) { /* noop */ } }
        jobs = jobs.filter(function (x) { return x !== j; });
        if (currentId === j.id) { currentId = null; $('ocr-result-block').hidden = true; }
        renderQueue();
        var next = queueEl.querySelector('button') || fileInput;
        next.focus();
        announce('أُزيل ' + j.name + ' من القائمة.');
      }
    });
    function focusTool(id, act) {
      var b = queueEl.querySelector('[data-job="' + id + '"] button[data-act="' + act + '"]');
      if (b) b.focus();
    }
    $('ocr-clear').addEventListener('click', function () {
      if (running) return;
      jobs.forEach(function (j) { if (j.thumbUrl && /^blob:/.test(j.thumbUrl)) { try { URL.revokeObjectURL(j.thumbUrl); } catch (e) { /* noop */ } } });
      jobs = []; currentId = null; $('ocr-result-block').hidden = true;
      renderQueue(); fileInput.focus();
    });

    /* ---------------------------------------------------------------
       Progress (overall bar + per-job mini bar)
       --------------------------------------------------------------- */
    var progressBox = $('ocr-progress'), progressBar = $('ocr-progress-bar');
    var lastAnnounce = 0;
    function setProgress(j, pct, text, force) {
      j.progress = Math.max(0, Math.min(100, pct));
      if (text) j.statusText = text;
      var li = queueEl.querySelector('[data-job="' + j.id + '"]');
      if (li) {
        var bar = li.querySelector('.progress-bar'), pr = li.querySelector('[role="progressbar"]'), st = li.querySelector('.ocr-q-status');
        if (bar) bar.style.width = Math.round(j.progress) + '%';
        if (pr) pr.setAttribute('aria-valuenow', String(Math.round(j.progress)));
        if (st && text) st.textContent = text;
      }
      var idx = jobs.indexOf(j) + 1, n = jobs.length;
      var label = 'المستند ' + idx + ' من ' + n + ': ' + (j.statusText || '');
      $('ocr-progress-label').textContent = label;
      $('ocr-progress-pct').textContent = Math.round(j.progress) + '%';
      progressBar.setAttribute('aria-valuenow', String(Math.round(j.progress)));
      progressBar.querySelector('.progress-bar').style.width = Math.round(j.progress) + '%';
      var now = Date.now();
      if (force || now - lastAnnounce > 4000) { lastAnnounce = now; announce(label); }
    }

    /* ---------------------------------------------------------------
       Image decode + pre-processing
       --------------------------------------------------------------- */
    function decodeImage(file) {
      if (window.createImageBitmap) {
        return createImageBitmap(file).catch(function () { return decodeViaImg(file); });
      }
      return decodeViaImg(file);
    }
    function decodeViaImg(file) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error(/hei[cf]/.test(ext(file.name)) || /hei[cf]/.test(file.type)
            ? 'متصفحك لا يستطيع فتح صور HEIC. التقط الصورة بصيغة JPG (من إعدادات الكاميرا: «الأكثر توافقًا») أو حوّلها ثم ارفعها.'
            : 'تعذّر فتح الصورة. قد يكون الملف تالفًا أو بصيغة غير مدعومة.'));
        };
        img.src = url;
      });
    }
    // draw source (bitmap / img / canvas) rotated + scaled to a sensible OCR size
    function toCanvas(src, rotation, maxSide) {
      var w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
      var long = Math.max(w, h), scale = 1;
      if (long > (maxSide || 3500)) scale = (maxSide || 3500) / long;
      else if (long < 1400) scale = Math.min(2, 2200 / long);
      var sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
      var rot = ((rotation || 0) % 360 + 360) % 360, swap = rot === 90 || rot === 270;
      var c = document.createElement('canvas');
      c.width = swap ? sh : sw; c.height = swap ? sw : sh;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(rot * Math.PI / 180);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
      return c;
    }
    // grayscale + 1–99% contrast stretch, optional Otsu threshold (black & white)
    function preprocess(canvas, enhance, threshold) {
      if (!enhance && !threshold) return canvas;
      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data, n = d.length / 4;
      var gray = new Uint8ClampedArray(n), hist = new Array(256), i;
      for (i = 0; i < 256; i++) hist[i] = 0;
      for (i = 0; i < n; i++) {
        var g = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
        gray[i] = g; hist[g]++;
      }
      var lo = 0, hi = 255, acc = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
      acc = 0;
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
      // a white page with under 1% ink puts both percentiles on the background (lo = hi = 255),
      // which would stretch the background to black: keep lo dark enough and the range wide enough
      lo = Math.min(lo, 128); hi = Math.max(hi, lo + 64);
      var range = Math.max(1, hi - lo);
      if (enhance || threshold) {
        for (i = 0; i < 256; i++) hist[i] = 0;
        for (i = 0; i < n; i++) { var v = (gray[i] - lo) * 255 / range; v = v < 0 ? 0 : v > 255 ? 255 : v | 0; gray[i] = v; hist[v]++; }
      }
      var t = -1;
      if (threshold) {        // Otsu
        var sum = 0, sumB = 0, wB = 0, best = 0;
        for (i = 0; i < 256; i++) sum += i * hist[i];
        for (i = 0; i < 256; i++) {
          wB += hist[i]; if (!wB) continue;
          var wF = n - wB; if (!wF) break;
          sumB += i * hist[i];
          var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
          if (between > best) { best = between; t = i; }
        }
      }
      for (i = 0; i < n; i++) {
        var o = t >= 0 ? (gray[i] > t ? 255 : 0) : gray[i];
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = o; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    }
    function thumbFrom(canvas) {
      try {
        var s = 160 / Math.max(canvas.width, canvas.height), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.7);
      } catch (e) { return ''; }
    }

    /* ---------------------------------------------------------------
       QR (ZATCA) — scanned on the colour canvas before thresholding
       --------------------------------------------------------------- */
    function scanQr(canvas) {
      if (!$('ocr-qr').checked) return Promise.resolve(null);
      return loadLib('jsqr').then(function (jsQR) {
        var tries = [1200, 2400], found = null;
        for (var k = 0; k < tries.length && !found; k++) {
          var long = Math.max(canvas.width, canvas.height);
          if (k === 1 && long <= tries[0]) break;
          var s = Math.min(1, tries[k] / long), c = canvas;
          if (s < 1) {
            c = document.createElement('canvas');
            c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
            c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
          }
          var data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
          var code = jsQR(data.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
          if (code && code.data) found = code.data;
        }
        if (!found) return null;
        var qr = P.decodeZatcaQr(found);
        return qr ? { zatca: qr } : { other: true };
      }, function () { return null; });   // QR is optional: never fail the job because jsQR did not load
    }

    /* ---------------------------------------------------------------
       Tesseract worker (one, reused while the language choice is the same)
       --------------------------------------------------------------- */
    function getWorker(langs) {
      if (worker && workerLangs === langs) return Promise.resolve(worker);
      var old = worker; worker = null;
      return Promise.resolve(old ? old.terminate().catch(function () {}) : null).then(function () { return loadLib('tesseract'); })
        .then(function (T) {
          return T.createWorker(langs.split('+'), 1, {
            logger: function (m) { if (logSink) logSink(m); },
            errorHandler: function (e) { if (window.console) console.warn('[ocr]', e); }
          });
        })
        .then(function (w) {
          return w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' }).catch(function () {}).then(function () {
            worker = w; workerLangs = langs; return w;
          });
        });
    }
    function killWorker() {
      var w = worker; worker = null; workerLangs = '';
      if (w) { try { w.terminate(); } catch (e) { /* noop */ } }
    }
    function cancelled() { var e = new Error('cancelled'); e.cancelled = true; return e; }
    function ocrCanvas(j, canvas, base, span, pageLabel) {
      logSink = function (m) {
        var label = TESS_STATUS[m.status] || null;
        var frac = typeof m.progress === 'number' ? m.progress : 0;
        var pct = m.status === 'recognizing text' ? base + span * (0.15 + 0.85 * frac) : base + span * 0.15 * frac;
        setProgress(j, pct, (pageLabel ? pageLabel + ' — ' : '') + (label || 'قراءة النص…'));
      };
      return gated(getWorker(j.langs)).then(function (w) {
        if (cancelRequested) throw cancelled();
        return gated(w.recognize(canvas));
      }).then(function (r) {
        logSink = null;
        if (cancelRequested) throw cancelled();
        return { text: ((r.data && r.data.text) || '').replace(/[\u200e\u200f\u061c]/g, ''), conf: r.data && typeof r.data.confidence === 'number' ? r.data.confidence : null, method: 'ocr' };
      }, function (e) {
        logSink = null;
        if (cancelRequested) throw cancelled();
        throw e;
      });
    }

    /* ---------------------------------------------------------------
       Per-file processing
       --------------------------------------------------------------- */
    function processImageJob(j) {
      setProgress(j, 2, 'فتح الصورة…', true);
      return decodeImage(j.file).then(function (bmp) {
        var c = toCanvas(bmp, j.rotation);
        if (bmp.close) { try { bmp.close(); } catch (e) { /* noop */ } }
        return scanQr(c).then(function (qr) {
          if (cancelRequested) throw cancelled();
          if (qr && qr.zatca) j.qr = qr.zatca;
          if (qr && qr.other) j.qrOther = true;
          preprocess(c, $('ocr-enhance').checked, $('ocr-threshold').checked);
          j.thumbUrl = thumbFrom(c) || j.thumbUrl; j.processedThumb = true;
          return ocrCanvas(j, c, 5, 93, '');
        }).then(function (page) { j.pageCount = 1; return [page]; });
      });
    }
    // pdf.js text layer → lines (y from the transform matrix; Arabic lines read right-to-left)
    function layoutText(items) {
      var rows = [];
      items.forEach(function (it) {
        if (!it || typeof it.str !== 'string' || !it.str.trim()) return;
        var y = it.transform[5], x = it.transform[4];
        var row = rows.filter(function (r) { return Math.abs(r.y - y) <= Math.max(2, (it.height || 10) * 0.4); })[0];
        if (!row) { row = { y: y, parts: [] }; rows.push(row); }
        row.parts.push({ x: x, s: it.str, w: typeof it.width === 'number' ? it.width : 0, h: it.height || 10 });
      });
      rows.sort(function (a, b) { return b.y - a.y; });
      // fields v2: a wide horizontal gap between two text items is a column gap → kept as two spaces
      // (the parser splits B/L label rows / value rows on 2+ spaces); other runs of spaces collapse to one
      return rows.map(function (r) {
        var txt = r.parts.map(function (p) { return p.s; }).join(' ');
        var arabic = (txt.match(/[؀-ۿ]/g) || []).length, latin = (txt.match(/[A-Za-z]/g) || []).length;
        var rtl = arabic > latin;
        r.parts.sort(function (a, b) { return rtl ? b.x - a.x : a.x - b.x; });
        var out = '';
        r.parts.forEach(function (p, i) {
          var s = p.s.trim().replace(/[ \t\u00a0]{2,}/g, '  ');
          if (i) {
            var q = r.parts[i - 1];
            var gap = rtl ? q.x - (p.x + p.w) : p.x - (q.x + q.w);
            var cw = Math.max(2, p.h * 0.5);
            out += q.w && gap > Math.max(8, cw * 2) ? '  ' : ' ';
          }
          out += s;
        });
        return out.replace(/ {3,}/g, '  ');
      }).join('\n');
    }
    function processPdfJob(j) {
      setProgress(j, 2, 'تنزيل قارئ PDF…', true);
      var pdfDoc;
      return loadLib('pdf').then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        return j.file.arrayBuffer().then(function (buf) {
          // isEvalSupported:false — never compile font programs with eval (CVE-2024-4367 hardening)
          return pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false, disableAutoFetch: true }).promise;
        });
      }).then(function (doc) {
        pdfDoc = doc;
        j.pageCount = doc.numPages; j.truncated = doc.numPages > MAX_PAGES;
        var n = Math.min(doc.numPages, MAX_PAGES), pages = [], span = 93 / n;
        var chain = Promise.resolve();
        for (var p = 1; p <= n; p++) {
          (function (pn) {
            chain = chain.then(function () {
              if (cancelRequested) throw cancelled();
              var base = 5 + (pn - 1) * span, label = 'الصفحة ' + pn + ' من ' + n;
              setProgress(j, base, label + ' — قراءة الطبقة النصية…', pn === 1);
              return doc.getPage(pn).then(function (page) {
                return page.getTextContent().then(function (tc) {
                  var txt = layoutText(tc.items || []);
                  if (txt.replace(/\s+/g, '').length >= 40) {
                    pages.push({ text: txt, conf: null, method: 'text' });
                    if (pn === 1 && !j.qr && $('ocr-qr').checked) return renderPage(page, j.rotation, 1.5).then(function (c) {
                      if (!j.processedThumb) { j.thumbUrl = thumbFrom(c); j.processedThumb = true; }
                      return scanQr(c).then(function (qr) { if (qr && qr.zatca) j.qr = qr.zatca; if (qr && qr.other) j.qrOther = true; });
                    });
                    return null;
                  }
                  setProgress(j, base + span * 0.05, label + ' — تحويل الصفحة إلى صورة…');
                  return renderPage(page, j.rotation, 2).then(function (c) {
                    return (j.qr ? Promise.resolve(null) : scanQr(c)).then(function (qr) {
                      if (qr && qr.zatca) j.qr = qr.zatca;
                      if (qr && qr.other) j.qrOther = true;
                      preprocess(c, $('ocr-enhance').checked, $('ocr-threshold').checked);
                      if (!j.processedThumb) { j.thumbUrl = thumbFrom(c); j.processedThumb = true; }
                      return ocrCanvas(j, c, base + span * 0.1, span * 0.9, label);
                    }).then(function (res) { pages.push(res); c.width = c.height = 0; });
                  });
                }).then(function () { page.cleanup(); });
              });
            });
          })(p);
        }
        return chain.then(function () { return pages; });
      }).then(function (pages) {
        if (pdfDoc) pdfDoc.destroy();
        return pages;
      }, function (e) {
        if (pdfDoc) { try { pdfDoc.destroy(); } catch (er) { /* noop */ } }
        if (e && e.name === 'PasswordException') throw new Error('ملف PDF محمي بكلمة مرور. افتح الحماية ثم ارفعه من جديد.');
        if (e && (e.name === 'InvalidPDFException' || e.name === 'MissingPDFException')) throw new Error('تعذّر فتح ملف PDF. قد يكون تالفًا.');
        throw e;
      });
    }
    function renderPage(page, rotation, scale) {
      var vp = page.getViewport({ scale: scale, rotation: ((page.rotate || 0) + (rotation || 0)) % 360 });
      var long = Math.max(vp.width, vp.height);
      if (long > 4000) vp = page.getViewport({ scale: scale * 4000 / long, rotation: ((page.rotate || 0) + (rotation || 0)) % 360 });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () { return c; });
    }

    function finishJob(j, pages) {
      var multi = pages.length > 1;
      var text = pages.map(function (p, i) { return (multi ? '[صفحة ' + (i + 1) + ']\n' : '') + String(p.text || '').trim(); }).join('\n\n');
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      var ocrPages = pages.filter(function (p) { return p.method === 'ocr' && p.conf != null; });
      var wsum = 0, csum = 0;
      ocrPages.forEach(function (p) { var w = Math.max(1, p.text.length); wsum += w; csum += p.conf * w; });
      j.confidence = ocrPages.length ? Math.round(csum / wsum * 10) / 10 : null;
      var usedOcr = pages.some(function (p) { return p.method === 'ocr'; }), usedText = pages.some(function (p) { return p.method === 'text'; });
      j.engine = isPdf(j.file) ? (usedOcr ? ENGINE_OCR + '+' + ENGINE_PDF + (usedText ? ' (OCR + text layer)' : '') : ENGINE_PDF + ' (text layer)') : ENGINE_OCR;
      j.pages = pages.length;
      j.text = text;
      parseJob(j);
      j.status = 'done'; j.progress = 100;
    }
    function parseJob(j) {
      var res = P.extractFields(j.text, j.docType);
      if (j.qr) res = P.mergeQr(res, j.qr);
      j.fields = res.fields;
      j.items = res.lineItems.map(function (x) { return Object.assign({}, x); });
      j.extracted = P.plainFields(res.fields);
      j.machineItems = res.lineItems;
    }

    /* ---------------------------------------------------------------
       AI reading (Claude) — the file leaves the browser only here
       --------------------------------------------------------------- */
    function engineMode() {
      var r = $('ocr-engine-ai');
      return ONLINE && STAFF && AI.enabled && r && r.checked ? 'ai' : 'tesseract';
    }
    function aiMediaType(f) {
      var t = String(f.type || '').toLowerCase();
      var byType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1 ? t : null;
      return byType || AI_MEDIA[ext(f.name)] || null;
    }
    function fileB64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
        fr.onerror = function () { reject(new Error('read')); };
        fr.readAsDataURL(file);
      });
    }
    function aiLevel(c) { return c >= 0.85 ? 'high' : (c >= 0.6 ? 'medium' : 'low'); }
    // the AI answer comes back in one piece (no server-side progress): the bar keeps moving on an easing curve
    // (5% → 95%, time constant ~35 s: about 45% at 20 s, 80% at 60 s, 90% at 90 s) and jumps to 100% when done
    function aiEta(t) { return Math.min(95, 5 + 90 * (1 - Math.exp(-t / 35000))); }
    function startAiTicker(j) {
      var t0 = Date.now();
      var tick = function () {
        if (j.status !== 'running') { stopAiTicker(j); return; }
        var pct = Math.max(j.progress || 0, aiEta(Date.now() - t0));
        setProgress(j, pct, T('ai_reading') + ' ' + Math.round(pct) + '%');
      };
      stopAiTicker(j);
      j.aiTimer = setInterval(tick, 400);
      tick();
    }
    function stopAiTicker(j) { if (j && j.aiTimer) { clearInterval(j.aiTimer); j.aiTimer = null; } }
    function processAiJob(j) {
      var mt = aiMediaType(j.file);
      if (!mt) return Promise.reject(new Error(T('ai_unsupported')));
      if (j.file.size > (mt === 'application/pdf' ? AI_MAX_FILE : AI_MAX_IMAGE)) return Promise.reject(new Error(T('ai_too_large')));
      setProgress(j, 3, T('ai_sending'), true);
      return fileB64(j.file).then(function (b64) {
        startAiTicker(j);
        return activeOrg().then(function (oid) {
          return API.aiExtract({ orgId: oid || undefined, docType: aiRequestType(j.docType), promptVersion: AI_PROMPT,
            file: { media_type: mt, data_b64: b64 }, lang: I18N && I18N.lang ? I18N.lang() : 'ar' });
        });
      }).then(function (r) {
        stopAiTicker(j);
        if (r.error) throw new Error(r.error.message || T('ai_unsupported'));
        setProgress(j, 100, T('ai_reading') + ' 100%');
        var d = r.data;
        // v3: the same file already read and saved comes back as that reading (reused: no Claude call, no charge); it
        // is opened as the saved row, never saved a second time
        if (d && d.reused && UUID_RE.test(String(d.extraction_id || '')) && typeof API.getExtraction === 'function') {
          return API.getExtraction(d.extraction_id).then(function (g) {
            if (g && !g.error && g.data && g.data.id === d.extraction_id) d.savedRow = g.data;
            return d;
          }, function () { return d; });
        }
        if (AI.remaining != null && !(d && d.reused)) { AI.remaining = Math.max(0, AI.remaining - 1); showAiRemaining(); }
        return d;
      }, function (e) { stopAiTicker(j); throw e; });
    }
    // the Edge Function's answer → the job (same shape as an OCR job; untrusted values are only ever set as text)
    function finishAiJob(j, res) {
      var fields = {};
      // every returned field is kept (shown; unknown keys under «حقول أخرى»); only the DB keys are saved
      (res.fields || []).forEach(function (f) {
        if (!f || typeof f.name !== 'string' || typeof f.value !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(f.name)) return;
        var c = Number(f.confidence); if (!isFinite(c)) c = 0;
        fields[f.name] = { value: f.value, confidence: aiLevel(c), source: 'ai', score: c, page: f.page || null, valid: f.valid !== false };
      });
      j.fields = fields;
      j.items = (res.line_items || []).map(function (x) { return Object.assign({}, x); });
      j.machineItems = (res.line_items || []).map(function (x) { return Object.assign({}, x); });
      // ai-doc-v3: one row per container (number, seal, size / type, packages, weights) — shown in the items tab
      j.containers = (Array.isArray(res.containers) ? res.containers : []).filter(function (c) { return c && typeof c === 'object'; })
        .slice(0, 300).map(function (c) { return Object.assign({}, c); });
      j.extracted = P.plainFields(fields, P.DB_FIELD_KEYS);
      j.text = String(res.raw_text || '').slice(0, MAX_TEXT);
      j.confidence = res.mean_confidence == null ? null : Number(res.mean_confidence);
      j.engine = res.reused && res.engine ? String(res.engine) : ENGINE_AI; j.langs = 'auto';
      var maxPage = 0;
      (res.fields || []).forEach(function (f) { if (f && f.page > maxPage) maxPage = f.page; });
      j.pages = maxPage || null; j.pageCount = j.pages;
      // the type follows what Claude found (it was asked with 'auto', or the typed declaration was something else);
      // 'other' / an unknown kind keeps the user's choice. The change is shown on the result.
      var before = j.docType;
      var KIND = { supplier_invoice: 'operator_invoice' };
      var det = typeof res.detected_type === 'string' ? (KIND[res.detected_type] || res.detected_type) : '';
      var kind = typeof res.kind === 'string' ? res.kind : '';
      var known = function (t) { return t && t !== 'other' && DOC_TYPES.some(function (x) { return x[0] === t; }); };
      if (known(kind) && kind !== j.docType) j.docType = kind;
      var docs = Array.isArray(res.detected_documents) ? res.detected_documents : [];
      // a reused stored reading keeps the saved row's type (kind = row.doc_type, maybe corrected by the reviewer)
      if (!res.reused && known(det) && det !== j.docType && docs.indexOf(res.doc_type) === -1) j.docType = det;
      // a reused stored reading opens with its reviewed values (the same as reopening it from the history), so a save
      // never puts the machine values back over the reviewer's corrections
      var sr = res.savedRow;
      if (sr && sr.reviewed_fields && typeof sr.reviewed_fields === 'object') {
        var rv = sr.reviewed_fields;
        Object.keys(fields).forEach(function (k) { if (SAVE_KEYS.indexOf(k) !== -1 && !(typeof rv[k] === 'string' && rv[k])) delete fields[k]; });
        Object.keys(rv).forEach(function (k) {
          if (typeof rv[k] !== 'string' || !rv[k] || !/^[a-z][a-z0-9_]{0,59}$/.test(k)) return;
          if (!fields[k] || fields[k].value !== rv[k]) fields[k] = { value: rv[k], confidence: 'manual', source: 'manual' };
        });
      }
      if (sr && Array.isArray(sr.line_items)) j.items = sr.line_items.map(function (x) { return Object.assign({}, x); });
      j.ai = { usageId: res.usage_id, model: res.model || ENGINE_AI, warnings: (res.warnings || []).slice(0, 60),
        costUsd: res.usage && res.usage.cost_usd != null ? Number(res.usage.cost_usd) : null,
        typeFrom: j.docType !== before ? before : null, reused: !!res.reused,
        detail: res.ai_detail && typeof res.ai_detail === 'object' && !res.reused ? res.ai_detail : null };
      if (res.savedRow) j.saved = { id: res.savedRow.id, where: 'server', row: res.savedRow };
      // ai-doc-v3: a file holding several documents also answers each document's own values (by_document; never on a
      // reused reading) — they are compared with each other in the matching report (ocr-match.js), not saved
      var bd = res.by_document;
      j.byDocument = !res.reused && bd && typeof bd === 'object' && !Array.isArray(bd) ? bd : null;
      j.aiRes = res;
      j.status = 'done'; j.progress = 100;
    }
    function showAiRemaining() {
      var n = $('ocr-ai-remaining');
      if (n) n.textContent = AI.remaining == null ? '' : T('ai_remaining', { n: AI.remaining });
    }
    // the engine the user picked in this page session ('' = none yet): the AI reading is the default whenever it is
    // available (online + staff + enabled + quota not used up); a Tesseract pick is kept on later org / role changes
    var userEngine = '';
    function aiAvailable() { return ONLINE && STAFF && AI.enabled && AI.remaining !== 0; }
    function syncEngineUi() {
      var g = $('ocr-engine-group');
      var show = ONLINE && STAFF && AI.enabled;
      if (g) g.hidden = !show;
      if (!show && $('ocr-engine-tesseract')) $('ocr-engine-tesseract').checked = true;
      if (show && $('ocr-engine-ai') && $('ocr-engine-tesseract')) {
        if (!aiAvailable()) $('ocr-engine-tesseract').checked = true;           // quota used up: the browser reading
        else if (userEngine !== 'tesseract') $('ocr-engine-ai').checked = true;  // default: the AI reading
      }
      var note = $('ocr-ai-note');
      if (note) note.hidden = !(show && $('ocr-engine-ai') && $('ocr-engine-ai').checked);
      showAiRemaining();
    }
    qsa('input[name="ocr-engine"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) userEngine = r.value === 'tesseract' ? 'tesseract' : 'ai'; syncEngineUi(); });
    });
    // the AI mode exists only for staff of an org whose admin enabled it (MarsaApi.aiAccess = public.ai_access)
    function initAi() {
      AI.enabled = false; AI.remaining = null;
      if (!ONLINE || !STAFF || !API || typeof API.aiAccess !== 'function') { syncEngineUi(); return Promise.resolve(false); }
      return activeOrg().then(function (oid) { return API.aiAccess(oid || undefined); }).then(function (r) {
        AI.enabled = !!(r && !r.error && r.data && r.data.can_use === true);
        AI.remaining = AI.enabled && r.data.daily_remaining != null ? Number(r.data.daily_remaining) : null;
        syncEngineUi();
        return AI.enabled;
      }, function () { syncEngineUi(); return false; });
    }

    // AI readings run up to AI_PARALLEL at a time (each is one Edge Function call, ~20–90 s, mostly waiting on Claude);
    // the browser reading (Tesseract) stays one at a time: one shared worker (getWorker / logSink) and heavy canvas work.
    // Each job keeps its own state (closures over j); the cancel gate stops them all; the first job to finish is shown.
    var AI_PARALLEL = 3;
    function runQueue() {
      if (running) return;
      var todo = jobs.filter(function (j) { return j.status === 'queued' || j.status === 'cancelled'; });
      if (!todo.length) return;
      todo.forEach(function (j) { j.status = 'queued'; j.statusText = 'بانتظار القراءة'; });
      running = true; cancelRequested = false; cancelGate = newGate();
      progressBox.hidden = false;
      renderQueue();
      var firstDone = null, active = [], finished = false;
      function canStart(mode) {
        if (!active.length) return true;
        if (mode !== 'ai' || active.length >= AI_PARALLEL) return false;
        if (active.some(function (a) { return a.mode !== 'ai'; })) return false;   // never next to a Tesseract job
        // a known daily quota: never more readings in flight than remain (a reused reading costs none — the next one
        // waits for the answers). With none left and nothing in flight the job is sent: the server answers daily_cap.
        return AI.remaining == null || AI.remaining - active.length > 0;
      }
      function pump() {
        if (finished) return;
        while (!cancelRequested) {
          var j = jobs.filter(function (x) { return x.status === 'queued'; })[0];
          if (!j) break;
          var mode = engineMode();
          if (!canStart(mode)) break;
          start(j, mode);
        }
        if (!active.length) finish();
      }
      function start(j, mode) {
        j.status = 'running'; j.error = ''; j.qr = null; j.qrOther = false; j.processedThumb = false;
        j.saved = null;     // a re-read is a new extraction (new machine output)
        j.docType = $('ocr-doc-type').value; j.langs = $('ocr-langs').value;
        j.mode = mode; j.ai = null;
        active.push(j);
        renderQueue();
        setProgress(j, 0, 'تحضير الملف…', true);
        sha256(j.file).then(function (h) { j.sha256 = h; })
          .then(function () { return gated(j.mode === 'ai' ? processAiJob(j) : (isPdf(j.file) ? processPdfJob(j) : processImageJob(j))); })
          .then(function (pages) {
            if (j.mode === 'ai') finishAiJob(j, pages); else finishJob(j, pages);
            if (!firstDone) firstDone = j;
            announce('تمت قراءة ' + j.name + (j.confidence != null ? ' بدقة ' + Math.round(j.confidence) + '%' : '') + '.');
          }, function (e) {
            if ((e && e.cancelled) || cancelRequested) { j.status = 'cancelled'; j.statusText = 'أُوقفت القراءة'; return; }
            j.status = 'error';
            j.error = (e && e.message && /[\u0600-\u06ff]/.test(e.message)) ? e.message : 'تعذّرت قراءة هذا المستند. حاول مرة أخرى أو جرّب صورة أوضح.';
            if (window.console) console.warn('[ocr]', e);
          })
          .then(function () {
            active = active.filter(function (x) { return x !== j; });
            renderQueue(); pump();
          });
      }
      function finish() {
        finished = true;
        running = false;
        progressBox.hidden = true;
        var stopped = cancelRequested;
        if (cancelRequested) announce('أُوقفت القراءة. اضغط «بدء القراءة» للمتابعة.');
        cancelRequested = false; cancelGate = null;
        renderQueue();
        if (firstDone) showResult(firstDone.id, true);
        // 2+ AI readings of this run for different documents (or one combined file): the matching report, no new AI call
        if (!stopped && typeof autoCompare === 'function') autoCompare(todo);
      }
      pump();
    }
    $('ocr-start').addEventListener('click', runQueue);
    $('ocr-cancel').addEventListener('click', function () {
      if (!running) return;
      cancelRequested = true;
      if (cancelGate) cancelGate.reject(cancelled());
      killWorker();                 // stops the engine; the gate releases the pending promise
      logSink = null;
      $('ocr-cancel').hidden = true;
      announce('جارٍ إيقاف القراءة…');
    });

    /* ---------------------------------------------------------------
       Result view
       --------------------------------------------------------------- */
    var typeSel = $('ocr-result-type');
    DOC_TYPES.forEach(function (t) { var o = el('option', null, t[1]); o.value = t[0]; typeSel.appendChild(o); });

    function showResult(id, focus) {
      var j = job(id);
      if (!j || j.status !== 'done') return;
      currentId = id;
      renderQueue();
      $('ocr-result-block').hidden = false;
      $('ocr-result-title').textContent = 'النتيجة: ' + j.name;
      typeSel.value = j.docType || 'other';
      $('ocr-text').value = j.text || '';
      renderMeta(j);
      renderFields(j);
      renderItems(j);
      renderSaveState(j);
      renderCompareBox(j);
      if (focus) { $('ocr-result-title').focus(); }
    }

    /* ---------------------------------------------------------------
       Compare the readings (ocr-match.js: window.MarsaOcrMatch.compareReadings — the matching report, no new AI call)
       kind → match slot: commercial / supplier invoice → invoice, B/L → bl, customs declaration → declaration,
       packing list → packing; other kinds are not compared. Whole files first (queue order; a second file for the same
       slot is left out, with a note), then the parts of a combined file (by_document) where their slot is still free.
       --------------------------------------------------------------- */
    var MATCH_SLOT = { commercial_invoice: 'invoice', supplier_invoice: 'invoice', operator_invoice: 'invoice', bill_of_lading: 'bl',
      customs_declaration: 'declaration', packing_list: 'packing' };
    var lastRunIds = [];
    function matchApi() { var m = window.MarsaOcrMatch; return m && typeof m.compareReadings === 'function' ? m : null; }
    function cmpKind(kind) { return T('cmp_kind_' + (MATCH_SLOT[kind] ? kind : 'other')); }
    function cmpSlot(slot) { return T('cmp_slot_' + slot); }
    function listText(a) { return a.join(I18N && I18N.lang && I18N.lang() === 'en' ? ', ' : '، '); }
    function aiDone(j) { return !!(j && j.status === 'done' && j.mode === 'ai' && j.ai && j.aiRes && j.fields); }
    // the document kinds of a combined file (2+), main kind first
    function partsOf(j) {
      var bd = j && j.byDocument;
      if (!bd) return null;
      var kinds = Object.keys(bd).filter(function (k) { return /^[a-z_]{2,40}$/.test(k) && Array.isArray(bd[k]) && bd[k].length; });
      return kinds.length >= 2 ? kinds : null;
    }
    function savedGetter(j) {
      return function () {
        var r = j.saved && j.saved.where === 'server' && j.saved.row ? j.saved.row : null;
        return r && r.id ? { id: r.id, doc_type: r.doc_type || null, transaction_id: r.transaction_id || null, document_id: r.document_id || null } : null;
      };
    }
    function wholeEntry(j, slot) {
      var fields = {};
      Object.keys(j.fields || {}).forEach(function (k) {
        var f = j.fields[k];
        if (f && typeof f.value === 'string' && f.value) fields[k] = { value: f.value, score: f.score != null ? f.score : null };
      });
      return { slot: slot, label: j.name, fileName: j.name, fields: fields, items: (j.items || []).map(function (x) { return Object.assign({}, x); }),
        res: j.aiRes, file: j.file || null, sha256: j.sha256 || '', saved: savedGetter(j),
        onSaved: function (row) {
          if (!row || !row.id || j.saved) return;
          j.saved = { id: row.id, where: 'server', row: row };
          if (row.doc_type && row.doc_type !== j.docType) j.docType = row.doc_type;
          if (currentId === j.id) { typeSel.value = j.docType || 'other'; renderMeta(j); renderSaveState(j); }
        } };
    }
    // one document of a combined file: its own values (by_document) as a reading of its own (shown and compared, not saved)
    function partEntry(j, kind, slot) {
      var res = j.aiRes || {}, list = j.byDocument[kind], fields = {}, rows = [], sum = 0, n = 0;
      list.slice(0, 200).forEach(function (f) {
        if (!f || typeof f.name !== 'string' || typeof f.value !== 'string' || !/^[a-z][a-z0-9_]{0,59}$/.test(f.name)) return;
        var c = Number(f.confidence); if (!isFinite(c)) c = null;
        rows.push({ name: f.name, value: f.value, confidence: c, page: f.page || null, valid: f.valid !== false });
        if (f.value && !fields[f.name]) { fields[f.name] = { value: f.value, score: c }; if (c != null) { sum += c; n++; } }
      });
      var kinds = partsOf(j) || [];
      var main = typeof res.detected_type === 'string' && kinds.indexOf(res.detected_type) !== -1 ? res.detected_type : kinds[0];
      var itemsKind = kinds.indexOf('commercial_invoice') !== -1 ? 'commercial_invoice' : kinds.indexOf('supplier_invoice') !== -1 ? 'supplier_invoice' : main;
      // a remark about a field this document carries: the model's notes, and the server's on a value it marks invalid here
      var warnings = (res.warnings || []).filter(function (w) {
        if (!w || typeof w.text !== 'string' || !w.field || w.code === 'conflicting_values' || w.code === 'doc_type_mismatch') return false;
        var key = w.field === 'containers' ? 'container_numbers' : w.field;
        if (w.code === 'container_check_digit') return kind === main;
        if (!fields[key]) return false;
        return w.source === 'model' || rows.some(function (r) { return r.name === key && r.valid === false; });
      });
      return { slot: slot, label: j.name + ' — ' + cmpKind(kind), fileName: j.name, part: true, fields: fields,
        items: kind === itemsKind ? (j.machineItems || []).map(function (x) { return Object.assign({}, x); }) : [],
        res: { fields: rows, warnings: warnings, mean_confidence: n ? Math.round(sum / n * 1000) / 10 : null, line_items: [],
          containers: kind === main && Array.isArray(res.containers) ? res.containers : [], usage_id: res.usage_id || null,
          doc_type: kind, detected_type: kind, kind: kind, part: true },
        file: j.file || null, sha256: j.sha256 || '' };
    }
    // the comparison of a set of jobs: { entries, notes, used: [{slot, label}] } or null (fewer than 2 slots)
    function comparePlan(list) {
      var ai = list.filter(aiDone), used = {}, entries = [], notes = [];
      var whole = ai.filter(function (j) { return !partsOf(j); }), combined = ai.filter(function (j) { return !!partsOf(j); });
      whole.forEach(function (j) {
        var slot = MATCH_SLOT[j.docType];
        if (!slot) return;
        if (used[slot]) { notes.push(T('cmp_note_dup', { slot: cmpSlot(slot), used: used[slot], skipped: j.name })); return; }
        used[slot] = j.name;
        entries.push(wholeEntry(j, slot));
      });
      combined.forEach(function (j) {
        var took = [], left = [], other = [];
        partsOf(j).forEach(function (kind) {
          var slot = MATCH_SLOT[kind];
          if (!slot) { other.push(cmpKind(kind)); return; }
          if (used[slot]) { left.push(cmpKind(kind)); return; }
          used[slot] = j.name + ' — ' + cmpKind(kind);
          took.push(cmpKind(kind));
          entries.push(partEntry(j, kind, slot));
        });
        if (left.length) notes.push(T('cmp_note_combined', { file: j.name, took: took.length ? listText(took) : '—', left: listText(left) }));
        if (other.length) notes.push(T('cmp_note_other', { file: j.name, kinds: listText(other) }));
      });
      if (entries.length < 2) return null;
      return { entries: entries, notes: notes };
    }
    function openCompare(list) {
      var m = matchApi(), plan = comparePlan(list);
      if (!m || !plan) return false;
      var ok = m.compareReadings(plan.entries, { notes: plan.notes });
      if (!ok) toast(T('cmp_unavailable'), 'warning');
      return ok;
    }
    function runJobs() { return lastRunIds.map(job).filter(aiDone); }
    function autoCompare(todo) {
      lastRunIds = (todo || []).map(function (j) { return j.id; });
      var cur = current();
      if (cur) renderCompareBox(cur);
      if (!matchApi() || !matchApi().available || !matchApi().available()) return;
      openCompare(runJobs());
    }
    function planText(plan) {
      return listText(plan.entries.map(function (e) { return cmpSlot(e.slot) + ' (' + e.label + ')'; }));
    }
    function renderCompareBox(j) {
      var box = $('ocr-compare-box');
      if (!box) return;
      var m = matchApi(), ok = !!(m && (!m.available || m.available()));
      var runPlan = ok ? comparePlan(runJobs()) : null;
      var filePlan = ok && j && aiDone(j) && partsOf(j) ? comparePlan([j]) : null;
      var fb = $('ocr-compare-file-btn');
      // the run's comparison is the file's own when the run was this combined file alone
      if (filePlan && runPlan && lastRunIds.length === 1 && lastRunIds[0] === j.id) filePlan = null;
      box.hidden = !runPlan && !filePlan;
      if (box.hidden) return;
      $('ocr-compare-btn').hidden = !runPlan;
      fb.hidden = !filePlan;
      fb.textContent = filePlan ? T('cmp_file_btn', { n: filePlan.entries.length }) : '';
      fb.setAttribute('data-job', filePlan ? j.id : '');
      var parts = [];
      if (runPlan) parts.push(T('cmp_desc_run', { docs: planText(runPlan) }));
      if (filePlan) parts.push(T('cmp_desc_file', { file: j.name, docs: listText(partsOf(j).map(cmpKind)) }));
      $('ocr-compare-desc').textContent = parts.join(' ');
    }
    $('ocr-compare-btn').addEventListener('click', function () { openCompare(runJobs()); });
    $('ocr-compare-file-btn').addEventListener('click', function () {
      var j = job(this.getAttribute('data-job') || '');
      if (j) openCompare([j]);
    });
    window.addEventListener('marsa:ocrmatchready', function () { var j = current(); if (j) renderCompareBox(j); });
    function badge(cls, text) { return el('span', 'badge ' + cls, text); }
    function docTypeLabel(t) { return (DOC_TYPES.filter(function (x) { return x[0] === t; })[0] || DOC_TYPES[6])[1]; }
    function renderMeta(j) {
      var box = $('ocr-result-meta');
      box.textContent = '';
      var typeName = (DOC_TYPES.filter(function (t) { return t[0] === j.docType; })[0] || DOC_TYPES[6])[1];
      box.appendChild(badge('badge-navy', typeName));
      if (j.engine === ENGINE_AI) {
        box.appendChild(badge('badge-teal', T('ai_badge')));
        if (j.confidence != null) box.appendChild(badge(j.confidence < LOW_CONF ? 'badge-warning' : 'badge-success', T('ai_conf', { n: Math.round(j.confidence) })));
        if (j.ai && j.ai.costUsd != null && !j.ai.reused) box.appendChild(badge('badge-blue', T('ai_cost', { usd: j.ai.costUsd.toFixed(4) })));
      } else if (j.confidence != null) box.appendChild(badge(j.confidence < LOW_CONF ? 'badge-warning' : 'badge-success', 'متوسط دقة القراءة: ' + Math.round(j.confidence) + '%'));
      else box.appendChild(badge('badge-success', 'نص PDF أصلي (دون تعرّف ضوئي)'));
      if (j.pages) box.appendChild(badge('badge-blue', 'الصفحات: ' + j.pages + (j.truncated ? ' (أول ' + MAX_PAGES + ' من ' + j.pageCount + ')' : '')));
      if (j.langs && j.engine !== ENGINE_AI) box.appendChild(badge('badge-blue', 'اللغة: ' + (LANG_LABEL[j.langs] || j.langs)));
      if (j.qr) box.appendChild(badge('badge-teal', 'رمز QR للفاتورة الإلكترونية ✓'));
      else if (j.qrOther) box.appendChild(badge('badge-warning', 'رمز QR غير مطابق لصيغة الفاتورة الإلكترونية'));
      if (j.saved) box.appendChild(badge('badge-success', j.saved.where === 'server' ? 'محفوظ على الخادم' : 'محفوظ على هذا الجهاز'));
      if (j.ai && j.ai.reused) box.appendChild(badge('badge-teal', T('ai_reused')));
      // the AI found another kind of document than the one picked: the type (and the sections) follow it
      if (j.ai && j.ai.typeFrom && j.ai.typeFrom !== j.docType) box.appendChild(badge('badge-warning', T('ai_type_set', { from: docTypeLabel(j.ai.typeFrom), to: docTypeLabel(j.docType) })));
      // the weak-reading alert (fields v2) says more and replaces this one
      $('ocr-low-conf').hidden = !(j.confidence != null && j.confidence < LOW_CONF) || !!(fxWeak && !fxWeak.hidden && j.engine !== ENGINE_AI);
    }

    /* fields form */
    function validateField(def, raw) {
      var v = String(raw == null ? '' : raw).trim();
      if (!v) return { value: '', error: '', warn: '' };
      var out = { value: v, error: '', warn: '' };
      if (def.ltr) out.value = v = P.normalizeDigits(v);
      switch (def.kind) {
        case 'vat':
          v = v.replace(/[\s\-]/g, ''); out.value = v;
          if (!P.isValidSaudiVat(v)) out.error = 'الرقم الضريبي السعودي 15 رقمًا يبدأ بالرقم 3 وينتهي به.';
          break;
        case 'date':
          var d = P.normalizeDate(v);
          if (d) out.value = d; else out.error = 'تاريخ غير مفهوم. اكتبه بالصيغة YYYY-MM-DD، أو بالهجري (أم القرى) مثل 1447/03/15 هـ ويُحوَّل إلى الميلادي.';
          break;
        case 'amount':
          var n = P.parseAmount(v);
          if (n == null) out.error = 'مبلغ غير صحيح.'; else out.value = P.formatAmount(n);
          break;
        case 'currency':
          v = v.toUpperCase(); out.value = v;
          if (!/^[A-Z]{3}$/.test(v)) out.error = 'رمز العملة 3 أحرف لاتينية (مثل SAR أو USD).';
          break;
        case 'containers':
          var list = v.toUpperCase().split(/[\s,;،]+/).filter(Boolean);
          out.value = list.join(', ');
          var bad = list.filter(function (c) { return !P.isValidContainer(c); });
          if (bad.length) out.warn = 'تحقّق من: ' + bad.slice(0, 4).join('، ') + (bad.length > 4 ? '…' : '') + ' — لا يطابق رقم التحقق (ISO 6346).';
          break;
        case 'list':
          out.value = v.split(/[\s,;،]+/).filter(Boolean).join(', ').slice(0, 1200);
          break;
        case 'hs':
          var codes = v.split(/[\s,;،]+/).filter(Boolean);
          out.value = codes.join(', ');
          var badHs = codes.filter(function (c) { return !/^\d{4,12}$|^\d{4}(\.\d{2,4}){1,3}$/.test(c); });
          if (badHs.length) out.warn = 'رمز HS غير معتاد: ' + badHs.slice(0, 3).join('، ');
          break;
        case 'iban':
          v = v.toUpperCase().replace(/[\s\-]/g, ''); out.value = v;
          if (!P.isValidIban(v)) out.error = 'رقم الآيبان غير صحيح (رقم التحقق لا يطابق).';
          break;
        case 'digits':
          if (!/^\d{4,20}$/.test(v.replace(/\s/g, ''))) out.warn = 'رقم البيان أرقام فقط عادةً.';
          else out.value = v.replace(/\s/g, '');
          break;
        case 'id':
          out.value = v.slice(0, 60);
          break;
        default:
          out.value = v.slice(0, 2000);     // the DB limit of one field value (app.extraction_fields_ok)
      }
      return out;
    }
    function srcInfo(f) {
      if (!f || !f.value) return null;
      if (f.source === 'qr') return { cls: 'is-qr', text: 'من رمز QR' };
      if (f.source === 'ai') return { cls: 'is-' + (f.confidence || 'medium'), text: T('ai_src', { n: Math.round((Number(f.score) || 0) * 100) }) };
      if (f.source === 'manual' || f.confidence === 'manual') return { cls: 'is-manual', text: CONF_LABEL.manual };
      return { cls: 'is-' + f.confidence, text: CONF_LABEL[f.confidence] || '' };
    }
    /* fields v2: grouped sections per document type + issue highlight (summary, pulse, «لم يُقرأ») */
    var FX_SECTIONS = {
      doc: ['invoice_number', 'invoice_date', 'bl_number', 'booking_number', 'declaration_number', 'declaration_type', 'declaration_status',
        'declaration_date', 'declaration_date_hijri', 'packing_list_number', 'packing_list_date'],
      parties: ['supplier_name', 'supplier_vat', 'buyer_name', 'buyer_vat', 'shipper', 'consignee', 'consignee_name', 'notify_party',
        'importer_name_ar', 'broker_name'],
      transport: ['vessel', 'voyage', 'shipping_line', 'port_of_loading', 'port_of_discharge', 'place_of_receipt', 'place_of_delivery',
        'export_country', 'freight_terms', 'incoterms'],
      cargo: ['container_numbers', 'seal_numbers', 'packages_count', 'package_type', 'gross_weight', 'net_weight', 'measurement_cbm',
        'temperature_c', 'goods_description', 'hs_codes', 'country_of_origin'],
      money: ['currency', 'subtotal', 'vat_amount', 'total', 'local_value', 'payment_terms', 'payment_method', 'iban']
    };
    var FX_INVOICE_SHOW = ['invoice_number', 'invoice_date', 'supplier_name', 'supplier_vat', 'buyer_name', 'buyer_vat', 'currency', 'subtotal',
      'vat_amount', 'total', 'bl_number', 'container_numbers', 'hs_codes', 'country_of_origin'];
    // order: section order; show: keys shown even when empty (a filled key is always shown); need: expected → «لم يُقرأ»
    var FX_LAYOUT = {
      bill_of_lading: { order: ['doc', 'parties', 'transport', 'cargo', 'money'],
        parties: ['shipper', 'consignee', 'supplier_name', 'supplier_vat', 'buyer_name', 'buyer_vat'],
        doc: ['bl_number', 'invoice_number', 'invoice_date', 'declaration_number'],
        show: ['bl_number', 'shipper', 'consignee', 'notify_party', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'container_numbers',
          'seal_numbers', 'packages_count', 'package_type', 'gross_weight', 'net_weight', 'goods_description', 'hs_codes', 'country_of_origin'],
        need: ['bl_number', 'shipper', 'consignee', 'vessel', 'port_of_loading', 'port_of_discharge', 'container_numbers', 'packages_count', 'gross_weight', 'goods_description'] },
      commercial_invoice: { order: ['doc', 'parties', 'money', 'cargo', 'transport'],
        show: FX_INVOICE_SHOW.concat(['packages_count', 'gross_weight', 'net_weight', 'goods_description']),
        need: ['invoice_number', 'invoice_date', 'supplier_name', 'buyer_name', 'currency', 'total'] },
      operator_invoice: { order: ['doc', 'parties', 'money', 'cargo', 'transport'], show: FX_INVOICE_SHOW.concat(['iban']),
        need: ['invoice_number', 'invoice_date', 'supplier_name', 'supplier_vat', 'total'] },
      customs_declaration: { order: ['doc', 'parties', 'cargo', 'transport', 'money'],
        doc: ['declaration_number', 'bl_number', 'invoice_number', 'invoice_date'],
        parties: ['consignee', 'shipper', 'buyer_name', 'buyer_vat', 'supplier_name', 'supplier_vat'],
        show: ['declaration_number', 'declaration_type', 'declaration_date', 'bl_number', 'invoice_number', 'consignee', 'container_numbers',
          'packages_count', 'gross_weight', 'net_weight', 'hs_codes', 'country_of_origin', 'vessel', 'port_of_loading', 'port_of_discharge',
          'currency', 'total', 'vat_amount'],
        need: ['declaration_number', 'bl_number', 'container_numbers', 'hs_codes'] },
      packing_list: { order: ['doc', 'parties', 'cargo', 'transport', 'money'],
        parties: ['shipper', 'consignee', 'supplier_name', 'buyer_name', 'supplier_vat', 'buyer_vat'],
        show: ['packing_list_number', 'packing_list_date', 'invoice_number', 'invoice_date', 'bl_number', 'shipper', 'consignee', 'container_numbers',
          'packages_count', 'package_type', 'gross_weight', 'net_weight', 'measurement_cbm', 'goods_description', 'hs_codes', 'country_of_origin'],
        need: ['packages_count', 'gross_weight', 'net_weight', 'goods_description'] },
      certificate_of_origin: { order: ['doc', 'parties', 'cargo', 'transport', 'money'],
        parties: ['shipper', 'consignee', 'supplier_name', 'buyer_name', 'supplier_vat', 'buyer_vat'],
        show: ['invoice_number', 'invoice_date', 'shipper', 'consignee', 'country_of_origin', 'goods_description', 'hs_codes', 'packages_count',
          'gross_weight', 'vessel', 'port_of_loading', 'port_of_discharge'],
        need: ['country_of_origin', 'goods_description'] },
      other: { order: ['doc', 'parties', 'money', 'cargo', 'transport'],
        show: FX_INVOICE_SHOW.concat(['declaration_number', 'iban']), need: [] }
    };
    var FX_REASON = { vat: 'fx_r_vat', date: 'fx_r_date', amount: 'fx_r_amount', currency: 'fx_r_currency', iban: 'fx_r_iban',
      containers: 'fx_r_container', hs: 'fx_r_hs', digits: 'fx_r_digits' };
    function fxLayout(j) { return FX_LAYOUT[j && j.docType] || FX_LAYOUT.other; }
    function hasVal(j, k) { var f = j.fields[k]; return !!(f && String(f.value == null ? '' : f.value).trim()); }
    // sections in the type's order (a type's own key order first, then the section's other keys); every filled key the
    // sections do not place — an unknown key returned by a reading included — goes to «حقول أخرى» (nothing returned is hidden)
    function fxPlan(j) {
      var L = fxLayout(j), placed = {};
      var plan = L.order.map(function (sid) {
        var own = L[sid] || [], keys = own.concat(FX_SECTIONS[sid].filter(function (k) { return own.indexOf(k) === -1; }));
        keys = keys.filter(function (k) { return knownDef(k) && (L.show.indexOf(k) !== -1 || hasVal(j, k)); });
        keys.forEach(function (k) { placed[k] = 1; });
        return { id: sid, keys: keys };
      });
      var rest = Object.keys(j.fields || {}).filter(function (k) { return !placed[k] && /^[a-z][a-z0-9_]{0,59}$/.test(k) && hasVal(j, k); });
      plan.push({ id: 'other', keys: rest });
      return plan.filter(function (s) { return s.keys.length; });
    }
    function aiWarnFor(j, key) {
      var aw = j.ai && j.ai.warnings ? j.ai.warnings : [];
      for (var i = 0; i < aw.length; i++) if (aw[i] && aw[i].field === key && aw[i].text) return String(aw[i].text).slice(0, 140);
      return '';
    }
    // level: 'error' (red pulse) | 'review' (amber) | 'missing' (dashed «لم يُقرأ») | ''
    function fieldState(def, j, r) {
      var f = j.fields[def.key];
      if (!r.value) return fxLayout(j).need.indexOf(def.key) !== -1 ? { level: 'missing', reason: T('fx_r_missing') } : { level: '', reason: '' };
      if (r.error || r.warn) return { level: 'error', reason: T(FX_REASON[def.kind] || 'fx_r_check') };
      if (f && f.source === 'ai') {
        var aw = aiWarnFor(j, def.key);
        if (f.valid === false) return { level: 'error', reason: T('fx_r_ai_invalid'), why: aw };
        if (aw) return { level: 'review', reason: T('fx_r_check'), why: aw };
      }
      if (f && f.source !== 'manual' && f.confidence === 'low') return { level: 'review', reason: T('fx_r_low') };
      return { level: '', reason: '' };
    }
    function applyState(g, st) {
      g.classList.remove('is-fx-error', 'is-fx-review', 'is-fx-missing');
      if (st.level) g.classList.add('is-fx-' + st.level);
      g.setAttribute('data-fx', st.level || '');
      g.setAttribute('data-fx-reason', st.reason || '');
      var b = g.querySelector('.ocr-fx-badge');
      if (b) { b.textContent = st.reason || ''; b.hidden = !st.level; }
      var why = g.querySelector('.ocr-fx-why');
      if (why) why.textContent = st.level && st.level !== 'missing' ? (st.why || (st.level === 'review' ? st.reason : '')) : '';
    }
    function fieldEl(j, def) {
        var f = j.fields[def.key];
        var g = el('div', 'form-group ocr-field');
        g.setAttribute('data-key', def.key);
        var head = el('div', 'ocr-field-head');
        var lab = el('label', 'form-label', def.label);
        lab.htmlFor = 'of-' + def.key;
        head.appendChild(lab);
        var si = srcInfo(f), src = el('span', 'ocr-src' + (si ? ' ' + si.cls : ''), si ? si.text : '');
        src.id = 'of-' + def.key + '-src';
        if (!si) src.hidden = true;
        head.appendChild(src);
        var fxb = el('span', 'ocr-fx-badge'); fxb.hidden = true; fxb.setAttribute('aria-hidden', 'true');
        head.appendChild(fxb);
        g.appendChild(head);
        var inp = el('input', 'form-control' + (def.ltr ? ' num' : ''));
        inp.type = 'text'; inp.id = 'of-' + def.key; inp.autocomplete = 'off';
        inp.dir = def.ltr ? 'ltr' : 'auto';   // a Latin name in an Arabic page keeps its punctuation in place
        if (def.ph) inp.placeholder = def.ph;
        inp.maxLength = def.kind === 'containers' || def.kind === 'hs' || def.kind === 'list' ? 1200 : 2000;
        inp.value = f ? f.value : '';
        var errId = 'of-' + def.key + '-err', warnId = 'of-' + def.key + '-warn', whyId = 'of-' + def.key + '-why';
        inp.setAttribute('aria-describedby', src.id + ' ' + errId + ' ' + warnId + ' ' + whyId);
        g.appendChild(inp);
        var err = el('span', 'form-error'); err.id = errId;
        var warn = el('span', 'ocr-warn'); warn.id = warnId;
        var why = el('span', 'ocr-fx-why'); why.id = whyId;
        g.appendChild(err); g.appendChild(warn); g.appendChild(why);
        if (f && f.alt) g.appendChild(el('span', 'ocr-alt', 'النص المقروء كان: ' + f.alt));
        return g;
    }
    function renderFields(j) {
      var box = $('ocr-fields');
      box.textContent = '';
      box.classList.add('ocr-fx-on');
      fxPlan(j).forEach(function (sec) {
        var card = el('section', 'ocr-fx-sec');
        card.setAttribute('data-sec', sec.id);
        card.setAttribute('aria-labelledby', 'ocr-fx-sec-' + sec.id);
        var head = el('div', 'ocr-fx-sec-head');
        var h = el('h3', 'ocr-fx-sec-title', T('fx_sec_' + sec.id)); h.id = 'ocr-fx-sec-' + sec.id;
        head.appendChild(h);
        head.appendChild(el('span', 'ocr-fx-count'));
        card.appendChild(head);
        var grid = el('div', 'ocr-fx-grid');
        sec.keys.forEach(function (k) { grid.appendChild(fieldEl(j, defOf(k))); });
        card.appendChild(grid);
        box.appendChild(card);
      });
      qsa('.ocr-field', box).forEach(function (g) { showValidation(defOf(g.getAttribute('data-key')), g.querySelector('input'), false); });
      renderChecks(j);
      renderIssues(j);
      renderWeak(j);
    }
    function showValidation(def, inp, normalise) {
      var g = inp.closest('.ocr-field');
      var r = validateField(def, inp.value);
      if (normalise && r.value !== inp.value && !r.error) inp.value = r.value;
      g.querySelector('.form-error').textContent = r.error;
      g.querySelector('.ocr-warn').textContent = r.warn;
      if (r.error) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      var j = current();
      if (j) applyState(g, fieldState(def, j, r));
      return r;
    }
    // while typing: a value that now validates clears the highlight at once; a new error waits for focusout
    function softValidate(def, inp, j) {
      var g = inp.closest('.ocr-field');
      var r = validateField(def, inp.value), st = fieldState(def, j, r);
      var prev = g.getAttribute('data-fx') || '';
      if (st.level === 'error' && prev !== 'error') st = { level: '', reason: '' };
      if (!r.error && !r.warn) {
        g.querySelector('.form-error').textContent = ''; g.querySelector('.ocr-warn').textContent = '';
        inp.removeAttribute('aria-invalid');
      } else if (prev === 'error') {
        g.querySelector('.form-error').textContent = r.error; g.querySelector('.ocr-warn').textContent = r.warn;
        if (r.error) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      }
      applyState(g, st);
    }
    function knownDef(key) { return FIELD_DEFS.filter(function (d) { return d.key === key; })[0]; }
    function defOf(key) { return knownDef(key) || extraDef(key); }
    function labelOf(key) { var d = defOf(key); return d ? d.label : key; }
    // every field to list in an export: the known ones in their order, then the other filled keys
    function exportDefs(f) {
      var out = FIELD_DEFS.filter(function (d) { return f[d.key]; });
      Object.keys(f).forEach(function (k) { if (!knownDef(k) && f[k]) out.push(extraDef(k)); });
      return out;
    }

    /* issue summary above the sections + per-section count chips */
    var fxSummary = null, fxWeak = null;
    function fxBox() {
      if (fxSummary) return fxSummary;
      fxSummary = el('div', 'ocr-fx-summary');
      fxSummary.id = 'ocr-fx-summary';
      var f = $('ocr-fields');
      f.parentNode.insertBefore(fxSummary, f);
      return fxSummary;
    }
    function fxChip(g, cls) {
      var key = g.getAttribute('data-key'), def = defOf(key);
      var b = el('button', 'ocr-fx-chip ' + cls);
      b.type = 'button';
      b.setAttribute('data-fx-go', key);
      b.appendChild(el('span', 'ocr-fx-chip-dot'));
      b.appendChild(el('strong', null, def ? def.label : key));
      var reason = g.getAttribute('data-fx-reason') || '';
      if (reason && cls !== 'is-missing') b.appendChild(el('span', 'ocr-fx-chip-why', reason));
      return b;
    }
    function renderIssues(j) {
      var box = fxBox();
      box.textContent = '';
      var all = qsa('#ocr-fields .ocr-field');
      var bad = all.filter(function (g) { var l = g.getAttribute('data-fx'); return l === 'error' || l === 'review'; });
      var miss = all.filter(function (g) { return g.getAttribute('data-fx') === 'missing'; });
      bad.sort(function (a, b) { return (a.getAttribute('data-fx') === 'error' ? 0 : 1) - (b.getAttribute('data-fx') === 'error' ? 0 : 1); });
      box.className = 'ocr-fx-summary ' + (bad.length ? (bad.some(function (g) { return g.getAttribute('data-fx') === 'error'; }) ? 'is-error' : 'is-review') : 'is-ok');
      var head = el('div', 'ocr-fx-sum-head');
      var title = el('strong', 'ocr-fx-sum-title', bad.length ? (bad.length === 1 ? T('fx_sum_one') : T('fx_sum_many', { n: bad.length })) : T('fx_sum_ok'));
      head.appendChild(title);
      if (bad.length) head.appendChild(el('span', 'ocr-fx-sum-hint', T('fx_sum_hint')));
      box.appendChild(head);
      if (bad.length) {
        var list = el('div', 'ocr-fx-chips');
        bad.forEach(function (g) { list.appendChild(fxChip(g, g.getAttribute('data-fx') === 'error' ? 'is-error' : 'is-review')); });
        box.appendChild(list);
      }
      if (miss.length) {
        box.appendChild(el('div', 'ocr-fx-sum-sub', T('fx_missing_title', { n: miss.length })));
        var ml = el('div', 'ocr-fx-chips');
        miss.forEach(function (g) { ml.appendChild(fxChip(g, 'is-missing')); });
        box.appendChild(ml);
      }
      qsa('#ocr-fields .ocr-fx-sec').forEach(function (sec) {
        var fs = qsa('.ocr-field', sec);
        var n = fs.filter(function (g) { var l = g.getAttribute('data-fx'); return l === 'error' || l === 'review'; }).length;
        var m = fs.filter(function (g) { return g.getAttribute('data-fx') === 'missing'; }).length;
        var hasErr = fs.some(function (g) { return g.getAttribute('data-fx') === 'error'; });
        var c = sec.querySelector('.ocr-fx-count');
        c.className = 'ocr-fx-count ' + (n ? (hasErr ? 'is-error' : 'is-review') : m ? 'is-missing' : 'is-ok');
        c.textContent = n ? T('fx_chip_n', { n: n }) + (m ? ' · ' + T('fx_chip_missing', { n: m }) : '') : m ? T('fx_chip_missing', { n: m }) : T('fx_chip_ok');
      });
    }
    function fxGo(key) {
      var inp = $('of-' + key);
      if (!inp) return;
      try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { inp.scrollIntoView(); }
      try { inp.focus({ preventScroll: true }); } catch (e2) { inp.focus(); }
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-fx-go]');
      if (b && fxSummary && fxSummary.contains(b)) fxGo(b.getAttribute('data-fx-go'));
    });

    /* weak local reading → suggest the AI reading (scanned B/L / invoices) */
    function renderWeak(j) {
      if (!fxWeak) {
        fxWeak = el('div', 'alert alert-warning mb-2 ocr-fx-weak');
        fxWeak.id = 'ocr-fx-weak';
        fxWeak.setAttribute('role', 'note');
        var lc = $('ocr-low-conf');
        lc.parentNode.insertBefore(fxWeak, lc.nextSibling);
      }
      fxWeak.textContent = '';
      var need = fxLayout(j).need, empty = need.filter(function (k) { return !hasVal(j, k); }).length;
      var lowConf = j.confidence != null && j.confidence < 80;
      var mostEmpty = need.length > 0 && empty / need.length > 0.5;
      // a bill of lading read as an invoice: B/L data found, invoice data not
      var blKeys = ['bl_number', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'shipper', 'consignee'];
      var looksBl = (j.docType === 'commercial_invoice' || j.docType === 'operator_invoice') &&
        blKeys.filter(function (k) { return hasVal(j, k); }).length >= 3 && !hasVal(j, 'invoice_number') && !hasVal(j, 'total');
      var weak = j.engine !== ENGINE_AI && (lowConf || mostEmpty);
      var show = weak || looksBl;
      fxWeak.hidden = !show;
      // this alert says more (and offers the AI reading); without it the plain low-confidence alert is back
      $('ocr-low-conf').hidden = show || !(j.confidence != null && j.confidence < LOW_CONF);
      if (!show) return;
      if (looksBl) {
        var tb = el('div', 'ocr-fx-weak-body ocr-fx-type-hint');
        tb.appendChild(el('strong', null, T('fx_type_bl_title')));
        tb.appendChild(el('p', null, T('fx_type_bl_text')));
        var tbtn = el('button', 'btn btn-secondary btn-sm', T('fx_type_bl_btn'));
        tbtn.type = 'button';
        tbtn.addEventListener('click', function () {
          typeSel.value = 'bill_of_lading';
          typeSel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        tb.appendChild(tbtn);
        fxWeak.appendChild(tb);
        if (!weak) return;
      }
      var why = [];
      if (lowConf) why.push(T('fx_weak_conf', { n: Math.round(j.confidence) }));
      if (mostEmpty) why.push(T('fx_weak_empty', { a: empty, b: need.length }));
      var body = el('div', 'ocr-fx-weak-body');
      body.appendChild(el('strong', null, T('fx_weak_title')));
      body.appendChild(el('p', null, T('fx_weak_text', { why: why.join(I18N && I18N.lang && I18N.lang() === 'en' ? ', ' : '، ') })));
      var canAi = ONLINE && STAFF && AI.enabled;
      if (canAi && j.file && AI.remaining !== 0) {
        var btn = el('button', 'btn btn-primary btn-sm', T('fx_weak_ai_btn'));
        btn.type = 'button';
        btn.disabled = running;
        btn.addEventListener('click', function () { rereadWithAi(j); });
        body.appendChild(btn);
      } else if (canAi && AI.remaining === 0) {
        body.appendChild(el('p', 'text-sm', T('fx_weak_quota')));
      } else if (canAi) {
        body.appendChild(el('p', 'text-sm', T('fx_weak_nofile')));
      } else if (ONLINE) {
        body.appendChild(el('p', 'text-sm', T('fx_weak_admin')));
        var a = el('a', 'btn btn-ghost btn-sm', T('fx_weak_admin_link'));
        a.href = 'admin.html#org';
        body.appendChild(a);
      } else {
        body.appendChild(el('p', 'text-sm', T('fx_weak_offline')));
      }
      fxWeak.appendChild(body);
    }
    function rereadWithAi(j) {
      if (running || !j || !j.file || !$('ocr-engine-ai')) return;
      var edited = Object.keys(j.fields).some(function (k) { return j.fields[k] && j.fields[k].source === 'manual'; });
      if (!edited) { startAiReread(j); return; }
      ask({ title: T('fx_weak_ai_btn'), text: T('fx_weak_confirm'), okText: T('fx_weak_ai_btn'), danger: true })
        .then(function (yes) { if (yes) startAiReread(j); });
    }
    function startAiReread(j) {
      if (running || !j || !j.file) return;
      var r = $('ocr-engine-ai');
      if (!r) return;
      r.checked = true; userEngine = 'ai';       // the user asked for the AI reading
      syncEngineUi();
      var dt = $('ocr-doc-type');
      if (dt && j.docType && dt.querySelector('option[value="' + j.docType + '"]')) dt.value = j.docType;
      j.status = 'queued'; j.statusText = 'بانتظار القراءة';
      announce(T('fx_weak_started'));
      renderQueue(); runQueue();
    }

    $('ocr-fields').addEventListener('input', function (e) {
      var g = e.target.closest('.ocr-field'), j = current();
      if (!g || !j) return;
      var key = g.getAttribute('data-key');
      var v = e.target.value;
      if (v.trim()) j.fields[key] = { value: v, confidence: 'manual', source: 'manual' };
      else delete j.fields[key];
      var src = g.querySelector('.ocr-src');
      var si = srcInfo(j.fields[key]);
      src.className = 'ocr-src' + (si ? ' ' + si.cls : ''); src.textContent = si ? si.text : ''; src.hidden = !si;
      softValidate(defOf(key), e.target, j);
      renderIssues(j);
    });
    $('ocr-fields').addEventListener('focusout', function (e) {
      var g = e.target.closest && e.target.closest('.ocr-field'), j = current();
      if (!g || !j || e.target.tagName !== 'INPUT') return;
      var key = g.getAttribute('data-key');
      var r = showValidation(defOf(key), e.target, true);
      if (j.fields[key] && !r.error) j.fields[key].value = r.value;
      renderChecks(j);
      renderIssues(j);
    });
    function num(j, key) { var f = j.fields[key]; return f ? P.parseAmount(f.value) : null; }
    function renderChecks(j) {
      var box = $('ocr-checks');
      box.textContent = '';
      var s = num(j, 'subtotal'), v = num(j, 'vat_amount'), t = num(j, 'total');
      var msgs = [];
      if (s != null && v != null && t != null) {
        if (Math.abs(s + v - t) > Math.max(0.05, t * 0.002)) msgs.push(['warning', 'المجموع قبل الضريبة + الضريبة (' + P.formatAmount(s + v) + ') لا يساوي الإجمالي (' + P.formatAmount(t) + '). راجع المبالغ.']);
        else msgs.push(['success', 'المبالغ متسقة: المجموع قبل الضريبة + الضريبة = الإجمالي.']);
      }
      if (s != null && v != null && s > 0 && Math.abs(v / s - 0.15) > 0.005 && v > 0) msgs.push(['info', 'نسبة الضريبة ' + (v / s * 100).toFixed(1) + '% وليست 15%؛ قد تكون الفاتورة معفاة جزئيًا أو المبالغ مقروءة خطأ.']);
      var itemsSum = sumItems(j);
      if (itemsSum != null && s != null && Math.abs(itemsSum - s) > Math.max(0.05, s * 0.002)) msgs.push(['info', 'مجموع البنود (' + P.formatAmount(itemsSum) + ') يختلف عن المجموع قبل الضريبة. قد تكون بعض البنود لم تُقرأ.']);
      msgs.forEach(function (m) {
        var a = el('div', 'alert alert-' + (m[0] === 'success' ? 'success' : m[0] === 'warning' ? 'warning' : 'info'));
        a.appendChild(el('span', null, m[1]));
        box.appendChild(a);
      });
      // AI reading: the model's notes and the server checks (ISO 6346, VAT, totals) — untrusted text, textContent only
      var aw = j.ai && j.ai.warnings ? j.ai.warnings : [];
      if (aw.length) {
        var w = el('div', 'alert alert-warning');
        var inner = el('div');
        inner.appendChild(el('strong', null, T('ai_warn_title')));
        var ul = el('ul');
        aw.forEach(function (x) {
          var fk = x && typeof x.field === 'string' ? x.field : '';
          var label = fk ? (fk === 'containers' ? T('cont_title') : /^[a-z][a-z0-9_]{0,59}$/.test(fk) ? labelOf(fk) : fk) + ': ' : '';
          ul.appendChild(el('li', null, label + String((x && x.text) || '')));
        });
        inner.appendChild(ul);
        w.appendChild(inner);
        box.appendChild(w);
      }
    }

    /* line items: the 5 base columns, + the ai-doc-v3 item columns a reading filled (unit, packages, weights, container,
       seal, origin, scientific name, notes — app.extraction_items_ok keys); + the per-container rows (read-only) */
    var ITEM_COLS = [['description', 'الوصف', 'ocr-desc', false], ['hs_code', 'رمز HS', '', true], ['quantity', 'الكمية', '', true], ['unit_price', 'سعر الوحدة', '', true], ['amount', 'المبلغ', '', true]];
    var ITEM_EXTRA = [['unit', 'it_unit', false], ['packages', 'it_packages', true], ['net_weight', 'it_net_weight', true],
      ['gross_weight', 'it_gross_weight', true], ['container_number', 'it_container_number', true], ['seal_number', 'it_seal_number', true],
      ['origin_country', 'it_origin_country', false], ['scientific_name', 'it_scientific_name', false], ['notes', 'it_notes', false]];
    var CONT_COLS = [['container_number', 'it_container_number'], ['seal_number', 'it_seal_number'], ['size_type', 'cont_size_type'],
      ['packages_count', 'it_packages'], ['net_weight', 'it_net_weight'], ['gross_weight', 'it_gross_weight']];
    function filled(v) { return v != null && String(v).trim() !== ''; }
    function itemCols(j) {
      var extra = ITEM_EXTRA.filter(function (c) { return j.items.some(function (it) { return filled(it[c[0]]); }); })
        .map(function (c) { return [c[0], T(c[1]), c[0] === 'notes' || c[0] === 'scientific_name' ? 'ocr-desc' : '', c[2]]; });
      return ITEM_COLS.concat(extra);
    }
    function renderItems(j) {
      var tb = $('ocr-items-body');
      tb.textContent = '';
      var cols = itemCols(j);
      var hr = $('ocr-items-head');
      if (hr) {
        hr.textContent = '';
        var th0 = el('th', null, '#'); th0.scope = 'col'; hr.appendChild(th0);
        cols.forEach(function (c) { var th = el('th', null, c[1]); th.scope = 'col'; hr.appendChild(th); });
        var thx = el('th'); thx.scope = 'col'; thx.appendChild(el('span', 'sr-only', 'حذف')); hr.appendChild(thx);
      }
      j.items.forEach(function (it, i) {
        var tr = el('tr');
        tr.setAttribute('data-i', String(i));
        tr.appendChild(el('td', 'num', String(i + 1)));
        cols.forEach(function (c) {
          var td = el('td'), inp = el('input', c[2] + (c[3] ? ' num' : ''));
          inp.type = 'text'; inp.value = it[c[0]] == null ? '' : String(it[c[0]]);
          inp.setAttribute('data-col', c[0]);
          inp.setAttribute('aria-label', c[1] + ' — البند ' + (i + 1));
          if (c[3]) { inp.dir = 'ltr'; inp.inputMode = c[0] === 'hs_code' ? 'numeric' : (/number$/.test(c[0]) ? 'text' : 'decimal'); }
          else inp.dir = 'auto';
          inp.maxLength = c[0] === 'description' || c[0] === 'notes' || c[0] === 'scientific_name' ? 300 : 40;
          td.appendChild(inp); tr.appendChild(td);
        });
        var tdx = el('td'), rm = iconBtn(ICON.x, 'حذف البند ' + (i + 1), 'is-danger');
        rm.setAttribute('data-del', String(i));
        tdx.appendChild(rm); tr.appendChild(tdx);
        tb.appendChild(tr);
      });
      var nc = (j.containers || []).length;
      $('ocr-items-count').textContent = j.items.length || nc ? '(' + j.items.length + (nc ? ' · ' + T('cont_n', { n: nc }) : '') + ')' : '';
      updateItemsSum(j);
      renderContainers(j);
    }
    // the per-container rows of an ai-doc-v3 reading (ai_detail.containers): read-only — the container / seal numbers
    // are also in the «أرقام الحاويات» / «أرقام الأختام» fields, which are the ones to correct
    function renderContainers(j) {
      var box = $('ocr-containers');
      if (!box) return;
      var rows = j.containers || [];
      box.hidden = !rows.length;
      var body = $('ocr-containers-body'), head = $('ocr-containers-head');
      body.textContent = ''; head.textContent = '';
      if (!rows.length) return;
      $('ocr-containers-count').textContent = '(' + rows.length + ')';
      var th0 = el('th', null, '#'); th0.scope = 'col'; head.appendChild(th0);
      CONT_COLS.forEach(function (c) { var th = el('th', null, T(c[1])); th.scope = 'col'; head.appendChild(th); });
      rows.forEach(function (r, i) {
        var tr = el('tr');
        tr.appendChild(el('td', null, String(i + 1)));
        CONT_COLS.forEach(function (c) {
          var td = el('td'), v = el('bdi', null, r[c[0]] == null ? '' : String(r[c[0]]));
          v.dir = 'ltr';
          td.appendChild(v); tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }
    function sumItems(j) {
      if (!j.items.length) return null;
      var s = 0, okAll = true;
      j.items.forEach(function (it) { var a = P.parseAmount(it.amount); if (a == null) okAll = false; else s += a; });
      return okAll || s ? s : null;
    }
    function updateItemsSum(j) {
      var s = sumItems(j);
      $('ocr-items-sum').textContent = s == null ? 'لا توجد بنود.' : 'مجموع المبالغ: ' + P.formatAmount(s) + (j.fields.currency ? ' ' + j.fields.currency.value : '');
    }
    $('ocr-items-body').addEventListener('input', function (e) {
      var j = current(), tr = e.target.closest('tr');
      if (!j || !tr) return;
      var it = j.items[+tr.getAttribute('data-i')];
      if (it) it[e.target.getAttribute('data-col')] = e.target.value;
    });
    $('ocr-items-body').addEventListener('focusout', function (e) {
      var j = current(), tr = e.target.closest && e.target.closest('tr');
      if (!j || !tr || e.target.tagName !== 'INPUT') return;
      var col = e.target.getAttribute('data-col'), it = j.items[+tr.getAttribute('data-i')];
      if (!it) return;
      var v = String(e.target.value || '').trim(), bad = false;
      if (col === 'quantity' || col === 'unit_price' || col === 'amount') {
        if (v) { var n = P.parseAmount(v); if (n == null) bad = true; else v = col === 'quantity' ? String(Math.round(n * 1000) / 1000) : P.formatAmount(n); }
        // fill the amount when quantity and unit price are known
        if (!bad && col !== 'amount' && !String(it.amount || '').trim()) {
          var q = P.parseAmount(col === 'quantity' ? v : it.quantity), p = P.parseAmount(col === 'unit_price' ? v : it.unit_price);
          if (q != null && p != null) { it.amount = P.formatAmount(q * p); var ai = tr.querySelector('[data-col="amount"]'); if (ai) ai.value = it.amount; }
        }
      } else if (col === 'hs_code') v = P.normalizeDigits(v);
      if (!bad) { it[col] = v; e.target.value = v; e.target.removeAttribute('aria-invalid'); }
      else e.target.setAttribute('aria-invalid', 'true');
      updateItemsSum(j); renderChecks(j);
    });
    $('ocr-items-body').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-del]'), j = current();
      if (!b || !j) return;
      var i = +b.getAttribute('data-del');
      j.items.splice(i, 1);
      renderItems(j); renderChecks(j);
      var nb = $('ocr-items-body').querySelector('button[data-del="' + Math.min(i, j.items.length - 1) + '"]') || $('ocr-add-item');
      nb.focus();
    });
    $('ocr-add-item').addEventListener('click', function () {
      var j = current();
      if (!j) return;
      if (j.items.length >= 500) { toast('الحد الأقصى 500 بند.', 'warning'); return; }
      j.items.push({ description: '', hs_code: '', quantity: '', unit_price: '', amount: '' });
      renderItems(j);
      var last = $('ocr-items-body').querySelector('tr:last-child input');
      if (last) last.focus();
    });

    /* text + type */
    $('ocr-text').addEventListener('input', function () { var j = current(); if (j) j.text = this.value.slice(0, MAX_TEXT); });
    typeSel.addEventListener('change', function () { var j = current(); if (j) { j.docType = this.value; if (j.ai) j.ai.typeFrom = null; renderMeta(j); renderFields(j); } });   // sections follow the type; edits live in j.fields
    $('ocr-reextract').addEventListener('click', function () {
      var j = current();
      if (j && j.engine === ENGINE_AI) { toast(T('ai_reextract_off'), 'info'); return; }
      if (!j) return;
      var edited = Object.keys(j.fields).some(function (k) { return j.fields[k].source === 'manual'; });
      if (!edited) { reextract(j); return; }
      ask({ title: 'إعادة استخراج البيانات', text: 'ستُستبدل تعديلاتك على الحقول والبنود بالقيم المستخرجة من النص الحالي. هل تريد المتابعة؟',
            okText: 'إعادة الاستخراج', danger: true }).then(function (yes) { if (yes) reextract(j); });
    });
    function reextract(j) {
      var res = P.extractFields(j.text, j.docType);
      if (j.qr) res = P.mergeQr(res, j.qr);
      j.fields = res.fields; j.items = res.lineItems.map(function (x) { return Object.assign({}, x); });
      renderFields(j); renderItems(j);
      announce('أُعيد استخراج البيانات: ' + Object.keys(j.fields).length + ' حقلًا و' + j.items.length + ' بندًا.');
    }

    /* ---------------------------------------------------------------
       Export
       --------------------------------------------------------------- */
    // every filled field (exports, copy, request hand-off) / the fields a save sends (the DB keys only)
    function plainCurrent(j) {
      var out = {};
      Object.keys(j.fields || {}).forEach(function (k) {
        var f = j.fields[k], v = f && typeof f === 'object' ? f.value : f;
        if (/^[a-z][a-z0-9_]{0,59}$/.test(k) && v != null && String(v).trim() !== '') out[k] = String(v).trim();
      });
      return out;
    }
    function savedFields(j) { return P.plainFields(j.fields, SAVE_KEYS); }
    // the reviewed items: the 5 base keys always, the v3 item keys when filled (all within app.extraction_items_ok)
    function cleanItems(j) {
      return j.items.map(function (it) {
        var o = { description: String(it.description || '').trim(), hs_code: String(it.hs_code || '').trim(), quantity: String(it.quantity || '').trim(),
          unit_price: String(it.unit_price || '').trim(), amount: String(it.amount || '').trim() };
        ITEM_EXTRA.forEach(function (c) { if (filled(it[c[0]])) o[c[0]] = String(it[c[0]]).trim().slice(0, 2000); });
        return o;
      }).filter(function (it) { return it.description || it.amount || it.quantity || ITEM_EXTRA.some(function (c) { return filled(it[c[0]]); }); });
    }
    function tableRows(j) {
      var f = plainCurrent(j), rows = [['الحقل', 'القيمة']];
      exportDefs(f).forEach(function (d) { rows.push([d.label, f[d.key]]); });
      var items = cleanItems(j), cols = itemCols(j);
      if (items.length) {
        rows.push([]);
        rows.push(['#'].concat(cols.map(function (c) { return c[1]; })));
        items.forEach(function (it, i) { rows.push([String(i + 1)].concat(cols.map(function (c) { return it[c[0]] == null ? '' : String(it[c[0]]); }))); });
      }
      var cr = j.containers || [];
      if (cr.length) {
        rows.push([]);
        rows.push(['#'].concat(CONT_COLS.map(function (c) { return T(c[1]); })));
        cr.forEach(function (r, i) { rows.push([String(i + 1)].concat(CONT_COLS.map(function (c) { return r[c[0]] == null ? '' : String(r[c[0]]); }))); });
      }
      return rows;
    }
    function exportJson(j) {
      return {
        source: { name: j.name, size: j.size, mime: j.mime || null, sha256: j.sha256 || null, pages: j.pages || null },
        doc_type: j.docType, engine: j.engine || null, languages: j.langs || null, mean_confidence: j.confidence,
        extracted_fields: j.extracted || {}, reviewed_fields: plainCurrent(j), line_items: cleanItems(j), containers: j.containers || [],
        qr_payload: j.qr || null, raw_text: j.text || '', exported_at: new Date().toISOString()
      };
    }
    function numOrStr(v) {   // spreadsheet cells: real numbers for amounts, strings otherwise
      return /^-?\d+(\.\d+)?$/.test(String(v)) && String(v).length < 15 ? Number(v) : v;
    }
    $('ocr-copy-text').addEventListener('click', function () {
      var j = current(); if (!j) return;
      copyText(j.text || '').then(function (okc) { toast(okc ? 'تم نسخ النص.' : 'تعذّر النسخ. حدّد النص وانسخه يدويًا.', okc ? 'success' : 'error'); });
    });
    $('ocr-copy-data').addEventListener('click', function () {
      var j = current(); if (!j) return;
      copyText(P.toDelimited(tableRows(j), '\t')).then(function (okc) {
        toast(okc ? 'تم نسخ البيانات. الصقها في Excel أو Google Sheets.' : 'تعذّر النسخ في هذا المتصفح. استخدم «تنزيل CSV».', okc ? 'success' : 'error');
      });
    });
    qsa('[data-download]').forEach(function (b) {
      b.addEventListener('click', function () {
        var j = current(); if (!j) return;
        var kind = b.getAttribute('data-download'), name = baseName(j.name) + '-ocr';
        try {
          if (kind === 'txt') download(new Blob([j.text || ''], { type: 'text/plain;charset=utf-8' }), name + '.txt');
          else if (kind === 'csv') download(new Blob(['﻿' + P.toDelimited(tableRows(j), ',')], { type: 'text/csv;charset=utf-8' }), name + '.csv');
          else if (kind === 'json') download(new Blob([JSON.stringify(exportJson(j), null, 2)], { type: 'application/json' }), name + '.json');
          else if (kind === 'xlsx') {
            if (!X) { toast('تعذّر إنشاء ملف Excel. استخدم CSV.', 'error'); return; }
            var f = plainCurrent(j), fr = [['الحقل', 'القيمة', 'المصدر']];
            exportDefs(f).forEach(function (d) {
              var si = srcInfo(j.fields[d.key]);
              fr.push([d.label, d.kind === 'amount' ? numOrStr(f[d.key]) : f[d.key], si ? si.text : '']);
            });
            var icols = itemCols(j);
            var ir = [['#'].concat(icols.map(function (c) { return c[1]; }))];
            cleanItems(j).forEach(function (it, i) { ir.push([i + 1].concat(icols.map(function (c) { var v = it[c[0]] == null ? '' : it[c[0]]; return c[3] && !/number$|hs_code/.test(c[0]) ? numOrStr(v) : v; }))); });
            var tr = [['النص']];
            String(j.text || '').split('\n').slice(0, 20000).forEach(function (l) { tr.push([l.slice(0, 32000)]); });
            var sheets = [{ name: 'البيانات', rows: fr }, { name: 'البنود', rows: ir }];
            if ((j.containers || []).length) {
              var cr = [['#'].concat(CONT_COLS.map(function (c) { return T(c[1]); }))];
              j.containers.forEach(function (r, i) { cr.push([i + 1].concat(CONT_COLS.map(function (c) { return r[c[0]] == null ? '' : r[c[0]]; }))); });
              sheets.push({ name: 'الحاويات', rows: cr });
            }
            sheets.push({ name: 'النص', rows: tr });
            download(X.write(sheets), name + '.xlsx');
          }
        } catch (e) { toast('تعذّر إنشاء الملف.', 'error'); }
      });
    });

    /* hand-off to request.html (request.js reads only known keys from ?from=ocr) */
    $('ocr-to-request').addEventListener('click', function () {
      var j = current(); if (!j) return;
      var f = plainCurrent(j), items = cleanItems(j);
      var hs = String(f.hs_codes || '').split(/[\s,]+/).filter(Boolean)[0] || (items.filter(function (i) { return i.hs_code; })[0] || {}).hs_code || '';
      var goods = items.map(function (i) { return i.description; }).filter(Boolean).join('، ').slice(0, 600);
      var data = {
        v: 1, savedAt: new Date().toISOString(), source: String(j.name || '').slice(0, 120),
        fields: {
          value: f.subtotal || f.total || '', currency: f.currency || '', hsCode: hs, declarationNo: f.declaration_number || '',
          blNumber: f.bl_number || '', containerNumbers: f.container_numbers || '', goods: goods, country: f.country_of_origin || '',
          taxId: f.buyer_vat && P.isValidSaudiVat(f.buyer_vat) ? f.buyer_vat : '', company: f.buyer_name || ''
        }
      };
      try { sessionStorage.setItem(PREFILL_KEY, JSON.stringify(data)); }
      catch (e) { toast('تعذّر نقل البيانات (التخزين المؤقت للمتصفح غير متاح).', 'error'); return; }
      window.location.href = 'request.html?from=ocr';
    });

    /* ---------------------------------------------------------------
       Save (server for signed-in staff, otherwise local history)
       --------------------------------------------------------------- */
    var LOCAL = API && API.localExtractions ? API.localExtractions : null;
    function saveTarget() { return ONLINE && STAFF ? 'server' : 'local'; }
    function store(where) {
      if (where === 'server') return { save: API.saveExtraction, review: API.reviewExtraction, list: API.listExtractions, get: API.getExtraction, void: API.voidExtraction };
      return LOCAL ? { save: LOCAL.save, review: LOCAL.review, list: LOCAL.list, get: LOCAL.get, void: LOCAL.void, remove: LOCAL.remove } : null;
    }
    function setSaveMsg(type, text) {
      var box = $('ocr-save-msg');
      box.className = 'alert mt-2 alert-' + (type === 'error' ? 'danger' : type === 'success' ? 'success' : 'warning');
      $('ocr-save-msg-text').textContent = text;
      box.hidden = !text;
    }
    function renderSaveState(j) {
      var where = j.saved ? j.saved.where : saveTarget();
      $('ocr-save-where').textContent = where === 'server'
        ? 'تُحفظ النتيجة على خادم مرسى في «المستندات المقروءة» ضمن مؤسستك، ويراها الموظفون المخوَّلون فقط. النص والبيانات الآلية لا تُعدَّل بعد الحفظ؛ تُحفظ تعديلاتك كمراجعة.'
        : (ONLINE ? 'لم تسجّل الدخول بحساب موظف، لذا تُحفظ النتيجة في «السجل» على هذا الجهاز فقط (التخزين المحلي للمتصفح) ولا تُرسل إلى الخادم. '
          : 'نسخة عرض تجريبية: تُحفظ النتيجة في «السجل» على هذا الجهاز فقط (التخزين المحلي للمتصفح) ولا تُرسل إلى أي جهة. ');
      $('ocr-tx-group').hidden = where !== 'server';
      var row = j.saved && j.saved.row;
      $('ocr-review-status').value = row && row.review_status ? row.review_status : 'unreviewed';
      $('ocr-review-note').value = row && row.review_note ? row.review_note : '';
      var linked = !!(row && row.transaction_id);
      $('ocr-tx').disabled = $('ocr-tx-q').disabled = $('ocr-tx-search').disabled = linked;
      $('ocr-attach').disabled = linked || !j.file;
      if (!j.file) $('ocr-attach').checked = false;
      $('ocr-save-label').textContent = j.saved ? 'حفظ التعديلات' : (where === 'server' ? 'حفظ على الخادم' : 'حفظ في السجل');
      setSaveMsg('', '');
    }
    // the org the shell header shows: an unlinked server save goes there explicitly, never to
    // whatever another tab stored as the active org meanwhile
    function shellOrg(where) {
      if (where !== 'server' || !Shell || typeof Shell.orgId !== 'function') return null;
      try { var o = Shell.orgId(); return typeof o === 'string' && o ? o : null; } catch (e) { return null; }
    }
    function buildRow(j) {
      return Object.assign({
        doc_type: j.docType || 'other', source_name: String(j.name || 'document').slice(0, 255), source_sha256: j.sha256 || '',
        source_mime: j.mime ? String(j.mime).slice(0, 120) : null, source_size: j.size > 0 ? j.size : null,
        source_pages: j.pages ? Math.min(Math.max(j.pages, 1), 200) : null, engine: String(j.engine || ENGINE_OCR).slice(0, 80),
        languages: String(j.langs || 'ara+eng').slice(0, 40), mean_confidence: j.confidence == null ? null : Math.min(100, Math.max(0, j.confidence)),
        raw_text: String(j.text || '').slice(0, MAX_TEXT), extracted_fields: P.plainFields(j.extracted || {}, SAVE_KEYS), qr_payload: j.qr || null,
        line_items: (j.machineItems || []).map(function (x) { return Object.assign({}, x); })
      }, j.engine === ENGINE_AI && j.ai && j.ai.usageId ? { ai_usage_id: j.ai.usageId, languages: 'auto', qr_payload: null } : {},
      // ai-doc-v3: the machine detail (containers, confidences, detected type) — bound to the usage row's file hash
      j.engine === ENGINE_AI && j.ai && j.ai.usageId && j.ai.detail ? { ai_detail: j.ai.detail } : {});
    }
    // order-independent: jsonb returns keys sorted by length, not in insertion order
    var ITEM_KEYS = ['description', 'hs_code', 'quantity', 'unit_price', 'amount'].concat(ITEM_EXTRA.map(function (c) { return c[0]; }));
    function sameFields(a, b) {
      a = a || {}; b = b || {};
      var ka = Object.keys(a).filter(function (k) { return a[k] != null && String(a[k]) !== ''; });
      var kb = Object.keys(b).filter(function (k) { return b[k] != null && String(b[k]) !== ''; });
      return ka.length === kb.length && ka.every(function (k) { return String(a[k]) === String(b[k] == null ? '' : b[k]); });
    }
    function sameItems(a, b) {
      a = a || []; b = b || [];
      return a.length === b.length && a.every(function (x, i) {
        return ITEM_KEYS.every(function (k) { return String(x[k] == null ? '' : x[k]) === String(b[i][k] == null ? '' : b[i][k]); });
      });
    }
    function reviewPatch(j, row) {
      var p = {}, rf = savedFields(j), items = cleanItems(j);
      var st = $('ocr-review-status').value, note = $('ocr-review-note').value.trim().slice(0, 1000);
      var prevReviewed = row.reviewed_fields || row.extracted_fields || {};
      if (!sameFields(rf, prevReviewed)) p.reviewed_fields = rf;
      if (!sameItems(items, row.line_items || [])) p.line_items = items;
      if (st !== (row.review_status || 'unreviewed')) p.review_status = st;
      if (note !== (row.review_note || '')) p.review_note = note || null;
      if ((j.docType || 'other') !== (row.doc_type || 'other')) p.doc_type = j.docType || 'other';
      if (st === 'reviewed' && !row.reviewed_fields && !p.reviewed_fields) p.reviewed_fields = rf;   // confirm the machine values
      return p;
    }
    var saving = false;
    $('ocr-save-btn').addEventListener('click', function () {
      var j = current();
      if (!j || saving) return;
      var where = j.saved ? j.saved.where : saveTarget();
      var S = store(where);
      if (!S) { setSaveMsg('error', 'الحفظ غير متاح: تعذّر تحميل طبقة البيانات (supa.js).'); return; }
      var invalid = qsa('#ocr-fields input[aria-invalid="true"]');
      if (!invalid.length) { doSave(j, where, S); return; }
      ask({ title: 'حقول غير صحيحة', text: 'بعض الحقول غير صحيحة (' + invalid.length + '). هل تريد الحفظ على أي حال؟', okText: 'الحفظ على أي حال' })
        .then(function (yes) { if (yes) doSave(j, where, S); else invalid[0].focus(); });
    });
    function doSave(j, where, S) {
      if (saving) return;
      if (!j.saved && !j.sha256) {
        if (where === 'server') { setSaveMsg('error', 'تعذّر حساب بصمة الملف في هذا المتصفح، فلا يمكن الحفظ على الخادم.'); return; }
      }
      saving = true;
      var btn = $('ocr-save-btn'); btn.disabled = true;
      setSaveMsg('info', 'جارٍ الحفظ…');
      var txId = where === 'server' && !(j.saved && j.saved.row && j.saved.row.transaction_id) ? $('ocr-tx').value : '';
      var attach = !!(txId && $('ocr-attach').checked && j.file);
      var notes = [];
      var p = j.saved ? Promise.resolve({ data: j.saved.row, error: null })
        : S.save(Object.assign(buildRow(j), txId && !attach ? { transaction_id: txId } : (shellOrg(where) ? { org_id: shellOrg(where) } : {})));
      p.then(function (r) {
        if (r.error) throw r.error;
        var row = r.data;
        j.saved = { id: row.id, where: where, row: row };
        var patch = reviewPatch(j, row);
        if (txId && !attach && !row.transaction_id) patch.transaction_id = txId;   // link chosen on a later save (NULL → value)
        return (Object.keys(patch).length ? S.review(row.id, patch) : Promise.resolve({ data: row, error: null }));
      }).then(function (r) {
        if (r.error) throw r.error;
        j.saved.row = r.data;
        if (!attach) return null;
        return API.attachExtractionDocument(j.saved.id, { file: j.file, transactionId: txId, kind: j.docType || 'other' }).then(function (a) {
          if (a.data && a.data.extraction) j.saved.row = a.data.extraction;
          if (a.error && a.data) { notes.push('رُبط السجل بالمعاملة لكن تعذّر رفع الملف الأصلي: ' + a.error.message); return null; }
          if (!a.error) return null;
          notes.push('تعذّر إرفاق الملف الأصلي: ' + a.error.message);
          // still link the transaction the user picked
          return S.review(j.saved.id, { transaction_id: txId }).then(function (l) {
            if (l.error) notes.push('ولم يُربط السجل بالمعاملة: ' + l.error.message);
            else j.saved.row = l.data;
          });
        });
      }).then(function () {
        setSaveMsg(notes.length ? 'warning' : 'success', (where === 'server' ? 'تم الحفظ على الخادم.' : 'تم الحفظ في السجل على هذا الجهاز.') + (notes.length ? ' ' + notes.join(' ') : ''));
        toast(where === 'server' ? 'تم حفظ المستند المقروء.' : 'تم الحفظ محليًا على هذا الجهاز.', 'success');
        renderMeta(j);
        var keepMsg = $('ocr-save-msg-text').textContent, keepCls = $('ocr-save-msg').className;
        renderSaveState(j);
        $('ocr-save-msg').className = keepCls; $('ocr-save-msg-text').textContent = keepMsg; $('ocr-save-msg').hidden = false;
        loadHistory();
      }).catch(function (e) {
        setSaveMsg('error', 'لم يُحفظ: ' + errMsg(e));
        $('ocr-save-msg').focus();
      }).then(function () { saving = false; btn.disabled = false; });
    }

    // active organization (server history / transaction picker); null when unknown
    function activeOrg() {
      if (!ONLINE || !API || !API.activeOrgId) return Promise.resolve(null);
      return API.activeOrgId().then(function (r) { return r && !r.error ? r.data || null : null; }, function () { return null; });
    }
    function resetTxPicker() {
      var sel = $('ocr-tx');
      sel.textContent = '';
      var o0 = el('option', null, 'بدون ربط'); o0.value = ''; sel.appendChild(o0);
      $('ocr-tx-q').value = '';
    }

    /* transaction picker (staff) */
    $('ocr-tx-search').addEventListener('click', searchTx);
    $('ocr-tx-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchTx(); } });
    function searchTx() {
      if (!API || !STAFF) return;
      var q = $('ocr-tx-q').value.trim();
      var sel = $('ocr-tx'), b = $('ocr-tx-search');
      b.disabled = true;
      activeOrg().then(function (oid) {
        return API.listTransactions({ search: q, limit: 15, orgId: oid || undefined });
      }).then(function (r) {
        b.disabled = false;
        sel.textContent = '';
        var o0 = el('option', null, 'بدون ربط'); o0.value = ''; sel.appendChild(o0);
        if (r.error) { toast(r.error.message, 'error'); return; }
        (r.data || []).forEach(function (t) {
          var o = el('option', null, [t.ref, t.bl_number, t.clients && t.clients.name_ar].filter(Boolean).join(' — '));
          o.value = t.id; sel.appendChild(o);
        });
        if ((r.data || []).length) { sel.selectedIndex = 1; sel.focus(); }
        announce((r.data || []).length ? 'وُجدت ' + r.data.length + ' معاملة.' : 'لا توجد معاملات مطابقة.');
      });
    }

    /* ---------------------------------------------------------------
       History (السجل)
       --------------------------------------------------------------- */
    var histQ = $('ocr-history-q'), histTimer = null;
    histQ.addEventListener('input', function () { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 300); });
    $('ocr-history-refresh').addEventListener('click', loadHistory);
    function loadHistory() {
      var q = histQ.value.trim();
      var tasks = [];
      if (ONLINE && STAFF) {
        tasks.push(activeOrg().then(function (oid) {
          return API.listExtractions({ limit: 30, q: q, orgId: oid || undefined });
        }).then(function (r) { return { where: 'server', r: r }; }));
      }
      if (LOCAL) tasks.push(LOCAL.list({ limit: 50, q: q }).then(function (r) { return { where: 'local', r: r }; }));
      if (!tasks.length) return;
      Promise.all(tasks).then(function (res) {
        var ul = $('ocr-history');
        ul.textContent = '';
        var n = 0;
        res.forEach(function (x) {
          if (x.r.error) {
            var li = el('li'); li.appendChild(el('span', 'text-sm', 'تعذّر تحميل سجل الخادم: ' + x.r.error.message)); ul.appendChild(li);
            return;
          }
          (x.r.data || []).forEach(function (row) { ul.appendChild(historyItem(row, x.where)); n++; });
        });
        $('ocr-history-empty').hidden = n > 0;
        $('ocr-history-empty').textContent = q ? 'لا توجد نتائج مطابقة.' : 'لا توجد سجلات محفوظة بعد.';
      });
    }
    function historyItem(row, where) {
      var li = el('li');
      var f = Object.assign({}, row.extracted_fields || {}, row.reviewed_fields || {});
      var main = el('div', 'ocr-h-main');
      var nm = el('span', 'ocr-h-name', row.source_name || 'مستند'); nm.title = row.source_name || '';
      main.appendChild(nm);
      var sub = el('div', 'ocr-h-sub');
      var tname = (DOC_TYPES.filter(function (t) { return t[0] === row.doc_type; })[0] || DOC_TYPES[6])[1];
      sub.appendChild(el('span', null, tname));
      if (f.invoice_number) sub.appendChild(el('span', 'num', '#' + f.invoice_number));
      if (f.total) sub.appendChild(el('span', 'num', f.total + (f.currency ? ' ' + f.currency : '')));
      sub.appendChild(el('span', null, fmtDate(row.created_at)));
      sub.appendChild(el('span', null, STATUS_LABEL[row.review_status] || ''));
      main.appendChild(sub);
      li.appendChild(main);
      li.appendChild(badge(where === 'server' ? 'badge-blue' : 'badge-teal', where === 'server' ? 'على الخادم' : 'على هذا الجهاز'));
      var tools = el('div', 'ocr-h-tools');
      var open = el('button', 'btn btn-secondary btn-sm', 'فتح');
      open.type = 'button'; open.setAttribute('aria-label', 'فتح ' + (row.source_name || 'السجل'));
      open.addEventListener('click', function () { reopen(row.id, where); });
      tools.appendChild(open);
      if (where === 'local') {
        var del = el('button', 'btn btn-ghost btn-sm', 'حذف من الجهاز');
        del.type = 'button'; del.setAttribute('aria-label', 'حذف ' + (row.source_name || 'السجل') + ' من هذا الجهاز');
        del.addEventListener('click', function () {
          ask({ title: 'حذف السجل', text: 'حذف هذا السجل من هذا الجهاز نهائيًا؟', okText: 'حذف', danger: true }).then(function (yes) {
            if (!yes) return;
            LOCAL.remove(row.id).then(function (r) {
              if (r.error) { toast(r.error.message, 'error'); return; }
              jobs.forEach(function (j) { if (j.saved && j.saved.id === row.id) j.saved = null; });
              toast('حُذف السجل من هذا الجهاز.', 'info');
              var c = current(); if (c) { renderMeta(c); renderSaveState(c); }
              loadHistory();
              histQ.focus();
            });
          });
        });
        tools.appendChild(del);
      } else {
        var vd = el('button', 'btn btn-ghost btn-sm', 'إلغاء السجل');
        vd.type = 'button'; vd.setAttribute('aria-label', 'إلغاء ' + (row.source_name || 'السجل'));
        vd.addEventListener('click', function () {
          var reason = window.prompt('سبب الإلغاء (مطلوب):', '');
          if (reason == null) return;
          if (!reason.trim()) { toast('اكتب سبب الإلغاء.', 'warning'); return; }
          API.voidExtraction(row.id, reason.trim()).then(function (r) {
            if (r.error) { toast(r.error.message, 'error'); return; }
            toast('أُلغي السجل.', 'info');
            loadHistory();
          });
        });
        tools.appendChild(vd);
      }
      li.appendChild(tools);
      return li;
    }
    // stored row → job (confidence hints re-derived by re-parsing the stored raw text)
    function reopen(id, where) {
      var existing = jobs.filter(function (j) { return j.saved && j.saved.id === id; })[0];
      if (existing) { showResult(existing.id, true); return; }
      var S = store(where);
      S.get(id).then(function (r) {
        if (r.error) { toast(r.error.message, 'error'); return; }
        var row = r.data;
        var j = { id: uid(), file: null, name: row.source_name, size: row.source_size, mime: row.source_mime, rotation: 0, status: 'done',
          progress: 100, statusText: '', error: '', thumbUrl: '', docType: row.doc_type || 'other', langs: row.languages,
          text: row.raw_text || '', confidence: row.mean_confidence == null ? null : Number(row.mean_confidence), engine: row.engine,
          pages: row.source_pages, pageCount: row.source_pages, qr: row.qr_payload || null, sha256: row.source_sha256,
          extracted: row.extracted_fields || {}, machineItems: [], saved: { id: row.id, where: where, row: row } };
        var isAi = row.engine === ENGINE_AI;
        var res = isAi ? { fields: {} } : P.extractFields(j.text, j.docType);
        if (j.qr && !isAi) res = P.mergeQr(res, j.qr);
        var stored = row.reviewed_fields || row.extracted_fields || {};
        var fields = {};
        Object.keys(stored).forEach(function (k) {
          var auto = res.fields[k];
          fields[k] = auto && auto.value === stored[k] ? auto : { value: String(stored[k]), confidence: row.reviewed_fields ? 'manual' : 'medium',
            source: row.reviewed_fields ? 'manual' : (isAi ? 'ai' : 'text'), score: isAi && row.mean_confidence != null ? Number(row.mean_confidence) / 100 : undefined };
        });
        j.fields = fields;
        j.items = (row.line_items || []).map(function (x) { return Object.assign({}, x); });
        j.machineItems = j.items;
        jobs.push(j);
        renderQueue();
        showResult(j.id, true);
      });
    }

    /* ---------------------------------------------------------------
       Init: role (online), history
       --------------------------------------------------------------- */
    function initRole() {
      if (!ONLINE || !API) return Promise.resolve(false);
      return API.getSession().then(function (s) {
        if (s.error || !s.data) return false;
        return API.isStaff().then(function (r) { return !r.error && !!r.data; });
      }).catch(function () { return false; });
    }
    function historySub() {
      $('ocr-history-sub').textContent = STAFF
        ? 'المستندات المقروءة المحفوظة على الخادم لمؤسستك، وما حُفظ على هذا الجهاز.'
        : 'المستندات المقروءة المحفوظة على هذا الجهاز. افتح أي سجل لمراجعته أو نسخه أو تنزيله.';
    }
    renderQueue();
    initRole().then(function (staff) {
      STAFF = staff;
      historySub();
      var c = current(); if (c) renderSaveState(c);
      loadHistory();
      initAi();
    });
    // org switcher (app shell): staff role, server history and the transaction picker follow the active org.
    // A result already saved keeps its row (it belongs to the org it was saved in).
    window.addEventListener('marsa:orgchange', function () {
      if (!ONLINE) return;
      initRole().then(function (s) {
        STAFF = s;
        historySub();
        resetTxPicker();
        var c = current(); if (c && !c.saved) renderSaveState(c);
        loadHistory();
        initAi();
      });
    });
    if (ONLINE && API && API.onAuth) {
      API.onAuth(function () { initRole().then(function (s) { if (s !== STAFF) { STAFF = s; var c = current(); if (c && !c.saved) renderSaveState(c); loadHistory(); initAi(); } }); });
    }
    window.addEventListener('beforeunload', function () { killWorker(); });
  });
})();

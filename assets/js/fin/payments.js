/* ==========================================================================
   مرسى | MARSA — legacy step 6: the payment register (#payments), the payment form (#payments/new) and the
   payment detail (#payments/<id>) — «السدادات والمصروفات»
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_PAY_AR.md (migration 20261122000100_legacy_pay.sql). Uses MarsaOps.ui
   (assets/js/ops/alerts.js) + MarsaOps.finUi (assets/js/fin/invoices.js), MarsaDraft (assets/js/fin/draft.js),
   MarsaPayAi (assets/js/fin/pay-ai.js) and MarsaNorm.normTas (assets/js/legacy-norm.js). Strings: 'pay.<k>'
   (assets/i18n/pay.js).

   * The UI only hides and explains — RLS and the guarded RPCs decide (record_payment_bundle, correct_payment,
     void_payment, review_payment, add_payment_documents, remove_payment_document).
   * The funding source × method matrix is mirrored from app.fin_funding_check (same rules, same order) so the form
     offers only the methods a source allows; the server enforces it again (MRS_PAY_FUNDING <rule>).
   * Claude reading (MarsaPayAi) fills ONLY empty fields as a draft; nothing is saved, approved or verified by it.
     A transaction is pre-selected only when match_payment_transaction answers one unique candidate.
   * Four eyes: approve / reject are offered only when the server says four_eyes.can_review (approver ≠ creator,
     no admin exception). Correct = void + re-record in one RPC; void needs a finance approver and a reason.
   * Payment dates are DATES (no time): never shifted by the device zone; "today" is Asia/Riyadh.
   * The unsaved form is kept per user in sessionStorage (MarsaDraft) and restored after a refresh; files are not.
   * Server and user data go through textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  /* ------------------------------------------------------------------
     Constants (mirror 20261122000100 / 20261117000100)
     ------------------------------------------------------------------ */
  var MOVEMENTS = ['org_paid', 'received_from_client', 'client_direct'];
  var PATTERNS = ['single', 'shared'];
  var ORG_SOURCES = ['org_account', 'cash_box', 'fasah_wallet', 'dry_port_wallet_org', 'client_custody', 'client_custody_dry_port', 'personal_account'];
  var ALL_SOURCES = ORG_SOURCES.concat(['client_direct', 'not_applicable_receipt']);
  var METHODS = ['sadad', 'mada', 'fasah_wallet', 'dry_port_wallet', 'bank_transfer', 'cash', 'cheque', 'other'];
  var WALLETS = ['fasah_wallet', 'dry_port_wallet'];
  var ACCOUNT_METHODS = ['sadad', 'mada', 'bank_transfer'];
  var DRY_SOURCES = ['dry_port_wallet_org', 'client_custody_dry_port'];
  var CUSTODY_SOURCES = ['client_custody', 'client_custody_dry_port'];
  var REVIEW = ['draft', 'pending', 'approved', 'rejected'];
  var STATUSES = ['recorded', 'void'];
  var DOC_ROLES = ['entity_invoice', 'payment_proof', 'extra'];
  var REF_FIELDS = ['sadad_number', 'bank_reference', 'receipt_no'];
  var REF_OF = { sadad: 'sadad_number', bank_transfer: 'bank_reference', mada: 'receipt_no', cash: 'receipt_no', cheque: 'receipt_no', other: 'receipt_no',
    fasah_wallet: 'receipt_no', dry_port_wallet: 'receipt_no' };
  var CHANNELS = ['Fasah', 'Tabadul', 'SADAD', 'mada', 'Visa', 'Mastercard', 'Apple Pay', 'STC Pay', 'urpay'];
  var LIMITS = { files: 8, fileBytes: 4194304, totalBytes: 12582912, aiDocs: 6, allocations: 50 };
  var DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
  var ACCEPT = DOC_MIME.join(',');
  // the Claude reading: the attachment types the model reads (no GIF — not an attachment type; no HEIC — attached, not read)
  var AI_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
  var APPT_CODES = ['gate_in_appointment', 'gate_out_appointment'];
  var BANK_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
  var RECEIPT_RE = /^[A-Za-z0-9؀-ۿ][A-Za-z0-9؀-ۿ\s\/._-]*$/;
  var INTERNAL_RE = /^[A-Z0-9][A-Z0-9 \/._-]*$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PAGE = 50;

  /* ------------------------------------------------------------------
     Strings ('pay.<k>'), labels 'pay.<domain>_<code>'
     ------------------------------------------------------------------ */
  function T(k, vars) {
    var I = window.MarsaI18n, key = 'pay.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    return k;
  }
  function L(domain, code) { return code == null || code === '' ? '—' : T(domain + '_' + code); }
  function lang() { var I = window.MarsaI18n; return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }

  /* ==================================================================
     Pure helpers (exported as MarsaOps.finPay.pure for the tests)
     ================================================================== */
  function str(v) { return v == null ? '' : String(v).replace(/^\s+|\s+$/g, ''); }
  function nn(v) { v = str(v); return v === '' ? null : v; }
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); }).replace(/٫/g, '.').replace(/٬/g, '');
  }
  // '' → null; '1,250.5' / '١٢٥٠٫٥' → 1250.5; garbage → NaN
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = western(v).replace(/\s+/g, '');
    if (s === '') return null;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); else s = s.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? +s : NaN;
  }
  function r2(n) { return Math.round((+n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
  function amountStr(n) { return n == null || n === '' || isNaN(+n) ? '' : r2(+n).toFixed(2); }
  // > 0, numeric(14,2)
  function moneyOk(v) { var n = num(v); return n != null && !isNaN(n) && n > 0 && n < 1e12 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6; }
  function moneyOkZero(v) { var n = num(v); return n != null && !isNaN(n) && n >= 0 && n < 1e12 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6; }
  // today in Asia/Riyadh (UTC+3, no DST) — never the device zone
  function riyadhToday(now) { return new Date((now == null ? Date.now() : +now) + 3 * 3600000).toISOString().slice(0, 10); }
  // a DATE value ('YYYY-MM-DD…') shown as that same calendar day in every zone
  function fmtDay(v, lg) {
    var s = str(v).slice(0, 10);
    if (!DATE_RE.test(s)) return v ? String(v) : '—';
    var p = s.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    try { return d.toLocaleDateString((lg || lang()) === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return s; }
  }
  // a timestamp shown in Asia/Riyadh time
  function fmtStamp(v, lg) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    try {
      return d.toLocaleString((lg || lang()) === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory',
        { timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function normTas(v) {
    var N = window.MarsaNorm;
    if (N && typeof N.normTas === 'function') return N.normTas(v) || '';
    // same rule as app.norm_tas when legacy-norm.js is absent
    var t = western(v == null ? '' : v).toUpperCase().replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/[\s\-_\/\\.]+/g, '');
    var m = t.match(/TAS(\d{8,})/) || t.match(/(\d{8,})TAS/);
    return m ? 'TAS' + m[1] : '';
  }
  // claim number identity (app.fin_norm_no, simplified: letters / digits, leading zeros dropped) — local duplicate check only
  function claimKey(v) {
    return western(str(v)).toUpperCase().replace(/(^|[^0-9])0+([0-9])/g, '$1$2').replace(/[^A-Z0-9ء-ي]+/g, '');
  }

  // ---- movement / funding / method -----------------------------------------------------------------
  function effectiveSource(mt, src) {
    if (mt === 'client_direct') return 'client_direct';
    if (mt === 'received_from_client') return 'not_applicable_receipt';
    return src || '';
  }
  function sourcesFor(mt) { return mt === 'org_paid' ? ORG_SOURCES.slice() : [effectiveSource(mt)]; }
  // the methods a funding source allows (app.fin_funding_check: wallet sources ⇔ their wallet method, cash box ⇒ cash)
  function methodsFor(src) {
    if (src === 'fasah_wallet') return ['fasah_wallet'];
    if (src === 'cash_box') return ['cash'];
    if (DRY_SOURCES.indexOf(src) !== -1) return ['dry_port_wallet'];
    return METHODS.filter(function (m) { return WALLETS.indexOf(m) === -1; });
  }
  // app.fin_funding_check(source, method, payer, account) — same rules, same order → null | the first broken rule
  function fundingRule(src, method, payer, account) {
    if (!method || METHODS.indexOf(method) === -1) return 'payment_method';
    if (!src || ALL_SOURCES.indexOf(src) === -1) return 'funding_source';
    if (method === 'fasah_wallet' && src !== 'fasah_wallet') return 'fasah_wallet_source';
    if (src === 'fasah_wallet' && method !== 'fasah_wallet') return 'fasah_wallet_method';
    if (src === 'cash_box' && method !== 'cash') return 'cash_box_method';
    if (method === 'dry_port_wallet' && DRY_SOURCES.indexOf(src) === -1) return 'dry_port_wallet_source';
    if (DRY_SOURCES.indexOf(src) !== -1 && method !== 'dry_port_wallet') return 'dry_port_wallet_method';
    if (src === 'personal_account' && !nn(payer)) return 'payer_name';
    if (ACCOUNT_METHODS.indexOf(method) !== -1 && !nn(account)) return 'paying_account';
    if (WALLETS.indexOf(method) !== -1 && nn(account)) return 'wallet_no_account';
    return null;
  }
  function ruleField(rule) {
    return rule === 'payer_name' ? 'payer_name' : rule === 'paying_account' || rule === 'wallet_no_account' ? 'paying_account'
      : rule === 'funding_source' ? 'funding_source' : 'method';
  }
  function isWallet(m) { return WALLETS.indexOf(m) !== -1; }
  function needsAccount(m) { return ACCOUNT_METHODS.indexOf(m) !== -1; }
  function refField(m) { return REF_OF[m] || null; }
  // what the payer field is for a movement + source (the server sets / replaces the payer the same way)
  function payerInfo(mt, src) {
    if (mt !== 'org_paid') return { mode: 'client' };                    // optional; default = the client
    if (src === 'org_account') return { mode: 'org' };                   // fixed: organization settings payer name
    if (src === 'fasah_wallet') return { mode: 'fixed', key: 'payer_fasah' };
    if (DRY_SOURCES.indexOf(src) !== -1) return { mode: 'fixed', key: 'payer_dry' };
    if (src === 'cash_box') return { mode: 'org_default' };              // optional; default = the organization
    if (src === 'personal_account') return { mode: 'required' };         // the person (reimbursable)
    if (src === 'client_custody') return { mode: 'client' };
    return { mode: 'optional' };
  }
  // the references: SADAD digits only; bank ref ^[A-Z0-9]+(-[A-Z0-9]+)*$; receipt ≤ 100
  function normRef(field, v) {
    var s = western(str(v));
    if (field === 'sadad_number') return s.replace(/[\s-]+/g, '');
    if (field === 'bank_reference') return s.replace(/\s+/g, '').toUpperCase();
    return s.replace(/\s+/g, ' ');
  }
  function refError(field, v) {
    var s = normRef(field, v);
    if (!s) return null;
    if (field === 'sadad_number') return !/^[0-9]+$/.test(s) ? 'format' : s.length > 30 ? 'too_long' : null;
    if (field === 'bank_reference') return s.length > 60 ? 'too_long' : BANK_RE.test(s) ? null : 'format';
    return s.length > 100 ? 'too_long' : RECEIPT_RE.test(s) ? null : 'format';
  }
  function allocTotals(paid, allocs) {
    var p = num(paid), sum = 0;
    (allocs || []).forEach(function (a) { var n = num(a && a.amount); if (n > 0) sum += n; });
    sum = r2(sum);
    var pp = p > 0 ? r2(p) : 0;
    return { paid: pp, allocated: sum, unallocated: r2(pp - sum), balanced: pp > 0 && Math.abs(pp - sum) < 0.005 };
  }
  // files = [{name, size, type}] → null | {field: count|size|total|type, name}
  function filesCheck(files) {
    var list = files || [], total = 0;
    if (list.length > LIMITS.files) return { field: 'count' };
    for (var i = 0; i < list.length; i++) {
      var f = list[i] || {};
      if (DOC_MIME.indexOf(String(f.type || '').toLowerCase()) === -1) return { field: 'type', name: f.name };
      if (!(f.size > 0) || f.size > LIMITS.fileBytes) return { field: 'size', name: f.name };
      total += f.size;
      if (total > LIMITS.totalBytes) return { field: 'total' };
    }
    return null;
  }
  function newAllocKey(allocs) {
    var n = 1;
    (allocs || []).forEach(function (a) { var m = /^a(\d+)$/.exec(a && a.key); if (m && +m[1] >= n) n = +m[1] + 1; });
    return 'a' + n;
  }
  function emptyAlloc(allocs) { return { key: newAllocKey(allocs), tx: null, amount: '', claim_no: '', internal_invoice_no: '', invoice_date: '', invoice_vat_amount: '', notes: '' }; }
  function emptyState(today) {
    return { movement_type: 'org_paid', pattern: 'single', service_item_id: '', tx: null, tx_suggested: false,
      claim_no: '', internal_invoice_no: '', invoice_date: '', invoice_vat_amount: '', appointment_no: '',
      expected_amount: '', paid_amount: '', paid_at: today || riyadhToday(), funding_source: '', method: '', paying_account: '', payer_name: '',
      beneficiary_party_id: '', payment_channel: '', sadad_number: '', bank_reference: '', receipt_no: '', notes: '',
      as_draft: false, charge_client: false, confirm_reuse: false, confirm_reuse_sig: '', allocations: [], reason: '', remove_document_ids: [], paid_at_touched: false };
  }
  // what an MRS_CONFIRM_INVOICE_REUSE confirmation covered: the issuer and every invoice line (transaction, number, internal
  // number). Any change of these after the confirmation makes it stale: the next save asks again (never sticky)
  function reuseSig(s) {
    if (!s) return '';
    var lines = s.pattern === 'shared'
      ? (s.allocations || []).map(function (a) { return [a.tx && a.tx.id || '', claimKey(a.claim_no), str(a.internal_invoice_no).toUpperCase()]; })
      : [[s.tx && s.tx.id || '', claimKey(s.claim_no), str(s.internal_invoice_no).toUpperCase()]];
    return JSON.stringify([s.movement_type || '', s.pattern || '', s.beneficiary_party_id || '', lines]);
  }
  function reuseConfirmed(s) { return !!(s && s.confirm_reuse && s.confirm_reuse_sig && s.confirm_reuse_sig === reuseSig(s)); }
  // the state kept in the session draft: never the reuse confirmation (it is given again for what is on screen)
  function draftState(s) { var c = Object.assign({}, s); c.confirm_reuse = false; c.confirm_reuse_sig = ''; return c; }
  // an appointment fee (Fasah gate-in / gate-out): its claim no is the Reference No, never the internal FP… number
  function isFpClaim(serviceCode, v) { return APPT_CODES.indexOf(serviceCode || '') !== -1 && /^\s*FP/i.test(western(str(v))); }
  // a transaction row (listTransactions / getTransaction / an allocation / a match candidate) → the form's tx
  function txOf(x) {
    if (!x) return null;
    var id = x.transaction_id || x.id;
    if (!id) return null;
    return { id: id, ref: x.transaction_ref || x.ref || null, client_id: x.client_id || null,
      client_name: x.client_name || (x.clients && x.clients.name_ar) || null, branch_id: x.branch_id || null };
  }
  // the form state → the record_payment_bundle payload (docs = [{finance_document_id, role, allocation?}])
  function buildPayload(s, docs) {
    var mt = s.movement_type, shared = s.pattern === 'shared', ref = refField(s.method), pi = payerInfo(mt, s.funding_source);
    var p = { movement_type: mt, pattern: shared ? 'shared' : 'single', paid_amount: r2(num(s.paid_amount)), paid_at: s.paid_at, method: s.method,
      review_status: s.as_draft ? 'draft' : 'pending' };
    if (s.service_item_id) p.service_item_id = s.service_item_id;
    if (mt === 'org_paid') p.funding_source = s.funding_source;
    if (moneyOk(s.expected_amount)) p.expected_amount = r2(num(s.expected_amount));
    var tas = nn(s.appointment_no) ? normTas(s.appointment_no) : '';
    if (tas) p.appointment_no = tas;
    if (!isWallet(s.method) && nn(s.paying_account)) p.paying_account = nn(s.paying_account);
    if ((pi.mode === 'required' || pi.mode === 'optional' || pi.mode === 'org_default' || pi.mode === 'client') && nn(s.payer_name)) p.payer_name = nn(s.payer_name);
    if (mt !== 'received_from_client' && s.beneficiary_party_id) p.beneficiary_party_id = s.beneficiary_party_id;
    if (nn(s.payment_channel)) p.payment_channel = nn(s.payment_channel);
    if (ref && nn(s[ref])) p[ref] = normRef(ref, s[ref]);
    if (nn(s.notes)) p.notes = nn(s.notes);
    if (mt === 'org_paid' && s.charge_client) p.charge_client = true;
    if (reuseConfirmed(s)) p.confirm_invoice_reuse = true;
    var inv = mt !== 'received_from_client';
    if (!shared) {
      if (s.tx && s.tx.id) p.transaction_id = s.tx.id;
      if (inv) {
        if (nn(s.claim_no)) p.claim_no = nn(s.claim_no);
        if (nn(s.internal_invoice_no)) p.internal_invoice_no = western(nn(s.internal_invoice_no)).toUpperCase();
        if (nn(s.invoice_date)) p.invoice_date = nn(s.invoice_date);
        if (moneyOkZero(s.invoice_vat_amount)) p.invoice_vat_amount = r2(num(s.invoice_vat_amount));
      }
    } else {
      p.allocations = (s.allocations || []).map(function (a) {
        var x = { transaction_id: a.tx && a.tx.id ? a.tx.id : null, amount: r2(num(a.amount)), key: a.key };
        if (inv && nn(a.claim_no)) x.claim_no = nn(a.claim_no);
        if (inv && nn(a.internal_invoice_no)) x.internal_invoice_no = western(nn(a.internal_invoice_no)).toUpperCase();
        if (inv && nn(a.invoice_date)) x.invoice_date = nn(a.invoice_date);
        if (inv && moneyOkZero(a.invoice_vat_amount)) x.invoice_vat_amount = r2(num(a.invoice_vat_amount));
        if (nn(a.notes)) x.notes = nn(a.notes);
        return x;
      });
    }
    if (docs && docs.length) p.documents = docs;
    if (s.remove_document_ids && s.remove_document_ids.length) p.remove_document_ids = s.remove_document_ids.slice();
    return p;
  }
  // local checks before anything is sent → {field: message key}; files = [{role, alloc, size, type, name}]
  function validate(s, files, o) {
    o = o || {};
    var e = {}, mt = s.movement_type, shared = s.pattern === 'shared', today = o.today || riyadhToday();
    files = files || [];
    if (MOVEMENTS.indexOf(mt) === -1) e.movement_type = 'required';
    if (!s.service_item_id) e.service_item_id = 'required';
    if (!nn(s.paid_amount)) e.paid_amount = 'required'; else if (!moneyOk(s.paid_amount)) e.paid_amount = 'money';
    if (nn(s.expected_amount) && !moneyOk(s.expected_amount)) e.expected_amount = 'money';
    if (!nn(s.paid_at)) e.paid_at = 'required';
    else if (!DATE_RE.test(s.paid_at) || s.paid_at < '2000-01-01') e.paid_at = 'date_bad';
    else if (s.paid_at > today) e.paid_at = 'date_future';
    if (nn(s.invoice_date) && (!DATE_RE.test(s.invoice_date) || s.invoice_date < '2000-01-01')) e.invoice_date = 'date_bad';
    if (nn(s.appointment_no) && !normTas(s.appointment_no)) e.appointment_no = 'tas_invalid';
    if (mt !== 'received_from_client') {
      if (!s.beneficiary_party_id) e.beneficiary_party_id = 'required';
      if (!shared) {
        if (nn(s.claim_no) && !claimKey(s.claim_no)) e.claim_no = 'claim_bad';
        else if (isFpClaim(o.serviceCode, s.claim_no)) e.claim_no = 'claim_fp';
        if (nn(s.internal_invoice_no) && !INTERNAL_RE.test(western(s.internal_invoice_no).toUpperCase())) e.internal_invoice_no = 'internal_bad';
        if (nn(s.invoice_vat_amount) && !moneyOkZero(s.invoice_vat_amount)) e.invoice_vat_amount = 'money_zero';
      }
    }
    if (!shared) {
      if (!s.tx || !s.tx.id) e.tx = 'tx_required';
    } else {
      var al = s.allocations || [];
      if (al.length < 2) e.allocations = 'alloc_count';
      else if (al.length > LIMITS.allocations) e.allocations = 'alloc_max';
      var seen = {}, branch = null, clients = {};
      al.forEach(function (a) {
        var k = 'alloc.' + a.key + '.';
        if (!a.tx || !a.tx.id) e[k + 'tx'] = 'tx_required';
        if (!nn(a.amount)) e[k + 'amount'] = 'required'; else if (!moneyOk(a.amount)) e[k + 'amount'] = 'money';
        if (mt !== 'received_from_client' && nn(a.internal_invoice_no) && !INTERNAL_RE.test(western(a.internal_invoice_no).toUpperCase())) e[k + 'internal_invoice_no'] = 'internal_bad';
        if (mt !== 'received_from_client' && nn(a.claim_no) && !claimKey(a.claim_no)) e[k + 'claim_no'] = 'claim_bad';
        else if (mt !== 'received_from_client' && isFpClaim(o.serviceCode, a.claim_no)) e[k + 'claim_no'] = 'claim_fp';
        if (mt !== 'received_from_client' && nn(a.invoice_vat_amount) && !moneyOkZero(a.invoice_vat_amount)) e[k + 'invoice_vat_amount'] = 'money_zero';
        if (a.tx && a.tx.id) {
          var sig = a.tx.id + '|' + (mt === 'received_from_client' ? '' : claimKey(a.claim_no));
          if (seen[sig]) e[k + 'claim_no'] = 'alloc_dup';
          seen[sig] = true;
          if (a.tx.branch_id) { if (branch && branch !== a.tx.branch_id && !e.allocations) e.allocations = 'alloc_branch'; branch = branch || a.tx.branch_id; }
          if (a.tx.client_id) clients[a.tx.client_id] = true;
        }
      });
      if (!e.allocations && al.length >= 2 && (mt !== 'org_paid' || CUSTODY_SOURCES.indexOf(s.funding_source) !== -1) && Object.keys(clients).length > 1) e.allocations = 'alloc_client';
      if (!e.allocations && al.length >= 2 && moneyOk(s.paid_amount) && !allocTotals(s.paid_amount, al).balanced) e.allocations = 'alloc_sum';
      if (mt !== 'received_from_client') {
        var claims = {};
        al.forEach(function (a) {
          var c = claimKey(a.claim_no);
          if (!c) return;
          if (claims[c]) e['alloc.' + a.key + '.claim_no'] = e['alloc.' + a.key + '.claim_no'] || 'invoice_twice';
          claims[c] = true;
        });
      }
    }
    var src = effectiveSource(mt, s.funding_source);
    if (mt === 'org_paid' && !s.funding_source) e.funding_source = 'required';
    if (!s.method) e.method = 'required';
    if (!e.funding_source && !e.method) {
      var pi = payerInfo(mt, s.funding_source);
      var payer = pi.mode === 'org' || pi.mode === 'fixed' ? 'x' : s.payer_name;
      var rule = fundingRule(src, s.method, payer, s.paying_account);
      if (rule && !e[ruleField(rule)]) e[ruleField(rule)] = 'rule_' + rule;
    }
    var ref = refField(s.method), hasProof = files.some(function (f) { return f.role === 'payment_proof'; }) || !!o.carriedProof;
    if (ref) {
      var re = refError(ref, s[ref]);
      if (re) e[ref] = re === 'too_long' ? 'too_long' : 'ref_format_' + ref;
      else if (!nn(s[ref]) && isWallet(s.method) && !hasProof) e[ref] = 'wallet_ref_or_proof';
      else if (!nn(s[ref]) && !isWallet(s.method)) e[ref] = 'required';
    }
    var anyClaim = shared ? (s.allocations || []).some(function (a) { return !!nn(a.claim_no); }) : !!nn(s.claim_no);
    if (mt === 'client_direct' && anyClaim && !hasProof) e._files = 'proof_required';
    var fc = filesCheck(files);
    if (fc && !e._files) e._files = 'files_' + fc.field;
    if (!e._files && shared && files.some(function (f) { return f.role === 'entity_invoice' && !f.alloc; })) e._files = 'doc_alloc';
    if (o.correct && str(s.reason).length < 3) e.reason = 'reason_min';
    return e;
  }
  // a server error → the form field it belongs to (or '_form')
  function errorField(err) {
    if (!err) return '_form';
    var c = err.code, f = err.field;
    if (c === 'MRS_PAY_REF_TAKEN' || c === 'MRS_PAY_REFERENCE' || c === 'MRS_PAY_REF_METHOD') return REF_FIELDS.indexOf(f) !== -1 ? f : '_form';
    if (c === 'MRS_PAY_FUNDING') return ruleField(f);
    if (c === 'MRS_PAY_INVOICE_TAKEN' || c === 'MRS_CONFIRM_INVOICE_REUSE') return f === 'internal_invoice_no' ? 'internal_invoice_no' : 'claim_no';
    if (c === 'MRS_PAY_ALLOCATION') return 'allocations';
    if (c === 'MRS_PAY_DOCUMENT') return '_files';
    if (c === 'MRS_REQUIRED' || c === 'MRS_INVALID' || c === 'MRS_TOO_LONG') {
      var map = { payment_proof: '_files', service_item: 'service_item_id', transaction_id: 'tx', finance_document_id: '_files', documents: '_files',
        claim_no_fp: 'claim_no', internal_invoice_mismatch: 'internal_invoice_no' };
      if (map[f]) return map[f];
      if (f === 'payment_reference') return 'receipt_no';
      return f || '_form';
    }
    return '_form';
  }
  // check_payment_duplicates → [{tone, key, vars}] explained with the earlier transaction
  function dupLines(d) {
    var out = [];
    ((d && d.references) || []).forEach(function (r) {
      // an entry of a branch the caller cannot read: only «taken» (the server sends no ref / transaction / amount)
      if (r.hidden) { out.push({ tone: 'danger', key: 'dup_ref_hidden', field: r.field, vars: { field: T('f_' + r.field) } }); return; }
      out.push({ tone: 'danger', key: 'dup_ref', field: r.field, vars: { field: T('f_' + r.field), ref: r.ref || '—', tx: r.transaction_ref || '—',
        amount: amountStr(r.amount), date: r.paid_at ? fmtDay(r.paid_at) : '—' } });
    });
    ((d && d.invoices) || []).forEach(function (r) {
      var k = r.kind === 'taken' ? (r.hidden ? 'dup_inv_taken_hidden' : 'dup_inv_taken') : r.kind === 'other_issuer' ? 'dup_inv_other' : r.kind === 'existing_invoice' ? 'dup_inv_existing' : 'dup_inv_internal';
      out.push({ tone: r.kind === 'existing_invoice' ? 'info' : r.kind === 'other_issuer' ? 'warning' : 'danger', key: k, field: r.kind === 'internal_taken' ? 'internal_invoice_no' : 'claim_no',
        vars: { no: r.kind === 'internal_taken' ? (r.internal_invoice_no || r.claim_no || '') : (r.claim_no || ''), ref: r.ref || '—', issuer: r.issuer_name || '—' } });
    });
    return out;
  }
  // the payment JSON → the form state (correct mode)
  function stateFromPayment(d, today) {
    var s = emptyState(today), al = (d && d.allocations) || [];
    s.movement_type = d.movement_type; s.pattern = d.pattern === 'shared' ? 'shared' : 'single';
    s.service_item_id = d.service_item_id || '';
    s.appointment_no = d.appointment_no || '';
    s.expected_amount = amountStr(d.expected_amount); s.paid_amount = amountStr(d.paid_amount);
    s.paid_at = str(d.paid_at).slice(0, 10) || s.paid_at;
    // the recorded date is a value, not the untouched default: a Claude reading on the correction form never replaces it
    s.paid_at_touched = true;
    s.funding_source = d.movement_type === 'org_paid' ? (d.funding_source || '') : '';
    s.method = d.method || ''; s.paying_account = d.paying_account || '';
    var pm = payerInfo(d.movement_type, d.funding_source).mode;
    s.payer_name = pm === 'org' || pm === 'fixed' ? '' : (d.payer_name || '');
    s.beneficiary_party_id = d.beneficiary_party_id || ''; s.payment_channel = d.payment_channel || '';
    REF_FIELDS.forEach(function (k) { s[k] = d[k] || ''; });
    s.notes = d.notes || ''; s.charge_client = !!d.charge_client;
    if (s.pattern === 'single') {
      var a = al[0] || {};
      s.tx = a.transaction_id ? { id: a.transaction_id, ref: a.transaction_ref || null, client_id: a.client_id || null, client_name: a.client_name || null, branch_id: d.branch_id || null } : null;
      s.claim_no = a.claim_no || d.claim_no || ''; s.internal_invoice_no = a.internal_invoice_no || '';
      // the invoice date / VAT of the booked supplier invoice: the correction re-creates it, so they are carried
      var si = a.supplier_invoice;
      if (si) { s.invoice_date = str(si.invoice_date).slice(0, 10); s.invoice_vat_amount = si.vat_amount != null ? amountStr(si.vat_amount) : ''; }
    } else {
      s.allocations = al.map(function (a) {
        var si = a.supplier_invoice;
        return { key: 'a' + (a.seq || 1), tx: { id: a.transaction_id, ref: a.transaction_ref || null, client_id: a.client_id || null, client_name: a.client_name || null, branch_id: d.branch_id || null },
          amount: amountStr(a.amount), claim_no: a.claim_no || '', internal_invoice_no: a.internal_invoice_no || '',
          invoice_date: si ? str(si.invoice_date).slice(0, 10) : '', invoice_vat_amount: si && si.vat_amount != null ? amountStr(si.vat_amount) : '', notes: a.notes || '' };
      });
    }
    return s;
  }
  // why void / correct are refused (step 7 Daftra columns, an invoiced charge, an active custody deduction) | null
  function lockOf(d) {
    if (!d) return null;
    if (d.daftra_draft_id || d.daftra_linked_at) return 'daftra';
    if ((d.allocations || []).some(function (a) { return a.client_charge && a.client_charge.status === 'invoiced'; })) return 'invoiced';
    if ((d.custody_deductions || []).some(function (c) { return c.status === 'active'; })) return 'custody';
    return null;
  }
  function draftScope(q) {
    if (q && q.correct && UUID_RE.test(q.correct)) return 'pay-form.correct.' + q.correct;
    if (q && q.tx && UUID_RE.test(q.tx)) return 'pay-form.tx.' + q.tx;
    return 'pay-form.new';
  }
  // the readings' suggestion → the form (ONLY the empty fields, MarsaPayAi.fillEmpty); method conflicts and the references of
  // another method are skipped; → { state, filled [keys], skipped [keys] }
  function applySuggestion(s, sug, ctx) {
    ctx = ctx || {};
    var PA = window.MarsaPayAi;
    var out = JSON.parse(JSON.stringify(s)), filled = [], skipped = [];
    if (!PA || !sug) return { state: out, filled: filled, skipped: skipped };
    var cur = {};
    PA.FILLABLE.forEach(function (k) { cur[k] = out[k] == null ? '' : out[k]; });
    cur.service_code = ctx.serviceCode || '';
    // the payment date still at its default (today, untouched) counts as empty: the document's Date of Payment is better
    if (!out.paid_at_touched) cur.paid_at = '';
    cur.beneficiary_name = ctx.beneficiaryName || '';
    if (out.pattern === 'shared') { ['claim_no', 'internal_invoice_no', 'invoice_date', 'invoice_vat_amount', 'appointment_no'].forEach(function (k) { cur[k] = 'x'; }); }
    if (out.movement_type === 'received_from_client') { ['claim_no', 'internal_invoice_no', 'invoice_date', 'invoice_vat_amount'].forEach(function (k) { cur[k] = 'x'; }); }
    var r = PA.fillEmpty(cur, sug);
    var allowed = methodsFor(effectiveSource(out.movement_type, out.funding_source));
    var m = out.method;
    var target = function () { return m || (allowed.length === 1 ? allowed[0] : ''); };
    if (r.filled.indexOf('method') !== -1) {
      if (out.movement_type === 'org_paid' && !out.funding_source && isWallet(r.form.method)) { m = r.form.method; }
      else if (allowed.indexOf(r.form.method) === -1) { skipped.push('method'); }
      else m = r.form.method;
    }
    r.filled.forEach(function (k) {
      if (k === 'method') { if (skipped.indexOf('method') === -1) { out.method = m; filled.push(k); } return; }
      if (REF_FIELDS.indexOf(k) !== -1) { if (target() && refField(target()) !== k) { skipped.push(k); return; } out[k] = String(r.form[k]); filled.push(k); return; }
      if (k === 'service_code' || k === 'beneficiary_name') { filled.push(k); return; }   // resolved by the caller (catalog / parties)
      var v = r.form[k];
      if (k === 'paid_amount' || k === 'expected_amount' || k === 'invoice_vat_amount') v = amountStr(v);
      if ((k === 'paid_at' || k === 'invoice_date') && !DATE_RE.test(String(v))) { skipped.push(k); return; }
      if (k === 'appointment_no') { v = normTas(v); if (!v) { skipped.push(k); return; } }
      out[k] = String(v);
      filled.push(k);
    });
    if (out.method === 'fasah_wallet' && out.movement_type === 'org_paid' && !out.funding_source && filled.indexOf('method') !== -1) { out.funding_source = 'fasah_wallet'; filled.push('funding_source'); }
    if (out.method === 'dry_port_wallet' && out.movement_type === 'org_paid' && !out.funding_source && filled.indexOf('method') !== -1) skipped.push('funding_source');
    return { state: out, filled: filled, skipped: skipped, service_code: r.filled.indexOf('service_code') !== -1 ? r.form.service_code : null,
      beneficiary_name: r.filled.indexOf('beneficiary_name') !== -1 ? r.form.beneficiary_name : null };
  }
  // a reading's beneficiary name → the one matching party (rough match, legacy) | null
  function partyByName(parties, name) {
    var PA = window.MarsaPayAi;
    if (!name || !PA) return null;
    var hits = (parties || []).filter(function (p) {
      return (!!str(p.name_ar) && PA.roughMatch(name, p.name_ar)) || (!!str(p.name_en) && PA.roughMatch(name, p.name_en));
    });
    return hits.length === 1 ? hits[0] : null;
  }

  var PURE = {
    MOVEMENTS: MOVEMENTS, PATTERNS: PATTERNS, ORG_SOURCES: ORG_SOURCES, ALL_SOURCES: ALL_SOURCES, METHODS: METHODS, REVIEW: REVIEW, STATUSES: STATUSES,
    DOC_ROLES: DOC_ROLES, REF_FIELDS: REF_FIELDS, LIMITS: LIMITS, DOC_MIME: DOC_MIME, CHANNELS: CHANNELS,
    num: num, r2: r2, amountStr: amountStr, moneyOk: moneyOk, riyadhToday: riyadhToday, fmtDay: fmtDay, fmtStamp: fmtStamp, normTas: normTas, claimKey: claimKey,
    effectiveSource: effectiveSource, sourcesFor: sourcesFor, methodsFor: methodsFor, fundingRule: fundingRule, ruleField: ruleField, isWallet: isWallet,
    needsAccount: needsAccount, refField: refField, payerInfo: payerInfo, normRef: normRef, refError: refError, allocTotals: allocTotals, filesCheck: filesCheck,
    emptyState: emptyState, emptyAlloc: emptyAlloc, txOf: txOf, reuseSig: reuseSig, reuseConfirmed: reuseConfirmed, draftState: draftState, isFpClaim: isFpClaim, buildPayload: buildPayload, validate: validate, errorField: errorField, dupLines: dupLines,
    stateFromPayment: stateFromPayment, lockOf: lockOf, draftScope: draftScope, applySuggestion: applySuggestion, partyByName: partyByName
  };

  /* ==================================================================
     Shared UI bits
     ================================================================== */
  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }
  function errText(U, api, e) {
    var c = U.errCode(e), f = e && e.field;
    if (c === 'MRS_FORBIDDEN' && f === 'self_approval') return T('err_self_approval');
    if (c === 'MRS_FORBIDDEN') return T('err_forbidden');
    return U.errMsg(e, api);
  }
  var TONE = {
    review: { draft: 'neutral', pending: 'warning', approved: 'success', rejected: 'danger' },
    status: { recorded: 'success', void: 'neutral' }
  };
  function pill(U, domain, code) { return U.pill((TONE[domain] || {})[code] || 'info', L(domain, code)); }
  function moneyNode(U, n) {
    if (n == null || n === '' || isNaN(+n)) return U.el('span', { class: 'ops-muted', text: '—' });
    return U.el('bdi', { dir: 'ltr', class: 'num fin-money' + (+n < 0 ? ' is-neg' : ''), text: U.fmtMoney(+n, 'SAR') });
  }
  function userName(api, id) { if (!id) return '—'; try { return typeof api.who === 'function' ? api.who(id) || String(id).slice(0, 8) : String(id).slice(0, 8); } catch (e) { return String(id).slice(0, 8); } }
  function meId(api) { return api && api.userId ? api.userId : null; }
  // an inline reason / note panel (mobile friendly, no modal): onSubmit(note) → Promise<{error}>
  function reasonPanel(U, host, o) {
    var el = U.el;
    U.clear(host);
    var id = 'pay-rp-' + (o.id || 'x');
    var ta = el('textarea', { class: 'form-control', id: id, rows: 2, maxlength: o.max || 500, 'aria-describedby': id + '-e' });
    var err = el('p', { class: 'form-error', id: id + '-e', hidden: true, role: 'alert' });
    var go = U.btn(o.submitText, o.danger ? 'btn-danger' : 'btn-primary', function () {
      var v = str(ta.value);
      if (v.length < (o.min == null ? 3 : o.min)) { err.textContent = o.minMsg || T('reason_min'); err.hidden = false; return; }
      err.hidden = true; go.disabled = true;
      Promise.resolve(o.onSubmit(v)).then(function (r) {
        go.disabled = false;
        if (r && r.error) { err.textContent = r.message || ''; err.hidden = false; return; }
        U.clear(host);
      });
    }, { 'data-go': o.id || 'x' });
    var cancel = U.btn(T('cancel'), 'btn-ghost', function () { U.clear(host); });
    host.appendChild(el('div', { class: 'pay-reason card' }, [
      o.title ? el('strong', { class: 'pay-reason-title', text: o.title }) : null,
      o.text ? el('p', { class: 'form-hint', text: o.text }) : null,
      el('label', { class: 'form-label', for: id, text: o.label || T('reason') }), ta, err,
      el('div', { class: 'pay-actions' }, [go, cancel])
    ]));
    try { ta.focus(); } catch (e) { /* ignore */ }
    return { textarea: ta, go: go };
  }

  /* ==================================================================
     #payments — the register (search + filters, table in its own scroll box)
     ================================================================== */
  var PF = { q: '', status: 'recorded', review_status: '', method: '', funding_source: '', movement_type: '', pattern: '', date_from: '', date_to: '',
    transaction_id: '', tx_ref: '', offset: 0 };
  function listFilters() {
    var f = { limit: PAGE, offset: PF.offset, status: PF.status || 'recorded' };
    ['q', 'review_status', 'method', 'funding_source', 'movement_type', 'pattern', 'date_from', 'date_to', 'transaction_id'].forEach(function (k) {
      var v = str(PF[k]); if (v) f[k] = v;
    });
    return f;
  }
  function renderList(root, api, F, q) {
    var U = F.U, el = U.el, sc = U.scope(root);
    if (q && q.tx && UUID_RE.test(q.tx)) { if (q.tx !== PF.transaction_id) { PF.transaction_id = q.tx; PF.tx_ref = ''; PF.offset = 0; } PF.tx_from_url = true; }
    else if (PF.tx_from_url) { PF.transaction_id = ''; PF.tx_ref = ''; PF.offset = 0; PF.tx_from_url = false; } // a plain #payments drops the ?tx= filter
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'pay-view');
    var acts = [];
    if (api.can('finWrite')) acts.push(el('a', { class: 'btn btn-sm btn-primary', href: '#payments/new', 'data-act': 'pay-new' }, [U.icon('plus'), el('span', { text: T('new_payment') })]));
    root.appendChild(U.head(T('reg_title'), T('reg_sub'), acts));
    var tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis pay-tiles', 'aria-live': 'polite' });
    var bar = el('div', { class: 'pay-bar' }), body = el('div', { class: 'pay-body' });
    root.appendChild(tiles); root.appendChild(bar); root.appendChild(body);
    var countEl = null, seq = 0;
    function load() {
      var my = ++seq;
      U.loadingInto(body);
      if (countEl) countEl.textContent = '';
      return U.call(api, 'listPayments', api.orgId, listFilters()).then(function (r) {
        if (!sc.alive() || my !== seq) return;
        U.doneLoading(body);
        if (r.error) { drawTiles(null); body.appendChild(U.errorState(api, r.error, load)); return; }
        var d = r.data || {}, rows = Array.isArray(d.rows) ? d.rows : [];
        var total = d.total != null ? +d.total : rows.length;
        drawTiles(d);
        if (countEl) countEl.textContent = T('count_n', { n: total });
        drawRows(rows, total);
      });
    }
    function drawTiles(d) {
      U.clear(tiles);
      var t = (d && d.totals) || {};
      tiles.appendChild(U.kpi(T('tile_count'), d ? String(d.total || 0) : '—', 'neutral'));
      tiles.appendChild(U.kpi(T('tile_paid'), d ? U.fmtMoney(+t.paid || 0, 'SAR') : '—', 'neutral'));
      tiles.appendChild(U.kpi(T('tile_expected'), d ? U.fmtMoney(+t.expected || 0, 'SAR') : '—', 'neutral'));
      tiles.appendChild(U.kpi(T('tile_difference'), d ? U.fmtMoney(+t.difference || 0, 'SAR') : '—', d && Math.abs(+t.difference || 0) >= 0.005 ? 'warning' : 'neutral'));
    }
    function sel(name, label, codes, domain, allLabel) {
      return U.select(name, label, [['', label + ': ' + (allLabel || T('all'))]].concat(codes.map(function (c) { return [c, L(domain, c)]; })), PF[name], function (v) { PF[name] = v; PF.offset = 0; load(); });
    }
    function drawBar() {
      U.clear(bar);
      var search = U.searchBox(PF.q, T('search_label'), function (v) { PF.q = v; PF.offset = 0; load(); });
      var st = U.select('status', T('f_status'), STATUSES.map(function (c) { return [c, L('status', c)]; }).concat([['all', T('f_status') + ': ' + T('all')]]), PF.status, function (v) { PF.status = v; PF.offset = 0; load(); });
      var fl = [st, sel('review_status', T('f_review'), REVIEW, 'review'), sel('method', T('f_method'), METHODS, 'method'),
        sel('funding_source', T('f_funding'), ALL_SOURCES, 'source'), sel('movement_type', T('f_movement'), MOVEMENTS, 'mt'),
        F.dateInput('date_from', T('date_from'), PF.date_from, function (v) { PF.date_from = v; PF.offset = 0; load(); }),
        F.dateInput('date_to', T('date_to'), PF.date_to, function (v) { PF.date_to = v; PF.offset = 0; load(); })];
      var txBox = el('div', { class: 'pay-tx-filter' });
      if (PF.transaction_id) {
        txBox.appendChild(el('span', { class: 'badge badge-teal' }, [T('f_tx') + ': ', el('bdi', { dir: 'ltr', text: PF.tx_ref || String(PF.transaction_id).slice(0, 8) })]));
        txBox.appendChild(U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { PF.transaction_id = ''; PF.tx_ref = ''; PF.offset = 0; drawBar(); load(); }, { 'aria-label': T('clear_tx'), title: T('clear_tx'), 'data-act': 'clear-tx' }));
      } else {
        var finder = F.txFinder(api, function (x) { PF.transaction_id = x.id; PF.tx_ref = x.ref || ''; PF.offset = 0; drawBar(); load(); });
        txBox.appendChild(finder.node);
      }
      fl.push(txBox);
      var ref = U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': T('refresh'), title: T('refresh') });
      bar.appendChild(U.toolbar(search, fl, [ref], ''));
      countEl = bar.querySelector('.toolbar-count');
    }
    function txCell(p) {
      var list = Array.isArray(p.transactions) ? p.transactions : [];
      if (!list.length) return '—';
      var kids = list.slice(0, 2).map(function (x) {
        return el('span', { class: 'cell-sub pay-tx-chip' }, [el('a', { class: 'ops-ref', href: '#tx/' + x.transaction_id }, el('bdi', { dir: 'ltr', text: x.ref || '' })), x.client_name ? ' · ' + x.client_name : null]);
      });
      if (list.length > 2) kids.push(el('span', { class: 'cell-sub', text: T('more_n', { n: list.length - 2 }) }));
      return kids;
    }
    drawBar();
    function drawRows(rows, total) {
      U.clear(body);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('inbox', T('reg_empty_title'), T('reg_empty_text')))); return; }
      var tbl = U.table([T('c_ref'), T('c_movement'), T('c_service'), T('c_tx'), T('c_beneficiary'), T('c_method'), { label: T('c_paid'), num: true }, T('c_review')],
        rows.map(function (p) {
          return el('tr', { 'data-id': p.id, class: p.status === 'void' ? 'is-muted' : null }, [
            U.td([el('a', { class: 'ops-ref cell-main', href: '#payments/' + p.id }, el('bdi', { dir: 'ltr', text: p.ref || String(p.id).slice(0, 8) })),
              el('span', { class: 'cell-sub', text: fmtDay(p.paid_at) })]),
            U.td([el('span', { class: 'cell-main', text: L('mt', p.movement_type) }), el('span', { class: 'cell-sub', text: L('pattern', p.pattern) + (+p.allocation_count > 1 ? ' (' + p.allocation_count + ')' : '') })]),
            U.td([el('span', { class: 'cell-main', text: (lang() === 'en' && p.service_name_en) || p.service_name_ar || p.service_code || '—' }),
              p.claim_no ? el('span', { class: 'cell-sub' }, [T('f_claim_no') + ': ', el('bdi', { dir: 'ltr', text: p.claim_no })]) : null,
              p.appointment_no ? el('span', { class: 'cell-sub' }, el('bdi', { dir: 'ltr', text: p.appointment_no })) : null]),
            U.td(txCell(p)),
            U.td([el('span', { class: 'cell-main', text: p.beneficiary_name || '—' }), p.payer_name ? el('span', { class: 'cell-sub', text: T('payer_short') + ': ' + p.payer_name }) : null]),
            U.td([el('span', { class: 'cell-main', text: L('method', p.method) }), el('span', { class: 'cell-sub', text: L('source', p.funding_source) }),
              refOf(p) ? el('span', { class: 'cell-sub' }, el('bdi', { dir: 'ltr', text: refOf(p) })) : null]),
            U.td([moneyNode(U, p.paid_amount), Math.abs(+p.difference || 0) >= 0.005 ? el('span', { class: 'cell-sub pay-diff' }, [T('difference') + ': ', moneyNode(U, p.difference)]) : null], 'num'),
            U.td([pill(U, 'review', p.review_status), p.status === 'void' ? pill(U, 'status', 'void') : null])
          ]);
        }), { caption: T('reg_title') });
      tbl.classList.add('pay-scroll');
      body.appendChild(U.card(null, tbl, null, { flush: true }));
      var pg = F.pager(total, PAGE, PF.offset, function (o) { PF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    return load();
  }
  function refOf(p) { return p.sadad_number || p.bank_reference || p.receipt_no || null; }

  /* ==================================================================
     #payments/<id> — detail, review (four eyes), correct, void, documents
     ================================================================== */
  function renderDetail(root, api, F, id) {
    var U = F.U, el = U.el, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'pay-view');
    var body = el('div');
    root.appendChild(body);
    function load() {
      U.loadingInto(body);
      return U.call(api, 'getPayment', id).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(r.data || {});
      });
    }
    function after(r, okKey) {
      if (r.error) return { error: true, message: errText(U, api, r.error) };
      U.toast(api, T(okKey), 'success');
      load();
      return { error: null };
    }
    function draw(d) {
      U.clear(body);
      var back = el('a', { class: 'btn btn-sm btn-ghost', href: '#payments' }, T('back_list'));
      var head = U.head(d.ref || T('payment'), L('mt', d.movement_type) + ' · ' + L('pattern', d.pattern), [back]);
      body.appendChild(head);
      var pills = el('div', { class: 'pay-pills' }, [pill(U, 'review', d.review_status), pill(U, 'status', d.status)]);
      body.appendChild(pills);
      var lock = lockOf(d), b = d.branch_id, mine = d.created_by && d.created_by === meId(api);
      var fe = d.four_eyes || {};
      if (d.status === 'void') body.appendChild(U.alertBox('info', T('void_note', { reason: d.void_reason || '—', when: fmtStamp(d.voided_at) })));
      if (d.corrected_by) body.appendChild(el('div', { class: 'alert alert-info', role: 'status' }, [el('span', { text: T('corrected_by') + ' ' }), el('a', { class: 'ops-ref', href: '#payments/' + d.corrected_by.id }, el('bdi', { dir: 'ltr', text: d.corrected_by.ref || '' }))]));
      if (d.corrects) body.appendChild(el('div', { class: 'alert alert-info', role: 'status' }, [el('span', { text: T('corrects') + ' ' }), el('a', { class: 'ops-ref', href: '#payments/' + d.corrects.id }, el('bdi', { dir: 'ltr', text: d.corrects.ref || '' }))]));
      if (d.status === 'recorded' && d.review_status === 'pending' && !fe.can_review) {
        body.appendChild(U.alertBox('warning', mine ? T('four_eyes_mine') : T('four_eyes_wait')));
      }
      if (d.review_status === 'rejected' && d.review_note) body.appendChild(U.alertBox('danger', T('rejected_note', { note: d.review_note })));
      if (lock && d.status === 'recorded') body.appendChild(U.alertBox('warning', T('lock_' + lock)));
      // actions
      var panel = el('div', { class: 'pay-panel', 'aria-live': 'polite' });
      var acts = [];
      if (d.status === 'recorded') {
        if (d.review_status === 'draft' && F.canAt(api, 'finWrite', b)) acts.push(U.btn(T('act_submit'), 'btn-primary', function () {
          U.call(api, 'reviewPayment', d.id, 'submit', null).then(function (r) { var x = after(r, 'submitted'); if (x.error) U.toast(api, x.message, 'error'); });
        }, { 'data-act': 'submit' }));
        if (fe.can_review === true) {
          acts.push(U.btn(T('act_approve'), 'btn-primary', function () {
            U.confirm(api, { title: T('approve_title'), text: T('approve_text', { ref: d.ref || '' }), okText: T('act_approve') }).then(function (yes) {
              if (!yes) return;
              U.call(api, 'reviewPayment', d.id, 'approve', null).then(function (r) { var x = after(r, 'approved'); if (x.error) U.toast(api, x.message, 'error'); });
            });
          }, { 'data-act': 'approve' }));
          acts.push(U.btn(T('act_reject'), 'btn-secondary', function () {
            reasonPanel(U, panel, { id: 'reject', title: T('reject_title'), label: T('reject_note'), submitText: T('act_reject'), danger: true, min: 3,
              onSubmit: function (note) { return U.call(api, 'reviewPayment', d.id, 'reject', note).then(function (r) { return after(r, 'rejected'); }); } });
          }, { 'data-act': 'reject' }));
        }
        var canCorrect = !lock && !d.corrected_by && (d.review_status === 'approved' ? F.canAt(api, 'finApprove', b) : F.canAt(api, 'finWrite', b));
        if (canCorrect) acts.push(el('a', { class: 'btn btn-sm btn-secondary', href: '#payments/new?correct=' + d.id, 'data-act': 'correct' }, T('act_correct')));
        if (!lock && F.canAt(api, 'finApprove', b)) acts.push(U.btn(T('act_void'), 'btn-subtle', function () {
          reasonPanel(U, panel, { id: 'void', title: T('void_title'), text: T('void_text'), label: T('reason'), submitText: T('act_void'), danger: true, min: 3,
            onSubmit: function (note) { return U.call(api, 'voidPayment', d.id, note).then(function (r) { return after(r, 'voided'); }); } });
        }, { 'data-act': 'void' }));
      }
      if (acts.length) body.appendChild(el('div', { class: 'pay-actions pay-detail-actions' }, acts));
      body.appendChild(panel);
      body.appendChild(el('p', { class: 'form-hint', text: T('four_eyes_rule') }));
      // facts
      var refTxt = refOf(d);
      body.appendChild(U.card(T('sec_facts'), F.dl([
        [T('f_service_item'), (lang() === 'en' && d.service_name_en) || d.service_name_ar || d.service_code],
        [T('f_beneficiary'), d.beneficiary_name],
        [T('f_claim_no'), d.claim_no ? U.ltr(d.claim_no) : null],
        [T('f_appointment_no'), d.appointment_no ? U.ltr(d.appointment_no) : null],
        [T('f_expected'), moneyNode(U, d.expected_amount)], [T('f_paid'), moneyNode(U, d.paid_amount)], [T('difference'), moneyNode(U, d.difference)],
        [T('f_paid_at'), fmtDay(d.paid_at)],
        [T('f_funding'), L('source', d.funding_source)], [T('f_method'), L('method', d.method)],
        [T('f_paying_account'), d.paying_account], [T('f_payer'), d.payer_name], [T('f_channel'), d.payment_channel],
        [refTxt ? T('f_' + (d.sadad_number ? 'sadad_number' : d.bank_reference ? 'bank_reference' : 'receipt_no')) : T('f_reference'), refTxt ? U.ltr(refTxt) : null],
        [T('f_charge_client'), d.charge_client ? T('yes') : null],
        [T('f_notes'), d.notes],
        [T('created'), userName(api, d.created_by) + ' · ' + fmtStamp(d.created_at)],
        [T('reviewed'), d.reviewed_at ? userName(api, d.reviewed_by) + ' · ' + fmtStamp(d.reviewed_at) : null]
      ])));
      // allocations (each transaction's share)
      var al = d.allocations || [];
      body.appendChild(U.card(T('sec_allocations', { n: al.length }), U.table([T('c_tx'), { label: T('c_share'), num: true }, T('f_claim_no'), T('c_invoice'), T('c_charge')],
        al.map(function (a) {
          var si = a.supplier_invoice;
          return el('tr', { 'data-alloc': a.id, class: a.voided_at ? 'is-muted' : null }, [
            U.td([el('a', { class: 'ops-ref', href: '#tx/' + a.transaction_id }, el('bdi', { dir: 'ltr', text: a.transaction_ref || '' })), a.client_name ? el('span', { class: 'cell-sub', text: a.client_name }) : null]),
            U.td(moneyNode(U, a.amount), 'num'),
            U.td([a.claim_no ? U.ltr(a.claim_no) : '—', a.internal_invoice_no ? el('span', { class: 'cell-sub' }, [T('f_internal_no') + ': ', el('bdi', { dir: 'ltr', text: a.internal_invoice_no })]) : null]),
            U.td(si ? [el('a', { class: 'ops-ref', href: '#costs/' + si.id }, el('bdi', { dir: 'ltr', text: si.invoice_number || '' })), el('span', { class: 'cell-sub', text: si.created_by_this ? T('inv_created') : T('inv_reused') })] : '—'),
            U.td(a.client_charge ? [moneyNode(U, a.client_charge.total_amount), el('span', { class: 'cell-sub', text: T('charge_' + a.client_charge.status) })] : '—')
          ]);
        }), { caption: T('sec_allocations', { n: al.length }) }), null, { flush: true }));
      // documents
      body.appendChild(docsCard(F, api, d, load));
      if ((d.custody_deductions || []).length) {
        body.appendChild(U.card(T('sec_custody'), el('ul', { class: 'adm-list' }, d.custody_deductions.map(function (c) {
          return el('li', null, [el('bdi', { dir: 'ltr', text: c.ref || '' }), ' · ', moneyNode(U, c.amount), ' · ', pill(U, 'status', c.status === 'active' ? 'recorded' : 'void')]);
        }))));
      }
    }
    return load();
  }
  function allocLabel(a) { return '#' + a.seq + ' · ' + (a.transaction_ref || '') + (a.claim_no ? ' · ' + a.claim_no : ''); }
  function docsCard(F, api, d, reload) {
    var U = F.U, el = U.el;
    var docs = d.documents || [], live = docs.filter(function (x) { return !x.removed_at; });
    var panel = el('div', { class: 'pay-panel' });
    // an approved entry keeps the evidence that was approved (the server refuses: MRS_BAD_TRANSITION approved_documents)
    var approved = d.review_status === 'approved';
    var canW = d.status === 'recorded' && !approved && F.canAt(api, 'finWrite', d.branch_id);
    var list = el('ul', { class: 'pay-docs' }, docs.map(function (x) {
      var a = (d.allocations || []).filter(function (y) { return y.id === x.allocation_id; })[0];
      return el('li', { class: 'pay-doc' + (x.removed_at ? ' is-removed' : ''), 'data-doc': x.id }, [
        el('span', { class: 'badge badge-blue', text: L('role', x.role) }),
        el('bdi', { class: 'pay-doc-name', text: x.original_name || '' }),
        el('span', { class: 'text-xs text-muted', text: fmtSize(x.size_bytes) + (a ? ' · ' + allocLabel(a) : '') }),
        x.removed_at ? el('span', { class: 'text-xs text-muted', text: T('doc_removed', { reason: x.remove_reason || '' }) }) : null,
        !x.removed_at && x.storage_path ? F.fileLink(api, x.storage_path, 'finance', T('open_file')) : null,
        !x.removed_at && canW ? U.btn(T('doc_remove'), 'btn-subtle', function () {
          reasonPanel(U, panel, { id: 'rm-' + x.id, title: T('doc_remove_title', { name: x.original_name || '' }), label: T('reason'), submitText: T('doc_remove'), danger: true, min: 3,
            onSubmit: function (note) {
              return U.call(api, 'removePaymentDocument', x.id, note).then(function (r) {
                if (r.error) return { error: true, message: errText(U, api, r.error) };
                U.toast(api, T('doc_removed_ok'), 'success'); reload(); return { error: null };
              });
            } });
        }, { 'data-remove': x.id }) : null
      ]);
    }));
    var kids = [docs.length ? list : el('p', { class: 'text-sm text-muted', text: T('docs_none') }), panel];
    if (d.status === 'recorded' && approved) kids.push(el('p', { class: 'form-hint', 'data-note': 'docs-locked', text: T('docs_locked_approved') }));
    if (canW) {
      var picker = filesPicker(F, api, { shared: d.pattern === 'shared', allocations: (d.allocations || []).map(function (a) { return { key: String(a.seq), label: allocLabel(a) }; }), existing: live.length });
      var addB = U.btn(T('docs_add_save'), 'btn-secondary', function () {
        var files = picker.files();
        var chk = filesCheck(files);
        if (!files.length) { picker.error(T('pick_file')); return; }
        if (chk) { picker.error(T('files_' + chk.field, { name: chk.name || '' })); return; }
        if (files.some(function (f) { return d.pattern === 'shared' && f.role === 'entity_invoice' && !f.alloc; })) { picker.error(T('doc_alloc')); return; }
        addB.disabled = true;
        uploadAll(F, api, files, d.branch_id).then(function (u) {
          if (u.error) { addB.disabled = false; picker.error(errText(U, api, u.error)); return; }
          var docsP = u.docs.map(function (x) { var y = { finance_document_id: x.finance_document_id, role: x.role }; if (x.allocation) y.allocation = +x.allocation; return y; });
          var scope = 'pay-adddocs-' + d.id, key = U.idemKey(api, scope, docsP);
          U.call(api, 'addPaymentDocuments', d.id, docsP, { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            addB.disabled = false;
            if (r.error) { picker.error(errText(U, api, r.error)); return; }
            U.toast(api, T('docs_added'), 'success'); reload();
          });
        });
      }, { 'data-act': 'add-docs' });
      kids.push(el('div', { class: 'pay-docs-add' }, [picker.node, addB]));
    }
    return U.card(T('sec_documents', { n: live.length }), kids);
  }
  function fmtSize(n) { n = +n || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  // a typed attachments picker: rows [{file, role, alloc}] (+ limits); o = {shared, allocations [{key, label}], existing}
  function filesPicker(F, api, o) {
    var U = F.U, el = U.el, rows = [];
    var inp = el('input', { type: 'file', class: 'form-control pay-file-input', accept: ACCEPT, multiple: true, 'aria-label': T('docs_pick'), 'data-files': 'pick' });
    var listEl = el('ul', { class: 'pay-files' });
    var err = el('p', { class: 'form-error', role: 'alert', hidden: true });
    var hint = el('p', { class: 'form-hint', text: T('docs_limits') });
    function draw() {
      U.clear(listEl);
      rows.forEach(function (r, i) {
        var role = el('select', { class: 'form-control is-sm', 'aria-label': T('doc_role'), 'data-role-of': String(i) }, DOC_ROLES.map(function (c) { return el('option', { value: c, text: L('role', c) }); }));
        role.value = r.role;
        role.addEventListener('change', function () { r.role = role.value; draw(); if (o.onChange) o.onChange(); });
        var alloc = null;
        if (o.shared) {
          var allocs = typeof o.allocations === 'function' ? o.allocations() : (o.allocations || []);
          alloc = el('select', { class: 'form-control is-sm', 'aria-label': T('doc_alloc_label'), 'data-alloc-of': String(i) },
            [el('option', { value: '', text: r.role === 'entity_invoice' ? T('doc_alloc_pick') : T('doc_alloc_none') })].concat(allocs.map(function (a) { return el('option', { value: a.key, text: a.label }); })));
          alloc.value = r.alloc || '';
          alloc.addEventListener('change', function () { r.alloc = alloc.value; if (o.onChange) o.onChange(); });
        }
        var rm = U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { rows.splice(i, 1); draw(); if (o.onChange) o.onChange(); }, { 'aria-label': T('doc_unpick'), title: T('doc_unpick') });
        listEl.appendChild(el('li', { class: 'pay-file' + (r.file.size > LIMITS.fileBytes || DOC_MIME.indexOf(String(r.file.type || '').toLowerCase()) === -1 ? ' is-bad' : '') }, [
          el('bdi', { class: 'pay-file-name', text: r.file.name || '' }), el('span', { class: 'text-xs text-muted', text: fmtSize(r.file.size) }), role, alloc, rm]));
      });
      var chk = filesCheck(files());
      if (chk) { err.textContent = T('files_' + chk.field, { name: chk.name || '' }); err.hidden = false; } else err.hidden = true;
    }
    function add(list, role, alloc) {
      Array.prototype.slice.call(list || []).forEach(function (f) {
        if (rows.some(function (r) { return r.file === f || (r.file.name === f.name && r.file.size === f.size && r.file.lastModified === f.lastModified); })) return;
        rows.push({ file: f, role: role || (rows.some(function (r) { return r.role === 'entity_invoice'; }) ? 'payment_proof' : 'entity_invoice'), alloc: alloc || '' });
      });
      draw();
      if (o.onChange) o.onChange();
    }
    inp.addEventListener('change', function () { add(inp.files); try { inp.value = ''; } catch (e) { /* old browsers */ } });
    function files() { return rows.map(function (r) { return { file: r.file, name: r.file.name, size: r.file.size, type: r.file.type, role: r.role, alloc: r.alloc }; }); }
    return {
      node: el('div', { class: 'pay-files-box' }, [inp, hint, listEl, err]),
      files: files, add: add, redraw: draw,
      error: function (m) { err.textContent = m; err.hidden = !m; },
      has: function (f) { return rows.some(function (r) { return r.file === f; }); }
    };
  }
  // upload each picked file (finance_documents; entity invoice → kind supplier_invoice, else payment_evidence) → {docs, error}
  function uploadAll(F, api, files, branchId) {
    var up = api.__payUploader || (api.__payUploader = F.uploader(api));
    var out = [], i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve({ docs: out, error: null });
      var f = files[i++];
      return up(f.file, branchId, f.role === 'entity_invoice' ? 'supplier_invoice' : 'payment_evidence').then(function (r) {
        var id = r && r.data && r.data.id;
        if (!id && r && r.error && r.error.refId && F.U.errCode(r.error) === 'MRS_INVALID') id = r.error.refId;   // the same file registered before
        if (!id) return { docs: out, error: (r && r.error) || { code: 'MRS_UPLOAD' } };
        out.push({ finance_document_id: id, role: f.role, allocation: f.alloc || null });
        return next();
      });
    }
    return next();
  }

  /* ==================================================================
     #payments/new[?tx=<id> | ?correct=<id>] — the payment form
     ================================================================== */
  function renderForm(root, api, F, q) {
    var U = F.U, el = U.el, sc = U.scope(root);
    var D = window.MarsaDraft;
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'pay-view', 'pay-form-view');
    if (!api.can('finWrite')) { root.appendChild(U.emptyState('alert', null, T('err_forbidden'))); return null; }
    var correctId = q && q.correct && UUID_RE.test(q.correct) ? q.correct : null;
    var presetTx = q && q.tx && UUID_RE.test(q.tx) ? q.tx : null;
    var scope = draftScope(q), uid = meId(api);
    var today = riyadhToday();
    var state = emptyState(today), old = null, items = [], parties = [], restored = null;
    var ctl = {}, errs = {}, aiDocs = [], aiResult = null, dupRes = null, busy = false;
    var saver = D ? D.autosave(scope, uid, function () { return { state: draftState(state) }; }, 400) : null;
    var picker = null;
    root.appendChild(U.head(correctId ? T('form_correct_title') : T('form_title'), correctId ? T('form_correct_sub') : T('form_sub'),
      [el('a', { class: 'btn btn-sm btn-ghost', href: correctId ? '#payments/' + correctId : '#payments' }, T('back'))]));
    var host = el('div', { class: 'pay-form' });
    root.appendChild(host);
    U.loadingInto(host);

    function changed() { if (saver) saver.schedule(); }
    function itemCode(id) { var it = items.filter(function (x) { return x.id === id; })[0]; return it ? it.code : ''; }
    function partyName(id) { var p = parties.filter(function (x) { return x.id === id; })[0]; return p ? U.partyName(p) : ''; }
    function clientName() {
      if (state.pattern === 'single') return state.tx && state.tx.client_name;
      var a = (state.allocations || []).filter(function (x) { return x.tx && x.tx.client_name; })[0];
      return a ? a.tx.client_name : null;
    }
    function branchId() {
      if (state.pattern === 'single') return state.tx && state.tx.branch_id;
      var a = (state.allocations || []).filter(function (x) { return x.tx && x.tx.branch_id; })[0];
      return a ? a.tx.branch_id : null;
    }

    /* ---- field builders (bound to state) ---- */
    function box(name, label, control, o) {
      o = o || {};
      var id = 'pay-f-' + name.replace(/\./g, '-');
      control.setAttribute('id', id);
      control.setAttribute('data-name', name);
      control.setAttribute('aria-describedby', id + '-e');
      var err = el('span', { class: 'form-error', id: id + '-e', hidden: true });
      errs[name] = err; ctl[name] = control;
      return el('div', { class: 'form-group pay-field' + (o.full ? ' is-full' : '') + (o.cls ? ' ' + o.cls : ''), 'data-field': name }, [
        el('label', { class: 'form-label', for: id }, [label, o.req ? el('span', { class: 'ops-req', 'aria-hidden': 'true', text: ' *' }) : null]),
        control, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null, o.after || null, err
      ]);
    }
    function text(name, o) {
      o = o || {};
      var i = el('input', { class: 'form-control', type: o.type || 'text', dir: o.ltr ? 'ltr' : null, inputmode: o.inputmode || null, maxlength: o.max || null,
        max: o.maxDate || null, placeholder: o.ph || null, autocomplete: 'off', list: o.list || null, disabled: !!o.disabled });
      i.value = o.value != null ? o.value : (state[name] == null ? '' : String(state[name]));
      if (!o.disabled) {
        i.addEventListener('input', function () { state[name] = i.value; setErr(name, null); if (o.onInput) o.onInput(i.value); changed(); });
        if (o.onBlur) i.addEventListener('blur', function () { o.onBlur(i.value); });
      }
      return i;
    }
    function choose(name, options, o) {
      o = o || {};
      var s = el('select', { class: 'form-control' }, options.map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
      s.value = state[name] == null ? '' : String(state[name]);
      s.addEventListener('change', function () { state[name] = s.value; setErr(name, null); if (o.onChange) o.onChange(s.value); else changed(); });
      return s;
    }
    function check(name, label, o) {
      o = o || {};
      var c = el('input', { type: 'checkbox', checked: !!state[name] });
      c.setAttribute('data-name', name);
      c.addEventListener('change', function () { state[name] = !!c.checked; changed(); });
      ctl[name] = c;
      return el('div', { class: 'form-group pay-field is-full' }, [el('label', { class: 'check ops-check' }, [c, el('span', { text: label })]), o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null]);
    }
    function setErr(name, msg) {
      var e = errs[name], c = ctl[name];
      if (!e) return false;
      e.textContent = msg || ''; e.hidden = !msg;
      if (c) { if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); }
      return true;
    }
    function section(title, kids, cls) {
      return el('section', { class: 'pay-sec' + (cls ? ' ' + cls : '') }, [el('h3', { class: 'pay-sec-title', text: title }), el('div', { class: 'pay-grid' }, kids)]);
    }

    /* ---- live parts ---- */
    var diffOut = null, totalsOut = null, dupBox = null, formErr = null, saveB = null, refErrNode = {};
    function drawDiff() {
      if (!diffOut) return;
      var e = num(state.expected_amount), p = num(state.paid_amount);
      U.clear(diffOut);
      if (e == null || p == null || isNaN(e) || isNaN(p)) { diffOut.appendChild(el('span', { class: 'ops-muted', text: T('diff_auto') })); return; }
      diffOut.appendChild(moneyNode(U, r2(e - p)));
    }
    function drawTotals() {
      if (!totalsOut) return;
      var t = allocTotals(state.paid_amount, state.allocations);
      U.clear(totalsOut);
      totalsOut.className = 'pay-totals' + (t.balanced ? ' is-ok' : t.unallocated < 0 ? ' is-over' : ' is-short');
      totalsOut.appendChild(el('span', null, [T('alloc_total') + ': ', moneyNode(U, t.paid)]));
      totalsOut.appendChild(el('span', null, [T('alloc_allocated') + ': ', moneyNode(U, t.allocated)]));
      totalsOut.appendChild(el('span', { class: 'pay-unalloc' }, [T('alloc_unallocated') + ': ', moneyNode(U, t.unallocated)]));
    }
    var dupTimer = null, dupSeq = 0;
    function dupCheck() {
      clearTimeout(dupTimer);
      dupTimer = setTimeout(function () {
        var ref = refField(state.method), p = {}, my = ++dupSeq;
        if (ref && nn(state[ref]) && !refError(ref, state[ref])) p[ref] = normRef(ref, state[ref]);
        if (state.beneficiary_party_id) p.beneficiary_party_id = state.beneficiary_party_id;
        var claims = state.movement_type === 'received_from_client' ? [] : state.pattern === 'single'
          ? (nn(state.claim_no) || nn(state.internal_invoice_no) ? [{ claim_no: nn(state.claim_no), internal_invoice_no: nn(state.internal_invoice_no) }] : [])
          : state.allocations.filter(function (a) { return nn(a.claim_no) || nn(a.internal_invoice_no); }).map(function (a) { return { claim_no: nn(a.claim_no), internal_invoice_no: nn(a.internal_invoice_no) }; });
        if (claims.length) p.claims = claims;
        if (correctId) p.exclude_id = correctId;
        if (!p[ref] && !claims.length) { dupRes = null; drawDup(); return; }
        U.call(api, 'checkPaymentDuplicates', api.orgId, p).then(function (r) {
          if (my !== dupSeq || !sc.alive()) return;
          dupRes = r.error ? null : r.data;
          drawDup();
        });
      }, 350);
    }
    function drawDup() {
      if (!dupBox) return;
      U.clear(dupBox);
      var lines = dupLines(dupRes);
      if (!lines.length) return;
      lines.forEach(function (x) { dupBox.appendChild(U.alertBox(x.tone === 'info' ? 'info' : x.tone === 'warning' ? 'warning' : 'danger', T(x.key, x.vars))); });
    }

    /* ---- the form ---- */
    function draw() {
      ctl = {}; errs = {};
      U.clear(host);
      var mt = state.movement_type, shared = state.pattern === 'shared', inv = mt !== 'received_from_client';
      var src = effectiveSource(mt, state.funding_source);
      if (restored) {
        host.appendChild(el('div', { class: 'alert alert-info pay-restored', role: 'status' }, [
          el('div', { class: 'ops-alert-text', text: T('draft_restored', { when: fmtStamp(restored) }) }),
          U.btn(T('draft_discard'), 'btn-ghost', function () { if (D) D.clear(scope, uid); restored = null; start(true); }, { 'data-act': 'discard-draft' })
        ]));
      }
      if (correctId && old) {
        host.appendChild(U.alertBox('warning', T('correct_note', { ref: old.ref || '' })));
        host.appendChild(section(T('sec_correct'), [
          box('reason', T('correct_reason'), (function () { var ta = el('textarea', { class: 'form-control', rows: 2, maxlength: 500 }); ta.value = state.reason; ta.addEventListener('input', function () { state.reason = ta.value; setErr('reason', null); changed(); }); return ta; })(), { req: true, full: true }),
          carriedDocs()
        ]));
      }
      host.appendChild(aiSection());
      // 1. movement + pattern
      host.appendChild(section(T('sec_kind'), [
        box('movement_type', T('f_movement'), choose('movement_type', MOVEMENTS.map(function (c) { return [c, L('mt', c)]; }), { onChange: function () {
          if (state.movement_type !== 'org_paid') { state.funding_source = ''; state.charge_client = false; }
          var allowed = methodsFor(effectiveSource(state.movement_type, state.funding_source));
          if (state.method && allowed.indexOf(state.method) === -1) state.method = '';
          if (state.movement_type === 'received_from_client') state.beneficiary_party_id = '';
          changed(); draw();
        } }), { req: true, hint: T('mt_hint_' + mt) }),
        box('pattern', T('f_pattern'), choose('pattern', PATTERNS.map(function (c) { return [c, L('pattern', c)]; }), { onChange: function () {
          if (state.pattern === 'shared' && !state.allocations.length) {
            var a1 = emptyAlloc([]); a1.tx = state.tx; a1.claim_no = state.claim_no; a1.internal_invoice_no = state.internal_invoice_no; a1.invoice_date = state.invoice_date;
            state.allocations = [a1, emptyAlloc([a1])];
          }
          if (state.pattern === 'single' && !state.tx && state.allocations.length && state.allocations[0].tx) state.tx = state.allocations[0].tx;
          changed(); draw();
        } }), { req: true, hint: T('pattern_hint') })
      ]));
      // 2. service, beneficiary, transaction, invoice
      var svc = [box('service_item_id', T('f_service_item'), choose('service_item_id', [['', T('choose')]].concat(items.map(function (it) {
        return [it.id, (lang() === 'en' && it.name_en) || it.name_ar];
      }))), { req: true })];
      if (inv) {
        svc.push(box('beneficiary_party_id', T('f_beneficiary'), choose('beneficiary_party_id', [['', T('choose')]].concat(parties.map(function (p) { return [p.id, U.partyName(p)]; })), { onChange: function () { changed(); dupCheck(); } }),
          { req: true, hint: T('beneficiary_hint') }));
      } else {
        svc.push(el('div', { class: 'form-group pay-field' }, [el('span', { class: 'form-label', text: T('f_beneficiary') }), el('p', { class: 'pay-static', text: T('beneficiary_org', { org: api.orgName || T('org_word') }) })]));
      }
      if (!shared) svc.push(txField());
      if (inv && !shared) {
        svc.push(box('claim_no', T('f_claim_no'), text('claim_no', { ltr: true, max: 60, onBlur: dupCheck }), { hint: T('claim_hint') }));
        svc.push(box('internal_invoice_no', T('f_internal_no'), text('internal_invoice_no', { ltr: true, max: 60, onBlur: dupCheck }), { hint: T('internal_hint') }));
        svc.push(box('invoice_date', T('f_invoice_date'), text('invoice_date', { type: 'date', maxDate: today })));
        svc.push(box('invoice_vat_amount', T('f_invoice_vat'), text('invoice_vat_amount', { ltr: true, inputmode: 'decimal', max: 16 })));
      }
      if (!shared) svc.push(box('appointment_no', T('f_appointment_no'), text('appointment_no', { ltr: true, max: 80, ph: 'TAS…', onBlur: function (v) {
        var t = nn(v) ? normTas(v) : '';
        if (nn(v) && !t) setErr('appointment_no', T('tas_invalid'));
        else if (t && t !== v) { state.appointment_no = t; ctl.appointment_no.value = t; changed(); }
      } }), { hint: T('tas_hint') }));
      host.appendChild(section(T('sec_service'), svc));
      // 3. amounts and date
      diffOut = el('output', { class: 'pay-static pay-diff-out', 'aria-live': 'polite' });
      host.appendChild(section(T('sec_amounts'), [
        box('expected_amount', T('f_expected'), text('expected_amount', { ltr: true, inputmode: 'decimal', max: 16, onInput: drawDiff }), { hint: T('expected_hint') }),
        box('paid_amount', T('f_paid'), text('paid_amount', { ltr: true, inputmode: 'decimal', max: 16, onInput: function () { drawDiff(); drawTotals(); } }), { req: true }),
        el('div', { class: 'form-group pay-field' }, [el('span', { class: 'form-label', text: T('difference') }), diffOut]),
        box('paid_at', T('f_paid_at'), text('paid_at', { type: 'date', maxDate: today, onInput: function () { state.paid_at_touched = true; } }), { req: true, hint: T('paid_at_hint') })
      ]));
      drawDiff();
      // 4. shared allocations
      totalsOut = null;
      if (shared) host.appendChild(allocSection(inv));
      // 5. funding and payment
      host.appendChild(fundingSection(mt, src));
      // 6. attachments
      host.appendChild(filesSection());
      // 7. notes and review
      var tail = [box('notes', T('f_notes'), (function () { var ta = el('textarea', { class: 'form-control', rows: 2, maxlength: 2000 }); ta.value = state.notes; ta.addEventListener('input', function () { state.notes = ta.value; changed(); }); return ta; })(), { full: true }),
        check('as_draft', T('f_as_draft'), { hint: T('as_draft_hint') })];
      if (mt === 'org_paid') tail.push(check('charge_client', T('f_charge_client'), { hint: T('charge_client_hint') }));
      host.appendChild(section(T('sec_review'), tail));
      host.appendChild(el('p', { class: 'form-hint', text: T('four_eyes_rule') }));
      formErr = el('div', { class: 'pay-form-error', 'aria-live': 'assertive' });
      host.appendChild(formErr);
      saveB = U.btn(correctId ? T('save_correct') : T('save'), 'btn-primary', save, { 'data-act': 'save' });
      host.appendChild(el('div', { class: 'pay-actions pay-form-actions' }, [saveB,
        el('a', { class: 'btn btn-sm btn-ghost', href: correctId ? '#payments/' + correctId : '#payments' }, T('cancel'))]));
      drawDup();
    }
    function txField() {
      var wrap = el('div', { class: 'pay-tx' });
      var chosen = el('div', { class: 'pay-tx-chosen' });
      if (state.tx) {
        chosen.appendChild(el('span', { class: 'badge badge-teal' }, [T('f_tx') + ': ', el('bdi', { dir: 'ltr', text: state.tx.ref || String(state.tx.id).slice(0, 8) })]));
        if (state.tx.client_name) chosen.appendChild(el('span', { class: 'text-xs text-muted', text: ' ' + state.tx.client_name }));
        if (state.tx_suggested) chosen.appendChild(el('span', { class: 'badge badge-warning', text: T('tx_suggested') }));
        chosen.appendChild(U.btn(T('tx_change'), 'btn-subtle', function () { state.tx = null; state.tx_suggested = false; changed(); draw(); }, { 'data-act': 'tx-change' }));
        wrap.appendChild(chosen);
      } else {
        var f = F.txFinder(api, function (x) { state.tx = txOf(x); state.tx_suggested = false; changed(); draw(); });
        wrap.appendChild(f.node);
      }
      var b = box('tx', T('f_tx'), wrap, { req: true, full: true });
      return b;
    }
    function allocSection(inv) {
      var rowsEl = el('div', { class: 'pay-allocs' });
      state.allocations.forEach(function (a, i) {
        var k = 'alloc.' + a.key + '.';
        function atext(name, o) {
          o = o || {};
          var x = el('input', { class: 'form-control', type: o.type || 'text', dir: o.ltr ? 'ltr' : null, inputmode: o.inputmode || null, maxlength: o.max || null, max: o.maxDate || null, autocomplete: 'off' });
          x.value = a[name] == null ? '' : String(a[name]);
          x.addEventListener('input', function () { a[name] = x.value; setErr(k + name, null); if (o.onInput) o.onInput(); changed(); });
          if (o.onBlur) x.addEventListener('blur', o.onBlur);
          return x;
        }
        var txNode = el('div', { class: 'pay-tx' });
        if (a.tx) {
          txNode.appendChild(el('span', { class: 'badge badge-teal' }, el('bdi', { dir: 'ltr', text: a.tx.ref || String(a.tx.id).slice(0, 8) })));
          if (a.tx.client_name) txNode.appendChild(el('span', { class: 'text-xs text-muted', text: ' ' + a.tx.client_name }));
          txNode.appendChild(U.btn(T('tx_change'), 'btn-subtle', function () { a.tx = null; changed(); draw(); }));
        } else {
          txNode.appendChild(F.txFinder(api, function (x) { a.tx = txOf(x); changed(); draw(); }).node);
        }
        var fill = U.btn(T('alloc_fill'), 'btn-subtle', function () {
          var t = allocTotals(state.paid_amount, state.allocations);
          var cur = num(a.amount) > 0 ? num(a.amount) : 0;
          if (t.unallocated > 0) { a.amount = amountStr(cur + t.unallocated); changed(); draw(); }
        }, { 'data-fill': a.key });
        var rm = state.allocations.length > 2 ? U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { state.allocations.splice(i, 1); changed(); draw(); }, { 'aria-label': T('alloc_remove'), title: T('alloc_remove'), 'data-rm': a.key }) : null;
        var fields = [box(k + 'tx', T('f_tx'), txNode, { req: true, full: true }),
          box(k + 'amount', T('alloc_amount'), atext('amount', { ltr: true, inputmode: 'decimal', max: 16, onInput: drawTotals }), { req: true, after: fill })];
        if (inv) {
          fields.push(box(k + 'claim_no', T('f_claim_no'), atext('claim_no', { ltr: true, max: 60, onBlur: dupCheck })));
          fields.push(box(k + 'internal_invoice_no', T('f_internal_no'), atext('internal_invoice_no', { ltr: true, max: 60, onBlur: dupCheck })));
          fields.push(box(k + 'invoice_date', T('f_invoice_date'), atext('invoice_date', { type: 'date', maxDate: today })));
          fields.push(box(k + 'invoice_vat_amount', T('f_invoice_vat'), atext('invoice_vat_amount', { ltr: true, inputmode: 'decimal', max: 16 })));
        }
        fields.push(box(k + 'notes', T('f_notes'), atext('notes', { max: 500 })));
        rowsEl.appendChild(el('fieldset', { class: 'pay-alloc', 'data-alloc': a.key }, [
          el('legend', { class: 'pay-alloc-legend' }, [T('alloc_n', { n: i + 1 }), rm]), el('div', { class: 'pay-grid' }, fields)]));
      });
      totalsOut = el('div', { class: 'pay-totals', 'aria-live': 'polite' });
      var add = U.btn([U.icon('plus'), el('span', { text: T('alloc_add') })], 'btn-secondary', function () {
        if (state.allocations.length >= LIMITS.allocations) return;
        state.allocations.push(emptyAlloc(state.allocations)); changed(); draw();
      }, { 'data-act': 'alloc-add' });
      var errNode = el('span', { class: 'form-error', hidden: true, role: 'alert' });
      errs.allocations = errNode;
      var sec = el('section', { class: 'pay-sec pay-sec-allocs' }, [el('h3', { class: 'pay-sec-title', text: T('sec_allocations_form') }),
        el('p', { class: 'form-hint', text: T('alloc_hint') }), totalsOut, errNode, rowsEl, add]);
      drawTotals();
      return sec;
    }
    function fundingSection(mt, src) {
      var kids = [];
      if (mt === 'org_paid') {
        kids.push(box('funding_source', T('f_funding'), choose('funding_source', [['', T('choose')]].concat(ORG_SOURCES.map(function (c) { return [c, L('source', c)]; })), { onChange: function () {
          var allowed = methodsFor(state.funding_source);
          if (allowed.length === 1) state.method = allowed[0];
          else if (state.method && allowed.indexOf(state.method) === -1) state.method = '';
          if (isWallet(state.method)) state.paying_account = '';
          changed(); draw();
        } }), { req: true, hint: state.funding_source ? T('src_hint_' + state.funding_source) : T('src_hint') }));
      } else {
        kids.push(el('div', { class: 'form-group pay-field' }, [el('span', { class: 'form-label', text: T('f_funding') }), el('p', { class: 'pay-static', text: L('source', src) })]));
      }
      var allowed = methodsFor(src);
      kids.push(box('method', T('f_method'), choose('method', [['', T('choose')]].concat(allowed.map(function (c) { return [c, L('method', c)]; })), { onChange: function () {
        var keep = refField(state.method);
        REF_FIELDS.forEach(function (k) { if (k !== keep) state[k] = ''; });
        if (isWallet(state.method)) state.paying_account = '';
        changed(); draw();
      } }), { req: true, hint: allowed.length === 1 ? T('method_fixed') : null }));
      if (state.method && !isWallet(state.method)) {
        kids.push(box('paying_account', T('f_paying_account'), text('paying_account', { max: 120 }), { req: needsAccount(state.method), hint: needsAccount(state.method) ? T('account_hint') : T('account_optional') }));
      } else if (isWallet(state.method)) {
        kids.push(el('div', { class: 'form-group pay-field' }, [el('span', { class: 'form-label', text: T('f_paying_account') }), el('p', { class: 'pay-static text-muted', text: T('wallet_no_bank') })]));
      }
      var pi = payerInfo(mt, state.funding_source);
      if (pi.mode === 'org') kids.push(box('payer_name', T('f_payer'), text('payer_name', { disabled: true, value: api.orgName || '' , ph: T('payer_org_ph') }), { hint: T('payer_org_hint') }));
      else if (pi.mode === 'fixed') kids.push(box('payer_name', T('f_payer'), text('payer_name', { disabled: true, value: T(pi.key) }), { hint: T('payer_fixed_hint') }));
      else kids.push(box('payer_name', T(pi.mode === 'required' ? 'f_payer_person' : 'f_payer'), text('payer_name', { max: 160,
        ph: pi.mode === 'org_default' ? (api.orgName || T('payer_org_ph')) : pi.mode === 'client' ? (clientName() || T('payer_client_ph')) : null }),
        { req: pi.mode === 'required', hint: T('payer_hint_' + pi.mode) }));
      kids.push(box('payment_channel', T('f_channel'), text('payment_channel', { max: 60, list: 'pay-channels', ltr: true }), { hint: T('channel_hint'),
        after: el('datalist', { id: 'pay-channels' }, CHANNELS.map(function (c) { return el('option', { value: c }); })) }));
      var ref = refField(state.method);
      if (ref) {
        var o = { ltr: true, max: ref === 'receipt_no' ? 100 : ref === 'bank_reference' ? 60 : 30, inputmode: ref === 'sadad_number' ? 'numeric' : null,
          onInput: function (v) { var e = refError(ref, v); setErr(ref, e ? T(e === 'too_long' ? 'too_long' : 'ref_format_' + ref) : null); },
          onBlur: function (v) {
            var n = normRef(ref, v);
            if (n && n !== v && !refError(ref, n)) { state[ref] = n; ctl[ref].value = n; changed(); }
            dupCheck();
          } };
        kids.push(box(ref, T(isWallet(state.method) ? 'f_wallet_ref' : 'f_' + ref), text(ref, o), { req: !isWallet(state.method), hint: T('ref_hint_' + (isWallet(state.method) ? 'wallet' : ref)) }));
      }
      dupBox = el('div', { class: 'pay-dup', 'aria-live': 'polite' });
      kids.push(el('div', { class: 'form-group pay-field is-full' }, dupBox));
      return section(T('sec_funding'), kids);
    }
    function filesSection() {
      var allocOpts = function () { return state.allocations.map(function (a, i) { return { key: a.key, label: T('alloc_n', { n: i + 1 }) + (a.tx && a.tx.ref ? ' · ' + a.tx.ref : '') + (a.claim_no ? ' · ' + a.claim_no : '') }; }); };
      var prev = picker ? picker.files() : [];
      picker = filesPicker(F, api, { shared: state.pattern === 'shared', allocations: allocOpts, onChange: function () { setErr('_files', null); } });
      prev.forEach(function (f) {
        var keep = f.alloc && state.allocations.some(function (a) { return a.key === f.alloc; }) ? f.alloc : '';
        picker.add([f.file], f.role, keep);
      });
      var err = el('span', { class: 'form-error', hidden: true, role: 'alert' });
      errs._files = err;
      return el('section', { class: 'pay-sec pay-sec-files' }, [el('h3', { class: 'pay-sec-title', text: T('sec_files') }),
        el('p', { class: 'form-hint', text: T('files_hint') }), picker.node, err,
        el('p', { class: 'form-hint text-xs', text: T('files_not_in_draft') })]);
    }
    function carriedDocs() {
      var docs = (old && old.documents || []).filter(function (x) { return !x.removed_at || x.remove_reason === 'corrected'; });
      if (!docs.length) return el('p', { class: 'form-hint is-full', text: T('carried_none') });
      return el('div', { class: 'form-group pay-field is-full' }, [el('span', { class: 'form-label', text: T('carried_docs') }),
        el('ul', { class: 'pay-docs' }, docs.map(function (x) {
          var c = el('input', { type: 'checkbox', checked: state.remove_document_ids.indexOf(x.id) !== -1, 'data-carried': x.id });
          c.addEventListener('change', function () {
            var i = state.remove_document_ids.indexOf(x.id);
            if (c.checked && i === -1) state.remove_document_ids.push(x.id);
            if (!c.checked && i !== -1) state.remove_document_ids.splice(i, 1);
            changed();
          });
          return el('li', { class: 'pay-doc' }, [el('span', { class: 'badge badge-blue', text: L('role', x.role) }), el('bdi', { class: 'pay-doc-name', text: x.original_name || '' }),
            el('label', { class: 'check ops-check' }, [c, el('span', { text: T('carried_remove') })])]);
        }))]);
    }

    /* ---- Claude reading (≤ 6 documents, one per call; only empty fields are filled) ---- */
    function aiSection() {
      var PA = window.MarsaPayAi, M = U.call && api.MarsaApi;
      if (!PA || !M || typeof M.aiExtract !== 'function') return el('div', { hidden: true });
      var inp = el('input', { type: 'file', class: 'form-control', accept: AI_ACCEPT, multiple: true, 'aria-label': T('ai_pick'), 'data-ai': 'pick' });
      var listEl = el('ul', { class: 'pay-files' });
      var res = el('div', { class: 'pay-ai-result', 'aria-live': 'polite' });
      var err = el('p', { class: 'form-error', role: 'alert', hidden: true });
      var readB = U.btn(T('ai_read'), 'btn-primary', readAll, { 'data-act': 'ai-read' });
      function drawList() {
        U.clear(listEl);
        aiDocs.forEach(function (d, i) {
          var role = el('select', { class: 'form-control is-sm', 'aria-label': T('ai_doc_kind'), 'data-ai-kind': String(i) },
            [['entity_invoice', T('ai_kind_invoice')], ['payment_proof', T('ai_kind_proof')]].map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
          role.value = d.role;
          role.addEventListener('change', function () { d.role = role.value; });
          var rm = U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { aiDocs.splice(i, 1); drawList(); }, { 'aria-label': T('doc_unpick'), title: T('doc_unpick') });
          listEl.appendChild(el('li', { class: 'pay-file' }, [el('bdi', { class: 'pay-file-name', text: d.file.name || '' }), el('span', { class: 'text-xs text-muted', text: fmtSize(d.file.size) }),
            role, d.status ? el('span', { class: 'badge badge-' + (d.status === 'done' ? 'success' : d.status === 'error' ? 'danger' : 'blue'), text: T('ai_st_' + d.status) }) : null,
            d.error ? el('span', { class: 'text-xs fin-text-danger', text: d.error }) : null, rm]));
        });
        var chk = PA.checkFiles(aiDocs.map(function (d) { return { size: d.file.size, type: d.file.type }; }));
        if (!chk.ok) { err.textContent = T('ai_files_' + chk.field); err.hidden = false; } else err.hidden = true;
        readB.disabled = !aiDocs.length || !chk.ok || aiDocs.some(function (d) { return d.status === 'reading'; });
      }
      inp.addEventListener('change', function () {
        Array.prototype.slice.call(inp.files || []).forEach(function (f) {
          aiDocs.push({ file: f, role: aiDocs.some(function (x) { return x.role === 'entity_invoice'; }) ? 'payment_proof' : 'entity_invoice', status: '', error: '' });
        });
        try { inp.value = ''; } catch (e) { /* old browsers */ }
        drawList();
      });
      function readAll() {
        var chk = PA.checkFiles(aiDocs.map(function (d) { return { size: d.file.size, type: d.file.type }; }));
        if (!chk.ok || !aiDocs.length) return;
        var readings = [], i = 0;
        readB.disabled = true;
        U.clear(res);
        function next() {
          if (i >= aiDocs.length) return finish();
          var d = aiDocs[i++];
          if (d.status === 'done' && d.reading) { readings.push(d.reading); return next(); }
          d.status = 'reading'; d.error = ''; drawList();
          return b64(d.file).then(function (data) {
            return U.call(api, 'aiExtract', { docType: d.role === 'payment_proof' ? 'payment_proof' : 'appointment_invoice', promptVersion: 'ai-doc-v3',
              file: { media_type: d.file.type, data_b64: data }, transactionId: state.tx && state.tx.id ? state.tx.id : undefined, lang: lang() });
          }, function () { return { data: null, error: { code: 'MRS_AI_UNSUPPORTED', message: T('ai_read_file_failed') } }; }).then(function (r) {
            if (!sc.alive()) return null;
            if (r.error) { d.status = 'error'; d.error = errText(U, api, r.error); }
            else { d.status = 'done'; d.reading = r.data; readings.push(r.data); }
            drawList();
            return next();
          });
        }
        function finish() {
          drawList();
          if (!readings.length) return null;
          aiResult = PA.merge(readings);
          var ap = applySuggestion(state, aiResult.suggestion, { serviceCode: itemCode(state.service_item_id), beneficiaryName: partyName(state.beneficiary_party_id) });
          var filled = ap.filled.slice(), notes = [];
          state = ap.state;
          if (ap.service_code && !state.service_item_id) {
            var it = items.filter(function (x) { return x.code === ap.service_code; })[0];
            if (it) state.service_item_id = it.id; else filled.splice(filled.indexOf('service_code'), 1);
          } else if (filled.indexOf('service_code') !== -1) filled.splice(filled.indexOf('service_code'), 1);
          if (ap.beneficiary_name && !state.beneficiary_party_id && state.movement_type !== 'received_from_client') {
            var p = partyByName(parties, ap.beneficiary_name);
            if (p) state.beneficiary_party_id = p.id;
            else { filled.splice(filled.indexOf('beneficiary_name'), 1); notes.push(T('ai_benef_pick', { name: ap.beneficiary_name })); }
          } else if (filled.indexOf('beneficiary_name') !== -1) filled.splice(filled.indexOf('beneficiary_name'), 1);
          // the read files become typed attachments of the payment (still subject to the limits; nothing is uploaded yet)
          aiDocs.forEach(function (d) { if (d.status === 'done' && picker && !picker.has(d.file)) picker.add([d.file], d.role); });
          var afterMatch = function (match) {
            if (!sc.alive()) return;
            changed(); draw();
            showResult(filled, ap.skipped, notes, match);
          };
          var h = aiResult.hints || {};
          if (state.pattern === 'single' && !state.tx && (h.bl_number || h.declaration_number || (h.container_numbers || []).length || h.appointment_no)) {
            return U.call(api, 'matchPaymentTransaction', api.orgId, h).then(function (m) {
              var d = m.error ? null : m.data;
              if (d && d.unique_transaction_id && !state.tx) {
                var c = (d.candidates || []).filter(function (x) { return x.transaction_id === d.unique_transaction_id; })[0];
                if (c) { state.tx = txOf(c); state.tx_suggested = true; }
              }
              afterMatch(d);
            });
          }
          afterMatch(null);
          return null;
        }
        return next();
      }
      drawList();
      return el('section', { class: 'pay-sec pay-sec-ai' }, [el('h3', { class: 'pay-sec-title', text: T('ai_title') }),
        el('p', { class: 'form-hint', text: T('ai_hint') }), inp, listEl, err, el('div', { class: 'pay-actions' }, readB), res]);
    }
    function showResult(filled, skipped, notes, match) {
      var res = host.querySelector('.pay-ai-result');
      if (!res || !aiResult) return;
      U.clear(res);
      var lg = lang();
      (aiResult.warnings || []).forEach(function (w) { res.appendChild(U.alertBox('warning', lg === 'en' ? w.text_en : w.text_ar)); });
      res.appendChild(U.alertBox(filled.length ? 'success' : 'info', filled.length ? T('ai_filled', { list: filled.map(function (k) { return T('f_' + k); }).join('، ') }) : T('ai_nothing_filled')));
      if (skipped.length) res.appendChild(U.alertBox('warning', T('ai_skipped', { list: skipped.map(function (k) { return T('f_' + k); }).join('، ') })));
      notes.forEach(function (n) { res.appendChild(U.alertBox('info', n)); });
      if (aiResult.allocations_suggested && aiResult.allocations_suggested.length >= 2) {
        var sa = aiResult.allocations_suggested;
        var b = U.btn(T('ai_use_allocs', { n: sa.length }), 'btn-secondary', function () {
          var list = [];
          sa.forEach(function (x) { var a = emptyAlloc(list); a.claim_no = x.claim_no || ''; a.internal_invoice_no = x.internal_invoice_no || ''; a.amount = x.amount != null ? amountStr(x.amount) : '';
            if (x.invoice_date && DATE_RE.test(String(x.invoice_date))) a.invoice_date = String(x.invoice_date);
            if (x.invoice_vat_amount != null && moneyOkZero(x.invoice_vat_amount)) a.invoice_vat_amount = amountStr(x.invoice_vat_amount);
            if (state.tx) a.tx = state.tx; list.push(a); });
          if (state.pattern === 'shared') {
            // only empty rows are filled; existing rows stay as typed
            var empty = state.allocations.every(function (a) { return !nn(a.amount) && !nn(a.claim_no) && !a.tx; });
            if (!empty) { U.toast(api, T('ai_allocs_kept'), 'warning'); return; }
          }
          state.pattern = 'shared'; state.allocations = list; changed(); draw();
        }, { 'data-act': 'ai-allocs' });
        res.appendChild(el('div', { class: 'alert alert-info', role: 'status' }, [el('div', { class: 'ops-alert-text', text: T('ai_allocs_text', { n: sa.length }) }), b]));
      }
      if (match && state.tx_suggested) res.appendChild(U.alertBox('info', T('ai_tx_unique', { ref: state.tx.ref || '' })));
      else if (match && (match.candidates || []).length > 1 && state.pattern === 'single' && !state.tx) {
        res.appendChild(el('div', { class: 'alert alert-info', role: 'status' }, [el('div', { class: 'ops-alert-text', text: T('ai_tx_many', { n: match.candidates.length }) }),
          el('div', { class: 'pay-actions' }, match.candidates.slice(0, 6).map(function (c) {
            return U.btn([el('bdi', { dir: 'ltr', text: c.ref || '' }), c.client_name ? ' · ' + c.client_name : ''], 'btn-secondary', function () { state.tx = txOf(c); state.tx_suggested = false; changed(); draw(); });
          }))]));
      }
      res.appendChild(el('p', { class: 'form-hint', text: T('ai_never_saves') }));
    }
    function b64(file) {
      return new Promise(function (resolve, reject) {
        try {
          var fr = new FileReader();
          fr.onload = function () { var s = String(fr.result || ''), i = s.indexOf(','); resolve(i === -1 ? s : s.slice(i + 1)); };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsDataURL(file);
        } catch (e) { reject(e); }
      });
    }

    /* ---- save ---- */
    function showErrors(bad, files) {
      var names = Object.keys(bad), unplaced = [];
      var fc = filesCheck(files || []);
      names.forEach(function (k) {
        var msg = T(bad[k], { name: fc && fc.name ? fc.name : '' });
        if (!setErr(k, msg)) unplaced.push(msg);
      });
      U.clear(formErr);
      if (names.length) formErr.appendChild(U.alertBox('danger', names.length > 1 ? T('form_errors', { n: names.length }) : (unplaced[0] || T(bad[names[0]]))));
      unplaced.forEach(function (m, i) { if (names.length > 1 || i) formErr.appendChild(U.alertBox('danger', m)); });
      var first = ctl[names[0]];
      if (first && first.focus) { try { first.focus(); } catch (e) { /* ignore */ } }
    }
    function clearErrors() { Object.keys(errs).forEach(function (k) { setErr(k, null); }); if (formErr) U.clear(formErr); }
    function save() {
      if (busy) return;
      clearErrors();
      var files = picker ? picker.files() : [];
      var carriedProof = !!(old && (old.documents || []).some(function (x) { return x.role === 'payment_proof' && (!x.removed_at || x.remove_reason === 'corrected') && state.remove_document_ids.indexOf(x.id) === -1; }));
      var bad = validate(state, files, { today: riyadhToday(), correct: !!correctId, carriedProof: carriedProof, serviceCode: itemCode(state.service_item_id) });
      if (Object.keys(bad).length) { showErrors(bad, files); return; }
      busy = true; saveB.disabled = true; saveB.textContent = T('saving');
      uploadAll(F, api, files, branchId()).then(function (u) {
        if (u.error) return done({ data: null, error: u.error });
        var payload = buildPayload(state, u.docs.map(function (x) {
          var y = { finance_document_id: x.finance_document_id, role: x.role };
          if (state.pattern === 'shared' && x.allocation) y.allocation = x.allocation;
          return y;
        }));
        var sk = 'pay-save-' + (correctId || scope), key = U.idemKey(api, sk, payload);
        var p = correctId ? U.call(api, 'correctPayment', correctId, payload, str(state.reason), { idemKey: key }) : U.call(api, 'recordPaymentBundle', payload, { idemKey: key });
        return p.then(function (r) { U.idemSettle(sk, r.error); return done(r); });
      });
    }
    function done(r) {
      busy = false;
      if (!sc.alive()) return null;
      saveB.disabled = false; saveB.textContent = correctId ? T('save_correct') : T('save');
      if (!r.error) {
        if (saver) saver.cancel();
        if (D) D.clear(scope, uid);
        var d = r.data || {}, pid = correctId ? (d.payment && d.payment.id) : d.id;
        U.toast(api, correctId ? T('corrected_ok', { ref: (d.payment && d.payment.ref) || '' }) : d.replayed ? T('saved_replayed', { ref: d.ref || '' }) : T('saved_ok', { ref: d.ref || '' }), 'success');
        U.go(api, pid ? '#payments/' + pid : '#payments');
        return null;
      }
      var c = U.errCode(r.error);
      if (c === 'MRS_CONFIRM_INVOICE_REUSE' && !reuseConfirmed(state)) {
        return U.confirm(api, { title: T('reuse_title'), text: T('reuse_text', { x: r.error.extra || '' }), okText: T('reuse_ok') }).then(function (yes) {
          if (!yes) { setErr('claim_no', errText(U, api, r.error)); U.clear(formErr); formErr.appendChild(U.alertBox('warning', errText(U, api, r.error))); return; }
          // the confirmation covers exactly what is on screen now (issuer + every invoice line); an edit makes it stale
          state.confirm_reuse = true; state.confirm_reuse_sig = reuseSig(state); changed(); save();
        });
      }
      var f = errorField(r.error), msg = errText(U, api, r.error);
      if (c === 'MRS_UNKNOWN_RESULT' || c === 'MRS_IN_PROGRESS') { saveB.textContent = T('retry_safe'); }
      U.clear(formErr);
      formErr.appendChild(U.alertBox(c === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'danger', msg));
      if (f !== '_form') setErr(f, msg);
      return null;
    }

    /* ---- start: catalog + parties (+ the transaction / the corrected payment), then a restored draft ---- */
    function start(fresh) {
      var dr = !fresh && D ? D.load(scope, uid) : null;
      U.loadingInto(host);
      return Promise.all([
        U.call(api, 'listServiceItems', { orgId: api.orgId }),
        U.call(api, 'listParties', { limit: 500 }),
        correctId ? U.call(api, 'getPayment', correctId) : null,
        presetTx && !correctId ? U.call(api, 'getTransaction', presetTx) : null
      ]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(host);
        if (res[0].error) { host.appendChild(U.errorState(api, res[0].error, function () { start(fresh); })); return; }
        items = U.rowsOf(res[0].data).filter(function (x) { return x && x.is_active !== false; });
        parties = res[1].error ? [] : U.rowsOf(res[1].data);
        state = emptyState(today);
        if (correctId) {
          if (res[2].error) { host.appendChild(U.errorState(api, res[2].error, function () { start(fresh); })); return; }
          old = res[2].data || {};
          if (old.status !== 'recorded' || old.corrected_by) { host.appendChild(U.alertBox('warning', T('correct_not_allowed'))); return; }
          state = stateFromPayment(old, today);
        } else if (presetTx && res[3] && !res[3].error && res[3].data) {
          state.tx = txOf(res[3].data);
        }
        restored = null;
        if (dr && dr.data && dr.data.state && typeof dr.data.state === 'object') {
          var keepTx = state.tx;
          state = Object.assign(emptyState(today), dr.data.state);
          if (!Array.isArray(state.allocations)) state.allocations = [];
          if (!Array.isArray(state.remove_document_ids)) state.remove_document_ids = [];
          state.confirm_reuse = false; state.confirm_reuse_sig = '';
          if (presetTx && !state.tx && keepTx) state.tx = keepTx;
          restored = dr.savedAt;
        }
        draw();
      });
    }
    return start(false);
  }

  /* ==================================================================
     Registration
     ================================================================== */
  Ops.finPay = { pure: PURE, renderList: renderList, renderDetail: renderDetail, renderForm: renderForm, T: T, L: L };
  Ops.views.payments = {
    allow: 'finRead', titleKey: 'pay.nav_payments', icon: 'wallet',
    render: function (root, api, param) {
      var F = Ops.finKit && Ops.finKit();
      if (!F) return noKit(root);
      var q = {};
      try { q = typeof api.hashQuery === 'function' ? api.hashQuery() || {} : {}; } catch (e) { q = {}; }
      if (param === 'new') return renderForm(root, api, F, q);
      if (param && UUID_RE.test(param)) return renderDetail(root, api, F, param);
      return renderList(root, api, F, q);
    }
  };
})();

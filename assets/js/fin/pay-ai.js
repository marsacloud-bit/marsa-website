/*
  Marsa (مرسى) — the payment form's AI helper (legacy port step 6, migration 20261122000100_legacy_pay.sql; legacy
  PaymentDocumentAI.js paymentDocAiV2NormalizeProofParties_ / paymentDocAiV2ComparisonWarnings_, Payments.js
  paymentAiAddComparisonWarnings_, Index.html applyPaymentAiResult). Pure functions, ES5, no DOM, no network.
  The page reads up to 6 payment documents with MarsaSupa.aiExtract({docType: 'appointment_invoice' | 'payment_proof',
  promptVersion: 'ai-doc-v3', ...}) — ONE document per call, ≤ 4 MB each, ≤ 12 MB together — then:
    var m = MarsaPayAi.merge(readings);        // the readings (ai-extract bodies) → invoices, proofs, warnings, suggestion, hints
    var r = MarsaPayAi.fillEmpty(form, m.suggestion);   // ONLY the empty form fields are filled → {form, filled}
  Nothing is saved or approved here: a staff member reviews the form and saves it (record_payment_bundle); the
  transaction is pre-selected only when match_payment_transaction returns unique_transaction_id (never saved by itself).
  Payment channels (Fasah, Tabadul, SADAD, mada, Visa, Mastercard, Apple Pay, STC Pay, urpay) never become the beneficiary:
  the beneficiary is the invoice issuer.
*/
(function (root) {
  'use strict';

  var MAX_DOCS = 6;
  var MAX_BYTES = 4 * 1024 * 1024;
  var MAX_TOTAL_BYTES = 12 * 1024 * 1024;
  // what the reading AND the attachments both accept (a read file becomes an attachment): no GIF (refused as an attachment),
  // no HEIC (the model does not read it; it can still be attached)
  var MEDIA = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  // the form fields a reading may fill (record_payment_bundle payload keys); never review / status / pattern / movement
  var FILLABLE = ['claim_no', 'internal_invoice_no', 'appointment_no', 'service_code', 'expected_amount', 'paid_amount', 'paid_at',
    'invoice_date', 'invoice_vat_amount', 'method', 'sadad_number', 'bank_reference', 'receipt_no', 'payer_name', 'payment_channel',
    'beneficiary_name'];
  var REF_OF = { sadad: 'sadad_number', bank_transfer: 'bank_reference', mada: 'receipt_no', cash: 'receipt_no', cheque: 'receipt_no', other: 'receipt_no' };
  var TEXT = {
    issuers_differ: ['توجد فواتير تبدو صادرة من جهات مختلفة؛ السداد المشترك يجب أن يكون لجهة واحدة فقط.',
      'The invoices seem to come from different issuers; a shared payment is for one issuer only.'],
    beneficiary_issuer_mismatch: ['اسم المستفيد في إثبات السداد لا يطابق بوضوح اسم جهة الفاتورة؛ راجع المستندين.',
      'The beneficiary on the payment proof does not clearly match the invoice issuer; review both documents.'],
    amount_mismatch: ['إجمالي الفاتورة / الفواتير المقروءة يختلف عن مبلغ إثبات السداد؛ راجع المبلغين قبل الحفظ.',
      'The invoice total(s) read differ from the payment proof amount; review both amounts before saving.'],
    beneficiary_from_issuer: ['الجهة المستفيدة مأخوذة من جهة الفاتورة (قناة الدفع لا تكون مستفيدًا).',
      'The beneficiary is taken from the invoice issuer (a payment channel is never the beneficiary).'],
    too_many: ['يمكن قراءة 6 مستندات سداد كحد أقصى في العملية الواحدة.', 'At most 6 payment documents can be read at once.'],
    proofs_differ: ['إثباتات السداد المقروءة تذكر مبالغ مختلفة؛ اعتُمد مبلغ الإثبات الأول. السداد الواحد له إثبات مبلغ واحد، فراجع المستندات.',
      'The payment proofs read show different amounts; the first proof\'s amount was used. One payment has one amount, so review the documents.']
  };

  function str(v) { return v == null ? '' : String(v).replace(/^\s+|\s+$/g, ''); }
  function isEmpty(v) { return v == null || str(v) === ''; }
  function round2(n) { return Math.round((n + 1e-9) * 100) / 100; }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(str(v)); return isFinite(n) ? n : null; }
  // legacy paymentDocAiV2PartyKey_ / paymentDocAiV2RoughPartyMatch_ (an empty side matches)
  function partyKey(v) {
    return str(v).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^a-z0-9؀-ۿ]+/g, '');
  }
  function roughMatch(a, b) {
    var l = partyKey(a), r = partyKey(b);
    if (!l || !r) return true;
    return l === r || l.indexOf(r) !== -1 || r.indexOf(l) !== -1;
  }
  var CHANNELS = ['fasah', 'فسح', 'fasahpay', 'فسحباي', 'tabadul', 'تبادل', 'sadad', 'سداد', 'سدادللمدفوعات', 'mada', 'مدي', 'مدى',
    'visa', 'فيزا', 'mastercard', 'ماستركارد', 'applepay', 'stcpay', 'urpay'];
  function isChannel(v) {
    var k = partyKey(v);
    if (!k) return false;
    for (var i = 0; i < CHANNELS.length; i++) if (partyKey(CHANNELS[i]) === k) return true;
    return /^(fasah|tabadul|sadad|mada|visa|mastercard|applepay|stcpay|urpay)/.test(k) || /^(فسح|تبادل|سداد|مدى|مدي|فيزا|ماستركارد)/.test(k);
  }
  function warn(list, code) { for (var i = 0; i < list.length; i++) if (list[i].code === code) return; list.push({ code: code, text_ar: TEXT[code][0], text_en: TEXT[code][1] }); }

  // files = [{size, type}] → {ok: true} | {ok: false, code: 'MRS_PAY_DOCUMENT', field: count|size|total|type, index}
  function checkFiles(files) {
    var list = files || [], total = 0;
    if (list.length > MAX_DOCS) return { ok: false, code: 'MRS_PAY_DOCUMENT', field: 'count', index: MAX_DOCS };
    for (var i = 0; i < list.length; i++) {
      var f = list[i] || {};
      if (MEDIA.indexOf(String(f.type || '').toLowerCase()) === -1) return { ok: false, code: 'MRS_PAY_DOCUMENT', field: 'type', index: i };
      if (!(f.size > 0) || f.size > MAX_BYTES) return { ok: false, code: 'MRS_PAY_DOCUMENT', field: 'size', index: i };
      total += f.size;
      if (total > MAX_TOTAL_BYTES) return { ok: false, code: 'MRS_PAY_DOCUMENT', field: 'total', index: i };
    }
    return { ok: true };
  }

  // readings = the ai-extract bodies of one payment form (doc_type appointment_invoice / payment_proof, body.payment)
  // → { invoices [payment], proofs [payment], warnings [{code, text_ar, text_en}], suggestion {form key: value},
  //     allocations_suggested [{claim_no, internal_invoice_no, amount, appointment_no, invoice_date, invoice_vat_amount}] (≥ 2 invoices: shared),
  //     hints {bl_number, declaration_number, container_numbers, appointment_no} (for match_payment_transaction), error? }
  function merge(readings) {
    var list = readings || [];
    var out = { invoices: [], proofs: [], warnings: [], suggestion: {}, allocations_suggested: [], hints: {} };
    if (list.length > MAX_DOCS) { out.error = { code: 'MRS_PAY_DOCUMENT', field: 'count' }; warn(out.warnings, 'too_many'); list = list.slice(0, MAX_DOCS); }
    for (var i = 0; i < list.length; i++) {
      var p = list[i] && list[i].payment;
      if (!p || typeof p !== 'object') continue;
      if (p.kind === 'invoice') out.invoices.push(p); else if (p.kind === 'proof') out.proofs.push(p);
    }
    var inv = out.invoices, pr = out.proofs, s = out.suggestion;
    // issuers (legacy: a shared payment is for ONE issuer)
    var issuers = [];
    for (i = 0; i < inv.length; i++) if (str(inv[i].issuer_name)) issuers.push(str(inv[i].issuer_name));
    for (i = 1; i < issuers.length; i++) if (!roughMatch(issuers[i], issuers[0])) { warn(out.warnings, 'issuers_differ'); break; }
    var issuer = issuers[0] || '';
    // the beneficiary is the issuer; a proof's beneficiary only when no invoice names one (and never a channel)
    var benef = issuer;
    for (i = 0; i < pr.length; i++) {
      var b = str(pr[i].beneficiary_name);
      if (b && !isChannel(b) && issuer && !roughMatch(issuer, b)) warn(out.warnings, 'beneficiary_issuer_mismatch');
      if (!benef && b && !isChannel(b)) benef = b;
    }
    if (issuer && pr.some(function (x) { return x.payment_channel && !x.beneficiary_name; })) warn(out.warnings, 'beneficiary_from_issuer');
    if (benef) s.beneficiary_name = benef;
    // amounts: Σ invoice totals vs the paid amount. A register entry is ONE payment: several proofs (an SMS screenshot and
    // the bank PDF …) are the same money, so the first proof with an amount decides (legacy applyPaymentAiResult proofs[0]);
    // another proof with a different amount is reported, never added
    var invTotal = 0, invHas = false, paid = 0, paidHas = false;
    for (i = 0; i < inv.length; i++) if (num(inv[i].total) !== null) { invTotal += num(inv[i].total); invHas = true; }
    for (i = 0; i < pr.length; i++) {
      if (num(pr[i].amount) === null) continue;
      if (!paidHas) { paid = num(pr[i].amount); paidHas = true; }
      else if (Math.abs(round2(num(pr[i].amount)) - round2(paid)) >= 0.005) warn(out.warnings, 'proofs_differ');
    }
    invTotal = round2(invTotal); paid = round2(paid);
    if (invHas && paidHas && Math.abs(invTotal - paid) >= 0.005) warn(out.warnings, 'amount_mismatch');
    if (invHas) s.expected_amount = invTotal;
    if (paidHas) s.paid_amount = paid; else if (invHas) s.paid_amount = invTotal;
    // the invoice fields (one invoice: single; several: suggested allocations, no top-level claim)
    if (inv.length === 1) {
      var v = inv[0];
      if (v.invoice_no) s.claim_no = v.invoice_no;
      if (v.internal_invoice_no) s.internal_invoice_no = v.internal_invoice_no;
      if (v.invoice_date) s.invoice_date = v.invoice_date;
      if (num(v.vat_amount) !== null) s.invoice_vat_amount = num(v.vat_amount);
    } else if (inv.length > 1) {
      for (i = 0; i < inv.length; i++) {
        out.allocations_suggested.push({ claim_no: inv[i].invoice_no || null, internal_invoice_no: inv[i].internal_invoice_no || null,
          amount: num(inv[i].total), appointment_no: inv[i].appointment_no || null, invoice_date: inv[i].invoice_date || null,
          invoice_vat_amount: num(inv[i].vat_amount) });
      }
    }
    var tas = '', svc = '', bl = '', decl = '', ctrs = [];
    for (i = 0; i < inv.length; i++) {
      if (!tas && inv[i].appointment_no) tas = inv[i].appointment_no;
      if (!svc && inv[i].service_code) svc = inv[i].service_code;
      if (!bl && inv[i].bl_number) bl = inv[i].bl_number;
      if (!decl && inv[i].declaration_number) decl = inv[i].declaration_number;
      (inv[i].container_numbers || []).forEach(function (c) { if (ctrs.indexOf(c) === -1) ctrs.push(c); });
    }
    if (tas && inv.length === 1) s.appointment_no = tas;
    if (svc) s.service_code = svc;
    // the proof fields (the first proof decides the method and its reference)
    if (pr.length) {
      var q = pr[0];
      if (q.paid_at) s.paid_at = q.paid_at;
      if (q.method) s.method = q.method;
      if (q.payer_name) s.payer_name = q.payer_name;
      if (q.payment_channel) s.payment_channel = q.payment_channel;
      var refKey = q.method ? REF_OF[q.method] : null;
      ['sadad_number', 'bank_reference', 'receipt_no'].forEach(function (k) { if (q[k] && (!refKey || refKey === k)) s[k] = q[k]; });
    } else if (inv.length === 1 && inv[0].invoice_date) {
      s.paid_at = inv[0].invoice_date;
    }
    out.hints = { bl_number: bl || null, declaration_number: decl || null, container_numbers: ctrs, appointment_no: tas || null };
    return out;
  }

  // only the EMPTY fields of the form are filled (legacy applyPaymentAiResult) → {form (a copy), filled [keys]}
  function fillEmpty(form, suggestion) {
    var f = {}, k, filled = [];
    for (k in (form || {})) if (Object.prototype.hasOwnProperty.call(form, k)) f[k] = form[k];
    var s = suggestion || {};
    for (var i = 0; i < FILLABLE.length; i++) {
      k = FILLABLE[i];
      if (!Object.prototype.hasOwnProperty.call(s, k) || isEmpty(s[k])) continue;
      if (!isEmpty(f[k])) continue;
      f[k] = s[k];
      filled.push(k);
    }
    return { form: f, filled: filled };
  }

  var API = { MAX_DOCS: MAX_DOCS, MAX_BYTES: MAX_BYTES, MAX_TOTAL_BYTES: MAX_TOTAL_BYTES, FILLABLE: FILLABLE, checkFiles: checkFiles,
    merge: merge, fillEmpty: fillEmpty, isChannel: isChannel, roughMatch: roughMatch };
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.MarsaPayAi = API;
})(typeof window !== 'undefined' ? window : null);

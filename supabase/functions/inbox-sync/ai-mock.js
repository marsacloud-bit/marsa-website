/*
  Marsa (مرسى) — G6b "AI" provider: deterministic RULE-BASED mock (docs/online/G6B_SPEC.md §13–§17, §22, §24).
  STAGING / TESTS ONLY. No LLM, no network, no tool, no RPC access, no key. Plain classic script (no import / export,
  no require). Pure and deterministic: the same input gives the same output; the only clock is the injected one.

  createRuleProvider({clock}) → provider {name:'rule_mock', version, extract, classify, summarize, draftReply, detectInjection}
    extract(text, {source, attachment_id})       → [{kind, raw, normalized, valid, confidence, detail, span:{source, attachment_id?, start, end}}]
                                                  (offsets in Unicode CODE POINTS of the original text)
    classify({subject, body, extractions})       → {category, confidence, rules:[{rule, lang, keyword}]}
    summarize({category, extractions, sender, flags, lang, topic_rules}) → {summary_ar, summary_en, action_code, suggested_role, deadline, risks}
    draftReply(draftCtx)                         → {lang, subject, body_text, clarification, missing, used_facts, template_key, template_version, template_status}
    detectInjection(text, {participants, directory}) → {flags, hits:[{rule}]}   (flags only — never changes any other output)

  Message and attachment text is DATA: nothing here interprets it as an instruction. The injection detector only adds
  risk flags; extraction / classification / summary / draft use exactly the same rules with or without such text, and
  drafts never quote the inbound text (template + confirmed facts only).
*/
(function () {
  'use strict';

  const PROVIDER_VERSION = 'rule-mock-1.0.0';
  const MAX_EXTRACTIONS = 100;
  const DEFAULT_CLOCK_ISO = '2026-11-02T09:00:00.000Z';

  /* ------------------------------------------------------------------ text folding */
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const SPACES = '       ';
  // one code point → exactly one UTF-16 unit, so folded string index === code-point index of the original
  function foldCp(ch) {
    const a = AR_DIGITS.indexOf(ch); if (a >= 0) return String(a);
    const p = FA_DIGITS.indexOf(ch); if (p >= 0) return String(p);
    if (SPACES.indexOf(ch) >= 0) return ' ';
    if (ch.length > 1) return '�';                     // astral (emoji…): placeholder of length 1
    const u = ch.toUpperCase();
    return u.length === 1 ? u : ch;
  }
  function foldForMatch(text) {
    const cps = Array.from(String(text === null || text === undefined ? '' : text));
    return { cps, f: cps.map(foldCp).join('') };
  }
  // digits only (exported helper; same length per code point)
  function foldDigits(text) {
    return Array.from(String(text === null || text === undefined ? '' : text)).map(ch => {
      const a = AR_DIGITS.indexOf(ch); if (a >= 0) return String(a);
      const p = FA_DIGITS.indexOf(ch); if (p >= 0) return String(p);
      return ch;
    }).join('');
  }
  // keyword normalisation (classification / injection only — no spans needed)
  function normKw(s) {
    return foldDigits(String(s || ''))
      .replace(/[   ]/g, ' ')
      .replace(/[ً-ْـٰ]/g, '')            // tashkeel, tatweel
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .toLowerCase();
  }
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const isLatin = s => /^[\x20-\x7e]+$/.test(s);

  /* ------------------------------------------------------------------ ISO 6346 */
  const LETTER_VALUES = (() => {
    const v = {}; let n = 10;
    for (let c = 65; c <= 90; c++) { if (n % 11 === 0) n++; v[String.fromCharCode(c)] = n; n++; }
    return v;
  })();
  // check digit of the first 10 chars (owner code 4 letters + 6 digits), or null when malformed
  function iso6346CheckDigit(s) {
    const t = String(s || '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z]{3}[UJZ]\d{6}/.test(t)) return null;
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const ch = t[i];
      const x = /\d/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
      sum += x * Math.pow(2, i);
    }
    const r = sum % 11;
    return r === 10 ? 0 : r;
  }
  function iso6346Valid(s) {
    const t = String(s || '').toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(t)) return false;
    return iso6346CheckDigit(t) === Number(t[10]);
  }

  /* ------------------------------------------------------------------ extraction patterns (on the folded, upper-cased text) */
  const KW_NO = '[ \\t]*(?:NO\\.?|NUMBER|#|:|رقم)?[ \\t]*[:#.]?[ \\t]*';
  const RE = {
    container: /(?<![A-Z0-9])([A-Z]{3}[UJZ])[ \t-]?(\d{6})[ \t-]?(\d)(?![A-Z0-9])/g,
    bl_kw: new RegExp('(?:(?<![A-Z])B\\/L|(?<![A-Z])BL(?![A-Z])|BILL OF LADING|رقم البوليصة|بوليصة الشحن|بوليصة)' + KW_NO + '([A-Z0-9][A-Z0-9-]{5,19})(?![A-Z0-9-])', 'g'),
    bl_prefix: /(?<![A-Z0-9])((?:MEDU|MSCU|MAEU|COSU|HLCU|ONEY|EGLV|CMDU|OOLU|ZIMU|YMLU)[A-Z0-9]{6,12})(?![A-Z0-9])/g,
    declaration: new RegExp('(?:البيان الجمركي|رقم البيان|بيان|CUSTOMS DECL\\.?|DECLARATION)' + KW_NO + '(\\d{6,12})(?!\\d)', 'g'),
    invoice: /(?:فاتورة رقم|رقم الفاتورة|INVOICE[ \t]*(?:NO\.?|NUMBER|#))[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9/-]{2,29})(?![A-Z0-9/-])/g,
    tx_ref: /(?<![A-Z0-9])(MRS-\d{4}-\d{6})(?!\d)/g,
    appointment: /(?:رقم الموعد|APPOINTMENT[ \t]*(?:NO\.?|#|REF\.?))[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9-]{3,39})(?![A-Z0-9-])/g,
    date_ymd: /(?<![\d/.-])(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?![\d/-])/g,
    date_dmy: /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d/.-]?\d)/g
  };
  const MONTHS = [
    ['JANUARY', 1], ['FEBRUARY', 2], ['MARCH', 3], ['APRIL', 4], ['MAY', 5], ['JUNE', 6], ['JULY', 7], ['AUGUST', 8],
    ['SEPTEMBER', 9], ['OCTOBER', 10], ['NOVEMBER', 11], ['DECEMBER', 12],
    ['يناير', 1], ['فبراير', 2], ['مارس', 3], ['أبريل', 4], ['ابريل', 4], ['إبريل', 4], ['مايو', 5], ['يونيو', 6], ['يوليو', 7],
    ['أغسطس', 8], ['اغسطس', 8], ['سبتمبر', 9], ['أكتوبر', 10], ['اكتوبر', 10], ['نوفمبر', 11], ['ديسمبر', 12],
    ['كانون الثاني', 1], ['شباط', 2], ['آذار', 3], ['نيسان', 4], ['أيار', 5], ['حزيران', 6], ['تموز', 7], ['آب', 8],
    ['أيلول', 9], ['تشرين الأول', 10], ['تشرين الثاني', 11], ['كانون الأول', 12]
  ];
  const MONTH_MAP = new Map(MONTHS);
  const MONTH_ALT = MONTHS.map(m => m[0]).sort((a, b) => b.length - a.length).map(escRe).join('|');
  const RE_DATE_TEXT = new RegExp('(?<!\\d)(\\d{1,2})[ \\t]+(' + MONTH_ALT + ')(?![A-Z\\u0621-\\u064a])[ \\t]*,?[ \\t]*(\\d{4})(?!\\d)', 'g');
  // review fix: a date introduced by an appointment phrase («confirmed for», «slot», «موعد … يوم», «بتاريخ») is the appointment date
  const APPT_BEFORE = /(?:CONFIRMED (?:FOR|ON)|SCHEDULED (?:FOR|ON)|BOOKED (?:FOR|ON)|SLOT(?: ON| AT| FOR)?|APPOINTMENT(?: DATE| IS| ON| AT| FOR)?|موعد[^\n]{0,30}?|بتاريخ)[ \t]*(?::|-|IS)?[ \t]*(?:ON|THE|DATE|يوم|تاريخ)?[ \t]*$/;
  const DEADLINE_BEFORE = /(?:BEFORE|(?<![A-Z])BY|NO LATER THAN|DEADLINE|قبل|موعد أقصاه|في موعد لا يتجاوز)[ \t]*[:-]?[ \t]*(?:THE|DATE|تاريخ|يوم)?[ \t]*$/;

  const pad2 = n => String(n).padStart(2, '0');
  function realDate(y, m, d) {
    if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  const hasDigits = (s, n) => (String(s).match(/\d/g) || []).length >= n;

  function extract(text, opts) {
    const o = opts || {};
    const source = ['subject', 'body', 'attachment'].includes(o.source) ? o.source : 'body';
    const { cps, f } = foldForMatch(text);
    const out = [];
    const seen = new Set();
    function push(kind, start, end, normalized, valid, confidence, detail) {
      if (!(start >= 0 && end > start && end <= cps.length)) return;
      const raw = cps.slice(start, end).join('');
      if (Array.from(raw).length > 200 || String(normalized).length > 200) return;
      const key = kind + '|' + normalized + '|' + start + '|' + end;
      if (seen.has(key)) return;
      seen.add(key);
      const span = { source, start, end };
      if (source === 'attachment' && o.attachment_id) span.attachment_id = o.attachment_id;
      out.push({ kind, raw, normalized: String(normalized), valid: !!valid, confidence, detail: detail || {}, span });
    }
    const each = (re, fn) => { re.lastIndex = 0; let m; while ((m = re.exec(f)) !== null) { fn(m); if (m[0].length === 0) re.lastIndex++; } };
    const tail = (m, g) => { const s = m.index + m[0].length - g.length; return [s, s + g.length]; };

    each(RE.container, m => {
      const norm = m[1] + m[2] + m[3];
      const ok = iso6346Valid(norm);
      push('container_no', m.index, m.index + m[0].length, norm, ok, ok ? 0.95 : 0.3, ok ? {} : { check_digit_expected: iso6346CheckDigit(norm) });
    });
    each(RE.bl_kw, m => {
      const tok = m[1];
      if (!hasDigits(tok, 3)) return;
      const [s, e] = tail(m, tok);
      push('bl_number', s, e, tok.replace(/-/g, ''), true, 0.9, { rule: 'keyword' });
    });
    each(RE.bl_prefix, m => {
      const tok = m[1];
      if (tok.length === 11 && iso6346Valid(tok)) return;      // a valid container number is not a B/L
      const [s, e] = tail(m, tok);
      push('bl_number', s, e, tok, true, 0.7, { rule: 'carrier_prefix' });
    });
    each(RE.declaration, m => { const [s, e] = tail(m, m[1]); push('declaration_no', s, e, m[1], true, 0.85, {}); });
    each(RE.invoice, m => {
      if (!hasDigits(m[1], 1)) return;
      const [s, e] = tail(m, m[1]); push('invoice_no', s, e, m[1], true, 0.8, {});
    });
    each(RE.tx_ref, m => push('tx_ref', m.index, m.index + m[0].length, m[1], true, 0.99, {}));
    each(RE.appointment, m => {
      if (!hasDigits(m[1], 1)) return;
      const [s, e] = tail(m, m[1]); push('appointment_no', s, e, m[1], true, 0.8, {});
    });
    const deadlineAt = start => DEADLINE_BEFORE.test(f.slice(Math.max(0, start - 40), start));
    const apptAt = start => APPT_BEFORE.test(f.slice(Math.max(0, start - 50), start));
    each(RE.date_ymd, m => {
      const y = +m[1], mo = +m[2], d = +m[3];
      const ok = realDate(y, mo, d);
      push('date', m.index, m.index + m[0].length, ok ? y + '-' + pad2(mo) + '-' + pad2(d) : m[0], ok, ok ? 0.9 : 0.2,
        { date_format: 'ymd', ambiguous: false, deadline_phrase: deadlineAt(m.index), appointment_phrase: apptAt(m.index) });
    });
    each(RE.date_dmy, m => {
      const d = +m[1], mo = +m[2], y = +m[3];
      const ok = realDate(y, mo, d);
      const amb = d <= 12 && mo <= 12 && d !== mo;
      push('date', m.index, m.index + m[0].length, ok ? y + '-' + pad2(mo) + '-' + pad2(d) : m[0], ok, ok ? (amb ? 0.5 : 0.85) : 0.2,
        { date_format: 'dmy', ambiguous: amb, deadline_phrase: deadlineAt(m.index), appointment_phrase: apptAt(m.index) });
    });
    each(RE_DATE_TEXT, m => {
      const d = +m[1], mo = MONTH_MAP.get(m[2]) || MONTH_MAP.get(m[2].toUpperCase()), y = +m[3];
      const ok = !!mo && realDate(y, mo, d);
      push('date', m.index, m.index + m[0].length, ok ? y + '-' + pad2(mo) + '-' + pad2(d) : m[0], ok, ok ? 0.85 : 0.2,
        { date_format: 'text', ambiguous: false, deadline_phrase: deadlineAt(m.index), appointment_phrase: apptAt(m.index) });
    });
    out.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out.slice(0, MAX_EXTRACTIONS);
  }

  /* ------------------------------------------------------------------ classification (§14) */
  const RULES = Object.freeze({
    telex_release: { en: ['telex release', 'telex', 'surrender'], ar: ['سويفت التلكس', 'تلكس', 'إفراج'], weight: 1 },
    delivery_order: { en: ['delivery order', 'd/o'], ar: ['إذن تسليم', 'اذن استلام'], weight: 1 },
    freight_charges: { en: ['freight', 'charges', 'local charges', 'invoice amount'], ar: ['رسوم الشحن', 'أجور الشحن', 'رسوم محلية'], weight: 1 },
    appointment: { en: ['appointment', 'booking slot', 'fasah appointment'], ar: ['موعد', 'حجز موعد', 'فسح موعد'], weight: 1 },
    missing_documents: { en: ['missing', 'pending documents', 'please send'], ar: ['نواقص', 'مستند ناقص', 'المستندات المطلوبة'], weight: 1 },
    violation: { en: ['violation', 'penalty', 'fine'], ar: ['مخالفة', 'غرامة', 'جزاء'], weight: 1 },
    empty_return: { en: ['empty return', 'return the empty', 'depot'], ar: ['إرجاع الفارغ', 'تسليم الفارغ', 'ساحة الفوارغ'], weight: 1 },
    general_inquiry: { en: ['inquiry', 'question'], ar: ['استفسار'], weight: 1, question_mark: true }
  });
  const CATEGORIES = Object.freeze(['telex_release', 'delivery_order', 'freight_charges', 'appointment', 'missing_documents', 'violation', 'empty_return', 'general_inquiry', 'unknown']);
  const KW_RE = (() => {
    const m = {};
    for (const cat of Object.keys(RULES)) {
      m[cat] = [];
      for (const lang of ['en', 'ar']) {
        for (const kw of RULES[cat][lang]) {
          const n = normKw(kw);
          const re = isLatin(n) ? new RegExp('(?<![a-z0-9])' + escRe(n) + '(?![a-z])') : new RegExp(escRe(n));
          m[cat].push({ kw, lang, re });
        }
      }
    }
    return m;
  })();

  function classify(input) {
    const i = input || {};
    const subj = normKw(i.subject || '');
    const body = normKw(i.body || '');
    const scores = {};
    const rules = [];
    for (const cat of Object.keys(RULES)) {
      let s = 0;
      for (const k of KW_RE[cat]) {
        const inS = k.re.test(subj), inB = k.re.test(body);
        if (inS || inB) { s += RULES[cat].weight * (inS ? 2 : 1); rules.push({ rule: cat, lang: k.lang, keyword: k.kw }); }
      }
      if (RULES[cat].question_mark && /[?؟]/.test(subj + ' ' + body)) { s += RULES[cat].weight; rules.push({ rule: cat, lang: 'any', keyword: '?' }); }
      scores[cat] = s;
    }
    // context: a valid container + "empty" → empty return
    const ex = Array.isArray(i.extractions) ? i.extractions : [];
    if (ex.some(e => e.kind === 'container_no' && e.valid) && /(?<![a-z])empty(?![a-z])|فارغ|فوارغ/.test(subj + ' ' + body)) {
      scores.empty_return += 2; rules.push({ rule: 'empty_return', lang: 'any', keyword: 'container+empty' });
    }
    const ranked = Object.keys(scores).map(c => [c, scores[c]]).sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
    const [top, second] = [ranked[0], ranked[1]];
    let category = 'unknown', confidence;
    if (top[1] >= 2 && top[1] >= 1.5 * second[1]) {
      category = top[0];
      confidence = Math.min(0.95, Math.round((0.45 + 0.1 * top[1]) * 100) / 100);
    } else {
      confidence = Math.min(0.4, Math.round(0.1 * top[1] * 100) / 100);
    }
    return { category, confidence, rules: rules.slice(0, 20) };
  }

  /* ------------------------------------------------------------------ summary / action / role / deadline (§15) */
  const ACTIONS = Object.freeze({
    telex_release: 'send_telex', delivery_order: 'issue_do', freight_charges: 'pay_or_query_charges', appointment: 'book_or_confirm_appointment',
    missing_documents: 'provide_documents', violation: 'respond_violation', empty_return: 'arrange_empty_return', general_inquiry: 'answer_inquiry',
    unknown: 'review_manually'
  });
  const DEFAULT_ROLES = Object.freeze({ freight_charges: 'accountant', appointment: 'transport_staff', empty_return: 'transport_staff' });
  const STAFF_ROLES = Object.freeze(['admin', 'branch_manager', 'operations_manager', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'supervisor']);
  const SUGGESTED_TEMPLATE = Object.freeze({
    telex_release: 'telex_release', delivery_order: 'delivery_order', freight_charges: 'freight_charges', empty_return: 'empty_return_instructions',
    missing_documents: 'missing_documents', violation: 'violation_response', general_inquiry: 'clarification', appointment: 'clarification'
  });
  const LABELS = {
    category: {
      ar: { telex_release: 'طلب تلكس / إفراج', delivery_order: 'إذن تسليم', freight_charges: 'رسوم الشحن', appointment: 'موعد', missing_documents: 'مستندات ناقصة',
        violation: 'مخالفة', empty_return: 'متابعة إرجاع الفارغ', general_inquiry: 'استفسار عام', unknown: 'رسالة غير مصنفة' },
      en: { telex_release: 'Telex / release request', delivery_order: 'Delivery order', freight_charges: 'Freight charges', appointment: 'Appointment',
        missing_documents: 'Missing documents', violation: 'Violation', empty_return: 'Empty return follow-up', general_inquiry: 'General inquiry', unknown: 'Unclassified message' }
    },
    action: {
      ar: { send_telex: 'متابعة التلكس / الإفراج', issue_do: 'استلام إذن التسليم', pay_or_query_charges: 'مراجعة الرسوم مع المحاسبة', book_or_confirm_appointment: 'تأكيد الموعد',
        provide_documents: 'توفير المستندات الناقصة', respond_violation: 'الرد على المخالفة بعد المراجعة', arrange_empty_return: 'ترتيب إرجاع الفارغ',
        answer_inquiry: 'الرد على الاستفسار', review_manually: 'مراجعة يدوية' },
      en: { send_telex: 'follow up the telex / release', issue_do: 'collect the delivery order', pay_or_query_charges: 'review the charges with accounting',
        book_or_confirm_appointment: 'confirm the appointment', provide_documents: 'provide the missing documents', respond_violation: 'respond to the violation after review',
        arrange_empty_return: 'arrange the empty return', answer_inquiry: 'answer the inquiry', review_manually: 'manual review' }
    },
    kind: {
      ar: { bl_number: 'بوليصة', container_no: 'حاوية', declaration_no: 'بيان', invoice_no: 'فاتورة', tx_ref: 'معاملة', appointment_no: 'موعد', date: 'تاريخ' },
      en: { bl_number: 'B/L', container_no: 'container', declaration_no: 'declaration', invoice_no: 'invoice', tx_ref: 'transaction', appointment_no: 'appointment', date: 'date' }
    }
  };
  const isoDay = s => String(s || DEFAULT_CLOCK_ISO).slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const clip = (s, n) => Array.from(String(s)).slice(0, n).join('');

  function makeSummarize(clock) {
    return function summarize(input) {
      const i = input || {};
      const category = CATEGORIES.includes(i.category) ? i.category : 'unknown';
      const ex = Array.isArray(i.extractions) ? i.extractions : [];
      const action_code = ACTIONS[category];
      let suggested_role = DEFAULT_ROLES[category] || 'clearance_staff';
      for (const r of (Array.isArray(i.topic_rules) ? i.topic_rules : [])) {
        if (r && r.category === category && STAFF_ROLES.includes(r.owner_role)) { suggested_role = r.owner_role; break; }
      }
      // review fix: never a date before the message day (a «dated …» reference or quoted history is not a deadline); a deadline
      // phrase wins; for an appointment message, a date introduced by an appointment phrase, else the earliest date on / after the day
      let deadline = null;
      const refDay = isoDay(i.sent_at || clock());
      const usable = [];
      for (let k = 0; k < ex.length; k++) {
        const e = ex[k];
        if (e.kind === 'date' && e.valid && !(e.detail && e.detail.ambiguous) && /^\d{4}-\d{2}-\d{2}$/.test(e.normalized) && e.normalized >= refDay) usable.push(k);
      }
      const pickK = usable.find(k => ex[k].detail && ex[k].detail.deadline_phrase) ??
        (category === 'appointment' ? (usable.find(k => ex[k].detail && ex[k].detail.appointment_phrase) ??
          usable.slice().sort((a, b) => (ex[a].normalized < ex[b].normalized ? -1 : ex[a].normalized > ex[b].normalized ? 1 : a - b))[0]) : undefined);
      if (pickK !== undefined) deadline = { extraction_index: pickK };
      const refs = [];
      const seen = new Set();
      for (const e of ex) {
        if (!e.valid || e.kind === 'date') continue;
        const key = e.kind + ':' + e.normalized;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(e);
        if (refs.length >= 8) break;
      }
      const sender = i.sender || {};
      const senderAr = sender.display_name ? clip(sender.display_name, 160) : 'جهة غير معروفة';
      const senderEn = sender.display_name ? clip(sender.display_name, 160) : 'an unknown party';
      const refAr = refs.map(e => LABELS.kind.ar[e.kind] + ' ' + e.normalized).join('، ');
      const refEn = refs.map(e => LABELS.kind.en[e.kind] + ' ' + e.normalized).join(', ');
      const dl = deadline ? ex[deadline.extraction_index].normalized : null;
      const summary_ar = clip(LABELS.category.ar[category] + ' من ' + senderAr + '.' + (refAr ? ' المراجع: ' + refAr + '.' : ' لا توجد مراجع واضحة.') +
        (dl ? ' الموعد المذكور: ' + dl + '.' : '') + ' الإجراء المقترح: ' + LABELS.action.ar[action_code] + '.', 1000);
      const summary_en = clip(LABELS.category.en[category] + ' from ' + senderEn + '.' + (refEn ? ' References: ' + refEn + '.' : ' No clear reference.') +
        (dl ? ' Stated date: ' + dl + '.' : '') + ' Suggested action: ' + LABELS.action.en[action_code] + '.', 1000);
      const risks = [];
      const add = r => { if (r && !risks.includes(r)) risks.push(r); };
      (Array.isArray(i.flags) ? i.flags : []).forEach(add);
      if (dl) { const d = daysBetween(isoDay(clock()), dl); if (d >= 0 && d <= 2) add('deadline_soon'); }
      if (sender.status === 'unknown' || sender.status === 'known') add('sender_unverified');
      return { summary_ar, summary_en, action_code, suggested_role, deadline, risks };
    };
  }

  /* ------------------------------------------------------------------ injection detection (§24) — flags only */
  const INJECTION_PATTERNS = [
    { rule: 'ignore_instructions', re: /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+|prior\s+|above\s+|the above\s+)?(?:instructions|rules)/ },
    { rule: 'ignore_instructions', re: /ignore\s+(?:all|any|previous|prior|the above)\s+(?:\w+\s+)?(?:instructions|rules)/ },
    { rule: 'disregard', re: /(?<![a-z])disregard(?![a-z])/ },
    { rule: 'system_prompt', re: /system\s+prompt/ },
    { rule: 'role_override', re: /you\s+are\s+(?:now\s+)?(?:an?|the)\s+(?:assistant|ai)(?![a-z])/ },
    { rule: 'exfiltrate', re: /(?:send|forward|email)\s+(?:all|every|the)\s+(?:invoices|documents|files)\s+to(?![a-z])/ },
    { rule: 'ignore_instructions_ar', re: /تجاهل\s*(?:جميع|كل)?\s*(?:التعليمات|الاوامر)/ },
    { rule: 'exfiltrate_ar', re: /ارسل\s*(?:جميع|كل)\s*(?:الفواتير|المستندات)/ }
  ];
  const URGENCY = [/(?<![a-z])(?:asap|urgent|urgently|tomorrow|immediately)(?![a-z])/, /غدا|عاجل|فورا/];
  const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;
  const PHONE_IN_TEXT = /(?:\+|(?<!\d)00)\d[\d \-]{7,16}\d(?!\d)|(?<!\d)05\d{8}(?!\d)/g;
  function normPhone(s) {
    let t = String(s).replace(/[\s-]/g, '');
    if (t.startsWith('00')) t = '+' + t.slice(2);
    if (/^05\d{8}$/.test(t)) t = '+966' + t.slice(1);
    return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
  }
  function detectInjection(text, ctx) {
    const c = ctx || {};
    const known = new Set([].concat(c.participants || [], c.directory || []).map(x => String(x).toLowerCase()));
    const t = normKw(text);
    const flags = [];
    const hits = [];
    for (const p of INJECTION_PATTERNS) if (p.re.test(t) && !hits.some(h => h.rule === p.rule)) hits.push({ rule: p.rule });
    if (hits.length) flags.push('injection_suspected');
    let foreign = 0;
    for (const m of t.match(EMAIL_IN_TEXT) || []) if (!known.has(m.replace(/\.+$/, ''))) foreign++;
    for (const m of t.match(PHONE_IN_TEXT) || []) { const n = normPhone(m); if (n && !known.has(n)) foreign++; }
    if (foreign) { flags.push('foreign_address'); hits.push({ rule: 'foreign_address', count: foreign }); }
    if (URGENCY.some(re => re.test(t))) { flags.push('urgency_claim'); hits.push({ rule: 'urgency_claim' }); }
    return { flags, hits };
  }

  /* ------------------------------------------------------------------ templates (§22) */
  const PLACEHOLDERS = Object.freeze(['tx_ref', 'bl_number', 'declaration_no', 'container_list', 'client_name', 'counterpart_name', 'operation_label',
    'appointment_at', 'terminal_name', 'return_deadline_list', 'missing_documents_list', 'org_name', 'signature', 'today']);
  // mirror of app.msg_default_templates() (the migration seeds them as drafts with seed_msg_templates; the cycle test compares both)
  const T = (subject_tpl, body_tpl) => ({ subject_tpl, body_tpl });
  const DEFAULT_TEMPLATES = Object.freeze({
    telex_release: {
      ar: T('طلب تأكيد إفراج التلكس — بوليصة {{bl_number}}', 'السادة {{counterpart_name}}،\nنرجو تأكيد إفراج التلكس للبوليصة رقم {{bl_number}} الخاصة بالمعاملة {{tx_ref}}.\n{{signature}}'),
      en: T('Telex release confirmation — B/L {{bl_number}}', 'Dear {{counterpart_name}},\nPlease confirm the telex release for B/L {{bl_number}} (our reference {{tx_ref}}).\n{{signature}}')
    },
    delivery_order: {
      ar: T('طلب إذن التسليم — بوليصة {{bl_number}}', 'السادة {{counterpart_name}}،\nنرجو إصدار إذن التسليم للبوليصة رقم {{bl_number}} والحاويات: {{container_list}} (مرجعنا {{tx_ref}}).\n{{signature}}'),
      en: T('Delivery order request — B/L {{bl_number}}', 'Dear {{counterpart_name}},\nPlease issue the delivery order for B/L {{bl_number}}, containers: {{container_list}} (our reference {{tx_ref}}).\n{{signature}}')
    },
    freight_charges: {
      ar: T('طلب فاتورة رسوم الشحن — بوليصة {{bl_number}}', 'السادة {{counterpart_name}}،\nنرجو تزويدنا بفاتورة رسوم الشحن والرسوم المحلية للبوليصة رقم {{bl_number}} (مرجعنا {{tx_ref}}).\n{{signature}}'),
      en: T('Freight / local charges invoice — B/L {{bl_number}}', 'Dear {{counterpart_name}},\nPlease send us the freight and local charges invoice for B/L {{bl_number}} (our reference {{tx_ref}}).\n{{signature}}')
    },
    empty_return_instructions: {
      ar: T('تعليمات إرجاع الحاويات الفارغة — {{tx_ref}}', 'السادة {{counterpart_name}}،\nنرجو تزويدنا بموقع وموعد إرجاع الحاويات الفارغة: {{container_list}}.\n{{signature}}'),
      en: T('Empty container return instructions — {{tx_ref}}', 'Dear {{counterpart_name}},\nPlease advise the return location and deadline for the empty containers: {{container_list}}.\n{{signature}}')
    },
    missing_documents: {
      ar: T('مستندات مطلوبة — المعاملة {{tx_ref}}', 'السادة {{client_name}}،\nلاستكمال المعاملة {{tx_ref}} نرجو تزويدنا بالمستندات التالية: {{missing_documents_list}}.\n{{signature}}'),
      en: T('Documents required — transaction {{tx_ref}}', 'Dear {{client_name}},\nTo complete transaction {{tx_ref}} please provide: {{missing_documents_list}}.\n{{signature}}')
    },
    violation_response: {
      ar: T('بخصوص إشعار المخالفة — {{tx_ref}}', 'السادة {{counterpart_name}}،\nاستلمنا إشعاركم، ونرجو تزويدنا بتفاصيل المخالفة ورقمها المرجعي لدراستها.\n{{signature}}'),
      en: T('Regarding the violation notice — {{tx_ref}}', 'Dear {{counterpart_name}},\nWe received your notice. Please send the violation details and its reference number for our review.\n{{signature}}')
    },
    clarification: {
      ar: T('طلب إيضاح', 'السادة {{counterpart_name}}،\nشكرًا لرسالتكم. نرجو تزويدنا بالمراجع اللازمة (رقم البوليصة أو الحاوية أو مرجع المعاملة) للتحقق ومتابعة طلبكم.\n{{signature}}'),
      en: T('Clarification request', 'Dear {{counterpart_name}},\nThank you for your message. Please provide the references needed (B/L, container or transaction reference) so we can verify and follow up.\n{{signature}}')
    },
    ack_receipt: {
      ar: T('تأكيد استلام', 'استلمنا رسالتكم وسيتم الرد عليها.\n{{signature}}'),
      en: T('Acknowledgement', 'We received your message and will reply.\n{{signature}}')
    }
  });
  const MISSING_LABELS = {
    ar: { bl_number: 'رقم بوليصة الشحن', container_no: 'أرقام الحاويات', transaction: 'المرجع أو رقم المعاملة لدينا', appointment_date: 'تاريخ ووقت الموعد',
      documents_list: 'قائمة المستندات المطلوبة', recipient_verification: 'تأكيد صفتكم وتفويضكم بخطاب رسمي من الجهة المعنية قبل مشاركة أي بيانات' },
    en: { bl_number: 'the bill of lading number', container_no: 'the container numbers', transaction: 'our transaction reference', appointment_date: 'the appointment date and time',
      documents_list: 'the list of required documents', recipient_verification: 'confirmation of your role and authorization (an official letter from the party concerned) before any data can be shared' }
  };
  // placeholder → [fact key, missing code | null]
  const PH_FACT = {
    tx_ref: ['tx_ref', 'transaction'], bl_number: ['bl_number', 'bl_number'], declaration_no: ['declaration_no', null], container_list: ['container_list', 'container_no'],
    client_name: ['client_name', null], operation_label: ['operation_label', null], appointment_at: ['appointment', 'appointment_date'], terminal_name: ['appointment', null],
    return_deadline_list: ['return_deadlines', 'container_no'], missing_documents_list: ['missing_documents', 'documents_list']
  };
  const placeholdersOf = s => { const out = []; String(s || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => { if (!out.includes(k)) out.push(k); return m; }); return out; };
  const plain = (s, n) => clip(String(s === null || s === undefined ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, ''), n || 200);

  function makeDraftReply(clock) {
    return function draftReply(d) {
      const c = d || {};
      const lang = c.lang === 'en' ? 'en' : 'ar';
      const facts = c.facts || {};
      const pub = facts.public || {};
      const res = facts.restricted || null;
      const recipient = c.recipient || {};
      const params = c.params || {};
      const style = params.style || {};
      const sig = typeof params.signature === 'string' ? { text_ar: params.signature, text_en: params.signature } : (params.signature || {});
      const orgName = c.org_name || pub.org_name || null;
      const neverDiscuss = Array.isArray(params.never_discuss) ? params.never_discuss : [];
      let key = c.template_key || (c.template && c.template.key) || 'clarification';
      let tpl = c.template && c.template.subject_tpl !== undefined && c.template.body_tpl !== undefined && (!c.template.lang || c.template.lang === lang)
        ? { subject_tpl: c.template.subject_tpl, body_tpl: c.template.body_tpl, version: Number.isInteger(c.template.version) ? c.template.version : null, status: c.template.status || 'approved' }
        : null;
      if (!tpl) {
        const b = (DEFAULT_TEMPLATES[key] || DEFAULT_TEMPLATES.clarification)[lang];
        if (!DEFAULT_TEMPLATES[key]) key = 'clarification';
        tpl = { subject_tpl: b.subject_tpl, body_tpl: b.body_tpl, version: null, status: 'builtin' };
      }
      const used = [];
      const use = k => { if (!used.includes(k)) used.push(k); };
      const sep = lang === 'ar' ? '، ' : ', ';
      const value = {
        tx_ref: () => pub.tx_ref || null,
        bl_number: () => (res && res.bl_number) || null,
        declaration_no: () => (res && res.declaration_no) || null,
        container_list: () => (res && Array.isArray(res.container_list) && res.container_list.length ? res.container_list.join(sep) : null),
        client_name: () => (res && res.client_name) || greeting,
        operation_label: () => (res && res.operation_label) || null,
        appointment_at: () => (res && res.appointment && res.appointment.at) || null,
        terminal_name: () => (res && res.appointment && res.appointment.terminal_name) || null,
        return_deadline_list: () => (res && Array.isArray(res.return_deadlines) && res.return_deadlines.length
          ? res.return_deadlines.map(r => r.container_no + ': ' + r.date).join(sep) : null),
        missing_documents_list: () => (res && Array.isArray(res.missing_documents) && res.missing_documents.length
          ? res.missing_documents.map(x => '- ' + (typeof x === 'string' ? x : (x[lang === 'ar' ? 'label_ar' : 'label_en'] || x.label || x.kind || ''))).join('\n') : null)
      };
      // the templates carry the salutation («السادة» / "Dear"); the placeholder is the name only (directory name, never the inbound text)
      const greeting = recipient.verified && recipient.contact_display_name ? plain(recipient.contact_display_name, 160)
        : (lang === 'ar' ? 'الكرام' : 'Sir or Madam');
      const opening = style.greeting ? plain(style.greeting, 200) + '\n' : '';
      const signatureText = plain((lang === 'ar' ? sig.text_ar : sig.text_en) || (lang === 'ar' ? 'فريق التخليص' : 'Clearance team'), 500) +
        (orgName ? '\n' + plain(orgName, 160) : '');
      const fixed = {
        counterpart_name: () => greeting,
        org_name: () => orgName ? plain(orgName, 160) : (lang === 'ar' ? 'مرسى' : 'Marsa'),
        signature: () => signatureText,
        today: () => isoDay(clock())
      };
      const missing = [];
      const addMissing = m => { if (m && !missing.includes(m)) missing.push(m); };
      if (!(recipient.verified && recipient.authorized)) addMissing('recipient_verification');

      const fill = (s, record) => String(s || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
        if (fixed[k]) return fixed[k]();
        if (value[k]) {
          const v = value[k]();
          if (v === null || v === undefined || v === '') {
            if (record && PH_FACT[k] && PH_FACT[k][1]) addMissing(PH_FACT[k][1]);
            return '—';
          }
          if (record) use(PH_FACT[k][0]);
          return plain(v, 2000);
        }
        return '';
      });
      const category = c.category || null;
      if (category && neverDiscuss.includes(category)) {
        const b = DEFAULT_TEMPLATES.ack_receipt[lang];
        return { lang, subject: plain(fill(b.subject_tpl, false), 500), body_text: plain(fill(b.body_tpl, false), 20000), clarification: false,
          missing: [], used_facts: [], template_key: 'ack_receipt', template_version: null, template_status: 'builtin' };
      }
      // first pass: which confirmed facts are missing for this template?
      const needed = placeholdersOf(tpl.subject_tpl + '\n' + tpl.body_tpl);
      for (const k of needed) {
        if (value[k]) { const v = value[k](); if ((v === null || v === undefined || v === '') && PH_FACT[k][1]) addMissing(PH_FACT[k][1]); }
      }
      const restrictedNeeded = needed.some(k => value[k] && k !== 'tx_ref');
      const needsClarification = key === 'clarification' || missing.some(m => m !== 'recipient_verification') ||
        (missing.includes('recipient_verification') && restrictedNeeded);
      if (!needsClarification) {
        const subject = plain(fill(tpl.subject_tpl, true), 500);
        let body = opening + fill(tpl.body_tpl, true);
        if (style.closing) body += '\n' + plain(style.closing, 200);
        return { lang, subject, body_text: plain(body, 20000), clarification: false, missing: [], used_facts: used,
          template_key: key, template_version: tpl.version, template_status: tpl.status };
      }
      // clarification: ask the counterpart for exactly the missing items; never guess, never share restricted facts
      const ct = (key === 'clarification' && tpl) ? tpl : Object.assign({ version: null, status: 'builtin' }, DEFAULT_TEMPLATES.clarification[lang]);
      const used2 = [];
      if (pub.tx_ref && (recipient.verified && recipient.authorized)) used2.push('tx_ref');
      const items = missing.length ? missing : ['transaction'];
      const list = (lang === 'ar' ? 'نرجو تزويدنا بما يلي:' : 'Please provide the following:') + '\n' + items.map(m => '- ' + MISSING_LABELS[lang][m]).join('\n');
      let sawSig = false;
      let body = opening + String(ct.body_tpl).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
        if (k === 'signature') { sawSig = true; return list + '\n\n' + signatureText; }
        return fixed[k] ? fixed[k]() : (k === 'tx_ref' && used2.includes('tx_ref') ? pub.tx_ref : '—');
      });
      if (!sawSig) body += '\n' + list + '\n\n' + signatureText;
      const subject = plain(String(ct.subject_tpl).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (fixed[k] ? fixed[k]() : '')), 500);
      return { lang, subject, body_text: plain(body, 20000), clarification: true, missing: items, used_facts: used2,
        template_key: 'clarification', template_version: key === 'clarification' ? ct.version : null, template_status: key === 'clarification' ? ct.status : 'builtin' };
    };
  }

  function createRuleProvider(opts) {
    const o = opts || {};
    const clock = typeof o.clock === 'function' ? o.clock : () => DEFAULT_CLOCK_ISO;
    return Object.freeze({
      name: 'rule_mock', version: PROVIDER_VERSION,
      extract, classify, summarize: makeSummarize(clock), draftReply: makeDraftReply(clock), detectInjection
    });
  }

  const API = {
    createRuleProvider, RULES, DEFAULT_TEMPLATES, ACTIONS, iso6346CheckDigit, iso6346Valid, foldDigits, PROVIDER_VERSION,
    CATEGORIES, PLACEHOLDERS, SUGGESTED_TEMPLATE, DEFAULT_ROLES, MISSING_LABELS, placeholdersOf
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();

/* ==========================================================================
   مرسى | MARSA — G6a role dashboards  →  window.MarsaDash
   --------------------------------------------------------------------------
   Contract: docs/online/G6A_SPEC.md §3 (dash_ops / dash_finance / dash_management)
   and §3.4 (UI). admin.js renderDashboard(param) draws the tab strip
   «نظرة عامة · التشغيل · المالية · الإدارة» and calls, for a role tab,
       MarsaDash.render(root, tab, opsApi)     tab = 'ops' | 'finance' | 'management'
   * One RPC per tab, each returning only what the caller's role may see: the
     server filters by org membership, branch scope per row and role. The UI
     never filters for security; a missing tab is hidden by admin.js only.
   * Official invoice figures come from Daftra only (G6a-6): the finance tab
     shows `official` (issued intents, Daftra-synced fields) and, apart, the
     Marsa drafts as «قيد الإعداد — غير رسمي» — never added together. G4
     margins are linked (#margins, «تحليلي»), never recomputed here.
   * Filters: branch select on every tab (from opsApi.branches, «كل الفروع»
     default), currency on finance, from / to on management (default: the
     current month, Asia/Riyadh, decided by the server). Kept in memory per tab.
   * Every tile links to the filtered list / report. Original design only:
     card card-stat adm-tile, adm-mini, card adm-card, table.table.table-striped
     .adm-table in .table-wrap, badge, form-control, adm-loading.
   * Strings: own namespace 'dash' (ar + en) registered below. Server data goes
     in through textContent / createElement only (opsApi.el).
   * A missing MarsaApi function or RPC (G6a migration not applied) → the
     ops.api_missing alert; admin.js' overview tab keeps working.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var DICT = {
    ar: {
      tabs_label: 'أقسام لوحة التحكم', tab_overview: 'نظرة عامة', tab_ops: 'التشغيل', tab_finance: 'المالية', tab_management: 'الإدارة',
      none: '—', loading: 'جارٍ التحميل…', load_failed: 'تعذّر تحميل لوحة التحكم: {e}', retry: 'إعادة المحاولة',
      api_missing: 'هذه الميزة غير متاحة بعد في واجهة الاتصال ({fn}).',
      f_branch: 'الفرع', all_branches: 'كل الفروع', f_currency: 'العملة', all_currencies: 'كل العملات', f_from: 'من', f_to: 'إلى',
      apply: 'تطبيق', reset: 'الشهر الحالي', generated_at: 'آخر تحديث: {d}', scope_note: 'الأرقام محسوبة على الفروع والصلاحيات المسموح لك بها فقط.',
      // ops
      ops_title: 'لوحة التشغيل',
      k_tx_open: 'معاملات مفتوحة', k_tx_open_foot: 'متوقفة منذ أكثر من 7 أيام: {n}',
      k_appts_today: 'مواعيد الميناء اليوم', k_appts_foot: 'مؤكدة {c} · مطلوبة {r} · خلال 7 أيام {n}', k_appts_missed: 'مواعيد فائتة اليوم',
      k_trips_today: 'رحلات مخططة اليوم', k_trips_foot: 'متأخرة {n}', k_trips_late: 'رحلات متأخرة',
      k_ctr_overdue: 'حاويات متأخرة الإرجاع', k_ctr_overdue_foot: 'خلال 3 أيام {a} · خلال 7 أيام {b}',
      k_ctr_open: 'حاويات بانتظار الإرجاع', k_ctr_open_foot: 'إثبات مُقدَّم {e} · متنازع عليها {d}',
      k_alerts: 'تنبيهات حرجة', k_alerts_foot: 'تحذير {w} · معلومات {i}', k_exceptions: 'استثناءات مفتوحة',
      k_req_new: 'طلبات جديدة', k_req_foot: 'قيد المراجعة {n}',
      sec_by_status: 'المعاملات حسب المرحلة', sec_appts: 'المواعيد القادمة', sec_trips: 'رحلات النقل القادمة', sec_ctr: 'أقرب مواعيد إرجاع الفارغ',
      sec_ctr_state: 'الحاويات حسب الحالة التشغيلية', sec_transport: 'النقل حسب الحالة',
      empty_appts: 'لا توجد مواعيد قادمة.', empty_trips: 'لا توجد رحلات قادمة.', empty_ctr: 'لا توجد حاويات بانتظار الإرجاع.', empty_list: 'لا توجد بيانات.',
      leg: 'المرحلة {n}', days_left: 'خلال {n} يوم', days_over: 'متأخرة {n} يوم', due_today: 'اليوم',
      see_report: 'التقرير', see_schedule: 'الجدول اليومي', see_all: 'عرض الكل',
      // finance
      fin_title: 'لوحة المالية',
      fin_note: 'الأرقام الرسمية للفواتير من دفترة (آخر مزامنة: {d})؛ هوامش G4 تحليلية.', never_synced: 'لم تتم بعد',
      mock_banner: 'وضع المحاكاة — لا اتصال بدفترة حقيقية',
      sec_official: 'الفواتير الصادرة — أرقام رسمية من دفترة', official_empty: 'لا توجد فواتير صادرة في هذا النطاق.',
      col_currency: 'العملة', col_issued: 'عدد الفواتير', col_total: 'الإجمالي', col_paid: 'المسدد', col_outstanding: 'المتبقي',
      source_daftra: 'المصدر: دفترة (حقول المزامنة للفواتير الصادرة فقط).',
      cancelled_pending: 'أُلغيت في دفترة وتنتظر قرار المحاسب (غير محسوبة أعلاه): {v}',
      sec_unofficial: 'قيد الإعداد — غير رسمي', unofficial_note: 'مسودات مرسى قبل الإصدار في دفترة؛ لا تُجمع مع الأرقام الرسمية.',
      k_open_intents: 'أغراض فوترة قيد الإعداد', col_lines_total: 'إجمالي البنود (غير رسمي)',
      sec_payables: 'المستحقات للموردين', col_open_amount: 'المستحق المفتوح', col_overdue_amount: 'المتأخر', col_open_count: 'فواتير مفتوحة', col_overdue_count: 'فواتير متأخرة',
      payables_empty: 'لا توجد مستحقات مفتوحة.',
      k_si_review: 'فواتير موردين للمراجعة', k_si_foot: 'مستلمة {r} · قيد المراجعة {u} · متنازع عليها {d}',
      k_due7: 'مستحقات خلال 7 أيام', k_cost_queue: 'تكاليف بانتظار المراجعة', k_cost_foot: 'تكاليف متوقعة مفتوحة {a} · تعديلات معلقة {j}',
      k_bill_review: 'بنود مراجعة الفوترة', k_bill_conflict: 'تعارضات مع دفترة', k_bill_conflict_foot: 'نتيجة غير معروفة {u} · أخطاء {e}',
      k_jobs_failed: 'مهام مزامنة فاشلة', k_jobs_foot: 'في الانتظار {q} · متوقفة نهائيًا {d}',
      sec_billing: 'الفوترة ودفترة', sec_fin_status: 'المعاملات حسب الحالة المالية', b_intents: 'أغراض الفوترة', b_sync: 'المزامنة', b_jobs: 'المهام',
      b_connection: 'الاتصال', conn_line: '{s} · {m} · المزامنة {e}', sync_on: 'مفعّلة', sync_off: 'موقوفة',
      margins_link: 'الهامش والتكاليف (تحليلي)', analytical: 'تحليلي — ليس رقمًا محاسبيًا رسميًا',
      // management
      mgmt_title: 'لوحة الإدارة', period: 'الفترة: {f} — {t}',
      k_req_received: 'طلبات واردة', k_req_conv_foot: 'حُوّلت {c} · رُفضت {r}',
      k_tx_created: 'معاملات جديدة', k_tx_completed: 'معاملات مكتملة تشغيليًا', k_tx_closed: 'معاملات مغلقة', k_open_now: 'مفتوحة الآن',
      k_cycle: 'متوسط مدة الإنجاز (يوم)', k_cycle_foot: 'من الإنشاء حتى الاكتمال التشغيلي',
      k_overdue_now: 'حاويات متأخرة الآن', k_returned: 'حاويات أُرجعت في الفترة', k_alerts_now: 'تنبيهات حرجة الآن',
      sec_by_branch: 'حسب الفرع', col_branch: 'الفرع', col_open_now: 'مفتوحة الآن', col_created: 'جديدة', col_completed: 'مكتملة', col_overdue: 'حاويات متأخرة',
      sec_mgmt_fin: 'المالية (فواتير رسمية من دفترة)', col_payables_overdue: 'مستحقات موردين متأخرة', mgmt_fin_hidden: 'الملخص المالي متاح لصلاحيات المالية فقط.',
      bad_range: 'تاريخ «من» يجب أن يسبق تاريخ «إلى».'
    },
    en: {
      tabs_label: 'Dashboard sections', tab_overview: 'Overview', tab_ops: 'Operations', tab_finance: 'Finance', tab_management: 'Management',
      none: '—', loading: 'Loading…', load_failed: 'The dashboard could not be loaded: {e}', retry: 'Retry',
      api_missing: 'This feature is not available in the data layer yet ({fn}).',
      f_branch: 'Branch', all_branches: 'All branches', f_currency: 'Currency', all_currencies: 'All currencies', f_from: 'From', f_to: 'To',
      apply: 'Apply', reset: 'Current month', generated_at: 'Updated: {d}', scope_note: 'Figures only cover the branches and roles you are allowed to see.',
      ops_title: 'Operations dashboard',
      k_tx_open: 'Open transactions', k_tx_open_foot: 'Idle for more than 7 days: {n}',
      k_appts_today: 'Port appointments today', k_appts_foot: 'Confirmed {c} · requested {r} · next 7 days {n}', k_appts_missed: 'Missed appointments today',
      k_trips_today: 'Trips planned today', k_trips_foot: 'Late {n}', k_trips_late: 'Late trips',
      k_ctr_overdue: 'Containers overdue for return', k_ctr_overdue_foot: 'Within 3 days {a} · within 7 days {b}',
      k_ctr_open: 'Containers awaiting return', k_ctr_open_foot: 'Evidence submitted {e} · disputed {d}',
      k_alerts: 'Critical alerts', k_alerts_foot: 'Warning {w} · info {i}', k_exceptions: 'Open exceptions',
      k_req_new: 'New requests', k_req_foot: 'Under review {n}',
      sec_by_status: 'Transactions by stage', sec_appts: 'Upcoming appointments', sec_trips: 'Upcoming transport trips', sec_ctr: 'Nearest empty-return deadlines',
      sec_ctr_state: 'Containers by operational state', sec_transport: 'Transport by status',
      empty_appts: 'No upcoming appointments.', empty_trips: 'No upcoming trips.', empty_ctr: 'No containers awaiting return.', empty_list: 'No data.',
      leg: 'Leg {n}', days_left: 'In {n} days', days_over: '{n} days overdue', due_today: 'Today',
      see_report: 'Report', see_schedule: 'Daily schedule', see_all: 'See all',
      fin_title: 'Finance dashboard',
      fin_note: 'Official invoice figures come from Daftra (last sync: {d}); G4 margins are analytical.', never_synced: 'not yet',
      mock_banner: 'Mock mode — no connection to a real Daftra account',
      sec_official: 'Issued invoices — official figures from Daftra', official_empty: 'No issued invoices in this scope.',
      col_currency: 'Currency', col_issued: 'Invoices', col_total: 'Total', col_paid: 'Paid', col_outstanding: 'Outstanding',
      source_daftra: 'Source: Daftra (synced fields of issued invoices only).',
      cancelled_pending: 'Cancelled in Daftra, awaiting the accountant (not in the figures above): {v}',
      sec_unofficial: 'In preparation — not official', unofficial_note: 'Marsa drafts before issue in Daftra; never added to the official figures.',
      k_open_intents: 'Billing intents in preparation', col_lines_total: 'Lines total (not official)',
      sec_payables: 'Supplier payables', col_open_amount: 'Open amount', col_overdue_amount: 'Overdue', col_open_count: 'Open invoices', col_overdue_count: 'Overdue invoices',
      payables_empty: 'No open payables.',
      k_si_review: 'Supplier invoices to review', k_si_foot: 'Received {r} · under review {u} · disputed {d}',
      k_due7: 'Payables due within 7 days', k_cost_queue: 'Costs awaiting review', k_cost_foot: 'Open expected costs {a} · pending adjustments {j}',
      k_bill_review: 'Billing review items', k_bill_conflict: 'Conflicts with Daftra', k_bill_conflict_foot: 'Unknown result {u} · errors {e}',
      k_jobs_failed: 'Failed sync jobs', k_jobs_foot: 'Queued {q} · dead {d}',
      sec_billing: 'Billing & Daftra', sec_fin_status: 'Transactions by financial status', b_intents: 'Billing intents', b_sync: 'Sync', b_jobs: 'Jobs',
      b_connection: 'Connection', conn_line: '{s} · {m} · sync {e}', sync_on: 'enabled', sync_off: 'disabled',
      margins_link: 'Margins & costs (analytical)', analytical: 'Analytical — not an official accounting figure',
      mgmt_title: 'Management dashboard', period: 'Period: {f} — {t}',
      k_req_received: 'Requests received', k_req_conv_foot: 'Converted {c} · rejected {r}',
      k_tx_created: 'New transactions', k_tx_completed: 'Operationally completed', k_tx_closed: 'Closed transactions', k_open_now: 'Open now',
      k_cycle: 'Average cycle time (days)', k_cycle_foot: 'From creation to operational completion',
      k_overdue_now: 'Containers overdue now', k_returned: 'Containers returned in the period', k_alerts_now: 'Critical alerts now',
      sec_by_branch: 'By branch', col_branch: 'Branch', col_open_now: 'Open now', col_created: 'New', col_completed: 'Completed', col_overdue: 'Overdue containers',
      sec_mgmt_fin: 'Finance (official invoices from Daftra)', col_payables_overdue: 'Overdue supplier payables', mgmt_fin_hidden: 'The finance summary is available to finance roles only.',
      bad_range: '"From" must not be after "To".'
    }
  };
  if (I && typeof I.register === 'function') { try { I.register('dash', DICT); } catch (e) { /* local fallback below */ } }

  function lang(api) { return api && typeof api.isEn === 'function' && api.isEn() ? 'en' : 'ar'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : String(s); }
  function t(api, k, vars) {
    var key = 'dash.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s && s !== key) return s; }
    var d = DICT[lang(api)][k]; if (d == null) d = DICT.ar[k];
    return interp(d == null ? k : d, vars);
  }
  function apiMissingText(api, fn) {
    if (I && typeof I.t === 'function') { var s = I.t('ops.api_missing', { fn: fn }); if (s && s !== 'ops.api_missing') return s; }
    return t(api, 'api_missing', { fn: fn });
  }

  /* ------------------------------------------------------------------
     DOM helpers (opsApi.el = admin.js el: textContent / attributes only)
     ------------------------------------------------------------------ */
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var CUR_RE = /^[A-Z]{3}$/;
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && typeof v !== 'object' && typeof v !== 'boolean' && !isNaN(+v) ? +v : null); }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function count(api, v) { var n = num(v); return n == null ? t(api, 'none') : api.fmtNumber(n); }
  function money(api, v, cur) { var n = num(v); return n == null ? t(api, 'none') : api.fmtMoney(n, CUR_RE.test(cur || '') ? cur : 'SAR'); }
  function alertNode(api, type, text) {
    return api.el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, [api.el('div', { text: text })]);
  }
  function tile(api, o) {
    // o: {label, value (number|null), display (text, optional), foot, href, tone}
    var v = num(o.value);
    var tint = (o.tone === 'danger' || o.tone === 'warning') && v ? ' adm-tile-' + o.tone : '';
    // href false: the figure has no list that reproduces it (a plain tile, never a misleading link)
    var link = o.href !== false;
    return api.el(link ? 'a' : 'div', { class: 'card card-stat adm-tile' + tint, href: link ? (o.href || '#dashboard') : null, 'data-dash-tile': o.id || null }, [
      api.el('span', { class: 'stat-value num', text: o.display != null ? o.display : count(api, v) }),
      api.el('span', { class: 'stat-label', text: o.label }),
      o.foot ? api.el('span', { class: 'adm-tile-foot text-xs text-muted', text: o.foot }) : null
    ]);
  }
  function tiles(api, list) { return api.el('div', { class: 'adm-tiles dash-tiles' }, list.filter(Boolean).map(function (o) { return tile(api, o); })); }
  function card(api, title, body, actions, cls) {
    return api.el('div', { class: 'card card-flush adm-card' + (cls ? ' ' + cls : '') }, [
      api.el('div', { class: 'card-header' }, [api.el('h3', { text: title }), actions && actions.length ? api.el('div', { class: 'btn-group' }, actions) : null]),
      api.el('div', { class: 'card-body' }, body)
    ]);
  }
  function linkBtn(api, text, href) { return api.el('a', { class: 'btn btn-sm btn-ghost', href: href, text: text }); }
  function mini(api, items, emptyText) {
    if (!items.length) return api.el('p', { class: 'text-sm text-muted dash-empty', text: emptyText || t(api, 'empty_list') });
    return api.el('ul', { class: 'adm-mini' }, items.map(function (it) {
      var main = api.el('span', { class: 'adm-mini-main' }, [api.el('span', { class: 'adm-mini-title' }, it.title), it.sub ? api.el('span', { class: 'adm-mini-sub', text: it.sub }) : null]);
      var side = it.side ? api.el('span', { class: 'adm-mini-side' }, it.side) : null;
      return api.el('li', null, it.href ? api.el('a', { class: 'adm-mini-row', href: it.href }, [main, side]) : api.el('div', { class: 'adm-mini-row' }, [main, side]));
    }));
  }
  function pill(api, tone, text) { return api.el('span', { class: 'badge badge-' + (tone || 'muted'), text: text }); }
  function ltr(api, v) { return api.el('bdi', { dir: 'ltr', class: 'num', text: v == null || v === '' ? t(api, 'none') : String(v) }); }
  function table(api, headers, rows, emptyText, foot) {
    var body = api.el('tbody', null, rows.length ? rows : api.el('tr', null, api.el('td', { colspan: headers.length, class: 'adm-empty', text: emptyText || t(api, 'empty_list') })));
    return api.el('div', { class: 'table-wrap' }, api.el('table', { class: 'table table-striped adm-table' }, [
      api.el('thead', null, api.el('tr', null, headers.map(function (h, i) { return api.el('th', { scope: 'col', class: i ? 'num' : null, text: h }); }))), body, foot || null
    ]));
  }
  function tr(api, cells) {
    return api.el('tr', null, cells.map(function (c, i) { return api.el('td', { class: i ? 'num' : null }, c == null ? t(api, 'none') : c); }));
  }
  // {code: n} as a bar list (original .chart-bars .adm-bars), each bar a link
  function bars(api, map, order, domain, hrefOf, label) {
    var m = obj(map), keys = (order || []).filter(function (k) { return k in m; });
    Object.keys(m).forEach(function (k) { if (keys.indexOf(k) === -1 && num(m[k]) != null) keys.push(k); });
    if (!keys.length) return api.el('p', { class: 'text-sm text-muted dash-empty', text: t(api, 'empty_list') });
    var max = 0;
    keys.forEach(function (k) { max = Math.max(max, num(m[k]) || 0); });
    return api.el('div', { class: 'chart-bars adm-bars', role: 'list', 'aria-label': label || null }, keys.map(function (k) {
      var n = num(m[k]) || 0, lab = api.label(domain, k);
      var b = api.el(hrefOf ? 'a' : 'div', { class: 'chart-bar' + (n ? '' : ' is-zero'), role: 'listitem', href: hrefOf ? hrefOf(k) : null, 'aria-label': lab + ': ' + api.fmtNumber(n) }, [
        api.el('span', { class: 'chart-bar-label', text: lab }),
        api.el('span', { class: 'chart-bar-track', 'aria-hidden': 'true' }, api.el('span', { class: 'chart-bar-fill' })),
        api.el('span', { class: 'chart-bar-value', text: api.fmtNumber(n) })
      ]);
      b.style.setProperty('--v', String(max ? n / max : 0));
      return b;
    }));
  }
  function kv(api, rows) {
    return api.el('ul', { class: 'kv dash-kv' }, rows.filter(Boolean).map(function (r) {
      return api.el('li', null, [api.el('span', { class: 'k', text: r[0] }), api.el('span', { class: 'v' }, r[1] == null || r[1] === '' ? t(api, 'none') : r[1])]);
    }));
  }
  // code label: admin's label (status_labels + page dictionaries) first, then the G5 billing dictionaries
  // (bill.<domain>_<code>, billtx.lbl_<domain>_<code>; the connection status prefix is 'daftra_conn_status'), else the code
  var LABEL_ALIAS = { daftra_connection_status: 'daftra_conn_status' };
  function lbl(api, domain, code) {
    if (code == null || code === '') return t(api, 'none');
    var s = null;
    try { s = typeof api.label === 'function' ? api.label(domain, code) : null; } catch (e) { s = null; }
    if (s && s !== String(code) && s !== domain + '.' + code) return s;
    var d = LABEL_ALIAS[domain] || domain;
    if (I && typeof I.has === 'function' && typeof I.t === 'function') {
      var k1 = 'bill.' + d + '_' + code, k2 = 'billtx.lbl_' + d + '_' + code;
      if (I.has(k1)) return I.t(k1);
      if (I.has(k2)) return I.t(k2);
    }
    return s || String(code);
  }
  function codeMap(api, map, domain) {
    var m = obj(map), keys = Object.keys(m).filter(function (k) { return num(m[k]) != null; });
    if (!keys.length) return api.el('p', { class: 'text-sm text-muted dash-empty', text: t(api, 'empty_list') });
    return kv(api, keys.map(function (k) { return [lbl(api, domain, k), count(api, m[k])]; }));
  }
  // today in Asia/Riyadh (UTC+3, no DST) — the server's app.rpt_today()
  function riyadhToday() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
  // hash query of a list / report link; arrays are comma-joined (the rpt/*.js views' 'codes' format: status=planned,dispatched)
  function q(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (Array.isArray(v)) v = v.filter(function (x) { return x != null && x !== ''; }).join(',');
      if (v != null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function daysText(api, n) {
    n = num(n);
    if (n == null) return '';
    if (n < 0) return t(api, 'days_over', { n: api.fmtNumber(-n) });
    if (n === 0) return t(api, 'due_today');
    return t(api, 'days_left', { n: api.fmtNumber(n) });
  }
  function rpcMissing(err) {
    var raw = err && (err.raw || err);
    var code = raw && raw.code ? String(raw.code) : '';
    return (err && err.code === 'MRS_UNAVAILABLE') || code === '42883' || code === 'PGRST202' || /could not find the function/i.test(String((raw && raw.message) || ''));
  }
  function currencies(byCur) { return Object.keys(obj(byCur)).filter(function (c) { return CUR_RE.test(c); }).sort(); }

  /* ------------------------------------------------------------------
     Filters (in memory per tab; never in the URL, never in storage)
     ------------------------------------------------------------------ */
  var F = { ops: { branch_id: '' }, finance: { branch_id: '', currency: '' }, management: { branch_id: '', from: '', to: '' } };
  var SEEN_CUR = ['SAR', 'USD', 'EUR'];
  function filterBar(api, tab, onApply) {
    var f = F[tab];
    var kids = [];
    var branches = arr(api.branches).filter(function (b) { return b && UUID_RE.test(b.id || '') && b.is_active !== false; });
    if (f.branch_id && !branches.some(function (b) { return b.id === f.branch_id; })) f.branch_id = '';
    var bSel = api.el('select', { class: 'form-control', id: 'dash-f-branch', name: 'branch_id' },
      [api.el('option', { value: '', text: t(api, 'all_branches') })].concat(branches.map(function (b) {
        return api.el('option', { value: b.id, text: (lang(api) === 'en' && b.name_en) || b.name_ar || b.name_en || b.code || b.id.slice(0, 8) });
      })));
    bSel.value = f.branch_id || '';
    bSel.addEventListener('change', function () { f.branch_id = UUID_RE.test(bSel.value) ? bSel.value : ''; onApply(); });
    kids.push(api.el('div', { class: 'form-group' }, [api.el('label', { class: 'form-label', for: 'dash-f-branch', text: t(api, 'f_branch') }), bSel]));
    if (tab === 'finance') {
      var cSel = api.el('select', { class: 'form-control', id: 'dash-f-currency', name: 'currency', dir: 'ltr' },
        [api.el('option', { value: '', text: t(api, 'all_currencies') })].concat(SEEN_CUR.map(function (c) { return api.el('option', { value: c, text: c }); })));
      cSel.value = f.currency || '';
      cSel.addEventListener('change', function () { f.currency = CUR_RE.test(cSel.value) ? cSel.value : ''; onApply(); });
      kids.push(api.el('div', { class: 'form-group' }, [api.el('label', { class: 'form-label', for: 'dash-f-currency', text: t(api, 'f_currency') }), cSel]));
    }
    if (tab === 'management') {
      var from = api.el('input', { class: 'form-control', type: 'date', id: 'dash-f-from', name: 'from', value: f.from || '' });
      var to = api.el('input', { class: 'form-control', type: 'date', id: 'dash-f-to', name: 'to', value: f.to || '' });
      var err = api.el('p', { class: 'form-error dash-range-error', role: 'alert', hidden: true });
      var applyBtn = api.el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: t(api, 'apply') });
      var resetBtn = api.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: t(api, 'reset') });
      applyBtn.addEventListener('click', function () {
        var a = /^\d{4}-\d{2}-\d{2}$/.test(from.value) ? from.value : '', b = /^\d{4}-\d{2}-\d{2}$/.test(to.value) ? to.value : '';
        if (a && b && a > b) { err.textContent = t(api, 'bad_range'); err.hidden = false; return; }
        err.hidden = true; f.from = a; f.to = b; onApply();
      });
      resetBtn.addEventListener('click', function () { f.from = ''; f.to = ''; onApply(); });
      kids.push(api.el('div', { class: 'form-group' }, [api.el('label', { class: 'form-label', for: 'dash-f-from', text: t(api, 'f_from') }), from]));
      kids.push(api.el('div', { class: 'form-group' }, [api.el('label', { class: 'form-label', for: 'dash-f-to', text: t(api, 'f_to') }), to]));
      kids.push(applyBtn, resetBtn, err);
    }
    return api.el('div', { class: 'card adm-filters dash-filters', role: 'search' }, kids);
  }
  function filtersFor(tab) {
    var f = F[tab], out = {};
    if (f.branch_id) out.branch_id = f.branch_id;
    if (tab === 'finance' && f.currency) out.currency = f.currency;
    if (tab === 'management') { if (f.from) out.from = f.from; if (f.to) out.to = f.to; }
    return out;
  }

  /* ------------------------------------------------------------------
     Operations — dash_ops (no money anywhere)
     ------------------------------------------------------------------ */
  var OPS_ORDER = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  function paintOps(api, box, d) {
    var tx = obj(d.transactions), ap = obj(d.appointments), today = obj(ap.today), tr0 = obj(d.transport), trs = obj(tr0.by_status);
    var ct = obj(d.containers), al = obj(d.alerts), rq = d.requests && typeof d.requests === 'object' ? d.requests : null;
    var br = F.ops.branch_id ? { branchId: F.ops.branch_id } : {};
    var list = [
      { id: 'tx_open', label: t(api, 'k_tx_open'), value: tx.open, href: '#transactions' + q(br), tone: 'brand',
        foot: num(tx.stale_7d) != null ? t(api, 'k_tx_open_foot', { n: count(api, tx.stale_7d) }) : null },
      { id: 'appts_today', label: t(api, 'k_appts_today'), value: (num(today.requested) || 0) + (num(today.confirmed) || 0) + (num(today.completed) || 0), href: '#schedule',
        foot: t(api, 'k_appts_foot', { c: count(api, today.confirmed), r: count(api, today.requested), n: count(api, ap.next_7d) }) },
      { id: 'appts_missed', label: t(api, 'k_appts_missed'), value: today.missed, href: '#schedule', tone: 'danger' },
      // the links reproduce the tile numbers: today_planned = non-cancelled trips planned today (Riyadh);
      // late = planned / dispatched with planned_at past (report_trips 'late'); both with the tab's branch
      { id: 'trips_today', label: t(api, 'k_trips_today'), value: tr0.today_planned,
        href: '#reports/trips' + q({ from: riyadhToday(), to: riyadhToday(), status: ['planned', 'dispatched', 'loaded', 'delivered'], branch_id: F.ops.branch_id }),
        foot: t(api, 'k_trips_foot', { n: count(api, tr0.late) }) },
      { id: 'trips_late', label: t(api, 'k_trips_late'), value: tr0.late, href: '#reports/trips' + q({ late: 'true', branch_id: F.ops.branch_id }), tone: 'warning' },
      { id: 'ctr_overdue', label: t(api, 'k_ctr_overdue'), value: ct.overdue, href: '#reports/containers' + q({ overdue: 'true', branch_id: F.ops.branch_id }), tone: 'danger',
        foot: t(api, 'k_ctr_overdue_foot', { a: count(api, ct.due_3d), b: count(api, ct.due_7d) }) },
      { id: 'ctr_open', label: t(api, 'k_ctr_open'), value: ct.open_returns, href: '#reports/containers' + q({ return_status: ['pending', 'evidence_submitted', 'disputed'], branch_id: F.ops.branch_id }),
        foot: t(api, 'k_ctr_open_foot', { e: count(api, ct.evidence_submitted), d: count(api, ct.disputed) }), tone: num(ct.disputed) ? 'warning' : null },
      { id: 'alerts', label: t(api, 'k_alerts'), value: al.critical, href: '#alerts', tone: 'danger', foot: t(api, 'k_alerts_foot', { w: count(api, al.warning), i: count(api, al.info) }) },
      { id: 'exceptions', label: t(api, 'k_exceptions'), value: d.exceptions_open, href: '#exceptions', tone: 'warning' }
    ];
    if (rq) list.unshift({ id: 'req_new', label: t(api, 'k_req_new'), value: rq['new'], href: '#requests?status=new', foot: t(api, 'k_req_foot', { n: count(api, rq.under_review) }) });
    box.appendChild(tiles(api, list));

    box.appendChild(api.el('div', { class: 'adm-cols adm-cols-wide' }, [
      card(api, t(api, 'sec_by_status'), bars(api, tx.by_status, OPS_ORDER, 'operational_status', function (c) { return '#transactions' + q({ status: c, branchId: F.ops.branch_id }); }, t(api, 'sec_by_status'))),
      card(api, t(api, 'sec_ctr_state'), [codeMap(api, ct.by_operational_state, 'container_state'),
        api.el('h4', { class: 'dash-sub-title', text: t(api, 'sec_transport') }), codeMap(api, trs, 'trip_status')])
    ]));

    var appts = arr(ap.upcoming).slice(0, 10).map(function (a) {
      return { href: UUID_RE.test(a.transaction_id || '') ? '#tx/' + a.transaction_id : '#schedule',
        title: [ltr(api, a.transaction_ref), a.container_no ? [' · ', ltr(api, a.container_no)] : null],
        sub: api.fmtDate(a.appointment_at, true), side: pill(api, a.status === 'confirmed' ? 'success' : 'info', api.label('appt_status', a.status)) };
    });
    var trips = arr(tr0.upcoming).slice(0, 10).map(function (x) {
      return { href: '#schedule', title: [ltr(api, x.transaction_ref), x.container_no ? [' · ', ltr(api, x.container_no)] : null],
        sub: [x.leg_no != null ? t(api, 'leg', { n: x.leg_no }) : null, x.carrier_name, api.fmtDate(x.planned_at, true)].filter(Boolean).join(' · '),
        side: pill(api, 'info', api.label('trip_status', x.status)) };
    });
    var ctrs = arr(ct.nearest).slice(0, 10).map(function (c) {
      var n = num(c.days_left);
      return { href: UUID_RE.test(c.transaction_id || '') ? '#tx/' + c.transaction_id : '#reports/containers',
        title: [ltr(api, c.container_no), c.transaction_ref ? [' · ', ltr(api, c.transaction_ref)] : null],
        sub: api.fmtDate(c.return_deadline) + ' · ' + api.label('container_return_status', c.return_status),
        side: pill(api, n == null ? 'muted' : n < 0 ? 'danger' : n <= 3 ? 'warning' : 'muted', daysText(api, n) || t(api, 'none')) };
    });
    box.appendChild(api.el('div', { class: 'adm-cols adm-cols-3' }, [
      card(api, t(api, 'sec_appts'), mini(api, appts, t(api, 'empty_appts')), [linkBtn(api, t(api, 'see_schedule'), '#schedule')]),
      card(api, t(api, 'sec_trips'), mini(api, trips, t(api, 'empty_trips')), [linkBtn(api, t(api, 'see_report'), '#reports/trips')]),
      card(api, t(api, 'sec_ctr'), mini(api, ctrs, t(api, 'empty_ctr')), [linkBtn(api, t(api, 'see_report'), '#reports/containers')])
    ]));
  }

  /* ------------------------------------------------------------------
     Finance — dash_finance (official = Daftra-synced issued intents only)
     ------------------------------------------------------------------ */
  // issued invoices Daftra reported cancelled (G5 review item still open): outside the official figures, listed apart
  function cancelledNote(api, byCur) {
    var parts = currencies(byCur).map(function (c) { var x = obj(byCur[c]); return c + ' ' + count(api, x.count) + ' · ' + money(api, x.total, c); });
    return parts.length ? api.el('p', { class: 'text-xs text-muted dash-cancelled', 'data-dash-note': 'cancelled_pending', text: t(api, 'cancelled_pending', { v: parts.join(' — ') }) }) : null;
  }
  function paintFinance(api, box, d) {
    var si = obj(d.supplier_invoices), sis = obj(si.by_status), pay = obj(d.payables), costs = obj(d.costs), bill = obj(d.billing);
    var sync = obj(bill.sync), jobs = obj(bill.jobs), conn = obj(bill.connection), off = obj(d.official), unoff = obj(d.unofficial);
    // header note + mock banner
    var last = off.last_synced_at ? api.fmtDate(off.last_synced_at, true) : t(api, 'never_synced');
    box.appendChild(api.el('div', { class: 'alert alert-info dash-note', role: 'note', 'data-dash-note': 'official' }, [api.el('div', { text: t(api, 'fin_note', { d: last }) })]));
    if (conn.mode === 'mock') box.appendChild(api.el('div', { class: 'alert alert-warning dash-mock', role: 'note' }, [api.el('div', { text: t(api, 'mock_banner') })]));

    var byCur = obj(pay.by_currency), overdueCount = 0;
    currencies(byCur).forEach(function (c) { overdueCount += num(obj(byCur[c]).overdue_count) || 0; });
    box.appendChild(tiles(api, [
      { id: 'si_review', label: t(api, 'k_si_review'), value: si.needs_review, href: '#costs', tone: 'warning',
        foot: t(api, 'k_si_foot', { r: count(api, sis.received), u: count(api, sis.under_review), d: count(api, sis.disputed) }) },
      { id: 'payables_overdue', label: t(api, 'col_overdue_count'), value: currencies(byCur).length ? overdueCount : null, href: '#payables', tone: 'danger' },
      { id: 'due7', label: t(api, 'k_due7'), value: pay.due_7d_count, href: '#payables', tone: 'warning' },
      { id: 'cost_queue', label: t(api, 'k_cost_queue'), value: costs.review_queue, href: '#costs', tone: 'warning',
        foot: t(api, 'k_cost_foot', { a: count(api, costs.accruals_open), j: count(api, costs.adjustments_pending) }) },
      { id: 'bill_review', label: t(api, 'k_bill_review'), value: bill.review_open, href: '#billing/queue', tone: 'warning' },
      { id: 'bill_conflict', label: t(api, 'k_bill_conflict'), value: sync.conflict, href: '#billing', tone: 'danger',
        foot: t(api, 'k_bill_conflict_foot', { u: count(api, sync.unknown), e: count(api, sync.error) }) },
      { id: 'jobs_failed', label: t(api, 'k_jobs_failed'), value: (num(jobs.failed) == null && num(jobs.dead) == null) ? null : (num(jobs.failed) || 0) + (num(jobs.dead) || 0), href: '#billing', tone: 'danger',
        foot: t(api, 'k_jobs_foot', { q: count(api, jobs.queued), d: count(api, jobs.dead) }) }
    ]));

    // official (Daftra) — its own table, never mixed with the drafts below
    var offCur = obj(off.by_currency);
    var offRows = currencies(offCur).map(function (c) {
      var x = obj(offCur[c]);
      return tr(api, [ltr(api, c), count(api, x.issued_count), money(api, x.total, c), money(api, x.paid, c), money(api, x.outstanding, c)]);
    });
    var unCur = obj(unoff.open_lines_total_by_currency);
    var unRows = currencies(unCur).map(function (c) { return tr(api, [ltr(api, c), money(api, unCur[c], c)]); });
    box.appendChild(api.el('div', { class: 'adm-cols adm-cols-wide' }, [
      card(api, t(api, 'sec_official'), [
        table(api, [t(api, 'col_currency'), t(api, 'col_issued'), t(api, 'col_total'), t(api, 'col_paid'), t(api, 'col_outstanding')], offRows, t(api, 'official_empty')),
        cancelledNote(api, obj(obj(off.cancelled_pending_review).by_currency)),
        api.el('p', { class: 'text-xs text-muted dash-source', text: t(api, 'source_daftra') })
      ], [linkBtn(api, t(api, 'see_all'), '#billing')], 'dash-official'),
      card(api, t(api, 'sec_unofficial'), [
        api.el('p', { class: 'text-xs text-muted', text: t(api, 'unofficial_note') }),
        kv(api, [[t(api, 'k_open_intents'), count(api, unoff.open_intents)]]),
        table(api, [t(api, 'col_currency'), t(api, 'col_lines_total')], unRows, t(api, 'empty_list'))
      ], null, 'dash-unofficial')
    ]));

    var payRows = currencies(byCur).map(function (c) {
      var x = obj(byCur[c]);
      return tr(api, [ltr(api, c), money(api, x.open_amount, c), money(api, x.overdue_amount, c), count(api, x.open_count), count(api, x.overdue_count)]);
    });
    var connLine = conn.status ? t(api, 'conn_line', { s: lbl(api, 'daftra_connection_status', conn.status), m: lbl(api, 'daftra_mode', conn.mode), e: conn.sync_enabled ? t(api, 'sync_on') : t(api, 'sync_off') }) : null;
    box.appendChild(api.el('div', { class: 'adm-cols' }, [
      card(api, t(api, 'sec_payables'), table(api, [t(api, 'col_currency'), t(api, 'col_open_amount'), t(api, 'col_overdue_amount'), t(api, 'col_open_count'), t(api, 'col_overdue_count')],
        payRows, t(api, 'payables_empty')), [linkBtn(api, t(api, 'see_all'), '#payables')]),
      card(api, t(api, 'sec_billing'), [
        connLine ? kv(api, [[t(api, 'b_connection'), connLine]]) : null,
        api.el('h4', { class: 'dash-sub-title', text: t(api, 'b_intents') }), codeMap(api, bill.intents_by_status, 'bill_intent_status'),
        api.el('h4', { class: 'dash-sub-title', text: t(api, 'b_sync') }), codeMap(api, sync, 'bill_sync_state'),
        api.el('h4', { class: 'dash-sub-title', text: t(api, 'b_jobs') }), codeMap(api, jobs, 'bill_job_status')
      ], [linkBtn(api, t(api, 'see_all'), '#billing')])
    ]));
    box.appendChild(api.el('div', { class: 'adm-cols' }, [
      card(api, t(api, 'sec_fin_status'), codeMap(api, d.financial_status, 'financial_status')),
      card(api, t(api, 'margins_link'), [api.el('p', { class: 'text-sm text-muted', text: t(api, 'analytical') })], [linkBtn(api, t(api, 'see_all'), '#margins')], 'dash-margins')
    ]));
  }

  /* ------------------------------------------------------------------
     Management — dash_management
     ------------------------------------------------------------------ */
  function paintManagement(api, box, d) {
    var p = obj(d.period), rq = obj(d.requests), tx = obj(d.transactions), ct = obj(d.containers);
    if (p.from || p.to) box.appendChild(api.el('p', { class: 'text-sm text-muted dash-period', text: t(api, 'period', { f: p.from ? api.fmtDate(p.from) : t(api, 'none'), t: p.to ? api.fmtDate(p.to) : t(api, 'none') }) }));
    var cycle = num(tx.avg_cycle_days);
    box.appendChild(tiles(api, [
      { id: 'req_received', label: t(api, 'k_req_received'), value: rq.received, href: '#requests', foot: t(api, 'k_req_conv_foot', { c: count(api, rq.converted), r: count(api, rq.rejected) }) },
      { id: 'tx_created', label: t(api, 'k_tx_created'), value: tx.created, href: '#reports/transactions' + q({ date_field: 'created', from: p.from, to: p.to, branch_id: F.management.branch_id }) },
      // completed / closed IN THE PERIOD (first status event) and the cycle time have no list that reproduces them
      // (the lists filter by current status): plain tiles, not links
      { id: 'tx_completed', label: t(api, 'k_tx_completed'), value: tx.completed, href: false },
      { id: 'tx_closed', label: t(api, 'k_tx_closed'), value: tx.closed, href: false },
      { id: 'open_now', label: t(api, 'k_open_now'), value: tx.open_now, href: '#transactions' + q({ branchId: F.management.branch_id }), tone: 'brand' },
      { id: 'cycle', label: t(api, 'k_cycle'), value: cycle, display: cycle == null ? t(api, 'none') : (I && typeof I.fmtNumber === 'function' ? I.fmtNumber(cycle, { digits: 1 }) : cycle.toFixed(1)),
        href: false, foot: t(api, 'k_cycle_foot') },
      { id: 'overdue_now', label: t(api, 'k_overdue_now'), value: ct.overdue_now, href: '#reports/containers' + q({ overdue: 'true', branch_id: F.management.branch_id }), tone: 'danger' },
      { id: 'returned', label: t(api, 'k_returned'), value: ct.returned_in_period, href: '#reports/containers' + q({ date_field: 'returned_at', from: p.from, to: p.to, branch_id: F.management.branch_id }) },
      { id: 'alerts_now', label: t(api, 'k_alerts_now'), value: d.alerts_critical_now, href: '#alerts', tone: 'danger' }
    ]));
    var rows = arr(d.by_branch).map(function (b) {
      var name = (lang(api) === 'en' && b.branch_name_en) || b.branch_name || t(api, 'none');
      var nameNode = UUID_RE.test(b.branch_id || '') ? api.el('a', { href: '#transactions' + q({ branchId: b.branch_id }), text: name }) : name;
      return tr(api, [nameNode, count(api, b.open_now), count(api, b.created), count(api, b.completed), count(api, b.overdue_now)]);
    });
    var kids = [card(api, t(api, 'sec_by_branch'), table(api, [t(api, 'col_branch'), t(api, 'col_open_now'), t(api, 'col_created'), t(api, 'col_completed'), t(api, 'col_overdue')], rows))];
    var fin = d.finance && typeof d.finance === 'object' ? d.finance : null;
    if (fin) {
      var oc = obj(fin.official_by_currency), po = obj(fin.payables_overdue_by_currency);
      var curs = currencies(oc).concat(currencies(po).filter(function (c) { return !(c in oc); })).sort();
      var fr = curs.map(function (c) {
        var x = obj(oc[c]);
        return tr(api, [ltr(api, c), count(api, x.issued_count), money(api, x.total, c), money(api, x.paid, c), money(api, po[c], c)]);
      });
      var mHref = typeof fin.margin_link === 'string' && /^#[a-z]+$/.test(fin.margin_link) ? fin.margin_link : '#margins';
      kids.push(card(api, t(api, 'sec_mgmt_fin'), [
        table(api, [t(api, 'col_currency'), t(api, 'col_issued'), t(api, 'col_total'), t(api, 'col_paid'), t(api, 'col_payables_overdue')], fr, t(api, 'official_empty')),
        cancelledNote(api, obj(fin.cancelled_pending_review_by_currency)),
        api.el('p', { class: 'text-xs text-muted dash-source', text: t(api, 'source_daftra') })
      ], [linkBtn(api, t(api, 'margins_link'), mHref)], 'dash-mgmt-finance'));
    } else {
      kids.push(card(api, t(api, 'sec_mgmt_fin'), api.el('p', { class: 'text-sm text-muted', text: t(api, 'mgmt_fin_hidden') })));
    }
    box.appendChild(api.el('div', { class: 'adm-cols' }, kids));
  }

  /* ------------------------------------------------------------------
     Entry point
     ------------------------------------------------------------------ */
  var TABS = {
    ops: { fn: 'dashOps', title: 'ops_title', paint: paintOps },
    finance: { fn: 'dashFinance', title: 'fin_title', paint: paintFinance },
    management: { fn: 'dashManagement', title: 'mgmt_title', paint: paintManagement }
  };
  function render(root, tab, api) {
    var def = TABS[tab];
    root.textContent = '';
    if (!def || !api || typeof api.el !== 'function') return null;
    var M = api.MarsaApi;
    if (!M || typeof M[def.fn] !== 'function') { root.appendChild(alertNode(api, 'warning', apiMissingText(api, def.fn))); return null; }
    var seq = 0;
    var body = api.el('div', { class: 'dash-body', 'aria-live': 'polite' });
    function load() {
      var my = ++seq;
      body.textContent = '';
      body.setAttribute('aria-busy', 'true');
      body.appendChild(api.el('div', { class: 'adm-loading', role: 'status' }, [api.el('span', { class: 'adm-spinner', 'aria-hidden': 'true' }), t(api, 'loading')]));
      return Promise.resolve().then(function () { return M[def.fn](filtersFor(tab)); }).then(function (r) {
        if (my !== seq) return;
        body.textContent = '';
        body.removeAttribute('aria-busy');
        if (!r || r.error) {
          var e = r && r.error;
          if (rpcMissing(e)) { body.appendChild(alertNode(api, 'warning', apiMissingText(api, def.fn))); return; }
          var retry = api.el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: t(api, 'retry') });
          retry.addEventListener('click', load);
          body.appendChild(api.el('div', { class: 'alert alert-danger', role: 'alert' }, [api.el('div', { text: t(api, 'load_failed', { e: api.errText ? api.errText(e) : String((e && e.message) || '') }) }), retry]));
          return;
        }
        var d = obj(r.data);
        if (tab === 'finance') {
          // currencies the server reported become choices of the currency filter
          [obj(obj(d.payables).by_currency), obj(obj(d.official).by_currency)].forEach(function (m) {
            currencies(m).forEach(function (c) { if (SEEN_CUR.indexOf(c) === -1) SEEN_CUR.push(c); });
          });
        }
        def.paint(api, body, d);
        body.appendChild(api.el('p', { class: 'text-xs text-muted dash-foot' }, [t(api, 'scope_note'),
          d.generated_at ? ' · ' + t(api, 'generated_at', { d: api.fmtDate(d.generated_at, true) }) : null]));
      }, function (e) {
        if (my !== seq) return;
        body.textContent = '';
        body.removeAttribute('aria-busy');
        body.appendChild(alertNode(api, 'danger', t(api, 'load_failed', { e: api.errText ? api.errText(e) : String(e && e.message || e) })));
      });
    }
    root.appendChild(api.el('h3', { class: 'dash-title', text: t(api, def.title) }));
    root.appendChild(filterBar(api, tab, load));
    root.appendChild(body);
    return load();
  }

  window.MarsaDash = { version: 'g6a', tabs: ['ops', 'finance', 'management'], render: render, _dict: DICT };
})();

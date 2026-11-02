/* ==========================================================================
   مرسى | MARSA — classic page helper for the signed-in pages (STAGING)  →  window.MarsaShell
   --------------------------------------------------------------------------
   The signed-in pages (admin, platform, ocr, bulk-upload, portal, offline) use the
   ORIGINAL marketing layout again (topbar + site-header + drawer + demo banner +
   page-hero + .container sections + site-footer). This file builds NO chrome and
   never moves the page's DOM: it only offers shared services to the page scripts.

   Load order: config.js → i18n.js → assets/i18n/<page>.js → assets/i18n/app.js
               → main.js → supa.js → app-shell.js → pwa.js → <page>.js (all defer).

   Page id: <body data-app-page="…"> or <body data-page="admin|platform|ocr|bulk-upload|portal|offline">
   (else the file name). It decides the active nav item, the login link and the
   staff-org rule (admin / ocr / bulk work in a staff organization only).

   window.MarsaShell = {
     ready                      Promise → my_context data, or null (signed out / demo / offline / error); never rejects
     status()                   'loading' | 'ready' | 'signedout' | 'demo' | 'error' | 'offline'
     context() orgId() roles() can(roles[]) isClient() isPlatformAdmin()   R (role sets)  NAV (full definition)
     navItems(opts?)            role-filtered NAV, flat: [{id, href, label, group, groupLabel, page, local, badge?, count?}]
                                opts.group: only that group id · opts.local: only items on the current page
     setActive(navId)           aria-current="page" + .is-active on every [data-nav-id] in the page (others cleared)
     setBadge(navId, count?)    count badge (span.badge.badge-danger.nav-count) inside every [data-nav-id="navId"];
                                count 0/null removes it; no count = repaint the stored value
     badge(navId)               stored count or null
     setTitle(title, crumbs?)   document.title = "title | مرسى MARSA"; [data-shell-title] gets the text;
                                crumbs [{label, href?}|string] + the title become the trailing items of
                                the page-hero breadcrumb ([data-shell-crumbs] or .page-hero .breadcrumb ol)
     toast(text, tone?, opts?)  tone success|error|warning|info; opts {duration ms (0 = sticky), action:{label, onClick}} → {el, close()}
     confirm({title, text, okText, cancelText, danger}) → Promise<boolean>
     modal({title, body (Node|string), actions:[{label, value, primary, danger}], size}) → Promise<value|null>
     openSearch(q?) / openPalette(q?) / closePalette()   Ctrl/⌘K command palette (also "/" outside fields)
     orgs() → [{org_id, slug, name_ar, name_en, name}]   switchOrg(orgId) → Promise<{error}>
     user() → {name, email, roles:[labels]} | null
     signOut() signOutAll()     (signOutAll asks first)   refresh() → Promise (re-reads my_context)
     refreshAlertBadge() → Promise   open-alerts count on the 'alerts' nav item
     t(key, vars)               'app.*' strings
   }
   Declarative hooks (all optional, wired by delegation, safe to add later):
     [data-shell-search]        click opens the palette (an empty one is filled with icon + label + shortcut)
     [data-shell-org]           slot: a labelled <select class="form-control"> org switcher when the user has > 1 org
     [data-shell-user]          slot: name + roles text (strong + span.text-xs.text-muted)
     [data-shell-signout] / [data-shell-signout-all]   buttons (an empty one is filled with icon + label)
     [data-shell-session]       container shown only while signed in (status 'ready')
     [data-shell-staff]         shown only for staff of the active org (e.g. an «alerts» link)
     [data-shell-alerts]        empty <a data-nav-id="alerts"> is filled with icon + label; setBadge paints its count
     [data-shell-nav]           marks a page nav container (setActive / setBadge also work without it)
   Events: window 'marsa:shellready' {detail:{context}} once; 'marsa:contextchange' {detail:{context, status}};
     'marsa:orgchange' {detail:{orgId}} (dispatched by MarsaApi.setActiveOrg; the shell dispatches it itself
     only if supa.js did not); 'marsa:badgechange' {detail:{navId, count}}; listens to 'marsa:alertschange'.

   * There is no dark theme: the shell removes any html[data-theme] attribute and never sets one.
   * Role sets R mirror assets/js/admin.js (VIEWS / R); the UI only hides — RLS + guarded RPCs are the gate.
   * Server and user data go in with textContent / createElement only; innerHTML is used only for the
     static SVG icon strings below.
   * Demo mode (no Supabase config) or no MarsaApi: ready → null, no network calls.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document, html = doc.documentElement, body = doc.body;
  var api = window.MarsaApi;
  var I18N = window.MarsaI18n;
  var DICT = window.MarsaAppDict || { ar: {}, en: {} };

  // the original design has no dark theme: drop a stale attribute from an old cached <head> script
  if (html.getAttribute('data-theme')) html.removeAttribute('data-theme');

  /* ------------------------------------------------------------------
     Strings
     ------------------------------------------------------------------ */
  function lang() { return I18N && typeof I18N.lang === 'function' ? I18N.lang() : 'ar'; }
  function interp(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
  }
  function t(k, vars) {
    var key = 'app.' + k;
    if (I18N && typeof I18N.t === 'function') {
      var s = I18N.t(key, vars);
      if (s != null && s !== key) return s;
    }
    var d = (DICT[lang()] || {})[k];
    if (d == null) d = (DICT.ar || {})[k];
    return interp(d == null ? k : d, vars);
  }
  // NAV labels: a full i18n key (it.key, e.g. 'ops.nav_alerts') or 'app.nav_<id>'
  function keyLabel(key, vars, l) {
    if (!l && I18N && typeof I18N.t === 'function') {
      var s = I18N.t(key, vars);
      if (s != null && s !== key) return s;
    }
    var d = (OPS_NAV[l || lang()] || {})[key];
    if (d == null) d = OPS_NAV.ar[key];
    return interp(d == null ? key : d, vars);
  }
  function navLabel(it, l) {
    if (it.key) return keyLabel(it.key, null, l);
    return l ? ((DICT[l] || {})['nav_' + it.id] || (DICT.ar || {})['nav_' + it.id] || it.id) : t('nav_' + it.id);
  }
  function groupLabel(g) { return g.key ? keyLabel(g.key) : t(g.label); }
  // pages that ship a dictionary (<html data-i18n-page>) can switch language
  function canSwitchLang() { return !!(I18N && typeof I18N.setLang === 'function' && html.hasAttribute('data-i18n-page')); }

  /* ------------------------------------------------------------------
     Role model — mirrors assets/js/admin.js R / VIEWS (UI only)
     ------------------------------------------------------------------ */
  var R = {
    staff: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    opsWriter: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    transportWriter: ['clearance_staff', 'transport_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    finance: ['accountant', 'accounts_manager', 'admin'],
    contact: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    membersRead: ['admin', 'branch_manager', 'supervisor'],
    orgAdmin: ['admin'],
    auditRead: ['admin', 'supervisor'],
    // G4 (docs/online/G4_SPEC.md §Roles) — mirrors app.fin_read_roles / fin_write_roles / fin_approve_roles
    finRead: ['accountant', 'accounts_manager', 'branch_manager', 'supervisor', 'admin'],
    finWrite: ['accountant', 'accounts_manager', 'branch_manager', 'admin'],
    finApprove: ['accounts_manager', 'branch_manager', 'admin'],
    // G5 (docs/online/G5_SPEC.md §Roles) — mirrors app.bill_admin_roles (Daftra connection / catalog / tax settings)
    billAdmin: ['accounts_manager', 'admin'],
    // G6a (docs/online/G6A_SPEC.md §Roles) — mirrors app.mgmt_roles / app.trip_finance_roles
    mgmt: ['admin', 'supervisor', 'branch_manager'],
    tripFin: ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    // G6b (docs/online/G6B_SPEC.md §Roles) — mirrors app.msg_read_roles / msg_triage / msg_approve / msg_send / msg_lib / msg_admin
    msgRead: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    msgTriage: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'admin'],
    msgApprove: ['operations_manager', 'branch_manager', 'supervisor', 'admin'],
    msgSend: ['clearance_staff', 'operations_manager', 'branch_manager', 'admin'],
    msgLib: ['admin', 'operations_manager'],
    msgAdmin: ['admin']
  };
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];

  // NAV — single source for the pages' own nav (MarsaShell.navItems) and the palette's "go to" group.
  // allow: any of these roles in the active org · platform: is_platform_admin · client: client account
  // key: full i18n key of the label (G3 views: assets/i18n/ops.js, OPS_NAV below as fallback)
  // badge: live count kind ('alerts', see "Open-alerts badge"). The ops views' allow sets mirror
  // MarsaOps.views[id].allow (alerts / schedule / exceptions / parties: staff · requirements: orgAdmin).
  var NAV = [
    { id: 'work', label: 'grp_work', items: [
      { id: 'dashboard', href: 'admin.html#dashboard', icon: 'home', allow: R.staff },
      { id: 'requests', href: 'admin.html#requests', icon: 'inbox', allow: R.opsWriter },
      { id: 'transactions', href: 'admin.html#transactions', icon: 'layers', allow: R.staff },
      { id: 'clients', href: 'admin.html#clients', icon: 'users', allow: R.staff },
      { id: 'messages', href: 'admin.html#messages', icon: 'mail', allow: R.contact },
      { id: 'bulk', href: 'bulk-upload.html', icon: 'upload', allow: R.opsWriter },     // bulk-upload.js: ops writer
      { id: 'ocr', href: 'ocr.html', icon: 'scan', allow: R.staff },                     // ocr.js: isStaff
      { id: 'imports', href: 'admin.html#imports', icon: 'history', allow: R.opsWriter }
    ] },
    { id: 'ops', key: 'ops.nav_group', items: [
      { id: 'alerts', key: 'ops.nav_alerts', href: 'admin.html#alerts', icon: 'bell', allow: R.staff, badge: 'alerts' },
      { id: 'schedule', key: 'ops.nav_schedule', href: 'admin.html#schedule', icon: 'calendar', allow: R.staff },
      { id: 'exceptions', key: 'ops.nav_exceptions', href: 'admin.html#exceptions', icon: 'flag', allow: R.staff },
      { id: 'parties', key: 'ops.nav_parties', href: 'admin.html#parties', icon: 'truck', allow: R.staff }
    ] },
    // G6a reports & advanced search (assets/js/rpt/*.js views, allow 'staff')
    { id: 'insight', key: 'rpt.nav_group', items: [
      { id: 'search', key: 'rpt.nav_search', href: 'admin.html#search', icon: 'search', allow: R.staff },
      { id: 'reports', key: 'rpt.nav_reports', href: 'admin.html#reports', icon: 'report', allow: R.staff }
    ] },
    // G6b messaging (assets/js/msg/*.js views, allow 'msgRead'). The G2 contact-form inbox ('messages') stays in 'work'.
    // badge 'inbox' = unassigned + link-review threads (one listMsgThreads count read; hidden when it fails)
    { id: 'comms', key: 'msg.nav_group', items: [
      { id: 'inbox', key: 'msg.nav_inbox', href: 'admin.html#inbox', icon: 'chat', allow: R.msgRead, badge: 'inbox' },
      { id: 'contacts', key: 'msg.nav_contacts', href: 'admin.html#contacts', icon: 'book', allow: R.msgRead },
      { id: 'templates', key: 'msg.nav_templates', href: 'admin.html#templates', icon: 'template', allow: R.msgRead },
      { id: 'channels', key: 'msg.nav_channels', href: 'admin.html#channels', icon: 'antenna', allow: R.msgRead }
    ] },
    // G4 operating finance (assets/js/fin/*.js views, allow 'finRead')
    { id: 'finance', key: 'fin.nav_group', items: [
      { id: 'costs', key: 'fin.nav_costs', href: 'admin.html#costs', icon: 'receipt', allow: R.finRead },
      { id: 'payables', key: 'fin.nav_payables', href: 'admin.html#payables', icon: 'wallet', allow: R.finRead },
      { id: 'margins', key: 'fin.nav_margins', href: 'admin.html#margins', icon: 'chart', allow: R.finRead },
      { id: 'demurrage', key: 'fin.nav_demurrage', href: 'admin.html#demurrage', icon: 'clock', allow: R.finRead },
      // G5 billing & Daftra (assets/js/bill/*.js views, allow 'finRead')
      { id: 'billing', key: 'bill.nav_billing', href: 'admin.html#billing', icon: 'sync', allow: R.finRead },
      { id: 'daftra', key: 'bill.nav_daftra', href: 'admin.html#daftra', icon: 'link', allow: R.finRead }
    ] },
    { id: 'manage', label: 'grp_manage', items: [
      { id: 'org', href: 'admin.html#org', icon: 'building', allow: R.orgAdmin },
      { id: 'branches', href: 'admin.html#branches', icon: 'branch', allow: R.orgAdmin },
      { id: 'members', href: 'admin.html#members', icon: 'userPlus', allow: R.membersRead },
      { id: 'requirements', key: 'ops.nav_requirements', href: 'admin.html#requirements', icon: 'listCheck', allow: R.orgAdmin },
      { id: 'audit', href: 'admin.html#audit', icon: 'shield', allow: R.auditRead },
      { id: 'errors', href: 'admin.html#errors', icon: 'alert', allow: R.orgAdmin }
    ] },
    { id: 'platform', label: 'grp_platform', items: [
      { id: 'platform', href: 'platform.html', icon: 'globe', platform: true }
    ] },
    { id: 'client', label: 'grp_client', items: [
      { id: 'portal', href: 'portal.html', icon: 'grid', client: true },
      { id: 'request', href: 'request.html', icon: 'filePlus', client: true },
      { id: 'tracking', href: 'tracking.html', icon: 'route', client: true }
    ] },
    // G7 user guides (help.html renders docs/guide/<lang>/<id>.md). One item for every audience:
    // staff → the guide index, client → #client-portal, platform admin → #platform (first match wins, see itemHref)
    { id: 'support', key: 'app.grp_support', items: [
      { id: 'help', key: 'app.nav_help', href: 'help.html', icon: 'help',
        audiences: [{ allow: R.staff, href: 'help.html' }, { client: true, href: 'help.html#client-portal' }, { platform: true, href: 'help.html#platform' }] }
    ] }
  ];
  // admin.js detail routes (#tx/<id> …) belong to their list view
  var ADMIN_ALIAS = { tx: 'transactions', request: 'requests', client: 'clients', import: 'imports' };
  var PAGE_NAV = { platform: 'platform', ocr: 'ocr', bulk: 'bulk', portal: 'portal', help: 'help', offline: null };
  var OPS_NAV = {
    ar: { 'ops.nav_group': 'العمليات', 'ops.nav_alerts': 'التنبيهات', 'ops.nav_schedule': 'الجدول اليومي', 'ops.nav_exceptions': 'الاستثناءات',
      'ops.nav_parties': 'الجهات والناقلون', 'ops.nav_requirements': 'قواعد المستندات', 'ops.nav_alerts_badge': 'التنبيهات المفتوحة: {n}',
      'fin.nav_group': 'المالية التشغيلية', 'fin.nav_costs': 'فواتير الموردين', 'fin.nav_payables': 'المستحقات والمدفوعات',
      'fin.nav_margins': 'الهامش والتكاليف', 'fin.nav_demurrage': 'الأرضيات والغرامات',
      'bill.nav_billing': 'الفوترة ودفترة', 'bill.nav_daftra': 'إعداد دفترة',
      'rpt.nav_group': 'التقارير والبحث', 'rpt.nav_search': 'البحث المتقدم', 'rpt.nav_reports': 'التقارير',
      'rpt.cmdk_advanced': 'بحث متقدم عن «{q}»…',
      'msg.nav_group': 'المراسلات', 'msg.nav_inbox': 'صندوق المراسلات', 'msg.nav_contacts': 'جهات الاتصال',
      'msg.nav_templates': 'القوالب والتعليمات', 'msg.nav_channels': 'القنوات', 'msg.nav_inbox_badge': 'محادثات غير مسندة أو تحتاج مراجعة ربط: {n}',
      'app.grp_support': 'المساعدة', 'app.nav_help': 'دليل الاستخدام' },
    en: { 'ops.nav_group': 'Operations', 'ops.nav_alerts': 'Alerts', 'ops.nav_schedule': 'Daily schedule', 'ops.nav_exceptions': 'Exceptions',
      'ops.nav_parties': 'Parties & carriers', 'ops.nav_requirements': 'Document rules', 'ops.nav_alerts_badge': 'Open alerts: {n}',
      'fin.nav_group': 'Operating finance', 'fin.nav_costs': 'Supplier invoices', 'fin.nav_payables': 'Payables & payments',
      'fin.nav_margins': 'Margins & costs', 'fin.nav_demurrage': 'Storage & demurrage',
      'bill.nav_billing': 'Billing & Daftra', 'bill.nav_daftra': 'Daftra settings',
      'rpt.nav_group': 'Reports & search', 'rpt.nav_search': 'Advanced search', 'rpt.nav_reports': 'Reports',
      'rpt.cmdk_advanced': 'Advanced search for "{q}"…',
      'msg.nav_group': 'Communications', 'msg.nav_inbox': 'Inbox', 'msg.nav_contacts': 'Contacts',
      'msg.nav_templates': 'Templates & instructions', 'msg.nav_channels': 'Channels', 'msg.nav_inbox_badge': 'Unassigned or link-review conversations: {n}',
      'app.grp_support': 'Help', 'app.nav_help': 'User guide' }
  };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ------------------------------------------------------------------
     Page id
     ------------------------------------------------------------------ */
  var PAGE_ALIAS = { 'bulk-upload': 'bulk', bulk: 'bulk', admin: 'admin', platform: 'platform', ocr: 'ocr', portal: 'portal', offline: 'offline', login: 'login', help: 'help' };
  function fileName() { return (location.pathname.split('/').pop() || 'index.html'); }
  var PAGE = (function () {
    var v = body ? (body.getAttribute('data-app-page') || body.getAttribute('data-page') || '') : '';
    if (!v) v = fileName().replace(/\.html?$/i, '');
    return PAGE_ALIAS[v] || v;
  })();
  // staff pages work in a staff org only (same rule as admin.js staffOrgs)
  var STAFF_PAGE = PAGE === 'admin' || PAGE === 'ocr' || PAGE === 'bulk';
  var PALETTE_ON = PAGE !== 'offline' && PAGE !== 'login';

  /* ------------------------------------------------------------------
     Icons (static, trusted markup; 24×24 stroke — style.css .icon)
     ------------------------------------------------------------------ */
  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 9h8M8 12h8M8 15h5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 21v-4h6v4M8 7h2M14 7h2M8 11h2M14 11h2"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
    userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
    languages: '<path d="M4 5h8M8 3v2M5.5 5c.8 3.5 3.3 6 6.5 7.5M10.5 5c-.8 3.5-3.3 6-6.5 7.5"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    warning: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    container: '<rect x="2" y="7" width="20" height="11" rx="1"/><path d="M6 7v11M10 7v11M14 7v11M18 7v11"/>',
    signin: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4M18 12H8"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    truck: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>',
    listCheck: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
    // G4 finance
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    wallet: '<path d="M4 7a2 2 0 0 1 2-2h12v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    // G5 billing & Daftra
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    // G6a reports
    report: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 17v-3M12 17v-6M15 17v-2"/>',
    // G6b messaging
    chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>',
    book: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11"/><circle cx="11.5" cy="9" r="2"/><path d="M8.5 13.5a3 3 0 0 1 6 0"/>',
    template: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11M11 13h7M11 16h5"/>',
    antenna: '<circle cx="12" cy="11" r="1.6"/><path d="M12 12.6V21M8.5 7.5a5 5 0 0 0 0 7M15.5 7.5a5 5 0 0 1 0 7M5.6 4.6a9 9 0 0 0 0 12.8M18.4 4.6a9 9 0 0 1 0 12.8"/>',
    // G7 help / user guide
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2.3-2.5 4"/><path d="M12 17.3h.01"/>'
  };
  function icon(name, cls) {
    var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.innerHTML = ICONS[name] || ICONS.info;
    return s;
  }

  /* ------------------------------------------------------------------
     DOM helpers
     ------------------------------------------------------------------ */
  function el(tag, attrs, kids) {
    var n = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function qsa(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  var uidN = 0;
  function uid(p) { return (p || 'shell') + '-' + (++uidN); }
  function isVisible(n) { return !!n && !n.hidden && !n.closest('[hidden]') && !n.closest('[inert]'); }
  // calls MarsaApi safely: a missing method, a sync throw or a rejection become {data:null, error}
  function call(fn) {
    try { return Promise.resolve(fn()).then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: e || {} }; }); }
    catch (e) { return Promise.resolve({ data: null, error: e || {} }); }
  }
  function errMsg(e) {
    if (!e) return '';
    if (api && typeof api.errorMessage === 'function') { try { return api.errorMessage(e); } catch (x) { /* fall through */ } }
    return String(e.message || e);
  }
  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* very old browsers */ }
  }
  function onReady(fn) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn); else fn(); }

  /* ------------------------------------------------------------------
     Focus traps (modal, palette) — the top one handles Tab / Esc
     ------------------------------------------------------------------ */
  var traps = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(root) { return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), isVisible); }
  function trap(root, onEscape) {
    var entry = { root: root, onEscape: onEscape, prev: doc.activeElement };
    traps.push(entry);
    return function release(restore) {
      var i = traps.indexOf(entry);
      if (i !== -1) traps.splice(i, 1);
      if (restore !== false && entry.prev && entry.prev.focus && doc.contains(entry.prev)) { try { entry.prev.focus(); } catch (e) { /* ignore */ } }
    };
  }
  doc.addEventListener('keydown', function (e) {
    var top = traps[traps.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (top.onEscape) top.onEscape(); return; }
    if (e.key !== 'Tab') return;
    var modalDlg = modalDialog();
    if (modalDlg && !modalDlg.contains(top.root)) return;   // a page's native modal <dialog> owns focus
    var list = focusables(top.root);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1], a = doc.activeElement;
    if (!top.root.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }, true);
  // a page's native modal <dialog> (showModal) sits in the top layer: overlays opened under it would be hidden
  function modalDialog() {
    try { return doc.querySelector('dialog:modal'); } catch (e) { return doc.querySelector('dialog[open]'); }   // no :modal support
  }
  function topLayerModalOpen() { return !!modalDialog(); }
  // an open overlay makes the page behind it inert (top-level body children: header, main, footer,
  // a lower overlay…); the returned function restores only the ones this call changed.
  // Toasts stay live; an open native <dialog> is left alone (it owns the top layer).
  function inertBehind(keep) {
    var set = [];
    Array.prototype.forEach.call(doc.body ? doc.body.children : [], function (n) {
      if (n === keep || n.hasAttribute('inert') || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName) ||
          n.classList.contains('toast-stack') || (n.tagName === 'DIALOG' && n.open)) return;
      n.setAttribute('inert', ''); set.push(n);
    });
    return function () { set.forEach(function (n) { n.removeAttribute('inert'); }); set = []; };
  }
  function appModalOpen() { return !!doc.querySelector('.app-modal-backdrop'); }
  // html.app-lock: no page scroll behind an overlay (also used by assets/js/ops/alerts.js)
  function lockScroll() {
    html.classList.toggle('app-lock', !!doc.querySelector('.app-modal-backdrop') || !!(paletteEl && !paletteEl.hidden));
  }

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  var S = {
    status: 'loading',          // loading | ready | signedout | demo | error | offline
    ctx: null, session: null, orgId: null, roles: [], memberships: [],
    active: null, manualActive: false,
    title: null, crumbs: []
  };
  function canAny(roles) { return S.roles.some(function (r) { return roles.indexOf(r) !== -1; }); }
  function isPlatform() { return !!(S.ctx && S.ctx.is_platform_admin); }
  function isClient() {
    if (!S.ctx) return false;
    if (S.roles.indexOf('client') !== -1 || (S.ctx.clients || []).length > 0) return true;
    // a signed-in account without any staff or platform role is a (not yet linked) client account
    var anyStaff = (S.ctx.memberships || []).some(function (m) { return R.staff.indexOf(m.role) !== -1; });
    return !anyStaff && !isPlatform();
  }
  // G7: an item with audiences[] (help) is shown to the first audience that matches, with that audience's href
  function audienceOf(it) {
    var a = it.audiences || [];
    for (var i = 0; i < a.length; i++) {
      if (a[i].platform ? isPlatform() : a[i].client ? isClient() : (a[i].allow ? canAny(a[i].allow) : false)) return a[i];
    }
    return null;
  }
  function itemHref(it) { var a = it.audiences ? audienceOf(it) : null; return a && a.href ? a.href : it.href; }
  function itemVisible(it) {
    if (S.status !== 'ready') return false;
    if (it.audiences) return !!audienceOf(it);
    if (it.platform) return isPlatform();
    if (it.client) return isClient();
    return it.allow ? canAny(it.allow) : true;
  }
  function visibleNav() {
    return NAV.map(function (g) { return { id: g.id, label: g.label, key: g.key, items: g.items.filter(itemVisible) }; })
      .filter(function (g) { return g.items.length; });
  }
  function navItem(id) {
    for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i].items.length; j++) if (NAV[i].items[j].id === id) return NAV[i].items[j];
    return null;
  }
  function hrefPage(href) { return String(href || '').split('#')[0] || fileName(); }
  function navItems(opts) {
    opts = opts || {};
    var here = fileName(), out = [];
    visibleNav().forEach(function (g) {
      if (opts.group && opts.group !== g.id) return;
      var gl = groupLabel(g);
      g.items.forEach(function (it) {
        var href = itemHref(it), page = hrefPage(href), local = page === here;
        if (opts.local && !local) return;
        var row = { id: it.id, href: href, label: navLabel(it), group: g.id, groupLabel: gl, page: page, local: local, icon: it.icon };
        if (it.badge) { row.badge = it.badge; row.count = badgeValue(it.id); }
        out.push(row);
      });
    });
    return out;
  }
  function hasStaffRole(orgId) {
    return !!S.ctx && (S.ctx.memberships || []).some(function (m) { return m.org_id === orgId && R.staff.indexOf(m.role) !== -1; });
  }
  function orgs() {
    var map = {}, list = [];
    function add(id, slug, ar, en) {
      if (!id) return;
      if (!map[id]) { map[id] = { org_id: id, slug: slug, name_ar: ar, name_en: en }; list.push(map[id]); }
      else { map[id].name_ar = ar || map[id].name_ar; map[id].name_en = en || map[id].name_en; }
    }
    if (!S.ctx) return list;
    (S.ctx.memberships || []).forEach(function (m) { add(m.org_id, m.org_slug, m.org_name_ar, m.org_name_en); });
    (Array.isArray(S.ctx.organizations) ? S.ctx.organizations : []).forEach(function (o) { add(o.org_id, o.slug, o.name_ar, o.name_en); });
    if (STAFF_PAGE) {
      var staff = list.filter(function (o) { return hasStaffRole(o.org_id); });
      if (staff.length) return staff;
    }
    return list;
  }
  // the org a staff page should use for a wanted id: itself when it is a staff org (or not a staff
  // page / no staff org at all), else the configured-slug staff org, else the first staff org
  function staffPick(id) {
    if (!STAFF_PAGE || !S.ctx || (id && hasStaffRole(id))) return id;
    var list = orgs().filter(function (o) { return hasStaffRole(o.org_id); });
    if (!list.length) return id;
    var slug = api && api.orgSlug;
    return (list.filter(function (o) { return o.slug === slug; })[0] || list[0]).org_id;
  }
  function orgName(o) { return o ? ((lang() === 'en' && o.name_en) || o.name_ar || o.name_en || o.slug || '') : ''; }
  function activeOrg() { return orgs().filter(function (o) { return o.org_id === S.orgId; })[0] || null; }
  function computeRoles() {
    var ms = S.ctx ? (S.ctx.memberships || []).filter(function (m) { return m.org_id === S.orgId; }) : [];
    S.memberships = ms;
    S.roles = ms.map(function (m) { return m.role; }).filter(function (r, i, a) { return r && a.indexOf(r) === i; });
    S.roles.sort(function (a, b) { return ROLE_RANK.indexOf(b) - ROLE_RANK.indexOf(a); });
  }
  function loginHref() { return PAGE === 'portal' ? 'login.html#client' : 'login.html#staff'; }

  /* ------------------------------------------------------------------
     Context
     ------------------------------------------------------------------ */
  function loadContext(force) {
    if (PAGE === 'offline') { S.status = 'offline'; S.ctx = null; S.roles = []; return Promise.resolve(null); }
    if (!api || typeof api.isOnline !== 'function' || !api.isOnline()) {
      S.status = 'demo'; S.ctx = null; S.roles = [];
      return Promise.resolve(null);
    }
    return call(function () { return api.getSession(); }).then(function (s) {
      if (s.error || !s.data) { S.status = s.error ? 'error' : 'signedout'; S.ctx = null; S.session = null; S.roles = []; return null; }
      S.session = s.data;
      return call(function () { return api.myContext(force); }).then(function (c) {
        if (c.error || !c.data) {
          S.status = c.error && c.error.code === 'MRS_AUTH_REQUIRED' ? 'signedout' : 'error';
          S.ctx = null; S.roles = []; return null;
        }
        S.ctx = c.data;
        return call(function () { return api.activeOrgId(); }).then(function (o) {
          var v = o && !o.error ? o.data : null;
          S.orgId = typeof v === 'string' ? v : null;
          var pick = staffPick(S.orgId);
          if (pick !== S.orgId) {
            // store the staff org so supa.js (orgId() for writes) and the page agree; the
            // 'marsa:orgchange' it fires is a no-op here because S.orgId already matches
            S.orgId = pick;
            if (typeof api.setActiveOrg === 'function') call(function () { return api.setActiveOrg(pick); });
          }
          computeRoles();
          S.status = 'ready';
          return S.ctx;
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     Page nav: active item + count badges ([data-nav-id] anywhere in the page)
     ------------------------------------------------------------------ */
  function navNodes(id) {
    return qsa(id ? '[data-nav-id="' + String(id).replace(/[^a-z0-9_-]/gi, '') + '"]' : '[data-nav-id]')
      .filter(function (n) { return !(paletteEl && paletteEl.contains(n)); });
  }
  function markActive() {
    navNodes().forEach(function (a) {
      var on = !!S.active && a.getAttribute('data-nav-id') === S.active;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else if (a.getAttribute('aria-current') === 'page') a.removeAttribute('aria-current');
    });
  }
  function detectActive() {
    if (PAGE === 'admin') {
      var h = (location.hash || '').replace(/^#/, '').split(/[/?]/)[0] || 'dashboard';
      h = ADMIN_ALIAS[h] || h;
      return navItem(h) ? h : 'dashboard';
    }
    return PAGE_NAV[PAGE] || null;
  }
  function setActive(id) {
    S.active = id && navItem(id) ? id : null;
    S.manualActive = true;
    markActive();
  }
  window.addEventListener('hashchange', function () {
    if (PAGE !== 'admin') return;
    S.active = detectActive(); S.manualActive = false;
    markActive();
  });

  // counts per nav id ({navId: {count, org}}); a count belongs to the org it was read for
  var counts = {};
  function badgeValue(id) {
    var c = counts[id];
    return c && (c.org == null || c.org === S.orgId) && c.count ? c.count : null;
  }
  function paintBadge(id) {
    var n = badgeValue(id), it = navItem(id);
    var label = it ? navLabel(it) : '';
    navNodes(id).forEach(function (a) {
      var b = a.querySelector('.nav-count');
      if (!n) {
        if (b) b.parentNode.removeChild(b);
        if (a.hasAttribute('data-shell-badge-label')) { a.removeAttribute('aria-label'); a.removeAttribute('data-shell-badge-label'); }
        return;
      }
      var txt = n > 99 ? '99+' : String(n);
      if (!b) { b = el('span', { class: 'badge badge-danger nav-count', 'aria-hidden': 'true' }); a.appendChild(b); }
      b.textContent = txt;
      if (label) {
        var desc = id === 'alerts' ? keyLabel('ops.nav_alerts_badge', { n: n }) : (id === 'inbox' ? keyLabel('msg.nav_inbox_badge', { n: n }) : t('badge_count', { n: n }));
        a.setAttribute('aria-label', label + ' — ' + desc);
        a.setAttribute('data-shell-badge-label', '');
      }
    });
  }
  function setBadge(id, count, org) {
    if (!id) return;
    if (arguments.length >= 2) {
      var n = count == null || isNaN(+count) ? null : Math.max(0, Math.floor(+count));
      counts[id] = { count: n, org: org === undefined ? S.orgId : org };
      emit('marsa:badgechange', { navId: id, count: n });
    }
    paintBadge(id);
  }

  /* ------------------------------------------------------------------
     Open-alerts badge (NAV item 'alerts'): MarsaApi.listAlerts({status:'open', count_only:true})
     for staff of the active org — on load, on org change, on 'marsa:alertschange' (dispatched by
     the ops views after ack / resolve / refresh) and every 5 minutes while the page is visible.
     A failed read hides the badge.
     ------------------------------------------------------------------ */
  var BADGE_MS = 5 * 60 * 1000;
  var alertPoll = { seq: 0, at: 0, timer: null };
  function badgeCount(d) {
    if (typeof d === 'number') return d;
    if (d && typeof d === 'object' && !Array.isArray(d)) { var c = d.count != null ? d.count : d.total; return c != null && !isNaN(+c) ? +c : null; }
    return Array.isArray(d) ? d.length : null;
  }
  function refreshBadge() {
    var seq = ++alertPoll.seq, org = S.orgId;
    var it = navItem('alerts');
    if (S.status !== 'ready' || !org || !it || !itemVisible(it) || !api || typeof api.listAlerts !== 'function') {
      setBadge('alerts', null, org); return Promise.resolve(null);
    }
    return call(function () { return api.listAlerts({ status: 'open', count_only: true }); }).then(function (r) {
      if (seq !== alertPoll.seq || org !== S.orgId) return null;   // a newer refresh / another org won
      alertPoll.at = Date.now();
      var n = r.error ? null : badgeCount(r.data);
      setBadge('alerts', n, org);
      return n;
    });
  }
  function armBadge() {
    if (alertPoll.timer) clearInterval(alertPoll.timer);
    alertPoll.timer = setInterval(function () { if (!doc.hidden) { refreshBadge(); refreshInboxBadge(); } }, BADGE_MS);
  }
  window.addEventListener('marsa:alertschange', function () { refreshBadge(); });

  /* G6b inbox badge (NAV item 'inbox'): unassigned + link-review threads of the active org, from ONE
     MarsaApi.listMsgThreads({box:'unassigned', limit:1}) read (its counts.by_box) — on load, on org change,
     on 'marsa:inboxchange' (dispatched by the msg views) and with the alerts poll. Hidden when the read
     fails (e.g. the G6b migration is not applied yet) or the role has no msgRead. */
  var inboxPoll = { seq: 0 };
  function inboxCount(d) {
    var b = d && d.counts && d.counts.by_box;
    if (!b || typeof b !== 'object') return null;
    // review fix: 'attention' counts a thread that is both unassigned and in link review ONCE (older servers: the sum)
    if (b.attention != null && !isNaN(+b.attention)) return +b.attention;
    var u = +b.unassigned, r = +b.review;
    if (isNaN(u) && isNaN(r)) return null;
    return (isNaN(u) ? 0 : u) + (isNaN(r) ? 0 : r);
  }
  function refreshInboxBadge() {
    var seq = ++inboxPoll.seq, org = S.orgId;
    var it = navItem('inbox');
    if (S.status !== 'ready' || !org || !it || !itemVisible(it) || !api || typeof api.listMsgThreads !== 'function') {
      setBadge('inbox', null, org); return Promise.resolve(null);
    }
    return call(function () { return api.listMsgThreads({ box: 'unassigned', limit: 1, orgId: org }); }).then(function (r) {
      if (seq !== inboxPoll.seq || org !== S.orgId) return null;
      var n = r.error ? null : inboxCount(r.data);
      setBadge('inbox', n, org);
      return n;
    });
  }
  window.addEventListener('marsa:inboxchange', function () { refreshInboxBadge(); });
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden && alertPoll.at && Date.now() - alertPoll.at >= BADGE_MS) { refreshBadge(); refreshInboxBadge(); } });

  /* ------------------------------------------------------------------
     Title + breadcrumb (page-hero)
     ------------------------------------------------------------------ */
  function crumbsHost() { return doc.querySelector('[data-shell-crumbs]') || doc.querySelector('.page-hero .breadcrumb ol'); }
  function renderTitle() {
    var title = S.title;
    if (title) doc.title = title + ' | ' + t('title_suffix');
    qsa('[data-shell-title]').forEach(function (n) {
      if (!n.hasAttribute('data-shell-title-orig')) n.setAttribute('data-shell-title-orig', n.textContent);
      n.textContent = title != null ? title : n.getAttribute('data-shell-title-orig');
    });
    var ol = crumbsHost();
    if (!ol) return;
    qsa('[data-shell-crumb]', ol).forEach(function (n) { n.parentNode.removeChild(n); });
    var statics = Array.prototype.filter.call(ol.children, function (li) { return li.getAttribute('aria-current') === 'page'; });
    var items = [];
    (S.crumbs || []).forEach(function (c) {
      var label = typeof c === 'string' ? c : (c && c.label);
      if (!label) return;
      var href = c && typeof c === 'object' && c.href ? String(c.href) : null;
      if (href && /^\s*(javascript|data|vbscript):/i.test(href)) href = null;
      items.push({ label: String(label), href: href });
    });
    if (title != null && (!items.length || items[items.length - 1].label !== title)) items.push({ label: title, href: null });
    if (!items.length) { statics.forEach(function (li) { li.hidden = false; }); return; }
    // a static current item with the same text as the first crumb stays as that crumb's place
    statics.forEach(function (li) { li.hidden = true; });
    items.forEach(function (c, i) {
      var last = i === items.length - 1;
      var li = el('li', { 'data-shell-crumb': '', 'aria-current': last ? 'page' : null });
      if (c.href && !last) li.appendChild(el('a', { href: c.href, text: c.label })); else li.textContent = c.label;
      ol.appendChild(li);
    });
  }
  function setTitle(title, crumbs) {
    S.title = title == null ? null : String(title);
    S.crumbs = Array.isArray(crumbs) ? crumbs.slice(0, 6) : [];
    onReady(renderTitle);
  }

  /* ------------------------------------------------------------------
     Toasts (shared style.css .toast-stack with main.js Marsa.toast)
     ------------------------------------------------------------------ */
  var TONES = { success: 1, error: 1, warning: 1, info: 1 };
  function toastStack() {
    var s = doc.querySelector('.toast-stack');
    if (!s) {
      s = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
      body.appendChild(s);
    }
    return s;
  }
  function toast(text, tone, opts) {
    opts = opts || {};
    tone = tone === 'danger' ? 'error' : (TONES[tone] ? tone : 'info');
    var n = el('div', { class: 'toast toast-' + tone + ' shell-toast', role: tone === 'error' ? 'alert' : null });
    n.appendChild(icon(tone));
    n.appendChild(el('span', { class: 'toast-text', text: text == null ? '' : String(text) }));
    var closed = false, timer = null;
    function close() {
      if (closed) return; closed = true;
      if (timer) clearTimeout(timer);
      n.classList.add('is-leaving');
      setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 300);
    }
    if (opts.action && opts.action.label) {
      var ab = el('button', { class: 'toast-action', type: 'button', text: opts.action.label });
      ab.addEventListener('click', function () { try { if (opts.action.onClick) opts.action.onClick(); } finally { close(); } });
      n.appendChild(ab);
    }
    var cb = el('button', { class: 'toast-close', type: 'button', 'aria-label': t('toast_close') }, [icon('x')]);
    cb.addEventListener('click', close);
    n.appendChild(cb);
    toastStack().appendChild(n);
    var dur = opts.duration != null ? opts.duration : (tone === 'error' ? 8000 : 5000);
    function arm() { if (dur > 0 && !closed) timer = setTimeout(close, dur); }
    n.addEventListener('mouseenter', function () { if (timer) clearTimeout(timer); });
    n.addEventListener('mouseleave', arm);
    n.addEventListener('focusin', function () { if (timer) clearTimeout(timer); });
    arm();
    return { el: n, close: close };
  }

  /* ------------------------------------------------------------------
     Modal + confirm (.app-modal-backdrop > .app-modal, styled like the original admin dialog)
     ------------------------------------------------------------------ */
  function modal(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var titleId = uid('modal-t'), bodyId = uid('modal-b');
      var backdrop = el('div', { class: 'app-modal-backdrop' });
      var box = el('div', {
        class: 'app-modal' + (o.size === 'sm' ? ' is-sm' : o.size === 'lg' ? ' is-lg' : ''),
        role: o.alert ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId
      });
      var head = el('div', { class: 'app-modal-head' });
      if (o.danger) head.appendChild(el('span', { class: 'app-modal-icon', 'aria-hidden': 'true' }, [icon('warning')]));
      head.appendChild(el('h2', { class: 'app-modal-title', id: titleId, text: o.title || t('confirm_title') }));
      var bodyBox = el('div', { class: 'app-modal-body', id: bodyId });
      if (o.body && o.body.nodeType) bodyBox.appendChild(o.body);
      else if (o.body != null || o.text != null) bodyBox.appendChild(el('p', { text: String(o.body != null ? o.body : o.text) }));
      var foot = el('div', { class: 'app-modal-foot' });
      var done = false, release = null, initial = null, unInert = null;
      function finish(v) {
        if (done) return; done = true;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (unInert) unInert();
        if (release) release();
        lockScroll();
        resolve(v);
      }
      (o.actions || [{ label: t('ok'), value: true, primary: true }]).forEach(function (a) {
        var b = el('button', { class: 'btn ' + (a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-ghost'), type: 'button', text: a.label });
        b.addEventListener('click', function () { finish(a.value === undefined ? null : a.value); });
        foot.appendChild(b);
        if (a.autofocus || (!initial && a.primary && !o.danger) || (o.danger && a.value === false)) initial = b;
      });
      box.appendChild(head); box.appendChild(bodyBox); box.appendChild(foot);
      backdrop.appendChild(box);
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && o.dismissible !== false) finish(o.dismissValue === undefined ? null : o.dismissValue); });
      body.appendChild(backdrop);
      unInert = inertBehind(backdrop);
      lockScroll();
      release = trap(box, function () { if (o.dismissible !== false) finish(o.dismissValue === undefined ? null : o.dismissValue); });
      setTimeout(function () { (initial || foot.lastChild || box).focus(); }, 0);
    });
  }
  function confirmDialog(o) {
    o = o || {};
    return modal({
      title: o.title || t('confirm_title'), body: o.text != null ? o.text : o.body, alert: true, danger: !!o.danger, size: 'sm', dismissValue: false,
      actions: [
        { label: o.okText || t('ok'), value: true, primary: !o.danger, danger: !!o.danger },
        { label: o.cancelText || t('cancel'), value: false }
      ]
    }).then(function (v) { return v === true; });
  }

  /* ------------------------------------------------------------------
     Language (palette action) · org switch · sign out
     ------------------------------------------------------------------ */
  function switchLang(l) {
    l = l === 'en' ? 'en' : 'ar';
    if (canSwitchLang() && I18N.lang() !== l) I18N.setLang(l);   // fires marsa:langchange
    if (S.status === 'ready' && api && typeof api.setMyLocale === 'function') call(function () { return api.setMyLocale(l); });
  }
  var orgEventSeen = false;
  function switchOrg(id) {
    var o = orgs().filter(function (x) { return x.org_id === id; })[0];
    if (!o) return Promise.resolve({ error: { message: t('org_unknown') } });
    if (o.org_id === S.orgId) return Promise.resolve({ error: null });
    if (!api || typeof api.setActiveOrg !== 'function') return Promise.resolve({ error: { message: t('org_unknown') } });
    orgEventSeen = false;
    var before = S.orgId;
    return call(function () { return api.setActiveOrg(o.org_id); }).then(function (r) {
      if (r.error) { toast(t('org_failed', { msg: errMsg(r.error) }), 'error'); renderOrgSlots(); return { error: r.error }; }
      if (!orgEventSeen && before !== o.org_id) emit('marsa:orgchange', { orgId: o.org_id });   // older supa.js
      toast(t('org_switched', { name: orgName(o) }), 'success');
      return { error: null };
    });
  }
  window.addEventListener('marsa:orgchange', function (e) {
    orgEventSeen = true;
    var id = e && e.detail && e.detail.orgId;
    if (!id || id === S.orgId) return;
    S.orgId = id;
    computeRoles();
    renderSlots();
    markActive();
    Object.keys(counts).forEach(paintBadge);
    refreshBadge(); refreshInboxBadge();
  });
  // another tab changed the active org: follow it here too (a removed key = sign-out elsewhere)
  window.addEventListener('storage', function (e) {
    if (e.key !== 'marsa_active_org' || S.status !== 'ready') return;
    if (!e.newValue) { refresh(); return; }
    var id = staffPick(e.newValue);
    if (id === S.orgId || !orgs().some(function (o) { return o.org_id === id; })) return;
    emit('marsa:orgchange', { orgId: id });
  });
  // login.html?signedout=1|all shows a "signed out" notice (auth.js); the hash keeps the client/staff tab
  function afterSignOut(all) { var h = loginHref(), i = h.indexOf('#'); location.href = h.slice(0, i) + '?signedout=' + (all ? 'all' : '1') + h.slice(i); }
  function signOut() {
    if (!api || typeof api.signOut !== 'function') return Promise.resolve();
    return call(function () { return api.signOut(); }).then(function (r) {
      if (r.error) { toast(t('signout_failed', { msg: errMsg(r.error) }), 'error'); return; }
      afterSignOut();
    });
  }
  function signOutAll() {
    if (!api || typeof api.signOutEverywhere !== 'function') return Promise.resolve();
    return confirmDialog({ title: t('signout_all_title'), text: t('signout_all_text'), okText: t('signout_all_ok'), danger: true }).then(function (yes) {
      if (!yes) return;
      return call(function () { return api.signOutEverywhere(); }).then(function (r) {
        if (r.error) { toast(t('signout_failed', { msg: errMsg(r.error) }), 'error'); return; }
        afterSignOut(true);
      });
    });
  }
  function displayName() {
    var p = (S.ctx && S.ctx.profile) || {};
    return p.full_name || p.name || userEmail() || t('user_fallback');
  }
  function userEmail() {
    var p = (S.ctx && S.ctx.profile) || {};
    return p.email || (S.session && S.session.user && S.session.user.email) || '';
  }
  function roleLabels() {
    var out = S.roles.map(function (r) { return t('role_' + r); });
    if (isPlatform()) out.push(t('platform_admin'));
    if (!S.roles.length && isClient()) out.push(t('client_account'));
    return out;
  }
  function user() {
    if (S.status !== 'ready') return null;
    return { name: displayName(), email: userEmail(), roles: roleLabels() };
  }

  /* ------------------------------------------------------------------
     Declarative slots: [data-shell-org] [data-shell-user] [data-shell-search]
     ------------------------------------------------------------------ */
  function renderOrgSlots() {
    qsa('[data-shell-org]').forEach(function (slot) {
      var list = orgs();
      clear(slot);
      slot.hidden = !(S.status === 'ready' && list.length > 1);
      if (slot.hidden) return;
      var id = slot.getAttribute('data-shell-org-id') || uid('shell-org');
      slot.setAttribute('data-shell-org-id', id);
      slot.classList.add('shell-org');
      var sel = el('select', { class: 'form-control shell-org-select', id: id });
      list.forEach(function (o) {
        var opt = el('option', { value: o.org_id, text: orgName(o) });
        if (o.org_id === S.orgId) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () { switchOrg(sel.value); });
      slot.appendChild(el('label', { class: 'text-xs text-muted', for: id, text: t('org_switch') }));
      slot.appendChild(sel);
    });
  }
  function renderUserSlots() {
    qsa('[data-shell-user]').forEach(function (slot) {
      clear(slot);
      var u = user();
      slot.hidden = !u;
      if (!u) return;
      slot.appendChild(el('strong', { class: 'shell-user-name', text: u.name }));
      var o = activeOrg();
      var meta = [u.roles.join('، ')];
      if (o) meta.push(orgName(o));
      slot.appendChild(el('span', { class: 'text-xs text-muted shell-user-meta', text: meta.filter(Boolean).join(' · ') }));
    });
  }
  var MAC = /Mac|iPhone|iPad/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  function renderSearchSlots() {
    qsa('[data-shell-search]').forEach(function (b) {
      b.setAttribute('aria-keyshortcuts', MAC ? 'Meta+K' : 'Control+K');
      b.setAttribute('aria-haspopup', 'dialog');
      if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', t('search_aria'));
      // signed-in users only: anonymous / demo visitors of the public tool pages keep the original header
      b.hidden = !PALETTE_ON || S.status !== 'ready';
      if (b.hasAttribute('data-shell-filled') || !b.firstChild) {
        clear(b).setAttribute('data-shell-filled', '');
        b.appendChild(icon('search'));
        b.appendChild(el('span', { class: 'shell-search-text', text: t('search_button') }));
        b.appendChild(el('kbd', { class: 'shell-kbd', text: MAC ? '⌘K' : 'Ctrl K' }));
      }
    });
  }
  // signed-in chrome for the classic pages (ocr / bulk): session bar, sign-out buttons, staff-only «alerts» link
  function renderSessionSlots() {
    var ready = S.status === 'ready';
    qsa('[data-shell-session]').forEach(function (n) { n.hidden = !ready; });
    qsa('[data-shell-staff]').forEach(function (n) { n.hidden = !(ready && hasStaffRole(S.orgId)); });
    qsa('[data-shell-signout],[data-shell-signout-all]').forEach(function (b) {
      if (!b.hasAttribute('data-shell-filled') && b.firstChild) return;
      clear(b).setAttribute('data-shell-filled', '');
      b.appendChild(icon('logout'));
      b.appendChild(el('span', { text: t(b.hasAttribute('data-shell-signout-all') ? 'signout_all' : 'signout') }));
    });
    var alertsIt = navItem('alerts');
    qsa('[data-shell-alerts]').forEach(function (a) {
      if (!a.hasAttribute('data-shell-filled') && a.firstChild) return;
      clear(a).setAttribute('data-shell-filled', '');
      a.appendChild(icon('bell'));
      a.appendChild(el('span', { text: alertsIt ? navLabel(alertsIt) : 'alerts' }));
    });
    paintBadge('alerts');
  }
  function renderSlots() { renderOrgSlots(); renderUserSlots(); renderSearchSlots(); renderSessionSlots(); }
  doc.addEventListener('click', function (e) {
    var n = e.target && e.target.closest ? e.target.closest('[data-shell-search],[data-shell-signout],[data-shell-signout-all]') : null;
    if (!n) return;
    e.preventDefault();
    if (n.hasAttribute('data-shell-search')) openPalette();
    else if (n.hasAttribute('data-shell-signout-all')) signOutAll();
    else signOut();
  });

  /* ------------------------------------------------------------------
     Command palette (Ctrl/⌘K, "/", [data-shell-search], MarsaShell.openSearch)
     ------------------------------------------------------------------ */
  var paletteEl = null, pInput, pList, pStatus, pFoot, pBox, pRelease = null, pItems = [], pIndex = 0, pSeq = 0, pTimer = null, pRemote = null;
  function buildPalette() {
    paletteEl = el('div', { class: 'cmdk-backdrop' });
    paletteEl.hidden = true;
    pBox = el('div', { class: 'cmdk', role: 'dialog', 'aria-modal': 'true' });
    pInput = el('input', { class: 'cmdk-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmdk-list',
      'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go' });
    pList = el('div', { class: 'cmdk-list', id: 'cmdk-list', role: 'listbox' });
    pStatus = el('div', { class: 'cmdk-status', role: 'status', 'aria-live': 'polite' });
    pFoot = el('div', { class: 'cmdk-foot', 'aria-hidden': 'true' });
    pBox.appendChild(el('div', { class: 'cmdk-head' }, [icon('search'), pInput, el('kbd', { class: 'shell-kbd', text: 'Esc' })]));
    pBox.appendChild(pList); pBox.appendChild(pStatus); pBox.appendChild(pFoot);
    paletteEl.appendChild(pBox);
    body.appendChild(paletteEl);
    paletteEl.addEventListener('mousedown', function (e) { if (e.target === paletteEl) closePalette(); });
    pInput.addEventListener('input', function () { refreshPalette(); });
    pInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!pItems.length) return;
        pIndex = (pIndex + (e.key === 'ArrowDown' ? 1 : -1) + pItems.length) % pItems.length;
        highlight(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pItems[pIndex]) activate(pItems[pIndex]);
      } else if ((e.key === 'Home' || e.key === 'End') && (e.ctrlKey || e.metaKey) && pItems.length) {
        e.preventDefault(); pIndex = e.key === 'Home' ? 0 : pItems.length - 1; highlight(true);
      }
    });
    pList.addEventListener('mousemove', function (e) {
      var o = e.target.closest('.cmdk-item');
      if (!o) return;
      var i = parseInt(o.getAttribute('data-index'), 10);
      if (i !== pIndex && !isNaN(i)) { pIndex = i; highlight(false); }
    });
    pList.addEventListener('click', function (e) {
      var o = e.target.closest('.cmdk-item');
      if (!o) return;
      var it = pItems[parseInt(o.getAttribute('data-index'), 10)];
      if (it) activate(it);
    });
  }
  function localizePalette() {
    pBox.setAttribute('aria-label', t('cmdk_label'));
    pInput.setAttribute('aria-label', t('cmdk_input_label'));
    pInput.setAttribute('placeholder', t('cmdk_placeholder'));
    pList.setAttribute('aria-label', t('cmdk_label'));
    clear(pFoot);
    [['↑↓', 'cmdk_foot_nav'], ['↵', 'cmdk_foot_open'], ['Esc', 'cmdk_foot_close']].forEach(function (x) {
      pFoot.appendChild(el('span', null, [el('kbd', { class: 'shell-kbd', text: x[0] }), doc.createTextNode(t(x[1]))]));
    });
  }
  var pUnInert = null;
  function openPalette(q) {
    if (!PALETTE_ON || topLayerModalOpen() || appModalOpen()) return;   // not over a shell / ops form modal
    if (!paletteEl) buildPalette();
    if (!paletteEl.hidden) { pInput.focus(); return; }
    localizePalette();
    paletteEl.hidden = false;
    paletteEl.removeAttribute('inert');
    pUnInert = inertBehind(paletteEl);
    lockScroll();
    pRelease = trap(pBox, closePalette);
    pInput.value = q != null ? String(q) : '';
    pRemote = null;
    refreshPalette();
    pInput.focus(); pInput.select();
    setTimeout(function () { if (!paletteEl.hidden && doc.activeElement !== pInput) pInput.focus(); }, 0);   // some browsers drop focus set during the opening click
  }
  function closePalette() {
    if (!paletteEl || paletteEl.hidden) return;
    paletteEl.hidden = true;
    if (pUnInert) { var u = pUnInert; pUnInert = null; u(); }
    pSeq++;
    if (pTimer) { clearTimeout(pTimer); pTimer = null; }
    lockScroll();
    if (pRelease) { var r = pRelease; pRelease = null; r(); }
  }
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[ً-ْـ]/g, '')            // tashkeel + tatweel
      .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
  }
  function navMatches(q) {
    var out = [], nq = norm(q);
    visibleNav().forEach(function (g) {
      g.items.forEach(function (it) {
        var hay = [navLabel(it), navLabel(it, 'ar'), navLabel(it, 'en'), it.id].map(norm).join(' ');
        if (!nq || hay.indexOf(nq) !== -1) out.push({ group: 'nav', title: navLabel(it), sub: groupLabel(g), icon: it.icon, href: itemHref(it) });
      });
    });
    return out;
  }
  function actionMatches(q) {
    var nq = norm(q), out = [];
    function add(title, iconName, run, words) {
      var hay = norm(title + ' ' + (words || ''));
      if (!nq || hay.indexOf(nq) !== -1) out.push({ group: 'actions', title: title, icon: iconName, run: run });
    }
    if (canSwitchLang()) add(t('act_lang'), 'languages', function () { switchLang(lang() === 'en' ? 'ar' : 'en'); }, 'language english arabic لغة');
    if (S.status === 'ready') {
      add(t('act_signout'), 'logout', signOut, 'logout sign out خروج');
      add(t('signout_all'), 'logout', signOutAll, 'logout all devices خروج الأجهزة');
    } else if (S.status === 'signedout') add(t('sign_in'), 'signin', function () { location.href = loginHref(); }, 'login دخول');
    return out;
  }
  function canSearchRecords() { return S.status === 'ready' && canAny(R.staff) && api && typeof api.globalSearch === 'function'; }
  function refreshPalette() {
    var q = pInput.value;
    var trimmed = q.trim();
    if (pTimer) { clearTimeout(pTimer); pTimer = null; }
    var seq = ++pSeq;
    if (trimmed.length >= 2 && canSearchRecords()) {
      pRemote = { q: trimmed, state: 'loading', data: null };
      pTimer = setTimeout(function () {
        var oid = S.orgId;
        call(function () { return api.globalSearch(trimmed, { limit: 8, orgId: oid }); }).then(function (r) {
          if (seq !== pSeq) return;            // a newer query won
          pRemote = { q: trimmed, state: r.error ? 'error' : 'done', data: r.data, error: r.error };
          renderPalette(q);
        });
      }, 200);
    } else pRemote = null;
    pIndex = 0;
    renderPalette(q);
  }
  function txSub(row) {
    var c = row.clients || {};
    var parts = [(lang() === 'en' && c.name_en) || c.name_ar || c.name_en];
    if (row.matched === 'container_no' && row.container_no) parts.push(t('f_container') + ' ' + row.container_no);
    if (row.bl_number) parts.push(t('f_bl') + ' ' + row.bl_number);
    if (row.declaration_no) parts.push(t('f_decl') + ' ' + row.declaration_no);
    return parts.filter(Boolean).join(' · ');
  }
  function remoteItems() {
    var out = [];
    if (!pRemote || pRemote.state !== 'done' || !pRemote.data) return out;
    var d = pRemote.data;
    (d.transactions || []).forEach(function (r) {
      if (!r || !UUID_RE.test(r.id)) return;
      out.push({ group: 'tx', title: r.ref || r.id.slice(0, 8), sub: txSub(r), icon: r.matched === 'container_no' ? 'container' : 'layers', href: 'admin.html#tx/' + r.id, ltr: true });
    });
    (d.clients || []).forEach(function (r) {
      if (!r || !UUID_RE.test(r.id)) return;
      var name = (lang() === 'en' && r.name_en) || r.name_ar || r.name_en || '';
      var sub = [r.cr_number ? t('f_cr') + ' ' + r.cr_number : '', r.vat_number ? t('f_vat') + ' ' + r.vat_number : ''].filter(Boolean).join(' · ');
      out.push({ group: 'clients', title: name, sub: sub, icon: 'users', href: 'admin.html#client/' + r.id });
    });
    if (canAny(R.opsWriter)) (d.requests || []).forEach(function (r) {   // admin.js #request/<id> needs ops writer
      if (!r || !UUID_RE.test(r.id)) return;
      out.push({ group: 'requests', title: r.ref || r.id.slice(0, 8), sub: [r.company, r.full_name].filter(Boolean).join(' · '), icon: 'inbox', href: 'admin.html#request/' + r.id, ltr: true });
    });
    return out;
  }
  // G6a: last item of the records part → admin.html#search?q=<q> (advanced search, staff only; the q travels
  // in the hash only, never in a query string sent to a server)
  function advancedItem(q) {
    var trimmed = String(q || '').trim().slice(0, 80);
    if (trimmed.length < 2 || S.status !== 'ready' || !canAny(R.staff)) return [];
    return [{ group: 'tx', title: keyLabel('rpt.cmdk_advanced', { q: trimmed }), icon: 'search', href: 'admin.html#search?q=' + encodeURIComponent(trimmed) }];
  }
  var GROUP_LABEL = { nav: 'cmdk_nav', tx: 'cmdk_tx', clients: 'cmdk_clients', requests: 'cmdk_requests', actions: 'cmdk_actions' };
  function renderPalette(q) {
    var items = navMatches(q).concat(remoteItems()).concat(advancedItem(q)).concat(actionMatches(q));
    pItems = items;
    if (pIndex >= items.length) pIndex = 0;
    clear(pList);
    var groups = {}, order = [];
    items.forEach(function (it, i) {
      it.index = i;
      if (!groups[it.group]) { groups[it.group] = []; order.push(it.group); }
      groups[it.group].push(it);
    });
    order.forEach(function (g) {
      var lid = 'cmdk-g-' + g;
      var box = el('div', { class: 'cmdk-group', role: 'group', 'aria-labelledby': lid }, [el('div', { class: 'cmdk-group-label', id: lid, text: t(GROUP_LABEL[g]) })]);
      groups[g].forEach(function (it) {
        var text = el('span', { class: 'cmdk-item-text' }, [el('span', { class: 'cmdk-item-title', text: it.title, dir: it.ltr ? 'auto' : null })]);
        if (it.sub) text.appendChild(el('span', { class: 'cmdk-item-sub', text: it.sub }));
        box.appendChild(el('div', { class: 'cmdk-item', role: 'option', id: 'cmdk-opt-' + it.index, 'data-index': String(it.index), 'aria-selected': 'false' }, [
          el('span', { class: 'cmdk-item-icon', 'aria-hidden': 'true' }, [icon(it.icon)]), text, el('span', { class: 'cmdk-item-hint', 'aria-hidden': 'true', text: '↵' })
        ]));
      });
      pList.appendChild(box);
    });
    var trimmed = q.trim(), msg = '';
    if (pRemote && pRemote.state === 'loading') msg = t('cmdk_searching');
    else if (pRemote && pRemote.state === 'error') msg = t('cmdk_error', { msg: errMsg(pRemote.error) });
    else if (!items.length) msg = S.status === 'demo' ? t('demo_text') : S.status === 'signedout' ? t('signed_out_text') : t('cmdk_empty');
    else if (trimmed.length === 1 && canSearchRecords()) msg = t('cmdk_min');
    else if (trimmed) msg = t('cmdk_count', { n: items.length });
    pStatus.textContent = msg;
    highlight(false);
  }
  function highlight(scroll) {
    Array.prototype.forEach.call(pList.querySelectorAll('.cmdk-item'), function (o) {
      o.setAttribute('aria-selected', String(parseInt(o.getAttribute('data-index'), 10) === pIndex));
    });
    var cur = pItems[pIndex] ? doc.getElementById('cmdk-opt-' + pIndex) : null;
    if (cur) { pInput.setAttribute('aria-activedescendant', cur.id); if (scroll && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' }); }
    else pInput.removeAttribute('aria-activedescendant');
  }
  function activate(it) {
    closePalette();
    if (it.run) { it.run(); return; }
    if (!it.href) return;
    var target = it.href.split('#'), here = fileName();
    if (target[0] === here && target[1] != null) { if (location.hash === '#' + target[1]) window.dispatchEvent(new Event('hashchange')); else location.hash = target[1]; }
    else location.href = it.href;
  }
  doc.addEventListener('keydown', function (e) {
    if (!PALETTE_ON) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (appModalOpen() || topLayerModalOpen()) return;
      e.preventDefault();
      if (paletteEl && !paletteEl.hidden) closePalette(); else openPalette();
      return;
    }
    if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !traps.length && !appModalOpen() && !topLayerModalOpen()) {
      var a = doc.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      e.preventDefault(); openPalette();
    }
  });

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  function afterContext(ctx) {
    if (!S.manualActive) S.active = detectActive();
    onReady(function () { renderSlots(); markActive(); renderTitle(); });
    emit('marsa:contextchange', { context: ctx, status: S.status });
  }
  function refresh() {
    return loadContext(true).then(function (ctx) {
      afterContext(ctx);
      refreshBadge(); refreshInboxBadge();
      return ctx;
    }, function () { S.status = 'error'; afterContext(null); return null; });
  }

  var Shell = {
    ready: ready,
    status: function () { return S.status; },
    context: function () { return S.ctx; }, orgId: function () { return S.orgId; }, roles: function () { return S.roles.slice(); },
    can: function (roles) { return canAny([].concat(roles || [])); }, isClient: isClient, isPlatformAdmin: isPlatform,
    navItems: navItems, setActive: setActive, setBadge: setBadge, badge: badgeValue,
    setTitle: setTitle, toast: toast, confirm: confirmDialog, modal: modal,
    openSearch: function (q) { openPalette(q); }, openPalette: function (q) { openPalette(q); }, closePalette: closePalette,
    orgs: function () { return orgs().map(function (o) { return { org_id: o.org_id, slug: o.slug, name_ar: o.name_ar, name_en: o.name_en, name: orgName(o) }; }); },
    switchOrg: switchOrg, user: user, signOut: signOut, signOutAll: signOutAll,
    refresh: refresh, refreshAlertBadge: function () { return refreshBadge(); },
    NAV: NAV, R: R, t: t
  };
  window.MarsaShell = Shell;

  S.active = detectActive();
  onReady(function () { renderSlots(); markActive(); });
  loadContext(false).then(function (ctx) {
    afterContext(ctx);
    readyResolve(ctx);
    emit('marsa:shellready', { context: ctx });
    refreshBadge(); refreshInboxBadge();
    armBadge();
  }, function () {
    S.status = 'error'; afterContext(null); readyResolve(null);
  });

  window.addEventListener('marsa:langchange', function () {
    renderSlots();
    renderTitle();
    Object.keys(counts).forEach(paintBadge);
    if (paletteEl && !paletteEl.hidden) { localizePalette(); refreshPalette(); }
  });
  if (api && typeof api.onAuth === 'function') {
    try {
      api.onAuth(function (event) {
        if (event === 'SIGNED_OUT') {
          S.status = 'signedout'; S.ctx = null; S.session = null; S.roles = []; S.orgId = null;
          afterContext(null);
          setBadge('alerts', null); setBadge('inbox', null);
        } else if (event === 'SIGNED_IN' && S.status !== 'ready' && S.status !== 'loading') {
          refresh();
        }
      });
    } catch (e) { /* demo / old supa.js */ }
  }
})();

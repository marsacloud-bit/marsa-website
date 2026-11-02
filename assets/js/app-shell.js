/* ==========================================================================
   مرسى | MARSA — app shell (signed-in "program" pages, STAGING)  →  window.MarsaShell
   --------------------------------------------------------------------------
   Contract: docs/online/APP_UI_SPEC.md ("Layout", "Shared files").
   Load order: config.js → i18n.js → assets/i18n/<page>.js → assets/i18n/app.js
               → main.js → supa.js → app-shell.js → pwa.js → <page>.js (all defer).

   On <body class="app-page" data-app-page="admin|platform|ocr|bulk|portal|offline">
   the shell is built around the page's <main id="app-main">: sidebar (nav
   filtered by role), topbar (title + breadcrumb, search / command palette,
   org switcher, [data-pwa-install] slot, language, theme, user menu), skip
   link, toasts and dialogs.

   window.MarsaShell = {
     ready                 Promise → my_context data, or null (signed out / demo mode / error);
                           never rejects. The page shows its own gate when null.
     setTitle(title, crumbs?)   crumbs: [{label, href?}] or strings, shown before the title
     setActive(navId)      highlight a NAV item (auto: data-app-page / admin.html #hash)
     toast(text, tone?, opts?)  tone success|error|warning|info; opts {duration ms (0 = sticky),
                           action:{label, onClick}} → {el, close()}
     confirm({title, text, okText, cancelText, danger}) → Promise<boolean>
     modal({title, body (Node|string), actions:[{label, value, primary, danger}], size}) → Promise<value|null>
     openPalette(q?) closePalette()   refresh() → Promise (re-reads my_context)
     context() orgId() roles() can(roles[]) isClient() isPlatformAdmin()   NAV  R
   }
   Events: window 'marsa:shellready' {detail:{context}}; 'marsa:orgchange' {detail:{orgId}}
   (dispatched by MarsaApi.setActiveOrg; the shell dispatches it itself only if not).

   * The role sets R mirror assets/js/admin.js (VIEWS / R); the UI only hides —
     the database (RLS + guarded RPCs) is the gate.
   * Server and user data are inserted with textContent / createElement only;
     innerHTML is used for the static SVG icon strings below.
   * Demo mode (no Supabase config) or no MarsaApi: the shell renders with a
     signed-out state and makes no calls.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document, html = doc.documentElement, body = doc.body;
  var api = window.MarsaApi;
  var I18N = window.MarsaI18n;
  var DICT = window.MarsaAppDict || { ar: {}, en: {} };

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
  // pages that ship a dictionary (<html data-i18n-page>) can switch language; the others stay Arabic
  function canSwitchLang() { return !!(I18N && typeof I18N.setLang === 'function' && html.hasAttribute('data-i18n-page')); }

  /* ------------------------------------------------------------------
     Role model — mirrors assets/js/admin.js R / VIEWS (UI only)
     ------------------------------------------------------------------ */
  var R = {
    staff: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    opsWriter: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    contact: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    membersRead: ['admin', 'branch_manager', 'supervisor'],
    orgAdmin: ['admin'],
    auditRead: ['admin', 'supervisor']
  };
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];

  // NAV — the single source for the sidebar and the palette's "go to" group.
  // allow: any of these roles in the active org · platform: is_platform_admin · client: client account
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
    { id: 'manage', label: 'grp_manage', items: [
      { id: 'org', href: 'admin.html#org', icon: 'building', allow: R.orgAdmin },
      { id: 'branches', href: 'admin.html#branches', icon: 'branch', allow: R.orgAdmin },
      { id: 'members', href: 'admin.html#members', icon: 'userPlus', allow: R.membersRead },
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
    ] }
  ];
  // admin.js detail routes (#tx/<id> …) belong to their list view
  var ADMIN_ALIAS = { tx: 'transactions', request: 'requests', client: 'clients', import: 'imports' };
  var PAGE_NAV = { platform: 'platform', ocr: 'ocr', bulk: 'bulk', portal: 'portal', offline: null };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ------------------------------------------------------------------
     Icons (static, trusted markup; 24×24 stroke)
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
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevrons: '<path d="m11 17 5-5-5-5M5 17l5-5-5-5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
    devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
    languages: '<path d="M4 5h8M8 3v2M5.5 5c.8 3.5 3.3 6 6.5 7.5M10.5 5c-.8 3.5-3.3 6-6.5 7.5"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    warning: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    container: '<rect x="2" y="7" width="20" height="11" rx="1"/><path d="M6 7v11M10 7v11M14 7v11M18 7v11"/>',
    signin: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M14 16l4-4-4-4M18 12H8"/>'
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
  var uidN = 0;
  function uid(p) { return (p || 'app') + '-' + (++uidN); }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); }
    catch (e) { /* private mode / blocked storage */ }
    return null;
  }
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

  /* ------------------------------------------------------------------
     Focus traps (modal, palette, drawer) — the top one handles Tab / Esc
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
    var modal = modalDialog();
    if (modal && !modal.contains(top.root)) return;   // the dialog owns focus, not a stale shell trap
    var list = focusables(top.root);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1], a = doc.activeElement;
    if (!top.root.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }, true);
  // a page's native modal <dialog> (showModal) sits in the top layer and makes the shell inert:
  // shell overlays opened under it would be invisible and their focus traps would swallow Tab
  function modalDialog() {
    try { return doc.querySelector('dialog:modal'); } catch (e) { return doc.querySelector('dialog[open]'); }   // no :modal support
  }
  function topLayerModalOpen() { return !!modalDialog(); }
  function lockScroll(on) { html.classList.toggle('app-lock', !!on || !!doc.querySelector('.app-modal-backdrop, .cmdk-backdrop:not([hidden])') || (shellEl && shellEl.classList.contains('is-drawer-open'))); }

  /* ------------------------------------------------------------------
     Menus (org switcher, theme, user): button[aria-haspopup] + panel of
     [role=menuitem|menuitemradio]; arrows / Home / End / Esc / Tab
     ------------------------------------------------------------------ */
  var openMenu = null;
  function makeMenu(btn, panel, onOpen) {
    var m = {};
    panel.id = panel.id || uid('menu');
    panel.setAttribute('role', 'menu');
    panel.hidden = true;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', panel.id);
    function items() { return Array.prototype.filter.call(panel.querySelectorAll('[role^="menuitem"]'), function (n) { return isVisible(n) && !n.disabled; }); }
    m.open = function (focusLast) {
      if (openMenu && openMenu !== m) openMenu.close(false);
      if (onOpen) onOpen();
      panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); openMenu = m;
      var list = items(), cur = panel.querySelector('[aria-checked="true"]');
      var target = focusLast ? list[list.length - 1] : (cur && list.indexOf(cur) !== -1 ? cur : list[0]);
      if (target) target.focus();
    };
    m.close = function (restore) {
      if (panel.hidden) return;
      panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
      if (openMenu === m) openMenu = null;
      if (restore) btn.focus();
    };
    m.contains = function (n) { return btn.contains(n) || panel.contains(n); };
    btn.addEventListener('click', function () { if (panel.hidden) m.open(); else m.close(true); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); m.open(e.key === 'ArrowUp'); }
    });
    panel.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (list[(i + 1) % list.length] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[(i - 1 + list.length) % list.length] || list[0]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); if (list[0]) list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); if (list.length) list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.close(true); }
      else if (e.key === 'Tab') { m.close(false); }
    });
    // capture: the menu closes (focus back on its button) before the item's own handler runs,
    // so a dialog opened by that handler remembers the button as the focus to restore
    panel.addEventListener('click', function (e) {
      var it = e.target.closest('[role^="menuitem"]');
      if (it && !it.disabled) m.close(true);
    }, true);
    return m;
  }
  doc.addEventListener('mousedown', function (e) { if (openMenu && !openMenu.contains(e.target)) openMenu.close(false); });
  function menuItem(label, iconName, opts) {
    opts = opts || {};
    var b = el(opts.href ? 'a' : 'button', {
      class: 'app-menu-item' + (opts.danger ? ' is-danger' : ''), role: opts.radio ? 'menuitemradio' : 'menuitem',
      type: opts.href ? null : 'button', href: opts.href || null, tabindex: '-1',
      'aria-checked': opts.radio ? String(!!opts.checked) : null, lang: opts.lang || null
    });
    if (iconName) b.appendChild(icon(iconName));
    b.appendChild(el('span', { text: label }));
    if (opts.radio) b.appendChild(icon('check', 'app-check'));
    if (opts.onClick) b.addEventListener('click', function (e) { if (!opts.href) e.preventDefault(); opts.onClick(); });
    return b;
  }

  /* ------------------------------------------------------------------
     Theme: light / dark / system (localStorage marsa_theme)
     ------------------------------------------------------------------ */
  var THEME_KEY = 'marsa_theme';
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function themePref() { var v = store(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; }
  function applyTheme() {
    var p = themePref(), dark = p === 'dark' || (p === 'system' && !!(mqDark && mqDark.matches));
    html.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0A111D' : '#0B3A6E');
    if (themeBtn) {
      clear(themeBtn).appendChild(icon(p === 'system' ? 'monitor' : (dark ? 'moon' : 'sun')));
      themeBtn.setAttribute('aria-label', t('theme') + ': ' + t('theme_' + p));
      themeBtn.title = t('theme') + ': ' + t('theme_' + p);
    }
  }
  function setTheme(p) { store(THEME_KEY, p === 'light' || p === 'dark' ? p : 'system'); applyTheme(); }
  if (mqDark) {
    var onScheme = function () { if (themePref() === 'system') applyTheme(); };
    if (mqDark.addEventListener) mqDark.addEventListener('change', onScheme); else if (mqDark.addListener) mqDark.addListener(onScheme);
  }

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  var S = {
    status: 'loading',          // loading | ready | signedout | demo | error
    ctx: null, session: null, orgId: null, roles: [], memberships: [],
    active: null, manualActive: false,
    title: null, crumbs: [], titleAuto: true
  };
  var PAGE = body ? (body.getAttribute('data-app-page') || '') : '';
  var IS_APP = !!(body && body.classList.contains('app-page'));
  // staff pages work in a staff org only (same rule as admin.js staffOrgs): a client-only membership
  // elsewhere is never offered or kept as the active org there
  var STAFF_PAGE = PAGE === 'admin' || PAGE === 'ocr' || PAGE === 'bulk';
  function canAny(roles) { return S.roles.some(function (r) { return roles.indexOf(r) !== -1; }); }
  function isPlatform() { return !!(S.ctx && S.ctx.is_platform_admin); }
  function isClient() {
    if (!S.ctx) return false;
    if (S.roles.indexOf('client') !== -1 || (S.ctx.clients || []).length > 0) return true;
    // a signed-in account without any staff or platform role is a (not yet linked) client account
    var anyStaff = (S.ctx.memberships || []).some(function (m) { return R.staff.indexOf(m.role) !== -1; });
    return !anyStaff && !isPlatform();
  }
  function itemVisible(it) {
    if (S.status !== 'ready') return false;
    if (it.platform) return isPlatform();
    if (it.client) return isClient();
    return it.allow ? canAny(it.allow) : true;
  }
  function visibleNav() {
    return NAV.map(function (g) { return { id: g.id, label: g.label, items: g.items.filter(itemVisible) }; })
      .filter(function (g) { return g.items.length; });
  }
  function navItem(id) {
    for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i].items.length; j++) if (NAV[i].items[j].id === id) return NAV[i].items[j];
    return null;
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
  function hasStaffRole(orgId) {
    return !!S.ctx && (S.ctx.memberships || []).some(function (m) { return m.org_id === orgId && R.staff.indexOf(m.role) !== -1; });
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
            // store the staff org so supa.js (orgId() for writes), admin.js and this header agree;
            // the 'marsa:orgchange' it fires is a no-op here because S.orgId already matches
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
     Shell DOM
     ------------------------------------------------------------------ */
  var shellEl, sidebar, navEl, bodyEl, topbar, titleEl, crumbsEl, brandOrg, brandName, envEl, collapseBtn, menuBtn, drawerClose,
    searchBtn, searchText, orgWrap, orgBtn, orgPanel, orgMenu, langBtn, themeBtn, themePanel, themeMenu,
    userWrap, userBtn, userPanel, userMenu, signinBtn, mainEl, skipEl, pwaSlot;

  function build() {
    mainEl = doc.getElementById('app-main');
    if (!mainEl) {   // tolerate pages without the expected <main id="app-main">
      mainEl = doc.querySelector('main') || el('main');
      if (!mainEl.parentNode) {
        Array.prototype.slice.call(body.childNodes).forEach(function (n) { if (!(n.nodeType === 1 && n.tagName === 'SCRIPT')) mainEl.appendChild(n); });
        body.insertBefore(mainEl, body.firstChild);
      }
      mainEl.id = 'app-main';
    }
    mainEl.classList.add('app-main');
    if (!mainEl.hasAttribute('tabindex')) mainEl.setAttribute('tabindex', '-1');

    skipEl = el('a', { class: 'skip-link app-skip', href: '#app-main' });
    skipEl.addEventListener('click', function (e) { e.preventDefault(); mainEl.focus(); try { mainEl.scrollIntoView({ block: 'start' }); } catch (x) { /* old */ } });

    // sidebar
    brandName = el('span', { class: 'app-brand-name' });
    brandOrg = el('span', { class: 'app-brand-org' });
    var logo = el('img', { src: 'assets/img/logo.png', alt: '', width: '28', height: '28', decoding: 'async' });
    var brandLink = el('a', { class: 'app-brand-link', href: PAGE === 'portal' ? 'portal.html' : 'admin.html#dashboard' }, [
      el('span', { class: 'app-brand-mark' }, [logo]), el('span', { class: 'app-brand-text' }, [brandName, brandOrg])
    ]);
    drawerClose = el('button', { class: 'app-icon-btn app-drawer-close', type: 'button' }, [icon('x')]);
    drawerClose.addEventListener('click', function () { closeDrawer(true); });
    navEl = el('nav', { class: 'app-nav', id: 'app-nav' });
    envEl = el('span', { class: 'app-env' }, [el('span', { class: 'app-env-text' })]);
    collapseBtn = el('button', { class: 'app-icon-btn app-collapse-btn', type: 'button', 'aria-controls': 'app-sidebar' }, [icon('chevrons')]);
    collapseBtn.addEventListener('click', function () { setCollapsed(!shellEl.classList.contains('is-collapsed')); });
    sidebar = el('aside', { class: 'app-sidebar', id: 'app-sidebar' }, [
      el('div', { class: 'app-brand' }, [brandLink, drawerClose]),
      navEl,
      el('div', { class: 'app-sidebar-foot' }, [envEl, collapseBtn])
    ]);
    var scrim = el('div', { class: 'app-scrim', 'aria-hidden': 'true' });
    scrim.addEventListener('click', function () { closeDrawer(true); });

    // topbar
    menuBtn = el('button', { class: 'app-icon-btn app-menu-btn', type: 'button', 'aria-controls': 'app-sidebar', 'aria-expanded': 'false' }, [icon('menu')]);
    menuBtn.addEventListener('click', function () { if (shellEl.classList.contains('is-drawer-open')) closeDrawer(true); else openDrawer(); });
    crumbsEl = el('nav', { class: 'app-crumbs' }, [el('ol')]);
    titleEl = el('h1', { class: 'app-title', id: 'app-title' });
    searchText = el('span', { class: 'app-search-text' });
    var mac = /Mac|iPhone|iPad/i.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
    searchBtn = el('button', { class: 'app-search-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K' },
      [icon('search'), searchText, el('kbd', { text: mac ? '⌘K' : 'Ctrl K' })]);
    searchBtn.addEventListener('click', function () { openPalette(); });

    orgBtn = el('button', { class: 'app-icon-btn app-org-btn', type: 'button' }, [icon('building'), el('span', { class: 'app-org-name' }), icon('chevronDown')]);
    orgPanel = el('div', { class: 'app-menu' });
    orgWrap = el('div', { class: 'app-menu-wrap app-org' }, [orgBtn, orgPanel]);
    orgWrap.hidden = true;
    orgMenu = makeMenu(orgBtn, orgPanel, renderOrgMenu);

    pwaSlot = el('div', { class: 'app-pwa-slot', 'data-pwa-install': '' });

    langBtn = el('button', { class: 'app-icon-btn app-lang-btn', type: 'button' });
    langBtn.addEventListener('click', function () { switchLang(lang() === 'en' ? 'ar' : 'en'); });

    themeBtn = el('button', { class: 'app-icon-btn app-theme-btn', type: 'button' });
    themePanel = el('div', { class: 'app-menu' });
    themeMenu = makeMenu(themeBtn, themePanel, renderThemeMenu);

    userBtn = el('button', { class: 'app-icon-btn app-user-btn', type: 'button' });
    userPanel = el('div', { class: 'app-menu app-user-menu' });
    userMenu = makeMenu(userBtn, userPanel, renderUserMenu);
    signinBtn = el('a', { class: 'btn btn-primary btn-sm app-signin-btn', href: loginHref() });
    userWrap = el('div', { class: 'app-menu-wrap app-user' }, [userBtn, userPanel, signinBtn]);

    topbar = el('header', { class: 'app-topbar' }, [
      menuBtn,
      el('div', { class: 'app-topbar-title' }, [crumbsEl, titleEl]),
      el('div', { class: 'app-topbar-actions' }, [searchBtn, orgWrap, pwaSlot, langBtn, el('div', { class: 'app-menu-wrap' }, [themeBtn, themePanel]),
        el('span', { class: 'app-sep', 'aria-hidden': 'true' }), userWrap])
    ]);

    bodyEl = el('div', { class: 'app-body' }, [topbar]);
    shellEl = el('div', { class: 'app-shell' }, [sidebar, scrim, bodyEl]);
    if (store('marsa_sidebar') === 'collapsed') shellEl.classList.add('is-collapsed');

    body.insertBefore(shellEl, mainEl);
    bodyEl.appendChild(mainEl);
    body.insertBefore(skipEl, body.firstChild);

    navEl.addEventListener('keydown', navKeys);
    navEl.addEventListener('click', function (e) {
      var a = e.target.closest('a.app-nav-link');
      if (a && shellEl.classList.contains('is-drawer-open')) closeDrawer(false);
    });
    // collapsed rail: one fixed tooltip, so the nav itself keeps scrolling on short screens
    navTip = el('div', { class: 'app-nav-tip', role: 'presentation', 'aria-hidden': 'true', hidden: true });
    body.appendChild(navTip);
    navEl.addEventListener('mouseover', function (e) { showNavTip(e.target.closest && e.target.closest('.app-nav-link[data-tip]')); });
    navEl.addEventListener('focusin', function (e) { showNavTip(e.target.closest && e.target.closest('.app-nav-link[data-tip]'), true); });
    navEl.addEventListener('mouseleave', hideNavTip);
    navEl.addEventListener('focusout', hideNavTip);
    navEl.addEventListener('scroll', hideNavTip, { passive: true });
    window.addEventListener('resize', hideNavTip);
    S.title = null;
  }
  var navTip = null;
  function showNavTip(a, byFocus) {
    if (!navTip) return;
    var collapsed = shellEl.classList.contains('is-collapsed') && !(mqDrawer && mqDrawer.matches);
    if (!a || !collapsed) { hideNavTip(); return; }
    if (byFocus && a.matches && !a.matches(':focus-visible')) { hideNavTip(); return; }
    var r = a.getBoundingClientRect(), rtl = html.getAttribute('dir') === 'rtl';
    navTip.textContent = a.getAttribute('data-tip');
    navTip.style.top = Math.round(r.top + r.height / 2) + 'px';
    // outward from the rail: left of it in RTL (rail on the right), right of it in LTR
    navTip.style.left = rtl ? 'auto' : Math.round(r.right + 10) + 'px';
    navTip.style.right = rtl ? Math.round(doc.documentElement.clientWidth - r.left + 10) + 'px' : 'auto';
    navTip.hidden = false;
  }
  function hideNavTip() { if (navTip) navTip.hidden = true; }

  /* ---- sidebar: collapse (desktop) and drawer (< 1024px) ---- */
  var mqDrawer = window.matchMedia ? window.matchMedia('(max-width: 1023.98px)') : null;
  function setCollapsed(on) {
    shellEl.classList.toggle('is-collapsed', !!on);
    hideNavTip();
    store('marsa_sidebar', on ? 'collapsed' : 'expanded');
    syncCollapse();
  }
  function syncCollapse() {
    var on = shellEl.classList.contains('is-collapsed');
    var label = on ? t('expand') : t('collapse');
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.title = label;
    collapseBtn.setAttribute('aria-expanded', String(!on));
  }
  var releaseDrawer = null;
  function openDrawer() {
    if (shellEl.classList.contains('is-drawer-open')) return;
    shellEl.classList.add('is-drawer-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    bodyEl.setAttribute('inert', '');
    sidebar.setAttribute('aria-modal', 'true');
    releaseDrawer = trap(sidebar, function () { closeDrawer(true); });
    lockScroll(true);
    var first = sidebar.querySelector('.app-nav-link[aria-current="page"]') || sidebar.querySelector('.app-nav-link') || drawerClose;
    setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 30);
  }
  function closeDrawer(restore) {
    if (!shellEl.classList.contains('is-drawer-open')) return;
    shellEl.classList.remove('is-drawer-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    bodyEl.removeAttribute('inert');
    sidebar.removeAttribute('aria-modal');
    if (releaseDrawer) { var r = releaseDrawer; releaseDrawer = null; r(false); }
    lockScroll(false);
    if (restore) menuBtn.focus();
  }
  if (mqDrawer) {
    var onDrawerMq = function () { if (!mqDrawer.matches && shellEl) closeDrawer(false); };
    if (mqDrawer.addEventListener) mqDrawer.addEventListener('change', onDrawerMq); else if (mqDrawer.addListener) mqDrawer.addListener(onDrawerMq);
  }
  function navKeys(e) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) === -1) return;
    var links = Array.prototype.filter.call(navEl.querySelectorAll('.app-nav-link'), isVisible);
    var i = links.indexOf(doc.activeElement);
    if (i === -1 || !links.length) return;
    e.preventDefault();
    var n = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : e.key === 'ArrowDown' ? (i + 1) % links.length : (i - 1 + links.length) % links.length;
    links[n].focus();
  }

  /* ------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------ */
  function renderAll() {
    if (!shellEl) return;
    skipEl.textContent = t('skip');
    sidebar.setAttribute('aria-label', t('sidebar_aria'));
    navEl.setAttribute('aria-label', t('nav_aria'));
    topbar.setAttribute('aria-label', t('topbar_aria'));
    crumbsEl.setAttribute('aria-label', t('crumbs_aria'));
    drawerClose.setAttribute('aria-label', t('menu_close'));
    menuBtn.setAttribute('aria-label', t('menu_open'));
    searchText.textContent = t('search_placeholder');
    searchBtn.setAttribute('aria-label', t('search_aria'));
    syncCollapse();
    renderBrand();
    renderEnv();
    renderNav();
    renderOrg();
    renderLang();
    applyTheme();
    renderUser();
    renderTitle();
    if (paletteEl && !paletteEl.hidden) { localizePalette(); refreshPalette(); }
  }
  function renderBrand() {
    brandName.textContent = t('brand');
    var o = activeOrg();
    brandOrg.textContent = o ? orgName(o) : (S.status === 'demo' ? t('env_demo') : t('env_hint_staging'));
  }
  function renderEnv() {
    var demo = S.status === 'demo';
    var env = demo ? 'demo' : String((api && api.environment) || 'staging');
    envEl.setAttribute('data-env', env);
    var label = demo ? t('env_demo') : (env === 'production' ? t('env_production') : t('env_staging'));
    var hint = demo ? t('env_hint_demo') : t('env_hint_staging');
    envEl.firstChild.textContent = label;
    envEl.title = label + ' — ' + hint;
    envEl.setAttribute('aria-label', label + ' — ' + hint);
    envEl.setAttribute('role', 'note');
  }
  function renderNav() {
    clear(navEl);
    if (S.status === 'loading') {
      var sk = el('div', { class: 'app-nav-skel', 'aria-hidden': 'true' });
      for (var i = 0; i < 6; i++) sk.appendChild(el('span', { class: 'skeleton' }));
      navEl.appendChild(sk);
      navEl.setAttribute('aria-busy', 'true');
      return;
    }
    navEl.removeAttribute('aria-busy');
    var groups = visibleNav();
    if (!groups.length) {
      var key = S.status === 'demo' ? 'demo' : S.status === 'error' ? 'error' : S.status === 'ready' ? 'none' : 'signed_out';
      var note = el('div', { class: 'app-nav-note' });
      if (key === 'demo') { note.appendChild(el('strong', { text: t('demo_title') })); note.appendChild(doc.createTextNode(t('demo_text'))); }
      else if (key === 'error') {
        note.appendChild(el('strong', { text: t('ctx_error') }));
        var rb = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: t('retry') });
        rb.addEventListener('click', function () { refresh(); });
        note.appendChild(rb);
      } else if (key === 'none') note.appendChild(doc.createTextNode(t('no_sections')));
      else {
        note.appendChild(el('strong', { text: t('signed_out_title') }));
        note.appendChild(doc.createTextNode(t('signed_out_text')));
        note.appendChild(el('a', { class: 'btn btn-primary btn-sm', href: loginHref(), text: t('sign_in') }));
      }
      navEl.appendChild(note);
      return;
    }
    groups.forEach(function (g) {
      var labelId = 'app-nav-grp-' + g.id;
      var list = el('ul', { class: 'app-nav-list', 'aria-labelledby': labelId });
      g.items.forEach(function (it) {
        var label = t('nav_' + it.id);
        var a = el('a', { class: 'app-nav-link', href: it.href, 'data-nav-id': it.id, 'data-tip': label }, [icon(it.icon), el('span', { class: 'app-nav-text', text: label })]);
        if (it.id === S.active) a.setAttribute('aria-current', 'page');
        list.appendChild(el('li', null, [a]));
      });
      navEl.appendChild(el('div', { class: 'app-nav-group' }, [el('p', { class: 'app-nav-label', id: labelId, text: t(g.label) }), list]));
    });
  }
  function markActive() {
    if (!navEl) return;
    Array.prototype.forEach.call(navEl.querySelectorAll('.app-nav-link'), function (a) {
      if (a.getAttribute('data-nav-id') === S.active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function renderOrg() {
    var list = orgs();
    orgWrap.hidden = !(S.status === 'ready' && list.length > 1);
    var o = activeOrg();
    orgBtn.querySelector('.app-org-name').textContent = o ? orgName(o) : t('none');
    orgBtn.setAttribute('aria-label', t('org_switch') + ': ' + (o ? orgName(o) : t('none')));
    orgBtn.title = t('org_switch');
  }
  function renderOrgMenu() {
    clear(orgPanel);
    orgPanel.setAttribute('aria-label', t('org_switch'));
    orgPanel.appendChild(el('div', { class: 'app-menu-label', role: 'presentation', text: t('org_switch') }));
    orgs().forEach(function (o) {
      orgPanel.appendChild(menuItem(orgName(o), 'building', { radio: true, checked: o.org_id === S.orgId, onClick: function () { switchOrg(o); } }));
    });
  }
  function renderLang() {
    langBtn.hidden = !canSwitchLang();
    langBtn.textContent = t('lang_short');
    langBtn.setAttribute('lang', lang() === 'en' ? 'ar' : 'en');
    langBtn.setAttribute('aria-label', t('lang_aria'));
    langBtn.title = t('lang_aria');
  }
  function renderThemeMenu() {
    clear(themePanel);
    themePanel.setAttribute('aria-label', t('theme'));
    var p = themePref();
    [['light', 'sun'], ['dark', 'moon'], ['system', 'monitor']].forEach(function (x) {
      themePanel.appendChild(menuItem(t('theme_' + x[0]), x[1], { radio: true, checked: p === x[0], onClick: function () { setTheme(x[0]); } }));
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
  function initials(name) {
    var parts = String(name || '').replace(/@.*/, '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    var s = parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '');
    return s.toUpperCase();
  }
  function roleLabels() {
    var out = S.roles.map(function (r) { return t('role_' + r); });
    if (isPlatform()) out.push(t('platform_admin'));
    if (!S.roles.length && isClient()) out.push(t('client_account'));
    return out;
  }
  function renderUser() {
    var signed = S.status === 'ready';
    userBtn.hidden = !signed;
    signinBtn.hidden = signed || S.status === 'loading' || S.status === 'demo';
    signinBtn.textContent = t('sign_in');
    if (!signed) { userMenu.close(false); return; }
    var name = displayName();
    clear(userBtn).appendChild(el('span', { class: 'app-avatar', 'aria-hidden': 'true', text: initials(name) }));
    userBtn.setAttribute('aria-label', t('user_menu') + ': ' + name);
    userBtn.title = name;
  }
  function renderUserMenu() {
    clear(userPanel);
    userPanel.setAttribute('aria-label', t('user_menu'));
    var head = el('div', { class: 'app-menu-head', role: 'presentation' }, [el('span', { class: 'app-menu-name', text: displayName() })]);
    var email = userEmail();
    if (email && email !== displayName()) head.appendChild(el('span', { class: 'app-menu-email', text: email }));
    userPanel.appendChild(head);
    var o = activeOrg();
    var meta = el('div', { class: 'app-menu-meta', role: 'presentation' });
    meta.appendChild(el('span', null, [el('b', { text: t('roles') + ': ' }), doc.createTextNode(roleLabels().join('، ') || t('none'))]));
    meta.appendChild(el('span', null, [el('b', { text: t('active_org') + ': ' }), doc.createTextNode(o ? orgName(o) : t('none'))]));
    userPanel.appendChild(meta);
    userPanel.appendChild(el('div', { class: 'app-menu-sep', role: 'separator' }));
    userPanel.appendChild(el('div', { class: 'app-menu-label', role: 'presentation', text: t('profile_locale') }));
    [['ar', t('lang_ar')], ['en', t('lang_en')]].forEach(function (x) {
      userPanel.appendChild(menuItem(x[1], null, { radio: true, checked: profileLocale() === x[0], lang: x[0], onClick: function () { switchLang(x[0]); } }));
    });
    userPanel.appendChild(el('div', { class: 'app-menu-sep', role: 'separator' }));
    userPanel.appendChild(menuItem(t('signout'), 'logout', { onClick: signOut }));
    userPanel.appendChild(menuItem(t('signout_all'), 'devices', { danger: true, onClick: signOutAll }));
  }
  function profileLocale() {
    if (canSwitchLang()) return lang();
    var p = (S.ctx && S.ctx.profile) || {};
    var stored = store('marsa_lang');
    return stored === 'en' || stored === 'ar' ? stored : (p.locale === 'en' ? 'en' : 'ar');
  }
  function renderTitle() {
    var title = S.title;
    if (S.titleAuto || title == null) {
      var it = S.active && navItem(S.active);
      title = it ? t('nav_' + it.id) : (doc.title || '').split('|')[0].trim();
    }
    titleEl.textContent = title || '';
    var ol = clear(crumbsEl.firstChild);
    (S.crumbs || []).forEach(function (c) {
      var label = typeof c === 'string' ? c : (c && c.label);
      if (!label) return;
      var href = c && typeof c === 'object' && c.href ? String(c.href) : null;
      if (href && /^\s*javascript:/i.test(href)) href = null;
      ol.appendChild(el('li', null, [href ? el('a', { href: href, text: label }) : el('span', { text: label })]));
    });
    crumbsEl.hidden = !ol.firstChild;
    if (title) doc.title = title + ' | ' + t('title_suffix');
  }

  /* ------------------------------------------------------------------
     Actions
     ------------------------------------------------------------------ */
  function switchLang(l) {
    l = l === 'en' ? 'en' : 'ar';
    var signed = S.status === 'ready' && api && typeof api.setMyLocale === 'function';
    if (canSwitchLang()) {
      if (I18N.lang() !== l) I18N.setLang(l);   // fires marsa:langchange → renderAll
    } else {
      store('marsa_lang', l);                    // untranslated page: keep it Arabic, remember the choice
      if (!signed) toast(t('locale_page_note'), 'info');
    }
    if (signed) {
      call(function () { return api.setMyLocale(l); }).then(function (r) {
        if (!canSwitchLang() && !r.error) toast(t('locale_page_note'), 'success');
      });
    }
  }
  var orgEventSeen = false;
  function switchOrg(o) {
    if (!o || o.org_id === S.orgId || !api || typeof api.setActiveOrg !== 'function') return;
    orgEventSeen = false;
    var before = S.orgId;
    call(function () { return api.setActiveOrg(o.org_id); }).then(function (r) {
      if (r.error) { toast(t('org_failed', { msg: errMsg(r.error) }), 'error'); return; }
      if (!orgEventSeen && before !== o.org_id) emit('marsa:orgchange', { orgId: o.org_id });   // older supa.js
      toast(t('org_switched', { name: orgName(o) }), 'success');
    });
  }
  window.addEventListener('marsa:orgchange', function (e) {
    orgEventSeen = true;
    var id = e && e.detail && e.detail.orgId;
    if (!id || id === S.orgId) return;
    S.orgId = id;
    computeRoles();
    renderAll();
  });
  // another tab changed the active org (supa.js reads it fresh from localStorage for every write):
  // follow it here too, so the header, the page and its writes stay on the same org. A removed key
  // (sign-out elsewhere) reloads the context.
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
    if (!api || typeof api.signOut !== 'function') return;
    call(function () { return api.signOut(); }).then(function (r) {
      if (r.error) return toast(t('signout_failed', { msg: errMsg(r.error) }), 'error');
      afterSignOut();
    });
  }
  function signOutAll() {
    if (!api || typeof api.signOutEverywhere !== 'function') return;
    confirmDialog({ title: t('signout_all_title'), text: t('signout_all_text'), okText: t('signout_all_ok'), danger: true }).then(function (yes) {
      if (!yes) return;
      call(function () { return api.signOutEverywhere(); }).then(function (r) {
        if (r.error) return toast(t('signout_failed', { msg: errMsg(r.error) }), 'error');
        afterSignOut(true);
      });
    });
  }

  /* ------------------------------------------------------------------
     Title / active item
     ------------------------------------------------------------------ */
  function detectActive() {
    if (PAGE === 'admin') {
      var h = (location.hash || '').replace(/^#/, '').split('/')[0] || 'dashboard';
      h = ADMIN_ALIAS[h] || h;
      return navItem(h) ? h : 'dashboard';
    }
    return PAGE_NAV[PAGE] || null;
  }
  function setActive(id) {
    S.active = id && navItem(id) ? id : null;
    S.manualActive = true;
    markActive();
    if (S.titleAuto && shellEl) renderTitle();
  }
  function setTitle(title, crumbs) {
    S.title = title == null ? null : String(title);
    S.titleAuto = title == null;
    S.crumbs = Array.isArray(crumbs) ? crumbs.slice(0, 6) : [];
    if (shellEl) renderTitle();
  }
  window.addEventListener('hashchange', function () {
    if (PAGE !== 'admin' || !shellEl) return;
    S.active = detectActive(); S.manualActive = false;
    S.titleAuto = true; S.title = null; S.crumbs = [];   // the page sets its own title again after routing
    markActive(); renderTitle();
  });

  /* ------------------------------------------------------------------
     Toasts (shared .toast-stack with main.js Marsa.toast)
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
    var n = el('div', { class: 'toast toast-' + tone, role: tone === 'error' ? 'alert' : null });
    n.appendChild(icon(tone));
    n.appendChild(el('span', { class: 'toast-text', text: text == null ? '' : String(text) }));
    var closed = false, timer = null;
    function close() {
      if (closed) return; closed = true;
      if (timer) clearTimeout(timer);
      n.classList.add('is-leaving');
      setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 200);
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
     Modal + confirm
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
      var done = false, release = null, initial = null;
      function finish(v) {
        if (done) return; done = true;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (shellEl && !doc.querySelector('.app-modal-backdrop') && (!paletteEl || paletteEl.hidden)) shellEl.removeAttribute('inert');
        if (release) release();
        lockScroll(false);
        resolve(v);
      }
      (o.actions || [{ label: t('ok'), value: true, primary: true }]).forEach(function (a) {
        var b = el('button', { class: 'btn ' + (a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-secondary'), type: 'button', text: a.label });
        b.addEventListener('click', function () { finish(a.value === undefined ? null : a.value); });
        foot.appendChild(b);
        if (a.autofocus || (!initial && a.primary && !o.danger) || (o.danger && a.value === false)) initial = b;
      });
      box.appendChild(head); box.appendChild(bodyBox); box.appendChild(foot);
      backdrop.appendChild(box);
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && o.dismissible !== false) finish(o.dismissValue === undefined ? null : o.dismissValue); });
      body.appendChild(backdrop);
      if (openMenu) openMenu.close(false);
      if (shellEl) shellEl.setAttribute('inert', '');
      lockScroll(true);
      release = trap(box, function () { if (o.dismissible !== false) finish(o.dismissValue === undefined ? null : o.dismissValue); });
      setTimeout(function () { (initial || foot.lastChild || box).focus(); }, 0);
    });
  }
  function confirmDialog(o) {
    o = o || {};
    return modal({
      title: o.title || t('confirm_title'), body: o.text != null ? o.text : o.body, alert: true, danger: !!o.danger, size: 'sm', dismissValue: false,
      actions: [
        { label: o.cancelText || t('cancel'), value: false },
        { label: o.okText || t('ok'), value: true, primary: !o.danger, danger: !!o.danger }
      ]
    }).then(function (v) { return v === true; });
  }

  /* ------------------------------------------------------------------
     Command palette (Ctrl/⌘K, topbar search)
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
    pBox.appendChild(el('div', { class: 'cmdk-head' }, [icon('search'), pInput, el('kbd', { text: 'Esc' })]));
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
      pFoot.appendChild(el('span', null, [el('kbd', { text: x[0] }), doc.createTextNode(t(x[1]))]));
    });
  }
  function openPalette(q) {
    if (topLayerModalOpen()) return;
    if (!paletteEl) buildPalette();
    if (!paletteEl.hidden) { pInput.focus(); return; }
    if (openMenu) openMenu.close(false);
    if (shellEl && shellEl.classList.contains('is-drawer-open')) closeDrawer(false);
    localizePalette();
    paletteEl.hidden = false;
    if (shellEl) shellEl.setAttribute('inert', '');
    lockScroll(true);
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
    pSeq++;
    if (pTimer) { clearTimeout(pTimer); pTimer = null; }
    if (shellEl && !doc.querySelector('.app-modal-backdrop')) shellEl.removeAttribute('inert');
    lockScroll(false);
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
        var hay = [t('nav_' + it.id), DICT.ar['nav_' + it.id], DICT.en['nav_' + it.id], it.id].map(norm).join(' ');
        if (!nq || hay.indexOf(nq) !== -1) out.push({ group: 'nav', title: t('nav_' + it.id), sub: t(g.label), icon: it.icon, href: it.href });
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
    var p = themePref(), next = p === 'light' ? 'dark' : p === 'dark' ? 'system' : 'light';
    add(t('act_theme', { name: t('theme_' + next) }), next === 'dark' ? 'moon' : next === 'light' ? 'sun' : 'monitor', function () { setTheme(next); }, 'theme dark light سمة داكن فاتح');
    if (canSwitchLang()) add(t('act_lang'), 'languages', function () { switchLang(lang() === 'en' ? 'ar' : 'en'); }, 'language english arabic لغة');
    if (S.status === 'ready') add(t('act_signout'), 'logout', signOut, 'logout sign out خروج');
    else if (S.status === 'signedout') add(t('sign_in'), 'signin', function () { location.href = loginHref(); }, 'login دخول');
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
  var GROUP_LABEL = { nav: 'cmdk_nav', tx: 'cmdk_tx', clients: 'cmdk_clients', requests: 'cmdk_requests', actions: 'cmdk_actions' };
  function renderPalette(q) {
    var items = navMatches(q).concat(remoteItems()).concat(actionMatches(q));
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
    else if (!items.length) msg = t('cmdk_empty');
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
    var target = it.href.split('#'), here = (location.pathname.split('/').pop() || 'index.html');
    if (target[0] === here && target[1] != null) { if (location.hash === '#' + target[1]) window.dispatchEvent(new Event('hashchange')); else location.hash = target[1]; }
    else location.href = it.href;
  }
  doc.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (!IS_APP || doc.querySelector('.app-modal-backdrop') || topLayerModalOpen()) return;
      e.preventDefault();
      if (paletteEl && !paletteEl.hidden) closePalette(); else openPalette();
      return;
    }
    if (k === '/' && IS_APP && !e.ctrlKey && !e.metaKey && !e.altKey && !traps.length && !topLayerModalOpen()) {
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
  function refresh() {
    if (IS_APP && S.status !== 'ready') { S.status = 'loading'; renderAll(); }
    return loadContext(true).then(function (ctx) {
      if (!S.manualActive) S.active = detectActive();
      renderAll();
      return ctx;
    }, function () { S.status = 'error'; renderAll(); return null; });
  }

  var Shell = {
    ready: ready,
    setTitle: setTitle, setActive: setActive, toast: toast, confirm: confirmDialog, modal: modal,
    openPalette: function (q) { if (IS_APP) openPalette(q); }, closePalette: closePalette, refresh: refresh,
    context: function () { return S.ctx; }, orgId: function () { return S.orgId; }, roles: function () { return S.roles.slice(); },
    can: function (roles) { return canAny([].concat(roles || [])); }, isClient: isClient, isPlatformAdmin: isPlatform,
    status: function () { return S.status; },
    NAV: NAV, R: R, t: t
  };
  window.MarsaShell = Shell;

  if (!IS_APP) { readyResolve(null); return; }

  applyTheme();
  build();
  S.active = detectActive();
  renderAll();
  loadContext(false).then(function (ctx) {
    if (!S.manualActive) S.active = detectActive();
    renderAll();
    readyResolve(ctx);
    emit('marsa:shellready', { context: ctx });
  }, function () {
    S.status = 'error'; renderAll(); readyResolve(null);
  });

  window.addEventListener('marsa:langchange', function () { renderAll(); });
  if (api && typeof api.onAuth === 'function') {
    try {
      api.onAuth(function (event) {
        if (event === 'SIGNED_OUT') {
          S.status = 'signedout'; S.ctx = null; S.session = null; S.roles = []; S.orgId = null;
          if (shellEl) renderAll();
        } else if (event === 'SIGNED_IN' && S.status !== 'ready') {
          refresh();
        }
      });
    } catch (e) { /* demo / old supa.js */ }
  }
})();

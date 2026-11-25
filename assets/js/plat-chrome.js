/* =====================================================================
   Platform chrome — the platform's own top bar + right-hand menu on every platform page
   (owner 2026-11-23: «القائمة في اليمين يجب أن تظهر في كل الصفحات في المنصة؛ للمنصة قائمة خاصة
   مختلفة عن قائمة مواقع المشتركين». Picture: docs/owner/designs/staff-panel-mockup.html)
   Pages: admin, ocr, bulk-upload, help, platform (<body class="plat-v2">, assets/css/plat-v2.css).
   Load order: … main.js → supa.js → plat-chrome.js → app-shell.js … (defer). This file builds its frame at
   once (so the page does not jump) and fills it from window.MarsaShell when the shell is ready.

   Menu items: MarsaShell.navItems() (single source of the role rules, assets/js/app-shell.js NAV), grouped in
   the owner's order (GROUPS below). An item the groups do not name lands in «أخرى». The search and the user
   guide live in the top bar, not in the menu. The office website and the client page are previews only
   («معاينة الموقع وصفحة العميل», new tab) — not platform functions.
   Each link carries data-nav-id, so MarsaShell.setActive / setBadge (counts) paint it like before.
   Two panels, two menus (owner 2026-11-23, «فكرة سلة»): the PLATFORM panel (platform.html — the platform owner only:
   subscribed offices, plans, AI keys, system health; no transactions) has its own menu (PF_GROUPS, the sections of
   that page); every other page is the OFFICE panel (the office's staff work) with the GROUPS menu. The user menu
   links one panel to the other when the person has both.
   Hide, not delete: the old site header / footer and admin.html's in-page menu stay in the markup (CSS hides them).
   Texts: assets/i18n/app.js ('app.pl_*', 'app.pnav_*'). Data goes in with textContent only.
   ===================================================================== */
(function () {
  'use strict';
  var doc = document, body = doc.body;
  if (!body || !body.classList.contains('plat-v2')) return;
  var I18N = window.MarsaI18n || null;
  var MINI_KEY = 'marsa_plat_side';      // per device: '1' = folded menu (icons only)
  var GRP_KEY = 'marsa_plat_groups';     // per device: {groupId: true (open) | false (closed)}

  // the owner's order (2026-11-23); ids of app-shell.js NAV
  var GROUPS = [
    { id: 'daily', items: ['dashboard', 'requests', 'register', 'transactions', 'clients', 'ocr', 'alerts', 'schedule'] },
    { id: 'ops', items: ['exceptions', 'parties', 'drivers', 'bulk', 'imports'] },
    { id: 'msg', items: ['inbox', 'messages', 'contacts', 'templates', 'channels'] },
    { id: 'finance', items: ['costs', 'payables', 'payments', 'custody', 'margins', 'demurrage', 'billing', 'daftra'] },
    { id: 'reports', items: ['reports', 'fasah_recon', 'changes'] },
    { id: 'settings', items: ['team', 'org', 'branches', 'requirements', 'attention_rules', 'audit', 'errors', 'legacy_import'] },
    { id: 'account', items: ['portal', 'request', 'tracking'] }
  ];
  var TOP_ONLY = { search: 1, help: 1, platform: 1 };   // in the top bar / the user menu, not in the office menu
  var OPEN_DEFAULT = { daily: true, account: true };
  // the platform panel (platform.html): its own sections, in the owner's order
  var PF_GROUPS = [
    { id: 'pf_offices', items: [['pf_orgs', 'pf-orgs-title', 'building'], ['pf_create', 'pf-create-title', 'userPlus']] },
    { id: 'pf_subs', items: [['pf_subs', 'pf-subs-title', 'chart'], ['pf_plans', 'pf-plans-title', 'receipt']] },
    { id: 'pf_ai', items: [['pf_ai', 'pf-ai-title', 'scan']] },
    { id: 'pf_system', items: [['pf_health', 'pf-health-title', 'shield'], ['pf_errors', 'pf-errors-title', 'alert']] }
  ];
  var PF_PAGE = (document.body.getAttribute('data-page') || '') === 'platform';
  // the old list merged into «المعاملات» (owner 2026-11-18): its detail routes light the register item
  var ADMIN_ACTIVE = { tx: 'register', transactions: 'register', request: 'requests', client: 'clients', import: 'imports', members: 'team' };
  var PAGE_ACTIVE = { ocr: 'ocr', 'bulk-upload': 'bulk', help: 'help', platform: 'platform' };

  function SH() { return window.MarsaShell || null; }
  function t(k, vars) {
    var sh = SH();
    if (sh && typeof sh.t === 'function') return sh.t(k, vars);
    var d = window.MarsaAppDict && (window.MarsaAppDict[lang()] || window.MarsaAppDict.ar);
    return (d && d[k]) || k;
  }
  function has(k) { var s = t(k); return s && s !== k && s !== 'app.' + k; }
  function lang() { return I18N && I18N.lang && I18N.lang() === 'en' ? 'en' : 'ar'; }
  function el(tag, attrs, kids) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }
  function ico(name) {
    var sh = SH();
    if (sh && typeof sh.icon === 'function') return sh.icon(name);
    return el('span', { class: 'icon', 'aria-hidden': 'true' });
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function groupState() { try { var o = JSON.parse(store(GRP_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
  function pageId() { return (body.getAttribute('data-page') || '').toLowerCase(); }

  /* ---------------- frame (built at once) ---------------- */
  var side = el('aside', { class: 'pl-side', id: 'pl-side' });
  var top = el('header', { class: 'pl-top' });
  var backdrop = el('div', { class: 'pl-backdrop', hidden: true });
  body.insertBefore(side, body.firstChild);
  var main = doc.getElementById('main');
  var anchor = doc.querySelector('.site-demo-banner') || main;
  if (anchor && anchor.parentNode === body) body.insertBefore(top, anchor); else body.insertBefore(top, side.nextSibling);
  body.appendChild(backdrop);
  if (store(MINI_KEY) === '1') body.classList.add('pl-mini');

  // nodes the shell fills ([data-shell-*] slots): made once and always in the document (a hidden holder while
  // they are not shown), so the shell's own renders reach them; the menus below only move them
  var orgSlot = el('span', { class: 'pl-brand-org', 'data-shell-orgname': true, hidden: true });
  var userWrap = el('div', { class: 'pl-user' });
  var userBtn = el('button', { class: 'pl-user-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'pl-user-menu' });
  var userMeta = el('div', { class: 'pl-umeta' });
  var secLink = el('a', { href: 'login.html?security=1', 'data-shell-security': true });
  var userMenuEl = el('div', { class: 'pl-user-menu', id: 'pl-user-menu', hidden: true }, [
    userMeta,
    el('div', { 'data-shell-org': true, hidden: true }),
    secLink,
    el('button', { type: 'button', 'data-shell-signout': true }),
    el('button', { type: 'button', 'data-shell-signout-all': true })
  ]);
  userWrap.appendChild(userBtn); userWrap.appendChild(userMenuEl);
  userBtn.addEventListener('click', function () {
    userMenuEl.hidden = !userMenuEl.hidden;
    userBtn.setAttribute('aria-expanded', userMenuEl.hidden ? 'false' : 'true');
  });
  var holder = el('div', { hidden: true }, [orgSlot, userWrap]);
  body.appendChild(holder);

  function closeDrawer(refocus) {
    body.classList.remove('pl-open'); backdrop.hidden = true;
    var mb = doc.querySelector('.pl-menu-btn');
    if (mb) { mb.setAttribute('aria-expanded', 'false'); if (refocus === true) mb.focus(); }
  }
  backdrop.addEventListener('click', closeDrawer);
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (body.classList.contains('pl-open')) closeDrawer(true);
    if (!userMenuEl.hidden) { userMenuEl.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); userBtn.focus(); }
  });
  doc.addEventListener('click', function (e) {
    if (!userMenuEl.hidden && !e.target.closest('.pl-user')) { userMenuEl.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); }
  });

  /* ---------------- side menu ---------------- */
  function renderSide() {
    var sh = SH();
    var status = sh ? sh.status() : 'loading';
    holder.appendChild(orgSlot);
    while (side.firstChild) side.removeChild(side.firstChild);
    side.setAttribute('aria-label', t('pl_menu_aria'));

    var fold = el('button', { class: 'pl-iconbtn pl-fold', type: 'button', title: t('pl_fold'), 'aria-label': t('pl_fold'),
      'aria-pressed': body.classList.contains('pl-mini') ? 'true' : 'false' }, [ico('fold')]);
    fold.addEventListener('click', function () {
      var mini = body.classList.toggle('pl-mini');
      store(MINI_KEY, mini ? '1' : '0');
      fold.setAttribute('aria-pressed', mini ? 'true' : 'false');
    });
    // the office (name + logo, filled by the shell) once signed in; the platform name before that
    var signedIn = !PF_PAGE && status === 'ready' && sh && sh.orgId && sh.orgId();
    var plat = el('span', { class: 'pl-brand-text' }, [el('b', { text: t('brand') }), el('small', { text: t(PF_PAGE ? 'pl_platform_panel' : 'pl_tagline') })]);
    plat.hidden = !!signedIn;
    side.appendChild(el('div', { class: 'pl-brand' }, PF_PAGE ? [el('span', { class: 'pl-brand-mark', 'aria-hidden': 'true' }, [ico('globe')]), plat, fold] : [orgSlot, plat, fold]));

    var nav = el('nav', { class: 'pl-nav', 'aria-label': t('pl_menu_aria') });
    side.appendChild(nav);
    if (PF_PAGE) { renderPlatformMenu(nav, sh, status); paint(); return; }
    var items = status === 'ready' && sh ? sh.navItems() : [];
    if (!items.length) {
      if (status === 'signedout' || status === 'error') {
        nav.appendChild(el('a', { class: 'btn btn-primary btn-block pl-signin', href: 'login.html#staff', text: t('sign_in') }));
      }
    } else {
      var byId = {}, used = {};
      items.forEach(function (it) { byId[it.id] = it; });
      var hasRegister = !!byId.register;
      var openSt = groupState();
      GROUPS.concat([{ id: 'more', items: items.map(function (it) { return it.id; }) }]).forEach(function (g) {
        var rows = g.items.filter(function (id) {
          if (!byId[id] || used[id] || TOP_ONLY[id]) return false;
          if (id === 'transactions' && hasRegister) return false;   // merged into «المعاملات»
          return true;
        }).map(function (id) { used[id] = true; return byId[id]; });
        if (!rows.length) return;
        var open = openSt[g.id] !== undefined ? !!openSt[g.id] : !!OPEN_DEFAULT[g.id];
        if (rows.some(function (r) { return r.id === activeId(); })) open = true;
        var list = el('ul', { class: 'pl-list', id: 'pl-grp-' + g.id });
        var btn = el('button', { class: 'pl-grp-btn', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'pl-grp-' + g.id },
          [el('span', { text: t('pl_grp_' + g.id) }), el('span', { class: 'pl-grp-count', hidden: true }), ico('chevron')]);
        btn.lastChild.setAttribute('class', 'icon pl-chev');
        var grp = el('div', { class: 'pl-grp' + (open ? '' : ' is-closed'), 'data-group': g.id }, [btn, list]);
        btn.addEventListener('click', function () {
          var now = grp.classList.toggle('is-closed');
          btn.setAttribute('aria-expanded', now ? 'false' : 'true');
          var s = groupState(); s[g.id] = !now; store(GRP_KEY, JSON.stringify(s));
          groupCounts();
        });
        rows.forEach(function (it) {
          var label = has('pnav_' + it.id) ? t('pnav_' + it.id) : it.label;
          var href = it.local && it.href.indexOf('#') !== -1 ? '#' + it.href.split('#')[1] : it.href;
          var a = el('a', { class: 'pl-link', href: href, 'data-nav-id': it.id, title: label }, [ico(it.icon || 'info'), el('span', { text: label })]);
          a.addEventListener('click', function () { if (body.classList.contains('pl-open')) closeDrawer(); });
          list.appendChild(el('li', null, [a]));
        });
        nav.appendChild(grp);
      });
    }

    // previews of the office website and the client page (not platform functions)
    var foot = el('div', { class: 'pl-foot' });
    if (status === 'ready') {
      var pvList = el('ul', { class: 'pl-preview-list', id: 'pl-preview', hidden: true }, [
        el('li', null, [el('a', { href: 'office.html', target: '_blank', rel: 'noopener', text: t('pl_preview_site') })]),
        el('li', null, [el('a', { href: 'portal.html', target: '_blank', rel: 'noopener', text: t('pl_preview_portal') })])
      ]);
      var pv = el('a', { class: 'pl-link', href: '#', role: 'button', 'aria-expanded': 'false', 'aria-controls': 'pl-preview', title: t('pl_preview') },
        [ico('eye'), el('span', { text: t('pl_preview') })]);
      pv.addEventListener('click', function (e) {
        e.preventDefault();
        if (body.classList.contains('pl-mini')) { window.open('office.html', '_blank', 'noopener'); return; }
        pvList.hidden = !pvList.hidden;
        pv.setAttribute('aria-expanded', pvList.hidden ? 'false' : 'true');
      });
      foot.appendChild(pv); foot.appendChild(pvList);
    }
    side.appendChild(foot);
    paint();
  }

  // the platform panel menu: links to the sections of platform.html (platform owner only)
  function renderPlatformMenu(nav, sh, status) {
    if (!(status === 'ready' && sh && sh.isPlatformAdmin && sh.isPlatformAdmin())) {
      if (status === 'signedout' || status === 'error') nav.appendChild(el('a', { class: 'btn btn-primary btn-block pl-signin', href: 'login.html#staff', text: t('sign_in') }));
      return;
    }
    PF_GROUPS.forEach(function (g) {
      var list = el('ul', { class: 'pl-list', id: 'pl-grp-' + g.id });
      var head = el('div', { class: 'pl-grp-btn pl-grp-static' }, [el('span', { text: t('pl_grp_' + g.id) })]);
      g.items.forEach(function (it) {
        var label = t('pl_' + it[0]);
        var a = el('a', { class: 'pl-link', href: '#' + it[1], 'data-pf-target': it[1], title: label }, [ico(it[2]), el('span', { text: label })]);
        a.addEventListener('click', function (e) {
          var target = doc.getElementById(it[1]);
          if (!target) return;
          e.preventDefault();
          var card = target.closest('section') || target;
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (history.replaceState) history.replaceState(null, '', '#' + it[1]);
          pfActive = it[1]; markActive();
          if (body.classList.contains('pl-open')) closeDrawer();
        });
        list.appendChild(el('li', null, [a]));
      });
      nav.appendChild(el('div', { class: 'pl-grp', 'data-group': g.id }, [head, list]));
    });
  }
  var pfActive = (location.hash || '').replace(/^#/, '') || 'pf-orgs-title';

  /* ---------------- top bar ---------------- */
  function dates() {
    var box = el('div', { class: 'pl-dates', 'aria-label': t('pl_today') });
    if (typeof Intl === 'undefined') return box;
    var base = lang() === 'en' ? 'en-GB-u-nu-latn' : 'ar-SA-u-nu-latn', now = new Date();
    function fmt(cal, o) { try { return new Intl.DateTimeFormat(base + '-ca-' + cal, o).format(now); } catch (e) { return ''; } }
    box.appendChild(el('span', { text: fmt('gregory', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) }));
    box.appendChild(el('span', { text: fmt('islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }) }));
    return box;
  }
  function renderTop() {
    var sh = SH(), ready = sh && sh.status() === 'ready';
    var lb = top.querySelector('[data-lang-toggle]') || doc.querySelector('.topbar [data-lang-toggle]') || doc.querySelector('[data-lang-toggle]');
    holder.appendChild(userWrap);
    while (top.firstChild) top.removeChild(top.firstChild);

    var menuBtn = el('button', { class: 'pl-iconbtn pl-menu-btn', type: 'button', 'aria-label': t('pl_open_menu'), 'aria-controls': 'pl-side', 'aria-expanded': 'false' }, [ico('menu')]);
    menuBtn.addEventListener('click', function () {
      var open = body.classList.toggle('pl-open');
      backdrop.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var f = side.querySelector('a, button'); if (f) f.focus(); }
    });
    top.appendChild(menuBtn);

    if (ready && !PF_PAGE) {
      var search = el('button', { class: 'pl-search', type: 'button', 'aria-label': t('search_aria') },
        [ico('search'), el('span', { text: t('search_field_hint') }), el('kbd', { text: 'Ctrl K' })]);
      search.addEventListener('click', function () { var s = SH(); if (s && s.openSearch) s.openSearch(); });
      top.appendChild(search);
    }
    top.appendChild(dates());

    var acts = el('div', { class: 'pl-top-actions' });
    if (ready) {
      var items = sh.navItems(), alerts = null, help = null;
      items.forEach(function (it) { if (it.id === 'alerts') alerts = it; if (it.id === 'help') help = it; });
      if (alerts && !PF_PAGE) {
        acts.appendChild(el('a', { class: 'pl-tbtn', href: alerts.local ? '#alerts' : alerts.href, 'data-nav-id': 'alerts', title: alerts.label, 'aria-label': alerts.label }, [ico('bell')]));
      }
      if (help) acts.appendChild(el('a', { class: 'pl-tbtn', href: help.href, title: help.label, 'aria-label': help.label, text: '؟' }));
    }
    if (lb) acts.appendChild(lb);
    if (ready) acts.appendChild(userMenu(sh));
    else if (sh && sh.status() !== 'loading') acts.appendChild(el('a', { class: 'pl-tbtn', href: 'login.html#staff' }, [ico('signin'), el('span', { text: t('sign_in') })]));
    top.appendChild(acts);
    paint();
  }
  function userMenu(sh) {
    var u = sh.user() || { name: '', roles: [] };
    var name = u.name || u.email || '';
    while (userBtn.firstChild) userBtn.removeChild(userBtn.firstChild);
    userBtn.appendChild(el('span', { class: 'pl-av', 'aria-hidden': 'true', text: (name.trim().charAt(0) || '؟') }));
    userBtn.appendChild(el('span', { class: 'pl-uname', text: name }));
    while (userMeta.firstChild) userMeta.removeChild(userMeta.firstChild);
    userMeta.appendChild(el('strong', { text: name }));
    userMeta.appendChild(el('span', { text: (u.roles || []).join('، ') }));
    // the other panel, when the person has it (platform owner <-> office staff)
    var old = userMenuEl.querySelector('.pl-switch'); if (old) old.parentNode.removeChild(old);
    var office = sh.navItems().some(function (it) { return it.id === 'dashboard'; });
    var sw = PF_PAGE ? (office ? ['admin.html', 'pl_office_panel', 'home'] : null)
      : (sh.isPlatformAdmin && sh.isPlatformAdmin() ? ['platform.html', 'pl_platform_panel', 'globe'] : null);
    if (sw) userMenuEl.insertBefore(el('a', { class: 'pl-switch', href: sw[0] }, [ico(sw[2]), el('span', { text: t(sw[1]) })]), secLink);
    return userWrap;
  }

  /* ---------------- active item + counts ---------------- */
  function activeId() {
    var p = pageId();
    if (p === 'admin') {
      var h = (location.hash || '').replace(/^#/, '').split(/[/?]/)[0] || 'dashboard';
      return ADMIN_ACTIVE[h] || h;
    }
    return PAGE_ACTIVE[p] || null;
  }
  function markActive() {
    if (PF_PAGE) {
      side.querySelectorAll('.pl-link[data-pf-target]').forEach(function (a) {
        var on = a.getAttribute('data-pf-target') === pfActive;
        a.classList.toggle('is-active', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
      return;
    }
    var id = activeId();
    side.querySelectorAll('.pl-link[data-nav-id]').forEach(function (a) {
      var on = a.getAttribute('data-nav-id') === id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    top.querySelectorAll('[data-nav-id]').forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
    groupCounts();
  }
  // a closed group shows the sum of its items' live counts on its heading (mockup: «المراسلات 2»)
  function groupCounts() {
    side.querySelectorAll('.pl-grp').forEach(function (g) {
      var c = g.querySelector('.pl-grp-count'); if (!c) return;
      var n = 0;
      g.querySelectorAll('.pl-list .nav-count').forEach(function (s) { if (!s.hidden) { var v = parseInt(s.textContent, 10); if (v > 0) n += v; } });
      c.textContent = n > 99 ? '99+' : String(n);
      c.hidden = !(n > 0 && g.classList.contains('is-closed'));
    });
  }
  function paint() {
    var sh = SH();
    if (sh && typeof sh.setBadge === 'function') {
      ['alerts', 'inbox', 'requests'].forEach(function (id) { try { sh.setBadge(id); } catch (e) { /* optional */ } });
    }
    markActive();
  }
  // the shell / admin.js mark the active item on route changes too: ours wins right after
  window.addEventListener('hashchange', function () { setTimeout(markActive, 0); });
  window.addEventListener('marsa:badgechange', function () { setTimeout(markActive, 0); });

  function render() { renderSide(); renderTop(); }
  render();
  window.addEventListener('marsa:shellready', render);
  window.addEventListener('marsa:contextchange', render);
  window.addEventListener('marsa:langchange', render);
})();

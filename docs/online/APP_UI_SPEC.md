> **Superseded (2026-11-03).** The app shell described below (sidebar/topbar layout, dark theme, `marsa_theme`, theme toggle, split login screen) was removed. The signed-in pages (admin, login, portal, ocr, bulk-upload, platform) use the original efa96c9 design again: marketing topbar, site-header + drawer, demo banner, page-hero with wave and breadcrumb, `.container` sections, site-footer, to-top. There is no dark theme; nothing sets `html[data-theme]`. `assets/js/app-shell.js` is now a "classic" helper (my_context, roles, `navItems()`, `setActive`, `setBadge('alerts')`, `setTitle` → document title + hero breadcrumb, toast/confirm/modal, Ctrl/⌘K palette with `MarsaApi.globalSearch`, org switch via `[data-shell-org]`) that builds no chrome and never moves the page DOM; `assets/css/app.css` only adds component classes on the style.css tokens. PWA (manifest, sw.js, pwa.js `[data-pwa-install]` slot, offline.html) is unchanged in behaviour. The contract is in the header comment of `assets/js/app-shell.js`; the rest of this file is kept for history.

# Marsa app UI — "professional program" spec (staging)

Goal: the signed-in parts of the site look and behave like a professional SaaS application (installable PWA), not like marketing pages. The public marketing pages (index, about, services, contact, calculator, request, tracking) stay as they are.

## App pages
`admin.html` (staff console, already a hash-routed SPA: dashboard, requests, transactions, clients, messages, imports, org, branches, members, audit, errors), `platform.html`, `ocr.html`, `bulk-upload.html`, `portal.html` (client), plus `login.html` as the app sign-in screen and new `offline.html`.

## Layout (app shell)
```
┌ sidebar (RTL: right; LTR: left) ┬ topbar: page title + breadcrumb · search (Ctrl/⌘K) · org switcher · install · lang · theme · user menu
│ logo + org name                 ├──────────────────────────────────────────────
│ nav groups by role              │ content (max-width none; cards, KPI tiles, data tables)
│ collapse ◀                      │
└ env badge "Staging"             ┘
```
- No marketing header/footer/hero/wave on app pages. Full-height layout, sidebar collapsible (icons only; state in localStorage `marsa_sidebar`), off-canvas drawer < 1024px.
- Light + dark theme (`html[data-theme="dark"]`), choice light / dark / system in localStorage `marsa_theme`. Brand: navy `#0B3A6E`, teal `#14A3A8` (see style.css tokens), font Cairo. Dark tokens are defined only in `assets/css/app.css` (marketing pages never get dark).
- Bilingual: everything via `MarsaI18n` (ar default RTL, en LTR). Use logical CSS properties only.

## Shared files (owner: shell task)
- `assets/css/app.css` — tokens (light/dark), shell layout, and components: `.app-card`, `.kpi` (value, label, delta, tone), `.data-table` (sticky header, zebra, hover, compact, numeric alignment, sortable header button `.th-sort[aria-sort]`), `.toolbar` (search input, filters, actions), `.pill`/status badges per tone, buttons (`.btn` variants reused from style.css, restyled for the app), forms, `.app-modal`, `.toast`, `.empty-state`, `.skeleton`, `.tabs`, `.cmdk` palette, `.chart-bars` (pure CSS horizontal bars).
- `assets/js/app-shell.js` → `window.MarsaShell`:
  - builds the shell around the page's `<main id="app-main">` on any page with `<body class="app-page" data-app-page="admin|platform|ocr|bulk|portal|offline">`;
  - `MarsaShell.ready` → Promise resolving to `my_context` data (or null when signed out / demo mode — then the page shows its own gate);
  - `setTitle(title, crumbs[])`, `setActive(navId)`, `toast(text, tone)`, `confirm({title, text, okText, danger}) → Promise<boolean>`;
  - NAV definition (single source for the sidebar), filtered by roles from my_context (server still enforces):
    - staff: لوحة التحكم `admin.html#dashboard` · الطلبات `#requests` · المعاملات `#transactions` · العملاء `#clients` · الرسائل `#messages` · الرفع الجماعي `bulk-upload.html` · قراءة المستندات `ocr.html` · سجل الاستيراد `admin.html#imports`
    - إدارة (org admin / branch_manager / supervisor per admin.js R sets): المؤسسة `#org` · الفروع `#branches` · الأعضاء والدعوات `#members` · سجل التدقيق `#audit` · أخطاء الواجهة `#errors`
    - platform admin: لوحة المنصة `platform.html`
    - client: بوابتي `portal.html` · طلب جديد `request.html` · تتبع شحنة `tracking.html`
    Role sets MUST mirror `VIEWS`/`R` in assets/js/admin.js.
  - command palette (Ctrl/⌘K and the topbar search): jump to any nav item + `MarsaApi.globalSearch(q)` results (transactions by ref / B/L / declaration no. / container no., clients by name/CR/VAT, requests by ref) → open `admin.html#transactions/<id>` etc. (use admin.js's existing detail-route format);
  - user menu: name, roles, active org, profile locale, sign out, sign out of all devices; org switcher uses `MarsaApi.activeOrgId/setActiveOrg` and dispatches `window` event `marsa:orgchange`;
  - topbar slot `[data-pwa-install]` (filled by pwa.js).
- `assets/i18n/app.js` — shell strings (ar + en).
- `assets/js/supa.js` — add `globalSearch(q, {limit})` (RLS-scoped PostgREST queries, `ilike` with escaped `%_`, max 8 per group, `{data:{transactions,clients,requests}, error}`) and `dashboardStats(orgId)` (parallel `count: 'exact', head: true` queries: requests by status, transactions by operational_status, containers pending return / overdue (return_deadline < today) / due in 3 days, documents unreviewed; returns `{data, error}`).

## Standard <head> for app pages
```html
<meta name="theme-color" content="#0B3A6E">
<link rel="manifest" href="manifest.json" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="assets/img/icons/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<script>(function(){try{var t=localStorage.getItem('marsa_theme');if(t==='dark'||(t!=='light'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();</script>
<!-- keep the existing early lang/dir script if the page has one -->
<link rel="stylesheet" href="assets/css/style.css">
<link rel="stylesheet" href="assets/css/app.css">
<link rel="stylesheet" href="assets/css/pages/<page>.css">
```
Script order (all `defer`): `config.js → i18n.js → assets/i18n/<page>.js → assets/i18n/app.js → main.js → supa.js → app-shell.js → pwa.js → <page>.js`.
`crossorigin="use-credentials"` matters: the site is behind HTTP Basic Auth, and a manifest fetched without credentials gets 401.

## PWA (owner: PWA task)
`manifest.json` (name «مرساة كلاود | Marsa Cloud», short_name «مرساة», dir rtl, lang ar, start_url `login.html?source=pwa`, scope `./`, display `standalone`, theme/background colors, icons 192/512 + maskable 512 generated from `assets/img/logo.png` with `sips` into `assets/img/icons/`), `sw.js` at the site root (versioned cache; precache the shell's static files; network-first for navigations and same-origin JS/CSS with cache fallback; cache-first for images/fonts; offline fallback `offline.html` for navigations; NEVER cache or intercept cross-origin requests (Supabase, CDNs) or non-GET; skipWaiting + clients.claim with an "update available — reload" toast via MarsaShell), `assets/js/pwa.js` (register sw.js with scope `./`, `beforeinstallprompt` → install button in `[data-pwa-install]`, iOS hint, hide when already standalone).

## Rules
- Keep every existing feature and data flow working (all MarsaApi calls, demo mode without Supabase config, idempotency handling, invitations, OCR, bulk import).
- Insert data with textContent / createElement (no innerHTML with server or user data).
- No new external dependencies except what pages already load (supabase-js self-hosted under assets/vendor with SRI since 2026-11-03; Tesseract, pdf.js, jsQR still loaded on demand from jsDelivr).
- `node --check` every JS file touched.

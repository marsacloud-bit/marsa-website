/* =====================================================================
   Office website — the office's own identity (owner 2026-11-23, migration 20261213000100)
   Every subscribed office customises its website. Stage A: the pages show what the office keeps in its organisation
   settings («إعدادات المؤسسة»): name, accent colour, phone, e-mail, address, logo.
   Contacts (owner 2026-11-28): the site never shows a phone / e-mail / WhatsApp / address / working hours that does
   not come from the organisation settings. The markup carries NO default value: every contact hook starts hidden
   (class site-c-off, empty text, no href) and is shown only when the office has a valid value. Empty or invalid
   value, no profile, demo (no config.js), offline or an API error → the contact stays hidden. Never a fallback.
   Contact hooks (fixed markup in the site pages):
     [data-site-phone]    tel: link (text in its [dir=ltr] child, else itself)
     [data-site-email]    mailto: link (same)
     [data-site-whatsapp] wa.me link (same); stored 05xxxxxxxx, shown +966 5x xxx xxxx
     [data-site-address]  the address text (ar / en)
     [data-site-hours]    the working hours text (ar / en)
     [data-site-row]      a wrapper meaningless without the hook inside it (an <li> with an icon, a label+value row):
                          shown / hidden together with that hook
     [data-site-group]    a container whose whole purpose is these contacts (top-bar strip, footer «تواصل معنا»
                          column, contact card): hidden while no contact hook inside it is shown
     [data-site-hours-badge]  the «open now» badge (built-in hours only): always hidden
   Identity hooks:
     [data-site-logo]     <img> of the brand (header / drawer / footer): the office logo, or the office name as text
     [data-site-brand]    the brand link: its aria-label becomes the office name
   Stage B (same migration): settings whatsapp / hours_ar / hours_en / about_ar / about_en —
     [data-site-about-page]   «من نحن»: the office text, shown in place of [data-site-story]; the footer blurb too
     [data-site-platform-only] hidden once an office profile is shown (a text about the platform name itself)
     [data-site-swap]      the platform name inside a fixed text / its aria-label → the office name
   <body data-site-contact-only>: only the contact hooks are applied (no colour, title, logo, footer text, swaps),
   for pages whose look must not change.
   Online: MarsaApi.siteProfile() (anon); the last profile is kept in localStorage so the next page opens with it at
   once. The footer texts that name the platform (footer.about / footer.rights) name the office instead.
   window.MarsaSiteProfile.apply(): re-applies the profile — for code that injects contact markup later (tracking.js).
   Data is set with textContent / attributes only. The accent colour is validated (#rrggbb), the text colour on it is
   chosen for contrast, and a colour too light to read on white is darkened.
   CSS: .site-c-off { display: none !important } (assets/css/style.css).
   ===================================================================== */
(function () {
  'use strict';
  var I18N = window.MarsaI18n || null;
  var API = window.MarsaApi || null;
  var KEY = 'marsa_site_profile';
  var HEX = /^#[0-9a-f]{6}$/i;
  var profile = null;
  var logoUrl = null;

  function lang() { return I18N && I18N.lang() === 'en' ? 'en' : 'ar'; }
  function str(v, max) { return typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 300) : ''; }
  function nameOf(p) { return lang() === 'en' ? (str(p.name_en, 160) || str(p.name_ar, 160)) : str(p.name_ar, 160); }

  /* ---------------- colour ---------------- */
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hex(c) { return '#' + c.map(function (v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? '0' + s : s; }).join(''); }
  function mix(c, to, t) { return c.map(function (v, i) { return v + (to[i] - v) * t; }); }
  function lum(c) {
    var a = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  var WHITE = [255, 255, 255], INK = [31, 28, 36];
  function applyColor(c) {
    var body = document.body;
    if (!body || !HEX.test(c || '')) return;
    var base = rgb(c), i = 0;
    while (contrast(base, WHITE) < 3 && i++ < 20) base = mix(base, [0, 0, 0], 0.08);   // readable as text on white
    body.style.setProperty('--accent', hex(base));
    body.style.setProperty('--accent-strong', hex(mix(base, [0, 0, 0], 0.18)));
    body.style.setProperty('--accent-soft', hex(mix(base, WHITE, 0.9)));
    body.style.setProperty('--accent-line', hex(mix(base, WHITE, 0.75)));
    body.style.setProperty('--aqua', hex(mix(base, WHITE, 0.45)));   // the light accent on dark parts (footer lines)
    body.style.setProperty('--on-accent', contrast(base, WHITE) >= 4.5 ? '#ffffff' : hex(INK));
  }

  /* ---------------- contacts (hidden unless the office has a valid value) ---------------- */
  var OFF = 'site-c-off';
  var HOOKS = '[data-site-phone], [data-site-email], [data-site-whatsapp], [data-site-address], [data-site-hours]';
  function all(sel) { return document.querySelectorAll ? document.querySelectorAll(sel) : []; }
  function toggle(el, on) {
    if (!el || !el.classList) return;
    if (on) { if (el.classList.remove) el.classList.remove(OFF); } else el.classList.add(OFF);
  }
  // the hook and the wrapper row that means nothing without it
  function showHook(el, on) {
    toggle(el, on);
    var row = el.closest ? el.closest('[data-site-row]') : null;
    if (row && row !== el) toggle(row, on);
  }
  function textTarget(el) { return (el.querySelector && el.querySelector('[dir="ltr"]')) || el; }
  // a link hook: filled when the value is valid, else hidden and its link removed
  function setLink(sel, href, text) {
    all(sel).forEach(function (a) {
      if (href) {
        a.setAttribute('href', href);
        textTarget(a).textContent = text;
      } else if (a.removeAttribute) a.removeAttribute('href');
      showHook(a, !!href);
    });
  }
  // a text hook (address / hours): the office text, else hidden
  function setText(sel, v) {
    all(sel).forEach(function (el) {
      el.removeAttribute('data-i18n');   // the office text, never the built-in translation
      if (v) el.textContent = v;
      showHook(el, !!v);
    });
  }
  function phoneOf(v) {
    var digits = v.replace(/[^0-9+]/g, '');
    return /^\+?[0-9]{6,16}$/.test(digits) ? digits : '';
  }
  function emailOf(v) { return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v) ? v : ''; }
  // stage B: WhatsApp (stored 05xxxxxxxx) → 9665xxxxxxxx, else ''
  function whatsappOf(v) {
    var d = v.replace(/[^0-9]/g, '');
    if (/^05[0-9]{8}$/.test(d)) d = '966' + d.slice(1);
    else if (/^5[0-9]{8}$/.test(d)) d = '966' + d;
    return /^9665[0-9]{8}$/.test(d) ? d : '';
  }
  function setPhone(v) { var d = phoneOf(v); setLink('[data-site-phone]', d ? 'tel:' + d : '', v); }
  function setEmail(v) { var e = emailOf(v); setLink('[data-site-email]', e ? 'mailto:' + e : '', e); }
  function setWhatsapp(v) {
    var d = whatsappOf(v);
    var shown = d ? '+966 ' + d.slice(3, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8) : '';
    setLink('[data-site-whatsapp]', d ? 'https://wa.me/' + d : '', shown);
  }
  function setAddress(p) {
    setText('[data-site-address]', lang() === 'en' ? (str(p.address_en) || str(p.address_ar)) : str(p.address_ar));
  }
  function setHours(p) {
    setText('[data-site-hours]', lang() === 'en' ? (str(p.hours_en, 120) || str(p.hours_ar, 120)) : str(p.hours_ar, 120));
    // the «open now» badge knows only the built-in hours, not the office's: always hidden
    all('[data-site-hours-badge]').forEach(function (el) {
      if (el.classList) { el.classList.add(OFF); el.classList.add('is-site-off'); }
    });
  }
  // a contacts container is shown only while at least one contact hook inside it is shown
  function setGroups() {
    all('[data-site-group]').forEach(function (g) {
      var hooks = g.querySelectorAll ? g.querySelectorAll(HOOKS) : [], shown = false;
      for (var i = 0; i < hooks.length && !shown; i++) shown = !(hooks[i].classList && hooks[i].classList.contains(OFF));
      toggle(g, shown);
    });
  }
  function setContacts(p) {
    setPhone(str(p.contact_phone, 40));
    setEmail(str(p.contact_email, 200));
    setWhatsapp(str(p.whatsapp, 40));
    setAddress(p);
    setHours(p);
    setGroups();
  }
  function aboutOf(p) { return lang() === 'en' ? (str(p.about_en, 600) || str(p.about_ar, 600)) : str(p.about_ar, 600); }
  // «من نحن» page: the office text in place of the platform story
  function setAboutPage(p) {
    var v = aboutOf(p);
    document.querySelectorAll('[data-site-about-page]').forEach(function (el) { el.textContent = v; el.hidden = !v; });
    document.querySelectorAll('[data-site-story]').forEach(function (el) { el.hidden = !!v; });
    document.querySelectorAll('[data-site-platform-only]').forEach(function (el) { el.hidden = true; });   // texts about the platform name
  }
  // [data-site-swap]: the platform name inside a fixed text (and its aria-label) → the office name
  // the platform display name (one source: MarsaI18n.brand) + the provisional names it replaced
  var BRAND = I18N && typeof I18N.brand === 'function' ? I18N.brand() : 'Blue Sea';
  var BRAND_RE = BRAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var PLATFORM_WORD = new RegExp(BRAND_RE + '|مرسى( MARSA)?|MARSA', 'g');
  function swapText(el, name) {
    // [data-brand] inside a swapped text now shows the office: i18n.js must not refill it
    if (el.querySelectorAll) el.querySelectorAll('[data-brand]').forEach(function (b) { b.removeAttribute('data-brand'); b.removeAttribute('dir'); });
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = walk.nextNode())) {
      if (n._siteOrig === undefined) n._siteOrig = n.nodeValue;
      n.nodeValue = n._siteOrig.replace(PLATFORM_WORD, name);
    }
    var aria = el.getAttribute('aria-label');
    if (aria !== null) {
      if (!el.hasAttribute('data-site-orig-aria')) el.setAttribute('data-site-orig-aria', aria);
      el.setAttribute('aria-label', el.getAttribute('data-site-orig-aria').replace(PLATFORM_WORD, name));
    }
  }
  function setSwaps(name) {
    if (!name) return;
    document.querySelectorAll('[data-site-swap]').forEach(function (el) { swapText(el, name); });
  }
  function setName(name) {
    if (!name) return;
    document.querySelectorAll('[data-site-brand]').forEach(function (a) { a.setAttribute('aria-label', name); a.removeAttribute('data-i18n-attr'); });
    document.title = titled(document.title, name);
  }
  // «مرسى | MARSA — وصف» → «المكتب — وصف»; «من نحن | مرسى MARSA» → «من نحن | المكتب»; «المدونة» → «المدونة | المكتب»
  function titled(t, name) {
    var PLATFORM = new RegExp(BRAND_RE + '|مرسى|MARSA|Marsa');
    var bar = t.indexOf(' | '), dash = t.indexOf(' — ');
    if (bar > 0) {
      var head = t.slice(0, bar);
      if (PLATFORM.test(head)) return name + (dash > 0 ? t.slice(dash) : '');
      return head + ' | ' + name;
    }
    if (t.indexOf(name) >= 0) return t;
    if (PLATFORM.test(t) && dash > 0) return name + t.slice(dash);
    return t + ' | ' + name;
  }
  // the footer texts that name the platform → the office (footer.officeAbout / officeRights, {name})
  // the office «about» text (stage B), when set, is the footer blurb as is
  function setFooter(name, about) {
    if (!name || !I18N || typeof I18N.t !== 'function') return;
    [['footer.about', 'footer.officeAbout'], ['footer.rights', 'footer.officeRights']].forEach(function (k) {
      var tpl = I18N.t(k[1]);
      if (!tpl || tpl === k[1]) return;
      var text = k[0] === 'footer.about' && about ? about : tpl.split('{name}').join(name);
      document.querySelectorAll('[data-i18n="' + k[0] + '"], [data-site-text="' + k[0] + '"]').forEach(function (el) {
        el.removeAttribute('data-i18n');
        el.setAttribute('data-site-text', k[0]);
        el.textContent = text;
      });
    });
  }
  function setLogo(name) {
    document.querySelectorAll('img[data-site-logo]').forEach(function (img) {
      var mark = img.parentNode && img.parentNode.querySelector('.site-wordmark');
      img.removeAttribute('data-i18n-attr');
      if (logoUrl) {
        img.src = logoUrl;
        img.alt = name || '';
        img.hidden = false;
        img.classList.add('is-office-logo');
        if (mark) mark.remove();
      } else if (profile && str(profile.logo_path, 200)) {
        return;   // the office has a logo, its link is still loading: keep what is shown (no flicker)
      } else if (name) {
        img.hidden = true;   // no office logo: the office name as a word mark (never the platform logo)
        if (!mark) { mark = document.createElement('span'); mark.className = 'site-wordmark'; img.parentNode.insertBefore(mark, img.nextSibling); }
        mark.textContent = name;
      }
    });
  }

  function contactOnly() { var b = document.body; return !!(b && b.hasAttribute && b.hasAttribute('data-site-contact-only')); }
  // also runs with no profile at all (demo / offline / error / none): the contacts then stay hidden
  function apply() {
    var p = profile && typeof profile === 'object' ? profile : null;
    if (p && !contactOnly()) {
      var name = nameOf(p);
      applyColor(str(p.brand_color, 7));
      setName(name);
      setLogo(name);
      setFooter(name, aboutOf(p));
      setSwaps(name);
      setAboutPage(p);
    }
    setContacts(p || {});
  }
  window.MarsaSiteProfile = { apply: apply };

  function remember(p) { try { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY); } catch (e) { /* storage off */ } }
  function recalled() { try { var s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  function load() {
    if (!API || typeof API.siteProfile !== 'function' || (API.isOnline && !API.isOnline())) return;
    var cached = recalled();
    if (cached) { profile = cached; logoUrl = null; apply(); }
    API.siteProfile().then(function (r) {
      if (!r || r.error) return;   // keep what is shown
      profile = r.data && typeof r.data === 'object' ? r.data : null;
      remember(profile);
      if (!profile) { logoUrl = null; apply(); return; }   // no office profile: contacts hidden
      var path = str(profile.logo_path, 200);
      if (!path || typeof API.orgLogoUrl !== 'function') { logoUrl = null; apply(); return; }
      API.orgLogoUrl(path, 3600).then(function (u) {
        logoUrl = u && !u.error && typeof u.data === 'string' ? u.data : null;
        apply();
      }, function () { logoUrl = null; apply(); });
    }, function () { /* offline: keep what is shown */ });
  }

  function init() {
    apply();   // hide every contact first (no profile yet): never a default value
    load();
    window.addEventListener('marsa:langchange', function () { apply(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

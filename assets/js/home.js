/* =====================================================================
   Platform home page (index.html, owner 2026-11-24): language button, header shadow, mobile menu,
   the platform name in every [data-brand], and the plan cards.
   Load order: config.js → i18n.js → assets/i18n/home.js → home.js (all defer).
   PLANS: placeholder prices in SAR (owner: «مبدئيًا» until a payment gateway is connected). The plan codes
   match public.plans (20261108000100); limits mirror its seed. When the gateway lands, this list is read
   from the database instead (one place to change), and «choose» opens the checkout.
   ===================================================================== */
(function () {
  'use strict';
  var I = window.MarsaI18n;
  var doc = document;
  function t(k, vars) { return I ? I.t('home.' + k, vars) : k; }
  function lang() { return I ? I.lang() : 'ar'; }
  function num(n) { return Number(n).toLocaleString('en-US'); }   // latin digits 0-9 (owner rule)

  var PLANS = [
    { code: 'basic', name: 'pBasic', desc: 'pBasicD', price: 499,
      lines: [['lUsers', 5], ['lBranch1'], ['lTx', 300], ['lAi', 500], ['lStorage', 10], ['lSupportMail']] },
    { code: 'pro', name: 'pPro', desc: 'pProD', price: 1499, featured: true,
      lines: [['lUser25', 25], ['lBranches', 5], ['lTx', 3000], ['lAi', 5000], ['lStorage', 100], ['lAccounting'], ['lSite'], ['lSupportPrio']] },
    { code: 'enterprise', name: 'pEnt', desc: 'pEntD', price: null,
      lines: [['lUnlimited'], ['lAccounting'], ['lSite'], ['lManager'], ['lCustomInt']] }
  ];

  function el(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return e;
  }
  function check() {
    var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'm5 12 5 5 9-10');
    s.appendChild(p); return s;
  }

  function renderPlans() {
    var box = doc.querySelector('[data-h-plans]');
    if (!box) return;
    box.textContent = '';
    PLANS.forEach(function (p) {
      var price = p.price == null
        ? el('div', { class: 'h-price' }, [el('b', { text: t('custom'), style: 'font-size:32px' })])
        : el('div', { class: 'h-price' }, [el('b', { class: 'h-amount', text: num(p.price) }), el('span', { text: t('perMonth') })]);
      var href = 'contact.html?plan=' + encodeURIComponent(p.code);
      var card = el('article', { class: 'h-plan' + (p.featured ? ' is-featured' : ''), 'data-plan': p.code }, [
        p.featured ? el('span', { class: 'h-plan-badge', text: t('featured') }) : null,
        el('h3', { text: t(p.name) }),
        el('p', { class: 'h-plan-desc', text: t(p.desc) }),
        price,
        el('div', { class: 'h-price-note', text: p.price == null ? t('customNote') : t('vatNote') }),
        el('ul', null, p.lines.map(function (l) {
          return el('li', null, [check(), el('span', { text: t(l[0], l.length > 1 ? { n: num(l[1]) } : undefined) })]);
        })),
        el('a', { class: 'h-btn ' + (p.featured ? 'h-btn-main' : 'h-btn-line'), href: href, text: p.price == null ? t('contactSales') : t('choose') })
      ]);
      box.appendChild(card);
    });
  }

  function fillBrand() {
    var name = t('brand');
    doc.title = t('metaTitle', { brand: name });
    doc.querySelectorAll('[data-brand]').forEach(function (s) { s.textContent = name; });
  }

  function paintLang() {
    var b = doc.querySelector('[data-h-lang]');
    if (!b) return;
    var lab = b.querySelector('[data-h-lang-label]');
    if (lab) lab.textContent = t('langBtn');
    b.setAttribute('aria-label', t('langAria'));
    b.setAttribute('lang', lang() === 'ar' ? 'en' : 'ar');
  }

  function paint() { fillBrand(); renderPlans(); paintLang(); }

  // language button
  var lb = doc.querySelector('[data-h-lang]');
  if (lb && I) lb.addEventListener('click', function () { I.setLang(lang() === 'ar' ? 'en' : 'ar'); });
  window.addEventListener('marsa:langchange', function () { setTimeout(paint, 0); });

  // header: shadow once the page scrolls
  var hdr = doc.querySelector('[data-h-header]');
  function onScroll() { if (hdr) hdr.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // mobile menu
  var mb = doc.querySelector('[data-h-menu]'), dr = doc.querySelector('[data-h-drawer]');
  function setMenu(open) {
    if (!mb || !dr) return;
    dr.classList.toggle('is-open', open);
    mb.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (mb && dr) {
    mb.addEventListener('click', function () { setMenu(!dr.classList.contains('is-open')); });
    dr.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dr.classList.contains('is-open')) { setMenu(false); mb.focus(); } });
  }

  paint();
})();

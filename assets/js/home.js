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

  /* ================= motion (owner 2026-11-24) — all of it off under prefers-reduced-motion ================= */
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var IO = 'IntersectionObserver' in window;
  function whenSeen(node, fn, opts) {
    if (!node) return;
    if (!IO) { fn(); return; }
    var o = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { o.disconnect(); fn(); } }); }, opts || { threshold: 0.2 });
    o.observe(node);
  }

  // reveal sections as they scroll in (staggered inside a group)
  function initReveal() {
    if (REDUCED || !IO) return;
    var groups = ['.h-head', '.h-feats > *', '.h-steps > *', '.h-faq > *', '.h-band', '.h-journey'];
    groups.forEach(function (sel) {
      doc.querySelectorAll(sel).forEach(function (n, i) {
        n.classList.add('h-reveal');
        n.style.setProperty('--d', (Math.min(i % 6, 5) * 0.08) + 's');
        whenSeen(n, function () { n.classList.add('is-in'); }, { threshold: 0.15 });
      });
    });
  }
  function revealPlans() {
    if (REDUCED || !IO) return;
    doc.querySelectorAll('.h-plan').forEach(function (n, i) {
      n.classList.add('h-reveal'); n.style.setProperty('--d', (i * 0.1) + 's');
      whenSeen(n, function () { n.classList.add('is-in'); }, { threshold: 0.15 });
    });
  }

  // numbers count up from 0 (latin digits)
  function initCounters() {
    doc.querySelectorAll('[data-count]').forEach(function (n) {
      var end = Number(n.getAttribute('data-count')) || 0, suf = n.getAttribute('data-suffix') || '';
      if (REDUCED) { n.textContent = num(end) + suf; return; }
      n.textContent = '0' + suf;
      whenSeen(n, function () {
        var t0 = null, dur = 1400;
        function step(ts) {
          if (t0 == null) t0 = ts;
          var p = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          n.textContent = num(Math.round(end * e)) + suf;
          if (p < 1) requestAnimationFrame(step);
        }
        setTimeout(function () { requestAnimationFrame(step); }, 500);
      });
    });
  }

  // moving strip: the items twice, so the loop has no gap
  function initMarquee() {
    var tr = doc.querySelector('[data-h-marquee]');
    if (!tr || tr.getAttribute('data-doubled')) return;
    Array.prototype.slice.call(tr.children).forEach(function (s) { var c = s.cloneNode(true); c.removeAttribute('data-i18n'); c.setAttribute('data-mq-copy', s.getAttribute('data-i18n')); tr.appendChild(c); });
    tr.setAttribute('data-doubled', '1');
  }
  function paintMarquee() {
    doc.querySelectorAll('[data-mq-copy]').forEach(function (c) { c.textContent = I ? I.t(c.getAttribute('data-mq-copy')) : c.textContent; });
  }

  /* ---------------- the journey: one transaction, stage by stage, fake people ---------------- */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(markup, vb) {
    var s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', vb || '0 0 64 64'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = markup;   // static, trusted markup defined below (no user data)
    return s;
  }
  // simple illustrated people (fake): skin, clothes and a head style each
  var PEOPLE = {
    client: { name: 'pClient', role: 'pClientR', skin: '#D9A77E', body: '#F4F1EA', head: 'ghutra' },
    noura:  { name: 'pNoura', role: 'pNouraR', skin: '#E8B48F', body: '#5B4BA8', head: 'hijab', hijab: '#3A3344' },
    ahmed:  { name: 'pAhmed', role: 'pAhmedR', skin: '#C98E66', body: '#2F6B5E', head: 'short', hair: '#2B2420' },
    khaled: { name: 'pKhaled', role: 'pKhaledR', skin: '#B97D57', body: '#D9822B', head: 'cap', cap: '#26212F' },
    reem:   { name: 'pReem', role: 'pReemR', skin: '#F0C3A0', body: '#8F7EDB', head: 'hijab', hijab: '#B4436C' }
  };
  function personSvg(key) {
    var p = PEOPLE[key], h = '';
    h += '<rect width="64" height="64" fill="#EFECF8"/>';
    h += '<path d="M10 64c2-13 11-20 22-20s20 7 22 20z" fill="' + p.body + '"/>';
    if (p.head === 'hijab') h += '<path d="M15 50c-1-16 6-30 17-30s18 14 17 30c-6 4-28 4-34 0z" fill="' + p.hijab + '"/>';
    if (p.head === 'ghutra') h += '<path d="M14 52c0-18 7-31 18-31s18 13 18 31l-6-2c0-10-5-18-12-18s-12 8-12 18z" fill="#fff" stroke="#E2DED6" stroke-width="1"/>';
    h += '<circle cx="32" cy="31" r="11" fill="' + p.skin + '"/>';
    if (p.head === 'short') h += '<path d="M21 29c0-8 5-12 11-12s11 4 11 12c-3-4-7-5-11-5s-8 1-11 5z" fill="' + p.hair + '"/>';
    if (p.head === 'cap') h += '<path d="M20 27c1-7 6-10 12-10s11 3 12 10z" fill="' + p.cap + '"/><path d="M30 26h18c0 2-2 3-4 3H30z" fill="' + p.cap + '"/>';
    if (p.head === 'hijab') h += '<path d="M20 28c1-8 6-12 12-12s11 4 12 12c-3-3-7-5-12-5s-9 2-12 5z" fill="' + p.hijab + '"/>';
    if (p.head === 'ghutra') h += '<path d="M19 27c1-7 6-11 13-11s12 4 13 11c-4-3-8-4-13-4s-9 1-13 4z" fill="#fff" stroke="#E2DED6" stroke-width="1"/><path d="M21 23h22" stroke="#26212F" stroke-width="2.5" stroke-linecap="round"/>';
    h += '<circle cx="28" cy="31" r="1.3" fill="#26212F"/><circle cx="36" cy="31" r="1.3" fill="#26212F"/><path d="M28.5 36c2 1.6 5 1.6 7 0" stroke="#26212F" stroke-width="1.4" fill="none" stroke-linecap="round"/>';
    return svg(h);
  }
  var ICONS = [
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h4"/>',
    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>',
    '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'
  ];
  var STAGES = [
    { who: 'client', s: 'jS1', m: 'jM1', c: 'jC1', st: 'jT1' }, { who: 'noura', s: 'jS2', m: 'jM2', c: 'jC2', st: 'jT2' },
    { who: 'ahmed', s: 'jS3', m: 'jM3', c: 'jC3', st: 'jT3' }, { who: 'ahmed', s: 'jS4', m: 'jM4', c: 'jC4', st: 'jT4' },
    { who: 'khaled', s: 'jS5', m: 'jM5', c: 'jC5', st: 'jT5' }, { who: 'khaled', s: 'jS6', m: 'jM6', c: 'jC6', st: 'jT6' },
    { who: 'reem', s: 'jS7', m: 'jM7', c: 'jC7', st: 'jT7' }
  ];
  var J = { i: -1, timer: null, typer: null, playing: !REDUCED, seen: false, dur: 3600 };
  function q(sel) { return doc.querySelector(sel); }
  function buildTrack() {
    var tr = q('[data-h-track]');
    if (!tr) return;
    tr.textContent = '';
    tr.appendChild(el('span', { class: 'h-track-fill', 'data-h-fill': '' }));
    var truck = el('span', { class: 'h-truck', 'data-h-truck': '' });
    truck.appendChild(svg('<rect x="2" y="6" width="24" height="15" rx="2" fill="#5B4BA8"/><path d="M26 10h7l5 5v6H26z" fill="#4A3C91"/><rect x="29" y="12" width="5" height="4" rx="1" fill="#EFECF8"/>'
      + '<circle cx="10" cy="23" r="3.5" fill="#26212F"/><circle cx="32" cy="23" r="3.5" fill="#26212F"/><path d="M6 10h16M6 14h16" stroke="#EFECF8" stroke-width="1.2"/>', '0 0 44 28'));
    tr.appendChild(truck);
    STAGES.forEach(function (s, i) {
      var dot = el('span', { class: 'h-node-dot' });
      dot.appendChild(svg(ICONS[i], '0 0 24 24'));
      tr.appendChild(el('li', { class: 'h-node', 'data-node': String(i) }, [dot, el('span', { text: t(s.s) })]));
    });
  }
  function typeText(node, text) {
    clearInterval(J.typer);
    if (REDUCED) { node.textContent = text; return; }
    var k = 0, caret = el('span', { class: 'h-caret' });
    node.textContent = ''; node.appendChild(doc.createTextNode('')); node.appendChild(caret);
    J.typer = setInterval(function () {
      k = Math.min(text.length, k + 2);
      node.firstChild.nodeValue = text.slice(0, k);
      if (k >= text.length) { clearInterval(J.typer); setTimeout(function () { if (caret.parentNode) caret.remove(); }, 900); }
    }, 28);
  }
  function show(i) {
    J.i = i;
    var s = STAGES[i], p = PEOPLE[s.who], n = STAGES.length;
    doc.querySelectorAll('.h-node').forEach(function (nd, k) {
      nd.classList.toggle('is-done', k < i || (k === i && i === n - 1));
      nd.classList.toggle('is-now', k === i && i !== n - 1);
    });
    var pct = n > 1 ? i / (n - 1) : 1, span = 86;   // track runs from 7% to 93%
    var fill = q('[data-h-fill]'), truck = q('[data-h-truck]');
    if (fill) fill.style.width = (pct * span) + '%';
    if (truck) truck.style.insetInlineStart = (7 + pct * span) + '%';
    var card = q('[data-h-scene]');
    if (card) { card.classList.remove('is-swap'); void card.offsetWidth; if (!REDUCED) card.classList.add('is-swap'); }
    var ph = q('[data-h-person]'); if (ph) { ph.textContent = ''; ph.appendChild(personSvg(s.who)); }
    var nm = q('[data-h-name]'); if (nm) nm.textContent = t(p.name);
    var rl = q('[data-h-role]'); if (rl) rl.textContent = t(p.role);
    var stp = q('[data-h-step]'); if (stp) stp.textContent = t('jStep', { n: i + 1, t: n });
    var chip = q('[data-h-status]'); if (chip) { chip.textContent = t(s.st); chip.classList.toggle('is-final', i === n - 1); }
    var msg = q('[data-h-msg]'); if (msg) typeText(msg, t(s.m));
    var bar = q('[data-h-bar]');
    if (bar) { bar.classList.remove('is-run'); bar.style.width = '0'; void bar.offsetWidth; if (J.playing) { bar.style.removeProperty('width'); bar.style.setProperty('--h-dur', (J.dur / 1000) + 's'); bar.classList.add('is-run'); } }
    var toast = q('[data-h-toast]'), tm = q('[data-h-toast-msg]'), cl = q('[data-h-client]');
    if (toast && tm) {
      toast.classList.remove('is-show');
      if (cl && !cl.firstChild) cl.appendChild(personSvg('client'));
      setTimeout(function () { tm.textContent = t(s.c); toast.classList.add('is-show'); }, REDUCED ? 0 : 1300);
    }
  }
  function schedule() {
    clearTimeout(J.timer);
    if (!J.playing || !J.seen) return;
    var last = J.i === STAGES.length - 1;
    J.timer = setTimeout(function () { show(last ? 0 : J.i + 1); schedule(); }, last ? J.dur + 1800 : J.dur);
  }
  function paintPlay() {
    var b = q('[data-h-play]'); if (!b) return;
    b.setAttribute('aria-pressed', J.playing ? 'false' : 'true');
    var lab = b.querySelector('[data-h-play-label]'); if (lab) lab.textContent = J.playing ? t('jPause') : t('jPlay');
    var ic = b.querySelector('svg path'); if (ic) ic.setAttribute('d', J.playing ? 'M8 5v14M16 5v14' : 'M7 4l13 8-13 8z');
  }
  function initJourney() {
    var box = q('[data-h-journey]');
    if (!box) return;
    buildTrack();
    show(REDUCED ? STAGES.length - 1 : 0);
    paintPlay();
    var b = q('[data-h-play]');
    if (b) b.addEventListener('click', function () { J.playing = !J.playing; paintPlay(); if (J.playing) { show(J.i === STAGES.length - 1 ? 0 : J.i); } schedule(); });
    doc.querySelectorAll('.h-node').forEach(function (nd) {
      nd.style.cursor = 'pointer';
      nd.addEventListener('click', function () { show(Number(nd.getAttribute('data-node'))); schedule(); });
    });
    if (REDUCED) return;
    if (IO) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { J.seen = e.isIntersecting; if (J.seen) schedule(); else clearTimeout(J.timer); });
      }, { threshold: 0.3 }).observe(box);
    } else { J.seen = true; schedule(); }
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) clearTimeout(J.timer); else schedule(); });
  }
  function repaintJourney() { if (q('[data-h-track]')) { buildTrack(); if (J.i >= 0) show(J.i); paintPlay(); } }

  /* ---------------- the hero panel picture, alive (fake data in a loop; paused off-screen) ---------------- */
  var LIVE = { on: false, timers: [], ref: 231, pool: 0, rows: null };
  var POOL = [['mC4', 'mAv4'], ['mC5', 'mAv5'], ['mC6', 'mAv6'], ['mC1', 'mAv1'], ['mC2', 'mAv2'], ['mC3', 'mAv3']];
  var STATUS = { mS4: '', mS1: 'acc', mS2: 'warn', mS3: 'ok' };
  var NEXT = { mS4: 'mS1', mS1: 'mS2', mS2: 'mS3', mS3: 'mS3' };
  function liveRows() {
    if (!LIVE.rows) LIVE.rows = [{ c: 'mC1', a: 'mAv1', ref: 231, s: 'mS1' }, { c: 'mC2', a: 'mAv2', ref: 230, s: 'mS2' }, { c: 'mC3', a: 'mAv3', ref: 229, s: 'mS3' }];
    return LIVE.rows;
  }
  function rowNode(r, isNew) {
    return el('div', { class: 'h-row' + (isNew ? ' is-new' : '') }, [
      el('span', { class: 'h-av', text: t(r.a) }),
      el('span', { class: 'who' }, [el('b', { text: t(r.c) }), el('small', { class: 'h-num', text: 'CC-2026-' + String(r.ref).padStart(6, '0') })]),
      el('span', { class: 'h-chip ' + (STATUS[r.s] || 'acc'), text: t(r.s) })
    ]);
  }
  function drawRows(newFirst) {
    var box = doc.querySelector('[data-h-list]');
    if (!box) return;
    box.classList.add('is-live');
    box.querySelectorAll('.h-row').forEach(function (n) { n.remove(); });
    liveRows().forEach(function (r, i) { box.appendChild(rowNode(r, newFirst && i === 0)); });
  }
  function liveTick() {
    // a new transaction arrives at the top; the others move one stage on; the oldest leaves
    var rows = liveRows();
    var p = POOL[LIVE.pool % POOL.length]; LIVE.pool++;
    rows.forEach(function (r) { r.s = NEXT[r.s]; });
    rows.unshift({ c: p[0], a: p[1], ref: ++LIVE.ref, s: 'mS4' });
    rows.length = 3;
    drawRows(true);
    var box = doc.querySelector('[data-h-list]');
    if (box) box.querySelectorAll('.h-row:not(.is-new) .h-chip').forEach(function (c) { c.classList.add('is-flip'); });
    // the counters move with it
    var tiles = doc.querySelectorAll('.h-tile b');
    [[0, 1], [3, 1]].forEach(function (x) {
      var b = tiles[x[0]]; if (!b) return;
      var v = (Number(b.getAttribute('data-count')) || 0) + x[1];
      b.setAttribute('data-count', String(v)); b.textContent = num(v);
      b.classList.remove('is-bump'); void b.offsetWidth; b.classList.add('is-bump');
    });
  }
  function liveBars() {
    doc.querySelectorAll('[data-h-bars] i').forEach(function (b, i) {
      b.style.animation = 'none';
      b.style.height = Math.round(30 + 60 * Math.abs(Math.sin((Date.now() / 1700) + i * 0.7)) + i * 1) + '%';
    });
  }
  function liveTabs() {
    var tabs = doc.querySelectorAll('[data-h-tabs] span');
    if (!tabs.length) return;
    var cur = 0; tabs.forEach(function (s, i) { if (s.classList.contains('on')) cur = i; });
    tabs[cur].classList.remove('on'); tabs[(cur + 1) % Math.min(tabs.length, 4)].classList.add('on');
  }
  function liveRead() {
    // the floating card reads the three documents again, one after the other
    var fl = doc.querySelector('[data-h-float]'); if (!fl) return;
    var docs = fl.querySelectorAll('.h-doc'), foot = fl.querySelector('[data-h-ffoot]');
    fl.classList.add('is-reading');
    if (foot) foot.classList.add('is-wait');
    docs.forEach(function (d) { d.classList.add('is-wait'); var b = d.querySelector('b'); if (b) b.textContent = '…'; });
    docs.forEach(function (d, i) {
      LIVE.timers.push(setTimeout(function () {
        var b = d.querySelector('b'), end = Number(b && b.getAttribute('data-count')) || 0, k = 0;
        d.classList.remove('is-wait');
        var iv = setInterval(function () { k = Math.min(end, k + 7); if (b) b.textContent = k + '%'; if (k >= end) clearInterval(iv); }, 40);
        if (i === docs.length - 1) LIVE.timers.push(setTimeout(function () { fl.classList.remove('is-reading'); if (foot) foot.classList.remove('is-wait'); }, 700));
      }, 900 + i * 900));
    });
  }
  function liveStart() {
    if (LIVE.on || REDUCED) return;
    LIVE.on = true;
    LIVE.timers.push(setInterval(liveTick, 4200));
    LIVE.timers.push(setInterval(liveBars, 2200));
    LIVE.timers.push(setInterval(liveTabs, 3000));
    LIVE.timers.push(setInterval(liveRead, 9000));
    setTimeout(liveBars, 1800);
  }
  function liveStop() { LIVE.on = false; LIVE.timers.forEach(function (x) { clearInterval(x); clearTimeout(x); }); LIVE.timers = []; }
  function initLive() {
    var shot = doc.querySelector('.h-shot');
    if (!shot || REDUCED) return;
    if (IO) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && !doc.hidden) setTimeout(liveStart, 2200); else liveStop(); }); }, { threshold: 0.25 }).observe(shot);
    } else setTimeout(liveStart, 2200);
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) liveStop(); });
  }

  /* ---------------- the port story: the ship docks, the crane unloads EVERY container one after the other into the
     customs yard, «تم الفسح», the containers leave, the ship sails on — then again (owner 2026-11-24) ---------------- */
  function initPort() {
    var svgEl = doc.querySelector('[data-h-port]');
    if (!svgEl || REDUCED) return;
    var fleet = svgEl.querySelector('[data-h-fleet]'), trolley = svgEl.querySelector('[data-h-trolley]');
    var cable = svgEl.querySelector('[data-h-cable]'), stamp = svgEl.querySelector('[data-h-stamp]');
    var boxes = Array.prototype.slice.call(svgEl.querySelectorAll('.h-sbox'));
    if (!fleet || !trolley || !cable || !boxes.length) return;
    var T0 = 897, CAB = 29, LIFT = 30;                                   // trolley centre, cable top, carried box top
    var COLS = [1112, 1148, 1184, 1220], ROWS = [88, 72];                // the yard: 4 columns x 2 rows
    var st = { seen: false };
    function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
    function waitSeen() {
      return new Promise(function (res) { (function chk() { if (st.seen && !doc.hidden) res(); else setTimeout(chk, 400); })(); });
    }
    function tween(ms, fn) {
      return waitSeen().then(function () {
        return new Promise(function (res) {
          var t0 = null;
          function step(ts) {
            if (t0 == null) t0 = ts;
            var p = Math.min(1, (ts - t0) / ms);
            fn(ease(p));
            if (p < 1) requestAnimationFrame(step); else res();
          }
          requestAnimationFrame(step);
        });
      });
    }
    function wait(ms) { return waitSeen().then(function () { return new Promise(function (r) { setTimeout(r, ms); }); }); }
    function lerp(a, b, p) { return a + (b - a) * p; }
    var tx = 0, ch = 3;   // trolley offset, cable height
    function setTrolley(v) { tx = v; trolley.setAttribute('transform', 'translate(' + v + ' 0)'); }
    function setCable(h) { ch = h; cable.setAttribute('height', String(Math.max(1, h))); }
    function setBox(b, dx, dy, op) { b._dx = dx; b._dy = dy; b.setAttribute('transform', 'translate(' + dx + ' ' + dy + ')'); if (op != null) b.style.opacity = op; }
    function setFleet(x) { fleet.setAttribute('transform', 'translate(' + x + ' 0)'); }
    function setStamp(s, op) { stamp.style.opacity = op; stamp.setAttribute('transform', 'translate(1166 44) scale(' + s + ') translate(-1166 -44)'); }
    // unload order: the top row first, then the bottom row
    var order = boxes.slice().sort(function (a, b) { return Number(a.getAttribute('data-y')) - Number(b.getAttribute('data-y')) || Number(a.getAttribute('data-x')) - Number(b.getAttribute('data-x')); });
    function reset() {
      boxes.forEach(function (b) { setBox(b, 0, 0, 1); });
      setTrolley(0); setCable(3); setStamp(0.3, 0); setFleet(-1000);
    }
    function unload(b, k) {
      var bx = Number(b.getAttribute('data-x')), by = Number(b.getAttribute('data-y'));
      var sx = COLS[k % COLS.length], sy = ROWS[Math.floor(k / COLS.length) % ROWS.length];
      var over = bx + 15 - T0, slot = sx + 15 - T0;
      var t1 = tx, c1 = ch;
      return tween(520, function (p) { setTrolley(lerp(t1, over, p)); setCable(lerp(c1, 3, p)); })                 // over the box
        .then(function () { return tween(340, function (p) { setCable(lerp(3, by - CAB, p)); }); })                // cable down
        .then(function () { return tween(420, function (p) { setBox(b, 0, lerp(0, LIFT - by, p)); setCable(lerp(by - CAB, LIFT - CAB, p)); }); })   // lift
        .then(function () { return tween(680, function (p) { setTrolley(lerp(over, slot, p)); setBox(b, lerp(0, sx - bx, p), LIFT - by); }); })      // carry
        .then(function () { return tween(420, function (p) { setBox(b, sx - bx, lerp(LIFT - by, sy - by, p)); setCable(lerp(LIFT - CAB, sy - CAB, p)); }); })   // set down
        .then(function () { return tween(260, function (p) { setCable(lerp(sy - CAB, 3, p)); }); });              // cable up
    }
    function cycle() {
      reset();
      return tween(4200, function (p) { setFleet(lerp(-1000, 0, 1 - Math.pow(1 - p, 3))); })                      // sail in, slow down
        .then(function () { return wait(500); })
        .then(function () { return order.reduce(function (pr, b, k) { return pr.then(function () { return unload(b, k); }); }, Promise.resolve()); })
        .then(function () { var t1 = tx; return tween(500, function (p) { setTrolley(lerp(t1, 0, p)); }); })
        .then(function () { return tween(520, function (p) { setStamp(p < 0.7 ? lerp(0.3, 1.18, p / 0.7) : lerp(1.18, 1, (p - 0.7) / 0.3), Math.min(1, p * 2)); }); })   // «تم الفسح»
        .then(function () { return wait(1800); })
        .then(function () { return tween(800, function (p) { boxes.forEach(function (b) { b.style.opacity = String(1 - p); }); setStamp(1, 1 - p); }); })   // cleared, gone
        .then(function () { return wait(400); })
        .then(function () { return tween(3800, function (p) { setFleet(lerp(0, -1100, p * p)); }); })              // the empty ship sails on
        .then(function () { return wait(600); })
        .then(cycle);
    }
    if (IO) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { st.seen = e.isIntersecting; }); }, { threshold: 0.05 }).observe(svgEl);
    } else st.seen = true;
    reset();
    cycle();
  }

  initMarquee();
  paint();
  paintMarquee();
  initReveal();
  revealPlans();
  initCounters();
  initJourney();
  initLive();
  initPort();
  window.addEventListener('marsa:langchange', function () { setTimeout(function () { paintMarquee(); revealPlans(); repaintJourney(); if (LIVE.rows) drawRows(false); }, 0); });
})();

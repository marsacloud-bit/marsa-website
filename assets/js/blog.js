/* =====================================================================
   Office website — blog rendering (owner 2026-11-22)
   blog.html: article list, or one article with ?post=<slug>.
   index.html: the latest 3 articles in [data-blog-latest].
   Source: window.MarsaBlogPosts (assets/js/blog-posts.js). textContent only.
   ===================================================================== */
(function () {
  'use strict';
  var I18N = window.MarsaI18n || null;
  var $ = function (id) { return document.getElementById(id); };

  function posts() { return Array.isArray(window.MarsaBlogPosts) ? window.MarsaBlogPosts : []; }
  function lang() { return I18N && I18N.lang() === 'en' ? 'en' : 'ar'; }
  function tr(key, fallback) {
    if (!I18N) return fallback;
    var v = I18N.t(key);
    return (v && v !== key) ? v : fallback;
  }
  function pick(v) { return (v && typeof v === 'object') ? (v[lang()] || v.ar || '') : (v || ''); }
  function fmtDate(iso) {
    var d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return iso;
    var loc = lang() === 'en' ? 'en-GB-u-nu-latn' : 'ar-SA-u-nu-latn-ca-gregory';
    try { return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(d); }
    catch (e) { return iso; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function slugOk(s) { return typeof s === 'string' && /^[a-z0-9-]{1,80}$/.test(s); }

  function card(p) {
    var a = el('a', 'hm-card hm-post-card');
    a.href = 'blog.html?post=' + encodeURIComponent(p.slug);
    var meta = el('div', 'hm-post-meta');
    meta.appendChild(el('span', null, pick(p.tag)));
    meta.appendChild(el('span', null, fmtDate(p.date)));
    a.appendChild(meta);
    a.appendChild(el('h3', null, pick(p.title)));
    a.appendChild(el('p', null, pick(p.summary)));
    a.appendChild(el('span', 'hm-more', tr('blog.read', 'اقرأ المقال')));
    return a;
  }
  function fill(box, list) {
    if (!box) return;
    box.textContent = '';
    list.forEach(function (p) { if (p && slugOk(p.slug)) box.appendChild(card(p)); });
  }

  function renderBody(box, blocks) {
    box.textContent = '';
    (blocks || []).forEach(function (b) {
      if (!b) return;
      if (b.h) box.appendChild(el('h2', null, b.h));
      else if (b.p) box.appendChild(el('p', null, b.p));
      else if (Array.isArray(b.ul)) {
        var ul = el('ul');
        b.ul.forEach(function (t) { ul.appendChild(el('li', null, t)); });
        box.appendChild(ul);
      }
    });
  }

  var baseTitle = document.title;
  function renderBlogPage() {
    var listView = $('blog-list-view'), postView = $('blog-post-view'), missing = $('blog-missing');
    if (!listView || !postView) return;
    var slug = null;
    try { slug = new URLSearchParams(location.search).get('post'); } catch (e) { slug = null; }
    if (!slug) {
      listView.hidden = false; postView.hidden = true; if (missing) missing.hidden = true;
      fill($('blog-list'), posts());
      document.title = tr('blog.doc_title', baseTitle);
      return;
    }
    var p = slugOk(slug) ? posts().filter(function (x) { return x && x.slug === slug; })[0] : null;
    listView.hidden = true;
    if (!p) { postView.hidden = true; if (missing) missing.hidden = false; return; }
    if (missing) missing.hidden = true;
    postView.hidden = false;
    $('post-tag').textContent = pick(p.tag);
    $('post-date').textContent = fmtDate(p.date);
    $('post-title').textContent = pick(p.title);
    $('post-summary').textContent = pick(p.summary);
    renderBody($('post-body'), p.body && (p.body[lang()] || p.body.ar));
    document.title = pick(p.title) + ' — ' + tr('blog.doc_title', baseTitle);
  }

  function renderHome() {
    var box = document.querySelector('[data-blog-latest]');
    if (!box) return;
    var list = posts().slice(0, 3);
    var section = box.closest('section');
    if (section) section.hidden = list.length === 0;
    fill(box, list);
  }

  function render() { renderBlogPage(); renderHome(); }
  function init() {
    render();
    window.addEventListener('marsa:langchange', render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

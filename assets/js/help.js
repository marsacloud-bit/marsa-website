/* ==========================================================================
   مرسى | MARSA — help.html  (user guides, G7 step ١٢ — docs/online/G7_SPEC.md §help.html)
   Load order: config.js → i18n.js → assets/i18n/help.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → help.js  (plain <script defer>)

   * Source of truth: docs/guide/<lang>/<id>.md (ar | en, following MarsaI18n).
     Route: help.html#<id>; ids: index, admin, ops, finance, client-portal, platform.
     Unknown hash → index. Readable signed out (static text; no RPC is called).
   * Fetched same-origin only (relative path built from the whitelisted id, never
     from the hash text). Over 200 KB → refused. Failure (file://, not deployed) →
     a bilingual message with the file path.
   * In-house Markdown SUBSET → DOM with createElement / textContent only:
       # / ## / ###, paragraphs, "- " and "1." lists, | tables (→ table.table.adm-table
       in .table-wrap), "> " notes (→ .card note), ``` fenced code (→ pre > code),
       **bold**, `code`, links [t](x.md) / [t](#id) to another guide only (→ in-page route).
     A line that is only an HTML comment (<!-- env:staging --> / <!-- /env -->) is skipped:
     scripts/build-release.sh drops the staging-only lines between those markers from the
     production release. Any other link, raw HTML and images stay plain text. No innerHTML anywhere.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n || null;
  var Shell = window.MarsaShell || null;
  var GUIDES = ['index', 'admin', 'ops', 'finance', 'client-portal', 'platform'];
  var MAX_BYTES = 200 * 1024;
  var DEFAULT_ID = 'index';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function tr(k, vars) {
    var key = 'help.' + k;
    return I && typeof I.t === 'function' ? I.t(key, vars) : key;
  }
  // a string in a given language (the bilingual failure message shows both)
  function trIn(l, k, vars) {
    var D = window.MarsaHelpDict || {};
    var s = (D[l] || {})[k];
    if (s == null) return tr(k, vars);
    return String(s).replace(/\{(\w+)\}/g, function (m, n) { return vars && vars[n] != null ? String(vars[n]) : m; });
  }
  function lang() { return I && typeof I.lang === 'function' && I.lang() === 'en' ? 'en' : 'ar'; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

  /* ======================================================================
     ROUTE
     ====================================================================== */
  function guideId(hash) {
    var id = String(hash == null ? location.hash : hash).replace(/^#/, '').split(/[?&/]/)[0].toLowerCase();
    return GUIDES.indexOf(id) !== -1 ? id : DEFAULT_ID;
  }
  function guidePath(l, id) { return 'docs/guide/' + l + '/' + id + '.md'; }

  /* ======================================================================
     MARKDOWN SUBSET → DOM
     ====================================================================== */
  // link target → guide id (only another guide: x.md, ./x.md, ../ar/x.md, #x), else null
  function linkTarget(href) {
    var s = String(href || '').trim();
    var m = /^#([a-z0-9-]+)$/i.exec(s) || /^(?:\.{0,2}\/)*(?:(?:ar|en)\/)?([a-z0-9-]+)\.md(?:#[a-z0-9-]*)?$/i.exec(s);
    if (!m) return null;
    var id = m[1].toLowerCase();
    return GUIDES.indexOf(id) !== -1 ? id : null;
  }
  // inline: **bold**, `code`, [t](x.md|#id); everything else literal text
  var INLINE_SRC = '(`[^`\\n]+`)|(\\*\\*[^*\\n]+?\\*\\*)|(!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\))';
  function inline(parent, text) {
    var s = String(text), last = 0, m;
    var re = new RegExp(INLINE_SRC, 'g');   // own lastIndex per call (bold recurses)
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      var tok = m[0];
      if (m[1]) parent.appendChild(h('code', { text: tok.slice(1, -1) }));
      else if (m[2]) { var b = h('strong'); inline(b, tok.slice(2, -2)); parent.appendChild(b); }
      else {
        var lm = /^(!?)\[([^\]]*)\]\(([^)]*)\)$/.exec(tok);
        var id = lm && !lm[1] ? linkTarget(lm[3]) : null;
        if (id) parent.appendChild(h('a', { href: '#' + id, 'data-help-link': id, text: lm[2] || id }));
        else parent.appendChild(document.createTextNode(tok));   // image / external / javascript: link → plain text
      }
      last = m.index + tok.length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
    return parent;
  }
  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|' && t.charAt(t.length - 2) !== '\\') t = t.slice(0, -1);
    var cells = [], cur = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c === '\\' && t.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  function isSepRow(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); }
  function table(lines) {
    var head = splitRow(lines[0]);
    var bodyRows = lines.slice(isSepRow(lines[1] || '') ? 2 : 1).map(splitRow);
    var tbody = h('tbody');
    bodyRows.forEach(function (r) {
      var tr0 = h('tr');
      for (var i = 0; i < head.length; i++) tr0.appendChild(inline(h('td'), r[i] == null ? '' : r[i]));
      tbody.appendChild(tr0);
    });
    var thr = h('tr');
    head.forEach(function (c) { thr.appendChild(inline(h('th', { scope: 'col' }), c)); });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table table-striped adm-table help-table' }, [h('thead', null, thr), tbody]));
  }
  // → DocumentFragment
  function render(md) {
    var frag = document.createDocumentFragment();
    var lines = String(md || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    var i = 0, para = [];
    function flush() { if (para.length) { frag.appendChild(inline(h('p'), para.join(' '))); para = []; } }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\s*```/.exec(line);
      if (fence) {
        flush();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;   // closing fence (or end of file)
        frag.appendChild(h('pre', { class: 'help-pre', dir: 'ltr' }, h('code', { text: code.join('\n') })));
        continue;
      }
      if (/^\s*$/.test(line) || /^\s*<!--.*-->\s*$/.test(line)) { flush(); i++; continue; }
      var hm = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (hm) {
        flush();
        var lvl = hm[1].length;   // # → h2 (the page h1 is the hero), ## → h3, ### → h4
        frag.appendChild(inline(h('h' + (lvl + 1), { class: 'help-h' + lvl }), hm[2]));
        i++; continue;
      }
      if (/^\s*\|/.test(line)) {
        flush();
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        frag.appendChild(table(rows));
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        var note = h('div', { class: 'card help-note', role: 'note' });
        var qp = [];
        q.concat(['']).forEach(function (ql) {
          if (/^\s*$/.test(ql)) { if (qp.length) { note.appendChild(inline(h('p'), qp.join(' '))); qp = []; } }
          else qp.push(ql.trim());
        });
        frag.appendChild(note);
        continue;
      }
      var ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flush();
        var ordered = !ul, list = h(ordered ? 'ol' : 'ul', { class: 'help-list' });
        var re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
        var li = null;
        while (i < lines.length) {
          var lm = re.exec(lines[i]);
          if (lm) { li = inline(h('li'), lm[1]); list.appendChild(li); i++; continue; }
          // continuation line of the previous item (indented, not a new block)
          if (li && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { li.appendChild(document.createTextNode(' ')); inline(li, lines[i].trim()); i++; continue; }
          break;
        }
        frag.appendChild(list);
        continue;
      }
      para.push(line.trim());
      i++;
    }
    flush();
    return frag;
  }

  /* ======================================================================
     PAGE
     ====================================================================== */
  var listEl = $('[data-help-list]'), article = $('[data-help-article]'), statusEl = $('[data-help-status]');
  var seq = 0, current = null;

  function renderList(active) {
    if (!listEl) return;
    clear(listEl);
    GUIDES.forEach(function (id) {
      var a = h('a', { class: 'help-nav-link' + (id === active ? ' is-active' : ''), href: '#' + id, 'data-help-guide': id,
        'aria-current': id === active ? 'page' : null }, [
        h('span', { class: 'help-nav-title', text: tr('guide_' + id) }),
        h('span', { class: 'help-nav-sub text-xs text-muted', text: tr('guide_' + id + '_sub') })
      ]);
      listEl.appendChild(h('li', null, a));
    });
  }
  function setStatus(text) { if (statusEl) { statusEl.textContent = text || ''; statusEl.hidden = !text; } }
  function failBox(path, why) {
    // bilingual on purpose: the reader may not have the guide in either language yet
    return h('div', { class: 'alert alert-warning help-fail', role: 'alert', 'data-help-fail': why }, [
      h('p', { class: 'mb-0', lang: 'ar', dir: 'rtl', text: trIn('ar', why === 'large' ? 'failLarge' : 'failLoad') }),
      h('p', { class: 'mb-0', lang: 'en', dir: 'ltr', text: trIn('en', why === 'large' ? 'failLarge' : 'failLoad') }),
      h('p', { class: 'mb-0' }, [h('span', { text: trIn(lang(), 'failPath') + ' ' }), h('code', { dir: 'ltr', text: path })])
    ]);
  }
  function setTitle(id) {
    var t = tr('guide_' + id);
    if (Shell && typeof Shell.setTitle === 'function') Shell.setTitle(tr('title'), id === DEFAULT_ID ? [] : [{ label: t }]);
    else document.title = tr('title') + ' | مرسى MARSA';
    if (Shell && typeof Shell.setActive === 'function') Shell.setActive('help');
  }
  function fetchText(path) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
    return fetch(path, { credentials: 'same-origin', cache: 'no-cache' }).then(function (res) {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      var len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
      if (len > MAX_BYTES) { var e = new Error('large'); e.large = true; throw e; }
      return res.text();
    }).then(function (txt) {
      var bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(txt).length : txt.length * 3;
      if (bytes > MAX_BYTES) { var e = new Error('large'); e.large = true; throw e; }
      return txt;
    });
  }
  function show(id) {
    var l = lang(), path = guidePath(l, id), my = ++seq;
    current = id;
    renderList(id);
    setTitle(id);
    if (!article) return Promise.resolve();
    article.setAttribute('lang', l);
    article.setAttribute('dir', l === 'en' ? 'ltr' : 'rtl');
    article.setAttribute('data-help-id', id);
    article.setAttribute('aria-busy', 'true');
    clear(article);
    setStatus(tr('loading'));
    return fetchText(path).then(function (txt) {
      if (my !== seq) return;
      clear(article).appendChild(render(txt));
      article.removeAttribute('aria-busy');
      setStatus('');
    }, function (err) {
      if (my !== seq) return;
      clear(article).appendChild(failBox(path, err && err.large ? 'large' : 'load'));
      article.removeAttribute('aria-busy');
      setStatus('');
    });
  }
  function route() {
    var id = guideId();
    var raw = String(location.hash || '').replace(/^#/, '');
    // unknown / empty hash → index (the address bar shows the guide actually rendered)
    if (raw && raw !== id && history && typeof history.replaceState === 'function') {
      try { history.replaceState(null, '', location.pathname + location.search + '#' + id); } catch (e) { /* ignore */ }
    }
    return show(id);
  }
  // single-column layout (help.css: max-width 900px): the guide list sits above the article
  function stacked() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches); } catch (e) { return false; }
  }
  window.addEventListener('hashchange', function () {
    // review fix: a same-page anchor — the shared skip link «#main» first of all — is not a guide route: when the hash
    // names an element of this page (and is not a guide id) the guide being read stays. Any other unknown hash → index.
    var frag = String(location.hash || '').replace(/^#/, '');
    var raw = frag.split(/[?&/]/)[0].toLowerCase();
    var anchor = null;
    try { anchor = frag ? document.getElementById(decodeURIComponent(frag)) : null; } catch (e) { anchor = document.getElementById(frag); }
    if (raw && GUIDES.indexOf(raw) === -1 && anchor) return;
    route();
    if (!article) return;
    // review fix: on phone / tablet widths bring the newly chosen guide into view (it renders below the list)
    var bring = stacked() && typeof article.scrollIntoView === 'function';
    if (bring) { try { article.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } }
    if (typeof article.focus === 'function') { try { article.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  });
  window.addEventListener('marsa:langchange', function () { if (current) show(current); });

  // exposed for the jsdom checks (no state, no network)
  window.MarsaHelp = { render: render, guideId: guideId, linkTarget: linkTarget, GUIDES: GUIDES.slice(), MAX_BYTES: MAX_BYTES, show: show };
  route();
})();

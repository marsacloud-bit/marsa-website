/* ==========================================================================
   مرسى | MARSA — G3 operations: shared UI kit (MarsaOps.ui) + the #alerts view
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("Module hook", "UI scope"). Loaded before admin.js,
   which merges MarsaOps.views into its routing and calls
   view.render(root, api, param) with
     api = { orgId, roles, can(setName), t, el, toast, confirm, modal, go(hash), refresh(),
             MarsaApi, label(domain, code), fmtDate, fmtMoney }.

   MarsaOps.ui is defined here (this file must be loaded together with the other
   ops views; they only use it at render time, so the order among them does not
   matter). It holds the strings lookup ('ops.<k>' via MarsaI18n, else
   window.MarsaOpsDict), DOM helpers, pills/tones, table / toolbar / empty /
   loading state, API plumbing ({data, error}, idempotency keys kept until a
   definite answer, MRS_UNKNOWN_RESULT messages) and a form modal that validates
   in place and stays open on server errors.

   * The UI only hides — RLS and the guarded RPCs are the gate.
   * Server and user data are inserted with textContent / createElement only;
     innerHTML is used for the constant SVG icon strings below.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  Ops.txSections = Ops.txSections || [];

  /* ==================================================================
     MarsaOps.ui — shared kit
     ================================================================== */
  var doc = document;
  function I18N() { return window.MarsaI18n; }
  function lang() { var I = I18N(); return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function interp(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
  }
  function dictGet(k) {
    var D = window.MarsaOpsDict || {};
    var s = (D[lang()] || {})[k];
    return s == null ? (D.ar || {})[k] : s;
  }
  function t(k, vars) {
    var I = I18N(), key = 'ops.' + k;
    if (I && typeof I.t === 'function') {
      var s = I.t(key, vars);
      if (s != null && s !== key) return s;
    }
    var d = dictGet(k);
    return interp(d == null ? k : d, vars);
  }
  function has(k) {
    var I = I18N();
    if (I && typeof I.has === 'function' && I.has('ops.' + k)) return true;
    return dictGet(k) != null;
  }
  var NONE = '—';

  // label of a code: ops.<domain>_<code>; the shared domains prefer the server's status_labels
  var SERVER_DOMAINS = { document_kind: 'doc', operational_status: 'stage' };
  function lab(domain, code, api) {
    if (code == null || code === '') return NONE;
    var own = (SERVER_DOMAINS[domain] || domain) + '_' + code;
    if (SERVER_DOMAINS[domain] && api && typeof api.label === 'function') {
      try { var s = api.label(domain, code); if (s && s !== code && s !== domain + '.' + code) return s; } catch (e) { /* fall back */ }
    }
    return has(own) ? t(own) : String(code);
  }

  // --- DOM ---------------------------------------------------------------
  var BOOL = { checked: 1, disabled: 1, selected: 1, required: 1, readOnly: 1, multiple: 1, hidden: 1 };
  function append(n, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return append(n, c);
      n.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c)));
    });
    return n;
  }
  function el(tag, attrs, kids) {
    var n = doc.createElement(tag), value;
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'value') value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (BOOL[k]) n[k] = true;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    append(n, kids);
    if (value !== undefined) n.value = String(value);   // after <option>s exist
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  var ICONS = {
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    truck: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    building: '<rect x="4" y="3" width="18" height="18" rx="1.5"/><path d="M9 21v-4h6v4M8 7h2M14 7h2M8 11h2M14 11h2"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    chevronStart: '<path d="m9 6 6 6-6 6"/>',
    chevronEnd: '<path d="m15 6-6 6 6 6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
  };
  function icon(name, cls) {
    var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICONS[name] || ICONS.info;   // constant markup only
    return s;
  }
  function btn(label, cls, onClick, attrs) {
    var b = el('button', Object.assign({ class: 'btn btn-sm ' + (cls || 'btn-secondary'), type: 'button' }, attrs || {}), label);
    if (onClick) b.addEventListener('click', function (e) { e.preventDefault(); onClick(b, e); });
    return b;
  }
  function ltr(v) { return v == null || v === '' ? NONE : el('bdi', { dir: 'ltr', class: 'num', text: v }); }

  // --- tones / pills -----------------------------------------------------
  var TONES = {
    severity: { critical: 'danger', warning: 'warning', info: 'info' },
    alert_status: { open: 'danger', acknowledged: 'warning', resolved: 'success' },
    appt_status: { requested: 'info', confirmed: 'brand', completed: 'success', missed: 'danger', cancelled: 'neutral', rescheduled: 'neutral' },
    trip_status: { planned: 'info', dispatched: 'brand', loaded: 'warning', delivered: 'success', cancelled: 'neutral' },
    exception_status: { open: 'danger', in_progress: 'warning', resolved: 'success', waived: 'neutral' }
  };
  function tone(domain, code) { return (TONES[domain] || {})[code] || 'neutral'; }
  // status words use the original style.css badges (.badge.badge-<colour>, no dot), as admin.js badgeCls()
  var BADGE_CLS = { success: 'success', warning: 'warning', danger: 'danger', info: 'blue', brand: 'teal', neutral: 'muted' };
  function pill(toneName, text) {
    return el('span', { class: 'badge badge-' + (BADGE_CLS[toneName] || 'muted'), 'data-tone': toneName || 'neutral', text: text });
  }
  function statusPill(domain, code, api) { return pill(tone(domain, code), lab(domain, code, api)); }

  // --- dates / money ------------------------------------------------------
  function toDate(v) { if (!v) return null; var d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; }
  function locale() { var I = I18N(); return I && typeof I.locale === 'function' ? I.locale() : (lang() === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn-ca-gregory'); }
  function fmtDate(v, time, api) {
    var d = toDate(v);
    if (!d) return v ? String(v) : NONE;
    var I = I18N();
    if (I && typeof I.fmtDate === 'function') { try { return I.fmtDate(d, { time: !!time }); } catch (e) { /* fall through */ } }
    if (api && typeof api.fmtDate === 'function') { try { return api.fmtDate(d, { time: !!time }); } catch (e) { /* fall through */ } }
    return d.toISOString().replace('T', ' ').slice(0, time ? 16 : 10);
  }
  function fmtTime(v) {
    var d = toDate(v);
    if (!d) return NONE;
    try { return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return d.toTimeString().slice(0, 5); }
  }
  function fmtDay(d) {
    try { return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'short' }); }
    catch (e) { return d.toDateString(); }
  }
  function fmtMoney(n, cur, api) {
    if (n == null || n === '' || isNaN(+n)) return NONE;
    var I = I18N();
    if (I && typeof I.fmtMoney === 'function') { try { return I.fmtMoney(+n, cur || 'SAR'); } catch (e) { /* fall through */ } }
    if (api && typeof api.fmtMoney === 'function') { try { return api.fmtMoney(+n, cur || 'SAR'); } catch (e) { /* fall through */ } }
    return (+n).toFixed(2) + ' ' + (cur || 'SAR');
  }
  function startOfDay(d) { var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function isoDay(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  // days from today (local midnight) to v: <0 overdue, 0 today
  function daysFrom(v) {
    var d = toDate(v);
    if (!d) return null;
    return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  }
  function dueNode(v, done) {
    var n = daysFrom(v);
    if (n == null) return el('span', { class: 'ops-muted', text: t('al_no_due') });
    var txt = n < 0 ? t('overdue_by', { n: -n }) : n === 0 ? t('due_today') : n === 1 ? t('tomorrow') : t('due_in', { n: n });
    var cls = done ? 'ops-due' : n < 0 ? 'ops-due is-overdue' : n <= 1 ? 'ops-due is-soon' : 'ops-due';
    return el('span', { class: cls }, [el('span', { class: 'ops-due-main', text: txt }), el('span', { class: 'cell-sub', text: fmtDate(v, true) })]);
  }
  function localInput(v) {   // ISO → <input type=datetime-local> value
    var d = toDate(v); if (!d) return '';
    return isoDay(d) + 'T' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function fromLocalInput(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }

  // --- text helpers ------------------------------------------------------
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[ً-ْـ]/g, '')
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
  }
  function matches(q, parts) { var nq = norm(q); return !nq || norm(parts.filter(function (p) { return p != null; }).join(' ')).indexOf(nq) !== -1; }
  function nn(v) { v = v == null ? '' : String(v).trim(); return v === '' ? null : v; }
  function pick(row, keys) {   // first non-empty of row[key] / row.a.b
    for (var i = 0; i < keys.length; i++) {
      var v = keys[i].split('.').reduce(function (o, k) { return o == null ? null : o[k]; }, row);
      if (v != null && v !== '') return v;
    }
    return null;
  }
  function partyName(p) { return p ? ((lang() === 'en' && p.name_en) || p.name_ar || p.name_en || NONE) : NONE; }
  // supa.js list readers embed transactions(id, ref, branch_id); RPC readers may flatten it
  function txRef(row) { return pick(row, ['transaction_ref', 'tx_ref', 'transactions.ref', 'transaction.ref']); }

  // --- API plumbing ------------------------------------------------------
  function sdk(api) { return (api && api.MarsaApi) || window.MarsaApi || null; }
  function call(api, name) {
    var args = Array.prototype.slice.call(arguments, 2), M = sdk(api);
    if (!M || typeof M[name] !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', fn: name, message: t('api_missing', { fn: name }) } });
    return Promise.resolve().then(function () { return M[name].apply(M, args); }).then(function (r) {
      return r && typeof r === 'object' && ('data' in r || 'error' in r) ? r : { data: r == null ? null : r, error: null };
    }, function (e) { return { data: null, error: e || { message: 'error' } }; });
  }
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.items || d.data)) || []; }
  function countOf(d) {
    if (typeof d === 'number') return d;
    if (d && typeof d === 'object' && !Array.isArray(d)) { var c = d.count != null ? d.count : d.total; if (c != null && !isNaN(+c)) return +c; }
    return Array.isArray(d) ? d.length : null;
  }
  function errCode(e) {
    if (!e) return null;
    if (e.code && /^MRS_/.test(e.code)) return e.code;
    var m = (e.raw && e.raw.message) || e.message;
    return /^MRS_[A-Z_]+$/.test(m || '') ? m : (e.code || null);
  }
  function errField(e) { return e ? (e.field || (e.raw && (e.raw.details || e.raw.detail)) || null) : null; }
  function isForbidden(e) { var c = errCode(e); return c === 'MRS_FORBIDDEN' || c === 'RLS' || c === 'MRS_RLS' || c === '42501'; }
  // supa.js maps a unique violation (23505) to code 'DUPLICATE'
  function isUnique(e) { var c = errCode(e); return c === 'DUPLICATE' || c === '23505' || c === 'MRS_DUPLICATE' || c === 'MRS_CONFLICT' || !!(e && e.raw && e.raw.code === '23505'); }
  function errMsg(e, api) {
    var c = errCode(e);
    if (c === 'MRS_UNKNOWN_RESULT') return t('unknown_result');
    if (c === 'MRS_IN_PROGRESS') return t('in_progress');
    if (c === 'MRS_IDEMPOTENCY_CONFLICT') return t('idem_conflict');
    if (c === 'MRS_DEMO_MODE') return t('demo');
    if (c === 'MRS_UNAVAILABLE') return t('api_missing', { fn: e.fn || '' });
    if (isForbidden(e)) return t('forbidden');
    // legacy step 8: a raw technical failure (network, timeout, expired session, 5xx) in plain Arabic / English (MarsaShell.techKnown)
    var SH = window.MarsaShell;
    if (!c && SH && typeof SH.techKnown === 'function') { try { var tk = SH.techKnown(e); if (tk) return tk; } catch (x) { /* fall through */ } }
    var M = sdk(api);
    if (M && typeof M.errorMessage === 'function') { try { var s = M.errorMessage(e); if (s) return s; } catch (x) { /* fall through */ } }
    return (e && e.message) || String(e || '');
  }
  // one key per scope while the payload is unchanged and the last answer was not definite
  var IDEM = {};
  function newKey(api) {
    var M = sdk(api);
    if (M && typeof M.newIdemKey === 'function') { try { return M.newIdemKey(); } catch (e) { /* fall through */ } }
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function idemKey(api, scope, payload) {
    var sig; try { sig = JSON.stringify(payload); } catch (e) { sig = String(Math.random()); }
    var c = IDEM[scope];
    if (!c || c.sig !== sig) c = IDEM[scope] = { sig: sig, key: newKey(api) };
    return c.key;
  }
  function idemSettle(scope, err) {
    var c = errCode(err);
    if (c !== 'MRS_UNKNOWN_RESULT' && c !== 'MRS_IN_PROGRESS') delete IDEM[scope];
  }
  function toast(api, text, toneName) {
    if (api && typeof api.toast === 'function') return api.toast(text, toneName);
    if (window.MarsaShell && typeof window.MarsaShell.toast === 'function') return window.MarsaShell.toast(text, toneName);
    return null;
  }
  function confirmAsk(api, o) {
    if (api && typeof api.confirm === 'function') return Promise.resolve(api.confirm(o)).then(function (v) { return !!v; });
    if (window.MarsaShell && typeof window.MarsaShell.confirm === 'function') return window.MarsaShell.confirm(o);
    return Promise.resolve(window.confirm(o.text || o.title));
  }
  function can(api, set) { try { return !!(api && typeof api.can === 'function' && api.can(set)); } catch (e) { return false; } }
  function go(api, hash) { if (api && typeof api.go === 'function') api.go(hash); else location.hash = hash; }

  // a render scope: async work checks alive() before touching a root that was re-rendered or left
  function scope(root) {
    var seq = (root.__opsSeq || 0) + 1;
    root.__opsSeq = seq;
    return { alive: function () { return root.__opsSeq === seq && root.isConnected !== false; } };
  }

  // --- building blocks ---------------------------------------------------
  function head(title, sub, actions) {
    return el('header', { class: 'app-page-head ops-head' }, [
      el('div', { class: 'ops-head-main' }, [el('h2', { class: 'ops-title', text: title }), sub ? el('p', { class: 'app-page-sub', text: sub }) : null]),
      actions && actions.length ? el('div', { class: 'app-page-actions' }, actions) : null
    ]);
  }
  function card(title, body, actions, o) {
    o = o || {};
    return el('section', { class: 'app-card ops-card' + (o.flush ? ' is-flush' : '') + (o.cls ? ' ' + o.cls : ''), 'aria-label': o.aria || null }, [
      title || (actions && actions.length) ? el('header', { class: 'app-card-head' }, [
        el('div', null, [title ? el('h3', { class: 'app-card-title', text: title }) : null, o.sub ? el('p', { class: 'app-card-sub', text: o.sub }) : null]),
        actions && actions.length ? el('div', { class: 'ops-card-actions' }, actions) : null
      ]) : null,
      el('div', { class: 'app-card-body' }, body)
    ]);
  }
  function emptyState(iconName, title, text, actions, compact) {
    return el('div', { class: 'empty-state' + (compact ? ' is-compact' : '') }, [
      el('div', { class: 'empty-state-icon' }, icon(iconName || 'inbox')),
      title ? el('h3', { class: 'empty-state-title', text: title }) : null,
      text ? el('p', { text: text }) : null,
      actions && actions.length ? el('div', { class: 'empty-state-actions' }, actions) : null
    ]);
  }
  function alertBox(type, text, actions) {
    return el('div', { class: 'alert alert-' + type + ' ops-alert', role: type === 'danger' ? 'alert' : 'status' }, [
      icon(type === 'danger' || type === 'warning' ? 'alert' : 'info'), el('div', { class: 'ops-alert-text', text: text }),
      actions && actions.length ? el('div', { class: 'ops-alert-actions' }, actions) : null
    ]);
  }
  function errorState(api, e, onRetry) {
    var c = errCode(e);
    if (c === 'MRS_DEMO_MODE') return emptyState('info', null, t('demo'));
    if (isForbidden(e)) return emptyState('alert', null, t('forbidden'));
    return alertBox('danger', t('load_failed', { msg: errMsg(e, api) }), onRetry ? [btn(t('retry'), 'btn-secondary', onRetry)] : null);
  }
  // the original admin loading state (.adm-loading: centred spinner + muted text, as admin.js loadingBox)
  function skeleton() {
    return el('div', { class: 'adm-loading', role: 'status' }, [el('span', { class: 'adm-spinner', 'aria-hidden': 'true' }), t('loading')]);
  }
  function loadingInto(host) {
    clear(host);
    host.setAttribute('aria-busy', 'true');
    host.appendChild(skeleton());
  }
  function doneLoading(host) { host.removeAttribute('aria-busy'); clear(host); }
  // headers: [label | {label, num, cls}] · trs: <tr> nodes
  function table(headers, trs, o) {
    o = o || {};
    // the original admin list table (.table.table-striped.adm-table in .table-wrap), as #transactions
    return el('div', { class: 'table-wrap adm-table-wrap ops-table-wrap' }, el('table', { class: 'table table-striped adm-table ops-table' }, [
      o.caption ? el('caption', { class: 'ops-sr', text: o.caption }) : null,
      el('thead', null, el('tr', null, headers.map(function (h) {
        h = typeof h === 'string' ? { label: h } : h;
        return el('th', { scope: 'col', class: (h.num ? 'num ' : '') + (h.cls || '') || null, text: h.label });
      }))),
      el('tbody', null, trs)
    ]));
  }
  function td(kids, cls) { return el('td', { class: cls || null }, kids == null || kids === '' ? NONE : kids); }
  function twoLine(main, sub, mainLtr) {
    return [mainLtr ? el('bdi', { dir: 'ltr', class: 'cell-main num', text: main || NONE }) : el('span', { class: 'cell-main', text: main || NONE }),
      sub ? el('span', { class: 'cell-sub', text: sub }) : null];
  }
  function txLink(row) {
    var id = pick(row, ['transaction_id', 'tx_id']);
    var ref = txRef(row);
    if (!id) return ref ? ltr(ref) : NONE;
    return el('a', { class: 'ops-ref', href: '#tx/' + id }, el('bdi', { dir: 'ltr', text: ref || String(id).slice(0, 8) }));
  }
  // select with options [[value, label]] or optgroups {group, options}
  function select(name, label, options, value, onChange) {
    var s = el('select', { class: 'form-control is-sm', name: name, 'aria-label': label, title: label }, options.map(function (o) {
      if (o && o.group) return el('optgroup', { label: o.group }, o.options.map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
      return el('option', { value: o[0], text: o[1] });
    }));
    s.value = value == null ? '' : String(value);
    if (onChange) s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function searchBox(value, label, onInput) {
    var inp = el('input', { class: 'form-control is-sm', type: 'search', value: value || '', placeholder: t('search_ph'), 'aria-label': label || t('search'), autocomplete: 'off' });
    var timer = null;
    inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { onInput(inp.value); }, 160); });
    return el('div', { class: 'toolbar-search' }, [icon('search'), inp]);
  }
  function toolbar(searchNode, filters, actions, countText) {
    return el('div', { class: 'toolbar ops-toolbar', role: 'search' }, [
      searchNode || null,
      filters && filters.length ? el('div', { class: 'toolbar-filters' }, filters) : null,
      el('div', { class: 'toolbar-actions' }, [countText != null ? el('span', { class: 'toolbar-count', 'aria-live': 'polite', text: countText }) : null].concat(actions || []))
    ]);
  }
  // the original admin stat tile (.card.card-stat.adm-tile, as admin.js kpiNode): centred, value first,
  // label under it; a danger / warning tone with a non-zero value tints the tile (.adm-tile-danger / -warning)
  function kpi(label, value, toneName, o) {
    o = o || {};
    var tag = o.onClick ? 'button' : 'div';
    var hot = (toneName === 'danger' || toneName === 'warning') && value != null && value !== '' && value !== 0 && value !== '0';
    var n = el(tag, { class: 'card card-stat adm-tile ops-kpi' + (hot ? ' adm-tile-' + toneName : '') + (o.active ? ' is-active' : ''),
      type: o.onClick ? 'button' : null, 'aria-pressed': o.onClick ? String(!!o.active) : null, title: o.onClick ? t('al_kpi_hint') : null }, [
      el('span', { class: 'stat-value num', text: value == null ? NONE : String(value) }),
      el('span', { class: 'stat-label', text: label }),
      o.foot ? el('span', { class: 'adm-tile-foot text-xs text-muted', text: o.foot }) : null
    ]);
    if (o.onClick) n.addEventListener('click', function (e) { e.preventDefault(); o.onClick(); });
    return n;
  }
  function kitMissing(root) { clear(root).appendChild(el('div', { class: 'alert alert-danger', role: 'alert', text: t('kit_missing') })); }

  /* ------------------------------------------------------------------
     Form modal
     o = { title, size ('sm'|'lg'), intro (text|Node), warn (text), submitText, danger,
           fields: [{ name, label, type: text|email|tel|number|date|datetime-local|textarea|select|checkbox|checks,
                      value, required, max (maxlength), min/maxNum (number range), pattern (RegExp), patternMsg,
                      options [[value,label]] (select / checks), list [values] (datalist), ltr, hint, full,
                      placeholder, rows, step, autocomplete }],
           validate(values) → {field: message} | null,
           fieldMap {serverField: formField}, uniqueField, uniqueMsg,
           submit(values) → Promise<{data, error}> }
     → Promise<data | null (dismissed)>. Field errors and server errors are shown in place; the
     dialog stays open until a definite success, so a retry after MRS_UNKNOWN_RESULT re-sends
     the same idempotency key (the caller derives it from the values).
     ------------------------------------------------------------------ */
  var modalN = 0;
  function formModal(o) {
    return new Promise(function (resolve) {
      var id = 'ops-m' + (++modalN), titleId = id + '-t';
      var backdrop = el('div', { class: 'app-modal-backdrop ops-modal-backdrop' });
      var box = el('div', { class: 'app-modal ops-modal' + (o.size === 'sm' ? ' is-sm' : o.size === 'lg' ? ' is-lg' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
      var form = el('form', { class: 'ops-form', novalidate: true, id: id + '-f' });
      var formErr = el('div', { class: 'ops-form-error', hidden: true });
      var ctl = {}, errs = {};
      var grid = el('div', { class: 'ops-form-grid' });
      (o.fields || []).forEach(function (f) { grid.appendChild(fieldNode(f)); });
      if (o.intro) form.appendChild(typeof o.intro === 'string' ? el('p', { class: 'ops-modal-intro', text: o.intro }) : o.intro);
      if (o.warn) form.appendChild(alertBox('warning', o.warn));
      form.appendChild(formErr);
      form.appendChild(grid);
      var cancelB = el('button', { class: 'btn btn-secondary', type: 'button', text: o.cancelText || t('cancel') });
      var okText = o.submitText || t('save');
      var okB = el('button', { class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), type: 'submit', form: form.id, text: okText });
      // the original admin dialog close button (.adm-dialog-x: 38px white circle, teal on hover)
      var closeB = el('button', { class: 'adm-dialog-x ops-modal-x', type: 'button', 'aria-label': t('close'), title: t('close') }, icon('x'));
      box.appendChild(el('div', { class: 'app-modal-head' }, [el('h2', { class: 'app-modal-title', id: titleId, text: o.title }), closeB]));
      box.appendChild(el('div', { class: 'app-modal-body' }, form));
      box.appendChild(el('div', { class: 'app-modal-foot' }, [cancelB, okB]));
      backdrop.appendChild(box);

      var busy = false, done = false, prevFocus = doc.activeElement;
      // classic page (no app shell): the page's own top-level blocks (topbar, header, main, footer…)
      // are made inert while the modal is open; only the ones this modal changed are restored.
      var inertEls = [];
      function finish(v) {
        if (done) return; done = true;
        doc.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        inertEls.forEach(function (n) { n.removeAttribute('inert'); });
        if (!doc.querySelector('.app-modal-backdrop')) doc.documentElement.classList.remove('app-lock');
        if (prevFocus && prevFocus.focus && doc.contains(prevFocus)) { try { prevFocus.focus(); } catch (e) { /* ignore */ } }
        resolve(v);
      }
      function dismiss() { if (!busy) finish(null); }
      function focusables() {
        return Array.prototype.filter.call(box.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])'),
          function (n) { return !n.closest('[hidden]'); });
      }
      function onKey(e) {
        if (done) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
        if (e.key !== 'Tab') return;
        var list = focusables(); if (!list.length) return;
        var first = list[0], last = list[list.length - 1], a = doc.activeElement;
        if (!box.contains(a)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      }
      cancelB.addEventListener('click', dismiss);
      closeB.addEventListener('click', dismiss);
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) dismiss(); });

      function fieldNode(f) {
        var fid = id + '-' + f.name, hintId = fid + '-h', errId = fid + '-e', c;
        var err = el('span', { class: 'form-error', id: errId, hidden: true });
        errs[f.name] = err;
        var describedBy = (f.hint ? hintId + ' ' : '') + errId;
        if (f.type === 'checkbox') {
          c = el('input', { type: 'checkbox', id: fid, name: f.name, checked: !!f.value, 'aria-describedby': describedBy });
          ctl[f.name] = c;
          return el('div', { class: 'form-group ops-field' + (f.full ? ' is-full' : '') }, [
            el('label', { class: 'check ops-check' }, [c, el('span', { text: f.label })]),
            f.hint ? el('span', { class: 'form-hint', id: hintId, text: f.hint }) : null, err
          ]);
        }
        if (f.type === 'checks') {
          var vals = Array.isArray(f.value) ? f.value : [];
          var set = el('fieldset', { class: 'ops-checks', 'aria-describedby': describedBy }, [el('legend', { class: 'form-label' }, [f.label, f.required ? el('span', { class: 'ops-req', 'aria-hidden': 'true', text: ' *' }) : null])]);
          (f.options || []).forEach(function (p) {
            set.appendChild(el('label', { class: 'check ops-check' }, [el('input', { type: 'checkbox', name: f.name, value: p[0], checked: vals.indexOf(p[0]) !== -1 }), el('span', { text: p[1] })]));
          });
          ctl[f.name] = set;
          return el('div', { class: 'form-group ops-field' + (f.full ? ' is-full' : '') }, [set, f.hint ? el('span', { class: 'form-hint', id: hintId, text: f.hint }) : null, err]);
        }
        var common = { class: 'form-control', id: fid, name: f.name, required: !!f.required, dir: f.ltr ? 'ltr' : null, placeholder: f.placeholder || null,
          'aria-describedby': describedBy, autocomplete: f.autocomplete || 'off' };
        if (f.type === 'select') {
          c = el('select', common, (f.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
          c.value = f.value == null ? '' : String(f.value);
        } else if (f.type === 'textarea') {
          c = el('textarea', Object.assign(common, { rows: f.rows || 3, maxlength: f.max || null }));
          c.value = f.value == null ? '' : String(f.value);
        } else {
          var listId = f.list ? fid + '-l' : null;
          c = el('input', Object.assign(common, { type: f.type || 'text', maxlength: f.max || null, min: f.minNum != null ? f.minNum : null, max: f.maxNum != null ? f.maxNum : null,
            step: f.step || null, list: listId, inputmode: f.inputmode || null }));
          c.value = f.value == null ? '' : String(f.value);
          if (listId) c.__list = el('datalist', { id: listId }, f.list.map(function (v) { return el('option', { value: v }); }));
        }
        ctl[f.name] = c;
        return el('div', { class: 'form-group ops-field' + (f.full || f.type === 'textarea' ? ' is-full' : '') }, [
          el('label', { class: 'form-label', for: fid }, [f.label, f.required ? el('span', { class: 'ops-req', 'aria-hidden': 'true', text: ' *' }) : null]),
          c, c.__list || null, f.hint ? el('span', { class: 'form-hint', id: hintId, text: f.hint }) : null, err
        ]);
      }
      function values() {
        var v = {};
        (o.fields || []).forEach(function (f) {
          var c = ctl[f.name];
          if (f.type === 'checkbox') v[f.name] = !!c.checked;
          else if (f.type === 'checks') v[f.name] = Array.prototype.filter.call(c.querySelectorAll('input'), function (i) { return i.checked; }).map(function (i) { return i.value; });
          else v[f.name] = String(c.value == null ? '' : c.value).trim();
        });
        return v;
      }
      function setErr(name, msg) {
        var e = errs[name], c = ctl[name];
        if (!e) return false;
        e.textContent = msg || ''; e.hidden = !msg;
        if (c) { if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); }
        if (c && c.parentNode) c.closest('.form-group').classList.toggle('has-error', !!msg);
        return true;
      }
      function showFormErr(msg, kind) {
        clear(formErr);
        formErr.hidden = !msg;
        if (msg) formErr.appendChild(alertBox(kind || 'danger', msg));
      }
      function check(v) {
        var bad = {};
        (o.fields || []).forEach(function (f) {
          var x = v[f.name];
          if (f.required && (f.type === 'checks' ? !x.length : f.type === 'checkbox' ? false : x === '')) { bad[f.name] = f.requiredMsg || t('required'); return; }
          if (x === '' || x == null || f.type === 'checks' || f.type === 'checkbox') return;
          if (f.max && x.length > f.max) bad[f.name] = t('too_long', { n: f.max });
          else if (f.type === 'number' && (isNaN(+x) || (f.minNum != null && +x < f.minNum) || (f.maxNum != null && +x > f.maxNum))) bad[f.name] = t('num_range', { min: f.minNum != null ? f.minNum : '', max: f.maxNum != null ? f.maxNum : '' });
          else if (f.pattern && !f.pattern.test(x)) bad[f.name] = f.patternMsg || t('invalid');
          else if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)) bad[f.name] = t('email_invalid');
        });
        var extra = o.validate ? o.validate(v) : null;
        Object.keys(extra || {}).forEach(function (k) { if (extra[k] && !bad[k]) bad[k] = extra[k]; });
        return bad;
      }
      function setBusy(on) {
        busy = on;
        box.setAttribute('aria-busy', on ? 'true' : 'false');
        okB.disabled = on; cancelB.disabled = on; closeB.disabled = on;
        okB.textContent = on ? t('saving') : okB.__label || okText;
      }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        var v = values();
        Object.keys(errs).forEach(function (k) { setErr(k, null); });
        showFormErr(null);
        var bad = check(v), names = Object.keys(bad);
        if (names.length) {
          names.forEach(function (k) { if (!setErr(k, bad[k])) showFormErr(bad[k]); });
          if (names.length > 1) showFormErr(t('form_errors'));
          var first = ctl[names[0]];
          if (first) { var fc = first.tagName === 'FIELDSET' ? first.querySelector('input') : first; if (fc && fc.focus) fc.focus(); }
          return;
        }
        setBusy(true);
        Promise.resolve().then(function () { return o.submit(v); }).then(function (r) {
          r = r || {};
          if (done) return;
          setBusy(false);
          if (!r.error) { finish(r.data === undefined ? true : (r.data == null ? true : r.data)); return; }
          var c = errCode(r.error);
          if (c === 'MRS_UNKNOWN_RESULT' || c === 'MRS_IN_PROGRESS') {
            okB.__label = t('retry_safe'); okB.textContent = okB.__label;
            showFormErr(errMsg(r.error), 'warning');
            return;
          }
          var field = errField(r.error);
          field = field && o.fieldMap && o.fieldMap[field] ? o.fieldMap[field] : field;
          if (isUnique(r.error) && o.uniqueField) { setErr(o.uniqueField, o.uniqueMsg || t('unique_taken')); focusField(o.uniqueField); return; }
          if (field && ctl[field] && (c === 'MRS_INVALID' || c === 'MRS_REQUIRED' || c === 'MRS_TOO_LONG' || c === 'MRS_DUPLICATE' || c === 'MRS_CONFLICT')) {
            setErr(field, c === 'MRS_REQUIRED' ? t('required') : (c === 'MRS_DUPLICATE' || c === 'MRS_CONFLICT') ? (o.uniqueMsg || t('unique_taken')) : errMsg(r.error));
            focusField(field);
            return;
          }
          showFormErr(errMsg(r.error));
        }, function (err) {
          if (done) return;
          setBusy(false);
          showFormErr(errMsg(err));
        });
      });
      function focusField(name) { var c = ctl[name]; if (c && c.focus) { try { c.focus(); } catch (e) { /* ignore */ } } }

      doc.body.appendChild(backdrop);
      Array.prototype.forEach.call(doc.body.children, function (n) {
        if (n === backdrop || n.hasAttribute('inert') || /^(SCRIPT|STYLE|TEMPLATE)$/.test(n.tagName) || n.classList.contains('app-modal-backdrop') || n.classList.contains('toast-stack') || n.classList.contains('cmdk-backdrop')) return;
        n.setAttribute('inert', ''); inertEls.push(n);
      });
      doc.documentElement.classList.add('app-lock');
      doc.addEventListener('keydown', onKey, true);
      setTimeout(function () {
        var first = focusables().filter(function (n) { return n !== closeB; })[0];
        (first || okB).focus();
      }, 0);
      // test / integration hook (not used by the views)
      backdrop.__ops = { values: values, submit: function () { form.dispatchEvent(new Event('submit', { cancelable: true })); }, close: dismiss };
    });
  }

  Ops.ui = Ops.ui || {
    t: t, has: has, lab: lab, lang: lang, NONE: NONE,
    el: el, clear: clear, icon: icon, btn: btn, ltr: ltr, pill: pill, statusPill: statusPill, tone: tone,
    fmtDate: fmtDate, fmtTime: fmtTime, fmtDay: fmtDay, fmtMoney: fmtMoney, daysFrom: daysFrom, dueNode: dueNode,
    startOfDay: startOfDay, addDays: addDays, isoDay: isoDay, toDate: toDate, localInput: localInput, fromLocalInput: fromLocalInput,
    norm: norm, matches: matches, nn: nn, pick: pick, partyName: partyName, txRef: txRef,
    call: call, rowsOf: rowsOf, countOf: countOf, errCode: errCode, errMsg: errMsg, isForbidden: isForbidden, isUnique: isUnique,
    idemKey: idemKey, idemSettle: idemSettle, toast: toast, confirm: confirmAsk, can: can, go: go, scope: scope,
    head: head, card: card, emptyState: emptyState, alertBox: alertBox, errorState: errorState, skeleton: skeleton,
    loadingInto: loadingInto, doneLoading: doneLoading, table: table, td: td, twoLine: twoLine, txLink: txLink,
    select: select, searchBox: searchBox, toolbar: toolbar, kpi: kpi, formModal: formModal, kitMissing: kitMissing
  };
  // tells the shell badge (and anything else listening) that alert counts may have changed
  Ops.alertsChanged = function () { try { window.dispatchEvent(new CustomEvent('marsa:alertschange')); } catch (e) { /* old browsers */ } };

  /* ==================================================================
     #alerts — inbox grouped by severity, then due date
     ================================================================== */
  var U = Ops.ui;
  var SEVERITIES = ['critical', 'warning', 'info'];
  var KINDS = ['docs_missing', 'appointment_soon', 'appointment_missed', 'empty_return_due', 'empty_return_overdue', 'exception_open', 'declaration_stalled',
    // legacy step 8 (20261124000100): idle per status (app.status_aging_rules) and a gate-out appointment passed without an update
    'status_stale', 'appointment_not_updated'];
  var AF = { status: 'active', severity: '', kind: '', q: '' };   // filters survive navigation

  function statusOk(s, row) {
    if (s === 'all') return true;
    if (s === 'active') return row.status === 'open' || row.status === 'acknowledged';
    return row.status === s;
  }
  function alertTitle(a) { return (U.lang() === 'en' && a.title_en) || a.title_ar || a.title_en || U.lab('alert_kind', a.kind); }
  function dueTs(a) { var d = U.toDate(a.due_at); return d ? d.getTime() : Infinity; }

  var ALERT_PAGE = 200;   // list_alerts / listAlerts cap per read

  function renderAlerts(root, api) {
    var sc = U.scope(root);
    var rows = [], seen = {};
    // one paged read per status ("active" = open + acknowledged): server totals / per-severity counts
    // cover the whole filtered set, so KPIs and totals stay right when only the first page is loaded
    var pages = [];
    var writer = U.can(api, 'staff');
    U.clear(root);
    root.classList.add('ops-view', 'ops-alerts');

    var refreshB = U.btn([U.icon('refresh'), el2('span', U.t('al_refresh_now'))], 'btn-primary', doRefreshNow);
    var head = U.head(U.t('al_title'), U.t('al_sub'), writer ? [refreshB] : []);
    var kpis = U.el('div', { class: 'adm-tiles ops-kpis', 'aria-live': 'polite' });
    var bar = U.el('div');
    var body = U.el('div', { class: 'ops-groups' });
    root.appendChild(head); root.appendChild(kpis); root.appendChild(bar); root.appendChild(body);

    function el2(tag, text) { return U.el(tag, { text: text }); }
    // severity / kind / search filter the loaded rows (client side); status is the server read
    function fetchPage(p) {
      var f = { limit: ALERT_PAGE, offset: p.offset };
      if (p.status) f.status = p.status;
      return U.call(api, 'listAlerts', f).then(function (r) {
        if (r.error) return r;
        var got = U.rowsOf(r.data);
        p.offset += got.length;
        p.total = r.count != null ? r.count : p.offset;
        p.counts = r.counts || null;
        got.forEach(function (a) { if (a && !seen[a.id]) { seen[a.id] = 1; rows.push(a); } });
        return r;
      });
    }
    function load() {
      U.loadingInto(body, 6, false);
      U.clear(kpis);
      // list_alerts filters by one status: "open + acknowledged" is two reads, merged by id
      var statuses = AF.status === 'active' ? ['open', 'acknowledged'] : [AF.status === 'all' ? null : AF.status];
      rows = []; seen = {};
      pages = statuses.map(function (s) { return { status: s, offset: 0, total: 0, counts: null }; });
      return Promise.all(pages.map(fetchPage)).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        var err = res.filter(function (r) { return r.error; })[0];
        if (err) { body.appendChild(U.errorState(api, err.error, load)); return; }
        draw();
      });
    }
    function serverTotal() { return pages.reduce(function (n, p) { return n + (p.total || 0); }, 0); }
    function loadMore(b) {
      b.disabled = true;
      Promise.all(pages.filter(function (p) { return p.offset < p.total; }).map(fetchPage)).then(function (res) {
        if (!sc.alive()) return;
        b.disabled = false;
        var err = res.filter(function (r) { return r.error; })[0];
        if (err) { U.toast(api, U.errMsg(err.error, api), 'error'); return; }
        draw();
      });
    }
    function filtered() {
      return rows.filter(function (a) {
        return statusOk(AF.status, a) && (!AF.severity || a.severity === AF.severity) && (!AF.kind || a.kind === AF.kind) &&
          U.matches(AF.q, [a.title_ar, a.title_en, U.txRef(a), U.pick(a, ['container_no', 'container.container_no']), U.lab('alert_kind', a.kind), a.note]);
      });
    }
    function drawKpis() {
      U.clear(kpis);
      var live = rows.filter(function (a) { return a.status !== 'resolved'; });
      // "active" view: the server's counts of the whole set (open + acknowledged reads), not the loaded page
      var openP = AF.status === 'active' ? pages.filter(function (p) { return p.status === 'open'; })[0] : null;
      var ackP = AF.status === 'active' ? pages.filter(function (p) { return p.status === 'acknowledged'; })[0] : null;
      var srv = openP && ackP && openP.counts && ackP.counts;
      SEVERITIES.forEach(function (s) {
        var n = srv ? (+openP.counts[s] || 0) + (+ackP.counts[s] || 0) : live.filter(function (a) { return a.severity === s; }).length;
        var nOpen = srv ? (+openP.counts[s] || 0) : live.filter(function (a) { return a.severity === s && a.status === 'open'; }).length;
        kpis.appendChild(U.kpi(U.lab('severity', s), n, U.tone('severity', s), {
          active: AF.severity === s, foot: U.t('al_kpi_open') + ': ' + nOpen,
          onClick: function () { AF.severity = AF.severity === s ? '' : s; draw(); }
        }));
      });
      kpis.appendChild(U.kpi(U.t('al_kpi_ack'), srv ? (ackP.total || 0) : live.filter(function (a) { return a.status === 'acknowledged'; }).length, 'neutral', {
        active: AF.status === 'acknowledged', onClick: function () { AF.status = AF.status === 'acknowledged' ? 'active' : 'acknowledged'; load(); }
      }));
    }
    function drawBar(shown) {
      U.clear(bar);
      var statusOpts = [['active', U.t('al_status_active')], ['open', U.lab('alert_status', 'open')], ['acknowledged', U.lab('alert_status', 'acknowledged')],
        ['resolved', U.lab('alert_status', 'resolved')], ['all', U.t('all')]];
      var filters = [
        U.select('status', U.t('al_f_status'), statusOpts, AF.status, function (v) { AF.status = v; load(); }),
        U.select('severity', U.t('al_f_severity'), [['', U.t('al_f_severity') + ': ' + U.t('all')]].concat(SEVERITIES.map(function (s) { return [s, U.lab('severity', s)]; })), AF.severity, function (v) { AF.severity = v; draw(); }),
        U.select('kind', U.t('al_f_kind'), [['', U.t('al_f_kind') + ': ' + U.t('all')]].concat(KINDS.map(function (k) { return [k, U.lab('alert_kind', k)]; })), AF.kind, function (v) { AF.kind = v; draw(); })
      ];
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': U.t('refresh'), title: U.t('refresh') })];
      if (AF.severity || AF.kind || AF.q || AF.status !== 'active') acts.unshift(U.btn(U.t('clear_filters'), 'btn-subtle', function () { AF = { status: 'active', severity: '', kind: '', q: '' }; load(); }));
      bar.appendChild(U.toolbar(U.searchBox(AF.q, U.t('search'), function (v) { AF.q = v; draw(true); }), filters, acts, U.t('shown_of', { n: shown, total: Math.max(serverTotal(), rows.length) })));
    }
    function draw(keepBar) {
      if (!sc.alive()) return;
      var list = filtered();
      drawKpis();
      if (!keepBar) drawBar(list.length);
      else { var cnt = bar.querySelector('.toolbar-count'); if (cnt) cnt.textContent = U.t('shown_of', { n: list.length, total: Math.max(serverTotal(), rows.length) }); }
      U.clear(body);
      // more on the server than loaded: say so (the filters / groups below cover the loaded rows only)
      var total = serverTotal();
      if (pages.some(function (p) { return p.offset < p.total; })) {
        body.appendChild(U.el('div', { class: 'ops-more' }, [
          U.alertBox('info', U.t('al_partial', { n: rows.length, total: Math.max(total, rows.length) })),
          U.btn(U.t('al_more'), 'btn-secondary', loadMore)
        ]));
      }
      if (!rows.length) {
        body.appendChild(U.card(null, U.emptyState('bell', U.t('al_empty_title'), U.t('al_empty_text'), writer ? [U.btn(U.t('al_refresh_now'), 'btn-secondary', doRefreshNow)] : null)));
        return;
      }
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('search', null, U.t('no_match'), [U.btn(U.t('clear_filters'), 'btn-secondary', function () { AF.q = ''; AF.severity = ''; AF.kind = ''; draw(); })], true))); return; }
      SEVERITIES.concat(['other']).forEach(function (s) {
        var g = list.filter(function (a) { return s === 'other' ? SEVERITIES.indexOf(a.severity) === -1 : a.severity === s; });
        if (!g.length) return;
        g.sort(function (a, b) { return dueTs(a) - dueTs(b) || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')); });
        var titleTxt = (s === 'other' ? U.t('all') : U.lab('severity', s)) + ' (' + g.length + ')';
        var c = U.card(titleTxt, U.table([U.t('al_col_alert'), U.t('tx'), U.t('al_col_due'), U.t('al_col_status'), U.t('al_col_seen'), { label: U.t('actions'), cls: 'ops-col-actions' }],
          g.map(rowNode), { caption: titleTxt }), null, { flush: true, cls: 'ops-group ops-sev-' + s });
        body.appendChild(c);
      });
    }
    function rowNode(a) {
      var sub = [U.lab('alert_kind', a.kind)];
      var ctr = U.pick(a, ['container_no', 'container.container_no']);
      var titleCell = U.el('div', { class: 'ops-alert-title' }, [
        U.pill(U.tone('severity', a.severity), U.lab('severity', a.severity)),
        U.el('div', null, [U.el('span', { class: 'cell-main', text: alertTitle(a) }), U.el('span', { class: 'cell-sub', text: sub.join(' · ') }),
          ctr ? U.el('span', { class: 'cell-sub' }, [U.t('container') + ': ', U.ltr(ctr)]) : null,
          a.note ? U.el('span', { class: 'cell-sub ops-note', text: a.note }) : null])
      ]);
      var statusSub = a.status === 'acknowledged' && a.acknowledged_at ? U.t('al_acked_at', { d: U.fmtDate(a.acknowledged_at, true) })
        : a.status === 'resolved' && a.resolved_at ? U.t('al_resolved_at', { d: U.fmtDate(a.resolved_at, true), how: U.t(a.resolution === 'auto' ? 'al_resolution_auto' : 'al_resolution_manual') }) : null;
      var acts = U.el('div', { class: 'ops-row-actions' });
      if (writer && a.status === 'open') acts.appendChild(U.btn([U.icon('check'), U.el('span', { text: U.t('al_ack') })], 'btn-secondary', function (b) { ack(a, b); }));
      if (writer && a.status !== 'resolved') acts.appendChild(U.btn(U.t('al_resolve'), 'btn-subtle', function () { resolve(a); }));
      return U.el('tr', { 'data-id': a.id, class: a.status === 'resolved' ? 'is-muted' : null }, [
        U.td(titleCell), U.td(U.txLink(a), 'is-nowrap'), U.td(U.dueNode(a.due_at, a.status === 'resolved')),
        U.td([U.statusPill('alert_status', a.status), statusSub ? U.el('span', { class: 'cell-sub', text: statusSub }) : null]),
        U.td([U.el('span', { text: U.fmtDate(a.last_seen_at || a.first_seen_at, true) }), a.first_seen_at ? U.el('span', { class: 'cell-sub', text: U.t('al_first_seen', { d: U.fmtDate(a.first_seen_at) }) }) : null], 'is-nowrap'),
        U.td(acts, 'ops-col-actions')
      ]);
    }
    function ack(a, b) {
      b.disabled = true;
      U.call(api, 'ackAlert', a.id).then(function (r) {
        if (!sc.alive()) return;
        b.disabled = false;
        if (r.error) { U.toast(api, U.errMsg(r.error, api), U.errCode(r.error) === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error'); return; }
        U.toast(api, U.t('al_acked'), 'success');
        a.status = 'acknowledged'; a.acknowledged_at = new Date().toISOString();
        Ops.alertsChanged();
        load();
      });
    }
    function resolve(a) {
      U.formModal({
        title: U.t('al_resolve_title'), size: 'sm', intro: alertTitle(a), submitText: U.t('al_resolve'),
        fields: [{ name: 'note', label: U.t('al_resolve_note'), type: 'textarea', required: true, max: 500, hint: U.t('al_resolve_hint') }],
        submit: function (v) { return U.call(api, 'resolveAlert', a.id, v.note); }
      }).then(function (res) {
        if (!res || !sc.alive()) return;
        U.toast(api, U.t('al_resolved'), 'success');
        Ops.alertsChanged();
        load();
      });
    }
    function doRefreshNow() {
      refreshB.disabled = true;
      var label = refreshB.querySelector('span');
      if (label) label.textContent = U.t('al_refreshing');
      U.call(api, 'refreshAlerts').then(function (r) {
        refreshB.disabled = false;
        if (label) label.textContent = U.t('al_refresh_now');
        if (!sc.alive()) return;
        if (r.error) {
          var c = U.errCode(r.error);
          U.toast(api, c === 'MRS_RATE_LIMITED' ? U.t('rate_limited') : U.errMsg(r.error, api), c === 'MRS_RATE_LIMITED' || c === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error');
          if (c !== 'MRS_RATE_LIMITED') return;
        } else if (r.data && (r.data.rate_limited || r.data.refreshed === false)) {
          // refresh_alerts answers a call within the minute with refreshed:false (no error): nothing was recomputed
          var sec = +r.data.retry_after_seconds || 0;
          U.toast(api, sec > 0 ? U.t('al_rate_limited_s', { s: sec }) : U.t('rate_limited'), 'warning');
        } else {
          var d = r.data || {};
          U.toast(api, d.opened != null || d.resolved != null ? U.t('al_refreshed_n', { opened: d.opened || 0, resolved: d.resolved || 0 }) : U.t('al_refreshed'), 'success');
        }
        Ops.alertsChanged();
        load();
      });
    }
    return load();
  }

  Ops.views.alerts = {
    allow: 'staff', titleKey: 'ops.nav_alerts', icon: 'bell',
    render: function (root, api) { return renderAlerts(root, api); }
  };
})();

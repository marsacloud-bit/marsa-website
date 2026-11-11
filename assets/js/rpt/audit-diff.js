/* ==========================================================================
   مرسى | MARSA — legacy step 8: operations log with business labels and an Arabic field diff
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_REPORTS_AR.md §10 (audit_trail, 20261124000100; owner decision 2026-11-11 (7): the labels are
   derived when the log is read). Legacy: Audit.js recordSystemAuditEvent, Index.html buildTransactionAuditDetails.

     MarsaAuditDiff.lines(item) → [{field, label, from, to, kind: 'change' | 'add' | 'remove' | 'changed' (two row ids)}]   (pure)
     MarsaAuditDiff.sentence(line) → «الحالة التشغيلية: من «جديدة» إلى «قيد العمل»»
     MarsaAuditDiff.value(table, field, v) → display text (codes → labels, timestamps → Asia/Riyadh, dates kept)
     MarsaAuditDiff.entry(item, api) → <li> (label, event «من X إلى Y», the field list, actor, time, transaction / container)
   Views: #changes (MarsaOps.views.changes, admin + supervisor: auditTrail with table / actor / dates / row filters and
   «الأقدم»), and a section on #tx/<id> (admin / supervisor at the transaction's branch), loaded on demand.
   Strings: 'lrpt' (al_<audit_label>, ev_<audit_event>, fld_<table>_<field> / fld_<field>). textContent only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  Ops.txSections = Ops.txSections || [];

  var AUDIT_ROLES = ['admin', 'supervisor'];
  var PAGE = 50;
  var RIYADH_MS = 3 * 3600 * 1000;
  var TABLES = ['transactions', 'containers', 'port_appointments', 'transport_trips', 'customs_declarations', 'empty_return_proofs', 'client_disbursements', 'billing_intents', 'clients', 'organizations'];
  // field → label domain of its codes (per table first, then any table)
  var CODE_DOMAINS = {
    'transactions.operational_status': 'operational_status', 'transactions.financial_status': 'financial_status', 'transactions.transaction_type': 'transaction_type',
    'transactions.cargo_unit_type': 'cargo_unit_type', 'transactions.transport_mode': 'transport_mode',
    'containers.return_status': 'container_return_status', 'containers.operational_state': 'container_state',
    'port_appointments.status': 'appt_status', 'transport_trips.status': 'trip_status', 'customs_declarations.status': 'declaration_status',
    'client_disbursements.review_status': 'pay_review_status', 'client_disbursements.status': 'pay_status', 'client_disbursements.movement_type': 'pay_movement_type',
    'billing_intents.status': 'billing_intent_status', 'billing_intents.purpose': 'billing_purpose', 'billing_intents.origin': 'billing_origin', 'billing_intents.sync_state': 'billing_sync_state',
    'operational_status': 'operational_status', 'financial_status': 'financial_status', 'return_status': 'container_return_status', 'declaration_status': 'declaration_status'
  };
  var TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // links between rows (ids) say nothing to a reader: never listed as a field change
  var LINK_FIELDS = { id: 1, org_id: 1, organization_id: 1, transaction_id: 1, intent_id: 1, container_id: 1, appointment_id: 1, trip_id: 1, declaration_id: 1, created_by: 1, updated_by: 1 };

  function I() { return window.MarsaI18n; }
  function lang() { var x = I(); return x && typeof x.lang === 'function' ? x.lang() : 'ar'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : String(s); }
  function lt(k, vars) {
    var x = I(), key = 'lrpt.' + k;
    if (x && typeof x.t === 'function') { var s = x.t(key, vars); if (s != null && s !== key) return s; }
    var D = window.MarsaLrptDict || {}, d = (D[lang()] || {})[k];
    if (d == null) d = (D.ar || {})[k];
    return d == null ? null : interp(d, vars);
  }
  function txt(k, vars) { var s = lt(k, vars); return s == null ? k : s; }
  var CTX_API = null;
  function codeLabel(domain, code) {
    if (code == null || code === '') return '';
    var a = CTX_API;
    if (a && typeof a.label === 'function') { try { var s = a.label(domain, code); if (s && s !== String(code) && s !== '—') return s; } catch (e) { /* fall back */ } }
    var x = I();
    if (x && typeof x.label === 'function') { var s2 = x.label(domain, code); if (s2 && s2 !== String(code)) return s2; }
    return lt('code_' + domain + '_' + code) || String(code);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function riyadhStamp(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    var r = new Date(d.getTime() + RIYADH_MS);
    return r.getUTCFullYear() + '-' + pad(r.getUTCMonth() + 1) + '-' + pad(r.getUTCDate()) + ' ' + pad(r.getUTCHours()) + ':' + pad(r.getUTCMinutes());
  }
  function fieldLabel(table, field) {
    return lt('fld_' + table + '_' + field) || lt('fld_' + field) || String(field);
  }
  function value(table, field, v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'boolean') return txt(v ? 'yes' : 'no');
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') { var j; try { j = JSON.stringify(v); } catch (e) { j = String(v); } return j.length > 120 ? j.slice(0, 120) + '…' : j; }
    var s = String(v);
    if (UUID_RE.test(s)) return txt('diff_ref');       // a row id is never shown raw
    var dom = CODE_DOMAINS[table + '.' + field] || CODE_DOMAINS[field];
    if (dom && /^[a-z][a-z0-9_]{0,40}$/.test(s)) return codeLabel(dom, s);
    if (DAY_RE.test(s)) return s;                       // a date without time is never shifted
    if (TS_RE.test(s)) return riyadhStamp(s);           // a timestamp → Asia/Riyadh wall time
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  function lines(item) {
    var table = item && item.table_name || '';
    return (item && Array.isArray(item.changes) ? item.changes : []).filter(function (c) { return c && c.field && !LINK_FIELDS[c.field]; }).map(function (c) {
      var from = value(table, c.field, c.from), to = value(table, c.field, c.to);
      var kind = from == null && to != null ? 'add' : to == null && from != null ? 'remove' : 'change';
      if (kind === 'change' && from === to && String(c.from) !== String(c.to)) kind = 'changed';   // two different row ids: say it changed, never the ids
      return { field: c.field, label: fieldLabel(table, c.field), from: from, to: to, kind: kind };
    }).filter(function (l) { return !(l.from == null && l.to == null) && (l.kind === 'changed' || l.from !== l.to); });
  }
  function sentence(l) {
    if (l.kind === 'add') return txt('diff_add', { f: l.label, to: l.to });
    if (l.kind === 'remove') return txt('diff_remove', { f: l.label, from: l.from });
    if (l.kind === 'changed') return txt('diff_changed', { f: l.label });
    return txt('diff_change', { f: l.label, from: l.from, to: l.to });
  }
  function labelOf(item) {
    var code = item && item.label;
    if (!code) return txt('al_row.' + String(item && item.action || 'update').toLowerCase());
    var s = codeLabel('audit_label', code);
    return s !== code ? s : (lt('al_' + code) || code);
  }
  function eventText(ev) {
    if (!ev || !ev.type) return null;
    var name = codeLabel('audit_event', ev.type);
    if (name === ev.type) name = lt('ev_' + ev.type) || ev.type;
    var parts = [name];
    if (ev.from_status || ev.to_status) {
      var dom = ev.type === 'financial_status' ? 'financial_status' : 'operational_status';
      parts.push(txt('diff_status', { from: ev.from_status ? codeLabel(dom, ev.from_status) : txt('diff_empty'), to: ev.to_status ? codeLabel(dom, ev.to_status) : txt('diff_empty') }));
    }
    if (ev.note) parts.push('«' + String(ev.note).slice(0, 300) + '»');
    return parts.join(' — ');
  }

  /* ------------------------------------------------------------------ DOM */
  function entry(item, api) {
    var U = Ops.ui, el = U.el;
    CTX_API = api || CTX_API;
    var ls = lines(item), ev = eventText(item.event);
    var who = item.actor_name || (api && typeof api.who === 'function' && item.actor ? api.who(item.actor) : '') || txt('actor_system');
    var role = item.actor_role ? codeLabel('role', item.actor_role) : null;
    var tone = { INSERT: 'success', UPDATE: 'info', DELETE: 'danger' }[item.action] || 'neutral';
    return el('li', { class: 'lrpt-audit-item', 'data-id': item.id != null ? String(item.id) : null }, [
      el('div', { class: 'lrpt-audit-head' }, [
        U.pill(tone, labelOf(item)),
        el('span', { class: 'lrpt-audit-when is-nowrap text-xs text-muted', text: item.at ? riyadhStamp(item.at) : '' }),
        el('span', { class: 'lrpt-audit-who text-xs' }, [who, role ? ' · ' + role : null]),
        item.transaction_id ? el('a', { class: 'ops-ref text-xs', href: '#tx/' + item.transaction_id }, el('bdi', { dir: 'ltr', text: item.transaction_ref || String(item.transaction_id).slice(0, 8) })) : null,
        item.container_no ? el('bdi', { dir: 'ltr', class: 'badge badge-muted', text: item.container_no }) : null
      ]),
      ev ? el('p', { class: 'lrpt-audit-event text-sm', text: ev }) : null,
      ls.length ? el('ul', { class: 'lrpt-audit-diff' }, ls.map(function (l) {
        return el('li', { class: 'lrpt-diff-' + l.kind }, [el('span', { class: 'lrpt-diff-field', text: l.label + ': ' }),
          l.kind === 'add' ? [el('span', { text: txt('diff_add_word') + ' ' }), el('bdi', { dir: 'auto', class: 'lrpt-diff-to', text: l.to })]
            : l.kind === 'remove' ? [el('span', { text: txt('diff_remove_word') + ' ' }), el('bdi', { dir: 'auto', class: 'lrpt-diff-from', text: l.from })]
              : l.kind === 'changed' ? [el('span', { text: txt('diff_changed_word') })]
              : [el('span', { text: txt('diff_from') + ' ' }), el('bdi', { dir: 'auto', class: 'lrpt-diff-from', text: l.from }), el('span', { text: ' ' + txt('diff_to') + ' ' }), el('bdi', { dir: 'auto', class: 'lrpt-diff-to', text: l.to })]]);
      })) : (ev ? null : el('p', { class: 'text-xs text-muted', text: txt('diff_none') }))
    ]);
  }
  function feed(host, api, base) {
    var U = Ops.ui, el = U.el, sc = U.scope(host);
    var list = el('ol', { class: 'lrpt-audit-list' }), more = el('div', { class: 'adm-pager' }), status = el('p', { class: 'text-xs text-muted', role: 'status' });
    var before = null, shown = 0;
    var older = U.btn(txt('older'), 'btn-ghost', function () { load(); });
    U.clear(host);
    host.appendChild(list); host.appendChild(status); more.appendChild(older); host.appendChild(more);
    older.hidden = true;
    function load() {
      older.disabled = true;
      var f = Object.assign({ limit: PAGE }, base);
      if (before != null) f.before_id = before;
      return U.call(api, 'auditTrail', f).then(function (r) {
        older.disabled = false;
        if (!sc.alive()) return;
        if (r.error) { host.insertBefore(U.errorState(api, r.error, null), list); older.hidden = true; return; }
        var d = r.data || {}, items = Array.isArray(d.items) ? d.items : [];
        if (!shown && !items.length) list.appendChild(el('li', { class: 'lrpt-audit-empty text-sm text-muted', text: txt('audit_empty') }));
        items.forEach(function (it) { list.appendChild(entry(it, api)); });
        shown += items.length;
        before = d.next_before_id != null ? d.next_before_id : null;
        older.hidden = before == null;
        status.textContent = txt('audit_count', { n: shown });
      });
    }
    return load();
  }

  function renderView(root, api) {
    var U = Ops.ui, el = U.el;
    CTX_API = api;
    U.clear(root);
    root.classList.add('ops-view', 'lrpt-changes');
    root.appendChild(U.head(txt('ch_title'), txt('ch_sub')));
    var M = api && api.MarsaApi;
    if (!M || typeof M.auditTrail !== 'function') { root.appendChild(U.alertBox('warning', txt('api_missing_fn', { fn: 'auditTrail' }))); return; }
    var f = renderView.state || (renderView.state = { table_name: '', actor: '', from: '', to: '', row_id: '' });
    var tSel = U.select('table_name', txt('ch_table'), [['', txt('all')]].concat(TABLES.map(function (x) { return [x, lt('tbl_' + x) || x]; })), f.table_name);
    var from = el('input', { class: 'form-control is-sm', type: 'date', name: 'from', 'aria-label': txt('ch_from'), value: f.from });
    var to = el('input', { class: 'form-control is-sm', type: 'date', name: 'to', 'aria-label': txt('ch_to'), value: f.to });
    var row = el('input', { class: 'form-control is-sm', name: 'row_id', dir: 'ltr', maxlength: 64, 'aria-label': txt('ch_row'), placeholder: txt('ch_row'), value: f.row_id });
    var go = U.btn(txt('apply'), 'btn-primary', function () {
      if (from.value && to.value && from.value > to.value) { U.toast(api, txt('err_range'), 'warning'); return; }
      renderView.state = { table_name: tSel.value, actor: '', from: from.value, to: to.value, row_id: String(row.value || '').trim().slice(0, 64) };
      renderView(root, api);
    });
    root.appendChild(el('div', { class: 'toolbar ops-toolbar lrpt-ch-filters', role: 'search' }, [el('div', { class: 'toolbar-filters' }, [tSel, from, to, row]), el('div', { class: 'toolbar-actions' }, [go])]));
    var host = el('div', { class: 'app-card ops-card lrpt-audit-card' });
    root.appendChild(host);
    var base = {};
    Object.keys(f).forEach(function (k) { if (f[k]) base[k] = f[k]; });
    return feed(host, api, base);
  }

  Ops.views.changes = {
    allow: AUDIT_ROLES, titleKey: 'lrpt.nav_changes', icon: 'history',
    render: function (root, api) {
      if (renderView.org !== (api && api.orgId)) { renderView.state = null; renderView.org = api && api.orgId; }   // filters of this org only
      return renderView(root, api);
    },
    _reset: function () { renderView.state = null; renderView.org = null; }
  };
  Ops.txSections.push({
    id: 'audit-trail', order: 990,
    render: function (root, tx, api) {
      if (!tx || !api || typeof api.can !== 'function' || !api.can(AUDIT_ROLES, tx.branch_id)) return;
      var M = api.MarsaApi;
      if (!M || typeof M.auditTrail !== 'function') return;
      var U = Ops.ui, el = U.el;
      CTX_API = api;
      var body = el('div', { class: 'lrpt-audit-tx' });
      var btn = U.btn(txt('tx_audit_show'), 'btn-secondary', function () { btn.hidden = true; feed(body, api, { transaction_id: tx.id }); });
      root.appendChild(U.card(txt('tx_audit_title'), [el('p', { class: 'text-xs text-muted', text: txt('tx_audit_sub') }), btn, body], null, { cls: 'lrpt-audit-section' }));
    }
  });

  window.MarsaAuditDiff = { VERSION: 'audit-diff-1', lines: lines, sentence: sentence, value: value, entry: entry, labelOf: labelOf, eventText: eventText, fieldLabel: fieldLabel, use: function (api) { CTX_API = api; } };
})();

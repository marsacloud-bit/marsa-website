/* ==========================================================================
   مرسى | MARSA — G5 Daftra settings: #daftra, #daftra/clients, #daftra/items
   --------------------------------------------------------------------------
   Contract: docs/online/G5_SPEC.md (§1 connection, §2 capability probe,
   §3 client links, §4 item catalog, §12 tax policy, "Front end").
   Uses MarsaOps.billKit() (assets/js/bill/billing.js, loaded before this file).

   * No API key is ever entered, shown or stored here: the connection row holds
     mode / status / capabilities / tax settings only. A future live key lives
     server-side (Supabase Vault / Edge Function secrets), never in a table.
   * Capabilities are proven on the MOCK account only — never on a real Daftra
     account (open issue, plan step ٢); the table says so.
   * Client drift is shown for review and never auto-overwritten in either
     direction; the Marsa client row is never changed from here.
   * Settings / catalog / unlink = can('billAdmin'); link / refresh =
     can('finWrite'); drift resolution = can('finApprove'). The server decides.
   * Legacy step 7 (docs/online/LEGACY_DAFTRA_AR.md): the tabs #daftra/products, /fields, /import, /reviews and the
     account guard / write policy / org settings / older-invoice scan cards of «الاتصال» come from
     assets/js/bill/dft-settings.js (MarsaOps.dftSettings, loaded before this file).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var EXT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
  var SUB_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  var RATE_RE = /^[0-9٠-٩]{1,3}([.,٫][0-9٠-٩]{1,2})?$/;
  var TAX_CODES = ['standard', 'zero', 'exempt', 'out_of_scope'];
  var SNAP_FIELDS = ['name', 'name_en', 'vat_number', 'cr_number', 'address_short', 'address', 'email', 'phone'];
  var PAGE = 50;
  var CF = { status: '', q: '', billable_only: false, offset: 0 };

  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }

  function render(root, api, param) {
    var B = Ops.billKit && Ops.billKit();
    if (!B) return noKit(root);
    var U = B.U, F = B.F, el = B.el, t = B.t, sc = U.scope(root);
    // legacy step 7: + products / fields / import / reviews (assets/js/bill/dft-settings.js, MarsaOps.dftSettings)
    var L7 = Ops.dftSettings && Ops.dftKit ? Ops.dftSettings : null, D = Ops.dftKit;
    var L7_TABS = L7 ? L7.TABS : [];
    var tab = param === 'clients' || param === 'items' || L7_TABS.indexOf(param) !== -1 ? param : 'connection';
    var admin = B.canAdmin(api), writer = B.canOrg(api, 'finWrite'), approver = B.canOrg(api, 'finApprove');
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'bill-view', 'bill-daftra');
    root.appendChild(U.head(t('daftra_title'), t('daftra_sub'), [el('a', { class: 'btn btn-sm btn-secondary', href: '#billing', text: t('nav_billing') })]));
    var tabBox = el('div'), body = el('div');
    root.appendChild(tabBox); root.appendChild(body);
    function drawTabs() {
      U.clear(tabBox);
      var items = [['connection', t('tab_connection')], ['clients', t('tab_clients')], ['items', t('tab_items')]].concat(L7_TABS.map(function (k) { return [k, D.t('tab_' + k)]; }));
      tabBox.appendChild(F.tabs(items, tab, function (v) { tab = v; CF.offset = 0; load(); }, t('daftra_title')));
    }
    function load() {
      drawTabs();
      U.loadingInto(body);
      if (tab === 'clients') return loadClients();
      if (tab === 'items') return loadItems();
      if (L7 && L7_TABS.indexOf(tab) !== -1) return L7.render(tab, { B: B, api: api, body: body, sc: sc, reload: load });
      return loadConnection();
    }

    /* ---------------- tab «الاتصال» ---------------- */
    function loadConnection() {
      return U.call(api, 'getDaftraConnection').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        drawConnection(F.dataOf(r));
      });
    }
    function drawConnection(d) {
      var c = d.connection || {}, counts = d.counts || {};
      var exists = c.exists !== false && !!c.id;
      var bn = B.mockBanner(d);
      if (bn) body.appendChild(bn);
      body.appendChild(el('div', { class: 'alert alert-info bill-no-key', role: 'note' }, [U.icon('info'), el('div', null, [el('strong', { text: t('no_key_title') }), el('span', { text: ' ' + t('no_key_text') })])]));
      // connection card
      var acts = [];
      if (admin) {
        acts.push(U.btn(t('probe'), 'btn-primary bill-probe', function (b) {
          b.disabled = true;
          var scope = 'bill-probe', key = U.idemKey(api, scope, { org: api && api.orgId, at: c.capabilities_checked_at || null });
          U.call(api, 'requestDaftraProbe', { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            if (!sc.alive()) return;
            b.disabled = false;
            if (r.error) { F.toastErr(api, r); return; }
            U.toast(api, F.dataOf(r).deduplicated ? t('push_dedup') : t('probe_queued'), 'success');
            load();
          });
        }));
        acts.push(U.btn(t('edit_settings'), 'btn-secondary', function () { settingsDialog(c).then(B.done(api, sc, t('settings_saved'), load)); }));
      }
      var info = F.dl([
        [t('f_mode'), B.pill('daftra_mode', c.mode || 'mock', api)],
        [t('f_status'), B.pill('daftra_conn_status', c.status || 'not_connected', api)],
        [t('f_subdomain'), c.subdomain ? el('span', null, [B.ref(c.subdomain), el('span', { class: 'cell-sub', text: ' ' + t('subdomain_placeholder') })]) : el('span', { class: 'ops-muted', text: U.NONE })],
        [t('f_sync_enabled'), U.pill(c.sync_enabled ? 'success' : 'neutral', c.sync_enabled ? t('yes') : t('no'))],
        [t('last_check'), c.last_check_at ? el('span', null, [B.when(c.last_check_at), ' ', c.last_check_status ? U.pill(c.last_check_status === 'ok' ? 'success' : 'danger', B.lab('bill_check_status', c.last_check_status)) : null]) : el('span', { class: 'ops-muted', text: t('never_checked') })],
        [t('col_last_error'), c.last_error_code || c.last_error_message ? el('span', { class: 'fin-text-danger' }, [B.ref(c.last_error_code), D && c.last_error_code ? '' : ' ' + (c.last_error_message || ''),   // the Arabic dictionary text replaces the raw worker message
          D && c.last_error_code ? D.errNode({ code: c.last_error_code, message: c.last_error_message }, 'cell-sub') : null]) : null],
        [t('push_ready'), U.pill(d.push_ready ? 'success' : 'warning', d.push_ready ? t('push_ready_yes') : t('push_ready_no'))],
        [t('missing_capabilities'), B.list(d.missing_capabilities).length ? el('span', null, B.list(d.missing_capabilities).map(function (k) { return U.pill('danger', B.lab('daftra_capability', k)); })) : null]
      ]);
      body.appendChild(U.card(t('connection'), [info, exists ? null : el('p', { class: 'form-hint', text: t('connection_absent') })], acts, { cls: 'bill-conn', sub: t('worker_not_deployed') }));
      // counts
      var tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis bill-kpis' });
      var jb = counts.jobs_by_status || {}, lb = counts.links_by_status || {}, ib = counts.items_by_status || {};
      tiles.appendChild(U.kpi(t('tile_queued'), +(jb.queued || 0), 'neutral', { foot: t('queued_no_worker_short') }));
      tiles.appendChild(U.kpi(t('tile_failed'), F.nz(jb.failed) + F.nz(jb.dead), 'danger'));
      tiles.appendChild(U.kpi(t('tile_links'), +(lb.linked || 0), 'neutral', { foot: t('tile_links_foot', { drift: lb.drift || 0, review: lb.needs_review || 0 }) }));
      tiles.appendChild(U.kpi(t('tile_items'), +(ib.linked || 0), 'neutral', { foot: t('tile_items_foot', { pending: ib.pending || 0, review: ib.needs_review || 0 }) }));
      body.appendChild(tiles);
      body.appendChild(capabilitiesCard(c));
      body.appendChild(taxCard(c));
      body.appendChild(policyCard());
      if (L7) L7.connectionCards({ B: B, api: api, body: body, sc: sc, reload: load }, d).forEach(function (n) { body.appendChild(n); });
    }
    function capabilitiesCard(c) {
      var caps = c.capabilities && typeof c.capabilities === 'object' ? c.capabilities : {};
      var checked = !!c.capabilities_checked_at;
      var rows = B.CAPABILITY_KEYS.map(function (k) {
        var x = caps[k];
        var st = !x ? U.pill('neutral', t('cap_unchecked')) : x.supported ? U.pill('success', t('cap_supported')) : U.pill('danger', t('cap_unsupported'));
        var use = B.NEVER_USED.indexOf(k) !== -1 ? t('cap_never_used') : B.PUSH_CAPABILITIES.indexOf(k) !== -1 ? t('cap_push_gate') : t('cap_used');
        return el('tr', { 'data-cap': k, class: x && !x.supported && B.PUSH_CAPABILITIES.indexOf(k) !== -1 ? 'bill-cap-missing' : null }, [
          U.td([el('span', { class: 'cell-main', text: B.lab('daftra_capability', k) }), el('span', { class: 'cell-sub' }, B.ref(k))]),
          U.td(st), U.td(el('span', { class: 'text-xs', text: use })),
          U.td(x && x.evidence ? el('span', { class: 'text-xs', text: x.evidence === 'mock' ? t('evidence_mock') : x.evidence }) : null),
          U.td(x && x.checked_at ? B.when(x.checked_at) : null, 'is-nowrap')
        ]);
      });
      var src = c.capabilities_source;
      var sub = !checked ? t('cap_not_probed') : src === 'live' ? t('cap_source_live') : t('cap_source_mock');
      return U.card(t('capabilities'), [
        el('div', { class: 'alert alert-warning bill-cap-note', role: 'note' }, [U.icon('alert'), el('div', { text: t('cap_mock_only') })]),
        U.table([t('col_capability'), t('col_supported'), t('col_use'), t('col_evidence'), t('col_checked_at')], rows, { caption: t('capabilities') })
      ], null, { flush: true, sub: sub + (checked ? ' · ' + B.when(c.capabilities_checked_at) : ''), cls: 'bill-caps' });
    }
    function taxCard(c) {
      var rates = Array.isArray(c.allowed_vat_rates) ? c.allowed_vat_rates : [0, 15];
      return U.card(t('tax_settings'), F.dl([
        [t('f_default_vat'), el('bdi', { dir: 'ltr', class: 'num', text: (c.default_service_vat_rate != null ? +c.default_service_vat_rate : 15) + '%' })],
        [t('f_allowed_rates'), el('bdi', { dir: 'ltr', class: 'num', text: rates.map(function (x) { return +x + '%'; }).join(' · ') })],
        [t('f_reimbursable_tax'), B.lab('daftra_tax_code', c.reimbursable_tax_code || 'out_of_scope')],
        [t('f_invoice_notes'), c.invoice_notes || el('span', { class: 'ops-muted', text: U.NONE })]
      ]), null, { sub: t('tax_settings_sub'), cls: 'bill-tax' });
    }
    function policyCard() {
      return U.card(t('tax_policy'), [
        el('ul', { class: 'check-list bill-policy' }, ['policy_1', 'policy_2', 'policy_3', 'policy_4', 'policy_5', 'policy_6'].map(function (k) {
          return el('li', null, [U.icon('info'), el('span', { text: t(k) })]);
        })),
        el('p', { class: 'form-hint', text: t('policy_foot') })
      ], null, { cls: 'bill-policy-card' });
    }
    function settingsDialog(c) {
      var rates = Array.isArray(c.allowed_vat_rates) ? c.allowed_vat_rates : [0, 15];
      return U.formModal({
        title: t('edit_settings'), intro: t('settings_intro'), warn: null, submitText: t('save'),
        fields: [
          { name: 'mode', label: t('f_mode'), type: 'select', required: true, value: c.mode || 'mock', options: ['mock', 'live_pending'].map(function (m) { return [m, B.lab('daftra_mode', m)]; }), hint: t('mode_hint') },
          { name: 'subdomain', label: t('f_subdomain'), value: c.subdomain || '', ltr: true, max: 63, pattern: SUB_RE, patternMsg: t('subdomain_invalid'), placeholder: 'marsa-demo', hint: t('subdomain_hint') },
          { name: 'sync_enabled', label: t('f_sync_enabled'), type: 'checkbox', value: !!c.sync_enabled, hint: t('sync_enabled_hint') },
          { name: 'default_service_vat_rate', label: t('f_default_vat') + ' %', required: true, ltr: true, inputmode: 'decimal', value: c.default_service_vat_rate != null ? String(+c.default_service_vat_rate) : '15', pattern: RATE_RE, patternMsg: t('rate_invalid') },
          { name: 'allowed_vat_rates', label: t('f_allowed_rates') + ' %', required: true, ltr: true, value: rates.map(function (x) { return String(+x); }).join(', '), hint: t('allowed_rates_hint') },
          { name: 'reimbursable_tax_code', label: t('f_reimbursable_tax'), type: 'select', required: true, value: c.reimbursable_tax_code || 'out_of_scope', options: TAX_CODES.map(function (x) { return [x, B.lab('daftra_tax_code', x)]; }), hint: t('reimbursable_tax_hint') },
          { name: 'invoice_notes', label: t('f_invoice_notes'), type: 'textarea', max: 500, rows: 2, value: c.invoice_notes || '', hint: t('invoice_notes_hint') }
        ],
        validate: function (v) {
          var bad = {}, d = F.num(v.default_service_vat_rate);
          if (d == null || isNaN(d) || d < 0 || d > 100) bad.default_service_vat_rate = t('rate_invalid');
          var list = parseRates(v.allowed_vat_rates);
          if (!list) bad.allowed_vat_rates = t('rates_invalid');
          else if (d != null && !isNaN(d) && list.indexOf(F.r2(d)) === -1) bad.allowed_vat_rates = t('rates_need_default');
          return bad;
        },
        submit: function (v) {
          return U.call(api, 'saveDaftraConnection', {
            mode: v.mode, subdomain: U.nn(v.subdomain), sync_enabled: !!v.sync_enabled, default_service_vat_rate: F.r2(F.num(v.default_service_vat_rate)),
            allowed_vat_rates: parseRates(v.allowed_vat_rates), reimbursable_tax_code: v.reimbursable_tax_code, invoice_notes: U.nn(v.invoice_notes)
          });
        }
      });
    }
    function parseRates(s) {
      var parts = F.western(s).split(/[\s,،;]+/).filter(Boolean), out = [];
      for (var i = 0; i < parts.length; i++) {
        var n = F.num(parts[i]);
        if (n == null || isNaN(n) || n < 0 || n > 100) return null;
        n = F.r2(n);
        if (out.indexOf(n) === -1) out.push(n);
      }
      return out.length && out.length <= 10 ? out.sort(function (a, b) { return a - b; }) : null;
    }

    /* ---------------- tab «العملاء» ---------------- */
    function loadClients() {
      var f = { limit: PAGE, offset: CF.offset };
      if (CF.status) f.status = CF.status;
      if (CF.q) f.q = CF.q;
      if (CF.billable_only) f.billable_only = true;
      return U.call(api, 'listDaftraClientLinks', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        drawClientBar(r.error ? null : F.dataOf(r).total);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        drawClients(F.dataOf(r));
      });
    }
    function drawClientBar(total) {
      var all = t('f_status') + ': ' + t('all');
      var st = U.select('status', t('f_status'), [['', all]].concat(['pending', 'linked', 'drift', 'needs_review', 'error', 'unlinked'].map(function (s) { return [s, B.lab('daftra_link_status', s)]; })), CF.status, function (v) { CF.status = v; CF.offset = 0; load(); });
      var cb = el('input', { type: 'checkbox', checked: CF.billable_only, 'aria-label': t('billable_only') });
      cb.addEventListener('change', function () { CF.billable_only = cb.checked; CF.offset = 0; load(); });
      var search = U.searchBox(CF.q, t('search_clients'), function (v) { CF.q = v.trim(); CF.offset = 0; load(); });
      body.appendChild(U.toolbar(search, [st, el('label', { class: 'check bill-toolbar-check' }, [cb, el('span', { text: t('billable_only') })])],
        [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], total != null ? t('count_n', { n: total }) : null));
    }
    function snapLocal(l) { return l.local_snapshot || l.client_snapshot || l.local || null; }
    function driftTable(l) {
      var fields = {};
      B.list(l.drift).forEach(function (x) { var p = String(x).split(':'); fields[p[1] || p[0]] = true; });
      var keys = SNAP_FIELDS.filter(function (k) { return fields[k]; }).concat(Object.keys(fields).filter(function (k) { return SNAP_FIELDS.indexOf(k) === -1; }));
      if (!keys.length) return null;
      var loc = snapLocal(l) || {}, pushed = l.pushed_snapshot || {}, remote = l.remote_snapshot || {};
      return U.table([t('col_field'), t('col_local'), t('col_pushed'), t('col_remote')], keys.map(function (k) {
        return el('tr', { class: 'bill-diff-row' }, [U.td(B.lab('bill_field', k)), U.td(el('bdi', { class: 'bill-diff-local', text: B.val(loc[k]) })),
          U.td(el('bdi', { class: 'bill-diff-pushed', text: B.val(pushed[k]) })), U.td(el('bdi', { class: 'bill-diff-remote', text: B.val(remote[k]) }))]);
      }), { caption: t('drift_compare') });
    }
    function drawClients(d) {
      var items = U.rowsOf(d), unlinked = B.list(d.unlinked);
      body.appendChild(U.alertBox('info', t('drift_rule')));
      if (!items.length) body.appendChild(U.card(t('client_links'), U.emptyState('user', t('links_empty_title'), t('links_empty_text'))));
      else {
        var detailHost = el('div', { class: 'bill-drift-detail', 'aria-live': 'polite' });
        var rows = items.map(function (l) {
          var acts = el('div', { class: 'ops-row-actions' });
          var drift = B.list(l.drift);
          if (drift.length) acts.appendChild(U.btn(t('drift_show'), 'btn-subtle', function () {
            U.clear(detailHost);
            detailHost.appendChild(U.card(t('drift_compare') + ' · ' + B.clientName(l), [driftTable(l), el('p', { class: 'form-hint', text: t('drift_compare_hint') })],
              [U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { U.clear(detailHost); }, { 'aria-label': t('close'), title: t('close') })]));
          }));
          if (writer && l.external_id && l.status !== 'unlinked' && l.status !== 'needs_review') acts.appendChild(U.btn(t('client_refresh'), 'btn-secondary', function (b) {
            b.disabled = true;
            U.call(api, 'refreshDaftraClient', l.id).then(function (r) {
              if (!sc.alive()) return;
              b.disabled = false;
              if (r.error) { F.toastErr(api, r); return; }
              U.toast(api, t('job_queued'), 'success'); load();
            });
          }));
          if (approver && (l.status === 'drift' || l.status === 'needs_review')) acts.appendChild(U.btn(t('drift_resolve'), 'btn-primary', function () { resolveDialog(l).then(B.done(api, sc, t('drift_resolved'), load)); }));
          if (admin && l.status !== 'unlinked') acts.appendChild(U.btn(t('client_unlink'), 'btn-subtle', function () {
            F.noteDialog(api, { title: t('client_unlink'), noteLabel: t('reason'), danger: true, warn: t('unlink_warn'), submitText: t('client_unlink'),
              submit: function (note) { return U.call(api, 'unlinkDaftraClient', l.id, note); } }).then(B.done(api, sc, t('client_unlinked'), load));
          }));
          return el('tr', { 'data-id': l.id, class: 'bill-link-' + l.status + (l.status === 'unlinked' ? ' is-muted' : '') }, [
            U.td([el('span', { class: 'cell-main', text: B.clientName(l) }), U.pick(l, ['client_vat', 'vat_number', 'client.vat_number']) ? el('span', { class: 'cell-sub' }, [t('vat_no') + ' ', B.ref(U.pick(l, ['client_vat', 'vat_number', 'client.vat_number']))]) : null]),
            U.td(B.ref(l.client_ref)),
            U.td(B.ref(l.external_id)),
            U.td([B.pill('daftra_link_status', l.status, api), l.unlink_reason && l.status === 'unlinked' ? el('span', { class: 'cell-sub', text: l.unlink_reason }) : null]),
            U.td(drift.length ? el('span', { class: 'bill-drift' }, drift.map(function (f) { var p = String(f).split(':'); return U.pill('warning', B.lab('bill_drift', p[0]) + ': ' + B.lab('bill_field', p[1] || p[0])); }))
              : B.list(l.candidates).length ? el('span', { class: 'cell-sub', text: t('candidates_n', { n: B.list(l.candidates).length }) }) : null),
            U.td([B.when(l.last_synced_at), l.last_error_code ? el('span', { class: 'cell-sub fin-text-danger', text: l.last_error_code + (l.last_error_message ? ' · ' + l.last_error_message : '') }) : null], 'is-nowrap'),
            U.td(acts, 'ops-col-actions')
          ]);
        });
        body.appendChild(U.card(t('client_links'), U.table([t('col_client'), t('col_client_ref'), t('col_external_id'), t('col_status'), t('col_drift'), t('col_last_sync'), { label: t('actions'), cls: 'ops-col-actions' }], rows, { caption: t('client_links') }), null, { flush: true, sub: t('client_links_sub') }));
        body.appendChild(detailHost);
        var pg = F.pager(d.total != null ? +d.total : items.length, PAGE, CF.offset, function (o) { CF.offset = o; load(); });
        if (pg) body.appendChild(pg);
      }
      // billable clients without a link
      if (!unlinked.length) body.appendChild(U.card(t('unlinked_clients'), el('p', { class: 'text-sm text-muted', text: t('unlinked_empty') })));
      else body.appendChild(U.card(t('unlinked_clients') + ' (' + unlinked.length + ')', U.table([t('col_client'), t('vat_no'), { label: t('col_charges'), num: true }, { label: t('actions'), cls: 'ops-col-actions' }], unlinked.map(function (c) {
        var cid = c.client_id || c.id;
        return el('tr', { 'data-id': cid }, [
          U.td(el('span', { class: 'cell-main', text: (U.lang() === 'en' && c.name_en) || c.name_ar || B.clientName(c) })),
          U.td(c.vat_number ? B.ref(c.vat_number) : null),
          U.td(el('bdi', { dir: 'ltr', class: 'num', text: c.approved_count != null ? String(c.approved_count) : U.NONE }), 'num'),
          U.td(writer ? U.btn(t('client_link'), 'btn-secondary', function () { linkDialog(c, cid).then(B.done(api, sc, t('client_link_queued'), load)); }) : null, 'ops-col-actions')
        ]);
      }), { caption: t('unlinked_clients') }), null, { flush: true, sub: t('unlinked_sub') }));
    }
    function linkDialog(c, cid) {
      return U.formModal({
        title: t('client_link'), size: 'sm', intro: t('link_intro', { name: (U.lang() === 'en' && c.name_en) || c.name_ar || '' }), submitText: t('client_link'),
        fields: [{ name: 'external_id', label: t('f_external_client'), ltr: true, max: 64, pattern: EXT_RE, patternMsg: t('external_invalid'), hint: t('external_client_hint') }],
        submit: function (v) {
          var ext = U.nn(v.external_id);
          var scope = 'bill-link-' + cid, key = U.idemKey(api, scope, ext);
          return U.call(api, 'linkDaftraClient', cid, ext, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      });
    }
    function resolveDialog(l) {
      var review = l.status === 'needs_review';
      var cands = B.list(l.candidates);
      var decisions = review ? ['choose', 'create_new'] : ['acknowledge', 'push_local'];
      var fields = [{ name: 'decision', label: t('decision'), type: 'select', required: true, value: decisions[0], options: decisions.map(function (x) { return [x, B.lab('bill_drift_decision', x)]; }) }];
      if (review) fields.push({ name: 'external_id', label: t('f_candidate'), type: 'select', value: cands[0] ? cands[0].external_id : '',
        options: [['', U.NONE]].concat(cands.map(function (x) { return [x.external_id, [x.external_id, x.name, x.vat_number].filter(Boolean).join(' · ')]; })) });
      fields.push({ name: 'note', label: t('note'), type: 'textarea', required: true, max: 2000, rows: 3, hint: t('note_required_hint') });
      var intro = el('div', { class: 'fin-dialog-intro' }, [el('p', { class: 'ops-modal-intro', text: B.clientName(l) }), el('p', { class: 'form-hint', text: t(review ? 'review_client_help' : 'drift_help') }), review ? null : driftTable(l)]);
      var pr = U.formModal({
        title: t('drift_resolve'), intro: intro, submitText: t('drift_resolve'), size: review ? null : 'lg', fields: fields,
        validate: function (v) { return v.decision === 'choose' && !v.external_id ? { external_id: t('required') } : null; },
        submit: function (v) { return U.call(api, 'resolveClientDrift', l.id, v.decision, U.nn(v.note), v.decision === 'choose' ? v.external_id : null); }
      });
      var form = intro.closest('form');
      if (form && review) {
        var dec = form.elements.decision, ext = form.elements.external_id;
        var sync = function () { if (ext) ext.closest('.form-group').hidden = dec.value !== 'choose'; };
        dec.addEventListener('change', sync); sync();
      }
      return pr;
    }

    /* ---------------- tab «الأصناف» ---------------- */
    function loadItems() {
      return U.call(api, 'listDaftraItems').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        drawItems(U.rowsOf(r.data));
      });
    }
    function drawItems(items) {
      body.appendChild(U.alertBox('info', t('items_rule')));
      if (!items.length) { body.appendChild(U.card(t('items'), U.emptyState('list', t('items_empty_title'), t('items_empty_text')))); return; }
      body.appendChild(U.card(t('items') + ' (' + items.length + ')', U.table([t('col_item'), t('col_product_code'), t('col_names'), t('col_tax'), t('col_external_product'), t('col_status'), { label: t('actions'), cls: 'ops-col-actions' }], items.map(function (it) {
        var st = it.status || (it.exists === false || !it.id ? 'unmapped' : 'pending');
        return el('tr', { 'data-key': it.item_key, class: 'bill-item-' + st + (st === 'retired' ? ' is-muted' : '') }, [
          U.td([el('span', { class: 'cell-main', text: B.itemLabel(it.item_key) }), el('span', { class: 'cell-sub' }, B.ref(it.item_key))]),
          U.td(B.ref(it.product_code || ('MRS-' + String(it.item_key || '').replace(':', '-')))),
          U.td([el('span', { class: 'cell-main', text: it.name_ar || U.NONE }), it.name_en ? el('span', { class: 'cell-sub', text: it.name_en }) : null]),
          U.td([el('bdi', { dir: 'ltr', class: 'num', text: (it.default_vat_rate != null ? +it.default_vat_rate : '?') + '%' }), el('span', { class: 'cell-sub', text: B.lab('daftra_tax_code', it.tax_code) })]),
          U.td(it.external_product_id ? B.ref(it.external_product_id) : null),
          U.td([B.pill('daftra_item_status', st, api), B.list(it.candidates).length ? el('span', { class: 'cell-sub', text: t('candidates_n', { n: B.list(it.candidates).length }) + ': ' + B.list(it.candidates).map(function (x) { return x.external_product_id || x.id || x.external_id; }).filter(Boolean).join(', ') }) : null,
            it.last_error_code ? el('span', { class: 'cell-sub fin-text-danger', text: it.last_error_code }) : null]),
          U.td(admin ? U.btn(t('edit'), 'btn-secondary', function () { itemDialog(it).then(B.done(api, sc, t('item_saved'), load)); }) : null, 'ops-col-actions')
        ]);
      }), { caption: t('items') }), null, { flush: true, sub: t('items_sub') }));
    }
    function itemDialog(it) {
      return U.formModal({
        title: t('item_edit'), intro: B.itemLabel(it.item_key) + ' · ' + (it.product_code || ''), submitText: t('save'),
        fields: [
          { name: 'name_ar', label: t('f_name_ar'), required: true, max: 160, value: it.name_ar || '' },
          { name: 'name_en', label: t('f_name_en'), max: 160, ltr: true, value: it.name_en || '' },
          { name: 'default_vat_rate', label: t('f_default_vat') + ' %', required: true, ltr: true, inputmode: 'decimal', value: it.default_vat_rate != null ? String(+it.default_vat_rate) : '', pattern: RATE_RE, patternMsg: t('rate_invalid'), hint: t('item_vat_hint') },
          { name: 'tax_code', label: t('f_tax_code'), type: 'select', required: true, value: it.tax_code || 'standard', options: TAX_CODES.map(function (x) { return [x, B.lab('daftra_tax_code', x)]; }) },
          { name: 'external_product_id', label: t('f_external_product'), ltr: true, max: 64, pattern: EXT_RE, patternMsg: t('external_invalid'), value: it.external_product_id || '', hint: t('external_product_hint') },
          { name: 'retire', label: t('f_retire'), type: 'checkbox', value: it.status === 'retired', hint: t('retire_hint') }
        ],
        validate: function (v) {
          var bad = {}, r = F.num(v.default_vat_rate);
          if (r == null || isNaN(r) || r < 0 || r > 100) bad.default_vat_rate = t('rate_invalid');
          if (v.name_ar.length < 2) bad.name_ar = t('name_short');
          return bad;
        },
        submit: function (v) {
          return U.call(api, 'saveDaftraItem', it.item_key, { name_ar: v.name_ar, name_en: U.nn(v.name_en), default_vat_rate: F.r2(F.num(v.default_vat_rate)),
            tax_code: v.tax_code, external_product_id: U.nn(v.external_product_id), retire: !!v.retire });
        }
      });
    }
    return load();
  }

  Ops.views.daftra = {
    allow: 'finRead', titleKey: 'bill.nav_daftra', icon: 'link',
    render: function (root, api, param) { return render(root, api, param); }
  };
})();

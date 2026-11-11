/* ==========================================================================
   مرسى | MARSA — legacy step 7 «مواءمة دفترة»: the step-7 parts of #daftra (MarsaOps.dftSettings)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DAFTRA_AR.md (§1 owner decisions, §3 rules, §5 MarsaApi).
   Called by assets/js/bill/daftra.js (loaded after this file):
     connectionCards(ctx, d)  — on the «الاتصال» tab: the KSA account guard (what the owner changes in Daftra), the write
                                policy (read only: «ممنوع» + the reason; NO control — owner-only, audited, server side),
                                the org draft settings (auto_draft_on_declaration / purchase_drafts_enabled: owner-only
                                toggles, OFF by default) and the read-only older-invoice scan
     render(tab, ctx)         — the tabs 'products' (#daftra/products: product codes of the service catalog, read-only
                                match, human confirmation, unmapped list), 'fields' (#daftra/fields: the CustomModel map +
                                the owner's dry run), 'import' (#daftra/import: Daftra client import + the tenant CSV/XLSX
                                file) and 'reviews' (#daftra/reviews: the step-7 review items)
   ctx = { B (billKit), api, body, reload(), sc }
   * Nothing here writes to Daftra: requests are read-only jobs or settings; the server re-checks every role
     (bill_admin / owner / import roles) and every rule.
   * Server and user data are inserted with textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  var TABS = ['products', 'fields', 'import', 'reviews'];

  function K() { return Ops.dftKit; }
  // review: the owner = an ORG-WIDE admin (app.daftra_is_owner: branch_id IS NULL), not any admin membership (api.orgOwner
  // from admin.js); older hosts without the flag fall back to "no owner" (fail closed: the server decides anyway)
  function isOwner(api) { try { return !!(api && api.orgOwner === true && typeof api.can === 'function' && api.can('orgAdmin')); } catch (e) { return false; } }
  function canImport(api) { try { return !!(api && typeof api.can === 'function' && api.can(['admin', 'operations_manager', 'accounts_manager'])); } catch (e) { return false; } }

  /* ==================================================================
     «الاتصال» tab — account guard, write policy, org settings, legacy scan
     ================================================================== */
  function connectionCards(ctx, d) {
    var D = K(), B = ctx.B, U = B.U, F = B.F, el = B.el, api = ctx.api;
    var c = (d && d.connection) || {};
    var out = [];
    // --- KSA account guard
    var check = c.account_check || null, view = D.accountView(check);
    var acctKids = [];
    if (view.ok) acctKids.push(U.alertBox('success', c.mode === 'mock' || !view.enforced ? D.t('acct_ok_mock') : D.t('acct_ok')));
    else {
      acctKids.push(el('div', { class: 'alert alert-danger dft-ksa-block', role: 'alert', 'data-dft': 'ksa-block' }, [U.icon('alert'),
        el('div', { text: D.t('acct_block', { reason: D.t('acct_reason_' + view.reason) }) })]));
      acctKids.push(el('div', { class: 'dft-fix' }, [el('strong', { text: D.t('acct_fix_title') }),
        el('ol', { class: 'dft-fix-list' }, view.fixes.map(function (k) { return el('li', { 'data-fix': k, text: D.t(k) }); }))]));
    }
    var chk = check || {};
    acctKids.push(F.dl([
      [D.t('acct_currency'), chk.currency ? B.ref(chk.currency) : el('span', { class: 'ops-muted', text: U.NONE })],
      [D.t('acct_country'), chk.country ? el('bdi', { text: String(chk.country) }) : el('span', { class: 'ops-muted', text: U.NONE })],
      [D.t('acct_vat15'), U.pill(chk.vat_15 ? 'success' : 'danger', chk.vat_15 ? D.t('acct_vat_yes') : D.t('acct_vat_no'))],
      [D.t('acct_mode'), el('span', { class: 'text-xs', text: chk.enforced ? D.t('acct_enforced') : D.t('acct_not_enforced') })],
      [D.t('acct_checked_at'), chk.checked_at ? B.when(chk.checked_at) : el('span', { class: 'ops-muted', text: U.NONE })]
    ]));
    out.push(U.card(D.t('acct_title'), acctKids, null, { sub: D.t('acct_sub'), cls: 'dft-account' + (view.ok ? '' : ' is-blocked') }));

    // --- write policy (read only)
    var upd = c.allow_draft_update === true, mk = c.allow_product_create === true;
    var pol = F.dl([
      [D.t('pol_draft_update'), el('span', null, [U.pill(upd ? 'warning' : 'danger', upd ? D.t('pol_allowed') : D.t('pol_forbidden')),
        el('span', { class: 'cell-sub', text: ' ' + D.t('pol_draft_reason') })])],
      [D.t('pol_product_create'), el('span', null, [U.pill(mk ? 'warning' : 'danger', mk ? D.t('pol_allowed') : D.t('pol_forbidden')),
        el('span', { class: 'cell-sub', text: ' ' + D.t('pol_product_reason') })])]
    ]);
    out.push(U.card(D.t('pol_title'), [pol,
      c.policy_changed_at ? el('p', { class: 'form-hint', text: D.t('pol_changed', { at: B.when(c.policy_changed_at), reason: c.policy_reason || U.NONE }) }) : null,
      el('p', { class: 'form-hint dft-owner-only', text: D.t('pol_owner_only') }),
      el('p', { class: 'form-hint', text: D.t('pol_ai') })], null, { sub: D.t('pol_sub'), cls: 'dft-policy', 'data-dft': 'policy' }));

    // --- org draft settings (owner-only toggles, OFF by default)
    var owner = isOwner(api);
    function toggleRow(name, on, hint) {
      var label = D.t(name === 'auto_draft_on_declaration' ? 'org_auto' : 'org_purchase');
      var act = owner ? U.btn(on ? D.t('org_turn_off') : D.t('org_turn_on'), on ? 'btn-secondary' : 'btn-primary', function (b) {
        // review: owner only on the server too (set_daftra_write_policy: org-wide admin, a written reason, audited)
        U.formModal({
          title: D.t('org_confirm_title', { act: on ? D.t('org_turn_off') : D.t('org_turn_on'), name: label }), size: 'sm', intro: D.t('org_confirm_text'),
          submitText: on ? D.t('org_turn_off') : D.t('org_turn_on'), danger: !on,
          fields: [{ name: 'reason', label: D.t('org_reason'), type: 'textarea', required: true, max: 500 }],
          validate: function (v) { return String(v.reason || '').trim().length < 3 ? { reason: D.t('required') } : null; },
          submit: function (v) { var p = {}; p[name] = !on; return U.call(api, 'setDaftraWritePolicy', p, String(v.reason).trim()); }
        }).then(function (ok) { if (ok && ctx.sc.alive()) { U.toast(api, D.t('org_saved'), 'success'); ctx.reload(); } });
      }, { 'data-act': 'dft-toggle-' + name }) : null;
      return el('div', { class: 'dft-toggle', 'data-setting': name }, [
        el('div', { class: 'dft-toggle-main' }, [el('strong', { text: label }), ' ', U.pill(on ? 'warning' : 'neutral', on ? D.t('org_on') : D.t('org_off'))]),
        el('p', { class: 'form-hint', text: hint }), act
      ]);
    }
    out.push(U.card(D.t('org_title'), [
      toggleRow('auto_draft_on_declaration', c.auto_draft_on_declaration === true, D.t('org_auto_hint')),
      toggleRow('purchase_drafts_enabled', c.purchase_drafts_enabled === true, D.t('org_purchase_hint')),
      F.dl([[D.t('org_opening_item'), B.ref(c.opening_item || 'item:customs_clearance')], [D.t('org_purchase_item'), B.ref(c.purchase_item || 'item:transportation_cost')]]),
      owner ? null : el('p', { class: 'form-hint', text: D.t('org_owner_note') })
    ], null, { sub: D.t('org_sub'), cls: 'dft-org' }));

    // --- legacy invoice scan (read only, resumable)
    if (B.canAdmin(api)) {
      var scanInfo = el('div', { class: 'dft-scan-info', 'aria-live': 'polite' });
      var last = D.recallRuns(api && api.orgId, ['legacy_scan'])[0];
      if (last) U.call(api, 'getDaftraRun', last.id).then(function (r) {
        if (!ctx.sc.alive() || r.error) return;
        var run = F.dataOf(r), cn = run.counters || {};
        U.clear(scanInfo);
        scanInfo.appendChild(el('p', { class: 'text-sm' }, [U.pill(run.status === 'failed' || run.status === 'aborted' ? 'danger' : run.status === 'done' ? 'success' : 'info', D.t('run_st_' + run.status)),
          ' ' + D.t('scan_counters', { s: cn.invoices_seen || 0, c: cn.candidates || 0 })]));
        if (run.error_code) scanInfo.appendChild(D.errNode({ code: run.error_code, message: run.error_message }, 'form-error'));
      });
      var scan = function (restart) {
        return function (b) {
          b.disabled = true;
          var p = restart ? { restart: true } : {}, scope = 'dft-scan', key = U.idemKey(api, scope, p);
          U.call(api, 'requestDaftraLegacyScan', p, { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            if (!ctx.sc.alive()) return;
            b.disabled = false;
            if (r.error) { F.toastErr(api, r); return; }
            var run = F.dataOf(r);
            D.rememberRun(api && api.orgId, run);
            U.toast(api, run.resumed ? D.t('scan_resumed') : D.t('scan_queued'), 'success'); ctx.reload();
          });
        };
      };
      out.push(U.card(D.t('scan_title'), [el('p', { class: 'text-sm', text: D.t('scan_text') }), scanInfo],
        [U.btn(D.t('scan_request'), 'btn-secondary', scan(false), { 'data-act': 'dft-scan' }), U.btn(D.t('scan_restart'), 'btn-subtle', scan(true), { 'data-act': 'dft-scan-restart' })],
        { cls: 'dft-scan' }));
    }
    return out;
  }

  /* ==================================================================
     «الأصناف بالكود» tab
     ================================================================== */
  function itemName(B, row) {
    var s = row.service_item;
    if (s) return (B.U.lang() === 'en' && s.name_en) || s.name_ar || s.name_en || s.code;
    return B.itemLabel(row.item_key);
  }
  function renderProducts(ctx) {
    var D = K(), B = ctx.B, U = B.U, F = B.F, el = B.el, api = ctx.api, body = ctx.body, admin = B.canAdmin(api);
    return U.call(api, 'listDaftraProductMap').then(function (r) {
      if (!ctx.sc.alive()) return;
      U.doneLoading(body);
      if (r.error) { body.appendChild(U.errorState(api, r.error, ctx.reload)); return; }
      var d = F.dataOf(r), items = U.rowsOf(d), counts = d.counts || {};
      body.appendChild(U.alertBox('info', D.t('pm_sub')));
      if (d.policy && d.policy.allow_product_create) body.appendChild(U.alertBox('warning', D.t('pm_policy_create')));
      var un = D.unmappedKeys(items);
      if (un.length) {
        var names = items.filter(function (x) { return un.indexOf(x.item_key) !== -1; }).map(function (x) { return itemName(B, x); });
        body.appendChild(el('div', { class: 'alert alert-warning dft-unmapped', role: 'status', 'data-dft': 'unmapped' }, [U.icon('alert'),
          el('div', null, [el('strong', { text: D.t('pm_unmapped_title', { n: un.length }) }), el('span', { text: ' ' + D.t('pm_unmapped_text', { list: names.join(D.t('list_sep')) }) })])]));
      }
      if (!items.length) { body.appendChild(U.card(D.t('pm_title'), U.emptyState('list', null, D.t('pm_empty')))); return; }
      var matchAll = admin ? U.btn(D.t('pm_match_all'), 'btn-primary', function (b) { requestMatch(b, null); }, { 'data-act': 'dft-match-all' }) : null;
      var rows = items.map(function (x) {
        var l = x.link || {}, st = D.productState(x), cands = (l.candidates || []);
        var acts = el('div', { class: 'ops-row-actions' });
        if (admin) acts.appendChild(U.btn(D.t('pm_set_code'), 'btn-secondary', function () { codeDialog(x); }, { 'data-act': 'dft-code' }));
        if (admin && l.remote_code_norm && !x.mapped) acts.appendChild(U.btn(D.t('pm_match_one'), 'btn-subtle', function (b) { requestMatch(b, [x.item_key]); }, { 'data-act': 'dft-match' }));
        var candNode = !cands.length ? el('span', { class: 'cell-sub', text: l.match_checked_at ? D.t('pm_st_not_found') : D.t('pm_no_candidates') })
          : el('ul', { class: 'dft-cands' }, cands.map(function (c) {
            var li = el('li', { 'data-ext': c.external_product_id }, [el('bdi', { dir: 'ltr', class: 'bill-ref', text: (c.code || '?') + ' · #' + c.external_product_id }),
              ' ', el('span', { text: c.name || '' }), ' ', U.pill(c.exact ? 'success' : 'neutral', c.exact ? D.t('pm_exact') : D.t('pm_not_exact'))]);
            if (admin && c.exact && !x.mapped) li.appendChild(U.btn(D.t('pm_confirm'), 'btn-primary', function () { confirmDialog(x, c); }, { 'data-act': 'dft-confirm' }));
            return li;
          }));
        return el('tr', { 'data-key': x.item_key, 'data-state': st }, [
          U.td([el('span', { class: 'cell-main', text: itemName(B, x) }), el('span', { class: 'cell-sub' }, [B.ref(x.item_key)]),
            x.service_item && x.service_item.is_active === false ? el('span', { class: 'cell-sub', text: D.t('pm_inactive') }) : null]),
          U.td(l.remote_product_code ? B.ref(l.remote_product_code) : null),
          U.td(l.external_product_id && x.mapped ? B.ref('#' + l.external_product_id) : null),
          U.td([U.pill(st === 'mapped' ? 'success' : st === 'not_found' ? 'danger' : st === 'code_only' ? 'warning' : 'neutral', D.t('pm_st_' + st)),
            l.match_checked_at ? el('span', { class: 'cell-sub', text: D.t('pm_checked', { at: B.when(l.match_checked_at) }) }) : null]),
          U.td(candNode),
          U.td(acts, 'ops-col-actions')
        ]);
      });
      body.appendChild(U.card(D.t('pm_title') + ' · ' + D.t('pm_counts', { m: counts.mapped || 0, n: counts.total || items.length }),
        U.table([D.t('pm_col_item'), D.t('pm_col_code'), D.t('pm_col_product'), D.t('pm_col_state'), D.t('pm_col_candidates'), { label: B.t('actions'), cls: 'ops-col-actions' }], rows, { caption: D.t('pm_title') }),
        [matchAll], { flush: true, cls: 'dft-products' }));
    });
    function requestMatch(b, keys) {
      b.disabled = true;
      var scope = 'dft-match-' + (keys ? keys.join(',') : 'all'), key = U.idemKey(api, scope, keys);
      U.call(api, 'requestDaftraProductMatch', keys, { idemKey: key }).then(function (r) {
        U.idemSettle(scope, r.error);
        if (!ctx.sc.alive()) return;
        b.disabled = false;
        if (r.error) { F.toastErr(api, r); return; }
        D.rememberRun(api && api.orgId, F.dataOf(r));
        U.toast(api, D.t('pm_match_queued'), 'success'); ctx.reload();
      });
    }
    function codeDialog(x) {
      var l = x.link || {};
      U.formModal({
        title: D.t('pm_set_code'), size: 'sm', intro: itemName(B, x) + ' · ' + x.item_key, submitText: D.t('save'),
        fields: [{ name: 'code', label: D.t('pm_code'), ltr: true, max: 40, value: l.remote_product_code || '', hint: D.t('pm_code_hint') }],
        validate: function (v) { var c = D.western(v.code).trim(); return c && !D.CODE_RE.test(c) ? { code: D.t('pm_code_bad') } : null; },
        fieldMap: { remote_product_code: 'code' },
        submit: function (v) { var c = D.western(v.code).trim(); return U.call(api, 'saveDaftraProductCode', x.item_key, c || null); }
      }).then(B.done(api, ctx.sc, D.t('pm_code_saved'), ctx.reload));
    }
    function confirmDialog(x, c) {
      var l = x.link || {};
      U.formModal({
        title: D.t('pm_confirm_title'), size: 'sm', submitText: D.t('pm_confirm_ok'),
        intro: D.t('pm_confirm_text', { item: itemName(B, x), code: l.remote_product_code || '', ext: c.external_product_id, name: c.name || '', rcode: c.code || '' }),
        fields: [],
        submit: function () { return U.call(api, 'confirmDaftraProductMapping', x.item_key, c.external_product_id); }
      }).then(B.done(api, ctx.sc, D.t('pm_confirmed'), ctx.reload));
    }
  }

  /* ==================================================================
     «الحقول الإضافية» tab (CustomModel map + the owner's dry run)
     ================================================================== */
  function renderFields(ctx) {
    var D = K(), B = ctx.B, U = B.U, F = B.F, el = B.el, api = ctx.api, body = ctx.body, owner = isOwner(api);
    return Promise.all([U.call(api, 'getDaftraConnection'), U.call(api, 'listCustomsPorts')]).then(function (res) {
      if (!ctx.sc.alive()) return;
      U.doneLoading(body);
      if (res[0].error) { body.appendChild(U.errorState(api, res[0].error, ctx.reload)); return; }
      var c = F.dataOf(res[0]).connection || {}, map = c.custom_field_map || {}, fields = map.fields || {};
      var ports = res[1].error ? [] : U.rowsOf(res[1].data).filter(function (p) { return p && p.is_active !== false; });
      body.appendChild(U.alertBox('info', D.t('cf_sub')));
      var rows = D.CUSTOM_FIELDS.map(function (f) {
        var x = fields[f];
        return el('tr', { 'data-field': f }, [U.td(el('span', { class: 'cell-main', text: D.t('cf_' + f) })),
          U.td(x && x.key ? B.ref(x.key) : el('span', { class: 'ops-muted', text: D.t('cf_not_sent') })),
          U.td(x && x.required ? U.pill('warning', D.t('cf_req')) : null)]);
      });
      // review: the map is a bill_admin setting on the server (save_daftra_custom_fields); the dry run stays owner only
      var canEdit = B.canAdmin(api);
      var edit = canEdit ? U.btn(D.t('cf_edit'), 'btn-primary', function () { editDialog(c, ports); }, { 'data-act': 'dft-cf-edit' }) : null;
      body.appendChild(U.card(D.t('cf_title'), U.table([D.t('cf_col_field'), D.t('cf_col_key'), D.t('cf_col_required')], rows, { caption: D.t('cf_title') }),
        [edit], { flush: true, cls: 'dft-fields', sub: canEdit ? null : D.t('bill_admin_only') }));
      var tv = map.type_values || {}, pv = map.port_values || {};
      body.appendChild(U.card(D.t('cf_values_title'), [
        F.dl(D.DECL_TYPES.map(function (d) { return [D.t('cf_type_' + d), el('span', { text: tv[d] || D.t('cf_type_default', { v: D.TYPE_DEFAULTS[d] }) })]; })),
        ports.length ? F.dl(ports.map(function (p) { return [(U.lang() === 'en' && p.name_en) || p.name_ar || p.code, el('span', { text: pv[p.code] || p.daftra_value || p.name_ar || U.NONE })]; }))
          : el('p', { class: 'form-hint', text: D.t('cf_no_ports') })
      ], null, { cls: 'dft-values' }));
      if (owner) body.appendChild(dryRunCard());
    });
    function editDialog(c, ports) {
      var map = c.custom_field_map || {}, fields = map.fields || {}, tv = map.type_values || {}, pv = map.port_values || {};
      var list = [];
      D.CUSTOM_FIELDS.forEach(function (f) {
        list.push({ name: 'key_' + f, label: D.t('cf_' + f), ltr: true, max: 40, value: (fields[f] && fields[f].key) || '', placeholder: 'field_1' });
        list.push({ name: 'req_' + f, label: D.t('cf_req') + ' — ' + D.t('cf_' + f), type: 'checkbox', value: !!(fields[f] && fields[f].required) });
      });
      D.DECL_TYPES.forEach(function (d) { list.push({ name: 'type_' + d, label: D.t('cf_type_values') + ': ' + D.t('cf_type_' + d), max: 120, value: tv[d] || '', placeholder: D.TYPE_DEFAULTS[d] }); });
      ports.forEach(function (p) { list.push({ name: 'port_' + p.code, label: D.t('cf_port_values') + ': ' + ((U.lang() === 'en' && p.name_en) || p.name_ar || p.code), max: 120, value: pv[p.code] || '', placeholder: p.daftra_value || p.name_ar || '', hint: D.t('cf_port_hint') }); });
      var codes = ports.map(function (p) { return p.code; });
      U.formModal({
        title: D.t('cf_edit'), size: 'lg', intro: D.t('cf_key_hint'), submitText: D.t('save'), fields: list,
        validate: function (v) { var e = D.customMapPayload(v, codes).errors, out = {}; Object.keys(e).forEach(function (k) { out[k] = D.t(e[k]); }); return out; },
        submit: function (v) { return U.call(api, 'saveDaftraCustomFields', D.customMapPayload(v, codes).map); }
      }).then(B.done(api, ctx.sc, D.t('cf_saved'), ctx.reload));
    }
    function dryRunCard() {
      var out = el('div', { class: 'dft-dry-out', 'aria-live': 'polite' });
      var finder = F.txFinder(api, function (tx) {
        U.loadingInto(out);
        U.call(api, 'testDaftraCustomFields', tx.id).then(function (r) {
          if (!ctx.sc.alive()) return;
          U.doneLoading(out);
          if (r.error) { out.appendChild(U.errorState(api, r.error)); return; }
          var x = F.dataOf(r), miss = x.missing || [], un = x.unmapped || [];
          var acc = D.accountView(x.account_check);
          out.appendChild(U.alertBox(x.ok && acc.ok && x.client_linked ? 'success' : 'warning', x.ok ? D.t(acc.ok && x.client_linked ? 'cf_dry_ok' : 'cf_dry_ok_blocked') : D.t('cf_dry_not_sent')));
          if (!acc.ok) out.appendChild(U.alertBox('danger', D.t('acct_block', { reason: D.t('acct_reason_' + acc.reason) })));
          if (miss.length) out.appendChild(el('p', { class: 'form-error', 'data-dft': 'dry-missing', text: D.t('cf_dry_missing', { list: miss.map(D.fieldLabel).join(D.t('list_sep')) }) }));
          if (un.length) out.appendChild(el('p', { class: 'form-error', text: D.t('cf_dry_unmapped', { list: un.join(D.t('list_sep')) }) }));
          if (!x.client_linked) out.appendChild(el('p', { class: 'form-error', text: D.t('cf_dry_client_unlinked') }));
          var vals = x.values || {};
          out.appendChild(el('h4', { class: 'ops-sub-title', text: D.t('cf_dry_values') }));
          out.appendChild(F.dl(D.CUSTOM_FIELDS.map(function (f) { return [D.t('cf_' + f), vals[f] ? el('bdi', { text: String(vals[f]) }) : el('span', { class: 'ops-muted', text: U.NONE })]; })
            .concat([[D.t('cf_dry_date'), B.ref(x.payload && x.payload.invoice_date)]])));
          out.appendChild(el('h4', { class: 'ops-sub-title', text: D.t('cf_dry_payload') }));
          out.appendChild(B.pre(x.payload || {}));
          out.appendChild(el('p', { class: 'form-hint', text: D.t('cf_dry_not_sent') }));
        });
      });
      return U.card(D.t('cf_dry'), [el('p', { class: 'text-sm', text: D.t('cf_dry_sub') }), el('label', { class: 'form-label', text: D.t('cf_dry_pick') }), finder.node, out], null, { cls: 'dft-dry' });
    }
  }

  /* ==================================================================
     «استيراد العملاء» tab
     ================================================================== */
  var IM = { org: null, run: null, action: '', decisions: {}, offset: 0 };
  var IM_PAGE = 200;
  function renderImport(ctx) {
    var D = K(), B = ctx.B, U = B.U, F = B.F, el = B.el, api = ctx.api, body = ctx.body;
    var admin = B.canAdmin(api), importer = canImport(api), orgId = api && api.orgId;
    // review: the import state belongs to one org (an org switch never opens the previous org's run)
    if (IM.org !== orgId) { IM.org = orgId; IM.run = null; IM.action = ''; IM.decisions = {}; IM.offset = 0; }
    U.doneLoading(body);
    body.appendChild(U.alertBox('info', D.t('im_sub')));
    // --- from Daftra
    body.appendChild(U.card(D.t('im_daftra_title'), el('p', { class: 'text-sm', text: D.t('im_daftra_text') }),
      [admin ? U.btn(D.t('im_request'), 'btn-primary', function (b) {
        b.disabled = true;
        var scope = 'dft-import', key = U.idemKey(api, scope, { org: orgId });
        U.call(api, 'requestDaftraClientImport', { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!ctx.sc.alive()) return;
          b.disabled = false;
          if (r.error) { F.toastErr(api, r); return; }
          var run = F.dataOf(r);
          D.rememberRun(orgId, run); IM.run = run.id; IM.decisions = {}; IM.offset = 0;
          U.toast(api, run.deduplicated ? D.t('im_dedup') : D.t('im_requested'), 'success'); ctx.reload();
        });
      }, { 'data-act': 'dft-import-daftra' }) : null], { cls: 'dft-im-daftra' }));
    // --- from the tenant file
    if (importer) body.appendChild(fileCard());
    // --- remembered runs
    var runs = D.recallRuns(orgId, ['client_import', 'client_file']);
    if (!IM.run && runs.length) IM.run = runs[0].id;
    body.appendChild(U.card(D.t('im_last_runs'), runs.length ? el('ul', { class: 'dft-runs' }, runs.map(function (x) {
      var li = el('li', { class: x.id === IM.run ? 'is-current' : null }, [el('span', { text: D.t('im_run_of', { kind: D.t('run_kind_' + x.kind), at: B.when(x.at) }) }), ' ']);
      li.appendChild(U.btn(D.t('im_open_run'), 'btn-subtle', function () { IM.run = x.id; IM.decisions = {}; IM.offset = 0; ctx.reload(); }));
      return li;
    })) : el('p', { class: 'text-sm text-muted', text: D.t('im_no_runs') }), null, { cls: 'dft-im-runs' }));
    var host = el('div', { class: 'dft-im-run', 'aria-live': 'polite' });
    body.appendChild(host);
    if (IM.run) loadRun(host);
    return Promise.resolve();

    function fileCard() {
      var inp = el('input', { type: 'file', class: 'form-control', name: 'client_file', accept: '.csv,.xlsx,.txt', 'aria-label': D.t('im_file_pick') });
      var dry = el('input', { type: 'checkbox', name: 'dry_run' }); dry.checked = true;
      var msg = el('div', { class: 'dft-im-file-msg', 'aria-live': 'polite' });
      var go = U.btn(D.t('im_upload'), 'btn-primary', function (b) {
        U.clear(msg);
        var f = inp.files && inp.files[0];
        if (!f) { msg.appendChild(el('p', { class: 'form-error', text: D.t('im_file_e_pick') })); return; }
        b.disabled = true;
        D.readTable(f).then(function (rows2d) {
          var m = D.mapImportRows(rows2d);
          if (m.error) throw m.error;
          msg.appendChild(el('p', { class: 'text-sm', text: D.t('im_file_read', { n: m.rows.length, skipped: m.skipped }) }));
          if (m.unknown.length) msg.appendChild(el('p', { class: 'form-hint', text: D.t('im_file_unknown', { list: m.unknown.join(D.t('list_sep')) }) }));
          var opts = { dry_run: !!dry.checked, file_name: String(f.name || '').slice(0, 200) };
          var scope = 'dft-file', key = U.idemKey(api, scope, { rows: m.rows, o: opts });
          return U.call(api, 'importClients', m.rows, opts, { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            if (r.error) throw { api: r.error };
            var run = F.dataOf(r);
            D.rememberRun(orgId, run); IM.run = run.id; IM.decisions = {}; IM.offset = 0;
            U.toast(api, D.t('im_file_done', { n: m.rows.length }), 'success');
            if (ctx.sc.alive()) ctx.reload();
          });
        }).catch(function (e) {
          if (!ctx.sc.alive()) return;
          b.disabled = false;
          msg.appendChild(el('p', { class: 'form-error', role: 'alert', text: typeof e === 'string' ? D.t(e) : e && e.api ? U.errMsg(e.api, api) : D.t('im_file_e_read') }));
        });
      }, { 'data-act': 'dft-import-file' });
      return U.card(D.t('im_file_title'), [el('p', { class: 'text-sm', text: D.t('im_file_text') }), el('p', { class: 'form-hint', text: D.t('im_file_cols') }),
        el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: D.t('im_file_pick') }), inp]),
        el('label', { class: 'check ops-check' }, [dry, el('span', { text: D.t('im_dry') })]), go, msg], null, { cls: 'dft-im-file' });
    }
    function loadRun(hostEl) {
      U.loadingInto(hostEl);
      // review: paged (the server returns total; ≤ 2000 file rows / many Daftra pages): every row can get a decision
      var f = { limit: IM_PAGE, offset: IM.offset || 0 };
      if (IM.action) f.action = IM.action;
      U.call(api, 'listDaftraClientImport', IM.run, f).then(function (r) {
        if (!ctx.sc.alive()) return;
        U.doneLoading(hostEl);
        if (r.error) { hostEl.appendChild(U.errorState(api, r.error)); return; }
        drawRun(hostEl, F.dataOf(r));
      });
    }
    function drawRun(hostEl, d) {
      var run = d.run || {}, rows = U.rowsOf(d), cn = run.counters || {};
      var mine = run.kind === 'client_import' ? admin : importer;
      var head = [U.pill(run.status === 'aborted' || run.status === 'failed' ? 'danger' : run.status === 'ready' ? 'warning' : run.status === 'applied' || run.status === 'done' ? 'success' : 'info', D.t('run_st_' + run.status)),
        ' ', el('span', { class: 'text-sm', text: D.t('run_kind_' + run.kind) + ' · ' + B.when(run.created_at) })];
      var kids = [el('p', { class: 'dft-run-head' }, head),
        el('p', { class: 'text-sm', 'data-dft': 'counters', text: D.t('im_counters', { r: cn.received || 0, c: cn.created || 0, l: cn.linked || 0, u: cn.updated || 0, s: cn.skipped || 0, x: cn.conflicts || 0, w: cn.waiting != null ? cn.waiting : U.NONE }) })];
      if (run.status === 'aborted' || run.error_code === 'empty_result') kids.push(U.alertBox('danger', D.t('im_aborted')));
      else if (run.error_code) kids.push(D.errNode({ code: run.error_code, message: run.error_message }, 'form-error'));
      var acts = ['', 'create', 'link', 'update_link', 'review_name', 'conflict', 'invalid'];
      kids.push(U.toolbar(null, [U.select('action', D.t('im_filter_action'), acts.map(function (a) { return [a, a ? D.t('act_' + a) : D.t('all')]; }), IM.action, function (v) { IM.action = v; IM.offset = 0; loadRun(hostEl); })],
        [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', function () { loadRun(hostEl); }, { 'aria-label': D.t('refresh'), title: D.t('refresh') })], D.t('count_n', { n: d.total != null ? d.total : rows.length })));
      var ready = run.status === 'ready' || run.status === 'applied';
      var trs = rows.map(function (w) {
        var needs = w.status === 'conflict' || (w.status === 'pending' && w.proposed_action === 'review_name');
        var dec = null;
        if (mine && ready && (w.status === 'pending' || w.status === 'conflict')) {
          var opts = [['', D.t('im_dec_none')]];
          if (w.match_client_id) opts.push(['link', D.t('im_dec_link')]);
          opts.push(['create', D.t('im_dec_create')], ['skip', D.t('im_dec_skip')]);
          dec = el('select', { class: 'form-control form-control-sm', name: 'dec_' + w.id, 'aria-label': D.t('im_col_decision') }, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
          dec.value = IM.decisions[w.id] ? IM.decisions[w.id].action : '';
          dec.addEventListener('change', function () {
            if (!dec.value) delete IM.decisions[w.id];
            else IM.decisions[w.id] = dec.value === 'link' ? { row_id: w.id, action: 'link', client_id: w.match_client_id } : { row_id: w.id, action: dec.value };
            syncApply();
          });
        }
        return el('tr', { 'data-row': w.id, 'data-action': w.proposed_action, class: needs ? 'dft-row-review' : w.status === 'skipped' ? 'is-muted' : null }, [
          U.td(el('bdi', { dir: 'ltr', class: 'num', text: String(w.seq) }), 'num'),
          U.td([el('span', { class: 'cell-main', text: w.name_ar || U.NONE }), w.name_en ? el('span', { class: 'cell-sub', text: w.name_en }) : null,
            w.suspended ? el('span', { class: 'cell-sub fin-text-danger', text: D.t('im_suspended') }) : null]),
          U.td([B.ref(w.client_number), w.external_id ? el('span', { class: 'cell-sub' }, B.ref('#' + w.external_id)) : null]),
          U.td([B.ref(w.vat_number), w.cr_number ? el('span', { class: 'cell-sub' }, B.ref(w.cr_number)) : null]),
          U.td([U.pill(w.proposed_action === 'conflict' || w.proposed_action === 'invalid' ? 'danger' : w.proposed_action === 'review_name' ? 'warning' : 'info', D.t('act_' + w.proposed_action)),
            w.match_reason ? el('span', { class: 'cell-sub', text: D.has('reason_' + w.match_reason) ? D.t('reason_' + w.match_reason) : w.match_reason }) : null]),
          U.td(w.match_client_id ? el('span', { text: w.match_client_name || String(w.match_client_id).slice(0, 8) }) : null),
          U.td(U.pill(w.status === 'applied' ? 'success' : w.status === 'conflict' ? 'danger' : 'neutral', D.t('row_st_' + w.status))),
          U.td(dec)
        ]);
      });
      kids.push(U.table([D.t('im_col_seq'), D.t('im_col_name'), D.t('im_col_number'), D.t('im_col_vat'), D.t('im_col_action'), D.t('im_col_match'), D.t('im_col_status'), D.t('im_col_decision')],
        trs, { caption: D.t('im_rows_title', { n: rows.length }) }));
      // the decisions made on other pages are kept (IM.decisions) until applied
      var pg = F.pager(d.total != null ? +d.total : rows.length, IM_PAGE, IM.offset || 0, function (o) { IM.offset = o; loadRun(hostEl); });
      if (pg) kids.push(pg);
      var applySafe = null, applyMine = null;
      function apply(b, payload) {
        b.disabled = true;
        var scope = 'dft-apply-' + run.id, key = U.idemKey(api, scope, payload);
        U.call(api, 'applyDaftraClientImport', run.id, payload, { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!ctx.sc.alive()) return;
          b.disabled = false;
          if (r.error) { F.toastErr(api, r); return; }
          IM.decisions = {};
          U.toast(api, D.t('im_applied', { w: F.dataOf(r).waiting != null ? F.dataOf(r).waiting : 0 }), 'success');
          loadRun(hostEl);
        });
      }
      function decisionList() { return Object.keys(IM.decisions).map(function (k) { return IM.decisions[k]; }); }
      function syncApply() { if (applyMine) { applyMine.textContent = D.t('im_apply_decisions', { n: decisionList().length }); applyMine.disabled = !decisionList().length; } }
      if (mine && ready) {
        applySafe = U.btn(D.t('im_apply_safe'), 'btn-primary', function (b) { apply(b, { apply_safe: true }); }, { 'data-act': 'dft-apply-safe' });
        applyMine = U.btn(D.t('im_apply_decisions', { n: 0 }), 'btn-secondary', function (b) { apply(b, { decisions: decisionList(), apply_safe: false }); }, { 'data-act': 'dft-apply-mine' });
        syncApply();
      } else if (mine && !ready && run.status !== 'aborted') kids.push(el('p', { class: 'form-hint', text: D.t('im_not_ready', { s: D.t('run_st_' + run.status) }) }));
      hostEl.appendChild(U.card(D.t('im_run') + ' · ' + D.t('run_kind_' + run.kind), kids, [applySafe, applyMine], { cls: 'dft-im-rows' }));
    }
  }

  /* ==================================================================
     «مراجعات دفترة» tab
     ================================================================== */
  var RV = { kind: '', offset: 0 };
  function reviewBlock(api, item, can, onDone) {
    var D = K(), U = Ops.ui, el = D.el;
    var lines = D.reviewLines(item);
    var box = el('div', { class: 'dft-review', 'data-review': item.id, 'data-kind': item.kind }, lines.map(function (ln) {
      return el('p', { class: 'dft-review-line' + (ln.op ? ' is-' + ln.op : ''), text: ln.text });
    }));
    var url = D.safeUrl(item.details && item.details.daftra_url);
    if (url) box.appendChild(el('a', { class: 'btn btn-sm btn-ghost', href: url, target: '_blank', rel: 'noopener noreferrer', text: D.t('open_in_daftra') }));
    var decs = item.status === 'open' || !item.status ? D.decisionsFor(item.kind, can) : [];
    if (decs.length && U) {
      var b = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', 'data-act': 'dft-review-resolve', text: D.t('rv_resolve') });
      b.addEventListener('click', function (e) {
        e.preventDefault();
        U.formModal({
          title: D.t('rv_resolve_title', { kind: D.t('rv_kind_' + item.kind) }), size: 'sm', submitText: D.t('rv_resolve'),
          intro: el('div', null, lines.map(function (ln) { return el('p', { class: 'form-hint', text: ln.text }); })),
          fields: [{ name: 'decision', label: D.t('rv_resolve'), type: 'select', required: true, value: decs[0], options: decs.map(function (x) { return [x, D.t('dec_' + x)]; }) },
            { name: 'note', label: D.t('note'), type: 'textarea', required: true, max: 2000, rows: 3, hint: D.t('rv_note_hint') }],
          submit: function (v) { return D.call(api, 'resolveDaftraReview', item.id, v.decision, U.nn(v.note)); }
        }).then(function (ok) { if (ok) { U.toast(api, D.t('rv_resolved'), 'success'); if (onDone) onDone(); } });
      });
      box.appendChild(b);
    }
    return box;
  }
  function renderReviews(ctx) {
    var D = K(), B = ctx.B, U = B.U, F = B.F, el = B.el, api = ctx.api, body = ctx.body;
    var f = { status: 'open', limit: 50, offset: RV.offset };
    if (RV.kind) f.kind = RV.kind;
    return U.call(api, 'listDaftraReviews', f).then(function (r) {
      if (!ctx.sc.alive()) return;
      U.doneLoading(body);
      if (r.error) { body.appendChild(U.errorState(api, r.error, ctx.reload)); return; }
      var d = F.dataOf(r), items = U.rowsOf(d), counts = d.counts || {};
      body.appendChild(U.toolbar(null, [U.select('kind', D.t('rv_col_kind'), [['', D.t('all')]].concat(D.REVIEW_KINDS.map(function (k) { return [k, D.t('rv_kind_' + k) + (counts[k] ? ' (' + counts[k] + ')' : '')]; })), RV.kind, function (v) { RV.kind = v; RV.offset = 0; ctx.reload(); })],
        [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', ctx.reload, { 'aria-label': D.t('refresh'), title: D.t('refresh') })], D.t('count_n', { n: d.total != null ? d.total : items.length })));
      if (!items.length) { body.appendChild(U.card(D.t('rv_title'), U.emptyState('check', null, D.t('rv_empty')))); return; }
      var trs = items.map(function (it) {
        var can = { write: F.canAt(api, 'finWrite', it.branch_id), approve: F.canAt(api, 'finApprove', it.branch_id) };
        return el('tr', { 'data-id': it.id, 'data-kind': it.kind }, [
          U.td(U.pill(it.kind === 'manual_in_daftra' ? 'warning' : 'danger', D.t('rv_kind_' + it.kind))),
          U.td([B.txLink(it.transaction_id, it.transaction_ref), it.operational_ref ? el('span', { class: 'cell-sub' }, B.ref(it.operational_ref)) : null]),
          U.td(reviewBlock(api, it, can, ctx.reload)),
          U.td(B.when(it.created_at), 'is-nowrap')
        ]);
      });
      body.appendChild(U.card(D.t('rv_title'), U.table([D.t('rv_col_kind'), D.t('rv_col_tx'), D.t('rv_col_details'), D.t('rv_col_when')], trs, { caption: D.t('rv_title') }),
        null, { flush: true, sub: D.t('rv_sub'), cls: 'dft-reviews' }));
      var pg = F.pager(d.total != null ? +d.total : items.length, 50, RV.offset, function (o) { RV.offset = o; ctx.reload(); });
      if (pg) body.appendChild(pg);
    });
  }

  function render(tab, ctx) {
    if (!K()) return Promise.resolve();
    if (tab === 'products') return renderProducts(ctx);
    if (tab === 'fields') return renderFields(ctx);
    if (tab === 'import') return renderImport(ctx);
    if (tab === 'reviews') return renderReviews(ctx);
    return Promise.resolve();
  }

  Ops.dftSettings = { TABS: TABS, connectionCards: connectionCards, render: render, reviewBlock: reviewBlock, isOwner: isOwner,
    _state: { IM: IM, RV: RV } };
})();

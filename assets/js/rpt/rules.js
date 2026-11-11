/* ==========================================================================
   مرسى | MARSA — legacy step 8: follow-up rules  →  #attention_rules (MarsaOps.views.attention_rules)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_REPORTS_AR.md §4 + §11 (get_status_aging_rules / set_status_aging_rules / set_email_otp_login).
   Legacy: الرمز.js transactionAttentionRulesR12119_ (new 24/48 h, active 48/96, complete 24/48, transport 24/48, under
   billing 48/96; an appointment passed and not updated 6/12 h; an overdue empty return is always critical).
   * Every staff member reads the rules in force; the org OWNER (org-wide admin, aal2 session) edits them with a reason
     (owner decision 2026-11-11 (4)); a row equal to its default is not stored (the save replaces all overrides).
   * The e-mail code login switch of the org (OFF by default) — shown with the platform switch of this site
     (MARSA_CONFIG.emailOtpLogin); both must be on for the login page to offer it.
   * A per-device switch for the response-time badge (MarsaShell.responseBadge, OFF by default).
   Strings: 'lrpt'. Data → textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var KEYS = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'appointment_not_updated'];
  var MAX_H = 2160;

  function hours(v) { var s = String(v == null ? '' : v).trim(); if (!/^\d{1,4}$/.test(s)) return null; var n = +s; return n >= 1 && n <= MAX_H ? n : null; }
  // the form rows → the overrides to store (rows equal to the default are left out); {error: key} when a row is invalid
  function overridesFrom(values, defaults) {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], v = values[k] || {}, d = (defaults || {})[k] || {};
      if (v.off) { out[k] = null; continue; }   // a rule switched off is stored as null (the contract): kept off on every save
      var w = hours(v.warning_hours), c = hours(v.critical_hours);
      if (w == null || c == null || w >= c) return { error: k };
      if (w === +d.warning_hours && c === +d.critical_hours) continue;
      out[k] = { warning_hours: w, critical_hours: c };
    }
    return { rules: out };
  }

  function render(root, api) {
    var U = Ops.ui, K = window.MarsaExport && window.MarsaExport.kit && window.MarsaExport.kit();
    if (!U || !K) return;
    K.use(api);
    var lt = K.lt, el = U.el, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'lrpt-rules');
    root.appendChild(U.head(lt('rules_title'), lt('rules_sub')));
    var body = el('div', { class: 'app-stack' });
    root.appendChild(body);
    if (!K.hasFn(api, 'getStatusAgingRules')) { body.appendChild(U.alertBox('warning', K.t('api_missing', { fn: 'getStatusAgingRules' }))); return; }
    function load() {
      U.loadingInto(body);
      return U.call(api, 'getStatusAgingRules').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(r.data || {});
      });
    }
    function errText(e) {
      if (U.errCode(e) === 'MRS_MFA_REQUIRED') return lt('rules_need_mfa');
      return U.errMsg(e, api);
    }
    function draw(d) {
      var rules = d.rules || {}, defs = d.defaults || {}, over = d.overrides || {}, can = !!d.can_edit;
      var inputs = {};
      var trs = KEYS.map(function (k) {
        var has = function (o) { return Object.prototype.hasOwnProperty.call(o, k); };
        var off = (has(over) && over[k] === null) || (has(rules) && rules[k] === null);
        var r = off ? {} : (rules[k] || defs[k] || {}), isOver = !off && !!over[k];
        var label = k === 'appointment_not_updated' ? lt('rule_appointment_not_updated') : K.lab('operational_status', k, api);
        function cell(name) {
          if (!can) return U.td(off ? '—' : U.ltr(K.fmtNum(r[name], 0)), 'num');
          var dv = off ? (defs[k] || {})[name] : r[name];
          var inp = el('input', { class: 'form-control is-sm lrpt-hours', type: 'text', inputmode: 'numeric', maxlength: 4, dir: 'ltr', name: k + '.' + name,
            'aria-label': lt('rules_aria', { s: label, f: lt(name === 'warning_hours' ? 'rules_warning' : 'rules_critical') }), value: dv != null ? String(dv) : '' });
          inp.disabled = off;
          inputs[k] = inputs[k] || {}; inputs[k][name] = inp;
          return U.td(inp, 'num');
        }
        var def = defs[k] || {};
        var wCell = cell('warning_hours'), cCell = cell('critical_hours');
        var pill = off ? U.pill('warning', lt('rules_off')) : isOver ? U.pill('info', lt('rules_override')) : U.pill('neutral', lt('rules_default'));
        var src = [pill];
        if (can) {
          var offBox = el('input', { type: 'checkbox', name: k + '.off', 'aria-label': lt('rules_off_aria', { s: label }) });
          offBox.checked = off;
          offBox.addEventListener('change', function () { inputs[k].warning_hours.disabled = inputs[k].critical_hours.disabled = offBox.checked; });
          inputs[k].off = offBox;
          src.push(el('label', { class: 'ops-inline-check' }, [offBox, el('span', { text: lt('rules_off_toggle') })]));
        }
        return el('tr', { 'data-rule': k }, [U.td(label), wCell, cCell,
          U.td(el('span', { class: 'lrpt-rule-src' }, src)),
          U.td(el('span', { class: 'text-xs text-muted', text: lt('rules_default_val', { w: def.warning_hours != null ? def.warning_hours : '—', c: def.critical_hours != null ? def.critical_hours : '—' }) }))]);
      });
      trs.push(el('tr', { class: 'lrpt-rule-fixed' }, [U.td(lt('rule_empty_return_overdue')), U.td('—', 'num'), U.td(lt('rules_always'), 'num'), U.td(U.pill('danger', lt('rules_fixed'))), U.td('')]));
      var tbl = U.table([lt('rules_status'), { label: lt('rules_warning'), num: true }, { label: lt('rules_critical'), num: true }, lt('rules_source'), lt('rules_default_col')], trs, { caption: lt('rules_title') });
      var kids = [el('p', { class: 'text-sm text-muted', text: lt('rules_explain') }), tbl];
      if (can) {
        var reason = el('textarea', { class: 'form-control', id: 'lrpt-rules-reason', rows: 2, maxlength: 500 });
        var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
        var save = U.btn(lt('rules_save'), 'btn-primary', function () {
          var vals = {};
          KEYS.forEach(function (k) { vals[k] = { warning_hours: inputs[k].warning_hours.value, critical_hours: inputs[k].critical_hours.value, off: !!(inputs[k].off && inputs[k].off.checked) }; });
          var o = overridesFrom(vals, defs);
          var msg = o.error ? lt('rules_bad_row', { s: o.error === 'appointment_not_updated' ? lt('rule_appointment_not_updated') : K.lab('operational_status', o.error, api), max: MAX_H }) : !String(reason.value || '').trim() ? lt('rules_reason_required') : null;
          err.hidden = !msg; err.textContent = msg || '';
          if (msg) return;
          save.disabled = true;
          U.call(api, 'setStatusAgingRules', o.rules, String(reason.value).trim()).then(function (r) {
            save.disabled = false;
            if (r.error) { err.hidden = false; err.textContent = errText(r.error); return; }
            U.toast(api, lt('rules_saved'), 'success');
            U.clear(body); draw(r.data || {});
          });
        });
        var restore = U.btn(lt('rules_restore'), 'btn-ghost', function () {
          KEYS.forEach(function (k) {
            var dd = defs[k] || {};
            inputs[k].warning_hours.value = dd.warning_hours != null ? String(dd.warning_hours) : ''; inputs[k].critical_hours.value = dd.critical_hours != null ? String(dd.critical_hours) : '';
            if (inputs[k].off) inputs[k].off.checked = false;
            inputs[k].warning_hours.disabled = inputs[k].critical_hours.disabled = false;
          });
        });
        kids.push(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'lrpt-rules-reason', text: lt('rules_reason') }), reason]), err, el('div', { class: 'rpt-form-actions' }, [save, restore]));
      } else kids.push(el('p', { class: 'text-xs text-muted', text: lt('rules_owner_only') }));
      body.appendChild(U.card(lt('rules_card'), kids, null, { cls: 'lrpt-rules-card' }));
      body.appendChild(otpCard(d, can));
      body.appendChild(deviceCard());
    }
    function otpCard(d, can) {
      var cfg = window.MARSA_CONFIG || {}, platform = cfg.emailOtpLogin === true, org = d.email_otp_login === true;
      var kids = [
        el('p', { class: 'text-sm', text: lt('otp_explain') }),
        el('ul', { class: 'kv' }, [
          el('li', null, [el('span', { class: 'k', text: lt('otp_platform') }), el('span', { class: 'v' }, U.pill(platform ? 'success' : 'neutral', lt(platform ? 'otp_on' : 'otp_off')))]),
          el('li', null, [el('span', { class: 'k', text: lt('otp_org') }), el('span', { class: 'v' }, U.pill(org ? 'success' : 'neutral', lt(org ? 'otp_on' : 'otp_off')))])
        ]),
        el('p', { class: 'text-xs text-muted', text: lt('otp_mfa_note') })
      ];
      if (can && K.hasFn(api, 'setEmailOtpLogin')) {
        var reason = el('textarea', { class: 'form-control', id: 'lrpt-otp-reason', rows: 2, maxlength: 500 });
        var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
        var b = U.btn(lt(org ? 'otp_turn_off' : 'otp_turn_on'), org ? 'btn-secondary' : 'btn-primary', function () {
          if (!String(reason.value || '').trim()) { err.hidden = false; err.textContent = lt('rules_reason_required'); return; }
          b.disabled = true;
          U.call(api, 'setEmailOtpLogin', !org, String(reason.value).trim()).then(function (r) {
            b.disabled = false;
            if (r.error) { err.hidden = false; err.textContent = errText(r.error); return; }
            U.toast(api, lt(!org ? 'otp_now_on' : 'otp_now_off'), 'success');
            U.clear(body); draw(r.data || {});
          });
        }, { 'data-act': 'otp-toggle' });
        kids.push(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: 'lrpt-otp-reason', text: lt('rules_reason') }), reason]), err, b);
      }
      return U.card(lt('otp_title'), kids, null, { cls: 'lrpt-otp-card' });
    }
    function deviceCard() {
      var SH = window.MarsaShell, box = el('input', { type: 'checkbox', id: 'lrpt-rt-badge' });
      box.checked = !!(SH && typeof SH.responseBadge === 'function' && SH.responseBadge());
      box.disabled = !(SH && typeof SH.responseBadge === 'function');
      box.addEventListener('change', function () { if (SH && SH.responseBadge) SH.responseBadge(!!box.checked); });
      return U.card(lt('device_title'), [el('label', { class: 'ops-inline-check', for: 'lrpt-rt-badge' }, [box, el('span', { text: lt('device_rt_badge') })]),
        el('p', { class: 'text-xs text-muted', text: lt('device_rt_note') })], null, { cls: 'lrpt-device-card' });
    }
    return load();
  }

  Ops.views.attention_rules = {
    allow: 'staff', titleKey: 'lrpt.nav_rules', icon: 'clock',
    render: function (root, api) { return render(root, api); },
    _pure: { KEYS: KEYS, overridesFrom: overridesFrom, hours: hours }
  };
})();

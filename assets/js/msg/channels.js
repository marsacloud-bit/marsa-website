/* ==========================================================================
   مرسى | MARSA — G6b channels & settings: #channels (القنوات والإعدادات)
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md §1 settings, §2 channels, §24 retention / AI cost,
   §25 jobs. Uses MarsaOps.msgKit() (assets/js/msg/kit.js).

   * No password, token or key is ever entered, shown or stored here: a channel row holds
     kind / address / mode / status / capabilities only. A future live credential lives in
     Supabase Vault, read only by the server-side worker (open issue).
   * Every channel is a MOCK channel in G6b (no real mailbox, no real WhatsApp Business
     account); capabilities are «مُثبتة بالمحاكاة فقط». live_pending = not configured.
   * Read: msgRead. Every write: msgAdmin (the server decides).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var CAPS = ['send', 'lookup_send', 'status_events', 'attachments', 'threading', 'templates'];
  var JF = { status: '', kind: '' };

  function render(root, api) {
    var K = Ops.msgKit && Ops.msgKit();
    if (!K) return window.MarsaMsgKit ? window.MarsaMsgKit.noKit(root) : null;
    K.use(api);
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    var admin = K.can(api, 'msgAdmin');
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-channels');
    root.appendChild(U.head(t('channels_title'), t('channels_sub'), [el('a', { class: 'btn btn-sm btn-secondary', href: '#inbox', text: t('nav_inbox') })]));
    root.appendChild(K.note('info', t('no_secret_title'), t('no_secret_text')));
    var chanBox = el('div'), setBox = el('div'), usageBox = el('div'), jobBox = el('div');
    [chanBox, setBox, usageBox, jobBox].forEach(function (n) { root.appendChild(n); });

    /* ---------------- channels ---------------- */
    function loadChannels() {
      U.loadingInto(chanBox);
      return U.call(api, 'listMsgChannels').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(chanBox);
        if (r.error) { chanBox.appendChild(U.errorState(api, r.error, loadChannels)); return; }
        var d = K.dataOf(r), items = K.itemsOf(r);
        if (d.mock !== false || items.some(function (c) { return !c.mode || c.mode === 'mock'; })) chanBox.appendChild(K.mockBanner());
        var acts = admin ? [U.btn([U.icon('plus'), el('span', { text: t('add_channel') })], 'btn-primary msg-add-channel', function () { channelDialog(null); })] : [];
        var content;
        if (!items.length) content = U.emptyState('inbox', t('channels_empty_title'), t('channels_empty_text'), null, true);
        else content = U.table([t('col_kind'), t('col_name'), t('col_address'), t('f_branch'), t('col_mode'), t('col_status'), t('col_flags'), t('col_caps'), t('col_last_poll'), ''],
          items.map(function (c) { return channelRow(c); }), { caption: t('channels_title') });
        chanBox.appendChild(U.card(t('channels_title'), [content, el('p', { class: 'form-hint', text: t('worker_not_deployed') })], acts, { cls: 'msg-channels-card', flush: !!items.length }));
      });
    }
    function channelRow(c) {
      var caps = c.capabilities && typeof c.capabilities === 'object' ? c.capabilities : {};
      var capNodes = CAPS.filter(function (k) { return caps[k]; }).map(function (k) { return U.pill(caps[k].supported ? 'success' : 'danger', t('cap_' + k)); });
      var counts = c.counts || {};
      var acts = [];
      if (admin) {
        acts.push(U.btn(t('edit'), 'btn-ghost msg-edit-channel', function () { channelDialog(c); }));
        acts.push(U.btn(t('probe'), 'btn-secondary msg-probe', function (b) {
          var scope = 'msg-probe-' + c.id, key = U.idemKey(api, scope, { id: c.id, at: c.capabilities_checked_at || null });
          b.disabled = true;
          U.call(api, 'requestMsgChannelProbe', c.id, { idemKey: key }).then(function (r) {
            U.idemSettle(scope, r.error);
            if (!sc.alive()) return;
            b.disabled = false;
            if (r.error) return K.toastErr(api, r);
            U.toast(api, K.dataOf(r).deduplicated ? t('probe_dedup') : t('probe_queued'), 'success');
            loadJobs();
          });
        }));
      }
      return el('tr', { 'data-channel': c.id }, [
        U.td(K.kindIcon(c.kind), 'is-nowrap'),
        U.td([el('span', { class: 'cell-main' }, K.safe(c.name)), counts.threads_open != null ? el('span', { class: 'cell-sub', text: t('open_threads_n', { n: counts.threads_open }) }) : null]),
        U.td(K.addr(c.address || c.address_norm)),
        U.td(K.branchName(api, c.default_branch_id)),
        U.td(K.pill('msg_channel_mode', c.mode || 'mock')),
        U.td([K.pill('msg_channel_status', c.status || 'not_connected'), c.last_error_code ? el('span', { class: 'cell-sub msg-text-danger' }, [K.ref(c.last_error_code), ' ', K.safe(c.last_error_message)]) : null]),
        U.td(el('span', { class: 'msg-flags' }, [U.pill(c.ingest_enabled ? 'success' : 'neutral', t('flag_ingest') + ': ' + (c.ingest_enabled ? t('on') : t('off'))),
          U.pill(c.send_enabled ? 'success' : 'neutral', t('flag_send') + ': ' + (c.send_enabled ? t('on') : t('off'))),
          c.provider_terms_ack_at ? null : U.pill('warning', t('terms_missing'))])),
        U.td(capNodes.length ? [el('span', { class: 'msg-caps' }, capNodes), el('span', { class: 'cell-sub', text: c.capabilities_source === 'live' ? t('caps_live') : t('caps_mock_only') })]
          : el('span', { class: 'ops-muted', text: t('caps_unchecked') })),
        U.td([K.when(c.last_poll_at), c.last_check_at ? el('span', { class: 'cell-sub', text: t('last_check') + ': ' + K.when(c.last_check_at) }) : null], 'is-nowrap'),
        U.td(acts.length ? el('div', { class: 'msg-acts' }, acts) : null)
      ]);
    }
    function channelDialog(c) {
      c = c || {};
      var brOpts = [['', t('org_wide')]].concat(K.branchOptions(api, false));
      U.formModal({
        title: c.id ? t('edit_channel') : t('add_channel'), size: 'lg', intro: t('channel_intro'), warn: t('no_secret_text'),
        fields: [
          { name: 'kind', label: t('col_kind'), type: 'select', required: true, options: K.options('msg_channel_kind'), value: c.kind || 'email' },
          { name: 'name', label: t('col_name'), required: true, max: 120, value: c.name || '' },
          { name: 'address', label: t('col_address'), required: true, max: 254, ltr: true, value: c.address || '', hint: t('address_hint') },
          { name: 'default_branch_id', label: t('default_branch'), type: 'select', options: brOpts, value: c.default_branch_id || '', hint: t('default_branch_hint') },
          { name: 'mode', label: t('col_mode'), type: 'select', options: K.options('msg_channel_mode'), value: c.mode || 'mock', hint: t('mode_hint') },
          { name: 'ingest_enabled', label: t('flag_ingest_long'), type: 'checkbox', value: !!c.ingest_enabled },
          { name: 'send_enabled', label: t('flag_send_long'), type: 'checkbox', value: !!c.send_enabled },
          { name: 'provider_terms_ack', label: t('terms_ack'), type: 'checkbox', value: !!c.provider_terms_ack_at, full: true, hint: t('terms_ack_hint') }
        ],
        validate: function (v) {
          if (v.name.length < 2) return { name: t('too_short') };
          if ((v.ingest_enabled || v.send_enabled) && !v.provider_terms_ack) return { provider_terms_ack: t('terms_required') };
          if (v.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.address)) return { address: t('email_invalid') };
          if (v.kind === 'whatsapp' && !/^[+0٠-٩0-9][0-9٠-٩\s()-]{6,20}$/.test(v.address)) return { address: t('phone_invalid') };
          return null;
        },
        fieldMap: { address_taken: 'address', address: 'address', provider_terms: 'provider_terms_ack' },
        submit: function (v) {
          var p = { kind: v.kind, name: v.name, address: v.address, default_branch_id: v.default_branch_id || null, mode: v.mode,
            ingest_enabled: !!v.ingest_enabled, send_enabled: !!v.send_enabled, provider_terms_ack: !!v.provider_terms_ack };
          if (c.id) p.id = c.id;
          var scope = 'msg-channel-' + (c.id || 'new'), key = U.idemKey(api, scope, p);
          return U.call(api, 'saveMsgChannel', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      }).then(K.done(api, sc, t('channel_saved'), loadChannels));
    }

    /* ---------------- settings + retention ---------------- */
    function loadSettings() {
      U.loadingInto(setBox);
      return U.call(api, 'getMsgSettings').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(setBox);
        if (r.error) { setBox.appendChild(U.errorState(api, r.error, loadSettings)); return; }
        var d = K.dataOf(r), s = d.settings || d;
        var acts = admin ? [U.btn(t('edit_settings'), 'btn-secondary msg-edit-settings', function () { settingsDialog(s); })] : [];
        var ret = el('div', { class: 'msg-retention' });
        if (admin) ret.appendChild(U.btn(t('retention_preview'), 'btn-ghost msg-ret-preview', function (b) {
          b.disabled = true;
          U.call(api, 'msgRetentionPreview').then(function (r2) {
            if (!sc.alive()) return;
            b.disabled = false;
            U.clear(out);
            if (r2.error) { out.appendChild(U.errorState(api, r2.error)); return; }
            var p = K.dataOf(r2);
            out.appendChild(K.dl([[t('older_than'), K.day(p.older_than)], [t('ret_messages'), String(p.messages != null ? p.messages : 0)],
              [t('ret_attachments'), String(p.attachments != null ? p.attachments : 0)], [t('ret_threads'), String(p.threads != null ? p.threads : 0)]]));
            out.appendChild(el('p', { class: 'form-hint', text: t('no_purge') }));
          });
        }));
        var out = el('div', { class: 'msg-ret-out', 'aria-live': 'polite' });
        ret.appendChild(out);
        setBox.appendChild(U.card(t('settings_title'), [
          d.exists === false ? el('p', { class: 'form-hint', text: t('settings_defaults') }) : null,
          K.dl([
            [t('ai_provider'), el('span', null, [U.pill(s.ai_provider === 'llm_pending' ? 'neutral' : 'success', t('ai_' + (s.ai_provider || 'rule_mock')))])],
            [t('ai_budget'), String(s.ai_monthly_budget_usd != null ? s.ai_monthly_budget_usd : 0) + ' USD'],
            [t('auto_link'), s.auto_link_enabled === false ? t('off') : t('on')],
            [t('four_eyes'), t('four_eyes_always')],
            [t('retention_days'), t('days_n', { n: s.retention_days != null ? s.retention_days : 730 })],
            [t('purge'), t('purge_disabled')],
            [t('violation_repeat_days'), t('days_n', { n: s.violation_repeat_days != null ? s.violation_repeat_days : 30 })],
            [t('default_lang'), t('lang_' + (s.default_lang || 'ar'))],
            [t('signature_ar'), s.signature_ar ? K.safe(s.signature_ar) : null],
            [t('signature_en'), s.signature_en ? K.safe(s.signature_en) : null]
          ]),
          el('p', { class: 'form-hint', text: t('ai_rule_note') }),
          ret
        ], acts, { cls: 'msg-settings-card' }));
      });
    }
    function settingsDialog(s) {
      U.formModal({
        title: t('edit_settings'), size: 'lg',
        fields: [
          { name: 'ai_provider', label: t('ai_provider'), type: 'select', options: [['rule_mock', t('ai_rule_mock')], ['llm_pending', t('ai_llm_pending')]], value: s.ai_provider || 'rule_mock', hint: t('ai_provider_hint') },
          { name: 'ai_monthly_budget_usd', label: t('ai_budget'), type: 'number', minNum: 0, maxNum: 99999999, step: '0.01', value: s.ai_monthly_budget_usd != null ? s.ai_monthly_budget_usd : 0, ltr: true },
          { name: 'auto_link_enabled', label: t('auto_link_long'), type: 'checkbox', value: s.auto_link_enabled !== false },
          { name: 'retention_days', label: t('retention_days'), type: 'number', minNum: 90, maxNum: 3650, required: true, value: s.retention_days != null ? s.retention_days : 730, ltr: true },
          { name: 'violation_repeat_days', label: t('violation_repeat_days'), type: 'number', minNum: 1, maxNum: 365, required: true, value: s.violation_repeat_days != null ? s.violation_repeat_days : 30, ltr: true },
          { name: 'default_lang', label: t('default_lang'), type: 'select', options: [['ar', t('lang_ar')], ['en', t('lang_en')]], value: s.default_lang || 'ar' },
          { name: 'signature_ar', label: t('signature_ar'), type: 'textarea', max: 500, value: s.signature_ar || '' },
          { name: 'signature_en', label: t('signature_en'), type: 'textarea', max: 500, value: s.signature_en || '' }
        ],
        submit: function (v) {
          return U.call(api, 'saveMsgSettings', { ai_provider: v.ai_provider, ai_monthly_budget_usd: +v.ai_monthly_budget_usd || 0, auto_link_enabled: !!v.auto_link_enabled,
            retention_days: +v.retention_days, violation_repeat_days: +v.violation_repeat_days, default_lang: v.default_lang, signature_ar: v.signature_ar || null, signature_en: v.signature_en || null });
        }
      }).then(K.done(api, sc, t('settings_saved'), loadSettings));
    }

    /* ---------------- AI usage (msgAdmin) ---------------- */
    function loadUsage() {
      U.clear(usageBox);
      if (!admin) return null;
      U.loadingInto(usageBox);
      return U.call(api, 'msgAiUsage', {}).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(usageBox);
        if (r.error) { usageBox.appendChild(U.errorState(api, r.error)); return; }
        var d = K.dataOf(r), by = d.by_provider || {};
        var rows = Object.keys(by).map(function (p) {
          var x = by[p] || {};
          return el('tr', { 'data-provider': p }, [U.td(t('ai_' + p)), U.td(String(x.runs || 0), 'num'), U.td(String(x.input_chars || 0), 'num'), U.td(String(x.est_tokens || 0), 'num'), U.td(String(x.est_cost_usd || 0), 'num')]);
        });
        usageBox.appendChild(U.card(t('ai_usage_title'), [
          K.dl([[t('ai_runs'), String(d.runs || 0)], [t('ai_budget'), String(d.budget_usd != null ? d.budget_usd : 0) + ' USD'], [t('ai_mtd'), String(d.month_to_date_usd != null ? d.month_to_date_usd : 0) + ' USD']]),
          rows.length ? U.table([t('ai_provider'), t('ai_runs'), t('ai_input_chars'), t('ai_tokens'), t('ai_cost')], rows, { caption: t('ai_usage_title') }) : el('p', { class: 'ops-muted msg-none', text: t('ai_no_runs') }),
          el('p', { class: 'form-hint', text: t('ai_cost_note') })
        ], null, { cls: 'msg-usage-card' }));
      });
    }

    /* ---------------- jobs ---------------- */
    function loadJobs() {
      U.loadingInto(jobBox);
      var f = { limit: 50, offset: 0 };
      if (JF.status) f.status = JF.status;
      if (JF.kind) f.kind = JF.kind;
      return U.call(api, 'listMsgJobs', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(jobBox);
        var filters = [U.select('status', t('col_status'), K.options('msg_job_status', true, t('all_statuses')), JF.status, function (v) { JF.status = v; loadJobs(); }),
          U.select('kind', t('col_kind'), K.options('msg_job_kind', true, t('all_kinds')), JF.kind, function (v) { JF.kind = v; loadJobs(); })];
        var content;
        if (r.error) content = U.errorState(api, r.error, loadJobs);
        else {
          var items = K.itemsOf(r);
          content = !items.length ? el('p', { class: 'ops-muted msg-none', text: t('no_jobs') }) : U.table([t('col_kind'), t('col_status'), t('col_attempts'), t('col_target'), t('last_error'), t('col_created'), ''], items.map(function (j) {
            var retry = j.kind !== 'send' && (j.status === 'failed' || j.status === 'dead') && (j.channel_id && !j.thread_id ? admin : K.can(api, 'msgTriage'))
              ? U.btn(t('retry'), 'btn-ghost msg-retry-job', function (b) {
                b.disabled = true;
                U.call(api, 'retryMsgJob', j.id).then(function (r2) { if (!sc.alive()) return; b.disabled = false; if (r2.error) return K.toastErr(api, r2); U.toast(api, t('retry_queued'), 'success'); loadJobs(); });
              }) : null;
            return el('tr', { 'data-job': j.id, class: 'msg-job-' + j.status }, [
              U.td(K.lab('msg_job_kind', j.kind)), U.td([K.pill('msg_job_status', j.status), j.status === 'queued' ? el('span', { class: 'cell-sub', text: t('queued_no_worker') }) : null]),
              U.td(String(j.attempts || 0) + ' / ' + String(j.max_attempts || 5), 'num'),
              U.td(j.thread_id ? el('a', { class: 'ops-ref', href: '#inbox/' + j.thread_id, text: t('open_thread') }) : K.safe(j.channel_name || t('target_channel'))),
              U.td(j.last_error_code || j.last_error_message ? el('span', { class: 'msg-text-danger' }, [K.ref(j.last_error_code), ' ', K.safe(j.last_error_message)]) : null),
              U.td(K.when(j.created_at), 'is-nowrap'), U.td(retry)
            ]);
          }), { caption: t('jobs_title') });
        }
        jobBox.appendChild(U.card(t('jobs_title'), [U.toolbar(null, filters, null, null), content, el('p', { class: 'form-hint', text: t('send_retry_note') })], null, { cls: 'msg-jobs-card' }));
      });
    }

    return Promise.all([loadChannels(), loadSettings(), loadUsage(), loadJobs()]);
  }

  Ops.views.channels = { allow: 'msgRead', titleKey: 'msg.nav_channels', render: render };
})();

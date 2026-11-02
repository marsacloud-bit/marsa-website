/* ==========================================================================
   مرسى | MARSA — G6b agent templates, instruction library and auto-reply policies:
   #templates (القوالب) · #templates/instructions (مكتبة التعليمات) · #templates/auto (الردود الآلية)
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md §16 instructions + approval levels, §22 templates,
   §23 auto-reply policies (disabled in v1). Uses MarsaOps.msgKit() (assets/js/msg/kit.js).

   * Templates and instructions are versioned: saving makes a new «مسودة»; a msgApprove user
     other than the author approves (the previous approved version retires) or retires it.
   * Placeholders are plain-text {{name}} substitutions from the fixed list — no markup and no
     expression language. The preview fills them with SAMPLE data only (never real records).
   * Instruction bodies are human-readable rules shown to staff and never executed; only the
     typed params reach drafts.
   * Auto-replies: «الردود الآلية غير مفعلة في الإصدار الأول» — the view can save conditions
     only; enabled is always false (the server refuses true).
   * Read: msgRead. Save: msgLib. Review: msgApprove ≠ author. Seed / auto-reply: msgAdmin.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var TABS = ['templates', 'instructions', 'auto'];
  var SAMPLE = {
    ar: { tx_ref: 'MRS-2026-000123', bl_number: 'MEDU1234567', declaration_no: '1234567890', container_list: 'MSCU1234565، TGHU7654321', client_name: 'شركة العميل التجريبية',
      counterpart_name: 'الوكيل الملاحي (مثال)', operation_label: 'استيراد', appointment_at: '2026-11-05 09:00', terminal_name: 'محطة الحاويات (مثال)',
      return_deadline_list: 'MSCU1234565: 2026-11-10', missing_documents_list: 'شهادة المنشأ، قائمة التعبئة', org_name: 'مرسى', signature: 'فريق العمليات', today: '2026-11-02' },
    en: { tx_ref: 'MRS-2026-000123', bl_number: 'MEDU1234567', declaration_no: '1234567890', container_list: 'MSCU1234565, TGHU7654321', client_name: 'Sample Client Co.',
      counterpart_name: 'Shipping agent (sample)', operation_label: 'Import', appointment_at: '2026-11-05 09:00', terminal_name: 'Container terminal (sample)',
      return_deadline_list: 'MSCU1234565: 2026-11-10', missing_documents_list: 'Certificate of origin, packing list', org_name: 'MARSA', signature: 'Operations team', today: '2026-11-02' }
  };
  function fill(tpl, lang) {
    var s = SAMPLE[lang === 'en' ? 'en' : 'ar'];
    return String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : m; });
  }
  function unknownPlaceholders(K, tpl) {
    var bad = [];
    String(tpl || '').replace(/\{\{\s*([^}]*?)\s*\}\}/g, function (m, k) { if (K.PLACEHOLDERS.indexOf(k) === -1 && bad.indexOf(k) === -1) bad.push(k); return m; });
    return bad;
  }
  function usedPlaceholders(K, a, b) {
    var used = [];
    (String(a || '') + ' ' + String(b || '')).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, function (m, k) { if (K.PLACEHOLDERS.indexOf(k) !== -1 && used.indexOf(k) === -1) used.push(k); return m; });
    return used;
  }

  function render(root, api, param) {
    var K = Ops.msgKit && Ops.msgKit();
    if (!K) return window.MarsaMsgKit ? window.MarsaMsgKit.noKit(root) : null;
    K.use(api);
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    var tab = TABS.indexOf(param) !== -1 ? param : 'templates';
    var lib = K.can(api, 'msgLib'), approver = K.can(api, 'msgApprove'), admin = K.can(api, 'msgAdmin');
    var me = api && api.userId;
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-library', 'msg-tab-' + tab);
    root.appendChild(U.head(t('library_title'), t('library_sub'), [el('a', { class: 'btn btn-sm btn-secondary', href: '#inbox', text: t('nav_inbox') })]));
    root.appendChild(K.tabs([['templates', t('tab_templates')], ['instructions', t('tab_instructions')], ['auto', t('tab_auto')]], tab, function (v) {
      U.go(api, v === 'templates' ? '#templates' : '#templates/' + v);
    }, t('library_title')));
    var body = el('div');
    root.appendChild(body);

    function reviewBtns(row, fn, reload) {
      var out = [];
      if (!approver || row.status === 'retired') return out;
      var own = !!(me && row.author_id === me);
      if (row.status === 'draft') out.push(U.btn(t('approve'), 'btn-secondary msg-lib-approve', function () { review(row, 'approve', fn, reload); }, { disabled: own, title: own ? t('not_own_review') : null }));
      out.push(U.btn(t('retire'), 'btn-ghost msg-lib-retire', function () { review(row, 'retire', fn, reload); }, { disabled: own, title: own ? t('not_own_review') : null }));
      return out;
    }
    function review(row, decision, fn, reload) {
      U.formModal({
        title: decision === 'approve' ? t('lib_approve_title') : t('lib_retire_title'), size: 'sm', danger: decision === 'retire',
        submitText: decision === 'approve' ? t('approve') : t('retire'), intro: decision === 'approve' ? t('lib_approve_intro') : null,
        fields: [{ name: 'note', label: t('note'), type: 'textarea', max: 2000, required: decision === 'retire' }],
        submit: function (v) { return U.call(api, fn, row.id, decision, v.note || null); }
      }).then(K.done(api, sc, t('review_saved'), reload));
    }

    /* ---------------- templates ---------------- */
    function loadTemplates() {
      U.loadingInto(body);
      return U.call(api, 'listMsgTemplates', {}).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, loadTemplates)); return; }
        var items = K.itemsOf(r);
        var acts = [];
        if (lib) acts.push(U.btn([U.icon('plus'), el('span', { text: t('new_template') })], 'btn-primary msg-new-template', function () { templateDialog(null); }));
        if (admin) acts.push(U.btn(t('seed_templates'), 'btn-secondary msg-seed', function (b) {
          b.disabled = true;
          U.call(api, 'seedMsgTemplates').then(function (r2) {
            if (!sc.alive()) return;
            b.disabled = false;
            if (r2.error) return K.toastErr(api, r2);
            U.toast(api, t('seeded_n', { n: K.dataOf(r2).inserted != null ? K.dataOf(r2).inserted : 0 }), 'success'); loadTemplates();
          });
        }));
        body.appendChild(K.note('info', null, t('templates_note')));
        // key × language: the approved version (if any) + the newest draft
        var groups = {};
        items.forEach(function (x) { var g = (x.template_key || '') + '|' + (x.lang || 'ar'); (groups[g] = groups[g] || []).push(x); });
        var rows = [];
        K.CODES.msg_template_key.forEach(function (k) {
          ['ar', 'en'].forEach(function (lg) {
            var g = (groups[k + '|' + lg] || []).slice().sort(function (a, b) { return (+b.version || 0) - (+a.version || 0); });
            rows.push(templateRow(k, lg, g));
          });
        });
        body.appendChild(U.card(t('tab_templates'), [U.table([t('template'), t('language'), t('col_status'), t('version'), t('party_kinds'), t('operation'), t('placeholders_used'), ''], rows, { caption: t('tab_templates') }),
          !items.length ? el('p', { class: 'form-hint', text: t('templates_empty') }) : null], acts, { cls: 'msg-templates-card', flush: true }));
      });
    }
    function templateRow(key, lg, versions) {
      var appr = versions.filter(function (x) { return x.status === 'approved'; })[0] || null;
      var draft = versions.filter(function (x) { return x.status === 'draft'; })[0] || null;
      var show = draft || appr || versions[0] || null;
      var acts = [];
      if (show) acts.push(U.btn(t('view'), 'btn-ghost msg-tpl-view', function () { templateView(show); }));
      if (lib) acts.push(U.btn(show ? t('new_version') : t('create'), 'btn-secondary msg-tpl-edit', function () { templateDialog(show || { template_key: key, lang: lg }); }));
      if (draft) acts = acts.concat(reviewBtns(draft, 'reviewMsgTemplate', loadTemplates));
      return el('tr', { 'data-template': key + '-' + lg, class: key === 'ack_receipt' ? 'msg-row-inactive' : null }, [
        U.td([el('span', { class: 'cell-main', text: K.lab('msg_template_key', key) }), key === 'ack_receipt' ? el('span', { class: 'cell-sub', text: t('ack_reserved') }) : null]),
        U.td(t('lang_' + lg)),
        U.td([appr ? K.pill('msg_lib_status', 'approved') : el('span', { class: 'badge badge-warning', text: t('builtin_only') }), draft ? K.pill('msg_lib_status', 'draft') : null]),
        U.td(show ? [appr ? 'v' + appr.version : U.NONE, draft ? ' · ' + t('draft_v', { n: draft.version }) : ''] : U.NONE),
        U.td(show ? el('span', { class: 'msg-kinds' }, K.list(show.party_kinds).map(function (p) { return U.pill('neutral', p === 'client' ? t('entity_client') : U.lab('party_kind', p)); })) : null),
        U.td(show && show.operation ? K.lab('msg_operation', show.operation) : null),
        U.td(show ? el('span', { class: 'text-xs' }, K.list(show.placeholders).length ? K.list(show.placeholders).map(function (p) { return '{{' + p + '}}'; }).join(' ') : U.NONE) : null),
        U.td(acts.length ? el('div', { class: 'msg-acts' }, acts) : null)
      ]);
    }
    function templateView(x) {
      U.formModal({
        title: K.lab('msg_template_key', x.template_key) + ' — ' + t('lang_' + (x.lang || 'ar')) + ' · v' + (x.version || 1), size: 'lg', submitText: t('close'),
        intro: el('div', { class: 'msg-tpl-preview' }, [
          K.dl([[t('col_status'), K.pill('msg_lib_status', x.status)], [t('author'), x.author_name ? K.safe(x.author_name) : null], [t('reviewed'), x.reviewed_at ? K.when(x.reviewed_at) : null],
            [t('note'), x.review_note ? K.safe(x.review_note) : null]]),
          el('h4', { class: 'msg-sub-title', text: t('tpl_source') }),
          el('pre', { class: 'msg-body msg-tpl-src', dir: 'auto', text: (x.subject_tpl ? x.subject_tpl + '\n\n' : '') + (x.body_tpl || '') }),
          el('h4', { class: 'msg-sub-title', text: t('preview_sample') }),
          el('pre', { class: 'msg-body msg-tpl-filled', dir: 'auto', text: fill((x.subject_tpl ? x.subject_tpl + '\n\n' : '') + (x.body_tpl || ''), x.lang) })
        ]),
        fields: [], submit: function () { return Promise.resolve({ data: true, error: null }); }
      });
    }
    function templateDialog(x) {
      x = x || {};
      var p = U.formModal({
        title: x.id ? t('new_version_of', { key: K.lab('msg_template_key', x.template_key) }) : t('new_template'), size: 'lg', intro: t('template_intro'),
        fields: [
          { name: 'template_key', label: t('template'), type: 'select', required: true, options: K.options('msg_template_key'), value: x.template_key || 'clarification' },
          { name: 'lang', label: t('language'), type: 'select', options: [['ar', t('lang_ar')], ['en', t('lang_en')]], value: x.lang || 'ar' },
          { name: 'category', label: t('col_category'), type: 'select', options: [['', U.NONE]].concat(K.options('msg_category')), value: x.category || '' },
          { name: 'operation', label: t('operation'), type: 'select', options: K.options('msg_operation'), value: x.operation || 'any' },
          { name: 'party_kinds', label: t('party_kinds'), type: 'checks', full: true, options: [['client', t('entity_client')]].concat(K.PARTY_KINDS.map(function (k) { return [k, U.lab('party_kind', k)]; })), value: K.list(x.party_kinds) },
          { name: 'subject_tpl', label: t('subject_tpl'), max: 300, full: true, value: x.subject_tpl || '' },
          { name: 'body_tpl', label: t('body_tpl'), type: 'textarea', rows: 10, max: 5000, required: true, value: x.body_tpl || '' }
        ],
        validate: function (v) {
          var b1 = unknownPlaceholders(K, v.subject_tpl), b2 = unknownPlaceholders(K, v.body_tpl);
          if (b1.length) return { subject_tpl: t('placeholder_unknown', { names: b1.join(', ') }) };
          if (b2.length) return { body_tpl: t('placeholder_unknown', { names: b2.join(', ') }) };
          return null;
        },
        submit: function (v) {
          var pl = { template_key: v.template_key, lang: v.lang, category: v.category || null, operation: v.operation, party_kinds: v.party_kinds,
            subject_tpl: v.subject_tpl || null, body_tpl: v.body_tpl, placeholders: usedPlaceholders(K, v.subject_tpl, v.body_tpl) };
          if (x.id) pl.supersedes_id = x.id;
          var scope = 'msg-tpl-' + v.template_key + '-' + v.lang, key = U.idemKey(api, scope, pl);
          return U.call(api, 'saveMsgTemplate', pl, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      });
      // placeholder insert buttons + live sample preview, added inside the open form
      var boxes = document.querySelectorAll('.ops-modal');
      var box = boxes[boxes.length - 1];
      var form = box && box.querySelector('form');
      if (form) {
        var ta = form.querySelector('[name="body_tpl"]'), subj = form.querySelector('[name="subject_tpl"]'), lg = form.querySelector('[name="lang"]');
        var prev = el('pre', { class: 'msg-body msg-tpl-filled', dir: 'auto' });
        var upd = function () { prev.textContent = fill((subj.value ? subj.value + '\n\n' : '') + ta.value, lg.value); };
        var ins = el('div', { class: 'msg-ph-bar', role: 'group', 'aria-label': t('placeholders') }, [el('span', { class: 'text-xs text-muted', text: t('placeholders') + ':' })].concat(K.PLACEHOLDERS.map(function (ph) {
          return U.btn('{{' + ph + '}}', 'btn-ghost msg-ph', function () {
            var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length, e = ta.selectionEnd != null ? ta.selectionEnd : s;
            ta.value = ta.value.slice(0, s) + '{{' + ph + '}}' + ta.value.slice(e);
            try { ta.focus(); ta.selectionStart = ta.selectionEnd = s + ph.length + 4; } catch (er) { /* ignore */ }
            upd();
          }, { title: t('ph_' + ph), 'data-ph': ph });
        })));
        form.appendChild(ins);
        form.appendChild(el('h4', { class: 'msg-sub-title', text: t('preview_sample') }));
        form.appendChild(prev);
        [ta, subj].forEach(function (n) { n.addEventListener('input', upd); });
        lg.addEventListener('change', upd);
        upd();
      }
      p.then(K.done(api, sc, t('template_saved'), loadTemplates));
    }

    /* ---------------- instructions ---------------- */
    function loadInstructions() {
      U.loadingInto(body);
      return U.call(api, 'listMsgInstructions', {}).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, loadInstructions)); return; }
        var items = K.itemsOf(r);
        body.appendChild(K.note('info', null, t('instructions_note')));
        var acts = lib ? [U.btn([U.icon('plus'), el('span', { text: t('new_instruction') })], 'btn-primary msg-new-instruction', function () { instructionDialog(null); })] : [];
        var content = !items.length ? el('p', { class: 'ops-muted msg-none', text: t('no_instructions') }) : U.table([t('instruction_key'), t('col_kind'), t('scope'), t('language'), t('version'), t('col_status'), t('params'), ''],
          items.slice().sort(function (a, b) { return String(a.instruction_key).localeCompare(String(b.instruction_key)) || (+b.version || 0) - (+a.version || 0); }).map(function (x) {
            var acts2 = reviewBtns(x, 'reviewMsgInstruction', loadInstructions);
            if (lib && x.status !== 'retired') acts2.unshift(U.btn(t('new_version'), 'btn-ghost msg-ins-edit', function () { instructionDialog(x); }));
            return el('tr', { 'data-instruction': x.id, class: x.status === 'retired' ? 'msg-row-inactive' : null }, [
              U.td([K.ref(x.instruction_key), x.body ? el('span', { class: 'cell-sub msg-ins-body', dir: 'auto', text: K.preview(x.body, 200) }) : null]),
              U.td(K.lab('msg_instruction_kind', x.kind)),
              U.td([K.lab('msg_instruction_scope', x.scope || 'all'), x.scope_value ? el('span', { class: 'cell-sub' }, K.safe(x.scope_value)) : null]),
              U.td(x.lang === 'any' ? t('lang_any') : t('lang_' + (x.lang || 'ar'))),
              U.td('v' + (x.version || 1)), U.td(K.pill('msg_lib_status', x.status)),
              U.td(paramsNode(x)), U.td(acts2.length ? el('div', { class: 'msg-acts' }, acts2) : null)
            ]);
          }), { caption: t('tab_instructions') });
        body.appendChild(U.card(t('tab_instructions'), content, acts, { cls: 'msg-instructions-card', flush: !!items.length }));
        body.appendChild(levelsCard(items));
      });
    }
    function paramsNode(x) {
      var p = x.params && typeof x.params === 'object' ? x.params : {};
      var keys = Object.keys(p);
      if (!keys.length) return el('span', { class: 'ops-muted', text: U.NONE });
      return el('ul', { class: 'msg-params text-xs' }, keys.slice(0, 8).map(function (k) {
        var v = p[k];
        var s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v);
        return el('li', null, [el('span', { class: 'text-muted', text: K.tOr('param_' + k, k) + ': ' }), K.safe(K.preview(s, 120))]);
      }));
    }
    function levelsCard(items) {
      var rows = K.CODES.msg_category.map(function (c) {
        var lv = K.levelOf(c, items);
        var fromIns = K.list(items).some(function (i) { return i.kind === 'approval_level' && i.status === 'approved' && i.params && i.params.category === c; });
        return el('tr', { 'data-category': c }, [U.td(K.pill('msg_category', c)), U.td(K.pill('msg_approval_level', lv)),
          U.td(K.LEVEL_ROLES[lv].map(function (r) { return K.lab('role', r, api); }).join('، ')), U.td(fromIns ? t('level_from_instruction') : t('level_default'))]);
      });
      return U.card(t('levels_title'), U.table([t('col_category'), t('approval_level'), t('level_roles'), t('col_source')], rows, { caption: t('levels_title') }), null, { cls: 'msg-levels-card', flush: true, sub: t('levels_sub') });
    }
    function instructionDialog(x) {
      x = x || {};
      var p = x.params || {};
      var kind = x.kind || 'style';
      // step 1: kind (a new instruction) → step 2: typed params for that kind
      if (!x.id && !x.__kindChosen) {
        U.formModal({
          title: t('new_instruction'), size: 'sm',
          fields: [{ name: 'kind', label: t('col_kind'), type: 'select', options: K.options('msg_instruction_kind'), value: 'style' }],
          submitText: t('next'), submit: function (v) { return Promise.resolve({ data: { kind: v.kind }, error: null }); }
        }).then(function (res) { if (res && res.kind && sc.alive()) instructionDialog({ kind: res.kind, __kindChosen: true }); });
        return;
      }
      var cats = [['', U.NONE]].concat(K.options('msg_category'));
      var typed = {
        style: [{ name: 'formality', label: t('param_formality'), type: 'select', options: [['formal', t('formal')], ['neutral', t('neutral')]], value: p.formality || 'formal' },
          { name: 'greeting', label: t('param_greeting'), max: 200, value: p.greeting || '' }, { name: 'closing', label: t('param_closing'), max: 200, value: p.closing || '' }],
        language: [{ name: 'default', label: t('param_default'), type: 'select', options: [['ar', t('lang_ar')], ['en', t('lang_en')]], value: p['default'] || 'ar' },
          { name: 'mirror_sender', label: t('param_mirror_sender'), type: 'checkbox', value: !!p.mirror_sender }],
        party_rule: [{ name: 'party_kind', label: t('param_party_kind'), type: 'select', options: K.PARTY_KINDS.map(function (k) { return [k, U.lab('party_kind', k)]; }), value: p.party_kind || 'shipping_agent' },
          { name: 'cc_internal', label: t('param_cc_internal'), ltr: true, max: 400, value: K.list(p.cc_internal).join(', '), hint: t('cc_internal_hint') },
          { name: 'never_discuss', label: t('param_never_discuss'), type: 'checks', full: true, options: K.options('msg_category').filter(function (o) { return o[0] !== 'unknown'; }), value: K.list(p.never_discuss) }],
        topic_rule: [{ name: 'category', label: t('col_category'), type: 'select', required: true, options: cats, value: p.category || '' },
          { name: 'owner_role', label: t('param_owner_role'), type: 'select', options: K.ROLES.msgTriage.map(function (r) { return [r, K.lab('role', r, api)]; }), value: p.owner_role || 'clearance_staff' },
          { name: 'max_response_hours', label: t('param_max_response_hours'), type: 'number', minNum: 1, maxNum: 720, value: p.max_response_hours != null ? p.max_response_hours : 24, ltr: true }],
        approval_level: [{ name: 'category', label: t('col_category'), type: 'select', required: true, options: cats, value: p.category || '' },
          { name: 'level', label: t('approval_level'), type: 'select', options: K.options('msg_approval_level'), value: p.level || 'standard' }],
        signature: [{ name: 'text_ar', label: t('signature_ar'), type: 'textarea', max: 500, value: p.text_ar || '' }, { name: 'text_en', label: t('signature_en'), type: 'textarea', max: 500, value: p.text_en || '' }]
      };
      var base = [
        { name: 'instruction_key', label: t('instruction_key'), required: true, max: 60, ltr: true, value: x.instruction_key || '', pattern: /^[a-z0-9_.-]{1,60}$/, patternMsg: t('key_pattern'), hint: x.id ? t('key_fixed') : t('key_hint') },
        { name: 'scope', label: t('scope'), type: 'select', options: K.options('msg_instruction_scope'), value: x.scope || 'all' },
        { name: 'scope_value', label: t('scope_value'), max: 80, value: x.scope_value || '', hint: t('scope_value_hint') },
        { name: 'lang', label: t('language'), type: 'select', options: [['any', t('lang_any')], ['ar', t('lang_ar')], ['en', t('lang_en')]], value: x.lang || 'any' },
        { name: 'body', label: t('instruction_body'), type: 'textarea', max: 2000, value: x.body || '', hint: t('instruction_body_hint') }
      ];
      U.formModal({
        title: (x.id ? t('new_version') + ' — ' : '') + K.lab('msg_instruction_kind', kind), size: 'lg', intro: t('instruction_intro'),
        fields: base.concat(typed[kind] || []),
        submit: function (v) {
          var params = {};
          (typed[kind] || []).forEach(function (f) {
            var val = v[f.name];
            if (f.type === 'number') val = val === '' ? null : +val;
            if (f.name === 'cc_internal') val = String(val || '').split(/[,\s]+/).filter(function (s) { return /^[0-9a-f-]{36}$/i.test(s); });
            params[f.name] = val;
          });
          var pl = { instruction_key: x.id ? x.instruction_key : v.instruction_key, kind: kind, scope: v.scope, scope_value: v.scope_value || null, lang: v.lang, body: v.body || null, params: params };
          if (x.id) pl.supersedes_id = x.id;
          var scope = 'msg-ins-' + pl.instruction_key, key = U.idemKey(api, scope, pl);
          return U.call(api, 'saveMsgInstruction', pl, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      }).then(K.done(api, sc, t('instruction_saved'), loadInstructions));
    }

    /* ---------------- auto-replies (disabled in v1) ---------------- */
    function loadAuto() {
      U.loadingInto(body);
      return U.call(api, 'listMsgAutoReplyPolicies').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        body.appendChild(el('div', { class: 'alert alert-warning msg-auto-off', role: 'note', 'data-msg-banner': 'auto-off' }, [U.icon('alert'),
          el('div', null, [el('strong', { text: t('auto_disabled_title') }), el('span', { text: ' ' + t('auto_disabled_text') })])]));
        body.appendChild(U.card(t('auto_limits_title'), el('ul', { class: 'msg-limits' }, ['auto_limit_1', 'auto_limit_2', 'auto_limit_3', 'auto_limit_4'].map(function (k) { return el('li', { text: t(k) }); })), null, { cls: 'msg-limits-card' }));
        if (r.error) { body.appendChild(U.errorState(api, r.error, loadAuto)); return; }
        var items = K.itemsOf(r), by = {};
        items.forEach(function (x) { by[x.kind] = x; });
        var rows = K.CODES.msg_auto_reply_kind.map(function (k) {
          var x = by[k] || { kind: k };
          var c = x.conditions || {};
          return el('tr', { 'data-policy': k }, [
            U.td(K.lab('msg_auto_reply_kind', k)), U.td(U.pill('neutral', t('auto_not_enabled'))),
            U.td(el('span', { class: 'msg-kinds' }, K.list(x.allowed_categories).map(function (cc) { return K.pill('msg_category', cc); }))),
            U.td(x.template_key ? K.lab('msg_template_key', x.template_key) : null),
            U.td([c.verified_sender_only !== false ? el('span', { class: 'cell-sub', text: t('cond_verified_sender_only') }) : null, c.business_hours_only !== false ? el('span', { class: 'cell-sub', text: t('cond_business_hours_only') }) : null]),
            U.td(x.note ? K.safe(x.note) : null),
            U.td(admin ? U.btn(t('edit_conditions'), 'btn-ghost msg-auto-edit', function () { autoDialog(x); }) : null)
          ]);
        });
        body.appendChild(U.card(t('tab_auto'), U.table([t('col_kind'), t('col_status'), t('allowed_categories'), t('template'), t('conditions'), t('note'), ''], rows, { caption: t('tab_auto') }), null, { cls: 'msg-auto-card', flush: true }));
      });
    }
    function autoDialog(x) {
      var c = x.conditions || {};
      U.formModal({
        title: t('edit_conditions') + ' — ' + K.lab('msg_auto_reply_kind', x.kind), size: 'lg', warn: t('auto_disabled_text'),
        fields: [
          { name: 'allowed_categories', label: t('allowed_categories'), type: 'checks', full: true, value: K.list(x.allowed_categories),
            options: K.options('msg_category').filter(function (o) { return ['freight_charges', 'violation', 'unknown'].indexOf(o[0]) === -1; }) },
          { name: 'template_key', label: t('template'), type: 'select', options: [['', U.NONE], ['ack_receipt', K.lab('msg_template_key', 'ack_receipt')]], value: x.template_key || '' },
          { name: 'verified_sender_only', label: t('cond_verified_sender_only'), type: 'checkbox', value: c.verified_sender_only !== false },
          { name: 'business_hours_only', label: t('cond_business_hours_only'), type: 'checkbox', value: c.business_hours_only !== false },
          { name: 'note', label: t('note'), type: 'textarea', max: 1000, value: x.note || '' }
        ],
        submit: function (v) {
          return U.call(api, 'saveMsgAutoReplyPolicy', { kind: x.kind, enabled: false, allowed_categories: v.allowed_categories, template_key: v.template_key || null,
            conditions: { verified_sender_only: !!v.verified_sender_only, business_hours_only: !!v.business_hours_only }, note: v.note || null });
        }
      }).then(K.done(api, sc, t('policy_saved'), loadAuto));
    }

    return tab === 'instructions' ? loadInstructions() : tab === 'auto' ? loadAuto() : loadTemplates();
  }

  Ops.views.templates = { allow: 'msgRead', titleKey: 'msg.nav_templates', render: render };
})();

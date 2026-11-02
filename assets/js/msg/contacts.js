/* ==========================================================================
   مرسى | MARSA — G6b contacts directory: #contacts and #contacts/<id> (دليل جهات الاتصال)
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md §3 contacts, §10 sender verification & sharing
   authorization. Uses MarsaOps.msgKit() (assets/js/msg/kit.js).

   «العنوان أو الرقم ليس تفويضًا — المشاركة تتطلب تفويضًا موثقًا»: an address in the
   directory is only "known"; it becomes "verified" by a msgVerify user with a method + note,
   and nothing is shared without an active, in-date authorization covering the document kind.
   * Add / edit contact, add address: msgTriage. Verify, grant / revoke: msgVerify.
   * Names, addresses and notes are untrusted text (textContent only).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 50;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var CF = { q: '', entity_type: '', verified: '', offset: 0 };

  function render(root, api, param) {
    var K = Ops.msgKit && Ops.msgKit();
    if (!K) return window.MarsaMsgKit ? window.MarsaMsgKit.noKit(root) : null;
    K.use(api);
    if (param && UUID_RE.test(param)) return renderContact(root, api, param, K);
    return renderList(root, api, K);
  }
  function banner(K) { return K.note('warning', K.t('not_authorization_title'), K.t('not_authorization_text')); }

  // client / party pickers (optional readers; a missing one leaves a UUID field)
  function loadRefs(K, api) {
    var U = K.U;
    return Promise.all([U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 }), U.call(api, 'listParties', { limit: 500 })]).then(function (res) {
      return { clients: res[0].error ? null : U.rowsOf(res[0].data), parties: res[1].error ? null : U.rowsOf(res[1].data) };
    });
  }
  function nameOf(U, x) { return (U.lang() === 'en' && x.name_en) || x.name_ar || x.name_en || String(x.id).slice(0, 8); }

  function contactDialog(K, api, c, refs) {
    var U = K.U, t = K.t;
    c = c || {};
    var fields = [
      { name: 'display_name', label: t('display_name'), required: true, max: 160, value: c.display_name || '' },
      { name: 'entity_type', label: t('entity_type'), type: 'select', required: true, options: K.options('msg_entity_type'), value: c.entity_type || 'party' }
    ];
    if (refs.clients) fields.push({ name: 'client_id', label: t('entity_client'), type: 'select', options: [['', U.NONE]].concat(refs.clients.map(function (x) { return [x.id, nameOf(U, x)]; })), value: c.client_id || '' });
    else fields.push({ name: 'client_id', label: t('entity_client') + ' (UUID)', ltr: true, max: 36, value: c.client_id || '' });
    if (refs.parties) fields.push({ name: 'party_id', label: t('entity_party'), type: 'select', options: [['', U.NONE]].concat(refs.parties.map(function (x) { return [x.id, nameOf(U, x)]; })), value: c.party_id || '' });
    else fields.push({ name: 'party_id', label: t('entity_party') + ' (UUID)', ltr: true, max: 36, value: c.party_id || '' });
    fields.push({ name: 'role_label', label: t('role_label'), max: 80, value: c.role_label || '', hint: t('role_label_hint') });
    fields.push({ name: 'lang', label: t('language'), type: 'select', options: [['ar', t('lang_ar')], ['en', t('lang_en')]], value: c.lang || 'ar' });
    fields.push({ name: 'notes', label: t('notes'), type: 'textarea', max: 2000, value: c.notes || '' });
    if (c.id) fields.push({ name: 'is_active', label: t('active'), type: 'checkbox', value: c.is_active !== false });
    return U.formModal({
      title: c.id ? t('edit_contact') : t('add_contact'), size: 'lg', intro: t('not_authorization_text'), fields: fields,
      validate: function (v) {
        if (v.display_name.length < 2) return { display_name: t('too_short') };
        if (v.entity_type === 'client' && !v.client_id) return { client_id: t('required') };
        if (v.entity_type === 'party' && !v.party_id) return { party_id: t('required') };
        if (v.client_id && !UUID_RE.test(v.client_id)) return { client_id: t('uuid_invalid') };
        if (v.party_id && !UUID_RE.test(v.party_id)) return { party_id: t('uuid_invalid') };
        return null;
      },
      submit: function (v) {
        var p = { display_name: v.display_name, entity_type: v.entity_type, client_id: v.entity_type === 'client' ? v.client_id : null, party_id: v.entity_type === 'party' ? v.party_id : null,
          role_label: v.role_label || null, lang: v.lang, notes: v.notes || null, is_active: c.id ? !!v.is_active : true };
        if (c.id) p.id = c.id;
        var scope = 'msg-contact-' + (c.id || 'new'), key = U.idemKey(api, scope, p);
        return U.call(api, 'saveMsgContact', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
      }
    });
  }

  /* ==================================================================
     #contacts — directory
     ================================================================== */
  function renderList(root, api, K) {
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    var triage = K.can(api, 'msgTriage');
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-contacts');
    var acts = [el('a', { class: 'btn btn-sm btn-secondary', href: '#inbox', text: t('nav_inbox') })];
    if (triage) acts.unshift(U.btn([U.icon('plus'), el('span', { text: t('add_contact') })], 'btn-primary msg-add-contact', function () {
      loadRefs(K, api).then(function (refs) { return contactDialog(K, api, null, refs); }).then(function (res) {
        if (res && sc.alive()) { U.toast(api, t('contact_saved'), 'success'); var id = res.id || (res.contact && res.contact.id); if (id) U.go(api, '#contacts/' + id); else load(); }
      });
    }));
    root.appendChild(U.head(t('contacts_title'), t('contacts_sub'), acts));
    root.appendChild(banner(K));
    var bar = el('div'), body = el('div');
    root.appendChild(bar); root.appendChild(body);
    function drawBar() {
      U.clear(bar);
      bar.appendChild(U.toolbar(U.searchBox(CF.q, t('search_contacts'), function (v) { CF.q = v; CF.offset = 0; load(); }), [
        U.select('entity_type', t('entity_type'), K.options('msg_entity_type', true), CF.entity_type, function (v) { CF.entity_type = v; CF.offset = 0; load(); }),
        U.select('verified', t('verification'), [['', t('all')], ['true', t('has_verified')], ['false', t('no_verified')]], CF.verified, function (v) { CF.verified = v; CF.offset = 0; load(); })
      ], null, null));
    }
    function load() {
      U.loadingInto(body);
      var f = { limit: PAGE, offset: CF.offset };
      if (CF.q && CF.q.trim()) f.q = CF.q.trim();
      if (CF.entity_type) f.entity_type = CF.entity_type;
      if (CF.verified) f.verified = CF.verified === 'true';
      return U.call(api, 'listMsgContacts', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        var d = K.dataOf(r), items = K.itemsOf(r), total = d.total != null ? +d.total : items.length;
        if (!items.length) { body.appendChild(U.emptyState('user', t('contacts_empty_title'), t('contacts_empty_text'))); return; }
        body.appendChild(U.table([t('display_name'), t('entity_type'), t('addresses'), t('authorizations'), t('col_status')], items.map(function (c) {
          var addrs = K.list(c.addresses);
          var tr = el('tr', { 'data-contact': c.id, class: c.is_active === false ? 'msg-row-inactive' : null, tabindex: '0' }, [
            U.td([el('a', { class: 'cell-main msg-contact-link', href: '#contacts/' + c.id }, K.safe(c.display_name)), c.role_label ? el('span', { class: 'cell-sub' }, K.safe(c.role_label)) : null]),
            U.td(entityNode(K, c)),
            U.td(addrs.length ? el('ul', { class: 'msg-addr-list' }, addrs.slice(0, 4).map(function (a) { return el('li', null, [K.addr(a.address || a.address_norm), ' ', addrBadge(K, a)]); }))
              : el('span', { class: 'ops-muted', text: t('no_addresses') })),
            U.td(String(c.authorizations_count != null ? c.authorizations_count : K.list(c.authorizations).filter(function (x) { return x.status === 'active'; }).length), 'num'),
            U.td(U.pill(c.is_active === false ? 'neutral' : 'success', c.is_active === false ? t('inactive') : t('active')))
          ]);
          tr.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a,button')) return; U.go(api, '#contacts/' + c.id); });
          return tr;
        }), { caption: t('contacts_title') }));
        var pg = K.pager(total, PAGE, CF.offset, function (o) { CF.offset = o; load(); });
        if (pg) body.appendChild(pg);
      });
    }
    drawBar();
    return load();
  }
  function entityNode(K, c) {
    var U = K.U, el = K.el;
    var kinds = K.list(c.party_kinds || (c.party && c.party.kinds));
    var name = c.client_name || c.party_name || (c.client && (c.client.name_ar || c.client.name_en)) || (c.party && (c.party.name_ar || c.party.name_en));
    var link = c.client_id ? el('a', { class: 'ops-ref', href: '#client/' + c.client_id }, K.safe(name || K.t('entity_client'))) : name ? K.safe(name) : null;
    return [el('span', { class: 'cell-main', text: K.lab('msg_entity_type', c.entity_type) }), link ? el('span', { class: 'cell-sub' }, link) : null,
      kinds.length ? el('span', { class: 'msg-kinds' }, kinds.map(function (k) { return U.pill('neutral', U.lab('party_kind', k)); })) : null];
  }
  function addrBadge(K, a) {
    var U = K.U;
    if (a.status === 'retired') return U.pill('neutral', K.t('retired'));
    return a.verified_at ? U.pill('success', K.t('rcpt_verified')) : U.pill('warning', K.t('known_unverified'));
  }

  /* ==================================================================
     #contacts/<id> — one contact: addresses + authorizations
     ================================================================== */
  function renderContact(root, api, id, K) {
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    var triage = K.can(api, 'msgTriage'), verify = K.can(api, 'msgVerify');
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-contact');
    var body = el('div');
    root.appendChild(body);
    function load() {
      U.loadingInto(body);
      return U.call(api, 'getMsgContact', id).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(el('p', null, el('a', { class: 'btn btn-sm btn-secondary', href: '#contacts', text: t('back_contacts') }))); body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(K.dataOf(r));
      });
    }
    function draw(d) {
      var c = d.contact || {};
      var acts = [el('a', { class: 'btn btn-sm btn-secondary', href: '#contacts', text: t('back_contacts') })];
      if (triage) acts.unshift(U.btn(t('edit'), 'btn-secondary msg-edit-contact', function () {
        loadRefs(K, api).then(function (refs) { return contactDialog(K, api, c, refs); }).then(K.done(api, sc, t('contact_saved'), load));
      }));
      body.appendChild(U.head(K.preview(c.display_name, 160) || U.NONE, K.lab('msg_entity_type', c.entity_type), acts));
      body.appendChild(banner(K));
      body.appendChild(U.card(t('contact_info'), K.dl([
        [t('entity_type'), entityNode(K, c)], [t('role_label'), c.role_label ? K.safe(c.role_label) : null], [t('language'), c.lang ? t('lang_' + c.lang) : null],
        [t('col_status'), U.pill(c.is_active === false ? 'neutral' : 'success', c.is_active === false ? t('inactive') : t('active'))], [t('notes'), c.notes ? K.safe(c.notes) : null]
      ]), null, { cls: 'msg-contact-card' }));
      body.appendChild(addressesCard(c, K.list(d.addresses)));
      body.appendChild(authCard(c, K.list(d.authorizations)));
      var th = K.list(d.recent_threads);
      body.appendChild(U.card(t('recent_threads'), th.length ? U.table([t('col_subject'), t('col_status'), t('col_last')], th.map(function (x) {
        return el('tr', { 'data-thread': x.id }, [U.td(el('a', { href: '#inbox/' + x.id }, K.safe(x.subject || t('no_subject')))), U.td(K.pill('msg_thread_status', x.status)), U.td(K.when(x.last_message_at), 'is-nowrap')]);
      }), { caption: t('recent_threads') }) : el('p', { class: 'ops-muted msg-none', text: t('no_threads') }), null, { flush: !!th.length }));
    }
    function addressesCard(c, addrs) {
      var acts = triage ? [U.btn([U.icon('plus'), el('span', { text: t('add_address') })], 'btn-primary msg-add-address', function () {
        U.formModal({
          title: t('add_address'), size: 'sm', intro: t('address_known_only'),
          fields: [{ name: 'kind', label: t('col_kind'), type: 'select', options: K.options('msg_channel_kind'), value: 'email' },
            { name: 'address', label: t('col_address'), required: true, max: 254, ltr: true, hint: t('address_hint') }],
          fieldMap: { address: 'address', address_taken: 'address' },
          submit: function (v) {
            var p = { kind: v.kind, address: v.address }, scope = 'msg-addr-' + c.id, key = U.idemKey(api, scope, p);
            return U.call(api, 'addMsgContactAddress', c.id, p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
          }
        }).then(K.done(api, sc, t('address_added'), load));
      })] : [];
      var content = !addrs.length ? el('p', { class: 'ops-muted msg-none', text: t('no_addresses') }) : U.table([t('col_kind'), t('col_address'), t('verification'), t('col_status'), ''], addrs.map(function (a) {
        var bs = [];
        if (a.status !== 'retired' && !a.verified_at && verify) bs.push(U.btn(t('verify'), 'btn-secondary msg-verify', function () {
          U.formModal({
            title: t('verify_title'), size: 'sm', intro: t('verify_intro'),
            fields: [{ name: 'method', label: t('verification_method'), type: 'select', required: true, options: K.options('msg_verification_method'), value: 'callback' },
              { name: 'note', label: t('note'), type: 'textarea', required: true, max: 500 }],
            submit: function (v) { return U.call(api, 'verifyMsgContactAddress', a.id, v.method, v.note); }
          }).then(K.done(api, sc, t('address_verified'), load));
        }));
        if (a.status !== 'retired' && triage) bs.push(U.btn(t('retire'), 'btn-ghost msg-retire', function () {
          U.formModal({ title: t('retire_address'), size: 'sm', danger: true, fields: [{ name: 'reason', label: t('reason'), type: 'textarea', required: true, max: 500 }],
            submit: function (v) { return U.call(api, 'retireMsgContactAddress', a.id, v.reason); } }).then(K.done(api, sc, t('address_retired'), load));
        }));
        return el('tr', { 'data-address': a.id, class: a.status === 'retired' ? 'msg-row-inactive' : null }, [
          U.td(K.kindIcon(a.kind)), U.td(K.addr(a.address || a.address_norm)),
          U.td(a.verified_at ? [addrBadge(K, a), el('span', { class: 'cell-sub', text: K.lab('msg_verification_method', a.verification_method) + ' · ' + K.when(a.verified_at) }),
            a.verification_note ? el('span', { class: 'cell-sub' }, K.safe(a.verification_note)) : null] : addrBadge(K, a)),
          U.td(a.status === 'retired' ? [U.pill('neutral', t('retired')), a.retired_reason ? el('span', { class: 'cell-sub' }, K.safe(a.retired_reason)) : null] : U.pill('success', t('active'))),
          U.td(bs.length ? el('div', { class: 'msg-acts' }, bs) : null)
        ]);
      }), { caption: t('addresses') });
      return U.card(t('addresses'), [content, el('p', { class: 'form-hint', text: t('verify_roles_note') })], acts, { cls: 'msg-addresses-card' });
    }
    function authCard(c, auths) {
      var acts = verify ? [U.btn([U.icon('plus'), el('span', { text: t('grant') })], 'btn-primary msg-grant', function () { grantDialog(c); })] : [];
      var today = U.isoDay(new Date());
      var content = !auths.length ? el('p', { class: 'ops-muted msg-none', text: t('no_authorizations') }) : U.table([t('scope'), t('may_receive'), t('may_discuss'), t('validity'), t('col_status'), ''], auths.map(function (a) {
        var expired = a.valid_until && String(a.valid_until).slice(0, 10) < today;
        var scopeRef = a.scope_type === 'transaction' && a.tx_hidden ? el('span', { class: 'ops-muted', text: t('tx_hidden') })   // review fix: other branch masked
          : a.scope_type === 'transaction' && a.transaction_id ? el('a', { class: 'ops-ref', href: '#tx/' + a.transaction_id }, K.ref(a.transaction_ref || String(a.transaction_id).slice(0, 8)))
          : a.scope_type === 'client' && a.client_id ? el('a', { class: 'ops-ref', href: '#client/' + a.client_id }, K.safe(a.client_name || String(a.client_id).slice(0, 8)))
          : K.safe(a.party_name || (a.party_id ? String(a.party_id).slice(0, 8) : null));
        return el('tr', { 'data-auth': a.id, class: a.status === 'revoked' || expired ? 'msg-row-inactive' : null }, [
          U.td([el('span', { class: 'cell-main', text: K.lab('msg_scope_type', a.scope_type) }), el('span', { class: 'cell-sub' }, scopeRef)]),
          U.td(el('span', { class: 'msg-kinds' }, K.list(a.may_receive_kinds).map(function (k) { return K.SENSITIVE_KINDS.indexOf(k) !== -1 ? U.pill('danger', K.lab('document_kind', k)) : U.pill('neutral', K.lab('document_kind', k)); }))),
          U.td(el('span', { class: 'msg-kinds' }, K.list(a.may_discuss).map(function (k) { return K.pill('msg_category', k); }))),
          U.td([K.day(a.valid_from), ' → ', a.valid_until ? K.day(a.valid_until) : t('open_ended'), expired ? U.pill('warning', t('expired')) : null], 'is-nowrap'),
          U.td([U.pill(a.status === 'revoked' ? 'neutral' : 'success', t('authst_' + (a.status || 'active'))), a.grant_note ? el('span', { class: 'cell-sub' }, K.safe(a.grant_note)) : null,
            a.revoke_reason || a.revoked_reason ? el('span', { class: 'cell-sub' }, K.safe(a.revoke_reason || a.revoked_reason)) : null]),
          U.td(a.status !== 'revoked' && verify ? U.btn(t('revoke'), 'btn-ghost msg-revoke', function () {
            U.formModal({ title: t('revoke_title'), size: 'sm', danger: true, fields: [{ name: 'reason', label: t('reason'), type: 'textarea', required: true, max: 500 }],
              submit: function (v) { return U.call(api, 'revokeMsgAuthorization', a.id, v.reason); } }).then(K.done(api, sc, t('auth_revoked'), load));
          }) : null)
        ]);
      }), { caption: t('authorizations') });
      return U.card(t('authorizations'), [content, el('p', { class: 'form-hint', text: t('auth_rule') })], acts, { cls: 'msg-auth-card' });
    }
    function grantDialog(c) {
      var scopeOpts = K.options('msg_scope_type');
      U.formModal({
        title: t('grant'), size: 'lg', intro: t('grant_intro'),
        fields: [
          { name: 'scope_type', label: t('scope'), type: 'select', required: true, options: scopeOpts, value: c.client_id ? 'client' : c.party_id ? 'party' : 'transaction' },
          { name: 'scope_id', label: t('scope_id'), ltr: true, max: 36, value: c.client_id || c.party_id || '', hint: t('scope_id_hint') },
          { name: 'may_receive_kinds', label: t('may_receive'), type: 'checks', options: K.DOC_KINDS.map(function (k) { return [k, K.lab('document_kind', k) + (K.SENSITIVE_KINDS.indexOf(k) !== -1 ? ' — ' + t('sensitive') : '')]; }), value: [], full: true },
          { name: 'may_discuss', label: t('may_discuss'), type: 'checks', options: K.options('msg_category').filter(function (o) { return o[0] !== 'unknown'; }), value: [], full: true,
            hint: t('authz_topics_hint') },
          { name: 'valid_from', label: t('valid_from'), type: 'date', value: U.isoDay(new Date()) },
          { name: 'valid_until', label: t('valid_until'), type: 'date', hint: t('valid_until_hint') },
          { name: 'note', label: t('grant_note'), type: 'textarea', required: true, max: 2000 }
        ],
        validate: function (v) {
          if (!UUID_RE.test(v.scope_id)) return { scope_id: t('uuid_invalid') };
          if (v.valid_until && v.valid_from && v.valid_until < v.valid_from) return { valid_until: t('range_invalid') };
          return null;
        },
        submit: function (v) {
          var p = { scope_type: v.scope_type, may_receive_kinds: v.may_receive_kinds, may_discuss: v.may_discuss, valid_from: v.valid_from || null, valid_until: v.valid_until || null };
          p[v.scope_type === 'transaction' ? 'transaction_id' : v.scope_type + '_id'] = v.scope_id;
          return U.call(api, 'grantMsgAuthorization', c.id, p, v.note);
        }
      }).then(K.done(api, sc, t('auth_granted'), load));
    }
    return load();
  }

  Ops.views.contacts = { allow: 'msgRead', titleKey: 'msg.nav_contacts', render: render };
})();

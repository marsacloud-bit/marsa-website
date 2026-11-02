/* ==========================================================================
   مرسى | MARSA — G6b unified inbox: #inbox (صندوق المراسلات) and #inbox/<threadId> (المحادثة)
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md (§4 threads, §5 messages, §7 extractions, §8 classification /
   summary, §12 matching, §17–§21 replies → approval → send → delivery, "Front end").
   Uses MarsaOps.msgKit() (assets/js/msg/kit.js).

   * Every message body, subject, name, address, file name and extracted value is untrusted DATA:
     textContent / createElement only, never markup strings; bodies in <pre dir="auto">.
   * Nothing on this screen sends by itself. Approval (decideMsgReply) and send (sendMsgReply)
     are two separate staff actions; the worker sends through the mock adapter only, and until it
     is deployed the job stays «في الانتظار — لم يُشغَّل العامل».
   * Buttons follow the server's can.* flags (get_msg_thread) and else the role sets at the
     thread branch (§Roles). The server decides (RLS + guarded RPCs).
   * G6b-1: the G2 contact-form inbox (#messages) stays separate; a tile links to it.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 50;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var BOXES = ['all', 'mine', 'unassigned', 'review', 'approval', 'sent'];
  var QUERY_KEYS = ['box', 'status', 'priority', 'category', 'channel_id', 'branch_id', 'owner_id', 'match_status', 'risk', 'q', 'from', 'to', 'transaction_id'];
  function blank() { return { box: 'all', status: '', priority: '', category: '', channel_id: '', branch_id: '', owner_id: '', match_status: '', risk: '', q: '', from: '', to: '', transaction_id: '', offset: 0 }; }
  var LF = blank();
  var LAST_QUERY = null;

  function render(root, api, param) {
    var K = Ops.msgKit && Ops.msgKit();
    if (!K) return window.MarsaMsgKit ? window.MarsaMsgKit.noKit(root) : null;
    K.use(api);
    if (param && UUID_RE.test(param)) return renderThread(root, api, param, K);
    return renderList(root, api, K);
  }

  /* ==================================================================
     #inbox — the list
     ================================================================== */
  function applyHashQuery(api) {
    var raw = api && typeof api.query === 'string' ? api.query : '';
    if (raw === LAST_QUERY) return;
    LAST_QUERY = raw;
    if (!raw) return;
    var q = api && typeof api.hashQuery === 'function' ? api.hashQuery() : {};
    var next = blank();
    QUERY_KEYS.forEach(function (k) {
      var v = q[k]; if (Array.isArray(v)) v = v[0];
      if (v == null || v === '') return;
      v = String(v).slice(0, 120);
      if (/_id$/.test(k) && !UUID_RE.test(v)) return;
      if (k === 'box' && BOXES.indexOf(v) === -1) return;
      if ((k === 'from' || k === 'to') && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      if (['status', 'priority', 'category', 'match_status', 'risk'].indexOf(k) !== -1 && !/^[a-z_]{1,40}$/.test(v)) return;
      next[k] = v;
    });
    LF = next;
  }
  function filtersOf() {
    var f = { limit: PAGE, offset: LF.offset || 0 };
    QUERY_KEYS.forEach(function (k) { var v = LF[k]; if (v != null && v !== '' && !(k === 'box' && v === 'all')) f[k] = k === 'q' ? String(v).trim() : v; });
    if (!f.q) delete f.q;
    return f;
  }
  function keepHash() {
    var parts = [];
    QUERY_KEYS.forEach(function (k) { var v = LF[k]; if (v && !(k === 'box' && v === 'all')) parts.push(k + '=' + encodeURIComponent(v)); });
    var h = '#inbox' + (parts.length ? '?' + parts.join('&') : '');
    LAST_QUERY = parts.join('&');
    try { if (location.hash !== h) history.replaceState(null, '', h); } catch (e) { /* ignore */ }
  }

  function renderList(root, api, K) {
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    applyHashQuery(api);
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-inbox');
    root.appendChild(U.head(t('inbox_title'), t('inbox_sub'), [
      el('a', { class: 'btn btn-sm btn-secondary', href: '#contacts', text: t('nav_contacts') }),
      el('a', { class: 'btn btn-sm btn-secondary', href: '#channels', text: t('nav_channels') })
    ]));
    var banners = el('div', { class: 'msg-banners' });
    var tiles = el('div', { class: 'adm-tiles ops-kpis msg-kpis', 'aria-live': 'polite' });
    var tabsBox = el('div'), bar = el('div'), body = el('div', { class: 'msg-list-body' });
    [banners, tiles, tabsBox, bar, body].forEach(function (n) { root.appendChild(n); });
    var counts = null, channels = [], members = [];

    // channels (filter options + mock banner) and the G2 contact-form tile, in parallel with the list
    U.call(api, 'listMsgChannels').then(function (r) {
      if (!sc.alive() || r.error) return;
      var d = K.dataOf(r);
      channels = K.itemsOf(r);
      if (d.mock === true || channels.some(function (c) { return !c.mode || c.mode === 'mock'; })) banners.insertBefore(K.mockBanner(), banners.firstChild);
      if (!channels.length) banners.appendChild(K.note('info', null, t('no_channels_hint')));
      drawBar();
    });
    U.call(api, 'listMembers', api && api.orgId).then(function (r) {
      if (!sc.alive() || r.error) return;
      members = U.rowsOf(r.data);
      drawBar();
    });

    function drawTiles() {
      U.clear(tiles);
      var c = counts || {}, bb = c.by_box || {}, bs = c.by_status || {};
      function n(v) { return v == null ? null : +v; }
      tiles.appendChild(U.kpi(t('kpi_new'), n(bs['new']), 'warning', { onClick: function () { setF({ box: 'all', status: 'new' }); }, active: LF.status === 'new' && LF.box === 'all' }));
      tiles.appendChild(U.kpi(t('kpi_unassigned'), n(bb.unassigned), 'warning', { onClick: function () { setF({ box: 'unassigned', status: '' }); }, active: LF.box === 'unassigned' }));
      tiles.appendChild(U.kpi(t('kpi_review'), n(bb.review), 'danger', { onClick: function () { setF({ box: 'review', status: '' }); }, active: LF.box === 'review' }));
      tiles.appendChild(U.kpi(t('kpi_approval'), n(bb.approval), 'warning', { onClick: function () { setF({ box: 'approval', status: '' }); }, active: LF.box === 'approval' }));
      var unk = c.send_unknown != null ? c.send_unknown : (c.by_outbound_state || {}).unknown;
      tiles.appendChild(U.kpi(t('kpi_send_unknown'), n(unk), 'danger', { foot: t('kpi_send_unknown_foot') }));
      if (K.can(api, 'contact')) contactTile();
    }
    // G6b-1: «رسائل نموذج التواصل الجديدة (N)» → #messages?status=new
    function contactTile() {
      var a = el('a', { class: 'card card-stat adm-tile ops-kpi msg-contact-tile', href: '#messages?status=new', 'data-g6b1': 'contact-form' }, [
        el('span', { class: 'stat-value num', text: U.NONE }), el('span', { class: 'stat-label', text: t('contact_form_tile', { n: '…' }) }),
        el('span', { class: 'adm-tile-foot text-xs text-muted', text: t('contact_form_foot') })]);
      tiles.appendChild(a);
      U.call(api, 'listContactMessages', { orgId: api && api.orgId, status: 'new', limit: 1, offset: 0 }).then(function (r) {
        if (!sc.alive()) return;
        var nn = r.error ? null : (r.count != null ? r.count : U.countOf(r.data));
        a.firstChild.textContent = nn == null ? U.NONE : String(nn);
        a.childNodes[1].textContent = t('contact_form_tile', { n: nn == null ? U.NONE : nn });
      });
    }
    function drawTabs() {
      U.clear(tabsBox);
      var bb = (counts && counts.by_box) || {};
      tabsBox.appendChild(K.tabs(BOXES.map(function (b) { return [b, t('box_' + b), bb[b] != null ? bb[b] : null]; }), LF.box, function (v) { setF({ box: v }); }, t('inbox_title')));
    }
    function drawBar() {
      U.clear(bar);
      var chanOpts = [['', t('all_channels')]].concat(channels.map(function (c) { return [c.id, (c.name || '') + ' · ' + K.lab('msg_channel_kind', c.kind)]; }));
      var ownerOpts = [['', t('all_owners')]];
      if (api && api.userId) ownerOpts.push([api.userId, t('owner_me')]);
      members.forEach(function (m) { var id = m.user_id || m.id; if (id && id !== (api && api.userId) && ownerOpts.every(function (o) { return o[0] !== id; })) ownerOpts.push([id, m.full_name || m.email || String(id).slice(0, 8)]); });
      var filters = [
        U.select('status', t('f_status'), K.options('msg_thread_status', true, t('all_statuses')), LF.status, function (v) { setF({ status: v }); }),
        U.select('priority', t('f_priority'), K.options('msg_priority', true, t('all_priorities')), LF.priority, function (v) { setF({ priority: v }); }),
        U.select('category', t('f_category'), K.options('msg_category', true, t('all_categories')), LF.category, function (v) { setF({ category: v }); }),
        U.select('channel_id', t('f_channel'), chanOpts, LF.channel_id, function (v) { setF({ channel_id: v }); }),
        U.select('branch_id', t('f_branch'), K.branchOptions(api, true), LF.branch_id, function (v) { setF({ branch_id: v }); }),
        U.select('owner_id', t('f_owner'), ownerOpts, LF.owner_id, function (v) { setF({ owner_id: v }); }),
        U.select('match_status', t('f_match'), K.options('msg_match_status', true, t('all_match')), LF.match_status, function (v) { setF({ match_status: v }); }),
        U.select('risk', t('f_risk'), K.options('msg_risk_flag', true, t('all_risks')), LF.risk, function (v) { setF({ risk: v }); }),
        dateIn('from', t('f_from')), dateIn('to', t('f_to'))
      ];
      var clearB = U.btn(t('clear_filters'), 'btn-ghost', function () { var b = LF.box; LF = blank(); LF.box = b; keepHash(); drawBar(); load(); });
      bar.appendChild(U.toolbar(U.searchBox(LF.q, t('search_label'), function (v) { setF({ q: v }, true); }), filters, [clearB], null));
      if (LF.transaction_id) bar.appendChild(K.note('info', null, t('filtered_by_tx')));
    }
    function dateIn(name, label) {
      var i = el('input', { class: 'form-control is-sm ops-date', type: 'date', name: name, value: LF[name] || '', 'aria-label': label, title: label });
      i.addEventListener('change', function () { var o = {}; o[name] = i.value; setF(o); });
      return el('label', { class: 'ops-range' }, [el('span', { class: 'text-xs text-muted', text: label }), i]);
    }
    function setF(o, keepBar) {
      Object.keys(o).forEach(function (k) { LF[k] = o[k]; });
      LF.offset = 0;
      keepHash();
      if (!keepBar) drawBar();
      load();
    }
    function load() {
      drawTabs();
      U.loadingInto(body);
      return U.call(api, 'listMsgThreads', filtersOf()).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { counts = null; drawTiles(); body.appendChild(U.errorState(api, r.error, load)); return; }
        var d = K.dataOf(r), items = K.itemsOf(r);
        counts = d.counts || null;
        drawTiles(); drawTabs();
        var total = d.total != null ? +d.total : (r.count != null ? r.count : items.length);
        if (!items.length) {
          body.appendChild(U.emptyState('inbox', t('inbox_empty_title'), LF.box === 'all' && !LF.status && !LF.q ? t('inbox_empty_text') : t('inbox_empty_filtered')));
          return;
        }
        body.appendChild(el('p', { class: 'toolbar-count msg-count', text: t('threads_n', { n: total }) }));
        body.appendChild(U.table([t('col_channel'), t('col_from'), t('col_subject'), t('col_category'), t('col_tx'), t('col_owner'), t('col_priority'), t('col_status'), t('col_last')],
          items.map(row), { caption: t('inbox_title') }));
        var pg = K.pager(total, PAGE, LF.offset || 0, function (off) { LF.offset = off; load(); });
        if (pg) body.appendChild(pg);
      });
    }
    function row(th) {
      var open = function () { U.go(api, '#inbox/' + th.id); };
      var fr = th.from && typeof th.from === 'object' ? th.from : {};     // review fix: the RPC nests the latest sender
      var fromName = U.pick(th, ['contact_name', 'contact_display_name', 'counterpart_name', 'last_from_name', 'from_name']) || fr.name;
      var fromAddr = U.pick(th, ['counterpart_address', 'counterpart_address_norm', 'last_from_address', 'from_address_norm', 'from_address']) || fr.address_norm;
      var senderSt = fr.sender_status || th.sender_status;
      var subj = th.subject || (th.kind === 'whatsapp' ? t('wa_conversation') : t('no_subject'));
      var link = el('a', { class: 'msg-thread-link', href: '#inbox/' + th.id }, K.safe(subj));
      var unread = +th.unread_count > 0;
      var tr = el('tr', { class: 'msg-row' + (unread ? ' is-unread' : '') + (th.match_status === 'review' ? ' msg-row-review' : '') + (th.priority === 'urgent' ? ' msg-row-urgent' : ''), 'data-thread': th.id, tabindex: '0' }, [
        U.td(K.kindIcon(th.kind || th.channel_kind), 'is-nowrap'),
        U.td([fromName ? el('span', { class: 'cell-main' }, K.safe(fromName)) : null, fromAddr ? el('span', { class: 'cell-sub' }, K.addr(fromAddr)) : null,
          senderSt ? K.senderBadge(senderSt) : null]),
        U.td([el('span', { class: 'cell-main' }, [link, unread ? el('span', { class: 'badge badge-sm badge-teal msg-unread', text: String(th.unread_count) }) : null]),
          th.preview || th.last_message_preview ? el('span', { class: 'cell-sub msg-preview', dir: 'auto', text: K.preview(th.preview || th.last_message_preview, 160) }) : null,
          K.riskBadges(th.risk_flags)]),
        U.td([K.pill('msg_category', th.category || 'unknown'), th.category_source === 'staff' ? null : K.aiTag()]),
        U.td(th.transaction_id ? el('a', { class: 'ops-ref', href: '#tx/' + th.transaction_id }, K.ref(th.transaction_ref || th.tx_ref || String(th.transaction_id).slice(0, 8)))
          : K.pill('msg_match_status', th.match_status || 'unmatched')),
        U.td(th.owner_id ? K.safe(th.owner_name || String(th.owner_id).slice(0, 8)) : el('span', { class: 'ops-muted', text: t('unassigned') })),
        U.td(K.pill('msg_priority', th.priority || 'normal')),
        U.td(K.pill('msg_thread_status', th.status || 'new')),
        U.td(K.when(th.last_message_at), 'is-nowrap')
      ]);
      tr.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a,button')) return; open(); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(); } });
      return tr;
    }
    drawTiles(); drawBar();
    return load();
  }

  /* ==================================================================
     #inbox/<id> — the conversation
     ================================================================== */
  function renderThread(root, api, id, K) {
    var U = K.U, el = K.el, t = K.t, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'msg-view', 'msg-thread-view');
    var body = el('div');
    root.appendChild(body);
    var members = [];
    U.call(api, 'listMembers', api && api.orgId).then(function (r) { if (!r.error) members = U.rowsOf(r.data); });

    function load() {
      U.loadingInto(body);
      return U.call(api, 'getMsgThread', id).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) {
          body.appendChild(el('p', null, el('a', { class: 'btn btn-sm btn-secondary', href: '#inbox', text: t('back_inbox') })));
          body.appendChild(U.errorState(api, r.error, load));
          return;
        }
        draw(K.dataOf(r));
      });
    }

    function draw(d) {
      var th = d.thread || {}, msgs = K.list(d.messages), replies = K.list(d.replies), srv = d.can || null;
      var br = th.branch_id || null;
      var can = {
        triage: K.canFlag(api, srv, 'triage', 'msgTriage', br),
        link: K.canFlag(api, srv, 'link', 'msgTriage', br),
        draft: K.canFlag(api, srv, 'draft', 'msgTriage', br),
        approve: K.canFlag(api, srv, 'approve', 'msgApprove', br),
        send: K.canFlag(api, srv, 'send', 'msgSend', br),
        resolve: K.canFlag(api, srv, 'resolve_unknown', 'msgApprove', br)
      };
      var chan = d.channel || {};
      var chanName = th.channel_name || chan.name;
      var chanKind = th.kind || chan.kind;
      var mode = th.channel_mode || chan.mode;
      var exts = [];
      msgs.forEach(function (m) { K.list(m.extractions).forEach(function (x) { exts.push({ x: x, m: m }); }); });

      body.appendChild(U.head(th.subject ? K.preview(th.subject, 200) : (chanKind === 'whatsapp' ? t('wa_conversation') : t('no_subject')),
        [chanName, K.lab('msg_channel_kind', chanKind), K.branchName(api, br)].filter(Boolean).join(' · '),
        [el('a', { class: 'btn btn-sm btn-secondary', href: '#inbox', text: t('back_inbox') })]));
      if (!mode || mode === 'mock') body.appendChild(K.mockBanner());
      K.riskBanners(th.risk_flags).forEach(function (n) { body.appendChild(n); });

      body.appendChild(triageCard(th, can));
      var grid = el('div', { class: 'msg-thread-grid' });
      var main = el('div', { class: 'msg-main' }), side = el('div', { class: 'msg-side' });
      grid.appendChild(main); grid.appendChild(side);
      body.appendChild(grid);

      side.appendChild(matchPanel(d, th, can));
      main.appendChild(timeline(msgs, th, can, exts));
      main.appendChild(replySection(d, th, msgs, replies, can));
    }

    /* ---------------- header: status / priority / owner / due / branch ---------------- */
    function triageCard(th, can) {
      var dis = !can.triage;
      var st = U.select('status', t('f_status'), K.options('msg_thread_status'), th.status || 'new');
      var pr = U.select('priority', t('f_priority'), K.options('msg_priority'), th.priority || 'normal');
      var ownerOpts = [['', t('unassigned')]];
      if (th.owner_id) ownerOpts.push([th.owner_id, th.owner_name || String(th.owner_id).slice(0, 8)]);
      if (api && api.userId && api.userId !== th.owner_id) ownerOpts.push([api.userId, t('owner_me')]);
      members.forEach(function (m) {
        var mid = m.user_id || m.id;
        if (!mid || ownerOpts.some(function (o) { return o[0] === mid; })) return;
        if (m.role && K.ROLES.msgTriage.indexOf(m.role) === -1) return;
        ownerOpts.push([mid, m.full_name || m.email || String(mid).slice(0, 8)]);
      });
      var ow = U.select('owner_id', t('f_owner'), ownerOpts, th.owner_id || '');
      var due = el('input', { class: 'form-control is-sm', type: 'datetime-local', name: 'due_at', value: U.localInput(th.due_at), 'aria-label': t('f_due') });
      var brOpts = [['', t('org_wide')]].concat(K.branchOptions(api, false));
      var bs = U.select('branch_id', t('f_branch'), brOpts, th.branch_id || '');
      [st, pr, ow, due, bs].forEach(function (n) { n.disabled = dis; });
      var saveB = U.btn(t('save_triage'), 'btn-primary msg-save-triage', function (b) {
        var p = {};
        if (st.value !== (th.status || 'new')) p.status = st.value;
        if (pr.value !== (th.priority || 'normal')) p.priority = pr.value;
        if (ow.value !== (th.owner_id || '')) p.owner_id = ow.value || null;
        var dv = U.fromLocalInput(due.value);
        if ((dv || null) !== (th.due_at ? U.fromLocalInput(U.localInput(th.due_at)) : null)) p.due_at = dv;
        if (bs.value !== (th.branch_id || '')) p.branch_id = bs.value || null;
        if (!Object.keys(p).length) { U.toast(api, t('nothing_changed'), 'info'); return; }
        b.disabled = true;
        U.call(api, 'updateMsgThread', th.id, p).then(function (r) {
          if (!sc.alive()) return;
          b.disabled = false;
          if (r.error) return K.toastErr(api, r);
          U.toast(api, t('saved'), 'success'); K.changed(); load();
        });
      }, { disabled: dis });
      var fields = el('div', { class: 'msg-triage' }, [
        lbl(t('f_status'), st), lbl(t('f_priority'), pr), lbl(t('f_owner'), ow), lbl(t('f_due'), due), lbl(t('f_branch'), bs)
      ]);
      var info = K.dl([
        [t('col_category'), el('span', null, [K.pill('msg_category', th.category || 'unknown'), th.category_source === 'staff' ? null : K.aiTag()])],
        [t('f_match'), K.pill('msg_match_status', th.match_status || 'unmatched')],
        [t('messages_count'), String(th.message_count != null ? th.message_count : U.NONE)],
        [t('col_last'), K.when(th.last_message_at)],
        [t('risks'), K.riskBadges(th.risk_flags)]
      ]);
      return U.card(t('triage_title'), [info, fields, dis ? el('p', { class: 'form-hint', text: t('read_only_hint') }) : null], can.triage ? [saveB] : [], { cls: 'msg-triage-card' });
    }
    function lbl(text, ctl) { return el('label', { class: 'msg-field' }, [el('span', { class: 'text-xs text-muted', text: text }), ctl]); }

    /* ---------------- messages timeline ---------------- */
    function timeline(msgs, th, can, exts) {
      var box = el('div', { class: 'msg-timeline' });
      if (!msgs.length) box.appendChild(U.emptyState('inbox', null, t('no_messages'), null, true));
      msgs.slice().sort(function (a, b) { return String(a.received_at || a.sent_at || '').localeCompare(String(b.received_at || b.sent_at || '')); })
        .forEach(function (m) { box.appendChild(messageCard(m, th, can)); });
      return U.card(t('timeline_title'), box, null, { cls: 'msg-timeline-card', flush: true });
    }
    function messageCard(m, th, can) {
      var inbound = m.direction !== 'outbound';
      var exts = K.list(m.extractions);
      var bodySpans = exts.filter(function (x) { return x.source === 'body' && x.status !== 'rejected'; })
        .map(function (x) { return { start: +x.span_start, end: +x.span_end, id: x.id, kind: x.kind }; });
      var subjSpans = exts.filter(function (x) { return x.source === 'subject' && x.status !== 'rejected'; })
        .map(function (x) { return { start: +x.span_start, end: +x.span_end, id: x.id, kind: x.kind }; });
      var from = m.from_address_norm || m.from_address;
      var art = el('article', { class: 'msg-msg ' + (inbound ? 'is-inbound' : 'is-outbound'), 'data-message': m.id }, [
        el('header', { class: 'msg-msg-head' }, [
          el('span', { class: 'badge badge-sm ' + (inbound ? 'badge-blue' : 'badge-teal') + ' msg-dir', text: t(inbound ? 'dir_inbound' : 'dir_outbound') }),
          el('span', { class: 'msg-from' }, [m.from_name ? K.safe(m.from_name) : null, ' ', K.addr(from)]),
          inbound ? K.senderBadge(m.sender_status) : null,
          el('span', { class: 'msg-times text-xs text-muted' }, [t('sent_at') + ': ' + K.when(m.sent_at), ' · ', t('received_at') + ': ' + K.when(m.received_at)])
        ]),
        recipientsLine(m),
        authLine(m),
        K.riskBadges(m.risk_flags),
        m.subject ? el('p', { class: 'msg-subject' }, [el('span', { class: 'text-xs text-muted', text: t('subject') + ': ' }), K.bodyNode(m.subject, subjSpans, { cls: 'msg-subject-text', expand: false })]) : null,
        K.bodyNode(m.body_text, bodySpans),
        attachmentsNode(m),
        eventsNode(m)
      ]);
      if (inbound) {
        art.appendChild(extractionsNode(m, exts, can));
        art.appendChild(classificationNode(m, can));
        var sm = summaryNode(m, exts, can);
        if (sm) art.appendChild(sm);
      }
      return art;
    }
    function recipientsLine(m) {
      var to = K.list(m.to_addresses), cc = K.list(m.cc_addresses);
      if (!to.length && !cc.length && !m.recipient_address_norm) return null;
      return el('div', { class: 'msg-addrs text-xs' }, [
        to.length ? el('span', null, [t('to') + ': '].concat(to.map(function (a, i) { return [i ? ', ' : '', K.addr(a.address || a.address_norm || a)]; }))) : null,
        cc.length ? el('span', null, [' · ' + t('cc') + ': '].concat(cc.map(function (a, i) { return [i ? ', ' : '', K.addr(a.address || a.address_norm || a)]; }))) : null,
        m.recipient_address_norm ? el('span', { class: 'text-muted' }, [' · ' + t('reached_channel') + ': ', K.addr(m.recipient_address_norm)]) : null
      ]);
    }
    function authLine(m) {
      var a = m.auth_results;
      if (!a || typeof a !== 'object') return null;
      return el('div', { class: 'msg-auth text-xs' }, ['spf', 'dkim', 'dmarc'].filter(function (k) { return a[k]; }).map(function (k) {
        return U.pill(a[k] === 'pass' ? 'success' : a[k] === 'fail' ? 'danger' : 'neutral', k.toUpperCase() + ': ' + (a[k] === 'pass' ? t('auth_pass') : a[k] === 'fail' ? t('auth_fail') : t('auth_none')));
      }));
    }
    function attachmentsNode(m) {
      var a = K.list(m.attachments);
      if (!a.length) return null;
      return el('div', { class: 'msg-atts' }, [el('h4', { class: 'msg-sub-title', text: t('attachments_title', { n: a.length }) }),
        el('ul', { class: 'msg-att-list' }, a.map(function (x) {
          var stored = x.storage_status === 'stored';
          var dl = stored ? U.btn(t('download'), 'btn-secondary msg-dl', function (b) {
            b.disabled = true;
            U.call(api, 'msgAttachmentUrl', x, 60).then(function (r) {
              b.disabled = false;
              if (r.error) return K.toastErr(api, r);
              var url = typeof r.data === 'string' ? r.data : (r.data && (r.data.signedUrl || r.data.url));
              if (url && /^https?:\/\//i.test(url)) { try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ } }
            });
          }) : null;
          return el('li', { class: 'msg-att', 'data-att': x.id }, [U.icon('file'), K.safe(x.file_name || t('unnamed_file'), { cls: 'msg-filename' }),
            el('span', { class: 'cell-sub' }, [K.ref(x.mime_type), ' · ', K.fmtSize(x.size_bytes)]),
            K.pill('msg_storage_status', x.storage_status || 'not_fetched'), K.pill('msg_scan_status', x.scan_status || 'not_scanned'), dl,
            x.extracted_text ? el('details', { class: 'msg-att-text' }, [el('summary', { text: t('attachment_text') }), K.bodyNode(x.extracted_text,
              K.list(m.extractions).filter(function (e) { return e.source === 'attachment' && e.attachment_id === x.id && e.status !== 'rejected'; })
                .map(function (e) { return { start: +e.span_start, end: +e.span_end, id: e.id, kind: e.kind }; }))]) : null
          ]);
        }))]);
    }
    function eventsNode(m) {
      var ev = K.list(m.events);
      if (!ev.length) return null;
      return el('div', { class: 'msg-events text-xs' }, ev.map(function (e) {
        var p = e.payload || {};
        return el('div', { class: 'msg-event' }, [U.pill('neutral', K.tOr('event_' + e.event, e.event)), ' ', K.when(e.at),
          e.event === 'edited' && p.text ? el('details', null, [el('summary', { text: t('edited_text') }), K.bodyNode(p.text, null, { expand: false })]) : null,
          e.event === 'reaction' && p.emoji ? el('span', null, [' ', K.safe(p.emoji)]) : null]);
      }));
    }
    function sourceText(m, x) {
      if (x.source === 'subject') return m.subject || '';
      if (x.source === 'attachment') { var a = K.list(m.attachments).filter(function (y) { return y.id === x.attachment_id; })[0]; return a ? a.extracted_text || '' : ''; }
      return m.body_text || '';
    }
    function extractionsNode(m, exts, can) {
      var box = el('div', { class: 'msg-exts' }, el('h4', { class: 'msg-sub-title', text: t('extractions_title') }));
      if (!exts.length) { box.appendChild(el('p', { class: 'ops-muted msg-none', text: t('no_extractions') })); return box; }
      box.appendChild(U.table([t('col_kind'), t('col_value'), t('col_valid'), t('col_confidence'), t('col_source'), t('col_status'), ''], exts.map(function (x) {
        var acts = [];
        if (can.triage && (x.status === 'suggested' || !x.status)) {
          acts.push(U.btn(t('confirm'), 'btn-secondary msg-ext-confirm', function (b) { reviewExt(b, x, 'confirm'); }));
          acts.push(U.btn(t('correct'), 'btn-ghost msg-ext-correct', function () { correctExt(x); }));
          acts.push(U.btn(t('reject'), 'btn-ghost msg-ext-reject', function () { rejectExt(x); }));
        }
        var valid = x.valid === false ? U.pill('danger', x.kind === 'container_no' ? t('invalid_check_digit') : t('invalid')) : x.valid === true ? U.pill('success', t('valid')) : null;
        var amb = x.detail && x.detail.ambiguous ? U.pill('warning', K.lab('msg_risk_flag', 'ambiguous_date')) : null;
        return el('tr', { 'data-ext': x.id, class: x.status === 'rejected' ? 'msg-ext-rejected' : null }, [
          U.td(K.lab('msg_extraction_kind', x.kind)),
          U.td([K.ref(x.corrected_value || x.normalized || x.raw), x.corrected_value ? el('span', { class: 'cell-sub' }, [t('was') + ' ', K.ref(x.normalized)]) : null]),
          U.td([valid, amb]),
          U.td(x.confidence != null ? Math.round(+x.confidence * 100) + '%' : null, 'num'),
          U.td([el('span', { class: 'cell-sub', text: t('source_' + (x.source || 'body')) }), K.spanSnippet(sourceText(m, x), +x.span_start, +x.span_end, x.raw)]),
          U.td(K.pill('msg_extraction_status', x.status || 'suggested')),
          U.td(acts.length ? el('div', { class: 'msg-acts' }, acts) : null)
        ]);
      }), { caption: t('extractions_title') }));
      return box;
    }
    function reviewExt(b, x, decision) {
      b.disabled = true;
      U.call(api, 'reviewMsgExtraction', x.id, decision, null, null).then(function (r) {
        if (!sc.alive()) return;
        b.disabled = false;
        if (r.error) return K.toastErr(api, r);
        U.toast(api, t('ext_' + decision + 'ed'), 'success'); K.changed(); load();
      });
    }
    function correctExt(x) {
      U.formModal({
        title: t('correct_title', { kind: K.lab('msg_extraction_kind', x.kind) }), size: 'sm',
        fields: [{ name: 'value', label: t('correct_value'), required: true, max: 200, ltr: true, value: x.normalized || x.raw },
          { name: 'note', label: t('note'), type: 'textarea', max: 2000 }],
        submit: function (v) { return U.call(api, 'reviewMsgExtraction', x.id, 'correct', v.value, v.note || null); }
      }).then(K.done(api, sc, t('ext_corrected'), load));
    }
    function rejectExt(x) {
      U.formModal({
        title: t('reject_ext_title'), size: 'sm', danger: true, submitText: t('reject'),
        fields: [{ name: 'note', label: t('note'), type: 'textarea', max: 2000 }],
        submit: function (v) { return U.call(api, 'reviewMsgExtraction', x.id, 'reject', null, v.note || null); }
      }).then(K.done(api, sc, t('ext_rejected'), load));
    }
    function latestClass(m) {
      var c = m.classifications;
      if (c && !Array.isArray(c) && typeof c === 'object') return { latest: c.latest || null, history: K.list(c.history) };
      var arr = K.list(c).slice().sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
      return { latest: arr[arr.length - 1] || m.classification || null, history: arr };
    }
    function classificationNode(m, can) {
      var c = latestClass(m), l = c.latest;
      var box = el('div', { class: 'msg-class' }, el('h4', { class: 'msg-sub-title', text: t('classification_title') }));
      var line = el('div', { class: 'msg-class-line' }, [
        K.pill('msg_category', (l && l.category) || 'unknown'),
        l && l.source === 'staff' ? U.pill('success', t('class_staff')) : K.aiTag(),
        l && l.confidence != null ? el('span', { class: 'text-xs text-muted', text: t('confidence_n', { n: Math.round(+l.confidence * 100) }) }) : null,
        l && K.list(l.rules).length ? el('span', { class: 'text-xs text-muted msg-rules' }, [t('keywords') + ': '].concat(K.list(l.rules).slice(0, 6).map(function (x, i) { return [i ? '، ' : '', K.safe(x.keyword || x.rule)]; }))) : null,
        l && l.source === 'staff' && l.note ? el('span', { class: 'cell-sub' }, K.safe(l.note)) : null,
        can.triage ? U.btn(t('correct_class'), 'btn-ghost msg-class-correct', function () { correctClass(m, l); }) : null
      ]);
      box.appendChild(line);
      box.appendChild(el('p', { class: 'form-hint', text: t('class_is_suggestion') }));
      if (c.history.length > 1) box.appendChild(el('details', { class: 'msg-class-hist' }, [el('summary', { text: t('history_n', { n: c.history.length }) }),
        el('ul', null, c.history.map(function (h) { return el('li', null, [K.pill('msg_category', h.category), ' ', t('class_src_' + (h.source || 'ai')), ' · ', K.when(h.created_at), h.note ? [' · ', K.safe(h.note)] : null]); }))]));
      return box;
    }
    function correctClass(m, l) {
      U.formModal({
        title: t('correct_class_title'), size: 'sm',
        fields: [{ name: 'category', label: t('col_category'), type: 'select', required: true, options: K.options('msg_category'), value: (l && l.category) || 'unknown' },
          { name: 'note', label: t('note'), type: 'textarea', required: true, max: 2000 }],
        submit: function (v) { return U.call(api, 'correctMsgClassification', m.id, v.category, v.note); }
      }).then(K.done(api, sc, t('class_corrected'), load));
    }
    function summaryNode(m, exts, can) {
      var s = m.summary;
      if (!s) return null;
      var en = U.lang() === 'en';
      var text = (en ? s.summary_en : s.summary_ar) || s.summary_ar || s.summary_en;
      var dx = s.deadline_extraction_id ? exts.filter(function (x) { return x.id === s.deadline_extraction_id; })[0] : null;
      var deadline = s.deadline_date && dx
        ? el('span', { class: 'msg-deadline' }, [K.ref(s.deadline_date), ' ', el('span', { class: 'cell-sub', text: t('deadline_source') }), K.spanSnippet(sourceText(m, dx), +dx.span_start, +dx.span_end, dx.raw)])
        : el('span', { class: 'ops-muted msg-no-deadline', text: t('no_deadline') });
      var acts = [];
      if (can.triage && !s.accepted_at) acts.push(U.btn(t('accept_summary'), 'btn-secondary msg-accept-summary', function () { acceptSummary(s); }));
      return el('div', { class: 'msg-summary', 'data-summary': s.id }, [
        el('h4', { class: 'msg-sub-title' }, [t('summary_title'), ' ', K.aiTag()]),
        el('p', { class: 'msg-summary-text', dir: 'auto', text: text || U.NONE }),
        K.dl([
          [t('action'), K.lab('msg_action', s.action_code)],
          [t('suggested_role'), s.suggested_role ? K.lab('role', s.suggested_role, api) : null],
          [t('deadline'), deadline],
          [t('risks'), K.riskBadges(s.risks)],
          [t('accepted'), s.accepted_at ? K.when(s.accepted_at) : null]
        ]),
        acts.length ? el('div', { class: 'msg-acts' }, acts) : null
      ]);
    }
    function acceptSummary(s) {
      var ownerOpts = [['', t('owner_keep')]];
      if (api && api.userId) ownerOpts.push([api.userId, t('owner_me')]);
      members.forEach(function (mm) { var mid = mm.user_id || mm.id; if (mid && mid !== api.userId && (!mm.role || K.ROLES.msgTriage.indexOf(mm.role) !== -1)) ownerOpts.push([mid, mm.full_name || mm.email || String(mid).slice(0, 8)]); });
      var fields = [{ name: 'owner_id', label: t('f_owner'), type: 'select', options: ownerOpts, value: '' }];
      if (s.deadline_extraction_id) fields.push({ name: 'set_due', label: t('set_due'), type: 'checkbox', value: true });
      U.formModal({
        title: t('accept_summary'), size: 'sm', intro: s.deadline_extraction_id ? null : t('no_deadline_hint'), fields: fields,
        submit: function (v) {
          var p = { set_due: !!(s.deadline_extraction_id && v.set_due) };
          if (v.owner_id) p.owner_id = v.owner_id;
          return U.call(api, 'acceptMsgSummary', s.id, p);
        }
      }).then(K.done(api, sc, t('summary_accepted'), load));
    }

    /* ---------------- match panel (step ١٣) ---------------- */
    function matchPanel(d, th, can) {
      var links = K.list(d.links).slice().sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
      var cands = K.list(d.candidates).length ? K.list(d.candidates) : K.list(th.match_candidates);
      var box = el('div', { class: 'msg-match' });
      var cur = links.filter(function (l) { return l.action === 'auto_link' || l.action === 'link'; }).pop() || null;
      box.appendChild(K.dl([
        [t('f_match'), K.pill('msg_match_status', th.match_status || 'unmatched')],
        [t('linked_tx'), th.transaction_id ? el('a', { class: 'ops-ref', href: '#tx/' + th.transaction_id }, K.ref(th.transaction_ref || th.tx_ref || String(th.transaction_id).slice(0, 8))) : null],
        [t('match_reason'), th.match_reason ? K.tOr('reason_' + th.match_reason, th.match_reason) : null]
      ]));
      if (th.match_status === 'review' || th.match_reason === 'conflict') box.appendChild(K.note('danger', t('conflict_title'), t(th.match_reason === 'multiple' ? 'reason_multiple_long' : 'conflict_text')));
      if (th.transaction_id && cur) box.appendChild(basisNode(cur));
      if (cands.length) {
        box.appendChild(el('h4', { class: 'msg-sub-title', text: t('candidates_title') }));
        box.appendChild(U.table([t('col_tx'), t('col_score'), t('col_signals'), ''], cands.map(function (c, i) {
          if (c.hidden) {                                  // review fix: another branch's transaction is masked by the RPC
            return el('tr', { class: 'msg-cand-hidden' }, [U.td(el('span', { class: 'ops-muted', text: t('cand_hidden') })),
              U.td(String(c.score != null ? c.score : U.NONE), 'num'), U.td(el('span', { class: 'ops-muted', text: U.NONE })), U.td(null)]);
          }
          var isCur = th.transaction_id && c.transaction_id === th.transaction_id;
          return el('tr', { 'data-cand': c.transaction_id, class: isCur ? 'is-current' : null }, [
            U.td(el('a', { class: 'ops-ref', href: '#tx/' + c.transaction_id }, K.ref(c.ref || c.transaction_ref || String(c.transaction_id || '').slice(0, 8)))),
            U.td(String(c.score != null ? c.score : U.NONE), 'num'),
            U.td(signalsNode(c.signals)),
            U.td(can.link && !isCur ? U.btn(t('link_this'), 'btn-secondary msg-link-cand', function () { linkDialog(th, cands, c.transaction_id, i !== 0); }) : null)
          ]);
        }), { caption: t('candidates_title') }));
      } else box.appendChild(el('p', { class: 'ops-muted msg-none', text: t('no_candidates') }));
      var acts = [];
      if (can.link) {
        acts.push(U.btn(t('link_other'), 'btn-secondary msg-link-other', function () { linkDialog(th, cands, null, true); }));
        if (th.transaction_id) acts.push(U.btn(t('unlink'), 'btn-ghost msg-unlink', function () { reasonDialog('unlinkMsgThread', th.id, t('unlink_title'), t('unlinked')); }));
        if (th.match_status !== 'not_related') acts.push(U.btn(t('not_related'), 'btn-ghost msg-not-related', function () { reasonDialog('markMsgNotRelated', th.id, t('not_related_title'), t('marked_not_related')); }));
      }
      if (acts.length) box.appendChild(el('div', { class: 'msg-acts' }, acts));
      if (links.length) box.appendChild(el('details', { class: 'msg-links-hist' }, [el('summary', { text: t('links_history_n', { n: links.length }) }),
        el('ul', { class: 'msg-hist' }, links.slice().reverse().map(function (l) {
          return el('li', { 'data-link-action': l.action }, [U.pill(l.action === 'unlink' || l.action === 'not_related' ? 'neutral' : l.action === 'review' ? 'warning' : 'success', K.lab('msg_link_action', l.action)),
            ' ', t('method_' + (l.method || 'staff')), ' · ', K.when(l.created_at),
            l.actor_name ? [' · ', K.safe(l.actor_name)] : null, l.transaction_ref ? [' · ', K.ref(l.transaction_ref)] : null,
            l.transaction_hidden ? [' · ', el('span', { class: 'ops-muted', text: t('tx_hidden') })] : null,
            l.note ? el('div', { class: 'cell-sub' }, K.safe(l.note)) : null, l.basis ? basisNode(l, true) : null]);
        }))]));
      return U.card(t('match_title'), box, null, { cls: 'msg-match-card' });
    }
    function signalsNode(sig) {
      var s = K.list(sig);
      if (!s.length) return el('span', { class: 'ops-muted', text: U.NONE });
      return el('ul', { class: 'msg-signals' }, s.map(function (x) {
        return el('li', { 'data-signal': x.kind }, [el('span', { class: 'text-xs', text: K.lab('msg_signal_kind', x.kind) + (x.strength ? ' (' + K.tOr('strength_' + x.strength, x.strength) + ')' : '') + ': ' }), K.ref(x.value)]);
      }));
    }
    function basisNode(l, compact) {
      var b = l.basis || {};
      return el('div', { class: 'msg-basis' + (compact ? ' is-compact' : '') }, [
        compact ? null : el('h4', { class: 'msg-sub-title', text: t('basis_title') }),
        el('p', { class: 'text-xs' }, [t('basis_rule') + ': ', el('span', { text: b.rule ? K.tOr('rule_' + b.rule, b.rule) : U.NONE }), b.score != null ? ' · ' + t('col_score') + ': ' + b.score : null,
          b.sender ? [' · ', t('basis_sender') + ': ', K.lab('msg_sender_status', b.sender.status)] : null]),
        signalsNode(b.signals),
        !compact && K.list(b.candidates).length > 1 ? el('p', { class: 'text-xs text-muted', text: t('basis_other_candidates', { n: K.list(b.candidates).length - 1 }) }) : null
      ]);
    }
    function linkDialog(th, cands, preset, needNote) {
      var opts = cands.filter(function (c) { return !c.hidden && c.transaction_id; }).map(function (c) { return [c.transaction_id, (c.ref || c.transaction_ref || String(c.transaction_id).slice(0, 8)) + ' — ' + t('col_score') + ' ' + (c.score != null ? c.score : '?')]; });
      opts.push(['__other', t('other_tx')]);
      var noteReq = needNote || th.match_status === 'review';
      U.formModal({
        title: t('link_title'), intro: noteReq ? t('link_note_required') : t('link_intro'),
        fields: [
          { name: 'tx', label: t('col_tx'), type: 'select', options: opts, value: preset || (opts.length > 1 ? opts[0][0] : '__other'), required: true },
          { name: 'tx_id', label: t('other_tx_id'), ltr: true, max: 36, hint: t('other_tx_hint') },
          { name: 'note', label: t('note'), type: 'textarea', max: 2000, required: noteReq }
        ],
        validate: function (v) {
          if (v.tx === '__other' && !UUID_RE.test(v.tx_id)) return { tx_id: t('uuid_invalid') };
          if (v.tx !== '__other' && cands[0] && v.tx !== cands[0].transaction_id && !v.note) return { note: t('note_required_not_top') };
          return null;
        },
        submit: function (v) { return U.call(api, 'linkMsgThread', th.id, v.tx === '__other' ? v.tx_id : v.tx, v.note || null); }
      }).then(K.done(api, sc, t('linked'), load));
    }
    function reasonDialog(fn, arg, title, okMsg) {
      U.formModal({
        title: title, size: 'sm', danger: true,
        fields: [{ name: 'reason', label: t('reason'), type: 'textarea', required: true, max: 2000 }],
        submit: function (v) { return U.call(api, fn, arg, v.reason); }
      }).then(K.done(api, sc, okMsg, load));
    }

    /* ---------------- replies: composer → review → send (steps ١٧–٢١) ---------------- */
    function versionsOf(rep) { return K.list(rep.versions).slice().sort(function (a, b) { return (+a.version_no || 0) - (+b.version_no || 0); }); }
    function currentVersion(rep) {
      var v = versionsOf(rep);
      return v.filter(function (x) { return x.id === rep.current_version_id; })[0] || v[v.length - 1] || null;
    }
    function outboundsOf(rep) { var o = rep.outbound || rep.outbounds; return Array.isArray(o) ? o : o ? [o] : []; }
    function participants(msgs, th) {
      var own = {}, seen = {}, out = [];
      msgs.forEach(function (m) { if (m.recipient_address_norm) own[m.recipient_address_norm] = 1; if (m.direction === 'outbound' && m.from_address_norm) own[m.from_address_norm] = 1; });
      function add(a) { a = a && (a.address_norm || a.address || (typeof a === 'string' ? a : null)); if (!a || own[a] || seen[a]) return; seen[a] = 1; out.push(a); }
      msgs.forEach(function (m) {
        if (m.direction !== 'outbound') add(m.from_address_norm || m.from_address);
        K.list(m.to_addresses).forEach(add); K.list(m.cc_addresses).forEach(add);
      });
      if (th.counterpart_address_norm) add(th.counterpart_address_norm);
      return out;
    }
    function lastInbound(msgs) {
      return msgs.filter(function (m) { return m.direction !== 'outbound'; }).sort(function (a, b) { return String(a.received_at || '').localeCompare(String(b.received_at || '')); }).pop() || null;
    }

    function replySection(d, th, msgs, replies, can) {
      var box = el('div', { class: 'msg-replies' });
      var live = replies.filter(function (r) { return K.LIVE_REPLY.indexOf(r.status) !== -1; })[0] || null;
      var reopenable = !live ? replies.filter(function (r) { return r.status === 'rejected'; }).sort(function (a, b) { return String(a.updated_at || '').localeCompare(String(b.updated_at || '')); }).pop() : null;
      if (live) box.appendChild(replyCard(d, th, msgs, live, can));
      else if (reopenable && can.draft) box.appendChild(replyCard(d, th, msgs, reopenable, can));
      else box.appendChild(composerStart(d, th, msgs, can));
      var past = replies.filter(function (r) { return r !== live && r !== reopenable; });
      if (past.length) box.appendChild(U.card(t('past_replies'), past.map(function (r) { return pastReply(r, can); }), null, { cls: 'msg-past' }));
      return box;
    }
    function composerStart(d, th, msgs, can) {
      var parts = [];
      if (!can.draft) { parts.push(el('p', { class: 'ops-muted', text: t('no_reply_yet') })); return U.card(t('composer_title'), parts, null, { cls: 'msg-composer' }); }
      var sug = d.suggestions && d.suggestions.template_key;
      var tplOpts = K.CODES.msg_template_key.filter(function (k) { return k !== 'ack_receipt'; }).map(function (k) { return [k, K.lab('msg_template_key', k) + (k === sug ? ' — ' + t('suggested') : '')]; });
      var tplSel = U.select('template_key', t('template'), tplOpts, sug && sug !== 'ack_receipt' ? sug : 'clarification');
      var langSel = U.select('lang', t('language'), [['ar', t('lang_ar')], ['en', t('lang_en')]], U.lang() === 'en' ? 'en' : 'ar');
      var li = lastInbound(msgs);
      var status = el('div', { class: 'msg-draft-status', 'aria-live': 'polite' });
      // review fix: get_msg_thread returns the open draft jobs, so the pending request survives a reload
      var jobs = K.list(d.jobs).filter(function (j) { return j.kind === 'draft' && (j.status === 'queued' || j.status === 'running' || j.status === 'unknown'); });
      if (jobs.length) {
        var jo = jobs[jobs.length - 1].options || {};
        status.appendChild(K.note('info', t('draft_job_queued'), t('worker_not_deployed')));
        if (jo.template_key) status.appendChild(el('p', { class: 'form-hint msg-draft-pending', text: t('draft_job_pending', { tpl: K.lab('msg_template_key', jo.template_key), lang: jo.lang === 'en' ? t('lang_en') : t('lang_ar') }) }));
      }
      var genB = U.btn(jobs.length ? t('replace_draft_request') : t('make_draft'), 'btn-primary msg-make-draft', function (b) {
        if (jobs.length && typeof window.confirm === 'function' && !window.confirm(t('replace_draft_confirm'))) return;
        var p = { template_key: tplSel.value, lang: langSel.value, reply_to_message_id: li ? li.id : null };
        var scope = 'msg-draft-' + th.id, key = U.idemKey(api, scope, p);
        b.disabled = true;
        U.call(api, 'requestMsgDraft', th.id, p, { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!sc.alive()) return;
          b.disabled = false;
          if (r.error) return K.toastErr(api, r);
          var dd = K.dataOf(r);
          K.changed();
          if (dd.reply && dd.reply.id) { load(); return; }
          U.clear(status);
          status.appendChild(K.note('info', dd.job && dd.job.deduplicated ? t('draft_job_updated') : t('draft_job_queued'), t('worker_not_deployed')));
        });
      });
      var manualB = U.btn(t('write_manual'), 'btn-secondary msg-write-manual', function () { manualDialog(th, msgs, li); });
      parts.push(el('div', { class: 'msg-composer-start' }, [lbl(t('template'), tplSel), lbl(t('language'), langSel), genB, manualB]));
      parts.push(el('p', { class: 'form-hint', text: t('draft_confirmed_only') }));
      parts.push(status);
      return U.card(t('composer_title'), parts, null, { cls: 'msg-composer' });
    }
    function manualDialog(th, msgs, li) {
      var to = li ? [li.from_address_norm || li.from_address] : (th.counterpart_address_norm ? [th.counterpart_address_norm] : []);
      U.formModal({
        title: t('write_manual'), size: 'lg', intro: t('recipients_rule'),
        fields: [
          { name: 'lang', label: t('language'), type: 'select', options: [['ar', t('lang_ar')], ['en', t('lang_en')]], value: U.lang() === 'en' ? 'en' : 'ar' },
          { name: 'subject', label: t('subject'), max: 500, full: true, value: th.subject ? (/^re:/i.test(th.subject) ? th.subject : 'Re: ' + th.subject) : '' },
          { name: 'body_text', label: t('body'), type: 'textarea', rows: 8, max: 20000, required: true },
          { name: 'to', label: t('to'), ltr: true, required: true, value: to.filter(Boolean).join(', '), hint: t('addr_list_hint'), full: true },
          { name: 'cc', label: t('cc'), ltr: true, hint: t('addr_list_hint'), full: true }
        ],
        submit: function (v) {
          var p = { thread_id: th.id, reply_to_message_id: li ? li.id : null, lang: v.lang, subject: v.subject || null, body_text: v.body_text, to: splitAddr(v.to), cc: splitAddr(v.cc) };
          var scope = 'msg-save-new-' + th.id, key = U.idemKey(api, scope, p);
          return U.call(api, 'saveMsgReply', null, p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      }).then(K.done(api, sc, t('reply_saved'), load));
    }
    function splitAddr(s) { return String(s || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 50); }

    function replyCard(d, th, msgs, rep, can) {
      var v = currentVersion(rep) || {};
      var parts = [];
      var st = rep.status;
      var head = el('div', { class: 'msg-reply-head' }, [K.pill('msg_reply_status', st), ' ', el('span', { class: 'text-xs text-muted', text: t('version_n', { n: v.version_no || 1 }) }),
        v.author_kind === 'ai_mock' ? [' ', K.aiTag(), el('span', { class: 'text-xs text-muted', text: ' ' + t('author_ai') })] : null,
        rep.template_key ? el('span', { class: 'text-xs text-muted', text: ' · ' + t('template') + ': ' + K.lab('msg_template_key', rep.template_key) }) : null]);
      parts.push(head);
      if (v.template_status === 'builtin' || rep.template_status === 'builtin') parts.push(K.note('warning', null, t('template_builtin')));
      if (v.clarification) parts.push(K.note('info', t('clarification_title'), t('clarification_text')));
      if (K.list(v.missing).length) parts.push(el('p', { class: 'text-sm' }, [t('missing_items') + ': '].concat(K.list(v.missing).map(function (x, i) { return [i ? '، ' : '', K.lab('msg_missing', x)]; }))));
      if (st === 'rejected') parts.push(K.note('warning', null, t('rejected_reopen')));
      // an approval exists, but for an older version (an edit after approval → draft, approved_version_id NULL)
      var stale = !!rep.approval_stale || (rep.approved_version_id && rep.current_version_id && rep.approved_version_id !== rep.current_version_id) ||
        (st === 'draft' && K.list(rep.approvals).some(function (a) { return a.decision === 'approve' && a.version_id && a.version_id !== (v.id || rep.current_version_id); }));
      if (stale) parts.push(K.note('warning', t('approval_stale_title'), t('approval_stale')));

      var editable = (st === 'draft' || st === 'rejected') && can.draft;
      if (editable) parts.push(editorNode(th, msgs, rep, v));
      else parts.push(finalText(v));
      parts.push(el('h4', { class: 'msg-sub-title', text: t('recipients') }));
      parts.push(K.recipientList(v.to_addresses, v.cc_addresses));
      parts.push(el('h4', { class: 'msg-sub-title', text: t('reply_attachments') }));
      parts.push(K.attachmentList(v.attachments));
      if (editable) parts.push(suggestionsNode(rep, v));
      if (K.list(v.used_facts).length) parts.push(el('p', { class: 'text-xs text-muted msg-facts' }, [t('used_facts') + ': '].concat(K.list(v.used_facts).map(function (f, i) { return [i ? '، ' : '', K.tOr('fact_' + f, f)]; }))));

      var acts = [];
      if (st === 'draft' && can.draft) acts.push(U.btn(t('submit'), 'btn-primary msg-submit', function (b) { simple(b, 'submitMsgReply', [rep.id], t('submitted')); }));
      if ((st === 'draft' || st === 'pending_approval' || st === 'approved') && can.draft) acts.push(U.btn(t('cancel_reply'), 'btn-ghost msg-cancel', function () { reasonDialog('cancelMsgReply', rep.id, t('cancel_reply'), t('reply_cancelled')); }));
      if (st === 'approved' && can.draft) acts.push(U.btn(t('edit_after_approval'), 'btn-ghost msg-edit-approved', function () { editAfterApproval(th, msgs, rep, v); }));
      if (acts.length) parts.push(el('div', { class: 'msg-acts' }, acts));

      var cards = [U.card(t('reply_title'), parts, null, { cls: 'msg-reply-card', sub: st === 'draft' ? t('reply_draft_sub') : null })];
      if (st === 'pending_approval' || st === 'approved' || st === 'rejected' || K.list(rep.approvals).length) cards.push(reviewPanel(th, rep, v, can));
      if (st === 'approved' || st === 'sending' || st === 'sent' || st === 'send_failed' || st === 'send_unknown' || outboundsOf(rep).length) cards.push(sendPanel(th, rep, v, can, msgs));
      return el('div', { class: 'msg-reply-stack' }, cards);
    }
    function finalText(v) {
      return el('div', { class: 'msg-final' }, [
        v.subject ? el('p', { class: 'msg-subject' }, [el('span', { class: 'text-xs text-muted', text: t('subject') + ': ' }), K.safe(v.subject)]) : null,
        K.bodyNode(v.body_text, null, { cls: 'msg-final-body' })
      ]);
    }
    function editorNode(th, msgs, rep, v) {
      var subj = el('input', { class: 'form-control', type: 'text', name: 'subject', maxlength: '500', dir: 'auto', 'aria-label': t('subject') });
      subj.value = v.subject || '';
      var bodyTa = el('textarea', { class: 'form-control msg-editor-body', name: 'body_text', rows: '10', maxlength: '20000', dir: 'auto', 'aria-label': t('body') });
      bodyTa.value = v.body_text || '';
      var cur = K.list(v.to_addresses).map(function (r) { return r.address_norm || r.address || r; });
      var curCc = K.list(v.cc_addresses).map(function (r) { return r.address_norm || r.address || r; });
      var opts = participants(msgs, th);
      cur.concat(curCc).forEach(function (a) { if (a && opts.indexOf(a) === -1) opts.push(a); });
      var checks = el('fieldset', { class: 'msg-rcpt-checks' }, [el('legend', { class: 'form-label', text: t('to') })].concat(opts.map(function (a) {
        return el('label', { class: 'check ops-check' }, [el('input', { type: 'checkbox', name: 'to', value: a, checked: cur.indexOf(a) !== -1 }), K.addr(a)]);
      })));
      var cc = el('input', { class: 'form-control', type: 'text', name: 'cc', dir: 'ltr', 'aria-label': t('cc'), placeholder: t('addr_list_hint') });
      cc.value = curCc.join(', ');
      var saveB = U.btn(t('save_version'), 'btn-secondary msg-save-reply', function (b) {
        var to = Array.prototype.filter.call(checks.querySelectorAll('input[name="to"]'), function (i) { return i.checked; }).map(function (i) { return i.value; });
        var p = { thread_id: th.id, reply_to_message_id: rep.reply_to_message_id || null, lang: rep.lang || 'ar', subject: subj.value.trim() || null, body_text: bodyTa.value, to: to, cc: splitAddr(cc.value) };
        if (!p.body_text.trim()) { U.toast(api, t('body_required'), 'error'); return; }
        var scope = 'msg-save-' + rep.id, key = U.idemKey(api, scope, p);
        b.disabled = true;
        U.call(api, 'saveMsgReply', rep.id, p, { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!sc.alive()) return;
          b.disabled = false;
          if (r.error) return K.toastErr(api, r);
          U.toast(api, t('reply_saved'), 'success'); K.changed(); load();
        });
      });
      return el('div', { class: 'msg-editor' }, [lbl(t('subject'), subj), lbl(t('body'), bodyTa), checks,
        el('p', { class: 'form-hint', text: t('recipients_rule') }), lbl(t('cc'), cc), el('div', { class: 'msg-acts' }, [saveB])]);
    }
    function editAfterApproval(th, msgs, rep, v) {
      U.confirm(api, { title: t('edit_after_approval'), text: t('edit_after_approval_warn'), okText: t('continue_edit'), danger: true }).then(function (ok) {
        if (!ok) return;
        U.formModal({
          title: t('edit_after_approval'), size: 'lg', warn: t('edit_after_approval_warn'),
          fields: [{ name: 'subject', label: t('subject'), max: 500, value: v.subject || '', full: true },
            { name: 'body_text', label: t('body'), type: 'textarea', rows: 8, max: 20000, required: true, value: v.body_text || '' }],
          submit: function (x) {
            var p = { thread_id: th.id, reply_to_message_id: rep.reply_to_message_id || null, lang: rep.lang || 'ar', subject: x.subject || null, body_text: x.body_text,
              to: K.list(v.to_addresses).map(function (r) { return r.address_norm || r.address || r; }), cc: K.list(v.cc_addresses).map(function (r) { return r.address_norm || r.address || r; }) };
            var scope = 'msg-save-' + rep.id, key = U.idemKey(api, scope, p);
            return U.call(api, 'saveMsgReply', rep.id, p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
          }
        }).then(K.done(api, sc, t('reply_saved_stale'), load));
      });
    }
    function suggestionsNode(rep, v) {
      var box = el('div', { class: 'msg-sugg' }, [el('h4', { class: 'msg-sub-title', text: t('att_suggestions') }), el('p', { class: 'form-hint', text: t('att_never_auto') })]);
      var host = el('div');
      box.appendChild(host);
      U.loadingInto(host);
      U.call(api, 'msgAttachmentSuggestions', rep.id).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(host);
        if (r.error) { host.appendChild(U.errorState(api, r.error)); return; }
        var items = K.itemsOf(r);
        if (!items.length) { host.appendChild(el('p', { class: 'ops-muted msg-none', text: t('no_suggestions') })); return; }
        var chosen = K.list(v.attachments).map(function (a) { return a.document_id; });
        var rows = items.map(function (x) {
          var cb = el('input', { type: 'checkbox', name: 'doc', value: x.document_id, checked: chosen.indexOf(x.document_id) !== -1, disabled: x.can_share === false, 'aria-label': x.name || x.kind });
          return el('tr', { 'data-doc': x.document_id, class: x.can_share === false ? 'msg-cannot-share' : null }, [
            U.td(cb), U.td([K.safe(x.name || K.lab('document_kind', x.classification || x.kind)), el('span', { class: 'cell-sub', text: K.lab('document_kind', x.classification || x.kind) })]),
            U.td(K.sensitiveBadge(x)), U.td(x.can_share === false ? [U.pill('danger', t('cannot_share')), K.reasonsNode(x.reasons)] : U.pill('success', t('can_share'))),
            U.td(K.day(x.uploaded_at), 'is-nowrap')
          ]);
        });
        host.appendChild(U.table(['', t('col_doc'), t('col_sensitivity'), t('col_can_share'), t('col_uploaded')], rows, { caption: t('att_suggestions') }));
        host.appendChild(el('div', { class: 'msg-acts' }, [U.btn(t('set_attachments'), 'btn-secondary msg-set-atts', function (b) {
          var ids = Array.prototype.filter.call(host.querySelectorAll('input[name="doc"]'), function (i) { return i.checked && !i.disabled; }).map(function (i) { return i.value; }).slice(0, 10);
          b.disabled = true;
          U.call(api, 'setMsgReplyAttachments', rep.id, ids).then(function (r2) {
            if (!sc.alive()) return;
            b.disabled = false;
            if (r2.error) return K.toastErr(api, r2);
            U.toast(api, t('attachments_set'), 'success'); K.changed(); load();
          });
        })]));
      });
      return box;
    }
    function simple(b, fn, args, okMsg) {
      b.disabled = true;
      U.call.apply(null, [api, fn].concat(args)).then(function (r) {
        if (!sc.alive()) return;
        b.disabled = false;
        if (r.error) return K.toastErr(api, r);
        U.toast(api, okMsg, 'success'); K.changed(); load();
      });
    }

    /* review & approval (step ١٩) */
    function reviewPanel(th, rep, v, can) {
      var level = rep.approval_level || rep.level || K.DEFAULT_LEVEL[rep.category] || 'standard';
      var atts = K.list(v.attachments), sensitive = atts.some(K.isSensitive);
      var author = v.author_id || v.requested_by || null;
      var mine = !!(api && api.userId && (api.userId === author || api.userId === rep.submitted_by || (v.author_kind === 'ai_mock' && api.userId === v.requested_by)));
      var levelOk = K.can(api, K.LEVEL_ROLES[level] || K.ROLES.msgApprove, th.branch_id || undefined);
      var parts = [];
      parts.push(K.dl([
        [t('approval_level'), K.pill('msg_approval_level', level)],
        [t('col_category'), K.pill('msg_category', rep.category || th.category || 'unknown')],
        [t('submitted_by'), rep.submitted_by ? el('span', null, [K.safe(rep.submitted_by_name || String(rep.submitted_by).slice(0, 8)), ' · ', K.when(rep.submitted_at)]) : null],
        [t('content_hash'), v.content_sha256 ? K.ref(String(v.content_sha256).slice(0, 16) + '…') : null]
      ]));
      K.riskBanners(th.risk_flags).forEach(function (n) { parts.push(n); });
      parts.push(el('h4', { class: 'msg-sub-title', text: t('final_text') }));
      parts.push(finalText(v));
      parts.push(el('h4', { class: 'msg-sub-title', text: t('recipients') }));
      parts.push(K.recipientList(v.to_addresses, v.cc_addresses));
      parts.push(el('h4', { class: 'msg-sub-title', text: t('reply_attachments') }));
      parts.push(K.attachmentList(atts));
      if (sensitive) parts.push(K.note('warning', null, t('sensitive_needs_ack')));
      if (K.list(v.used_facts).length) parts.push(el('p', { class: 'text-xs text-muted' }, [t('used_facts') + ': '].concat(K.list(v.used_facts).map(function (f, i) { return [i ? '، ' : '', K.tOr('fact_' + f, f)]; }))));
      if (rep.status === 'pending_approval') {
        if (mine) parts.push(el('div', { class: 'alert alert-warning msg-four-eyes', role: 'note' }, [U.icon('alert'), el('div', { text: t('four_eyes_notice') })]));
        else parts.push(el('p', { class: 'form-hint msg-four-eyes-hint', text: t('four_eyes_rule') }));
        if (can.approve && !levelOk) parts.push(K.note('info', null, t('level_roles_needed', { level: K.lab('msg_approval_level', level) })));
        var acts = [];
        if (can.approve) {
          acts.push(U.btn(t('approve'), 'btn-primary msg-approve', function () { decide(rep, v, 'approve', sensitive); }, { disabled: mine || !levelOk }));
          acts.push(U.btn(t('reject'), 'btn-danger msg-reject', function () { decide(rep, v, 'reject', false); }, { disabled: mine || !levelOk }));
        }
        if (acts.length) parts.push(el('div', { class: 'msg-acts' }, acts));
      }
      parts.push(historyNode(rep));
      return U.card(t('review_title'), parts, null, { cls: 'msg-review-card', sub: t('review_sub') });
    }
    function decide(rep, v, decision, sensitive) {
      var fields = [{ name: 'note', label: t('note'), type: 'textarea', max: 2000, required: decision === 'reject' }];
      if (decision === 'approve' && sensitive) fields.unshift({ name: 'ack', label: t('sensitive_ack'), type: 'checkbox', value: false });
      U.formModal({
        title: decision === 'approve' ? t('approve_title') : t('reject_title'), size: 'sm', danger: decision === 'reject',
        submitText: decision === 'approve' ? t('approve') : t('reject'), intro: decision === 'approve' ? t('approve_intro') : null, fields: fields,
        validate: function (x) {
          if (decision === 'approve' && sensitive && !x.ack) return { ack: t('sensitive_ack_required') };
          if (decision === 'approve' && sensitive && !x.note) return { note: t('note_required_ack') };
          return null;
        },
        submit: function (x) { return U.call(api, 'decideMsgReply', rep.id, v.id, decision, x.note || null, !!(decision === 'approve' && sensitive && x.ack)); }
      }).then(K.done(api, sc, decision === 'approve' ? t('approved_ok') : t('rejected_ok'), load));
    }
    function historyNode(rep) {
      var vs = versionsOf(rep), ap = K.list(rep.approvals);
      return el('details', { class: 'msg-history' }, [el('summary', { text: t('history_title', { v: vs.length, a: ap.length }) }),
        vs.length ? U.table([t('version'), t('author'), t('col_when'), t('content_hash')], vs.slice().reverse().map(function (x) {
          return el('tr', { 'data-version': x.id }, [U.td(String(x.version_no)), U.td(x.author_kind === 'ai_mock' ? [K.aiTag(), ' ', t('author_ai')] : K.safe(x.author_name || (x.author_id ? String(x.author_id).slice(0, 8) : U.NONE))),
            U.td(K.when(x.created_at), 'is-nowrap'), U.td(x.content_sha256 ? K.ref(String(x.content_sha256).slice(0, 12)) : null)]);
        }), { caption: t('versions') }) : null,
        ap.length ? U.table([t('decision'), t('version'), t('approval_level'), t('sensitive_ack_col'), t('actor'), t('note'), t('col_when')], ap.map(function (a) {
          var vn = vs.filter(function (x) { return x.id === a.version_id; })[0];
          return el('tr', { 'data-approval': a.id }, [U.td(U.pill(a.decision === 'approve' ? 'success' : 'danger', t('decision_' + a.decision))), U.td(vn ? String(vn.version_no) : null),
            U.td(a.level ? K.lab('msg_approval_level', a.level) : null), U.td(a.sensitive_ack ? t('yes') : t('no')),
            U.td(K.safe(a.actor_name || (a.actor ? String(a.actor).slice(0, 8) : U.NONE))), U.td(a.note ? K.safe(a.note) : null), U.td(K.when(a.created_at), 'is-nowrap')]);
        }), { caption: t('approvals') }) : el('p', { class: 'ops-muted msg-none', text: t('no_approvals') })]);
    }

    /* authorized send + delivery tracking (steps ٢٠–٢١) */
    function sendPanel(th, rep, v, can, msgs) {
      var parts = [], obs = outboundsOf(rep);
      var stale = rep.approved_version_id && rep.current_version_id && rep.approved_version_id !== rep.current_version_id;
      if (rep.status === 'approved') {
        if (stale) parts.push(K.note('warning', null, t('approval_stale')));
        if (th.kind === 'whatsapp' && th.last_inbound_at && (Date.now() - new Date(th.last_inbound_at).getTime()) > 24 * 3600 * 1000) parts.push(K.note('warning', null, t('wa_window_closed')));
        parts.push(el('p', { class: 'form-hint', text: t('send_rule') }));
        if (can.send) parts.push(el('div', { class: 'msg-acts' }, [U.btn(t('send'), 'btn-primary msg-send', function (b) {
          U.confirm(api, { title: t('send_confirm_title'), text: t('send_confirm_text'), okText: t('send') }).then(function (ok) {
            if (!ok) return;
            var scope = 'msg-send-' + rep.id + '-' + (rep.approved_version_id || ''), key = U.idemKey(api, scope, { reply: rep.id, version: rep.approved_version_id });
            b.disabled = true;
            U.call(api, 'sendMsgReply', rep.id, { idemKey: key }).then(function (r) {
              U.idemSettle(scope, r.error);
              if (!sc.alive()) return;
              b.disabled = false;
              if (r.error) return K.toastErr(api, r);
              U.toast(api, K.dataOf(r).deduplicated ? t('send_dedup') : t('send_queued'), 'success'); K.changed(); load();
            });
          });
        }, { disabled: !!stale })]));
        else parts.push(el('p', { class: 'ops-muted', text: t('send_roles_needed') }));
      }
      obs.forEach(function (o) { parts.push(outboundNode(o, can)); });
      if (!parts.length) parts.push(el('p', { class: 'ops-muted msg-none', text: t('no_outbound') }));
      return U.card(t('send_title'), parts, null, { cls: 'msg-send-card', sub: t('send_sub') });
    }
    function outboundNode(o, can) {
      var st = o.state || 'queued';
      var box = el('div', { class: 'msg-outbound msg-ob-' + st, 'data-outbound': o.id }, [
        K.dl([
          [t('ob_state'), K.pill('msg_outbound_state', st)],
          [t('provider_request_id'), K.ref(o.provider_request_id)],
          [t('provider_message_id'), o.provider_message_id ? K.ref(o.provider_message_id) : null],
          [t('requested_by'), o.requested_by ? el('span', null, [K.safe(o.requested_by_name || String(o.requested_by).slice(0, 8)), ' · ', K.when(o.requested_at)]) : null],
          [t('accepted_at'), o.accepted_at ? K.when(o.accepted_at) : null],
          [t('delivered_at'), o.delivered_at ? K.when(o.delivered_at) : null],
          [t('read_at'), o.read_at ? K.when(o.read_at) : null],
          [t('last_error'), o.last_error_code || o.last_error_message ? el('span', { class: 'msg-text-danger' }, [K.ref(o.last_error_code), ' ', K.safe(o.last_error_message)]) : null],
          [t('unknown_resolution'), o.unknown_resolution ? el('span', null, [t('res_' + o.unknown_resolution), o.resolution_note ? [' · ', K.safe(o.resolution_note)] : null]) : null]
        ])
      ]);
      if (st === 'queued') box.appendChild(K.note('info', t('ob_queued_title'), t('worker_not_deployed')));
      if (st === 'accepted') box.appendChild(K.note('info', null, t('accepted_not_delivered')));
      if (st === 'unknown') box.appendChild(K.note('warning', t('unknown_title'), t('unknown_text')));
      if (st === 'failed') box.appendChild(K.note('danger', null, t('failed_text')));
      var ev = K.list(o.delivery_events);
      if (ev.length) box.appendChild(U.table([t('col_event'), t('col_when'), t('col_source'), t('last_error')], ev.map(function (e) {
        return el('tr', { 'data-delivery': e.provider_event_id || e.id }, [U.td(K.pill('msg_delivery_status', e.status)), U.td(K.when(e.at), 'is-nowrap'), U.td(K.tOr('evsrc_' + (e.source || 'send_result'), e.source)), U.td(e.error_code ? K.ref(e.error_code) : null)]);
      }), { caption: t('delivery_events') }));
      var acts = [];
      if (st === 'failed' && can.send && o.retryable !== false) acts.push(U.btn(t('retry_send'), 'btn-secondary msg-retry-send', function (b) { simple(b, 'retryMsgSend', [o.id], t('retry_queued')); }));
      if (st === 'unknown' && can.resolve) acts.push(U.btn(t('resolve_unknown'), 'btn-secondary msg-resolve', function () {
        U.formModal({
          title: t('resolve_unknown'), size: 'sm', intro: t('resolve_intro'),
          fields: [{ name: 'decision', label: t('decision'), type: 'select', required: true, options: [['confirmed_sent', t('res_confirmed_sent')], ['confirmed_not_sent', t('res_confirmed_not_sent')]], value: 'confirmed_sent' },
            { name: 'note', label: t('note'), type: 'textarea', required: true, max: 2000 }],
          submit: function (v) { return U.call(api, 'resolveMsgSendUnknown', o.id, v.decision, v.note); }
        }).then(K.done(api, sc, t('resolved_ok'), load));
      }));
      if (acts.length) box.appendChild(el('div', { class: 'msg-acts' }, acts));
      return box;
    }
    // an earlier reply (sent / failed / cancelled / rejected): a failed send can still be retried from here
    function pastReply(r, can) {
      var v = currentVersion(r) || {};
      return el('details', { class: 'msg-past-reply', 'data-reply': r.id }, [
        el('summary', null, [K.pill('msg_reply_status', r.status), ' ', K.when(r.updated_at || r.created_at), v.subject ? [' · ', K.safe(K.preview(v.subject, 80))] : null]),
        finalText(v), K.recipientList(v.to_addresses, v.cc_addresses),
        outboundsOf(r).map(function (o) { return outboundNode(o, { send: !!(can && can.send), resolve: !!(can && can.resolve) }); }),
        r.cancel_reason || r.cancelled_reason ? el('p', { class: 'cell-sub' }, [t('reason') + ': ', K.safe(r.cancel_reason || r.cancelled_reason)]) : null,
        historyNode(r)
      ]);
    }

    return load();
  }

  Ops.views.inbox = { allow: 'msgRead', titleKey: 'msg.nav_inbox', render: render };
})();

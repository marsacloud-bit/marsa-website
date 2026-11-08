/*
  Marsa (مرسى) — G6b unified inbox: channel adapter contract (docs/online/G6B_SPEC.md § Edge Function, adapters.js).
  STAGING ONLY. Plain classic script (no import / export, no require), ES2020, no dependencies:
  node tests require() it, Deno loads it by side-effect import and reads globalThis.MarsaInbox.

  This file defines:
    - CHANNEL_METHODS / WRITE_METHODS / CAPABILITY_KEYS — the provider contract every channel adapter implements:
        probe() → {capabilities, account:{address}}
        fetchInbound({cursor, limit}) → {messages:[raw], next_cursor}
        send({request_id, from, to, cc, subject, body_text, in_reply_to, references, attachments}) → {provider_message_id, status}
        lookupSend(request_id) → {found, provider_message_id?, status?}   (or throws AdapterError validation 'unsupported')
        fetchStatusEvents({cursor}) → {events, next_cursor}
    - AdapterError — the only error type an adapter throws (kind + applied 'no' | 'unknown' | 'yes');
    - normalizeInbound — raw provider message (mock e-mail / mock WhatsApp shapes) → the CANONICAL inbound message
      that msg_ingest_messages / the poll completion accept (HTML is converted to plain text here, never stored);
    - normalizeAddress — mirror of app.msg_norm_address;
    - redact / scrubText — mirror of app.msg_redact / app.msg_scrub_text (= the G5 app.bill_redact rules);
    - sha256Hex — lowercase hex SHA-256 of a UTF-8 string (globalThis.crypto.subtle);
    - estimateAiCost / AI_PRICES — the AI cost-estimate hook (rule_mock = 0; llm_pending = null = unknown → refused;
      claude = claude-opus-5-5 per-direction prices, real token usage when the provider reports it);
    - createLiveEmailAdapter — G6c: the REAL IMAP / SMTP adapter only when the config carries connect + imap + smtp AND
      an explicit factory (config.impl = email-live.js createImapSmtpEmail, passed by index.ts; review H1), else the
      documented stub; createLiveWhatsAppAdapter — documented stub. Stubs throw AdapterError('not_configured'), never
      read a key and never call fetch;
    - createLlmProvider — the AI provider interface: the model-backed provider (llm-provider.js) when given an injected
      callModel + factory, else the stub whose every method throws not_configured;
    - LIVE_ENDPOINTS_TO_VERIFY — data only. Nothing here is ever called.
*/
(function () {
  'use strict';

  const CHANNEL_METHODS = Object.freeze(['probe', 'fetchInbound', 'send', 'lookupSend', 'fetchStatusEvents']);
  // a lost response on these is "unknown", never "failed"
  const WRITE_METHODS = Object.freeze(['send']);
  const CAPABILITY_KEYS = Object.freeze(['send', 'lookup_send', 'status_events', 'attachments', 'threading', 'templates']);
  const AI_METHODS = Object.freeze(['extract', 'classify', 'summarize', 'draftReply', 'detectInjection']);

  const ERROR_KINDS = Object.freeze(['timeout', 'network', 'http_5xx', 'rate_limited', 'validation', 'not_found', 'conflict', 'not_configured', 'window_closed']);
  const RETRYABLE_KINDS = Object.freeze(['timeout', 'network', 'http_5xx', 'rate_limited']);
  const APPLIED = Object.freeze(['no', 'unknown', 'yes']);

  class AdapterError extends Error {
    constructor(kind, message, opts) {
      const o = opts || {};
      super(message || kind);
      this.name = 'AdapterError';
      this.kind = ERROR_KINDS.includes(kind) ? kind : 'network';
      this.code = o.code ? String(o.code).slice(0, 60) : this.kind;
      this.http_status = Number.isInteger(o.http_status) ? o.http_status : null;
      this.applied = APPLIED.includes(o.applied) ? o.applied : 'no';
    }
    toJSON() { return { kind: this.kind, code: this.code, message: String(this.message).slice(0, 500), http_status: this.http_status, applied: this.applied }; }
  }
  const isAdapterError = e => !!e && (e instanceof AdapterError || e.name === 'AdapterError') && typeof e.kind === 'string';

  /* ---------------------------------------------------------------- limits (G6b binding rules) */
  const LIMITS = Object.freeze({
    subject: 500, body_text: 100000, name: 160, address: 254, attachments: 20, attachment_bytes: 26214400,
    batch: 50, provider_id: 200, file_name: 255, mime_type: 120, recipients: 50, raw_bytes: 262144
  });

  /* ---------------------------------------------------------------- redaction (mirror of app.msg_redact) */
  const SECRET_RE = /(api[_-]?key|secret|token|password|passwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)/i;
  const SECRET_EXACT_RE = /^\s*(pass|pwd|auth|bearer|x-auth)\s*$/i;
  const isSecretKey = k => SECRET_RE.test(k) || SECRET_EXACT_RE.test(k);

  function scrubText(t) {
    if (typeof t !== 'string') return t;
    return t
      .replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/gi, '$1?[redacted]')
      .replace(/(bearer|basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
      .replace(/([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)[A-Za-z0-9_.-]*)(\s*[=:]\s*"?)[^\s&"',;]+/gi, '$1$2[redacted]');
  }
  function redact(x, depth) {
    const d = depth || 0;
    if (d > 20) return null;
    if (Array.isArray(x)) {
      if (x.length === 2 && typeof x[0] === 'string' && isSecretKey(x[0])) return [x[0], '[redacted]'];
      return x.map(v => redact(v, d + 1));
    }
    if (x && typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x)) if (!isSecretKey(k) && x[k] !== undefined) o[k] = redact(x[k], d + 1);
      return o;
    }
    if (typeof x === 'string') return scrubText(x).slice(0, 4000);
    return x === undefined ? null : x;
  }

  /* ---------------------------------------------------------------- hashing */
  function utf8(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    // eslint-disable-next-line no-undef
    return Uint8Array.from(Buffer.from(s, 'utf8'));
  }
  async function sha256Hex(s) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('crypto.subtle unavailable');
    const buf = await subtle.digest('SHA-256', utf8(String(s === null || s === undefined ? '' : s)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // key-sorted JSON (stable across engines and key insertion order)
  function stableStringify(x) {
    if (x === null || x === undefined) return 'null';
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    if (typeof x === 'object') {
      return '{' + Object.keys(x).filter(k => x[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
    }
    if (typeof x === 'number' && !Number.isFinite(x)) return 'null';
    return JSON.stringify(x);
  }
  const cpLen = s => Array.from(String(s === null || s === undefined ? '' : s)).length;
  const cpSlice = (s, n) => Array.from(String(s)).slice(0, n).join('');

  /* ---------------------------------------------------------------- addresses (mirror of app.msg_norm_address) */
  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  function foldDigitsStr(s) {
    let out = '';
    for (const ch of String(s)) {
      const a = ARABIC_DIGITS.indexOf(ch);
      const p = PERSIAN_DIGITS.indexOf(ch);
      out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
    }
    return out;
  }
  // → normalized address or null when invalid
  function normalizeAddress(kind, text) {
    if (text === null || text === undefined) return null;
    if (kind === 'email') {
      const s = String(text).trim().toLowerCase();
      if (s.length < 3 || s.length > LIMITS.address) return null;
      if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s)) return null;
      return s;
    }
    if (kind === 'whatsapp') {
      let s = foldDigitsStr(String(text)).replace(/[\s\-() ]/g, '');
      if (s.startsWith('00')) s = '+' + s.slice(2);
      if (/^05\d{8}$/.test(s)) s = '+966' + s.slice(1);
      return /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- inbound normalisation */
  function invalid(field, msg) { return new AdapterError('validation', msg || ('invalid inbound ' + field), { applied: 'no', code: field }); }
  function clip(s, n) { return s === null || s === undefined ? null : cpSlice(String(s), n); }
  // HTML → plain text (the adapter converts; HTML is never stored nor rendered)
  function htmlToText(html) {
    return String(html)
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function iso(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(/^\d+$/.test(String(v)) ? Number(v) * 1000 : v));
    return Number.isNaN(n.getTime()) ? null : n.toISOString();
  }
  function addrList(kind, list) {
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    if (arr.length > LIMITS.recipients) throw invalid('to', 'too many recipients');
    return arr.map(a => {
      const address = typeof a === 'string' ? a : (a && (a.address || a.email || a.phone));
      if (!normalizeAddress(kind, address)) throw invalid('address');
      const o = { address: String(address).trim().slice(0, LIMITS.address) };
      const name = typeof a === 'object' && a ? (a.name || null) : null;
      if (name) o.name = clip(name, LIMITS.name);
      return o;
    });
  }
  function authVal(v) { const s = String(v || 'none').toLowerCase(); return ['pass', 'fail', 'none'].includes(s) ? s : 'none'; }
  function normAttachments(list) {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length > LIMITS.attachments) throw invalid('attachments', 'too many attachments');
    const seen = new Set();
    return arr.map((a, i) => {
      const id = String((a && (a.provider_attachment_id || a.id)) || ('att-' + (i + 1))).slice(0, LIMITS.provider_id);
      if (seen.has(id)) throw invalid('attachments', 'duplicate attachment id');
      seen.add(id);
      const size = Number(a && (a.size_bytes !== undefined ? a.size_bytes : a.size));
      if (!Number.isInteger(size) || size < 0) throw invalid('attachments', 'attachment size');
      const o = {
        provider_attachment_id: id,
        file_name: clip(String((a && (a.file_name || a.filename)) || 'attachment').replace(/[\u0000-\u001f\u007f]/g, ''), LIMITS.file_name) || 'attachment',
        mime_type: clip(String((a && (a.mime_type || a.contentType || a.mime)) || 'application/octet-stream'), LIMITS.mime_type),
        size_bytes: size
      };
      if (a && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256)) o.sha256 = a.sha256;
      const t = a && (a.extracted_text !== undefined ? a.extracted_text : a.text);
      if (typeof t === 'string' && t !== '') o.extracted_text = clip(t, LIMITS.body_text);
      return o;
    });
  }
  // raw is stored redacted and WITHOUT bodies (body_text is the stored copy; attachments keep metadata only)
  function rawSummary(raw, provider) {
    const r = raw || {};
    const keep = {};
    for (const k of Object.keys(r)) {
      if (['text', 'html', 'body', 'body_text', 'attachments', 'extracted_text'].includes(k)) continue;
      keep[k] = r[k];
    }
    const out = redact(Object.assign({ provider }, keep));
    const s = JSON.stringify(out);
    return s.length * 3 > LIMITS.raw_bytes ? { provider, truncated: true } : out;
  }

  // canonical inbound: {provider_message_id, provider_thread_id?, kind, from:{address, name?}, to, cc, sent_at, subject?,
  //   body_text, headers?, wa_context?, auth?, attachments, raw}
  function normalizeInbound(raw, opts) {
    const o = opts || {};
    const r = raw || {};
    const kind = o.kind || r.kind || (r.messaging_product === 'whatsapp' ? 'whatsapp' : 'email');
    if (kind !== 'email' && kind !== 'whatsapp') throw invalid('kind');
    const pid = String(r.provider_message_id || r.id || '').trim();
    if (!pid || pid.length > LIMITS.provider_id) throw invalid('provider_message_id');
    const out = { provider_message_id: pid, kind };
    if (kind === 'email') {
      const from = r.from && typeof r.from === 'object' ? r.from : { address: r.from };
      const fa = from.address || from.email;
      if (!normalizeAddress('email', fa)) throw invalid('from');
      out.from = { address: String(fa).trim() };
      if (from.name) out.from.name = clip(from.name, LIMITS.name);
      out.to = addrList('email', r.to);
      out.cc = addrList('email', r.cc);
      if (r.thread_id || r.threadId) out.provider_thread_id = String(r.thread_id || r.threadId).slice(0, LIMITS.provider_id);
      out.subject = clip(r.subject === undefined || r.subject === null ? '' : r.subject, LIMITS.subject);
      const text = typeof r.text === 'string' ? r.text : (typeof r.body_text === 'string' ? r.body_text : (typeof r.html === 'string' ? htmlToText(r.html) : ''));
      if (cpLen(text) > LIMITS.body_text) throw invalid('body_text', 'body too long');
      out.body_text = text;
      const h = r.headers || {};
      const refs = h.references || h.References;
      out.headers = {
        message_id: String(h.message_id || h['Message-ID'] || ('<' + pid + '@mock-mail.invalid>')).slice(0, 300),
        in_reply_to: (h.in_reply_to || h['In-Reply-To']) ? String(h.in_reply_to || h['In-Reply-To']).slice(0, 300) : null,
        references: (Array.isArray(refs) ? refs : (refs ? String(refs).split(/\s+/) : [])).filter(Boolean).slice(0, 20).map(x => String(x).slice(0, 300))
      };
      const au = r.auth || r.authResults || r.auth_results || {};
      out.auth = { spf: authVal(au.spf), dkim: authVal(au.dkim), dmarc: authVal(au.dmarc) };
    } else {
      const fa = r.from && typeof r.from === 'object' ? (r.from.address || r.from.phone) : r.from;
      if (!normalizeAddress('whatsapp', fa)) throw invalid('from');
      out.from = { address: String(fa).trim() };
      const pname = (r.profile && r.profile.name) || (r.from && r.from.name);
      if (pname) out.from.name = clip(pname, LIMITS.name);
      out.to = addrList('whatsapp', r.to);
      out.cc = [];
      out.subject = '';
      const text = r.text && typeof r.text === 'object' ? String(r.text.body || '') : (typeof r.text === 'string' ? r.text : (typeof r.body_text === 'string' ? r.body_text : ''));
      if (cpLen(text) > LIMITS.body_text) throw invalid('body_text', 'body too long');
      out.body_text = text;
      const ctx = r.context || r.wa_context || null;
      out.wa_context = { reply_to_provider_id: ctx && (ctx.id || ctx.reply_to_provider_id) ? String(ctx.id || ctx.reply_to_provider_id).slice(0, LIMITS.provider_id) : null, type: String(r.type || 'text').slice(0, 30) };
    }
    out.sent_at = iso(r.sent_at || r.date || r.timestamp);
    if (!out.sent_at) throw invalid('sent_at');
    out.attachments = normAttachments(r.attachments || (r.document ? [r.document] : []));
    out.raw = rawSummary(r, o.provider || (kind === 'email' ? 'mock-email' : 'mock-whatsapp'));
    return out;
  }

  /* ---------------------------------------------------------------- AI cost estimate hook (§24) */
  // USD per 1k tokens. A number = one price for input + output (rule_mock 0; null = unknown → refused). A Claude model =
  // per-direction prices from the published list (claude-api skill, shared/models.md): Claude Opus 5.5 $4 in / $20 out per
  // MTok, cache reads $0.20, cache writes 1.25 × input; Claude Opus 5 / Opus 4.8 (possible refusal-fallback targets)
  // $5 / $25, cache reads 0.1 ×. settings.ai_provider 'claude' = model claude-opus-5-5.
  const claudePrice = (inp, out, read) => Object.freeze({ input_per_1k: inp, output_per_1k: out, cache_read_per_1k: read, cache_write_per_1k: inp * 1.25 });
  const AI_PRICES = Object.freeze({
    rule_mock: 0, llm_pending: null,
    'claude-opus-5-5': claudePrice(0.004, 0.02, 0.0002),
    'claude-opus-5': claudePrice(0.005, 0.025, 0.0005),
    'claude-opus-4-8': claudePrice(0.005, 0.025, 0.0005)
  });
  const AI_PROVIDER_MODELS = Object.freeze({ claude: 'claude-opus-5-5' });
  // an unknown claude-* model (e.g. a future refusal-fallback target) is priced at the most expensive known Claude price
  function claudeMaxPrice() {
    let best = null;
    for (const k of Object.keys(AI_PRICES)) {
      const p = AI_PRICES[k];
      if (p && typeof p === 'object' && (!best || p.output_per_1k > best.output_per_1k)) best = p;
    }
    return best;
  }
  function priceOf(o) {
    const key = o.model || AI_PROVIDER_MODELS[o.provider] || o.provider;
    if (Object.prototype.hasOwnProperty.call(AI_PRICES, key)) return AI_PRICES[key];
    if (typeof key === 'string' && /^claude-/.test(key)) return claudeMaxPrice();
    return null;
  }
  const tok = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const ceil4 = x => Math.ceil(Math.round(x * 1e8) / 1e4) / 10000;
  // estimateAiCost({provider | model, input_chars, output_chars, usage?, exact?}) → {est_input_tokens, est_output_tokens, est_cost_usd}
  //   without usage: tokens = ceil(chars / 4) (the G6b estimate); with usage (the model's real counts): those tokens, and
  //   usage.cost_usd when the provider already priced each attempt. Claude costs round UP to 4 decimals (numeric(10,4));
  //   exact: true returns the unrounded cost (to sum attempts before rounding once).
  function estimateAiCost(x) {
    const o = x || {};
    const u = o.usage && typeof o.usage === 'object' ? o.usage : null;
    const inC = Math.max(0, Number(o.input_chars) || 0);
    const outC = Math.max(0, Number(o.output_chars) || 0);
    const cr = u ? tok(u.cache_read_input_tokens) : 0, cw = u ? tok(u.cache_creation_input_tokens) : 0;
    const inT = u ? tok(u.input_tokens) : Math.ceil(inC / 4);
    const est_input_tokens = inT + cr + cw;
    const est_output_tokens = u ? tok(u.output_tokens) : Math.ceil(outC / 4);
    const price = priceOf(o);
    let est_cost_usd;
    if (price === null || price === undefined) est_cost_usd = null;
    else if (typeof price === 'number') est_cost_usd = Math.round(((est_input_tokens + est_output_tokens) / 1000) * price * 10000) / 10000;
    else {
      const c = u && Number.isFinite(u.cost_usd) && u.cost_usd >= 0 ? u.cost_usd
        : (inT * price.input_per_1k + cr * price.cache_read_per_1k + cw * price.cache_write_per_1k + est_output_tokens * price.output_per_1k) / 1000;
      est_cost_usd = o.exact ? c : ceil4(c);
    }
    return { est_input_tokens, est_output_tokens, est_cost_usd };
  }

  /* ---------------------------------------------------------------- live stubs (documented, never called) */
  const LIVE_ENDPOINTS_TO_VERIFY = Object.freeze([
    { channel: 'email', capability: 'provider', note: 'G6c: Hostinger IMAP imap.hostinger.com:993 + SMTP smtp.hostinger.com:465, implicit TLS (TLS connect to both verified from Supabase staging 2026-11-03); 587 / STARTTLS refused (blocked on Supabase)' },
    { channel: 'email', capability: 'auth', note: 'mailbox password in Edge Function secrets MARSA_EMAIL_IMAP_* / MARSA_EMAIL_SMTP_* (owner only; no OAuth at Hostinger); one channel MARSA_EMAIL_LIVE_CHANNEL; Vault msg_email_credential:<channel_id> per channel is phase 2' },
    { channel: 'email', capability: 'send', note: 'SMTP 465 AUTH, From = MARSA_EMAIL_FROM_ADDRESS (the channel alias); Message-ID <MRSO-…@MARSA_EMAIL_MSGID_DOMAIN> as the idempotency key; envelope-only Bcc to the login mailbox' },
    { channel: 'email', capability: 'lookup_send', note: 'IMAP UID SEARCH HEADER Message-ID in INBOX (the Bcc copy) and Sent; not found → unsupported (a human decides)' },
    { channel: 'email', capability: 'status_events', note: 'DSN (multipart/report delivery-status) scanned in INBOX by its own cursor; bounced only when every recipient failed' },
    { channel: 'email', capability: 'attachments', note: 'inbound metadata only (BODYSTRUCTURE); outbound attachments refused; download into bucket messages is phase 2' },
    { channel: 'whatsapp', capability: 'account', note: 'WhatsApp Business Platform (Cloud API): phone-number id per org' },
    { channel: 'whatsapp', capability: 'webhook', note: 'webhook verify token + X-Hub-Signature-256 (secret in Vault msg_webhook_secret:<channel_id>)' },
    { channel: 'whatsapp', capability: 'status_events', note: 'message status webhooks sent / delivered / read / failed' },
    { channel: 'whatsapp', capability: 'templates', note: '24 h customer-service window and provider-approved template messages' },
    { channel: 'whatsapp', capability: 'attachments', note: 'media download' },
    { channel: 'whatsapp', capability: 'lookup_send', note: 'no idempotency key on send → lookup by biz_opaque_callback_data = request id' },
    { channel: 'whatsapp', capability: 'limits', note: 'rate limits and opt-in rules' }
  ]);

  function notConfigured(what) {
    return new AdapterError('not_configured', what + ' not configured (G6b staging: mock only)', { applied: 'no', code: 'not_configured' });
  }
  function stub(kind) {
    const a = { mode: 'live', kind };
    for (const m of CHANNEL_METHODS) a[m] = async function () { throw notConfigured('live ' + kind + ' adapter'); };
    return Object.freeze(a);
  }
  // G6c (review H1): the factory is passed explicitly (config.impl) so Node tests reach the real path; the call-time
  // globalThis lookup is the Deno fallback only. Without connect + imap + smtp + a factory → the not_configured stub.
  function createLiveEmailAdapter(config) {
    const c = config || {};
    const g = typeof globalThis === 'object' && globalThis.MarsaInbox ? globalThis.MarsaInbox.createImapSmtpEmail : null;
    const impl = typeof c.impl === 'function' ? c.impl : (typeof g === 'function' ? g : null);
    if (!impl || typeof c.connect !== 'function' || !c.imap || typeof c.imap !== 'object' || !c.smtp || typeof c.smtp !== 'object') return stub('email');
    const cfg = Object.assign({}, c);
    delete cfg.impl;
    return impl(cfg);
  }
  function createLiveWhatsAppAdapter(config) { void config; return stub('whatsapp'); }
  // createLlmProvider(config): with config.callModel AND an explicit factory (config.impl = llm-provider.js
  // createModelProvider, passed by index.ts / the tests; same rule as createLiveEmailAdapter, review H1) → the model-backed
  // provider; otherwise the documented stub whose every method throws not_configured (settings.ai_provider 'llm_pending',
  // or 'claude' without a key / consent). Never reads a key, never calls fetch: callModel is injected.
  function createLlmProvider(config) {
    const c = config || {};
    if (typeof c.callModel === 'function' && typeof c.impl === 'function') {
      const cfg = Object.assign({}, c);
      delete cfg.impl;
      return c.impl(cfg);
    }
    const p = { name: 'llm_pending', version: 'stub' };
    for (const m of AI_METHODS) p[m] = function () { throw notConfigured('LLM provider'); };
    return Object.freeze(p);
  }

  const API = {
    CHANNEL_METHODS, WRITE_METHODS, CAPABILITY_KEYS, AI_METHODS, ERROR_KINDS, RETRYABLE_KINDS, LIMITS,
    AdapterError, isAdapterError,
    normalizeInbound, normalizeAddress, htmlToText, foldDigitsStr,
    redact, scrubText, sha256Hex, stableStringify, cpLen,
    estimateAiCost, AI_PRICES, AI_PROVIDER_MODELS,
    createLiveEmailAdapter, createLiveWhatsAppAdapter, createLlmProvider, LIVE_ENDPOINTS_TO_VERIFY
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();

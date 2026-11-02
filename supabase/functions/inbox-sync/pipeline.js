/*
  Marsa (مرسى) — G6b message pipeline (docs/online/G6B_SPEC.md § pipeline.js). Server-side only.
  Plain classic script (no import / export, no require). The adapter API is passed explicitly as `deps`.

  processMessage(ctx, provider, deps) → the `process` job effects:
    {message_id, extractions, classification, summary, risk_flags, suggested_template, ai_run}
    runs extract on the subject, the body and each attachment's extracted text; classify; summarize; detectInjection;
    cost estimate. Injection flags are SIDE OUTPUT: the classification / extraction / matching inputs exclude nothing
    because of a flag and include nothing from it.
  buildDraft(ctx, provider, deps) → the `draft` job effects:
    {reply_id, lang, subject, body_text, clarification, missing, used_facts, template_key, template_version, ai_run}
    The context (built by SQL from CONFIRMED data only) is the only input; recipients and attachments are never part
    of the effects (SQL sets them). used_facts ⊆ the fact keys the context offered.
*/
(function () {
  'use strict';

  const PIPELINE_VERSION = 'g6b-pipeline-1.0.0';
  const MAX_EXTRACTIONS = 100;
  const SUGGESTED_TEMPLATE = {
    telex_release: 'telex_release', delivery_order: 'delivery_order', freight_charges: 'freight_charges', empty_return: 'empty_return_instructions',
    missing_documents: 'missing_documents', violation: 'violation_response', general_inquiry: 'clarification', appointment: 'clarification'
  };

  function need(deps) {
    if (!deps || typeof deps.AdapterError !== 'function' || typeof deps.sha256Hex !== 'function') throw new Error('pipeline: deps (adapter API) required');
    return deps;
  }
  function validation(A, code, msg) { return new A.AdapterError('validation', msg || code, { applied: 'no', code }); }

  async function aiRun(A, provider, settings, inputObj, outputObj) {
    const input = A.stableStringify(inputObj);
    const output = A.stableStringify(outputObj);
    const input_chars = A.cpLen(input);
    const output_chars = A.cpLen(output);
    const est = A.estimateAiCost({ provider: provider.name, input_chars, output_chars });
    if (est.est_cost_usd === null) throw new A.AdapterError('not_configured', 'AI provider price unknown', { applied: 'no', code: 'not_configured' });
    const s = settings || {};
    const budget = Number(s.ai_monthly_budget_usd || 0);
    const mtd = Number(s.month_to_date_usd || 0);
    if (est.est_cost_usd > 0 && mtd + est.est_cost_usd > budget) {
      throw new A.AdapterError('validation', 'AI monthly budget exceeded', { applied: 'no', code: 'ai_budget' });
    }
    return {
      provider: provider.name, provider_version: String(provider.version || '').slice(0, 40), input_sha256: await A.sha256Hex(input),
      input_chars, output_chars, est_input_tokens: est.est_input_tokens, est_output_tokens: est.est_output_tokens, est_cost_usd: est.est_cost_usd
    };
  }

  async function processMessage(ctx, provider, deps) {
    const A = need(deps);
    const m = ctx && ctx.message;
    if (!m || !m.id) throw validation(A, 'message', 'process: no message in the context');
    if (!provider || typeof provider.extract !== 'function') throw validation(A, 'provider', 'process: no AI provider');
    const subject = typeof m.subject === 'string' ? m.subject : '';
    const body = typeof m.body_text === 'string' ? m.body_text : '';
    const atts = Array.isArray(m.attachments) ? m.attachments : [];

    // extraction: subject, body, each attachment's extracted text (never the file name)
    const all = [];
    all.push(...provider.extract(subject, { source: 'subject' }));
    all.push(...provider.extract(body, { source: 'body' }));
    for (const a of atts) {
      if (a && a.id && typeof a.extracted_text === 'string' && a.extracted_text) all.push(...provider.extract(a.extracted_text, { source: 'attachment', attachment_id: a.id }));
    }
    const seen = new Set();
    const extractions = [];
    for (const e of all) {
      const key = e.kind + '|' + e.normalized + '|' + e.span.source + '|' + e.span.start;     // UNIQUE (message_id, kind, normalized, source, span_start)
      if (seen.has(key)) continue;
      seen.add(key);
      extractions.push(e);
      if (extractions.length >= MAX_EXTRACTIONS) break;
    }

    const classifyBody = [body].concat(atts.map(a => (a && typeof a.extracted_text === 'string') ? a.extracted_text : '')).join('\n');
    const classification = provider.classify({ subject, body: classifyBody, extractions });

    // injection / foreign-address detection over everything the message carries (flags only)
    const scanText = [subject, body].concat(atts.map(a => String((a && a.file_name) || '') + '\n' + String((a && a.extracted_text) || ''))).join('\n');
    const participants = [].concat(m.participants || [], m.from && m.from.address_norm ? [m.from.address_norm] : [],
      (m.to || []).map(x => (typeof x === 'string' ? x : (x && (x.address_norm || x.address)))), ctx.channel && ctx.channel.address_norm ? [ctx.channel.address_norm] : [])
      .filter(Boolean).map(x => String(x).toLowerCase());
    const inj = provider.detectInjection(scanText, { participants, directory: m.directory_addresses || [] });
    const risk_flags = [];
    const flag = f => { if (f && !risk_flags.includes(f)) risk_flags.push(f); };
    (inj.flags || []).forEach(flag);
    if (extractions.some(e => e.kind === 'container_no' && !e.valid)) flag('invalid_check_digit');
    if (extractions.some(e => e.kind === 'date' && e.detail && e.detail.ambiguous)) flag('ambiguous_date');

    const sender = m.sender || { display_name: m.sender_display_name || null, status: m.sender_status || null };
    const lang = (ctx.settings && ctx.settings.default_lang) === 'en' ? 'en' : 'ar';
    const summary = provider.summarize({ category: classification.category, extractions, sender, flags: risk_flags, lang, sent_at: m.sent_at || null,
      topic_rules: (ctx.instructions && ctx.instructions.topic_rules) || [] });

    const out = {
      message_id: m.id,
      extractions,
      classification,
      summary,
      risk_flags,
      suggested_template: SUGGESTED_TEMPLATE[classification.category] || null
    };
    out.ai_run = await aiRun(A, provider, ctx.settings,
      { v: PIPELINE_VERSION, subject, body, attachments: atts.map(a => ({ id: a.id, file_name: a.file_name || null, extracted_text: a.extracted_text || null })) },
      { extractions, classification, summary, risk_flags });
    return out;
  }

  function factKeys(facts) {
    const f = facts || {};
    const keys = [];
    for (const part of ['public', 'restricted']) if (f[part] && typeof f[part] === 'object') keys.push(...Object.keys(f[part]));
    return keys;
  }

  async function buildDraft(ctx, provider, deps) {
    const A = need(deps);
    const d = ctx && ctx.draft;
    if (!d || !d.thread_id) throw validation(A, 'draft', 'draft: no draft context');
    if (!provider || typeof provider.draftReply !== 'function') throw validation(A, 'provider', 'draft: no AI provider');
    const r = provider.draftReply({
      lang: d.lang, template_key: d.template_key, template: d.template, params: d.params || {}, recipient: d.recipient || {},
      facts: d.facts || {}, category: d.category || null, org_name: d.org_name || null
    });
    const offered = factKeys(d.facts);
    const used_facts = (r.used_facts || []).filter(k => offered.includes(k));
    const out = {
      reply_id: d.reply_id || null,
      lang: r.lang,
      subject: r.subject,
      body_text: r.body_text,
      clarification: !!r.clarification,
      missing: r.missing || [],
      used_facts,
      template_key: r.template_key,
      template_version: r.template_version === undefined ? null : r.template_version
    };
    out.ai_run = await aiRun(A, provider, ctx.settings,
      { v: PIPELINE_VERSION, draft: { lang: d.lang, template_key: d.template_key, template: d.template || null, params: d.params || {}, recipient: d.recipient || {}, facts: d.facts || {}, category: d.category || null } },
      { subject: out.subject, body_text: out.body_text, missing: out.missing, used_facts });
    return out;
  }

  const API = { processMessage, buildDraft, PIPELINE_VERSION };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();

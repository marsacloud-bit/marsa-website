// Marsa (مرسى) — AI document reading Edge Function (Claude, model claude-opus-5-5). Migration 20261114000100_ai_documents.sql.
// SOURCE ONLY — NOT DEPLOYED. Until the owner deploys it and sets ANTHROPIC_API_KEY, ocr.html shows the AI mode only
// to staff of an org whose admin enabled it, and every call ends with `not_configured` / a network error.
//
// - POST only (OPTIONS = CORS preflight). CORS: https://marsacloud.com, and http://127.0.0.1[:port] for local dev only.
// - The caller sends THEIR user access token (Authorization: Bearer <access token>; supabase-js functions.invoke does).
//   It is verified with supabase-js auth.getUser on a client built with the anon / publishable key, then the same
//   user client calls public.ai_access(org) — staff roles only, the MFA rule of app.has_role (an admin-only member needs
//   an aal2 session) — and reads the optional transaction under the caller's own RLS.
// - Body: {org_id, doc_type: bill_of_lading | commercial_invoice | customs_declaration | supplier_invoice | auto,
//   file: {media_type: image/jpeg | image/png | image/webp | image/gif | application/pdf, data_b64}, transaction_id?, lang?,
//   prompt_version?: 'ai-doc-v3' (20261119000100: + doc_type packing_list, extended keys, containers; the same file already
//   read with v3 and saved is returned without a Claude call or a charge — reused: true; 20261121000100: + doc_type
//   appointment_ticket (needs transaction_id) / empty_return_receipt (≤ 8 MB); a wrong document → 422 wrong_document_type),
//   reading_mode?: 'full' (default) | 'quick' (2026-11-14, v3 shipping documents / auto: the key facts and a compact item
//   table only — extract.js QUICK_KEYS; the answer says reading_mode 'quick')}
//   Images up to 5 MB, PDFs up to 10 MB (decoded); the media type must match the file's magic bytes. The body is read
//   with a byte limit (also when chunked, without content-length).
// - Usage: a service client calls public.ai_reserve(org, user, 'doc_extract', held estimate) (enabled + consent, daily
//   cap, monthly budget) BEFORE Claude is called, and public.ai_settle(id, tokens, status, model, attempts) after,
//   whatever happened ('unknown' — timeout / connection lost / 5xx — charges the held amount).
// - The request path is handler.js (classic script, injected clients, Node-tested); request / schema / parsing /
//   validation live in extract.js. Refusal fallbacks on (betas server-side-fallback-2026-07-01, fallbacks 'default');
//   stop_reason is checked before the content is read.
// - Timing: the response must start within Supabase's 150 s request idle timeout (wall clock 400 s). Claude is
//   streamed (client.beta.messages.stream → finalMessage) with maxRetries 0; the SDK timeout (135 s) covers the wait
//   for the response headers, and handler.js aborts the whole streamed call after claudeTimeoutMs (135 s, and at most
//   145 s after the request started), so getUser + ai_access + reserve + the Claude call + settle end inside the 150 s
//   (a retry could outlive it, be billed twice and leave the reservation to the 15-minute sweep). Shipping documents
//   use max_tokens 32000 (measured: an ~85-line scanned invoice, 13.4k output tokens in 92 s).
// - Secrets: the provider keys (saved on the platform page in Vault, read with the service RPC ai_provider_keys; else the
//   Edge Function secrets) live in index.ts only, go to the SDK client / the request header only, never logged, never
//   returned, never sent to handler.js. Errors are fixed codes; upstream / SDK messages are never echoed.
// - Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY), SUPABASE_SERVICE_ROLE_KEY (all injected by
//   Supabase), ANTHROPIC_API_KEY (owner-entered Edge Function secret).
//   OPENAI_API_KEY / GEMINI_API_KEY (optional, owner-entered secrets, 21 Nov 2026): the other reading providers, tried
//   in the order the organisation chose; a provider without its key is skipped.

import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './extract.js';
import './handler.js';

// deno-lint-ignore no-explicit-any
const X: any = (globalThis as any).MarsaAiExtract;

const CLAUDE_TIMEOUT_MS = 135000;                // one attempt, no retry: inside the 150 s request idle timeout

// Other providers (owner, 21 Nov 2026): OpenAI and Gemini, tried in the organisation's order (ai_access → providers).
// Keys (owner, 22 Nov 2026): entered on the platform page and kept in Supabase Vault (migration 20261209000100); read
// per request through the service RPC ai_provider_keys into this request's `keys` only — never logged, never returned,
// never handed to handler.js (it gets booleans). The Edge Function secrets ANTHROPIC_API_KEY / OPENAI_API_KEY /
// GEMINI_API_KEY stay as a fallback when no key is saved on the page. The addresses below are the only ones called.
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PROVIDERS = ['anthropic', 'openai', 'gemini'];
const TEST_TIMEOUT_MS = 20000;

// one HTTPS JSON call → {status, json} (json only on a 2xx answer). No retry; the response is never logged.
async function httpJson(url: string, init: RequestInit, ms: number): Promise<{ status: number; json: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let json: unknown = null;
    if (r.ok) { try { json = JSON.parse(text); } catch (_e) { json = null; } }
    return { status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (!X || typeof X.handleRequest !== 'function') {
    return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  // this request's keys: the Edge Function secrets first, replaced by the keys saved on the platform page (loadKeys)
  const keys: Record<string, string> = {
    anthropic: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    openai: Deno.env.get('OPENAI_API_KEY') ?? '',
    gemini: Deno.env.get('GEMINI_API_KEY') ?? '',
  };
  const ready = () => ({ anthropic: keys.anthropic !== '', openai: keys.openai !== '', gemini: keys.gemini !== '' });
  const service = () => createClient(url, serviceKey, opts);

  // the keys saved for this organisation (its own, else the platform's; org null = the platform's) → booleans only
  async function loadKeys(org: string | null): Promise<Record<string, boolean>> {
    try {
      const r = await service().rpc('ai_provider_keys', { p_org: org });
      const d = r && !r.error && r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : {};
      for (const p of PROVIDERS) { const v = d[p]; if (typeof v === 'string' && v !== '') keys[p] = v; }
    } catch (_e) { /* the secrets stay */ }
    return ready();
  }

  // one reading call to OpenAI / Gemini → {status, json}. Rejects with {notSent: true} when nothing was sent, or with
  // the abort / network error (the call may have run).
  async function send(provider: string, model: string, body: unknown, o: { deadlineMs: number }): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let target = '';
    if (!MODEL_ID.test(model) || !(Number.isFinite(o.deadlineMs) && o.deadlineMs > 0)) throw { notSent: true };
    if (provider === 'openai' && keys.openai !== '') { target = OPENAI_URL; headers['authorization'] = 'Bearer ' + keys.openai; }
    else if (provider === 'gemini' && keys.gemini !== '') { target = GEMINI_URL + model + ':generateContent'; headers['x-goog-api-key'] = keys.gemini; }
    else throw { notSent: true };
    return await httpJson(target, { method: 'POST', headers, body: JSON.stringify(body) }, o.deadlineMs);
  }

  // the connection test of the platform page: list the provider's models with the saved key → {status, models}
  async function listModels(provider: string): Promise<{ status: number; models: string[] }> {
    if (provider === 'anthropic') {
      if (keys.anthropic === '') return { status: 0, models: [] };
      try {
        const out: string[] = [];
        const page = await new Anthropic({ apiKey: keys.anthropic, maxRetries: 0, timeout: TEST_TIMEOUT_MS }).models.list({ limit: 100 });
        for (const m of page.data) if (m && typeof m.id === 'string') out.push(m.id);
        return { status: 200, models: out };
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        const st = (e as any) && Number.isInteger((e as any).status) ? (e as any).status : 599;
        return { status: st, models: [] };
      }
    }
    let target = '';
    const headers: Record<string, string> = {};
    if (provider === 'openai' && keys.openai !== '') { target = OPENAI_MODELS_URL; headers['authorization'] = 'Bearer ' + keys.openai; }
    else if (provider === 'gemini' && keys.gemini !== '') { target = GEMINI_MODELS_URL; headers['x-goog-api-key'] = keys.gemini; }
    else return { status: 0, models: [] };
    try {
      const r = await httpJson(target, { method: 'GET', headers }, TEST_TIMEOUT_MS);
      // deno-lint-ignore no-explicit-any
      const j: any = r.json || {};
      const list = provider === 'openai'
        ? (Array.isArray(j.data) ? j.data.map((m: { id?: unknown }) => m && m.id) : [])
        : (Array.isArray(j.models) ? j.models.filter((m: { supportedGenerationMethods?: unknown }) => m && Array.isArray(m.supportedGenerationMethods)
            && (m.supportedGenerationMethods as unknown[]).includes('generateContent')).map((m: { name?: unknown }) => m && typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null) : []);
      return { status: r.status, models: list.filter((x: unknown) => typeof x === 'string') };
    } catch (_e) {
      return { status: 599, models: [] };
    }
  }

  const r = await X.handleRequest(req, {
    configured: !!(url && anonKey && serviceKey),
    isAnonKey: (t: string) => t === anonKey,
    userClient: (token: string) => createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } }),
    serviceClient: service,
    modelConfigured: keys.anthropic !== '',
    claudeClient: () => new Anthropic({ apiKey: keys.anthropic, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS }),
    claudeTimeoutMs: CLAUDE_TIMEOUT_MS,           // the whole streamed call (headers + body), see handler.js
    sdk: Anthropic,
    ready: { openai: keys.openai !== '', gemini: keys.gemini !== '' },
    loadKeys,
    send,
    listModels,
    log: (text: string) => console.error(text),
  });
  return new Response(r.body, { status: r.status, headers: r.headers });
});

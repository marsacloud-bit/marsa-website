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
//   file: {media_type: image/jpeg | image/png | image/webp | image/gif | application/pdf, data_b64}, transaction_id?, lang?}
//   Images up to 5 MB, PDFs up to 10 MB (decoded); the media type must match the file's magic bytes. The body is read
//   with a byte limit (also when chunked, without content-length).
// - Usage: a service client calls public.ai_reserve(org, user, 'doc_extract', held estimate) (enabled + consent, daily
//   cap, monthly budget) BEFORE Claude is called, and public.ai_settle(id, tokens, status, model, attempts) after,
//   whatever happened ('unknown' — timeout / connection lost / 5xx — charges the held amount).
// - The request path is handler.js (classic script, injected clients, Node-tested); request / schema / parsing /
//   validation live in extract.js. Refusal fallbacks on (betas server-side-fallback-2026-07-01, fallbacks 'default');
//   stop_reason is checked before the content is read.
// - Timing: maxRetries 0 and a 100 s timeout, so getUser + ai_access + reserve + the Claude call + settle end inside the
//   150 s wall clock (a retry could outlive it, be billed twice and leave the reservation to the 15-minute sweep).
// - Secrets: ANTHROPIC_API_KEY is read here only (Deno.env), passed to the SDK client only, never logged, never returned,
//   never sent to the database or to handler.js. Errors are fixed codes; upstream / SDK messages are never echoed.
// - Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY), SUPABASE_SERVICE_ROLE_KEY (all injected by
//   Supabase), ANTHROPIC_API_KEY (owner-entered Edge Function secret).

import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './extract.js';
import './handler.js';

// deno-lint-ignore no-explicit-any
const X: any = (globalThis as any).MarsaAiExtract;

const CLAUDE_TIMEOUT_MS = 100000;                // one attempt, no retry: inside the 150 s wall clock

Deno.serve(async (req: Request): Promise<Response> => {
  if (!X || typeof X.handleRequest !== 'function') {
    return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

  const r = await X.handleRequest(req, {
    configured: !!(url && anonKey && serviceKey),
    isAnonKey: (t: string) => t === anonKey,
    userClient: (token: string) => createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } }),
    serviceClient: () => createClient(url, serviceKey, opts),
    modelConfigured: apiKey !== '',
    claudeClient: () => new Anthropic({ apiKey, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS }),
    sdk: Anthropic,
    log: (text: string) => console.error(text),
  });
  return new Response(r.body, { status: r.status, headers: r.headers });
});

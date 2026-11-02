# G5 — Daftra integration & invoicing (staging spec)

Source: execution plan §G5 «المرحلة السادسة: تكامل دفترة والفوترة», steps ١–١٣. Goal: prepare correct Daftra invoice **drafts** from approved G4 client charges and pull their status back, **with no duplicate invoice, no duplicate line and no blind overwrite of the official document**. Exit gate (plan step ١٣): «مزامنة صحيحة بلا ازدواج».
Read first: `docs/online/ARCHITECTURE.md`, `docs/online/G4_SPEC.md` (incl. "As built"), `docs/online/G3_SPEC.md`, `docs/online/G2_SPEC.md` (conventions, idempotency). Staging only.

**G5 builds on G4 and never duplicates it.** The sell side stays `client_charges` (G4 §8); its status `invoiced` (reserved by G4, `g5_only`) is set **only** by G5. The billing client is `public.clients` (`transactions.client_id`), *not* `parties` (parties are suppliers / carriers / operators; G3 `kinds` has no client kind). Service codes are G4 `fin_service`; charge kinds are G4 `client_charges.kind`. No cost, accrual, allocation or margin logic changes.

## Owner-control rule: no real Daftra (binding)
- **No real Daftra account, no network call, no API key, anywhere** (code, tables, tests, docs, fixtures).
- Every Daftra interaction goes through a **provider adapter** (`supabase/functions/daftra-sync/adapter.js`) with two implementations:
  - `mock` — deterministic fake Daftra account (`mock-adapter.js`) that models clients, products, invoice drafts, issued invoices, accountant manual edits, lost responses / timeouts, payments. **The only adapter used in G5.**
  - `live` — a documented stub (`createRealAdapter`) that throws `AdapterError{kind:'not_configured'}` from every method and lists the Daftra endpoints to verify later (§ "Real adapter: endpoints to verify"). Plan step ٢ «إثبات الإمكانات من الحساب المعني؛ لا التخمين» stays an **open issue** until the owner provides a real account.
- **Secrets are never stored in G5.** The per-org connection row holds status / mode / capabilities only. A future live key lives in Supabase Vault (`vault.secrets`, name `daftra_api_key:<org_id>`) or Edge Function secrets and is read only by the server-side worker; no table readable by staff or clients ever holds it (tested: no column named like `%key%|%secret%|%token%|%password%` in G5 tables, and `app.bill_redact` strips such keys from every logged request / response).
- The Edge Function `supabase/functions/daftra-sync/` is **source only, not deployed**. Until the owner deploys it, jobs queued from the staging UI stay `queued` (the UI says so).

## Binding rules (apply to every item below)
- One migration: `supabase/migrations/20261105000100_g5_daftra.sql`. Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS), applies on the LIVE staging DB that already holds G2 + G3 + G4 data.
- Every `SECURITY DEFINER` function: `SET search_path = ''`, auth check first, errors via `app.fail('MRS_*', detail)` (or `app.fin_fail` with a HINT), `REVOKE … FROM PUBLIC, anon, authenticated`, then `GRANT EXECUTE` to **`authenticated`** (staff RPCs) or **`service_role`** only (worker RPCs). `app.*` helpers stay revoked (policy helpers called by RLS get `GRANT … TO authenticated`, like `app.fin_can_read_invoice`).
- **Worker RPC auth:** first statement `IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;` and EXECUTE granted to `service_role` only. Staff can never call them (tested), and the worker can never call staff RPCs meaningfully (`auth.uid()` NULL → `MRS_AUTH_REQUIRED`).
- Composite FKs `(x_id, org_id)` / `(x_id, transaction_id)` everywhere; RLS on every table; branch scope through the parent transaction (`app.has_tx_role`); org-level rows (connection, client links, item links, org-level jobs) through `app.has_role(org_id, fin_read)`.
- No direct table writes from the API (`REVOKE ALL`, `GRANT SELECT` to authenticated only where a policy exists). No DELETE anywhere. Removal = state change with a reason.
- **Append-only sync history:** `billing_sync_attempts` rows are inserted at claim and closed exactly once at completion (trigger refuses any other UPDATE and every DELETE).
- Audit via the existing `app.tg_audit` trigger on every new table **except** `billing_sync_attempts` (it is itself the append-only history; its `calls` payloads must not be copied into `audit_log`) and `daftra_mock_accounts`. `updated_at` via `app.touch_updated_at`.
- Create / request RPCs are idempotent (`p_idem_key uuid DEFAULT NULL` + `app.idem_begin / app.idem_finish`, scope = RPC name, org resolved before the call).
- Money `numeric(14,2)` (≥ 0), quantity `numeric(14,3)`, VAT rate `numeric(5,2)`, currency `char(3) CHECK (~ '^[A-Z]{3}$')`.
- `transaction_events`: new event type `'billing'` (superset of the G4 list). `visible_to_client=false`, payload `{op, entity, id, …ids}`, **never amounts, never Daftra numbers' totals, never request/response bodies**.

## Open G0 decisions (default applied in this build; each one goes into the G5 report)
| # | Decision | Default applied |
|---|---|---|
| G5-1 | **Invoice timing** (step ٥ «وفق التوقيت المعتمد») | A billing intent is created **manually** by finance (`fin_write`) at any operational stage, once ≥ 1 approved charge exists in that currency. Nothing is created automatically. The UI recommends it from `operationally_complete`. No link to empty return (step ١١ «الفاتورة قد تسبق إعادة الفارغ»): container returns are never checked. |
| G5-2 | **Consolidation** | **One invoice per transaction per currency** (purpose `final`). Late charges after issue go to a `supplementary` intent (`S1`, `S2`…). Optional `interim` intents (`I1`…) before the final. **No per-client period consolidation** in G5 (deferred). |
| G5-3 | **VAT on reimbursables** | The G4 charge `vat_rate` is binding for the line (G4-2: 0 for `reimbursable`, 15 for services). Item mappings for `reimbursable:*` default to `tax_code='out_of_scope'` (disbursement as agent). A reimbursable line with rate > 0 is a warning (`reimbursable_taxed`), not a block. To confirm with a tax advisor (step ١١). |
| G5-4 | **Who issues** | **The accountant issues inside Daftra.** Marsa only creates / updates **drafts**; it never calls an issue endpoint (`invoices.issue` capability is not used even if present). Push = `fin_write` at the tx branch. Conflict overwrite, review resolutions and cancelling an intent = `fin_approve` (note required). Connection, catalog and tax settings = `bill_admin` (`accounts_manager`, `admin`). |
| G5-5 | Source of truth | **Daftra is the source of truth** for the official document (number, status, totals, payments). G4 `charge_collections` stay evidence only; both are shown side by side, never merged. |
| G5-6 | Client visibility | Clients see **nothing from G5** (no SELECT policy, no RPC result, portal unchanged). Exposing the issued Daftra invoice in the portal is deferred (owner decision). |
| G5-7 | `transactions.financial_status` | Driven by G5, **forward only**: any live intent with a remote draft → `draft_pending`; any issued intent → `invoiced`; every issued intent paid and no open / draft intent left → `settled`. Never moved backwards automatically. The G2 placeholder RPC `set_financial_status` stays unchanged. |
| G5-8 | Connection mode | Per org: `mock` (default) or `live_pending`. `live_pending` makes every job fail with `not_configured` (no network). |
| G5-9 | Operational references | Invoice: `<tx.ref>/<purpose_key>[-<CUR>][-R<n>]` (e.g. `MRS-2026-000123/F`). Line: `MRSL-<16 hex of line id>`. Client: `MRSC-<client id>`. Product code: `MRS-<kind>-<service_code|none>`. The Daftra field that carries each reference must be proven on the real account (open issue). |
| G5-10 | Client drift | Name / billing-info differences are **shown for review, never auto-overwritten** in either direction. Pushing local data to Daftra = `fin_approve`. |
| G5-11 | FX | No conversion. One intent per currency. Multi-currency support in the Daftra account must be verified (open issue). |

## Roles
- Reuse G4: `app.fin_read_roles()` (read every G5 row of the scope), `app.fin_write_roles()` (create intents, add / remove lines, link clients, request push / pull / retry), `app.fin_approve_roles()` (resolve conflicts, resolve review items, cancel intents, accept client drift push).
- **New** `app.bill_admin_roles()` = `accounts_manager, admin` (IMMUTABLE): connection settings, probe, item / tax catalog, unlink a client. Checked org-level with `app.has_role(org, …)`.
- Client roles: nothing. `operations_manager`, `clearance_staff`, `transport_staff`: nothing (not in fin_read).
- UI role sets (admin.js `R` + app-shell.js `R`, mirrored): reuse `finRead / finWrite / finApprove`; add `billAdmin: ['accounts_manager','admin']` and add it to `OPS_SETS`.

## Data model (migration `20261105000100_g5_daftra.sql`)

**Section P — preflight (read-only, before any DDL).**
- Stop if `schema_versions` lacks `20261104000100`: `RAISE EXCEPTION 'G5 preflight: apply G4 first (schema_versions lacks 20261104000100 g4_costs)'`.
- Stop if any `client_charges` row has `status='invoiced'` (impossible before G5; the guard proves G4 kept its promise): `'G5 preflight: client_charges already invoiced outside G5'`. On a re-run this check is skipped when the `20261105000100` row already exists.
- Then `INSERT INTO schema_versions ('20261105000100','g5_daftra') ON CONFLICT DO NOTHING`.

**Section 0 — dictionaries and helpers.**
- `status_labels` (all `client_visible=false`, ar + en, upserted). Domains:
  - `daftra_mode` (`mock` «محاكاة تجريبية», `live_pending` «حساب حقيقي — غير مُعدّ»);
  - `daftra_conn_status` (`not_connected` «غير متصل», `connected` «متصل», `error` «خطأ», `disabled` «موقوف»);
  - `daftra_link_status` (`pending` «بانتظار المزامنة», `linked` «مربوط», `drift` «اختلاف بيانات», `needs_review` «يحتاج مراجعة», `error` «خطأ», `unlinked` «مفكوك»);
  - `daftra_tax_code` (`standard` «خاضع للنسبة الأساسية», `zero` «نسبة صفرية», `exempt` «معفى», `out_of_scope` «خارج النطاق (مبلغ مسترد)»);
  - `daftra_capability` (keys of the capability record below);
  - `bill_purpose` (`final` «فاتورة نهائية», `interim` «فاتورة مرحلية», `supplementary` «فاتورة إضافية»);
  - `bill_intent_status` (`open` «قيد الإعداد», `draft` «مسودة في دفترة», `issued` «صادرة», `cancelled` «ملغاة»);
  - `bill_sync_state` (`idle` «لم تُرسل», `pending` «تغييرات بانتظار الإرسال», `in_flight` «قيد الإرسال», `synced` «متزامنة», `unknown` «نتيجة غير معروفة», `conflict` «تعارض», `error` «خطأ»);
  - `bill_line_state` (`pending_add` «بانتظار الإضافة», `synced` «في المسودة», `pending_remove` «بانتظار الحذف», `removed` «محذوف»);
  - `bill_job_kind` (`probe`, `client_ensure`, `client_refresh`, `client_push`, `item_ensure`, `invoice_push`, `invoice_pull`);
  - `bill_job_status` (`queued` «في الانتظار», `running` «قيد التنفيذ», `unknown` «بانتظار المطابقة», `done` «تمت», `conflict` «تعارض», `failed` «فشلت», `dead` «استنفدت المحاولات», `cancelled` «أُلغيت»);
  - `bill_review_kind` (`late_charge` «مبلغ لاحق بعد الإصدار», `issued_mismatch` «الفاتورة الصادرة تختلف», `issued_cancelled` «أُلغيت الفاتورة في دفترة»);
  - `bill_review_status` (`open`, `resolved`, `dismissed`);
  - `daftra_payment_status` (`unknown`, `unpaid`, `partial`, `paid`).
- `transaction_events_event_type_check` recreated as a superset: the full G4 list + `'billing'`.
- Helpers (all revoked from everyone unless stated): `app.bill_admin_roles()`; `app.bill_redact(jsonb)` (recursively drops keys for which `app.bill_secret_key` is true — `(?i)(api[_-]?key|secret|token|password|passwd|authorization|cookie|credential|access[_-]?key|private[_-]?key|jwt|session)` or exactly `pass|pwd|auth|bearer|x-auth` —, masks the value of `[name, value]` header pairs, scrubs every string value with `app.bill_scrub_text` (URL query strings, `name=value` / `name: value` secrets, bearer / basic credentials → `[redacted]`), truncates strings > 4000 chars; `app.bill_error` scrubs `message` and `code` the same way, and so do capability evidence and the completion's exception text; mirrored by `redact` / `scrubText` in worker.js); `app.bill_event(org, tx, op, entity, id, extra)` (like `app.fin_event`, type `'billing'`, never amounts); `app.bill_service_only()`; `app.bill_client_snapshot(public.clients)` → jsonb `{name, name_en, vat_number, cr_number, address_short, address, email, phone}` (trimmed, empty → null; `address` = the national address object rendered as one line); `app.bill_item_key(kind, service_code)` → `'<kind>:<service_code|none>'`; `app.bill_tx_financial(p_tx)` (G5-7 recompute, writes a `financial_status` event, forward only); `app.bill_can_read_job(public.billing_sync_jobs)` (GRANT to authenticated, used by RLS).

### 1. `daftra_connections` — one per org (step ١)
- **Columns:**
  - `id, org_id` (FK organizations, `UNIQUE (org_id)`, `UNIQUE (id, org_id)`);
  - `mode text DEFAULT 'mock' CHECK IN ('mock','live_pending')`;
  - `status text DEFAULT 'not_connected' CHECK IN daftra_conn_status`;
  - `subdomain text CHECK (~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')` — placeholder only (e.g. `marsa-demo`), never used for a call in G5; **one Daftra account per org**: partial unique index `daftra_connections_subdomain_uidx ON (lower(subdomain)) WHERE subdomain IS NOT NULL`, `save_daftra_connection` → `MRS_INVALID 'subdomain_taken'` (the other org is never named; the migration stops loudly if a duplicate already exists);
  - `sync_enabled boolean DEFAULT false` (claim skips the org's jobs, probe excepted, while false);
  - `capabilities jsonb DEFAULT '{}'` (`{<capability>: {supported bool, evidence text ≤300, checked_at}}`), `capabilities_checked_at timestamptz`, `capabilities_source text CHECK IN ('mock','live')`;
  - `last_check_at, last_check_status ('ok','failed'), last_error_code text ≤60, last_error_message text ≤500`;
  - tax / billing settings (step ١١): `default_service_vat_rate numeric(5,2) DEFAULT 15`, `allowed_vat_rates numeric(5,2)[] DEFAULT '{0,15}'`, `reimbursable_tax_code text DEFAULT 'out_of_scope'` (daftra_tax_code), `invoice_notes text ≤500` (footer sent on every draft);
  - `created_by`, `updated_by`, timestamps.
- **No secret columns** (tested). The live key location is documented, never stored.
- Rows are created lazily by `save_daftra_connection` (upsert on `org_id`). A missing row = `not_connected`.
- **Never mix orgs:** every job, link and intent carries `org_id`; the worker builds one adapter per `org_id` from that org's connection only (`adapterFor(connection)`); mock accounts are keyed by `org_id` (§ Worker). Tested with two orgs.
- `status` transitions are written only by the worker completion of a `probe` job (`connected` on success, `error` on failure) and by `save_daftra_connection` (`disabled` when `sync_enabled` false and mode changes; `not_connected` after a mode change, which forces a new probe).

### 2. Capability probe (step ٢)
- No separate table: the probe is a job of kind `probe` (`request_daftra_probe`). Its attempt keeps every adapter call (request / response). Completion writes `daftra_connections.capabilities`, `capabilities_checked_at`, `capabilities_source` (= the adapter mode), `last_check_*`, `status`.
- **Capability keys** (fixed list, `daftra_capability` domain):
  `clients.search_by_ref`, `clients.read`, `clients.create`, `clients.update`, `products.search_by_code`, `products.search_by_name`, `products.create`, `invoices.create_draft`, `invoices.read`, `invoices.search_by_reference`, `invoices.update_draft`, `invoices.line_reference_field`, `invoices.version_token`, `invoices.multi_currency`, `invoices.issue` (never used, G5-4), `payments.read`, `credit_notes.create` (never used).
- The mock probe reports every key `supported:true` except `invoices.issue` and `credit_notes.create` (`false`), with `evidence:'mock'`.
- **Push gate:** `request_billing_push` requires `status='connected'`, `sync_enabled`, and `supported:true` for `invoices.create_draft, invoices.read, invoices.search_by_reference, invoices.update_draft, clients.search_by_ref, clients.create, products.search_by_code, products.create` (`MRS_BAD_TRANSITION 'capability'`, hint = the missing keys). The UI shows the capability table with «مُثبتة على حساب تجريبي (محاكاة) — لم تُثبت على حساب دفترة حقيقي».
- Real probing on a real Daftra account = **open issue** (owner action).

### 3. `daftra_client_links` — client mapping (step ٣)
- **Columns:**
  - `id, org_id, client_id` (FK `(client_id, org_id)` → clients), `UNIQUE (id, org_id)`;
  - `client_ref text NOT NULL` = `'MRSC-' || client_id` (immutable, trigger);
  - `external_id text CHECK (~ '^[A-Za-z0-9_.:-]{1,64}$')` (Daftra client id, NULL until found / created);
  - `status` (daftra_link_status) `DEFAULT 'pending'`;
  - `pushed_snapshot jsonb` (what Marsa sent or adopted, `app.bill_client_snapshot` shape), `remote_snapshot jsonb` (last read, same shape, normalized by the adapter), `drift text[]` (computed, see below), `drift_detected_at`;
  - `candidates jsonb` (for `needs_review`: `[{external_id, name, vat_number}]`, ≤ 10);
  - `last_synced_at, last_error_code, last_error_message`;
  - `linked_by, linked_at, unlinked_by, unlinked_at, unlink_reason`, `created_by`, timestamps.
- **Uniqueness (per org, never across orgs):** `UNIQUE (org_id, client_id) WHERE status <> 'unlinked'`; `UNIQUE (org_id, external_id) WHERE external_id IS NOT NULL AND status <> 'unlinked'` (one Daftra client ↔ one Marsa client; a second link → `MRS_INVALID 'external_id_taken'`, hint = the other link id).
- **Drift** (`app.bill_client_drift(link)` → text[]; recomputed at every completion touching the link and by `list_daftra_client_links`): `local:<field>` for every key where `app.bill_client_snapshot(client)` ≠ `pushed_snapshot`; `remote:<field>` where `remote_snapshot` ≠ `pushed_snapshot`. Non-empty → `status='drift'` (only from `linked`; it returns to `linked` when the drift is resolved).
- **Never auto-overwrite.** Drift is a warning: invoicing continues against the linked Daftra client. Resolution (`resolve_client_drift`, fin_approve org-level, note required):
  - `push_local` → enqueue `client_push` (updates the Daftra client with the local snapshot; requires `clients.update`), then `pushed_snapshot := local`, `remote_snapshot := read-back`;
  - `acknowledge` → `pushed_snapshot := remote_snapshot` merged with the local fields the user keeps; the Marsa client row is **never** changed by G5 (staff edit it in `#client/<id>` if they want).
  - For `needs_review`: `choose` (`p_external_id` ∈ candidates → linked, then `client_refresh`) or `create_new` (enqueue `client_ensure` with `force_create:true`; still searches by `client_ref` first).
- **Ensure algorithm (worker, `client_ensure` / inline in `invoice_push`):** `findClientByRef(client_ref)` → found = adopt (`found_by:'ref'`). Else `findClientsByVat(vat_number)` (when set) → any hit = outcome `conflict`, link `needs_review` with `candidates` (never a silent second client, never a silent adoption by VAT). Else `createClient` → read back → linked. A lost response on create is `unknown`; the retry repeats `findClientByRef` first.
- Manual link (`link_daftra_client(p_client, p_external_id)`): `status='pending'`, `external_id` set, enqueue `client_refresh` (reads the remote, stores `remote_snapshot`; `pushed_snapshot := remote_snapshot`; drift computed against local).

### 4. `daftra_item_links` — service / item catalog mapping (step ٤)
- **Columns:**
  - `id, org_id`, `UNIQUE (id, org_id)`;
  - `item_key text NOT NULL` = `app.bill_item_key(kind, service_code)`: `kind ∈ ('service','internal_service','reimbursable')` × G4 `fin_service` code or `none` (CHECK through `app.bill_check_item_key`);
  - `product_code text NOT NULL` = `'MRS-' || replace(item_key, ':', '-')` (immutable);
  - `name_ar text (2..160)`, `name_en text ≤160` — canonical names from the dictionaries: `fin_service` label, plus « — مبلغ مسترد» / « — خدمة داخلية» for the other kinds; `none` → «خدمات أخرى» / «Other services»;
  - `default_vat_rate numeric(5,2)`, `tax_code` (daftra_tax_code): defaults `service` / `internal_service` → `default_service_vat_rate` + `standard`; `reimbursable` → 0 + `reimbursable_tax_code`;
  - `external_product_id text (same CHECK as external ids)`, `status ('pending','linked','needs_review','error','retired') DEFAULT 'pending'`, `candidates jsonb`, `last_synced_at, last_error_code, last_error_message`, `updated_by`, timestamps.
- **Unique mapping rule:** `UNIQUE (org_id, item_key) WHERE status <> 'retired'` and `UNIQUE (org_id, external_product_id) WHERE external_product_id IS NOT NULL AND status <> 'retired'`. One key ↔ one Daftra product; no product shared by two keys; no second product for a key.
- **No duplicate products with different names** (worker): `findProductByCode(product_code)` → adopt. Else `findProductsByName(name_ar)` (normalized: trim, collapse spaces, Arabic folding like `app.fin_norm_no` letters) → any hit with another code → outcome `conflict`, item `needs_review` with candidates (the user maps it manually with `save_daftra_item(…, {external_product_id})`). Else `createProduct({code, name_ar, name_en, tax_code, vat_rate})`.
- Rows are created lazily: `list_daftra_items` returns every possible key (mapped or not, with defaults); `request_billing_push` inserts `pending` rows for the keys its lines need.
- The **line** VAT always comes from the charge (G4 binding). The item tax setting is only the product default (G5-3).

### 5. `billing_intents` — billing purpose / invoice intent «غرض الفوترة» (steps ٥, ٦)
- **Columns:**
  - `id, org_id, transaction_id` (FK `(transaction_id, org_id)`), `client_id` (FK `(client_id, org_id)`, = `transactions.client_id` at creation, immutable), `UNIQUE (id, org_id)`, `UNIQUE (id, transaction_id)`;
  - `purpose` (bill_purpose) `DEFAULT 'final'`, `purpose_key text NOT NULL` (`F`, `I1`, `I2`…, `S1`, `S2`…, assigned by the RPC), `currency char(3) DEFAULT 'SAR'`, `revision int DEFAULT 1`;
  - `operational_ref text NOT NULL` (G5-9 format, ≤ 60, immutable) with `UNIQUE (org_id, operational_ref)` over **all** rows (a cancelled intent's ref is never reused: the next one gets `-R2`);
  - `status` (bill_intent_status) `DEFAULT 'open'`, `sync_state` (bill_sync_state) `DEFAULT 'idle'`;
  - remote mirror: `external_invoice_id text` (`UNIQUE (org_id, external_invoice_id) WHERE external_invoice_id IS NOT NULL`), `daftra_number text ≤60`, `daftra_status text ≤40` (raw), `remote_version text ≤64`, `pushed_hash text (^[0-9a-f]{64}$)`, `remote_hash text`, `pushed_at`, `last_pulled_at`, `last_synced_at`;
  - remote figures (from Daftra, the official ones): `remote_net, remote_vat, remote_total numeric(14,2)`, `payment_status` (daftra_payment_status) `DEFAULT 'unknown'`, `paid_amount numeric(14,2)`, `last_payment_at`;
  - local figures (Σ live lines, trigger-maintained): `lines_net, lines_vat, lines_total numeric(14,2) DEFAULT 0`;
  - `conflict jsonb` (`{reason:'remote_edited'|'remote_missing'|'external_in_use', diff:[{line_ref|null, field, pushed, remote}], detected_at}`), `last_error_code, last_error_message`;
  - `issued_at`, `cancelled_by/at, cancel_reason`, `note ≤2000`, `created_by`, timestamps.
- **One draft per purpose + source:** `UNIQUE (transaction_id, currency, purpose_key) WHERE status <> 'cancelled'`. A second `final` → `MRS_INVALID 'intent_taken'` (hint = existing id). `supplementary` requires an issued `final` of the same tx + currency (`MRS_BAD_TRANSITION 'no_issued_final'`); `interim` requires no issued `final` (`'final_issued'`).
- **Operational identity (step ٦):** `operational_ref` is fixed at creation and is the reference sent to Daftra. Before **every** create (first push, retry, reconcile, recreate) the worker calls `findInvoiceByReference(operational_ref)`; a hit is adopted, never duplicated. A double click on «إرسال إلى دفترة» returns the same live job (`dedupe_key`), and `p_idem_key` replays the first result.
- **Lifecycle:**
  - `open` → `draft` when a completion records `external_invoice_id` with a remote draft;
  - `open | draft` → `issued` when a pull / push reads a non-draft, non-cancelled remote status (frozen, step ١٠);
  - `open` → `cancelled` (`cancel_billing_intent`, fin_approve, reason) only with no `external_invoice_id`, `sync_state NOT IN ('in_flight','unknown','conflict')` and **no unreconciled possibly-applied write** (`app.bill_unreconciled`: an `invoice_push` attempt that ended `unknown` / `abandoned` / `lease_lost` with no later `ok` / `frozen` / `conflict` attempt, unless a later push job ended `done`); otherwise `MRS_BAD_TRANSITION 'remote_draft_exists'` / `'sync_in_flight'` / `'conflict_open'` / `'unreconciled_remote'` (way out: `retry_billing_job`, whose reference lookup settles it). `draft` → `cancelled` only through conflict resolution `release` after the remote draft is gone (`remote_missing`).
  - `issued` is terminal for G5 edits (no line add / remove / push: `MRS_BAD_TRANSITION 'intent_issued'`); pulls continue for payment status.
- **sync_state** is written by the RPCs (`pending` after a local change on a pushed intent, `in_flight` at claim) and by completion (`synced`, `unknown`, `conflict`, `error`). After a completion, if lines are still `pending_add` / `pending_remove` (added during the flight) → `pending`.

### 6. `billing_intent_lines` — eligible lines with a unique operational reference (step ٨)
- **Columns:**
  - `id, org_id, transaction_id` (FK `(transaction_id, org_id)`), `intent_id` (FK `(intent_id, transaction_id)` → billing_intents), `charge_id` (FK `(charge_id, transaction_id)` → client_charges), `UNIQUE (id, org_id)`;
  - `line_ref text NOT NULL` = `'MRSL-' || upper(substr(replace(id::text,'-',''),1,16))`, `UNIQUE (org_id, line_ref)`;
  - snapshot at add time (immutable): `item_key, description, quantity, unit_price, net_amount, vat_rate, vat_amount, total_amount, currency`, `kind`, `service_code`;
  - `state` (bill_line_state) `DEFAULT 'pending_add'`, `pushed boolean DEFAULT false` (true once any completion reports it on the remote), `remote_line_id text`, `remote_override jsonb` (accountant values kept after `keep_remote`), `removed_reason`, `removed_by/at`, `added_by`, timestamps.
- **No double billing:** `UNIQUE (charge_id) WHERE state <> 'removed'` — a charge sits on at most one live line, across all intents.
- **Eligibility** (`add_billing_lines`): charge `status='approved'`, same transaction, same currency as the intent, not on a live line. `p_charge_ids NULL` = all eligible. A non-eligible id → `MRS_INVALID 'not_eligible'` (hint = the id). Other-currency approved charges are listed in `checks.other_currency` (they need their own intent).
- **No blind deletion** (`remove_billing_line`, fin_write, reason required, intent `open | draft` only): a line never pushed, with no running / unknown job on the intent, intent `sync_state NOT IN ('in_flight','unknown')` and nothing unreconciled (`app.bill_unreconciled`) → `removed` at once; otherwise `pending_remove`. The worker removes **only that `line_ref`** from the remote draft, and only if the remote line still equals the pushed snapshot (else conflict). Remote lines without a Marsa `line_ref` (added by the accountant) are **never** removed or changed.
- **Charge guard** — trigger `app.tg_bill_charge_guard` BEFORE UPDATE ON `client_charges`:
  - a charge on a live line cannot leave `approved` (`MRS_BAD_TRANSITION 'in_invoice'`), so G4 `set_charge_status` (approved → draft / void) is refused while it is billed;
  - `status → 'invoiced'` only with the transaction-local flag `marsa.bill_invoiced = on`, set only by the completion path (`app.bill_mark_issued`).
- Line → transaction mapping is structural (FK `(intent_id, transaction_id)` + `(charge_id, transaction_id)`): a line can never point at another transaction's charge (tested).

### 7. `billing_sync_jobs` — outbox (steps ٦, ٧, ١٢)
- **Columns:**
  - `id, org_id`, `UNIQUE (id, org_id)`;
  - `kind` (bill_job_kind), `intent_id` (FK `(intent_id, org_id)`), `client_link_id` (FK `(…, org_id)`), `item_link_id` (FK `(…, org_id)`); CHECK: `invoice_*` ⇒ intent_id; `client_*` ⇒ client_link_id; `item_ensure` ⇒ item_link_id; `probe` ⇒ none;
  - `dedupe_key text NOT NULL` (`'<kind>:<target id>'`, `'probe'`), unique partial index `(org_id, dedupe_key) WHERE status IN ('queued','running','unknown')`;
  - `options jsonb DEFAULT '{}'` (`{overwrite:true}`, `{recreate:true}`, `{force_create:true}`);
  - `status` (bill_job_status) `DEFAULT 'queued'`, `priority int` (probe 0, client / item 1, invoice_push 2, invoice_pull 3);
  - `attempts int DEFAULT 0`, `max_attempts int DEFAULT 5`, `next_run_at timestamptz DEFAULT now()`, `locked_by text ≤80`, `locked_until timestamptz`;
  - `expected_hash text` (set from an `unknown` outcome: the content hash the worker expected the remote to hold), `last_error_kind, last_error_code text ≤60, last_error_message text ≤500`;
  - `requested_by uuid` (NULL for scheduler jobs), `created_at`, `finished_at`, `updated_at`.
- **One running job per org** (lane = `org_id`): the claim skips an org that has a `running` job with a valid lease. This serializes find-then-create across intents, clients and items of the same Daftra account (no race creates a second client or product).
- **Retry policy (completion):** outcome `retry` → `status='queued'`, `next_run_at = now() + least(30s × 2^(attempts−1), 1h)`; when `attempts >= max_attempts` → `dead`. Outcome `failed` → `failed` (final: validation, not_configured). `unknown` → `status='unknown'`, `next_run_at = now() + 2 min` (reconcile delay). `conflict` → `conflict` (human). `retry_billing_job` (fin_write) moves `failed | dead` back to `queued` with `max_attempts = attempts + 3`.
- **Lease expiry:** a `running` job whose `locked_until < now()` is claimable again; its open attempt is closed `abandoned` and the job is treated as `unknown` (the next run starts with the reference lookup).
- **Scheduler:** `daftra_schedule_pulls(p_limit)` (service only) enqueues `invoice_pull` for intents with `external_invoice_id`, status `draft | issued`, `payment_status <> 'paid'`, and `last_pulled_at` NULL or older than 15 min (dedupe applies).
- **Cancel:** cancelling an intent marks its `queued` jobs `cancelled`.

### 8. `billing_sync_attempts` — append-only request / response log (step ٧)
- **Columns:** `id, org_id, job_id` (FK `(job_id, org_id)`), `attempt_no int`, `worker text ≤80`, `started_at DEFAULT clock_timestamp()`, `finished_at`, `outcome text CHECK IN ('ok','retry','failed','unknown','conflict','frozen','abandoned','lease_lost')` (NULL while open), `adapter_mode text ('mock','live')`, `calls jsonb DEFAULT '[]'` (array, ≤ 50 entries, `octet_length(calls::text) <= 262144`), `error jsonb`, `UNIQUE (job_id, attempt_no)`.
- Each call: `{op, at, ms, request, response, error:{kind, code, message, http_status}|null, applied:'yes'|'no'|'unknown'}`. `request` / `response` pass through `app.bill_redact` before insert.
- **Append-only:** trigger refuses DELETE, refuses UPDATE unless `OLD.outcome IS NULL` and only `finished_at, outcome, calls, error` change. No `trg_audit` on this table.
- «فقد الرد لا يعني فشل التنفيذ لدى دفترة»: an adapter error with `applied:'unknown'` (timeout after send, connection reset after write) makes the attempt outcome `unknown`, **never** `failed` / `retry`.

### 9. Read before update, manual-edit detection (step ٩)
- **Canonical content** (`adapter.canonicalInvoice(inv)` in `adapter.js`, the only definition): `{client_id, currency, lines:[{line_ref|null, product_id, description, quantity (3 dp string), unit_price (2 dp string), tax_rate (2 dp string)}]}` with lines sorted by `line_ref` (foreign lines without a ref after, sorted by their JSON). Totals, dates, numbers and version tokens are excluded. `contentHash(x)` = lowercase hex SHA-256 of the key-sorted JSON (`globalThis.crypto.subtle`, works in Deno and node ≥ 19). **SQL never computes this hash; it only stores and compares strings.**
- `pushed_hash` = hash of the canonical content **read back** after Marsa's last successful create / update (or adopted baseline).
- **Before any update** the worker calls `getInvoice(external_invoice_id)`:
  - not found → outcome `conflict`, reason `remote_missing`;
  - status not `draft` → outcome `frozen` (handled as a pull: issued, step ١٠);
  - `contentHash(canonical(remote)) ≠ pushed_hash` and no `options.overwrite` → outcome `conflict`, reason `remote_edited`, `diff` per line_ref / field (pushed snapshot vs remote), `remote_snapshot` stored. **No update is sent.**
  - otherwise the new line list = remote lines with Marsa's operations applied: keep foreign lines verbatim; keep owned synced lines as they are on the remote; append `pending_add` lines; drop `pending_remove` lines. If the result equals the remote → no update call (`ok`, no-op). Else `updateDraftInvoice(id, {lines, expected_version: remote_version})`, then read back → new `pushed_hash`.
- **Conflict resolution** (`resolve_billing_conflict(p_intent, p_decision, p_note)`, fin_approve at the tx branch, note required, `sync_state='conflict'` only):
  - `keep_remote` — accept the accountant's edits: `pushed_hash := remote_hash`; owned lines whose remote values differ get `remote_override`; `sync_state := pending` if lines are pending, else `synced`. Nothing is sent.
  - `overwrite_remote` — explicit, non-blind overwrite of the **Marsa-owned lines only** (foreign lines kept): enqueue `invoice_push` with `options.overwrite=true`. The worker still re-reads first and refuses if the remote is no longer a draft.
  - `recreate` (`remote_missing` only) — clear `external_invoice_id`, enqueue `invoice_push` with `options.recreate=true` (the worker still searches by `operational_ref` first).
  - `release` (`remote_missing` only) — intent `cancelled`, every live line `removed` (`removed_reason='released'`), charges stay `approved` (eligible again).
- `conflict.reason='external_in_use'`: a reference lookup found a Daftra invoice already linked to another intent → no adoption; human review (`release` or support).

### 10. Issued invoices are frozen (step ١٠)
- When a completion (pull, or push outcome `frozen`) reports a remote status other than `draft` / `cancelled` (normalized `remote_state='issued'`), `app.bill_mark_issued(intent, remote_snapshot)`:
  - `status := 'issued'`, `issued_at`, `daftra_number`, remote figures;
  - for every live line whose `line_ref` is on the remote issued invoice → line stays `synced` (frozen) and its charge → `invoiced` (flag `marsa.bill_invoiced`);
  - live lines **not** on the remote (pending_add, or removed by the accountant) → `removed` (`removed_reason='not_on_issued'`), charge stays `approved` → a `late_charge` review item;
  - remote content ≠ `pushed_hash` (edited before issue) → one `issued_mismatch` review item with the diff (Daftra wins; Marsa never edits an issued invoice);
  - `app.bill_tx_financial(tx)`; event `issued`.
- **No automatic edit of an issued invoice, ever.** Push on an issued intent → `MRS_BAD_TRANSITION 'intent_issued'`; the worker never calls `updateDraftInvoice` on a non-draft (re-checked on read).
- Remote issued → later `cancelled` in Daftra → `issued_cancelled` review item; charges stay `invoiced` until resolved.

### 11. `billing_review_items` — adjustment / credit-note review queue (step ١٠)
- **Columns:** `id, org_id, transaction_id` (FK), `intent_id` (FK `(intent_id, transaction_id)`), `charge_id` (FK `(charge_id, transaction_id)`, NULL for mismatch / cancelled), `kind` (bill_review_kind), `details jsonb` (diff, ids — no amounts copied into events), `status` (bill_review_status) `DEFAULT 'open'`, `resolution text`, `resolution_note`, `resolved_intent_id` (FK `(…, transaction_id)`), `resolved_by/at`, timestamps. Unique partial `(charge_id, kind) WHERE status = 'open'`.
- **Late charge trigger** `app.tg_bill_late_charge` (AFTER INSERT OR UPDATE OF status ON client_charges): a charge becoming `approved` on a transaction that has an `issued` intent of the same currency, and not on a live line → open `late_charge` item. Plus the items created by `app.bill_mark_issued`.
- **Resolution** (`resolve_billing_review(p_id, p_decision, p_note, p_intent DEFAULT NULL)`, fin_approve, note required):
  - `late_charge`: `supplementary` (p_intent = an `open | draft` supplementary intent of the same tx + currency; the charge is added as a line in the same call) or `dismiss` (charge stays approved and unbilled; the user may void it in G4);
  - `issued_mismatch`: `accept` (Daftra is the truth; owned lines get `remote_override`) or `credit_note_in_daftra` (records that the accountant handles a credit / debit note in Daftra; Marsa creates none);
  - `issued_cancelled`: `release_charges` (intent `cancelled`, lines `removed`, charges `invoiced → approved` with flag, financial status recomputed forward only — no backward move, a note is kept) or `dismiss`.
- An item whose charge later lands on a live line is auto-`resolved` (`resolution='billed'`).

### 12. Tax policy (step ١١) — notes + config, no blocking link
- The line VAT rate = the G4 charge `vat_rate`. Push refuses a line whose rate is not in `allowed_vat_rates` (`MRS_INVALID 'tax_rate_unmapped'`, hint = line refs). The mapping of a rate to a Daftra tax id is a real-account detail (open issue); the mock accepts the rate as is.
- `reimbursable` lines with rate > 0 → warning `reimbursable_taxed` in `checks` (not a block, G5-3).
- **No blocking operational link:** intent creation, push and issue never check container returns, trips, demurrage closure or `operational_status` (tested: an intent pushes while an empty return is pending).
- Policy notes shown in `#daftra` (static i18n text): official tax invoicing, timing, advance payments, refunds / reimbursables and item classification are confirmed with a tax specialist when needed; Marsa never issues the tax document.

### 13. Status pull (step ١٢)
- `invoice_pull` (manual `request_billing_pull`, or the scheduler) reads `getInvoice(external_invoice_id)` + `listPayments(id)` and completes with: `daftra_number`, `daftra_status`, normalized state (`draft | issued | cancelled`), `remote_hash`, remote figures, `payment {status, paid_amount, last_payment_at}`.
- Draft + hash ≠ `pushed_hash` → `sync_state='conflict'` (`remote_edited`) — detected on pull too, not only on push.
- Issued → `app.bill_mark_issued` (§10). Paid / partial → `payment_status`, `paid_amount`; `app.bill_tx_financial` (→ `settled` per G5-7). Every pull stamps `last_pulled_at`, `last_synced_at`; failures stamp `last_error_*` on the intent.
- The UI shows per invoice: Daftra number, Daftra status, collection info (paid / remaining from Daftra), last sync time, last error. The official figures shown are Daftra's (`remote_*`), next to Marsa's line totals; a difference is highlighted, never "fixed".

### 14. `daftra_mock_accounts` — DB-backed fake (staging demo only)
- `org_id uuid PRIMARY KEY` (FK organizations), `state jsonb NOT NULL`, `version int NOT NULL DEFAULT 1`, `updated_at`. RLS on, **no policy**, `REVOKE ALL` from anon / authenticated (service role only).
- Service RPCs `daftra_mock_load(p_org uuid)` → `{state, version}` (empty state when absent) and `daftra_mock_save(p_org uuid, p_state jsonb, p_version int)` (optimistic: `MRS_BAD_TRANSITION 'mock_version'` when the version moved). Used by `index.ts` in mock mode so a deployed staging function keeps a persistent fake account; node tests use the in-memory mock.

## Worker RPC contract (service role only)
### `daftra_claim_jobs(p_worker text, p_limit int DEFAULT 5)` → jsonb array
- Auth: `service_only`. `p_worker` 1..80 chars, `p_limit` 1..20.
- Picks, `FOR UPDATE SKIP LOCKED`, ordered by `priority, created_at`: jobs with `status IN ('queued','unknown') AND next_run_at <= now()`, or `running` with an expired lease; skipping orgs with a live lease (one per org) and orgs with `sync_enabled=false` (except `probe`). At most one job per org per call.
- For each: `status='running'`, `attempts += 1`, `locked_by=p_worker`, `locked_until=now()+5 min`; insert the attempt (`outcome NULL`); intent `sync_state='in_flight'` for `invoice_push`.
- Returns, per job, the **context** (the worker's only input; no other read):
```
{ job: {id, org_id, kind, attempt_no, options, expected_hash, previous_status},   // previous_status 'unknown' ⇒ reconcile first
  attempt_id,
  connection: {mode, status, subdomain, capabilities, settings:{default_service_vat_rate, allowed_vat_rates, reimbursable_tax_code, invoice_notes}},
  client?: {link_id, client_id, client_ref, external_id, status, data: <app.bill_client_snapshot>, pushed_snapshot},
  item?:   {link_id, item_key, product_code, external_product_id, name_ar, name_en, default_vat_rate, tax_code},
  intent?: {id, transaction_id, transaction_ref, operational_ref, currency, purpose, status, sync_state, external_invoice_id,
            pushed_hash, remote_version, invoice_date (today), notes,
            client: {…as client}, items: [{…as item} for every item_key on live lines],
            lines: [{line_id, line_ref, state, pushed, item_key, description, quantity, unit_price, vat_rate, net_amount, vat_amount, total_amount}] } }
```
  (`lines` = every non-`removed` line; `pending_remove` included so the worker can remove it.)

### `daftra_complete_job(p_attempt uuid, p_result jsonb)` → `{job_id, job_status, applied boolean}`
- Auth: `service_only`. The attempt must be open and its job `running` with `locked_by` = the attempt's worker; otherwise the attempt is closed `lease_lost`, its calls are kept, **nothing else is applied** (`applied:false`).
- `p_result` keys (`app.only_keys`): `outcome` (`ok|retry|failed|unknown|conflict|frozen`), `error` `{kind, code, message, http_status}`, `calls` (array as §8), `effects` (per kind, below), `expected_hash`.
- Validation: external ids `^[A-Za-z0-9_.:-]{1,64}$`, hashes `^[0-9a-f]{64}$`, money via `app.fin_money`, statuses from the fixed lists; anything else → `MRS_INVALID '<field>'` (the attempt is then closed `failed` with that error and the job goes `failed`).
- **Effects:**
  - `probe`: `{capabilities:{<key>:{supported, evidence}}, account:{currency?}}` → connection updated (§2).
  - `client_ensure | client_refresh | client_push`: `{client_link_id, external_id, found_by:'ref'|'created'|'manual'|'pushed', remote_snapshot, pushed_snapshot?}`; conflict: `{client_link_id, candidates:[…]}` → `needs_review`.
  - `item_ensure`: `{item_link_id, external_product_id, found_by, remote_snapshot}`; conflict: `{item_link_id, candidates}`.
  - `invoice_push`: `{intent_id, external_invoice_id, found_by:'ref'|'created'|'existing', daftra_status, remote_state, daftra_number?, remote_version, remote_hash, pushed_hash, remote_snapshot, remote_totals:{net, vat, total}, line_results:[{line_id, state:'synced'|'removed', remote_line_id}], clients:[client effects done inline], items:[item effects done inline]}`.
    - conflict: `{intent_id, reason, remote_hash, remote_snapshot, diff, external_invoice_id?}`; frozen: the `invoice_pull` effects; unknown: `{intent_id, external_invoice_id?}` + top-level `expected_hash`.
  - `invoice_pull`: `{intent_id, external_invoice_id, daftra_number, daftra_status, remote_state:'draft'|'issued'|'cancelled', remote_hash, remote_snapshot, remote_totals, payment:{status, paid_amount, last_payment_at}}`.
- Applying `line_results`: `pending_add → synced` (`pushed=true`); `pending_remove → removed` (only lines the worker reports removed); a line reported `synced` that is now `pending_remove` keeps `pending_remove` but gets `pushed=true`. Lines not reported are untouched.
- Every outcome writes the attempt (`finished_at`, `outcome`, redacted `calls`, `error`), the job status (retry policy §7), the target's `last_*` fields, and `billing` events for intents (`draft_synced`, `conflict`, `issued`, `paid`, `sync_failed`), with `actor` NULL.

### `daftra_schedule_pulls(p_limit int DEFAULT 50)` → `{enqueued}`; `daftra_mock_load` / `daftra_mock_save` (§14).
### `daftra_renew_lease(p_attempt uuid)` → `{job_id, locked_until}` (review fix: write fencing)
- Auth: `service_only`. Called by the worker right before **every** adapter write. The attempt must be open and its job `running`, held by the attempt's worker and attempt number, with an unexpired lease; the lease is extended by 5 minutes. Otherwise `MRS_BAD_TRANSITION 'lease_lost'` and the worker sends nothing (outcome `retry`, or `unknown` if an earlier write of the same run may have landed). Every adapter call is also capped at 60 s (a write that times out = `applied:'unknown'`).

## Staff RPC list (all `SECURITY DEFINER`, `search_path=''`, `authenticated` only)
Write RPCs return the row json (`app.bill_intent_json`, `app.bill_line_json`, `app.bill_job_json`, `app.bill_link_json`, `app.bill_item_json`), plus `from` on state changes and `deduplicated:true` when a live job was returned instead of a new one.

| RPC | Params | Role check | Idem | Event (`billing`) |
|---|---|---|---|---|
| `get_daftra_connection` | `(p_org uuid)` → `{connection (or defaults, exists:false), counts:{jobs_by_status, links_by_status, items_by_status}, push_ready bool, missing_capabilities[]}` | fin_read (org) | – | – |
| `save_daftra_connection` | `(p_org uuid, p_payload {mode, subdomain, sync_enabled, default_service_vat_rate, allowed_vat_rates, reimbursable_tax_code, invoice_notes})` | bill_admin | – | – |
| `request_daftra_probe` | `(p_org uuid, p_idem_key uuid)` → job | bill_admin | ✓ | – |
| `list_daftra_client_links` | `(p_org uuid, p_filters {status, q, billable_only bool, limit ≤200, offset})` → `{items:[link + client name / vat + drift], unlinked:[clients with approved charges and no link], total, counts}` | fin_read (org) | – | – |
| `link_daftra_client` | `(p_client uuid, p_external_id text DEFAULT NULL, p_idem_key uuid)` → `{link, job}` | fin_write (org) | ✓ | – |
| `refresh_daftra_client` | `(p_link uuid)` → job | fin_write (org) | – | – |
| `resolve_client_drift` | `(p_link uuid, p_decision text push_local\|acknowledge\|choose\|create_new, p_note text, p_external_id text DEFAULT NULL)` | fin_approve (org) | – | – |
| `unlink_daftra_client` | `(p_link uuid, p_reason text)` (refused while a non-cancelled intent of that client has an `external_invoice_id`: `'in_use'`) | bill_admin | – | – |
| `list_daftra_items` | `(p_org uuid)` → `{items:[every possible key with mapping or defaults], counts}` | fin_read (org) | – | – |
| `save_daftra_item` | `(p_org uuid, p_item_key text, p_payload {name_ar, name_en, default_vat_rate, tax_code, external_product_id, retire bool})` (manual `external_product_id` → `pending` + `item_ensure` verify job) | bill_admin | – | – |
| `create_billing_intent` | `(p_payload {transaction_id, purpose, currency, note, add_eligible bool DEFAULT true}, p_idem_key uuid)` → intent (+ lines) | fin_write @tx | ✓ | `intent_created` |
| `add_billing_lines` | `(p_intent uuid, p_charge_ids uuid[] DEFAULT NULL, p_idem_key uuid DEFAULT NULL)` (≤ 200) → `{intent, added:[line]}` | fin_write @tx | ✓ | `lines_added` |
| `remove_billing_line` | `(p_line uuid, p_reason text)` | fin_write @tx | – | `line_removed` |
| `request_billing_push` | `(p_intent uuid, p_idem_key uuid DEFAULT NULL)` → `{intent, job, deduplicated}` | fin_write @tx | ✓ | `push_requested` |
| `request_billing_pull` | `(p_intent uuid)` → job | fin_write @tx | – | – |
| `resolve_billing_conflict` | `(p_intent uuid, p_decision text keep_remote\|overwrite_remote\|recreate\|release, p_note text)` | fin_approve @tx | – | `conflict_resolved` |
| `cancel_billing_intent` | `(p_intent uuid, p_reason text)` | fin_approve @tx | – | `intent_cancelled` |
| `retry_billing_job` | `(p_job uuid)` (`failed \| dead` only) | fin_write (tx or org scope of the job); **bill_admin for `probe` / `item_ensure`** | – | – |
| `list_billing_intents` | `(p_org uuid, p_filters {status, sync_state, transaction_id, client_id, branch_id, payment_status, q (ref / operational_ref / daftra_number / client name), limit ≤200, offset})` → `{items:[intent + tx ref + client name + branch_id + line_count], total, counts:{by_status, by_sync_state, by_payment_status}}` | fin_read (rows by tx scope) | – | – |
| `get_billing_intent` | `(p_id uuid)` → `{intent, transaction:{id, ref, branch_id, operational_status, financial_status}, client:{id, name_ar, link}, lines[], eligible_charges[], jobs[] (last 10 + last attempt summary), review_items[], checks:{client_link, items_unmapped[], tax_rate_unmapped[], reimbursable_taxed[], other_currency[], capabilities_missing[]}, can:{edit, push, pull, resolve, cancel}}` | fin_read @tx | – | – |
| `list_billing_jobs` | `(p_org uuid, p_filters {status, kind, intent_id, limit ≤200, offset})` → `{items, total, counts}` | fin_read (job scope) | – | – |
| `get_billing_job` | `(p_id uuid)` → `{job, attempts:[attempt with redacted calls]}` | fin_read (job scope) | – | – |
| `billing_review_queue` | `(p_org uuid, p_filters {branch_id, kind})` → `{late_charges[], issued_mismatch[], issued_cancelled[], conflicts[] (intents), unknown[] (intents), failed_jobs[], client_drift[], client_review[], item_review[], counts}` | fin_read | – | – |
| `resolve_billing_review` | `(p_id uuid, p_decision text, p_note text, p_intent uuid DEFAULT NULL)` | fin_approve @tx | – | `review_resolved` |
| `tx_billing` | `(p_tx uuid)` → `{intents:[intent + lines], eligible_charges[], review_items[], financial_status, connection:{status, mode, sync_enabled}}` | fin_read @tx (`MRS_NOT_FOUND` invisible, `MRS_FORBIDDEN 'finance'` without fin role, via `app.fin_tx_read`) | – | – |

- Payload keys checked with `app.only_keys` (+ `idempotencyKey`); `app.puuid / ptext / pnum`, `app.fin_money`, `app.fin_currency`, `app.fin_note`.
- **Lock order:** transaction (`app.g3_lock_tx`) → intent → lines → charges → job. Completion locks intent → lines → charges in the same order. **The worker RPCs follow it too:** `daftra_complete_job` reads the attempt / job unlocked, locks transaction → intent, then attempt → job; `daftra_claim_jobs` takes the intent row with `FOR UPDATE SKIP LOCKED` (a busy intent is claimed on a later run); a deadlock / serialization failure (`40P01` / `40001`) inside the completion is re-raised, never recorded as a validation failure.
- Job scope (RLS + RPCs): intent jobs → `has_tx_role(intent.transaction_id, fin_read)`; org-level jobs (probe, client, item) → `has_role(org, fin_read)`. Attempts follow their job.
- **Errors:**
  - existing codes: `MRS_AUTH_REQUIRED, MRS_NOT_FOUND, MRS_FORBIDDEN ('role','finance','service_only'), MRS_INVALID, MRS_REQUIRED, MRS_BAD_TRANSITION, MRS_NOTE_REQUIRED, MRS_TOO_LONG`, idempotency codes;
  - details: `MRS_BAD_TRANSITION` `'not_connected'`, `'capability'`, `'intent_issued'`, `'in_invoice'`, `'sync_in_flight'`, `'conflict_open'`, `'remote_draft_exists'`, `'no_issued_final'`, `'final_issued'`, `'in_use'`, `'mock_version'`, `'g5_only'` (G4, still valid for staff); `MRS_INVALID` `'intent_taken'`, `'external_id_taken'`, `'not_eligible'`, `'currency'`, `'tax_rate_unmapped'`, `'item_key'`; `MRS_REQUIRED` `'lines'`, `'client'` (tx without client), `'client_review'` (link `needs_review`), `'item_review'`;
  - **no new MRS code** (hints carry ids as in G4 "As built").
- **Audit:** `trg_audit` on `daftra_connections, daftra_client_links, daftra_item_links, billing_intents, billing_intent_lines, billing_sync_jobs, billing_review_items` (+ existing on `client_charges`, `transactions`). `trg_touch` on the tables with `updated_at`.
- **Grants:** all tables `REVOKE ALL FROM anon, authenticated`, `GRANT SELECT TO authenticated` except `daftra_mock_accounts` (nothing). `billing_sync_attempts` SELECT through its job policy (staff may see redacted calls). Service RPCs: `GRANT EXECUTE … TO service_role` only.

## Edge Function `supabase/functions/daftra-sync/` (source, not deployed)
All of `adapter.js`, `mock-adapter.js`, `worker.js` are **plain classic scripts** (no `import` / `export`, no `require` of other files), ES2020, no dependencies. Each ends with
`(typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaDaftra = Object.assign(globalThis.MarsaDaftra || {}, API));`
so node tests `require()` them and Deno loads them by side-effect import (`import './adapter.js'`, then read `globalThis.MarsaDaftra`). Load order: adapter → mock-adapter → worker. **Binding:** the mock and worker factories take the adapter API explicitly as `deps` (node: `const A = require('./adapter.js'); createMockAdapter({ deps: A, … })`); they never read another file or a global themselves.

### `adapter.js` → `{ ADAPTER_METHODS, CAPABILITY_KEYS, AdapterError, canonicalInvoice, contentHash, normalizeClient, normalizeName, createRealAdapter, REAL_ENDPOINTS_TO_VERIFY }`
- `AdapterError(kind, message, {code, http_status, applied})` with `kind ∈ 'timeout' | 'network' | 'http_5xx' | 'rate_limited' | 'validation' | 'not_found' | 'conflict' | 'not_configured'` and `applied ∈ 'no' | 'unknown' | 'yes'`. Worker mapping: `applied:'unknown'` → outcome `unknown`; `timeout|network|http_5xx|rate_limited` with `applied:'no'` → `retry`; `validation|not_configured` → `failed`; `not_found` → handled per step.
- **Adapter interface** (all `async`, plain JSON in / out):
  - `probe()` → `{capabilities:{<key>:{supported, evidence}}, account:{currency}}`;
  - `findClientByRef(ref)` → client|null; `findClientsByVat(vat)` → client[]; `getClient(id)`; `createClient({ref, name, name_en, vat_number, cr_number, address, address_short, email, phone})`; `updateClient(id, data)`;
  - `findProductByCode(code)` → product|null; `findProductsByName(name)` → product[]; `createProduct({code, name_ar, name_en, tax_code, vat_rate})`;
  - `findInvoiceByReference(ref)` → invoice[] (array: the worker treats > 1 as `conflict` `external_in_use`/duplicate evidence, never picks silently); `getInvoice(id)` → invoice|throws not_found; `createDraftInvoice({reference, client_id, currency, date, notes, lines:[{line_ref, product_id, description, quantity, unit_price, tax_rate}]})`; `updateDraftInvoice(id, {lines, expected_version})`; `listPayments(invoiceId)` → `[{amount, date}]`.
  - Invoice shape: `{id, reference, client_id, currency, status:'draft'|'issued'|'cancelled', number|null, version, lines:[{id, line_ref|null, product_id, description, quantity, unit_price, tax_rate}], totals:{net, vat, total}, payment:{status, paid_amount, last_payment_at}}`.
- `createRealAdapter(config)` returns an object implementing every method by throwing `AdapterError('not_configured', 'Daftra live adapter not configured (G5 staging: mock only)', {applied:'no'})`. It never reads a key, never calls `fetch`.

### `mock-adapter.js` → `{ createMockAdapter }`
`createMockAdapter({ orgId, clock = () => fixed ISO time, state = null, deps: adapterApi })` → adapter + `control`:
- deterministic ids per account: clients `c-1…`, products `p-1…`, invoices `inv-1…`, invoice lines `l-1…`; issue numbers `INV-000001…`; `version` increments on every change;
- **does not enforce unique references** (like an API we have not verified): duplicates are possible and countable, so tests prove that the worker prevents them;
- `control.failNext(op, kind, {applied})` (one-shot, queued), `control.offline(bool)` (every call throws `network`, `applied:'no'`), `control.loseResponse(op)` (applies the operation, then throws `timeout` with `applied:'unknown'`);
- accountant actions: `control.editInvoice(id, mutate)` (manual edit of a draft: change a line price / add a foreign line / delete a line), `control.issueInvoice(id)` (assigns the number, status `issued`), `control.cancelInvoice(id)`, `control.deleteDraft(id)`, `control.addPayment(id, amount, date)`, `control.renameClient(id, name)`;
- inspection: `control.state()` (deep copy, JSON-serializable), `control.calls` (log of `{op, args}`), `control.count(kind, predicate)`.
- `issueInvoice` refuses `updateDraftInvoice` afterwards (`AdapterError('conflict','not a draft')`). `expected_version` mismatch → `AdapterError('conflict','version')`.

### `worker.js` → `{ createWorker, runJob }`
`createWorker({ rpc, adapterFor, workerId, clock, deps: adapterApi })`:
- `rpc(name, args)` → Promise of the RPC jsonb (Deno: supabase-js service client; tests: PGlite as `service_role`);
- `adapterFor(connection, orgId)` → adapter (mock per org / real stub). Tests pass a map `orgId → mock`, proving no cross-org use;
- `worker.runOnce({limit})` → `{claimed, ok, retry, failed, unknown, conflict, frozen}`: `daftra_claim_jobs` → for each context `runJob` → `daftra_complete_job`. Each adapter call is wrapped to record `{op, at, ms, request, response, error, applied}` into `calls` (the worker also redacts).
- `runJob(ctx, adapter)` per kind, **binding algorithms**:
  - `probe`: `adapter.probe()`.
  - `client_*` / `item_ensure`: §3 / §4 ensure algorithms (lookup first, candidates → conflict, create last).
  - `invoice_push`:
    1. ensure the client link and every needed item inline (same lookups);
    2. if `previous_status='unknown'` or no `external_invoice_id` (or `options.recreate`): `findInvoiceByReference(operational_ref)` — exactly 1 hit not linked elsewhere → adopt (`found_by:'ref'`) then continue at 3; > 1 → `conflict` (`external_in_use`, all ids in diff); 0 → `createDraftInvoice` with all `pending_add` + `synced` lines → `getInvoice` read-back → `ok`;
    3. with an id: read before update (§9), then update or no-op, read back → `ok`; with `expected_hash` from an unknown update: remote hash = expected → `ok` (it was applied), = `pushed_hash` → re-apply, else `conflict`.
  - `invoice_pull`: `getInvoice` + `listPayments` → pull effects; not found → `conflict` `remote_missing`.
- Any `AdapterError` maps as above; an unexpected exception → outcome `retry` with `error.kind='worker'`.

### `index.ts` (Deno, not deployed)
- `Deno.serve`: accepts only `POST` with header `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (compared in constant time); creates a supabase-js client (`npm:@supabase/supabase-js@2.45.4`) with `SUPABASE_URL` + service key from env; loads the three scripts by side-effect import; `adapterFor`: `mock` → `createMockAdapter` with state from `daftra_mock_load`, saved after the run with `daftra_mock_save`, and **only when `MARSA_DAFTRA_ALLOW_MOCK=1`**; `live_pending` → `createRealAdapter` (throws `not_configured`). Calls `daftra_schedule_pulls` then `runOnce({limit: 5})`; returns the counts JSON. Intended trigger: Supabase scheduled function every minute (not set up).

### Real adapter: endpoints to verify (`REAL_ENDPOINTS_TO_VERIFY`, open issue)
Listed as data, never called. Each item = `{capability, method, path, note}`; to prove on the real account (plan step ٢) before any live use:
- auth header and key scope per account (`APIKEY` header vs OAuth), subdomain base URL `https://<subdomain>.daftra.com/api2/…`, rate limits;
- clients: list / search by our reference (`client_number`?) and by VAT, `GET /api2/clients/{id}`, `POST /api2/clients`, `PUT /api2/clients/{id}`;
- products: search by code / name, `POST /api2/products`, tax assignment (tax ids for 15 % / 0 % / exempt / out of scope);
- invoices: create as **draft**, a field that stores `operational_ref` and is searchable, a per-item field for `line_ref`, `GET /api2/invoices/{id}` (status, number, items, totals), `PUT` on a draft (replace vs merge of items), a version / `modified` token, multi-currency;
- payments: invoice payments list / paid amount;
- whether the API can refuse updates on issued invoices (Marsa never relies on it: it re-reads first).

## Front end
### MarsaApi (supa.js): names are fixed
`{data, error}`; idempotent calls use `idemRpc` (key kept across retries; `opts.idemKey`). Demo mode → `MRS_DEMO_MODE`. `p_org` = the active org.
- **Connection & mappings:** `getDaftraConnection()`, `saveDaftraConnection(p)`, `requestDaftraProbe(opts)`, `listDaftraClientLinks(f)`, `linkDaftraClient(clientId, externalId, opts)`, `refreshDaftraClient(linkId)`, `resolveClientDrift(linkId, decision, note, externalId)`, `unlinkDaftraClient(linkId, reason)`, `listDaftraItems()`, `saveDaftraItem(itemKey, p)`.
- **Intents & lines:** `createBillingIntent(p, opts)`, `listBillingIntents(f)`, `getBillingIntent(id)`, `addBillingLines(intentId, chargeIds, opts)`, `removeBillingLine(lineId, reason)`, `requestBillingPush(intentId, opts)`, `requestBillingPull(intentId)`, `resolveBillingConflict(intentId, decision, note)`, `cancelBillingIntent(intentId, reason)`.
- **Queue & review:** `listBillingJobs(f)`, `getBillingJob(id)`, `retryBillingJob(jobId)`, `billingReviewQueue(f)`, `resolveBillingReview(id, decision, note, intentId)`, `txBilling(txId)`.
- The service RPCs (`daftra_*`) are **never** exposed in MarsaApi.
- Arabic + English messages for `MRS_FORBIDDEN 'service_only'` and the details `not_connected, capability, intent_issued, in_invoice, sync_in_flight, conflict_open, remote_draft_exists, no_issued_final, final_issued, in_use, intent_taken, external_id_taken, not_eligible, tax_rate_unmapped, client_review, item_review`.

### Module hook and files
- Hook unchanged: `window.MarsaOps = { views:{}, txSections:[] }`. Bill modules reuse `MarsaOps.ui` (ops/alerts.js) and `MarsaOps.finKit()` (fin/invoices.js, loaded before them).
- Original design only (admin.html `page-hero` + `.adm-app`, in-page nav `#adm-nav` from `MarsaShell.navItems()`): `card`, `card-stat adm-tile`, `table.table.table-striped.adm-table` in `.table-wrap`, `badge badge-*`, `btn`, `form-control`, `adm-dialog`, `adm-loading`. textContent / createElement only (request / response JSON shown in `<pre>` via textContent). `node --check` every touched JS file.
- Script order in admin.html: … `fin/*.js` → `bill/billing.js, bill/daftra.js, bill/tx-bill.js` → `admin.js`; `assets/i18n/bill.js` after `fin.js`; `assets/css/pages/bill.css` after `fin.css`.
- **Views** (all `allow: 'finRead'`; write buttons only for `can('finWrite', branchId)`, approve buttons for `can('finApprove', branchId)`, settings for `can('billAdmin')`):

| Route | File | Label (ar / en) | Content |
|---|---|---|---|
| `#billing` | `assets/js/bill/billing.js` | الفوترة ودفترة / Billing & Daftra | Banner when the connection is `mock` («وضع المحاكاة — لا اتصال بدفترة حقيقية») or not connected. KPI tiles: قيد الإعداد، بانتظار الإرسال، تعارضات، نتائج غير معروفة، صادرة، مسددة. Intents table (operational ref LTR, tx ref link, client, purpose, currency, Marsa total, Daftra number / status, payment, sync-state badge, last sync). Filters. «غرض فوترة جديد» dialog (find tx by ref → purpose → currency → add eligible). |
| `#billing/<intentId>` | same | تفاصيل الفاتورة التشغيلية / Invoice intent | Header (operational ref, tx link, client + link status, Daftra number / status / payment, last sync, last error); checks panel (client link, unmapped items, tax rates, reimbursable taxed, other currency, missing capabilities); lines table (line_ref LTR, description, qty, price, VAT, total, state badge, remote override note) + remove (reason); eligible charges with add; buttons «إرسال إلى دفترة» (disabled with the reason from `can` / checks; shows «في الانتظار — لم يُشغَّل العامل» while queued), «تحديث الحالة من دفترة», «إلغاء»; conflict panel (diff table pushed vs Daftra, decisions with note); review items; jobs + attempts history (calls in collapsible `<pre>`). |
| `#billing/queue` | same | طابور المزامنة والمراجعة / Sync queue & review | `list_billing_jobs` with status / kind filters + retry; `billing_review_queue` sections: late charges (supplementary / dismiss), issued mismatches, cancelled in Daftra, conflicts, unknown results, client drift / review, item review. |
| `#daftra` | `assets/js/bill/daftra.js` | إعداد دفترة / Daftra settings | Tab «الاتصال»: mode badge, status, subdomain placeholder, sync enabled, last check, capabilities table («مُثبتة بالمحاكاة فقط»), probe button, tax settings (default service VAT, allowed rates, reimbursable tax code, invoice notes) and the static tax-policy notes (step ١١); a fixed note that no API key is stored here. Tab «العملاء»: links table (status / drift badges, drift fields local vs Daftra), unlinked billable clients, link / refresh / resolve. Tab «الأصناف»: every item key with product code, names, tax, external id, status; edit (bill_admin). |

- **Transaction-detail section** (`assets/js/bill/tx-bill.js`, namespace `billtx`, id `bill-invoices`, order 90) «الفواتير ودفترة»: renders nothing unless `api.can('finRead', tx.branch_id)`. `tx_billing`: intents with status / sync / Daftra number / payment, lines, eligible approved charges («غير مفوترة»), review items, `financial_status` badge; actions: create intent, add eligible, push, pull, open `#billing/<id>`.
- **NAV** (`assets/js/app-shell.js`): in group `finance` add `billing` (icon `sync`, `admin.html#billing`, `allow: R.finRead`) and `daftra` (icon `link`, `admin.html#daftra`, `allow: R.finRead`); new constant SVG icons `sync`, `link` in `ICONS`; `OPS_NAV` fallback gets `bill.nav_billing` / `bill.nav_daftra`; `R.billAdmin`. admin.js: `R.billAdmin`, `OPS_SETS += 'billAdmin'`, `NAV_ORDER` adds `'billing','daftra'` after `'demurrage'`; `event_type` label `billing` + per-op labels (ar / en).
- **i18n:** namespace `bill` in `assets/i18n/bill.js` (ar + en, also `window.MarsaBillDict`): `nav_billing, nav_daftra`, view strings, labels `<domain>_<code>` for every `daftra_*` / `bill_*` domain, capability labels, tax-policy notes. Namespace `billtx` registered inside `tx-bill.js`.
- **Styles** `assets/css/pages/bill.css`: sync-state badges mapping onto `badge-*`, mock banner, diff table tint (pushed vs remote), LTR reference cells, `<pre>` call log. Original tokens / classes only.

## Tests (PGlite, harness style of g4-tests.js)
**`supabase/tests/g5-tests.js`** (DB agent, SQL level; worker results handcrafted as `service_role`: `SET ROLE service_role; set_config('request.jwt.claims','{"role":"service_role"}')`):
- **Migration:** preflight message without G4; re-run twice (counts unchanged); `schema_versions` row; event-type superset.
- **No secrets:** no G5 column matching the secret pattern; `app.bill_redact` strips nested keys; attempts never store them.
- **Isolation:** org B refused everywhere; other branch refused for intents / lines / tx jobs; `operations_manager` / staff / client roles see 0 rows and get `MRS_FORBIDDEN` / `MRS_NOT_FOUND`; supervisor reads, cannot write; `daftra_mock_accounts` invisible to authenticated.
- **Service-only:** every `daftra_*` RPC refused for authenticated (`permission denied` and, with a forged grant check, `service_only`); staff RPCs refuse the service role (`MRS_AUTH_REQUIRED`).
- **Connection:** bill_admin only; settings validation; status written by probe completion only.
- **Client / item links:** uniqueness per org (same external id allowed in two orgs, refused twice in one); drift computation; `needs_review` candidates; no auto-overwrite (the `clients` row is unchanged by every G5 path).
- **Intents:** one final per tx + currency (`intent_taken`); supplementary / interim rules; `operational_ref` format, immutability, `-R2` after cancel; tx without client → `MRS_REQUIRED 'client'`.
- **Lines:** eligibility; a charge on two live lines refused (unique); cross-transaction charge refused (FK); remove never-pushed → removed, pushed → pending_remove; charge guard `in_invoice`; G4 `set_charge_status('invoiced')` still `g5_only`.
- **Push gate:** not_connected, capability, conflict_open, intent_issued, tax_rate_unmapped, lines; double request → same job (`deduplicated`); idem replay.
- **Claim / complete:** one job per org per lease; skip disabled orgs; lease expiry → abandoned + unknown; `lease_lost` applies nothing; retry backoff and `dead`; attempts append-only (UPDATE / DELETE refused after close); every effect kind applied exactly as §Worker; `line_results` concurrency rules; `external_id_taken` / `external_in_use`.
- **Issue / pull:** frozen marking, charges → `invoiced`, late charge trigger, mismatch / cancelled items, review resolutions, financial_status forward only (`draft_pending` → `invoiced` → `settled`), events without amounts.
- **No blocking link:** pushing with a container whose empty return is pending.
- **Idempotent replays** for every idem RPC.

**`supabase/tests/g5-cycle-tests.js`** (SYNC agent, step ١٣ end-to-end: real `worker.js` + `mock-adapter.js` driving PGlite through the service RPCs; staff actions through the staff RPCs; time moved by superuser `UPDATE billing_sync_jobs SET next_run_at = now()`):
1. Setup on seed + G4 data: org A (TX-A with approved service 2500 @15 % and reimbursable 600 @0 %; TX-B), org B (own TX + charge). Connect both orgs in mock mode, probe → connected; capabilities stored.
2. **Create:** final intent TX-A, push → one Daftra client (by ref), two products, one draft with 2 lines carrying `line_ref`s; intent `draft` / `synced`; `financial_status = draft_pending`.
3. **Duplicate:** double push request → one job; idem replay; re-running the worker → no second invoice (`control.count('invoice', ref)` = 1); a second final intent refused.
4. **Lost response:** new intent TX-B, `loseResponse('createDraftInvoice')` → attempt `unknown`, job `unknown`; next run reconciles by reference → adopted, still exactly one invoice. Also `failNext('createDraftInvoice','timeout',{applied:'no'})` → retry → one invoice. `offline(true)` → retries → `dead` → `retry_billing_job` after `offline(false)` → synced, one invoice.
5. **Update:** a late approved charge added to the TX-A draft → push → line appended, previous lines untouched (same remote line ids), no duplicate line on re-run; remove a line → only that line removed remotely.
6. **Manual edit:** `editInvoice` (price of an owned line + a foreign line) → next push → `conflict` (no update call in `control.calls`); `keep_remote` → synced, foreign line kept; another case `overwrite_remote` → owned lines restored, foreign line still kept; `deleteDraft` → `remote_missing` → `recreate` → exactly one live invoice for the ref.
7. **Issue:** `issueInvoice` → pull → intent `issued`, Daftra number stored, charges `invoiced`, push refused (`intent_issued`), worker never calls update on it; a new approved charge → `late_charge` item → supplementary intent `S1` → its own invoice.
8. **Payments:** `addPayment` partial → `partial`; full → `paid`; `financial_status = settled` when all issued paid.
9. **Two orgs:** org B pushes in parallel runs; org B mock never sees org A refs (state inspection); same Marsa ids never cross; one running job per org.
10. **Line ↔ transaction mapping:** every remote line with `line_ref` maps to exactly one live line, whose charge's transaction = the intent's transaction; no live line without a remote line after sync.
11. **Gate (exit criteria):** per org mock: invoices per `operational_ref` = 1, products per code = 1, clients per ref = 1, owned lines per `line_ref` = 1; Σ invoiced charges = Σ synced lines of issued intents; `billing_sync_attempts` count = worker calls of complete; no amount and no request body in `transaction_events`; the client portal user sees 0 rows from every G5 table and RPC; no `fetch` / network use (the worker is given no `fetch`; `createRealAdapter` methods throw `not_configured`).
- Also unit-level node checks inside g5-cycle-tests: `canonicalInvoice` / `contentHash` stability (key order, number formatting), mock determinism (same script → same state), `daftra_mock_save` / `load` round-trip and `mock_version`.
- Existing suites stay green. Catalogs (`rls-tests.js` TENANT_TABLES + RPC catalog, `restore-drill.js`) are updated by the **integration step**.
- jsdom smokes (UI agents) under `/private/tmp/claude-501/-Users-apple/3164bcee-2188-447c-b713-54d9e847dd13/scratchpad/g5x/` (copy `integ/admin-stub.js`, `loader.js` and the g4x harness): each view ar + en, empty / mock-banner / conflict / issued states, tx section hidden without finRead, missing MarsaApi name → `ops.api_missing`.

## Task split (file-disjoint OWNS lists)
- **DB**
  - OWNS: `supabase/migrations/20261105000100_g5_daftra.sql`, `supabase/tests/g5-tests.js`.
  - Implements every table, helper, staff RPC and service RPC above, exactly to the worker contract (the SYNC agent codes against it concurrently).
  - Runs g5-tests + all existing suites (expect only the catalog failures in rls-tests / restore-drill for new objects) and reports numbers.
- **SYNC**
  - OWNS: `supabase/functions/daftra-sync/index.ts`, `supabase/functions/daftra-sync/adapter.js`, `supabase/functions/daftra-sync/mock-adapter.js`, `supabase/functions/daftra-sync/worker.js`, `supabase/tests/g5-cycle-tests.js`.
  - `node --check` the three JS files; unit checks run without the DB; the cycle test runs once the DB migration exists (report if it is not there yet). No network, no `fetch`, no keys.
- **UI_CORE**
  - OWNS: `assets/js/supa.js` (MarsaApi additions + error messages), `assets/js/admin.js` (`R.billAdmin`, `OPS_SETS`, `NAV_ORDER`, `billing` event labels), `admin.html` (bill script / style tags), `assets/js/app-shell.js` (`R.billAdmin`, NAV items, icons `sync` / `link`, `OPS_NAV` fallback), `assets/js/bill/tx-bill.js` (section `bill-invoices`, own `billtx` strings).
  - jsdom smoke under `scratchpad/g5x/`.
- **UI_VIEWS**
  - OWNS: `assets/js/bill/billing.js`, `assets/js/bill/daftra.js`, `assets/i18n/bill.js`, `assets/css/pages/bill.css`.
  - Codes against the MarsaApi names above; a missing name shows `ops.api_missing` instead of failing. jsdom smoke per view (ar + en).
- **Not owned in the build** (integration step): `supabase/tests/rls-tests.js`, `supabase/tests/restore-drill.js`, `supabase/all_migrations.sql` (+ a `g5_apply.sql` for live staging), `sw.js` (precache `bill/*.js`, `i18n/bill.js`, `bill.css`, new VERSION), docs (`ARCHITECTURE.md`, `G5_REPORT_AR.md`, this spec's "As built"), `portal.js` (no change, G5-6).

## Not in G5 (explicitly)
- Any real Daftra call, account, key or deployment; ZATCA / e-invoicing inside Marsa; issuing invoices or credit notes via API.
- Ledger, journal entries, receipt / payment vouchers; reconciling G4 collections with Daftra payments.
- Per-client period consolidation, FX conversion, automatic invoice creation.
- Client portal exposure of invoices.

## Open issues (carried to the G5 report)
1. **Real Daftra capabilities unproven** (plan step ٢): every item of `REAL_ENDPOINTS_TO_VERIFY`, especially a searchable invoice reference field, a per-line reference field, draft-only update semantics (replace vs merge), a version token, multi-currency, tax ids.
2. Secret storage for live keys (Vault vs Edge secrets, per-org naming, rotation) — design only.
3. Edge Function deployment + schedule (owner); until then staging jobs stay `queued`.
4. Search consistency of Daftra after a create (the reconcile delay of 2 min is an assumption).
5. Tax advisor confirmation of G5-3 and of reimbursable classification (step ١١).
6. Client portal exposure of the official invoice (G5-6).

## As built — review fixes (2026-11-02, binding)
Each item closes a confirmed review finding; regression suite `supabase/tests/g5-review-tests.js`.
1. **One Daftra account per org** (§1) and **identity check on adoption**: the worker adopts a reference hit only when its `client_id` = the intent's Daftra client and its `currency` = the intent currency, checked on the full read *before* the frozen check; otherwise conflict `external_in_use` (diff `client_id` / `currency`). Open issue for the live adapter: bind the account identity returned by the probe per org next to the future Vault secret and refuse an account bound to another org; references and product codes carry no org token (only safe because of this rule).
2. **Value-level redaction** (§0 helpers): see `app.bill_redact` / `app.bill_scrub_text`; every `last_error_message` comes from `app.bill_error` or a scrubbed exception text.
3. **issued_mismatch details** = `app.bill_diff_cap(diff)` (array, first 500, redacted, never raises) + `app.bill_redact(remote_snapshot)`, bounded by `app.bill_bound_details` (≤ 256 KiB: snapshot dropped first, then the diff); `billing_review_items_details_size_chk` (NOT VALID) backs it; the conflict record goes through the same bound.
4. `retry_billing_job` on `probe` / `item_ensure` = bill_admin.
5. `list_daftra_client_links`: `unlinked[].approved_count` and `billable_only` count only charges on transactions the caller can read (`has_branch_role`); link rows stay org-level.
6. **«Possibly applied» is sticky**: a retry / failed / dead completion keeps `sync_state='unknown'` while the job is unreconciled (`app.bill_job_unreconciled`); the claim hands `previous_status='unknown'` (reference lookup first) when the job is unreconciled or the intent is `unknown`; cancel / immediate removal refused (§5, §6).
7. **Backstop**: a line already `removed` in Marsa whose `line_ref` is on the issued invoice → `issued_mismatch` with `details.removed_on_remote [{line_ref, line_id, charge_id}]` (raised even when the hashes match); its charge is held (`app.bill_charge_held`: not eligible, not addable) until resolved; `accept` turns those charges `invoiced`, `credit_note_in_daftra` releases them (eligible again).
8. **Write fencing** (`daftra_renew_lease`) + 60 s call timeout. A completion that arrives after its attempt was closed (`abandoned`) still applies nothing, but if its calls report an applied / possibly applied write the intent becomes `sync_state='unknown'`, `last_error_code='late_write'`, and a `billing` event `late_write` names the ops (no bodies); the next push reconciles by reference (a duplicate → `external_in_use`, never silent).
9. **No silent adoption without a baseline**: with no `pushed_hash`, the remote is adopted only when it equals `expected_hash` or every Marsa line on it equals Marsa's line and nothing else is on it (`adoptDiff`); otherwise conflict `remote_edited` with that diff.
10. **No false conflict after a crash / lost update**: on a takeover (`previous_status='unknown'`) a remote equal to what this run would leave (`mergeLines` applied) is `ok` with nothing sent; `bill_apply_pull` raises no `remote_edited` / `remote_missing` conflict while the intent is `unknown` / `in_flight` or a push job of it is `queued` / `unknown` (the push re-reads and decides).
11. Pull and frozen push results carry the per-line `diff` whenever the remote hash ≠ `pushed_hash` (draft or issued), so `issued_mismatch` shows it and `accept` writes `remote_override`.
12. UI: the late-charge «new supplementary» dialog remembers the intent it created (a retry never creates a second one; the create idem key is released only after the resolve succeeds). `MarsaApi.addBillingLines`: `null` = every eligible; an array is sent exactly (`[]` → `MRS_REQUIRED 'lines'`, a malformed id → `MRS_INVALID 'charge_ids'`). New labels: `bill_field_foreign_line`, `bill_field_external_invoice_id`, `bill_removed_reason_intent_cancelled|removed`, `removed_on_remote`; error details `link_exists, no_conflict, conflict_reason, unlinked, unreconciled_remote, subdomain_taken`; fields `intent`, `external_invoice_id`; event op `late_write`.
13. **G5-6 enforced on `transactions.financial_status`**: it joins the 0700 hidden columns (column-level SELECT grant without it, fail closed); staff read it through `staff_internal_fields('transactions')` (MarsaApi `withInternal`; `TX_COLS` no longer selects it; the `financialStatus` list filter runs on the merged field), `tx_billing` and `get_billing_intent`.
14. **G4 collection evidence after invoicing**: `app.tg_collection_check` (G4 body) accepts charges `approved` **or `invoiced`** (cap `MRS_OVERPAID` unchanged); the G4 UI shows «تسجيل تحصيل» for both.
15. Lock order of the worker RPCs (see Lock order above).
16. **Re-paste rule**: after G5 never re-paste `g4_apply.sql` / `g3_apply.sql` alone (they narrow `transaction_events_event_type_check` and drop `'billing'`, and restore the G4 collection check); if one succeeded, paste `g5_apply.sql` straight after.
17. `index.ts` (mock mode) saves the DB-backed mock account per job in the worker's `beforeComplete` hook, **before** `daftra_complete_job`; a `mock_version` refusal turns the job into `retry` with nothing applied and drops the cached account; a failed save makes the response 207.

## As built — integration (2026-11-02)
Deviations from the contract above found or decided in the integration and documentation steps. Report: `docs/online/G5_REPORT_AR.md`.
1. **Client refresh keeps the baseline** (§3): on a link that is already `linked` or `drift` (same external id), `client_refresh` stores the new `remote_snapshot` but keeps `pushed_snapshot`, so a rename inside Daftra shows as `remote:<field>` drift instead of a Marsa-side difference (g5-cycle 10b). `pushed_snapshot := remote_snapshot` applies only to a pending manual link or a chosen candidate.
2. **Capability record rebuilt from the fixed key list** (§2): `worker.js` builds the probe effects from `CAPABILITY_KEYS`, because key-name redaction dropped `invoices.version_token` (it contains "token"); the SQL re-checks every key and value. All 17 keys are stored. The logged probe calls (`billing_sync_attempts.calls`) still drop that key — log only.
3. **Response fields added for the UI:** `list_daftra_client_links` `unlinked[]` rows carry `approved_count`; `tx_billing` intents carry `job_status` (lets the «في الانتظار — لم يُشغَّل العامل» note show in the transaction section). Review items expose the charge as `charge.description` / `charge.currency` (the UI reads those).
4. **`billing` events** are readable by non-finance staff of the same transaction, like G4 `finance` events: they carry only an op label and ids, no amounts. The G5-6 rule is enforced and tested for client users (none sees one).
5. **Catalog:** authenticated executes 123 public RPCs (98 + the 25 staff RPCs); the worker RPCs are **six** (`daftra_claim_jobs`, `daftra_complete_job`, `daftra_renew_lease`, `daftra_schedule_pulls`, `daftra_mock_load`, `daftra_mock_save`), `service_role` only. `staff_internal_fields` is recreated (returns `financial_status`). Only `app.bill_can_read_job` is granted to authenticated.
6. **Test fixtures:** in `rls-tests.js` and `restore-drill.js` the single review item per org is inserted by the owner (superuser), because the natural path needs an issued Daftra invoice; every other G5 fixture row goes through real staff / service RPCs.
7. **Transaction detail for non-finance staff:** the `bill-invoices` slot is rendered empty (no children, no text), like the G4 `fin-costs` slot, rather than absent.
8. **sw.js:** `VERSION = '2026-11-05.1'`; precaches the 5 new files (`bill/billing.js`, `bill/daftra.js`, `bill/tx-bill.js`, `i18n/bill.js`, `css/pages/bill.css`). `supabase/functions/daftra-sync/` is not served and not precached.
9. **Decisions added to the report** (defaults already applied by the review fixes): G5-12 one Daftra account per org; G5-13 G4 collection evidence allowed on `invoiced` charges.
10. **Not changed (open):** the `admin.js` fallback label for `financial_status='invoiced'` still reads «صدرت الفاتورة (خارج النظام)» although G5 now sets it from Daftra; `can('billAdmin')` without a branch treats a branch-scoped `accounts_manager` as bill_admin in the UI (the server decides through `app.has_role`); the older harness `g4x/smoke-g4.js` is out of date (11 failures, 7 of them pre-G5 expectations; replaced by `g5x/smoke-g5.js` and `g5int/smoke-real.js`).
11. **Verified numbers (2026-11-02):** rls-tests 1432/0 (1 warning), g2-tests 222/0, g2-ops-tests 110/0, restore-drill 24/0, g3-tests 578/0, g3-cycle-tests 70/0, g4-tests 300/0, g4-cycle-tests 87/0, g5-tests 318/0, g5-cycle-tests 177/0, g5-review-tests 78/0.

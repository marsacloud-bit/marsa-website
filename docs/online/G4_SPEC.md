# G4 — suppliers & operating costs (staging spec)

Source: execution plan §G4 «المرحلة الخامسة: الموردون والتكاليف التشغيلية», steps ١–١٣. Goal: control costs, client charges and their sources **without building a second accounting ledger** (no journal, no GL accounts, no tax invoices: those stay in Daftra / G5).
Read first: `docs/online/ARCHITECTURE.md`, `docs/online/G2_SPEC.md` (conventions, roles, idempotency), `docs/online/G3_SPEC.md` + its "As built" section (parties, trips, exceptions, module hook). Staging only.

**Binding rules (apply to every item below)**
- One migration: `supabase/migrations/20261104000100_g4_costs.sql`. It is re-runnable and applies on the LIVE staging DB that already holds G2 + G3 data.
- Every `SECURITY DEFINER` function: `SET search_path = ''`, the auth check comes first, errors via `app.fail('MRS_*', detail)`, `REVOKE … FROM PUBLIC, anon, authenticated`, then `GRANT EXECUTE … TO authenticated` (public RPCs only; `app.*` helpers stay revoked).
- Money is `numeric(14,2)` (`>= 0`; sign comes from the document type, never from a negative amount). Quantities are `numeric(14,3)`. Currency is `char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$')`. VAT is always a separate column.
- Every child table carries `org_id`. Parents are referenced through composite FKs `(x_id, org_id)` or `(x_id, transaction_id)`. RLS is on for every table. Branch scope always goes through the parent transaction (`app.has_tx_role`) or through the supplier invoice's `branch_id`.
- No direct table writes from the API. All writes go through RPCs (`REVOKE ALL`, then `GRANT SELECT` only). There is no DELETE anywhere. "Removing" a row means `void` / `rejected` / `reversed` with a reason, and the row stays.
- Audit uses the existing `app.tg_audit` trigger on every new table (before/after values, so amounts are never lost). `updated_at` uses `app.touch_updated_at`.
- Create RPCs are idempotent: `p_idem_key uuid DEFAULT NULL` + `app.idem_begin / app.idem_finish`, keyed by the RPC name and the payload without `idempotencyKey`.

## Open G0 decisions (default applied in this build; each one is listed in the G4 report)
| # | Decision | Default applied |
|---|---|---|
| G4-1 | **VAT** on supplier costs | Input VAT is treated as recoverable. **Cost = net (excl. VAT).** Line VAT is stored and checked against `net × rate`, but never enters cost or margin. The demurrage tracker and payables show gross amounts (what is owed or paid). |
| G4-2 | VAT on client charges | Entered per charge: `vat_rate` defaults to 15 for `service` / `internal_service` and to 0 for `reimbursable` (disbursement). G4 issues **no tax invoice**; G5 / Daftra does. |
| G4-3 | **Markup rules** | No rule table. `source='markup'` takes a `markup_pct` on that charge. The price is computed once, from the linked cost at creation, and stored. It is never re-priced automatically; the UI flags "cost changed since priced". |
| G4-4 | **Who approves allocations / invoices / adjustments** | `fin_approve_roles` = accounts_manager, branch_manager, admin. **Four eyes:** the approver must not be the row's creator, except for `admin` (`MRS_FORBIDDEN 'self_approval'`). |
| G4-5 | **FX** | No conversion. Every sum is grouped **by currency**. An allocation inherits the invoice currency. Matching an accrual in another currency is refused (`MRS_INVALID 'currency'`). Margins are per currency, with a `mixed_currency` flag. |
| G4-6 | Carrier-accrual recognition point | Every non-cancelled trip has exactly one accrual, from the moment the trip is created (estimated). With no trip cost, the level is `unknown`. |
| G4-7 | Client visibility of charges | **Clients see nothing from G4** (no costs, no charges, no margins, no demurrage figures). Reason: an approved charge is not yet an invoice. Showing pre-invoice amounts in the portal would create a second, unofficial "bill" that could differ from the Daftra tax invoice (G5). G5 exposes the official invoice instead. |
| G4-8 | Collections from client | Only `charge_collections` *evidence* records (amount, reference, file). They are not receipts. Daftra becomes the source of truth in G5. |
| G4-9 | `transactions.financial_status` | G4 never changes it (it stays the G2 placeholder that G5 drives). |

## Roles (new helpers, `app.*`, IMMUTABLE)
- `app.fin_read_roles()` = `accountant, accounts_manager, branch_manager, supervisor, admin`. These roles may see costs, supplier prices, payments, charges, margins and demurrage figures.
  - `supervisor` is included because `audit_select` already shows them every audit row org-wide, amounts included. Hiding the same figures in the UI would be fake privacy. This holds because G4 makes supervisors **org-wide by construction** (`memberships_supervisor_no_branch` / `invitations_supervisor_no_branch`; the preflight stops while an active branch-scoped supervisor exists).
  - `operations_manager` is **not** included. It keeps the G3 `trip_finance` view of trip cost/sell only.
- `app.fin_write_roles()` = `accountant, accounts_manager, branch_manager, admin`: create invoices / lines / allocations / payments / charges / cases / adjustments.
- `app.fin_approve_roles()` = `accounts_manager, branch_manager, admin`: approve invoices, allocations, charges, adjustments and variances, and void payments.
- Client roles: no SELECT policy on any G4 table, no RPC result.
- UI role sets (admin.js `R` + app-shell.js `R`, mirrored): `finRead`, `finWrite`, `finApprove` = the three lists above. They are added to `OPS_SETS`.

## Data model (migration `20261104000100_g4_costs.sql`)

**Section P — preflight (read-only, before any DDL).**
- Stop if `schema_versions` lacks `20261103000200` (G3 B): `RAISE EXCEPTION 'G4 preflight: apply G3 first'`.
- Stop if `public.transport_trips` has a non-cancelled trip whose `cost_currency` fails `^[A-Z]{3}$`. That is impossible by CHECK, but it is the guard for the backfill.
- Then `INSERT INTO schema_versions ('20261104000100','g4_costs') ON CONFLICT DO NOTHING`.

**Section 0 — dictionaries.**
- `status_labels` (all `client_visible=false`), ar + en, upserted. Domains:
  - `fin_invoice_status`, `fin_invoice_doc_type`, `fin_payment_status`, `fin_line_review`;
  - `fin_alloc_status`, `fin_accrual_status`, `fin_accrual_source`, `fin_variance_reason`;
  - `fin_charge_kind`, `fin_charge_status`, `fin_charge_source`, `fin_payment_method`, `fin_payer`;
  - `fin_demurrage_kind`, `fin_demurrage_status`, `fin_adjustment_kind`, `fin_adjustment_status`;
  - `fin_level`, `fin_doc_kind`, `fin_service`.
- `fin_service` codes (service catalog; nullable on lines):
  - `customs_clearance`, `transport`, `port_charges`, `delivery_order`, `storage` (أرضيات), `demurrage`, `detention`;
  - `inspection`, `empty_handling`, `washing`, `repair`, `documentation`, `saber`, `other`.
  - `app.fin_check_service(code)` raises `MRS_INVALID 'service_code'` for an unknown code.
- `transaction_events_event_type_check` is recreated as a superset: the full G3 list + `'finance'`. Finance events are `visible_to_client=false` and **never carry amounts**. The payload is `{op, entity, id, …ids}`.
- Unique helpers for composite FKs, added inside `DO` blocks only if missing:
  - `transport_trips UNIQUE (id, transaction_id)`;
  - `operational_exceptions UNIQUE (id, transaction_id)`.

### 1. Parties: official / finance data (plan step ١, mostly done in G3)
- `parties` already has `kinds[]` (multi-function), `cr_number`, `vat_number`, `phone`, `email`. **Do not duplicate.**
- Add (`ADD COLUMN IF NOT EXISTS`):
  - `iban_last4 text CHECK (~ '^[0-9]{4}$')` (never the full IBAN);
  - `bank_name text (≤80)`;
  - `payment_terms_days int CHECK (0..365)`;
  - `default_currency char(3) DEFAULT 'SAR'`;
  - `address text (≤300)`;
  - `contact_name text (≤120)`.
- `address` / `contact_name` are written directly, like the other party fields (G3 RLS, transport writers).
- `iban_last4, bank_name, payment_terms_days, default_currency` are **finance columns**:
  - trigger `app.tg_parties_fin_guard` (BEFORE INSERT/UPDATE) refuses a change to them unless the transaction-local flag `marsa.fin_party = on` is set (`MRS_FORBIDDEN 'party_finance'`);
  - the flag is set only by `save_party_finance`.
  - They stay staff-readable: no column grant, because `select('*')` in parties.js must keep working; last4 is not secret.
- RPC `save_party_finance(p_party uuid, p_payload jsonb)` → party json. Needs `fin_write_roles` in any branch of the org (`app.has_role`). Keys: the 4 finance columns.

### 2. `finance_documents`: original files outside the transaction documents (steps ٤, ٧, ١١)
`documents` requires a transaction or a request and may be client-visible. A supplier invoice can span many transactions, or none. So finance originals get their own table and a private bucket.
- **Columns:**
  - `id, org_id, branch_id` (FK branches `(branch_id, org_id)`);
  - `kind` ('supplier_invoice','credit_note','payment_evidence','collection_evidence','adjustment_evidence','demurrage_evidence','other');
  - `storage_bucket text DEFAULT 'finance' CHECK = 'finance'`;
  - `storage_path text UNIQUE` = `{org_id}/{id}/{file name}` (CHECK like `documents_path_chk`: 3 segments, no `..`);
  - `sha256 (^[0-9a-f]{64}$)`, `original_name (1..255)`, `mime_type`, `size_bytes (1..26214400)`;
  - `uploaded_by NOT NULL`, `uploaded_at`;
  - `voided_at, voided_by, void_reason` (CHECK both-or-neither);
  - `UNIQUE (id, org_id)`.
- **Duplicate file:** unique index `(org_id, sha256) WHERE voided_at IS NULL`. The RPC turns it into `MRS_INVALID 'file_duplicate'`, with detail = the existing document id.
- **Storage:** bucket `finance` (private, 25 MB, same mime list as `documents`). Policies `marsa_finance_read` / `marsa_finance_insert` mirror the 0500 ones: read = an `EXISTS` row visible under finance_documents RLS; insert = the caller's own non-voided row less than 24 h old; `foldername` length = 2. No UPDATE / DELETE policy.
- **RLS SELECT:** `app.has_branch_role(org_id, branch_id, app.fin_read_roles())`.
- **RPCs:**
  - `register_finance_document(p_payload {branch_id, kind, original_name, mime_type, size_bytes, sha256}, p_idem_key)` → `{id, storage_bucket, storage_path}`. Needs `fin_write` at that branch.
  - `void_finance_document(p_id, p_reason)`: refused while it is the original of a non-void invoice (`MRS_BAD_TRANSITION 'in_use'`).

### 3. `supplier_invoices` (step ٤)
- **Columns:**
  - `id, org_id, branch_id` (receiving branch: scope, immutable);
  - `supplier_id` → parties `(id, org_id)` (any kind, active at creation);
  - `doc_type ('invoice','credit_note','debit_note') DEFAULT 'invoice'`, `adjusts_invoice_id` → supplier_invoices (required for credit/debit notes, same supplier);
  - `invoice_number text (1..60)`, `number_norm text NOT NULL` (trigger);
  - `invoice_date date NOT NULL`, `due_date date (>= invoice_date)`, `received_at timestamptz DEFAULT now()`;
  - `currency`, `subtotal`, `vat_amount`, `total_amount` with CHECK `total_amount = subtotal + vat_amount`;
  - `reference text (≤120)` (B/L, booking, container…), `supplier_vat_number (^[0-9]{15}$)` (snapshot, default = the party's);
  - `finance_document_id` → finance_documents (the original), `source_document_id` → documents (an `operator_invoice` already uploaded on a transaction);
  - `status ('received','under_review','approved','disputed','void') DEFAULT 'received'`, `status_note`;
  - `approved_by, approved_at, discrepancy_note`;
  - payment cache (trigger-maintained only): `company_paid_amount numeric(14,2) DEFAULT 0`, `client_paid_amount DEFAULT 0`, `payment_status ('unpaid','partial','paid','paid_directly_by_client') DEFAULT 'unpaid'`;
  - `void_reason`, `duplicate_of_id` → supplier_invoices, `notes (≤2000)`, `created_by`, timestamps;
  - `UNIQUE (id, org_id)`.
- **`number_norm` = `app.fin_norm_no(invoice_number)`:** `to_western` → upper → strip leading zeros of every digit run → fold Arabic variants (أ/إ/آ/ٱ → ا, ة → ه, ى → ي; tatweel and harakat dropped) → every run of other characters becomes one separator, kept **only between two digits**. Examples: `inv-0012` → `INV12`, `INV 12` → `INV12`, `١٢٣` → `123`, `A-1-23` → `A1-23` ≠ `A-12-3` → `A12-3`, `2026/1/05` → `2026-1-5`, `فاتورة 12` = `فاتوره 12`. Numbers equal once the separators are dropped are a soft `similar_number` warning.
- **Hard uniqueness:** unique index `(org_id, supplier_id, doc_type, number_norm) WHERE status <> 'void'`. A second copy gives `MRS_INVALID 'invoice_number_taken'` (detail = existing id).
- **Soft detection:** `app.fin_possible_duplicates(org, supplier, number_norm, date, total, sha256)`. Same supplier + same total + date within ±7 days + different number, or same number_norm under another supplier, or same file sha256. The result is returned as `possible_duplicates` in create/get results and shown as a warning. It never blocks.
- **Rule «وجود فاتورة لا يثبت دفعها»:** no status implies payment. `payment_status` is only ever derived from `supplier_payments`.
- **State machine** (`set_supplier_invoice_status`):
  - `received → under_review | disputed | void`;
  - `under_review → approved | disputed | void`;
  - `disputed → under_review | void`;
  - `approved → disputed` (note required; approved allocations stay, but their level drops to *estimated*).
  - `void` needs a note, no non-void payment and no approved allocation (`MRS_BAD_TRANSITION 'has_payments' / 'has_approved_allocations'`).
- **Approval gate** (`approved`, `fin_approve` at the invoice branch, four eyes vs `created_by`):
  - an original file (`finance_document_id` or `source_document_id`), else `MRS_REQUIRED 'original_file'`;
  - ≥ 1 line, else `MRS_REQUIRED 'lines'`;
  - no line in `pending_review` / `disputed`, else `MRS_INVALID 'lines_pending_review'`;
  - every `ok` line fully allocated with **approved** allocations, else `MRS_INVALID 'lines_unallocated'` (detail = line_nos);
  - header vs lines discrepancy = 0 on net, VAT and total, or a note given, which is stored as `discrepancy_note` (`MRS_NOTE_REQUIRED 'discrepancy'`).
- **Edits:** header and lines are editable only in `received / under_review / disputed`; otherwise `MRS_BAD_TRANSITION 'invoice_locked'`.

### 4. `supplier_invoice_lines` (step ٥: every line kept)
- **Columns:**
  - `id, org_id, supplier_invoice_id` (FK `(supplier_invoice_id, org_id)`), `line_no int (1..999)`, unique `(supplier_invoice_id, line_no)`;
  - `description text NOT NULL (1..500)`, `quantity numeric(14,3) DEFAULT 1 (>0)`, `unit text (≤20)`, `unit_price numeric(14,2)`;
  - `net_amount`, `vat_rate numeric(5,2) DEFAULT 15 (0..100)`, `vat_amount`, `total_amount` with CHECK `= net_amount + vat_amount`;
  - `service_code` (nullable, fin_service), `container_no_hint`, `reference_hint`;
  - `source ('manual','ocr','import') DEFAULT 'manual'`;
  - `review_status ('pending_review','ok','overhead','excluded','disputed')`, `review_reasons text[]`, `review_note`, `reviewed_by/at`;
  - `created_by`, timestamps;
  - `UNIQUE (id, org_id)`, `UNIQUE (id, supplier_invoice_id)`.
- **Never dropped.**
  - No DELETE grant; no RPC removes a line. A wrong line becomes `excluded` with a note.
  - A line with an amount but no readable description is stored with the placeholder `'(بند غير مقروء)'` and `review_reasons ⊇ {'unreadable'}`.
- **Auto review on insert/update** (`app.fin_line_review_reasons`): `review_status='pending_review'` when any reason applies:
  - `no_service` (service_code NULL);
  - `qty_price_mismatch` (`|qty × unit_price − net| > 0.05`, when unit_price is given);
  - `vat_mismatch` (`|net × rate/100 − vat| > 0.05`);
  - `from_ocr` (source ocr/import);
  - `unreadable`.
  - Otherwise the status is `ok`.
- **Sum check vs header:** `discrepancy = {net: subtotal − Σ net, vat: vat_amount − Σ vat, total: total_amount − Σ total}` over **all** lines (excluded included: they are on paper). Returned by `get_supplier_invoice` and shown as an explicit banner; it is never silently fixed.
- **Review queue:** `cost_review_queue` (below) lists `pending_review` / `disputed` lines first.

### 5. `cost_allocations` (step ٦: allocation never doubles the invoice)
- **Columns:**
  - `id, org_id, supplier_invoice_id, line_id` (FK `(line_id, supplier_invoice_id)` → lines);
  - `transaction_id` (FK `(transaction_id, org_id)`), and optionally, each FK `(x, transaction_id)` so every target is inside that same transaction: `container_id`, `trip_id`, `demurrage_case_id`, `accrual_id`;
  - `amount numeric(14,2) > 0` (net, in the invoice currency), `share_pct numeric(7,4)` (informational, when allocated by share), `service_code` (default = the line's);
  - `is_late boolean` (the transaction was in `under_billing / billed / closed` at allocation time);
  - `status ('proposed','approved','rejected','reversed') DEFAULT 'proposed'`, `note`;
  - `decided_by, decided_at, decision_note` (approve / reject), `reversed_by, reversed_at, reverse_reason`;
  - `created_by`, timestamps.
- **No-doubling constraint:** trigger `app.tg_alloc_cap` (BEFORE INSERT/UPDATE OF amount, status). It locks the line `FOR UPDATE` and refuses when `Σ amount over the line's allocations with status IN ('proposed','approved') > line.net_amount` (`MRS_OVER_ALLOCATED`, detail = remaining). Lines `excluded` / `overhead` / `pending_review` / `disputed` accept no allocation (`MRS_BAD_TRANSITION 'line_<status>'`).
- **Share mode:** `share_pct` targets must sum to ≤ 100. Amounts = `round(net × pct/100, 2)` with the largest-remainder rule, so 100 % gives exactly `net`.
- **Approval** (`approve_allocations`):
  - `fin_approve` at the *transaction's* branch, plus four eyes vs `created_by`;
  - `is_late` rows need `p_note` (`MRS_NOTE_REQUIRED 'late_cost'`), and each one auto-creates an approved `cost_adjustments` row of kind `late_cost` (document = the invoice original);
  - matching with the linked accrual happens here (item 6).
- Approved rows are immutable. A correction is `reverse_allocation` with a reason (allowed only while the invoice is not `approved`: `MRS_BAD_TRANSITION 'invoice_approved'`, dispute first). Reversing recomputes the accrual match.
- **Cross-branch:** allocating to a transaction needs `fin_write` at that transaction's branch (`app.g3_lock_tx(tx, fin_write_roles)`).

### 6. `cost_accruals`: expected costs, carrier accrual (step ٣: accrual ≠ payment, never doubled)
- **Columns:**
  - `id, org_id, transaction_id` (FK), `container_id` (FK `(…, transaction_id)`);
  - `source ('trip','demurrage','adjustment','manual')`, `trip_id` (FK `(trip_id, transaction_id)`), `demurrage_case_id`, `adjustment_id`;
  - `supplier_id` → parties (the carrier / operator; NULL = own fleet or unknown), `service_code`;
  - `amount numeric(14,2) NULL` (NULL = **unknown**), `currency`, `basis ('agreed','estimated') DEFAULT 'estimated'`;
  - `matched_amount numeric(14,2) DEFAULT 0` (Σ approved allocations with this `accrual_id`, trigger-maintained);
  - `status ('open','matched','variance','void') DEFAULT 'open'`;
  - `variance_reason ('amount_diff','trip_cost_changed_after_match','trip_cancelled_after_match','allocation_reversed')`, `variance_amount`, `pending_amount` (a new trip cost waiting for review);
  - `reviewed_by, reviewed_at, review_note`, `void_reason`, `created_by`, timestamps;
  - `UNIQUE (id, transaction_id)`.
- Unique partial indexes give one live accrual per source: `(trip_id) WHERE status <> 'void'`, `(demurrage_case_id) WHERE status <> 'void'`, `(adjustment_id) WHERE status <> 'void'`. CHECK: the source column matches `source`.
- **Trip sync:** `app.sync_trip_accrual(transport_trips)` is called by trigger `trg_g4_accrual` (AFTER INSERT OR UPDATE OF cost_amount, cost_currency, cost_basis, carrier_id, container_id, status ON transport_trips). It is definer and emits no amounts in events.
  - **New trip, not cancelled:** insert an `open` accrual with `amount = cost_amount`, `currency = cost_currency`, `basis = 'agreed'` when `cost_basis='agreed'` else `'estimated'`, `supplier_id = carrier_id`.
  - **Change with `matched_amount = 0` and status `open`:** update amount / currency / supplier / basis in place (audit keeps the before value).
  - **Cost change after any match (`matched_amount > 0`):** the amount is **not** changed. `pending_amount := new cost`, `status := 'variance'`, `variance_reason := 'trip_cost_changed_after_match'`. This is the plan's «لا تتكرر التكلفة»: the invoice allocation stays the only counted cost.
  - **Trip cancelled:** open + unmatched → `void` (reason `trip_cancelled`); matched → `variance` / `trip_cancelled_after_match`.
- **Matching** (in `approve_allocations` / `reverse_allocation`):
  - recompute `matched_amount`;
  - `matched_amount = amount` → `matched`;
  - otherwise (> 0, or amount NULL) → `variance` / `amount_diff` with `variance_amount = matched_amount − coalesce(amount, 0)`;
  - all approved allocations reversed → back to `open`;
  - a currency mismatch is refused at allocation time.
- **Review** (`review_accrual_variance`, fin_approve, note required). Decisions:
  - `accept` → `matched` (the residual expectation is dropped; the variance is kept on the row);
  - `keep_open` → `open` (the residual `amount − matched_amount` stays estimated);
  - `accept_new_amount` → `amount := pending_amount`, then the match is recomputed;
  - `keep_amount` → `pending_amount := NULL`, then recomputed.
- **Backfill:** one accrual per existing non-cancelled trip (`INSERT … ON CONFLICT DO NOTHING` on the partial index). No events.
- An accrual never creates a payment, and a payment never touches an accrual.

### 7. `supplier_payments`: payment evidence (step ٧: paid ≠ due ≠ revenue)
- **Columns:**
  - `id, org_id, supplier_invoice_id` (FK `(…, org_id)`);
  - `amount > 0`, `currency` (= the invoice's, CHECK in trigger), `paid_at date NOT NULL (≤ today+1)`;
  - `method ('bank_transfer','cash','cheque','card','offset','other')`;
  - `payer ('company','client') DEFAULT 'company'`, `client_id` (FK `(client_id, org_id)`, required iff `payer='client'`);
  - `reference text (≤120)`, `evidence_document_id` → finance_documents;
  - CHECK: `reference IS NOT NULL OR evidence_document_id IS NOT NULL`, and `payer='client'` requires `evidence_document_id`;
  - `status ('recorded','void') DEFAULT 'recorded'`, `void_reason`, `voided_by/at`, `created_by`, `created_at`.
- Append-only: an UPDATE is allowed only for `recorded → void`, via `app.tg_guard_generic`-style immutables.
- **Trigger `app.tg_payment_totals`:**
  - recompute the invoice's `company_paid_amount`, `client_paid_amount` and `payment_status`:
    - `paid_directly_by_client` if client ≥ total and company = 0;
    - `paid` if company + client ≥ total;
    - `partial` if > 0;
    - else `unpaid`;
  - refuse overpayment (`MRS_OVERPAID`, detail = remaining);
  - refuse a payment on `void` invoices and on credit notes (`MRS_BAD_TRANSITION`).
- **No fake cash movement:**
  - a `payer='client'` payment is evidence that the client paid the supplier directly. It is *not* company cash-out and is reported separately;
  - no payment ever creates a charge, collection, accrual or allocation;
  - recording a client-direct payment on an invoice whose allocations already carry a non-void `reimbursable` charge is refused (`MRS_BAD_TRANSITION 'charged_to_client'`: void the charge first). Otherwise the client would pay twice.
- Void: `fin_approve`, reason required.

### 8. `client_charges`: sell side (step ٨: price independent of cost)
- **Columns:**
  - `id, org_id, transaction_id` (FK), `container_id`;
  - `kind ('service','internal_service','reimbursable')`. `internal_service` = the company's own work with no supplier cost; `reimbursable` = a pass-through disbursement;
  - `service_code`, `description (1..300)`, `quantity numeric(14,3) DEFAULT 1`, `unit_price`;
  - `net_amount` (= round(qty × unit_price, 2), trigger), `vat_rate`, `vat_amount` (= round(net × rate/100, 2)), `total_amount`, `currency`;
  - `source ('manual','from_cost','markup','from_trip')`, `cost_allocation_id`, `accrual_id`, `trip_id`, `demurrage_case_id` (each FK `(…, transaction_id)`);
  - `markup_pct numeric(7,2)`, `cost_snapshot numeric(14,2)` (the linked cost at pricing time);
  - `status ('draft','approved','invoiced','void') DEFAULT 'draft'`, `approved_by/at`, `void_reason`, `note`, `created_by`, timestamps;
  - `UNIQUE (id, transaction_id)`.
- **Rules:**
  - `from_cost` / `markup` need exactly one of `cost_allocation_id` / `accrual_id`;
  - `from_cost` price = cost; `markup` price = round(cost × (1 + pct/100), 2);
  - `from_trip` needs `trip_id` and takes `transport_trips.sell_amount` (G3 sell becomes a real charge only through this).
  - **No double charge:**
    - unique partial indexes `(cost_allocation_id)`, `(accrual_id)` and `(trip_id) WHERE status <> 'void'`;
    - any sourced charge (`from_cost` / `markup`, whatever its kind) on a cost the transaction's own client paid directly → `MRS_INVALID 'paid_by_client'` (a genuine handling fee is a manual charge);
    - across the accrual ↔ allocation link: an allocation whose accrual is charged, or an accrual one of whose allocations is charged → `cost_charged`; a cost charge on a trip already charged `from_trip`, or `from_trip` on a leg already billed through its cost → `trip_charged`.
  - `invoiced` is reserved for G5: `set_charge_status(…,'invoiced')` gives `MRS_BAD_TRANSITION 'g5_only'`.
  - States: `draft → approved | void`; `approved → void` (fin_approve, note); `approved → draft` (fin_approve, note).
  - Edits only in `draft`.

### 9. `charge_collections`: collected-from-client evidence (step ١٠)
- **Columns:**
  - `id, org_id, charge_id` (FK `(charge_id, transaction_id)` → client_charges), `transaction_id`;
  - `amount > 0`, `currency` (= the charge's), `collected_at date`, `method` (same list as payments);
  - `reference`, `evidence_document_id` → finance_documents (CHECK: one of the two);
  - `status ('recorded','void')`, `void_reason`, `created_by`, `created_at`.
- Allowed only on `approved` charges. Σ non-void ≤ charge `total_amount` (`MRS_OVERPAID`). Append-only like payments.

### 10. `demurrage_cases`: storage / demurrage / detention tracker (أرضيات وغرامات, step ١٠)
- **Columns:**
  - `id, org_id, transaction_id` (FK), `container_id` (FK `(…, transaction_id)`, NULL for LCL);
  - `kind ('storage','demurrage','detention')`;
  - `operator_id` → parties with kinds && `{terminal_operator, shipping_agent, yard}`;
  - `exception_id` → operational_exceptions `(id, transaction_id)` (reuses G3);
  - `free_until date`, `charged_until date`, `days int`;
  - `estimated_amount numeric(14,2)` (net, the expected operator amount), `estimated_vat_rate DEFAULT 15`, `currency`;
  - `status ('open','closed','waived','void')`, `status_note`, `created_by`, timestamps;
  - `UNIQUE (id, transaction_id)`.
- If `estimated_amount` is set, a `source='demurrage'` accrual is kept in sync (same rules as trips: in-place while unmatched, `variance` after a match).
- **Four separate figures** (computed by `list_demurrage` / `tx_costs`, gross = incl. VAT):
  1. `charged_to_client` = Σ total of non-void `approved` / `invoiced` charges with this `demurrage_case_id`.
  2. `collected_from_client` = Σ non-void collections on those charges.
  3. `paid_to_operator` = Σ over approved allocations to the case of `alloc_gross × company_paid_amount / invoice.total_amount`, where `alloc_gross = amount × line.total_amount / line.net_amount`. `paid_by_client_to_operator` uses `client_paid_amount` in the same way and is shown separately.
  4. `remaining`:
     - `{to_collect: (1) − (2), to_pay_operator: operator_due − paid_to_operator − paid_by_client_to_operator}`;
     - `operator_due` = Σ alloc_gross, or `estimated_amount × (1 + rate/100)` with `operator_due_level='estimated'` when nothing is allocated yet.
- «التحصيل من العميل لا يعني سداد المشغل»: no figure is derived from another. Each comes from its own records.

### 11. `cost_adjustments`: exceptional fees & adjustments (step ١١)
- **Columns:**
  - `id, org_id`;
  - `kind ('late_cost','empty_fee','washing','repair','amendment','duplicate_invoice','other')`;
  - `transaction_id`, `container_id`, `supplier_invoice_id`, `related_invoice_id` (the original, for duplicates), `exception_id` (reuses G3 `operational_exceptions` of the same transaction);
  - `supplier_id`, `service_code`, `amount numeric(14,2)`, `currency`;
  - `finance_document_id` → finance_documents, `document_id` → documents;
  - `reason NOT NULL (1..2000)`;
  - `status ('proposed','approved','rejected') DEFAULT 'proposed'`, `reviewed_by/at`, `review_note`;
  - `accrual_id` (set on approval), `created_by`, timestamps.
- **CHECKs:**
  - linked to a document: `finance_document_id OR document_id OR supplier_invoice_id IS NOT NULL` (an invoice carries its original);
  - `transaction_id OR supplier_invoice_id IS NOT NULL`;
  - `duplicate_invoice` / `amendment` require `supplier_invoice_id`;
  - `duplicate_invoice` requires `related_invoice_id` (same supplier, ≠ itself).
- **Review effects** (`review_cost_adjustment`, fin_approve, four eyes, note required):
  - **approved fee kinds** (`empty_fee`, `washing`, `repair`, `late_cost`, `other`) with transaction + amount and no `supplier_invoice_id`: create a `source='adjustment'` accrual (an expected cost). When the supplier invoice arrives, its line matches that accrual like a trip;
  - **approved `duplicate_invoice`:** the duplicate invoice becomes `void` (`void_reason 'duplicate'`, `duplicate_of_id = related_invoice_id`). Refused if it has payments or approved allocations. The file and lines stay, contributing nothing;
  - **`amendment`:** a documented link only (the credit/debit note runs its own approval);
  - **rejected:** no effect, kept.
- **Readable by:** `(transaction_id IS NOT NULL AND has_tx_role(tx, fin_read)) OR (supplier_invoice_id IS NOT NULL AND app.fin_can_read_invoice(si))`.

### 12. Cost items, margin, reports (steps ٩, ١٢)
**`app.fin_cost_items(p_org uuid)`** is an internal SQL function (definer, revoked from everyone), RETURNS TABLE `(org_id, branch_id, transaction_id, client_id, supplier_id, service_code, currency, amount, level, source, ref_id, item_date, is_pass_through, client_paid_share)`. Each cost is counted **exactly once**:

| source | rows | amount | level |
|---|---|---|---|
| `allocation` | approved allocations on non-void invoices | `amount` (− for credit notes) | `confirmed` if invoice `approved`, else `estimated` |
| `accrual` | accruals with status `open` | `amount − matched_amount` (≥ 0), or NULL | `estimated`, or `unknown` when amount IS NULL |
| `overhead` | lines `overhead` | `net_amount` | from the invoice status (no transaction; branch = invoice branch) |
| `unallocated` | `ok` / `disputed` lines minus approved allocations | the remainder | `unknown` attribution, shown under "unallocated" |

- `matched` / `variance` / `void` accruals and `proposed` / `rejected` / `reversed` allocations add 0; they are listed as *pending*.
- `excluded` lines add 0.
- `client_paid_share` (per allocation) = `least(Σ that transaction's client's recorded payer='client' payments on the invoice / Σ gross of that client's approved allocations on it, 1)` (`app.fin_client_share`); 0 for overhead / unallocated items. A client's direct payment never lowers another client's cost.
- `is_pass_through` = an **approved / invoiced** `reimbursable` charge references the allocation / accrual (a draft keeps the cost in the margin and is pending `draft_charge`).
- **Invariant (tested):** for every non-void invoice, Σ items with `ref` in its lines = Σ net of its non-excluded lines.

**`tx_margin(p_tx uuid)`** returns jsonb. It needs `fin_read` at the tx branch (`MRS_NOT_FOUND` when the tx is invisible, `MRS_FORBIDDEN 'finance'` when it is visible without a finance role).
- Shape: `{transaction_id, analytical:true, currencies:[{currency, …figures}], level, pending:[{type, id, label_ar, label_en}], mixed_currency}`.
- Per currency:
  - `charges_service` (approved + invoiced net of `service` + `internal_service`), `charges_internal` (of which internal), `charges_draft`;
  - `reimbursable_charged`;
  - `cost_confirmed` = Σ confirmed non-pass-through × (1 − client_paid_share), `cost_estimated` (same for estimated), `unknown_count`;
  - `pass_through_cost`, `client_paid_direct` (Σ amount × client_paid_share);
  - `margin_confirmed = charges_service − cost_confirmed`, `margin_expected = charges_service − cost_confirmed − cost_estimated`;
  - `reimbursable_gap = reimbursable_charged − pass_through_cost × (1 − share)` (≠ 0 is listed as pending).
- `level`:
  - `unknown` if unknown_count > 0 or an unallocated line names this tx in `reference_hint`;
  - else `estimated` if cost_estimated ≠ 0 or any pending item;
  - else `confirmed`.
- `pending` types: `proposed_allocation`, `open_accrual`, `unknown_accrual`, `variance_accrual`, `draft_charge`, `open_demurrage`, `proposed_adjustment`, `reimbursable_gap`.
- The UI always shows «هامش تحليلي — ليس ربحًا محاسبيًا».

Other reporting RPCs:
- `margin_report(p_org, p_filters {branch_id, client_id, from, to (tx created_at), operational_status, level, currency, limit ≤200, offset})` → `{items:[{transaction_id, ref, client_name, branch_id, currency, charges_service, cost_confirmed, cost_estimated, margin_confirmed, margin_expected, level, pending_count}], total, limit, offset, totals_by_currency}`. Rows are limited to transactions where the caller has fin_read.
- `cost_report(p_org, p_filters {group_by: 'transaction'|'client'|'supplier'|'service'|'branch'|'level' (required), from, to (item_date), branch_id, client_id, supplier_id, service_code, level, currency, include_overhead bool DEFAULT true})` → `{group_by, rows:[{key, label_ar, label_en, currency, confirmed, estimated, unknown_count, pass_through, client_paid_direct, items}], totals_by_currency}`.
  - Built on `fin_cost_items`, filtered by `app.has_branch_role(org, branch_id, fin_read)` per row.
  - Payables figures stay in `list_supplier_payments`: due, paid and revenue are never mixed into one column.

### 13. Readers for the UI
- `list_supplier_invoices(p_org, p_filters {status, payment_status, supplier_id, branch_id, from, to, q (number/reference/supplier name), needs_review bool, limit ≤200, offset})` → `{items:[invoice + supplier_name + line_count + pending_lines + allocated_pct + discrepancy_total], total, counts:{by_status, by_payment_status}, limit, offset}`.
- `get_supplier_invoice(p_id)` → `{invoice, supplier, lines:[line + allocations[]], payments[], adjustments[], discrepancy, possible_duplicates[], can:{edit, approve, pay, void}}`.
- `check_supplier_invoice_duplicate(p_org, p_payload {supplier_id, invoice_number, invoice_date, total_amount, doc_type?, sha256?})` → `{exact:[{id, invoice_number, status}], possible:[…], file:[…]}`.
- `cost_review_queue(p_org, p_filters {branch_id, kind?})` → `{lines_pending[], invoices_discrepancy[], allocations_proposed[], accruals_variance[], adjustments_proposed[], counts}`.
- `list_accruals(p_org, p_filters {transaction_id, status, source, supplier_id, limit, offset})`.
- `list_supplier_payments(p_org, p_filters {supplier_id, branch_id, payer, status, from, to, limit, offset})` → `{items, totals_by_currency:{due_approved_unpaid, paid_by_company, paid_by_client_direct}}` (three separate figures).
- `list_client_charges(p_tx)` → `{items: charges + collected_amount}`, and `suggest_client_charges(p_tx)` → `{trips_with_sell:[…not yet charged], reimbursable_costs:[approved allocations / open accruals without a charge]}`.
- `list_demurrage(p_org, p_filters {transaction_id, status, kind, operator_id, limit, offset})` → items with the four figures.
- `list_cost_adjustments(p_org, p_filters {transaction_id, supplier_invoice_id, status, kind, limit, offset})`.
- `tx_costs(p_tx)` → `{allocations:[+invoice_number, supplier_name, line description, invoice status], accruals[], adjustments[], demurrage[], charges[], collections[]}`. One call for the transaction section.

## RPC list (all `SECURITY DEFINER`, `search_path=''`, `authenticated` only)
Write RPCs return the row json (`app.fin_*_json`), plus `from` on status changes.

| RPC | Params | Role check | Idem | Event (`finance`, tx-level only) |
|---|---|---|---|---|
| `save_party_finance` | `(p_party uuid, p_payload jsonb)` | fin_write (org) | – | – |
| `register_finance_document` | `(p_payload jsonb, p_idem_key uuid)` | fin_write @branch | ✓ | – |
| `void_finance_document` | `(p_id uuid, p_reason text)` | fin_approve @branch | – | – |
| `create_supplier_invoice` | `(p_payload jsonb, p_idem_key uuid)` (optional `lines` array → same as add_invoice_lines) | fin_write @branch | ✓ | – |
| `update_supplier_invoice` | `(p_id uuid, p_payload jsonb)` | fin_write | – | – |
| `set_supplier_invoice_status` | `(p_id uuid, p_status text, p_note text DEFAULT NULL)` | write; approve/void → fin_approve | – | – |
| `check_supplier_invoice_duplicate` | `(p_org uuid, p_payload jsonb)` | fin_read | – | – |
| `add_invoice_lines` | `(p_invoice uuid, p_lines jsonb, p_source text DEFAULT 'manual', p_idem_key uuid)` (≤200 lines) | fin_write | ✓ | – |
| `update_invoice_line` | `(p_id uuid, p_payload jsonb)` (refused when allocated: `MRS_BAD_TRANSITION 'allocated'`) | fin_write | – | – |
| `review_invoice_line` | `(p_id uuid, p_decision text ok\|overhead\|excluded\|disputed, p_note text, p_service_code text DEFAULT NULL)` (note required except `ok`) | fin_write | – | – |
| `allocate_invoice_line` | `(p_line uuid, p_targets jsonb, p_idem_key uuid)` | fin_write @each tx | ✓ | `allocation_proposed` |
| `approve_allocations` | `(p_ids uuid[], p_note text DEFAULT NULL)` (≤100) | fin_approve @tx, four eyes | – | `allocation_approved`, `late_cost` |
| `reject_allocation` | `(p_id uuid, p_reason text)` | fin_approve | – | `allocation_rejected` |
| `reverse_allocation` | `(p_id uuid, p_reason text)` | fin_approve | – | `allocation_reversed` |
| `cost_review_queue` | `(p_org uuid, p_filters jsonb DEFAULT '{}')` | fin_read | – | – |
| `list_supplier_invoices` / `get_supplier_invoice` | `(p_org, p_filters)` / `(p_id)` | fin_read | – | – |
| `create_accrual` | `(p_payload jsonb, p_idem_key uuid)` (manual) | fin_write @tx | ✓ | `accrual_created` |
| `review_accrual_variance` | `(p_id uuid, p_decision text, p_note text)` | fin_approve | – | `accrual_reviewed` |
| `void_accrual` | `(p_id uuid, p_reason text)` (only `open` and `matched_amount = 0`) | fin_write | – | `accrual_voided` |
| `list_accruals` | `(p_org uuid, p_filters jsonb)` | fin_read | – | – |
| `record_supplier_payment` | `(p_payload jsonb, p_idem_key uuid)` | fin_write @invoice branch | ✓ | – |
| `void_supplier_payment` | `(p_id uuid, p_reason text)` | fin_approve | – | – |
| `list_supplier_payments` | `(p_org uuid, p_filters jsonb)` | fin_read | – | – |
| `create_client_charge` | `(p_payload jsonb, p_idem_key uuid)` | fin_write @tx | ✓ | `charge_created` |
| `update_client_charge` | `(p_id uuid, p_payload jsonb)` (draft only) | fin_write | – | – |
| `set_charge_status` | `(p_id uuid, p_status text, p_note text DEFAULT NULL)` | approve/void → fin_approve | – | `charge_status` |
| `list_client_charges` / `suggest_client_charges` | `(p_tx uuid)` | fin_read @tx | – | – |
| `record_charge_collection` | `(p_payload jsonb, p_idem_key uuid)` | fin_write @tx | ✓ | `collection_recorded` |
| `void_charge_collection` | `(p_id uuid, p_reason text)` | fin_approve | – | `collection_voided` |
| `create_demurrage_case` | `(p_payload jsonb, p_idem_key uuid)` | fin_write @tx | ✓ | `demurrage_created` |
| `update_demurrage_case` | `(p_id uuid, p_payload jsonb)` (open only) | fin_write | – | `demurrage_updated` |
| `set_demurrage_status` | `(p_id uuid, p_status text, p_note text)` (closed\|waived\|void\|open; waived/void → fin_approve) | fin_write | – | `demurrage_status` |
| `list_demurrage` | `(p_org uuid, p_filters jsonb)` | fin_read | – | – |
| `create_cost_adjustment` | `(p_payload jsonb, p_idem_key uuid)` | fin_write | ✓ | `adjustment_created` (if tx) |
| `review_cost_adjustment` | `(p_id uuid, p_decision text approved\|rejected, p_note text)` | fin_approve, four eyes | – | `adjustment_reviewed` |
| `list_cost_adjustments` | `(p_org uuid, p_filters jsonb)` | fin_read | – | – |
| `tx_costs` / `tx_margin` | `(p_tx uuid)` | fin_read @tx | – | – |
| `margin_report` / `cost_report` | `(p_org uuid, p_filters jsonb)` | fin_read | – | – |

- Payload keys are checked with `app.only_keys` (+ `idempotencyKey`). Ids come from `app.puuid`, text from `app.ptext`, numbers from `app.pnum`, dates from `app.pdate`.
- Lock order is fixed: transaction (`app.g3_lock_tx`) → invoice → line. This avoids deadlocks.
- **Errors:**
  - existing codes: `MRS_AUTH_REQUIRED, MRS_NOT_FOUND, MRS_FORBIDDEN ('role','finance','self_approval','party_finance'), MRS_INVALID, MRS_REQUIRED, MRS_BAD_TRANSITION, MRS_NOTE_REQUIRED, MRS_TOO_LONG`, idempotency codes;
  - **new:** `MRS_OVER_ALLOCATED` (allocation > line net), `MRS_OVERPAID` (payments > invoice total, collections > charge total);
  - duplicates follow the G3 convention: `MRS_INVALID '<x>_taken'` / `'file_duplicate'`.
- **Idempotency:**
  - the org passed to `idem_begin` is resolved from the payload's branch / transaction / invoice before the call;
  - a replay returns the first result;
  - the same key with a different payload gives `MRS_IDEMPOTENCY_CONFLICT`.
- **Audit:** `trg_audit` on all 10 new tables (`finance_documents, supplier_invoices, supplier_invoice_lines, cost_allocations, cost_accruals, supplier_payments, client_charges, charge_collections, demurrage_cases, cost_adjustments`) plus the existing one on parties. `trg_touch` on the tables that have `updated_at`.
- **Function privileges:** list every new `app.*` helper in one `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` block. Policy helpers that RLS calls as the invoker (`app.fin_can_read_invoice`, `app.fin_read_roles`) get `GRANT EXECUTE … TO authenticated`, like `has_tx_role`.

## Front end
### MarsaApi (supa.js): names are fixed
- `{data, error}`; idempotent calls go through the existing `idemRpc` (key kept across retries; `opts.idemKey`). Demo mode returns `MRS_DEMO_MODE`. `p_org` = the active org.
- **Party, files, invoices, lines:**
  - `savePartyFinance(partyId, p)`;
  - `uploadFinanceDocument({file, branchId, kind})`: sha256 in the browser → `register_finance_document` → `storage.from('finance').upload(path)` → `{data:{id, storage_path}}`;
  - `financeDocumentUrl(path, expiresIn)`, `voidFinanceDocument(id, reason)`;
  - `checkInvoiceDuplicate(p)`, `listSupplierInvoices(f)`, `getSupplierInvoice(id)`, `createSupplierInvoice(p, opts)`, `updateSupplierInvoice(id, p)`, `setSupplierInvoiceStatus(id, s, note)`;
  - `addInvoiceLines(invoiceId, lines, source, opts)`, `updateInvoiceLine(id, p)`, `reviewInvoiceLine(id, decision, note, serviceCode)`.
- **Allocations, accruals, payments:**
  - `allocateInvoiceLine(lineId, targets, opts)`, `approveAllocations(ids, note)`, `rejectAllocation(id, reason)`, `reverseAllocation(id, reason)`, `costReviewQueue(f)`;
  - `listAccruals(f)`, `createAccrual(p, opts)`, `reviewAccrualVariance(id, decision, note)`, `voidAccrual(id, reason)`;
  - `listSupplierPayments(f)`, `recordSupplierPayment(p, opts)`, `voidSupplierPayment(id, reason)`.
- **Charges, collections, demurrage, adjustments:**
  - `listClientCharges(txId)`, `suggestClientCharges(txId)`, `createClientCharge(p, opts)`, `updateClientCharge(id, p)`, `setChargeStatus(id, s, note)`;
  - `recordChargeCollection(p, opts)`, `voidChargeCollection(id, reason)`;
  - `listDemurrage(f)`, `createDemurrageCase(p, opts)`, `updateDemurrageCase(id, p)`, `setDemurrageStatus(id, s, note)`;
  - `listCostAdjustments(f)`, `createCostAdjustment(p, opts)`, `reviewCostAdjustment(id, decision, note)`.
- **Reports:** `txCosts(txId)`, `txMargin(txId)`, `marginReport(f)`, `costReport(f)`.
- Add Arabic + English messages for `MRS_OVER_ALLOCATED`, `MRS_OVERPAID`, and the details `invoice_number_taken`, `file_duplicate`, `self_approval`, `paid_by_client`, `charged_to_client`, `g5_only`, `lines_pending_review`, `lines_unallocated`, `original_file`, `late_cost`, `discrepancy`.

### Module hook and files
- The G3 hook is reused unchanged: `window.MarsaOps.views` / `.txSections`. Fin modules use the shared kit `MarsaOps.ui` from `assets/js/ops/alerts.js`.
- The original design classes are used: `card`, `card-stat adm-tile`, `table.table.table-striped.adm-table` in `.table-wrap`, `badge badge-*`, `btn`, `form-control`, `adm-dialog`, `adm-loading`.
- Script order in admin.html: … `ops/*.js` → `fin/invoices.js, fin/payables.js, fin/margins.js, fin/demurrage.js, fin/tx-fin.js` → `admin.js`. Also add `assets/i18n/fin.js` after `ops.js`, and `assets/css/pages/fin.css` after `ops.css`.
- **Views** (all `allow: 'finRead'`; write buttons are shown only for `can('finWrite', branchId)`, approve buttons only for `can('finApprove', branchId)`):

| Route | File | Label (ar / en) | Content |
|---|---|---|---|
| `#costs` | `assets/js/fin/invoices.js` | فواتير الموردين / Supplier invoices | Inbox with KPI tiles by status and payment status, plus filters. «فاتورة جديدة» dialog: upload the original → duplicate check (exact = blocking message, possible = warning with links) → header + line editor (add rows, paste from OCR text = `source 'ocr'`). |
| `#costs/review` | same | قائمة المراجعة / Review queue | `cost_review_queue`: lines to review, discrepancies, allocations awaiting approval (bulk approve), variances, adjustments. |
| `#costs/<invoiceId>` | same | تفاصيل الفاتورة / Invoice detail | Header + original file link (signed URL); discrepancy banner; possible-duplicates banner; lines table with `review_status` badges and reasons; review dialog; allocate dialog (find transaction by ref, then container / trip / demurrage case / matching-accrual pickers from `txCosts`, amount or share %, live remaining); allocations per line with approve / reject / reverse; payments panel; adjustments panel; status actions. |
| `#payables` | `assets/js/fin/payables.js` | المستحقات والمدفوعات / Payables & payments | Three separate tiles: due (approved, unpaid), paid by company, paid directly by client. Invoices by payment status and due date; payments list; record payment (evidence upload + reference, payer); void. |
| `#margins` | `assets/js/fin/margins.js` | الهامش والتكاليف / Margins & costs | A permanent «تحليلي — ليس ربحًا محاسبيًا» banner. Tab 1: `margin_report` table with level badges (مؤكد / تقديري / غير معروف) and pending counts. Tab 2: `cost_report` with a group-by selector (المعاملة / العميل / المورد / الخدمة / الفرع / مستوى التأكيد) and filters, per currency. |
| `#demurrage` | `assets/js/fin/demurrage.js` | الأرضيات والغرامات / Storage & demurrage | Cases list with the four figures + remaining; create / edit a case (link a G3 exception); record a client collection; status. |

- **Transaction-detail sections** (`assets/js/fin/tx-fin.js`, namespace `fintx`). Each renders nothing unless `api.can('finRead', tx.branch_id)`.
  - `fin-costs` (order 80) «التكاليف والمبالغ المحمّلة»: accruals (trip / demurrage / manual, with variance badges and review), approved / proposed allocations with invoice links, adjustments (create / review), client charges (create from manual / cost / markup / trip suggestion, approve, void, collections).
  - `fin-margin` (order 85) «الهامش التحليلي»: `tx_margin` per currency, level badge, pending list.
- **NAV** (`assets/js/app-shell.js`):
  - new group `{ id: 'finance', key: 'fin.nav_group' }` «المالية التشغيلية» between `ops` and `manage`;
  - items: `costs` (icon `receipt`), `payables` (`wallet`), `margins` (`chart`), `demurrage` (`clock`), all `allow: R.finRead`;
  - new icons are added to `ICONS` (constant SVG);
  - `OPS_NAV` fallback gets the `fin.nav_*` keys.
  - admin.js `NAV_ORDER` adds `'costs','payables','margins','demurrage'` after `'parties'`.
- **i18n:**
  - namespace `fin` in `assets/i18n/fin.js` (ar + en, also `window.MarsaFinDict`). Keys: `nav_group, nav_costs, nav_payables, nav_margins, nav_demurrage`, view strings, labels `<domain>_<code>` for every `fin_*` domain;
  - namespace `fintx` is registered inside `tx-fin.js`;
  - the `finance` event-type label + per-op labels go in admin.js `event_type` (ar/en).
- **Styles:** `assets/css/pages/fin.css`: level badges, discrepancy banner, line-review row tint, allocation remaining meter, the four-figure demurrage strip. Only the original tokens and classes from style.css are used.
- **Rule:** textContent / createElement only. Run `node --check` on every touched JS file.

## Tests (PGlite, same harness style as g3-tests.js)
**`supabase/tests/g4-tests.js`**, per table / RPC:
- **Isolation:** org B refused, other branch refused, `transport_staff` / `clearance_staff` / `operations_manager` / client get no rows and `MRS_FORBIDDEN` / `MRS_NOT_FOUND`. `supervisor` reads but cannot write.
- **Party finance:** a direct update of the guarded columns is refused; `save_party_finance` works.
- **Files:** the storage policies of the finance bucket hold; a duplicate sha256 is refused.
- **Invoices:** number normalization + hard duplicate; the same number reused after void is allowed; possible duplicates are reported; state machine; approval gates (file, lines, pending review, unallocated, discrepancy note); four eyes; edits locked after approval.
- **Lines:** auto-review reasons; never deleted (no DELETE grant, no RPC); excluded / overhead need a note.
- **Allocations:**
  - Σ cap (`MRS_OVER_ALLOCATED`), including two concurrent-style inserts in one transaction;
  - share rounding sums exactly to net;
  - cross-tx targets must belong to the same transaction (FK);
  - late flag + note + auto adjustment;
  - reverse.
- **Accruals:**
  - backfill count = non-cancelled trips;
  - in-place update while unmatched;
  - variance after match;
  - cancel → void / variance;
  - each review decision.
- **Payments:** partial / paid / client-direct status; overpay refused; client-direct on a charged reimbursable refused; void recomputes.
- **Charges:** price independence (no link to cost unless sourced); markup math; no double charge (unique); `paid_by_client` guard; `g5_only`.
- **Collections:** cap.
- **Demurrage:** four figures on fixed data.
- **Adjustments:** CHECKs (document link); duplicate approval voids; fee approval creates an accrual that a later invoice matches.
- **Reports:** `fin_cost_items` invariant; `tx_margin` exact numbers; `cost_report` each group_by + branch scope.
- **Idempotent replays** for every create RPC.
- **Migration:** re-run safety (apply the file twice; counts unchanged) and the preflight message.

**`supabase/tests/g4-cycle-tests.js`**, step ١٣ scenario on seed + G3 data.
1. TX-A (2 containers, 2 trips with agreed costs 800 + 800 SAR) and TX-B (1 trip, 500 SAR): 3 open accruals, `tx_margin` level estimated.
2. Carrier invoice C1 (3 lines 800 / 800 / 500 + VAT 15 %), each allocated to its trip with `accrual_id`, then approved. All accruals become `matched`, and TX-A cost = 1600 confirmed, **not 3200**.
3. **Duplicate invoice:** C1 (number `INV-0001`) re-entered as `inv 1` (same `number_norm` `INV1`) → `invoice_number_taken`. Then registered under a slightly different number with the same total/date: `possible_duplicates` is reported, a `duplicate_invoice` adjustment is approved, the copy becomes void, and costs are unchanged.
4. **Shared invoice:** a port-charges invoice P1 with one line of 1000, allocated 60 % TX-A / 40 % TX-B. A third allocation of 0.01 is refused. Σ = 1000 exactly.
5. **Partial payment:** C1 paid 50 % → `partial`, then the rest → `paid`; payables tiles show due / paid separately; an overpay attempt is refused.
6. **Paid directly by client:**
   - storage invoice S1 for TX-B, allocated to a demurrage case, paid with `payer='client'` → `paid_directly_by_client`;
   - `client_paid_direct` = S1, while company paid and cost confirmed exclude S1;
   - a reimbursable charge on it is refused;
   - the demurrage tracker shows `paid_by_client_to_operator` and `paid_to_operator = 0`.
7. **Trip cost change after matching:** a TX-A trip cost changes 800 → 950. The accrual goes to `variance` (`pending_amount 950`) and the cost stays 800 (the invoice). Review `keep_amount` → matched. Cancelling a matched trip → variance, never a negative or doubled cost.
8. Client charges for TX-A (service 2500 + reimbursable P1 share at cost) are approved, and a collection is recorded. `tx_margin` gives exact `margin_confirmed`, and `reimbursable_gap = 0`.
9. **Gate (exit criteria):**
   - for every invoice, Σ cost items = Σ non-excluded net;
   - for every transaction, Σ cost items = the expected fixed numbers;
   - no accrual and allocation are both counted for the same trip;
   - `supplier_payments` / `charge_collections` counts equal exactly the recorded actions (nothing auto-created);
   - Σ payments ≤ totals, Σ collections ≤ charges;
   - no amount appears in `transaction_events`;
   - the client sees 0 rows from every G4 table and RPC.
- The existing suites must stay green. Catalogs (`rls-tests.js` TENANT_TABLES + RPC catalog, `restore-drill.js` table list) are updated by the **integration step**, not by the build agents.

## Task split (file-disjoint OWNS lists)
- **DB**:
  - OWNS: `supabase/migrations/20261104000100_g4_costs.sql`, `supabase/tests/g4-tests.js`, `supabase/tests/g4-cycle-tests.js`.
  - Must not touch the G2 / G3 migrations or the other test files.
  - Run g4 suites + all existing suites (expect only the catalog failures in rls-tests / restore-drill for new objects) and report the numbers.
- **UI_CORE**:
  - OWNS: `assets/js/supa.js` (MarsaApi additions + error messages + finance upload / signed URL), `assets/js/admin.js` (R `finRead/finWrite/finApprove`, `OPS_SETS`, `NAV_ORDER`, `finance` event labels), `admin.html` (fin script/style tags), `assets/js/app-shell.js` (R + NAV group `finance` + icons + `OPS_NAV` fin fallback), `assets/js/fin/tx-fin.js` (tx sections `fin-costs`, `fin-margin`, own `fintx` strings).
  - jsdom smoke under `…/scratchpad/g4x/` (copy `integ/admin-stub.js`, `loader.js`).
- **UI_VIEWS**:
  - OWNS: `assets/js/fin/invoices.js`, `assets/js/fin/payables.js`, `assets/js/fin/margins.js`, `assets/js/fin/demurrage.js`, `assets/i18n/fin.js`, `assets/css/pages/fin.css`.
  - Codes against the MarsaApi names above. When a name is missing, it shows `ops.api_missing` instead of failing.
  - jsdom smoke for each view (ar + en) under `…/scratchpad/g4x/`.
- **Not owned by anyone in the build** (integration step):
  - `supabase/tests/rls-tests.js`, `supabase/tests/restore-drill.js`, `supabase/all_migrations.sql`;
  - docs (`ARCHITECTURE.md`, the G4 report, this spec's "As built");
  - `sw.js`, `portal.js` (no change: clients see nothing from G4).

## Not in G4 (explicitly)
- Ledger, journal entries, receipt / payment vouchers, tax invoices, Daftra sync (G5).
- Changes to `financial_status`.
- Automatic markup rules and FX conversion.
- OCR auto-extraction into lines (only "paste OCR text as lines, all `pending_review`").
- Client portal figures.

## As built (integration, 2026-11-04)
- **Files.** Migration `supabase/migrations/20261104000100_g4_costs.sql`; `supabase/all_migrations.sql` regenerated (same format, 14 files); tests `g4-tests.js`, `g4-cycle-tests.js`; catalogs updated in `rls-tests.js` (10 tables in `TENANT_TABLES` with org A / org B fixtures, 98 RPCs, a G4 client-visibility section) and `restore-drill.js` (G4 rows in the sample, post-restore G4 checks). `sw.js` precaches `fin/*.js`, `i18n/fin.js`, `fin.css` (VERSION `2026-11-04.1`).
- **Error details.** The existing id of `invoice_number_taken` / `file_duplicate` and the line numbers of `lines_pending_review` / `lines_unallocated` travel in the Postgres HINT; DETAIL keeps the code word. `MRS_OVER_ALLOCATED` / `MRS_OVERPAID` carry the remaining amount in DETAIL.
- **Payload whitelists (as built, binding for the UI).**
  - `create_accrual`: no `note` key (the table has no note column). The tx-section dialog no longer sends one.
  - `record_supplier_payment` / `record_charge_collection`: no `currency` (and no `transaction_id` on collections); both come from the invoice / charge.
  - `update_client_charge`: `description, vat_rate, service_code, container_id, note, quantity, unit_price, markup_pct` only. `kind` / `currency` / `source` are fixed at creation; quantity / unit price only on `manual` charges; `markup_pct` only on `markup` charges.
  - `cost_report` is not paged: no `limit` / `offset` (supa.js drops them).
- **DB behaviour beyond the spec text.** See the DB report: `app.fin_cost_items(p_org, p_tx DEFAULT NULL)`; `pending_review` lines count as unallocated items; credit-note items are negative; demurrage accrual variances use `amount_diff`; trip / demurrage accrual sync writes no events; an allocation naming a trip / case without `accrual_id` links that source's live accrual; voiding an invoice rejects its proposed allocations; every `set_charge_status` change needs fin_approve.
- **UI.** Shared helpers `MarsaOps.finUi` / `finKit()` live in `fin/invoices.js` (the other views need it loaded). Allocations are created from the invoice page only; the tx section shows demurrage figures read-only.

## As built — review fixes (2026-11-02)
Binding behaviour added after the G4 review (tests: `g4-tests.js` section `review_fixes`, 48 checks; jsdom `scratchpad/g4x/fix/ui-fixes.js`).
- **Isolation.**
  - `get_supplier_invoice.adjustments` applies `app.fin_can_read_adjustment` (a duplicate claim on another branch's invoice is not shown to a reader of the original only).
  - `app.fin_check_findoc(p_org, p_branch, p_id, p_field)`: a finance document is attached only to a record of its own branch — invoice branch (originals, payment evidence), transaction branch (collections), `coalesce(tx, invoice)` branch (adjustments). Mismatch → `MRS_INVALID '<field>'`.
  - Supervisors are org-wide (see Roles).
  - Readers carry the scope: allocation rows (`get_supplier_invoice`, `cost_review_queue`, `tx_costs`) have `branch_id` = `transaction_branch_id` and `can_approve` (`app.fin_can_decide`: fin_approve at the tx branch + four eyes); accrual / adjustment queue rows and invoice adjustments have `branch_id` + `can_review`; demurrage cases (`app.fin_case_json`), charges (`app.fin_charge_json`) and `list_client_charges` / `tx_costs` carry the transaction `branch_id`. The UI uses these flags (never "a role in any branch").
- **Credit notes.** Same currency as the original; Σ non-void credit notes ≤ the original total (`credit_exceeds_invoice`, hint = remaining). A credit-note line is never linked to a trip / case / accrual (`credit_note_link`); it reduces only a transaction holding approved allocations of the original, never below 0 (`credit_target`, re-checked at approval); reversing an original allocation under a credit → `credit_allocated`.
- **Payables.** `app.fin_invoice_payable` = total − approved credit notes (debit notes stay their own rows). It drives the overpay cap, `payment_status` and `due_approved_unpaid`; approving / un-approving / voiding a credit note recomputes its original. Paid above the payable is `supplier_credit_due` (never an error). Invoice rows carry `payable_amount`, `supplier_credit_due`.
- **Client-direct payments.** `payer='client'` needs a live allocation of that client on the invoice (`MRS_INVALID 'client_id'`) and is capped at the gross of those allocations (`MRS_OVERPAID`). `charged_to_client` covers every sourced charge of that client's allocations. Demurrage `paid_by_client_to_operator` uses the case client's share; company payments are spread over what clients did not pay.
- **Sources gone.** Pending type `charge_source_gone` (approved / invoiced charge whose accrual is void, allocation rejected / reversed, or trip cancelled). `void_accrual` / `reverse_allocation` refuse while a non-void charge references the row (`charged_to_client`).
- **Currencies.** Allocations to a case / trip need the case / trip cost currency (also with no live accrual); a charge on a case is in the case currency; a case currency change with linked allocations / charges → `currency_in_use`; `approve_allocations` re-checks the accrual currency (`MRS_INVALID 'currency'`). Demurrage figures sum only rows in the case currency.
- **Allocation without a source.** A transaction-only target is matched to the single open accrual of the same supplier + currency (+ service) on that transaction (`auto_accrual: true`); several → `MRS_REQUIRED 'accrual_id'` (hint = candidate ids) unless the target says `no_accrual: true`.
- **Files.** `register_finance_document` hands back the caller's own unattached registration of the same file (`reused: true`) instead of `file_duplicate`. Payment rows (`get_supplier_invoice`, `list_supplier_payments`) and `tx_costs.collections` carry `evidence_path`.
- **Migration.** Backfilled accruals are audited (trigger attached before the backfill). Re-runs recompute `number_norm` (preflight refuses a normalization collision). `all_migrations.sql` is for an empty database only; live staging uses `g4_apply.sql`.

## As built — documentation (2026-11-02)
Deviations still open at hand-over (report: `G4_REPORT_AR.md`; architecture: `ARCHITECTURE.md` §3, §4, §5, §8, §9, §15):
- **Dates.** The migration version and the integration heading say 2026-11-04. The hand-over date is 2026-11-02. `schema_versions` / `health_check()` report `20261104000100`, and `sw.js` VERSION is `2026-11-04.1`. Both are identifiers only.
- **UI gaps against the Front-end section.**
  - `savePartyFinance` exists in MarsaApi but no view calls it (party finance columns are server-only for now).
  - `supplier_credit_due` is returned but has no `#payables` tile.
  - `refId` from the HINT is not yet turned into an "open existing" link.
  - No UI action voids an unused registered file (the server hands it back with `reused: true`).
- **Open decisions beyond G4-1..9.** The report lists G4-10..15 as applied defaults: org-wide supervisors, operations_manager outside fin_read, `paid_by_client` blocking service / markup charges (owner to confirm), credit-note bounds, auto-link to the single matching accrual, invoice-number normalisation.
- **Tests at hand-over** (PGlite): rls-tests 1123/0 (1 warning), g2-tests 222/0, g2-ops-tests 110/0, restore-drill 22/0, g3-tests 578/0, g3-cycle-tests 70/0, g4-tests 300/0, g4-cycle-tests 87/0. The older `scratchpad/g4x/smoke-g4.js` keeps 4 assertions that contradict the payload whitelists above; `scratchpad/g4int/smoke-g4.js` is the current copy (122/122).
- **Not verified:** real Supabase / PostgREST / Storage (`finance` bucket uploads and signed URLs) and a real browser. The late-cost auto adjustment copies the invoice's `finance_document_id` even when the transaction is in another branch; this case is not checked.

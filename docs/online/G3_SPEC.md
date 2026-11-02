# G3 — clearance & transport operations (staging spec)

Source: execution plan §G3 steps 1–17 (goal: from opening the transaction to following up the empty container). Read first: `docs/online/ARCHITECTURE.md`, `docs/online/G2_SPEC.md` (conventions, roles, idempotency), `docs/online/APP_UI_SPEC.md` (app shell, superseded: the pages use the original efa96c9 design again). Staging only.

**Open G0 decisions:** G0 has not been formally closed, so the relationship rules below are the working assumptions. Each one is listed as an open owner decision in the G3 report. Nothing here hard-codes the Blue Sea tenant.

## Existing (reuse, don't rebuild)
- `clients`, `transactions` (fixed `ref`, `bl_number`, `declaration_no/date/type`, `operational_status` 10 stages, `financial_status`), `containers` (one row per container **visit** per transaction; `container_no` unique only inside a transaction; return_deadline / return_status / evidence doc), `documents` (versions, classification, void), `transaction_events` (append-only), `document_extractions` (OCR, human review), `audit_log`.
- Role helpers `app.has_branch_role / ops_writer_roles / transport_writer_roles / staff_roles`, including `branch_manager`. Idempotency: `app.idem_*`. Errors: `app.fail('MRS_*')`.

## Data model additions
Migration A, `supabase/migrations/20261103000100_g3_registry.sql`:
1. **`parties`** — the org's directory of operational counterparties (G4 extends it with supplier/finance data).
   - Fields: `id, org_id, kinds text[]` (subset of `shipping_agent, terminal_operator, carrier, yard, customs_broker, supplier, other`; one party may have several), `name_ar, name_en, cr_number, vat_number, phone, email, notes, is_active`, timestamps, `created_by`.
   - Constraint: unique `(org_id, lower(name_ar))`.
   - Children: `drivers(id, org_id, carrier_id → parties, full_name, phone, national_id_last4, license_no, is_active)` and `trucks(id, org_id, carrier_id, plate_no, plate_type, is_active)`, with unique `(org_id, plate_no)`.
   - Access: staff read; `transport_writer_roles` write; RLS; audit.
2. **Client identity (G3.2)** — `client_aliases(id, org_id, client_id, alias, alias_norm, source ('bl','invoice','manual','ocr'), created_by, created_at)`, unique `(org_id, alias_norm)`. Plus `match_client(p_org, p_payload {name, vat_number, cr_number})`, which returns ranked candidates:
   - exact VAT or CR → `strong`;
   - exact alias or normalized-name match → `alias`;
   - token similarity → `weak`, with the reasons.
   - Never auto-links; the UI shows conflicts for human choice.
   - `alias_norm` = lower, Arabic letters normalized (أإآ→ا، ة→ه، ى→ي), punctuation and company suffixes stripped (co, ltd, llc, est, مؤسسة, شركة).
3. **Customs declarations (G3.5)** — `customs_declarations(id, org_id, transaction_id, declaration_no, declaration_type, declaration_date, status ('draft','submitted','under_inspection','released','cancelled','replaced'), source ('manual','ocr','import','fasah'), source_document_id, corrected_at, cancelled_at, cancel_reason, replaced_by_id → customs_declarations, notes, created_by, timestamps)`.
   - Unique `(org_id, declaration_no)` among non-cancelled/replaced rows. A cancelled number can't be reused in the same org without an explicit replacement.
   - RPCs: `add_declaration(p_tx, p_payload, p_idem_key)`, `set_declaration_status(p_id, p_status, p_note)`, `cancel_declaration(p_id, p_reason, p_replacement jsonb DEFAULT NULL)` (cancel + optional new declaration linked via `replaced_by_id`, in one transaction), `correct_declaration(p_id, p_payload, p_reason)` (keeps before/after in audit_log; sets `corrected_at`).
   - Trigger keeps `transactions.declaration_no/date/type` mirrored from the latest **active** declaration, for backward compatibility. Every change emits a `transaction_events` row (`declaration`).
   - Backfill: existing `transactions.declaration_no` values become declaration rows.
4. **Bills of lading (G3.6)** — `bills_of_lading(id, org_id, bl_number, bl_type ('master','house','sea_waybill','awb','other'), shipping_agent_id → parties, carrier_name, vessel, voyage, port_of_loading, port_of_discharge, origin_country, goods_description, packages, gross_weight_kg, issued_at, notes, created_by, timestamps)`, unique `(org_id, bl_number, bl_type)`, plus the link `transaction_bls(transaction_id, bl_id, org_id, is_primary, created_at)`, many-to-many.
   - Rule: no 1:1 is forced (one B/L may feed several transactions, one transaction may have several B/Ls). `transactions.bl_number` stays mirrored from the primary B/L.
   - Backfill existing `bl_number`s.
   - RPCs: `save_bl(p_payload, p_idem_key)`, `link_bl(p_tx, p_bl, p_primary)`, `unlink_bl(p_tx, p_bl, p_reason)`.
5. **Containers (G3.7)** — add to `containers`: `bl_id` (nullable link to one of the transaction's B/Ls), `seal_no`, `size_type` (keep `container_type`), `gross_weight_kg`, `operational_state` ('expected','at_port','released','gated_out','delivered','empty_returned'), `visit_ref` (generated `<container_no>@<transaction ref>`).
   - A container number may repeat across transactions: that is legitimate and must stay allowed.
   - `container_history(p_org, p_container_no)` lists all visits.
6. **Completeness (G3.4)** — `transaction_completeness(p_tx)` returns `{score 0–100, missing:[{field|document, label_ar, label_en}], ready_for:[stage…]}` computed from data + documents + requirements (below). It never claims clearance readiness. The UI shows a progress ring and the list.

Migration B, `supabase/migrations/20261103000200_g3_operations.sql`:

7. **Document requirements (G3.10)** — `document_requirements(id, org_id, operation, mode, port NULL = any, document_kind, required_for_stage (operational_status code), is_active, note)`.
   - Seed sensible defaults per org through `app.seed_document_requirements(p_org)`, called for existing orgs and from `platform_create_org`:
     - import sea: bill_of_lading + commercial_invoice + packing_list before `customs_declaration`; certificate_of_origin before `customs_declaration` (optional flag); delivery_order before `appointment`; empty_return_receipt before `operationally_complete`.
     - air: awb as bill_of_lading kind.
   - `tx_checklist(p_tx)` → per requirement: satisfied / missing / unreviewed (a document counts only if its classification is confirmed or reclassified to that kind and it is not voided).
   - `set_transaction_status` refuses a forward move into stage S while a requirement for S is missing (`MRS_DOCS_MISSING`, detail = kinds). It blocks only that move, not the whole transaction; operations_manager / supervisor / admin may override with a mandatory reason, which is logged as an event.
   - Recreate `set_transaction_status` from its LATEST definition (G2 migrations 0200 + 0300, including idempotency and branch_manager) and only add this check.
8. **Port appointments (G3.11)** — `port_appointments(id, org_id, transaction_id, container_id NULL, terminal_party_id → parties, appointment_at timestamptz, window_minutes, appointment_no, driver_id, truck_id, status ('requested','confirmed','completed','missed','cancelled','rescheduled'), status_reason, rescheduled_from_id → port_appointments, created_by, timestamps)`.
   - Rescheduling creates a NEW row and marks the old one `rescheduled`, so the old appointment is never lost.
   - RPCs: `create_appointment(p_payload, p_idem_key)`, `reschedule_appointment(p_id, p_payload, p_reason, p_idem_key)`, `set_appointment_status(p_id, p_status, p_reason)`.
9. **Transport trips (G3.12)** — `transport_trips(id, org_id, transaction_id, container_id NULL, leg_no int, carrier_id → parties, driver_id, truck_id, origin, destination, planned_at, loaded_at, unloaded_at, status ('planned','dispatched','loaded','delivered','cancelled'), cost_amount numeric(12,2), cost_currency default 'SAR', sell_amount numeric(12,2), sell_currency, cost_basis ('agreed','estimated','invoice') , notes, created_by, timestamps)`.
   - Several legs per transaction or container are allowed.
   - The trip is separate from carrier payment and from the client price: no payment fields here (G4).
   - Cost and sell are visible only to finance roles + operations_manager / supervisor / admin / branch_manager. Use column grants plus a staff reader RPC, the same pattern as `staff_internal_fields`; transport_staff does not see sell_amount.
   - RPCs: `create_trip(p_payload, p_idem_key)`, `set_trip_status(p_id, p_status, p_at timestamptz, p_note)`, `update_trip(p_id, p_payload)`.
10. **Empty return (G3.13)** — add to `containers`: `return_yard_party_id → parties`, `return_instruction_document_id` (the Return Note = instruction, not proof), `evidence_received_at`.
    - Keep the existing proof rule: `returned_verified` needs a confirmed `empty_return_receipt` from the same transaction.
    - RPC `set_container_return(p_container, p_payload)` sets deadline / yard / location / instruction doc; the existing verify path stays.
11. **Operational exceptions (G3.14)** — `operational_exceptions(id, org_id, transaction_id, container_id NULL, kind ('declaration_cancelled','demurrage','detention_extension','customs_rejection','inspection','repair_fee','cleaning_fee','appointment_change','transport_change','other'), occurred_at, source ('manual','document','email','system'), document_id NULL, reason (required), amount numeric NULL, currency, status ('open','in_progress','resolved','waived'), resolved_at, resolved_by, resolution_note, created_by, timestamps)`.
    - Every exception has a source + date + reason (CHECK). A document link is optional, but `kind IN ('demurrage','repair_fee','cleaning_fee')` requires `document_id` or `amount`.
    - RPCs: `create_exception(p_payload, p_idem_key)`, `resolve_exception(p_id, p_status, p_note)`.
    - Cancelling a declaration through `cancel_declaration` auto-creates a `declaration_cancelled` exception.
12. **Operational alerts (G3.16)** — `operational_alerts(id, org_id, branch_id, transaction_id, container_id, kind ('docs_missing','appointment_soon','appointment_missed','empty_return_due','empty_return_overdue','exception_open','declaration_stalled'), severity ('info','warning','critical'), title_ar, title_en, due_at, status ('open','acknowledged','resolved'), dedupe_key unique per org, first_seen_at, last_seen_at, acknowledged_by/at, resolved_by/at, resolution ('auto','manual'), note)`.
    - `refresh_alerts(p_org)`: idempotent upsert by dedupe_key. It auto-resolves alerts whose cause is gone. Viewing never closes an alert; acknowledging keeps it open until the cause is fixed or someone resolves it manually with a note.
    - Schedule it with pg_cron every 15 min if the extension exists. It is also callable by staff (rate-limited to once / minute / org).
    - Reader: `list_alerts(p_org, p_filters)`, branch-scoped via RLS. Actions: `ack_alert(p_id)`, `resolve_alert(p_id, p_note)`.

All new tables:
- `org_id` + composite FKs `(x_id, org_id)` to parents; RLS with branch scoping through the parent transaction (`app.has_tx_role` / `has_branch_role`); audit trigger.
- Added to the test catalogs. Writes go through RPCs when there is a state machine; simple directories (parties/drivers/trucks/aliases/requirements) may use RLS-guarded direct writes.
- Every state change on a transaction child emits a `transaction_events` row. The client sees only `visible_to_client` events: status, appointment confirmed (time only), container returned.

## Client visibility (portal)
Clients see their transactions':
- declaration number + status;
- B/L numbers;
- containers with operational_state / return status / deadline;
- confirmed appointment times.

Clients never see:
- costs, sell prices, drivers' national ID, internal notes, exceptions, alerts.

Extend existing client policies accordingly. Only `portal.js` read additions are needed.

## Front end
### MarsaApi (supa.js) — names are fixed
`listParties(f)`, `saveParty(p)`, `listDrivers(carrierId)`, `saveDriver(p)`, `listTrucks(carrierId)`, `saveTruck(p)`, `listClientAliases(clientId)`, `addClientAlias(clientId, alias, source)`, `removeClientAlias(id)`, `matchClient(payload)`, `listDeclarations(txId)`, `addDeclaration(txId, p)`, `setDeclarationStatus(id, s, note)`, `cancelDeclaration(id, reason, replacement)`, `correctDeclaration(id, p, reason)`, `listBLs(txId)`, `saveBL(p)`, `linkBL(txId, blId, primary)`, `unlinkBL(txId, blId, reason)`, `updateContainer(id, patch)`, `containerHistory(no)`, `txCompleteness(txId)`, `txChecklist(txId)`, `listRequirements()`, `saveRequirement(p)`, `listAppointments(f)`, `createAppointment(p)`, `rescheduleAppointment(id, p, reason)`, `setAppointmentStatus(id, s, reason)`, `listTrips(f)`, `createTrip(p)`, `updateTrip(id, p)`, `setTripStatus(id, s, at, note)`, `tripFinance(ids)`, `setContainerReturn(id, p)`, `listExceptions(f)`, `createException(p)`, `resolveException(id, s, note)`, `listAlerts(f)`, `ackAlert(id)`, `resolveAlert(id, note)`, `refreshAlerts()`.
- All of them return `{data, error}`; idempotent ones keep the key across retries (existing helper).
- Demo mode returns `MRS_DEMO_MODE`.
- `globalSearch` also matches declarations (any status) and B/L numbers from the new tables.

### Module hook (so several files can add UI without editing admin.js concurrently)
```js
window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
// a full admin view (route #<id>, optional #<id>/<param>)
MarsaOps.views.alerts = { allow: 'staff', titleKey: 'ops.nav_alerts', render: function (root, api, param) { … } };
// a section inside the transaction detail (#tx/<id>), sorted by order
MarsaOps.txSections.push({ id: 'declarations', order: 20, render: function (root, tx, api) { … } });
// api = { orgId, roles, can(setName), t(key, vars), el(tag, attrs, children), toast, confirm, modal, go(hash), refresh(), MarsaApi, label(domain, code), fmtDate, fmtMoney }
```
- admin.js loads after the ops modules, merges `MarsaOps.views` into its routing (VIEWS + R sets: `staff`, `opsWriter`, `transportWriter`, `orgAdmin`, `finance`), and renders `txSections` in the transaction detail after its own sections.
- Module files: `assets/js/ops/tx-sections.js`, `assets/js/ops/alerts.js`, `assets/js/ops/schedule.js`, `assets/js/ops/parties.js`, `assets/js/ops/exceptions.js`, `assets/js/ops/requirements.js`.
- Strings: `assets/i18n/ops.js` (ar+en). Styles: `assets/css/pages/ops.css`.

### UI scope
- **Transaction detail** (tx-sections.js):
  - completeness ring + missing list;
  - document checklist per stage with an upload / classify shortcut;
  - declarations timeline (add, status, correct, cancel + replace);
  - B/Ls (link existing / create, primary);
  - containers table with operational state, seal, B/L, visit history link, empty-return panel (deadline, yard, instruction doc, evidence status);
  - appointments (create, confirm, reschedule with reason showing the chain, cancel);
  - trips (legs, carrier / driver / truck pickers, statuses, cost/sell only for allowed roles);
  - exceptions (create / resolve).
- **New views:**
  - `#alerts`: inbox grouped by severity and due date; filters; ack / resolve; "refresh now".
  - `#schedule`: today / week board of appointments and trips; filters by terminal, carrier, status.
  - `#parties`: directory with kinds, drivers and trucks sub-lists.
  - `#exceptions`: list + filters.
  - `#requirements`: org admin edits the document rules.
- Client detail: aliases list + add.
- Request conversion and transaction creation call `matchClient` and show candidates / conflicts before linking (G3.2). Creating a transaction from a B/L or partial data is allowed (G3.4).
- **Dashboard:** add alert counts by severity and today's appointments to the KPI row (data from listAlerts / listAppointments).
- **Shell NAV** (`assets/js/app-shell.js`): new group «العمليات»: التنبيهات (badge with open count), الجدول اليومي, الاستثناءات, الجهات والناقلون, plus «قواعد المستندات» under الإدارة. Role sets as above.

## Tests (PGlite, same harness style)
- `supabase/tests/g3-tests.js` — per table/RPC:
  - isolation (org B and other branch refused);
  - state rules: cancelled declaration number reuse, replacement chain, reschedule keeps the old row, trip cost hidden from transport_staff and clients, exception CHECKs, B/L many-to-many, container repeat across transactions allowed / within one refused;
  - alerts: dedupe, auto-resolve, ack keeps it open;
  - `MRS_DOCS_MISSING` blocks only that transition, and override needs a reason;
  - match_client never links;
  - client sees only allowed fields;
  - idempotent replays.
- `supabase/tests/g3-cycle-tests.js` — G3.17 end-to-end scenario:
  - request → transaction from a B/L with 3 containers;
  - documents uploaded and classified;
  - declaration added, then cancelled and replaced;
  - appointments incl. a reschedule;
  - two transport legs;
  - one container returned with valid evidence, one with only a Return Note (refused), one waived;
  - exceptions;
  - alerts appearing and auto-resolving;
  - the transaction reaches `operationally_complete`.
  - Finally compare every record: nothing lost, no duplicates.
- Existing suites must stay green: `rls-tests.js`, `g2-tests.js`, `g2-ops-tests.js`, `restore-drill.js` (update catalogs for new tables / RPCs).

## As built (2026-11-02) — real deviations from the text above
Only where the implementation differs from a line above. Details, test numbers and owner decisions: `docs/online/G3_REPORT_AR.md`.
- **`set_transaction_status`** (item 7). The override is not "senior role + reason". It needs an explicit new last parameter `p_docs_override boolean DEFAULT false`, so the signature is `(uuid, text, text, uuid, boolean)` and the 4-argument version is dropped.
  - A note alone never overrides.
  - The flag from a non-senior role gives `MRS_FORBIDDEN 'docs_override'`, and the flag without a reason gives `MRS_NOTE_REQUIRED 'docs_override'`.
  - The flag is part of the idempotency hash. The result carries `docs_override` (the kinds that were overridden).
  - `branch_manager` counts as a senior role (`app.senior_ops_roles`).
  - The gate also covers a forward move *past* stage S, not only into it.
  - `20261102000200` / `0300` gained rerun guards so a re-run of those files cannot leave an ambiguous or downgraded overload.
- **`document_requirements`** has an extra `is_optional` column. Optional rules show in the checklist and never block; certificate_of_origin is seeded optional. Defaults are 15 rules: import sea / air / land and export. `tx_checklist` also returns `not_applicable` (empty_return_receipt when no container needs one). Only the org `admin` edits rules (RLS direct writes, no DELETE).
- **`seed.sql` does not call `app.seed_document_requirements`.** On a fresh database the seed org has no rules, so the gate is open. Existing orgs get their rules when migration B runs.
- **`transaction_completeness`** also returns `ready_limit`. No stage after `customs_declaration` appears in `ready_for` until a declaration is `released` (`ready_limit = 'declaration_release'`). The score is unchanged.
- **B/Ls** (item 4): branch-scoped through the transactions they feed (`app.can_read_bl`).
  - A not-yet-linked B/L is readable by the org's ops writers.
  - `save_bl` on a number held by another branch gives `MRS_FORBIDDEN 'bl_other_branch'`, and `link_bl` on an unreadable B/L gives `MRS_NOT_FOUND 'bl'`.
  - A client reads a B/L only while every linked transaction is theirs, so a deliberate cross-client share is flagged (`shared_with_other_client`) and hidden from both clients.
  - Legacy `bl_number` adoption never reuses another client's or branch's B/L. It writes an internal bl `conflict` event and keeps the plain number.
  - A stale or cleared `bl_number` demotes the old primary; links are never deleted.
  - A legacy number becomes `bl_type 'other'`, or `'awb'` for air.
- **Declarations through the transaction record:** renumbering gives `MRS_BAD_TRANSITION 'use_correct_declaration'`, and clearing gives `'use_cancel_declaration'`. A change of date or type only is corrected in place, with a legacy_edit event. Backfilled declarations keep the legacy `created_at` / `updated_at`.
- **Migration A** starts with a read-only preflight. It lists normalized declaration-number collisions and stops before any DDL. A creates `cancel_declaration` / `transaction_completeness` only while B is not applied.
- **Containers.** `operational_state = 'empty_returned'` requires `return_status` `returned_verified` or `waived`, and falls back when verification is undone. `evidence_received_at` is stamped by the server and is not a `set_container_return` key.
- **Appointments.** Client events carry time, window, container number and an opaque `appointment_ref`. A confirmed slot that later becomes rescheduled, cancelled or missed emits a client-visible `withdrawn`; `completed` emits `completed`. This goes slightly beyond "time only". `missed` requires a reason.
- **Trips.** `cost_*` / `sell_*` / `cost_basis` are outside the SELECT grant. Writing them through `create_trip` / `update_trip` needs `trip_finance_roles` (`MRS_FORBIDDEN 'cost'`). `update_trip` locks with `staff_roles`, so an accountant may set money fields.
- **Alerts.**
  - Branch scope uses the alert's transaction (`app.has_tx_role`), not its stored `branch_id`. `trg_alert_branch` moves `branch_id` on a branch change and reopens acknowledged / manually resolved alerts whose cause is still active.
  - `list_alerts` caps `limit` at 200 and returns `{items, counts, total, limit, offset}`. `count_only` is client-side in `MarsaApi.listAlerts`.
  - `refresh_alerts` returns `opened` / `resolved`, or `{refreshed:false, rate_limited:true, retry_after_seconds}`.
  - Thresholds: appointment soon = 24 h; empty return due = 3 days; declaration stalled = 3 days without a change.
- **`operational_alert_runs`** (internal, `NO_API_TABLES`) holds the per-org refresh rate limit.
- **UI.**
  - The portal reads appointment times from events, because clients cannot read `port_appointments`.
  - The alerts view pages at 200 and filters severity / kind on loaded rows. The edit form no longer has declaration fields and sends changed keys only.
  - The docs-override dialog is the only sender of `docsOverride`.
  - `admin.js` `renderOpsView` returns the root before the module promise resolves.
  - `sw.js` was not updated: the ops files are not precached and `VERSION` is unchanged.
- **Not delivered** (plan steps, see the report):
  - an importer-number field on clients;
  - OCR fields flowing into declarations / B/Ls;
  - a task entity;
  - alert notifications;
  - removing the request-conversion "automatic" client match (owner decision G3-14).

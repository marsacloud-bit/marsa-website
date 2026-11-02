# Finance and billing

For accountants and accounts managers (and branch managers in their branch, and the organization admin). Screens are in the "Staff console", group "Operating finance". Back to the [guide index](index.md).

> Two fixed rules: **an invoice does not prove payment**, and **the margin is analytical, not accounting profit**. Every amount stays in its own currency; there is no FX conversion.

## How do I record a supplier invoice?

1. Open "Supplier invoices" → new invoice: supplier, invoice number, date, currency and the original (PDF or image up to 25 MB; approval needs the original).
2. Add the lines. A saved line is never deleted; a wrong line is reviewed as excluded with a note.
3. If the header differs from the sum of the lines, the difference is shown and never fixed silently: correct it, or give a reason when approving.
4. Four eyes: nobody approves what they created themselves (except the organization admin).

## How do I allocate a cost to a transaction?

1. On the transaction page, section "Costs & client charges" → "Supplier-invoice allocations".
2. Allocate the line to the transaction (or a container), then "Approve cost allocation" or "Approve proposed".
3. To correct: "Reverse an approved allocation", then allocate again. Allocations never exceed the line's net amount.
4. The "Review queue" gathers what needs a decision: lines to review, differences, allocations awaiting approval, expected-cost differences.

## How do I record an expected cost or an exceptional fee?

- "Manual expected cost": e.g. an agreed trip cost; matched with the invoice at approval instead of being counted twice.
- "Fee / adjustment": extra fees or exceptional adjustments, reviewed and approved.
- "Storage & demurrage" (`admin.html#demurrage`): storage, demurrage and detention cases with four separate figures: charged to the client, collected from the client, paid to the operator, and remaining. A client collection does not mean the operator was paid.

## How do I charge the client?

1. In "Client charges" click "Client charge".
2. Choose the method: manual, at cost, markup, or the trip sell price. Suggestions help; you can still enter a manual price.
3. Approve the charge (someone other than its creator). Only approved charges reach billing.
4. "Record client collection" records the collection evidence (receipt or transfer image).

## How do I follow payables and payments?

"Payables & payments" has two tabs: "Awaiting payment" and "Payments log". Three separate figures that are never added up: due to suppliers, paid by the company, and paid by the client directly to the supplier. A payment is evidence only (reference or file); voiding needs the approve role and a reason.

## How do I prepare the client invoice in Daftra?

1. On the transaction page, section "Invoices & Daftra" → "New billing intent" (one final invoice per transaction and currency; a supplementary one only after the final is issued).
2. "Add unbilled" adds the approved, not yet billed charges in the same currency.
3. Check the "Invoice intent" page: anything that blocks the push is shown in red.
4. "Push to Daftra" requests a **draft** in Daftra. Clicking twice does not create a second job.
5. The accountant issues the invoice inside Daftra. Then "Refresh status from Daftra" brings the invoice number, status and payment as Daftra shows them.
6. "Sync queue & review" shows every attempt with its request and response, and what needs a human decision.

> Charges after issue go to a supplementary invoice; an issued invoice is never changed from MARSA. Daftra is the source of the official figures.

## How do I set up Daftra?

Accounts manager and organization admin, from "Daftra settings" with tabs "Connection", "Clients" and "Items":

1. "Connection": mode (mock), subdomain, sync on / off, tax settings. Then "Probe capabilities".
2. "Clients": link a MARSA client to a Daftra client (optional; the push searches by reference, then creates). Differences are shown for review and never overwritten automatically on either side.
3. "Items": one item key per Daftra product.

> No API key is stored here, and there is no field to enter one.

## How do I read margins and reports?

- "Margins & costs": "Transaction margins" per transaction and currency with a level (confirmed / estimated / unknown), and the "Cost report" grouped by transaction, client, supplier, service or branch.
- "Overview → Finance": official invoice figures from Daftra only; drafts are shown apart as "in preparation — not official".
- "Reports → Profitability (analytical)" and "Costs (analytical)" with exports that match the screen.

## What the system does not do

- It never issues an official invoice: it prepares a draft only; issuing happens in Daftra.
- It does not connect to a real Daftra account in staging: the mode is a **mock** and sync jobs stay "queued" unless the worker runs.
- It never infers payment from an invoice status; payment comes from payment records or from Daftra.
- It never converts currencies or adds amounts in different currencies.
- It does not bill the subscription itself (plan billing is deferred).

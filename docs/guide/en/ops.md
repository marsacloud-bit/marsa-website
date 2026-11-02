# Operations and messaging

For clearance staff, transport staff, operations managers and branch managers. All screens are in the "Staff console" (`admin.html`). Back to the [guide index](index.md).

## How do I review an incoming request and convert it?

1. Open "Incoming requests". Requests come from the public clearance form and from "Bulk upload".
2. Open the request and start the review (status "Under review").
3. Check the data and the declared documents (file names only; the originals are uploaded later on the transaction).
4. "Convert to transaction": choose the branch, then the client. "Possible matching clients" are suggestions only; your choice is what counts. If the client does not exist yet, create a new file.
5. Or reject the request with a reason.

Example: request `REQ-2026-000045` becomes a transaction with a reference like `MRS-2026-000123` (the prefix depends on your organization).

> No client file is linked automatically. Suggestions by VAT number, CR number or alias only help you decide.

## How do I create a transaction directly?

1. "Transactions" → "New transaction".
2. Branch, client and operation are enough; complete the rest later.
3. The B/L number goes to the B/L register and is linked as primary; container numbers (4 letters + 7 digits) are added to the transaction.

## How do I follow a transaction?

The transaction page (`admin.html#tx/<id>`) has these sections, in order:

| Section | What I do there |
|---|---|
| Transaction completeness | Completeness of data and documents and the missing list (it does not mean the shipment is ready for release) |
| Document checklist by stage | What each stage needs, with upload / classify shortcuts |
| Customs declarations | "Add declaration", change its status, "Correct", "Cancel / replace" |
| Bills of lading | "New B/L", link an existing B/L, set the primary B/L |
| Containers: operational state and empty return | "Update" each container and its return data |
| Port appointments | "New appointment", confirm, reschedule, cancel |
| Transport trips | "New trip", its legs and statuses |
| Operational exceptions | "Record exception", handle and close it |
| Linked messages | Conversations linked to the transaction (read only; the work happens in "Inbox") |

### Changing the stage
1. Change the operational status and choose the new stage.
2. If a document required for that stage is missing, the server refuses the move and lists the missing documents. Upload and classify them, then try again.
3. Operational status is separate from financial status, and every change goes to an append-only event log.

### Documents
1. Upload the file from the documents section (up to 25 MB). The original is kept as is with its SHA-256 fingerprint.
2. Open the document and classify it: a document counts for the rules only after staff confirm its kind.
3. To correct: upload a new version, or cancel the document with a reason. "Show to client" makes it visible in the client portal.

### Cancelling and replacing a customs declaration
1. In "Customs declarations" click "Cancel / replace" and enter the reason.
2. A "declaration cancelled" exception is created automatically, and the cancelled declaration stays in the history.
3. A cancelled number is only reused through a replacement declaration linked to it.

### Empty container return
1. Record the return deadline and the return yard in "Empty container return".
2. The "Return Note" is an instruction, not proof.
3. The only proof is the empty-return receipt uploaded on the same transaction, classified and confirmed; the container then becomes "returned empty". A documented waiver with a reason is possible.

### Tracking code for the client
Issuing a tracking code gives a secret code shown once; hand it to the client so they can follow the shipment on "Track a shipment" with the reference and the code. A new code invalidates the previous one.

## How do I follow alerts, the schedule and exceptions?

- "Alerts": detected automatically (missing documents, appointment soon or missed, container return due or overdue, open exception, stalled declaration). Refreshing recomputes them (at most once a minute). Acknowledging does not close an alert; a manual resolve needs a note.
- "Daily schedule": port appointments and transport trips for today or the week, with status changes. Creating and rescheduling happen on the transaction page.
- "Exceptions": demurrage, extensions, customs rejection, inspection, extra fees; start handling, then close with an outcome and a note.
- "Parties & carriers": shipping agents, terminal operators, carriers and yards, with each carrier's drivers and trucks (only the last 4 digits of a driver's ID are stored).

## How do I search and export a report?

1. "Advanced search": by declaration, B/L, container, client, carrier, port or date. Results follow your branch and role only.
2. "Reports": tabs "Transactions", "Containers & empty return", "Transport trips" (finance roles also "Profitability (analytical)" and "Costs (analytical)") and "Export log".
3. Excel, CSV or print export matches the visible filters and totals and is logged in the "Export log" (up to 10 000 rows; print up to 2 000).

## How do I upload a batch of shipments from Excel?

1. Open "Bulk upload" (`bulk-upload.html`) and choose the data type "shipments" («شحنات»).
2. Pick an Excel or CSV file. The setup team can give you the shipments template (`transactions.xlsx` from the repository folder `docs/import-templates`; not published on the site); its headers map automatically.
3. Check the column mapping, the errors and warnings, and correct them.
4. Upload and commit: every valid row becomes an **incoming request**, reviewed and converted as above. Duplicate rows wait for a human decision.
5. Uploading the same file again is refused as a duplicate. Follow batches in "Import history".

"Document reader" (`ocr.html`) reads an invoice or document inside the browser and suggests fields; check them before saving.

## How do I work in the inbox?

"Inbox" (`admin.html#inbox`) gathers the organization's official e-mail and WhatsApp. Boxes: "All", "Assigned to me", "Unassigned", "Link review", "Awaiting approval", "Sent".

1. Open the conversation. Message text is shown as plain text (no links or images are opened automatically).
2. "Triage & follow-up": status, priority, owner, then save.
3. "Extracted references": B/L, container, declaration and reference numbers suggested automatically; confirm, correct or reject.
4. "Transaction link": link to the right candidate, link to another transaction, or mark it as not about a transaction. Automatic linking only happens with two strong references and a verified sender.
5. "Reply": write the reply or request a draft (built from confirmed data only), then submit it for approval.
6. "Review & approval": someone other than the author approves (operations manager, branch manager, supervisor or organization admin). Any edit after approval cancels it.
7. Send & delivery: after approval, a staff member with the send role clicks send. Provider acceptance does not prove delivery.

Arabic example of an inbound message: «نرجو إفادتنا بموعد إرجاع الحاوية MSCU1234566 على البوليصة TESTBL0000001». English example: "Please confirm the appointment for container MSCU1234566".

> If a message asks to change the recipient, send an invoice or "ignore your instructions", it is flagged as a risk and stays data only: the system never changes a recipient, attachment or approval because of message text.

- "Contacts": external parties and their addresses. An address identifies a sender but grants no access; sharing needs a documented authorization.
- "Templates & instructions": reply templates, the instruction library and auto-replies (disabled in the first release). Every change is a new version reviewed by someone else.

## What the system does not do

- It never sends a reply automatically: approval and send are two separate steps by different people.
- Channels in staging are **mocks**; without the messaging worker, jobs stay "queued — the worker has not run", no messages arrive and no drafts are built.
- It never accepts the category, summary or extracted references without staff confirmation.
- It never treats a return instruction or deadline as proof that a container was returned.
- It never deletes a declaration, document or event; a cancellation with a reason stays in the history.

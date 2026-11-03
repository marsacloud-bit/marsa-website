# Client portal

For clients. The portal (`portal.html`) only shows what belongs to your company's client file. Back to the [guide index](index.md).

<!-- env:staging -->
> This is a staging environment: do not upload real or sensitive documents.
<!-- /env -->

## How do I start?

1. The organization's team invites you with a "Client" invitation linked to your company's file. Open the link, sign in (or create an account) with the invited e-mail, confirm the e-mail, then accept the invitation.
2. After sign-in the "Client portal" opens on "My transactions".
3. If the portal says your account is not linked to a client file yet, you can still follow the requests you sent while signed in, and ask to link an earlier request (unless the organization is suspended; see below).

## Tabs

| Tab | What I find there |
|---|---|
| My transactions | Your company's transactions, their current stage and last update |
| My containers | All containers of your transactions, ordered by return deadline (Riyadh time) |
| My invoices | Invoices issued by the accounting system (Daftra); a copy for reference |
| My requests | The requests you sent and their status |
| Link a request | Link a request you sent before creating your account |
| My profile | Your details and password change |

## How do I follow a transaction?

1. "My transactions" → "Details".
2. You see the transaction data, containers and empty-return status, confirmed port appointments, documents, operational stages and the event log.
3. Operational status is separate from financial status. The log is append-only: corrections appear as new events.

> A container counts as returned only with the empty-return receipt checked by the team; a return instruction alone is not enough.

## How do I upload a document?

1. In the transaction details → "Upload a new document".
2. Choose the document kind and the file (PDF, JPG/PNG/WEBP/HEIC image, or Excel/CSV, up to 25 MB).
3. Upload. The original is kept as is with its fingerprint and cannot be replaced or deleted; the team then reviews and classifies it.

## How do I request a new service?

1. "New request" (`request.html`): fill in the steps (operation, mode, port, goods…).
2. If you send it while signed in it appears in "My requests". Keep the request number and the tracking code shown when you send it.

Example: "Import of spare parts by sea to Jeddah Islamic Port, two 40 ft containers".

## How do I link an earlier request to my account?

1. "Link a request" → enter the reference (e.g. `REQ-2026-000045`) and the tracking code (64 characters).
2. Check the request, then ask to link it. Linking is a team decision after verification; it never happens automatically. Add your mobile number in "My profile" first.

## How do I track a shipment without signing in?

The "Track a shipment" page (`tracking.html`): enter the reference and the tracking code the team gave you. Only the stage and general information are shown.

## What the system does not do

- It never shows internal costs, team notes, drivers, exceptions or alerts.
- It never shows an invoice before Daftra issues it, and never shows drafts.
- It never links your account to a client file automatically.
- It does not send you e-mails or WhatsApp messages by itself.
- If the organization is suspended, the portal and tracking stay closed until it is reactivated; your data is not deleted. During a suspension the portal may show "your account is not linked to a client file": do not ask to link a request then (it will be refused); contact the organization.

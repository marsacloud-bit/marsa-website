# MARSA user guide

MARSA is a platform for customs-clearance and transport work: from the client's request to the customs declaration, containers, transport, empty return, costs, the Daftra draft invoice and reports.

<!-- env:staging -->
> This is a staging environment: test data only. Do not upload real or sensitive documents, and do not reuse a password from another service.
<!-- /env -->

## Guides

| Guide | For |
|---|---|
| [Organization administration](admin.md) | Organization admin, branch manager, supervisor |
| [Operations and messaging](ops.md) | Clearance staff, transport staff, operations manager |
| [Finance and billing](finance.md) | Accountant, accounts manager |
| [Client portal](client-portal.md) | Clients |
| [Platform admin](platform.md) | Platform admins (organizations and plans) |

## How do I sign in?

1. Open the sign-in page (`login.html`).
2. Choose "Staff sign-in" if you are staff, or the client sign-in if you are a client.
3. Enter your e-mail and password. Staff land on the "Staff console", clients on the "Client portal".
4. If you received an invitation: open the invitation link, sign in (or create an account) **with the invited e-mail**, confirm the e-mail, then accept the invitation.

> The system never sends invitation e-mails. The link is shown once to the person who created it, and they send it to you themselves.

## How do I find my way around?

- The side navigation of the "Staff console" only shows **the sections your role allows**: "Workspace", "Operations", "Reports & search", "Communications", "Operating finance", "Administration" and "Help" ("User guide").
- Search and commands: press `Ctrl+K` (`⌘K` on a Mac) and type a section, reference, B/L, declaration, container or client.
- "Active organization": if you belong to more than one organization, pick it in the switcher at the top. Everything you see afterwards belongs to that organization only.
- Language: use the language switch ("Switch to Arabic" in the command palette). This guide follows the interface language.

## Roles in short

| Role | Main work |
|---|---|
| Organization admin | Everything inside the organization: settings, branches, members, document rules, channels |
| Branch manager | Works like an operations manager inside the branch; invites the branch's staff and portal clients |
| Supervisor | Reads all operational sections, approves replies, sees the audit log; does not triage messages or approve money |
| Operations manager | Requests, transactions, operations, reply approval |
| Clearance staff | Requests, transactions, declarations, documents, sending approved replies |
| Transport staff | Containers, appointments, transport trips |
| Accountant | Supplier invoices, costs, client charges, billing intents |
| Accounts manager | Everything the accountant does + approvals + Daftra settings |
| Client | The client portal only: own transactions, containers, issued invoices, documents |

> The interface hides what your role cannot do, but **the database decides** every action. "You are not allowed to perform this action" means the server refused and nothing was saved.

## Common messages

| Message | Meaning |
|---|---|
| "The result could not be confirmed because the connection dropped…" | Retry safely; no duplicate will be created |
| "Your organization reached its plan limit (…). Nothing was saved." | The plan does not allow another record of this kind; the organization admin contacts the platform team |
| "The organization's subscription is not active (…)." | The trial period has ended: you can view and update data but cannot create new records. If the organization is suspended or cancelled, access is blocked entirely for staff and clients (data kept) until the platform team reactivates it — in that case staff see the general "no permission" page, not this message |

## What the system does not do

- It never sends an e-mail or WhatsApp message by itself. Every reply needs an approval and then a separate manual send, and while the channel is in **mock** mode nothing actually leaves.
- It does not connect to a real Daftra account while the connection is in mock mode: the connection is a **mock** and sync jobs stay "queued" unless the worker runs.
- It never treats automatic analysis (category, extracted references, summary, draft) as fact before a staff member confirms it.
- It never deletes records: a correction is a new record or a cancellation with a reason, and everything stays in the history.

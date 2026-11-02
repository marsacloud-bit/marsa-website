# Organization administration

For the organization admin, the branch manager (own branch only) and the supervisor (read only). All screens are in the "Staff console" (`admin.html`), group "Administration". Back to the [guide index](index.md).

## How do I review the organization's data?

1. Open "Organization" (`admin.html#org`). It has two parts: "Fixed identity" and "Settings".
2. "Slug", "Reference prefix" and "Environment" cannot be changed here (the platform admin sets them at creation).
3. Edit "Arabic name", "English name", "Default language", "Brand color" (format `#rrggbb`, e.g. `#0B3A6E`), "Contact phone", "Contact e-mail" and the address, then "Save".
4. "Accept requests from the public forms": when off, the server rejects public clearance requests and contact messages for this organization.

> Every change is written to the "Audit log" with before and after values.

## How do I add or deactivate a branch?

1. Open "Branches" → "Add branch".
2. Enter the "Branch code" (2–10 uppercase letters or digits, e.g. `JED`), the Arabic and English names and the city.
3. The code cannot change after creation. Use "Deactivate" to stop a branch; the last active branch cannot be deactivated.

> If a plan-limit message appears when adding or reactivating a branch, the active branches reached the organization's plan limit. Nothing was saved.

## How do I invite a new member?

1. Open "Members & invitations" → "Invite member".
2. Enter the e-mail, choose the "Role" and the "Branch" (pick a branch to limit the role to it; organization admins have no branch, branch managers need one).
3. To invite a client to the portal choose the "Client" role and "Choose the client" (the client file they will see).
4. Click "Create invitation". The "Invitation accept link" is shown **once only** and is valid for 7 days. Copy it with "Copy link" and send it to the invitee yourself, safely.
5. If the link is lost use "Re-issue" (the previous link stops working immediately); to cancel use "Revoke".

Example: invite `clearance.jed@example.com` as "Clearance staff" in branch `JED`.

> A branch manager invites for their own branch only: clearance staff, transport staff, accountants and portal clients.
> If a plan-limit message appears when inviting or accepting, the number of users (active staff roles) reached the plan limit. Portal clients are not counted.

## How do I deactivate a membership?

1. In the "Members" table click "Deactivate" on the membership.
2. The user loses that access immediately. You cannot deactivate yourself or the last active organization admin.

## How do I set the document rules?

1. Open "Document rules" (`admin.html#requirements`).
2. "Add rule": choose the operation, the shipping mode, the port (empty = any port), the document kind and the stage it is required before.
3. A rule only blocks the move to its own stage while the confirmed document is missing. An optional document is listed but never blocks.
4. An operations manager, supervisor or organization admin can "Override document rule" for one move with a required reason, recorded in the transaction history.

## How do I check the audit log and client errors?

- "Audit log" (organization admin and supervisor): every insert and update on organization data with before and after values. Read only. Filter by date, table and actor.
- "Client errors" (organization admin): the latest browser errors, personal data scrubbed; helps spot breakages early.

## How do I manage messaging channels?

Organization admin only, from "Channels" (`admin.html#channels`):

1. "Add channel": e-mail or WhatsApp, with the organization's official address (no shared accounts). One account belongs to one organization.
2. In this phase every channel is a **mock**: capabilities are "proven by simulation only".
3. Messaging settings and "Analysis usage & cost" are on the same page (cost is zero today: the analysis is local rules).

> Never enter a password or key on this screen; there is no field for it.

## How do I know my organization's plan and limits?

The plan and its limits are managed by the platform admin. This release has no plan screen inside "Organization"; if you see a plan-limit or "subscription is not active" message, contact the platform team.

## What the system does not do

- It does not e-mail invitations; the link is copied and sent by hand.
- It never deletes a member, branch or record; deactivation only, the data stays.
- It never reveals whether an e-mail has an account.
- It does not connect a real mailbox or WhatsApp account in staging.

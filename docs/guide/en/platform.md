# Platform admin

For platform admins only. The "Platform console" (`platform.html`) manages tenant organizations and their plans and never shows operational data of the organizations. Back to the [guide index](index.md).

> A platform admin account is added only from the Supabase SQL Editor (table `platform_admins`), never from a screen.

## How do I create a new organization?

1. "Create an organization": Arabic name, English name, slug (lowercase letters, digits and dash, 2–40), reference prefix (2–5 uppercase letters) and default language.
2. "First branch": branch code, name and city.
3. "Organization admin": the e-mail. An invitation with the "Organization admin" role is created.
4. "Create organization". The invitation link is shown **once only**: copy it and send it to the organization admin safely.
5. If the link is lost: "Re-issue admin invitation" in the organization's row (the previous link stops working).

Example: organization «مؤسسة تجريبية ب» with slug `org-g7b` and prefix `TSB`; its references start with `TSB-` and are fully independent of other organizations.

> Every new organization automatically gets the "pilot" plan (`pilot`, no limits) with status "active".

## How do I manage plans?

The "Plans" card: a table with code, name, the six limits, price, number of organizations and active state.

1. "New plan" or "Edit" opens a form: plan code, Arabic and English names, sort order, active, the six "Plan limits", monthly price (SAR, optional) and notes.
2. An empty field means "Unlimited". "Storage (GB)" is entered in GB and stored in MB.
3. A plan code cannot change after creation. The `pilot` plan cannot be deactivated.

| Limit | What it measures |
|---|---|
| Users | Users with an active staff role (clients are not counted; a second role of the same user is not counted twice) |
| Branches | Active branches |
| Transactions / month | Transactions created in the month (Riyadh time) |
| Storage | Size of documents, finance documents and message attachments (cumulative) |
| Messages / month | All inbound and outbound messages; **only sending is refused**, inbound is never refused |
| Automated processing / month | Automatic analysis runs; **only draft requests are refused**, inbound processing never stops |

> The starting values of `basic` and `pro` are placeholders — an owner decision. Prices stay empty ("Not priced") until the owner decides after the cost model and real usage.

## How do I change an organization's plan?

The "Subscriptions & usage" card: per organization the plan, status, period and "used / limit" cells, highlighted when over the limit.

1. "Change plan": plan, status ("trial" with an end date, or "active"), period start and end, per-organization limit overrides if needed, and a **required reason**.
2. Downgrading below current usage is allowed: nothing is deleted or deactivated, only new records of the exceeded kind are refused, and the exceeded limits are shown.
3. "Usage": the current month, the previous months and the latest subscription events.
4. "Recount": recomputes the counters from the real rows (safe to repeat).

> The "Over plan limits" tile shows how many organizations exceed at least one limit.

## How do I suspend or reactivate an organization?

1. "Suspend" in "Subscriptions & usage" (or in the organizations table): enter the "Reason" (**required**). "Cancel the subscription (instead of suspending)" sets the status to "Cancelled" instead of "Suspended".
2. The effect is immediate: no access for the organization's staff, no client portal, no public tracking, and its public forms stop. **No data is deleted.**
3. "Reactivate" with a required reason restores access immediately for its active members.

| Subscription status | Meaning |
|---|---|
| Trial | Works until the period end; afterwards view and edit only, no new records until extended or switched to "active" |
| Active | Works within the plan limits |
| Suspended | No access (full block), data kept |
| Cancelled | Same as suspended |

> Every plan or status change is written to the subscription events (append-only) and the audit log.

## How do I check server health and errors?

- "Server health" → "Check now": status, database time, schema version (last applied migration), environment, response time.
- "Recent front-end errors": JavaScript errors from users' browsers across all organizations, personal data scrubbed.

## What do I see, and what not?

You see organizations, branch and member counts, plans, subscriptions and usage counts only. You never see the organizations' transactions, clients, references, amounts or messages. A platform admin is not a member of any organization.

## What the system does not do

- It does not bill subscriptions or take online payments (deferred until before the commercial launch).
- It never deletes an organization or its data; suspension and cancellation keep everything.
- It does not e-mail the admin invitation link; you copy and send it yourself.
- The interface does not decide limits; the server refuses the exceeding record with "Your organization reached its plan limit".

# CSR resupply calendar

Open **Schedule → Resupply calendar** (`/admin/resupply-calendar`).

- The month view shows the number of distinct patients due on each date.
  Click a date to see its patients, or use **Due now & overdue** to work
  across all past scheduled dates. Search by patient name or supply SKU.
- **Orders & eligibility** opens the patient's supply review without leaving
  the worklist. This review is also at **Patients → Resupply**.
- The review shows active prescriptions, catalog item names, last order dates,
  replacement-rule results, quantity limits, and scheduled resupply dates.
  Order history includes item quantities, external order references, and
  recorded shipping/delivery dates, with pagination for older orders.
  The most recent 50 linked resupply drafts also expose their CSR order
  contents and signature status, including orders not yet fulfilled.
- Select one patient or up to 50, choose **Email**, **SMS**, or **Automated
  call**, then review the named recipients and queue the outreach. Each
  patient is included once even when several supplies are due.
- Results distinguish **queued**, **skipped**, and **failed**. Queue acceptance
  does not mean delivery. Review delivery and patient replies in Conversations.
  The existing reminder content asks whether the patient is still using the
  supplies and running low; sending an invitation does not place an order.

## Dates and guardrails

Calendar dates use the same tenant cutover as the reminder scanner. Before
`resupply.due_at_authoritative` is enabled, they derive from the last shipment
(or order creation, then prescription creation) plus the effective cadence:
patient override, matching frequency rule, then prescription default. All
open episodes are considered before filtering by the derived date, so a stale
stored episode date cannot hide patients. After the cutover, the calendar
uses `episodes.due_at`. Outreach rechecks and the patient review use this same
calculation. Dates display in the browser's timezone, separate from the HCPCS interval
and quantity results in the patient review. Replacement eligibility uses the
same entitlement calculation as the existing `resolveSkuEntitlement` adapter,
with reference data and patient history loaded once for all supplies. An unmapped SKU displays **Needs
eligibility review**; it does not invent coverage. Quantity-limit dates are
shown as the next quantity review, not a guaranteed payable date. Insurance
coverage and prescription validity must still be verified before fulfillment.

Only active patients and prescriptions appear in the calendar. Outreach is
rechecked on the server and again by the worker: closed/held/completed/future
or expired cycles, invalid prescriptions, inactive patients, missing channel
contacts, and conversations in the last 48 hours are skipped. SMS and calls
use the existing recipient-local contact hours. Queue singleton keys and the
worker's existing daily reminder claim limit duplicate requests. Patients
receive the tenant's configured identity and sender through the existing
messaging and voice workers.

Provider-rejected call attempts keep their conversation and audit records,
but do not count as patient contact for the 48-hour check, so the queue can
retry them. Accepted calls retain their contact timestamp.

The calendar walks all matching pages; it does not truncate at the first
PostgREST page. All patient reads and outreach checks are tenant-scoped.
Historical ad-hoc CSR orders that have no patient/draft link cannot be
attributed to a patient and remain on the existing Orders screen.

## Operation and verification

No database migration or new provider integration is required. The API,
pg-boss worker, and the existing channel credentials must be running;
email also requires the tenant's verified link domain. No real patient
messages are sent by the automated tests or demo handlers.
Viewing requires `patients.read`; sending outreach additionally requires
`conversations.manage` in both the API and user interface.

Demo preview: `/admin/resupply-calendar?demo=1`. It uses fictional patients
and reports simulated outreach explicitly.

Tests cover paged calendars, tenant scope, order pages, unknown eligibility,
all three outreach queues, patient/episode deduplication, partial failures,
stale-cycle checks, selection clearing, recipient review, and the patient
review dialog. Live Supabase and vendor delivery require a configured test
environment and are separate from the mocked route and browser checks.

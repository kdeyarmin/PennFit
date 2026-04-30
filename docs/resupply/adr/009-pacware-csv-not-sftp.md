# ADR 009 — Pacware integration is manual CSV file exchange

## Context

Pacware is the legacy DME platform (Brightree-owned) that owns the system
of record for billing, insurance eligibility, equipment setup, and
shipment history. It does not have a documented public API. SFTP access
exists in theory but requires custom report development from Brightree
support, has unknown turnaround, and adds an external system to harden.

The user's stated operational reality: a designated staff member is
willing to do a daily upload-and-download workflow.

## Decision

Pacware integration in v1 is **manual CSV file exchange**, mediated
through the admin dashboard:

- **Inbound (Pacware → us):** staff exports the patient roster, insurance,
  equipment, shipment history, and supply entitlement reports from
  Pacware's UI. They upload the CSV files into the admin dashboard's
  "Daily Pacware Import" page. The dashboard parses, validates, diffs
  against our DB, and applies the changes — surfacing rejections for
  admin review.
- **Outbound (us → Pacware):** confirmed orders that are ready to bill
  produce a downloadable order CSV in the dashboard. Staff downloads it
  and imports it into Pacware. The download is logged to
  `pacware_export_log` so we can prove what was generated and when.
- A daily SOP (see `docs/resupply/SOP-pacware-daily.md` once Phase 7
  ships) documents the exact button clicks for the designated staff.

Pacware is the system of record for billing, insurance, and eligibility.
Our system is the source of truth for conversations, consent, messaging
history, and outreach state.

## Consequences

- No integration outage risk: if Pacware is down, our system keeps
  working with the last-imported data; orders queue for the next export.
- Latency: data is at most ~24 hours stale. Acceptable for resupply
  cadences (Medicare allows orders no earlier than the schedule date
  anyway).
- Operational dependency on a single staff member doing the daily SOP.
  Backup admin must be designated.
- Manual = error-prone. Every import surfaces a diff and requires
  admin confirmation before applying destructive changes (status
  changes, soft deletes).

## Migration exit ramp

If Brightree opens a real API or builds an SFTP automation:

1. The CSV import pipeline becomes an automated fetch on the same parser.
2. The download-and-paste outbound becomes a push.
3. The schema and the admin workflows do not change — only the
   transport.

## Alternatives Considered

- **SFTP** — depends on Brightree custom report development; unknown
  turnaround; another system to harden.
- **Direct DB access** — not offered.
- **Screen scraping Pacware's web UI** — fragile, ToS risk, brittle to
  layout changes.

## TODO

- [BUSINESS REVIEW] Confirm designated primary + backup staff for the
  daily SOP.
- [BUSINESS REVIEW] Confirm with Brightree support whether Pacware
  accepts inbound order CSVs (deal-breaker question for the outbound
  half of this ADR — answered before Phase 7).

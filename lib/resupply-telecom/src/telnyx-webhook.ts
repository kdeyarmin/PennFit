// @workspace/resupply-telecom — Telnyx Programmable Fax webhook parsing.
//
// Telnyx posts every fax lifecycle transition as a JSON event. Outbound
// faxes emit fax.queued → fax.media.processed → fax.sending.started →
// fax.delivered (or fax.failed); inbound faxes emit a single
// fax.received. The event is wrapped in a `data` envelope:
//
//   { "data": { "event_type", "id", "occurred_at", "record_type",
//               "payload": { fax_id, direction, status, from, to,
//                            page_count, media_url, failure_reason, … } },
//     "meta": { … } }
//
// Some Telnyx docs show the event flattened (no `data` wrapper); we
// accept both shapes so a payload-format quirk can't drop an event.
//
// This module is PURE parsing — it maps the wire shape to a normalized
// TelnyxFaxEvent. DB status mapping ("sent" / "delivered" / "failed")
// stays in the API route layer; the telecom lib must not know about the
// resupply schema.

import { z } from "zod";

/** Every fax event type we recognize. */
export const TELNYX_FAX_EVENT_TYPES = [
  "fax.queued",
  "fax.media.processed",
  "fax.sending.started",
  "fax.delivered",
  "fax.failed",
  "fax.received",
] as const;

export type TelnyxFaxEventType = (typeof TELNYX_FAX_EVENT_TYPES)[number];

const payloadSchema = z
  .object({
    fax_id: z.string().min(1),
    direction: z.string().optional(),
    status: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page_count: z.coerce.number().int().nonnegative().optional(),
    media_url: z.string().optional(),
    failure_reason: z.string().optional(),
    connection_id: z.string().optional(),
  })
  .passthrough();

const eventInnerSchema = z.object({
  event_type: z.string().min(1),
  id: z.string().optional(),
  occurred_at: z.string().optional(),
  payload: payloadSchema,
});

// Accept both the wrapped `{ data: { … } }` and the flattened `{ … }`
// shapes. The wrapped form is what production Telnyx sends; the
// flattened form appears in some doc examples.
const envelopeSchema = z.union([
  z.object({ data: eventInnerSchema }).transform((v) => v.data),
  eventInnerSchema,
]);

/** Normalized fax event, vendor field names flattened to camelCase. */
export interface TelnyxFaxEvent {
  /** e.g. "fax.received", "fax.delivered", "fax.failed". */
  eventType: string;
  /** Telnyx fax id (UUID) — the idempotency key / vendor_ref. */
  faxId: string;
  /** "inbound" | "outbound" | null. */
  direction: string | null;
  /** Telnyx status string, e.g. "delivered", "failed", "received". */
  status: string | null;
  /** Sender fax number (PHI — never log). */
  from: string | null;
  /** Recipient fax number. */
  to: string | null;
  pageCount: number | null;
  /** Downloadable media URL (inbound fax.received only). */
  mediaUrl: string | null;
  /** Failure reason on fax.failed, e.g. "user_busy". */
  failureReason: string | null;
}

export type ParseTelnyxFaxEventResult =
  | { ok: true; event: TelnyxFaxEvent }
  | { ok: false };

/**
 * Parse a Telnyx fax webhook body (already JSON-decoded) into a
 * normalized event. Returns `{ ok: false }` when the body doesn't carry
 * the minimal shape (an event_type + a payload.fax_id) so the route can
 * 200-and-skip rather than 5xx (which would make Telnyx retry forever).
 */
export function parseTelnyxFaxEvent(body: unknown): ParseTelnyxFaxEventResult {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false };
  const e = parsed.data;
  const p = e.payload;
  return {
    ok: true,
    event: {
      eventType: e.event_type,
      faxId: p.fax_id,
      direction: p.direction ?? null,
      status: p.status ?? null,
      from: p.from ?? null,
      to: p.to ?? null,
      pageCount: p.page_count ?? null,
      mediaUrl: p.media_url ?? null,
      failureReason: p.failure_reason ?? null,
    },
  };
}

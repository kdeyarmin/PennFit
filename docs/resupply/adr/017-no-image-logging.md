# ADR 017 — No image logging anywhere in the backend

## Context

The cpap-fitter customer flow captures camera frames in the browser
to compute facial measurements (nose width, mouth width, face width
at cheekbones, etc). The measurements feed the mask-recommendation
engine and a small portion is later persisted on `shop_customers.
facial_measurements` for the customer's own /account view and the
admin Customer 360.

The captured frames themselves are PHI under HIPAA — a face photo
plus an order address is a re-identification vector. They are also
not necessary anywhere on the backend.

## Decision

Camera images and video frames NEVER leave the browser. Only the
numeric facial measurements derived from them are transmitted. The
backend is forbidden from logging anything image-shaped. This is a
**hard rule**, restated at the top of `CLAUDE.md`:

> No image logging anywhere in the backend. Camera images and video
> frames never leave the browser; only numeric facial measurements
> are transmitted. Do not add log lines that include image bytes,
> base64, data URLs, or paths to camera-derived blobs.

## What this means in practice

- The `/orders` endpoint MUST NOT log `req.body` because the body
  carries a `measurements` object on the orders that include them
  (and could in the future carry image-adjacent fields).
- The `lib/logger.ts` redactor is a defense-in-depth back-stop, NOT
  the primary control. The primary control is "don't log the body
  at all" and that is the developer's responsibility at the call
  site.
- Patient-uploaded prescription documents and inbound MMS images
  follow the separate object-storage policy in
  [`PHI-RETENTION.md`](../PHI-RETENTION.md). Object KEYS are
  loggable (they're random UUIDs); object BYTES are not, and are
  never proxied through the logger.
- MediaPipe runs on-device (`scripts/setup-mediapipe.mjs` ships the
  WASM bundle into the cpap-fitter `public/`). Inference is in the
  browser; the result is a small JSON object of measurements.

## What we do NOT control here

The admin reply composer can attach PDFs / images for outbound
fax. Those flows are subject to fax-specific retention (see the
`fax-document-token` machinery and the weekly attachment sweep) —
but they're admin-uploaded, never camera-derived, and the rule
above is specifically about the camera capture path.

## Why an ADR for what looks like a one-line rule

Three reasons:

1. **It's load-bearing for the privacy posture, not stylistic.** A
   well-meaning future contributor adding `logger.info({ req }, "
/orders")` would feel correct — "logs are private, this is just
   for ops". The ADR is what makes the wrongness obvious.
2. **The CLAUDE.md hard rule lives one keystroke away from being
   silently softened.** The ADR pins the rationale in a place that
   gets reviewed when the rule gets edited.
3. **It's the canonical reference when someone asks "why is the
   measurement extraction in the browser instead of the
   server?".** Server-side inference would be cleaner code, but
   would require shipping image bytes to a process that under no
   other path ever sees them.

## Enforcement gaps (open follow-ups)

- No automated lint rule today catches `logger.*({ req.body })` or
  `logger.*(measurementValue)` in the API. Manual code review +
  this ADR are the controls.
- `lib/logger.ts` redacts `req.headers.authorization`,
  `req.headers.cookie`, and `res.headers.set-cookie`. It does NOT
  blanket-redact `req.body`; that would defeat structured
  field-level logging on bodies that are deliberately non-PHI
  (`/health`, public `/shop/products`).

## Related

- CLAUDE.md "Hard rules — do not break".
- `PHI-RETENTION.md` — attachment-storage rules for non-camera
  uploads.
- `AUDIT-RETENTION.md` — what audit metadata MAY contain.
- ADR 016 — no column-level encryption (works in concert with
  this rule: don't store or log image bytes either way).

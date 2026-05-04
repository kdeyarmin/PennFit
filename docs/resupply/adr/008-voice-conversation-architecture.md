# ADR 008 — Voice conversation architecture (OpenAI Realtime + Twilio Media Streams)

## Context

The Resupply product needs to hold real-time spoken conversations with
patients to confirm reorder timing, verify shipping addresses, gather
mask-fit feedback, and read back Medicare-required disclosures. The
conversation transcript and tool-call decisions must persist into the
existing `resupply.conversations` and `resupply.messages` tables so
admins can audit every call and so SMS/email follow-ups carry the
same context.

Hard constraints, derived from the threat model and the Anthropic /
OpenAI / Twilio BAA documentation:

1. **PHI-safe**: the patient's phone number, address, DOB, and prescription
   data live encrypted in `resupply.*` (per ADR 007). The voice path must
   never log, return, or otherwise spill those values, and must never
   send them to a model that we don't have a BAA with.
2. **Audio is ephemeral**: we keep the **transcript** in `messages`
   (encrypted) but discard the audio bytes themselves — no recordings,
   no S3, no cache.
3. **Identity verification before any patient-specific tool**: a model
   cannot be trusted to gate this on its own, so the gate is enforced
   server-side in the tool dispatcher, not in the prompt.
4. **HIPAA-grade audit trail**: every tool invocation, every call
   lifecycle transition, and every admin-initiated call must land in
   `resupply.audit_log` via `lib/resupply-audit` (per Rule 8).
5. **Admin-initiated only (this batch)**: outbound calls only.
   Inbound is deferred (it requires phone-number lookup against an
   encrypted column, which is a separate design problem — see Backlog).

ADR 006 picked Anthropic Claude as the **text** conversation model.
That choice doesn't carry to voice: Claude does not (yet) have a
realtime speech-to-speech API under BAA, so a voice-conversation
deployment that uses Claude requires gluing together STT + LLM + TTS
across two or three vendors, plus a turn-detection layer. We chose
instead to use OpenAI's Realtime API (`gpt-realtime`, voice `marin`)
for voice specifically, while leaving Claude as the SMS/email model.

## Decision

### Vendor split

- **Voice transport + telephony**: Twilio Voice + Twilio Media Streams
  (bidirectional WebSocket, **g711 µ-law @ 8 kHz**). ADR 004 already
  picked Twilio.
- **Voice model**: OpenAI Realtime API (`gpt-realtime`, voice `marin`)
  over `wss://api.openai.com/v1/realtime`, **under the OpenAI BAA**
  (`OPENAI_API_KEY` must point at a BAA-covered project).
- **Audio format**: configure Realtime with
  `input_audio_format=g711_ulaw` AND `output_audio_format=g711_ulaw` so
  there is **no transcoding** between Twilio and OpenAI in either
  direction. Forwarding base64 `media` frames as-is removes a whole
  class of latency, drift, and codec bugs.

### Process topology

The bridge runs **inside the existing `artifacts/resupply-api` Express
process**, not as a separate service. Why:

- The bridge needs the resupply DB pool, the audit helper, and the
  encryption keys — exactly what `resupply-api` already has wired up.
- One TLS endpoint, one auth-protected admin surface, one set of
  env vars to manage.
- A separate "voice service" would force a public WS endpoint for
  Twilio plus a private channel back to the API for tool calls — more
  surface area, more secrets, more drift.

`index.ts` constructs an explicit `http.createServer(app)` and attaches
a `WebSocketServer({ noServer: true })`. The server's `upgrade` event
routes WebSocket handshakes whose path is
`/resupply-api/voice/stream`; every other path is rejected with a
`socket.write(... 404 ...); socket.destroy()`.

### Endpoints

| Method | Path                                  | Caller                       | Auth                  |
| ------ | ------------------------------------- | ---------------------------- | --------------------- |
| POST   | `/resupply-api/voice/place-call`      | Admin dashboard              | `requireAdmin`        |
| POST   | `/resupply-api/voice/twiml-connect`   | Twilio (after dial picks up) | Twilio HMAC signature |
| POST   | `/resupply-api/voice/status-callback` | Twilio (lifecycle webhook)   | Twilio HMAC signature |
| WS     | `/resupply-api/voice/stream`          | Twilio Media Stream          | Pending-session claim |

`twiml-connect` is intentionally **excluded** from
`lib/resupply-api-spec/openapi.yaml`. Twilio is the only legitimate
caller; publishing it tempts the dashboard to invoke it directly.
`status-callback` IS in the spec — the dashboard must not call it
either, but admins reading the spec need to see it exists to
understand the audit-row provenance.

### Patient-context binding

The model is never given a patient identifier. Instead:

1. `place-call` opens a `conversations` row (`channel='voice'`,
   `status='open'`) and registers the `conversationId` in a short-TTL
   in-memory `pendingSessions` map keyed on `conversationId` with
   `{ patientId, episodeId, expiresAt }`.
2. The TwiML returned by `twiml-connect` puts the `conversationId` on
   the Stream URL as a query parameter.
3. The WebSocket `upgrade` handler extracts `conversationId` from the
   URL and **claims** the pending session (a one-shot operation — a
   second claim returns `null` and the upgrade is rejected).
4. The tool dispatcher is constructed bound to `{ patientId,
conversationId, episodeId }`. **All** tool calls operate on the
   bound patient; the model can never select a different patient by
   passing an argument.

The pending-session map is **in-process** with a 5-minute TTL. This
matches the existing single-API-instance model (per the readiness +
migration design); a future multi-instance deployment will need a
shared store (Postgres-backed, probably). Single-instance is documented
explicitly so we don't accidentally ship a multi-replica deploy without
revisiting this.

### Tool surface

Seven tools, defined as zod schemas in `lib/resupply-ai/src/tools.ts`
and turned into OpenAI tool descriptors at the same site:

1. `verify_patient_identity({ date_of_birth })` — **3-attempt limit**;
   constant-time DOB compare via `Buffer.from(...) +
timingSafeEqual`. Until this passes, every other patient-data tool
   returns `{ error: "identity_not_verified" }`.
2. `lookup_resupply_inventory()` — supplies due for the bound patient.
3. `get_shipping_address()` — current address for verbal confirmation.
4. `update_shipping_address({ street, city, state, postal_code })`
   — only on explicit patient request.
5. `place_resupply_order({ skus, address_confirmed })` — final commit.
6. `request_human_handoff({ reason })` — graceful escalation; the
   bridge plays a "transferring you to a human" line and closes the WS.
7. `end_call({ outcome })` — outcome enum: `completed`, `voicemail`,
   `no_answer`, `patient_declined`, `transfer_to_human`,
   `error`.

Identity-gate exemptions: only `verify_patient_identity`,
`request_human_handoff`, and `end_call`. Everything else requires
verified state.

### Persistence

- **Transcript turns** (both `input_audio_transcription` deltas/done
  events from the patient and `response.audio_transcript.done` from the
  model) are coalesced per item id and persisted as **one
  `resupply.messages` row per turn**, body encrypted with the existing
  `encrypt()` helper. We never store audio.
- **Tool invocations** emit a `voice.tool.invoked` audit row with a
  sanitized arg shape (the audit helper's `sanitizeMetadata` rejects
  PHI-shaped keys at any depth — see ADR 007 / Rule 8).
- **Call lifecycle** emits `voice.call.placed` (from `place-call`) and
  `voice.call.completed` (from both `status-callback` AND the WS
  finaliser; `closed` is idempotent so double-firing is safe).

### Architecture rule additions

Two rules added to `scripts/check-resupply-architecture.sh` and locked
in by self-tests:

- **Rule 9**: `lib/resupply-ai/src/` MUST NOT import
  `@workspace/resupply-db`, `pg`, or `twilio`. It owns the OpenAI
  Realtime adapter and the conversation orchestration; touching the DB
  or Twilio SDK from there would erase the hexagonal boundary.
- **Rule 10**: `lib/resupply-telecom/src/` MUST NOT import
  `@workspace/resupply-db`, `pg`, `openai`, or `@anthropic-ai/sdk`. It
  owns the Twilio adapter; keeping LLM and DB wiring out of it makes
  it independently testable and prevents call-routing code from
  growing PHI-handling responsibilities.

`ws` is an explicit carve-out for `lib/resupply-ai` because it is the
transport for the OpenAI Realtime WebSocket — not a vendor SDK.

The patterns are quote-anchored (`@workspace/resupply-db['"]`) so
mentions in code comments don't trip the gate.

### Feature flagging

Voice routes are conditionally registered on env presence. The check
returns 503 with a stable error code when missing:

| Env var                             | Required for                | Source                 |
| ----------------------------------- | --------------------------- | ---------------------- |
| `OPENAI_API_KEY`                    | WS bridge + `place-call`    | OpenAI BAA project key |
| `TWILIO_ACCOUNT_SID`                | All voice routes            | Twilio integration     |
| `TWILIO_AUTH_TOKEN`                 | Signature validation + REST | Twilio integration     |
| `RESUPPLY_VOICE_PUBLIC_BASE_URL`    | TwiML + Status callback URL | Admin-supplied         |
| `TWILIO_PHONE_NUMBER`               | `place-call` only           | Admin-supplied (E.164) |
| `RESUPPLY_PRACTICE_NAME` (optional) | System prompt branding      | Admin-supplied         |

The 503 is the published behaviour, not a bug. The OpenAPI spec lists
it explicitly.

## Consequences

- **One BAA per modality.** Voice goes through OpenAI; SMS/email goes
  through Anthropic. Two BAAs to manage, but each adapter stays simple
  and switchable.
- **No recordings.** We have transcripts, not audio. Resolves the
  retention question at the design layer rather than the policy layer.
- **Single-instance assumption is now load-bearing in two places.**
  The pending-session map and the readiness/migration design both
  assume one API process. Multi-replica deploys need a shared session
  store before voice can scale out.
- **Switching realtime vendors is a real refactor.** OpenAI Realtime's
  message protocol (session.update / response.create / etc.) does not
  generalize cleanly. If we move to Gemini Live or another vendor we
  rewrite `lib/resupply-ai/src/realtime-client.ts`; the bridge and
  dispatcher boundary mean the rewrite is contained, not project-wide.
- **µ-law passthrough means no audio inspection.** We give up the
  ability to record-on-error or replay a problem call's audio. We
  accepted that trade for the BAA + retention story.
- **Inbound is deferred.** The TwiML inbound path needs to map an
  E.164 number back to a `patients` row. The phone column is encrypted
  random-IV (`encryptedText`) so equality lookup is impossible without
  a separate lookup table or a deterministic-encrypted column. That's
  a schema change + threat-model revision. Captured in the backlog.

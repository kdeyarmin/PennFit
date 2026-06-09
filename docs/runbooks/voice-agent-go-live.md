# Voice agent go-live — AI inbound/outbound phone calls

**Audience:** Penn Home Medical Supply operator / deployer.
**Status:** The voice agent is **fully built and shipping** — code-complete and
tested. It stays **off** until its env vars are set and a Twilio number is
pointed at the API. Going live is a **configuration** task; no code change is
required.

The agent holds a real spoken conversation with the patient (OpenAI Realtime
brain over a Twilio Media Stream), verifies identity by date of birth, reviews
what resupply is due, confirms the shipping address, and places the reorder —
then Claude writes a post-call summary that can route a follow-up to a human.

> **PHI posture (already enforced in code):** calls are **never recorded** —
> `placeCall` passes `record: false` and the inbound path never enables
> recording. Only the **transcript** is persisted (encrypted `messages` rows);
> the audio bytes are discarded. Do not add recording.

---

## What this turns on

| Path                        | Entry point                                                                                                              | What happens                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbound** (patient calls) | `POST /resupply-api/voice/inbound-reorder`                                                                               | Look up caller by `From` → if a single patient matches, `voice.agent` is on, and they have an actionable episode, connect to the AI agent; otherwise transfer to a human (`+1 814-471-0627`). |
| **Outbound** (admin calls)  | Admin clicks "Call patient" → `POST /resupply-api/voice/place-call` → Twilio dials → `/resupply-api/voice/twiml-connect` | Same AI bridge, with an outbound greeting. Outbound is app-initiated; **no Twilio-console wiring is needed** for it.                                                                          |
| **Status callbacks**        | `POST /resupply-api/voice/status-callback`                                                                               | Twilio call-lifecycle events (answered / completed / failed) close out the conversation row.                                                                                                  |

The Media Stream itself connects to a WebSocket at
`/resupply-api/voice/stream` (handled by the HTTP `upgrade` listener in
`artifacts/resupply-api/src/index.ts`, gated by a short-TTL pending-session
claim — Twilio doesn't sign WS handshakes, only the preceding TwiML POST).

---

## 1. Set the environment variables

The voice path is gated by `readVoiceConfigOrThrow()` in
`artifacts/resupply-api/src/lib/voice/voice-config.ts`. It is **all-or-nothing**:
if any required var is missing, every voice route returns a clean `503`
(`voice_not_configured`) / hangup TwiML rather than a partial config that fails
mid-call.

### Required (inbound **and** outbound)

| Variable                         | Value                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                 | The Realtime conversational model + built-in transcription. Also the LLM fallback elsewhere.                                                                                       |
| `TWILIO_ACCOUNT_SID`             | Production `AC…` SID. Used for webhook signature validation + the outbound REST call.                                                                                              |
| `TWILIO_AUTH_TOKEN`              | Production auth token. Webhook signatures fail closed (403) without it.                                                                                                            |
| `RESUPPLY_VOICE_PUBLIC_BASE_URL` | `https://pennpaps.com` — the public origin Twilio calls back into, and the `wss://` origin for the stream. Falls back to `https://${RAILWAY_PUBLIC_DOMAIN}` when unset on Railway. |

### Required for **outbound** only

| Variable              | Value                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_PHONE_NUMBER` | E.164 caller-ID we dial **out** from (e.g. `+12155550123`). Inbound works without it; outbound `/voice/place-call` returns `503` (`voice_outbound_not_configured`) until it's set. |

### Optional (graceful-degrade — unset is fine)

| Variable                                      | Effect when set                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEEPGRAM_API_KEY`                            | Opens a parallel Nova-3 transcription on the caller audio for a higher-accuracy audit transcript + the summarizer. Unset → the model's built-in transcription is used. |
| `ELEVENLABS_API_KEY`                          | ElevenLabs becomes the agent's voice (Realtime runs text-output, each turn synthesised to µ-law). Unset → OpenAI's built-in `cedar` voice.                             |
| `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` | Override the ElevenLabs voice / model (sensible client defaults otherwise).                                                                                            |
| `RESUPPLY_PRACTICE_NAME`                      | Practice name baked into the system prompt (defaults to `PennPaps`).                                                                                                   |

Set these in **Railway → the `resupply-api` service → Variables**. Then confirm
the shape with `preflight:prod` (§4).

---

## 2. Provision the Twilio phone number

In the **Twilio Console → Phone Numbers → Manage → Buy a number** (or use an
existing one), pick a **Voice-capable** number. Note it in **E.164**
(`+1NXXNXXXXXX`).

- If you want **outbound** calls, set this same number as `TWILIO_PHONE_NUMBER`
  in §1 (it's the caller-ID patients see).
- Inbound and outbound can be the same number.

---

## 3. Wire the number's webhooks (the inbound step)

On the number's configuration page in the Twilio Console, set the **Voice**
section to call the API. Use **HTTP POST** for both:

| Twilio field                              | URL                                                       |
| ----------------------------------------- | --------------------------------------------------------- |
| **A Call Comes In** (Voice)               | `https://pennpaps.com/resupply-api/voice/inbound-reorder` |
| **Call Status Changes** (Status Callback) | `https://pennpaps.com/resupply-api/voice/status-callback` |

Replace `pennpaps.com` with your `RESUPPLY_VOICE_PUBLIC_BASE_URL` host if
different. **The host must match `RESUPPLY_VOICE_PUBLIC_BASE_URL` exactly** —
the signature check reconstructs the URL Twilio signed from that var, so a host
mismatch 403s every inbound call.

> **Outbound needs no console wiring.** App-initiated calls pass
> `/resupply-api/voice/twiml-connect` as the answer URL programmatically;
> `twiml-connect` only works for a call that already has a pending
> `conversationId`, so do **not** point the inbound "A Call Comes In" webhook at
> it.

---

## 4. Confirm config shape with `preflight:prod`

```bash
pnpm --filter @workspace/scripts preflight:prod
```

The `VOICE_AGENT` line reports the effective state:

- **PASS** "…all set… is live" — the four required vars are present.
- **WARN** "partially configured (N/4)… Missing: …" — voice will `503` until the
  rest are set. (Ignore only if you're deliberately not running voice and those
  vars are there for SMS/chat.)
- **PASS** "voice agent disabled" — no voice env at all; expected if voice isn't
  part of this launch.

The `TWILIO_PHONE_NUMBER` line validates E.164 shape (and flags the
`.env.example` placeholder). Unset → WARN (outbound disabled, inbound still
works). Note `preflight` checks **shape only** — it does not place a call; the
smoke test in §6 is the live-wire check.

---

## 5. Confirm the `voice.agent` feature flag

The agent is gated by the `voice.agent` feature flag, **seeded ON** (migration
`0149_feature_flags.sql`). Confirm it's enabled in **Control Center →
`/admin/feature-flags`** (category "Voice & AI"). Toggling it OFF makes every
inbound call route to a human / hangup within ~5 s (the flag is cached for 5 s);
it's the kill switch if the agent ever misbehaves on a live call.

---

## 6. Smoke test (live wire)

With the deploy live (`pnpm --filter @workspace/scripts verify:deploy -- https://<host>`
green), place real calls:

1. **Known patient with a due episode** → call from that patient's number on
   file. The agent should answer with the inbound greeting and ask you to
   **verify date of birth** before reading anything back. Walk through a reorder.
2. **Unknown / blocked number** → the agent should say it couldn't match the
   number and **transfer to the human line** (`+1 814-471-0627`).
3. After hangup, confirm a **post-call summary** landed: a `voice.call.summary`
   audit row, and — if the agent flagged it — a follow-up in the CSR queue.

If you set `DEEPGRAM_API_KEY`, confirm a `voice.call.deepgram_transcript` audit
row as well.

---

## Cost & scaling caveats

- **Per-call duration cap: 15 minutes** (`ws-handler.ts`). A wedged bridge is
  force-closed so it can't burn Realtime + Twilio (+ Deepgram/ElevenLabs)
  minutes indefinitely. There is **no** per-patient, per-day, or concurrency
  cap — budget accordingly, and watch spend after launch.
- **Single instance only.** The pending-session map that binds a call to its
  patient context is **in-process** (5-min TTL). Do **not** horizontally scale
  the `resupply-api` service while voice is on without first moving that map to
  a shared store — a call whose TwiML POST and WS upgrade land on different
  instances will fail the session claim and drop.

---

## Troubleshooting

| Symptom                                                         | Likely cause                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every call gets "Voice service unavailable" / `503`             | A required §1 var is missing → `readVoiceConfigOrNull()` returns null. Re-check `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `RESUPPLY_VOICE_PUBLIC_BASE_URL`. |
| Twilio shows a **403** on the webhook                           | Signature mismatch — the webhook URL host doesn't match `RESUPPLY_VOICE_PUBLIC_BASE_URL`, or `TWILIO_AUTH_TOKEN` is wrong. Make them identical.                                |
| Caller is **immediately transferred to a human**                | `voice.agent` flag OFF, the number didn't match a single patient (unknown / shared), or the patient has no actionable episode. Check the `voice.inbound-reorder.*` log events. |
| Outbound "Call patient" returns `voice_outbound_not_configured` | `TWILIO_PHONE_NUMBER` is unset.                                                                                                                                                |
| WS upgrade rejected `401 no-pending-session`                    | Expected for a stray/expired/duplicate upgrade — the one-shot session claim already consumed (or never created) that `conversationId`. Not actionable on its own.              |

---

## Rollback

Flip **`voice.agent` OFF** in `/admin/feature-flags` — inbound calls fall back
to the human transfer within ~5 s, and outbound place-call won't connect to the
bridge. To take voice fully offline, unset the §1 env vars (every route then
returns the clean `503`). Neither affects the rest of the API.

---

## Cross-references

- [`docs/resupply/adr/008-voice-conversation-architecture.md`](../resupply/adr/008-voice-conversation-architecture.md)
  — the architecture decision (and the update note confirming inbound shipped).
- [`docs/runbooks/production-launch.md`](./production-launch.md) — the broader
  first-launch procedure (voice is an optional add-on to it).
- `artifacts/resupply-api/src/lib/voice/voice-config.ts` — the single source of
  truth for "is voice configured?".
  </content>
  </invoke>

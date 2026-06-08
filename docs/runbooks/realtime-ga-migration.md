# Runbook: gpt-realtime-2 GA-schema spike (voice agent brain)

Status: **feature-flagged, OFF by default. Not yet validated against a live
OpenAI key.** Production runs the proven beta schema on `gpt-realtime`.

## What this is

OpenAI shipped **`gpt-realtime-2`** (May 2026) — a GPT‑5‑class reasoning
voice model with a 128K context window and configurable reasoning effort.
It is a real upgrade for conversational naturalness, paired with
**`gpt-realtime-whisper`** (natively‑streaming STT, lower WER on phone
audio). Both require OpenAI's **GA Realtime session schema** (nested
`session.audio.input/output`, `session.type:"realtime"`), which differs
from the `OpenAI-Beta: realtime=v1` flat schema this repo runs today.

The GA path is built behind a flag in `lib/resupply-ai/src/realtime-client.ts`
(`sessionSchema: "ga"`). The inbound event demux already handles both
schemas' event names, so only the outbound `session.update` and the
connection header differ. The Twilio µ‑law bridge is **unchanged** — the GA
schema still carries µ‑law, as `audio/pcmu`.

## Why it's flag‑gated (not the default)

- It rewrites the live, PHI‑touching voice session. It cannot be
  integration‑tested from CI — only against a real OpenAI key + a real call.
- A few GA wire details were **not fully documented** at build time and
  must be confirmed on a preview (below). They're all env‑overridable so
  validation needs **no code change** — just env edits + a test call.
- `gpt-realtime` is **not deprecated** on the first‑party OpenAI API, so
  there is no urgency forcing a risky cutover.

## How to enable on a preview

On the PR's Railway preview (or any non‑prod environment), set:

```
OPENAI_REALTIME_SCHEMA=ga
```

That single var switches the model to `gpt-realtime-2`, the input STT to
`gpt-realtime-whisper`, the session to the GA nested schema, µ‑law to
`audio/pcmu`, and reasoning effort to `low`. Place a test call and work the
checklist. Overrides for correcting wire values during validation:

| Env var                            | Purpose                         | Default when `…SCHEMA=ga` |
| ---------------------------------- | ------------------------------- | ------------------------- |
| `OPENAI_REALTIME_MODEL`            | Pin/override the model          | `gpt-realtime-2`          |
| `OPENAI_REALTIME_TRANSCRIBE_MODEL` | Input STT model                 | `gpt-realtime-whisper`    |
| `OPENAI_REALTIME_AUDIO_FORMAT`     | µ‑law wire token                | `audio/pcmu`              |
| `OPENAI_REALTIME_REASONING_EFFORT` | `minimal`/`low`/`medium`/`high` | `low`                     |

**Rollback is instant:** unset `OPENAI_REALTIME_SCHEMA` → back to
beta/`gpt-realtime`. No deploy needed beyond the env change.

## Validation checklist (confirm each against a real test call)

Watch the app logs for `voice_realtime_ga_schema` (confirms GA is active)
and `voice_session_error` (OpenAI rejecting our `session.update`).

1. **Connection** — the WS connects to `gpt-realtime-2` **without** the
   `realtime=v1` header. If it closes/4xx on connect, the GA handshake
   wants a header/version we omitted — capture the close code and adjust
   the constructor in `realtime-client.ts`.
2. **µ‑law format accepted** — no `session.error` about
   `audio.input.format` / `audio.output.format`. If rejected, try the
   alternative token via `OPENAI_REALTIME_AUDIO_FORMAT` (candidates:
   `audio/pcmu`, `g711_ulaw`, `pcmu`). The one user thread on this exact
   migration had `{type:"g711_ulaw"}` rejected, so `audio/pcmu` is the
   leading candidate — confirm it.
3. **Transcription model accepted** — `gpt-realtime-whisper` is valid as a
   _conversational_ session's `audio.input.transcription.model` (not only
   the dedicated transcription endpoint). If rejected, fall back via
   `OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-4o-transcribe`.
4. **`reasoning.effort` + `max_output_tokens`** — no `session.error` about
   unknown fields. If `max_output_tokens` is rejected, the GA field name
   differs — fix in `buildGaSession()`.
5. **Audio round‑trips end‑to‑end** — the caller hears the agent and the
   agent hears the caller (µ‑law in and out, zero transcoding). This is the
   load‑bearing check: if µ‑law output isn't supported in GA over WS, the
   bridge would need a PCM↔µ‑law layer (a much larger change — stop and
   reassess).
6. **Latency + barge‑in** — at `effort: low`, time‑to‑first‑word is
   acceptable on a phone call, and caller barge‑in still interrupts cleanly
   (`input_audio_buffer.speech_started` still fires).
7. **Tools + transcript** — `verify_patient_identity` etc. still dispatch,
   and transcript turns still persist (the demux already handles GA event
   names; confirm in the conversation record).

## Promotion (after a clean preview pass)

1. Flip the default in `RealtimeClient` (`sessionSchema` default → `"ga"`)
   and in `voice-config.ts`, and update the realtime-client tests' default
   assertions to the GA shape.
2. Set the confirmed env values in production (or bake the corrected
   defaults into the client) and remove the temporary overrides.
3. Retire the beta `buildBetaSession()` path once GA has soaked in prod.
4. Update `CLAUDE.md`'s AI-stack table and the realtime-client header
   comments to reflect gpt-realtime-2 + gpt-realtime-whisper as the
   shipped models.

## Sources

- OpenAI — new realtime voice models (gpt-realtime-2, -whisper, -translate):
  https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/
- gpt-realtime-2 model: https://developers.openai.com/api/docs/models/gpt-realtime-2
- gpt-realtime-whisper: https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- Realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
- Realtime conversations (GA session shape): https://developers.openai.com/api/docs/guides/realtime-conversations

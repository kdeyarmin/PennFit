// TEMPORARY voice-session diagnostic buffer.
//
// Purpose: pin down why the CareMetric Breathe sales agent greets the caller
// but never responds to caller speech. We have no OpenAI key/logs in the
// debugging environment, so this records the live OpenAI Realtime session
// lifecycle (session opened / errored / closed, caller-speech VAD events,
// model responses, and inbound media frame counts) into an in-memory ring
// buffer that a token-gated debug route returns. That makes ONE real call
// definitively answer: did caller audio reach us? did the server VAD fire on
// caller speech? did the model create a response? was there a session error?
//
// Scope/PHI: only the PLATFORM SALES line (`breathe_prospect`) is
// instrumented — those calls carry no patient data, so the recorded event
// types / timestamps / OpenAI error strings are non-PHI. In-memory only
// (production is single-replica); nothing is persisted.
//
// REMOVE THIS once the inbound-turn-taking issue is fixed.

export interface VoiceDebugEntry {
  ts: string;
  conversationId: string;
  event: string;
  detail?: unknown;
}

const MAX_ENTRIES = 500;
const buffer: VoiceDebugEntry[] = [];

/** Append a diagnostic event (best-effort; never throws into the call path). */
export function pushVoiceDebug(entry: Omit<VoiceDebugEntry, "ts">): void {
  try {
    buffer.push({ ts: new Date().toISOString(), ...entry });
    if (buffer.length > MAX_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_ENTRIES);
    }
  } catch {
    /* diagnostics must never affect the call */
  }
}

/** Snapshot of recent events (newest last). */
export function getVoiceDebug(): VoiceDebugEntry[] {
  return [...buffer];
}

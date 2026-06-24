// TEMPORARY voice-session diagnostic route. GET /voice/debug-events?key=…
//
// Returns the in-memory voice-session debug buffer (see
// lib/voice/voice-session-debug.ts) so the operator can read what the live
// OpenAI Realtime session did on the platform sales line. Token-gated on an
// unguessable constant (the data is non-PHI sales-session telemetry, but we
// still don't want it on an open path). REMOVE with the buffer once the
// inbound-turn-taking issue is fixed.

import { timingSafeEqual } from "node:crypto";

import { Router, type IRouter } from "express";

import { getVoiceDebug } from "../../lib/voice/voice-session-debug";

// Gate on a REAL secret from the environment (VOICE_DEBUG_KEY), not a constant
// committed to source. DISABLED (404) whenever the env var is unset — which is
// the default — so the diagnostic buffer is unreachable in production unless an
// operator deliberately sets a key. REMOVE with the buffer once the
// inbound-turn-taking issue is fixed.
function debugKey(): string {
  return process.env.VOICE_DEBUG_KEY?.trim() ?? "";
}

function keyMatches(provided: unknown): boolean {
  const expected = debugKey();
  if (!expected) return false; // disabled when unset
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const router: IRouter = Router();

router.get("/voice/debug-events", (req, res) => {
  if (!keyMatches(req.query.key)) {
    res.status(404).end();
    return;
  }
  res.json({ events: getVoiceDebug() });
});

export default router;

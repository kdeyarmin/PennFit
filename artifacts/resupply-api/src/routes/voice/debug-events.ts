// TEMPORARY voice-session diagnostic route. GET /voice/debug-events?key=…
//
// Returns the in-memory voice-session debug buffer (see
// lib/voice/voice-session-debug.ts) so the operator can read what the live
// OpenAI Realtime session did on the platform sales line. Token-gated on an
// unguessable constant (the data is non-PHI sales-session telemetry, but we
// still don't want it on an open path). REMOVE with the buffer once the
// inbound-turn-taking issue is fixed.

import { Router, type IRouter } from "express";

import { getVoiceDebug } from "../../lib/voice/voice-session-debug";

// Unguessable gate. Not a real secret (it's in source), just keeps the
// endpoint off casual/scanner traffic for the short life of this diagnostic.
const DEBUG_KEY = "vdbg-7f3a91c2e5b84d06a1";

const router: IRouter = Router();

router.get("/voice/debug-events", (req, res) => {
  if (req.query.key !== DEBUG_KEY) {
    res.status(404).end();
    return;
  }
  res.json({ events: getVoiceDebug() });
});

export default router;

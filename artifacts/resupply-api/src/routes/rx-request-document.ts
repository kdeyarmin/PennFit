// GET /rx-request/document/:token — public token-gated endpoint
// serving the fully-rendered prescription-request PDF.
//
// Twilio fetches this immediately after the dispatch call to obtain
// the fax media. The token carries the packet row id + a short-lived
// HMAC signature; no PHI in the URL itself.
//
// PHI posture:
//   * Signed token prevents enumeration of packet IDs.
//   * Response streams directly to res; PDF bytes never touch the
//     application logger.
//   * No per-request audit row — the dispatch audit on the admin
//     create/send route is sufficient and Twilio fetch traffic
//     would otherwise flood the log.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import PDFDocument from "pdfkit";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  renderPrescriptionRequest,
  validatePrescriptionRequestInputs,
} from "../lib/prescription-request-pdf";
import { verifyPrescriptionRequestToken } from "../lib/prescription-request-token";
import { resolvePrescriptionRequestInputs } from "../lib/prescription-request-resolver";

const router: IRouter = Router();

// Per-IP rate limit: the URL is signed but the route still does a
// DB lookup + PDF render. 60/min keeps a flood of expired or
// invalid tokens from burning CPU.
const rxDocLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

router.get("/rx-request/document/:token", rxDocLimiter, async (req, res) => {
  const rawToken = req.params.token;
  const token = Array.isArray(rawToken)
    ? (rawToken[0] ?? "")
    : (rawToken ?? "");
  const verified = verifyPrescriptionRequestToken(token);
  if (!verified.valid) {
    res.status(403).json({ error: "invalid_token" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolvePrescriptionRequestInputs(
    supabase,
    verified.packetId,
  );
  if (resolved.kind === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (resolved.kind === "invalid_inputs") {
    // The packet exists but is missing required fields for render.
    // Surfacing 422 lets ops distinguish "bad token" from "bad data."
    res
      .status(422)
      .json({ error: "invalid_inputs", missing: resolved.missing });
    return;
  }
  const inputs = resolved.inputs;

  // Final paranoid re-validate before render — defence in depth.
  const validated = validatePrescriptionRequestInputs(inputs);
  if (!validated.ok) {
    res
      .status(422)
      .json({ error: "invalid_inputs", missing: validated.missing });
    return;
  }

  const doc = new PDFDocument({ margin: 72, size: "LETTER" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="rx-request-${verified.packetId.slice(0, 8)}.pdf"`,
  );
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);
  renderPrescriptionRequest(doc, validated.inputs);
  doc.end();
});

export default router;

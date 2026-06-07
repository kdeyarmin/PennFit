// /admin/connection-tests — super-admin "send a test" diagnostics.
//
//   GET  /admin/connection-tests/status   per-channel "is it wired?"
//   POST /admin/connection-tests/email     send a real test email
//   POST /admin/connection-tests/sms       send a real test SMS
//   POST /admin/connection-tests/voice     place a real test call
//   POST /admin/connection-tests/chat      ping the active LLM provider
//
// These back the "Connection tests" section on the super-admin System
// Configuration page (/admin/system/configuration), so an operator can
// verify a credential they just entered actually works — including a
// value saved in the UI but not yet folded into process.env (catalog
// keys are `applyMode: "restart"`). Each test runs against the
// EFFECTIVE env (process.env + saved overlay) via `getEffectiveEnv()`.
//
// Gating: `system.config.manage` — super_admin ONLY (same gate as the
// configuration store itself). The sends cost money / hit external
// vendors, so they sit behind the highest-trust role plus a "sensitive"
// rate limit (30/hr).
//
// PHI / secret posture: the recipient an operator types is their own
// test target; we still never log it (mirrors click-to-dial). The app
// logger sees channel + outcome + structural code only — never the
// recipient, never a secret, never the message body.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";

import { normalizeE164 } from "@workspace/resupply-domain";

import { getEffectiveEnv } from "../../lib/app-config/store";
import {
  computeConnectionTestStatus,
  runChatTest,
  runEmailTest,
  runSmsTest,
  runVoiceTest,
  type ConnectionTestResult,
} from "../../lib/connection-tests/runners";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Accept whatever shape an operator naturally types — a bare 10-digit
// NANP number (8142418865), a punctuated one ((215) 555-1212), or an
// already-E.164 string — and normalize to strict E.164 for Twilio.
// Requiring the operator to pre-format as E.164 (the old strict regex)
// rejected ordinary US numbers with a bare "invalid_body"; normalizing
// here delegates to the same domain helper the inbound SMS/voice paths
// use, so all phone entry points parse identically. `normalizeE164`
// returns null for anything that can't be a real number, which we
// surface as a clear validation message instead of a raw 400.
const e164 = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const normalized = normalizeE164(raw);
    if (normalized === null || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Enter a valid phone number, e.g. (215) 555-1212 or +12155551212.",
      });
      return z.NEVER;
    }
    return normalized;
  });

const emailBody = z.object({ to: z.string().trim().email() }).strict();
const phoneBody = z.object({ to: e164 }).strict();

function badBody(res: Response, err: z.ZodError): void {
  res.status(400).json({
    error: "invalid_body",
    issues: err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

/** Log the OUTCOME only — never the recipient, body, or any secret. */
function logOutcome(adminEmail: string | undefined, result: ConnectionTestResult): void {
  logger.info(
    {
      event: "admin.connection_test.run",
      channel: result.channel,
      ok: result.ok,
      code: result.ok ? null : result.code,
      adminEmail: adminEmail ?? null,
    },
    "admin.connection_test.run",
  );
}

router.get(
  "/admin/connection-tests/status",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  async (_req, res) => {
    const env = await getEffectiveEnv();
    res.json(computeConnectionTestStatus(env));
  },
);

router.post(
  "/admin/connection-tests/email",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "connection_tests.email", preset: "sensitive" }),
  async (req, res) => {
    const parsed = emailBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runEmailTest(env, { to: parsed.data.to });
    logOutcome(req.adminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/admin/connection-tests/sms",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "connection_tests.sms", preset: "sensitive" }),
  async (req, res) => {
    const parsed = phoneBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runSmsTest(env, { to: parsed.data.to });
    logOutcome(req.adminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/admin/connection-tests/voice",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "connection_tests.voice", preset: "sensitive" }),
  async (req, res) => {
    const parsed = phoneBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runVoiceTest(env, { to: parsed.data.to });
    logOutcome(req.adminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/admin/connection-tests/chat",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "connection_tests.chat", preset: "sensitive" }),
  async (req, res) => {
    const env = await getEffectiveEnv();
    const result = await runChatTest(env);
    logOutcome(req.adminEmail, result);
    res.status(200).json(result);
  },
);

export default router;

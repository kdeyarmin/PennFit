// /platform/connection-tests — global super-admin "send a test" diagnostics.
//
//   GET  /platform/connection-tests/status   per-channel "is it wired?"
//   POST /platform/connection-tests/email     send a real test email
//   POST /platform/connection-tests/sms       send a real test SMS
//   POST /platform/connection-tests/voice     place a real test call
//   POST /platform/connection-tests/chat      ping the active LLM provider
//
// These verify the PLATFORM infrastructure credentials (the platform's
// SendGrid, Twilio, and AI vendors) that the super-admin manages on
// /platform/config. They run against the effective platform env
// (process.env + the seed/platform overlay) via `getEffectiveEnv()`,
// including a value saved in the UI but not yet folded into process.env
// (catalog keys are `applyMode: "restart"`).
//
// Gating: `requirePlatformAdmin` — the global super-admin tier. The sends
// cost money / hit external vendors, so they sit behind the highest-trust
// role plus a "sensitive" rate limit.
//
// PHI / secret posture: the recipient an operator types is their own test
// target; we never log it. The app logger sees channel + outcome +
// structural code only — never the recipient, never a secret, never the
// message body.

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
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

// Accept whatever shape an operator naturally types — a bare 10-digit NANP
// number, a punctuated one, or an already-E.164 string — and normalize to
// strict E.164 for Twilio.
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
function logOutcome(
  adminEmail: string | null | undefined,
  result: ConnectionTestResult,
): void {
  logger.info(
    {
      event: "platform.connection_test.run",
      channel: result.channel,
      ok: result.ok,
      code: result.ok ? null : result.code,
      adminEmail: adminEmail ?? null,
    },
    "platform.connection_test.run",
  );
}

router.get(
  "/platform/connection-tests/status",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res) => {
    const env = await getEffectiveEnv();
    res.json(computeConnectionTestStatus(env));
  },
);

router.post(
  "/platform/connection-tests/email",
  adminRateLimit({
    name: "platform_connection_tests.email",
    preset: "sensitive",
  }),
  requirePlatformAdmin,
  async (req, res) => {
    const parsed = emailBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runEmailTest(env, { to: parsed.data.to });
    logOutcome(req.platformAdminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/platform/connection-tests/sms",
  adminRateLimit({
    name: "platform_connection_tests.sms",
    preset: "sensitive",
  }),
  requirePlatformAdmin,
  async (req, res) => {
    const parsed = phoneBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runSmsTest(env, { to: parsed.data.to });
    logOutcome(req.platformAdminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/platform/connection-tests/voice",
  adminRateLimit({
    name: "platform_connection_tests.voice",
    preset: "sensitive",
  }),
  requirePlatformAdmin,
  async (req, res) => {
    const parsed = phoneBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const env = await getEffectiveEnv();
    const result = await runVoiceTest(env, { to: parsed.data.to });
    logOutcome(req.platformAdminEmail, result);
    res.status(200).json(result);
  },
);

router.post(
  "/platform/connection-tests/chat",
  adminRateLimit({
    name: "platform_connection_tests.chat",
    preset: "sensitive",
  }),
  requirePlatformAdmin,
  async (req, res) => {
    const env = await getEffectiveEnv();
    const result = await runChatTest(env);
    logOutcome(req.platformAdminEmail, result);
    res.status(200).json(result);
  },
);

export default router;

// /admin/bot-playground — a safe sandbox for the team to exercise the
// three customer-facing bots (storefront PennBot, the signed-in account
// assistant, and the voice agent's text brain) against scripted
// situations, so they can see how each behaves and tune its prompt.
//
//   GET  /admin/bot-playground/info     scenario catalog + provider status
//   GET  /admin/bot-playground/prompt   render the exact system prompt a
//                                        bot+config would receive (so the
//                                        team can read what it's told)
//   POST /admin/bot-playground/run      run one assistant turn and return
//                                        the reply + every tool call made
//
// Gating: `admin.tools.manage` (supervisor-tier and up) — same gate as
// the other CSR-tool management surfaces. The run endpoint hits a paid
// LLM, so it sits behind the "sensitive" per-actor rate limit.
//
// Safety: the account + voice bots run against SYNTHETIC context and
// SIMULATED tools — no real customer data is read, no order is placed,
// and escalate_to_human never files a real CSR message. The storefront
// bot's mask tools touch only the public catalog, so they run for real.
//
// PHI posture: nothing here reads or writes patient/customer records.
// We log only the bot kind, provider, round count, and tool-call names
// — never the conversation text.

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { normalizeE164 } from "@workspace/resupply-domain";
import {
  createTwilioClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { getPendingSessions } from "../../lib/voice/pending-sessions";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  MAX_PLAYGROUND_TURNS,
  MAX_PLAYGROUND_USER_MESSAGE_CHARS,
  PLAYGROUND_SCENARIOS,
  getPlaygroundPrompt,
  resolvePlaygroundDeps,
  resolveVoiceCallSetup,
  runBotPlayground,
  type BotKind,
} from "../../lib/bot-playground/playground";

const router: IRouter = Router();

const botKindSchema = z.enum(["storefront", "account", "voice"]);

// Synthetic account context overlay — every field optional; the lib
// fills the rest from DEFAULT_ACCOUNT_CONTEXT. Bounded so the prompt
// can't be bloated from the playground UI.
const accountConfigSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    memberSince: z.string().trim().max(16).nullable().optional(),
    totalPaidOrders: z.number().int().min(0).max(9999).optional(),
    activeSubscriptionCount: z.number().int().min(0).max(999).optional(),
    latestOrder: z
      .object({
        orderId: z.string().max(64),
        sessionId: z.string().max(120),
        amountTotalCents: z.number().int().min(0),
        paidAt: z.string().max(32),
        shippedAt: z.string().max(32).nullable(),
        deliveredAt: z.string().max(32).nullable(),
        trackingCarrier: z.string().max(32).nullable(),
        trackingNumber: z.string().max(64).nullable(),
        shipCityState: z.string().max(120).nullable(),
      })
      .nullable()
      .optional(),
    device: z
      .object({
        manufacturer: z.string().max(64),
        model: z.string().max(64),
        pressureSetting: z.string().max(32).nullable(),
      })
      .nullable()
      .optional(),
  })
  .strict();

const voiceConfigSchema = z
  .object({
    practiceName: z.string().trim().min(1).max(120).optional(),
    callerName: z.string().trim().min(1).max(80).optional(),
    callContext: z.string().trim().min(1).max(250).optional(),
    callerKind: z.enum(["patient", "shop_customer"]).optional(),
  })
  .strict();

const configSchema = z
  .object({
    account: accountConfigSchema.optional(),
    voice: voiceConfigSchema.optional(),
  })
  .strict();

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_PLAYGROUND_USER_MESSAGE_CHARS),
});

const runBodySchema = z
  .object({
    bot: botKindSchema,
    messages: z.array(messageSchema).min(1).max(MAX_PLAYGROUND_TURNS),
    config: configSchema.optional(),
  })
  .strict();

// GET scenario catalog + which provider the playground will use.
router.get(
  "/admin/bot-playground/info",
  requirePermission("admin.tools.manage"),
  adminReadRateLimiter,
  (_req, res) => {
    const deps = resolvePlaygroundDeps();
    res.json({
      provider: deps.provider,
      scenarios: PLAYGROUND_SCENARIOS,
      limits: {
        maxTurns: MAX_PLAYGROUND_TURNS,
        maxMessageChars: MAX_PLAYGROUND_USER_MESSAGE_CHARS,
      },
    });
  },
);

// GET the rendered system prompt for inspection ("what is this bot told?").
const promptQuerySchema = z.object({
  bot: botKindSchema,
  callerKind: z.enum(["patient", "shop_customer"]).optional(),
});

router.get(
  "/admin/bot-playground/prompt",
  requirePermission("admin.tools.manage"),
  adminReadRateLimiter,
  (req, res) => {
    const parsed = promptQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const bot: BotKind = parsed.data.bot;
    const config =
      bot === "voice" && parsed.data.callerKind
        ? { voice: { callerKind: parsed.data.callerKind } }
        : {};
    res.json(getPlaygroundPrompt(bot, config));
  },
);

// POST run one assistant turn.
router.post(
  "/admin/bot-playground/run",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "bot_playground.run", preset: "sensitive" }),
  async (req, res) => {
    const parsed = runBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const last = parsed.data.messages.at(-1);
    if (!last || last.role !== "user") {
      res
        .status(400)
        .json({ error: "The last message must be from the user." });
      return;
    }

    const result = await runBotPlayground({
      bot: parsed.data.bot,
      messages: parsed.data.messages,
      config: parsed.data.config,
    });

    logger.info(
      {
        event: "bot_playground_run",
        bot: parsed.data.bot,
        provider: result.provider,
        rounds: result.rounds,
        // Names only — never the conversation text or tool args.
        toolCalls: result.toolCalls.map((t) => t.name),
        offline: result.offline ?? false,
        degraded: result.degraded ?? false,
      },
      "bot playground: ran a turn",
    );

    res.json(result);
  },
);

// POST place a LIVE outbound test call so an admin can actually TALK to
// the voice agent (the part you can only tune by ear: greeting, prosody,
// turn-taking, empathy, scope refusal, handoff). We dial the admin's own
// number and connect them to the production Realtime bridge in DIAGNOSTIC
// mode — real persona prompt, no patient lookup, no DB, no account tools —
// reusing the same /voice/twiml-connect → WS path inbound/outbound calls
// use. The chosen scenario/callerKind only sets how the agent FRAMES the
// call; no real customer data is ever touched.
const voiceCallBody = z
  .object({
    // The admin's own test phone. Accept any natural form; normalized to
    // E.164 below. Never logged or audited (their own number, but we treat
    // it as sensitive — same posture as connection-tests / click-to-dial).
    to: z.string().trim().min(7).max(32),
    callerKind: z.enum(["patient", "shop_customer"]).optional(),
    scenarioId: z.string().trim().max(64).optional(),
    callContext: z.string().trim().max(250).optional(),
  })
  .strict();

router.post(
  "/admin/bot-playground/voice-call",
  requirePermission("admin.tools.manage"),
  // Real outbound call — costs money + rings a phone. Conservative cap.
  adminRateLimit({ name: "bot_playground.voice_call", preset: "sensitive" }),
  async (req, res) => {
    const config = readVoiceConfigOrNull();
    if (!config) {
      res.status(503).json({
        error: "voice_not_configured",
        message:
          "Voice is not configured. Set OPENAI_API_KEY, TWILIO_ACCOUNT_SID, " +
          "TWILIO_AUTH_TOKEN, and RESUPPLY_VOICE_PUBLIC_BASE_URL to place a " +
          "live test call.",
      });
      return;
    }
    if (!config.twilioPhoneNumber) {
      res.status(503).json({
        error: "voice_outbound_not_configured",
        message:
          "TWILIO_PHONE_NUMBER is not set — outbound calls cannot be placed.",
      });
      return;
    }

    const parsed = voiceCallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const to = normalizeE164(parsed.data.to);
    if (!to) {
      res.status(400).json({
        error: "invalid_phone",
        message: "Enter a valid phone number to call.",
      });
      return;
    }

    const { callContext, callerKind } = resolveVoiceCallSetup({
      scenarioId: parsed.data.scenarioId,
      callContext: parsed.data.callContext,
      callerKind: parsed.data.callerKind,
    });

    // Register a DIAGNOSTIC pending session before dialing — the WS
    // upgrade can race the API response. diagnostic:true routes the
    // upgrade to the no-patient bridge (real persona, no tools, no DB).
    const conversationId = randomUUID();
    getPendingSessions().register({
      conversationId,
      patientId: "",
      episodeId: "",
      diagnostic: true,
      callContext,
      callerKind,
    });

    const base = config.publicBaseUrl;
    const twimlUrl = `${base}/resupply-api/voice/twiml-connect?conversationId=${encodeURIComponent(
      conversationId,
    )}`;
    const statusCallbackUrl = `${base}/resupply-api/voice/status-callback?conversationId=${encodeURIComponent(
      conversationId,
    )}`;

    let callSid: string;
    try {
      const twilio = createTwilioClient({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
      });
      const result = await twilio.placeCall({
        to,
        from: config.twilioPhoneNumber,
        url: twimlUrl,
        statusCallbackUrl,
      });
      callSid = result.sid;
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        logger.error(
          { event: "bot_playground_voice_call_config_error" },
          "bot playground: twilio config error placing test call",
        );
        res.status(503).json({ error: "twilio_config_error" });
        return;
      }
      if (err instanceof TwilioApiError) {
        logger.warn(
          {
            event: "bot_playground_voice_call_twilio_error",
            twilioStatus: err.status ?? null,
            twilioCode: err.code ?? null,
          },
          "bot playground: twilio rejected the test call",
        );
        res.status(502).json({
          error: "twilio_api_error",
          twilioStatus: err.status,
          twilioCode: err.code,
        });
        return;
      }
      throw err;
    }

    getPendingSessions().attachCallSid(conversationId, callSid);

    // Audit the admin action. PHI/secret-safe: the destination phone is
    // NOT recorded (admin's own test target — same posture as place-call /
    // click-to-dial), only structural facts.
    await logAudit({
      action: "voice.call.placed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: {
        conversation_id: conversationId,
        source: "bot_playground_test_call",
        caller_kind: callerKind,
        diagnostic: true,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "bot playground voice-call audit write failed");
    });

    logger.info(
      {
        event: "bot_playground_voice_call_placed",
        conversationId,
        callerKind,
      },
      "bot playground: placed live voice test call",
    );

    res.status(201).json({ conversationId, callSid, callerKind });
  },
);

export default router;

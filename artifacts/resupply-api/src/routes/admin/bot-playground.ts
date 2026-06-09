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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logger } from "../../lib/logger";
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

export default router;

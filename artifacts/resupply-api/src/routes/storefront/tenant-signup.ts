// POST /tenant-signup — public self-serve account creation for the
// Breathe marketing site. Creates a new tenant organization + its first
// admin login (email-verified) so a DME can onboard themselves instead
// of routing through the operator CLI.
//
// The heavy lifting (and the security notes) live in
// ../../lib/tenant-signup-service.ts. This handler is the HTTP boundary:
// honeypot, Zod validation, optional Turnstile, slug derivation, and
// mapping the service result to a status code. Anonymous (no session);
// per-IP rate limited in app.ts. PII: the email + password are never
// logged.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  createSelfServeTenant,
  slugifyOrgName,
} from "../../lib/tenant-signup-service.js";
import { verifyTurnstile } from "../../lib/turnstile.js";
import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

const signupBody = z.object({
  orgName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  // Password policy: length beats complexity (>= 12, <= 1024) — matches
  // the auth lib. The service re-checks as a defensive backstop.
  password: z.string().min(12).max(1024),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
    .optional(),
  captchaToken: z.string().max(4096).optional(),
});

router.post("/tenant-signup", async (req, res) => {
  // Honeypot before zod (zod would strip the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)
    ?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.json({ ok: true });
    return;
  }

  const parsed = signupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check the form and try again." });
    return;
  }
  const {
    orgName,
    email,
    password,
    slug: providedSlug,
    captchaToken,
  } = parsed.data;

  // Optional Turnstile — skipped (returns true) when no secret is set.
  const human = await verifyTurnstile(captchaToken, req.ip);
  if (!human) {
    res
      .status(400)
      .json({ error: "Could not verify you're human. Please try again." });
    return;
  }

  const slug = providedSlug ?? slugifyOrgName(orgName);
  if (!slug || slug.length < 2) {
    res.status(400).json({
      error: "Please use a workspace name with at least a couple of letters.",
    });
    return;
  }

  try {
    const result = await createSelfServeTenant({
      orgName,
      slug,
      adminEmail: email,
      password,
    });
    if (result.ok) {
      res.status(201).json({
        ok: true,
        slug: result.slug,
        signInUrl: result.signInUrl,
      });
      return;
    }
    const status =
      result.reason === "slug_taken" || result.reason === "email_taken"
        ? 409
        : result.reason === "unavailable"
          ? 503
          : 400;
    res.status(status).json({ error: result.message, reason: result.reason });
  } catch (err) {
    logger.error(
      { event: "tenant_signup_unhandled", name: (err as Error)?.name ?? null },
      "tenant signup threw",
    );
    res.status(500).json({
      error: "Something went wrong creating your account. Please try again.",
    });
  }
});

export default router;

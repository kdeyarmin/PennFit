import type { Request, Response } from "express";

import { checkCsrf } from "../csrf";
import type { RateLimitConfig } from "../rate-limit";

import { authError } from "./responses";
import type { AuthDeps } from "./types";

interface CriticalMutationOptions {
  action: string;
  rateLimit: RateLimitConfig;
}

export async function enforceCriticalMutationPolicy(
  deps: AuthDeps,
  req: Request,
  res: Response,
  options: CriticalMutationOptions,
): Promise<boolean> {
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    void deps.audit({
      action: `${options.action}.rejected`,
      ip: req.ip ?? null,
      metadata: { reason: `csrf_${csrf.reason ?? "unknown"}` },
    });
    authError(res, 403, "csrf_failed", "Session validation failed.");
    return false;
  }

  const ip = req.ip ?? null;
  const ipSentinel = `__critical:${options.action}:${ip ?? "unknown"}`;
  const recent = await deps.repo.countRecentFailures({
    emailLower: ipSentinel,
    ip: null,
    sinceMs: options.rateLimit.windowMs,
  });
  if (recent >= options.rateLimit.maxPerIp) {
    const retryAfter = Math.ceil(options.rateLimit.windowMs / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    authError(res, 429, "rate_limited", "Too many requests.");
    return false;
  }
  return true;
}

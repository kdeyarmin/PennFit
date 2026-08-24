// Shared limiter for the two public mask-scoring entry points.
//
// `/api/recommend` (the legacy engine) and `/api/fit/*` (the clinical
// assessment) run the same CPU-bound scoring engine on the single Node
// process, so an unthrottled flood is event-loop pressure rather than a
// token or PHI concern. ONE instance is exported and mounted on both, so
// they share a single per-IP bucket — a client cannot get two budgets by
// alternating between the paths.
//
// Built DIRECTLY from `express-rate-limit`, not through the local
// `rateLimit()` wrapper, for the same reason `adminReadRateLimiter` and
// `adminWriteRateLimiter` are: CodeQL's js/missing-rate-limiting query
// recognises the upstream middleware at the call site but cannot trace
// this repo's factory wrappers. Living in its own module (rather than
// inline in app.ts) is what lets the route that performs authorization
// apply it AT the registration, where the query can see it — an
// app-level `app.use(path, limiter)` in another file is invisible to it.
//
// Applying it at the route rather than app-level does not weaken the cap:
// a `/api/recommend` request traverses only path-scoped limiters that
// don't match it and the admin/shop CSRF gates in between, so the limiter
// still runs before any handler work.
//
// Mount it ONCE per request path. Attaching the same instance both
// app-level and at the route would count a single request twice against
// the bucket and silently halve the effective budget.

import {
  rateLimit as expressRateLimit,
  ipKeyGenerator,
} from "express-rate-limit";
import type { Request, RequestHandler } from "express";

import { RATE_LIMITS } from "../lib/rate-limits-config";

export const storefrontRecommendLimiter: RequestHandler = expressRateLimit({
  windowMs: RATE_LIMITS.storefront_recommend.windowMs,
  limit: RATE_LIMITS.storefront_recommend.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: {
    error:
      "Too many recommendation requests from this network. Please wait a moment and try again.",
  },
});

import { Router, raw, type ErrorRequestHandler, type IRouter } from "express";
import {
  createCentralAdminHandler,
  type CentralAdminOptions,
} from "../lib/central-admin";
import { createTenantLifecycleHandler } from "../lib/tenant-lifecycle";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../middlewares/admin-rate-limit";

/** Mounted before the general body parser; accepts one bounded server-to-server operation. */
export function createCentralAdminRouter(
  options: CentralAdminOptions = {},
): IRouter {
  const router = Router();
  for (const route of [
    {
      path: "/read",
      handler: createCentralAdminHandler(options),
      limiter: adminReadRateLimiter,
      limit: "2kb",
    },
    {
      path: "/tenant-lifecycle",
      handler: createTenantLifecycleHandler(options),
      limiter: adminWriteRateLimiter,
      limit: "16kb",
    },
  ]) {
    router.all(
      route.path,
      route.limiter,
      raw({ type: () => true, limit: route.limit, inflate: false }),
      async (req, res) => {
        const controller = new AbortController();
        const abort = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.once("aborted", abort);
        res.once("close", abort);
        try {
          const headers = new Headers();
          for (const name of [
            "authorization",
            "content-type",
            "origin",
            "cookie",
          ]) {
            const value = req.get(name);
            if (value !== undefined) headers.set(name, value);
          }
          const request = new Request(
            `https://cmbreathe.com/resupply-api/central-admin${route.path}${new URL(req.originalUrl, "https://cmbreathe.com").search}`,
            {
              method: req.method,
              headers,
              signal: controller.signal,
              body: ["GET", "HEAD"].includes(req.method)
                ? undefined
                : Buffer.isBuffer(req.body)
                  ? req.body.toString("utf8")
                  : "",
            },
          );
          const response = await route.handler(request);
          for (const [key, value] of response.headers)
            res.setHeader(key, value);
          res.status(response.status).send(await response.text());
        } finally {
          req.off("aborted", abort);
          res.off("close", abort);
        }
      },
    );
  }
  const invalidBody: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 413
        ? 413
        : 400;
    res.setHeader("Cache-Control", "no-store, private");
    res.status(status).json({ error: { code: "invalid_request" } });
  };
  router.use(invalidBody);
  return router;
}

import { Router, type IRouter } from "express";
import { z } from "zod";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  ownerAnalyticsQuerySchema,
  ownerAnalyticsWindow,
  ownerBusinessAnalyticsSchema,
  ownerFinancialAnalyticsSchema,
  type OwnerAnalyticsResponse,
  type OwnerAnalyticsSection,
} from "@workspace/resupply-domain";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminRateLimit,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/analytics/owner",
  adminReadRateLimiter,
  // metrics.read is the existing management reporting tier. cost.read alone
  // would admit billing staff to this whole-business management surface.
  requirePermission("metrics.read"),
  requirePermission("cost.read"),
  adminRateLimit({
    name: "owner_analytics.read",
    preset: "query",
    max: 30,
    windowMs: 60_000,
  }),
  async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const parsed = ownerAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ error: "invalid_query" });
    const asOf = new Date();
    let window;
    try {
      window = ownerAnalyticsWindow(parsed.data, asOf);
    } catch {
      return res.status(400).json({ error: "invalid_date_range" });
    }
    if (!req.orgId)
      return res.status(500).json({ error: "tenant_context_missing" });
    const db = getOrgScopedClient(req.orgId);
    const args = {
      p_org_id: req.orgId,
      p_from: window.from,
      p_to: window.to,
      p_as_of: asOf.toISOString(),
    };
    async function section<T>(
      name: "business" | "financial",
      schema: z.ZodType<T>,
    ): Promise<OwnerAnalyticsSection<T>> {
      let failureCode = "request_failed";
      try {
        const rpc =
          name === "business"
            ? "owner_business_analytics"
            : "owner_pricing_analytics";
        const result = await db
          .raw()
          .schema("resupply")
          .rpc(rpc, args)
          .abortSignal(AbortSignal.timeout(20_000));
        if (result.error) {
          failureCode =
            typeof result.error.code === "string" &&
            /^[A-Z0-9_]{1,40}$/.test(result.error.code)
              ? result.error.code
              : "source_unavailable";
          throw new Error("source_unavailable");
        }
        const data = schema.safeParse(result.data);
        if (!data.success) {
          failureCode = "source_contract_invalid";
          throw new Error("source_contract_invalid");
        }
        return { status: "available", data: data.data };
      } catch {
        // Aggregate values and raw database errors are deliberately not logged.
        logger.warn(
          {
            event: "owner_analytics.section_unavailable",
            section: name,
            code: failureCode,
          },
          "Owner analytics source unavailable",
        );
        return {
          status: "unavailable",
          message:
            name === "business"
              ? "Business activity is temporarily unavailable. Retry to load current figures."
              : "Financial records are temporarily unavailable. Retry to load current figures.",
        };
      }
    }
    const [business, financial] = await Promise.all([
      section("business", ownerBusinessAnalyticsSchema),
      section("financial", ownerFinancialAnalyticsSchema),
    ]);
    if (business.status === "unavailable" && financial.status === "unavailable")
      return res.status(503).json({
        error: "owner_analytics_unavailable",
        message: "Business reports are temporarily unavailable. Please retry.",
      });
    // Preserve quiet UTC days in charts, tables, and exports. The reporting
    // window is half-open: a midnight end must not add an extra empty day.
    const dates: string[] = [];
    for (
      let time = Date.parse(`${window.from.slice(0, 10)}T00:00:00.000Z`);
      time < Date.parse(window.to);
      time += 86_400_000
    )
      dates.push(new Date(time).toISOString().slice(0, 10));
    if (business.status === "available") {
      const daily = new Map(business.data.daily.map((row) => [row.date, row]));
      business.data.daily = dates.map(
        (date) =>
          daily.get(date) ?? {
            date,
            orderRequestsCreated: 0,
            orderRequestsSigned: 0,
            episodesOpened: 0,
            shipmentLinesRecorded: 0,
            patientsAdded: 0,
          },
      );
    }
    if (financial.status === "available") {
      const daily = new Map(financial.data.daily.map((row) => [row.date, row]));
      financial.data.daily = dates.map(
        (date) =>
          daily.get(date) ?? {
            date,
            revenueCents: 0,
            costCents: 0,
            eventCount: 0,
          },
      );
    }
    const response: OwnerAnalyticsResponse = {
      generatedAt: asOf.toISOString(),
      window,
      business,
      financial,
    };
    return res.json(response);
  },
);

export default router;

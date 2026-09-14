import {
  Router,
  type IRouter,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { roleHasPermission } from "@workspace/resupply-auth";
import {
  getOrgScopedClient,
  type Database,
  type ResupplyTable,
} from "@workspace/resupply-db";
import { PricingValidationError } from "@workspace/resupply-domain";
import { calculateDiscountHeadroom } from "../../lib/pricing/discount-headroom";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  activateBatchSchema,
  actualSchema,
  alertReviewSchema,
  approveQuoteSchema,
  batchSchema,
  closeActualsSchema,
  offerSchema,
  policySchema,
  proposalSchema,
  publishSchema,
  revenueProfileSchema,
  reviewProposalSchema,
  saveQuoteSchema,
  scenarioSchema,
  scheduleBatchSchema,
  skuSchema,
} from "../../lib/pricing/contracts";
import {
  approvalClass,
  batchDto,
  getActivePrices,
  getPricingState,
  getQuote,
  getReconciliation,
  listCurrentOffers,
  mutatePricing,
  offerDto,
  policyDto,
  PricingError,
  proposalDto,
  quoteDto,
  recommendResolved,
  resolveScenario,
  revenueProfileDto,
  saveQuote,
} from "../../lib/pricing/service";

const router: IRouter = Router();
// A reviewed CSV can contain 100 rows. Key the limit after authentication so
// independent CSRs do not share the fallback "no-actor" bucket.
const mutation = adminRateLimit({
  name: "pricing.write",
  preset: "mutation",
  max: 600,
});
const authenticatedLimit: RequestHandler = (req, res, next) =>
  req.method === "GET" ? next() : mutation(req, res, next);
const uuid = z.string().uuid();
const pagination = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sku: skuSchema.optional(),
  patientId: uuid.optional(),
  status: z.enum(["draft", "pending_approval", "approved", "bound"]).optional(),
  view: z.enum(["current", "latest", "history"]).default("current"),
});
type TableRow<T extends ResupplyTable> =
  Database["resupply"]["Tables"][T]["Row"];
function context(req: Request) {
  if (!req.orgId || !req.adminUserId)
    throw new PricingError("tenant_context_missing", 500);
  return {
    scoped: getOrgScopedClient(req.orgId),
    actor: req.adminUserId,
    mayVerify: Boolean(
      req.adminGranularRole &&
      roleHasPermission(req.adminGranularRole, "pricing.manage"),
    ),
  };
}
function endpoint(action: (req: Request, res: Response) => Promise<void>) {
  return [
    authenticatedLimit,
    async (req: Request, res: Response) => {
      try {
        await action(req, res);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({
            error: "invalid_body",
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }
        if (error instanceof PricingValidationError) {
          res
            .status(422)
            .json({ error: "invalid_pricing_input", issues: error.issues });
          return;
        }
        if (error instanceof PricingError) {
          res.status(error.status).json({ error: error.code });
          return;
        }
        // Do not echo financial snapshots, patient-linked JSON or raw SQL errors.
        req.log?.error(
          { errorType: error instanceof Error ? error.name : "unknown" },
          "pricing.request_failed",
        );
        res.status(503).json({ error: "pricing_unavailable" });
      }
    },
  ];
}
router.get(
  "/admin/pricing/state",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    res.json(await getPricingState(context(req).scoped));
  }),
);
router.get(
  "/admin/pricing/summary",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .rpc("pricing_summary", { p_org_id: scoped.orgId });
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json(data);
  }),
);
router.get(
  "/admin/pricing/offers",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, mayVerify } = context(req);
    const { offset, limit, sku, view } = pagination.parse(req.query);
    if (view !== "current") {
      if (!mayVerify) throw new PricingError("permission_denied", 403);
      let query = scoped
        .from("pricing_offers")
        .select("*")
        .eq("is_current", true)
        .order("sku")
        .order("id")
        .range(offset, offset + limit);
      if (sku) query = query.eq("sku", sku);
      const { data, error } = await query;
      if (error) throw new PricingError("pricing_unavailable", 503);
      res.json({
        offers: (data ?? []).slice(0, limit).map(offerDto),
        hasMore: (data?.length ?? 0) > limit,
      });
      return;
    }
    const offers = await listCurrentOffers(scoped, {
      offset,
      limit: limit + 1,
      sku,
    });
    res.json({
      offers: offers.slice(0, limit),
      hasMore: offers.length > limit,
    });
  }),
);
router.get(
  "/admin/pricing/offers/:id/versions",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit } = pagination.parse(req.query);
    const { data, error } = await scoped
      .from("pricing_offers")
      .select("*")
      .eq("id", uuid.parse(req.params.id))
      .order("version", { ascending: false })
      .range(offset, offset + limit);
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      offers: (data ?? []).slice(0, limit).map(offerDto),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.post(
  "/admin/pricing/offers",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const payload = offerSchema.parse(req.body);
    const catalog = await scoped
      .from("products")
      .select("sku")
      .eq("sku", payload.sku)
      .maybeSingle();
    if (catalog.error) throw new PricingError("pricing_unavailable", 503);
    if (!catalog.data) throw new PricingError("unresolved_sku");
    res
      .status(201)
      .json(
        offerDto(
          (await mutatePricing(
            scoped,
            actor,
            "offer",
            payload,
          )) as unknown as TableRow<"pricing_offers">,
        ),
      );
  }),
);
router.get(
  "/admin/pricing/policies",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit } = pagination.parse(req.query);
    const { data, error } = await scoped
      .from("pricing_policies")
      .select("*")
      .order("version", { ascending: false })
      .range(offset, offset + limit);
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      policies: (data ?? []).slice(0, limit).map(policyDto),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.post(
  "/admin/pricing/policies",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    res
      .status(201)
      .json(
        policyDto(
          (await mutatePricing(
            scoped,
            actor,
            "policy",
            policySchema.parse(req.body),
          )) as unknown as TableRow<"pricing_policies">,
        ),
      );
  }),
);
router.post(
  "/admin/pricing/policies/:id/publish",
  requirePermission("pricing.publish"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    await mutatePricing(scoped, actor, "publish", {
      ...publishSchema.parse(req.body),
      id: uuid.parse(req.params.id),
    });
    res.json(await getPricingState(scoped));
  }),
);
router.get(
  "/admin/pricing/revenue-profiles",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, mayVerify } = context(req);
    const { offset, limit, patientId, view } = pagination.parse(req.query);
    if (view !== "current") {
      if (!mayVerify) throw new PricingError("permission_denied", 403);
      let query = scoped
        .from("pricing_revenue_profiles")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id")
        .order("version", { ascending: false })
        .range(offset, offset + limit);
      if (patientId) query = query.eq("patient_id", patientId);
      const { data, error } = await query;
      if (error) throw new PricingError("pricing_unavailable", 503);
      res.json({
        profiles: (data ?? []).slice(0, limit).map(revenueProfileDto),
        hasMore: (data?.length ?? 0) > limit,
      });
      return;
    }
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .rpc("pricing_current_revenue_profiles", {
        p_org_id: scoped.orgId,
        p_patient_id: patientId,
        p_offset: offset,
        p_limit: limit + 1,
      });
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      profiles: (data ?? []).slice(0, limit).map(revenueProfileDto),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.post(
  "/admin/pricing/revenue-profiles",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const payload = revenueProfileSchema.parse(req.body);
    const catalog = await scoped
      .from("products")
      .select("sku")
      .in(
        "sku",
        payload.lines.map((line) => line.sku),
      )
      .eq("active", true);
    if (catalog.error) throw new PricingError("pricing_unavailable", 503);
    if (catalog.data?.length !== payload.lines.length)
      throw new PricingError("unresolved_sku");
    res
      .status(201)
      .json(
        revenueProfileDto(
          (await mutatePricing(
            scoped,
            actor,
            "revenue_profile",
            payload,
          )) as unknown as TableRow<"pricing_revenue_profiles">,
        ),
      );
  }),
);
router.get(
  "/admin/pricing/active-prices",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    res.json({ batch: await getActivePrices(context(req).scoped) });
  }),
);
router.post(
  "/admin/pricing/evaluate",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, mayVerify } = context(req);
    res.json(
      await resolveScenario(scoped, scenarioSchema.parse(req.body), {
        mayVerify,
      }),
    );
  }),
);
router.post(
  "/admin/pricing/discount-headroom",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, mayVerify } = context(req);
    const payload = z
      .object({
        scenario: scenarioSchema,
        maxAdditionalDiscountCents: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const resolved = await resolveScenario(scoped, payload.scenario, {
      mayVerify,
    });
    res.json({
      ...resolved,
      discountHeadroom: await calculateDiscountHeadroom(
        resolved,
        payload.maxAdditionalDiscountCents,
      ),
    });
  }),
);
router.post(
  "/admin/pricing/recommend",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, mayVerify } = context(req);
    const payload = z
      .object({ scenario: scenarioSchema, lineId: uuid.optional() })
      .strict()
      .parse(req.body);
    const resolved = await resolveScenario(scoped, payload.scenario, {
      mayVerify,
    });
    res.json({
      ...resolved,
      recommendation: recommendResolved(resolved, payload.lineId),
    });
  }),
);
router.get(
  "/admin/pricing/quotes",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit, status, patientId } = pagination.parse(req.query);
    let query = scoped
      .from("pricing_quotes")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + limit);
    if (status) query = query.eq("status", status);
    if (patientId) query = query.eq("patient_id", patientId);
    const { data, error } = await query;
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      quotes: (data ?? []).slice(0, limit).map(quoteDto),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.get(
  "/admin/pricing/quotes/:id",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    res.json(
      quoteDto(await getQuote(context(req).scoped, uuid.parse(req.params.id))),
    );
  }),
);
router.post(
  "/admin/pricing/quotes",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, actor, mayVerify } = context(req);
    res
      .status(201)
      .json(
        await saveQuote(
          scoped,
          actor,
          saveQuoteSchema.parse(req.body),
          mayVerify,
        ),
      );
  }),
);
router.post(
  "/admin/pricing/quotes/:id/approve",
  requirePermission("pricing.approve"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    res.json(
      quoteDto(
        (await mutatePricing(scoped, actor, "approve", {
          ...approveQuoteSchema.parse(req.body),
          id: uuid.parse(req.params.id),
        })) as unknown as TableRow<"pricing_quotes">,
      ),
    );
  }),
);
router.get(
  "/admin/pricing/proposals",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit } = pagination.parse(req.query);
    const { data, error } = await scoped
      .from("pricing_proposals")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + limit);
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      proposals: (data ?? []).slice(0, limit).map(proposalDto),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.post(
  "/admin/pricing/proposals",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    res
      .status(201)
      .json(
        proposalDto(
          (await mutatePricing(
            scoped,
            actor,
            "proposal",
            proposalSchema.parse(req.body),
          )) as unknown as TableRow<"pricing_proposals">,
        ),
      );
  }),
);
router.post(
  "/admin/pricing/proposals/:id/review",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    res.json(
      proposalDto(
        (await mutatePricing(scoped, actor, "review_proposal", {
          ...reviewProposalSchema.parse(req.body),
          id: uuid.parse(req.params.id),
        })) as unknown as TableRow<"pricing_proposals">,
      ),
    );
  }),
);
router.post(
  "/admin/pricing/batches/preview",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor, mayVerify } = context(req);
    const payload = batchSchema.parse(req.body);
    const entries = [];
    const contexts = new Set<string>();
    for (const scenario of payload.scenarios) {
      if (scenario.patientId)
        throw new PricingError("catalog_batch_cannot_link_patient");
      const key = `${scenario.revenue.mode}:${scenario.lines
        .map((line) => `${line.sku}:${line.quantity}`)
        .sort()
        .join("|")}`;
      if (contexts.has(key)) throw new PricingError("duplicate_price_context");
      contexts.add(key);
      const resolved = await resolveScenario(scoped, scenario, { mayVerify });
      entries.push({ ...resolved, approvalClass: approvalClass(resolved) });
    }
    const row = await mutatePricing(scoped, actor, "batch", {
      name: payload.name,
      entries,
    });
    res
      .status(201)
      .json(batchDto(row as unknown as TableRow<"pricing_price_lists">, null));
  }),
);
router.get(
  "/admin/pricing/batches",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit } = pagination.parse(req.query);
    const state = await getPricingState(scoped);
    const { data, error } = await scoped
      .from("pricing_price_lists")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + limit);
    if (error) throw new PricingError("pricing_unavailable", 503);
    res.json({
      batches: (data ?? [])
        .slice(0, limit)
        .map((row: TableRow<"pricing_price_lists">) =>
          batchDto(row, state.activePriceListId),
        ),
      hasMore: (data?.length ?? 0) > limit,
    });
  }),
);
router.post(
  "/admin/pricing/batches/:id/activate",
  requirePermission("pricing.publish"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    await mutatePricing(scoped, actor, "activate", {
      ...activateBatchSchema.parse(req.body),
      id: uuid.parse(req.params.id),
    });
    res.json(await getPricingState(scoped));
  }),
);
router.post(
  "/admin/pricing/batches/:id/schedule",
  requirePermission("pricing.publish"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const row = await mutatePricing(scoped, actor, "schedule", {
      ...scheduleBatchSchema.parse(req.body),
      id: uuid.parse(req.params.id),
    });
    res.json(
      batchDto(
        row as unknown as TableRow<"pricing_price_lists">,
        (await getPricingState(scoped)).activePriceListId,
      ),
    );
  }),
);
router.post(
  "/admin/pricing/batches/:id/cancel-schedule",
  requirePermission("pricing.publish"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const row = await mutatePricing(scoped, actor, "cancel_schedule", {
      ...activateBatchSchema.parse(req.body),
      id: uuid.parse(req.params.id),
    });
    res.json(
      batchDto(
        row as unknown as TableRow<"pricing_price_lists">,
        (await getPricingState(scoped)).activePriceListId,
      ),
    );
  }),
);
router.get(
  "/admin/pricing/alerts",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped } = context(req);
    const { offset, limit } = pagination.parse(req.query);
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .rpc("pricing_alerts", {
        p_org_id: scoped.orgId,
        p_offset: offset,
        p_limit: limit + 1,
      });
    if (error || !Array.isArray(data))
      throw new PricingError("pricing_unavailable", 503);
    res.json({ alerts: data.slice(0, limit), hasMore: data.length > limit });
  }),
);
router.post(
  "/admin/pricing/alerts/:key/review",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    res.json(
      await mutatePricing(scoped, actor, "alert_review", {
        ...alertReviewSchema.parse(req.body),
        key: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .parse(req.params.key),
      }),
    );
  }),
);
router.get(
  "/admin/pricing/quotes/:id/actuals",
  requirePermission("pricing.evaluate"),
  ...endpoint(async (req, res) => {
    res.json(
      await getReconciliation(context(req).scoped, uuid.parse(req.params.id)),
    );
  }),
);
router.post(
  "/admin/pricing/quotes/:id/actuals",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const id = uuid.parse(req.params.id);
    await mutatePricing(scoped, actor, "actual", {
      ...actualSchema.parse(req.body),
      quoteId: id,
    });
    res.status(201).json(await getReconciliation(scoped, id));
  }),
);
router.post(
  "/admin/pricing/quotes/:id/actuals/close",
  requirePermission("pricing.manage"),
  ...endpoint(async (req, res) => {
    const { scoped, actor } = context(req);
    const id = uuid.parse(req.params.id);
    await mutatePricing(scoped, actor, "close_actuals", {
      ...closeActualsSchema.parse(req.body),
      id,
    });
    res.json(await getReconciliation(scoped, id));
  }),
);
export default router;

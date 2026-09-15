import { Router, type IRouter } from "express";
import { z } from "zod";
import { getOrgScopedClient, type Database } from "@workspace/resupply-db";
import type { Quote } from "../../lib/pricing/contracts";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  prepareCsrPricing,
  quoteDto,
  PricingError,
} from "../../lib/pricing/service";

const router: IRouter = Router();
const schema = z
  .object({ draftIds: z.array(z.string().uuid()).min(1).max(50) })
  .strict()
  .refine(
    (b) => new Set(b.draftIds).size === b.draftIds.length,
    "Select each draft once.",
  );

router.post(
  "/admin/pricing/resupply-review",
  adminRateLimit({
    name: "pricing_resupply_review",
    windowMs: 60_000,
    max: 10,
  }),
  requirePermission("pricing.evaluate"),
  async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(req.orgId);
    const drafts = await db
      .from("resupply_order_drafts")
      .select("id,patient_id,suggested_product_id,suggested_quantity,status")
      .in("id", parsed.data.draftIds);
    if (drafts.error) {
      res.status(503).json({ error: "pricing_unavailable" });
      return;
    }
    const reviews = [];
    for (const draftId of parsed.data.draftIds) {
      const draft = drafts.data?.find(
        (d: Database["resupply"]["Tables"]["resupply_order_drafts"]["Row"]) =>
          d.id === draftId,
      );
      const base = {
        draftId,
        patientId: draft?.patient_id ?? null,
        sku: draft?.suggested_product_id ?? null,
        quantity: draft?.suggested_quantity ?? null,
      };
      if (!draft || !["proposed", "approved"].includes(draft.status)) {
        reviews.push({
          ...base,
          state: "unavailable",
          message: "This draft is unavailable or has already been handled.",
        });
        continue;
      }
      if (!draft.suggested_product_id) {
        reviews.push({
          ...base,
          state: "review_needed",
          message:
            "Select the exact catalog item in this patient's draft before pricing.",
        });
        continue;
      }
      const candidates = await db
        .from("pricing_quotes")
        .select("*")
        .eq("patient_id", draft.patient_id)
        .eq("status", "approved")
        .order("updated_at", { ascending: false })
        .order("id")
        .limit(100);
      if (candidates.error) {
        reviews.push({
          ...base,
          state: "unavailable",
          message: "Pricing could not be checked. Retry this patient.",
        });
        continue;
      }
      const exact = (candidates.data ?? [])
        .map(quoteDto)
        .filter(
          (q: Quote) =>
            q.lines.length === 1 &&
            q.lines[0].sku === draft.suggested_product_id &&
            q.lines[0].quantity === draft.suggested_quantity &&
            q.input.revenue.mode === "insurance",
        );
      let ready = false;
      // Review only the newest exact approval. Falling through up to 100 stale
      // versions per patient can produce thousands of serial validation calls.
      // Older approvals remain available for an explicit individual review.
      for (const candidate of exact.slice(0, 1)) {
        try {
          const quote = await prepareCsrPricing(db, {
            quoteId: candidate.id,
            quoteRevision: candidate.revision,
            patientId: draft.patient_id,
            items: candidate.lines,
          });
          reviews.push({
            ...base,
            state: "ready",
            message:
              "Current approved pricing is ready for individual order review.",
            quoteId: quote.id,
            quoteRevision: quote.revision,
            contributionCents: quote.evaluation.contributionCents,
            marginBps: quote.evaluation.contributionMarginBps,
          });
          ready = true;
          break;
        } catch (error) {
          if (!(error instanceof PricingError) || error.status >= 500) {
            reviews.push({
              ...base,
              state: "unavailable",
              message: "Pricing could not be checked. Retry this patient.",
            });
            ready = true;
            break;
          }
        }
      }
      if (!ready)
        reviews.push({
          ...base,
          state: exact.length ? "stale" : "review_needed",
          message: exact.length
            ? "The newest matching approval needs a fresh review of costs, delivery or policy. Review this patient individually to choose another saved approval."
            : "Prepare an individual pricing review with this patient's insurance and delivery terms.",
        });
    }
    res.json({ reviews, evaluatedAt: new Date().toISOString() });
  },
);
export default router;

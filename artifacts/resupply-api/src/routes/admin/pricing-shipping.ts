import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { getOrgScopedClient, type Json } from "@workspace/resupply-db";
import { validateReceiverAddress } from "@workspace/resupply-integrations-xps-ship";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  adapterErrorStatus,
  getXpsAdapterForOrg,
} from "../../lib/shipping/xps-core";
import {
  pricingDestinationFingerprint,
  pricingShippingAddress,
} from "../../lib/pricing/shipping";

const router: IRouter = Router();
const schema = z
  .object({
    patientId: z.string().uuid(),
    lines: z
      .array(
        z
          .object({
            sku: z.string().min(1).max(64),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    parcels: z
      .array(
        z
          .object({
            weightOz: z.number().positive().max(1120),
            lengthIn: z.number().positive().max(108),
            widthIn: z.number().positive().max(108),
            heightIn: z.number().positive().max(108),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    residential: z.boolean(),
  })
  .strict()
  .refine(
    (b) => new Set(b.lines.map((l) => l.sku)).size === b.lines.length,
    "Combine duplicate item quantities.",
  );

// The XPS account's configured warehouse is the origin. Supplier dropship
// costs must come from the supplier's verified offer, not this warehouse rate.
router.post(
  "/admin/pricing/shipping-rates",
  requirePermission("pricing.evaluate"),
  adminRateLimit({ name: "pricing_shipping_rates", windowMs: 60_000, max: 20 }),
  async (req, res) => {
    const b = schema.safeParse(req.body);
    if (!b.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "Select a patient and provide the measured weight and dimensions of every parcel.",
      });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(req.orgId);
    const { data: patient, error } = await db
      .from("patients")
      .select("id,address")
      .eq("id", b.data.patientId)
      .maybeSingle();
    if (error) throw error;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const receiver = pricingShippingAddress(patient.address);
    if (!receiver || !validateReceiverAddress(receiver).ok) {
      res.status(422).json({
        error: "patient_address_required",
        message:
          "Complete the patient's delivery address before requesting a shipping rate.",
      });
      return;
    }
    const { data: products, error: productError } = await db
      .from("products")
      .select("sku")
      .in(
        "sku",
        b.data.lines.map((l) => l.sku),
      )
      .eq("active", true);
    if (productError) throw productError;
    if ((products ?? []).length !== b.data.lines.length) {
      res.status(422).json({ error: "catalog_item_required" });
      return;
    }
    const adapter = await getXpsAdapterForOrg(req.orgId);
    if (adapter.availability().status !== "configured") {
      res.status(503).json({
        error: "shipping_unconfigured",
        message:
          "Configure the warehouse shipping account, or request a verified freight estimate from management.",
      });
      return;
    }
    const result = await adapter.quoteRates({
      receiver,
      parcels: b.data.parcels,
      residential: b.data.residential,
    });
    if (!result.ok) {
      res
        .status(adapterErrorStatus(result.error))
        .json({ error: "shipping_rate_unavailable", reason: result.error });
      return;
    }
    const rates = result.value.filter(
      (r) =>
        Number.isSafeInteger(r.totalCents) &&
        r.totalCents >= 0 &&
        r.totalCents <= 100_000_000,
    );
    if (!rates.length) {
      res.status(422).json({
        error: "no_shipping_rates",
        message:
          "No priced service was returned. Delivery cost remains unknown.",
      });
      return;
    }
    // Local validity limit for this estimate, not a promise of a carrier lock.
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const rows = rates.map((r) => ({
      id: randomUUID(),
      cost_cents: r.totalCents,
      expires_at: expiresAt,
      data: {
        patientId: patient.id,
        lines: [...b.data.lines].sort((a, c) => a.sku.localeCompare(c.sku)),
        patientAddressSnapshot: patient.address,
        destinationFingerprint: pricingDestinationFingerprint(patient.address),
        service: r.serviceCode,
        carrier: r.carrierCode,
        source: "xps",
        origin: "configured_warehouse",
        parcels: b.data.parcels,
        residential: b.data.residential,
      } as unknown as Json,
    }));
    const { error: saveError } = await db
      .from("pricing_shipping_quotes")
      .insert(rows);
    if (saveError) throw saveError;
    res.json({
      rates: rates.map((r, i) => ({
        ...r,
        shippingQuoteId: rows[i].id,
        expiresAt,
      })),
      origin: "configured_warehouse",
    });
  },
);
export default router;

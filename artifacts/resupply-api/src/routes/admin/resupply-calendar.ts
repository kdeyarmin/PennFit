import { Router, type IRouter } from "express";
import { z } from "zod";
import { getOrgScopedClient, type Database } from "@workspace/resupply-db";
import { requirePermission } from "../../middlewares/requireAdmin";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { resolveSkuEntitlement } from "../../lib/entitlement/resolve-sku-entitlement";
import {
  loadCsrScheduleContext,
  loadLastSupplyDates,
  resolveCsrSchedule,
  supplyDateKey,
} from "../../lib/resupply/csr-schedule";

type Tables = Database["resupply"]["Tables"];
type Episode = Tables["episodes"]["Row"];
type Rx = Tables["prescriptions"]["Row"];
type Patient = Tables["patients"]["Row"];
type Product = Tables["products"]["Row"];
type Fill = Tables["fulfillments"]["Row"];
const router: IRouter = Router();
const windowQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    overdue: z.enum(["true", "false"]).default("false"),
  })
  .strict()
  .refine(
    (q) =>
      Date.parse(q.to) > Date.parse(q.from) &&
      Date.parse(q.to) - Date.parse(q.from) <= 42 * 86400000,
  );

router.get(
  "/admin/resupply-calendar",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = windowQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(req.orgId);
    const { from, to, overdue } = parsed.data;
    const scheduleContext = await loadCsrScheduleContext(db, req.orgId);
    const now = new Date();
    const items = [];
    // Walk every page, including large overdue queues. Never silently truncate
    // a month at PostgREST's default row cap. Child lookups stay page-bounded.
    for (let offset = 0; ; offset += 200) {
      let query = db
        .from("episodes")
        .select("id, patient_id, prescription_id, status, due_at, expires_at")
        .in("status", ["outreach_pending", "awaiting_response"]);
      if (scheduleContext.dueAtAuthoritative)
        query =
          overdue === "true"
            ? query.lt("due_at", from)
            : query.gte("due_at", from).lt("due_at", to);
      const { data, error } = await query
        .order("due_at")
        .order("id")
        .range(offset, offset + 199);
      if (error) throw error;
      const episodes = (data ?? []) as Episode[];
      if (!episodes.length) break;
      const [patients, prescriptions] = await Promise.all([
        db
          .from("patients")
          .select(
            "id, legal_first_name, legal_last_name, status, phone_e164, email, channel_preference, created_at, insurance_payer, cadence_override_days",
          )
          .in("id", [...new Set(episodes.map((e) => e.patient_id))]),
        db
          .from("prescriptions")
          .select(
            "id, patient_id, item_sku, cadence_days, status, valid_until, created_at",
          )
          .in("id", [...new Set(episodes.map((e) => e.prescription_id))]),
      ]);
      if (patients.error) throw patients.error;
      if (prescriptions.error) throw prescriptions.error;
      const pts = new Map((patients.data as Patient[]).map((p) => [p.id, p]));
      const rxs = new Map((prescriptions.data as Rx[]).map((r) => [r.id, r]));
      const lastDates = scheduleContext.dueAtAuthoritative
        ? new Map<string, string>()
        : await loadLastSupplyDates(db, [...pts.keys()]);
      for (const e of episodes) {
        const p = pts.get(e.patient_id);
        const rx = rxs.get(e.prescription_id);
        if (
          !p ||
          !rx ||
          p.status !== "active" ||
          rx.status !== "active" ||
          rx.patient_id !== p.id
        )
          continue;
        const schedule = resolveCsrSchedule(
          scheduleContext,
          p,
          rx,
          e.due_at,
          lastDates.get(supplyDateKey(p.id, rx.item_sku)),
          now,
        );
        if (!schedule.dueAt) continue;
        const dueMs = Date.parse(schedule.dueAt);
        if (
          overdue === "true"
            ? dueMs >= Date.parse(from)
            : dueMs < Date.parse(from) || dueMs >= Date.parse(to)
        )
          continue;
        items.push({
          id: e.id,
          patientId: p.id,
          patientName: `${p.legal_first_name} ${p.legal_last_name}`.trim(),
          itemSku: rx.item_sku,
          cadenceDays: schedule.cadenceDays,
          dueAt: schedule.dueAt,
          status: e.status,
          expiresAt: e.expires_at,
          prescriptionValidUntil: rx.valid_until,
          hasPhone: Boolean(p.phone_e164),
          hasEmail: Boolean(p.email),
          channelPreference: p.channel_preference,
        });
      }
      if (episodes.length < 200) break;
    }
    res.json({ items });
  },
);

router.get(
  "/admin/patients/:id/supply-overview",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const page = z
      .object({ offset: z.coerce.number().int().min(0).default(0) })
      .strict()
      .safeParse(req.query);
    if (!id.success || !page.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(req.orgId);
    const patient = await db
      .from("patients")
      .select(
        "id, created_at, insurance_payer, cadence_override_days, channel_preference, phone_e164",
      )
      .eq("id", id.data)
      .maybeSingle();
    if (patient.error) throw patient.error;
    if (!patient.data) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const scheduleContext = await loadCsrScheduleContext(db, req.orgId);
    const [prescriptions, fills, episodes, drafts] = await Promise.all([
      db
        .from("prescriptions")
        .select(
          "id, item_sku, hcpcs_code, cadence_days, status, valid_until, created_at",
        )
        .eq("patient_id", id.data)
        .eq("status", "active")
        .order("created_at", { ascending: false }),
      db
        .from("fulfillments")
        .select(
          "id, item_sku, quantity, status, pacware_order_ref, created_at, shipped_at, delivered_at",
          { count: "exact" },
        )
        .eq("patient_id", id.data)
        .order("created_at", { ascending: false })
        .order("id")
        .range(page.data.offset, page.data.offset + 24),
      db
        .from("episodes")
        .select("id, prescription_id, due_at, status")
        .eq("patient_id", id.data)
        .in("status", ["outreach_pending", "awaiting_response"])
        .order("due_at"),
      db
        .from("resupply_order_drafts")
        .select("csr_order_request_id")
        .eq("patient_id", id.data)
        .not("csr_order_request_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    for (const result of [prescriptions, fills, episodes, drafts])
      if (result.error) throw result.error;
    const requestIds = [
      ...new Set(
        ((drafts.data ?? []) as { csr_order_request_id: string }[]).map(
          (d) => d.csr_order_request_id,
        ),
      ),
    ];
    const requests = requestIds.length
      ? await db
          .from("csr_order_requests")
          .select("id, order_reference, items, status, created_at, signed_at")
          .in("id", requestIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };
    if (requests.error) throw requests.error;
    const linkedOrders = (
      (requests.data ?? []) as Tables["csr_order_requests"]["Row"][]
    ).map((r) => ({
      id: r.id,
      orderReference: r.order_reference,
      status: r.status,
      createdAt: r.created_at,
      signedAt: r.signed_at,
      items:
        z
          .array(z.object({ description: z.string(), quantity: z.number() }))
          .safeParse(r.items).data ?? [],
    }));
    const rxs = (prescriptions.data ?? []) as Rx[];
    const orders = (fills.data ?? []) as Fill[];
    const skus = [
      ...new Set([
        ...rxs.map((r) => r.item_sku),
        ...orders.map((f) => f.item_sku),
      ]),
    ];
    const products = skus.length
      ? await db.from("products").select("sku, name").in("sku", skus)
      : { data: [], error: null };
    if (products.error) throw products.error;
    const names = new Map(
      (products.data as Product[]).map((p) => [p.sku, p.name]),
    );
    const supplies = [];
    const lastDates = scheduleContext.dueAtAuthoritative
      ? new Map<string, string>()
      : await loadLastSupplyDates(db, [id.data]);
    const now = new Date();
    for (const rx of rxs) {
      // Patient ownership was checked above; this shared adapter reads global
      // HCPCS reference data and the already-verified patient's dispense rows.
      const entitlement = await resolveSkuEntitlement(db.raw(), {
        patientId: id.data,
        itemSku: rx.item_sku,
      });
      const lastOrder = await db
        .from("fulfillments")
        .select("created_at")
        .eq("patient_id", id.data)
        .eq("item_sku", rx.item_sku)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastOrder.error) throw lastOrder.error;
      const episode = (episodes.data as Episode[]).find(
        (e) => e.prescription_id === rx.id,
      );
      const schedule = episode
        ? resolveCsrSchedule(
            scheduleContext,
            patient.data,
            rx,
            episode.due_at,
            lastDates.get(supplyDateKey(id.data, rx.item_sku)),
            now,
          )
        : null;
      supplies.push({
        prescriptionId: rx.id,
        itemSku: rx.item_sku,
        itemName: names.get(rx.item_sku) ?? rx.item_sku,
        hcpcsCode: entitlement?.hcpcsCode ?? rx.hcpcs_code,
        cadenceDays: schedule?.cadenceDays ?? rx.cadence_days,
        validUntil: rx.valid_until,
        episodeId: episode?.id ?? null,
        scheduledDueAt: schedule?.dueAt ?? null,
        lastOrderedAt: lastOrder.data?.created_at ?? null,
        eligibility: entitlement
          ? {
              status: entitlement.status,
              eligible: entitlement.eligible,
              intervalEligibleOn: entitlement.eligibleOn.toISOString(),
              quantityEligibleOn:
                entitlement.quantityEligibleOn?.toISOString() ?? null,
              maxQuantityNow: entitlement.maxQuantityNow,
              reason: entitlement.reason,
            }
          : null,
      });
    }
    res.json({
      supplies,
      linkedOrders,
      orders: orders.map((f) => ({
        id: f.id,
        itemSku: f.item_sku,
        itemName: names.get(f.item_sku) ?? f.item_sku,
        quantity: f.quantity,
        status: f.status,
        orderReference: f.pacware_order_ref,
        orderedAt: f.created_at,
        shippedAt: f.shipped_at,
        deliveredAt: f.delivered_at,
      })),
      totalOrders: fills.count ?? 0,
      offset: page.data.offset,
    });
  },
);

export default router;

// Platform super-admin: outreach contacts / leads (mini-CRM).
//
//   GET    /resupply-api/platform/contacts            — list (search/tag)
//   POST   /resupply-api/platform/contacts            — create one
//   POST   /resupply-api/platform/contacts/import     — bulk upsert
//   PATCH  /resupply-api/platform/contacts/:id         — edit
//   POST   /resupply-api/platform/contacts/:id/unsubscribe — opt out
//   DELETE /resupply-api/platform/contacts/:id         — remove
//
// Platform-GLOBAL rows (no org_id) behind requirePlatformAdmin, read /
// written through the service-role client. These are the platform
// operator's own saved contacts — prospects, partners, leads — reusable
// across outreach campaigns.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const CONTACT_SELECT =
  "id, email, name, company, tags, notes, unsubscribed, unsubscribed_at, source, created_at, updated_at";

const emailSchema = z.string().trim().email().max(320);

const createBody = z.object({
  email: emailSchema,
  name: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

const updateBody = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  unsubscribed: z.boolean().optional(),
});

const importBody = z.object({
  // Either structured rows or a raw blob of addresses (pasted list).
  contacts: z
    .array(
      z.object({
        email: emailSchema,
        name: z.string().trim().max(200).nullable().optional(),
        company: z.string().trim().max(200).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      }),
    )
    .max(50_000)
    .optional(),
  /** Newline/comma/space separated addresses (pasted blob). */
  raw: z.string().max(2_000_000).optional(),
  /** Tags applied to every imported row (in addition to per-row tags). */
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t.trim();
    if (v) seen.add(v);
  }
  return Array.from(seen);
}

// ── List ───────────────────────────────────────────────────────────
router.get(
  "/platform/contacts",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const tag = typeof req.query.tag === "string" ? req.query.tag.trim() : "";
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("platform_contacts")
      .select(CONTACT_SELECT)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (search) {
      // PostgREST OR filter across email + name + company.
      const safe = search.replace(/[%,()]/g, " ");
      query = query.or(
        `email.ilike.%${safe}%,name.ilike.%${safe}%,company.ilike.%${safe}%`,
      );
    }
    if (tag) query = query.contains("tags", [tag]);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ contacts: data ?? [] });
  },
);

// ── Create one ─────────────────────────────────────────────────────
router.post(
  "/platform/contacts",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createBody.safeParse(req.body);
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("platform_contacts")
      .insert({
        email: b.email,
        name: b.name ?? null,
        company: b.company ?? null,
        tags: normalizeTags(b.tags),
        notes: b.notes ?? null,
        source: "manual",
        created_by_email: req.platformAdminEmail ?? null,
      })
      .select(CONTACT_SELECT)
      .single();
    if (error) {
      // Unique-violation on lower(email).
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "duplicate_email" });
        return;
      }
      throw error;
    }
    res.status(201).json({ contact: data });
  },
);

// ── Bulk import (upsert by lower(email)) ───────────────────────────
router.post(
  "/platform/contacts/import",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const extraTags = normalizeTags(parsed.data.tags);
    // Build a de-duplicated map keyed on lowercased email.
    const byEmail = new Map<
      string,
      {
        email: string;
        name: string | null;
        company: string | null;
        tags: string[];
      }
    >();
    const addEmail = (
      email: string,
      name: string | null,
      company: string | null,
      tags: string[],
    ) => {
      const trimmed = email.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      const existing = byEmail.get(lower);
      const merged = normalizeTags([
        ...(existing?.tags ?? []),
        ...tags,
        ...extraTags,
      ]);
      byEmail.set(lower, {
        email: trimmed,
        name: name ?? existing?.name ?? null,
        company: company ?? existing?.company ?? null,
        tags: merged,
      });
    };
    for (const c of parsed.data.contacts ?? []) {
      addEmail(
        c.email,
        c.name ?? null,
        c.company ?? null,
        normalizeTags(c.tags),
      );
    }
    if (parsed.data.raw) {
      for (const token of parsed.data.raw.split(/[\s,;]+/)) {
        const t = token.trim();
        if (t && emailSchema.safeParse(t).success) addEmail(t, null, null, []);
      }
    }
    const rows = Array.from(byEmail.values());
    if (rows.length === 0) {
      res.json({ imported: 0, skipped: 0 });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    let imported = 0;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH).map((r) => ({
        email: r.email,
        name: r.name,
        company: r.company,
        tags: r.tags,
        source: "import" as const,
        created_by_email: req.platformAdminEmail ?? null,
      }));
      // ignoreDuplicates keeps existing rows intact (fill-only). Conflict
      // target is the generated `email_lower` column (case-insensitive
      // unique key) — a real column/constraint, which PostgREST requires
      // for onConflict (an expression index can't be targeted). We don't
      // write email_lower; the DB derives it from `email`.
      const { data, error } = await supabase
        .schema("resupply")
        .from("platform_contacts")
        .upsert(slice, { onConflict: "email_lower", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      imported += (data ?? []).length;
    }

    await logAudit({
      action: "platform_contacts.import",
      adminEmail: req.platformAdminEmail ?? null,
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "platform_contacts",
      targetId: null,
      metadata: { submitted: rows.length, imported },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) =>
      logger.warn({ err }, "platform_contacts.import audit failed"),
    );

    res.json({ imported, skipped: rows.length - imported });
  },
);

// ── Update ─────────────────────────────────────────────────────────
router.patch(
  "/platform/contacts/:id",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const update: Record<string, unknown> = {};
    if (b.name !== undefined) update.name = b.name;
    if (b.company !== undefined) update.company = b.company;
    if (b.tags !== undefined) update.tags = normalizeTags(b.tags);
    if (b.notes !== undefined) update.notes = b.notes;
    if (b.unsubscribed !== undefined) {
      update.unsubscribed = b.unsubscribed;
      update.unsubscribed_at = b.unsubscribed ? new Date().toISOString() : null;
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "no_fields" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("platform_contacts")
      .update(update)
      .eq("id", params.data.id)
      .select(CONTACT_SELECT)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ contact: data });
  },
);

// ── Manual unsubscribe (operator-initiated) ────────────────────────
router.post(
  "/platform/contacts/:id/unsubscribe",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("platform_contacts")
      .update({ unsubscribed: true, unsubscribed_at: new Date().toISOString() })
      .eq("id", params.data.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

// ── Delete ─────────────────────────────────────────────────────────
router.delete(
  "/platform/contacts/:id",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("platform_contacts")
      .delete()
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;

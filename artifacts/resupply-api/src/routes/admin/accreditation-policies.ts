// /admin/accreditation/* — policy catalog + attestation + binder
// summary surface for the DMEPOS accreditation evidence binder.
//
// Endpoints:
//   GET    /admin/accreditation/policies              — full catalog
//                                                       with attestation
//                                                       roster summary
//                                                       per row.
//   POST   /admin/accreditation/policies              — create a new
//                                                       (policy_key,version)
//                                                       row. Admin-only.
//   PATCH  /admin/accreditation/policies/:id          — narrow lifecycle
//                                                       updates (activate,
//                                                       retire, edit
//                                                       title/summary).
//                                                       Admin-only.
//   GET    /admin/accreditation/policies/me/pending   — caller's pending
//                                                       attestations.
//   POST   /admin/accreditation/policies/:id/attest   — caller attests a
//                                                       specific policy
//                                                       version. Idempotent
//                                                       by (staff,policy)
//                                                       UNIQUE.
//   GET    /admin/accreditation/binder                — surveyor-facing
//                                                       summary JSON +
//                                                       links to the four
//                                                       existing CSV
//                                                       exports.
//   GET    /admin/accreditation/attestations.csv      — flat CSV for the
//                                                       binder.
//
// Permissions wire-up (RBAC Phase A):
//   * Catalog CRUD lives behind `admin_team.manage` (admin-only by
//     policy choice — see rbac.ts; matches the requireAdminOnly
//     posture used by team management).
//   * Per-staff attest endpoints use `requireAdmin` directly — every
//     staff member needs to attest, regardless of granular role.
//   * Binder dashboard + CSV use `audit.export` (admin / supervisor
//     / compliance_officer per the catalog) — same audience as the
//     audit-log export.
//
// Audit posture:
// Every catalog mutation + attestation writes a row to audit_log
// with the policy_key + version in metadata. The attestation
// payload (`acknowledgedText`) is captured in the table itself; we
// do NOT echo it into the audit metadata to keep audit envelopes
// small.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type AccreditationPolicyUpdate =
  Database["resupply"]["Tables"]["accreditation_policies"]["Update"];

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const POLICY_KEY = /^[a-z0-9_]{1,64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,32}$/;

const createBody = z
  .object({
    policyKey: z.string().regex(POLICY_KEY),
    version: z.string().regex(VERSION),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000).nullable().optional(),
    bodyUrl: z.string().trim().url().max(2048).nullable().optional(),
    category: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/, "lowercase identifier"),
    /** When true, activate immediately. Otherwise the row lands as
     *  a draft (active_at NULL). */
    activate: z.boolean().optional(),
  })
  .strict();

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    bodyUrl: z.string().trim().url().max(2048).nullable().optional(),
    category: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_]+$/)
      .optional(),
    /** Lifecycle controls. Pass `activate: true` to set
     *  `active_at = now()` (if not already set). Pass `retire: true`
     *  to set `retired_at = now()`. Mutually exclusive. */
    activate: z.boolean().optional(),
    retire: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.activate && b.retire), {
    message: "activate and retire are mutually exclusive",
  });

const attestBody = z
  .object({
    /** Verbatim acknowledgement statement the staff member saw.
     *  The route stamps this on the attestation row for audit. */
    acknowledgedText: z.string().trim().min(1).max(4000),
  })
  .strict();

// ────────────────────────────────────────────────────────────────
// GET /admin/accreditation/policies — full catalog + attestation
// counts. Admin-and-above.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/accreditation/policies",
  requirePermission("audit.export"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: policies, error } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .select(
        "id, policy_key, version, title, summary, body_url, category, active_at, retired_at, created_at, updated_at",
      )
      .order("category", { ascending: true })
      .order("policy_key", { ascending: true })
      .order("version", { ascending: true });
    if (error) throw error;

    // Fan out a single attestation-count query per policy in one
    // round trip via a parallel `Promise.all`. The catalog is
    // small (dozens of policies, not thousands), so this is fine.
    const counts = await Promise.all(
      (policies ?? []).map(async (p) => {
        const { count } = await supabase
          .schema("resupply")
          .from("admin_policy_attestations")
          .select("id", { count: "exact", head: true })
          .eq("policy_id", p.id);
        return [p.id, count ?? 0] as const;
      }),
    );
    const countById = new Map(counts);

    res.json({
      policies: (policies ?? []).map((p) => ({
        id: p.id,
        policyKey: p.policy_key,
        version: p.version,
        title: p.title,
        summary: p.summary,
        bodyUrl: p.body_url,
        category: p.category,
        activeAt: p.active_at,
        retiredAt: p.retired_at,
        attestationCount: countById.get(p.id) ?? 0,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  },
);

// ────────────────────────────────────────────────────────────────
// POST /admin/accreditation/policies — admin-only.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/accreditation/policies",
  requireAdminOnly,
  adminRateLimit({ name: "accreditation_policies.create", preset: "mutation" }),
  async (req, res) => {
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
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .insert({
        policy_key: b.policyKey,
        version: b.version,
        title: b.title,
        summary: b.summary ?? null,
        body_url: b.bodyUrl ?? null,
        category: b.category,
        active_at: b.activate ? nowIso : null,
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // 23505 = unique_violation. Translate the (policy_key,
      // version) collision to a 409 with a useful message rather
      // than throwing a 500.
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "duplicate_policy_version",
          message: `A policy with key "${b.policyKey}" and version "${b.version}" already exists.`,
        });
        return;
      }
      throw error;
    }

    await logAudit({
      action: "accreditation.policy.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "accreditation_policies",
      targetId: row.id,
      metadata: {
        policy_key: b.policyKey,
        version: b.version,
        category: b.category,
        activated: !!b.activate,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "accreditation.policy.create audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

// ────────────────────────────────────────────────────────────────
// PATCH /admin/accreditation/policies/:id — admin-only narrow
// updates + lifecycle moves.
// ────────────────────────────────────────────────────────────────
router.patch(
  "/admin/accreditation/policies/:id",
  requireAdminOnly,
  adminRateLimit({ name: "accreditation_policies.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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

    // Read first so we can reject "activate a retired row" and
    // surface the prior state in the audit envelope.
    const { data: prior, error: priorErr } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .select("id, policy_key, version, active_at, retired_at")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (!prior) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (b.activate && prior.retired_at) {
      res.status(409).json({
        error: "retired",
        message: "Cannot activate a retired policy. Create a new version.",
      });
      return;
    }

    const update: AccreditationPolicyUpdate = {
      updated_at: new Date().toISOString(),
    };
    if (b.title !== undefined) update.title = b.title;
    if (b.summary !== undefined) update.summary = b.summary;
    if (b.bodyUrl !== undefined) update.body_url = b.bodyUrl;
    if (b.category !== undefined) update.category = b.category;
    if (b.activate && !prior.active_at) {
      update.active_at = new Date().toISOString();
    }
    if (b.retire && !prior.retired_at) {
      update.retired_at = new Date().toISOString();
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .update(update)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: b.activate
        ? "accreditation.policy.activate"
        : b.retire
          ? "accreditation.policy.retire"
          : "accreditation.policy.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "accreditation_policies",
      targetId: params.data.id,
      metadata: {
        policy_key: prior.policy_key,
        version: prior.version,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "accreditation.policy.update audit failed");
    });

    res.json({ ok: true });
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/accreditation/policies/me/pending — what the calling
// staff member still owes. Every authenticated staff member can
// see their own pending list, regardless of granular role.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/accreditation/policies/me/pending",
  requireAdmin,
  async (req, res) => {
    const adminUserId = req.adminUserId;
    if (!adminUserId) {
      res.status(500).json({ error: "admin_context_missing" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: live, error: liveErr } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .select(
        "id, policy_key, version, title, summary, body_url, category, active_at",
      )
      .not("active_at", "is", null)
      .is("retired_at", null);
    if (liveErr) throw liveErr;

    if (!live || live.length === 0) {
      res.json({ pending: [] });
      return;
    }

    const { data: attested, error: attestedErr } = await supabase
      .schema("resupply")
      .from("admin_policy_attestations")
      .select("policy_id")
      .eq("staff_user_id", adminUserId)
      .in(
        "policy_id",
        live.map((p) => p.id),
      );
    if (attestedErr) throw attestedErr;
    const attestedIds = new Set((attested ?? []).map((a) => a.policy_id));

    const pending = live
      .filter((p) => !attestedIds.has(p.id))
      .map((p) => ({
        id: p.id,
        policyKey: p.policy_key,
        version: p.version,
        title: p.title,
        summary: p.summary,
        bodyUrl: p.body_url,
        category: p.category,
        activeAt: p.active_at,
      }));

    res.json({ pending });
  },
);

// ────────────────────────────────────────────────────────────────
// POST /admin/accreditation/policies/:id/attest — the calling staff
// member attests this policy version. Idempotent: re-posting after
// an attestation is already on file returns 200 with the prior row,
// no audit duplicate.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/accreditation/policies/:id/attest",
  requireAdmin,
  adminRateLimit({ name: "accreditation_policies.attest", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = attestBody.safeParse(req.body);
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
    const adminUserId = req.adminUserId;
    if (!adminUserId) {
      res.status(500).json({ error: "admin_context_missing" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // Confirm the policy is live (active_at NOT NULL, retired_at NULL).
    // Refusing on retired prevents back-dating attestations to a
    // policy that's already been replaced.
    const { data: policy, error: policyErr } = await supabase
      .schema("resupply")
      .from("accreditation_policies")
      .select("id, policy_key, version, active_at, retired_at")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (policyErr) throw policyErr;
    if (!policy) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!policy.active_at || policy.retired_at) {
      res.status(409).json({
        error: "not_active",
        message:
          "This policy isn't live for attestation right now. Ask an admin to activate it.",
      });
      return;
    }

    // Check for an existing attestation — the unique constraint
    // would error with 23505 if we just blind-inserted, but we
    // want the idempotent response shape (200, not 201) and a
    // sane audit signal.
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("admin_policy_attestations")
      .select("id, attested_at")
      .eq("staff_user_id", adminUserId)
      .eq("policy_id", policy.id)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      res.status(200).json({
        id: existing.id,
        alreadyAttested: true,
        attestedAt: existing.attested_at,
      });
      return;
    }

    const { data: row, error: insErr } = await supabase
      .schema("resupply")
      .from("admin_policy_attestations")
      .insert({
        staff_user_id: adminUserId,
        policy_id: policy.id,
        acknowledged_text: parsed.data.acknowledgedText,
        ip: req.ip ?? null,
        user_agent: req.get("user-agent") ?? null,
      })
      .select("id, attested_at")
      .single();
    if (insErr) {
      // Lost race with another tab — same idempotent outcome.
      if ((insErr as { code?: string }).code === "23505") {
        res.status(200).json({ alreadyAttested: true });
        return;
      }
      throw insErr;
    }

    await logAudit({
      action: "accreditation.policy.attest",
      adminEmail: req.adminEmail ?? null,
      adminUserId,
      targetTable: "admin_policy_attestations",
      targetId: row.id,
      // Policy identity goes in metadata; the acknowledgement text
      // stays in the table to keep audit envelopes lean.
      metadata: {
        policy_key: policy.policy_key,
        version: policy.version,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "accreditation.policy.attest audit failed");
    });

    res.status(201).json({
      id: row.id,
      attestedAt: row.attested_at,
    });
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/accreditation/binder — the surveyor-facing summary
// JSON. Counts per evidence section + links into the existing
// CSV exports (training-records, grievances, audit-log) plus the
// new attestations CSV.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/accreditation/binder",
  requirePermission("audit.export"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const [
      policiesCount,
      activePoliciesCount,
      attestationsCount,
      trainingCount,
      grievancesCount,
      openGrievancesCount,
    ] = await Promise.all([
      countTable(supabase, "accreditation_policies"),
      countTable(supabase, "accreditation_policies", (q) =>
        q.not("active_at", "is", null).is("retired_at", null),
      ),
      countTable(supabase, "admin_policy_attestations"),
      countTable(supabase, "staff_training_records"),
      countTable(supabase, "patient_grievances"),
      countTable(supabase, "patient_grievances", (q) =>
        q.in("status", ["open", "acknowledged", "escalated", "reopened"]),
      ),
    ]);

    res.json({
      asOf: new Date().toISOString(),
      sections: {
        policies: {
          total: policiesCount,
          active: activePoliciesCount,
          attestations: attestationsCount,
          csvUrl: "/resupply-api/admin/accreditation/attestations.csv",
        },
        training: {
          total: trainingCount,
          // The training-records page is the only "CSV" surface
          // for now — surveyors get the JSON list and can
          // print-to-PDF from the SPA. Future: dedicated CSV
          // endpoint.
          listUrl: "/resupply-api/admin/compliance/training-records",
        },
        grievances: {
          total: grievancesCount,
          open: openGrievancesCount,
          listUrl: "/resupply-api/admin/compliance/grievances",
        },
        auditLog: {
          csvUrl: "/resupply-api/audit/export.csv",
        },
      },
    });
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/accreditation/attestations.csv — flat CSV for the
// binder. One row per (staff, policy) attestation.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/accreditation/attestations.csv",
  requirePermission("audit.export"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    // Limit just in case — accreditation history grows slowly so
    // a 50k cap matches the audit-log export and is well over a
    // decade of attestations at typical DME headcount.
    const { data, error } = await supabase
      .schema("resupply")
      .from("admin_policy_attestations")
      .select(
        "id, staff_user_id, policy_id, attested_at, signature_method, ip, user_agent, acknowledged_text",
      )
      .order("attested_at", { ascending: false })
      .limit(50_000);
    if (error) throw error;

    // Decorate with policy + admin lookups. Small joins; one round
    // trip each, both keyed by id.
    const rows = data ?? [];
    const policyIds = Array.from(new Set(rows.map((r) => r.policy_id)));
    const staffIds = Array.from(new Set(rows.map((r) => r.staff_user_id)));
    const [policies, admins] = await Promise.all([
      policyIds.length
        ? supabase
            .schema("resupply")
            .from("accreditation_policies")
            .select("id, policy_key, version, title, category")
            .in("id", policyIds)
        : Promise.resolve({ data: [], error: null }),
      staffIds.length
        ? supabase
            .schema("resupply")
            .from("admin_users")
            .select("id, email_lower, display_name")
            .in("id", staffIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (policies.error) throw policies.error;
    if (admins.error) throw admins.error;
    const policyById = new Map(
      (policies.data ?? []).map((p) => [p.id, p] as const),
    );
    const adminById = new Map(
      (admins.data ?? []).map((a) => [a.id, a] as const),
    );

    const filename = `accreditation-attestations-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    // Header — wide enough that a surveyor can grep the export
    // without joining other docs.
    res.write(
      [
        "attestation_id",
        "attested_at",
        "staff_email",
        "staff_display_name",
        "policy_key",
        "policy_version",
        "policy_title",
        "policy_category",
        "signature_method",
        "ip",
        "user_agent",
        "acknowledged_text",
      ].join(",") + "\n",
    );
    for (const r of rows) {
      const p = policyById.get(r.policy_id);
      const a = adminById.get(r.staff_user_id);
      res.write(
        [
          r.id,
          r.attested_at,
          a?.email_lower ?? "",
          a?.display_name ?? "",
          p?.policy_key ?? "",
          p?.version ?? "",
          p?.title ?? "",
          p?.category ?? "",
          r.signature_method,
          r.ip ?? "",
          r.user_agent ?? "",
          r.acknowledged_text,
        ]
          .map(csvCell)
          .join(",") + "\n",
      );
    }

    await logAudit({
      action: "accreditation.attestations.export",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "admin_policy_attestations",
      targetId: null,
      metadata: { rowCount: rows.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "accreditation.attestations.export audit failed",
      );
    });

    res.end();
  },
);

// Escape a CSV cell — quote on any character that would otherwise
// confuse a parser (comma, quote, newline). Mirrors the helper
// used in audit/export.ts.
function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Thin helper for the binder summary — runs a head-only count with
// an optional refiner so each section's "open" sub-count is one
// expression instead of three.
// The PostgrestFilterBuilder type is too deeply parameterised across
// the four tables this helper accepts (TS errors with "type
// instantiation is excessively deep"). The runtime is uniform — `q`
// is the result of the Supabase select chain — so we type it loosely
// and rely on the caller's chain methods being valid for the table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CountRefiner = (q: any) => unknown;
async function countTable(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  table:
    | "accreditation_policies"
    | "admin_policy_attestations"
    | "staff_training_records"
    | "patient_grievances",
  refine?: CountRefiner,
): Promise<number> {
  const q = supabase
    .schema("resupply")
    .from(table)
    .select("id", { count: "exact", head: true });
  const final = refine ? (refine(q) as typeof q) : q;
  const { count, error } = await final;
  if (error) throw error;
  return count ?? 0;
}

export default router;

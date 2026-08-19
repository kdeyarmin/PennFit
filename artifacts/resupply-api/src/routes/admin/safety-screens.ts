// /admin/fitter/safety-screens — author and publish safety question sets.
//
//   GET    /admin/fitter/safety-screens            — active set + this
//                                                    tenant's own versions
//   POST   /admin/fitter/safety-screens            — start a draft, cloned
//                                                    from whatever is active
//   PATCH  /admin/fitter/safety-screens/:id        — edit a DRAFT's copy
//   PUT    /admin/fitter/safety-screens/:id/questions — replace a draft's
//                                                    questions
//   POST   /admin/fitter/safety-screens/:id/publish — make it the active set
//   POST   /admin/fitter/safety-screens/:id/retire  — fall back to platform
//   DELETE /admin/fitter/safety-screens/:id         — discard a draft
//
// WHY THIS EXISTS
// ---------------
// 0484 shipped versioned safety screening: the questions are data, every
// answer is stamped with the version that asked it, and the fit report
// prints that version so a report reprinted a year later shows the rules
// that actually ran. All of that worked — except there was no way to
// author a version. The table had a read path and a seed, so a tenant
// facing a revised manufacturer warning had no move except to ask us to
// ship a migration. "The rules are data, not a deploy" was true of the
// storage and false of the workflow.
//
// TENANCY — the rule that shapes every write here
// -----------------------------------------------
// `safety_screen_versions.org_id` is NULLABLE, and NULL means the
// PLATFORM-published set that every tenant sees. Same shape as the mask
// catalog, same hazard: an unfiltered write would let one DME edit the
// clinical screen shown to every other DME on the platform.
//
// So: reads go through `.raw()` with an explicit
// `org_id.is.null,org_id.eq.<tenant>` filter (the org-scoped facade would
// hide the platform row, which is the one most tenants are actually
// using), and EVERY write is `.eq("org_id", orgId)` — a tenant can only
// ever author its own set. Retiring falls back to the platform set rather
// than to nothing, so a tenant can always get back to a known-good screen.
//
// WHY DRAFTS
// ----------
// A published set is what a patient is asked and what their answers are
// stamped against. Editing one in place would silently change the meaning
// of answers already recorded under that version label. So an active set
// is immutable: revising means cloning to a draft, editing that, and
// publishing — which retires the previous set and leaves its label
// pointing at exactly the questions it asked.
//
// PHI: none. Questions only. The ANSWERS live in
// `fit_session_safety_responses` (0483) and are never touched here.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  adminRateLimit,
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { invalidateFittingContext } from "../../lib/fitting/catalog-store";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

type Row = Record<string, unknown>;

/** The only family the engine reads today (see `loadSafetyScreen`). */
const SCREEN_SLUG = "magnetic_implant";

const VERSION_COLUMNS =
  "id, org_id, slug, version, scope, manufacturer, status, title, intro_copy, attestation_copy, source_url, source_version_date, effective_from, retired_on, created_at, updated_at";

const QUESTION_COLUMNS =
  "id, screen_version_id, question_key, prompt, help_text, subject, answer_type, sort_order, risk_flag, disqualifies_attribute, severity, unsure_behaves_as";

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

const createBody = z
  .object({
    /**
     * The label stamped on every answer and printed on the fit report.
     * Free text so a tenant can follow the manufacturer's own versioning
     * ("ResMed FSN 2026-09") rather than a scheme we invented.
     */
    version: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200).optional(),
    introCopy: z.string().trim().max(4000).nullable().optional(),
    attestationCopy: z.string().trim().min(1).max(4000).optional(),
    manufacturer: z.string().trim().max(120).nullable().optional(),
    sourceUrl: z.string().trim().url().max(500).nullable().optional(),
    sourceVersionDate: z.string().date().nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    introCopy: z.string().trim().max(4000).nullable().optional(),
    attestationCopy: z.string().trim().min(1).max(4000).optional(),
    manufacturer: z.string().trim().max(120).nullable().optional(),
    sourceUrl: z.string().trim().url().max(500).nullable().optional(),
    sourceVersionDate: z.string().date().nullable().optional(),
    effectiveFrom: z.string().date().nullable().optional(),
  })
  .strict();

const questionSchema = z
  .object({
    questionKey: z
      .string()
      .trim()
      .min(1)
      .max(120)
      // Keys are stamped onto stored answers, so they have to be stable
      // machine identifiers rather than prose.
      .regex(/^[a-z0-9_]+$/, "question_key must be lower_snake_case"),
    prompt: z.string().trim().min(1).max(1000),
    helpText: z.string().trim().max(1000).nullable().optional(),
    subject: z.enum(["patient", "household"]),
    sortOrder: z.number().int().min(0).max(10_000),
    riskFlag: z.string().trim().min(1).max(120),
    /**
     * Which mask attribute a positive answer disqualifies on. Constrained
     * to the one column the engine knows how to filter by — a free-text
     * value here would be a question that silently excludes nothing.
     */
    disqualifiesAttribute: z
      .enum(["has_magnetic_components"])
      .nullable()
      .optional(),
    severity: z.enum(["exclude", "warn"]),
    unsureBehavesAs: z.enum(["exclude", "warn", "ignore"]),
  })
  .strict();

const questionsBody = z
  .object({
    // 40 matches the assessment route's response cap, so a set can never
    // be authored that the patient-facing endpoint would reject.
    questions: z.array(questionSchema).min(1).max(40),
  })
  .strict();

function mapVersion(row: Row, questions: Row[]) {
  return {
    id: String(row.id),
    /** True for the platform-published set: read-only to every tenant. */
    isPlatform: row.org_id === null,
    slug: String(row.slug),
    version: String(row.version),
    scope: String(row.scope),
    manufacturer: (row.manufacturer as string | null) ?? null,
    status: String(row.status) as "draft" | "active" | "retired",
    title: String(row.title),
    introCopy: (row.intro_copy as string | null) ?? null,
    attestationCopy: String(row.attestation_copy),
    sourceUrl: (row.source_url as string | null) ?? null,
    sourceVersionDate: (row.source_version_date as string | null) ?? null,
    effectiveFrom: (row.effective_from as string | null) ?? null,
    retiredOn: (row.retired_on as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
    questions: questions
      .map((q) => ({
        id: String(q.id),
        questionKey: String(q.question_key),
        prompt: String(q.prompt),
        helpText: (q.help_text as string | null) ?? null,
        subject: q.subject as "patient" | "household",
        sortOrder: Number(q.sort_order ?? 0),
        riskFlag: String(q.risk_flag),
        disqualifiesAttribute:
          (q.disqualifies_attribute as "has_magnetic_components" | null) ??
          null,
        severity: q.severity as "exclude" | "warn",
        unsureBehavesAs: q.unsure_behaves_as as "exclude" | "warn" | "ignore",
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/** Fetch the questions for a set of version ids in one round trip. */
async function questionsByVersion(
  supabase: ReturnType<typeof getOrgScopedClient>,
  versionIds: string[],
): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  if (versionIds.length === 0) return out;
  const { data } = await supabase
    .raw()
    .schema("resupply")
    .from("safety_screen_questions")
    .select(QUESTION_COLUMNS)
    .in("screen_version_id", versionIds);
  for (const q of (data ?? []) as Row[]) {
    const key = String(q.screen_version_id);
    const list = out.get(key) ?? [];
    list.push(q);
    out.set(key, list);
  }
  return out;
}

/**
 * Load one version this tenant OWNS, or null.
 *
 * The `org_id` equality is the ownership check, and it is why the handlers
 * below never need a separate "is this mine?" query: a platform row simply
 * does not match, so an attempt to edit one reads as "not found".
 */
async function ownedVersion(
  supabase: ReturnType<typeof getOrgScopedClient>,
  orgId: string,
  id: string,
): Promise<Row | null> {
  const { data } = await supabase
    .raw()
    .schema("resupply")
    .from("safety_screen_versions")
    .select(VERSION_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

// ── List ───────────────────────────────────────────────────────────────
router.get(
  "/admin/fitter/safety-screens",
  // Pre-auth IP bucket FIRST: `requireAdmin` does a DB-backed session
  // lookup, so a limiter placed only after it leaves that read exposed to
  // an unauthenticated flood. The per-actor budget layers on top.
  adminReadRateLimiter,
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "safety_screens.list", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Platform rows have a NULL org_id, so the org-scoped facade would
    // hide the set most tenants are actually using.
    const { data, error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .select(VERSION_COLUMNS)
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .eq("slug", SCREEN_SLUG)
      .order("created_at", { ascending: false });

    if (error) {
      logger.warn(
        { event: "safety_screens.list_failed", orgId, err: error.message },
        "safety screens: list failed",
      );
      res.status(500).json({ error: "safety_screens_unavailable" });
      return;
    }

    const rows = (data ?? []) as Row[];
    const byVersion = await questionsByVersion(
      supabase,
      rows.map((r) => String(r.id)),
    );
    const versions = rows.map((r) =>
      mapVersion(r, byVersion.get(String(r.id)) ?? []),
    );

    // Which set a patient is actually being asked right now. Mirrors
    // `loadSafetyScreen`'s resolution exactly: a tenant's own active set
    // wins over the platform's.
    const active =
      versions.find((v) => v.status === "active" && !v.isPlatform) ??
      versions.find((v) => v.status === "active" && v.isPlatform) ??
      null;

    res.json({
      activeVersionId: active?.id ?? null,
      usingPlatformDefault: active?.isPlatform ?? true,
      versions,
    });
  },
);

// ── Create a draft ─────────────────────────────────────────────────────
router.post(
  "/admin/fitter/safety-screens",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.create", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const supabase = getOrgScopedClient(orgId);

    // Clone from whatever is active. Revising a screen almost always
    // means changing one question, so starting from a blank set would
    // make the common case the most dangerous one: a tenant could
    // publish a set that quietly dropped four of the six questions.
    const { data: sourceRows } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .select(VERSION_COLUMNS)
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .eq("slug", SCREEN_SLUG)
      .eq("status", "active")
      .order("org_id", { ascending: false, nullsFirst: false })
      .limit(1);
    const source = ((sourceRows ?? []) as Row[])[0] ?? null;

    const { data: inserted, error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .insert({
        org_id: orgId,
        slug: SCREEN_SLUG,
        version: body.version,
        scope: source ? String(source.scope) : "magnetic",
        status: "draft",
        title: body.title ?? (source ? String(source.title) : "Safety check"),
        intro_copy:
          body.introCopy ?? (source?.intro_copy as string | null) ?? null,
        attestation_copy:
          body.attestationCopy ??
          (source ? String(source.attestation_copy) : ""),
        manufacturer: body.manufacturer ?? null,
        source_url: body.sourceUrl ?? null,
        source_version_date: body.sourceVersionDate ?? null,
      })
      .select("id")
      .limit(1)
      .maybeSingle();

    if (error || !inserted) {
      // The (org_id, slug, version) unique index is the likely cause:
      // this tenant already has a version carrying that label.
      logger.warn(
        { event: "safety_screens.create_failed", orgId, err: error?.message },
        "safety screens: create failed",
      );
      res.status(409).json({ error: "version_label_taken" });
      return;
    }

    const draftId = String((inserted as Row).id);

    if (source) {
      const sourceQuestions = await questionsByVersion(supabase, [
        String(source.id),
      ]);
      const rows = (sourceQuestions.get(String(source.id)) ?? []).map((q) => ({
        screen_version_id: draftId,
        question_key: q.question_key,
        prompt: q.prompt,
        help_text: q.help_text,
        subject: q.subject,
        answer_type: q.answer_type,
        sort_order: q.sort_order,
        risk_flag: q.risk_flag,
        disqualifies_attribute: q.disqualifies_attribute,
        severity: q.severity,
        unsure_behaves_as: q.unsure_behaves_as,
      }));
      if (rows.length > 0) {
        await supabase
          .raw()
          .schema("resupply")
          .from("safety_screen_questions")
          .insert(rows);
      }
    }

    res.status(201).json({ id: draftId, clonedFrom: source?.version ?? null });
  },
);

// ── Edit a draft's copy ────────────────────────────────────────────────
router.patch(
  "/admin/fitter/safety-screens/:id",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.issues });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const existing = await ownedVersion(supabase, orgId, String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // An active set is what patients are being asked and what their
    // stored answers are stamped against. Editing it in place would
    // change the meaning of answers already recorded under that label.
    if (existing.status !== "draft") {
      res.status(409).json({ error: "not_a_draft" });
      return;
    }

    const b = parsed.data;
    const patch: Row = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) patch.title = b.title;
    if (b.introCopy !== undefined) patch.intro_copy = b.introCopy;
    if (b.attestationCopy !== undefined) {
      patch.attestation_copy = b.attestationCopy;
    }
    if (b.manufacturer !== undefined) patch.manufacturer = b.manufacturer;
    if (b.sourceUrl !== undefined) patch.source_url = b.sourceUrl;
    if (b.sourceVersionDate !== undefined) {
      patch.source_version_date = b.sourceVersionDate;
    }
    if (b.effectiveFrom !== undefined) patch.effective_from = b.effectiveFrom;

    const { error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .update(patch)
      .eq("id", existing.id)
      .eq("org_id", orgId);
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }
    res.json({ ok: true });
  },
);

// ── Replace a draft's questions ────────────────────────────────────────
router.put(
  "/admin/fitter/safety-screens/:id/questions",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.questions", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = questionsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", details: parsed.error.issues });
      return;
    }
    const keys = parsed.data.questions.map((q) => q.questionKey);
    if (new Set(keys).size !== keys.length) {
      // The (screen_version_id, question_key) unique index would reject
      // this anyway; saying so plainly beats a 500 from the insert.
      res.status(400).json({ error: "duplicate_question_key" });
      return;
    }

    const supabase = getOrgScopedClient(orgId);
    const existing = await ownedVersion(supabase, orgId, String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "not_a_draft" });
      return;
    }

    // Replace wholesale. The alternative — diffing by key — would leave a
    // removed question in place whenever the client omitted it by
    // accident, and on this screen a silently-retained question is the
    // less obvious of two wrong answers.
    await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_questions")
      .delete()
      .eq("screen_version_id", existing.id);

    const { error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_questions")
      .insert(
        parsed.data.questions.map((q) => ({
          screen_version_id: existing.id,
          question_key: q.questionKey,
          prompt: q.prompt,
          help_text: q.helpText ?? null,
          subject: q.subject,
          answer_type: "yes_no_unsure",
          sort_order: q.sortOrder,
          risk_flag: q.riskFlag,
          disqualifies_attribute: q.disqualifiesAttribute ?? null,
          severity: q.severity,
          unsure_behaves_as: q.unsureBehavesAs,
        })),
      );
    if (error) {
      logger.warn(
        { event: "safety_screens.questions_failed", orgId, err: error.message },
        "safety screens: question replace failed",
      );
      res.status(500).json({ error: "questions_update_failed" });
      return;
    }
    res.json({ ok: true, count: parsed.data.questions.length });
  },
);

// ── Publish ────────────────────────────────────────────────────────────
router.post(
  "/admin/fitter/safety-screens/:id/publish",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.publish", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const draft = await ownedVersion(supabase, orgId, String(req.params.id));
    if (!draft) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (draft.status !== "draft") {
      res.status(409).json({ error: "not_a_draft" });
      return;
    }

    // A set with no questions would resolve to a screen the assessment
    // route demands and the patient cannot complete — every fitting would
    // stall. Refuse rather than publish an unanswerable screen.
    const questions = await questionsByVersion(supabase, [String(draft.id)]);
    if ((questions.get(String(draft.id)) ?? []).length === 0) {
      res.status(409).json({ error: "no_questions" });
      return;
    }

    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);

    // Retire the currently-active OWN set first. The unique index added in
    // 0498 makes "at most one active per (org, slug)" a guarantee, so this
    // has to happen before the promotion rather than after it.
    await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .update({ status: "retired", retired_on: today, updated_at: nowIso })
      .eq("org_id", orgId)
      .eq("slug", SCREEN_SLUG)
      .eq("status", "active");

    const { error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .update({
        status: "active",
        effective_from: (draft.effective_from as string | null) ?? today,
        updated_at: nowIso,
      })
      .eq("id", draft.id)
      .eq("org_id", orgId);
    if (error) {
      logger.warn(
        { event: "safety_screens.publish_failed", orgId, err: error.message },
        "safety screens: publish failed",
      );
      res.status(500).json({ error: "publish_failed" });
      return;
    }

    // The screen is read through the cached fitting context, so without
    // this the next patient is still asked the old questions.
    invalidateFittingContext(orgId);
    logger.info(
      {
        event: "safety_screens.published",
        orgId,
        version: String(draft.version),
      },
      "safety screens: published a new active set",
    );
    res.json({ ok: true, version: String(draft.version) });
  },
);

// ── Retire ─────────────────────────────────────────────────────────────
router.post(
  "/admin/fitter/safety-screens/:id/retire",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.retire", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const version = await ownedVersion(supabase, orgId, String(req.params.id));
    if (!version) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (version.status !== "active") {
      res.status(409).json({ error: "not_active" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .update({
        status: "retired",
        retired_on: nowIso.slice(0, 10),
        updated_at: nowIso,
      })
      .eq("id", version.id)
      .eq("org_id", orgId);
    if (error) {
      res.status(500).json({ error: "retire_failed" });
      return;
    }

    // Retiring falls back to the PLATFORM set, not to no screening at
    // all — `loadSafetyScreen` picks up the platform row again the moment
    // this tenant has no active set of its own. That is why retire is
    // safe to offer: the worst case is reverting to the shipped
    // questions, never turning screening off by accident.
    invalidateFittingContext(orgId);
    res.json({ ok: true, revertedToPlatformDefault: true });
  },
);

// ── Discard a draft ────────────────────────────────────────────────────
router.delete(
  "/admin/fitter/safety-screens/:id",
  // Pre-auth IP bucket FIRST — see the GET above for why.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "safety_screens.delete", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const version = await ownedVersion(supabase, orgId, String(req.params.id));
    if (!version) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Only drafts. A retired set is the provenance behind every answer
    // stamped with its label — deleting it would leave stored responses
    // pointing at a version nobody can look up.
    if (version.status !== "draft") {
      res.status(409).json({ error: "not_a_draft" });
      return;
    }

    // Questions cascade on delete (0484's FK).
    const { error } = await supabase
      .raw()
      .schema("resupply")
      .from("safety_screen_versions")
      .delete()
      .eq("id", version.id)
      .eq("org_id", orgId);
    if (error) {
      res.status(500).json({ error: "delete_failed" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;

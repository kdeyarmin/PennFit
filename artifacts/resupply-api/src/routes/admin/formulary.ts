// /admin/fitter/formulary — the multi-axis provider formulary.
//
//   GET    /admin/fitter/formulary              — the active formulary + rules
//   POST   /admin/fitter/formulary/rules        — add a rule
//   DELETE /admin/fitter/formulary/rules/:id    — remove a rule
//   PATCH  /admin/fitter/formulary              — posture / name / notes
//   POST   /admin/fitter/formulary/publish      — bump the version
//   POST   /admin/fitter/formulary/simulate     — dry-run against synthetic faces
//   GET    /admin/fitter/formulary/manufacturers — per-brand show/hide state
//   PUT    /admin/fitter/formulary/manufacturers/:name — show/hide one brand
//
// THE MANUFACTURER TOGGLE
// -----------------------
// "We dropped ResMed, stop listing them" is the single most common thing
// an operator wants from this page, and expressing it as
// `targetKind=manufacturer, effect=exclude, every scope axis blank` is
// three correct choices in a form that offers a dozen. So the two
// endpoints below present that one rule as a per-brand switch: the GET
// lists every manufacturer in the tenant's catalog with a model count and
// its current state, and the PUT writes or deletes exactly the org-wide
// exclude rule that backs it.
//
// It is a VIEW over `formulary_rules`, not a second store — an operator who
// prefers the rule form gets the same result, and the toggle reports a
// brand as hidden however the rule was written. What the toggle will not do
// is silently rewrite a scoped rule somebody else authored: un-hiding
// removes only unscoped manufacturer excludes and reports what it left
// behind.
//
// THE PUBLISH PRE-FLIGHT IS THE POINT OF THIS FILE
// ------------------------------------------------
// A `closed` formulary with no `allow` rules denies everything, which
// turns every patient into a `contraindicated` outcome — a
// misconfiguration that looks like a clinical finding. So `publish` runs
// the resolver over a panel of synthetic faces first and refuses with 409
// `formulary_would_exclude_all` if any of them ends up with nothing.
// `simulate` exposes the same machinery so an operator can see what a rule
// does BEFORE saving it; multi-axis precedence is not something a human
// can evaluate by reading a rule list.
//
// The simulation panel is synthetic by construction — it accepts no
// patient identifier and reads no patient data, so a configuration tool
// stays outside the PHI blast radius.
//
// PHI: none.

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
import {
  invalidateFittingContext,
  loadFittingContext,
} from "../../lib/fitting/catalog-store";
import {
  resolveCatalogVisibility,
  resolveFormulary,
} from "../../lib/fitting/formulary";
import type {
  FitContext,
  FitMeasurements,
  Formulary,
  FormularyRule,
} from "../../lib/fitting/types";

const router: IRouter = Router();

type Row = Record<string, unknown>;

const ruleBody = z
  .object({
    locationId: z.string().trim().uuid().nullable().optional(),
    payerProfileId: z.string().trim().uuid().nullable().optional(),
    contractRef: z.string().trim().max(120).nullable().optional(),
    serviceLine: z.enum(["adult", "pediatric"]).nullable().optional(),
    therapyMode: z.enum(["pap", "niv"]).nullable().optional(),
    targetKind: z.enum([
      "manufacturer",
      "interface_type",
      "mask_model",
      "size_variant",
      "all",
    ]),
    targetManufacturer: z.string().trim().max(120).nullable().optional(),
    targetInterfaceType: z
      .enum([
        "nasal",
        "nasal_pillow",
        "nasal_cradle",
        "hybrid",
        "full_face",
        "total_face",
        "oral",
      ])
      .nullable()
      .optional(),
    targetMaskModelId: z.string().trim().uuid().nullable().optional(),
    targetSizeVariantId: z.string().trim().uuid().nullable().optional(),
    effect: z.enum(["allow", "deny", "exclude", "prefer", "deprioritize"]),
    preferenceRank: z.number().int().min(1).max(99).nullable().optional(),
    reasonCode: z.string().trim().max(64).nullable().optional(),
    reasonNote: z.string().trim().max(2000).nullable().optional(),
    effectiveFrom: z.string().date().nullable().optional(),
    effectiveTo: z.string().date().nullable().optional(),
  })
  .strict()
  .refine((v) => v.effect !== "prefer" || v.preferenceRank != null, {
    message: "A 'prefer' rule needs a preference rank (1 = most preferred).",
    path: ["preferenceRank"],
  });

const formularyPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    defaultPosture: z.enum(["open", "closed"]).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

const simulateBody = z
  .object({
    locationId: z.string().trim().uuid().nullable().optional(),
    payerProfileId: z.string().trim().uuid().nullable().optional(),
    contractRef: z.string().trim().max(120).nullable().optional(),
    population: z.enum(["adult", "pediatric"]).default("adult"),
    therapyMode: z.enum(["pap", "niv"]).default("pap"),
  })
  .strict();

/**
 * A synthetic panel spanning the measurement space — small, average, and
 * large faces, adult and pediatric. Synthetic by design: a configuration
 * tool must never touch a real patient.
 *
 * Synthetic is not the same as arbitrary. "Average adult face" is the
 * canonical face — MediaPipe's metric reference mesh as this pipeline's
 * landmark pairs measure it (see lib/fitting/plausibility-windows.test.ts)
 * — and the other three are that face scaled uniformly: x0.85, x1.15, and
 * x0.72 for the child. Every row therefore sits inside the plausibility
 * window for its population, with margin.
 *
 * The previous numbers were freehand and carried the textbook
 * nasion→subnasale reading of "nose height" (36 / 45 / 54 mm) rather
 * than the bridge→tip span this pipeline reports (~29 mm on an average
 * face). Two of the four faces fell outside the recalibrated windows —
 * "Large adult" at noseHeight 54 and "Small adult" at noseToChin 52 —
 * i.e. the panel meant to represent the measurement space contained
 * faces the scanner would have rejected as measurement failures.
 *
 * Only `label` is read today (the simulation resolves formulary allow /
 * deny rules, which are geometry-independent), so these values are
 * currently inert. They are kept correct because the moment size-band
 * scoring is added to the simulation — the obvious next step for this
 * tool — wrong-convention numbers here would silently produce wrong
 * answers about a tenant's own catalog.
 */
const SIMULATION_PANEL: Array<{ label: string; m: FitMeasurements }> = [
  {
    label: "Small adult face",
    m: {
      noseWidth: 30.3,
      noseHeight: 25.0,
      noseToChin: 76.0,
      mouthWidth: 41.7,
      faceWidthAtCheekbones: 130.3,
    },
  },
  {
    label: "Average adult face",
    m: {
      noseWidth: 35.7,
      noseHeight: 29.4,
      noseToChin: 89.4,
      mouthWidth: 49.1,
      faceWidthAtCheekbones: 153.3,
    },
  },
  {
    label: "Large adult face",
    m: {
      noseWidth: 41.1,
      noseHeight: 33.8,
      noseToChin: 102.8,
      mouthWidth: 56.5,
      faceWidthAtCheekbones: 176.3,
    },
  },
  {
    label: "Pediatric face",
    m: {
      noseWidth: 25.7,
      noseHeight: 21.2,
      noseToChin: 64.4,
      mouthWidth: 35.4,
      faceWidthAtCheekbones: 110.4,
    },
  },
];

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

async function activeFormularyId(orgId: string): Promise<string | null> {
  const { data } = (await getOrgScopedClient(orgId)
    .from("formularies")
    .select("id")
    .eq("status", "active")
    .limit(1)
    .maybeSingle()) as { data: Row | null };
  return data ? String(data.id) : null;
}

router.get(
  "/admin/fitter/formulary",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "formulary.read", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: formulary, error } = (await supabase
      .from("formularies")
      .select("*")
      .eq("status", "active")
      .limit(1)
      .maybeSingle()) as {
      data: Row | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    if (!formulary) {
      res.json({ formulary: null, rules: [] });
      return;
    }
    const { data: rules } = (await supabase
      .from("formulary_rules")
      .select("*")
      .eq("formulary_id", String(formulary.id))
      .order("created_at", { ascending: false })) as { data: Row[] | null };

    res.json({
      formulary: {
        id: String(formulary.id),
        name: formulary.name,
        status: formulary.status,
        defaultPosture: formulary.default_posture,
        version: formulary.version,
        publishedAt: formulary.published_at,
        publishedByEmail: formulary.published_by_email,
        notes: formulary.notes,
      },
      rules: (rules ?? []).map(mapRule),
    });
  },
);

router.patch(
  "/admin/fitter/formulary",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = formularyPatch.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const formularyId = await activeFormularyId(orgId);
    if (!formularyId) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.defaultPosture !== undefined) {
      patch.default_posture = body.data.defaultPosture;
    }
    if (body.data.notes !== undefined) patch.notes = body.data.notes;

    // Flipping the posture to `closed` with no allow rules denies
    // everything — the single easiest way to turn this page into a
    // platform-wide outage that reads to patients as a clinical finding.
    // Same pre-flight, same refusal, before it goes live.
    if (body.data.defaultPosture === "closed") {
      const starved = await starvedProfiles(orgId, {
        defaultPosture: "closed",
      });
      if (starved.length > 0) {
        res.status(409).json({
          error: "formulary_would_exclude_all",
          message:
            "A closed formulary dispenses only what an allow rule names, " +
            "and right now that leaves at least one patient profile with " +
            "nothing at all. Add your allow rules first, then close the " +
            "formulary.",
          starvedProfiles: starved,
        });
        return;
      }
    }

    const { error } = await getOrgScopedClient(orgId)
      .from("formularies")
      .update(patch)
      .eq("id", formularyId);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
  },
);

router.post(
  "/admin/fitter/formulary/rules",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.rule_create", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = ruleBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const formularyId = await activeFormularyId(orgId);
    if (!formularyId) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    const b = body.data;
    // The database enforces the one-hot target too; normalising here gives
    // the operator a clear 400 instead of a constraint-violation 500.
    const targetsByKind: Record<string, unknown> = {
      manufacturer: b.targetManufacturer,
      interface_type: b.targetInterfaceType,
      mask_model: b.targetMaskModelId,
      size_variant: b.targetSizeVariantId,
      all: null,
    };
    if (b.targetKind !== "all" && !targetsByKind[b.targetKind]) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "targetKind",
            message: `A '${b.targetKind}' rule needs its matching target value.`,
          },
        ],
      });
      return;
    }

    // Pre-flight BEFORE writing. There is no draft state — a saved rule is
    // immediately live for every patient mid-fitting — so checking only at
    // publish time leaves a window where a starving rule is already
    // producing "contraindicated" verdicts that look clinical.
    const starved = await starvedProfiles(orgId, {
      extraRule: {
        id: "__pending__",
        locationId: b.locationId ?? null,
        payerProfileId: b.payerProfileId ?? null,
        contractRef: b.contractRef ?? null,
        serviceLine: b.serviceLine ?? null,
        therapyMode: b.therapyMode ?? null,
        targetKind: b.targetKind,
        targetManufacturer:
          b.targetKind === "manufacturer"
            ? (b.targetManufacturer ?? null)
            : null,
        targetInterfaceType:
          b.targetKind === "interface_type"
            ? (b.targetInterfaceType ?? null)
            : null,
        targetMaskModelId:
          b.targetKind === "mask_model" ? (b.targetMaskModelId ?? null) : null,
        targetSizeVariantId:
          b.targetKind === "size_variant"
            ? (b.targetSizeVariantId ?? null)
            : null,
        effect: b.effect,
        preferenceRank:
          b.effect === "prefer" ? (b.preferenceRank ?? null) : null,
        reasonCode: b.reasonCode ?? null,
        reasonNote: b.reasonNote ?? null,
        effectiveFrom: b.effectiveFrom ?? null,
        effectiveTo: b.effectiveTo ?? null,
        createdAt: new Date().toISOString(),
      },
    });
    if (starved.length > 0) {
      res.status(409).json({
        error: "formulary_would_exclude_all",
        message:
          "Saving this rule would leave at least one patient profile with " +
          "no dispensable mask, and patients would see that as a clinical " +
          "exclusion rather than a configuration problem. Narrow the rule's " +
          "scope, or add an allow rule alongside it.",
        starvedProfiles: starved,
      });
      return;
    }

    const { data, error } = (await getOrgScopedClient(orgId)
      .from("formulary_rules")
      .insert({
        formulary_id: formularyId,
        location_id: b.locationId ?? null,
        payer_profile_id: b.payerProfileId ?? null,
        contract_ref: b.contractRef ?? null,
        service_line: b.serviceLine ?? null,
        therapy_mode: b.therapyMode ?? null,
        target_kind: b.targetKind,
        target_manufacturer:
          b.targetKind === "manufacturer" ? b.targetManufacturer : null,
        target_interface_type:
          b.targetKind === "interface_type" ? b.targetInterfaceType : null,
        target_mask_model_id:
          b.targetKind === "mask_model" ? b.targetMaskModelId : null,
        target_size_variant_id:
          b.targetKind === "size_variant" ? b.targetSizeVariantId : null,
        effect: b.effect,
        preference_rank: b.effect === "prefer" ? b.preferenceRank : null,
        reason_code: b.reasonCode ?? null,
        reason_note: b.reasonNote ?? null,
        effective_from: b.effectiveFrom ?? null,
        effective_to: b.effectiveTo ?? null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single()) as { data: Row | null; error: { message: string } | null };

    if (error || !data) {
      res.status(500).json({
        error: "insert_failed",
        message: error?.message ?? "unknown",
      });
      return;
    }
    invalidateFittingContext(orgId);
    res.status(201).json({ id: String(data.id) });
  },
);

router.delete(
  "/admin/fitter/formulary/rules/:id",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.rule_delete", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const { error } = await getOrgScopedClient(orgId)
      .from("formulary_rules")
      .delete()
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "delete_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
  },
);

// ── Manufacturer visibility ──────────────────────────────────────────

const UNSCOPED_AXES = [
  "locationId",
  "payerProfileId",
  "contractRef",
  "serviceLine",
  "therapyMode",
] as const;

/** An org-wide `exclude` on this manufacturer — what the toggle writes. */
function isPlainManufacturerExclude(
  rule: FormularyRule,
  manufacturer?: string,
): boolean {
  if (rule.effect !== "exclude") return false;
  if (rule.targetKind !== "manufacturer") return false;
  if (!rule.targetManufacturer) return false;
  if (
    manufacturer !== undefined &&
    rule.targetManufacturer.trim().toLowerCase() !==
      manufacturer.trim().toLowerCase()
  ) {
    return false;
  }
  return UNSCOPED_AXES.every((axis) => rule[axis] === null);
}

/**
 * GET /admin/fitter/formulary/manufacturers
 *
 * Every manufacturer in the tenant's catalog, with how many models it
 * contributes and whether it is currently hidden.
 *
 * Two INDEPENDENT booleans, because they answer different questions and
 * collapsing them into one is what makes a switch lie:
 *
 *   `hiddenByToggle` — does this switch's own rule exist? That is the
 *                      switch's POSITION, and the only thing the PUT below
 *                      can change.
 *   `hidden`         — is anything of theirs still dispensable? That is the
 *                      EFFECT, which other rules also contribute to.
 *
 * They come apart in both directions. A brand can carry the toggle rule and
 * still be dispensable, because a narrower `allow` rescued one model. And a
 * brand can be hidden with no toggle rule at all, by an exclusion somebody
 * authored by hand — which this switch reports but will not silently
 * rewrite, because deleting a rule the operator wrote deliberately is worse
 * than making them go edit it.
 */
router.get(
  "/admin/fitter/formulary/manufacturers",
  // Shared pre-auth net FIRST, then the per-actor budget.
  //
  // Both halves earn their place. `requireAdmin` does a DB-backed session
  // lookup, and the app-level `adminMutationLooseLimit` deliberately skips
  // safe methods — so without a limiter ahead of the gate, an
  // unauthenticated GET flood reaches Postgres unbounded. `adminRateLimit`
  // below cannot cover that: it keys on `req.adminUserId`, which only
  // exists once the gate has already run.
  adminReadRateLimiter,
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "formulary.manufacturers_read", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const context = await loadFittingContext(orgId);
    const asOf = new Date().toISOString().slice(0, 10);
    const visibility = resolveCatalogVisibility(
      context.formulary,
      context.catalog,
      asOf,
    );

    // Group the catalog by manufacturer, preserving the spelling the
    // catalog uses (that is what a rule has to match) while grouping
    // case-insensitively so a "Resmed"/"ResMed" seed split doesn't render
    // as two brands.
    const byKey = new Map<
      string,
      { manufacturer: string; modelCount: number; hiddenModelCount: number }
    >();
    for (const mask of context.catalog) {
      const name = mask.manufacturer.trim();
      const key = name.toLowerCase();
      const entry = byKey.get(key) ?? {
        manufacturer: name,
        modelCount: 0,
        hiddenModelCount: 0,
      };
      entry.modelCount += 1;
      if (visibility.hiddenSlugs.has(mask.slug)) entry.hiddenModelCount += 1;
      byKey.set(key, entry);
    }

    const toggleRules = context.formulary.rules.filter((r) =>
      isPlainManufacturerExclude(r),
    );

    const manufacturers = [...byKey.values()]
      .map((entry) => {
        const key = entry.manufacturer.toLowerCase();
        const toggleRule = toggleRules.find(
          (r) => r.targetManufacturer!.trim().toLowerCase() === key,
        );
        return {
          ...entry,
          // Nothing of theirs is dispensable — the effect.
          hidden: entry.hiddenModelCount === entry.modelCount,
          // This switch's own rule exists — its position.
          hiddenByToggle: toggleRule !== undefined,
          ruleId: toggleRule?.id ?? null,
        };
      })
      .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer));

    res.json({
      formulary: {
        name: context.formulary.name,
        version: context.formulary.version,
        defaultPosture: context.formulary.defaultPosture,
      },
      degraded: context.degraded,
      manufacturers,
    });
  },
);

const manufacturerVisibilityBody = z.object({ hidden: z.boolean() }).strict();

/**
 * PUT /admin/fitter/formulary/manufacturers/:name
 *
 * Hide or show one manufacturer. Idempotent: hiding an already-hidden
 * brand, or showing one that was never hidden, succeeds and changes
 * nothing.
 *
 * Hiding runs the SAME `formulary_would_exclude_all` pre-flight every
 * other mutation on this router runs, and for the same reason: rules go
 * live the moment they are written, with no draft state, so a brand that
 * cannot be dropped without starving a patient profile has to be refused
 * here rather than discovered by a patient mid-fitting.
 */
router.put(
  "/admin/fitter/formulary/manufacturers/:name",
  // Same layering as the GET above. The app-level `adminMutationLooseLimit`
  // does bound this one (it is a non-safe method under `/…/admin`), but
  // that net is per-IP and shared with every other admin mutation; this
  // caps the flood at the auth gate the way the rest of the admin tree
  // does, before the session lookup runs.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.manufacturer_toggle", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const name = z.string().trim().min(1).max(120).safeParse(req.params.name);
    if (!name.success) {
      res.status(400).json({ error: "invalid_manufacturer" });
      return;
    }
    const body = manufacturerVisibilityBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const formularyId = await activeFormularyId(orgId);
    if (!formularyId) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    const context = await loadFittingContext(orgId);
    const key = name.data.toLowerCase();
    // Resolve against the CATALOG's spelling, not the operator's: the rule
    // has to match `mask_models.manufacturer` exactly for the resolver to
    // fire, and a rule targeting "resmed" against a catalog that says
    // "ResMed" would save cleanly and then hide nothing at all.
    const canonical = context.catalog.find(
      (m) => m.manufacturer.trim().toLowerCase() === key,
    )?.manufacturer;
    if (!canonical) {
      res.status(404).json({
        error: "unknown_manufacturer",
        message:
          "No mask in this tenant's catalog is made by that manufacturer.",
      });
      return;
    }

    const supabase = getOrgScopedClient(orgId);
    const existing = context.formulary.rules.filter((r) =>
      isPlainManufacturerExclude(r, canonical),
    );

    if (body.data.hidden) {
      if (existing.length > 0) {
        res.json({ ok: true, hidden: true, manufacturer: canonical });
        return;
      }
      const pending: FormularyRule = {
        id: "__pending__",
        locationId: null,
        payerProfileId: null,
        contractRef: null,
        serviceLine: null,
        therapyMode: null,
        targetKind: "manufacturer",
        targetManufacturer: canonical,
        targetInterfaceType: null,
        targetMaskModelId: null,
        targetSizeVariantId: null,
        effect: "exclude",
        preferenceRank: null,
        reasonCode: "not_carried",
        reasonNote: null,
        effectiveFrom: null,
        effectiveTo: null,
        createdAt: new Date().toISOString(),
      };
      const starved = await starvedProfiles(orgId, { extraRule: pending });
      if (starved.length > 0) {
        res.status(409).json({
          error: "formulary_would_exclude_all",
          message:
            `Hiding ${canonical} would leave at least one patient profile ` +
            "with no mask at all, and a patient would see that as a " +
            "clinical exclusion rather than a stocking decision. Hide a " +
            "narrower set, or add the replacement line to your catalog first.",
          starvedProfiles: starved,
        });
        return;
      }

      const { error } = await supabase.from("formulary_rules").insert({
        formulary_id: formularyId,
        location_id: null,
        payer_profile_id: null,
        contract_ref: null,
        service_line: null,
        therapy_mode: null,
        target_kind: "manufacturer",
        target_manufacturer: canonical,
        target_interface_type: null,
        target_mask_model_id: null,
        target_size_variant_id: null,
        effect: "exclude",
        preference_rank: null,
        reason_code: "not_carried",
        reason_note: null,
        effective_from: null,
        effective_to: null,
        created_by_email: req.adminEmail ?? null,
      });
      if (error) {
        res
          .status(500)
          .json({ error: "insert_failed", message: error.message });
        return;
      }
      invalidateFittingContext(orgId);
      res.json({ ok: true, hidden: true, manufacturer: canonical });
      return;
    }

    // Un-hide. Only the toggle's own rules are removed — a scoped or
    // narrower exclusion is somebody's deliberate configuration, so it is
    // left alone and reported back rather than quietly dropped.
    for (const rule of existing) {
      const { error } = await supabase
        .from("formulary_rules")
        .delete()
        .eq("id", rule.id);
      if (error) {
        res
          .status(500)
          .json({ error: "delete_failed", message: error.message });
        return;
      }
    }
    invalidateFittingContext(orgId);

    const refreshed = await loadFittingContext(orgId);
    const stillHidden = resolveCatalogVisibility(
      refreshed.formulary,
      refreshed.catalog,
      new Date().toISOString().slice(0, 10),
    );
    const remaining = refreshed.catalog.filter(
      (m) =>
        m.manufacturer.trim().toLowerCase() === key &&
        stillHidden.hiddenSlugs.has(m.slug),
    );

    res.json({
      ok: true,
      hidden: false,
      manufacturer: canonical,
      // Non-zero means another rule is still hiding some of this brand.
      // The UI surfaces it so "I turned it back on and it's still gone"
      // has an answer on the page instead of in a support ticket.
      stillHiddenModelCount: remaining.length,
    });
  },
);

router.post(
  "/admin/fitter/formulary/simulate",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "formulary.simulate", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = simulateBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const result = await simulate(orgId, {
      locationId: body.data.locationId ?? null,
      payerProfileId: body.data.payerProfileId ?? null,
      contractRef: body.data.contractRef ?? null,
      population: body.data.population,
      therapyMode: body.data.therapyMode,
      asOf: new Date().toISOString().slice(0, 10),
    });
    res.json(result);
  },
);

router.post(
  "/admin/fitter/formulary/publish",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.publish", preset: "sensitive" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: formulary } = (await supabase
      .from("formularies")
      .select("id, version")
      .eq("status", "active")
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    if (!formulary) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    // Pre-flight. A formulary that leaves a synthetic face with nothing to
    // dispense is a misconfiguration, and it would surface to patients as
    // a clinical "contraindicated" verdict — so refuse to publish it.
    //
    // Every mutation runs this check too, so reaching here in a starved
    // state should be rare — but rules carry effective-date windows, so a
    // formulary that was safe when saved can become starving later. This
    // catches that.
    const starved = await starvedProfiles(orgId);
    if (starved.length > 0) {
      res.status(409).json({
        error: "formulary_would_exclude_all",
        message:
          "This formulary leaves at least one patient profile with no dispensable mask. Add an allow rule, or switch the default posture back to open, before publishing.",
        starvedProfiles: starved,
      });
      return;
    }

    const { error } = await supabase
      .from("formularies")
      .update({
        version: Number(formulary.version ?? 1) + 1,
        published_at: new Date().toISOString(),
        published_by_email: req.adminEmail ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(formulary.id));
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true, version: Number(formulary.version ?? 1) + 1 });
  },
);

/**
 * Which synthetic patient profiles would end up with NOTHING dispensable.
 *
 * A non-empty result means the formulary (as it would stand after the
 * proposed change) turns a configuration mistake into a patient-facing
 * "contraindicated" verdict. Both callers refuse on that.
 *
 * `changes` describes the prospective edit; omit it to check what is
 * already live.
 */
async function starvedProfiles(
  orgId: string,
  changes: {
    extraRule?: FormularyRule;
    removeRuleId?: string;
    defaultPosture?: "open" | "closed";
  } = {},
): Promise<string[]> {
  const live = await loadFittingContext(orgId);
  let rules = live.formulary.rules;
  if (changes.removeRuleId) {
    rules = rules.filter((r) => r.id !== changes.removeRuleId);
  }
  if (changes.extraRule) rules = [...rules, changes.extraRule];

  const proposed: Formulary = {
    ...live.formulary,
    defaultPosture: changes.defaultPosture ?? live.formulary.defaultPosture,
    rules,
  };

  // Check both service lines: a rule scoped to `pediatric` starves only
  // pediatric fittings, and checking adults alone would wave it through.
  const starved = new Set<string>();
  for (const population of ["adult", "pediatric"] as const) {
    for (const therapyMode of ["pap", "niv"] as const) {
      const result = await simulate(
        orgId,
        {
          locationId: null,
          payerProfileId: null,
          contractRef: null,
          population,
          therapyMode,
          asOf: new Date().toISOString().slice(0, 10),
        },
        proposed,
      );
      for (const p of result.panel) {
        if (p.allowedCount === 0) {
          starved.add(
            `${p.label} (${population}, ${therapyMode.toUpperCase()})`,
          );
        }
      }
    }
  }
  return [...starved];
}

interface SimulationResult {
  formulary: { name: string; version: number; defaultPosture: string };
  panel: Array<{
    label: string;
    allowedCount: number;
    deniedCount: number;
    /**
     * Of the denied, how many are HIDDEN outright rather than demoted.
     * The distinction is the operator's whole decision: a demoted mask
     * still reaches a clinician when nothing else survives, a hidden one
     * never does.
     */
    hiddenCount: number;
    preferred: Array<{ mask: string; rank: number | null }>;
    denied: Array<{
      mask: string;
      reasonCode: string | null;
      ruleIds: string[];
      hidden: boolean;
    }>;
  }>;
}

/**
 * Run the resolver over the synthetic panel.
 *
 * Reports the matched rule ids per decision, because "this mask is denied"
 * is not actionable but "this mask is denied by rule X" is.
 */
async function simulate(
  orgId: string,
  context: FitContext,
  /**
   * A hypothetical formulary to evaluate INSTEAD of the tenant's live one.
   *
   * This is what lets a save be pre-flighted before it takes effect. Rules
   * go live the moment they are written — there is no draft state — so
   * checking only at publish time leaves a window where a `deny` rule that
   * starves every patient is already shaping real recommendations, and it
   * surfaces to patients as a clinical "contraindicated" verdict rather
   * than as the misconfiguration it is.
   */
  override?: Formulary,
): Promise<SimulationResult> {
  const loaded = await loadFittingContext(orgId);
  const ctx = override ? { ...loaded, formulary: override } : loaded;
  const panel = SIMULATION_PANEL.filter((p) =>
    context.population === "pediatric" ? true : p.label !== "Pediatric face",
  ).map((face) => {
    let allowedCount = 0;
    const preferred: Array<{ mask: string; rank: number | null }> = [];
    const denied: Array<{
      mask: string;
      reasonCode: string | null;
      ruleIds: string[];
      hidden: boolean;
    }> = [];

    for (const mask of ctx.catalog) {
      if (mask.status === "discontinued") continue;
      if (
        mask.serviceLine !== "both" &&
        mask.serviceLine !== context.population
      ) {
        continue;
      }
      const decision = resolveFormulary(ctx.formulary, mask, null, context);
      if (decision.allowed) {
        allowedCount += 1;
        if (decision.preferenceRank !== null) {
          preferred.push({
            mask: `${mask.manufacturer} ${mask.modelName}`,
            rank: decision.preferenceRank,
          });
        }
      } else {
        denied.push({
          mask: `${mask.manufacturer} ${mask.modelName}`,
          reasonCode: decision.denyReasonCode,
          ruleIds: decision.matchedRuleIds,
          hidden: decision.excluded,
        });
      }
    }

    preferred.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    // Hidden first: they are the consequential half of the list, and the
    // 25-row cap must not push them off the bottom behind demotions.
    denied.sort((a, b) => Number(b.hidden) - Number(a.hidden));
    return {
      label: face.label,
      allowedCount,
      deniedCount: denied.length,
      hiddenCount: denied.filter((d) => d.hidden).length,
      preferred: preferred.slice(0, 10),
      denied: denied.slice(0, 25),
    };
  });

  return {
    formulary: {
      name: ctx.formulary.name,
      version: ctx.formulary.version,
      defaultPosture: ctx.formulary.defaultPosture,
    },
    panel,
  };
}

function mapRule(row: Row) {
  return {
    id: String(row.id),
    locationId: row.location_id,
    payerProfileId: row.payer_profile_id,
    contractRef: row.contract_ref,
    serviceLine: row.service_line,
    therapyMode: row.therapy_mode,
    targetKind: row.target_kind,
    targetManufacturer: row.target_manufacturer,
    targetInterfaceType: row.target_interface_type,
    targetMaskModelId: row.target_mask_model_id,
    targetSizeVariantId: row.target_size_variant_id,
    effect: row.effect,
    preferenceRank: row.preference_rank,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export default router;

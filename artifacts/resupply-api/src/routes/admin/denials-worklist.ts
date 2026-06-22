// /admin/billing/denials-worklist — denied claims ranked by recoverable
// dollars × win-probability (Biller #33, Phase 5).
//
//   GET /admin/billing/denials-worklist
//
// The denial-rate page + the AI billing queue already exist; this is the
// missing *worklist UX* — a single ranked list that tells the biller
// which denial to work next for the most recoverable money at the best
// odds. Recoverable = billed − paid; win-probability is the AI analysis
// confidence (or a conservative default when a claim hasn't been
// analyzed yet). One-click resubmit/appeal happens on the existing claim
// workbench, deep-linked per row.
//
// reports.read-gated (billing-read). Ranking core is pure + unit-tested.
// Returns claim metadata + the denial recommendation enum / confidence —
// no patient clinical data; the free-text root cause stays on the claim
// detail, not in this list.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  assessAuditReadiness,
  coveredKeysFromDocumentTypes,
} from "@workspace/resupply-domain";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Win-probability assumed for a denied claim with no AI analysis yet —
// deliberately modest so analyzed, high-confidence denials outrank the
// unknowns of similar dollar value.
const DEFAULT_WIN_PROBABILITY = 0.3;

export type DenialRecommendation =
  | "auto_resubmit"
  | "manual_resubmit"
  | "appeal"
  | "bill_patient"
  | "write_off"
  | "manual_review";

export interface DenialClaimInput {
  claimId: string;
  patientId: string;
  payerName: string | null;
  recoverableCents: number;
  /** AI analysis confidence 0..1, or null when not analyzed. */
  confidence: number | null;
  recommendation: DenialRecommendation | null;
  canAutoResubmit: boolean;
  denialReason: string | null;
  decisionAt: string | null;
  /** Distinct categories for this denial's CARC/RARC codes, from the
   *  denial_codes catalog (e.g. ["coverage", "coding"]). Empty on no match. */
  denialCategories: string[];
  /** True when ANY of the denial's codes is `is_terminal` in the catalog —
   *  i.e. not worth appealing (write off / bill the patient). Lets the biller
   *  triage terminal denials apart from workable ones. */
  isTerminal: boolean;
}

export interface DenialWorkItem extends DenialClaimInput {
  /** confidence ?? default, clamped to [0,1]. */
  winProbability: number;
  /** recoverableCents × winProbability — the ranking key. */
  scoreCents: number;
  hasAnalysis: boolean;
}

export interface DenialsWorklist {
  items: DenialWorkItem[];
  totals: {
    count: number;
    recoverableCents: number;
    /** Σ(recoverable × win-prob) — expected recoverable dollars. */
    expectedRecoverableCents: number;
    autoResubmittable: number;
    unanalyzed: number;
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure: score each denied claim by recoverable dollars × win-probability
 * and sort highest-value-at-best-odds first. Unanalyzed claims get a
 * conservative default probability so a freshly-denied big claim still
 * surfaces, but a high-confidence analyzed one of equal size ranks above
 * it. No I/O — unit-tested directly.
 */
export function rankDenialWorklist(
  claims: readonly DenialClaimInput[],
): DenialsWorklist {
  const items: DenialWorkItem[] = claims.map((c) => {
    const hasAnalysis = c.confidence != null || c.recommendation != null;
    const winProbability =
      c.confidence != null ? clamp01(c.confidence) : DEFAULT_WIN_PROBABILITY;
    const recoverableCents = Math.max(0, Math.trunc(c.recoverableCents));
    return {
      ...c,
      recoverableCents,
      winProbability,
      scoreCents: Math.round(recoverableCents * winProbability),
      hasAnalysis,
    };
  });

  items.sort((a, b) => b.scoreCents - a.scoreCents);

  const totals = items.reduce(
    (acc, i) => {
      acc.count += 1;
      acc.recoverableCents += i.recoverableCents;
      acc.expectedRecoverableCents += i.scoreCents;
      if (i.canAutoResubmit) acc.autoResubmittable += 1;
      if (!i.hasAnalysis) acc.unanalyzed += 1;
      return acc;
    },
    {
      count: 0,
      recoverableCents: 0,
      expectedRecoverableCents: 0,
      autoResubmittable: 0,
      unanalyzed: 0,
    },
  );

  return { items, totals };
}

// Latest-analysis review states that mean the denial is already handled
// — exclude those claims from the actionable worklist.
const RESOLVED_REVIEW_STATES = new Set([
  "accepted_resubmitted",
  "accepted_appealed",
  "accepted_written_off",
]);

/**
 * Load + shape the actionable denied-claim inputs (denied claims joined
 * to their latest denial analysis, minus already-resolved ones). Shared
 * by the denials worklist route and the billing action-queue roll-up so
 * both read the same source of truth. Returns a discriminated result so
 * callers preserve their own error responses.
 */
export async function loadDenialInputs(
  supabase: ReturnType<typeof getOrgScopedClient>,
): Promise<
  { ok: true; inputs: DenialClaimInput[] } | { ok: false; message: string }
> {
  const { data: claims, error } = await supabase
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, total_billed_cents, total_paid_cents, denial_reason, decision_at",
    )
    .eq("status", "denied")
    .order("decision_at", { ascending: false })
    .limit(500);
  if (error) return { ok: false, message: error.message };
  const claimRows = (claims ?? []) as Array<Record<string, unknown>>;
  const claimIds = claimRows
    .map((c) => (typeof c.id === "string" ? c.id : null))
    .filter((v): v is string => v != null);

  // Latest analysis per claim (rows newest-first → first seen wins).
  const analysisByClaim = new Map<string, Record<string, unknown>>();
  if (claimIds.length > 0) {
    const { data: analyses, error: aErr } = await supabase
      .from("claim_denial_analyses")
      .select(
        "claim_id, confidence, recommendation, can_auto_resubmit, review_status, created_at",
      )
      .in("claim_id", claimIds)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (aErr) return { ok: false, message: aErr.message };
    for (const a of (analyses ?? []) as Array<Record<string, unknown>>) {
      const cid = typeof a.claim_id === "string" ? a.claim_id : "";
      if (cid && !analysisByClaim.has(cid)) analysisByClaim.set(cid, a);
    }
  }

  const inputs: DenialClaimInput[] = [];
  for (const c of claimRows) {
    const id = typeof c.id === "string" ? c.id : "";
    if (id === "") continue;
    const analysis = analysisByClaim.get(id);
    const reviewStatus = analysis ? String(analysis.review_status ?? "") : "";
    // Skip denials already resolved (resubmitted / appealed / written off).
    if (RESOLVED_REVIEW_STATES.has(reviewStatus)) continue;

    const billed =
      typeof c.total_billed_cents === "number" ? c.total_billed_cents : 0;
    const paid =
      typeof c.total_paid_cents === "number" ? c.total_paid_cents : 0;
    inputs.push({
      claimId: id,
      patientId: typeof c.patient_id === "string" ? c.patient_id : "",
      payerName: typeof c.payer_name === "string" ? c.payer_name : null,
      recoverableCents: billed - paid,
      confidence:
        analysis && typeof analysis.confidence === "number"
          ? analysis.confidence
          : null,
      recommendation: analysis
        ? ((analysis.recommendation as DenialRecommendation | null) ?? null)
        : null,
      canAutoResubmit: analysis ? analysis.can_auto_resubmit === true : false,
      denialReason:
        typeof c.denial_reason === "string" ? c.denial_reason : null,
      decisionAt: typeof c.decision_at === "string" ? c.decision_at : null,
      denialCategories: [],
      isTerminal: false,
    });
  }

  // Enrich each denial with its codes' catalog category + terminal flag.
  // The CARC/RARC codes live in the denial_reason string (e.g. "CARC 16 — …;
  // RARC N130 — …"); parse them out and join the GLOBAL denial_codes catalog
  // (read via the unscoped client, keyed by code_system + code). A catalog
  // miss leaves the defaults ([] / false) — never blocks the worklist.
  const codeRe = /(CARC|RARC)\s+([A-Z]?\d+)/gi;
  const codesByClaim = new Map<string, Set<string>>(); // claimId → "system:CODE"
  const allKeys = new Set<string>();
  for (const inp of inputs) {
    if (!inp.denialReason) continue;
    const keys = new Set<string>();
    for (const m of inp.denialReason.matchAll(codeRe)) {
      const key = `${m[1]!.toLowerCase()}:${m[2]!.toUpperCase()}`;
      keys.add(key);
      allKeys.add(key);
    }
    if (keys.size > 0) codesByClaim.set(inp.claimId, keys);
  }
  if (allKeys.size > 0) {
    const codeValues = [...allKeys].map((k) => k.split(":")[1]!);
    const { data: catalog } = await supabase
      .raw()
      .schema("resupply")
      .from("denial_codes")
      .select("code_system, code, category, is_terminal")
      .in("code", codeValues);
    const byKey = new Map<string, { category: string; is_terminal: boolean }>();
    for (const row of (catalog ?? []) as Array<{
      code_system: string;
      code: string;
      category: string;
      is_terminal: boolean;
    }>) {
      byKey.set(`${row.code_system.toLowerCase()}:${row.code.toUpperCase()}`, {
        category: row.category,
        is_terminal: row.is_terminal === true,
      });
    }
    for (const inp of inputs) {
      const keys = codesByClaim.get(inp.claimId);
      if (!keys) continue;
      const categories = new Set<string>();
      let terminal = false;
      for (const key of keys) {
        const hit = byKey.get(key);
        if (!hit) continue;
        categories.add(hit.category);
        if (hit.is_terminal) terminal = true;
      }
      inp.denialCategories = [...categories];
      inp.isTerminal = terminal;
    }
  }

  return { ok: true, inputs };
}

const querySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
  .strip();

router.get(
  "/admin/billing/denials-worklist",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const limit = parsed.success ? (parsed.data.limit ?? 200) : 200;

    // Fail closed: never widen to all tenants on a missing orgId.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(orgId);
    const loaded = await loadDenialInputs(db);
    if (!loaded.ok) {
      res.status(500).json({ error: "query_failed", message: loaded.message });
      return;
    }

    const worklist = rankDenialWorklist(loaded.inputs);
    const topItems = worklist.items.slice(0, limit);

    // When the audit feature is on, flag which denied claims are document-
    // complete (a defensible appeal) vs document-short (likely to lose an
    // audit too). One bulk doc query over just the displayed patients.
    let items: Array<
      (typeof topItems)[number] & {
        auditReady?: boolean;
        missingRequired?: number;
      }
    > = topItems;
    if (await isFeatureEnabled("billing.adr_queue", orgId)) {
      const patientIds = Array.from(
        new Set(topItems.map((i) => i.patientId).filter(Boolean)),
      );
      const docTypesByPatient = new Map<string, Set<string>>();
      if (patientIds.length > 0) {
        const { data: pdocs } = await db
          .from("patient_documents")
          .select("patient_id, document_type")
          .in("patient_id", patientIds);
        for (const d of (pdocs ?? []) as Array<{
          patient_id: string;
          document_type: string;
        }>) {
          const set = docTypesByPatient.get(d.patient_id) ?? new Set<string>();
          set.add(d.document_type);
          docTypesByPatient.set(d.patient_id, set);
        }
      }
      items = topItems.map((i) => {
        if (!i.patientId) return i;
        const r = assessAuditReadiness(
          "device",
          coveredKeysFromDocumentTypes([
            ...(docTypesByPatient.get(i.patientId) ?? new Set<string>()),
          ]),
        );
        return { ...i, auditReady: r.ready, missingRequired: r.missing.length };
      });
    }

    res.json({
      items,
      totals: worklist.totals,
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;

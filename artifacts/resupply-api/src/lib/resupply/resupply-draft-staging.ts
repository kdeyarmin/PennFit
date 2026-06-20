// Shared staging logic for resupply order drafts, used by BOTH the manual
// batch-create endpoint (a CSR multi-selects opportunities) and the daily
// `resupply-auto-draft` worker. A draft is a PROPOSAL — staging never
// creates an order or charges anyone; a CSR approves it later.
//
// Idempotency: at most one OPEN (proposed/approved) draft per
// (patient, category, next-eligible-date). The dedup DECISION is a pure
// function (`planDraftInserts`) so it's unit-tested without a DB; the thin
// wrapper (`stageResupplyDrafts`) reads the existing open keys, plans, and
// inserts. The partial-unique index (migration 0391) is the race backstop.

import type { OrgScopedClient } from "@workspace/resupply-db";

export interface DraftSeed {
  patientId: string;
  category: string;
  source?: string | null;
  sourceDescription?: string | null;
  nextEligibleDate?: string | null;
}

export interface DraftStagingActor {
  origin: "auto" | "manual";
  createdByUserId?: string | null;
  createdByEmail?: string | null;
}

export interface DraftStagingResult {
  staged: number;
  skipped: number;
}

/** Composite dedup key: one open draft per (patient, category, date). */
export function draftDedupKey(
  patientId: string,
  category: string,
  nextEligibleDate: string | null | undefined,
): string {
  return `${patientId}|${category}|${nextEligibleDate ?? ""}`;
}

/**
 * Decide which seeds to insert, given the set of dedup keys that already
 * have an OPEN draft. Also collapses duplicates within the incoming batch.
 * Pure — no DB.
 */
export function planDraftInserts(
  seeds: DraftSeed[],
  existingOpenKeys: ReadonlySet<string>,
): { toInsert: DraftSeed[]; skipped: number } {
  const seen = new Set<string>();
  const toInsert: DraftSeed[] = [];
  let skipped = 0;
  for (const seed of seeds) {
    const key = draftDedupKey(
      seed.patientId,
      seed.category,
      seed.nextEligibleDate,
    );
    if (existingOpenKeys.has(key) || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    toInsert.push(seed);
  }
  return { toInsert, skipped };
}

function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toRow(
  seed: DraftSeed,
  actor: DraftStagingActor,
): Record<string, unknown> {
  return {
    patient_id: seed.patientId,
    category: seed.category,
    source: seed.source ?? null,
    source_description: seed.sourceDescription ?? null,
    next_eligible_date: seed.nextEligibleDate ?? null,
    status: "proposed",
    origin: actor.origin,
    created_by_user_id: actor.createdByUserId ?? null,
    created_by_email: actor.createdByEmail ?? null,
  };
}

interface ExistingOpenRow {
  patient_id: string;
  category: string;
  next_eligible_date: string | null;
}

/**
 * Stage drafts for `seeds`, skipping any that already have an open draft.
 * `org_id` is injected by the org-scoped facade on insert — never set it
 * here. Returns how many rows were staged vs skipped.
 */
export async function stageResupplyDrafts(
  supabase: OrgScopedClient,
  seeds: DraftSeed[],
  actor: DraftStagingActor,
): Promise<DraftStagingResult> {
  if (seeds.length === 0) return { staged: 0, skipped: 0 };

  const patientIds = Array.from(new Set(seeds.map((s) => s.patientId)));
  const { data, error } = await supabase
    .from("resupply_order_drafts")
    .select("patient_id, category, next_eligible_date")
    .in("status", ["proposed", "approved"])
    .in("patient_id", patientIds);
  if (error) throw error;

  const existingOpenKeys = new Set<string>(
    ((data ?? []) as ExistingOpenRow[]).map((r) =>
      draftDedupKey(r.patient_id, r.category, r.next_eligible_date),
    ),
  );

  const { toInsert, skipped } = planDraftInserts(seeds, existingOpenKeys);
  if (toInsert.length === 0) return { staged: 0, skipped };

  const rows = toInsert.map((seed) => toRow(seed, actor));
  const { error: insertError } = await supabase
    .from("resupply_order_drafts")
    .insert(rows);
  if (!insertError) return { staged: rows.length, skipped };

  // A concurrent run may have inserted the same open draft between our read
  // and write (the partial-unique index rejects it). Fall back to per-row
  // inserts, skipping just the conflicting ones.
  if (pgErrorCode(insertError) !== "23505") throw insertError;
  let staged = 0;
  let racedSkipped = skipped;
  for (const row of rows) {
    const { error: rowError } = await supabase
      .from("resupply_order_drafts")
      .insert(row);
    if (!rowError) staged += 1;
    else if (pgErrorCode(rowError) === "23505") racedSkipped += 1;
    else throw rowError;
  }
  return { staged, skipped: racedSkipped };
}

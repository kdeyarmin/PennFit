// pacware-shipments.ts — the return leg of the PacWare file exchange.
//
// `/admin/pacware/export/resupply-due.csv` hands PacWare a worklist of
// what to pick, ship and bill. Nothing ever came back. So
// `fulfillments.shipped_at` stayed NULL forever, and four things were
// quietly wrong because of it:
//
//   * refill cadence anchored on when we QUEUED the order rather than
//     when the patient received it (worker/jobs/reminders.ts:641);
//   * the reorder funnel's "shipped" stage was permanently zero;
//   * resupply.fulfillments_to_bill_count() always returned zero;
//   * every claim carried today's date as its date of service instead of
//     the real one (lib/billing/claim-builder.ts:197).
//
// This route imports PacWare's shipment report and closes that loop.
// Preview first, then commit — the same shape as the patient import
// beside it, for the same reason: an operator should see what a file
// will do before it does it.
//
// PHI: the preview returns COUNTS ONLY, never sample rows. The patient
// import makes the same choice and says why — a sample would put PHI in
// the response body, and if the caller passed an Idempotency-Key the
// idempotency middleware would persist it. Row errors carry an index and
// a field name, never the offending value.
//
// DATE OF SERVICE IS NOT A HYGIENE FIELD. A ship date imported here
// becomes the date of service on an 837P. A bulk first import that
// backfills months of history will therefore produce months-old claims,
// which can cross a payer's timely-filing limit (CARC 29). Hence the
// clamp below and the `shipDatesOlderThan60d` count in the preview: the
// operator sees the backdating before they commit to it.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  matchShipmentRows,
  parsePacwareShipmentCsv,
  type PacwareShipmentRow,
  type ShipmentCandidateFulfillment,
  type ShipmentMatchResult,
} from "@workspace/resupply-integrations-pacware";

import { recordShipmentEvidence } from "../../lib/fulfillments/record-shipment-evidence";
import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const MAX_IMPORT_ROWS = 5000;
/** Rows per `.in(...)` lookup chunk — keeps the PostgREST URL bounded. */
const READ_CHUNK = 200;
/** PostgREST caps a single read at ~1000 rows regardless of `.limit()`. */
const PAGE_SIZE = 1000;
/**
 * How far back a ship date may reach. Past this the operator is almost
 * certainly importing history, and every matched row would mint a claim
 * dated that far back.
 */
const MAX_SHIP_BACKDATE_DAYS = 180;
/** Ship dates older than this are counted in the preview as a warning. */
const BACKDATE_WARN_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({
    csv: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
    mode: z.enum(["preview", "commit"]),
  })
  .strict();

interface RowIssue {
  rowIndex: number;
  field?: string;
  message: string;
}

/**
 * Reject a ship date that cannot be right, with a reason an operator can
 * act on. Returns null when the date is acceptable.
 */
function shipDateIssue(row: PacwareShipmentRow, now: Date): string | null {
  const shippedMs = Date.parse(`${row.shippedDate}T00:00:00.000Z`);
  if (!Number.isFinite(shippedMs)) return "ship date is not a real date";
  // Allow one day ahead: a warehouse in a later timezone, or a report run
  // just after midnight, can legitimately look like tomorrow from UTC.
  if (shippedMs - now.getTime() > DAY_MS) {
    return "ship date is in the future";
  }
  if (now.getTime() - shippedMs > MAX_SHIP_BACKDATE_DAYS * DAY_MS) {
    return `ship date is more than ${MAX_SHIP_BACKDATE_DAYS} days old; importing it would date a claim that far back`;
  }
  return null;
}

/**
 * Load every fulfillment that could plausibly be referenced by this file.
 *
 * Three lookups, one per match strategy, each chunked at READ_CHUNK for
 * the PostgREST URL limit AND paged at PAGE_SIZE inside each chunk —
 * 200 patients can own far more than one page of dispense history, and an
 * unpaginated read silently truncates, which would turn a real match into
 * an "unmatched" row the operator has to chase.
 */
async function loadCandidates(
  supabase: ReturnType<typeof getOrgScopedClient>,
  rows: readonly PacwareShipmentRow[],
): Promise<ShipmentCandidateFulfillment[]> {
  const episodeIds = [
    ...new Set(rows.map((r) => r.pennfitEpisodeId).filter(Boolean)),
  ] as string[];
  const orderRefs = [
    ...new Set(rows.map((r) => r.pacwareOrderRef).filter(Boolean)),
  ] as string[];
  const pacwareIds = [...new Set(rows.map((r) => r.pacwareId))];

  // pacware_id -> patient_id. The fulfillments table has no pacware_id of
  // its own, so the fallback strategy has to hop through patients.
  const patientIdByPacwareId = new Map<string, string>();
  const pacwareIdByPatientId = new Map<string, string>();
  for (let i = 0; i < pacwareIds.length; i += READ_CHUNK) {
    const chunk = pacwareIds.slice(i, i + READ_CHUNK);
    const { data, error } = await supabase
      .from("patients")
      .select("id, pacware_id")
      .in("pacware_id", chunk);
    if (error) throw error;
    for (const p of (data ?? []) as Array<{
      id: string;
      pacware_id: string | null;
    }>) {
      if (!p.pacware_id) continue;
      patientIdByPacwareId.set(p.pacware_id, p.id);
      pacwareIdByPatientId.set(p.id, p.pacware_id);
    }
  }

  const SELECT =
    "id, episode_id, patient_id, item_sku, pacware_order_ref, created_at, shipped_at, status";
  const byId = new Map<string, ShipmentCandidateFulfillment>();

  const absorb = (data: unknown[] | null): void => {
    for (const f of (data ?? []) as Array<{
      id: string;
      episode_id: string | null;
      patient_id: string | null;
      item_sku: string | null;
      pacware_order_ref: string | null;
      created_at: string;
      shipped_at: string | null;
      status: string | null;
    }>) {
      byId.set(f.id, {
        id: f.id,
        episodeId: f.episode_id,
        patientPacwareId: f.patient_id
          ? (pacwareIdByPatientId.get(f.patient_id) ?? null)
          : null,
        itemSku: f.item_sku ?? "",
        pacwareOrderRef: f.pacware_order_ref,
        createdAt: f.created_at,
        shippedAt: f.shipped_at,
        status: f.status ?? "queued",
      });
    }
  };

  const pagedIn = async (
    column: string,
    values: readonly string[],
  ): Promise<void> => {
    for (let i = 0; i < values.length; i += READ_CHUNK) {
      const chunk = values.slice(i, i + READ_CHUNK);
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("fulfillments")
          .select(SELECT)
          .in(column, chunk)
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        absorb(data as unknown[] | null);
        if (!data || data.length < PAGE_SIZE) break;
      }
    }
  };

  if (episodeIds.length > 0) await pagedIn("episode_id", episodeIds);
  if (orderRefs.length > 0) await pagedIn("pacware_order_ref", orderRefs);
  const patientIds = [...patientIdByPacwareId.values()];
  if (patientIds.length > 0) await pagedIn("patient_id", patientIds);

  return [...byId.values()];
}

interface MatchTally {
  byEpisodeId: number;
  byOrderRef: number;
  byPatientSku: number;
  unmatched: number;
  ambiguous: number;
  rowCancelled: number;
  alreadyRecorded: number;
}

function tally(matches: readonly ShipmentMatchResult[]): MatchTally {
  const t: MatchTally = {
    byEpisodeId: 0,
    byOrderRef: 0,
    byPatientSku: 0,
    unmatched: 0,
    ambiguous: 0,
    rowCancelled: 0,
    alreadyRecorded: 0,
  };
  for (const m of matches) {
    if (m.alreadyRecorded) t.alreadyRecorded += 1;
    switch (m.strategy) {
      case "episode_id":
        t.byEpisodeId += 1;
        break;
      case "order_ref":
        t.byOrderRef += 1;
        break;
      case "patient_sku_date":
        t.byPatientSku += 1;
        break;
      case "ambiguous":
        t.ambiguous += 1;
        break;
      case "row_cancelled":
        t.rowCancelled += 1;
        break;
      default:
        t.unmatched += 1;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// POST /admin/pacware/import/shipments — preview or commit.
// ---------------------------------------------------------------------------
router.post(
  "/admin/pacware/import/shipments",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  withIdempotency("POST /admin/pacware/import/shipments"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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

    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const { csv, mode } = parsed.data;
    const result = parsePacwareShipmentCsv(csv);

    if (result.totalDataRows > MAX_IMPORT_ROWS) {
      res.status(413).json({
        error: "too_many_rows",
        message: `This file has ${result.totalDataRows} rows; the limit per upload is ${MAX_IMPORT_ROWS}. Split the report and upload in parts.`,
      });
      return;
    }

    const now = new Date();
    const issues: RowIssue[] = result.errors.map((e) => ({
      rowIndex: e.rowIndex,
      field: e.field,
      message: e.message,
    }));

    // Clamp implausible ship dates before matching, so a typo cannot mint
    // a claim dated two years back.
    const usable: PacwareShipmentRow[] = [];
    const usableIndex: number[] = [];
    result.rows.forEach((row, i) => {
      const problem = shipDateIssue(row, now);
      if (problem) {
        issues.push({
          rowIndex: i + 1,
          field: "shippedDate",
          message: problem,
        });
        return;
      }
      usable.push(row);
      usableIndex.push(i + 1);
    });

    let candidates: ShipmentCandidateFulfillment[];
    try {
      candidates = await loadCandidates(getOrgScopedClient(orgId), usable);
    } catch (err) {
      logger.error(
        {
          event: "pacware.shipments_import_lookup_failed",
          errName: err instanceof Error ? err.name : "unknown",
        },
        "pacware/shipments: candidate lookup failed",
      );
      res.status(503).json({ error: "lookup_failed" });
      return;
    }

    const matches = matchShipmentRows(usable, candidates).map((m, i) => ({
      ...m,
      // Re-map onto the ORIGINAL file row numbers so an operator reading
      // the preview can find the line in their spreadsheet.
      rowIndex: usableIndex[i] ?? m.rowIndex,
    }));
    const counts = tally(matches);

    const oldestShipDate = usable.reduce<string | null>(
      (min, r) => (min === null || r.shippedDate < min ? r.shippedDate : min),
      null,
    );
    const shipDatesOlderThan60d = usable.filter(
      (r) =>
        now.getTime() - Date.parse(`${r.shippedDate}T00:00:00.000Z`) >
        BACKDATE_WARN_DAYS * DAY_MS,
    ).length;

    if (mode === "preview") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        mode: "preview",
        totalDataRows: result.totalDataRows,
        validCount: usable.length,
        errorCount: issues.length,
        matched: {
          byEpisodeId: counts.byEpisodeId,
          byOrderRef: counts.byOrderRef,
          byPatientSku: counts.byPatientSku,
        },
        unmatched: counts.unmatched,
        ambiguous: counts.ambiguous,
        rowCancelled: counts.rowCancelled,
        alreadyRecorded: counts.alreadyRecorded,
        oldestShipDate,
        shipDatesOlderThan60d,
        unmappedHeaders: result.unmappedHeaders ?? [],
        errors: issues.slice(0, 200),
      });
      return;
    }

    // ── commit ──────────────────────────────────────────────────────
    let applied = 0;
    let unchanged = 0;
    let failed = 0;
    let nextCyclesOpened = 0;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (!match.fulfillmentId) continue;
      const row = usable[i];
      if (!row) continue;

      if (match.alreadyRecorded) {
        unchanged += 1;
        continue;
      }

      try {
        const outcome = await recordShipmentEvidence({
          orgId,
          fulfillmentId: match.fulfillmentId,
          shippedAt: new Date(`${row.shippedDate}T12:00:00.000Z`),
          deliveredAt: row.deliveredDate
            ? new Date(`${row.deliveredDate}T12:00:00.000Z`)
            : null,
          source: "pacware_import",
          pacwareOrderRef: row.pacwareOrderRef ?? null,
          trackingNumber: row.trackingNumber ?? null,
          carrier: row.carrier ?? null,
        });
        if (outcome.status === "applied") {
          applied += 1;
          if (outcome.nextEpisodeId) nextCyclesOpened += 1;
        } else if (outcome.status === "already_recorded") {
          unchanged += 1;
        } else {
          failed += 1;
          issues.push({
            rowIndex: match.rowIndex,
            message:
              outcome.status === "not_shippable"
                ? "that order was cancelled, so no shipment was recorded"
                : "the matched order no longer exists",
          });
        }
      } catch (err) {
        failed += 1;
        // Never echo the row: it is PHI.
        logger.warn(
          {
            event: "pacware.shipments_import_row_failed",
            fulfillmentId: match.fulfillmentId,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "pacware/shipments: row failed to apply",
        );
        issues.push({
          rowIndex: match.rowIndex,
          message: "failed to write (database error)",
        });
      }
    }

    await logAudit({
      action: "fulfillment.pacware_shipment_import",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fulfillments",
      targetId: null,
      metadata: {
        total_data_rows: result.totalDataRows,
        valid_rows: usable.length,
        applied,
        unchanged,
        failed,
        unmatched: counts.unmatched,
        ambiguous: counts.ambiguous,
        row_cancelled: counts.rowCancelled,
        next_cycles_opened: nextCyclesOpened,
        oldest_ship_date: oldestShipDate,
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      mode: "commit",
      totalDataRows: result.totalDataRows,
      applied,
      unchanged,
      failed,
      unmatched: counts.unmatched,
      ambiguous: counts.ambiguous,
      rowCancelled: counts.rowCancelled,
      nextCyclesOpened,
      errors: issues.slice(0, 200),
    });
  },
);

export default router;

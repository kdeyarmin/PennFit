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
//   POST /admin/pacware/import/shipments            preview or commit
//   POST /admin/pacware/import/shipments/report.csv sanitized dispositions
//   GET  /admin/pacware/shipment-exceptions         ship-date conflicts
//   POST /admin/pacware/shipment-exceptions/:id/resolve
//
// DATE OF SERVICE IS NOT A HYGIENE FIELD
// --------------------------------------
// A ship date imported here becomes the date of service on an 837P.
// Three consequences run through the whole file:
//
//   * A bulk first import that backfills months of history produces
//     months-old claims, which can cross a payer's timely-filing limit
//     (CARC 29). Rows past `DEFAULT_MAX_BACKDATE_DAYS` are classified
//     `too_old` and NOT applied; the operator sees the count and decides.
//   * A future date cannot be a date of service at all — `future_dated`,
//     never applied.
//   * A date already recorded AND already billed cannot be corrected in
//     place. The payer has been told something; overwriting it would make
//     the claim and the record disagree with nobody knowing. Those rows
//     become `date_conflict` and open a `shipment_date_exceptions` row
//     for a person. Previously the new date was silently dropped —
//     safe, but the correction the warehouse sent was lost.
//
// IDEMPOTENCY, TWICE
// ------------------
//   * Per ROW: `recordShipmentEvidence` claims the fulfillment with
//     `.is("shipped_at", null)`, so a replay writes nothing.
//   * Per FILE: a SHA-256 of the normalized report text is recorded on
//     every commit. The `Idempotency-Key` header stops a double-submit
//     of the same REQUEST; it does nothing about the same FILE uploaded
//     from a fresh tab, by a colleague, or after a timeout that had
//     actually succeeded. Those are different requests with identical
//     content, and only the content can tell.
//
// PHI
// ---
// The preview returns COUNTS ONLY, never sample rows — a sample would
// put PHI in the response body, and with an `Idempotency-Key` the
// idempotency middleware would persist it. The downloadable disposition
// report carries row NUMBERS, categories, reasons built from constants,
// and internal UUIDs — never a name, account number, SKU, tracking
// number or date drawn from the file. That is what makes it safe to
// attach to a ticket. The operator finds the offending line by row
// number in their own copy, which never left their machine.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  buildShipmentDispositionCsv,
  classifyShipmentRows,
  computeShipmentFileHash,
  countDispositions,
  matchShipmentRows,
  parsePacwareShipmentCsv,
  type ClassifiedShipmentRow,
  type PacwareShipmentRow,
  type ShipmentCandidateFulfillment,
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
    /**
     * Re-commit a file already on record. Off by default: a silent
     * re-import reports the same counts as the first one with everything
     * "unchanged", which is indistinguishable from a file that genuinely
     * contained nothing new.
     */
    acknowledgeReimport: z.boolean().optional(),
    /**
     * Raise the timely-filing threshold for a deliberate history
     * backfill. Bounded, and every row it admits is still counted and
     * reported.
     */
    maxBackdateDays: z.number().int().min(1).max(730).optional(),
  })
  .strict();

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
): Promise<{
  candidates: ShipmentCandidateFulfillment[];
  recordedShipDates: Map<string, string>;
}> {
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
  const recordedShipDates = new Map<string, string>();

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
      if (f.shipped_at) recordedShipDates.set(f.id, f.shipped_at);
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

  return { candidates: [...byId.values()], recordedShipDates };
}

/**
 * Which of these fulfillments already have a claim behind them.
 *
 * The distinction decides whether a changed ship date is a correction a
 * person must work (billed) or merely a value to leave alone (not
 * billed).
 */
async function loadBilledFulfillments(
  supabase: ReturnType<typeof getOrgScopedClient>,
  fulfillmentIds: readonly string[],
): Promise<{ billed: Set<string>; claimIdByFulfillment: Map<string, string> }> {
  const billed = new Set<string>();
  const claimIdByFulfillment = new Map<string, string>();
  for (let i = 0; i < fulfillmentIds.length; i += READ_CHUNK) {
    const chunk = fulfillmentIds.slice(i, i + READ_CHUNK);
    const { data, error } = await supabase
      .from("insurance_claims")
      .select("id, fulfillment_id")
      .in("fulfillment_id", chunk);
    if (error) throw error;
    for (const c of (data ?? []) as Array<{
      id: string;
      fulfillment_id: string | null;
    }>) {
      if (!c.fulfillment_id) continue;
      billed.add(c.fulfillment_id);
      if (!claimIdByFulfillment.has(c.fulfillment_id)) {
        claimIdByFulfillment.set(c.fulfillment_id, c.id);
      }
    }
  }
  return { billed, claimIdByFulfillment };
}

interface AnalyzedFile {
  fileHash: string;
  totalDataRows: number;
  classified: ClassifiedShipmentRow[];
  usable: PacwareShipmentRow[];
  /** Aligned with `usable`: file row number per parsed row. */
  usableIndex: number[];
  unmappedHeaders: string[];
  oldestShipDate: string | null;
  newestShipDate: string | null;
  shipDatesOlderThan60d: number;
  claimIdByFulfillment: Map<string, string>;
}

/**
 * Parse, match and classify a file. Read-only — this is exactly what a
 * preview does, and exactly what a commit does before it writes, so the
 * two can never disagree about what a file means.
 */
async function analyzeFile(
  orgId: string,
  csv: string,
  now: Date,
  maxBackdateDays: number | undefined,
): Promise<AnalyzedFile> {
  const supabase = getOrgScopedClient(orgId);
  const parsed = parsePacwareShipmentCsv(csv);
  const fileHash = await computeShipmentFileHash(csv);

  const usable: PacwareShipmentRow[] = [];
  const usableIndex: number[] = [];
  parsed.rows.forEach((row, i) => {
    usable.push(row);
    usableIndex.push(i + 1);
  });

  const { candidates, recordedShipDates } = await loadCandidates(
    supabase,
    usable,
  );
  const matches = matchShipmentRows(usable, candidates);

  // Which matched fulfillments are already billed. Only needed for rows
  // whose ship date is already recorded — the rest cannot conflict.
  const alreadyRecordedIds = matches
    .map((m) => m.fulfillmentId)
    .filter((id): id is string => id !== null && recordedShipDates.has(id));
  const { billed, claimIdByFulfillment } = await loadBilledFulfillments(
    supabase,
    [...new Set(alreadyRecordedIds)],
  );

  const classified = classifyShipmentRows({
    rows: usable,
    rowIndexes: usableIndex,
    matches,
    parseErrors: parsed.errors,
    recordedShipDates,
    fulfillmentsWithClaims: billed,
    now,
    maxBackdateDays,
  });

  const shipDates = usable.map((r) => r.shippedDate).sort();
  const shipDatesOlderThan60d = usable.filter(
    (r) =>
      now.getTime() - Date.parse(`${r.shippedDate}T00:00:00.000Z`) >
      BACKDATE_WARN_DAYS * DAY_MS,
  ).length;

  return {
    fileHash,
    totalDataRows: parsed.totalDataRows,
    classified,
    usable,
    usableIndex,
    unmappedHeaders: parsed.unmappedHeaders ?? [],
    oldestShipDate: shipDates[0] ?? null,
    newestShipDate: shipDates[shipDates.length - 1] ?? null,
    shipDatesOlderThan60d,
    claimIdByFulfillment,
  };
}

/** Look up a prior COMMIT of the same file for this tenant. */
async function findPriorCommit(
  orgId: string,
  fileHash: string,
): Promise<{ id: string; createdAt: string; appliedCount: number } | null> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("pacware_shipment_imports")
    .select("id, created_at, applied_count")
    .eq("file_hash", fileHash)
    .eq("mode", "commit")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    created_at: string;
    applied_count: number;
  };
  return {
    id: row.id,
    createdAt: row.created_at,
    appliedCount: row.applied_count,
  };
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
    const parsedBody = bodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsedBody.error.issues.map((i) => ({
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

    const { csv, mode, acknowledgeReimport, maxBackdateDays } = parsedBody.data;

    // Cheap row-count guard before any DB work.
    const rowCountProbe = parsePacwareShipmentCsv(csv);
    if (rowCountProbe.totalDataRows > MAX_IMPORT_ROWS) {
      res.status(413).json({
        error: "too_many_rows",
        message: `This file has ${rowCountProbe.totalDataRows} rows; the limit per upload is ${MAX_IMPORT_ROWS}. Split the report and upload in parts.`,
      });
      return;
    }

    const now = new Date();
    let analysis: AnalyzedFile;
    try {
      analysis = await analyzeFile(orgId, csv, now, maxBackdateDays);
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

    const counts = countDispositions(analysis.classified);
    const priorCommit = await findPriorCommit(orgId, analysis.fileHash).catch(
      () => null,
    );

    if (mode === "preview") {
      // A preview is a question, not an event. It records nothing and
      // claims no hash, so previewing the same file five times while an
      // operator works out what it will do is free.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        mode: "preview",
        fileHash: analysis.fileHash,
        totalDataRows: analysis.totalDataRows,
        dispositions: counts,
        willApply: counts.matched,
        needsAPerson:
          counts.ambiguous +
          counts.unmatched +
          counts.date_conflict +
          counts.invalid,
        alreadyImported: priorCommit
          ? { at: priorCommit.createdAt, applied: priorCommit.appliedCount }
          : null,
        oldestShipDate: analysis.oldestShipDate,
        newestShipDate: analysis.newestShipDate,
        shipDatesOlderThan60d: analysis.shipDatesOlderThan60d,
        unmappedHeaders: analysis.unmappedHeaders,
      });
      return;
    }

    // ── commit ──────────────────────────────────────────────────────
    if (priorCommit && !acknowledgeReimport) {
      res.status(409).json({
        error: "already_imported",
        message:
          `This exact file was already imported on ${priorCommit.createdAt} ` +
          `(${priorCommit.appliedCount} shipment(s) recorded). Re-importing it ` +
          "writes nothing new — every row is already claimed. Send " +
          "`acknowledgeReimport: true` if you meant to run it again.",
        importedAt: priorCommit.createdAt,
        appliedCount: priorCommit.appliedCount,
      });
      return;
    }

    let applied = 0;
    let unchanged = 0;
    let failed = 0;
    let nextCyclesOpened = 0;
    let exceptionsOpened = 0;
    const rowIssues: Array<{ rowIndex: number; message: string }> = [];

    // Rows whose ship date conflicts with one already billed. Raised as
    // exceptions BEFORE the writes, so a failure part-way through the
    // apply loop still leaves the corrections queued for a person.
    for (const row of analysis.classified) {
      if (!row.requiresException || !row.fulfillmentId) continue;
      const parsedRow = analysis.usable[
        analysis.usableIndex.indexOf(row.rowIndex)
      ] as PacwareShipmentRow | undefined;
      if (!parsedRow) continue;
      try {
        const opened = await openShipDateException({
          orgId,
          fulfillmentId: row.fulfillmentId,
          proposedShippedAt: new Date(`${parsedRow.shippedDate}T12:00:00.000Z`),
          claimId: analysis.claimIdByFulfillment.get(row.fulfillmentId) ?? null,
          raisedByEmail: req.adminEmail ?? null,
        });
        if (opened) exceptionsOpened += 1;
      } catch (err) {
        logger.warn(
          {
            event: "pacware.ship_date_exception_failed",
            fulfillmentId: row.fulfillmentId,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "pacware/shipments: could not raise a ship-date exception",
        );
      }
    }

    for (const row of analysis.classified) {
      if (row.disposition === "already_recorded") {
        unchanged += 1;
        continue;
      }
      // ONLY `matched` is written. Everything else — ambiguous,
      // unmatched, duplicate, cancelled, invalid, too_old, future_dated,
      // date_conflict — is reported and skipped.
      if (row.disposition !== "matched" || !row.fulfillmentId) continue;

      const parsedRow = analysis.usable[
        analysis.usableIndex.indexOf(row.rowIndex)
      ] as PacwareShipmentRow | undefined;
      if (!parsedRow) continue;

      try {
        const outcome = await recordShipmentEvidence({
          orgId,
          fulfillmentId: row.fulfillmentId,
          shippedAt: new Date(`${parsedRow.shippedDate}T12:00:00.000Z`),
          deliveredAt: parsedRow.deliveredDate
            ? new Date(`${parsedRow.deliveredDate}T12:00:00.000Z`)
            : null,
          source: "pacware_import",
          pacwareOrderRef: parsedRow.pacwareOrderRef ?? null,
          trackingNumber: parsedRow.trackingNumber ?? null,
          carrier: parsedRow.carrier ?? null,
        });
        if (outcome.status === "applied") {
          applied += 1;
          if (outcome.nextEpisodeId) nextCyclesOpened += 1;
        } else if (outcome.status === "already_recorded") {
          unchanged += 1;
        } else {
          failed += 1;
          rowIssues.push({
            rowIndex: row.rowIndex,
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
            fulfillmentId: row.fulfillmentId,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "pacware/shipments: row failed to apply",
        );
        rowIssues.push({
          rowIndex: row.rowIndex,
          message: "failed to write (database error)",
        });
      }
    }

    // Record the file. Fail-soft: the shipments are already written, and
    // losing the ledger row must not turn a successful import into an
    // error the operator retries.
    try {
      const supabase = getOrgScopedClient(orgId);
      const { error } = await supabase.from("pacware_shipment_imports").insert({
        org_id: orgId,
        file_hash: analysis.fileHash,
        mode: "commit",
        total_data_rows: analysis.totalDataRows,
        applied_count: applied,
        dispositions: counts,
        oldest_ship_date: analysis.oldestShipDate,
        newest_ship_date: analysis.newestShipDate,
        reimport_acknowledged: Boolean(acknowledgeReimport),
        imported_by_email: req.adminEmail ?? null,
      });
      if (error) throw error;
    } catch (err) {
      logger.warn(
        {
          event: "pacware.shipment_import_ledger_failed",
          errName: err instanceof Error ? err.name : "unknown",
        },
        "pacware/shipments: import succeeded but the ledger row was not written",
      );
    }

    await logAudit({
      action: "fulfillment.pacware_shipment_import",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fulfillments",
      targetId: null,
      metadata: {
        file_hash: analysis.fileHash,
        total_data_rows: analysis.totalDataRows,
        applied,
        unchanged,
        failed,
        exceptions_opened: exceptionsOpened,
        next_cycles_opened: nextCyclesOpened,
        oldest_ship_date: analysis.oldestShipDate,
        ...counts,
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      mode: "commit",
      fileHash: analysis.fileHash,
      totalDataRows: analysis.totalDataRows,
      applied,
      unchanged,
      failed,
      exceptionsOpened,
      nextCyclesOpened,
      dispositions: counts,
      errors: rowIssues.slice(0, 200),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /admin/pacware/import/shipments/report.csv — sanitized dispositions
// ---------------------------------------------------------------------------
//
// Separate endpoint rather than a field on the preview response, because
// the two have different audiences and different sizes: the preview is a
// summary a person reads on screen, and this is a file they work through
// line by line, filter in a spreadsheet, and attach to a ticket.
router.post(
  "/admin/pacware/import/shipments/report.csv",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsedBody = bodySchema
      .omit({ mode: true, acknowledgeReimport: true })
      .safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    let analysis: AnalyzedFile;
    try {
      analysis = await analyzeFile(
        orgId,
        parsedBody.data.csv,
        new Date(),
        parsedBody.data.maxBackdateDays,
      );
    } catch {
      res.status(503).json({ error: "lookup_failed" });
      return;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="pacware-shipment-dispositions-${analysis.fileHash.slice(0, 12)}.csv"`,
    );
    res.status(200).send(buildShipmentDispositionCsv(analysis.classified));
  },
);

// ---------------------------------------------------------------------------
// Ship-date correction exceptions
// ---------------------------------------------------------------------------

/**
 * Raise a ship-date conflict for a person.
 *
 * Returns false when one is already open for this fulfillment — the
 * partial unique index is the arbiter, so a repeated import of the same
 * conflicting file cannot queue the same decision ten times.
 */
async function openShipDateException(args: {
  orgId: string;
  fulfillmentId: string;
  proposedShippedAt: Date;
  claimId: string | null;
  raisedByEmail: string | null;
}): Promise<boolean> {
  const supabase = getOrgScopedClient(args.orgId);
  const { data: current, error: readErr } = await supabase
    .from("fulfillments")
    .select("shipped_at")
    .eq("id", args.fulfillmentId)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  const recorded = (current as { shipped_at: string | null } | null)
    ?.shipped_at;
  if (!recorded) return false;

  const { error } = await supabase.from("shipment_date_exceptions").insert({
    org_id: args.orgId,
    fulfillment_id: args.fulfillmentId,
    recorded_shipped_at: recorded,
    proposed_shipped_at: args.proposedShippedAt.toISOString(),
    claim_id: args.claimId,
    source: "pacware_import",
    status: "open",
    raised_by_email: args.raisedByEmail,
  });
  if (error) {
    // 23505 — an exception is already open for this fulfillment. That is
    // the index doing its job, not a failure.
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

router.get(
  "/admin/pacware/shipment-exceptions",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const status = req.query.status === "resolved" ? "resolved" : "open";
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("shipment_date_exceptions")
      .select(
        "id, fulfillment_id, recorded_shipped_at, proposed_shipped_at, claim_id, source, status, resolution, resolution_note, raised_by_email, resolved_by_email, resolved_at, created_at",
      )
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ status, exceptions: data ?? [] });
  },
);

const resolveBody = z
  .object({
    resolution: z.enum([
      "kept_recorded",
      "corrected",
      "duplicate_report",
      "invalid_report",
    ]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post(
  "/admin/pacware/shipment-exceptions/:id/resolve",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = resolveBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getOrgScopedClient(orgId);
    const { data: existing, error: readErr } = await supabase
      .from("shipment_date_exceptions")
      .select("id, fulfillment_id, proposed_shipped_at, status")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    const row = existing as {
      id: string;
      fulfillment_id: string;
      proposed_shipped_at: string;
      status: string;
    } | null;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "open") {
      res.status(409).json({ error: "already_resolved" });
      return;
    }

    // `corrected` is the ONE resolution that rewrites the ship date, and
    // it is a deliberate, attributed act — never something an import
    // does on its own. The claim it affects must be corrected separately;
    // this route does not touch it, because re-submitting a claim is a
    // billing decision with its own approval gate.
    if (body.data.resolution === "corrected") {
      const { error: updateErr } = await supabase
        .from("fulfillments")
        .update({
          shipped_at: row.proposed_shipped_at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.fulfillment_id);
      if (updateErr) throw updateErr;
    }

    const { error } = await supabase
      .from("shipment_date_exceptions")
      .update({
        status: "resolved",
        resolution: body.data.resolution,
        resolution_note: body.data.note ?? null,
        resolved_by_email: req.adminEmail ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id.data)
      .eq("status", "open");
    if (error) throw error;

    await logAudit({
      action: "fulfillment.ship_date_exception_resolved",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fulfillments",
      targetId: row.fulfillment_id,
      metadata: {
        exception_id: row.id,
        resolution: body.data.resolution,
      },
    });

    logger.info(
      {
        event: "resupply.ship_date_exception_resolved",
        orgId,
        exceptionId: row.id,
        resolution: body.data.resolution,
      },
      "pacware/shipments: ship-date exception resolved",
    );

    res.json({ resolved: true, resolution: body.data.resolution });
  },
);

export default router;

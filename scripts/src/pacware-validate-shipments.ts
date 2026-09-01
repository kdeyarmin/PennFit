#!/usr/bin/env tsx
//
// pacware:validate-shipments — check a REAL PacWare shipment report
// without importing it, without a database, and without the file ever
// leaving the operator's machine.
//
// WHY THIS EXISTS
// ---------------
// The import route can already preview. But a preview is an authenticated
// HTTP call against a live tenant, which means the first time anyone
// looks at a real PacWare export is inside production. That is the wrong
// order for a file format nobody in this repository has ever seen: a
// PacWare "shipment report" is whatever the operator's saved report
// happens to emit, and the only way to find out is to look at one.
//
// So: parse and classify locally, print a report that contains no patient
// data, and let the operator paste that into a validation ticket. Nothing
// is written anywhere. The file is read from the path given and is never
// copied, uploaded, or echoed.
//
//   pnpm --filter @workspace/scripts pacware:validate-shipments -- \
//     --file=/path/to/pacware-shipments.csv
//   pnpm --filter @workspace/scripts pacware:validate-shipments -- \
//     --file=… --json > validation-evidence.json
//
// WHAT IT CANNOT TELL YOU
// -----------------------
// Matching needs the tenant's fulfillments, and this has no database. So
// every parseable row that is not obviously invalid comes back
// `unmatched` — that is expected and is NOT a finding. What this DOES
// answer, which is what the first look needs:
//
//   * does the header map to the columns the importer knows?
//   * do the ship dates parse, and are any of them impossible?
//   * how many rows carry an episode id / order ref / patient+SKU?
//   * are there duplicate order lines, split shipments, cancelled rows?
//
// PHI: the report prints COUNTS, row NUMBERS, and category names. It
// never prints a cell value. `--show-headers` additionally prints the
// column HEADER labels, which are not patient data and are the single
// most useful thing when a report does not map — it is opt-in anyway.

import { readFileSync } from "node:fs";

import {
  classifyShipmentRows,
  computeShipmentFileHash,
  countDispositions,
  parsePacwareShipmentCsv,
  SHIPMENT_DISPOSITIONS,
  type ClassifiedShipmentRow,
} from "@workspace/resupply-integrations-pacware";

interface Args {
  file: string | null;
  json: boolean;
  showHeaders: boolean;
  maxBackdateDays: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    file: null,
    json: false,
    showHeaders: false,
    maxBackdateDays: undefined,
  };
  for (const raw of argv) {
    if (raw === "--json") args.json = true;
    else if (raw === "--show-headers") args.showHeaders = true;
    else if (raw.startsWith("--file=")) args.file = raw.slice("--file=".length);
    else if (raw.startsWith("--max-backdate-days=")) {
      const n = Number(raw.slice("--max-backdate-days=".length));
      if (Number.isInteger(n) && n > 0) args.maxBackdateDays = n;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error(
      "Usage: pacware:validate-shipments -- --file=/path/to/report.csv [--json] [--show-headers]\n\n" +
        "Reads the file, reports what the importer would make of it, and\n" +
        "writes nothing anywhere. The file is never copied or uploaded.\n",
    );
    process.exit(2);
  }

  let csv: string;
  try {
    csv = readFileSync(args.file, "utf8");
  } catch (err) {
    console.error(
      `Could not read ${args.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const parsed = parsePacwareShipmentCsv(csv);
  const now = new Date();

  // No database, so no candidates: every parseable row is `unmatched` by
  // construction. That is expected here and is not a finding.
  const rowIndexes = parsed.rows.map((_, i) => i + 1);
  const matches = parsed.rows.map((_, i) => ({
    rowIndex: i + 1,
    strategy: "unmatched" as const,
    fulfillmentId: null,
    alreadyRecorded: false,
    candidateIds: [],
  }));
  const classified = classifyShipmentRows({
    rows: parsed.rows,
    rowIndexes,
    matches,
    parseErrors: parsed.errors,
    now,
    maxBackdateDays: args.maxBackdateDays,
  });
  const counts = countDispositions(classified);

  // Which match key each row carries. This is what decides whether the
  // real import will resolve cleanly or fall back to patient+SKU.
  const keyCoverage = {
    withEpisodeId: parsed.rows.filter((r) => r.pennfitEpisodeId).length,
    withOrderRef: parsed.rows.filter((r) => r.pacwareOrderRef).length,
    withPatientAndSku: parsed.rows.filter((r) => r.pacwareId && r.itemSku)
      .length,
    withTracking: parsed.rows.filter((r) => r.trackingNumber).length,
    withDeliveredDate: parsed.rows.filter((r) => r.deliveredDate).length,
  };

  const splitLines = classified.filter((r) => r.lineOccurrences > 1);

  void computeShipmentFileHash(csv).then((fileHash) => {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            event: "pacware.shipment_file_validation",
            fileHash,
            validatedAt: now.toISOString(),
            totalDataRows: parsed.totalDataRows,
            parsedRows: parsed.rows.length,
            parseErrors: parsed.errors.length,
            unmappedHeaders: args.showHeaders
              ? (parsed.unmappedHeaders ?? [])
              : (parsed.unmappedHeaders ?? []).length,
            dispositions: counts,
            keyCoverage,
            splitOrDuplicateLines: splitLines.length,
            findings: buildFindings(parsed, counts, keyCoverage),
          },
          null,
          2,
        ),
      );
    } else {
      printHuman({
        file: args.file as string,
        fileHash,
        now,
        parsed,
        counts,
        keyCoverage,
        classified,
        showHeaders: args.showHeaders,
      });
    }

    const blocking = counts.invalid + counts.future_dated;
    process.exit(blocking > 0 ? 1 : 0);
  });
}

type ParsedResult = ReturnType<typeof parsePacwareShipmentCsv>;
type Counts = ReturnType<typeof countDispositions>;
type KeyCoverage = {
  withEpisodeId: number;
  withOrderRef: number;
  withPatientAndSku: number;
  withTracking: number;
  withDeliveredDate: number;
};

/** Operator-facing findings, phrased as what to do about them. */
function buildFindings(
  parsed: ParsedResult,
  counts: Counts,
  keys: KeyCoverage,
): string[] {
  const findings: string[] = [];
  if (parsed.totalDataRows === 0) {
    findings.push(
      "The file has no data rows. Check that the export includes a header row and at least one order.",
    );
  }
  if ((parsed.unmappedHeaders ?? []).length > 0) {
    findings.push(
      `${(parsed.unmappedHeaders ?? []).length} column(s) in this report do not map to any field the importer knows. They are ignored. Re-run with --show-headers to see which.`,
    );
  }
  if (counts.invalid > 0) {
    findings.push(
      `${counts.invalid} row(s) failed validation and would be skipped. See the per-row list.`,
    );
  }
  if (counts.future_dated > 0) {
    findings.push(
      `${counts.future_dated} row(s) carry a ship date in the future. A claim cannot carry a date of service that has not happened; these are never imported.`,
    );
  }
  if (counts.too_old > 0) {
    findings.push(
      `${counts.too_old} row(s) are past the timely-filing threshold. Expected on a first backfill; raise --max-backdate-days deliberately if that is what this is.`,
    );
  }
  if (counts.cancelled > 0) {
    findings.push(
      `${counts.cancelled} row(s) are marked cancelled or voided in the report and are never treated as a dispense.`,
    );
  }
  if (counts.duplicate > 0) {
    findings.push(
      `${counts.duplicate} row(s) repeat an order line already in this file — a split shipment, or a duplicated export. Only the first occurrence would be applied.`,
    );
  }
  if (keys.withEpisodeId === 0 && keys.withOrderRef === 0) {
    findings.push(
      "No row carries a PennFit episode id or a PacWare order reference, so every match will fall back to patient account + SKU + date. That works, but it is the weakest key and produces the most ambiguity. Adding the episode id from the resupply-due export to the PacWare order notes removes it.",
    );
  }
  return findings;
}

function printHuman(ctx: {
  file: string;
  fileHash: string;
  now: Date;
  parsed: ParsedResult;
  counts: Counts;
  keyCoverage: KeyCoverage;
  classified: ClassifiedShipmentRow[];
  showHeaders: boolean;
}): void {
  const { parsed, counts, keyCoverage } = ctx;
  console.log("PacWare shipment report — local validation");
  console.log("==========================================");
  console.log(`file          ${ctx.file}`);
  console.log(`sha256        ${ctx.fileHash}`);
  console.log(`validated at  ${ctx.now.toISOString()}`);
  console.log("");
  console.log(`data rows     ${parsed.totalDataRows}`);
  console.log(`parsed        ${parsed.rows.length}`);
  console.log(`parse errors  ${parsed.errors.length}`);
  console.log("");

  console.log("Match keys present");
  console.log(`  PennFit episode id   ${keyCoverage.withEpisodeId}`);
  console.log(`  PacWare order ref    ${keyCoverage.withOrderRef}`);
  console.log(`  patient + SKU        ${keyCoverage.withPatientAndSku}`);
  console.log(`  tracking number      ${keyCoverage.withTracking}`);
  console.log(`  delivered date       ${keyCoverage.withDeliveredDate}`);
  console.log("");

  console.log("Dispositions (offline — matching needs the tenant's data)");
  for (const d of SHIPMENT_DISPOSITIONS) {
    if (d === "unmatched") {
      console.log(
        `  ${d.padEnd(18)} ${String(counts[d]).padStart(6)}  (expected offline)`,
      );
    } else {
      console.log(`  ${d.padEnd(18)} ${String(counts[d]).padStart(6)}`);
    }
  }
  console.log("");

  if (ctx.showHeaders && (parsed.unmappedHeaders ?? []).length > 0) {
    console.log("Unmapped columns (ignored by the importer)");
    for (const h of parsed.unmappedHeaders ?? []) console.log(`  ${h}`);
    console.log("");
  }

  const problems = ctx.classified.filter(
    (r) =>
      r.disposition !== "unmatched" &&
      r.disposition !== "matched" &&
      r.disposition !== "already_recorded",
  );
  if (problems.length > 0) {
    console.log("Rows needing attention (row number + reason, no cell values)");
    for (const row of problems.slice(0, 100)) {
      console.log(
        `  row ${String(row.rowIndex).padStart(5)}  ${row.disposition.padEnd(14)} ${row.reason}`,
      );
    }
    if (problems.length > 100) {
      console.log(`  … and ${problems.length - 100} more`);
    }
    console.log("");
  }

  const findings = buildFindings(parsed, counts, keyCoverage);
  if (findings.length > 0) {
    console.log("Findings");
    for (const f of findings) console.log(`  - ${f}`);
    console.log("");
  }

  console.log(
    "Nothing was written and the file was not copied anywhere. This output\n" +
      "contains no patient data and is safe to attach to a validation ticket.",
  );
}

main();

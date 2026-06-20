// Pure parser for the CMS DMEPOS Fee Schedule public-use file (the
// `DMEPOS<YY>_<MON>.csv` grid CMS publishes quarterly).
//
// Layout (verified against the live CY2026 file, Attachment A-1):
//   * ~7 banner/blank rows precede a header row whose first cell is "HCPCS".
//   * Header: HCPCS, Mod, Mod2, JURIS, CATG, Ceiling, Floor, then 52
//     states/territories as a NON-RURAL then RURAL pair — e.g. "PA (NR)",
//     "PA (R)" — then a trailing "Description".
//   * One row per (HCPCS, Mod, Mod2); the per-state fee lives in that
//     state's column. Amounts are plain decimal dollars; "0.00" means "not
//     applicable" (capped-rental ceilings, special pricing), not free.
//   * The pricing amount is the NON-RURAL column unless the patient's ZIP is
//     rural (caller's choice via `rural`).
//
// Header-DRIVEN (never positional): column counts have grown across years,
// so we locate the state's NR/R column by header name. No I/O — the caller
// reads the upload and persists the result. Unit-tested directly.

export interface CmsFeeScheduleRow {
  /** HCPCS Level II code, uppercased (e.g. "E0601"). */
  hcpcs: string;
  /** 1st modifier (e.g. "RR"/"NU"); null when blank. */
  modifier: string | null;
  /** 2nd modifier; null when blank. */
  modifier2: string | null;
  /** The selected (non-rural or rural) allowed amount, in cents (> 0). */
  allowedCents: number;
}

export interface ParseCmsFeeScheduleOptions {
  /** Two-letter USPS state, e.g. "PA". */
  state: string;
  /** Use the rural "(R)" column instead of non-rural "(NR)". Default false. */
  rural?: boolean;
}

export interface CmsFeeScheduleParseResult {
  rows: CmsFeeScheduleRow[];
  /** Non-fatal notes (missing column, skipped rows). */
  warnings: string[];
}

/** Parse one CSV line into cells, honouring `"`-quoted fields and `""`
 *  escapes. The CMS file has no embedded newlines in fields, so per-line
 *  parsing is safe (and streams a 20 MB file without a full-doc parser). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Normalise a header cell for matching: collapse whitespace, uppercase. */
function normHeader(cell: string): string {
  return cell.replace(/\s+/g, " ").trim().toUpperCase();
}

/** Decimal dollars → integer cents, or null for blank / zero / unparseable.
 *  "0.00" is CMS's "not applicable" sentinel, not a real $0 allowable. */
function feeToCents(raw: string | undefined): number | null {
  const s = (raw ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

function cleanModifier(raw: string | undefined): string | null {
  const m = (raw ?? "").trim().toUpperCase();
  return m.length > 0 ? m : null;
}

/** HCPCS Level II: one letter + four digits (E0601, A7032, K0108). */
const HCPCS_RE = /^[A-Z]\d{4}$/;

/**
 * Parse the CMS DMEPOS fee-schedule CSV grid for a single state, returning
 * one row per (HCPCS, modifier, modifier2) with the selected fee in cents.
 * Rows with a missing/zero fee for the chosen column are skipped (counted in
 * `warnings`). A missing header or state column returns an empty result with
 * an explanatory warning rather than throwing.
 */
export function parseCmsDmeposFeeScheduleCsv(
  content: string,
  opts: ParseCmsFeeScheduleOptions,
): CmsFeeScheduleParseResult {
  const state = opts.state.trim().toUpperCase();
  const want = normHeader(`${state} (${opts.rural ? "R" : "NR"})`);
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);

  // Locate the header row (skips the banner rows above it).
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (normHeader(parseCsvLine(lines[i]!)[0] ?? "") === "HCPCS") {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      rows: [],
      warnings: ['header row (first cell "HCPCS") not found'],
    };
  }

  const header = parseCsvLine(lines[headerIdx]!).map(normHeader);
  const hcpcsIdx = header.indexOf("HCPCS");
  const modIdx = header.indexOf("MOD");
  const mod2Idx = header.indexOf("MOD2");
  const feeIdx = header.indexOf(want);
  if (feeIdx === -1) {
    return {
      rows: [],
      warnings: [
        `fee column "${state} (${opts.rural ? "R" : "NR"})" not found`,
      ],
    };
  }

  const rows: CmsFeeScheduleRow[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const cells = parseCsvLine(lines[i]!);
    if (cells.length <= feeIdx) {
      skipped++;
      continue;
    }
    const hcpcs = (cells[hcpcsIdx] ?? "").trim().toUpperCase();
    if (!HCPCS_RE.test(hcpcs)) {
      skipped++;
      continue;
    }
    const allowedCents = feeToCents(cells[feeIdx]);
    if (allowedCents == null) {
      skipped++;
      continue;
    }
    rows.push({
      hcpcs,
      modifier: cleanModifier(modIdx >= 0 ? cells[modIdx] : undefined),
      modifier2: cleanModifier(mod2Idx >= 0 ? cells[mod2Idx] : undefined),
      allowedCents,
    });
  }
  if (skipped > 0) {
    warnings.push(
      `${skipped} row(s) skipped (blank, non-HCPCS, or no ${state} (${
        opts.rural ? "R" : "NR"
      }) fee)`,
    );
  }
  return { rows, warnings };
}

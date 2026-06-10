// Minimal, dependency-free CSV reader + writer for the PacWare
// file-exchange surface.
//
// Why hand-rolled and not papaparse:
//   This package is the *shared contract* between the API (server,
//   Node) and any future browser caller. Keeping it dependency-free
//   (only `zod`) means it imports cleanly into both runtimes with no
//   `node:`-only modules and no bundler surprises. The grammar we need
//   is small and well-specified (RFC 4180), so a focused reader is
//   safer than pulling a parser whose options drift between callers.
//
// The reader handles the parts of RFC 4180 that real DME exports hit:
//   * quoted fields containing commas, quotes (doubled: "") and newlines,
//   * CRLF / LF / lone-CR line endings,
//   * a leading UTF-8 BOM (Excel on Windows emits one),
//   * a trailing newline (ignored — does not yield a phantom empty row).
//
// PHI posture: this module never logs. Callers own audit/logging and
// must keep cell values (which are patient data on the import side) out
// of any logger — see the route layer.

/**
 * Parse CSV text into a matrix of string cells. Empty input (or input
 * that is only a BOM / whitespace) yields an empty array. The first
 * returned row is whatever the source put first — header handling is the
 * caller's job (see {@link parsePacwarePatientCsv} in parse.ts).
 */
export function parseCsv(input: string): string[][] {
  // Strip a leading UTF-8 BOM if present.
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAnyChar = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Normalise CRLF: skip the LF that follows a CR.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    field += ch;
  }
  // Flush the final field/row unless the file ended exactly on a newline
  // (in which case `sawAnyChar` is false and there is nothing pending).
  if (sawAnyChar || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Encode a single value as a safe CSV cell. Combines RFC 4180 quoting
 * with spreadsheet formula-injection neutralisation (Excel / Sheets /
 * Numbers evaluate a cell that begins with `=`, `+`, `-`, `@`, or a
 * leading tab/CR as a formula). Mirrors
 * artifacts/resupply-api/src/lib/safe-csv-cell.ts — kept here too so the
 * package has no dependency on the API artifact and every PacWare export
 * gets the guard for free.
 */
export function safeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = "[unserialisable]";
    }
  } else {
    s = String(value);
  }
  // Guard a leading trigger char — and ALSO a leading apostrophe-run
  // ending in a trigger char (e.g. a genuine stored value `'=note`).
  // Without the second case such a value exports verbatim and then
  // loses its apostrophe to stripCsvFormulaGuard on re-import; with
  // it, export adds one apostrophe and import strips exactly one, so
  // the round trip is lossless for every value class. (This is the
  // one deliberate divergence from the API-side safe-csv-cell.ts
  // mirror, which has no paired importer.)
  if (/^'*[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialise a header row + record rows to CRLF-terminated CSV text.
 * CRLF is the RFC 4180 line ending and the one PacWare's importer (a
 * Windows client-server app) expects. Every cell is run through
 * {@link safeCsvCell}.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly unknown[][],
): string {
  const lines: string[] = [];
  lines.push(header.map((h) => safeCsvCell(h)).join(","));
  for (const r of rows) {
    lines.push(r.map((c) => safeCsvCell(c)).join(","));
  }
  // Trailing CRLF so the file ends on a clean record boundary.
  return lines.join("\r\n") + "\r\n";
}

/** Normalise a header label for alias matching: lowercase, alphanumerics only. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reverse {@link safeCsvCell}'s formula-injection guard on import: strip a
 * single leading apostrophe when it immediately precedes a formula-trigger
 * char (`= + - @` / tab / CR). This is what makes a PennFit export
 * round-trip losslessly — without it, an E.164 phone "+14155551212"
 * exported as the spreadsheet-safe "'+14155551212" would fail re-import.
 *
 * It is deliberately surgical: a leading apostrophe NOT eventually
 * followed by a trigger char (a genuine value like "'tis") is left
 * untouched, so real data is never mangled. An apostrophe-run ending
 * in a trigger ("''=x") loses exactly ONE apostrophe — the inverse of
 * safeCsvCell, which adds exactly one to any such run.
 */
export function stripCsvFormulaGuard(value: string): string {
  if (/^'+[=+\-@\t\r]/.test(value)) return value.slice(1);
  return value;
}

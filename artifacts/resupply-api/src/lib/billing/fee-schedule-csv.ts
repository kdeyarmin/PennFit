// CSV bulk import / export for payer_fee_schedules.
//
// Format (header row required):
//
//   hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes
//   E0601,RR,12235,2026-01-01,,cms_published,Medicare DME 2026 fee
//   E0601,RR,12500,2026-01-01,,payer_published,Highmark commercial 2026
//
// Behavior:
//   * Lines with whitespace-only / empty first column are skipped.
//   * Bad rows are returned in `errors[]` but DO NOT block the rest.
//   * Each accepted row is inserted (no upsert — operators close
//     prior rows manually by setting effective_through; see
//     migration 0129 commentary).

import type { Database } from "@workspace/resupply-db";

import { logger } from "../logger";

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MOD_CSV_RE = /^([A-Z0-9]{2})(,[A-Z0-9]{2})*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_VALUES = new Set([
  "manual",
  "cms_published",
  "payer_published",
  "observed",
]);

type FeeRow = Database["resupply"]["Tables"]["payer_fee_schedules"]["Insert"];

export interface ImportInput {
  payerProfileId: string;
  csvBody: string;
  /** Maximum rows we accept in one upload. */
  maxRows?: number;
}

export interface ImportResult {
  accepted: number;
  errors: Array<{ row: number; reason: string }>;
}

export function parseFeeScheduleCsv(input: ImportInput): {
  rows: FeeRow[];
  errors: ImportResult["errors"];
} {
  const max = input.maxRows ?? 5000;
  const rows: FeeRow[] = [];
  const errors: ImportResult["errors"] = [];
  const lines = input.csvBody.split(/\r?\n/);
  if (lines.length === 0) return { rows, errors };
  // Pop the header row; reject if columns are wrong.
  const header = lines[0]?.toLowerCase().split(",").map((s) => s.trim()) ?? [];
  const expected = [
    "hcpcs_code",
    "modifier",
    "allowed_cents",
    "effective_from",
    "effective_through",
    "source",
    "notes",
  ];
  for (const col of expected) {
    if (!header.includes(col)) {
      errors.push({
        row: 0,
        reason: `header missing required column: ${col}`,
      });
      return { rows, errors };
    }
  }
  const idx: Record<string, number> = {};
  for (const col of expected) idx[col] = header.indexOf(col);

  for (let i = 1; i < lines.length && rows.length < max; i++) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    const cells = parseCsvLine(raw);
    const hcpcsRaw = (cells[idx.hcpcs_code!] ?? "").trim().toUpperCase();
    if (!hcpcsRaw) continue;
    if (!HCPCS_RE.test(hcpcsRaw)) {
      errors.push({ row: i + 1, reason: `invalid HCPCS: ${hcpcsRaw}` });
      continue;
    }
    const modifierRaw = (cells[idx.modifier!] ?? "").trim().toUpperCase();
    if (modifierRaw && !MOD_CSV_RE.test(modifierRaw)) {
      errors.push({
        row: i + 1,
        reason: `invalid modifier CSV: ${modifierRaw}`,
      });
      continue;
    }
    const allowedRaw = (cells[idx.allowed_cents!] ?? "").trim();
    const allowedCents = Number.parseInt(allowedRaw, 10);
    if (!Number.isInteger(allowedCents) || allowedCents < 0) {
      errors.push({
        row: i + 1,
        reason: `invalid allowed_cents: ${allowedRaw}`,
      });
      continue;
    }
    const effFromRaw = (cells[idx.effective_from!] ?? "").trim();
    if (!ISO_DATE_RE.test(effFromRaw)) {
      errors.push({
        row: i + 1,
        reason: `invalid effective_from: ${effFromRaw}`,
      });
      continue;
    }
    const effThroughRaw = (cells[idx.effective_through!] ?? "").trim();
    if (effThroughRaw && !ISO_DATE_RE.test(effThroughRaw)) {
      errors.push({
        row: i + 1,
        reason: `invalid effective_through: ${effThroughRaw}`,
      });
      continue;
    }
    if (effThroughRaw && effThroughRaw < effFromRaw) {
      errors.push({
        row: i + 1,
        reason: "effective_through must be on or after effective_from",
      });
      continue;
    }
    const sourceRaw = (cells[idx.source!] ?? "manual").trim();
    if (!SOURCE_VALUES.has(sourceRaw)) {
      errors.push({
        row: i + 1,
        reason: `invalid source: ${sourceRaw}`,
      });
      continue;
    }
    const notesRaw = (cells[idx.notes!] ?? "").trim();
    rows.push({
      payer_profile_id: input.payerProfileId,
      hcpcs_code: hcpcsRaw,
      modifier: modifierRaw || null,
      allowed_cents: allowedCents,
      effective_from: effFromRaw,
      effective_through: effThroughRaw || null,
      source:
        sourceRaw as Database["resupply"]["Tables"]["payer_fee_schedules"]["Row"]["source"],
      notes: notesRaw || null,
    });
  }
  if (lines.length - 1 > max) {
    errors.push({
      row: max + 1,
      reason: `truncated at maxRows=${max}; ${lines.length - 1 - max} rows ignored`,
    });
  }
  void logger;
  return { rows, errors };
}

function parseCsvLine(line: string): string[] {
  // Minimal CSV parser supporting double-quoted fields with escaped
  // quotes (""). We don't ship Papa Parse for this — the format is
  // controlled by ops, the column set is fixed, and a one-purpose
  // parser stays auditable in 25 lines.
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        buf += ch;
      }
    } else {
      if (ch === ",") {
        out.push(buf);
        buf = "";
      } else if (ch === '"') {
        inQuote = true;
      } else {
        buf += ch;
      }
    }
  }
  out.push(buf);
  return out;
}

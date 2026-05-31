// Pure CSV parser for the product-cost seed (scripts/src/seed-product-costs.ts).
//
// Kept separate from the self-executing seed script so the parsing +
// validation rules are unit-testable without a DB, a file, or argv.
//
// Expected columns (a header row is optional and auto-skipped):
//   sku,unit_cost_cents,cost_source,notes
//   - unit_cost_cents : integer CENTS, not dollars (4200 = $42.00).
//   - cost_source     : manual | invoice | catalog | estimate
//                       (default "catalog" — this is a bulk sheet import).
//   - notes           : free text; it's the LAST column so it may contain
//                       commas (the remaining cells are re-joined).

const SKU_RE = /^[A-Za-z0-9._-]+$/;
const COST_SOURCES = new Set(["manual", "invoice", "catalog", "estimate"]);
const MAX_COST_CENTS = 100_000_000; // $1,000,000.00 dollars-vs-cents guard

export interface ParsedProductCost {
  sku: string;
  unitCostCents: number;
  costSource: string;
  notes: string | null;
}

export interface ProductCostParseError {
  /** 1-based line number in the input. */
  line: number;
  message: string;
}

export interface ProductCostParseResult {
  rows: ParsedProductCost[];
  errors: ProductCostParseError[];
}

/**
 * Parse a cost-sheet CSV into validated rows + per-line errors. A bad
 * row is reported and excluded (never silently coerced) so the seed can
 * write the good rows and surface the rest for the operator to fix.
 */
export function parseProductCostCsv(text: string): ProductCostParseResult {
  const rows: ParsedProductCost[] = [];
  const errors: ProductCostParseError[] = [];

  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (rawLine.trim() === "") return; // skip blank lines

    const cells = rawLine.split(",");
    const sku = (cells[0] ?? "").trim();

    // Auto-skip a header row (first line whose first cell is "sku").
    if (lineNo === 1 && sku.toLowerCase() === "sku") return;

    if (sku === "") {
      errors.push({ line: lineNo, message: "missing sku" });
      return;
    }
    if (sku.length > 64 || !SKU_RE.test(sku)) {
      errors.push({ line: lineNo, message: `invalid sku "${sku}"` });
      return;
    }

    const costRaw = (cells[1] ?? "").trim();
    if (costRaw === "") {
      errors.push({
        line: lineNo,
        message: `missing unit_cost_cents for "${sku}"`,
      });
      return;
    }
    if (!/^\d+$/.test(costRaw)) {
      errors.push({
        line: lineNo,
        message: `unit_cost_cents must be a whole number of cents for "${sku}" (got "${costRaw}")`,
      });
      return;
    }
    const unitCostCents = Number(costRaw);
    if (
      !Number.isSafeInteger(unitCostCents) ||
      unitCostCents > MAX_COST_CENTS
    ) {
      errors.push({
        line: lineNo,
        message: `unit_cost_cents out of range for "${sku}"`,
      });
      return;
    }

    const sourceRaw = (cells[2] ?? "").trim().toLowerCase();
    const costSource = sourceRaw === "" ? "catalog" : sourceRaw;
    if (!COST_SOURCES.has(costSource)) {
      errors.push({
        line: lineNo,
        message: `invalid cost_source "${sourceRaw}" for "${sku}" (expected manual|invoice|catalog|estimate)`,
      });
      return;
    }

    // notes is the last column; re-join the remainder so commas survive.
    const notesRaw = cells.slice(3).join(",").trim();
    rows.push({
      sku,
      unitCostCents,
      costSource,
      notes: notesRaw === "" ? null : notesRaw,
    });
  });

  return { rows, errors };
}

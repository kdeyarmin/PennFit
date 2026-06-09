// Code 128 (subset B) decoder — the inverse of code128.ts.
//
// Used by the inbound-fax barcode fast-path (lib/inbound-fax/barcode-decode)
// to read the signature-tracking code off a returned fax deterministically,
// before falling back to the (paid, AI) vision scan. Pure module — no I/O,
// no image deps, no PHI. Operates on a single binarized scanline (one row
// of pixels reduced to bar/space booleans); the image rasterizing +
// thresholding lives in the caller.
//
// It shares the symbol tables with the encoder (PATTERNS / START_B / STOP /
// MIN_CHAR are imported, not re-declared) so the two can never drift, and
// it validates the mod-103 checksum + Start/Stop framing so a misread row
// returns null rather than a wrong code.

import { MIN_CHAR, PATTERNS, START_B, STOP } from "./code128";

/** pattern string ("212222", …) → symbol value (0..106). */
const VALUE_BY_PATTERN: ReadonlyMap<string, number> = new Map(
  PATTERNS.map((pattern, value) => [pattern, value]),
);

const STOP_PATTERN = PATTERNS[STOP]!; // "2331112"
const SYMBOL_RUNS = 6; // a data/start symbol is 6 runs / 11 modules
const SYMBOL_MODULES = 11;
const STOP_RUNS = 7; // the stop bar is 7 runs / 13 modules
const STOP_MODULES = 13;
const HIGHEST_SET_B_CHAR_VALUE = 94; // value 94 → '~'; 95+ are FNC/shift/codes
/** Generous cap so a noisy row can't spin forever (our codes are ~12 chars). */
const MAX_SYMBOLS = 80;

interface Run {
  bar: boolean;
  len: number;
}

/** Collapse a binarized row (true = dark/bar) into alternating runs. */
function toRuns(row: readonly boolean[]): Run[] {
  const runs: Run[] = [];
  for (const bar of row) {
    const last = runs[runs.length - 1];
    if (last && last.bar === bar) last.len += 1;
    else runs.push({ bar, len: 1 });
  }
  return runs;
}

/**
 * Quantize `lens` run lengths into integer module widths (1..4) that sum to
 * exactly `totalModules`. Uses largest-remainder rounding so a jittery scan
 * (bars never land on perfect pixel multiples) still resolves, and returns
 * null when it can't make the widths sum correctly within the 1..4 bounds —
 * which rejects noise rather than guessing.
 */
function quantize(lens: number[], totalModules: number): number[] | null {
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const moduleWidth = total / totalModules;
  const ideal = lens.map((l) => l / moduleWidth);
  const mods = ideal.map((x) => Math.min(4, Math.max(1, Math.round(x))));
  let diff = totalModules - mods.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    // Adjust the runs with the largest rounding residual first, in the
    // direction that closes the gap, staying within the 1..4 module bounds.
    const order = ideal
      .map((x, i) => ({ i, residual: x - Math.round(x) }))
      .sort((a, b) =>
        diff > 0 ? b.residual - a.residual : a.residual - b.residual,
      );
    for (const { i } of order) {
      if (diff === 0) break;
      const next = mods[i]! + (diff > 0 ? 1 : -1);
      if (next >= 1 && next <= 4) {
        mods[i] = next;
        diff += diff > 0 ? -1 : 1;
      }
    }
    if (diff !== 0) return null;
  }
  return mods;
}

/** True when the 7 runs starting at `pos` are the Code 128 Stop bar. */
function matchesStop(runs: Run[], pos: number): boolean {
  if (pos + STOP_RUNS > runs.length) return false;
  if (!runs[pos]!.bar) return false; // stop is bar-first
  const mods = quantize(
    runs.slice(pos, pos + STOP_RUNS).map((r) => r.len),
    STOP_MODULES,
  );
  return mods !== null && mods.join("") === STOP_PATTERN;
}

/** Decode runs left-to-right. Returns the payload string or null. */
function decodeForward(runs: Run[]): string | null {
  const startIdx = runs.findIndex((r) => r.bar);
  if (startIdx < 0) return null;

  const values: number[] = [];
  let pos = startIdx;
  let stopFound = false;
  for (let guard = 0; guard < MAX_SYMBOLS; guard += 1) {
    if (matchesStop(runs, pos)) {
      stopFound = true;
      break;
    }
    if (pos + SYMBOL_RUNS > runs.length) break;
    if (!runs[pos]!.bar) return null; // a symbol must start on a bar
    const mods = quantize(
      runs.slice(pos, pos + SYMBOL_RUNS).map((r) => r.len),
      SYMBOL_MODULES,
    );
    if (!mods) return null;
    const value = VALUE_BY_PATTERN.get(mods.join(""));
    if (value === undefined) return null;
    values.push(value);
    pos += SYMBOL_RUNS;
  }

  // Need Start + ≥1 data + checksum, and the symbol must have been
  // terminated by a real Stop bar.
  if (!stopFound || values.length < 2 || values[0] !== START_B) return null;

  const checksum = values[values.length - 1]!;
  const data = values.slice(1, values.length - 1);
  let sum = START_B;
  for (let i = 0; i < data.length; i += 1) sum += data[i]! * (i + 1);
  if (sum % 103 !== checksum) return null;

  let out = "";
  for (const v of data) {
    // Our tracking codes are plain set-B text; reject any control / shift /
    // code-set symbol (95+) rather than emit a bogus character.
    if (v < 0 || v > HIGHEST_SET_B_CHAR_VALUE) return null;
    out += String.fromCharCode(v + MIN_CHAR);
  }
  return out;
}

/**
 * Decode a Code 128 (set B) payload from one binarized scanline, where
 * `row[i] === true` means that pixel is dark (a bar). Tries the row in both
 * directions (a fax may be scanned/placed reversed) and returns the decoded
 * string, or null if the row carries no valid Code 128 symbol.
 */
export function decodeCode128FromBinaryRow(
  row: readonly boolean[],
): string | null {
  const forward = decodeForward(toRuns(row));
  if (forward !== null) return forward;
  return decodeForward(toRuns([...row].reverse()));
}

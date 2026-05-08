#!/usr/bin/env node
// Print a sorted size report of the production cpap-fitter build.
//
// Why this exists
// ---------------
// The fitter is the largest customer-facing surface in the
// workspace and ships everything in front of patients on first
// click — onboarding wizard, chat widget, MediaPipe vision runtime,
// shop catalog, account dashboard, admin console. Without an easy
// way to see "which chunks are large, and which packages are
// driving them" we can't tell whether a new dependency added 12 KB
// or 1.2 MB.
//
// We deliberately do NOT pull in rollup-plugin-visualizer here.
// That plugin is great but adds a build-step dependency and a
// non-trivial maintenance surface (HTML output, ESM/CJS
// peer-version pins, treemap config). For the recurring "is this
// chunk an outlier?" question, sorted byte counts off the existing
// dist/public/ tree are enough.
//
// Output
// ------
// Two sections:
//   1. Top-N chunks by gzipped size — the metric your customers
//      actually pay for over the wire.
//   2. Per-asset-type totals (js / css / images / wasm / etc) —
//      the headline number to track on a budget gate later.
//
// Usage
// -----
//   pnpm --filter @workspace/cpap-fitter run bundle-report
//
// or directly:
//   node ./scripts/bundle-report.mjs
//
// Pre-requisite: a fresh `pnpm build` so dist/public/ exists.

import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "dist", "public");
const TOP_N = 20;

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(
        `bundle-report: ${dir} does not exist. Run \`pnpm build\` first.`,
      );
      process.exit(2);
    }
    throw err;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(1).padStart(8)} KB`;
}

function categoryFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".css") return "css";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"].includes(ext))
    return "image";
  if (ext === ".wasm") return "wasm";
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(ext)) return "font";
  if (ext === ".html") return "html";
  if (ext === ".map") return "sourcemap";
  return "other";
}

const files = await walk(ROOT);

const records = files.map((f) => {
  const buf = readFileSync(f);
  const gzipped = categoryFor(f) === "image" ? buf.length : gzipSync(buf).length;
  const stat = statSync(f);
  return {
    relPath: path.relative(ROOT, f),
    raw: stat.size,
    gzipped,
    category: categoryFor(f),
  };
});

records.sort((a, b) => b.gzipped - a.gzipped);

console.log(`\nbundle-report: ${ROOT}`);
console.log(`(gzipped sizes for js/css; raw for images/fonts/wasm)\n`);

console.log(`Top ${TOP_N} chunks by transfer size:`);
console.log(
  `${"size".padStart(11)}  ${"raw".padStart(11)}  type  path`,
);
console.log("-".repeat(80));
for (const r of records.slice(0, TOP_N)) {
  console.log(
    `${fmtKb(r.gzipped)}  ${fmtKb(r.raw)}  ${r.category.padEnd(4)}  ${r.relPath}`,
  );
}

console.log(`\nTotals by asset type (transfer size):`);
const totals = new Map();
for (const r of records) {
  const cur = totals.get(r.category) ?? { count: 0, bytes: 0 };
  cur.count += 1;
  cur.bytes += r.gzipped;
  totals.set(r.category, cur);
}
const totalsSorted = Array.from(totals.entries()).sort(
  (a, b) => b[1].bytes - a[1].bytes,
);
for (const [cat, agg] of totalsSorted) {
  console.log(
    `${fmtKb(agg.bytes)}  ${String(agg.count).padStart(4)} files  ${cat}`,
  );
}

const grand = records.reduce((s, r) => s + r.gzipped, 0);
console.log(`\nTotal transfer size: ${fmtKb(grand)} across ${records.length} files`);

// Bundle-size budget. A single JS chunk over `HEAVY_CHUNK_GZIP_KB`
// gzipped is treated as a failure unless `--no-fail` is passed (or
// `BUNDLE_REPORT_NO_FAIL=1` is set). The 500 KB ceiling is generous
// — react + react-dom alone is ~140 KB gzipped, so a single chunk
// breaching this means a vendor or page module has bloomed and is
// worth investigating before merge.
//
// Why a CLI flag and an env var both: developers running locally
// against a known-heavy work-in-progress branch want a quick way to
// suppress the failure; CI explicitly does NOT pass the flag so the
// gate stays on by default.
const HEAVY_CHUNK_GZIP_KB = 500;
const noFail =
  process.argv.includes("--no-fail") ||
  process.env["BUNDLE_REPORT_NO_FAIL"] === "1";
const heavy = records.filter(
  (r) => r.category === "js" && r.gzipped / 1024 > HEAVY_CHUNK_GZIP_KB,
);
if (heavy.length > 0) {
  console.log(
    `\n${noFail ? "WARN" : "FAIL"}: ${heavy.length} JS chunk(s) > ${HEAVY_CHUNK_GZIP_KB} KB gzipped:`,
  );
  for (const r of heavy) {
    console.log(`  ${fmtKb(r.gzipped)}  ${r.relPath}`);
  }
  if (!noFail) {
    console.log(
      `\nIf this is intentional, re-run with --no-fail (or set BUNDLE_REPORT_NO_FAIL=1).`,
    );
    process.exit(1);
  }
}

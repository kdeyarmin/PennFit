#!/usr/bin/env node
//
// Fail a Playwright run that SKIPPED tests when none were meant to skip.
//
// Why this exists: several storefront specs stub the
// @mediapipe/tasks-vision ES module, which only works against the unbundled
// Vite dev server. Under `vite preview` the module is bundled, the stub never
// intercepts, and those specs call `test.skip()` — Playwright then exits 0.
// That silent pass is the exact failure this PR set out to close: three specs
// sat in no CI job for months while everything looked green.
//
// The `e2e-dev` job runs against `vite dev`, where every spec's harness
// requirement is satisfied, so a skip there is never expected. It means the
// harness broke (Vite started prebundling the module, the fitter stopped
// requesting it, a guard regressed) — and without this check the job would
// keep reporting success while covering less and less.
//
// Usage: node scripts/ci/assert-no-skipped-tests.mjs <results.json> [--min N]
//   --min N  also require at least N tests to have run (guards a filter or
//            config change that silently narrows the suite to nothing).
//
// Self-test: node scripts/ci/assert-no-skipped-tests.mjs --self-test

import { readFileSync } from "node:fs";

/** Walk the nested suite tree and yield every test with its spec title. */
function collectTests(node, out = []) {
  for (const spec of node.specs ?? []) {
    for (const test of spec.tests ?? []) {
      out.push({ title: spec.title, file: spec.file ?? node.file, test });
    }
  }
  for (const child of node.suites ?? []) collectTests(child, out);
  return out;
}

export function analyze(report) {
  const tests = collectTests(report);
  // The JSON reporter's per-test `status` is the run-level verdict:
  // "expected" | "unexpected" | "flaky" | "skipped".
  const skipped = tests.filter((t) => t.test.status === "skipped");
  return { total: tests.length, skipped };
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(
      "usage: assert-no-skipped-tests.mjs <results.json> [--min N]",
    );
    return 2;
  }
  const minIdx = argv.indexOf("--min");
  const min = minIdx === -1 ? 0 : Number(argv[minIdx + 1] ?? 0);

  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // A missing/!unparseable report is itself a failure: the run did not
    // produce the evidence we gate on.
    console.error(`could not read Playwright JSON report at ${file}: ${err}`);
    return 1;
  }

  const { total, skipped } = analyze(report);

  if (skipped.length > 0) {
    console.error(
      `\n${skipped.length} test(s) SKIPPED in a job where nothing should skip:\n`,
    );
    for (const s of skipped) console.error(`  - ${s.file ?? "?"} › ${s.title}`);
    console.error(
      "\nAgainst the dev server every spec's harness requirement is met, so a\n" +
        "skip means the harness broke — most likely the @mediapipe/tasks-vision\n" +
        "module stub no longer intercepts. Fix the harness; do not silence this.\n",
    );
    return 1;
  }

  if (total < min) {
    console.error(
      `only ${total} test(s) ran, expected at least ${min}. ` +
        "A filter or config change has narrowed the suite.",
    );
    return 1;
  }

  console.log(`assert-no-skipped-tests: OK — ${total} ran, 0 skipped.`);
  return 0;
}

function selfTest() {
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
      console.error(`self-test FAILED: ${label}\n  got  ${g}\n  want ${w}`);
      process.exit(1);
    }
  };

  // Flat suite, all good.
  eq(
    analyze({
      suites: [
        {
          file: "a.spec.ts",
          specs: [{ title: "one", tests: [{ status: "expected" }] }],
        },
      ],
    }),
    { total: 1, skipped: [] },
    "flat, no skips",
  );

  // Nested suites are walked, and a skip is caught.
  const nested = analyze({
    suites: [
      {
        file: "b.spec.ts",
        specs: [{ title: "outer", tests: [{ status: "expected" }] }],
        suites: [
          {
            file: "b.spec.ts",
            specs: [{ title: "inner", tests: [{ status: "skipped" }] }],
          },
        ],
      },
    ],
  });
  eq(nested.total, 2, "nested total");
  eq(
    nested.skipped.map((s) => s.title),
    ["inner"],
    "nested skip detected",
  );

  // Flaky/unexpected are not skips — the run's own exit code covers those.
  eq(
    analyze({
      suites: [
        {
          file: "c.spec.ts",
          specs: [
            { title: "f", tests: [{ status: "flaky" }] },
            { title: "u", tests: [{ status: "unexpected" }] },
          ],
        },
      ],
    }).skipped,
    [],
    "flaky/unexpected are not skips",
  );

  // An empty report is zero tests, not a crash.
  eq(analyze({}), { total: 0, skipped: [] }, "empty report");

  console.log("assert-no-skipped-tests --self-test: OK");
  return 0;
}

process.exit(main(process.argv.slice(2)));

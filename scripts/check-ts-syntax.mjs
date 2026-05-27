#!/usr/bin/env node
// Syntactically parses a list of TypeScript/TSX files and reports any
// SYNTAX errors (no type checking). Designed to be called from the
// pre-commit hook against staged .ts/.tsx files so that classes of
// bugs like the one in Task #81 — a `useGetReminderSubscription(params,
// { ... )` call missing the closing `}` for the options object — get
// caught locally in milliseconds instead of at workflow build time
// minutes later, where TS1136 ("Property assignment expected") shows
// up as a cryptic "Unexpected token".
//
// Why a hand-rolled script and not `tsc --noEmit`:
//   - `tsc --noEmit` on a single artifact (e.g. cpap-fitter) takes
//     5–15s because it has to load the entire project + lib types.
//     For a pre-commit hook that runs on every commit, that's too
//     slow; developers will start using --no-verify to escape it,
//     which defeats the purpose.
//   - Parsing with `ts.createSourceFile` is purely syntactic — it
//     doesn't load lib types, doesn't resolve imports, doesn't run
//     the type checker — so it's ~10ms per file. Fast enough that
//     we can run it on every staged TS/TSX file with no perceivable
//     delay.
//   - Syntax errors (TS1xxx) are exactly the class of bug this task
//     is about: unbalanced braces/parens/brackets, unterminated
//     strings, malformed template literals, etc. These break the
//     build the same way the React Query hook call did. Type errors
//     (TS2xxx) are out of scope here — those need the full type-
//     checker pipeline and are caught by `pnpm run typecheck`.
//
// Usage:
//   node scripts/check-ts-syntax.mjs path/to/file.ts [more files...]
//   node scripts/check-ts-syntax.mjs --self-test
//
// Exit codes:
//   0  all files parsed cleanly (or no eligible files passed in)
//   1  at least one file had a syntax error (printed to stderr)
//   2  invocation error (e.g. typescript module not resolvable)

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

async function loadTypeScript() {
  // Prefer the workspace-root copy so we use the exact version the
  // repo pins (catalog: typescript). Fall back to whatever Node can
  // resolve, so the script also works when invoked from a tarball /
  // self-test fixture without the full node_modules tree.
  const rootCopy = path.join(REPO_ROOT, "node_modules", "typescript", "lib", "typescript.js");
  try {
    if (existsSync(rootCopy)) {
      return (await import(pathToFileURL(rootCopy).href)).default;
    }
    return (await import("typescript")).default;
  } catch (err) {
    process.stderr.write(
      `[check-ts-syntax] ERROR: cannot load the 'typescript' module: ${err?.message ?? err}\n` +
        `[check-ts-syntax] Run \`pnpm install\` at the repo root and try again.\n`,
    );
    process.exit(2);
  }
}

function isEligible(file) {
  return /\.(ts|tsx|mts|cts)$/i.test(file) && !/\.d\.ts$/i.test(file);
}

function scriptKindFor(ts, file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.mts$/i.test(file)) return ts.ScriptKind.TS;
  if (/\.cts$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

async function checkFile(ts, file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return [
      {
        file,
        line: 1,
        col: 1,
        code: 0,
        message: `cannot read file: ${err?.message ?? err}`,
      },
    ];
  }

  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    scriptKindFor(ts, file),
  );

  // `parseDiagnostics` is the array TypeScript fills during parse —
  // it contains exactly the TS1xxx syntax errors we want (TS1005
  // "')' expected", TS1109 "Expression expected", TS1136 "Property
  // assignment expected", etc.). It does NOT contain type errors,
  // which is what makes this check fast.
  const diags = sf.parseDiagnostics ?? [];
  return diags.map((d) => {
    let line = 1;
    let col = 1;
    if (typeof d.start === "number") {
      const lc = sf.getLineAndCharacterOfPosition(d.start);
      line = lc.line + 1;
      col = lc.character + 1;
    }
    return {
      file,
      line,
      col,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

async function main(argv) {
  if (argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const files = argv.filter((a) => !a.startsWith("--")).filter(isEligible);
  if (files.length === 0) {
    return;
  }

  const ts = await loadTypeScript();
  let totalErrors = 0;
  for (const file of files) {
    const errs = await checkFile(ts, file);
    for (const e of errs) {
      totalErrors++;
      process.stderr.write(
        `${path.relative(REPO_ROOT, e.file)}:${e.line}:${e.col}: error TS${e.code}: ${e.message}\n`,
      );
    }
  }

  if (totalErrors > 0) {
    process.stderr.write(
      `\n[check-ts-syntax] ${totalErrors} syntax error(s) in ${files.length} staged TS/TSX file(s).\n` +
        `[check-ts-syntax] These would break \`pnpm run typecheck\` and the build. Fix and re-stage.\n`,
    );
    process.exit(1);
  }
}

async function selfTest() {
  // Self-test: build two in-memory fixtures (one good, one bad),
  // run them through the same code path the hook uses, and assert
  // we get the expected outcome. This pins the contract so future
  // edits to the script can't silently regress the check.
  const ts = await loadTypeScript();
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  const tmp = await mkdtemp(path.join(os.tmpdir(), "check-ts-syntax-test-"));
  let failures = 0;
  const assert = (cond, msg) => {
    if (!cond) {
      failures++;
      process.stderr.write(`  FAIL: ${msg}\n`);
    } else {
      process.stdout.write(`  ok: ${msg}\n`);
    }
  };

  try {
    // Fixture 1: clean file should produce zero diagnostics.
    const goodFile = path.join(tmp, "good.tsx");
    await writeFile(
      goodFile,
      [
        "import { useQuery } from 'react-query';",
        "export function Page() {",
        "  const q = useQuery(['k'], () => 1, { enabled: true });",
        "  return q.data;",
        "}",
        "",
      ].join("\n"),
    );
    const goodErrs = await checkFile(ts, goodFile);
    assert(goodErrs.length === 0, "well-formed .tsx parses with zero syntax errors");

    // Fixture 2: the exact bug from Task #81 — useGetX(params, { ... )
    // missing the closing `}` for the options object. This is the
    // class of error the hook exists to catch.
    const badFile = path.join(tmp, "bad.tsx");
    await writeFile(
      badFile,
      [
        "import { useGetReminderSubscription } from './hooks';",
        "export function Page(params: any) {",
        "  const q = useGetReminderSubscription(params, { enabled: true );",
        "  return q.data;",
        "}",
        "",
      ].join("\n"),
    );
    const badErrs = await checkFile(ts, badFile);
    assert(
      badErrs.length > 0,
      "malformed useGetReminderSubscription(params, { ... ) is flagged as a syntax error",
    );

    // Fixture 3: eligibility filter — .d.ts files are skipped.
    assert(!isEligible("foo.d.ts"), ".d.ts files are excluded");
    assert(isEligible("foo.ts"), ".ts files are included");
    assert(isEligible("foo.tsx"), ".tsx files are included");
    assert(!isEligible("foo.js"), ".js files are excluded");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`\n[check-ts-syntax --self-test] ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("[check-ts-syntax --self-test] all assertions passed\n");
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[check-ts-syntax] unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});

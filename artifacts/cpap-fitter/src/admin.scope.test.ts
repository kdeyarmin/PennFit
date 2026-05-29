// Static guard for the "admin theme stays scoped" rule.
//
// CLAUDE.md hard rule:
//   "Admin theme stays scoped. Admin tokens (--penn-navy, etc.) live
//    in src/admin.css under `.admin-root`. Every admin surface must
//    wrap its outer <div> with className=\"admin-root\" so it doesn't
//    clobber storefront brand tokens."
//
// Without enforcement the failure mode is silent: a contributor adds
// `:root { --penn-navy: ... }` to admin.css for "convenience", the
// storefront chunk lazy-loads admin.css from a shared barrel, and now
// the customer marketing pages render with the admin palette. This
// test parses admin.css and fails if any `--penn-*` token (or any
// other admin-only brand token we explicitly enumerate) is declared
// outside a `.admin-root`-scoped block.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_CSS = readFileSync(path.join(__dirname, "admin.css"), "utf8");

// Strip /* ... */ block comments so an example token in a comment
// can't trip the static check.
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Walk a CSS source forwards, yielding each top-level rule with its
// selector list. We don't need a real parser — every rule we care
// about is at the file's top level (ignoring nesting under @media,
// which we treat as transparent for the purposes of selector
// extraction).
function* iterateTopLevelRules(
  src: string,
): Generator<{ selectors: string; body: string }> {
  let i = 0;
  while (i < src.length) {
    // Skip whitespace and at-rules whose body we want to recurse
    // into (e.g. @media). For simplicity we treat @media's body as
    // a sub-source: if a rule appears inside it, we surface its
    // selectors as if at the top level.
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) return;

    if (src[i] === "@") {
      // Find the matching brace block.
      const braceStart = src.indexOf("{", i);
      if (braceStart === -1) return;
      // Match braces.
      let depth = 1;
      let j = braceStart + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const inner = src.slice(braceStart + 1, j - 1);
      // Recurse into media-query inner CSS so nested selectors
      // surface to the test.
      yield* iterateTopLevelRules(inner);
      i = j;
      continue;
    }

    // Read selector list up to the opening brace.
    const braceStart = src.indexOf("{", i);
    if (braceStart === -1) return;
    const selectors = src.slice(i, braceStart).trim();
    let depth = 1;
    let j = braceStart + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(braceStart + 1, j - 1);
    yield { selectors, body };
    i = j;
  }
}

// Match a CSS custom-property *declaration*: `--penn-foo: …;`. We
// anchor on a leading boundary that's either the start of the
// stripped block or one of the legal pre-declaration characters
// (whitespace, `;`, `{`). Crucially this does NOT match reads of
// the token through `var(--penn-foo)`, because those have `(` to
// the left of the token, not start-of-block / `;` / `{`.
const ADMIN_TOKEN_DECL_RE = /(?:^|[\s;{])(--penn-[A-Za-z0-9_-]+)\s*:/;

function findDeclarations(body: string): string[] {
  const matches = body.matchAll(
    /(?:^|[\s;{])(--penn-[A-Za-z0-9_-]+)\s*:/g,
  );
  const tokens: string[] = [];
  for (const m of matches) tokens.push(m[1]!);
  return tokens;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("admin.css scoping", () => {
  const cleaned = stripCssComments(ADMIN_CSS);
  const rules = Array.from(iterateTopLevelRules(cleaned));

  it("declares every --penn-* token inside a .admin-root rule", () => {
    const offenders: Array<{ selectors: string; token: string }> = [];
    for (const { selectors, body } of rules) {
      const tokens = findDeclarations(body);
      if (tokens.length === 0) continue;
      // Selector list is OK if every selector is or starts with
      // `.admin-root`. We allow `.admin-root::before`, `.admin-root
      // .foo`, etc. — anything else (e.g. `:root`, `body`, `.foo`)
      // is a leak.
      const allOk = selectors
        .split(",")
        .map((s) => s.trim())
        .every((s) => s === ".admin-root" || s.startsWith(".admin-root"));
      if (!allOk) {
        for (const token of tokens) offenders.push({ selectors, token });
      }
    }
    expect(
      offenders,
      `--penn-* tokens must be declared inside .admin-root selectors. Offenders: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });

  it("never declares --penn-* tokens on :root", () => {
    const rootRules = rules.filter((r) =>
      r.selectors
        .split(",")
        .map((s) => s.trim())
        .includes(":root"),
    );
    for (const r of rootRules) {
      expect(ADMIN_TOKEN_DECL_RE.test(r.body)).toBe(false);
    }
  });

  // Tailwind v4 `@theme` (including `@theme inline`) emits GLOBAL utility
  // rules — they are NOT scopeable to a selector. admin.css is lazy-loaded
  // into the same document as the storefront, so a
  // `@theme { --color-background: hsl(var(--surface-1)) }` here overrides
  // the storefront's own `.bg-background` for the WHOLE page. Because the
  // admin surface/ink/line values live only under `.admin-root`, every
  // storefront surface then resolves to an undefined variable and renders
  // transparent — which is exactly what left the PennBot support panel
  // see-through. The admin console must re-point shadcn tokens by
  // overriding the RAW `--background` / `--foreground` / … variables
  // *scoped under `.admin-root`* (the storefront's utilities already read
  // those), never via a global `@theme` block.
  it("does not remap shared tokens via a global @theme block", () => {
    expect(
      /@theme\b/.test(cleaned),
      "admin.css must not contain an @theme block — Tailwind emits its " +
        "utilities globally, so it leaks admin colours onto the storefront " +
        "(undefined vars → transparent surfaces). Override the raw " +
        "--background/--foreground/… tokens under .admin-root instead.",
    ).toBe(false);
  });

  // Companion to the rule above: the shadcn token bridge must actually be
  // present (and scoped). admin.css re-points the RAW shadcn variables
  // (`--background`, `--foreground`, `--primary`, …) under `.admin-root`
  // so the storefront-admin pages' `bg-background` / `text-primary` / …
  // utilities resolve to the Penn-brand palette. Guard that the bridge
  // stays scoped under `.admin-root` (never leaked to `:root`/global).
  it("declares the raw shadcn token bridge under .admin-root (not globally)", () => {
    const BRIDGE_TOKENS = [
      "--background",
      "--foreground",
      "--border",
      "--input",
      "--muted",
      "--muted-foreground",
      "--primary",
      "--primary-foreground",
      "--destructive",
      "--destructive-foreground",
    ];
    for (const token of BRIDGE_TOKENS) {
      const declRe = new RegExp(`(?:^|[\\s;{])(${token})\\s*:`);
      const declaringRules = rules.filter((r) => declRe.test(r.body));
      // Every rule that declares a bridge token must be .admin-root-scoped.
      for (const r of declaringRules) {
        const allScoped = r.selectors
          .split(",")
          .map((s) => s.trim())
          .every((s) => s === ".admin-root" || s.startsWith(".admin-root"));
        expect(
          allScoped,
          `'${token}' is declared under '${r.selectors}' — the shadcn bridge ` +
            `must be scoped to .admin-root so it can't leak onto the storefront.`,
        ).toBe(true);
      }
    }
  });

  // admin.css is lazy-loaded into the storefront's document, so any rule
  // here whose selector ALSO matches storefront elements (:focus-visible,
  // ::-webkit-scrollbar*, #root, :root, html, body, the universal *) leaks
  // admin styling onto the storefront — and because admin colours live
  // only under `.admin-root`, those rules often resolve to undefined
  // variables off-admin (e.g. the storefront focus ring vanished when
  // admin.css's global `:focus-visible`, which references the admin-only
  // `--surface-2`, won the cascade). Such selectors must be scoped under
  // `.admin-root`. Admin-only class utilities (`.surface-card`, …) are
  // fine: those class names never appear on the storefront.
  it("scopes globally-reaching selectors under .admin-root", () => {
    const GLOBAL_REACH =
      /(^|,)\s*(\*|html|body|:root|#root)\b|:focus-visible|::-webkit-scrollbar/;
    const ADMIN_ROOT_SCOPED = /^\.admin-root(?:$|[\s>+~:.#[]|::)/;
    const offenders = rules
      .map((r) => r.selectors)
      .filter((selectors) => GLOBAL_REACH.test(selectors))
      .filter(
        (selectors) =>
          !selectors
            .split(",")
            .map((s) => s.trim())
            .every((s) => ADMIN_ROOT_SCOPED.test(s)),
      );
    expect(
      offenders,
      "These admin.css selectors reach storefront elements and must be " +
        "scoped under .admin-root (or moved to the shared index.css): " +
        JSON.stringify(offenders, null, 2),
    ).toEqual([]);
  });
});

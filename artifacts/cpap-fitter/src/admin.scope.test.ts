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

// ── Helpers for the @theme inline bridge tests ───────────────────────────────

/**
 * Extract the body of the first `@theme inline { … }` block from a CSS source.
 * Returns null if no such block exists.
 */
function extractThemeInlineBody(src: string): string | null {
  const match = src.match(/@theme\s+inline\s*\{/);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/**
 * Parse `--foo: value;` declarations from a CSS block body.
 * Returns a Map of property name → trimmed value (without trailing semicolon).
 */
function parseDeclarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  for (const m of body.matchAll(re)) {
    map.set(m[1]!.trim(), m[2]!.trim());
  }
  return map;
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
});

// ── @theme inline bridge (new in PR — replaces old scoped overrides) ─────────
//
// The storefront-admin pages use shadcn token names (`bg-background`,
// `text-primary`, etc.). Instead of re-pointing the *raw* `--background` /
// `--foreground` variables under `.admin-root`, admin.css now uses a
// top-level `@theme inline` block that maps `--color-*` onto the Penn-brand
// design-system vocabulary. Tailwind v4 emits those as first-class utilities.
describe("admin.css @theme inline bridge", () => {
  const cleaned = stripCssComments(ADMIN_CSS);
  const themeBody = extractThemeInlineBody(cleaned);

  const EXPECTED_TOKENS = [
    "--color-background",
    "--color-foreground",
    "--color-border",
    "--color-input",
    "--color-muted",
    "--color-muted-foreground",
    "--color-primary",
    "--color-primary-foreground",
    "--color-destructive",
    "--color-destructive-foreground",
  ] as const;

  it("admin.css contains an @theme inline block", () => {
    expect(
      themeBody,
      "admin.css must have an `@theme inline { … }` block for the shadcn " +
        "token bridge — without it bg-muted / text-primary / etc. resolve " +
        "to unstyled Tailwind defaults on the admin pages.",
    ).not.toBeNull();
  });

  it("uses @theme inline, not a bare @theme block", () => {
    // A bare `@theme { }` (without `inline`) would force Tailwind to emit
    // every token as a CSS custom property on :root in addition to utility
    // classes, which is noisier. `@theme inline` is the correct form.
    const bareThemeRe = /@theme\s*\{/;
    expect(
      bareThemeRe.test(cleaned),
      "admin.css must not contain a bare `@theme { }` block — use " +
        "`@theme inline { }` instead to avoid unnecessary :root output.",
    ).toBe(false);
  });

  it("defines all expected shadcn colour tokens", () => {
    // themeBody is guaranteed non-null by the earlier test; coerce for TS.
    const decls = parseDeclarations(themeBody ?? "");
    for (const token of EXPECTED_TOKENS) {
      expect(
        decls.has(token),
        `@theme inline block is missing '${token}' — storefront-admin pages ` +
          `that use the corresponding Tailwind utility (e.g. bg-muted for ` +
          `--color-muted) will fall back to an unstyled default.`,
      ).toBe(true);
    }
  });

  it("defines exactly the expected token set (no extra undocumented tokens)", () => {
    const decls = parseDeclarations(themeBody ?? "");
    const actual = [...decls.keys()].sort();
    const expected = [...EXPECTED_TOKENS].sort();
    expect(actual).toEqual(expected);
  });

  it("maps --color-background to hsl(var(--surface-1))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-background")).toBe("hsl(var(--surface-1))");
  });

  it("maps --color-foreground to hsl(var(--ink-1))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-foreground")).toBe("hsl(var(--ink-1))");
  });

  it("maps --color-border and --color-input to hsl(var(--line-1))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-border")).toBe("hsl(var(--line-1))");
    expect(decls.get("--color-input")).toBe("hsl(var(--line-1))");
  });

  it("maps --color-muted to hsl(var(--surface-3))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-muted")).toBe("hsl(var(--surface-3))");
  });

  it("maps --color-muted-foreground to hsl(var(--ink-3))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-muted-foreground")).toBe("hsl(var(--ink-3))");
  });

  it("maps --color-primary to hsl(var(--penn-navy))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-primary")).toBe("hsl(var(--penn-navy))");
  });

  it("maps --color-destructive to hsl(var(--tone-rose))", () => {
    const decls = parseDeclarations(themeBody ?? "");
    expect(decls.get("--color-destructive")).toBe("hsl(var(--tone-rose))");
  });

  it("maps foreground-on-colour tokens to opaque white", () => {
    const decls = parseDeclarations(themeBody ?? "");
    // Both -foreground-on-solid tokens must be full white so text is
    // legible on the navy primary and rose destructive backgrounds.
    expect(decls.get("--color-primary-foreground")).toBe("hsl(0 0% 100%)");
    expect(decls.get("--color-destructive-foreground")).toBe("hsl(0 0% 100%)");
  });

  it("each var()-based token references a Penn-brand variable (not a shadcn name)", () => {
    const decls = parseDeclarations(themeBody ?? "");
    // Tokens that use var() must reference the dashboard's own vocabulary
    // (--surface-*, --ink-*, --line-*, --penn-*, --tone-*), never a
    // shadcn/Tailwind built-in, to keep the mapping unambiguous.
    const VAR_RE = /var\((--[\w-]+)\)/g;
    const ALLOWED_PREFIXES = [
      "--surface-",
      "--ink-",
      "--line-",
      "--penn-",
      "--tone-",
    ];
    for (const [token, value] of decls) {
      for (const m of value.matchAll(VAR_RE)) {
        const ref = m[1]!;
        const ok = ALLOWED_PREFIXES.some((p) => ref.startsWith(p));
        expect(
          ok,
          `${token}: '${value}' references '${ref}' which is not in the ` +
            `Penn-brand vocabulary (--surface-*, --ink-*, --line-*, ` +
            `--penn-*, --tone-*). Bridge tokens must map onto the ` +
            `dashboard design system, not to other shadcn names.`,
        ).toBe(true);
      }
    }
  });

  // Regression: the OLD approach put --background / --foreground / etc.
  // directly under .admin-root. That has been replaced by the @theme inline
  // block. Guard against accidental reintroduction of the old pattern.
  it("does not declare old-style raw shadcn overrides (--background, --foreground, …) under .admin-root", () => {
    const OLD_RAW_TOKENS = [
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
    const rules = Array.from(iterateTopLevelRules(cleaned));
    const adminRootRules = rules.filter((r) =>
      r.selectors
        .split(",")
        .map((s) => s.trim())
        .some((s) => s === ".admin-root" || s.startsWith(".admin-root")),
    );
    for (const { selectors, body } of adminRootRules) {
      for (const token of OLD_RAW_TOKENS) {
        // Match declaration (not a var() read)
        const declRe = new RegExp(`(?:^|[\\s;{])(${token})\\s*:`);
        expect(
          declRe.test(body),
          `'.admin-root' block (selector: '${selectors}') declares '${token}'. ` +
            `The raw shadcn overrides were replaced by the @theme inline bridge — ` +
            `remove the declaration from .admin-root or the two approaches will conflict.`,
        ).toBe(false);
      }
    }
  });
});

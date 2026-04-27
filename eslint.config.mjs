// Repo-wide ESLint flat config — scoped to the resupply tree only.
//
// Penn Fit predates this config and is intentionally NOT linted here.
// If/when Penn Fit adopts ESLint, expand the `files` globs below; do
// not add a per-package eslint config (this is the single source of
// truth so the resupply-check validation step can call `eslint`
// against the whole tree in one pass).
//
// Why scoped: the resupply product's `resupply-check` validation gate
// requires lint + typecheck + test as a single signal. Linting Penn
// Fit in the same pass would block this gate on unrelated Penn Fit
// drift, which is the wrong incentive for Phase 0.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  // Global ignores — never lint generated, vendored, or build output.
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.replit-artifact/**",
      "**/*.d.ts",
      // Orval-generated code under lib/resupply-api-client. The shape
      // is owned by the OpenAPI spec (lib/resupply-api-spec/openapi.yaml)
      // and is overwritten on every codegen run, so lint findings here
      // are not actionable. Typecheck still covers it via the lib's
      // tsconfig.
      "lib/resupply-api-client/src/generated/**",
      "scripts/check-resupply-architecture.sh.test", // bash, not JS
    ],
  },

  // Resupply TS sources — the actual scope of this config.
  {
    files: [
      "lib/resupply-*/src/**/*.ts",
      "lib/resupply-*/src/**/*.tsx",
      "artifacts/resupply-api/src/**/*.ts",
      "artifacts/resupply-worker/src/**/*.ts",
      "artifacts/resupply-dashboard/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended[2].rules, // recommended (non-type-aware)
      // Phase 0 carve-outs — these will tighten in later phases as
      // real code lands. Listed explicitly so the deviation is visible
      // rather than silently inherited.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // TypeScript already resolves and validates identifiers (including
      // DOM types like `RequestInfo` / `HeadersInit`); ESLint's no-undef
      // can't see lib.dom.d.ts and produces false positives. Typecheck
      // is the source of truth for "is this defined".
      "no-undef": "off",
    },
  },
];

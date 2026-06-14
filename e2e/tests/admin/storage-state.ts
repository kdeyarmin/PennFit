// Shared path for the admin authenticated storage state, written by
// admin-auth.setup.ts and consumed by the `admin` Playwright project
// (see playwright.config.ts, which mirrors this literal).
//
// A cwd-relative string (not computed via node:path/url): the e2e suite
// is always launched from the repo root (e2e/README.md + the CI jobs),
// so this resolves to <repo>/e2e/.auth/admin.json for both the setup
// (which writes it) and the admin project (which reads it). Avoiding a
// node-builtin import also keeps Playwright's per-file transpiler from
// emitting CJS interop that fails under the repo's ESM mode.
export const ADMIN_STORAGE_STATE = "e2e/.auth/admin.json";

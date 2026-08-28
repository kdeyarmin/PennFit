// The role vocabulary on /admin/team has to cover every role the server
// will actually persist, and offer every role a tenant can hire.
//
// Both halves guard a silent failure. A persisted role with no label
// renders a BLANK badge on the member row — the row looks broken and
// nobody can tell what that person is. And a role missing from
// ROLE_OPTIONS cannot be invited or switched to from the console at
// all: the API accepts it, so the only way to create one is a direct
// API call or a legacy row. That is exactly what happened to `rt`
// (respiratory therapist) — the invitation email had a full RT
// handbook, the RBAC catalog had an RT permission set, and there was
// no way to make one.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ROLE_HINT, ROLE_LABEL, ROLE_OPTIONS } from "./team-roles";
import type { TeamRole } from "./admin-team-api";

describe("team-roles — invite selector", () => {
  it("offers both job-scoped roles, not just the general buckets", () => {
    // The regression: a role the server accepts but the console never
    // offers is unreachable to the person doing the hiring.
    expect(ROLE_OPTIONS).toContain("rt");
    expect(ROLE_OPTIONS).toContain("biller");
  });

  it("offers each role exactly once", () => {
    expect(new Set(ROLE_OPTIONS).size).toBe(ROLE_OPTIONS.length);
  });

  it("gives every offered role a label and a scope hint", () => {
    for (const role of ROLE_OPTIONS) {
      expect(ROLE_LABEL[role]?.trim()).toBeTruthy();
      expect(ROLE_HINT[role]?.trim()).toBeTruthy();
    }
  });

  it("labels every offered role distinctly", () => {
    // Two options reading the same thing is a coin flip for the admin.
    const labels = ROLE_OPTIONS.map((r) => ROLE_LABEL[r]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("team-roles — member row labels", () => {
  it("labels every persisted role, including the legacy names", () => {
    for (const [role, label] of Object.entries(ROLE_LABEL)) {
      expect(label?.trim(), `blank label for ${role}`).toBeTruthy();
    }
  });

  it("collapses each legacy alias onto its canonical label", () => {
    // A row persisted under an older role name must read as the bucket
    // it actually resolves to in rbac.ts, not as its own fourth thing.
    for (const legacy of ["fitter", "fulfillment", "agent"] as TeamRole[]) {
      expect(ROLE_LABEL[legacy]).toBe(ROLE_LABEL.csr);
    }
    expect(ROLE_LABEL.compliance_officer).toBe(ROLE_LABEL.supervisor);
  });

  it("reserves 'Super admin' for the platform tier", () => {
    // A tenant's top role is the Owner; "super admin" names the global
    // platform_admins tier that sits above every tenant.
    for (const label of Object.values(ROLE_LABEL)) {
      expect(label.toLowerCase()).not.toContain("super admin");
    }
  });
});

// ---------------------------------------------------------------------------
// Drift: the console's vocabulary vs. what the API will persist
// ---------------------------------------------------------------------------
//
// allow-source-read: the server's accepted-role list is a plain array in
// the route module, and the SPA does not (and should not) depend on the
// API package, so there is no importable representation of it. Read it
// as DATA the way app-modules.drift.test.ts reads the migration SQL. The
// parse asserts its own success, so a rename or a refactor of that array
// fails this test loudly instead of quietly checking nothing.

const ROUTE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "artifacts",
  "resupply-api",
  "src",
  "routes",
  "admin",
  "team.ts",
);

/** The roles POST /admin/team/invite and PATCH /admin/team/:id accept. */
function serverRoleValues(): string[] {
  const src = readFileSync(ROUTE_FILE, "utf8");
  // Tolerant of anything that doesn't change what the array MEANS:
  // spacing, a type annotation that changes or disappears, and a
  // trailing `as const satisfies …` before the semicolon. What it will
  // not do is quietly match nothing — a rename fails the assertion
  // below by name instead of silently checking an empty list.
  const block = /const\s+ROLE_VALUES\b[^=]*=\s*\[([^\]]*)\][^;]*;/.exec(src);
  expect(block, `ROLE_VALUES not found in ${ROUTE_FILE}`).toBeTruthy();
  const roles = Array.from(block![1].matchAll(/"([a-z_]+)"/g), (m) => m[1]);
  // Sanity-check the parse itself: the enum has never been this small.
  expect(roles.length).toBeGreaterThanOrEqual(5);
  return roles;
}

describe("team-roles — drift against the API's accepted roles", () => {
  it("labels every role the API will persist", () => {
    const unlabelled = serverRoleValues().filter((r) => !(r in ROLE_LABEL));
    expect(
      unlabelled,
      "role accepted by the API with no console label",
    ).toEqual([]);
  });

  it("only offers roles the API will accept", () => {
    const server = new Set(serverRoleValues());
    const rejected = ROLE_OPTIONS.filter((r) => !server.has(r));
    expect(rejected, "role offered in the console the API would 400").toEqual(
      [],
    );
  });
});

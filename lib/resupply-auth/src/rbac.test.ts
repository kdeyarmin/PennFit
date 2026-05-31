// Tests for the RBAC catalog.
//
// Goal: pin the role → permission relationships that real routes
// depend on, AND pin the invariants (admin has everything, every
// permission has at least one role besides admin, no role outside
// the catalog).

import { describe, it, expect } from "vitest";

import {
  ALL_PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  type Permission,
} from "./rbac";

describe("roleHasPermission", () => {
  it("admin has every permission", () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(roleHasPermission("admin", perm)).toBe(true);
    }
  });

  it("supervisor can approve returns + export audit", () => {
    expect(roleHasPermission("supervisor", "returns.approve")).toBe(true);
    expect(roleHasPermission("supervisor", "audit.export")).toBe(true);
  });

  it("csr can read returns but cannot approve", () => {
    expect(roleHasPermission("csr", "returns.read")).toBe(true);
    expect(roleHasPermission("csr", "returns.approve")).toBe(false);
  });

  it("csr cannot export audit", () => {
    expect(roleHasPermission("csr", "audit.export")).toBe(false);
  });

  it("csr cannot resolve compliance alerts", () => {
    expect(roleHasPermission("csr", "compliance.resolve")).toBe(false);
    // ...but can read them
    expect(roleHasPermission("csr", "compliance.read")).toBe(true);
  });

  it("fitter has fit-session override + patient read/update, nothing else clinical", () => {
    expect(roleHasPermission("fitter", "fit_session.override")).toBe(true);
    expect(roleHasPermission("fitter", "patients.update")).toBe(true);
    expect(roleHasPermission("fitter", "compliance.resolve")).toBe(false);
    expect(roleHasPermission("fitter", "returns.approve")).toBe(false);
    expect(roleHasPermission("fitter", "audit.export")).toBe(false);
  });

  it("fulfillment folds into customer_service_rep (union of pre-collapse perms)", () => {
    // Phase B collapse: `fulfillment` is one of the four DB roles that
    // merges into the `customer_service_rep` effective bucket. The
    // bucket's perm set is the UNION of csr + fitter + fulfillment +
    // agent, so fulfillment ROW HOLDERS now inherit perms they didn't
    // have pre-collapse (patients.update from csr, compliance.read
    // from csr, etc.) — that's by design.
    expect(roleHasPermission("fulfillment", "patients.read")).toBe(true);
    expect(roleHasPermission("fulfillment", "returns.read")).toBe(true);
    expect(roleHasPermission("fulfillment", "patients.update")).toBe(true);
    expect(roleHasPermission("fulfillment", "compliance.read")).toBe(true);
    // Destructive / management perms stay out — not in any of the
    // four DB roles that folded into customer_service_rep.
    expect(roleHasPermission("fulfillment", "audit.export")).toBe(false);
    expect(roleHasPermission("fulfillment", "returns.approve")).toBe(false);
    expect(roleHasPermission("fulfillment", "admin_team.manage")).toBe(false);
  });

  it("compliance_officer folds into admin (gains supervisor union)", () => {
    // Phase B collapse: `compliance_officer` is merged with the legacy
    // `supervisor` role into the `admin` effective bucket. The bucket's
    // perm set is the UNION of those two — so compliance_officer ROW
    // HOLDERS now have supervisor-tier perms like returns.approve,
    // admin.tools.manage, conversations.manage. By design.
    expect(roleHasPermission("compliance_officer", "compliance.resolve")).toBe(
      true,
    );
    expect(roleHasPermission("compliance_officer", "audit.export")).toBe(true);
    expect(roleHasPermission("compliance_officer", "training.manage")).toBe(
      true,
    );
    expect(roleHasPermission("compliance_officer", "returns.approve")).toBe(
      true,
    );
    // admin_team.manage stays super_admin-only — not in either of
    // the two DB roles that folded into admin.
    expect(roleHasPermission("compliance_officer", "admin_team.manage")).toBe(
      false,
    );
  });

  it("agent (legacy) mirrors csr — no destructive perms", () => {
    expect(roleHasPermission("agent", "returns.read")).toBe(true);
    expect(roleHasPermission("agent", "returns.approve")).toBe(false);
    expect(roleHasPermission("agent", "audit.export")).toBe(false);
    expect(roleHasPermission("agent", "compliance.resolve")).toBe(false);
  });

  it("returns.manage is broader than returns.approve", () => {
    // returns.manage covers fulfillment-lifecycle ops (loss claims,
    // POD updates) — sits BELOW the approve gate so CSRs and
    // fulfillment can run the lifecycle without unlocking refunds.
    expect(roleHasPermission("csr", "returns.manage")).toBe(true);
    expect(roleHasPermission("csr", "returns.approve")).toBe(false);
    expect(roleHasPermission("fulfillment", "returns.manage")).toBe(true);
    expect(roleHasPermission("fulfillment", "returns.approve")).toBe(false);
    // Supervisor + admin still have both (the approve gate implies
    // the manage gate in practice).
    expect(roleHasPermission("supervisor", "returns.manage")).toBe(true);
    expect(roleHasPermission("supervisor", "returns.approve")).toBe(true);
  });

  it("conversations.manage holds for every effective bucket", () => {
    // Phase B collapse: conversations.manage was in csr + agent +
    // supervisor pre-collapse, so it's in both customer_service_rep
    // and admin after the union. super_admin trivially holds it via
    // the ALL_PERMISSIONS membership.
    expect(roleHasPermission("csr", "conversations.manage")).toBe(true);
    expect(roleHasPermission("agent", "conversations.manage")).toBe(true);
    expect(roleHasPermission("supervisor", "conversations.manage")).toBe(true);
    expect(roleHasPermission("admin", "conversations.manage")).toBe(true);
    // Fitter + fulfillment + compliance_officer now resolve through
    // the bucket merger and inherit conversations.manage too —
    // documented behavior change of the 3-bucket collapse.
    expect(roleHasPermission("fitter", "conversations.manage")).toBe(true);
    expect(roleHasPermission("fulfillment", "conversations.manage")).toBe(true);
    expect(
      roleHasPermission("compliance_officer", "conversations.manage"),
    ).toBe(true);
  });

  it("admin.tools.manage is admin-bucket-and-up", () => {
    // Phase B collapse: admin.tools.manage was in admin + supervisor
    // pre-collapse — so super_admin (=admin DB role) holds it and
    // admin-effective (=supervisor + compliance_officer) holds it.
    // The customer_service_rep bucket does NOT — no DB role that
    // folds into it had admin.tools.manage.
    expect(roleHasPermission("admin", "admin.tools.manage")).toBe(true);
    expect(roleHasPermission("supervisor", "admin.tools.manage")).toBe(true);
    expect(roleHasPermission("compliance_officer", "admin.tools.manage")).toBe(
      true,
    );
    // customer_service_rep bucket — none of these inherit it.
    expect(roleHasPermission("csr", "admin.tools.manage")).toBe(false);
    expect(roleHasPermission("agent", "admin.tools.manage")).toBe(false);
    expect(roleHasPermission("fitter", "admin.tools.manage")).toBe(false);
    expect(roleHasPermission("fulfillment", "admin.tools.manage")).toBe(false);
  });

  it("cost.read / cost.write are finance-gated: admin + supervisor yes, CSR tier no", () => {
    // Cost / COGS / margin figures are owner-and-management data. Both
    // permissions ride the `admin` effective bucket (supervisor +
    // compliance_officer fold in), and super_admin holds them trivially —
    // but the customer_service_rep bucket (csr + fitter + fulfillment +
    // agent) must NOT see or edit unit cost.
    for (const perm of ["cost.read", "cost.write"] as const) {
      expect(roleHasPermission("admin", perm)).toBe(true);
      expect(roleHasPermission("supervisor", perm)).toBe(true);
      expect(roleHasPermission("compliance_officer", perm)).toBe(true);
      expect(roleHasPermission("csr", perm)).toBe(false);
      expect(roleHasPermission("agent", perm)).toBe(false);
      expect(roleHasPermission("fitter", perm)).toBe(false);
      expect(roleHasPermission("fulfillment", perm)).toBe(false);
    }
  });
});

describe("permissionsForRole", () => {
  it("returns the full set for admin", () => {
    const perms = permissionsForRole("admin");
    expect(perms.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("returns a non-empty set for every role", () => {
    for (const role of [
      "admin",
      "supervisor",
      "csr",
      "fitter",
      "fulfillment",
      "compliance_officer",
      "agent",
    ] as const) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });

  it("returns a fresh array per call (caller mutation safety)", () => {
    const a = permissionsForRole("csr");
    a.push("admin_team.manage" as Permission);
    const b = permissionsForRole("csr");
    expect(b).not.toContain("admin_team.manage");
  });
});

describe("catalog invariants", () => {
  it("every non-admin-only permission is granted to at least one non-admin role", () => {
    // A permission only `admin` has is a smell unless it's
    // intentionally admin-only — either it should be gated via
    // requireAdminOnly, or it should be delegable to a role. This
    // test fails loud when the policy choice is implicit.
    const ADMIN_ONLY: ReadonlySet<Permission> = new Set([
      // Team management (invite / revoke) is the legacy
      // requireAdminOnly surface; the perm exists in the catalog
      // for symmetry but must not leak to any other role today.
      "admin_team.manage",
    ]);
    for (const perm of ALL_PERMISSIONS) {
      if (ADMIN_ONLY.has(perm)) continue;
      const granted = (
        [
          "supervisor",
          "csr",
          "fitter",
          "fulfillment",
          "compliance_officer",
          "agent",
        ] as const
      ).some((r) => roleHasPermission(r, perm));
      expect(
        granted,
        `permission "${perm}" is only on admin — either move it to ADMIN_ONLY or grant a role`,
      ).toBe(true);
    }
  });

  it("admin_team.manage is restricted to admin only", () => {
    // The team-management endpoints (invite, revoke) are still
    // admin-only — this perm exists in the catalog for forward-
    // compat but must not leak to any other role today.
    for (const role of [
      "supervisor",
      "csr",
      "fitter",
      "fulfillment",
      "compliance_officer",
      "agent",
    ] as const) {
      expect(roleHasPermission(role, "admin_team.manage")).toBe(false);
    }
  });
});

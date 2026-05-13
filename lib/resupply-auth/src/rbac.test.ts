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

  it("fulfillment has narrow read access only", () => {
    expect(roleHasPermission("fulfillment", "patients.read")).toBe(true);
    expect(roleHasPermission("fulfillment", "returns.read")).toBe(true);
    expect(roleHasPermission("fulfillment", "patients.update")).toBe(false);
    expect(roleHasPermission("fulfillment", "compliance.read")).toBe(false);
    expect(roleHasPermission("fulfillment", "audit.export")).toBe(false);
  });

  it("compliance_officer can resolve compliance + export audit but not approve returns", () => {
    expect(roleHasPermission("compliance_officer", "compliance.resolve")).toBe(
      true,
    );
    expect(roleHasPermission("compliance_officer", "audit.export")).toBe(true);
    expect(roleHasPermission("compliance_officer", "returns.approve")).toBe(
      false,
    );
    expect(roleHasPermission("compliance_officer", "training.manage")).toBe(
      true,
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

  it("conversations.manage covers CSR triage workflows", () => {
    // CSRs run the inbox; agents (legacy) need parity to avoid a
    // deploy-day regression.
    expect(roleHasPermission("csr", "conversations.manage")).toBe(true);
    expect(roleHasPermission("agent", "conversations.manage")).toBe(true);
    expect(roleHasPermission("supervisor", "conversations.manage")).toBe(true);
    // Read-only / non-CSR roles should not gain triage perms.
    expect(roleHasPermission("fitter", "conversations.manage")).toBe(false);
    expect(roleHasPermission("fulfillment", "conversations.manage")).toBe(
      false,
    );
    expect(roleHasPermission("compliance_officer", "conversations.manage")).toBe(
      false,
    );
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

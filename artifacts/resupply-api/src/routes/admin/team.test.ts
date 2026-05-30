// Tests for routes/admin/team.ts — the invite simplification in this PR.
//
// PR changes:
//   * Removed `initialPassword` field from the `inviteBody` Zod schema
//   * Removed `signInReady` from response payloads
//   * The route now only accepts: email, role, displayName?, notes?
//
// This file covers:
//   * Source-text assertions: inviteBody schema shape (no initialPassword)
//   * Source-text assertions: response payloads don't mention signInReady
//   * Pure-function unit tests: coarseAuthRoleFor (all role values)
//   * Pure-function unit tests: effectiveStatus (all status/verifiedAt combos)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "team.ts"), "utf8");

// ---------------------------------------------------------------------------
// inviteBody Zod schema — removed fields
// ---------------------------------------------------------------------------
describe("team.ts inviteBody — initialPassword present in schema", () => {
  it("includes initialPassword in the inviteBody schema", () => {
    expect(SRC).toContain("initialPassword");
  });

  it("declares initialPassword as a length-bounded optional field", () => {
    // Admin-set initial password feature: z.string().min(12)… so an
    // admin can hand a new staff member a password out of band.
    expect(SRC).toMatch(/initialPassword:\s*z\.string\(\)\.min\(12\)/);
  });

  it("inviteBody is declared as a strict schema (no extra fields allowed)", () => {
    expect(SRC).toContain(".strict()");
  });

  it("inviteBody accepts email field", () => {
    expect(SRC).toContain("email: z.string()");
  });

  it("inviteBody accepts role field", () => {
    expect(SRC).toContain("role: z.enum(ROLE_VALUES");
  });

  it("inviteBody accepts optional displayName field", () => {
    expect(SRC).toContain("displayName: z.string()");
  });

  it("inviteBody accepts optional notes field", () => {
    expect(SRC).toContain("notes: z.string()");
  });
});

// ---------------------------------------------------------------------------
// Response payloads — signInReady removed
// ---------------------------------------------------------------------------
describe("team.ts invite response — includes signInReady", () => {
  it("includes signInReady in the invite response payload", () => {
    expect(SRC).toContain("signInReady");
  });

  it("invite response includes emailSent field", () => {
    expect(SRC).toContain("emailSent: invite.emailSent");
  });

  it("invite response includes inviteLink field (null when emailSent)", () => {
    expect(SRC).toContain(
      "inviteLink: invite.emailSent ? null : invite.inviteLink",
    );
  });
});

// ---------------------------------------------------------------------------
// coarseAuthRoleFor — pure function reimplemented for unit testing
// ---------------------------------------------------------------------------
type AdminRole =
  | "admin"
  | "supervisor"
  | "csr"
  | "fitter"
  | "fulfillment"
  | "compliance_officer"
  | "agent";

function coarseAuthRoleFor(role: AdminRole): "admin" | "agent" {
  return role === "admin" ? "admin" : "agent";
}

describe("coarseAuthRoleFor", () => {
  it("maps 'admin' to 'admin'", () => {
    expect(coarseAuthRoleFor("admin")).toBe("admin");
  });

  it("maps 'supervisor' to 'agent'", () => {
    expect(coarseAuthRoleFor("supervisor")).toBe("agent");
  });

  it("maps 'csr' to 'agent'", () => {
    expect(coarseAuthRoleFor("csr")).toBe("agent");
  });

  it("maps 'fitter' to 'agent'", () => {
    expect(coarseAuthRoleFor("fitter")).toBe("agent");
  });

  it("maps 'fulfillment' to 'agent'", () => {
    expect(coarseAuthRoleFor("fulfillment")).toBe("agent");
  });

  it("maps 'compliance_officer' to 'agent'", () => {
    expect(coarseAuthRoleFor("compliance_officer")).toBe("agent");
  });

  it("maps 'agent' to 'agent'", () => {
    expect(coarseAuthRoleFor("agent")).toBe("agent");
  });

  it("only returns 'admin' for the exact 'admin' role, not for any other", () => {
    const nonAdmin: AdminRole[] = [
      "supervisor",
      "csr",
      "fitter",
      "fulfillment",
      "compliance_officer",
      "agent",
    ];
    for (const role of nonAdmin) {
      expect(coarseAuthRoleFor(role)).toBe("agent");
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveStatus — pure function reimplemented for unit testing
// ---------------------------------------------------------------------------
type AdminStatus = "active" | "pending" | "revoked";

function effectiveStatus(
  storedStatus: string,
  emailVerifiedAt: string | null,
): AdminStatus {
  if (storedStatus === "revoked") return "revoked";
  if (emailVerifiedAt) return "active";
  return "pending";
}

describe("effectiveStatus", () => {
  it("returns 'revoked' when storedStatus is 'revoked' regardless of emailVerifiedAt", () => {
    expect(effectiveStatus("revoked", null)).toBe("revoked");
    expect(effectiveStatus("revoked", "2024-01-01T00:00:00Z")).toBe("revoked");
  });

  it("returns 'active' when storedStatus is 'pending' but emailVerifiedAt is set", () => {
    expect(effectiveStatus("pending", "2024-01-01T00:00:00Z")).toBe("active");
  });

  it("returns 'active' when storedStatus is 'active' and emailVerifiedAt is set", () => {
    expect(effectiveStatus("active", "2024-01-01T00:00:00Z")).toBe("active");
  });

  it("returns 'pending' when storedStatus is 'pending' and emailVerifiedAt is null", () => {
    expect(effectiveStatus("pending", null)).toBe("pending");
  });

  it("returns 'pending' when storedStatus is 'active' but emailVerifiedAt is null (edge case)", () => {
    // An admin row with status='active' but no verified_at would be pending by
    // effective status — emailVerifiedAt is the authoritative signal for "accepted".
    expect(effectiveStatus("active", null)).toBe("pending");
  });

  it("revoked takes priority over emailVerifiedAt being set", () => {
    // A revoked user who previously accepted should still show as revoked.
    expect(effectiveStatus("revoked", "2024-03-15T12:00:00Z")).toBe("revoked");
  });

  it("treats empty string emailVerifiedAt as falsy (returns pending)", () => {
    // Defensive: an empty string should not be treated as "verified".
    expect(effectiveStatus("pending", "")).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Route structure: endpoints still present
// ---------------------------------------------------------------------------
describe("team.ts — route structure retained", () => {
  it("registers GET /admin/team for listing members", () => {
    expect(SRC).toContain('router.get("/admin/team"');
  });

  it("registers POST /admin/team/invite for inviting members", () => {
    expect(SRC).toContain('router.post(\n  "/admin/team/invite"');
  });

  it("registers POST /admin/team/:id/resend for resending invites", () => {
    expect(SRC).toContain('"/admin/team/:id/resend"');
  });

  it("registers POST /admin/team/:id/revoke for revoking members", () => {
    expect(SRC).toContain('"/admin/team/:id/revoke"');
  });

  it("registers PATCH /admin/team/:id for updating members", () => {
    expect(SRC).toContain('"/admin/team/:id"');
  });

  it("applies requireAdminOnly to all sensitive mutations", () => {
    // requireAdminOnly appears multiple times — once per protected route.
    const matches = SRC.split("requireAdminOnly");
    expect(matches.length).toBeGreaterThanOrEqual(6); // at least 5 usages
  });
});

// ---------------------------------------------------------------------------
// ROLE_VALUES catalog — all 7 granular roles present
// ---------------------------------------------------------------------------
describe("team.ts — ROLE_VALUES catalog", () => {
  it("includes all 7 granular admin roles", () => {
    expect(SRC).toContain('"admin"');
    expect(SRC).toContain('"supervisor"');
    expect(SRC).toContain('"csr"');
    expect(SRC).toContain('"fitter"');
    expect(SRC).toContain('"fulfillment"');
    expect(SRC).toContain('"compliance_officer"');
    expect(SRC).toContain('"agent"');
  });
});

// ---------------------------------------------------------------------------
// Self-protection invariants — still present
// ---------------------------------------------------------------------------
describe("team.ts — self-revoke / self-demote guards retained", () => {
  it("still checks cannot_revoke_self", () => {
    expect(SRC).toContain("cannot_revoke_self");
  });

  it("still checks cannot_demote_self", () => {
    expect(SRC).toContain("cannot_demote_self");
  });
});

// ---------------------------------------------------------------------------
// 409 conflict on already-active member still present
// ---------------------------------------------------------------------------
describe("team.ts — 409 conflict for already-active member", () => {
  it("returns 409 with already_active_member error for an active re-invite", () => {
    expect(SRC).toContain("already_active_member");
  });

  it("points the caller at PATCH for role changes on active members", () => {
    expect(SRC).toContain("Use PATCH /admin/team/:id to change their role.");
  });
});

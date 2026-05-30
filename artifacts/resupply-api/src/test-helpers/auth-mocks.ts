// Test helpers for route tests that need to bypass `requireAdmin`
// / `requireSignedIn` without spinning up the full in-house auth
// stack (cookie + session repo + auth.users lookup).
//
// Usage (admin route test):
//
//   import { makeRequireAdminMock, type MockAdminCtx } from
//     "../../test-helpers/auth-mocks";
//   const { mockAdmin } = vi.hoisted(() => ({
//     mockAdmin: { current: null as MockAdminCtx | null },
//   }));
//   vi.mock("../../middlewares/requireAdmin", () =>
//     makeRequireAdminMock(mockAdmin),
//   );
//   // …
//   beforeEach(() => { mockAdmin.current = null; });
//   function stubVerifiedAdmin() {
//     mockAdmin.current = {
//       userId: "u_admin_1",
//       email: "ops@penn.example.com",
//       role: "admin",
//     };
//   }
//
// The shop variant is identical but mocks `requireSignedIn` /
// `attachSignedIn` and exposes a `userCustomerId` ref instead.
//
// Why we mock the middleware (not the underlying auth-deps): route
// tests aren't testing the auth gate — that's covered exhaustively
// by `requireAdmin-in-house.test.ts` and `requireSignedIn-in-house.test.ts`.
// Bypassing the middleware keeps each route test focused on its
// own contract.

import type { NextFunction, Request, Response } from "express";

import { type Permission, roleHasPermission } from "@workspace/resupply-auth";
import type { AdminRole } from "@workspace/resupply-db";

export interface MockAdminCtx {
  userId: string;
  email: string;
  role: "admin" | "agent";
  /**
   * Optional granular role (RBAC Phase A). When omitted, defaults
   * to `role` — existing tests that only set "admin" / "agent" still
   * work, and permission checks pass admin universally + agent via
   * the legacy mirror set.
   */
  granularRole?: AdminRole;
}

export interface MockAdminRef {
  current: MockAdminCtx | null;
}

export interface MockSignedInProfile {
  customerId: string;
  email?: string | null;
  displayName?: string | null;
}

/**
 * Backwards-compatible: when the ref holds a bare string, it's
 * treated as the customerId; tests that need to drive
 * `shopCustomerEmail` / `shopCustomerDisplayName` can hold a
 * profile object instead.
 */
export interface MockSignedInRef {
  current: string | MockSignedInProfile | null;
}

/**
 * Build the module replacement for `../middlewares/requireAdmin`.
 * `requireAdmin` returns 401 when `ref.current` is null, attaches
 * the admin context to `req` otherwise. `requireAdminOnly` adds a
 * 403 when the role is not 'admin'.
 */
export function makeRequireAdminMock(ref: MockAdminRef): {
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  requireAdminOnly: (req: Request, res: Response, next: NextFunction) => void;
  requirePermission: (
    perm: Permission,
  ) => (req: Request, res: Response, next: NextFunction) => void;
} {
  const attach = (req: Request, ctx: MockAdminCtx): void => {
    req.adminUserId = ctx.userId;
    req.adminEmail = ctx.email;
    req.adminRole = ctx.role;
    req.adminGranularRole = ctx.granularRole ?? ctx.role;
  };
  return {
    requireAdmin: (req, res, next) => {
      if (!ref.current) {
        res.status(401).json({ error: "Sign in required" });
        return;
      }
      attach(req, ref.current);
      next();
    },
    requireAdminOnly: (req, res, next) => {
      if (!ref.current) {
        res.status(401).json({ error: "Sign in required" });
        return;
      }
      if (ref.current.role !== "admin") {
        res.status(403).json({
          error:
            "This action requires admin privileges. Customer-service agents cannot perform destructive operations.",
        });
        return;
      }
      attach(req, ref.current);
      next();
    },
    requirePermission: (perm) => (req, res, next) => {
      if (!ref.current) {
        res.status(401).json({ error: "Sign in required" });
        return;
      }
      const role = ref.current.granularRole ?? ref.current.role;
      if (!roleHasPermission(role, perm)) {
        res.status(403).json({
          error: "permission_denied",
          message: "Your account doesn't have permission for this action.",
          requiredPermission: perm,
        });
        return;
      }
      attach(req, ref.current);
      next();
    },
  };
}

/**
 * Build the module replacement for
 * `../middlewares/requireSignedIn`. `requireSignedIn` 401s on a
 * null ref; `attachSignedIn` is a soft variant that just attaches
 * when the ref is set.
 */
export function makeRequireSignedInMock(ref: MockSignedInRef): {
  requireSignedIn: (req: Request, res: Response, next: NextFunction) => void;
  attachSignedIn: (req: Request, res: Response, next: NextFunction) => void;
} {
  const attach = (req: Request, value: string | MockSignedInProfile): void => {
    if (typeof value === "string") {
      req.userCustomerId = value;
      return;
    }
    req.userCustomerId = value.customerId;
    req.shopCustomerEmail = value.email ?? null;
    req.shopCustomerDisplayName = value.displayName ?? null;
  };
  return {
    requireSignedIn: (req, res, next) => {
      if (!ref.current) {
        res.status(401).json({ error: "sign_in_required" });
        return;
      }
      attach(req, ref.current);
      next();
    },
    attachSignedIn: (req, _res, next) => {
      if (ref.current) {
        attach(req, ref.current);
      }
      next();
    },
  };
}

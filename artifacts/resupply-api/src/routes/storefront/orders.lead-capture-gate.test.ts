// POST /orders under `fitter.lead_capture_only`.
//
// Hiding a button is not a control. The SPA stops linking to the
// self-serve order form when the flag is on, but this endpoint is public
// and anonymous, so it has to refuse on its own — otherwise a bookmarked
// URL, a replayed request, or an old tab still starts a claim from a
// patient's guess at their own member ID with nobody at the DME having
// looked at it.
//
// The other half of what this file pins is the DIRECTION of the failure.
// `isFeatureEnabled` absorbs every lookup failure into "off", so reading
// the flag through it would quietly re-open self-service ordering during
// a flag-store blip. The route reads `enabled || degraded` instead.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../middlewares/requireSignedIn", () => ({
  attachSignedIn: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSignedIn: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const flagState = vi.hoisted(() => ({ enabled: true, degraded: false }));
vi.mock("../../lib/feature-flags", () => ({
  getFeatureFlagState: vi.fn(async () => ({
    enabled: flagState.enabled,
    degraded: flagState.degraded,
  })),
  isFeatureEnabled: vi.fn(async () => flagState.enabled),
}));

// The handler past the gate is not what this file is about; stub the data
// layer far enough that a permitted request doesn't explode.
vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: vi.fn(async () => "00000000-0000-4000-8000-000000000000"),
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          insert: () => ({
            select: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: { id: "order-1" },
                  error: null,
                }),
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }),
      }),
    }),
  }),
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({
      from: () => ({
        insert: () => ({
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: { id: "o" }, error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("../../lib/storefront/orderEmail", () => ({
  sendOrderToPenn: vi.fn(async () => ({
    delivered: false,
    configured: false,
    error: "not configured in test",
  })),
  generateOrderReference: vi.fn(() => "PENN-TEST001"),
}));

vi.mock("../../lib/stripe/customer", () => ({
  ensureShopCustomerRow: vi.fn(async () => "cus_test"),
}));

import ordersRouter from "./orders";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(ordersRouter);
  return app;
}

const VALID_ORDER = {
  chosenMask: {
    maskId: "resmed-airfit-f20",
    name: "AirFit F20",
    modelNumber: "PHM-RM-F20",
    manufacturer: "ResMed",
    size: "M",
  },
  patient: {
    firstName: "Alice",
    lastName: "Nguyen",
    dateOfBirth: "1970-04-12",
    email: "alice@example.com",
    phone: "5551234567",
  },
  shippingAddress: {
    street1: "1 Main St",
    city: "Pittsburgh",
    state: "PA",
    zip: "15213",
  },
  insurance: { provider: "Highmark", memberId: "HM12345" },
  prescription: { hasExistingPrescription: false },
  consentToContact: true,
};

beforeEach(() => {
  flagState.enabled = true;
  flagState.degraded = false;
});

describe("POST /orders — fitter.lead_capture_only", () => {
  it("refuses a patient-submitted order while the flag is on", async () => {
    const res = await request(makeApp()).post("/orders").send(VALID_ORDER);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("self_service_ordering_disabled");
    // The message is patient-facing and must point somewhere useful.
    expect(res.body.message).toMatch(/team/i);
  });

  it("refuses when the flag lookup is DEGRADED, not just when it is on", async () => {
    // A lookup that never reached the tenant's row means we do not know
    // whether this tenant allows self-service ordering — and the safe
    // reading of "we don't know" is that it does not.
    flagState.enabled = false;
    flagState.degraded = true;
    const res = await request(makeApp()).post("/orders").send(VALID_ORDER);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("self_service_ordering_disabled");
  });

  it("lets a deliberate opt-out tenant keep self-service ordering", async () => {
    // An explicit `{enabled:false, degraded:false}` is a tenant that
    // turned the flag off on purpose. That choice is honoured.
    flagState.enabled = false;
    flagState.degraded = false;
    const res = await request(makeApp()).post("/orders").send(VALID_ORDER);
    expect(res.status).not.toBe(409);
  });

  it("still rejects a malformed body before consulting the flag", async () => {
    // Validation first: a 400 for a broken payload is more useful than a
    // 409 that implies the payload would otherwise have worked.
    const res = await request(makeApp()).post("/orders").send({});
    expect(res.status).toBe(400);
  });
});

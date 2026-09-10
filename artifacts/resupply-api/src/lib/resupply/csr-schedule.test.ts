import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSupabaseMock,
  stageSupabaseResponse as stage,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  loadCsrScheduleContext,
  loadLastSupplyDates,
  resolveCsrSchedule,
  supplyDateKey,
  type ScheduleContext,
} from "./csr-schedule";
const db = installSupabaseMock();
const { flag } = vi.hoisted(() => ({ flag: vi.fn() }));
vi.mock("../feature-flags", () => ({ isFeatureEnabled: flag }));
const now = new Date("2026-09-10T12:00:00Z");
const patient = {
  id: "p",
  created_at: "2025-01-01T12:00:00Z",
  insurance_payer: "Aetna",
  cadence_override_days: null,
  channel_preference: null,
  phone_e164: null,
};
const rx = {
  item_sku: "MASK-100",
  cadence_days: 90,
  created_at: "2026-08-01T12:00:00Z",
};
const rule = {
  id: "rule",
  priority: 1,
  createdAt: now,
  active: true,
  matchItemSkuPrefix: "MASK",
  matchInsurancePayer: "Aetna",
  minTenureDays: null,
  maxTenureDays: null,
  cadenceDays: 30,
  defaultChannel: null,
};
const context: ScheduleContext = { dueAtAuthoritative: false, rules: [rule] };
beforeEach(() => {
  db.reset();
  flag.mockReset().mockResolvedValue(false);
});
describe("CSR dates agree with the reminder scanner", () => {
  it("applies patient override, matching rule, then prescription default", () => {
    expect(
      resolveCsrSchedule(context, patient, rx, "2026-12-01", undefined, now),
    ).toEqual({ cadenceDays: 30, dueAt: "2026-08-31T12:00:00.000Z" });
    expect(
      resolveCsrSchedule(
        context,
        { ...patient, cadence_override_days: 15 },
        rx,
        "2026-12-01",
        undefined,
        now,
      ),
    ).toEqual({ cadenceDays: 15, dueAt: "2026-08-16T12:00:00.000Z" });
    expect(
      resolveCsrSchedule(
        context,
        { ...patient, insurance_payer: "Other" },
        rx,
        "2026-12-01",
        undefined,
        now,
      ),
    ).toEqual({ cadenceDays: 90, dueAt: "2026-10-30T12:00:00.000Z" });
  });
  it("uses stored episode dates only after the cutover", () => {
    expect(
      resolveCsrSchedule(
        { ...context, dueAtAuthoritative: true },
        patient,
        rx,
        "2026-09-12T12:00:00Z",
        "2026-09-09T12:00:00Z",
        now,
      ).dueAt,
    ).toBe("2026-09-12T12:00:00.000Z");
    expect(
      resolveCsrSchedule(
        context,
        patient,
        rx,
        "2026-12-01",
        "2026-09-09T12:00:00Z",
        now,
      ).dueAt,
    ).toBe("2026-10-09T12:00:00.000Z");
    expect(
      resolveCsrSchedule(
        context,
        patient,
        { ...rx, created_at: "bad" },
        "2026-12-01",
        undefined,
        now,
      ).dueAt,
    ).toBeNull();
  });
  it("reads the tenant flag and scoped frequency rules", async () => {
    const result = await loadCsrScheduleContext(
      getOrgScopedClient("org"),
      "org",
    );
    expect(flag).toHaveBeenCalledWith("resupply.due_at_authoritative", "org");
    expect(result.dueAtAuthoritative).toBe(false);
    expect(getSupabaseFilterCalls("frequency_rules", "select")).toContainEqual({
      verb: "eq",
      args: ["org_id", "org"],
    });
  });
  it("pages fulfillment history and prefers shipment evidence per patient and SKU", async () => {
    stage("fulfillments", "select", {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `old-${i}`,
        patient_id: "p",
        item_sku: "MASK-100",
        created_at: "2026-07-01T12:00:00Z",
        shipped_at: null,
      })),
    });
    stage("fulfillments", "select", {
      data: [
        {
          id: "new",
          patient_id: "p",
          item_sku: "MASK-100",
          created_at: "2026-08-01T12:00:00Z",
          shipped_at: "2026-08-05T12:00:00Z",
        },
        {
          id: "queued",
          patient_id: "p",
          item_sku: "TUBE",
          created_at: "2026-09-01T12:00:00Z",
          shipped_at: null,
        },
      ],
    });
    const dates = await loadLastSupplyDates(getOrgScopedClient("org"), ["p"]);
    expect(dates.get(supplyDateKey("p", "MASK-100"))).toBe(
      "2026-08-05T12:00:00Z",
    );
    expect(dates.get(supplyDateKey("p", "TUBE"))).toBe("2026-09-01T12:00:00Z");
    expect(getSupabaseFilterCalls("fulfillments", "select")).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["org_id", "org"] },
        { verb: "neq", args: ["status", "cancelled"] },
        { verb: "range", args: [200, 399] },
      ]),
    );
  });
});

import { describe, expect, it } from "vitest";

import type { getOrgScopedClient } from "@workspace/resupply-db";
import type { DeviceSettings } from "@workspace/resupply-integrations";

import { inferDeviceClass, linkEquipmentFromSnapshot } from "./link-equipment";

// Minimal OrgScopedClient stub for the serial-conflict path: the pre-insert
// lookup and the 23505 re-lookup both see NO in-tenant row, and the insert
// fails with a 23505 unique-violation.
function stubSerialConflictClient(): ReturnType<typeof getOrgScopedClient> {
  const selectChain = {
    eq() {
      return selectChain;
    },
    limit() {
      return selectChain;
    },
    async maybeSingle() {
      return { data: null, error: null };
    },
  };
  const insertChain = {
    select() {
      return insertChain;
    },
    async single() {
      return { data: null, error: { code: "23505" } };
    },
  };
  return {
    from() {
      return {
        select() {
          return selectChain;
        },
        insert() {
          return insertChain;
        },
      };
    },
  } as unknown as ReturnType<typeof getOrgScopedClient>;
}

describe("inferDeviceClass", () => {
  it("defaults to cpap when therapyMode is null/empty", () => {
    expect(inferDeviceClass(null)).toBe("cpap");
    expect(inferDeviceClass("")).toBe("cpap");
    expect(inferDeviceClass(undefined)).toBe("cpap");
  });

  it("maps ResMed AutoSet to auto_cpap", () => {
    expect(inferDeviceClass("AutoSet")).toBe("auto_cpap");
  });

  it("maps APAP-Auto to auto_cpap", () => {
    expect(inferDeviceClass("APAP-Auto")).toBe("auto_cpap");
  });

  it("maps BiPAP to bipap", () => {
    expect(inferDeviceClass("BiPAP")).toBe("bipap");
  });

  it("maps Bilevel-ST to bipap", () => {
    expect(inferDeviceClass("Bilevel-ST")).toBe("bipap");
  });

  it("maps ASV / AVAPS distinctly", () => {
    expect(inferDeviceClass("ASV")).toBe("asv");
    expect(inferDeviceClass("AVAPS")).toBe("avaps");
  });

  it("falls back to cpap for unknown modes", () => {
    expect(inferDeviceClass("MysteryMode42")).toBe("cpap");
  });
});

describe("linkEquipmentFromSnapshot — serial conflict", () => {
  it("returns serial_conflict (does not throw) when a 23505 has no in-tenant row", async () => {
    // Regression: pre-migration-0479 a cross-tenant serial collision tripped
    // the GLOBAL unique index; the org-scoped 23505 re-lookup then found no row
    // and the helper re-threw, 500-ing the whole equipment sync for a
    // collision caused by another tenant's data. It must degrade to a skip.
    const outcome = await linkEquipmentFromSnapshot(
      stubSerialConflictClient(),
      "patient-1",
      {
        deviceModel: "ResMed AirSense 10",
        deviceSerial: "SN-CROSS-TENANT",
      } as unknown as DeviceSettings,
    );
    expect(outcome).toEqual({ kind: "serial_conflict" });
  });
});

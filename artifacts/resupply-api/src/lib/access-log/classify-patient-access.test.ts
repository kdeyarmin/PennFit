import { describe, expect, it } from "vitest";

import { classifyPatientAccess } from "./classify-patient-access";

describe("classifyPatientAccess", () => {
  it("returns null for non-patient admin surfaces", () => {
    expect(classifyPatientAccess("GET", "/resupply-api/admin/me")).toBeNull();
    expect(
      classifyPatientAccess("GET", "/resupply-api/admin/feature-flags"),
    ).toBeNull();
    expect(
      classifyPatientAccess("GET", "/resupply-api/admin/billing-dashboard"),
    ).toBeNull();
    // The audit report itself must never be recorded.
    expect(
      classifyPatientAccess(
        "GET",
        "/resupply-api/admin/patient-access-log?from=x",
      ),
    ).toBeNull();
  });

  it("records a patient detail view with the patient id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const d = classifyPatientAccess("GET", `/resupply-api/patients/${id}`);
    expect(d).toEqual({
      action: "patients.view",
      targetTable: "patients",
      targetId: id,
      patientId: id,
    });
  });

  it("derives the verb from the HTTP method", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(
      classifyPatientAccess("PATCH", `/resupply-api/patients/${id}`)?.action,
    ).toBe("patients.update");
    expect(
      classifyPatientAccess("DELETE", `/resupply-api/patients/${id}`)?.action,
    ).toBe("patients.delete");
    expect(
      classifyPatientAccess("POST", `/resupply-api/patients`)?.action,
    ).toBe("patients.create");
  });

  it("captures non-uuid customer ids as the patient id", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/customers/cus_ABC123",
    );
    expect(d).toEqual({
      action: "customers.view",
      targetTable: "customers",
      targetId: "cus_ABC123",
      patientId: "cus_ABC123",
    });
  });

  it("does not treat verb sub-paths as ids", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/customers/export",
    );
    expect(d).toEqual({
      action: "customers.view",
      targetTable: "customers",
      targetId: null,
      patientId: null,
    });
  });

  it("records related resources without a patient id", () => {
    const convId = "33333333-3333-4333-8333-333333333333";
    const d = classifyPatientAccess(
      "GET",
      `/resupply-api/conversations/${convId}`,
    );
    expect(d).toEqual({
      action: "conversations.view",
      targetTable: "conversations",
      targetId: convId,
      patientId: null,
    });
  });

  it("does not let /admin/customers swallow /admin/customer-notes", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/customer-notes?customerId=x",
    );
    expect(d?.targetTable).toBe("customers");
    expect(d?.action).toBe("customers.view");
  });

  it("matches under the /api mount as well as /resupply-api", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(classifyPatientAccess("GET", `/api/patients/${id}`)?.patientId).toBe(
      id,
    );
  });
});

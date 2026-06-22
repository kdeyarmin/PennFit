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

  it("records the /admin/patients/:id/onboarding family against the patient", () => {
    // Codex/Copilot P1: this admin per-patient namespace was previously
    // missed because only `/patients` was in the allowlist.
    const id = "55555555-5555-4555-8555-555555555555";
    const d = classifyPatientAccess(
      "GET",
      `/resupply-api/admin/patients/${id}/onboarding`,
    );
    expect(d).toEqual({
      action: "patients.view",
      targetTable: "patients",
      targetId: id,
      patientId: id,
    });
  });

  it("does not treat the /admin/patients/clinical-encounters/query sub-collection as a patient", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/patients/clinical-encounters/query",
    );
    expect(d).toMatchObject({
      action: "patients.view",
      targetTable: "patients",
      targetId: null,
      patientId: null,
    });
  });

  it("records the real /admin/shop/customers surface (not the old guessed prefix)", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/shop/customers/cus_ABC123",
    );
    expect(d).toEqual({
      action: "customers.view",
      targetTable: "customers",
      targetId: "cus_ABC123",
      patientId: "cus_ABC123",
    });
  });

  it("records customer sub-routes (notes/timeline/followups) against the customer id", () => {
    const d = classifyPatientAccess(
      "POST",
      "/resupply-api/admin/shop/customers/cus_ABC123/notes",
    );
    expect(d).toEqual({
      action: "customers.create",
      targetTable: "customers",
      targetId: "cus_ABC123",
      patientId: "cus_ABC123",
    });
  });

  it("does not treat verb sub-paths as ids", () => {
    // `/patients/merge` is a real bulk action, not a patient id.
    const d = classifyPatientAccess("POST", "/resupply-api/patients/merge");
    expect(d).toEqual({
      action: "patients.create",
      targetTable: "patients",
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

  it("records shop orders at the real /admin/shop/orders path", () => {
    const orderId = "66666666-6666-4666-8666-666666666666";
    const d = classifyPatientAccess(
      "GET",
      `/resupply-api/admin/shop/orders/${orderId}/notes`,
    );
    expect(d).toEqual({
      action: "orders.view",
      targetTable: "orders",
      targetId: orderId,
      patientId: null,
    });
  });

  it("records the /admin/clinical/outreach surface", () => {
    const d = classifyPatientAccess(
      "GET",
      "/resupply-api/admin/clinical/outreach/eligible",
    );
    expect(d).toMatchObject({
      targetTable: "clinical_outreach",
      action: "clinical_outreach.view",
      patientId: null,
    });
  });

  it("matches under the /api mount as well as /resupply-api", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(classifyPatientAccess("GET", `/api/patients/${id}`)?.patientId).toBe(
      id,
    );
  });
});

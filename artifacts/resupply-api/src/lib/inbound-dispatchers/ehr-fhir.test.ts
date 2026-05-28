// Tests for the EHR FHIR dispatcher.
//
// The dispatcher itself is small — it does signature verification +
// FHIR Bundle parsing + handoff to landReferralFromOrder. We focus on
// the pure branches that don't hit any downstream:
//
//   * signature_verified=false → permanent failure
//   * parseFhirBundle returns {ok:false, reason} → permanent failure
//     with `parse_<reason>` propagated
//   * On parse success, calls landReferralFromOrder with the parsed
//     order + correct dispatcherLabel/source

import { describe, it, expect, vi, beforeEach } from "vitest";

const { parseFhirBundleMock } = vi.hoisted(() => ({
  parseFhirBundleMock: vi.fn(),
}));
vi.mock("@workspace/resupply-integrations-ehr-fhir", () => ({
  parseFhirBundle: parseFhirBundleMock,
}));

const { landReferralFromOrderMock } = vi.hoisted(() => ({
  landReferralFromOrderMock: vi.fn(),
}));
vi.mock("./land-referral", () => ({
  landReferralFromOrder: landReferralFromOrderMock,
}));

import { dispatchEhrFhir } from "./ehr-fhir";

beforeEach(() => {
  parseFhirBundleMock.mockReset();
  landReferralFromOrderMock.mockReset();
});

describe("dispatchEhrFhir", () => {
  it("refuses when signature_verified is false", async () => {
    const out = await dispatchEhrFhir({
      row: {
        id: "wh_1",
        source: "ehr_fhir_test",
        payload_json: {},
        signature_verified: false,
      },
    });
    expect(out).toEqual({
      ok: false,
      permanent: true,
      reason: "signature_not_verified",
    });
    expect(parseFhirBundleMock).not.toHaveBeenCalled();
    expect(landReferralFromOrderMock).not.toHaveBeenCalled();
  });

  it("returns permanent parse_<reason> on bundle parse failure", async () => {
    parseFhirBundleMock.mockReturnValueOnce({
      ok: false,
      reason: "missing_patient",
    });
    const out = await dispatchEhrFhir({
      row: {
        id: "wh_1",
        source: "ehr_fhir_test",
        payload_json: { foo: "bar" },
        signature_verified: true,
      },
    });
    expect(out).toEqual({
      ok: false,
      permanent: true,
      reason: "parse_missing_patient",
    });
  });

  it("hands off to landReferralFromOrder with dispatcherLabel='ehr_fhir' on parse success", async () => {
    const fakeOrder = {
      sourceOrderId: "fhir_xyz",
      eventType: "new",
      patient: { firstName: null, lastName: null, dob: null, phoneE164: null },
      provider: { npi: null, lastName: null, firstName: null },
      payerName: null,
      hcpcsLines: [],
      icd10Codes: [],
      documents: [],
      occurredAt: "2026-01-01T00:00:00Z",
    };
    parseFhirBundleMock.mockReturnValueOnce({ ok: true, order: fakeOrder });
    landReferralFromOrderMock.mockResolvedValueOnce({
      ok: true,
      referralId: "ref_1",
      deduped: false,
    });

    const out = await dispatchEhrFhir({
      row: {
        id: "wh_1",
        source: "ehr_fhir_test",
        payload_json: { resourceType: "Bundle" },
        signature_verified: true,
      },
    });
    expect(out).toEqual({ ok: true, referralId: "ref_1", deduped: false });
    expect(landReferralFromOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ehr_fhir_test",
        inboundWebhookId: "wh_1",
        order: fakeOrder,
        dispatcherLabel: "ehr_fhir",
      }),
    );
  });
});

// Tests for the Parachute inbound dispatcher.
//
// Coverage:
//   * Returns parachute_unconfigured when PARACHUTE_SIGNING_SECRET absent
//   * Returns permanent signature_not_verified when inbound row not verified
//   * Returns permanent parse_invalid_shape on bad payload
//   * Hands off to landReferralFromOrder with dispatcherLabel='parachute'

import { describe, it, expect, vi, beforeEach } from "vitest";

const { readParachuteConfigMock, parseParachuteOrderMock } = vi.hoisted(() => ({
  readParachuteConfigMock: vi.fn(),
  parseParachuteOrderMock: vi.fn(),
}));
vi.mock("@workspace/resupply-integrations-parachute", () => ({
  readParachuteConfigOrNull: readParachuteConfigMock,
  parseParachuteOrder: parseParachuteOrderMock,
}));

const { landReferralFromOrderMock } = vi.hoisted(() => ({
  landReferralFromOrderMock: vi.fn(),
}));
vi.mock("./land-referral", () => ({
  landReferralFromOrder: landReferralFromOrderMock,
}));

import { dispatchParachute } from "./parachute";

const ROW = {
  id: "wh_1",
  source: "parachute",
  payload_json: { foo: "bar" },
  verification_headers_json: {},
  signature_verified: true as boolean,
};

beforeEach(() => {
  readParachuteConfigMock.mockReset();
  parseParachuteOrderMock.mockReset();
  landReferralFromOrderMock.mockReset();
});

describe("dispatchParachute", () => {
  it("returns parachute_unconfigured when config is absent", async () => {
    readParachuteConfigMock.mockReturnValueOnce(null);
    const out = await dispatchParachute({ row: ROW, env: {} });
    expect(out).toEqual({
      ok: false,
      permanent: false,
      reason: "parachute_unconfigured",
    });
  });

  it("refuses when signature_verified is false", async () => {
    readParachuteConfigMock.mockReturnValueOnce({ signingSecret: "shh" });
    const out = await dispatchParachute({
      row: { ...ROW, signature_verified: false },
      env: { PARACHUTE_SIGNING_SECRET: "shh" },
    });
    expect(out).toEqual({
      ok: false,
      permanent: true,
      reason: "signature_not_verified",
    });
  });

  it("returns permanent parse_invalid_shape on bad payload", async () => {
    readParachuteConfigMock.mockReturnValueOnce({ signingSecret: "shh" });
    parseParachuteOrderMock.mockReturnValueOnce({
      ok: false,
      reason: "missing_field",
    });
    const out = await dispatchParachute({ row: ROW, env: {} });
    expect(out).toEqual({
      ok: false,
      permanent: true,
      reason: "parse_invalid_shape",
    });
  });

  it("hands off to landReferralFromOrder with dispatcherLabel='parachute'", async () => {
    readParachuteConfigMock.mockReturnValueOnce({ signingSecret: "shh" });
    const fakeOrder = {
      sourceOrderId: "para_1",
      eventType: "new",
      patient: { firstName: null, lastName: null, dob: null, phoneE164: null },
      provider: { npi: null, lastName: null, firstName: null },
      payerName: null,
      hcpcsLines: [],
      icd10Codes: [],
      documents: [],
      occurredAt: "2026-01-01T00:00:00Z",
    };
    parseParachuteOrderMock.mockReturnValueOnce({ ok: true, order: fakeOrder });
    landReferralFromOrderMock.mockResolvedValueOnce({
      ok: true,
      referralId: "ref_1",
      deduped: false,
    });
    const out = await dispatchParachute({ row: ROW, env: {} });
    expect(out).toEqual({ ok: true, referralId: "ref_1", deduped: false });
    expect(landReferralFromOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "parachute",
        inboundWebhookId: "wh_1",
        dispatcherLabel: "parachute",
        order: fakeOrder,
      }),
    );
  });
});

import { describe, expect, it } from "vitest";

import { parseClaimResponse } from "./parse-claim-response";

describe("parseClaimResponse", () => {
  it("returns pended when payload is null/empty/non-ClaimResponse", () => {
    expect(parseClaimResponse(null).decision).toBe("pended");
    expect(parseClaimResponse({}).decision).toBe("pended");
    expect(parseClaimResponse({ resourceType: "Patient" }).decision).toBe(
      "pended",
    );
  });

  it("extracts an approval decision + auth number from a bare ClaimResponse", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      disposition: "Approved per medical-necessity review",
      preAuthRef: "PA-9988-XYZ",
      item: [
        {
          adjudication: [
            {
              category: { coding: [{ code: "approved" }] },
            },
          ],
        },
      ],
    });
    expect(r.decision).toBe("approved");
    expect(r.authNumber).toBe("PA-9988-XYZ");
    expect(r.dispositionText).toContain("Approved");
  });

  it("extracts denial with reason from error[].code.display", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      disposition: "Denied — see error detail",
      item: [
        {
          adjudication: [{ category: { coding: [{ code: "denied" }] } }],
        },
      ],
      error: [
        {
          code: { coding: [{ display: "Missing sleep study documentation" }] },
        },
      ],
    });
    expect(r.decision).toBe("denied");
    expect(r.denialReason).toContain("sleep study");
  });

  it("unwraps a Bundle containing a ClaimResponse", () => {
    const r = parseClaimResponse({
      resourceType: "Bundle",
      type: "collection",
      entry: [
        {
          resource: {
            resourceType: "ClaimResponse",
            outcome: "complete",
            preAuthRef: "PA-FROM-BUNDLE",
            item: [
              {
                adjudication: [
                  { category: { coding: [{ code: "approved" }] } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(r.decision).toBe("approved");
    expect(r.authNumber).toBe("PA-FROM-BUNDLE");
  });

  it("falls back to disposition text as denial reason when error[] is empty", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      disposition: "Service does not meet coverage criteria",
      item: [
        {
          adjudication: [{ category: { coding: [{ code: "denied" }] } }],
        },
      ],
    });
    expect(r.decision).toBe("denied");
    expect(r.denialReason).toBe("Service does not meet coverage criteria");
  });

  it("treats outcome=error as denied when no item-level code is present", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "error",
      disposition: "Invalid submitter id",
    });
    expect(r.decision).toBe("denied");
  });

  it("handles preAuthRef as an array (some payer implementations)", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      preAuthRef: ["PA-FIRST", "PA-SECOND"],
      item: [
        {
          adjudication: [{ category: { coding: [{ code: "approved" }] } }],
        },
      ],
    });
    expect(r.authNumber).toBe("PA-FIRST");
  });

  it("returns pended for explicit pended adjudication code", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "queued",
      item: [
        {
          adjudication: [{ category: { coding: [{ code: "pending" }] } }],
        },
      ],
    });
    expect(r.decision).toBe("pended");
  });

  it("does NOT treat a `submitted` financial adjudication line as approval", () => {
    // `submitted` is the FHIR financial category for the billed amount;
    // it rides along on denied claims too. A denial whose first
    // adjudication line is `submitted` must still resolve to denied.
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      item: [
        {
          adjudication: [
            {
              category: { coding: [{ code: "submitted" }] },
              amount: { value: 249.99 },
            },
            { category: { coding: [{ code: "denied" }] } },
          ],
        },
      ],
    });
    expect(r.decision).toBe("denied");
  });

  it("stays pended when the only adjudication code is `submitted`/`complete` (no real decision)", () => {
    const submittedOnly = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      item: [
        {
          adjudication: [
            {
              category: { coding: [{ code: "submitted" }] },
              amount: { value: 100 },
            },
          ],
        },
      ],
    });
    expect(submittedOnly.decision).toBe("pended");
  });

  // requestIdentifier is the security-critical field: the route compares it
  // against the locally-sent claim identifier before applying any state
  // change, so a misrouted / replayed / compromised payer response can't
  // overwrite the wrong prior authorization. These cases lock in the
  // extraction precedence and the null-when-absent contract.
  it("extracts requestIdentifier from ClaimResponse.request.identifier.value", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      request: { identifier: { value: "pa-1234abcd-1" } },
      // identifier[0] present too — request.identifier must win.
      identifier: [{ value: "should-not-be-used" }],
    });
    expect(r.requestIdentifier).toBe("pa-1234abcd-1");
  });

  it("falls back to identifier[0].value when request.identifier is absent", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      identifier: [{ value: "pa-5678efgh-2" }, { value: "ignored-second" }],
    });
    expect(r.requestIdentifier).toBe("pa-5678efgh-2");
  });

  it("returns null requestIdentifier when neither field is present", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
    });
    expect(r.requestIdentifier).toBeNull();
  });

  it("returns null requestIdentifier when there is no ClaimResponse in the payload", () => {
    expect(parseClaimResponse(null).requestIdentifier).toBeNull();
    expect(parseClaimResponse({ resourceType: "Patient" }).requestIdentifier).toBeNull();
  });

  it("resolves requestIdentifier through a Bundle-wrapped ClaimResponse", () => {
    const r = parseClaimResponse({
      resourceType: "Bundle",
      entry: [
        { resource: { resourceType: "OperationOutcome" } },
        {
          resource: {
            resourceType: "ClaimResponse",
            outcome: "complete",
            request: { identifier: { value: "pa-bundle-9" } },
          },
        },
      ],
    });
    expect(r.requestIdentifier).toBe("pa-bundle-9");
  });

  it("ignores a non-string request.identifier.value (treats as absent)", () => {
    const r = parseClaimResponse({
      resourceType: "ClaimResponse",
      outcome: "complete",
      request: { identifier: { value: 12345 } },
      identifier: [{ value: "pa-fallback-3" }],
    });
    expect(r.requestIdentifier).toBe("pa-fallback-3");
  });
});

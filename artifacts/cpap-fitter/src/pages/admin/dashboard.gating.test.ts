// Who is offered the Home quick fitter-invite sender.
//
// Home is the one page every staff member lands on, so this card is the
// first place an inapplicable action would reach the wrong people: the
// `clinician` bucket (DB role `rt`) has no `conversations.manage`, and a
// tenant can switch the whole storefront module off. Both must hide it.

import { describe, expect, it } from "vitest";

import { canQuickSendFitterInvite } from "./dashboard";

const CSR = { permissions: ["patients.read", "conversations.manage"] };

describe("canQuickSendFitterInvite", () => {
  it("offers it to staff who hold conversations.manage", () => {
    expect(canQuickSendFitterInvite(CSR)).toBe(true);
  });

  it("hides it from an RT, whose role the send endpoint would 403", () => {
    // The clinician bucket's real permission set — no conversations.manage.
    expect(
      canQuickSendFitterInvite({
        permissions: [
          "patients.read",
          "clinical.read",
          "clinical.note.write",
          "clinical.intervention.write",
          "formulary.manage",
          "fit_session.override",
        ],
      }),
    ).toBe(false);
  });

  it("hides it when the tenant switched the storefront module off", () => {
    expect(
      canQuickSendFitterInvite({
        ...CSR,
        disabledFeatures: ["module.storefront"],
      }),
    ).toBe(false);
  });

  it("still offers it when some other module is off", () => {
    expect(
      canQuickSendFitterInvite({
        ...CSR,
        disabledFeatures: ["module.billing", "module.therapy"],
      }),
    ).toBe(true);
  });

  it("fails closed on permissions while /me is still in flight", () => {
    expect(canQuickSendFitterInvite({})).toBe(false);
  });

  it("fails open on features, matching how AppShell treats the flag table", () => {
    // An unreadable flag table reports no disabled features; that must
    // show the console whole, not strip it.
    expect(canQuickSendFitterInvite({ ...CSR, disabledFeatures: [] })).toBe(
      true,
    );
  });
});

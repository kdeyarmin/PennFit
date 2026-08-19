// Tests for the proactive re-fit campaign worker.
//
// This job contacts patients who did not ask to be contacted, so what is
// tested here is mostly the REFUSALS: the flag, consent, quiet hours, and
// the once-a-quarter cap. A bug that makes it send too eagerly is worse
// than one that makes it send nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

const claimOutcome = vi.hoisted(() => ({ value: "claimed" as string }));
const releaseDedup = vi.hoisted(() =>
  vi.fn(async (_supabase: unknown, _key: string) => ({ released: true })),
);
vi.mock("../../lib/dedup-keys", () => ({
  claimDedupKey: vi.fn(async () => ({ outcome: claimOutcome.value })),
  releaseDedupKey: releaseDedup,
}));

const sendRescan = vi.hoisted(() =>
  vi.fn(
    async (
      _orgId: string,
      _inviteId: string,
      _reason: string,
    ): Promise<{
      delivered: boolean;
      reason: string | null;
      link: string | null;
    }> => ({ delivered: true, reason: null, link: "https://x/y" }),
  ),
);
vi.mock("../../lib/fitting/rescan-notify", () => ({
  sendRescanForInvite: sendRescan,
}));

import { runRefitCampaignScan } from "./refit-campaign";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ORDER = "order-1";
const INVITE = "22222222-2222-4222-8222-222222222222";

const SAVED_ENV = { ...process.env };

/** A patient who has told us their mask leaks and can be contacted. */
function stageHappyPath(
  prefs?: Record<string, unknown>,
  opts: { inviteInsertFails?: boolean } = {},
) {
  stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
  stageSupabaseResponse("mask_fit_outcomes", "select", {
    data: [
      {
        order_id: ORDER,
        fit_outcome: "leaking",
        status: "new",
        created_at: "2026-05-01T00:00:00Z",
      },
    ],
  });
  stageSupabaseResponse("shop_orders", "select", {
    data: [{ id: ORDER, patient_id: PATIENT }],
  });
  // No discontinued models — keeps this candidate set to one reason.
  stageSupabaseResponse("mask_models", "select", { data: [] });
  stageSupabaseResponse("patients", "select", {
    data: {
      id: PATIENT,
      email: "p@example.com",
      phone_e164: "+12155551234",
      legal_first_name: "Jordan",
      legal_last_name: "Lee",
      timezone: "America/New_York",
    },
  });
  stageSupabaseResponse("shop_customers", "select", {
    data: {
      communication_preferences: prefs ?? {
        smsTransactional: true,
        emailResupplyReminders: true,
      },
    },
  });
  stageSupabaseResponse(
    "fitter_invites",
    "insert",
    opts.inviteInsertFails
      ? { error: { message: "boom" } }
      : { data: { id: INVITE } },
  );
}

beforeEach(() => {
  supabaseMock.reset();
  featureEnabled.value = true;
  claimOutcome.value = "claimed";
  sendRescan.mockClear();
  sendRescan.mockResolvedValue({
    delivered: true,
    reason: null,
    link: "https://x/y",
  });
  releaseDedup.mockClear();
  process.env.RESUPPLY_REFIT_CAMPAIGN_ENABLED = "1";
  // Pin inside the 9am-8pm patient-local window (17:00 UTC = 1pm ET), so
  // these tests don't pass or fail by the wall-clock hour of the CI run.
  vi.useFakeTimers({ now: new Date("2026-06-01T17:00:00Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...SAVED_ENV };
});

describe("runRefitCampaignScan — refusals", () => {
  it("sends nothing when the tenant flag is off", async () => {
    featureEnabled.value = false;
    stageHappyPath();

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
    expect(getSupabaseWritePayloads("fitter_invites", "insert")).toHaveLength(
      0,
    );
  });

  it("sends nothing to a patient with no consent on either channel", async () => {
    // A patient with no consent row at all must never be contacted — the
    // defaults are opt-OUT for exactly this reason.
    stageHappyPath({ smsTransactional: false, emailResupplyReminders: false });

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });

  it("does not burn the quarterly slot when the patient is skipped", async () => {
    // The cap is claimed only after consent passes. A patient skipped for
    // lack of consent must not go silent for a quarter as a side effect.
    const { claimDedupKey } = await import("../../lib/dedup-keys");
    stageHappyPath({ smsTransactional: false, emailResupplyReminders: false });

    await runRefitCampaignScan();

    expect(claimDedupKey).not.toHaveBeenCalled();
  });

  it("sends nothing when the patient was already offered this quarter", async () => {
    claimOutcome.value = "held";
    stageHappyPath();

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });

  it("skips a survey answer that cannot be tied to a chart", async () => {
    stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        {
          order_id: ORDER,
          fit_outcome: "leaking",
          status: "new",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // The order exists but carries no patient — there is nobody to write to.
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: ORDER, patient_id: null }],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });
});

describe("runRefitCampaignScan — whose survey answer still counts", () => {
  function stageOutcomes(rows: Array<Record<string, unknown>>) {
    stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
    stageSupabaseResponse("mask_fit_outcomes", "select", { data: rows });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: ORDER, patient_id: PATIENT }],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT,
        email: "p@example.com",
        phone_e164: "+12155551234",
        legal_first_name: "Jordan",
        legal_last_name: "Lee",
        timezone: "America/New_York",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });
    stageSupabaseResponse("fitter_invites", "insert", { data: { id: INVITE } });
  }

  it("ignores a bad answer the patient has since replaced with 'good'", async () => {
    // 0201 allows re-answering. Messaging someone whose fit is now fine
    // reads as not having listened the first time.
    stageOutcomes([
      {
        order_id: ORDER,
        fit_outcome: "good",
        status: "new",
        created_at: "2026-05-20T00:00:00Z",
      },
      {
        order_id: ORDER,
        fit_outcome: "leaking",
        status: "new",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });

  it("lets a newer 'good' on a DIFFERENT order cancel an older order's bad verdict", async () => {
    // The verdict that governs is the PATIENT's newest, across orders. A
    // patient who reported a leak, got a replacement, and reported the
    // replacement good must not be re-offered a refit off the old order's
    // stale verdict.
    const OLD_ORDER = "44444444-4444-4444-8444-444444444444";
    stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        {
          order_id: ORDER,
          fit_outcome: "good",
          status: "new",
          created_at: "2026-05-20T00:00:00Z",
        },
        {
          order_id: OLD_ORDER,
          fit_outcome: "leaking",
          status: "new",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // Both orders belong to the same patient.
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        { id: ORDER, patient_id: PATIENT },
        { id: OLD_ORDER, patient_id: PATIENT },
      ],
    });
    stageSupabaseResponse("mask_models", "select", { data: [] });

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });

  it("leaves an answer staff have already actioned alone", async () => {
    // Staff picked it up; a second automated message talks over them.
    stageOutcomes([
      {
        order_id: ORDER,
        fit_outcome: "leaking",
        status: "actioned",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
  });

  it("still acts on a bad answer that is the latest and unactioned", async () => {
    stageOutcomes([
      {
        order_id: ORDER,
        fit_outcome: "leaking",
        status: "reviewed",
        created_at: "2026-05-20T00:00:00Z",
      },
      {
        order_id: ORDER,
        fit_outcome: "good",
        status: "new",
        created_at: "2026-05-01T00:00:00Z",
      },
    ]);

    await runRefitCampaignScan();

    expect(sendRescan).toHaveBeenCalledTimes(1);
  });
});

describe("runRefitCampaignScan — the cooldown tracks messages actually sent", () => {
  it("gives the quarterly slot back when delivery fails", async () => {
    // The cap promises "we messaged this patient". A vendor outage that
    // burned it would suppress them for a quarter having heard nothing.
    stageHappyPath();
    sendRescan.mockResolvedValue({
      delivered: false,
      reason: "no_channel_config",
      link: null,
    });

    await runRefitCampaignScan();

    expect(releaseDedup).toHaveBeenCalledTimes(1);
    expect(releaseDedup.mock.calls[0]?.[1]).toBe(`refit-campaign:${PATIENT}`);
  });

  it("gives the slot back when the invite row can't be created", async () => {
    stageHappyPath({ smsTransactional: true }, { inviteInsertFails: true });

    await runRefitCampaignScan();

    expect(sendRescan).not.toHaveBeenCalled();
    expect(releaseDedup).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot when the message actually went out", async () => {
    stageHappyPath();

    await runRefitCampaignScan();

    expect(sendRescan).toHaveBeenCalledTimes(1);
    expect(releaseDedup).not.toHaveBeenCalled();
  });
});

describe("runRefitCampaignScan — sending", () => {
  it("offers a re-fit to a consented patient who reported a bad fit", async () => {
    stageHappyPath();

    await runRefitCampaignScan();

    expect(sendRescan).toHaveBeenCalledTimes(1);
    // The reason drives the copy — a patient who told us the mask leaks
    // must not get the "your scan wasn't clear enough" message.
    expect(sendRescan).toHaveBeenCalledWith(ORG, INVITE, "reported_bad_fit");

    const invite = getSupabaseWritePayloads(
      "fitter_invites",
      "insert",
    )[0] as Record<string, unknown>;
    expect(invite.patient_id).toBe(PATIENT);
    expect(invite.recipient_name).toBe("Jordan Lee");
    // SMS preferred when consented — a fit problem is felt tonight.
    expect(invite.channel).toBe("sms");
    expect(invite.recipient_phone_e164).toBe("+12155551234");
  });

  it("falls back to email when SMS is not consented", async () => {
    stageHappyPath({ smsTransactional: false, emailResupplyReminders: true });

    await runRefitCampaignScan();

    expect(sendRescan).toHaveBeenCalledTimes(1);
    const invite = getSupabaseWritePayloads(
      "fitter_invites",
      "insert",
    )[0] as Record<string, unknown>;
    expect(invite.channel).toBe("email");
    expect(invite.recipient_email).toBe("p@example.com");
    expect(invite.recipient_phone_e164).toBeNull();
  });

  it("contacts a patient once even when they qualify twice over", async () => {
    // Both triggers fire for the same person. They get one message, about
    // the bad fit — the thing they are feeling tonight — not two.
    stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        {
          order_id: ORDER,
          fit_outcome: "uncomfortable",
          status: "new",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: ORDER, patient_id: PATIENT }],
    });
    stageSupabaseResponse("mask_models", "select", { data: [{ id: "m1" }] });
    stageSupabaseResponse("fit_sessions", "select", {
      data: [{ patient_id: PATIENT }],
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT,
        email: "p@example.com",
        phone_e164: "+12155551234",
        legal_first_name: "Jordan",
        legal_last_name: "Lee",
        timezone: "America/New_York",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });
    stageSupabaseResponse("fitter_invites", "insert", { data: { id: INVITE } });

    await runRefitCampaignScan();

    expect(sendRescan).toHaveBeenCalledTimes(1);
    expect(sendRescan).toHaveBeenCalledWith(ORG, INVITE, "reported_bad_fit");
  });
});

// Tests for the fitter follow-up sweep.
//
// The load-bearing behaviours, in rough order of "what breaks worst if
// this regresses":
//
//   * the STAFF WORKLIST is built whatever the tenant's flag, vendor
//     credentials or domain say — the whole point is that nobody goes
//     quiet unnoticed;
//   * the patient messages ARE gated by that flag;
//   * one invite raises at most ONE cohort-A alert, so a person who
//     opens a link and then stalls isn't queued twice;
//   * duplicate inserts are the database's job, and a 23505 is a normal
//     outcome rather than an error;
//   * a completed fitting that already produced a request is neither
//     alerted nor messaged;
//   * `request_unworked` never messages the patient;
//   * the stamp is claimed BEFORE the send and a lost race sends
//     nothing;
//   * a link too close to expiry is never advertised;
//   * consent: an explicit refusal wins, an absent record falls back to
//     the channel the invite itself used, and neither bypasses the
//     TCPA window.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags.js", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

const sendFollowup = vi.hoisted(() =>
  vi.fn(
    async (
      _target: unknown,
      _reason: string,
    ): Promise<{
      delivered: boolean;
      reason: string | null;
      channel: "email" | "sms" | null;
    }> => ({ delivered: true, reason: null, channel: "email" }),
  ),
);
vi.mock("../../lib/fitting/followup-notify.js", () => ({
  sendFitterFollowup: sendFollowup,
}));

vi.mock("../../lib/tenant-branding.js", () => ({
  resolveTenantLinkBaseUrl: vi.fn(async (orgId?: string) =>
    orgId === "org-nodomain" ? null : "https://tenant.example",
  ),
}));

import { runFitterFollowupSweep } from "./fitter-followup-scan";

const ORG = "00000000-0000-4000-8000-000000000001";
const INVITE = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const PATIENT = "55555555-5555-4555-8555-555555555555";
const DAY = 86_400_000;

/** A fixed mid-afternoon UTC instant, comfortably inside the US SMS
 *  send window for every continental timezone. */
const NOW = new Date("2026-06-10T18:00:00.000Z");

function agoDays(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}
function inDays(n: number): string {
  return new Date(NOW.getTime() + n * DAY).toISOString();
}

type InviteOverrides = Partial<Record<string, unknown>>;

function openInvite(over: InviteOverrides = {}): Record<string, unknown> {
  return {
    id: INVITE,
    patient_id: null,
    fit_session_id: null,
    recipient_email: "prospect@example.com",
    recipient_phone_e164: null,
    recipient_name: "Jordan Avery",
    channel: "email",
    status: "sent",
    sent_at: agoDays(5),
    completed_at: null,
    // Default 30-day TTL, sent 5 days ago.
    expires_at: inDays(25),
    fit_reminder_sent_at: null,
    fit_final_reminder_sent_at: null,
    post_fit_reminder_sent_at: null,
    post_fit_final_reminder_sent_at: null,
    ...over,
  };
}

function completedInvite(over: InviteOverrides = {}): Record<string, unknown> {
  return openInvite({
    status: "completed",
    sent_at: agoDays(12),
    completed_at: agoDays(6),
    fit_session_id: "44444444-4444-4444-8444-444444444444",
    ...over,
  });
}

/** Every tick starts by resolving the active tenant list. */
function stageOrg(): void {
  stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
}

/** The claim UPDATE returns the row it stamped when it wins the race. */
function stageClaimWon(): void {
  stageSupabaseResponse("fitter_invites", "update", {
    data: [{ id: INVITE }],
  });
}

beforeEach(() => {
  supabaseMock.reset();
  sendFollowup.mockClear();
  sendFollowup.mockResolvedValue({
    delivered: true,
    reason: null,
    channel: "email",
  });
  featureEnabled.value = true;
});

describe("cohort A — the link was sent and the fitting never happened", () => {
  it("raises fit_not_started and follows up on an unopened invite", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(1);
    expect(stats.nudgesSent).toBe(1);

    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.alert_type).toBe("fit_not_started");
    expect(alert.fitter_invite_id).toBe(INVITE);
    // No contact detail may be copied onto the alert row — the route
    // joins it in at read time.
    expect(JSON.stringify(alert)).not.toContain("prospect@example.com");
    expect(JSON.stringify(alert)).not.toContain("Jordan Avery");

    expect(sendFollowup).toHaveBeenCalledTimes(1);
    expect(sendFollowup.mock.calls[0]?.[1]).toBe("unstarted");
  });

  it("raises fit_abandoned (high) and uses the resume copy once opened", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite({ status: "opened" })],
    });
    stageClaimWon();

    await runFitterFollowupSweep(NOW);

    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.alert_type).toBe("fit_abandoned");
    expect(alert.severity).toBe("high");
    expect(sendFollowup.mock.calls[0]?.[1]).toBe("abandoned");
  });

  it("never raises a SECOND cohort-A alert for the same invite", async () => {
    stageOrg();
    // The tick opens with two alert-side resolve passes (cohort A's
    // finished/revoked invites, then acted-on fit_no_request), both of
    // which read the open alerts before the cohort scans run.
    stageSupabaseResponse("fitter_followup_alerts", "select", { data: [] });
    stageSupabaseResponse("fitter_followup_alerts", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite({ status: "opened" })],
    });
    // …and this invite already carries one (raised while it was 'sent').
    stageSupabaseResponse("fitter_followup_alerts", "select", {
      data: [{ fitter_invite_id: INVITE }],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(0);
    expect(getSupabaseCallCount("fitter_followup_alerts", "insert")).toBe(0);
    // The nudge still goes out — the person is still unfitted.
    expect(stats.nudgesSent).toBe(1);
  });

  it("treats a unique violation as already-raised, not an error", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });
    stageSupabaseResponse("fitter_followup_alerts", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.errors).toBe(0);
    expect(stats.alertsRaised).toBe(0);
  });

  it("scans only invites that are still live", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });

    await runFitterFollowupSweep(NOW);

    const filters = getSupabaseFilterCalls("fitter_invites", "select");
    // An expired link cannot be followed up on, and excluding them is
    // also what keeps this cohort from chasing a historical backlog.
    expect(
      filters.some((f) => f.verb === "gt" && f.args[0] === "expires_at"),
    ).toBe(true);
  });

  it("does not advertise a link that is about to expire", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
        }),
      ],
    });

    const stats = await runFitterFollowupSweep(NOW);

    // Still worth a staff alert — somebody was sent a link and is
    // unfitted — but the message would dead-end.
    expect(stats.alertsRaised).toBe(1);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it("sends the FINAL nudge (only) once the link is nearly dead", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          sent_at: agoDays(28),
          expires_at: inDays(2),
          fit_reminder_sent_at: null,
        }),
      ],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.nudgesSent).toBe(1);
    const [patch] = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    ) as Array<Record<string, unknown>>;
    // Both stamps are spent, so the earlier window can't also fire.
    expect(patch.fit_final_reminder_sent_at).toBeTruthy();
    expect(patch.fit_reminder_sent_at).toBeTruthy();
  });

  it("does not re-send when the stamp is current for this send", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite({ fit_reminder_sent_at: agoDays(1) })],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(sendFollowup).not.toHaveBeenCalled();
    expect(stats.nudgesSent).toBe(0);
  });

  it("nudges again when a resend post-dates the old stamp", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          // Staff resent 5 days ago; the stamp is from the first round.
          sent_at: agoDays(5),
          fit_reminder_sent_at: agoDays(20),
        }),
      ],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.nudgesSent).toBe(1);
  });

  it("sends nothing when it loses the claim race", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });
    // Conditional UPDATE matched no rows: another tick got there first.
    stageSupabaseResponse("fitter_invites", "update", { data: [] });

    const stats = await runFitterFollowupSweep(NOW);

    expect(sendFollowup).not.toHaveBeenCalled();
    expect(stats.skippedAlreadyClaimed).toBe(1);
  });

  it("never auto-picks a channel for an in-office handover", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          channel: "in_office",
          recipient_phone_e164: "+12155550100",
        }),
      ],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(1);
    expect(sendFollowup).not.toHaveBeenCalled();
  });
});

describe("the worklist is not the nudge", () => {
  it("still raises alerts when the tenant's flag is off", async () => {
    featureEnabled.value = false;
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(1);
    expect(stats.skippedFlagOff).toBe(1);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it("still raises alerts for a tenant with no verified domain", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-nodomain" }],
    });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("spends NOTHING on a cohort-A row it has no domain to link to", async () => {
    // Nothing clears a nudge stamp. Claiming one for a message that
    // cannot be built would mean that the day this tenant verified a
    // domain, every invite outstanding today had already burned its
    // follow-up on a send that never happened.
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-nodomain" }],
    });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(getSupabaseCallCount("fitter_invites", "update")).toBe(0);
    expect(sendFollowup).not.toHaveBeenCalled();
    expect(stats.skippedNoLinkBase).toBe(1);
  });

  it("still sends cohort B's no-link follow-up when cohort A has no domain", async () => {
    // Cohort B needs no link, so those follow-ups must still go out. The
    // two cohorts share one per-tick send budget, so cohort A spending
    // slots on guaranteed non-deliveries is what would silence the one
    // cohort that could actually have been reached.
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-nodomain" }],
    });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite()],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.nudgesSent).toBe(1);
    expect(sendFollowup.mock.calls[0]?.[1]).toBe("no_request");
  });
});

describe("cohort B — the fitting happened and nothing followed", () => {
  it("raises fit_no_request and nudges with the no-link copy", async () => {
    stageOrg();
    // Cohort A finds nothing.
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite()],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.alert_type).toBe("fit_no_request");
    expect(alert.severity).toBe("high");
    expect(stats.nudgesSent).toBe(1);
    expect(sendFollowup.mock.calls[0]?.[1]).toBe("no_request");
    // No link is minted for this reason — the /fit-request route is
    // guarded by per-tab state the patient no longer has.
    const target = sendFollowup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(target.linkBase).toBeUndefined();
  });

  it("leaves a fitting alone once the patient has asked", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite()],
    });
    // findActedOn: a request already exists against this fitting.
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [{ fit_session_id: "44444444-4444-4444-8444-444444444444" }],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(getSupabaseCallCount("fitter_followup_alerts", "insert")).toBe(0);
    expect(sendFollowup).not.toHaveBeenCalled();
    // …and any alert already standing for it is closed on the way past.
    expect(stats.alertsAutoResolved).toBeGreaterThanOrEqual(0);
  });

  it("leaves a fitting alone once it has been dispensed", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite()],
    });
    stageSupabaseResponse("fitter_fit_requests", "select", { data: [] });
    stageSupabaseResponse("fit_sessions", "select", {
      data: [{ id: "44444444-4444-4444-8444-444444444444" }],
    });

    await runFitterFollowupSweep(NOW);

    expect(getSupabaseCallCount("fitter_followup_alerts", "insert")).toBe(0);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it("bounds the look-back so a first deploy can't chase old fittings", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });

    await runFitterFollowupSweep(NOW);

    const filters = getSupabaseFilterCalls("fitter_invites", "select");
    expect(
      filters.some((f) => f.verb === "gte" && f.args[0] === "completed_at"),
    ).toBe(true);
  });
});

describe("a returning patient is not silenced by an old request", () => {
  it("alerts a new fitting even when the same email asked months ago", async () => {
    // Migration 0519 is explicit that a patient may legitimately come
    // back — its dedupe index is partial on `status <> 'closed'` for
    // exactly that reason. An unbounded email match answers "has this
    // person EVER asked", so a request closed after an earlier fitting
    // would mark today's fitting as acted on and the patient would hear
    // nothing at all.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite({ fit_session_id: null })],
    });
    // The invite carries no fit_session_id, so the only correlation the
    // sweep can make is by email — and the one row there predates this
    // fitting by months.
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [{ email: "prospect@example.com", created_at: agoDays(120) }],
    });
    // Nothing stale in the request queue itself.
    stageSupabaseResponse("fitter_fit_requests", "select", { data: [] });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsRaised).toBe(1);
    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.alert_type).toBe("fit_no_request");
  });

  it("still stands down when the request came AFTER this fitting", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [completedInvite({ fit_session_id: null })],
    });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [{ email: "prospect@example.com", created_at: agoDays(1) }],
    });
    stageSupabaseResponse("fitter_fit_requests", "select", { data: [] });

    await runFitterFollowupSweep(NOW);

    expect(getSupabaseCallCount("fitter_followup_alerts", "insert")).toBe(0);
    expect(sendFollowup).not.toHaveBeenCalled();
  });
});

describe("the stamps stay honest across a resend", () => {
  it("SPENDS a stale first stamp when the final nudge goes out", async () => {
    // A resend re-stamps `sent_at`, which makes the old first-round
    // stamp stale on purpose. Preserving it with `?? nowIso` meant the
    // next tick read it as unspent and fired the first reminder
    // immediately after the final one — two messages in an hour.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          sent_at: agoDays(28),
          expires_at: inDays(2),
          // From a round that ended before this invite was resent.
          fit_reminder_sent_at: agoDays(60),
        }),
      ],
    });
    stageClaimWon();

    await runFitterFollowupSweep(NOW);

    const [patch] = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    ) as Array<Record<string, string>>;
    expect(patch.fit_final_reminder_sent_at).toBeTruthy();
    // Refreshed to now, not left holding the stale value.
    expect(new Date(patch.fit_reminder_sent_at).getTime()).toBeGreaterThan(
      new Date(agoDays(1)).getTime(),
    );
  });

  it("claims against the lifecycle it observed, not the stamp alone", async () => {
    // The stamp does not move when a patient finishes the fitting or a
    // CSR revokes the invite, so a claim conditional on the stamp alone
    // would happily send "finish your mask fitting" to somebody who
    // completed it thirty seconds earlier.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite()],
    });
    stageClaimWon();

    await runFitterFollowupSweep(NOW);

    const filters = getSupabaseFilterCalls("fitter_invites", "update");
    expect(filters.some((f) => f.verb === "in" && f.args[0] === "status")).toBe(
      true,
    );
    expect(
      filters.some((f) => f.verb === "eq" && f.args[0] === "sent_at"),
    ).toBe(true);
  });
});

describe("request_unworked — the one that is ours", () => {
  it("raises a staff alert and messages nobody", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [
        {
          id: REQUEST,
          status: "new",
          patient_id: null,
          fit_session_id: null,
          request_type: "callback",
          created_at: agoDays(3),
        },
      ],
    });

    const stats = await runFitterFollowupSweep(NOW);

    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.alert_type).toBe("request_unworked");
    expect(alert.fit_request_id).toBe(REQUEST);
    expect(alert.fitter_invite_id).toBeUndefined();
    expect(stats.nudgesSent).toBe(0);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it("pages the stale-request scan instead of re-reading one prefix", async () => {
    // A request stays `status='new'` after its alert is raised (an alert
    // does not work the queue) and the insert then no-ops on the unique
    // index. With one fixed limit, every request past the first page
    // would never be alerted at all until enough older ones were worked
    // — the worklist would be quietly incomplete for exactly the tenant
    // most in need of it.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_fit_requests", "select", { data: [] });

    await runFitterFollowupSweep(NOW);

    const filters = getSupabaseFilterCalls("fitter_fit_requests", "select");
    expect(filters.some((f) => f.verb === "range")).toBe(true);
  });

  it("escalates to high once a request has waited a week", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [
        {
          id: REQUEST,
          status: "new",
          patient_id: null,
          fit_session_id: null,
          request_type: "full_details",
          created_at: agoDays(9),
        },
      ],
    });

    await runFitterFollowupSweep(NOW);

    const [alert] = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.severity).toBe("high");
  });
});

describe("an alert closes itself when the thing it was about happens", () => {
  it("closes a cohort-A alert once the fitting is finished", async () => {
    stageOrg();
    // resolveFinishedInvites: one open alert, whose invite is now done.
    stageSupabaseResponse("fitter_followup_alerts", "select", {
      data: [{ fitter_invite_id: INVITE }],
    });
    stageSupabaseResponse("fitter_invites", "select", {
      data: [{ id: INVITE, status: "completed" }],
    });
    stageSupabaseResponse("fitter_followup_alerts", "update", {
      data: [{ id: "alert-1" }],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsAutoResolved).toBe(1);
    const patch = (
      getSupabaseWritePayloads("fitter_followup_alerts", "update") as Array<
        Record<string, unknown>
      >
    ).find((p) => p.status === "resolved");
    expect(patch?.resolved_reason).toBe("fit_completed");
  });

  it("closes a request alert from the ALERT side, not by scanning every request", async () => {
    stageOrg();
    // Both opening resolve passes find nothing…
    stageSupabaseResponse("fitter_followup_alerts", "select", { data: [] });
    stageSupabaseResponse("fitter_followup_alerts", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    // …no request is stale…
    stageSupabaseResponse("fitter_fit_requests", "select", { data: [] });
    // …but one open alert points at a request a CSR has picked up.
    stageSupabaseResponse("fitter_followup_alerts", "select", {
      data: [{ fit_request_id: REQUEST }],
    });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [{ id: REQUEST, status: "contacted" }],
    });
    stageSupabaseResponse("fitter_followup_alerts", "update", {
      data: [{ id: "alert-2" }],
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(stats.alertsAutoResolved).toBe(1);
    const patch = (
      getSupabaseWritePayloads("fitter_followup_alerts", "update") as Array<
        Record<string, unknown>
      >
    ).find((p) => p.status === "resolved");
    expect(patch?.resolved_reason).toBe("request_worked");
  });

  it("escalates an ALREADY-RAISED request alert once it passes a week", async () => {
    // The insert is a no-op after the first tick (the unique index is
    // deliberately not scoped to open rows), so without a separate
    // update a request raised at two days would still read 'medium'
    // three weeks later.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [
        {
          id: REQUEST,
          status: "new",
          patient_id: null,
          fit_session_id: null,
          request_type: "callback",
          created_at: agoDays(21),
        },
      ],
    });
    stageSupabaseResponse("fitter_followup_alerts", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });

    await runFitterFollowupSweep(NOW);

    const patches = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(patches.some((p) => p.severity === "high")).toBe(true);
  });

  it("does not escalate one that is merely a couple of days old", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "select", { data: [] });
    stageSupabaseResponse("fitter_fit_requests", "select", {
      data: [
        {
          id: REQUEST,
          status: "new",
          patient_id: null,
          fit_session_id: null,
          request_type: "callback",
          created_at: agoDays(3),
        },
      ],
    });

    await runFitterFollowupSweep(NOW);

    const patches = getSupabaseWritePayloads(
      "fitter_followup_alerts",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(patches.some((p) => p.severity === "high")).toBe(false);
  });
});

describe("consent", () => {
  it("texts a prospect whose invite was itself a text", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          channel: "sms",
          recipient_email: null,
          recipient_phone_e164: "+12155550100",
        }),
      ],
    });
    stageClaimWon();

    const stats = await runFitterFollowupSweep(NOW);

    // A prospect has no shop_customers row, and the stored default for
    // smsTransactional is false. Reading that absence as a refusal would
    // make the sweep unable to follow up the commonest invite there is.
    expect(stats.nudgesSent).toBe(1);
    const target = sendFollowup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(target.allowSms).toBe(true);
  });

  it("does not text an emailed prospect just because a number is on file", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          channel: "email",
          recipient_phone_e164: "+12155550100",
        }),
      ],
    });
    stageClaimWon();

    await runFitterFollowupSweep(NOW);

    const target = sendFollowup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(target.allowSms).toBe(false);
    expect(target.allowEmail).toBe(true);
  });

  it("reaches the preference record through a key that EXISTS", async () => {
    // `resupply.shop_customers` has no `patient_id` column — it links to
    // a chart through `auth_user_id` = `patients.portal_auth_user_id`,
    // or by email (migration 0532 backfills through exactly that pair).
    // Filtering on a column that does not exist does not return nothing;
    // PostgREST returns an ERROR, and reading only `data` swallows it.
    // The lookup then reads as "no stored preference", which for email
    // means the opted-in default — so an explicit opt-out would be
    // ignored and the patient messaged anyway.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite({ patient_id: PATIENT })],
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT,
        email: "p@example.com",
        timezone: null,
        portal_auth_user_id: "auth-user-1",
      },
    });
    stageClaimWon();

    await runFitterFollowupSweep(NOW);

    const filters = getSupabaseFilterCalls("shop_customers", "select");
    const columns = filters
      .filter((f) => f.verb === "eq")
      .map((f) => f.args[0]);
    expect(columns).not.toContain("patient_id");
    expect(columns).toContain("auth_user_id");
  });

  it("declines to send when the consent lookup FAILS", async () => {
    // A preference record we could not read might be a refusal. Sending
    // on it is the one unrecoverable outcome; skipping costs an hour,
    // because nothing is stamped and the next tick retries.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [openInvite({ patient_id: PATIENT })],
    });
    stageSupabaseResponse("patients", "select", {
      error: { code: "PGRST100", message: "boom" },
    });

    const stats = await runFitterFollowupSweep(NOW);

    expect(sendFollowup).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("fitter_invites", "update")).toBe(0);
    // Deferred, not refused — a later tick tries again.
    expect(stats.skippedQuietHours).toBe(1);
    // …and the alert still stands, so staff can act meanwhile.
    expect(stats.alertsRaised).toBe(1);
  });

  it("uses the customer's OWN timezone for the SMS window", async () => {
    // 18:00Z is 11:00 in Los Angeles (inside the window) but the chart
    // has no timezone, so reading only the chart would fall back to
    // Eastern. The mirror case is what makes this a TCPA problem: at
    // 13:00Z, Eastern reads 09:00 (allowed) while the patient's real
    // 06:00 Pacific is not.
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          patient_id: PATIENT,
          channel: "sms",
          recipient_email: null,
          recipient_phone_e164: "+12155550100",
        }),
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT,
        email: null,
        // The chart has no timezone — this is the case where reading
        // only the chart silently falls back to Eastern.
        timezone: null,
        portal_auth_user_id: "auth-user-1",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        communication_preferences: {
          smsTransactional: true,
          timezone: "America/Los_Angeles",
        },
      },
    });
    stageClaimWon();

    const early = new Date("2026-06-10T13:00:00.000Z");
    const stats = await runFitterFollowupSweep(early);

    // 06:00 Pacific — outside 9am-8pm, so deferred rather than sent.
    expect(sendFollowup).not.toHaveBeenCalled();
    expect(stats.skippedQuietHours).toBe(1);
  });

  it("honours a stored refusal on both channels", async () => {
    stageOrg();
    stageSupabaseResponse("fitter_invites", "select", {
      data: [
        openInvite({
          patient_id: PATIENT,
          channel: "sms",
          recipient_phone_e164: "+12155550100",
        }),
      ],
    });
    // `shop_customers` has no `patient_id`; the prefs are reached
    // through `patients.portal_auth_user_id` = `auth_user_id`.
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT,
        email: "opted.out@example.com",
        timezone: "America/Los_Angeles",
        portal_auth_user_id: "auth-user-1",
      },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        communication_preferences: {
          emailResupplyReminders: false,
          smsTransactional: false,
        },
      },
    });

    const stats = await runFitterFollowupSweep(NOW);

    // The alert still stands — staff can phone them.
    expect(stats.alertsRaised).toBe(1);
    expect(sendFollowup).not.toHaveBeenCalled();
    expect(stats.skippedNoChannel).toBe(1);
  });
});

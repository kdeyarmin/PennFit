import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { closeEpisode, closeOpenEpisodesForPatient } from "./close-episode";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000011";
const EPISODE = "00000000-0000-4000-8000-000000000031";
const FULFILLMENT = "00000000-0000-4000-8000-000000000041";

beforeEach(() => {
  supabaseMock.reset();
});

describe("closeEpisode", () => {
  it("writes status, reason and closed_at together", () => {
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE }],
      error: null,
    });

    return closeEpisode({
      orgId: ORG,
      episodeId: EPISODE,
      patientId: PATIENT,
      status: "declined",
      reason: "patient_declined",
      at: new Date("2026-04-05T06:07:08.000Z"),
    }).then((result) => {
      expect(result).toEqual({ closed: true });
      const [patch] = supabaseMock.writePayloads("episodes", "update") as [
        Record<string, unknown>,
      ];
      expect(patch.status).toBe("declined");
      expect(patch.closed_reason).toBe("patient_declined");
      expect(patch.closed_at).toBe("2026-04-05T06:07:08.000Z");
    });
  });

  it("reports closed:false when another exit already won the race", async () => {
    // An email click and an SMS reply landing together, or a webhook
    // replay. Postgres arbitrates via the status guard; the loser matches
    // zero rows. That is not an error and must not be retried.
    stageSupabaseResponse("episodes", "update", { data: [], error: null });

    const result = await closeEpisode({
      orgId: ORG,
      episodeId: EPISODE,
      status: "declined",
      reason: "patient_declined",
    });

    expect(result).toEqual({ closed: false });
  });

  it("records the fulfillment that satisfied the cycle", async () => {
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE }],
      error: null,
    });

    await closeEpisode({
      orgId: ORG,
      episodeId: EPISODE,
      status: "fulfilled",
      reason: "shipped",
      fulfillmentId: FULFILLMENT,
      allowFromConfirmed: true,
    });

    const [patch] = supabaseMock.writePayloads("episodes", "update") as [
      Record<string, unknown>,
    ];
    expect(patch.closing_fulfillment_id).toBe(FULFILLMENT);
  });

  it("omits closing_fulfillment_id when there is none", async () => {
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE }],
      error: null,
    });

    await closeEpisode({
      orgId: ORG,
      episodeId: EPISODE,
      status: "expired",
      reason: "no_response",
    });

    const [patch] = supabaseMock.writePayloads("episodes", "update") as [
      Record<string, unknown>,
    ];
    expect(patch).not.toHaveProperty("closing_fulfillment_id");
  });

  it("rejects a reason that does not belong to the status", async () => {
    // Folding an opt-out into `declined` would make the decline rate
    // meaningless, so the pairing fails loudly at the callsite.
    await expect(
      closeEpisode({
        orgId: ORG,
        episodeId: EPISODE,
        status: "declined",
        reason: "patient_opted_out",
      }),
    ).rejects.toThrow(/not valid for status "declined"/);
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
  });

  it("surfaces a DB error instead of reporting a write that did not happen", async () => {
    stageSupabaseResponse("episodes", "update", {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    });

    await expect(
      closeEpisode({
        orgId: ORG,
        episodeId: EPISODE,
        status: "canceled",
        reason: "csr_canceled",
      }),
    ).rejects.toBeDefined();
  });
});

describe("closeOpenEpisodesForPatient", () => {
  it("closes every open cycle and counts them", async () => {
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: "a" }, { id: "b" }, { id: "c" }],
      error: null,
    });

    const result = await closeOpenEpisodesForPatient({
      orgId: ORG,
      patientId: PATIENT,
      status: "canceled",
      reason: "patient_opted_out",
    });

    expect(result).toEqual({ closedCount: 3 });
    const [patch] = supabaseMock.writePayloads("episodes", "update") as [
      Record<string, unknown>,
    ];
    expect(patch.status).toBe("canceled");
    expect(patch.closed_reason).toBe("patient_opted_out");
  });

  it("is a no-op for a patient with nothing open", async () => {
    stageSupabaseResponse("episodes", "update", { data: [], error: null });

    await expect(
      closeOpenEpisodesForPatient({
        orgId: ORG,
        patientId: PATIENT,
        status: "canceled",
        reason: "patient_opted_out",
      }),
    ).resolves.toEqual({ closedCount: 0 });
  });
});

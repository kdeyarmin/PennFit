import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { openOutreachEpisode } from "./open-outreach-episode";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000011";
const RX = "00000000-0000-4000-8000-000000000021";
const EPISODE = "00000000-0000-4000-8000-000000000031";

beforeEach(() => {
  supabaseMock.reset();
});

describe("openOutreachEpisode", () => {
  it("reuses an existing in-progress episode for the same prescription", async () => {
    stageSupabaseResponse("episodes", "select", {
      data: { id: EPISODE },
      error: null,
    });

    const result = await openOutreachEpisode({
      orgId: ORG,
      patientId: PATIENT,
      prescriptionId: RX,
      cadenceDays: 90,
    });

    expect(result).toEqual({ episodeId: EPISODE, created: false });
    expect(supabaseMock.callCount("episodes", "insert")).toBe(0);
    expect(supabaseMock.callCount("episodes", "select")).toBe(1);
  });

  it("inserts outreach_pending with due_at = from + cadenceDays", async () => {
    stageSupabaseResponse("episodes", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("episodes", "insert", {
      data: { id: EPISODE },
      error: null,
    });

    const from = new Date("2026-01-01T00:00:00.000Z");
    const result = await openOutreachEpisode({
      orgId: ORG,
      patientId: PATIENT,
      prescriptionId: RX,
      cadenceDays: 90,
      from,
    });

    expect(result).toEqual({ episodeId: EPISODE, created: true });
    const [payload] = supabaseMock.writePayloads("episodes", "insert") as [
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({
      patient_id: PATIENT,
      prescription_id: RX,
      status: "outreach_pending",
    });
    expect(payload.due_at).toBe("2026-04-01T00:00:00.000Z");
  });

  it("clamps cadenceDays to at least 1", async () => {
    stageSupabaseResponse("episodes", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("episodes", "insert", {
      data: { id: EPISODE },
      error: null,
    });

    const from = new Date("2026-06-01T00:00:00.000Z");
    await openOutreachEpisode({
      orgId: ORG,
      patientId: PATIENT,
      prescriptionId: RX,
      cadenceDays: 0,
      from,
    });

    const [payload] = supabaseMock.writePayloads("episodes", "insert") as [
      Record<string, unknown>,
    ];
    expect(payload.due_at).toBe("2026-06-02T00:00:00.000Z");
  });
});

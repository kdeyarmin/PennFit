import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../episodes/open-outreach-episode.js", () => ({
  openOutreachEpisode: vi.fn(async () => ({
    episodeId: "ep-1",
    created: true,
  })),
}));

import {
  previewBootstrapPrescriptions,
  commitBootstrapPrescriptions,
} from "./bootstrap-prescriptions";
import { openOutreachEpisode } from "../episodes/open-outreach-episode.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000011";

beforeEach(() => {
  supabaseMock.reset();
  vi.mocked(openOutreachEpisode).mockClear();
});

function stageEmptyPrescriptions() {
  stageSupabaseResponse("prescriptions", "select", { data: [], error: null });
}

function stageOneEligiblePatient() {
  stageSupabaseResponse("patients", "select", {
    data: [
      {
        id: PATIENT,
        created_at: "2025-06-01T00:00:00.000Z",
        insurance_payer: "Medicare",
        cadence_override_days: null,
        channel_preference: null,
        phone_e164: "+14155551212",
        pacware_id: "PW-100",
      },
    ],
    error: null,
  });
}

function stageRules() {
  stageSupabaseResponse("frequency_rules", "select", {
    data: [
      {
        id: "rule-1",
        priority: 200,
        created_at: "2025-01-01T00:00:00.000Z",
        active: true,
        match_item_sku_prefix: "FILTER-DISP",
        match_insurance_payer: "Medicare",
        min_tenure_days: null,
        max_tenure_days: null,
        cadence_days: 15,
        default_channel: null,
      },
    ],
    error: null,
  });
}

describe("previewBootstrapPrescriptions", () => {
  it("counts eligible patients without active prescriptions", async () => {
    stageEmptyPrescriptions();
    stageOneEligiblePatient();

    const result = await previewBootstrapPrescriptions({
      orgId: ORG,
      onlyPacwarePatients: true,
    });

    expect(result.mode).toBe("preview");
    expect(result.eligiblePatients).toBe(1);
    expect(result.prescriptionsToCreate).toBe(4);
    expect(result.lineSkus).toContain("MASK-STD");
  });
});

describe("commitBootstrapPrescriptions", () => {
  it("creates prescriptions and opens episodes for each default line", async () => {
    stageRules();
    stageEmptyPrescriptions();
    stageOneEligiblePatient();

    for (let i = 0; i < 4; i++) {
      stageSupabaseResponse("prescriptions", "insert", {
        data: { id: `rx-${i}` },
        error: null,
      });
      stageSupabaseResponse("episodes", "select", { data: null, error: null });
    }

    const result = await commitBootstrapPrescriptions({
      orgId: ORG,
      onlyPacwarePatients: true,
      now: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(result.patientsBootstrapped).toBe(1);
    expect(result.prescriptionsCreated).toBe(4);
    expect(result.episodesOpened).toBe(4);
    expect(openOutreachEpisode).toHaveBeenCalledTimes(4);
  });
});

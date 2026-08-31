// A decline is a SKIP, not an exit.
//
// The bug these guard is invisible by construction: closing an episode
// `declined` and opening nothing leaves the patient with no outreach-open
// cycle, and the reminder scan only READS cycles — it never creates them.
// So the patient simply stops being contacted, no row records that it
// happened, and every channel had just told them we would be back.
//
// The anchoring assertions matter as much as the reopen itself. Anchoring
// on the last dispense (which is right for opt-in, and wrong here) would
// reopen a cycle that is already overdue and remind them tomorrow — the
// exact thing they declined.

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { reopenCycleAfterDecline } from "./reopen-after-decline";

const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000011";
const EPISODE = "00000000-0000-4000-8000-000000000031";
const RX = "00000000-0000-4000-8000-000000000051";
const DECLINED_AT = new Date("2026-05-10T00:00:00.000Z");

function stageEpisode(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("episodes", "select", {
    data: { patient_id: PATIENT, prescription_id: RX, ...over },
    error: null,
  });
}

function stagePrescription(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("prescriptions", "select", {
    data: { cadence_days: 30, status: "active", ...over },
    error: null,
  });
}

/** The insert `openOutreachEpisode` performs when no cycle is open. */
function stageNoOpenCycleThenInsert(newId = "ep-next"): void {
  stageSupabaseResponse("episodes", "select", { data: null, error: null });
  stageSupabaseResponse("episodes", "insert", {
    data: { id: newId },
    error: null,
  });
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("reopenCycleAfterDecline", () => {
  it("opens the next cycle so the ladder does not end", () => {
    stageEpisode();
    stagePrescription();
    stageNoOpenCycleThenInsert();

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.reopened).toBe(true);
      expect(r.created).toBe(true);
      expect(r.skipped).toBeNull();
    });
  });

  it("anchors the next cycle on the decline, not on a past dispense", () => {
    // 30-day cadence declined on the 10th → due the 9th of next month.
    // If this ever anchors on the last dispense, the new episode is born
    // overdue and the scan contacts them immediately.
    stageEpisode();
    stagePrescription({ cadence_days: 30 });
    stageNoOpenCycleThenInsert();

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then(() => {
      const [row] = supabaseMock.writePayloads("episodes", "insert") as [
        Record<string, unknown>,
      ];
      const dueAt = new Date(String(row.due_at));
      expect(dueAt.getTime()).toBe(
        DECLINED_AT.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      expect(dueAt.getTime()).toBeGreaterThan(DECLINED_AT.getTime());
    });
  });

  it("uses the prescription's own cadence", () => {
    stageEpisode();
    stagePrescription({ cadence_days: 90 });
    stageNoOpenCycleThenInsert();

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then(() => {
      const [row] = supabaseMock.writePayloads("episodes", "insert") as [
        Record<string, unknown>,
      ];
      expect(new Date(String(row.due_at)).getTime()).toBe(
        DECLINED_AT.getTime() + 90 * 24 * 60 * 60 * 1000,
      );
    });
  });

  it("does not resurrect an inactive prescription", () => {
    // Ending therapy is a clinician's decision. A patient declining one
    // refill must not undo it.
    stageEpisode();
    stagePrescription({ status: "ended" });

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.reopened).toBe(false);
      expect(r.skipped).toBe("prescription_inactive");
      expect(supabaseMock.callCount("episodes", "insert")).toBe(0);
    });
  });

  it("is a no-op with no bound episode", () => {
    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: null,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.reopened).toBe(false);
      expect(r.skipped).toBe("no_episode");
    });
  });

  it("never throws when the lookup fails", () => {
    // The patient has already been told "no problem, we will check back".
    // Throwing here would turn an acknowledged decline into a 500 while
    // the episode stays closed either way.
    stageSupabaseResponse("episodes", "select", {
      data: null,
      error: { message: "connection reset" },
    });

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.reopened).toBe(false);
      expect(r.skipped).toBe("lookup_failed");
    });
  });

  it("reuses an already-open cycle instead of opening a second", () => {
    // A replayed webhook or a double-clicked email link must not queue
    // two cycles for one prescription.
    stageEpisode();
    stagePrescription();
    stageSupabaseResponse("episodes", "select", {
      data: { id: "ep-existing" },
      error: null,
    });

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.reopened).toBe(true);
      expect(r.created).toBe(false);
      expect(r.episodeId).toBe("ep-existing");
      expect(supabaseMock.callCount("episodes", "insert")).toBe(0);
    });
  });

  it("falls back to a 90-day cadence when the prescription carries none", () => {
    stageEpisode();
    stagePrescription({ cadence_days: null });
    stageNoOpenCycleThenInsert();

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then(() => {
      const [row] = supabaseMock.writePayloads("episodes", "insert") as [
        Record<string, unknown>,
      ];
      expect(new Date(String(row.due_at)).getTime()).toBe(
        DECLINED_AT.getTime() + 90 * 24 * 60 * 60 * 1000,
      );
    });
  });

  it("skips an episode row that no longer resolves", () => {
    stageSupabaseResponse("episodes", "select", { data: null, error: null });

    return reopenCycleAfterDecline({
      orgId: ORG,
      episodeId: EPISODE,
      at: DECLINED_AT,
    }).then((r) => {
      expect(r.skipped).toBe("episode_missing");
      expect(supabaseMock.callCount("episodes", "insert")).toBe(0);
    });
  });
});

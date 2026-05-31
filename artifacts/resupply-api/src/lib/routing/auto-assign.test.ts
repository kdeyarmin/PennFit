// Integration test for the availability filter in auto-assign (CSR #16).
// The pure scorer is covered in skill-score.test.ts; this pins that
// away / do-not-assign reps are excluded from auto-assignment.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { maybeAutoAssignConversation } from "./auto-assign";

beforeEach(() => supabaseMock.reset());

describe("maybeAutoAssignConversation — availability", () => {
  it("skips reps marked away and assigns the available one", async () => {
    // convo lookup
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "c1",
        assigned_admin_user_id: null,
        required_skills: ["billing"],
      },
    });
    // active admins: a1 available, a2 away (both have the skill)
    stageSupabaseResponse("admin_users", "select", {
      data: [
        { id: "a1", skills: ["billing"], availability: "available" },
        { id: "a2", skills: ["billing"], availability: "away" },
      ],
    });
    // open-queue depth lookup
    stageSupabaseResponse("conversations", "select", { data: [] });
    // atomic claim
    stageSupabaseResponse("conversations", "update", { data: [{ id: "c1" }] });

    const result = await maybeAutoAssignConversation(
      getSupabaseServiceRoleClient(),
      "c1",
    );
    expect(result).toEqual({
      assigned: true,
      adminUserId: "a1",
      matchedSkillCount: 1,
    });
  });

  it("returns no_eligible_candidate when everyone is away", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "c1",
        assigned_admin_user_id: null,
        required_skills: ["billing"],
      },
    });
    stageSupabaseResponse("admin_users", "select", {
      data: [{ id: "a2", skills: ["billing"], availability: "do_not_assign" }],
    });

    const result = await maybeAutoAssignConversation(
      getSupabaseServiceRoleClient(),
      "c1",
    );
    expect(result).toEqual({
      assigned: false,
      reason: "no_eligible_candidate",
    });
  });
});

// Pure scoring helper for skill-based conversation routing.
//
// Given a set of required skills + a candidate's skill list,
// return a score that tips toward stronger overlap. Tied scores
// break by smaller current queue depth (caller supplies the
// counts).
//
// Why pure
// --------
// Same posture as recall-match.ts / coaching-transitions.ts: keep
// the rules independent of DB so they're unit-testable and reused
// if/when a worker auto-assigns later.

export interface CandidateInput {
  /** admin_users.id */
  adminUserId: string;
  /** Skill tags this admin has. */
  skills: string[];
  /** How many open conversations are currently assigned to them. */
  openQueueSize: number;
}

export interface ScoredCandidate extends CandidateInput {
  /** Intersection cardinality between required + admin skills.
   *  Zero when there's no overlap; admins are still eligible
   *  (the score-zero candidate just sorts to the bottom of the
   *  list, picked only when no specialist exists). */
  matchedSkillCount: number;
  /** True when every required skill is on the admin's list. */
  coversAll: boolean;
}

export function scoreCandidates(input: {
  requiredSkills: string[];
  candidates: CandidateInput[];
}): ScoredCandidate[] {
  const want = new Set(
    input.requiredSkills
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  const scored: ScoredCandidate[] = input.candidates.map((c) => {
    if (want.size === 0) {
      return { ...c, matchedSkillCount: 0, coversAll: true };
    }
    const has = new Set(
      c.skills.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
    );
    let matched = 0;
    for (const w of want) if (has.has(w)) matched += 1;
    return {
      ...c,
      matchedSkillCount: matched,
      coversAll: matched === want.size,
    };
  });

  // Sort: covers-all-first, then by matchedSkillCount desc, then
  // by openQueueSize asc (load-balancing), then by adminUserId for
  // a stable order.
  scored.sort((a, b) => {
    if (a.coversAll !== b.coversAll) return a.coversAll ? -1 : 1;
    if (a.matchedSkillCount !== b.matchedSkillCount) {
      return b.matchedSkillCount - a.matchedSkillCount;
    }
    if (a.openQueueSize !== b.openQueueSize) {
      return a.openQueueSize - b.openQueueSize;
    }
    return a.adminUserId.localeCompare(b.adminUserId);
  });
  return scored;
}

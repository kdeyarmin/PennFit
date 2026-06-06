// Real-time CSR workload snapshot (CSR #C3).
//
// Today's productivity dashboard is a LAGGING rollup (closed-this-week
// counts). This is the LIVE view a supervisor needs to rebalance work
// mid-shift: how many open conversations each active agent is carrying
// right now, who's on shift, who's available, and how big the unassigned
// backlog is. Pure — the route supplies the rows it reads from Postgres.

export interface StaffAgentInput {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  /** admin_users.availability — 'available' | 'away' | 'do_not_assign'. */
  availability: string;
}

export interface BuildLiveStaffingInput {
  /** Active staff roster. */
  agents: StaffAgentInput[];
  /** assigned_admin_user_id of each OPEN conversation; null = unassigned. */
  openConversationAssignees: Array<string | null>;
  /** admin_user ids currently on shift. */
  onShiftIds: Iterable<string>;
}

export interface StaffAgentLoad {
  adminUserId: string;
  email: string;
  displayName: string | null;
  role: string;
  availability: string;
  onShift: boolean;
  openConversations: number;
}

export interface LiveStaffingSnapshot {
  agents: StaffAgentLoad[];
  /** Open conversations with no assignee — the backlog to distribute. */
  unassignedOpenConversations: number;
  /** All open conversations (assigned to anyone + unassigned). */
  totalOpenConversations: number;
  activeAgents: number;
  onShiftAgents: number;
}

const labelOf = (a: { displayName: string | null; email: string }): string =>
  a.displayName ?? a.email;

/**
 * Fold the raw rows into a per-agent live-load snapshot. Agents are
 * sorted heaviest-load first (then by name) so the most overloaded rep
 * is at the top. Conversations assigned to an inactive/unknown agent
 * still count toward the total but produce no row.
 */
export function buildLiveStaffing(
  input: BuildLiveStaffingInput,
): LiveStaffingSnapshot {
  const onShift = new Set(input.onShiftIds);

  const counts = new Map<string, number>();
  let unassigned = 0;
  for (const assignee of input.openConversationAssignees) {
    if (assignee == null) {
      unassigned += 1;
      continue;
    }
    counts.set(assignee, (counts.get(assignee) ?? 0) + 1);
  }

  const knownIds = new Set(input.agents.map((a) => a.id));
  const agents: StaffAgentLoad[] = input.agents
    .map((a) => ({
      adminUserId: a.id,
      email: a.email,
      displayName: a.displayName,
      role: a.role,
      availability: a.availability,
      onShift: onShift.has(a.id),
      openConversations: counts.get(a.id) ?? 0,
    }))
    .sort(
      (x, y) =>
        y.openConversations - x.openConversations ||
        labelOf(x).localeCompare(labelOf(y)),
    );

  let assignedToUnknown = 0;
  for (const [id, c] of counts) {
    if (!knownIds.has(id)) assignedToUnknown += c;
  }
  const assignedToKnown = agents.reduce((s, a) => s + a.openConversations, 0);

  return {
    agents,
    unassignedOpenConversations: unassigned,
    totalOpenConversations: assignedToKnown + assignedToUnknown + unassigned,
    activeAgents: input.agents.length,
    onShiftAgents: agents.filter((a) => a.onShift).length,
  };
}

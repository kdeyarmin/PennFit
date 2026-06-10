// Outreach playbooks — pure helpers shared by the admin routes
// (routes/admin/outreach-playbooks.ts) and the dispatcher job
// (worker/jobs/outreach-playbook-tick.ts). No I/O here so the
// scheduling + rendering rules are unit-testable.

export const PLAYBOOK_CHANNELS = ["sms", "email", "call"] as const;
export type PlaybookChannel = (typeof PLAYBOOK_CHANNELS)[number];

/**
 * The only substitution variables playbook bodies may use. Mirrors the
 * {{snake_case}} syntax of @workspace/resupply-templates but with a
 * deliberately tiny allowlist — playbook copy is operator-authored
 * free text, not a per-template schema.
 */
export const PLAYBOOK_VARIABLES = ["first_name", "practice_name"] as const;

const VARIABLE_TOKEN_RE = /\{\{([a-z][a-z0-9_]*)\}\}/g;

/**
 * Return every `{{token}}` in the body that is NOT in the allowlist.
 * Routes reject step bodies containing unknown tokens with a 400 so a
 * typo ({{first_nme}}) is caught at authoring time, not in a patient's
 * inbox.
 */
export function findUnknownVariables(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(VARIABLE_TOKEN_RE)) {
    const token = match[1]!;
    if (!(PLAYBOOK_VARIABLES as readonly string[]).includes(token)) {
      unknown.add(token);
    }
  }
  return [...unknown];
}

/** Substitute the allowlisted variables. Unknown tokens are left
 *  literal (authoring-time validation should have caught them; leaving
 *  them visible beats silently sending an empty hole). */
export function renderPlaybookBody(
  body: string,
  vars: { firstName: string | null; practiceName: string },
): string {
  return body
    .replaceAll("{{first_name}}", vars.firstName?.trim() || "there")
    .replaceAll("{{practice_name}}", vars.practiceName);
}

/** When a step is due, anchored on the run's start time (mirrors the
 *  fitter campaign anchoring touches on completed_at). day_offset 0 is
 *  due immediately — picked up by the next dispatcher tick. */
export function stepDueAt(startedAt: Date, dayOffset: number): Date {
  return new Date(startedAt.getTime() + dayOffset * 24 * 60 * 60 * 1000);
}

export interface PlaybookStepShape {
  stepIndex: number;
  dayOffset: number;
  channel: PlaybookChannel;
  subject: string | null;
  body: string;
}

/**
 * Structural validation for a step list shared by POST / and
 * PUT /:id/steps. Returns human-readable problems (empty = valid).
 * Zod handles field shapes; this covers the cross-field rules.
 */
export function validateSteps(steps: PlaybookStepShape[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push("A playbook needs at least one step.");
  if (steps.length > 20) problems.push("A playbook may have at most 20 steps.");
  let prevOffset = -1;
  for (const [i, step] of steps.entries()) {
    const label = `Step ${i + 1}`;
    if (step.channel === "email" && !step.subject?.trim()) {
      problems.push(`${label}: email steps need a subject.`);
    }
    if (step.channel !== "email" && step.subject?.trim()) {
      problems.push(`${label}: only email steps may have a subject.`);
    }
    if (step.dayOffset < prevOffset) {
      problems.push(
        `${label}: day offsets must not decrease (cadence runs in order).`,
      );
    }
    prevOffset = step.dayOffset;
    const unknown = findUnknownVariables(`${step.subject ?? ""} ${step.body}`);
    if (unknown.length > 0) {
      problems.push(
        `${label}: unknown variable(s) ${unknown
          .map((t) => `{{${t}}}`)
          .join(", ")} — allowed: ${PLAYBOOK_VARIABLES.map(
          (v) => `{{${v}}}`,
        ).join(", ")}.`,
      );
    }
  }
  return problems;
}

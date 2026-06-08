// Rule-based snooze resolution (CSR convenience).
//
// The conversation snooze endpoint historically took only an absolute
// ISO timestamp (`snoozedUntil`). CSRs actually think in relative terms
// — "remind me in a day", "next business day" — so this pure helper
// resolves a small grammar of relative/named specs to a concrete ISO
// instant the existing `conversations.snoozed_until` column understands.
//
// Pure + deterministic (takes `now`), so it is unit-tested directly and
// produces no time-zone surprises: all named anchors are expressed in
// UTC.

/** Max horizon a snooze may resolve to — guards against `999w`-style abuse. */
export const MAX_SNOOZE_DAYS = 90;

/** UTC hour used as the "morning" anchor for named day specs (~9am US Eastern). */
const MORNING_ANCHOR_UTC_HOUR = 13;

const DURATION = /^(\d{1,4})(h|d|w)$/;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export type SnoozeSpecResult =
  | { ok: true; untilIso: string }
  | { ok: false; reason: "unrecognized" | "out_of_range" };

/**
 * Resolve a snooze spec to an absolute ISO instant.
 *
 * Accepted forms:
 *   - duration: `<n>h` / `<n>d` / `<n>w` (e.g. `4h`, `1d`, `2w`)
 *   - `next_business_day` — next Mon–Fri at 13:00 UTC
 *   - `next_week` — exactly 7 days from now
 *
 * Anything that resolves beyond {@link MAX_SNOOZE_DAYS} (or a non-positive
 * duration) is rejected so the column never holds an absurd value.
 */
export function resolveSnoozeUntil(
  spec: string,
  now: Date = new Date(),
): SnoozeSpecResult {
  const s = spec.trim().toLowerCase();
  const horizonMs = now.getTime() + MAX_SNOOZE_DAYS * MS_PER_DAY;

  const clampOk = (until: Date): SnoozeSpecResult =>
    until.getTime() > now.getTime() && until.getTime() <= horizonMs
      ? { ok: true, untilIso: until.toISOString() }
      : { ok: false, reason: "out_of_range" };

  const m = DURATION.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n <= 0) return { ok: false, reason: "out_of_range" };
    const unitMs =
      m[2] === "h" ? MS_PER_HOUR : m[2] === "d" ? MS_PER_DAY : 7 * MS_PER_DAY;
    return clampOk(new Date(now.getTime() + n * unitMs));
  }

  if (s === "next_business_day") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    d.setUTCHours(MORNING_ANCHOR_UTC_HOUR, 0, 0, 0);
    return clampOk(d);
  }

  if (s === "next_week") {
    return clampOk(new Date(now.getTime() + 7 * MS_PER_DAY));
  }

  return { ok: false, reason: "unrecognized" };
}

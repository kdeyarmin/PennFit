// Explicit wrappers around AuthRepository.upsertCredential so the
// `set_by_admin_at` contract can't be accidentally inherited.
//
// Background: `upsertCredential` accepts `setByAdminAt` as
//   * `Date`       — stamp this moment (operator typed it)
//   * `null`       — clear the column (user typed it themselves)
//   * `undefined`  — preserve whatever value is on the row
//
// The "preserve" branch is the foot-gun. It exists so the sign-in
// algorithm-upgrade path can rehash a credential without flipping a
// stale operator-typed row back into a fresh one. But every OTHER
// caller is a user-initiated write that MUST clear the timestamp,
// and forgetting to pass `setByAdminAt: null` silently leaves a
// stale value in place — which then trips the 7-day invite-expired
// gate the next time the user signs in, locking them out of an
// account they just successfully reset.
//
// Use the helpers below instead of calling upsertCredential
// directly. The narrow types make it impossible to leave
// `setByAdminAt` implicit:
//
//   writeUserChosenPassword(repo, …)            // always nulls
//   writeAdminSetPassword(repo, …, setAt)       // always stamps
//   rehashPasswordPreservingProvenance(repo, …) // explicit preserve
//
// Direct calls to repo.upsertCredential outside the three helpers
// + the ./team-invite path (which bypasses the repo entirely and
// writes the column inline) should be treated as a review smell.

import type { AuthRepository } from "./repository";

/**
 * Persist a password the user just typed themselves (sign-up,
 * reset-password, change-password, recovery flows). Clears
 * `set_by_admin_at` so the next sign-in does not trip the
 * operator-typed credential expiry gate.
 */
export async function writeUserChosenPassword(
  repo: AuthRepository,
  input: {
    userId: string;
    passwordHash: string;
    mustChange?: boolean;
  },
): Promise<void> {
  await repo.upsertCredential({
    userId: input.userId,
    passwordHash: input.passwordHash,
    mustChange: input.mustChange ?? false,
    setByAdminAt: null,
  });
}

/**
 * Persist a password an operator typed on behalf of the user (team
 * invite "set their password for them"). Stamps `set_by_admin_at`
 * with the supplied moment so the sign-in handler can expire stale
 * operator-typed credentials whose owner never signed in.
 *
 * `mustChange` defaults to true here because every admin-set
 * password is expected to be rotated on first sign-in. Callers
 * must opt out explicitly.
 */
export async function writeAdminSetPassword(
  repo: AuthRepository,
  input: {
    userId: string;
    passwordHash: string;
    mustChange?: boolean;
  },
  setAt: Date,
): Promise<void> {
  await repo.upsertCredential({
    userId: input.userId,
    passwordHash: input.passwordHash,
    mustChange: input.mustChange ?? true,
    setByAdminAt: setAt,
  });
}

/**
 * Rehash an existing credential during a transparent algorithm
 * upgrade without touching `set_by_admin_at`. This is the ONLY
 * legitimate "preserve the existing value" caller — every other
 * writer must use {@link writeUserChosenPassword} or
 * {@link writeAdminSetPassword}.
 */
export async function rehashPasswordPreservingProvenance(
  repo: AuthRepository,
  input: {
    userId: string;
    passwordHash: string;
    mustChange: boolean;
  },
): Promise<void> {
  await repo.upsertCredential({
    userId: input.userId,
    passwordHash: input.passwordHash,
    mustChange: input.mustChange,
    // setByAdminAt deliberately omitted — repo treats undefined
    // as "preserve". See credential-writes.ts top-of-file comment.
  });
}

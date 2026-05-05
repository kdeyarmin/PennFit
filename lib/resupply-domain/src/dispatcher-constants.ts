// Shared dispatcher tuning constants.
//
// Centralised here so ops-status.ts mirrors the same window the
// prescription-renewals dispatcher uses — changing the constant in
// one place keeps the "Eligible now" badge honest.

/** Days before Rx expiry that the renewal nudge fires.
 *  Industry default is 30 — long enough for a physician callback,
 *  short enough that the patient feels the urgency. */
export const RENEWAL_WINDOW_DAYS = 30;

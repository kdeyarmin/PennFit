// resolveRefillWindow — models the CMS DMEPOS refill-timing window for
// one supply family, as a pure decision (no DB, no network, no clock
// except the `now` passed in — ADR 008). Shared by the order-confirm
// ship-window guard, the reminder dispatcher, and the admin "when can
// this ship?" preview.
//
// What it models
// --------------
// CMS Standard Documentation Requirements (PIM Ch. 5, "Refill
// Requirements") constrain WHEN a recurring supply may be touched
// relative to the expected end of the CURRENT supply's usable life
// ("expected depletion"):
//
//   • CONTACT window — the supplier must not CONTACT the beneficiary to
//     arrange a refill earlier than `REFILL_CONTACT_LEAD_DAYS` (14) days
//     before expected depletion. This bounds how early a refill REMINDER
//     may go out.
//
//   • SHIP window — the supplier must not DELIVER / SHIP a refill earlier
//     than `REFILL_SHIP_LEAD_DAYS` (10) days before expected depletion.
//     This bounds how early a confirmed order may ship.
//
// Expected depletion is `lastFulfilledAt + supplyDurationDays`, where
// `supplyDurationDays` is how long the current supply is expected to last
// (for resupply this is the HCPCS replacement interval — the same
// `min_interval_days` the entitlement engine reads).
//
// First fill
// ----------
// When `lastFulfilledAt` is null the patient has never been dispensed
// this family, so there is no "current supply" to deplete and BOTH
// windows are open — the initial fill is never refill-window-blocked.
// (Initial-fill medical-necessity is gated elsewhere, by the prescription
// / SWO and coverage checks, not here.)

/** Earliest a refill reminder may be sent: depletion minus this many days. */
export const REFILL_CONTACT_LEAD_DAYS = 14;

/** Earliest a confirmed refill may ship: depletion minus this many days. */
export const REFILL_SHIP_LEAD_DAYS = 10;

export interface RefillWindowInput {
  /** When this supply family was last dispensed. `null` → first fill,
   *  both windows open. */
  lastFulfilledAt: Date | null;
  /** Expected usable life of the current supply, in days (the HCPCS
   *  replacement interval). Clamped to >= 1 defensively. */
  supplyDurationDays: number;
  /** Current moment. Pass `new Date()` in production; tests pass a fixed
   *  instant for determinism. */
  now: Date;
}

export interface RefillWindowResult {
  /** Expected end of the current supply's usable life. `null` on a first
   *  fill (no current supply to deplete). */
  expectedDepletionOn: Date | null;
  /** Earliest date a refill reminder may go out (depletion − 14d).
   *  `null` on a first fill (open now). */
  earliestContactOn: Date | null;
  /** Earliest date a confirmed refill may ship (depletion − 10d).
   *  `null` on a first fill (open now). */
  earliestShipOn: Date | null;
  /** Whether contacting the beneficiary about a refill is allowed now. */
  contactAllowed: boolean;
  /** Whether shipping a confirmed refill is allowed now. */
  shipAllowed: boolean;
  /** Whole days until the contact window opens; 0 when already open. */
  daysUntilContact: number;
  /** Whole days until the ship window opens; 0 when already open. */
  daysUntilShip: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveRefillWindow(
  input: RefillWindowInput,
): RefillWindowResult {
  const { lastFulfilledAt, now } = input;
  // Clamp to >= 1 whole day. Guard non-finite inputs (NaN / Infinity)
  // explicitly: Math.floor(NaN) is NaN and Math.max(1, NaN) is NaN, which
  // would produce Invalid Dates downstream — fall back to 1 instead.
  const supplyDurationDays = Number.isFinite(input.supplyDurationDays)
    ? Math.max(1, Math.floor(input.supplyDurationDays))
    : 1;

  // First fill — no current supply, both windows open.
  if (lastFulfilledAt === null) {
    return {
      expectedDepletionOn: null,
      earliestContactOn: null,
      earliestShipOn: null,
      contactAllowed: true,
      shipAllowed: true,
      daysUntilContact: 0,
      daysUntilShip: 0,
    };
  }

  const depletionMs = lastFulfilledAt.getTime() + supplyDurationDays * DAY_MS;
  const expectedDepletionOn = new Date(depletionMs);
  const earliestContactOn = new Date(
    depletionMs - REFILL_CONTACT_LEAD_DAYS * DAY_MS,
  );
  const earliestShipOn = new Date(depletionMs - REFILL_SHIP_LEAD_DAYS * DAY_MS);

  const nowMs = now.getTime();
  const contactAllowed = nowMs >= earliestContactOn.getTime();
  const shipAllowed = nowMs >= earliestShipOn.getTime();
  const daysUntilContact = contactAllowed
    ? 0
    : Math.ceil((earliestContactOn.getTime() - nowMs) / DAY_MS);
  const daysUntilShip = shipAllowed
    ? 0
    : Math.ceil((earliestShipOn.getTime() - nowMs) / DAY_MS);

  return {
    expectedDepletionOn,
    earliestContactOn,
    earliestShipOn,
    contactAllowed,
    shipAllowed,
    daysUntilContact,
    daysUntilShip,
  };
}

/**
 * The canonical Medicare/payer refill attestation a beneficiary agrees
 * to when they confirm a resupply order, snapshotted onto every
 * `refill_confirmations` row. Kept here (the pure domain layer) so the
 * patient-facing copy (SMS/email/voice/landing page) and the persisted
 * proof reference ONE source of truth — if the wording changes, both
 * move together and old rows keep the text the patient actually saw.
 */
export const REFILL_AFFIRMATION_STATEMENT =
  "I confirm that I am still using my equipment and that my current " +
  "supplies are running low or used up, and I am requesting a refill.";

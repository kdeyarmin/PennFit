// The fitting → cart → checkout handoff.
//
// WHY A SIDE-CHANNEL AND NOT A CART FIELD
// ---------------------------------------
// Checkout does not happen on the results page. The patient adds a mask
// to the cart, lands on /shop/cart, and pays from there — by which point
// the fitter's React state is long gone. Something has to carry "this
// order came from fit session X, and the patient picked mask Y" across
// that navigation.
//
// The obvious place would be a field on `CartItem`, but the cart is a
// shared localStorage structure with a defensive shape check and legacy
// rows to tolerate, and the link is not really per-line data: one fitting
// produces one order regardless of how many lines end up in the basket.
// So it lives in its own small record instead, and the cart keeps its
// current shape.
//
// EXPIRY
// ------
// A stale record is worse than no record: it would attribute an unrelated
// resupply order weeks later to a fitting the patient has forgotten. The
// record therefore carries its own timestamp and is treated as absent
// once it is older than TTL_MS.
//
// PRIVACY: ids and a slug. No measurements, no name, no email, no PHI.

const STORAGE_KEY = "pennfit_fit_checkout_v1";

/**
 * How long a fitting stays attachable to a checkout. A day is generous
 * for "scan, look at the results, buy" and short enough that the next
 * unrelated resupply order is never mis-attributed to it.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface FitCheckoutContext {
  fitSessionId: string;
  /** The mask the patient actually chose — may be an alternative. */
  orderedMaskSlug: string | null;
  /** Cushion (preferred) or frame variant for the chosen size. */
  orderedVariantId: string | null;
}

interface StoredContext extends FitCheckoutContext {
  savedAt: number;
}

/**
 * Remember which fitting the patient is buying from. Called at
 * add-to-cart time, when the chosen mask is still known.
 *
 * A later add overwrites an earlier one — the last mask the patient put
 * in the cart is the one they went to checkout with.
 */
export function rememberFitCheckoutContext(ctx: FitCheckoutContext): void {
  if (typeof window === "undefined") return;
  if (!ctx.fitSessionId) return;
  try {
    const stored: StoredContext = { ...ctx, savedAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private-mode / quota failures lose the attribution, nothing more.
    // Never let this break an add-to-cart.
  }
}

/**
 * Read the pending fitting link, or null when there isn't a usable one.
 *
 * Returns null — rather than throwing or returning a partial — for an
 * absent, malformed, or expired record, so callers can spread the result
 * into a request body without checking anything but nullness.
 */
export function readFitCheckoutContext(): FitCheckoutContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredContext> | null;
    if (!parsed || typeof parsed.fitSessionId !== "string") return null;
    if (!parsed.fitSessionId.trim()) return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt))
      return null;
    if (Date.now() - parsed.savedAt > TTL_MS) return null;
    return {
      fitSessionId: parsed.fitSessionId,
      orderedMaskSlug:
        typeof parsed.orderedMaskSlug === "string" && parsed.orderedMaskSlug
          ? parsed.orderedMaskSlug
          : null,
      orderedVariantId:
        typeof parsed.orderedVariantId === "string" && parsed.orderedVariantId
          ? parsed.orderedVariantId
          : null,
    };
  } catch {
    return null;
  }
}

/** Drop the pending link — the order it described has been placed. */
export function clearFitCheckoutContext(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — an orphaned record expires on its own */
  }
}

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
  /** Set when a Stripe Checkout Session was created carrying this record
   *  — i.e. the attribution is now baked into a pending checkout. */
  submittedAt?: number;
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
// Mirror the checkout routes' Zod shapes (`z.string().uuid()` and the
// slug regex in routes/shop/checkout.ts). This attribution rides a MONEY
// path in a `.strict()` schema: a corrupted or hand-edited localStorage
// value that we forward verbatim 400s the ENTIRE checkout, and since the
// record survives the failure, every retry fails the same way. A value
// that doesn't match is dropped here instead — losing the attribution,
// never the sale.
//
// The UUID pattern is Zod 4's own RFC 9562 regex, verbatim (zod
// v4/core/regexes.ts) — a merely hyphen-shaped check is NOT equivalent:
// Zod enforces the version nibble (1-8) and variant bits (8/9/a/b), so a
// looser client check would forward values the server still rejects,
// recreating the exact retry-loop this guard exists to prevent.
const UUID_RE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const SLUG_RE = /^[a-z0-9-]{1,120}$/;

export function readFitCheckoutContext(): FitCheckoutContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredContext> | null;
    if (!parsed || typeof parsed.fitSessionId !== "string") return null;
    if (!UUID_RE.test(parsed.fitSessionId.trim())) return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt))
      return null;
    if (Date.now() - parsed.savedAt > TTL_MS) return null;
    return {
      fitSessionId: parsed.fitSessionId.trim(),
      orderedMaskSlug:
        typeof parsed.orderedMaskSlug === "string" &&
        SLUG_RE.test(parsed.orderedMaskSlug)
          ? parsed.orderedMaskSlug
          : null,
      orderedVariantId:
        typeof parsed.orderedVariantId === "string" &&
        UUID_RE.test(parsed.orderedVariantId.trim())
          ? parsed.orderedVariantId.trim()
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

/**
 * Record that a checkout Session was just created carrying this context.
 * Called at checkout-click, after the Session exists — from that moment
 * the attribution rides the Session's metadata, and the stored record's
 * only remaining job is a retry after a Stripe cancel.
 */
export function markFitCheckoutContextSubmitted(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredContext | null;
    if (!parsed || typeof parsed !== "object") return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...parsed, submittedAt: Date.now() }),
    );
  } catch {
    /* best-effort — worst case the success page clears an unmarked record */
  }
}

/**
 * Clear the record on confirmed payment — but only if it was the one a
 * checkout actually carried. The record is a SINGLE localStorage slot
 * shared across tabs: while checkout A is pending on Stripe, a second
 * fitting in another tab can store context B, and A's success page must
 * not delete B's not-yet-submitted attribution. A fresh (un-submitted)
 * record is left alone; it either rides its own checkout or ages out on
 * the TTL.
 */
export function clearSubmittedFitCheckoutContext(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredContext | null;
    if (parsed && typeof parsed === "object" && !parsed.submittedAt) return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Unreadable record — remove it; it can't attribute anything anyway.
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unusable */
    }
  }
}

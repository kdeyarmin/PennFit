// /shop/me/comm-prefs — communication preferences for the signed-in
// shopper.
//
//   GET  /shop/me/comm-prefs   — always returns the fully-populated
//                                 default-merged shape.
//   PUT  /shop/me/comm-prefs   — partial update; missing keys retain
//                                 the prior value (or default).
//
// Dispatcher integration: every dispatcher that sends a customer-
// directed message should call `shouldSendForCustomer()` from
// lib/comm-prefs.ts before emitting. We consult the same row that
// stores the customer's address + saved card to avoid a separate
// lookup.

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  type CommunicationPreferences,
  getDbPool,
  shopCustomers,
} from "@workspace/resupply-db";

import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const prefsSchema = z
  .object({
    emailMarketing: z.boolean().optional(),
    emailResupplyReminders: z.boolean().optional(),
    emailAbandonedCart: z.boolean().optional(),
    emailReviewRequests: z.boolean().optional(),
    smsMarketing: z.boolean().optional(),
    smsTransactional: z.boolean().optional(),
    preferredChannel: z.enum(["email", "sms"]).optional(),
    dndStartHour: z.number().int().min(0).max(23).nullable().optional(),
    dndEndHour: z.number().int().min(0).max(23).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, "IANA tz id")
      .nullable()
      .optional(),
  })
  .strict();

router.get("/shop/me/comm-prefs", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId!;
  await ensureShopCustomerRow({ customerId, email: null });
  const db = drizzle(getDbPool());
  const rows = await db
    .select({ prefs: shopCustomers.communicationPreferences })
    .from(shopCustomers)
    .where(eq(shopCustomers.customerId, customerId))
    .limit(1);
  const stored = rows[0]?.prefs ?? null;
  res.json({ preferences: mergeWithDefaults(stored) });
});

router.put("/shop/me/comm-prefs", requireSignedIn, async (req, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const customerId = req.userCustomerId!;
  await ensureShopCustomerRow({ customerId, email: null });
  const db = drizzle(getDbPool());
  const rows = await db
    .select({ prefs: shopCustomers.communicationPreferences })
    .from(shopCustomers)
    .where(eq(shopCustomers.customerId, customerId))
    .limit(1);
  const current = mergeWithDefaults(rows[0]?.prefs ?? null);
  // Validate DND window: either both null or both set with start != end.
  const proposedDndStart =
    parsed.data.dndStartHour !== undefined
      ? parsed.data.dndStartHour
      : current.dndStartHour;
  const proposedDndEnd =
    parsed.data.dndEndHour !== undefined
      ? parsed.data.dndEndHour
      : current.dndEndHour;
  if (
    (proposedDndStart === null) !== (proposedDndEnd === null)
  ) {
    res.status(400).json({
      error: "dnd_partial",
      message:
        "DND requires both dndStartHour and dndEndHour or neither.",
    });
    return;
  }
  if (
    proposedDndStart !== null &&
    proposedDndEnd !== null &&
    proposedDndStart === proposedDndEnd
  ) {
    res.status(400).json({
      error: "dnd_zero_window",
      message: "DND start and end must differ.",
    });
    return;
  }

  const next: CommunicationPreferences = {
    ...current,
    ...parsed.data,
    dndStartHour: proposedDndStart,
    dndEndHour: proposedDndEnd,
  };
  await db
    .update(shopCustomers)
    .set({ communicationPreferences: next, updatedAt: new Date() })
    .where(eq(shopCustomers.customerId, customerId));
  res.json({ preferences: next });
});

function mergeWithDefaults(
  stored: CommunicationPreferences | null,
): CommunicationPreferences {
  if (!stored) return { ...DEFAULT_COMMUNICATION_PREFERENCES };
  return { ...DEFAULT_COMMUNICATION_PREFERENCES, ...stored };
}

export default router;

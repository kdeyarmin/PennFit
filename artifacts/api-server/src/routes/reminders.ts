/**
 * Reminder subscription routes — public, capability-token-gated.
 *
 * POST /reminders                          — subscribe (idempotent on email)
 * GET  /reminders/manage?token=...         — fetch current subscription
 * PATCH /reminders/manage?token=...        — replace items
 * POST /reminders/manage/unsubscribe?token=...  — set status='unsubscribed'
 *
 * The manage token is the only auth on /reminders/manage* — treat it
 * like a capability secret. We use it as the URL parameter (not the
 * Authorization header) because it's also embedded in email links the
 * customer clicks from their inbox.
 *
 * Idempotency: POST /reminders looks up by lowercased email. If a row
 * exists (active OR unsubscribed), we update items and reactivate. If
 * not, we insert a fresh row with a new manage token.
 *
 * Anti-spam: a hidden "website" honeypot mirrors the orders route. If
 * filled, we return a fake success without touching the DB or sending
 * email — so naive bots think they succeeded and stop retrying.
 */

import { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  SubscribeToRemindersBody,
  UpdateReminderSubscriptionBody,
  GetReminderSubscriptionQueryParams,
  UpdateReminderSubscriptionQueryParams,
  UnsubscribeFromRemindersQueryParams,
  type ReminderItem,
} from "@workspace/api-zod";
import { db, reminderSubscriptionsTable, type ReminderSubscriptionRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sendReminderConfirmation,
  sendReminderManageLink,
} from "../lib/reminderEmail.js";

const router = Router();

function generateManageToken(): string {
  // 32 bytes = 64 hex chars. URL-safe and well over the unguessability bar
  // for a per-row capability.
  return randomBytes(32).toString("hex");
}

/**
 * Strict calendar-date parse. Zod's regex on "YYYY-MM-DD" accepts strings
 * like 2026-02-31 that JS `Date` will silently roll over to March 3 — that
 * would corrupt nextDueAt. We split + reconstruct + verify the round-trip
 * to reject impossible dates with a clear 400.
 */
function parseStrictIsoDate(yyyyMmDd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  const [, ys, ms, ds] = m;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Build at UTC noon to dodge DST. Then verify Date didn't roll over.
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

function addDays(yyyyMmDd: string, days: number): string {
  // Caller has already validated the date; if not, fall back to JS rollover.
  const d = parseStrictIsoDate(yyyyMmDd) ?? new Date(`${yyyyMmDd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns null if all items have valid calendar dates, or an array of
 * human-readable messages otherwise. Used both by POST and PATCH so the
 * front-end gets the same precise feedback in both flows.
 */
function findInvalidDates(items: ReminderItem[]): string[] | null {
  const issues: string[] = [];
  items.forEach((it, i) => {
    if (!parseStrictIsoDate(it.lastReplacedAt)) {
      issues.push(`items[${i}].lastReplacedAt: not a valid calendar date (got "${it.lastReplacedAt}")`);
    }
  });
  return issues.length > 0 ? issues : null;
}

function withNextDue(items: ReminderItem[]): Array<ReminderItem & { nextDueAt: string }> {
  return items.map((it) => ({
    ...it,
    nextDueAt: addDays(it.lastReplacedAt, it.intervalDays),
  }));
}

function toView(row: ReminderSubscriptionRow): {
  email: string;
  status: "active" | "unsubscribed";
  items: Array<ReminderItem & { nextDueAt: string }>;
  createdAt: string;
} {
  return {
    email: row.email,
    status: row.status,
    items: row.items as Array<ReminderItem & { nextDueAt: string }>,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- POST /reminders ----------
router.post("/reminders", async (req, res) => {
  // Honeypot must run before zod (zod strip would drop the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.json({
      success: true,
      emailStatus: "skipped" as const,
      message: "Subscription saved. Check your email for a manage link.",
    });
    return;
  }

  const parsed = SubscribeToRemindersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid subscription",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  // Belt-and-braces: the OpenAPI regex pattern accepts impossible dates
  // like 2026-02-31 (it only checks shape). Reject those before they
  // become bad nextDueAt values.
  const dateIssues = findInvalidDates(parsed.data.items);
  if (dateIssues) {
    res.status(400).json({ error: "Invalid subscription", details: dateIssues });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const items = parsed.data.items;
  const itemsWithDue = withNextDue(items);
  const now = new Date();

  // Look up by email. We branch hard here: existing rows DO NOT receive
  // the new items in the response and DO NOT have their token disclosed.
  // This closes a takeover hole where an attacker could submit a victim's
  // email and read back the capability token.
  const existing = await db
    .select()
    .from(reminderSubscriptionsTable)
    .where(eq(reminderSubscriptionsTable.email, email))
    .limit(1);

  if (existing.length > 0) {
    // Email the EXISTING manage link to the registered owner only. The
    // response is intentionally identical to the new-subscription response
    // so callers cannot determine whether the email was already on file
    // (preventing email-enumeration of health-adjacent subscriber data).
    let emailStatus: "sent" | "skipped" | "failed" = "skipped";
    try {
      const result = await sendReminderManageLink({
        toEmail: existing[0]!.email,
        manageToken: existing[0]!.manageToken,
      });
      emailStatus = !result.configured ? "skipped" : result.delivered ? "sent" : "failed";
    } catch (err) {
      req.log.warn({ err }, "reminder manage-link send threw");
      emailStatus = "failed";
    }

    res.json({
      success: true,
      emailStatus,
      message: "Check your email for a manage link to view or update your reminders.",
    });
    return;
  }

  // New row — insert and send confirmation. The manage token is delivered
  // only via email; it is never returned in the API response so that
  // unauthenticated callers cannot mint and retain tokens for arbitrary
  // email addresses without proving inbox ownership.
  const [inserted] = await db
    .insert(reminderSubscriptionsTable)
    .values({
      email,
      manageToken: generateManageToken(),
      items: itemsWithDue,
      status: "active",
      updatedAt: now,
    })
    .returning();
  const row: ReminderSubscriptionRow = inserted!;

  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  try {
    const result = await sendReminderConfirmation({
      toEmail: row.email,
      manageToken: row.manageToken,
      items: itemsWithDue,
    });
    emailStatus = !result.configured ? "skipped" : result.delivered ? "sent" : "failed";
  } catch (err) {
    req.log.warn({ err }, "reminder confirmation send threw");
    emailStatus = "failed";
  }

  res.json({
    success: true,
    emailStatus,
    message: "Check your email for a manage link to view or update your reminders.",
  });
});

// ---------- GET /reminders/manage?token=... ----------
router.get("/reminders/manage", async (req, res) => {
  const parsed = GetReminderSubscriptionQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: ["token: required"] });
    return;
  }
  const row = await db
    .select()
    .from(reminderSubscriptionsTable)
    .where(eq(reminderSubscriptionsTable.manageToken, parsed.data.token))
    .limit(1);
  if (row.length === 0) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }
  res.json(toView(row[0]!));
});

// ---------- PATCH /reminders/manage?token=... ----------
router.patch("/reminders/manage", async (req, res) => {
  const queryParsed = UpdateReminderSubscriptionQueryParams.safeParse(req.query);
  const bodyParsed = UpdateReminderSubscriptionBody.safeParse(req.body);
  if (!queryParsed.success) {
    res.status(400).json({ error: "Invalid query", details: ["token: required"] });
    return;
  }
  if (!bodyParsed.success) {
    res.status(400).json({
      error: "Invalid update",
      details: bodyParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const dateIssues = findInvalidDates(bodyParsed.data.items);
  if (dateIssues) {
    res.status(400).json({ error: "Invalid update", details: dateIssues });
    return;
  }

  const itemsWithDue = withNextDue(bodyParsed.data.items);

  const updated = await db
    .update(reminderSubscriptionsTable)
    .set({ items: itemsWithDue, status: "active", updatedAt: new Date() })
    .where(eq(reminderSubscriptionsTable.manageToken, queryParsed.data.token))
    .returning();

  if (updated.length === 0) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }
  res.json(toView(updated[0]!));
});

// ---------- POST /reminders/manage/unsubscribe?token=... ----------
router.post("/reminders/manage/unsubscribe", async (req, res) => {
  const parsed = UnsubscribeFromRemindersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: ["token: required"] });
    return;
  }
  const updated = await db
    .update(reminderSubscriptionsTable)
    .set({ status: "unsubscribed", updatedAt: new Date() })
    .where(eq(reminderSubscriptionsTable.manageToken, parsed.data.token))
    .returning({ id: reminderSubscriptionsTable.id });
  if (updated.length === 0) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }
  res.json({
    success: true,
    message: "You've been unsubscribed from PennPaps supply reminders.",
  });
});

export default router;

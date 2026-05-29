/**
 * Reminder subscription routes — public, capability-token-gated.
 *
 * Forward-port of main commit 1e50795 (Task #18) — close the email-
 * enumeration and unauthenticated-token-disclosure holes in POST
 * /reminders. New + existing email branches now return identical
 * response shapes (no `manageToken`, no `alreadySubscribed`); the
 * manage token is only delivered via email.
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
  type ReminderItem,
} from "../../lib/api-zod/index.js";
import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
} from "@workspace/resupply-db";
import {
  sendReminderConfirmation,
  sendReminderManageLink,
} from "../../lib/storefront/reminderEmail.js";
import { attachSignedIn } from "../../middlewares/requireSignedIn.js";

type ReminderSubscriptionRow =
  Database["public"]["Tables"]["reminder_subscriptions"]["Row"];

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
      issues.push(
        `items[${i}].lastReplacedAt: not a valid calendar date (got "${it.lastReplacedAt}")`,
      );
    }
  });
  return issues.length > 0 ? issues : null;
}

function withNextDue(
  items: ReminderItem[],
): Array<ReminderItem & { nextDueAt: string }> {
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
    items: row.items as unknown as Array<ReminderItem & { nextDueAt: string }>,
    // PostgREST returns timestamptz as ISO string already.
    createdAt: row.created_at,
  };
}

// ---------- POST /reminders ----------
router.post("/reminders", async (req, res) => {
  // Honeypot must run before zod (zod strip would drop the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)
    ?.website;
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
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }

  // Belt-and-braces: the OpenAPI regex pattern accepts impossible dates
  // like 2026-02-31 (it only checks shape). Reject those before they
  // become bad nextDueAt values.
  const dateIssues = findInvalidDates(parsed.data.items);
  if (dateIssues) {
    res
      .status(400)
      .json({ error: "Invalid subscription", details: dateIssues });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const items = parsed.data.items;
  const itemsWithDue = withNextDue(items);

  const supabase = getSupabaseServiceRoleClient();

  // Look up by email. We branch hard here: existing rows DO NOT receive
  // the new items in the response and DO NOT have their token disclosed.
  // This closes a takeover hole where an attacker could submit a victim's
  // email and read back the capability token.
  const { data: existing, error: existingErr } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .select("email, manage_token")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;

  if (existing) {
    // Email the EXISTING manage link to the registered owner only. The
    // response is intentionally identical to the new-subscription response
    // so callers cannot determine whether the email was already on file
    // (preventing email-enumeration of health-adjacent subscriber data).
    let emailStatus: "sent" | "skipped" | "failed";
    try {
      const result = await sendReminderManageLink({
        toEmail: existing.email,
        manageToken: existing.manage_token,
      });
      emailStatus = !result.configured
        ? "skipped"
        : result.delivered
          ? "sent"
          : "failed";
    } catch (err) {
      req.log.warn({ err }, "reminder manage-link send threw");
      emailStatus = "failed";
    }

    res.json({
      success: true,
      emailStatus,
      message:
        "Check your email for a manage link to view or update your reminders.",
    });
    return;
  }

  // New row — insert and send confirmation. The manage token is delivered
  // only via email; it is never returned in the API response so that
  // unauthenticated callers cannot mint and retain tokens for arbitrary
  // email addresses without proving inbox ownership.
  const { data: row, error: insertErr } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .insert({
      email,
      manage_token: generateManageToken(),
      // The strongly-typed item array doesn't satisfy PostgREST's `Json`
      // type without a cast at the boundary.
      items: itemsWithDue as unknown as Json,
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .select(
      "id, email, manage_token, status, items, last_sent_at, created_at, updated_at",
    )
    .limit(1)
    .maybeSingle();
  if (insertErr) {
    // Two concurrent POSTs with the same email can both pass the SELECT
    // check above and race to INSERT. The unique index on email makes
    // exactly one win; the loser gets a 23505. Return the same success
    // shape as the existing-row branch so the user experience is identical.
    if ((insertErr as { code?: string }).code === "23505") {
      res.json({
        success: true,
        emailStatus: "skipped",
        message:
          "Check your email for a manage link to view or update your reminders.",
      });
      return;
    }
    throw insertErr;
  }
  if (!row) {
    throw new Error("INSERT returned no rows");
  }

  let emailStatus: "sent" | "skipped" | "failed";
  try {
    const result = await sendReminderConfirmation({
      toEmail: row.email,
      manageToken: row.manage_token,
      items: itemsWithDue,
    });
    emailStatus = !result.configured
      ? "skipped"
      : result.delivered
        ? "sent"
        : "failed";
  } catch (err) {
    req.log.warn({ err }, "reminder confirmation send threw");
    emailStatus = "failed";
  }

  res.json({
    success: true,
    emailStatus,
    message:
      "Check your email for a manage link to view or update your reminders.",
  });
});

/**
 * Manage-route lookup key resolver (P5).
 *
 * The historical contract for /reminders/manage* was "token in query
 * = sole auth" so the magic-link emails worked for guest subscribers.
 * That broke the UX for signed-in shoppers, who had to leave the SPA,
 * open their inbox, and click a link just to edit a list they could
 * already see in /account. We now accept EITHER:
 *
 *   1. `?token=...` (capability token, unchanged), OR
 *   2. an `attachSignedIn` session — we look up by the session's
 *      email (lowercased the same way the subscribe path stores it).
 *
 * Token wins when both are present so a deep-linked manage email
 * always lands on the row it refers to, even if the recipient was
 * happening to be signed in as a different customer at the time.
 *
 * Returns `{ column, value }` for a `.eq()` clause, or null with a
 * status + message the handler should return.
 */
function resolveManageLookup(
  req: import("express").Request,
):
  | { ok: true; column: "manage_token" | "email"; value: string }
  | { ok: false; status: number; message: string } {
  const tokenParsed = GetReminderSubscriptionQueryParams.safeParse(req.query);
  if (tokenParsed.success) {
    return { ok: true, column: "manage_token", value: tokenParsed.data.token };
  }
  const email = req.shopCustomerEmail?.toLowerCase().trim();
  if (email) {
    return { ok: true, column: "email", value: email };
  }
  return {
    ok: false,
    status: 401,
    message: "sign_in_required or token query parameter — pass one of the two",
  };
}

// ---------- GET /reminders/manage[?token=...] ----------
// Auth: token in query OR signed-in session. See resolveManageLookup.
router.get("/reminders/manage", attachSignedIn, async (req, res) => {
  const lookup = resolveManageLookup(req);
  if (!lookup.ok) {
    res.status(lookup.status).json({ error: lookup.message });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .select(
      "id, email, manage_token, status, items, last_sent_at, created_at, updated_at",
    )
    .eq(lookup.column, lookup.value)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }
  res.json(toView(row));
});

// ---------- PATCH /reminders/manage[?token=...] ----------
// Auth: token in query OR signed-in session. See resolveManageLookup.
router.patch("/reminders/manage", attachSignedIn, async (req, res) => {
  const lookup = resolveManageLookup(req);
  if (!lookup.ok) {
    res.status(lookup.status).json({ error: lookup.message });
    return;
  }
  const bodyParsed = UpdateReminderSubscriptionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: "Invalid update",
      details: bodyParsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }

  const dateIssues = findInvalidDates(bodyParsed.data.items);
  if (dateIssues) {
    res.status(400).json({ error: "Invalid update", details: dateIssues });
    return;
  }

  const itemsWithDue = withNextDue(bodyParsed.data.items);

  const supabase = getSupabaseServiceRoleClient();
  const { data: updated, error } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .update({
      items: itemsWithDue as unknown as Json,
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq(lookup.column, lookup.value)
    .select(
      "id, email, manage_token, status, items, last_sent_at, created_at, updated_at",
    )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }
  res.json(toView(updated));
});

// ---------- POST /reminders/manage/unsubscribe[?token=...] ----------
// Auth: token in query OR signed-in session. See resolveManageLookup.
router.post(
  "/reminders/manage/unsubscribe",
  attachSignedIn,
  async (req, res) => {
    const lookup = resolveManageLookup(req);
    if (!lookup.ok) {
      res.status(lookup.status).json({ error: lookup.message });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("public")
      .from("reminder_subscriptions")
      .update({
        status: "unsubscribed",
        updated_at: new Date().toISOString(),
      })
      .eq(lookup.column, lookup.value)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(404).json({ error: "Subscription not found" });
      return;
    }
    res.json({
      success: true,
      message: "You've been unsubscribed from PennPaps supply reminders.",
    });
  },
);

export default router;

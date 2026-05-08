// /admin/lookup — global cross-entity lookup bar.
//
// Single endpoint that takes a free-text query and dispatches to the
// right index based on what the input "looks like":
//   * 10-15 digits / +E.164 → patient by direct phone_e164 equality
//   * contains "@"           → shop customer by email_lower
//   * UUIDv4 shape           → patient / conversation / episode / fulfillment
//   * starts with "cs_"      → shop order by stripe_session_id
//   * 12+ hex chars (no @)   → shop order by stripe_session_id LIKE %tail
//
// Each hit includes a `kind` and a relative URL the dashboard can
// turn into a navigable link. PHI policy: phone numbers and email
// addresses are NEVER echoed back; the response includes only ids,
// channel labels, and the patient name (already permitted elsewhere
// in the admin console).

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  conversations,
  episodes,
  fulfillments,
  getDbPool,
  patients,
  shopCustomers,
  shopOrders,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

interface Hit {
  kind:
    | "patient"
    | "conversation"
    | "episode"
    | "fulfillment"
    | "shop_order"
    | "shop_customer";
  id: string;
  label: string;
  href: string;
  hint?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stripe Checkout Session ids are `cs_` + 60-ish base62 chars; the
// upper bound here is generous (Stripe has shipped variants up to
// ~80 chars) but tight enough that a megabyte-long admin query never
// gets sent through Postgres as an `=` lookup.
const STRIPE_SESSION_RE = /^cs_[a-zA-Z0-9_]{20,200}$/;
const HEX_TAIL_RE = /^[A-Za-z0-9_-]{8,40}$/;
// Bounded length is deliberate (max 19 chars total: optional '+' + 18
// digit/separator characters) so a malformed input can't drag the
// route into a long-running normalization or DB call.
const PHONE_RE = /^\+?\d[\d\s().-]{6,18}$/;

// Max accepted query length. Above this we short-circuit to an empty
// result rather than running every regex + DB lookup. Defense-in-
// depth — the route is already admin-gated, but a slow query log
// flooded with megabyte-long `q` values is its own problem.
const MAX_QUERY_LENGTH = 200;

router.get("/admin/lookup", requireAdmin, async (req, res) => {
  const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  // Cap before any further work. Deliberate empty-result response (not
  // 400) so the admin UI can keep typing without the lookup bar going
  // red on a single keystroke that briefly exceeds the cap.
  if (raw.length > MAX_QUERY_LENGTH) {
    res.json({ q: raw.slice(0, MAX_QUERY_LENGTH), hits: [] });
    return;
  }
  const q = raw;
  if (q.length < 3) {
    res.json({ q, hits: [] });
    return;
  }

  const db = drizzle(getDbPool());
  const hits: Hit[] = [];

  // Phone? Strip non-digits and check.
  const digits = q.replace(/\D/g, "");
  if (PHONE_RE.test(q) && digits.length >= 7) {
    const e164 = normalizeE164(
      digits.length === 10 ? `+1${digits}` : `+${digits}`,
    );
    if (e164) {
      const rows = await db
        .select({
          patientId: patients.id,
          firstName: patients.legalFirstName,
          lastName: patients.legalLastName,
          pacwareId: patients.pacwareId,
        })
        .from(patients)
        .where(eq(patients.phoneE164, e164))
        .limit(5);
      for (const r of rows) {
        const name = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
        hits.push({
          kind: "patient",
          id: r.patientId,
          label: name || "(no name on file)",
          href: `/admin/patients/${r.patientId}`,
          hint: r.pacwareId ? `PACware #${r.pacwareId}` : null,
        });
      }
    }
  }

  // Email? Look up by email_lower in shopCustomers (the only place we
  // store email in plaintext on the cash-pay surface).
  if (q.includes("@")) {
    const emailLower = q.toLowerCase();
    const rows = await db
      .select({
        customerId: shopCustomers.customerId,
        emailLower: shopCustomers.emailLower,
        displayName: shopCustomers.displayName,
      })
      .from(shopCustomers)
      .where(eq(shopCustomers.emailLower, emailLower))
      .limit(5);
    for (const r of rows) {
      hits.push({
        kind: "shop_customer",
        id: r.customerId,
        label: r.displayName ?? r.emailLower ?? r.customerId,
        // Customers don't have an admin detail page yet; deep-link to
        // the abandoned-cart list filtered on the user (close enough).
        href: `/admin/shop/abandoned-carts?customerId=${encodeURIComponent(r.customerId)}`,
        hint: "Cash-pay shop customer",
      });
    }
  }

  // UUID? Try patients / conversations / episodes / fulfillments.
  if (UUID_RE.test(q)) {
    const [pat] = await db
      .select({
        id: patients.id,
        firstName: patients.legalFirstName,
        lastName: patients.legalLastName,
        pacwareId: patients.pacwareId,
      })
      .from(patients)
      .where(eq(patients.id, q))
      .limit(1);
    if (pat) {
      const name = [pat.firstName, pat.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      hits.push({
        kind: "patient",
        id: pat.id,
        label: name || "(no name on file)",
        href: `/admin/patients/${pat.id}`,
        hint: pat.pacwareId ? `PACware #${pat.pacwareId}` : null,
      });
    }
    const [conv] = await db
      .select({
        id: conversations.id,
        patientId: conversations.patientId,
        channel: conversations.channel,
        status: conversations.status,
      })
      .from(conversations)
      .where(eq(conversations.id, q))
      .limit(1);
    if (conv) {
      hits.push({
        kind: "conversation",
        id: conv.id,
        label: `Conversation · ${conv.channel} · ${conv.status}`,
        href: `/admin/conversations/${conv.id}`,
      });
    }
    const [ep] = await db
      .select({
        id: episodes.id,
        status: episodes.status,
        dueAt: episodes.dueAt,
      })
      .from(episodes)
      .where(eq(episodes.id, q))
      .limit(1);
    if (ep) {
      hits.push({
        kind: "episode",
        id: ep.id,
        label: `Episode · ${ep.status}${ep.dueAt ? ` · due ${ep.dueAt.toISOString().slice(0, 10)}` : ""}`,
        href: `/admin/episodes`,
      });
    }
    const [fu] = await db
      .select({ id: fulfillments.id, status: fulfillments.status })
      .from(fulfillments)
      .where(eq(fulfillments.id, q))
      .limit(1);
    if (fu) {
      hits.push({
        kind: "fulfillment",
        id: fu.id,
        label: `Fulfillment · ${fu.status}`,
        // No dedicated fulfillment page yet — link to the patient
        // detail when we can resolve it (skip for now if unavailable).
        href: `/admin/episodes`,
      });
    }
  }

  // Stripe Checkout Session id (full or last-12).
  if (STRIPE_SESSION_RE.test(q)) {
    const [order] = await db
      .select({
        id: shopOrders.id,
        stripeSessionId: shopOrders.stripeSessionId,
        status: shopOrders.status,
        amountTotalCents: shopOrders.amountTotalCents,
      })
      .from(shopOrders)
      .where(eq(shopOrders.stripeSessionId, q))
      .limit(1);
    if (order) {
      hits.push({
        kind: "shop_order",
        id: order.id,
        label: `Shop order · ${order.status}${order.amountTotalCents ? ` · $${(order.amountTotalCents / 100).toFixed(2)}` : ""}`,
        href: `/admin/shop/returns?orderId=${order.id}`,
        hint: order.stripeSessionId.slice(-12),
      });
    }
  } else if (HEX_TAIL_RE.test(q) && !UUID_RE.test(q) && !q.includes("@")) {
    // Last-N tail of a session id — match suffix.
    const rows = await db
      .select({
        id: shopOrders.id,
        stripeSessionId: shopOrders.stripeSessionId,
        status: shopOrders.status,
      })
      .from(shopOrders)
      // Escape LIKE metacharacters so an underscore in `q` matches a literal
      // underscore rather than acting as a single-character wildcard.
      .where(sql`${shopOrders.stripeSessionId} LIKE ${"%" + q.replace(/[%_\\]/g, "\\$&")} ESCAPE '\\'`)
      .limit(5);
    for (const order of rows) {
      hits.push({
        kind: "shop_order",
        id: order.id,
        label: `Shop order · ${order.status}`,
        href: `/admin/shop/returns?orderId=${order.id}`,
        hint: order.stripeSessionId.slice(-12),
      });
    }
  }

  res.json({ q, hits });
});

export default router;

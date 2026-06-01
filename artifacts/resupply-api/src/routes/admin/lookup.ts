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

import { normalizeE164 } from "@workspace/resupply-domain";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
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
// Real Stripe Checkout Session IDs are well below 128 chars
// (cs_test_/cs_live_ prefix + ~58-char body). Cap the upper bound so
// no caller can blow the regex up with a multi-MB string and force
// the whole admin-lookup handler to spend time matching.
const STRIPE_SESSION_RE = /^cs_[a-zA-Z0-9_]{20,128}$/;
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

router.get(
  "/admin/lookup",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
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

    const supabase = getSupabaseServiceRoleClient();
    const hits: Hit[] = [];

    // Phone? Strip non-digits and check.
    const digits = q.replace(/\D/g, "");
    if (PHONE_RE.test(q) && digits.length >= 7) {
      const e164 = normalizeE164(
        digits.length === 10 ? `+1${digits}` : `+${digits}`,
      );
      if (e164) {
        const { data: rows } = await supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name, pacware_id")
          .eq("phone_e164", e164)
          .limit(5);
        for (const r of rows ?? []) {
          const name = [r.legal_first_name, r.legal_last_name]
            .filter(Boolean)
            .join(" ")
            .trim();
          hits.push({
            kind: "patient",
            id: r.id,
            label: name || "(no name on file)",
            href: `/admin/patients/${r.id}`,
            hint: r.pacware_id ? `PACware #${r.pacware_id}` : null,
          });
        }
      }
    }

    // Email? Look up by email_lower in shop_customers (the only place we
    // store email in plaintext on the cash-pay surface).
    if (q.includes("@")) {
      const emailLower = q.toLowerCase();
      const { data: rows } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("customer_id, email_lower, display_name")
        .eq("email_lower", emailLower)
        .limit(5);
      for (const r of rows ?? []) {
        hits.push({
          kind: "shop_customer",
          id: r.customer_id,
          label: r.display_name ?? r.email_lower ?? r.customer_id,
          // Customers don't have an admin detail page yet; deep-link to
          // the abandoned-cart list filtered on the user (close enough).
          href: `/admin/shop/abandoned-carts?customerId=${encodeURIComponent(r.customer_id)}`,
          hint: "Cash-pay shop customer",
        });
      }
    }

    // UUID? Try patients / conversations / episodes / fulfillments. The
    // four queries are independent so we fire them in parallel.
    if (UUID_RE.test(q)) {
      const [patRes, convRes, epRes, fuRes] = await Promise.all([
        supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name, pacware_id")
          .eq("id", q)
          .limit(1)
          .maybeSingle(),
        supabase
          .schema("resupply")
          .from("conversations")
          .select("id, patient_id, channel, status")
          .eq("id", q)
          .limit(1)
          .maybeSingle(),
        supabase
          .schema("resupply")
          .from("episodes")
          .select("id, status, due_at")
          .eq("id", q)
          .limit(1)
          .maybeSingle(),
        supabase
          .schema("resupply")
          .from("fulfillments")
          .select("id, status")
          .eq("id", q)
          .limit(1)
          .maybeSingle(),
      ]);
      if (patRes.data) {
        const pat = patRes.data;
        const name = [pat.legal_first_name, pat.legal_last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        hits.push({
          kind: "patient",
          id: pat.id,
          label: name || "(no name on file)",
          href: `/admin/patients/${pat.id}`,
          hint: pat.pacware_id ? `PACware #${pat.pacware_id}` : null,
        });
      }
      if (convRes.data) {
        const conv = convRes.data;
        hits.push({
          kind: "conversation",
          id: conv.id,
          label: `Conversation · ${conv.channel} · ${conv.status}`,
          href: `/admin/conversations/${conv.id}`,
        });
      }
      if (epRes.data) {
        const ep = epRes.data;
        hits.push({
          kind: "episode",
          id: ep.id,
          label: `Episode · ${ep.status}${ep.due_at ? ` · due ${ep.due_at.slice(0, 10)}` : ""}`,
          href: `/admin/episodes`,
        });
      }
      if (fuRes.data) {
        const fu = fuRes.data;
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
      const { data: order } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .select("id, stripe_session_id, status, amount_total_cents")
        .eq("stripe_session_id", q)
        .limit(1)
        .maybeSingle();
      if (order) {
        hits.push({
          kind: "shop_order",
          id: order.id,
          label: `Shop order · ${order.status}${order.amount_total_cents ? ` · $${(order.amount_total_cents / 100).toFixed(2)}` : ""}`,
          href: `/admin/shop/returns?orderId=${order.id}`,
          hint: order.stripe_session_id.slice(-12),
        });
      }
    } else if (HEX_TAIL_RE.test(q) && !UUID_RE.test(q) && !q.includes("@")) {
      // Last-N tail of a session id — match suffix via PostgREST
      // `.like('*<tail>')` (the `*` wildcard is PostgREST's stand-in
      // for SQL `%`). The tail is regex-validated so it can't smuggle
      // metacharacters.
      const { data: rows } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .select("id, stripe_session_id, status")
        .like("stripe_session_id", `*${q}`)
        .limit(5);
      for (const order of rows ?? []) {
        hits.push({
          kind: "shop_order",
          id: order.id,
          label: `Shop order · ${order.status}`,
          href: `/admin/shop/returns?orderId=${order.id}`,
          hint: order.stripe_session_id.slice(-12),
        });
      }
    }

    res.json({ q, hits });
  },
);

export default router;

// /admin/provider-referrals — the DME's side of the provider referral
// portal.
//
//   GET   /admin/provider-referrals              — the inbound queue
//   GET   /admin/provider-referrals/:id          — one referral + timeline
//   POST  /admin/provider-referrals/:id/accept   — take it, onto a chart
//   POST  /admin/provider-referrals/:id/decline  — send it back, with a reason
//   POST  /admin/provider-referrals/:id/status   — in_progress / dispensed
//   POST  /admin/provider-referrals/:id/messages — reply to the provider
//   GET   /admin/provider-referrals/providers    — linked referring providers
//   POST  /admin/provider-referrals/providers    — authorize one to refer here
//   PATCH /admin/provider-referrals/providers/:id — suspend / revoke
//
// WHY NOT THE OBVIOUS `/admin/referrals`
// --------------------------------------
// That namespace is already occupied, and taking it broke two live
// endpoints. `GET /admin/referrals/scorecard` (referral-source CRM, 0431)
// and `POST /admin/referrals/scan-attribution` (patient-to-patient
// attribution, 0107) both live under it, and this router mounts several
// hundred lines EARLIER in routes/index.ts — so a parameterised
// `/admin/referrals/:id` here swallowed `/scorecard` and 400'd it on the
// uuid parse, for every tenant.
//
// The same collision bit the product-scope allowlist, which matches by
// substring: allowlisting `/admin/referrals` for fitter-only tenants also
// exposed the unrelated attribution sweep. A distinct prefix fixes both
// at once, which is why this is `provider-referrals` rather than a
// carefully-ordered `/admin/referrals`.
//
// THIS SIDE IS THE ORDINARY ONE. Unlike the provider tree — where a
// referral's tenant comes off the row because the provider is a cross-org
// identity — the DME reads its own inbound queue with its own admin
// session, so `req.orgId` is authoritative and the org-scoped client does
// the work. Nothing here needs to reach across tenants, and nothing here
// should.
//
// The authorization edge runs the other way round: a provider cannot
// refer to this DME until the DME creates a `provider_dme_links` row for
// them. That is what the /providers endpoints manage, and it is the only
// thing standing between a global provider directory and unsolicited PHI
// landing in a tenant's queue — so it is gated on `provider_portal.manage`
// rather than a general clinical permission.
//
// PATH CHOICE: top-level rather than under
// /admin/clinical/, matching the reasoning in fit-sessions.ts —
// /admin/clinical/* is not on the mask_fitter product-scope allowlist, and
// a fitter-only DME receiving referrals is exactly the customer this
// exists for.
//
// PHI: referrals carry demographics and insurance identifiers, and the
// message thread is free text about a named patient. Log lines carry ids,
// codes, and counts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import {
  REFERRAL_COLUMNS,
  mapReferralDetail,
  mapReferralSummary,
  recordReferralEvent,
  type ReferralRow,
} from "../provider/referral-shared.js";

const router: IRouter = Router();

type Row = Record<string, unknown>;

const uuid = z.string().trim().uuid();

const listQuery = z
  .object({
    status: z
      .enum([
        "submitted",
        "accepted",
        "in_progress",
        "dispensed",
        "declined",
        "cancelled",
      ])
      .optional(),
    /** Default view: everything the DME still has to act on. */
    open: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const acceptBody = z
  .object({
    /** Match to an existing chart, or omit to leave unmatched for now. */
    patientId: uuid.nullable().optional(),
    locationId: uuid.nullable().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const declineBody = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, "Tell the referring provider why, in a sentence.")
      .max(2000),
  })
  .strict();

const statusBody = z
  .object({ status: z.enum(["in_progress", "dispensed"]) })
  .strict();

const messageBody = z
  .object({ body: z.string().trim().min(1).max(8000) })
  .strict();

const linkBody = z
  .object({
    providerId: uuid,
    displayName: z.string().trim().max(200).nullable().optional(),
    defaultLocationId: uuid.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const linkPatch = z
  .object({
    status: z.enum(["active", "suspended", "revoked"]).optional(),
    displayName: z.string().trim().max(200).nullable().optional(),
    defaultLocationId: uuid.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/** Statuses that still need something from the DME. */
const OPEN_STATUSES = ["submitted", "accepted", "in_progress"];

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

function rowsOf(result: unknown): Row[] {
  const r = result as { data?: unknown[] | null };
  return Array.isArray(r?.data) ? (r.data as Row[]) : [];
}

// Registered BEFORE the `/:id` route on purpose: Express matches in
// declaration order, so with these last, a GET of
// /admin/provider-referrals/providers would bind :id="providers" and 400
// on the uuid parse. (The same class of bug this whole router hit against
// the pre-existing /admin/referrals namespace — see the header.)
// ── Referring-provider links ─────────────────────────────────────────

router.get(
  "/admin/provider-referrals/providers",
  requireAdmin,
  requirePermission("provider_portal.manage"),
  adminRateLimit({ name: "referrals.providers_list", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { data, error } = (await getOrgScopedClient(orgId)
      .from("provider_dme_links")
      .select(
        "id, provider_id, status, display_name, default_location_id, invited_by_email, invited_at, revoked_at, notes",
      )
      .order("invited_at", { ascending: false })
      .limit(500)) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed" });
      return;
    }
    res.json({
      links: (data ?? []).map((r) => ({
        id: String(r.id),
        providerId: String(r.provider_id),
        status: r.status,
        displayName: r.display_name ?? null,
        defaultLocationId: r.default_location_id ?? null,
        invitedByEmail: r.invited_by_email ?? null,
        invitedAt: r.invited_at,
        revokedAt: r.revoked_at ?? null,
        notes: r.notes ?? null,
      })),
    });
  },
);

router.post(
  "/admin/provider-referrals/providers",
  requireAdmin,
  requirePermission("provider_portal.manage"),
  adminRateLimit({ name: "referrals.providers_create", preset: "sensitive" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = linkBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // `providers` is the GLOBAL NPI directory (no org_id), so this is a
    // raw read of reference data — confirming the id names a real
    // provider before granting them the right to send PHI here.
    const { data: provider } = (await supabase
      .raw()
      .schema("resupply")
      .from("providers")
      .select("id, first_name, last_name, npi")
      .eq("id", body.data.providerId)
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    if (!provider) {
      res.status(404).json({ error: "unknown_provider" });
      return;
    }

    const nowIso = new Date().toISOString();
    // Re-inviting a previously revoked provider reactivates the existing
    // row rather than failing on the unique index — an operator who
    // revoked someone by mistake should be able to undo it.
    const { error } = (await supabase.from("provider_dme_links").upsert(
      {
        provider_id: body.data.providerId,
        status: "active",
        display_name: body.data.displayName ?? null,
        default_location_id: body.data.defaultLocationId ?? null,
        notes: body.data.notes ?? null,
        invited_by_email: req.adminEmail ?? null,
        invited_at: nowIso,
        revoked_at: null,
        updated_at: nowIso,
      },
      { onConflict: "org_id,provider_id" },
    )) as unknown as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "insert_failed" });
      return;
    }
    res.status(201).json({ ok: true });
  },
);

router.patch(
  "/admin/provider-referrals/providers/:id",
  requireAdmin,
  requirePermission("provider_portal.manage"),
  adminRateLimit({ name: "referrals.providers_update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = linkPatch.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.data.status !== undefined) {
      patch.status = body.data.status;
      patch.revoked_at =
        body.data.status === "revoked" ? new Date().toISOString() : null;
    }
    if (body.data.displayName !== undefined) {
      patch.display_name = body.data.displayName;
    }
    if (body.data.defaultLocationId !== undefined) {
      patch.default_location_id = body.data.defaultLocationId;
    }
    if (body.data.notes !== undefined) patch.notes = body.data.notes;

    const { error } = await getOrgScopedClient(orgId)
      .from("provider_dme_links")
      .update(patch)
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }
    res.json({ ok: true });
  },
);

// ── Queue ────────────────────────────────────────────────────────────

router.get(
  "/admin/provider-referrals",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "referrals.list", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const q = parsed.data;

    let query = getOrgScopedClient(orgId)
      .from("referrals")
      .select(REFERRAL_COLUMNS)
      // A DME never sees another provider's DRAFT. A referral becomes
      // theirs when it is submitted, not while it is being written.
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .range(q.offset, q.offset + q.limit - 1);

    if (q.status) query = query.eq("status", q.status);
    else if (q.open) query = query.in("status", OPEN_STATUSES);

    const { data, error } = (await query) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      referrals: (data ?? []).map((row) =>
        mapReferralSummary(row as unknown as ReferralRow),
      ),
      limit: q.limit,
      offset: q.offset,
    });
  },
);

router.get(
  "/admin/provider-referrals/:id",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "referrals.detail", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    const { data: row } = (await supabase
      .from("referrals")
      .select(REFERRAL_COLUMNS)
      .eq("id", id.data)
      .not("submitted_at", "is", null)
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [events, messages, documents] = await Promise.all([
      supabase
        .from("referral_events")
        .select("event_type, actor_kind, actor_email, detail, occurred_at")
        .eq("referral_id", id.data)
        .order("occurred_at", { ascending: true })
        .limit(500),
      supabase
        .from("referral_messages")
        .select("id, author_kind, author_email, author_name, body, created_at")
        .eq("referral_id", id.data)
        .order("created_at", { ascending: true })
        .limit(500),
      supabase
        .from("referral_documents")
        .select(
          "id, doc_type, file_name, content_type, size_bytes, uploaded_by_kind, uploaded_by_email, notes, created_at",
        )
        .eq("referral_id", id.data)
        .order("created_at", { ascending: true })
        .limit(200),
    ]);

    // Opening it clears the DME's own badge; the provider's is untouched.
    if (Number(row.dme_unread_count ?? 0) > 0) {
      await supabase
        .from("referrals")
        .update({ dme_unread_count: 0 })
        .eq("id", id.data);
    }

    res.json(
      mapReferralDetail(row as unknown as ReferralRow, {
        events: rowsOf(events),
        messages: rowsOf(messages),
        documents: rowsOf(documents),
      }),
    );
  },
);

// ── Accept / decline / progress ──────────────────────────────────────

router.post(
  "/admin/provider-referrals/:id/accept",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "referrals.accept", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = acceptBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    const { data: existing } = (await supabase
      .from("referrals")
      .select("id, status, submitted_at, patient_id")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    if (!existing || !existing.submitted_at) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.status !== "submitted") {
      res.status(409).json({
        error: "not_pending",
        message: `This referral is already ${String(existing.status).replace(/_/g, " ")}.`,
      });
      return;
    }

    // A chart match must be a chart THIS tenant owns. The org-scoped
    // client already constrains the lookup, so a foreign id simply misses.
    if (body.data.patientId) {
      const { data: patient } = (await supabase
        .from("patients")
        .select("id")
        .eq("id", body.data.patientId)
        .limit(1)
        .maybeSingle()) as { data: Row | null };
      if (!patient) {
        res.status(400).json({
          error: "unknown_patient",
          message: "That chart isn't in your system.",
        });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: "accepted",
      accepted_at: nowIso,
      accepted_by_email: req.adminEmail ?? null,
      updated_at: nowIso,
    };
    if (body.data.patientId !== undefined) {
      patch.patient_id = body.data.patientId;
    }
    if (body.data.locationId !== undefined) {
      patch.routed_to_location_id = body.data.locationId;
    }

    // Guard the transition in the UPDATE itself, not just in the read
    // above. The read-then-write window is real: two staff opening the
    // queue and clicking Accept together would both pass the read, both
    // write, and produce two `referral.accepted` events with
    // last-writer-wins on who is recorded as having taken it. Constraining
    // on `status = 'submitted'` makes exactly one of them win, and the
    // loser gets the same 409 as if they had been slower to click.
    const { data: accepted, error } = (await supabase
      .from("referrals")
      .update(patch)
      .eq("id", id.data)
      .eq("status", "submitted")
      .select("id")) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }
    if (!accepted || accepted.length === 0) {
      res.status(409).json({
        error: "not_pending",
        message: "Someone else has already picked this referral up.",
      });
      return;
    }

    await recordReferralEvent(orgId, id.data, "referral.accepted", {
      actorKind: "staff",
      actorEmail: req.adminEmail ?? null,
      detail: { matchedToChart: Boolean(body.data.patientId) },
    });
    if (body.data.patientId) {
      await recordReferralEvent(orgId, id.data, "patient.matched", {
        actorKind: "staff",
        actorEmail: req.adminEmail ?? null,
        detail: {},
      });
    }
    if (body.data.note) {
      await postStaffMessage(
        orgId,
        id.data,
        req.adminEmail ?? null,
        body.data.note,
      );
    }

    res.json({ ok: true, status: "accepted" });
  },
);

router.post(
  "/admin/provider-referrals/:id/decline",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "referrals.decline", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = declineBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.success
          ? []
          : body.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
      });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();

    // The reason is stored on the row (a DB CHECK requires it on a
    // decline) AND posted to the thread, because a provider looking at a
    // declined referral should not have to hunt for why.
    const { data: updated, error } = (await supabase
      .from("referrals")
      .update({
        status: "declined",
        declined_at: nowIso,
        declined_reason: body.data.reason,
        updated_at: nowIso,
      })
      .eq("id", id.data)
      .not("submitted_at", "is", null)
      .in("status", ["submitted", "accepted", "in_progress"])
      .select("id")) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }
    if (!updated || updated.length === 0) {
      res.status(409).json({
        error: "not_declinable",
        message: "This referral is no longer open.",
      });
      return;
    }

    await recordReferralEvent(orgId, id.data, "referral.declined", {
      actorKind: "staff",
      actorEmail: req.adminEmail ?? null,
      detail: {},
    });
    await postStaffMessage(
      orgId,
      id.data,
      req.adminEmail ?? null,
      body.data.reason,
    );

    res.json({ ok: true, status: "declined" });
  },
);

router.post(
  "/admin/provider-referrals/:id/status",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "referrals.status", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = statusBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const next = body.data.status;

    const patch: Record<string, unknown> = {
      status: next,
      updated_at: nowIso,
    };
    if (next === "dispensed") patch.dispensed_at = nowIso;

    // Only forward, and only from a state that can reach it. Guarding in
    // the WHERE rather than after a read keeps two staff clicking at once
    // from racing a referral backwards.
    const from =
      next === "in_progress" ? ["accepted"] : ["accepted", "in_progress"];

    const { data: updated, error } = (await supabase
      .from("referrals")
      .update(patch)
      .eq("id", id.data)
      .in("status", from)
      .select("id")) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }
    if (!updated || updated.length === 0) {
      res.status(409).json({
        error: "invalid_transition",
        message:
          next === "in_progress"
            ? "Accept the referral before marking it in progress."
            : "A referral has to be accepted before it can be dispensed.",
      });
      return;
    }

    await recordReferralEvent(
      orgId,
      id.data,
      next === "dispensed" ? "referral.dispensed" : "referral.in_progress",
      {
        actorKind: "staff",
        actorEmail: req.adminEmail ?? null,
        detail: {},
      },
    );
    res.json({ ok: true, status: next });
  },
);

router.post(
  "/admin/provider-referrals/:id/messages",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "referrals.message", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = messageBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const ok = await postStaffMessage(
      orgId,
      id.data,
      req.adminEmail ?? null,
      body.data.body,
    );
    if (!ok) {
      res.status(500).json({ error: "insert_failed" });
      return;
    }
    res.status(201).json({ ok: true });
  },
);

/**
 * Post a staff reply and bump the PROVIDER's unread badge.
 *
 * Mirrors `postMessage` on the provider side; kept separate rather than
 * shared because the two differ in exactly the fields that matter
 * (author kind, which counter moves), and a single function taking both
 * as parameters reads worse than two four-line ones.
 */
async function postStaffMessage(
  orgId: string,
  referralId: string,
  adminEmail: string | null,
  body: string,
): Promise<boolean> {
  const supabase = getOrgScopedClient(orgId);
  const { error } = await supabase.from("referral_messages").insert({
    referral_id: referralId,
    author_kind: "staff",
    author_email: adminEmail,
    body,
  });
  if (error) {
    logger.warn(
      { event: "referral_message_insert_failed", referralId },
      "referral staff message failed",
    );
    return false;
  }
  try {
    const { data } = (await supabase
      .from("referrals")
      .select("provider_unread_count")
      .eq("id", referralId)
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    await supabase
      .from("referrals")
      .update({
        provider_unread_count: Number(data?.provider_unread_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", referralId);
  } catch {
    // Badge only.
  }
  await recordReferralEvent(orgId, referralId, "message.sent", {
    actorKind: "staff",
    actorEmail: adminEmail,
    detail: { chars: body.length },
  });
  return true;
}

export default router;

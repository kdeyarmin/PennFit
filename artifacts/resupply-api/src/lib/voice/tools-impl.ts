// Voice tool implementations — the live side effects the model can
// invoke during a call. The contract (`ToolDispatcher`) lives in
// @workspace/resupply-ai; this file is the API-side implementation.
//
// PHI rules baked in:
//   * Patient identifiers (patientId, episodeId, conversationId) are
//     bound at construction time. The model NEVER sees them in any
//     argument or any return value.
//   * All free-form caller content stays in the `messages` table.
//     Tool args + results carry only the structured shape the model
//     needs to reason — never raw addresses, full names, or DOBs on
//     the way out.
//   * Identity verification gates every other side-effect tool. Until
//     `verify_patient_identity` succeeds, dispatcher returns a stub
//     `identity_required` shape so the model is forced to verify
//     first. The two exceptions are `request_human_handoff` and
//     `end_call` — a panicking caller MUST be able to escape to a
//     human or hang up without first proving their date of birth.

import { timingSafeEqual, randomUUID } from "node:crypto";

import {
  getSupabaseServiceRoleClient,
  type Json,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

import type {
  DispatchToolCall,
  DispatchToolResult,
  ToolDispatcher,
  ToolName,
} from "@workspace/resupply-ai";

const MAX_VERIFY_ATTEMPTS = 3;

// Tools the dispatcher will still serve once the caller has burned all
// MAX_VERIFY_ATTEMPTS without proving identity. Same as IDENTITY_EXEMPT
// minus `verify_patient_identity` itself — once you're locked out you
// don't get to keep trying. Caller can still escalate to a human or
// hang up cleanly. Anything else gets the same `identity_required`
// stub the unverified path returns, so the model is forced to call
// handoff/end_call instead of looping on side-effect tools.
const POST_LOCKOUT_ALLOWED: ReadonlySet<ToolName> = new Set([
  "request_human_handoff",
  "end_call",
]);

// Shape the dispatcher returns when the model tries to use a side-
// effect tool before identity is verified. `verify_patient_identity`-
// shaped result so the wire payload matches `ToolResultByName`. The
// model interprets `matched: false` as "verify first, then retry".
//
// We deliberately do NOT widen `ToolResultByName` with a generic
// `identity_required` variant: that would force every callsite that
// reads a tool result to handle a fourth shape, even when the
// dispatcher guarantees it's unreachable. Routing identity-required
// callers back through verification keeps the model's state machine
// simple.
function identityRequiredResultFor<K extends ToolName>(
  name: K,
): DispatchToolResult<K>["result"] {
  // Use casts at the leaves — TS can't see that each branch matches
  // its name's `ToolResultByName[K]` shape at the type level.
  switch (name) {
    case "verify_patient_identity":
      // Reached when the dispatcher's lockout guard refuses a 4th+
      // verify attempt (verifyAttempts >= MAX, !verified). We report
      // `attempts_remaining: 0` so the model sees a stable
      // exhausted-state signal and routes to handoff/end_call instead
      // of looping on more verify calls. This branch is NOT hit on
      // the pre-lockout exempt path — verifyIdentity() handles those
      // and returns the real countdown.
      return {
        matched: false,
        attempts_remaining: 0,
      } as DispatchToolResult<K>["result"];
    case "lookup_resupply_inventory":
      return { items: [] } as unknown as DispatchToolResult<K>["result"];
    case "get_customer_chart":
      return {
        kind: "patient",
        supplies_due: [],
        has_open_followups: false,
      } as unknown as DispatchToolResult<K>["result"];
    case "get_shipping_address":
      return {
        street_name: "",
        city: "",
        state: "",
      } as unknown as DispatchToolResult<K>["result"];
    case "update_shipping_address":
      return {
        ok: false,
        summary: "identity_not_verified",
      } as unknown as DispatchToolResult<K>["result"];
    case "place_resupply_order":
      return {
        ok: false,
        order_id: "",
        accepted_skus: [],
      } as unknown as DispatchToolResult<K>["result"];
    case "request_human_handoff":
    case "end_call":
      // Unreachable — both are exempt from the identity gate.
      return { ok: true } as unknown as DispatchToolResult<K>["result"];
  }
  // Exhaustiveness — TypeScript should already have narrowed away.
  throw new Error(`Unknown tool: ${String(name)}`);
}

const IDENTITY_EXEMPT: ReadonlySet<ToolName> = new Set([
  "verify_patient_identity",
  "request_human_handoff",
  "end_call",
]);

export interface VoiceToolDispatcherDeps {
  /** Optional Supabase client. Tests inject a stub; production callers
   *  pass nothing and the dispatcher resolves the singleton at construct. */
  supabase?: ResupplySupabaseClient;
  patientId: string;
  conversationId: string;
  episodeId: string;
}

export interface VoiceToolDispatcher extends ToolDispatcher {
  isIdentityVerified(): boolean;
}

export function createVoiceToolDispatcher(
  deps: VoiceToolDispatcherDeps,
): VoiceToolDispatcher {
  return new Impl(deps);
}

class Impl implements VoiceToolDispatcher {
  private verified = false;
  private verifyAttempts = 0;
  private readonly supabase: ResupplySupabaseClient;

  constructor(private readonly deps: VoiceToolDispatcherDeps) {
    this.supabase = deps.supabase ?? getSupabaseServiceRoleClient();
  }

  isIdentityVerified(): boolean {
    return this.verified;
  }

  async dispatch<K extends ToolName>(
    call: DispatchToolCall<K>,
  ): Promise<DispatchToolResult<K>> {
    // Hard lockout: once MAX_VERIFY_ATTEMPTS DOB checks have failed
    // without success, the only escape paths are human handoff or
    // ending the call. This includes refusing further
    // verify_patient_identity calls — those would just keep burning
    // patient time on a doomed loop. The check sits ABOVE the regular
    // identity-exempt gate so that even verify_patient_identity is
    // refused once exhausted.
    if (
      !this.verified &&
      this.verifyAttempts >= MAX_VERIFY_ATTEMPTS &&
      !POST_LOCKOUT_ALLOWED.has(call.name)
    ) {
      return {
        callId: call.callId,
        name: call.name,
        result: identityRequiredResultFor(call.name),
      };
    }
    if (!this.verified && !IDENTITY_EXEMPT.has(call.name)) {
      return {
        callId: call.callId,
        name: call.name,
        result: identityRequiredResultFor(call.name),
      };
    }
    switch (call.name) {
      case "verify_patient_identity":
        return (await this.verifyIdentity(
          call as DispatchToolCall<"verify_patient_identity">,
        )) as DispatchToolResult<K>;
      case "lookup_resupply_inventory":
        return (await this.lookupInventory(
          call as DispatchToolCall<"lookup_resupply_inventory">,
        )) as DispatchToolResult<K>;
      case "get_customer_chart":
        return (await this.getCustomerChart(
          call as DispatchToolCall<"get_customer_chart">,
        )) as DispatchToolResult<K>;
      case "get_shipping_address":
        return (await this.getShippingAddress(
          call as DispatchToolCall<"get_shipping_address">,
        )) as DispatchToolResult<K>;
      case "update_shipping_address":
        return (await this.updateShippingAddress(
          call as DispatchToolCall<"update_shipping_address">,
        )) as DispatchToolResult<K>;
      case "place_resupply_order":
        return (await this.placeResupplyOrder(
          call as DispatchToolCall<"place_resupply_order">,
        )) as DispatchToolResult<K>;
      case "request_human_handoff":
        return (await this.requestHumanHandoff(
          call as DispatchToolCall<"request_human_handoff">,
        )) as DispatchToolResult<K>;
      case "end_call":
        return (await this.endCall(
          call as DispatchToolCall<"end_call">,
        )) as DispatchToolResult<K>;
    }
    throw new Error(`Unknown tool: ${String(call.name)}`);
  }

  private async verifyIdentity(
    call: DispatchToolCall<"verify_patient_identity">,
  ): Promise<DispatchToolResult<"verify_patient_identity">> {
    // Read DOB + first name FIRST. If the patient row was deleted
    // (or never had a DOB on file), we don't want to burn a verify
    // attempt — three calls and the patient is locked out without
    // the system ever actually comparing anything. The previous
    // order incremented `verifyAttempts` before this lookup.
    //
    // The plaintext DOB is compared in Node with `timingSafeEqual`
    // so we don't leak match duration via the SQL planner.
    const { data: row, error } = await this.supabase
      .schema("resupply")
      .from("patients")
      .select("date_of_birth, legal_first_name")
      .eq("id", this.deps.patientId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!row || !row.date_of_birth) {
      // No comparison happened — don't increment.
      const attemptsRemaining = Math.max(
        0,
        MAX_VERIFY_ATTEMPTS - this.verifyAttempts,
      );
      return {
        callId: call.callId,
        name: call.name,
        result: { matched: false, attempts_remaining: attemptsRemaining },
      };
    }

    this.verifyAttempts += 1;
    const attemptsRemaining = Math.max(
      0,
      MAX_VERIFY_ATTEMPTS - this.verifyAttempts,
    );

    const matched = constantTimeStringEquals(
      call.args.date_of_birth,
      row.date_of_birth,
    );
    if (matched) {
      this.verified = true;
      return {
        callId: call.callId,
        name: call.name,
        result: {
          matched: true,
          first_name: row.legal_first_name ?? undefined,
          attempts_remaining: attemptsRemaining,
        },
      };
    }
    return {
      callId: call.callId,
      name: call.name,
      result: { matched: false, attempts_remaining: attemptsRemaining },
    };
  }

  private async lookupInventory(
    call: DispatchToolCall<"lookup_resupply_inventory">,
  ): Promise<DispatchToolResult<"lookup_resupply_inventory">> {
    const { data: rows, error } = await this.supabase
      .schema("resupply")
      .from("prescriptions")
      .select("item_sku, cadence_days")
      .eq("patient_id", this.deps.patientId)
      .eq("status", "active");
    if (error) throw error;

    const items = (rows ?? [])
      .filter((r) => r.item_sku)
      .map((r) => ({
        sku: r.item_sku,
        // We don't carry SKU descriptions in our schema yet — the
        // Pacware product catalogue lives outside this DB. The model's
        // prompt tells it the description is the SKU's product
        // description in plain English; for now we hand it the SKU
        // itself so it can still read it back to the patient.
        description: r.item_sku,
        quantity: 1,
        due_reason: `every ${r.cadence_days} days`,
      }));

    return {
      callId: call.callId,
      name: call.name,
      result: { items },
    };
  }

  private async getCustomerChart(
    call: DispatchToolCall<"get_customer_chart">,
  ): Promise<DispatchToolResult<"get_customer_chart">> {
    // Consolidated, SAFE-TO-VOICE account snapshot for the verified
    // caller: first name + supplies due + latest order date + an
    // open-followup flag. We never return addresses, order contents,
    // DOB, phone, email, or any identifier (the model never sees the
    // bound patientId). The agent prompt also forbids reading full PHI
    // aloud — this is defense in depth.
    const patientId = this.deps.patientId;
    const [patientRes, rxRes, fulfillmentRes, followupRes] = await Promise.all([
      this.supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      this.supabase
        .schema("resupply")
        .from("prescriptions")
        .select("item_sku, cadence_days")
        .eq("patient_id", patientId)
        .eq("status", "active"),
      this.supabase
        .schema("resupply")
        .from("fulfillments")
        .select("created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase
        .schema("resupply")
        .from("patient_followups")
        .select("id")
        .eq("patient_id", patientId)
        .is("completed_at", null)
        .limit(1),
    ]);
    if (patientRes.error) throw patientRes.error;
    if (rxRes.error) throw rxRes.error;
    if (fulfillmentRes.error) throw fulfillmentRes.error;
    if (followupRes.error) throw followupRes.error;

    const suppliesDue = (rxRes.data ?? [])
      .filter((r) => r.item_sku)
      .map((r) => ({
        sku: r.item_sku,
        // Same as lookup_resupply_inventory: we don't carry SKU
        // descriptions in our schema, so the SKU doubles as the
        // description for now.
        description: r.item_sku,
        quantity: 1,
        due_reason: `every ${r.cadence_days} days`,
      }));

    return {
      callId: call.callId,
      name: call.name,
      result: {
        kind: "patient",
        first_name: patientRes.data?.legal_first_name ?? undefined,
        supplies_due: suppliesDue,
        recent_order_summary: {
          last_order_at: fulfillmentRes.data?.created_at ?? null,
          // Patients aren't Stripe subscribers; their recurring resupply
          // is represented by supplies_due, not an "open subscription".
          open_subscription: false,
        },
        has_open_followups: (followupRes.data ?? []).length > 0,
      },
    };
  }

  private async getShippingAddress(
    call: DispatchToolCall<"get_shipping_address">,
  ): Promise<DispatchToolResult<"get_shipping_address">> {
    const { data: row, error } = await this.supabase
      .schema("resupply")
      .from("patients")
      .select("address")
      .eq("id", this.deps.patientId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    const addr = (row?.address ?? null) as {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    } | null;
    if (!addr) {
      return {
        callId: call.callId,
        name: call.name,
        result: { street_name: "", city: "", state: "" },
      };
    }
    // Strip leading street number so the model can SAY the street
    // name without leaking the full address back to a caller who
    // somehow got past identity but wasn't really the patient. Defense
    // in depth — verify_patient_identity should have already gated
    // this, but the prompt also tells the model to never read the
    // full street back.
    const streetName = addr.line1.replace(/^\s*\d+\s+/, "").trim();
    return {
      callId: call.callId,
      name: call.name,
      result: {
        street_name: streetName,
        city: addr.city,
        state: addr.state,
      },
    };
  }

  private async updateShippingAddress(
    call: DispatchToolCall<"update_shipping_address">,
  ): Promise<DispatchToolResult<"update_shipping_address">> {
    const a = call.args;
    const newAddress = {
      line1: a.street,
      city: a.city,
      state: a.state,
      postalCode: a.postal_code,
      country: "US",
    };
    const { error } = await this.supabase
      .schema("resupply")
      .from("patients")
      .update({ address: newAddress as unknown as Json })
      .eq("id", this.deps.patientId);
    if (error) throw error;

    return {
      callId: call.callId,
      name: call.name,
      result: {
        ok: true,
        // Read-back summary deliberately omits the full street and ZIP
        // — those are the riskiest pieces of address PHI to read aloud.
        summary: `${a.city}, ${a.state}`,
      },
    };
  }

  private async placeResupplyOrder(
    call: DispatchToolCall<"place_resupply_order">,
  ): Promise<DispatchToolResult<"place_resupply_order">> {
    const args = call.args;
    if (!args.address_confirmed) {
      return {
        callId: call.callId,
        name: call.name,
        result: { ok: false, order_id: "", accepted_skus: [] },
      };
    }
    // Validate the model's requested SKUs against the patient's active
    // prescriptions. The model can mis-hear or invent a SKU; without
    // this filter the agent would read back ineligible items as
    // "ordered". Fulfillment is driven downstream from the
    // prescriptions (not this echo), so we still confirm the episode —
    // we just never claim an ineligible SKU was accepted.
    const { data: rxRows, error: rxErr } = await this.supabase
      .schema("resupply")
      .from("prescriptions")
      .select("item_sku")
      .eq("patient_id", this.deps.patientId)
      .eq("status", "active");
    if (rxErr) throw rxErr;
    const normalizeSku = (sku: string): string => sku.trim().toUpperCase();
    const eligibleSkus = new Set(
      (rxRows ?? [])
        .map((r) => r.item_sku)
        .filter((s): s is string => Boolean(s))
        .map(normalizeSku),
    );
    const acceptedSkus = Array.from(
      new Set(args.skus.map(normalizeSku).filter((s) => eligibleSkus.has(s))),
    );

    // Mark the episode as `confirmed`. Actual order placement against
    // Pacware is a downstream worker job; the admin dashboard will
    // pick this episode up in the "ready to fulfil" queue. The .eq on
    // status gates the transition so a second tool call (or a call
    // that races a prior cancellation) can't resurrect an already-
    // terminal episode.
    const orderId = randomUUID();
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await this.supabase
      .schema("resupply")
      .from("episodes")
      .update({ status: "confirmed", updated_at: nowIso })
      .eq("id", this.deps.episodeId)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      return {
        callId: call.callId,
        name: call.name,
        result: { ok: false, order_id: "", accepted_skus: [] },
      };
    }

    return {
      callId: call.callId,
      name: call.name,
      result: {
        ok: true,
        order_id: orderId,
        accepted_skus: acceptedSkus,
      },
    };
  }

  private async requestHumanHandoff(
    call: DispatchToolCall<"request_human_handoff">,
  ): Promise<DispatchToolResult<"request_human_handoff">> {
    const handoffId = randomUUID();
    // Move the conversation into the admin queue so the dashboard
    // surfaces it immediately. We do NOT close the conversation here
    // — the human admin will close it once they've handled the
    // escalation.
    const nowIso = new Date().toISOString();
    const { error } = await this.supabase
      .schema("resupply")
      .from("conversations")
      .update({ status: "awaiting_admin", updated_at: nowIso })
      .eq("id", this.deps.conversationId);
    if (error) throw error;

    return {
      callId: call.callId,
      name: call.name,
      result: { ok: true, handoff_id: handoffId },
    };
  }

  private async endCall(
    call: DispatchToolCall<"end_call">,
  ): Promise<DispatchToolResult<"end_call">> {
    // We don't close the conversation row here — the WS handler does
    // that on session.closed so there's exactly one "this call ended"
    // chokepoint that runs regardless of HOW it ended (model hung up,
    // Twilio stop, or network drop). Returning `ok: true` lets the
    // model reply with its closing line; the bridge's
    // `session.closed` handler will then finalise the row.
    return {
      callId: call.callId,
      name: call.name,
      result: { ok: true },
    };
  }
}

/**
 * Constant-time string equality. Returns false fast for unequal
 * lengths (which itself leaks length, which is fine — the DOB shape
 * is fixed at YYYY-MM-DD so length never varies in legitimate input).
 */
function constantTimeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

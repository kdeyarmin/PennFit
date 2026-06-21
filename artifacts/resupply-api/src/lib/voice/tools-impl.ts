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

import { timingSafeEqual, randomUUID, randomBytes } from "node:crypto";

import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type Json,
  type OrgScopedClient,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

import {
  BREATHE_SALES_TOOL_NAMES,
  PATIENT_TOOL_NAMES,
  SHOP_TOOL_NAMES,
} from "@workspace/resupply-ai";
import type {
  DispatchToolCall,
  DispatchToolResult,
  StartBreatheSignupResult,
  ToolArgsByName,
  ToolDispatcher,
  ToolName,
} from "@workspace/resupply-ai";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../logger";
import { resolveSuperAdminRecipients } from "../admin-assistant/adminAssistantTools";
import { placeResupplyOrderForConversation } from "../messaging/order-flow";
import { describeHcpcsPlain } from "../swo-pdf";
import {
  createSelfServeTenant,
  slugifyOrgName,
  type SelfServeSignupResult,
} from "../tenant-signup-service";

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
    case "verify_shop_customer_identity":
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
    // The CareMetric Breathe sales tools are only ever dispatched on the
    // "breathe_prospect" path (which never runs the identity gate). These
    // branches exist purely so this helper stays total over ToolName and
    // returns a benign "not available" shape if one ever reaches a
    // patient/shop dispatcher.
    case "identify_call_reason":
      return {
        ok: true,
        reason: "other",
      } as unknown as DispatchToolResult<K>["result"];
    case "send_info_email":
      return {
        ok: false,
        sent: false,
      } as unknown as DispatchToolResult<K>["result"];
    case "capture_sales_lead":
      return { ok: false } as unknown as DispatchToolResult<K>["result"];
    case "start_breathe_signup":
      return {
        ok: false,
        status: "unavailable",
      } as unknown as DispatchToolResult<K>["result"];
  }
  // Exhaustiveness — TypeScript should already have narrowed away.
  throw new Error(`Unknown tool: ${String(name)}`);
}

const IDENTITY_EXEMPT: ReadonlySet<ToolName> = new Set([
  "verify_patient_identity",
  "verify_shop_customer_identity",
  "request_human_handoff",
  "end_call",
]);

// Per-caller-kind dispatch allowlists (defense in depth — the WS handler
// already offers the model only the right subset). Anything outside the
// caller's set gets the same identity_required stub as an unverified call.
const PATIENT_DISPATCH_TOOLS: ReadonlySet<ToolName> = new Set(
  PATIENT_TOOL_NAMES,
);
const SHOP_DISPATCH_TOOLS: ReadonlySet<ToolName> = new Set(SHOP_TOOL_NAMES);
const BREATHE_SALES_DISPATCH_TOOLS: ReadonlySet<ToolName> = new Set(
  BREATHE_SALES_TOOL_NAMES,
);

// How many platform-info emails one sales call may send. Bounds a single
// malicious caller using the agent as an email relay — combined with
// templated (never model-authored) bodies and a single confirmed recipient,
// the relay surface is closed.
const MAX_INFO_EMAILS_PER_CALL = 3;

/** A composed platform email (sales-line tools). */
export interface PlatformEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends a platform email; resolves to whether it went out (never throws on
 *  an unconfigured/failed send — returns ok:false so the model degrades). */
export type SendPlatformEmail = (
  msg: PlatformEmailMessage,
) => Promise<{ ok: boolean; reason?: string }>;

export interface VoiceToolDispatcherDeps {
  /** Optional Supabase client. Tests inject a stub; production callers
   *  pass nothing and the dispatcher resolves the singleton at construct. */
  supabase?: ResupplySupabaseClient;
  /** "patient" (default) runs the full resupply flow and verifies by date
   *  of birth; "shop_customer" verifies by the last four of the card on
   *  file and is limited to reading their account or reaching a human;
   *  "breathe_prospect" is the CareMetric Breathe B2B platform sales agent
   *  (no patient identity, no conversations row — its own tool set). */
  callerKind?: "patient" | "shop_customer" | "breathe_prospect";
  /** Set for patient callers — the bound clinical patient. */
  patientId?: string;
  conversationId: string;
  /** Set for patient callers — the actionable episode. */
  episodeId?: string;
  /** Set for shop_customer callers — the storefront customer id. */
  shopCustomerId?: string;
  /** The Twilio CallSid, when known — recorded on captured sales leads so a
   *  lead can be tied back to its call. Sales path only. */
  twilioCallSid?: string;
  /**
   * Seam for the shared order-placement flow (the SAME path the SMS and
   * email confirms ride: atomic episode claim + entitlement/coverage
   * guards + queued fulfillment rows). Tests inject a stub; production
   * callers leave it unset and get the real implementation.
   */
  placeOrderForConversation?: typeof placeResupplyOrderForConversation;
  /**
   * Seam for sending a platform email (sales-line tools). Tests inject a
   * stub; production callers leave it unset and get the SendGrid-backed
   * {@link defaultSendPlatformEmail} (platform default From, cmbreathe.com).
   */
  sendPlatformEmail?: SendPlatformEmail;
  /**
   * Seam for provisioning a CareMetric Breathe tenant (the no-spoken-password
   * sign-up). Tests inject a stub; production callers leave it unset and get
   * the real {@link createSelfServeTenant}.
   */
  createTenant?: typeof createSelfServeTenant;
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
  /** Platform-info emails sent so far this call (sales line cap). */
  private infoEmailsSent = 0;
  /** Injected raw client (test seam); undefined in production. */
  private readonly injectedClient?: ResupplySupabaseClient;
  /** Memoized org-scoped facade, resolved on first DB use. */
  private scoped: OrgScopedClient | null = null;

  constructor(private readonly deps: VoiceToolDispatcherDeps) {
    this.injectedClient = deps.supabase;
  }

  /**
   * Resolve (once) the tenant-scoped client. The constructor is sync and
   * `resolveSeedOrgId()` is async, so we resolve the seed org lazily at
   * first DB use (file-local worker pattern — single-tenant equivalent).
   * A test-injected client is wrapped with the same org-scoped facade so
   * the query bodies are identical on both paths.
   */
  private async db(): Promise<OrgScopedClient> {
    if (this.scoped) return this.scoped;
    const orgId = await resolveSeedOrgId();
    if (!orgId) throw new Error("tenant context missing");
    this.scoped = this.injectedClient
      ? getOrgScopedClient(orgId, this.injectedClient)
      : getOrgScopedClient(orgId);
    return this.scoped;
  }

  isIdentityVerified(): boolean {
    return this.verified;
  }

  /** The bound patient id, asserted present. Only the patient-flow tools
   *  call this, and the per-kind dispatch gate guarantees they only run
   *  for a patient caller — so a missing id is a programming error. */
  private requirePatientId(): string {
    const id = this.deps.patientId;
    if (!id) throw new Error("patientId is required for patient-flow tools");
    return id;
  }

  private requireShopCustomerId(): string {
    const id = this.deps.shopCustomerId;
    if (!id) throw new Error("shopCustomerId is required for shop-flow tools");
    return id;
  }

  async dispatch<K extends ToolName>(
    call: DispatchToolCall<K>,
  ): Promise<DispatchToolResult<K>> {
    // CareMetric Breathe B2B platform sales caller: a wholly separate tool
    // set with no patient identity, no PHI, and no `conversations` row.
    // Routed entirely through its own dispatcher so the patient/shop identity
    // gate, lockout, and chart machinery never run for a prospect.
    if ((this.deps.callerKind ?? "patient") === "breathe_prospect") {
      return this.dispatchBreatheSales(call);
    }
    // Per-caller-kind scoping (defense in depth): a shop_customer caller
    // can only verify-by-card, read their chart, hand off, or hang up; a
    // patient caller cannot use the shop verify tool. Anything outside the
    // caller's set returns the same stub an unverified side-effect call
    // would, nudging the model back to the tools it's allowed.
    const callerKind = this.deps.callerKind ?? "patient";
    const allowedForKind =
      callerKind === "shop_customer"
        ? SHOP_DISPATCH_TOOLS
        : PATIENT_DISPATCH_TOOLS;
    if (!allowedForKind.has(call.name)) {
      return {
        callId: call.callId,
        name: call.name,
        result: identityRequiredResultFor(call.name),
      };
    }
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
      case "verify_shop_customer_identity":
        return (await this.verifyShopCustomerIdentity(
          call as DispatchToolCall<"verify_shop_customer_identity">,
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
    const supabase = await this.db();
    const { data: row, error } = await supabase
      .from("patients")
      .select("date_of_birth, legal_first_name")
      .eq("id", this.requirePatientId())
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

  private async verifyShopCustomerIdentity(
    call: DispatchToolCall<"verify_shop_customer_identity">,
  ): Promise<DispatchToolResult<"verify_shop_customer_identity">> {
    // Storefront callers have no DOB on file; we verify against the last
    // four of the card on file — a low-sensitivity factor gating only the
    // deliberately low-sensitivity shop chart. Read it FIRST so a customer
    // with no saved card doesn't burn an attempt (the prompt then hands
    // off). Compared in Node with timingSafeEqual.
    const supabase = await this.db();
    const { data: row, error } = await supabase
      .from("shop_customers")
      .select("default_payment_method_last4, display_name")
      .eq("customer_id", this.requireShopCustomerId())
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    const last4OnFile = row?.default_payment_method_last4 ?? null;
    if (!last4OnFile) {
      // No card on file → verification can NEVER succeed. Signal a terminal
      // state (attempts_remaining: 0) so the model stops asking for digits
      // and hands off, per the prompt's "no card on file" rule. We don't
      // increment the counter — there was nothing to compare.
      return {
        callId: call.callId,
        name: call.name,
        result: { matched: false, attempts_remaining: 0 },
      };
    }

    this.verifyAttempts += 1;
    const attemptsRemaining = Math.max(
      0,
      MAX_VERIFY_ATTEMPTS - this.verifyAttempts,
    );

    const matched = constantTimeStringEquals(call.args.last_four, last4OnFile);
    if (matched) {
      this.verified = true;
      return {
        callId: call.callId,
        name: call.name,
        result: {
          matched: true,
          first_name: firstNameFromDisplayName(row?.display_name ?? null),
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
    const supabase = await this.db();
    const { data: rows, error } = await supabase
      .from("prescriptions")
      .select("item_sku, cadence_days, hcpcs_code")
      .eq("patient_id", this.requirePatientId())
      .eq("status", "active");
    if (error) throw error;

    const items = (rows ?? [])
      .filter((r: Record<string, unknown>) => r.item_sku)
      .map((r: Record<string, unknown>) => ({
        sku: r.item_sku,
        // The Pacware product catalogue (which holds the marketing name
        // for each SKU) lives outside this DB, but the prescription
        // carries the authorising HCPCS code — enough to read a real
        // product name back to the patient instead of a bare SKU
        // number. Fall back to the SKU when the code isn't one we
        // recognise.
        description:
          describeHcpcsPlain(r.hcpcs_code as string | null) ?? r.item_sku,
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
    // bound patient/customer id). The agent prompt also forbids reading
    // full PHI aloud — this is defense in depth.
    if ((this.deps.callerKind ?? "patient") === "shop_customer") {
      return this.getShopCustomerChart(call);
    }
    const patientId = this.requirePatientId();
    const supabase = await this.db();
    const [patientRes, rxRes, fulfillmentRes, followupRes] = await Promise.all([
      supabase
        .from("patients")
        .select("legal_first_name")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("prescriptions")
        .select("item_sku, cadence_days, hcpcs_code")
        .eq("patient_id", patientId)
        .eq("status", "active"),
      supabase
        .from("fulfillments")
        .select("created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
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
      .filter((r: Record<string, unknown>) => r.item_sku)
      .map((r: Record<string, unknown>) => ({
        sku: r.item_sku,
        // Same as lookup_resupply_inventory: derive a plain-English
        // product name from the authorising HCPCS code, falling back
        // to the raw SKU when the code isn't one we recognise.
        description:
          describeHcpcsPlain(r.hcpcs_code as string | null) ?? r.item_sku,
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

  private async getShopCustomerChart(
    call: DispatchToolCall<"get_customer_chart">,
  ): Promise<DispatchToolResult<"get_customer_chart">> {
    // Storefront snapshot: first name + last order date + active-
    // subscription flag + open-followup flag. No supplies_due (cash-pay
    // customers have no clinical prescriptions). Dates + booleans only —
    // never order contents, addresses, payment details, or email.
    const customerId = this.requireShopCustomerId();
    const supabase = await this.db();
    const [customerRes, orderRes, subRes, followupRes] = await Promise.all([
      supabase
        .from("shop_customers")
        .select("display_name")
        .eq("customer_id", customerId)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("shop_orders")
        .select("paid_at, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("shop_subscriptions")
        .select("status")
        .eq("customer_id", customerId)
        .in("status", ["active", "trialing"])
        .limit(1),
      supabase
        .from("shop_customer_followups")
        .select("id")
        .eq("customer_id", customerId)
        .is("completed_at", null)
        .limit(1),
    ]);
    if (customerRes.error) throw customerRes.error;
    if (orderRes.error) throw orderRes.error;
    if (subRes.error) throw subRes.error;
    if (followupRes.error) throw followupRes.error;

    const lastOrderAt =
      orderRes.data?.paid_at ?? orderRes.data?.created_at ?? null;

    return {
      callId: call.callId,
      name: call.name,
      result: {
        kind: "shop_customer",
        first_name: firstNameFromDisplayName(
          customerRes.data?.display_name ?? null,
        ),
        supplies_due: [],
        recent_order_summary: {
          last_order_at: lastOrderAt,
          open_subscription: (subRes.data ?? []).length > 0,
        },
        has_open_followups: (followupRes.data ?? []).length > 0,
      },
    };
  }

  private async getShippingAddress(
    call: DispatchToolCall<"get_shipping_address">,
  ): Promise<DispatchToolResult<"get_shipping_address">> {
    const supabase = await this.db();
    const { data: row, error } = await supabase
      .from("patients")
      .select("address")
      .eq("id", this.requirePatientId())
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
    const supabase = await this.db();
    const { error } = await supabase
      .from("patients")
      .update({ address: newAddress as unknown as Json })
      .eq("id", this.requirePatientId());
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
    // "ordered". Fulfillment is driven by the episode's prescription
    // (not this echo) — we just never claim an ineligible SKU was
    // accepted.
    const supabase = await this.db();
    const { data: rxRows, error: rxErr } = await supabase
      .from("prescriptions")
      .select("item_sku")
      .eq("patient_id", this.requirePatientId())
      .eq("status", "active");
    if (rxErr) throw rxErr;
    const normalizeSku = (sku: string): string => sku.trim().toUpperCase();
    const eligibleSkus = new Set<string>(
      (rxRows ?? [])
        .map((r: Record<string, unknown>) => r.item_sku)
        .filter((s: unknown): s is string => Boolean(s))
        .map(normalizeSku),
    );
    const acceptedSkus = Array.from(
      new Set(args.skus.map(normalizeSku).filter((s) => eligibleSkus.has(s))),
    );

    // Place the order through the SAME shared path the SMS and email
    // confirms ride (order-flow.ts): it resolves the bound episode,
    // atomically claims it (any non-terminal status → `confirmed`), runs
    // the feature-flagged entitlement/coverage guards, and creates the
    // `queued` fulfillment rows the PacWare exporter actually ships
    // from. The previous voice-only implementation flipped
    // episodes.status behind a guard requiring the status to equal
    // "pending" — which is not an episode status (the lifecycle is
    // outreach_pending → awaiting_response → confirmed/declined/…), so
    // the guard matched zero rows and EVERY voice order failed; and it
    // created no fulfillment rows, so even a successful claim would
    // never have shipped.
    const placeOrder =
      this.deps.placeOrderForConversation ?? placeResupplyOrderForConversation;
    const placed = await placeOrder({
      conversationId: this.deps.conversationId,
      // The caller's spoken confirmation (the agent reads back the
      // refill attestation before calling this tool) is the recorded
      // Medicare/payer refill attestation. No IP/UA on a phone call.
      affirmation: {
        channel: "voice",
        continuedUse: true,
        supplyLow: true,
        requestedBy: "self",
        ip: null,
        userAgent: null,
      },
    });
    switch (placed.status) {
      case "ok":
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: true,
            order_id: placed.fulfillmentIds[0] ?? randomUUID(),
            accepted_skus: acceptedSkus,
          },
        };
      case "already_confirmed":
        // The order is already on the books (e.g. the patient confirmed
        // by SMS earlier today). Telling the caller their order "failed"
        // would be wrong and alarming — report success idempotently and
        // let the model reassure them it's in the queue.
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: true,
            order_id: "",
            accepted_skus: acceptedSkus,
            reason: "already_confirmed",
          },
        };
      case "not_eligible":
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: false,
            order_id: "",
            accepted_skus: [],
            reason:
              "Insurance will not cover this item again until " +
              `${placed.entitlement.eligibleOn.slice(0, 10)}. Offer to have ` +
              "a teammate follow up rather than placing the order now.",
          },
        };
      case "coverage_blocked":
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: false,
            order_id: "",
            accepted_skus: [],
            reason:
              "The insurance coverage on file needs review before this " +
              "order can ship. Offer to have a teammate follow up.",
          },
        };
      case "usage_review":
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: false,
            order_id: "",
            accepted_skus: [],
            reason:
              "A teammate needs to check in about the patient's therapy " +
              "before this order can ship. Warmly offer to have a " +
              "teammate follow up — do not mention usage data or " +
              "compliance.",
          },
        };
      case "too_early":
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: false,
            order_id: "",
            accepted_skus: [],
            reason:
              "It is a little early to reship this under the plan" +
              (placed.refillWindow.earliestShipOn
                ? ` (eligible to ship on ${placed.refillWindow.earliestShipOn})`
                : "") +
              ". Warmly offer to have a teammate follow up rather than " +
              "placing the order now.",
          },
        };
      default:
        // conversation_not_found / episode_not_found /
        // no_active_prescription — all "we can't place this by phone".
        return {
          callId: call.callId,
          name: call.name,
          result: {
            ok: false,
            order_id: "",
            accepted_skus: [],
            reason: placed.status,
          },
        };
    }
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
    const supabase = await this.db();
    const { error } = await supabase
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

  // ---- CareMetric Breathe B2B platform sales tools ----------------------
  //
  // These run for `callerKind === "breathe_prospect"` only. No patient
  // identity, no PHI, no `conversations` row. The dispatcher routes here
  // BEFORE the identity gate so none of the patient/shop machinery applies.

  private async dispatchBreatheSales<K extends ToolName>(
    call: DispatchToolCall<K>,
  ): Promise<DispatchToolResult<K>> {
    if (!BREATHE_SALES_DISPATCH_TOOLS.has(call.name)) {
      // A non-sales tool reached the sales line — return a benign shape so
      // the wire payload type-checks. The model is only ever offered the
      // sales tools, so this is defense in depth.
      return {
        callId: call.callId,
        name: call.name,
        result: identityRequiredResultFor(call.name),
      };
    }
    switch (call.name) {
      case "identify_call_reason":
        return (await this.identifyCallReason(
          call as DispatchToolCall<"identify_call_reason">,
        )) as DispatchToolResult<K>;
      case "send_info_email":
        return (await this.sendInfoEmail(
          call as DispatchToolCall<"send_info_email">,
        )) as DispatchToolResult<K>;
      case "capture_sales_lead":
        return (await this.captureSalesLead(
          call as DispatchToolCall<"capture_sales_lead">,
        )) as DispatchToolResult<K>;
      case "start_breathe_signup":
        return (await this.startBreatheSignup(
          call as DispatchToolCall<"start_breathe_signup">,
        )) as DispatchToolResult<K>;
      case "request_human_handoff":
        return (await this.salesHandoff(
          call as DispatchToolCall<"request_human_handoff">,
        )) as DispatchToolResult<K>;
      case "end_call":
        return (await this.endCall(
          call as DispatchToolCall<"end_call">,
        )) as DispatchToolResult<K>;
    }
    throw new Error(`Unknown sales tool: ${String(call.name)}`);
  }

  private async identifyCallReason(
    call: DispatchToolCall<"identify_call_reason">,
  ): Promise<DispatchToolResult<"identify_call_reason">> {
    // No side effect — committing to a skill is enough for the model to
    // route. The durable record of a service/support reason is the lead the
    // model captures next; the bridge audits this invocation either way.
    logger.info(
      { event: "voice_breathe_sales.call_reason", reason: call.args.reason },
      "voice sales: call reason identified",
    );
    return {
      callId: call.callId,
      name: call.name,
      result: { ok: true, reason: call.args.reason },
    };
  }

  private async sendInfoEmail(
    call: DispatchToolCall<"send_info_email">,
  ): Promise<DispatchToolResult<"send_info_email">> {
    if (this.infoEmailsSent >= MAX_INFO_EMAILS_PER_CALL) {
      return {
        callId: call.callId,
        name: call.name,
        result: { ok: false, sent: false, reason: "send_limit" },
      };
    }
    const { email, topic, notes } = call.args;
    const built = buildPlatformInfoEmail(topic, notes);
    const send = this.deps.sendPlatformEmail ?? defaultSendPlatformEmail;
    const outcome = await send({ to: email, ...built });
    if (outcome.ok) this.infoEmailsSent += 1;
    return {
      callId: call.callId,
      name: call.name,
      result: {
        ok: outcome.ok,
        sent: outcome.ok,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
    };
  }

  private async captureSalesLead(
    call: DispatchToolCall<"capture_sales_lead">,
  ): Promise<DispatchToolResult<"capture_sales_lead">> {
    const a = call.args;
    // Assigned in the try below; the catch always returns, so by the time we
    // read it past the try/catch it is definitely set.
    let leadId: string | null;
    try {
      const supabase = await this.db();
      const { data, error } = await supabase
        .raw()
        .schema("resupply")
        .from("sales_leads")
        .insert({
          contact_name: a.contact_name ?? null,
          company_name: a.company_name ?? null,
          phone_e164: a.phone ?? null,
          email: a.email ?? null,
          interest_tier: a.interest_tier ?? null,
          message: a.message,
          twilio_call_sid: this.deps.twilioCallSid ?? null,
          source: "voice_sales_agent",
          status: "new",
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      leadId = (data as { id?: string } | null)?.id ?? null;
    } catch (err) {
      logger.warn(
        { event: "voice_breathe_sales.lead_insert_failed", err: errShape(err) },
        "voice sales: sales lead insert failed",
      );
      return {
        callId: call.callId,
        name: call.name,
        result: { ok: false, reason: "persist_failed" },
      };
    }

    // Best-effort super-admin notification. The DB row is the durable
    // record — a failed/queued email must never lose the lead.
    void this.notifySalesLead(a, leadId);

    return {
      callId: call.callId,
      name: call.name,
      result: { ok: true, ...(leadId ? { lead_id: leadId } : {}) },
    };
  }

  /** Email the captured lead to the super-admin(s). Best-effort; always
   *  resolves (a notification failure is logged, not surfaced). */
  private async notifySalesLead(
    args: ToolArgsByName["capture_sales_lead"],
    leadId: string | null,
  ): Promise<void> {
    try {
      const supabase = await this.db();
      const recipients = await resolveSuperAdminRecipients(supabase);
      if (recipients.length === 0) {
        logger.warn(
          { event: "voice_breathe_sales.no_lead_recipients" },
          "voice sales: no super-admin recipient resolved for a sales lead",
        );
        return;
      }
      const built = buildSalesLeadNotificationEmail(args, leadId);
      const send = this.deps.sendPlatformEmail ?? defaultSendPlatformEmail;
      for (const to of recipients) {
        await send({ to, ...built });
      }
    } catch (err) {
      logger.warn(
        { event: "voice_breathe_sales.lead_notify_failed", err: errShape(err) },
        "voice sales: sales lead notification failed",
      );
    }
  }

  private async startBreatheSignup(
    call: DispatchToolCall<"start_breathe_signup">,
  ): Promise<DispatchToolResult<"start_breathe_signup">> {
    const { org_name, admin_email } = call.args;
    // NO spoken password: generate a strong throwaway the caller never learns
    // and which is never logged. They set their own via the emailed verify /
    // set-password link — the only secure path on a recorded call.
    const throwawayPassword = randomBytes(24).toString("base64url");
    const create = this.deps.createTenant ?? createSelfServeTenant;
    let result: SelfServeSignupResult;
    try {
      result = await create({
        orgName: org_name,
        slug: slugifyOrgName(org_name),
        adminEmail: admin_email,
        password: throwawayPassword,
        baseUrl: platformBaseUrl(),
        // The caller never speaks a password — email them a set-password
        // link (which also verifies the email) instead of a verify-only link.
        sendSetPasswordLink: true,
      });
    } catch (err) {
      logger.warn(
        { event: "voice_breathe_sales.signup_failed", err: errShape(err) },
        "voice sales: tenant signup threw",
      );
      return {
        callId: call.callId,
        name: call.name,
        result: { ok: false, status: "unavailable" },
      };
    }

    if (result.ok) {
      // Record a converted lead (best-effort; never block the signup result).
      void this.recordSignupLead(org_name, admin_email);
    } else {
      logger.info(
        { event: "voice_breathe_sales.signup_rejected", reason: result.reason },
        "voice sales: tenant signup rejected",
      );
    }
    return {
      callId: call.callId,
      name: call.name,
      result: { ok: result.ok, status: mapSignupResultToStatus(result) },
    };
  }

  /** Stamp a `signed_up` lead row after a successful sign-up. Best-effort. */
  private async recordSignupLead(
    orgName: string,
    adminEmail: string,
  ): Promise<void> {
    try {
      const supabase = await this.db();
      const { error } = await supabase
        .raw()
        .schema("resupply")
        .from("sales_leads")
        .insert({
          company_name: orgName,
          email: adminEmail,
          message: "Started a CareMetric Breathe sign-up on a sales call.",
          twilio_call_sid: this.deps.twilioCallSid ?? null,
          source: "voice_sales_agent",
          status: "signed_up",
        });
      if (error) throw error;
    } catch (err) {
      logger.warn(
        { event: "voice_breathe_sales.signup_lead_failed", err: errShape(err) },
        "voice sales: signup lead row failed",
      );
    }
  }

  private async salesHandoff(
    call: DispatchToolCall<"request_human_handoff">,
  ): Promise<DispatchToolResult<"request_human_handoff">> {
    // The sales line has no `conversations` row to escalate (a prospect is
    // neither a patient nor a customer). The durable artifact is the lead the
    // model captures; this just acknowledges so the model can wrap up.
    return {
      callId: call.callId,
      name: call.name,
      result: { ok: true, handoff_id: randomUUID() },
    };
  }
}

/** Best-effort first name from a free-form display name ("Jane Doe" ->
 *  "Jane"). The storefront has no structured name; we only ever voice the
 *  first token, and return undefined when there's nothing usable. */
function firstNameFromDisplayName(
  displayName: string | null,
): string | undefined {
  if (!displayName) return undefined;
  const first = displayName.trim().split(/\s+/)[0];
  return first || undefined;
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

// ---- CareMetric Breathe sales-tool helpers --------------------------------

/** PII-safe error shape for logs — name only, never the message (which could
 *  echo a caller-supplied value). Mirrors the admin-assistant tool posture. */
function errShape(err: unknown): { name: string } {
  return { name: err instanceof Error ? err.name : "unknown" };
}

/** Escape HTML for the dynamic (caller/model-supplied) parts of an email. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sanitize a model/caller-supplied value for safe use in an email Subject
 *  header: replace CR/LF and other control characters (which would trip
 *  SendGrid's header-injection guard and silently drop the send) with spaces,
 *  squeeze runs of spaces, and cap the length. */
function sanitizeEmailSubjectValue(s: string): string {
  const stripped = Array.from(s)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("");
  return stripped.replace(/ +/g, " ").trim().slice(0, 120);
}

/** The platform host for sign-up / info links. Overridable for preview envs;
 *  defaults to the canonical platform domain. */
function platformBaseUrl(): string {
  const raw = (process.env.BREATHE_PLATFORM_BASE_URL ?? "").trim();
  if (raw && /^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return "https://cmbreathe.com";
}

/** Production platform-email sender: the shared SendGrid client with the
 *  platform default From (noreply@cmbreathe.com). Never throws — an
 *  unconfigured/failed send returns ok:false so the model degrades. */
async function defaultSendPlatformEmail(
  msg: PlatformEmailMessage,
): Promise<{ ok: boolean; reason?: string }> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { ok: false, reason: "email_unconfigured" };
    }
    throw err;
  }
  try {
    await client.sendEmail({
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { ok: true };
  } catch (err) {
    const retryable = err instanceof EmailApiError ? err.retryable : null;
    logger.warn(
      {
        event: "voice_breathe_sales.email_send_failed",
        retryable,
        err: errShape(err),
      },
      "voice sales: platform email send failed",
    );
    return { ok: false, reason: "send_failed" };
  }
}

/**
 * Compose a TEMPLATED platform-info email keyed by topic. The model never
 * authors the body — it only picks the topic and supplies an optional short
 * note (escaped, in a clearly delimited section) — which closes the
 * open-relay/spam surface.
 */
function buildPlatformInfoEmail(
  topic: ToolArgsByName["send_info_email"]["topic"],
  notes: string | undefined,
): { subject: string; text: string; html: string } {
  const overview = [
    "CareMetric Breathe is an all-in-one platform that DME and sleep businesses use to run their CPAP resupply program — a branded patient storefront with an AI mask-fitter, automated SMS/email/voice resupply reminders and auto-ship, insurance eligibility and billing tools, therapy-compliance monitoring, built-in AI assistants, multi-location support, and analytics. It's the engine that helps providers bring more patients back on schedule and grow resupply revenue without adding staff.",
  ];
  const pricing = [
    "CareMetric Breathe pricing — these are Founder DME Launch prices, a limited-time launch discount (regular Launch is $799/mo, Growth $1,899/mo), and a DME that signs up during the launch has the rate locked for a full 12 months. Every plan is a monthly platform fee plus a small per-active-patient monthly fee plus a one-time setup, and all plans include the full platform:",
    "• Launch — $499/mo + $1.25 per active patient/mo, $2,500 setup (best under ~1,000 patients).",
    "• Growth — $1,500/mo + $0.95 per active patient/mo, $5,000 setup (~1,000–10,000 patients).",
    "• Scale — $3,999/mo + $0.65 per active patient/mo, $10,000 setup (10,000+ / multi-location).",
    "• Enterprise — custom pricing, dedicated database and integrations.",
    "Optional add-ons include the AI voice agent and advanced billing automation.",
  ];
  const signup = [
    "Ready to get started with CareMetric Breathe?",
    `Create your account here: ${platformBaseUrl()}`,
    "You'll confirm your email and set a password, and our team will help you get set up.",
  ];

  let subject: string;
  let bodyLines: string[];
  switch (topic) {
    case "pricing":
      subject = "CareMetric Breathe — pricing";
      bodyLines = pricing;
      break;
    case "signup_link":
      subject = "CareMetric Breathe — create your account";
      bodyLines = signup;
      break;
    case "custom":
      subject = "Following up from CareMetric Breathe";
      bodyLines = [
        "Thanks for taking the time to talk with us about CareMetric Breathe.",
        ...overview,
      ];
      break;
    case "overview":
    default:
      subject = "About CareMetric Breathe";
      bodyLines = overview;
      break;
  }

  const noteText = notes && notes.trim().length > 0 ? notes.trim() : null;
  const text = [
    ...bodyLines,
    ...(noteText ? ["", "Note from your call:", noteText] : []),
    "",
    "Reply to this email or call us back any time and we'll be glad to help.",
    "— The CareMetric Breathe team",
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5">`,
    ...bodyLines.map(
      (line) => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`,
    ),
    ...(noteText
      ? [
          `<p style="margin:14px 0 4px;color:#64748b">Note from your call</p>`,
          `<p style="white-space:pre-wrap;margin:0 0 10px">${escapeHtml(noteText)}</p>`,
        ]
      : []),
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0"/>`,
    `<p style="margin:0">Reply to this email or call us back any time and we'll be glad to help.</p>`,
    `<p style="color:#94a3b8;font-size:12px;margin:8px 0 0">— The CareMetric Breathe team</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/** Compose the super-admin notification for a captured sales lead. Subject
 *  carries no sensitive content beyond the business name. */
function buildSalesLeadNotificationEmail(
  args: ToolArgsByName["capture_sales_lead"],
  leadId: string | null,
): { subject: string; text: string; html: string } {
  const company =
    sanitizeEmailSubjectValue(args.company_name ?? "") || "a prospect";
  const subject = `New CareMetric Breathe sales lead: ${company}`;
  const rows: Array<[string, string]> = [
    ["Contact", args.contact_name ?? "(not given)"],
    ["Company", args.company_name ?? "(not given)"],
    ["Phone", args.phone ?? "(not given)"],
    ["Email", args.email ?? "(not given)"],
    ["Interest", args.interest_tier ?? "(unspecified)"],
    ["Lead id", leadId ?? "(not recorded)"],
  ];

  const text = [
    "A new sales lead was captured by the CareMetric Breathe phone agent.",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Message:",
    args.message,
    "",
    "— Captured by the CareMetric Breathe sales line.",
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5">`,
    `<p>A new sales lead was captured by the CareMetric Breathe phone agent.</p>`,
    `<table style="border-collapse:collapse;margin:12px 0">`,
    ...rows.map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#64748b">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
    ),
    `</table>`,
    `<p style="margin:12px 0 4px;color:#64748b">Message</p>`,
    `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(args.message)}</p>`,
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0"/>`,
    `<p style="color:#94a3b8;font-size:12px;margin:0">Captured by the CareMetric Breathe sales line.</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

/** Map the self-serve signup result to the sales tool's status enum. */
function mapSignupResultToStatus(
  result: SelfServeSignupResult,
): StartBreatheSignupResult["status"] {
  if (result.ok) return "verification_email_sent";
  switch (result.reason) {
    case "email_taken":
      return "email_taken";
    case "slug_taken":
      return "name_taken";
    case "invalid_email":
      return "invalid_email";
    case "weak_password":
    case "unavailable":
    default:
      return "unavailable";
  }
}

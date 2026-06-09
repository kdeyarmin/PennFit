// @workspace/resupply-ai — tool (function-call) definitions for the voice agent.
//
// What lives here vs. what lives in the API:
//   - HERE: tool NAMES, ARG SCHEMAS (zod), RESULT SCHEMAS (zod), and the
//     OpenAI tool descriptors derived from those schemas. Plus the
//     `ToolDispatcher` interface — the contract the API implements.
//   - IN THE API: the IMPLEMENTATION of each tool. Tools touch the
//     database, the audit log, and the encryption helpers — none of
//     which the resupply-ai package is allowed to import (Rule 9 in
//     `scripts/check-resupply-architecture.sh`).
//
// Why split this way:
//   The model only ever sees tool NAMES and JSON schemas. Keeping those
//   here lets the bridge run with a fake dispatcher in tests without
//   pulling in pg / pgcrypto / Twilio. It also keeps the source of
//   truth for what the model can request in one tiny file the prompt
//   can quote from.
//
// Schema rules:
//   - All arg objects use `.strict()` so the model can't smuggle extra
//     fields past us (those would be silently dropped, which would mask
//     real bugs).
//   - Every shape has a discriminator-friendly outer object so error
//     codes are stable across tool implementations.

import { z } from "zod";

// ---- Tool name registry ---------------------------------------------------

export const TOOL_NAMES = [
  "verify_patient_identity",
  "verify_shop_customer_identity",
  "lookup_resupply_inventory",
  "get_customer_chart",
  "get_shipping_address",
  "update_shipping_address",
  "place_resupply_order",
  "request_human_handoff",
  "end_call",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// Per-caller-kind tool availability. The voice WS handler offers the model
// only the subset for the resolved caller kind, and the dispatcher enforces
// the same split server-side (defense in depth). A clinical patient verifies
// by date of birth and can run the full resupply flow; a cash-pay storefront
// caller verifies by the last four of the card on file and can only review
// their account (read-only) or reach a human.
export const PATIENT_TOOL_NAMES = [
  "verify_patient_identity",
  "lookup_resupply_inventory",
  "get_customer_chart",
  "get_shipping_address",
  "update_shipping_address",
  "place_resupply_order",
  "request_human_handoff",
  "end_call",
] as const satisfies readonly ToolName[];

export const SHOP_TOOL_NAMES = [
  "verify_shop_customer_identity",
  "get_customer_chart",
  "request_human_handoff",
  "end_call",
] as const satisfies readonly ToolName[];

// ---- Arg schemas ----------------------------------------------------------

// Why YYYY-MM-DD specifically: the patients table stores DOB as
// `YYYY-MM-DD` (see lib/resupply-db/src/schema/patients.ts). Anchoring
// the model on the same shape avoids a lossy "Jan 5 1972" -> ISO
// translation that the implementation would otherwise have to attempt.
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Expected an ISO date in YYYY-MM-DD form.",
});

export const verifyPatientIdentityArgs = z
  .object({
    date_of_birth: isoDateString,
  })
  .strict();

export const verifyShopCustomerIdentityArgs = z
  .object({
    last_four: z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Expected the last four digits of the card on file."),
  })
  .strict();

export const lookupResupplyInventoryArgs = z.object({}).strict();

export const getCustomerChartArgs = z.object({}).strict();

export const getShippingAddressArgs = z.object({}).strict();

// US-only address shape for v1. International support is a separate
// project (postal-code regex would change, address normalisation rules
// would change, and the carrier integration only ships domestic right
// now).
export const updateShippingAddressArgs = z
  .object({
    street: z.string().trim().min(1),
    city: z.string().trim().min(1),
    state: z
      .string()
      .trim()
      .length(2, "Use the two-letter US state code (e.g. PA)."),
    postal_code: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "Use a US ZIP, optionally ZIP+4."),
  })
  .strict();

export const placeResupplyOrderArgs = z
  .object({
    skus: z
      .array(z.string().trim().min(1))
      .min(1, "place_resupply_order requires at least one SKU."),
    address_confirmed: z.literal(true),
  })
  .strict();

export const requestHumanHandoffArgs = z
  .object({
    reason: z.enum([
      "identity_verification_failed",
      "patient_distress",
      "billing_or_insurance_question",
      "medical_question",
      "complex_change_request",
      "repeated_misunderstanding",
      "other",
    ]),
    notes: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const endCallArgs = z
  .object({
    outcome: z.enum([
      "order_placed",
      "completed",
      "patient_declined",
      "no_answer",
      "voicemail",
      "wrong_number",
      "handoff",
      "identity_verification_failed",
    ]),
  })
  .strict();

// Map for runtime dispatch. Keep this exhaustive — the dispatcher
// switch below uses it as the source of truth for "is this a known
// tool".
export const TOOL_ARG_SCHEMAS = {
  verify_patient_identity: verifyPatientIdentityArgs,
  verify_shop_customer_identity: verifyShopCustomerIdentityArgs,
  lookup_resupply_inventory: lookupResupplyInventoryArgs,
  get_customer_chart: getCustomerChartArgs,
  get_shipping_address: getShippingAddressArgs,
  update_shipping_address: updateShippingAddressArgs,
  place_resupply_order: placeResupplyOrderArgs,
  request_human_handoff: requestHumanHandoffArgs,
  end_call: endCallArgs,
} as const satisfies Record<ToolName, z.ZodTypeAny>;

// ---- Result types ---------------------------------------------------------
//
// Returned by the dispatcher and serialised back to the model as the
// tool result. Every result is a plain JSON-serialisable object — the
// Realtime API expects function results as a JSON STRING, the bridge
// stringifies for us.
//
// We DO NOT echo PHI in the verbose `address` field of the verify
// result; the model only needs "matched" + "first_name" (which the
// caller has just told us). Anything richer is fetched via a
// follow-up tool call.

export interface VerifyPatientIdentityResult {
  matched: boolean;
  first_name?: string;
  /** Number of attempts remaining before the agent should hand off. */
  attempts_remaining: number;
}

export interface VerifyShopCustomerIdentityResult {
  matched: boolean;
  first_name?: string;
  /** Number of attempts remaining before the agent should hand off. */
  attempts_remaining: number;
}

export interface InventoryItem {
  sku: string;
  description: string;
  quantity: number;
  due_reason: string;
}

export interface LookupResupplyInventoryResult {
  items: InventoryItem[];
}

export interface CustomerChartResult {
  kind: "patient" | "shop_customer";
  /** First name — the caller already stated it during verify; safe to use. */
  first_name?: string;
  /** Supplies currently due. Empty for storefront (cash-pay) customers. */
  supplies_due: InventoryItem[];
  /** Order/subscription crumbs — dates + booleans only, never contents. */
  recent_order_summary?: {
    last_order_at: string | null;
    open_subscription: boolean;
  };
  /** Whether the account has open follow-ups — a flag, not the contents. */
  has_open_followups: boolean;
}

export interface ShippingAddressResult {
  /** Street name only — no number/apartment. Safe to read aloud. */
  street_name: string;
  city: string;
  state: string;
}

export interface UpdateShippingAddressResult {
  ok: boolean;
  /** Human-readable summary the model can read back, sans full street + zip. */
  summary: string;
}

export interface PlaceResupplyOrderResult {
  ok: boolean;
  order_id: string;
  /** SKUs that were actually accepted (subset of the requested set). */
  accepted_skus: string[];
}

export interface RequestHumanHandoffResult {
  ok: boolean;
  /** Admin-visible escalation id for the queue. */
  handoff_id: string;
}

export interface EndCallResult {
  ok: true;
}

export interface ToolResultByName {
  verify_patient_identity: VerifyPatientIdentityResult;
  verify_shop_customer_identity: VerifyShopCustomerIdentityResult;
  lookup_resupply_inventory: LookupResupplyInventoryResult;
  get_customer_chart: CustomerChartResult;
  get_shipping_address: ShippingAddressResult;
  update_shipping_address: UpdateShippingAddressResult;
  place_resupply_order: PlaceResupplyOrderResult;
  request_human_handoff: RequestHumanHandoffResult;
  end_call: EndCallResult;
}

// ---- OpenAI tool descriptors ---------------------------------------------
//
// The Realtime API accepts tools in its session.update payload. We hand-
// roll the JSON Schema here (one pass through `zod` -> JSON Schema would
// be needlessly heavy for seven tiny shapes, and the failure mode of
// going through a converter is the model getting subtly different
// schemas than the dispatcher accepts). Keep these in sync with the zod
// schemas above; the unit tests assert that EVERY descriptor parses
// each example input through its zod schema.

export interface OpenAiToolDescriptor {
  type: "function";
  name: ToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

export const OPENAI_TOOL_DESCRIPTORS: readonly OpenAiToolDescriptor[] = [
  {
    type: "function",
    name: "verify_patient_identity",
    description:
      "Verify the caller's identity by matching their stated date of birth against the patient record on file. MUST be called and succeed before any other tool.",
    parameters: {
      type: "object",
      properties: {
        date_of_birth: {
          type: "string",
          description:
            "Date of birth in YYYY-MM-DD form (e.g. 1972-01-05). Convert any spoken form to this shape before calling.",
        },
      },
      required: ["date_of_birth"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "verify_shop_customer_identity",
    description:
      "Verify a storefront (cash-pay) caller's identity by matching the last four digits of the card on file. MUST be called and succeed before any other tool for a storefront caller. If no card is on file, or it fails three times, hand off to a human.",
    parameters: {
      type: "object",
      properties: {
        last_four: {
          type: "string",
          description:
            "The last four digits of the caller's payment card (exactly four digits, e.g. 4242).",
        },
      },
      required: ["last_four"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "lookup_resupply_inventory",
    description:
      "Return the list of CPAP supplies currently due for resupply for the verified patient.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_customer_chart",
    description:
      "Return a SAFE-TO-READ snapshot of the verified caller's account: their first name, any supplies due, whether they have a recent order or an active subscription, and whether there are open follow-ups. Never read back full addresses, full order contents, date of birth, phone, or email. Requires identity verification first.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_shipping_address",
    description:
      "Return a SAFE-TO-READ summary of the patient's shipping address (street name, city, state). The full street number, apartment, and postal code are deliberately omitted — confirm those by asking the caller, never by reading them out.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_shipping_address",
    description:
      "Replace the patient's shipping address. Only call when the caller has explicitly asked to change the address. US addresses only.",
    parameters: {
      type: "object",
      properties: {
        street: {
          type: "string",
          description: "Street line including house number and apartment.",
        },
        city: { type: "string" },
        state: {
          type: "string",
          description: "Two-letter US state code (e.g. PA).",
        },
        postal_code: {
          type: "string",
          description:
            "US ZIP code, optionally ZIP+4 (e.g. 19103 or 19103-1234).",
        },
      },
      required: ["street", "city", "state", "postal_code"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "place_resupply_order",
    description:
      "Place a resupply order for the supplied SKUs. Requires the caller to have verbally confirmed the shipping address; pass address_confirmed=true to acknowledge.",
    parameters: {
      type: "object",
      properties: {
        skus: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "SKUs to order. Use SKUs from the lookup_resupply_inventory result.",
        },
        address_confirmed: {
          type: "boolean",
          enum: [true],
          description:
            "Must be true. Set only after the caller has verbally confirmed the shipping address.",
        },
      },
      required: ["skus", "address_confirmed"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_human_handoff",
    description:
      "Escalate the call to a human admin. Use for distress, billing/insurance questions, medical questions, repeated misunderstanding, or identity-verification failure.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "identity_verification_failed",
            "patient_distress",
            "billing_or_insurance_question",
            "medical_question",
            "complex_change_request",
            "repeated_misunderstanding",
            "other",
          ],
        },
        notes: {
          type: "string",
          maxLength: 500,
          description: "Optional non-PHI context for the receiving admin.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "end_call",
    description:
      "Terminate the call. MUST be the last tool invoked on every call. The outcome enum is the canonical lifecycle reason recorded against the conversation.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "order_placed",
            "completed",
            "patient_declined",
            "no_answer",
            "voicemail",
            "wrong_number",
            "handoff",
            "identity_verification_failed",
          ],
        },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
] as const;

// ---- Dispatcher contract -------------------------------------------------
//
// Implemented in artifacts/resupply-api/src/lib/voice/tools-impl.ts. The
// bridge holds a `ToolDispatcher` and forwards every model tool call to
// `dispatch()`. The dispatcher is bound to a `{ patientId,
// conversationId }` pair at construction time so the model never has to
// see those identifiers.
//
// Errors thrown by `dispatch()` are caught by the bridge and reported
// back to the model as a structured error result so the agent can
// recover (e.g. ask the caller to repeat the date of birth).

export type ToolArgsByName = {
  [K in ToolName]: z.infer<(typeof TOOL_ARG_SCHEMAS)[K]>;
};

export interface DispatchToolCall<K extends ToolName = ToolName> {
  /** OpenAI's id for this specific tool call — round-trip into the result. */
  callId: string;
  name: K;
  args: ToolArgsByName[K];
}

export interface DispatchToolResult<K extends ToolName = ToolName> {
  callId: string;
  name: K;
  /** JSON-serialisable result. */
  result: ToolResultByName[K];
}

export interface ToolDispatcher {
  /**
   * Validate args, perform side effects, return a result. Implementors
   * MUST throw if `name` is not a known tool — the bridge maps that to
   * an error result the model can react to.
   */
  dispatch<K extends ToolName>(
    call: DispatchToolCall<K>,
  ): Promise<DispatchToolResult<K>>;
}

/**
 * Sanitise a tool-call's arguments for audit logging. We never want
 * raw DOBs or addresses landing in plaintext audit metadata. The audit
 * sanitizer in @workspace/resupply-audit also rejects PHI-shaped keys,
 * but defense-in-depth means we strip them HERE so a future audit
 * sanitiser change can't accidentally let them through.
 *
 * Returns: a shape that records WHICH args were provided (and string
 * lengths where relevant) without their VALUES.
 */
export function summarizeToolArgsForAudit(
  name: ToolName,
  args: unknown,
): Record<string, unknown> {
  if (args === null || typeof args !== "object")
    return { name, args_kind: typeof args };
  const a = args as Record<string, unknown>;
  switch (name) {
    case "verify_patient_identity":
      return { name, has_dob: typeof a.date_of_birth === "string" };
    case "verify_shop_customer_identity":
      return { name, has_last_four: typeof a.last_four === "string" };
    case "lookup_resupply_inventory":
    case "get_shipping_address":
    case "get_customer_chart":
      return { name };
    case "update_shipping_address":
      return {
        name,
        has_street: typeof a.street === "string",
        has_city: typeof a.city === "string",
        has_state: typeof a.state === "string",
        has_postal_code: typeof a.postal_code === "string",
      };
    case "place_resupply_order":
      return {
        name,
        sku_count: Array.isArray(a.skus) ? a.skus.length : 0,
        address_confirmed: a.address_confirmed === true,
      };
    case "request_human_handoff":
      return {
        name,
        reason: typeof a.reason === "string" ? a.reason : null,
        has_notes: typeof a.notes === "string",
      };
    case "end_call":
      return {
        name,
        outcome: typeof a.outcome === "string" ? a.outcome : null,
      };
    default:
      // The switch is exhaustive over ToolName, but this function is
      // exported and reusable: a caller passing an unvalidated/unknown
      // tool name would otherwise fall through and return `undefined`,
      // violating the declared return type and writing `undefined` into an
      // audit record. Never echo raw args (may carry PHI) — name only.
      return { name: String(name), unknown_tool: true };
  }
}

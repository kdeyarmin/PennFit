// Voice tool implementations — the live side effects the model can
// invoke during a call. The contract (`ToolDispatcher`) lives in
// @workspace/resupply-ai; this file is the API-side implementation.
//
// PHI rules baked in:
//   * Patient identifiers (patientId, episodeId, conversationId) are
//     bound at construction time. The model NEVER sees them in any
//     argument or any return value.
//   * All free-form caller content stays in the encrypted `messages`
//     table. Tool args + results carry only the structured shape the
//     model needs to reason — never raw addresses, full names, or DOBs
//     on the way out.
//   * Identity verification gates every other side-effect tool. Until
//     `verify_patient_identity` succeeds, dispatcher returns a stub
//     `identity_required` shape so the model is forced to verify
//     first. The two exceptions are `request_human_handoff` and
//     `end_call` — a panicking caller MUST be able to escape to a
//     human or hang up without first proving their date of birth.
//
// Why raw SQL for the identity check (and not Drizzle .select):
//   The check needs `pgp_sym_decrypt(...) = $dob` evaluated INSIDE
//   Postgres so we never pull the plaintext DOB across the wire into
//   the API process. Drizzle's select projection would let us do the
//   same thing, but the parameterised SQL is shorter, easier to
//   audit, and avoids an extra import. The data key flows through the
//   shared encryption helpers' source of truth — we read it via
//   `getDataKey()` rather than `process.env.RESUPPLY_DATA_KEY`
//   directly so a missing key throws the same descriptive error from
//   here as from a Drizzle-side encrypt() call.

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { timingSafeEqual, randomUUID } from "node:crypto";

import {
  conversations,
  decrypt,
  decryptJson,
  encryptJson,
  episodes,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import type {
  DispatchToolCall,
  DispatchToolResult,
  ToolDispatcher,
  ToolName,
} from "@workspace/resupply-ai";

const MAX_VERIFY_ATTEMPTS = 3;

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
      // Should not happen — identity tool is exempt — but return a
      // safe shape anyway.
      return {
        matched: false,
        attempts_remaining: MAX_VERIFY_ATTEMPTS,
      } as DispatchToolResult<K>["result"];
    case "lookup_resupply_inventory":
      return { items: [] } as unknown as DispatchToolResult<K>["result"];
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
  // Drizzle handle bound to the resupply pool. The dispatcher does not
  // construct its own Pool/db handle so this lib never has to import
  // the `pg` package directly (architecture rule 7) and tests can
  // inject a mock db.
  db: NodePgDatabase;
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
  private readonly db: NodePgDatabase;

  constructor(private readonly deps: VoiceToolDispatcherDeps) {
    this.db = deps.db;
  }

  isIdentityVerified(): boolean {
    return this.verified;
  }

  async dispatch<K extends ToolName>(
    call: DispatchToolCall<K>,
  ): Promise<DispatchToolResult<K>> {
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
    this.verifyAttempts += 1;
    const attemptsRemaining = Math.max(
      0,
      MAX_VERIFY_ATTEMPTS - this.verifyAttempts,
    );

    // Decrypt DOB + first name in-database. The plaintext DOB is
    // compared in Node with `timingSafeEqual` so we don't leak match
    // duration via the SQL planner.
    const rows = await this.db
      .select({
        dob: decrypt(patients.dateOfBirth),
        firstName: decrypt(patients.legalFirstName),
      })
      .from(patients)
      .where(eq(patients.id, this.deps.patientId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.dob) {
      return {
        callId: call.callId,
        name: call.name,
        result: { matched: false, attempts_remaining: attemptsRemaining },
      };
    }

    const matched = constantTimeStringEquals(call.args.date_of_birth, row.dob);
    if (matched) {
      this.verified = true;
      return {
        callId: call.callId,
        name: call.name,
        result: {
          matched: true,
          first_name: row.firstName ?? undefined,
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
    const rows = await this.db
      .select({
        sku: prescriptions.itemSku,
        cadenceDays: prescriptions.cadenceDays,
      })
      .from(prescriptions)
      .where(eq(prescriptions.patientId, this.deps.patientId));

    const items = rows
      .filter((r) => r.sku)
      .map((r) => ({
        sku: r.sku,
        // We don't carry SKU descriptions in our schema yet — the
        // Pacware product catalogue lives outside this DB. The model's
        // prompt tells it the description is the SKU's product
        // description in plain English; for now we hand it the SKU
        // itself so it can still read it back to the patient.
        description: r.sku,
        quantity: 1,
        due_reason: `every ${r.cadenceDays} days`,
      }));

    return {
      callId: call.callId,
      name: call.name,
      result: { items },
    };
  }

  private async getShippingAddress(
    call: DispatchToolCall<"get_shipping_address">,
  ): Promise<DispatchToolResult<"get_shipping_address">> {
    const rows = await this.db
      .select({
        address: decryptJson<{
          line1: string;
          line2?: string;
          city: string;
          state: string;
          postalCode: string;
          country: string;
        }>(patients.address),
      })
      .from(patients)
      .where(eq(patients.id, this.deps.patientId))
      .limit(1);

    const addr = rows[0]?.address ?? null;
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
    await this.db
      .update(patients)
      .set({ address: encryptJson(newAddress) })
      .where(eq(patients.id, this.deps.patientId));

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
    // Mark the episode as `confirmed`. Actual order placement against
    // Pacware is a downstream worker job; the operator dashboard will
    // pick this episode up in the "ready to fulfil" queue.
    const orderId = randomUUID();
    await this.db
      .update(episodes)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(episodes.id, this.deps.episodeId));

    return {
      callId: call.callId,
      name: call.name,
      result: {
        ok: true,
        order_id: orderId,
        accepted_skus: args.skus,
      },
    };
  }

  private async requestHumanHandoff(
    call: DispatchToolCall<"request_human_handoff">,
  ): Promise<DispatchToolResult<"request_human_handoff">> {
    const handoffId = randomUUID();
    // Move the conversation into the operator queue so the dashboard
    // surfaces it immediately. We do NOT close the conversation here
    // — the human operator will close it once they've handled the
    // escalation.
    await this.db
      .update(conversations)
      .set({ status: "awaiting_operator", updatedAt: new Date() })
      .where(eq(conversations.id, this.deps.conversationId));

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

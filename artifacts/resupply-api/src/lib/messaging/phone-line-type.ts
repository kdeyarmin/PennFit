// Phone line-type classification + caching.
//
// Wraps Twilio Lookup v2 (line_type_intelligence) and caches the result on
// the patient / shop_customer row so the app knows whether a number is a
// cell, and so bulk-campaign SMS can be gated to cellular numbers.
//
// Policy:
//   * A 'manual' source value is authoritative — staff override — and is
//     NEVER overwritten by a lookup.
//   * Lookup creds are the account-level Twilio creds (TWILIO_ACCOUNT_SID /
//     _AUTH_TOKEN). When unset, classification is a graceful no-op (numbers
//     stay unclassified → allowed to send under the allow-unknown policy).
//   * PHI: a phone number is PHI — never log it. We log only ids + the
//     resolved line type + a checked flag.

import {
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";
import {
  createTwilioLookupClient,
  type PhoneLineType,
  type TwilioLookupClient,
} from "@workspace/resupply-telecom";

import { logger } from "../logger.js";

export type LineTypeRecipientKind = "patient" | "shop_customer";

/** Build a Lookup client from account-level creds, or null when unset. */
export function readLookupClientOrNull(
  env: NodeJS.ProcessEnv = process.env,
): TwilioLookupClient | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  try {
    return createTwilioLookupClient({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
    });
  } catch {
    return null;
  }
}

interface PhoneRow {
  phone_e164: string | null;
  phone_line_type: PhoneLineType | null;
  phone_line_type_source: "lookup" | "manual" | null;
}

function tableFor(kind: LineTypeRecipientKind): "patients" | "shop_customers" {
  return kind === "patient" ? "patients" : "shop_customers";
}

function idColumnFor(kind: LineTypeRecipientKind): "id" | "customer_id" {
  return kind === "patient" ? "id" : "customer_id";
}

/**
 * Classify a recipient's phone line type via Twilio Lookup and cache it on the
 * row. Skips when: Lookup isn't configured, the row has no phone, the phone
 * won't normalize, or the value was set manually (override is authoritative).
 *
 * Returns the resolved line type, or null when nothing was classified.
 * Fire-and-forget safe: never throws.
 */
export async function classifyAndCachePhoneLineType(input: {
  orgId: string;
  kind: LineTypeRecipientKind;
  id: string;
  /** Pre-built client (e.g. a backfill loop reusing one); else read from env. */
  client?: TwilioLookupClient | null;
  /** Re-classify even if already classified (default false → only when unset). */
  force?: boolean;
}): Promise<PhoneLineType | null> {
  try {
    const client = input.client ?? readLookupClientOrNull();
    if (!client) return null;
    const supabase: OrgScopedClient = getOrgScopedClient(input.orgId);
    const table = tableFor(input.kind);
    const idCol = idColumnFor(input.kind);

    const { data, error } = await supabase
      .from(table)
      .select("phone_e164, phone_line_type, phone_line_type_source")
      .eq(idCol, input.id)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as PhoneRow;

    if (row.phone_line_type_source === "manual") return null; // never override
    if (!input.force && row.phone_line_type) return null; // already classified
    if (!row.phone_e164) return null; // no phone to classify

    // A phone that won't normalize can't be looked up — record it as
    // 'unknown' (rather than leaving phone_line_type NULL) so the nightly
    // backfill candidate scan doesn't re-pick it forever and starve other
    // rows. The phone-change DB trigger (migration 0399) re-NULLs it if the
    // number is later corrected, so it'll be re-classified then.
    const normalized = normalizeE164(row.phone_e164);
    const lineType = normalized
      ? (await client.lookupLineType(normalized)).lineType
      : "unknown";

    const { error: updErr } = await supabase
      .from(table)
      .update({
        phone_line_type: lineType,
        phone_line_type_source: "lookup",
        phone_line_type_checked_at: new Date().toISOString(),
      })
      .eq(idCol, input.id)
      // Don't clobber a manual override that landed between read and write.
      // NB: a bare `.neq("…","manual")` would compile to `<> 'manual'`, which
      // is NULL (not TRUE) for the NULL-source rows this path targets — so it
      // would match ZERO rows and silently drop every first-time
      // classification. Match "source IS NULL OR source <> 'manual'" instead.
      .or("phone_line_type_source.is.null,phone_line_type_source.neq.manual");
    if (updErr) {
      logger.warn(
        // Pass the error OBJECT so the logger's err.* redaction applies.
        { kind: input.kind, id: input.id, err: updErr },
        "phone_line_type: cache update failed",
      );
      return null;
    }
    logger.info(
      { kind: input.kind, id: input.id, lineType },
      "phone_line_type: classified",
    );
    return lineType;
  } catch (err) {
    logger.warn(
      { kind: input.kind, id: input.id, err },
      "phone_line_type: classify failed",
    );
    return null;
  }
}

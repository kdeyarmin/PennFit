// Resolve the tenant that owns a signed-link record (multi-tenant G1).
//
// The public storefront signed-link flows (CSR sign-&-pay orders, patient
// signature packets, reminder click-throughs, fitter invites, mask-fit
// responses) are authorized by an HMAC token that references one
// org-scoped record. The link carries no host/session tenant, so we resolve
// the tenant FROM the record: read `org_id` for the token's record id ACROSS
// tenants via `.raw()` — the one sanctioned cross-scope read — so a tenant-B
// link lands in tenant B and every subsequent read/write scopes to it.
//
// Falls back to the seed org when the record is absent (or single-tenant),
// so a miss degrades to the caller's existing not_found path rather than a
// 500. The `org_id` columns are NOT NULL, so a found row always carries a
// real tenant.
//
// Also used by the Twilio-signature-gated voice TwiML callbacks (check-in
// IVR, click-to-dial), which carry a record id (patient / call_disposition)
// in the URL but no tenant — same "resolve the org from the record" shape.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

/** Org-scoped tables a public signed link / signed callback can reference. */
export type SignedLinkTable =
  | "csr_order_requests"
  | "patient_packets"
  | "conversations"
  | "fitter_invites"
  | "fitter_leads"
  | "shop_orders"
  | "video_visits"
  | "prescription_request_packets"
  | "claim_appeal_letters"
  | "manual_documents"
  | "manual_document_packets"
  | "prior_authorizations"
  | "physician_fax_outreach"
  | "patients"
  | "call_dispositions"
  | "referral_reviews";

export async function resolveOrgIdForSignedRecord(
  table: SignedLinkTable,
  recordId: string,
): Promise<string | null> {
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return null;
  const { data } = await getOrgScopedClient(seedOrgId)
    .raw()
    .schema("resupply")
    .from(table)
    .select("org_id")
    .eq("id", recordId)
    .limit(1)
    .maybeSingle();
  return (data as { org_id: string | null } | null)?.org_id ?? seedOrgId;
}

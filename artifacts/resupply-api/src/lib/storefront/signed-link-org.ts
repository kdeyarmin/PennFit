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

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

/** Org-scoped tables a public signed link can reference. */
export type SignedLinkTable =
  | "csr_order_requests"
  | "patient_packets"
  | "conversations"
  | "fitter_invites"
  | "fitter_leads"
  | "shop_orders";

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

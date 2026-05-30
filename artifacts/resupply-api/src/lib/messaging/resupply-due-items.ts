// resupply-due-items.ts — resolve the supplies due on a resupply
// episode into display rows for the email-link confirmation landing
// page (renderClickLanding). Showing the patient exactly what's
// shipping, with a category chip, is the single biggest lever on
// resupply confirmation rate.
//
// Reuses the 0171 HCPCS layer (sku_hcpcs_map → hcpcs_codes) so the
// item name + category come from the canonical catalog rather than a
// raw SKU string. FAIL SOFT throughout: any missing row falls back to
// a humanized SKU, and the caller treats a throw as "render without
// the list" (back-compat). Supply names/quantities are product
// references, not PHI.

import type { ClickLandingItem } from "@workspace/resupply-messaging";
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

/** "CUSHION-NASAL-MED" → "Cushion nasal med" (fallback name only). */
function humanizeSku(sku: string): string {
  const words = sku
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return sku;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** Strip the trailing "(replacement)" the HCPCS descriptions carry. */
function cleanDescription(desc: string): string {
  return desc.replace(/\s*\(replacement\)\s*$/i, "").trim();
}

export async function buildResupplyDueItems(
  supabase: ResupplySupabaseClient,
  episodeId: string,
): Promise<ClickLandingItem[]> {
  // 1. episode → prescription_id
  const { data: episode, error: epErr } = await supabase
    .schema("resupply")
    .from("episodes")
    .select("id, prescription_id")
    .eq("id", episodeId)
    .limit(1)
    .maybeSingle();
  if (epErr) throw epErr;
  if (!episode?.prescription_id) return [];

  // 2. prescription → item_sku
  const { data: rx, error: rxErr } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("id, item_sku")
    .eq("id", episode.prescription_id)
    .limit(1)
    .maybeSingle();
  if (rxErr) throw rxErr;
  if (!rx?.item_sku) return [];
  const itemSku: string = rx.item_sku;

  // 3. SKU → HCPCS family (longest matching prefix).
  const { data: mapRows, error: mapErr } = await supabase
    .schema("resupply")
    .from("sku_hcpcs_map")
    .select("sku_prefix, hcpcs_code");
  if (mapErr) throw mapErr;
  const match = (mapRows ?? [])
    .filter((r) => itemSku.startsWith(r.sku_prefix))
    .sort((a, b) => b.sku_prefix.length - a.sku_prefix.length)[0];

  // Unmapped SKU → still show the item, humanized, as "other".
  if (!match) {
    return [{ name: humanizeSku(itemSku), category: "other", quantity: 1 }];
  }

  // 4. HCPCS → category + friendly name.
  const { data: hcpcs, error: hErr } = await supabase
    .schema("resupply")
    .from("hcpcs_codes")
    .select("category, short_description")
    .eq("code", match.hcpcs_code)
    .maybeSingle();
  if (hErr) throw hErr;

  return [
    {
      name: hcpcs?.short_description
        ? cleanDescription(hcpcs.short_description)
        : humanizeSku(itemSku),
      category: hcpcs?.category ?? "other",
      quantity: 1,
    },
  ];
}

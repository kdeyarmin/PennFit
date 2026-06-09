// Render a manual document to PDF bytes for the Telnyx fax media URL.
//
// Thin wrapper used by routes/fax/document.ts: loads the row and renders
// it. Returns null when the row is gone so the route can 404. No PHI in
// the URL (the token carries only the row id); bytes are never logged.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { loadManualDocumentRow, renderManualDocumentRowToPdf } from "./service";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export async function renderManualDocumentForFax(
  supabase: SupabaseClient,
  manualDocumentId: string,
): Promise<Buffer | null> {
  const row = await loadManualDocumentRow(supabase, manualDocumentId);
  if (!row) return null;
  return renderManualDocumentRowToPdf(supabase, row);
}

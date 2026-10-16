// Open the single new-CPAP setup row for a patient. A second open
// insert hits patient_setups_one_open and this function returns the
// row that won. Callers treat a failure as fail-soft: accepting a
// referral or filing a fit request must still succeed.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { redactDbErr } from "../redact-db-err";
import { escapeIlikeExact, uniquePatientIdsByEmail } from "./email-match";
import { orderHasE0601 } from "./machine-order";

export type SetupSource =
  | "referral"
  | "fit_request"
  | "provider_referral"
  | "manual";

export async function openPatientSetup(input: {
  orgId: string;
  patientId: string;
  source: SetupSource;
  sourceId?: string | null;
  ownerUserId?: string | null;
  ownerEmail?: string | null;
}): Promise<{ id: string; created: boolean } | null> {
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: existing, error: readErr } = await supabase
      .from("patient_setups")
      .select("id")
      .eq("patient_id", input.patientId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing?.id) return { id: existing.id, created: false };

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("patient_setups")
      .insert({
        patient_id: input.patientId,
        source: input.source,
        source_id: input.sourceId ?? null,
        status: "open",
        owner_user_id: input.ownerUserId ?? null,
        owner_email: input.ownerEmail ?? null,
        opened_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!error && data?.id) return { id: data.id, created: true };
    if ((error as { code?: string } | null)?.code !== "23505") {
      if (error) throw error;
      return null;
    }

    const { data: raced, error: raceErr } = await supabase
      .from("patient_setups")
      .select("id")
      .eq("patient_id", input.patientId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (raceErr) throw raceErr;
    return raced?.id ? { id: raced.id, created: false } : null;
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err), source: input.source },
      "patient setup: open failed",
    );
    return null;
  }
}

/**
 * A fit request has no patient id. Match one chart by email and open
 * its setup. Zero matches and two matches both leave the request as a
 * synthetic board row instead of guessing a chart.
 */
export async function openSetupForFitRequest(input: {
  orgId: string;
  requestId: string;
  email: string;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!email) return;
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const matched = await matchUniquePatientsByEmail(supabase, [email]);
    const patientId = matched.get(email);
    if (!patientId) return;
    await openPatientSetup({
      orgId: input.orgId,
      patientId,
      source: "fit_request",
      sourceId: input.requestId,
    });
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "patient setup: fit-request match failed",
    );
  }
}

type OrgClient = ReturnType<typeof getOrgScopedClient>;

/**
 * Exact case-insensitive matches only. An email that hits two charts
 * is omitted so the caller cannot pick one of them.
 */
export async function matchUniquePatientsByEmail(
  supabase: OrgClient,
  emails: string[],
): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(
      emails.map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const rows: Array<{ id: string; email: string | null }> = [];
  for (let index = 0; index < wanted.length; index += 15) {
    const chunk = wanted.slice(index, index + 15);
    const found = await Promise.all(
      chunk.map(async (address) => {
        const { data, error } = await supabase
          .from("patients")
          .select("id, email")
          .ilike("email", escapeIlikeExact(address))
          .limit(5);
        if (error) throw error;
        const list = Array.isArray(data) ? data : [];
        return list.filter(
          (row) => row.email?.trim().toLowerCase() === address,
        );
      }),
    );
    for (const list of found) rows.push(...list);
  }
  return uniquePatientIdsByEmail(rows);
}

/** Point the open setup at this E0601 signature order. A later order
 *  does not replace one that is already linked. */
export async function linkOpenSetupToE0601Order(input: {
  orgId: string;
  patientId: string;
  orderId: string;
  items: unknown;
}): Promise<void> {
  if (!orderHasE0601(input.items)) return;
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { error } = await supabase
      .from("patient_setups")
      .update({
        csr_order_request_id: input.orderId,
        updated_at: new Date().toISOString(),
      })
      .eq("patient_id", input.patientId)
      .eq("status", "open")
      .is("csr_order_request_id", null);
    if (error) throw error;
  } catch (err) {
    logger.warn({ err: redactDbErr(err) }, "patient setup: order link failed");
  }
}

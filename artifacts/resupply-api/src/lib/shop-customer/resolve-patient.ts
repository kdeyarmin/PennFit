import { getOrgScopedClient } from "@workspace/resupply-db";

/**
 * Bind the signed-in shop customer to a patient chart by email.
 *
 * Same exactly-one-match rule as /api/me/billing-statements and the
 * signed-in account chatbot — refuse when zero or ambiguous matches.
 */
export async function resolvePatientIdForCustomer(
  supabase: ReturnType<typeof getOrgScopedClient>,
  customerId: string,
): Promise<string | null> {
  const { data: customer, error: customerErr } = await supabase
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (customerErr) throw customerErr;
  if (!customer?.email_lower) return null;

  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients, error: patientErr } = await supabase
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (patientErr) throw patientErr;
  if (!patients || patients.length !== 1) return null;
  return patients[0]!.id;
}

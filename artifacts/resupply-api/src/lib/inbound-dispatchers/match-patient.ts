// Patient auto-matcher for inbound referrals.
//
// Strategy (in order — first hit wins):
//   1. exact_phone        — patients.phone_e164 = order.patient.phoneE164
//   2. exact_dob_last_name — date_of_birth = order.patient.dob AND
//                            legal_last_name ILIKE order.patient.lastName
//   3. fuzzy_phone_tail   — last-7-digit substring match (handles US
//                            area-code rewrites + Parachute's
//                            inconsistent country-code prefix)
//
// Multi-match handling: the matcher returns the first single hit per
// strategy. When multiple patients match a single strategy we punt
// to human triage (the suggested-patients endpoint surfaces them).
//
// PHI posture: logs the referral id and the chosen kind only. NEVER
// the DOB / last name / phone / email itself.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export type PatientMatchKind =
  | "exact_phone"
  | "exact_dob_last_name"
  | "fuzzy_phone_tail"
  | "none";

export interface PatientMatchInput {
  /** From ParachuteOrder.patient. */
  lastName: string | null;
  dob: string | null;
  phoneE164: string | null;
}

export interface PatientMatchResult {
  patientId: string | null;
  kind: PatientMatchKind;
}

export async function matchPatient(
  input: PatientMatchInput,
): Promise<PatientMatchResult> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. exact_phone
  if (input.phoneE164) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("phone_e164", input.phoneE164)
      .limit(2);
    if (error) {
      logger.error(
        {
          event: "inbound_referral.match_patient.db_error",
          err: error.message,
        },
        "inbound referral patient matcher: database error on exact_phone",
      );
      throw error;
    }
    if (data && data.length === 1) {
      return { patientId: data[0].id, kind: "exact_phone" };
    }
    // 2+ exact-phone matches → ambiguous, fall through.
  }

  // 2. exact_dob_last_name
  if (input.dob && input.lastName) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("date_of_birth", input.dob)
      .ilike("legal_last_name", input.lastName)
      .limit(2);
    if (error) {
      logger.error(
        {
          event: "inbound_referral.match_patient.db_error",
          err: error.message,
        },
        "inbound referral patient matcher: database error on exact_dob_last_name",
      );
      throw error;
    }
    if (data && data.length === 1) {
      return { patientId: data[0].id, kind: "exact_dob_last_name" };
    }
  }

  // 3. fuzzy_phone_tail — last 7 digits of phone string.
  if (input.phoneE164 && input.phoneE164.length >= 7) {
    const tail = input.phoneE164.slice(-7);
    if (/^\d{7}$/.test(tail)) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .ilike("phone_e164", `%${tail}%`)
        .limit(2);
      if (error) {
        logger.error(
          {
            event: "inbound_referral.match_patient.db_error",
            err: error.message,
          },
          "inbound referral patient matcher: database error on fuzzy_phone_tail",
        );
        throw error;
      }
      if (data && data.length === 1) {
        return { patientId: data[0].id, kind: "fuzzy_phone_tail" };
      }
    }
  }

  logger.info(
    { event: "inbound_referral.match_patient.none" },
    "inbound referral patient matcher found 0 / >1 candidates",
  );
  return { patientId: null, kind: "none" };
}

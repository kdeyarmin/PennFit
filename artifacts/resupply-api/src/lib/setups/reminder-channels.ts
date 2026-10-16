// Read the chart's stored communication preferences before a signature
// reminder. A lookup error is not "no preference": the caller sends
// nothing and leaves the reminder stamp for the next tick.

import {
  type CommunicationPreferences,
  DEFAULT_COMMUNICATION_PREFERENCES,
  getOrgScopedClient,
} from "@workspace/resupply-db";

type OrgClient = ReturnType<typeof getOrgScopedClient>;

export interface SignaturePrefs {
  prefs: CommunicationPreferences;
  explicit: boolean;
  unknown: boolean;
  patientTimezone: string | null;
}

const UNKNOWN_PREFS: SignaturePrefs = {
  prefs: DEFAULT_COMMUNICATION_PREFERENCES,
  explicit: false,
  unknown: true,
  patientTimezone: null,
};

export async function readSignaturePrefs(
  supabase: OrgClient,
  patientId: string | null,
): Promise<SignaturePrefs> {
  if (!patientId) {
    return {
      prefs: DEFAULT_COMMUNICATION_PREFERENCES,
      explicit: false,
      unknown: false,
      patientTimezone: null,
    };
  }
  try {
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id, email, timezone, portal_auth_user_id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) return UNKNOWN_PREFS;
    if (!patient) {
      return {
        prefs: DEFAULT_COMMUNICATION_PREFERENCES,
        explicit: false,
        unknown: false,
        patientTimezone: null,
      };
    }
    const patientTimezone = patient.timezone ?? null;
    const authUserId = patient.portal_auth_user_id ?? null;
    const email = patient.email ?? null;

    const found = async (
      column: "auth_user_id" | "email_lower",
      value: string,
    ): Promise<{ raw: unknown; failed: boolean }> => {
      const { data, error } = await supabase
        .from("shop_customers")
        .select("communication_preferences")
        .eq(column, value)
        .limit(1)
        .maybeSingle();
      if (error) return { raw: null, failed: true };
      return { raw: data?.communication_preferences ?? null, failed: false };
    };

    let raw: unknown = null;
    if (authUserId) {
      const byAuth = await found("auth_user_id", authUserId);
      if (byAuth.failed) return UNKNOWN_PREFS;
      raw = byAuth.raw;
    }
    if (!raw && email) {
      const byEmail = await found("email_lower", email.toLowerCase());
      if (byEmail.failed) return UNKNOWN_PREFS;
      raw = byEmail.raw;
    }
    if (!raw || typeof raw !== "object") {
      return {
        prefs: DEFAULT_COMMUNICATION_PREFERENCES,
        explicit: false,
        unknown: false,
        patientTimezone,
      };
    }
    return {
      prefs: {
        ...DEFAULT_COMMUNICATION_PREFERENCES,
        ...(raw as Partial<CommunicationPreferences>),
      },
      explicit: true,
      unknown: false,
      patientTimezone,
    };
  } catch {
    return UNKNOWN_PREFS;
  }
}

// Hand-rolled fetch wrapper for the /rules/test simulator.

export type Channel = "sms" | "email" | "voice";

export interface RuleTestInput {
  patient: {
    tenureDays?: number;
    insurancePayer?: string | null;
    cadenceOverrideDays?: number | null;
    channelPreference?: Channel | null;
    hasPhone?: boolean;
  };
  prescription: {
    itemSku: string;
    cadenceDays: number;
  };
}

export interface RuleTestEvaluatedRow {
  id: string;
  priority: number;
  cadenceDays: number;
  defaultChannel: Channel | null;
  matchItemSkuPrefix: string | null;
  matchInsurancePayer: string | null;
  minTenureDays: number | null;
  maxTenureDays: number | null;
  active: boolean;
  matched: boolean;
  reasonsForNoMatch: string[];
}

export interface RuleTestResponse {
  input: {
    patient: {
      tenureDays: number;
      insurancePayer: string | null;
      cadenceOverrideDays: number | null;
      channelPreference: Channel | null;
      hasPhone: boolean;
    };
    prescription: {
      itemSku: string;
      cadenceDays: number;
    };
    now: string;
  };
  plan: {
    cadenceDays: number;
    cadenceSource: "patient_override" | "rule" | "prescription";
    channel: Channel;
    channelSource:
      | "patient_override"
      | "rule"
      | "default_sms"
      | "default_email";
    matchedRuleId: string | null;
  };
  evaluated: RuleTestEvaluatedRow[];
}

export async function testRules(input: RuleTestInput): Promise<RuleTestResponse> {
  const res = await fetch("/resupply-api/rules/test", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Test failed (${res.status})`);
  }
  return (await res.json()) as RuleTestResponse;
}

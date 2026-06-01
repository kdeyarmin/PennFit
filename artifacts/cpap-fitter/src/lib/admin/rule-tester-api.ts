// Hand-rolled fetch wrapper for the /rules/test simulator.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

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

export async function testRules(
  input: RuleTestInput,
): Promise<RuleTestResponse> {
  const url = "/resupply-api/rules/test";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as RuleTestResponse;
}

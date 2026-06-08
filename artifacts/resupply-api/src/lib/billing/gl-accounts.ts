// Configurable GL account names for the QuickBooks export (owner #O3).
//
// resolveGlAccounts() is pure (rows → resolved names with defaults) and
// unit-tested; loadGlAccounts() reads the gl_account_mappings table and
// resolves. Defaults mirror the historical hardcoded constants in
// lib/quickbooks-export.ts so an unconfigured export is unchanged.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export const GL_ACCOUNT_KEYS = [
  "deposit",
  "revenue",
  "refund",
  "patient_pay",
] as const;
export type GlAccountKey = (typeof GL_ACCOUNT_KEYS)[number];

export interface ResolvedGlAccounts {
  deposit: string;
  revenue: string;
  refund: string;
  patientPay: string;
}

/** Defaults — must match lib/quickbooks-export.ts + the patient-pay row. */
export const GL_ACCOUNT_DEFAULTS: ResolvedGlAccounts = {
  deposit: "Stripe Clearing",
  revenue: "Sales:Online Orders",
  refund: "Sales Returns and Allowances",
  patientPay: "Patient Payments",
};

export interface GlAccountMappingRow {
  mapping_key: string;
  account_name: string;
}

/** Pure: overlay configured rows onto the defaults. */
export function resolveGlAccounts(
  rows: readonly GlAccountMappingRow[],
): ResolvedGlAccounts {
  const out: ResolvedGlAccounts = { ...GL_ACCOUNT_DEFAULTS };
  for (const r of rows) {
    const name = (r.account_name ?? "").trim();
    if (!name) continue;
    switch (r.mapping_key) {
      case "deposit":
        out.deposit = name;
        break;
      case "revenue":
        out.revenue = name;
        break;
      case "refund":
        out.refund = name;
        break;
      case "patient_pay":
        out.patientPay = name;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Load + resolve the configured GL accounts (defaults when unset). */
export async function loadGlAccounts(): Promise<ResolvedGlAccounts> {
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("gl_account_mappings")
    .select("mapping_key, account_name");
  return resolveGlAccounts((data ?? []) as GlAccountMappingRow[]);
}

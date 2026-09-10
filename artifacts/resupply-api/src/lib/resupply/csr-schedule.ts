import type { Database, OrgScopedClient } from "@workspace/resupply-db";
import {
  resolveOutreachPlan,
  type OutreachChannel,
  type OutreachRule,
} from "@workspace/resupply-domain";
import { isFeatureEnabled } from "../feature-flags";

type Tables = Database["resupply"]["Tables"];
export type SchedulePatient = Pick<
  Tables["patients"]["Row"],
  | "id"
  | "created_at"
  | "insurance_payer"
  | "cadence_override_days"
  | "channel_preference"
  | "phone_e164"
>;
export type SchedulePrescription = Pick<
  Tables["prescriptions"]["Row"],
  "item_sku" | "cadence_days" | "created_at"
>;
export type ScheduleContext = {
  dueAtAuthoritative: boolean;
  rules: OutreachRule[];
};

/** Same tenant cutover and domain planner as reminders.scan. */
export async function loadCsrScheduleContext(
  db: OrgScopedClient,
  orgId: string,
): Promise<ScheduleContext> {
  const dueAtAuthoritative = await isFeatureEnabled(
    "resupply.due_at_authoritative",
    orgId,
  );
  const rules: OutreachRule[] = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await db
      .from("frequency_rules")
      .select(
        "id, priority, created_at, active, match_item_sku_prefix, match_insurance_payer, min_tenure_days, max_tenure_days, cadence_days, default_channel",
      )
      .eq("active", true)
      .order("id")
      .range(offset, offset + 199);
    if (error) throw error;
    for (const r of data ?? [])
      rules.push({
        id: r.id,
        priority: r.priority,
        createdAt: new Date(r.created_at),
        active: r.active,
        matchItemSkuPrefix: r.match_item_sku_prefix,
        matchInsurancePayer: r.match_insurance_payer,
        minTenureDays: r.min_tenure_days,
        maxTenureDays: r.max_tenure_days,
        cadenceDays: r.cadence_days,
        defaultChannel: r.default_channel as OutreachChannel | null,
      });
    if (!data || data.length < 200) break;
  }
  return { dueAtAuthoritative, rules };
}

export const supplyDateKey = (patientId: string, itemSku: string) =>
  `${patientId}\x00${itemSku}`;

/** MAX(COALESCE(shipped_at, created_at)), per patient/SKU, matching the scanner. */
export async function loadLastSupplyDates(
  db: OrgScopedClient,
  patientIds: string[],
) {
  const dates = new Map<string, string>();
  const ids = [...new Set(patientIds)];
  for (let i = 0; i < ids.length; i += 200) {
    for (let offset = 0; ; offset += 200) {
      const { data, error } = await db
        .from("fulfillments")
        .select("id, patient_id, item_sku, shipped_at, created_at")
        .in("patient_id", ids.slice(i, i + 200))
        .neq("status", "cancelled")
        .order("id")
        .range(offset, offset + 199);
      if (error) throw error;
      for (const f of data ?? []) {
        const at = f.shipped_at ?? f.created_at;
        const key = supplyDateKey(f.patient_id, f.item_sku);
        if (at && (!dates.has(key) || at > dates.get(key)!)) dates.set(key, at);
      }
      if (!data || data.length < 200) break;
    }
  }
  return dates;
}

export function resolveCsrSchedule(
  context: ScheduleContext,
  patient: SchedulePatient,
  rx: SchedulePrescription,
  episodeDueAt: string,
  lastSupplyAt: string | undefined,
  now: Date,
) {
  const plan = resolveOutreachPlan({
    patient: {
      id: patient.id,
      createdAt: new Date(patient.created_at),
      insurancePayer: patient.insurance_payer ?? null,
      cadenceOverrideDays: patient.cadence_override_days ?? null,
      channelPreference: (patient.channel_preference ??
        null) as OutreachChannel | null,
      hasPhone: Boolean(patient.phone_e164),
    },
    prescription: { itemSku: rx.item_sku, cadenceDays: rx.cadence_days },
    rules: context.rules,
    now,
  });
  const dueMs = context.dueAtAuthoritative
    ? Date.parse(episodeDueAt)
    : Date.parse(lastSupplyAt ?? rx.created_at) + plan.cadenceDays * 86400000;
  return {
    cadenceDays: plan.cadenceDays,
    dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
  };
}

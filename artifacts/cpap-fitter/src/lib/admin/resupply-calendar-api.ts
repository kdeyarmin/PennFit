import { adminJsonFetch } from "../admin-json-fetch";
export interface ResupplyCalendarItem {
  id: string;
  patientId: string;
  patientName: string;
  itemSku: string;
  cadenceDays: number;
  dueAt: string;
  status: string;
  expiresAt: string | null;
  prescriptionValidUntil: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  channelPreference: string | null;
}
export interface SupplyOverview {
  linkedOrders: {
    id: string;
    orderReference: string;
    status: string;
    createdAt: string;
    signedAt: string | null;
    items: { description: string; quantity: number }[];
  }[];
  supplies: {
    prescriptionId: string;
    itemSku: string;
    itemName: string;
    hcpcsCode: string | null;
    cadenceDays: number;
    validUntil: string | null;
    episodeId: string | null;
    scheduledDueAt: string | null;
    lastOrderedAt: string | null;
    eligibility: {
      status: string;
      eligible: boolean;
      intervalEligibleOn: string;
      quantityEligibleOn: string | null;
      maxQuantityNow: number;
      reason: string;
    } | null;
  }[];
  orders: {
    id: string;
    itemSku: string;
    itemName: string;
    quantity: number;
    status: string;
    orderReference: string | null;
    orderedAt: string;
    shippedAt: string | null;
    deliveredAt: string | null;
  }[];
  totalOrders: number;
  offset: number;
}
export type OutreachChannel = "email" | "sms" | "voice";
export interface OutreachResult {
  episodeId: string;
  status: "queued" | "skipped" | "error";
  message: string;
}
export const getResupplyCalendar = (
  from: string,
  to: string,
  overdue: boolean,
) =>
  adminJsonFetch<{ items: ResupplyCalendarItem[] }>(
    `/admin/resupply-calendar?${new URLSearchParams({ from, to, overdue: String(overdue) })}`,
  );
export const getSupplyOverview = (patientId: string, offset = 0) =>
  adminJsonFetch<SupplyOverview>(
    `/admin/patients/${patientId}/supply-overview?offset=${offset}`,
  );
export const queueResupplyOutreach = (
  episodeIds: string[],
  channel: OutreachChannel,
) =>
  adminJsonFetch<{ results: OutreachResult[] }>("/admin/resupply-outreach", {
    method: "POST",
    body: JSON.stringify({ episodeIds, channel }),
  });

/** Calendar day keys must use the same local timezone as the month boundaries. */
export function localDayKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function groupResupplyPatients(items: ResupplyCalendarItem[]) {
  const groups = new Map<string, ResupplyCalendarItem[]>();
  for (const item of [...items].sort(
    (a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id),
  )) {
    const group = groups.get(item.patientId) ?? [];
    group.push(item);
    groups.set(item.patientId, group);
  }
  return [...groups.values()];
}

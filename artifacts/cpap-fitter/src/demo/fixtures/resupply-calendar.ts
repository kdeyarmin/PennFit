import type {
  ResupplyCalendarItem,
  SupplyOverview,
} from "@/lib/admin/resupply-calendar-api";
import { demoPatients } from "./admin";

function dueAt(patientId: string) {
  const n = Number.parseInt(patientId.replace(/\D/g, ""), 10) || 1;
  const day = new Date();
  day.setHours(10, 0, 0, 0);
  day.setDate(day.getDate() + n * 2 - 12);
  return day.toISOString();
}
export function demoResupplyCalendar(
  from: string,
  to: string,
  overdue: boolean,
): { items: ResupplyCalendarItem[] } {
  const items = demoPatients(50)
    .items.filter((p) => p.status === "active")
    .map((p) => ({
      id: `demo-resupply-${p.id}`,
      patientId: p.id,
      patientName: `${p.firstName} ${p.lastName}`,
      itemSku: "Nasal mask · A7034",
      dueAt: dueAt(p.id),
      cadenceDays: 90,
      status: "outreach_pending",
      expiresAt: null,
      prescriptionValidUntil: null,
      hasPhone: p.hasPhone,
      hasEmail: p.hasEmail,
      channelPreference: null,
    }));
  return {
    items: items.filter((i) =>
      overdue ? i.dueAt < from : i.dueAt >= from && i.dueAt < to,
    ),
  };
}
export function demoSupplyOverview(patientId: string): SupplyOverview {
  const due = dueAt(patientId);
  const last = new Date(Date.parse(due) - 90 * 86400000).toISOString();
  const eligible = Date.parse(due) <= Date.now();
  return {
    supplies: [
      {
        prescriptionId: `rx-${patientId}`,
        itemSku: "A7034",
        itemName: "Nasal mask",
        hcpcsCode: "A7034",
        cadenceDays: 90,
        validUntil: null,
        episodeId: `demo-resupply-${patientId}`,
        scheduledDueAt: due,
        lastOrderedAt: last,
        eligibility: {
          status: eligible ? "eligible" : "too_soon",
          eligible,
          intervalEligibleOn: due,
          quantityEligibleOn: null,
          maxQuantityNow: eligible ? 1 : 0,
          reason: eligible
            ? "Eligible by the recorded replacement rule."
            : "Replacement interval has not elapsed.",
        },
      },
    ],
    orders: [
      {
        id: `fill-${patientId}`,
        itemSku: "A7034",
        itemName: "Nasal mask",
        quantity: 1,
        status: "shipped",
        orderReference: "DEMO-2026-1042",
        orderedAt: last,
        shippedAt: last,
        deliveredAt: new Date(Date.parse(last) + 3 * 86400000).toISOString(),
      },
    ],
    totalOrders: 1,
    offset: 0,
    linkedOrders: [],
  };
}

// ShippingEta — same-day cutoff countdown + estimated delivery
// window. Used on the product detail page (under the Add-to-cart
// button) and on the cart summary so the customer sees the same
// promise from PDP through checkout.
//
// All time math runs in America/New_York because the warehouse is
// in PA and the cutoff is wall-clock-by-warehouse, not by the
// shopper's timezone. We avoid pulling in a date library by using
// Intl.DateTimeFormat for the timezone conversion and UTC Date
// arithmetic for whole-day offsets (which is exact, no DST drift).

import { useEffect, useMemo, useState } from "react";
import { Truck } from "lucide-react";

const SHIP_CUTOFF_HOUR_ET = 14; // 2:00 PM ET
const STD_SHIPPING_BUSINESS_DAYS_MIN = 3;
const STD_SHIPPING_BUSINESS_DAYS_MAX = 5;

interface EasternParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sun, 6 = Sat
}

function easternPartsNow(now: Date): EasternParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const rawHour = parseInt(get("hour"), 10);
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(get("minute"), 10),
    weekday: weekdayMap[wd] ?? 0,
  };
}

function addDays(year: number, month: number, day: number, n: number) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

function isBusinessDay(weekday: number) {
  return weekday >= 1 && weekday <= 5;
}

function nextBusinessDay(year: number, month: number, day: number) {
  let cur = addDays(year, month, day, 1);
  while (!isBusinessDay(cur.weekday))
    cur = addDays(cur.year, cur.month, cur.day, 1);
  return cur;
}

function addBusinessDays(
  year: number,
  month: number,
  day: number,
  n: number,
) {
  let cur = {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
  let added = 0;
  while (added < n) {
    cur = addDays(cur.year, cur.month, cur.day, 1);
    if (isBusinessDay(cur.weekday)) added += 1;
  }
  return cur;
}

function formatDayLabel(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

interface ShippingEtaState {
  ctaLine: string;
  arrivalLine: string;
  countdown: string | null;
}

export function computeShippingEta(now: Date): ShippingEtaState {
  const et = easternPartsNow(now);
  const isWeekend = !isBusinessDay(et.weekday);
  const beforeCutoff = !isWeekend && et.hour < SHIP_CUTOFF_HOUR_ET;

  let shipDate: { year: number; month: number; day: number };
  let countdown: string | null = null;
  let ctaLine: string;

  if (beforeCutoff) {
    shipDate = { year: et.year, month: et.month, day: et.day };
    const minsUntilCutoff =
      (SHIP_CUTOFF_HOUR_ET - et.hour) * 60 - et.minute;
    const hours = Math.floor(minsUntilCutoff / 60);
    const minutes = minsUntilCutoff % 60;
    countdown =
      hours > 0
        ? `${hours}h ${minutes.toString().padStart(2, "0")}m`
        : `${minutes}m`;
    ctaLine = `Order in the next ${countdown} to ship today`;
  } else {
    const next = nextBusinessDay(et.year, et.month, et.day);
    shipDate = next;
    ctaLine = isWeekend
      ? `Ships ${formatDayLabel(next.year, next.month, next.day)}`
      : `Ships next business day (${formatDayLabel(next.year, next.month, next.day)})`;
  }

  const earliest = addBusinessDays(
    shipDate.year,
    shipDate.month,
    shipDate.day,
    STD_SHIPPING_BUSINESS_DAYS_MIN,
  );
  const latest = addBusinessDays(
    shipDate.year,
    shipDate.month,
    shipDate.day,
    STD_SHIPPING_BUSINESS_DAYS_MAX,
  );
  const arrivalLine = `Estimated delivery ${formatDayLabel(
    earliest.year,
    earliest.month,
    earliest.day,
  )} – ${formatDayLabel(latest.year, latest.month, latest.day)}`;
  return { ctaLine, arrivalLine, countdown };
}

export function ShippingEta({
  className = "",
  testIdPrefix = "shipping-eta",
}: {
  className?: string;
  /** Override for callers (e.g. PDP) that depend on a stable test id. */
  testIdPrefix?: string;
}) {
  // Tick once a minute so the countdown stays fresh without churning
  // CPU. Mount also re-computes so the value isn't stale on first
  // paint.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const { ctaLine, arrivalLine, countdown } = useMemo(
    () => computeShippingEta(now),
    [now],
  );
  return (
    <div
      className={`rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 flex items-start gap-2 ${className}`}
      data-testid={testIdPrefix}
      role="status"
    >
      <Truck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-700" />
      <div className="leading-snug">
        <div
          className="font-semibold"
          data-testid={`${testIdPrefix}-cta`}
          data-countdown={countdown ?? ""}
        >
          {ctaLine}
        </div>
        <div
          className="text-xs text-emerald-800/80"
          data-testid={`${testIdPrefix}-arrival`}
        >
          {arrivalLine}
        </div>
      </div>
    </div>
  );
}

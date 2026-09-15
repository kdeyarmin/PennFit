/** Strict decimal entry: blank is unknown, and partial/rounded values are refused. */
export function parsePricingMoney(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}

export function pricingMoneyInput(value: number | null | undefined): string {
  return value == null ? "" : (value / 100).toFixed(2);
}

export function formatPricingMoney(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "Not available"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value / 100);
}

export function parsePricingPercent(value: string): number | null {
  const bps = parsePricingMoney(value);
  return bps != null && bps < 10_000 ? bps : null;
}

export function pricingQuantity(value: string, maximum = 99): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum
    ? number
    : null;
}

export function pricingDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

export function pricingExpiry(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date.toISOString()
    : null;
}

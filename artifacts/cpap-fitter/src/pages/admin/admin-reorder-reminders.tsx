// /admin/reorder-reminders — reorder-reminder funnel dashboard.
//
// One window-scoped view of the resupply reminder ladder's effectiveness:
//   due → reminded → confirmed → shipped
// with a per-channel (SMS / email / voice) conversion breakdown so an
// operator can see which channel actually drives reorders. Read-only;
// backed by GET /admin/reorder-reminders/funnel.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, CheckCircle2, PhoneCall, Send, Truck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchReorderFunnel,
  type FunnelChannel,
  type ReorderFunnelResponse,
} from "@/lib/admin/reorder-reminders-api";

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

function WindowPicker({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (v: number) => void;
  options: number[];
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className="rounded-full px-2.5 py-1 text-xs font-semibold transition-colors"
          style={{
            backgroundColor:
              value === opt ? "hsl(var(--penn-gold))" : "hsl(var(--line-2))",
            color:
              value === opt ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
          }}
        >
          {opt}d
        </button>
      ))}
    </div>
  );
}

const CHANNEL_LABEL: Record<FunnelChannel, string> = {
  sms: "SMS",
  email: "Email",
  voice: "Voice call",
};

export function AdminReorderRemindersPage() {
  const [days, setDays] = useState(30);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "reorder-reminders", "funnel", days],
    queryFn: () => fetchReorderFunnel(days),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold">Reorder reminders</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          How the SMS → email → call reminder ladder converts due episodes into
          shipped reorders, and which channel is doing the work.
        </p>
      </header>

      <Card
        title="Funnel"
        subtitle="Episodes that became due in the window, and how far they got."
        action={
          <WindowPicker value={days} onChange={setDays} options={[7, 30, 90]} />
        }
      >
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <FunnelBody data={data} />
        )}
      </Card>
    </div>
  );
}

function FunnelBody({ data }: { data: ReorderFunnelResponse }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FunnelTile
          icon={<BellRing className="h-4 w-4" />}
          label="Due"
          value={data.due}
        />
        <FunnelTile
          icon={<Send className="h-4 w-4" />}
          label="Reminded"
          value={data.reminded}
          rate={pct(data.rates.remindedOfDue)}
          rateLabel="of due"
        />
        <FunnelTile
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Confirmed"
          value={data.confirmed}
          rate={pct(data.rates.confirmedOfReminded)}
          rateLabel="of reminded"
        />
        <FunnelTile
          icon={<Truck className="h-4 w-4" />}
          label="Shipped"
          value={data.shipped}
          rate={pct(data.rates.shippedOfConfirmed)}
          rateLabel="of confirmed"
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <PhoneCall className="h-4 w-4" />
          By channel
        </h3>
        <p className="text-xs mb-3" style={{ color: "hsl(var(--ink-3))" }}>
          An episode reminded on more than one channel is counted under each —
          so "confirm rate" reads as "of the patients we reached on this
          channel, how many reordered".
        </p>
        <div
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: "hsl(var(--line-2))" }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "hsl(var(--ink-3))" }}>
                <th scope="col" className="px-3 py-2 font-medium">
                  Channel
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Reminded
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Confirmed
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Shipped
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Confirm rate
                </th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(CHANNEL_LABEL) as FunnelChannel[]).map((ch) => {
                const s = data.byChannel[ch];
                const confirmRate =
                  s.reminded > 0 ? s.confirmed / s.reminded : null;
                return (
                  <tr
                    key={ch}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-2))" }}
                  >
                    <td className="px-3 py-2 font-medium">
                      {CHANNEL_LABEL[ch]}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.reminded}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.confirmed}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.shipped}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {pct(confirmRate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FunnelTile({
  icon,
  label,
  value,
  rate,
  rateLabel,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  rate?: string;
  rateLabel?: string;
}) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      <div
        className="flex items-center gap-1.5 text-xs font-medium"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {rate && (
        <div className="text-xs mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
          {rate} {rateLabel}
        </div>
      )}
    </div>
  );
}

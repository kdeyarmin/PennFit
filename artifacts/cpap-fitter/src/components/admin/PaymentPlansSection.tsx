// Payment-plans section for the patient billing tab.
//
// Completes the financing operator UX: list a patient's installment
// plans with their autopay status, create a new plan, and launch the
// off-session autopay authorization (Stripe setup mandate) — the action
// whose backend shipped separately. "Authorize autopay" opens the hosted
// Stripe setup page; on completion the webhook flips the plan to
// 'authorized' and the seeded-OFF auto-charge worker can debit it.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Plus } from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { csrfHeader } from "@/lib/csrf";

const BASE = "/resupply-api";

type AutopayStatus = "off" | "pending" | "authorized" | "revoked";

interface PlanSummary {
  paidCents: number;
  remainingCents: number;
  overdueCents: number;
}

interface PlanRow {
  id: string;
  total_amount_cents: number;
  installment_count: number;
  frequency: string;
  start_date: string;
  status: string;
  autopay_status: AutopayStatus | null;
  autopay_authorized_at: string | null;
  summary: PlanSummary | null;
}

function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const AUTOPAY_LABEL: Record<AutopayStatus, string> = {
  off: "Autopay off",
  pending: "Autopay pending",
  authorized: "Autopay on",
  revoked: "Autopay revoked",
};

const AUTOPAY_TONE: Record<AutopayStatus, string> = {
  off: "hsl(var(--ink-3))",
  pending: "#b45309",
  authorized: "#15803d",
  revoked: "#b91c1c",
};

async function listPlans(patientId: string): Promise<{ plans: PlanRow[] }> {
  const res = await fetch(`${BASE}/admin/patients/payment-plans/list`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({ patientId }),
  });
  if (!res.ok) throw new Error(`Failed to load payment plans (${res.status})`);
  return (await res.json()) as { plans: PlanRow[] };
}

export function PaymentPlansSection({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ["patient-payment-plans", patientId],
    queryFn: () => listPlans(patientId),
    staleTime: 30_000,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const authorize = useMutation({
    mutationFn: async (planId: string): Promise<string> => {
      const origin = window.location.origin;
      const res = await fetch(
        `${BASE}/admin/payment-plans/${planId}/authorize-autopay`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            successUrl: `${origin}/admin/patients/${patientId}?autopay=ok`,
            cancelUrl: `${origin}/admin/patients/${patientId}?autopay=cancelled`,
          }),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { message?: string; error?: string };
          detail = j.message ?? j.error ?? "";
        } catch {
          // ignore
        }
        throw new Error(detail || `request failed (${res.status})`);
      }
      const { url } = (await res.json()) as { url: string };
      return url;
    },
    onSuccess: (url) => {
      setActionError(null);
      void qc.invalidateQueries({
        queryKey: ["patient-payment-plans", patientId],
      });
      // Open the hosted Stripe setup page for the patient to complete.
      window.open(url, "_blank", "noopener,noreferrer");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed.");
    },
  });

  return (
    <Card
      title="Payment plans"
      subtitle="Installment plans for the patient balance. Authorize autopay to charge the schedule automatically."
    >
      <div className="mb-3 flex items-center gap-2">
        <Button
          intent="secondary"
          size="sm"
          onClick={() => setShowCreate((s) => !s)}
          data-testid="payment-plan-new-toggle"
        >
          <Plus className="h-3.5 w-3.5" />
          {showCreate ? "Close" : "New plan"}
        </Button>
        {actionError && (
          <span className="text-xs" style={{ color: "#b91c1c" }}>
            {actionError}
          </span>
        )}
      </div>

      {showCreate && (
        <CreatePlanForm
          patientId={patientId}
          onCreated={() => {
            setShowCreate(false);
            void qc.invalidateQueries({
              queryKey: ["patient-payment-plans", patientId],
            });
          }}
        />
      )}

      {plans.isPending ? (
        <Spinner label="Loading payment plans…" />
      ) : plans.isError ? (
        <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
          {plans.error instanceof Error
            ? plans.error.message
            : "Failed to load."}
        </p>
      ) : (plans.data?.plans.length ?? 0) === 0 ? (
        <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
          No payment plans on file.
        </p>
      ) : (
        <div className="space-y-2">
          {plans.data!.plans.map((p) => {
            const autopay = p.autopay_status ?? "off";
            const canAuthorize =
              p.status === "active" && autopay !== "authorized";
            return (
              <div
                key={p.id}
                className="rounded border p-3 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
                data-testid="payment-plan-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold tabular-nums">
                      {money(p.total_amount_cents)}
                    </span>{" "}
                    <span style={{ color: "hsl(var(--ink-3))" }}>
                      · {p.installment_count} × {p.frequency} · from{" "}
                      {p.start_date}
                    </span>
                  </div>
                  <span
                    className="text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: AUTOPAY_TONE[autopay] }}
                  >
                    {AUTOPAY_LABEL[autopay]}
                  </span>
                </div>
                {p.summary && (
                  <div
                    className="mt-1 text-[12px] tabular-nums"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    Paid {money(p.summary.paidCents)} · Remaining{" "}
                    {money(p.summary.remainingCents)}
                    {p.summary.overdueCents > 0 && (
                      <span style={{ color: "#b91c1c" }}>
                        {" "}
                        · Overdue {money(p.summary.overdueCents)}
                      </span>
                    )}
                  </div>
                )}
                {canAuthorize && (
                  <div className="mt-2">
                    <Button
                      intent="secondary"
                      size="sm"
                      disabled={authorize.isPending}
                      isLoading={
                        authorize.isPending && authorize.variables === p.id
                      }
                      onClick={() => authorize.mutate(p.id)}
                      data-testid="payment-plan-authorize"
                    >
                      <CreditCard className="h-3.5 w-3.5" />
                      {autopay === "pending"
                        ? "Re-send autopay authorization"
                        : "Authorize autopay"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CreatePlanForm({
  patientId,
  onCreated,
}: {
  patientId: string;
  onCreated: () => void;
}) {
  const [totalDollars, setTotalDollars] = useState("");
  const [count, setCount] = useState(6);
  const [frequency, setFrequency] = useState<"weekly" | "biweekly" | "monthly">(
    "monthly",
  );
  const [startDate, setStartDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (): Promise<void> => {
      const totalCents = Math.round(Number(totalDollars) * 100);
      if (!Number.isFinite(totalCents) || totalCents < count) {
        throw new Error("Enter a total of at least 1¢ per installment.");
      }
      const res = await fetch(
        `${BASE}/admin/patients/${patientId}/payment-plans`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            totalAmountCents: totalCents,
            installmentCount: count,
            frequency,
            startDate,
          }),
        },
      );
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
    },
    onSuccess: () => {
      setError(null);
      onCreated();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed."),
  });

  return (
    <div
      className="mb-3 rounded border p-3 grid grid-cols-2 gap-2 text-sm"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold">Total ($)</span>
        <input
          value={totalDollars}
          onChange={(e) => setTotalDollars(e.target.value)}
          inputMode="decimal"
          placeholder="300.00"
          className="rounded border px-2 py-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold">Installments</span>
        <input
          type="number"
          min={2}
          max={60}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="rounded border px-2 py-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold">Frequency</span>
        <select
          value={frequency}
          onChange={(e) =>
            setFrequency(e.target.value as "weekly" | "biweekly" | "monthly")
          }
          className="rounded border px-2 py-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <option value="weekly">Weekly</option>
          <option value="biweekly">Biweekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold">Start date</span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="rounded border px-2 py-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        />
      </label>
      <div className="col-span-2 flex items-center gap-2">
        <Button
          intent="primary"
          size="sm"
          disabled={create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
          data-testid="payment-plan-create"
        >
          Create plan
        </Button>
        {error && (
          <span className="text-xs" style={{ color: "#b91c1c" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

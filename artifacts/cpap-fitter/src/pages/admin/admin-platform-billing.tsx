import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  buildPreviewConfirm,
  fetchPlatformBillingActivity,
  fetchPlatformBillingCatalog,
  fetchPlatformTenantBilling,
  ensureTenantStripeCustomer,
  formatMoney,
  previewTenantBillingChange,
  resyncTenantStripeSubscriptions,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
  updateCatalogAddon,
  updateCatalogPlan,
  updateTenantAddon,
  updateTenantPlan,
  type BillingActivityEvent,
  type BillingAddon,
  type BillingPlan,
  type CatalogAddonEdit,
  type CatalogPlanEdit,
  type PlatformTenantBillingRow,
} from "@/lib/admin/platform-billing-api";
import { formatAppDateTime } from "@/lib/utils";

const METRIC_LABELS: Record<string, string> = {
  activePatients: "Active patients",
  seats: "Seats",
  locations: "Locations",
  ordersPerMonth: "Orders this month",
  activeSubscriptions: "Active subscriptions",
  outboundMessagesPerMonth: "Outbound messages",
  aiTextInteractionsPerMonth: "AI text interactions",
  billingTransactionsPerMonth: "Billing transactions",
  faxEvents: "Fax events",
  aiVoiceEvents: "AI voice events",
};

/** "$799.00" cents → "799" / "799.50" for an editable dollar input. */
function centsToDollarInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

/** Parse a dollar string from an input back to integer cents. Empty string
 *  → null (clears the column). Returns `undefined` for an unparseable value
 *  so the caller can reject the save. */
function dollarInputToCents(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function pct(used: number, limit: number | undefined): number | null {
  if (!limit || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function usageTone(used: number, limit: number | undefined) {
  const p = pct(used, limit);
  if (p === null) return "bg-slate-300";
  if (p >= 100) return "bg-red-600";
  if (p >= 90) return "bg-red-500";
  if (p >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function allowanceStatus(tenant: PlatformTenantBillingRow) {
  const plan = tenant.billing.subscription?.plan;
  const allowances = {
    ...(plan?.allowances ?? {}),
    ...(tenant.billing.subscription?.customAllowances ?? {}),
  };
  const rows = Object.entries(tenant.billing.usage.metrics).map(
    ([key, used]) => {
      const limit = allowances[key];
      return { key, used, limit, percent: pct(used, limit) };
    },
  );
  const overLimit = rows.filter((r) => r.percent !== null && r.percent >= 100);
  const nearLimit = rows.filter(
    (r) => r.percent !== null && r.percent >= 75 && r.percent < 100,
  );
  return { allowances, rows, overLimit, nearLimit };
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit?: number;
}) {
  const p = pct(used, limit);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span>
          {used.toLocaleString()}
          {limit ? ` / ${limit.toLocaleString()}` : ""}
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div
          className={`h-2 rounded-full ${usageTone(used, limit)}`}
          style={{ width: `${p ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function TenantEditor({
  tenant,
  plans,
  addons,
}: {
  tenant: PlatformTenantBillingRow;
  plans: BillingPlan[];
  addons: BillingAddon[];
}) {
  const qc = useQueryClient();
  const plan = tenant.billing.subscription?.plan;
  const { allowances, rows, overLimit, nearLimit } = allowanceStatus(tenant);
  const [planCode, setPlanCode] = useState(
    plan?.code ?? plans[0]?.code ?? "launch",
  );
  const [monthly, setMonthly] = useState(
    tenant.billing.subscription?.customMonthlyPriceCents?.toString() ?? "",
  );
  const [notes, setNotes] = useState(tenant.billing.subscription?.notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const savePlan = useMutation({
    mutationFn: () =>
      updateTenantPlan(tenant.id, {
        planCode,
        status: "active",
        customMonthlyPriceCents: monthly.trim() ? Number(monthly) : null,
        notes,
      }),
    onSuccess: () => {
      setMessage("Plan saved.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(err instanceof Error ? err.message : "Plan save failed.");
    },
  });
  const createStripeCustomer = useMutation({
    mutationFn: () => ensureTenantStripeCustomer(tenant.id),
    onSuccess: () => {
      setMessage("Stripe customer linked.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(
        err instanceof Error ? err.message : "Stripe customer sync failed.",
      );
    },
  });
  const syncStripeSubscription = useMutation({
    mutationFn: () => syncTenantStripeSubscription(tenant.id),
    onSuccess: () => {
      setMessage("Stripe subscription synced.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(
        err instanceof Error ? err.message : "Stripe subscription sync failed.",
      );
    },
  });
  const saveAddon = useMutation({
    mutationFn: ({
      addonCode,
      quantity,
    }: {
      addonCode: string;
      quantity: number;
    }) => updateTenantAddon(tenant.id, { addonCode, quantity }),
    onSuccess: () => {
      setMessage("Add-on saved.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(err instanceof Error ? err.message : "Add-on save failed.");
    },
  });
  const activeAddonQty = new Map(
    tenant.billing.addons.map((a) => [a.addon.code, a.quantity]),
  );
  const activeAddonsTotal = tenant.billing.addons.reduce((sum, a) => {
    const price =
      a.customRecurringPriceCents ?? a.addon.recurringPriceCents ?? 0;
    return sum + price * a.quantity;
  }, 0);
  const monthlyTotal =
    (tenant.billing.subscription?.customMonthlyPriceCents ??
      plan?.monthlyPriceCents ??
      0) + activeAddonsTotal;

  return (
    <Card className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">
              {tenant.storefrontName || tenant.name || tenant.slug}
            </h2>
            {overLimit.length > 0 ? (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                {overLimit.length} over limit
              </span>
            ) : nearLimit.length > 0 ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                {nearLimit.length} near limit
              </span>
            ) : (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                Healthy usage
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {tenant.slug} · {tenant.status} · usage month{" "}
            {tenant.billing.usage.month}
          </p>
          <p className="text-sm text-slate-500">
            Fax:{" "}
            {tenant.faxNumber ? (
              <span className="font-medium tabular-nums text-slate-700">
                {tenant.faxNumber}
              </span>
            ) : (
              <span className="text-slate-400">not provisioned</span>
            )}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold text-slate-900">
            {formatMoney(monthlyTotal)}/mo estimated
          </div>
          <div className="text-slate-500">
            {plan?.name ?? "No plan"} · add-ons {formatMoney(activeAddonsTotal)}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ key, used }) => (
          <UsageBar
            key={key}
            label={METRIC_LABELS[key] ?? key}
            used={used}
            limit={allowances[key]}
          />
        ))}
      </div>

      <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-semibold text-slate-900">Stripe billing</div>
            <div className="text-slate-600">
              Customer{" "}
              {tenant.billing.subscription?.stripeCustomerId ?? "not linked"}
              {" · "}
              Subscription{" "}
              {tenant.billing.subscription?.stripeSubscriptionId ??
                "not synced"}
            </div>
            <div className="text-xs text-slate-500">
              Status {tenant.billing.subscription?.stripeStatus ?? "—"} ·
              Invoice {tenant.billing.subscription?.lastInvoiceStatus ?? "—"}
              {tenant.billing.subscription?.currentPeriodEnd
                ? ` · Renews ${new Date(
                    tenant.billing.subscription.currentPeriodEnd,
                  ).toLocaleDateString(undefined, {
                    timeZone: "America/New_York",
                  })}`
                : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => createStripeCustomer.mutate()}
              disabled={createStripeCustomer.isPending}
              className="rounded-md border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-60"
            >
              {createStripeCustomer.isPending
                ? "Linking…"
                : "Create Stripe customer"}
            </button>
            <button
              onClick={() => syncStripeSubscription.mutate()}
              disabled={syncStripeSubscription.isPending}
              className="rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              {syncStripeSubscription.isPending
                ? "Syncing…"
                : "Sync subscription"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[200px_180px_1fr_auto]">
        <label className="text-sm font-medium text-slate-700">
          Plan
          <select
            value={planCode}
            onChange={(e) => setPlanCode(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          >
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} — {formatMoney(p.monthlyPriceCents)}/mo
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Custom monthly cents
          <input
            value={monthly}
            onChange={(e) => setMonthly(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="blank = catalog"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Notes
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          />
        </label>
        <button
          onClick={async () => {
            // Cost/proration preview before committing the plan change. A
            // custom monthly override skips the preview (it isn't catalog
            // priced); on a preview failure we still show a plain confirm so
            // a save never commits without acknowledgement.
            if (!monthly.trim()) {
              const planName =
                plans.find((p) => p.code === planCode)?.name ?? planCode;
              const who = tenant.storefrontName || tenant.name || tenant.slug;
              let message = `Switch ${who} to the ${planName} plan? This updates their Stripe billing.`;
              try {
                const preview = await previewTenantBillingChange(tenant.id, {
                  kind: "plan",
                  planCode,
                });
                message = buildPreviewConfirm(preview);
              } catch {
                // preview unavailable — keep the static fallback message
              }
              if (!window.confirm(message)) return;
            }
            savePlan.mutate();
          }}
          disabled={savePlan.isPending}
          className="self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {savePlan.isPending ? "Saving…" : "Save plan"}
        </button>
      </div>
      {message ? <p className="text-sm text-slate-600">{message}</p> : null}

      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          Edit add-ons ({tenant.billing.addons.length} active)
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {addons.map((addon) => {
            const qty = activeAddonQty.get(addon.code) ?? 0;
            return (
              <div
                key={addon.code}
                className="flex items-center justify-between gap-3 rounded-md bg-slate-50 p-3"
              >
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {addon.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {formatMoney(
                      addon.recurringPriceCents ?? addon.oneTimeMinCents,
                    )}{" "}
                    {addon.unitLabel ? `· ${addon.unitLabel}` : ""}
                  </div>
                  {addon.passThroughNote ? (
                    <div className="mt-1 text-xs text-amber-700">
                      {addon.passThroughNote}
                    </div>
                  ) : null}
                </div>
                <input
                  key={`${addon.code}:${qty}`}
                  aria-label={`${addon.name} quantity`}
                  defaultValue={qty}
                  type="number"
                  min={0}
                  step={1}
                  className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  onBlur={async (e) => {
                    // Normalize to a non-negative integer — the API schema
                    // expects an int, so an empty/decimal/NaN field would
                    // otherwise 400. Reflect the cleaned value back into the
                    // input so the UI matches what we'll send.
                    const parsed = Number(e.currentTarget.value);
                    const next = Number.isFinite(parsed)
                      ? Math.max(0, Math.floor(parsed))
                      : 0;
                    e.currentTarget.value = String(next);
                    if (next === qty) return;
                    // Cost/proration preview before committing the change; on
                    // a preview failure we still show a plain confirm so a
                    // save never commits without acknowledgement.
                    let message =
                      next === 0
                        ? `Remove ${addon.name} from this tenant?`
                        : `Set ${addon.name} to ${next} for this tenant?`;
                    try {
                      const preview = await previewTenantBillingChange(
                        tenant.id,
                        {
                          kind: "addon",
                          addonCode: addon.code,
                          quantity: next,
                        },
                      );
                      message = buildPreviewConfirm(preview);
                    } catch {
                      // preview unavailable — keep the static fallback message
                    }
                    if (!window.confirm(message)) return;
                    saveAddon.mutate({
                      addonCode: addon.code,
                      quantity: next,
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </details>
    </Card>
  );
}

const FIELD_CLASS =
  "w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-900";

// One editable plan card. View mode shows price + allowances; Edit mode
// exposes the base price, onboarding fee, public flag, allowances, and
// features. Saving populates every tenant account + the marketing page and
// (on a price change) re-mints the Stripe price server-side.
function PlanCatalogCard({ plan }: { plan: BillingPlan }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState(plan.name);
  const [monthly, setMonthly] = useState(
    centsToDollarInput(plan.monthlyPriceCents),
  );
  const [onboarding, setOnboarding] = useState(
    centsToDollarInput(plan.onboardingFeeCents),
  );
  const [isPublic, setIsPublic] = useState(plan.isPublic !== false);
  const [allowances, setAllowances] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(plan.allowances).map(([k, v]) => [k, String(v)]),
    ),
  );
  const [features, setFeatures] = useState(plan.features.join("\n"));

  // Re-derive the form from the current catalog values. Called on Cancel so
  // re-opening the editor never shows stale/unsaved edits.
  function resetForm() {
    setName(plan.name);
    setMonthly(centsToDollarInput(plan.monthlyPriceCents));
    setOnboarding(centsToDollarInput(plan.onboardingFeeCents));
    setIsPublic(plan.isPublic !== false);
    setAllowances(
      Object.fromEntries(
        Object.entries(plan.allowances).map(([k, v]) => [k, String(v)]),
      ),
    );
    setFeatures(plan.features.join("\n"));
  }

  const save = useMutation({
    mutationFn: (edit: CatalogPlanEdit) => updateCatalogPlan(plan.code, edit),
    onSuccess: (res) => {
      setMessage(
        res.affectedTenants
          ? `Saved. ${res.affectedTenants} tenant${res.affectedTenants === 1 ? "" : "s"} still bill the old price — use “Re-sync tenant subscriptions” above to roll it out in Stripe.`
          : "Saved.",
      );
      setEditing(false);
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) =>
      setMessage(err instanceof Error ? err.message : "Save failed."),
  });

  function onSave() {
    const monthlyCents = dollarInputToCents(monthly);
    const onboardingCents = dollarInputToCents(onboarding);
    if (monthlyCents === undefined || onboardingCents === undefined) {
      setMessage("Enter a valid dollar amount.");
      return;
    }
    const parsedAllowances: Record<string, number> = {};
    for (const [k, v] of Object.entries(allowances)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        setMessage(`Invalid allowance for ${METRIC_LABELS[k] ?? k}.`);
        return;
      }
      parsedAllowances[k] = Math.round(n);
    }
    save.mutate({
      name: name.trim() || plan.name,
      monthlyPriceCents: monthlyCents,
      onboardingFeeCents: onboardingCents,
      isPublic,
      allowances: parsedAllowances,
      features: features
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-slate-950">{plan.name}</div>
          <div className="text-xs text-slate-500">{plan.description}</div>
        </div>
        <div className="text-right text-sm font-semibold text-slate-900">
          {plan.isCustom && plan.monthlyPriceCents == null
            ? "Custom"
            : `${formatMoney(plan.monthlyPriceCents)}/mo`}
          <div className="text-[11px] font-normal text-slate-500">
            {plan.stripePriceId ? "Stripe synced" : "No Stripe price"}
          </div>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <label className="block text-[11px] font-medium text-slate-600">
            Name
            <input
              className={FIELD_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] font-medium text-slate-600">
              Monthly price ($)
              <input
                className={FIELD_CLASS}
                inputMode="decimal"
                value={monthly}
                placeholder="0 = free"
                onChange={(e) => setMonthly(e.target.value)}
              />
            </label>
            <label className="block text-[11px] font-medium text-slate-600">
              Onboarding fee ($)
              <input
                className={FIELD_CLASS}
                inputMode="decimal"
                value={onboarding}
                placeholder="blank = none"
                onChange={(e) => setOnboarding(e.target.value)}
              />
            </label>
          </div>
          {Object.keys(allowances).length > 0 ? (
            <div>
              <div className="text-[11px] font-medium text-slate-600">
                Allowances
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {Object.entries(allowances).map(([key, value]) => (
                  <label key={key} className="block text-[10px] text-slate-500">
                    {METRIC_LABELS[key] ?? key}
                    <input
                      className={FIELD_CLASS}
                      inputMode="numeric"
                      value={value}
                      onChange={(e) =>
                        setAllowances((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <label className="block text-[11px] font-medium text-slate-600">
            Features (one per line)
            <textarea
              className={`${FIELD_CLASS} h-20`}
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            Public (self-selectable + shown on the marketing page)
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={onSave}
              disabled={save.isPending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                resetForm();
                setEditing(false);
                setMessage(null);
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-1 text-xs text-slate-600">
            {Object.entries(plan.allowances)
              .slice(0, 5)
              .map(([key, value]) => (
                <li key={key}>
                  {METRIC_LABELS[key] ?? key}: {value.toLocaleString()}
                </li>
              ))}
          </ul>
          <button
            onClick={() => setEditing(true)}
            className="mt-3 text-xs font-semibold text-slate-700 underline"
          >
            Edit pricing
          </button>
        </>
      )}
      {message ? (
        <p className="mt-2 text-[11px] text-slate-600">{message}</p>
      ) : null}
    </div>
  );
}

// One editable add-on row: recurring price + unit label + active flag.
function AddonCatalogRow({ addon }: { addon: BillingAddon }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState(addon.name);
  const [recurring, setRecurring] = useState(
    centsToDollarInput(addon.recurringPriceCents),
  );
  const [unitLabel, setUnitLabel] = useState(addon.unitLabel ?? "");
  const [isActive, setIsActive] = useState(addon.isActive !== false);

  // Re-derive the form from the current catalog values, so Cancel + re-open
  // never shows stale/unsaved edits.
  function resetForm() {
    setName(addon.name);
    setRecurring(centsToDollarInput(addon.recurringPriceCents));
    setUnitLabel(addon.unitLabel ?? "");
    setIsActive(addon.isActive !== false);
  }

  const save = useMutation({
    mutationFn: (edit: CatalogAddonEdit) =>
      updateCatalogAddon(addon.code, edit),
    onSuccess: (res) => {
      setMessage(
        res.affectedTenants
          ? `Saved. ${res.affectedTenants} tenant${res.affectedTenants === 1 ? "" : "s"} still bill the old price — use “Re-sync tenant subscriptions” above to roll it out in Stripe.`
          : "Saved.",
      );
      setEditing(false);
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) =>
      setMessage(err instanceof Error ? err.message : "Save failed."),
  });

  function onSave() {
    const recurringCents = dollarInputToCents(recurring);
    if (recurringCents === undefined) {
      setMessage("Enter a valid dollar amount.");
      return;
    }
    save.mutate({
      name: name.trim() || addon.name,
      recurringPriceCents: recurringCents,
      unitLabel: unitLabel.trim() || null,
      isActive,
    });
  }

  const priceLabel =
    addon.recurringPriceCents != null
      ? `${formatMoney(addon.recurringPriceCents)}/mo`
      : addon.oneTimeMinCents != null
        ? `${formatMoney(addon.oneTimeMinCents)}–${formatMoney(addon.oneTimeMaxCents)} one-time`
        : "—";

  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900">
            {addon.name}
            {addon.isActive === false ? (
              <span className="ml-2 text-[10px] font-normal text-amber-600">
                inactive
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-slate-500">
            {priceLabel}
            {addon.unitLabel ? ` · ${addon.unitLabel}` : ""}
          </div>
        </div>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 text-[11px] font-semibold text-slate-700 underline"
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[10px] text-slate-500">
              Name
              <input
                className={FIELD_CLASS}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-[10px] text-slate-500">
              Recurring price ($/mo)
              <input
                className={FIELD_CLASS}
                inputMode="decimal"
                value={recurring}
                placeholder="blank = none"
                onChange={(e) => setRecurring(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-[10px] text-slate-500">
            Unit label
            <input
              className={FIELD_CLASS}
              value={unitLabel}
              onChange={(e) => setUnitLabel(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={onSave}
              disabled={save.isPending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                resetForm();
                setEditing(false);
                setMessage(null);
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="mt-1 text-[11px] text-slate-600">{message}</p>
      ) : null}
    </div>
  );
}

function CatalogPreview({
  plans,
  addons,
}: {
  plans: BillingPlan[];
  addons: BillingAddon[];
}) {
  const qc = useQueryClient();
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const syncCatalog = useMutation({
    mutationFn: syncPlatformBillingCatalogToStripe,
    onSuccess: (result) => {
      setCatalogMessage(
        `Stripe catalog synced: ${result.catalog?.plans ?? 0} plans and ${
          result.catalog?.addons ?? 0
        } add-ons.`,
      );
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setCatalogMessage(
        err instanceof Error ? err.message : "Stripe catalog sync failed.",
      );
    },
  });
  const resyncTenants = useMutation({
    mutationFn: resyncTenantStripeSubscriptions,
    onSuccess: (r) => {
      setCatalogMessage(
        `Re-synced ${r.synced}/${r.total} tenant subscription${
          r.total === 1 ? "" : "s"
        }${r.failed ? `, ${r.failed} failed` : ""}.`,
      );
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setCatalogMessage(
        err instanceof Error ? err.message : "Tenant re-sync failed.",
      );
    },
  });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-950">Billing catalog</h2>
          <p className="text-xs text-slate-500">
            Edit base plan &amp; add-on pricing here. Changes populate to every
            tenant account, the public pricing page, and Stripe. Existing tenant
            subscriptions keep the old price until you re-sync them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => resyncTenants.mutate()}
            disabled={resyncTenants.isPending}
            className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
            title="Roll the current catalog pricing out to every tenant's live Stripe subscription"
          >
            {resyncTenants.isPending
              ? "Re-syncing…"
              : "Re-sync tenant subscriptions"}
          </button>
          <button
            onClick={() => syncCatalog.mutate()}
            disabled={syncCatalog.isPending}
            className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          >
            {syncCatalog.isPending
              ? "Syncing Stripe…"
              : "Sync catalog to Stripe"}
          </button>
        </div>
      </div>
      {catalogMessage ? (
        <p className="mt-2 text-sm text-slate-600">{catalogMessage}</p>
      ) : null}
      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        {plans.map((plan) => (
          <PlanCatalogCard key={plan.code} plan={plan} />
        ))}
      </div>
      <div className="mt-5">
        <h3 className="text-sm font-semibold text-slate-900">
          Add-ons ({addons.length})
        </h3>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {addons.map((addon) => (
            <AddonCatalogRow key={addon.code} addon={addon} />
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Recent tenant-billing changes across the fleet — surfaces the
 *  tenant.billing.* / platform.billing.* events the logAudit stub can't show.
 *  Polls every 60s; degrades to a quiet empty/error state. */
function RecentBillingActivity({
  tenants,
}: {
  tenants: Array<{ id: string; label: string }>;
}) {
  const [tenantId, setTenantId] = useState<string>("");
  const activity = useQuery({
    queryKey: ["platform-billing", "activity", tenantId || "all"],
    queryFn: () => fetchPlatformBillingActivity(25, tenantId || undefined),
    refetchInterval: 60_000,
  });
  return (
    <Card className="p-5" data-testid="platform-billing-activity">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-950">
            Recent billing activity
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Plan and add-on changes across every tenant — who changed what, and
            when. Self-service tenant changes and super-admin assignments both
            show here.
          </p>
        </div>
        <label className="text-sm text-slate-600">
          <span className="sr-only">Filter by tenant</span>
          <select
            data-testid="activity-tenant-filter"
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          >
            <option value="">All tenants</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {activity.isPending ? (
        <div className="mt-4">
          <Spinner label="Loading activity…" />
        </div>
      ) : activity.isError ? (
        <p className="mt-4 text-sm text-slate-500">
          Could not load billing activity.
        </p>
      ) : activity.data.activity.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          {tenantId
            ? "No billing changes for this tenant yet."
            : "No billing changes yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {activity.data.activity.map((e: BillingActivityEvent) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <span className="font-medium text-slate-900">
                  {e.tenantName}
                </span>
                <span className="text-slate-600">
                  {" "}
                  — {e.summary ?? e.action}
                </span>
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    e.actor === "tenant"
                      ? "bg-sky-50 text-sky-700"
                      : "bg-violet-50 text-violet-700"
                  }`}
                >
                  {e.actor === "tenant" ? "self-service" : "super-admin"}
                </span>
              </div>
              <div className="text-right text-xs text-slate-500">
                <div>{e.operatorEmail ?? "—"}</div>
                <time dateTime={e.occurredAt}>
                  {formatAppDateTime(e.occurredAt)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AdminPlatformBillingPage() {
  const catalog = useQuery({
    queryKey: ["platform-billing", "catalog"],
    queryFn: fetchPlatformBillingCatalog,
  });
  const tenants = useQuery({
    queryKey: ["platform-billing", "tenants"],
    queryFn: fetchPlatformTenantBilling,
  });
  const addons = useMemo(() => catalog.data?.addons ?? [], [catalog.data]);
  const plans = useMemo(() => catalog.data?.plans ?? [], [catalog.data]);

  if (catalog.isPending || tenants.isPending)
    return <Spinner label="Loading platform billing…" />;
  if (catalog.isError)
    return (
      <ErrorPanel
        title="Could not load billing catalog"
        error={catalog.error}
      />
    );
  if (tenants.isError)
    return (
      <ErrorPanel title="Could not load tenant billing" error={tenants.error} />
    );

  const tenantRows = tenants.data.tenants.map((tenant) => {
    const status = allowanceStatus(tenant);
    const addonsTotal = tenant.billing.addons.reduce((sum, a) => {
      const price =
        a.customRecurringPriceCents ?? a.addon.recurringPriceCents ?? 0;
      return sum + price * a.quantity;
    }, 0);
    return { tenant, status, addonsTotal };
  });
  const mrr = tenantRows.reduce((sum, row) => {
    const sub = row.tenant.billing.subscription;
    return (
      sum +
      (sub?.customMonthlyPriceCents ?? sub?.plan.monthlyPriceCents ?? 0) +
      row.addonsTotal
    );
  }, 0);
  const overLimitTenants = tenantRows.filter(
    (r) => r.status.overLimit.length > 0,
  ).length;
  const nearLimitTenants = tenantRows.filter(
    (r) => r.status.nearLimit.length > 0,
  ).length;

  return (
    <div data-testid="admin-platform-billing" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-950">Platform billing</h1>
        <p className="text-sm text-slate-600">
          Super-admin package assignment, add-ons, pricing overrides, and tenant
          usage tracking.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="p-4">
          <div className="text-sm text-slate-500">Estimated MRR</div>
          <div className="text-2xl font-bold">{formatMoney(mrr)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Tenants</div>
          <div className="text-2xl font-bold">
            {tenants.data.tenants.length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Over limit</div>
          <div className="text-2xl font-bold text-red-700">
            {overLimitTenants}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Near limit</div>
          <div className="text-2xl font-bold text-amber-700">
            {nearLimitTenants}
          </div>
        </Card>
      </div>
      <RecentBillingActivity
        tenants={tenantRows.map(({ tenant }) => ({
          id: tenant.id,
          label:
            tenant.storefrontName || tenant.name || tenant.slug || tenant.id,
        }))}
      />
      <CatalogPreview plans={plans} addons={addons} />
      {tenantRows.map(({ tenant }) => (
        <TenantEditor
          key={tenant.id}
          tenant={tenant}
          plans={plans}
          addons={addons}
        />
      ))}
    </div>
  );
}

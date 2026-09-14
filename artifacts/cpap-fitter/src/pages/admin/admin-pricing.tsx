import { PricingBulkPatientReviewsPanel } from "@/components/admin/pricing/PricingBulkPatientReviewsPanel";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetAdminMe } from "@workspace/api-client-react/admin";
import {
  Calculator,
  ClipboardCheck,
  Layers3,
  PackageSearch,
  Settings2,
  Truck,
} from "lucide-react";
import { Link } from "wouter";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  getPricingState,
  pricingKey,
  type Scenario,
} from "@/lib/admin/pricing-api";
import { PricingAlertsPanel } from "@/components/admin/pricing/PricingAlertsPanel";
import { PricingRevenueProfilesPanel } from "@/components/admin/pricing/PricingRevenueProfilesPanel";
import { PricingItemReview } from "@/components/admin/pricing/PricingItemReview";
import { PricingPolicyPanel } from "@/components/admin/pricing/PricingPolicyPanel";
import { PricingOffersPanel } from "@/components/admin/pricing/PricingOffersPanel";
import {
  PricingBatchesPanel,
  PricingQuotesPanel,
} from "@/components/admin/pricing/PricingReviewsPanel";
import { PricingProposalsPanel } from "@/components/admin/pricing/PricingProposalsPanel";
import { PricingMetric } from "@/components/admin/pricing/PricingPrimitives";
const tabs = [
  {
    id: "patient-reviews",
    label: "Patient batch review",
    icon: ClipboardCheck,
  },
  { id: "review", label: "Item review", icon: Calculator },
  { id: "offers", label: "Supplier costs", icon: Truck },
  { id: "proposals", label: "New items", icon: PackageSearch },
  { id: "quotes", label: "Reviews & actuals", icon: ClipboardCheck },
  { id: "batches", label: "Bulk prices", icon: Layers3 },
  { id: "collections", label: "Collection evidence", icon: ClipboardCheck },
  { id: "alerts", label: "Follow-up", icon: ClipboardCheck },
  { id: "policy", label: "Pricing policy", icon: Settings2 },
] as const;
export function AdminPricingPage() {
  const me = useGetAdminMe();
  if (me.isPending) return <p role="status">Loading pricing access…</p>;
  if (me.error)
    return <ErrorPanel error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data?.permissions?.includes("pricing.evaluate"))
    return (
      <div
        role="alert"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        Your role does not have pricing access.
      </div>
    );
  return (
    <PricingWorkspace
      key={`${me.data.userId}:${me.data.permissions.join(",")}`}
      permissions={me.data.permissions}
    />
  );
}
function PricingWorkspace({ permissions }: { permissions: string[] }) {
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>(
      permissions.includes("pricing.manage") ? "batches" : "review",
    ),
    [scenarios, setScenarios] = useState<Scenario[]>([]),
    [batchNotice, setBatchNotice] = useState("");
  const [reviewItem, setReviewItem] = useState<{
    key: number;
    sku: string;
    name: string;
  } | null>(null);
  const state = useQuery({
    queryKey: [...pricingKey, "state"],
    queryFn: getPricingState,
  });
  const canManage = permissions.includes("pricing.manage"),
    canApprove = permissions.includes("pricing.approve"),
    canPublish = permissions.includes("pricing.publish");
  return (
    <div className="admin-root mx-auto max-w-7xl space-y-6 p-1 md:p-2">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            CareMetric Breathe
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Pricing & Profitability
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Know the delivered cost, review expected profit, and keep each order
            within your approved pricing policy.
          </p>
        </div>
        <div className="flex gap-4 text-sm font-medium">
          <Link
            className="text-slate-700 underline underline-offset-4"
            href="/admin/catalog"
          >
            Product catalog
          </Link>
          <Link
            className="text-slate-700 underline underline-offset-4"
            href="/admin/orders"
          >
            Orders
          </Link>
        </div>
      </header>
      {state.error ? (
        <ErrorPanel error={state.error} onRetry={() => void state.refetch()} />
      ) : state.isPending ? (
        <p role="status">Loading pricing policy…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <PricingMetric
              label="Current policy"
              value={state.data.policy?.name ?? "Set your policy"}
              detail={
                state.data.enabled ? "Enabled for new reviews" : "Not enabled"
              }
            />
            <PricingMetric
              label="Target margin"
              value={
                state.data.policy
                  ? `${state.data.policy.rules.targetMarginBps / 100}%`
                  : "Not configured"
              }
              detail={
                state.data.policy
                  ? `Floor ${state.data.policy.rules.floorMarginBps / 100}%`
                  : "Enter your business target; no default is assumed"
              }
            />
            <PricingMetric
              label="Patient order review"
              value={state.data.enforceQuotes ? "Required" : "Optional"}
              detail={
                state.data.enforceQuotes
                  ? "Approved insurance review required"
                  : "Unreviewed legacy orders remain available"
              }
            />
          </div>
          <nav
            aria-label="Pricing workspace"
            className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1.5"
          >
            {tabs
              .filter((t) => t.id !== "batches" || canManage || canPublish)
              .filter((t) => t.id !== "alerts" || canManage)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-current={tab === t.id ? "page" : undefined}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 ${tab === t.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  onClick={() => setTab(t.id)}
                >
                  <t.icon className="h-4 w-4" aria-hidden="true" />
                  {t.label}
                  {t.id === "batches" && scenarios.length > 0 && (
                    <span className="rounded bg-slate-200 px-1.5 text-xs text-slate-800">
                      {scenarios.length}
                    </span>
                  )}
                </button>
              ))}
          </nav>
          {batchNotice && (
            <p role="status" className="text-sm text-emerald-800">
              {batchNotice}
            </p>
          )}
          {
            <div hidden={tab !== "review"}>
              <PricingItemReview
                key={reviewItem?.key ?? "initial"}
                initialLines={
                  reviewItem
                    ? [
                        {
                          sku: reviewItem.sku,
                          description: reviewItem.name,
                          quantity: 1,
                          unitAmountCents: null,
                        },
                      ]
                    : undefined
                }
                canVerify={canManage}
                onAddToBatch={
                  canManage || canPublish
                    ? (scenario) => {
                        setScenarios((old) => [...old, scenario]);
                        setBatchNotice(
                          "Scenario added. Open Bulk prices to review and activate the selection.",
                        );
                      }
                    : undefined
                }
              />
            </div>
          }
          {tab === "patient-reviews" && <PricingBulkPatientReviewsPanel />}
          {tab === "alerts" && canManage && (
            <PricingAlertsPanel canManage={canManage} />
          )}{" "}
          {tab === "collections" && (
            <PricingRevenueProfilesPanel canManage={canManage} />
          )}
          {tab === "offers" && <PricingOffersPanel canManage={canManage} />}
          {tab === "proposals" && (
            <PricingProposalsPanel canManage={canManage} />
          )}
          {tab === "quotes" && (
            <PricingQuotesPanel canManage={canManage} canApprove={canApprove} />
          )}
          {(canManage || canPublish) && (
            <div hidden={tab !== "batches"}>
              <PricingBatchesPanel
                scenarios={scenarios}
                onClear={() => {
                  setScenarios([]);
                  setBatchNotice("");
                }}
                state={state.data}
                canPublish={canPublish}
                canManage={canManage}
                onReviewItem={(item) => {
                  setReviewItem((old) => ({
                    ...item,
                    key: (old?.key ?? 0) + 1,
                  }));
                  setTab("review");
                }}
              />
            </div>
          )}
          {tab === "policy" && (
            <PricingPolicyPanel
              state={state.data}
              canManage={canManage}
              canPublish={canPublish}
            />
          )}
        </>
      )}
    </div>
  );
}

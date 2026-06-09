// /admin/bulk-campaigns — staging surface for bulk-email campaigns.
//
// Phase A: a CSR composes the audience + selects a template +
// previews the resolved recipient counts, then either saves the
// draft (which persists the recipients snapshot) or cancels.
// Phase B will add the "Start sending" button + worker integration.
//
// The form is intentionally permissive — server-side validation
// rejects the bad shapes (missing payer for by_patient_payer,
// missing compliance attestation for category=compliance, unknown
// template key). The UI surfaces those 400 responses inline.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Megaphone, Plus } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { AdminModal } from "@/components/admin/AdminModal";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  cancelBulkCampaign,
  createBulkCampaignDraft,
  getBulkCampaign,
  listBulkCampaigns,
  pauseBulkCampaign,
  resumeBulkCampaign,
  startBulkCampaign,
  TICK_INTERVAL_SECONDS,
  type AudienceKind,
  type BulkCampaignDetail,
  type BulkCampaignListItem,
  type CampaignStatus,
  type Category,
  type CreateDraftRequest,
} from "@/lib/admin/bulk-campaigns-api";

const listQueryKey = ["admin", "bulk-campaigns"] as const;

export function AdminBulkCampaignsPage() {
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: listQueryKey,
    queryFn: listBulkCampaigns,
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Megaphone className="h-6 w-6" />
            Bulk campaigns
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Compose audience + template + preview recipient counts. Phase A
            persists the draft; Phase B will add the worker that actually sends.
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New campaign
        </Button>
      </header>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.campaigns.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No campaigns yet. Click <strong>New campaign</strong> to compose
            one.
          </p>
        ) : (
          <CampaignsTable rows={data.campaigns} onSelect={setOpenId} />
        )}
      </Card>

      {showNew && (
        <NewCampaignModal
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            setOpenId(id);
          }}
        />
      )}
      {openId && (
        <CampaignDetailModal id={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

const STATUS_COLOR: Record<CampaignStatus, string> = {
  draft: "bg-blue-100 text-blue-900",
  sending: "bg-amber-100 text-amber-900",
  sent: "bg-emerald-100 text-emerald-900",
  paused: "bg-orange-100 text-orange-900",
  cancelled: "bg-gray-100 text-gray-700",
};

const AUDIENCE_LABEL: Record<AudienceKind, string> = {
  all_active_shop_customers: "All shop customers",
  all_active_patients: "All active patients",
  by_patient_payer: "Patients by payer",
  manual_list: "Manual list",
};

const CATEGORY_LABEL: Record<Category, string> = {
  marketing: "Marketing",
  service: "Service",
  compliance: "Compliance / recall",
};

function CampaignsTable({
  rows,
  onSelect,
}: {
  rows: BulkCampaignListItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Name</th>
          <th className="py-2 font-semibold">Audience</th>
          <th className="py-2 font-semibold">Category</th>
          <th className="py-2 font-semibold text-right">Total</th>
          <th className="py-2 font-semibold text-right">Pending</th>
          <th className="py-2 font-semibold text-right">Suppressed</th>
          <th className="py-2 font-semibold">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className="border-b cursor-pointer hover:bg-[hsl(var(--bg-2))]"
            style={{ borderColor: "hsl(var(--line-2))" }}
            onClick={() => onSelect(r.id)}
          >
            <td className="py-1.5">
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-muted-foreground">
                {r.templateKey}
              </div>
            </td>
            <td className="py-1.5 text-xs">
              {AUDIENCE_LABEL[r.audienceKind]}
              {r.audiencePayer && (
                <span className="text-muted-foreground">
                  {" "}
                  · {r.audiencePayer}
                </span>
              )}
            </td>
            <td className="py-1.5 text-xs">{CATEGORY_LABEL[r.category]}</td>
            <td className="py-1.5 text-right tabular-nums">
              {r.totalRecipients}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {r.pendingRecipients}
            </td>
            <td className="py-1.5 text-right tabular-nums text-muted-foreground">
              {r.suppressedCount}
            </td>
            <td className="py-1.5">
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[r.status]}`}
              >
                {r.status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── New-campaign modal ─────────────────────────────────────────────

function NewCampaignModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [audienceKind, setAudienceKind] = useState<AudienceKind>(
    "all_active_shop_customers",
  );
  const [audiencePayer, setAudiencePayer] = useState("");
  const [category, setCategory] = useState<Category>("marketing");
  const [complianceAttestation, setComplianceAttestation] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [throttle, setThrottle] = useState(120);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateDraftRequest = {
        name: name.trim(),
        audienceKind,
        audiencePayer:
          audienceKind === "by_patient_payer"
            ? audiencePayer.trim() || null
            : null,
        category,
        complianceAttestation:
          category === "compliance"
            ? complianceAttestation.trim() || null
            : null,
        templateKey: templateKey.trim(),
        throttlePerMinute: throttle,
      };
      return createBulkCampaignDraft(body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: listQueryKey });
      onCreated(r.id);
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSave =
    name.trim().length > 0 &&
    templateKey.trim().length > 0 &&
    (audienceKind !== "by_patient_payer" || audiencePayer.trim().length > 0) &&
    (category !== "compliance" || complianceAttestation.trim().length >= 10);

  return (
    <ModalShell title="New bulk campaign" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>Campaign name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="May resupply reminder push"
            maxLength={200}
            aria-label="Campaign name"
          />
        </div>

        <div>
          <Label>Audience</Label>
          <select
            value={audienceKind}
            onChange={(e) => setAudienceKind(e.target.value as AudienceKind)}
            aria-label="Audience"
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="all_active_shop_customers">
              All shop customers
            </option>
            <option value="all_active_patients">All active patients</option>
            <option value="by_patient_payer">
              Patients by insurance payer
            </option>
            <option value="manual_list">Manual list (Phase B)</option>
          </select>
        </div>

        {audienceKind === "by_patient_payer" && (
          <div>
            <Label>Payer</Label>
            <Input
              value={audiencePayer}
              onChange={(e) => setAudiencePayer(e.target.value)}
              placeholder="Medicare, Aetna, …"
              maxLength={120}
              aria-label="Payer"
            />
          </div>
        )}

        <div>
          <Label>Category</Label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            aria-label="Category"
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="marketing">Marketing</option>
            <option value="service">Service</option>
            <option value="compliance">Compliance / recall</option>
          </select>
        </div>

        <div>
          <Label>Throttle / minute</Label>
          <Input
            type="number"
            value={throttle.toString()}
            onChange={(e) => setThrottle(Number(e.target.value) || 0)}
            min={1}
            max={3600}
            aria-label="Throttle per minute"
          />
        </div>

        <div className="col-span-2">
          <Label>Template key</Label>
          <Input
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            placeholder="bulk_marketing_may_2026"
            maxLength={120}
            aria-label="Template key"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            From the Message Templates library — must already exist and be
            active.
          </p>
        </div>

        {category === "compliance" && (
          <div className="col-span-2">
            <Label>Compliance attestation (≥ 10 chars)</Label>
            <textarea
              value={complianceAttestation}
              onChange={(e) => setComplianceAttestation(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{ borderColor: "hsl(var(--line-1))" }}
              placeholder="FDA Class II recall — Philips DreamStation foam degradation. Recipients are notified per 21 CFR 806; marketing opt-out does not apply."
              aria-label="Compliance attestation"
            />
            <p className="text-[10px] text-rose-700 mt-1">
              Compliance-category campaigns bypass marketing opt-out. The
              attestation is logged with the campaign.
            </p>
          </div>
        )}
      </div>

      <ModalFooter
        onCancel={onClose}
        onSave={() => create.mutate()}
        saving={create.isPending}
        canSave={canSave}
        error={error}
        saveLabel="Resolve audience + save draft"
      />
    </ModalShell>
  );
}

// ── Detail modal ───────────────────────────────────────────────────

function CampaignDetailModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const detailKey = ["admin", "bulk-campaigns", id] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: detailKey,
    queryFn: () => getBulkCampaign(id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: listQueryKey });
    void qc.invalidateQueries({ queryKey: detailKey });
  };

  const start = useMutation({
    mutationFn: () => startBulkCampaign(id),
    onSuccess: invalidate,
  });
  const pause = useMutation({
    mutationFn: () => pauseBulkCampaign(id),
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: () => resumeBulkCampaign(id),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => cancelBulkCampaign(id),
    onSuccess: invalidate,
  });

  // Starting a campaign fires real SMS/email to every resolved
  // recipient — irreversible once sending begins — so it gates behind
  // an explicit confirm naming the recipient count. Cancel is likewise
  // guarded (a half-sent campaign can't be un-cancelled). Pause/Resume
  // are reversible and fire immediately.
  const confirmStart = async () => {
    const total = data?.totalRecipients ?? 0;
    if (
      !(await confirm({
        title: "Start sending this campaign?",
        description: `This will begin sending to ${total.toLocaleString()} recipient${
          total === 1 ? "" : "s"
        } via SMS/email. Once sending starts it can be paused but messages already sent cannot be recalled.`,
        confirmLabel: "Start sending",
      }))
    ) {
      return;
    }
    start.mutate();
  };
  const confirmCancel = async () => {
    if (
      !(await confirm({
        title: "Cancel this campaign?",
        description:
          "No further messages will be sent. Recipients already contacted are not affected. This cannot be undone.",
        confirmLabel: "Cancel campaign",
        cancelLabel: "Keep campaign",
        destructive: true,
      }))
    ) {
      return;
    }
    cancel.mutate();
  };

  const anyPending =
    start.isPending || pause.isPending || resume.isPending || cancel.isPending;
  const actionError =
    start.error?.message ??
    pause.error?.message ??
    resume.error?.message ??
    cancel.error?.message ??
    null;

  return (
    <ModalShell title="Campaign detail" onClose={onClose}>
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <CampaignDetailBody
          data={data}
          actionsPending={anyPending}
          actionError={actionError}
          onStart={() => void confirmStart()}
          onPause={() => pause.mutate()}
          onResume={() => resume.mutate()}
          onCancel={() => void confirmCancel()}
        />
      )}
      <div className="flex justify-end pt-3 border-t border-border/40">
        <Button intent="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {ConfirmDialogEl}
    </ModalShell>
  );
}

function CampaignDetailBody({
  data,
  actionsPending,
  actionError,
  onStart,
  onPause,
  onResume,
  onCancel,
}: {
  data: BulkCampaignDetail;
  actionsPending: boolean;
  actionError: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[data.status]}`}
        >
          {data.status}
        </span>
        <strong>{data.name}</strong>
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <Stat label="Total" value={data.totalRecipients.toLocaleString()} />
        <Stat
          label="Pending"
          value={(
            data.totalRecipients -
            data.suppressedCount -
            data.sentCount -
            data.failedCount
          ).toLocaleString()}
        />
        <Stat
          label="Suppressed"
          value={data.suppressedCount.toLocaleString()}
        />
      </div>

      <dl className="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
        <KV k="Audience" v={AUDIENCE_LABEL[data.audienceKind]} />
        {data.audiencePayer && <KV k="Payer" v={data.audiencePayer} />}
        <KV k="Category" v={CATEGORY_LABEL[data.category]} />
        <KV k="Template" v={data.templateKey} />
        <KV k="Throttle / min" v={String(data.throttlePerMinute)} />
        <KV k="Created" v={new Date(data.createdAt).toLocaleString()} />
      </dl>

      {data.complianceAttestation && (
        <div
          className="rounded border p-3 text-xs"
          style={{
            borderColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-2))",
          }}
        >
          <strong>Compliance attestation:</strong> {data.complianceAttestation}
        </div>
      )}

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 text-muted-foreground">
          Recipient preview (first 200, suppressed first)
        </h3>
        {data.recipients.length === 0 ? (
          <p className="text-sm py-2" style={{ color: "hsl(var(--ink-3))" }}>
            No recipients resolved.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr
                className="text-left border-b"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <th className="py-1.5">Kind</th>
                <th className="py-1.5">Recipient</th>
                <th className="py-1.5">Email</th>
                <th className="py-1.5">Status</th>
                <th className="py-1.5">Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.recipients.map((r) => (
                <tr
                  key={r.id}
                  className="border-b"
                  style={{ borderColor: "hsl(var(--line-2))" }}
                >
                  <td className="py-1">{r.recipientKind}</td>
                  <td className="py-1 font-mono text-[10px]">
                    {r.recipientKind === "patient" ? (
                      <Link
                        href={`/admin/patients/${r.recipientId}`}
                        className="text-[hsl(var(--penn-navy))] hover:underline"
                      >
                        {r.recipientId.slice(0, 8)}
                      </Link>
                    ) : (
                      <Link
                        href={`/admin/shop/customers/${r.recipientId}`}
                        className="text-[hsl(var(--penn-navy))] hover:underline"
                      >
                        {r.recipientId.slice(0, 8)}
                      </Link>
                    )}
                  </td>
                  <td className="py-1">{r.recipientEmail ?? "—"}</td>
                  <td className="py-1">{r.status}</td>
                  <td className="py-1 text-muted-foreground">
                    {r.suppressionReason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2">
          <a
            href={`/resupply-api/admin/bulk-campaigns/${data.id}/recipients.csv`}
            className="inline-block rounded border px-3 py-1 text-xs font-semibold"
            style={{
              borderColor: "hsl(var(--line-1))",
              color: "hsl(var(--penn-navy))",
            }}
          >
            Download recipients CSV
          </a>
        </div>
      </div>

      {(data.status === "draft" ||
        data.status === "sending" ||
        data.status === "paused") && (
        <div className="pt-3 border-t border-border/40 space-y-2">
          {actionError && (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {actionError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {data.status === "draft" && (
              <Button
                onClick={onStart}
                disabled={actionsPending}
                isLoading={actionsPending}
              >
                Start sending
              </Button>
            )}
            {data.status === "sending" && (
              <Button
                intent="secondary"
                onClick={onPause}
                disabled={actionsPending}
                isLoading={actionsPending}
              >
                Pause
              </Button>
            )}
            {data.status === "paused" && (
              <Button
                onClick={onResume}
                disabled={actionsPending}
                isLoading={actionsPending}
              >
                Resume
              </Button>
            )}
            <Button intent="ghost" onClick={onCancel} disabled={actionsPending}>
              Cancel campaign
            </Button>
          </div>
          {data.status === "sending" && (
            <p className="text-[10px] text-muted-foreground">
              Pause / cancel takes effect within {TICK_INTERVAL_SECONDS} seconds
              (next tick).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// ── modal primitives ───────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="text-xs font-semibold block mb-1"
      style={{ color: "hsl(var(--penn-navy))" }}
    >
      {children}
    </label>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Delegates to the shared AdminModal (Radix): Escape-to-close, focus
  // trap, scroll lock, and aria-modal for free — the hand-rolled version
  // had none of those.
  return (
    <AdminModal title={title} onClose={onClose} className="max-w-3xl">
      <div className="space-y-4">{children}</div>
    </AdminModal>
  );
}

function ModalFooter({
  onCancel,
  onSave,
  saving,
  canSave,
  error,
  saveLabel,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  error: string | null;
  saveLabel?: string;
}) {
  return (
    <>
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
        <Button intent="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canSave || saving}
          onClick={onSave}
          isLoading={saving}
        >
          {saveLabel ?? "Save"}
        </Button>
      </div>
    </>
  );
}

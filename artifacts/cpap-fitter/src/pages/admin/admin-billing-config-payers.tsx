// /admin/billing/config/payers — Pennsylvania payer-profile catalog.
//
// Filters: region, LOB, active flag, name search. The PA payer list
// drives every other config table (fee schedules, modifier rules,
// claim templates all carry a payer_profile_id). Make this list
// browseable so an operator can confirm "yes, we have UPMC" before
// staging a fee-schedule import.
//
// 0149 additions: each row opens an edit drawer (PATCH) with every
// submission-readiness field — claims address, timely filing,
// prior-auth submission channel, required modifiers, EDI enrollment
// status, member-ID hint — so an op can keep the catalog clean
// without a deploy. "Add payer" opens the same drawer in create
// mode. "Download OA enrollment CSV" exports the catalog in Office
// Ally's enrollment-review column order.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  createPayerProfile,
  fetchPayerProfiles,
  officeAllyExportCsvHref,
  updatePayerProfile,
  type PayerClaimFormat,
  type PayerEdiEnrollmentStatus,
  type PayerLineOfBusiness,
  type PayerPaSubmissionMethod,
  type PayerProfile,
  type PayerProfilePatch,
  type PayerProfileUpsert,
  type PayerRegion,
} from "@/lib/admin/billing-config-api";

const LOB_OPTIONS: Array<{ value: PayerLineOfBusiness; label: string }> = [
  { value: "commercial", label: "Commercial" },
  { value: "medicare_advantage", label: "Medicare Advantage" },
  { value: "medicare_part_b", label: "Medicare Part B" },
  { value: "medicaid_ffs", label: "Medicaid FFS" },
  { value: "medicaid_mco", label: "Medicaid MCO" },
  { value: "federal", label: "Federal" },
  { value: "workers_comp", label: "Workers' Comp" },
  { value: "other", label: "Other" },
];

const REGION_OPTIONS: Array<{ value: PayerRegion; label: string }> = [
  { value: "pa", label: "PA" },
  { value: "multi_state", label: "Multi-state" },
  { value: "national", label: "National" },
];

const CLAIM_FORMAT_OPTIONS: Array<{ value: PayerClaimFormat; label: string }> =
  [
    { value: "837p", label: "837P (professional)" },
    { value: "837i", label: "837I (institutional)" },
    { value: "paper_1500", label: "Paper HCFA-1500" },
  ];

const PA_METHOD_OPTIONS: Array<{
  value: PayerPaSubmissionMethod;
  label: string;
}> = [
  { value: "portal", label: "Portal" },
  { value: "fax", label: "Fax" },
  { value: "phone", label: "Phone" },
  { value: "electronic_278", label: "Electronic 278" },
  { value: "paper", label: "Paper" },
  { value: "none", label: "Not required" },
];

const EDI_ENROLLMENT_OPTIONS: Array<{
  value: PayerEdiEnrollmentStatus;
  label: string;
}> = [
  { value: "enrolled", label: "Enrolled" },
  { value: "pending", label: "Pending" },
  { value: "not_enrolled", label: "Not enrolled" },
  { value: "not_applicable", label: "N/A (paper / WC)" },
];

type DrawerMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; payer: PayerProfile };

export function AdminBillingConfigPayersPage() {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [lob, setLob] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [drawer, setDrawer] = useState<DrawerMode>({ kind: "closed" });

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-payer-profiles", { search, region, lob, active }],
    queryFn: () =>
      fetchPayerProfiles({
        q: search || undefined,
        region: region || undefined,
        lineOfBusiness: lob || undefined,
        active: active || undefined,
      }),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-config-payers"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-semibold mb-1"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Payer profiles
          </h1>
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            The PA payer catalog backing every claim header.{" "}
            {data?.payerProfiles.length ?? 0} match the current filters.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setDrawer({ kind: "create" })}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            data-testid="payer-add-button"
          >
            + Add payer
          </button>
          <a
            href={officeAllyExportCsvHref()}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
            style={{ color: "hsl(var(--ink-1))" }}
            data-testid="payer-export-oa-csv"
          >
            ↓ Download OA enrollment CSV
          </a>
        </div>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <Card title="Filters">
        <div className="flex flex-wrap gap-3 items-end">
          <FilterInput
            label="Name search"
            value={search}
            onChange={setSearch}
            placeholder="UPMC, Aetna, …"
          />
          <FilterSelect
            label="Region"
            value={region}
            onChange={setRegion}
            options={[
              { value: "", label: "All" },
              ...REGION_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              })),
            ]}
          />
          <FilterSelect
            label="Line of business"
            value={lob}
            onChange={setLob}
            options={[
              { value: "", label: "All" },
              ...LOB_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
          <FilterSelect
            label="Active"
            value={active}
            onChange={(v) => setActive(v as typeof active)}
            options={[
              { value: "true", label: "Active" },
              { value: "false", label: "Inactive" },
              { value: "", label: "Either" },
            ]}
          />
        </div>
      </Card>

      <Card>
        {isPending ? (
          <Spinner label="Loading payers…" />
        ) : (data?.payerProfiles.length ?? 0) === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No payers match.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Name</th>
                  <th className="p-3">Region</th>
                  <th className="p-3">LOB</th>
                  <th className="p-3">Office Ally ID</th>
                  <th className="p-3">Claim format</th>
                  <th className="p-3">PA req?</th>
                  <th className="p-3">Timely filing</th>
                  <th className="p-3">EDI</th>
                  <th className="p-3">Verified</th>
                  <th className="p-3">Active</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {(data?.payerProfiles ?? []).map((p) => (
                  <PayerRow
                    key={p.id}
                    p={p}
                    onEdit={() => setDrawer({ kind: "edit", payer: p })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {drawer.kind !== "closed" && (
        <PayerDrawer
          mode={drawer}
          onClose={() => setDrawer({ kind: "closed" })}
        />
      )}
    </div>
  );
}

function PayerRow({ p, onEdit }: { p: PayerProfile; onEdit: () => void }) {
  return (
    <tr
      className="border-t"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid={`payer-row-${p.slug}`}
    >
      <td className="p-3">
        <p className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
          {p.displayName}
        </p>
        <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
          {p.payerLegalName} · {p.slug}
        </p>
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.region}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.lineOfBusiness}
      </td>
      <td
        className="p-3 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {p.officeAllyPayerId ?? p.edi5010PayerId ?? "—"}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.claimFormat}
        {p.paperOnly && (
          <span
            className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase"
            style={{
              backgroundColor: "rgba(180, 83, 9, 0.16)",
              color: "#b45309",
            }}
          >
            paper
          </span>
        )}
      </td>
      <td className="p-3 text-center">
        {p.requiresPriorAuthDme ? (
          <span style={{ color: "#b45309" }}>yes</span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>no</span>
        )}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.timelyFilingDays != null ? (
          `${p.timelyFilingDays}d`
        ) : (
          <span style={{ color: "#b45309" }}>review</span>
        )}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        <EnrollmentBadge status={p.ediEnrollmentStatus} />
      </td>
      <td className="p-3 text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {p.requirementsLastVerifiedAt
          ? p.requirementsLastVerifiedAt.slice(0, 10)
          : "—"}
      </td>
      <td className="p-3">
        {p.isActive ? (
          <span style={{ color: "#15803d" }}>active</span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>inactive</span>
        )}
      </td>
      <td className="p-3">
        <button
          type="button"
          onClick={onEdit}
          className="text-sm font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
          data-testid={`payer-edit-${p.slug}`}
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

function EnrollmentBadge({ status }: { status: PayerEdiEnrollmentStatus }) {
  const colors: Record<PayerEdiEnrollmentStatus, { bg: string; fg: string }> = {
    enrolled: { bg: "rgba(21,128,61,0.14)", fg: "#15803d" },
    pending: { bg: "rgba(180,83,9,0.14)", fg: "#b45309" },
    not_enrolled: { bg: "rgba(190,18,60,0.14)", fg: "#be123c" },
    not_applicable: { bg: "rgba(100,116,139,0.16)", fg: "#475569" },
  };
  const c = colors[status];
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ── Edit / Add drawer ───────────────────────────────────────────────

function PayerDrawer({
  mode,
  onClose,
}: {
  mode: { kind: "create" } | { kind: "edit"; payer: PayerProfile };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const initial = useMemo<PayerProfileFormState>(
    () => (mode.kind === "edit" ? formFromProfile(mode.payer) : emptyForm()),
    [mode],
  );
  const [form, setForm] = useState<PayerProfileFormState>(initial);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = formToPayload(form);
      if (mode.kind === "edit") {
        await updatePayerProfile(mode.payer.id, payload);
        return mode.payer.id;
      }
      const { id } = await createPayerProfile(payload as PayerProfileUpsert);
      return id;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin-payer-profiles"],
      });
      onClose();
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  function set<K extends keyof PayerProfileFormState>(
    key: K,
    value: PayerProfileFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const isEdit = mode.kind === "edit";

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/40"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      data-testid="payer-drawer"
    >
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2
              className="text-xl font-semibold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {isEdit ? "Edit payer" : "Add payer"}
            </h2>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Saving stamps {`"requirements last verified"`} with your email so
              the catalog tracks freshness.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitError(null);
            mutation.mutate();
          }}
          className="space-y-5"
          data-testid="payer-form"
        >
          <Section title="Identity">
            <Field
              label="Slug"
              hint="Stable identifier, [a-z0-9_]+. Cannot change after creation in practice."
            >
              <input
                type="text"
                value={form.slug}
                onChange={(e) => set("slug", e.target.value)}
                disabled={isEdit}
                required
                pattern="^[a-z0-9_]+$"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono disabled:bg-slate-100"
              />
            </Field>
            <Field label="Display name">
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => set("displayName", e.target.value)}
                required
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Payer legal name (for 837P NM1*PR loop)">
              <input
                type="text"
                value={form.payerLegalName}
                onChange={(e) => set("payerLegalName", e.target.value)}
                required
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Parent organization">
              <input
                type="text"
                value={form.parentOrg}
                onChange={(e) => set("parentOrg", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <FieldRow>
              <Field label="Line of business">
                <SimpleSelect
                  value={form.lineOfBusiness}
                  onChange={(v) =>
                    set("lineOfBusiness", v as PayerLineOfBusiness)
                  }
                  options={LOB_OPTIONS}
                />
              </Field>
              <Field label="Region">
                <SimpleSelect
                  value={form.region}
                  onChange={(v) => set("region", v as PayerRegion)}
                  options={REGION_OPTIONS}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                label="Active?"
                hint="Inactive payers stay in claim history but vanish from claim composer."
              >
                <BooleanToggle
                  value={form.isActive}
                  onChange={(v) => set("isActive", v)}
                />
              </Field>
              <Field label="Paper-only (HCFA-1500)?">
                <BooleanToggle
                  value={form.paperOnly}
                  onChange={(v) => set("paperOnly", v)}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                label="Require signed paperwork before shipment?"
                hint="When on, a patient whose primary coverage is this payer must have signed intake paperwork (HIPAA NPP, Assignment of Benefits, Supplier Standards) on file before their orders can be marked shipped."
              >
                <BooleanToggle
                  value={form.requiresSignedPaperwork}
                  onChange={(v) => set("requiresSignedPaperwork", v)}
                />
              </Field>
            </FieldRow>
          </Section>

          <Section title="Electronic claim identifiers">
            <FieldRow>
              <Field label="Office Ally payer ID">
                <input
                  type="text"
                  value={form.officeAllyPayerId}
                  onChange={(e) => set("officeAllyPayerId", e.target.value)}
                  maxLength={20}
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
              <Field label="EDI 5010 payer ID">
                <input
                  type="text"
                  value={form.edi5010PayerId}
                  onChange={(e) => set("edi5010PayerId", e.target.value)}
                  maxLength={20}
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Claim format">
                <SimpleSelect
                  value={form.claimFormat}
                  onChange={(v) => set("claimFormat", v as PayerClaimFormat)}
                  options={CLAIM_FORMAT_OPTIONS}
                />
              </Field>
              <Field label="EDI enrollment status">
                <SimpleSelect
                  value={form.ediEnrollmentStatus}
                  onChange={(v) =>
                    set("ediEnrollmentStatus", v as PayerEdiEnrollmentStatus)
                  }
                  options={EDI_ENROLLMENT_OPTIONS}
                />
              </Field>
            </FieldRow>
            <Field label="Accepts electronic secondary (COB) claims?">
              <BooleanToggle
                value={form.acceptsElectronicSecondary}
                onChange={(v) => set("acceptsElectronicSecondary", v)}
              />
            </Field>
            <Field label="Member ID format hint">
              <input
                type="text"
                value={form.memberIdFormatHint}
                onChange={(e) => set("memberIdFormatHint", e.target.value)}
                placeholder='e.g. "3 letters + 9 digits"'
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
          </Section>

          <Section title="Prior authorization (DME)">
            <FieldRow>
              <Field label="Requires PA for capped-rental DME?">
                <BooleanToggle
                  value={form.requiresPriorAuthDme}
                  onChange={(v) => set("requiresPriorAuthDme", v)}
                />
              </Field>
              <Field label="PA submission method">
                <SimpleSelect
                  value={form.priorAuthSubmissionMethod ?? ""}
                  onChange={(v) =>
                    set(
                      "priorAuthSubmissionMethod",
                      v === "" ? null : (v as PayerPaSubmissionMethod),
                    )
                  }
                  options={[
                    { value: "", label: "(none / unknown)" },
                    ...PA_METHOD_OPTIONS,
                  ]}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="PA phone (E.164)">
                <input
                  type="tel"
                  value={form.priorAuthPhoneE164}
                  onChange={(e) => set("priorAuthPhoneE164", e.target.value)}
                  placeholder="+18005551234"
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
              <Field label="PA fax (E.164)">
                <input
                  type="tel"
                  value={form.priorAuthFaxE164}
                  onChange={(e) => set("priorAuthFaxE164", e.target.value)}
                  placeholder="+18005551234"
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
            </FieldRow>
            <Field label="PA turnaround (business days)">
              <input
                type="number"
                min={0}
                max={180}
                value={form.priorAuthTurnaroundBusinessDays}
                onChange={(e) =>
                  set("priorAuthTurnaroundBusinessDays", e.target.value)
                }
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
          </Section>

          <Section title="Claims submission (paper backup + status)">
            <Field label="Timely filing limit (days from DOS)">
              <input
                type="number"
                min={30}
                max={1825}
                value={form.timelyFilingDays}
                onChange={(e) => set("timelyFilingDays", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Required modifiers (comma-separated, e.g. KX, GA)">
              <input
                type="text"
                value={form.requiredClaimModifiers}
                onChange={(e) => set("requiredClaimModifiers", e.target.value)}
                placeholder="KX, GA"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
            </Field>
            <Field label="Claims address line 1">
              <input
                type="text"
                value={form.claimsAddressLine1}
                onChange={(e) => set("claimsAddressLine1", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Claims address line 2">
              <input
                type="text"
                value={form.claimsAddressLine2}
                onChange={(e) => set("claimsAddressLine2", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <FieldRow>
              <Field label="City">
                <input
                  type="text"
                  value={form.claimsCity}
                  onChange={(e) => set("claimsCity", e.target.value)}
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                />
              </Field>
              <Field label="State (2-letter)">
                <input
                  type="text"
                  value={form.claimsState}
                  onChange={(e) =>
                    set("claimsState", e.target.value.toUpperCase())
                  }
                  maxLength={2}
                  pattern="^[A-Z]{2}$"
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm uppercase"
                />
              </Field>
              <Field label="ZIP">
                <input
                  type="text"
                  value={form.claimsZip}
                  onChange={(e) => set("claimsZip", e.target.value)}
                  maxLength={10}
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Claim status phone (E.164)">
                <input
                  type="tel"
                  value={form.claimStatusPhoneE164}
                  onChange={(e) => set("claimStatusPhoneE164", e.target.value)}
                  placeholder="+18005551234"
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
              <Field label="Claims fax (E.164)">
                <input
                  type="tel"
                  value={form.claimsFaxE164}
                  onChange={(e) => set("claimsFaxE164", e.target.value)}
                  placeholder="+18005551234"
                  className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
                />
              </Field>
            </FieldRow>
            <Field label="Claims general phone (E.164)">
              <input
                type="tel"
                value={form.claimsPhoneE164}
                onChange={(e) => set("claimsPhoneE164", e.target.value)}
                placeholder="+18005551234"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
            </Field>
          </Section>

          <Section title="References">
            <Field label="Provider portal URL">
              <input
                type="url"
                value={form.providerPortalUrl}
                onChange={(e) => set("providerPortalUrl", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Fee schedule source URL">
              <input
                type="text"
                value={form.feeScheduleSource}
                onChange={(e) => set("feeScheduleSource", e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field
              label="Notes (no PHI)"
              hint="Payer-level metadata only — no patient identifiers."
            >
              <textarea
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                rows={4}
                maxLength={2000}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
          </Section>

          {submitError && (
            <p
              className="rounded border border-rose-300 bg-rose-50 p-3 text-sm"
              style={{ color: "#9f1239" }}
            >
              {submitError}
            </p>
          )}

          <footer className="flex justify-end gap-2 border-t pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-300 px-4 py-1.5 text-sm font-semibold hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="rounded bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              data-testid="payer-form-submit"
            >
              {mutation.isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create payer"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ── Form helpers ────────────────────────────────────────────────────

interface PayerProfileFormState {
  slug: string;
  displayName: string;
  payerLegalName: string;
  parentOrg: string;
  lineOfBusiness: PayerLineOfBusiness;
  region: PayerRegion;
  officeAllyPayerId: string;
  edi5010PayerId: string;
  claimFormat: PayerClaimFormat;
  paperOnly: boolean;
  requiresPriorAuthDme: boolean;
  requiresSignedPaperwork: boolean;
  priorAuthPhoneE164: string;
  claimStatusPhoneE164: string;
  providerPortalUrl: string;
  feeScheduleSource: string;
  notes: string;
  isActive: boolean;
  timelyFilingDays: string;
  claimsAddressLine1: string;
  claimsAddressLine2: string;
  claimsCity: string;
  claimsState: string;
  claimsZip: string;
  claimsPhoneE164: string;
  claimsFaxE164: string;
  priorAuthSubmissionMethod: PayerPaSubmissionMethod | null;
  priorAuthFaxE164: string;
  priorAuthTurnaroundBusinessDays: string;
  requiredClaimModifiers: string;
  acceptsElectronicSecondary: boolean;
  ediEnrollmentStatus: PayerEdiEnrollmentStatus;
  memberIdFormatHint: string;
}

function emptyForm(): PayerProfileFormState {
  return {
    slug: "",
    displayName: "",
    payerLegalName: "",
    parentOrg: "",
    lineOfBusiness: "commercial",
    region: "pa",
    officeAllyPayerId: "",
    edi5010PayerId: "",
    claimFormat: "837p",
    paperOnly: false,
    requiresPriorAuthDme: false,
    requiresSignedPaperwork: false,
    priorAuthPhoneE164: "",
    claimStatusPhoneE164: "",
    providerPortalUrl: "",
    feeScheduleSource: "",
    notes: "",
    isActive: true,
    timelyFilingDays: "180",
    claimsAddressLine1: "",
    claimsAddressLine2: "",
    claimsCity: "",
    claimsState: "",
    claimsZip: "",
    claimsPhoneE164: "",
    claimsFaxE164: "",
    priorAuthSubmissionMethod: null,
    priorAuthFaxE164: "",
    priorAuthTurnaroundBusinessDays: "",
    requiredClaimModifiers: "",
    acceptsElectronicSecondary: true,
    ediEnrollmentStatus: "not_applicable",
    memberIdFormatHint: "",
  };
}

function formFromProfile(p: PayerProfile): PayerProfileFormState {
  return {
    slug: p.slug,
    displayName: p.displayName,
    payerLegalName: p.payerLegalName,
    parentOrg: p.parentOrg ?? "",
    lineOfBusiness: p.lineOfBusiness,
    region: p.region,
    officeAllyPayerId: p.officeAllyPayerId ?? "",
    edi5010PayerId: p.edi5010PayerId ?? "",
    claimFormat: p.claimFormat,
    paperOnly: p.paperOnly,
    requiresPriorAuthDme: p.requiresPriorAuthDme,
    requiresSignedPaperwork: p.requiresSignedPaperwork,
    priorAuthPhoneE164: p.priorAuthPhoneE164 ?? "",
    claimStatusPhoneE164: p.claimStatusPhoneE164 ?? "",
    providerPortalUrl: p.providerPortalUrl ?? "",
    feeScheduleSource: p.feeScheduleSource ?? "",
    notes: p.notes ?? "",
    isActive: p.isActive,
    timelyFilingDays:
      p.timelyFilingDays != null ? String(p.timelyFilingDays) : "",
    claimsAddressLine1: p.claimsAddressLine1 ?? "",
    claimsAddressLine2: p.claimsAddressLine2 ?? "",
    claimsCity: p.claimsCity ?? "",
    claimsState: p.claimsState ?? "",
    claimsZip: p.claimsZip ?? "",
    claimsPhoneE164: p.claimsPhoneE164 ?? "",
    claimsFaxE164: p.claimsFaxE164 ?? "",
    priorAuthSubmissionMethod: p.priorAuthSubmissionMethod,
    priorAuthFaxE164: p.priorAuthFaxE164 ?? "",
    priorAuthTurnaroundBusinessDays:
      p.priorAuthTurnaroundBusinessDays != null
        ? String(p.priorAuthTurnaroundBusinessDays)
        : "",
    requiredClaimModifiers: p.requiredClaimModifiers.join(", "),
    acceptsElectronicSecondary: p.acceptsElectronicSecondary,
    ediEnrollmentStatus: p.ediEnrollmentStatus,
    memberIdFormatHint: p.memberIdFormatHint ?? "",
  };
}

function formToPayload(
  f: PayerProfileFormState,
): PayerProfilePatch & PayerProfileUpsert {
  const nullableString = (s: string) => (s.trim() === "" ? null : s.trim());
  const nullableInt = (s: string) => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const modifiers = f.requiredClaimModifiers
    .split(/[,\s]+/)
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length > 0);

  return {
    slug: f.slug.trim(),
    displayName: f.displayName.trim(),
    payerLegalName: f.payerLegalName.trim(),
    parentOrg: nullableString(f.parentOrg),
    lineOfBusiness: f.lineOfBusiness,
    region: f.region,
    officeAllyPayerId: nullableString(f.officeAllyPayerId),
    edi5010PayerId: nullableString(f.edi5010PayerId),
    claimFormat: f.claimFormat,
    paperOnly: f.paperOnly,
    requiresPriorAuthDme: f.requiresPriorAuthDme,
    requiresSignedPaperwork: f.requiresSignedPaperwork,
    priorAuthPhoneE164: nullableString(f.priorAuthPhoneE164),
    claimStatusPhoneE164: nullableString(f.claimStatusPhoneE164),
    providerPortalUrl: nullableString(f.providerPortalUrl),
    feeScheduleSource: nullableString(f.feeScheduleSource),
    notes: nullableString(f.notes),
    isActive: f.isActive,
    timelyFilingDays: nullableInt(f.timelyFilingDays),
    claimsAddressLine1: nullableString(f.claimsAddressLine1),
    claimsAddressLine2: nullableString(f.claimsAddressLine2),
    claimsCity: nullableString(f.claimsCity),
    claimsState: nullableString(f.claimsState),
    claimsZip: nullableString(f.claimsZip),
    claimsPhoneE164: nullableString(f.claimsPhoneE164),
    claimsFaxE164: nullableString(f.claimsFaxE164),
    priorAuthSubmissionMethod: f.priorAuthSubmissionMethod,
    priorAuthFaxE164: nullableString(f.priorAuthFaxE164),
    priorAuthTurnaroundBusinessDays: nullableInt(
      f.priorAuthTurnaroundBusinessDays,
    ),
    requiredClaimModifiers: modifiers,
    acceptsElectronicSecondary: f.acceptsElectronicSecondary,
    ediEnrollmentStatus: f.ediEnrollmentStatus,
    memberIdFormatHint: nullableString(f.memberIdFormatHint),
  };
}

// ── Tiny presentational helpers ─────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="block text-xs font-semibold mb-1"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span
          className="mt-1 block text-[11px]"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function SimpleSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function BooleanToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
      <span className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
        {value ? "Yes" : "No"}
      </span>
    </label>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

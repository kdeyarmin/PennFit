// /admin/billing/config/organization — DME organization identity editor.
//
// The editable, DB-backed billing identity (legal name, tax id,
// organizational NPI, addresses, accreditation, …). The backend
// identity-resolver PREFERS this row over the legacy OFFICE_ALLY_BILLING_*
// env vars, so setting it here removes the need for those global secrets.
// The 837P claim builder, 270 eligibility request, HCFA PDF, and
// auto-resubmit pipeline all read through the resolver.
//
// The PUT is a full upsert, so the form round-trips EVERY field (a key
// omitted from the body is written NULL). We seed form state from the
// GET response and submit the whole body.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  ACCREDITATION_BODIES,
  type DmeOrgBody,
  emptyDmeOrgBody,
  fetchDmeOrganization,
  orgToBody,
  saveDmeOrganization,
} from "@/lib/admin/dme-organization-api";

type FieldKind = "text" | "date" | "usd";
interface FieldDef {
  key: keyof DmeOrgBody;
  label: string;
  required?: boolean;
  kind?: FieldKind;
  placeholder?: string;
  maxLength?: number;
}

const IDENTITY: FieldDef[] = [
  { key: "legalName", label: "Legal name", required: true },
  { key: "dbaName", label: "DBA name" },
  {
    key: "taxId",
    label: "Tax ID (EIN)",
    required: true,
    placeholder: "9 digits, no dashes",
    maxLength: 9,
  },
  {
    key: "organizationalNpi",
    label: "Organizational NPI (type-2)",
    required: true,
    placeholder: "10 digits",
    maxLength: 10,
  },
  { key: "taxonomyCode", label: "Taxonomy code", required: true },
  { key: "medicarePtan", label: "Medicare PTAN" },
];
function addressFields(prefix: "physical" | "mailing" | "payTo"): FieldDef[] {
  const req = prefix === "physical";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    {
      key: `${prefix}AddressLine1` as keyof DmeOrgBody,
      label: `${cap(prefix)} line 1`,
      required: req,
    },
    { key: `${prefix}AddressLine2` as keyof DmeOrgBody, label: "Line 2" },
    { key: `${prefix}City` as keyof DmeOrgBody, label: "City", required: req },
    {
      key: `${prefix}State` as keyof DmeOrgBody,
      label: "State",
      required: req,
      placeholder: "PA",
      maxLength: 2,
    },
    {
      key: `${prefix}Zip` as keyof DmeOrgBody,
      label: "ZIP",
      required: req,
      placeholder: "19106",
    },
  ];
}
const CONTACT: FieldDef[] = [
  {
    key: "phoneE164",
    label: "Phone",
    required: true,
    placeholder: "+12155551234",
  },
  { key: "faxE164", label: "Fax", placeholder: "+12155551234" },
  { key: "billingEmail", label: "Billing email", required: true },
  { key: "generalEmail", label: "General email" },
  { key: "websiteUrl", label: "Website URL", placeholder: "https://…" },
];
const SUPPORT: FieldDef[] = [
  {
    key: "supportPhoneE164",
    label: "Support phone",
    placeholder: "+18144710627",
  },
  { key: "supportEmail", label: "Support email" },
  {
    key: "supportHoursText",
    label: "Support hours",
    placeholder: "Mon–Fri 9a–5p ET",
    maxLength: 160,
  },
];
const ACCREDITATION: FieldDef[] = [
  { key: "accreditationNumber", label: "Accreditation number" },
  {
    key: "accreditationExpiresOn",
    label: "Accreditation expires",
    kind: "date",
  },
];
const LICENSING: FieldDef[] = [
  { key: "stateLicenseNumber", label: "State license number" },
  {
    key: "stateLicenseState",
    label: "License state",
    placeholder: "PA",
    maxLength: 2,
  },
  { key: "stateLicenseExpiresOn", label: "License expires", kind: "date" },
  { key: "liabilityCarrier", label: "Liability carrier" },
  { key: "liabilityPolicyNumber", label: "Liability policy #" },
  { key: "liabilityExpiresOn", label: "Liability expires", kind: "date" },
  { key: "suretyBondCarrier", label: "Surety bond carrier" },
  {
    key: "suretyBondAmountCents",
    label: "Surety bond amount (USD)",
    kind: "usd",
  },
  { key: "suretyBondExpiresOn", label: "Surety bond expires", kind: "date" },
  { key: "authorizedSignerName", label: "Authorized signer" },
  { key: "authorizedSignerTitle", label: "Signer title" },
];

const INPUT_STYLE = { borderColor: "hsl(var(--line))" } as const;

export function AdminBillingConfigOrganizationPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "dme-organization"],
    queryFn: fetchDmeOrganization,
  });

  const [body, setBody] = useState<DmeOrgBody>(emptyDmeOrgBody);
  const [saved, setSaved] = useState(false);

  // Seed form state once the GET resolves (or when the org is created).
  useEffect(() => {
    if (data) {
      setBody(
        data.organization ? orgToBody(data.organization) : emptyDmeOrgBody(),
      );
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: saveDmeOrganization,
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ["admin", "dme-organization"],
      });
    },
  });

  const set = (key: keyof DmeOrgBody, raw: string, kind?: FieldKind): void => {
    setSaved(false);
    setBody((prev) => {
      if (kind === "usd") {
        const dollars = Number.parseFloat(raw);
        return {
          ...prev,
          suretyBondAmountCents:
            raw.trim() === "" || !Number.isFinite(dollars)
              ? null
              : Math.round(dollars * 100),
        };
      }
      // Required string fields keep "" (so the server enforces them);
      // optional ones collapse "" → null.
      const required = ALL_REQUIRED.has(key);
      return { ...prev, [key]: raw === "" && !required ? null : raw };
    });
  };

  const missingRequired = useMemo(
    () => [...ALL_REQUIRED].filter((k) => !String(body[k] ?? "").trim()),
    [body],
  );

  function renderField(f: FieldDef) {
    const current = body[f.key];
    const value =
      f.kind === "usd"
        ? body.suretyBondAmountCents == null
          ? ""
          : String(body.suretyBondAmountCents / 100)
        : ((current as string | null) ?? "");
    return (
      <label key={String(f.key)} className="block text-sm">
        <span style={{ color: "hsl(var(--ink-2))" }}>
          {f.label}
          {f.required ? <span style={{ color: "#dc2626" }}> *</span> : null}
        </span>
        <input
          type={
            f.kind === "date" ? "date" : f.kind === "usd" ? "number" : "text"
          }
          className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
          style={INPUT_STYLE}
          value={value}
          placeholder={f.placeholder}
          maxLength={f.maxLength}
          onChange={(e) => set(f.key, e.target.value, f.kind)}
        />
      </label>
    );
  }

  function section(title: string, fields: FieldDef[], extra?: ReactNode) {
    return (
      <Card title={title}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fields.map(renderField)}
          {extra}
        </div>
      </Card>
    );
  }

  if (isPending) {
    return (
      <div className="admin-root p-6">
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="admin-root p-6">
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const accreditationSelect = (
    <label className="block text-sm">
      <span style={{ color: "hsl(var(--ink-2))" }}>Accreditation body</span>
      <select
        className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
        style={INPUT_STYLE}
        value={body.accreditationBody ?? ""}
        onChange={(e) => {
          setSaved(false);
          setBody((p) => ({
            ...p,
            accreditationBody:
              e.target.value === ""
                ? null
                : (e.target.value as DmeOrgBody["accreditationBody"]),
          }));
        }}
      >
        <option value="">—</option>
        {ACCREDITATION_BODIES.map((b) => (
          <option key={b} value={b}>
            {b.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="admin-root p-6 space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold">Company information</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          The company identity used everywhere: claims (837P), eligibility
          requests (270), HCFA forms, patient-packet documents, generated PDFs,
          the storefront contact details, the chatbots, and the brand name on
          SMS and email. The display name is the DBA name when set, otherwise
          the legal name. Saved to the database and preferred over the legacy{" "}
          <code>OFFICE_ALLY_BILLING_*</code> /{" "}
          <code>RESUPPLY_PRACTICE_NAME</code> environment variables — set it
          here instead of in global secrets. SFTP login keys stay in secrets;
          this page is identity only.
        </p>
      </header>

      {section("Identity", IDENTITY)}
      {section("Physical address", addressFields("physical"))}
      {section(
        "Mailing address (optional — blank = same as physical)",
        addressFields("mailing"),
      )}
      {section(
        "Pay-to address (optional — blank = same as physical)",
        addressFields("payTo"),
      )}
      {section("Contact", CONTACT)}
      {section(
        "Customer support (shown on the storefront, chat, and documents — blank = main phone/email)",
        SUPPORT,
      )}
      {section("Accreditation", ACCREDITATION, accreditationSelect)}
      {section("Licensing, liability & signer (optional)", LICENSING)}

      <Card title="Notes">
        <textarea
          className="w-full rounded-md border px-2.5 py-1.5 text-sm"
          style={INPUT_STYLE}
          rows={3}
          value={body.notes ?? ""}
          onChange={(e) => {
            setSaved(false);
            setBody((p) => ({
              ...p,
              notes: e.target.value === "" ? null : e.target.value,
            }));
          }}
        />
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: "hsl(var(--penn-navy))" }}
          disabled={mutation.isPending || missingRequired.length > 0}
          onClick={() => mutation.mutate(body)}
        >
          <Building2 className="h-4 w-4" />
          {mutation.isPending ? "Saving…" : "Save organization"}
        </button>
        {missingRequired.length > 0 && (
          <span className="text-sm" style={{ color: "#b45309" }}>
            Fill required fields: {missingRequired.join(", ")}
          </span>
        )}
        {saved && !mutation.isPending && (
          <span className="text-sm" style={{ color: "#15803d" }}>
            Saved.
          </span>
        )}
        {mutation.isError && (
          <span className="text-sm" style={{ color: "#dc2626" }}>
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Save failed"}
          </span>
        )}
      </div>
    </div>
  );
}

// Required keys mirror the server's `orgBody` non-optional fields.
const ALL_REQUIRED = new Set<keyof DmeOrgBody>([
  "legalName",
  "taxId",
  "organizationalNpi",
  "taxonomyCode",
  "physicalAddressLine1",
  "physicalCity",
  "physicalState",
  "physicalZip",
  "phoneE164",
  "billingEmail",
]);

export default AdminBillingConfigOrganizationPage;

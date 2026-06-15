// /admin/storefront-branding — a tenant configures their own storefront
// identity and wires up a custom domain.
//
// Two jobs on one page:
//   1. Brand — storefront name, tagline, and logo shown on the public
//      site (served by GET /api/storefront-branding).
//   2. Custom domain — bind a domain, publish the DNS records we show,
//      and click Verify to prove ownership (a DNS TXT challenge). Once
//      verified, requests on that host resolve to this storefront.
//
// All writes are scoped server-side to the caller's tenant.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, ImageUp, Store } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchStorefrontBranding,
  LOGO_IMAGE_TYPES,
  LOGO_MAX_BYTES,
  PublicStorageUnavailableError,
  removeCustomDomain,
  removeStorefrontLogo,
  saveStorefrontBranding,
  setCustomDomain,
  type StorefrontBrandingView,
  uploadStorefrontLogo,
  verifyCustomDomain,
} from "@/lib/admin/storefront-branding-api";

const INPUT_STYLE = { borderColor: "hsl(var(--line))" } as const;
const QUERY_KEY = ["admin", "storefront-branding"] as const;

function DnsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <span
        className="text-xs font-semibold uppercase tracking-wide sm:w-28 sm:shrink-0"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <code
        className="break-all rounded bg-black/5 px-2 py-1 text-xs"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </code>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: StorefrontBrandingView["domain"]["status"];
}) {
  const map = {
    none: {
      label: "Not configured",
      color: "hsl(var(--ink-3))",
      bg: "hsl(var(--line))",
    },
    pending: { label: "Pending verification", color: "#b45309", bg: "#fef3c7" },
    verified: { label: "Verified", color: "#15803d", bg: "#dcfce7" },
  } as const;
  const s = map[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ color: s.color, background: s.bg }}
    >
      {s.label}
    </span>
  );
}

function TlsBadge({
  status,
}: {
  status: "none" | "pending" | "active" | "failed";
}) {
  const map = {
    none: {
      label: "Not started",
      color: "hsl(var(--ink-3))",
      bg: "hsl(var(--line))",
    },
    pending: { label: "Issuing certificate…", color: "#b45309", bg: "#fef3c7" },
    active: { label: "HTTPS live", color: "#15803d", bg: "#dcfce7" },
    failed: { label: "Needs attention", color: "#b91c1c", bg: "#fee2e2" },
  } as const;
  const s = map[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ color: s.color, background: s.bg }}
    >
      {s.label}
    </span>
  );
}

export function AdminStorefrontBrandingPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchStorefrontBranding,
  });

  const [storefrontName, setStorefrontName] = useState("");
  const [tagline, setTagline] = useState("");
  const [savedBrand, setSavedBrand] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Seed editable fields once the GET resolves.
  useEffect(() => {
    if (data) {
      setStorefrontName(data.storefrontName);
      setTagline(data.tagline);
    }
  }, [data]);

  function applyResult(next: StorefrontBrandingView): void {
    queryClient.setQueryData(QUERY_KEY, next);
  }

  const saveBrand = useMutation({
    mutationFn: () => saveStorefrontBranding({ storefrontName, tagline }),
    onSuccess: (next) => {
      setSavedBrand(true);
      applyResult(next);
    },
  });

  const logoUpload = useMutation({
    mutationFn: (file: File) => uploadStorefrontLogo(file),
    onSuccess: (next) => {
      setLogoError(null);
      applyResult(next);
    },
    onError: (err) => {
      setLogoError(
        err instanceof PublicStorageUnavailableError
          ? "Logo uploads aren't available in this environment (no public storage bucket configured). You can still set your storefront name and tagline."
          : err instanceof Error
            ? err.message
            : "Logo upload failed.",
      );
    },
  });

  const logoRemove = useMutation({
    mutationFn: removeStorefrontLogo,
    onSuccess: applyResult,
  });

  const domainSet = useMutation({
    mutationFn: (domain: string) => setCustomDomain(domain),
    onSuccess: (next) => {
      setVerifyMsg(null);
      setDomainInput("");
      applyResult(next);
    },
  });

  const domainVerify = useMutation({
    mutationFn: verifyCustomDomain,
    onSuccess: (next) => {
      applyResult(next);
      setVerifyMsg(
        next.verified
          ? "Domain verified — your storefront is now live on this domain (TLS provisioning may take a few minutes)."
          : "We couldn't find the TXT record yet. DNS changes can take a few minutes to propagate — double-check the record and try again.",
      );
    },
  });

  const domainRemove = useMutation({
    mutationFn: removeCustomDomain,
    onSuccess: (next) => {
      setVerifyMsg(null);
      applyResult(next);
    },
  });

  function onPickLogo(file: File | null): void {
    setLogoError(null);
    if (!file) return;
    if (!LOGO_IMAGE_TYPES.includes(file.type)) {
      setLogoError("Unsupported image type — use PNG, JPEG, or WebP.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError("Logo is too large — keep it under 2 MB.");
      return;
    }
    logoUpload.mutate(file, {
      onSettled: () => {
        if (fileRef.current) fileRef.current.value = "";
      },
    });
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

  const domain = data.domain;

  return (
    <div className="admin-root p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold">Storefront branding</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Your storefront name, tagline, and logo are shown to shoppers on the
          public site. Wire up your own domain below so customers reach your
          storefront at your address — with your brand on it.
        </p>
      </header>

      {/* ── Storefront identity ─────────────────────────────────── */}
      <Card title="Storefront identity">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>Storefront name</span>
            <input
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={storefrontName}
              maxLength={120}
              placeholder="e.g. PennPaps"
              onChange={(e) => {
                setSavedBrand(false);
                setStorefrontName(e.target.value);
              }}
            />
          </label>
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>Tagline</span>
            <input
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={tagline}
              maxLength={200}
              placeholder="Your CPAP, made simple."
              onChange={(e) => {
                setSavedBrand(false);
                setTagline(e.target.value);
              }}
            />
          </label>
        </div>
        <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          The legal company name ({data.legalName || "—"}) is managed on the
          Company information page.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "hsl(var(--penn-navy))" }}
            disabled={saveBrand.isPending}
            onClick={() => saveBrand.mutate()}
          >
            <Store className="h-4 w-4" />
            {saveBrand.isPending ? "Saving…" : "Save identity"}
          </button>
          {savedBrand && !saveBrand.isPending && (
            <span className="text-sm" style={{ color: "#15803d" }}>
              Saved.
            </span>
          )}
          {saveBrand.isError && (
            <span className="text-sm" style={{ color: "#dc2626" }}>
              {saveBrand.error instanceof Error
                ? saveBrand.error.message
                : "Save failed"}
            </span>
          )}
        </div>
      </Card>

      {/* ── Logo ────────────────────────────────────────────────── */}
      <Card title="Logo">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div
            className="flex h-20 w-40 shrink-0 items-center justify-center rounded-md border bg-white"
            style={INPUT_STYLE}
          >
            {data.logoUrl ? (
              <img
                src={data.logoUrl}
                alt="Storefront logo"
                className="max-h-16 max-w-36 object-contain"
              />
            ) : (
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Default logo
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={LOGO_IMAGE_TYPES.join(",")}
              className="text-sm"
              disabled={logoUpload.isPending}
              onChange={(e) => onPickLogo(e.target.files?.[0] ?? null)}
            />
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                PNG, JPEG, or WebP · up to 2 MB
              </span>
              {data.logoUrl && (
                <button
                  type="button"
                  className="text-xs font-semibold underline disabled:opacity-50"
                  style={{ color: "hsl(var(--ink-2))" }}
                  disabled={logoRemove.isPending}
                  onClick={() => logoRemove.mutate()}
                >
                  {logoRemove.isPending ? "Removing…" : "Remove logo"}
                </button>
              )}
            </div>
            {logoUpload.isPending && (
              <span className="inline-flex items-center gap-2 text-sm">
                <ImageUp className="h-4 w-4" /> Uploading…
              </span>
            )}
            {logoError && (
              <span className="text-sm" style={{ color: "#dc2626" }}>
                {logoError}
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ── Custom domain ───────────────────────────────────────── */}
      <Card title="Custom domain">
        <div className="flex items-center gap-3">
          <Globe className="h-4 w-4" style={{ color: "hsl(var(--ink-3))" }} />
          <StatusBadge status={domain.status} />
          {domain.host && (
            <code className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
              {domain.host}
            </code>
          )}
        </div>

        {domain.status === "none" && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="block flex-1 text-sm">
              <span style={{ color: "hsl(var(--ink-2))" }}>Your domain</span>
              <input
                className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
                style={INPUT_STYLE}
                value={domainInput}
                placeholder="shop.yourcompany.com"
                onChange={(e) => setDomainInput(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={domainSet.isPending || domainInput.trim().length === 0}
              onClick={() => domainSet.mutate(domainInput)}
            >
              {domainSet.isPending ? "Adding…" : "Add domain"}
            </button>
          </div>
        )}
        {domainSet.isError && (
          <p className="mt-2 text-sm" style={{ color: "#dc2626" }}>
            {(() => {
              const e = domainSet.error;
              const code =
                e && typeof e === "object" && "data" in e
                  ? (e as { data?: { error?: string } }).data?.error
                  : undefined;
              if (code === "domain_taken")
                return "That domain is already in use by another account.";
              if (code === "invalid_domain")
                return "That doesn't look like a valid domain.";
              return "Couldn't add that domain.";
            })()}
          </p>
        )}

        {domain.instructions && domain.status !== "none" && (
          <div className="mt-4 space-y-4">
            <div>
              <p
                className="text-sm font-medium"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                1. Point your domain at the platform
              </p>
              <p
                className="mb-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Add a CNAME record for your domain pointing at the host below.
                (For a root/apex domain, use your DNS provider's ALIAS/ANAME or
                CNAME-flattening.)
              </p>
              <DnsRow label="Type" value="CNAME" />
              <DnsRow label="Name" value={domain.host ?? ""} />
              <DnsRow label="Target" value={domain.instructions.cnameTarget} />
            </div>
            <div>
              <p
                className="text-sm font-medium"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                2. Add the verification record
              </p>
              <p
                className="mb-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Add this TXT record so we can confirm you own the domain.
              </p>
              <DnsRow label="Type" value="TXT" />
              <DnsRow label="Name" value={domain.instructions.txtName} />
              <DnsRow label="Value" value={domain.instructions.txtValue} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {domain.status !== "verified" && (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: "hsl(var(--penn-navy))" }}
                  disabled={domainVerify.isPending}
                  onClick={() => domainVerify.mutate()}
                >
                  {domainVerify.isPending ? "Checking…" : "Verify domain"}
                </button>
              )}
              <button
                type="button"
                className="text-sm font-semibold underline disabled:opacity-50"
                style={{ color: "hsl(var(--ink-2))" }}
                disabled={domainRemove.isPending}
                onClick={() => domainRemove.mutate()}
              >
                {domainRemove.isPending ? "Removing…" : "Remove domain"}
              </button>
              {verifyMsg && (
                <span
                  className="text-sm"
                  style={{
                    color: domain.status === "verified" ? "#15803d" : "#b45309",
                  }}
                >
                  {verifyMsg}
                </span>
              )}
            </div>
          </div>
        )}

        {/* TLS provisioning (Cloudflare for SaaS) — only when automation is
            on and the domain is verified. Otherwise HTTPS is the documented
            operator step. */}
        {domain.tls?.automation && domain.status === "verified" && (
          <div
            className="mt-4 border-t pt-4"
            style={{ borderColor: "hsl(var(--line))" }}
          >
            <div className="flex items-center gap-3">
              <p
                className="text-sm font-medium"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                HTTPS certificate
              </p>
              <TlsBadge status={domain.tls.status} />
            </div>
            {domain.tls.status === "active" ? (
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Your domain is live over HTTPS — certificates renew
                automatically.
              </p>
            ) : domain.tls.status === "failed" ? (
              <p className="mt-1 text-xs" style={{ color: "#b45309" }}>
                Certificate issuance didn't complete. Double-check your DNS
                records and click <strong>Verify domain</strong> again.
              </p>
            ) : (
              <>
                <p
                  className="mt-1 mb-2 text-xs"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {domain.tls.validation
                    ? "Add the record below to finish issuing your certificate, then refresh this page."
                    : "We're issuing your certificate — this usually takes a few minutes. Refresh this page to check."}
                </p>
                {domain.tls.validation && (
                  <>
                    <DnsRow label="Type" value="TXT" />
                    <DnsRow label="Name" value={domain.tls.validation.name} />
                    <DnsRow label="Value" value={domain.tls.validation.value} />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

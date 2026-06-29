// /admin/fax-settings — a tenant's own fax number.
//
// Each DME tenant gets its OWN fax number so inbound faxes (sleep studies,
// signed Rx, chart notes) route to them and outbound faxes (physician
// outreach, appeal letters) send from their DID. Numbers are
// auto-provisioned through Telnyx (Twilio retired Programmable Fax) or set
// manually for a ported / pre-existing number. Backed by
// organizations.fax_from_number (migration 0368).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchFaxSettings,
  provisionFaxNumber,
  setFaxNumber,
} from "@/lib/admin/fax-settings-api";
import { formatAppDate } from "@/lib/utils";

const INPUT_STYLE: React.CSSProperties = {
  background: "hsl(var(--surface-1))",
  borderColor: "hsl(var(--line-1))",
  color: "hsl(var(--ink-1))",
};

const E164_RE = /^\+[1-9]\d{6,14}$/;
const AREA_CODE_RE = /^\d{3}$/;

const FAX_QUERY_KEY = ["admin", "fax-settings"] as const;

export function AdminFaxSettingsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: FAX_QUERY_KEY,
    queryFn: fetchFaxSettings,
  });

  const [areaCode, setAreaCode] = useState("");
  const [manualNumber, setManualNumber] = useState("");

  // Seed the manual-entry field from the current number once it loads.
  useEffect(() => {
    if (data) setManualNumber(data.faxNumber ?? "");
  }, [data]);

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: FAX_QUERY_KEY });
  }

  const provision = useMutation({
    mutationFn: () => provisionFaxNumber(areaCode.trim() || undefined),
    onSuccess: invalidate,
  });

  const saveManual = useMutation({
    mutationFn: () => setFaxNumber(manualNumber.trim()),
    onSuccess: invalidate,
  });

  const clearNumber = useMutation({
    mutationFn: () => setFaxNumber(null),
    onSuccess: invalidate,
  });

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

  const areaCodeValid =
    areaCode.trim() === "" || AREA_CODE_RE.test(areaCode.trim());
  const manualValid =
    manualNumber.trim() === "" || E164_RE.test(manualNumber.trim());
  const anyPending =
    provision.isPending || saveManual.isPending || clearNumber.isPending;

  function mutationError(m: {
    isError: boolean;
    error: unknown;
  }): string | null {
    if (!m.isError) return null;
    return m.error instanceof Error ? m.error.message : "Request failed";
  }

  return (
    <div className="admin-root p-6 space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold">Fax number</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Your practice&apos;s own fax number. Inbound faxes (sleep studies,
          signed prescriptions, chart notes) route here, and outbound faxes
          (physician outreach, appeal letters) send from it. Numbers are
          provisioned through Telnyx.
        </p>
      </header>

      <Card title="Current fax number">
        {data.faxNumber ? (
          <div className="space-y-1">
            <p className="text-lg font-semibold tabular-nums">
              {data.faxNumber}
            </p>
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              {data.telnyxOrderId
                ? `Provisioned via Telnyx (order ${data.telnyxOrderId})`
                : "Set manually (ported / pre-existing number)"}
              {data.provisionedAt
                ? ` · ${formatAppDate(data.provisionedAt)}`
                : ""}
            </p>
          </div>
        ) : (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No fax number yet. Provision one below, or enter a number you
            already own.
          </p>
        )}
      </Card>

      {!data.faxNumber && (
        <Card title="Provision a new fax number">
          {data.canProvision ? (
            <div className="space-y-3">
              <label className="block text-sm">
                <span style={{ color: "hsl(var(--ink-2))" }}>
                  Preferred area code (optional)
                </span>
                <input
                  className="mt-1 w-40 rounded-md border px-2.5 py-1.5 text-sm"
                  style={INPUT_STYLE}
                  value={areaCode}
                  inputMode="numeric"
                  maxLength={3}
                  placeholder="e.g. 215"
                  onChange={(e) => setAreaCode(e.target.value)}
                />
              </label>
              {!areaCodeValid && (
                <p className="text-sm" style={{ color: "#b45309" }}>
                  Area code must be 3 digits.
                </p>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "hsl(var(--penn-navy))" }}
                disabled={anyPending || !areaCodeValid}
                onClick={() => provision.mutate()}
              >
                <Printer className="h-4 w-4" />
                {provision.isPending ? "Provisioning…" : "Provision fax number"}
              </button>
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Orders a real fax-capable number from Telnyx and attaches it to
                your account. This may incur a monthly charge.
              </p>
              {mutationError(provision) && (
                <p className="text-sm" style={{ color: "#dc2626" }}>
                  {mutationError(provision)}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              Automatic provisioning isn&apos;t available — the platform&apos;s
              Telnyx credentials aren&apos;t configured. Enter a number you
              already own below, or contact your platform administrator.
            </p>
          )}
        </Card>
      )}

      <Card
        title={
          data.faxNumber
            ? "Replace or clear the fax number"
            : "Use a number you already own"
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>
              Fax number (E.164)
            </span>
            <input
              className="mt-1 w-56 rounded-md border px-2.5 py-1.5 text-sm tabular-nums"
              style={INPUT_STYLE}
              value={manualNumber}
              placeholder="+12155551212"
              onChange={(e) => setManualNumber(e.target.value)}
            />
          </label>
          {!manualValid && (
            <p className="text-sm" style={{ color: "#b45309" }}>
              Must be E.164, e.g. +12155551212.
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={
                anyPending ||
                !manualValid ||
                manualNumber.trim() === "" ||
                manualNumber.trim() === (data.faxNumber ?? "")
              }
              onClick={() => saveManual.mutate()}
            >
              {saveManual.isPending ? "Saving…" : "Save number"}
            </button>
            {data.faxNumber && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-1))",
                }}
                disabled={anyPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Clear this tenant's fax number? Inbound faxes will fall back to the platform default and outbound faxes will send from it.",
                    )
                  ) {
                    clearNumber.mutate();
                  }
                }}
              >
                {clearNumber.isPending ? "Clearing…" : "Clear"}
              </button>
            )}
          </div>
          {(mutationError(saveManual) || mutationError(clearNumber)) && (
            <p className="text-sm" style={{ color: "#dc2626" }}>
              {mutationError(saveManual) ?? mutationError(clearNumber)}
            </p>
          )}
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Use this for a number you&apos;ve ported in or already own. A
            manually-entered number must be fax-capable and routed to the
            platform&apos;s Telnyx fax application to send and receive.
          </p>
        </div>
      </Card>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminAgreements,
  useAcceptAgreement,
  getGetAdminMeQueryKey,
  getAdminAgreementsQueryKey,
  type AgreementStatus,
} from "@workspace/api-client-react/admin";

import { Spinner } from "@/components/admin/Spinner";

// Onboarding agreements gate (G16, BAA portion).
//
// Hosting other companies' PHI makes CareMetric Breathe a HIPAA BUSINESS
// ASSOCIATE of each tenant, so every tenant must execute a Business
// Associate Agreement plus the platform's Master Services Agreement BEFORE
// using the product. /me exposes `pendingAgreements`; AdminConsole renders
// THIS screen (instead of the AppShell + routes) whenever that list is
// non-empty, so an unsigned tenant cannot reach any admin page.
//
// Rendered OUTSIDE the AppShell — like NotAuthorizedPage — so it wraps its
// own `.admin-root` scope and applies the admin theme tokens itself.
//
// Accepting is owner-tier on the server (system.config.manage). A
// non-owner admin who somehow lands here sees the documents but their
// Accept POST 403s; the inline error tells them an owner must sign.

export function AgreementsGate() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, refetch } = useAdminAgreements();
  const accept = useAcceptAgreement();
  const [signatoryName, setSignatoryName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  // The required agreements this tenant still owes, in declaration order
  // (platform terms first, then the BAA). We walk them one at a time so the
  // signatory reads and signs each document deliberately rather than
  // rubber-stamping a stack.
  const pending = useMemo<AgreementStatus[]>(
    () => (data?.agreements ?? []).filter((a) => !a.accepted),
    [data],
  );
  const current = pending[0];
  const signedCount = (data?.agreements.length ?? 0) - pending.length;
  const total = data?.agreements.length ?? 0;

  function onAccept() {
    if (!current) return;
    const name = signatoryName.trim();
    if (!name || !acknowledged || accept.isPending) return;
    accept.mutate(
      { type: current.type, version: current.version, signatoryName: name },
      {
        onSuccess: async (res) => {
          // Re-read the agreement list so the just-signed doc drops out of
          // `pending`, and refresh /me so AdminConsole re-evaluates the gate
          // (once `allSigned`, pendingAgreements is empty and the console
          // renders).
          setAcknowledged(false);
          await Promise.all([
            refetch(),
            queryClient.invalidateQueries({
              queryKey: getAdminAgreementsQueryKey(),
            }),
          ]);
          if (res.allSigned) {
            await queryClient.invalidateQueries({
              queryKey: getGetAdminMeQueryKey(),
            });
          }
        },
      },
    );
  }

  return (
    // .admin-root scopes the admin theme tokens; this screen renders before
    // the AppShell exists, so it applies the scope itself (same pattern as
    // NotAuthorizedPage).
    <div
      className="admin-root min-h-screen flex flex-col"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ backgroundColor: "#0a1f44", borderColor: "#0a1f44" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded flex items-center justify-center font-bold"
            style={{ backgroundColor: "#c9a24a", color: "hsl(var(--ink-1))" }}
            aria-hidden="true"
          >
            C
          </div>
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight">
              Welcome to CareMetric Breathe
            </div>
            <div
              className="text-xs"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Finish onboarding
            </div>
          </div>
        </div>
        {total > 0 && (
          <div className="text-xs text-white/80">
            {signedCount} of {total} signed
          </div>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div
          className="max-w-2xl w-full bg-white border rounded-lg p-8 shadow-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {isPending ? (
            <Spinner label="Loading agreements…" />
          ) : isError ? (
            <div role="alert" aria-live="polite">
              <h1
                className="text-2xl font-semibold mb-3"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                We couldn't load your agreements
              </h1>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                There was a problem reaching the server. Please try again in a
                moment.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="text-sm font-semibold px-4 py-2 rounded text-white"
                style={{ backgroundColor: "#0a1f44" }}
              >
                Try again
              </button>
            </div>
          ) : !current ? (
            // No pending agreements — the parent should already have
            // re-rendered the console after the /me invalidation; this is a
            // brief transitional state while that refetch lands.
            <Spinner label="Finishing up…" />
          ) : (
            <div>
              <p
                className="text-xs uppercase tracking-[0.2em] mb-3 font-semibold"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Agreement {signedCount + 1} of {total}
              </p>
              <h1
                className="text-2xl font-semibold mb-2"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {current.title}
              </h1>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                Before your organization can use CareMetric Breathe, an
                authorized representative must review and accept the agreement
                below. Version {current.version}.
              </p>

              <div
                className="border rounded-md p-4 mb-5 max-h-[40vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  backgroundColor: "#fbfcfe",
                  color: "hsl(var(--ink-2))",
                }}
                tabIndex={0}
                aria-label={`${current.title} text`}
              >
                {current.body}
              </div>

              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "hsl(var(--ink-1))" }}
                htmlFor="agreement-signatory"
              >
                Full legal name of authorized signatory
              </label>
              <input
                id="agreement-signatory"
                type="text"
                value={signatoryName}
                onChange={(e) => setSignatoryName(e.target.value)}
                placeholder="Jane Doe"
                autoComplete="name"
                maxLength={200}
                className="w-full border rounded-md px-3 py-2 mb-4 text-sm"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-1))",
                }}
              />

              <label className="flex items-start gap-2 mb-5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5"
                />
                <span style={{ color: "hsl(var(--ink-2))" }}>
                  I have read this agreement and I am authorized to bind my
                  organization to it.
                </span>
              </label>

              {accept.isError && (
                <p
                  className="text-sm mb-4"
                  style={{ color: "#b91c1c" }}
                  role="alert"
                  aria-live="polite"
                >
                  We couldn't record your acceptance. If this account isn't an
                  owner, an organization owner must sign these agreements.
                  Otherwise, please try again.
                </p>
              )}

              <button
                type="button"
                onClick={onAccept}
                disabled={
                  !signatoryName.trim() || !acknowledged || accept.isPending
                }
                aria-busy={accept.isPending}
                className="text-sm font-semibold px-5 py-2.5 rounded text-white disabled:opacity-50"
                style={{ backgroundColor: "#0a1f44" }}
              >
                {accept.isPending
                  ? "Recording…"
                  : pending.length > 1
                    ? "Accept and continue"
                    : "Accept and finish"}
              </button>
            </div>
          )}
        </div>
      </main>

      <footer
        className="text-xs px-6 py-3 border-t text-center"
        style={{
          color: "hsl(var(--ink-3))",
          backgroundColor: "#ffffff",
          borderColor: "hsl(var(--line-1))",
        }}
      >
        CareMetric Breathe · These documents are templates, not legal advice.
      </footer>
    </div>
  );
}

// Provider e-signature portal — single lazy-loaded chunk that owns
// everything under /provider/*. Handles its own gating against
// /api/provider/me:
//
//   * not signed in (401)        → /provider/sign-in
//   * platform / unbound host (403 provider_tenant_host_required)
//                                → org picker (session pin or deep link)
//   * signed in, not a provider  → "no access" card
//   * signed in, MFA not enrolled → /provider/mfa-setup (mandatory)
//   * signed in + enrolled       → queue / signing screens
//
// Reuses the storefront SPA's root QueryClient; the provider session
// cookie is the same pf_session set by /api/provider/auth.

import { useEffect, useState, type ReactNode } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getProviderMe,
  getProviderOrgs,
  ProviderApiError,
  selectProviderOrg,
  type ProviderMe,
  type ProviderOrgMembership,
} from "@/lib/provider/provider-api";
import { providerAuthHooks } from "@/lib/provider/provider-auth";
import { isPlatformHomeHost } from "@/lib/platform-host";
import { ProviderSignIn } from "./provider-sign-in";
import { ProviderResetPassword } from "./provider-reset-password";
import { ProviderMfaSetup } from "./provider-mfa-setup";
import { ProviderQueue } from "./provider-queue";
import { ProviderSignDocument } from "./provider-sign-document";
import { ProviderPatients } from "./provider-patients";
import { ProviderReferrals } from "./provider-referrals";
import { ProviderReferralDetail } from "./provider-referral-detail";
import { ProviderPatientDetail } from "./provider-patient-detail";
import { Button, Card, ProviderAuthLayout, Spinner } from "./provider-ui";

function NoAccess() {
  const signOut = providerAuthHooks.useSignOut();
  return (
    <ProviderAuthLayout>
      <Card className="p-6 text-center">
        <h1 className="text-xl font-bold text-slate-900">No portal access</h1>
        <p className="mt-2 text-sm text-slate-500">
          This account isn't set up for the provider portal. If you believe this
          is a mistake, please contact the practice.
        </p>
        <Button
          variant="secondary"
          className="mt-5"
          onClick={() =>
            signOut.mutate(undefined, {
              onSettled: () => window.location.assign("/provider/sign-in"),
            })
          }
        >
          Sign out
        </Button>
      </Card>
    </ProviderAuthLayout>
  );
}

/**
 * Platform / unbound host without a session pin: pick a linked DME (pins
 * provider_active_org_id) or deep-link to a verified tenant portal.
 * Never shows seed-tenant PHI — /me already refused without a pin.
 */
function WrongTenantHost() {
  const signOut = providerAuthHooks.useSignOut();
  const queryClient = useQueryClient();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [autoTried, setAutoTried] = useState(false);

  const orgs = useQuery({
    queryKey: ["provider", "orgs"],
    queryFn: getProviderOrgs,
    retry: false,
  });

  const linked: ProviderOrgMembership[] = orgs.data?.orgs ?? [];
  const withPortal = linked.filter((o) => o.hasVerifiedPortal && o.portalUrl);

  async function pinOrg(orgId: string) {
    setSelectError(null);
    setSelectingId(orgId);
    try {
      await selectProviderOrg(orgId);
      await queryClient.invalidateQueries({ queryKey: ["provider", "me"] });
      await queryClient.invalidateQueries({ queryKey: ["provider", "orgs"] });
    } catch (err) {
      const message =
        err instanceof ProviderApiError
          ? err.message
          : "Could not open that practice. Try again.";
      setSelectError(message);
    } finally {
      setSelectingId(null);
    }
  }

  // Single membership: open on this site without an extra click.
  const soleOrgId =
    !orgs.isPending && !orgs.isError && linked.length === 1
      ? linked[0]!.orgId
      : null;
  useEffect(() => {
    if (autoTried || soleOrgId == null) return;
    setAutoTried(true);
    void pinOrg(soleOrgId);
    // One-shot: pinOrg identity is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auto-select once
  }, [autoTried, soleOrgId]);

  return (
    <ProviderAuthLayout>
      <Card
        className="p-6 text-center"
        data-testid="provider-wrong-tenant-host"
      >
        <h1 className="text-xl font-bold text-slate-900">
          Choose a DME practice
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          This address is the CareMetric Breathe platform home. Select a linked
          practice to open its signature queue and patient views here, or
          continue on the practice&apos;s own verified domain.
        </p>

        {orgs.isPending || (linked.length === 1 && selectingId) ? (
          <div className="mt-5">
            <Spinner label="Opening your practice…" />
          </div>
        ) : orgs.isError ? (
          <p className="mt-4 text-sm text-slate-500">
            Couldn&apos;t load your linked practices. Use the portal URL from
            your invitation email, or try again after signing out.
          </p>
        ) : linked.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No linked DME practices yet. Ask your DME to send a provider portal
            invitation.
          </p>
        ) : (
          <ul
            className="mt-5 space-y-2 text-left"
            data-testid="provider-org-select"
          >
            {linked.map((org) => (
              <li key={org.dmeLinkId} className="space-y-1">
                <button
                  type="button"
                  disabled={selectingId != null}
                  data-testid={`provider-org-select-${org.orgId}`}
                  className="block w-full rounded border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-60"
                  onClick={() => void pinOrg(org.orgId)}
                >
                  {selectingId === org.orgId
                    ? `Opening ${org.name}…`
                    : `Open ${org.name} on this site`}
                </button>
                {org.hasVerifiedPortal && org.portalUrl ? (
                  <a
                    href={org.portalUrl}
                    className="block px-1 text-xs text-slate-500 underline-offset-2 hover:underline"
                    data-testid="provider-org-deeplink"
                  >
                    Or continue on {org.name}&apos;s domain
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {selectError ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {selectError}
          </p>
        ) : null}

        {withPortal.length > 0 && linked.length > 1 ? (
          <p
            className="mt-3 text-xs text-slate-400"
            data-testid="provider-org-deeplinks"
          >
            You can also open a practice on its own verified domain via the
            links above.
          </p>
        ) : null}

        <Button
          variant="secondary"
          className="mt-5"
          onClick={() =>
            signOut.mutate(undefined, {
              onSettled: () => window.location.assign("/provider/sign-in"),
            })
          }
        >
          Sign out
        </Button>
      </Card>
    </ProviderAuthLayout>
  );
}
function isWrongTenantHostError(error: unknown): boolean {
  if (error instanceof ProviderApiError) {
    if (error.code === "provider_tenant_host_required") return true;
    // Defense in depth: platform hosts should never show a generic "no access"
    // card when the API refused tenant context.
    if (error.status === 403 && isPlatformHomeHost()) return true;
  }
  return false;
}

/** Run the /me gate, then render the children with the resolved
 *  identity. `allowUnenrolled` lets the MFA-setup screen render even
 *  before enrollment (otherwise it would redirect to itself). */
function Gated({
  allowUnenrolled,
  render,
}: {
  allowUnenrolled?: boolean;
  render: (me: ProviderMe) => ReactNode;
}) {
  const me = useQuery({
    queryKey: ["provider", "me"],
    queryFn: getProviderMe,
    retry: false,
  });

  if (me.isPending) {
    return (
      <ProviderAuthLayout>
        <Spinner label="Loading…" />
      </ProviderAuthLayout>
    );
  }
  if (me.isError) {
    const status = me.error instanceof ProviderApiError ? me.error.status : 500;
    if (status === 401) return <Redirect to="/provider/sign-in" />;
    if (isWrongTenantHostError(me.error)) return <WrongTenantHost />;
    // 403 / role mismatch → genuinely no access.
    if (status === 403) return <NoAccess />;
    // 5xx or network failure → transient error, not an access decision.
    return (
      <ProviderAuthLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">
            Couldn't connect to the portal
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            There was a temporary problem loading your account. Please try
            again.
          </p>
          <Button
            variant="secondary"
            className="mt-5"
            onClick={() => void me.refetch()}
          >
            Try again
          </Button>
        </Card>
      </ProviderAuthLayout>
    );
  }
  if (!me.data.account.mfaEnrolled && !allowUnenrolled) {
    return <Redirect to="/provider/mfa-setup" />;
  }
  return <>{render(me.data)}</>;
}

export function ProviderPortalRoute() {
  const [, setLocation] = useLocation();
  return (
    <Switch>
      <Route path="/provider/sign-in">
        <ProviderSignIn />
      </Route>
      <Route path="/provider/reset-password">
        <ProviderResetPassword />
      </Route>
      <Route path="/provider/mfa-setup">
        <Gated
          allowUnenrolled
          render={(me) =>
            me.account.mfaEnrolled ? (
              <Redirect to="/provider" />
            ) : (
              <ProviderMfaSetup providerName={me.provider?.legalName} />
            )
          }
        />
      </Route>
      <Route path="/provider/sign/:id">
        {(params: { id: string }) => (
          <Gated
            render={(me) => (
              <ProviderSignDocument
                id={params.id}
                providerName={me.provider?.legalName}
              />
            )}
          />
        )}
      </Route>
      <Route path="/provider/referrals/:id">
        {(params: { id: string }) => (
          <Gated
            render={(me) => (
              <ProviderReferralDetail
                id={params.id}
                providerName={me.provider?.legalName}
              />
            )}
          />
        )}
      </Route>
      <Route path="/provider/referrals">
        <Gated
          render={(me) => (
            <ProviderReferrals providerName={me.provider?.legalName} />
          )}
        />
      </Route>
      <Route path="/provider/patients/:id">
        {(params: { id: string }) => (
          <Gated
            render={(me) => (
              <ProviderPatientDetail
                id={params.id}
                providerName={me.provider?.legalName}
              />
            )}
          />
        )}
      </Route>
      <Route path="/provider/patients">
        <Gated
          render={(me) => (
            <ProviderPatients providerName={me.provider?.legalName} />
          )}
        />
      </Route>
      <Route path="/provider">
        <Gated
          render={(me) => (
            <ProviderQueue providerName={me.provider?.legalName} />
          )}
        />
      </Route>
      {/* Any other /provider/* path → queue. */}
      <Route>
        {() => {
          setLocation("/provider");
          return null;
        }}
      </Route>
    </Switch>
  );
}

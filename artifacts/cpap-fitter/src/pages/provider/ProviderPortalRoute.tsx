// Provider e-signature portal — single lazy-loaded chunk that owns
// everything under /provider/*. Handles its own gating against
// /api/provider/me:
//
//   * not signed in (401)        → /provider/sign-in
//   * platform / unbound host (403 provider_tenant_host_required)
//                                → "use your DME's portal URL" card
//   * signed in, not a provider  → "no access" card
//   * signed in, MFA not enrolled → /provider/mfa-setup (mandatory)
//   * signed in + enrolled       → queue / signing screens
//
// Reuses the storefront SPA's root QueryClient; the provider session
// cookie is the same pf_session set by /api/provider/auth.

import type { ReactNode } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

import {
  getProviderMe,
  getProviderOrgs,
  ProviderApiError,
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

/** Platform / unbound host: queue and RTM refuse seed-org soft-fallback. */
function WrongTenantHost() {
  const signOut = providerAuthHooks.useSignOut();
  const orgs = useQuery({
    queryKey: ["provider", "orgs"],
    queryFn: getProviderOrgs,
    retry: false,
  });

  const linked: ProviderOrgMembership[] = orgs.data?.orgs ?? [];
  const withPortal = linked.filter((o) => o.hasVerifiedPortal && o.portalUrl);
  const withoutPortal = linked.filter((o) => !o.hasVerifiedPortal);

  return (
    <ProviderAuthLayout>
      <Card
        className="p-6 text-center"
        data-testid="provider-wrong-tenant-host"
      >
        <h1 className="text-xl font-bold text-slate-900">
          Open your DME&apos;s provider portal
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          This address is the CareMetric Breathe platform home. Signature queues
          and patient therapy views are available only on your DME&apos;s own
          verified domain — not here.
        </p>

        {orgs.isPending ? (
          <div className="mt-5">
            <Spinner label="Looking up your practices…" />
          </div>
        ) : orgs.isError ? (
          <p className="mt-4 text-sm text-slate-500">
            Couldn&apos;t load your linked practices. Use the portal URL from
            your invitation email, or try again after signing out.
          </p>
        ) : withPortal.length > 0 ? (
          <ul
            className="mt-5 space-y-2 text-left"
            data-testid="provider-org-deeplinks"
          >
            {withPortal.map((org) => (
              <li key={org.dmeLinkId}>
                <a
                  href={org.portalUrl!}
                  className="block rounded border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                >
                  Continue to {org.name}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            {linked.length === 0
              ? "No linked DME practices yet. Ask your DME to send a provider portal invitation."
              : "Your linked practices do not have a verified portal domain yet. Ask the practice to finish domain setup, or use the URL from your invitation email."}
          </p>
        )}

        {withoutPortal.length > 0 && withPortal.length > 0 ? (
          <p className="mt-3 text-xs text-slate-400">
            {withoutPortal.length} linked practice
            {withoutPortal.length === 1 ? "" : "s"} without a verified portal
            domain
            {withoutPortal.length <= 3
              ? `: ${withoutPortal.map((o) => o.name).join(", ")}`
              : ""}
            .
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

// Provider e-signature portal — single lazy-loaded chunk that owns
// everything under /provider/*. Handles its own gating against
// /api/provider/me:
//
//   * not signed in (401)        → /provider/sign-in
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
  ProviderApiError,
  type ProviderMe,
} from "@/lib/provider/provider-api";
import { providerAuthHooks } from "@/lib/provider/provider-auth";
import { ProviderSignIn } from "./provider-sign-in";
import { ProviderMfaSetup } from "./provider-mfa-setup";
import { ProviderQueue } from "./provider-queue";
import { ProviderSignDocument } from "./provider-sign-document";
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

import { useQuery } from "@tanstack/react-query";
import { Link, Redirect, useLocation } from "wouter";
import { fetchAdminMe, AdminApiError } from "@/lib/admin-api";
import { AdminLayout } from "@/components/admin-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldOff } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SignedIn, SignedOut, useShopIdentity } from "@/lib/identity";

/**
 * Build the `/sign-in` URL that returns the user to the admin route
 * they were trying to reach. Centralized so the signed-out branch and
 * the 401-from-/admin/me branch can't drift apart.
 */
function getSignInTarget(location: string): string {
  return `/sign-in?redirect=${encodeURIComponent(location || "/admin")}`;
}

/**
 * AdminShell — wraps an admin page with two layered checks:
 *
 *   1. Signed-out users get redirected to /sign-in (via the
 *      identity shim's <SignedOut>). The current admin path is
 *      forwarded as `?redirect=` so the auth provider returns the
 *      user to the page they were trying to reach (e.g.
 *      /admin/orders) instead of the global
 *      `signInFallbackRedirectUrl` (which is /account, the patient
 *      page). We deliberately do NOT redirect from "/" — only from
 *      /admin*.
 *
 *   2. Signed-in users hit /api/admin/me to verify they're on the
 *      PENN_ADMIN_EMAILS allowlist (in Clerk mode) or that
 *      auth.users.role is admin/agent (in in-house mode). If not,
 *      we render a "not authorized" page instead of the admin UI.
 *
 * The signed-in admin's email is then passed down to AdminLayout for
 * display in the sidebar.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  // Pass the current admin path through to /sign-in so the auth provider's
  // post-auth redirect lands the user back on the page they were trying to
  // reach (e.g. /admin/orders) instead of falling through to the
  // global signInFallbackRedirectUrl, which is /account. Without this,
  // an admin who clicks an /admin link while signed-out gets bounced to
  // the patient account page after authenticating, where the
  // session-not-yet-propagated race produces a misleading "Your account
  // info couldn't load" error.
  const [location] = useLocation();
  const signInTarget = getSignInTarget(location);
  return (
    <>
      <SignedOut>
        <Redirect to={signInTarget} />
      </SignedOut>
      <SignedIn>
        <AdminAuthorizedShell>{children}</AdminAuthorizedShell>
      </SignedIn>
    </>
  );
}

function AdminAuthorizedShell({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useShopIdentity();
  const [location] = useLocation();
  const signInTarget = getSignInTarget(location);
  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: fetchAdminMe,
    enabled: isLoaded,
    retry: false,
  });

  // Title precedence is intentionally NOT shared between this shell
  // and child admin pages — that would create a useEffect ordering
  // hazard (children mount before parents in React, so the parent's
  // title hook would run last and clobber e.g. "Admin · Orders" with
  // "Admin"). Instead, each non-child branch below renders a tiny
  // sub-shell component that owns the "Admin" title for that state,
  // and child pages own their own (e.g. "Admin · Orders") with no
  // overlap.

  if (!isLoaded || me.isLoading) {
    return <AdminLoadingShell />;
  }

  if (me.error) {
    const status = me.error instanceof AdminApiError ? me.error.status : 0;
    if (status === 403 || status === 503) {
      return <NotAuthorized status={status} message={(me.error as Error).message} />;
    }
    if (status === 401) {
      return <Redirect to={signInTarget} />;
    }
    return <AdminErrorShell error={me.error as Error} />;
  }

  return (
    <AdminLayout
      adminEmail={me.data?.email ?? null}
      adminRole={me.data?.role ?? "admin"}
    >
      {children}
    </AdminLayout>
  );
}

function AdminLoadingShell() {
  useDocumentTitle("Admin");
  return (
    <AdminLayout adminEmail={null}>
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    </AdminLayout>
  );
}

function AdminErrorShell({ error }: { error: Error }) {
  useDocumentTitle("Admin");
  return (
    <AdminLayout adminEmail={null}>
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-8 text-sm text-destructive">
          Could not verify admin access: {error.message}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}

function NotAuthorized({ status, message }: { status: number; message: string }) {
  useDocumentTitle("Admin");
  return (
    <div className="container max-w-2xl mx-auto px-4 py-16">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
            <ShieldOff className="w-6 h-6" />
          </div>
          <CardTitle className="text-2xl tracking-tight">
            {status === 503 ? "Admin not configured" : "Not authorized"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-muted-foreground">{message}</p>
          <p className="text-sm text-muted-foreground">
            If you should have access, ask your PennPaps administrator to add
            your email to the <code className="font-mono">PENN_ADMIN_EMAILS</code> allowlist.
          </p>
          <Link href="/">
            <Button variant="outline">Back to PennPaps</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

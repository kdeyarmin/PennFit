import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import { Show, useUser } from "@clerk/react";
import { fetchAdminMe, AdminApiError } from "@/lib/admin-api";
import { AdminLayout } from "@/components/admin-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldOff } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * AdminShell — wraps an admin page with two layered checks:
 *
 *   1. Signed-out users get redirected to /sign-in (Clerk's `<Show>`).
 *      We deliberately do NOT redirect from "/" — only from /admin*.
 *
 *   2. Signed-in users hit /api/admin/me to verify they're on the
 *      PENN_ADMIN_EMAILS allowlist. If not, we render a "not authorized"
 *      page instead of the admin UI. This second check is the
 *      authoritative one — Clerk gives us identity, the server gives us
 *      authorization.
 *
 * The signed-in admin's email is then passed down to AdminLayout for
 * display in the sidebar.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
      <Show when="signed-in">
        <AdminAuthorizedShell>{children}</AdminAuthorizedShell>
      </Show>
    </>
  );
}

function AdminAuthorizedShell({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useUser();
  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: fetchAdminMe,
    enabled: isLoaded,
    retry: false,
  });

  // Set <title> for admin pages so it's clear in the tab bar.
  useEffect(() => {
    const prev = document.title;
    document.title = "PennPaps · Admin";
    return () => {
      document.title = prev;
    };
  }, []);

  if (!isLoaded || me.isLoading) {
    return (
      <AdminLayout adminEmail={null}>
        <div className="space-y-4">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-32 w-full" />
        </div>
      </AdminLayout>
    );
  }

  if (me.error) {
    const status = me.error instanceof AdminApiError ? me.error.status : 0;
    if (status === 403 || status === 503) {
      return <NotAuthorized status={status} message={(me.error as Error).message} />;
    }
    if (status === 401) {
      return <Redirect to="/sign-in" />;
    }
    return (
      <AdminLayout adminEmail={null}>
        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="p-8 text-sm text-destructive">
            Could not verify admin access: {(me.error as Error).message}
          </CardContent>
        </Card>
      </AdminLayout>
    );
  }

  return <AdminLayout adminEmail={me.data?.email ?? null}>{children}</AdminLayout>;
}

function NotAuthorized({ status, message }: { status: number; message: string }) {
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

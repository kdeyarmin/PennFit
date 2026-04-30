import React from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, ListOrdered, ScrollText, LogOut, ShieldCheck, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminConsoleSwitcher } from "@/components/admin-console-switcher";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/orders", label: "Orders", icon: ListOrdered, exact: false },
  { href: "/admin/reminders", label: "Reminders", icon: Bell, exact: false },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText, exact: false },
];

function isActive(currentPath: string, href: string, exact: boolean): boolean {
  if (exact) return currentPath === href;
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export function AdminLayout({
  children,
  adminEmail,
  adminRole = "admin",
}: {
  children: React.ReactNode;
  adminEmail: string | null;
  /**
   * Caller's role. Drives the visual badge in the sidebar so an
   * operator can tell at a glance whether they are signed in with
   * full admin privileges or as a customer-service agent. Defaults
   * to "admin" for backward compatibility (older callers that
   * don't pass this prop are unchanged).
   */
  adminRole?: "admin" | "agent";
}) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const displayEmail =
    adminEmail ??
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    "";
  const isAdmin = adminRole === "admin";

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-background">
      <div className="container mx-auto px-4 py-6 md:py-10">
        <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
          {/* Sidebar */}
          <aside className="space-y-1">
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg glass-panel">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <div className="text-xs min-w-0 flex-1">
                <div className="font-semibold tracking-tight flex items-center gap-2">
                  <span>Admin Console</span>
                  <span
                    className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      isAdmin
                        ? "bg-primary text-primary-foreground"
                        : "bg-amber-100 text-amber-900 border border-amber-400"
                    }`}
                    title={
                      isAdmin
                        ? "Full admin — all operations available"
                        : "Customer-service agent — destructive deletes are disabled"
                    }
                    data-testid="admin-role-badge"
                  >
                    {isAdmin ? "Admin" : "Agent"}
                  </span>
                </div>
                <div className="text-muted-foreground truncate" title={displayEmail}>
                  {displayEmail || "—"}
                </div>
              </div>
            </div>
            <AdminConsoleSwitcher />
            <nav className="space-y-1" aria-label="Admin navigation">
              {navItems.map((item) => {
                const active = isActive(location, item.href, item.exact);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-foreground"
                    }`}
                    data-testid={`admin-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="pt-4 border-t border-border/50 mt-4">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-muted-foreground"
                onClick={() => signOut({ redirectUrl: basePath || "/" })}
                data-testid="button-admin-signout"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </Button>
            </div>
          </aside>

          {/* Content */}
          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}

import React from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, ListOrdered, ScrollText, LogOut, ShieldCheck, Bell, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminConsoleSwitcher } from "@/components/admin-console-switcher";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Sidebar nav items.
 *
 * Each entry pairs a short `label` (the link text) with a one-line
 * `description` that renders underneath. The description is the
 * single most useful UX upgrade for non-technical operators: it
 * tells a customer-service rep what each section is for *before*
 * they click, instead of forcing them to learn the layout by
 * exploration.
 *
 * Ordering reflects daily usage: dashboard → orders → reminders →
 * team → audit log.
 *
 * `adminOnly: true` items are filtered out of the sidebar when the
 * caller's role is "agent". The page itself still renders read-only
 * if an agent navigates there directly via URL — hiding it from the
 * nav just keeps the daily-use surface uncluttered for roles that
 * can't act on it.
 */
const navItems: ReadonlyArray<{
  href: string;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
  exact: boolean;
  adminOnly?: boolean;
}> = [
  {
    href: "/admin",
    label: "Dashboard",
    description: "Daily snapshot of orders and shopper activity.",
    icon: LayoutDashboard,
    exact: true,
  },
  {
    href: "/admin/orders",
    label: "Orders",
    description: "Search and open individual customer orders.",
    icon: ListOrdered,
    exact: false,
  },
  {
    href: "/admin/reminders",
    label: "Reminders",
    description: "Send batched email or text reminders.",
    icon: Bell,
    exact: false,
  },
  {
    href: "/admin/users",
    label: "Team",
    description: "Invite teammates and manage who has access.",
    icon: Users,
    exact: false,
    adminOnly: true,
  },
  {
    href: "/admin/audit",
    label: "Activity history",
    description: "See who did what — orders viewed, reminders sent.",
    icon: ScrollText,
    exact: false,
  },
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
              {navItems
                .filter((item) => !item.adminOnly || isAdmin)
                .map((item) => {
                const active = isActive(location, item.href, item.exact);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={item.description}
                    className={`flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-foreground"
                    }`}
                    data-testid={`admin-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-tight">
                        {item.label}
                      </span>
                      <span
                        className={`block text-[11px] leading-snug mt-0.5 ${
                          active
                            ? "text-primary-foreground/80"
                            : "text-muted-foreground"
                        }`}
                      >
                        {item.description}
                      </span>
                    </span>
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

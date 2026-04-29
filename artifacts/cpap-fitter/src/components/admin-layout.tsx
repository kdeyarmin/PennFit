import React from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, ListOrdered, ScrollText, LogOut, ShieldCheck, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

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
}: {
  children: React.ReactNode;
  adminEmail: string | null;
}) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const displayEmail =
    adminEmail ??
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    "";

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-background">
      <div className="container mx-auto px-4 py-6 md:py-10">
        <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
          {/* Sidebar */}
          <aside className="space-y-1">
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg glass-panel">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <div className="text-xs">
                <div className="font-semibold tracking-tight">Admin Console</div>
                <div className="text-muted-foreground truncate" title={displayEmail}>
                  {displayEmail || "—"}
                </div>
              </div>
            </div>
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

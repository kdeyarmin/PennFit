// Real unit tests for the extracted nav-traversal logic.
//
// These import the ACTUAL functions AppShell uses (not a verbatim copy),
// so the route-reachability rules — active-tab selection, permission
// gating, where a sidebar entry lands, badge roll-ups — are pinned to the
// shipping implementation and can't silently drift. The cpap-fitter vitest
// env is "node" (no jsdom), but these helpers are pure so no render is
// needed; we pass a dummy icon to satisfy the NavLink/NavSection type.

import { describe, expect, it } from "vitest";
import type { ComponentType, SVGProps } from "react";

import type { AdminInboxCounts } from "@/lib/admin/inbox-counts-api";
import {
  findGroupForActiveHref,
  flattenTargets,
  linkMatchesLocation,
  pickActiveHref,
  pickActiveTarget,
  sectionBadgeCount,
  sectionLandingHref,
  sectionVisible,
  visibleTabs,
  type NavGroup,
  type NavLink,
  type NavSection,
} from "./nav-traversal";

// A throwaway icon — the helpers never render it, they only carry the type.
const Icon = (() => null) as unknown as ComponentType<SVGProps<SVGSVGElement>>;

function link(partial: Partial<NavLink> & { href: string }): NavLink {
  return { label: partial.href, icon: Icon, ...partial };
}
function section(partial: Partial<NavSection> & { label: string }): NavSection {
  return { icon: Icon, ...partial };
}

// Fixture mirroring the real grouping shape: a tabbed "Home", a
// permission-gated "Outreach", a single-page "Patients", and a billing
// group with a landing + a tabbed worklist.
const GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Workspace",
    items: [
      section({
        label: "Home",
        tabs: [
          link({ href: "/admin", label: "Dashboard", matchPrefix: "/admin" }),
          link({ href: "/admin/today", label: "My Today" }),
        ],
      }),
      section({
        label: "Outreach",
        tabs: [
          link({ href: "/admin/bulk-campaigns", label: "Bulk Campaigns" }),
          link({
            href: "/admin/macros",
            label: "Canned Replies",
            requiredPermission: "admin.tools.manage",
          }),
        ],
      }),
    ],
  },
  {
    label: "Patients & Clinical",
    items: [
      section({
        label: "Patients",
        href: "/admin/patients",
        matchPrefix: "/admin/patients",
      }),
    ],
  },
  {
    label: "Billing",
    items: [
      section({
        label: "Billing Hub",
        href: "/admin/billing",
        matchPrefix: "/admin/billing",
      }),
      section({
        label: "Worklists",
        tabs: [
          link({ href: "/admin/billing/ai-queue", label: "AI queue" }),
          link({ href: "/admin/billing/eligibility", label: "Eligibility" }),
        ],
      }),
    ],
  },
];

describe("linkMatchesLocation", () => {
  it("treats /admin (Dashboard) as exact, never a /admin/* prefix", () => {
    expect(linkMatchesLocation("/admin", "/admin")).toBe(true);
    expect(linkMatchesLocation("/admin/", "/admin")).toBe(true);
    expect(linkMatchesLocation("/admin/patients", "/admin")).toBe(false);
  });

  it("matches exact and detail routes for a normal prefix", () => {
    expect(linkMatchesLocation("/admin/patients", "/admin/patients")).toBe(
      true,
    );
    expect(linkMatchesLocation("/admin/patients/123", "/admin/patients")).toBe(
      true,
    );
    expect(
      linkMatchesLocation("/admin/patients-archive", "/admin/patients"),
    ).toBe(false);
  });
});

describe("flattenTargets", () => {
  it("flattens every tab and single-page entry with back-references", () => {
    const flat = flattenTargets(GROUPS);
    // 2 Home tabs + 2 Outreach tabs + Patients + Billing Hub + 2 Worklist tabs
    expect(flat).toHaveLength(8);
    const patients = flat.find((t) => t.href === "/admin/patients");
    expect(patients?.section.label).toBe("Patients");
    expect(patients?.group.label).toBe("Patients & Clinical");
    expect(patients?.tab).toBeUndefined();
    const aiQueue = flat.find((t) => t.href === "/admin/billing/ai-queue");
    expect(aiQueue?.tab?.label).toBe("AI queue");
    expect(aiQueue?.group.label).toBe("Billing");
  });
});

describe("pickActiveTarget — longest-prefix wins", () => {
  it("selects the deeper tab over the section landing", () => {
    const t = pickActiveTarget("/admin/billing/ai-queue", GROUPS);
    expect(t?.section.label).toBe("Worklists");
    expect(t?.tab?.label).toBe("AI queue");
  });

  it("keeps the section landing active on the bare prefix", () => {
    const t = pickActiveTarget("/admin/billing", GROUPS);
    expect(t?.section.label).toBe("Billing Hub");
  });

  it("treats /admin (Dashboard) as exact — /admin/patients picks Patients", () => {
    expect(pickActiveTarget("/admin", GROUPS)?.section.label).toBe("Home");
    expect(pickActiveTarget("/admin/patients", GROUPS)?.section.label).toBe(
      "Patients",
    );
  });

  it("matches a detail route via its tab prefix", () => {
    const t = pickActiveTarget("/admin/billing/eligibility/123", GROUPS);
    expect(t?.tab?.label).toBe("Eligibility");
  });

  it("returns null when nothing matches", () => {
    expect(pickActiveTarget("/admin/nope", GROUPS)).toBeNull();
  });
});

describe("pickActiveHref", () => {
  it("returns the active tab href for a tabbed section", () => {
    expect(pickActiveHref("/admin/billing/ai-queue", GROUPS)).toBe(
      "/admin/billing/ai-queue",
    );
  });

  it("returns the single-page href for a non-tabbed section", () => {
    expect(pickActiveHref("/admin/patients/5", GROUPS)).toBe("/admin/patients");
  });

  it("returns null when no target matches", () => {
    expect(pickActiveHref("/admin/nope", GROUPS)).toBeNull();
  });
});

describe("findGroupForActiveHref", () => {
  it("returns null for a null active href", () => {
    expect(findGroupForActiveHref(GROUPS, null)).toBeNull();
  });

  it("finds the group owning a tab href", () => {
    expect(findGroupForActiveHref(GROUPS, "/admin/billing/ai-queue")).toBe(
      "Billing",
    );
  });

  it("finds the group owning a single-page href", () => {
    expect(findGroupForActiveHref(GROUPS, "/admin/patients")).toBe(
      "Patients & Clinical",
    );
  });

  it("returns null for an href not in any group", () => {
    expect(findGroupForActiveHref(GROUPS, "/admin/unknown")).toBeNull();
    expect(findGroupForActiveHref([], "/admin/patients")).toBeNull();
  });
});

describe("permission gating — visibleTabs / sectionVisible / sectionLandingHref", () => {
  const csr = new Set<string>(); // lacks admin.tools.manage
  const admin = new Set<string>(["admin.tools.manage"]);
  const outreach = GROUPS[0]!.items[1]!;

  it("hides permission-gated tabs for a CSR", () => {
    expect(visibleTabs(outreach, csr).map((t) => t.label)).toEqual([
      "Bulk Campaigns",
    ]);
    expect(visibleTabs(outreach, admin).map((t) => t.label)).toEqual([
      "Bulk Campaigns",
      "Canned Replies",
    ]);
  });

  it("lands the entry on the first tab the caller can see (never a 403)", () => {
    expect(sectionLandingHref(outreach, csr)).toBe("/admin/bulk-campaigns");
    expect(sectionLandingHref(outreach, admin)).toBe("/admin/bulk-campaigns");
  });

  it("returns the single-page href as the landing for a non-tabbed entry", () => {
    expect(sectionLandingHref(GROUPS[1]!.items[0]!, csr)).toBe(
      "/admin/patients",
    );
  });

  it("keeps a section visible while >=1 tab is visible", () => {
    expect(sectionVisible(outreach, csr)).toBe(true);
  });

  it("hides a section whose every tab is gated away", () => {
    const locked = section({
      label: "Locked",
      tabs: [
        link({ href: "/admin/x", label: "X", requiredPermission: "nope" }),
      ],
    });
    expect(sectionVisible(locked, csr)).toBe(false);
  });

  it("hides a section gated by its own requiredPermission", () => {
    const gated = section({
      label: "Owner-only",
      href: "/admin/owner",
      requiredPermission: "owner.only",
    });
    expect(sectionVisible(gated, csr)).toBe(false);
    expect(sectionVisible(gated, new Set(["owner.only"]))).toBe(true);
  });

  it("always shows an ungated single-page entry", () => {
    expect(sectionVisible(GROUPS[1]!.items[0]!, csr)).toBe(true);
  });
});

describe("sectionBadgeCount — own badge + rolled-up visible-tab badges", () => {
  const counts: AdminInboxCounts = {
    awaitingReplyConversations: 3,
    pendingReturns: 0,
    pendingReviews: 5,
    overdueFollowups: 2,
    newPatientDocuments: 0,
    newInboundFaxes: 0,
    pacwareReadyToSync: 0,
    serverTime: "2026-06-22T00:00:00.000Z",
  };
  const all = new Set<string>(["reports.read"]);

  it("sums the section's own badge with its visible tabs' badges", () => {
    const sec = section({
      label: "Worklists",
      badgeKey: "overdueFollowups", // 2
      tabs: [
        link({
          href: "/admin/a",
          label: "A",
          badgeKey: "awaitingReplyConversations",
        }), // 3
        link({ href: "/admin/b", label: "B", badgeKey: "pendingReviews" }), // 5
      ],
    });
    expect(sectionBadgeCount(sec, counts, all)).toBe(10);
  });

  it("excludes badges of tabs the caller can't see", () => {
    const sec = section({
      label: "Worklists",
      tabs: [
        link({ href: "/admin/a", label: "A", badgeKey: "pendingReviews" }), // 5, visible
        link({
          href: "/admin/secret",
          label: "Secret",
          badgeKey: "awaitingReplyConversations", // 3, gated away
          requiredPermission: "reports.write",
        }),
      ],
    });
    expect(sectionBadgeCount(sec, counts, new Set<string>())).toBe(5);
  });

  it("returns 0 when counts are undefined", () => {
    const sec = section({
      label: "X",
      badgeKey: "pendingReviews",
      tabs: [],
    });
    expect(sectionBadgeCount(sec, undefined, all)).toBe(0);
  });
});

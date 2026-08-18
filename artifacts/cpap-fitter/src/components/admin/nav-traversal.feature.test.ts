// App-module nav filtering — the mechanism that makes "turn a part of
// the app off" actually remove it from the console.
//
// These exercise the real exported functions (not a mirrored
// re-implementation), because the failure mode that matters here is
// silent: a group that should have vanished quietly staying, or — much
// worse — an over-broad filter emptying a sidebar it shouldn't touch.

import { describe, it, expect } from "vitest";
import { Home } from "lucide-react";

import {
  featureHidingLocation,
  filterNavGroupsByFeature,
  pickActiveHref,
  sectionVisible,
  type NavGroup,
} from "./nav-traversal";

const GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Workspace",
    items: [
      { label: "Home", icon: Home, href: "/admin", matchPrefix: "/admin" },
      {
        label: "Front Desk",
        icon: Home,
        href: "/admin/front-desk",
        requiredFeature: "module.front_desk",
      },
      {
        label: "Schedule",
        icon: Home,
        requiredFeature: "module.schedule",
        tabs: [
          { href: "/admin/company-calendar", label: "Calendar", icon: Home },
          { href: "/admin/video-visits", label: "Video visits", icon: Home },
        ],
      },
    ],
  },
  {
    label: "Billing",
    requiredFeature: "module.billing",
    items: [
      {
        label: "Worklists",
        icon: Home,
        tabs: [
          { href: "/admin/billing/verify", label: "Verify", icon: Home },
          {
            href: "/admin/billing/adr",
            label: "ADR",
            icon: Home,
            requiredFeature: "billing.adr_queue",
          },
        ],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Operations",
        icon: Home,
        tabs: [
          { href: "/admin/operations", label: "Operations", icon: Home },
          {
            href: "/admin/pacware",
            label: "PacWare",
            icon: Home,
            requiredFeature: "module.integrations",
          },
        ],
      },
    ],
  },
];

const labels = (groups: ReadonlyArray<NavGroup>) => groups.map((g) => g.label);
const sectionLabels = (groups: ReadonlyArray<NavGroup>, group: string) =>
  groups.find((g) => g.label === group)?.items.map((i) => i.label) ?? [];

describe("filterNavGroupsByFeature", () => {
  it("returns the nav untouched when nothing is disabled", () => {
    const out = filterNavGroupsByFeature(GROUPS, new Set());
    // Identity, not a copy — an empty disabled set is the overwhelmingly
    // common case (and the fail-safe the API reports on a read error), so
    // it must not churn referential equality on every render.
    expect(out).toBe(GROUPS);
  });

  it("drops a whole group when the group's module is off", () => {
    const out = filterNavGroupsByFeature(GROUPS, new Set(["module.billing"]));
    expect(labels(out)).toEqual(["Workspace", "System"]);
  });

  it("drops a single-page section when its module is off", () => {
    const out = filterNavGroupsByFeature(
      GROUPS,
      new Set(["module.front_desk"]),
    );
    expect(sectionLabels(out, "Workspace")).toEqual(["Home", "Schedule"]);
  });

  it("drops a tabbed section when its module is off", () => {
    const out = filterNavGroupsByFeature(GROUPS, new Set(["module.schedule"]));
    expect(sectionLabels(out, "Workspace")).toEqual(["Home", "Front Desk"]);
  });

  it("drops an individual tab without removing its section", () => {
    const out = filterNavGroupsByFeature(
      GROUPS,
      new Set(["module.integrations"]),
    );
    const ops = out
      .find((g) => g.label === "System")
      ?.items.find((i) => i.label === "Operations");
    expect(ops?.tabs?.map((t) => t.href)).toEqual(["/admin/operations"]);
  });

  it("removes a section left with no tabs at all", () => {
    // Both Operations tabs gone → the section has nothing to land on, so
    // the section (and with it the now-empty System group) must go too.
    const out = filterNavGroupsByFeature(
      GROUPS,
      new Set(["module.integrations", "module.schedule"]),
    );
    const opsTabsGone = filterNavGroupsByFeature(
      [
        {
          label: "System",
          items: [
            {
              label: "Operations",
              icon: Home,
              tabs: [
                {
                  href: "/admin/pacware",
                  label: "PacWare",
                  icon: Home,
                  requiredFeature: "module.integrations",
                },
              ],
            },
          ],
        },
      ],
      new Set(["module.integrations"]),
    );
    expect(opsTabsGone).toEqual([]);
    // The mixed case above still keeps System, because /admin/operations
    // survives.
    expect(labels(out)).toContain("System");
  });

  it("never mutates the input groups", () => {
    const before = JSON.stringify(GROUPS.map((g) => g.items.length));
    filterNavGroupsByFeature(GROUPS, new Set(["module.integrations"]));
    expect(JSON.stringify(GROUPS.map((g) => g.items.length))).toBe(before);
  });

  it("leaves permission filtering alone — the two gates compose", () => {
    // A section carrying BOTH gates is hidden by either one independently.
    const groups: ReadonlyArray<NavGroup> = [
      {
        label: "System",
        items: [
          {
            label: "Gated",
            icon: Home,
            href: "/admin/gated",
            requiredFeature: "module.support",
            requiredPermission: "admin.tools.manage",
          },
        ],
      },
    ];
    // Feature on, permission missing → hidden by sectionVisible.
    const kept = filterNavGroupsByFeature(groups, new Set());
    expect(sectionVisible(kept[0]!.items[0]!, new Set())).toBe(false);
    expect(
      sectionVisible(kept[0]!.items[0]!, new Set(["admin.tools.manage"])),
    ).toBe(true);
    // Permission held, feature off → hidden by the module filter.
    expect(
      filterNavGroupsByFeature(groups, new Set(["module.support"])),
    ).toEqual([]);
  });

  it("keeps active-route resolution consistent with the filtered nav", () => {
    const out = filterNavGroupsByFeature(GROUPS, new Set(["module.billing"]));
    // The billing route is no longer a target, so nothing claims it and
    // the sidebar highlights nothing rather than the wrong entry.
    expect(pickActiveHref("/admin/billing/verify", out)).toBeNull();
    expect(pickActiveHref("/admin/billing/verify", GROUPS)).toBe(
      "/admin/billing/verify",
    );
  });
});

describe("featureHidingLocation", () => {
  it("returns null when nothing is disabled", () => {
    expect(featureHidingLocation("/admin/billing/adr", GROUPS, new Set())).toBe(
      null,
    );
  });

  it("returns null for a route that is still available", () => {
    expect(
      featureHidingLocation("/admin", GROUPS, new Set(["module.billing"])),
    ).toBe(null);
  });

  it("names the group module for a deep link into a disabled group", () => {
    expect(
      featureHidingLocation(
        "/admin/billing/verify",
        GROUPS,
        new Set(["module.billing"]),
      ),
    ).toBe("module.billing");
  });

  it("names the section module for a disabled section", () => {
    expect(
      featureHidingLocation(
        "/admin/video-visits",
        GROUPS,
        new Set(["module.schedule"]),
      ),
    ).toBe("module.schedule");
  });

  it("prefers a tab's own key over its group's", () => {
    // Both are off; the more specific one is what the notice should name,
    // because that's the switch the operator has to find.
    expect(
      featureHidingLocation(
        "/admin/billing/adr",
        GROUPS,
        new Set(["module.billing", "billing.adr_queue"]),
      ),
    ).toBe("billing.adr_queue");
  });

  it("matches child routes of a hidden page, not just the exact path", () => {
    expect(
      featureHidingLocation(
        "/admin/front-desk/new",
        GROUPS,
        new Set(["module.front_desk"]),
      ),
    ).toBe("module.front_desk");
  });

  it("does not let the bare /admin prefix swallow unrelated routes", () => {
    // "/admin" is exact-match-only; a disabled module must not make the
    // dashboard entry claim every /admin/* path.
    expect(
      featureHidingLocation(
        "/admin/somewhere-unmapped",
        GROUPS,
        new Set(["module.billing", "module.schedule"]),
      ),
    ).toBe(null);
  });
});

import { expect, it } from "vitest";
import { NAV_GROUPS } from "./AppShell";
import {
  filterNavGroupsByFeature,
  pickActiveTarget,
  sectionVisible,
} from "./nav-traversal";

it("makes the owner overview reachable only for management in the enabled analytics module", () => {
  const target = pickActiveTarget("/admin/analytics/owner", NAV_GROUPS);
  expect(target?.section.label).toBe("Owner overview");
  expect(target?.group.requiredFeature).toBe("module.analytics");
  expect(
    sectionVisible(target!.section, new Set(["metrics.read", "cost.read"])),
  ).toBe(true);
  expect(
    sectionVisible(target!.section, new Set(["cost.read", "reports.read"])),
  ).toBe(false);
  expect(
    pickActiveTarget(
      "/admin/analytics/owner",
      filterNavGroupsByFeature(NAV_GROUPS, new Set(["module.analytics"])),
    ),
  ).toBeNull();
});

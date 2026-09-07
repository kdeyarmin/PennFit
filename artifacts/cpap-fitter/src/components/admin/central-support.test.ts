import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCentralSupportUrl,
  CENTRAL_SUPPORT_EMAIL,
  CENTRAL_SUPPORT_HUB_URL,
  CENTRAL_SUPPORT_PHONE_E164,
  CENTRAL_SUPPORT_PRODUCT,
  isCentralSupportHubEnabled,
  normalizeCentralSupportEnvironment,
  normalizeCentralSupportVersion,
  safeStaticAdminNavHref,
  staticAdminSupportRoute,
} from "./central-support";
import { type NavGroup } from "./nav-traversal";

const Icon = () => null;
const NAV: ReadonlyArray<NavGroup> = [
  {
    label: "Test admin nav",
    items: [
      {
        label: "Home",
        icon: Icon,
        href: "/admin",
        matchPrefix: "/admin",
      },
      {
        label: "Patients",
        icon: Icon,
        href: "/admin/patients",
        matchPrefix: "/admin/patients",
      },
      {
        label: "Billing",
        icon: Icon,
        tabs: [
          {
            label: "ADR",
            icon: Icon,
            href: "/admin/billing/adr",
            matchPrefix: "/admin/billing/adr",
          },
          {
            label: "Office Ally",
            icon: Icon,
            href: "/admin/billing/office-ally",
            matchPrefix: "/admin/billing/office-ally",
          },
        ],
      },
      {
        label: "Support",
        icon: Icon,
        href: "/admin/support",
        matchPrefix: "/admin/support",
      },
    ],
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("central support feature flag", () => {
  it("is positive opt-in only", () => {
    expect(isCentralSupportHubEnabled("true")).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", " true "]) {
      expect(isCentralSupportHubEnabled(value)).toBe(false);
    }
  });
});

describe("staticAdminSupportRoute", () => {
  it("returns only the static admin nav destination", () => {
    expect(staticAdminSupportRoute("/admin/support", NAV)).toBe(
      "/admin/support",
    );
    expect(
      staticAdminSupportRoute(
        "/admin/patients/550e8400-e29b-41d4-a716-446655440000",
        NAV,
      ),
    ).toBe("/admin/patients");
    expect(staticAdminSupportRoute("/admin/billing/adr/123456", NAV)).toBe(
      "/admin/billing/adr",
    );
  });

  it("strips query and hash before consulting the static nav", () => {
    expect(
      staticAdminSupportRoute(
        "/admin/patients/123?patientId=secret#alice@example.com",
        NAV,
      ),
    ).toBe("/admin/patients");
  });

  it.each([
    "/help",
    "/resupply-api/admin/patients/123",
    "/admin/unknown/123",
    "https://example.com/admin/support",
    "/admin/patients/alice@example.com",
    "/admin/patients/%2fadmin%2fsupport",
    "/admin//support",
    "/admin\\support",
    `/admin/${"a".repeat(600)}`,
  ])("omits unsafe or unknown location %s", (location) => {
    expect(staticAdminSupportRoute(location, NAV)).toBeUndefined();
  });

  it("does not let bare /admin claim an unknown child route", () => {
    expect(
      staticAdminSupportRoute("/admin/not-in-the-nav", NAV),
    ).toBeUndefined();
  });
});

describe("central Support Hub URL", () => {
  it("uses the production Hub, Breathe product, and approved metadata only", () => {
    const built = new URL(
      buildCentralSupportUrl({
        staticRoute: "/admin/patients",
        appVersion: "4f3556552e5e7cf6c7831c6cf6dfcc58eb385335",
        environment: "production",
      }),
    );

    expect(built.origin).toBe(new URL(CENTRAL_SUPPORT_HUB_URL).origin);
    expect(built.pathname).toBe("/help");
    expect(Object.fromEntries(built.searchParams)).toEqual({
      product: CENTRAL_SUPPORT_PRODUCT,
      route: "/admin/patients",
      app_version: "4f3556552e5e7cf6c7831c6cf6dfcc58eb385335",
      environment: "production",
    });
    expect([...built.searchParams.keys()].sort()).toEqual(
      ["app_version", "environment", "product", "route"].sort(),
    );
  });

  it("omits rejected routes rather than forwarding them", () => {
    const built = new URL(
      buildCentralSupportUrl({
        staticRoute: "/admin/patients/secret-id?token=secret",
        appVersion: "v1.2.3",
        environment: "preview",
      }),
    );
    expect(built.searchParams.has("route")).toBe(false);
    expect(built.toString()).not.toContain("secret");
    expect(built.searchParams.get("environment")).toBe("staging");
  });

  it("falls through blank metadata overrides to injected build metadata", () => {
    vi.stubEnv("VITE_APP_VERSION", "   ");
    vi.stubEnv("VITE_APP_ENVIRONMENT", "");

    const built = new URL(
      buildCentralSupportUrl({ appVersion: "", environment: "   " }),
    );

    expect(built.searchParams.get("app_version")).toBe("test-build");
    expect(built.searchParams.get("environment")).toBe("development");
  });

  it("exports the verified central contact endpoints", () => {
    expect(CENTRAL_SUPPORT_EMAIL).toBe("support@caremetric.ai");
    expect(CENTRAL_SUPPORT_PHONE_E164).toBe("+18775212890");
  });
});

describe("central support metadata normalization", () => {
  it.each([
    ["production", "production"],
    ["prod", "production"],
    ["preview", "staging"],
    ["PR", "staging"],
    ["test", "development"],
    ["customer-name", "development"],
  ])("maps environment %s to %s", (input, expected) => {
    expect(normalizeCentralSupportEnvironment(input)).toBe(expected);
  });

  it("allows release metadata and rejects free text or oversized values", () => {
    expect(normalizeCentralSupportVersion("v1.2.3+build.4")).toBe(
      "v1.2.3+build.4",
    );
    expect(normalizeCentralSupportVersion("release with patient name")).toBe(
      "unknown",
    );
    expect(normalizeCentralSupportVersion("a".repeat(49))).toBe("unknown");
  });

  it("accepts only validated static admin nav hrefs", () => {
    expect(safeStaticAdminNavHref("/admin/billing/adr")).toBe(
      "/admin/billing/adr",
    );
    expect(safeStaticAdminNavHref("/help")).toBeUndefined();
    expect(safeStaticAdminNavHref("/admin/patients/:id")).toBeUndefined();
    expect(
      safeStaticAdminNavHref("/admin/patients/id?patient=secret"),
    ).toBeUndefined();
  });
});

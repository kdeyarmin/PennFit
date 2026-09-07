// Central CareMetric software-support launcher for the authenticated admin
// console. This module intentionally accepts no user, organization, tenant, or
// patient data. Route context can only come from the console's compile-time nav
// model; unknown locations are omitted rather than forwarded verbatim.

import { pickActiveHref, type NavGroup } from "./nav-traversal";

declare const __CARE_METRIC_SUPPORT_BUILD_VERSION__: string;
declare const __CARE_METRIC_SUPPORT_BUILD_ENVIRONMENT__: string;

export const CENTRAL_SUPPORT_HUB_URL =
  "https://support-hub-web-production.up.railway.app";
export const CENTRAL_SUPPORT_PRODUCT = "breathe";
export const CENTRAL_SUPPORT_EMAIL = "support@caremetric.ai";
export const CENTRAL_SUPPORT_PHONE_E164 = "+18775212890";
export const CENTRAL_SUPPORT_PHONE_DISPLAY = "(877) 521-2890";

const MAX_LOCATION_LENGTH = 512;
const MAX_STATIC_ROUTE_LENGTH = 160;
const STATIC_ADMIN_ROUTE = /^\/admin(?:\/[a-z0-9][a-z0-9-]*)*$/;
const SAFE_LOCATION = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?$/;

export type CentralSupportEnvironment =
  | "production"
  | "staging"
  | "development";

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

/** Positive opt-in. Missing, malformed, or differently-cased values stay off. */
export function isCentralSupportHubEnabled(
  rawValue: string | undefined = import.meta.env
    .VITE_CENTRAL_SUPPORT_HUB_ENABLED,
): boolean {
  return rawValue === "true";
}

/**
 * Resolve the current admin location to a static href from the active nav.
 *
 * The raw location is never returned. Detail IDs collapse to their owning nav
 * destination (for example `/admin/patients/<id>` -> `/admin/patients`). An
 * unknown, malformed, public, or API location produces no route context.
 */
export function staticAdminSupportRoute(
  rawLocation: string,
  navGroups: ReadonlyArray<NavGroup>,
): string | undefined {
  if (
    rawLocation.length === 0 ||
    rawLocation.length > MAX_LOCATION_LENGTH ||
    rawLocation.includes("\\") ||
    containsControlCharacter(rawLocation)
  ) {
    return undefined;
  }

  const delimiterIndex = rawLocation.search(/[?#]/);
  const pathname =
    delimiterIndex === -1 ? rawLocation : rawLocation.slice(0, delimiterIndex);

  if (
    pathname.includes("%") ||
    pathname.includes("//") ||
    !SAFE_LOCATION.test(pathname)
  ) {
    return undefined;
  }

  const navHref = pickActiveHref(pathname, navGroups);
  return safeStaticAdminNavHref(navHref);
}

/** Validate a compile-time nav href before it can become outbound context. */
export function safeStaticAdminNavHref(
  navHref: string | null | undefined,
): string | undefined {
  if (
    !navHref ||
    navHref.length > MAX_STATIC_ROUTE_LENGTH ||
    !STATIC_ADMIN_ROUTE.test(navHref)
  ) {
    return undefined;
  }
  return navHref;
}

export function normalizeCentralSupportEnvironment(
  value: string | undefined,
): CentralSupportEnvironment {
  switch (value?.trim().toLowerCase()) {
    case "production":
    case "prod":
      return "production";
    case "staging":
    case "stage":
    case "preview":
    case "pr":
      return "staging";
    default:
      return "development";
  }
}

export function normalizeCentralSupportVersion(
  value: string | undefined,
): string {
  const candidate = value?.trim();
  if (
    !candidate ||
    candidate.length > 48 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(candidate)
  ) {
    return "unknown";
  }
  return candidate;
}

function injectedBuildVersion(): string | undefined {
  if (typeof __CARE_METRIC_SUPPORT_BUILD_VERSION__ === "string") {
    return __CARE_METRIC_SUPPORT_BUILD_VERSION__;
  }
  return undefined;
}

function injectedBuildEnvironment(): string | undefined {
  if (typeof __CARE_METRIC_SUPPORT_BUILD_ENVIRONMENT__ === "string") {
    return __CARE_METRIC_SUPPORT_BUILD_ENVIRONMENT__;
  }
  return undefined;
}

function firstNonBlank(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

export type CentralSupportUrlOptions = {
  /** Must already be a static href selected from the admin nav model. */
  staticRoute?: string;
  /** Test/explicit override; defaults to Vite metadata or the Railway SHA. */
  appVersion?: string;
  /** Test/explicit override; normalized to one of three approved values. */
  environment?: string;
};

/** Build a closed-schema Support Hub URL. No arbitrary query data is accepted. */
export function buildCentralSupportUrl(
  options: CentralSupportUrlOptions = {},
): string {
  const url = new URL("/help", CENTRAL_SUPPORT_HUB_URL);
  url.searchParams.set("product", CENTRAL_SUPPORT_PRODUCT);

  const route = safeStaticAdminNavHref(options.staticRoute);
  if (route) url.searchParams.set("route", route);

  url.searchParams.set(
    "app_version",
    normalizeCentralSupportVersion(
      firstNonBlank(
        options.appVersion,
        import.meta.env.VITE_APP_VERSION,
        injectedBuildVersion(),
      ),
    ),
  );
  url.searchParams.set(
    "environment",
    normalizeCentralSupportEnvironment(
      firstNonBlank(
        options.environment,
        import.meta.env.VITE_APP_ENVIRONMENT,
        injectedBuildEnvironment(),
        import.meta.env.MODE,
      ),
    ),
  );

  return url.toString();
}

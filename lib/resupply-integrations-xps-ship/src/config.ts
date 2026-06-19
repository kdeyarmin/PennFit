// XPS Ship configuration reader.
//
// XPS Ship (xpsshipper.com) is a multi-carrier shipping-label platform
// widely used by DME suppliers. Each tenant brings its OWN XPS account,
// so these vars are tenant-scoped app-config keys (see the catalog) and
// are read at CALL time via getEffectiveEnvForOrg(orgId) — credential
// rotation is honoured without a restart, exactly like the other
// outbound adapters.
//
// Like every other integration package, this reader returns `null` when
// the integration is not fully configured rather than throwing, so a
// missing credential degrades the adapter to "stub" mode and never
// crashes boot.

/** XPS default REST base. Overridable for the sandbox / a proxy. */
export const DEFAULT_XPS_API_BASE_URL = "https://xpsshipper.com/restapi/v1";

/** A postal address as XPS expects it on the sender/receiver objects. */
export interface XpsAddress {
  name: string;
  company?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
  /** ISO-3166 alpha-2. Defaults to "US" when unset. */
  country: string;
  phone?: string | null;
  email?: string | null;
}

export interface XpsShipConfig {
  apiBaseUrl: string;
  apiKey: string;
  /** XPS customer id (the `:customerId` URL segment). */
  customerId: string;
  /** REST API integration id (the `:integrationId` Put-Order segment). */
  integrationId: string;
  /** Ship-from address printed on every label as the sender / return-to. */
  sender: XpsAddress;
  /** Default label image format. PDF is universal; PNG is carrier-dependent. */
  labelFormat: "PDF" | "PNG";
}

function clean(v: string | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

/**
 * Strip trailing slashes without a regex. A regex like `/\/+$/` over
 * uncontrolled (env) input trips CodeQL's polynomial-ReDoS heuristic; a
 * plain loop is linear and obviously safe.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

/**
 * Reads XPS Ship config from the supplied env, or returns `null` when any
 * required value is missing. Required: the API key, customer id,
 * integration id, and a complete-enough ship-from address (name, line 1,
 * city, state, zip). Everything else has a safe default.
 */
export function readXpsShipConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): XpsShipConfig | null {
  const apiKey = clean(env.XPS_SHIP_API_KEY);
  const customerId = clean(env.XPS_SHIP_CUSTOMER_ID);
  const integrationId = clean(env.XPS_SHIP_INTEGRATION_ID);

  const senderName = clean(env.XPS_SHIP_FROM_NAME);
  const senderAddress1 = clean(env.XPS_SHIP_FROM_ADDRESS1);
  const senderCity = clean(env.XPS_SHIP_FROM_CITY);
  const senderState = clean(env.XPS_SHIP_FROM_STATE);
  const senderZip = clean(env.XPS_SHIP_FROM_ZIP);

  if (
    !apiKey ||
    !customerId ||
    !integrationId ||
    !senderName ||
    !senderAddress1 ||
    !senderCity ||
    !senderState ||
    !senderZip
  ) {
    return null;
  }

  const labelFormatRaw = clean(env.XPS_SHIP_LABEL_FORMAT)?.toUpperCase();
  const labelFormat: "PDF" | "PNG" = labelFormatRaw === "PNG" ? "PNG" : "PDF";

  return {
    apiBaseUrl: stripTrailingSlashes(
      clean(env.XPS_SHIP_API_BASE_URL) ?? DEFAULT_XPS_API_BASE_URL,
    ),
    apiKey,
    customerId,
    integrationId,
    labelFormat,
    sender: {
      name: senderName,
      company: clean(env.XPS_SHIP_FROM_COMPANY),
      address1: senderAddress1,
      address2: clean(env.XPS_SHIP_FROM_ADDRESS2),
      city: senderCity,
      state: senderState,
      zip: senderZip,
      country: clean(env.XPS_SHIP_FROM_COUNTRY) ?? "US",
      phone: clean(env.XPS_SHIP_FROM_PHONE),
      email: clean(env.XPS_SHIP_FROM_EMAIL),
    },
  };
}

/** True when the env carries no XPS credentials at all (vs partial). */
export function isXpsShipUnconfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !clean(env.XPS_SHIP_API_KEY) &&
    !clean(env.XPS_SHIP_CUSTOMER_ID) &&
    !clean(env.XPS_SHIP_INTEGRATION_ID)
  );
}

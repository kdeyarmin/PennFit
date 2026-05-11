// NPPES (National Plan and Provider Enumeration System) lookup helper.
//
// NPPES is the public registry CMS maintains for NPIs. The v2.1 API is
// free, requires no auth, returns JSON, and serves "lookup by NPI" as
// well as "search by name + state". The provider creation flow in
// /admin/providers uses this to autofill `legal_name`, `taxonomy_code`,
// and the practice address when a CSR types an NPI — instead of having
// the CSR re-key data already in NPPES.
//
// Endpoint: https://npiregistry.cms.hhs.gov/api/?version=2.1&number=NNNNNNNNNN
//
// Why a hand-rolled fetch wrapper (no SDK):
//   * The API surface is tiny — one endpoint, ~10 fields per result.
//   * There's no auth, no rate-limit header, and no retry semantics
//     worth abstracting; a 5-second timeout + parse + project is the
//     entire contract.
//   * Pulling in an SDK for this would be ~30 LOC of wrapper over
//     ~50 LOC of value. Easier to keep this inline.
//
// PHI posture: NPIs and the public NPPES projection are NOT PHI — see
// providers schema comment.

/**
 * Subset of the NPPES v2.1 response shape we actually use. The
 * `results[]` array carries one entry per matching NPI; a lookup by
 * exact 10-digit NPI always returns 0 or 1.
 *
 * Field names mirror the API verbatim so the projection function
 * reads like a direct mapping. The NPPES schema also includes
 * licenses, identifiers, endpoints, taxonomies (plural — providers
 * can have several), etc.; we only project the canonical taxonomy
 * (the one marked `primary: true`) plus the LOCATION address (vs.
 * MAILING).
 */
interface NppesResponse {
  result_count: number;
  results?: Array<{
    number: string;
    basic: {
      name?: string;
      first_name?: string;
      last_name?: string;
      organization_name?: string;
      credential?: string;
      authorized_official_first_name?: string;
      authorized_official_last_name?: string;
    };
    addresses?: Array<{
      address_purpose: "MAILING" | "LOCATION";
      address_type?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country_code?: string;
      telephone_number?: string;
      fax_number?: string;
    }>;
    taxonomies?: Array<{
      code: string;
      desc?: string;
      primary: boolean;
      state?: string;
    }>;
  }>;
}

export interface NppesProviderProjection {
  npi: string;
  legalName: string;
  taxonomyCode: string | null;
  phoneE164: string | null;
  faxE164: string | null;
  practiceName: string | null;
  practiceAddress: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  } | null;
}

export class NppesLookupError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NppesLookupError";
  }
}

/**
 * Look up a single NPI in NPPES. Returns null when the NPI is not
 * registered (NPPES returns `result_count: 0`); throws on network or
 * format errors so the caller can distinguish "not found" from
 * "couldn't reach the registry".
 *
 * Times out at 5 seconds. NPPES is generally fast (<500ms) and the
 * caller is in a CSR-form interaction loop — failing fast is better
 * than blocking the form on a slow upstream.
 */
export async function lookupNpi(
  npi: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<NppesProviderProjection | null> {
  if (!/^\d{10}$/.test(npi)) {
    throw new NppesLookupError(`Invalid NPI format: ${npi}`);
  }

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(
      `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`,
      { signal: controller.signal },
    );
  } catch (err) {
    throw new NppesLookupError("NPPES lookup failed (network)", err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new NppesLookupError(`NPPES lookup failed (HTTP ${res.status})`);
  }

  let json: NppesResponse;
  try {
    json = (await res.json()) as NppesResponse;
  } catch (err) {
    throw new NppesLookupError("NPPES response not JSON", err);
  }

  if (json.result_count === 0 || !json.results || json.results.length === 0) {
    return null;
  }

  const r = json.results[0]!;
  return projectNppes(r);
}

function projectNppes(r: NonNullable<NppesResponse["results"]>[number]): NppesProviderProjection {
  // Composite legal name: prefer organization_name (for clinics
  // registered as orgs), fall back to "First Last, Credential".
  const orgName = r.basic.organization_name?.trim();
  const personName =
    [r.basic.first_name, r.basic.last_name]
      .filter((s): s is string => !!s && s.length > 0)
      .join(" ")
      .trim() || undefined;
  const credential = r.basic.credential?.trim();
  const legalName =
    orgName ??
    (personName
      ? credential
        ? `${personName}, ${credential}`
        : personName
      : (r.basic.name ?? "Unknown provider"));

  // Prefer LOCATION over MAILING — LOCATION is the physical practice
  // address and is what the SWO + fax cover sheet should reference.
  // If no LOCATION row exists, fall back to MAILING.
  const addresses = r.addresses ?? [];
  const location =
    addresses.find((a) => a.address_purpose === "LOCATION") ??
    addresses.find((a) => a.address_purpose === "MAILING");

  // Primary taxonomy (CSR-facing description). NPPES marks one
  // taxonomy as `primary: true`; if none is flagged, take the first.
  const primaryTaxonomy =
    r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];

  return {
    npi: r.number,
    legalName,
    taxonomyCode: primaryTaxonomy?.code ?? null,
    phoneE164: location?.telephone_number
      ? toE164(location.telephone_number, location.country_code)
      : null,
    faxE164: location?.fax_number
      ? toE164(location.fax_number, location.country_code)
      : null,
    practiceName: orgName ?? null,
    practiceAddress: location
      ? {
          line1: location.address_1 ?? undefined,
          line2: location.address_2 ?? undefined,
          city: location.city ?? undefined,
          state: location.state ?? undefined,
          postalCode: location.postal_code ?? undefined,
          country: location.country_code ?? undefined,
        }
      : null,
  };
}

/**
 * Best-effort E.164 normalization. NPPES returns US numbers as
 * `2155551234` or `(215) 555-1234` or `215-555-1234`; we strip non-
 * digits and prefix `+1` when there are exactly 10 digits (US
 * country code). Non-US numbers go back untouched — better to surface
 * something than nothing, and the CSR can correct on the form.
 */
function toE164(raw: string, countryCode: string | undefined): string {
  const digits = raw.replace(/\D/g, "");
  if (countryCode && countryCode !== "US" && countryCode !== "USA") {
    return raw;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

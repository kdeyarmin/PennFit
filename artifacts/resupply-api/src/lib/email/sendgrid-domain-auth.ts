// SendGrid sender-domain authentication check.
//
// Storing a tenant `from_email` whose sending DOMAIN isn't authenticated
// (SPF/DKIM) in SendGrid still SENDS — but lands in spam. The email-settings
// UI surfaces this so a tenant isn't silently dropped into junk folders.
//
// This queries SendGrid's Domain Authentication API
// (GET /v3/whitelabel/domains) and reports whether a VALID authenticated
// domain covers the From address's domain. A root authentication (e.g.
// `acme.com`) covers any subdomain address (`billing@mail.acme.com`), so we
// match on equality OR suffix.
//
// Fail-soft: when SENDGRID_API_KEY is unset, or the API call fails, we
// return `"unknown"` rather than throwing — a deliverability hint must never
// block saving a sender or 500 the settings page.

const WHITELABEL_DOMAINS_URL =
  "https://api.sendgrid.com/v3/whitelabel/domains?limit=200";

export type DomainAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface DomainAuthResult {
  status: DomainAuthStatus;
  /** Human-readable explanation (never a secret). */
  detail: string;
  /** The authenticated domain that covers the address, when found. */
  matchedDomain?: string;
}

/** An authenticated-domain record (the subset we read). */
interface WhitelabelDomain {
  domain: string;
  valid: boolean;
}

/** Test seam: fetch the account's authenticated domains. */
export type FetchWhitelabelDomains = (
  apiKey: string,
) => Promise<WhitelabelDomain[]>;

export interface CheckDomainAuthOptions {
  apiKey?: string;
  fetchDomains?: FetchWhitelabelDomains;
}

/** Extract the lowercased domain part of an email address. */
export function emailDomain(fromEmail: string): string | null {
  const at = fromEmail.lastIndexOf("@");
  if (at < 0) return null;
  const domain = fromEmail
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}

/**
 * Whether `authDomain` (an authenticated SendGrid domain) covers
 * `addrDomain` (the From address's domain): exact match or a subdomain.
 */
function covers(authDomain: string, addrDomain: string): boolean {
  const a = authDomain.toLowerCase();
  return addrDomain === a || addrDomain.endsWith(`.${a}`);
}

export async function checkSendgridDomainAuth(
  fromEmail: string | null | undefined,
  opts: CheckDomainAuthOptions = {},
): Promise<DomainAuthResult> {
  const addr = fromEmail?.trim();
  if (!addr) {
    return { status: "unknown", detail: "No sender address set." };
  }
  const addrDomain = emailDomain(addr);
  if (!addrDomain) {
    return { status: "unknown", detail: "Sender address has no domain." };
  }

  const apiKey = opts.apiKey ?? process.env.SENDGRID_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return {
      status: "unknown",
      detail:
        "SendGrid isn't configured on this deployment, so domain authentication can't be verified here.",
    };
  }

  let domains: WhitelabelDomain[];
  try {
    const fetchDomains = opts.fetchDomains ?? defaultFetchDomains;
    domains = await fetchDomains(apiKey.trim());
  } catch {
    return {
      status: "unknown",
      detail: "Couldn't reach SendGrid to verify domain authentication.",
    };
  }

  const match = domains.find((d) => d.valid && covers(d.domain, addrDomain));
  if (match) {
    return {
      status: "authenticated",
      detail: `${addrDomain} is authenticated in SendGrid (via ${match.domain}). Mail will pass SPF/DKIM.`,
      matchedDomain: match.domain,
    };
  }
  return {
    status: "unauthenticated",
    detail: `${addrDomain} is not authenticated in SendGrid (SPF/DKIM). Mail will send but is likely to land in spam until you authenticate the domain.`,
  };
}

async function defaultFetchDomains(
  apiKey: string,
): Promise<WhitelabelDomain[]> {
  const res = await fetch(WHITELABEL_DOMAINS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`SendGrid whitelabel domains: HTTP ${res.status}`);
  }
  const parsed = (await res.json()) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => {
      const r = row as Record<string, unknown>;
      const domain = typeof r["domain"] === "string" ? r["domain"] : null;
      const valid = r["valid"] === true;
      return domain ? { domain, valid } : null;
    })
    .filter((d): d is WhitelabelDomain => d !== null);
}

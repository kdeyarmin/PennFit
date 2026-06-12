// Typed fetch wrappers for the DME organization identity config
// (/admin/dme-organization). This is the editable, DB-backed billing
// identity (legal name, tax id, NPI, addresses, accreditation, …) that
// the identity-resolver prefers over the legacy OFFICE_ALLY_BILLING_*
// env vars — so an operator can set it here instead of in global env.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export const ACCREDITATION_BODIES = [
  "achc",
  "boc",
  "tjc",
  "cap",
  "other",
] as const;
export type AccreditationBody = (typeof ACCREDITATION_BODIES)[number];

/** Flat shape matching the server's `orgBody` (PUT) contract. */
export interface DmeOrgBody {
  legalName: string;
  dbaName: string | null;
  taxId: string;
  organizationalNpi: string;
  taxonomyCode: string;
  medicarePtan: string | null;
  physicalAddressLine1: string;
  physicalAddressLine2: string | null;
  physicalCity: string;
  physicalState: string;
  physicalZip: string;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  payToAddressLine1: string | null;
  payToAddressLine2: string | null;
  payToCity: string | null;
  payToState: string | null;
  payToZip: string | null;
  phoneE164: string;
  faxE164: string | null;
  billingEmail: string;
  generalEmail: string | null;
  supportEmail: string | null;
  supportPhoneE164: string | null;
  supportHoursText: string | null;
  websiteUrl: string | null;
  accreditationBody: AccreditationBody | null;
  accreditationNumber: string | null;
  accreditationExpiresOn: string | null;
  stateLicenseNumber: string | null;
  stateLicenseState: string | null;
  stateLicenseExpiresOn: string | null;
  liabilityCarrier: string | null;
  liabilityPolicyNumber: string | null;
  liabilityExpiresOn: string | null;
  suretyBondCarrier: string | null;
  suretyBondAmountCents: number | null;
  suretyBondExpiresOn: string | null;
  authorizedSignerName: string | null;
  authorizedSignerTitle: string | null;
  notes: string | null;
}

interface Address {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
}

/** Nested shape the GET endpoint returns for the organization. */
export interface DmeOrganization {
  id: string;
  legalName: string;
  dbaName: string | null;
  taxId: string;
  organizationalNpi: string;
  taxonomyCode: string;
  medicarePtan: string | null;
  physical: Address;
  mailing: Address | null;
  payTo: Address | null;
  phoneE164: string;
  faxE164: string | null;
  billingEmail: string;
  generalEmail: string | null;
  supportEmail: string | null;
  supportPhoneE164: string | null;
  supportHoursText: string | null;
  websiteUrl: string | null;
  accreditation: {
    body: AccreditationBody;
    number: string | null;
    expiresOn: string | null;
  } | null;
  stateLicense: {
    number: string;
    state: string | null;
    expiresOn: string | null;
  } | null;
  liability: {
    carrier: string;
    policyNumber: string | null;
    expiresOn: string | null;
  } | null;
  suretyBond: {
    carrier: string;
    amountCents: number | null;
    expiresOn: string | null;
  } | null;
  authorizedSigner: { name: string; title: string | null } | null;
  notes: string | null;
  updatedAt: string;
}

export interface DmeOrganizationResponse {
  organization: DmeOrganization | null;
  contacts: unknown[];
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function putJSON<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "PUT", url });
  }
  return (await res.json()) as T;
}

export const fetchDmeOrganization = () =>
  getJSON<DmeOrganizationResponse>("/admin/dme-organization");

export const saveDmeOrganization = (body: DmeOrgBody) =>
  putJSON<{ id: string; created: boolean }>("/admin/dme-organization", body);

/** A blank form body — the defaults a brand-new org starts from. */
export function emptyDmeOrgBody(): DmeOrgBody {
  return {
    legalName: "",
    dbaName: null,
    taxId: "",
    organizationalNpi: "",
    taxonomyCode: "332B00000X",
    medicarePtan: null,
    physicalAddressLine1: "",
    physicalAddressLine2: null,
    physicalCity: "",
    physicalState: "",
    physicalZip: "",
    mailingAddressLine1: null,
    mailingAddressLine2: null,
    mailingCity: null,
    mailingState: null,
    mailingZip: null,
    payToAddressLine1: null,
    payToAddressLine2: null,
    payToCity: null,
    payToState: null,
    payToZip: null,
    phoneE164: "",
    faxE164: null,
    billingEmail: "",
    generalEmail: null,
    supportEmail: null,
    supportPhoneE164: null,
    supportHoursText: null,
    websiteUrl: null,
    accreditationBody: null,
    accreditationNumber: null,
    accreditationExpiresOn: null,
    stateLicenseNumber: null,
    stateLicenseState: null,
    stateLicenseExpiresOn: null,
    liabilityCarrier: null,
    liabilityPolicyNumber: null,
    liabilityExpiresOn: null,
    suretyBondCarrier: null,
    suretyBondAmountCents: null,
    suretyBondExpiresOn: null,
    authorizedSignerName: null,
    authorizedSignerTitle: null,
    notes: null,
  };
}

/** Flatten the nested GET organization into the flat PUT body so the
 *  form round-trips EVERY field (the PUT is a full upsert — a field
 *  omitted from the body is written NULL, so we must carry them all). */
export function orgToBody(org: DmeOrganization): DmeOrgBody {
  return {
    legalName: org.legalName,
    dbaName: org.dbaName,
    taxId: org.taxId,
    organizationalNpi: org.organizationalNpi,
    taxonomyCode: org.taxonomyCode,
    medicarePtan: org.medicarePtan,
    physicalAddressLine1: org.physical.line1,
    physicalAddressLine2: org.physical.line2,
    physicalCity: org.physical.city,
    physicalState: org.physical.state,
    physicalZip: org.physical.zip,
    mailingAddressLine1: org.mailing?.line1 ?? null,
    mailingAddressLine2: org.mailing?.line2 ?? null,
    mailingCity: org.mailing?.city ?? null,
    mailingState: org.mailing?.state ?? null,
    mailingZip: org.mailing?.zip ?? null,
    payToAddressLine1: org.payTo?.line1 ?? null,
    payToAddressLine2: org.payTo?.line2 ?? null,
    payToCity: org.payTo?.city ?? null,
    payToState: org.payTo?.state ?? null,
    payToZip: org.payTo?.zip ?? null,
    phoneE164: org.phoneE164,
    faxE164: org.faxE164,
    billingEmail: org.billingEmail,
    generalEmail: org.generalEmail,
    supportEmail: org.supportEmail,
    supportPhoneE164: org.supportPhoneE164,
    supportHoursText: org.supportHoursText,
    websiteUrl: org.websiteUrl,
    accreditationBody: org.accreditation?.body ?? null,
    accreditationNumber: org.accreditation?.number ?? null,
    accreditationExpiresOn: org.accreditation?.expiresOn ?? null,
    stateLicenseNumber: org.stateLicense?.number ?? null,
    stateLicenseState: org.stateLicense?.state ?? null,
    stateLicenseExpiresOn: org.stateLicense?.expiresOn ?? null,
    liabilityCarrier: org.liability?.carrier ?? null,
    liabilityPolicyNumber: org.liability?.policyNumber ?? null,
    liabilityExpiresOn: org.liability?.expiresOn ?? null,
    suretyBondCarrier: org.suretyBond?.carrier ?? null,
    suretyBondAmountCents: org.suretyBond?.amountCents ?? null,
    suretyBondExpiresOn: org.suretyBond?.expiresOn ?? null,
    authorizedSignerName: org.authorizedSigner?.name ?? null,
    authorizedSignerTitle: org.authorizedSigner?.title ?? null,
    notes: org.notes,
  };
}

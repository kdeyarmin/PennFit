// Tenant onboarding agreements (G16, BAA portion).
//
// The legal documents every tenant must execute BEFORE using CareMetric
// Breathe, plus the version-aware "required set" the onboarding gate
// enforces. Acceptances are recorded in `organization_agreements`
// (migration 0366); the gate (GET /admin/agreements, the `pendingAgreements`
// signal on /me, and the SPA accept screen) blocks the tenant admin console
// until every required agreement is signed at its CURRENT version.
//
// Versioning: bump an agreement's `version` whenever its `body` materially
// changes. A version bump invalidates prior acceptances (the unique
// (org, type, version) row no longer matches), so tenants are re-prompted
// to sign the new text. Keep the version a stable, sortable string
// (ISO date + optional suffix).
//
// IMPORTANT: these are platform templates, not legal advice. The business
// owner / counsel should review and adjust the text before relying on it.
// Editing the text here is the source of truth — there is no DB copy of the
// body, only the signed (type, version) acceptance record.

export type AgreementType = "baa" | "platform_terms";

export interface AgreementDoc {
  type: AgreementType;
  /** Sortable version string; bump on material text change. */
  version: string;
  title: string;
  /** Plain-text body rendered (pre-wrapped) in the accept screen. */
  body: string;
}

const PLATFORM_NAME = "CareMetric Breathe";

const BAA_BODY = `BUSINESS ASSOCIATE AGREEMENT

This Business Associate Agreement ("BAA") supplements the Master Services
Agreement between ${PLATFORM_NAME} ("Business Associate") and the
organization accepting this BAA ("Covered Entity"). It governs the
Business Associate's handling of Protected Health Information ("PHI") as
defined under the Health Insurance Portability and Accountability Act of
1996 and its implementing regulations (collectively, "HIPAA").

1. PERMITTED USES AND DISCLOSURES. Business Associate may use and disclose
PHI only as necessary to perform the services described in the Master
Services Agreement, as Required by Law, or for the proper management and
administration of Business Associate, and will not use or disclose PHI in
any manner that would violate HIPAA if done by Covered Entity.

2. SAFEGUARDS. Business Associate will implement and maintain
administrative, physical, and technical safeguards that reasonably and
appropriately protect the confidentiality, integrity, and availability of
electronic PHI it creates, receives, maintains, or transmits on behalf of
Covered Entity, in accordance with the HIPAA Security Rule.

3. REPORTING. Business Associate will report to Covered Entity, without
unreasonable delay, any use or disclosure of PHI not permitted by this BAA
of which it becomes aware, including any Breach of Unsecured PHI as
required by 45 C.F.R. Sec. 164.410.

4. SUBCONTRACTORS. Business Associate will ensure that any subcontractors
that create, receive, maintain, or transmit PHI on its behalf agree in
writing to restrictions and conditions at least as protective as those
that apply to Business Associate under this BAA.

5. ACCESS, AMENDMENT, AND ACCOUNTING. Business Associate will make PHI
available to Covered Entity as necessary to satisfy Covered Entity's
obligations under 45 C.F.R. Sec.Sec. 164.524, 164.526, and 164.528
(access, amendment, and accounting of disclosures).

6. MINIMUM NECESSARY. Business Associate will limit its uses, disclosures,
and requests for PHI to the minimum necessary to accomplish the intended
purpose.

7. TERM AND TERMINATION. This BAA is effective on acceptance and continues
until the Master Services Agreement terminates. Upon termination, Business
Associate will return or destroy all PHI it maintains on behalf of Covered
Entity where feasible, and will extend the protections of this BAA to any
PHI it cannot feasibly return or destroy for as long as it retains that
PHI.

8. NO THIRD-PARTY BENEFICIARIES. Nothing in this BAA confers any rights on
any person other than the parties.

By accepting, the signatory represents that they are authorized to bind
the Covered Entity to this Business Associate Agreement.`;

const PLATFORM_TERMS_BODY = `MASTER SERVICES AGREEMENT / TERMS OF SERVICE

These terms ("Agreement") govern your organization's access to and use of
the ${PLATFORM_NAME} platform ("Service").

1. ACCESS. ${PLATFORM_NAME} grants your organization a non-exclusive,
non-transferable right to access and use the Service for your internal
business operations during the subscription term.

2. YOUR DATA. Your organization retains all rights to the data it submits.
You grant ${PLATFORM_NAME} the rights necessary to host and process that
data to provide the Service. Handling of Protected Health Information is
governed by the separate Business Associate Agreement.

3. ACCEPTABLE USE. You will use the Service in compliance with applicable
law and will not attempt to access another tenant's data, probe or
circumvent the platform's security, or use the Service to transmit
unlawful or infringing content.

4. FEES. Fees, billing frequency, and any usage-based charges are as set
out in your order or pricing plan. Payment-processing for your own
customers runs through your connected payment account; platform fees are
billed separately.

5. CONFIDENTIALITY. Each party will protect the other's confidential
information with at least reasonable care and use it only to perform under
this Agreement.

6. WARRANTIES AND DISCLAIMERS. The Service is provided "as is" except as
expressly stated. ${PLATFORM_NAME} disclaims implied warranties to the
extent permitted by law.

7. LIMITATION OF LIABILITY. To the extent permitted by law, neither party
is liable for indirect, incidental, or consequential damages, and each
party's aggregate liability is limited as set out in the order.

8. TERM AND TERMINATION. Either party may terminate for material breach
not cured within thirty (30) days of notice. On termination your access
ends and you may export your data for a reasonable period.

By accepting, the signatory represents that they are authorized to bind
the organization to this Agreement.`;

// The agreements every tenant must sign, at their CURRENT versions. The
// onboarding gate requires an accepted row for each (type, version) here.
export const REQUIRED_AGREEMENTS: readonly AgreementDoc[] = [
  {
    type: "platform_terms",
    version: "2026-06-16",
    title: `${PLATFORM_NAME} Master Services Agreement`,
    body: PLATFORM_TERMS_BODY,
  },
  {
    type: "baa",
    version: "2026-06-16",
    title: "HIPAA Business Associate Agreement",
    body: BAA_BODY,
  },
] as const;

/** The current required doc for a type, or undefined if not required. */
export function currentAgreement(
  type: AgreementType,
): AgreementDoc | undefined {
  return REQUIRED_AGREEMENTS.find((a) => a.type === type);
}

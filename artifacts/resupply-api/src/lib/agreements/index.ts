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
//
// Liability posture (2026-06-24 revision): the MSA carries a full
// warranty disclaimer, an exclusion of indirect/consequential damages, a
// 12-month-fees aggregate liability cap, customer indemnification of the
// platform, and assumption-of-risk + AI-output disclaimers. The BAA keeps
// every HIPAA-mandated Business Associate obligation (it MUST — a covered
// entity tenant needs a compliant BAA, and HITECH liability to regulators
// cannot be contracted away) and adds the protections a BA legitimately
// CAN take: covered-entity obligations, covered-entity indemnification of
// the BA, and a liability cap cross-referenced to the MSA. Do NOT attempt
// to convert the BAA into a blanket "harmless for anything" waiver — that
// would be non-compliant and a court would likely void the whole clause.
// The contracting party is the legal entity CareMetric AI (LEGAL_ENTITY);
// "the CareMetric Breathe platform" (PLATFORM_NAME) is the Service. Governing
// law and venue are set to the Commonwealth of Pennsylvania and Cambria
// County, PA. Counsel should still review before relying on these templates.

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

// The contracting legal entity — the PARTY to these agreements — as distinct
// from PLATFORM_NAME, the product/service brand. The documents are executed
// with the company (CareMetric AI) and refer to "the CareMetric Breathe
// platform" as the Service; "CareMetric" is the defined short form used
// throughout the operative clauses. If the registered entity carries a
// corporate suffix (e.g. ", Inc." / ", LLC"), append it to LEGAL_ENTITY.
const LEGAL_ENTITY = "CareMetric AI";
const COMPANY = "CareMetric";

const BAA_BODY = `BUSINESS ASSOCIATE AGREEMENT

This Business Associate Agreement ("BAA") supplements the Master Services
Agreement between ${LEGAL_ENTITY} ("Business Associate") and the
organization accepting this BAA ("Covered Entity"). It governs the
Business Associate's handling of Protected Health Information ("PHI") as
defined under the Health Insurance Portability and Accountability Act of
1996 and its implementing regulations (collectively, "HIPAA").

1. PERMITTED USES AND DISCLOSURES. Business Associate may use and disclose
PHI only as necessary to perform the services described in the Master
Services Agreement, as Required by Law, or for the proper management and
administration of Business Associate, and will not use or disclose PHI in
any manner that would violate HIPAA if done by Covered Entity. Business
Associate may de-identify PHI in accordance with 45 C.F.R. Sec. 164.514,
and de-identified data is not subject to this BAA.

2. SAFEGUARDS. Business Associate will implement and maintain
administrative, physical, and technical safeguards that reasonably and
appropriately protect the confidentiality, integrity, and availability of
electronic PHI it creates, receives, maintains, or transmits on behalf of
Covered Entity, in accordance with the HIPAA Security Rule.

3. REPORTING. Business Associate will report to Covered Entity, without
unreasonable delay, any use or disclosure of PHI not permitted by this BAA
of which it becomes aware, including any Breach of Unsecured PHI as
required by 45 C.F.R. Sec. 164.410. The parties agree that this provision
constitutes notice of the ongoing occurrence of unsuccessful security
incidents (such as routine scans, pings, and failed access attempts) for
which no additional notice will be required.

4. SUBCONTRACTORS. Business Associate will ensure that any subcontractors
that create, receive, maintain, or transmit PHI on its behalf agree in
writing to restrictions and conditions at least as protective as those
that apply to Business Associate under this BAA.

5. ACCESS, AMENDMENT, AND ACCOUNTING. Business Associate will make PHI
available to Covered Entity as necessary to satisfy Covered Entity's
obligations under 45 C.F.R. Sec.Sec. 164.524, 164.526, and 164.528
(access, amendment, and accounting of disclosures). Where an individual
requests access, amendment, or an accounting directly from Business
Associate, Business Associate will forward the request to Covered Entity,
which is responsible for responding.

6. MINIMUM NECESSARY. Business Associate will limit its uses, disclosures,
and requests for PHI to the minimum necessary to accomplish the intended
purpose.

7. COVERED ENTITY OBLIGATIONS. Covered Entity will: (a) obtain and
maintain all consents, authorizations, and notices (including its Notice
of Privacy Practices) required for Business Associate to use and disclose
PHI as contemplated by the Master Services Agreement; (b) not request or
instruct Business Associate to use or disclose PHI in any manner that
would violate HIPAA; (c) notify Business Associate of any limitation in
its Notice of Privacy Practices, of any restriction on use or disclosure
to which it has agreed under 45 C.F.R. Sec. 164.522, and of any
revocation of an authorization, to the extent any of these affects
Business Associate's permitted uses or disclosures; and (d) be solely
responsible for its own compliance, as a covered entity, with HIPAA and
all other laws applicable to it. Business Associate acts on Covered
Entity's instructions and is not responsible for Covered Entity's
compliance obligations or for the lawfulness of Covered Entity's
instructions.

8. TERM AND TERMINATION. This BAA is effective on acceptance and continues
until the Master Services Agreement terminates. Upon termination, Business
Associate will return or destroy all PHI it maintains on behalf of Covered
Entity where feasible, and will extend the protections of this BAA to any
PHI it cannot feasibly return or destroy for as long as it retains that
PHI.

9. ALLOCATION OF LIABILITY; INDEMNIFICATION. Each party is responsible for
its own acts and omissions and for its own violations of HIPAA, and not
for those of the other party. To the fullest extent permitted by law,
Covered Entity will defend, indemnify, and hold harmless Business
Associate and its affiliates, officers, directors, employees, and agents
from and against any claims, liabilities, penalties, fines, costs, and
expenses (including reasonable attorneys' fees) arising out of or relating
to Covered Entity's breach of this BAA, its unlawful or unauthorized
instructions, its failure to obtain any consent or authorization required
under Section 7, or its own violation of HIPAA or other applicable law.
Except for each party's nondelegable statutory obligations to regulators
and to individuals under HIPAA (which the parties acknowledge cannot be
limited by contract), each party's liability arising out of or relating to
this BAA is subject to the limitations of liability set out in the Master
Services Agreement, to the fullest extent permitted by law.

10. NO THIRD-PARTY BENEFICIARIES. Nothing in this BAA confers any rights
on any person other than the parties.

11. INTERPRETATION. Any ambiguity in this BAA will be resolved to permit
compliance with HIPAA. If HIPAA is amended or new guidance is issued in a
manner that affects this BAA, the parties will negotiate in good faith to
amend it as needed to remain compliant. Except as expressly modified by
this BAA, the Master Services Agreement remains in full force; in the
event of a direct conflict regarding the handling of PHI, this BAA
controls.

By accepting, the signatory represents that they are authorized to bind
the Covered Entity to this Business Associate Agreement.`;

const PLATFORM_TERMS_BODY = `MASTER SERVICES AGREEMENT / TERMS OF SERVICE

These terms ("Agreement") govern the access to and use of the
${PLATFORM_NAME} platform, software, websites, APIs, AI features, and
related services (collectively, the "Service") by your organization
("Customer," "you," or "your"), provided by ${LEGAL_ENTITY}
("${COMPANY}," "we," "us," or "our"). By accepting this Agreement or
using the Service, you agree to be bound by it.

1. ACCESS. ${COMPANY} grants Customer a non-exclusive,
non-transferable, revocable right to access and use the Service for
Customer's internal business operations during the subscription term,
subject to this Agreement.

2. YOUR DATA. Customer retains all rights to the data it submits
("Customer Data"). Customer grants ${COMPANY} the rights necessary
to host, process, transmit, and display Customer Data to provide and
support the Service. ${COMPANY} may collect and use aggregated and
de-identified data — which does not identify Customer or any individual —
for any lawful business purpose, including operating, securing, and
improving the Service. Handling of Protected Health Information is governed
by the separate Business Associate Agreement.

3. CUSTOMER RESPONSIBILITIES; ASSUMPTION OF RISK. Customer is solely
responsible for, and assumes all risk arising from: (a) its use of and
reliance on the Service and any output of the Service; (b) all clinical,
medical, prescribing, fitting, billing, coding, insurance, eligibility,
and reimbursement decisions, which remain the exclusive responsibility of
Customer and its licensed professionals — the Service is a software tool
and does not provide medical, clinical, legal, billing, or other
professional advice; (c) the accuracy, legality, and completeness of all
data, instructions, and content that Customer or its users submit;
(d) obtaining and maintaining all patient consents, authorizations,
prescriptions, and notices required by law; (e) Customer's own compliance
with every law applicable to its business, including HIPAA (as a covered
entity), state licensure, DMEPOS/DME supplier requirements, payer rules,
and telemarketing and SMS/text-messaging consent laws; (f) maintaining the
confidentiality of its account credentials and for all activity under its
account; and (g) reviewing and verifying all Service output before relying
on it. Customer acknowledges that ${COMPANY} is not a healthcare
provider, pharmacy, DME supplier, insurer, billing service, or law firm,
and does not exercise professional judgment on Customer's behalf.

4. ACCEPTABLE USE. Customer will use the Service in compliance with
applicable law and will not (a) attempt to access another tenant's data,
(b) probe, scan, or circumvent the platform's security, (c) use the
Service to transmit unlawful, infringing, or harmful content, or
(d) submit false or misleading patient, insurance, or prescription
information.

5. AI AND AUTOMATED FEATURES. The Service includes AI-assisted and
automated features (including mask-fitting recommendations, chat
assistants, voice agents, drafted messages, and call or document
summaries). These features are probabilistic, may produce inaccurate,
incomplete, or unexpected output, and are provided as productivity aids
only — not as medical advice and not as a substitute for professional
judgment. Customer is responsible for human review of all such output
before it is sent, acted upon, or relied upon, and ${COMPANY} makes
no warranty as to the accuracy or suitability of any AI output.

6. FEES. Fees, billing frequency, and any usage-based charges are as set
out in your order or pricing plan. Payment-processing for your own
customers runs through your connected payment account; platform fees are
billed separately. Fees are non-refundable except as expressly stated in
your order.

7. CONFIDENTIALITY. Each party will protect the other's confidential
information with at least reasonable care and use it only to perform under
this Agreement.

8. WARRANTIES AND DISCLAIMERS. THE SERVICE AND ALL OUTPUT ARE PROVIDED
"AS IS" AND "AS AVAILABLE," WITH ALL FAULTS. TO THE FULLEST EXTENT
PERMITTED BY LAW, ${COMPANY} DISCLAIMS ALL WARRANTIES, WHETHER
EXPRESS, IMPLIED, OR STATUTORY, INCLUDING THE IMPLIED WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND
NON-INFRINGEMENT, AND ANY WARRANTY THAT THE SERVICE WILL BE UNINTERRUPTED,
ERROR-FREE, OR SECURE, OR WILL MEET CUSTOMER'S REQUIREMENTS OR PRODUCE
ACCURATE OR COMPLETE RESULTS (INCLUDING MASK RECOMMENDATIONS, INSURANCE OR
ELIGIBILITY RESULTS, BILLING OR CODING OUTPUT, OR THE DELIVERY OR TIMING OF
ANY MESSAGE). ${COMPANY} IS NOT RESPONSIBLE FOR THE ACTS, OMISSIONS,
AVAILABILITY, OR ACCURACY OF ANY THIRD-PARTY SERVICE, CARRIER, PAYER, OR
DATA SOURCE.

9. LIMITATION OF LIABILITY. TO THE FULLEST EXTENT PERMITTED BY LAW:
(a) IN NO EVENT WILL ${COMPANY} BE LIABLE FOR ANY INDIRECT,
INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR
ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS, OR FOR THE COST
OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATING TO THIS AGREEMENT OR THE
SERVICE, REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT, NEGLIGENCE,
STRICT LIABILITY, OR OTHERWISE) AND EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGES; AND (b) ${COMPANY}'S TOTAL AGGREGATE LIABILITY ARISING
OUT OF OR RELATING TO THIS AGREEMENT AND THE SERVICE WILL NOT EXCEED THE
TOTAL PLATFORM FEES PAID BY CUSTOMER TO ${COMPANY} FOR THE SERVICE
IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO
THE CLAIM. THE PARTIES AGREE THESE LIMITATIONS ARE AN ESSENTIAL BASIS OF
THE BARGAIN AND APPLY EVEN IF A LIMITED REMEDY FAILS OF ITS ESSENTIAL
PURPOSE. Some jurisdictions do not allow certain exclusions or
limitations; in those jurisdictions ${COMPANY}'s liability is limited
to the maximum extent permitted by law.

10. INDEMNIFICATION. Customer will defend, indemnify, and hold harmless
${COMPANY} and its affiliates, officers, directors, employees, and
agents from and against any third-party claims, damages, liabilities,
penalties, fines, costs, and expenses (including reasonable attorneys'
fees) arising out of or relating to: (a) Customer Data and any content or
instructions Customer or its users submit; (b) Customer's use of the
Service or any output of the Service, including clinical, prescribing,
billing, and insurance decisions; (c) Customer's violation of any law or
of any patient, payer, or third-party right, including HIPAA, licensure,
DME/DMEPOS, and SMS/telemarketing-consent obligations; (d) Customer's
breach of this Agreement; and (e) any claim by a patient, end user, or
other person arising from Customer's business or services.

11. THIRD-PARTY SERVICES; FORCE MAJEURE. The Service integrates
third-party services (including AI providers; telecom, SMS, voice, and fax
carriers; payment processors; clearinghouses; and storage providers),
which are governed by their own terms and for which ${COMPANY} is not
responsible or liable. ${COMPANY} is not liable for any delay or
failure to perform caused by events beyond its reasonable control,
including acts of God, internet or utility failures, third-party service
outages, labor disputes, or governmental action.

12. TERM AND TERMINATION. Either party may terminate for material breach
not cured within thirty (30) days of written notice. ${COMPANY} may
suspend access immediately for non-payment or for use that violates law or
this Agreement or that threatens the security or integrity of the Service.
On termination your access ends and you may export Customer Data for a
reasonable period.

13. GOVERNING LAW; DISPUTE RESOLUTION. This Agreement is governed by the
laws of the Commonwealth of Pennsylvania, without regard to its
conflict-of-laws rules. The exclusive venue for any dispute is the state
courts located in Cambria County, Pennsylvania and the federal courts
having jurisdiction over that county, and each party consents to that
jurisdiction. TO THE FULLEST EXTENT PERMITTED BY LAW, EACH PARTY WAIVES
ANY RIGHT TO A JURY TRIAL. Any claim arising out of or relating to this
Agreement must be brought within one (1) year after it accrues.

14. GENERAL. This Agreement, together with the Business Associate
Agreement and any order, is the entire agreement between the parties on its
subject and supersedes prior agreements on that subject. If any provision
is held unenforceable, it will be modified to the minimum extent necessary
to make it enforceable, or severed, and the remainder will stay in effect.
The disclaimers, limitations of liability, indemnities, and
confidentiality terms survive termination. No waiver is effective unless in
writing. Customer may not assign this Agreement without ${COMPANY}'s
prior written consent; ${COMPANY} may assign it to an affiliate or to
a successor in connection with a merger, acquisition, or sale of assets.

By accepting, the signatory represents that they are authorized to bind
the organization to this Agreement.`;

// The agreements every tenant must sign, at their CURRENT versions. The
// onboarding gate requires an accepted row for each (type, version) here.
export const REQUIRED_AGREEMENTS: readonly AgreementDoc[] = [
  {
    type: "platform_terms",
    version: "2026-06-24",
    title: `${PLATFORM_NAME} Master Services Agreement`,
    body: PLATFORM_TERMS_BODY,
  },
  {
    type: "baa",
    version: "2026-06-24",
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

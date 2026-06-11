// Patient packet document catalog.
//
// Defines the standard set of onboarding documents a new DME / CPAP
// customer reviews and signs electronically. Each template renders to
// structured content (headings, paragraphs, bullet lists) that is used
// both by the public signing UI (rendered as React) and by the signed
// PDF generator (rendered with PDFKit). Keeping content structured —
// not raw HTML — means the same source of truth drives both surfaces
// and there is no markup-injection surface in the patient-facing app.
//
// Content is parameterised by a CompanyProfile so the supplier's legal
// name, contact details and NPI are accurate (resolved at send time
// from the DME organization row, with a safe fallback). Bumping a
// template's `version` does NOT rewrite documents already signed — the
// version is snapshotted onto patient_packet_documents at send time.

export interface CompanyProfile {
  legalName: string;
  phone: string;
  email: string;
  addressLine1: string;
  cityStateZip: string;
  npi: string | null;
}

export interface PacketDocumentSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

export type PacketDocumentCategory =
  | "instructions"
  | "consent"
  | "privacy"
  | "rights"
  | "financial"
  | "delivery";

/** A line item on the Proof of Delivery (CMS requires a detailed item
 *  description; HCPCS + quantity strengthen the audit trail). */
export interface DeliveryItem {
  description: string;
  hcpcs?: string | null;
  quantity?: number | null;
}

/** Itemized delivery snapshot stored on the packet and rendered into the
 *  Proof of Delivery document. */
export interface DeliveryDetails {
  items?: DeliveryItem[];
  deliveryDate?: string | null;
  deliveryAddress?: string | null;
  orderRef?: string | null;
}

/** Extra context some documents fold into their rendered content so the
 *  on-screen text and the signed PDF stay byte-for-byte identical. */
export interface PacketBuildContext {
  deliveryDetails?: DeliveryDetails | null;
}

export interface PacketDocumentTemplate {
  key: string;
  title: string;
  category: PacketDocumentCategory;
  version: string;
  /** One-line description shown in the admin packet builder. */
  summary: string;
  /** When true the document is part of the signed agreement; when
   *  false it is informational (still acknowledged, never signed). */
  requiresSignature: boolean;
  /** Whether this document is selected by default in a standard new
   *  patient packet. */
  defaultIncluded: boolean;
  build: (
    company: CompanyProfile,
    ctx?: PacketBuildContext,
  ) => PacketDocumentSection[];
}

// Every template carries the same date stamp in its version so a
// coordinated content review bumps them together; individual edits
// should bump only the touched template.
const V = "2026-06-06.v1";

export const PACKET_TEMPLATES: PacketDocumentTemplate[] = [
  {
    key: "welcome_instructions",
    title: "Welcome & Equipment Use Instructions",
    category: "instructions",
    version: V,
    summary:
      "Welcome letter plus how to set up, clean, and care for CPAP therapy equipment.",
    requiresSignature: false,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `Welcome to ${c.legalName}. Thank you for trusting us with your sleep therapy. This packet contains the information and agreements we are required to review with every new patient. Please read each document carefully, ask us any questions, and sign electronically where indicated.`,
          `Our patient care team is available to help you get the most out of your therapy. You can reach us at ${c.phone} or ${c.email}.`,
        ],
      },
      {
        heading: "Setting up your equipment",
        bullets: [
          "Place your device on a firm, flat surface near your bed and below the level of your mattress so condensation drains away from the mask.",
          "Fill the humidifier chamber (if equipped) with distilled water only — never tap or bottled mineral water.",
          "Connect the tubing to the device and to your mask, then turn the device on and confirm air is flowing before you put the mask on.",
          "Fit the mask while lying down in your normal sleep position; adjust the headgear so the seal is comfortable but not over-tightened.",
        ],
      },
      {
        heading: "Daily and weekly care",
        bullets: [
          "Daily: empty and air-dry the humidifier chamber; wipe the mask cushion with a fragrance-free wipe or mild soap and water.",
          "Weekly: hand-wash the mask, headgear, and tubing in warm soapy water, rinse thoroughly, and air-dry out of direct sunlight.",
          "Replace supplies on the schedule your insurance allows — worn cushions and filters reduce therapy effectiveness.",
          "Never use bleach, alcohol, or scented cleaners on equipment that contacts your airway.",
        ],
      },
      {
        heading: "Getting comfortable with therapy",
        paragraphs: [
          "It is normal to need a few weeks to adjust. If your mask leaks, your nose feels dry or congested, or the pressure feels difficult, contact us before stopping therapy — most issues are solved with a simple adjustment, a different mask size, or a humidity change.",
          "If you experience chest pain, severe shortness of breath, or any medical emergency, call 911. For equipment that is not working, stop use and contact us right away.",
        ],
      },
    ],
  },
  {
    key: "assignment_of_benefits",
    title: "Assignment of Benefits & Authorization to Bill Insurance",
    category: "consent",
    version: V,
    summary:
      "Authorizes the supplier to bill insurance directly and receive payment on the patient's behalf.",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `I request that payment of authorized benefits be made on my behalf to ${c.legalName} for any equipment, supplies, and services furnished to me. I authorize ${c.legalName} to submit claims to my insurance carrier(s), Medicare, Medicaid, and/or any other responsible payer, and I assign to ${c.legalName} all rights to such benefits.`,
        ],
      },
      {
        heading: "Authorization to release information",
        paragraphs: [
          `I authorize ${c.legalName} and my treating physician(s) to release any medical or other information necessary to process my claims, including to my insurer, Medicare/Medicaid, and their contractors. A copy of this authorization may be used in place of the original.`,
        ],
      },
      {
        heading: "Financial responsibility acknowledgement",
        bullets: [
          "I understand that my insurance is a contract between me and my insurer, and that I am financially responsible for any deductible, coinsurance, copayment, or non-covered amount.",
          "I understand benefits quoted are not a guarantee of payment and are subject to my insurer's determination at the time the claim is processed.",
          "I authorize the supplier to appeal denied claims on my behalf and to bill any secondary or tertiary insurance.",
        ],
      },
    ],
  },
  {
    key: "notice_of_privacy_practices",
    title: "Notice of Privacy Practices — Acknowledgement of Receipt",
    category: "privacy",
    version: V,
    summary:
      "HIPAA Notice of Privacy Practices summary and acknowledgement that the patient received it.",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `This notice describes how medical information about you may be used and disclosed by ${c.legalName} and how you can get access to this information. Please review it carefully.`,
        ],
      },
      {
        heading: "How we may use and disclose your health information",
        bullets: [
          "Treatment — to provide, coordinate, and manage your care with your physicians and other providers.",
          "Payment — to bill and collect payment from you, your insurer, or other responsible parties.",
          "Health care operations — for quality assessment, care coordination, training, and business management.",
          "As required by law — including public health, safety, and regulatory reporting obligations.",
        ],
      },
      {
        heading: "Your rights regarding your health information",
        bullets: [
          "You may request to inspect and obtain a copy of your health records.",
          "You may request a correction of information you believe is inaccurate or incomplete.",
          "You may request restrictions on certain uses and disclosures and request confidential communications.",
          "You may request an accounting of certain disclosures and obtain a paper copy of this notice on request.",
          `You may file a complaint with us at ${c.phone} or with the U.S. Department of Health & Human Services without fear of retaliation.`,
        ],
      },
      {
        heading: "Acknowledgement",
        paragraphs: [
          `By signing this packet, I acknowledge that I have received and had the opportunity to review the ${c.legalName} Notice of Privacy Practices. I understand a more detailed copy is available to me on request.`,
        ],
      },
    ],
  },
  {
    key: "patient_rights_responsibilities",
    title: "Patient Rights & Responsibilities",
    category: "rights",
    version: V,
    summary:
      "Statement of patient rights and responsibilities for home medical equipment services.",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c) => [
      {
        heading: "As a patient, you have the right to",
        bullets: [
          "Be treated with dignity, respect, and without discrimination of any kind.",
          "Receive safe, appropriate equipment and competent, courteous service.",
          "Be informed about your equipment, its proper use, and what to do if it fails.",
          "Have your personal health information kept private and secure.",
          "Voice complaints or grievances without fear of reprisal and to have them addressed promptly.",
          "Refuse service and be informed of the consequences of doing so.",
          "Be informed of the charges for equipment and services and your financial responsibility.",
        ],
      },
      {
        heading: "As a patient, you are responsible for",
        bullets: [
          "Providing accurate and complete health and insurance information.",
          "Using and caring for your equipment as instructed and following your physician's plan of care.",
          "Notifying us of any change in your condition, insurance, address, or phone number.",
          "Notifying us promptly if equipment is not functioning properly.",
          "Meeting your financial obligations for the equipment and services provided.",
        ],
      },
      {
        heading: "Concerns and grievances",
        paragraphs: [
          `If you have a concern about your equipment or service, please contact us at ${c.phone} or ${c.email}. We will acknowledge your concern and work to resolve it promptly.`,
        ],
      },
    ],
  },
  {
    key: "financial_responsibility",
    title: "Financial Responsibility & Payment Agreement",
    category: "financial",
    version: V,
    summary:
      "Patient agreement to pay deductibles, coinsurance, and non-covered amounts, with optional card-on-file authorization.",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `I understand that I am financially responsible to ${c.legalName} for all charges not paid by my insurance, including deductibles, coinsurance, copayments, and any items or services determined to be non-covered.`,
        ],
      },
      {
        heading: "Rental and capped-rental items",
        bullets: [
          "For rented equipment, I understand my insurer may make monthly payments and that I am responsible for any patient share each month the item is in my possession.",
          "I will return rented equipment when therapy ends or when requested, and I understand I may be billed the replacement cost for equipment that is not returned or is returned damaged beyond normal wear.",
        ],
      },
      {
        heading: "Statements and payment",
        bullets: [
          "I agree to pay patient-responsibility balances within 30 days of the statement date.",
          "I understand that returned-payment and reasonable collection costs may be added to past-due balances as permitted by law.",
        ],
      },
      {
        heading: "Optional card-on-file authorization",
        paragraphs: [
          `I may authorize ${c.legalName} to keep a payment card securely on file and to charge my patient-responsibility balance after my insurance processes each claim. This authorization is optional, can be revoked in writing at any time, and is handled through a PCI-compliant processor — full card numbers are never stored by ${c.legalName}. Card-on-file enrollment is completed separately and is not required to sign this packet.`,
        ],
      },
    ],
  },
  {
    key: "medicare_supplier_standards",
    title: "Medicare DMEPOS Supplier Standards",
    category: "rights",
    version: V,
    summary:
      "Summary of the Medicare Supplier Standards every accredited DMEPOS supplier must furnish to patients.",
    requiresSignature: false,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `The products and/or services provided to you by ${c.legalName} are subject to the supplier standards contained in the Federal regulations shown at 42 Code of Federal Regulations Section 424.57(c). These standards concern business professional and operational matters (e.g., honoring warranties and hours of operation). The following is an abbreviated list of these standards. The full text is available on request or from your Medicare contractor.`,
        ],
      },
      {
        heading: "Selected supplier standards",
        bullets: [
          "A supplier must be in compliance with all applicable Federal and State licensure and regulatory requirements.",
          "A supplier must provide complete and accurate information on the supplier's enrollment application.",
          "A supplier must honor all warranties under applicable State law and must not charge the patient for the repair or replacement of Medicare-covered items under warranty.",
          "A supplier must agree not to initiate telephone contact with beneficiaries, with limited exceptions allowed under the law.",
          "A supplier must maintain a physical facility, accessible hours of operation, and proof of appropriate liability insurance.",
          "A supplier is responsible for delivery and must instruct beneficiaries on the use of items, and maintain proof of delivery.",
          "A supplier must answer questions and respond to complaints from beneficiaries, and maintain documentation of those complaints.",
          "A supplier must disclose these standards to each beneficiary to whom it supplies a Medicare-covered item.",
        ],
      },
      {
        paragraphs: [
          `This is a summary provided for your information. Receipt of these standards does not require your signature; it is provided as part of your welcome packet.`,
        ],
      },
    ],
  },
  {
    key: "consent_to_care",
    title: "Consent for Care & Release of Information",
    category: "consent",
    version: V,
    summary:
      "Consent to receive equipment/services and to exchange information with physicians and payers.",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c) => [
      {
        paragraphs: [
          `I voluntarily consent to receive the home medical equipment, supplies, and related services ordered by my physician and provided by ${c.legalName}. I understand that ${c.legalName} is a supplier of equipment and services and does not replace the care of my treating physician.`,
        ],
      },
      {
        heading: "Coordination of care",
        bullets: [
          `I authorize ${c.legalName} to communicate with my physician(s) and their staff to obtain orders, documentation, and information needed for my care and billing.`,
          "I understand my equipment is provided pursuant to a valid physician order and that continued service may depend on ongoing physician documentation and, where applicable, demonstrated therapy use.",
          "I consent to receive appointment, resupply, and therapy-related communications by phone, text message, and email at the contact information I have provided.",
        ],
      },
      {
        heading: "Acknowledgement of instruction",
        paragraphs: [
          "I acknowledge that I have been instructed on the safe setup, use, cleaning, and maintenance of my equipment and on what to do if it does not function properly, and that I have had the opportunity to ask questions.",
        ],
      },
    ],
  },
  {
    key: "proof_of_delivery",
    title: "Proof of Delivery & Receipt of Equipment",
    category: "delivery",
    version: V,
    summary:
      "Confirms the patient received the equipment listed and was instructed on its use (signature of delivery).",
    requiresSignature: true,
    defaultIncluded: true,
    build: (c, ctx) => {
      const sections: PacketDocumentSection[] = [
        {
          paragraphs: [
            `By signing below, I confirm that I have received the equipment and supplies furnished by ${c.legalName} as itemized below and on my accompanying delivery documentation.`,
          ],
        },
        ...buildDeliveryDetailSections(ctx?.deliveryDetails ?? null),
      ];
      sections.push(
        {
          heading: "I confirm that",
          bullets: [
            "The items I received match the items listed above and are in good working condition.",
            "I was instructed on the proper setup, use, cleaning, and maintenance of the equipment.",
            "I was given information on whom to contact with questions or problems.",
            "I am recording below the actual date I received this equipment.",
          ],
        },
        {
          paragraphs: [
            `This signed proof of delivery, together with the date of receipt I provide, serves as confirmation of delivery for my records and for billing my insurance, including Medicare. If any item listed was not received, I will contact ${c.legalName} at ${c.phone} before signing.`,
          ],
        },
      );
      return sections;
    },
  },
];

/** The document key whose presence requires capturing a date-received
 *  (a Medicare Proof of Delivery field). */
export const PROOF_OF_DELIVERY_KEY = "proof_of_delivery";

/**
 * The dynamic, per-packet portion of the Proof of Delivery: the CMS-
 * required itemized list of what was delivered, plus delivery date /
 * address when known. Exported so the content layer (content.ts) can
 * splice these into an operator-edited POD template at render time —
 * an edit to the static POD wording must never drop the itemization.
 */
export function buildDeliveryDetailSections(
  dd: DeliveryDetails | null,
): PacketDocumentSection[] {
  const sections: PacketDocumentSection[] = [];
  if (dd?.items && dd.items.length > 0) {
    sections.push({
      heading: "Equipment delivered",
      bullets: dd.items.map((it) => {
        const qty = it.quantity ? `${it.quantity} × ` : "";
        const hcpcs = it.hcpcs ? ` (HCPCS ${it.hcpcs})` : "";
        return `${qty}${it.description}${hcpcs}`;
      }),
    });
  }
  const deliveryFacts: string[] = [];
  if (dd?.deliveryDate) deliveryFacts.push(`Delivery date: ${dd.deliveryDate}`);
  if (dd?.deliveryAddress)
    deliveryFacts.push(`Delivered to: ${dd.deliveryAddress}`);
  if (deliveryFacts.length > 0) {
    sections.push({ heading: "Delivery details", bullets: deliveryFacts });
  }
  return sections;
}

/**
 * Compliance-mandatory document keys: the signed agreements and required
 * disclosures every onboarding packet must carry. The admin UI locks
 * these and the API rejects a packet missing any of them.
 */
const REQUIRED_DOC_KEYS = new Set<string>([
  "assignment_of_benefits",
  "notice_of_privacy_practices",
  "patient_rights_responsibilities",
  "financial_responsibility",
  "medicare_supplier_standards",
  "consent_to_care",
  "proof_of_delivery",
]);

export function requiredPacketDocumentKeys(): string[] {
  return PACKET_TEMPLATES.filter((t) => REQUIRED_DOC_KEYS.has(t.key)).map(
    (t) => t.key,
  );
}

export function isRequiredPacketDocumentKey(key: string): boolean {
  return REQUIRED_DOC_KEYS.has(key);
}

/** True when the packet contains the Proof of Delivery (so the signer
 *  must record the date they received the equipment). */
export function packetRequiresDateReceived(documentKeys: string[]): boolean {
  return documentKeys.includes(PROOF_OF_DELIVERY_KEY);
}

const TEMPLATE_BY_KEY = new Map<string, PacketDocumentTemplate>(
  PACKET_TEMPLATES.map((t) => [t.key, t]),
);

export function getPacketTemplate(
  key: string,
): PacketDocumentTemplate | undefined {
  return TEMPLATE_BY_KEY.get(key);
}

export function isValidPacketDocumentKey(key: string): boolean {
  return TEMPLATE_BY_KEY.has(key);
}

/** The keys included in a standard new-patient packet. */
export function defaultPacketDocumentKeys(): string[] {
  return PACKET_TEMPLATES.filter((t) => t.defaultIncluded).map((t) => t.key);
}

// Last-resort values when the dme_organization row hasn't been seeded
// (dev / preview). The phone is the real support line — a placeholder
// number must never render on a signed patient agreement.
export const FALLBACK_COMPANY: CompanyProfile = {
  legalName: "PennPaps",
  phone: "(814) 471-0627",
  email: "info@pennpaps.com",
  addressLine1: "",
  cityStateZip: "",
  npi: null,
};

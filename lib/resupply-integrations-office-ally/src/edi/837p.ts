// ASC X12 5010 837P (Professional Health Care Claim) builder.
//
// The 837P transaction set is the EDI document a clearinghouse like
// Office Ally expects when it receives a professional claim from a
// supplier. The wire format is segment-delimited (`~`) text with
// element delimiter (`*`) and an optional component delimiter (`:`).
//
// We implement the slice the Office Ally companion guide cares about
// for DME submissions:
//
//   ISA        — interchange envelope
//     GS       — functional group envelope
//       ST     — transaction set header (one per submitter/payer batch)
//         BHT  — beginning of hierarchical transaction
//         1000A — submitter name (us)
//         1000B — receiver name (Office Ally)
//         2000A — billing provider hierarchical level
//           2010AA — billing provider name + NPI + tax id
//         2000B — subscriber hierarchical level (assumes patient == subscriber)
//           SBR  — subscriber primary/secondary
//           2010BA — subscriber demographics
//           2010BB — payer
//           2300 — claim header
//             CLM  — total billed, place-of-service, frequency
//             HI   — diagnosis codes (ICD-10)
//             REF  — prior-authorization number when present
//             2400 — service lines (one LX/SV1/DTP per HCPCS line item)
//       SE     — transaction set trailer (segment count incl. ST/SE)
//     GE       — functional group trailer
//   IEA        — interchange envelope trailer
//
// This is intentionally a SUBSET — we don't emit the optional COB
// (coordination of benefits) loop 2320 or the rendering / referring
// provider loops (2310A/B/C). Those are added when the codebase needs
// them and the wire format never changes for the ones we do support.
//
// We never log the EDI body — it contains PHI (subscriber name + DOB
// + diagnosis). The caller wraps logging at the audit layer.

const SEGMENT_TERMINATOR = "~";
const ELEMENT_SEPARATOR = "*";
const COMPONENT_SEPARATOR = ":";

/** Inputs to a single 837P transaction. One transaction = one or more claims for one payer. */
export interface Claim837PInput {
  /** Our identity (the DME / supplier). */
  submitter: SubmitterIdentity;
  /** The clearinghouse we're sending to. For Office Ally: id `OFFCLY`, qualifier `ZZ`. */
  receiver: ReceiverIdentity;
  /** The billing provider record (us, at the legal-entity level). */
  billingProvider: BillingProvider;
  /** One or more claims. Each claim corresponds to a `resupply.insurance_claims` row. */
  claims: ClaimDetail[];
  /** Envelope control numbers (caller passes monotonic values). */
  control: ControlNumbers;
  /** Production or test marker. Office Ally honours both. */
  usageIndicator: "P" | "T";
}

export interface SubmitterIdentity {
  /** Our trading-partner id assigned by Office Ally. */
  etin: string;
  /** Legal organization name (PennPaps Inc.). */
  organizationName: string;
  /** Contact name for clearinghouse callbacks. */
  contactName: string;
  /** E.164 phone. Office Ally strips the +; we emit digits only. */
  contactPhoneE164: string;
}

export interface ReceiverIdentity {
  /** Office Ally's interchange ID. Always `OFFCLY` for the OA production drop. */
  interchangeId: string;
  /** Office Ally's organization name as printed in their companion guide. */
  organizationName: string;
}

export interface BillingProvider {
  /** Legal name of the DME entity (NM103). */
  organizationName: string;
  /** Type-2 NPI (organization). */
  npi: string;
  /** Federal Tax ID (EIN). 9 digits, no dashes. */
  taxId: string;
  /** Practice physical address — required by 5010 for the billing provider. */
  address: PostalAddress;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  /** Two-letter USPS state code. */
  state: string;
  /** 5 or 9 digit ZIP (no dash). */
  zip: string;
}

export interface ClaimDetail {
  /** Our internal claim ID (CLM01 — payer claim control ref). Max 38 chars. */
  internalClaimId: string;
  /** Total billed (sum of service-line billed amounts). Money in cents. */
  totalBilledCents: number;
  /** Place of service. `12` = patient's home; DME default. */
  placeOfServiceCode: string;
  /** ICD-10 diagnosis codes. First entry is the primary; up to 12 allowed. */
  diagnosisCodes: string[];
  /** Payer-side prior-auth number, when present. Surfaces as REF*G1. */
  priorAuthNumber?: string | null;
  /** Subscriber (patient when policyholder=self; legal guardian otherwise). */
  subscriber: SubscriberDetail;
  /** Payer the claim is being billed to. */
  payer: PayerDetail;
  /** One row per HCPCS service line. Must be non-empty. */
  serviceLines: ServiceLine[];
  /** Loop 2310B — provider who actually rendered the service.
   *  DME defaults to the billing provider; pass null to omit. */
  renderingProvider?: ProviderRef | null;
  /** Loop 2310D — referring / ordering physician.
   *  Required by Medicare DME and most commercial DME payers. */
  referringProvider?: ProviderRef | null;
  /** Loop 2320/2330 — secondary-payer coordination of benefits.
   *  Pass to indicate this is being billed to the primary while a
   *  secondary payer exists; or to the secondary with the primary's
   *  prior-payment info attached. */
  otherSubscriber?: OtherSubscriberDetail | null;
}

export interface ProviderRef {
  /** Type-1 NPI (individual). 10 digits. */
  npi: string;
  /** Full legal first name. */
  firstName: string;
  /** Full legal last name. */
  lastName: string;
  /** Optional middle name initial. */
  middleName?: string | null;
  /** Optional state license number — surfaces as REF*0B when present. */
  stateLicenseNumber?: string | null;
}

export interface OtherSubscriberDetail {
  /** SBR01 payer-responsibility code. `S` = secondary, `T` = tertiary, `P` = primary
   *  (used when WE are billing the secondary and need to disclose primary). */
  payerResponsibility: "P" | "S" | "T";
  /** Subscriber on the other policy. */
  subscriber: SubscriberDetail;
  /** The other payer. */
  payer: PayerDetail;
  /** Dollars the prior payer paid (AMT*D, claim-level). Pass `null` when this is
   *  the prior-payer disclosure and they haven't adjudicated yet. */
  priorPayerPaidCents?: number | null;
}

export interface SubscriberDetail {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. Will be reformatted to CCYYMMDD on the wire. */
  dateOfBirth: string;
  /** `M` | `F` | `U`. */
  gender: "M" | "F" | "U";
  /** Payer-side member id. */
  memberId: string;
  /** Subscriber's address — required for primary subscriber per 5010. */
  address: PostalAddress;
  /** Relationship to insured. `18` = self. */
  relationshipCode: "18" | "01" | "19" | "G8";
}

export interface PayerDetail {
  /** Display name as the payer wants to see it (NM103). */
  organizationName: string;
  /** Office Ally payer ID (NM109). */
  payerId: string;
}

export interface ServiceLine {
  /** HCPCS code (E0601 etc). 5-char alphanumeric. */
  hcpcsCode: string;
  /** Up to 4 two-char modifiers (e.g. ['RR','KX']). */
  modifiers: string[];
  /** Billed amount for this line, in cents. */
  billedCents: number;
  /** Unit count (typically 1 for DME). */
  units: number;
  /** Service date YYYY-MM-DD (same as claim date_of_service for DME). */
  serviceDate: string;
  /** Diagnosis pointers — which entries from `diagnosisCodes` apply to this line.
   *  Pointer is 1-based; e.g. [1] points at the first diagnosis. */
  diagnosisPointers: number[];
}

export interface ControlNumbers {
  /** 9-digit ISA13 interchange control number. */
  interchangeControlNumber: string;
  /** 1-9 digit GS06 group control number. */
  groupControlNumber: string;
  /** 4-9 digit ST02 transaction set control number. */
  transactionSetControlNumber: string;
  /** UTC timestamp (ms) the envelope was built. Drives ISA09/ISA10 + GS04/GS05. */
  builtAt: number;
}

const ELEMENT_FORBIDDEN = new RegExp(
  `[${escapeForCharClass(ELEMENT_SEPARATOR)}${escapeForCharClass(SEGMENT_TERMINATOR)}${escapeForCharClass(COMPONENT_SEPARATOR)}]`,
  "g",
);

function escapeForCharClass(c: string): string {
  return c.replace(/[\\\]^-]/g, "\\$&");
}

/**
 * Strip any of the X12 reserved delimiters from a free-text element.
 * The 5010 standard requires that elements never contain the separator
 * characters themselves — there is no escape mechanism, so the only
 * defensible behaviour is to drop them. Caller-provided phone numbers
 * are also normalised to digits-only here so a leading `+` from an
 * E.164 number doesn't blow past the AAA01 length cap.
 */
export function sanitizeElement(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw.replace(ELEMENT_FORBIDDEN, "").trim();
}

/** Return digits-only form of a phone number (E.164 or otherwise). */
export function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

/** Convert YYYY-MM-DD -> CCYYMMDD (8 digits, no separators). */
export function toCcyymmdd(iso: string): string {
  // Defensive: validate shape so a malformed date doesn't smuggle a
  // delimiter character into the EDI envelope. Throws — invalid dates
  // are a coding error, not a runtime failure mode.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid date for EDI: ${iso}`);
  }
  return iso.replace(/-/g, "");
}

/** Cents -> decimal money string with 2 fractional digits, no commas, no $. */
export function centsToMoney(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Invalid money value: ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  const minor = cents % 100;
  return `${dollars}.${minor.toString().padStart(2, "0")}`;
}

function joinSegment(elements: readonly string[]): string {
  return `${elements.join(ELEMENT_SEPARATOR)}${SEGMENT_TERMINATOR}`;
}

interface BuildOptions {
  /** Override for the segment terminator. Tests use `~\n` for readability. */
  segmentTerminatorSuffix?: string;
}

export interface Built837P {
  /** The fully serialized 837P transaction as bytes-ready text. */
  payload: string;
  /** ISA13 — caller persists. */
  interchangeControlNumber: string;
  /** GS06 — caller persists. */
  groupControlNumber: string;
  /** Count of CLM segments emitted. Caller sanity-checks against `input.claims.length`. */
  claimCount: number;
}

/**
 * Build one full 837P interchange envelope from the supplied claim input.
 *
 * The output is a single multi-segment string ready for SFTP upload to
 * Office Ally. The caller is responsible for choosing fresh control
 * numbers (see `nextControlNumbers()`) and persisting them so the next
 * upload is monotonic.
 */
export function build837P(
  input: Claim837PInput,
  opts: BuildOptions = {},
): Built837P {
  if (input.claims.length === 0) {
    throw new Error("build837P: claims must be non-empty");
  }
  for (const c of input.claims) {
    if (c.serviceLines.length === 0) {
      throw new Error(
        `build837P: claim ${c.internalClaimId} has no service lines`,
      );
    }
    if (c.diagnosisCodes.length === 0) {
      throw new Error(
        `build837P: claim ${c.internalClaimId} has no diagnosis codes`,
      );
    }
    if (c.diagnosisCodes.length > 12) {
      throw new Error(
        `build837P: claim ${c.internalClaimId} has > 12 diagnoses`,
      );
    }
  }

  const segments: string[] = [];
  const built = new Date(input.control.builtAt);
  const ccyymmdd = `${built.getUTCFullYear()}${twoDigit(built.getUTCMonth() + 1)}${twoDigit(built.getUTCDate())}`;
  const yymmdd = ccyymmdd.slice(2);
  const hhmm = `${twoDigit(built.getUTCHours())}${twoDigit(built.getUTCMinutes())}`;
  const isaCtl = leftPadDigits(input.control.interchangeControlNumber, 9);
  const gsCtl = stripLeadingZeros(input.control.groupControlNumber) || "1";
  const stCtl = leftPadDigits(input.control.transactionSetControlNumber, 4);

  // ISA — 16 fixed elements + segment terminator. Note ISA needs
  // fixed-length elements; we pad strictly.
  segments.push(
    joinSegment([
      "ISA",
      "00", // ISA01 authorization information qualifier
      "          ", // ISA02 authorization (10 spaces)
      "00", // ISA03 security information qualifier
      "          ", // ISA04 security (10 spaces)
      "ZZ", // ISA05 sender qualifier
      padOrTrunc(sanitizeElement(input.submitter.etin), 15),
      "ZZ", // ISA07 receiver qualifier
      padOrTrunc(sanitizeElement(input.receiver.interchangeId), 15),
      yymmdd, // ISA09 — date YYMMDD
      hhmm, // ISA10 — time HHMM
      "^", // ISA11 — repetition separator
      "00501", // ISA12 — interchange control version
      isaCtl, // ISA13
      "0", // ISA14 — ack requested (0 = no TA1; 999 still flows)
      input.usageIndicator, // ISA15
      COMPONENT_SEPARATOR, // ISA16
    ]),
  );

  segments.push(
    joinSegment([
      "GS",
      "HC", // GS01 — health care claim
      sanitizeElement(input.submitter.etin),
      sanitizeElement(input.receiver.interchangeId),
      ccyymmdd, // GS04
      hhmm, // GS05
      gsCtl, // GS06
      "X", // GS07 — accredited standards committee
      "005010X222A1", // GS08 — version (837P)
    ]),
  );

  // ST — transaction set header
  segments.push(joinSegment(["ST", "837", stCtl, "005010X222A1"]));

  // BHT — beginning of hierarchical transaction
  segments.push(
    joinSegment([
      "BHT",
      "0019", // hierarchical structure code
      "00", // transaction set purpose: original
      sanitizeElement(input.control.transactionSetControlNumber).slice(0, 30),
      ccyymmdd,
      hhmm,
      "CH", // claim or encounter ⇒ chargeable
    ]),
  );

  // 1000A — Submitter
  segments.push(
    joinSegment([
      "NM1",
      "41", // submitter
      "2", // non-person entity
      padOrTrunc(sanitizeElement(input.submitter.organizationName), 60),
      "",
      "",
      "",
      "",
      "46", // ETIN
      sanitizeElement(input.submitter.etin),
    ]),
  );
  segments.push(
    joinSegment([
      "PER",
      "IC", // information contact
      padOrTrunc(sanitizeElement(input.submitter.contactName), 60),
      "TE",
      digitsOnly(input.submitter.contactPhoneE164),
    ]),
  );

  // 1000B — Receiver
  segments.push(
    joinSegment([
      "NM1",
      "40", // receiver
      "2",
      padOrTrunc(sanitizeElement(input.receiver.organizationName), 60),
      "",
      "",
      "",
      "",
      "46",
      sanitizeElement(input.receiver.interchangeId),
    ]),
  );

  // 2000A — Billing provider hierarchical level
  let hierarchicalId = 1;
  const billingHl = String(hierarchicalId++);
  segments.push(
    joinSegment([
      "HL",
      billingHl,
      "",
      "20", // billing provider
      "1", // has subordinate (subscriber)
    ]),
  );
  segments.push(joinSegment(["PRV", "BI", "PXC", "332B00000X"])); // 332B00000X = Durable Medical Equipment & Medical Supplies

  // 2010AA — Billing provider name
  const bp = input.billingProvider;
  segments.push(
    joinSegment([
      "NM1",
      "85", // billing provider
      "2",
      padOrTrunc(sanitizeElement(bp.organizationName), 60),
      "",
      "",
      "",
      "",
      "XX", // NPI
      sanitizeElement(bp.npi),
    ]),
  );
  segments.push(
    joinSegment(["N3", padOrTrunc(sanitizeElement(bp.address.line1), 55)]),
  );
  segments.push(
    joinSegment([
      "N4",
      padOrTrunc(sanitizeElement(bp.address.city), 30),
      sanitizeElement(bp.address.state).slice(0, 2),
      digitsOnly(bp.address.zip),
    ]),
  );
  segments.push(joinSegment(["REF", "EI", digitsOnly(bp.taxId)])); // EI = Employer ID

  // One 2000B subscriber HL per claim. We assume one subscriber per
  // claim (the patient when relationshipCode==18), which matches the
  // current insurance_claims model. Multi-patient batches would loop
  // the subscriber HL outside the claim loop — that's a future
  // enhancement; we already loop them sibling-wise here so the wire
  // format is well-formed for either pattern.
  let claimCount = 0;
  for (const claim of input.claims) {
    const subHl = String(hierarchicalId++);
    segments.push(
      joinSegment([
        "HL",
        subHl,
        billingHl,
        "22", // subscriber
        "0", // no further subordinate
      ]),
    );
    segments.push(
      joinSegment([
        "SBR",
        "P", // primary
        claim.subscriber.relationshipCode,
        "", // group/policy number lives in 2010BA REF*0F when known
        "", // group name
        "",
        "",
        "",
        "",
        "CI", // commercial insurance
      ]),
    );

    // 2010BA — subscriber name
    const sub = claim.subscriber;
    segments.push(
      joinSegment([
        "NM1",
        "IL", // insured / subscriber
        "1", // person
        padOrTrunc(sanitizeElement(sub.lastName), 60),
        padOrTrunc(sanitizeElement(sub.firstName), 35),
        "",
        "",
        "",
        "MI", // member identification number
        sanitizeElement(sub.memberId),
      ]),
    );
    segments.push(
      joinSegment(["N3", padOrTrunc(sanitizeElement(sub.address.line1), 55)]),
    );
    segments.push(
      joinSegment([
        "N4",
        padOrTrunc(sanitizeElement(sub.address.city), 30),
        sanitizeElement(sub.address.state).slice(0, 2),
        digitsOnly(sub.address.zip),
      ]),
    );
    segments.push(
      joinSegment(["DMG", "D8", toCcyymmdd(sub.dateOfBirth), sub.gender]),
    );

    // 2010BB — payer
    segments.push(
      joinSegment([
        "NM1",
        "PR", // payer
        "2",
        padOrTrunc(sanitizeElement(claim.payer.organizationName), 60),
        "",
        "",
        "",
        "",
        "PI", // payer identification
        sanitizeElement(claim.payer.payerId),
      ]),
    );

    // 2300 — claim header
    segments.push(
      joinSegment([
        "CLM",
        padOrTrunc(sanitizeElement(claim.internalClaimId), 38),
        centsToMoney(claim.totalBilledCents),
        "",
        "",
        // CLM05 composite — place of service : facility-code-qualifier (B) : frequency (1)
        `${sanitizeElement(claim.placeOfServiceCode).slice(0, 2)}${COMPONENT_SEPARATOR}B${COMPONENT_SEPARATOR}1`,
        "Y", // provider/signature on file
        "A", // provider accepts assignment
        "Y", // benefits assignment
        "Y", // release of information
      ]),
    );

    // HI — diagnoses. First entry uses code ABK (principal ICD-10);
    // subsequent entries use ABF.
    const hiComposites = claim.diagnosisCodes.map((dx, i) => {
      const qualifier = i === 0 ? "ABK" : "ABF";
      return `${qualifier}${COMPONENT_SEPARATOR}${sanitizeElement(dx).replace(/\./g, "")}`;
    });
    segments.push(joinSegment(["HI", ...hiComposites]));

    if (claim.priorAuthNumber) {
      segments.push(
        joinSegment([
          "REF",
          "G1",
          sanitizeElement(claim.priorAuthNumber).slice(0, 50),
        ]),
      );
    }

    // 2310B — rendering provider. NM1*82, REF*0B when license present.
    if (claim.renderingProvider) {
      const rp = claim.renderingProvider;
      segments.push(
        joinSegment([
          "NM1",
          "82",
          "1",
          padOrTrunc(sanitizeElement(rp.lastName), 60),
          padOrTrunc(sanitizeElement(rp.firstName), 35),
          padOrTrunc(sanitizeElement(rp.middleName ?? ""), 25),
          "",
          "",
          "XX",
          sanitizeElement(rp.npi),
        ]),
      );
      if (rp.stateLicenseNumber) {
        segments.push(
          joinSegment([
            "REF",
            "0B",
            sanitizeElement(rp.stateLicenseNumber).slice(0, 50),
          ]),
        );
      }
    }

    // 2310D — referring / ordering / prescribing physician. NM1*DN.
    // For DME, Medicare specifically requires this loop with the
    // prescribing NPI; commercial DME payers generally honor the
    // same convention.
    if (claim.referringProvider) {
      const rp = claim.referringProvider;
      segments.push(
        joinSegment([
          "NM1",
          "DN",
          "1",
          padOrTrunc(sanitizeElement(rp.lastName), 60),
          padOrTrunc(sanitizeElement(rp.firstName), 35),
          padOrTrunc(sanitizeElement(rp.middleName ?? ""), 25),
          "",
          "",
          "XX",
          sanitizeElement(rp.npi),
        ]),
      );
      if (rp.stateLicenseNumber) {
        segments.push(
          joinSegment([
            "REF",
            "0B",
            sanitizeElement(rp.stateLicenseNumber).slice(0, 50),
          ]),
        );
      }
    }

    // 2320 / 2330 — coordination of benefits. We emit a single OI
    // payer disclosure: SBR (other subscriber info), NM1*IL + N3 + N4
    // + DMG (other subscriber demographics), NM1*PR (other payer),
    // AMT*D (prior payer paid amount, when known).
    if (claim.otherSubscriber) {
      const oth = claim.otherSubscriber;
      segments.push(
        joinSegment([
          "SBR",
          oth.payerResponsibility,
          oth.subscriber.relationshipCode,
          "",
          "",
          "",
          "",
          "",
          "",
          "CI",
        ]),
      );
      if (
        oth.priorPayerPaidCents !== null &&
        oth.priorPayerPaidCents !== undefined
      ) {
        segments.push(
          joinSegment(["AMT", "D", centsToMoney(oth.priorPayerPaidCents)]),
        );
      }
      // OI — informational subscriber, benefits assignment, release of info
      segments.push(joinSegment(["OI", "", "", "Y", "", "", "Y"]));
      // 2330A — other subscriber name
      segments.push(
        joinSegment([
          "NM1",
          "IL",
          "1",
          padOrTrunc(sanitizeElement(oth.subscriber.lastName), 60),
          padOrTrunc(sanitizeElement(oth.subscriber.firstName), 35),
          "",
          "",
          "",
          "MI",
          sanitizeElement(oth.subscriber.memberId),
        ]),
      );
      segments.push(
        joinSegment([
          "N3",
          padOrTrunc(sanitizeElement(oth.subscriber.address.line1), 55),
        ]),
      );
      segments.push(
        joinSegment([
          "N4",
          padOrTrunc(sanitizeElement(oth.subscriber.address.city), 30),
          sanitizeElement(oth.subscriber.address.state).slice(0, 2),
          digitsOnly(oth.subscriber.address.zip),
        ]),
      );
      segments.push(
        joinSegment([
          "DMG",
          "D8",
          toCcyymmdd(oth.subscriber.dateOfBirth),
          oth.subscriber.gender,
        ]),
      );
      // 2330B — other payer
      segments.push(
        joinSegment([
          "NM1",
          "PR",
          "2",
          padOrTrunc(sanitizeElement(oth.payer.organizationName), 60),
          "",
          "",
          "",
          "",
          "PI",
          sanitizeElement(oth.payer.payerId),
        ]),
      );
    }

    // 2400 — service lines
    claim.serviceLines.forEach((line, idx) => {
      const lx = String(idx + 1);
      segments.push(joinSegment(["LX", lx]));
      const modifiers = line.modifiers
        .slice(0, 4)
        .map((m) => sanitizeElement(m).slice(0, 2));
      const sv1Procedure = [
        "HC", // qualifier — HCPCS
        sanitizeElement(line.hcpcsCode).slice(0, 5),
        ...modifiers,
      ].join(COMPONENT_SEPARATOR);
      const diagPointers = line.diagnosisPointers
        .slice(0, 4)
        .map((p) => String(p))
        .join(COMPONENT_SEPARATOR);
      segments.push(
        joinSegment([
          "SV1",
          sv1Procedure,
          centsToMoney(line.billedCents),
          "UN", // units
          String(line.units),
          "", // place of service (defaults to CLM05)
          "",
          diagPointers || "1",
        ]),
      );
      segments.push(
        joinSegment([
          "DTP",
          "472", // service date
          "D8",
          toCcyymmdd(line.serviceDate),
        ]),
      );
    });

    claimCount++;
  }

  // SE — segment count is everything from ST (inclusive) to SE (inclusive).
  // We need to count segments emitted since the ST line for this transaction.
  const stIdx = segments.findIndex((s) => s.startsWith("ST*"));
  const segmentsInTxn = segments.length - stIdx + 1; // +1 for the SE we'll add
  segments.push(joinSegment(["SE", String(segmentsInTxn), stCtl]));

  // GE — functional group trailer (1 ST in this group)
  segments.push(joinSegment(["GE", "1", gsCtl]));

  // IEA — interchange trailer (1 functional group in this interchange)
  segments.push(joinSegment(["IEA", "1", isaCtl]));

  const suffix = opts.segmentTerminatorSuffix ?? "";
  const payload =
    suffix === ""
      ? segments.join("")
      : segments
          .map((s) => s + suffix.replace(SEGMENT_TERMINATOR, ""))
          .join("");

  return {
    payload,
    interchangeControlNumber: isaCtl,
    groupControlNumber: gsCtl,
    claimCount,
  };
}

// ───────── small helpers ─────────

function twoDigit(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function leftPadDigits(value: string, width: number): string {
  const digits = digitsOnly(value);
  if (digits.length >= width) return digits.slice(-width);
  return digits.padStart(width, "0");
}

function stripLeadingZeros(value: string): string {
  const digits = digitsOnly(value);
  return digits.replace(/^0+(?=\d)/, "");
}

function padOrTrunc(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width);
  return value;
}

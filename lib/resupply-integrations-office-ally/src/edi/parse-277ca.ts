// 277CA Claim Acknowledgment parser.
//
// Office Ally returns a 277CA after the 999 acceptance to communicate
// per-claim acceptance / rejection at the payer (or clearinghouse)
// stage. The body of interest:
//
//   ST*277* ... BHT
//   HL*1*  20  (information source)
//   HL*2*1 21  (information receiver)
//   HL*3*2 19  (provider of service)
//   HL*4*3 PT  (subscriber)
//     NM1*QC*1*<last>*<first>...   subscriber name
//     TRN*2*<payer claim id>       trace number
//     STC*<status code list>*<status date>*<action>*<total charge>*<paid amount>*<adjustment>
//     REF*1K*<payer claim ref>     (assigned by payer)
//     REF*BLT*<bill type>          (when relevant)
//
// We surface one row per claim block — keyed by the trace number we
// originally put on the 837P (TRN02 in the claim block here).
//
// The status code list (STC01) is a composite triple
//   industry-code : status-category-code : entity-identifier-code
// where status-category-code is A=accepted, R=rejected.

import { parseX12, parseMoneyToCents, splitComposite } from "./parse-segments";

export interface Parsed277CA {
  claims: Parsed277CAClaim[];
}

export interface Parsed277CAClaim {
  /** The TRN02 trace number we sent on the original 837P. */
  traceNumber: string | null;
  /** Payer-assigned claim reference (REF*1K), when present. */
  payerClaimRef: string | null;
  /** Patient ID the payer references back (NM109 on QC name segment). */
  patientId: string | null;
  /** Patient last name + first name as the payer sees them. */
  subscriberLastName: string | null;
  subscriberFirstName: string | null;
  /** Outcome: accepted or rejected. */
  outcome: "accepted" | "rejected" | "pended" | "unknown";
  /** Free-text payer-supplied status messages. */
  statusMessages: string[];
  /** Total charge as the payer received it. */
  totalChargeCents: number;
  /** Amount the payer reports as paid; usually 0 for a 277CA. */
  paidCents: number;
}

/**
 * Parse an X12 277CA acknowledgment document into structured claim records.
 *
 * Produces one Parsed277CAClaim per subscriber/patient HL block, extracting fields such as trace number, payer claim reference, subscriber/patient identifiers and names, adjudication outcome, payer status messages, and monetary amounts (total charge and paid amount, in cents).
 *
 * @returns An object with a `claims` array of Parsed277CAClaim. Each claim contains:
 * - `traceNumber`: trace identifier or `null`
 * - `payerClaimRef`: payer claim reference or `null`
 * - `patientId`: patient identifier or `null`
 * - `subscriberLastName` / `subscriberFirstName`: subscriber name parts or `null`
 * - `outcome`: one of `"accepted" | "rejected" | "pended" | "unknown"`
 * - `statusMessages`: array of status message strings
 * - `totalChargeCents`: total charge in cents (number)
 * - `paidCents`: paid amount in cents (number)
 */
export function parse277CA(input: string): Parsed277CA {
  const { segments, delimiters } = parseX12(input);
  const claims: Parsed277CAClaim[] = [];
  let current: Parsed277CAClaim | null = null;
  let hlPt = false; // are we inside a subscriber / patient HL block?

  for (const seg of segments) {
    if (seg.id === "HL") {
      const levelCode = seg.elements[2];
      if (levelCode === "22" || levelCode === "PT") {
        // Open a new claim/patient block; flush any in-flight one.
        if (current) claims.push(current);
        current = {
          traceNumber: null,
          payerClaimRef: null,
          patientId: null,
          subscriberLastName: null,
          subscriberFirstName: null,
          outcome: "unknown",
          statusMessages: [],
          totalChargeCents: 0,
          paidCents: 0,
        };
        hlPt = true;
      } else {
        hlPt = false;
      }
    } else if (!current || !hlPt) {
      continue;
    } else if (seg.id === "NM1" && seg.elements[0] === "QC") {
      current.subscriberLastName = (seg.elements[2] ?? "").trim() || null;
      current.subscriberFirstName = (seg.elements[3] ?? "").trim() || null;
      current.patientId = (seg.elements[8] ?? "").trim() || null;
    } else if (seg.id === "TRN") {
      current.traceNumber = (seg.elements[1] ?? "").trim() || null;
    } else if (seg.id === "REF" && seg.elements[0] === "1K") {
      current.payerClaimRef = (seg.elements[1] ?? "").trim() || null;
    } else if (seg.id === "STC") {
      const parts = splitComposite(seg.elements[0] ?? "", delimiters.component);
      // STC01-01 is the Health Care Claim Status Category Code per
      // X12 5010 codeset 507. STC01-02 is the granular status code
      // (numeric), STC01-03 is the entity identifier.
      //
      // The "A" (Acknowledgement) family splits into accept vs. reject:
      //   A1 / A2          — received / accepted into adjudication → accepted
      //   A3               — returned as unprocessable             → rejected
      //   A4               — claim not found                       → rejected
      //   A6 / A7 / A8     — rejected (missing/invalid/relational) → rejected
      // P1 / P2 are pended; everything else stays `unknown`.
      //
      // The ENTIRE rejection family must be classified as rejected:
      // dispatch277ca maps any non-"rejected" outcome to
      // `accepted_277ca`, so a rejection that fell through to `unknown`
      // (A4 / A6 / A8 — previously unhandled) was silently persisted as
      // ACCEPTED, masking a denied claim from CSR triage.
      const statusCategoryCode = parts[0] ?? "";
      if (statusCategoryCode === "A1" || statusCategoryCode === "A2") {
        current.outcome = "accepted";
      } else if (
        statusCategoryCode === "A3" ||
        statusCategoryCode === "A4" ||
        statusCategoryCode === "A6" ||
        statusCategoryCode === "A7" ||
        statusCategoryCode === "A8"
      ) {
        current.outcome = "rejected";
      } else if (statusCategoryCode === "P1" || statusCategoryCode === "P2") {
        current.outcome = "pended";
      }
      // Compose the message text from the codes the payer provided.
      const message = parts.filter(Boolean).join(":");
      if (message) current.statusMessages.push(message);
      // STC04 = total charge, STC05 = paid amount when populated.
      const charge = seg.elements[3];
      if (charge) {
        try {
          current.totalChargeCents = parseMoneyToCents(charge);
        } catch {
          // Skip — malformed money in an ack shouldn't crash the parser.
        }
      }
      const paid = seg.elements[4];
      if (paid) {
        try {
          current.paidCents = parseMoneyToCents(paid);
        } catch {
          // ignore
        }
      }
    }
  }
  if (current) claims.push(current);
  return { claims };
}

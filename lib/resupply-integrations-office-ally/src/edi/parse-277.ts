// 277 (Health Care Claim Status Response, 005010X212) parser.
//
// Distinct from parse-277ca.ts: that handles the 277CA *acknowledgement*
// (claim accepted/rejected at intake). THIS parses the 277 claim-status
// *response* to a 276 inquiry — the adjudication state of an already-
// accepted claim (pending / finalized-paid / finalized-denied / …).
//
// The status lives in STC segments. STC01 is a composite:
//   <category code>:<status code>[:<entity>]
// e.g. STC*F1:65*20260601*WQ*100*100~
//   STC01-1 category code  (A/E/F/P/R/D…; F1=finalized-payment,
//                           F2=finalized-denial, F3=finalized-revised,
//                           F4=finalized-no-payment, P*=pending)
//   STC01-2 status code     (numeric detail)
//   STC02   status date     (CCYYMMDD)
//   STC04   total charge amount
//   STC05   total paid amount
//
// Matching keys echoed from the 276:
//   TRN02   our trace reference
//   REF*EJ  our claim id (patient control number)
//   REF*1K  the payer's claim control number
//
// One 277 can carry many claims; we return one entry per STC-bearing
// claim loop, plus the file-level trace reference.

import { parseMoneyToCents, parseX12 } from "./parse-segments";

export interface Parsed277ClaimStatus {
  /** Our trace reference (TRN02) — primary match key to the 276. */
  traceReference: string | null;
  /** Our claim id (REF*EJ / patient control number). */
  claimControlNumber: string | null;
  /** Payer's claim control number (REF*1K), when present. */
  payerClaimControlNumber: string | null;
  /** STC01-1 — health-care-claim-status category code. */
  categoryCode: string | null;
  /** STC01-2 — claim status code. */
  statusCode: string | null;
  /** STC02 — status date (CCYYMMDD), as supplied. */
  statusDate: string | null;
  totalChargeCents: number | null;
  totalPaidCents: number | null;
  /** Coarse derived outcome for the worklist. */
  outcome: Parsed277Outcome;
}

export type Parsed277Outcome =
  | "acknowledged"
  | "pending"
  | "finalized_paid"
  | "finalized_denied"
  | "finalized_other"
  | "error"
  | "unknown";

export interface Parsed277 {
  /** First trace reference seen — convenience for single-claim inquiries. */
  traceReference: string | null;
  claims: Parsed277ClaimStatus[];
}

/**
 * Map an STC category code to a coarse outcome. Category-code families
 * (X12 507): A=accepted/acknowledged, P=pending, F=finalized, R=request
 * for additional info, E=error/response-not-possible, D=data error.
 */
export function deriveOutcome(categoryCode: string | null): Parsed277Outcome {
  if (!categoryCode) return "unknown";
  const c = categoryCode.toUpperCase();
  if (c === "F1" || c === "F3") return "finalized_paid";
  if (c === "F2") return "finalized_denied";
  if (c.startsWith("F")) return "finalized_other";
  if (c.startsWith("P")) return "pending";
  if (c.startsWith("A") || c.startsWith("R")) return "acknowledged";
  if (c.startsWith("E") || c.startsWith("D")) return "error";
  return "unknown";
}

export function parse277(input: string): Parsed277 {
  const { segments, delimiters } = parseX12(input);
  const claims: Parsed277ClaimStatus[] = [];
  let fileTrace: string | null = null;

  // Accumulate into the "current" claim as we walk the hierarchy. A new
  // TRN (claim-level tracking) or an STC with no open claim starts a new
  // entry; REF*EJ / REF*1K attach to whichever claim loop is open.
  let current: Parsed277ClaimStatus | null = null;
  const flush = (): void => {
    if (current) {
      claims.push(current);
      current = null;
    }
  };
  const ensure = (): Parsed277ClaimStatus => {
    if (!current) {
      current = {
        traceReference: null,
        claimControlNumber: null,
        payerClaimControlNumber: null,
        categoryCode: null,
        statusCode: null,
        statusDate: null,
        totalChargeCents: null,
        totalPaidCents: null,
        outcome: "unknown",
      };
    }
    return current;
  };

  for (const seg of segments) {
    if (seg.id === "TRN") {
      // A new claim-level TRN starts a new claim entry.
      flush();
      const ref = (seg.elements[1] ?? "").trim();
      const c = ensure();
      c.traceReference = ref || null;
      if (ref && !fileTrace) fileTrace = ref;
    } else if (seg.id === "STC") {
      const c = ensure();
      const composite = (seg.elements[0] ?? "").split(delimiters.component);
      c.categoryCode = (composite[0] ?? "").trim() || null;
      c.statusCode = (composite[1] ?? "").trim() || null;
      c.statusDate = (seg.elements[1] ?? "").trim() || null;
      const charge = (seg.elements[3] ?? "").trim();
      const paid = (seg.elements[4] ?? "").trim();
      if (charge) c.totalChargeCents = safeMoney(charge);
      if (paid) c.totalPaidCents = safeMoney(paid);
      c.outcome = deriveOutcome(c.categoryCode);
    } else if (seg.id === "REF") {
      const qual = (seg.elements[0] ?? "").trim();
      const val = (seg.elements[1] ?? "").trim();
      if (!val) continue;
      const c = ensure();
      if (qual === "EJ") c.claimControlNumber = val;
      else if (qual === "1K") c.payerClaimControlNumber = val;
    }
  }
  flush();

  return { traceReference: fileTrace, claims };
}

function safeMoney(s: string): number {
  try {
    return parseMoneyToCents(s);
  } catch {
    return 0;
  }
}

// 835 ERA (Electronic Remittance Advice) parser.
//
// The 835 is what payers send back to tell us "we paid this claim
// $X, with these adjustments, and the remaining $Y is the patient's
// responsibility". It is the single most valuable EDI document for
// reconciling AR — without it, the DME chases every payment by hand.
//
// Wire shape (5010X221A1 subset we honour):
//
//   ST*835*<ctl>
//   BPR*I*<total paid>*C*ACH ...  payer-to-provider monetary detail
//   TRN*1*<check or EFT number>*<originating payer id>
//   REF*EV*<additional ref>
//   DTM*405*<payment date YYYYMMDD>
//   N1*PR*<payer name>*XV*<payer id>
//     N3*<addr line 1>
//     N4*<city>*<state>*<zip>
//   N1*PE*<payee / provider name>*XX*<NPI>
//   LX*1                                      (per-check loop separator)
//     CLP*<patient ctl>*<status>*<total charge>*<paid>*<patient resp>*<filing indicator>*<payer claim ref>*<facility>*<freq>
//       CAS*<group>*<reason code>*<amount>*<qty>* ...   (claim-level adjustments)
//       NM1*QC*1*<patient last>*<patient first> ...
//       SVC*<HC|HCPCS>:<code>:<modifiers>*<line charge>*<line paid>*<svc>*<units>*<units>
//         DTM*472*<service date>
//         CAS*<group>*<reason code>*<amount>* ...       (line-level adjustments)
//   PLB*<NPI>*<fiscal period date>*<adj id>*<amount>    (provider-level adjustments)
//   SE ...
//
// Adjustment group codes (CAS01):
//   CO — contractual obligation (writeoff; never billable to patient)
//   PR — patient responsibility (deductible, coinsurance, copay)
//   OA — other adjustment (informational)
//   PI — payer-initiated reductions (rare; not billable to patient)
//
// We surface a structured shape that the API layer can persist into
// resupply.insurance_claims / insurance_claim_line_items /
// insurance_claim_events without further EDI knowledge.

import { parseX12, parseMoneyToCents, splitComposite } from "./parse-segments";

export interface Parsed835 {
  totalPaidCents: number;
  paymentMethod: string | null;
  paymentDate: string | null;
  /** TRN02 — the payer's check or EFT number. */
  checkOrEftNumber: string | null;
  /** TRN03 — the originating payer id. */
  originatingPayerId: string | null;
  /** REF*EV — when the payer echoes our submitter ETIN back. */
  receiverIdentifier: string | null;
  payerName: string | null;
  payerId: string | null;
  payeeName: string | null;
  payeeNpi: string | null;
  claims: Parsed835Claim[];
  /** Provider-level adjustments (PLB segments). */
  providerAdjustments: ProviderAdjustment[];
}

export interface Parsed835Claim {
  /** CLP01 — our submitter claim control number (the same string we
   *  put on the 837P CLM01). This is the join key back to
   *  resupply.insurance_claims. */
  patientControlNumber: string;
  /** CLP02 — claim status: 1=primary processed as primary, 2=processed
   *  as secondary, 3=processed as tertiary, 4=denied, 19=processed as
   *  primary forwarded, 22=reversal, ... */
  claimStatusCode: string;
  totalChargeCents: number;
  paidCents: number;
  patientResponsibilityCents: number;
  filingIndicator: string | null;
  payerClaimReference: string | null;
  /** Patient name as the payer echoes it back. */
  patientLastName: string | null;
  patientFirstName: string | null;
  /** Claim-level CAS adjustments. */
  adjustments: Adjustment[];
  /** Service-line detail (SVC + nested CAS). */
  serviceLines: Parsed835ServiceLine[];
  /** Convenience: did this claim end with non-zero paid? */
  isPaid: boolean;
  /** Convenience: was this claim denied (status 4 / 22 / 23)? */
  isDenied: boolean;
}

export interface Parsed835ServiceLine {
  /** HCPCS code from SVC01 composite element. */
  hcpcsCode: string | null;
  modifiers: string[];
  billedCents: number;
  paidCents: number;
  unitsBilled: number | null;
  unitsPaid: number | null;
  serviceDate: string | null;
  adjustments: Adjustment[];
}

export interface Adjustment {
  /** CAS01 group code: CO / PR / OA / PI. */
  groupCode: string;
  /** CAS02 reason code (CARC). */
  reasonCode: string;
  amountCents: number;
  /** CAS04 — quantity adjustment, when present. */
  quantity: number | null;
}

export interface ProviderAdjustment {
  groupCode: string;
  amountCents: number;
}

const DENIAL_STATUS_CODES = new Set(["4", "22", "23"]);

export function parse835(input: string): Parsed835 {
  const { segments, delimiters } = parseX12(input);
  const result: Parsed835 = {
    totalPaidCents: 0,
    paymentMethod: null,
    paymentDate: null,
    checkOrEftNumber: null,
    originatingPayerId: null,
    receiverIdentifier: null,
    payerName: null,
    payerId: null,
    payeeName: null,
    payeeNpi: null,
    claims: [],
    providerAdjustments: [],
  };

  let currentClaim: Parsed835Claim | null = null;
  let currentLine: Parsed835ServiceLine | null = null;
  let n1Context: "PR" | "PE" | null = null;

  for (const seg of segments) {
    if (seg.id === "BPR") {
      result.paymentMethod = seg.elements[2] ?? null;
      result.totalPaidCents = safeMoney(seg.elements[1]);
    } else if (seg.id === "TRN") {
      result.checkOrEftNumber = (seg.elements[1] ?? "").trim() || null;
      result.originatingPayerId = (seg.elements[2] ?? "").trim() || null;
    } else if (seg.id === "REF" && seg.elements[0] === "EV") {
      result.receiverIdentifier = (seg.elements[1] ?? "").trim() || null;
    } else if (seg.id === "DTM" && seg.elements[0] === "405") {
      result.paymentDate = formatDate(seg.elements[1]);
    } else if (seg.id === "N1") {
      const qualifier = seg.elements[0];
      if (qualifier === "PR") {
        result.payerName = seg.elements[1] ?? null;
        result.payerId = seg.elements[3] ?? null;
        n1Context = "PR";
      } else if (qualifier === "PE") {
        result.payeeName = seg.elements[1] ?? null;
        result.payeeNpi = seg.elements[3] ?? null;
        n1Context = "PE";
      } else {
        n1Context = null;
      }
    } else if (seg.id === "CLP") {
      // Close any in-flight claim.
      if (currentLine && currentClaim) {
        currentClaim.serviceLines.push(currentLine);
        currentLine = null;
      }
      if (currentClaim) result.claims.push(currentClaim);
      const charge = safeMoney(seg.elements[2]);
      const paid = safeMoney(seg.elements[3]);
      const patientResp = safeMoney(seg.elements[4]);
      const statusCode = (seg.elements[1] ?? "").trim();
      currentClaim = {
        patientControlNumber: (seg.elements[0] ?? "").trim(),
        claimStatusCode: statusCode,
        totalChargeCents: charge,
        paidCents: paid,
        patientResponsibilityCents: patientResp,
        filingIndicator: (seg.elements[5] ?? "").trim() || null,
        payerClaimReference: (seg.elements[6] ?? "").trim() || null,
        patientLastName: null,
        patientFirstName: null,
        adjustments: [],
        serviceLines: [],
        isPaid: paid > 0,
        isDenied: DENIAL_STATUS_CODES.has(statusCode),
      };
      n1Context = null;
    } else if (seg.id === "NM1" && currentClaim && seg.elements[0] === "QC") {
      currentClaim.patientLastName = (seg.elements[2] ?? "").trim() || null;
      currentClaim.patientFirstName = (seg.elements[3] ?? "").trim() || null;
    } else if (seg.id === "SVC" && currentClaim) {
      if (currentLine) {
        currentClaim.serviceLines.push(currentLine);
      }
      const composite = splitComposite(
        seg.elements[0] ?? "",
        delimiters.component,
      );
      // composite[0]=qualifier (HC), composite[1]=HCPCS, composite[2..5]=modifiers
      const hcpcs = composite[1] ?? null;
      const modifiers = composite.slice(2).filter(Boolean);
      currentLine = {
        hcpcsCode: hcpcs,
        modifiers,
        billedCents: safeMoney(seg.elements[1]),
        paidCents: safeMoney(seg.elements[2]),
        unitsBilled: toIntOrNull(seg.elements[4]),
        unitsPaid: toIntOrNull(seg.elements[5]),
        serviceDate: null,
        adjustments: [],
      };
    } else if (seg.id === "DTM" && currentLine && seg.elements[0] === "472") {
      currentLine.serviceDate = formatDate(seg.elements[1]);
    } else if (seg.id === "CAS") {
      const target = currentLine ?? currentClaim;
      if (!target) continue;
      // CAS can carry up to 6 (group, reason, amount, qty) tuples
      // — elements 0-3, 4-7, 8-11, ..., 20-23.
      const groupCode = seg.elements[0] ?? "";
      for (let i = 1; i < seg.elements.length; i += 3) {
        const reason = seg.elements[i];
        const amount = seg.elements[i + 1];
        const qty = seg.elements[i + 2];
        if (!reason && !amount) break;
        target.adjustments.push({
          groupCode,
          reasonCode: (reason ?? "").trim(),
          amountCents: safeMoney(amount),
          quantity: toIntOrNull(qty ?? null),
        });
      }
    } else if (seg.id === "PLB") {
      // Provider-level adjustments. We extract the (qualifier, amount)
      // pairs starting at element index 3 (per CMS spec).
      for (let i = 2; i < seg.elements.length; i += 2) {
        const qualifierComposite = seg.elements[i];
        const amount = seg.elements[i + 1];
        if (!qualifierComposite && !amount) break;
        const parts = splitComposite(
          qualifierComposite ?? "",
          delimiters.component,
        );
        result.providerAdjustments.push({
          groupCode: parts[0] ?? "",
          amountCents: safeMoney(amount),
        });
      }
    }
  }
  if (currentLine && currentClaim) {
    currentClaim.serviceLines.push(currentLine);
  }
  if (currentClaim) result.claims.push(currentClaim);
  // n1Context isn't read after the parser finishes; this assignment
  // exists so the eslint no-unused-vars rule sees it written.
  void n1Context;
  return result;
}

function safeMoney(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    return parseMoneyToCents(raw);
  } catch {
    return 0;
  }
}

function toIntOrNull(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function formatDate(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}

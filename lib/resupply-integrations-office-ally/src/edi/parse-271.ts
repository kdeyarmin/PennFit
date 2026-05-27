// 271 (Health Care Eligibility Benefit Response) parser.
//
// Surfaces the EB segments that matter for the claim builder:
//   isActive, inNetwork, deductibleCents, deductibleMetCents,
//   oopMaxCents, oopMetCents, copayCents, coinsurancePct,
//   requiresPriorAuth, plus the trace reference echoed from TRN02
//   of the original 270.
//
// EB segment legend (X12 5010 271):
//   EB01 — eligibility/benefit info code:
//     1 = active coverage
//     6 = inactive
//     C = deductible
//     G = out of pocket (stop loss)
//     B = copayment
//     A = coinsurance
//     I = non-covered
//   EB04 — coverage level code (FAM/IND)
//   EB05 — insurance type code
//   EB06 — time period qualifier
//   EB07 — money amount (deductible / OOP)
//   EB08 — coinsurance percentage (0.20 = 20%)
//   EB09 — quantity qualifier (Y/V = remaining; D = deductible balance)
//
// HSD segments may follow with quantity / frequency rules.

import { parseX12, parseMoneyToCents } from "./parse-segments";

export interface Parsed271 {
  traceReference: string | null;
  isActive: boolean;
  inNetwork: boolean | null;
  deductibleCents: number | null;
  deductibleMetCents: number | null;
  /**
   * Deductible REMAINING (EB06=29 or Y). Populated when the payer
   * sent a remaining-only segment without a paired total — the
   * downstream claim builder can still surface "you have $X to go"
   * even when total is unknown.
   */
  deductibleRemainingCents: number | null;
  oopMaxCents: number | null;
  oopMetCents: number | null;
  /** Same as deductibleRemainingCents but for the out-of-pocket cap. */
  oopRemainingCents: number | null;
  copayCents: number | null;
  coinsurancePct: number | null;
  requiresPriorAuth: boolean;
  /** Free-form payer-supplied messages (MSG segments). */
  messages: string[];
}

export function parse271(input: string): Parsed271 {
  const { segments } = parseX12(input);
  const out: Parsed271 = {
    traceReference: null,
    isActive: false,
    inNetwork: null,
    deductibleCents: null,
    deductibleMetCents: null,
    deductibleRemainingCents: null,
    oopMaxCents: null,
    oopMetCents: null,
    oopRemainingCents: null,
    copayCents: null,
    coinsurancePct: null,
    requiresPriorAuth: false,
    messages: [],
  };
  // Capture raw totals + remaining values in a first pass so the
  // "met = total - remaining" math can run regardless of segment
  // order. Real payer 271s frequently emit the remaining segment
  // BEFORE the total, which the prior single-pass implementation
  // silently dropped (it nulled deductibleMetCents and the remaining
  // amount was lost).
  let deductibleTotalRaw: number | null = null;
  let deductibleRemainingRaw: number | null = null;
  let oopTotalRaw: number | null = null;
  let oopRemainingRaw: number | null = null;
  // Resolve coverage status after the full scan (see below) so segment
  // order can't let a later EB01=I (non-covered service type) or EB01=6
  // line clobber a plan-level EB01=1 (active) — real 271s carry both.
  let sawActiveCoverage = false;
  for (const seg of segments) {
    if (seg.id === "TRN") {
      // The 271's TRN echoes TRN02 from the 270 — that's our key.
      const ref = (seg.elements[1] ?? "").trim();
      if (ref && !out.traceReference) out.traceReference = ref;
    } else if (seg.id === "EB") {
      const code = (seg.elements[0] ?? "").trim();
      const timeQual = (seg.elements[5] ?? "").trim();
      const amt = (seg.elements[6] ?? "").trim();
      const pct = (seg.elements[7] ?? "").trim();
      // EB01=1 = active coverage. EB01=6 = inactive and EB01=I =
      // non-covered service type both leave the conservative
      // not-active default; a non-covered *service* must never flip
      // plan-level eligibility.
      if (code === "1") sawActiveCoverage = true;
      if (code === "C" && amt) {
        const cents = safeMoney(amt);
        // remaining = "29" or "Y"; total = "23" or "30".
        if (timeQual === "29" || timeQual === "Y") {
          deductibleRemainingRaw = cents;
        } else {
          deductibleTotalRaw = cents;
        }
      }
      if (code === "G" && amt) {
        const cents = safeMoney(amt);
        if (timeQual === "29" || timeQual === "Y") {
          oopRemainingRaw = cents;
        } else {
          oopTotalRaw = cents;
        }
      }
      if (code === "B" && amt) out.copayCents = safeMoney(amt);
      if (code === "A" && pct) {
        const n = Number.parseFloat(pct);
        if (Number.isFinite(n)) {
          out.coinsurancePct = Math.round(n <= 1 ? n * 100 : n);
        }
      }
      // EB03 service-type code "P" = PA required (rare); some payers
      // signal via the MSG that follows. We mark requiresPriorAuth=true
      // when MSG includes phrases like "PRIOR AUTH" or "AUTHORIZATION REQUIRED".
      const inNetworkCode = (seg.elements[11] ?? "").trim();
      if (inNetworkCode === "Y") out.inNetwork = true;
      if (inNetworkCode === "N") out.inNetwork = false;
    } else if (seg.id === "MSG") {
      const text = (seg.elements[0] ?? "").trim();
      if (text) {
        out.messages.push(text);
        if (/PRIOR\s+AUTH|AUTHORIZATION\s+REQUIRED/i.test(text)) {
          out.requiresPriorAuth = true;
        }
      }
    } else if (seg.id === "REF") {
      const qualifier = (seg.elements[0] ?? "").trim();
      // REF*1L — group/policy number; can carry "AUTH REQ" semantics
      // depending on payer.
      if (qualifier === "EJ" || qualifier === "X9") {
        // Plan-network-id signal; some payers indicate PA-required
        // here. Capture but don't mutate requiresPriorAuth — too
        // payer-specific to assume.
        void qualifier;
      }
    }
  }
  // Second pass: compute met = total - remaining where both are
  // known; otherwise expose whichever raw values we got. Order-
  // independent.
  // Plan-level active coverage (any EB01=1) wins; an EB01=6 / EB01=I or
  // a status-segment-less response stays at the conservative
  // not-active default.
  out.isActive = sawActiveCoverage;
  out.deductibleCents = deductibleTotalRaw;
  out.deductibleRemainingCents = deductibleRemainingRaw;
  if (deductibleTotalRaw !== null && deductibleRemainingRaw !== null) {
    out.deductibleMetCents = Math.max(0, deductibleTotalRaw - deductibleRemainingRaw);
  }
  out.oopMaxCents = oopTotalRaw;
  out.oopRemainingCents = oopRemainingRaw;
  if (oopTotalRaw !== null && oopRemainingRaw !== null) {
    out.oopMetCents = Math.max(0, oopTotalRaw - oopRemainingRaw);
  }
  return out;
}

function safeMoney(s: string): number {
  try {
    return parseMoneyToCents(s);
  } catch {
    return 0;
  }
}

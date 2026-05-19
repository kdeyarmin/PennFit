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
  oopMaxCents: number | null;
  oopMetCents: number | null;
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
    oopMaxCents: null,
    oopMetCents: null,
    copayCents: null,
    coinsurancePct: null,
    requiresPriorAuth: false,
    messages: [],
  };
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
      if (code === "1") out.isActive = true;
      if (code === "I") out.isActive = false;
      if (code === "C" && amt) {
        const cents = safeMoney(amt);
        // remaining = "29" or "Y"; total = "23" or "30".
        if (timeQual === "29" || timeQual === "Y") {
          // remaining = deductible - met; we'll compute later if both known
          out.deductibleMetCents = out.deductibleCents
            ? Math.max(0, out.deductibleCents - cents)
            : null;
        } else {
          out.deductibleCents = cents;
        }
      }
      if (code === "G" && amt) {
        const cents = safeMoney(amt);
        if (timeQual === "29" || timeQual === "Y") {
          out.oopMetCents = out.oopMaxCents
            ? Math.max(0, out.oopMaxCents - cents)
            : null;
        } else {
          out.oopMaxCents = cents;
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
  return out;
}

function safeMoney(s: string): number {
  try {
    return parseMoneyToCents(s);
  } catch {
    return 0;
  }
}

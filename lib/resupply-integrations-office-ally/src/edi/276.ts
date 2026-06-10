// ASC X12 5010 276 (Health Care Claim Status Request) builder.
//
// Wire shape (slim 005010X212 subset Office Ally accepts):
//   ISA / GS*HR / ST*276*0001*005010X212 / BHT*0010*13*<trace>*date*time
//   2000A HL*1**20*1     information source (payer)
//     NM1*PR*2*<payer>*****PI*<payer id>
//   2000B HL*2*1*21*1    information receiver (us, the submitter)
//     NM1*41*2*<our org>*****46*<etin>
//   2000C HL*3*2*19*1    service provider
//     NM1*1P*2*<our org>*****XX*<NPI>
//   2000D HL*4*3*22*0    subscriber
//     NM1*IL*1*<last>*<first>****MI*<member id>
//   2200D TRN*1*<trace>             — echoed back in the 277 to match
//     REF*EJ*<our claim id>         — patient control number (our claim)
//     [REF*1K*<payer claim #>]      — when we already know it
//     AMT*T3*<total billed>
//     DTP*472*RD8*<dos>-<dos>
//   SE / GE / IEA
//
// Mirrors the 270 builder (270.ts) — same envelope helpers + trace-ref
// scheme so the 277 parser can match the response to this request.

import { randomBytes } from "node:crypto";

import {
  centsToMoney,
  digitsOnly,
  sanitizeElement,
  toCcyymmdd,
  type ControlNumbers,
} from "./837p";

const SEGMENT_TERMINATOR = "~";
const ELEMENT_SEPARATOR = "*";
const COMPONENT_SEPARATOR = ":";

export interface Build276Input {
  submitter: {
    etin: string;
    organizationName: string;
    npi: string;
  };
  receiver: {
    interchangeId: string;
    organizationName: string;
  };
  payer: {
    organizationName: string;
    payerId: string;
  };
  subscriber: {
    firstName: string;
    lastName: string;
    memberId: string;
  };
  claim: {
    /** Our patient-control-number = the claim id we submitted (REF*EJ). */
    claimControlNumber: string;
    /** The payer's claim control number, when known (REF*1K). */
    payerClaimControlNumber?: string | null;
    totalBilledCents: number;
    /** Date of service (YYYY-MM-DD). */
    serviceDateFrom: string;
    serviceDateTo?: string;
  };
  control: ControlNumbers;
  usageIndicator: "P" | "T";
}

export interface Built276 {
  payload: string;
  interchangeControlNumber: string;
  groupControlNumber: string;
  /** TRN02 — the trace reference the 277 echoes back. */
  traceReference: string;
}

export function build276(input: Build276Input): Built276 {
  const segments: string[] = [];
  const built = new Date(input.control.builtAt);
  const ccyymmdd = `${built.getUTCFullYear()}${twoDigit(built.getUTCMonth() + 1)}${twoDigit(built.getUTCDate())}`;
  const yymmdd = ccyymmdd.slice(2);
  const hhmm = `${twoDigit(built.getUTCHours())}${twoDigit(built.getUTCMinutes())}`;
  const isaCtl = leftPadDigits(input.control.interchangeControlNumber, 9);
  const gsCtl = stripLeadingZeros(input.control.groupControlNumber) || "1";
  const stCtl = leftPadDigits(input.control.transactionSetControlNumber, 4);
  const traceNonce = randomBytes(4).toString("hex");
  const traceRef = `${input.submitter.etin}-${isaCtl}-${stCtl}-${traceNonce}`;

  segments.push(
    join([
      "ISA",
      "00",
      "          ",
      "00",
      "          ",
      "ZZ",
      padFixedWidth(sanitizeElement(input.submitter.etin), 15),
      "ZZ",
      padFixedWidth(sanitizeElement(input.receiver.interchangeId), 15),
      yymmdd,
      hhmm,
      "^",
      "00501",
      isaCtl,
      "0",
      input.usageIndicator,
      COMPONENT_SEPARATOR,
    ]),
  );
  segments.push(
    join([
      "GS",
      "HR",
      sanitizeElement(input.submitter.etin),
      sanitizeElement(input.receiver.interchangeId),
      ccyymmdd,
      hhmm,
      gsCtl,
      "X",
      "005010X212",
    ]),
  );
  segments.push(join(["ST", "276", stCtl, "005010X212"]));
  segments.push(
    join(["BHT", "0010", "13", traceRef.slice(0, 30), ccyymmdd, hhmm]),
  );

  // 2000A — information source (payer).
  segments.push(join(["HL", "1", "", "20", "1"]));
  segments.push(
    join([
      "NM1",
      "PR",
      "2",
      pad(sanitizeElement(input.payer.organizationName), 60),
      "",
      "",
      "",
      "",
      "PI",
      sanitizeElement(input.payer.payerId),
    ]),
  );

  // 2000B — information receiver (us, the submitter).
  segments.push(join(["HL", "2", "1", "21", "1"]));
  segments.push(
    join([
      "NM1",
      "41",
      "2",
      pad(sanitizeElement(input.submitter.organizationName), 60),
      "",
      "",
      "",
      "",
      "46",
      sanitizeElement(input.submitter.etin),
    ]),
  );

  // 2000C — service provider.
  segments.push(join(["HL", "3", "2", "19", "1"]));
  segments.push(
    join([
      "NM1",
      "1P",
      "2",
      pad(sanitizeElement(input.submitter.organizationName), 60),
      "",
      "",
      "",
      "",
      "XX",
      sanitizeElement(input.submitter.npi),
    ]),
  );

  // 2000D — subscriber.
  segments.push(join(["HL", "4", "3", "22", "0"]));
  segments.push(
    join([
      "NM1",
      "IL",
      "1",
      pad(sanitizeElement(input.subscriber.lastName), 60),
      pad(sanitizeElement(input.subscriber.firstName), 35),
      "",
      "",
      "",
      "MI",
      sanitizeElement(input.subscriber.memberId),
    ]),
  );

  // 2200D — claim status tracking.
  segments.push(join(["TRN", "1", traceRef]));
  segments.push(
    join(["REF", "EJ", sanitizeElement(input.claim.claimControlNumber)]),
  );
  if (input.claim.payerClaimControlNumber) {
    segments.push(
      join(["REF", "1K", sanitizeElement(input.claim.payerClaimControlNumber)]),
    );
  }
  segments.push(
    join(["AMT", "T3", centsToMoney(input.claim.totalBilledCents)]),
  );
  const dateFrom = input.claim.serviceDateFrom;
  const dateTo = input.claim.serviceDateTo ?? dateFrom;
  segments.push(
    join([
      "DTP",
      "472",
      "RD8",
      `${toCcyymmdd(dateFrom)}-${toCcyymmdd(dateTo)}`,
    ]),
  );

  // SE counts ST..SE inclusive.
  const stIdx = segments.findIndex((s) => s.startsWith("ST*"));
  const segmentsInTxn = segments.length - stIdx + 1;
  segments.push(join(["SE", String(segmentsInTxn), stCtl]));
  segments.push(join(["GE", "1", gsCtl]));
  segments.push(join(["IEA", "1", isaCtl]));

  return {
    payload: segments.join(""),
    interchangeControlNumber: isaCtl,
    groupControlNumber: gsCtl,
    traceReference: traceRef,
  };
}

function join(elements: readonly string[]): string {
  return `${elements.join(ELEMENT_SEPARATOR)}${SEGMENT_TERMINATOR}`;
}
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
function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value;
}

/**
 * ISA06/ISA08 are fixed-width AN(15) elements: exactly 15 chars,
 * space-padded on the right. The ISA segment is the one segment X12
 * receivers (and our own parse-segments.ts) parse POSITIONALLY — it
 * must be exactly 106 bytes with ISA16 at offset 104 — so an unpadded
 * sender/receiver id shifts every later byte and makes the whole
 * interchange unparseable at strict intake (TA1-level rejection).
 */
function padFixedWidth(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, " ");
}

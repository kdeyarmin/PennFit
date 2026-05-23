// ASC X12 5010 270 (Health Care Eligibility Benefit Inquiry) builder.
//
// Wire shape (slim subset Office Ally accepts):
//   ISA / GS / ST*270*0001*005010X279A1 / BHT
//   2000A HL information source (payer)
//     NM1*PR*2*<payer name>*****PI*<payer id>
//   2000B HL information receiver (us)
//     NM1*1P*2*<our org>*****XX*<NPI>
//   2000C HL subscriber
//     TRN*1*<our trace ref>*<sender id>
//     NM1*IL*1*<last>*<first>****MI*<member id>
//     DMG*D8*<dob ccyymmdd>*<sex>
//     DTP*291*RD8*<from>-<to>
//     EQ*30  (general health benefits) — or service-type-specific code
//   SE / GE / IEA

import { randomBytes } from "node:crypto";

import {
  centsToMoney as _unused, // keep import alignment with 837p
  digitsOnly,
  sanitizeElement,
  toCcyymmdd,
  type ControlNumbers,
  type PostalAddress,
} from "./837p";

const SEGMENT_TERMINATOR = "~";
const ELEMENT_SEPARATOR = "*";
const COMPONENT_SEPARATOR = ":";

void _unused;

export interface Build270Input {
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
    dateOfBirth: string; // YYYY-MM-DD
    gender: "M" | "F" | "U";
    address?: PostalAddress;
  };
  /** X12 STC service type code. `30` = general health benefits;
   *  `12` = DME (durable medical equipment); `B0` = DME rental. */
  serviceTypeCode?: string;
  /** Optional HCPCS scope for the inquiry. */
  hcpcsCode?: string;
  /** Optional date range for the inquiry (YYYY-MM-DD..YYYY-MM-DD).
   *  Defaults to today→today. */
  serviceDateFrom?: string;
  serviceDateTo?: string;
  control: ControlNumbers;
  usageIndicator: "P" | "T";
}

export interface Built270 {
  payload: string;
  interchangeControlNumber: string;
  groupControlNumber: string;
  /** TRN02 — the trace reference. The 271 echoes this back so we can
   *  match the response to the request. */
  traceReference: string;
}

export function build270(input: Build270Input): Built270 {
  const segments: string[] = [];
  const built = new Date(input.control.builtAt);
  const ccyymmdd = `${built.getUTCFullYear()}${twoDigit(built.getUTCMonth() + 1)}${twoDigit(built.getUTCDate())}`;
  const yymmdd = ccyymmdd.slice(2);
  const hhmm = `${twoDigit(built.getUTCHours())}${twoDigit(built.getUTCMinutes())}`;
  const isaCtl = leftPadDigits(input.control.interchangeControlNumber, 9);
  const gsCtl = stripLeadingZeros(input.control.groupControlNumber) || "1";
  const stCtl = leftPadDigits(input.control.transactionSetControlNumber, 4);
  // Trace ref appears in TRN02 and is the only key the 271 parser can
  // use to match an eligibility response back to the originating
  // request. ISA13 alone collides under burst (two requests from the
  // same submitter in the same second share a seconds-bucket — see
  // control-numbers.ts). Append ST02 + 8 random hex chars so two
  // round-trips fired back-to-back can never claim the same trace.
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
      pad(sanitizeElement(input.submitter.etin), 15),
      "ZZ",
      pad(sanitizeElement(input.receiver.interchangeId), 15),
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
      "HS",
      sanitizeElement(input.submitter.etin),
      sanitizeElement(input.receiver.interchangeId),
      ccyymmdd,
      hhmm,
      gsCtl,
      "X",
      "005010X279A1",
    ]),
  );
  segments.push(join(["ST", "270", stCtl, "005010X279A1"]));
  segments.push(
    join(["BHT", "0022", "13", traceRef.slice(0, 30), ccyymmdd, hhmm]),
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

  // 2000B — information receiver (us).
  segments.push(join(["HL", "2", "1", "21", "1"]));
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

  // 2000C — subscriber.
  segments.push(join(["HL", "3", "2", "22", "0"]));
  segments.push(join(["TRN", "1", traceRef, sanitizeElement(input.submitter.etin)]));
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
  segments.push(
    join(["DMG", "D8", toCcyymmdd(input.subscriber.dateOfBirth), input.subscriber.gender]),
  );

  const dateFrom = input.serviceDateFrom ?? isoToday();
  const dateTo = input.serviceDateTo ?? dateFrom;
  segments.push(
    join([
      "DTP",
      "291",
      "RD8",
      `${toCcyymmdd(dateFrom)}-${toCcyymmdd(dateTo)}`,
    ]),
  );
  segments.push(
    join(["EQ", input.serviceTypeCode ?? "30"]),
  );
  if (input.hcpcsCode) {
    // III — health care service composite
    segments.push(
      join([
        "III",
        "HC",
        `${sanitizeElement(input.hcpcsCode)}`,
      ]),
    );
  }

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
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

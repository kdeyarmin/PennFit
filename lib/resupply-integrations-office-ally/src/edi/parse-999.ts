// 999 Implementation Acknowledgment parser.
//
// Office Ally returns a 999 to confirm syntactic acceptance of an
// 837P upload. The shape we care about is:
//
//   ISA ... GS ... ST*999*... AK1*HC*<group control number>
//     AK2*837*<txn control number>
//       (optional IK3 / IK4 / CTX for segment-level errors)
//       (optional AK9 segment summarising the txn)
//   AK9*A|R|P|E*<txn count>*<received count>*<accepted count>
//   SE ... GE ... IEA ...
//
// We surface a simple shape:
//   { accepted, group_control_number, transaction_set_count,
//     errors: [{ segment_id, error_code, error_message }] }
//
// Office Ally's 999 messages put human-readable text in CTX*SITUATIONAL
// segments; we capture both the code (IK304 / IK403) and the CTX text
// so the CSR sees a useful triage line.

import { parseX12, type Segment } from "./parse-segments";

export interface Parsed999 {
  /** AK9 disposition: A=accepted, R=rejected, P=partial, E=errored. */
  disposition: "A" | "R" | "P" | "E" | "unknown";
  groupControlNumber: string | null;
  /** The ST02 control number of the 837 that was acked. */
  transactionSetControlNumber: string | null;
  /** Count of original 837 transactions received (AK902). */
  transactionsReceived: number | null;
  /** Count of transactions accepted (AK903). */
  transactionsAccepted: number | null;
  errors: Parsed999Error[];
}

export interface Parsed999Error {
  /** Loop / segment identifier the error references (IK3 segment id). */
  segmentId: string | null;
  /** Loop identifier when the error is loop-scoped. */
  loopId: string | null;
  /** Error code — IK304 (segment) or IK403 (element). Per X12 the IK4
   *  value overrides IK3 when present, because element-level diagnoses
   *  are more specific than the parent segment-level diagnosis. */
  errorCode: string | null;
  /** Data element reference number from IK402 (e.g. "66" for NM109).
   *  Helps the CSR locate which field is broken; the human meaning is
   *  payer-specific so we don't try to map it here. */
  elementReferenceNumber: string | null;
  /** Free text from a CTX segment that immediately follows. */
  errorText: string | null;
}

export function parse999(input: string): Parsed999 {
  const { segments } = parseX12(input);
  let disposition: Parsed999["disposition"] = "unknown";
  let groupControlNumber: string | null = null;
  let transactionSetControlNumber: string | null = null;
  let transactionsReceived: number | null = null;
  let transactionsAccepted: number | null = null;
  const errors: Parsed999Error[] = [];

  let currentError: Parsed999Error | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.id === "AK1") {
      groupControlNumber = seg.elements[1] ?? null;
    } else if (seg.id === "AK2") {
      transactionSetControlNumber = seg.elements[1] ?? null;
    } else if (seg.id === "IK3") {
      // IK3 fields:
      //   IK301 = segment id code      (elements[0])
      //   IK302 = segment position     (elements[1])
      //   IK303 = loop identifier code (elements[2])
      //   IK304 = segment syntax error code (elements[3])
      currentError = {
        segmentId: seg.elements[0] ?? null,
        loopId: (seg.elements[2] ?? "").trim() || null,
        errorCode: (seg.elements[3] ?? "").trim() || null,
        elementReferenceNumber: null,
        errorText: null,
      };
      errors.push(currentError);
    } else if (seg.id === "IK4" && currentError) {
      // IK4 fields:
      //   IK401 = element position composite (elements[0])
      //   IK402 = data element reference     (elements[1])
      //   IK403 = element syntax error code  (elements[2])
      //   IK404 = the bad data value         (elements[3])
      // We prefer IK403 as the actionable error code; IK402 is stored
      // separately as the data element reference.
      const ik402 = (seg.elements[1] ?? "").trim();
      const ik403 = (seg.elements[2] ?? "").trim();
      if (ik402) currentError.elementReferenceNumber = ik402;
      if (ik403) currentError.errorCode = ik403;
    } else if (seg.id === "CTX" && currentError) {
      currentError.errorText = readableCtx(seg);
    } else if (seg.id === "IK5") {
      // Transaction set response trailer disposition.
      const code = seg.elements[0];
      if (code === "A") disposition = "A";
      else if (code === "R") disposition = "R";
      else if (code === "P") disposition = "P";
      else if (code === "E") disposition = "E";
    } else if (seg.id === "AK9") {
      const code = seg.elements[0];
      // AK9 disposition takes precedence over IK5 because it's the
      // group-level summary; a missing AK9 still leaves us with IK5.
      if (code === "A") disposition = "A";
      else if (code === "R") disposition = "R";
      else if (code === "P") disposition = "P";
      else if (code === "E") disposition = "E";
      transactionsReceived = toInt(seg.elements[2] ?? null);
      transactionsAccepted = toInt(seg.elements[3] ?? null);
    }
  }

  return {
    disposition,
    groupControlNumber,
    transactionSetControlNumber,
    transactionsReceived,
    transactionsAccepted,
    errors,
  };
}

function readableCtx(seg: Segment): string {
  // CTX element 1 is a context-name composite; we just concatenate
  // the elements with `; ` so the CSR sees the full context line.
  return seg.elements
    .map((e) => e?.trim())
    .filter((e): e is string => Boolean(e))
    .join("; ");
}

function toInt(s: string | null): number | null {
  if (s === null || s === undefined) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// @workspace/resupply-integrations-parachute — Parachute Health
// webhook adapter. Unlike the manufacturer-cloud adapters
// (AirView / Care Orchestrator), this package does not pull
// snapshots; it parses + verifies inbound webhook deliveries that
// land via /integrations/inbound/parachute. The matching dispatcher
// lives in artifacts/resupply-api/src/lib/inbound-dispatchers/parachute.ts.

export type { ParachuteConfig } from "./config";
export { isParachuteStubMode, readParachuteConfigOrNull } from "./config";

export type {
  ParachuteDocument,
  ParachuteHcpcsLine,
  ParachuteOrder,
} from "./types";

export type { ParseOutcome, ParseIssue } from "./parse-order";
export { parseParachuteOrder } from "./parse-order";

export type { VerifyOutcome } from "./verify-signature";
export {
  signParachutePayload,
  verifyParachuteSignature,
} from "./verify-signature";

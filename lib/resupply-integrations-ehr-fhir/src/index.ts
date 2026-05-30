// @workspace/resupply-integrations-ehr-fhir — SMART-on-FHIR Backend
// Services adapter for inbound DME orders from EHR partners
// (Athena, Epic, PointClickCare, etc).
//
// Unlike the Parachute adapter (single-vendor HMAC), this package
// is multi-tenant: each EHR partner has a row in ehr_fhir_tenants
// with their JWKS URI + expected JWT claims. Authentication uses
// the SMART-on-FHIR Backend Services profile (asymmetric RSA JWT
// against the partner's JWKS).
//
// The bundle parser projects FHIR ServiceRequest+Patient+...
// into the same ParachuteOrder shape the Phase 1+2 dispatcher
// already consumes, so matchers + classifier + triage queue UI
// all "just work."

export type {
  Jwks,
  VerifiedClaims,
  VerifyFailureReason,
  VerifyJwtInput,
  VerifyJwtOutcome,
} from "./verify-jwt";
export { fetchJwks, verifySmartJwt } from "./verify-jwt";

export type { ParseBundleFailure, ParseBundleOutcome } from "./parse-bundle";
export { parseFhirBundle } from "./parse-bundle";

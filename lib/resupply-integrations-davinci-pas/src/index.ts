// @workspace/resupply-integrations-davinci-pas
//
// FHIR-based prior authorization client per the Da Vinci PAS IG
// v2.2 (CMS-0057-F). Three layers:
//
//   - buildPasBundle()     — pure FHIR Bundle composer.
//   - submitPasBundle()    — HTTP POST to the payer's PAS endpoint.
//   - parseClaimResponse() — extract decision / auth number / denial
//                             reason from the payer's ClaimResponse.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db, vendor SDKs.

export {
  buildPasBundle,
  buildBundleInputSchema,
  type BuildBundleInput,
  type BuiltBundle,
  type FhirBundle,
  type BundleEntry,
} from "./build-bundle";

export {
  submitPasBundle,
  type SubmitPasInput,
  type SubmitPasOutcome,
} from "./client";

export {
  parseClaimResponse,
  type ParsedClaimResponse,
} from "./parse-claim-response";

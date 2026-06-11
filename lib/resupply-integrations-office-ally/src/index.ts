// @workspace/resupply-integrations-office-ally — Office Ally
// clearinghouse adapter for the DME billing workflow.
//
// Public surface:
//   - createOfficeAllyAdapter() returns an adapter that either
//     uploads 837P claim files to Office Ally over SFTP (when the
//     OFFICE_ALLY_* env is set) or writes them to a local file-drop
//     directory (stub mode for dev / DR).
//   - build837P(input) — pure function builder, exported so worker
//     jobs and CLI scripts can pre-generate files.
//   - allocateControlNumbers() — monotonic control-number helper for
//     the API route that persists the office_ally_submissions row.
//   - readOfficeAllyConfigOrNull / isOfficeAllyStubMode — env helpers
//     mirroring the AirView adapter pattern.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db. The API route is the
// one and only persistence layer.

export {
  createOfficeAllyAdapter,
  type AdapterAvailability,
  type CreateAdapterOptions,
  type OfficeAllyAdapter,
  type SubmitClaimsInput,
  type SubmitClaimsResult,
} from "./adapter";

export {
  build837P,
  centsToMoney,
  digitsOnly,
  sanitizeElement,
  toCcyymmdd,
  type BillingProvider,
  type Built837P,
  type ClaimDetail,
  type Claim837PInput,
  type ControlNumbers,
  type OtherSubscriberDetail,
  type PayerDetail,
  type PostalAddress,
  type ProviderRef,
  type ReceiverIdentity,
  type ServiceLine,
  type SubmitterIdentity,
  type SubscriberDetail,
} from "./edi/837p";

export {
  allocateControlNumbers,
  controlNumbersFromValue,
  type AllocateControlNumbersInput,
} from "./edi/control-numbers";

export { parse999, type Parsed999, type Parsed999Error } from "./edi/parse-999";

export {
  parse277CA,
  type Parsed277CA,
  type Parsed277CAClaim,
} from "./edi/parse-277ca";

export {
  parse835,
  type Adjustment,
  type Parsed835,
  type Parsed835Claim,
  type Parsed835ServiceLine,
  type ProviderAdjustment,
} from "./edi/parse-835";

export { build270, type Build270Input, type Built270 } from "./edi/270";

export { parse271, type Parsed271 } from "./edi/parse-271";

export { build276, type Build276Input, type Built276 } from "./edi/276";

export {
  parse277,
  deriveOutcome,
  type Parsed277,
  type Parsed277ClaimStatus,
  type Parsed277Outcome,
} from "./edi/parse-277";

export {
  parseX12,
  parseMoneyToCents,
  splitComposite,
  type ParsedX12,
  type Segment,
} from "./edi/parse-segments";

export {
  isOfficeAllyStubMode,
  readOfficeAllyConfigOrNull,
  readOfficeAllyRealtimeConfigOrNull,
  resolveOutboxDir,
  type OfficeAllyConfig,
  type OfficeAllyRealtimeConfig,
} from "./config";

export {
  createFileTransport,
  type FileTransportConfig,
} from "./transport/file";
export {
  createSftpTransport,
  type SftpTransportConfig,
} from "./transport/sftp";
export {
  createRealtimeEligibilityTransport,
  isX12Response271,
  type FetchLike,
  type RealtimeTransportDeps,
} from "./transport/realtime";
export {
  classifyEdiPayload,
  downloadFile,
  listOutboundFiles,
  type DownloadFailure,
  type DownloadOutcome,
  type DownloadResult,
  type ListFailure,
  type ListOutcome,
  type ListResult,
  type RemoteFile,
} from "./transport/sftp-inbound";
export type {
  EligibilityRealtimeFailure,
  EligibilityRealtimeOutcome,
  EligibilityRealtimeResult,
  EligibilityRealtimeTransport,
  EligibilityRequest,
  SubmissionTransport,
  SubmissionTransportKind,
  UploadFailure,
  UploadOutcome,
  UploadRequest,
  UploadResult,
} from "./transport/types";

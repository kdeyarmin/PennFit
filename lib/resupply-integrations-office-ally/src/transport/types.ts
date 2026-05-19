// Submission transport interface.
//
// Office Ally accepts 837 files via SFTP (sftp10.officeally.com:22),
// inbound directory `inbound/`. The default production transport
// wraps the system `sftp` binary via child_process so we don't add a
// new top-level npm dep for a single-purpose call. Tests + dev use the
// file-drop transport which writes the payload to a local directory.
//
// A custom transport (e.g. ssh2-sftp-client wrapping a connection pool)
// can be plugged in by passing a custom factory to createOfficeAllyAdapter.

export type SubmissionTransportKind = "sftp" | "file" | "noop";

export interface UploadResult {
  ok: true;
  /** The opaque session / file handle the transport surfaces. Persisted for support tickets. */
  sessionId: string | null;
  /** The remote path the file landed on (server-side or local). Informational only. */
  remotePath: string;
}

export interface UploadFailure {
  ok: false;
  kind:
    | "auth_failed"
    | "connect_failed"
    | "transfer_failed"
    | "unavailable";
  /** Caller-safe failure message. Never includes credentials. */
  message: string;
}

export type UploadOutcome = UploadResult | UploadFailure;

export interface UploadRequest {
  /** Caller-chosen file name. Office Ally rejects file names with spaces or non-ASCII. */
  fileName: string;
  /** UTF-8 EDI payload. */
  payload: string;
}

export interface SubmissionTransport {
  readonly kind: SubmissionTransportKind;
  upload(req: UploadRequest): Promise<UploadOutcome>;
}

// Office Ally adapter — high-level orchestration:
//
//   1. Build an 837P payload from caller-supplied claim input.
//   2. Choose the right transport (SFTP when configured, file-drop
//      otherwise).
//   3. Upload.
//   4. Return a normalised SubmissionResult the API layer can persist
//      to resupply.office_ally_submissions.
//
// This module does NOT touch the database; the API route layer reads
// the claim/coverage/patient rows, calls submitClaims(), then writes
// the resulting office_ally_submissions row. That keeps the integration
// package free of `@workspace/resupply-db` so the same code can be
// exercised in CLI scripts and unit tests.

import { build837P, type Claim837PInput } from "./edi/837p";
import {
  isOfficeAllyStubMode,
  readOfficeAllyConfigOrNull,
  resolveOutboxDir,
  type OfficeAllyConfig,
} from "./config";
import { createFileTransport } from "./transport/file";
import { createSftpTransport } from "./transport/sftp";
import type {
  SubmissionTransport,
  UploadOutcome,
} from "./transport/types";

export type AdapterAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "stub_mode" };

export interface OfficeAllyAdapter {
  availability(): AdapterAvailability;
  /** Build the 837P payload + upload via the active transport. */
  submitClaims(input: SubmitClaimsInput): Promise<SubmitClaimsResult>;
}

export interface SubmitClaimsInput {
  /** Already-allocated control numbers — caller persists these BEFORE upload. */
  control: Claim837PInput["control"];
  /** Per-claim payload. */
  claims: Claim837PInput["claims"];
  /** Caller-chosen file name. Office Ally restricts to A-Z0-9._- */
  fileName: string;
  /** Override the usage indicator for this specific submission (T for tests). */
  usageIndicatorOverride?: "P" | "T";
}

export interface SubmitClaimsResult {
  /** The 837P bytes we sent (or would have sent in stub mode). */
  payload: string;
  fileSizeBytes: number;
  claimCount: number;
  interchangeControlNumber: string;
  groupControlNumber: string;
  /** Which transport ran. */
  transport: SubmissionTransport["kind"];
  /** Upload result. `ok=false` shapes are caller-actionable. */
  upload: UploadOutcome;
}

export interface CreateAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /** Inject a custom transport (e.g. a tests-only in-memory transport). */
  transportFactory?: (config: OfficeAllyConfig | null) => SubmissionTransport;
}

export function createOfficeAllyAdapter(
  opts: CreateAdapterOptions = {},
): OfficeAllyAdapter {
  const env = opts.env ?? process.env;
  const config = readOfficeAllyConfigOrNull(env);
  const stubMode = config === null;
  const stubReason: "no_credentials" | "stub_mode" = isOfficeAllyStubMode(env)
    ? "stub_mode"
    : "no_credentials";

  const transport = opts.transportFactory
    ? opts.transportFactory(config)
    : config
      ? createSftpTransport(config.sftp)
      : createFileTransport({ outboxDir: resolveOutboxDir(env) });

  return {
    availability() {
      if (stubMode) return { status: "stub", reason: stubReason };
      return { status: "configured" };
    },
    async submitClaims(input: SubmitClaimsInput): Promise<SubmitClaimsResult> {
      const built = build837P({
        submitter: stubSubmitter(config),
        receiver: { interchangeId: "OFFCLY", organizationName: "OFFICE ALLY" },
        billingProvider: stubBillingProvider(config),
        claims: input.claims,
        control: input.control,
        usageIndicator:
          input.usageIndicatorOverride ?? config?.usageIndicator ?? "T",
      });

      const upload = await transport.upload({
        fileName: input.fileName,
        payload: built.payload,
      });

      return {
        payload: built.payload,
        fileSizeBytes: Buffer.byteLength(built.payload, "utf8"),
        claimCount: built.claimCount,
        interchangeControlNumber: built.interchangeControlNumber,
        groupControlNumber: built.groupControlNumber,
        transport: transport.kind,
        upload,
      };
    },
  };
}

// Stub identity used when no env config is present. Visible only when
// the file-drop transport is active, so a developer reviewing the
// `outputs/office-ally/*.txt` file can immediately tell it's a stub.
function stubSubmitter(
  config: OfficeAllyConfig | null,
): Claim837PInput["submitter"] {
  if (config) return config.submitter;
  return {
    etin: "STUBETIN",
    organizationName: "STUB SUBMITTER (NO CREDS)",
    contactName: "STUB",
    contactPhoneE164: "+10000000000",
  };
}

function stubBillingProvider(
  config: OfficeAllyConfig | null,
): Claim837PInput["billingProvider"] {
  if (config) return config.billingProvider;
  return {
    organizationName: "STUB BILLING PROVIDER",
    npi: "0000000000",
    taxId: "000000000",
    address: {
      line1: "STUB",
      city: "STUB",
      state: "PA",
      zip: "00000",
    },
  };
}

// File-drop submission transport — writes the 837P payload to a
// local directory instead of uploading. Used in:
//
//   * stub mode (OFFICE_ALLY_STUB=1 or no credentials), so a dev
//     environment can exercise the full submit flow without a real
//     SFTP target,
//   * unit tests of the API layer,
//   * disaster-recovery: if Office Ally is down, ops can flip the
//     env var and we keep building well-formed claim files for
//     manual re-upload later.
//
// The path is configurable via OFFICE_ALLY_FILE_OUTBOX_DIR; defaults
// to <cwd>/outputs/office-ally/. The transport creates the directory
// on demand.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  SubmissionTransport,
  UploadOutcome,
  UploadRequest,
} from "./types";

export interface FileTransportConfig {
  /** Absolute path to the outbox directory. */
  outboxDir: string;
}

export function createFileTransport(
  config: FileTransportConfig,
): SubmissionTransport {
  return {
    kind: "file",
    async upload(req: UploadRequest): Promise<UploadOutcome> {
      try {
        const dir = resolve(config.outboxDir);
        await mkdir(dir, { recursive: true });
        const target = resolve(dir, sanitizeFileName(req.fileName));
        await writeFile(target, req.payload, { encoding: "utf8" });
        return { ok: true, sessionId: null, remotePath: target };
      } catch (err) {
        return {
          ok: false,
          kind: "transfer_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

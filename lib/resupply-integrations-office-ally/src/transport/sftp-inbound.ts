// SFTP inbound listing + download for the 999 / 277CA / 835
// round-trip pull. Mirrors transport/sftp.ts in posture: shells
// out to the system `sftp` binary so we don't add an ssh2 dep just
// for inbound polling, uses the same key + known-hosts pins, and
// returns structured results the worker can persist.
//
// Listing approach:
//   sftp's `ls -1 <dir>` returns bare file names. We invoke it via
//   a batch file (same -b pattern as the upload transport), capture
//   stdout, and parse line-by-line.
//
// Download approach:
//   sftp's `get <remote> <local>` retrieves the file. We then read
//   it into memory and delete the local copy in the `finally` block
//   so PHI doesn't linger on disk between runs.
//
// PHI / safety posture:
//   - File contents are never logged.
//   - We accept files whose names match the OA conventions (.txt for
//     837/999/277, .835 for ERA) and skip anything else.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SftpTransportConfig } from "./sftp";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RemoteFile {
  /** Full remote path the file lives at. */
  remotePath: string;
  /** Just the base name. */
  fileName: string;
}

export interface ListResult {
  ok: true;
  files: RemoteFile[];
}

export interface ListFailure {
  ok: false;
  kind: "auth_failed" | "connect_failed" | "list_failed" | "unavailable";
  message: string;
}

export type ListOutcome = ListResult | ListFailure;

export interface DownloadResult {
  ok: true;
  /** UTF-8 file content. EDI files are pure ASCII so this is safe. */
  content: string;
  fileSizeBytes: number;
}

export interface DownloadFailure {
  ok: false;
  kind:
    | "auth_failed"
    | "connect_failed"
    | "download_failed"
    | "unavailable";
  message: string;
}

export type DownloadOutcome = DownloadResult | DownloadFailure;

/**
 * List files in the clearinghouse's outbound directory. Returns
 * structured results; never throws.
 */
export async function listOutboundFiles(
  config: SftpTransportConfig,
  outboundDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<ListOutcome> {
  const tmpDir = join(tmpdir(), "pf-oa-list");
  const batchPath = join(tmpDir, `list-${Date.now()}.batch`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const batch = [`ls -1 ${quoteSftpArg(outboundDir)}`, "exit", ""].join("\n");
    await writeFile(batchPath, batch, { encoding: "utf8" });

    const args = [
      "-b",
      batchPath,
      "-i",
      config.privateKeyPath,
      "-o",
      `UserKnownHostsFile=${config.knownHostsPath}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "-P",
      String(config.port),
      `${config.username}@${config.host}`,
    ];

    const { stdout } = await execFileAsync("sftp", args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });

    const files: RemoteFile[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      // Skip empty lines, sftp prompts, and the batch-mode echoes
      // that begin with "sftp>".
      if (!line || line.startsWith("sftp>") || line.startsWith("Connected")) {
        continue;
      }
      // Skip directories — bare `ls -1` may include "." / ".." on
      // some servers. We also skip anything with a slash.
      if (line === "." || line === "..") continue;
      if (line.includes("/")) continue;
      files.push({
        fileName: line,
        remotePath: `${outboundDir.replace(/\/$/, "")}/${line}`,
      });
    }
    return { ok: true, files };
  } catch (err) {
    return classifyListError(err);
  } finally {
    await rm(batchPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Download a single file from the clearinghouse's outbound directory.
 * Returns the file contents as a UTF-8 string; never throws.
 */
export async function downloadFile(
  config: SftpTransportConfig,
  remotePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<DownloadOutcome> {
  const tmpDir = join(tmpdir(), "pf-oa-download");
  const safeName = remotePath.replace(/[^A-Za-z0-9._-]/g, "_");
  const localPath = join(tmpDir, `${safeName}-${Date.now()}`);
  const batchPath = join(tmpDir, `get-${Date.now()}.batch`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const batch = [
      `get ${quoteSftpArg(remotePath)} ${quoteSftpArg(localPath)}`,
      "exit",
      "",
    ].join("\n");
    await writeFile(batchPath, batch, { encoding: "utf8" });
    const args = [
      "-b",
      batchPath,
      "-i",
      config.privateKeyPath,
      "-o",
      `UserKnownHostsFile=${config.knownHostsPath}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "-P",
      String(config.port),
      `${config.username}@${config.host}`,
    ];
    await execFileAsync("sftp", args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const content = await readFile(localPath, { encoding: "utf8" });
    return {
      ok: true,
      content,
      fileSizeBytes: Buffer.byteLength(content, "utf8"),
    };
  } catch (err) {
    return classifyDownloadError(err);
  } finally {
    await rm(localPath, { force: true }).catch(() => undefined);
    await rm(batchPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Classify the contents of an EDI file by sniffing the ST segment.
 * Works on full payloads and on the first ~1KB. Returns "unknown" if
 * the payload doesn't look like X12 5010.
 */
export function classifyEdiPayload(
  content: string,
): "999" | "277ca" | "835" | "unknown" {
  // Sniff in the first 4KB. The ISA segment is 106 chars; the ST
  // segment usually lands within the first 500 bytes for our sizes.
  const head = content.slice(0, 4096);
  if (!head.startsWith("ISA")) return "unknown";
  if (/~ST\*999\*/.test(head)) return "999";
  if (/~ST\*277\*/.test(head)) return "277ca";
  if (/~ST\*835\*/.test(head)) return "835";
  return "unknown";
}

// ── error classification (shared shape with sftp.ts) ────────────────

function quoteSftpArg(arg: string): string {
  return `"${arg.replace(/"/g, "")}"`;
}

interface NodeExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stderr?: string | Buffer;
}

function classifyListError(err: unknown): ListOutcome {
  const k = classify(err);
  if (k.kind === "transfer_failed") {
    return { ok: false, kind: "list_failed", message: k.message };
  }
  return { ok: false, kind: k.kind as ListFailure["kind"], message: k.message };
}

function classifyDownloadError(err: unknown): DownloadOutcome {
  const k = classify(err);
  if (k.kind === "transfer_failed") {
    return {
      ok: false,
      kind: "download_failed",
      message: k.message,
    };
  }
  return {
    ok: false,
    kind: k.kind as DownloadFailure["kind"],
    message: k.message,
  };
}

function classify(err: unknown): { kind: string; message: string } {
  const e = err as NodeExecError;
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : e?.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : "";
  if (e?.killed && e?.signal) {
    return { kind: "unavailable", message: `sftp killed by signal ${e.signal}` };
  }
  if (e?.code === "ENOENT") {
    return { kind: "unavailable", message: "sftp binary not found on PATH" };
  }
  if (/Permission denied|Authentication failed/i.test(stderr)) {
    return { kind: "auth_failed", message: "sftp authentication failed" };
  }
  if (/Connection refused|No route to host|Connection timed out/i.test(stderr)) {
    return { kind: "connect_failed", message: "sftp connect failed" };
  }
  return {
    kind: "transfer_failed",
    message: `sftp transfer failed (exit ${typeof e?.code === "number" ? e.code : "unknown"})`,
  };
}

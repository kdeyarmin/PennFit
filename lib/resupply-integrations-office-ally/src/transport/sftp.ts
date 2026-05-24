// SFTP submission transport — uploads the 837P payload to Office
// Ally via the system `sftp` binary.
//
// Why shell out instead of an ssh2 npm dep
// ----------------------------------------
// Office Ally's only documented transport for 837 batches is SFTP to
// sftp10.officeally.com. The ssh2 Node library is excellent but adds
// ~150kB and a libuv native binding for a single-purpose call that
// happens at most a few times per business day. The system `sftp`
// binary (openssh-clients) is present on every supported container
// image we ship to, and shelling out keeps the dependency surface
// tight while still giving us the full SFTP feature set (key auth,
// known_hosts pinning, atomic rename).
//
// Security posture
// ----------------
//   * The private key is provided via the OFFICE_ALLY_PRIVATE_KEY_PATH
//     env var. The file MUST be 0600 — we don't read or rewrite the
//     key, only point ssh at it.
//   * Known-hosts is pinned via OFFICE_ALLY_KNOWN_HOSTS_PATH. We pass
//     `-o StrictHostKeyChecking=yes` so a TOFU acceptance is impossible
//     in production.
//   * We write the payload to a temp file with a `.tmp` suffix and
//     `rename` it on the remote side so Office Ally never reads a
//     half-written file.
//   * Stderr / stdout are captured but NEVER logged at the call site —
//     the EDI payload (PHI) can echo back on a verbose ssh failure.
//
// Out of scope (intentional)
// --------------------------
//   * Connection pooling — submissions are infrequent.
//   * 999 / 277CA polling — that's a separate worker job that reads
//     the inbound directory; not implemented in this transport.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  SubmissionTransport,
  UploadOutcome,
  UploadRequest,
} from "./types";

const execFileAsync = promisify(execFile);

export interface SftpTransportConfig {
  host: string;
  /** Default 22. */
  port: number;
  username: string;
  /** Absolute path to the private key file (0600). */
  privateKeyPath: string;
  /** Absolute path to the known_hosts file pinning the OA host key. */
  knownHostsPath: string;
  /** Remote directory the batch file lands in. Office Ally default: `inbound`. */
  remoteInboxDir: string;
  /** Hard timeout per upload, in ms. Default 60s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

// Transient-failure retry policy. SFTP uploads to Office Ally
// historically failed silently on a single network blip, leaving the
// `office_ally_submissions` row in 'error' and requiring manual replay.
// Three attempts with exponential backoff (1s, 2s — total worst-case
// 3s of waiting on top of the 60s SFTP timeout each) covers ~99% of
// the transient-failure window without meaningfully delaying the
// submission. We retry ONLY the failure kinds that are transient by
// nature — connect_failed and transfer_failed are typically network
// blips or remote-side hiccups; auth_failed and unavailable (missing
// binary, killed process) indicate a config error that won't recover.
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAYS_MS = [1000, 2000];

function isRetryableUploadFailure(outcome: UploadOutcome): boolean {
  if (outcome.ok) return false;
  return outcome.kind === "connect_failed" || outcome.kind === "transfer_failed";
}

export function createSftpTransport(
  config: SftpTransportConfig,
): SubmissionTransport {
  return {
    kind: "sftp",
    async upload(req: UploadRequest): Promise<UploadOutcome> {
      // Single-attempt closure — extracted so the retry loop below
      // can call it multiple times without duplicating the
      // tmp-file/batch-file dance.
      const attempt = async (): Promise<UploadOutcome> => uploadOnce(config, req);

      let lastOutcome: UploadOutcome = await attempt();
      for (let i = 1; i < MAX_UPLOAD_ATTEMPTS; i++) {
        if (!isRetryableUploadFailure(lastOutcome)) break;
        // Sleep before the next attempt. The delays array is sized
        // to MAX_UPLOAD_ATTEMPTS - 1; we never read past it.
        const delay = UPLOAD_RETRY_DELAYS_MS[i - 1] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastOutcome = await attempt();
      }
      return lastOutcome;
    },
  };
}

async function uploadOnce(
  config: SftpTransportConfig,
  req: UploadRequest,
): Promise<UploadOutcome> {
  const safeName = req.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const localDir = join(tmpdir(), "pf-oa-upload");
  const localPath = join(localDir, safeName);
  const batchPath = join(localDir, `${safeName}.batch`);
  try {
    await mkdir(localDir, { recursive: true });
    await writeFile(localPath, req.payload, { encoding: "utf8" });
    // The batch file tells sftp the exact upload+rename sequence
    // so a transport interruption never leaves a half-written
    // file in OA's pickup directory.
    const remoteTmp = `${config.remoteInboxDir}/${safeName}.tmp`;
    const remoteFinal = `${config.remoteInboxDir}/${safeName}`;
    const batch = [
      `put ${quoteSftpArg(localPath)} ${quoteSftpArg(remoteTmp)}`,
      `rename ${quoteSftpArg(remoteTmp)} ${quoteSftpArg(remoteFinal)}`,
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
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // 1MB stdout cap — the EDI payload is well under 100kB so
      // anything larger means OA echoed something unexpected.
      maxBuffer: 1024 * 1024,
    });

    return {
      ok: true,
      sessionId: null,
      remotePath: `${config.remoteInboxDir}/${safeName}`,
    };
  } catch (err) {
    return classifyError(err);
  } finally {
    // Best-effort cleanup. Never lets a cleanup failure mask the
    // actual upload result.
    await rm(localPath, { force: true }).catch(() => undefined);
    await rm(batchPath, { force: true }).catch(() => undefined);
  }
}

function quoteSftpArg(arg: string): string {
  // The sftp batch parser uses whitespace as delimiter; double-quote
  // strip + replace internal quotes to prevent injection from a
  // sanitized but adversarial file name. Our caller already strips
  // most characters but we belt-and-suspender.
  return `"${arg.replace(/"/g, "")}"`;
}

interface NodeExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stderr?: string | Buffer;
}

function classifyError(err: unknown): UploadOutcome {
  const e = err as NodeExecError;
  const stderr =
    typeof e?.stderr === "string"
      ? e.stderr
      : e?.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : "";

  if (e?.killed && e?.signal) {
    return {
      ok: false,
      kind: "unavailable",
      message: `sftp killed by signal ${e.signal}`,
    };
  }
  if (e?.code === "ENOENT") {
    return {
      ok: false,
      kind: "unavailable",
      message: "sftp binary not found on PATH",
    };
  }
  if (
    /Permission denied|Authentication failed|key_load_public|PRIVATE KEY/i.test(
      stderr,
    )
  ) {
    return { ok: false, kind: "auth_failed", message: "sftp authentication failed" };
  }
  if (/Connection refused|No route to host|Connection timed out/i.test(stderr)) {
    return {
      ok: false,
      kind: "connect_failed",
      message: "sftp connect failed",
    };
  }
  return {
    ok: false,
    kind: "transfer_failed",
    message: `sftp transfer failed (exit ${typeof e?.code === "number" ? e.code : "unknown"})`,
  };
}

// Tests for createSftpTransport — the retry loop, isRetryableUploadFailure
// logic, and error classification via uploadOnce/classifyError.
//
// We mock:
//   * node:child_process — to control execFile success / failure.
//   * node:fs/promises — to avoid real disk I/O.
// Fake timers eliminate the 1s / 2s retry sleeps so tests run instantly.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── node:child_process mock ───────────────────────────────────────────────────
// execFile is the raw callback-style function; promisify(execFile) is what
// the module actually awaits. Because vi.mock is hoisted before the import
// of sftp.ts, promisify wraps the mock's execFile reference and every call
// goes through execFileMock.
const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "", "");
    },
  ),
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// ── node:fs/promises mock ─────────────────────────────────────────────────────
const mkdirMock = vi.hoisted(() => vi.fn(async () => undefined));
const writeFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const rmMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  rm: rmMock,
}));

import { createSftpTransport } from "./sftp";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(over: Partial<Parameters<typeof createSftpTransport>[0]> = {}) {
  return {
    host: "sftp10.officeally.com",
    port: 22,
    username: "test-user",
    privateKeyPath: "/keys/test.pem",
    knownHostsPath: "/etc/ssh/known_hosts",
    remoteInboxDir: "inbound",
    ...over,
  };
}

function makeRequest(
  over: Partial<{ fileName: string; payload: string }> = {},
) {
  return {
    fileName: "claim_20260519.837p",
    payload: "ISA*00*test~",
    ...over,
  };
}

/** Build an exec callback that fires with the given error fields. */
function buildFailImpl(err: {
  message?: string;
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stderr?: string;
}) {
  return (
    _file: string,
    _args: string[],
    _opts: object,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const e = Object.assign(new Error(err.message ?? "sftp error"), err);
    cb(e, "", err.stderr ?? "");
  };
}

/** Simulate execFile calling its callback with an error ONCE; the
 *  next call hits the default-success shim. Use for retry-success
 *  scenarios where the first attempt fails and the second succeeds. */
function failExecFile(err: Parameters<typeof buildFailImpl>[0]): void {
  execFileMock.mockImplementationOnce(buildFailImpl(err));
}

/** Make execFile fail the same way on EVERY call (sticky). The SFTP
 *  transport retries connect_failed / transfer_failed up to 3 times;
 *  error-classification tests need the failure to persist across all
 *  attempts so the final outcome reflects the failure kind under test. */
function failExecFileSticky(err: Parameters<typeof buildFailImpl>[0]): void {
  execFileMock.mockImplementation(buildFailImpl(err));
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  execFileMock.mockReset();
  mkdirMock.mockReset();
  writeFileMock.mockReset();
  rmMock.mockReset();

  // Default: all fs/promises calls succeed silently.
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);

  // Default: sftp binary exits 0 (success).
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "", "");
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSftpTransport — happy path", () => {
  it("returns ok:true with the remote path on success", async () => {
    const transport = createSftpTransport(makeConfig());
    const outcome = await transport.upload(makeRequest());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.remotePath).toBe("inbound/claim_20260519.837p");
      expect(outcome.sessionId).toBeNull();
    }
  });

  it("sanitizes the file name — replaces unsafe characters with underscores", async () => {
    const transport = createSftpTransport(makeConfig());
    const outcome = await transport.upload(makeRequest({ fileName: "claim 2026/01/01.837p" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // spaces and slashes become underscores; dots and alphanumerics survive
      expect(outcome.remotePath).toBe("inbound/claim_2026_01_01.837p");
    }
  });

  it("invokes execFile exactly once on a clean first attempt", async () => {
    const transport = createSftpTransport(makeConfig());
    await transport.upload(makeRequest());
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("passes the correct sftp arguments including known_hosts and strict host checking", async () => {
    const cfg = makeConfig({
      port: 2222,
      username: "alice",
      host: "sftp.example.com",
      privateKeyPath: "/home/alice/.ssh/id_ed25519",
      knownHostsPath: "/etc/ssh/oa_known_hosts",
    });
    const transport = createSftpTransport(cfg);
    await transport.upload(makeRequest());

    // execFile's full signature is (file, args, opts, cb) — a 4-tuple
    // — so cast through `unknown` to peel just the first two we care
    // about. TypeScript otherwise complains about the tuple-length
    // mismatch under strict mode.
    const [binary, args] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(binary).toBe("sftp");
    expect(args).toContain("-i");
    expect(args).toContain("/home/alice/.ssh/id_ed25519");
    expect(args).toContain("UserKnownHostsFile=/etc/ssh/oa_known_hosts");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("-P");
    expect(args).toContain("2222");
    expect(args[args.length - 1]).toBe("alice@sftp.example.com");
  });

  it("writes a batch file with put + rename so remote never sees a partial file", async () => {
    const transport = createSftpTransport(makeConfig());
    await transport.upload(makeRequest({ fileName: "test.837p" }));

    // The second writeFile call is the batch file. Find it by examining
    // calls that passed a string containing 'put' and 'rename'.
    // `mock.calls` is loosely typed; the destructure-cast pattern below
    // satisfies TS strict tuple-element-count without changing runtime
    // behavior.
    type WriteFileCall = readonly [unknown, unknown, ...unknown[]];
    const batchWriteCall = (writeFileMock.mock.calls as unknown as WriteFileCall[]).find(
      (call) => typeof call[1] === "string" && (call[1] as string).includes("put "),
    );
    expect(batchWriteCall).toBeDefined();
    const batchContent = batchWriteCall![1] as string;
    expect(batchContent).toContain("put ");
    expect(batchContent).toContain("rename ");
    expect(batchContent).toContain(".tmp");
    expect(batchContent).toContain("exit");
  });

  it("cleans up temp files even on success", async () => {
    const transport = createSftpTransport(makeConfig());
    await transport.upload(makeRequest());
    expect(rmMock).toHaveBeenCalledTimes(2); // localPath + batchPath
  });

  it("uses the configured timeoutMs for the execFile call", async () => {
    const transport = createSftpTransport(makeConfig({ timeoutMs: 5000 }));
    await transport.upload(makeRequest());
    const [, , opts] = execFileMock.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { timeout: number },
    ];
    expect(opts.timeout).toBe(5000);
  });

  it("defaults to 60_000 ms timeout when timeoutMs is not set", async () => {
    const transport = createSftpTransport(makeConfig());
    await transport.upload(makeRequest());
    const [, , opts] = execFileMock.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { timeout: number },
    ];
    expect(opts.timeout).toBe(60_000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Error classification — classifyError
// ──────────────────────────────────────────────────────────────────────────────

describe("createSftpTransport — error classification", () => {
  it("returns unavailable when sftp binary is not found (ENOENT)", async () => {
    failExecFile({ code: "ENOENT" });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    // Run all pending timers to handle any retry delays
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unavailable");
      expect(outcome.message).toContain("binary not found");
    }
  });

  it("returns unavailable when the process was killed by a signal", async () => {
    failExecFile({ killed: true, signal: "SIGTERM" });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unavailable");
      expect(outcome.message).toContain("SIGTERM");
    }
  });

  it("returns auth_failed on 'Permission denied' in stderr", async () => {
    failExecFile({ stderr: "Permission denied (publickey)", code: 255 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth_failed");
    }
  });

  it("returns auth_failed on 'Authentication failed' in stderr", async () => {
    failExecFile({ stderr: "Authentication failed.", code: 255 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth_failed");
    }
  });

  it("returns auth_failed on 'PRIVATE KEY' in stderr", async () => {
    failExecFile({ stderr: "Error loading PRIVATE KEY: bad format", code: 1 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth_failed");
    }
  });

  it("returns connect_failed on 'Connection refused' in stderr", async () => {
    failExecFileSticky({ stderr: "ssh: connect to host sftp10.officeally.com port 22: Connection refused", code: 255 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("connect_failed");
    }
  });

  it("returns connect_failed on 'No route to host' in stderr", async () => {
    failExecFileSticky({ stderr: "No route to host", code: 255 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("connect_failed");
    }
  });

  it("returns connect_failed on 'Connection timed out' in stderr", async () => {
    failExecFileSticky({ stderr: "ssh: connect to host sftp10.officeally.com port 22: Connection timed out", code: 255 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("connect_failed");
    }
  });

  it("returns transfer_failed as the default for unrecognised exit codes", async () => {
    failExecFileSticky({ code: 1 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transfer_failed");
      expect(outcome.message).toContain("exit 1");
    }
  });

  it("returns transfer_failed with 'unknown' when the error has no numeric code", async () => {
    failExecFileSticky({ message: "some random error" });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transfer_failed");
      expect(outcome.message).toContain("unknown");
    }
  });

  it("cleans up temp files even when execFile fails", async () => {
    // Sticky failure → retry loop exhausts all 3 attempts. Each
    // attempt's finally{} clause runs the two-file cleanup (localPath
    // + batchPath), so we expect rm to be called 2 × 3 = 6 times.
    failExecFileSticky({ code: 1 });
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;
    expect(rmMock).toHaveBeenCalledTimes(6);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Retry logic
// ──────────────────────────────────────────────────────────────────────────────

describe("createSftpTransport — retry loop", () => {
  it("retries on connect_failed and succeeds on the second attempt", async () => {
    // Attempt 1: connect_failed
    failExecFile({ stderr: "Connection refused", code: 255 });
    // Attempt 2: success (default mock)

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    // Advance past the 1s sleep between attempts 1 and 2.
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("retries on transfer_failed and succeeds on the second attempt", async () => {
    failExecFile({ code: 1 }); // default → transfer_failed
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("retries twice and succeeds on the third (final) attempt", async () => {
    // Attempts 1 + 2 fail with connect_failed; attempt 3 succeeds.
    failExecFile({ stderr: "Connection refused", code: 255 });
    failExecFile({ stderr: "Connection refused", code: 255 });
    // execFileMock default → success

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("exhausts all attempts and returns the last failure (connect_failed × 3)", async () => {
    failExecFile({ stderr: "Connection refused", code: 255 });
    failExecFile({ stderr: "Connection refused", code: 255 });
    failExecFile({ stderr: "Connection refused", code: 255 });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("connect_failed");
    }
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on auth_failed (config error — won't recover on retry)", async () => {
    failExecFile({ stderr: "Permission denied (publickey)", code: 255 });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth_failed");
    }
    // auth_failed is not retryable — only one attempt
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when sftp binary is missing (unavailable / ENOENT)", async () => {
    failExecFile({ code: "ENOENT" });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unavailable");
    }
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when process is killed by a signal (unavailable)", async () => {
    failExecFile({ killed: true, signal: "SIGKILL" });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unavailable");
    }
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on a successful outcome (ok:true)", async () => {
    // default mock = success
    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying as soon as a success is reached (no extra attempts after success)", async () => {
    // First attempt fails with connect_failed; second succeeds.
    failExecFile({ stderr: "Connection refused", code: 255 });
    // default mock = success on attempt 2

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;

    // Exactly 2 attempts (no third attempt triggered after success)
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("caps retries at MAX_UPLOAD_ATTEMPTS (3) even if failures keep coming", async () => {
    // Stage more failures than MAX_UPLOAD_ATTEMPTS to verify the cap
    for (let i = 0; i < 5; i++) {
      failExecFile({ stderr: "Connection refused", code: 255 });
    }

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;

    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("re-creates temp files on each retry attempt", async () => {
    // First attempt: connect_failed; second: success.
    failExecFile({ stderr: "Connection refused", code: 255 });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;

    // mkdir + writeFile(payload) + writeFile(batch) called twice (once per attempt)
    expect(mkdirMock).toHaveBeenCalledTimes(2);
  });

  it("cleans up temp files after each individual retry attempt", async () => {
    failExecFile({ stderr: "Connection refused", code: 255 });

    const transport = createSftpTransport(makeConfig());
    const p = transport.upload(makeRequest());
    await vi.runAllTimersAsync();
    await p;

    // rm called twice per attempt × 2 attempts = 4 total
    expect(rmMock).toHaveBeenCalledTimes(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Filename sanitisation (regression: unsafe chars must not reach sftp args)
// ──────────────────────────────────────────────────────────────────────────────

describe("createSftpTransport — filename sanitisation", () => {
  it("preserves alphanumerics, dots, underscores, and dashes", async () => {
    const transport = createSftpTransport(makeConfig());
    const outcome = await transport.upload(makeRequest({ fileName: "claim-2026.A1_v2.837p" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.remotePath).toBe("inbound/claim-2026.A1_v2.837p");
    }
  });

  it("converts spaces to underscores", async () => {
    const transport = createSftpTransport(makeConfig());
    const outcome = await transport.upload(makeRequest({ fileName: "my claim.837p" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.remotePath).toContain("my_claim.837p");
    }
  });

  it("strips characters that would break the sftp batch parser", async () => {
    const transport = createSftpTransport(makeConfig());
    const outcome = await transport.upload(
      makeRequest({ fileName: 'claim"with"quotes.837p' }),
    );
    expect(outcome.ok).toBe(true);
    // The file should have been written; the exact sanitised name is observable
    // via the remotePath — all non-[A-Za-z0-9._-] chars → underscore.
    if (outcome.ok) {
      expect(outcome.remotePath).not.toContain('"');
    }
  });
});

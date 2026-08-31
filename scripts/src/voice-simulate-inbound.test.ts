// The simulated-inbound-call tool's refusals.
//
// This tool posts a signed webhook that creates a real conversation for a
// real tenant and can dispatch a real message. Everything worth testing
// here is what it REFUSES to do — and the refusals have to be tested by
// spawning it, because the script self-executes and its guards run before
// any exported function could be reached.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "voice-simulate-inbound.ts");
const PACKAGE_DIR = resolve(HERE, "..");

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...args],
    {
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("production refusals", () => {
  it.each([
    "https://cmbreathe.com",
    "https://www.cmbreathe.com",
    "https://pennpaps.com",
    "https://pennfit.up.railway.app",
  ])("refuses %s outright", (baseUrl) => {
    const { code, stderr } = run([
      `--base-url=${baseUrl}`,
      "--to=+15550001111",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("production host");
  });

  it("refuses a production host EVEN WITH the override flag", () => {
    // There is no flag that makes this acceptable — the tool creates a
    // real conversation for a real tenant.
    const { code, stderr } = run([
      "--base-url=https://cmbreathe.com",
      "--to=+15550001111",
      "--i-know-this-is-not-prod",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("production host");
  });

  it("refuses when DEPLOY_ENV says production, whatever the URL", () => {
    const { code, stderr } = run(
      ["--base-url=http://localhost:3000", "--to=+15550001111"],
      { DEPLOY_ENV: "production", TWILIO_AUTH_TOKEN: "t" },
    );
    expect(code).toBe(2);
    expect(stderr).toContain("DEPLOY_ENV=production");
  });

  it("refuses a non-local host unless the operator says so", () => {
    const { code, stderr } = run([
      "--base-url=https://staging.example.invalid",
      "--to=+15550001111",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("not a local address");
  });

  it("refuses a base URL that is not a URL", () => {
    const { code } = run(["--base-url=not a url", "--to=+15550001111"]);
    expect(code).toBe(2);
  });
});

describe("required inputs", () => {
  it("prints usage and exits 2 with no arguments", () => {
    const { code, stderr } = run([]);
    expect(code).toBe(2);
    expect(stderr).toContain("Usage:");
  });

  it("refuses to send without an auth token", () => {
    // An unsigned request proves nothing except that the verifier
    // rejects it, which is not what anyone is running this to learn.
    const { code, stderr } = run([
      "--base-url=http://localhost:3000",
      "--to=+15550001111",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("TWILIO_AUTH_TOKEN");
  });
});

// Static source-level guard for the explicit HOST = "::" binding added to
// index.ts as part of the R3 fix (docs/railway-hosting-review-2026-05-29.md).
//
// index.ts is the process entry point and relies on live network binds,
// DB connections, and environment variables — importing it in a unit-test
// environment would require mocking virtually everything. The static approach
// used for app.ts tests is the right fit: it pins the structural invariants
// the PR must preserve without spinning up a server.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = readFileSync(path.join(__dirname, "index.ts"), "utf8");

/** Strip line and block comments so text searches aren't confused by
 * documentation references to the same identifier. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(INDEX_SOURCE);

describe('index.ts — explicit "::" host binding (R3)', () => {
  it('declares HOST as the string literal "::"', () => {
    // A const avoids repeating the magic string and makes the intent
    // searchable in code review and error logs.
    expect(CODE).toMatch(/const HOST\s*=\s*"::"/);
  });

  it("passes HOST as the second argument to httpServer.listen (not a bare port call)", () => {
    // Previously `httpServer.listen(port, callback)` omitted the host;
    // the fix adds HOST as the explicit second argument.
    expect(CODE).toMatch(/httpServer\.listen\s*\(\s*port\s*,\s*HOST/);
  });

  it("does NOT use httpServer.listen with only port and a callback (old form)", () => {
    // The old two-argument form `listen(port, callback)` must no longer exist.
    // Valid: listen(port, HOST, callback). Invalid: listen(port, () => ...).
    // We check the call site doesn't have listen(port followed immediately by a
    // function expression without HOST in between.
    expect(CODE).not.toMatch(/httpServer\.listen\s*\(\s*port\s*,\s*\(/);
  });

  it("includes host: HOST in the structured log at server startup", () => {
    // The startup log object must carry `host` so operators can confirm
    // the bind address in production logs without reading source code.
    expect(CODE).toContain("host: HOST");
  });

  it('"resupply-api listening" log appears AFTER the listen call, confirming the server is up', () => {
    const listenIdx = CODE.indexOf("httpServer.listen");
    const listeningMsgIdx = CODE.indexOf("resupply-api listening");
    expect(listenIdx).toBeGreaterThan(-1);
    expect(listeningMsgIdx).toBeGreaterThan(-1);
    expect(listeningMsgIdx).toBeGreaterThan(listenIdx);
  });

  it("HOST is declared in the start() function scope, not at module level", () => {
    // HOST is a local implementation detail of start(); exposing it at
    // module level would be unnecessary.
    const startFnIdx = CODE.indexOf("async function start()");
    const hostIdx = CODE.indexOf('const HOST = "::"');
    expect(startFnIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeGreaterThan(startFnIdx);
  });

  it('HOST constant value is "::" (dual-stack IPv6 unspecified address), not "0.0.0.0" or "localhost"', () => {
    // "::" is the dual-stack unspecified address — a single bind that
    // serves both Railway's IPv4 public network and its IPv6 private network.
    // "0.0.0.0" would miss the IPv6 private network; "localhost" would refuse
    // external connections entirely.
    expect(CODE).not.toMatch(/const HOST\s*=\s*"0\.0\.0\.0"/);
    expect(CODE).not.toMatch(/const HOST\s*=\s*"localhost"/);
    expect(CODE).toMatch(/const HOST\s*=\s*"::"/);
  });

  it("host: HOST log field appears in the same logger.info block as the port field", () => {
    // Both host and port must be in the same structured log object so
    // the bind address and port are always co-located in the log line.
    const portFieldIdx = CODE.indexOf("port,");
    const hostFieldIdx = CODE.indexOf("host: HOST");
    // They must appear close together — within 200 chars (the log object).
    expect(portFieldIdx).toBeGreaterThan(-1);
    expect(hostFieldIdx).toBeGreaterThan(-1);
    expect(Math.abs(hostFieldIdx - portFieldIdx)).toBeLessThan(200);
  });
});
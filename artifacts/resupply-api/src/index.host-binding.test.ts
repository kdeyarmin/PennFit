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

  it("passes a host as the second argument to httpServer.listen (not a bare port call)", () => {
    // Previously `httpServer.listen(port, callback)` omitted the host;
    // the fix adds the host as the explicit second argument. The bind is
    // now routed through a `listenOn(host)` helper so the IPv4 fallback
    // below can reuse it, so assert on the helper's parameter.
    expect(CODE).toMatch(/httpServer\.listen\s*\(\s*port\s*,\s*host\s*\)/);
  });

  it("registers the `listening` handler separately so a failed bind can remove it", () => {
    // `listen(port, host, cb)` attaches cb as a one-shot `listening`
    // listener that a FAILED bind does not clear. Left attached, the
    // failed `::` attempt's callback fires on the successful IPv4 bind
    // and logs a phantom `host: "::"` line. The error path must detach it.
    expect(CODE).toMatch(/httpServer\.once\("listening", onListening\)/);
    expect(CODE).toMatch(/httpServer\.off\("listening", onListening\)/);
  });

  it("attempts the HOST ('::') bind FIRST", () => {
    // The dual-stack address stays the primary bind; the IPv4 fallback
    // must never become the first thing we try.
    expect(CODE).toMatch(/listenOn\(HOST\)/);
    const primaryIdx = CODE.indexOf("listenOn(HOST)");
    const fallbackIdx = CODE.indexOf('listenOn("0.0.0.0")');
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(primaryIdx);
  });

  it("falls back to IPv4 ONLY for IPv6-unavailable bind errors", () => {
    // A host with no IPv6 stack fails `::` with EAFNOSUPPORT /
    // EADDRNOTAVAIL / EINVAL. Those must degrade to 0.0.0.0 rather than
    // exit the process (an IPv6-less kernel must not blackhole the site).
    // Every OTHER bind error (EADDRINUSE, EACCES) is a real
    // misconfiguration and must stay fatal — so the fallback is gated on
    // an explicit code allowlist, never a bare catch-all.
    expect(CODE).toContain("EAFNOSUPPORT");
    expect(CODE).toContain("EADDRNOTAVAIL");
    expect(CODE).toMatch(/IPV6_UNAVAILABLE_CODES\.has\(code\)/);
    expect(CODE).toMatch(
      /if\s*\(code === undefined \|\| !IPV6_UNAVAILABLE_CODES\.has\(code\)\)\s*throw err;/,
    );
  });

  it("does NOT use httpServer.listen with only port and a callback (old form)", () => {
    // The old two-argument form `listen(port, callback)` must no longer exist.
    // Valid: listen(port, HOST, callback). Invalid: listen(port, () => ...).
    // We check the call site doesn't have listen(port followed immediately by a
    // function expression without HOST in between.
    expect(CODE).not.toMatch(/httpServer\.listen\s*\(\s*port\s*,\s*\(/);
  });

  it("includes the bound host in the structured log at server startup", () => {
    // The startup log object must carry `host` so operators can confirm
    // the bind address in production logs without reading source code —
    // and it must log the address actually bound, so an IPv4 fallback is
    // visible rather than being reported as "::".
    expect(CODE).toMatch(/logger\.info\(\s*\{\s*\n?\s*host,/);
  });

  it('"resupply-api listening" is logged from the listening handler, not unconditionally', () => {
    // The invariant is causal, not textual: the line must only be emitted once
    // the socket is actually bound. It now lives inside `onListening`, which is
    // declared ABOVE the `listen()` call and wired to the server's `listening`
    // event — so assert containment rather than source order (the old
    // positional check silently encoded the previous layout).
    const listeningMsgIdx = CODE.indexOf("resupply-api listening");
    const handlerIdx = CODE.indexOf("const onListening = () => {");
    const handlerEndIdx = CODE.indexOf('httpServer.once("error", onError)');
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(listeningMsgIdx).toBeGreaterThan(handlerIdx);
    expect(listeningMsgIdx).toBeLessThan(handlerEndIdx);
    // …and that handler is only ever invoked by the `listening` event.
    expect(CODE).toMatch(/httpServer\.once\("listening", onListening\)/);
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

  it("host log field appears in the same logger.info block as the port field", () => {
    // Both host and port must be in the same structured log object so
    // the bind address and port are always co-located in the log line.
    const hostFieldIdx = CODE.indexOf("host,\n");
    expect(hostFieldIdx).toBeGreaterThan(-1);
    const portFieldIdx = CODE.indexOf("port,", hostFieldIdx);
    // They must appear close together — within 200 chars (the log object).
    expect(portFieldIdx).toBeGreaterThan(-1);
    expect(portFieldIdx - hostFieldIdx).toBeLessThan(200);
  });
});

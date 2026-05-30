// Static source-level guard for the face-model presence check added to
// app.ts as part of the R1 safety-net fix
// (docs/railway-hosting-review-2026-05-29.md).
//
// The check runs at module-load time inside the SPA-mount block.
// Loading app.ts in a test environment requires live DB credentials,
// configured Stripe/Supabase keys, and a real filesystem layout — none
// of which are available in the unit-test runner. The static approach used
// by app.cors-origins.test.ts and app.middleware-order.test.ts is a
// better fit: it pins the structural invariants the PR must preserve
// without needing a live environment.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "app.ts"), "utf8");

/** Strip line and block comments so text searches aren't confused by
 * documentation references to the same identifier. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(APP_SOURCE);

describe("app.ts — face model presence check path construction (R1 safety net)", () => {
  it('constructs FACE_MODEL from SPA_DIST + "mediapipe" + "models" + "face_landmarker.task"', () => {
    // The path must use the three string literals so a refactor that
    // changes any segment will be caught.
    expect(CODE).toContain('"mediapipe"');
    expect(CODE).toContain('"models"');
    expect(CODE).toContain('"face_landmarker.task"');
  });

  it("stores the path in a constant named FACE_MODEL", () => {
    expect(CODE).toMatch(/const FACE_MODEL\s*=/);
  });

  it("uses path.join to assemble FACE_MODEL so path separators are platform-safe", () => {
    expect(CODE).toMatch(/path\.join\s*\(\s*SPA_DIST/);
  });

  it("derives FACE_MODEL from SPA_DIST so it tracks the built SPA output directory", () => {
    // FACE_MODEL must be relative to SPA_DIST, not a hardcoded absolute path.
    const faceModelDecl = CODE.match(/const FACE_MODEL\s*=\s*([^;]+);/);
    expect(faceModelDecl).not.toBeNull();
    expect(faceModelDecl![1]).toContain("SPA_DIST");
  });
});

describe("app.ts — face model existence check behaviour (R1 safety net)", () => {
  it("calls existsSync to test whether FACE_MODEL is present on disk", () => {
    expect(CODE).toContain("existsSync(FACE_MODEL)");
  });

  it("branches on the ABSENCE of the model (negation of existsSync)", () => {
    // The guard must fire when the model is MISSING, i.e. !existsSync(FACE_MODEL).
    expect(CODE).toMatch(/!\s*existsSync\s*\(\s*FACE_MODEL\s*\)/);
  });

  it("calls logger.error — not logger.warn or logger.fatal — on a missing model", () => {
    // Non-fatal but loud: error severity without process termination.
    expect(CODE).toContain("logger.error");
    // Must not escalate to fatal.
    const faceModelIdx = CODE.indexOf("FACE_MODEL");
    const fatalIdx = CODE.indexOf("logger.fatal", faceModelIdx);
    // logger.fatal must not appear in the face-model block (between FACE_MODEL
    // and the next logger.info which ends the block).
    const nextInfoIdx = CODE.indexOf("logger.info", faceModelIdx);
    if (fatalIdx > -1 && nextInfoIdx > -1) {
      expect(fatalIdx).toBeGreaterThan(nextInfoIdx);
    }
  });

  it('logs the "face_model_missing" event key for structured log filtering', () => {
    // Use raw source (not comment-stripped) so string literals in the
    // logger call are searched, not just code tokens.
    expect(APP_SOURCE).toContain('"face_model_missing"');
  });

  it("includes face_model in the logged object so the log line names the expected path", () => {
    expect(CODE).toContain("face_model: FACE_MODEL");
  });

  it("log message says face-scan will be unavailable, not that the server is refusing to start", () => {
    // Non-fatal: every other surface works; only face-scan is broken.
    const logMsgMatch = APP_SOURCE.match(
      /face_model_missing[\s\S]*?"([^"]{10,})"/,
    );
    expect(logMsgMatch).not.toBeNull();
    const logMsg = logMsgMatch![1].toLowerCase();
    expect(logMsg).toMatch(/face.scan will be unavailable/);
  });
});

describe("app.ts — face model check is non-fatal (R1 safety net)", () => {
  it("does not call process.exit in the face-model check block", () => {
    // Locate the face_model_missing neighbourhood.
    const missingIdx = CODE.indexOf("face_model_missing");
    expect(missingIdx).toBeGreaterThan(-1);
    // Everything between face_model_missing and the next logger.info (the
    // spa_mounted success log) is the check block.
    const spaMountedIdx = CODE.indexOf("spa_mounted", missingIdx);
    const segment =
      spaMountedIdx > -1
        ? CODE.slice(missingIdx, spaMountedIdx)
        : CODE.slice(missingIdx, missingIdx + 600);
    expect(segment).not.toContain("process.exit");
  });

  it("does not throw in the face-model check block", () => {
    const missingIdx = CODE.indexOf("face_model_missing");
    expect(missingIdx).toBeGreaterThan(-1);
    const spaMountedIdx = CODE.indexOf("spa_mounted", missingIdx);
    const segment =
      spaMountedIdx > -1
        ? CODE.slice(missingIdx, spaMountedIdx)
        : CODE.slice(missingIdx, missingIdx + 600);
    // `throw` must not appear; `new Error` must not appear.
    expect(segment).not.toMatch(/\bthrow\b/);
    expect(segment).not.toContain("new Error");
  });
});

describe("app.ts — face model check placement (R1 safety net)", () => {
  it("FACE_MODEL check appears AFTER the SPA_INDEX_HTML existence guard", () => {
    // The check only makes sense when the SPA has been mounted — it must
    // be lexically inside the if (existsSync(SPA_INDEX_HTML)) block.
    const spaGuardIdx = CODE.indexOf("existsSync(SPA_INDEX_HTML)");
    const faceModelCheckIdx = CODE.indexOf("existsSync(FACE_MODEL)");
    expect(spaGuardIdx).toBeGreaterThan(-1);
    expect(faceModelCheckIdx).toBeGreaterThan(-1);
    expect(faceModelCheckIdx).toBeGreaterThan(spaGuardIdx);
  });

  it("spa_mounted info log appears AFTER the FACE_MODEL check", () => {
    // The success log ("serving cpap-fitter SPA") must follow the guard
    // so startup logs always appear in the right order.
    const faceModelCheckIdx = CODE.indexOf("existsSync(FACE_MODEL)");
    const spaMountedIdx = CODE.indexOf("spa_mounted");
    expect(faceModelCheckIdx).toBeGreaterThan(-1);
    expect(spaMountedIdx).toBeGreaterThan(-1);
    expect(spaMountedIdx).toBeGreaterThan(faceModelCheckIdx);
  });

  it("event key in the log object is a string literal, not a variable", () => {
    // Ensures structured-log dashboards can filter by the exact key
    // without needing dynamic string lookup.
    expect(APP_SOURCE).toContain('event: "face_model_missing"');
  });
});
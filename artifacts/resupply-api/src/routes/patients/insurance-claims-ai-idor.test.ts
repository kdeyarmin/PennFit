// Regression guard (structural source check): the AI claim sub-routes
// (preflight / predict-denial / explain-denial) must scope the claim to
// the :id patient before handing the claimId to a lib helper that looks
// the claim up by id only. Without it, a mismatched :id / :claimId
// pairing reads (and, for predict-denial, writes) another patient's
// claim — an IDOR. Behavioural supertest coverage for these thin
// wrappers would need the full auth-middleware + Supabase harness; this
// pins the scoping cheaply, like era-reconciler's source checks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROUTES = [
  "insurance-claims-preflight.ts",
  "insurance-claims-predict-denial.ts",
  "insurance-claims-explain-denial.ts",
] as const;

describe("AI claim sub-routes — patient-scoping (IDOR guard)", () => {
  for (const file of ROUTES) {
    const src = readFileSync(path.join(__dirname, file), "utf8");

    it(`${file} scopes the claim lookup by both id and patient_id`, () => {
      expect(src).toContain('.from("insurance_claims")');
      expect(src).toContain('.eq("id", parsed.data.claimId)');
      expect(src).toContain('.eq("patient_id", parsed.data.id)');
    });

    it(`${file} performs the ownership check before invoking the lib helper`, () => {
      const scopeIdx = src.indexOf('.eq("patient_id", parsed.data.id)');
      // The helper calls all reference parsed.data.claimId as the arg.
      const helperIdx = src.indexOf("parsed.data.claimId", scopeIdx + 1);
      expect(scopeIdx).toBeGreaterThan(-1);
      expect(helperIdx).toBeGreaterThan(scopeIdx);
    });
  }
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = [
  "equipment.ts",
  "insurance-coverages.ts",
  "prior-authorizations.ts",
] as const;

const AUDITED_ROUTES = [
  ...ROUTES,
  "followups.ts",
  "notes-create.ts",
  "notes-list.ts",
  "sleep-studies.ts",
] as const;

describe("patient create-route lookup failures", () => {
  for (const route of ROUTES) {
    it(`${route} distinguishes database errors from missing patients`, () => {
      const source = readFileSync(
        path.join(import.meta.dirname, route),
        "utf8",
      );

      expect(source).toContain("error: patientError");
      expect(source).toContain("redactDbErr(patientError)");
      expect(source).toContain('status(500).json({ error: "query_failed" })');
      expect(source).toContain('status(404).json({ error: "not_found" })');
      expect(source.indexOf("if (patientError)")).toBeLessThan(
        source.indexOf("if (!patient)"),
      );
    });
  }
});

describe("patient-route audit logging", () => {
  for (const route of AUDITED_ROUTES) {
    it(`${route} redacts audit-write errors before logging`, () => {
      const source = readFileSync(
        path.join(import.meta.dirname, route),
        "utf8",
      );

      expect(source).not.toContain("logger.warn({ err },");
      expect(source).not.toContain("logger.warn(\n        { err },");
      expect(source).toContain("redactDbErr");
    });
  }

  it("never logs raw caught errors on the patient route surface", () => {
    const routeFiles = readdirSync(import.meta.dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    for (const route of routeFiles) {
      const source = readFileSync(
        path.join(import.meta.dirname, route),
        "utf8",
      );
      expect(source, route).not.toContain("logger.warn({ err },");
      expect(source, route).not.toContain("logger.error({ err },");
    }
  });
});

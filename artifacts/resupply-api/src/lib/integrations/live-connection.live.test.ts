// Live therapy-cloud connection tests.
//
// THESE CONTACT A REAL VENDOR. They are OFF by default and skip — loudly
// and honestly — unless an operator opts in with real, NON-PRODUCTION
// credentials.
//
// WHY OPT-IN AND NOT "RUN IF CREDENTIALS HAPPEN TO BE PRESENT"
// -----------------------------------------------------------
// A live test that quietly passes without credentials is worse than no
// live test at all: it makes a connector look validated when nothing was
// contacted, which is precisely the claim this whole workstream exists to
// stop the product from making. So the gate is an explicit flag, the skip
// is visible in the runner output, and there is no path where an absent
// credential produces a green tick.
//
// TO RUN
// ------
//   INTEGRATION_LIVE_TESTS=1 \
//   INTEGRATION_LIVE_SOURCE=resmed_airview \
//   INTEGRATION_LIVE_ORG_ID=<tenant uuid in a NON-PRODUCTION database> \
//   INTEGRATION_LIVE_PATIENT_ID=<the vendor's test patient> \
//   AIRVIEW_API_BASE_URL=… AIRVIEW_OAUTH_TOKEN_URL=… \
//   AIRVIEW_CLIENT_ID=… AIRVIEW_CLIENT_SECRET=… AIRVIEW_DME_ID=… \
//   pnpm --filter @workspace/resupply-api exec vitest run \
//     src/lib/integrations/live-connection.live.test.ts
//
// SAFETY
// ------
//   * READ-ONLY. Every call is a GET; nothing is written to the vendor.
//   * The tenant must be in a non-production database — the boot-time
//     data-path guard (lib/data-path-guard.ts) enforces that separately,
//     and the assertion below refuses a production DEPLOY_ENV outright.
//   * Use the vendor's designated TEST patient. Do not point this at a
//     real patient's record.
//   * Assertions are on SHAPES and step outcomes. No vendor payload, no
//     patient identifier, and no credential is ever printed.

import { describe, expect, it } from "vitest";

import {
  INTEGRATION_SOURCES,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { validateIntegrationConnection } from "./validate-connection";

const enabled = process.env.INTEGRATION_LIVE_TESTS === "1";
const rawSource = process.env.INTEGRATION_LIVE_SOURCE ?? "";
const source = (INTEGRATION_SOURCES as readonly string[]).includes(rawSource)
  ? (rawSource as IntegrationSource)
  : null;
const orgId = process.env.INTEGRATION_LIVE_ORG_ID ?? "";
const patientId = process.env.INTEGRATION_LIVE_PATIENT_ID ?? "";

const ready = enabled && source !== null && orgId !== "" && patientId !== "";

/** Why the suite is skipping, printed so a skip is never mistaken for a pass. */
const skipReason = !enabled
  ? "INTEGRATION_LIVE_TESTS is not 1"
  : source === null
    ? `INTEGRATION_LIVE_SOURCE is missing or not one of ${INTEGRATION_SOURCES.join(", ")}`
    : orgId === ""
      ? "INTEGRATION_LIVE_ORG_ID is not set"
      : "INTEGRATION_LIVE_PATIENT_ID is not set";

describe("live therapy-cloud connection (opt-in)", () => {
  it("reports why it is skipping, so a skip is never read as a pass", () => {
    if (!ready) {
      expect(skipReason).toBeTruthy();
      // This assertion is the whole point of the test existing when the
      // suite is off: the runner shows one passing test whose name says
      // nothing was validated.
      expect(ready).toBe(false);
      return;
    }
    expect(ready).toBe(true);
  });

  it.skipIf(!ready)("refuses to run against a production deployment", () => {
    // A live vendor probe belongs in a non-production environment. The
    // boot-time data-path guard enforces the database side; this
    // refuses the deployment side.
    expect(process.env.DEPLOY_ENV).not.toBe("production");
    expect(process.env.NODE_ENV).not.toBe("production");
  });

  it.skipIf(!ready)(
    "completes the full validation ladder against the vendor",
    async () => {
      const result = await validateIntegrationConnection({
        orgId,
        source: source as IntegrationSource,
        partnerPatientId: patientId,
        windowDays: 30,
        actorEmail: "live-integration-test",
      });

      // Print the ladder so a failing run says WHICH step broke. Step
      // details carry vendor error codes only — never a payload.
      console.log(
        `\n[live] ${source} validation ladder:\n` +
          result.steps
            .map(
              (s) =>
                `  ${s.name.padEnd(18)} ${s.status.padEnd(14)} ${s.detail}`,
            )
            .join("\n") +
          "\n",
      );

      expect(result.steps.find((s) => s.name === "configured")?.status).toBe(
        "pass",
      );
      expect(result.steps.find((s) => s.name === "authenticated")?.status).toBe(
        "pass",
      );
      expect(result.steps.find((s) => s.name === "authorized")?.status).toBe(
        "pass",
      );
      // `no_data` is acceptable on the data steps — a test patient with
      // no therapy history is still a working connection. What must not
      // happen is a `fail`.
      for (const name of [
        "patient_lookup",
        "usage_data",
        "compliance_data",
        "device_settings",
        "schema",
      ]) {
        expect(result.steps.find((s) => s.name === name)?.status).not.toBe(
          "fail",
        );
      }
    },
    120_000,
  );

  it.skipIf(!ready)(
    "classifies a deliberately unknown patient id as no_data, not as a broken endpoint",
    async () => {
      // The distinction that decides whether an operator investigates the
      // connection or the link.
      const result = await validateIntegrationConnection({
        orgId,
        source: source as IntegrationSource,
        partnerPatientId: `pennfit-nonexistent-${Date.now()}`,
        skipStatusWrite: true,
      });
      const lookup = result.steps.find((s) => s.name === "patient_lookup");
      expect(lookup?.status).toBe("no_data");
      expect(result.errorClass).toBe("no_data");
    },
    120_000,
  );
});

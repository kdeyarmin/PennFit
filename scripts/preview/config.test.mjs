import { describe, expect, it } from "vitest";
import { applyEnvAliases } from "@workspace/resupply-secrets";
import {
  readEmailConfigOrNull,
  readSmsConfigOrNull,
} from "../../artifacts/resupply-api/src/lib/messaging/messaging-config.ts";
import { readPlatformBillingStripeConfigOrNull } from "../../artifacts/resupply-api/src/lib/stripe/config.ts";
import {
  BREAK_GLASS_VAR,
  BREAK_GLASS_REASON_VAR,
  evaluateMigrationGuard,
  readBreakGlass,
} from "../../lib/resupply-db/scripts/deploy-environment.mjs";
import {
  buildPreviewConfig,
  PREVIEW_TARGET,
  PREVIEW_ORIGIN_VARIABLES,
} from "./config.mjs";

describe("PR 1373 preview overrides", () => {
  it.each([":5432", ""])(
    "blocks the verified production database with port spelling %j",
    (port) => {
      const { variables } = buildPreviewConfig(PREVIEW_TARGET.publicOrigin);
      const result = evaluateMigrationGuard({
        ...variables,
        DATABASE_URL: `postgresql://postgres@db.${PREVIEW_TARGET.supabaseParentProjectRef}.supabase.co${port}/postgres`,
      });
      expect(result.allowed).toBe(false);
      expect(result.database.tier).toBe("production");
    },
  );
  it("disables real SMS, email and both Stripe account modes after inherited configuration", () => {
    const inherited = {
      TWILIO_ACCOUNT_SID: "AC-test",
      TWILIO_AUTH_TOKEN: "synthetic-token",
      TWILIO_PHONE_NUMBER: "+12155550100",
      SENDGRID_API_KEY: "synthetic-sendgrid-key",
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: "synthetic-event-key",
      SENDGRID_FROM_NAME: "Fixture",
      STRIPE_PLATFORM_SECRET_KEY: "synthetic-dedicated",
      STRIPE_SECRET_KEY: "synthetic-shared",
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://cmbreathe.com",
    };
    expect(readSmsConfigOrNull(inherited)).not.toBeNull();
    expect(readEmailConfigOrNull(inherited)).not.toBeNull();
    const effective = {
      ...inherited,
      ...buildPreviewConfig(PREVIEW_TARGET.publicOrigin).variables,
    };
    applyEnvAliases(effective);
    expect(readSmsConfigOrNull(effective)).toBeNull();
    expect(readEmailConfigOrNull(effective)).toBeNull();
    expect(readPlatformBillingStripeConfigOrNull(effective)).toBeNull();
    expect(effective.APP_CONFIG_OVERLAY_DISABLED).toBe("1");
  });

  it("replaces every specific production callback origin and clears real break-glass fields", () => {
    const inherited = Object.fromEntries(
      PREVIEW_ORIGIN_VARIABLES.map((name) => [name, "https://cmbreathe.com"]),
    );
    const { variables } = buildPreviewConfig(PREVIEW_TARGET.publicOrigin);
    const effective = {
      ...inherited,
      [BREAK_GLASS_VAR]: "I-UNDERSTAND-THIS-WRITES-TO-PRODUCTION",
      [BREAK_GLASS_REASON_VAR]:
        "A synthetic inherited override used only in this test",
      ...variables,
    };
    applyEnvAliases(effective);
    expect(
      PREVIEW_ORIGIN_VARIABLES.every(
        (name) => effective[name] === PREVIEW_TARGET.publicOrigin,
      ),
    ).toBe(true);
    expect(readBreakGlass(effective).engaged).toBe(false);
    expect(readBreakGlass(effective).problem).toBeNull();
    expect(variables.PRODUCTION_DATABASE_FINGERPRINT).toBe(
      "28616a064d1b,9b7fdb5b3be3",
    );
    expect(variables.PRODUCTION_SUPABASE_FINGERPRINT).toBe("47654561c718");
  });

  it.each([
    "https://pennfit.up.railway.app",
    "https://other-preview.up.railway.app",
    "https://cmbreathe.com",
    `${PREVIEW_TARGET.publicOrigin}/admin`,
    `${PREVIEW_TARGET.publicOrigin}?secret=value`,
    "https://user:password@resupply-api-pennfit-pr-1373.up.railway.app",
    "invalid",
  ])("rejects the wrong or unsafe origin %s", (origin) => {
    expect(() => buildPreviewConfig(origin)).toThrow();
  });

  it("lists required secrets without copying them or emitting usable placeholders", () => {
    const manifest = buildPreviewConfig(PREVIEW_TARGET.publicOrigin);
    expect(manifest.requiredSecrets).toEqual([
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "RESUPPLY_LINK_HMAC_KEY",
    ]);
    for (const name of manifest.requiredSecrets)
      expect(manifest.variables).not.toHaveProperty(name);
    expect(manifest.variables.SUPABASE_URL).toBe(
      `https://${PREVIEW_TARGET.supabaseProjectRef}.supabase.co`,
    );
    expect(manifest.variables.PATIENT_PACKET_REMINDER_CRON).toBe("33 19 * * *");
  });
});

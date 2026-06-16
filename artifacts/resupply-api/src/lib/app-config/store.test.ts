// Tests for the System Configuration runtime resolver.
//
// Coverage:
//   1. maskSecretHint reveals only the last 4 chars (short → fully masked).
//   2. getEffectiveEnv overlays DB values on process.env (DB wins).
//   3. The overlay ignores stray + boot-critical keys.
//   4. APP_CONFIG_OVERLAY_DISABLED bypasses the overlay entirely.
//   5. A DB error degrades to process.env (fail-soft, never throws).
//   6. applyAppConfigOverlayToEnv mutates process.env for catalog keys.
//   7. The catalog never includes bootstrap/boot-critical keys.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { APP_CONFIG_KEYS, appConfigScopeOf } from "./catalog";
import {
  __resetAppConfigCacheForTests,
  applyAppConfigOverlayToEnv,
  getEffectiveEnv,
  getTenantConfigValue,
  maskSecretHint,
} from "./store";

// The supabase mock stubs resolveSeedOrgId() to this fixed org.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  supabaseMock.reset();
  __resetAppConfigCacheForTests();
  delete process.env.APP_CONFIG_OVERLAY_DISABLED;
});

describe("maskSecretHint", () => {
  it("reveals only the last 4 characters", () => {
    expect(maskSecretHint("sk-1234567890abcd")).toBe("••••abcd");
  });

  it("fully masks short values", () => {
    expect(maskSecretHint("abcd")).toBe("••••");
    expect(maskSecretHint("xy")).toBe("••••");
  });
});

describe("getEffectiveEnv", () => {
  afterEach(() => {
    delete process.env.AIRVIEW_CLIENT_SECRET;
    delete process.env.AIRVIEW_CLIENT_ID;
  });

  it("overlays DB values on process.env (DB wins over env)", async () => {
    process.env.AIRVIEW_CLIENT_ID = "env-id";
    stageSupabaseResponse("app_config", "select", {
      data: [
        { key: "AIRVIEW_CLIENT_ID", value: "db-id" },
        { key: "AIRVIEW_CLIENT_SECRET", value: "db-secret" },
      ],
    });

    const env = await getEffectiveEnv();
    // DB wins over the environment value.
    expect(env.AIRVIEW_CLIENT_ID).toBe("db-id");
    // DB-only value is present even though the env var was unset.
    expect(env.AIRVIEW_CLIENT_SECRET).toBe("db-secret");
  });

  it("falls back to process.env when there is no DB row", async () => {
    process.env.AIRVIEW_CLIENT_ID = "env-id";
    stageSupabaseResponse("app_config", "select", { data: [] });

    const env = await getEffectiveEnv();
    expect(env.AIRVIEW_CLIENT_ID).toBe("env-id");
  });

  it("ignores stray (non-catalog) and boot-critical keys", async () => {
    stageSupabaseResponse("app_config", "select", {
      data: [
        { key: "AIRVIEW_CLIENT_SECRET", value: "ok" },
        { key: "NOT_A_REAL_KEY", value: "ignore-me" },
        // Even if a boot-critical key somehow landed in the table, the
        // overlay must never apply it.
        { key: "DATABASE_URL", value: "postgres://attacker" },
      ],
    });

    const env = await getEffectiveEnv();
    expect(env.AIRVIEW_CLIENT_SECRET).toBe("ok");
    expect(env.NOT_A_REAL_KEY).toBeUndefined();
    expect(env.DATABASE_URL).not.toBe("postgres://attacker");
  });

  it("returns process.env unchanged when the kill switch is set", async () => {
    process.env.APP_CONFIG_OVERLAY_DISABLED = "1";
    stageSupabaseResponse("app_config", "select", {
      data: [{ key: "AIRVIEW_CLIENT_SECRET", value: "db-secret" }],
    });

    const env = await getEffectiveEnv();
    expect(env.AIRVIEW_CLIENT_SECRET).toBeUndefined();
  });

  it("degrades to process.env on a DB error (fail-soft)", async () => {
    process.env.AIRVIEW_CLIENT_ID = "env-id";
    stageSupabaseResponse("app_config", "select", {
      throws: new Error("boom"),
    });

    const env = await getEffectiveEnv();
    expect(env.AIRVIEW_CLIENT_ID).toBe("env-id");
  });
});

describe("applyAppConfigOverlayToEnv", () => {
  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
  });

  it("folds catalog values into process.env and reports the count", async () => {
    stageSupabaseResponse("app_config", "select", {
      data: [{ key: "DEEPGRAM_API_KEY", value: "whsec-xyz" }],
    });

    const result = await applyAppConfigOverlayToEnv();
    expect(result.applied).toBe(1);
    expect(process.env.DEEPGRAM_API_KEY).toBe("whsec-xyz");
  });

  it("does nothing when disabled", async () => {
    process.env.APP_CONFIG_OVERLAY_DISABLED = "1";
    stageSupabaseResponse("app_config", "select", {
      data: [{ key: "DEEPGRAM_API_KEY", value: "whsec-xyz" }],
    });

    const result = await applyAppConfigOverlayToEnv();
    expect(result.applied).toBe(0);
    expect(process.env.DEEPGRAM_API_KEY).toBeUndefined();
  });
});

describe("getTenantConfigValue", () => {
  it("returns the tenant's own value when its (org_id, key) row exists", async () => {
    stageSupabaseResponse("app_config", "select", {
      data: { value: "AcmeBot" },
    });
    const v = await getTenantConfigValue(
      TENANT_ORG,
      "RESUPPLY_ASSISTANT_STOREFRONT_NAME",
    );
    expect(v).toBe("AcmeBot");
  });

  it("falls back to the seed org's value when the tenant has no row", async () => {
    // Tenant read → no row; seed read → the platform default value.
    stageSupabaseResponse("app_config", "select", { data: null });
    stageSupabaseResponse("app_config", "select", {
      data: { value: "PennBot" },
    });
    const v = await getTenantConfigValue(
      TENANT_ORG,
      "RESUPPLY_ASSISTANT_STOREFRONT_NAME",
    );
    expect(v).toBe("PennBot");
  });

  it("returns null when neither the tenant nor the seed org has a row", async () => {
    stageSupabaseResponse("app_config", "select", { data: null });
    stageSupabaseResponse("app_config", "select", { data: null });
    const v = await getTenantConfigValue(
      TENANT_ORG,
      "RESUPPLY_ASSISTANT_ADMIN_NAME",
    );
    expect(v).toBeNull();
  });

  it("does not double-read when the org IS the seed org", async () => {
    stageSupabaseResponse("app_config", "select", { data: null });
    const v = await getTenantConfigValue(
      SEED_ORG,
      "RESUPPLY_ASSISTANT_ADMIN_NAME",
    );
    // Only one read (no seed fallback, since org === seed) → null, no throw
    // from a missing second staged response.
    expect(v).toBeNull();
  });

  it("degrades to null (never throws) on a DB error", async () => {
    stageSupabaseResponse("app_config", "select", {
      error: { message: "boom" },
    });
    // Error path falls back to a seed read; stage that as a miss.
    stageSupabaseResponse("app_config", "select", { data: null });
    const v = await getTenantConfigValue(
      TENANT_ORG,
      "RESUPPLY_ASSISTANT_ADMIN_NAME",
    );
    expect(v).toBeNull();
  });
});

describe("appConfigScopeOf", () => {
  it("tags the assistant-name keys as tenant-overridable", () => {
    expect(appConfigScopeOf("RESUPPLY_ASSISTANT_STOREFRONT_NAME")).toBe(
      "tenant",
    );
    expect(appConfigScopeOf("RESUPPLY_ASSISTANT_ADMIN_NAME")).toBe("tenant");
  });

  it("defaults vendor credentials + unknown keys to platform scope", () => {
    expect(appConfigScopeOf("OPENAI_API_KEY")).toBe("platform");
    expect(appConfigScopeOf("NOT_A_REAL_KEY")).toBe("platform");
  });
});

describe("catalog safety", () => {
  it("never includes bootstrap / boot-critical keys", () => {
    const forbidden = [
      "DATABASE_URL",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "PORT",
      "NODE_ENV",
      "RESUPPLY_LINK_HMAC_KEY",
      "RAILWAY_PUBLIC_DOMAIN",
      "RESUPPLY_ALLOWED_ORIGINS",
      "SUPABASE_STORAGE_BUCKET_PRIVATE",
    ];
    for (const key of forbidden) {
      expect(APP_CONFIG_KEYS).not.toContain(key);
    }
  });
});

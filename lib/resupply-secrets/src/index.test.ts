import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DATA_KEY_ENV,
  LEGACY_KEY_ENVS,
  LINK_HMAC_KEY_ENV,
  MASTER_KEY_ENV,
  PHONE_HMAC_KEY_ENV,
  diagnoseSecretConfig,
  getDataKey,
  getLinkHmacKey,
  getPhoneHmacKey,
  hasDataKey,
  hasFullSecretConfig,
  hasLinkHmacKey,
  hasPhoneHmacKey,
} from "./index";

const ALL_ENVS = [MASTER_KEY_ENV, ...LEGACY_KEY_ENVS] as const;

describe("resupply-secrets", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const name of ALL_ENVS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ALL_ENVS) {
      const v = saved[name];
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  describe("legacy mode (per-purpose env vars)", () => {
    it("returns each legacy value unchanged for backwards compatibility", () => {
      process.env[DATA_KEY_ENV] = "legacy-data";
      process.env[LINK_HMAC_KEY_ENV] = "legacy-link";
      process.env[PHONE_HMAC_KEY_ENV] = "legacy-phone";

      expect(getDataKey()).toBe("legacy-data");
      expect(getLinkHmacKey().toString("utf8")).toBe("legacy-link");
      expect(getPhoneHmacKey().toString("utf8")).toBe("legacy-phone");
    });

    it("treats whitespace-only values as unset", () => {
      process.env[DATA_KEY_ENV] = "   ";
      expect(hasDataKey()).toBe(false);
      expect(() => getDataKey()).toThrow(/RESUPPLY_DATA_KEY/);
    });
  });

  describe("master-key mode (HKDF derivation)", () => {
    it("derives all three keys from the master", () => {
      process.env[MASTER_KEY_ENV] = "master-secret-aaaa";

      const data = getDataKey();
      const link = getLinkHmacKey();
      const phone = getPhoneHmacKey();

      // 32 bytes hex = 64 chars.
      expect(data).toMatch(/^[0-9a-f]{64}$/u);
      expect(link.length).toBe(32);
      expect(phone.length).toBe(32);
    });

    it("produces three DIFFERENT subkeys (HKDF info domain-separation)", () => {
      process.env[MASTER_KEY_ENV] = "master-secret-aaaa";
      const data = Buffer.from(getDataKey(), "hex");
      const link = getLinkHmacKey();
      const phone = getPhoneHmacKey();
      expect(data.equals(link)).toBe(false);
      expect(data.equals(phone)).toBe(false);
      expect(link.equals(phone)).toBe(false);
    });

    it("is deterministic — same master always derives the same subkeys", () => {
      process.env[MASTER_KEY_ENV] = "master-secret-aaaa";
      const a = getLinkHmacKey();
      const b = getLinkHmacKey();
      expect(a.equals(b)).toBe(true);
    });

    it("changes every subkey when the master changes", () => {
      process.env[MASTER_KEY_ENV] = "master-one";
      const link1 = getLinkHmacKey();
      const phone1 = getPhoneHmacKey();
      const data1 = getDataKey();
      process.env[MASTER_KEY_ENV] = "master-two";
      const link2 = getLinkHmacKey();
      const phone2 = getPhoneHmacKey();
      const data2 = getDataKey();
      expect(link1.equals(link2)).toBe(false);
      expect(phone1.equals(phone2)).toBe(false);
      expect(data1).not.toBe(data2);
    });
  });

  describe("legacy precedence over master", () => {
    it("prefers a legacy var when both it and the master are set", () => {
      // This is the migration ordering: PHI already encrypted under
      // the legacy data key must keep decrypting until the rotation
      // script runs.
      process.env[MASTER_KEY_ENV] = "master-secret-aaaa";
      process.env[DATA_KEY_ENV] = "legacy-data";
      expect(getDataKey()).toBe("legacy-data");
    });

    it("derives the OTHER purposes from master when only one legacy var is set", () => {
      process.env[MASTER_KEY_ENV] = "master-secret-aaaa";
      process.env[DATA_KEY_ENV] = "legacy-data";
      // link/phone fall through to derivation.
      expect(getLinkHmacKey().length).toBe(32);
      expect(getPhoneHmacKey().length).toBe(32);
    });
  });

  describe("error behavior", () => {
    it("throws a clear error mentioning both env vars when nothing is set", () => {
      expect(() => getDataKey()).toThrow(/RESUPPLY_DATA_KEY.*RESUPPLY_MASTER_KEY/u);
      expect(() => getLinkHmacKey()).toThrow(
        /RESUPPLY_LINK_HMAC_KEY.*RESUPPLY_MASTER_KEY/u,
      );
      expect(() => getPhoneHmacKey()).toThrow(
        /RESUPPLY_PHONE_HMAC_KEY.*RESUPPLY_MASTER_KEY/u,
      );
    });

    it("hasXxxKey returns false when no source is configured", () => {
      expect(hasDataKey()).toBe(false);
      expect(hasLinkHmacKey()).toBe(false);
      expect(hasPhoneHmacKey()).toBe(false);
    });

    it("hasXxxKey returns true with the master alone", () => {
      process.env[MASTER_KEY_ENV] = "m";
      expect(hasDataKey()).toBe(true);
      expect(hasLinkHmacKey()).toBe(true);
      expect(hasPhoneHmacKey()).toBe(true);
    });
  });

  describe("hasFullSecretConfig / diagnoseSecretConfig", () => {
    it("accepts master-only config", () => {
      process.env[MASTER_KEY_ENV] = "m";
      expect(hasFullSecretConfig()).toBe(true);
      expect(diagnoseSecretConfig()).toEqual([]);
    });

    it("accepts all-three-legacy config", () => {
      process.env[DATA_KEY_ENV] = "a";
      process.env[LINK_HMAC_KEY_ENV] = "b";
      process.env[PHONE_HMAC_KEY_ENV] = "c";
      expect(hasFullSecretConfig()).toBe(true);
      expect(diagnoseSecretConfig()).toEqual([]);
    });

    it("rejects nothing-set config with a message naming the master var", () => {
      const problems = diagnoseSecretConfig();
      expect(hasFullSecretConfig()).toBe(false);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/RESUPPLY_MASTER_KEY/);
    });

    it("rejects partial-legacy config and names the missing var(s)", () => {
      process.env[DATA_KEY_ENV] = "a";
      process.env[PHONE_HMAC_KEY_ENV] = "c";
      // RESUPPLY_LINK_HMAC_KEY missing.
      const problems = diagnoseSecretConfig();
      expect(hasFullSecretConfig()).toBe(false);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(LINK_HMAC_KEY_ENV);
      expect(problems[0]).not.toContain(DATA_KEY_ENV);
    });
  });
});

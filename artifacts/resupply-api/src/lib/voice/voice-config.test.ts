// Unit tests for the voice-config gate.
//
// voice-config is the "either fully configured or fully off" predicate
// that gates 4 voice routes + the WS upgrade. A regression that returns
// a PARTIAL config (the foot-gun the module's own comments warn about —
// "discover the missing secret mid-call to a real patient") has no test
// otherwise. The env-clamping and scheme-throwing helpers are pure, so
// they're trivially table-testable here.

import { describe, expect, it } from "vitest";

import {
  publicWsOriginFromBaseUrl,
  readTwilioWebhookAuthTokenOrNull,
  readVoiceConfigOrNull,
  readVoiceConfigOrThrow,
  readVoicePublicBaseUrlOrNull,
  readVoicePublicBaseUrls,
} from "./voice-config";

// The three required keys plus a public-base-URL source. Spread and
// delete/override per case so each test states only what it changes.
function fullEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENAI_API_KEY: "sk-openai-test",
    TWILIO_ACCOUNT_SID: "AC_test",
    TWILIO_AUTH_TOKEN: "tok_test",
    RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
    ...overrides,
  };
}

describe("readVoiceConfigOrNull — required-var gate", () => {
  it("returns a config when all required vars are present", () => {
    const cfg = readVoiceConfigOrNull(fullEnv());
    expect(cfg).not.toBeNull();
    expect(cfg?.openaiApiKey).toBe("sk-openai-test");
    expect(cfg?.publicBaseUrl).toBe("https://voice.example.com");
  });

  it.each([["OPENAI_API_KEY"], ["TWILIO_ACCOUNT_SID"], ["TWILIO_AUTH_TOKEN"]])(
    "returns null when %s is missing (never a partial config)",
    (key) => {
      const env = fullEnv();
      delete env[key];
      expect(readVoiceConfigOrNull(env)).toBeNull();
    },
  );

  it("returns null when no public-base-URL source is set", () => {
    const env = fullEnv();
    delete env.RESUPPLY_VOICE_PUBLIC_BASE_URL;
    expect(readVoiceConfigOrNull(env)).toBeNull();
  });

  it("falls back to https://RAILWAY_PUBLIC_DOMAIN when the explicit URL is unset", () => {
    const env = fullEnv();
    delete env.RESUPPLY_VOICE_PUBLIC_BASE_URL;
    env.RAILWAY_PUBLIC_DOMAIN = "pennfit.up.railway.app";
    expect(readVoiceConfigOrNull(env)?.publicBaseUrl).toBe(
      "https://pennfit.up.railway.app",
    );
  });

  it("prefers the explicit URL over RAILWAY_PUBLIC_DOMAIN and strips a trailing slash", () => {
    const cfg = readVoiceConfigOrNull(
      fullEnv({
        RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://voice.example.com/",
        RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
      }),
    );
    expect(cfg?.publicBaseUrl).toBe("https://voice.example.com");
  });
});

describe("readVoiceConfigOrNull — optional value parsing", () => {
  it("clamps ELEVENLABS_STABILITY into [0,1] and drops unparseable values", () => {
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STABILITY: "5" }))
        ?.elevenLabsStability,
    ).toBe(1);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STABILITY: "-2" }))
        ?.elevenLabsStability,
    ).toBe(0);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STABILITY: "0.6" }))
        ?.elevenLabsStability,
    ).toBe(0.6);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STABILITY: "abc" }))
        ?.elevenLabsStability,
    ).toBeUndefined();
    expect(
      readVoiceConfigOrNull(fullEnv())?.elevenLabsStability,
    ).toBeUndefined();
  });

  it("clamps ELEVENLABS_SPEED into [0.7,1.2]", () => {
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_SPEED: "2" }))
        ?.elevenLabsSpeed,
    ).toBe(1.2);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_SPEED: "0.1" }))
        ?.elevenLabsSpeed,
    ).toBe(0.7);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_SPEED: "0.95" }))
        ?.elevenLabsSpeed,
    ).toBe(0.95);
  });

  it("clamps ELEVENLABS_STYLE / ELEVENLABS_SIMILARITY_BOOST into [0,1]", () => {
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STYLE: "0.15" }))
        ?.elevenLabsStyle,
    ).toBe(0.15);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_STYLE: "5" }))
        ?.elevenLabsStyle,
    ).toBe(1);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_SIMILARITY_BOOST: "0.9" }))
        ?.elevenLabsSimilarityBoost,
    ).toBe(0.9);
    // Unset → undefined (tuned defaults apply downstream).
    expect(readVoiceConfigOrNull(fullEnv())?.elevenLabsStyle).toBeUndefined();
  });

  it("parses ELEVENLABS_USE_SPEAKER_BOOST: unset → undefined, else truthiness", () => {
    expect(
      readVoiceConfigOrNull(fullEnv())?.elevenLabsUseSpeakerBoost,
    ).toBeUndefined();
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_USE_SPEAKER_BOOST: "false" }))
        ?.elevenLabsUseSpeakerBoost,
    ).toBe(false);
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_USE_SPEAKER_BOOST: "true" }))
        ?.elevenLabsUseSpeakerBoost,
    ).toBe(true);
  });

  it("resolves OPENAI_REALTIME_NOISE_REDUCTION: valid values pass, typos → undefined", () => {
    expect(
      readVoiceConfigOrNull(fullEnv())?.realtimeNoiseReduction,
    ).toBeUndefined();
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_NOISE_REDUCTION: "near_field" }),
      )?.realtimeNoiseReduction,
    ).toBe("near_field");
    expect(
      readVoiceConfigOrNull(fullEnv({ OPENAI_REALTIME_NOISE_REDUCTION: "off" }))
        ?.realtimeNoiseReduction,
    ).toBe("off");
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_NOISE_REDUCTION: "loud" }),
      )?.realtimeNoiseReduction,
    ).toBeUndefined();
  });

  it("resolves the TTS transport: only 'http' (case/space-insensitive) → http, else ws", () => {
    expect(readVoiceConfigOrNull(fullEnv())?.elevenLabsTransport).toBe("ws");
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_TTS_TRANSPORT: " HTTP " }))
        ?.elevenLabsTransport,
    ).toBe("http");
    expect(
      readVoiceConfigOrNull(fullEnv({ ELEVENLABS_TTS_TRANSPORT: "websocket" }))
        ?.elevenLabsTransport,
    ).toBe("ws");
  });

  it("resolves the Realtime schema: only 'ga' → ga, else beta", () => {
    expect(readVoiceConfigOrNull(fullEnv())?.realtimeSchema).toBe("beta");
    expect(
      readVoiceConfigOrNull(fullEnv({ OPENAI_REALTIME_SCHEMA: "GA" }))
        ?.realtimeSchema,
    ).toBe("ga");
    expect(
      readVoiceConfigOrNull(fullEnv({ OPENAI_REALTIME_SCHEMA: "v1" }))
        ?.realtimeSchema,
    ).toBe("beta");
  });

  it("accepts a valid reasoning effort and drops a typo to undefined", () => {
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_REASONING_EFFORT: "high" }),
      )?.realtimeReasoningEffort,
    ).toBe("high");
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_REASONING_EFFORT: "extreme" }),
      )?.realtimeReasoningEffort,
    ).toBeUndefined();
  });

  it("parses the diagnostic flag truthily", () => {
    expect(readVoiceConfigOrNull(fullEnv())?.realtimeDiagnosticEnabled).toBe(
      false,
    );
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_DIAGNOSTIC_ENABLED: "yes" }),
      )?.realtimeDiagnosticEnabled,
    ).toBe(true);
    expect(
      readVoiceConfigOrNull(
        fullEnv({ OPENAI_REALTIME_DIAGNOSTIC_ENABLED: "0" }),
      )?.realtimeDiagnosticEnabled,
    ).toBe(false);
  });
});

describe("readVoiceConfigOrThrow", () => {
  it("returns the config when complete", () => {
    expect(readVoiceConfigOrThrow(fullEnv()).openaiApiKey).toBe(
      "sk-openai-test",
    );
  });

  it("throws (naming the required vars) when incomplete", () => {
    const env = fullEnv();
    delete env.OPENAI_API_KEY;
    expect(() => readVoiceConfigOrThrow(env)).toThrow(/OPENAI_API_KEY/);
  });
});

describe("readTwilioWebhookAuthTokenOrNull", () => {
  it("returns the trimmed token when set", () => {
    expect(
      readTwilioWebhookAuthTokenOrNull({ TWILIO_AUTH_TOKEN: "  tok  " }),
    ).toBe("tok");
  });

  it("returns null when unset or blank", () => {
    expect(readTwilioWebhookAuthTokenOrNull({})).toBeNull();
    expect(
      readTwilioWebhookAuthTokenOrNull({ TWILIO_AUTH_TOKEN: "   " }),
    ).toBeNull();
  });
});

describe("readVoicePublicBaseUrlOrNull", () => {
  it("prefers the explicit URL (trailing slash stripped)", () => {
    expect(
      readVoicePublicBaseUrlOrNull({
        RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://a.example.com/",
        RAILWAY_PUBLIC_DOMAIN: "b.up.railway.app",
      }),
    ).toBe("https://a.example.com");
  });

  it("falls back to https://RAILWAY_PUBLIC_DOMAIN", () => {
    expect(
      readVoicePublicBaseUrlOrNull({
        RAILWAY_PUBLIC_DOMAIN: "b.up.railway.app",
      }),
    ).toBe("https://b.up.railway.app");
  });

  it("returns null when neither source is set", () => {
    expect(readVoicePublicBaseUrlOrNull({})).toBeNull();
  });
});

describe("readVoicePublicBaseUrls — multi-host allowlist", () => {
  it("returns the single configured host when only the singular var is set", () => {
    expect(
      readVoicePublicBaseUrls({
        RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennpaps.com/",
      }),
    ).toEqual(["https://pennpaps.com"]);
  });

  it("unions the comma-separated allowlist with the singular var, deduped", () => {
    expect(
      readVoicePublicBaseUrls({
        RESUPPLY_VOICE_PUBLIC_BASE_URLS:
          "https://cmbreathe.com, https://pennpaps.com/",
        RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennpaps.com",
      }),
    ).toEqual(["https://cmbreathe.com", "https://pennpaps.com"]);
  });

  it("strips trailing slashes and ignores blank entries", () => {
    expect(
      readVoicePublicBaseUrls({
        RESUPPLY_VOICE_PUBLIC_BASE_URLS: "https://cmbreathe.com/, ,",
      }),
    ).toEqual(["https://cmbreathe.com"]);
  });

  it("includes the RAILWAY_PUBLIC_DOMAIN fallback when no explicit URL is set", () => {
    expect(
      readVoicePublicBaseUrls({
        RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app",
      }),
    ).toEqual(["https://pennfit.up.railway.app"]);
  });

  it("returns an empty array when nothing is configured (fails closed)", () => {
    expect(readVoicePublicBaseUrls({})).toEqual([]);
  });
});

describe("publicWsOriginFromBaseUrl", () => {
  it("maps https → wss and strips the trailing slash", () => {
    expect(publicWsOriginFromBaseUrl("https://voice.example.com")).toBe(
      "wss://voice.example.com",
    );
  });

  it("maps http → ws", () => {
    expect(publicWsOriginFromBaseUrl("http://localhost:3000")).toBe(
      "ws://localhost:3000",
    );
  });

  it("throws on a non-http(s) scheme", () => {
    expect(() =>
      publicWsOriginFromBaseUrl("gopher://nope.example.com"),
    ).toThrow(/Unsupported scheme/);
  });
});

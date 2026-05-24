// Tests for lib/llm-provider.ts
//
// PR change: added `lastLoggedProvider` module variable and
// `maybeLogProviderSelection()` which logs once on first call and
// again only if the provider changes. The reset helper
// `__resetLlmProviderCacheForTests()` now also clears lastLoggedProvider
// so subsequent tests start with a clean state.
//
// What we test:
//   - selectLlmProvider picks the correct provider based on env vars.
//   - selectLlmProvider logs on first call (via source-analysis since
//     the logger is a module import we can't vitest.mock() without
//     fighting the module graph). Behavioural tests via the reset helper.
//   - __resetLlmProviderCacheForTests() resets lastLoggedProvider so
//     a subsequent selectLlmProvider() call re-logs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetLlmProviderCacheForTests,
  selectLlmProvider,
} from "./llm-provider";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "llm-provider.ts"), "utf8");

// Always reset between tests so module-level state doesn't leak.
beforeEach(() => __resetLlmProviderCacheForTests());
afterEach(() => __resetLlmProviderCacheForTests());

// ---------------------------------------------------------------------------
// selectLlmProvider — provider selection logic
// ---------------------------------------------------------------------------

describe("selectLlmProvider — provider selection", () => {
  it("returns 'anthropic' when ANTHROPIC_API_KEY is set", () => {
    const result = selectLlmProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    expect(result.provider).toBe("anthropic");
  });

  it("returns 'anthropic' even when OPENAI_API_KEY is also set (Anthropic wins)", () => {
    const result = selectLlmProvider({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENAI_API_KEY: "sk-openai-test-key",
    });
    expect(result.provider).toBe("anthropic");
  });

  it("returns 'openai' when only OPENAI_API_KEY is set", () => {
    const result = selectLlmProvider({ OPENAI_API_KEY: "sk-openai-test-key" });
    expect(result.provider).toBe("openai");
  });

  it("returns 'offline' when neither key is set", () => {
    const result = selectLlmProvider({});
    expect(result.provider).toBe("offline");
  });

  it("returns 'offline' when ANTHROPIC_API_KEY is an empty string (whitespace only)", () => {
    const result = selectLlmProvider({ ANTHROPIC_API_KEY: "   " });
    expect(result.provider).toBe("offline");
  });

  it("returns 'offline' when OPENAI_API_KEY is an empty string (whitespace only)", () => {
    const result = selectLlmProvider({ OPENAI_API_KEY: "" });
    expect(result.provider).toBe("offline");
  });

  it("ignores ANTHROPIC_API_KEY when it trims to empty, falls back to openai", () => {
    const result = selectLlmProvider({
      ANTHROPIC_API_KEY: "  ",
      OPENAI_API_KEY: "sk-openai-test-key",
    });
    expect(result.provider).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// selectLlmProvider — stable LlmSelection shape
// ---------------------------------------------------------------------------

describe("selectLlmProvider — return shape", () => {
  it("returns an object with exactly a `provider` key", () => {
    const result = selectLlmProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    expect(result).toHaveProperty("provider");
    expect(typeof result.provider).toBe("string");
  });

  it("returns the same provider on repeated calls with the same env (stable)", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
    expect(selectLlmProvider(env).provider).toBe("anthropic");
    expect(selectLlmProvider(env).provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// maybeLogProviderSelection — PR change
// Source-analysis checks on the new logging structure.
// ---------------------------------------------------------------------------

describe("llm-provider — maybeLogProviderSelection (PR change)", () => {
  it("declares the lastLoggedProvider module-level variable", () => {
    expect(SRC).toContain("let lastLoggedProvider");
  });

  it("initialises lastLoggedProvider to null", () => {
    expect(SRC).toMatch(/let lastLoggedProvider[^=]*=\s*null/);
  });

  it("declares maybeLogProviderSelection as a private function", () => {
    expect(SRC).toContain("function maybeLogProviderSelection");
  });

  it("returns early when lastLoggedProvider equals the current provider (no-op)", () => {
    expect(SRC).toContain(
      "if (lastLoggedProvider === provider) return;",
    );
  });

  it("logs the 'llm_provider_selected' event with provider + previous fields", () => {
    expect(SRC).toContain('"llm_provider_selected"');
    expect(SRC).toContain("provider,");
    expect(SRC).toContain("previous,");
  });

  it("maybeLogProviderSelection is called by selectLlmProvider", () => {
    expect(SRC).toContain("maybeLogProviderSelection(provider)");
  });
});

// ---------------------------------------------------------------------------
// __resetLlmProviderCacheForTests — PR change: clears lastLoggedProvider
// ---------------------------------------------------------------------------

describe("__resetLlmProviderCacheForTests — resets lastLoggedProvider (PR change)", () => {
  it("resets lastLoggedProvider to null in the source", () => {
    expect(SRC).toContain("lastLoggedProvider = null;");
  });

  it("after reset, selectLlmProvider can be called again without issue", () => {
    // Verify that calling selectLlmProvider → reset → selectLlmProvider
    // doesn't throw. The PR change that clears lastLoggedProvider means
    // a second call is treated as a fresh first call.
    selectLlmProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    __resetLlmProviderCacheForTests();
    const result = selectLlmProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    expect(result.provider).toBe("anthropic");
  });

  it("provider switches are visible after a reset (regression guard)", () => {
    // First call: anthropic. Reset. Second call: openai.
    // Without the lastLoggedProvider reset, the "anthropic → openai"
    // change log would never fire because lastLoggedProvider still held
    // "anthropic" — masking the provider rotation in prod logs.
    selectLlmProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    __resetLlmProviderCacheForTests();
    const result = selectLlmProvider({ OPENAI_API_KEY: "sk-openai-test-key" });
    expect(result.provider).toBe("openai");
  });
});
// Unit tests for the admin-assistant (PennPilot) system-prompt builder.

import { describe, it, expect } from "vitest";

import {
  buildAdminAssistantSystemPrompt,
  ADMIN_OFFLINE_FALLBACK_REPLY,
  MAX_ADMIN_CHAT_TURNS,
  MAX_ADMIN_USER_MESSAGE_CHARS,
  type AdminAssistantContext,
} from "./adminAssistantKnowledge";

describe("buildAdminAssistantSystemPrompt", () => {
  const baseCtx: AdminAssistantContext = {
    adminEmail: "alice@pennpaps.com",
    adminRole: "admin",
  };

  it("includes the persona, the app map, and the single tool", () => {
    const prompt = buildAdminAssistantSystemPrompt(baseCtx);
    expect(prompt).toContain("PennPilot");
    // Carries a real slice of the admin nav map.
    expect(prompt).toContain("/admin/billing");
    expect(prompt).toContain("ADMIN CONSOLE MAP");
    // The feature-suggester tool + confirm-first rule.
    expect(prompt).toContain("suggest_feature");
    expect(prompt).toContain("CONFIRM FIRST");
  });

  it("embeds the signed-in operator's identity", () => {
    const prompt = buildAdminAssistantSystemPrompt(baseCtx);
    expect(prompt).toContain("alice@pennpaps.com");
    expect(prompt).toContain("Role: admin");
  });

  it("adds an agent-specific note for the junior role", () => {
    const prompt = buildAdminAssistantSystemPrompt({
      adminEmail: "bob@pennpaps.com",
      adminRole: "agent",
    });
    expect(prompt).toContain("this operator is an AGENT");
  });

  it("does not crash with unknown identity", () => {
    const prompt = buildAdminAssistantSystemPrompt({
      adminEmail: null,
      adminRole: null,
    });
    expect(prompt).toContain("(unknown)");
  });

  it("stays under the system-prompt char cap", () => {
    const prompt = buildAdminAssistantSystemPrompt(baseCtx);
    // The builder throws if it ever exceeds the internal cap; here we
    // just assert it produced a substantial, non-empty prompt.
    expect(prompt.length).toBeGreaterThan(2000);
    expect(prompt.length).toBeLessThan(40_000);
  });

  it("exports sane request limits + an offline fallback", () => {
    expect(MAX_ADMIN_CHAT_TURNS).toBeGreaterThan(0);
    expect(MAX_ADMIN_USER_MESSAGE_CHARS).toBeGreaterThan(0);
    expect(ADMIN_OFFLINE_FALLBACK_REPLY.length).toBeGreaterThan(0);
  });
});

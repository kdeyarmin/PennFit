// Unit tests for the chatbot email auto-reply generator.
//
// We drive the OpenAI path (simplest to mock) via the fetch test seam
// and assert the {handoff, reply, confidence} contract collapses to the
// right EmailReplyResult — including the confidence gate (only high-
// confidence replies are sent; low/absent confidence hands off). The
// "offline" branch (no provider key) and the fail-soft hand-off branches
// (HTTP error, bad JSON) are the safety guarantees the inbound webhook
// relies on, so they're covered too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanyInfo } from "../company-info";

// A second tenant's saved identity (source "database" so the brand/
// contact rewrite fires) plus a neutral fallback (source "fallback" →
// no-op rewrite) returned for every other orgId so the rest of the
// suite is unaffected and never hits a real Supabase lookup.
const { TENANT_B_INFO, FALLBACK_INFO } = vi.hoisted(() => {
  const base = {
    faxE164: null,
    websiteUrl: null,
    address: null,
    organizationalNpi: null,
    assistantStorefrontName: "PennBot",
    assistantAdminName: "PennPilot",
  };
  const TENANT_B_INFO: CompanyInfo = {
    ...base,
    name: "Acme Respiratory",
    legalName: "Acme Respiratory LLC",
    phoneE164: "+15551230000",
    phoneDisplay: "(555) 123-0000",
    supportPhoneE164: "+15551230000",
    supportPhoneDisplay: "(555) 123-0000",
    supportEmail: "help@acmeresp.com",
    generalEmail: "info@acmeresp.com",
    billingEmail: "billing@acmeresp.com",
    websiteUrl: "https://acmeresp.com",
    supportHours: "Mon–Fri 8a–6p CT",
    source: "database",
  };
  const FALLBACK_INFO: CompanyInfo = {
    ...base,
    name: "PennPaps",
    legalName: "Penn Home Medical Supply",
    phoneE164: "+18144710627",
    phoneDisplay: "(814) 471-0627",
    supportPhoneE164: "+18144710627",
    supportPhoneDisplay: "(814) 471-0627",
    supportEmail: "support@pennpaps.com",
    generalEmail: "info@pennpaps.com",
    billingEmail: "info@pennpaps.com",
    supportHours: "Mon–Fri 9a–5p ET",
    source: "fallback",
  };
  return { TENANT_B_INFO, FALLBACK_INFO };
});

// Keep the real module (applyCompanyIdentityToText etc.) but pin
// getCompanyInfo so the tenant rewrite is deterministic and offline.
vi.mock("../company-info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../company-info")>();
  return {
    ...actual,
    getCompanyInfo: vi.fn(async (orgId?: string) =>
      orgId === "org-b" ? TENANT_B_INFO : FALLBACK_INFO,
    ),
  };
});

import {
  generateEmailReply,
  __setEmailAutoReplyFetchForTests,
  __resetEmailAutoReplyCacheForTests,
} from "./email-auto-reply";

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function openAiReply(content: string): Response {
  return okJson({ choices: [{ message: { content } }] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetEmailAutoReplyCacheForTests();
  // Force the OpenAI path: clear Anthropic, set OpenAI.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  __setEmailAutoReplyFetchForTests(undefined);
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const INPUT = {
  body: "Do your nasal masks work if I breathe through my mouth at night?",
  subject: "Question about masks",
  thread: [],
};

describe("generateEmailReply", () => {
  it("returns offline when no LLM provider is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "offline" });
  });

  it("returns a reply when the model answers with high confidence", async () => {
    const fetchMock = vi.fn(async () =>
      openAiReply(
        JSON.stringify({
          handoff: false,
          confidence: 0.95,
          reply:
            "Hi there!\n\nGreat question — a full-face mask is the way to go.\n\n— The PennPaps Team",
        }),
      ),
    );
    __setEmailAutoReplyFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateEmailReply(INPUT);
    expect(result.kind).toBe("reply");
    if (result.kind === "reply") {
      expect(result.reply).toContain("— The PennPaps Team");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands off when the reply is below the confidence bar", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(
          JSON.stringify({
            handoff: false,
            confidence: 0.5,
            reply:
              "I think the deductible resets in January.\n— The PennPaps Team",
          }),
        ),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("hands off when the model omits a confidence (no signal)", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(
          JSON.stringify({
            handoff: false,
            reply: "All set.\n— The PennPaps Team",
          }),
        ),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("honors a custom RESUPPLY_EMAIL_AUTO_REPLY_MIN_CONFIDENCE override", async () => {
    process.env.RESUPPLY_EMAIL_AUTO_REPLY_MIN_CONFIDENCE = "0.5";
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(
          JSON.stringify({
            handoff: false,
            confidence: 0.6,
            reply: "Happy to help.\n— The PennPaps Team",
          }),
        ),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result.kind).toBe("reply");
  });

  it("hands off when the model sets handoff=true", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(JSON.stringify({ handoff: true, reply: "" })),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply({
      ...INPUT,
      body: "Where is my order? It said it shipped last week.",
    });
    expect(result).toEqual({ kind: "handoff" });
  });

  it("hands off when handoff=false but reply is empty", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(JSON.stringify({ handoff: false, reply: "   " })),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("hands off on unparseable model output", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply("I'm not going to give you JSON, sorry"),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("tolerates a markdown-fenced JSON object", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(
          '```json\n{"handoff": false, "confidence": 0.9, "reply": "All set.\\n— The PennPaps Team"}\n```',
        ),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result.kind).toBe("reply");
  });

  it("hands off on an HTTP error from the model", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "upstream boom",
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("brands the system prompt + sign-off for the sender's tenant", async () => {
    let capturedSystem = "";
    __setEmailAutoReplyFetchForTests(
      vi.fn(async (_url: string, init: { body?: string }) => {
        const sent = JSON.parse(init.body ?? "{}") as {
          messages: Array<{ role: string; content: string }>;
        };
        capturedSystem = sent.messages[0]?.content ?? "";
        return openAiReply(
          JSON.stringify({ handoff: false, confidence: 0.95, reply: "Hi" }),
        );
      }) as unknown as typeof fetch,
    );

    await generateEmailReply(INPUT, process.env, "org-b");

    // The knowledge base + email addendum carry the second tenant's
    // brand, contact details, and legal sign-off — no seed leak.
    expect(capturedSystem).toContain("Acme Respiratory");
    expect(capturedSystem).toContain("help@acmeresp.com");
    expect(capturedSystem).toContain("Acme Respiratory LLC"); // addendum sign-off
    expect(capturedSystem).not.toContain("PennPaps");
    expect(capturedSystem).not.toContain("support@pennpaps.com");
    expect(capturedSystem).not.toContain("(814) 471-0627");
    expect(capturedSystem).not.toContain("Penn Home Medical Supply");
  });
});

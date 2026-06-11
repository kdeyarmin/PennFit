import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  CHAT_TOOLS,
  executeChatTool,
  serializeToolResult,
  type ChatToolContext,
} from "./chatbotTools";
import { _resetTrackOrderRateBucketForTests } from "./orderTracking";

beforeEach(() => {
  supabaseMock.reset();
  _resetTrackOrderRateBucketForTests();
});

describe("CHAT_TOOLS descriptors", () => {
  it("exposes recommend_masks, find_masks, compare_masks, and track_order with strict schemas", async () => {
    const names = CHAT_TOOLS.map((t) => t.function.name);
    expect(names).toEqual([
      "recommend_masks",
      "find_masks",
      "compare_masks",
      "track_order",
    ]);
    for (const tool of CHAT_TOOLS) {
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
  });
});

describe("executeChatTool", () => {
  it("returns an unknown-tool error for unrecognised names", async () => {
    const result = await executeChatTool("delete_database", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown tool/);
  });

  describe("recommend_masks", () => {
    it("returns ranked recommendations for a side-sleeping mouth-breather", async () => {
      const result = await executeChatTool("recommend_masks", {
        mouth_breather: true,
        side_or_stomach_sleeper: true,
        cpap_pressure_setting: "high",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        recommendations: Array<{ type: string; confidence: number }>;
      };
      expect(data.recommendations.length).toBeGreaterThan(0);
      expect(data.recommendations.length).toBeLessThanOrEqual(3);
      // Mouth breather + high pressure should bias toward full-face / hybrid
      // styles rather than nasal-pillow at the top of the list.
      expect(["fullFace", "hybrid"]).toContain(data.recommendations[0]!.type);
      expect(data.recommendations[0]!.confidence).toBeGreaterThan(0);
    });

    it("respects the `limit` argument", async () => {
      const result = await executeChatTool("recommend_masks", {
        side_or_stomach_sleeper: true,
        limit: 2,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { recommendations: unknown[] };
      expect(data.recommendations).toHaveLength(2);
    });

    it("works with an empty argument object (no preferences stated)", async () => {
      const result = await executeChatTool("recommend_masks", {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { recommendations: unknown[] };
      expect(data.recommendations.length).toBeGreaterThan(0);
    });

    it("does not invent a 'breathes through nose' rationale when mouth_breather is omitted", async () => {
      // Regression: previously toQuestionnaireAnswers defaulted
      // missing booleans to `false`, which the recommendation engine
      // treats as an affirmative negative — e.g. emitting
      // "You breathe through your nose during sleep" in the patient-
      // facing rationale, despite the patient never having said so.
      // After the fix, missing booleans pass through as `null` and
      // the rationale stays silent on the question.
      const result = await executeChatTool("recommend_masks", {});
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        recommendations: Array<{ rationale?: string[] }>;
      };
      for (const r of data.recommendations) {
        for (const reason of r.rationale ?? []) {
          expect(reason.toLowerCase()).not.toContain(
            "you breathe through your nose during sleep",
          );
          expect(reason.toLowerCase()).not.toContain(
            "ideal since you breathe through your mouth",
          );
        }
      }
    });

    it("rejects unknown extra fields (zod strict)", async () => {
      const result = await executeChatTool("recommend_masks", {
        mouth_breather: true,
        delete_orders: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid arguments/);
    });

    it("rejects the wrong type for an enum arg", async () => {
      const result = await executeChatTool("recommend_masks", {
        cpap_pressure_setting: "stratospheric",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("find_masks", () => {
    it("filters by mask type", async () => {
      const result = await executeChatTool("find_masks", {
        type: "nasalPillow",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ type: string }>;
      };
      expect(data.masks.length).toBeGreaterThan(0);
      for (const m of data.masks) expect(m.type).toBe("nasalPillow");
    });

    it("filters by manufacturer with case-insensitive substring match", async () => {
      const result = await executeChatTool("find_masks", {
        manufacturer: "RESMED",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ manufacturer: string }>;
      };
      expect(data.masks.length).toBeGreaterThan(0);
      for (const m of data.masks)
        expect(m.manufacturer.toLowerCase()).toContain("resmed");
    });

    it("excludes masks below the requested pressure rating", async () => {
      const result = await executeChatTool("find_masks", {
        min_pressure_rating: 25,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ pressureRangeMax: number }>;
      };
      for (const m of data.masks)
        expect(m.pressureRangeMax).toBeGreaterThanOrEqual(25);
    });

    it("returns an empty list (not an error) when nothing matches", async () => {
      const result = await executeChatTool("find_masks", {
        manufacturer: "nonexistent-vendor",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { masks: unknown[] };
      expect(data.masks).toEqual([]);
    });

    it("rejects unknown extra fields", async () => {
      const result = await executeChatTool("find_masks", {
        invalid_field: true,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("compare_masks", () => {
    it("compares two masks looked up by catalog id", async () => {
      const result = await executeChatTool("compare_masks", {
        mask_a: "resmed-airfit-p10",
        mask_b: "fisher-paykel-brevida",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        a: { name: string; type: string };
        b: { name: string; type: string };
        differences: string[];
      };
      expect(data.a.name).toBe("AirFit P10");
      expect(data.b.name).toBe("Brevida Nasal Pillow");
      // Both are nasal pillows — the type difference shouldn't appear.
      const typeDiff = data.differences.find((d) =>
        d.startsWith("AirFit P10 is a"),
      );
      expect(typeDiff).toBeUndefined();
      // But weight delta and manufacturer should differ.
      expect(data.differences.length).toBeGreaterThan(0);
      expect(data.differences.join(" ")).toMatch(/ResMed|Fisher & Paykel/);
    });

    it("resolves masks by case-insensitive name substring", async () => {
      const result = await executeChatTool("compare_masks", {
        mask_a: "p10",
        mask_b: "F20",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        a: { name: string };
        b: { name: string };
      };
      expect(data.a.name).toContain("P10");
      expect(data.b.name).toContain("F20");
    });

    it("highlights cross-style differences", async () => {
      const result = await executeChatTool("compare_masks", {
        mask_a: "AirFit F20",
        mask_b: "AirFit P10",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { differences: string[] };
      const text = data.differences.join(" ");
      expect(text).toMatch(/fullFace|nasalPillow/);
    });

    it("returns an error when one mask cannot be resolved", async () => {
      const result = await executeChatTool("compare_masks", {
        mask_a: "AirFit P10",
        mask_b: "ImaginaryMask 9000",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error).toMatch(/ImaginaryMask 9000/);
    });

    it("returns an error when both args resolve to the same mask", async () => {
      const result = await executeChatTool("compare_masks", {
        mask_a: "AirFit P10",
        mask_b: "p10",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error).toMatch(/same mask/);
    });

    it("rejects missing required arguments (zod strict)", async () => {
      const result = await executeChatTool("compare_masks", { mask_a: "P10" });
      expect(result.ok).toBe(false);
    });
  });
});

describe("track_order", () => {
  const ORDER_ROW = {
    order_reference: "PENN-AB1234",
    patient_email: "pat@example.com",
    mask_name: "AirFit P10",
    mask_manufacturer: "ResMed",
    mask_model_number: "PHM-RM-P10",
    email_status: "delivered",
    email_delivered_at: "2026-06-01T12:00:00Z",
    created_at: "2026-06-01T11:00:00Z",
  };
  const ctx = (emails: string[]): ChatToolContext => ({
    candidateEmails: emails,
    rateLimitKey: null,
  });

  it("returns the order when reference + harvested email match", async () => {
    stageSupabaseResponse("orders", "select", { data: ORDER_ROW });
    const result = await executeChatTool(
      "track_order",
      { order_reference: "ab1234" },
      ctx(["pat@example.com"]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const data = result.data as {
      status: string;
      order: { orderReference: string; mask: { name: string } };
    };
    expect(data.status).toBe("found");
    expect(data.order.orderReference).toBe("PENN-AB1234");
    expect(data.order.mask.name).toBe("AirFit P10");
  });

  it("asks for the email when none has been typed in the conversation", async () => {
    const result = await executeChatTool(
      "track_order",
      { order_reference: "PENN-AB1234" },
      ctx([]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("needs_email");
  });

  it("reports not_found when the email doesn't match the order", async () => {
    stageSupabaseResponse("orders", "select", { data: ORDER_ROW });
    const result = await executeChatTool(
      "track_order",
      { order_reference: "PENN-AB1234" },
      ctx(["wrong@example.com"]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("not_found");
  });

  it("tries the most recent harvested email first", async () => {
    // Two candidates; only the LAST-typed one matches. The first
    // lookup (most recent first) must already succeed — only one
    // staged select round-trip is provided, so a wrong order of
    // attempts would drain the queue and fail.
    stageSupabaseResponse("orders", "select", { data: ORDER_ROW });
    const result = await executeChatTool(
      "track_order",
      { order_reference: "PENN-AB1234" },
      ctx(["old@example.com", "pat@example.com"]),
    );
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("found");
  });

  it("rejects a malformed reference without touching the database", async () => {
    const result = await executeChatTool(
      "track_order",
      { order_reference: "TOTALLY-NOT-A-REF" },
      ctx(["pat@example.com"]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("not_found");
  });

  it("degrades to unavailable on a database error", async () => {
    stageSupabaseResponse("orders", "select", {
      data: null,
      error: { message: "boom" },
    });
    const result = await executeChatTool(
      "track_order",
      { order_reference: "PENN-AB1234" },
      ctx(["pat@example.com"]),
    );
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("unavailable");
  });

  it("rate-limits via the shared /orders/track bucket", async () => {
    const limitedCtx: ChatToolContext = {
      candidateEmails: ["pat@example.com"],
      rateLimitKey: "1.2.3.4:track",
    };
    // Exhaust the 10-slot window…
    for (let i = 0; i < 10; i++) {
      stageSupabaseResponse("orders", "select", { data: null });
      await executeChatTool(
        "track_order",
        { order_reference: "PENN-AB1234" },
        limitedCtx,
      );
    }
    // …then the next attempt short-circuits before the lookup.
    const result = await executeChatTool(
      "track_order",
      { order_reference: "PENN-AB1234" },
      limitedCtx,
    );
    if (!result.ok) throw new Error("expected ok");
    expect((result.data as { status: string }).status).toBe("rate_limited");
  });
});

describe("serializeToolResult", () => {
  it("produces compact JSON for ok results", async () => {
    const result = await executeChatTool("find_masks", {
      type: "nasalPillow",
      limit: 1,
    });
    const json = serializeToolResult(result);
    const parsed = JSON.parse(json);
    expect(parsed.masks).toBeDefined();
  });

  it("wraps error results in an {error} envelope", async () => {
    const json = serializeToolResult({ ok: false, error: "boom" });
    expect(JSON.parse(json)).toEqual({ error: "boom" });
  });
});

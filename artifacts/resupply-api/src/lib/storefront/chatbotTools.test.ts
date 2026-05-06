import { describe, it, expect } from "vitest";
import {
  CHAT_TOOLS,
  executeChatTool,
  serializeToolResult,
} from "./chatbotTools";

describe("CHAT_TOOLS descriptors", () => {
  it("exposes recommend_masks, find_masks, and compare_masks with strict schemas", () => {
    const names = CHAT_TOOLS.map((t) => t.function.name);
    expect(names).toEqual(["recommend_masks", "find_masks", "compare_masks"]);
    for (const tool of CHAT_TOOLS) {
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
  });
});

describe("executeChatTool", () => {
  it("returns an unknown-tool error for unrecognised names", () => {
    const result = executeChatTool("delete_database", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown tool/);
  });

  describe("recommend_masks", () => {
    it("returns ranked recommendations for a side-sleeping mouth-breather", () => {
      const result = executeChatTool("recommend_masks", {
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

    it("respects the `limit` argument", () => {
      const result = executeChatTool("recommend_masks", {
        side_or_stomach_sleeper: true,
        limit: 2,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { recommendations: unknown[] };
      expect(data.recommendations).toHaveLength(2);
    });

    it("works with an empty argument object (no preferences stated)", () => {
      const result = executeChatTool("recommend_masks", {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { recommendations: unknown[] };
      expect(data.recommendations.length).toBeGreaterThan(0);
    });

    it("rejects unknown extra fields (zod strict)", () => {
      const result = executeChatTool("recommend_masks", {
        mouth_breather: true,
        delete_orders: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid arguments/);
    });

    it("rejects the wrong type for an enum arg", () => {
      const result = executeChatTool("recommend_masks", {
        cpap_pressure_setting: "stratospheric",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("find_masks", () => {
    it("filters by mask type", () => {
      const result = executeChatTool("find_masks", { type: "nasalPillow" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ type: string }>;
      };
      expect(data.masks.length).toBeGreaterThan(0);
      for (const m of data.masks) expect(m.type).toBe("nasalPillow");
    });

    it("filters by manufacturer with case-insensitive substring match", () => {
      const result = executeChatTool("find_masks", { manufacturer: "RESMED" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ manufacturer: string }>;
      };
      expect(data.masks.length).toBeGreaterThan(0);
      for (const m of data.masks)
        expect(m.manufacturer.toLowerCase()).toContain("resmed");
    });

    it("excludes masks below the requested pressure rating", () => {
      const result = executeChatTool("find_masks", {
        min_pressure_rating: 25,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as {
        masks: Array<{ pressureRangeMax: number }>;
      };
      for (const m of data.masks) expect(m.pressureRangeMax).toBeGreaterThanOrEqual(25);
    });

    it("returns an empty list (not an error) when nothing matches", () => {
      const result = executeChatTool("find_masks", {
        manufacturer: "nonexistent-vendor",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { masks: unknown[] };
      expect(data.masks).toEqual([]);
    });

    it("rejects unknown extra fields", () => {
      const result = executeChatTool("find_masks", { invalid_field: true });
      expect(result.ok).toBe(false);
    });
  });

  describe("compare_masks", () => {
    it("compares two masks looked up by catalog id", () => {
      const result = executeChatTool("compare_masks", {
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

    it("resolves masks by case-insensitive name substring", () => {
      const result = executeChatTool("compare_masks", {
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

    it("highlights cross-style differences", () => {
      const result = executeChatTool("compare_masks", {
        mask_a: "AirFit F20",
        mask_b: "AirFit P10",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      const data = result.data as { differences: string[] };
      const text = data.differences.join(" ");
      expect(text).toMatch(/fullFace|nasalPillow/);
    });

    it("returns an error when one mask cannot be resolved", () => {
      const result = executeChatTool("compare_masks", {
        mask_a: "AirFit P10",
        mask_b: "ImaginaryMask 9000",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error).toMatch(/ImaginaryMask 9000/);
    });

    it("returns an error when both args resolve to the same mask", () => {
      const result = executeChatTool("compare_masks", {
        mask_a: "AirFit P10",
        mask_b: "p10",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error).toMatch(/same mask/);
    });

    it("rejects missing required arguments (zod strict)", () => {
      const result = executeChatTool("compare_masks", { mask_a: "P10" });
      expect(result.ok).toBe(false);
    });
  });
});

describe("serializeToolResult", () => {
  it("produces compact JSON for ok results", () => {
    const result = executeChatTool("find_masks", { type: "nasalPillow", limit: 1 });
    const json = serializeToolResult(result);
    const parsed = JSON.parse(json);
    expect(parsed.masks).toBeDefined();
  });

  it("wraps error results in an {error} envelope", () => {
    const json = serializeToolResult({ ok: false, error: "boom" });
    expect(JSON.parse(json)).toEqual({ error: "boom" });
  });
});

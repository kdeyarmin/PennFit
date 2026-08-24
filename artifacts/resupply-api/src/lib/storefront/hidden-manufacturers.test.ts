// Hidden manufacturers on the SEARCH surfaces (migration 0516).
//
// The fitting engine's side of this is pinned in lib/fitting/tiers.test.ts.
// This file covers the other half of the operator's ask — "don't list them
// in any searches" — across the three legacy, context-free surfaces that
// share the static catalog: the recommendation engine behind
// POST /api/recommend, the assistant's catalog tools, and the assistant's
// system prompt.
//
// The prompt case is the one worth stating out loud: filtering the TOOLS
// alone is not enough, because the model can answer "do you carry the
// AirFit F20?" straight out of the catalog section without ever calling a
// tool.

import { describe, expect, it } from "vitest";

import { maskCatalog } from "../../data/maskCatalog.js";
import {
  recommend,
  type FacialMeasurements,
  type QuestionnaireAnswers,
} from "./recommendationEngine.js";
import { executeChatTool, type ChatToolContext } from "./chatbotTools.js";
import { buildChatSystemPromptBase } from "./chatbotKnowledge.js";

const HIDDEN_BRAND = "ResMed";
const VISIBLE_BRAND = "Philips Respironics";

const HIDDEN = new Set(
  maskCatalog.filter((m) => m.manufacturer === HIDDEN_BRAND).map((m) => m.id),
);

/**
 * How the catalog section opens a model's entry, so an assertion can tell a
 * real catalog ENTRY from a passing mention of the same name in the prose
 * sections further down the prompt.
 */
function formatCatalogLine(mask: {
  manufacturer: string;
  name: string;
}): string {
  return `- ${mask.manufacturer} ${mask.name} (`;
}

const NEUTRAL_MEASUREMENTS: FacialMeasurements = {
  noseWidth: 35.7,
  noseHeight: 29.4,
  noseToChin: 89.4,
  mouthWidth: 49.1,
  faceWidthAtCheekbones: 153.3,
  calibrationMethod: "creditCard",
};

const NO_ANSWERS: QuestionnaireAnswers = {
  mouthBreather: null,
  claustrophobic: null,
  sideOrStomachSleeper: null,
  heavyFacialHair: null,
  wearsGlasses: null,
  frequentCongestion: null,
  priorMaskExperience: "none",
  mobilityLimitations: null,
  sensitiveSkin: null,
  siliconeSensitivity: null,
  cpapPressureSetting: "unknown",
};

function ctx(hiddenMaskIds?: ReadonlySet<string>): ChatToolContext {
  return { candidateEmails: [], rateLimitKey: null, hiddenMaskIds };
}

describe("recommendationEngine hiddenMaskIds", () => {
  it("is a no-op by default, so an un-configured tenant is unchanged", () => {
    const before = recommend(NEUTRAL_MEASUREMENTS, NO_ANSWERS);
    const withEmpty = recommend(NEUTRAL_MEASUREMENTS, NO_ANSWERS, {
      hiddenMaskIds: new Set(),
    });
    expect(withEmpty.topRecommendations.map((r) => r.maskId)).toEqual(
      before.topRecommendations.map((r) => r.maskId),
    );
  });

  it("keeps a hidden manufacturer out of both the top picks and the alternatives", () => {
    expect(HIDDEN.size).toBeGreaterThan(0);
    const result = recommend(NEUTRAL_MEASUREMENTS, NO_ANSWERS, {
      hiddenMaskIds: HIDDEN,
    });
    const shown = [...result.topRecommendations, ...result.alternatives].map(
      (r) => r.maskId,
    );
    expect(shown.some((id) => HIDDEN.has(id))).toBe(false);
    // Removed BEFORE scoring, so the shortlist backfills instead of
    // leaving holes where a hidden mask used to rank.
    expect(result.topRecommendations).toHaveLength(3);
  });
});

describe("assistant catalog tools", () => {
  it("returns nothing from find_masks for a hidden brand asked for by name", async () => {
    const result = await executeChatTool(
      "find_masks",
      { manufacturer: HIDDEN_BRAND, limit: 10 },
      ctx(HIDDEN),
    );
    expect(result.ok).toBe(true);
    if (result.ok && "masks" in result.data) {
      expect(result.data.masks).toHaveLength(0);
    }
  });

  it("still returns a brand the tenant carries", async () => {
    const result = await executeChatTool(
      "find_masks",
      { manufacturer: VISIBLE_BRAND, limit: 10 },
      ctx(HIDDEN),
    );
    expect(result.ok).toBe(true);
    if (result.ok && "masks" in result.data) {
      expect(result.data.masks.length).toBeGreaterThan(0);
    }
  });

  it("reports a hidden mask as not found rather than comparing it", async () => {
    const hiddenId = [...HIDDEN][0]!;
    const visibleId = maskCatalog.find(
      (m) => m.manufacturer === VISIBLE_BRAND,
    )!.id;

    const blocked = await executeChatTool(
      "compare_masks",
      { mask_a: hiddenId, mask_b: visibleId },
      ctx(HIDDEN),
    );
    expect(blocked.ok).toBe(false);

    // Same call with nothing hidden still works, so the refusal above is
    // the hide and not a broken lookup.
    const allowed = await executeChatTool(
      "compare_masks",
      { mask_a: hiddenId, mask_b: visibleId },
      ctx(),
    );
    expect(allowed.ok).toBe(true);
  });

  it("keeps hidden masks out of recommend_masks", async () => {
    const result = await executeChatTool(
      "recommend_masks",
      { limit: 5 },
      ctx(HIDDEN),
    );
    expect(result.ok).toBe(true);
    if (result.ok && "recommendations" in result.data) {
      expect(result.data.recommendations.length).toBeGreaterThan(0);
      for (const r of result.data.recommendations) {
        expect(HIDDEN.has(r.maskId)).toBe(false);
      }
    }
  });
});

describe("assistant system prompt", () => {
  it("drops a hidden mask's catalog entry but keeps the carried ones", () => {
    const hiddenModel = maskCatalog.find((m) => HIDDEN.has(m.id))!;
    expect(buildChatSystemPromptBase()).toContain(
      formatCatalogLine(hiddenModel),
    );

    const filtered = buildChatSystemPromptBase(HIDDEN);
    expect(filtered).not.toContain(formatCatalogLine(hiddenModel));
    // A manufacturer that is still carried is untouched.
    const kept = maskCatalog.find((m) => m.manufacturer === VISIBLE_BRAND)!;
    expect(filtered).toContain(formatCatalogLine(kept));
  });

  it("names the dropped line and tells the model what to do about it", () => {
    // Removing catalog entries is not enough on its own: prose sections
    // further down name specific masks to illustrate general CPAP
    // guidance, and the model knows the mask market anyway. The
    // constraint has to be stated, not implied.
    const filtered = buildChatSystemPromptBase(HIDDEN);
    expect(filtered).toContain("no longer carries");
    expect(filtered).toContain(`Entire lines: ${HIDDEN_BRAND}`);
    expect(filtered).not.toContain(`Entire lines: ${VISIBLE_BRAND}`);
  });

  it("does not call a partially-hidden brand a dropped line", () => {
    // One model hidden is not a dropped line, and telling the model
    // otherwise would make it refuse masks we still sell.
    const oneModel = new Set([[...HIDDEN][0]!]);
    const filtered = buildChatSystemPromptBase(oneModel);
    expect(filtered).not.toContain(`Entire lines: ${HIDDEN_BRAND}`);
  });

  it("names an individually hidden model so the model cannot offer it", () => {
    // Filtering the catalog entry is not enough on its own — the model
    // knows the mask market, and one hidden model of a line that is
    // otherwise carried never reaches the dropped-lines list.
    const oneId = [...HIDDEN][0]!;
    const one = maskCatalog.find((m) => m.id === oneId)!;
    const filtered = buildChatSystemPromptBase(new Set([oneId]));
    expect(filtered).toContain("Individual models:");
    expect(filtered).toContain(`${one.manufacturer} ${one.name}`);
  });

  it("does not repeat a model whose whole line is already named", () => {
    const filtered = buildChatSystemPromptBase(HIDDEN);
    expect(filtered).toContain(`Entire lines: ${HIDDEN_BRAND}`);
    expect(filtered).not.toContain("Individual models:");
  });

  it("reports the CARRIED model count, not the catalog's", () => {
    expect(buildChatSystemPromptBase(HIDDEN)).toContain(
      `# Mask catalog (${maskCatalog.length - HIDDEN.size} models`,
    );
  });

  it("is byte-identical to the unfiltered prompt when nothing is hidden", () => {
    expect(buildChatSystemPromptBase(new Set())).toBe(
      buildChatSystemPromptBase(),
    );
  });
});

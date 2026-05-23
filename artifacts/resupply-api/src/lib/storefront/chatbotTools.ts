/**
 * Tool descriptors and dispatcher for the storefront chatbot.
 *
 * PennBot can call these tools via OpenAI function calling so it can
 * actually run the recommendation engine and filter the catalog
 * instead of just narrating from its system-prompt knowledge. Three
 * tools today:
 *
 *   - `recommend_masks(preferences)` runs the same scoring engine
 *     the on-device fitter uses, with the patient's stated
 *     preferences as questionnaire answers. We synthesize neutral
 *     median measurements so the engine doesn't exclude masks on
 *     size grounds — without a face scan we don't have real
 *     measurements, and the fit-score component would be uniform
 *     anyway. Type-weighted scoring + contraindications carry the
 *     ranking.
 *   - `find_masks(criteria)` filters the catalog by type, price
 *     tier, manufacturer, hose connection, or pressure rating.
 *     Answers questions like "show me three budget nasal masks
 *     compatible with high-pressure therapy".
 *   - `compare_masks(idA, idB)` returns a side-by-side payload for
 *     two named masks. Lets the bot answer "what's the difference
 *     between the AirFit P10 and the Brevida" with structured
 *     fields instead of model-generated guesses.
 *
 * PHI posture: tool args are non-PHI booleans + enums + catalog ids.
 * Tool results are public catalog data. No DB writes, no audit, no
 * patient identity ever flows through this module.
 */

import { z } from "zod";
import {
  recommend,
  type FacialMeasurements,
  type QuestionnaireAnswers,
} from "./recommendationEngine.js";
import { maskCatalog, type MaskEntry } from "../../data/maskCatalog.js";

/** Maximum tool-execution rounds per user turn — defense vs runaway. */
export const MAX_TOOL_ROUNDS = 2;

/** OpenAI tool descriptor shape (subset we actually need). */
export interface OpenAiToolDescriptor {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: false;
    };
  };
}

const recommendArgsSchema = z
  .object({
    mouth_breather: z.boolean().optional(),
    side_or_stomach_sleeper: z.boolean().optional(),
    claustrophobic: z.boolean().optional(),
    wears_glasses: z.boolean().optional(),
    heavy_facial_hair: z.boolean().optional(),
    frequent_congestion: z.boolean().optional(),
    sensitive_skin: z.boolean().optional(),
    silicone_sensitivity: z.boolean().optional(),
    mobility_limitations: z.boolean().optional(),
    cpap_pressure_setting: z
      .enum(["unknown", "low", "medium", "high"])
      .optional(),
    prior_mask_experience: z
      .enum(["none", "nasal", "nasalPillow", "fullFace", "hybrid"])
      .optional(),
    limit: z.number().int().min(1).max(5).optional(),
  })
  .strict();

const findArgsSchema = z
  .object({
    type: z.enum(["fullFace", "nasal", "nasalPillow", "hybrid"]).optional(),
    price_tier: z.enum(["budget", "standard", "premium"]).optional(),
    manufacturer: z.string().min(1).max(64).optional(),
    hose_connection: z.enum(["front", "top"]).optional(),
    min_pressure_rating: z.number().int().min(4).max(40).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

/**
 * `compare_masks` accepts either catalog ids (recommended — exact
 * match, no fuzziness) or human names. The dispatcher tries id
 * first, then case-insensitive substring match against names. Two
 * masks must resolve or we return an error.
 */
const compareArgsSchema = z
  .object({
    mask_a: z.string().min(1).max(64),
    mask_b: z.string().min(1).max(64),
  })
  .strict();

export const CHAT_TOOLS: OpenAiToolDescriptor[] = [
  {
    type: "function",
    function: {
      name: "recommend_masks",
      description:
        "Recommend the best PennPaps masks for a patient based on their stated preferences. Use this when the user asks 'help me pick a mask', 'which mask is best for me', or describes their sleep profile and wants a recommendation. All arguments are optional; pass only the preferences the user has actually stated. Returns a ranked shortlist.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          mouth_breather: {
            type: "boolean",
            description:
              "User breathes through their mouth at night, wakes with dry mouth, or uses a chin strap.",
          },
          side_or_stomach_sleeper: {
            type: "boolean",
            description: "User sleeps on their side or stomach.",
          },
          claustrophobic: {
            type: "boolean",
            description:
              "User feels claustrophobic with masks on their face or large frames.",
          },
          wears_glasses: {
            type: "boolean",
            description:
              "User reads, watches TV, or works with glasses on while in bed.",
          },
          heavy_facial_hair: {
            type: "boolean",
            description: "User has a heavy beard or moustache.",
          },
          frequent_congestion: {
            type: "boolean",
            description:
              "User has chronic nasal congestion, allergies, or a deviated septum.",
          },
          sensitive_skin: {
            type: "boolean",
            description:
              "User gets red marks, irritation, or breakouts from cushion contact.",
          },
          silicone_sensitivity: {
            type: "boolean",
            description: "User has a known reaction to silicone cushions.",
          },
          mobility_limitations: {
            type: "boolean",
            description:
              "User has limited hand/finger dexterity for fitting headgear.",
          },
          cpap_pressure_setting: {
            type: "string",
            enum: ["unknown", "low", "medium", "high"],
            description:
              "Approximate prescribed CPAP pressure (low <8 cmH2O, medium 8-15, high 15+). Default 'unknown'.",
          },
          prior_mask_experience: {
            type: "string",
            enum: ["none", "nasal", "nasalPillow", "fullFace", "hybrid"],
            description:
              "Style the user has tried before, if any. Default 'none'.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description:
              "Maximum recommendations to return. Default 3.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_masks",
      description:
        "Filter the PennPaps mask catalog by structured criteria. Use this when the user wants to BROWSE the catalog with a filter (type, price tier, manufacturer, top-of-head hose, or pressure rating) rather than asking for a tailored recommendation. Returns matching masks; an empty array means no match.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["fullFace", "nasal", "nasalPillow", "hybrid"],
            description: "Mask style.",
          },
          price_tier: {
            type: "string",
            enum: ["budget", "standard", "premium"],
            description: "Price band.",
          },
          manufacturer: {
            type: "string",
            description:
              "Brand name, case-insensitive substring match (e.g. 'ResMed', 'Philips').",
          },
          hose_connection: {
            type: "string",
            enum: ["front", "top"],
            description:
              "'top' for top-of-head hose (DreamWear-style); 'front' for traditional.",
          },
          min_pressure_rating: {
            type: "integer",
            minimum: 4,
            maximum: 40,
            description:
              "Filter to masks rated to at least this pressure (cmH2O). Useful for high-pressure patients.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Maximum results to return. Default 5.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_masks",
      description:
        "Compare two specific PennPaps masks side by side. Use this when the user asks 'what's the difference between X and Y' or 'should I pick A or B?'. Pass each mask by its catalog id (preferred — e.g. 'resmed-airfit-p10') or by name (case-insensitive substring match — e.g. 'P10', 'AirFit F20'). Returns the structured fields for both masks plus a list of meaningful differences.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mask_a", "mask_b"],
        properties: {
          mask_a: {
            type: "string",
            description: "First mask, by catalog id or name.",
          },
          mask_b: {
            type: "string",
            description: "Second mask, by catalog id or name.",
          },
        },
      },
    },
  },
];

/**
 * Median measurements across the catalog's fit ranges, used as a
 * neutral baseline so the recommendation engine doesn't exclude
 * masks on size grounds when we don't have a real face scan.
 * Calibration method is set to "iris" purely to satisfy the type;
 * the engine doesn't branch on it.
 */
const NEUTRAL_MEASUREMENTS: FacialMeasurements = {
  noseWidth: 36,
  noseHeight: 50,
  noseToChin: 65,
  mouthWidth: 50,
  faceWidthAtCheekbones: 140,
  calibrationMethod: "iris",
};

function toQuestionnaireAnswers(
  args: z.infer<typeof recommendArgsSchema>,
): QuestionnaireAnswers {
  // Default missing booleans to NULL, not false. The engine treats
  // `false` as an affirmative negative — e.g. mouthBreather=false
  // unlocks "You breathe through your nose during sleep, making a
  // nasal mask an effective choice" in patient-facing copy. That's
  // wrong when the LLM tool call simply didn't include the field
  // (the patient never mentioned it). The engine's QuestionnaireAnswers
  // type explicitly allows null on every boolean precisely so the
  // ranker can distinguish "no opinion" from "they said no".
  return {
    mouthBreather: args.mouth_breather ?? null,
    claustrophobic: args.claustrophobic ?? null,
    sideOrStomachSleeper: args.side_or_stomach_sleeper ?? null,
    heavyFacialHair: args.heavy_facial_hair ?? null,
    wearsGlasses: args.wears_glasses ?? null,
    frequentCongestion: args.frequent_congestion ?? null,
    priorMaskExperience: args.prior_mask_experience ?? "none",
    mobilityLimitations: args.mobility_limitations ?? null,
    sensitiveSkin: args.sensitive_skin ?? null,
    siliconeSensitivity: args.silicone_sensitivity ?? null,
    cpapPressureSetting: args.cpap_pressure_setting ?? "unknown",
  };
}

interface RecommendToolResultEntry {
  maskId: string;
  name: string;
  manufacturer: string;
  type: MaskEntry["type"];
  priceTier: MaskEntry["priceTier"];
  confidence: number;
  summary: string;
  reasoning: string[];
}

interface FindToolResultEntry {
  maskId: string;
  name: string;
  manufacturer: string;
  type: MaskEntry["type"];
  priceTier: MaskEntry["priceTier"];
  hoseConnection: MaskEntry["hoseConnection"];
  weightGrams: number;
  sizesAvailable: string[];
  bestFor: string[];
  pressureRangeMax: number;
}

interface CompareToolResultMask {
  maskId: string;
  name: string;
  manufacturer: string;
  type: MaskEntry["type"];
  priceTier: MaskEntry["priceTier"];
  hoseConnection: MaskEntry["hoseConnection"];
  weightGrams: number;
  sizesAvailable: string[];
  cushionMaterial: string;
  pressureRangeMin: number;
  pressureRangeMax: number;
  bestFor: string[];
  contraindications: string[];
}

/**
 * Discriminated tool result. `ok: true` carries a JSON-serializable
 * payload we forward back to the model verbatim; `ok: false` carries
 * a short human-readable error the model can surface to the user.
 */
export type ChatToolResult =
  | { ok: true; data: { recommendations: RecommendToolResultEntry[] } }
  | { ok: true; data: { masks: FindToolResultEntry[] } }
  | {
      ok: true;
      data: {
        a: CompareToolResultMask;
        b: CompareToolResultMask;
        differences: string[];
      };
    }
  | { ok: false; error: string };

/** Resolve a user-supplied mask reference (id or substring of name) to a catalog entry. */
function resolveMask(reference: string): MaskEntry | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  const exactById = maskCatalog.find((m) => m.id === trimmed);
  if (exactById) return exactById;
  const lower = trimmed.toLowerCase();
  // Prefer exact-name match before substring to avoid "F20" matching "F20 Pro".
  const exactByName = maskCatalog.find(
    (m) => m.name.toLowerCase() === lower,
  );
  if (exactByName) return exactByName;
  const substring = maskCatalog.find((m) =>
    m.name.toLowerCase().includes(lower),
  );
  return substring ?? null;
}

function summarizeMaskForCompare(m: MaskEntry): CompareToolResultMask {
  return {
    maskId: m.id,
    name: m.name,
    manufacturer: m.manufacturer,
    type: m.type,
    priceTier: m.priceTier,
    hoseConnection: m.hoseConnection,
    weightGrams: m.weightGrams,
    sizesAvailable: m.sizesAvailable,
    cushionMaterial: m.cushionMaterial,
    pressureRangeMin: m.pressureRangeMin,
    pressureRangeMax: m.pressureRangeMax,
    bestFor: m.bestFor,
    contraindications: m.contraindications,
  };
}

/**
 * Walk the comparable fields and produce a short list of meaningful
 * differences as plain-English fragments. We don't enumerate every
 * field — only the ones a patient would care about. Identical fields
 * are dropped so the model gets a concise diff.
 */
function buildDifferences(a: MaskEntry, b: MaskEntry): string[] {
  const diffs: string[] = [];
  if (a.type !== b.type) {
    diffs.push(`${a.name} is a ${a.type} mask; ${b.name} is a ${b.type} mask.`);
  }
  if (a.manufacturer !== b.manufacturer) {
    diffs.push(
      `Made by different brands — ${a.manufacturer} vs. ${b.manufacturer}.`,
    );
  }
  if (a.priceTier !== b.priceTier) {
    diffs.push(`${a.name} is ${a.priceTier} tier; ${b.name} is ${b.priceTier}.`);
  }
  if (a.hoseConnection !== b.hoseConnection) {
    diffs.push(
      `${a.name} uses a ${a.hoseConnection} hose connection; ${b.name} uses ${b.hoseConnection}.`,
    );
  }
  const weightDelta = Math.abs(a.weightGrams - b.weightGrams);
  if (weightDelta >= 10) {
    const lighter = a.weightGrams < b.weightGrams ? a : b;
    const heavier = lighter === a ? b : a;
    diffs.push(
      `${lighter.name} is ${weightDelta} g lighter than ${heavier.name} (${lighter.weightGrams} g vs ${heavier.weightGrams} g).`,
    );
  }
  if (a.pressureRangeMax !== b.pressureRangeMax) {
    diffs.push(
      `Pressure ratings differ: ${a.name} is rated to ${a.pressureRangeMax} cmH2O, ${b.name} to ${b.pressureRangeMax} cmH2O.`,
    );
  }
  if (a.cushionMaterial !== b.cushionMaterial) {
    diffs.push(
      `Cushion materials differ — ${a.name}: ${a.cushionMaterial}; ${b.name}: ${b.cushionMaterial}.`,
    );
  }
  return diffs;
}

/**
 * Execute one tool call from the model. Always returns — never throws —
 * so the chat route's try/catch only has to deal with HTTP failures,
 * not tool errors.
 */
export function executeChatTool(
  name: string,
  rawArgs: unknown,
): ChatToolResult {
  if (name === "recommend_masks") {
    const parsed = recommendArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `recommend_masks: invalid arguments — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const limit = parsed.data.limit ?? 3;
    const result = recommend(
      NEUTRAL_MEASUREMENTS,
      toQuestionnaireAnswers(parsed.data),
    );
    const top = result.topRecommendations.slice(0, limit).map((r) => ({
      maskId: r.maskId,
      name: r.name,
      manufacturer: r.manufacturer,
      type: r.type,
      priceTier:
        maskCatalog.find((m) => m.id === r.maskId)?.priceTier ?? "standard",
      confidence: Math.round(r.confidence * 100) / 100,
      summary: r.summary,
      reasoning: r.reasoning.slice(0, 4),
    }));
    return { ok: true, data: { recommendations: top } };
  }

  if (name === "find_masks") {
    const parsed = findArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `find_masks: invalid arguments — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const a = parsed.data;
    const limit = a.limit ?? 5;
    const manufacturerLower = a.manufacturer?.toLowerCase();
    const filtered = maskCatalog.filter((m) => {
      if (a.type && m.type !== a.type) return false;
      if (a.price_tier && m.priceTier !== a.price_tier) return false;
      if (a.hose_connection && m.hoseConnection !== a.hose_connection)
        return false;
      if (
        manufacturerLower &&
        !m.manufacturer.toLowerCase().includes(manufacturerLower)
      )
        return false;
      if (
        a.min_pressure_rating !== undefined &&
        m.pressureRangeMax < a.min_pressure_rating
      )
        return false;
      return true;
    });
    const masks = filtered.slice(0, limit).map((m) => ({
      maskId: m.id,
      name: m.name,
      manufacturer: m.manufacturer,
      type: m.type,
      priceTier: m.priceTier,
      hoseConnection: m.hoseConnection,
      weightGrams: m.weightGrams,
      sizesAvailable: m.sizesAvailable,
      bestFor: m.bestFor,
      pressureRangeMax: m.pressureRangeMax,
    }));
    return { ok: true, data: { masks } };
  }

  if (name === "compare_masks") {
    const parsed = compareArgsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `compare_masks: invalid arguments — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const a = resolveMask(parsed.data.mask_a);
    const b = resolveMask(parsed.data.mask_b);
    if (!a) {
      return {
        ok: false,
        error: `compare_masks: could not find a mask matching "${parsed.data.mask_a}".`,
      };
    }
    if (!b) {
      return {
        ok: false,
        error: `compare_masks: could not find a mask matching "${parsed.data.mask_b}".`,
      };
    }
    if (a.id === b.id) {
      return {
        ok: false,
        error: "compare_masks: both arguments resolved to the same mask.",
      };
    }
    return {
      ok: true,
      data: {
        a: summarizeMaskForCompare(a),
        b: summarizeMaskForCompare(b),
        differences: buildDifferences(a, b),
      },
    };
  }

  return { ok: false, error: `unknown tool: ${name}` };
}

/**
 * Serialize a tool result for inclusion in the OpenAI tool message.
 * Must be a string; we use compact JSON.
 */
export function serializeToolResult(result: ChatToolResult): string {
  if (result.ok) return JSON.stringify(result.data);
  return JSON.stringify({ error: result.error });
}

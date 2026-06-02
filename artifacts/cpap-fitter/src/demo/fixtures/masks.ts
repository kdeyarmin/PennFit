// Seeded mask catalog + recommendations for the demo fit flow.
// Shapes mirror the generated storefront client
// (MaskEntry / MaskRecommendation / RecommendationResponse).

import type {
  MaskCatalogResponse,
  MaskEntry,
  MaskRecommendation,
  RecommendationResponse,
} from "@workspace/api-client-react/storefront";

export const DEMO_MASKS: MaskEntry[] = [
  {
    id: "demo-mask-n20",
    name: "ResMed AirFit N20",
    modelNumber: "63500",
    manufacturer: "ResMed",
    type: "nasal",
    description:
      "The most-prescribed nasal mask we carry. The InfinitySeal cushion suits a wide range of nose shapes and the magnetic clips make it easy to take on and off.",
    fitRanges: {
      noseWidthMin: 28,
      noseWidthMax: 42,
      noseToChinMin: 95,
      noseToChinMax: 135,
      mouthWidthMin: 40,
      mouthWidthMax: 60,
    },
    features: [
      "InfinitySeal silicone cushion",
      "Magnetic headgear clips",
      "Three cushion sizes",
    ],
    contraindications: ["Frequent mouth-breathing without a chinstrap"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric with magnetic clips",
    hoseConnection: "front",
    weightGrams: 86,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Nose breathers", "Side sleepers", "First-time users"],
    imageUrl: "/products/airfit-n20.webp",
  },
  {
    id: "demo-mask-p10",
    name: "ResMed AirFit P10",
    modelNumber: "62900",
    manufacturer: "ResMed",
    type: "nasalPillow",
    description:
      "An ultra-light nasal-pillow mask with a barely-there feel and the quietest vent in the lineup. A favorite of active sleepers and travelers.",
    fitRanges: {
      noseWidthMin: 26,
      noseWidthMax: 40,
      noseToChinMin: 90,
      noseToChinMax: 130,
      mouthWidthMin: 38,
      mouthWidthMax: 58,
    },
    features: ["QuietAir vent", "Two-point headgear", "Under 60 g"],
    contraindications: ["Pressures above 20 cmH2O", "Mouth-breathing"],
    cushionMaterial: "Silicone",
    headgearStyle: "Two-strap split headgear",
    hoseConnection: "front",
    weightGrams: 53,
    sizesAvailable: ["XS", "S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Light sleepers", "Travelers", "Readers"],
    imageUrl: "/products/airfit-p10.webp",
  },
  {
    id: "demo-mask-f30i",
    name: "ResMed AirFit F30i",
    modelNumber: "64101",
    manufacturer: "ResMed",
    type: "fullFace",
    description:
      "A full-face mask with the tube connected at the top of the head, so you can sleep in any position. The under-the-nose cushion avoids the bridge of the nose.",
    fitRanges: {
      noseWidthMin: 30,
      noseWidthMax: 46,
      noseToChinMin: 100,
      noseToChinMax: 145,
      mouthWidthMin: 42,
      mouthWidthMax: 66,
    },
    features: [
      "Tube-up-top frame",
      "Under-the-nose cushion",
      "QuietAir diffused vent",
    ],
    contraindications: [],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric",
    hoseConnection: "top",
    weightGrams: 98,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 30,
    priceTier: "premium",
    bestFor: ["Mouth breathers", "Higher pressures", "Active sleepers"],
    imageUrl: "/products/airfit-f30i.webp",
  },
  {
    id: "demo-mask-rio2",
    name: "React Health Rio II",
    modelNumber: "RIO2-N",
    manufacturer: "React Health",
    type: "nasal",
    description:
      "A comfortable, budget-friendly nasal mask with a soft cushion and simple clip headgear — a solid value pick.",
    fitRanges: {
      noseWidthMin: 28,
      noseWidthMax: 44,
      noseToChinMin: 95,
      noseToChinMax: 138,
      mouthWidthMin: 40,
      mouthWidthMax: 62,
    },
    features: ["Soft silicone cushion", "Easy-clip headgear", "Lightweight"],
    contraindications: ["Mouth-breathing without a chinstrap"],
    cushionMaterial: "Silicone",
    headgearStyle: "Easy-clip straps",
    hoseConnection: "front",
    weightGrams: 88,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "budget",
    bestFor: ["Budget-conscious", "Nose breathers"],
    imageUrl: "/products/react-health-rio2.webp",
  },
];

export function demoMaskCatalog(): MaskCatalogResponse {
  return { masks: DEMO_MASKS, total: DEMO_MASKS.length };
}

const DEMO_DISCLAIMER =
  "These recommendations are generated from the measurements and answers you provided and are for guidance only. A PennFit specialist will confirm sizing before your order ships. This is a demonstration — no real order is placed.";

export function demoRecommendation(): RecommendationResponse {
  const top: MaskRecommendation[] = [
    {
      maskId: "demo-mask-n20",
      name: "ResMed AirFit N20",
      modelNumber: "63500",
      manufacturer: "ResMed",
      type: "nasal",
      confidence: 0.92,
      summary:
        "A great match for your nose width and breathing style — comfortable, well-sealed, and easy to live with.",
      reasoning: [
        "Your nose-width measurement falls squarely in the N20's Medium cushion range.",
        "You reported breathing mostly through your nose, which suits a nasal mask.",
        "Your prescribed pressure is well within the N20's comfortable range.",
      ],
      features: [
        "InfinitySeal cushion adapts to your face",
        "Magnetic clips for easy on/off",
        "Quiet, diffused venting",
      ],
      contraindications: [],
      imageUrl: "/products/airfit-n20.webp",
      recommendedSize: "M",
      sizeRationale:
        "Your nose width of ~36 mm maps to the Medium cushion for the best seal.",
    },
    {
      maskId: "demo-mask-p10",
      name: "ResMed AirFit P10",
      modelNumber: "62900",
      manufacturer: "ResMed",
      type: "nasalPillow",
      confidence: 0.81,
      summary:
        "A featherweight nasal-pillow option if you'd prefer the least amount of mask on your face.",
      reasoning: [
        "You indicated you're a light sleeper — the P10 is the quietest mask we carry.",
        "Nasal-pillow seals work well at your pressure setting.",
      ],
      features: ["Under 60 g", "QuietAir vent", "Minimal facial contact"],
      contraindications: ["Not ideal if you mouth-breathe"],
      imageUrl: "/products/airfit-p10.webp",
      recommendedSize: "M",
      sizeRationale:
        "Medium pillows match your measured nostril spacing most closely.",
    },
    {
      maskId: "demo-mask-rio2",
      name: "React Health Rio II",
      modelNumber: "RIO2-N",
      manufacturer: "React Health",
      type: "nasal",
      confidence: 0.74,
      summary:
        "A comfortable, budget-friendly nasal mask that still fits your measurements well.",
      reasoning: [
        "Fits your measured nose width.",
        "A good value alternative to the N20.",
      ],
      features: ["Soft cushion", "Simple clip headgear", "Lower price"],
      contraindications: [],
      imageUrl: "/products/react-health-rio2.webp",
      recommendedSize: "M",
      sizeRationale: "Medium covers your nose-width range with margin.",
    },
  ];

  const alternatives: MaskRecommendation[] = [
    {
      maskId: "demo-mask-f30i",
      name: "ResMed AirFit F30i",
      modelNumber: "64101",
      manufacturer: "ResMed",
      type: "fullFace",
      confidence: 0.63,
      summary:
        "If you find yourself opening your mouth at night, this full-face option keeps therapy effective.",
      reasoning: [
        "Full-face coverage handles mouth-breathing.",
        "Tube-up-top design lets you sleep in any position.",
      ],
      features: ["Tube-up-top frame", "Under-the-nose cushion"],
      contraindications: [],
      imageUrl: "/products/airfit-f30i.webp",
      recommendedSize: "M",
      sizeRationale: "Medium frame fits your nose-to-chin measurement.",
    },
  ];

  return { topRecommendations: top, alternatives, disclaimer: DEMO_DISCLAIMER };
}

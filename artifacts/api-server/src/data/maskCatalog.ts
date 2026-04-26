/**
 * CPAP Mask Catalog — Seed Data
 *
 * Uses real product names from ResMed AirFit, Philips DreamWear, and Fisher & Paykel
 * Brevida lines as representative examples. Replace with actual inventory and
 * manufacturer-provided fit ranges before production use.
 *
 * Fit range dimensions are in millimeters (mm).
 * Sources:
 *   - ResMed AirFit specifications: https://www.resmed.com/en-us/sleep-apnea/cpap-parts-support/masks/
 *   - Philips DreamWear specifications: https://www.philips.com/c-p/HH1097_00/dreamwear-full-face-mask
 *   - Fisher & Paykel product guides: https://www.fphcare.com/en-us/hospital/adult-respiratory/nasal-high-flow/
 *   - Manufacturer fitting guides and DME clinical practice notes
 *
 * Contraindication references:
 *   - AASM clinical guidelines on PAP therapy mask selection
 *   - Individual manufacturer fitting instructions
 */

export type MaskType = "fullFace" | "nasal" | "nasalPillow" | "hybrid";

export interface FitRanges {
  noseWidthMin: number;
  noseWidthMax: number;
  noseToChinMin: number;
  noseToChinMax: number;
  mouthWidthMin: number;
  mouthWidthMax: number;
}

export interface MaskEntry {
  id: string;
  name: string;
  manufacturer: string;
  type: MaskType;
  fitRanges: FitRanges;
  features: string[];
  contraindications: string[];
  imageUrl: string | null;
}

export const maskCatalog: MaskEntry[] = [
  // ── FULL FACE MASKS ──────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-f20",
    name: "AirFit F20",
    manufacturer: "ResMed",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 28,
      noseWidthMax: 44,
      noseToChinMin: 55,
      noseToChinMax: 80,
      mouthWidthMin: 42,
      mouthWidthMax: 60,
    },
    features: [
      "Magnetic clips for easy removal",
      "Plush cushion with InfinitySeal silicone",
      "Available in XS, S, M, LW (Large Wide)",
      "Fits wider range of face shapes",
    ],
    contraindications: [
      "Heavy facial hair (poor seal)",
      "Claustrophobia",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-f30",
    name: "AirFit F30",
    manufacturer: "ResMed",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 26,
      noseWidthMax: 40,
      noseToChinMin: 52,
      noseToChinMax: 76,
      mouthWidthMin: 38,
      mouthWidthMax: 56,
    },
    features: [
      "Under-nose cushion (minimal contact)",
      "Open line of sight — compatible with glasses",
      "Lightweight minimal design",
      "Good for mouth breathers who feel claustrophobic",
    ],
    contraindications: [
      "Heavy facial hair",
      "Very narrow or protruding nose bridge",
    ],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-ff",
    name: "DreamWear Full Face",
    manufacturer: "Philips",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 27,
      noseWidthMax: 42,
      noseToChinMin: 53,
      noseToChinMax: 78,
      mouthWidthMin: 40,
      mouthWidthMax: 58,
    },
    features: [
      "Top-of-head hose connection (360° rotation)",
      "Gel cushion for sensitive skin",
      "Compatible with glasses",
      "Minimal facial contact points",
    ],
    contraindications: [
      "Heavy facial hair",
      "Claustrophobia",
    ],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-vitera",
    name: "Vitera Full Face",
    manufacturer: "Fisher & Paykel",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 29,
      noseWidthMax: 45,
      noseToChinMin: 56,
      noseToChinMax: 82,
      mouthWidthMin: 43,
      mouthWidthMax: 62,
    },
    features: [
      "RollFit seal adapts to movement",
      "VentiCool technology reduces CO2 rebreathing",
      "Soft foam headgear",
      "Excellent for active sleepers",
    ],
    contraindications: [
      "Heavy facial hair",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-f40",
    name: "AirFit F40",
    manufacturer: "ResMed",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 25,
      noseWidthMax: 38,
      noseToChinMin: 50,
      noseToChinMax: 74,
      mouthWidthMin: 36,
      mouthWidthMax: 54,
    },
    features: [
      "Minimal contact under-nose design",
      "Flat on face for side sleepers",
      "Flexible frame adapts to face",
      "QuietAir elbow reduces noise",
    ],
    contraindications: [
      "Very heavy beard",
    ],
    imageUrl: null,
  },

  // ── NASAL MASKS ───────────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-n20",
    name: "AirFit N20",
    manufacturer: "ResMed",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 26,
      noseWidthMax: 40,
      noseToChinMin: 45,
      noseToChinMax: 72,
      mouthWidthMin: 35,
      mouthWidthMax: 56,
    },
    features: [
      "Soft InfinitySeal cushion",
      "Available in XS, S, M, LW",
      "Stable headgear with easy adjustment",
      "Good for nasal breathing",
    ],
    contraindications: [
      "Mouth breathers (without chin strap)",
      "Severe nasal congestion",
      "Heavy facial hair at nose-to-lip region",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-n30",
    name: "AirFit N30",
    manufacturer: "ResMed",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 24,
      noseWidthMax: 38,
      noseToChinMin: 42,
      noseToChinMax: 68,
      mouthWidthMin: 33,
      mouthWidthMax: 52,
    },
    features: [
      "Cradle cushion fits under nose",
      "Open view — compatible with glasses",
      "Lightweight and minimal",
      "Good for side and stomach sleepers",
    ],
    contraindications: [
      "Mouth breathers",
      "Very wide or flat nose bridge",
    ],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-nasal",
    name: "DreamWear Nasal",
    manufacturer: "Philips",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 25,
      noseWidthMax: 39,
      noseToChinMin: 43,
      noseToChinMax: 70,
      mouthWidthMin: 34,
      mouthWidthMax: 54,
    },
    features: [
      "Under-nose cushion with nasal hood",
      "Top-of-head hose connection",
      "Side sleeping friendly",
      "Gel and silicone cushion options",
    ],
    contraindications: [
      "Mouth breathers without chin strap",
      "Nasal polyps or deviated septum",
    ],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-eson2",
    name: "Eson 2 Nasal",
    manufacturer: "Fisher & Paykel",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 27,
      noseWidthMax: 41,
      noseToChinMin: 44,
      noseToChinMax: 71,
      mouthWidthMin: 36,
      mouthWidthMax: 55,
    },
    features: [
      "RollFit seal follows head movement",
      "Diffused vent reduces noise",
      "Flexible frame",
      "Good for restless sleepers",
    ],
    contraindications: [
      "Mouth breathers",
      "Chronic sinusitis",
    ],
    imageUrl: null,
  },

  // ── NASAL PILLOW MASKS ────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-p10",
    name: "AirFit P10",
    manufacturer: "ResMed",
    type: "nasalPillow",
    fitRanges: {
      noseWidthMin: 22,
      noseWidthMax: 36,
      noseToChinMin: 38,
      noseToChinMax: 65,
      mouthWidthMin: 30,
      mouthWidthMax: 50,
    },
    features: [
      "Ultra-lightweight (42g)",
      "QuietAir woven vent — whisper quiet",
      "XS/S/M pillow sizes",
      "Minimal facial contact",
      "Excellent for claustrophobic patients",
    ],
    contraindications: [
      "Mouth breathers",
      "High CPAP pressures above 15 cmH₂O (may cause air leak)",
      "Nasal septum deviation affecting airflow",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-p10-for-her",
    name: "AirFit P10 For Her",
    manufacturer: "ResMed",
    type: "nasalPillow",
    fitRanges: {
      noseWidthMin: 20,
      noseWidthMax: 32,
      noseToChinMin: 36,
      noseToChinMax: 60,
      mouthWidthMin: 28,
      mouthWidthMax: 46,
    },
    features: [
      "Smaller pillow sizes for narrower nasal passages",
      "Soft lavender headgear",
      "Ultra-lightweight",
      "For patients with smaller facial features",
    ],
    contraindications: [
      "Mouth breathers",
      "High pressures above 15 cmH₂O",
    ],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-brevida",
    name: "Brevida Nasal Pillow",
    manufacturer: "Fisher & Paykel",
    type: "nasalPillow",
    fitRanges: {
      noseWidthMin: 21,
      noseWidthMax: 35,
      noseToChinMin: 37,
      noseToChinMax: 63,
      mouthWidthMin: 29,
      mouthWidthMax: 49,
    },
    features: [
      "AirPillow seal self-adjusts under pressure",
      "Extra-soft headgear",
      "S/M and M/L sizes",
      "Low profile — great for side sleepers",
    ],
    contraindications: [
      "Mouth breathers",
      "Severe nasal obstruction",
    ],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-np",
    name: "DreamWear Nasal Pillow",
    manufacturer: "Philips",
    type: "nasalPillow",
    fitRanges: {
      noseWidthMin: 22,
      noseWidthMax: 36,
      noseToChinMin: 38,
      noseToChinMax: 65,
      mouthWidthMin: 30,
      mouthWidthMax: 50,
    },
    features: [
      "Top-of-head hose prevents tangling",
      "Open field of vision",
      "Compatible with glasses",
      "Four pillow sizes (XS, S, M, L)",
    ],
    contraindications: [
      "Mouth breathers",
      "High pressures",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-airtouch-n20",
    name: "AirTouch N20",
    manufacturer: "ResMed",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 26,
      noseWidthMax: 40,
      noseToChinMin: 43,
      noseToChinMax: 70,
      mouthWidthMin: 34,
      mouthWidthMax: 54,
    },
    features: [
      "UltraSoft memory foam cushion",
      "No nightly washing required",
      "Replace cushion weekly",
      "Excellent for sensitive skin",
    ],
    contraindications: [
      "Mouth breathers",
      "Silicone allergy (check foam material)",
    ],
    imageUrl: null,
  },

  // ── HYBRID MASKS ──────────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-f30i",
    name: "AirFit F30i",
    manufacturer: "ResMed",
    type: "hybrid",
    fitRanges: {
      noseWidthMin: 24,
      noseWidthMax: 39,
      noseToChinMin: 48,
      noseToChinMax: 74,
      mouthWidthMin: 36,
      mouthWidthMax: 55,
    },
    features: [
      "Top-of-head tube connection",
      "Frame rests on upper lip and forehead",
      "Nasal pillows + mouth coverage",
      "Great for active and side sleepers",
    ],
    contraindications: [
      "Heavy beard interfering with seal",
    ],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-ff-gel",
    name: "DreamWear Full Face Gel",
    manufacturer: "Philips",
    type: "hybrid",
    fitRanges: {
      noseWidthMin: 26,
      noseWidthMax: 41,
      noseToChinMin: 50,
      noseToChinMax: 76,
      mouthWidthMin: 38,
      mouthWidthMax: 57,
    },
    features: [
      "Soft gel cushion for sensitive skin",
      "Top-of-head hose",
      "Covers nose and mouth with minimal contact",
      "Silicone-free gel — good for silicone sensitivity",
    ],
    contraindications: [
      "Heavy beard",
    ],
    imageUrl: null,
  },
  {
    id: "bleep-dreamport",
    name: "DreamPort Solution",
    manufacturer: "Bleep Sleep",
    type: "nasalPillow",
    fitRanges: {
      noseWidthMin: 21,
      noseWidthMax: 37,
      noseToChinMin: 36,
      noseToChinMax: 64,
      mouthWidthMin: 28,
      mouthWidthMax: 50,
    },
    features: [
      "Adhesive ports — no headgear straps",
      "Ultra-minimal design",
      "Side sleeping friendly",
      "Good for patients who find straps uncomfortable",
    ],
    contraindications: [
      "Sensitive skin reactions to adhesive",
      "Mouth breathers",
    ],
    imageUrl: null,
  },
  {
    id: "resmed-mirage-fx",
    name: "Mirage FX Nasal",
    manufacturer: "ResMed",
    type: "nasal",
    fitRanges: {
      noseWidthMin: 28,
      noseWidthMax: 44,
      noseToChinMin: 46,
      noseToChinMax: 73,
      mouthWidthMin: 37,
      mouthWidthMax: 57,
    },
    features: [
      "Spring air cushion for gentle seal",
      "Adjustable forehead support",
      "Straightforward fit",
      "Suitable for higher pressures",
    ],
    contraindications: [
      "Mouth breathers",
      "Chronic congestion",
    ],
    imageUrl: null,
  },
  {
    id: "philips-amara-view",
    name: "Amara View Full Face",
    manufacturer: "Philips",
    type: "fullFace",
    fitRanges: {
      noseWidthMin: 30,
      noseWidthMax: 46,
      noseToChinMin: 58,
      noseToChinMax: 84,
      mouthWidthMin: 44,
      mouthWidthMax: 63,
    },
    features: [
      "Under-chin cushion — nothing over nose bridge",
      "Full open field of vision",
      "Good for glasses wearers",
      "Suitable for mouth breathers with wider faces",
    ],
    contraindications: [
      "Very heavy beard",
      "Claustrophobia",
    ],
    imageUrl: null,
  },
];

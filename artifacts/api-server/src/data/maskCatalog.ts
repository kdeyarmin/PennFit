/**
 * CPAP Mask Catalog — Seed Data for Penn Home Medical Supply
 *
 * Uses real product names from ResMed AirFit, Philips DreamWear, Fisher & Paykel
 * Brevida and Bleep Sleep lines as representative examples. Replace with actual
 * Penn Home Medical Supply inventory and manufacturer-provided fit ranges before
 * production use.
 *
 * Fit range dimensions are in millimeters (mm).
 * Pressure ranges are in cmH2O (centimeters of water).
 * Weight is in grams (g).
 *
 * Sources:
 *   - ResMed AirFit specifications
 *   - Philips DreamWear specifications
 *   - Fisher & Paykel product guides
 *   - Manufacturer fitting guides and DME clinical practice notes
 */

export type MaskType = "fullFace" | "nasal" | "nasalPillow" | "hybrid";
export type HoseConnection = "front" | "top";
export type PriceTier = "budget" | "standard" | "premium";

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
  description: string;
  fitRanges: FitRanges;
  features: string[];
  contraindications: string[];
  cushionMaterial: string;
  headgearStyle: string;
  hoseConnection: HoseConnection;
  weightGrams: number;
  sizesAvailable: string[];
  pressureRangeMin: number;
  pressureRangeMax: number;
  priceTier: PriceTier;
  bestFor: string[];
  imageUrl: string | null;
}

export const maskCatalog: MaskEntry[] = [
  // ── FULL FACE MASKS ──────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-f20",
    name: "AirFit F20",
    manufacturer: "ResMed",
    type: "fullFace",
    description:
      "ResMed's flagship full face mask featuring an InfinitySeal silicone cushion that adapts to a wide range of face shapes. Magnetic clips make it easy to put on and take off, even in the dark.",
    fitRanges: { noseWidthMin: 28, noseWidthMax: 44, noseToChinMin: 55, noseToChinMax: 80, mouthWidthMin: 42, mouthWidthMax: 60 },
    features: [
      "Magnetic clips for easy removal",
      "Plush InfinitySeal silicone cushion",
      "Fits a wide range of face shapes",
      "Quiet diffuser exhalation vent",
    ],
    contraindications: ["Heavy facial hair (poor seal)", "Claustrophobia"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric with magnetic clips",
    hoseConnection: "front",
    weightGrams: 124,
    sizesAvailable: ["XS", "S", "M", "L", "LW (Large Wide)"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Mouth breathers", "Higher pressures", "Side sleepers"],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-f30",
    name: "AirFit F30",
    manufacturer: "ResMed",
    type: "fullFace",
    description:
      "A compact under-the-nose full face mask that keeps your line of sight clear so you can read or watch TV with glasses on. The minimal frame is great for patients who feel claustrophobic.",
    fitRanges: { noseWidthMin: 26, noseWidthMax: 40, noseToChinMin: 52, noseToChinMax: 76, mouthWidthMin: 38, mouthWidthMax: 56 },
    features: [
      "Under-nose cushion (minimal contact)",
      "Open line of sight — compatible with glasses",
      "Lightweight minimal design",
      "QuickFit headgear straps",
    ],
    contraindications: ["Heavy facial hair", "Very narrow or protruding nose bridge"],
    cushionMaterial: "Silicone",
    headgearStyle: "QuickFit elastic straps",
    hoseConnection: "front",
    weightGrams: 98,
    sizesAvailable: ["S", "M", "Wide-S", "Wide-M"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Glasses wearers", "Claustrophobic patients", "Mouth breathers"],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-ff",
    name: "DreamWear Full Face",
    manufacturer: "Philips Respironics",
    type: "fullFace",
    description:
      "Innovative full face mask with a top-of-head hose connection that gives you 360° freedom of movement. The soft silicone frame channels air down the sides, eliminating the bulky front tube.",
    fitRanges: { noseWidthMin: 27, noseWidthMax: 42, noseToChinMin: 53, noseToChinMax: 78, mouthWidthMin: 40, mouthWidthMax: 58 },
    features: [
      "Top-of-head hose connection (360° rotation)",
      "Soft silicone frame channels air down the sides",
      "Compatible with glasses",
      "Minimal facial contact points",
    ],
    contraindications: ["Heavy facial hair", "Claustrophobia"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric wrap",
    hoseConnection: "top",
    weightGrams: 110,
    sizesAvailable: ["S", "M", "MW (Medium Wide)", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Active sleepers", "Patients who toss and turn", "Glasses wearers"],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-vitera",
    name: "Vitera Full Face",
    manufacturer: "Fisher & Paykel",
    type: "fullFace",
    description:
      "Premium full face mask featuring RollFit XT seal technology that rolls and adjusts as you move. VentiCool venting reduces noise and CO2 rebreathing for a cooler, fresher therapy experience.",
    fitRanges: { noseWidthMin: 29, noseWidthMax: 45, noseToChinMin: 56, noseToChinMax: 82, mouthWidthMin: 43, mouthWidthMax: 62 },
    features: [
      "RollFit XT seal adapts to movement",
      "VentiCool reduces CO2 rebreathing and noise",
      "Soft foam-lined headgear",
      "Excellent for active sleepers",
    ],
    contraindications: ["Heavy facial hair"],
    cushionMaterial: "Silicone with foam-lined seal",
    headgearStyle: "Foam-lined breathable fabric",
    hoseConnection: "front",
    weightGrams: 130,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Active sleepers", "Side sleepers", "Patients with skin sensitivity"],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-f40",
    name: "AirFit F40",
    manufacturer: "ResMed",
    type: "fullFace",
    description:
      "ResMed's most compact full face mask. The minimal under-nose design lies flat on the face — perfect for side sleepers — while the QuietAir vent makes it one of the quietest masks available.",
    fitRanges: { noseWidthMin: 25, noseWidthMax: 38, noseToChinMin: 50, noseToChinMax: 74, mouthWidthMin: 36, mouthWidthMax: 54 },
    features: [
      "Minimal under-nose design",
      "Lies flat on face for side sleepers",
      "Flexible frame adapts to face shape",
      "QuietAir elbow reduces noise",
    ],
    contraindications: ["Very heavy beard"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft adjustable straps",
    hoseConnection: "front",
    weightGrams: 88,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Side sleepers", "Light sleepers", "Bed partners sensitive to noise"],
    imageUrl: null,
  },

  // ── NASAL MASKS ───────────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-n20",
    name: "AirFit N20",
    manufacturer: "ResMed",
    type: "nasal",
    description:
      "ResMed's best-selling nasal mask. The InfinitySeal silicone cushion provides a stable seal across a wide range of nose shapes, while the soft headgear adjusts easily even with one hand.",
    fitRanges: { noseWidthMin: 26, noseWidthMax: 40, noseToChinMin: 45, noseToChinMax: 72, mouthWidthMin: 35, mouthWidthMax: 56 },
    features: [
      "Soft InfinitySeal silicone cushion",
      "Stable headgear with easy one-handed adjustment",
      "Quiet diffuser vent",
      "Suitable for higher pressures",
    ],
    contraindications: ["Mouth breathers (without chin strap)", "Severe nasal congestion", "Heavy facial hair at nose-to-lip region"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric with magnetic clips",
    hoseConnection: "front",
    weightGrams: 90,
    sizesAvailable: ["XS", "S", "M", "LW (Large Wide)"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "standard",
    bestFor: ["Nasal breathers", "First-time CPAP users", "Higher pressures"],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-n30",
    name: "AirFit N30",
    manufacturer: "ResMed",
    type: "nasal",
    description:
      "An ultra-compact nasal cradle mask that sits below the nose instead of over it. Eliminates red marks on the bridge of the nose and gives you a wide-open field of view.",
    fitRanges: { noseWidthMin: 24, noseWidthMax: 38, noseToChinMin: 42, noseToChinMax: 68, mouthWidthMin: 33, mouthWidthMax: 52 },
    features: [
      "Cradle cushion fits under the nose",
      "Open view — compatible with glasses",
      "Lightweight and minimal contact",
      "Good for side and stomach sleepers",
    ],
    contraindications: ["Mouth breathers", "Very wide or flat nose bridge"],
    cushionMaterial: "Silicone",
    headgearStyle: "Slim fabric straps",
    hoseConnection: "front",
    weightGrams: 71,
    sizesAvailable: ["S", "M", "Wide-S", "Wide-M"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Side sleepers", "Stomach sleepers", "Patients with bridge sensitivity"],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-nasal",
    name: "DreamWear Nasal",
    manufacturer: "Philips Respironics",
    type: "nasal",
    description:
      "Comfortable nasal mask with the signature DreamWear top-of-head hose. The under-nose cushion stays put without the bulk of a traditional nasal mask, making it ideal for restless sleepers.",
    fitRanges: { noseWidthMin: 25, noseWidthMax: 39, noseToChinMin: 43, noseToChinMax: 70, mouthWidthMin: 34, mouthWidthMax: 54 },
    features: [
      "Under-nose cushion with nasal hood",
      "Top-of-head hose connection",
      "Side-sleeping friendly",
      "Frame swaps with other DreamWear cushions",
    ],
    contraindications: ["Mouth breathers without chin strap", "Nasal polyps or deviated septum"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric wrap",
    hoseConnection: "top",
    weightGrams: 95,
    sizesAvailable: ["S", "M", "MW", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Active sleepers", "Patients who toss and turn", "Glasses wearers"],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-eson2",
    name: "Eson 2 Nasal",
    manufacturer: "Fisher & Paykel",
    type: "nasal",
    description:
      "Ergonomic nasal mask designed around the natural movement of your head. The RollFit seal pivots with you, and the diffused exhalation vent keeps things quiet for your bed partner.",
    fitRanges: { noseWidthMin: 27, noseWidthMax: 41, noseToChinMin: 44, noseToChinMax: 71, mouthWidthMin: 36, mouthWidthMax: 55 },
    features: [
      "RollFit seal follows head movement",
      "Diffused vent for quiet operation",
      "Flexible frame",
      "Easy two-clip headgear",
    ],
    contraindications: ["Mouth breathers", "Chronic sinusitis"],
    cushionMaterial: "Silicone",
    headgearStyle: "Stretch fabric with side clips",
    hoseConnection: "front",
    weightGrams: 102,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "standard",
    bestFor: ["Restless sleepers", "Nasal breathers", "Patients seeking quiet operation"],
    imageUrl: null,
  },
  {
    id: "resmed-airtouch-n20",
    name: "AirTouch N20",
    manufacturer: "ResMed",
    type: "nasal",
    description:
      "Memory foam version of the N20. The UltraSoft cushion molds to your face for a luxurious feel — ideal for sensitive skin or patients who get red marks from silicone. Replace the cushion weekly.",
    fitRanges: { noseWidthMin: 26, noseWidthMax: 40, noseToChinMin: 43, noseToChinMax: 70, mouthWidthMin: 34, mouthWidthMax: 54 },
    features: [
      "UltraSoft memory foam cushion",
      "Molds to unique facial contours",
      "No nightly washing required",
      "Replace cushion weekly",
    ],
    contraindications: ["Mouth breathers", "Allergy to foam material"],
    cushionMaterial: "Memory foam",
    headgearStyle: "Soft fabric with magnetic clips",
    hoseConnection: "front",
    weightGrams: 95,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Sensitive skin", "Patients with red marks from silicone", "Comfort seekers"],
    imageUrl: null,
  },
  {
    id: "resmed-mirage-fx",
    name: "Mirage FX Nasal",
    manufacturer: "ResMed",
    type: "nasal",
    description:
      "A reliable, simply-designed nasal mask with a dual-wall Spring Air cushion that flexes for a gentle seal. Adjustable forehead support makes initial fitting straightforward.",
    fitRanges: { noseWidthMin: 28, noseWidthMax: 44, noseToChinMin: 46, noseToChinMax: 73, mouthWidthMin: 37, mouthWidthMax: 57 },
    features: [
      "Spring Air dual-wall cushion",
      "Adjustable forehead support",
      "Straightforward fitting",
      "Suitable for higher pressures",
    ],
    contraindications: ["Mouth breathers", "Chronic congestion"],
    cushionMaterial: "Silicone",
    headgearStyle: "Standard fabric straps",
    hoseConnection: "front",
    weightGrams: 108,
    sizesAvailable: ["Standard", "Wide"],
    pressureRangeMin: 4,
    pressureRangeMax: 30,
    priceTier: "budget",
    bestFor: ["Higher pressures", "Patients on a budget", "Standard nasal anatomy"],
    imageUrl: null,
  },

  // ── NASAL PILLOW MASKS ────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-p10",
    name: "AirFit P10",
    manufacturer: "ResMed",
    type: "nasalPillow",
    description:
      "ResMed's iconic ultra-light nasal pillow mask. At just 42g it's almost unnoticeable, and the QuietAir woven vent is whisper-quiet. A favorite for first-time CPAP users.",
    fitRanges: { noseWidthMin: 22, noseWidthMax: 36, noseToChinMin: 38, noseToChinMax: 65, mouthWidthMin: 30, mouthWidthMax: 50 },
    features: [
      "Ultra-lightweight at just 42 g",
      "QuietAir woven vent — whisper quiet",
      "Dual-wall pillows for stable seal",
      "Minimal facial contact",
    ],
    contraindications: ["Mouth breathers", "High CPAP pressures above 15 cmH₂O may cause leaks", "Severe nasal septum deviation"],
    cushionMaterial: "Silicone (dual-wall pillows)",
    headgearStyle: "Split-strap design (no rear panel)",
    hoseConnection: "front",
    weightGrams: 42,
    sizesAvailable: ["XS", "S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["First-time users", "Claustrophobic patients", "Side sleepers", "Glasses wearers"],
    imageUrl: null,
  },
  {
    id: "resmed-airfit-p10-for-her",
    name: "AirFit P10 For Her",
    manufacturer: "ResMed",
    type: "nasalPillow",
    description:
      "The P10 designed for women, with smaller pillow sizes calibrated for narrower nasal passages and softer, lavender-accented fabric headgear.",
    fitRanges: { noseWidthMin: 20, noseWidthMax: 32, noseToChinMin: 36, noseToChinMax: 60, mouthWidthMin: 28, mouthWidthMax: 46 },
    features: [
      "Smaller pillow sizes for narrower nasal passages",
      "Soft lavender-accented headgear",
      "Ultra-lightweight",
      "Same QuietAir vent as standard P10",
    ],
    contraindications: ["Mouth breathers", "High pressures above 15 cmH₂O"],
    cushionMaterial: "Silicone (dual-wall pillows)",
    headgearStyle: "Lavender split-strap design",
    hoseConnection: "front",
    weightGrams: 42,
    sizesAvailable: ["XS", "S", "M"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Women with smaller features", "Petite patients", "Claustrophobic users"],
    imageUrl: null,
  },
  {
    id: "fisher-paykel-brevida",
    name: "Brevida Nasal Pillow",
    manufacturer: "Fisher & Paykel",
    type: "nasalPillow",
    description:
      "Compact nasal pillow mask featuring an AirPillow seal that gently inflates under therapy pressure for a soft, leak-free fit. Two cushion sizes cover most patients.",
    fitRanges: { noseWidthMin: 21, noseWidthMax: 35, noseToChinMin: 37, noseToChinMax: 63, mouthWidthMin: 29, mouthWidthMax: 49 },
    features: [
      "AirPillow seal self-adjusts under pressure",
      "Extra-soft VisiBlue headgear",
      "Low profile — great for side sleepers",
      "Fewer sizes simplify fitting",
    ],
    contraindications: ["Mouth breathers", "Severe nasal obstruction"],
    cushionMaterial: "Silicone (AirPillow inflatable seal)",
    headgearStyle: "VisiBlue stretch fabric",
    hoseConnection: "front",
    weightGrams: 58,
    sizesAvailable: ["XS/S", "M/L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "standard",
    bestFor: ["Side sleepers", "Patients new to pillows", "Simple fitting"],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-np",
    name: "DreamWear Nasal Pillow",
    manufacturer: "Philips Respironics",
    type: "nasalPillow",
    description:
      "Combines DreamWear's signature top-of-head hose design with comfortable silicone nasal pillows. The hollow soft frame channels air down the sides for a lightweight, unrestricted feel.",
    fitRanges: { noseWidthMin: 22, noseWidthMax: 36, noseToChinMin: 38, noseToChinMax: 65, mouthWidthMin: 30, mouthWidthMax: 50 },
    features: [
      "Top-of-head hose prevents tangling",
      "Open field of vision",
      "Compatible with glasses",
      "Frame swaps with other DreamWear cushions",
    ],
    contraindications: ["Mouth breathers", "High pressures"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric wrap",
    hoseConnection: "top",
    weightGrams: 84,
    sizesAvailable: ["XS", "S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: ["Restless sleepers", "Glasses wearers", "Active sleepers"],
    imageUrl: null,
  },
  {
    id: "bleep-dreamport",
    name: "DreamPort Solution",
    manufacturer: "Bleep Sleep",
    type: "nasalPillow",
    description:
      "A radical redesign that uses gentle adhesive ports instead of headgear straps. No marks on your face, no pressure on your head, and you can sleep in any position you like.",
    fitRanges: { noseWidthMin: 21, noseWidthMax: 37, noseToChinMin: 36, noseToChinMax: 64, mouthWidthMin: 28, mouthWidthMax: 50 },
    features: [
      "Adhesive ports — no headgear straps",
      "Ultra-minimal design",
      "Side and stomach sleeping friendly",
      "No straps means no pressure marks",
    ],
    contraindications: ["Sensitive skin reactions to adhesive", "Mouth breathers"],
    cushionMaterial: "Silicone with adhesive ports",
    headgearStyle: "None — adhesive only",
    hoseConnection: "front",
    weightGrams: 30,
    sizesAvailable: ["One size with adjustable ports"],
    pressureRangeMin: 4,
    pressureRangeMax: 18,
    priceTier: "premium",
    bestFor: ["Patients who hate headgear", "Stomach sleepers", "Travelers"],
    imageUrl: null,
  },

  // ── HYBRID MASKS ──────────────────────────────────────────────────────────────
  {
    id: "resmed-airfit-f30i",
    name: "AirFit F30i",
    manufacturer: "ResMed",
    type: "hybrid",
    description:
      "Hybrid full-face mask with a top-of-head tube connection. Combines under-nose cushion with mouth coverage so mouth breathers can sleep on their side without dislodging the hose.",
    fitRanges: { noseWidthMin: 24, noseWidthMax: 39, noseToChinMin: 48, noseToChinMax: 74, mouthWidthMin: 36, mouthWidthMax: 55 },
    features: [
      "Top-of-head tube connection",
      "Under-nose cushion + mouth coverage",
      "Frame channels air down the sides",
      "Great for active and side sleepers",
    ],
    contraindications: ["Heavy beard interfering with seal"],
    cushionMaterial: "Silicone",
    headgearStyle: "Soft fabric with magnetic clips",
    hoseConnection: "top",
    weightGrams: 122,
    sizesAvailable: ["S", "M", "L", "Wide-S", "Wide-M", "Wide-L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Mouth breathers who toss and turn", "Side sleepers", "Patients who feel claustrophobic in traditional FF"],
    imageUrl: null,
  },
  {
    id: "philips-dreamwear-ff-gel",
    name: "DreamWear Full Face Gel",
    manufacturer: "Philips Respironics",
    type: "hybrid",
    description:
      "Gel-cushioned variant of the DreamWear Full Face for patients with silicone sensitivity. The soft gel conforms gently to the face while the top-of-head hose stays out of the way.",
    fitRanges: { noseWidthMin: 26, noseWidthMax: 41, noseToChinMin: 50, noseToChinMax: 76, mouthWidthMin: 38, mouthWidthMax: 57 },
    features: [
      "Soft gel cushion for sensitive skin",
      "Top-of-head hose connection",
      "Covers nose and mouth with minimal contact",
      "Good alternative for silicone allergies",
    ],
    contraindications: ["Heavy beard"],
    cushionMaterial: "Soft gel",
    headgearStyle: "Soft fabric wrap",
    hoseConnection: "top",
    weightGrams: 118,
    sizesAvailable: ["S", "M", "MW", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "premium",
    bestFor: ["Silicone-sensitive patients", "Side sleepers", "Sensitive facial skin"],
    imageUrl: null,
  },
  {
    id: "philips-amara-view",
    name: "Amara View Full Face",
    manufacturer: "Philips Respironics",
    type: "fullFace",
    description:
      "Under-the-nose full face mask with nothing on the bridge of the nose. The wide-open design is ideal for patients who wear glasses, want to read in bed, or simply hate having something across the nose.",
    fitRanges: { noseWidthMin: 30, noseWidthMax: 46, noseToChinMin: 58, noseToChinMax: 84, mouthWidthMin: 44, mouthWidthMax: 63 },
    features: [
      "Under-nose cushion — nothing over the nose bridge",
      "Full open field of vision",
      "Good for glasses wearers",
      "Suitable for mouth breathers with wider faces",
    ],
    contraindications: ["Very heavy beard", "Claustrophobia"],
    cushionMaterial: "Silicone",
    headgearStyle: "Standard fabric straps",
    hoseConnection: "front",
    weightGrams: 108,
    sizesAvailable: ["S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 25,
    priceTier: "standard",
    bestFor: ["Glasses wearers", "Mouth breathers with wider faces", "Patients who read before sleep"],
    imageUrl: null,
  },
];

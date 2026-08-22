import fullFaceImg from "@/assets/masks/full-face.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";
import hybridImg from "@/assets/masks/hybrid.webp";

export const maskTypeImages: Record<string, string> = {
  fullFace: fullFaceImg,
  nasal: nasalImg,
  nasalPillow: nasalPillowImg,
  hybrid: hybridImg,
};

export const maskTypeLabels: Record<string, string> = {
  fullFace: "Full Face",
  nasal: "Nasal",
  nasalPillow: "Nasal Pillow",
  hybrid: "Hybrid",
};

/**
 * The clinical engine's interface types, mapped onto the legacy asset /
 * label keys. Without this, every clinical candidate fell through both
 * maps: the card showed the FULL-FACE stock photo for a nasal pillow
 * (the `?? fullFaceImg` fallback) and printed the raw enum
 * ("nasal_pillow") as its type.
 */
const CLINICAL_TO_LEGACY: Record<string, string> = {
  full_face: "fullFace",
  total_face: "fullFace",
  nasal: "nasal",
  nasal_cradle: "nasal",
  nasal_pillow: "nasalPillow",
  hybrid: "hybrid",
  oral: "hybrid",
};

export function getMaskImage(type: string): string {
  const key = type in maskTypeImages ? type : CLINICAL_TO_LEGACY[type];
  return maskTypeImages[key ?? ""] ?? fullFaceImg;
}

export function formatMaskType(type: string): string {
  const key = type in maskTypeLabels ? type : CLINICAL_TO_LEGACY[type];
  return maskTypeLabels[key ?? ""] ?? type.replace(/_/g, " ");
}

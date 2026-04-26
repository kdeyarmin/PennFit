import fullFaceImg from "@/assets/masks/full-face.png";
import nasalImg from "@/assets/masks/nasal.png";
import nasalPillowImg from "@/assets/masks/nasal-pillow.png";
import hybridImg from "@/assets/masks/hybrid.png";

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

export function getMaskImage(type: string): string {
  return maskTypeImages[type] ?? fullFaceImg;
}

export function formatMaskType(type: string): string {
  return maskTypeLabels[type] ?? type;
}

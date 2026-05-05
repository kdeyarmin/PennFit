// Curated short-form educational videos for /learn (Phase C.2 /
// feature #21 extension).
//
// Each entry is a 60-90s how-to that the patient education hub
// embeds as a privacy-mode YouTube iframe. The library is small
// and editorially curated; we don't surface a CMS for it because
// the cardinality is low (~10-20 videos) and the cost of editing
// a TS array is lower than the cost of building/maintaining a
// content authoring surface.
//
// `youtubeId` defaults to "" so a fresh deployer can ship the
// structure without external assets — the component renders a
// "video coming soon" placeholder until a real id lands. Replace
// each id with a PennPaps-recorded clip (or a vetted ResMed /
// Philips clip) before launch.
//
// `durationSec` is informational; we don't enforce it. Useful for
// the "60-90s" badge on the card.

export type LearnVideoCategory =
  | "mask"
  | "equipment"
  | "comfort"
  | "troubleshooting";

export interface LearnVideo {
  id: string;
  /** YouTube video id, NOT a full URL. Empty string = placeholder. */
  youtubeId: string;
  title: string;
  /** One-sentence summary; rendered under the title on the card. */
  blurb: string;
  durationSec: number;
  category: LearnVideoCategory;
}

export const LEARN_VIDEOS: LearnVideo[] = [
  {
    id: "clean-mask",
    youtubeId: "",
    title: "How to clean your CPAP mask",
    blurb:
      "Daily wipe-down + weekly soak — the routine that doubles cushion life.",
    durationSec: 75,
    category: "mask",
  },
  {
    id: "fix-mask-leak",
    youtubeId: "",
    title: "Why is my mask leaking?",
    blurb:
      "Three checks (headgear tension, cushion seat, position) before you swap masks.",
    durationSec: 90,
    category: "troubleshooting",
  },
  {
    id: "nasal-vs-full-face",
    youtubeId: "",
    title: "Nasal vs full-face mask",
    blurb: "Mouth-breather? Side sleeper? Glasses? When each style wins.",
    durationSec: 80,
    category: "mask",
  },
  {
    id: "humidifier-setup",
    youtubeId: "",
    title: "Setting up your humidifier",
    blurb: "Avoid dry mouth and rainout in one minute.",
    durationSec: 60,
    category: "comfort",
  },
  {
    id: "filter-replacement",
    youtubeId: "",
    title: "Replacing your CPAP filter",
    blurb: "30-day disposable + 6-month foam — the right cadence.",
    durationSec: 65,
    category: "equipment",
  },
  {
    id: "tubing-care",
    youtubeId: "",
    title: "Caring for your tubing",
    blurb: "Weekly rinse, storage tips, and when it's time for a fresh hose.",
    durationSec: 70,
    category: "equipment",
  },
];

// Education-video library helpers (RT #25). Pure — the topic catalog +
// active-filter/sort/group logic the public + admin surfaces share. No
// I/O; unit-tested directly.

export const EDUCATION_TOPICS = [
  "getting_started",
  "mask_fitting",
  "ramp_comfort",
  "cleaning",
  "troubleshooting",
  "travel",
  "other",
] as const;

export type EducationTopic = (typeof EDUCATION_TOPICS)[number];

export const EDUCATION_TOPIC_LABELS: Record<EducationTopic, string> = {
  getting_started: "Getting started",
  mask_fitting: "Mask fitting",
  ramp_comfort: "Ramp & comfort",
  cleaning: "Cleaning & care",
  troubleshooting: "Troubleshooting",
  travel: "Travel",
  other: "More",
};

export function isEducationTopic(v: unknown): v is EducationTopic {
  return (
    typeof v === "string" && (EDUCATION_TOPICS as readonly string[]).includes(v)
  );
}

export interface EducationVideo {
  id: string;
  title: string;
  topic: string;
  description: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  sortOrder: number;
  active: boolean;
}

/**
 * Pure: active videos only, ordered by (sort_order, title) — the stable
 * display order for the public list.
 */
export function activeVideosInOrder(
  videos: readonly EducationVideo[],
): EducationVideo[] {
  return videos
    .filter((v) => v.active)
    .slice()
    .sort(
      (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
    );
}

export interface VideoTopicGroup {
  topic: string;
  label: string;
  videos: EducationVideo[];
}

/**
 * Pure: group active, ordered videos by topic, in the canonical topic
 * order, dropping empty topics. Drives the storefront /learn/videos page.
 */
export function groupActiveVideosByTopic(
  videos: readonly EducationVideo[],
): VideoTopicGroup[] {
  const ordered = activeVideosInOrder(videos);
  const groups: VideoTopicGroup[] = [];
  for (const topic of EDUCATION_TOPICS) {
    const inTopic = ordered.filter((v) => v.topic === topic);
    if (inTopic.length === 0) continue;
    groups.push({
      topic,
      label: EDUCATION_TOPIC_LABELS[topic],
      videos: inTopic,
    });
  }
  // Any rows with an unrecognized topic still surface under "More".
  const known = new Set<string>(EDUCATION_TOPICS);
  const orphans = ordered.filter((v) => !known.has(v.topic));
  if (orphans.length > 0) {
    const more = groups.find((g) => g.topic === "other");
    if (more) more.videos.push(...orphans);
    else
      groups.push({
        topic: "other",
        label: EDUCATION_TOPIC_LABELS.other,
        videos: orphans,
      });
  }
  return groups;
}

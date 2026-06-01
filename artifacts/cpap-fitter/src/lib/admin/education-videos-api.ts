// Fetch wrappers for the education-video library admin (RT #25).
// reports.read to list; create/update need admin.tools.manage (enforced
// server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type EducationTopic =
  | "getting_started"
  | "mask_fitting"
  | "ramp_comfort"
  | "cleaning"
  | "troubleshooting"
  | "travel"
  | "other";

export const EDUCATION_TOPIC_OPTIONS: {
  value: EducationTopic;
  label: string;
}[] = [
  { value: "getting_started", label: "Getting started" },
  { value: "mask_fitting", label: "Mask fitting" },
  { value: "ramp_comfort", label: "Ramp & comfort" },
  { value: "cleaning", label: "Cleaning & care" },
  { value: "troubleshooting", label: "Troubleshooting" },
  { value: "travel", label: "Travel" },
  { value: "other", label: "More" },
];

export interface AdminEducationVideo {
  id: string;
  title: string;
  topic: EducationTopic;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  sort_order: number;
  active: boolean;
}

export interface CreateVideoInput {
  title: string;
  topic: EducationTopic;
  videoUrl: string;
  description?: string | null;
  durationSeconds?: number | null;
  sortOrder?: number;
}

async function err(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

export async function listEducationVideos(): Promise<{
  videos: AdminEducationVideo[];
}> {
  const url = "/resupply-api/admin/education-videos";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { videos: AdminEducationVideo[] };
}

export async function createEducationVideo(
  input: CreateVideoInput,
): Promise<{ id: string }> {
  const url = "/resupply-api/admin/education-videos";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { id: string };
}

export async function updateEducationVideo(
  id: string,
  patch: Partial<{
    title: string;
    topic: EducationTopic;
    description: string | null;
    videoUrl: string;
    durationSeconds: number | null;
    sortOrder: number;
    active: boolean;
  }>,
): Promise<{ ok: boolean }> {
  const url = `/resupply-api/admin/education-videos/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
  return (await res.json()) as { ok: boolean };
}

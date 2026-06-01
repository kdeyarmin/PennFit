// /admin/education-videos — manage the storefront video-education library
// (RT #25). List existing clips, add a new one (title + topic + https
// URL), and activate/deactivate. Viewing is reports.read; create/edit
// need admin.tools.manage (enforced server-side).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  listEducationVideos,
  createEducationVideo,
  updateEducationVideo,
  EDUCATION_TOPIC_OPTIONS,
  type AdminEducationVideo,
  type EducationTopic,
} from "@/lib/admin/education-videos-api";

const QUERY_KEY = ["admin", "education-videos"] as const;

const TOPIC_LABEL = new Map(
  EDUCATION_TOPIC_OPTIONS.map((o) => [o.value, o.label]),
);

export function AdminEducationVideosPage() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listEducationVideos,
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-education-videos-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <PlayCircle className="h-6 w-6" />
          Video education library
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Short how-to clips shown on the storefront <code>/learn/videos</code>{" "}
          page. Paste an https link to a hosted clip (YouTube, Vimeo, a CDN).
          Inactive clips stay hidden from patients.
        </p>
      </header>

      <CreateVideoForm />

      {query.isPending ? (
        <Spinner label="Loading videos…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.videos.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No videos yet. Add one above — the storefront page degrades to an
            empty state until then.
          </p>
        </Card>
      ) : (
        <Card title={`Videos (${query.data.videos.length})`}>
          <div className="space-y-2">
            {query.data.videos.map((v) => (
              <VideoRow key={v.id} video={v} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function CreateVideoForm() {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState<EducationTopic>("mask_fitting");
  const [videoUrl, setVideoUrl] = useState("");
  const create = useMutation({
    mutationFn: () =>
      createEducationVideo({
        title: title.trim(),
        topic,
        videoUrl: videoUrl.trim(),
      }),
    onSuccess: () => {
      setTitle("");
      setVideoUrl("");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const canSubmit =
    title.trim().length > 0 && videoUrl.trim().startsWith("https://");

  return (
    <Card title="Add a video">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[160px]">
          <span style={{ color: "hsl(var(--ink-3))" }}>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span style={{ color: "hsl(var(--ink-3))" }}>Topic</span>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value as EducationTopic)}
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {EDUCATION_TOPIC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[200px]">
          <span style={{ color: "hsl(var(--ink-3))" }}>Video URL (https)</span>
          <input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://…"
            className="rounded border px-2 py-1 font-mono"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>
        <Button
          size="sm"
          disabled={!canSubmit}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          Add
        </Button>
      </div>
      {create.error instanceof Error && (
        <p className="text-xs mt-2" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t add the video — check the URL is https and you have
          permission.
        </p>
      )}
    </Card>
  );
}

function VideoRow({ video }: { video: AdminEducationVideo }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => updateEducationVideo(video.id, { active: !video.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="education-video-row"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="flex items-center gap-2">
          <Badge variant={video.active ? "success" : "muted"}>
            {video.active ? "active" : "hidden"}
          </Badge>
          <span
            className="font-medium truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {video.title}
          </span>
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {TOPIC_LABEL.get(video.topic) ?? video.topic}
          </span>
        </span>
        <a
          href={video.video_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline decoration-dotted font-mono truncate"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {video.video_url}
        </a>
      </span>
      <Button
        size="sm"
        intent="secondary"
        isLoading={toggle.isPending}
        onClick={() => toggle.mutate()}
      >
        {video.active ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

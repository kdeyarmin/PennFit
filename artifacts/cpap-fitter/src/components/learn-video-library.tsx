// /learn → "Watch & learn" video library section (Phase C.2 /
// feature #21 extension).
//
// Renders the curated short-form videos from lib/learn-videos.ts.
// Each card is collapsed by default; clicking expands it into an
// inline iframe via youtube-nocookie.com (no third-party cookies
// until the user explicitly hits play).
//
// Why click-to-expand and not a modal: older patients hate modal
// overlays — anecdotally the same group ACU-Serve found bouncing
// over offshore CSR experiences. Inline expansion stays scrollable
// and keyboard-friendly.
//
// When a video's `youtubeId` is empty (the default before a
// deployer drops in a real recording), we render a "video coming
// soon" placeholder instead of a broken iframe.

import { useState } from "react";
import { Play, Clock } from "lucide-react";

import { LEARN_VIDEOS, type LearnVideo } from "@/lib/learn-videos";

export function LearnVideoLibrary() {
  return (
    <section
      className="space-y-4"
      data-testid="learn-video-library"
      aria-label="Educational videos"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
            Watch &amp; learn
          </p>
          <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-[hsl(var(--penn-navy))] mt-0.5">
            Short videos for the most common questions
          </h2>
        </div>
        <p className="text-xs text-muted-foreground max-w-sm">
          Each clip is a minute or two — quick answers to the calls our
          customer-service team gets every week.
        </p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2">
        {LEARN_VIDEOS.map((v) => (
          <VideoCard key={v.id} video={v} />
        ))}
      </ul>
    </section>
  );
}

function VideoCard({ video }: { video: LearnVideo }) {
  const [open, setOpen] = useState(false);
  const hasEmbed = video.youtubeId.length > 0;
  const minutes = Math.round(video.durationSec / 60);

  return (
    <li
      className="rounded-2xl border border-border/60 bg-background/70 overflow-hidden"
      data-testid={`learn-video-${video.id}`}
    >
      {open && hasEmbed ? (
        <div
          className="relative w-full"
          // 16:9 aspect ratio without relying on Tailwind's aspect
          // plugin (project may or may not have it enabled).
          style={{ paddingTop: "56.25%" }}
        >
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtubeId)}?rel=0&modestbranding=1&autoplay=1`}
            title={video.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            data-testid={`learn-video-iframe-${video.id}`}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!hasEmbed}
          className="block w-full aspect-video bg-[hsl(var(--penn-navy)/0.08)] hover:bg-[hsl(var(--penn-navy)/0.12)] transition-colors disabled:cursor-not-allowed disabled:hover:bg-[hsl(var(--penn-navy)/0.04)]"
          aria-label={
            hasEmbed
              ? `Play: ${video.title}`
              : `${video.title} — video coming soon`
          }
          data-testid={`learn-video-play-${video.id}`}
        >
          <div className="h-full w-full flex flex-col items-center justify-center gap-2">
            <span
              className={`h-12 w-12 rounded-full flex items-center justify-center ${
                hasEmbed
                  ? "bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))]"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Play className="w-5 h-5" fill="currentColor" />
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              {hasEmbed ? "Tap to play" : "Coming soon"}
            </span>
          </div>
        </button>
      )}
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-[hsl(var(--penn-navy))]">
            {video.title}
          </h3>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
            <Clock className="w-3 h-3" />~{minutes} min
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          {video.blurb}
        </p>
      </div>
    </li>
  );
}

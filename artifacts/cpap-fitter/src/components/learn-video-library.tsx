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
// When a video's `youtubeId` is empty (the default before a deployer
// drops in a real recording), it is HIDDEN — production must never show
// "coming soon" placeholder cards to customers. If no video has a real
// id yet, the whole "Watch & learn" section renders nothing (the rest of
// /learn is unaffected); add real YouTube ids in lib/learn-videos.ts and
// the cards appear automatically. The per-card "coming soon" branch
// below is kept only as defensive resilience.

import { useState, useEffect, useRef } from "react";
import { Play, Clock } from "lucide-react";

import { LEARN_VIDEOS, type LearnVideo } from "@/lib/learn-videos";

export function LearnVideoLibrary() {
  // Only one video may be open at a time. Storing the id of the open card
  // (null = none) ensures that opening a second card unmounts the first
  // iframe and stops playback, preventing overlapping audio/CPU waste.
  const [openId, setOpenId] = useState<string | null>(null);

  // Show only videos that have a real, embeddable id. Empty-id entries
  // are placeholders and must not surface in production.
  const videos = LEARN_VIDEOS.filter((v) => v.youtubeId.trim().length > 0);

  // Nothing curated yet → hide the section entirely rather than render an
  // empty "Watch & learn" header with no cards.
  if (videos.length === 0) return null;

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
        {videos.map((v) => (
          <VideoCard
            key={v.id}
            video={v}
            open={openId === v.id}
            onOpen={() => setOpenId(v.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function VideoCard({
  video,
  open,
  onOpen,
}: {
  video: LearnVideo;
  open: boolean;
  onOpen: () => void;
}) {
  const hasEmbed = video.youtubeId.length > 0;
  const minutes = Math.round(video.durationSec / 60);
  // Ref used to move focus into the iframe after the play button is
  // activated, keeping keyboard and screen-reader users oriented.
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (open && hasEmbed) {
      // Focus the iframe so that keyboard/screen-reader users don't lose
      // their position when the play button is removed from the DOM.
      iframeRef.current?.focus();
    }
  }, [open, hasEmbed]);

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
            ref={iframeRef}
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
          onClick={onOpen}
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

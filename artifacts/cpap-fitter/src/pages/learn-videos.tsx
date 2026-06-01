// /learn/videos — short-video education library (RT #25), storefront.
//
// Fetches the public GET /shop/education-videos (active videos grouped by
// topic) and renders them as cards linking out to the hosted clip. Fully
// fail-soft: an empty / errored catalog shows a friendly empty state, so
// the page never breaks when no videos are configured yet.

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlayCircle } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

interface VideoItem {
  id: string;
  title: string;
  description: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}
interface VideoGroup {
  topic: string;
  label: string;
  videos: VideoItem[];
}

function formatDuration(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LearnVideos() {
  useDocumentTitle("Video guides — PennPaps");
  const [groups, setGroups] = useState<VideoGroup[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/resupply-api/shop/education-videos", {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const data = (await res.json()) as { groups?: VideoGroup[] };
        if (cancelled) return;
        setGroups(data.groups ?? []);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isEmpty = state === "error" || (groups != null && groups.length === 0);

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2">
          <PlayCircle className="w-7 h-7 text-[hsl(var(--penn-gold))]" />
          Video guides
        </h1>
        <p className="text-muted-foreground">
          Short how-to clips for getting comfortable with your therapy — mask
          fitting, ramp &amp; comfort settings, cleaning, and troubleshooting.
        </p>
      </header>

      {state === "loading" && (
        <p className="text-sm text-muted-foreground">Loading guides…</p>
      )}

      {isEmpty && (
        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="py-8">
            <p className="text-muted-foreground">
              We&apos;re putting our video guides together — check back soon. In
              the meantime, our{" "}
              <Link href="/learn" className="text-primary hover:underline">
                written guides
              </Link>{" "}
              cover the essentials, and you can always reply to any of our
              emails with questions.
            </p>
          </CardContent>
        </Card>
      )}

      {state === "ready" &&
        groups != null &&
        groups.map((group) => (
          <section key={group.topic} className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">
              {group.label}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {group.videos.map((video) => {
                const dur = formatDuration(video.durationSeconds);
                return (
                  <a
                    key={video.id}
                    href={video.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block group"
                    data-testid="education-video-card"
                  >
                    <Card className="border-0 glass-card rounded-2xl h-full transition-transform group-hover:-translate-y-0.5">
                      <CardHeader>
                        <CardTitle className="text-base font-medium flex items-center gap-2">
                          <PlayCircle className="w-5 h-5 text-[hsl(var(--penn-gold))] shrink-0" />
                          {video.title}
                          {dur && (
                            <span className="ml-auto text-xs text-muted-foreground font-normal">
                              {dur}
                            </span>
                          )}
                        </CardTitle>
                      </CardHeader>
                      {video.description && (
                        <CardContent className="pt-0 text-sm text-muted-foreground">
                          {video.description}
                        </CardContent>
                      )}
                    </Card>
                  </a>
                );
              })}
            </div>
          </section>
        ))}
    </div>
  );
}

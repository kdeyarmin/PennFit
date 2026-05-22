import React from "react";
import { Button } from "@/components/ui/button";
import { Link2, Mail, MessageCircle, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ShareArticleProps = {
  /** The path of the article — used to build a canonical, query-stripped URL. */
  path: string;
  /** Article headline. Used as the share-sheet title and email subject. */
  title: string;
  /** One-line summary. Used as the share-sheet body and as the email pre-body. */
  blurb: string;
  /** Optional `data-testid` prefix so tests can scope to a specific article. */
  testIdPrefix?: string;
};

// Build a canonical URL for an article path — origin + BASE_URL + path,
// with any incoming query/hash stripped. We never propagate `?utm_…` tracking
// params when a reader passes the link to a friend, and we don't want
// page-internal hash anchors to land on a different scroll point.
function buildCanonicalUrl(path: string): string {
  const basePath = (import.meta.env.BASE_URL || "").replace(/\/$/, "");
  const canonicalBasePath = basePath === "/" ? "" : basePath;
  return `${window.location.origin}${canonicalBasePath}${path}`;
}

/**
 * Share affordance for long-form educational articles. Mirrors the pattern
 * used on shop product detail pages — native Web Share API where supported
 * (iOS Safari, Android Chrome surface Messages, Mail, AirDrop, etc), with
 * clipboard copy as a fallback. Adds two extra explicit channels —
 * "email this" (mailto:) and "share on Facebook" — that work even when
 * Web Share is blocked or unavailable, since these articles are designed
 * to be passed around for awareness.
 */
export function ShareArticle({
  path,
  title,
  blurb,
  testIdPrefix = "share",
}: ShareArticleProps) {
  const { toast } = useToast();

  async function handleShare() {
    if (typeof window === "undefined") return;
    const url = buildCanonicalUrl(path);
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, text: blurb, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "Article link copied to your clipboard.",
      });
    } catch {
      toast({
        title: "Couldn't copy link",
        description:
          "Your browser blocked clipboard access — long-press the address bar to copy the URL instead.",
        variant: "destructive",
      });
    }
  }

  function handleEmail() {
    if (typeof window === "undefined") return;
    const url = buildCanonicalUrl(path);
    const subject = encodeURIComponent(title);
    const body = encodeURIComponent(
      `${blurb}\n\n${url}\n\n— shared from PennPaps`,
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  function handleFacebook() {
    if (typeof window === "undefined") return;
    const url = buildCanonicalUrl(path);
    const shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
      url,
    )}`;
    window.open(shareUrl, "_blank", "noopener,noreferrer,width=600,height=520");
  }

  return (
    <div className="glass-panel rounded-2xl p-5 md:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sparkles className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">
              Found this useful? Pass it along.
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed">
              Help a friend, partner, or family member learn what you just did.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleShare}
            className="rounded-full glass-card hover:border-primary/40 gap-1.5"
            data-testid={`${testIdPrefix}-copy-link`}
          >
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
            Copy link
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleEmail}
            className="rounded-full glass-card hover:border-primary/40 gap-1.5"
            data-testid={`${testIdPrefix}-email`}
          >
            <Mail className="w-3.5 h-3.5" aria-hidden="true" />
            Email
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFacebook}
            className="rounded-full glass-card hover:border-primary/40 gap-1.5"
            data-testid={`${testIdPrefix}-facebook`}
          >
            <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" />
            Facebook
          </Button>
        </div>
      </div>
    </div>
  );
}

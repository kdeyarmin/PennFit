import { useQuery } from "@tanstack/react-query";
import { BookOpen, HelpCircle, Wrench, Heart, Sparkles } from "lucide-react";

import {
  fetchEducationFeed,
  type EducationCategory,
  type EducationStage,
} from "@/lib/account-api";

/**
 * "Recommended reading" section on /account.
 *
 * Renders a small curated set of articles tailored to the patient's
 * onboarding stage (new / habituating / steady / experienced),
 * computed server-side from days since their first therapy night.
 * Always renders — even anonymous shop customers get the
 * "new patient" feed since this is education content, not PHI.
 */
const STAGE_HEADLINE: Record<EducationStage, string> = {
  new: "Your first weeks on therapy",
  habituating: "Getting comfortable",
  steady: "Keeping things steady",
  experienced: "Your long-term therapy",
};

const STAGE_BLURB: Record<EducationStage, string> = {
  new: "Most of what you're feeling now is normal. Start here.",
  habituating:
    "Weeks 3–8 are where most patients fine-tune the setup.",
  steady:
    "You're past the hump — this is upkeep + tuning for the long haul.",
  experienced:
    "Time for an annual look at your machine, mask, and prescription.",
};

const CATEGORY_ICON: Record<EducationCategory, React.ReactNode> = {
  comfort: <Heart className="h-3.5 w-3.5" />,
  troubleshooting: <HelpCircle className="h-3.5 w-3.5" />,
  maintenance: <Wrench className="h-3.5 w-3.5" />,
  lifestyle: <Sparkles className="h-3.5 w-3.5" />,
};

export function EducationFeedSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["account", "education-feed"] as const,
    queryFn: fetchEducationFeed,
  });
  if (isLoading || !data) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-education-feed"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
          <h2 className="font-semibold">{STAGE_HEADLINE[data.stage]}</h2>
        </div>
        {data.patientLinked && data.daysOnTherapy > 0 && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Day {data.daysOnTherapy}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {STAGE_BLURB[data.stage]}
      </p>
      <ul className="grid sm:grid-cols-2 gap-3">
        {data.articles.map((a) => (
          <li key={a.slug}>
            <a
              href={a.slug}
              className="block rounded-xl border p-3 hover:shadow-sm transition-shadow"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {CATEGORY_ICON[a.category]}
                <span>{a.category}</span>
              </div>
              <div className="text-sm font-semibold mt-1">{a.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {a.summary}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

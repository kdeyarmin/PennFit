import React, { useState } from "react";
import {
  useListMasks,
  MaskEntryType,
} from "@workspace/api-client-react/storefront";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Filter, Wind, Weight, Ruler, Activity, Tag, Sparkles } from "lucide-react";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { openPennBot } from "@/lib/chat-events";

const priceTierLabel: Record<string, string> = {
  budget: "Budget",
  standard: "Standard",
  premium: "Premium",
};

const priceTierColor: Record<string, string> = {
  budget: "chip-tier-budget",
  standard: "chip-tier-standard",
  premium: "chip-tier-premium",
};

export function Masks() {
  useDocumentTitle(
    "Mask catalog",
    "Browse the full PennPaps CPAP mask catalog: nasal, nasal pillow, full face, and hybrid masks with sizing, weight, noise level, and price tier.",
  );
  const { data, isLoading } = useListMasks();
  const [filter, setFilter] = useState<MaskEntryType | "all">("all");

  const filteredMasks =
    data?.masks.filter((m) => filter === "all" || m.type === filter) || [];

  return (
    <div className="container max-w-6xl mx-auto px-4 py-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-10 gap-6 animate-shimmer-in">
        <div>
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              PennPaps · Catalog
            </span>
          </div>
          <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-2 text-gradient-brand">
            Mask Catalog
          </h1>
          <p className="text-muted-foreground">
            Every mask we carry. Get matched to one with the{" "}
            <a
              href="/consent"
              className="text-primary underline-offset-4 hover:underline"
            >
              on-device fitter
            </a>
            , or order a complete mask direct from{" "}
            <a
              href="/shop"
              className="text-primary underline-offset-4 hover:underline"
            >
              the shop
            </a>
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-2 text-sm font-medium text-muted-foreground">
            <Filter className="w-4 h-4" /> Filter:
          </div>
          {(["all", "fullFace", "nasal", "nasalPillow", "hybrid"] as const).map(
            (t) => (
              <Button
                key={t}
                variant={filter === t ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(t)}
                className={
                  filter === t
                    ? "btn-primary-glow rounded-full"
                    : "rounded-full glass-panel hover:border-primary/40"
                }
              >
                {t === "all" ? "All" : formatMaskType(t)}
              </Button>
            ),
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              openPennBot({
                prefill: "Help me pick a mask — what should I consider?",
              })
            }
            className="rounded-full glass-panel hover:border-primary/40 gap-1.5"
            data-testid="masks-ask-pennbot"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Ask PennBot
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-[480px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredMasks.map((mask) => (
            <Card
              key={mask.id}
              className="flex flex-col overflow-hidden glass-card lift-on-hover rounded-2xl border-0"
            >
              <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 border-b border-border/50 relative overflow-hidden">
                <img
                  src={getMaskImage(mask.type)}
                  alt={`${mask.manufacturer} ${mask.name}`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                  decoding="async"
                />
                <Badge
                  className="absolute top-3 left-3 glass-panel text-foreground border-0 font-medium"
                  variant="secondary"
                >
                  {mask.manufacturer}
                </Badge>
                <Badge
                  className={`absolute top-3 right-3 font-medium ${priceTierColor[mask.priceTier] ?? ""}`}
                  variant="outline"
                >
                  <Tag className="w-3 h-3 mr-1" />
                  {priceTierLabel[mask.priceTier] ?? mask.priceTier}
                </Badge>
              </div>

              <CardContent className="flex-1 flex flex-col p-5">
                <div className="mb-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <h3 className="text-lg font-semibold leading-tight">
                      {mask.name}
                    </h3>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wider text-muted-foreground font-medium">
                    <span>{formatMaskType(mask.type)} Mask</span>
                    <code className="font-mono normal-case tracking-normal text-foreground bg-muted px-1.5 py-0.5 rounded text-[11px]">
                      {mask.modelNumber}
                    </code>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground leading-relaxed mb-4 line-clamp-3">
                  {mask.description}
                </p>

                <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                  <div className="flex items-start gap-2">
                    <Weight className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="text-muted-foreground">Weight</div>
                      <div className="font-medium">{mask.weightGrams} g</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Activity className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="text-muted-foreground">Pressure</div>
                      <div className="font-medium">
                        {mask.pressureRangeMin}–{mask.pressureRangeMax} cmH₂O
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Wind className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="text-muted-foreground">Hose</div>
                      <div className="font-medium capitalize">
                        {mask.hoseConnection}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Ruler className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="text-muted-foreground">Sizes</div>
                      <div className="font-medium truncate">
                        {mask.sizesAvailable.length}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 mt-auto">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Cushion
                    </div>
                    <div className="text-sm">{mask.cushionMaterial}</div>
                  </div>

                  {mask.bestFor && mask.bestFor.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        Best for
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {mask.bestFor.slice(0, 3).map((tag, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            className="text-xs font-normal"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Available sizes
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {mask.sizesAvailable.join(", ")}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && filteredMasks.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          No masks match the selected filter.
        </div>
      )}
    </div>
  );
}

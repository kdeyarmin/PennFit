import React, { useState } from "react";
import { useListMasks, MaskEntryType } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Filter, Wind, Weight, Ruler, Activity, Tag } from "lucide-react";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";

const priceTierLabel: Record<string, string> = {
  budget: "Budget",
  standard: "Standard",
  premium: "Premium",
};

const priceTierColor: Record<string, string> = {
  budget: "bg-emerald-50 text-emerald-700 border-emerald-200",
  standard: "bg-blue-50 text-blue-700 border-blue-200",
  premium: "bg-amber-50 text-amber-700 border-amber-200",
};

export function Masks() {
  const { data, isLoading } = useListMasks();
  const [filter, setFilter] = useState<MaskEntryType | "all">("all");

  const filteredMasks = data?.masks.filter((m) => filter === "all" || m.type === filter) || [];

  return (
    <div className="container max-w-6xl mx-auto px-4 py-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-10 gap-6 animate-shimmer-in">
        <div>
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Penn Fit · Catalog
            </span>
          </div>
          <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-2 text-gradient-brand">Mask Catalog</h1>
          <p className="text-muted-foreground">
            Browse all CPAP masks available through Penn Home Medical Supply.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-2 text-sm font-medium text-muted-foreground">
            <Filter className="w-4 h-4" /> Filter:
          </div>
          {(["all", "fullFace", "nasal", "nasalPillow", "hybrid"] as const).map((t) => (
            <Button
              key={t}
              variant={filter === t ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(t)}
            >
              {t === "all" ? "All" : formatMaskType(t)}
            </Button>
          ))}
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
            <Card key={mask.id} className="flex flex-col overflow-hidden glass-card lift-on-hover rounded-2xl border-0">
              <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 border-b border-border/50 relative overflow-hidden">
                <img
                  src={getMaskImage(mask.type)}
                  alt={`${mask.manufacturer} ${mask.name}`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                />
                <Badge className="absolute top-3 left-3" variant="secondary">
                  {mask.manufacturer}
                </Badge>
                <Badge
                  className={`absolute top-3 right-3 border ${priceTierColor[mask.priceTier] ?? ""}`}
                  variant="outline"
                >
                  <Tag className="w-3 h-3 mr-1" />
                  {priceTierLabel[mask.priceTier] ?? mask.priceTier}
                </Badge>
              </div>

              <CardContent className="flex-1 flex flex-col p-5">
                <div className="mb-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <h3 className="text-lg font-semibold leading-tight">{mask.name}</h3>
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
                      <div className="font-medium capitalize">{mask.hoseConnection}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Ruler className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <div className="text-muted-foreground">Sizes</div>
                      <div className="font-medium truncate">{mask.sizesAvailable.length}</div>
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
                          <Badge key={i} variant="outline" className="text-xs font-normal">
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

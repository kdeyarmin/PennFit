import React from "react";
import type {
  MaskEntry,
  MaskRecommendation,
} from "@workspace/api-client-react";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Activity,
  HardHat,
  HelpCircle,
  Info,
  Layers,
  ShoppingCart,
  Sparkles,
  Tag,
  Weight,
  Wind,
} from "lucide-react";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";

/**
 * MaskRecommendationCard — single, reusable card for one entry on the
 * results page. Extracted from the previously 480-line results.tsx so
 * that:
 *   - results.tsx becomes a layout-only file (easy to scan and reorder),
 *   - the card itself can be reused (e.g. in /masks alternative views),
 *   - and styling tweaks on a single card don't require scrolling
 *     hundreds of lines.
 */
export function MaskRecommendationCard({
  mask,
  details,
  isTopPick,
  onChoose,
}: {
  mask: MaskRecommendation;
  details: MaskEntry | undefined;
  isTopPick: boolean;
  onChoose: () => void;
}) {
  const confidencePct = Math.round(mask.confidence * 100);

  return (
    <Card
      className={`overflow-hidden border-0 glass-card lift-on-hover rounded-2xl ${
        isTopPick
          ? "ring-2 ring-[hsl(var(--penn-gold)/0.50)] shadow-[0_0_0_4px_hsl(var(--penn-gold)/0.10),0_24px_48px_hsl(var(--penn-navy)/0.12)]"
          : ""
      }`}
    >
      <div className="flex flex-col md:flex-row">
        <div className="w-full md:w-1/3 bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/30 p-6 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border/40">
          <div className="aspect-square w-full max-w-[220px] bg-white rounded-xl shadow-md border border-border/40 overflow-hidden mb-4">
            <img
              src={getMaskImage(mask.type)}
              alt={`${mask.manufacturer} ${mask.name}`}
              className="w-full h-full object-contain p-3"
            />
          </div>
          <div className="flex gap-2 flex-wrap justify-center">
            <Badge variant="secondary">{formatMaskType(mask.type)}</Badge>
            <Badge variant="outline">{mask.manufacturer}</Badge>
          </div>
        </div>

        <div className="w-full md:w-2/3 p-6 flex flex-col">
          <div className="flex justify-between items-start mb-4 gap-4">
            <div className="min-w-0">
              {isTopPick && (
                <span className="text-xs font-bold uppercase tracking-wider text-primary mb-1 block">
                  Best Match
                </span>
              )}
              <CardTitle className="text-2xl mb-1">{mask.name}</CardTitle>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5" />
                  Model{" "}
                  <code className="font-mono font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">
                    {mask.modelNumber}
                  </code>
                </span>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1 text-sm hover:text-foreground transition-colors group"
                      data-testid={`confidence-explainer-${mask.maskId}`}
                    >
                      Match confidence:{" "}
                      <span className="font-semibold text-foreground">{confidencePct}%</span>
                      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60 group-hover:text-primary transition-colors" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 text-sm space-y-2" align="start">
                    <div className="font-semibold">How we calculated {confidencePct}%</div>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Confidence blends two signals:
                    </p>
                    <ul className="text-xs space-y-1.5 text-muted-foreground">
                      <li className="flex gap-2">
                        <span className="font-semibold text-primary shrink-0">60%</span>
                        <span>
                          <strong className="text-foreground">Mask type fit</strong> — how well this
                          type matches your sleep style, breathing, facial hair, congestion, prior
                          experience, and CPAP pressure.
                        </span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-semibold text-primary shrink-0">40%</span>
                        <span>
                          <strong className="text-foreground">Physical fit</strong> — how your nose
                          width, height, mouth width, and nose-to-chin distance line up with this
                          mask's documented size range.
                        </span>
                      </li>
                    </ul>
                    <p className="text-xs text-muted-foreground italic pt-1">
                      Penalties apply for contraindications and pressure mismatches. The score is
                      guidance — the final fitting confirmation happens with Penn Home Medical Supply.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          <div
            className="rounded-xl p-4 mb-4 border border-[hsl(var(--penn-navy)/0.15)] relative overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--penn-navy) / 0.06) 0%, hsl(var(--penn-gold) / 0.06) 100%)",
            }}
          >
            <h4 className="text-xs font-bold uppercase tracking-wider text-primary mb-1.5 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[hsl(var(--penn-gold))]" />
              Why this fits you
            </h4>
            <p className="text-sm text-foreground leading-relaxed">{mask.summary}</p>
          </div>

          {details?.description && (
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {details.description}
            </p>
          )}

          {details && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 p-3 glass-panel rounded-xl text-xs">
              <Spec icon={<Weight className="w-3.5 h-3.5 text-primary" />} label="Weight">
                {details.weightGrams} g
              </Spec>
              <Spec icon={<Activity className="w-3.5 h-3.5 text-primary" />} label="Pressure">
                {details.pressureRangeMin}–{details.pressureRangeMax} cmH₂O
              </Spec>
              <Spec icon={<Wind className="w-3.5 h-3.5 text-primary" />} label="Hose">
                <span className="capitalize">{details.hoseConnection}</span>
              </Spec>
              <Spec icon={<Layers className="w-3.5 h-3.5 text-primary" />} label="Cushion">
                {details.cushionMaterial}
              </Spec>
              <Spec
                icon={<HardHat className="w-3.5 h-3.5 text-primary" />}
                label="Headgear"
                className="col-span-2 md:col-span-1"
              >
                {details.headgearStyle}
              </Spec>
            </div>
          )}

          <div className="space-y-4 flex-1">
            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Info className="w-4 h-4 text-primary" /> Reasoning
              </h4>
              <ul className="space-y-2">
                {mask.reasoning.map((reason, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary/50 mt-1.5 shrink-0" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>

            {mask.contraindications && mask.contraindications.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-700 mb-1.5">
                  Things to consider
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {mask.contraindications.map((c, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="text-xs font-normal bg-amber-50 border-amber-200 text-amber-800"
                    >
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {details?.sizesAvailable && details.sizesAvailable.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Available sizes
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {details.sizesAvailable.map((s, i) => (
                    <Badge key={i} variant="outline" className="text-xs font-normal">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-border/50">
            <Button
              onClick={onChoose}
              size="lg"
              variant={isTopPick ? "default" : "outline"}
              className={`w-full ${isTopPick ? "btn-primary-glow" : "glass-panel"}`}
              data-testid={`button-choose-${mask.maskId}`}
            >
              <ShoppingCart className="w-4 h-4 mr-2" />
              Order This Mask
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              We'll collect your insurance and shipping info, then send your order to Penn Home Medical Supply.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Spec({
  icon,
  label,
  children,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-muted-foreground">{label}</div>
        <div className="font-medium truncate">{children}</div>
      </div>
    </div>
  );
}

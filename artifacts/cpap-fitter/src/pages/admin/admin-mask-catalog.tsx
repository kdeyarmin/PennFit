// /admin/fitter/catalog — the Mask Intelligence Catalog.
//
// The page's real job is the clinical review queue. The catalog ships with
// ~250 size variants whose millimetre bands are clinically-reasoned
// estimates rather than published manufacturer data, and the engine caps
// an unreviewed variant below high confidence — so until a respiratory
// therapist works through this list the fitter will never issue a
// confident automated recommendation off estimated geometry. The
// "Needs review" filter is therefore the default view.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchMaskCatalog,
  fetchMaskModel,
  reviewVariant,
  type InterfaceType,
  type MaskModel,
} from "@/lib/admin/fitting-api";

const QUERY_KEY = ["admin", "mask-catalog"] as const;

const INTERFACE_LABELS: Record<InterfaceType, string> = {
  nasal: "Nasal",
  nasal_pillow: "Nasal pillow",
  nasal_cradle: "Nasal cradle",
  hybrid: "Hybrid",
  full_face: "Full face",
  total_face: "Total face",
  oral: "Oral",
};

function mm(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—";
  return `${min}–${max} mm`;
}

export function AdminMaskCatalogPage() {
  const queryClient = useQueryClient();
  const [needsReview, setNeedsReview] = useState(true);
  const [search, setSearch] = useState("");
  const [interfaceType, setInterfaceType] = useState<InterfaceType | "">("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: [...QUERY_KEY, needsReview, search, interfaceType],
    queryFn: () =>
      fetchMaskCatalog({
        needsReview: needsReview || undefined,
        search: search || undefined,
        interfaceType: interfaceType || undefined,
        limit: 200,
      }),
  });

  const detail = useQuery({
    queryKey: [...QUERY_KEY, "detail", expanded],
    queryFn: () => fetchMaskModel(expanded!),
    enabled: Boolean(expanded),
  });

  const review = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      reviewVariant(id, approved),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const models: MaskModel[] = catalog.data?.models ?? [];

  return (
    <div className="admin-root space-y-4">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Library size={20} aria-hidden="true" />
          Mask catalog
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Every mask the fitter can recommend, with its interface type, therapy
          compatibility, magnetic components, and per-size measurement ranges.
          Sizes marked <strong>needs review</strong> use estimated geometry: the
          engine will not issue a high-confidence recommendation from them until
          a clinician signs them off here.
        </p>
      </header>

      <Card>
        <div className="p-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor="catalog-search">Search by model</Label>
            <Input
              id="catalog-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="AirFit, DreamWear, Evora…"
            />
          </div>
          <div>
            <Label htmlFor="catalog-interface">Interface</Label>
            <select
              id="catalog-interface"
              className="border rounded h-9 px-2 text-sm"
              value={interfaceType}
              onChange={(e) =>
                setInterfaceType(e.target.value as InterfaceType | "")
              }
            >
              <option value="">All</option>
              {Object.entries(INTERFACE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Button
            intent={needsReview ? "primary" : "secondary"}
            onClick={() => setNeedsReview((v) => !v)}
            aria-pressed={needsReview}
          >
            {needsReview ? "Showing: needs review" : "Showing: all masks"}
          </Button>
        </div>
      </Card>

      {catalog.isError ? (
        <ErrorPanel
          title="Couldn't load the mask catalog"
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      ) : null}
      {catalog.isLoading ? <Spinner /> : null}

      {!catalog.isLoading && models.length === 0 ? (
        <Card>
          <p className="p-4 text-sm text-muted-foreground">
            {needsReview
              ? "Nothing left in the review queue — every size band has been signed off."
              : "No masks matched those filters."}
          </p>
        </Card>
      ) : null}

      <div className="space-y-2">
        {models.map((m) => (
          <Card key={m.id}>
            <div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {m.manufacturer} {m.modelName}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <Badge>{INTERFACE_LABELS[m.interfaceType]}</Badge>
                    <Badge>{m.serviceLine}</Badge>
                    <Badge>{m.therapyModes.join(" / ").toUpperCase()}</Badge>
                    {m.vented !== "vented" ? (
                      <Badge>{m.vented.replace("_", "-")}</Badge>
                    ) : null}
                    {m.hasMagneticComponents ? (
                      <Badge>Magnetic clips</Badge>
                    ) : null}
                    {m.avoidsNasalBridge ? (
                      <Badge>Avoids nose bridge</Badge>
                    ) : null}
                    {m.status !== "current" ? <Badge>{m.status}</Badge> : null}
                    {m.needsClinicalReview ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">
                        Needs review
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {m.pressureMinCmH2O !== null && m.pressureMaxCmH2O !== null
                      ? `${m.pressureMinCmH2O}–${m.pressureMaxCmH2O} cmH₂O · `
                      : ""}
                    sizing data: {m.fitDataSource}
                  </p>
                </div>
                <Button
                  intent="secondary"
                  onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                  aria-expanded={expanded === m.id}
                >
                  {expanded === m.id ? "Hide sizes" : "Review sizes"}
                </Button>
              </div>

              {expanded === m.id ? (
                <div className="mt-4 border-t pt-3">
                  {detail.isLoading ? <Spinner /> : null}
                  {detail.data ? (
                    <>
                      {detail.data.contraindications.length > 0 ? (
                        <div className="mb-3">
                          <p className="text-sm font-medium mb-1">
                            Clinical exclusions
                          </p>
                          <ul className="text-xs space-y-1">
                            {detail.data.contraindications.map((c, i) => (
                              <li key={i}>
                                <strong>
                                  {c.severity === "exclude"
                                    ? "Excludes"
                                    : "Caution"}
                                </strong>
                                {" — "}
                                {c.factor.replace(/_/g, " ")}: {c.rationale}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left border-b">
                              <th className="py-1 pr-3">Size</th>
                              <th className="py-1 pr-3">Part</th>
                              <th className="py-1 pr-3">Nose width</th>
                              <th className="py-1 pr-3">Nose to chin</th>
                              <th className="py-1 pr-3">Mouth width</th>
                              <th className="py-1 pr-3">HCPCS</th>
                              <th className="py-1 pr-3">Source</th>
                              <th className="py-1" />
                            </tr>
                          </thead>
                          <tbody>
                            {detail.data.variants.map((v) => (
                              <tr key={v.id} className="border-b last:border-0">
                                <td className="py-1.5 pr-3 font-medium">
                                  {v.sizeLabel}
                                </td>
                                <td className="py-1.5 pr-3">{v.component}</td>
                                <td className="py-1.5 pr-3">
                                  {mm(v.noseWidthMinMm, v.noseWidthMaxMm)}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {mm(v.noseToChinMinMm, v.noseToChinMaxMm)}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {mm(v.mouthWidthMinMm, v.mouthWidthMaxMm)}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {v.hcpcsCode ?? "—"}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {v.fitDataSource}
                                </td>
                                <td className="py-1.5">
                                  {v.needsClinicalReview ? (
                                    <Button
                                      onClick={() =>
                                        review.mutate({
                                          id: v.id,
                                          approved: true,
                                        })
                                      }
                                      disabled={review.isPending}
                                    >
                                      Sign off
                                    </Button>
                                  ) : (
                                    <span
                                      className="text-emerald-700"
                                      title={
                                        v.reviewedByEmail
                                          ? `Signed off by ${v.reviewedByEmail}`
                                          : undefined
                                      }
                                    >
                                      Approved
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Signing off a size confirms its measurement range is
                        clinically sound. Until then the engine caps any
                        recommendation using it at moderate confidence. Sign-off
                        applies to your organization only — it does not change
                        what any other provider on the platform sees.
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default AdminMaskCatalogPage;

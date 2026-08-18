// /admin/fitter/catalog — the Mask Intelligence Catalog.
//
// The page's real job is the clinical review queue. The catalog ships with
// ~250 size variants whose millimetre bands are clinically-reasoned
// estimates rather than published manufacturer data, and the engine caps
// an unreviewed variant below high confidence — so until a respiratory
// therapist works through this list the fitter will never issue a
// confident automated recommendation off estimated geometry. The
// "Needs review" filter is therefore the default view.
//
// A sign-off also records WHAT it was checked against (migration 0491).
// The source is captured once per model — a reviewer opens one
// manufacturer fitting guide and works that model's whole size run
// against it — and then applies to every sign-off made from this panel,
// individually or in bulk. That is what makes the fit report's provenance
// section evidence rather than an assertion.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label, Select } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchMaskCatalog,
  fetchMaskModel,
  reviewVariant,
  reviewVariantsBatch,
  REVIEW_SOURCE_KINDS,
  type InterfaceType,
  type MaskModel,
  type ReviewProvenance,
  type ReviewSourceKind,
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

const SOURCE_KIND_LABELS = new Map(
  REVIEW_SOURCE_KINDS.map((k) => [k.value, k.label] as const),
);

/**
 * Who signed a size off and what they checked it against.
 *
 * Sign-offs recorded before migration 0491 carry no source. That reads as
 * "source not recorded", never as an invented citation — the whole point of
 * the column is that a reader can tell evidence from assertion.
 */
function signOffTitle(v: {
  reviewedByEmail: string | null;
  reviewSourceKind: ReviewSourceKind | null;
  reviewSourceRef: string | null;
}): string | undefined {
  if (!v.reviewedByEmail && !v.reviewSourceKind && !v.reviewSourceRef) {
    return undefined;
  }
  const who = v.reviewedByEmail
    ? `Signed off by ${v.reviewedByEmail}`
    : "Signed off";
  const kind = v.reviewSourceKind
    ? (SOURCE_KIND_LABELS.get(v.reviewSourceKind) ?? v.reviewSourceKind)
    : null;
  const against = [kind, v.reviewSourceRef].filter(Boolean).join(" — ");
  return against ? `${who} against ${against}` : `${who} (source not recorded)`;
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

  // Sign-off provenance, held at page level and reset when the reviewer
  // opens a different model — a citation is only true of the model it was
  // read for, so carrying it across models would launder one mask's
  // evidence onto another.
  const [sourceKind, setSourceKind] = useState<ReviewSourceKind | "">("");
  const [sourceRef, setSourceRef] = useState("");
  const [sourcePrefilled, setSourcePrefilled] = useState(false);

  function openModel(id: string | null) {
    setExpanded(id);
    setSourceKind("");
    setSourceRef("");
    setSourcePrefilled(false);
  }

  // Seed the reviewer's citation from the catalog's own platform-sourced
  // provenance (0495), so a sourced band becomes a CONFIRMATION rather
  // than a fresh transcription. Rules, in order of what they protect:
  //   * only when EVERY pending variant is non-estimated and they agree
  //     on ONE ref. The "Sign off all" button submits every pending id
  //     with this provenance, so a partially sourced model must not
  //     pre-fill — it would record the citation against estimated bands
  //     the cited source never supported, and approve them with it;
  //   * the evidence CLASS is only pre-filled for 'measured' (which maps
  //     unambiguously to a physical measurement). 'manufacturer' says a
  //     manufacturer document, not WHICH kind — the 0491 schema splits
  //     fit guide from spec sheet on purpose, and guessing "fit guide"
  //     would misstate on the fit report what the RT actually reviewed.
  //     The reviewer picks the class; only the reference is seeded;
  //   * only while the reviewer has not typed — their words always win.
  const detailModelId = detail.data?.model.id;
  useEffect(() => {
    if (!detailModelId || sourceKind !== "" || sourceRef !== "") return;
    const pending = (detail.data?.variants ?? []).filter(
      (v) => v.needsClinicalReview,
    );
    if (pending.length === 0) return;
    if (pending.some((v) => v.fitDataSource === "estimated")) return;
    const refs = new Set(pending.map((v) => v.fitDataSourceRef));
    const kinds = new Set(pending.map((v) => v.fitDataSource));
    if (refs.size !== 1 || kinds.size !== 1) return;
    const [ref] = refs;
    if (!ref) return;
    if ([...kinds][0] === "measured") {
      setSourceKind("physical_measurement");
    }
    setSourceRef(String(ref));
    setSourcePrefilled(true);
    // Deliberately not exhaustive: this must fire once per opened model,
    // from the fetched detail, and never re-fire against user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailModelId]);

  const provenance: ReviewProvenance = {
    ...(sourceKind ? { sourceKind } : {}),
    ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
  };

  const review = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      reviewVariant(id, approved, provenance),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const reviewAll = useMutation({
    mutationFn: (variantIds: string[]) =>
      reviewVariantsBatch(variantIds, true, provenance),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const models: MaskModel[] = catalog.data?.models ?? [];
  const pendingVariantIds = (detail.data?.variants ?? [])
    .filter((v) => v.needsClinicalReview)
    .map((v) => v.id);

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
                  onClick={() => openModel(expanded === m.id ? null : m.id)}
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

                      {pendingVariantIds.length > 0 ? (
                        <div
                          className="mb-3 rounded-md border p-3"
                          style={{ borderColor: "hsl(var(--line-2))" }}
                        >
                          <p className="text-sm font-medium">Sign-off source</p>
                          <p className="text-xs text-muted-foreground mb-2">
                            What are you checking these ranges against? Recorded
                            with every sign-off you make below and printed on
                            the fit report, so a later reader can see the
                            evidence rather than take the approval on trust.
                          </p>
                          {detail.data.model.fittingInstructionsUrl ? (
                            <p className="text-xs mb-2">
                              <a
                                href={detail.data.model.fittingInstructionsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                Open the manufacturer&apos;s fitting
                                documentation
                                {detail.data.model.fittingInstructionsVersion
                                  ? ` (${detail.data.model.fittingInstructionsVersion})`
                                  : ""}
                              </a>
                            </p>
                          ) : null}
                          {sourcePrefilled ? (
                            <p className="text-xs text-muted-foreground mb-2">
                              Reference pre-filled from the catalog&apos;s own
                              recorded source — pick the evidence class, and
                              change the reference if you checked something
                              else.
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-3 items-end">
                            <div className="min-w-[220px]">
                              <Label htmlFor="review-source-kind">Source</Label>
                              <Select
                                id="review-source-kind"
                                emptyOptionLabel="Not recorded"
                                options={REVIEW_SOURCE_KINDS.map((k) => ({
                                  value: k.value,
                                  label: k.label,
                                }))}
                                value={sourceKind}
                                onChange={(e) =>
                                  setSourceKind(
                                    e.target.value as ReviewSourceKind | "",
                                  )
                                }
                              />
                            </div>
                            <div className="flex-1 min-w-[240px]">
                              <Label htmlFor="review-source-ref">
                                Reference
                              </Label>
                              <Input
                                id="review-source-ref"
                                placeholder="e.g. AirFit N20 fitting template rev C"
                                value={sourceRef}
                                onChange={(e) => setSourceRef(e.target.value)}
                              />
                            </div>
                            <Button
                              onClick={() =>
                                reviewAll.mutate(pendingVariantIds)
                              }
                              disabled={reviewAll.isPending}
                            >
                              {reviewAll.isPending
                                ? "Signing off…"
                                : `Sign off all ${pendingVariantIds.length} remaining`}
                            </Button>
                          </div>
                          {reviewAll.isError ? (
                            <p className="text-xs text-destructive mt-2">
                              Could not sign these off. Nothing was changed —
                              try again.
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left border-b">
                              <th className="py-1 pr-3">Size</th>
                              <th className="py-1 pr-3">Component</th>
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
                                <td
                                  className="py-1.5 pr-3"
                                  // The citation behind a non-estimated band
                                  // (0495), surfaced where the reviewer is
                                  // already looking.
                                  title={v.fitDataSourceRef ?? undefined}
                                >
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
                                      title={signOffTitle(v)}
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
                        what any other provider on the platform sees. Hover an
                        approved size to see who signed it off and against what.
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

// /admin/fitter/formulary — the multi-axis provider formulary.
//
// The "Test a scenario" panel is the most important thing on this page.
// Multi-axis precedence — contract beats payer beats location beats
// therapy mode beats service line, most specific target wins inside a
// tier, deny beats allow on a tie — is not something a human can evaluate
// by reading a list of rules. Being able to see, per synthetic face, what
// is allowed and which rule denied what is the difference between a
// configurable formulary and an unusable one.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListFilter } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  createFormularyRule,
  deleteFormularyRule,
  fetchFormulary,
  fetchMaskCatalog,
  publishFormulary,
  simulateFormulary,
  updateFormulary,
  type FormularyRule,
} from "@/lib/admin/fitting-api";

const QUERY_KEY = ["admin", "formulary"] as const;

const EFFECT_LABELS: Record<FormularyRule["effect"], string> = {
  allow: "Allow",
  deny: "Do not dispense",
  prefer: "Prefer",
  deprioritize: "Deprioritise",
};

const TARGET_KINDS = [
  { value: "manufacturer", label: "A manufacturer" },
  { value: "interface_type", label: "An interface type" },
  { value: "mask_model", label: "One mask model" },
  { value: "all", label: "Everything" },
] as const;

const INTERFACE_TYPES = [
  "nasal",
  "nasal_pillow",
  "nasal_cradle",
  "hybrid",
  "full_face",
  "total_face",
  "oral",
];

function describeScope(rule: FormularyRule): string {
  const parts: string[] = [];
  if (rule.contractRef) parts.push(`contract ${rule.contractRef}`);
  if (rule.payerProfileId) parts.push("a specific payer");
  if (rule.locationId) parts.push("a specific location");
  if (rule.therapyMode) parts.push(rule.therapyMode.toUpperCase());
  if (rule.serviceLine) parts.push(rule.serviceLine);
  return parts.length > 0 ? `when ${parts.join(", ")}` : "everywhere";
}

function describeTarget(rule: FormularyRule): string {
  switch (rule.targetKind) {
    case "manufacturer":
      return rule.targetManufacturer ?? "a manufacturer";
    case "interface_type":
      return (rule.targetInterfaceType ?? "").replace(/_/g, " ");
    case "mask_model":
      return "one mask model";
    case "size_variant":
      return "one size";
    default:
      return "everything";
  }
}

export function AdminFormularyPage() {
  const queryClient = useQueryClient();
  const [confirm, confirmDialog] = useConfirmDialog();
  const [showSimulation, setShowSimulation] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [ruleError, setRuleError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");

  const [draft, setDraft] = useState({
    targetKind: "manufacturer" as (typeof TARGET_KINDS)[number]["value"],
    targetManufacturer: "",
    targetInterfaceType: "",
    targetMaskModelId: "",
    effect: "prefer" as FormularyRule["effect"],
    preferenceRank: 1,
    serviceLine: "" as "" | "adult" | "pediatric",
    therapyMode: "" as "" | "pap" | "niv",
    contractRef: "",
    reasonCode: "",
    reasonNote: "",
  });

  const formulary = useQuery({ queryKey: QUERY_KEY, queryFn: fetchFormulary });

  const simulation = useQuery({
    queryKey: [...QUERY_KEY, "simulate"],
    queryFn: () => simulateFormulary({}),
    enabled: showSimulation,
  });

  // Backing list for the "One mask model" target. Without it that option
  // was unusable — the rule needs a catalog UUID and there was nowhere to
  // get one short of reading the database by hand.
  const models = useQuery({
    queryKey: ["admin", "mask-catalog", "formulary-picker", modelSearch],
    queryFn: () =>
      fetchMaskCatalog({
        search: modelSearch || undefined,
        status: "current",
        limit: 50,
      }),
    enabled: draft.targetKind === "mask_model",
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  const addRule = useMutation({
    mutationFn: () =>
      createFormularyRule({
        targetKind: draft.targetKind,
        targetManufacturer:
          draft.targetKind === "manufacturer"
            ? draft.targetManufacturer.trim()
            : null,
        targetInterfaceType:
          draft.targetKind === "interface_type"
            ? draft.targetInterfaceType
            : null,
        targetMaskModelId:
          draft.targetKind === "mask_model" ? draft.targetMaskModelId : null,
        effect: draft.effect,
        preferenceRank: draft.effect === "prefer" ? draft.preferenceRank : null,
        serviceLine: draft.serviceLine || null,
        therapyMode: draft.therapyMode || null,
        contractRef: draft.contractRef.trim() || null,
        reasonCode: draft.reasonCode.trim() || null,
        reasonNote: draft.reasonNote.trim() || null,
      }),
    onSuccess: () => {
      setRuleError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      // Saving now runs the same starvation pre-flight as publishing,
      // because a saved rule is live immediately. Say so plainly.
      const body = (err as { body?: { error?: string; message?: string } })
        ?.body;
      setRuleError(
        body?.error === "formulary_would_exclude_all"
          ? (body.message ??
              "This rule would leave some patients with no dispensable mask.")
          : "Couldn't save the rule. Try again.",
      );
    },
  });

  const removeRule = useMutation({
    mutationFn: (id: string) => deleteFormularyRule(id),
    onSuccess: invalidate,
  });

  const setPosture = useMutation({
    mutationFn: (posture: "open" | "closed") =>
      updateFormulary({ defaultPosture: posture }),
    onSuccess: () => {
      setPublishError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      // Closing a formulary with no allow rules denies everything. The
      // route refuses; explain why rather than failing generically.
      const body = (err as { body?: { error?: string; message?: string } })
        ?.body;
      setPublishError(
        body?.error === "formulary_would_exclude_all"
          ? (body.message ??
              "A closed formulary needs allow rules before it can be closed.")
          : "Couldn't change the formulary posture. Try again.",
      );
    },
  });

  const publish = useMutation({
    mutationFn: publishFormulary,
    onSuccess: () => {
      setPublishError(null);
      invalidate();
    },
    onError: (err: unknown) => {
      // The pre-flight refuses to publish a formulary that would leave a
      // patient with nothing dispensable — surface that plainly rather
      // than as a generic failure.
      const body = (err as { body?: { error?: string; message?: string } })
        ?.body;
      setPublishError(
        body?.error === "formulary_would_exclude_all"
          ? (body.message ??
              "This formulary would leave some patients with no dispensable mask.")
          : "Couldn't publish the formulary. Try again.",
      );
    },
  });

  const rules = formulary.data?.rules ?? [];
  const current = formulary.data?.formulary ?? null;

  return (
    <div className="admin-root space-y-4">
      {confirmDialog}
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <ListFilter size={20} aria-hidden="true" />
          Formulary
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          What your organisation actually dispenses, by location, payer,
          contract, service line, and therapy mode. Formulary rules shape the
          recommendation but never override it: a mask ruled out on safety or
          therapy compatibility stays out regardless, and if the clinical tiers
          leave only off-formulary options the best one is still shown, flagged,
          for a clinician to decide.
        </p>
      </header>

      {formulary.isError ? (
        <ErrorPanel
          title="Couldn't load the formulary"
          error={formulary.error}
          onRetry={() => void formulary.refetch()}
        />
      ) : null}
      {formulary.isLoading ? <Spinner /> : null}

      {current ? (
        <Card>
          <div className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{current.name}</p>
              <p className="text-xs text-muted-foreground">
                Version {current.version}
                {current.publishedAt
                  ? ` · published ${new Date(current.publishedAt).toLocaleDateString()}`
                  : " · never published"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>
                {current.defaultPosture === "open"
                  ? "Open — anything not denied is dispensable"
                  : "Closed — only what you explicitly allow"}
              </Badge>
              <Button
                intent="secondary"
                onClick={() =>
                  setPosture.mutate(
                    current.defaultPosture === "open" ? "closed" : "open",
                  )
                }
                disabled={setPosture.isPending}
              >
                Switch to{" "}
                {current.defaultPosture === "open" ? "closed" : "open"}
              </Button>
              <Button
                onClick={() => publish.mutate()}
                disabled={publish.isPending}
              >
                Publish
              </Button>
            </div>
          </div>
          {publishError ? (
            <p className="px-4 pb-4 text-sm text-rose-700">{publishError}</p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className="p-4 space-y-3">
          <h2 className="font-medium">Add a rule</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="rule-effect">Effect</Label>
              <select
                id="rule-effect"
                className="border rounded h-9 px-2 text-sm w-full"
                value={draft.effect}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    effect: e.target.value as FormularyRule["effect"],
                  })
                }
              >
                {Object.entries(EFFECT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="rule-target-kind">Applies to</Label>
              <select
                id="rule-target-kind"
                className="border rounded h-9 px-2 text-sm w-full"
                value={draft.targetKind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    targetKind: e.target
                      .value as (typeof TARGET_KINDS)[number]["value"],
                  })
                }
              >
                {TARGET_KINDS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {draft.targetKind === "manufacturer" ? (
              <div>
                <Label htmlFor="rule-manufacturer">Manufacturer</Label>
                <Input
                  id="rule-manufacturer"
                  value={draft.targetManufacturer}
                  onChange={(e) =>
                    setDraft({ ...draft, targetManufacturer: e.target.value })
                  }
                  placeholder="ResMed"
                />
              </div>
            ) : null}

            {draft.targetKind === "interface_type" ? (
              <div>
                <Label htmlFor="rule-interface">Interface type</Label>
                <select
                  id="rule-interface"
                  className="border rounded h-9 px-2 text-sm w-full"
                  value={draft.targetInterfaceType}
                  onChange={(e) =>
                    setDraft({ ...draft, targetInterfaceType: e.target.value })
                  }
                >
                  <option value="">Choose…</option>
                  {INTERFACE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {draft.targetKind === "mask_model" ? (
              <>
                <div>
                  <Label htmlFor="rule-model-search">Find a mask</Label>
                  <Input
                    id="rule-model-search"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="AirFit, DreamWear, Evora…"
                  />
                </div>
                <div>
                  <Label htmlFor="rule-model">Mask model</Label>
                  <select
                    id="rule-model"
                    className="border rounded h-9 px-2 text-sm w-full"
                    value={draft.targetMaskModelId}
                    onChange={(e) =>
                      setDraft({ ...draft, targetMaskModelId: e.target.value })
                    }
                  >
                    <option value="">
                      {models.isLoading ? "Loading…" : "Choose…"}
                    </option>
                    {(models.data?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.manufacturer} {m.modelName}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            {draft.effect === "prefer" ? (
              <div>
                <Label htmlFor="rule-rank">Preference rank (1 = first)</Label>
                <Input
                  id="rule-rank"
                  type="number"
                  min={1}
                  max={99}
                  value={draft.preferenceRank}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      preferenceRank: Number(e.target.value) || 1,
                    })
                  }
                />
              </div>
            ) : null}

            <div>
              <Label htmlFor="rule-service-line">Service line</Label>
              <select
                id="rule-service-line"
                className="border rounded h-9 px-2 text-sm w-full"
                value={draft.serviceLine}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    serviceLine: e.target.value as "" | "adult" | "pediatric",
                  })
                }
              >
                <option value="">Any</option>
                <option value="adult">Adult</option>
                <option value="pediatric">Pediatric</option>
              </select>
            </div>

            <div>
              <Label htmlFor="rule-therapy-mode">Therapy mode</Label>
              <select
                id="rule-therapy-mode"
                className="border rounded h-9 px-2 text-sm w-full"
                value={draft.therapyMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    therapyMode: e.target.value as "" | "pap" | "niv",
                  })
                }
              >
                <option value="">Any</option>
                <option value="pap">PAP</option>
                <option value="niv">NIV</option>
              </select>
            </div>

            <div>
              <Label htmlFor="rule-contract">Contract reference</Label>
              <Input
                id="rule-contract"
                value={draft.contractRef}
                onChange={(e) =>
                  setDraft({ ...draft, contractRef: e.target.value })
                }
                placeholder="Optional"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <Label htmlFor="rule-note">
                Internal note (staff only — never shown to patients)
              </Label>
              <Input
                id="rule-note"
                value={draft.reasonNote}
                onChange={(e) =>
                  setDraft({ ...draft, reasonNote: e.target.value })
                }
                placeholder="Why this rule exists"
              />
            </div>
          </div>

          {ruleError ? (
            <div
              className="text-sm rounded border px-3 py-2 mb-3 bg-amber-50 text-amber-900 border-amber-200"
              role="alert"
            >
              {ruleError}
            </div>
          ) : null}

          <Button
            onClick={() => addRule.mutate()}
            disabled={
              addRule.isPending ||
              (draft.targetKind === "manufacturer" &&
                draft.targetManufacturer.trim() === "") ||
              (draft.targetKind === "interface_type" &&
                draft.targetInterfaceType === "") ||
              (draft.targetKind === "mask_model" &&
                draft.targetMaskModelId === "")
            }
          >
            Add rule
          </Button>
        </div>
      </Card>

      <Card>
        <div className="p-4">
          <h2 className="font-medium mb-2">Rules ({rules.length})</h2>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rules yet. With an open posture and no rules, every mask in the
              catalog is dispensable — which is exactly how the fitter behaved
              before formularies existed.
            </p>
          ) : (
            <ul className="space-y-2">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-start justify-between gap-2 border-b pb-2 last:border-0"
                >
                  <div className="text-sm">
                    <span className="font-medium">
                      {EFFECT_LABELS[rule.effect]}
                    </span>{" "}
                    {describeTarget(rule)} {describeScope(rule)}
                    {rule.effect === "prefer" && rule.preferenceRank
                      ? ` (rank ${rule.preferenceRank})`
                      : ""}
                    {rule.reasonNote ? (
                      <p className="text-xs text-muted-foreground">
                        {rule.reasonNote}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    intent="secondary"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Remove this rule?",
                        description:
                          "Recommendations stop applying it immediately.",
                        confirmLabel: "Remove",
                        destructive: true,
                      });
                      if (ok) removeRule.mutate(rule.id);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">Test a scenario</h2>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Runs your rules against a set of synthetic faces — no patient
                data is used — and shows what each one would be offered, plus
                which rule denied what. Worth checking before publishing:
                precedence across five axes is hard to predict by reading.
              </p>
            </div>
            <Button
              intent="secondary"
              onClick={() => setShowSimulation((v) => !v)}
              aria-expanded={showSimulation}
            >
              {showSimulation ? "Hide" : "Run test"}
            </Button>
          </div>

          {showSimulation && simulation.isLoading ? <Spinner /> : null}
          {showSimulation && simulation.data ? (
            <div className="space-y-3">
              {simulation.data.panel.map((p) => (
                <div key={p.label} className="border rounded p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-sm">{p.label}</p>
                    <Badge>{p.allowedCount} dispensable</Badge>
                    {p.deniedCount > 0 ? (
                      <Badge>{p.deniedCount} denied</Badge>
                    ) : null}
                    {p.allowedCount === 0 ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded border bg-rose-50 text-rose-800 border-rose-200">
                        Nothing dispensable — this would block every patient
                      </span>
                    ) : null}
                  </div>
                  {p.preferred.length > 0 ? (
                    <p className="text-xs mt-1">
                      Preferred: {p.preferred.map((x) => x.mask).join(", ")}
                    </p>
                  ) : null}
                  {p.denied.length > 0 ? (
                    <details className="mt-1">
                      <summary className="text-xs cursor-pointer">
                        Show what was denied
                      </summary>
                      <ul className="text-xs mt-1 space-y-0.5">
                        {p.denied.map((d) => (
                          <li key={d.mask}>
                            {d.mask}
                            {d.reasonCode ? ` — ${d.reasonCode}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

export default AdminFormularyPage;

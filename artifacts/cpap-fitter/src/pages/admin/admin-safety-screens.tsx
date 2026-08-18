// /admin/fitter/safety-screens — author the questions the fitter asks
// before it will recommend a mask.
//
// Why this page exists: the screening has been versioned data since
// migration 0484 — every answer is stamped with the version that asked it,
// and the fit report prints that label so a report reprinted a year later
// shows the questions that actually ran. What was missing was any way to
// AUTHOR a version. A tenant facing a revised manufacturer warning had no
// move except to ask us to ship a migration.
//
// The workflow this page implements, and the reasoning behind it:
//
//   * A tenant never edits the platform set. It is the shared clinical
//     baseline; a tenant publishes its OWN set, which overrides it.
//   * A published set is immutable. Answers already stored are stamped
//     with its label, so editing it in place would change what those
//     answers mean. Revising = clone to a draft, edit, publish.
//   * A new draft is cloned from whatever is active, never blank. Revising
//     almost always means changing one question, and a blank start would
//     make the common case the most dangerous one — publishing a set that
//     quietly dropped four of the six questions.
//   * Retiring reverts to the PLATFORM set, not to no screening at all.
//     That is what makes retire a safe button to offer.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label, Select } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  listSafetyScreens,
  createSafetyScreenDraft,
  updateSafetyScreenDraft,
  replaceSafetyScreenQuestions,
  publishSafetyScreen,
  retireSafetyScreen,
  deleteSafetyScreenDraft,
  type SafetyScreenQuestion,
  type SafetyScreenVersion,
} from "@/lib/admin/fitting-api";

const QUERY_KEY = ["admin", "safety-screens"] as const;

type DraftQuestion = Omit<SafetyScreenQuestion, "id"> & { id?: string };

// The risk is proximity, so "who is this about?" is a real clinical
// distinction rather than a label — a household question answered for the
// patient is the same as not asking it.
const SUBJECT_OPTIONS = [
  { value: "patient", label: "Patient" },
  { value: "household", label: "Household" },
] as const;

function statusTone(status: SafetyScreenVersion["status"]) {
  if (status === "active") return "Active";
  if (status === "draft") return "Draft";
  return "Retired";
}

export function AdminSafetyScreensPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: listSafetyScreens });
  const [openId, setOpenId] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: QUERY_KEY });
  };
  const onError = (e: unknown) => {
    setActionError(
      e instanceof Error ? e.message : "That didn't work. Please try again.",
    );
  };

  const create = useMutation({
    mutationFn: () => createSafetyScreenDraft({ version: newVersion.trim() }),
    onSuccess: (r) => {
      setNewVersion("");
      setActionError(null);
      setOpenId(r.id);
      invalidate();
    },
    onError,
  });
  const publish = useMutation({
    mutationFn: (id: string) => publishSafetyScreen(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError,
  });
  const retire = useMutation({
    mutationFn: (id: string) => retireSafetyScreen(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError,
  });
  const discard = useMutation({
    mutationFn: (id: string) => deleteSafetyScreenDraft(id),
    onSuccess: () => {
      setOpenId(null);
      setActionError(null);
      invalidate();
    },
    onError,
  });

  const versions = query.data?.versions ?? [];
  const active = versions.find((v) => v.id === query.data?.activeVersionId);

  return (
    <div className="admin-root space-y-4">
      <PageHeader
        icon={ShieldAlert}
        title="Safety screening"
        description="The questions a patient answers before the fitter will recommend a mask. Every answer is stamped with the version that asked it, and the fit report prints that label — so a report reprinted next year shows the questions that actually ran."
      />

      {query.isError ? (
        <ErrorPanel
          error={query.error}
          onRetry={() => void query.refetch()}
          title="Couldn't load safety screening"
        />
      ) : null}
      {query.isPending ? <Spinner /> : null}

      {active ? (
        <Card>
          <div className="p-4">
            <p className="text-sm font-medium">
              Patients are currently asked: {active.title}{" "}
              <Badge>{active.version}</Badge>
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {query.data?.usingPlatformDefault
                ? "This is the platform-published set. Publish your own version below to override it — for example when a manufacturer revises a warning."
                : "This is your organization's own set. Retire it to go back to the platform-published questions."}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {active.questions.length} question
              {active.questions.length === 1 ? "" : "s"} ·{" "}
              {active.questions.filter((q) => q.subject === "household").length}{" "}
              about the household
            </p>
            {!query.data?.usingPlatformDefault ? (
              <Button
                intent="secondary"
                className="mt-3"
                onClick={() => retire.mutate(active.id)}
                disabled={retire.isPending}
              >
                {retire.isPending
                  ? "Retiring…"
                  : "Retire — go back to the platform questions"}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="p-4 space-y-2">
          <p className="text-sm font-medium">Start a new version</p>
          <p className="text-xs text-muted-foreground">
            The draft is copied from whatever set is active right now, so you
            edit rather than start from nothing. Label it however your source
            does — a manufacturer&apos;s own notice reference is usually the
            most useful thing to be able to look up later.
          </p>
          <div className="flex flex-wrap gap-2 items-end pt-1">
            <div className="min-w-[240px]">
              <Label htmlFor="new-screen-version">Version label</Label>
              <Input
                id="new-screen-version"
                value={newVersion}
                placeholder="e.g. 2026-09.v2 or ResMed FSN 2026-09"
                onChange={(e) => setNewVersion(e.target.value)}
              />
            </div>
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || newVersion.trim().length === 0}
            >
              {create.isPending ? "Creating…" : "Create draft"}
            </Button>
          </div>
        </div>
      </Card>

      {actionError ? (
        <p className="text-sm text-destructive">{actionError}</p>
      ) : null}

      <div className="space-y-2">
        {versions.map((v) => (
          <Card key={v.id}>
            <div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {v.title} <Badge>{v.version}</Badge>{" "}
                    <Badge>{statusTone(v.status)}</Badge>
                    {v.isPlatform ? <Badge>Platform</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {v.questions.length} questions
                    {v.manufacturer ? ` · ${v.manufacturer}` : ""}
                    {v.effectiveFrom ? ` · effective ${v.effectiveFrom}` : ""}
                    {v.retiredOn ? ` · retired ${v.retiredOn}` : ""}
                  </p>
                  {v.isPlatform ? (
                    <p className="text-xs text-muted-foreground mt-1">
                      Published by the platform and shared with every provider —
                      read-only here. Create your own version to change what
                      your patients are asked.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    intent="secondary"
                    onClick={() => setOpenId(openId === v.id ? null : v.id)}
                    aria-expanded={openId === v.id}
                  >
                    {openId === v.id ? "Hide questions" : "View questions"}
                  </Button>
                  {v.status === "draft" && !v.isPlatform ? (
                    <>
                      <Button
                        onClick={() => publish.mutate(v.id)}
                        disabled={publish.isPending || v.questions.length === 0}
                      >
                        {publish.isPending ? "Publishing…" : "Publish"}
                      </Button>
                      <Button
                        intent="secondary"
                        onClick={() => discard.mutate(v.id)}
                        disabled={discard.isPending}
                      >
                        Discard
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {openId === v.id ? (
                <QuestionEditor
                  version={v}
                  onSaved={() => {
                    setActionError(null);
                    invalidate();
                  }}
                  onError={onError}
                />
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * The question list for one version.
 *
 * Editable only for a tenant-owned DRAFT. An active or platform set
 * renders read-only, which is the point: what a patient was asked has to
 * stay recoverable from the label their answers carry.
 */
function QuestionEditor({
  version,
  onSaved,
  onError,
}: {
  version: SafetyScreenVersion;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const editable = version.status === "draft" && !version.isPlatform;
  const [rows, setRows] = useState<DraftQuestion[]>(() =>
    version.questions.map((q) => ({ ...q })),
  );
  const [title, setTitle] = useState(version.title);
  const [attestation, setAttestation] = useState(version.attestationCopy);

  const save = useMutation({
    mutationFn: async () => {
      await updateSafetyScreenDraft(version.id, {
        title,
        attestationCopy: attestation,
      });
      await replaceSafetyScreenQuestions(
        version.id,
        rows.map((r, i) => ({
          questionKey: r.questionKey,
          prompt: r.prompt,
          helpText: r.helpText ?? null,
          subject: r.subject,
          sortOrder: (i + 1) * 10,
          riskFlag: r.riskFlag,
          disqualifiesAttribute: r.disqualifiesAttribute ?? null,
          severity: r.severity,
          unsureBehavesAs: r.unsureBehavesAs,
        })),
      );
    },
    onSuccess: onSaved,
    onError,
  });

  const duplicateKey = useMemo(() => {
    const keys = rows.map((r) => r.questionKey.trim());
    return keys.length !== new Set(keys).size;
  }, [rows]);

  const update = (i: number, patch: Partial<DraftQuestion>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="mt-4 border-t pt-3 space-y-3">
      {editable ? (
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[240px]">
            <Label htmlFor={`title-${version.id}`}>Screen title</Label>
            <Input
              id={`title-${version.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-[320px]">
            <Label htmlFor={`attest-${version.id}`}>
              Attestation the patient confirms
            </Label>
            <Input
              id={`attest-${version.id}`}
              value={attestation}
              onChange={(e) => setAttestation(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left border-b">
              <th className="py-1 pr-3">Key</th>
              <th className="py-1 pr-3">Question</th>
              <th className="py-1 pr-3">About</th>
              <th className="py-1 pr-3">On yes</th>
              <th className="py-1 pr-3">On not sure</th>
              {editable ? <th className="py-1" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((q, i) => (
              <tr className="border-b last:border-0" key={q.questionKey || i}>
                <td className="py-1.5 pr-3 font-mono">
                  {editable ? (
                    <Input
                      aria-label="Question key"
                      value={q.questionKey}
                      onChange={(e) =>
                        update(i, { questionKey: e.target.value })
                      }
                    />
                  ) : (
                    q.questionKey
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {editable ? (
                    <Input
                      aria-label="Prompt"
                      value={q.prompt}
                      onChange={(e) => update(i, { prompt: e.target.value })}
                    />
                  ) : (
                    q.prompt
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {editable ? (
                    <Select
                      aria-label="Subject"
                      value={q.subject}
                      options={SUBJECT_OPTIONS}
                      onChange={(e) =>
                        update(i, {
                          subject: e.target.value as "patient" | "household",
                        })
                      }
                    />
                  ) : q.subject === "household" ? (
                    "Household"
                  ) : (
                    "Patient"
                  )}
                </td>
                <td className="py-1.5 pr-3">{q.severity}</td>
                <td className="py-1.5 pr-3">{q.unsureBehavesAs}</td>
                {editable ? (
                  <td className="py-1.5">
                    <Button
                      intent="secondary"
                      onClick={() =>
                        setRows((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      Remove
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable ? (
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            intent="secondary"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                {
                  questionKey: "",
                  prompt: "",
                  helpText: null,
                  subject: "patient",
                  sortOrder: (prev.length + 1) * 10,
                  riskFlag: "magnet_implant_patient",
                  disqualifiesAttribute: "has_magnetic_components",
                  severity: "exclude",
                  unsureBehavesAs: "exclude",
                },
              ])
            }
          >
            Add a question
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || duplicateKey || rows.length === 0}
          >
            {save.isPending ? "Saving…" : "Save draft"}
          </Button>
          {duplicateKey ? (
            <span className="text-xs text-destructive">
              Two questions share a key. Keys identify stored answers, so they
              have to be unique.
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {version.status === "active"
            ? "Published sets are read-only: answers already recorded are stamped with this version, so changing it would change what they mean. Create a new version to revise the questions."
            : "This version is retired. It stays here because answers recorded while it was active point at this label."}
        </p>
      )}
    </div>
  );
}

export default AdminSafetyScreensPage;

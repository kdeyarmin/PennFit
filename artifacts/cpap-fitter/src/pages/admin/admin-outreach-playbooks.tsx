// /admin/playbooks — situation-based outreach playbooks.
//
// One place to set up patient/customer contact across SMS, email, and
// phone: a library of "situations" (used the fitter, not meeting
// compliance goals, ready to re-order supplies, ...) where each
// playbook carries a suggested cadence (day offsets), the channel per
// touch, and editable wording templates. Three tabs:
//
//   Library    — browse / edit / create playbooks, start one for a
//                patient (with a schedule preview).
//   Active runs — what's in flight, next touch, cancel.
//   Call queue — due phone touches with the rendered call script;
//                staff complete them with a disposition.
//
// SMS/email touches are sent automatically by the worker dispatcher;
// call touches surface here (calls stay human).

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  BookOpenCheck,
  Mail,
  MessageSquareText,
  Phone,
  Plus,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { AdminModal } from "@/components/admin/AdminModal";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  CALL_OUTCOME_LABELS,
  PLAYBOOK_CATEGORY_LABELS,
  cancelRun,
  completeCallTask,
  createPlaybook,
  listCallQueue,
  listPlaybooks,
  listRuns,
  replacePlaybookSteps,
  searchPatients,
  startPlaybook,
  updatePlaybook,
  type CallOutcome,
  type CallTask,
  type Playbook,
  type PlaybookCategory,
  type PlaybookChannel,
  type PlaybookRun,
  type PlaybookStepDraft,
  type PatientSearchHit,
} from "@/lib/admin/outreach-playbooks-api";

const playbooksKey = ["admin", "outreach-playbooks"] as const;
const runsKey = (status: string) =>
  ["admin", "outreach-playbook-runs", status] as const;
const callQueueKey = ["admin", "outreach-playbook-call-queue"] as const;

const CHANNEL_META: Record<
  PlaybookChannel,
  { label: string; Icon: typeof Mail }
> = {
  sms: { label: "SMS", Icon: MessageSquareText },
  email: { label: "Email", Icon: Mail },
  call: { label: "Call", Icon: Phone },
};

function channelChip(channel: PlaybookChannel, dayOffset: number) {
  const { label, Icon } = CHANNEL_META[channel];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{
        borderColor: "hsl(var(--line-2))",
        color: "hsl(var(--ink-2))",
        background: "hsl(var(--surface-2))",
      }}
    >
      <Icon className="h-3 w-3" />
      Day {dayOffset} · {label}
    </span>
  );
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const d = data as { message?: string; problems?: string[] };
      if (Array.isArray(d.problems) && d.problems.length > 0) {
        return d.problems.join(" ");
      }
      if (d.message) return d.message;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

type Tab = "library" | "runs" | "calls";

export function AdminOutreachPlaybooksPage() {
  const [tab, setTab] = useState<Tab>("library");
  const callQueue = useQuery({
    queryKey: callQueueKey,
    queryFn: listCallQueue,
  });
  const dueCalls = callQueue.data?.tasks.length ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BookOpenCheck className="h-6 w-6" />
          Outreach playbooks
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Ready-made contact plans by situation — each playbook bundles the
          cadence, the channel per touch (SMS, email, phone), and the wording.
          Start one for a patient and the texts and emails send themselves;
          phone touches land in the call queue with a script.
        </p>
      </header>

      <nav
        className="flex gap-2 border-b"
        style={{ borderColor: "hsl(var(--line-2))" }}
      >
        {(
          [
            ["library", "Library"],
            ["runs", "Active runs"],
            ["calls", dueCalls > 0 ? `Call queue (${dueCalls})` : "Call queue"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className="px-3 py-2 text-sm font-semibold -mb-px border-b-2"
            style={
              tab === key
                ? {
                    borderColor: "hsl(var(--penn-navy, 215 49% 24%))",
                    color: "hsl(var(--ink-1))",
                  }
                : { borderColor: "transparent", color: "hsl(var(--ink-3))" }
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "library" && <LibraryTab />}
      {tab === "runs" && <RunsTab />}
      {tab === "calls" && <CallQueueTab />}
    </div>
  );
}

// ---------------------------------------------------------------
// Library
// ---------------------------------------------------------------

function LibraryTab() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: playbooksKey,
    queryFn: listPlaybooks,
  });
  const [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const [starting, setStarting] = useState<Playbook | null>(null);

  const grouped = useMemo(() => {
    const groups = new Map<string, Playbook[]>();
    for (const p of data?.playbooks ?? []) {
      const list = groups.get(p.category) ?? [];
      list.push(p);
      groups.set(p.category, list);
    }
    return [...groups.entries()];
  }, [data]);

  if (isPending) return <Spinner />;
  if (isError) {
    return <ErrorPanel error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4 mr-1.5" />
          New playbook
        </Button>
      </div>

      {grouped.map(([category, playbooks]) => (
        <section key={category} className="space-y-3">
          <h2
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {PLAYBOOK_CATEGORY_LABELS[category as PlaybookCategory] ?? category}
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {playbooks.map((p) => (
              <Card key={p.id}>
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold flex items-center gap-2">
                        {p.name}
                        {!p.isActive && (
                          <span
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{
                              background: "hsl(var(--surface-2))",
                              color: "hsl(var(--ink-3))",
                            }}
                          >
                            Inactive
                          </span>
                        )}
                      </h3>
                      <p
                        className="text-sm mt-1"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        <strong>When to use:</strong> {p.situation}
                      </p>
                      {p.description && (
                        <p
                          className="text-sm mt-1"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {p.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {p.steps.map((s) => (
                      <span key={s.id}>
                        {channelChip(s.channel, s.dayOffset)}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span
                      className="text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {p.activeRunCount > 0
                        ? `${p.activeRunCount} patient${p.activeRunCount === 1 ? "" : "s"} in flight`
                        : "No active runs"}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        intent="secondary"
                        size="sm"
                        onClick={() => setEditing(p)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        disabled={!p.isActive || p.steps.length === 0}
                        onClick={() => setStarting(p)}
                      >
                        Start for patient
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <PlaybookEditorModal
          playbook={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {starting && (
        <StartPlaybookModal
          playbook={starting}
          onClose={() => setStarting(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Editor (create + edit)
// ---------------------------------------------------------------

const textareaClass =
  "block w-full rounded-md border px-3 py-1.5 text-sm bg-white";
const textareaStyle = {
  borderColor: "hsl(var(--line-2))",
  color: "hsl(var(--ink-1))",
} as const;

function PlaybookEditorModal({
  playbook,
  onClose,
}: {
  playbook: Playbook | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(playbook?.name ?? "");
  const [situation, setSituation] = useState(playbook?.situation ?? "");
  const [description, setDescription] = useState(playbook?.description ?? "");
  const [category, setCategory] = useState<PlaybookCategory>(
    playbook?.category ?? "engagement",
  );
  const [isActive, setIsActive] = useState(playbook?.isActive ?? true);
  const [steps, setSteps] = useState<PlaybookStepDraft[]>(
    playbook?.steps.map((s) => ({
      dayOffset: s.dayOffset,
      channel: s.channel,
      subject: s.subject,
      body: s.body,
    })) ?? [{ dayOffset: 0, channel: "sms", subject: null, body: "" }],
  );
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (playbook) {
        await updatePlaybook(playbook.id, {
          name,
          situation,
          description: description.trim() ? description : null,
          category,
          isActive,
        });
        await replacePlaybookSteps(playbook.id, steps);
      } else {
        await createPlaybook({
          name,
          situation,
          description: description.trim() ? description : null,
          category,
          steps,
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: playbooksKey });
      onClose();
    },
    onError: (err) => setFormError(errMessage(err)),
  });

  const setStep = (i: number, patch: Partial<PlaybookStepDraft>) => {
    setSteps((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  };

  return (
    <AdminModal
      title={playbook ? `Edit “${playbook.name}”` : "New playbook"}
      description="Cadence and wording. You can use {{first_name}} and {{practice_name}} in any subject, message, or call script."
      onClose={onClose}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label htmlFor="pb-name">Name</Label>
            <Input
              id="pb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Supplies due for re-order"
            />
          </div>
          <div>
            <Label htmlFor="pb-category">Category</Label>
            <Select
              id="pb-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as PlaybookCategory)}
              options={Object.entries(PLAYBOOK_CATEGORY_LABELS).map(
                ([value, label]) => ({ value, label }),
              )}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="pb-situation">When to use (the situation)</Label>
          <textarea
            id="pb-situation"
            rows={2}
            className={textareaClass}
            style={textareaStyle}
            value={situation}
            onChange={(e) => setSituation(e.target.value)}
            placeholder="e.g. The patient is eligible to re-order supplies but hasn't placed the order."
          />
        </div>
        <div>
          <Label htmlFor="pb-description">Description (optional)</Label>
          <textarea
            id="pb-description"
            rows={2}
            className={textareaClass}
            style={textareaStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Touches</h3>
          {steps.map((s, i) => (
            <div
              key={i}
              className="rounded-md border p-3 space-y-2"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-24">
                  <Label htmlFor={`step-day-${i}`}>Day</Label>
                  <Input
                    id={`step-day-${i}`}
                    type="number"
                    min={0}
                    max={365}
                    value={s.dayOffset}
                    onChange={(e) =>
                      setStep(i, {
                        dayOffset: Math.max(
                          0,
                          Math.min(365, Number(e.target.value) || 0),
                        ),
                      })
                    }
                  />
                </div>
                <div className="w-36">
                  <Label htmlFor={`step-channel-${i}`}>Channel</Label>
                  <Select
                    id={`step-channel-${i}`}
                    value={s.channel}
                    onChange={(e) => {
                      const channel = e.target.value as PlaybookChannel;
                      setStep(i, {
                        channel,
                        subject: channel === "email" ? (s.subject ?? "") : null,
                      });
                    }}
                    options={[
                      { value: "sms", label: "SMS (sends automatically)" },
                      { value: "email", label: "Email (sends automatically)" },
                      { value: "call", label: "Phone call (staff task)" },
                    ]}
                  />
                </div>
                <div className="ml-auto">
                  <Button
                    intent="ghost"
                    size="sm"
                    disabled={steps.length === 1}
                    onClick={() =>
                      setSteps((prev) => prev.filter((_, idx) => idx !== i))
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {s.channel === "email" && (
                <div>
                  <Label htmlFor={`step-subject-${i}`}>Subject</Label>
                  <Input
                    id={`step-subject-${i}`}
                    value={s.subject ?? ""}
                    onChange={(e) => setStep(i, { subject: e.target.value })}
                  />
                </div>
              )}
              <div>
                <Label htmlFor={`step-body-${i}`}>
                  {s.channel === "call"
                    ? "Call script (what staff sees when the call comes due)"
                    : "Message"}
                </Label>
                <textarea
                  id={`step-body-${i}`}
                  rows={s.channel === "sms" ? 3 : 6}
                  className={textareaClass}
                  style={textareaStyle}
                  value={s.body}
                  onChange={(e) => setStep(i, { body: e.target.value })}
                />
                {s.channel === "sms" && (
                  <p
                    className="text-xs mt-1"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {s.body.length} characters — keep SMS short and end with
                    “Reply STOP to opt out.”
                  </p>
                )}
              </div>
            </div>
          ))}
          <Button
            intent="secondary"
            size="sm"
            onClick={() =>
              setSteps((prev) => [
                ...prev,
                {
                  dayOffset: (prev[prev.length - 1]?.dayOffset ?? 0) + 3,
                  channel: "email",
                  subject: "",
                  body: "",
                },
              ])
            }
          >
            <Plus className="h-4 w-4 mr-1" />
            Add touch
          </Button>
        </div>

        {playbook && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active (can be started for patients)
          </label>
        )}

        {formError && (
          <p className="text-sm" style={{ color: "hsl(0 72% 45%)" }}>
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button intent="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            isLoading={save.isPending}
            disabled={!name.trim() || !situation.trim()}
            onClick={() => {
              setFormError(null);
              save.mutate();
            }}
          >
            {playbook ? "Save changes" : "Create playbook"}
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

// ---------------------------------------------------------------
// Start-for-patient
// ---------------------------------------------------------------

function StartPlaybookModal({
  playbook,
  onClose,
}: {
  playbook: Playbook;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PatientSearchHit | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ["admin", "playbook-patient-search", search.trim()],
    queryFn: () => searchPatients(search.trim()),
    enabled: search.trim().length >= 2 && !selected,
  });

  const start = useMutation({
    mutationFn: () => startPlaybook(playbook.id, selected!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: playbooksKey });
      void qc.invalidateQueries({
        queryKey: ["admin", "outreach-playbook-runs"],
      });
      onClose();
    },
    onError: (err) => setFormError(errMessage(err)),
  });

  const now = Date.now();

  return (
    <AdminModal
      title={`Start “${playbook.name}”`}
      description="Pick the patient. SMS and email touches send automatically on schedule; phone touches appear in the call queue."
      onClose={onClose}
    >
      <div className="space-y-4">
        {!selected ? (
          <div>
            <Label htmlFor="start-patient-search">Find patient</Label>
            <Input
              id="start-patient-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, phone, or PacWare ID"
              autoFocus
            />
            {results.isFetching && <Spinner />}
            {results.data && results.data.length === 0 && (
              <p
                className="text-sm mt-2"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                No matching patients.
              </p>
            )}
            {results.data && results.data.length > 0 && (
              <ul
                className="mt-2 rounded-md border divide-y"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                {results.data.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                      onClick={() => setSelected(p)}
                    >
                      {[p.firstName, p.lastName].filter(Boolean).join(" ") ||
                        p.id}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm">
              Starting for{" "}
              <strong>
                {[selected.firstName, selected.lastName]
                  .filter(Boolean)
                  .join(" ")}
              </strong>{" "}
              <Button
                intent="ghost"
                size="sm"
                onClick={() => {
                  setSelected(null);
                  setFormError(null);
                }}
              >
                change
              </Button>
            </p>
            <div>
              <h4 className="text-sm font-semibold mb-1">Planned schedule</h4>
              <ul
                className="space-y-1 text-sm"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                {playbook.steps.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    {channelChip(s.channel, s.dayOffset)}
                    <span style={{ color: "hsl(var(--ink-3))" }}>
                      ~
                      {fmtDateTime(
                        new Date(
                          now + s.dayOffset * 24 * 60 * 60 * 1000,
                        ).toISOString(),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {formError && (
          <p className="text-sm" style={{ color: "hsl(0 72% 45%)" }}>
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button intent="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            isLoading={start.isPending}
            onClick={() => {
              setFormError(null);
              start.mutate();
            }}
          >
            Start playbook
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

// ---------------------------------------------------------------
// Runs
// ---------------------------------------------------------------

function RunsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"active" | "completed" | "cancelled">(
    "active",
  );
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: runsKey(status),
    queryFn: () => listRuns(status),
  });
  const playbooks = useQuery({
    queryKey: playbooksKey,
    queryFn: listPlaybooks,
  });
  const totalSteps = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of playbooks.data?.playbooks ?? []) {
      m.set(p.id, p.steps.length);
    }
    return m;
  }, [playbooks.data]);
  const [confirm, confirmDialog] = useConfirmDialog();

  const cancel = useMutation({
    mutationFn: (id: string) => cancelRun(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: runsKey("active") });
      void qc.invalidateQueries({ queryKey: playbooksKey });
      void qc.invalidateQueries({ queryKey: callQueueKey });
    },
  });

  return (
    <Card>
      {confirmDialog}
      <div className="flex items-center justify-between mb-4">
        <div className="w-44">
          <Label htmlFor="runs-status">Status</Label>
          <Select
            id="runs-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: "active", label: "Active" },
              { value: "completed", label: "Completed" },
              { value: "cancelled", label: "Cancelled" },
            ]}
          />
        </div>
      </div>
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.runs.length === 0 ? (
        <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
          No {status} runs. Start a playbook from the Library tab.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left text-xs uppercase tracking-wide"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              <th className="py-2 pr-3">Patient</th>
              <th className="py-2 pr-3">Playbook</th>
              <th className="py-2 pr-3">Progress</th>
              <th className="py-2 pr-3">Next touch</th>
              <th className="py-2 pr-3">Started by</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r: PlaybookRun) => {
              const total = totalSteps.get(r.playbookId);
              return (
                <tr
                  key={r.id}
                  className="border-t"
                  style={{ borderColor: "hsl(var(--line-2))" }}
                >
                  <td className="py-2 pr-3">
                    <Link
                      href={`/admin/patients/${r.patientId}`}
                      className="underline"
                    >
                      {r.patientName}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">{r.playbookName}</td>
                  <td className="py-2 pr-3">
                    {r.status === "active"
                      ? `Touch ${Math.min(r.nextStepIndex, total ?? r.nextStepIndex)}${total ? ` of ${total}` : ""}`
                      : r.status}
                  </td>
                  <td className="py-2 pr-3">
                    {r.status === "active" ? fmtDateTime(r.nextStepAt) : "—"}
                  </td>
                  <td className="py-2 pr-3">{r.startedByEmail ?? "—"}</td>
                  <td className="py-2 text-right">
                    {r.status === "active" && (
                      <Button
                        intent="ghost"
                        size="sm"
                        isLoading={
                          cancel.isPending && cancel.variables === r.id
                        }
                        onClick={() => {
                          void (async () => {
                            const ok = await confirm({
                              title: "Cancel this run?",
                              description: `Remaining touches of “${r.playbookName}” for ${r.patientName} will not be sent.`,
                              confirmLabel: "Cancel run",
                              destructive: true,
                            });
                            if (ok) cancel.mutate(r.id);
                          })();
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------
// Call queue
// ---------------------------------------------------------------

function CallQueueTab() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: callQueueKey,
    queryFn: listCallQueue,
  });

  if (isPending) return <Spinner />;
  if (isError) {
    return <ErrorPanel error={error} onRetry={() => void refetch()} />;
  }
  if (data.tasks.length === 0) {
    return (
      <Card>
        <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
          No calls due. Phone touches from running playbooks will appear here
          with their script when they come due.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {data.tasks.map((t) => (
        <CallTaskCard
          key={t.id}
          task={t}
          onCompleted={() => {
            void qc.invalidateQueries({ queryKey: callQueueKey });
          }}
        />
      ))}
    </div>
  );
}

function CallTaskCard({
  task,
  onCompleted,
}: {
  task: CallTask;
  onCompleted: () => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>("reached");
  const [formError, setFormError] = useState<string | null>(null);
  const complete = useMutation({
    mutationFn: () => completeCallTask(task.id, outcome),
    onSuccess: onCompleted,
    onError: (err) => setFormError(errMessage(err)),
  });

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Phone className="h-4 w-4" />
              {task.patientId ? (
                <Link
                  href={`/admin/patients/${task.patientId}`}
                  className="underline"
                >
                  {task.patientName}
                </Link>
              ) : (
                task.patientName
              )}
            </h3>
            <p
              className="text-xs mt-0.5"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {task.playbookName} · touch {task.stepIndex} · due since{" "}
              {fmtDateTime(task.dueSince)}
              {!task.hasPhone && " · no phone on file"}
            </p>
          </div>
        </div>
        {task.callScript && (
          <pre
            className="whitespace-pre-wrap rounded-md border p-3 text-sm font-sans"
            style={{
              borderColor: "hsl(var(--line-2))",
              background: "hsl(var(--surface-2))",
              color: "hsl(var(--ink-1))",
            }}
          >
            {task.callScript}
          </pre>
        )}
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Dial from the patient page (click-to-dial bridges your phone first),
          then log the outcome here.
        </p>
        <div className="flex items-end gap-3">
          <div className="w-52">
            <Label htmlFor={`call-outcome-${task.id}`}>Outcome</Label>
            <Select
              id={`call-outcome-${task.id}`}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as CallOutcome)}
              options={Object.entries(CALL_OUTCOME_LABELS).map(
                ([value, label]) => ({ value, label }),
              )}
            />
          </div>
          <Button
            size="sm"
            isLoading={complete.isPending}
            onClick={() => {
              setFormError(null);
              complete.mutate();
            }}
          >
            Mark done
          </Button>
        </div>
        {formError && (
          <p className="text-sm" style={{ color: "hsl(0 72% 45%)" }}>
            {formError}
          </p>
        )}
      </div>
    </Card>
  );
}

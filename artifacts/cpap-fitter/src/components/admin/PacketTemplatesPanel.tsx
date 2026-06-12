// Patient-packet document template manager.
//
// Lets staff VIEW each e-sign document exactly as a patient will see it
// (merge tokens resolved against the live company profile), EDIT the
// wording permanently (a template override applied to every future
// packet), and REVERT to the built-in default. One-off per-packet edits
// live in PacketDocumentCustomizer below, which the send panel embeds.
//
// Content is edited as plain text (see lib/admin/packet-template-text)
// and converted to the server's structured sections on save — never
// HTML, so the patient-facing signing UI keeps its no-markup property.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

import {
  getPacketTemplateHistoryQueryKey,
  getPatientPacketTemplatesQueryKey,
  usePacketTemplateHistory,
  usePatientPacketTemplates,
  usePreviewPacketTemplate,
  useResetPacketTemplate,
  useRestorePacketTemplate,
  useSavePacketTemplate,
  type PacketDocumentSection,
  type PacketMergeToken,
  type PacketTemplateRevision,
  type PatientPacketTemplate,
} from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import {
  sectionsToText,
  textToSections,
} from "@/lib/admin/packet-template-text";

/** Read-only renderer for structured document sections (same shapes the
 *  patient signing UI renders). */
export function PacketSectionsViewer({
  sections,
}: {
  sections: PacketDocumentSection[];
}) {
  return (
    <div className="space-y-3">
      {sections.map((s, i) => (
        <div key={i}>
          {s.heading && (
            <h4
              className="text-sm font-semibold mb-1"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {s.heading}
            </h4>
          )}
          {(s.paragraphs ?? []).map((p, j) => (
            <p
              key={j}
              className="text-sm mb-1.5"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {p}
            </p>
          ))}
          {s.bullets && s.bullets.length > 0 && (
            <ul
              className="text-sm list-disc pl-5 space-y-0.5"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {s.bullets.map((b, j) => (
                <li key={j}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function MergeTokenHelp({ tokens }: { tokens: PacketMergeToken[] }) {
  if (tokens.length === 0) return null;
  return (
    <details className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
      <summary className="cursor-pointer font-medium">
        Merge fields you can use — filled in automatically from the app
      </summary>
      <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {tokens.map((t) => (
          <li key={t.token}>
            <code
              className="rounded px-1"
              style={{ backgroundColor: "hsl(var(--line-1))" }}
            >
              {`{{${t.token}}}`}
            </code>{" "}
            {t.label}
          </li>
        ))}
      </ul>
    </details>
  );
}

const textareaStyle = {
  borderColor: "hsl(var(--line-2))",
  color: "hsl(var(--ink-1))",
} as const;

// ── Template manager panel ────────────────────────────────────────

export function PacketTemplatesPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const templatesQuery = usePatientPacketTemplates();
  const save = useSavePacketTemplate();
  const reset = useResetPacketTemplate();
  const preview = usePreviewPacketTemplate();

  const templates = templatesQuery.data?.templates ?? [];
  const mergeTokens = templatesQuery.data?.mergeTokens ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [previewSections, setPreviewSections] = useState<
    PacketDocumentSection[] | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [error, setError] = useState<string | null>(null);

  const selected = templates.find((t) => t.key === selectedKey) ?? null;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: getPatientPacketTemplatesQueryKey() });

  const openTemplate = async (t: PatientPacketTemplate) => {
    setSelectedKey(t.key);
    setEditing(false);
    setShowHistory(false);
    setMessage(null);
    setError(null);
    setPreviewSections(null);
    try {
      const res = await preview.mutateAsync({ key: t.key });
      setPreviewSections(res.sections);
    } catch {
      // Preview is best-effort; the token-form sections still render.
      setPreviewSections(null);
    }
  };

  const startEditing = (t: PatientPacketTemplate) => {
    setEditing(true);
    setMessage(null);
    setError(null);
    setDraftTitle(t.title);
    setDraftText(sectionsToText(t.sections));
  };

  const handlePreviewDraft = async () => {
    if (!selected) return;
    setError(null);
    const sections = textToSections(draftText);
    if (sections.length === 0) {
      setError("The document needs at least one paragraph or bullet.");
      return;
    }
    try {
      const res = await preview.mutateAsync({ key: selected.key, sections });
      setPreviewSections(res.sections);
      setMessage("Previewing your unsaved edits below.");
    } catch (err) {
      setError(describeError(err).detail ?? "Preview failed.");
    }
  };

  const handleSave = async () => {
    if (!selected) return;
    setError(null);
    setMessage(null);
    const sections = textToSections(draftText);
    if (sections.length === 0) {
      setError("The document needs at least one paragraph or bullet.");
      return;
    }
    try {
      await save.mutateAsync({
        key: selected.key,
        data: { title: draftTitle.trim() || undefined, sections },
      });
      await refresh();
      setEditing(false);
      setMessage(
        "Saved. Every packet sent from now on uses this wording; packets already sent are not changed.",
      );
      const res = await preview
        .mutateAsync({ key: selected.key, sections })
        .catch(() => null);
      setPreviewSections(res?.sections ?? null);
    } catch (err) {
      setError(describeError(err).detail ?? "Save failed.");
    }
  };

  const handleReset = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: "Revert to the built-in wording?",
      description: "Your customized version will be discarded.",
      confirmLabel: "Revert",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    setMessage(null);
    try {
      await reset.mutateAsync({ key: selected.key });
      await refresh();
      setEditing(false);
      setMessage("Reverted to the built-in wording.");
      const res = await preview
        .mutateAsync({ key: selected.key })
        .catch(() => null);
      setPreviewSections(res?.sections ?? null);
    } catch (err) {
      setError(describeError(err).detail ?? "Revert failed.");
    }
  };

  return (
    <Card
      title="Document templates"
      subtitle="View and edit the documents that go into e-sign packets. Edits apply to packets sent afterwards — never to packets already sent or signed."
      action={
        <Button intent="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="p-5 space-y-4">
        {templatesQuery.isPending ? (
          <Spinner label="Loading templates…" />
        ) : templatesQuery.isError ? (
          <ErrorPanel error={templatesQuery.error} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
            {/* Template list */}
            <div className="space-y-1.5">
              {templates.map((t) => {
                const active = t.key === selectedKey;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => void openTemplate(t)}
                    className="block w-full rounded-md border px-3 py-2 text-left text-sm"
                    style={{
                      borderColor: active
                        ? "hsl(var(--penn-navy))"
                        : "hsl(var(--line-1))",
                      backgroundColor: active
                        ? "hsl(var(--penn-navy) / 0.06)"
                        : "white",
                    }}
                  >
                    <span
                      className="font-medium block"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {t.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {t.customized ? (
                        <Badge variant="info">Customized</Badge>
                      ) : (
                        <Badge variant="muted">Default</Badge>
                      )}
                      {!t.requiresSignature && (
                        <Badge variant="muted">Informational</Badge>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Detail / editor */}
            {!selected ? (
              <div
                className="rounded-md border p-6 text-sm"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-3))",
                }}
              >
                Select a document to view or edit it.
              </div>
            ) : (
              <div className="space-y-4 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3
                      className="text-sm font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {selected.title}
                    </h3>
                    <p
                      className="text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      Version {selected.version}
                      {selected.customized && selected.updatedByEmail
                        ? ` · customized by ${selected.updatedByEmail}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {!editing && (
                      <Button
                        intent="secondary"
                        size="sm"
                        onClick={() => startEditing(selected)}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      intent="ghost"
                      size="sm"
                      onClick={() => setShowHistory((s) => !s)}
                    >
                      {showHistory ? "Hide history" : "History"}
                    </Button>
                    {selected.customized && (
                      <Button
                        intent="ghost"
                        size="sm"
                        isLoading={reset.isPending}
                        onClick={handleReset}
                      >
                        Revert to default
                      </Button>
                    )}
                  </div>
                </div>

                {showHistory && (
                  <TemplateHistoryPanel
                    templateKey={selected.key}
                    onRestored={async () => {
                      await refresh();
                      setMessage(
                        "Revision restored — it now applies to every packet sent from now on.",
                      );
                      const res = await preview
                        .mutateAsync({ key: selected.key })
                        .catch(() => null);
                      setPreviewSections(res?.sections ?? null);
                    }}
                  />
                )}

                {editing && (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="tplTitle">Document title</Label>
                      <Input
                        id="tplTitle"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="tplBody">Document content</Label>
                      <textarea
                        id="tplBody"
                        rows={18}
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        className="block w-full rounded-md border px-3 py-2 text-sm bg-white font-mono"
                        style={textareaStyle}
                      />
                      <p
                        className="mt-1 text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        Start a line with <code># </code> for a heading,{" "}
                        <code>- </code> for a bullet; use <code>---</code> on
                        its own line to divide sections, and a blank line to
                        start a new paragraph.
                        {selected.key === "proof_of_delivery" &&
                          " The itemized list of delivered equipment is inserted automatically after the first section."}
                      </p>
                    </div>
                    <MergeTokenHelp tokens={mergeTokens} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        isLoading={save.isPending}
                        onClick={handleSave}
                      >
                        Save for all future packets
                      </Button>
                      <Button
                        intent="secondary"
                        size="sm"
                        isLoading={preview.isPending}
                        onClick={handlePreviewDraft}
                      >
                        Preview
                      </Button>
                      <Button
                        intent="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(false);
                          setError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {message && (
                  <div
                    className="rounded-md p-2.5 text-sm"
                    style={{
                      backgroundColor: "hsl(142 70% 45% / 0.10)",
                      color: "hsl(142 60% 25%)",
                    }}
                  >
                    {message}
                  </div>
                )}
                {error && (
                  <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
                    {error}
                  </div>
                )}

                {/* Patient-eye preview */}
                <div
                  className="rounded-md border p-4 max-h-96 overflow-y-auto"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <p
                    className="mb-2 text-xs font-semibold uppercase tracking-wide"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {previewSections
                      ? "Preview — as the patient sees it"
                      : "Content (merge fields shown unresolved)"}
                  </p>
                  <PacketSectionsViewer
                    sections={previewSections ?? selected.sections}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {ConfirmDialogEl}
    </Card>
  );
}

// ── Template revision history ─────────────────────────────────────
//
// Append-only log of every permanent save/revert: who changed the
// wording, when, with the full content of each saved revision viewable
// and restorable (a restore re-saves it as a NEW revision).
function TemplateHistoryPanel({
  templateKey,
  onRestored,
}: {
  templateKey: string;
  onRestored: () => void | Promise<void>;
}) {
  const qc = useQueryClient();
  const historyQuery = usePacketTemplateHistory(templateKey);
  const restore = useRestorePacketTemplate();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, ConfirmDialogEl] = useConfirmDialog();

  const revisions = historyQuery.data?.revisions ?? [];

  const handleRestore = async (rev: PacketTemplateRevision) => {
    const ok = await confirm({
      title: `Restore revision ${rev.revision ?? "?"}?`,
      description: "It will apply to every packet sent from now on.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setError(null);
    try {
      await restore.mutateAsync({ key: templateKey, revisionId: rev.id });
      await qc.invalidateQueries({
        queryKey: getPacketTemplateHistoryQueryKey(templateKey),
      });
      await onRestored();
    } catch (err) {
      setError(describeError(err).detail ?? "Restore failed.");
    }
  };

  return (
    <div
      className="rounded-md border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <h4
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        Edit history
      </h4>
      {historyQuery.isPending ? (
        <Spinner label="Loading history…" />
      ) : historyQuery.isError ? (
        <ErrorPanel error={historyQuery.error} />
      ) : revisions.length === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No edits recorded yet — history starts with the first save after this
          feature shipped.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {revisions.map((rev) => {
            const when = new Date(rev.created_at).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <li
                key={rev.id}
                className="rounded-md border px-3 py-2"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span style={{ color: "hsl(var(--ink-1))" }}>
                    {rev.action === "saved" ? (
                      <>
                        <Badge variant="info">r{rev.revision}</Badge>{" "}
                        {rev.title ?? "Saved"}
                      </>
                    ) : (
                      <Badge variant="muted">Reverted to default</Badge>
                    )}
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {when}
                    {rev.changed_by_email ? ` · ${rev.changed_by_email}` : ""}
                  </span>
                </div>
                {rev.action === "saved" && rev.sections && (
                  <div className="mt-1 flex gap-3">
                    <button
                      type="button"
                      className="text-xs font-semibold"
                      style={{ color: "hsl(var(--penn-navy))" }}
                      onClick={() =>
                        setOpenId(openId === rev.id ? null : rev.id)
                      }
                    >
                      {openId === rev.id ? "Hide content" : "View content"}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-semibold"
                      style={{ color: "hsl(var(--penn-navy))" }}
                      disabled={restore.isPending}
                      onClick={() => void handleRestore(rev)}
                    >
                      Restore
                    </button>
                  </div>
                )}
                {openId === rev.id && rev.sections && (
                  <div
                    className="mt-2 max-h-64 overflow-y-auto rounded-md border p-3"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <p
                      className="mb-2 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      Merge fields shown unresolved.
                    </p>
                    <PacketSectionsViewer sections={rev.sections} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
          {error}
        </div>
      )}
      {ConfirmDialogEl}
    </div>
  );
}

// ── Per-packet (one-off) document customizer ──────────────────────
//
// Embedded in the send panel under each selected document. Edits here
// apply to the packet being sent and nothing else.

export interface PacketCustomization {
  title: string;
  text: string;
}

export function PacketDocumentCustomizer({
  template,
  mergeTokens,
  value,
  onChange,
}: {
  template: PatientPacketTemplate;
  mergeTokens: PacketMergeToken[];
  value: PacketCustomization | null;
  onChange: (value: PacketCustomization | null) => void;
}) {
  if (value === null) {
    return (
      <button
        type="button"
        className="text-xs font-semibold"
        style={{ color: "hsl(var(--penn-navy))" }}
        onClick={() =>
          onChange({
            title: template.title,
            text: sectionsToText(template.sections),
          })
        }
      >
        Customize for this packet
      </button>
    );
  }
  return (
    <div
      className="mt-2 space-y-2 rounded-md border p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        These edits apply to <strong>this packet only</strong> — the saved
        template is not changed.
      </p>
      <div>
        <Label htmlFor={`cust-title-${template.key}`}>Title</Label>
        <Input
          id={`cust-title-${template.key}`}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`cust-body-${template.key}`}>Content</Label>
        <textarea
          id={`cust-body-${template.key}`}
          rows={10}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          className="block w-full rounded-md border px-3 py-2 text-sm bg-white font-mono"
          style={textareaStyle}
        />
      </div>
      <MergeTokenHelp tokens={mergeTokens} />
      <button
        type="button"
        className="text-xs font-semibold"
        style={{ color: "hsl(0 70% 45%)" }}
        onClick={() => onChange(null)}
      >
        Discard customization
      </button>
    </div>
  );
}

/** Build the documentOverrides payload from the send panel's
 *  customization state, including only documents whose content actually
 *  differs from the current template. */
export function buildDocumentOverrides(
  customizations: Record<string, PacketCustomization | null>,
  templates: PatientPacketTemplate[],
  selectedKeys: string[],
):
  | {
      documentKey: string;
      title?: string;
      sections: PacketDocumentSection[];
    }[]
  | undefined {
  const byKey = new Map(templates.map((t) => [t.key, t]));
  const overrides: {
    documentKey: string;
    title?: string;
    sections: PacketDocumentSection[];
  }[] = [];
  for (const key of selectedKeys) {
    const custom = customizations[key];
    const template = byKey.get(key);
    if (!custom || !template) continue;
    const sections = textToSections(custom.text);
    if (sections.length === 0) continue;
    const titleChanged =
      custom.title.trim().length > 0 && custom.title.trim() !== template.title;
    const textChanged = custom.text !== sectionsToText(template.sections);
    if (!titleChanged && !textChanged) continue;
    overrides.push({
      documentKey: key,
      ...(titleChanged ? { title: custom.title.trim() } : {}),
      sections,
    });
  }
  return overrides.length > 0 ? overrides : undefined;
}

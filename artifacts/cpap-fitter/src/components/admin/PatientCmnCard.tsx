// Patient-page CMN/DIF card (Biller #29). Lists the patient's CMN forms,
// creates a draft (form type + HCPCS), and edits a draft's structured
// answers against the form catalog — Complete is gated server-side on the
// required keys (the gaps come back on a 409 and render inline).
//
// Wrapped in admin-root (it's only rendered inside the admin console).
// patients.update enforced server-side; the card renders for any admin
// surface and surfaces permission errors honestly.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import {
  getCmnCatalog,
  getPatientCmns,
  createCmn,
  patchCmn,
  type CmnDocument,
  type CmnFormDef,
} from "@/lib/admin/cmn-documents-api";

export function PatientCmnCard({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const key = ["admin", "patient-cmns", patientId] as const;
  const catalog = useQuery({
    queryKey: ["admin", "cmn-catalog"] as const,
    queryFn: getCmnCatalog,
    staleTime: 600_000,
  });
  const list = useQuery({
    queryKey: key,
    queryFn: () => getPatientCmns(patientId),
    staleTime: 30_000,
  });

  const [formType, setFormType] = useState("");
  const [hcpcs, setHcpcs] = useState("");
  const create = useMutation({
    mutationFn: () => createCmn(patientId, { formType, hcpcsCode: hcpcs }),
    onSuccess: () => {
      setHcpcs("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  const forms = catalog.data?.forms ?? [];

  return (
    <Card title="CMN / DIF forms">
      <div className="space-y-4">
        {/* Create */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span style={{ color: "hsl(var(--ink-3))" }}>Form</span>
            <select
              value={formType}
              onChange={(e) => {
                setFormType(e.target.value);
                const f = forms.find((x) => x.formType === e.target.value);
                if (f && !hcpcs) setHcpcs(f.hcpcsCodes[0] ?? "");
              }}
              className="rounded border px-2 py-1"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <option value="">Select…</option>
              {forms.map((f) => (
                <option key={f.formType} value={f.formType}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span style={{ color: "hsl(var(--ink-3))" }}>HCPCS</span>
            <input
              value={hcpcs}
              onChange={(e) => setHcpcs(e.target.value.toUpperCase())}
              placeholder="E1390"
              className="rounded border px-2 py-1 w-28 font-mono"
              style={{ borderColor: "hsl(var(--line-1))" }}
            />
          </label>
          <Button
            size="sm"
            disabled={!formType || hcpcs.trim().length < 2}
            isLoading={create.isPending}
            onClick={() => create.mutate()}
          >
            New CMN
          </Button>
        </div>

        {/* List */}
        {list.isPending ? (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Loading…
          </p>
        ) : list.isError ? (
          <p className="text-xs" style={{ color: "#b91c1c" }}>
            Couldn&apos;t load CMNs.
          </p>
        ) : list.data.documents.length === 0 ? (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            No CMN/DIF forms on file.
          </p>
        ) : (
          <div className="space-y-2">
            {list.data.documents.map((doc) => (
              <CmnRow
                key={doc.id}
                doc={doc}
                form={forms.find((f) => f.formType === doc.form_type) ?? null}
                onChanged={() => void qc.invalidateQueries({ queryKey: key })}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

const STATUS_VARIANT: Record<
  CmnDocument["status"],
  "muted" | "info" | "success" | "warning"
> = {
  draft: "warning",
  completed: "success",
  on_file: "info",
  voided: "muted",
};

function CmnRow({
  doc,
  form,
  onChanged,
}: {
  doc: CmnDocument;
  form: CmnFormDef | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc.answers ?? {})) {
      init[k] = v == null ? "" : String(v);
    }
    return init;
  });
  const [missing, setMissing] = useState<string[]>(doc.validation.missing);

  const save = useMutation({
    mutationFn: (complete: boolean) =>
      patchCmn(doc.id, {
        answers,
        ...(complete ? { status: "completed" as const } : {}),
      }),
    onSuccess: (res) => {
      if (res.error === "incomplete") {
        setMissing(res.missing ?? []);
      } else {
        setMissing([]);
        onChanged();
      }
    },
  });

  return (
    <div
      className="rounded border p-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm">
          <Badge variant={STATUS_VARIANT[doc.status]}>{doc.status}</Badge>
          <span style={{ color: "hsl(var(--ink-2))" }}>
            {form?.label ?? doc.form_type}
          </span>
          <span
            className="font-mono text-xs"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {doc.hcpcs_code}
          </span>
          {doc.status === "draft" && !doc.validation.ready && (
            <span className="text-xs" style={{ color: "#b45309" }}>
              {doc.validation.missing.length} field
              {doc.validation.missing.length === 1 ? "" : "s"} left
            </span>
          )}
        </span>
        {doc.status === "draft" && form && (
          <Button size="sm" intent="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Edit"}
          </Button>
        )}
      </div>

      {open && form && (
        <div className="mt-2 space-y-2">
          {form.questions.map((q) => {
            const isMissing = missing.includes(q.key);
            return (
              <label key={q.key} className="flex flex-col gap-1 text-xs">
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  {q.label}
                  {form.requiredKeys.includes(q.key) ? " *" : ""}
                </span>
                <input
                  value={answers[q.key] ?? ""}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, [q.key]: e.target.value }))
                  }
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: isMissing ? "#b91c1c" : "hsl(var(--line-1))",
                  }}
                />
              </label>
            );
          })}
          {missing.length > 0 && (
            <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
              Fill the required (*) fields to complete.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              intent="secondary"
              isLoading={save.isPending && save.variables === false}
              onClick={() => save.mutate(false)}
            >
              Save draft
            </Button>
            <Button
              size="sm"
              isLoading={save.isPending && save.variables === true}
              onClick={() => save.mutate(true)}
            >
              Complete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

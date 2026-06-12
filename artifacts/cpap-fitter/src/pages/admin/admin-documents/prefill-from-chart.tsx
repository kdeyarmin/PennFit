// /admin/documents — Prefill from a patient's chart.
//
// Opt-in: the operator picks a patient and the app suggests values from
// data already on file (demographics, latest prescription + provider,
// sleep-study diagnosis). The parent merges suggestions into BLANK
// inputs only — anything already typed is never overwritten.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Input, Label } from "@/components/admin/Input";
import { describeError } from "@/components/admin/ErrorPanel";
import {
  getManualDocumentPrefill,
  searchPatientsForAttach,
  type ManualDocumentPrefill,
  type ManualDocumentType,
} from "@/lib/admin/manual-documents-api";

export function PrefillFromChart({
  documentType,
  onApply,
}: {
  documentType: ManualDocumentType;
  onApply: (prefill: ManualDocumentPrefill) => void;
}) {
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const patientsQuery = useQuery({
    queryKey: ["manual-documents", "prefill-search", search.trim()],
    queryFn: () => searchPatientsForAttach(search.trim()),
    enabled: search.trim().length >= 2,
  });

  const prefillMut = useMutation({
    mutationFn: (patientId: string) =>
      getManualDocumentPrefill({ patientId, documentType }),
    onSuccess: (prefill) => {
      onApply(prefill);
      setSearch("");
      setMsg({
        kind: "ok",
        text: "Filled from the chart — only blank inputs were filled; edit anything you like.",
      });
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Prefill failed.",
      }),
  });

  return (
    <div
      className="rounded-md border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <Label htmlFor="prefillSearch">Prefill from a patient’s chart</Label>
      <Input
        id="prefillSearch"
        placeholder="Search by name or Pacware ID…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setMsg(null);
        }}
      />
      {search.trim().length >= 2 && (
        <div
          className="rounded-md border divide-y max-h-48 overflow-y-auto"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {patientsQuery.isPending ? (
            <div
              className="px-3 py-2 text-sm"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Searching…
            </div>
          ) : (patientsQuery.data ?? []).length === 0 ? (
            <div
              className="px-3 py-2 text-sm"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              No matches.
            </div>
          ) : (
            (patientsQuery.data ?? []).map((pt) => (
              <button
                key={pt.id}
                type="button"
                disabled={prefillMut.isPending}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                style={{ color: "hsl(var(--ink-1))" }}
                onClick={() => {
                  setMsg(null);
                  prefillMut.mutate(pt.id);
                }}
              >
                {pt.firstName} {pt.lastName}
                {pt.pacwareId && (
                  <span
                    className="ml-2 text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {pt.pacwareId}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
      {msg && (
        <div
          className="text-sm"
          style={{
            color: msg.kind === "ok" ? "hsl(142 60% 30%)" : "hsl(0 70% 45%)",
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

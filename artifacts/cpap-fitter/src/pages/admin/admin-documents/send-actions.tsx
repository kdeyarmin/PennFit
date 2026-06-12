// /admin/documents — Send / attach actions for a single document:
// email, fax, and "file to a patient chart" (each persists the editor
// form first so the rendered PDF matches what's typed).

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";
import { describeError } from "@/components/admin/ErrorPanel";
import {
  attachManualDocument,
  searchPatientsForAttach,
  sendManualDocumentEmail,
  sendManualDocumentFax,
} from "@/lib/admin/manual-documents-api";
import { sendErrorText } from "@/lib/admin/send-error";

export function SendActions({
  documentId,
  defaultEmail,
  defaultFax,
  persist,
  onChanged,
}: {
  documentId: string;
  defaultEmail: string;
  defaultFax: string;
  persist: () => Promise<unknown>;
  onChanged: () => void;
}) {
  // The destination inputs mirror the Recipient block above (including
  // "Prefill from chart") until the operator types a different
  // destination here — then their override wins.
  const [emailOverride, setEmailOverride] = useState<string | null>(null);
  const [faxOverride, setFaxOverride] = useState<string | null>(null);
  const email = emailOverride ?? defaultEmail;
  const fax = faxOverride ?? defaultFax;
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // Send paths persist the form first so the emailed/faxed PDF always
  // matches what's typed in the editor above.
  const emailMut = useMutation({
    mutationFn: async () => {
      await persist();
      return sendManualDocumentEmail(documentId, { email: email.trim() });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and emailed to the recipient." });
      onChanged();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Email failed.") }),
  });

  const faxMut = useMutation({
    mutationFn: async () => {
      await persist();
      return sendManualDocumentFax(documentId, { fax: fax.trim() });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and queued the fax." });
      onChanged();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Fax failed.") }),
  });

  const attachMut = useMutation({
    mutationFn: async (patientId: string) => {
      await persist();
      return attachManualDocument(documentId, { patientId });
    },
    onSuccess: () => {
      setMsg({
        kind: "ok",
        text: "Filed to the patient’s chart — it now appears in their Documents tab.",
      });
      setPicked(null);
      setSearch("");
      onChanged();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Attach failed.",
      }),
  });

  const patientsQuery = useQuery({
    queryKey: ["manual-documents", "patient-search", search.trim()],
    queryFn: () => searchPatientsForAttach(search.trim()),
    enabled: search.trim().length >= 2 && !picked,
  });

  return (
    <div
      className="rounded-md border p-4 space-y-4"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <h3
        className="text-sm font-semibold"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        Send &amp; file
      </h3>

      {/* Email */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="sendEmail">Email to</Label>
          <Input
            id="sendEmail"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmailOverride(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={emailMut.isPending}
          onClick={() => {
            if (!email.trim()) {
              setMsg({ kind: "err", text: "Enter an email address first." });
              return;
            }
            setMsg(null);
            emailMut.mutate();
          }}
        >
          Email document
        </Button>
      </div>

      {/* Fax */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="sendFax">Fax to (+1…)</Label>
          <Input
            id="sendFax"
            placeholder="+12155551234"
            value={fax}
            onChange={(e) => setFaxOverride(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={faxMut.isPending}
          onClick={() => {
            if (!fax.trim()) {
              setMsg({ kind: "err", text: "Enter a fax number first." });
              return;
            }
            setMsg(null);
            faxMut.mutate();
          }}
        >
          Send fax
        </Button>
      </div>

      {/* Attach to chart */}
      <div>
        <Label htmlFor="attachSearch">File to a patient chart</Label>
        {picked ? (
          <div
            className="flex items-center justify-between rounded-md border px-3 py-2"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <span style={{ color: "hsl(var(--ink-1))" }}>{picked.name}</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                isLoading={attachMut.isPending}
                onClick={() => {
                  setMsg(null);
                  attachMut.mutate(picked.id);
                }}
              >
                File to chart
              </Button>
              <Button intent="ghost" size="sm" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Input
              id="attachSearch"
              placeholder="Search by name or Pacware ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search.trim().length >= 2 && (
              <div
                className="mt-1 rounded-md border divide-y max-h-56 overflow-y-auto"
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
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                      style={{ color: "hsl(var(--ink-1))" }}
                      onClick={() =>
                        setPicked({
                          id: pt.id,
                          name: `${pt.firstName} ${pt.lastName}`.trim(),
                        })
                      }
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
          </>
        )}
      </div>

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
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        “Email document”, “Send fax”, and “File to chart” save your edits first,
        so the PDF always matches what's typed above.
      </p>
    </div>
  );
}

// CSR #11 — click-to-dial + post-call disposition, on the patient page.
//
// "Call patient" places an agent-first Twilio bridge: Twilio rings the
// CSR's OWN phone first; when they answer, the patient is connected. The
// patient's number never reaches the browser. After hanging up the CSR
// logs the outcome (reached / voicemail / …) + an optional note, and a
// recent call-history list shows below.
//
// The call-window guardrail (9am–7pm ET, Mon–Sat) is enforced server-
// side; outside it the first attempt 409s and we offer "Call anyway".
// If the agent hasn't set their own bridge number yet, the failure
// surfaces an inline "set your callback number" field right here.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, PhoneOutgoing } from "lucide-react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  placeClickToDial,
  logCallDisposition,
  getPatientCallHistory,
  setAgentPhone,
  CALL_OUTCOMES,
  OUTCOME_LABEL,
  type CallOutcome,
} from "@/lib/admin/click-to-dial-api";

function errInfo(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return {
      code: data?.error ?? String(err.status),
      message: data?.message ?? data?.error ?? "Couldn't place the call.",
    };
  }
  return { code: "error", message: "Couldn't place the call." };
}

export function ClickToDialCard({
  patientId,
  hasPhone,
}: {
  patientId: string;
  hasPhone: boolean;
}) {
  const qc = useQueryClient();
  const historyKey = ["admin", "patient", patientId, "call-history"] as const;
  const [dispositionId, setDispositionId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CallOutcome>("reached");
  const [note, setNote] = useState("");
  const [offerOverride, setOfferOverride] = useState(false);
  const [needPhone, setNeedPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logged, setLogged] = useState(false);

  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => getPatientCallHistory(patientId),
    enabled: hasPhone,
    staleTime: 30_000,
  });

  const dial = useMutation({
    mutationFn: (override: boolean) =>
      placeClickToDial(patientId, { override }),
    onMutate: () => {
      setError(null);
      setLogged(false);
    },
    onSuccess: (res) => {
      setDispositionId(res.dispositionId);
      setOfferOverride(false);
      setNeedPhone(false);
    },
    onError: (err) => {
      const { code, message } = errInfo(err);
      setOfferOverride(code === "outside_call_window");
      setNeedPhone(code === "agent_phone_missing");
      setError(message);
    },
  });

  const savePhone = useMutation({
    mutationFn: () => setAgentPhone(phoneInput.trim()),
    onSuccess: () => {
      setNeedPhone(false);
      setError(null);
      setPhoneInput("");
    },
  });

  const log = useMutation({
    mutationFn: () =>
      logCallDisposition(dispositionId!, {
        outcome,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setLogged(true);
      setDispositionId(null);
      setNote("");
      setOutcome("reached");
      void qc.invalidateQueries({ queryKey: historyKey });
    },
  });

  return (
    <Card
      title="Call the patient"
      subtitle="Rings your phone first, then bridges the patient in. Log the outcome when you hang up."
    >
      <div className="space-y-3" data-testid="click-to-dial">
        {!hasPhone ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No phone on file for this patient.
          </p>
        ) : dispositionId ? (
          <div className="space-y-2">
            <p
              className="text-sm flex items-center gap-2"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              <PhoneOutgoing className="h-4 w-4" />
              Calling your phone — answer it to connect the patient.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
                  Outcome
                </span>
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value as CallOutcome)}
                  className="rounded border border-slate-300 px-2 py-2 text-sm"
                  aria-label="Call outcome"
                >
                  {CALL_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {OUTCOME_LABEL[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block flex-1 min-w-[14rem]">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
                  Note (optional)
                </span>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What happened on the call?"
                  aria-label="Disposition note"
                  maxLength={4000}
                />
              </label>
              <Button isLoading={log.isPending} onClick={() => log.mutate()}>
                Log outcome
              </Button>
            </div>
            {log.error instanceof Error && (
              <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
                Couldn&apos;t log the outcome.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              isLoading={dial.isPending}
              onClick={() => dial.mutate(false)}
            >
              <Phone className="h-4 w-4 mr-1" />
              Call patient
            </Button>
            {offerOverride && (
              <Button
                intent="secondary"
                isLoading={dial.isPending}
                onClick={() => dial.mutate(true)}
              >
                Call anyway (outside hours)
              </Button>
            )}
          </div>
        )}

        {needPhone && (
          <div
            className="rounded border p-2 space-y-2"
            style={{ borderColor: "hsl(var(--line-1))", background: "#fffbe6" }}
          >
            <p className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
              Set your own callback number — Twilio rings it first, then bridges
              the patient.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Input
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="+12155551212"
                aria-label="Your callback number"
                className="font-mono text-sm w-[200px]"
              />
              <Button
                size="sm"
                isLoading={savePhone.isPending}
                disabled={phoneInput.trim() === ""}
                onClick={() => savePhone.mutate()}
              >
                Save number
              </Button>
            </div>
            {savePhone.error instanceof Error && (
              <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
                Couldn&apos;t save — use E.164 format (e.g. +12155551212).
              </p>
            )}
          </div>
        )}

        {error && !needPhone && (
          <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
            {error}
          </p>
        )}
        {logged && (
          <p className="text-sm" style={{ color: "#166534" }} role="status">
            Outcome logged.
          </p>
        )}

        {hasPhone && history.data && history.data.dispositions.length > 0 && (
          <div className="pt-1">
            <p
              className="text-[10px] uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Recent calls
            </p>
            <ul className="space-y-1">
              {history.data.dispositions.slice(0, 6).map((d) => (
                <li
                  key={d.id}
                  className="text-xs flex items-center gap-2"
                  style={{ color: "hsl(var(--ink-2))" }}
                >
                  <span className="font-medium">
                    {OUTCOME_LABEL[d.outcome as CallOutcome] ?? d.outcome}
                  </span>
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                  {d.note && (
                    <span
                      className="truncate"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      · {d.note}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

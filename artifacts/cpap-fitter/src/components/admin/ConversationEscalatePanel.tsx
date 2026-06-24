// Escalate a conversation — open a case or schedule a follow-up, pre-linked
// to this thread's patient / customer.
//
// Pattern B from the domain workflow review: the conversation detail (the
// CSR's main screen all day) could only tag / snooze / claim — any real
// escalation meant re-navigating and re-finding the patient elsewhere.
// "Open a case" also closes the inverse gap: nothing upstream offered an
// "add to case" path, so cases could previously only be filled by pasting
// raw UUIDs no human knows.

import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { addCaseLink, createCase } from "@/lib/admin/cases-api";
import { createAdminPatientFollowup } from "@/lib/admin/patient-followups-api";
import { createAdminCustomerFollowup } from "@/lib/admin/customer-followups-api";
import { appDateIsoOffset, parseAppDateTimeLocalInput } from "@/lib/utils";

export interface ConversationEscalatePanelProps {
  conversationId: string;
  /** Patient-flow thread subject (null for in-app / shop-customer threads). */
  patientId: string | null;
  /** Shop-customer thread subject (null for patient-flow threads). */
  customerId: string | null;
  /** Human label for the subject — seeds the default case title / note. */
  subjectLabel: string;
}

const labelClass = "block text-[11px] font-semibold uppercase tracking-wider";
const fieldClass = "w-full rounded border px-2 py-1.5 text-sm";

export function ConversationEscalatePanel({
  conversationId,
  patientId,
  customerId,
  subjectLabel,
}: ConversationEscalatePanelProps) {
  const [, navigate] = useLocation();

  // ── Open a case ────────────────────────────────────────────────────
  const [caseTitle, setCaseTitle] = useState(`Case — ${subjectLabel}`);
  const openCase = useMutation({
    mutationFn: async () => {
      const created = await createCase({
        title: caseTitle.trim() || `Case — ${subjectLabel}`,
        ...(patientId ? { patientId } : {}),
        ...(customerId ? { customerId } : {}),
      });
      // Link the originating thread so the case carries its context.
      await addCaseLink(created.id, {
        linkKind: "conversation",
        refId: conversationId,
      });
      return created;
    },
    onSuccess: (created) => navigate(`/admin/cases?case=${created.id}`),
  });

  // ── Schedule a follow-up ───────────────────────────────────────────
  // Default to tomorrow in the practice timezone (not UTC) so the date
  // doesn't slip a day for CSRs working near local midnight.
  const [dueDate, setDueDate] = useState(() => appDateIsoOffset(1));
  const [note, setNote] = useState("");
  const scheduleFollowup = useMutation({
    mutationFn: async () => {
      // Interpret "<date> 09:00" in the practice timezone (the app's
      // calendar standard), not the viewer's browser timezone.
      const dueAt = parseAppDateTimeLocalInput(`${dueDate}T09:00`);
      if (!dueAt) {
        throw new Error("Pick a valid follow-up date.");
      }
      const body = note.trim() || `Follow up: ${subjectLabel}`;
      if (patientId) {
        return createAdminPatientFollowup(patientId, body, dueAt);
      }
      if (customerId) {
        return createAdminCustomerFollowup(customerId, body, dueAt);
      }
      throw new Error("No patient or customer on this conversation.");
    },
    onSuccess: () => setNote(""),
  });

  return (
    <Card>
      <h3
        className="text-sm font-semibold mb-3"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        Escalate
      </h3>

      <div className="space-y-2">
        <label
          className={labelClass}
          style={{ color: "hsl(var(--ink-3))" }}
          htmlFor="escalate-case-title"
        >
          Open a case
        </label>
        <input
          id="escalate-case-title"
          value={caseTitle}
          onChange={(e) => setCaseTitle(e.target.value)}
          className={fieldClass}
          style={{ borderColor: "hsl(var(--line-1))" }}
          placeholder="Case title"
        />
        <Button
          intent="secondary"
          disabled={openCase.isPending || caseTitle.trim() === ""}
          isLoading={openCase.isPending}
          onClick={() => openCase.mutate()}
          data-testid="escalate-open-case"
        >
          Open a case
        </Button>
        {openCase.error instanceof Error && (
          <p className="text-xs text-rose-700">{openCase.error.message}</p>
        )}
      </div>

      <div
        className="mt-4 space-y-2 border-t pt-3"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <label
          className={labelClass}
          style={{ color: "hsl(var(--ink-3))" }}
          htmlFor="escalate-followup-date"
        >
          Schedule a follow-up
        </label>
        <input
          id="escalate-followup-date"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={fieldClass}
          style={{ borderColor: "hsl(var(--line-1))" }}
          aria-label="Follow-up note"
          placeholder={`Follow up: ${subjectLabel}`}
        />
        <Button
          intent="secondary"
          disabled={scheduleFollowup.isPending || dueDate === ""}
          isLoading={scheduleFollowup.isPending}
          onClick={() => scheduleFollowup.mutate()}
          data-testid="escalate-schedule-followup"
        >
          Schedule follow-up
        </Button>
        {scheduleFollowup.isSuccess && (
          <p className="text-xs text-emerald-700">Follow-up scheduled.</p>
        )}
        {scheduleFollowup.error instanceof Error && (
          <p className="text-xs text-rose-700">
            {scheduleFollowup.error.message}
          </p>
        )}
      </div>
    </Card>
  );
}

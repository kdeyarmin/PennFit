// Lead-capture form for /insurance. Posts to /shop/insurance-leads
// which fires a SendGrid notification to the verifications team and
// a confirmation email to the patient. The form intentionally keeps
// fields short — name, email, phone, DOB, carrier, member ID; the
// optional fields (group #, sleep provider, notes) are visually
// de-emphasized so a motivated patient can complete the form in
// well under 90 seconds.
//
// Honeypot: a hidden `website` field. Real users never see it; bots
// fill every input.
//
// Submission UX: button disables and shows "Sending…" while the
// request is in flight; on 200 the entire form is replaced with a
// success card. On 4xx/5xx we show a friendly error and re-enable
// the button — the form values are preserved.

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  CheckCircle2,
  ShieldCheck,
  Sparkles,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { submitInsuranceLead } from "@/lib/shop-api";

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  insuranceCarrier: string;
  memberId: string;
  groupNumber: string;
  prescribingPhysician: string;
  notes: string;
  website: string;
}

const INITIAL: FormState = {
  fullName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  insuranceCarrier: "",
  memberId: "",
  groupNumber: "",
  prescribingPhysician: "",
  notes: "",
  website: "",
};

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function InsuranceLeadForm() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "submitting") return;
    setStatus({ kind: "submitting" });
    try {
      await submitInsuranceLead({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        dateOfBirth: form.dateOfBirth.trim(),
        insuranceCarrier: form.insuranceCarrier.trim(),
        memberId: form.memberId.trim(),
        groupNumber: form.groupNumber.trim() || null,
        prescribingPhysician: form.prescribingPhysician.trim() || null,
        notes: form.notes.trim() || null,
        website: form.website,
      });
      setStatus({ kind: "ok" });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Something went wrong on our end. Please try again or call us.";
      setStatus({ kind: "error", message });
    }
  }

  if (status.kind === "ok") {
    return (
      <div
        className="glass-card rounded-2xl p-6 sm:p-8 space-y-3"
        data-testid="insurance-lead-success"
      >
        <div className="h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <h3 className="text-xl font-semibold tracking-tight">
          We received your request.
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          A member of the PennPaps team will reach out within{" "}
          <strong>one business day</strong> to confirm your benefits and walk
          you through the next step. We just sent a copy to{" "}
          <strong>{form.email}</strong> — check your inbox (and spam, just in
          case).
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          You won't be charged anything until we've confirmed your coverage and
          told you what — if anything — is owed out of pocket.
        </p>
      </div>
    );
  }

  const submitting = status.kind === "submitting";

  return (
    <form
      onSubmit={onSubmit}
      className="glass-card rounded-2xl p-6 sm:p-8 space-y-6"
      data-testid="insurance-lead-form"
      noValidate
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h3 className="text-xl font-semibold tracking-tight">
            Verify your insurance — about 90 seconds
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We'll check your benefits and call you back within one business day.
            No charge, no obligation.
          </p>
        </div>
      </div>

      {/* Required fields */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="lead-fullName">Full name</Label>
          <Input
            id="lead-fullName"
            name="fullName"
            required
            autoComplete="name"
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-fullName"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-dob">Date of birth</Label>
          <Input
            id="lead-dob"
            name="dateOfBirth"
            type="date"
            required
            autoComplete="bday"
            value={form.dateOfBirth}
            onChange={(e) => set("dateOfBirth", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-dob"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-email">Email</Label>
          <Input
            id="lead-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-phone">Phone</Label>
          <Input
            id="lead-phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            placeholder="(555) 555-1212"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-phone"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-carrier">Insurance carrier</Label>
          <Input
            id="lead-carrier"
            name="insuranceCarrier"
            required
            placeholder="Aetna, Medicare, Anthem BCBS…"
            value={form.insuranceCarrier}
            onChange={(e) => set("insuranceCarrier", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-carrier"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-memberId">Member ID</Label>
          <Input
            id="lead-memberId"
            name="memberId"
            required
            placeholder="From your insurance card"
            value={form.memberId}
            onChange={(e) => set("memberId", e.target.value)}
            disabled={submitting}
            data-testid="lead-input-memberId"
          />
        </div>
      </div>

      {/* Optional fields — visually de-emphasized */}
      <details className="rounded-xl border border-border/60 bg-secondary/20 px-4 py-3 group">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground select-none flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Optional details (helps us move faster)
        </summary>
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <div className="space-y-1.5">
            <Label htmlFor="lead-group">Group number</Label>
            <Input
              id="lead-group"
              name="groupNumber"
              value={form.groupNumber}
              onChange={(e) => set("groupNumber", e.target.value)}
              disabled={submitting}
              data-testid="lead-input-group"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-physician">Sleep / prescribing provider</Label>
            <Input
              id="lead-physician"
              name="prescribingPhysician"
              value={form.prescribingPhysician}
              onChange={(e) => set("prescribingPhysician", e.target.value)}
              disabled={submitting}
              data-testid="lead-input-physician"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="lead-notes">Anything we should know?</Label>
            <Textarea
              id="lead-notes"
              name="notes"
              rows={3}
              maxLength={1000}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              disabled={submitting}
              data-testid="lead-input-notes"
            />
          </div>
        </div>
      </details>

      {/* Honeypot — hidden from users + assistive tech, baited for bots */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          width: "1px",
          height: "1px",
          overflow: "hidden",
        }}
      >
        <label>
          Website (leave blank)
          <input
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            data-testid="lead-input-honeypot"
          />
        </label>
      </div>

      {status.kind === "error" && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 text-destructive px-3 py-2 text-sm flex items-start gap-2"
          data-testid="insurance-lead-error"
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{status.message}</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <p className="text-xs text-muted-foreground">
          By submitting you agree to be contacted about your CPAP coverage.
          We'll never share your info.
        </p>
        <Button
          type="submit"
          size="lg"
          className="rounded-full btn-primary-glow gap-2 w-full sm:w-auto"
          disabled={submitting}
          data-testid="insurance-lead-submit"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Verify my benefits
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

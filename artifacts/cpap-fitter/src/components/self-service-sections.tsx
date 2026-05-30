// Four patient-facing self-service sections added in the second
// 15-phase sprint. Co-located so account.tsx only needs four new
// JSX lines + one import.
//
//   * EsignFormsSection      — HIPAA NPP / AOB / ABN / Financial
//                              Responsibility / Supplier Standards
//                              click-through acknowledgement.
//   * ReferralProgramSection — generate referral code + history.
//   * EquipmentRegistrySection — register a CPAP / device the
//                                 patient already owns.
//   * RequestAppointmentSection — request a fitting / telehealth /
//                                  general appointment.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, FileSignature, Gift, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  listFormAcknowledgements,
  listMyReferrals,
  listSelfEquipment,
  mintReferral,
  registerSelfEquipment,
  signFormAcknowledgement,
  submitAppointmentRequest,
} from "@/lib/account/self-service-api";

// --- E-sign forms ---

export function EsignFormsSection() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: ["account", "form-acks"] as const,
    queryFn: listFormAcknowledgements,
  });
  const sign = useMutation({
    mutationFn: (kind: string) => signFormAcknowledgement(kind),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["account", "form-acks"] });
    },
  });
  if (isPending || isError || !data?.patientLinked) return null;
  return (
    <section className="glass-card rounded-2xl p-6">
      <header className="flex items-start gap-3 mb-4">
        <FileSignature className="h-5 w-5 mt-0.5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Required forms</h2>
          <p className="text-sm text-muted-foreground">
            Click-through acknowledgement of HIPAA, billing, and
            supplier-standards forms. Keeps your chart audit-ready.
          </p>
        </div>
      </header>
      <ul className="space-y-3">
        {data.forms.map((f) => (
          <li
            key={f.kind}
            className="rounded-lg border p-3 text-sm space-y-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="font-medium">{f.title}</div>
                <p className="text-xs text-muted-foreground">{f.body}</p>
              </div>
              {f.upToDate ? (
                <span className="text-xs font-medium text-emerald-700 whitespace-nowrap">
                  Signed v{f.lastSignedVersion}
                </span>
              ) : (
                <Button
                  size="sm"
                  onClick={() => sign.mutate(f.kind)}
                  disabled={sign.isPending}
                >
                  I acknowledge
                </Button>
              )}
            </div>
            {!f.upToDate && f.lastSignedVersion && (
              <p className="text-xs text-muted-foreground">
                You previously signed v{f.lastSignedVersion}. Please
                re-acknowledge the updated version.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Referrals ---

export function ReferralProgramSection() {
  const qc = useQueryClient();
  const [refereeEmail, setRefereeEmail] = useState("");
  const [refereeName, setRefereeName] = useState("");
  const { data, isPending, isError } = useQuery({
    queryKey: ["account", "referrals"] as const,
    queryFn: listMyReferrals,
  });
  const mint = useMutation({
    mutationFn: () =>
      mintReferral({
        refereeEmail: refereeEmail || null,
        refereeName: refereeName || null,
      }),
    onSuccess: () => {
      setRefereeEmail("");
      setRefereeName("");
      void qc.invalidateQueries({ queryKey: ["account", "referrals"] });
    },
  });
  if (isPending || isError || !data?.patientLinked) return null;
  const stats = data.stats;
  return (
    <section className="glass-card rounded-2xl p-6">
      <header className="flex items-start gap-3 mb-4">
        <Gift className="h-5 w-5 mt-0.5 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-lg font-semibold">Refer a friend</h2>
          <p className="text-sm text-muted-foreground">
            Share PennPaps with another CPAP user. We&apos;ll thank you once
            they place their first order.
          </p>
        </div>
        {stats && (
          <div className="text-xs text-right text-muted-foreground">
            <div>{stats.total} sent</div>
            <div>{stats.converted} converted</div>
          </div>
        )}
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <Label htmlFor="referee-name" className="text-xs">
            Friend&apos;s name (optional)
          </Label>
          <Input
            id="referee-name"
            value={refereeName}
            onChange={(e) => setRefereeName(e.target.value)}
            placeholder="Pat Smith"
          />
        </div>
        <div>
          <Label htmlFor="referee-email" className="text-xs">
            Friend&apos;s email (optional)
          </Label>
          <Input
            id="referee-email"
            type="email"
            value={refereeEmail}
            onChange={(e) => setRefereeEmail(e.target.value)}
            placeholder="friend@example.com"
          />
        </div>
      </div>
      <Button onClick={() => mint.mutate()} disabled={mint.isPending} size="sm">
        {mint.isPending ? "Generating…" : "Generate referral link"}
      </Button>
      {data.referrals.length > 0 && (
        <div className="mt-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            Your referrals
          </p>
          <ul className="space-y-1.5 text-sm">
            {data.referrals.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between rounded border px-2 py-1.5"
              >
                <span className="font-mono text-xs">{r.code}</span>
                <span className="text-xs text-muted-foreground">
                  {r.refereeName ?? r.refereeEmail ?? "Shared link"} ·{" "}
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// --- Equipment self-register ---

export function EquipmentRegistrySection() {
  const qc = useQueryClient();
  const [deviceClass, setDeviceClass] = useState("cpap");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const { data, isPending, isError } = useQuery({
    queryKey: ["account", "equipment"] as const,
    queryFn: listSelfEquipment,
  });
  const register = useMutation({
    mutationFn: () =>
      registerSelfEquipment({
        deviceClass,
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        serialNumber: serial.trim(),
      }),
    onSuccess: () => {
      setManufacturer("");
      setModel("");
      setSerial("");
      void qc.invalidateQueries({ queryKey: ["account", "equipment"] });
    },
  });
  if (isPending || isError || !data?.patientLinked) return null;
  return (
    <section className="glass-card rounded-2xl p-6">
      <header className="flex items-start gap-3 mb-4">
        <Stethoscope className="h-5 w-5 mt-0.5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">My equipment</h2>
          <p className="text-sm text-muted-foreground">
            Register your CPAP, BiPAP, or accessory device so we can reach you
            if there&apos;s ever a manufacturer recall.
          </p>
        </div>
      </header>
      {data.assets.length > 0 && (
        <ul className="space-y-1.5 mb-4 text-sm">
          {data.assets.map((a) => (
            <li
              key={a.id}
              className="rounded border px-3 py-2 flex items-center justify-between"
            >
              <span>
                {a.manufacturer} {a.model}{" "}
                <span className="text-xs text-muted-foreground">
                  ({a.deviceClass})
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {a.serialNumber}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <div>
          <Label htmlFor="dev-class" className="text-xs">
            Class
          </Label>
          <select
            id="dev-class"
            value={deviceClass}
            onChange={(e) => setDeviceClass(e.target.value)}
            className="w-full h-9 rounded border px-2 text-sm"
          >
            <option value="cpap">CPAP</option>
            <option value="auto_cpap">Auto CPAP</option>
            <option value="bipap">BiPAP</option>
            <option value="asv">ASV</option>
            <option value="avaps">AVAPS</option>
            <option value="humidifier">Humidifier</option>
            <option value="oximeter">Oximeter</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <Label htmlFor="dev-mfr" className="text-xs">
            Manufacturer
          </Label>
          <Input
            id="dev-mfr"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            placeholder="ResMed"
          />
        </div>
        <div>
          <Label htmlFor="dev-model" className="text-xs">
            Model
          </Label>
          <Input
            id="dev-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="AirSense 11"
          />
        </div>
        <div>
          <Label htmlFor="dev-serial" className="text-xs">
            Serial #
          </Label>
          <Input
            id="dev-serial"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
          />
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => register.mutate()}
        disabled={
          register.isPending ||
          !manufacturer.trim() ||
          !model.trim() ||
          !serial.trim()
        }
      >
        {register.isPending ? "Registering…" : "Register"}
      </Button>
      {register.isError && (
        <p className="text-xs mt-2 text-destructive">
          {(register.error as Error).message}
        </p>
      )}
      {register.isSuccess && (
        <p className="text-xs mt-2 text-emerald-700">
          Equipment registered. Thanks!
        </p>
      )}
    </section>
  );
}

// --- Appointment request ---

const APPOINTMENT_TOPICS = [
  { value: "fitting_help", label: "Mask fitting help" },
  { value: "telehealth_consult", label: "Telehealth consult" },
  { value: "billing_question", label: "Billing question" },
  { value: "general", label: "General question" },
];

export function RequestAppointmentSection() {
  const [topic, setTopic] = useState("fitting_help");
  const [preferredWindow, setPreferredWindow] = useState("");
  const [notes, setNotes] = useState("");
  const submit = useMutation({
    mutationFn: () =>
      submitAppointmentRequest({
        topic,
        preferredWindow: preferredWindow || null,
        notes: notes || null,
      }),
    onSuccess: () => {
      setPreferredWindow("");
      setNotes("");
    },
  });
  return (
    <section className="glass-card rounded-2xl p-6">
      <header className="flex items-start gap-3 mb-4">
        <CalendarPlus className="h-5 w-5 mt-0.5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Request an appointment</h2>
          <p className="text-sm text-muted-foreground">
            Fitting help, a telehealth consult, or a billing question —
            we&apos;ll reach out to schedule.
          </p>
        </div>
      </header>
      <div className="space-y-3 mb-3">
        <div>
          <Label htmlFor="appt-topic" className="text-xs">
            Topic
          </Label>
          <select
            id="appt-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="w-full h-9 rounded border px-2 text-sm"
          >
            {APPOINTMENT_TOPICS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="appt-window" className="text-xs">
            Preferred time window (optional)
          </Label>
          <Input
            id="appt-window"
            value={preferredWindow}
            onChange={(e) => setPreferredWindow(e.target.value)}
            placeholder="e.g. weekdays after 4pm ET"
          />
        </div>
        <div>
          <Label htmlFor="appt-notes" className="text-xs">
            What should the team know? (optional)
          </Label>
          <textarea
            id="appt-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full rounded border px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => submit.mutate()}
        disabled={submit.isPending || submit.isSuccess}
      >
        {submit.isSuccess
          ? "Request sent"
          : submit.isPending
            ? "Sending…"
            : "Send request"}
      </Button>
      {submit.isError && (
        <p className="text-xs mt-2 text-destructive">
          {(submit.error as Error).message}
        </p>
      )}
    </section>
  );
}

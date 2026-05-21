// Patient-detail "Settings" panel — three admin-managed fields
// that override the defaults used by the eligibility engine.
//
// Fields:
//   - insurancePayer:        free-text payer name (e.g. "Aetna").
//     Used as a match key by frequency_rules; blank means "no
//     payer recorded" and rules with a payer constraint will not
//     apply.
//   - cadenceOverrideDays:   hard override of the days between
//     reminders. Wins over rules and the prescription cadence.
//   - channelPreference:     hard override of the outbound
//     channel. Wins over rules and the SMS-then-email fallback.
//
// "Save" sends ONLY the fields the admin actually changed (the
// PATCH endpoint treats omitted keys as "leave alone" and explicit
// `null` as "clear"). "Reset to default" clears all three
// overrides in a single PATCH so the eligibility engine falls all
// the way back to rules / prescription defaults.

import { useEffect, useState } from "react";

import {
  ApiError,
  useUpdatePatient,
  type PatientDetail,
} from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input, Label, Select } from "@/components/admin/Input";

type ChannelChoice = "" | "sms" | "email" | "voice";

export function SettingsCard({
  patient,
  onSaved,
}: {
  patient: PatientDetail;
  onSaved: () => void;
}) {
  // Local form state. We re-seed from the server snapshot whenever
  // the patient row refetches (e.g. after a successful save) so the
  // "dirty" indicator clears.
  const [insurancePayer, setInsurancePayer] = useState(
    patient.insurancePayer ?? "",
  );
  const [cadence, setCadence] = useState(
    patient.cadenceOverrideDays != null
      ? String(patient.cadenceOverrideDays)
      : "",
  );
  const [channel, setChannel] = useState<ChannelChoice>(
    (patient.channelPreference ?? "") as ChannelChoice,
  );
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const mutation = useUpdatePatient();
  const isPending = mutation.isPending;

  useEffect(() => {
    setInsurancePayer(patient.insurancePayer ?? "");
    setCadence(
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "",
    );
    setChannel((patient.channelPreference ?? "") as ChannelChoice);
    setError(null);
  }, [
    patient.insurancePayer,
    patient.cadenceOverrideDays,
    patient.channelPreference,
  ]);

  function buildPatch(): {
    body: Record<string, string | number | null>;
    error: string | null;
  } {
    const body: Record<string, string | number | null> = {};
    // insurance: empty string clears, anything else is a set.
    const insTrim = insurancePayer.trim();
    const insOnServer = patient.insurancePayer ?? "";
    if (insTrim !== insOnServer) {
      body.insurancePayer = insTrim === "" ? null : insTrim;
    }
    // cadence: empty clears, otherwise integer in [1,365].
    const cadOnServer =
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "";
    if (cadence.trim() !== cadOnServer) {
      if (cadence.trim() === "") {
        body.cadenceOverrideDays = null;
      } else {
        const n = Number(cadence);
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          return {
            body: {},
            error: "Cadence override must be a whole number between 1 and 365.",
          };
        }
        body.cadenceOverrideDays = n;
      }
    }
    // channel: empty clears, otherwise enum.
    const chOnServer = patient.channelPreference ?? "";
    if (channel !== chOnServer) {
      body.channelPreference = channel === "" ? null : channel;
    }
    return { body, error: null };
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      // ConsoleValidationError surface
      const data = err.data as { error?: string; message?: string } | undefined;
      return data?.message ?? data?.error ?? "Couldn't save changes.";
    }
    return err instanceof Error ? err.message : "Couldn't save changes.";
  }

  async function onSave() {
    setError(null);
    setStatusMsg(null);
    const { body, error: validationError } = buildPatch();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (Object.keys(body).length === 0) {
      setStatusMsg("No changes to save.");
      return;
    }
    // Optimistic-concurrency precondition. We echo the `updatedAt`
    // we last saw so the server can refuse to clobber a parallel
    // edit; on 409 we surface the conflict and trigger a refetch
    // (via onSaved()) so the admin sees the latest data and can
    // re-apply.
    body.expectedUpdatedAt = patient.updatedAt;
    try {
      const res = await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg(
        res.changed.length === 0
          ? "No fields changed."
          : `Saved ${res.changed.length} field${res.changed.length === 1 ? "" : "s"}.`,
      );
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          "This patient was changed by someone else since you opened it. Refreshing — please re-apply your edits.",
        );
        onSaved();
        return;
      }
      setError(describeError(err));
    }
  }

  async function onReset() {
    setError(null);
    setStatusMsg(null);
    const body: Record<string, string | number | null> = {};
    if (patient.insurancePayer != null) body.insurancePayer = null;
    if (patient.cadenceOverrideDays != null) body.cadenceOverrideDays = null;
    if (patient.channelPreference != null) body.channelPreference = null;
    if (Object.keys(body).length === 0) {
      setStatusMsg("Nothing to reset — already on defaults.");
      return;
    }
    body.expectedUpdatedAt = patient.updatedAt;
    try {
      await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg("Reset to defaults — eligibility engine will use rules.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          "This patient was changed by someone else since you opened it. Refreshing — please re-apply your reset.",
        );
        onSaved();
        return;
      }
      setError(describeError(err));
    }
  }

  const hasOverride =
    patient.insurancePayer != null ||
    patient.cadenceOverrideDays != null ||
    patient.channelPreference != null;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2
            className="text-sm uppercase tracking-wider font-semibold mb-1"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Reminder settings
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Per-patient overrides win over global rules and the prescription
            cadence. Leave a field blank to fall back to the rules engine.
          </p>
        </div>
        {hasOverride && <Badge variant="info">Custom override active</Badge>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label htmlFor="patient-insurance">Insurance payer</Label>
          <Input
            id="patient-insurance"
            value={insurancePayer}
            placeholder="e.g. Aetna"
            maxLength={120}
            onChange={(e) => setInsurancePayer(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Free-text — match key for rules.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-cadence">Cadence override (days)</Label>
          <Input
            id="patient-cadence"
            type="number"
            min={1}
            max={365}
            value={cadence}
            placeholder="—"
            onChange={(e) => setCadence(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Whole days, 1–365.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-channel">Channel preference</Label>
          <Select
            id="patient-channel"
            value={channel}
            options={[
              { value: "sms", label: "SMS" },
              { value: "email", label: "Email" },
              { value: "voice", label: "Voice (manual)" },
            ]}
            emptyOptionLabel="Use default"
            onChange={(e) => setChannel(e.target.value as ChannelChoice)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Voice is admin-initiated only.
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {error}
        </p>
      )}
      {statusMsg && !error && (
        <p
          className="mt-3 text-sm"
          style={{ color: "hsl(var(--ink-1))" }}
          role="status"
        >
          {statusMsg}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button onClick={() => void onSave()} isLoading={isPending}>
          Save changes
        </Button>
        <Button
          intent="secondary"
          onClick={() => void onReset()}
          disabled={isPending || !hasOverride}
        >
          Reset to default
        </Button>
      </div>
    </Card>
  );
}

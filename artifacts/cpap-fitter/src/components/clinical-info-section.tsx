// ClinicalInfoSection — captures the signed-in shopper's CPAP
// device and prescribing physician on /account.
//
// Composed of two sub-cards rendered side-by-side on wide screens
// and stacked on mobile. Each card is independently editable and
// saves through `PUT /shop/me/clinical-info` — partial updates so
// editing the device doesn't disturb the physician record.
//
// Why we collapse the form into "view + edit" rather than always-
// editable inputs: this is sensitive PHI (prescribing physician,
// device serial), and an always-on form invites accidental
// keystrokes and partial typing that gets persisted on blur. The
// "Edit" → fill → "Save" cycle is a deliberate gesture and the
// audit-log trail matches it.

import React, { useEffect, useMemo, useState } from "react";
import { HeartPulse, Loader2, Pencil, Stethoscope, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AccountApiError,
  type CpapDeviceInfo,
  type PhysicianInfo,
  type ShopFacialMeasurements,
  fetchShopClinicalInfo,
  updateShopClinicalInfo,
} from "@/lib/account-api";
import { FacialMeasurementsCard } from "@/components/facial-measurements-card";
import { Link } from "wouter";
import {
  CPAP_DEVICE_CATALOG,
  CPAP_DEVICE_OTHER_ID,
  findCpapDeviceByManufacturerModel,
  getCpapDeviceById,
} from "@/lib/cpap-devices";

export function ClinicalInfoSection() {
  const [device, setDevice] = useState<CpapDeviceInfo | null>(null);
  const [physician, setPhysician] = useState<PhysicianInfo | null>(null);
  const [measurements, setMeasurements] =
    useState<ShopFacialMeasurements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchShopClinicalInfo();
        if (cancelled) return;
        setDevice(r.cpapDevice);
        setPhysician(r.physicianInfo);
        setMeasurements(r.facialMeasurements);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <section className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading device &amp; physician info…
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <FacialMeasurementsAccountCard measurements={measurements} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <DeviceCard
          device={device}
          onSaved={(d) => setDevice(d)}
          onError={setError}
        />
        <PhysicianCard
          physician={physician}
          onSaved={(p) => setPhysician(p)}
          onError={setError}
        />
        {error && (
          <p
            className="text-xs text-rose-700 md:col-span-2"
            role="alert"
            data-testid="clinical-info-error"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ───── FacialMeasurementsAccountCard ──────────────────────────
//
// Surfaces the measurements in the same headgear/nostril framing as
// the post-scan readout on /measure. When the customer hasn't yet
// completed a fitting tied to their account we show a small empty
// state with a CTA back into the fitter so the column doesn't look
// broken.

function FacialMeasurementsAccountCard({
  measurements,
}: {
  measurements: ShopFacialMeasurements | null;
}) {
  if (measurements) {
    return <FacialMeasurementsCard measurements={measurements} />;
  }
  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-3"
      data-testid="facial-measurements-empty"
    >
      <h2 className="text-base font-semibold tracking-tight">
        Your facial measurements
      </h2>
      <p className="text-sm text-muted-foreground">
        We don't have a recent on-device scan saved for your account yet.
        Running the fitter while signed in saves your sizing here so the team
        can recommend the right cushion and pillow on every order.
      </p>
      <Link
        href="/consent"
        className="inline-flex items-center text-sm font-semibold text-primary hover:underline"
        data-testid="facial-measurements-empty-cta"
      >
        Start a fitting
      </Link>
    </section>
  );
}

// ───── DeviceCard ──────────────────────────────────────────────

function DeviceCard({
  device,
  onSaved,
  onError,
}: {
  device: CpapDeviceInfo | null;
  onSaved: (d: CpapDeviceInfo | null) => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-device-section"
    >
      <SectionHeader
        Icon={HeartPulse}
        title="Your CPAP machine"
        editing={editing}
        onToggle={() => {
          onError(null);
          setEditing((v) => !v);
        }}
        empty={!device}
      />
      {!editing ? (
        device ? (
          <DeviceSummary device={device} />
        ) : (
          <EmptyHint
            label="No device on file."
            cta="Add your machine so the team can recommend the right cushions and filters."
            onClick={() => setEditing(true)}
            buttonLabel="Add my device"
            testId="account-device-add"
          />
        )
      ) : (
        <DeviceForm
          initial={device}
          saving={saving}
          onCancel={() => {
            onError(null);
            setEditing(false);
          }}
          onSubmit={async (next) => {
            setSaving(true);
            onError(null);
            try {
              const r = await updateShopClinicalInfo({ cpapDevice: next });
              onSaved(r.cpapDevice);
              setEditing(false);
            } catch (err) {
              onError(formatError(err));
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </section>
  );
}

function DeviceSummary({ device }: { device: CpapDeviceInfo }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm">
      <Row label="Manufacturer">{device.manufacturer}</Row>
      <Row label="Model">{device.model}</Row>
      {device.serialNumber && <Row label="Serial">{device.serialNumber}</Row>}
      {device.pressureSetting && (
        <Row label="Pressure">{device.pressureSetting}</Row>
      )}
      {device.humidifierSetting && (
        <Row label="Humidifier">{device.humidifierSetting}</Row>
      )}
      {device.notes && <Row label="Notes">{device.notes}</Row>}
    </dl>
  );
}

function DeviceForm({
  initial,
  saving,
  onSubmit,
  onCancel,
}: {
  initial: CpapDeviceInfo | null;
  saving: boolean;
  onSubmit: (next: CpapDeviceInfo | null) => void | Promise<void>;
  onCancel: () => void;
}) {
  // Decide the initial dropdown selection: match the saved device
  // against the catalog so returning customers see "their" machine
  // pre-selected. When no match is found (older free-text entry),
  // start in "Other" mode with the saved values pre-filled.
  const initialMatch = useMemo(
    () =>
      findCpapDeviceByManufacturerModel(initial?.manufacturer, initial?.model),
    [initial?.manufacturer, initial?.model],
  );
  const hadInitialDevice = Boolean(initial?.manufacturer && initial?.model);
  const [selectedId, setSelectedId] = useState<string>(
    initialMatch
      ? initialMatch.id
      : hadInitialDevice
        ? CPAP_DEVICE_OTHER_ID
        : "",
  );
  const [manufacturer, setManufacturer] = useState(initial?.manufacturer ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [serialNumber, setSerialNumber] = useState(initial?.serialNumber ?? "");
  const [pressureSetting, setPressureSetting] = useState(
    initial?.pressureSetting ?? "",
  );
  const [humidifierSetting, setHumidifierSetting] = useState(
    initial?.humidifierSetting ?? "",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  // Group catalog entries by manufacturer for the SelectGroup labels.
  const grouped = useMemo(() => {
    const map = new Map<string, typeof CPAP_DEVICE_CATALOG>();
    for (const d of CPAP_DEVICE_CATALOG) {
      const list = map.get(d.manufacturer) ?? [];
      list.push(d);
      map.set(d.manufacturer, list);
    }
    return Array.from(map.entries());
  }, []);

  const isOther = selectedId === CPAP_DEVICE_OTHER_ID;
  const catalogPick = isOther ? null : getCpapDeviceById(selectedId);
  const effectiveManufacturer = isOther
    ? manufacturer
    : (catalogPick?.manufacturer ?? "");
  const effectiveModel = isOther ? model : (catalogPick?.model ?? "");
  const canSave =
    effectiveManufacturer.trim().length > 0 && effectiveModel.trim().length > 0;

  function handleSelect(next: string) {
    setSelectedId(next);
    if (next !== CPAP_DEVICE_OTHER_ID) {
      // Picking a catalog entry blanks any leftover "Other" free-text
      // so a half-typed manual model can't sneak through if the user
      // toggles back later.
      setManufacturer("");
      setModel("");
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmedManufacturer = effectiveManufacturer.trim();
        const trimmedModel = effectiveModel.trim();
        if (!trimmedManufacturer || !trimmedModel) return;
        void onSubmit({
          manufacturer: trimmedManufacturer,
          model: trimmedModel,
          serialNumber: serialNumber.trim() || null,
          pressureSetting: pressureSetting.trim() || null,
          humidifierSetting: humidifierSetting.trim() || null,
          notes: notes.trim() || null,
        });
      }}
    >
      <FieldShell label="Machine" required htmlFor="device-picker">
        {/* Select renders its own trigger button — htmlFor binding to a
            button doesn't help, but the Label still serves as a visible
            caption above the trigger. */}
        <Select value={selectedId} onValueChange={handleSelect}>
          <SelectTrigger id="device-picker" data-testid="device-picker">
            <SelectValue placeholder="Select your CPAP machine" />
          </SelectTrigger>
          <SelectContent>
            {grouped.map(([mfr, items]) => (
              <SelectGroup key={mfr}>
                <SelectLabel>{mfr}</SelectLabel>
                {items.map((d) => (
                  <SelectItem
                    key={d.id}
                    value={d.id}
                    data-testid={`device-option-${d.id}`}
                  >
                    {d.model}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectSeparator />
            <SelectItem
              value={CPAP_DEVICE_OTHER_ID}
              data-testid="device-option-other"
            >
              Other / not listed
            </SelectItem>
          </SelectContent>
        </Select>
      </FieldShell>
      {isOther && (
        <FieldPair>
          <FieldShell
            label="Manufacturer"
            required
            htmlFor="device-manufacturer"
          >
            <Input
              id="device-manufacturer"
              required
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              placeholder="ResMed"
              data-testid="device-manufacturer"
            />
          </FieldShell>
          <FieldShell label="Model" required htmlFor="device-model">
            <Input
              id="device-model"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="AirSense 11 AutoSet"
              data-testid="device-model"
            />
          </FieldShell>
        </FieldPair>
      )}
      <FieldPair>
        <FieldShell label="Serial number (optional)" htmlFor="device-serial">
          <Input
            id="device-serial"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            placeholder="22A1234567"
            data-testid="device-serial"
          />
        </FieldShell>
        <FieldShell label="Pressure (optional)" htmlFor="device-pressure">
          <Input
            id="device-pressure"
            value={pressureSetting}
            onChange={(e) => setPressureSetting(e.target.value)}
            placeholder="8–12 cm H2O"
            data-testid="device-pressure"
          />
        </FieldShell>
      </FieldPair>
      <FieldShell label="Humidifier (optional)" htmlFor="device-humidifier">
        <Input
          id="device-humidifier"
          value={humidifierSetting}
          onChange={(e) => setHumidifierSetting(e.target.value)}
          placeholder="3 (or auto)"
          data-testid="device-humidifier"
        />
      </FieldShell>
      <FieldShell label="Notes (optional)" htmlFor="device-notes">
        <Textarea
          id="device-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Anything our team should know about your machine?"
          data-testid="device-notes"
        />
      </FieldShell>
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="submit"
          size="sm"
          disabled={saving || !canSave}
          data-testid="device-save"
        >
          {saving ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save device"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        {initial && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void onSubmit(null)}
            data-testid="device-clear"
            className="ml-auto text-muted-foreground hover:text-rose-700"
          >
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

// ───── PhysicianCard ───────────────────────────────────────────

function PhysicianCard({
  physician,
  onSaved,
  onError,
}: {
  physician: PhysicianInfo | null;
  onSaved: (p: PhysicianInfo | null) => void;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-physician-section"
    >
      <SectionHeader
        Icon={Stethoscope}
        title="Prescribing physician"
        editing={editing}
        onToggle={() => {
          onError(null);
          setEditing((v) => !v);
        }}
        empty={!physician}
      />
      {!editing ? (
        physician ? (
          <PhysicianSummary physician={physician} />
        ) : (
          <EmptyHint
            label="No physician on file."
            cta="Saving your prescriber speeds up insurance verification on future orders."
            onClick={() => setEditing(true)}
            buttonLabel="Add my physician"
            testId="account-physician-add"
          />
        )
      ) : (
        <PhysicianForm
          initial={physician}
          saving={saving}
          onCancel={() => {
            onError(null);
            setEditing(false);
          }}
          onSubmit={async (next) => {
            setSaving(true);
            onError(null);
            try {
              const r = await updateShopClinicalInfo({ physicianInfo: next });
              onSaved(r.physicianInfo);
              setEditing(false);
            } catch (err) {
              onError(formatError(err));
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </section>
  );
}

function PhysicianSummary({ physician }: { physician: PhysicianInfo }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm">
      <Row label="Name">{physician.name}</Row>
      {physician.practice && <Row label="Practice">{physician.practice}</Row>}
      {physician.phone && <Row label="Phone">{physician.phone}</Row>}
      {physician.fax && <Row label="Fax">{physician.fax}</Row>}
      {physician.email && <Row label="Email">{physician.email}</Row>}
      {physician.npi && <Row label="NPI">{physician.npi}</Row>}
      {(physician.addressLine1 || physician.city) && (
        <Row label="Address">
          <span className="block">
            {physician.addressLine1}
            {physician.addressLine2 ? `, ${physician.addressLine2}` : ""}
          </span>
          <span className="block text-muted-foreground">
            {[physician.city, physician.state, physician.postalCode]
              .filter(Boolean)
              .join(", ")}
          </span>
        </Row>
      )}
    </dl>
  );
}

function PhysicianForm({
  initial,
  saving,
  onSubmit,
  onCancel,
}: {
  initial: PhysicianInfo | null;
  saving: boolean;
  onSubmit: (next: PhysicianInfo | null) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [practice, setPractice] = useState(initial?.practice ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [fax, setFax] = useState(initial?.fax ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [npi, setNpi] = useState(initial?.npi ?? "");
  const [addressLine1, setAddressLine1] = useState(initial?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(initial?.addressLine2 ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [stateCode, setStateCode] = useState(initial?.state ?? "");
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? "");

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmedName = name.trim();
        if (!trimmedName) return;
        void onSubmit({
          name: trimmedName,
          practice: practice.trim() || null,
          phone: phone.trim() || null,
          fax: fax.trim() || null,
          email: email.trim() || null,
          npi: npi.trim() || null,
          addressLine1: addressLine1.trim() || null,
          addressLine2: addressLine2.trim() || null,
          city: city.trim() || null,
          state: stateCode.trim().toUpperCase() || null,
          postalCode: postalCode.trim() || null,
        });
      }}
    >
      <FieldShell label="Physician name" required htmlFor="phys-name">
        <Input
          id="phys-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dr. Anna Singh, MD"
          data-testid="physician-name"
        />
      </FieldShell>
      <FieldShell label="Practice (optional)" htmlFor="phys-practice">
        <Input
          id="phys-practice"
          value={practice}
          onChange={(e) => setPractice(e.target.value)}
          placeholder="Penn Sleep Medicine Associates"
          data-testid="physician-practice"
        />
      </FieldShell>
      <FieldPair>
        <FieldShell label="Phone (optional)" htmlFor="phys-phone">
          <Input
            id="phys-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            data-testid="physician-phone"
          />
        </FieldShell>
        <FieldShell label="Fax (optional)" htmlFor="phys-fax">
          <Input
            id="phys-fax"
            type="tel"
            value={fax}
            onChange={(e) => setFax(e.target.value)}
            placeholder="(555) 123-4568"
            data-testid="physician-fax"
          />
        </FieldShell>
      </FieldPair>
      <FieldPair>
        <FieldShell label="Email (optional)" htmlFor="phys-email">
          <Input
            id="phys-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="office@practice.com"
            data-testid="physician-email"
          />
        </FieldShell>
        <FieldShell label="NPI (optional)" htmlFor="phys-npi">
          <Input
            id="phys-npi"
            inputMode="numeric"
            pattern="\d{10}"
            value={npi}
            onChange={(e) => setNpi(e.target.value)}
            placeholder="1234567890"
            data-testid="physician-npi"
          />
        </FieldShell>
      </FieldPair>
      <FieldShell label="Address line 1 (optional)" htmlFor="phys-line1">
        <Input
          id="phys-line1"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
          placeholder="3400 Spruce St"
          data-testid="physician-line1"
        />
      </FieldShell>
      <FieldShell label="Address line 2 (optional)" htmlFor="phys-line2">
        <Input
          id="phys-line2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          placeholder="Suite 200"
          data-testid="physician-line2"
        />
      </FieldShell>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <FieldShell label="City" htmlFor="phys-city">
          <Input
            id="phys-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Philadelphia"
            data-testid="physician-city"
          />
        </FieldShell>
        <FieldShell label="State" htmlFor="phys-state">
          <Input
            id="phys-state"
            value={stateCode}
            onChange={(e) =>
              setStateCode(e.target.value.toUpperCase().slice(0, 2))
            }
            maxLength={2}
            placeholder="PA"
            data-testid="physician-state"
          />
        </FieldShell>
        <FieldShell label="ZIP" htmlFor="phys-zip">
          <Input
            id="phys-zip"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="19104"
            data-testid="physician-zip"
          />
        </FieldShell>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="submit"
          size="sm"
          disabled={saving || !name.trim()}
          data-testid="physician-save"
        >
          {saving ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save physician"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        {initial && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void onSubmit(null)}
            data-testid="physician-clear"
            className="ml-auto text-muted-foreground hover:text-rose-700"
          >
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

// ───── Shared bits ─────────────────────────────────────────────

function SectionHeader({
  Icon,
  title,
  editing,
  onToggle,
  empty,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  editing: boolean;
  onToggle: () => void;
  empty: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-5 w-5 text-muted-foreground" />
      <h2 className="font-semibold">{title}</h2>
      {!empty && (
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-[hsl(var(--penn-navy))] transition-colors"
          data-testid={`${title.toLowerCase().replace(/\s+/g, "-")}-edit-toggle`}
        >
          {editing ? (
            <>
              <X className="w-3.5 h-3.5" /> Close
            </>
          ) : (
            <>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </>
          )}
        </button>
      )}
    </div>
  );
}

function EmptyHint({
  label,
  cta,
  onClick,
  buttonLabel,
  testId,
}: {
  label: string;
  cta: string;
  onClick: () => void;
  buttonLabel: string;
  testId: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span> {cta}
      </p>
      <Button size="sm" onClick={onClick} data-testid={testId}>
        {buttonLabel}
      </Button>
    </div>
  );
}

function FieldShell({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-xs">
        {label} {required && <span className="text-rose-700">*</span>}
      </Label>
      {children}
    </div>
  );
}

function FieldPair({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{children}</div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground self-baseline">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof AccountApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

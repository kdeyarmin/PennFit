import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatientListItem } from "@workspace/api-client-react/admin";
import { PatientSearchCombobox } from "../PatientSearchCombobox";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import { fetchCatalog } from "@/lib/admin/catalog-api";
import {
  getPricingRevenueProfiles,
  savePricingRevenueProfile,
  pricingKey,
  type RevenueProfile,
  type RevenueProfileInput,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
  pricingMoneyInput,
  pricingExpiry,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingNotice,
  PricingSection,
  pricingControl,
} from "./PricingPrimitives";

type ProfileLine = { id: string; sku: string; quantity: string };
const newLine = (): ProfileLine => ({
  id: crypto.randomUUID(),
  sku: "",
  quantity: "1",
});
const fresh = () => ({
  name: "",
  allowed: "",
  collectible: "",
  insurer: "",
  secondary: "",
  patient: "",
  adjustment: "",
  source: "",
  effectiveFrom: new Date().toISOString().slice(0, 16),
  expiry: "",
});
function effectiveTimestamp(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(`${value}:00.000Z`);
  return Number.isFinite(at.getTime()) &&
    at.toISOString().slice(0, 16) === value
    ? at.toISOString()
    : null;
}

/** Management-owned evidence, reusable only for its exact patient and items. */
export function PricingRevenueProfilesPanel({
  canManage,
}: {
  canManage: boolean;
}) {
  const qc = useQueryClient(),
    version = useRef(0);
  const [patient, setPatient] = useState<PatientListItem | null>(null),
    [offset, setOffset] = useState(0);
  const [form, setForm] = useState(fresh),
    [lines, setLines] = useState<ProfileLine[]>(() => [newLine()]);
  const [editing, setEditing] = useState<RevenueProfile | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const profiles = useQuery({
    queryKey: [
      ...pricingKey,
      "revenue-profiles",
      patient?.id,
      "history",
      offset,
    ],
    queryFn: () => getPricingRevenueProfiles(offset, patient!.id, "history"),
    enabled: !!patient,
  });
  const save = useMutation({
    mutationFn: ({ body }: { body: RevenueProfileInput; version: number }) =>
      savePricingRevenueProfile(body),
    onSuccess: (data, variables) => {
      void qc.invalidateQueries({
        queryKey: [...pricingKey, "revenue-profiles"],
      });
      if (variables.version !== version.current) return;
      setEditing(null);
      setForm(fresh());
      setLines([newLine()]);
      setNotice(
        `Verified collection profile saved as version ${data.version}. It applies only to the recorded patient, items and quantities.`,
      );
    },
  });
  const reset = () => {
    version.current++;
    save.reset();
    setEditing(null);
    setForm(fresh());
    setLines([newLine()]);
    setError(null);
    setNotice("");
  };
  const change = (action: () => void) => {
    version.current++;
    save.reset();
    setError(null);
    setNotice("");
    action();
  };
  const revise = (profile: RevenueProfile) => {
    if (!canManage || profile.patientId !== patient?.id) return;
    change(() => {
      setEditing(profile);
      setForm({
        name: profile.name,
        allowed: pricingMoneyInput(profile.allowedCents),
        collectible: pricingMoneyInput(profile.expectedCollectibleCents),
        insurer: pricingMoneyInput(profile.expectedInsurerCents),
        secondary: pricingMoneyInput(profile.expectedSecondaryCents),
        patient: pricingMoneyInput(profile.expectedPatientCents),
        adjustment: pricingMoneyInput(profile.collectionAdjustmentCents),
        source: profile.source,
        effectiveFrom: new Date().toISOString().slice(0, 16),
        expiry: profile.expiresAt.slice(0, 10),
      });
      setLines(
        profile.lines.map((line) => ({
          id: crypto.randomUUID(),
          sku: line.sku,
          quantity: String(line.quantity),
        })),
      );
    });
  };
  const submit = () => {
    setError(null);
    setNotice("");
    if (!canManage || !patient || save.isPending) return;
    const allowedCents = parsePricingMoney(form.allowed),
      expectedCollectibleCents = parsePricingMoney(form.collectible),
      effectiveFrom = effectiveTimestamp(form.effectiveFrom),
      expiresAt = pricingExpiry(form.expiry);
    if (
      !form.name.trim() ||
      !form.source.trim() ||
      allowedCents === null ||
      expectedCollectibleCents === null ||
      expectedCollectibleCents > allowedCents ||
      !effectiveFrom ||
      !expiresAt ||
      Date.parse(expiresAt) <= Math.max(Date.now(), Date.parse(effectiveFrom))
    ) {
      setError(
        "Enter the evidence name, source, valid dates and exact dollar amounts. Expected total collections cannot exceed the allowed amount; enter zero explicitly when verified.",
      );
      return;
    }
    const allocation: Partial<RevenueProfileInput> = {};
    if (
      [form.insurer, form.secondary, form.patient, form.adjustment].some(
        (value) => value.trim(),
      )
    ) {
      const expectedInsurerCents = parsePricingMoney(form.insurer),
        expectedSecondaryCents = parsePricingMoney(form.secondary),
        expectedPatientCents = parsePricingMoney(form.patient);
      const adjustment = form.adjustment.trim(),
        absoluteAdjustment = parsePricingMoney(
          adjustment.startsWith("-") ? adjustment.slice(1) : adjustment,
        );
      const collectionAdjustmentCents =
        absoluteAdjustment === null
          ? null
          : absoluteAdjustment * (adjustment.startsWith("-") ? -1 : 1);
      if (
        expectedInsurerCents === null ||
        expectedSecondaryCents === null ||
        expectedPatientCents === null ||
        collectionAdjustmentCents === null ||
        expectedInsurerCents +
          expectedSecondaryCents +
          expectedPatientCents +
          collectionAdjustmentCents !==
          expectedCollectibleCents
      ) {
        setError(
          "Complete all four collection allocation amounts, including zero. Insurer, secondary, patient and signed adjustment must add exactly to expected total collections.",
        );
        return;
      }
      Object.assign(allocation, {
        expectedInsurerCents,
        expectedSecondaryCents,
        expectedPatientCents,
        collectionAdjustmentCents,
      });
    }
    const items: RevenueProfileInput["lines"] = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(line.sku) ||
        !/^\d+$/.test(line.quantity) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10_000
      ) {
        setError(
          "Choose each canonical item and enter a whole quantity between 1 and 10,000.",
        );
        return;
      }
      items.push({ sku: line.sku, quantity });
    }
    if (new Set(items.map((line) => line.sku)).size !== items.length) {
      setError("Combine duplicate items into one exact quantity per SKU.");
      return;
    }
    const body: RevenueProfileInput = {
      ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
      name: form.name.trim(),
      patientId: patient.id,
      lines: items,
      allowedCents,
      expectedCollectibleCents,
      source: form.source.trim(),
      effectiveFrom,
      expiresAt,
      ...allocation,
    };
    save.mutate({ body, version: version.current });
  };
  return (
    <div className="space-y-5">
      {notice && <PricingNotice>{notice}</PricingNotice>}
      <PricingSection
        title="Verified insurance collection profiles"
        description="A pricing manager records expected collections from verified evidence. CSRs can reuse a current profile only for the same patient and exact item quantities. Billed charges and patient responsibility remain separate."
      >
        <PatientSearchCombobox
          value={patient}
          onChange={(next) => {
            reset();
            setOffset(0);
            setPatient(next);
          }}
          aria-label="Collection profile patient"
          disabled={save.isPending}
        />
        {!patient ? (
          <p className="mt-3 text-sm text-slate-600">
            Select a patient to review their verified collection evidence.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {profiles.isPending ? (
              <p role="status">Loading collection profiles…</p>
            ) : profiles.error ? (
              <ErrorPanel
                error={profiles.error}
                onRetry={() => void profiles.refetch()}
              />
            ) : (
              <>
                {profiles.data?.profiles.length === 0 && (
                  <p className="text-sm text-slate-600">
                    No collection profiles are recorded for this patient.
                  </p>
                )}
                {profiles.data?.profiles.map((profile) => (
                  <article
                    key={`${profile.id}:${profile.version}`}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-4"
                  >
                    <div>
                      <h3 className="font-semibold">{profile.name}</h3>
                      <p className="mt-1 text-sm">
                        {patient.firstName} {patient.lastName} ·{" "}
                        {profile.lines
                          .map((line) => `${line.sku} × ${line.quantity}`)
                          .join(", ")}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Expected total{" "}
                        {formatPricingMoney(profile.expectedCollectibleCents)} ·
                        Allowed {formatPricingMoney(profile.allowedCents)} ·
                        Version {profile.version}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {profile.expectedInsurerCents === undefined
                          ? "Collection split not allocated; the total is supported by the recorded evidence."
                          : `Insurer ${formatPricingMoney(profile.expectedInsurerCents)} · Secondary ${formatPricingMoney(profile.expectedSecondaryCents)} · Patient ${formatPricingMoney(profile.expectedPatientCents)} · Collection adjustment ${formatPricingMoney(profile.collectionAdjustmentCents)}`}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {profile.source} · Effective{" "}
                        {new Date(profile.effectiveFrom).toLocaleString()} ·
                        Expires {new Date(profile.expiresAt).toLocaleString()}
                      </p>
                      {Date.parse(profile.expiresAt) <= Date.now() && (
                        <p className="mt-1 text-sm text-amber-800">
                          Expired — refresh the evidence before reuse.
                        </p>
                      )}
                    </div>
                    {canManage && (
                      <Button
                        intent="secondary"
                        size="sm"
                        disabled={save.isPending || profiles.isFetching}
                        onClick={() => revise(profile)}
                      >
                        Revise profile
                      </Button>
                    )}
                  </article>
                ))}
                <div className="flex justify-end gap-2">
                  <Button
                    intent="ghost"
                    disabled={!offset || profiles.isFetching || save.isPending}
                    onClick={() => setOffset((n) => Math.max(0, n - 50))}
                  >
                    Previous profiles
                  </Button>
                  <Button
                    intent="ghost"
                    disabled={
                      !profiles.data?.hasMore ||
                      profiles.isFetching ||
                      save.isPending
                    }
                    onClick={() => setOffset((n) => n + 50)}
                  >
                    Next profiles
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </PricingSection>
      {patient && canManage && (
        <PricingSection
          title={
            editing
              ? `Revise collection profile · version ${editing.version + 1}`
              : "Record verified collection evidence"
          }
          description={`For ${patient.firstName} ${patient.lastName}. Saving creates a new version; a changed patient or item quantity requires its own matching evidence.`}
        >
          <fieldset disabled={save.isPending} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <PricingField label="Collection profile name">
                <input
                  className={pricingControl}
                  maxLength={200}
                  value={form.name}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({ ...old, name: e.target.value })),
                    )
                  }
                />
              </PricingField>
              <PricingField
                label="Evidence / payer reference"
                hint="Record the verified source. Do not add insurance payments and total patient responsibility twice."
              >
                <input
                  className={pricingControl}
                  maxLength={1000}
                  value={form.source}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({ ...old, source: e.target.value })),
                    )
                  }
                />
              </PricingField>
              <PricingField label="Total allowed revenue ($)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={form.allowed}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({ ...old, allowed: e.target.value })),
                    )
                  }
                />
              </PricingField>
              <PricingField
                label="Expected total collections ($)"
                hint="Insurance plus collectible patient amounts, counted once; this does not establish patient liability."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={form.collectible}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({
                        ...old,
                        collectible: e.target.value,
                      })),
                    )
                  }
                />
              </PricingField>
              <PricingField label="Evidence effective from (UTC)">
                <input
                  className={pricingControl}
                  type="datetime-local"
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({
                        ...old,
                        effectiveFrom: e.target.value,
                      })),
                    )
                  }
                />
              </PricingField>
              <PricingField label="Evidence valid through (UTC)">
                <input
                  className={pricingControl}
                  type="date"
                  value={form.expiry}
                  onChange={(e) =>
                    change(() =>
                      setForm((old) => ({ ...old, expiry: e.target.value })),
                    )
                  }
                />
              </PricingField>
            </div>
            <details className="rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                Optional collection allocation
              </summary>
              <p className="mt-2 text-xs text-slate-600">
                Leave all four blank when the verified total is not allocated.
                Otherwise enter every amount, including zero. Use a negative
                collection adjustment for modeled loss; do not deduct that same
                risk again as a reserve.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {(
                  [
                    ["insurer", "Expected primary insurer collections ($)"],
                    ["secondary", "Expected secondary collections ($)"],
                    ["patient", "Expected patient collections ($)"],
                    ["adjustment", "Signed collection adjustment ($)"],
                  ] as const
                ).map(([key, label]) => (
                  <PricingField key={key} label={label}>
                    <input
                      className={pricingControl}
                      inputMode="decimal"
                      value={form[key]}
                      onChange={(e) =>
                        change(() =>
                          setForm((old) => ({ ...old, [key]: e.target.value })),
                        )
                      }
                    />
                  </PricingField>
                ))}
              </div>
            </details>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <ProfileItemEditor
                  key={line.id}
                  index={index}
                  value={line}
                  onChange={(next) =>
                    change(() =>
                      setLines((old) =>
                        old.map((row) => (row.id === line.id ? next : row)),
                      ),
                    )
                  }
                  onRemove={
                    lines.length > 1
                      ? () =>
                          change(() =>
                            setLines((old) =>
                              old.filter((row) => row.id !== line.id),
                            ),
                          )
                      : undefined
                  }
                />
              ))}
              <Button
                intent="secondary"
                disabled={lines.length >= 100}
                onClick={() =>
                  change(() => setLines((old) => [...old, newLine()]))
                }
              >
                Add covered item
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            {save.error && <ErrorPanel error={save.error} onRetry={submit} />}
            <div className="flex gap-3">
              <Button isLoading={save.isPending} onClick={submit}>
                Save verified collection profile
              </Button>
              {editing && (
                <Button intent="ghost" onClick={reset}>
                  Cancel revision
                </Button>
              )}
            </div>
          </fieldset>
        </PricingSection>
      )}
      {!canManage && (
        <p className="text-sm text-slate-600">
          A pricing manager can record or revise verified collection evidence.
        </p>
      )}
    </div>
  );
}

function ProfileItemEditor({
  index,
  value,
  onChange,
  onRemove,
}: {
  index: number;
  value: ProfileLine;
  onChange: (value: ProfileLine) => void;
  onRemove?: () => void;
}) {
  const [search, setSearch] = useState(value.sku);
  const catalog = useQuery({
    queryKey: [...pricingKey, "profile-catalog", search],
    queryFn: () => fetchCatalog({ q: search, limit: 20, offset: 0 }),
    enabled: search.trim().length >= 2,
  });
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <PricingField label={`Covered item ${index + 1} search`}>
          <input
            className={pricingControl}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              onChange({ ...value, sku: "" });
            }}
            placeholder="Search item name or SKU"
          />
        </PricingField>
        <PricingField label={`Covered item ${index + 1}`}>
          <select
            className={pricingControl}
            value={value.sku}
            onChange={(e) => onChange({ ...value, sku: e.target.value })}
          >
            <option value="">Choose exact catalog item</option>
            {value.sku &&
              !catalog.data?.products.some(
                (product) => product.sku === value.sku,
              ) && <option value={value.sku}>{value.sku}</option>}
            {catalog.data?.products
              .filter((product) => product.active)
              .map((product) => (
                <option key={product.sku} value={product.sku}>
                  {product.name} · {product.sku}
                </option>
              ))}
          </select>
        </PricingField>
        <PricingField label={`Covered item ${index + 1} quantity`}>
          <input
            className={pricingControl}
            type="number"
            min={1}
            max={10_000}
            value={value.quantity}
            onChange={(e) => onChange({ ...value, quantity: e.target.value })}
          />
        </PricingField>
      </div>
      {catalog.error && (
        <ErrorPanel
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      )}{" "}
      {onRemove && (
        <Button intent="ghost" className="mt-2" onClick={onRemove}>
          Remove covered item {index + 1}
        </Button>
      )}
    </div>
  );
}

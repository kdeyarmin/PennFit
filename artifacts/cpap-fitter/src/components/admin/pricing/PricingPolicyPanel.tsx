import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  getPricingPolicies,
  pricingKey,
  publishPricingPolicy,
  savePricingPolicy,
  type PricingState,
  type PolicyInput,
} from "@/lib/admin/pricing-api";
import {
  parsePricingMoney,
  parsePricingPercent,
  pricingExpiry,
  formatPricingMoney,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingNotice,
  PricingSection,
  pricingControl,
} from "./PricingPrimitives";
import { SUPPLY_CATEGORIES } from "@/lib/admin/catalog-api";

type RulesDraft = {
  target: string;
  floor: string;
  minimum: string;
  basis: "contribution" | "after_overhead";
  increment: string;
  ending: string;
  ceiling: string;
  lineFloor: string;
};
type OverrideDraft = {
  id: string;
  scope: "sku" | "category" | "revenue_mode";
  value: string;
  priority: string;
  effectiveFrom: string;
  expiry: string;
  rules: RulesDraft;
};
const utcMinute = () => new Date().toISOString().slice(0, 16);
function timestamp(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const result = new Date(`${value}:00.000Z`);
  return Number.isFinite(result.getTime()) &&
    result.toISOString().slice(0, 16) === value
    ? result.toISOString()
    : null;
}

function OverrideEditor({
  index,
  value,
  onChange,
  onRemove,
}: {
  index: number;
  value: OverrideDraft;
  onChange: (value: OverrideDraft) => void;
  onRemove: () => void;
}) {
  const label = `Override ${index + 1}`;
  const rule = (key: keyof RulesDraft, next: string) =>
    onChange({ ...value, rules: { ...value.rules, [key]: next } });
  return (
    <fieldset className="rounded-lg border border-slate-200 p-4">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <div className="grid gap-3 md:grid-cols-3">
        <PricingField label={`${label} scope`}>
          <select
            className={pricingControl}
            value={value.scope}
            onChange={(e) =>
              onChange({
                ...value,
                scope: e.target.value as OverrideDraft["scope"],
                value: "",
              })
            }
          >
            <option value="sku">Exact item SKU</option>
            <option value="category">Catalog category</option>
            <option value="revenue_mode">Revenue mode</option>
          </select>
        </PricingField>
        <PricingField label={`${label} match`}>
          {value.scope === "sku" ? (
            <input
              className={pricingControl}
              value={value.value}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
              placeholder="Exact canonical SKU"
            />
          ) : (
            <select
              className={pricingControl}
              value={value.value}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
            >
              <option value="">Choose match</option>
              {(value.scope === "category"
                ? SUPPLY_CATEGORIES
                : ["insurance", "self_pay"]
              ).map((option) => (
                <option key={option} value={option}>
                  {option.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          )}
        </PricingField>
        <PricingField
          label={`${label} priority`}
          hint="Higher priority wins within the same scope."
        >
          <input
            className={pricingControl}
            type="number"
            min={0}
            max={1000}
            value={value.priority}
            onChange={(e) => onChange({ ...value, priority: e.target.value })}
          />
        </PricingField>
        <PricingField label={`${label} effective from (UTC)`}>
          <input
            className={pricingControl}
            type="datetime-local"
            value={value.effectiveFrom}
            onChange={(e) =>
              onChange({ ...value, effectiveFrom: e.target.value })
            }
          />
        </PricingField>
        <PricingField label={`${label} valid through (UTC)`}>
          <input
            className={pricingControl}
            type="date"
            value={value.expiry}
            onChange={(e) => onChange({ ...value, expiry: e.target.value })}
          />
        </PricingField>
        <PricingField label={`${label} profit basis`}>
          <select
            className={pricingControl}
            value={value.rules.basis}
            onChange={(e) => rule("basis", e.target.value)}
          >
            <option value="contribution">After variable costs</option>
            <option value="after_overhead">
              After variable costs and overhead
            </option>
          </select>
        </PricingField>
        {(
          [
            ["target", "target margin (%)"],
            ["floor", "order floor (%)"],
            ["minimum", "minimum contribution ($)"],
            ["lineFloor", "allocated item floor (%)"],
            ["increment", "price increment ($)"],
            ["ending", "price ending ($)"],
            ["ceiling", "price ceiling ($)"],
          ] as const
        ).map(([key, title]) => (
          <PricingField key={key} label={`${label} ${title}`}>
            <input
              className={pricingControl}
              inputMode="decimal"
              value={value.rules[key]}
              onChange={(e) => rule(key, e.target.value)}
            />
          </PricingField>
        ))}
      </div>
      <Button intent="ghost" className="mt-3" onClick={onRemove}>
        Remove {label.toLowerCase()}
      </Button>
    </fieldset>
  );
}
function parseRules(draft: RulesDraft): PolicyInput["rules"] | null {
  const targetMarginBps = parsePricingPercent(draft.target),
    floorMarginBps = parsePricingPercent(draft.floor);
  const minimumContributionCents = draft.minimum.trim()
    ? parsePricingMoney(draft.minimum)
    : undefined;
  const priceIncrementCents = parsePricingMoney(draft.increment),
    priceEndingCents = draft.ending.trim()
      ? parsePricingMoney(draft.ending)
      : undefined;
  const priceCeilingCents = draft.ceiling.trim()
    ? parsePricingMoney(draft.ceiling)
    : undefined;
  const lineFloorMarginBps = draft.lineFloor.trim()
    ? parsePricingPercent(draft.lineFloor)
    : undefined;
  if (
    targetMarginBps === null ||
    floorMarginBps === null ||
    floorMarginBps > targetMarginBps ||
    minimumContributionCents === null ||
    !priceIncrementCents ||
    priceIncrementCents > 1_000_000 ||
    priceEndingCents === null ||
    (priceEndingCents !== undefined &&
      priceEndingCents >= priceIncrementCents) ||
    priceCeilingCents === null ||
    lineFloorMarginBps === null
  )
    return null;
  return {
    targetMarginBps,
    floorMarginBps,
    basis: draft.basis,
    priceIncrementCents,
    ...(minimumContributionCents === undefined
      ? {}
      : { minimumContributionCents }),
    ...(priceEndingCents === undefined ? {} : { priceEndingCents }),
    ...(priceCeilingCents === undefined ? {} : { priceCeilingCents }),
    ...(lineFloorMarginBps === undefined ? {} : { lineFloorMarginBps }),
  };
}

export function PricingPolicyPanel({
  state,
  canManage,
  canPublish,
}: {
  state: PricingState;
  canManage: boolean;
  canPublish: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, dialog] = useConfirmDialog();
  const policies = useQuery({
    queryKey: [...pricingKey, "policies"],
    queryFn: getPricingPolicies,
  });
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [floor, setFloor] = useState("");
  const [minimum, setMinimum] = useState("");
  const [basis, setBasis] = useState<"contribution" | "after_overhead">(
    "contribution",
  );
  const [expiry, setExpiry] = useState("");
  const [increment, setIncrement] = useState("0.01");
  const [ceiling, setCeiling] = useState("");
  const [ending, setEnding] = useState("");
  const [lineFloor, setLineFloor] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(utcMinute);
  const [overrides, setOverrides] = useState<OverrideDraft[]>([]);
  const [enforce, setEnforce] = useState(state.enforceQuotes);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const save = useMutation({
    mutationFn: savePricingPolicy,
    onSuccess: () => {
      setNotice(
        "Policy saved as a draft. Publish it below when you are ready.",
      );
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const publish = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      enabled: boolean;
      enforceQuotes: boolean;
      expectedStateRevision: number;
    }) => publishPricingPolicy(id, body),
    onSuccess: () => {
      setNotice(
        "Policy settings published. Existing signed order terms remain unchanged.",
      );
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const submit = () => {
    setError(null);
    setNotice("");
    const startsAt = timestamp(effectiveFrom),
      expiresAt = pricingExpiry(expiry);
    const rules = parseRules({
      target,
      floor,
      minimum,
      basis,
      increment,
      ending,
      ceiling,
      lineFloor,
    });
    if (!canManage) return;
    if (
      !name.trim() ||
      !startsAt ||
      !expiresAt ||
      Date.parse(expiresAt) <= Math.max(Date.now(), Date.parse(startsAt)) ||
      !rules
    ) {
      setError(
        "Enter a name, valid start and future expiry, and valid rules. The floor cannot exceed the target; a price ending must be below its increment.",
      );
      return;
    }
    const resolved: NonNullable<PolicyInput["overrides"]> = [];
    const keys = new Set<string>();
    for (const [index, override] of overrides.entries()) {
      const from = timestamp(override.effectiveFrom),
        until = pricingExpiry(override.expiry),
        rule = parseRules(override.rules),
        priority = Number(override.priority),
        value = override.value.trim();
      const key = `${override.scope}:${value}:${priority}`;
      if (
        !value ||
        value.length > 100 ||
        !/^\d+$/.test(override.priority) ||
        !Number.isInteger(priority) ||
        priority > 1000 ||
        !rule ||
        !from ||
        !until ||
        Date.parse(from) < Date.parse(startsAt) ||
        Date.parse(until) > Date.parse(expiresAt) ||
        Date.parse(until) <= Math.max(Date.now(), Date.parse(from)) ||
        keys.has(key) ||
        (override.scope === "sku" && !/^[A-Za-z0-9._-]{1,64}$/.test(value)) ||
        (override.scope === "revenue_mode" &&
          !["insurance", "self_pay"].includes(value))
      ) {
        setError(
          `Override ${index + 1} needs a unique scope/value/priority, complete valid rules, and dates inside the parent policy.`,
        );
        return;
      }
      keys.add(key);
      resolved.push({
        scope: override.scope,
        value,
        priority,
        effectiveFrom: from,
        expiresAt: until,
        rules: rule,
      });
    }
    const body: PolicyInput = {
      name: name.trim(),
      effectiveFrom: startsAt,
      expiresAt,
      rules,
      ...(resolved.length ? { overrides: resolved } : {}),
    };
    save.mutate(body);
  };
  const publishPolicy = async (id: string, enabled = true) => {
    const current = captureSessionCacheGuard(qc);
    const body = {
      id,
      enabled,
      enforceQuotes: enabled && enforce,
      expectedStateRevision: state.revision,
    };
    const approved = await confirm({
      title: enabled ? "Publish pricing policy?" : "Pause pricing policy?",
      description: enabled
        ? `This will apply the selected policy to new reviews.${enforce ? " Every new patient order will require an approved insurance review." : " Patient orders may still proceed without a pricing review."}`
        : "New orders will use the existing workflow without enforced pricing reviews.",
      confirmLabel: enabled ? "Publish policy" : "Pause policy",
    });
    if (approved && current()) publish.mutate(body);
  };
  return (
    <div className="space-y-5">
      {dialog}
      {!state.policy && (
        <PricingNotice>
          Set your own target and floor to start. No margin target has been
          assumed, and pricing enforcement is off.
        </PricingNotice>
      )}
      {notice && <PricingNotice>{notice}</PricingNotice>}
      <PricingSection
        title="Set the business rules"
        description="Margin is profit divided by revenue. A 40% margin is different from a 40% markup. Insurance reviews use expected collections, not the billed amount."
      >
        {canManage ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <PricingField label="Policy name">
                <input
                  className={pricingControl}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Standard supply policy"
                />
              </PricingField>
              <PricingField label="Target margin (%)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="Enter your target"
                />
              </PricingField>
              <PricingField label="Approval floor (%)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  placeholder="Lowest permitted margin"
                />
              </PricingField>
              <PricingField
                label="Minimum profit per order ($)"
                hint="Optional, in addition to the percentage floor."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                  placeholder="No additional minimum"
                />
              </PricingField>
              <PricingField label="Profit basis">
                <select
                  className={pricingControl}
                  value={basis}
                  onChange={(e) => setBasis(e.target.value as typeof basis)}
                >
                  <option value="contribution">After variable costs</option>
                  <option value="after_overhead">
                    After variable costs and allocated overhead
                  </option>
                </select>
              </PricingField>
              <PricingField label="Valid through (UTC)">
                <input
                  className={pricingControl}
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
              </PricingField>
              <PricingField label="Effective from (UTC)">
                <input
                  className={pricingControl}
                  type="datetime-local"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </PricingField>
              <PricingField label="Self-pay price increment ($)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={increment}
                  onChange={(e) => setIncrement(e.target.value)}
                />
              </PricingField>
              <PricingField
                label="Self-pay price ceiling ($)"
                hint="Optional. This does not change insurance liability."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                  placeholder="No ceiling"
                />
              </PricingField>
              <PricingField
                label="Price ending within increment ($)"
                hint="For .99 pricing, use a $1 increment and $0.99 ending."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={ending}
                  onChange={(e) => setEnding(e.target.value)}
                />
              </PricingField>
              <PricingField
                label="Allocated item floor (%)"
                hint="Optional. Leaving this blank permits item subsidies within an order that meets the order rules."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={lineFloor}
                  onChange={(e) => setLineFloor(e.target.value)}
                />
              </PricingField>
            </div>
            <div className="space-y-3 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold">Scoped pricing rules</h3>
              <p className="text-xs text-slate-600">
                Item rules take precedence over category rules, then revenue
                mode, then company rules. Priority resolves matches within a
                scope. A mixed order must satisfy the strictest applicable
                rules. Each override contains its own complete rules; later
                edits to the company form do not change it.
              </p>
              {overrides.map((override, index) => (
                <OverrideEditor
                  key={override.id}
                  index={index}
                  value={override}
                  onChange={(next) =>
                    setOverrides((old) =>
                      old.map((row) => (row.id === override.id ? next : row)),
                    )
                  }
                  onRemove={() =>
                    setOverrides((old) =>
                      old.filter((row) => row.id !== override.id),
                    )
                  }
                />
              ))}
              <Button
                intent="secondary"
                disabled={overrides.length >= 100 || save.isPending}
                onClick={() =>
                  setOverrides((old) => [
                    ...old,
                    {
                      id: crypto.randomUUID(),
                      scope: "sku",
                      value: "",
                      priority: "0",
                      effectiveFrom,
                      expiry,
                      rules: {
                        target,
                        floor,
                        minimum,
                        basis,
                        increment,
                        ending,
                        ceiling,
                        lineFloor,
                      },
                    },
                  ])
                }
              >
                Add scoped override
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            {save.error && <ErrorPanel error={save.error} onRetry={submit} />}
            <Button isLoading={save.isPending} onClick={submit}>
              Save draft policy
            </Button>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            A pricing manager maintains the policy. You can evaluate items
            against the current published rules.
          </p>
        )}
      </PricingSection>
      <PricingSection
        title="Policy versions"
        description="Publishing changes future reviews. A previous policy can be published again if it is still valid."
      >
        {policies.isPending ? (
          <p role="status">Loading policies…</p>
        ) : policies.error ? (
          <ErrorPanel
            error={policies.error}
            onRetry={() => void policies.refetch()}
          />
        ) : (
          <div className="space-y-3">
            {canPublish && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enforce}
                  onChange={(e) => setEnforce(e.target.checked)}
                />
                <span>
                  Require an approved insurance review before creating patient
                  orders
                </span>
              </label>
            )}
            {policies.data?.policies.length === 0 && (
              <p className="text-sm text-slate-500">No policies saved yet.</p>
            )}
            {policies.data?.policies.map((policy) => (
              <div
                key={policy.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-4"
              >
                <div>
                  <p className="font-medium">
                    {policy.name}{" "}
                    {state.policy?.id === policy.id && state.enabled && (
                      <span className="ml-2 text-xs text-emerald-700">
                        Active
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Target {policy.rules.targetMarginBps / 100}% · Floor{" "}
                    {policy.rules.floorMarginBps / 100}% · Minimum{" "}
                    {formatPricingMoney(
                      policy.rules.minimumContributionCents ?? 0,
                    )}{" "}
                    · Valid through {policy.expiresAt.slice(0, 10)}
                  </p>
                  {!!policy.overrides?.length && (
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer font-medium">
                        Review {policy.overrides.length} scoped rules
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {policy.overrides.map((override, index) => (
                          <li key={index} className="rounded bg-slate-50 p-2">
                            {override.scope.replaceAll("_", " ")}:{" "}
                            {override.value} · Priority {override.priority} ·
                            Target {override.rules.targetMarginBps / 100}% ·
                            Floor {override.rules.floorMarginBps / 100}% ·
                            Minimum{" "}
                            {formatPricingMoney(
                              override.rules.minimumContributionCents ?? 0,
                            )}{" "}
                            ·{" "}
                            {override.rules.basis === "after_overhead"
                              ? "After overhead"
                              : "Contribution"}{" "}
                            ·{" "}
                            {new Date(override.effectiveFrom).toLocaleString()}{" "}
                            to {new Date(override.expiresAt).toLocaleString()}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                {canPublish && (
                  <Button
                    intent="secondary"
                    disabled={
                      publish.isPending ||
                      Date.parse(policy.expiresAt) <= Date.now()
                    }
                    onClick={() => void publishPolicy(policy.id)}
                  >
                    Publish this policy
                  </Button>
                )}
              </div>
            ))}
            {canPublish && state.enabled && state.policy && (
              <Button
                intent="ghost"
                disabled={publish.isPending}
                onClick={() => void publishPolicy(state.policy!.id, false)}
              >
                Pause pricing enforcement
              </Button>
            )}
            {publish.error && (
              <ErrorPanel
                error={publish.error}
                onRetry={() =>
                  void qc.invalidateQueries({ queryKey: pricingKey })
                }
              />
            )}
          </div>
        )}
      </PricingSection>
    </div>
  );
}

// Front Desk — walk-in / counter capture for CSRs.
//
// One counter-optimized screen that lets a rep, in real time:
//   1. Find an existing patient OR fast-capture a new walk-in.
//   2. Ring up a counter order (cash or bill-to-insurance) from the live
//      catalog, fulfilled as in-store pickup (default) or shipped.
//   3. Hand the product over (mark picked up) and jump straight to the
//      full patient record for any clinical / billing follow-up.
//
// It reuses the existing patient, catalog, counter-order, and pickup
// endpoints rather than duplicating any of that logic. The order itself
// is created by POST /admin/shop/counter-orders (no Stripe charge — cash
// is collected at the counter, insurance routes to the billing worklist).

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

import {
  ApiError,
  useCreatePatient,
  useListPatients,
  getListPatientsQueryKey,
  useFrontDeskCatalog,
  useCreateCounterOrder,
  useMarkCounterOrderPickedUp,
  type CreatePatientRequest,
  type FrontDeskProduct,
  type CreateCounterOrderResponse,
} from "@workspace/api-client-react/admin";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { LOCATIONS_QUERY_KEY, listLocations } from "@/lib/admin/locations-api";

// ── Money ──────────────────────────────────────────────────────────
function formatCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

interface SelectedPatient {
  id: string;
  name: string;
  /** Captured at intake when available — lets the order bind onto the
   *  patient record via the existing email-lower join. Null for an
   *  existing patient selected from search (we don't surface PHI email
   *  in the list). */
  email: string | null;
}

// ── Walk-in intake (compact) ───────────────────────────────────────
const E164 = /^\+[1-9]\d{7,14}$/;

function WalkInIntake({
  onCreated,
  onCancel,
}: {
  onCreated: (p: SelectedPatient) => void;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMut = useCreatePatient();
  const isPending = createMut.isPending;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim() || !dob) {
      setError("First name, last name, and date of birth are required.");
      return;
    }
    const trimmedPhone = phone.trim();
    if (trimmedPhone && !E164.test(trimmedPhone)) {
      setError("Phone must be E.164 format, e.g. +14155551212.");
      return;
    }
    const body: CreatePatientRequest = {
      legalFirstName: firstName.trim(),
      legalLastName: lastName.trim(),
      dateOfBirth: dob,
      phoneE164: trimmedPhone || null,
      email: email.trim() || null,
    };
    try {
      const res = await createMut.mutateAsync({ data: body });
      onCreated({
        id: res.id,
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim() ? email.trim().toLowerCase() : null,
      });
    } catch (err) {
      setError(describeError(err, "Couldn't create the walk-in customer."));
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="fd-first">Legal first name</Label>
          <Input
            id="fd-first"
            value={firstName}
            maxLength={80}
            onChange={(e) => setFirstName(e.target.value)}
            required
            disabled={isPending}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="fd-last">Legal last name</Label>
          <Input
            id="fd-last"
            value={lastName}
            maxLength={80}
            onChange={(e) => setLastName(e.target.value)}
            required
            disabled={isPending}
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="fd-dob">Date of birth</Label>
          <Input
            id="fd-dob"
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            required
            disabled={isPending}
          />
        </div>
        <div>
          <Label htmlFor="fd-phone">Phone (optional)</Label>
          <Input
            id="fd-phone"
            type="tel"
            placeholder="+14155551212"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={isPending}
            autoComplete="off"
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="fd-email">Email (optional)</Label>
          <Input
            id="fd-email"
            type="email"
            value={email}
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isPending}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Capturing an email links the counter order to the patient's record
            automatically.
          </p>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating…" : "Create & continue"}
        </Button>
        <Button
          type="button"
          intent="secondary"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Find / capture step ────────────────────────────────────────────
function FindOrCapture({
  onSelect,
}: {
  onSelect: (p: SelectedPatient) => void;
}) {
  const [search, setSearch] = useState("");
  const [showIntake, setShowIntake] = useState(false);

  const trimmed = search.trim();
  const listParams = { search: trimmed || undefined, limit: 8 };
  const listQuery = useListPatients(listParams, {
    query: {
      queryKey: getListPatientsQueryKey(listParams),
      enabled: trimmed.length >= 2,
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-3">
          <div>
            <Label htmlFor="fd-search">Find a patient</Label>
            <Input
              id="fd-search"
              placeholder="Search by name, phone, email, or PacWare ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>

          {trimmed.length >= 2 ? (
            listQuery.isLoading ? (
              <div className="py-4">
                <Spinner />
              </div>
            ) : listQuery.isError ? (
              <ErrorPanel
                error={listQuery.error}
                title="Couldn't search patients."
              />
            ) : (listQuery.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No matches. Capture a new walk-in below.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {listQuery.data!.items.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {p.firstName} {p.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.pacwareId ? `PacWare ${p.pacwareId} · ` : ""}
                        {p.hasPhone ? "📞 " : ""}
                        {p.hasEmail ? "✉️ " : ""}
                        <Badge>{p.status}</Badge>
                      </p>
                    </div>
                    <Button
                      intent="secondary"
                      onClick={() =>
                        onSelect({
                          id: p.id,
                          name: `${p.firstName} ${p.lastName}`,
                          email: null,
                        })
                      }
                    >
                      Select
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Type at least 2 characters to search.
            </p>
          )}
        </div>
      </Card>

      <Card>
        {showIntake ? (
          <div className="space-y-3">
            <h2 className="text-base font-semibold">New walk-in customer</h2>
            <WalkInIntake
              onCreated={onSelect}
              onCancel={() => setShowIntake(false)}
            />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">New to the practice?</h2>
              <p className="text-sm text-muted-foreground">
                Capture a walk-in in seconds — name and date of birth are all
                you need to get started.
              </p>
            </div>
            <Button onClick={() => setShowIntake(true)}>New walk-in</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── CSR workflow guardrails ───────────────────────────────────────
type ChecklistItem = {
  id: string;
  label: string;
  detail: string;
};

const BASE_PRE_DISPENSE_CHECKS: ChecklistItem[] = [
  {
    id: "identity",
    label: "Verified patient identity",
    detail:
      "Match name + DOB before opening the account or creating a new one.",
  },
  {
    id: "prescription",
    label: "Confirmed active order / prescription",
    detail:
      "Supply or equipment is allowed by the current Rx and replacement schedule.",
  },
  {
    id: "eligibility",
    label: "Checked eligibility, plan, and balance",
    detail:
      "Confirm coverage path, copay / deductible, and any open account balance.",
  },
  {
    id: "fit",
    label: "Reviewed fit, usage, and item selection",
    detail:
      "Make sure size, mask style, filters, tubing, and quantities are correct.",
  },
];

const INSURANCE_PRE_DISPENSE_CHECKS: ChecklistItem[] = [
  {
    id: "aob",
    label: "AOB / financial responsibility is signed or queued",
    detail:
      "Assignment of Benefits and patient responsibility must be on file for billing.",
  },
  {
    id: "abn",
    label: "ABN need reviewed",
    detail:
      "If coverage is uncertain, collect the required ABN or route to billing before dispense.",
  },
];

const HANDOFF_CHECKS: ChecklistItem[] = [
  {
    id: "pod",
    label: "Proof of delivery / delivery ticket signed",
    detail:
      "Patient signs for the exact items and quantities leaving the office today.",
  },
  {
    id: "supplier-standards",
    label: "Supplier standards and rights notice provided",
    detail:
      "Give the patient their copy or confirm the current acknowledgement is already on file.",
  },
  {
    id: "payment",
    label: "Payment or billing path explained",
    detail:
      "Cash collected now, or patient understands insurance billing and possible balance.",
  },
  {
    id: "education",
    label: "Use, cleaning, warranty, and return instructions reviewed",
    detail:
      "Cover setup basics, replacement timing, contact path, and next follow-up.",
  },
  {
    id: "chart",
    label: "Chart follow-up captured",
    detail:
      "Scan/upload signed paperwork or open the patient record for any missing items.",
  },
];

function isChecklistComplete(
  items: ChecklistItem[],
  checked: Record<string, boolean>,
): boolean {
  return items.every((item) => checked[item.id]);
}

function ChecklistPanel({
  title,
  eyebrow,
  description,
  items,
  checked,
  onToggle,
}: {
  title: string;
  eyebrow: string;
  description: string;
  items: ChecklistItem[];
  checked: Record<string, boolean>;
  onToggle: (id: string, value: boolean) => void;
}) {
  const completeCount = items.filter((item) => checked[item.id]).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 shadow-inner">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {eyebrow}
          </p>
          <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-xs text-slate-600">{description}</p>
        </div>
        <Badge variant={completeCount === items.length ? "success" : undefined}>
          {completeCount}/{items.length}
        </Badge>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer gap-3 rounded-lg border border-white bg-white/85 p-3 shadow-sm transition hover:border-slate-300"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900"
              checked={Boolean(checked[item.id])}
              onChange={(e) => onToggle(item.id, e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-slate-900">
                {item.label}
              </span>
              <span className="block text-xs leading-5 text-slate-600">
                {item.detail}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Counter order panel ────────────────────────────────────────────
type Cart = Map<string, { product: FrontDeskProduct; quantity: number }>;

function CounterOrderPanel({
  patient,
  onPlaced,
}: {
  patient: SelectedPatient;
  onPlaced: (res: CreateCounterOrderResponse) => void;
}) {
  const [cart, setCart] = useState<Cart>(new Map());
  const [filter, setFilter] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "insurance">(
    "cash",
  );
  const [fulfillmentMethod, setFulfillmentMethod] = useState<"pickup" | "ship">(
    "pickup",
  );
  const [pickupLocationId, setPickupLocationId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [preDispenseChecks, setPreDispenseChecks] = useState<
    Record<string, boolean>
  >({});

  const catalog = useFrontDeskCatalog();
  const locationsQuery = useQuery({
    queryKey: LOCATIONS_QUERY_KEY,
    queryFn: listLocations,
  });
  const createMut = useCreateCounterOrder();

  const activeLocations = useMemo(
    () => (locationsQuery.data?.locations ?? []).filter((l) => l.isActive),
    [locationsQuery.data],
  );

  // Default the pickup location to the primary branch once loaded.
  const effectivePickupLocationId =
    pickupLocationId ||
    activeLocations.find((l) => l.isPrimary)?.id ||
    activeLocations[0]?.id ||
    "";

  const products = useMemo(() => {
    const all = catalog.data?.products ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [catalog.data, filter]);

  const totalCents = useMemo(() => {
    let sum = 0;
    for (const { product, quantity } of cart.values()) {
      sum += product.price.unitAmount * quantity;
    }
    return sum;
  }, [cart]);

  const preDispenseChecklist = useMemo(
    () =>
      paymentMethod === "insurance"
        ? [...BASE_PRE_DISPENSE_CHECKS, ...INSURANCE_PRE_DISPENSE_CHECKS]
        : BASE_PRE_DISPENSE_CHECKS,
    [paymentMethod],
  );
  const preDispenseComplete = isChecklistComplete(
    preDispenseChecklist,
    preDispenseChecks,
  );

  function addToCart(product: FrontDeskProduct) {
    setCart((prev) => {
      const next = new Map(prev);
      const existing = next.get(product.price.id);
      next.set(product.price.id, {
        product,
        quantity: (existing?.quantity ?? 0) + 1,
      });
      return next;
    });
  }

  function setQty(priceId: string, quantity: number) {
    setCart((prev) => {
      const next = new Map(prev);
      if (quantity <= 0) {
        next.delete(priceId);
      } else {
        const existing = next.get(priceId);
        if (existing) next.set(priceId, { ...existing, quantity });
      }
      return next;
    });
  }

  async function placeOrder() {
    setError(null);
    if (cart.size === 0) {
      setError("Add at least one item to the order.");
      return;
    }
    if (fulfillmentMethod === "pickup" && !effectivePickupLocationId) {
      setError("Choose a pickup location.");
      return;
    }
    if (!preDispenseComplete) {
      setError("Complete the front-desk checklist before placing the order.");
      return;
    }
    try {
      const res = await createMut.mutateAsync({
        patientId: patient.id,
        customerEmail: patient.email,
        items: Array.from(cart.values()).map(({ product, quantity }) => ({
          priceId: product.price.id,
          quantity,
        })),
        paymentMethod,
        fulfillmentMethod,
        pickupLocationId:
          fulfillmentMethod === "pickup" ? effectivePickupLocationId : null,
      });
      onPlaced(res);
    } catch (err) {
      setError(describeError(err, "Couldn't place the counter order."));
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Catalog picker */}
      <Card className="lg:col-span-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Add items</h2>
            <Input
              placeholder="Filter catalog…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-xs"
            />
          </div>
          {catalog.isLoading ? (
            <div className="py-6">
              <Spinner />
            </div>
          ) : catalog.isError ? (
            <ErrorPanel error={catalog.error} title="Couldn't load catalog." />
          ) : products.length === 0 ? (
            <EmptyState title="No products match your filter." />
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {products.map((p) => {
                const outOfStock = p.stockCount === 0;
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.category} · {formatCents(p.price.unitAmount)}
                        {outOfStock ? " · out of stock" : ""}
                      </p>
                    </div>
                    <Button
                      intent="secondary"
                      onClick={() => addToCart(p)}
                      disabled={outOfStock}
                    >
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      {/* Order summary + payment */}
      <Card>
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Order</h2>

          {cart.size === 0 ? (
            <p className="text-sm text-muted-foreground">No items yet.</p>
          ) : (
            <ul className="space-y-2">
              {Array.from(cart.entries()).map(([priceId, line]) => (
                <li key={priceId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {line.product.name}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    value={line.quantity}
                    onChange={(e) =>
                      setQty(priceId, Number(e.target.value) || 0)
                    }
                    className="w-16"
                    aria-label={`Quantity for ${line.product.name}`}
                  />
                  <span className="w-20 text-right text-sm tabular-nums">
                    {formatCents(line.product.price.unitAmount * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between border-t pt-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatCents(totalCents)}</span>
          </div>

          <div>
            <Label htmlFor="fd-payment">Payment</Label>
            <Select
              id="fd-payment"
              value={paymentMethod}
              options={[
                { value: "cash", label: "Cash / collected now" },
                { value: "insurance", label: "Bill to insurance" },
              ]}
              onChange={(e) =>
                setPaymentMethod(e.target.value as "cash" | "insurance")
              }
            />
            {paymentMethod === "insurance" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                No money collected now — the order is flagged for the billing
                worklist. Use the patient record to file the claim.
              </p>
            ) : null}
          </div>

          <div>
            <Label htmlFor="fd-fulfillment">Fulfillment</Label>
            <Select
              id="fd-fulfillment"
              value={fulfillmentMethod}
              options={[
                { value: "pickup", label: "In-store pickup" },
                { value: "ship", label: "Ship" },
              ]}
              onChange={(e) =>
                setFulfillmentMethod(e.target.value as "pickup" | "ship")
              }
            />
          </div>

          {fulfillmentMethod === "pickup" ? (
            <div>
              <Label htmlFor="fd-location">Pickup location</Label>
              <Select
                id="fd-location"
                value={effectivePickupLocationId}
                options={activeLocations.map((l) => ({
                  value: l.id,
                  label: l.name,
                }))}
                onChange={(e) => setPickupLocationId(e.target.value)}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Shipped counter orders need a shipping address — add it on the
              patient record, then enter tracking from the order.
            </p>
          )}

          <ChecklistPanel
            eyebrow="Before order"
            title="Ready-to-dispense checks"
            description="Keeps identity, coverage, prescription, and paperwork checks in one counter flow."
            items={preDispenseChecklist}
            checked={preDispenseChecks}
            onToggle={(id, value) =>
              setPreDispenseChecks((prev) => ({ ...prev, [id]: value }))
            }
          />

          {error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            onClick={() => void placeOrder()}
            disabled={
              createMut.isPending ||
              cart.size === 0 ||
              !preDispenseComplete ||
              // Ship lane needs an address the panel can't collect yet.
              fulfillmentMethod === "ship"
            }
            className="w-full"
          >
            {createMut.isPending
              ? "Placing…"
              : `Place ${paymentMethod === "cash" ? "cash" : "insurance"} order`}
          </Button>
          {fulfillmentMethod === "ship" ? (
            <p className="text-xs text-muted-foreground">
              Shipping from the counter isn't available yet — choose in-store
              pickup, or place a shipped order from the storefront / patient
              record.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

// ── Order placed ───────────────────────────────────────────────────
function OrderPlaced({
  patient,
  result,
  onAnother,
}: {
  patient: SelectedPatient;
  result: CreateCounterOrderResponse;
  onAnother: () => void;
}) {
  const [, navigate] = useLocation();
  const order = result.order;
  const markPickedUp = useMarkCounterOrderPickedUp();
  const [handedOver, setHandedOver] = useState(false);
  const [handoffChecks, setHandoffChecks] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);

  // Fulfillment is independent of payment: the patient walks out with the
  // supplies whether they paid cash or it's billed to insurance. So a
  // pickup order can always be handed over — an insurance order stays
  // `pending` (awaiting the payer) but is still dispensed now.
  const canHandOver = order.fulfillmentMethod === "pickup" && !handedOver;

  const paymentLabel =
    order.paymentMethod === "cash"
      ? "Cash — collected"
      : "Insurance — awaiting adjudication";
  const handoffComplete = isChecklistComplete(HANDOFF_CHECKS, handoffChecks);

  async function handOver() {
    setError(null);
    if (!handoffComplete) {
      setError("Complete the signed-paperwork and handoff checklist first.");
      return;
    }
    try {
      await markPickedUp.mutateAsync({ orderId: order.id });
      setHandedOver(true);
    } catch (err) {
      setError(describeError(err, "Couldn't mark the order picked up."));
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="success">Order placed</Badge>
          <span className="text-sm text-muted-foreground">
            for {patient.name}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Total</dt>
          <dd className="text-right tabular-nums">
            {formatCents(order.amountTotalCents, order.currency ?? "usd")}
          </dd>
          <dt className="text-muted-foreground">Payment</dt>
          <dd className="text-right">{paymentLabel}</dd>
          <dt className="text-muted-foreground">Fulfillment</dt>
          <dd className="text-right">
            {handedOver
              ? "Handed over"
              : order.fulfillmentMethod === "pickup"
                ? "Ready at counter"
                : "Ship"}
          </dd>
          <dt className="text-muted-foreground">Items</dt>
          <dd className="text-right">{order.itemCount}</dd>
        </dl>

        {canHandOver ? (
          <ChecklistPanel
            eyebrow="Before patient leaves"
            title="Signature and handoff checklist"
            description="Confirm the signed delivery ticket, required notices, payment explanation, and patient education before marking pickup complete."
            items={HANDOFF_CHECKS}
            checked={handoffChecks}
            onToggle={(id, value) =>
              setHandoffChecks((prev) => ({ ...prev, [id]: value }))
            }
          />
        ) : handedOver ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            Handoff complete — signed paperwork, patient education, and chart
            follow-up were confirmed.
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {canHandOver ? (
            <Button
              onClick={() => void handOver()}
              disabled={markPickedUp.isPending || !handoffComplete}
            >
              {markPickedUp.isPending ? "Saving…" : "Mark handed over"}
            </Button>
          ) : null}
          <Button
            intent="secondary"
            onClick={() => navigate(`/admin/patients/${patient.id}`)}
          >
            Open patient record
          </Button>
          <Button intent="secondary" onClick={onAnother}>
            Start another
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────
export function FrontDeskPage() {
  const [patient, setPatient] = useState<SelectedPatient | null>(null);
  const [placed, setPlaced] = useState<CreateCounterOrderResponse | null>(null);

  function reset() {
    setPatient(null);
    setPlaced(null);
  }

  return (
    <div className="admin-root space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Front Desk</h1>
        <p className="text-sm text-muted-foreground">
          Capture a walk-in customer and ring up a counter order in real time.
        </p>
      </div>

      {!patient ? (
        <FindOrCapture onSelect={setPatient} />
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Customer</p>
                <p className="font-medium">{patient.name}</p>
              </div>
              {!placed ? (
                <Button intent="secondary" onClick={reset}>
                  Change
                </Button>
              ) : null}
            </div>
          </Card>

          {placed ? (
            <OrderPlaced patient={patient} result={placed} onAnother={reset} />
          ) : (
            <CounterOrderPanel patient={patient} onPlaced={setPlaced} />
          )}
        </div>
      )}
    </div>
  );
}

export default FrontDeskPage;

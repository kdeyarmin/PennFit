// "Sign & pay orders" panel on the admin Orders page.
//
// A CSR builds an order here (free-form line items priced in dollars,
// optional standalone paperwork from the patient-packet template catalog) and the
// customer receives a secure link to review, e-sign, and pay via
// Stripe. The panel lists recent requests with a derived lifecycle
// badge (Sent → Viewed → Signed → Paid) plus resend / cancel actions.
//
// Backend: /resupply-api/admin/csr-order-requests* (returns.manage);
// public twin: /order-pay (token-gated).

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Loader2, Plus, Send, Trash2, X } from "lucide-react";

import {
  useCancelCsrOrderRequest,
  useCreateCsrOrderRequest,
  useCsrOrderRequests,
  useResendCsrOrderRequest,
  usePatientPacketTemplates,
  type CsrOrderRequestSummary,
} from "@workspace/api-client-react/admin";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
} from "@/components/admin/ui-shims";
import { AdminModal } from "@/components/admin/AdminModal";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatAppDateTime } from "@/lib/utils";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type DerivedStatus =
  | "sent"
  | "viewed"
  | "signed"
  | "paid"
  | "refunded"
  | "canceled"
  | "expired";

function deriveStatus(r: CsrOrderRequestSummary): DerivedStatus {
  if (r.status === "canceled") return "canceled";
  if (r.payment.status === "paid") return "paid";
  if (r.payment.status === "refunded") return "refunded";
  if (r.expiresAt && new Date(r.expiresAt).getTime() < Date.now()) {
    return "expired";
  }
  if (r.signedAt) return "signed";
  if (r.status === "viewed") return "viewed";
  return "sent";
}

const STATUS_LABEL: Record<DerivedStatus, string> = {
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed — awaiting payment",
  paid: "Paid",
  refunded: "Refunded",
  canceled: "Canceled",
  expired: "Expired",
};

const STATUS_TONE: Record<
  DerivedStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  sent: "outline",
  viewed: "secondary",
  signed: "secondary",
  paid: "default",
  refunded: "destructive",
  canceled: "destructive",
  expired: "destructive",
};

interface DraftItem {
  description: string;
  quantity: string;
  price: string; // dollars, parsed to cents on submit
}

const EMPTY_ITEM: DraftItem = { description: "", quantity: "1", price: "" };

function parsePriceToCents(price: string): number | null {
  const n = Number.parseFloat(price);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function CsrOrderRequestsPanel() {
  const { toast } = useToast();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, error } = useCsrOrderRequests({ pageSize: 25 });
  const resend = useResendCsrOrderRequest();
  const cancel = useCancelCsrOrderRequest();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["/resupply-api/admin/csr-order-requests"],
    });

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied to clipboard" });
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: link,
      });
    }
  };

  const handleResend = (r: CsrOrderRequestSummary) => {
    resend.mutate(
      { id: r.id },
      {
        onSuccess: (res) => {
          void invalidate();
          toast({
            title: `Order ${r.orderReference} re-sent`,
            description: `${res.emailSent ? "Email sent. " : ""}${res.smsSent ? "Text sent. " : ""}A fresh link was issued (older links no longer work).`,
          });
          void copyLink(res.signingLink);
        },
        onError: (err) =>
          toast({
            title: "Couldn't resend",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleCancel = async (r: CsrOrderRequestSummary) => {
    if (
      !(await confirm({
        title: `Cancel order ${r.orderReference}?`,
        description: `${r.customerName}'s link will stop working immediately.`,
        confirmLabel: "Cancel order",
        destructive: true,
      }))
    ) {
      return;
    }
    cancel.mutate(
      { id: r.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: `Order ${r.orderReference} canceled` });
        },
        onError: (err) =>
          toast({
            title: "Couldn't cancel",
            description: err.message,
            variant: "destructive",
          }),
      },
    );
  };

  const requests = data?.requests ?? [];

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-display text-xl font-bold tracking-tight">
              Sign &amp; pay orders
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Build an order for a customer and send them a secure link to
              review, sign paperwork, and pay by card.
            </p>
          </div>
          <Button
            onClick={() => setShowCreate(true)}
            data-testid="button-create-csr-order"
          >
            <Plus className="w-4 h-4 mr-1.5" /> Create order
          </Button>
        </div>

        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                  <tr>
                    <th className="text-left py-3 px-4">Reference</th>
                    <th className="text-left py-3 px-4">Customer</th>
                    <th className="text-left py-3 px-4">Total</th>
                    <th className="text-left py-3 px-4">Paperwork</th>
                    <th className="text-left py-3 px-4">Status</th>
                    <th className="text-left py-3 px-4">Sent</th>
                    <th className="text-right py-3 px-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr className="border-t border-border/40">
                      <td colSpan={7} className="py-3 px-4">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  )}
                  {!isLoading && requests.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-10 text-center text-muted-foreground"
                      >
                        No sign &amp; pay orders yet. Create one to send a
                        customer a secure sign-and-pay link.
                      </td>
                    </tr>
                  )}
                  {requests.map((r) => {
                    const status = deriveStatus(r);
                    const open =
                      status === "sent" ||
                      status === "viewed" ||
                      status === "signed" ||
                      status === "expired";
                    return (
                      <tr key={r.id} className="border-t border-border/40">
                        <td className="py-3 px-4 font-mono text-xs">
                          {r.orderReference}
                        </td>
                        <td className="py-3 px-4">
                          <div>{r.customerName}</div>
                          <div className="text-muted-foreground text-xs">
                            {r.customerEmail ?? r.customerPhone ?? ""}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium whitespace-nowrap">
                          {formatUsd(r.amountTotalCents)}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {r.documents.length === 0
                            ? "—"
                            : `${r.documents.length} doc${r.documents.length === 1 ? "" : "s"}`}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={STATUS_TONE[status]}>
                            {STATUS_LABEL[status]}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                          {formatAppDateTime(r.sentAt)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {open && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                className="mr-2"
                                disabled={resend.isPending}
                                onClick={() => handleResend(r)}
                                data-testid={`button-resend-${r.orderReference}`}
                              >
                                <Send className="w-3.5 h-3.5 mr-1" /> Resend
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={cancel.isPending}
                                onClick={() => handleCancel(r)}
                                data-testid={`button-cancel-${r.orderReference}`}
                              >
                                <X className="w-3.5 h-3.5 mr-1" /> Cancel
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {error && (
              <div className="p-4 text-sm text-destructive border-t border-border/40">
                Could not load sign &amp; pay orders: {error.message}
              </div>
            )}
          </CardContent>
        </Card>

        {showCreate && (
          <CreateCsrOrderModal
            onClose={() => setShowCreate(false)}
            onCreated={() => void invalidate()}
          />
        )}
      </div>
      {ConfirmDialogEl}
    </>
  );
}

function CreateCsrOrderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateCsrOrderRequest();
  const templates = usePatientPacketTemplates();

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);
  const [note, setNote] = useState("");
  const [documentKeys, setDocumentKeys] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    orderReference: string;
    signingLink: string;
    emailSent: boolean;
    smsSent: boolean;
  } | null>(null);

  const totalCents = useMemo(
    () =>
      items.reduce((sum, it) => {
        const cents = parsePriceToCents(it.price);
        const qty = Number.parseInt(it.quantity, 10);
        if (cents == null || !Number.isFinite(qty) || qty < 1) return sum;
        return sum + cents * qty;
      }, 0),
    [items],
  );

  const updateItem = (index: number, patch: Partial<DraftItem>) =>
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    );

  const toggleDocument = (key: string) =>
    setDocumentKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  const handleSubmit = () => {
    setFormError(null);
    if (customerName.trim().length < 2) {
      setFormError("Enter the customer's name.");
      return;
    }
    if (!customerEmail.trim() && !customerPhone.trim()) {
      setFormError(
        "Enter an email address or phone number to send the link to.",
      );
      return;
    }
    const parsedItems = [];
    for (const it of items) {
      if (!it.description.trim()) {
        setFormError("Every line item needs a description.");
        return;
      }
      const cents = parsePriceToCents(it.price);
      const qty = Number.parseInt(it.quantity, 10);
      if (cents == null) {
        setFormError(`Enter a valid price for "${it.description.trim()}".`);
        return;
      }
      if (!Number.isFinite(qty) || qty < 1) {
        setFormError(`Enter a valid quantity for "${it.description.trim()}".`);
        return;
      }
      parsedItems.push({
        description: it.description.trim(),
        quantity: qty,
        unitAmountCents: cents,
      });
    }
    if (totalCents < 50) {
      setFormError("Order total must be at least $0.50.");
      return;
    }

    create.mutate(
      {
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || null,
        customerPhone: customerPhone.trim() || null,
        items: parsedItems,
        noteToCustomer: note.trim() || null,
        documentKeys,
      },
      {
        onSuccess: (res) => {
          onCreated();
          setResult({
            orderReference: res.orderReference,
            signingLink: res.signingLink,
            emailSent: res.emailSent,
            smsSent: res.smsSent,
          });
        },
        onError: (err) => {
          const data = err.data as {
            error?: string;
            invalidKeys?: string[];
          } | null;
          if (data?.error === "invalid_document_keys") {
            setFormError(
              `These documents can't be sent with an order: ${(data.invalidKeys ?? []).join(", ")}.`,
            );
          } else if (data?.error === "invalid_phone") {
            setFormError("That phone number doesn't look valid.");
          } else {
            setFormError(err.message || "Couldn't create the order.");
          }
        },
      },
    );
  };

  // ── Success state: show the link + delivery summary ──
  if (result) {
    return (
      <AdminModal
        title={`Order ${result.orderReference} sent`}
        description="The customer received a secure link to review, sign, and pay."
        onClose={onClose}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            {result.emailSent && "Email sent. "}
            {result.smsSent && "Text message sent. "}
            {!result.emailSent &&
              !result.smsSent &&
              "Automatic delivery wasn't available — copy the link below and share it with the customer directly. "}
            You can resend or cancel from the orders list at any time.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={result.signingLink}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(result.signingLink)
                  .then(() => toast({ title: "Link copied" }))
                  .catch(() => {});
              }}
            >
              <ClipboardCopy className="w-4 h-4 mr-1" /> Copy
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </AdminModal>
    );
  }

  const selectableTemplates =
    templates.data?.templates.filter((t) => t.standalone) ?? [];

  return (
    <AdminModal
      title="Create a sign & pay order"
      description="The customer gets a secure link to review the order, e-sign standalone paperwork, and pay by card through Stripe."
      onClose={onClose}
      className="max-w-3xl"
    >
      <div className="space-y-5">
        {/* Customer */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="csr-order-name">
              Customer name
            </label>
            <Input
              id="csr-order-name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Jordan Smith"
              data-testid="input-csr-order-name"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="csr-order-email">
              Email
            </label>
            <Input
              id="csr-order-email"
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="jordan@example.com"
              data-testid="input-csr-order-email"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="csr-order-phone">
              Mobile phone
            </label>
            <Input
              id="csr-order-phone"
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="(555) 123-4567"
              data-testid="input-csr-order-phone"
            />
          </div>
        </div>

        {/* Line items */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Line items</div>
          {items.map((it, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Input
                value={it.description}
                onChange={(e) => updateItem(i, { description: e.target.value })}
                placeholder="e.g. AirSense 11 AutoSet CPAP machine"
                className="flex-1"
                aria-label={`Item ${i + 1} description`}
                data-testid={`input-csr-order-item-desc-${i}`}
              />
              <Input
                value={it.quantity}
                onChange={(e) => updateItem(i, { quantity: e.target.value })}
                type="number"
                min={1}
                max={99}
                className="w-20"
                aria-label={`Item ${i + 1} quantity`}
              />
              <div className="relative w-32">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  value={it.price}
                  onChange={(e) => updateItem(i, { price: e.target.value })}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="pl-7"
                  aria-label={`Item ${i + 1} unit price in dollars`}
                  data-testid={`input-csr-order-item-price-${i}`}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-0.5"
                disabled={items.length === 1}
                onClick={() =>
                  setItems((prev) => prev.filter((_, idx) => idx !== i))
                }
                aria-label={`Remove item ${i + 1}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={items.length >= 20}
              onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
              data-testid="button-csr-order-add-item"
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add item
            </Button>
            <div className="text-sm font-semibold">
              Total: {formatUsd(totalCents)}
            </div>
          </div>
        </div>

        {/* Paperwork */}
        <div className="space-y-2">
          <div className="text-sm font-medium">
            Standalone paperwork to sign{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </div>
          {templates.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : selectableTemplates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No standalone document templates available.
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2 max-h-48 overflow-y-auto rounded-lg border border-border/40 p-3">
              {selectableTemplates.map((t) => (
                <label
                  key={t.key}
                  className="flex items-start gap-2 text-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={documentKeys.includes(t.key)}
                    onChange={() => toggleDocument(t.key)}
                    data-testid={`checkbox-csr-order-doc-${t.key}`}
                  />
                  <span>
                    {t.title}
                    {t.requiresSignature && (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        · signature
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Only standalone forms are available here. Use Document packets for
            onboarding or custom patient e-sign packets.
          </p>
        </div>

        {/* Note */}
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="csr-order-note">
            Note to customer{" "}
            <span className="text-muted-foreground font-normal">
              (optional, shown on their page)
            </span>
          </label>
          <textarea
            id="csr-order-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full rounded-md border border-border/60 bg-transparent px-3 py-2 text-sm"
            placeholder="e.g. As discussed on the phone — this covers your new mask and a 3-month supply of filters."
            data-testid="textarea-csr-order-note"
          />
        </div>

        {formError && (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={create.isPending}
            data-testid="button-csr-order-submit"
          >
            {create.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Sending…
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-1.5" /> Create &amp; send
              </>
            )}
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

// /account — patient self-service account page.
//
//   * Profile (name + shipping address) — editable inline. Persists
//     to /shop/me PUT. Works in preview mode (no Stripe needed).
//   * Saved card — read-only display ("Visa •••• 4242"). Update CTA
//     starts a $0 setup-intent-style flow via /shop/me/quick-checkout
//     with a placeholder $0 cart… not yet — for v1 we send the user
//     into the standard checkout to update card on next purchase.
//     We surface the message instead of pretending an "Update card"
//     button works in isolation.
//   * Order history — last N orders with "Buy this again" buttons.
//     The button fetches the past order's line items via
//     /shop/orders/:sessionId, drops them into the local cart with
//     useCart().replaceItems, and navigates to /shop/cart so the
//     customer can review (and adjust) before paying. The cart page
//     reads a `pennpaps_reorder_from` sessionStorage flag to render
//     a "Loaded from your order on …" banner. We deliberately do
//     NOT bounce straight to Stripe — older patients want to see
//     what they're buying before a card form appears.
//
// Auth gating: rendered behind <SignedIn>. Wouter-level redirect to
// /sign-in?redirect=/account when not signed in.

import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SignedIn, useShopIdentity } from "@/lib/identity";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  Package,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Settings2,
  ShoppingBag,
  Trash2,
  Upload,
  UserCircle2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  AccountApiError,
  cancelShopSubscription,
  changeShopSubscriptionCadence,
  deleteMyDocument,
  fetchMyDocuments,
  fetchShopCadenceOptions,
  fetchShopMe,
  fetchShopMySubscriptions,
  pauseShopSubscription,
  resumeShopSubscription,
  uploadMyDocument,
  DOCUMENT_TYPE_LABELS,
  type PatientDocumentItem,
  type PatientDocumentType,
  type ShopCadenceOption,
  type ShopMeResponse,
  type ShopRecentOrder,
  type ShopSubscriptionView,
  type SavedCard,
} from "@/lib/account-api";
import {
  fetchOrderSummary,
  fetchShopProducts,
  formatMoneyCents,
} from "@/lib/shop-api";
import { useCart, type CartItem } from "@/hooks/use-cart";
import { ProfileSection } from "@/components/account/ProfileSection";
import { ClinicalInfoSection } from "@/components/clinical-info-section";
import { AccountMessagesSection } from "@/components/account-messages-section";
import { CustomerChatSection } from "@/components/customer-chat-section";
import { CommPrefsSection } from "@/components/comm-prefs-section";
import { CaregiverSection } from "@/components/caregiver-section";
import { PushPromptBanner } from "@/components/push-prompt-banner";
import { WalletPassSection } from "@/components/wallet-pass-section";
import {
  EquipmentRegistrySection,
  EsignFormsSection,
  ReferralProgramSection,
  RequestAppointmentSection,
} from "@/components/self-service-sections";
import { ReorderSuggestionsSection } from "@/components/reorder-suggestions-section";
import { InsightsSection } from "@/components/insights-section";
import { TherapySummarySection } from "@/components/therapy-summary-section";
import { MaintenanceSection } from "@/components/maintenance-section";
import { MaskLeakWizardSection } from "@/components/mask-leak-wizard-section";
import { SubstitutionsSection } from "@/components/substitutions-section";
import { EducationFeedSection } from "@/components/education-feed-section";
import { MyReturnsSection } from "@/components/my-returns-section";
import { BiometricLockGate } from "@/components/biometric-lock-gate";

// sessionStorage key picked up by /shop/cart to render the "Loaded
// from your order on …" banner. Stored as a JSON object so we can
// extend it later (e.g. orderId) without a schema bump.
const REORDER_FROM_KEY = "pennpaps_reorder_from";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function AccountPage() {
  useDocumentTitle("My account");
  // We render an inline sign-in prompt for signed-out visitors instead
  // of <Redirect to="/sign-in?…">. Mirroring the /shop/orders pattern
  // (inline CTA + ?redirect=/account round-trip) is more graceful UX:
  // the customer sees *why* they're being asked to sign in instead of
  // a jarring auto-bounce.
  return (
    <SignedIn fallback={<SignedOutAccountPrompt />}>
      <BiometricLockGate>
        <AccountInner />
      </BiometricLockGate>
    </SignedIn>
  );
}

function SignedOutAccountPrompt() {
  // Keep the ?redirect= convention in sync with sign-in.tsx
  // readRedirect() — it reads ONLY ?redirect=, NOT ?redirect_url=.
  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-20 max-w-2xl">
      <div
        className="glass-card rounded-2xl p-8 md:p-10 text-center"
        data-testid="account-signin-prompt"
      >
        <UserCircle2 className="w-12 h-12 text-[hsl(var(--penn-navy))]/60 mx-auto mb-4" />
        <h1 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-2">
          Sign in to your account
        </h1>
        <p className="text-sm md:text-base text-muted-foreground max-w-md mx-auto mb-6">
          Your saved shipping address, card on file, and order history live
          here. Sign in or create an account to continue.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/sign-in?redirect=/account">
            <Button data-testid="account-signin-btn">Sign in</Button>
          </Link>
          <Link href="/sign-up?redirect=/account">
            <Button variant="outline" data-testid="account-signup-btn">
              Create account
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function AccountInner() {
  const { displayName, isLoaded: isUserLoaded } = useShopIdentity();
  const [data, setData] = useState<ShopMeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<boolean | null>(null);

  // Probe preview mode the same way the cart does so we can disable
  // payment actions cleanly when Stripe isn't configured.
  useEffect(() => {
    let active = true;
    fetchShopProducts()
      .then((r) => {
        if (!active) return;
        if ("unavailable" in r) {
          setPreviewMode(true);
        } else {
          setPreviewMode(r.previewMode);
        }
      })
      .catch(() => {
        if (active) setPreviewMode(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const reload = React.useCallback(async () => {
    try {
      const r = await fetchShopMe();
      setData(r);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Wait for the auth provider to finish hydrating before calling
    // /shop/me. Otherwise the request can race ahead of the session
    // cookie/token, the server sees an unauthenticated request and
    // returns {signedIn:false}, and we'd render the misleading
    // "Your session expired" copy for a user we KNOW is signed in
    // (the outer <SignedIn> already gated on this).
    if (!isUserLoaded) return;
    void reload();
  }, [reload, isUserLoaded]);

  if (loadError) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-12 max-w-3xl">
        <div className="glass-card rounded-2xl p-6 text-center">
          <AlertCircle className="h-6 w-6 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-20 max-w-3xl text-center">
        <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Two distinct failure modes funnel into the no-profile branch:
  //
  //   data.signedIn === false  → the API can't see our session at all.
  //     This usually means the auth provider session cookie isn't
  //     reaching /resupply-api (cross-origin / SameSite issue or a
  //     proxy that strips cookies). Retrying won't fix it; the user
  //     needs to sign in again so a fresh cookie gets attached on
  //     the same origin as the API.
  //
  //   data.signedIn === true && !data.profile  → the API saw the
  //     session but couldn't materialize a profile row. This IS
  //     usually a momentary hiccup — transient DB error during
  //     ensureShopCustomerRow, etc. "Try again" is the right call
  //     here.
  //
  // The two need different copy + actions because retry-first vs
  // sign-in-first matters: telling someone whose session cookie is
  // gone to "try again in a few seconds" leaves them stuck.
  if (!data.signedIn) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-12 max-w-3xl">
        <div className="glass-card rounded-2xl p-6 text-center">
          <AlertCircle className="h-6 w-6 mx-auto mb-2 text-destructive" />
          <p
            className="text-sm font-semibold mb-1"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            Your session expired
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            We can&apos;t see your sign-in anymore — sign back in and
            you&apos;ll land right back here.
          </p>
          <Button asChild data-testid="account-resignin-btn">
            <Link href="/sign-in?redirect=/account">Sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!data.profile) {
    return (
      <div className="container mx-auto px-4 md:px-6 py-12 max-w-3xl">
        <div className="glass-card rounded-2xl p-6 text-center">
          <AlertCircle className="h-6 w-6 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-muted-foreground mb-4">
            Your account info couldn&apos;t load. This is usually a momentary
            hiccup — try again in a few seconds.
          </p>
          <Button onClick={() => void reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  const greeting =
    (displayName ?? "").trim().split(/\s+/)[0] ||
    data.profile.displayName?.split(" ")[0] ||
    "there";

  return (
    <div className="container mx-auto px-4 md:px-6 py-12 md:py-16 max-w-4xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground mb-2">
          Your account
        </p>
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight mb-2">
          Welcome back, {greeting}.
        </h1>
        <p className="text-muted-foreground">
          Saved info means one-tap reorders. Card details stay with Stripe.
        </p>
      </div>

      {previewMode === true && <PreviewBanner />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/*
            One-time, dismissible nudge to enable web push so shipment
            + delivery notifications reach the lock screen. The
            CommPrefsSection toggle further down covers the same
            ground, but it's buried two scrolls deep and barely
            discovered. This banner self-hides on dismiss (per-device,
            localStorage) and on subscription success.
          */}
          <PushPromptBanner />
          <ProfileSection
            profile={data.profile!}
            onSaved={() => void reload()}
          />
          {/*
            Device + physician info — added in the
            customer-clinical-info-and-messaging-foundation branch.
            Both fields are stored on shop_customers as JSONB and
            persist via PUT /shop/me/clinical-info, which audit-logs
            every change with a non-PHI metadata envelope.
          */}
          <ClinicalInfoSection />
          {/*
            In-account messaging with PennPaps customer service —
            Phase 2 (PR #53). Reuses the existing conversations +
            messages tables via the new in_app channel; admins reply
            from /admin/conversations.
          */}
          <AccountMessagesSection />
          {/*
            Account chatbot — answers order/subscription/supply/device
            questions for the signed-in user. Hits the auth-gated
            /shop/me/chat endpoint, which loads a thin slice of the
            caller's account context into the system prompt and exposes
            DB-backed tools scoped to this customer.
          */}
          <CustomerChatSection />
          <DocumentsSection />
          <TherapySummarySection />
          <SubstitutionsSection />
          <MaintenanceSection />
          <MaskLeakWizardSection />
          <EducationFeedSection />
          <InsightsSection />
          <ReorderSuggestionsSection />
          <SubscriptionsSection previewMode={previewMode === true} />
          <OrdersSection
            orders={data.recentOrders ?? []}
            previewMode={previewMode === true}
          />
          <MyReturnsSection />
          <EquipmentRegistrySection />
          <RequestAppointmentSection />
          <EsignFormsSection />
          <ReferralProgramSection />
          <CaregiverSection />
          <WalletPassSection />
          <CommPrefsSection />
          <DataExportSection />
        </div>
        <aside className="space-y-6">
          <SavedCardSection card={data.savedCard ?? null} />
          <KeepShoppingCard />
        </aside>
      </div>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div
      className="glass-card rounded-xl p-4 mb-6 border-l-4 border-l-[hsl(var(--penn-gold))] flex gap-3"
      data-testid="account-preview-banner"
    >
      <AlertCircle className="h-5 w-5 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-semibold text-[hsl(var(--penn-navy))]">
          Preview mode — payments not yet enabled
        </p>
        <p className="text-muted-foreground mt-1">
          You can edit your saved info now. Reorder + Express checkout will
          enable as soon as Stripe is connected.
        </p>
      </div>
    </div>
  );
}

const DOCUMENT_ACCEPT = "application/pdf,image/png,image/jpeg,image/heic,image/heif,image/webp";
const MAX_DOC_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentsSection() {
  const [docs, setDocs] = useState<PatientDocumentItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<PatientDocumentType>("insurance_card");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const r = await fetchMyDocuments();
      setDocs(r.documents);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your documents.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      setUploadError("File is too large. Maximum size is 10 MB.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      await uploadMyDocument(selectedType, file);
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await deleteMyDocument(id);
      await load();
    } catch {
      // Non-fatal: reload to reconcile.
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-documents-section"
    >
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">My documents</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Upload insurance cards, prescriptions, referrals, or other documents
        for Penn Home Medical Supply. Our team will be able to view these
        directly.
      </p>

      {/* Upload controls */}
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground mb-1 block">
            Document type
          </span>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as PatientDocumentType)}
            disabled={uploading}
            className="rounded-md border border-border/60 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.3)]"
            data-testid="account-doc-type-select"
          >
            {(Object.keys(DOCUMENT_TYPE_LABELS) as PatientDocumentType[]).map(
              (t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ),
            )}
          </select>
        </label>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="hidden"
            disabled={uploading}
            onChange={handleFileChange}
            data-testid="account-doc-file-input"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--penn-navy))] text-white text-sm font-semibold px-4 py-2 hover:bg-[hsl(var(--penn-navy))]/90 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="account-doc-upload-btn"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" /> Upload document
              </>
            )}
          </button>
          <p className="text-xs text-muted-foreground mt-1">
            PDF or image · max 10 MB
          </p>
        </div>
      </div>

      {uploadError && (
        <p className="text-sm text-destructive" data-testid="account-doc-upload-error">
          {uploadError}
        </p>
      )}

      {/* Document list */}
      {loadError && (
        <p className="text-sm text-muted-foreground">{loadError}</p>
      )}
      {docs === null && !loadError && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {docs !== null && docs.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="account-doc-empty">
          No documents uploaded yet.
        </p>
      )}
      {docs !== null && docs.length > 0 && (
        <ul className="divide-y divide-border/40" data-testid="account-doc-list">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="py-3 flex items-center justify-between gap-3"
              data-testid={`account-doc-${doc.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <p className="text-sm font-medium truncate">
                    {doc.filename ?? "Document"}
                  </p>
                  {doc.reviewedAt ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "#d1fae5", color: "#065f46" }}
                      title={`Reviewed ${new Date(doc.reviewedAt).toLocaleDateString()}`}
                      data-testid={`account-doc-reviewed-${doc.id}`}
                    >
                      <CheckCircle2 className="h-3 w-3" /> Reviewed
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "#fef3c7", color: "#92400e" }}
                      data-testid={`account-doc-pending-${doc.id}`}
                    >
                      Pending review
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {DOCUMENT_TYPE_LABELS[doc.documentType as PatientDocumentType] ??
                    doc.documentType}
                  {" · "}
                  {formatBytes(doc.sizeBytes)}
                  {" · "}
                  {new Date(doc.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <button
                type="button"
                disabled={deletingId === doc.id}
                onClick={() => void handleDelete(doc.id)}
                className="text-muted-foreground hover:text-destructive disabled:opacity-40 shrink-0"
                aria-label="Delete document"
                data-testid={`account-doc-delete-${doc.id}`}
              >
                {deletingId === doc.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Self-service data export. Hits /shop/me/export which streams a
// JSON file with every cash-pay record we hold for the user. No PHI
// (clinical data lives in a separate system); the section copy
// surfaces that explicitly so customers know to file a separate
// request for the resupply side if needed.
function DataExportSection() {
  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-2"
      data-testid="account-data-export"
    >
      <h2 className="font-semibold">Your data</h2>
      <p className="text-sm text-muted-foreground">
        Download every record we hold for your account on the cash-pay shop —
        orders, subscriptions, returns, reviews, communication preferences. The
        download is a JSON file; clinical / insurance data isn&apos;t included
        (those live in a separate system — email{" "}
        <a
          className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
          href="mailto:support@pennpaps.com"
        >
          support@pennpaps.com
        </a>{" "}
        for that).
      </p>
      <div>
        <a
          href="/resupply-api/shop/me/export"
          className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--penn-navy))] text-white text-sm font-semibold px-4 py-2 hover:bg-[hsl(var(--penn-navy))]/90"
          data-testid="account-data-export-download"
        >
          Download my data (JSON)
        </a>
      </div>
    </section>
  );
}


/**
 * Render the "Saved card" section on the Account page and provide a control to open Stripe's billing portal.
 *
 * Displays card brand, masked number, and expiry when `card` is present; otherwise shows a prompt to browse the shop.
 *
 * @param card - The saved payment card information, or `null` when no card is on file
 * @returns A React element representing the saved card section with update and fallback UI
 */
function SavedCardSection({ card }: { card: SavedCard | null }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setOpening(true);
    setError(null);
    try {
      const { openBillingPortal } = await import("@/lib/account-api");
      const { url } = await openBillingPortal("/account");
      // Hard navigate so we leave the SPA. Stripe will bounce us back
      // to /account when the customer closes the portal.
      window.location.href = url;
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 503) {
        setError("Billing isn't available in this environment yet.");
      } else {
        setError(
          "We couldn't open the billing portal. Please try again in a moment.",
        );
      }
      setOpening(false);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-card-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <CreditCard className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Saved card</h2>
      </div>
      {card && card.last4 ? (
        <div>
          <div className="rounded-xl bg-gradient-to-br from-[hsl(var(--penn-navy))] to-[hsl(var(--penn-navy)/0.85)] text-white p-5 mb-3">
            <p className="text-xs uppercase tracking-[0.16em] opacity-80 mb-2">
              {card.brand ?? "Card"} on file
            </p>
            <p
              className="font-semibold text-lg tracking-wider tabular-nums"
              data-testid="account-card-last4"
            >
              •••• •••• •••• {card.last4}
            </p>
            {card.expMonth && card.expYear && (
              <p className="text-xs opacity-80 mt-2">
                Expires {String(card.expMonth).padStart(2, "0")}/
                {String(card.expYear).slice(-2)}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openPortal}
            disabled={opening}
            data-testid="account-card-update"
            className="w-full mb-2"
          >
            {opening ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Opening…
              </>
            ) : (
              <>Update card or billing details</>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            We never see your card number. The update opens Stripe&apos;s secure
            billing portal in this tab and brings you back here when you&apos;re
            done.
          </p>
          {error && (
            <p
              className="text-xs text-destructive mt-2"
              data-testid="account-card-error"
            >
              {error}
            </p>
          )}
        </div>
      ) : (
        <div>
          <p className="text-sm text-muted-foreground mb-3">
            No card saved yet. Your next checkout can save the card you use, so
            future orders are one tap.
          </p>
          <Link
            href="/shop"
            className="text-sm text-primary font-medium hover:underline inline-flex items-center gap-1"
          >
            Browse the shop <ShoppingBag className="h-4 w-4" />
          </Link>
        </div>
      )}
    </section>
  );
}

function KeepShoppingCard() {
  return (
    <section className="glass-card rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-3">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Keep CPAP fresh</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Cushions every 2 weeks, headgear twice a year, full reset every 6
        months. We'll have your saved info ready when it's time.
      </p>
      <div className="flex flex-col gap-2">
        <Link
          href="/shop"
          className="text-sm font-medium text-primary hover:underline"
          data-testid="account-link-shop"
        >
          → Browse supplies
        </Link>
        <Link
          href="/learn/replacement-schedule"
          className="text-sm font-medium text-primary hover:underline"
        >
          → Replacement schedule
        </Link>
      </div>
    </section>
  );
}

function OrdersSection({
  orders,
  previewMode,
}: {
  orders: ShopRecentOrder[];
  previewMode: boolean;
}) {
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const { replaceItems } = useCart();
  const [, navigate] = useLocation();

  async function handleBuyAgain(order: ShopRecentOrder) {
    // Preview mode: /shop/orders/:sessionId would 503 (no Stripe).
    // The button is also visually disabled in this branch, but guard
    // here too in case of a stale click.
    if (previewMode) return;
    setReorderError(null);
    setReorderingId(order.sessionId);
    try {
      const summary = await fetchOrderSummary(order.sessionId);
      // Filter line items down to ones we can actually put back in
      // the cart. A null priceId or unitAmountCents means the item
      // can't round-trip through /shop/checkout (which validates by
      // priceId), so silently dropping it is the safest default.
      const reorderable: CartItem[] = summary.lineItems
        .filter(
          (
            li,
          ): li is typeof li & { priceId: string; unitAmountCents: number } =>
            !!li.priceId && typeof li.unitAmountCents === "number",
        )
        .map((li) => ({
          productId: li.productId ?? li.priceId,
          priceId: li.priceId,
          name: li.name,
          unitAmountCents: li.unitAmountCents,
          // Reorders always go back as one-time. If the patient
          // wants auto-ship for a reordered SKU they can toggle it
          // on the cart row before paying — we never silently
          // promote a one-time receipt into a subscription.
          mode: "one_time" as const,
          recurringPriceId: null,
          recurringIntervalLabel: null,
          currency: summary.currency ?? "usd",
          quantity: li.quantity,
          imageUrl: li.imageUrl,
          // No reliable way to know from a Stripe line item if it was
          // a curated bundle vs an individual product. Default to
          // false; the cart UI handles both shapes the same way.
          isBundle: false,
          // Stripe line items don't carry our inventory metadata.
          // Same convention as cart-resume + localStorage hydrate:
          // null = "not tracked here, the live product fetch +
          // checkout validation will catch out-of-stock before pay."
          stockCount: null,
        }));

      if (reorderable.length === 0) {
        setReorderError(
          "We couldn't load this order back into your cart. Try browsing the shop instead.",
        );
        setReorderingId(null);
        return;
      }

      // Track partial-reorder cases so the cart banner can be honest
      // about what got dropped. The most common cause is a price
      // that's since been archived in Stripe — checkout would have
      // rejected it anyway, but failing here (with a count) instead
      // of at the payment step is meaningfully friendlier UX.
      const droppedCount = summary.lineItems.length - reorderable.length;

      replaceItems(reorderable);

      // Drop a sessionStorage breadcrumb so /shop/cart can render the
      // "Loaded from your order on …" banner. sessionStorage (not
      // localStorage) means the flag dies when the tab closes, so a
      // user who reorders, closes the tab, then revisits the cart
      // doesn't see a stale banner. Stored as JSON so we can extend
      // the payload later (e.g. orderId) without a key bump.
      try {
        window.sessionStorage.setItem(
          REORDER_FROM_KEY,
          JSON.stringify({
            sessionId: order.sessionId,
            createdAt: order.createdAt,
            droppedCount,
          }),
        );
      } catch {
        // Quota exceeded / private mode — banner won't show, cart
        // still works. Not worth surfacing to the user.
      }

      navigate("/shop/cart");
    } catch (err) {
      const msg =
        err instanceof AccountApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setReorderError(msg);
      setReorderingId(null);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-orders-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <ShoppingBag className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Recent orders</h2>
      </div>
      {orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No orders yet. Your first purchase will show up here for one-tap
          reorders.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {orders.map((o) => (
            <li
              key={o.id}
              className="py-3 flex items-center justify-between gap-3"
              data-testid={`account-order-${o.sessionId}`}
            >
              <div className="min-w-0">
                <p className="font-medium tabular-nums">
                  {o.amountTotalCents
                    ? formatMoneyCents(o.amountTotalCents, o.currency ?? "usd")
                    : "—"}{" "}
                  <span className="ml-2 text-xs uppercase tracking-wide text-muted-foreground">
                    {o.status}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(o.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/shop/checkout-success?session_id=${encodeURIComponent(o.sessionId)}`}
                  className="text-xs text-muted-foreground hover:text-primary"
                >
                  Details
                </Link>
                {o.status === "paid" && (
                  <ReportLostLink orderId={o.id} />
                )}
                {o.status === "paid" && (
                  <Button
                    size="sm"
                    disabled={previewMode || reorderingId === o.sessionId}
                    onClick={() => void handleBuyAgain(o)}
                    data-testid={`account-reorder-${o.sessionId}`}
                    title={
                      previewMode
                        ? "Reordering will enable as soon as Stripe is connected."
                        : undefined
                    }
                  >
                    {reorderingId === o.sessionId ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        Buy this again
                      </>
                    )}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {reorderError && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="account-reorder-error"
        >
          {reorderError}
        </p>
      )}
    </section>
  );
}

function ReportLostLink({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok" }
    | { kind: "error"; message: string }
    | null
  >(null);
  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const { reportLostShipment } = await import(
        "@/lib/account/self-service-api"
      );
      await reportLostShipment(orderId, note.trim());
      setResult({ kind: "ok" });
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }
  if (result?.kind === "ok") {
    return (
      <span className="text-xs text-emerald-700">Reported — we&apos;ll follow up</span>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-destructive underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        Report not received
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        placeholder="Describe what happened (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-7 rounded border px-2 text-xs w-56"
      />
      <Button size="sm" onClick={() => void submit()} disabled={submitting}>
        {submitting ? "…" : "Report"}
      </Button>
      <button
        type="button"
        className="text-xs text-muted-foreground"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
      {result?.kind === "error" && (
        <span className="text-xs text-destructive ml-1">{result.message}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscriptions section — patient-managed Subscribe & Save lines.
// Self-fetches on mount because subscriptions live on a separate
// endpoint from /shop/me and we don't want to widen ShopMeResponse
// (subscriptions are a 0..N collection that warrants its own loading
// state, including a "Cancel auto-ship" pending state per row).
//
// Hidden when the user has zero subscriptions — the section's whole
// point is to be a quiet management surface, not to advertise the
// feature on accounts that haven't tried it. Discovery happens on
// /shop and /reminders; this section only manages.
// ---------------------------------------------------------------------------
// Per-row pending action — one of these at a time per subscription.
// `null` means the row is idle. We use a single state field rather
// than four booleans so the UI always disables every other button on
// the row while ONE is in flight (older patients double-tap things).
type PendingAction = "cancel" | "pause" | "resume";

function SubscriptionsSection({ previewMode }: { previewMode: boolean }) {
  const [subs, setSubs] = useState<ShopSubscriptionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    action: PendingAction;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Cadence dialog state. Held at the section level (not per-row) so
  // we can render a single shared <Dialog> instead of N dialogs.
  const [cadenceSub, setCadenceSub] = useState<ShopSubscriptionView | null>(
    null,
  );
  const [cadenceOptions, setCadenceOptions] = useState<
    ShopCadenceOption[] | null
  >(null);
  const [cadenceLoadError, setCadenceLoadError] = useState<string | null>(null);
  const [cadenceSelectedPriceId, setCadenceSelectedPriceId] = useState<
    string | null
  >(null);
  const [cadenceSubmitting, setCadenceSubmitting] = useState(false);

  // Cancel-intercept dialog — offers "Pause instead" before letting
  // the customer follow through with a hard cancel. Holds the
  // subscription targeted for cancellation (or null when closed)
  // plus an optional reason the customer chose, so we can log /
  // analyze later when we add a reasons table. The reason itself
  // is stored in component state only for now (no backend yet) —
  // the immediate goal is the deflection moment, not the analytics.
  const [cancelInterceptSub, setCancelInterceptSub] =
    useState<ShopSubscriptionView | null>(null);

  // Travel-mode bulk pause/resume in-flight flag.
  const [travelModeBusy, setTravelModeBusy] = useState(false);
  const [travelModeError, setTravelModeError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const r = await fetchShopMySubscriptions();
      setSubs(r.subscriptions);
    } catch (err: unknown) {
      // Treat 404 (route absent — preview mode without Stripe) and
      // every other read error the same: show nothing rather than a
      // scary banner. The section is opt-in surface; failing closed
      // is the right call.
      setSubs([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function isPending(id: string, action?: PendingAction) {
    if (!pending || pending.id !== id) return false;
    return action ? pending.action === action : true;
  }

  function handleCancel(sub: ShopSubscriptionView) {
    if (pending) return;
    // Open the cancel-intercept dialog instead of going straight to
    // a confirm-and-cancel. The dialog surfaces "Pause instead" as
    // the primary CTA — most patients who hit cancel just need a
    // break (vacation, hospital stay, supply backlog) rather than a
    // permanent stop. The native confirm() flow buried that option.
    setCancelInterceptSub(sub);
    setActionError(null);
  }

  async function confirmCancel(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "cancel" });
    setActionError(null);
    try {
      await cancelShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function pauseFromIntercept(sub: ShopSubscriptionView) {
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
      setCancelInterceptSub(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Pause / resume — both buttons are always shown when the sub is
  // active and not pending cancellation. We don't track local pause
  // state (no schema slice), so showing both lets the patient pick the
  // intent without us having to guess Stripe's `pause_collection`
  // value. Both endpoints are idempotent server-side.
  async function handlePause(sub: ShopSubscriptionView) {
    if (pending) return;
    if (
      !window.confirm(
        "Pause auto-ship? We'll stop charging your card and shipping until you " +
          "resume. Your subscription stays active so you can pick up where you left off.",
      )
    ) {
      return;
    }
    setPending({ id: sub.id, action: "pause" });
    setActionError(null);
    try {
      await pauseShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function handleResume(sub: ShopSubscriptionView) {
    if (pending) return;
    setPending({ id: sub.id, action: "resume" });
    setActionError(null);
    try {
      await resumeShopSubscription(sub.id);
      await load();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  // Travel mode — bulk-pause or bulk-resume every applicable
  // subscription with one click. Sequential rather than Promise.all so
  // we surface partial-failure state (Stripe rate limits + retry).
  // We don't store a "travel mode active" flag locally; the truth is
  // the subscriptions' actual paused/active state, which the next
  // load() reflects.
  async function bulkPauseAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await pauseShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be paused. ` +
          "Try the per-row Pause button.",
      );
    }
  }

  async function bulkResumeAll(targets: ShopSubscriptionView[]) {
    if (travelModeBusy || pending) return;
    setTravelModeBusy(true);
    setTravelModeError(null);
    let failed = 0;
    for (const sub of targets) {
      try {
        await resumeShopSubscription(sub.id);
      } catch {
        failed += 1;
      }
    }
    await load();
    setTravelModeBusy(false);
    if (failed > 0) {
      setTravelModeError(
        `${failed} subscription${failed === 1 ? "" : "s"} couldn't be resumed. ` +
          "Try the per-row Resume button.",
      );
    }
  }

  // Cadence dialog — opened by clicking "Change cadence" on a row.
  // We fetch the option list lazily on open (Stripe round-trip) so
  // the patient pays the latency only when they actually want it.
  async function openCadenceDialog(sub: ShopSubscriptionView) {
    setCadenceSub(sub);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
    try {
      const r = await fetchShopCadenceOptions(sub.id);
      setCadenceOptions(r.options);
      // Default-select the current cadence so the radio group has
      // a chosen value immediately (better than empty selection).
      const current = r.options.find((o) => o.isCurrent);
      if (current) setCadenceSelectedPriceId(current.priceId);
    } catch (err: unknown) {
      setCadenceLoadError(err instanceof Error ? err.message : String(err));
      setCadenceOptions([]);
    }
  }

  function closeCadenceDialog() {
    if (cadenceSubmitting) return;
    setCadenceSub(null);
    setCadenceOptions(null);
    setCadenceLoadError(null);
    setCadenceSelectedPriceId(null);
  }

  async function handleCadenceConfirm() {
    if (!cadenceSub || !cadenceSelectedPriceId) return;
    // No-op if the patient didn't actually change their selection —
    // the server short-circuits this too, but skipping the round-trip
    // makes the UX feel snappier on close.
    const current = cadenceOptions?.find((o) => o.isCurrent);
    if (current?.priceId === cadenceSelectedPriceId) {
      closeCadenceDialog();
      return;
    }
    setCadenceSubmitting(true);
    setActionError(null);
    try {
      await changeShopSubscriptionCadence(
        cadenceSub.id,
        cadenceSelectedPriceId,
      );
      await load();
      // Close AFTER the load completes so the dialog visibly reflects
      // the new state on the row underneath when it disappears.
      setCadenceSub(null);
      setCadenceOptions(null);
      setCadenceSelectedPriceId(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCadenceSubmitting(false);
    }
  }

  // While loading, render nothing — avoids flicker for the common
  // case of "this user has no subscriptions" which is the empty-state
  // we hide entirely.
  if (subs === null) return null;
  if (subs.length === 0) {
    // Hide the section entirely when empty (per spec). The load
    // error, if any, surfaces only on next mount — accept that as a
    // tradeoff to keep the empty-state silent.
    if (loadError) {
      // dev-mode breadcrumb; never user-visible.
      console.debug("[account] subscriptions load skipped:", loadError);
    }
    return null;
  }

  return (
    <section
      id="autoship"
      className="glass-card rounded-2xl p-6 scroll-mt-24"
      data-testid="account-subscriptions-section"
    >
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Repeat className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Auto-ship subscriptions</h2>
        </div>
        {(() => {
          // Bulk pause-everything is only useful when there's at least one
          // subscription that could meaningfully change. We show "Pause
          // all" if anything is active and "Resume all" if every active
          // subscription is paused (Stripe `paused` status). When the
          // collection is mixed we render Pause All — pausing what's
          // active is the higher-leverage action.
          const pauseTargets = subs.filter(
            (s) => s.status === "active" || s.status === "trialing",
          );
          const pausedTargets = subs.filter((s) => s.status === "paused");
          if (pauseTargets.length > 0) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkPauseAll(pauseTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-pause-all"
                title="Pause every active auto-ship — useful for travel or hospital stays."
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Pausing all…
                  </>
                ) : (
                  <>Pause all (travel mode)</>
                )}
              </Button>
            );
          }
          if (pausedTargets.length > 1) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bulkResumeAll(pausedTargets)}
                disabled={travelModeBusy || pending !== null}
                data-testid="account-travel-mode-resume-all"
              >
                {travelModeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Resuming all…
                  </>
                ) : (
                  <>Resume all</>
                )}
              </Button>
            );
          }
          return null;
        })()}
      </div>
      {travelModeError && (
        <p
          className="text-xs text-rose-700 mb-3"
          role="alert"
          data-testid="account-travel-mode-error"
        >
          {travelModeError}
        </p>
      )}
      <ul className="divide-y divide-border/40">
        {subs.map((sub) => {
          const isActive = sub.status === "active" || sub.status === "trialing";
          const isPastDue =
            sub.status === "past_due" || sub.status === "unpaid";
          const isCanceled =
            sub.status === "canceled" || sub.status === "incomplete_expired";
          const nextShip = sub.currentPeriodEnd
            ? new Date(sub.currentPeriodEnd)
            : null;
          return (
            <li
              key={sub.id}
              className="py-4 first:pt-0 last:pb-0"
              data-testid={`account-subscription-${sub.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <ul className="space-y-1">
                    {sub.items.map((item) => (
                      <li
                        key={item.priceId}
                        className="text-sm font-medium tabular-nums"
                      >
                        {item.quantity > 1 ? `${item.quantity}× ` : ""}
                        {item.name ?? item.priceId}
                        {item.intervalLabel && (
                          <span className="text-xs text-muted-foreground ml-2 font-normal">
                            every {item.intervalLabel}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {nextShip && isActive && !sub.cancelAtPeriodEnd && (
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" />
                        Next ship{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {sub.cancelAtPeriodEnd && nextShip && (
                      <span className="inline-flex items-center gap-1 text-[hsl(var(--penn-navy))]">
                        <XCircle className="h-3 w-3" />
                        Stops after{" "}
                        {nextShip.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                    {isPastDue && (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        Payment past due — update card on file
                      </span>
                    )}
                    {isCanceled && (
                      <span className="inline-flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        Canceled
                      </span>
                    )}
                  </div>
                </div>
                {!isCanceled && !sub.cancelAtPeriodEnd && (
                  // Vertical button column on the right keeps the
                  // four CTAs from wrapping awkwardly on mobile, and
                  // lets us put the destructive action visually last.
                  // Pause + Resume are both shown unconditionally
                  // because we don't track local pause state — see
                  // the comment block at the top of the section.
                  <div className="flex flex-col items-stretch gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handlePause(sub)}
                      data-testid={`account-subscription-pause-${sub.id}`}
                      title={
                        previewMode
                          ? "Pause will be available once Stripe is connected."
                          : "Pause auto-ship and stop charges until you resume."
                      }
                    >
                      {isPending(sub.id, "pause") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Pausing…
                        </>
                      ) : (
                        <>
                          <Pause className="h-3.5 w-3.5 mr-1.5" />
                          Pause
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handleResume(sub)}
                      data-testid={`account-subscription-resume-${sub.id}`}
                      title={
                        previewMode
                          ? "Resume will be available once Stripe is connected."
                          : "Resume auto-ship if it's currently paused."
                      }
                    >
                      {isPending(sub.id, "resume") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Resuming…
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 mr-1.5" />
                          Resume
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void openCadenceDialog(sub)}
                      data-testid={`account-subscription-cadence-${sub.id}`}
                      title={
                        previewMode
                          ? "Cadence changes will be available once Stripe is connected."
                          : "Change how often supplies arrive."
                      }
                    >
                      <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                      Change cadence
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={previewMode || isPending(sub.id)}
                      onClick={() => void handleCancel(sub)}
                      data-testid={`account-subscription-cancel-${sub.id}`}
                      title={
                        previewMode
                          ? "Auto-ship will be cancellable as soon as Stripe is connected."
                          : undefined
                      }
                    >
                      {isPending(sub.id, "cancel") ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Cancelling…
                        </>
                      ) : (
                        "Cancel auto-ship"
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {actionError && (
        <p
          className="mt-3 text-sm text-destructive"
          data-testid="account-subscription-action-error"
        >
          {actionError}
        </p>
      )}

      {/* Cadence-change dialog — shared across all rows; opens with
          the row's options pre-fetched. We render the radio group
          inline (rather than a Select) because older patients find
          radios easier to scan and the option list is short (≤ ~6). */}
      <Dialog
        open={cadenceSub !== null}
        onOpenChange={(o) => {
          if (!o) closeCadenceDialog();
        }}
      >
        <DialogContent
          data-testid="account-cadence-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Change auto-ship cadence</DialogTitle>
            <DialogDescription>
              Choose how often you'd like your supplies to ship. Changes apply
              to your next order — we won't re-charge you for the current
              period.
            </DialogDescription>
          </DialogHeader>
          {cadenceOptions === null && !cadenceLoadError && (
            <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading options…
            </div>
          )}
          {cadenceLoadError && (
            <p className="py-4 text-sm text-destructive">
              Couldn't load cadence options. Please try again.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No alternate shipping cadences are available for this product.
            </p>
          )}
          {cadenceOptions !== null && cadenceOptions.length > 0 && (
            <RadioGroup
              value={cadenceSelectedPriceId ?? ""}
              onValueChange={(v) => setCadenceSelectedPriceId(v)}
              className="space-y-2 py-2"
            >
              {cadenceOptions.map((opt) => {
                const inputId = `cadence-opt-${opt.priceId}`;
                const price =
                  opt.unitAmountCents != null && opt.currency
                    ? formatMoneyCents(opt.unitAmountCents, opt.currency)
                    : null;
                return (
                  <div
                    key={opt.priceId}
                    className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 hover:bg-accent/30"
                  >
                    <RadioGroupItem value={opt.priceId} id={inputId} />
                    <Label
                      htmlFor={inputId}
                      className="flex-1 cursor-pointer text-sm font-normal"
                    >
                      <span className="font-medium">
                        Every {opt.intervalLabel}
                      </span>
                      {price && (
                        <span className="ml-2 text-muted-foreground tabular-nums">
                          · {price}
                        </span>
                      )}
                      {opt.isCurrent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (current)
                        </span>
                      )}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeCadenceDialog}
              disabled={cadenceSubmitting}
              data-testid="account-cadence-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCadenceConfirm()}
              disabled={
                cadenceSubmitting ||
                !cadenceSelectedPriceId ||
                cadenceOptions === null ||
                cadenceOptions.length === 0
              }
              data-testid="account-cadence-confirm"
            >
              {cadenceSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save cadence"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelInterceptSub !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setCancelInterceptSub(null);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          data-testid="account-cancel-intercept-dialog"
        >
          <DialogHeader>
            <DialogTitle>Before you cancel — would a pause work?</DialogTitle>
            <DialogDescription>
              Most patients who hit Cancel just need a temporary break. Pause
              keeps your subscription on file with no charges; you resume in one
              tap when you&apos;re ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-[hsl(var(--penn-gold)/0.4)] bg-[hsl(var(--penn-gold)/0.06)] p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Pause auto-ship instead
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                We&apos;ll stop charging your card and pause shipments. Your
                cadence and payment method stay on file. Resume anytime from
                this page.
              </p>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                Cancel for good
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Your supplies will keep shipping until the end of the current
                period, then stop. You&apos;ll need to re-subscribe (and
                re-confirm cadence + price) if you change your mind later.
              </p>
            </div>
            {actionError && (
              <p className="text-xs text-rose-700" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setCancelInterceptSub(null)}
              disabled={pending !== null}
              data-testid="account-cancel-intercept-keep"
            >
              Keep auto-ship as-is
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                cancelInterceptSub && void confirmCancel(cancelInterceptSub)
              }
              disabled={pending !== null}
              className="border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              data-testid="account-cancel-intercept-confirm"
            >
              {isPending(cancelInterceptSub?.id ?? "", "cancel") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Canceling…
                </>
              ) : (
                "Cancel anyway"
              )}
            </Button>
            <Button
              onClick={() =>
                cancelInterceptSub &&
                void pauseFromIntercept(cancelInterceptSub)
              }
              disabled={pending !== null}
              data-testid="account-cancel-intercept-pause"
            >
              {isPending(cancelInterceptSub?.id ?? "", "pause") ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Pausing…
                </>
              ) : (
                "Pause instead"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// Re-export for App.tsx import consistency.
export default AccountPage;
// Reference basePath so unused-var lint stays clean even if a future
// edit drops its only consumer.
void basePath;

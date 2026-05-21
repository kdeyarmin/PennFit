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
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  MapPin,
  Package,
  RefreshCw,
  ShoppingBag,
  Trash2,
  Upload,
  User as UserIcon,
  UserCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AccountApiError,
  deleteMyDocument,
  fetchMyDocuments,
  fetchShopMe,
  updateShopMe,
  uploadMyDocument,
  DOCUMENT_TYPE_LABELS,
  type PatientDocumentItem,
  type PatientDocumentType,
  type SavedShippingAddress,
  type ShopMeResponse,
  type ShopRecentOrder,
  type SavedCard,
} from "@/lib/account-api";
import {
  fetchOrderSummary,
  fetchShopProducts,
  formatMoneyCents,
} from "@/lib/shop-api";
import { useCart, type CartItem } from "@/hooks/use-cart";
import { SubscriptionsSection } from "@/components/account/SubscriptionsSection";
import { ClinicalInfoSection } from "@/components/clinical-info-section";
import { AccountMessagesSection } from "@/components/account-messages-section";
import { CustomerChatSection } from "@/components/customer-chat-section";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
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

function ProfileSection({
  profile,
  onSaved,
}: {
  profile: NonNullable<ShopMeResponse["profile"]>;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [addr, setAddr] = useState<SavedShippingAddress>(
    profile.shippingAddress ?? {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addrWarnings, setAddrWarnings] = useState<string[]>([]);
  // When the user has been warned about a suspicious address and
  // clicks Save a second time, we let it through. Cleared whenever
  // any address field changes so a stale "override" doesn't ride
  // forward into a new edit.
  const [overrideAddrWarning, setOverrideAddrWarning] = useState(false);

  // Field-by-field comparison against the original profile snapshot
  // tells us whether the form has unsaved changes. We use trimmed
  // values to mirror what would actually be persisted (so adding
  // trailing whitespace to your name doesn't trigger the warning).
  // `addr.line2` falls back to "" because the original profile
  // stores nullable line2 as null and the input always returns "".
  const initialAddr = profile.shippingAddress ?? null;
  const dirty =
    (displayName.trim() || null) !== (profile.displayName ?? null) ||
    (addr.line1?.trim() ?? "") !== (initialAddr?.line1 ?? "") ||
    (addr.line2?.trim() ?? "") !== (initialAddr?.line2 ?? "") ||
    (addr.city?.trim() ?? "") !== (initialAddr?.city ?? "") ||
    (addr.state?.trim().toUpperCase() ?? "") !== (initialAddr?.state ?? "") ||
    (addr.postalCode?.trim() ?? "") !== (initialAddr?.postalCode ?? "");

  // Surface the browser's native "unsaved changes" prompt when the
  // user tries to close / reload the tab with edits in flight.
  // Cleared automatically once `dirty` flips false (after save).
  useUnsavedChangesWarning(dirty);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cleanAddr: SavedShippingAddress = {
        line1: addr.line1.trim(),
        line2: addr.line2?.trim() || null,
        city: addr.city.trim(),
        state: addr.state.trim().toUpperCase(),
        postalCode: addr.postalCode.trim(),
        country: "US",
      };
      const hasAnyField =
        cleanAddr.line1 ||
        cleanAddr.city ||
        cleanAddr.state ||
        cleanAddr.postalCode;
      const allRequiredFilled =
        cleanAddr.line1 &&
        cleanAddr.city &&
        cleanAddr.state &&
        cleanAddr.postalCode;
      if (hasAnyField && !allRequiredFilled) {
        setError(
          "Fill in street, city, state, and ZIP — or clear all four to remove the saved address.",
        );
        setSaving(false);
        return;
      }
      if (hasAnyField && allRequiredFilled && !overrideAddrWarning) {
        try {
          const probe = await fetch("/resupply-api/shop/validate-address", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              line1: cleanAddr.line1,
              line2: cleanAddr.line2,
              city: cleanAddr.city,
              state: cleanAddr.state,
              postalCode: cleanAddr.postalCode,
              country: cleanAddr.country,
            }),
          });
          const json = (await probe.json()) as {
            ok: boolean;
            reasons?: string[];
          };
          if (!json.ok && Array.isArray(json.reasons) && json.reasons.length > 0) {
            setAddrWarnings(json.reasons);
            setSaving(false);
            return;
          }
        } catch {
          // Validation probe is advisory only — never block a save.
        }
      }
      await updateShopMe({
        displayName: displayName.trim() || null,
        shippingAddress: hasAnyField ? cleanAddr : null,
      });
      setAddrWarnings([]);
      setOverrideAddrWarning(false);
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-profile-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <UserIcon className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Profile & shipping</h2>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            className="form-input"
            data-testid="account-name"
            autoComplete="name"
          />
        </Field>

        <div className="pt-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground mb-3 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" /> Default shipping address
          </p>
          <div className="space-y-3">
            <Field label="Street address">
              <input
                type="text"
                value={addr.line1}
                onChange={(e) => setAddr({ ...addr, line1: e.target.value })}
                placeholder="123 Main St"
                className="form-input"
                data-testid="account-addr-line1"
                autoComplete="address-line1"
              />
            </Field>
            <Field label="Apt, suite, etc. (optional)">
              <input
                type="text"
                value={addr.line2 ?? ""}
                onChange={(e) => setAddr({ ...addr, line2: e.target.value })}
                placeholder="Apt 4B"
                className="form-input"
                data-testid="account-addr-line2"
                autoComplete="address-line2"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="City">
                <input
                  type="text"
                  value={addr.city}
                  onChange={(e) => setAddr({ ...addr, city: e.target.value })}
                  className="form-input"
                  data-testid="account-addr-city"
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="State">
                <input
                  type="text"
                  value={addr.state}
                  onChange={(e) =>
                    setAddr({
                      ...addr,
                      state: e.target.value.toUpperCase().slice(0, 2),
                    })
                  }
                  maxLength={2}
                  placeholder="CA"
                  className="form-input"
                  data-testid="account-addr-state"
                  autoComplete="address-level1"
                />
              </Field>
              <Field label="ZIP">
                <input
                  type="text"
                  value={addr.postalCode}
                  onChange={(e) =>
                    setAddr({ ...addr, postalCode: e.target.value })
                  }
                  inputMode="numeric"
                  className="form-input"
                  data-testid="account-addr-zip"
                  autoComplete="postal-code"
                />
              </Field>
            </div>
          </div>
        </div>

        {error && (
          <p
            className="text-sm text-destructive"
            data-testid="account-save-error"
          >
            {error}
          </p>
        )}
        {addrWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-semibold mb-1">Address looks unusual:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {addrWarnings.map((r) => (
                <li key={r}>{r.replace(/_/g, " ")}</li>
              ))}
            </ul>
            <p className="mt-2">
              Fix it above, or{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setOverrideAddrWarning(true)}
              >
                save anyway
              </button>
              .
            </p>
          </div>
        )}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            disabled={saving}
            data-testid="account-save-btn"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span
              className="text-sm text-emerald-700 inline-flex items-center gap-1.5"
              data-testid="account-save-success"
            >
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
          {/* Visible cue when there are unsaved changes. Pairs with
              the beforeunload prompt — the prompt only fires on tab
              close, this hint reassures the user (or warns them)
              while they're still on the page. Hidden during the
              brief post-save flash so we don't show "Unsaved" right
              next to "Saved". */}
          {dirty && !(savedAt && Date.now() - savedAt < 4000) && (
            <span
              className="text-xs text-amber-700"
              data-testid="account-profile-dirty"
            >
              Unsaved changes
            </span>
          )}
        </div>
      </form>

      <style>{`
        .form-input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border-radius: 0.5rem;
          border: 1px solid hsl(var(--border) / 0.6);
          background: white;
          font-size: 0.95rem;
          color: hsl(var(--foreground));
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: hsl(var(--penn-navy) / 0.6);
          box-shadow: 0 0 0 3px hsl(var(--penn-navy) / 0.12);
        }
      `}</style>
    </section>
  );
}

/**
 * Renders a labeled form field wrapper.
 *
 * @param label - Visible label text shown above the field content
 * @param children - Field input or other inline content to render beneath the label
 * @returns A JSX element containing the label and its associated children
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground mb-1 block">
        {label}
      </span>
      {children}
    </label>
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


// Re-export for App.tsx import consistency.
export default AccountPage;
// Reference basePath so unused-var lint stays clean even if a future
// edit drops its only consumer.
void basePath;

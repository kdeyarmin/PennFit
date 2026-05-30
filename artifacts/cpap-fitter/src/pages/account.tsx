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

import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SignedIn, useShopIdentity } from "@/lib/identity";
import {
  AlertCircle,
  CreditCard,
  Loader2,
  Package,
  ShoppingBag,
  UserCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AccountApiError,
  fetchShopMe,
  type ShopMeResponse,
  type SavedCard,
} from "@/lib/account-api";
import { fetchShopProducts } from "@/lib/shop-api";
import { OrdersSection } from "@/components/account/OrdersSection";
import { SubscriptionsSection } from "@/components/account/SubscriptionsSection";
import { DocumentsSection } from "@/components/account/DocumentsSection";
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
              role="alert"
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

// Re-export for App.tsx import consistency.
export default AccountPage;
// Reference basePath so unused-var lint stays clean even if a future
// edit drops its only consumer.
void basePath;

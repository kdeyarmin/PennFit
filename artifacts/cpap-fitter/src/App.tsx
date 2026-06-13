import React, { Suspense, useEffect, useState } from "react";
import {
  Switch,
  Route,
  Router as WouterRouter,
  Redirect,
  useLocation,
} from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { CartSnapshotSync } from "@/hooks/use-cart-snapshot";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

// The landing page is the ONE eagerly-imported route. It's the most
// common entry point, so keeping it in the initial chunk avoids a
// load waterfall on first paint / LCP. Every other route is
// code-split into its own on-demand chunk (the lazyWithRetry block
// below) so its page code never weighs down the initial bundle.
import { Home } from "@/pages/home";

// Formerly-eager public pages, now code-split. Each becomes its own
// chunk, loaded on demand under the shared <Suspense> boundary in
// PatientRouter. They had grown large (shop/learn/faq are 800–1200+
// lines) and were the bulk of the >400 kB initial chunk.
const Shop = lazyWithRetry(() =>
  import("@/pages/shop").then((m) => ({ default: m.Shop })),
);
const Masks = lazyWithRetry(() =>
  import("@/pages/masks").then((m) => ({ default: m.Masks })),
);
const HowItWorks = lazyWithRetry(() =>
  import("@/pages/how-it-works").then((m) => ({ default: m.HowItWorks })),
);
const Faq = lazyWithRetry(() =>
  import("@/pages/faq").then((m) => ({ default: m.Faq })),
);
const Learn = lazyWithRetry(() =>
  import("@/pages/learn").then((m) => ({ default: m.Learn })),
);
const Privacy = lazyWithRetry(() =>
  import("@/pages/privacy").then((m) => ({ default: m.Privacy })),
);
const Terms = lazyWithRetry(() =>
  import("@/pages/terms").then((m) => ({ default: m.Terms })),
);
const Insurance = lazyWithRetry(() =>
  import("@/pages/insurance").then((m) => ({ default: m.Insurance })),
);
const InsuranceEstimate = lazyWithRetry(() =>
  import("@/pages/insurance-estimate").then((m) => ({
    default: m.InsuranceEstimate,
  })),
);
const TrackOrder = lazyWithRetry(() =>
  import("@/pages/track-order").then((m) => ({ default: m.TrackOrder })),
);
const NpsLanding = lazyWithRetry(() =>
  import("@/pages/nps").then((m) => ({ default: m.NpsLanding })),
);
const MaskFitLanding = lazyWithRetry(() =>
  import("@/pages/mask-fit").then((m) => ({ default: m.MaskFitLanding })),
);
const LearnVideos = lazyWithRetry(() =>
  import("@/pages/learn-videos").then((m) => ({ default: m.LearnVideos })),
);

// Lazy-loaded pages. Each is its own webpack/Rollup chunk so the
// heavy dependencies they pull in (e.g. @mediapipe/tasks-vision in
// /measure, the admin tables in /admin) don't bloat the initial
// patient-shop bundle. The catch-all <Suspense> below shows a tiny
// loading shim while the chunk is in flight.
//
// The named-export -> default-export adapter is needed because each
// page file uses a named export and React.lazy expects a module with
// a default export.
const Consent = lazyWithRetry(() =>
  import("@/pages/consent").then((m) => ({ default: m.Consent })),
);
const FitterInvite = lazyWithRetry(() =>
  import("@/pages/fitter-invite").then((m) => ({ default: m.FitterInvite })),
);
const Capture = lazyWithRetry(() =>
  import("@/pages/capture").then((m) => ({ default: m.Capture })),
);
const Measure = lazyWithRetry(() =>
  import("@/pages/measure").then((m) => ({ default: m.Measure })),
);
const Questionnaire = lazyWithRetry(() =>
  import("@/pages/questionnaire").then((m) => ({ default: m.Questionnaire })),
);
const Results = lazyWithRetry(() =>
  import("@/pages/results").then((m) => ({ default: m.Results })),
);
const Order = lazyWithRetry(() =>
  import("@/pages/order").then((m) => ({ default: m.Order })),
);
const OrderSuccess = lazyWithRetry(() =>
  import("@/pages/order-success").then((m) => ({ default: m.OrderSuccess })),
);
const ComfortGuaranteePage = lazyWithRetry(() =>
  import("@/pages/comfort-guarantee").then((m) => ({
    default: m.ComfortGuaranteePage,
  })),
);
const ReplacementSchedule = lazyWithRetry(() =>
  import("@/pages/replacement-schedule").then((m) => ({
    default: m.ReplacementSchedule,
  })),
);
const DeviceSetup = lazyWithRetry(() =>
  import("@/pages/device-setup").then((m) => ({ default: m.DeviceSetup })),
);
const SleepApneaQuiz = lazyWithRetry(() =>
  import("@/pages/sleep-apnea-quiz").then((m) => ({
    default: m.SleepApneaQuiz,
  })),
);
const ShopCart = lazyWithRetry(() =>
  import("@/pages/shop-cart").then((m) => ({ default: m.ShopCart })),
);
const ShopProductDetail = lazyWithRetry(() =>
  import("@/pages/shop-product-detail").then((m) => ({
    default: m.ShopProductDetail,
  })),
);
const ShopCheckoutSuccess = lazyWithRetry(() =>
  import("@/pages/shop-checkout-success").then((m) => ({
    default: m.ShopCheckoutSuccess,
  })),
);
const ShopCheckoutCancel = lazyWithRetry(() =>
  import("@/pages/shop-checkout-cancel").then((m) => ({
    default: m.ShopCheckoutCancel,
  })),
);
const ShopOrders = lazyWithRetry(() =>
  import("@/pages/shop-orders").then((m) => ({ default: m.ShopOrders })),
);
const ShopWishlist = lazyWithRetry(() =>
  import("@/pages/shop-wishlist").then((m) => ({ default: m.ShopWishlist })),
);
const AccountPage = lazyWithRetry(() =>
  import("@/pages/account").then((m) => ({ default: m.AccountPage })),
);
const AccountBillingPage = lazyWithRetry(() =>
  import("@/pages/account-billing").then((m) => ({
    default: m.AccountBillingPage,
  })),
);
const SignInPage = lazyWithRetry(() =>
  import("@/pages/sign-in").then((m) => ({ default: m.SignInPage })),
);
const SignUpPage = lazyWithRetry(() =>
  import("@/pages/sign-up").then((m) => ({ default: m.SignUpPage })),
);
const ForgotPasswordPage = lazyWithRetry(() =>
  import("@/pages/forgot-password").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazyWithRetry(() =>
  import("@/pages/reset-password").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const VerifyEmailPage = lazyWithRetry(() =>
  import("@/pages/verify-email").then((m) => ({
    default: m.VerifyEmailPage,
  })),
);
const ReturnsPage = lazyWithRetry(() =>
  import("@/pages/returns").then((m) => ({ default: m.ReturnsPage })),
);

// Help Center — task-oriented, "how do I use this feature" documentation.
// Distinct from /learn (medical patient education) and /faq (quick clinical
// Q&A): a category hub at /help plus step-by-step, screenshot-illustrated
// how-to guides under /help/* for the fitter, ordering, the shop, tracking,
// accounts, resupply reminders, insurance estimates, and returns. Lazy-loaded
// because they're support content, not part of the fitter/checkout flow, so
// they shouldn't bloat the initial patient-shop bundle.
const Help = lazyWithRetry(() =>
  import("@/pages/help").then((m) => ({ default: m.Help })),
);
const HelpFindYourMask = lazyWithRetry(() =>
  import("@/pages/help-find-your-mask").then((m) => ({
    default: m.HelpFindYourMask,
  })),
);
const HelpPlaceAnOrder = lazyWithRetry(() =>
  import("@/pages/help-place-an-order").then((m) => ({
    default: m.HelpPlaceAnOrder,
  })),
);
const HelpShopAndCheckout = lazyWithRetry(() =>
  import("@/pages/help-shop-and-checkout").then((m) => ({
    default: m.HelpShopAndCheckout,
  })),
);
const HelpTrackYourOrder = lazyWithRetry(() =>
  import("@/pages/help-track-your-order").then((m) => ({
    default: m.HelpTrackYourOrder,
  })),
);
const HelpCreateAnAccount = lazyWithRetry(() =>
  import("@/pages/help-create-an-account").then((m) => ({
    default: m.HelpCreateAnAccount,
  })),
);
const HelpResupplyReminders = lazyWithRetry(() =>
  import("@/pages/help-resupply-reminders").then((m) => ({
    default: m.HelpResupplyReminders,
  })),
);
const HelpInsuranceEstimate = lazyWithRetry(() =>
  import("@/pages/help-insurance-estimate").then((m) => ({
    default: m.HelpInsuranceEstimate,
  })),
);
const HelpReturnsAndRefunds = lazyWithRetry(() =>
  import("@/pages/help-returns-and-refunds").then((m) => ({
    default: m.HelpReturnsAndRefunds,
  })),
);
const HelpResetPassword = lazyWithRetry(() =>
  import("@/pages/help-reset-password").then((m) => ({
    default: m.HelpResetPassword,
  })),
);
const HelpSaveToWishlist = lazyWithRetry(() =>
  import("@/pages/help-save-to-wishlist").then((m) => ({
    default: m.HelpSaveToWishlist,
  })),
);
const HelpManageSubscriptions = lazyWithRetry(() =>
  import("@/pages/help-manage-subscriptions").then((m) => ({
    default: m.HelpManageSubscriptions,
  })),
);
const HelpPaymentMethods = lazyWithRetry(() =>
  import("@/pages/help-payment-methods").then((m) => ({
    default: m.HelpPaymentMethods,
  })),
);
const HelpCommunicationPreferences = lazyWithRetry(() =>
  import("@/pages/help-communication-preferences").then((m) => ({
    default: m.HelpCommunicationPreferences,
  })),
);
const HelpDocumentsAndForms = lazyWithRetry(() =>
  import("@/pages/help-documents-and-forms").then((m) => ({
    default: m.HelpDocumentsAndForms,
  })),
);
const HelpCaregiverAccess = lazyWithRetry(() =>
  import("@/pages/help-caregiver-access").then((m) => ({
    default: m.HelpCaregiverAccess,
  })),
);
const HelpEquipmentAndRecalls = lazyWithRetry(() =>
  import("@/pages/help-equipment-and-recalls").then((m) => ({
    default: m.HelpEquipmentAndRecalls,
  })),
);
const HelpOrderByPhone = lazyWithRetry(() =>
  import("@/pages/help-order-by-phone").then((m) => ({
    default: m.HelpOrderByPhone,
  })),
);

// Educational long-form articles under /learn/*. Lazy-loaded — these are
// shareable awareness pages, not entry points for the fitter flow, so
// they shouldn't bloat the initial bundle. The marketing/contact flows
// link out to these URLs directly.
const LearnSleepApneaExplained = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-explained").then((m) => ({
    default: m.LearnSleepApneaExplained,
  })),
);
const LearnHealthRisks = lazyWithRetry(() =>
  import("@/pages/learn-health-risks").then((m) => ({
    default: m.LearnHealthRisks,
  })),
);
const LearnPapTherapyBenefits = lazyWithRetry(() =>
  import("@/pages/learn-pap-therapy-benefits").then((m) => ({
    default: m.LearnPapTherapyBenefits,
  })),
);
const LearnHowPapWorks = lazyWithRetry(() =>
  import("@/pages/learn-how-pap-works").then((m) => ({
    default: m.LearnHowPapWorks,
  })),
);
const LearnTherapyTypes = lazyWithRetry(() =>
  import("@/pages/learn-therapy-types").then((m) => ({
    default: m.LearnTherapyTypes,
  })),
);
const LearnSleepApneaHeartHealth = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-heart-health").then((m) => ({
    default: m.LearnSleepApneaHeartHealth,
  })),
);
const LearnFirstTwoWeeks = lazyWithRetry(() =>
  import("@/pages/learn-first-two-weeks").then((m) => ({
    default: m.LearnFirstTwoWeeks,
  })),
);
const LearnTravelingWithCpap = lazyWithRetry(() =>
  import("@/pages/learn-traveling-with-cpap").then((m) => ({
    default: m.LearnTravelingWithCpap,
  })),
);
const LearnCleaningRoutine = lazyWithRetry(() =>
  import("@/pages/learn-cleaning-routine").then((m) => ({
    default: m.LearnCleaningRoutine,
  })),
);
const LearnMythsDebunked = lazyWithRetry(() =>
  import("@/pages/learn-myths-debunked").then((m) => ({
    default: m.LearnMythsDebunked,
  })),
);
const LearnGlossary = lazyWithRetry(() =>
  import("@/pages/learn-glossary").then((m) => ({
    default: m.LearnGlossary,
  })),
);
const LearnInsuranceGuide = lazyWithRetry(() =>
  import("@/pages/learn-insurance-guide").then((m) => ({
    default: m.LearnInsuranceGuide,
  })),
);

// SEO landing — the "front door" mega-page that anchors the whole
// educational library. Lazy because it's marketing content, not part
// of any fitter/checkout flow.
const SleepApnea101 = lazyWithRetry(() =>
  import("@/pages/sleep-apnea-101").then((m) => ({
    default: m.SleepApnea101,
  })),
);

// Specialty-audience articles — comorbidity and population-specific
// long-form resources that round out the library for the people most
// affected (women, diabetes, mental health, kids, seniors) plus the
// "for partners & family" pair that drives shareable, conversion-
// relevant content.
const LearnSleepApneaWomen = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-women").then((m) => ({
    default: m.LearnSleepApneaWomen,
  })),
);
const LearnSleepApneaDiabetes = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-diabetes").then((m) => ({
    default: m.LearnSleepApneaDiabetes,
  })),
);
const LearnSleepApneaMentalHealth = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-mental-health").then((m) => ({
    default: m.LearnSleepApneaMentalHealth,
  })),
);
const LearnPediatricSleepApnea = lazyWithRetry(() =>
  import("@/pages/learn-pediatric-sleep-apnea").then((m) => ({
    default: m.LearnPediatricSleepApnea,
  })),
);
const LearnSleepApneaSeniors = lazyWithRetry(() =>
  import("@/pages/learn-sleep-apnea-seniors").then((m) => ({
    default: m.LearnSleepApneaSeniors,
  })),
);
const LearnPartnerGuide = lazyWithRetry(() =>
  import("@/pages/learn-partner-guide").then((m) => ({
    default: m.LearnPartnerGuide,
  })),
);
const LearnTalkingToALovedOne = lazyWithRetry(() =>
  import("@/pages/learn-talking-to-a-loved-one").then((m) => ({
    default: m.LearnTalkingToALovedOne,
  })),
);

// Troubleshooting cluster — focused, high-search-volume fix-it articles
// for the issues that drive most first-month adherence drop-off.
const LearnDryMouth = lazyWithRetry(() =>
  import("@/pages/learn-dry-mouth").then((m) => ({ default: m.LearnDryMouth })),
);
const LearnCpapBloating = lazyWithRetry(() =>
  import("@/pages/learn-cpap-bloating").then((m) => ({
    default: m.LearnCpapBloating,
  })),
);
const LearnMaskLeaks = lazyWithRetry(() =>
  import("@/pages/learn-mask-leaks").then((m) => ({
    default: m.LearnMaskLeaks,
  })),
);
const LearnCpapClaustrophobia = lazyWithRetry(() =>
  import("@/pages/learn-cpap-claustrophobia").then((m) => ({
    default: m.LearnCpapClaustrophobia,
  })),
);
const LearnNasalCongestion = lazyWithRetry(() =>
  import("@/pages/learn-nasal-congestion").then((m) => ({
    default: m.LearnNasalCongestion,
  })),
);

// Utility & marketing additions — patient stories landing, plus three
// further long-form learn pieces (sleep-report explainer, sleep
// hygiene companion, CPAP & weight-loss relationship).
const Stories = lazyWithRetry(() =>
  import("@/pages/stories").then((m) => ({ default: m.Stories })),
);
const LearnReadingYourSleepReport = lazyWithRetry(() =>
  import("@/pages/learn-reading-your-sleep-report").then((m) => ({
    default: m.LearnReadingYourSleepReport,
  })),
);
const LearnSleepHygiene = lazyWithRetry(() =>
  import("@/pages/learn-sleep-hygiene").then((m) => ({
    default: m.LearnSleepHygiene,
  })),
);
const LearnCpapAndWeightLoss = lazyWithRetry(() =>
  import("@/pages/learn-cpap-and-weight-loss").then((m) => ({
    default: m.LearnCpapAndWeightLoss,
  })),
);

// Brand marketing pages — a hub plus per-brand spotlights (React Health
// is our flagship line, ResMed and Fisher & Paykel round out the catalog).
// Lazy-loaded because they're SEO landing surfaces, not entry points for
// the fitter flow — they shouldn't bloat the initial bundle.
const CpapMasks = lazyWithRetry(() =>
  import("@/pages/cpap-masks").then((m) => ({ default: m.CpapMasks })),
);
const CpapMasksReactHealth = lazyWithRetry(() =>
  import("@/pages/cpap-masks-react-health").then((m) => ({
    default: m.CpapMasksReactHealth,
  })),
);
const CpapMasksResmed = lazyWithRetry(() =>
  import("@/pages/cpap-masks-resmed").then((m) => ({
    default: m.CpapMasksResmed,
  })),
);
const CpapMasksFisherPaykel = lazyWithRetry(() =>
  import("@/pages/cpap-masks-fisher-paykel").then((m) => ({
    default: m.CpapMasksFisherPaykel,
  })),
);

// Admin auth pages — separate sign-in flow because admins post to
// /resupply-api/auth/* (allowlist-gated) while customers post to
// /api/auth/* (open self-signup). The shared `pf_session` cookie is
// the same, but the entry pages are distinct so a typo in the
// password page can't accidentally promote a customer into the
// console-allowlist check or vice versa.
const AdminSignInPage = lazyWithRetry(() =>
  import("@/pages/admin/sign-in").then((m) => ({ default: m.SignInPage })),
);
const AdminForgotPasswordPage = lazyWithRetry(() =>
  import("@/pages/admin/forgot-password").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const AdminResetPasswordPage = lazyWithRetry(() =>
  import("@/pages/admin/reset-password").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const AdminVerifyEmailPage = lazyWithRetry(() =>
  import("@/pages/admin/verify-email").then((m) => ({
    default: m.VerifyEmailPage,
  })),
);

// Gated admin console — bundles all 28 admin pages, the AppShell
// chrome, and the generated resupply-api client into a single chunk
// loaded only when a staff user navigates to /admin/*. Keeps the
// patient storefront bundle clean.
const AdminConsoleRoute = lazyWithRetry(() =>
  import("@/pages/admin/console").then((m) => ({ default: m.ConsoleRoute })),
);

// Provider e-signature portal — its own on-demand chunk (sign-in, MFA
// enrollment, document queue, signing). Gated internally against
// /api/provider/me; not part of the admin or storefront bundles.
const ProviderPortalRoute = lazyWithRetry(() =>
  import("@/pages/provider/ProviderPortalRoute").then((m) => ({
    default: m.ProviderPortalRoute,
  })),
);

const Reminders = lazyWithRetry(() =>
  import("@/pages/reminders").then((m) => ({ default: m.Reminders })),
);
const RemindersManage = lazyWithRetry(() =>
  import("@/pages/reminders-manage").then((m) => ({
    default: m.RemindersManage,
  })),
);
const PatientPacketSign = lazyWithRetry(() =>
  import("@/pages/patient-packet-sign").then((m) => ({
    default: m.PatientPacketSign,
  })),
);
const OrderPay = lazyWithRetry(() =>
  import("@/pages/order-pay").then((m) => ({
    default: m.OrderPay,
  })),
);
const VideoVisitPage = lazyWithRetry(() =>
  import("@/pages/video-visit").then((m) => ({
    default: m.VideoVisitPage,
  })),
);

import { FitterProvider, useFitterStore } from "@/hooks/use-fitter-store";
import { useShopIdentity } from "@/lib/identity";
import { canStayOnMeasure } from "@/lib/measure-flow";
import { DemoModeProvider } from "@/demo/DemoModeProvider";
import { DemoBanner } from "@/demo/DemoBanner";

/**
 * Suspense fallback for lazy-loaded routes. Intentionally minimal
 * (matches the page-load skeleton tone) so a slow-network chunk
 * load doesn't flash a heavy spinner above the fold.
 */
function RouteFallback() {
  return (
    <div
      className="flex flex-1 items-center justify-center min-h-[40vh]"
      role="status"
      aria-label="Loading page"
    >
      <div className="h-8 w-8 rounded-full border-2 border-[hsl(var(--penn-navy))]/20 border-t-[hsl(var(--penn-navy))] animate-spin" />
    </div>
  );
}

// Sensible client-wide defaults so the shop catalog, fitter recommendation,
// and mask lists don't refetch on every tab focus / remount. The shop catalog
// is already server-cached ~60s, so a 60s client staleTime keeps the two in
// lockstep; one retry absorbs a transient blip without hammering the API.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Guard helpers — each is rendered as the function-child of a Wouter
 * <Route>. We can't use a custom <ProtectedRoute> wrapper here because
 * Wouter's <Switch> only inspects its direct <Route> children's `path`
 * prop and would otherwise fall through to NotFound.
 *
 * Each guard:
 *   1. Reads from the in-memory fitter store (which lives in a context),
 *   2. If the precondition fails, returns <Redirect> — the URL changes
 *      and the protected page never mounts (no flash of intermediate UI),
 *   3. Otherwise mounts the page.
 *
 * This replaces the older per-page useEffect+setLocation+`return null`
 * pattern, which left the URL out of sync with rendered content during
 * the redirect tick.
 */
/**
 * Email gate that fronts every fitter step. The `/consent` page stores
 * the email when the patient clicks Continue, so "email present" means
 * "the consent step was completed"; a patient who deep-links into
 * `/capture` (or refreshes a tab whose sessionStorage was cleared)
 * gets bounced back here.
 *
 * Deliberately does NOT require `emailConsent`: that flag is the
 * OPTIONAL marketing opt-in checkbox, which the consent page does not
 * require to continue (forcing it would be a consent dark pattern —
 * see consent.tsx). Gating on it sent every patient who declined
 * marketing email into a silent /consent redirect loop. The flag's
 * only consumer is the marketing-gated completion ping in results.tsx.
 */
function useFitterEmailGate(): boolean {
  const { email } = useFitterStore();
  return Boolean(email);
}

function GuardedCapture() {
  const consented = useFitterEmailGate();
  if (!consented) return <Redirect to="/consent" />;
  return <Capture />;
}

function GuardedMeasure() {
  const { capturedImage, measurements } = useFitterStore();
  const consented = useFitterEmailGate();
  if (!consented) return <Redirect to="/consent" />;
  // See canStayOnMeasure for the invariant. The non-obvious case is the
  // brief post-extraction window where capturedImage has been cleared
  // for privacy but /measure hasn't navigated to /questionnaire yet —
  // bouncing back to /capture in that window strands the user.
  // `replace` so the image-less /measure entry doesn't stay in history
  // (Back from /capture would re-mount it and bounce forward again —
  // the P2-8 back-button trap).
  if (!canStayOnMeasure(capturedImage, measurements))
    return <Redirect to="/capture" replace />;
  return <Measure />;
}
function GuardedQuestionnaire() {
  const { measurements } = useFitterStore();
  const consented = useFitterEmailGate();
  if (!consented) return <Redirect to="/consent" />;
  if (!measurements) return <Redirect to="/capture" replace />;
  return <Questionnaire />;
}
function GuardedResults() {
  const { measurements } = useFitterStore();
  const consented = useFitterEmailGate();
  if (!consented) return <Redirect to="/consent" />;
  if (!measurements) return <Redirect to="/" />;
  return <Results />;
}
/**
 * LegacyResupplyRedirect
 *
 * Forward old `/resupply/*` URLs to the new `/admin/*` mount while
 * preserving the query string and hash. wouter's `<Redirect to>`
 * only carries the path, which would silently strip `?token=...`
 * from links like `/resupply/reset-password?token=abc` — breaking
 * password-reset and email-verify flows. We use an effect that calls
 * `setLocation` with the full path+search+hash so SPA navigation
 * lands on the right place with the original token intact.
 */
function LegacyResupplyRedirect({ rest }: { rest: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const path = rest ? `/admin/${rest}` : "/admin";
    setLocation(`${path}${search}${hash}`, { replace: true });
  }, [rest, setLocation]);
  return null;
}

function GuardedOrder() {
  const { chosenMask, measurements } = useFitterStore();
  const consented = useFitterEmailGate();
  if (!consented) return <Redirect to="/consent" />;
  // An order without sizing data is a fulfillment problem for the DME
  // team — require measurements alongside the chosen mask. Both are
  // sessionStorage-backed, so a mid-flow refresh keeps the user here;
  // missing measurements means the flow was never completed.
  if (!measurements) return <Redirect to="/" replace />;
  if (!chosenMask) return <Redirect to="/results" />;
  return <Order />;
}

function GuardedShopOrders() {
  const { isSignedIn, isLoaded } = useShopIdentity();
  if (!isLoaded) return <RouteFallback />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return <ShopOrders />;
}

function GuardedAccount() {
  const { isSignedIn, isLoaded } = useShopIdentity();
  if (!isLoaded) return <RouteFallback />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return <AccountPage />;
}

function GuardedAccountBilling() {
  const { isSignedIn, isLoaded } = useShopIdentity();
  if (!isLoaded) return <RouteFallback />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return <AccountBillingPage />;
}

/**
 * Order-success gating. The confirmation normally lives in
 * sessionStorage (so a refresh after order doesn't re-submit). If
 * that's gone — tab crashed, cache cleared, deep link from an email
 * — we fall back to recovering the confirmation server-side using
 * the ?ref + ?email URL params that /order appended on submit.
 * The /api/orders/track endpoint already enforces matching email +
 * rate limiting, so this doesn't widen the attack surface beyond
 * the existing track-order page.
 */
function GuardedOrderSuccess() {
  const [state, setState] = useState<"checking" | "ok" | "deny">("checking");
  useEffect(() => {
    let cancelled = false;
    // Fast path: sessionStorage carries the confirmation from /order.
    try {
      const stored = sessionStorage.getItem("fitter_order_confirmation");
      if (stored) {
        setState("ok");
        return;
      }
    } catch {
      /* fall through to URL-param recovery */
    }
    // Recovery path: read ?ref + ?email from the URL and ask the
    // server. If both are present and the lookup succeeds, prime
    // sessionStorage so <OrderSuccess /> renders normally without
    // its own retry needed.
    let ref: string | null = null;
    let email: string | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      ref = params.get("ref");
      email = params.get("email");
    } catch {
      /* ignore — URL parse failure falls through to deny */
    }
    if (!ref || !email) {
      setState("deny");
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/orders/track", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ orderReference: ref, email }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setState("deny");
          return;
        }
        const data = (await res.json()) as {
          orderReference: string;
          mask: {
            name: string;
            manufacturer: string | null;
            modelNumber?: string | null;
          };
        };
        // Prime sessionStorage in the same shape /order writes so the
        // OrderSuccess component's existing hydration path Just Works.
        // Recovered orders don't carry measurements (not returned by
        // /api/orders/track — they live in the persisted order's
        // payload jsonb and aren't part of the public lookup surface);
        // <OrderSuccess /> already renders the measurements card
        // conditionally so absence is a clean visual no-op.
        try {
          sessionStorage.setItem(
            "fitter_order_confirmation",
            JSON.stringify({
              orderReference: data.orderReference,
              message:
                "Your order has been sent to Penn Home Medical Supply. A team member will contact you within 1 business day to confirm and arrange shipping.",
              mask: {
                name: data.mask.name,
                manufacturer: data.mask.manufacturer ?? "",
                modelNumber: data.mask.modelNumber ?? "",
              },
            }),
          );
          setState("ok");
        } catch {
          // sessionStorage write failed (e.g. private browsing /
          // storage disabled). Without it, OrderSuccess hydrates to
          // null and the page is blank — better to deny+redirect so
          // the patient at least sees the home page than to leave
          // them staring at an empty "Order confirmed" frame.
          setState("deny");
          return;
        }
        // URL scrub runs ONLY after successful recovery so that a
        // transient fetch failure leaves the ?ref + ?email intact —
        // the patient can refresh and retry from the same URL.
        // Scrubbing earlier would burn the recovery inputs on the
        // first attempt and bounce them to "/" with no way back.
        try {
          const scrubbedUrl = `${window.location.pathname}${window.location.hash}`;
          window.history.replaceState(window.history.state, "", scrubbedUrl);
        } catch {
          /* ignore — best-effort URL scrub */
        }
      } catch {
        if (!cancelled) setState("deny");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (state === "checking") return <RouteFallback />;
  if (state === "deny") return <Redirect to="/" />;
  return <OrderSuccess />;
}

function PatientRouter() {
  const [location] = useLocation();
  return (
    <Layout>
      {/*
        Render-nothing component that mirrors a signed-in user's cart
        to the server (debounced, best-effort) so the cart-abandonment
        nudge dispatcher has something to scan. Mounted here so it runs
        on every patient page where the cart can change. No-op for
        signed-out visitors.
      */}
      <CartSnapshotSync />
      {/*
        Inline error boundary INSIDE the Layout so a crash in any single
        page falls back to a recoverable card while the header/nav/footer
        stay usable — the customer keeps navigation instead of losing the
        whole site (the top-level boundary in App() still catches crashes
        in the Layout chrome itself). Keyed on `location` so navigating to
        another route remounts it and clears a stuck error state.

        Single Suspense boundary above the Switch. Wouter swaps the
        active <Route>'s component on navigation; if the new component
        is lazy and not yet loaded, React suspends and we render the
        fallback in place of the page content (header/footer stay).
      */}
      <ErrorBoundary variant="inline" key={location}>
        <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/consent" component={Consent} />
            <Route path="/fitter-invite" component={FitterInvite} />
            <Route path="/capture" component={GuardedCapture} />
            <Route path="/masks" component={Masks} />
            <Route path="/cpap-masks" component={CpapMasks} />
            <Route
              path="/cpap-masks/react-health"
              component={CpapMasksReactHealth}
            />
            <Route path="/cpap-masks/resmed" component={CpapMasksResmed} />
            <Route
              path="/cpap-masks/fisher-paykel"
              component={CpapMasksFisherPaykel}
            />
            <Route path="/how-it-works" component={HowItWorks} />
            <Route path="/faq" component={Faq} />
            {/* Help Center — specific /help/* guides registered before the
              /help hub so wouter's <Switch> matches them first. */}
            <Route path="/help/find-your-mask" component={HelpFindYourMask} />
            <Route path="/help/place-an-order" component={HelpPlaceAnOrder} />
            <Route
              path="/help/shop-and-checkout"
              component={HelpShopAndCheckout}
            />
            <Route
              path="/help/track-your-order"
              component={HelpTrackYourOrder}
            />
            <Route
              path="/help/create-an-account"
              component={HelpCreateAnAccount}
            />
            <Route
              path="/help/resupply-reminders"
              component={HelpResupplyReminders}
            />
            <Route
              path="/help/insurance-estimate"
              component={HelpInsuranceEstimate}
            />
            <Route
              path="/help/returns-and-refunds"
              component={HelpReturnsAndRefunds}
            />
            <Route path="/help/reset-password" component={HelpResetPassword} />
            <Route
              path="/help/save-to-wishlist"
              component={HelpSaveToWishlist}
            />
            <Route
              path="/help/manage-subscriptions"
              component={HelpManageSubscriptions}
            />
            <Route
              path="/help/payment-methods"
              component={HelpPaymentMethods}
            />
            <Route
              path="/help/communication-preferences"
              component={HelpCommunicationPreferences}
            />
            <Route
              path="/help/documents-and-forms"
              component={HelpDocumentsAndForms}
            />
            <Route
              path="/help/caregiver-access"
              component={HelpCaregiverAccess}
            />
            <Route
              path="/help/equipment-and-recalls"
              component={HelpEquipmentAndRecalls}
            />
            <Route path="/help/order-by-phone" component={HelpOrderByPhone} />
            <Route path="/help" component={Help} />
            <Route path="/learn" component={Learn} />
            <Route path="/learn/videos" component={LearnVideos} />
            <Route
              path="/learn/replacement-schedule"
              component={ReplacementSchedule}
            />
            <Route path="/learn/device-setup" component={DeviceSetup} />
            <Route path="/learn/sleep-apnea-quiz" component={SleepApneaQuiz} />
            <Route
              path="/learn/sleep-apnea-explained"
              component={LearnSleepApneaExplained}
            />
            <Route path="/learn/health-risks" component={LearnHealthRisks} />
            <Route
              path="/learn/pap-therapy-benefits"
              component={LearnPapTherapyBenefits}
            />
            <Route path="/learn/how-pap-works" component={LearnHowPapWorks} />
            <Route path="/learn/therapy-types" component={LearnTherapyTypes} />
            <Route
              path="/learn/sleep-apnea-heart-health"
              component={LearnSleepApneaHeartHealth}
            />
            <Route
              path="/learn/first-two-weeks"
              component={LearnFirstTwoWeeks}
            />
            <Route
              path="/learn/traveling-with-cpap"
              component={LearnTravelingWithCpap}
            />
            <Route
              path="/learn/cleaning-routine"
              component={LearnCleaningRoutine}
            />
            <Route
              path="/learn/myths-debunked"
              component={LearnMythsDebunked}
            />
            <Route path="/learn/glossary" component={LearnGlossary} />
            <Route
              path="/learn/insurance-guide"
              component={LearnInsuranceGuide}
            />
            <Route path="/sleep-apnea-101" component={SleepApnea101} />
            <Route
              path="/learn/sleep-apnea-women"
              component={LearnSleepApneaWomen}
            />
            <Route
              path="/learn/sleep-apnea-diabetes"
              component={LearnSleepApneaDiabetes}
            />
            <Route
              path="/learn/sleep-apnea-mental-health"
              component={LearnSleepApneaMentalHealth}
            />
            <Route
              path="/learn/pediatric-sleep-apnea"
              component={LearnPediatricSleepApnea}
            />
            <Route
              path="/learn/sleep-apnea-seniors"
              component={LearnSleepApneaSeniors}
            />
            <Route path="/learn/partner-guide" component={LearnPartnerGuide} />
            <Route
              path="/learn/talking-to-a-loved-one"
              component={LearnTalkingToALovedOne}
            />
            <Route path="/learn/dry-mouth" component={LearnDryMouth} />
            <Route path="/learn/cpap-bloating" component={LearnCpapBloating} />
            <Route path="/learn/mask-leaks" component={LearnMaskLeaks} />
            <Route
              path="/learn/cpap-claustrophobia"
              component={LearnCpapClaustrophobia}
            />
            <Route
              path="/learn/nasal-congestion"
              component={LearnNasalCongestion}
            />
            <Route path="/stories" component={Stories} />
            <Route
              path="/learn/reading-your-sleep-report"
              component={LearnReadingYourSleepReport}
            />
            <Route path="/learn/sleep-hygiene" component={LearnSleepHygiene} />
            <Route
              path="/learn/cpap-and-weight-loss"
              component={LearnCpapAndWeightLoss}
            />
            <Route path="/comfort-guarantee" component={ComfortGuaranteePage} />
            <Route path="/insurance" component={Insurance} />
            <Route path="/insurance/estimate" component={InsuranceEstimate} />
            <Route path="/track-order" component={TrackOrder} />
            <Route path="/nps" component={NpsLanding} />
            <Route path="/mask-fit" component={MaskFitLanding} />
            <Route path="/shop" component={Shop} />
            <Route path="/shop/p/:productId">
              {(params) => <ShopProductDetail productId={params.productId} />}
            </Route>
            <Route path="/shop/cart" component={ShopCart} />
            <Route
              path="/shop/checkout-success"
              component={ShopCheckoutSuccess}
            />
            <Route
              path="/shop/checkout-cancel"
              component={ShopCheckoutCancel}
            />
            <Route path="/shop/orders" component={GuardedShopOrders} />
            <Route path="/shop/wishlist" component={ShopWishlist} />
            <Route path="/account" component={GuardedAccount} />
            <Route path="/account/billing" component={GuardedAccountBilling} />
            {/* Push-notification deep links. The backend sends pushes
                with url=/account/orders (shipping updates) and
                /account/insights (smart triggers); both surfaces are
                tabs on /account, not standalone routes, so redirect to
                the hash form that hashToAccountTab() understands. */}
            <Route path="/account/orders">
              <Redirect to="/account#orders" replace />
            </Route>
            <Route path="/account/insights">
              <Redirect to="/account#insights" replace />
            </Route>
            <Route path="/reminders" component={Reminders} />
            <Route path="/reminders/manage" component={RemindersManage} />
            <Route path="/patient-packet-sign" component={PatientPacketSign} />
            {/* Public token-gated "review, sign & pay" page for
                CSR-created orders (link arrives by SMS/email; token
                rides the query string like /patient-packet-sign). */}
            <Route path="/order-pay" component={OrderPay} />
            {/* Public token-gated telehealth join page (link arrives by
                SMS/email; token rides the query string like
                /patient-packet-sign). */}
            <Route path="/video-visit" component={VideoVisitPage} />
            <Route path="/privacy" component={Privacy} />
            <Route path="/terms" component={Terms} />
            <Route path="/returns" component={ReturnsPage} />

            {/* Guarded routes — see GuardedXxx components above. */}
            <Route path="/measure" component={GuardedMeasure} />
            <Route path="/questionnaire" component={GuardedQuestionnaire} />
            <Route path="/results" component={GuardedResults} />
            <Route path="/order" component={GuardedOrder} />
            <Route path="/order-success" component={GuardedOrderSuccess} />

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

/**
 * Top-level <Switch>. We split admin and auth routes OUT of the patient
 * <Layout> so they can render in their own chrome (sign-in centered card,
 * admin sidebar shell). The admin pages mount inside <AdminShell> which
 * does the auth + allowlist gate.
 *
 * Wouter's nested-routing trick: catching `/sign-in/*` lets the auth provider
 * own everything below /sign-in (e.g. /sign-in/factor-one) without us
 * pre-defining each step. (regexparam 3.x parses `:rest*` as a single-
 * segment param literally named `rest*`, not as a wildcard — use `*`.)
 */
function TopRouter() {
  return (
    /*
      Top-level Suspense for sign-in/sign-up/admin chunks. Patient
      pages have their own Suspense inside <PatientRouter>; this one
      catches the chunk loads for routes that render outside the
      patient <Layout> chrome.
    */
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/sign-in" component={SignInPage} />
        <Route path="/sign-in/*" component={SignInPage} />
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/sign-up/*" component={SignUpPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/verify-email" component={VerifyEmailPage} />

        {/*
          Old `/resupply/*` deep links — the staff console used to
          live in its own SPA mounted at /resupply before the
          consolidation. Keep these working so existing bookmarks,
          email links, and SOP docs don't break overnight.
          The proxy still routes /resupply/* to this artifact (see
          artifact.toml), and we forward to the new /admin/* path.
        */}
        <Route path="/resupply">
          <LegacyResupplyRedirect rest="" />
        </Route>
        <Route path="/resupply/*">
          {(params) => <LegacyResupplyRedirect rest={params["*"] ?? ""} />}
        </Route>

        {/*
          Admin / staff routes. The auth pages (sign-in, forgot,
          reset, verify) are mounted ABOVE the gated console route
          so a signed-out admin can actually reach the sign-in form.
          Everything else under /admin/* funnels into
          <AdminConsoleRoute>, which probes /resupply-api/auth/me
          (session) → /resupply-api/admin/me (allowlist) before
          mounting the AppShell + admin Switch.
        */}
        <Route path="/admin/sign-in" component={AdminSignInPage} />
        <Route
          path="/admin/forgot-password"
          component={AdminForgotPasswordPage}
        />
        <Route
          path="/admin/reset-password"
          component={AdminResetPasswordPage}
        />
        <Route path="/admin/verify-email" component={AdminVerifyEmailPage} />
        <Route path="/admin" component={AdminConsoleRoute} />
        <Route path="/admin/*" component={AdminConsoleRoute} />

        {/*
          Provider e-signature portal. Self-contained surface where
          credentialed physicians/NPs sign in (MFA-protected) and e-sign
          outstanding documents. The route component owns its own
          sign-in + gating, so it's mounted ungated here like the auth
          pages above.
        */}
        <Route path="/provider" component={ProviderPortalRoute} />
        <Route path="/provider/*" component={ProviderPortalRoute} />

        {/* Everything else falls through to the patient experience. */}
        <Route component={PatientRouter} />
      </Switch>
    </Suspense>
  );
}

// Inner tree — independent of which auth provider wraps it.
// All components below this point use the identity shim
// in `@/lib/identity` for auth state.
function AppInner() {
  return (
    <DemoModeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <FitterProvider>
            {/*
              ErrorBoundary wraps the router so any thrown render error in a
              page falls back to a recoverable on-brand screen instead of a
              blank white page.
            */}
            <ErrorBoundary>
              {/*
                Admins toggle demo mode from /admin/settings, but the
                banner must be GLOBAL (P2-7): `?demo=1` persists in
                localStorage, so a customer who followed a shared demo
                link would otherwise browse a fake-data storefront with
                no indication and no way out.
              */}
              <DemoBanner />
              <WouterRouter base={basePath}>
                <TopRouter />
              </WouterRouter>
            </ErrorBoundary>
            <Toaster />
          </FitterProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </DemoModeProvider>
  );
}

function App() {
  return <AppInner />;
}

export default App;

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
import { getCompanyContact } from "@/lib/contact";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

// The landing page is the ONE eagerly-imported route. It's the most
// common entry point, so keeping it in the initial chunk avoids a
// load waterfall on first paint / LCP. Every other route is
// code-split into its own on-demand chunk (the lazyWithRetry block
// below) so its page code never weighs down the initial bundle.
import { Home } from "@/pages/home";

const Masks = lazyWithRetry(() =>
  import("@/pages/masks").then((m) => ({ default: m.Masks })),
);
const HowItWorks = lazyWithRetry(() =>
  import("@/pages/how-it-works").then((m) => ({ default: m.HowItWorks })),
);
const Faq = lazyWithRetry(() =>
  import("@/pages/faq").then((m) => ({ default: m.Faq })),
);
const Contact = lazyWithRetry(() =>
  import("@/pages/contact").then((m) => ({ default: m.Contact })),
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
const NpsLanding = lazyWithRetry(() =>
  import("@/pages/nps").then((m) => ({ default: m.NpsLanding })),
);
const TrackOrder = lazyWithRetry(() =>
  import("@/pages/track-order").then((m) => ({ default: m.TrackOrder })),
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
const FitRequest = lazyWithRetry(() =>
  import("@/pages/fit-request").then((m) => ({ default: m.FitRequest })),
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

// Help Center — task-oriented, "how do I use this feature" documentation.
// Distinct from /learn (medical patient education) and /faq (quick clinical
// Q&A): a category hub at /help plus step-by-step, screenshot-illustrated
// how-to guides under /help/* for the fitter, insurance ordering, tracking,
// accounts, resupply reminders, insurance estimates, and the comfort
// guarantee. Lazy-loaded because they're support content, not part of the
// fitter flow, so they shouldn't bloat the initial patient bundle.
const Help = lazyWithRetry(() =>
  import("@/pages/help").then((m) => ({ default: m.Help })),
);
const HelpFindYourMask = lazyWithRetry(() =>
  import("@/pages/help-find-your-mask").then((m) => ({
    default: m.HelpFindYourMask,
  })),
);
const HelpRequestYourMask = lazyWithRetry(() =>
  import("@/pages/help-request-your-mask").then((m) => ({
    default: m.HelpRequestYourMask,
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
const HelpResetPassword = lazyWithRetry(() =>
  import("@/pages/help-reset-password").then((m) => ({
    default: m.HelpResetPassword,
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

// Gated platform super-admin console (G4) — the cross-tenant operator
// surface, its own lazy chunk loaded only at /platform/*.
const PlatformConsoleRoute = lazyWithRetry(() =>
  import("@/pages/platform/console").then((m) => ({
    default: m.PlatformConsoleRoute,
  })),
);

// Provider e-signature portal — its own on-demand chunk (sign-in, MFA
// enrollment, document queue, signing). Gated internally against
// /api/provider/me; not part of the admin or storefront bundles.
const ProviderPortalRoute = lazyWithRetry(() =>
  import("@/pages/provider/ProviderPortalRoute").then((m) => ({
    default: m.ProviderPortalRoute,
  })),
);

// Breathe — the public marketing / showcase homepage for the DME
// operating platform by CareMetric.ai. A self-contained dark "command
// center" surface rendered OUTSIDE the patient <Layout> (its own chrome),
// so it's mounted in TopRouter. Lazy-loaded — its bespoke CSS + page code
// never weigh on the patient-shop initial bundle.
// Split out of one long single-scroll page into nav-aligned routes. All six
// resolve from the same lazy chunk, so only the first /breathe navigation
// pays the load; the rest are instant.
const BreatheHome = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheHome })),
);
const BreatheProduct = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheProduct })),
);
const BreatheCompare = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheCompare })),
);
const BreatheRoi = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheRoi })),
);
const BreathePricing = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreathePricing })),
);
const BreatheSecurity = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheSecurity })),
);
const BreatheSignup = lazyWithRetry(() =>
  import("@/pages/breathe").then((m) => ({ default: m.BreatheSignup })),
);

// Breathe — Case studies. How AI is applied across the DME workflow (sourced
// industry benchmarks) plus an explicitly illustrative/modeled CareMetric
// Breathe scenario. Same dark chrome, mounted in TopRouter, lazy-loaded.
const BreatheCaseStudies = lazyWithRetry(() =>
  import("@/pages/breathe-case-studies").then((m) => ({
    default: m.BreatheCaseStudies,
  })),
);

// Breathe — "What the software does, by role". A dedicated companion to
// the Breathe homepage that breaks every feature down by the team seat
// that uses it and tags each with time saved / cost cut / revenue grown.
// Same self-contained dark chrome (reuses breathe.css), mounted in
// TopRouter alongside /breathe, and lazy-loaded.
const BreatheFeatures = lazyWithRetry(() =>
  import("@/pages/breathe-features").then((m) => ({
    default: m.BreatheFeatures,
  })),
);

// Breathe — Integrations. The centerpiece marketing page: unifying the CPAP
// manufacturer device clouds (ResMed AirView, Philips Care Orchestrator, 3B
// React Health) into one fleet view with AI early-warning monitoring, plus
// the payer/billing connectors. Same dark chrome, mounted in TopRouter.
const BreatheIntegrations = lazyWithRetry(() =>
  import("@/pages/breathe-integrations").then((m) => ({
    default: m.BreatheIntegrations,
  })),
);

// Breathe — DME Platform 101. Category education for prospects who don't yet
// know this kind of software exists. Same dark chrome, mounted in TopRouter.
const BreatheLearn = lazyWithRetry(() =>
  import("@/pages/breathe-learn").then((m) => ({
    default: m.BreatheLearn,
  })),
);

// Breathe — FAQ. Leads with the marquee operator question ("is this compliant
// with Medicare and the major payers?") and answers everything else about the
// software. Same dark chrome, mounted in TopRouter, lazy-loaded.
const BreatheFaq = lazyWithRetry(() =>
  import("@/pages/breathe-faq").then((m) => ({
    default: m.BreatheFaq,
  })),
);

// Breathe — "Switch from <competitor>" migration landing pages (Brightree,
// Bonafide, NikoHealth). High-intent pages for operators already shopping to
// leave a legacy DME suite; each reuses the shared comparison + migration
// sections. Same dark chrome, mounted in TopRouter, lazy-loaded.
const BreatheSwitchBrightree = lazyWithRetry(() =>
  import("@/pages/breathe-switch").then((m) => ({
    default: m.BreatheSwitchBrightree,
  })),
);
const BreatheSwitchBonafide = lazyWithRetry(() =>
  import("@/pages/breathe-switch").then((m) => ({
    default: m.BreatheSwitchBonafide,
  })),
);
const BreatheSwitchNikohealth = lazyWithRetry(() =>
  import("@/pages/breathe-switch").then((m) => ({
    default: m.BreatheSwitchNikohealth,
  })),
);
// Point-solution comparison (not a platform migration): teams shopping a
// stand-alone AI mask fitter against ours. Same lazy chunk as the switch
// pages; leads with the fitting head-to-head, then the platform table.
const BreatheVsSleepGlad = lazyWithRetry(() =>
  import("@/pages/breathe-switch").then((m) => ({
    default: m.BreatheVsSleepGlad,
  })),
);

// Breathe — deep-dive "solution" pages. Long-form pages for the marquee
// revenue drivers (the AI voice agent, the full revenue cycle) and the
// patient-experience story. Same dark chrome, mounted in TopRouter,
// lazy-loaded off the patient-shop bundle.
const BreatheAiVoice = lazyWithRetry(() =>
  import("@/pages/breathe-ai-voice").then((m) => ({
    default: m.BreatheAiVoice,
  })),
);
const BreatheRevenueCycle = lazyWithRetry(() =>
  import("@/pages/breathe-revenue-cycle").then((m) => ({
    default: m.BreatheRevenueCycle,
  })),
);
const BreathePatientExperience = lazyWithRetry(() =>
  import("@/pages/breathe-patient-experience").then((m) => ({
    default: m.BreathePatientExperience,
  })),
);
const BreatheResupplyEngine = lazyWithRetry(() =>
  import("@/pages/breathe-resupply-engine").then((m) => ({
    default: m.BreatheResupplyEngine,
  })),
);
const BreatheCommunications = lazyWithRetry(() =>
  import("@/pages/breathe-communications").then((m) => ({
    default: m.BreatheCommunications,
  })),
);
const BreatheClinical = lazyWithRetry(() =>
  import("@/pages/breathe-clinical").then((m) => ({
    default: m.BreatheClinical,
  })),
);
const BreatheAnalytics = lazyWithRetry(() =>
  import("@/pages/breathe-analytics").then((m) => ({
    default: m.BreatheAnalytics,
  })),
);
const BreatheCompliance = lazyWithRetry(() =>
  import("@/pages/breathe-compliance").then((m) => ({
    default: m.BreatheCompliance,
  })),
);
const BreatheLocations = lazyWithRetry(() =>
  import("@/pages/breathe-locations").then((m) => ({
    default: m.BreatheLocations,
  })),
);
const BreatheMaskFitting = lazyWithRetry(() =>
  import("@/pages/breathe-mask-fitting").then((m) => ({
    default: m.BreatheMaskFitting,
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
const OrderSign = lazyWithRetry(() =>
  import("@/pages/order-sign").then((m) => ({
    default: m.OrderSign,
  })),
);
const VideoVisitPage = lazyWithRetry(() =>
  import("@/pages/video-visit").then((m) => ({
    default: m.VideoVisitPage,
  })),
);

import { FitterProvider, useFitterStore } from "@/hooks/use-fitter-store";
import { useShopIdentity } from "@/lib/identity";
import { isPlatformHomeHost } from "@/lib/platform-host";
import { canStayOnMeasure } from "@/lib/measure-flow";
import { isDemoActive } from "@/demo/state";
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
 * Consent gate that fronts every fitter step.
 *
 * Keyed on `cameraConsentGiven` — set ONLY by the /consent page's
 * Continue handler, which requires the affirmative camera/biometric
 * checkbox. It used to be `Boolean(email)`, on the reasoning that the
 * consent page is what stores the email, so "email present" implied
 * "consent submitted". That inference broke the moment anything else
 * stored an email first: a staff invite carries a KNOWN email, and
 * /fitter-invite prefills it on Start, so an invited patient was
 * treated as consented before they had seen the disclosure — free to
 * type /capture (or press Back/Forward out of /consent) straight into
 * `getUserMedia` with the checkbox never ticked.
 *
 * The email is still required alongside it: it is how the
 * recommendation is delivered, and a rehydrate that lost it should
 * re-ask rather than proceed.
 *
 * Deliberately does NOT require `emailConsent`: that flag is the
 * OPTIONAL marketing opt-in checkbox, which the consent page does not
 * require to continue (forcing it would be a consent dark pattern —
 * see consent.tsx). Gating on it sent every patient who declined
 * marketing email into a silent /consent redirect loop. The flag's
 * only consumer is the marketing-gated completion ping in results.tsx.
 */
function useFitterConsentGate(): boolean {
  const { email, cameraConsentGiven } = useFitterStore();
  return cameraConsentGiven && Boolean(email);
}

/**
 * Invite gate that fronts the ENTIRE virtual mask fitter. The fitter
 * is invitation-only: a patient reaches it through a signed link a
 * Breathe customer (their local DME company) sends by SMS or email
 * (`/fitter-invite?t=…`), which stashes the invite token in the
 * fitter store. Every fitter step — starting at /consent — refuses to
 * render without that token and bounces to /fitter-invite, which
 * explains that the patient needs a code/link from their DME company.
 *
 * The server-side `/api/recommend` endpoint independently requires a
 * valid signed invite token, so this client gate can't be bypassed by
 * deep-linking or seeding sessionStorage.
 *
 * Demo mode (`?demo=1`) bypasses the gate so the sandbox walkthrough
 * can still showcase the fitter without a real invite.
 */
function useFitterInviteGate(): boolean {
  const { inviteToken } = useFitterStore();
  return Boolean(inviteToken) || isDemoActive();
}

function GuardedConsent() {
  const invited = useFitterInviteGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  return <Consent />;
}

function GuardedCapture() {
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  if (!consented) return <Redirect to="/consent" />;
  return <Capture />;
}

function GuardedMeasure() {
  const { capturedImage, measurements } = useFitterStore();
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
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
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  if (!consented) return <Redirect to="/consent" />;
  if (!measurements) return <Redirect to="/capture" replace />;
  return <Questionnaire />;
}
function GuardedResults() {
  const { measurements, population } = useFitterStore();
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  if (!consented) return <Redirect to="/consent" />;
  if (!measurements) return <Redirect to="/" />;
  // No population means the questionnaire's adult-or-child gate was never
  // answered — a deep link, or a session that predates the question. Both
  // engines would then fall back to "adult", so send the patient back to
  // the one screen that can say otherwise rather than guessing on their
  // behalf.
  if (!population) return <Redirect to="/questionnaire" replace />;
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

/**
 * LegacyShopRedirect
 *
 * The cash-pay storefront (/shop, cart, checkout, product pages) was
 * retired when the patient path went insurance-only. Bookmarks, email
 * links, and in-app CTAs still point at /shop/*, so forward them to
 * living insurance-era surfaces while preserving query strings and
 * hashes:
 *   - order history → /track-order
 *   - cart / checkout / success receipts → /contact (no trackable ref)
 *   - everything else (product pages, generic /shop) → /insurance
 */
function LegacyShopRedirect({ rest }: { rest: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const normalized = rest.replace(/^\/+/, "").toLowerCase();
    let path = "/insurance";
    if (normalized === "orders" || normalized.startsWith("orders/")) {
      path = "/track-order";
    } else if (
      normalized === "cart" ||
      normalized.startsWith("cart/") ||
      normalized === "checkout" ||
      normalized.startsWith("checkout") ||
      normalized === "checkout-success" ||
      normalized.startsWith("checkout-success")
    ) {
      // Abandoned-cart / mid-checkout bookmarks have no PENN/PHM
      // reference — /track-order would just reject the empty form.
      // Match abandonment-email CTAs and send them to a human.
      path = "/contact";
    } else if (normalized === "nps" || normalized.startsWith("orders/nps")) {
      path = "/nps";
    }
    setLocation(`${path}${search}${hash}`, { replace: true });
  }, [rest, setLocation]);
  return null;
}

/**
 * `/login` and `/signin` → whichever sign-in page actually applies to the
 * host being browsed. Tenant hosts get the patient sign-in (the storefront's
 * own `/sign-in`); the platform home host has no storefront at all, so the
 * only account there is a staff/operator one at `/admin/sign-in`.
 *
 * Any `?redirect=` / `#hash` the caller carried is preserved so a deep link
 * that bounced someone to /login still returns them where they were headed.
 */
function LoginAliasRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const target = isPlatformHomeHost() ? "/admin/sign-in" : "/sign-in";
    setLocation(`${target}${search}${hash}`, { replace: true });
  }, [setLocation]);
  return null;
}

function AccountHashRedirect({
  hash,
}: {
  hash: "insights" | "messages" | "orders";
}) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    setLocation(`/account${search}#${hash}`, { replace: true });
  }, [hash, setLocation]);
  return null;
}

function GuardedFitRequest() {
  const { measurements, population } = useFitterStore();
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  if (!consented) return <Redirect to="/consent" />;
  // Deliberately does NOT require `chosenMask`. The callback mode exists
  // for the patient who could not pick between the cards — or whose
  // fitting named no mask at all — and demanding one first would gate the
  // request on the very decision they are asking for help with.
  //
  // It also does not re-check the invite TOKEN beyond
  // `useFitterInviteGate`, which is satisfied by demo mode without one —
  // the demo sandbox has no invite and must still walk this page.
  if (!measurements) return <Redirect to="/" replace />;
  // Mirrors GuardedResults. Without it a session that never answered the
  // gate — one predating this deployment, or a direct hop from /measure —
  // reaches the form, which then serializes `population ?? "adult"`: the
  // request row and the team email would claim an adult fitting nobody
  // was ever asked about.
  if (!population) return <Redirect to="/questionnaire" replace />;
  return <FitRequest />;
}

function GuardedOrder() {
  const { chosenMask, measurements, leadCaptureOnly } = useFitterStore();
  const invited = useFitterInviteGate();
  const consented = useFitterConsentGate();
  if (!invited) return <Redirect to="/fitter-invite" />;
  if (!consented) return <Redirect to="/consent" />;
  // `fitter.lead_capture_only` — this tenant's patients don't file their
  // own insurance orders. The results page no longer links here, but a
  // bookmark, a back-button, or a mid-flow flag flip can still land on
  // it, and the API refuses the POST anyway — so send them to the form
  // that works rather than one that will fail at submit.
  if (leadCaptureOnly) return <Redirect to="/fit-request" replace />;
  // An order without sizing data is a fulfillment problem for the DME
  // team — require measurements alongside the chosen mask. Both are
  // sessionStorage-backed, so a mid-flow refresh keeps the user here;
  // missing measurements means the flow was never completed.
  if (!measurements) return <Redirect to="/" replace />;
  if (!chosenMask) return <Redirect to="/results" />;
  return <Order />;
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
              message: `Your order has been sent to ${getCompanyContact().legalName}. A team member will contact you within 1 business day to confirm and arrange shipping.`,
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
            <Route path="/consent" component={GuardedConsent} />
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
            <Route path="/contact" component={Contact} />
            {/* Help Center — specific /help/* guides registered before the
              /help hub so wouter's <Switch> matches them first. */}
            <Route path="/help/find-your-mask" component={HelpFindYourMask} />
            <Route
              path="/help/request-your-mask"
              component={HelpRequestYourMask}
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
            <Route path="/help/reset-password" component={HelpResetPassword} />
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
            {/* Push-notification deep links. Shipping pushes now use
                /track-order; smart-trigger pushes still use
                /account/insights. Path-style aliases redirect to the
                hash form that hashToAccountTab() understands (or to
                public tracking for the retired Orders tab). */}
            <Route path="/account/insights">
              {() => <AccountHashRedirect hash="insights" />}
            </Route>
            <Route path="/account/messages">
              {() => <AccountHashRedirect hash="messages" />}
            </Route>
            {/* Legacy deep link: the retail Orders tab retired with
                cash-pay, but older pushes/emails still carry
                /account/orders or /account/orders/:id. Land them on
                track-order (lookup by ref) rather than a 404. */}
            <Route path="/account/orders">
              {() => <Redirect to="/track-order" />}
            </Route>
            <Route path="/account/orders/:orderId">
              {() => <Redirect to="/track-order" />}
            </Route>
            <Route path="/account" component={GuardedAccount} />
            <Route path="/account/billing" component={GuardedAccountBilling} />
            <Route path="/reminders" component={Reminders} />
            <Route path="/reminders/manage" component={RemindersManage} />
            <Route path="/patient-packet-sign" component={PatientPacketSign} />
            {/* Public token-gated "review & sign" page for
                CSR-created orders (link arrives by SMS/email; token
                rides the query string like /patient-packet-sign). */}
            <Route path="/order-sign" component={OrderSign} />
            {/* Public token-gated telehealth join page (link arrives by
                SMS/email; token rides the query string like
                /patient-packet-sign). */}
            <Route path="/video-visit" component={VideoVisitPage} />
            <Route path="/privacy" component={Privacy} />
            <Route path="/terms" component={Terms} />

            {/* Guarded routes — see GuardedXxx components above. */}
            <Route path="/measure" component={GuardedMeasure} />
            <Route path="/questionnaire" component={GuardedQuestionnaire} />
            <Route path="/results" component={GuardedResults} />
            <Route path="/fit-request" component={GuardedFitRequest} />
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
        {/*
          Breathe marketing/showcase page. Mounted here (not in the
          patient <Layout>) so it renders in its own full-bleed dark
          chrome instead of the storefront header/footer.

          On the platform's OWN home host (cmbreathe.com / the Railway
          fallback) Breathe is ALSO the homepage and the super-admin
          sign-in entry point — its footer links to /platform. On a
          tenant storefront host, `/` stays the patient storefront, so
          the explicit `/` route below falls through to PatientRouter.
          The canonical /breathe URL keeps working on every host.

          Sub-routes are registered BEFORE `/breathe` so a prefix-style
          match can never shadow `/breathe/features`, `/breathe/pricing`,
          etc. (Wouter Switch is first-match-wins.)
        */}
        <Route path="/breathe/features" component={BreatheFeatures} />
        <Route path="/breathe/integrations" component={BreatheIntegrations} />
        <Route path="/breathe/why" component={BreatheLearn} />
        <Route path="/breathe/product" component={BreatheProduct} />
        <Route path="/breathe/compare" component={BreatheCompare} />
        <Route path="/breathe/roi" component={BreatheRoi} />
        <Route path="/breathe/pricing" component={BreathePricing} />
        <Route path="/breathe/security" component={BreatheSecurity} />
        <Route path="/breathe/faq" component={BreatheFaq} />
        <Route path="/breathe/case-studies" component={BreatheCaseStudies} />
        <Route path="/breathe/ai-voice" component={BreatheAiVoice} />
        <Route path="/breathe/get-paid" component={BreatheRevenueCycle} />
        <Route
          path="/breathe/patient-experience"
          component={BreathePatientExperience}
        />
        <Route
          path="/breathe/resupply-engine"
          component={BreatheResupplyEngine}
        />
        <Route
          path="/breathe/communications"
          component={BreatheCommunications}
        />
        <Route path="/breathe/clinical" component={BreatheClinical} />
        <Route path="/breathe/analytics" component={BreatheAnalytics} />
        <Route path="/breathe/compliance" component={BreatheCompliance} />
        <Route path="/breathe/multi-location" component={BreatheLocations} />
        <Route path="/breathe/mask-fitting" component={BreatheMaskFitting} />
        <Route
          path="/breathe/switch/brightree"
          component={BreatheSwitchBrightree}
        />
        <Route
          path="/breathe/switch/bonafide"
          component={BreatheSwitchBonafide}
        />
        <Route
          path="/breathe/switch/sleepglad"
          component={BreatheVsSleepGlad}
        />
        <Route
          path="/breathe/switch/nikohealth"
          component={BreatheSwitchNikohealth}
        />
        <Route path="/breathe/signup" component={BreatheSignup} />
        <Route path="/breathe" component={BreatheHome} />
        <Route path="/">
          {() => (isPlatformHomeHost() ? <BreatheHome /> : <PatientRouter />)}
        </Route>

        <Route path="/sign-in" component={SignInPage} />
        <Route path="/sign-in/*" component={SignInPage} />
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/sign-up/*" component={SignUpPage} />

        {/*
          "Where do I log in?" aliases. `/sign-in` is the canonical patient
          route and `/admin/sign-in` the canonical staff one, but people type
          /login and /signin — and hitting a 404 there is how a sign-in page
          ends up feeling like it doesn't exist. On the platform's OWN host
          (cmbreathe.com) there is no patient storefront, so the only sensible
          destination is the staff/operator sign-in.
        */}
        <Route path="/login">
          <LoginAliasRedirect />
        </Route>
        <Route path="/signin">
          <LoginAliasRedirect />
        </Route>
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
          Legacy cash-pay shop URLs. The catalog/checkout tree is gone;
          keep these forwarding so old links don't 404.
        */}
        <Route path="/shop">
          <LegacyShopRedirect rest="" />
        </Route>
        <Route path="/shop/*">
          {(params) => <LegacyShopRedirect rest={params["*"] ?? ""} />}
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
        {/* Same "what would someone type?" aliases for the staff console. */}
        <Route path="/admin/login">
          <Redirect to="/admin/sign-in" replace />
        </Route>
        <Route path="/admin/signin">
          <Redirect to="/admin/sign-in" replace />
        </Route>
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
          Platform super-admin console (G4). Cross-tenant operator surface
          gated by /resupply-api/platform/me (platform_admins membership).
          Platform admins sign in through the shared /admin/sign-in flow,
          so no separate auth pages are needed here.
        */}
        <Route path="/platform" component={PlatformConsoleRoute} />
        <Route path="/platform/*" component={PlatformConsoleRoute} />

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

import React, { Suspense, lazy, useEffect, useState } from "react";
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

// Eagerly imported pages — small, public, and likely entry points.
// Splitting them out of the initial chunk would only add latency to
// first paint without meaningful payload savings.
import { Home } from "@/pages/home";
import { Shop } from "@/pages/shop";
import { Masks } from "@/pages/masks";
import { HowItWorks } from "@/pages/how-it-works";
import { Faq } from "@/pages/faq";
import { Learn } from "@/pages/learn";
import { Privacy } from "@/pages/privacy";
import { Terms } from "@/pages/terms";
import { Insurance } from "@/pages/insurance";

// Lazy-loaded pages. Each is its own webpack/Rollup chunk so the
// heavy dependencies they pull in (e.g. @mediapipe/tasks-vision in
// /measure, the admin tables in /admin) don't bloat the initial
// patient-shop bundle. The catch-all <Suspense> below shows a tiny
// loading shim while the chunk is in flight.
//
// The named-export -> default-export adapter is needed because each
// page file uses a named export and React.lazy expects a module with
// a default export.
const Consent = lazy(() =>
  import("@/pages/consent").then((m) => ({ default: m.Consent })),
);
const Capture = lazy(() =>
  import("@/pages/capture").then((m) => ({ default: m.Capture })),
);
const Measure = lazy(() =>
  import("@/pages/measure").then((m) => ({ default: m.Measure })),
);
const Questionnaire = lazy(() =>
  import("@/pages/questionnaire").then((m) => ({ default: m.Questionnaire })),
);
const Results = lazy(() =>
  import("@/pages/results").then((m) => ({ default: m.Results })),
);
const Order = lazy(() =>
  import("@/pages/order").then((m) => ({ default: m.Order })),
);
const OrderSuccess = lazy(() =>
  import("@/pages/order-success").then((m) => ({ default: m.OrderSuccess })),
);
const ComfortGuaranteePage = lazy(() =>
  import("@/pages/comfort-guarantee").then((m) => ({
    default: m.ComfortGuaranteePage,
  })),
);
const ReplacementSchedule = lazy(() =>
  import("@/pages/replacement-schedule").then((m) => ({
    default: m.ReplacementSchedule,
  })),
);
const DeviceSetup = lazy(() =>
  import("@/pages/device-setup").then((m) => ({ default: m.DeviceSetup })),
);
const SleepApneaQuiz = lazy(() =>
  import("@/pages/sleep-apnea-quiz").then((m) => ({
    default: m.SleepApneaQuiz,
  })),
);
const ShopCart = lazy(() =>
  import("@/pages/shop-cart").then((m) => ({ default: m.ShopCart })),
);
const ShopProductDetail = lazy(() =>
  import("@/pages/shop-product-detail").then((m) => ({
    default: m.ShopProductDetail,
  })),
);
const ShopCheckoutSuccess = lazy(() =>
  import("@/pages/shop-checkout-success").then((m) => ({
    default: m.ShopCheckoutSuccess,
  })),
);
const ShopCheckoutCancel = lazy(() =>
  import("@/pages/shop-checkout-cancel").then((m) => ({
    default: m.ShopCheckoutCancel,
  })),
);
const ShopOrders = lazy(() =>
  import("@/pages/shop-orders").then((m) => ({ default: m.ShopOrders })),
);
const ShopWishlist = lazy(() =>
  import("@/pages/shop-wishlist").then((m) => ({ default: m.ShopWishlist })),
);
const AccountPage = lazy(() =>
  import("@/pages/account").then((m) => ({ default: m.AccountPage })),
);
const SignInPage = lazy(() =>
  import("@/pages/sign-in").then((m) => ({ default: m.SignInPage })),
);
const SignUpPage = lazy(() =>
  import("@/pages/sign-up").then((m) => ({ default: m.SignUpPage })),
);
const ForgotPasswordPage = lazy(() =>
  import("@/pages/forgot-password").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import("@/pages/reset-password").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const VerifyEmailPage = lazy(() =>
  import("@/pages/verify-email").then((m) => ({
    default: m.VerifyEmailPage,
  })),
);

// Admin auth pages — separate sign-in flow because admins post to
// /resupply-api/auth/* (allowlist-gated) while customers post to
// /api/auth/* (open self-signup). The shared `pf_session` cookie is
// the same, but the entry pages are distinct so a typo in the
// password page can't accidentally promote a customer into the
// console-allowlist check or vice versa.
const AdminSignInPage = lazy(() =>
  import("@/pages/admin/sign-in").then((m) => ({ default: m.SignInPage })),
);
const AdminForgotPasswordPage = lazy(() =>
  import("@/pages/admin/forgot-password").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const AdminResetPasswordPage = lazy(() =>
  import("@/pages/admin/reset-password").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const AdminVerifyEmailPage = lazy(() =>
  import("@/pages/admin/verify-email").then((m) => ({
    default: m.VerifyEmailPage,
  })),
);

// Gated admin console — bundles all 28 admin pages, the AppShell
// chrome, and the generated resupply-api client into a single chunk
// loaded only when a staff user navigates to /admin/*. Keeps the
// patient storefront bundle clean.
const AdminConsoleRoute = lazy(() =>
  import("@/pages/admin/console").then((m) => ({ default: m.ConsoleRoute })),
);

const Reminders = lazy(() =>
  import("@/pages/reminders").then((m) => ({ default: m.Reminders })),
);
const RemindersManage = lazy(() =>
  import("@/pages/reminders-manage").then((m) => ({
    default: m.RemindersManage,
  })),
);

import { FitterProvider, useFitterStore } from "@/hooks/use-fitter-store";

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

const queryClient = new QueryClient();

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
function GuardedMeasure() {
  const { capturedImage } = useFitterStore();
  if (!capturedImage) return <Redirect to="/capture" />;
  return <Measure />;
}
function GuardedQuestionnaire() {
  const { measurements } = useFitterStore();
  if (!measurements) return <Redirect to="/capture" />;
  return <Questionnaire />;
}
function GuardedResults() {
  const { measurements } = useFitterStore();
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
  const { chosenMask } = useFitterStore();
  if (!chosenMask) return <Redirect to="/results" />;
  return <Order />;
}

/**
 * Order-success has its own gating: the order confirmation lives in
 * sessionStorage (so a refresh after order doesn't re-submit) rather
 * than in the in-memory fitter store. We check it here at route-mount
 * time so a deep link to /order-success either renders cleanly or
 * redirects.
 */
function GuardedOrderSuccess() {
  const [state, setState] = useState<"checking" | "ok" | "deny">("checking");
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("fitter_order_confirmation");
      setState(stored ? "ok" : "deny");
    } catch {
      setState("deny");
    }
  }, []);
  if (state === "checking") return null;
  if (state === "deny") return <Redirect to="/" />;
  return <OrderSuccess />;
}

function PatientRouter() {
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
        Single Suspense boundary above the Switch. Wouter swaps the
        active <Route>'s component on navigation; if the new component
        is lazy and not yet loaded, React suspends and we render the
        fallback in place of the page content (header/footer stay).
      */}
      <Suspense fallback={<RouteFallback />}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/consent" component={Consent} />
          <Route path="/capture" component={Capture} />
          <Route path="/masks" component={Masks} />
          <Route path="/how-it-works" component={HowItWorks} />
          <Route path="/faq" component={Faq} />
          <Route path="/learn" component={Learn} />
          <Route
            path="/learn/replacement-schedule"
            component={ReplacementSchedule}
          />
          <Route path="/learn/device-setup" component={DeviceSetup} />
          <Route path="/learn/sleep-apnea-quiz" component={SleepApneaQuiz} />
          <Route path="/comfort-guarantee" component={ComfortGuaranteePage} />
          <Route path="/insurance" component={Insurance} />
          <Route path="/shop" component={Shop} />
          <Route path="/shop/p/:productId">
            {(params) => <ShopProductDetail productId={params.productId} />}
          </Route>
          <Route path="/shop/cart" component={ShopCart} />
          <Route
            path="/shop/checkout-success"
            component={ShopCheckoutSuccess}
          />
          <Route path="/shop/checkout-cancel" component={ShopCheckoutCancel} />
          <Route path="/shop/orders" component={ShopOrders} />
          <Route path="/shop/wishlist" component={ShopWishlist} />
          <Route path="/account" component={AccountPage} />
          <Route path="/reminders" component={Reminders} />
          <Route path="/reminders/manage" component={RemindersManage} />
          <Route path="/privacy" component={Privacy} />
          <Route path="/terms" component={Terms} />

          {/* Guarded routes — see GuardedXxx components above. */}
          <Route path="/measure" component={GuardedMeasure} />
          <Route path="/questionnaire" component={GuardedQuestionnaire} />
          <Route path="/results" component={GuardedResults} />
          <Route path="/order" component={GuardedOrder} />
          <Route path="/order-success" component={GuardedOrderSuccess} />

          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

/**
 * Top-level <Switch>. We split admin and auth routes OUT of the patient
 * <Layout> so they can render in their own chrome (sign-in centered card,
 * admin sidebar shell). The admin pages mount inside <AdminShell> which
 * does the auth + allowlist gate.
 *
 * Wouter's nested-routing trick: catching `/sign-in/:rest*` lets the auth provider
 * own everything below /sign-in (e.g. /sign-in/factor-one) without us
 * pre-defining each step.
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
        <Route path="/sign-in/:rest*" component={SignInPage} />
        <Route path="/sign-up" component={SignUpPage} />
        <Route path="/sign-up/:rest*" component={SignUpPage} />
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
        <Route path="/resupply/:rest*">
          {(params) => <LegacyResupplyRedirect rest={params["rest*"] ?? ""} />}
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
        <Route path="/admin/:rest*" component={AdminConsoleRoute} />

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
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FitterProvider>
          {/*
            ErrorBoundary wraps the router so any thrown render error in a
            page falls back to a recoverable on-brand screen instead of a
            blank white page.
          */}
          <ErrorBoundary>
            <WouterRouter base={basePath}>
              <TopRouter />
            </WouterRouter>
          </ErrorBoundary>
          <Toaster />
        </FitterProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function App() {
  return <AppInner />;
}

export default App;

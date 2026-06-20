import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "wouter";
import {
  type LucideIcon,
  Activity,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  BrainCircuit,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardSignature,
  Cpu,
  Database,
  FileStack,
  Gauge,
  GitBranch,
  Headphones,
  KeyRound,
  LineChart,
  Lock,
  Mail,
  Menu,
  MessageSquare,
  Mic,
  Minus,
  Network,
  PhoneCall,
  Plug,
  Quote,
  Radio,
  Receipt,
  RefreshCw,
  ScanFace,
  Server,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Store,
  TrendingUp,
  Users,
  Video,
  Waypoints,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useNoIndexExceptApex } from "@/hooks/use-noindex-except-apex";
import { ADDON_DETAILS } from "@/lib/admin/addon-details";
import "./breathe.css";

// Icon-only crop of the CareMetric app icon. The full lockup PNG
// (`caremetric-logo.png`) bakes a "CareMetric AI" wordmark UNDER the icon;
// squished into the small square brand slots it turned illegible and
// collided with the "Breathe" text we render beside it. Every on-page
// lockup pairs this square icon with separately-set brand text, so the
// wordmark version is never the right asset here.
const LOGO = "/breathe/caremetric-icon.png";

/**
 * Breathe — the public marketing / showcase homepage for the DME
 * operating platform built by CareMetric.ai.
 *
 * This is a self-contained surface: it renders OUTSIDE the patient
 * storefront <Layout> (mounted directly in TopRouter) with its own dark
 * "command center" chrome, and every style lives in the namespaced
 * `breathe.css` so nothing here can clobber the storefront/admin token
 * systems. Lazy-loaded, so its CSS + this component never weigh on the
 * patient-shop initial bundle.
 *
 * Art direction (2026 rebuild): editorial-meets-command-center. A
 * distinctive optical serif (Fraunces) carries the display voice over a
 * refined grotesque (Hanken) body, on the brand's deep-navy luminance —
 * a look no legacy DME vendor has. Both fonts are SELF-HOSTED woff2 in
 * /public/fonts so the page stays same-origin (the app's CSP forbids
 * third-party font CDNs).
 */
/**
 * Shared chrome for every Breathe marketing page — the dark page shell,
 * sticky nav, footer, and the reveal / no-index / smooth-scroll effects.
 * The story used to live on one very long single-scroll page; it is now
 * split into nav-aligned routes (Product, Compare, ROI, Pricing, Security)
 * so each page stays short and focused. Every page renders its own slice of
 * sections inside this shell.
 */
export function BreatheShell({ children }: { children: React.ReactNode }) {
  useRevealOnScroll();
  useNoIndexExceptApex();
  useSmoothScroll();
  useInitialHashScroll();

  return (
    <div className="breathe-page">
      <div className="bx-grain" aria-hidden="true" />
      <DemoGateProvider>
        <Nav />
        <main>{children}</main>
        <Footer />
      </DemoGateProvider>
    </div>
  );
}

/**
 * Compact header for the inner pages: eyebrow, H1, and a lede — so each
 * split-out page has its own title and context instead of opening cold on
 * a content section.
 */
export function PageHead({
  icon: Icon,
  eyebrow,
  title,
  sub,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: React.ReactNode;
  sub: string;
}) {
  return (
    <header className="bx-section bx-pagehead" id="top">
      <div className="bx-shell">
        <span className="bx-eyebrow bx-reveal in">
          <Icon size={13} />
          {eyebrow}
        </span>
        <h1 className="bx-pagehead-title bx-reveal in">{title}</h1>
        <p className="bx-pagehead-sub bx-reveal in">{sub}</p>
      </div>
    </header>
  );
}

/* ───────────────────── Self-serve demo gate ───────────────────── */
// Where the email gate sends a visitor: the admin "command center" demo.
// `?demo=1` is read by ./demo/boot at load, which flips on the CLIENT-ONLY
// sandbox — every API call is answered from in-browser fixtures, so there
// is no real patient data and no integration ever runs.
const DEMO_ENTRY_URL = "/admin?demo=1";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type DemoGateContextValue = {
  /** Open the email→self-serve-demo gate (lands the visitor in the console). */
  open: (source?: string) => void;
  /** Open the "talk to us" contact gate (a human follows up — no console). */
  openContact: (source?: string) => void;
};
const DemoGateContext = React.createContext<DemoGateContextValue | null>(null);

/** Open the demo / contact gates from any CTA. */
export function useDemoGate(): DemoGateContextValue {
  const ctx = useContext(DemoGateContext);
  if (!ctx) throw new Error("useDemoGate must be used within DemoGateProvider");
  return ctx;
}

function DemoGateProvider({ children }: { children: React.ReactNode }) {
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [contactSource, setContactSource] = useState<string | null>(null);
  // The two gates are mutually exclusive — opening one always closes the
  // other so there's never a second backdrop / focus-trap / scroll-lock
  // active at the same time.
  const open = useCallback((source?: string) => {
    setContactSource(null);
    setOpenSource(source ?? "breathe");
  }, []);
  const openContact = useCallback((source?: string) => {
    setOpenSource(null);
    setContactSource(source ?? "breathe-contact");
  }, []);
  const value = useMemo(() => ({ open, openContact }), [open, openContact]);
  return (
    <DemoGateContext.Provider value={value}>
      {children}
      {openSource !== null ? (
        <DemoGateModal
          source={openSource}
          onClose={() => setOpenSource(null)}
        />
      ) : null}
      {contactSource !== null ? (
        <ContactGateModal
          source={contactSource}
          onClose={() => setContactSource(null)}
        />
      ) : null}
    </DemoGateContext.Provider>
  );
}

/**
 * Saves the volunteered email to the marketing list (best-effort — a
 * failure must never block demo entry) and then hard-navigates into the
 * client-side demo sandbox.
 */
async function captureLead(
  email: string,
  source: string,
  honeypot: string,
): Promise<void> {
  try {
    await fetch("/api/demo-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        source,
        website: honeypot || undefined,
      }),
    });
  } catch {
    /* best-effort: never block the visitor on a capture failure */
  }
}

async function enterDemoWithEmail(
  email: string,
  source: string,
  honeypot: string,
): Promise<void> {
  await captureLead(email, source, honeypot);
  window.location.href = DEMO_ENTRY_URL;
}

/** The email input + submit, reused inline (closing CTA) and in the modal. */
function DemoEmailForm({
  source,
  autoFocus,
  cta = "Start the demo",
}: {
  source: string;
  autoFocus?: boolean;
  cta?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [err, setErr] = useState("");
  const hpRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) emailRef.current?.focus();
  }, [autoFocus]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setErr("Please enter a valid email address.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setErr("");
    await enterDemoWithEmail(value, source, hpRef.current?.value ?? "");
    // Navigation is in flight; keep the button disabled until unload.
  };

  return (
    <form className="bx-demoform" onSubmit={onSubmit} noValidate>
      {/* Honeypot: real users never see or fill this. */}
      <input
        ref={hpRef}
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="bx-hp"
      />
      <div className="bx-demoform-row">
        <input
          ref={emailRef}
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          placeholder="you@yourdme.com"
          aria-label="Work email"
          aria-invalid={status === "error"}
        />
        <button
          type="submit"
          className="bx-btn bx-btn-primary"
          disabled={status === "submitting"}
        >
          {status === "submitting" ? (
            "Starting…"
          ) : (
            <>
              {cta} <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
      {status === "error" ? (
        <span className="bx-demoform-err" role="alert">
          {err}
        </span>
      ) : null}
    </form>
  );
}

/**
 * Modal a11y plumbing shared by every Breathe gate modal: Esc to close,
 * body scroll-lock, a focus trap (keyboard users can't tab out to the page
 * behind), and focus restored to the trigger on close. Returns the ref to
 * spread onto the dialog element.
 */
function useModalDismiss(onClose: () => void) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !modalRef.current) return;
      const focusables = modalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocused?.focus?.();
    };
  }, [onClose]);
  return modalRef;
}

function DemoGateModal({
  source,
  onClose,
}: {
  source: string;
  onClose: () => void;
}) {
  const modalRef = useModalDismiss(onClose);

  return (
    <div className="bx-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={modalRef}
        className="bx-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bx-demo-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="bx-modal-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="bx-modal-ic">
          <Sparkles size={20} />
        </span>
        <h3 id="bx-demo-modal-title">Start the live demo</h3>
        <p className="bx-modal-lede">
          Enter your email and you&apos;ll land straight in the Breathe console,
          running on sample data — no call, no credit card, and no real patient
          information.
        </p>
        <DemoEmailForm source={source} autoFocus cta="Enter the demo" />
        <p className="bx-modal-fine">
          By continuing you agree to receive occasional product emails. You can
          unsubscribe anytime.
        </p>
        <div className="bx-modal-alt">
          Ready to commit?{" "}
          <Link href="/breathe/signup" onClick={onClose}>
            Create your account →
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Email-only contact capture for the "talk to us" gate. Mirrors
 * DemoEmailForm's validation + honeypot, but instead of navigating into
 * the demo it captures the lead (best-effort) and hands control back to
 * the modal to show a confirmation — the human follow-up happens off-app.
 */
function ContactEmailForm({
  source,
  onDone,
}: {
  source: string;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [err, setErr] = useState("");
  const hpRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setErr("Please enter a valid email address.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setErr("");
    await captureLead(value, source, hpRef.current?.value ?? "");
    onDone();
  };

  return (
    <form className="bx-demoform" onSubmit={onSubmit} noValidate>
      {/* Honeypot: real users never see or fill this. */}
      <input
        ref={hpRef}
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="bx-hp"
      />
      <div className="bx-demoform-row">
        <input
          ref={emailRef}
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          placeholder="you@yourdme.com"
          aria-label="Work email"
          aria-invalid={status === "error"}
        />
        <button
          type="submit"
          className="bx-btn bx-btn-primary"
          disabled={status === "submitting"}
        >
          {status === "submitting" ? (
            "Sending…"
          ) : (
            <>
              Send to support <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
      {status === "error" ? (
        <span className="bx-demoform-err" role="alert">
          {err}
        </span>
      ) : null}
    </form>
  );
}

/**
 * "Talk to us" gate — the human path that sits beside the self-serve demo.
 * Captures an email for follow-up (tagged with its own source) and always
 * surfaces the phone + email so an enterprise buyer who wants a real
 * conversation has one. On submit it confirms in-place rather than
 * navigating, then nudges toward the live demo for the impatient.
 */
function ContactGateModal({
  source,
  onClose,
}: {
  source: string;
  onClose: () => void;
}) {
  const modalRef = useModalDismiss(onClose);
  const { open: openDemoGate } = useDemoGate();
  const [submitted, setSubmitted] = useState(false);

  return (
    <div className="bx-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={modalRef}
        className="bx-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bx-contact-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="bx-modal-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        {submitted ? (
          <>
            <span className="bx-modal-ic">
              <Check size={20} />
            </span>
            <h3 id="bx-contact-modal-title">
              Thanks — we&apos;ll be in touch.
            </h3>
            <p className="bx-modal-lede">
              Our support team will get back to you within one business day.
              Prefer to talk now? We&apos;re here.
            </p>
            <div className="bx-modal-contact">
              <a href="tel:+18775212890">
                <PhoneCall size={14} aria-hidden="true" /> (877) 521-2890
              </a>
              <a href="mailto:info@cmbreathe.com">
                <Mail size={14} aria-hidden="true" /> info@cmbreathe.com
              </a>
            </div>
            <div className="bx-modal-alt">
              Don&apos;t want to wait?{" "}
              <button
                type="button"
                className="bx-linkbtn"
                onClick={() => {
                  onClose();
                  openDemoGate("breathe-contact-to-demo");
                }}
              >
                Jump into the live demo →
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="bx-modal-ic">
              <Headphones size={20} />
            </span>
            <h3 id="bx-contact-modal-title">
              Questions? We&apos;re here to help
            </h3>
            <p className="bx-modal-lede">
              Have a question, a concern, or need technical support? Leave your
              email and our support team will get back to you — or call us right
              now. Ready to go? You can start the demo or create your account
              yourself, no call required.
            </p>
            <ContactEmailForm
              source={source}
              onDone={() => setSubmitted(true)}
            />
            <div className="bx-modal-contact">
              <a href="tel:+18775212890">
                <PhoneCall size={14} aria-hidden="true" /> (877) 521-2890
              </a>
              <a href="mailto:info@cmbreathe.com">
                <Mail size={14} aria-hidden="true" /> info@cmbreathe.com
              </a>
            </div>
            <p className="bx-modal-fine">
              No sales pressure — just real help when you need it. Unsubscribe
              anytime.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* Create-your-account — self-serve tenant signup. */
export function BreatheSignup() {
  useDocumentTitle(
    "Create your account — Breathe by CareMetric.ai",
    "Spin up your own Breathe workspace and admin login in minutes. No credit card — choose a plan in-app whenever you're ready.",
  );
  return (
    <BreatheShell>
      <SignupSection />
    </BreatheShell>
  );
}

// Cloudflare Turnstile — optional. The widget only renders (and a token
// is then required) when VITE_TURNSTILE_SITE_KEY is configured; otherwise
// the backend skips verification too (fail-soft, server + client agree).
const TURNSTILE_SITE_KEY = (
  import.meta.env as Record<string, string | undefined>
).VITE_TURNSTILE_SITE_KEY;

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
function getTurnstile(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

/** Renders a Turnstile widget when a site key is set; yields its token. */
function useTurnstile() {
  const ref = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let widgetId: string | undefined;
    let cancelled = false;
    const render = () => {
      const ts = getTurnstile();
      if (cancelled || !ts || !ref.current || ref.current.childElementCount > 0)
        return;
      widgetId = ts.render(ref.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (t: string) => setToken(t),
        "error-callback": () => setToken(""),
        "expired-callback": () => setToken(""),
      });
    };
    if (getTurnstile()) {
      render();
    } else {
      const id = "cf-turnstile-script";
      let script = document.getElementById(id) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement("script");
        script.id = id;
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
    }
    return () => {
      cancelled = true;
      const ts = getTurnstile();
      if (ts && widgetId !== undefined) {
        try {
          ts.remove(widgetId);
        } catch {
          /* widget already removed */
        }
      }
    };
  }, []);
  return { ref, token, enabled: Boolean(TURNSTILE_SITE_KEY) };
}

function SignupSection() {
  const { open: openDemoGate } = useDemoGate();
  const turnstile = useTurnstile();
  const [org, setOrg] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "done" | "error"
  >("idle");
  const [err, setErr] = useState("");
  const [signInUrl, setSignInUrl] = useState("/admin/sign-in");
  const hpRef = useRef<HTMLInputElement>(null);

  const clearError = () => {
    if (status === "error") setStatus("idle");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (org.trim().length < 2) {
      setErr("Tell us your company name.");
      setStatus("error");
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setErr("Please enter a valid work email.");
      setStatus("error");
      return;
    }
    if (password.length < 12) {
      setErr("Use a password of at least 12 characters.");
      setStatus("error");
      return;
    }
    if (turnstile.enabled && !turnstile.token) {
      setErr("Please complete the verification below.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setErr("");
    try {
      const resp = await fetch("/api/tenant-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgName: org.trim(),
          email: email.trim(),
          password,
          captchaToken: turnstile.token || undefined,
          website: hpRef.current?.value || undefined,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        signInUrl?: string;
        error?: string;
      };
      if (resp.ok) {
        setSignInUrl(data.signInUrl || "/admin/sign-in");
        setStatus("done");
        return;
      }
      setErr(data.error || "Something went wrong. Please try again.");
      setStatus("error");
    } catch {
      setErr("Network error. Please check your connection and try again.");
      setStatus("error");
    }
  };

  if (status === "done") {
    return (
      <section className="bx-section bx-pagehead" id="top">
        <div className="bx-shell bx-signup-shell">
          <div className="bx-signup bx-reveal in">
            <span className="bx-signup-ic">
              <Check size={24} />
            </span>
            <h1 className="bx-pagehead-title">Check your email.</h1>
            <p className="bx-pagehead-sub">
              We sent a verification link to <b>{email.trim()}</b>. Click it to
              activate your account, then sign in to your new Breathe workspace.
            </p>
            <a className="bx-btn bx-btn-primary" href={signInUrl}>
              Go to sign in <ArrowRight size={16} />
            </a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="bx-section bx-pagehead" id="top">
      <div className="bx-shell bx-signup-shell">
        <div className="bx-signup bx-reveal in">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> Create your account
          </span>
          <h1 className="bx-pagehead-title">
            Your own Breathe, in <span className="grad-em">minutes.</span>
          </h1>
          <p className="bx-pagehead-sub">
            Spin up your workspace and your admin login. No credit card — pick a
            plan in-app whenever you&apos;re ready.
          </p>
          <form className="bx-signup-form" onSubmit={onSubmit} noValidate>
            <input
              ref={hpRef}
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="bx-hp"
            />
            <label className="bx-field-label">
              Company name
              <input
                type="text"
                value={org}
                onChange={(e) => {
                  setOrg(e.target.value);
                  clearError();
                }}
                placeholder="Acme Home Medical"
                autoComplete="organization"
                required
              />
            </label>
            <label className="bx-field-label">
              Work email
              <input
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError();
                }}
                placeholder="you@yourdme.com"
                autoComplete="email"
                required
              />
            </label>
            <label className="bx-field-label">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearError();
                }}
                placeholder="At least 12 characters"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            {turnstile.enabled ? (
              <div ref={turnstile.ref} className="bx-turnstile" />
            ) : null}
            {status === "error" ? (
              <p className="bx-demoform-err" role="alert">
                {err}
              </p>
            ) : null}
            <button
              type="submit"
              className="bx-btn bx-btn-primary"
              disabled={status === "submitting"}
            >
              {status === "submitting" ? (
                "Creating your workspace…"
              ) : (
                <>
                  Create account <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
          <p className="bx-signup-alt">
            Prefer to look around first?{" "}
            <button
              type="button"
              className="bx-linkbtn"
              onClick={() => openDemoGate("breathe-signup")}
            >
              Start the free demo
            </button>
          </p>
        </div>
      </div>
    </section>
  );
}

/* Landing — the elevator pitch: hero, integrations, what it replaces, CTA. */
export function BreatheHome() {
  useDocumentTitle(
    "Breathe — All-in-One CPAP & DME Software by CareMetric.ai",
    "Breathe is the all-in-one platform for CPAP & DME providers: automate resupply reordering, scrub claims clean before they're filed, sync therapy compliance from ResMed, Philips & 3B, and e-sign documentation — so you capture more revenue, cut denials, and keep patients on therapy.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <Hero />
      {/* Show the actual product on the landing page — not just the product
          tour. The hero sells the outcome; this proves the product is real
          with REAL captured screens of the live console (competitors all lead
          with product UI; we used to lead with an abstract graphic). */}
      <LiveConsole />
      <IntegrationsStrip />
      <Pillars />
      {/* The home page is deliberately short and focused on WHY Breathe is
          different: the proprietary resupply engine, the in-house (not
          bolted-on) architecture, and "one login instead of seven". The
          deeper detail — the full lifecycle, the capability grid, the unified
          therapy fleet, and the audience breakdown — lives on the Product,
          Compare, and Integrations pages so this page stays scannable. */}
      <ResupplyEngine />
      <BuiltInHouse />
      <Replaces />
      <Outcomes />
      <PricingHome />
      <FoundingPartner />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Product tour — how the platform runs the whole DME lifecycle. */
export function BreatheProduct() {
  useDocumentTitle(
    "Product tour — Breathe by CareMetric.ai",
    "See how Breathe runs the entire DME lifecycle in one system: intake, the resupply engine, revenue cycle, clinical monitoring, and the AI voice agent.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Workflow}
        eyebrow="Product tour"
        title={
          <>
            One platform for the{" "}
            <span className="grad-em">whole lifecycle.</span>
          </>
        }
        sub="From the first intake call to the last reconciled claim — see the console, the automations, and the AI that run a modern DME business."
      />
      <Lifecycle />
      <DayInLife />
      <Capabilities />
      <ProductShowcase />
      <Features />
      <FeatureVideos />
      <UnifiedFleet />
      <BuiltInHouse />
      <RevenueCycle />
      <AiBento />
      <Outcomes showClaimsEngine={false} />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Compare — how Breathe stacks up against legacy DME software, by role. */
export function BreatheCompare() {
  useDocumentTitle(
    "How Breathe compares — Breathe by CareMetric.ai",
    "How Breathe compares to legacy DME software, and how much time it gives back to every role on your team.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={BrainCircuit}
        eyebrow="Compare"
        title={
          <>
            Built AI-native, <span className="grad-em">not bolted on.</span>
          </>
        }
        sub="Legacy DME systems bolt modules onto decades-old cores. See the line-by-line difference — and what it means for each person on your team."
      />
      <Comparison />
      <SwitchLinks />
      <WhyDifferent />
      <BuiltInHouse />
      <Roles />
      <Audiences />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Cross-links to the per-competitor "Switch from X" migration pages, shown
   under the comparison table where switch intent is highest. */
const SWITCH_LINKS: { href: string; name: string }[] = [
  { href: "/breathe/switch/brightree", name: "Brightree" },
  { href: "/breathe/switch/bonafide", name: "Bonafide" },
  { href: "/breathe/switch/nikohealth", name: "NikoHealth" },
];

function SwitchLinks() {
  return (
    <div className="bx-shell">
      <div className="bx-switchlinks bx-reveal">
        <span className="bx-switchlinks-label">
          <GitBranch size={15} /> Coming from a specific system?
        </span>
        <div className="bx-switchlinks-row">
          {SWITCH_LINKS.map((s) => (
            <Link className="bx-switchlink" href={s.href} key={s.href}>
              Switch from {s.name} <ArrowRight size={14} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ROI — the interactive calculator. */
export function BreatheRoi() {
  useDocumentTitle(
    "ROI calculator — Breathe by CareMetric.ai",
    "Estimate what Breathe is worth to your DME business: staff time recovered, revenue-cycle recovery, resupply growth, and the point tools it replaces.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={LineChart}
        eyebrow="ROI"
        title={
          <>
            Size the <span className="grad-em">return.</span>
          </>
        }
        sub="Estimate what Breathe gives back on your own numbers — staff hours, revenue-cycle recovery, resupply growth, and the seven point tools you stop paying for."
      />
      <Roi />
      <RoiAssumptions />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Pricing — how it's priced, and how migration works. */
export function BreathePricing() {
  useDocumentTitle(
    "Pricing — Breathe by CareMetric.ai",
    "One platform, one price. How Breathe is priced, and how a guided migration gets your DME business live in weeks.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={CircleDollarSign}
        eyebrow="Pricing"
        title={
          <>
            Priced like <span className="grad-em">one platform.</span>
          </>
        }
        sub="No per-module upsells, no surprise line items — and a guided migration that gets you live in weeks, not quarters."
      />
      <Pricing />
      <Onboarding />
      <PricingFaq />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Security — posture, the why behind it, and the FAQ. */
export function BreatheSecurity() {
  useDocumentTitle(
    "Security — Breathe by CareMetric.ai",
    "Breathe's security posture: HIPAA-eligible infrastructure, on-device patient imaging, and the principles behind the platform.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={ShieldCheck}
        eyebrow="Security"
        title={
          <>
            Patient trust, <span className="grad-em">engineered in.</span>
          </>
        }
        sub="HIPAA-eligible infrastructure, on-device patient imaging, and a least-privilege posture — the questions your compliance team will ask, answered."
      />
      <Security />
      <SecurityPosture />
      <Manifesto />
      <Faq />
      <ClosingCta />
    </BreatheShell>
  );
}

/* ───────────────────────── Nav ───────────────────────── */
const NAV_LINKS: { href: string; label: string }[] = [
  { href: "/breathe/product", label: "Platform" },
  { href: "/breathe/integrations", label: "Integrations" },
  { href: "/breathe/why", label: "Why Breathe" },
  { href: "/breathe/compare", label: "Compare" },
  { href: "/breathe/case-studies", label: "Case studies" },
  { href: "/breathe/pricing", label: "Pricing" },
];

// The full set of marketing pages — used by the footer so ROI, Security,
// and Features stay reachable + crawlable even though they're kept out of
// the (deliberately short) top nav.
const FOOTER_LINKS: { href: string; label: string }[] = [
  { href: "/breathe/product", label: "Platform" },
  { href: "/breathe/integrations", label: "Integrations" },
  { href: "/breathe/why", label: "Why Breathe" },
  { href: "/breathe/compare", label: "Compare" },
  { href: "/breathe/features", label: "Features" },
  { href: "/breathe/roi", label: "ROI" },
  { href: "/breathe/pricing", label: "Pricing" },
  { href: "/breathe/security", label: "Security" },
  { href: "/breathe/case-studies", label: "Case studies" },
  { href: "/breathe/faq", label: "FAQ" },
];

function Nav() {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const { open: openDemoGate } = useDemoGate();
  // Close the mobile menu on any route change so it never lingers open.
  useEffect(() => {
    setOpen(false);
  }, [loc]);
  return (
    <nav className="bx-nav">
      <div className="bx-shell bx-nav-inner">
        <Link className="bx-brand" href="/breathe">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </Link>
        <div className="bx-nav-links">
          {NAV_LINKS.map((l) => (
            <Link
              className={"bx-nav-anchor" + (loc === l.href ? " is-active" : "")}
              href={l.href}
              key={l.href}
            >
              {l.label}
            </Link>
          ))}
          <Link
            className="bx-btn bx-btn-ghost bx-btn-sm"
            href="/breathe/signup"
          >
            Create account
          </Link>
          <button
            type="button"
            className="bx-btn bx-btn-primary bx-btn-sm"
            onClick={() => openDemoGate("breathe-nav")}
          >
            Start free demo
          </button>
        </div>
        <button
          type="button"
          className="bx-nav-toggle"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="bx-nav-mobile"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open ? (
        <div className="bx-nav-mobile" id="bx-nav-mobile">
          <div className="bx-shell bx-nav-mobile-inner">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={
                  "bx-nav-mobile-link" + (loc === l.href ? " is-active" : "")
                }
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <button
              type="button"
              className="bx-btn bx-btn-primary bx-nav-mobile-demo"
              onClick={() => {
                setOpen(false);
                openDemoGate("breathe-nav");
              }}
            >
              Start free demo
            </button>
            <Link
              href="/breathe/signup"
              className="bx-btn bx-btn-ghost bx-nav-mobile-demo"
              onClick={() => setOpen(false)}
            >
              Create account
            </Link>
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/* ───────────────────────── Hero ───────────────────────── */
function Hero() {
  const { open: openDemoGate, openContact } = useDemoGate();
  const onMove = (e: React.MouseEvent<HTMLElement>) => {
    if (prefersReducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const py = ((e.clientY - r.top) / r.height - 0.5) * 2;
    e.currentTarget.style.setProperty("--px", px.toFixed(3));
    e.currentTarget.style.setProperty("--py", py.toFixed(3));
  };
  const onLeave = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty("--px", "0");
    e.currentTarget.style.setProperty("--py", "0");
  };
  return (
    <header
      className="bx-section bx-hero"
      id="top"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <div className="bx-shell">
        <div className="bx-hero-grid">
          <div className="bx-hero-copy">
            <span className="bx-eyebrow bx-reveal in">
              <span className="bx-dot" />
              All-in-one software for CPAP &amp; DME
            </span>
            <h1 className="bx-h1 bx-reveal in">
              Capture every resupply.
              <br />
              <span className="grad-em">Get paid the first time.</span>
            </h1>
            <p className="bx-hero-sub bx-reveal in">
              Breathe is the all-in-one platform for CPAP &amp; DME providers.
              It automates the resupply reordering that eats your staff&apos;s
              day, scrubs every claim clean before it&apos;s filed, and syncs
              live compliance data straight from ResMed, Philips &amp; 3B — so
              you book more orders, deny fewer claims, and keep patients on
              therapy.
            </p>
            <div className="bx-hero-cta bx-reveal in">
              <button
                type="button"
                className="bx-btn bx-btn-primary"
                onClick={() => openDemoGate("breathe-hero")}
              >
                Start the free demo <ArrowRight size={17} />
              </button>
              <Link className="bx-btn bx-btn-ghost" href="/breathe/roi">
                See what you&apos;d save
              </Link>
            </div>
            <div className="bx-hero-trust bx-reveal in">
              <BadgeCheck size={15} color="#54c8ff" />
              Live demo on sample data · No call · No credit card
            </div>
            <p className="bx-hero-talk bx-reveal in">
              Questions, or need a hand getting set up?{" "}
              <button
                type="button"
                className="bx-linkbtn"
                onClick={() => openContact("breathe-hero")}
              >
                Contact support →
              </button>
            </p>
          </div>

          <div className="bx-orb-wrap bx-reveal in">
            <div className="bx-orb-aura" aria-hidden="true" />
            <div className="bx-orb">
              <div className="bx-orb-ring r3" />
              <div className="bx-orb-ring r2" />
              <div className="bx-orb-ring" />
              <div className="bx-orb-core">
                <img className="bx-orb-logo" src={LOGO} alt="CareMetric AI" />
              </div>
              <div className="bx-orb-chip c1">
                <span className="ico">
                  <Mic size={15} />
                </span>
                AI voice agent · live
              </div>
              <div className="bx-orb-chip c2">
                <span className="ico">
                  <Receipt size={15} />
                </span>
                Claim auto-submitted
              </div>
              <div className="bx-orb-chip c3">
                <span className="ico gold">
                  <RefreshCw size={15} />
                </span>
                Resupply reorder placed
              </div>
            </div>
          </div>
        </div>

        <StatBand />
      </div>
    </header>
  );
}

const STATS: { num: number; suffix: string; prefix?: string; label: string }[] =
  [
    { num: 7, suffix: "", label: "point tools replaced by one platform" },
    { num: 38, suffix: "%", label: "less time per resupply order" },
    { num: 22, suffix: "%", label: "lift in first-pass claim acceptance" },
    { num: 9, suffix: "+ hrs", label: "saved per staff member each week" },
  ];

function StatBand() {
  return (
    <>
      <div className="bx-stats bx-reveal">
        {STATS.map((s) => (
          <div className="bx-stat" key={s.label}>
            <div className="bx-stat-num">
              <CountUp to={s.num} prefix={s.prefix} suffix={s.suffix} />
            </div>
            <div className="bx-stat-label">{s.label}</div>
          </div>
        ))}
      </div>
      {/* Honest framing: these are modeled / benchmark figures, not a
          claim of measured customer results. Tie them to the calculator
          that shows the math on the reader's own numbers. */}
      <p className="bx-stats-note bx-reveal">
        Modeled on typical DME resupply economics and published industry
        benchmarks — directional, not a guarantee.{" "}
        <Link href="/breathe/roi">Size it on your own numbers →</Link>
      </p>
    </>
  );
}

/* ───────────────────── Integrations strip ───────────────────── */
const INTEGRATIONS = [
  "ResMed AirView",
  "Philips Care Orchestrator",
  "3B React Health",
  "Office Ally",
  "DaVinci PAS",
  "PacWare",
  "Stripe",
  "Twilio",
  "SendGrid",
];

function IntegrationsStrip() {
  return (
    <section className="bx-integrations bx-reveal" aria-label="Integrations">
      <div className="bx-shell bx-integrations-head">
        <p className="bx-integrations-label">
          <Plug size={13} /> Connected to the device clouds, clearinghouses, and
          billing systems you already run
        </p>
        <Link className="bx-integrations-link" href="/breathe/integrations">
          See how it connects <ArrowRight size={14} />
        </Link>
        {/* The marquee duplicates the list for the animation, so it is
            aria-hidden; this visually-hidden list exposes the partner
            names to assistive tech exactly once. */}
        <ul className="bx-sr-only">
          {INTEGRATIONS.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
      <div className="bx-marquee" aria-hidden="true">
        <div className="bx-marquee-track">
          {[...INTEGRATIONS, ...INTEGRATIONS].map((name, i) => (
            <span className="bx-marquee-item" key={`${name}-${i}`}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Value pillars ───────────────────────── */
/*
 * The home page's concrete "what it does, and what it's worth" band — placed
 * directly under the hero so a DME owner sees the four revenue/operational
 * wins (resupply, billing, compliance, documentation) before scrolling into
 * the deeper story. Each pillar pairs an outcome metric with the mechanism
 * behind it; the numbers mirror the benchmark-sourced figures in <Outcomes/>
 * lower on the page and are framed as industry ranges, not guarantees.
 */
const PILLARS: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <RefreshCw size={22} />,
    metric: "2.5×",
    metricSub: "more resupply orders",
    title: "CPAP resupply that runs itself",
    body: "Eligibility-aware reminders go out by text, email, and voice on the right 90-day cadence — and a 24/7 AI agent books the reorders behind them, even after hours. Your team works the exceptions instead of the phone tree, and no replacement window slips.",
  },
  {
    icon: <Receipt size={22} />,
    metric: "94%",
    metricSub: "first-pass clean claims",
    title: "Claims that get paid the first time",
    gold: true,
    body: "AI scrubs every 837P before it leaves the building — eligibility, modifiers, documentation — then auto-submits and posts the ERA back automatically. Most DME denials are preventable rework at ~$118 each; Breathe catches them before the claim is ever filed.",
  },
  {
    icon: <Stethoscope size={22} />,
    metric: "85%",
    metricSub: "therapy compliance",
    title: "Higher compliance, better outcomes",
    body: "Live adherence from ResMed, Philips, and 3B is pulled in nightly and ranked, so at-risk patients surface before they quit. Hit the Medicare 4-hour rule, document the 90-day window automatically, and keep every compliant patient supplied.",
  },
  {
    icon: <ClipboardSignature size={22} />,
    metric: "Minutes",
    metricSub: "to a signed order",
    title: "Documents signed, not stalled",
    body: "Written orders, CMNs, prior auths, and proof of delivery draft from the patient's own data and route for e-signature in a tap — signed and on file before delivery. Missing documentation is the #1 reason DME claims stall; Breathe closes that gap before it costs you.",
  },
];

function Pillars() {
  return (
    <section className="bx-section" id="what-it-does">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> What Breathe does
          </span>
          <h2 className="bx-h2">
            The work that runs a CPAP business — automated
          </h2>
          <p className="bx-lede">
            From the 90-day reorder reminder to the paid claim, Breathe handles
            the repetitive, revenue-critical work end to end — so you grow
            resupply, deny fewer claims, and keep patients on therapy without
            adding staff.
          </p>
        </div>
        <div className="bx-pillars">
          {PILLARS.map((p) => (
            <article
              className={`bx-pillar bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-pillar-top">
                <span className="bx-pillar-ic">{p.icon}</span>
                <span className="bx-pillar-metric">
                  <b>{p.metric}</b>
                  <small>{p.metricSub}</small>
                </span>
              </div>
              <h3 className="bx-pillar-title">{p.title}</h3>
              <p className="bx-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────── Proprietary resupply engine ─────────────────── */
/*
 * The revenue centerpiece: a dedicated band that explains HOW Breathe grows
 * resupply — the proprietary, behavioral-science-based reasoning engine that
 * gets patients to reorder across text, email, and an AI phone call with
 * almost no staff time. Placed right under the value pillars because, for a
 * DME, this is the single clearest line from "software" to "more revenue".
 * Reuses the existing .bx-pillar grid so it needs no new CSS.
 */
const ENGINE_STEPS: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <BrainCircuit size={22} />,
    metric: "AI",
    metricSub: "reasoning",
    title: "It reasons — it doesn't just remind",
    body: "Grounded in the behavioral science of timing, habit, and friction, the engine reasons about each patient: who's due, the right moment to reach them, the right channel, and how gently or firmly to ask. Every patient gets the nudge most likely to turn into an order — not a generic blast.",
    gold: true,
  },
  {
    icon: <Waypoints size={22} />,
    metric: "3",
    metricSub: "channels, escalating",
    title: "Text → email → AI phone call",
    body: "A friendly text first, then a follow-up email, then — if they still haven't ordered — a natural-sounding AI voice call that talks them through it. Each touch is worded with a little more urgency, and an unanswered call retries before anyone on your team is ever involved.",
  },
  {
    icon: <Zap size={22} />,
    metric: "1-tap",
    metricSub: "to reorder",
    title: "Reordering takes one tap",
    body: "Reply YES to a text, tap a secure link in the email, or just say “yes” on the call. No login, no forms, no portal — the order ships to the address on file. Making it effortless is the whole point: the easier it is to say yes, the more patients do.",
  },
  {
    icon: <TrendingUp size={22} />,
    metric: "~0",
    metricSub: "human touch",
    title: "Recurring revenue, on autopilot",
    body: "Every refill window that would have quietly slipped becomes a placed order — captured automatically, around the clock. Your team only ever sees the rare exception, so resupply revenue grows without adding headcount or hours on the phone.",
  },
];

function ResupplyEngine() {
  return (
    <section className="bx-section" id="resupply-engine">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The resupply engine
          </span>
          <h2 className="bx-h2">
            A proprietary engine that turns refills into revenue
          </h2>
          <p className="bx-lede">
            Breathe's resupply engine is a proprietary, behavioral-science-based
            reasoning system that gets patients to reorder their supplies from
            you — automatically. It reads each patient's eligibility and reorder
            window, then reasons about the message, the channel, and the moment
            most likely to land: a text, a follow-up email, and a natural AI
            phone call when it helps. Every touch is one tap from a placed
            order, and the rare exception is the only thing your team ever
            touches. It's exactly how resupply revenue grows — with almost no
            human in the loop.
          </p>
        </div>
        <div className="bx-pillars">
          {ENGINE_STEPS.map((p) => (
            <article
              className={`bx-pillar bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-pillar-top">
                <span className="bx-pillar-ic">{p.icon}</span>
                <span className="bx-pillar-metric">
                  <b>{p.metric}</b>
                  <small>{p.metricSub}</small>
                </span>
              </div>
              <h3 className="bx-pillar-title">{p.title}</h3>
              <p className="bx-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Replaces strip ───────────────────────── */
const REPLACED = [
  "Resupply software",
  "Billing / RCM suite",
  "Patient CRM",
  "Telehealth app",
  "Document & e-sign",
  "Therapy dashboards",
  "Call-center IVR",
];

function Replaces() {
  return (
    <div className="bx-shell bx-replace bx-reveal">
      <div className="bx-replace-label">One login instead of seven</div>
      <div className="bx-replace-row">
        {REPLACED.map((r) => (
          <span className="bx-replace-pill" key={r}>
            <s>{r}</s>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Lifecycle pipeline ───────────────────────── */
const LIFECYCLE: { icon: React.ReactNode; label: string }[] = [
  { icon: <PhoneCall size={18} />, label: "Intake" },
  { icon: <BadgeCheck size={18} />, label: "Eligibility" },
  { icon: <ScanFace size={18} />, label: "Mask fitting" },
  { icon: <Receipt size={18} />, label: "Order" },
  { icon: <RefreshCw size={18} />, label: "Fulfillment" },
  { icon: <Stethoscope size={18} />, label: "Monitoring" },
  { icon: <CalendarClock size={18} />, label: "Resupply" },
  { icon: <LineChart size={18} />, label: "Revenue" },
];

function Lifecycle() {
  return (
    <section className="bx-section bx-lifecycle-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Waypoints size={13} /> How it works
          </span>
          <h2 className="bx-h2">One continuous workflow, end to end</h2>
          <p className="bx-lede">
            From the first intake call to the last reconciled claim, every stage
            of the DME lifecycle runs on the same data — no exports, no
            re-keying between screens, no patients lost between systems.
          </p>
        </div>
        <div className="bx-pipeline bx-reveal">
          <div className="bx-pipeline-line">
            <span className="bx-pipeline-pulse" />
          </div>
          <ol className="bx-pipeline-nodes">
            {LIFECYCLE.map((s, i) => (
              <li className="bx-pipe-node" key={s.label}>
                <span className="bx-pipe-dot">{s.icon}</span>
                <span className="bx-pipe-label">{s.label}</span>
                <span className="bx-pipe-idx">{`0${i + 1}`}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── A day on Breathe ───────────────────────── */
/*
 * The concrete "what does it actually do" story — one operating day told
 * as the events the platform handles on its own, from before the team
 * logs in to the owner's end-of-day read. Every beat maps to shipped
 * functionality (nightly therapy sync, the resupply worklist, the AI
 * voice agent, the unified inbox + email auto-reply, Office Ally
 * submission + ERA posting, the therapy board + video visits, AI referral
 * intake + CMN drafting, and the live owner dashboards/KPI alerts).
 */
const DAY: {
  icon: React.ReactNode;
  time: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <RefreshCw size={20} />,
    time: "Before anyone logs in",
    title: "The day builds itself overnight",
    body: "The nightly sync pulls adherence from ResMed, Philips, and 3B; the resupply engine assembles an eligibility-ranked worklist; and the AI voice agent has already answered after-hours calls and booked the reorders behind them.",
  },
  {
    icon: <MessageSquare size={20} />,
    time: "8:30 AM",
    title: "Coordinators open one inbox",
    body: "SMS, email, and inbound faxes are already triaged to the right patient. High-confidence email questions were answered automatically overnight; the rest wait as drafts, so reps start on exceptions instead of a backlog.",
  },
  {
    icon: <Receipt size={20} />,
    time: "10:00 AM",
    title: "Billing works dollars, not a queue",
    body: "Clean 837P claims auto-submit through Office Ally, this morning's ERAs auto-post, and the denials worklist is already ranked by recoverable dollars × win probability — the biggest recoveries first.",
    gold: true,
  },
  {
    icon: <Video size={20} />,
    time: "1:00 PM",
    title: "Clinical reaches the right patients",
    body: "The therapy board surfaces three patients slipping in their first month. An RT launches a video visit with a one-tap link — no scheduling tool, no app for the patient to install.",
  },
  {
    icon: <FileStack size={20} />,
    time: "3:00 PM",
    title: "New business walks in by fax",
    body: "A referral fax arrives; AI extracts the patient and clinical details and pre-fills intake. The CMN drafts from therapy data and routes for e-signature — the order moves without anyone re-keying paper.",
    gold: true,
  },
  {
    icon: <LineChart size={20} />,
    time: "End of day",
    title: "The owner sees the real number",
    body: "Margin, DSO, and collections are live — not a month-old export. A KPI alert already flagged the one payer trending toward trouble, while the rest of the business ran itself.",
  },
];

function DayInLife() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CalendarClock size={13} /> A day on Breathe
          </span>
          <h2 className="bx-h2">What the platform does while you work</h2>
          <p className="bx-lede">
            The same operating day, told as the work the system handles on its
            own — so your team spends the hours on patients, not on stitching
            tools together.
          </p>
        </div>
        <ol className="bx-day bx-reveal">
          {DAY.map((d) => (
            <li className={`bx-day-item${d.gold ? " gold" : ""}`} key={d.time}>
              <span className="bx-day-dot">{d.icon}</span>
              <div className="bx-day-body">
                <span className="bx-day-time">{d.time}</span>
                <h3>{d.title}</h3>
                <p>{d.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ───────────────────────── Product showcase ───────────────────────── */
const SIDE_NAV: { icon: React.ReactNode; label: string; active?: boolean }[] = [
  { icon: <Gauge size={15} />, label: "Today", active: true },
  { icon: <Activity size={15} />, label: "Patients" },
  { icon: <RefreshCw size={15} />, label: "Resupply" },
  { icon: <Receipt size={15} />, label: "Claims" },
  { icon: <MessageSquare size={15} />, label: "Conversations" },
  { icon: <Stethoscope size={15} />, label: "Therapy" },
  { icon: <Video size={15} />, label: "Telehealth" },
  { icon: <LineChart size={15} />, label: "Analytics" },
];

const KPIS: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta: string;
  gold?: boolean;
}[] = [
  {
    icon: <RefreshCw size={15} />,
    label: "Resupply due",
    value: "248",
    delta: "+12 today",
  },
  {
    icon: <Receipt size={15} />,
    label: "First-pass claims",
    value: "94%",
    delta: "+3.1 pts",
  },
  {
    icon: <LineChart size={15} />,
    label: "Collected MTD",
    value: "$182.4k",
    delta: "on pace",
    gold: true,
  },
  {
    icon: <Stethoscope size={15} />,
    label: "At-risk patients",
    value: "37",
    delta: "−8 this wk",
  },
];

const WORKLIST: {
  initials: string;
  device: string;
  status: string;
  tone: "eligible" | "verify" | "auto" | "hold";
}[] = [
  {
    initials: "J·M",
    device: "AirSense 11",
    status: "Due now",
    tone: "eligible",
  },
  {
    initials: "R·K",
    device: "DreamStation 2",
    status: "Verify Rx",
    tone: "verify",
  },
  {
    initials: "S·P",
    device: "AirCurve VAuto",
    status: "Reorder placed",
    tone: "auto",
  },
  {
    initials: "T·W",
    device: "3B Luna G3",
    status: "Due now",
    tone: "eligible",
  },
  {
    initials: "D·L",
    device: "AirSense 10",
    status: "Awaiting Rx",
    tone: "hold",
  },
];

const DENIALS: { reason: string; amount: string; pct: number }[] = [
  { reason: "Prior auth missing", amount: "$4,210", pct: 100 },
  { reason: "Invalid HCPCS modifier", amount: "$1,980", pct: 47 },
  { reason: "Eligibility lapse", amount: "$1,140", pct: 27 },
];

const SPARK = [34, 41, 38, 50, 46, 58, 55, 67, 74, 70, 86, 96];

function Sparkline() {
  const w = 240;
  const h = 54;
  const pad = 5;
  const max = Math.max(...SPARK);
  const min = Math.min(...SPARK);
  const pts = SPARK.map((v, i) => {
    const x = pad + (i / (SPARK.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const area = `${line} L${last[0].toFixed(1)} ${h} L${first[0].toFixed(1)} ${h} Z`;
  return (
    <svg
      className="bx-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="bxSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bx-cyan)" stopOpacity="0.36" />
          <stop offset="100%" stopColor="var(--bx-cyan)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#bxSparkFill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--bx-cyan)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="var(--bx-mint)" />
    </svg>
  );
}

/* ───────────────────── Live console (real screenshots) ─────────────────────
 * Real captured screens from the /admin?demo=1 sandbox (sample data). Unlike
 * the illustrative ProductShowcase below, these are the actual product — the
 * strongest "show, don't tell" proof, and what every competitor's site leads
 * with. Hero screen + a four-up gallery, each captioned with the job it does. */
const LIVE_SHOTS: { src: string; cap: string; alt: string }[] = [
  {
    src: "/breathe/screens/console-resupply.jpg",
    cap: "Resupply opportunities — who's due, overdue, and ready to refit",
    alt: "Breathe admin: resupply opportunities worklist with overdue and at-risk flags",
  },
  {
    src: "/breathe/screens/console-fleet.jpg",
    cap: "Therapy fleet — compliance across ResMed, Philips & 3B",
    alt: "Breathe admin: therapy fleet compliance dashboard across device clouds",
  },
  {
    src: "/breathe/screens/console-denials.jpg",
    cap: "Denials ranked by recoverable $ × win-probability",
    alt: "Breathe admin: denials worklist ranked by recoverable dollars",
  },
  {
    src: "/breathe/screens/console-conversations.jpg",
    cap: "One inbox — SMS, email, voice & in-app",
    alt: "Breathe admin: unified conversations inbox across every channel",
  },
];

/* ───────────────────── Feature videos (short, per-capability clips) ─────────
 * Short screen-recorded clips of individual features in motion — the
 * complement to the LiveConsole stills. Click-to-play with preload="none"
 * (each clip is <1MB but still only loads on demand), reusing the .bx-shotgrid
 * card frame. Posters are the matching console screenshots. */
const FEATURE_VIDEOS: {
  src: string;
  poster: string;
  label: string;
  cap: string;
}[] = [
  {
    src: "/breathe/screens/feat-resupply.webm",
    poster: "/breathe/screens/console-resupply.jpg",
    label: "Resupply engine",
    cap: "Filter the worklist by item — who's overdue, who's due, who needs a refit.",
  },
  {
    src: "/breathe/screens/feat-copilot.webm",
    poster: "/breathe/screens/feat-copilot-poster.jpg",
    label: "AI admin copilot",
    cap: "Ask how something works — it answers with the exact pages to use.",
  },
  {
    src: "/breathe/screens/feat-denials.webm",
    poster: "/breathe/screens/console-denials.jpg",
    label: "AI denials worklist",
    cap: "Denials ranked by recoverable dollars × win probability.",
  },
  {
    src: "/breathe/screens/feat-fleet.webm",
    poster: "/breathe/screens/console-fleet.jpg",
    label: "Therapy monitoring",
    cap: "Compliance, clinical flags & at-risk alerts across ResMed, Philips & 3B.",
  },
];

function FeatureVideos() {
  return (
    <section className="bx-section" id="feature-videos">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Video size={13} /> See it in action
          </span>
          <h2 className="bx-h2">Each piece, in motion</h2>
          <p className="bx-lede">
            Short clips from the live demo — the resupply engine, the AI
            copilot, the denials worklist, and therapy monitoring doing their
            thing. Click any to play; sample data throughout.
          </p>
        </div>
        <div className="bx-shotgrid">
          {FEATURE_VIDEOS.map((v) => (
            <figure className="bx-shotcard bx-reveal" key={v.src}>
              <div className="bx-shotcard-frame">
                <span className="bx-shotcard-bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <video
                  src={v.src}
                  poster={v.poster}
                  controls
                  loop
                  muted
                  playsInline
                  preload="none"
                  aria-label={`${v.label} — ${v.cap}`}
                />
              </div>
              <figcaption>
                <b>{v.label}</b> — {v.cap}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function LiveConsole() {
  return (
    <section className="bx-section" id="console">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> The actual product
          </span>
          <h2 className="bx-h2">This is the console — not a mockup</h2>
          <p className="bx-lede">
            Watch the short tour, or click around the live demo yourself — the
            same command center your team works in every day, on sample data.
            Real screens below.
          </p>
        </div>

        <div className="bx-app-frame bx-reveal">
          <div className="bx-app">
            <div className="bx-app-top">
              <span className="bx-app-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="bx-app-url">
                <Lock size={11} /> app.cmbreathe.com/admin
              </span>
              <span className="bx-app-live">
                <span className="dot" /> Live
              </span>
            </div>
            {/* Click-to-play product tour. preload="none" so the ~4.5MB clip
                only loads when a visitor chooses to watch it; the home
                screenshot stands in as the poster until then. */}
            <video
              className="bx-shot-img"
              src="/breathe/screens/console-tour.webm"
              poster="/breathe/screens/console-home.jpg"
              controls
              loop
              muted
              playsInline
              preload="none"
              aria-label="Product tour — a walkthrough of the Breathe admin console: resupply, therapy fleet, denials, inbox and orders"
            />
          </div>
          <div className="bx-app-glow" aria-hidden="true" />
        </div>
        <p className="bx-app-caption">
          A 40-second look at Breathe — the command center, resupply, therapy
          monitoring, revenue cycle, and the AI workforce. Real product screens;
          sample data.
        </p>

        <div className="bx-shotgrid">
          {LIVE_SHOTS.map((s) => (
            <figure className="bx-shotcard bx-reveal" key={s.src}>
              <div className="bx-shotcard-frame">
                <span className="bx-shotcard-bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <img src={s.src} alt={s.alt} loading="lazy" />
              </div>
              <figcaption>{s.cap}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductShowcase() {
  return (
    <section className="bx-section" id="product">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> The command center
          </span>
          <h2 className="bx-h2">Your whole operation, on one screen</h2>
          <p className="bx-lede">
            Every queue, every claim, every conversation, and a live AI voice
            agent — in one console your team actually wants to work in.
          </p>
        </div>

        <div className="bx-app-frame bx-reveal">
          {/* Decorative illustrative UI — hidden from assistive tech so the
              sample sidebar/worklist text is not announced as real content
              (the section heading + caption convey the message). */}
          <div className="bx-app" aria-hidden="true">
            <div className="bx-app-top">
              <span className="bx-app-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="bx-app-url">
                <Lock size={11} /> app.cmbreathe.com/admin/today
              </span>
              <span className="bx-app-live">
                <span className="dot" /> Live
              </span>
            </div>

            <div className="bx-app-body">
              <aside className="bx-app-side">
                <div className="bx-app-brand">
                  <img src={LOGO} alt="" />
                  <b>Breathe</b>
                </div>
                <nav className="bx-app-nav">
                  {SIDE_NAV.map((n) => (
                    <span
                      className={`bx-app-navitem${n.active ? " active" : ""}`}
                      key={n.label}
                    >
                      {n.icon}
                      {n.label}
                    </span>
                  ))}
                </nav>
                <div className="bx-app-pilot">
                  <Bot size={14} />
                  <span>
                    <b>CareMetric Copilot</b>
                    <i>AI copilot · ready</i>
                  </span>
                </div>
              </aside>

              <div className="bx-app-main">
                <div className="bx-app-head">
                  <div>
                    <div className="bx-app-hello">Good morning, Maria</div>
                    <div className="bx-app-sub">
                      Tuesday · 248 patients due this week
                    </div>
                  </div>
                  <div className="bx-app-search">
                    <span>Search patients, orders, claims…</span>
                    <kbd>⌘K</kbd>
                  </div>
                </div>

                <div className="bx-app-kpis">
                  {KPIS.map((k) => (
                    <div
                      className={`bx-app-kpi${k.gold ? " gold" : ""}`}
                      key={k.label}
                    >
                      <span className="bx-app-kpi-ic">{k.icon}</span>
                      <span className="bx-app-kpi-label">{k.label}</span>
                      <span className="bx-app-kpi-val">{k.value}</span>
                      <span className="bx-app-kpi-delta">{k.delta}</span>
                    </div>
                  ))}
                </div>

                <div className="bx-app-cols">
                  <div className="bx-app-panel">
                    <div className="bx-app-panel-head">
                      <b>Resupply worklist</b>
                      <span>Eligibility-ranked</span>
                    </div>
                    <ul className="bx-worklist">
                      {WORKLIST.map((w) => (
                        <li key={w.initials}>
                          <span className="bx-avatar">{w.initials}</span>
                          <span className="bx-worklist-meta">
                            <b>{w.device}</b>
                            <i>Resupply window open</i>
                          </span>
                          <span className={`bx-pill ${w.tone}`}>
                            {w.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="bx-app-stack">
                    <div className="bx-app-panel bx-voice">
                      <div className="bx-app-panel-head">
                        <b>
                          <Mic size={13} /> AI voice agent
                        </b>
                        <span className="bx-voice-timer">
                          <span className="dot" /> on call · 02:14
                        </span>
                      </div>
                      <div className="bx-wave" aria-hidden="true">
                        {Array.from({ length: 28 }).map((_, i) => (
                          <i
                            key={i}
                            style={{ animationDelay: `${i * 60}ms` }}
                          />
                        ))}
                      </div>
                      <p className="bx-voice-transcript">
                        “…confirming your mask cushion and tubing for this
                        month&apos;s resupply — I have you all set.”
                      </p>
                      <div className="bx-voice-action">
                        <Check size={13} /> Order #80432 placed · eligibility
                        confirmed
                      </div>
                    </div>

                    <div className="bx-app-panel bx-denials">
                      <div className="bx-app-panel-head">
                        <b>Denials by $ recoverable</b>
                        <span>worklist</span>
                      </div>
                      {DENIALS.map((d) => (
                        <div className="bx-denial" key={d.reason}>
                          <span className="bx-denial-k">{d.reason}</span>
                          <span className="bx-denial-v">{d.amount}</span>
                          <span className="bx-denial-bar">
                            <i style={{ width: `${d.pct}%` }} />
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="bx-app-panel bx-collections">
                      <div className="bx-app-panel-head">
                        <b>
                          <TrendingUp size={13} /> Collections
                        </b>
                        <span>last 7 days</span>
                      </div>
                      <Sparkline />
                      <div className="bx-collections-foot">
                        <span className="amt">$1.21M collected</span>
                        <span className="up">
                          <TrendingUp size={11} /> 8.4%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bx-app-glow" aria-hidden="true" />
        </div>
        <p className="bx-app-caption">
          Illustrative interface. Sample data shown — no real patient
          information.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Features ───────────────────────── */
type Feature = {
  icon: React.ReactNode;
  title: string;
  body: string;
  tag?: string;
  gold?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: <Mic size={22} />,
    title: "AI Voice Agent",
    body: "A natural-sounding agent answers resupply calls, confirms eligibility, and books orders 24/7 — then leaves a structured summary and sentiment read for your team.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <RefreshCw size={22} />,
    title: "Resupply Automation",
    body: "Eligibility-aware reminders go out by SMS, email, and voice on the right cadence, with one-tap reorder links. No spreadsheets, no missed replacement windows.",
  },
  {
    icon: <Receipt size={22} />,
    title: "Revenue Cycle + AI Claims",
    body: "Real-time 270/271 eligibility, AI claim scrubbing, one-click Office Ally auto-submission — or a downloadable 837P for any clearinghouse — and a denials worklist ranked by recoverable dollars × win probability.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <Stethoscope size={22} />,
    title: "Therapy Monitoring",
    body: "Pulls adherence data straight from ResMed, Philips, and 3B device clouds and surfaces exactly who is falling off therapy — and who is due for resupply.",
  },
  {
    icon: <Workflow size={22} />,
    title: "Unified Conversations",
    body: "Every SMS, email, and chat thread in one inbox with canned replies and AI-drafted responses, auto-logged to a complete patient timeline.",
  },
  {
    icon: <Video size={22} />,
    title: "Built-in Telehealth",
    body: "Launch a video visit for setups, mask fittings, and follow-ups. Patients join from a secure link by text or email — no app to install, nothing to schedule twice.",
  },
  {
    icon: <ClipboardSignature size={22} />,
    title: "Documents & e-Sign",
    body: "Generate CMNs, prescriptions, and agreements, send e-signature packets, triage inbound faxes, and track provider signatures — the whole paperwork pipeline.",
  },
  {
    icon: <ScanFace size={22} />,
    title: "Virtual Mask Fitter",
    body: "Patients fit themselves at home from their phone camera — no staff time on in-person fittings and no sample masks opened just to be thrown away. AI facial measurements pick the perfect mask and size more accurately than eyeballing it, and images never leave the browser.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <LineChart size={22} />,
    title: "Analytics & KPIs",
    body: "Margin, DSO, LTV/CAC, payer profitability, team throughput, and NPS — live, with KPI alerts that page you before a number becomes a problem.",
  },
  {
    icon: <Store size={22} />,
    title: "Branded Storefront & Shop",
    body: "Your own CPAP storefront with catalog, cart, Stripe checkout, subscriptions, returns, and reviews — plus live insurance benefit estimates before a patient pays.",
  },
  {
    icon: <Workflow size={22} />,
    title: "Automation & Rules",
    body: "Smart triggers and routing rules fire the right outreach the moment an event happens, while KPI alerts and goal tracking keep leadership ahead of every number.",
  },
  {
    icon: <FileStack size={22} />,
    title: "AI Referral Intake",
    body: "Drop in a referral fax and AI extracts the patient and clinical details to pre-fill intake — no manual re-keying, and the paperwork pipeline takes it from there.",
    tag: "AI",
    gold: true,
  },
];

function Features() {
  return (
    <section className="bx-section" id="platform">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The platform
          </span>
          <h2 className="bx-h2">Every workflow in the DME lifecycle</h2>
          <p className="bx-lede">
            From the first intake call to the last reconciled claim, Breathe
            runs the work — and the AI does the parts that used to eat your
            team&apos;s day.
          </p>
        </div>
        <div className="bx-features">
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.title} f={f} delay={i * 60} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ f, delay }: { f: Feature; delay: number }) {
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div
      className={`bx-card bx-reveal${f.gold ? " gold" : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
      onMouseMove={onMove}
    >
      {f.tag ? <span className="bx-tag">{f.tag}</span> : null}
      <div className="bx-card-ico">{f.icon}</div>
      <h3>{f.title}</h3>
      <p>{f.body}</p>
    </div>
  );
}

/* ───────────────────────── AI bento ───────────────────────── */
type Ai = {
  icon: React.ReactNode;
  title: string;
  body: string;
  span?: boolean;
  wave?: boolean;
};

const AI_CELLS: Ai[] = [
  {
    icon: <Mic size={20} />,
    title: "Voice agent that closes the loop",
    body: "Answers inbound resupply and status calls, confirms coverage, places the order, and hands your team a transcript, summary, and sentiment read.",
    span: true,
    wave: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Claims intelligence",
    body: "Scrubs the 837P, predicts denials, and ranks the worklist by recoverable dollars.",
  },
  {
    icon: <ScanFace size={20} />,
    title: "Virtual mask fitter",
    body: "Patients self-fit at home — perfect mask and size, no wasted sample masks. Measurements are computed in the browser; the image never leaves the phone.",
  },
  {
    icon: <Bot size={20} />,
    title: "CareMetric Copilot",
    body: "An in-app assistant that answers “where do I…?” and surfaces the next best action for staff.",
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Storefront chatbot",
    body: "Warm, on-brand answers for patients on the web and over email — with clean human hand-off.",
  },
  {
    icon: <Headphones size={20} />,
    title: "Sleep coach & SMS triage",
    body: "Adherence coaching plus intent classification that routes every inbound text correctly.",
  },
];

function AiBento() {
  return (
    <section className="bx-section" id="ai">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> Intelligence, built in
          </span>
          <h2 className="bx-h2">
            AI that does the work — <em>not just the talking</em>
          </h2>
          <p className="bx-lede">
            Best-in-class models from Anthropic, OpenAI, and ElevenLabs are
            wired into the product where each is strongest — and if a provider
            is ever unavailable, that feature steps aside quietly instead of
            breaking your day.
          </p>
        </div>
        <div className="bx-bento">
          {AI_CELLS.map((c) => (
            <div
              className={`bx-bento-cell${c.span ? " span" : ""}`}
              key={c.title}
            >
              <div className="bx-bento-ic">{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              {c.wave ? (
                <div className="bx-bento-wave" aria-hidden="true">
                  {Array.from({ length: 40 }).map((_, i) => (
                    <i key={i} style={{ animationDelay: `${i * 45}ms` }} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Outcomes / proof ───────────────────────── */
/*
 * Three-pillar "what it adds up to" section: more sales, better patient
 * care, cleaner billing (AI). Every figure is an ILLUSTRATIVE range
 * grounded in published DME / healthcare revenue-cycle benchmarks (see the
 * section footnote) — directional, not a guarantee. Charts are hand-built
 * bars (no third-party charting library) so the page stays same-origin
 * under the strict CSP, matching the Sparkline / ROI patterns above.
 */
type OutcomeBar = {
  fromLabel: string;
  from: number;
  toLabel: string;
  to: number;
  unit: string;
  caption: string;
};

type OutcomeCard = {
  icon: React.ReactNode;
  eyebrow: string;
  hero: string;
  heroSub: string;
  bar: OutcomeBar;
  points: string[];
  source: string;
  gold?: boolean;
};

const OUTCOMES: OutcomeCard[] = [
  {
    icon: <TrendingUp size={20} />,
    eyebrow: "More sales",
    hero: "2.5×",
    heroSub: "more resupply orders captured",
    bar: {
      fromLabel: "Reactive outreach",
      from: 20,
      toLabel: "Breathe automation",
      to: 50,
      unit: "%",
      caption: "Resupply order rate — higher is better",
    },
    points: [
      "Eligibility-aware reminders by SMS, email & voice on the right cadence",
      "24/7 AI voice agent books reorders even while your team sleeps",
      "One-tap reorder links — no spreadsheets, no missed replacement windows",
    ],
    source:
      "Industry: proactive / managed resupply lifts order rates from ~20% to 45–50%.",
  },
  {
    icon: <Stethoscope size={20} />,
    eyebrow: "Better patient care",
    hero: "85%",
    heroSub: "therapy compliance, up from a ~50% norm",
    bar: {
      fromLabel: "National average",
      from: 50,
      toLabel: "Proactive monitoring",
      to: 85,
      unit: "%",
      caption: "CPAP compliance — higher is better",
    },
    points: [
      "Live ResMed, Philips & 3B adherence pulled nightly into one worklist",
      "At-risk patients surfaced before they fall off therapy",
      "~1 in 3 CPAP patients drift out of adherence — caught early, not lost",
    ],
    source:
      "Industry: live outreach raised compliance from the ~50% national average to 85%.",
  },
  {
    icon: <Receipt size={20} />,
    eyebrow: "Better billing — AI built in",
    hero: "94%",
    heroSub: "first-pass clean-claim rate",
    gold: true,
    bar: {
      fromLabel: "Typical DME",
      from: 80,
      toLabel: "Breathe AI scrubbing",
      to: 94,
      unit: "%",
      caption: "First-pass clean claims — higher is better",
    },
    points: [
      "AI scrubs every 837P clean, then auto-submits via Office Ally — or download it for any clearinghouse",
      "Denial worklist ranked by recoverable dollars × win probability",
      "AI eligibility checks cut denials up to 42%; each rework costs $25–$118",
    ],
    source:
      "Industry: best-practice first-pass rate is 95%+; initial denials average ~11.8%.",
  },
];

const CLAIMS_FLOW: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  {
    icon: <BadgeCheck size={16} />,
    label: "Eligibility",
    sub: "270 / 271 real-time",
  },
  {
    icon: <Sparkles size={16} />,
    label: "AI scrub",
    sub: "837P cleaned pre-submit",
  },
  {
    icon: <Receipt size={16} />,
    label: "Submit or export",
    sub: "Office Ally auto-submit · or download the 837P",
  },
  {
    icon: <RefreshCw size={16} />,
    label: "ERA auto-post",
    sub: "835 reconciled",
  },
  {
    icon: <LineChart size={16} />,
    label: "AI denial worklist",
    sub: "ranked by $ recoverable",
    gold: true,
  },
];

function OutcomeBars({ bar, gold }: { bar: OutcomeBar; gold?: boolean }) {
  // Expose the comparison to assistive tech as a single image label rather
  // than hiding the chart: e.g. "Resupply order rate: Reactive outreach 20%,
  // Breathe automation 50%." The decorative bars themselves carry no text.
  const metric = bar.caption.split(" — ")[0];
  const ariaLabel = `${metric}: ${bar.fromLabel} ${bar.from}${bar.unit}, ${bar.toLabel} ${bar.to}${bar.unit}.`;
  return (
    <div className="bx-ob" role="img" aria-label={ariaLabel}>
      <div className="bx-ob-row" aria-hidden="true">
        <span className="bx-ob-tag">{bar.fromLabel}</span>
        <span className="bx-ob-track">
          <i
            className="from"
            style={{ ["--w"]: `${bar.from}%` } as React.CSSProperties}
          />
        </span>
        <span className="bx-ob-val">
          {bar.from}
          {bar.unit}
        </span>
      </div>
      <div className="bx-ob-row" aria-hidden="true">
        <span className="bx-ob-tag">{bar.toLabel}</span>
        <span className="bx-ob-track">
          <i
            className={"to" + (gold ? " gold" : "")}
            style={{ ["--w"]: `${bar.to}%` } as React.CSSProperties}
          />
        </span>
        <span className={"bx-ob-val to" + (gold ? " gold" : "")}>
          {bar.to}
          {bar.unit}
        </span>
      </div>
      <div className="bx-ob-axis" aria-hidden="true">
        {bar.caption}
      </div>
    </div>
  );
}

function Outcomes({ showClaimsEngine = true }: { showClaimsEngine?: boolean }) {
  // The "Inside the AI claims engine" flow is the only claims pipeline on the
  // home page, but on the product tour the dedicated RevenueCycle section
  // already renders a richer pipeline a couple of sections up — so we suppress
  // this one there (showClaimsEngine={false}) to avoid two near-identical
  // claim-flow visualizations on the same page. The metric bars stay either way.
  return (
    <section className="bx-section" id="outcomes">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <LineChart size={13} /> What it adds up to
          </span>
          <h2 className="bx-h2">More sales, better care, cleaner billing</h2>
          <p className="bx-lede">
            One platform moves every number that matters — recurring resupply
            revenue, patients kept on therapy, and claims that get paid the
            first time — with the AI doing the heavy lifting.
          </p>
        </div>

        <div className="bx-outcomes">
          {OUTCOMES.map((o) => (
            <div
              className={`bx-outcome bx-reveal${o.gold ? " gold" : ""}`}
              key={o.eyebrow}
            >
              <div className="bx-outcome-top">
                <span className="bx-outcome-ic">{o.icon}</span>
                <span className="bx-outcome-eyebrow">{o.eyebrow}</span>
              </div>
              <div className="bx-outcome-hero">{o.hero}</div>
              <div className="bx-outcome-hero-sub">{o.heroSub}</div>
              <OutcomeBars bar={o.bar} gold={o.gold} />
              <ul className="bx-outcome-points">
                {o.points.map((p) => (
                  <li key={p}>
                    <Check size={14} />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="bx-outcome-source">{o.source}</p>
            </div>
          ))}
        </div>

        {showClaimsEngine ? (
          <div className="bx-claims-engine bx-reveal">
            <div className="bx-claims-engine-head">
              <BrainCircuit size={15} /> Inside the AI claims engine
            </div>
            <ol className="bx-claims-flow">
              {CLAIMS_FLOW.map((s, i) => (
                <li
                  className={`bx-claims-step${s.gold ? " gold" : ""}`}
                  key={s.label}
                >
                  <span className="bx-claims-ic">{s.icon}</span>
                  <span className="bx-claims-meta">
                    <b>{s.label}</b>
                    <i>{s.sub}</i>
                  </span>
                  {i < CLAIMS_FLOW.length - 1 ? (
                    <ArrowRight
                      className="bx-claims-arrow"
                      size={15}
                      aria-hidden="true"
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <p className="bx-outcomes-foot">
          Illustrative ranges drawn from published DME and healthcare
          revenue-cycle benchmarks; actual results depend on your payer mix,
          patient base, and current processes. Directional, not a guarantee.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Revenue cycle deep-dive ───────────────────────── */
/*
 * The RCM drill-down for the product tour — DME lives or dies on getting
 * paid, so the claims pipeline gets its own section. The flow steps and
 * worklist cards map to the real Office Ally EDI path (270/271, 837P,
 * 999/277CA, 835/ERA) plus the shipped A/R worklists (prior auth via
 * Da Vinci PAS, secondary/COB, capped rentals, timely filing, statements,
 * payer profitability). Reuses .bx-pipeline + .bx-caps so no new CSS.
 */
const RCM_FLOW: { icon: React.ReactNode; label: string; sub: string }[] = [
  { icon: <BadgeCheck size={18} />, label: "Eligibility", sub: "270 / 271" },
  { icon: <Sparkles size={18} />, label: "AI scrub", sub: "pre-flight" },
  { icon: <Receipt size={18} />, label: "Submit", sub: "837P" },
  { icon: <FileStack size={18} />, label: "Acknowledge", sub: "999 / 277CA" },
  { icon: <CircleDollarSign size={18} />, label: "Post", sub: "835 / ERA" },
  { icon: <TrendingUp size={18} />, label: "Denials", sub: "ranked by $" },
  { icon: <LineChart size={18} />, label: "A/R", sub: "aging & forecast" },
];

const RCM_WORKLISTS: Capability[] = [
  {
    icon: <ClipboardSignature size={20} />,
    title: "Electronic prior auth",
    summary: "FHIR submission through Da Vinci PAS, with SLA tracking.",
    points: [
      "Submit auth requests electronically, not by fax-and-wait",
      "Missed / at-risk SLA worklist with renewal tracking",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Secondary & COB",
    summary: "Roll the primary's leftover balance to the secondary payer.",
    points: [
      "Coordination-of-benefits worklist",
      "Patient responsibility calculated automatically",
    ],
  },
  {
    icon: <CalendarClock size={20} />,
    title: "Capped rentals",
    summary: "13- and 36-month Medicare cycles, handled.",
    points: [
      "Cycle tracking with KH / KI / KX modifier rotation",
      "Advance-notice automation before each cycle turns",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "A/R & timely filing",
    summary: "Nothing ages out or misses a filing window.",
    points: [
      "0 / 30 / 60 / 90 aging buckets",
      "Days-left-to-file countdown + collections forecast",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient statements",
    summary: "Send balances by email or SMS — compliantly.",
    points: [
      "Signed statement links delivered to the patient",
      "Consent- and quiet-hours-aware sending",
    ],
  },
  {
    icon: <CircleDollarSign size={20} />,
    title: "Payer profitability",
    summary: "Net yield by payer: billed → allowed → collected.",
    points: [
      "Denial rate and DSO broken out per payer",
      "Margin reported net of captured product cost",
    ],
  },
];

function RevenueCycle() {
  return (
    <section className="bx-section" id="revenue-cycle">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Revenue cycle, in depth
          </span>
          <h2 className="bx-h2">
            Get paid the first time — <em>automated end to end</em>
          </h2>
          <p className="bx-lede">
            From real-time eligibility to posted cash, the whole claim lifecycle
            runs on the same patient record. Specialists review exceptions; the
            platform does the keying, the submission, the posting, and the
            prioritizing.
          </p>
        </div>

        <div className="bx-pipeline bx-reveal">
          <div className="bx-pipeline-line">
            <span className="bx-pipeline-pulse" />
          </div>
          <ol className="bx-pipeline-nodes">
            {RCM_FLOW.map((s) => (
              <li className="bx-pipe-node" key={s.label}>
                <span className="bx-pipe-dot">{s.icon}</span>
                <span className="bx-pipe-label">{s.label}</span>
                <span className="bx-pipe-idx">{s.sub}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="bx-caps" style={{ marginTop: 56 }}>
          {RCM_WORKLISTS.map((c) => (
            <article className="bx-cap bx-reveal" key={c.title}>
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{c.icon}</span>
                <div>
                  <h3>{c.title}</h3>
                  <p className="bx-cap-summary">{c.summary}</p>
                </div>
              </div>
              <ul className="bx-cap-list">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Capabilities ───────────────────────── */
/*
 * The plain-language answer to "what does this software actually do?" —
 * the real product surface grouped into nine capability areas, each with
 * concrete sub-features. This is the homepage's core explainer; the
 * /breathe/product Features grid and the /breathe/features role page go
 * deeper. Copy is grounded in shipped functionality (resupply engine,
 * Office Ally RCM, therapy-cloud monitoring, the AI workforce, the virtual
 * mask fitter, storefront, telehealth, analytics), not aspiration.
 */
export type Capability = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const CAPABILITIES: Capability[] = [
  {
    icon: <RefreshCw size={20} />,
    title: "Resupply engine",
    summary: "Never miss a replacement window across your whole panel.",
    points: [
      "Eligibility-aware reminders by SMS, email & voice",
      "One-tap signed reorder links — no login, no friction",
      "Subscriptions, autopay & cart-abandonment recovery",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Revenue cycle & claims",
    summary: "Get paid the first time, faster — end to end.",
    points: [
      "Real-time 270/271 eligibility & re-verification",
      "AI-scrubbed 837P auto-submitted via Office Ally",
      "835/ERA auto-posting + denials ranked by $ recoverable",
      "Prior auth, A/R aging, timely-filing & capped rentals",
    ],
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Therapy monitoring",
    summary: "See who's slipping off therapy before they quit.",
    points: [
      "Nightly ResMed, Philips & 3B adherence pulls",
      "CMS 90-day compliance cohorts & RT interventions",
      "Provider-ready usage reports & recall tracking",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient communications",
    summary: "Every conversation in one inbox, fully logged.",
    points: [
      "Unified SMS, MMS, email & inbound-fax inbox",
      "Cases, routing rules, macros & message templates",
      "Bulk campaigns, alerts & cadence playbooks",
    ],
  },
  {
    icon: <BrainCircuit size={20} />,
    title: "AI workforce",
    summary: "AI that does the work — not just the talking.",
    points: [
      "24/7 voice agent confirms coverage & places orders",
      "Storefront chatbot + high-confidence email auto-reply",
      "Referral auto-intake from faxes, post-call summaries",
      "An in-app admin copilot for your whole team",
    ],
    gold: true,
  },
  {
    icon: <ScanFace size={20} />,
    title: "Virtual mask fitter",
    summary: "Patients fit themselves at home — staff never run a fitting.",
    points: [
      "Self-serve on-device AI fitting from the patient's own phone",
      "Precise facial measurements pick the perfect mask & size",
      "No staff time spent on in-person fittings",
      "No sample masks opened, tried on & thrown away",
    ],
    gold: true,
  },
  {
    icon: <Store size={20} />,
    title: "Storefront & shop",
    summary: "A branded shop that converts shoppers to patients.",
    points: [
      "Catalog, cart, Stripe checkout, returns & reviews",
      "Subscriptions, autopay & cart-abandonment recovery",
      "Live insurance benefit estimates before checkout",
    ],
  },
  {
    icon: <Video size={20} />,
    title: "Telehealth",
    summary: "Face-to-face setups and follow-ups, no friction.",
    points: [
      "Built-in video visits for setups, fittings & check-ins",
      "One-tap patient join by text or email — no app",
      "Scheduled, reminded & summarized automatically",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "Analytics & automation",
    summary: "Run the business on live signal, not last month's export.",
    points: [
      "Margin, DSO, LTV/CAC & payer-profitability dashboards",
      "KPI alerts, goal tracking & live staffing load",
      "Smart triggers, rules & CSV / PDF / QuickBooks export",
    ],
  },
];

function Capabilities() {
  return (
    <section className="bx-section" id="capabilities">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Workflow size={13} /> Everything it does
          </span>
          <h2 className="bx-h2">One platform runs the entire DME business</h2>
          <p className="bx-lede">
            Resupply, revenue cycle, clinical monitoring, patient communication,
            a branded storefront, telehealth, and an AI workforce — every
            workflow on the same patient record. No exports, no re-keying
            between screens, no patients lost between systems.
          </p>
        </div>
        <div className="bx-caps">
          {CAPABILITIES.map((c) => (
            <article
              className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}
              key={c.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{c.icon}</span>
                <div>
                  <h3>{c.title}</h3>
                  <p className="bx-cap-summary">{c.summary}</p>
                </div>
              </div>
              <ul className="bx-cap-list">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want the full tour — every screen and automation?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/product">
            Explore the platform <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Unified therapy fleet (home teaser) ───────────────── */
/*
 * Homepage teaser for the dedicated /breathe/integrations story: the
 * multi-portal status quo (ResMed AirView, Philips Care Orchestrator, 3B
 * React Health) → one compiled fleet view → AI that flags risk early.
 * Reuses the new logo-card grid and the price-cta; the deep version lives
 * on the Integrations page.
 */
const DEVICE_CLOUDS: { mark: string; sub: string; tag: string }[] = [
  { mark: "ResMed", sub: "AirView", tag: "Therapy cloud" },
  { mark: "Philips", sub: "Care Orchestrator", tag: "Respironics" },
  { mark: "3B Medical", sub: "React Health", tag: "Luna G3" },
];

function UnifiedFleet() {
  return (
    <section className="bx-section" id="unified-fleet">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Network size={13} /> Connected therapy
          </span>
          <h2 className="bx-h2">Three device clouds. One fleet view.</h2>
          <p className="bx-lede">
            Your patients are scattered across ResMed AirView, Philips Care
            Orchestrator, and 3B&apos;s React Health portal — three logins,
            three exports, the same patient re-keyed three times. Breathe
            compiles all of them onto one screen, then watches the whole fleet
            for you and flags who&apos;s slipping <em>before</em> they fall out
            of compliance.
          </p>
        </div>
        <div className="bx-logogrid bx-reveal">
          {DEVICE_CLOUDS.map((c) => (
            <article className="bx-logocard" key={c.mark}>
              <span className="bx-logocard-tag">{c.tag}</span>
              <span className="bx-logocard-mark">{c.mark}</span>
              <span className="bx-logocard-sub">{c.sub}</span>
            </article>
          ))}
          <div className="bx-logogrid-arrow" aria-hidden="true">
            <ArrowRight size={20} />
          </div>
          <article className="bx-logocard bx-logocard-unified">
            <span className="bx-logocard-tag">Breathe</span>
            <span className="bx-logocard-mark">One fleet</span>
            <span className="bx-logocard-sub">every patient, every night</span>
          </article>
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>
            See the unified fleet view and the AI early-warning system in depth.
          </span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/integrations">
            Explore integrations <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Built in-house, not bolted on ───────────────── */
/*
 * The marquee differentiation band: legacy DME suites are decades-old cores
 * with third-party add-ons stacked on top; Breathe is one native codebase.
 * Grounded in real in-house workspace packages (resupply-auth, -telecom,
 * -ai, RCM, the resupply engine, the voice agent). Used on the homepage and
 * the product tour.
 */
const NATIVE_STACK: { icon: React.ReactNode; label: string; note: string }[] = [
  {
    icon: <KeyRound size={17} />,
    label: "Authentication & MFA",
    note: "argon2id, TOTP, device sessions",
  },
  {
    icon: <MessageSquare size={17} />,
    label: "Messaging",
    note: "SMS, voice, email & fax in one inbox",
  },
  {
    icon: <BrainCircuit size={17} />,
    label: "AI orchestration",
    note: "voice agent, chat, scrubbing, coaching",
  },
  {
    icon: <Receipt size={17} />,
    label: "Billing & revenue cycle",
    note: "eligibility → claims → ERA posting",
  },
  {
    icon: <RefreshCw size={17} />,
    label: "Resupply engine",
    note: "reasoning-driven reorder outreach",
  },
  {
    icon: <Stethoscope size={17} />,
    label: "Therapy monitoring",
    note: "device-cloud adherence + early alerts",
  },
];

const BOLTED_ON = [
  "A separate billing / clearinghouse vendor",
  "A separate telephony provider for calls & texts",
  "A separate e-signature tool",
  "An add-on “AI” module, licensed on top",
  "Glue code, nightly exports & manual re-keying in between",
];

function BuiltInHouse() {
  return (
    <section className="bx-section" id="in-house">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> One codebase
          </span>
          <h2 className="bx-h2">Built in-house — not bolted on</h2>
          <p className="bx-lede">
            Legacy DME suites are decades-old cores with third-party add-ons
            stacked on top. Breathe is one native platform — every module built
            ground-up under one roof, on one patient record — so the
            intelligence ships <em>in</em> the product instead of arriving as
            the add-on you license separately.
          </p>
        </div>
        <div className="bx-vs bx-reveal">
          <article className="bx-vs-col bx-vs-legacy">
            <header>
              <span className="bx-vs-kicker">Legacy DME software</span>
              <h3>A core — plus a stack of vendors</h3>
            </header>
            <ul className="bx-vs-list">
              {BOLTED_ON.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </article>
          <div className="bx-vs-divider" aria-hidden="true">
            <span>vs</span>
          </div>
          <article className="bx-vs-col bx-vs-native">
            <header>
              <span className="bx-vs-kicker">Breathe</span>
              <h3>One native stack, one record</h3>
            </header>
            <ul className="bx-vs-native-list">
              {NATIVE_STACK.map((n) => (
                <li key={n.label}>
                  <span className="bx-vs-ic">{n.icon}</span>
                  <span className="bx-vs-text">
                    <b>{n.label}</b>
                    <i>{n.note}</i>
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Comparison ───────────────────────── */
type Cell = "yes" | "no" | "partial";
type CompareRow = {
  label: string;
  sub?: string;
  breathe: Cell;
  cols: Cell[];
  text?: { breathe: string; cols: string[] };
};

const COMPETITORS = ["Brightree", "Bonafide", "NikoHealth"];

const COMPARE_ROWS: CompareRow[] = [
  {
    label: "All-in-one platform",
    sub: "CRM · resupply · RCM · clinical · telehealth",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "AI voice agent for inbound calls",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "AI claim scrubbing & denial prediction",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "On-device AI mask fitting",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Multi-channel resupply (SMS · email · voice)",
    breathe: "yes",
    cols: ["partial", "yes", "partial"],
  },
  {
    label: "Built-in telehealth video visits",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Live therapy-cloud monitoring",
    sub: "ResMed · Philips · 3B",
    breathe: "yes",
    cols: ["partial", "partial", "no"],
  },
  {
    label: "Native telephony",
    sub: "SMS · voice · fax, built-in",
    breathe: "yes",
    cols: ["no", "partial", "no"],
  },
  {
    label: "One codebase, built in-house",
    sub: "not acquired & bolted-on modules",
    breathe: "yes",
    cols: ["no", "no", "partial"],
  },
  {
    label: "Electronic prior authorization",
    sub: "FHIR · Da Vinci PAS",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "Built-in branded storefront & shop",
    sub: "catalog · cart · checkout",
    breathe: "yes",
    cols: ["partial", "partial", "no"],
  },
  {
    label: "AI referral intake from faxes",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Owner analytics",
    sub: "margin · DSO · LTV/CAC",
    breathe: "yes",
    cols: ["partial", "partial", "partial"],
  },
  {
    label: "Modern, unified UI",
    breathe: "yes",
    cols: ["no", "partial", "yes"],
  },
  {
    label: "Transparent, month-to-month pricing",
    breathe: "yes",
    cols: ["no", "no", "partial"],
  },
  {
    label: "Typical implementation",
    breathe: "yes",
    cols: ["no", "partial", "partial"],
    text: {
      breathe: "Day one",
      cols: ["Months", "Weeks–months", "Weeks–months"],
    },
  },
];

function CompareMark({ v }: { v: Cell }) {
  if (v === "yes")
    return (
      <span className="bx-yes">
        <Check size={18} strokeWidth={2.6} />
      </span>
    );
  if (v === "partial") return <span className="bx-partial">partial</span>;
  return (
    <span className="bx-no">
      <Minus size={17} />
    </span>
  );
}

export function Comparison() {
  return (
    <section className="bx-section" id="compare">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> How Breathe compares
          </span>
          <h2 className="bx-h2">One platform vs. a stack of point tools</h2>
          <p className="bx-lede">
            Legacy DME software bolts modules onto decades-old cores. Breathe
            was built AI-first, so the intelligence is in the product — not in
            the add-on you license separately.
          </p>
        </div>

        <div className="bx-compare-wrap bx-reveal">
          <div className="bx-compare-scroll">
            <table className="bx-compare">
              <thead>
                <tr>
                  <th />
                  <th className="bx-col-breathe">
                    <span className="bx-compare-brand">
                      <img src={LOGO} alt="" />
                      <b>Breathe</b>
                    </span>
                  </th>
                  {COMPETITORS.map((c) => (
                    <th
                      key={c}
                      className="bx-other"
                      style={{ textAlign: "center" }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label}>
                    <td className="bx-row-label">
                      {row.label}
                      {row.sub ? <span>{row.sub}</span> : null}
                    </td>
                    <td className="bx-col-breathe">
                      {row.text ? (
                        <strong style={{ color: "#6ff0c2" }}>
                          {row.text.breathe}
                        </strong>
                      ) : (
                        <CompareMark v={row.breathe} />
                      )}
                    </td>
                    {row.cols.map((c, i) => (
                      <td className="bx-other" key={i}>
                        {row.text ? row.text.cols[i] : <CompareMark v={c} />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="bx-compare-foot">
          Comparison reflects publicly described capabilities of each product as
          of 2026 and is provided for illustration. All marks are property of
          their respective owners.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Why it's different ───────────────────────── */
/*
 * The "why the table looks like that" payoff — the three structural
 * choices behind every checkmark above. Reuses the .bx-caps card grid.
 */
const DIFFERENCES: Capability[] = [
  {
    icon: <BrainCircuit size={20} />,
    title: "AI in the core, not an add-on",
    summary: "Intelligence ships in the product — never licensed separately.",
    points: [
      "Voice agent, claim scrubbing, and mask fitting are built in",
      "No bolt-on module to buy to get the AI",
    ],
    gold: true,
  },
  {
    icon: <Database size={20} />,
    title: "One patient record, not seven integrations",
    summary: "Every workflow reads and writes the same data.",
    points: [
      "Intake → resupply → claims → clinical on one timeline",
      "No exports, no re-keying between screens, no patients lost between tools",
    ],
  },
  {
    icon: <CircleDollarSign size={20} />,
    title: "Priced like one platform",
    summary: "Transparent, month-to-month — and your data stays yours.",
    points: [
      "No per-module upsells or multi-year lock-in",
      "Export on demand, including back out to PacWare",
    ],
  },
];

export function WhyDifferent() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The difference, in three ideas
          </span>
          <h2 className="bx-h2">Why the table looks like that</h2>
          <p className="bx-lede">
            Those checkmarks aren&apos;t a longer feature list — they come from
            three structural choices a decades-old core can&apos;t retrofit.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {DIFFERENCES.map((c) => (
            <article
              className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}
              key={c.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{c.icon}</span>
                <div>
                  <h3>{c.title}</h3>
                  <p className="bx-cap-summary">{c.summary}</p>
                </div>
              </div>
              <ul className="bx-cap-list">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Roles ───────────────────────── */
type Role = {
  icon: React.ReactNode;
  title: string;
  hours: number;
  why: string;
  drivers: string[];
};

const ROLES: Role[] = [
  {
    icon: <PhoneCall size={20} />,
    title: "Patient Coordinator / CSR",
    hours: 11,
    why: "The AI voice agent and chatbot field routine resupply calls and FAQs around the clock, so reps only touch the conversations that need a human.",
    drivers: [
      "24/7 AI voice agent handles inbound resupply & status calls",
      "Unified inbox with AI-drafted email replies and canned macros",
      "Timelines auto-log every touch — no manual note-taking",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Billing / RCM Specialist",
    hours: 14,
    why: "Eligibility, scrubbing, submission, and posting are automated end-to-end, and denials arrive pre-ranked by recoverable dollars instead of in a flat queue.",
    drivers: [
      "Automated 270/271 eligibility & re-verification",
      "AI scrubs and auto-submits clean 837P claims",
      "ERA auto-posting + denials worklist ranked by $ recoverable",
    ],
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Respiratory Therapist / Clinical",
    hours: 9,
    why: "Adherence boards pull from the device clouds and surface exactly who is slipping, replacing hours of manual report-pulling with a prioritized worklist.",
    drivers: [
      "Live ResMed / Philips / 3B adherence monitoring",
      "Telehealth visits with secure one-tap patient join links",
      "Automated compliance tracking & coaching prompts",
    ],
  },
  {
    icon: <FileStack size={20} />,
    title: "Intake & Documentation",
    hours: 10,
    why: "CMNs, prescriptions, and agreements are generated and routed for e-signature automatically, and inbound faxes are triaged instead of hand-sorted.",
    drivers: [
      "One-click document generation (CMN / Rx / agreements)",
      "E-signature packets with automatic status tracking",
      "Inbound fax triage for sleep studies & Rx renewals",
    ],
  },
  {
    icon: <Activity size={20} />,
    title: "Operations Manager / Owner",
    hours: 6,
    why: "Every number lives in one system with KPI alerts, so leadership stops reconciling spreadsheets across tools and starts acting on live signal.",
    drivers: [
      "Real-time margin, DSO, LTV/CAC and payer dashboards",
      "KPI alerts that page you before a metric slips",
      "Team throughput & goals in a single source of truth",
    ],
  },
];

function Roles() {
  const maxHours = Math.max(...ROLES.map((r) => r.hours));
  return (
    <section className="bx-section" id="roles">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Activity size={13} /> Time back, by role
          </span>
          <h2 className="bx-h2">Hours returned to every seat on the team</h2>
          <p className="bx-lede">
            These aren&apos;t vague &ldquo;productivity gains.&rdquo; Each
            estimate maps to specific Breathe automations that remove a
            recurring manual task from someone&apos;s week.
          </p>
        </div>
        <div className="bx-roles">
          {ROLES.map((r) => (
            <div className="bx-role bx-reveal" key={r.title}>
              <div className="bx-role-hours">
                <div className="n">{r.hours}</div>
                <div className="u">hrs / week</div>
                <div className="bar">
                  <i style={{ width: `${(r.hours / maxHours) * 100}%` }} />
                </div>
              </div>
              <div>
                <div className="bx-card-ico" style={{ marginBottom: 14 }}>
                  {r.icon}
                </div>
                <h3>{r.title}</h3>
                <p>{r.why}</p>
                <ul>
                  {r.drivers.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want every feature mapped to the seat that uses it?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/features">
            See what the software does, by role <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── ROI calculator ───────────────────────── */
/*
 * Illustrative, transparent model. Every coefficient is a stated,
 * conservative assumption shown to the operator — this is a directional
 * estimate, not a quote.
 */
const ROI = {
  // Labor: hours saved per staff per week (sum of role automations, blended
  // and discounted) × loaded hourly cost × 52.
  hoursPerStaffWeek: 9,
  loadedHourly: 34,
  // Revenue cycle: incremental net collections per active patient/yr from
  // higher first-pass acceptance + worked denials.
  rcmPerPatient: 16,
  // Resupply growth: incremental annual margin per active patient from
  // automated, eligibility-aware reorder outreach.
  resupplyPerPatient: 21,
  // Tool consolidation: retired point-tool licenses, per staff seat/yr.
  toolsPerStaff: 1500,
};

function computeRoi(patients: number, staff: number) {
  const labor = Math.round(
    staff * ROI.hoursPerStaffWeek * ROI.loadedHourly * 52,
  );
  const rcm = Math.round(patients * ROI.rcmPerPatient);
  const resupply = Math.round(patients * ROI.resupplyPerPatient);
  const tools = Math.round(staff * ROI.toolsPerStaff);
  const total = labor + rcm + resupply + tools;
  return { labor, rcm, resupply, tools, total };
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function Roi() {
  const [patients, setPatients] = useState(5000);
  const [staff, setStaff] = useState(12);
  const r = useMemo(() => computeRoi(patients, staff), [patients, staff]);

  const lines: { k: string; v: number; gold?: boolean }[] = [
    { k: "Staff time automated", v: r.labor },
    { k: "Revenue-cycle recovery", v: r.rcm },
    { k: "Resupply revenue growth", v: r.resupply, gold: true },
    { k: "Retired software licenses", v: r.tools },
  ];
  const max = Math.max(...lines.map((l) => l.v));

  return (
    <section className="bx-section" id="roi">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <LineChart size={13} /> Total cost savings
          </span>
          <h2 className="bx-h2">What Breathe is worth to your business</h2>
          <p className="bx-lede">
            Move the sliders to your size. The model adds up labor automation,
            revenue-cycle recovery, resupply growth, and the point tools Breathe
            replaces.
          </p>
        </div>

        <div className="bx-roi bx-reveal">
          <div className="bx-roi-panel bx-roi-controls">
            <h3>Your DME, roughly</h3>
            <p>Two inputs. Drag to match your operation.</p>

            <div className="bx-field">
              <div className="bx-field-top">
                <label htmlFor="bx-patients">Active patients</label>
                <span className="val">{patients.toLocaleString("en-US")}</span>
              </div>
              <input
                id="bx-patients"
                className="bx-range"
                type="range"
                min={500}
                max={25000}
                step={500}
                value={patients}
                onChange={(e) => setPatients(Number(e.target.value))}
              />
            </div>

            <div className="bx-field">
              <div className="bx-field-top">
                <label htmlFor="bx-staff">Staff members</label>
                <span className="val">{staff}</span>
              </div>
              <input
                id="bx-staff"
                className="bx-range"
                type="range"
                min={3}
                max={60}
                step={1}
                value={staff}
                onChange={(e) => setStaff(Number(e.target.value))}
              />
            </div>

            <p className="bx-roi-disclaimer">
              Assumptions (per year): {ROI.hoursPerStaffWeek} hrs/week saved per
              staff at {money(ROI.loadedHourly)}/hr loaded;{" "}
              {money(ROI.rcmPerPatient)} RCM recovery and{" "}
              {money(ROI.resupplyPerPatient)} resupply margin per active
              patient; {money(ROI.toolsPerStaff)}/seat in retired licenses.
              Directional estimate, not a quote.
            </p>
          </div>

          <div className="bx-roi-panel bx-roi-result">
            <div className="bx-roi-total-label">Estimated annual impact</div>
            <div className="bx-roi-total">{money(r.total)}</div>
            <div className="bx-roi-total-sub">
              ≈ {money(r.total / 12)} every month back in the business.
            </div>

            <div className="bx-roi-breakdown">
              {lines.map((l) => (
                <div
                  className={`bx-roi-line${l.gold ? " gold" : ""}`}
                  key={l.k}
                >
                  <span className="k">{l.k}</span>
                  <span className="v">{money(l.v)}</span>
                  <span className="track">
                    <i
                      style={{ width: `${Math.max(6, (l.v / max) * 100)}%` }}
                    />
                  </span>
                </div>
              ))}
            </div>

            <RoiEmailCapture patients={patients} staff={staff} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * "Email me this estimate" — captures the lead at peak intent. Posts the two
 * slider inputs (not the computed totals) to /api/roi-estimate, which
 * recomputes the numbers server-side, saves the address to the marketing
 * list, and emails the visitor the breakdown. Fail-soft: the backend always
 * 200s; `emailed:false` (e.g. provider offline) still confirms we captured
 * the request.
 */
function RoiEmailCapture({
  patients,
  staff,
}: {
  patients: number;
  staff: number;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "sent" | "captured" | "error"
  >("idle");
  const [err, setErr] = useState("");
  const hpRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setErr("Please enter a valid email address.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setErr("");
    try {
      const resp = await fetch("/api/roi-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: value,
          patients,
          staff,
          website: hpRef.current?.value || undefined,
        }),
      });
      if (!resp.ok) {
        setErr("Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      const data = (await resp.json().catch(() => ({}))) as {
        emailed?: boolean;
      };
      setStatus(data.emailed ? "sent" : "captured");
    } catch {
      setErr("Network error. Please try again.");
      setStatus("error");
    }
  };

  if (status === "sent" || status === "captured") {
    return (
      <div className="bx-roi-capture-done" role="status">
        <Check size={16} />
        {status === "sent"
          ? "Sent — check your inbox for the full breakdown."
          : "Got it — we have your numbers and will be in touch with the breakdown."}
      </div>
    );
  }

  return (
    <form className="bx-roi-capture" onSubmit={onSubmit} noValidate>
      <label className="bx-roi-capture-label" htmlFor="bx-roi-email">
        Email me this estimate
      </label>
      <div className="bx-roi-capture-row">
        {/* Honeypot — real users never see or fill this. */}
        <input
          ref={hpRef}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="bx-hp"
        />
        <input
          id="bx-roi-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          placeholder="you@yourdme.com"
          aria-label="Work email"
          aria-invalid={status === "error"}
        />
        <button
          type="submit"
          className="bx-btn bx-btn-primary bx-btn-sm"
          disabled={status === "submitting"}
        >
          {status === "submitting" ? (
            "Sending…"
          ) : (
            <>
              Email it <ArrowRight size={15} />
            </>
          )}
        </button>
      </div>
      {status === "error" ? (
        <span className="bx-demoform-err" role="alert">
          {err}
        </span>
      ) : null}
    </form>
  );
}

/* ───────────────────────── Pricing ───────────────────────── */
// Canonical platform catalog, mirrored from the billing seed in migration
// 0362 (resupply.billing_plans / billing_addons). Launch/Growth/Scale are
// is_public=true so their prices are shown; Enterprise is is_custom, so it
// shows "Custom" and never the internal number. Keep in sync if the seed
// prices change.
const PLANS: {
  name: string;
  price: string;
  cadence: string;
  // Monthly list price in cents, used to derive the annual (2-months-free)
  // option in the billing toggle. null for custom/contact tiers, which never
  // show a derived annual number.
  monthlyCents: number | null;
  setup: string;
  blurb: string;
  highlights: string[];
  featured?: boolean;
}[] = [
  {
    name: "Launch",
    price: "$799",
    cadence: "/mo",
    monthlyCents: 79900,
    setup: "+ $2,500 one-time onboarding",
    blurb: "Branded storefront and core resupply automation for a small DME.",
    highlights: [
      "5 staff seats · 500 active patients · 1 location",
      "Branded CPAP storefront + mask fitter",
      "Shop, cart, checkout, and order tracking",
      "Resupply reminders + subscription tracking",
    ],
  },
  {
    name: "Growth",
    price: "$1,899",
    cadence: "/mo",
    monthlyCents: 189900,
    setup: "+ $5,000 one-time onboarding",
    blurb:
      "Full resupply operations, outreach, documents, and billing worklists.",
    highlights: [
      "15 seats · 3,000 patients · 3 locations",
      "Everything in Launch",
      "Bulk campaigns, patient packets + e-signature",
      "Eligibility, prior auth, CMN/DIF, and A/R worklists",
    ],
    featured: true,
  },
  {
    name: "Scale",
    price: "$3,999",
    cadence: "/mo",
    monthlyCents: 399900,
    setup: "+ $10,000 one-time onboarding",
    blurb:
      "Multi-location automation, analytics, and AI controls at higher volume.",
    highlights: [
      "40 seats · 10,000 patients · 10 locations",
      "Everything in Growth",
      "Advanced financial, funnel, and LTV/CAC analytics",
      "Automation rules, Control Center, bot playground",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "",
    monthlyCents: null,
    setup: "Contracted volume + SLA",
    blurb:
      "For high-volume DME operations needing custom integration and support.",
    highlights: [
      "Everything in Scale",
      "Custom integration + migration plan",
      "Advanced security and account controls",
      "Dedicated success manager + priority SLA",
    ],
  },
];

// ── Live pricing from the platform billing catalog ──────────────────
// The super-admin edits plan + add-on prices in the platform portal and
// they land here with no redeploy (GET /api/platform/pricing). Fail-soft:
// a missing/empty response falls back to the static PLANS / ADDON_GROUPS
// copy in this file.
interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number | null;
  onboardingFeeCents: number | null;
  isCustom: boolean;
  allowances: Record<string, number>;
  features: string[];
}
interface PublicAddon {
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  recurringPriceCents: number | null;
  oneTimeMinCents: number | null;
  oneTimeMaxCents: number | null;
  unitLabel: string | null;
}
interface PublicPricing {
  plans: PublicPlan[];
  addons: PublicAddon[];
}

function usePublicPricing(): PublicPricing | null {
  const [data, setData] = useState<PublicPricing | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/pricing", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const b = body as { plans?: unknown; addons?: unknown } | null;
        const plans = b?.plans;
        if (Array.isArray(plans) && plans.length > 0) {
          setData({
            plans: plans as PublicPlan[],
            addons: Array.isArray(b?.addons)
              ? (b!.addons as PublicAddon[])
              : [],
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

function dollars(cents: number): string {
  const v = cents / 100;
  // Whole dollars render without decimals ("$799"); fractional amounts
  // keep cents ("$799.50") so we never misstate a non-round price.
  return Number.isInteger(v)
    ? `$${v.toLocaleString("en-US")}`
    : `$${v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

type PlanCard = (typeof PLANS)[number];

function liveToPlanCards(plans: PublicPlan[]): PlanCard[] {
  return plans.map((p) => ({
    name: p.name,
    // Custom/Enterprise tiers never show a concrete public price — even if
    // a negotiated amount is stored, the marketing page says "Custom".
    price: p.isCustom
      ? "Custom"
      : p.monthlyPriceCents == null
        ? "Contact us"
        : dollars(p.monthlyPriceCents),
    cadence: p.isCustom || p.monthlyPriceCents == null ? "" : "/mo",
    monthlyCents: p.isCustom ? null : p.monthlyPriceCents,
    setup: p.isCustom
      ? "Contracted volume + SLA"
      : p.onboardingFeeCents != null && p.onboardingFeeCents > 0
        ? `+ ${dollars(p.onboardingFeeCents)} one-time onboarding`
        : "Onboarding included",
    blurb: p.description ?? "",
    highlights: p.features.slice(0, 6),
    featured: p.code.toLowerCase() === "growth",
  }));
}

// Each item carries the catalog `code` so the row can surface the shared
// plain-language explainer (ADDON_DETAILS) in a collapsible dropdown; live
// catalog data fills the same shape via liveToAddonGroups().
type AddonItem = {
  name: string;
  price: string;
  code?: string;
  description?: string | null;
};

const ADDON_GROUPS: {
  group: string;
  items: AddonItem[];
}[] = [
  {
    group: "Premium modules",
    items: [
      {
        name: "AI voice agent / IVR",
        price: "$499/mo",
        code: "ai_voice_agent",
      },
      {
        name: "Advanced billing automation",
        price: "$699/mo",
        code: "advanced_billing_automation",
      },
      {
        name: "Advanced analytics suite",
        price: "$399/mo",
        code: "advanced_analytics",
      },
      {
        name: "Multi-location management",
        price: "$499/mo",
        code: "multi_location_management",
      },
      { name: "Fax automation", price: "$199/mo", code: "fax_automation" },
      {
        name: "Dedicated success manager",
        price: "$1,000/mo",
        code: "dedicated_success_manager",
      },
    ],
  },
  {
    group: "Capacity",
    items: [
      {
        name: "Additional staff seat",
        price: "$49/mo",
        code: "additional_seat",
      },
      {
        name: "Active-patient block (+500)",
        price: "$99/mo",
        code: "active_patient_block",
      },
      {
        name: "Additional location",
        price: "$199/mo",
        code: "additional_location",
      },
      {
        name: "Extra storage (+100 GB)",
        price: "$25/mo",
        code: "storage_100gb",
      },
    ],
  },
  {
    group: "Usage bundles",
    items: [
      {
        name: "SMS / email bundle (1,000)",
        price: "$50",
        code: "message_bundle",
      },
      { name: "AI text bundle (1,000)", price: "$40", code: "ai_text_bundle" },
      {
        name: "Claims / eligibility bundle (1,000)",
        price: "$75",
        code: "billing_transaction_bundle",
      },
    ],
  },
  {
    group: "Integrations & one-time",
    items: [
      {
        name: "Additional therapy-cloud vendor",
        price: "$299/mo",
        code: "additional_therapy_vendor",
      },
      {
        name: "Custom integration",
        price: "from $5,000",
        code: "custom_integration",
      },
      {
        name: "Data migration package",
        price: "$2,500–$15,000",
        code: "data_migration",
      },
      {
        name: "Custom domain + branding setup",
        price: "$500",
        code: "custom_domain_branding_setup",
      },
    ],
  },
];

const ADDON_CATEGORY_LABELS: Record<string, string> = {
  premium: "Premium modules",
  capacity: "Capacity",
  usage: "Usage bundles",
  integration: "Integrations & one-time",
  one_time: "Integrations & one-time",
};

function addonPrice(a: PublicAddon): string {
  if (a.recurringPriceCents != null)
    return `${dollars(a.recurringPriceCents)}/mo`;
  if (
    a.oneTimeMinCents != null &&
    a.oneTimeMaxCents != null &&
    a.oneTimeMaxCents !== a.oneTimeMinCents
  )
    return `${dollars(a.oneTimeMinCents)}–${dollars(a.oneTimeMaxCents)}`;
  if (a.oneTimeMinCents != null) return `from ${dollars(a.oneTimeMinCents)}`;
  return "—";
}

function liveToAddonGroups(addons: PublicAddon[]): typeof ADDON_GROUPS {
  const order: string[] = [];
  const byLabel = new Map<string, AddonItem[]>();
  for (const a of addons) {
    const label = ADDON_CATEGORY_LABELS[a.category ?? ""] ?? "Add-ons";
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      order.push(label);
    }
    byLabel.get(label)!.push({
      name: a.name,
      price: addonPrice(a),
      code: a.code,
      description: a.description,
    });
  }
  return order.map((group) => ({ group, items: byLabel.get(group)! }));
}

type BillingMode = "monthly" | "annual";

// Annual billing = pay for 10 months, get 12 (two months free). Returns the
// values a plan card shows in annual mode, or null when the tier has no
// derivable price (Custom / Contact us) and should fall back to its monthly
// string unchanged.
function annualView(
  monthlyCents: number | null,
): { effMonthly: string; perYear: string; saved: string } | null {
  if (monthlyCents == null || monthlyCents <= 0) return null;
  const perYearCents = monthlyCents * 10;
  return {
    effMonthly: dollars(Math.round(perYearCents / 12)),
    perYear: dollars(perYearCents),
    saved: dollars(monthlyCents * 2),
  };
}

/** Monthly ⇄ annual segmented control. Controlled by the parent so the
 *  landing teaser and the full pricing page each own their own state. */
function BillingToggle({
  mode,
  onChange,
}: {
  mode: BillingMode;
  onChange: (m: BillingMode) => void;
}) {
  return (
    <div
      className="bx-billtoggle bx-reveal"
      role="radiogroup"
      aria-label="Billing period"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === "monthly"}
        className={"bx-billtoggle-opt" + (mode === "monthly" ? " on" : "")}
        onClick={() => onChange("monthly")}
      >
        Monthly
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "annual"}
        className={"bx-billtoggle-opt" + (mode === "annual" ? " on" : "")}
        onClick={() => onChange("annual")}
      >
        Annual
        <span className="bx-billtoggle-save">2 months free</span>
      </button>
    </div>
  );
}

/** The four subscription packages. Reused on the landing page + pricing page.
 *  `cards` defaults to the static PLANS but is fed live catalog data by the
 *  Pricing section when the public pricing endpoint responds. `billing`
 *  switches every priced card between its monthly rate and the annual
 *  (2-months-free) equivalent. */
function PricingPlans({
  cards = PLANS,
  billing = "monthly",
}: {
  cards?: PlanCard[];
  billing?: BillingMode;
}) {
  return (
    <div className="bx-plan-grid">
      {cards.map((p) => {
        const annual = billing === "annual" ? annualView(p.monthlyCents) : null;
        return (
          <div
            className={"bx-plan bx-reveal" + (p.featured ? " featured" : "")}
            key={p.name}
          >
            {p.featured ? (
              <span className="bx-plan-badge">Most popular</span>
            ) : null}
            <div className="bx-plan-name">{p.name}</div>
            <div className="bx-plan-price">
              <span className="bx-plan-amt">
                {annual ? annual.effMonthly : p.price}
              </span>
              {p.cadence ? (
                <span className="bx-plan-cadence">{p.cadence}</span>
              ) : null}
            </div>
            {annual ? (
              <div className="bx-plan-annual">
                {annual.perYear}/yr billed annually · <b>save {annual.saved}</b>
              </div>
            ) : null}
            <div className="bx-plan-setup">{p.setup}</div>
            <p className="bx-plan-blurb">{p.blurb}</p>
            <ul className="bx-plan-list">
              {p.highlights.map((h) => (
                <li key={h}>
                  <Check size={15} />
                  {h}
                </li>
              ))}
            </ul>
            <Link
              className={
                "bx-btn bx-btn-sm " +
                (p.featured ? "bx-btn-primary" : "bx-btn-ghost")
              }
              href="/breathe/signup"
            >
              Create your account
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** A single add-on line. When a plain-language explainer is available (the
 *  shared ADDON_DETAILS map, keyed by catalog code, or the add-on's own
 *  description) the row becomes a collapsible <details> with a down-arrow
 *  that reveals a brief "what it does / why it matters" benefit blurb.
 *  Otherwise it renders the static name/price row unchanged. */
function PricingAddonRow({ item }: { item: AddonItem }) {
  const detail = item.code ? ADDON_DETAILS[item.code] : undefined;
  const fallback = item.description?.trim();
  if (!detail && !fallback) {
    return (
      <div className="bx-addon-row">
        <span className="bx-addon-name">{item.name}</span>
        <span className="bx-addon-price">{item.price}</span>
      </div>
    );
  }
  return (
    <details className="bx-addon-item">
      <summary className="bx-addon-row">
        <span className="bx-addon-name">
          {item.name}
          <ChevronDown
            className="bx-addon-caret"
            size={14}
            aria-hidden="true"
          />
        </span>
        <span className="bx-addon-price">{item.price}</span>
      </summary>
      <div className="bx-addon-detail">
        {detail ? (
          <>
            <p>
              <strong>What it does:</strong> {detail.whatItDoes}
            </p>
            <p>
              <strong>Why it matters:</strong> {detail.whyItMatters}
            </p>
          </>
        ) : (
          <p>{fallback}</p>
        )}
      </div>
    </details>
  );
}

/** The à la carte add-on catalog, grouped by category. `groups` defaults
 *  to the static ADDON_GROUPS but is fed live catalog data by the Pricing
 *  section when the public pricing endpoint responds. */
function PricingAddons({
  groups = ADDON_GROUPS,
}: {
  groups?: typeof ADDON_GROUPS;
}) {
  return (
    <div className="bx-addons bx-reveal">
      <div className="bx-addons-head">
        <Plug size={15} /> Add-ons — license only what you need
      </div>
      <div className="bx-addon-groups">
        {groups.map((g) => (
          <div className="bx-addon-group" key={g.group}>
            <div className="bx-addon-group-name">{g.group}</div>
            {g.items.map((it) => (
              <PricingAddonRow item={it} key={it.code ?? it.name} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Full pricing — packages + the complete add-on catalog. Tiers + add-on
   prices are driven by the live billing catalog (/api/platform/pricing)
   when available, falling back to the static PLANS / ADDON_GROUPS copy. */
function Pricing() {
  const { open: openDemoGate } = useDemoGate();
  const live = usePublicPricing();
  const [billing, setBilling] = useState<BillingMode>("monthly");
  const cards = live ? liveToPlanCards(live.plans) : PLANS;
  const groups =
    live && live.addons.length > 0
      ? liveToAddonGroups(live.addons)
      : ADDON_GROUPS;
  return (
    <section className="bx-section" id="pricing">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Pricing
          </span>
          <h2 className="bx-h2">
            Pick a package, <em>add only what you need</em>
          </h2>
          <p className="bx-lede">
            Transparent subscription tiers sized to your patient base — monthly
            or annual (two months free), with onboarding and migration included.
            Upload a CSV of your patients and you&apos;re live on day one, and
            your data stays yours — always exportable (back out to PacWare too).
            License premium modules à la carte.
          </p>
        </div>
        <BillingToggle mode={billing} onChange={setBilling} />
        <PricingPlans cards={cards} billing={billing} />
        <PricingAddons groups={groups} />
        <div className="bx-price-cta bx-reveal">
          <span>Not sure which package fits?</span>
          <button
            type="button"
            className="bx-btn bx-btn-primary"
            onClick={() => openDemoGate("breathe-pricing")}
          >
            Try it free first <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

/* Landing-page pricing — packages up front with an add-ons teaser; the full
   catalog lives on /breathe/pricing. */
function PricingHome() {
  const [billing, setBilling] = useState<BillingMode>("monthly");
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Pricing
          </span>
          <h2 className="bx-h2">
            One platform, <em>packaged for your size</em>
          </h2>
          <p className="bx-lede">
            Subscription tiers sized to your patient base — monthly or annual
            (two months free), with onboarding and migration included. Upload a
            CSV of your patients and you&apos;re live on day one. Add premium
            modules only when you need them.
          </p>
        </div>
        <BillingToggle mode={billing} onChange={setBilling} />
        <PricingPlans billing={billing} />
        <div className="bx-addons-teaser bx-reveal">
          <Plug size={15} />
          <span>
            Plus à la carte add-ons — AI voice agent, advanced billing
            automation, extra seats, locations, and more.
          </span>
          <Link className="bx-addons-teaser-link" href="/breathe/pricing">
            See full pricing &amp; add-ons <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Security ───────────────────────── */
const SECURITY: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <ScanFace size={20} />,
    title: "On-device patient imaging",
    body: "Camera frames for mask fitting never leave the browser — only numeric measurements are transmitted. Nothing image-derived is ever logged.",
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "HIPAA-eligible infrastructure",
    body: "Every AI and communications vendor in the stack is HIPAA-eligible, and patient data flows through a SOC 2-aligned posture.",
  },
  {
    icon: <KeyRound size={20} />,
    title: "Least-privilege access",
    body: "Granular, permission-gated admin roles mean each teammate sees only what their job requires — enforced at every route.",
  },
  {
    icon: <Database size={20} />,
    title: "PHI minimization",
    body: "Order payloads and patient images are treated as world-readable and kept out of application logs by design, not by policy alone.",
  },
  {
    icon: <Server size={20} />,
    title: "Tenant isolation",
    body: "Multi-tenant by architecture: your brand, sending domain, and patient data are cleanly separated from every other operator.",
  },
  {
    icon: <Network size={20} />,
    title: "Encrypted in transit",
    body: "Same-origin, strict-CSP delivery with TLS everywhere — no third-party trackers or font CDNs reaching into patient sessions.",
  },
];

function Security() {
  return (
    <section className="bx-section" id="security">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Lock size={13} /> Trust &amp; security
          </span>
          <h2 className="bx-h2">Built for PHI from the first line of code</h2>
          <p className="bx-lede">
            Patient privacy isn&apos;t a settings page — it&apos;s an
            architectural invariant. The hard rules are enforced in the
            codebase, not left to operator discipline.
          </p>
        </div>
        <div className="bx-sec-grid">
          {SECURITY.map((s) => (
            <div className="bx-sec-card bx-reveal" key={s.title}>
              <div className="bx-sec-ic">{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────── Shared capability card + deepening sections ───────────── */
/*
 * Small reusable card for the .bx-caps grid (Capability shape). The
 * homepage Capabilities / Compare WhyDifferent bands inline this same
 * markup; the deepening sections below render through this helper.
 */
export function CapCard({ c }: { c: Capability }) {
  return (
    <article className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}>
      <div className="bx-cap-head">
        <span className="bx-cap-ic">{c.icon}</span>
        <div>
          <h3>{c.title}</h3>
          <p className="bx-cap-summary">{c.summary}</p>
        </div>
      </div>
      <ul className="bx-cap-list">
        {c.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </article>
  );
}

/* Security page — the concrete control list a compliance review reads. */
const SECURITY_POSTURE: Capability[] = [
  {
    icon: <KeyRound size={20} />,
    title: "Authentication, in-house",
    summary: "Identity is ours — no third-party SSO vendor in the loop.",
    points: [
      "argon2id password hashing",
      "TOTP multi-factor with recovery codes",
      "DB-backed sessions + CSRF protection",
      "Rate-limited auth endpoints",
    ],
  },
  {
    icon: <Database size={20} />,
    title: "Data handling",
    summary: "PHI minimized by architecture, not policy alone.",
    points: [
      "Order payloads & images kept out of logs",
      "Mask imaging on-device — frames never transmitted",
      "Per-object storage access control",
      "Your data exports on demand — no lock-in",
    ],
    gold: true,
  },
  {
    icon: <Server size={20} />,
    title: "Access & isolation",
    summary: "Least-privilege, multi-tenant by design.",
    points: [
      "Permission-gated admin routes, every mutation",
      "Per-tenant brand, sending domain & data separation",
      "Strict-CSP, same-origin delivery — no trackers",
      "HIPAA-eligible vendors end to end",
    ],
  },
];

function SecurityPosture() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldCheck size={13} /> The control list
          </span>
          <h2 className="bx-h2">
            The specifics your compliance team will ask for
          </h2>
          <p className="bx-lede">
            Not a trust-us badge — the concrete controls, grouped the way a
            security review actually reads them.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {SECURITY_POSTURE.map((c) => (
            <CapCard c={c} key={c.title} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ROI page — what each lever in the calculator actually models. */
const ROI_LEVERS: Capability[] = [
  {
    icon: <Activity size={20} />,
    title: "Staff time recovered",
    summary: "≈ 9 hrs / staff / week automated, at a $34 loaded hourly cost.",
    points: [
      "Routine resupply & status calls handled by the AI voice agent",
      "Eligibility, scrubbing, submission & posting run end to end",
      "Adherence worklists replace manual report-pulling",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Revenue-cycle recovery",
    summary: "≈ $16 / active patient / yr from cleaner claims.",
    points: [
      "Higher first-pass acceptance on AI-scrubbed 837Ps",
      "Denials worked, ranked by recoverable dollars",
      "Fewer timely-filing write-offs",
    ],
    gold: true,
  },
  {
    icon: <RefreshCw size={20} />,
    title: "Resupply growth",
    summary: "≈ $21 / active patient / yr in incremental margin.",
    points: [
      "Eligibility-aware reorder outreach across SMS, email & voice",
      "One-tap signed reorders — no portal friction",
      "Replacement windows that used to slip get captured",
    ],
  },
  {
    icon: <CircleDollarSign size={20} />,
    title: "Tools retired",
    summary: "≈ $1,500 / seat / yr in point-tool licenses you drop.",
    points: [
      "Resupply, RCM, CRM, telehealth, e-sign & IVR in one platform",
      "No per-module upsells or integration glue to maintain",
      "Your data exports back out on demand",
    ],
  },
];

function RoiAssumptions() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Gauge size={13} /> How the model works
          </span>
          <h2 className="bx-h2">Every number, traced to a lever</h2>
          <p className="bx-lede">
            The estimate is directional, not a quote — but each coefficient is a
            stated, conservative assumption you can see and challenge.
          </p>
        </div>
        <div className="bx-caps">
          {ROI_LEVERS.map((c) => (
            <CapCard c={c} key={c.title} />
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>
            New to this category? See what an all-in-one DME platform changes.
          </span>
          <Link className="bx-btn bx-btn-ghost" href="/breathe/why">
            DME Platform 101 <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* Pricing page — the cost questions buyers ask before they switch. */
const PRICING_FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Is it really one price, or per-module like legacy suites?",
    a: "One platform price covers the core — resupply, revenue cycle, patient communications, clinical monitoring, the storefront, and analytics. There are no per-module unlocks to discover later. A short list of à la carte add-ons (the AI voice agent, advanced billing automation, extra seats and locations) is published in the open, not negotiated line by line.",
  },
  {
    q: "Is there a long-term contract?",
    a: "No multi-year lock-in. Pricing is transparent and month-to-month, and your data is yours — exportable on demand, including back out to PacWare. The goal is to keep earning the relationship, not to trap it.",
  },
  {
    q: "How fast can we be live?",
    a: "Day one. Upload a CSV of your patients and your team starts the same day; the deeper payer, clearinghouse, and device-cloud connections come online over the following weeks, not quarters. The roster import is a fill-only sync, so there's no risky big-bang cutover.",
  },
  {
    q: "What does it replace?",
    a: "For most operators, the platform retires a stack of point tools — separate resupply software, an RCM/billing suite, a patient CRM, a telehealth app, a document/e-sign tool, therapy dashboards, and a call-center IVR — into one login. The ROI calculator models that consolidation per seat.",
  },
];

function PricingFaq() {
  return (
    <section className="bx-section">
      <div className="bx-shell bx-faq-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Pricing questions
          </span>
          <h2 className="bx-h2">Straight answers on cost</h2>
          <p className="bx-lede">
            How it&apos;s priced, what it replaces, and why there&apos;s no
            per-module surprise waiting after you sign.
          </p>
        </div>
        <div className="bx-faq bx-reveal">
          {PRICING_FAQ.map((f) => (
            <details className="bx-faq-item" key={f.q}>
              <summary>
                <span>{f.q}</span>
                <ChevronDown className="bx-faq-chev" size={18} />
              </summary>
              <div className="bx-faq-a">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Onboarding / migration ───────────────────────── */
const STEPS: {
  icon: React.ReactNode;
  n: string;
  title: string;
  body: string;
}[] = [
  {
    icon: <Database size={20} />,
    n: "01",
    title: "Import your patients — day one",
    body: "Upload a CSV of your current patients and they're in the system the same day. The importer is pre-mapped to PacWare's export, but any billing or CRM system that can export your roster to CSV works just as well. It's a fill-only sync — new patients are added and blank fields filled, while an existing value is never overwritten.",
  },
  {
    icon: <Plug size={20} />,
    n: "02",
    title: "Configure & connect",
    body: "Wire up your payers, clearinghouse, branding, sender email address, and reminder schedules. Switch on each AI feature one at a time, at your own pace.",
  },
  {
    icon: <Zap size={20} />,
    n: "03",
    title: "Go live the same day",
    body: 'Your team starts in a console they grasp in minutes — no training project to schedule. An in-app assistant answers "how do I…" questions right where the work happens, and email support is a message away through your first resupply run and first claim batch.',
  },
];

export function Onboarding() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <GitBranch size={13} /> Migration
          </span>
          <h2 className="bx-h2">Ready on day one</h2>
          <p className="bx-lede">
            Moving off legacy DME software is the scariest part — so we made it
            the easiest. Upload a CSV of your patients and you&apos;re running
            the same day; the deeper payer and device-cloud connections come
            online over the following weeks. Your data comes with you, and
            nothing you already have gets clobbered.
          </p>
        </div>
        <div className="bx-steps">
          {STEPS.map((s) => (
            <div className="bx-step bx-reveal" key={s.n}>
              <span className="bx-step-n">{s.n}</span>
              <div className="bx-step-ic">{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Manifesto ───────────────────────── */
function Manifesto() {
  return (
    <section className="bx-section bx-manifesto-section">
      <div className="bx-shell">
        <figure className="bx-manifesto bx-reveal">
          <Quote className="bx-quote-mark" size={40} aria-hidden="true" />
          <blockquote>
            DME software was built for billing departments. We built Breathe for
            patients — and for the people who care for them.
          </blockquote>
          <figcaption>
            <img src={LOGO} alt="" />
            <span>
              <b>The CareMetric.ai team</b>
              <i>Why we built Breathe</i>
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ───────────────────────── FAQ ───────────────────────── */
const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Will it work with our billing system?",
    a: "Yes. Breathe exchanges patient and worklist data with PacWare over CSV and builds standard ASC X12 5010 837P claims. Once the AI scrubs them clean you have a choice: submit automatically through the built-in Office Ally integration, or download the 837P and upload it to the clearinghouse of your choice. Either way, ERAs (835) post back and reconcile automatically. PacWare stays your system of record for the warehouse; Breathe runs the resupply and revenue engine on top.",
  },
  {
    q: "Can we import our current patients?",
    a: "Yes — on day one. Export your patient roster to a CSV and upload it, and your patients are in the system the same day. The importer is pre-mapped to PacWare's export format, but any billing or CRM system that can produce a CSV of your patients works. It runs as a fill-only sync — new patients are added and blank fields filled, and an existing value is never overwritten — so you can re-import as often as you like with no risk of clobbering data.",
  },
  {
    q: "How long does implementation take?",
    a: "You can be working on day one — upload a CSV of your patients and your team starts the same day. The deeper connections (payers, clearinghouse, device clouds) come online over the following weeks, not quarters. Because the roster imports as a fill-only sync — new patients added and blank fields filled, an existing value never overwritten — there is no risky big-bang cutover.",
  },
  {
    q: "Is our patient data safe?",
    a: "Privacy is architectural. Mask-fitting images are processed on-device and never transmitted, order payloads and images are kept out of application logs by design, admin access is least-privilege and permission-gated, and every AI vendor in the stack is HIPAA-eligible.",
  },
  {
    q: "Does the AI replace my staff?",
    a: "No — it removes the repetitive work so your team can do the human parts. The voice agent leaves a summary for review, claims are scrubbed before a person approves them, and the admin copilot always confirms before it sends anything. People stay in the loop.",
  },
  {
    q: "Which device clouds do you support?",
    a: "ResMed AirView, Philips Care Orchestrator, and 3B React Health today, with adherence pulled nightly and surfaced as a prioritized worklist of who is slipping and who is due.",
  },
  {
    q: "Do we own our data?",
    a: "Always. Your patients, orders, and history are yours — exportable on demand, including back out to PacWare. No lock-in, no hostage data.",
  },
];

function Faq() {
  return (
    <section className="bx-section" id="faq">
      <div className="bx-shell bx-faq-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <MessageSquare size={13} /> Questions
          </span>
          <h2 className="bx-h2">What DME owners ask us first</h2>
          <p className="bx-lede">
            Straight answers on the things that actually decide a switch —
            integrations, migration risk, security, and what the AI does and
            does not do.
          </p>
        </div>
        <div className="bx-faq bx-reveal">
          {FAQ.map((f) => (
            <details className="bx-faq-item" key={f.q}>
              <summary>
                <span>{f.q}</span>
                <ChevronDown className="bx-faq-chev" size={18} />
              </summary>
              <div className="bx-faq-a">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Who it's for ─────────────────────────
 * Business-profile self-qualification ("is this me?"), complementing the
 * role-based personas on /breathe/why. Reuses the exported CapCard +
 * .bx-caps grid, so no new markup or CSS. Capability-based, not customer
 * claims — honest for a pre-launch platform. */
const AUDIENCES: Capability[] = [
  {
    icon: <Store size={20} />,
    title: "Independent CPAP & DME providers",
    summary: "Run the whole operation without adding headcount.",
    points: [
      "Resupply reminders and the AI voice agent handle the busywork",
      "Claims scrubbed and submitted without a billing department",
      "One login instead of the seven point tools you pay for today",
    ],
  },
  {
    icon: <Network size={20} />,
    title: "Growing & multi-site DMEs",
    summary: "Scale the panel, not the payroll.",
    points: [
      "One patient record and one workflow across every location",
      "Live margin, DSO, and growth dashboards across the business",
      "Stand up a new site in weeks with a CSV import, not a quarter",
    ],
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Sleep & CPAP-focused suppliers",
    summary: "Keep patients on therapy and supplies on schedule.",
    points: [
      "ResMed, Philips & 3B adherence pulled nightly into one worklist",
      "Eligibility-aware resupply on every patient's reorder window",
      "Browser mask-fitter — images never leave the patient's device",
    ],
    gold: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Billing-led / RCM operations",
    summary: "Get paid the first time, faster.",
    points: [
      "AI scrubs every 837P clean, then auto-submits or exports it",
      "Denials ranked by recoverable dollars × win probability",
      "Eligibility (270/271), prior auth, and ERA posting automated",
    ],
  },
];

function Audiences() {
  return (
    <section className="bx-section" id="who-its-for">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Users size={13} /> Who it&apos;s for
          </span>
          <h2 className="bx-h2">Built for the people who run resupply</h2>
          <p className="bx-lede">
            Whether you&apos;re a one-location shop or a multi-site group,
            Breathe runs the resupply, billing, and therapy monitoring on one
            record — see where you fit.
          </p>
        </div>
        <div className="bx-caps">
          {AUDIENCES.map((c) => (
            <CapCard c={c} key={c.title} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Founding partner ─────────────────────────
 * Turns "pre-launch" into the pitch instead of hiding it. CareMetric
 * Breathe is newly launched, so rather than fake logos or testimonials we
 * make an honest early-access offer: a small cohort of founding DME
 * partners who lock in founding pricing, get a direct line to the team,
 * and help shape the roadmap. Reuses the .bx-pillar grid + .bx-cta button
 * styles, so it needs only a thin wrapper of new CSS. */
const FOUNDING_PERKS: { icon: React.ReactNode; title: string; body: string }[] =
  [
    {
      icon: <CircleDollarSign size={20} />,
      title: "Founding pricing, locked in",
      body: "Lock today's rate for the life of your account — it never goes up as we add capabilities and the list price does.",
    },
    {
      icon: <GitBranch size={20} />,
      title: "Shape the roadmap",
      body: "A direct line to the people building Breathe. The features you need get prioritized because you asked for them.",
    },
    {
      icon: <Headphones size={20} />,
      title: "White-glove migration",
      body: "We sit with you through the CSV import, your first resupply run, and your first claim batch — hands-on, not a ticket queue.",
    },
  ];

function FoundingPartner() {
  const { open: openDemoGate } = useDemoGate();
  return (
    <section className="bx-section bx-founding-section" id="founding">
      <div className="bx-shell">
        <div className="bx-founding bx-reveal">
          <div className="bx-section-head center">
            <span className="bx-eyebrow">
              <Sparkles size={13} /> Early access
            </span>
            <h2 className="bx-h2">Become a founding DME partner</h2>
            <p className="bx-lede">
              Breathe is newly launched, and we&apos;re onboarding a small group
              of founding providers by hand. Get in early and you don&apos;t
              just use the platform — you help shape it, at a price that never
              moves.
            </p>
          </div>
          <div className="bx-founding-grid">
            {FOUNDING_PERKS.map((p) => (
              <article className="bx-founding-perk" key={p.title}>
                <span className="bx-founding-ic">{p.icon}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
          <div className="bx-founding-cta">
            <Link className="bx-btn bx-btn-gold" href="/breathe/signup">
              Claim a founding spot <ArrowRight size={17} />
            </Link>
            <button
              type="button"
              className="bx-btn bx-btn-ghost"
              onClick={() => openDemoGate("breathe-founding")}
            >
              See it first
            </button>
          </div>
          <p className="bx-founding-fine">
            No credit card to start · founding terms confirmed in writing before
            you commit
          </p>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Closing CTA ───────────────────────── */
export function ClosingCta() {
  const { openContact } = useDemoGate();
  return (
    <section className="bx-section" id="demo">
      <div className="bx-shell">
        <div className="bx-cta bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> Ready when you are
          </span>
          <h2>Give your team room to breathe.</h2>
          <p>
            Jump straight into the live console on sample data — no call, no
            credit card. Enter your email and you&apos;re in. When you&apos;re
            ready, create your account in minutes.
          </p>
          <DemoEmailForm source="breathe-cta" cta="Start the demo" />
          <div className="bx-cta-row">
            <Link className="bx-btn bx-btn-gold" href="/breathe/signup">
              Create your account <ArrowRight size={17} />
            </Link>
            <Link className="bx-btn bx-btn-ghost" href="/breathe/product">
              Explore the platform
            </Link>
            <button
              type="button"
              className="bx-btn bx-btn-ghost"
              onClick={() => openContact("breathe-cta")}
            >
              Contact support
            </button>
          </div>
          <div className="bx-cta-meta">
            <span>
              <Radio size={13} /> No credit card
            </span>
            <span>
              <Check size={13} /> Sample data only
            </span>
            <span>
              <ArrowUpRight size={13} /> Live on day one
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Footer ───────────────────────── */
function Footer() {
  return (
    <footer className="bx-footer">
      <div className="bx-shell bx-footer-inner">
        <Link className="bx-brand" href="/breathe">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </Link>
        <p className="bx-footer-note">
          Breathe is the AI-native operating platform for durable medical
          equipment providers, built by CareMetric.ai. HIPAA-eligible
          infrastructure; patient imagery is processed on-device and never
          transmitted.
        </p>
        <div className="bx-footer-contact">
          <span className="bx-footer-contact-label">
            <Headphones size={13} aria-hidden="true" />
            Customer &amp; tech support
          </span>
          <a className="bx-footer-contact-link" href="tel:+18775212890">
            <PhoneCall size={13} aria-hidden="true" />
            (877) 521-2890
            <span className="bx-footer-contact-toll">toll-free</span>
          </a>
          <a
            className="bx-footer-contact-link"
            href="mailto:info@cmbreathe.com"
          >
            <Mail size={13} aria-hidden="true" />
            info@cmbreathe.com
          </a>
        </div>
        <div className="bx-brand-sub">
          © {new Date().getFullYear()} CareMetric.ai
        </div>
      </div>
      <nav className="bx-shell bx-footer-nav" aria-label="Breathe pages">
        {FOOTER_LINKS.map((l) => (
          <Link className="bx-footer-link" href={l.href} key={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="bx-footer-admin">
        <Link
          href="/platform"
          className="bx-footer-admin-link"
          data-testid="breathe-super-admin-login"
        >
          <Lock size={13} aria-hidden="true" />
          Super admin login
        </Link>
      </div>
    </footer>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * True when the user has asked the OS to minimize non-essential motion.
 * Centralizes the check shared by the scroll, count-up, and hero-parallax
 * effects so they all honor the preference identically.
 */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Enables smooth anchor scrolling for the in-page nav while Breathe is
 * mounted, restoring the prior value on unmount so it never leaks onto
 * other SPA routes. Skipped entirely under prefers-reduced-motion.
 */
function useSmoothScroll() {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = prev;
    };
  }, []);
}

/**
 * Scrolls to the URL hash target on mount. A deep link / cross-page
 * navigation like `/breathe#roi` would otherwise land at the top of the
 * page, because this surface is lazy-loaded — the browser's native hash
 * jump fires before the React content (and the `#roi` section) has
 * mounted. We retry on a few animation frames until the target exists,
 * then scroll to it (honoring prefers-reduced-motion). No hash, or a
 * hash that never resolves, is a silent no-op.
 */
function useInitialHashScroll() {
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || hash === "#" || hash === "#top") return;
    let frame = 0;
    let tries = 0;
    const tryScroll = () => {
      let el: Element | null;
      try {
        el = document.querySelector(hash);
      } catch {
        return; // malformed selector — nothing to do
      }
      if (el) {
        el.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
        return;
      }
      if (tries++ < 60) frame = requestAnimationFrame(tryScroll);
    };
    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }, []);
}

/**
 * Adds an `.in` class to every `.bx-reveal` element as it scrolls into
 * view, driving the staggered fade-up. Falls back to "everything
 * visible" when IntersectionObserver is unavailable.
 */
function useRevealOnScroll() {
  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".breathe-page .bx-reveal:not(.in)",
      ),
    );
    if (typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
}

/**
 * Counts from 0 to `to` once the element scrolls into view. Respects
 * prefers-reduced-motion by jumping straight to the final value.
 */
function CountUp({
  to,
  suffix = "",
  prefix = "",
}: {
  to: number;
  suffix?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setVal(to);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || done.current) return;
        done.current = true;
        const start = performance.now();
        const dur = 1300;
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          setVal(Math.round(to * eased));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        io.disconnect();
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to]);

  return (
    <span ref={ref}>
      {prefix}
      {val}
      {suffix}
    </span>
  );
}

export default BreatheHome;

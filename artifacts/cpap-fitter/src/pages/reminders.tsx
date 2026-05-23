import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useSubscribeToReminders,
  ApiError,
} from "@workspace/api-client-react/storefront";
import { useShopIdentity } from "@/lib/identity";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  Bell,
  CheckCircle2,
  MailCheck,
  Repeat,
  Sparkles,
  Truck,
} from "lucide-react";
import {
  REMINDER_ITEMS,
  todayIso,
  type ReminderSku,
} from "@/lib/reminder-defaults";

const PAGE_TITLE = "Supply replacement reminders";

interface ItemState {
  enabled: boolean;
  lastReplacedAt: string;
  intervalDays: number;
}

function buildInitialState(): Record<ReminderSku, ItemState> {
  const today = todayIso();
  const out = {} as Record<ReminderSku, ItemState>;
  for (const def of REMINDER_ITEMS) {
    out[def.sku] = {
      enabled: def.defaultEnabled,
      lastReplacedAt: today,
      intervalDays: def.defaultIntervalDays,
    };
  }
  return out;
}

// Forward-port of main commit 1e50795 (Task #18) — the API no longer
// returns `manageToken` or `alreadySubscribed`; both new + existing
// branches share the same "check your inbox" success shape.
interface SuccessState {
  emailStatus: "sent" | "skipped" | "failed";
  message: string;
}

export function Reminders() {
  useDocumentTitle(PAGE_TITLE);
  const [, setLocation] = useLocation();
  // P5 — for signed-in shoppers we skip the magic-link round-trip and
  // SPA-route straight to /reminders/manage on successful subscribe.
  // The manage page resolves the row by session email, so the patient
  // never has to leave the SPA, open their inbox, or click a token
  // link to edit a list they just typed.
  const { isSignedIn, isLoaded: identityLoaded, email: identityEmail } =
    useShopIdentity();
  const [email, setEmail] = useState(identityEmail ?? "");

  useEffect(() => {
    if (!identityLoaded || !identityEmail) return;
    setEmail((prev) => prev || identityEmail);
  }, [identityLoaded, identityEmail]);
  const [website, setWebsite] = useState(""); // honeypot
  const [items, setItems] = useState(buildInitialState);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const { mutate, isPending, error } = useSubscribeToReminders();

  function toggleItem(sku: ReminderSku, checked: boolean) {
    setItems((prev) => ({
      ...prev,
      [sku]: { ...prev[sku], enabled: checked },
    }));
  }
  function updateItem(sku: ReminderSku, patch: Partial<ItemState>) {
    setItems((prev) => ({ ...prev, [sku]: { ...prev[sku], ...patch } }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const enabledItems = REMINDER_ITEMS.filter((d) => items[d.sku].enabled).map(
      (d) => ({
        sku: d.sku,
        lastReplacedAt: items[d.sku].lastReplacedAt,
        intervalDays: items[d.sku].intervalDays,
      }),
    );

    if (enabledItems.length === 0) {
      setValidationError("Pick at least one supply to be reminded about.");
      return;
    }
    if (!email.trim()) {
      setValidationError("Enter the email where you want reminders sent.");
      return;
    }

    const submittedEmail = email.trim();
    const willSkipTokenStep =
      isSignedIn &&
      identityEmail !== null &&
      submittedEmail.toLowerCase() === identityEmail.toLowerCase();

    mutate(
      {
        data: {
          email: submittedEmail,
          items: enabledItems,
          website: website || undefined,
        },
      },
      {
        onSuccess: (resp) => {
          if (willSkipTokenStep) {
            // Signed-in subscriber subscribing under their own email:
            // jump straight into the manage page. The backend's manage
            // route will resolve the new row by session email.
            setLocation("/reminders/manage");
            return;
          }
          setSuccess({
            emailStatus: resp.emailStatus,
            message: resp.message,
          });
          // Scroll the success card into view on mobile so the user
          // notices the confirmation rather than thinking nothing happened.
          window.scrollTo({ top: 0, behavior: "smooth" });
        },
      },
    );
  }

  if (success) {
    return (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-2xl mx-auto px-4 py-12"
        >
          <Card className="border-0 glass-card rounded-2xl">
            <CardHeader className="text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <CardTitle className="text-2xl tracking-tight">
                Check your inbox
              </CardTitle>
              <CardDescription>{success.message}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {success.emailStatus !== "sent" && (
                <Alert>
                  <MailCheck className="w-4 h-4" />
                  <AlertTitle>Could not send the manage email</AlertTitle>
                  <AlertDescription>
                    Email delivery isn't configured right now — please reach out
                    to Penn Home Medical Supply directly so we can send you your
                    manage link.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-3">
                <Link href="/">
                  <Button variant="ghost">Back to PennPaps</Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </main>
    );
  }

  // Type the mutation error so we can read the typed `.data.error` payload
  // without sprinkling `as any`. Mirrors the order.tsx pattern.
  const apiError = error as ApiError<{
    error?: string;
    details?: string[];
  }> | null;
  const apiErrorMessage = apiError
    ? (apiError.data?.error ??
      apiError.message ??
      "Could not save your subscription. Please try again.")
    : null;

  return (
      <main
        id="main-content"
        tabIndex={-1}
        className="relative z-10 container max-w-3xl mx-auto px-4 py-10"
      >
        <div className="text-center space-y-3 mb-8">
          <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-gold flex items-center justify-center">
            <Truck className="w-6 h-6" />
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-[hsl(var(--penn-navy-deep))]">
            Never run out of CPAP supplies
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Subscribe and we'll auto-ship the right replacements on your
            schedule. Same price as one-time. Pause or cancel anytime — no phone
            calls, no insurance hoops.
          </p>
        </div>

        {/*
          Primary CTA — Subscribe & ship. Per the /reminders restructure
          (item #5), auto-ship is the hero. The link sends the patient
          to /shop with a fragment so the shop page can scroll to or
          surface the subscribe-default consumables (filters, cushions,
          tubing). The fragment is non-blocking: /shop renders identically
          if it's missing, and the toggles default to subscribe on
          consumables anyway.
        */}
        <div
          className="glass-card rounded-2xl p-6 mb-6 border-l-4 border-l-[hsl(var(--penn-gold))]"
          data-testid="reminders-subscribe-hero"
        >
          <div className="flex items-start gap-4">
            <div className="hidden sm:flex w-12 h-12 rounded-xl icon-halo-gold items-center justify-center shrink-0">
              <Repeat className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-[hsl(var(--penn-navy))]">
                Subscribe &amp; ship
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Pick your supplies once, get them shipped on the schedule that
                matches your insurance allowance. Cancel anytime from your
                account.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" data-testid="reminders-subscribe-cta">
                  <Link href="/shop#autoship">
                    <Truck className="w-4 h-4 mr-2" />
                    Browse auto-ship supplies
                  </Link>
                </Button>
                <p className="text-xs text-muted-foreground">
                  Same price as one-time · no membership fee · cancel anytime
                </p>
              </div>
            </div>
          </div>
        </div>

        {/*
          Secondary path — email-only reminders. Demoted from hero to a
          collapsed expandable card so existing users can still get the
          old behaviour, but it's no longer competing with subscribe.
          Kept fully functional and untouched below so existing tests
          and Sendgrid plumbing still work.
        */}
        <div
          className="text-center mb-6"
          data-testid="reminders-email-secondary"
        >
          <p className="text-sm text-muted-foreground inline-flex items-center gap-2">
            <Bell className="w-3.5 h-3.5" />
            Not ready to subscribe?{" "}
            <a
              href="#email-reminders"
              className="font-medium text-primary hover:underline"
            >
              Just remind me by email →
            </a>
          </p>
        </div>

        <Card
          id="email-reminders"
          className="border-0 glass-card rounded-2xl scroll-mt-24"
        >
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[hsl(var(--penn-gold))]" />
              Sign up for free reminders
            </CardTitle>
            <CardDescription>
              Adjust the intervals if your insurance covers a different cadence
              — you can always change them later.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-6" noValidate>
              <div className="space-y-2">
                <Label htmlFor="reminder-email">Email</Label>
                <Input
                  id="reminder-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  data-testid="input-reminder-email"
                />
              </div>

              {/* Honeypot — visually hidden, not focusable, ignored by humans. */}
              <div
                aria-hidden="true"
                className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden"
              >
                <Label htmlFor="reminder-website">Website (leave blank)</Label>
                <Input
                  id="reminder-website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <fieldset className="space-y-4">
                <legend className="text-sm font-medium mb-2">
                  What should we remind you about?
                </legend>
                <div className="space-y-3">
                  {REMINDER_ITEMS.map((def) => {
                    const state = items[def.sku];
                    return (
                      <div
                        key={def.sku}
                        className="rounded-xl border bg-background/60 p-4 space-y-3"
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            id={`item-${def.sku}`}
                            checked={state.enabled}
                            onCheckedChange={(c) =>
                              toggleItem(def.sku, c === true)
                            }
                            data-testid={`checkbox-${def.sku}`}
                          />
                          <div className="flex-1">
                            <Label
                              htmlFor={`item-${def.sku}`}
                              className="text-base cursor-pointer"
                            >
                              {def.label}
                            </Label>
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {def.description}
                            </p>
                          </div>
                        </div>
                        {state.enabled && (
                          <div className="grid sm:grid-cols-2 gap-3 pl-7">
                            <div className="space-y-1">
                              <Label
                                htmlFor={`last-${def.sku}`}
                                className="text-xs text-muted-foreground"
                              >
                                Last replaced
                              </Label>
                              <Input
                                id={`last-${def.sku}`}
                                type="date"
                                max={todayIso()}
                                value={state.lastReplacedAt}
                                onChange={(e) =>
                                  updateItem(def.sku, {
                                    lastReplacedAt: e.target.value,
                                  })
                                }
                                data-testid={`input-last-${def.sku}`}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label
                                htmlFor={`interval-${def.sku}`}
                                className="text-xs text-muted-foreground"
                              >
                                Remind every (days)
                              </Label>
                              <Input
                                id={`interval-${def.sku}`}
                                type="number"
                                min={1}
                                max={365}
                                value={state.intervalDays}
                                onChange={(e) =>
                                  updateItem(def.sku, {
                                    intervalDays: Math.max(
                                      1,
                                      Math.min(
                                        365,
                                        Number(e.target.value) ||
                                          def.defaultIntervalDays,
                                      ),
                                    ),
                                  })
                                }
                                data-testid={`input-interval-${def.sku}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              {(validationError || apiErrorMessage) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {validationError ?? apiErrorMessage}
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  disabled={isPending}
                  data-testid="button-subscribe"
                >
                  {isPending ? "Saving…" : "Sign me up"}
                </Button>
                <Link href="/">
                  <Button type="button" variant="ghost">
                    Cancel
                  </Button>
                </Link>
              </div>

              <p className="text-xs text-muted-foreground">
                We'll only use your email to send these reminders and any
                follow-ups about your supplies. Unsubscribe with one click any
                time. We never sell your email.
              </p>
            </form>
          </CardContent>
        </Card>
      </main>
  );
}

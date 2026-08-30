// /fit-request — where the mask fitter ends.
//
// The fitter used to end at /order: the patient typed their own shipping
// address, insurance member ID and prescriber into a form that inserted
// straight into the DME's order queue, unreviewed. This page replaces
// that with a REQUEST, in two shapes the patient chooses between:
//
//   "full_details" — they fill in what they know. Insurance is OPTIONAL,
//     which is the whole point: a patient who cannot find their member
//     ID should not be stuck, because a person is going to verify it
//     anyway.
//   "callback"     — they just ask to be contacted. Contact details and
//     nothing else.
//
// Contact fields: email is required (the /consent gate means every
// patient reaching this page already has one, and it is prefilled), and
// a phone number is asked for only when they chose to be reached by
// phone or text. Someone who picked email should not have to invent a
// number to ask for help.
//
// Nothing here creates an order, a claim, or a shipment, and the
// confirmation deliberately hands back no order number — an order-shaped
// reference for something no one has looked at yet would set exactly the
// wrong expectation.
//
// The mode arrives as `?mode=callback` from the results page, so the two
// CTAs there land on the right form without a second choice screen.

import React, { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCompanyContact } from "@/lib/contact";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  PhoneCall,
  ShieldCheck,
} from "lucide-react";
import { Field } from "@/components/form-field";
import { PopulationGate } from "@/components/population-gate";
import { track } from "@/lib/track";
import { formatUsPhone } from "@/lib/format-phone";
import { isPlausibleDob } from "@/lib/dob-validation";
import { submitFitRequest, type FitRequestType } from "@/lib/fit-request-api";
import {
  readFitRequestEntry,
  readFitRequestMode,
  type FitRequestEntry,
} from "@/lib/fit-request-mode";

const CONTACT_METHODS = [
  { value: "phone", label: "Phone call" },
  { value: "email", label: "Email" },
  { value: "text", label: "Text message" },
] as const;

/**
 * One schema, two required-field sets.
 *
 * A callback request asks for a name, a phone and an email and nothing
 * else — so the fields the detailed form requires are `.optional()` here
 * and enforced by a `superRefine` that only fires in `full_details` mode.
 * Splitting this into two schemas would mean two copies of the shared
 * field rules, and the shared rules are the ones most likely to change.
 */
const buildSchema = (mode: FitRequestType) =>
  z
    .object({
      fullName: z.string().trim().min(2, "Required").max(120),
      email: z.string().trim().email("Enter a valid email").max(200),
      phone: z.string().trim().max(40).optional().or(z.literal("")),
      preferredContactMethod: z.enum(["phone", "email", "text"]),
      preferredContactTime: z.string().max(120).optional().or(z.literal("")),
      // Optional even in the detailed form: it helps staff find an
      // existing chart, but a request without it is still workable.
      dateOfBirth: z
        .string()
        .optional()
        .or(z.literal(""))
        .refine(
          (v) => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && isPlausibleDob(v)),
          "Enter a valid date of birth",
        ),
      insuranceCarrier: z.string().max(120).optional().or(z.literal("")),
      memberId: z.string().max(80).optional().or(z.literal("")),
      groupNumber: z.string().max(80).optional().or(z.literal("")),
      prescribingPhysician: z.string().max(120).optional().or(z.literal("")),
      notes: z.string().max(2000).optional().or(z.literal("")),
      // Honeypot — hidden from real users via CSS + aria. The server
      // runs the same check. Deliberately NOT max(0): a schema-level
      // rejection blocked submit with no visible error (the field is
      // off-screen, so react-hook-form "focused" an invisible input and
      // the page just appeared dead), and it made the fake-success
      // branch in onSubmit unreachable — a bot should believe it
      // succeeded and move on, exactly like the server's own check.
      website: z.string().max(200).optional().or(z.literal("")),
    })
    .superRefine((values, ctx) => {
      // A number is only required when it is the channel they picked.
      const wantsCall =
        values.preferredContactMethod === "phone" ||
        values.preferredContactMethod === "text";
      if (wantsCall && (values.phone ?? "").trim().length < 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phone"],
          message: "Enter a number we can reach you on, or switch to email",
        });
      }
      if (mode !== "full_details") return;
      // A member ID with no carrier (or the reverse) is a half-answer
      // that reads as complete on the queue. Ask for the pair or
      // neither.
      const hasCarrier = Boolean(values.insuranceCarrier?.trim());
      const hasMember = Boolean(values.memberId?.trim());
      if (hasMember && !hasCarrier) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["insuranceCarrier"],
          message: "Add the carrier that issued this member ID",
        });
      }
      if (hasCarrier && !hasMember) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memberId"],
          message: "Add the member ID from that card",
        });
      }
    });

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export function FitRequest() {
  const [mode] = useState<FitRequestType>(readFitRequestMode);
  // Which capture failure sent them here, when one did. Seeds an
  // editable note; never travels to the server (the body is `.strict()`).
  const [entry] = useState<FitRequestEntry>(readFitRequestEntry);
  useDocumentTitle(
    mode === "callback" ? "Ask us to call you" : "Send us your fitting",
  );
  const company = useCompanyContact();
  const [, setLocation] = useLocation();
  const {
    chosenMask,
    setChosenMask,
    email: fitterEmail,
    population,
    setPopulation,
    inviteToken,
    fitSessionId,
  } = useFitterStore();

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The failure alert renders ABOVE the form while the submit button sits
  // at the bottom of it — on a phone a failed submit was invisible: the
  // spinner flicked, nothing else changed on screen, and the patient
  // reasonably concluded their request went through. Scroll the alert
  // into view whenever a failure lands (role="alert" already announces
  // it to screen readers).
  const failureAlertRef = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = failureAlertRef.current;
    // typeof-guarded — jsdom (the test environment) has no scrollIntoView.
    if (failure && el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [failure]);
  const [filed, setFiled] = useState<{ confirmationEmailed: boolean } | null>(
    null,
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(mode)),
    defaultValues: {
      // Captured at the /consent gate — the same address they'd type
      // again here. Still editable.
      email: fitterEmail ?? "",
      preferredContactMethod: "phone",
      // Say why there is no fitting attached, so the CSR plans an
      // in-person fit rather than waiting for a scan that is never
      // coming. Editable — it is the patient's note, not a system flag.
      notes: entry ? "I wasn't able to complete the photo scan." : "",
      website: "",
    } as Partial<FormValues> as FormValues,
    mode: "onBlur",
  });

  const contactMethod = watch("preferredContactMethod");

  useEffect(() => {
    track("fit_request_started", { mode });
  }, [mode]);

  const onSubmit = async (values: FormValues) => {
    if (submitting) return;
    // Population is asked, never assumed — block submit if the gate
    // answer is missing (should not happen after the questionnaire).
    if (!population) {
      setFailure(
        "We need to know whether this fitting is for an adult or a child. Go back and answer that question first.",
      );
      return;
    }
    // Honeypot: pretend it worked so the bot stops retrying, and never
    // touch the API.
    if (values.website && values.website.length > 0) {
      setFiled({ confirmationEmailed: false });
      return;
    }
    setSubmitting(true);
    setFailure(null);

    const result = await submitFitRequest({
      inviteToken,
      requestType: mode,
      fullName: values.fullName,
      email: values.email,
      phone: values.phone ?? "",
      preferredContactMethod: values.preferredContactMethod,
      preferredContactTime: values.preferredContactTime,
      // A callback request never asks for these, and the form never
      // renders them — but read them off the values rather than
      // hardcoding null, so a future mode that does ask needs no change
      // here.
      dateOfBirth: values.dateOfBirth,
      insuranceCarrier: values.insuranceCarrier,
      memberId: values.memberId,
      groupNumber: values.groupNumber,
      prescribingPhysician: values.prescribingPhysician,
      notes: values.notes,
      population,
      fitSessionId,
      recommendedMaskId: chosenMask?.maskId ?? null,
      recommendedMaskName: chosenMask?.name ?? null,
      recommendedMaskType: chosenMask?.maskType ?? null,
      recommendedMaskSize: chosenMask?.size ?? null,
    });
    setSubmitting(false);

    if (result.kind === "failed") {
      setFailure(result.message);
      return;
    }
    // Clear the chosen mask so a back-navigation can't file the same
    // request twice against a stale selection.
    setChosenMask(null);
    track("fit_request_submitted", { mode });
    setFiled({ confirmationEmailed: result.confirmationEmailed });
  };

  // The adult-or-child question, asked HERE when the flow never got to
  // it — a patient who reached this page from a failed capture has no
  // fitting and so never saw the questionnaire. It is not optional and
  // has no "not sure": population picks the service-line filter that
  // keeps a pediatric interface away from an adult and the reverse, and
  // the request row and the team email both state it. Sending them to
  // /questionnaire instead would bounce straight back — that page needs
  // measurements this patient does not have.
  if (!population) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 -ml-2 text-muted-foreground"
          onClick={() => setLocation("/capture?simple=1")}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to the camera
        </Button>
        <PopulationGate value={population} onSelect={setPopulation} />
      </div>
    );
  }

  if (filed) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader className="items-center text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mb-2">
              <CheckCircle2 className="w-7 h-7 text-emerald-600" />
            </div>
            <CardTitle className="text-display text-2xl font-bold tracking-tight">
              We have your request
            </CardTitle>
            <CardDescription className="text-base">
              A member of the {company.name} team will be in touch within one
              business day.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl callout-gold p-4 text-sm leading-relaxed">
              <strong className="font-semibold">
                Nothing has been ordered.
              </strong>{" "}
              We&apos;ll check your coverage, confirm the fit, and tell you what
              (if anything) is owed before anything ships.
            </div>
            {filed.confirmationEmailed && (
              <p className="text-sm text-muted-foreground">
                We&apos;ve emailed you a copy of this confirmation.
              </p>
            )}
            <div className="flex flex-wrap gap-3 pt-2">
              <Button variant="outline" onClick={() => setLocation("/results")}>
                Back to my results
              </Button>
              <Button variant="ghost" onClick={() => setLocation("/")}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isCallback = mode === "callback";

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <Button
        variant="ghost"
        size="sm"
        className="mb-6 -ml-2 text-muted-foreground"
        onClick={() => setLocation("/results")}
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to my results
      </Button>

      <div className="mb-8 space-y-3">
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          {isCallback ? "Ask us to call you" : "Send us your fitting"}
        </h1>
        <p className="text-muted-foreground leading-relaxed">
          {isCallback
            ? `Leave your name and the best way to reach you. Someone from ${company.name} will call to go through your results and what happens next.`
            : `Tell us how to reach you and we'll take it from here. ${company.name} places the order — you don't.`}
        </p>
        {chosenMask && (
          <div className="glass-panel rounded-xl p-4 text-sm">
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-1">
              Your fitting matched
            </div>
            <div className="font-semibold" data-testid="fit-request-mask">
              {chosenMask.name}
              {chosenMask.size ? ` · size ${chosenMask.size}` : ""}
            </div>
          </div>
        )}
      </div>

      {failure && (
        <Alert variant="destructive" className="mb-6" ref={failureAlertRef}>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>We couldn&apos;t send that</AlertTitle>
          <AlertDescription data-testid="fit-request-error">
            {failure}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">How to reach you</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Full name" required error={errors.fullName?.message}>
              <Input
                data-testid="input-fit-request-name"
                autoComplete="name"
                {...register("fullName")}
              />
            </Field>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Email" required error={errors.email?.message}>
                <Input
                  type="email"
                  data-testid="input-fit-request-email"
                  autoComplete="email"
                  {...register("email")}
                />
              </Field>
              <Field
                label="Phone"
                required={contactMethod === "phone" || contactMethod === "text"}
                error={errors.phone?.message}
              >
                <Input
                  type="tel"
                  data-testid="input-fit-request-phone"
                  autoComplete="tel"
                  {...register("phone")}
                  onChange={(e) =>
                    // Format as they type, exactly as /consent and
                    // /order do, so the same number looks the same
                    // wherever it is entered.
                    setValue("phone", formatUsPhone(e.target.value), {
                      shouldValidate: false,
                    })
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Best way to reach you" skipHtmlFor>
                <Select
                  value={contactMethod}
                  onValueChange={(v) =>
                    setValue(
                      "preferredContactMethod",
                      v as FormValues["preferredContactMethod"],
                    )
                  }
                >
                  <SelectTrigger data-testid="select-fit-request-contact">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTACT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Best time (optional)"
                error={errors.preferredContactTime?.message}
              >
                <Input
                  placeholder="Mornings, after 5pm…"
                  data-testid="input-fit-request-time"
                  {...register("preferredContactTime")}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        {!isCallback && (
          <>
            <Card className="border-0 glass-card rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg">
                  Insurance — only if you have it handy
                </CardTitle>
                <CardDescription>
                  Every field here is optional. We verify your benefits either
                  way; filling this in just saves a phone call.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Date of birth (optional)"
                  error={errors.dateOfBirth?.message}
                >
                  <Input
                    type="date"
                    data-testid="input-fit-request-dob"
                    {...register("dateOfBirth")}
                  />
                </Field>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field
                    label="Insurance carrier"
                    error={errors.insuranceCarrier?.message}
                  >
                    <Input
                      placeholder="Aetna, Highmark…"
                      data-testid="input-fit-request-carrier"
                      {...register("insuranceCarrier")}
                    />
                  </Field>
                  <Field label="Member ID" error={errors.memberId?.message}>
                    <Input
                      data-testid="input-fit-request-member-id"
                      {...register("memberId")}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field
                    label="Group number (optional)"
                    error={errors.groupNumber?.message}
                  >
                    <Input {...register("groupNumber")} />
                  </Field>
                  <Field
                    label="Sleep doctor (optional)"
                    error={errors.prescribingPhysician?.message}
                  >
                    <Input {...register("prescribingPhysician")} />
                  </Field>
                </div>
              </CardContent>
            </Card>

            <Card className="border-0 glass-card rounded-2xl">
              <CardHeader>
                <CardTitle className="text-lg">
                  Anything else we should know?
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Field label="Notes (optional)" error={errors.notes?.message}>
                  <Textarea
                    rows={4}
                    placeholder="Questions, a mask you've struggled with before, the best number to try…"
                    data-testid="input-fit-request-notes"
                    {...register("notes")}
                  />
                </Field>
              </CardContent>
            </Card>
          </>
        )}

        {/* Honeypot. Hidden from sighted users, screen readers, and the
            tab order alike — a bot that fills every input trips it.

            readOnly until focused: browser autofill and password managers
            ignore `autoComplete="off"` and will populate hidden inputs,
            and a tripped honeypot shows a REAL patient a fake success
            screen with no request ever filed — a silently lost lead.
            They all skip read-only fields, while a bot that types into
            whatever it finds first fires focus (or writes `value`
            directly, which register's onChange still records). No human
            can focus it — it is off-screen and out of the tab order. */}
        <div
          aria-hidden="true"
          className="absolute w-px h-px overflow-hidden -left-[9999px]"
        >
          <label htmlFor="fit-request-website">Leave this field empty</label>
          <input
            id="fit-request-website"
            tabIndex={-1}
            autoComplete="off"
            readOnly
            onFocus={(e) => {
              e.currentTarget.readOnly = false;
            }}
            {...register("website")}
          />
        </div>

        <div className="glass-panel rounded-xl p-4 flex items-start gap-3 text-sm text-muted-foreground leading-relaxed">
          <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-[hsl(var(--penn-navy))]" />
          <span>
            This is a request, not an order. {company.name} reviews it, confirms
            your coverage and sizing, and speaks to you before anything is
            ordered or billed.
          </span>
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full btn-primary-glow"
          disabled={submitting}
          data-testid="button-fit-request-submit"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Sending…
            </>
          ) : isCallback ? (
            <>
              <PhoneCall className="w-4 h-4 mr-2" />
              Ask {company.name} to contact me
            </>
          ) : (
            `Send my fitting to ${company.name}`
          )}
        </Button>
      </form>
    </div>
  );
}

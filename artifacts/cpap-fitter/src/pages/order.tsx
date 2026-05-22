import React, { useId, isValidElement, cloneElement } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  useSubmitOrder,
  ApiError,
} from "@workspace/api-client-react/storefront";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ArrowLeft,
  ShieldCheck,
  Tag,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useEffect } from "react";
import { track } from "@/lib/track";
import { FacialMeasurementsCard } from "@/components/facial-measurements-card";
import { DOB_MIN, isPlausibleDob, todayLocalDateString } from "@/lib/dob-validation";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
];

const formSchema = z.object({
  patient: z.object({
    firstName: z.string().min(1, "Required").max(100),
    lastName: z.string().min(1, "Required").max(100),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .refine(isPlausibleDob, "Enter a valid date of birth"),
    email: z.string().email("Enter a valid email").max(200),
    phone: z.string().min(7, "Enter a valid phone number").max(30),
  }),
  shippingAddress: z.object({
    street1: z.string().min(1, "Required").max(200),
    street2: z.string().max(200).optional().or(z.literal("")),
    city: z.string().min(1, "Required").max(100),
    state: z
      .string()
      .length(2, "Use 2-letter state code")
      .regex(/^[A-Za-z]{2}$/, "Letters only")
      .refine((v) => US_STATES.includes(v.toUpperCase()), "Invalid state code"),
    zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Use 12345 or 12345-6789"),
  }),
  insurance: z.object({
    provider: z.string().min(1, "Required").max(100),
    memberId: z.string().min(1, "Required").max(50),
    groupNumber: z.string().max(50).optional().or(z.literal("")),
    planName: z.string().max(100).optional().or(z.literal("")),
    policyholderName: z.string().max(200).optional().or(z.literal("")),
    policyholderRelationship: z
      .enum(["self", "spouse", "parent", "child", "other"])
      .optional(),
  }),
  prescription: z.object({
    hasExistingPrescription: z.boolean(),
    physicianName: z.string().max(200).optional().or(z.literal("")),
    physicianPhone: z.string().max(30).optional().or(z.literal("")),
  }),
  notes: z.string().max(1000).optional().or(z.literal("")),
  // Server (route handler) enforces `consentToContact === true` strictly,
  // so we keep the field in the payload but no longer surface a UI
  // checkbox for it — the patient cleared the /consent gate before
  // <GuardedOrder> would mount this page, and the form defaults this
  // field to true. See the acknowledgement panel below.
  consentToContact: z.boolean().refine((v) => v === true, {
    message: "You must consent to be contacted to submit an order",
  }),
  // Honeypot — this field is hidden from real users via CSS + aria. Bots
  // tend to fill in every input they see; if this is non-empty we
  // silently pretend the submission succeeded. Backend has the same check.
  website: z.string().max(0).optional().or(z.literal("")),
});

type FormValues = z.infer<typeof formSchema>;

/**
 * Format a US phone string as the user types. Strips non-digits,
 * truncates to 10 digits (US local), and reformats as
 *   ""               → ""
 *   "5"              → "(5"
 *   "555"            → "(555)"
 *   "5551"           → "(555) 1"
 *   "5551234"        → "(555) 123-4"
 *   "5551234567"     → "(555) 123-4567"
 *
 * The Zod schema accepts any non-empty 7-30 char string, so the
 * formatted output is always within bounds and is the natural
 * shape the contact-center / EHR systems expect downstream. We
 * keep a leading "+1" or "1" un-touched (return the digit string
 * with no parens) so international or unusual formats aren't
 * mangled — only obvious 10-digit US phones get reformatted.
 */
function formatUsPhone(input: string): string {
  if (!input) return "";
  // Skip reformat for international-looking inputs.
  if (input.trim().startsWith("+")) return input;
  const digits = input.replace(/\D/g, "");
  if (digits.length === 0) return "";
  // Treat 11-digit numbers starting with 1 as US country-code-prefixed.
  // Drop the leading 1 for display since the rest is local.
  const local =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.slice(0, 10);
  if (local.length < 4) return `(${local}`;
  if (local.length < 7) return `(${local.slice(0, 3)}) ${local.slice(3)}`;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 10)}`;
}

export function Order() {
  useDocumentTitle("Confirm your order");
  const [, setLocation] = useLocation();
  // The route-level <ProtectedRoute> in App.tsx already guarantees that
  // `chosenMask` is non-null by the time Order mounts.
  const { chosenMask, setChosenMask, measurements, email: fitterEmail } =
    useFitterStore();
  const { mutate, isPending, error } = useSubmitOrder();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitted },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      // Email captured at the /consent gate is the same email the
      // patient will use for the order; pre-fill so they don't retype.
      // Still editable here — if they want a different address on the
      // order, they can change it.
      patient: fitterEmail ? { email: fitterEmail } : undefined,
      prescription: { hasExistingPrescription: false },
      shippingAddress: { state: "" },
      consentToContact: false,
      website: "",
    } as Partial<FormValues> as FormValues,
    mode: "onBlur",
  });

  const stateValue = watch("shippingAddress.state");
  const relationshipValue = watch("insurance.policyholderRelationship");
  const hasRxValue = watch("prescription.hasExistingPrescription");
  const consentValue = watch("consentToContact");

  useEffect(() => {
    track("order_started");
  }, []);

  if (!chosenMask) return null;

  const onSubmit = (values: FormValues) => {
    // Defense against a fast double-click on the submit button:
    // react-hook-form's handleSubmit doesn't await fire-and-forget
    // mutate() calls, so the disabled-while-isPending button doesn't
    // close the race on its own. Skip a second submission while the
    // first is still in flight.
    if (isPending) return;
    // Frontend honeypot. Bots tend to fill in every visible input they
    // can find — including ones we hide visually. Silently pretend
    // success without ever hitting the API.
    if (values.website && values.website.length > 0) {
      sessionStorage.setItem(
        "fitter_order_confirmation",
        JSON.stringify({
          orderReference: "PENN-FAKE",
          message: "Order received.",
          mask: chosenMask,
          ...(measurements ? { measurements } : {}),
        }),
      );
      setChosenMask(null);
      setLocation("/order-success");
      return;
    }

    mutate(
      {
        data: {
          chosenMask,
          // Forward the on-device measurements so PennPaps can verify sizing.
          // Numeric only — image was discarded after the measure step.
          ...(measurements ? { measurements } : {}),
          patient: values.patient,
          shippingAddress: {
            street1: values.shippingAddress.street1,
            ...(values.shippingAddress.street2
              ? { street2: values.shippingAddress.street2 }
              : {}),
            city: values.shippingAddress.city,
            state: values.shippingAddress.state.toUpperCase(),
            zip: values.shippingAddress.zip,
          },
          insurance: {
            provider: values.insurance.provider,
            memberId: values.insurance.memberId,
            ...(values.insurance.groupNumber
              ? { groupNumber: values.insurance.groupNumber }
              : {}),
            ...(values.insurance.planName
              ? { planName: values.insurance.planName }
              : {}),
            ...(values.insurance.policyholderName
              ? {
                  policyholderName: values.insurance.policyholderName,
                  policyholderRelationship:
                    values.insurance.policyholderRelationship,
                }
              : {}),
          },
          prescription: {
            hasExistingPrescription:
              values.prescription.hasExistingPrescription,
            ...(values.prescription.physicianName
              ? { physicianName: values.prescription.physicianName }
              : {}),
            ...(values.prescription.physicianPhone
              ? { physicianPhone: values.prescription.physicianPhone }
              : {}),
          },
          ...(values.notes ? { notes: values.notes } : {}),
          consentToContact: values.consentToContact,
        },
      },
      {
        onSuccess: (data) => {
          // Clear the chosen mask from session so a refresh doesn't re-submit.
          setChosenMask(null);
          sessionStorage.setItem(
            "fitter_order_confirmation",
            JSON.stringify({
              orderReference: data.orderReference,
              message: data.message,
              mask: chosenMask,
              // Carry the measurements forward so the success page can
              // show the customer the exact numbers Penn Home Medical
              // Supply received with their order.
              ...(measurements ? { measurements } : {}),
            }),
          );
          track("order_submitted_success", { mask: chosenMask.modelNumber });
          setLocation("/order-success");
        },
      },
    );
  };

  // Type the React-Query mutation error as our generated ApiError so we
  // can read the typed `.data.error` / `.data.details` payload without
  // sprinkling `as any` everywhere.
  const apiError = error as ApiError<{
    error?: string;
    details?: string[];
  }> | null;

  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="mb-6">
        <Link href="/results">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-primary rounded-full"
            data-testid="link-back-to-results"
          >
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to recommendations
          </Button>
        </Link>
      </div>

      <div className="text-center mb-10 space-y-3">
        <div className="inline-flex items-center justify-center gap-3 mb-1">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            PennPaps · Checkout
          </span>
          <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
        </div>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand">
          Order Your Mask
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Tell us where to send your mask and how to bill your insurance. Your
          order goes directly to Penn Home Medical Supply for fulfillment.
        </p>
      </div>

      <Card className="mb-8 border-0 glass-card rounded-2xl ring-gold-soft">
        <CardContent className="p-5 flex items-start gap-4">
          <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center shrink-0">
            <Tag className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-[0.2em] text-[hsl(var(--penn-navy))]/70 font-semibold mb-1">
              Selected Mask
            </div>
            <div className="font-semibold text-lg leading-tight tracking-tight">
              {chosenMask.name}
            </div>
            <div className="text-sm text-muted-foreground">
              {chosenMask.manufacturer} ·{" "}
              <code className="font-mono text-foreground bg-white/60 px-1.5 py-0.5 rounded text-xs">
                {chosenMask.modelNumber}
              </code>
            </div>
          </div>
          <Link href="/results">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full glass-panel border-0"
              data-testid="button-change-mask"
            >
              Change
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Show the customer the measurements that will be transmitted
          with this order. Older flows had these numbers vanish after
          the measure step — surfacing them here lets the patient
          spot a wildly off scan (e.g. nostril span 2 mm) before the
          order goes out, and reassures CSR-bound shoppers exactly
          what data Penn Home Medical Supply will receive. */}
      {measurements && (
        <div className="mb-8">
          <FacialMeasurementsCard
            measurements={measurements}
            testIdPrefix="order-facial-measurements"
          />
        </div>
      )}

      {apiError && (
        <Alert
          variant="destructive"
          className="mb-6 glass-card border-destructive/30"
          data-testid="alert-order-error"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>We couldn't submit your order</AlertTitle>
          <AlertDescription>
            <div>
              {apiError.data?.error ??
                "Something went wrong while sending your order. Please try again or call Penn Home Medical Supply directly."}
            </div>
            {Array.isArray(apiError.data?.details) &&
              apiError.data!.details!.length > 0 && (
                <ul className="mt-2 text-xs list-disc list-inside space-y-0.5 opacity-90">
                  {apiError.data!.details!.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Patient info */}
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight font-bold">
              Your Information
            </CardTitle>
            <CardDescription>
              This is the patient who will be using the mask.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="First name"
              error={errors.patient?.firstName?.message}
              required
            >
              <Input
                data-testid="input-firstName"
                {...register("patient.firstName")}
                autoComplete="given-name"
              />
            </Field>
            <Field
              label="Last name"
              error={errors.patient?.lastName?.message}
              required
            >
              <Input
                data-testid="input-lastName"
                {...register("patient.lastName")}
                autoComplete="family-name"
              />
            </Field>
            <Field
              label="Date of birth"
              error={errors.patient?.dateOfBirth?.message}
              required
            >
              <Input
                data-testid="input-dob"
                type="date"
                min={DOB_MIN}
                max={todayLocalDateString()}
                {...register("patient.dateOfBirth")}
                autoComplete="bday"
              />
            </Field>
            <Field
              label="Phone"
              error={errors.patient?.phone?.message}
              required
            >
              {(() => {
                // We chain a custom onChange on top of register so the
                // input + react-hook-form state both store the
                // formatted value. Mutating e.target.value before
                // forwarding to RHF's onChange keeps the form state
                // and the visible input in sync without the overhead
                // of switching to <Controller>.
                const reg = register("patient.phone");
                return (
                  <Input
                    data-testid="input-phone"
                    type="tel"
                    placeholder="(555) 123-4567"
                    autoComplete="tel"
                    {...reg}
                    onChange={(e) => {
                      e.target.value = formatUsPhone(e.target.value);
                      void reg.onChange(e);
                    }}
                  />
                );
              })()}
            </Field>
            <Field
              label="Email"
              error={errors.patient?.email?.message}
              required
              className="md:col-span-2"
            >
              <Input
                data-testid="input-email"
                type="email"
                placeholder="you@example.com"
                {...register("patient.email")}
                autoComplete="email"
              />
            </Field>
          </CardContent>
        </Card>

        {/* Shipping address */}
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight font-bold">
              Shipping Address
            </CardTitle>
            <CardDescription>Where should we ship your mask?</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-4">
            <Field
              label="Street address"
              error={errors.shippingAddress?.street1?.message}
              required
              className="md:col-span-6"
            >
              <Input
                data-testid="input-street1"
                {...register("shippingAddress.street1")}
                autoComplete="address-line1"
              />
            </Field>
            <Field
              label="Apartment, suite, etc. (optional)"
              error={errors.shippingAddress?.street2?.message}
              className="md:col-span-6"
            >
              <Input
                data-testid="input-street2"
                {...register("shippingAddress.street2")}
                autoComplete="address-line2"
              />
            </Field>
            <Field
              label="City"
              error={errors.shippingAddress?.city?.message}
              required
              className="md:col-span-3"
            >
              <Input
                data-testid="input-city"
                {...register("shippingAddress.city")}
                autoComplete="address-level2"
              />
            </Field>
            <Field
              label="State"
              error={errors.shippingAddress?.state?.message}
              required
              className="md:col-span-1"
              /* Select renders its own trigger button — htmlFor binding to a button doesn't help, skip it. */
              skipHtmlFor
            >
              <Select
                value={stateValue}
                onValueChange={(v) =>
                  setValue("shippingAddress.state", v, { shouldValidate: true })
                }
              >
                <SelectTrigger data-testid="select-state">
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="ZIP"
              error={errors.shippingAddress?.zip?.message}
              required
              className="md:col-span-2"
            >
              <Input
                data-testid="input-zip"
                placeholder="12345"
                {...register("shippingAddress.zip")}
                autoComplete="postal-code"
              />
            </Field>
          </CardContent>
        </Card>

        {/* Insurance */}
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight font-bold">
              Insurance Information
            </CardTitle>
            <CardDescription>
              Penn Home Medical Supply will bill your insurance directly. Have
              your card ready.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Insurance provider"
              error={errors.insurance?.provider?.message}
              required
            >
              <Input
                data-testid="input-insurance-provider"
                placeholder="e.g. Aetna, Medicare, BCBS"
                {...register("insurance.provider")}
              />
            </Field>
            <Field
              label="Member ID"
              error={errors.insurance?.memberId?.message}
              required
            >
              <Input
                data-testid="input-member-id"
                {...register("insurance.memberId")}
              />
            </Field>
            <Field
              label="Group number (optional)"
              error={errors.insurance?.groupNumber?.message}
            >
              <Input
                data-testid="input-group-number"
                {...register("insurance.groupNumber")}
              />
            </Field>
            <Field
              label="Plan name (optional)"
              error={errors.insurance?.planName?.message}
            >
              <Input
                data-testid="input-plan-name"
                {...register("insurance.planName")}
              />
            </Field>
            <Field
              label="Policyholder name (if not you)"
              error={errors.insurance?.policyholderName?.message}
              className="md:col-span-2"
            >
              <Input
                data-testid="input-policyholder"
                placeholder="Leave blank if you are the policyholder"
                {...register("insurance.policyholderName")}
              />
            </Field>
            <Field
              label="Relationship to policyholder"
              error={errors.insurance?.policyholderRelationship?.message}
              className="md:col-span-2"
              skipHtmlFor
            >
              <Select
                value={relationshipValue ?? ""}
                onValueChange={(v) =>
                  setValue(
                    "insurance.policyholderRelationship",
                    v as FormValues["insurance"]["policyholderRelationship"],
                    {
                      shouldValidate: true,
                    },
                  )
                }
              >
                <SelectTrigger data-testid="select-relationship">
                  <SelectValue placeholder="Select if applicable" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="self">Self</SelectItem>
                  <SelectItem value="spouse">Spouse</SelectItem>
                  <SelectItem value="parent">Parent</SelectItem>
                  <SelectItem value="child">Child</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        {/* Prescription */}
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight font-bold">
              Prescription
            </CardTitle>
            <CardDescription>
              CPAP equipment requires a valid prescription. We'll work with your
              physician if needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <Label className="mb-2 block">
                Do you have an existing CPAP prescription?
              </Label>
              <RadioGroup
                value={hasRxValue ? "yes" : "no"}
                onValueChange={(v) =>
                  setValue(
                    "prescription.hasExistingPrescription",
                    v === "yes",
                    { shouldValidate: true },
                  )
                }
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="yes"
                    id="rx-yes"
                    data-testid="radio-rx-yes"
                  />
                  <Label
                    htmlFor="rx-yes"
                    className="cursor-pointer font-normal"
                  >
                    Yes, on file with a doctor
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="no"
                    id="rx-no"
                    data-testid="radio-rx-no"
                  />
                  <Label htmlFor="rx-no" className="cursor-pointer font-normal">
                    No / not sure
                  </Label>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground mt-2">
                If you don't have one yet, Penn Home Medical Supply can help you
                obtain one before shipping.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Prescribing physician name (optional)"
                error={errors.prescription?.physicianName?.message}
              >
                <Input
                  data-testid="input-physician-name"
                  {...register("prescription.physicianName")}
                />
              </Field>
              <Field
                label="Physician phone (optional)"
                error={errors.prescription?.physicianPhone?.message}
              >
                {(() => {
                  const reg = register("prescription.physicianPhone");
                  return (
                    <Input
                      data-testid="input-physician-phone"
                      type="tel"
                      placeholder="(555) 123-4567"
                      {...reg}
                      onChange={(e) => {
                        e.target.value = formatUsPhone(e.target.value);
                        void reg.onChange(e);
                      }}
                    />
                  );
                })()}
              </Field>
            </div>
          </CardContent>
        </Card>

        {/* Notes + consent */}
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight font-bold">
              Notes & Consent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field
              label="Anything else we should know? (optional)"
              error={errors.notes?.message}
            >
              <Textarea
                data-testid="input-notes"
                placeholder="Allergies, special requests, preferred contact times, etc."
                rows={4}
                {...register("notes")}
              />
            </Field>

            {/*
              Acknowledgement panel (formerly a second consent
              checkbox). The patient cleared the /consent gate before
              this page mounted — see <GuardedOrder> in App.tsx — so
              the contact / email consent is on file server-side
              (recorded via submitFitterLead). Re-prompting here for
              the same consent caused two well-documented problems:
                * ambiguity in the legal record when the upstream
                  opt-in said yes but the downstream box was missed,
                * an extra required click at the highest-abandon-risk
                  page of the funnel.
              We keep the TCPA disclosure copy verbatim — TCPA "prior
              express written consent" for transactional SMS is
              satisfied by the disclosure plus the act of providing
              the phone number on this form, not by the checkbox
              itself. The "data storage" disclosure also stays
              visible so the patient knows what submitting persists.
            */}
            <div
              className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30"
              data-testid="order-acknowledgement"
            >
              <ShieldCheck className="w-5 h-5 mt-0.5 shrink-0 text-primary" />
              <div className="flex-1 space-y-2">
                <p className="text-sm leading-relaxed">
                  By submitting this order, you authorize Penn Home Medical
                  Supply to <strong>contact you</strong> by phone, email, and
                  SMS at the number and email above regarding this order,
                  insurance verification, shipping updates, and ongoing CPAP
                  resupply reminders, and to{" "}
                  <strong>store the order details above</strong> in their secure
                  system for fulfillment and recordkeeping. The camera /
                  email consent you gave on the previous step also applies.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <strong>SMS terms:</strong> By providing your mobile number
                  you consent to receive transactional text messages from Penn
                  Home Medical Supply at that number, including via automated
                  systems. Approximately 1–2 messages per resupply cycle
                  (typically every 30–90 days). No marketing texts.{" "}
                  <strong>Message and data rates may apply.</strong> Reply{" "}
                  <strong>HELP</strong> for help, <strong>STOP</strong> to
                  unsubscribe at any time. See our{" "}
                  <Link
                    href="/privacy"
                    className="underline hover:text-primary"
                  >
                    Privacy Policy
                  </Link>{" "}
                  and{" "}
                  <Link href="/terms" className="underline hover:text-primary">
                    Terms of Service
                  </Link>{" "}
                  for full SMS program details.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 text-xs text-muted-foreground">
              <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <p>
                Your order is sent securely to Penn Home Medical Supply and
                stored in their secure order-fulfillment database, including the
                contact, shipping, insurance, and prescription details above
                plus the numeric facial measurements that were used to recommend
                your mask. Your camera image and video stream were never
                uploaded — only the measurement numbers leave your device. By
                submitting, you agree to our{" "}
                <Link href="/privacy" className="underline hover:text-primary">
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link href="/terms" className="underline hover:text-primary">
                  Terms of Service
                </Link>
                .
              </p>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="consent-checkbox"
                data-testid="checkbox-consent"
                checked={consentValue === true}
                aria-invalid={errors.consentToContact ? "true" : "false"}
                aria-describedby={
                  isSubmitted && errors.consentToContact
                    ? "consent-checkbox-error"
                    : undefined
                }
                onCheckedChange={(checked) =>
                  setValue("consentToContact", checked === true, {
                    shouldValidate: true,
                  })
                }
              />
              <div className="flex-1">
                <Label
                  htmlFor="consent-checkbox"
                  className="text-sm font-normal cursor-pointer leading-relaxed"
                >
                  I consent to be contacted by Penn Home Medical Supply
                  regarding this order, and agree to the SMS / contact and
                  data-storage terms above.
                </Label>
                {isSubmitted && errors.consentToContact && (
                  <p
                    id="consent-checkbox-error"
                    className="text-xs text-destructive mt-1"
                  >
                    {errors.consentToContact.message}
                  </p>
                )}
              </div>
            </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/*
          Honeypot. Real users never see this — it's positioned offscreen,
          aria-hidden, and tabindex=-1 so keyboard / screen-reader users
          skip past it. Bots that crawl forms tend to fill in everything
          they can find. The submit handler short-circuits if this is set.
        */}
        <div
          aria-hidden="true"
          className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
        >
          <label htmlFor="penn-website-hp">Website (leave blank)</label>
          <input
            id="penn-website-hp"
            type="text"
            autoComplete="off"
            tabIndex={-1}
            {...register("website")}
          />
        </div>

        {/*
          Reassurance card directly above the submit button. Insurance-
          path orders never carry a surprise charge — the patient owes
          $0 if the prescription + benefit verify, and Penn Home
          Medical Supply contacts them BEFORE shipping if anything
          would change that. Surfaces the no-surprise commitment at
          the exact moment the patient is deciding whether to submit.
        */}
        <div
          className="glass-card rounded-2xl p-5 flex items-start gap-3 border-l-4 border-l-[hsl(var(--penn-gold))]"
          data-testid="order-no-surprise-card"
        >
          <ShieldCheck className="w-5 h-5 mt-0.5 shrink-0 text-[hsl(var(--penn-gold))]" />
          <div className="text-sm leading-relaxed">
            <p className="font-semibold text-[hsl(var(--penn-navy))]">
              No surprise bills.
            </p>
            <p className="text-muted-foreground mt-0.5">
              Submitting this form does not charge your card. Penn Home Medical
              Supply will verify your insurance benefit and prescription first,
              then contact you to confirm before anything ships. You'll know
              your out-of-pocket — usually
              <span className="font-semibold"> $0 with prescription</span> —
              before they fulfill the order.
            </p>
          </div>
        </div>

        <div className="flex flex-col-reverse md:flex-row md:justify-between gap-3 pt-2">
          <Link href="/results">
            <Button
              type="button"
              variant="outline"
              className="w-full md:w-auto rounded-full glass-panel border-0 px-6"
              data-testid="button-cancel"
            >
              Cancel
            </Button>
          </Link>
          <Button
            type="submit"
            size="lg"
            disabled={isPending}
            className="w-full md:w-auto md:min-w-[260px] rounded-full btn-primary-glow disabled:opacity-70"
            data-testid="button-submit-order"
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending
                order...
              </>
            ) : (
              "Send Order to Penn Home Medical Supply"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Field — labels every form input with an auto-generated id and binds
 * the <Label htmlFor> to the input via React.cloneElement. Without this,
 * users navigating with screen readers (or who tap the label on mobile
 * to focus the input) get no association between label and control.
 *
 * For composite controls like our Select (which renders a Radix trigger
 * button — not a real form control), set `skipHtmlFor` and the wrapping
 * label is rendered without a `for` attribute (the underlying button
 * gets its own accessible name from its placeholder/value).
 */
function Field({
  label,
  required,
  error,
  className,
  skipHtmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  skipHtmlFor?: boolean;
  children: React.ReactNode;
}) {
  const generatedId = useId();
  const errorId = `${generatedId}-error`;
  // When the field has an error we clone the child so screen readers
  // announce both the invalid state (aria-invalid) and the error
  // text (via aria-describedby). The role="alert" on the message
  // also re-announces it when it appears or changes.
  type ChildProps = {
    id?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-describedby"?: string;
  };
  const child =
    !skipHtmlFor && isValidElement(children)
      ? cloneElement(children as React.ReactElement<ChildProps>, {
          id:
            (children as React.ReactElement<ChildProps>).props.id ??
            generatedId,
          ...(error
            ? {
                "aria-invalid": true,
                "aria-describedby": errorId,
              }
            : {}),
        })
      : children;
  const inputId = skipHtmlFor
    ? undefined
    : isValidElement(children)
      ? ((children as React.ReactElement<{ id?: string }>).props.id ??
        generatedId)
      : undefined;

  return (
    <div className={className}>
      <Label htmlFor={inputId} className="text-sm font-medium mb-1.5 block">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {child}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-xs text-destructive mt-1"
        >
          {error}
        </p>
      )}
    </div>
  );
}

import React, { useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useSubmitOrder } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowLeft, ShieldCheck, Tag, AlertCircle, Loader2 } from "lucide-react";

const formSchema = z.object({
  patient: z.object({
    firstName: z.string().min(1, "Required").max(100),
    lastName: z.string().min(1, "Required").max(100),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    email: z.string().email("Enter a valid email").max(200),
    phone: z.string().min(7, "Enter a valid phone number").max(30),
  }),
  shippingAddress: z.object({
    street1: z.string().min(1, "Required").max(200),
    street2: z.string().max(200).optional().or(z.literal("")),
    city: z.string().min(1, "Required").max(100),
    state: z.string().length(2, "Use 2-letter state code").regex(/^[A-Za-z]{2}$/, "Letters only"),
    zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Use 12345 or 12345-6789"),
  }),
  insurance: z.object({
    provider: z.string().min(1, "Required").max(100),
    memberId: z.string().min(1, "Required").max(50),
    groupNumber: z.string().max(50).optional().or(z.literal("")),
    planName: z.string().max(100).optional().or(z.literal("")),
    policyholderName: z.string().max(200).optional().or(z.literal("")),
    policyholderRelationship: z.enum(["self", "spouse", "parent", "child", "other"]).optional(),
  }),
  prescription: z.object({
    hasExistingPrescription: z.boolean(),
    physicianName: z.string().max(200).optional().or(z.literal("")),
    physicianPhone: z.string().max(30).optional().or(z.literal("")),
  }),
  notes: z.string().max(1000).optional().or(z.literal("")),
  consentToContact: z.literal(true, {
    errorMap: () => ({ message: "You must consent to be contacted to submit an order" }),
  }),
});

type FormValues = z.infer<typeof formSchema>;

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

export function Order() {
  const [, setLocation] = useLocation();
  const { chosenMask, setChosenMask, measurements } = useFitterStore();
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
      prescription: { hasExistingPrescription: false },
      shippingAddress: { state: "" },
    } as Partial<FormValues> as FormValues,
    mode: "onBlur",
  });

  const stateValue = watch("shippingAddress.state");
  const relationshipValue = watch("insurance.policyholderRelationship");
  const hasRxValue = watch("prescription.hasExistingPrescription");
  const consentValue = watch("consentToContact");

  // If somehow the user lands here without choosing a mask, send them back.
  useEffect(() => {
    if (!chosenMask) {
      setLocation("/results");
    }
  }, [chosenMask, setLocation]);

  if (!chosenMask) return null;

  const onSubmit = (values: FormValues) => {
    mutate(
      {
        data: {
          chosenMask,
          // Forward the on-device measurements so Penn can verify sizing.
          // Numeric only — image was discarded after the measure step.
          ...(measurements ? { measurements } : {}),
          patient: values.patient,
          shippingAddress: {
            street1: values.shippingAddress.street1,
            ...(values.shippingAddress.street2 ? { street2: values.shippingAddress.street2 } : {}),
            city: values.shippingAddress.city,
            state: values.shippingAddress.state.toUpperCase(),
            zip: values.shippingAddress.zip,
          },
          insurance: {
            provider: values.insurance.provider,
            memberId: values.insurance.memberId,
            ...(values.insurance.groupNumber ? { groupNumber: values.insurance.groupNumber } : {}),
            ...(values.insurance.planName ? { planName: values.insurance.planName } : {}),
            ...(values.insurance.policyholderName
              ? {
                  policyholderName: values.insurance.policyholderName,
                  policyholderRelationship: values.insurance.policyholderRelationship,
                }
              : {}),
          },
          prescription: {
            hasExistingPrescription: values.prescription.hasExistingPrescription,
            ...(values.prescription.physicianName ? { physicianName: values.prescription.physicianName } : {}),
            ...(values.prescription.physicianPhone ? { physicianPhone: values.prescription.physicianPhone } : {}),
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
              deliveredAt: data.deliveredAt,
              message: data.message,
              mask: chosenMask,
            }),
          );
          setLocation("/order-success");
        },
      },
    );
  };

  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-in fade-in duration-300">
      <div className="mb-6">
        <Link href="/results">
          <Button variant="ghost" size="sm" className="text-muted-foreground" data-testid="link-back-to-results">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to recommendations
          </Button>
        </Link>
      </div>

      <div className="text-center mb-8 space-y-3">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Order Your Mask</h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Tell us where to send your mask and how to bill your insurance. Your order goes directly to
          Penn Home Medical Supply for fulfillment.
        </p>
      </div>

      <Card className="mb-8 border-primary/30 bg-primary/5">
        <CardContent className="p-5 flex items-start gap-4">
          <Tag className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-1">Selected Mask</div>
            <div className="font-semibold text-lg leading-tight">{chosenMask.name}</div>
            <div className="text-sm text-muted-foreground">
              {chosenMask.manufacturer} ·{" "}
              <code className="font-mono text-foreground bg-background px-1.5 py-0.5 rounded text-xs">
                {chosenMask.modelNumber}
              </code>
            </div>
          </div>
          <Link href="/results">
            <Button variant="outline" size="sm" data-testid="button-change-mask">Change</Button>
          </Link>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive" className="mb-6" data-testid="alert-order-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>We couldn't submit your order</AlertTitle>
          <AlertDescription>
            <div>
              {(error as any)?.error ||
                "Something went wrong while sending your order. Please try again or call Penn Home Medical Supply directly."}
            </div>
            {Array.isArray((error as any)?.details) && (error as any).details.length > 0 && (
              <ul className="mt-2 text-xs list-disc list-inside space-y-0.5 opacity-90">
                {(error as any).details.map((d: string, i: number) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Patient info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Your Information</CardTitle>
            <CardDescription>This is the patient who will be using the mask.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="First name" error={errors.patient?.firstName?.message} required>
              <Input data-testid="input-firstName" {...register("patient.firstName")} autoComplete="given-name" />
            </Field>
            <Field label="Last name" error={errors.patient?.lastName?.message} required>
              <Input data-testid="input-lastName" {...register("patient.lastName")} autoComplete="family-name" />
            </Field>
            <Field label="Date of birth" error={errors.patient?.dateOfBirth?.message} required>
              <Input
                data-testid="input-dob"
                type="date"
                {...register("patient.dateOfBirth")}
                autoComplete="bday"
              />
            </Field>
            <Field label="Phone" error={errors.patient?.phone?.message} required>
              <Input
                data-testid="input-phone"
                type="tel"
                placeholder="(555) 123-4567"
                {...register("patient.phone")}
                autoComplete="tel"
              />
            </Field>
            <Field label="Email" error={errors.patient?.email?.message} required className="md:col-span-2">
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
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Shipping Address</CardTitle>
            <CardDescription>Where should we ship your mask?</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-4">
            <Field label="Street address" error={errors.shippingAddress?.street1?.message} required className="md:col-span-6">
              <Input data-testid="input-street1" {...register("shippingAddress.street1")} autoComplete="address-line1" />
            </Field>
            <Field label="Apartment, suite, etc. (optional)" error={errors.shippingAddress?.street2?.message} className="md:col-span-6">
              <Input data-testid="input-street2" {...register("shippingAddress.street2")} autoComplete="address-line2" />
            </Field>
            <Field label="City" error={errors.shippingAddress?.city?.message} required className="md:col-span-3">
              <Input data-testid="input-city" {...register("shippingAddress.city")} autoComplete="address-level2" />
            </Field>
            <Field label="State" error={errors.shippingAddress?.state?.message} required className="md:col-span-1">
              <Select
                value={stateValue}
                onValueChange={(v) => setValue("shippingAddress.state", v, { shouldValidate: true })}
              >
                <SelectTrigger data-testid="select-state">
                  <SelectValue placeholder="--" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="ZIP" error={errors.shippingAddress?.zip?.message} required className="md:col-span-2">
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
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Insurance Information</CardTitle>
            <CardDescription>
              Penn Home Medical Supply will bill your insurance directly. Have your card ready.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Insurance provider" error={errors.insurance?.provider?.message} required>
              <Input
                data-testid="input-insurance-provider"
                placeholder="e.g. Aetna, Medicare, BCBS"
                {...register("insurance.provider")}
              />
            </Field>
            <Field label="Member ID" error={errors.insurance?.memberId?.message} required>
              <Input data-testid="input-member-id" {...register("insurance.memberId")} />
            </Field>
            <Field label="Group number (optional)" error={errors.insurance?.groupNumber?.message}>
              <Input data-testid="input-group-number" {...register("insurance.groupNumber")} />
            </Field>
            <Field label="Plan name (optional)" error={errors.insurance?.planName?.message}>
              <Input data-testid="input-plan-name" {...register("insurance.planName")} />
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
            >
              <Select
                value={relationshipValue ?? ""}
                onValueChange={(v) =>
                  setValue("insurance.policyholderRelationship", v as FormValues["insurance"]["policyholderRelationship"], {
                    shouldValidate: true,
                  })
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
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Prescription</CardTitle>
            <CardDescription>
              CPAP equipment requires a valid prescription. We'll work with your physician if needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <Label className="mb-2 block">Do you have an existing CPAP prescription?</Label>
              <RadioGroup
                value={hasRxValue ? "yes" : "no"}
                onValueChange={(v) =>
                  setValue("prescription.hasExistingPrescription", v === "yes", { shouldValidate: true })
                }
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="yes" id="rx-yes" data-testid="radio-rx-yes" />
                  <Label htmlFor="rx-yes" className="cursor-pointer font-normal">Yes, on file with a doctor</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="no" id="rx-no" data-testid="radio-rx-no" />
                  <Label htmlFor="rx-no" className="cursor-pointer font-normal">No / not sure</Label>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground mt-2">
                If you don't have one yet, Penn Home Medical Supply can help you obtain one before shipping.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Prescribing physician name (optional)" error={errors.prescription?.physicianName?.message}>
                <Input data-testid="input-physician-name" {...register("prescription.physicianName")} />
              </Field>
              <Field label="Physician phone (optional)" error={errors.prescription?.physicianPhone?.message}>
                <Input
                  data-testid="input-physician-phone"
                  type="tel"
                  {...register("prescription.physicianPhone")}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        {/* Notes + consent */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Notes & Consent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="Anything else we should know? (optional)" error={errors.notes?.message}>
              <Textarea
                data-testid="input-notes"
                placeholder="Allergies, special requests, preferred contact times, etc."
                rows={4}
                {...register("notes")}
              />
            </Field>

            <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30">
              <Checkbox
                id="consent"
                data-testid="checkbox-consent"
                checked={!!consentValue}
                onCheckedChange={(c) =>
                  setValue("consentToContact", c === true ? true : (false as unknown as true), { shouldValidate: true })
                }
              />
              <div className="flex-1 -mt-0.5">
                <Label htmlFor="consent" className="cursor-pointer font-normal text-sm leading-relaxed">
                  I authorize Penn Home Medical Supply to contact me by phone, email, or SMS regarding this
                  order, my insurance verification, and shipping updates.
                </Label>
                {isSubmitted && errors.consentToContact && (
                  <p className="text-xs text-destructive mt-1">{errors.consentToContact.message}</p>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3 text-xs text-muted-foreground">
              <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <p>
                Your information is sent securely to Penn Home Medical Supply and is not stored on this
                website. By submitting, you agree to our{" "}
                <Link href="/privacy" className="underline hover:text-primary">Privacy Policy</Link>.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse md:flex-row md:justify-between gap-3">
          <Link href="/results">
            <Button type="button" variant="outline" className="w-full md:w-auto" data-testid="button-cancel">
              Cancel
            </Button>
          </Link>
          <Button
            type="submit"
            size="lg"
            disabled={isPending}
            className="w-full md:w-auto md:min-w-[220px]"
            data-testid="button-submit-order"
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending order...
              </>
            ) : (
              "Send Order to Penn Home Medical"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="text-sm font-medium mb-1.5 block">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}

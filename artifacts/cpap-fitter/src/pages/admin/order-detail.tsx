import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fetchAdminOrder, AdminApiError } from "@/lib/admin-api";
import { ArrowLeft, AlertCircle, ClipboardCheck } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending send",
  sent: "Delivered to PennPaps",
  failed: "Delivery failed",
  skipped: "Skipped (email not configured)",
};
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  sent: "default",
  failed: "destructive",
  skipped: "secondary",
};

interface InsuranceField {
  provider?: string;
  memberId?: string;
  groupNumber?: string;
  planName?: string;
  policyholderName?: string;
  policyholderRelationship?: string;
}
interface PrescriptionField {
  hasExistingPrescription?: boolean;
  physicianName?: string;
  physicianPhone?: string;
}
interface MeasurementsField {
  noseWidth?: number;
  noseHeight?: number;
  noseToChin?: number;
  mouthWidth?: number;
  faceWidthAtCheekbones?: number;
  calibrationMethod?: string;
}
interface ShippingField {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export function AdminOrderDetail() {
  useDocumentTitle("Admin · Order details");
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-order", id],
    queryFn: () => fetchAdminOrder(id!),
    enabled: !!id,
    retry: false,
  });

  if (error) {
    const status = error instanceof AdminApiError ? error.status : 0;
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>{status === 404 ? "Order not found" : "Could not load order"}</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  const o = data.order;
  const payload = o.payload as Record<string, unknown>;
  const insurance = (payload.insurance ?? {}) as InsuranceField;
  const prescription = (payload.prescription ?? {}) as PrescriptionField;
  const measurements = payload.measurements as MeasurementsField | undefined;
  const shipping = (payload.shippingAddress ?? {}) as ShippingField;
  const notes = typeof payload.notes === "string" ? payload.notes : null;

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Order reference</div>
          <h1 className="text-display text-3xl font-bold tracking-tight font-mono mt-1">
            {o.orderReference}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Submitted {new Date(o.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="text-right">
          <Badge variant={STATUS_TONE[o.emailStatus] ?? "outline"} className="text-sm">
            {STATUS_LABEL[o.emailStatus] ?? o.emailStatus}
          </Badge>
          {o.emailDeliveredAt && (
            <div className="text-xs text-muted-foreground mt-1">
              Delivered {new Date(o.emailDeliveredAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>

      {o.emailStatus === "failed" && o.emailError && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertTitle>Email delivery failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">{o.emailError}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Patient */}
        <Section title="Patient">
          <Field label="Name" value={`${o.patientFirstName} ${o.patientLastName}`} />
          <Field label="Date of birth" value={o.patientDateOfBirth} />
          <Field label="Email" value={o.patientEmail} />
          <Field label="Phone" value={o.patientPhone} />
        </Section>

        {/* Mask */}
        <Section title="Chosen mask">
          <Field label="Mask" value={`${o.maskManufacturer} ${o.maskName}`} />
          <Field label="Model #" value={o.maskModelNumber} />
          <Field label="Mask ID" value={o.maskId} mono />
        </Section>

        {/* Shipping */}
        <Section title="Shipping address">
          <Field label="Street" value={shipping.street1 ?? "—"} />
          {shipping.street2 && <Field label="Suite/Apt" value={shipping.street2} />}
          <Field
            label="City / State / ZIP"
            value={`${o.shippingCity}, ${o.shippingState} ${o.shippingZip}`}
          />
        </Section>

        {/* Insurance */}
        <Section title="Insurance">
          <Field label="Provider" value={insurance.provider ?? "—"} />
          <Field label="Member ID" value={insurance.memberId ?? "—"} mono />
          {insurance.groupNumber && <Field label="Group #" value={insurance.groupNumber} mono />}
          {insurance.planName && <Field label="Plan" value={insurance.planName} />}
          {insurance.policyholderName ? (
            <Field
              label="Policyholder"
              value={`${insurance.policyholderName} (${insurance.policyholderRelationship ?? "—"})`}
            />
          ) : (
            <Field label="Policyholder" value="Patient" />
          )}
        </Section>

        {/* Prescription */}
        <Section title="Prescription">
          <Field
            label="Existing CPAP Rx on file"
            value={prescription.hasExistingPrescription ? "Yes" : "No — PennPaps must obtain Rx before shipping"}
          />
          {prescription.physicianName && <Field label="Physician" value={prescription.physicianName} />}
          {prescription.physicianPhone && <Field label="Physician phone" value={prescription.physicianPhone} />}
        </Section>

        {/* Measurements */}
        {measurements && (
          <Section title="Facial measurements (mm)">
            {measurements.noseWidth != null && (
              <Field label="Nose width" value={`${measurements.noseWidth.toFixed(1)} mm`} mono />
            )}
            {measurements.noseHeight != null && (
              <Field label="Nose height" value={`${measurements.noseHeight.toFixed(1)} mm`} mono />
            )}
            {measurements.noseToChin != null && (
              <Field label="Nose to chin" value={`${measurements.noseToChin.toFixed(1)} mm`} mono />
            )}
            {measurements.mouthWidth != null && (
              <Field label="Mouth width" value={`${measurements.mouthWidth.toFixed(1)} mm`} mono />
            )}
            {measurements.faceWidthAtCheekbones != null && (
              <Field
                label="Face width (cheekbones)"
                value={`${measurements.faceWidthAtCheekbones.toFixed(1)} mm`}
                mono
              />
            )}
            {measurements.calibrationMethod && (
              <Field label="Calibration" value={measurements.calibrationMethod} />
            )}
          </Section>
        )}
      </div>

      {/* Notes */}
      {notes && (
        <Section title="Patient notes">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{notes}</p>
        </Section>
      )}

      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <ClipboardCheck className="w-3.5 h-3.5" />
        This view was logged to the audit trail.
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/admin/orders">
      <Button variant="ghost" size="sm" className="gap-1 -ml-2" data-testid="button-back-to-orders">
        <ArrowLeft className="w-4 h-4" /> All orders
      </Button>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-0 glass-card rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3">
      <div className="text-xs text-muted-foreground sm:w-44 sm:shrink-0">{label}</div>
      <div className={`text-sm ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

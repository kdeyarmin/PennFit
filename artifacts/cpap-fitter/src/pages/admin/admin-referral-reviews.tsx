// /admin/referral-reviews — the Referral Reviewer.
//
// Page layout
// -----------
// Header with an "Upload referral PDF" button and a status filter
// (Open / Accepted / Dismissed / All); below it the review queue.
// Selecting a review swaps in the detail view: the packet PDF in an
// iframe on the left, the editable extracted-intake form on the right
// (Patient / Insurance / Order / Sleep study / Physician / Documents)
// with per-section confidence badges, a possible-duplicate warning,
// a "Verify insurance" (270/271 quick-check) action, and the explicit
// "Enter this referral into the system?" accept confirmation.
//
// Nothing is written to the system until the operator confirms the
// accept — the AI only fills the form.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import {
  acceptReferralReview,
  createReferralReviewFromUpload,
  dismissReferralReview,
  extractReferralReview,
  getReferralReview,
  getReferralReviewDuplicates,
  getReferralUploadUrl,
  listReferralReviews,
  referralReviewMediaUrl,
  type AcceptReferralRequest,
  type AcceptReferralResponse,
  type ConfidenceLevel,
  type DuplicateCandidate,
  type ReferralReview,
  type ReferralReviewStatus,
  type ReferralSectionType,
} from "@/lib/admin/referral-reviews-api";
import { fetchPayerProfiles } from "@/lib/admin/billing-config-api";
import {
  quickCheckEligibility,
  type QuickCheckResult,
} from "@/lib/admin/billing-api";
import { useUrlState } from "@/hooks/use-url-state";

type ListFilter = "open" | "accepted" | "dismissed" | "all";
const LIST_FILTERS = new Set<ListFilter>([
  "open",
  "accepted",
  "dismissed",
  "all",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const STATUS_TEXT: Record<ReferralReviewStatus, string> = {
  pending: "Awaiting extraction",
  extracted: "Ready for review",
  accepted: "Entered in system",
  dismissed: "Dismissed",
  failed: "Extraction failed",
  offline: "AI offline",
  unsupported: "Not extractable",
};

const SECTION_LABEL: Record<ReferralSectionType, string> = {
  sleep_study: "Sleep study",
  physician_order: "Physician order",
  demographics: "Demographics",
  insurance_card: "Insurance card",
  chart_note: "Chart notes",
  other: "Other",
};

/** Best-effort E.164 normalisation for a transcribed phone number so
 *  the operator usually doesn't have to retype it. Leaves anything
 *  ambiguous untouched for the human to fix. */
function normalizePhone(raw: string | null): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+") && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim();
}

function ConfidenceBadge({ level }: { level: ConfidenceLevel | null }) {
  if (!level) return null;
  const palette =
    level === "high"
      ? { bg: "#ecfdf5", fg: "#047857", label: "High confidence" }
      : level === "medium"
        ? { bg: "#fffbeb", fg: "#b45309", label: "Medium confidence" }
        : { bg: "#fef2f2", fg: "#b91c1c", label: "Low confidence — check" };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ backgroundColor: palette.bg, color: palette.fg }}
    >
      {palette.label}
    </span>
  );
}

function StatusPill({ status }: { status: ReferralReviewStatus }) {
  const palette =
    status === "extracted"
      ? { bg: "#eff6ff", fg: "#1d4ed8" }
      : status === "accepted"
        ? { bg: "#ecfdf5", fg: "#047857" }
        : status === "pending"
          ? { bg: "#f5f5f4", fg: "#57534e" }
          : status === "dismissed"
            ? { bg: "#f5f5f4", fg: "#78716c" }
            : { bg: "#fef2f2", fg: "#b91c1c" };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: palette.bg, color: palette.fg }}
    >
      {STATUS_TEXT[status]}
    </span>
  );
}

// ── Editable form state ─────────────────────────────────────────────

interface InsuranceForm {
  payerName: string;
  planName: string;
  memberId: string;
  groupNumber: string;
  policyholderName: string;
  policyholderRelationship: "" | "self" | "spouse" | "child" | "other";
}

const EMPTY_INSURANCE: InsuranceForm = {
  payerName: "",
  planName: "",
  memberId: "",
  groupNumber: "",
  policyholderName: "",
  policyholderRelationship: "",
};

interface DocumentForm {
  include: boolean;
  type: ReferralSectionType;
  pageStart: string;
  pageEnd: string;
  title: string;
}

interface IntakeForm {
  firstName: string;
  lastName: string;
  dob: string;
  phone: string;
  email: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  insurance: InsuranceForm;
  secondaryInsurance: InsuranceForm;
  documents: DocumentForm[];
}

function formFromReview(review: ReferralReview): IntakeForm {
  const x = review.extraction;
  const ins = (i: typeof x extends null ? never : unknown): InsuranceForm => {
    const src = i as {
      payerName?: string | null;
      planName?: string | null;
      memberId?: string | null;
      groupNumber?: string | null;
      policyholderName?: string | null;
      policyholderRelationship?: string | null;
    } | null;
    if (!src) return { ...EMPTY_INSURANCE };
    const rel = (src.policyholderRelationship ?? "").trim().toLowerCase();
    return {
      payerName: src.payerName ?? "",
      planName: src.planName ?? "",
      memberId: src.memberId ?? "",
      groupNumber: src.groupNumber ?? "",
      policyholderName: src.policyholderName ?? "",
      policyholderRelationship:
        rel === "self" || rel === "spouse" || rel === "child"
          ? (rel as "self" | "spouse" | "child")
          : rel
            ? "other"
            : "",
    };
  };
  return {
    firstName: x?.patient.firstName ?? "",
    lastName: x?.patient.lastName ?? "",
    dob: x?.patient.dob ?? "",
    phone: normalizePhone(x?.patient.phone ?? null),
    email: x?.patient.email ?? "",
    line1: x?.patient.address?.line1 ?? "",
    line2: x?.patient.address?.line2 ?? "",
    city: x?.patient.address?.city ?? "",
    state: x?.patient.address?.state ?? "",
    postalCode: x?.patient.address?.postalCode ?? "",
    insurance: ins(x?.insurance ?? null),
    secondaryInsurance: ins(x?.secondaryInsurance ?? null),
    documents: (x?.documents ?? []).map((d) => ({
      include: true,
      type: d.type,
      pageStart: String(d.pageStart),
      pageEnd: String(d.pageEnd),
      title: d.title,
    })),
  };
}

function buildAcceptBody(
  form: IntakeForm,
  confirmDuplicateOverride: boolean,
): AcceptReferralRequest {
  const hasAddress =
    form.line1.trim() &&
    form.city.trim() &&
    form.state.trim() &&
    form.postalCode.trim();
  const insurance = (i: InsuranceForm) =>
    i.payerName.trim() && i.memberId.trim()
      ? {
          payerName: i.payerName.trim(),
          planName: i.planName.trim() || null,
          memberId: i.memberId.trim(),
          groupNumber: i.groupNumber.trim() || null,
          policyholderName: i.policyholderName.trim() || null,
          policyholderRelationship: i.policyholderRelationship || null,
        }
      : null;
  return {
    patient: {
      legalFirstName: form.firstName.trim(),
      legalLastName: form.lastName.trim(),
      dateOfBirth: form.dob.trim(),
      phoneE164: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: hasAddress
        ? {
            line1: form.line1.trim(),
            ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
            city: form.city.trim(),
            state: form.state.trim(),
            postalCode: form.postalCode.trim(),
            country: "US",
          }
        : null,
      insurancePayer: form.insurance.payerName.trim() || null,
    },
    insurance: insurance(form.insurance),
    secondaryInsurance: insurance(form.secondaryInsurance),
    documents: form.documents
      .filter(
        (d) =>
          d.include &&
          Number.parseInt(d.pageStart, 10) >= 1 &&
          Number.parseInt(d.pageEnd, 10) >= 1,
      )
      .map((d) => ({
        type: d.type,
        pageStart: Number.parseInt(d.pageStart, 10),
        pageEnd: Number.parseInt(d.pageEnd, 10),
        ...(d.title.trim() ? { title: d.title.trim() } : {}),
      })),
    confirmDuplicateOverride,
  };
}

// ── Page ────────────────────────────────────────────────────────────

export function AdminReferralReviewsPage() {
  const [filter, setFilter] = useUrlState<ListFilter>({
    key: "status",
    defaultValue: "open",
    isAllowed: (v): v is ListFilter => LIST_FILTERS.has(v as ListFilter),
  });
  const [selectedId, setSelectedId] = useUrlState<string>({
    key: "review",
    defaultValue: "",
    isAllowed: (v): v is string => v === "" || UUID_RE.test(v),
  });

  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ["admin-referral-reviews", filter],
    queryFn: () => listReferralReviews(filter),
  });

  // ── Upload referral PDF ───────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const { uploadURL, objectPath } = await getReferralUploadUrl(file.size);
      const put = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      return createReferralReviewFromUpload(objectPath);
    },
    onSuccess: (review) => {
      setUploadError(null);
      void queryClient.invalidateQueries({
        queryKey: ["admin-referral-reviews"],
      });
      setSelectedId(review.id);
    },
    onError: (err) =>
      setUploadError(err instanceof Error ? err.message : "Upload failed"),
  });

  const onFileChosen = (file: File | null) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      setUploadError("Only PDF files can be uploaded.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("PDF is larger than the 10 MB limit.");
      return;
    }
    uploadMutation.mutate(file);
  };

  // Deep-link from the Patients page ("Upload referral" button links here
  // with ?upload=1) opens the file picker straight away, so staff don't have
  // to hunt for the upload control. The param is stripped after firing so a
  // refresh or back-navigation doesn't re-open the picker.
  const autoUploadFired = useRef(false);
  useEffect(() => {
    if (autoUploadFired.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("upload") !== "1") return;
    autoUploadFired.current = true;
    params.delete("upload");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    fileInputRef.current?.click();
  }, []);

  const reviews = listQuery.data?.reviews ?? [];

  return (
    <div className="admin-root space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1
            className="text-xl font-bold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Referral reviewer
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
            Upload a referral PDF (or triage a faxed packet) and the AI
            pre-fills a new patient for your review — nothing is entered until
            you accept.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            data-testid="referral-upload-input"
            onChange={(e) => {
              onFileChosen(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <Button
            intent="secondary"
            isLoading={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" /> Upload referral PDF
          </Button>
        </div>
      </div>

      {uploadError && (
        <div
          className="rounded-md border px-4 py-2 text-sm"
          style={{
            backgroundColor: "#fef2f2",
            borderColor: "#fecaca",
            color: "#991b1b",
          }}
          role="alert"
        >
          {uploadError}
        </div>
      )}

      {selectedId ? (
        <ReviewDetail reviewId={selectedId} onBack={() => setSelectedId("")} />
      ) : (
        <Card
          title="Review queue"
          action={
            <div className="flex gap-1">
              {(["open", "accepted", "dismissed", "all"] as const).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  intent={filter === f ? "primary" : "ghost"}
                  onClick={() => setFilter(f)}
                >
                  {f === "open"
                    ? "Open"
                    : f === "accepted"
                      ? "Accepted"
                      : f === "dismissed"
                        ? "Dismissed"
                        : "All"}
                </Button>
              ))}
            </div>
          }
        >
          {listQuery.isLoading ? (
            <Spinner label="Loading referral reviews…" />
          ) : listQuery.isError ? (
            <ErrorPanel
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
            />
          ) : reviews.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 py-10 text-sm"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              <Inbox className="h-6 w-6" />
              No {filter === "all" ? "" : `${filter} `}referral reviews.
              {filter === "open" && (
                <span>
                  New faxed referrals appear here automatically when the
                  reviewer flag is on — or upload a referral PDF above.
                </span>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-xs uppercase tracking-wide"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="py-2 pr-3">Received</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Patient (extracted)</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t cursor-pointer hover:bg-black/[0.02]"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3 capitalize">{r.source}</td>
                    <td className="py-2.5 pr-3">
                      {r.extraction?.patient.firstName ||
                      r.extraction?.patient.lastName
                        ? `${r.extraction.patient.firstName ?? ""} ${r.extraction.patient.lastName ?? ""}`.trim()
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-3">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="py-2.5 text-right">
                      <Button size="sm" intent="ghost">
                        Review
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Detail / intake form ────────────────────────────────────────────

function ReviewDetail({
  reviewId,
  onBack,
}: {
  reviewId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["admin-referral-review", reviewId],
    queryFn: () => getReferralReview(reviewId),
    // While the extraction job runs, poll until the row leaves pending.
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 4000 : false),
  });
  const review = detailQuery.data;

  const [form, setForm] = useState<IntakeForm | null>(null);
  const loadedForReviewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!review) return;
    const key = `${review.id}:${review.extractedAt ?? ""}`;
    if (loadedForReviewRef.current === key) return;
    loadedForReviewRef.current = key;
    setForm(formFromReview(review));
  }, [review]);

  const duplicatesQuery = useQuery({
    queryKey: ["admin-referral-review-duplicates", reviewId],
    queryFn: () => getReferralReviewDuplicates(reviewId),
    enabled: review?.status === "extracted",
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["admin-referral-review", reviewId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["admin-referral-reviews"],
    });
  };

  const extractMutation = useMutation({
    mutationFn: () => extractReferralReview(reviewId),
    onSuccess: () => {
      loadedForReviewRef.current = null;
      invalidate();
    },
  });

  const [dismissNote, setDismissNote] = useState("");
  const [showDismiss, setShowDismiss] = useState(false);
  const dismissMutation = useMutation({
    mutationFn: () => dismissReferralReview(reviewId, dismissNote || null),
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });

  const [showConfirm, setShowConfirm] = useState(false);
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    DuplicateCandidate[] | null
  >(null);
  const [acceptResult, setAcceptResult] =
    useState<AcceptReferralResponse | null>(null);
  const acceptMutation = useMutation({
    mutationFn: (override: boolean) => {
      if (!form) throw new Error("form not ready");
      return acceptReferralReview(reviewId, buildAcceptBody(form, override));
    },
    onSuccess: (res) => {
      setShowConfirm(false);
      setDuplicateCandidates(null);
      setAcceptResult(res);
      invalidate();
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        (err.data as { error?: string } | null)?.error === "possible_duplicate"
      ) {
        setDuplicateCandidates(
          ((err.data as { candidates?: DuplicateCandidate[] }).candidates ??
            []) as DuplicateCandidate[],
        );
        setShowConfirm(false);
      }
    },
  });

  if (detailQuery.isLoading) return <Spinner label="Loading review…" />;
  if (detailQuery.isError || !review) {
    return (
      <ErrorPanel
        error={detailQuery.error}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const confidence = review.extraction?.confidence ?? null;
  const includedDocCount = form?.documents.filter((d) => d.include).length ?? 0;
  const canAccept =
    !!form &&
    form.firstName.trim() !== "" &&
    form.lastName.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.dob.trim()) &&
    review.status !== "accepted" &&
    review.status !== "dismissed";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button intent="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back to queue
        </Button>
        <div className="flex items-center gap-2">
          <StatusPill status={review.status} />
          {review.faxFromE164 && (
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Faxed from {review.faxFromE164}
            </span>
          )}
        </div>
      </div>

      {acceptResult && (
        <div
          className="rounded-md border px-4 py-3 text-sm flex items-start gap-2"
          style={{
            backgroundColor: "#ecfdf5",
            borderColor: "#a7f3d0",
            color: "#065f46",
          }}
          role="status"
        >
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Referral entered. Patient record created
            {acceptResult.documentIds.length > 0 &&
              ` with ${acceptResult.documentIds.length} document${acceptResult.documentIds.length === 1 ? "" : "s"} filed`}
            .{" "}
            <a
              href={`/admin/patients/${acceptResult.patientId}`}
              className="font-semibold underline"
            >
              Open the patient record
              <ExternalLink className="inline h-3 w-3 ml-0.5" />
            </a>
            {acceptResult.warnings.length > 0 && (
              <div className="mt-1" style={{ color: "#92400e" }}>
                Heads-up: {acceptResult.warnings.join(", ")} — review the chart
                and re-add anything missing.
              </div>
            )}
          </div>
        </div>
      )}

      {(review.status === "pending" ||
        review.status === "failed" ||
        review.status === "offline" ||
        review.status === "unsupported") && (
        <div
          className="rounded-md border px-4 py-3 text-sm flex items-center justify-between gap-3"
          style={{
            backgroundColor: "#fffbeb",
            borderColor: "#fde68a",
            color: "#92400e",
          }}
        >
          <span className="flex items-center gap-2">
            {review.status === "pending" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            {review.status === "pending" &&
              "Extraction is queued — this page refreshes automatically."}
            {review.status === "failed" &&
              "The AI pass failed; you can re-run it or key the intake by hand below."}
            {review.status === "offline" &&
              "No AI key is configured; key the intake by hand or re-run once configured."}
            {review.status === "unsupported" &&
              "This media type can't be auto-read (TIFF fax) — key the intake by hand from the preview."}
          </span>
          <Button
            size="sm"
            intent="secondary"
            isLoading={extractMutation.isPending}
            onClick={() => extractMutation.mutate()}
          >
            <Sparkles className="h-4 w-4" /> Run extraction
          </Button>
        </div>
      )}

      {duplicatesQuery.data && duplicatesQuery.data.candidates.length > 0 && (
        <DuplicateWarning candidates={duplicatesQuery.data.candidates} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Referral packet"
          subtitle={
            review.extraction?.summary ?? "Original document, as received."
          }
        >
          {review.hasMedia ? (
            <iframe
              title="Referral packet preview"
              src={referralReviewMediaUrl(review.id)}
              className="w-full rounded border"
              style={{ height: "70vh", borderColor: "hsl(var(--line-1))" }}
            />
          ) : (
            <div
              className="py-10 text-center text-sm"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              <FileText className="h-6 w-6 mx-auto mb-2" />
              The packet bytes weren't persisted for this review.
            </div>
          )}
        </Card>

        <div className="space-y-4">
          {form && (
            <IntakeFormFields
              form={form}
              setForm={setForm}
              confidence={confidence}
              review={review}
            />
          )}

          {form && review.status !== "accepted" && (
            <Card>
              {duplicateCandidates && (
                <div
                  className="mb-3 rounded-md border px-4 py-3 text-sm"
                  style={{
                    backgroundColor: "#fffbeb",
                    borderColor: "#fde68a",
                    color: "#92400e",
                  }}
                  role="alert"
                >
                  <p className="font-semibold mb-1">
                    Possible existing patient
                  </p>
                  <DuplicateList candidates={duplicateCandidates} />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      intent="secondary"
                      isLoading={acceptMutation.isPending}
                      onClick={() => acceptMutation.mutate(true)}
                    >
                      Create a new patient anyway
                    </Button>
                    <Button
                      size="sm"
                      intent="ghost"
                      onClick={() => setDuplicateCandidates(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {showConfirm ? (
                <div
                  className="rounded-md border px-4 py-3"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <p
                    className="text-sm font-semibold mb-2"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    Enter this referral into the system?
                  </p>
                  <p
                    className="text-sm mb-3"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    This creates a new patient record for{" "}
                    <strong>
                      {form.firstName} {form.lastName}
                    </strong>
                    {includedDocCount > 0 &&
                      `, files ${includedDocCount} document${includedDocCount === 1 ? "" : "s"} to the chart`}
                    {form.insurance.payerName.trim() &&
                      ", and saves the insurance coverage"}
                    .
                  </p>
                  <div className="flex gap-2">
                    <Button
                      isLoading={acceptMutation.isPending}
                      onClick={() => acceptMutation.mutate(false)}
                    >
                      Yes — enter referral
                    </Button>
                    <Button
                      intent="ghost"
                      onClick={() => setShowConfirm(false)}
                    >
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : showDismiss ? (
                <div
                  className="rounded-md border px-4 py-3"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <Label htmlFor="dismiss-note">
                    Dismiss this review (optional note)
                  </Label>
                  <Input
                    id="dismiss-note"
                    value={dismissNote}
                    onChange={(e) => setDismissNote(e.target.value)}
                    placeholder="e.g. Not a referral — marketing fax"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      intent="secondary"
                      isLoading={dismissMutation.isPending}
                      onClick={() => dismissMutation.mutate()}
                    >
                      Dismiss review
                    </Button>
                    <Button
                      size="sm"
                      intent="ghost"
                      onClick={() => setShowDismiss(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!canAccept}
                    onClick={() => setShowConfirm(true)}
                  >
                    <CheckCircle2 className="h-4 w-4" /> Enter this referral…
                  </Button>
                  <Button intent="ghost" onClick={() => setShowDismiss(true)}>
                    Dismiss
                  </Button>
                  {!canAccept && review.status !== "dismissed" && (
                    <span
                      className="text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      First/last name and a YYYY-MM-DD date of birth are
                      required.
                    </span>
                  )}
                </div>
              )}
              {acceptMutation.isError &&
                !duplicateCandidates &&
                !(
                  acceptMutation.error instanceof ApiError &&
                  acceptMutation.error.status === 409
                ) && (
                  <div className="mt-3">
                    <ErrorPanel
                      title="Couldn't enter the referral"
                      error={acceptMutation.error}
                    />
                  </div>
                )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function DuplicateList({ candidates }: { candidates: DuplicateCandidate[] }) {
  return (
    <ul className="space-y-1">
      {candidates.map((c) => (
        <li key={c.id} className="text-sm">
          <a
            href={`/admin/patients/${c.id}`}
            className="font-semibold underline"
            target="_blank"
            rel="noreferrer"
          >
            {c.legalFirstName} {c.legalLastName}
          </a>{" "}
          — DOB {c.dateOfBirth ?? "—"}, {c.phoneE164 ?? "no phone"} (matched on{" "}
          {c.matchedOn === "phone" ? "phone number" : "DOB + last name"})
        </li>
      ))}
    </ul>
  );
}

function DuplicateWarning({
  candidates,
}: {
  candidates: DuplicateCandidate[];
}) {
  return (
    <div
      className="rounded-md border px-4 py-3 text-sm"
      style={{
        backgroundColor: "#fffbeb",
        borderColor: "#fde68a",
        color: "#92400e",
      }}
      role="alert"
    >
      <p className="font-semibold mb-1 flex items-center gap-1.5">
        <AlertTriangle className="h-4 w-4" /> Possible existing patient
      </p>
      <p className="mb-1">
        The extracted details match {candidates.length} existing patient
        {candidates.length === 1 ? "" : "s"} — check before entering a new
        record:
      </p>
      <DuplicateList candidates={candidates} />
    </div>
  );
}

// ── Form sections ───────────────────────────────────────────────────

function IntakeFormFields({
  form,
  setForm,
  confidence,
  review,
}: {
  form: IntakeForm;
  setForm: (f: IntakeForm) => void;
  confidence: {
    patient: ConfidenceLevel;
    insurance: ConfidenceLevel;
    order: ConfidenceLevel;
    sleepStudy: ConfidenceLevel;
  } | null;
  review: ReferralReview;
}) {
  const x = review.extraction;
  const set = (patch: Partial<IntakeForm>) => setForm({ ...form, ...patch });
  const setIns = (
    key: "insurance" | "secondaryInsurance",
    patch: Partial<InsuranceForm>,
  ) => setForm({ ...form, [key]: { ...form[key], ...patch } });

  return (
    <>
      <Card
        title="Patient"
        action={<ConfidenceBadge level={confidence?.patient ?? null} />}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="rr-first">First name</Label>
            <Input
              id="rr-first"
              value={form.firstName}
              onChange={(e) => set({ firstName: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="rr-last">Last name</Label>
            <Input
              id="rr-last"
              value={form.lastName}
              onChange={(e) => set({ lastName: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="rr-dob">Date of birth (YYYY-MM-DD)</Label>
            <Input
              id="rr-dob"
              value={form.dob}
              onChange={(e) => set({ dob: e.target.value })}
              placeholder="1960-02-03"
            />
          </div>
          <div>
            <Label htmlFor="rr-phone">Phone (E.164)</Label>
            <Input
              id="rr-phone"
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder="+14155551212"
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="rr-email">Email</Label>
            <Input
              id="rr-email"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="rr-line1">Address line 1</Label>
            <Input
              id="rr-line1"
              value={form.line1}
              onChange={(e) => set({ line1: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="rr-line2">Address line 2</Label>
            <Input
              id="rr-line2"
              value={form.line2}
              onChange={(e) => set({ line2: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="rr-city">City</Label>
            <Input
              id="rr-city"
              value={form.city}
              onChange={(e) => set({ city: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rr-state">State</Label>
              <Input
                id="rr-state"
                value={form.state}
                onChange={(e) => set({ state: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="rr-zip">ZIP</Label>
              <Input
                id="rr-zip"
                value={form.postalCode}
                onChange={(e) => set({ postalCode: e.target.value })}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Insurance"
        action={<ConfidenceBadge level={confidence?.insurance ?? null} />}
      >
        <InsuranceFields
          idPrefix="rr-ins"
          value={form.insurance}
          onChange={(patch) => setIns("insurance", patch)}
        />
        <VerifyInsurancePanel form={form} />
        <details className="mt-4">
          <summary
            className="cursor-pointer text-sm font-semibold"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            Secondary insurance
            {form.secondaryInsurance.payerName ? " (extracted)" : ""}
          </summary>
          <div className="mt-3">
            <InsuranceFields
              idPrefix="rr-ins2"
              value={form.secondaryInsurance}
              onChange={(patch) => setIns("secondaryInsurance", patch)}
            />
          </div>
        </details>
      </Card>

      {x && x.order.length > 0 && (
        <Card
          title="Ordered items"
          subtitle="From the physician order — informational; create the order from the patient record after intake."
          action={<ConfidenceBadge level={confidence?.order ?? null} />}
        >
          <ul className="space-y-1 text-sm">
            {x.order.map((o, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{o.description}</span>
                {o.hcpcs && (
                  <span
                    className="font-mono text-xs rounded px-1.5 py-0.5"
                    style={{
                      backgroundColor: "hsl(var(--surface-2))",
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    {o.hcpcs}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(x?.sleepStudy || x?.physician) && (
        <Card
          title="Sleep study & referring physician"
          action={<ConfidenceBadge level={confidence?.sleepStudy ?? null} />}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {x?.sleepStudy?.studyDate && (
              <Fact label="Study date" value={x.sleepStudy.studyDate} />
            )}
            {x?.sleepStudy?.studyType && (
              <Fact label="Study type" value={x.sleepStudy.studyType} />
            )}
            {x?.sleepStudy?.ahi != null && (
              <Fact label="AHI" value={String(x.sleepStudy.ahi)} />
            )}
            {x?.sleepStudy?.rdi != null && (
              <Fact label="RDI" value={String(x.sleepStudy.rdi)} />
            )}
            {x?.sleepStudy?.odi != null && (
              <Fact label="ODI" value={String(x.sleepStudy.odi)} />
            )}
            {x?.sleepStudy?.totalSleepMinutes != null && (
              <Fact
                label="Total sleep"
                value={`${x.sleepStudy.totalSleepMinutes} min`}
              />
            )}
            {x?.sleepStudy?.interpretingPhysician && (
              <Fact
                label="Interpreting physician"
                value={x.sleepStudy.interpretingPhysician}
              />
            )}
            {x?.physician?.name && (
              <Fact label="Referring physician" value={x.physician.name} />
            )}
            {x?.physician?.npi && <Fact label="NPI" value={x.physician.npi} />}
            {x?.physician?.clinic && (
              <Fact label="Clinic" value={x.physician.clinic} />
            )}
            {x?.physician?.phone && (
              <Fact label="Office phone" value={x.physician.phone} />
            )}
            {x?.physician?.fax && (
              <Fact label="Office fax" value={x.physician.fax} />
            )}
          </div>
        </Card>
      )}

      <Card
        title="Documents to file"
        subtitle="Each section is split out of the packet, named, and added to the new patient's chart."
      >
        {form.documents.length === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No sections identified — the whole packet will be filed as one
            “Referral Packet” document.
          </p>
        ) : (
          <div className="space-y-2">
            {form.documents.map((d, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.include}
                  aria-label={`Include ${SECTION_LABEL[d.type]}`}
                  onChange={(e) => {
                    const documents = form.documents.slice();
                    documents[i] = { ...d, include: e.target.checked };
                    setForm({ ...form, documents });
                  }}
                />
                <Select
                  value={d.type}
                  aria-label="Document type"
                  options={(
                    Object.keys(SECTION_LABEL) as ReferralSectionType[]
                  ).map((t) => ({ value: t, label: SECTION_LABEL[t] }))}
                  onChange={(e) => {
                    const documents = form.documents.slice();
                    documents[i] = {
                      ...d,
                      type: e.target.value as ReferralSectionType,
                    };
                    setForm({ ...form, documents });
                  }}
                />
                <span style={{ color: "hsl(var(--ink-3))" }}>pages</span>
                <Input
                  className="w-16"
                  value={d.pageStart}
                  aria-label="First page"
                  onChange={(e) => {
                    const documents = form.documents.slice();
                    documents[i] = { ...d, pageStart: e.target.value };
                    setForm({ ...form, documents });
                  }}
                />
                <span style={{ color: "hsl(var(--ink-3))" }}>–</span>
                <Input
                  className="w-16"
                  value={d.pageEnd}
                  aria-label="Last page"
                  onChange={(e) => {
                    const documents = form.documents.slice();
                    documents[i] = { ...d, pageEnd: e.target.value };
                    setForm({ ...form, documents });
                  }}
                />
                <Input
                  className="flex-1"
                  value={d.title}
                  aria-label="Document title"
                  placeholder={SECTION_LABEL[d.type]}
                  onChange={(e) => {
                    const documents = form.documents.slice();
                    documents[i] = { ...d, title: e.target.value };
                    setForm({ ...form, documents });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: "hsl(var(--ink-3))" }}>{label}</span>
      <span style={{ color: "hsl(var(--ink-1))" }}>{value}</span>
    </>
  );
}

function InsuranceFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: InsuranceForm;
  onChange: (patch: Partial<InsuranceForm>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor={`${idPrefix}-payer`}>Payer</Label>
        <Input
          id={`${idPrefix}-payer`}
          value={value.payerName}
          onChange={(e) => onChange({ payerName: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-plan`}>Plan</Label>
        <Input
          id={`${idPrefix}-plan`}
          value={value.planName}
          onChange={(e) => onChange({ planName: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-member`}>Member ID</Label>
        <Input
          id={`${idPrefix}-member`}
          value={value.memberId}
          onChange={(e) => onChange({ memberId: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-group`}>Group number</Label>
        <Input
          id={`${idPrefix}-group`}
          value={value.groupNumber}
          onChange={(e) => onChange({ groupNumber: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-holder`}>Policyholder</Label>
        <Input
          id={`${idPrefix}-holder`}
          value={value.policyholderName}
          onChange={(e) => onChange({ policyholderName: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-rel`}>Relationship</Label>
        <Select
          id={`${idPrefix}-rel`}
          value={value.policyholderRelationship}
          emptyOptionLabel="—"
          options={[
            { value: "self", label: "Self" },
            { value: "spouse", label: "Spouse" },
            { value: "child", label: "Child" },
            { value: "other", label: "Other" },
          ]}
          onChange={(e) =>
            onChange({
              policyholderRelationship: e.target
                .value as InsuranceForm["policyholderRelationship"],
            })
          }
        />
      </div>
    </div>
  );
}

// ── Verify insurance (270/271 quick-check on the edited fields) ─────

function VerifyInsurancePanel({ form }: { form: IntakeForm }) {
  const payersQuery = useQuery({
    queryKey: ["admin-payer-profiles-active"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60 * 1000,
  });
  const payers = useMemo(
    () => payersQuery.data?.payerProfiles ?? [],
    [payersQuery.data],
  );

  // Pre-match the extracted payer name against the profile catalog.
  const suggested = useMemo(() => {
    const name = form.insurance.payerName.trim().toLowerCase();
    if (!name) return null;
    return (
      payers.find((p) => p.displayName.toLowerCase() === name) ??
      payers.find(
        (p) =>
          p.displayName.toLowerCase().includes(name) ||
          name.includes(p.displayName.toLowerCase()),
      ) ??
      null
    );
  }, [payers, form.insurance.payerName]);

  const [payerProfileId, setPayerProfileId] = useState("");
  const chosenId = payerProfileId || suggested?.id || "";

  const [result, setResult] = useState<QuickCheckResult | null>(null);
  const verifyMutation = useMutation({
    mutationFn: () =>
      quickCheckEligibility({
        payerProfileId: chosenId,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        memberId: form.insurance.memberId.trim(),
        dateOfBirth: form.dob.trim(),
      }),
    onSuccess: setResult,
  });

  const ready =
    chosenId !== "" &&
    form.firstName.trim() !== "" &&
    form.lastName.trim() !== "" &&
    form.insurance.memberId.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.dob.trim());

  return (
    <div
      className="mt-4 rounded-md border px-4 py-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-48">
          <Label htmlFor="rr-verify-payer">Verify against payer</Label>
          <Select
            id="rr-verify-payer"
            value={chosenId}
            emptyOptionLabel={
              payersQuery.isLoading
                ? "Loading payers…"
                : "Select a payer profile…"
            }
            options={payers.map((p) => ({
              value: p.id,
              label:
                suggested?.id === p.id
                  ? `${p.displayName} (matched from referral)`
                  : p.displayName,
            }))}
            onChange={(e) => setPayerProfileId(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          disabled={!ready}
          isLoading={verifyMutation.isPending}
          onClick={() => verifyMutation.mutate()}
        >
          <ShieldCheck className="h-4 w-4" /> Verify insurance
        </Button>
      </div>
      <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        Runs a real-time 270/271 eligibility check with the name, DOB, and
        member ID above. Nothing is saved until you accept the referral.
      </p>

      {verifyMutation.isError && (
        <div
          className="mt-3 rounded-md border px-3 py-2 text-sm"
          style={{
            backgroundColor: "#fef2f2",
            borderColor: "#fecaca",
            color: "#991b1b",
          }}
          role="alert"
        >
          {verifyMutation.error instanceof ApiError &&
          typeof (verifyMutation.error.data as { message?: string } | null)
            ?.message === "string"
            ? (verifyMutation.error.data as { message: string }).message
            : "Eligibility check failed."}
        </div>
      )}

      {result && (
        <div
          className="mt-3 rounded-md border px-3 py-2 text-sm space-y-1"
          style={{
            backgroundColor: result.benefits.isActive ? "#ecfdf5" : "#fef2f2",
            borderColor: result.benefits.isActive ? "#a7f3d0" : "#fecaca",
            color: result.benefits.isActive ? "#065f46" : "#991b1b",
          }}
          role="status"
        >
          <p className="font-semibold">
            {result.benefits.isActive
              ? `Active coverage with ${result.payerName}`
              : `No active coverage found with ${result.payerName}`}
          </p>
          {result.benefits.deductibleRemainingCents != null && (
            <p>
              Deductible remaining: $
              {(result.benefits.deductibleRemainingCents / 100).toFixed(2)}
            </p>
          )}
          {result.benefits.oopRemainingCents != null && (
            <p>
              Out-of-pocket remaining: $
              {(result.benefits.oopRemainingCents / 100).toFixed(2)}
            </p>
          )}
          {result.benefits.coinsurancePct != null && (
            <p>Coinsurance: {result.benefits.coinsurancePct}%</p>
          )}
          {result.benefits.requiresPriorAuth && (
            <p className="font-semibold">Prior authorization required.</p>
          )}
          {result.benefits.messages.slice(0, 4).map((m, i) => (
            <p key={i}>{m}</p>
          ))}
        </div>
      )}
    </div>
  );
}

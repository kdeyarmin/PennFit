import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  ShieldCheck,
  ShieldOff,
  FileSignature,
  Lock,
  AlertTriangle,
  ScrollText,
} from "lucide-react";

import {
  useViewPatientPacket,
  useSignPatientPacket,
  type PublicPacketDocument,
  type PacketDocumentSection,
  type SignerRelationship,
  ApiError,
} from "@workspace/api-client-react/storefront";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/signature-pad";
import {
  SIGNATURE_STYLES,
  renderTypedSignatureDataUrl,
} from "@/lib/typed-signature";
import { cn } from "@/lib/utils";
import { useDocumentTitle } from "@/hooks/use-document-title";

const PAGE_TITLE = "Sign your documents";

const RELATIONSHIP_OPTIONS: { value: SignerRelationship; label: string }[] = [
  { value: "self", label: "Myself (the patient)" },
  { value: "spouse", label: "Spouse" },
  { value: "guardian", label: "Legal guardian" },
  { value: "power_of_attorney", label: "Power of attorney" },
  { value: "caregiver", label: "Caregiver" },
  { value: "other", label: "Other authorized representative" },
];

const CATEGORY_LABEL: Record<string, string> = {
  instructions: "Instructions",
  consent: "Consent",
  privacy: "Privacy",
  rights: "Your rights",
  financial: "Financial",
  delivery: "Delivery",
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 container max-w-3xl mx-auto px-4 py-10 sm:py-14">
      {children}
    </div>
  );
}

function SectionView({ section }: { section: PacketDocumentSection }) {
  return (
    <div className="space-y-2">
      {section.heading && (
        <h4 className="text-sm font-semibold text-slate-900">
          {section.heading}
        </h4>
      )}
      {(section.paragraphs ?? []).map((p, i) => (
        <p key={i} className="text-sm leading-relaxed text-slate-600">
          {p}
        </p>
      ))}
      {section.bullets && section.bullets.length > 0 && (
        <ul className="ml-1 space-y-1.5">
          {section.bullets.map((b, i) => (
            <li
              key={i}
              className="flex gap-2 text-sm leading-relaxed text-slate-600"
            >
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentCard({
  doc,
  index,
  total,
  acknowledged,
  onAcknowledge,
}: {
  doc: PublicPacketDocument;
  index: number;
  total: number;
  acknowledged: boolean;
  onAcknowledge: (checked: boolean) => void;
}) {
  return (
    <Card
      className={
        "border transition-colors " +
        (acknowledged
          ? "border-emerald-300 bg-emerald-50/30"
          : "border-slate-200")
      }
    >
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Badge variant="secondary" className="text-xs font-medium">
            Document {index + 1} of {total}
          </Badge>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {CATEGORY_LABEL[doc.category] ?? doc.category}
          </span>
        </div>
        <CardTitle className="flex items-start gap-2 text-lg text-slate-900">
          <ScrollText className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
          {doc.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="max-h-72 space-y-4 overflow-y-auto rounded-lg border border-slate-100 bg-white p-4">
          {doc.sections.map((section, i) => (
            <SectionView key={i} section={section} />
          ))}
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-3">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(c) => onAcknowledge(c === true)}
            className="mt-0.5"
            aria-label={`Acknowledge ${doc.title}`}
          />
          <span className="text-sm text-slate-700">
            I have read and{" "}
            {doc.requiresSignature ? "agree to" : "acknowledge receipt of"}{" "}
            <span className="font-medium text-slate-900">{doc.title}</span>.
          </span>
        </label>
      </CardContent>
    </Card>
  );
}

export function PatientPacketSign() {
  useDocumentTitle(PAGE_TITLE);

  // Read the signing token once, then strip it from the URL so the
  // personalized link doesn't linger in history / autocomplete.
  const [token] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token") ?? "";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("token")) return;
      params.delete("token");
      const qs = params.toString();
      const next =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", next);
    } catch {
      // History API unavailable: no-op.
    }
  }, []);

  const { data, isLoading, error } = useViewPatientPacket(token);
  const sign = useSignPatientPacket();

  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [signerName, setSignerName] = useState("");
  const [relationship, setRelationship] = useState<SignerRelationship>("self");
  const [signerReason, setSignerReason] = useState("");
  const [dateReceived, setDateReceived] = useState("");
  const [consent, setConsent] = useState(false);
  const [sigMode, setSigMode] = useState<"type" | "draw">("type");
  const [styleIndex, setStyleIndex] = useState(0);
  const [drawnEmpty, setDrawnEmpty] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const sigRef = useRef<SignaturePadHandle | null>(null);

  const documents = data?.documents ?? [];
  const requiresDateReceived = Boolean(data?.requiresDateReceived);
  const isRepresentative = relationship !== "self";
  const ackedCount = documents.filter((d) => acked[d.key]).length;
  const allAcked = documents.length > 0 && ackedCount === documents.length;
  const canSubmit =
    allAcked &&
    signerName.trim().length >= 2 &&
    consent &&
    (!isRepresentative || signerReason.trim().length > 0) &&
    (!requiresDateReceived || dateReceived.length > 0) &&
    (sigMode !== "draw" || !drawnEmpty);

  // Pre-fill the signer's name from the packet recipient so the
  // signature is ready the moment the page loads — one less thing for
  // the patient to do.
  const prefilledName = useRef(false);
  useEffect(() => {
    if (!prefilledName.current && data?.recipientName && !signerName) {
      setSignerName(data.recipientName);
      prefilledName.current = true;
    }
  }, [data?.recipientName, signerName]);

  const acknowledgeAll = () => {
    const next: Record<string, boolean> = {};
    for (const d of documents) next[d.key] = true;
    setAcked(next);
  };

  const progress = useMemo(() => {
    const totalSteps = documents.length + 1; // docs + signing step
    const done = ackedCount + (canSubmit ? 1 : 0);
    return documents.length === 0 ? 0 : Math.round((done / totalSteps) * 100);
  }, [ackedCount, documents.length, canSubmit]);

  // ── Missing token ──
  if (!token) {
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
              <ShieldOff className="h-6 w-6 text-slate-500" />
            </div>
            <CardTitle>Signing link missing</CardTitle>
            <CardDescription>
              Please open the secure link we emailed you to review and sign your
              documents.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild variant="outline">
              <Link href="/">Return home</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  // ── Loading ──
  if (isLoading) {
    return (
      <PageShell>
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageShell>
    );
  }

  // ── Error / expired / voided ──
  if (error) {
    const code =
      error instanceof ApiError
        ? ((error.data as { error?: string } | null)?.error ?? "error")
        : "error";
    const messages: Record<string, { title: string; body: string }> = {
      expired: {
        title: "This link has expired",
        body: "For your security, signing links expire after a period of time. Contact us and we'll send you a fresh link.",
      },
      voided: {
        title: "This packet was withdrawn",
        body: "This document packet is no longer active. Please contact us if you believe this is a mistake.",
      },
      invalid: {
        title: "This link is no longer valid",
        body: "A newer link may have been sent to you. Please use the most recent email, or contact us for help.",
      },
      not_found: {
        title: "We couldn't find these documents",
        body: "Please use the secure link from your most recent email, or contact us for help.",
      },
      error: {
        title: "Something went wrong",
        body: "We couldn't load your documents right now. Please try again in a few minutes.",
      },
    };
    const m = messages[code] ?? messages.error;
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100">
              <AlertTriangle className="h-6 w-6 text-amber-600" />
            </div>
            <CardTitle>{m.title}</CardTitle>
            <CardDescription>{m.body}</CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    );
  }

  // ── Already completed (server) or just signed ──
  if (data?.status === "completed" || completedAt) {
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" />
            </div>
            <CardTitle className="text-2xl">You're all set</CardTitle>
            <CardDescription className="text-base">
              Your documents have been signed and securely recorded. Thank you —
              there's nothing more you need to do.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild>
              <Link href="/">Return home</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const company = data?.company;

  const handleSubmit = async () => {
    setSubmitError(null);
    if (!canSubmit) return;
    const signatureImage =
      sigMode === "draw"
        ? (sigRef.current?.toDataURL() ?? null)
        : renderTypedSignatureDataUrl(
            signerName.trim(),
            SIGNATURE_STYLES[styleIndex].fontStack,
          );
    try {
      const res = await sign.mutateAsync({
        token,
        signerName: signerName.trim(),
        signerRelationship: relationship,
        signatureImage,
        signerReason: isRepresentative ? signerReason.trim() : null,
        dateReceived: requiresDateReceived ? dateReceived : null,
        consentEsign: true,
        acknowledgedDocumentKeys: documents
          .filter((d) => acked[d.key])
          .map((d) => d.key),
      });
      setCompletedAt(res.completedAt);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.data as { error?: string; message?: string } | null)
              ?.message ??
            (err.data as { error?: string } | null)?.error ??
            err.message)
          : err instanceof Error
            ? err.message
            : "We couldn't submit your signature. Please try again.";
      setSubmitError(friendlySubmitError(msg));
    }
  };

  return (
    <PageShell>
      {/* Header */}
      <div className="mb-6 space-y-3">
        {company && (
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {company.legalName}
          </p>
        )}
        <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-slate-900">
          <FileSignature className="h-7 w-7 text-slate-700" />
          {data?.title ?? "Your new patient documents"}
        </h1>
        <p className="text-slate-600">
          {data?.recipientName
            ? `Hi ${data.recipientName.split(" ")[0]}, `
            : ""}
          please review each document below, confirm you've read it, then add
          your signature at the bottom. It only takes a few minutes.
        </p>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Lock className="h-3.5 w-3.5" />
          Secure &amp; encrypted — your signature is legally binding under the
          federal ESIGN Act.
        </div>
      </div>

      {/* Sticky progress */}
      <div className="sticky top-2 z-20 mb-6 rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur">
        <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600">
          <span>
            {ackedCount} of {documents.length} documents reviewed
          </span>
          <span>{progress}%</span>
        </div>
        <Progress value={progress} className="h-2" />
        {!allAcked && documents.length > 1 && (
          <button
            type="button"
            onClick={acknowledgeAll}
            className="mt-2 w-full rounded-lg bg-slate-900 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
          >
            I’ve read and agree to all {documents.length} documents
          </button>
        )}
      </div>

      {/* Documents */}
      <div className="space-y-5">
        {documents.map((doc, i) => (
          <DocumentCard
            key={doc.key}
            doc={doc}
            index={i}
            total={documents.length}
            acknowledged={Boolean(acked[doc.key])}
            onAcknowledge={(checked) =>
              setAcked((prev) => ({ ...prev, [doc.key]: checked }))
            }
          />
        ))}
      </div>

      {/* Signature block */}
      <Card className="mt-6 border-slate-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <FileSignature className="h-5 w-5 text-slate-700" />
            Your signature
          </CardTitle>
          <CardDescription>
            By signing, you adopt this as your legal electronic signature on the
            documents above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="signerName">Full legal name</Label>
              <Input
                id="signerName"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="e.g. Jordan A. Smith"
                autoComplete="name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="relationship">I am signing as</Label>
              <Select
                value={relationship}
                onValueChange={(v) => setRelationship(v as SignerRelationship)}
              >
                <SelectTrigger id="relationship">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Medicare: a representative must state why the patient can't sign */}
          {isRepresentative && (
            <div className="space-y-1.5">
              <Label htmlFor="signerReason">
                Reason the patient is unable to sign
              </Label>
              <Input
                id="signerReason"
                value={signerReason}
                onChange={(e) => setSignerReason(e.target.value)}
                placeholder="e.g. Patient is hospitalized / physically unable to sign"
              />
              <p className="text-xs text-slate-400">
                Required when someone other than the patient signs.
              </p>
            </div>
          )}

          {/* Medicare Proof of Delivery: the date the equipment arrived */}
          {requiresDateReceived && (
            <div className="space-y-1.5">
              <Label htmlFor="dateReceived">
                Date you received the equipment
              </Label>
              <Input
                id="dateReceived"
                type="date"
                value={dateReceived}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDateReceived(e.target.value)}
              />
              <p className="text-xs text-slate-400">
                Required for your proof of delivery.
              </p>
            </div>
          )}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label>Signature</Label>
              {/* Type vs Draw toggle */}
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setSigMode("type")}
                  className={cn(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    sigMode === "type"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500",
                  )}
                >
                  Type
                </button>
                <button
                  type="button"
                  onClick={() => setSigMode("draw")}
                  className={cn(
                    "rounded-md px-3 py-1 font-medium transition-colors",
                    sigMode === "draw"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500",
                  )}
                >
                  Draw
                </button>
              </div>
            </div>

            {sigMode === "type" ? (
              <div className="space-y-3">
                {/* Live preview generated from the typed legal name */}
                <div className="flex h-32 items-center justify-center overflow-hidden rounded-xl border-2 border-slate-200 bg-white px-4">
                  {signerName.trim() ? (
                    <span
                      className="truncate text-slate-900"
                      style={{
                        fontFamily: SIGNATURE_STYLES[styleIndex].fontStack,
                        fontStyle: "italic",
                        fontSize: "44px",
                        lineHeight: 1.1,
                      }}
                    >
                      {signerName.trim()}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-400">
                      Type your full legal name above to create your signature
                    </span>
                  )}
                </div>
                {/* Style picker */}
                <div className="flex flex-wrap gap-2">
                  {SIGNATURE_STYLES.map((s, i) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => setStyleIndex(i)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        i === styleIndex
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                      )}
                    >
                      <span
                        style={{
                          fontFamily: s.fontStack,
                          fontStyle: "italic",
                        }}
                      >
                        {s.label}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400">
                  Your signature is created from your name — no drawing needed.
                  Prefer to draw it? Switch to “Draw”.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <SignaturePad
                  ref={sigRef}
                  onChange={setDrawnEmpty}
                  ariaLabel="Draw your signature"
                />
                {drawnEmpty && (
                  <p className="text-xs text-slate-400">
                    Draw your signature above, or switch to “Type” for the
                    easiest option.
                  </p>
                )}
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <Checkbox
              checked={consent}
              onCheckedChange={(c) => setConsent(c === true)}
              className="mt-0.5"
              aria-label="Consent to sign electronically"
            />
            <span className="text-sm text-slate-700">
              I agree to use an electronic signature and to conduct this
              transaction electronically. I understand my electronic signature
              is legally binding and has the same effect as a handwritten
              signature.
            </span>
          </label>

          {!allAcked && (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Review remaining documents</AlertTitle>
              <AlertDescription>
                Please confirm you've read all {documents.length} documents
                above before signing.
              </AlertDescription>
            </Alert>
          )}

          {submitError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Couldn't submit</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <Button
            size="lg"
            className="w-full"
            disabled={!canSubmit || sign.isPending}
            onClick={handleSubmit}
          >
            {sign.isPending ? "Submitting…" : "Sign & submit my documents"}
          </Button>
          <p className="text-center text-xs text-slate-400">
            {company?.phone
              ? `Questions? Call us at ${company.phone}.`
              : "Questions? Contact our patient care team."}
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function friendlySubmitError(raw: string): string {
  if (/documents_not_acknowledged/.test(raw))
    return "Please confirm you've read every document before signing.";
  if (/signer_reason_required/.test(raw))
    return "Please enter the reason the patient is unable to sign.";
  if (/date_received_required/.test(raw))
    return "Please enter the date you received the equipment.";
  if (/already_completed/.test(raw))
    return "These documents have already been signed.";
  if (/expired|voided|invalid|not_found/.test(raw))
    return "This signing link is no longer valid. Please contact us for a new one.";
  return raw;
}

export default PatientPacketSign;

import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getListPatientNotesQueryKey,
  useCreatePatientNote,
  useGetAdminMe,
  useGetPatient,
  useListPatientNotes,
  type PatientNote,
  type PatientNotesPage,
  type PatientPrescription,
} from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import {
  InsuranceCoveragesTab,
  PriorAuthorizationsTab,
  SleepStudiesTab,
} from "@/components/admin/ClinicalTabs";
import { AlertMessageOverridesPanel } from "@/components/admin/alert-message-overrides-panel";
import { DocumentsTab } from "@/components/admin/DocumentsTab";
import { EquipmentTab } from "@/components/admin/EquipmentTab";
import { PacwareIdInlineEdit } from "@/components/admin/PacwareIdInlineEdit";
import { PatientActionBar } from "@/components/admin/PatientActionBar";
import { ClickToDialCard } from "@/components/admin/ClickToDialCard";
import { LogInterventionCard } from "@/components/admin/LogInterventionCard";
import { PatientCmnCard } from "@/components/admin/PatientCmnCard";
import { PatientBillingTab } from "@/components/admin/PatientBillingTab";
import { PatientResupplyTab } from "@/components/admin/PatientResupplyTab";
import { PatientPacketsTab } from "@/components/admin/PatientPacketsTab";
import { PortalTab } from "@/components/admin/PortalTab";
import { PrescriptionsTab } from "@/components/admin/PrescriptionsTab";
import { SettingsCard } from "@/components/admin/SettingsCard";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";
import {
  Badge,
  humanizeStatus,
  patientStatusVariant,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Label } from "@/components/admin/Input";
import { fullName, formatDate, formatDateTime } from "@/lib/admin/format";
import {
  listPatientIntegrations,
  refreshPatientIntegration,
  type IntegrationSource,
} from "@/lib/admin/patient-integrations-api";
// Page-local tab components extracted from this file — each owns its
// own data fetching + local state; the page passes ids/data/callbacks.
import { TimelineTab } from "@/pages/admin/patient-detail/TimelineTab";
import { ActivityTab } from "@/pages/admin/patient-detail/ActivityTab";
import { AddressHistoryTab } from "@/pages/admin/patient-detail/AddressHistoryTab";
import { EpisodesTab } from "@/pages/admin/patient-detail/EpisodesTab";
import { ConversationsTab } from "@/pages/admin/patient-detail/ConversationsTab";
import { FulfillmentsTab } from "@/pages/admin/patient-detail/FulfillmentsTab";
import { FollowupsTab } from "@/pages/admin/patient-detail/FollowupsTab";
import { OnboardingTab } from "@/pages/admin/patient-detail/OnboardingTab";
import { FaxOutreachTab } from "@/pages/admin/patient-detail/FaxOutreachTab";
import { FormAcksTab } from "@/pages/admin/patient-detail/FormAcksTab";
import { IntegrationSourceCard } from "@/pages/admin/patient-detail/IntegrationSourceCard";

type Tab =
  | "timeline"
  | "activity"
  | "address"
  | "episodes"
  | "conversations"
  | "fulfillments"
  | "prescriptions"
  | "notes"
  | "followups"
  | "onboarding"
  | "fax-outreach"
  | "documents"
  | "portal"
  | "device-data"
  | "sleep-studies"
  | "insurance"
  | "prior-auths"
  | "billing"
  | "resupply"
  | "equipment"
  | "forms"
  | "packets"
  | "alert-overrides";

/**
 * Admin detail page for a patient, presenting header info, action controls, settings, and a tabbed view of related data.
 *
 * Renders an error panel when the patient cannot be loaded and a loading state while fetching. On success it shows the patient header (name, identifiers, status, contact badges, last contact), the action bar and settings panel, then a tab strip that switches between timeline, activity, address history, episodes, conversations, fulfillments, prescriptions, notes, follow-ups, onboarding, fax outreach, documents, portal, device data, sleep studies, insurance, prior authorizations, equipment, and forms. The tab bar also includes a Claims button that navigates to the patient's insurance-claims route.
 *
 * @param id - The patient identifier to load and display
 * @returns The patient detail admin page UI
 */
export function PatientDetailPage({ id }: { id: string }) {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("timeline");
  const { data, isPending, isError, error, refetch } = useGetPatient(id);

  if (isError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load patient"
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <Card>
          <Spinner label="Loading patient…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <BackLink />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-semibold mb-1"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {fullName(data.firstName, data.lastName)}
            </h1>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              <PacwareIdInlineEdit
                patient={data}
                onSaved={() => void refetch()}
              />{" "}
              · Patient created {formatDate(data.createdAt)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Badge variant={patientStatusVariant(data.status)}>
              {humanizeStatus(data.status)}
            </Badge>
            {data.linkedCustomerUserId ? (
              // This patient shares a portal login with a shop customer —
              // a deterministic link, so jump straight to that record.
              <Link
                href={`/admin/shop/customers/${encodeURIComponent(
                  data.linkedCustomerUserId,
                )}`}
                className="text-xs font-semibold hover:underline whitespace-nowrap"
                style={{ color: "hsl(var(--penn-navy))" }}
                title="Open the shop-customer record that shares this patient's portal login"
              >
                View customer record →
              </Link>
            ) : (
              // No shared login on file — fall back to a name search of
              // the Customers directory (not a guaranteed match).
              <Link
                href={`/admin/shop/customers?search=${encodeURIComponent(
                  fullName(data.firstName, data.lastName),
                )}`}
                className="text-xs font-semibold hover:underline whitespace-nowrap"
                style={{ color: "hsl(var(--penn-navy))" }}
                title="Search the storefront Customers directory for this name"
              >
                Find in Customers →
              </Link>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Channels on file
            </p>
            <div className="flex gap-2">
              {data.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
              {data.hasEmail && <Badge variant="neutral">Email</Badge>}
              {!data.hasPhone && !data.hasEmail && (
                <Badge variant="muted">No contact methods on file</Badge>
              )}
            </div>
          </div>
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Last updated
            </p>
            <p style={{ color: "hsl(var(--ink-1))" }}>
              {formatDateTime(data.updatedAt)}
            </p>
          </div>
        </div>
        {/*
          Last contact strip. Sourced from patient_latest_message
          (refreshed in-line on every inbound/outbound write across
          SMS / email / voice transcript). Hidden entirely when the
          patient has no message history yet — the empty state would
          add visual noise without conveying anything an admin can
          act on.

          Direction is rendered as a coloured Badge (warning for
          inbound = "they're waiting on us", neutral for outbound)
          to mirror the colour cue used in the patients list. The
          preview sits below in a single ellipsised line; the full
          80-char body is also exposed via the title attribute so
          hovering reveals the rest without taking layout space.
        */}
        {data.lastMessageAt ? (
          <div
            className="mt-4 pt-4 border-t"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Last contact
            </p>
            <div className="flex items-center gap-2 text-sm">
              <Badge
                variant={
                  data.lastMessageDirection === "inbound"
                    ? "warning"
                    : "neutral"
                }
              >
                {data.lastMessageDirection === "inbound"
                  ? "Inbound"
                  : "Outbound"}
              </Badge>
              <span style={{ color: "hsl(var(--ink-1))" }}>
                {formatDateTime(data.lastMessageAt)}
              </span>
            </div>
            {data.lastMessagePreview ? (
              <p
                className="mt-1 text-sm"
                style={{
                  color: "hsl(var(--ink-2))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "48rem",
                }}
                title={data.lastMessagePreview}
              >
                {data.lastMessagePreview}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <PatientActionBar patient={data} onAfterAction={() => void refetch()} />

      <ClickToDialCard patientId={data.id} hasPhone={data.hasPhone} />

      <LogInterventionCard patientId={data.id} />

      <PatientCmnCard patientId={data.id} />

      <SettingsCard patient={data} onSaved={() => void refetch()} />

      <div
        className="flex gap-1 border-b"
        style={{ borderColor: "hsl(var(--line-1))" }}
        role="tablist"
      >
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </TabButton>
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity
        </TabButton>
        <TabButton active={tab === "address"} onClick={() => setTab("address")}>
          Address
        </TabButton>
        <TabButton
          active={tab === "episodes"}
          onClick={() => setTab("episodes")}
        >
          Episodes ({data.episodes.length})
        </TabButton>
        <TabButton
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
        >
          Conversations ({data.conversations.length})
        </TabButton>
        <TabButton
          active={tab === "fulfillments"}
          onClick={() => setTab("fulfillments")}
        >
          Fulfillments ({data.fulfillments.length})
        </TabButton>
        <TabButton
          active={tab === "prescriptions"}
          onClick={() => setTab("prescriptions")}
        >
          Prescriptions ({data.prescriptions.length})
        </TabButton>
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
          Notes
        </TabButton>
        <TabButton
          active={tab === "followups"}
          onClick={() => setTab("followups")}
        >
          Follow-ups
        </TabButton>
        <TabButton
          active={tab === "onboarding"}
          onClick={() => setTab("onboarding")}
        >
          Onboarding
        </TabButton>
        <TabButton
          active={tab === "fax-outreach"}
          onClick={() => setTab("fax-outreach")}
        >
          Fax outreach
        </TabButton>
        <TabButton
          active={tab === "documents"}
          onClick={() => setTab("documents")}
        >
          Documents
        </TabButton>
        <TabButton active={tab === "portal"} onClick={() => setTab("portal")}>
          Portal
        </TabButton>
        <TabButton
          active={tab === "device-data"}
          onClick={() => setTab("device-data")}
        >
          Device data
        </TabButton>
        <TabButton
          active={tab === "sleep-studies"}
          onClick={() => setTab("sleep-studies")}
        >
          Sleep studies
        </TabButton>
        <TabButton
          active={tab === "insurance"}
          onClick={() => setTab("insurance")}
        >
          Insurance
        </TabButton>
        <TabButton
          active={tab === "prior-auths"}
          onClick={() => setTab("prior-auths")}
        >
          Prior auths
        </TabButton>
        <TabButton active={tab === "billing"} onClick={() => setTab("billing")}>
          Billing
        </TabButton>
        <TabButton
          active={tab === "resupply"}
          onClick={() => setTab("resupply")}
        >
          Resupply
        </TabButton>
        <TabButton
          active={false}
          onClick={() => setLocation(`/admin/patients/${id}/insurance-claims`)}
        >
          Claims
        </TabButton>
        <TabButton
          active={tab === "equipment"}
          onClick={() => setTab("equipment")}
        >
          Equipment
        </TabButton>
        <TabButton active={tab === "forms"} onClick={() => setTab("forms")}>
          Forms
        </TabButton>
        <TabButton active={tab === "packets"} onClick={() => setTab("packets")}>
          Signatures
        </TabButton>
        <TabButton
          active={tab === "alert-overrides"}
          onClick={() => setTab("alert-overrides")}
        >
          Alert overrides
        </TabButton>
      </div>

      {/*
        Keyed on the patient id: this page receives a NEW `id` prop
        without remounting when the operator jumps patient→patient
        (global lookup, back/forward), and a cached target skips the
        spinner branch — so stateful tab bodies (e.g. FaxOutreachTab's
        physician/cover-letter compose fields) would otherwise carry the
        PREVIOUS patient's draft and submit it under the new patient.
        The key remounts the active tab with fresh state on switch.
      */}
      <Card key={id}>
        {tab === "timeline" && (
          <TimelineTab
            patientId={id}
            onConversationClick={(cid) =>
              setLocation(`/admin/conversations/${cid}`)
            }
          />
        )}
        {tab === "activity" && <ActivityTab patientId={id} />}
        {tab === "address" && <AddressHistoryTab patientId={id} />}
        {tab === "episodes" && <EpisodesTab episodes={data.episodes} />}
        {tab === "conversations" && (
          <ConversationsTab
            conversations={data.conversations}
            onRowClick={(cid) => setLocation(`/admin/conversations/${cid}`)}
          />
        )}
        {tab === "fulfillments" && (
          <FulfillmentsTab fulfillments={data.fulfillments} />
        )}
        {tab === "prescriptions" && (
          <PrescriptionsTab
            patientId={id}
            prescriptions={data.prescriptions}
            onChanged={() => void refetch()}
          />
        )}
        {tab === "notes" && <NotesTab patientId={id} />}
        {tab === "followups" && <FollowupsTab patientId={id} />}
        {tab === "onboarding" && <OnboardingTab patientId={id} />}
        {tab === "fax-outreach" && (
          <FaxOutreachTab patientId={id} prescriptions={data.prescriptions} />
        )}
        {tab === "documents" && <DocumentsTab patientId={id} />}
        {tab === "portal" && (
          <PortalTab patient={data} onChanged={() => void refetch()} />
        )}
        {tab === "device-data" && <IntegrationsTab patientId={id} />}
        {tab === "sleep-studies" && <SleepStudiesTab patientId={id} />}
        {tab === "insurance" && <InsuranceCoveragesTab patientId={id} />}
        {tab === "prior-auths" && <PriorAuthorizationsTab patientId={id} />}
        {tab === "billing" && <PatientBillingTab patientId={id} />}
        {tab === "resupply" && <PatientResupplyTab patientId={id} />}
        {tab === "equipment" && <EquipmentTab patientId={id} />}
        {tab === "forms" && <FormAcksTab patientId={id} />}
        {tab === "packets" && (
          <PatientPacketsTab
            patientId={id}
            hasEmail={data.hasEmail}
            hasPhone={data.hasPhone}
            onChanged={() => void refetch()}
          />
        )}
        {tab === "alert-overrides" && (
          <AlertMessageOverridesPanel patientId={id} />
        )}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/patients"
      className="text-sm underline"
      style={{ color: "hsl(var(--ink-1))" }}
    >
      ← Back to patients
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
      style={{
        color: active ? "#0a1f44" : "#6b7280",
        borderColor: active ? "#c9a24a" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// Single-source the prescription row shape from the generated
// OpenAPI client so the dashboard cannot drift from the contract.
// Attachment metadata fields are part of the schema; the underlying
// GCS object key is intentionally not exposed (downloads go through
// the dedicated, audit-logged GET endpoint).
// Exported as part of the page's typing surface (the extracted tab
// components type their props against the same generated shape).
export type Prescription = PatientPrescription;

// ----------------------
// Notes tab
// ----------------------
//
// Append-only admin case-notes. Composer at the top, newest-first
// list below. The empty state nudges admins to leave a note for the
// next person picking up the patient — the goal is to make handoff
// context discoverable.

function NotesTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } =
    useListPatientNotes(patientId);
  const create = useCreatePatientNote();
  // For the optimistic note's author chip — already cached by
  // AppShell's own useGetAdminMe call, so this never adds a request.
  const { data: adminMe } = useGetAdminMe();
  const [body, setBody] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Client-side filter. Notes are paginated to 50 server-side, so
  // an in-memory substring filter is more than fast enough for the
  // admin search-as-you-type use case. If we later add deeper
  // history, the filter input becomes the natural place to plumb a
  // server-side `?search=` query.
  const [filter, setFilter] = useState("");

  const trimmed = body.trim();
  const tooLong = trimmed.length > 4000;
  const canSubmit = trimmed.length > 0 && !tooLong && !create.isPending;

  const filterTrimmed = filter.trim().toLowerCase();
  const filteredItems =
    data && filterTrimmed
      ? data.items.filter((n) =>
          (n.body ?? "").toLowerCase().includes(filterTrimmed),
        )
      : (data?.items ?? []);

  async function onAdd() {
    if (!canSubmit) return;
    setSubmitError(null);
    // Optimistic prepend: show the note (and clear the composer)
    // immediately instead of blocking the UI on the round-trip +
    // full-list refetch. On error the cache rolls back AND the
    // composer text is restored so nothing the admin typed is lost.
    const notesKey = getListPatientNotesQueryKey(patientId);
    await queryClient.cancelQueries({ queryKey: notesKey });
    const previous = queryClient.getQueryData<PatientNotesPage>(notesKey);
    if (previous) {
      const optimistic: PatientNote = {
        id: `optimistic-${Date.now()}`,
        body: trimmed,
        authorEmail: adminMe?.email ?? "saving…",
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<PatientNotesPage>(notesKey, {
        items: [optimistic, ...previous.items],
        count: previous.count + 1,
      });
    }
    setBody("");
    try {
      await create.mutateAsync({ id: patientId, data: { body: trimmed } });
      // Re-sync so the optimistic row picks up its server id/timestamp.
      await queryClient.invalidateQueries({ queryKey: notesKey });
      void refetch();
    } catch (err) {
      if (previous) queryClient.setQueryData(notesKey, previous);
      setBody(trimmed);
      const msg =
        err instanceof ApiError
          ? ((err.data as { message?: string } | undefined)?.message ??
            "Couldn't save note.")
          : err instanceof Error
            ? err.message
            : "Couldn't save note.";
      setSubmitError(msg);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="note-body">Add a note</Label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={4100}
          placeholder="Patient is recovering from minor surgery; pause reminders for 2 weeks…"
          disabled={create.isPending}
          className="w-full rounded border px-3 py-2 text-sm font-sans resize-y"
          style={{
            borderColor: "hsl(var(--line-1))",
            color: "hsl(var(--ink-1))",
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span
            className="text-xs"
            style={{ color: tooLong ? "#b91c1c" : "#6b7280" }}
          >
            {trimmed.length} / 4000 · stored encrypted at rest
          </span>
          <Button
            onClick={() => void onAdd()}
            isLoading={create.isPending}
            disabled={!canSubmit}
          >
            Add note
          </Button>
        </div>
        {submitError && (
          <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
            {submitError}
          </p>
        )}
      </div>

      {isError ? (
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load notes"
        />
      ) : isPending || !data ? (
        <Spinner label="Loading notes…" />
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No notes yet."
          hint="Add the first one to leave context for the next admin."
        />
      ) : (
        <>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes…"
              className="flex-1 rounded border px-3 py-2 text-sm"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--ink-1))",
              }}
              aria-label="Filter notes"
            />
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {filterTrimmed
                ? `${filteredItems.length} of ${data.items.length}`
                : `${data.items.length} ${data.items.length === 1 ? "note" : "notes"}`}
            </span>
          </div>
          {filteredItems.length === 0 ? (
            <EmptyState
              title="No notes match your filter."
              hint="Clear the filter to see all notes again."
            />
          ) : (
            <ol className="space-y-3">
              {filteredItems.map((n) => (
                <NoteRow key={n.id} note={n} />
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function NoteRow({ note }: { note: PatientNote }) {
  return (
    <li
      className="rounded border px-3 py-2"
      style={{ borderColor: "hsl(var(--line-1))", backgroundColor: "#fafafa" }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span
          className="text-xs font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {note.authorEmail}
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(note.createdAt)}
        </span>
      </div>
      <p
        className="text-sm whitespace-pre-wrap break-words"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {note.body}
      </p>
    </li>
  );
}

// IntegrationsTab — unified "Device data" view across ResMed AirView,
// Philips Care Orchestrator, and React Health. Reads the cached
// snapshot per source; the Refresh button re-pulls from the partner.
// Per-source snapshot rendering lives in
// patient-detail/IntegrationSourceCard.tsx.
function IntegrationsTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "patient-integrations", patientId];
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listPatientIntegrations(patientId),
  });
  const [refreshingSource, setRefreshingSource] =
    useState<IntegrationSource | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refreshMutation = useMutation({
    mutationFn: (source: IntegrationSource) =>
      refreshPatientIntegration(patientId, source),
    onMutate: (source) => {
      setRefreshingSource(source);
      setRefreshError(null);
    },
    onSettled: () => {
      setRefreshingSource(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: (result) => {
      if (result.fetchError) {
        setRefreshError(`Partner returned ${result.fetchError}`);
      }
    },
    onError: (err: unknown) => {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed.");
    },
  });

  if (isError) {
    return (
      <ErrorPanel
        error={error}
        onRetry={() => void refetch()}
        title="Couldn't load device data"
      />
    );
  }
  if (isPending || !data) {
    return <Spinner label="Loading device data…" />;
  }
  if (data.sources.length === 0) {
    return (
      <EmptyState title="No therapy-cloud integrations are configured for this patient." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Therapy data from each configured cloud. Refresh re-pulls from the
          partner; the snapshot is cached for the dashboard and the
          patient-facing adherence card.
        </p>
        <GenerateAttestationButton
          patientId={patientId}
          onError={setRefreshError}
        />
      </div>
      {refreshError && (
        <div
          className="rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-2))",
            background: "hsl(var(--bg-2))",
          }}
        >
          {refreshError}
        </div>
      )}
      {data.sources.map((src) => (
        <IntegrationSourceCard
          key={src.source}
          view={src}
          refreshing={refreshingSource === src.source}
          onRefresh={() => refreshMutation.mutate(src.source)}
        />
      ))}
    </div>
  );
}

// "Generate adherence attestation" — pre-flights the
// /admin/patients/:id/compliance-attestation endpoint and opens the
// PDF in a new tab. The route returns 422 with `no_therapy_data`
// when the patient has zero therapy_nights on file (no SD card
// upload + no modem sync yet), which we surface inline rather than
// rendering a JSON error in a new tab.
function GenerateAttestationButton({
  patientId,
  onError,
}: {
  patientId: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const result = await openPdfInNewTab(
        `/resupply-api/admin/patients/${encodeURIComponent(
          patientId,
        )}/compliance-attestation`,
      );
      if (!result.ok) {
        onError(`Attestation: ${summarizePdfError(result.error)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      intent="secondary"
      isLoading={busy}
      disabled={busy}
      onClick={() => void handleClick()}
    >
      Generate 90-day attestation
    </Button>
  );
}

// /admin/support — tenant support tickets with an AI intake bot.
//
// A tenant admin files a support request to the platform operator; the
// intake bot answers from the admin-console knowledge base on the spot
// when it can, and otherwise the ticket goes to a human at the platform.
// This page is the tenant's view: file a ticket, read the bot's answer,
// follow up, and resolve.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ExternalLink,
  LifeBuoy,
  Mail,
  PhoneCall,
} from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { Input, Label } from "@/components/admin/Input";
import { PageHeader } from "@/components/admin/PageHeader";
import { Spinner } from "@/components/admin/Spinner";
import {
  addSupportMessage,
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  resolveSupportTicket,
  statusLabel,
  statusVariant,
  type SupportMessage,
  type SupportTicket,
} from "@/lib/admin/support-api";
import { formatAppDateTime } from "@/lib/utils";
import {
  buildCentralSupportUrl,
  CENTRAL_SUPPORT_EMAIL,
  CENTRAL_SUPPORT_PHONE_DISPLAY,
  CENTRAL_SUPPORT_PHONE_E164,
  isCentralSupportHubEnabled,
  safeStaticAdminNavHref,
} from "@/components/admin/central-support";

const TEXTAREA_CLASS =
  "w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2";
const textareaStyle = {
  borderColor: "hsl(var(--line-1))",
  backgroundColor: "hsl(var(--surface-1))",
  color: "hsl(var(--ink-1))",
} as const;

function authorLabel(role: SupportMessage["authorRole"]): string {
  if (role === "bot") return "Support bot";
  if (role === "platform") return "Support team";
  return "You";
}

function MessageBubble({ m }: { m: SupportMessage }) {
  const isYou = m.authorRole === "tenant";
  return (
    <div className={isYou ? "flex justify-end" : "flex justify-start"}>
      <div
        className="max-w-[85%] rounded-lg px-3 py-2"
        style={{
          backgroundColor: isYou
            ? "hsl(var(--penn-navy) / 0.08)"
            : "hsl(var(--surface-2))",
          border: "1px solid hsl(var(--line-1))",
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-[11px] font-semibold"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            {authorLabel(m.authorRole)}
          </span>
          {m.authorRole === "bot" && <Badge variant="info">AI</Badge>}
          <span className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
            {formatAppDateTime(m.createdAt)}
          </span>
        </div>
        <p
          className="text-sm whitespace-pre-wrap leading-snug"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {m.body}
        </p>
      </div>
    </div>
  );
}

function NewTicketCard({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createSupportTicket({ subject: subject.trim(), body: body.trim() }),
    onSuccess: (detail) => {
      setSubject("");
      setBody("");
      setNotice(
        detail.botOffline
          ? "Ticket filed. Our support team will follow up shortly."
          : detail.ticket.botAnswered
            ? "The support bot answered below — take a look!"
            : "Ticket filed and routed to our support team.",
      );
      void queryClient.invalidateQueries({ queryKey: ["support-tickets"] });
      onCreated(detail.ticket.id);
    },
  });

  const canSubmit =
    subject.trim().length > 0 && body.trim().length > 0 && !create.isPending;

  return (
    <Card
      title="Ask for help"
      subtitle="File a support request. Our bot answers how-to questions instantly; anything else goes to a person."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <div>
          <Label htmlFor="support-subject">Subject</Label>
          <Input
            id="support-subject"
            value={subject}
            maxLength={300}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="How do I add a team member?"
          />
        </div>
        <div>
          <Label htmlFor="support-body">What do you need help with?</Label>
          <textarea
            id="support-body"
            className={TEXTAREA_CLASS}
            style={textareaStyle}
            rows={4}
            maxLength={6000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe your question or the problem you're seeing…"
          />
        </div>
        {notice && (
          <p className="text-xs" style={{ color: "hsl(152 70% 24%)" }}>
            {notice}
          </p>
        )}
        {create.isError && (
          <p className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
            Couldn&apos;t file the ticket. Please try again.
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={!canSubmit}
            isLoading={create.isPending}
          >
            Submit ticket
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TicketList({
  tickets,
  selectedId,
  onSelect,
}: {
  tickets: SupportTicket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <EmptyState
        title="No tickets yet."
        hint="File one above to get started."
      />
    );
  }
  return (
    <ul className="space-y-1">
      {tickets.map((t) => {
        const active = t.id === selectedId;
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              className="w-full text-left rounded-md px-3 py-2 border"
              style={{
                borderColor: active
                  ? "hsl(var(--penn-navy))"
                  : "hsl(var(--line-1))",
                backgroundColor: active
                  ? "hsl(var(--penn-navy) / 0.06)"
                  : "transparent",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-sm font-medium truncate"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {t.subject}
                </span>
                <Badge variant={statusVariant(t.status)}>
                  {statusLabel(t.status)}
                </Badge>
              </div>
              <div
                className="text-[11px]"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {formatAppDateTime(t.lastActivityAt)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TicketThread({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const detail = useQuery({
    queryKey: ["support-ticket", id],
    queryFn: () => getSupportTicket(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["support-ticket", id] });
    void queryClient.invalidateQueries({ queryKey: ["support-tickets"] });
  };
  const send = useMutation({
    mutationFn: () => addSupportMessage(id, reply.trim()),
    onSuccess: () => {
      setReply("");
      invalidate();
    },
  });
  const resolve = useMutation({
    mutationFn: () => resolveSupportTicket(id),
    onSuccess: invalidate,
  });

  if (detail.isPending) return <Spinner label="Loading ticket…" />;
  if (detail.isError || !detail.data) {
    return <EmptyState title="Couldn't load that ticket." hint="Try again." />;
  }
  const { ticket, messages } = detail.data;
  const closed = ticket.status === "resolved" || ticket.status === "closed";

  return (
    <Card
      title={ticket.subject}
      action={
        <Badge variant={statusVariant(ticket.status)}>
          {statusLabel(ticket.status)}
        </Badge>
      }
    >
      <div className="space-y-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
      </div>

      {!closed && (
        <div
          className="mt-4 pt-4 border-t space-y-2"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <textarea
            className={TEXTAREA_CLASS}
            style={textareaStyle}
            rows={3}
            maxLength={6000}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Add a reply…"
          />
          <div className="flex items-center justify-between">
            <Button
              intent="ghost"
              size="sm"
              isLoading={resolve.isPending}
              onClick={() => resolve.mutate()}
            >
              Mark resolved
            </Button>
            <Button
              size="sm"
              disabled={reply.trim().length === 0 || send.isPending}
              isLoading={send.isPending}
              onClick={() => send.mutate()}
            >
              Send reply
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function CentralAdminSupportPage() {
  const supportHubUrl = buildCentralSupportUrl({
    staticRoute: safeStaticAdminNavHref("/admin/support"),
  });

  return (
    <div className="admin-root space-y-6">
      <PageHeader
        title="Support"
        description="One place for CareMetric Breathe software help, courses, tutorials, videos, and support requests."
        icon={LifeBuoy}
      />
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <Card
          title="CareMetric Support Hub"
          subtitle="Search shared guidance or contact the central software support team."
        >
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              The Support Hub brings product help, training courses, tutorials,
              and explainer videos together so the same resources can be used
              across CareMetric software.
            </p>
            <a
              href={supportHubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold"
              style={{
                backgroundColor: "hsl(var(--penn-navy))",
                color: "white",
              }}
              data-testid="central-support-hub-link"
            >
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
              Open Support Hub
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              The launcher sends only the Breathe product key, this static admin
              page category, app version, and deployment environment. It does
              not place user, tenant, patient, or ticket details in the URL.
            </p>
          </div>
        </Card>

        <Card
          title="Contact software support"
          subtitle="Use the central CareMetric contact details for help with the software."
        >
          <div className="space-y-3">
            <a
              href={`tel:${CENTRAL_SUPPORT_PHONE_E164}`}
              className="flex items-center gap-3 rounded-md border px-3 py-3 text-sm font-semibold"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--penn-navy))",
              }}
            >
              <PhoneCall className="h-4 w-4" aria-hidden="true" />
              {CENTRAL_SUPPORT_PHONE_DISPLAY}
            </a>
            <a
              href={`mailto:${CENTRAL_SUPPORT_EMAIL}`}
              className="flex items-center gap-3 rounded-md border px-3 py-3 text-sm font-semibold"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--penn-navy))",
              }}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {CENTRAL_SUPPORT_EMAIL}
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}

function LocalAdminSupportPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["support-tickets"],
    queryFn: () => listSupportTickets(),
  });

  const tickets = useMemo(() => list.data?.tickets ?? [], [list.data]);
  const activeId = selectedId ?? tickets[0]?.id ?? null;

  return (
    <div className="admin-root space-y-6">
      <PageHeader
        title="Support"
        description="File a support request to the CareMetric Breathe team. Our AI assistant answers how-to questions instantly; everything else is handled by a person."
        icon={LifeBuoy}
      />
      <div className="grid gap-6 lg:grid-cols-[340px_1fr] items-start">
        <div className="space-y-6">
          <Card
            title="User manual"
            subtitle="The complete CareMetric Breathe operator manual — every feature, the setup guide, and step-by-step job aides for each role."
          >
            <a
              href="/resupply-api/admin/support/manual"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold"
              style={{
                backgroundColor: "hsl(var(--penn-navy))",
                color: "white",
              }}
            >
              <BookOpen className="h-4 w-4" />
              Open the User Manual (PDF)
            </a>
          </Card>
          <NewTicketCard onCreated={(id) => setSelectedId(id)} />
          <Card title="Your tickets">
            {list.isPending ? (
              <Spinner label="Loading…" />
            ) : (
              <TicketList
                tickets={tickets}
                selectedId={activeId}
                onSelect={setSelectedId}
              />
            )}
          </Card>
        </div>
        {activeId ? (
          <TicketThread id={activeId} />
        ) : (
          <Card title="No ticket selected">
            <EmptyState
              title="Pick a ticket or file a new one."
              hint="Your conversation will show up here."
            />
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * Feature-flagged handoff. Turning the flag off restores the existing local
 * ticket UI without a code rollback or data migration.
 */
export function AdminSupportPage() {
  return isCentralSupportHubEnabled() ? (
    <CentralAdminSupportPage />
  ) : (
    <LocalAdminSupportPage />
  );
}

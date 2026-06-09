import { useMemo, useState } from "react";
import { useLocation } from "wouter";

import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Pagination } from "@/components/admin/Pagination";
import { fullName, formatDateTime } from "@/lib/admin/format";
import {
  useEmailInbox,
  type EmailInboxItem,
  type EmailMailbox,
} from "@/lib/admin/email-inbox-api";

const PAGE_SIZE = 25;

const MAILBOXES: { value: EmailMailbox; label: string }[] = [
  { value: "needs_response", label: "Needs response" },
  { value: "responded", label: "Responded" },
];

export function EmailInboxPage() {
  const [, setLocation] = useLocation();
  const [mailbox, setMailboxState] = useState<EmailMailbox>("needs_response");
  const [offset, setOffset] = useState(0);

  // Switching mailbox resets pagination — the two folders are
  // independent lists.
  const setMailbox = (next: EmailMailbox) => {
    setMailboxState(next);
    setOffset(0);
  };

  const params = useMemo(
    () => ({ mailbox, limit: PAGE_SIZE, offset }),
    [mailbox, offset],
  );
  const { data, isPending, isError, error, isFetching, refetch } =
    useEmailInbox(params);

  const counts = data?.counts;

  const cols: Column<EmailInboxItem>[] = [
    {
      key: "from",
      header: "From",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {fullName(r.patientFirstName, r.patientLastName) ||
              "Unknown sender"}
          </div>
          {r.patientEmail && (
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {r.patientEmail}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "subject",
      header: "Subject & message",
      render: (r) => (
        <div className="min-w-0">
          <div
            className="font-medium truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {r.subject || "(no subject)"}
          </div>
          {r.lastMessagePreview && (
            <div
              className="text-xs truncate"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {r.lastMessageDirection === "outbound" && (
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  {r.lastMessageAutoReply ? "Auto-reply: " : "You: "}
                </span>
              )}
              {r.lastMessagePreview}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "tag",
      header: "",
      render: (r) =>
        r.lastMessageAutoReply ? (
          <Badge variant="info">Bot replied</Badge>
        ) : r.lastMessageDirection === "outbound" ? (
          <Badge variant="success">Replied</Badge>
        ) : (
          <Badge variant="warning">Awaiting reply</Badge>
        ),
    },
    {
      key: "last",
      header: "Last activity",
      render: (r) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
          {formatDateTime(r.lastMessageAt ?? r.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Email Inbox
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Inbound patient emails. The chatbot answers what it can; anything it
          hands off lands in “Needs response” for a human. Open a thread to read
          the full message and reply.
        </p>
      </header>

      <Card>
        <div
          role="tablist"
          aria-label="Email mailboxes"
          className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-slate-100"
        >
          {MAILBOXES.map((m) => {
            const active = m.value === mailbox;
            const count =
              m.value === "needs_response"
                ? counts?.needsResponse
                : counts?.responded;
            return (
              <button
                key={m.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMailbox(m.value)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  active
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid={`email-mailbox-${m.value}`}
              >
                {m.label}
                {typeof count === "number" && (
                  <span
                    className={`ml-2 inline-flex items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${
                      m.value === "needs_response" && count > 0
                        ? "bg-amber-200 text-amber-900"
                        : "bg-slate-200 text-slate-700"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading email…" />
          ) : (
            <>
              <Table
                columns={cols}
                rows={data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setLocation(`/admin/conversations/${r.id}`)}
                emptyState={
                  <EmptyState
                    title={
                      mailbox === "needs_response"
                        ? "Inbox zero — no emails waiting on a human."
                        : "No answered emails yet."
                    }
                    hint={
                      mailbox === "needs_response"
                        ? "Emails the chatbot hands off will appear here."
                        : "Emails answered by the assistant or your team show up here."
                    }
                  />
                }
              />
              <Pagination
                total={data.total}
                limit={data.limit}
                offset={data.offset}
                onChange={setOffset}
                isLoading={isFetching}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

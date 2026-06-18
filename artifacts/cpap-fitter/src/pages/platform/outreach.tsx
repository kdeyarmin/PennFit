// Platform super-admin: Outreach.
//
// The platform operator's broadcast tool — email existing tenants, saved
// contacts/leads, or a pasted cold list from the platform's own sender.
// Two tabs: Campaigns (compose + send) and Contacts (the mini-CRM).
//
// Rendered inside PlatformConsole (console.tsx), which already wraps
// everything in `.admin-root` for the admin design tokens (hard rule R7).

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  useListTenants,
  type PlatformTenant,
} from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { Input, Label } from "@/components/admin/Input";
import { PageHeader } from "@/components/admin/PageHeader";
import { Spinner } from "@/components/admin/Spinner";
import { Table, type Column } from "@/components/admin/Table";
import {
  createPlatformCampaignDraft,
  createPlatformContact,
  deletePlatformContact,
  getPlatformCampaign,
  importPlatformContacts,
  listPlatformCampaigns,
  listPlatformContacts,
  platformCampaignAction,
  updatePlatformContact,
  type PlatformAudienceKind,
  type PlatformCampaignSummary,
  type PlatformContact,
} from "@/lib/admin/platform-outreach-api";

const INK1 = "hsl(var(--ink-1))";
const INK2 = "hsl(var(--ink-2))";
const INK3 = "hsl(var(--ink-3))";
const DANGER = "hsl(354 75% 38%)";
const SUCCESS = "hsl(152 70% 24%)";

function campaignStatusVariant(
  s: string,
): "success" | "danger" | "muted" | "neutral" | "info" {
  switch (s) {
    case "sent":
      return "success";
    case "sending":
      return "info";
    case "cancelled":
      return "danger";
    case "paused":
      return "muted";
    default:
      return "neutral";
  }
}

const AUDIENCE_LABELS: Record<PlatformAudienceKind, string> = {
  all_tenants: "All tenants (owner accounts)",
  selected_tenants: "Selected tenants",
  all_contacts: "All saved contacts",
  contacts_by_tag: "Contacts with a tag",
  manual_list: "Pasted email list",
};

// ── Compose ─────────────────────────────────────────────────────────

function ComposeCard({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [audienceKind, setAudienceKind] =
    useState<PlatformAudienceKind>("all_contacts");
  const [tag, setTag] = useState("");
  const [emails, setEmails] = useState("");
  const [throttle, setThrottle] = useState(60);
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantsQ = useListTenants({
    query: { enabled: audienceKind === "selected_tenants" },
  });

  const create = useMutation({
    mutationFn: () => {
      const emailList =
        audienceKind === "manual_list"
          ? emails
              .split(/[\s,;]+/)
              .map((e) => e.trim())
              .filter(Boolean)
          : undefined;
      return createPlatformCampaignDraft({
        name: name.trim(),
        subject: subject.trim(),
        bodyText: bodyText.trim(),
        audienceKind,
        tenantIds:
          audienceKind === "selected_tenants" ? selectedTenantIds : undefined,
        tag: audienceKind === "contacts_by_tag" ? tag.trim() : undefined,
        emails: emailList,
        throttlePerMinute: throttle,
      });
    },
    onSuccess: (res) => {
      setError(null);
      setNotice(
        `Draft created: ${res.totals.pending} will receive it, ${res.totals.suppressed} suppressed. Review and start it below.`,
      );
      setName("");
      setSubject("");
      setBodyText("");
      setEmails("");
      setTag("");
      setSelectedTenantIds([]);
      onCreated();
    },
    onError: () =>
      setError("Couldn't create the draft. Check the fields and try again."),
  });

  const canSubmit =
    name.trim().length > 0 &&
    subject.trim().length > 0 &&
    bodyText.trim().length > 0 &&
    (audienceKind !== "selected_tenants" || selectedTenantIds.length > 0) &&
    (audienceKind !== "contacts_by_tag" || tag.trim().length > 0) &&
    (audienceKind !== "manual_list" || emails.trim().length > 0) &&
    !create.isPending;

  return (
    <Card
      title="Compose a campaign"
      subtitle="Sends from the platform's own address (CareMetric Breathe). Saved contacts get a one-click unsubscribe link; pasted/tenant recipients get a reply-to-opt-out note."
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="c-name">Internal name</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="June partner outreach"
            />
          </div>
          <div>
            <Label htmlFor="c-throttle">Throttle (emails/min)</Label>
            <Input
              id="c-throttle"
              type="number"
              min={1}
              max={3600}
              value={throttle}
              onChange={(e) =>
                setThrottle(
                  Math.max(1, Math.min(3600, Number(e.target.value) || 1)),
                )
              }
            />
          </div>
        </div>
        <div>
          <Label htmlFor="c-subject">Subject</Label>
          <Input
            id="c-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="A quick note from CareMetric Breathe"
          />
        </div>
        <div>
          <Label htmlFor="c-body">Message</Label>
          <textarea
            id="c-body"
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            style={{
              borderColor: "hsl(var(--line-1))",
              backgroundColor: "hsl(var(--surface-1))",
              color: INK1,
            }}
            rows={8}
            maxLength={100_000}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Write your message in plain text…"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="c-audience">Audience</Label>
            <select
              id="c-audience"
              className="w-full rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: "hsl(var(--line-1))",
                backgroundColor: "hsl(var(--surface-1))",
                color: INK1,
              }}
              value={audienceKind}
              onChange={(e) =>
                setAudienceKind(e.target.value as PlatformAudienceKind)
              }
            >
              {(Object.keys(AUDIENCE_LABELS) as PlatformAudienceKind[]).map(
                (k) => (
                  <option key={k} value={k}>
                    {AUDIENCE_LABELS[k]}
                  </option>
                ),
              )}
            </select>
          </div>
          {audienceKind === "contacts_by_tag" && (
            <div>
              <Label htmlFor="c-tag">Tag</Label>
              <Input
                id="c-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="prospect"
              />
            </div>
          )}
        </div>
        {audienceKind === "selected_tenants" && (
          <div
            className="rounded-md border p-3 max-h-48 overflow-auto"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {tenantsQ.isPending ? (
              <Spinner label="Loading tenants…" />
            ) : (
              <div className="space-y-1">
                {(tenantsQ.data?.tenants ?? []).map((t: PlatformTenant) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: INK2 }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTenantIds.includes(t.id)}
                      onChange={(e) =>
                        setSelectedTenantIds((prev) =>
                          e.target.checked
                            ? [...prev, t.id]
                            : prev.filter((id) => id !== t.id),
                        )
                      }
                    />
                    {t.name ?? t.slug}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {audienceKind === "manual_list" && (
          <div>
            <Label htmlFor="c-emails">Email addresses</Label>
            <textarea
              id="c-emails"
              className="w-full rounded-md border px-3 py-2 text-sm font-mono"
              style={{
                borderColor: "hsl(var(--line-1))",
                backgroundColor: "hsl(var(--surface-1))",
                color: INK1,
              }}
              rows={4}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="paste addresses, separated by commas, spaces, or new lines"
            />
          </div>
        )}
        {notice && (
          <p className="text-xs" style={{ color: SUCCESS }}>
            {notice}
          </p>
        )}
        {error && (
          <p className="text-xs" style={{ color: DANGER }}>
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            disabled={!canSubmit}
            isLoading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create draft
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Campaigns list ──────────────────────────────────────────────────

function CampaignDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["platform-campaign", id],
    queryFn: () => getPlatformCampaign(id),
  });
  if (detail.isPending) return <Spinner label="Loading…" />;
  if (detail.isError || !detail.data)
    return (
      <EmptyState title="Couldn't load that campaign." hint="Try again." />
    );
  const c = detail.data;
  return (
    <div className="space-y-2 text-sm" style={{ color: INK2 }}>
      <div className="font-medium" style={{ color: INK1 }}>
        {c.subject}
      </div>
      <p className="whitespace-pre-wrap" style={{ color: INK2 }}>
        {c.bodyText}
      </p>
      <div className="text-xs" style={{ color: INK3 }}>
        Sent {c.sentCount} · failed {c.failedCount} · suppressed{" "}
        {c.suppressedCount} · total {c.totalRecipients}
      </div>
    </div>
  );
}

function CampaignsTab() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["platform-campaigns"],
    queryFn: listPlatformCampaigns,
    refetchInterval: 8000,
  });

  const act = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "start" | "pause" | "resume" | "cancel";
    }) => platformCampaignAction(id, action),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["platform-campaigns"] });
    },
    onError: () => setActionError("That action couldn't be completed."),
  });

  const columns = useMemo<Column<PlatformCampaignSummary>[]>(
    () => [
      {
        key: "name",
        header: "Campaign",
        render: (c) => (
          <div>
            <div className="font-medium" style={{ color: INK1 }}>
              {c.name}
            </div>
            <div className="text-xs" style={{ color: INK3 }}>
              {AUDIENCE_LABELS[c.audienceKind]}
            </div>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (c) => (
          <Badge variant={campaignStatusVariant(c.status)}>{c.status}</Badge>
        ),
      },
      {
        key: "progress",
        header: "Progress",
        className: "text-right tabular-nums",
        render: (c) => (
          <span className="text-xs" style={{ color: INK2 }}>
            {c.sentCount}/{c.totalRecipients - c.suppressedCount} sent
            {c.failedCount > 0 ? ` · ${c.failedCount} failed` : ""}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        className: "text-right",
        render: (c) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => setExpanded((p) => (p === c.id ? null : c.id))}
            >
              {expanded === c.id ? "Hide" : "View"}
            </Button>
            {c.status === "draft" && (
              <Button
                size="sm"
                isLoading={act.isPending}
                onClick={() => act.mutate({ id: c.id, action: "start" })}
              >
                Start
              </Button>
            )}
            {c.status === "sending" && (
              <Button
                intent="secondary"
                size="sm"
                onClick={() => act.mutate({ id: c.id, action: "pause" })}
              >
                Pause
              </Button>
            )}
            {c.status === "paused" && (
              <Button
                size="sm"
                onClick={() => act.mutate({ id: c.id, action: "resume" })}
              >
                Resume
              </Button>
            )}
            {(c.status === "draft" ||
              c.status === "sending" ||
              c.status === "paused") && (
              <Button
                intent="ghost"
                size="sm"
                onClick={() => act.mutate({ id: c.id, action: "cancel" })}
              >
                Cancel
              </Button>
            )}
          </div>
        ),
      },
    ],
    [expanded, act],
  );

  return (
    <div className="space-y-6">
      <ComposeCard
        onCreated={() =>
          void queryClient.invalidateQueries({
            queryKey: ["platform-campaigns"],
          })
        }
      />
      <Card title="Campaigns">
        {actionError && (
          <p className="text-xs mb-3" style={{ color: DANGER }}>
            {actionError}
          </p>
        )}
        {list.isPending ? (
          <Spinner label="Loading campaigns…" />
        ) : list.isError ? (
          <EmptyState title="Couldn't load campaigns." hint="Try again." />
        ) : (
          <>
            <Table<PlatformCampaignSummary>
              columns={columns}
              rows={list.data?.campaigns ?? []}
              rowKey={(c) => c.id}
              emptyState={
                <EmptyState
                  title="No campaigns yet."
                  hint="Compose one above."
                />
              }
            />
            {expanded && (
              <div
                className="mt-4 pt-4 border-t"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <CampaignDetail id={expanded} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

// ── Contacts ────────────────────────────────────────────────────────

function AddContactCard({ onChanged }: { onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      createPlatformContact({
        email: email.trim(),
        name: name.trim() || null,
        company: company.trim() || null,
        tags: tags
          .split(/[,;]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setError(null);
      setEmail("");
      setName("");
      setCompany("");
      setTags("");
      onChanged();
    },
    onError: () =>
      setError("Couldn't add that contact (duplicate or invalid email?)."),
  });

  return (
    <Card
      title="Add a contact"
      subtitle="Saved contacts are reusable across campaigns."
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ct-email">Email</Label>
            <Input
              id="ct-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="lead@example.com"
            />
          </div>
          <div>
            <Label htmlFor="ct-name">Name</Label>
            <Input
              id="ct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ct-company">Company</Label>
            <Input
              id="ct-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ct-tags">Tags (comma-separated)</Label>
            <Input
              id="ct-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="prospect, dme"
            />
          </div>
        </div>
        {error && (
          <p className="text-xs" style={{ color: DANGER }}>
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            disabled={email.trim().length === 0 || add.isPending}
            isLoading={add.isPending}
            onClick={() => add.mutate()}
          >
            Add contact
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ImportCard({ onChanged }: { onChanged: () => void }) {
  const [raw, setRaw] = useState("");
  const [tags, setTags] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const imp = useMutation({
    mutationFn: () =>
      importPlatformContacts({
        raw,
        tags: tags
          .split(/[,;]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: (res) => {
      setNotice(
        `Imported ${res.imported} new contacts (${res.skipped} already existed).`,
      );
      setRaw("");
      onChanged();
    },
    onError: () => setNotice("Import failed. Check the list and try again."),
  });

  return (
    <Card
      title="Bulk import"
      subtitle="Paste a list of addresses. Re-importing is safe (existing rows are kept)."
    >
      <div className="space-y-3">
        <textarea
          className="w-full rounded-md border px-3 py-2 text-sm font-mono"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-1))",
            color: INK1,
          }}
          rows={4}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="paste addresses, separated by commas, spaces, or new lines"
        />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="imp-tags">Tags for all imported (optional)</Label>
            <Input
              id="imp-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="prospect"
            />
          </div>
          <Button
            disabled={raw.trim().length === 0 || imp.isPending}
            isLoading={imp.isPending}
            onClick={() => imp.mutate()}
          >
            Import
          </Button>
        </div>
        {notice && (
          <p className="text-xs" style={{ color: SUCCESS }}>
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}

function ContactsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const list = useQuery({
    queryKey: ["platform-contacts", search],
    queryFn: () => listPlatformContacts({ search: search || undefined }),
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["platform-contacts"] });

  const unsub = useMutation({
    mutationFn: (id: string) =>
      updatePlatformContact(id, { unsubscribed: true }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: (id: string) => deletePlatformContact(id),
    onSuccess: invalidate,
  });

  const columns = useMemo<Column<PlatformContact>[]>(
    () => [
      {
        key: "email",
        header: "Contact",
        render: (c) => (
          <div>
            <div className="font-medium" style={{ color: INK1 }}>
              {c.email}
            </div>
            <div className="text-xs" style={{ color: INK3 }}>
              {[c.name, c.company].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        ),
      },
      {
        key: "tags",
        header: "Tags",
        render: (c) =>
          c.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {c.tags.map((t) => (
                <Badge key={t} variant="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <span style={{ color: INK3 }}>—</span>
          ),
      },
      {
        key: "status",
        header: "Status",
        render: (c) =>
          c.unsubscribed ? (
            <Badge variant="danger">unsubscribed</Badge>
          ) : (
            <Badge variant="success">subscribed</Badge>
          ),
      },
      {
        key: "actions",
        header: "",
        className: "text-right",
        render: (c) => (
          <div className="flex items-center justify-end gap-2">
            {!c.unsubscribed && (
              <Button
                intent="ghost"
                size="sm"
                isLoading={unsub.isPending}
                onClick={() => unsub.mutate(c.id)}
              >
                Unsubscribe
              </Button>
            )}
            <Button
              intent="ghost"
              size="sm"
              isLoading={del.isPending}
              onClick={() => del.mutate(c.id)}
            >
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [unsub, del],
  );

  return (
    <div className="space-y-6">
      <AddContactCard onChanged={invalidate} />
      <ImportCard onChanged={invalidate} />
      <Card title="Contacts">
        <div className="mb-3 max-w-xs">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email, name, company…"
          />
        </div>
        {list.isPending ? (
          <Spinner label="Loading contacts…" />
        ) : list.isError ? (
          <EmptyState title="Couldn't load contacts." hint="Try again." />
        ) : (
          <Table<PlatformContact>
            columns={columns}
            rows={list.data?.contacts ?? []}
            rowKey={(c) => c.id}
            emptyState={
              <EmptyState
                title="No contacts yet."
                hint="Add or import some above."
              />
            }
          />
        )}
      </Card>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────

export function PlatformOutreachPage() {
  const [tab, setTab] = useState<"campaigns" | "contacts">("campaigns");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Outreach"
        description="Email tenants, saved contacts/leads, or a pasted list from the platform's own sender. Throttled background sending with per-recipient delivery tracking."
        actions={
          <div
            className="inline-flex rounded-md overflow-hidden border"
            style={{ borderColor: "hsl(var(--line-1))" }}
            role="group"
            aria-label="Outreach view"
          >
            {(["campaigns", "contacts"] as const).map((t) => {
              const active = t === tab;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  aria-pressed={active}
                  className="px-3 py-1.5 text-xs font-medium capitalize"
                  style={{
                    color: active ? "hsl(var(--surface-1))" : INK2,
                    backgroundColor: active
                      ? "hsl(var(--penn-navy))"
                      : "transparent",
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        }
      />
      {tab === "campaigns" ? <CampaignsTab /> : <ContactsTab />}
    </div>
  );
}

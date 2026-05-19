// /admin/team — invite, list, and manage admin / customer-service
// reps. Only `admin` (super-admin) role can see and use this page;
// other roles receive 403 from the underlying API.
//
// 3-role model (Phase B collapse):
//   * admin               — super admin; full surface; only role
//                            that can use this page.
//   * supervisor          — admin tier (broad management). Legacy
//                            DB names supervisor + compliance_officer
//                            both render as "Admin" here.
//   * customer service    — CSR tier. Legacy DB names csr + fitter
//                            + fulfillment + agent all render as
//                            "Customer service rep".
//
// The DB still carries the 7-role enum for backward compat; the
// per-row permission lookup in lib/resupply-auth/src/rbac.ts
// normalizes those 7 names into the 3 effective buckets.
//
// Layout:
//   - Invite form at the top (email + role + optional display name + notes)
//   - Active members list
//   - Pending invites list (with Resend / Revoke buttons)
//   - Revoked rows (collapsed by default, kept for audit)

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inviteMember,
  listTeam,
  patchMember,
  resendInvite,
  revokeMember,
  type TeamMember,
  type TeamRole,
  type TeamStatus,
} from "@/lib/admin/admin-team-api";

// Display labels for every DB-persisted role. Legacy values map onto
// one of the 3 effective buckets so the UI shows a consistent
// "Super admin / Admin / Customer service rep" vocabulary even for
// rows persisted under one of the older role names.
const ROLE_LABEL: Record<TeamRole, string> = {
  admin: "Super admin",
  supervisor: "Admin",
  compliance_officer: "Admin",
  csr: "Customer service rep",
  fitter: "Customer service rep",
  fulfillment: "Customer service rep",
  agent: "Customer service rep",
};

/** Roles offered in the invite + edit selectors — the 3 effective
 *  buckets only. Existing rows persisted under one of the legacy
 *  names (supervisor, compliance_officer, fitter, fulfillment, agent)
 *  continue to resolve correctly through ROLE_LABEL above; new
 *  invites pick exactly one of these three. */
const ROLE_OPTIONS: TeamRole[] = ["admin", "supervisor", "csr"];

const STATUS_TONE: Record<TeamStatus, string> = {
  active: "bg-emerald-100 text-emerald-900 border-emerald-300",
  pending: "bg-amber-100 text-amber-900 border-amber-300",
  revoked: "bg-slate-200 text-slate-700 border-slate-300",
};

export function AdminTeamPage() {
  return (
    <div className="space-y-6" data-testid="admin-team-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Team
        </h1>
        <p className="text-sm text-slate-600">
          Invite admins and customer-service reps. Invitees receive a sign-up
          link by email and must accept before they can log in. Revoking removes
          access immediately.
        </p>
      </header>
      <InviteCard />
      <TeamList />
    </div>
  );
}

function TeamList() {
  const query = useQuery({
    queryKey: ["admin-team"],
    queryFn: listTeam,
  });

  const { active, pending, revoked } = useMemo(() => {
    const list = query.data?.members ?? [];
    return {
      active: list.filter((m) => m.status === "active"),
      pending: list.filter((m) => m.status === "pending"),
      revoked: list.filter((m) => m.status === "revoked"),
    };
  }, [query.data]);

  if (query.isPending)
    return <div className="text-sm text-slate-500">Loading…</div>;
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load team:{" "}
        {query.error instanceof Error ? query.error.message : "unknown error"}.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section title={`Active (${active.length})`} rows={active} />
      <Section
        title={`Pending invites (${pending.length})`}
        rows={pending}
        emptyText="No pending invitations."
      />
      {revoked.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-600">
            Revoked ({revoked.length})
          </summary>
          <div className="mt-3 space-y-2">
            {revoked.map((m) => (
              <MemberRow key={m.id} member={m} subtle />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: TeamMember[];
  emptyText?: string;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-500">
          {emptyText ?? "No members in this state."}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemberRow({
  member,
  subtle,
}: {
  member: TeamMember;
  subtle?: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-team"] });

  const resend = useMutation({
    mutationFn: () => resendInvite(member.id),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: () => revokeMember(member.id),
    onSuccess: invalidate,
  });
  const promote = useMutation({
    mutationFn: () => patchMember(member.id, { role: "admin" }),
    onSuccess: invalidate,
  });
  // Demote target: with the wider catalog, demoting an admin
  // straight to the legacy "agent" loses information about what
  // the user actually does. Demote to `csr` instead — admins can
  // then refine via the role selector below if needed.
  const demote = useMutation({
    mutationFn: () => patchMember(member.id, { role: "csr" }),
    onSuccess: invalidate,
  });
  // Inline role change for non-admin → any other non-admin role.
  // The dropdown lets a supervisor reassign a CSR to fulfillment
  // (etc.) without going through promote→demote.
  const changeRole = useMutation({
    mutationFn: (next: TeamRole) => patchMember(member.id, { role: next }),
    onSuccess: invalidate,
  });

  const errorMessage =
    resend.error instanceof Error
      ? resend.error.message
      : revoke.error instanceof Error
        ? revoke.error.message
        : promote.error instanceof Error
          ? promote.error.message
          : demote.error instanceof Error
            ? demote.error.message
            : changeRole.error instanceof Error
              ? changeRole.error.message
              : null;

  return (
    <li
      className={`rounded-lg border p-3 bg-white ${
        subtle ? "border-slate-200 opacity-80" : "border-slate-200"
      }`}
      data-testid={`team-member-${member.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[member.status]}`}
            >
              {member.status}
            </span>
            <span className="text-sm font-semibold text-slate-900">
              {member.displayName?.trim() || member.email}
            </span>
            <span className="text-xs text-slate-500">
              {ROLE_LABEL[member.role]}
            </span>
          </div>
          {member.displayName?.trim() && (
            <div className="text-xs text-slate-500 mt-0.5">{member.email}</div>
          )}
          <div className="text-[11px] text-slate-500 mt-1 space-x-2">
            <span>
              Invited {new Date(member.invitedAt).toLocaleDateString()}
            </span>
            {member.acceptedAt && (
              <span>
                · accepted {new Date(member.acceptedAt).toLocaleDateString()}
              </span>
            )}
            {member.lastLoginAt && (
              <span>
                · last login {new Date(member.lastLoginAt).toLocaleDateString()}
              </span>
            )}
            {member.revokedAt && (
              <span>
                · revoked {new Date(member.revokedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          {member.notes && (
            <p className="text-xs text-slate-600 mt-2 italic">{member.notes}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {member.status === "pending" && (
            <button
              type="button"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              data-testid={`team-member-${member.id}-resend`}
            >
              {resend.isPending ? "Resending…" : "Resend invite"}
            </button>
          )}
          {member.status === "active" && member.role !== "admin" && (
            <>
              <select
                value={member.role}
                onChange={(e) => {
                  const next = e.target.value as TeamRole;
                  if (next === member.role) return;
                  changeRole.mutate(next);
                }}
                disabled={changeRole.isPending}
                className="rounded border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-60"
                aria-label="Change role"
                data-testid={`team-member-${member.id}-role-select`}
              >
                {ROLE_OPTIONS.filter((r) => r !== "admin").map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Grant admin privileges to ${member.displayName ?? member.email}? They will be able to manage team members and access all admin features.`,
                    )
                  )
                    promote.mutate();
                }}
                disabled={promote.isPending}
                className="rounded border border-blue-300 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60"
              >
                {promote.isPending ? "Promoting…" : "Promote to admin"}
              </button>
            </>
          )}
          {member.status === "active" && member.role === "admin" && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Demote ${member.displayName ?? member.email} to the Customer service role? They will lose admin privileges.`,
                  )
                )
                  demote.mutate();
              }}
              disabled={demote.isPending}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {demote.isPending ? "Demoting…" : "Demote to CSR"}
            </button>
          )}
          {(member.status === "active" || member.status === "pending") && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Revoke access for ${member.displayName ?? member.email}? This will immediately end their session and prevent future sign-in.`,
                  )
                )
                  revoke.mutate();
              }}
              disabled={revoke.isPending}
              className="rounded border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              data-testid={`team-member-${member.id}-revoke`}
            >
              {revoke.isPending ? "Revoking…" : "Revoke access"}
            </button>
          )}
        </div>
      </div>
      {errorMessage && (
        <div className="mt-2 text-xs text-rose-700" role="alert">
          {errorMessage}
        </div>
      )}
    </li>
  );
}

function InviteCard() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  // Default to `csr` rather than the legacy `agent` for new
  // invites — the wider catalog is the future-looking choice.
  const [role, setRole] = useState<TeamRole>("csr");
  const [displayName, setDisplayName] = useState("");
  const [notes, setNotes] = useState("");
  const [initialPassword, setInitialPassword] = useState("");
  const [setPasswordMode, setSetPasswordMode] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: (body: Parameters<typeof inviteMember>[0]) =>
      inviteMember(body),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["admin-team"] });
      const invitedEmail = email;
      setEmail("");
      setDisplayName("");
      setNotes("");
      setRole("csr");
      setInitialPassword("");
      setSetPasswordMode(false);
      if (result.signInReady) {
        setSuccess(
          `${invitedEmail} is ready to sign in now. Share the password you just set with them — we did not email it.`,
        );
        setWarning(null);
      } else if (!result.emailSent) {
        setSuccess(null);
        setWarning(
          "We couldn't send the invitation email automatically — share the sign-up link with this person directly.",
        );
      } else {
        setSuccess(`Invitation email sent to ${invitedEmail}.`);
        setWarning(null);
      }
    },
  });

  const initialPasswordTooShort =
    setPasswordMode && initialPassword.length > 0 && initialPassword.length < 12;
  const submitDisabled =
    invite.isPending ||
    !email ||
    (setPasswordMode && initialPassword.length < 12);

  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-700">
          Invite a team member
        </h2>
        <span className="text-xs text-slate-500">
          They&apos;ll get a sign-up link by email — or set a password yourself
          so they can sign in right away.
        </span>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="csr@pennpaps.com"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as TeamRole)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
                {r === "admin" ? " (full privileges)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Display name (optional)
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Jordan Smith"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Notes (optional)
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Shift, team, internal note…"
          />
        </div>
      </div>
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 space-y-2">
        <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={setPasswordMode}
            onChange={(e) => {
              setSetPasswordMode(e.target.checked);
              if (!e.target.checked) setInitialPassword("");
            }}
            className="mt-0.5"
            data-testid="team-invite-set-password-toggle"
          />
          <span>
            <span className="font-semibold">Set their password for them</span>
            <span className="block text-slate-500">
              Skip the email link. The account will be ready to sign in
              immediately — you tell them the password directly.
            </span>
          </span>
        </label>
        {setPasswordMode && (
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              Initial password
            </label>
            <input
              type="password"
              value={initialPassword}
              onChange={(e) => setInitialPassword(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
              placeholder="At least 12 characters"
              autoComplete="new-password"
              spellCheck={false}
              data-testid="team-invite-initial-password"
            />
            {initialPasswordTooShort && (
              <div className="text-[11px] text-rose-700 mt-1">
                Password must be at least 12 characters.
              </div>
            )}
            <div className="text-[11px] text-slate-500 mt-1">
              They&apos;ll be able to change it after signing in.
            </div>
          </div>
        )}
      </div>
      {invite.error instanceof Error && (
        <div className="text-xs text-rose-700" role="alert">
          {invite.error.message}
        </div>
      )}
      {warning && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          {warning}
        </div>
      )}
      {success && (
        <div
          className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-3 py-2"
          data-testid="team-invite-success"
        >
          {success}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setWarning(null);
            setSuccess(null);
            invite.mutate({
              email,
              role,
              displayName: displayName || null,
              notes: notes || null,
              initialPassword:
                setPasswordMode && initialPassword.length >= 8
                  ? initialPassword
                  : null,
            });
          }}
          disabled={submitDisabled}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          data-testid="team-invite-submit"
        >
          {invite.isPending
            ? "Sending…"
            : setPasswordMode
              ? "Create account"
              : "Send invitation"}
        </button>
      </div>
    </div>
  );
}

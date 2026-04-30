import React, { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  fetchAdminUsers,
  inviteAdminUser,
  updateAdminUserRole,
  revokeAdminUser,
  revokeAdminInvitation,
  AdminApiError,
  type AdminTeamRole,
  type AdminTeamClerkUser,
  type AdminTeamEnvRow,
  type AdminTeamPendingInvitation,
  type AdminInvitationResult,
} from "@/lib/admin-api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { UserPlus, Users, ShieldCheck, Mail, Server, Trash2 } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

/**
 * Team page — Penn admins invite, promote, demote, and revoke
 * teammates from inside the console. The single most-asked-for UX
 * fix from CSR feedback ("we have to email an engineer to add a new
 * teammate"); this page makes that a self-service action.
 *
 * Three sections, in priority order for daily use:
 *
 *   1. Active teammates (Clerk-managed). Mutable inline. The signed-
 *      in admin's own row is marked "(you)" with disabled actions —
 *      the lockout-guard is also enforced server-side, but disabling
 *      the buttons is the friendlier signal.
 *
 *   2. Pending invitations. Cancel button revokes the Clerk invite
 *      (e.g. fixed a typo, want to re-send to the right address).
 *
 *   3. Env-allowlisted (read-only). Synthetic rows for emails listed
 *      in PENN_ADMIN_EMAILS / PENN_AGENT_EMAILS. Rendered with a
 *      "set in server config" muted note so admins know why those
 *      rows have no edit affordance — the env vars are the
 *      permanent recovery / bootstrap path and intentionally not
 *      editable from the UI.
 *
 * Agents (adminRole === "agent") see the page in read-only mode —
 * no Invite button, no per-row controls. The page is reachable for
 * them only by typing the URL; the sidebar nav item is admin-only
 * (admin-layout filters it).
 */
export function AdminUsers() {
  useDocumentTitle("Admin · Team");
  const queryClient = useQueryClient();

  const team = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchAdminUsers,
  });

  // Track which row is being mutated so we can disable just that
  // row's buttons (rather than disabling the whole table). Keeps the
  // UI responsive when the operator is doing bulk cleanup.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  // Transient success banner. We use this (rather than just closing
  // the dialog silently) when the invite path has a non-obvious
  // outcome — most importantly the "adopted an existing Clerk
  // account" branch, where no email was sent and the row appears in
  // Active rather than Pending.
  const [topInfo, setTopInfo] = useState<string | null>(null);

  const isAdmin = team.data?.role === "admin";

  function invalidate(): Promise<unknown> {
    return queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }

  const roleMutation = useMutation({
    mutationFn: updateAdminUserRole,
    onSuccess: invalidate,
    onError: (err) => setTopError(humanizeError(err)),
    onSettled: () => setPendingId(null),
  });

  const revokeMutation = useMutation({
    mutationFn: revokeAdminUser,
    onSuccess: invalidate,
    onError: (err) => setTopError(humanizeError(err)),
    onSettled: () => setPendingId(null),
  });

  const cancelInviteMutation = useMutation({
    mutationFn: revokeAdminInvitation,
    onSuccess: invalidate,
    onError: (err) => setTopError(humanizeError(err)),
    onSettled: () => setPendingId(null),
  });

  const clerkUsers = team.data?.clerkUsers ?? [];
  const envAllowlist = team.data?.envAllowlist ?? [];
  const pendingInvitations = team.data?.pendingInvitations ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Team</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Invite a teammate to the admin console, change someone's role, or
            remove access when a staff member leaves. Invitees get a one-time
            email link from Clerk and pick their own password.
          </p>
        </div>
        {isAdmin && (
          <InviteTeammateButton
            onInvited={(result) => {
              invalidate();
              setTopError(null);
              if ("adopted" in result) {
                setTopInfo(
                  `${result.email} already had a Clerk account, so we granted them ${result.role} access in place — no email was sent.`,
                );
              } else {
                setTopInfo(`Invitation sent to ${result.email}.`);
              }
            }}
            onError={(msg) => {
              setTopInfo(null);
              setTopError(msg);
            }}
          />
        )}
      </div>

      {topInfo && (
        <Alert data-testid="team-info">
          <AlertDescription>
            {topInfo}{" "}
            <button
              type="button"
              className="underline ml-2"
              onClick={() => setTopInfo(null)}
              data-testid="dismiss-team-info"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {topError && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            {topError}{" "}
            <button
              type="button"
              className="underline ml-2"
              onClick={() => setTopError(null)}
              data-testid="dismiss-team-error"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {team.error && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not load the team list. {humanizeError(team.error)}
          </AlertDescription>
        </Alert>
      )}

      {/* ---------- Active teammates ---------- */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Active teammates
          </CardTitle>
          <CardDescription>
            People who can sign in to this admin console right now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {team.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : clerkUsers.length === 0 ? (
            <EmptyHint
              icon={<Users className="w-5 h-5" />}
              title="No invited teammates yet"
              body={
                isAdmin
                  ? "Click Invite teammate to add the first one."
                  : "Ask an admin to invite teammates."
              }
            />
          ) : (
            <ul className="divide-y divide-border/40" data-testid="active-teammates">
              {clerkUsers.map((u) => (
                <ActiveTeammateRow
                  key={u.id}
                  user={u}
                  isAdmin={isAdmin}
                  pending={pendingId === u.id}
                  onChangeRole={(role) => {
                    setPendingId(u.id);
                    setTopError(null);
                    roleMutation.mutate({ userId: u.id, role });
                  }}
                  onRevoke={() => {
                    if (
                      !confirm(
                        `Remove ${u.email}? They will lose access to the admin console immediately. Their Clerk account stays so they can still use the patient site.`,
                      )
                    )
                      return;
                    setPendingId(u.id);
                    setTopError(null);
                    revokeMutation.mutate({ userId: u.id });
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------- Pending invitations ---------- */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5" />
            Pending invitations
          </CardTitle>
          <CardDescription>
            Invites that haven't been accepted yet. Cancel one if you sent it
            to the wrong address.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {team.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : pendingInvitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <ul className="divide-y divide-border/40" data-testid="pending-invitations">
              {pendingInvitations.map((inv) => (
                <PendingInviteRow
                  key={inv.id}
                  invite={inv}
                  isAdmin={isAdmin}
                  pending={pendingId === inv.id}
                  onCancel={() => {
                    if (!confirm(`Cancel the invitation for ${inv.email}?`))
                      return;
                    setPendingId(inv.id);
                    setTopError(null);
                    cancelInviteMutation.mutate({ invitationId: inv.id });
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------- Env-allowlisted ---------- */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" />
            Set in server config
          </CardTitle>
          <CardDescription>
            These emails are hard-coded in the server's environment as a
            recovery path. Only an engineer with shell access can change
            them. Listed here so you know who has standing access without
            relying on this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {team.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : envAllowlist.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No environment allowlist is set on this server.
            </p>
          ) : (
            <ul className="divide-y divide-border/40" data-testid="env-allowlist">
              {envAllowlist.map((row, idx) => (
                <EnvAllowlistRow key={`${row.email}-${idx}`} row={row} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Row components ----------

function ActiveTeammateRow({
  user,
  isAdmin,
  pending,
  onChangeRole,
  onRevoke,
}: {
  user: AdminTeamClerkUser;
  isAdmin: boolean;
  pending: boolean;
  onChangeRole: (role: AdminTeamRole) => void;
  onRevoke: () => void;
}) {
  // Env override means the email also appears in the server's
  // PENN_ADMIN_EMAILS / PENN_AGENT_EMAILS allowlist. Env wins over
  // Clerk metadata in requireAdmin, so any role-change or remove
  // action against this row would be a no-op for effective access.
  // Disable the controls and tell the operator who actually owns it.
  const isEnvOverride = user.envOverride !== null;
  const showActions = isAdmin && !user.isSelf && !isEnvOverride;
  return (
    <li
      className="py-3 flex flex-wrap items-center gap-3"
      data-testid={`teammate-${user.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate" title={user.email}>
            {user.name ?? user.email}
          </span>
          {user.isSelf && (
            <span className="text-xs text-muted-foreground">(you)</span>
          )}
          <RoleBadge role={user.role} />
          {isEnvOverride && (
            <span
              className="text-[10px] uppercase tracking-wide rounded border border-amber-400/40 text-amber-300/90 px-1.5 py-0.5"
              title={`Also set in server config as ${user.envOverride}. Effective access is controlled by the env allowlist.`}
              data-testid={`env-override-${user.id}`}
            >
              Server config
            </span>
          )}
        </div>
        {user.name && (
          <div className="text-xs text-muted-foreground truncate">
            {user.email}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {user.lastSignInAt
            ? `Last signed in ${formatTimeAgo(user.lastSignInAt)}`
            : "Hasn't signed in yet"}
        </div>
      </div>
      {showActions ? (
        <div className="flex items-center gap-2">
          <Select
            value={user.role}
            onValueChange={(v) => {
              if (v === user.role) return;
              if (v === "admin" || v === "agent") onChangeRole(v);
            }}
            disabled={pending}
          >
            <SelectTrigger
              className="h-8 w-[110px]"
              data-testid={`role-select-${user.id}`}
              aria-label={`Role for ${user.email}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={onRevoke}
            disabled={pending}
            data-testid={`revoke-${user.id}`}
            aria-label={`Remove ${user.email} from the team`}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            {pending ? "Removing…" : "Remove"}
          </Button>
        </div>
      ) : isAdmin && user.isSelf ? (
        <span className="text-xs text-muted-foreground italic">
          Ask another admin to change your role
        </span>
      ) : isAdmin && isEnvOverride ? (
        <span className="text-xs text-muted-foreground italic max-w-[220px] text-right">
          Set in server config — ask an engineer to change.
        </span>
      ) : null}
    </li>
  );
}

function PendingInviteRow({
  invite,
  isAdmin,
  pending,
  onCancel,
}: {
  invite: AdminTeamPendingInvitation;
  isAdmin: boolean;
  pending: boolean;
  onCancel: () => void;
}) {
  return (
    <li
      className="py-3 flex flex-wrap items-center gap-3"
      data-testid={`invite-${invite.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{invite.email}</span>
          <RoleBadge role={invite.role} />
        </div>
        <div className="text-xs text-muted-foreground">
          Invited {formatTimeAgo(invite.createdAt)}
        </div>
      </div>
      {isAdmin && (
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={pending}
          data-testid={`cancel-invite-${invite.id}`}
          aria-label={`Cancel invitation for ${invite.email}`}
        >
          {pending ? "Cancelling…" : "Cancel invite"}
        </Button>
      )}
    </li>
  );
}

function EnvAllowlistRow({ row }: { row: AdminTeamEnvRow }) {
  return (
    <li className="py-3 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium truncate">{row.email}</span>
          <RoleBadge role={row.role} />
        </div>
        <div className="text-xs text-muted-foreground">
          Set in server config — ask an engineer to remove.
        </div>
      </div>
    </li>
  );
}

// ---------- Invite dialog ----------

function InviteTeammateButton({
  onInvited,
  onError,
}: {
  onInvited: (result: AdminInvitationResult) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminTeamRole>("agent");

  const invite = useMutation({
    mutationFn: inviteAdminUser,
    onSuccess: (result) => {
      onInvited(result);
      setOpen(false);
      setEmail("");
      setRole("agent");
    },
    onError: (err) => onError(humanizeError(err)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!invite.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="button-invite-teammate">
          <UserPlus className="w-4 h-4 mr-2" />
          Invite teammate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            They'll get an email from Clerk with a one-time link to create
            their account. The link points back to this admin console.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = email.trim().toLowerCase();
            if (!trimmed) return;
            invite.mutate({ email: trimmed, role });
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              required
              autoFocus
              autoComplete="off"
              placeholder="teammate@pennpaps.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={invite.isPending}
              data-testid="invite-email"
            />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <RadioGroup
              value={role}
              onValueChange={(v) => {
                if (v === "admin" || v === "agent") setRole(v);
              }}
              className="space-y-2"
            >
              <RoleRadioOption
                value="agent"
                label="Agent"
                hint="Can view orders, send reminders, and see the team — but cannot change roles or remove teammates."
              />
              <RoleRadioOption
                value="admin"
                label="Admin"
                hint="Full access. Can invite, change roles, and remove other teammates."
              />
            </RadioGroup>
          </div>
          {invite.error && (
            <Alert variant="destructive">
              <AlertDescription>{humanizeError(invite.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={invite.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={invite.isPending || !email.trim()}
              data-testid="submit-invite"
            >
              {invite.isPending ? "Sending..." : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleRadioOption({
  value,
  label,
  hint,
}: {
  value: AdminTeamRole;
  label: string;
  hint: string;
}) {
  const id = `role-${value}`;
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 rounded-lg border border-border/60 p-3 cursor-pointer hover:bg-muted/40"
    >
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
    </label>
  );
}

// ---------- shared bits ----------

function RoleBadge({ role }: { role: AdminTeamRole }) {
  return (
    <Badge
      variant={role === "admin" ? "default" : "secondary"}
      className="uppercase tracking-wide text-[10px]"
    >
      {role}
    </Badge>
  );
}

function EmptyHint({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 text-sm text-muted-foreground">
      <div className="mt-0.5">{icon}</div>
      <div>
        <div className="font-medium text-foreground">{title}</div>
        <div>{body}</div>
      </div>
    </div>
  );
}

/**
 * Translate a thrown error into something a CSR can act on. Falls
 * back to a generic message rather than leaking a stack trace into
 * the alert banner.
 */
function humanizeError(err: unknown): string {
  if (err instanceof AdminApiError && err.payload?.error) {
    return err.payload.error;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Please try again.";
}

/**
 * Compact "X minutes ago" / "Yesterday" / date formatter. Uses
 * Intl.RelativeTimeFormat (broadly supported) for the recent window
 * and falls back to a date for older values. Accepts the millisecond
 * timestamps Clerk hands us.
 */
function formatTimeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const diffMs = Date.now() - ms;
  const sec = Math.round(diffMs / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(sec) < 60) return rtf.format(-sec, "second");
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return rtf.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(-hr, "hour");
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 7) return rtf.format(-day, "day");
  return new Date(ms).toLocaleDateString();
}

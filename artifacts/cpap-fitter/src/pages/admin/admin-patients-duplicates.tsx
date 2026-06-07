// /admin/patients/duplicates — likely-duplicate patient records for CSR
// review + merge (CSR #C1).
//
// DME intake from faxes/referrals routinely creates a second record for
// an existing patient (first-name typo, maiden vs married last name,
// re-keyed phone). The only uniqueness on the roster is pacware_id, so
// CSRs had no way to find these. This page lists the collisions grouped
// by the shared key and lets a CSR pick the survivor (primary) and fold a
// duplicate into it — the merge repoints every FK atomically server-side
// and closes (does not delete) the duplicate.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  listPatientDuplicates,
  mergePatients,
  type DuplicateGroup,
  type DuplicateMatchReason,
  type DuplicateMember,
} from "@/lib/admin/patients-duplicates-api";

const REASON_LABEL: Record<DuplicateMatchReason, string> = {
  dob_lastname: "Same last name + date of birth",
  phone: "Same phone number",
  email: "Same email address",
};

const memberLabel = (m: DuplicateMember): string =>
  [m.firstName, m.lastName].filter(Boolean).join(" ") ||
  m.pacwareId ||
  m.patientId;

const DUPLICATES_QUERY_KEY = ["admin", "patients", "duplicates"] as const;

export function AdminPatientsDuplicatesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();

  const mergeMut = useMutation({
    mutationFn: (v: { primaryId: string; duplicateId: string }) =>
      mergePatients(v.primaryId, v.duplicateId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DUPLICATES_QUERY_KEY });
      toast({ title: "Records merged" });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Merge failed",
        description:
          "These records may each have conflicting one-per-patient data (e.g. a coverage row). Reconcile by hand, then retry.",
      });
    },
  });

  async function handleMerge(
    primary: DuplicateMember,
    duplicate: DuplicateMember,
  ): Promise<void> {
    const ok = await confirm({
      title: "Merge patient records?",
      description: `Fold ${memberLabel(duplicate)} into ${memberLabel(
        primary,
      )}. All orders, claims, conversations, and history move to ${memberLabel(
        primary,
      )}; the duplicate is closed. This is hard to undo.`,
      confirmLabel: "Merge",
      destructive: true,
    });
    if (!ok) return;
    mergeMut.mutate({
      primaryId: primary.patientId,
      duplicateId: duplicate.patientId,
    });
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CopyCheck className="h-6 w-6" />
          Possible duplicate patients
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Records that share a strong identity signal (same last name + date of
          birth, phone, or email) but are stored as separate patients. Pick the
          record to keep, then merge the others into it. Closed patients are
          excluded.
        </p>
      </header>

      <DuplicateGroupsCard onMerge={handleMerge} merging={mergeMut.isPending} />
      {ConfirmDialogEl}
    </div>
  );
}

function DuplicateGroupsCard({
  onMerge,
  merging,
}: {
  onMerge: (primary: DuplicateMember, duplicate: DuplicateMember) => void;
  merging: boolean;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: DUPLICATES_QUERY_KEY,
    queryFn: listPatientDuplicates,
    staleTime: 60_000,
  });

  if (isPending) {
    return (
      <Card title="Duplicate groups">
        <Spinner />
      </Card>
    );
  }
  if (isError) {
    return (
      <Card title="Duplicate groups">
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </Card>
    );
  }
  if (data.groups.length === 0) {
    return (
      <Card title="Duplicate groups">
        <p className="text-sm text-muted-foreground py-2">
          No likely duplicates found. 🎉
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={`${data.groupCount} group${data.groupCount === 1 ? "" : "s"} to review`}
    >
      <div className="space-y-5">
        {data.groups.map((g) => (
          <DuplicateGroupBlock
            key={`${g.matchReason}:${g.groupKey}`}
            group={g}
            onMerge={onMerge}
            merging={merging}
          />
        ))}
      </div>
    </Card>
  );
}

function DuplicateGroupBlock({
  group,
  onMerge,
  merging,
}: {
  group: DuplicateGroup;
  onMerge: (primary: DuplicateMember, duplicate: DuplicateMember) => void;
  merging: boolean;
}) {
  // Default the survivor to the oldest record (the RPC returns members
  // oldest-first), which is usually the established chart.
  const [primaryId, setPrimaryId] = useState(group.members[0]?.patientId ?? "");
  const primary =
    group.members.find((m) => m.patientId === primaryId) ?? group.members[0]!;

  return (
    <div className="rounded-lg border">
      <div className="px-3 py-2 text-xs font-medium rounded-t-lg bg-muted text-muted-foreground">
        {REASON_LABEL[group.matchReason]} · {group.memberCount} records
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Keep</th>
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="px-3 py-1.5 font-medium">DOB</th>
            <th className="px-3 py-1.5 font-medium">Pacware ID</th>
            <th className="px-3 py-1.5 font-medium">Reachable</th>
            <th className="px-3 py-1.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => {
            const isPrimary = m.patientId === primary.patientId;
            return (
              <tr key={m.patientId} className="border-t">
                <td className="px-3 py-1.5">
                  <input
                    type="radio"
                    name={`primary-${group.matchReason}-${group.groupKey}`}
                    checked={isPrimary}
                    onChange={() => setPrimaryId(m.patientId)}
                    aria-label={`Keep ${memberLabel(m)}`}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <a
                    className="underline underline-offset-2"
                    href={`/admin/patients/${m.patientId}`}
                  >
                    {memberLabel(m)}
                  </a>
                </td>
                <td className="px-3 py-1.5">{m.dateOfBirth ?? "—"}</td>
                <td className="px-3 py-1.5">{m.pacwareId ?? "—"}</td>
                <td className="px-3 py-1.5">
                  {[m.hasPhone ? "phone" : null, m.hasEmail ? "email" : null]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {isPrimary ? (
                    <span className="text-xs text-muted-foreground">
                      Keeping
                    </span>
                  ) : (
                    <Button
                      intent="ghost"
                      size="sm"
                      disabled={merging}
                      onClick={() => onMerge(primary, m)}
                    >
                      Merge into kept
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

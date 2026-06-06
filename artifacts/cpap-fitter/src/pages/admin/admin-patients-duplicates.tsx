// /admin/patients/duplicates — likely-duplicate patient records for CSR
// review (CSR #C1, detection half).
//
// DME intake from faxes/referrals routinely creates a second record for
// an existing patient (first-name typo, maiden vs married last name,
// re-keyed phone). The only uniqueness on the roster is pacware_id, so
// CSRs had no way to find these. This page lists the collisions grouped
// by the shared key. Detection only — merging is done by hand on the
// patient detail pages (the destructive auto-merge is a future change).

import { useQuery } from "@tanstack/react-query";
import { CopyCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  listPatientDuplicates,
  type DuplicateGroup,
  type DuplicateMatchReason,
} from "@/lib/admin/patients-duplicates-api";

const REASON_LABEL: Record<DuplicateMatchReason, string> = {
  dob_lastname: "Same last name + date of birth",
  phone: "Same phone number",
  email: "Same email address",
};

export function AdminPatientsDuplicatesPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CopyCheck className="h-6 w-6" />
          Possible duplicate patients
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Records that share a strong identity signal (same last name + date of
          birth, phone, or email) but are stored as separate patients. Review
          each group and reconcile by hand on the patient pages. Closed patients
          are excluded.
        </p>
      </header>

      <DuplicateGroupsCard />
    </div>
  );
}

function DuplicateGroupsCard() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "patients", "duplicates"] as const,
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
          <DuplicateGroupBlock key={`${g.matchReason}:${g.groupKey}`} group={g} />
        ))}
      </div>
    </Card>
  );
}

function DuplicateGroupBlock({ group }: { group: DuplicateGroup }) {
  return (
    <div className="rounded-lg border">
      <div className="px-3 py-2 text-xs font-medium rounded-t-lg bg-muted text-muted-foreground">
        {REASON_LABEL[group.matchReason]} · {group.memberCount} records
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="px-3 py-1.5 font-medium">DOB</th>
            <th className="px-3 py-1.5 font-medium">Pacware ID</th>
            <th className="px-3 py-1.5 font-medium">Reachable</th>
            <th className="px-3 py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => (
            <tr key={m.patientId} className="border-t">
              <td className="px-3 py-1.5">
                <a
                  className="underline underline-offset-2"
                  href={`/admin/patients/${m.patientId}`}
                >
                  {[m.firstName, m.lastName].filter(Boolean).join(" ") || "—"}
                </a>
              </td>
              <td className="px-3 py-1.5">{m.dateOfBirth ?? "—"}</td>
              <td className="px-3 py-1.5">{m.pacwareId ?? "—"}</td>
              <td className="px-3 py-1.5">
                {[m.hasPhone ? "phone" : null, m.hasEmail ? "email" : null]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </td>
              <td className="px-3 py-1.5 capitalize">{m.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

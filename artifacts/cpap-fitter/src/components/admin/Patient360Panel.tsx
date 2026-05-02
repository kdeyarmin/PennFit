// Patient 360 panel — compact "everything I need to handle this
// conversation" sidebar rendered next to the conversation thread.
//
// Why a component-level fetch instead of folding the data into
// /conversations/:id: the conversation detail endpoint deliberately
// stays narrow (decrypted message bodies + thread metadata) for the
// PHI minimization rule. Pulling the patient detail separately keeps
// each cache key isolated — a patient-data refresh doesn't invalidate
// the message thread query and vice versa.
//
// What's surfaced: status, contact channels on file, channel
// preference, latest 3 prescriptions with active/expired/revoked
// state, latest 3 episodes with status pills, latest 3 fulfillments,
// and a deep link to the full patient page.

import { Link } from "wouter";
import { useGetPatient } from "@workspace/resupply-api-client";
import { Card } from "./Card";
import { Badge, humanizeStatus, patientStatusVariant } from "./Badge";
import { Spinner } from "./Spinner";
import { fullName, formatDate } from "@/lib/admin/format";

const DISPLAY_LIMIT = 3;

export function Patient360Panel({ patientId }: { patientId: string }) {
  const { data, isPending, isError, error } = useGetPatient(patientId);

  if (isError) {
    return (
      <Card title="Patient context">
        <p className="text-sm text-rose-700">
          Couldn&apos;t load patient context:{" "}
          {error instanceof Error ? error.message : "unknown error"}.
        </p>
      </Card>
    );
  }

  if (isPending || !data) {
    return (
      <Card title="Patient context">
        <Spinner label="Loading patient…" />
      </Card>
    );
  }

  const recentPrescriptions = (data.prescriptions ?? []).slice(0, DISPLAY_LIMIT);
  const recentEpisodes = (data.episodes ?? []).slice(0, DISPLAY_LIMIT);
  const recentFulfillments = (data.fulfillments ?? []).slice(0, DISPLAY_LIMIT);

  return (
    <Card
      title="Patient context"
      subtitle={
        <span className="text-xs">
          <Link
            href={`/patients/${patientId}`}
            className="underline decoration-dotted"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Open full patient view →
          </Link>
        </span>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
              {fullName(data.firstName, data.lastName)}
            </div>
            <div className="text-xs text-slate-500">
              PACware #{data.pacwareId} · since {formatDate(data.createdAt)}
            </div>
          </div>
          <Badge variant={patientStatusVariant(data.status)}>
            {humanizeStatus(data.status)}
          </Badge>
        </div>

        <ContactsRow
          hasPhone={data.hasPhone}
          hasEmail={data.hasEmail}
          channelPref={data.channelPreference ?? null}
        />

        {recentPrescriptions.length > 0 && (
          <Section title="Recent prescriptions">
            <ul className="space-y-1.5">
              {recentPrescriptions.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-xs text-slate-700 truncate">
                    {p.itemSku}{" "}
                    <span className="text-slate-400">
                      · valid from {formatDate(p.validFrom)}
                    </span>
                  </span>
                  <Badge variant={prescriptionVariant(p.status)}>
                    {humanizeStatus(p.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {recentEpisodes.length > 0 && (
          <Section title="Recent episodes">
            <ul className="space-y-1.5">
              {recentEpisodes.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-xs text-slate-700 truncate">
                    {e.itemSku ?? "supply"}{" "}
                    <span className="text-slate-400">
                      · due {formatDate(e.dueAt)}
                    </span>
                  </span>
                  <Badge variant={episodeVariant(e.status)}>
                    {humanizeStatus(e.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {recentFulfillments.length > 0 && (
          <Section title="Recent fulfillments">
            <ul className="space-y-1.5">
              {recentFulfillments.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-xs text-slate-700 truncate">
                    {f.itemSku ?? "supply"}{" "}
                    <span className="text-slate-400">
                      · qty {f.quantity}
                    </span>
                  </span>
                  <Badge variant="neutral">
                    {humanizeStatus(f.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {recentPrescriptions.length === 0 &&
          recentEpisodes.length === 0 &&
          recentFulfillments.length === 0 && (
            <p className="text-xs text-slate-500">
              No recent activity on file.
            </p>
          )}
      </div>
    </Card>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function ContactsRow({
  hasPhone,
  hasEmail,
  channelPref,
}: {
  hasPhone: boolean;
  hasEmail: boolean;
  channelPref: string | null;
}) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Channels on file
      </p>
      <div className="flex gap-2 flex-wrap">
        {hasPhone && <Badge variant="info">SMS / Voice</Badge>}
        {hasEmail && <Badge variant="neutral">Email</Badge>}
        {!hasPhone && !hasEmail && (
          <Badge variant="muted">No contact methods</Badge>
        )}
        {channelPref && (
          <Badge variant="muted">
            Prefers {humanizeStatus(channelPref)}
          </Badge>
        )}
      </div>
    </div>
  );
}

function prescriptionVariant(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "expired") return "warning";
  if (status === "revoked") return "danger";
  return "neutral";
}

function episodeVariant(
  status: string,
): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "fulfilled") return "success";
  if (status === "overdue") return "danger";
  if (status === "awaiting") return "warning";
  if (status === "pending") return "info";
  return "neutral";
}

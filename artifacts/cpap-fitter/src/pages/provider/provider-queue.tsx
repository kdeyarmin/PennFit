// Provider document queue — the list of items awaiting (or recently
// acted on by) the signed-in provider.

import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { FileSignature, ChevronRight, Inbox } from "lucide-react";

import { getProviderQueue } from "@/lib/provider/provider-api";
import {
  Card,
  ProviderShell,
  Spinner,
  StatusBadge,
  ErrorNote,
  formatDateTime,
} from "./provider-ui";

type Tab = "pending" | "signed" | "all";

export function ProviderQueue({
  providerName,
}: {
  providerName?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  const query = useQuery({
    queryKey: ["provider", "queue", tab],
    queryFn: () => getProviderQueue(tab),
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: "pending", label: "Awaiting signature" },
    { key: "signed", label: "Signed" },
    { key: "all", label: "All" },
  ];

  return (
    <ProviderShell providerName={providerName}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Documents to sign</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review each document and apply your electronic signature.
        </p>
      </div>

      <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-blue-700 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading your documents…" />
      ) : query.isError ? (
        <ErrorNote>
          We couldn't load your documents. Please refresh and try again.
        </ErrorNote>
      ) : query.data.requests.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Inbox className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-sm text-slate-500">
            {tab === "pending"
              ? "You're all caught up — nothing is awaiting your signature."
              : "Nothing here yet."}
          </p>
        </Card>
      ) : (
        <Card className="divide-y divide-slate-100">
          {query.data.requests.map((r) => {
            const inner = (
              <div className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                  <FileSignature className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">
                    {r.title}
                  </p>
                  <p className="truncate text-sm text-slate-500">
                    {r.subjectLabel}
                    {r.patientName ? ` · ${r.patientName}` : ""} ·{" "}
                    {formatDateTime(r.createdAt)}
                  </p>
                </div>
                <StatusBadge status={r.status} />
                {r.status === "pending" ? (
                  <ChevronRight
                    className="h-5 w-5 shrink-0 text-slate-400"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
            return r.status === "pending" ? (
              <Link
                key={r.id}
                href={`/provider/sign/${r.id}`}
                className="block hover:bg-slate-50"
              >
                {inner}
              </Link>
            ) : (
              <div key={r.id}>{inner}</div>
            );
          })}
        </Card>
      )}
    </ProviderShell>
  );
}

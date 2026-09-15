import { useId, useState, type ReactNode } from "react";
import { Link } from "wouter";

export const ownerMoney = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const ownerCount = (value: number) => value.toLocaleString("en-US");

export function OwnerSection({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  id?: string;
}) {
  const heading = useId();
  return (
    <section
      id={id}
      aria-labelledby={heading}
      className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6"
    >
      <h2
        id={heading}
        className="text-lg font-semibold tracking-tight text-slate-950"
      >
        {title}
      </h2>
      {description && (
        <p className="mt-1 max-w-4xl text-sm leading-relaxed text-slate-600">
          {description}
        </p>
      )}
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

export function OwnerMetric({
  label,
  value,
  previous,
  money,
  hint,
}: {
  label: string;
  value: number;
  previous?: number;
  money?: boolean;
  hint?: string;
}) {
  const format = money ? ownerMoney : ownerCount;
  const delta = previous === undefined ? null : value - previous;
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <p className="mt-2 break-words text-2xl font-semibold tracking-tight text-slate-950 tabular-nums">
        {format(value)}
      </p>
      {previous !== undefined && (
        <p className="mt-2 text-xs text-slate-600">
          Previous {format(previous)}{" "}
          <span className="whitespace-nowrap">
            ({delta! > 0 ? "+" : ""}
            {format(delta!)})
          </span>
        </p>
      )}
      {hint && (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{hint}</p>
      )}
    </div>
  );
}

export function OwnerTable({
  label,
  columns,
  rows,
  empty = "No activity in this period.",
}: {
  label: string;
  columns: string[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
  empty?: string;
}) {
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <div
      className="max-w-full overflow-x-auto rounded-lg border border-slate-200"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="whitespace-nowrap px-4 py-3 font-semibold"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className="px-4 py-3 align-top text-slate-700 tabular-nums"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OwnerTrend({
  title,
  rows,
  series,
  money = false,
}: {
  title: string;
  rows: Array<{ label: string; first: number; second: number }>;
  series: [string, string];
  money?: boolean;
}) {
  const [table, setTable] = useState(false);
  const format = money ? ownerMoney : ownerCount;
  const values = rows.flatMap((r) => [r.first, r.second]);
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values);
  const x = (i: number) => 75 + (i / Math.max(1, rows.length - 1)) * 680;
  const y = (value: number) => 205 - ((value - min) / (max - min)) * 175;
  const path = (key: "first" | "second") =>
    rows.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r[key])}`).join(" ");
  const compact = (v: number) =>
    new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
      ...(money ? { style: "currency", currency: "USD" } : {}),
    }).format(money ? v / 100 : v);
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-xs text-slate-600">
          <span>
            <span
              className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-800"
              aria-hidden
            />
            {series[0]}
          </span>
          <span>
            <span
              className="mr-1 inline-block h-2 w-2 rounded-full bg-teal-600"
              aria-hidden
            />
            {series[1]}
          </span>
        </div>
        <button
          type="button"
          aria-pressed={table}
          onClick={() => setTable(!table)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium focus-visible:ring-2"
        >
          {table ? "Show chart" : "Show data table"}
        </button>
      </div>
      {table ? (
        <OwnerTable
          label={`${title} data`}
          columns={["Date", ...series]}
          rows={rows.map((r) => ({
            key: r.label,
            cells: [r.label, format(r.first), format(r.second)],
          }))}
        />
      ) : rows.length ? (
        <svg
          viewBox="0 0 800 255"
          className="w-full"
          role="img"
          aria-label={`${title}. ${rows.length} daily observations. Use Show data table for exact values.`}
        >
          <title>{title}</title>
          {[min, (min + max) / 2, max].map((value, i) => (
            <g key={i}>
              <line
                x1="75"
                x2="755"
                y1={y(value)}
                y2={y(value)}
                stroke="#e2e8f0"
              />
              <text
                x="65"
                y={y(value) + 4}
                textAnchor="end"
                fontSize="12"
                fill="#475569"
              >
                {compact(value)}
              </text>
            </g>
          ))}
          <path
            d={path("first")}
            fill="none"
            stroke="#1e293b"
            strokeWidth="3"
          />
          <path
            d={path("second")}
            fill="none"
            stroke="#0d9488"
            strokeWidth="3"
            strokeDasharray="6 4"
          />
          <circle
            cx={x(rows.length - 1)}
            cy={y(rows[rows.length - 1].first)}
            r="4"
            fill="#1e293b"
          />
          <circle
            cx={x(rows.length - 1)}
            cy={y(rows[rows.length - 1].second)}
            r="4"
            fill="#0d9488"
          />
          {[
            ...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1]),
          ].map((i) => (
            <text
              key={i}
              x={x(i)}
              y="237"
              textAnchor={
                i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"
              }
              fontSize="12"
              fill="#475569"
            >
              {rows[i].label}
            </text>
          ))}
        </svg>
      ) : (
        <p className="text-sm text-slate-500">
          No trend activity in this period.
        </p>
      )}
    </div>
  );
}

export function OwnerDrillLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex rounded py-1 text-sm font-medium text-teal-800 underline underline-offset-4 focus-visible:ring-2"
    >
      {children}
      <span className="ml-1" aria-hidden>
        →
      </span>
    </Link>
  );
}

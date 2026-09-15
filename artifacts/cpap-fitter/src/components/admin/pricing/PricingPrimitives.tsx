import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, ShieldAlert } from "lucide-react";

export const pricingControl =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:bg-slate-100 disabled:text-slate-500";

export function PricingField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const input = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? children
    : null;
  const inputId = input?.props.id ?? id;
  return (
    <div className="block min-w-0 text-sm font-medium text-slate-800">
      <label htmlFor={inputId} className="mb-1.5 block">
        {label}
      </label>
      {input
        ? cloneElement(input, {
            id: inputId,
            "aria-describedby":
              [input.props["aria-describedby"], hint ? `${id}-hint` : null]
                .filter(Boolean)
                .join(" ") || undefined,
          })
        : children}
      {hint && (
        <span
          id={`${id}-hint`}
          className="mt-1 block text-xs font-normal text-slate-500"
        >
          {hint}
        </span>
      )}
    </div>
  );
}

export function PricingSection({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950">{title}</h2>
          {description && (
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

const STATUS = {
  meets_target: {
    label: "Meets target",
    icon: CheckCircle2,
    style: "border-emerald-200 bg-emerald-50 text-emerald-900",
  },
  approval_needed: {
    label: "Approval needed",
    icon: Clock3,
    style: "border-amber-200 bg-amber-50 text-amber-900",
  },
  blocked: {
    label: "Blocked",
    icon: ShieldAlert,
    style: "border-red-200 bg-red-50 text-red-900",
  },
  cost_information_needed: {
    label: "Cost information needed",
    icon: AlertCircle,
    style: "border-amber-200 bg-amber-50 text-amber-900",
  },
} as const;

export function PricingStatus({ state }: { state: string }) {
  const status = STATUS[state as keyof typeof STATUS];
  if (!status)
    return (
      <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
        {state.replaceAll("_", " ")}
      </span>
    );
  const Icon = status.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${status.style}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {status.label}
    </span>
  );
}

export function PricingMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-950">
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

export function PricingNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      {children}
    </p>
  );
}

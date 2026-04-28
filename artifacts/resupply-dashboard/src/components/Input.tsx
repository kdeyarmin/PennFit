import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";

// Brand-aligned form controls. Kept minimal — these are filter
// controls, not a full forms library. Labels are required for a11y;
// the filter strip on each list page wires every control with one.

export function Label({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs font-semibold mb-1"
      style={{ color: "#374151" }}
    >
      {children}
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className = "", ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={`block w-full rounded border px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 ${className}`}
      style={{
        borderColor: "#d1d5db",
        color: "#0a1f44",
      }}
    />
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<{ value: string; label: string }>;
  emptyOptionLabel?: string;
}

export function Select({
  className = "",
  options,
  emptyOptionLabel,
  ...rest
}: SelectProps) {
  return (
    <select
      {...rest}
      className={`block w-full rounded border px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 ${className}`}
      style={{
        borderColor: "#d1d5db",
        color: "#0a1f44",
      }}
    >
      {emptyOptionLabel !== undefined && (
        <option value="">{emptyOptionLabel}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

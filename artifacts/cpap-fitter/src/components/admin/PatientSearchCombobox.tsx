// Shared patient picker — search any patient by name or PacWare id and
// select one. Extracted from the /admin/billing/verify pattern so the many
// admin surfaces that need "pick a patient" stop asking operators to paste a
// raw patient UUID (a value no human knows).
//
// Controlled: `value` is the selected PatientListItem (or null) and
// `onChange` fires with the chosen patient — so callers get `patient.id`
// without a copy-paste — or null when the selection is cleared.
//
// Implements the same combobox/listbox ARIA contract as GlobalLookup —
// Arrow Up/Down move the active option, Enter selects, Escape closes — with
// aria-activedescendant tracking the highlight. Selecting a hit by mouse
// also works.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  listPatients,
  type ListPatientsStatus,
  type PatientListItem,
} from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";

export interface PatientSearchComboboxProps {
  /** The selected patient, or null when nothing is picked. Controlled. */
  value: PatientListItem | null;
  /** Fires with the chosen patient, or null when the selection is cleared. */
  onChange: (patient: PatientListItem | null) => void;
  /** Restrict the search to one patient status (e.g. "active"). */
  status?: ListPatientsStatus;
  /** Placeholder for the search input. */
  placeholder?: string;
  /** id for the input, so a caller's <label htmlFor> can target it. */
  id?: string;
  /** Accessible name when there is no associated <label>. */
  "aria-label"?: string;
  /** Focus the search box on mount (when nothing is selected yet). */
  autoFocus?: boolean;
  /** Disable the control. */
  disabled?: boolean;
  /** Prefix for the data-testid hooks (input, options, selection). */
  testId?: string;
}

const MIN_CHARS = 2;

export function PatientSearchCombobox({
  value,
  onChange,
  status,
  placeholder = "Search by name or PacWare ID",
  id,
  "aria-label": ariaLabel,
  autoFocus,
  disabled,
  testId = "patient-search",
}: PatientSearchComboboxProps) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  // Index of the keyboard-highlighted option, or -1 when none is active.
  const [active, setActive] = useState(-1);

  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [search]);

  const matches = useQuery({
    queryKey: ["patient-search-combobox", status ?? null, debounced],
    queryFn: () =>
      listPatients({
        search: debounced,
        limit: 10,
        ...(status ? { status } : {}),
      }),
    enabled: !value && debounced.length >= MIN_CHARS,
    staleTime: 30_000,
  });

  const items = useMemo(() => matches.data?.items ?? [], [matches.data]);
  const showList = open && !value && debounced.length >= MIN_CHARS;

  // Reset the highlight whenever the result set changes.
  useEffect(() => setActive(-1), [debounced, items.length]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function select(p: PatientListItem) {
    onChange(p);
    setOpen(false);
    setSearch("");
    setDebounced("");
    setActive(-1);
  }

  function clear() {
    onChange(null);
    setSearch("");
    setDebounced("");
    setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (items.length === 0) return;
      e.preventDefault();
      setOpen(true);
      // From "no selection" land on the first item; otherwise advance,
      // clamping at the last (no wrap — predictable for a short list).
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (showList && active >= 0 && active < items.length) {
        e.preventDefault();
        select(items[active]!);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  if (value) {
    return (
      <div
        className="flex flex-wrap items-center gap-3"
        data-testid={`${testId}-selected`}
      >
        <span className="text-sm font-medium">
          {value.firstName} {value.lastName}
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {value.pacwareId ? `PacWare ${value.pacwareId} · ` : ""}
          {value.status}
        </span>
        <Button intent="secondary" onClick={clear} disabled={disabled}>
          Change patient
        </Button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Input
        id={id}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && active >= 0 ? optionId(active) : undefined
        }
        data-testid={`${testId}-input`}
      />
      {showList && (
        <div className="absolute z-50 mt-1 w-full">
          {matches.isError ? (
            <div
              className="rounded-md border bg-white p-2 shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <ErrorPanel
                error={matches.error}
                onRetry={() => void matches.refetch()}
              />
            </div>
          ) : matches.isFetching && items.length === 0 ? (
            <div
              className="rounded-md border bg-white px-3 py-2 shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <Spinner label="Searching…" />
            </div>
          ) : items.length === 0 ? (
            <div
              className="rounded-md border bg-white px-3 py-2 text-sm shadow-lg"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--ink-3))",
              }}
              data-testid={`${testId}-empty`}
            >
              No patients match “{debounced}”.
            </div>
          ) : (
            <ul
              id={listId}
              role="listbox"
              className="max-h-60 overflow-auto rounded-md border bg-white shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {items.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    // The input is the single tab stop; options are reached
                    // via aria-activedescendant, so keep them out of the tab
                    // sequence.
                    tabIndex={-1}
                    onClick={() => select(p)}
                    onMouseEnter={() => setActive(i)}
                    className={`w-full px-3 py-2 text-left text-sm ${
                      i === active ? "bg-slate-100" : "hover:bg-slate-50"
                    }`}
                    data-testid={`${testId}-option-${p.id}`}
                  >
                    <span className="font-medium">
                      {p.firstName} {p.lastName}
                    </span>
                    <span
                      className="ml-2 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {p.pacwareId ? `PacWare ${p.pacwareId} · ` : ""}
                      {p.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

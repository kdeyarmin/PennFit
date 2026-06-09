import { useMemo, useState, type ReactNode } from "react";

// Minimal data table primitive. Admin console tables are read-only
// with one optional row click; nothing fancy like sticky headers,
// virtualization or column reordering. Width control lives on the
// caller via column.className so we don't reinvent CSS grid.
//
// Optional client-side sorting: mark a column `sortable` and give it a
// `sortValue` accessor, and its header becomes a tri-state toggle
// (ascending → descending → unsorted). This is a pure in-memory sort,
// appropriate for the capped lists these tables render; server-side
// ordering for truly large datasets is a separate concern. Columns
// without `sortable` are unaffected, so existing callers need no change.

export interface Column<Row> {
  key: string;
  header: ReactNode;
  className?: string;
  render: (row: Row) => ReactNode;
  /** Enable a clickable sort toggle on this column's header. */
  sortable?: boolean;
  /**
   * Value to sort by when this column is active. Numbers sort
   * numerically, everything else by locale string compare; `null` /
   * `undefined` / blank always sort last regardless of direction.
   * Required for sorting to do anything — a `sortable` column without
   * it is a no-op.
   */
  sortValue?: (row: Row) => string | number | null | undefined;
}

type SortDir = "asc" | "desc";

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyState,
  initialSort,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  emptyState?: ReactNode;
  /** Optional starting sort. Cleared by toggling the column past descending. */
  initialSort?: { key: string; dir: SortDir };
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(
    initialSort ?? null,
  );

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const accessor = col?.sortValue;
    if (!accessor) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      const aNil = av == null || av === "";
      const bNil = bv == null || bv === "";
      // Nulls/blanks always sort last, regardless of direction.
      if (aNil && bNil) return 0;
      if (aNil) return 1;
      if (bNil) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * dir;
    });
  }, [rows, columns, sort]);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // third activation clears the sort
    });
  }

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr
            className="border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {columns.map((col) => {
              const isActive = sort?.key === col.key;
              const ariaSort: "ascending" | "descending" | "none" | undefined =
                col.sortable
                  ? isActive
                    ? sort!.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                  : undefined;
              return (
                <th
                  key={col.key}
                  className={`text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${col.className ?? ""}`}
                  style={{
                    color: "hsl(var(--ink-3))",
                    backgroundColor: "hsl(var(--surface-1))",
                  }}
                  scope="col"
                  aria-sort={ariaSort}
                >
                  {col.sortable && col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 uppercase tracking-[0.16em] hover:opacity-80"
                      style={{ color: "inherit" }}
                    >
                      {col.header}
                      <span aria-hidden="true" className="text-[9px]">
                        {isActive ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const clickable = !!onRowClick;
            return (
              <tr
                key={rowKey(row)}
                className={`border-b transition-colors ${clickable ? "cursor-pointer" : ""}`}
                style={{
                  borderColor: "hsl(var(--line-1) / 0.6)",
                  backgroundColor: "transparent",
                }}
                onClick={clickable ? () => onRowClick!(row) : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick!(row);
                        }
                      }
                    : undefined
                }
                onMouseEnter={
                  clickable
                    ? (e) =>
                        (e.currentTarget.style.backgroundColor =
                          "hsl(var(--surface-3))")
                    : undefined
                }
                onMouseLeave={
                  clickable
                    ? (e) =>
                        (e.currentTarget.style.backgroundColor = "transparent")
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-5 py-3 align-middle ${col.className ?? ""}`}
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

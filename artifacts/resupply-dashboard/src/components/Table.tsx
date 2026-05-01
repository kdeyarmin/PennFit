import type { ReactNode } from "react";

// Minimal data table primitive. Admin console tables are read-only
// with one optional row click; nothing fancy like sticky headers,
// virtualization or column reordering. Width control lives on the
// caller via column.className so we don't reinvent CSS grid.

export interface Column<Row> {
  key: string;
  header: ReactNode;
  className?: string;
  render: (row: Row) => ReactNode;
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyState,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  emptyState?: ReactNode;
}) {
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
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${col.className ?? ""}`}
                style={{
                  color: "hsl(var(--ink-3))",
                  backgroundColor: "hsl(var(--surface-1))",
                }}
                scope="col"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
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

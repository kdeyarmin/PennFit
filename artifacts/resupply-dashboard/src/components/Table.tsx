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
          <tr className="border-b" style={{ borderColor: "#e5e7eb" }}>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider ${col.className ?? ""}`}
                style={{ color: "#6b7280", backgroundColor: "#f9fafb" }}
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
                className={`border-b ${clickable ? "cursor-pointer hover:bg-slate-50" : ""}`}
                style={{ borderColor: "#f1f5f9" }}
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
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-5 py-3 align-middle ${col.className ?? ""}`}
                    style={{ color: "#0a1f44" }}
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

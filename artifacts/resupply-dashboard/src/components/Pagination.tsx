import { Button } from "./Button";

// List-page pagination strip. All list endpoints return
// { items, total, limit, offset }; this component takes those four
// values + an `onChange(offset)` callback. Page math lives here so
// every page renders pages identically.

export function Pagination({
  total,
  limit,
  offset,
  onChange,
  isLoading,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (nextOffset: number) => void;
  isLoading?: boolean;
}) {
  const safeTotal = Math.max(0, total);
  const safeLimit = Math.max(1, limit);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
  const currentPage =
    Math.min(totalPages, Math.floor(offset / safeLimit) + 1) || 1;

  const startIdx = safeTotal === 0 ? 0 : offset + 1;
  const endIdx = Math.min(safeTotal, offset + safeLimit);

  const canPrev = currentPage > 1 && !isLoading;
  const canNext = currentPage < totalPages && !isLoading;

  return (
    <div
      className="flex items-center justify-between px-5 py-3 border-t text-xs"
      style={{
        borderColor: "hsl(var(--line-1))",
        color: "hsl(var(--ink-2))",
      }}
    >
      <span>
        {safeTotal === 0
          ? "No results"
          : `Showing ${startIdx}–${endIdx} of ${safeTotal}`}
      </span>
      <div className="flex items-center gap-2">
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <Button
          intent="secondary"
          size="sm"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(0, offset - safeLimit))}
        >
          Prev
        </Button>
        <Button
          intent="secondary"
          size="sm"
          disabled={!canNext}
          onClick={() => onChange(offset + safeLimit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

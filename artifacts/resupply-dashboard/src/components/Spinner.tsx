// Tiny purpose-built loading indicator. Used inside cards/tables so
// loading states share the brand chrome rather than introducing a
// page-level skeleton system.

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-2 text-sm py-6 justify-center"
      style={{ color: "#6b7280" }}
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block h-4 w-4 rounded-full border-2 animate-spin"
        style={{
          borderColor: "#c9a24a",
          borderTopColor: "transparent",
        }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

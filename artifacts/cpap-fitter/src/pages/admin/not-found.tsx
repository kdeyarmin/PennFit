import { Link } from "wouter";

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <div
        className="max-w-md w-full bg-white border rounded-lg p-8 shadow-sm text-center"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <p
          className="text-xs uppercase tracking-[0.2em] mb-2 font-semibold"
          style={{ color: "hsl(var(--penn-gold-deep))" }}
        >
          404
        </p>
        <h1 className="text-2xl font-semibold mb-3" style={{ color: "hsl(var(--ink-1))" }}>
          Page not found
        </h1>
        <p className="text-sm mb-6" style={{ color: "hsl(var(--ink-2))" }}>
          That route is not part of the admin console. Phase 0 only ships
          the home placeholder.
        </p>
        <Link
          href="/admin"
          className="inline-block text-sm font-medium underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Back to console home
        </Link>
      </div>
    </div>
  );
}

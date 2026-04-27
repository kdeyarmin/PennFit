import { Link } from "wouter";

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <div
        className="max-w-md w-full bg-white border rounded-lg p-8 shadow-sm text-center"
        style={{ borderColor: "#e5e7eb" }}
      >
        <p
          className="text-xs uppercase tracking-[0.2em] mb-2 font-semibold"
          style={{ color: "#c9a24a" }}
        >
          404
        </p>
        <h1 className="text-2xl font-semibold mb-3" style={{ color: "#0a1f44" }}>
          Page not found
        </h1>
        <p className="text-sm mb-6" style={{ color: "#374151" }}>
          That route is not part of the operator console. Phase 0 only ships
          the home placeholder.
        </p>
        <Link
          href="/"
          className="inline-block text-sm font-medium underline"
          style={{ color: "#0a1f44" }}
        >
          Back to console home
        </Link>
      </div>
    </div>
  );
}

// Shared path helper for demo handlers that build same-origin URLs
// (simulated checkout success, billing portal, etc.).

/** App base path (Vite BASE_URL) normalized to end with a single "/". */
export function appBaseUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

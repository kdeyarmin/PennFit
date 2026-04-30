// Hand-rolled fetch wrappers for the admin shop-reviews endpoints.
//
// Why hand-rolled instead of going through the generated client:
// the v1 review endpoints aren't in the OpenAPI spec yet — they were
// added directly to the API for a fast moderation loop. Adding them
// to the spec + regen would be the right next step if the surface
// grows, but for the v1 admin queue this thin wrapper is enough and
// avoids a codegen cycle for every backend tweak.
//
// Auth bridge: we reuse the same `globalThis.Clerk.session.getToken()`
// pattern api-client.ts already wires up — see `getTokenFromGlobal`
// there. The bridge is registered at module load, so by the time any
// query in this module fires, the auth provider has installed `window.Clerk`.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface AdminReview {
  id: string;
  productId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  body: string;
  authorDisplayName: string;
  authorEmail: string;
  status: ReviewStatus;
  moderationNote: string | null;
  moderatedAt: string | null;
  moderatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReviewListResponse {
  items: AdminReview[];
  nextCursor: string | null;
}

export interface ListReviewsParams {
  status: ReviewStatus | "all";
  cursor?: string;
  limit?: number;
}

export async function listAdminShopReviews(
  params: ListReviewsParams,
): Promise<AdminReviewListResponse> {
  const qs = new URLSearchParams();
  qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await fetch(`/resupply-api/admin/shop/reviews?${qs.toString()}`, {
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) {
    throw new Error(`Failed to load reviews (${res.status})`);
  }
  return (await res.json()) as AdminReviewListResponse;
}

export async function approveAdminShopReview(id: string): Promise<AdminReview> {
  const res = await fetch(
    `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/approve`,
    {
      method: "POST",
      headers: { Accept: "application/json", ...(await authHeaders()) },
    },
  );
  if (!res.ok) {
    throw new Error(`Approve failed (${res.status})`);
  }
  return (await res.json()) as AdminReview;
}

export async function rejectAdminShopReview(
  id: string,
  note: string | null,
): Promise<AdminReview> {
  const res = await fetch(
    `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/reject`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(await authHeaders()),
      },
      body: JSON.stringify(note ? { note } : {}),
    },
  );
  if (!res.ok) {
    throw new Error(`Reject failed (${res.status})`);
  }
  return (await res.json()) as AdminReview;
}

// Un-reject endpoint: flips a rejected review back to pending so it
// re-enters the moderation queue. The server clears the moderation
// note + moderatedAt server-side; we don't need to send anything
// other than the id. Returns the trimmed status response (the
// review is no longer visible to the customer until a new
// approve/reject lands).
export interface UnrejectResponse {
  id: string;
  status: ReviewStatus;
  moderatedAt: string | null;
}

export async function unrejectAdminShopReview(
  id: string,
): Promise<UnrejectResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/unreject`,
    {
      method: "POST",
      headers: { Accept: "application/json", ...(await authHeaders()) },
    },
  );
  if (!res.ok) {
    throw new Error(`Un-reject failed (${res.status})`);
  }
  return (await res.json()) as UnrejectResponse;
}

// PATCH the rejection note on an already-rejected review. Empty
// string / null → clears the note. Server enforces the same 500 char
// cap as the original reject body.
export interface NotePatchResponse {
  id: string;
  status: ReviewStatus;
  moderationNote: string | null;
  moderatedAt: string | null;
}

export async function updateAdminShopReviewNote(
  id: string,
  note: string | null,
): Promise<NotePatchResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/note`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ note: note && note.trim() !== "" ? note : null }),
    },
  );
  if (!res.ok) {
    throw new Error(`Note update failed (${res.status})`);
  }
  return (await res.json()) as NotePatchResponse;
}

// Hand-rolled fetch wrappers for the admin shop-reviews endpoints.
//
// Why hand-rolled instead of going through the generated client:
// the v1 review endpoints aren't in the OpenAPI spec yet — they were
// added directly to the API for a fast moderation loop. Adding them
// to the spec + regen would be the right next step if the surface
// grows, but for the v1 admin queue this thin wrapper is enough and
// avoids a codegen cycle for every backend tweak.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

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
  const url = `/resupply-api/admin/shop/reviews?${qs.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as AdminReviewListResponse;
}

export async function approveAdminShopReview(id: string): Promise<AdminReview> {
  const url = `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/approve`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as AdminReview;
}

export async function rejectAdminShopReview(
  id: string,
  note: string | null,
): Promise<AdminReview> {
  const url = `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/reject`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
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
  const url = `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/unreject`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
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
  const url = `/resupply-api/admin/shop/reviews/${encodeURIComponent(id)}/note`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ note: note && note.trim() !== "" ? note : null }),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "PATCH", url });
  }
  return (await res.json()) as NotePatchResponse;
}

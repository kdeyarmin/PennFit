// Hand-rolled fetch wrappers for the admin product-question
// moderation endpoints (Phase A.5 follow-up).

export type AdminProductQuestionStatus = "pending" | "answered" | "rejected";

export interface AdminProductQuestion {
  id: string;
  productId: string;
  askerDisplayName: string;
  askerEmail: string;
  questionBody: string;
  answerBody: string | null;
  answeredByEmail: string | null;
  answeredAt: string | null;
  moderationNote: string | null;
  moderatedAt: string | null;
  status: AdminProductQuestionStatus;
  createdAt: string;
}

export interface AdminProductQuestionListResponse {
  items: AdminProductQuestion[];
  nextCursor: string | null;
}

export interface ListProductQuestionsParams {
  status: AdminProductQuestionStatus;
  cursor?: string;
  limit?: number;
}

export async function listAdminProductQuestions(
  params: ListProductQuestionsParams,
): Promise<AdminProductQuestionListResponse> {
  const qs = new URLSearchParams();
  qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await fetch(
    `/resupply-api/admin/shop/product-questions?${qs.toString()}`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load questions (${res.status})`);
  }
  return (await res.json()) as AdminProductQuestionListResponse;
}

export async function answerAdminProductQuestion(
  id: string,
  answerBody: string,
): Promise<void> {
  const res = await fetch(
    `/resupply-api/admin/shop/product-questions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer", answerBody }),
    },
  );
  if (res.status === 409) {
    throw new Error(
      "This question was already answered or rejected by another moderator.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to answer (${res.status}): ${text}`);
  }
}

export async function rejectAdminProductQuestion(
  id: string,
  moderationNote: string | null,
): Promise<void> {
  const res = await fetch(
    `/resupply-api/admin/shop/product-questions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", moderationNote }),
    },
  );
  if (res.status === 409) {
    throw new Error(
      "This question was already answered or rejected by another moderator.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to reject (${res.status}): ${text}`);
  }
}

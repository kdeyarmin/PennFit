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

export async function listAdminProductQuestions(
  status: AdminProductQuestionStatus,
): Promise<{ questions: AdminProductQuestion[] }> {
  const res = await fetch(
    `/resupply-api/admin/shop/product-questions?status=${encodeURIComponent(status)}`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load questions (${res.status})`);
  }
  return (await res.json()) as { questions: AdminProductQuestion[] };
}

export class AlreadyModeratedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyModeratedError";
  }
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
    const json = await res.json().catch(() => ({}));
    const msg =
      typeof json.message === "string"
        ? json.message
        : "This question has already been moderated by another CSR.";
    throw new AlreadyModeratedError(msg);
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
    const json = await res.json().catch(() => ({}));
    const msg =
      typeof json.message === "string"
        ? json.message
        : "This question has already been moderated by another CSR.";
    throw new AlreadyModeratedError(msg);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to reject (${res.status}): ${text}`);
  }
}

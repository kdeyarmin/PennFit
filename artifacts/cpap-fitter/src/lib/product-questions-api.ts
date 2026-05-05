// Hand-rolled fetch wrappers for the product Q&A endpoints
// (Phase A.5 / feature #24 extension).

export interface ShopProductQuestion {
  id: string;
  askerDisplayName: string;
  questionBody: string;
  /** Empty string when the question is not yet answered. The public
   *  endpoint only returns answered questions, so this is always
   *  populated for entries the customer sees. */
  answerBody: string;
  answeredAt: string | null;
  createdAt: string;
}

export interface ListShopProductQuestionsResponse {
  questions: ShopProductQuestion[];
}

export interface SubmitShopProductQuestionResponse {
  id: string;
  status: "pending";
  createdAt: string;
}

export async function fetchProductQuestions(
  productId: string,
): Promise<ListShopProductQuestionsResponse> {
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/questions`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to load questions (${res.status})`);
  }
  return (await res.json()) as ListShopProductQuestionsResponse;
}

export async function submitProductQuestion(
  productId: string,
  questionBody: string,
): Promise<SubmitShopProductQuestionResponse> {
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/questions`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ questionBody }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to submit question (${res.status}): ${text}`);
  }
  return (await res.json()) as SubmitShopProductQuestionResponse;
}

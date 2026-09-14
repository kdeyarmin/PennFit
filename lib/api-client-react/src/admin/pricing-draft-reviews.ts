export type PricingDraftReview = {
  draftId: string;
  patientId: string | null;
  sku: string | null;
  quantity: number | null;
  state: "ready" | "review_needed" | "stale" | "unavailable";
  message: string;
  quoteId?: string;
  quoteRevision?: number;
  contributionCents?: number | null;
  marginBps?: number | null;
};
export type PricingDraftReviewResponse = {
  reviews: PricingDraftReview[];
  evaluatedAt: string;
};

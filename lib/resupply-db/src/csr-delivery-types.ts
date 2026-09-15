import type { Json } from "./supabase-types";
export type CsrDeliveryReviewRow = {
  id: string;
  org_id: string;
  order_id: string;
  quote_id: string;
  quote_revision: number;
  revision: number;
  status: "pending" | "approved";
  data: Json;
  address_snapshot: Json;
  valid_until: string;
  approved_at: string | null;
  approved_by: string | null;
  reason: string | null;
  created_at: string;
  created_by: string;
};
export type CsrDeliveryReviewTable = {
  Row: CsrDeliveryReviewRow;
  Insert: Partial<CsrDeliveryReviewRow>;
  Update: Partial<CsrDeliveryReviewRow>;
  Relationships: [];
};

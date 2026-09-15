import type { Json } from "./supabase-types";

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};
type Created = {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string;
};
export type PricingTables = {
  pricing_policies: Table<
    Created & {
      version: number;
      data: Json;
      effective_from: string;
      expires_at: string;
    }
  >;
  pricing_offers: Table<
    Created & {
      version: number;
      sku: string;
      is_current: boolean;
      data: Json;
      effective_from: string;
      expires_at: string;
    }
  >;
  pricing_state: Table<{
    org_id: string;
    revision: number;
    enabled: boolean;
    enforce_quotes: boolean;
    current_policy_id: string | null;
    active_price_list_id: string | null;
  }>;
  pricing_price_lists: Table<
    Created & {
      name: string;
      entries: Json;
      scheduled_at: string | null;
      schedule_status: "pending" | "applied" | "cancelled" | "blocked" | null;
      schedule_error: string | null;
    }
  >;
  pricing_quotes: Table<
    Created & {
      patient_id: string | null;
      revision: number;
      status: "draft" | "pending_approval" | "approved" | "bound";
      policy_id: string;
      policy_version: number;
      scenario: Json;
      input: Json;
      evaluation: Json;
      lines: Json;
      dependencies: Json;
      approval_class: "firm" | "exception" | "blocked";
      valid_until: string;
      approved_by: string | null;
      approved_at: string | null;
      bound_order_id: string | null;
      actuals_revision: number;
      costs_complete: boolean;
      revenue_complete: boolean;
      updated_at: string;
    }
  >;
  pricing_events: Table<
    Omit<Created, "created_by"> & {
      entity_id: string;
      operation: string;
      actor: string;
      data: Json;
    }
  >;
  pricing_actual_events: Table<
    Created & {
      quote_id: string;
      economic_event_id: string;
      source: string;
      source_ref: string;
      kind: "cost" | "revenue" | "refund" | "cost_credit";
      amount_cents: number;
      data: Json;
    }
  >;
  pricing_shipping_quotes: Table<
    Omit<Created, "created_by"> & {
      cost_cents: number;
      data: Json;
      expires_at: string;
    }
  >;
  pricing_proposals: Table<
    Created & {
      revision: number;
      status: "open" | "reviewing" | "resolved" | "rejected";
      data: Json;
      sku: string | null;
      review_notes: string | null;
    }
  >;
  pricing_revenue_profiles: Table<
    Created & {
      version: number;
      patient_id: string;
      data: Json;
      effective_from: string;
      expires_at: string;
    }
  >;
  pricing_alert_reviews: Table<{
    org_id: string;
    key: string;
    revision: number;
    status: "open" | "resolved";
    owner: string;
    review_at: string | null;
    notes: string;
    updated_at: string;
  }>;
};

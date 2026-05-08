// Hand-authored Supabase Database type for the Drizzle → Supabase
// migration in progress.
//
// Why hand-authored: `mcp__supabase__generate_typescript_types` only
// emits the schemas exposed via PostgREST's `db_schemas` setting.
// The PennPaps Supabase project currently exposes only `public`, but
// every resupply table lives under `resupply` or `resupply_auth`. Until
// those schemas are added to the project's Exposed schemas list (Studio
// → Project Settings → API → "Exposed schemas") this file is the
// authoritative type source for the Supabase JS client.
//
// Coverage today: the tables touched by `artifacts/resupply-api/src/
// routes/storefront/admin-users.ts` (the first module ported off
// Drizzle). Extend as more modules migrate.
//
// When the `resupply` and `resupply_auth` schemas are exposed, replace
// this file with the generator output and delete the hand-authored
// shapes.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  // PostgREST default schema. Storefront-funnel tables (orders,
  // usage_events, admin_audit_log, reminder_subscriptions from
  // migration 0027) live here.
  public: {
    Tables: {
      usage_events: {
        Row: {
          id: string;
          session_id: string;
          step: string;
          metadata: string | null;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          step: string;
          metadata?: string | null;
          occurred_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["usage_events"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
  resupply: {
    Tables: {
      admin_users: {
        Row: {
          id: string;
          email_lower: string;
          role: "admin" | "agent";
          status: "pending" | "active" | "revoked";
          display_name: string | null;
          notes: string | null;
          invited_by: string | null;
          invited_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          last_login_at: string | null;
          auth_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_lower: string;
          role?: "admin" | "agent";
          status?: "pending" | "active" | "revoked";
          display_name?: string | null;
          notes?: string | null;
          invited_by?: string | null;
          invited_at?: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          last_login_at?: string | null;
          auth_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["resupply"]["Tables"]["admin_users"]["Insert"]>;
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          operator_email: string | null;
          operator_user_id: string | null;
          action: string;
          target_table: string | null;
          target_id: string | null;
          metadata: Json;
          ip: string | null;
          user_agent: string | null;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          operator_email?: string | null;
          operator_user_id?: string | null;
          action: string;
          target_table?: string | null;
          target_id?: string | null;
          metadata?: Json;
          ip?: string | null;
          user_agent?: string | null;
          occurred_at?: string;
        };
        Update: Partial<Database["resupply"]["Tables"]["audit_log"]["Insert"]>;
        Relationships: [];
      };
      conversations: {
        Row: {
          id: string;
          patient_id: string | null;
          episode_id: string | null;
          customer_id: string | null;
          channel: string;
          status: string;
          priority: string;
          external_ref: string | null;
          last_message_at: string | null;
          assigned_admin_user_id: string | null;
          assigned_at: string | null;
          sla_due_at: string | null;
          escalated_at: string | null;
          escalated_to: string | null;
          escalation_reason: string | null;
          customer_last_read_at: string | null;
          last_in_app_notification_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["conversations"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["conversations"]["Row"]>;
        Relationships: [];
      };
      episodes: {
        Row: {
          id: string;
          patient_id: string;
          prescription_id: string;
          status: string;
          due_at: string;
          expires_at: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["episodes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["episodes"]["Row"]>;
        Relationships: [];
      };
      fulfillments: {
        Row: {
          id: string;
          patient_id: string;
          episode_id: string;
          item_sku: string;
          quantity: number;
          status: string;
          pacware_order_ref: string | null;
          shipment_metadata: Json;
          submitted_at: string | null;
          shipped_at: string | null;
          delivered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["fulfillments"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["fulfillments"]["Row"]>;
        Relationships: [];
      };
      patients: {
        Row: {
          id: string;
          pacware_id: string;
          legal_first_name: string;
          legal_last_name: string;
          date_of_birth: string;
          phone_e164: string | null;
          email: string | null;
          address: Json | null;
          status: string;
          insurance_payer: string | null;
          cadence_override_days: number | null;
          channel_preference: string | null;
          portal_auth_user_id: string | null;
          portal_invited_at: string | null;
          portal_invited_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patients"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patients"]["Row"]>;
        Relationships: [];
      };
      frequency_rules: {
        Row: {
          id: string;
          name: string;
          priority: number;
          match_item_sku_prefix: string | null;
          match_insurance_payer: string | null;
          min_tenure_days: number | null;
          max_tenure_days: number | null;
          cadence_days: number;
          default_channel: string | null;
          active: boolean;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["frequency_rules"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["frequency_rules"]["Row"]>;
        Relationships: [];
      };
      // Minimal coverage for count-style queries; expand to full Row
      // as more callers migrate.
      shop_returns: {
        Row: {
          id: string;
          customer_id: string;
          order_id: string;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_returns"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_returns"]["Row"]>;
        Relationships: [];
      };
      shop_reviews: {
        Row: {
          id: string;
          customer_id: string;
          product_id: string;
          rating: number;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_reviews"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_reviews"]["Row"]>;
        Relationships: [];
      };
      patient_documents: {
        Row: {
          id: string;
          patient_id: string;
          object_key: string;
          document_type: string;
          reviewed_at: string | null;
          reviewed_by_admin_id: string | null;
          review_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_documents"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_documents"]["Row"]>;
        Relationships: [];
      };
      shop_customer_followups: {
        Row: {
          id: string;
          customer_id: string;
          body: string;
          due_at: string;
          completed_at: string | null;
          completed_by_email: string | null;
          completed_by_user_id: string | null;
          created_by_email: string;
          created_by_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_customer_followups"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_customer_followups"]["Row"]>;
        Relationships: [];
      };
      insurance_leads: {
        Row: {
          id: string;
          full_name: string;
          email: string;
          phone: string;
          date_of_birth: string;
          insurance_carrier: string;
          member_id: string;
          group_number: string | null;
          prescribing_physician: string | null;
          notes: string | null;
          status: string;
          csr_note: string | null;
          notification_email_delivered: boolean;
          confirmation_email_delivered: boolean;
          submitter_ip: string | null;
          user_agent: string | null;
          moderated_at: string | null;
          moderated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["insurance_leads"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["insurance_leads"]["Row"]>;
        Relationships: [];
      };
      shop_product_questions: {
        Row: {
          id: string;
          product_id: string;
          customer_id: string;
          asker_display_name: string;
          asker_email: string;
          question_body: string;
          status: string;
          answer_body: string | null;
          answered_by_email: string | null;
          answered_by_user_id: string | null;
          answered_at: string | null;
          moderation_note: string | null;
          moderated_at: string | null;
          moderated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_product_questions"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_product_questions"]["Row"]>;
        Relationships: [];
      };
      shop_customer_push_subscriptions: {
        Row: {
          id: string;
          customer_id: string;
          endpoint: string;
          auth_b64: string;
          p256dh_b64: string;
          user_agent: string | null;
          expired_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_customer_push_subscriptions"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_customer_push_subscriptions"]["Row"]>;
        Relationships: [];
      };
      patient_smart_trigger_events: {
        Row: {
          id: string;
          patient_id: string;
          kind: string;
          detected_at: string;
          window_start_date: string;
          window_end_date: string;
          sent_at: string | null;
          dismissed_at: string | null;
          dismissed_by_email: string | null;
          dismissed_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_smart_trigger_events"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_smart_trigger_events"]["Row"]>;
        Relationships: [];
      };
      physician_fax_outreach: {
        Row: {
          id: string;
          patient_id: string;
          prescription_id: string | null;
          physician_name: string;
          physician_fax_e164: string;
          cover_letter_text: string;
          status: string;
          vendor_ref: string | null;
          vendor_name: string | null;
          sent_at: string | null;
          delivered_at: string | null;
          failed_at: string | null;
          failure_reason: string | null;
          created_by_email: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["physician_fax_outreach"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["physician_fax_outreach"]["Row"]>;
        Relationships: [];
      };
      patient_followups: {
        Row: {
          id: string;
          patient_id: string;
          body: string;
          due_at: string;
          completed_at: string | null;
          completed_by_email: string | null;
          completed_by_user_id: string | null;
          created_by_email: string;
          created_by_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_followups"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_followups"]["Row"]>;
        Relationships: [];
      };
      prescriptions: {
        Row: {
          id: string;
          patient_id: string;
          item_sku: string;
          cadence_days: number;
          valid_from: string;
          valid_until: string | null;
          details: Json | null;
          status: string;
          attachment_object_key: string | null;
          attachment_filename: string | null;
          attachment_content_type: string | null;
          attachment_size_bytes: number | null;
          attachment_uploaded_at: string | null;
          renewal_requested_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["prescriptions"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["prescriptions"]["Row"]>;
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          direction: string;
          sender_role: string;
          body: string;
          delivery_status: string | null;
          delivery_error: string | null;
          vendor_metadata: Json;
          sent_at: string | null;
          delivered_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["messages"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["messages"]["Row"]>;
        Relationships: [];
      };
      patient_latest_message: {
        Row: {
          patient_id: string;
          last_message_at: string;
          last_message_direction: string;
          last_message_preview: string;
          last_message_conversation_id: string | null;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_latest_message"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_latest_message"]["Row"]>;
        Relationships: [];
      };
      patient_notes: {
        Row: {
          id: string;
          patient_id: string;
          body: string;
          author_email: string;
          author_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_notes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_notes"]["Row"]>;
        Relationships: [];
      };
      shop_subscriptions: {
        Row: {
          id: string;
          customer_id: string;
          stripe_subscription_id: string;
          stripe_customer_id: string | null;
          status: string;
          items: Json;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          initial_amount_total_cents: number | null;
          last_stripe_event_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_subscriptions"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_subscriptions"]["Row"]>;
        Relationships: [];
      };
      shop_customers: {
        Row: {
          customer_id: string;
          stripe_customer_id: string | null;
          display_name: string | null;
          email_lower: string | null;
          shipping_address_json: Json | null;
          default_payment_method_id: string | null;
          default_payment_method_brand: string | null;
          default_payment_method_last4: string | null;
          default_payment_method_exp_month: number | null;
          default_payment_method_exp_year: number | null;
          communication_preferences: Json | null;
          cpap_device_json: Json | null;
          physician_info_json: Json | null;
          facial_measurements_json: Json | null;
          auth_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_customers"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_customers"]["Row"]>;
        Relationships: [];
      };
      shop_order_items: {
        Row: {
          id: string;
          order_id: string;
          stripe_session_id: string;
          customer_id: string | null;
          product_id: string;
          price_id: string;
          quantity: number;
          unit_amount_cents: number | null;
          currency: string | null;
          paid_at: string;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_order_items"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_order_items"]["Row"]>;
        Relationships: [];
      };
      shop_abandoned_carts: {
        Row: {
          id: string;
          customer_id: string;
          email: string | null;
          items: Json;
          subtotal_cents: number;
          currency: string;
          updated_at: string;
          reminded_at: string | null;
          recovered_at: string | null;
          cleared_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_abandoned_carts"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_abandoned_carts"]["Row"]>;
        Relationships: [];
      };
      shop_orders: {
        Row: {
          id: string;
          stripe_session_id: string;
          stripe_payment_intent_id: string | null;
          status: string;
          amount_total_cents: number | null;
          currency: string | null;
          cart_hash: string | null;
          customer_id: string | null;
          tracking_carrier: string | null;
          tracking_number: string | null;
          shipped_at: string | null;
          delivered_at: string | null;
          shipping_address_json: Json | null;
          confirmation_email_sent_at: string | null;
          shipping_email_sent_at: string | null;
          customer_email: string | null;
          review_request_sent_at: string | null;
          created_at: string;
          updated_at: string;
          paid_at: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_orders"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_orders"]["Row"]>;
        Relationships: [];
      };
      shop_order_notes: {
        Row: {
          id: string;
          order_id: string;
          body: string;
          author_email: string;
          author_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_order_notes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_order_notes"]["Row"]>;
        Relationships: [];
      };
      shop_customer_notes: {
        Row: {
          id: string;
          customer_id: string;
          body: string;
          author_email: string;
          author_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_customer_notes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_customer_notes"]["Row"]>;
        Relationships: [];
      };
      shop_product_compatibility: {
        Row: {
          id: string;
          product_id: string;
          machine_manufacturer: string;
          machine_model: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_product_compatibility"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_product_compatibility"]["Row"]>;
        Relationships: [];
      };
      csr_macros: {
        Row: {
          id: string;
          key: string;
          label: string;
          category: string | null;
          body: string;
          channels: Json;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
          created_by: string | null;
          updated_by: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["csr_macros"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["csr_macros"]["Row"]>;
        Relationships: [];
      };
      shop_return_notes: {
        Row: {
          id: string;
          return_id: string;
          body: string;
          author_email: string;
          author_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_return_notes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_return_notes"]["Row"]>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
  resupply_auth: {
    Tables: {
      users: {
        Row: {
          id: string;
          email_lower: string;
          display_name: string | null;
          role: string;
          status: string;
          email_verified_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_lower: string;
          display_name?: string | null;
          role?: string;
          status?: string;
          email_verified_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["resupply_auth"]["Tables"]["users"]["Insert"]>;
        Relationships: [];
      };
      password_credentials: {
        Row: {
          user_id: string;
          password_hash: string;
          algo: string;
          must_change: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          password_hash: string;
          algo?: string;
          must_change?: boolean;
          updated_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["password_credentials"]["Insert"]
        >;
        Relationships: [];
      };
      sessions: {
        Row: {
          id: string;
          // bytea — Supabase JS round-trips bytea as a hex string by
          // default ("\\x...").  Typed as `string` so the type system
          // matches what the wire actually carries; the in-house
          // helpers convert back to Buffer at the API boundary.
          token_hash: string;
          user_id: string;
          issued_at: string;
          expires_at: string;
          last_seen_at: string;
          revoked_at: string | null;
          ip: string | null;
          user_agent_hash: string | null;
        };
        Insert: {
          id?: string;
          token_hash: string;
          user_id: string;
          issued_at?: string;
          expires_at: string;
          last_seen_at?: string;
          revoked_at?: string | null;
          ip?: string | null;
          user_agent_hash?: string | null;
        };
        Update: Partial<Database["resupply_auth"]["Tables"]["sessions"]["Insert"]>;
        Relationships: [];
      };
      email_tokens: {
        Row: {
          token_hash: string;
          user_id: string;
          purpose: string;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: {
          token_hash: string;
          user_id: string;
          purpose: string;
          expires_at: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["email_tokens"]["Insert"]
        >;
        Relationships: [];
      };
      login_attempts: {
        Row: {
          id: number;
          email_lower: string;
          ip: string | null;
          success: boolean;
          attempted_at: string;
        };
        Insert: {
          id?: number;
          email_lower: string;
          ip?: string | null;
          success: boolean;
          attempted_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["login_attempts"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}

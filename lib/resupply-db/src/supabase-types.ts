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

/** Shape of a single line entry in claim_templates.lines_json. */
export interface TemplateLine {
  hcpcs: string;
  modifiers: string;
  units: number;
  billed_cents: number;
  description?: string;
}

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
      admin_audit_log: {
        Row: {
          id: string;
          admin_email: string;
          admin_user_id: string;
          action: string;
          target_order_id: string | null;
          ip: string | null;
          occurred_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["admin_audit_log"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["admin_audit_log"]["Row"]>;
        Relationships: [];
      };
      reminder_subscriptions: {
        Row: {
          id: string;
          email: string;
          manage_token: string;
          status: "active" | "unsubscribed";
          items: Json;
          last_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["reminder_subscriptions"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["reminder_subscriptions"]["Row"]>;
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          order_reference: string;
          patient_first_name: string;
          patient_last_name: string;
          patient_email: string;
          patient_phone: string;
          patient_date_of_birth: string;
          mask_id: string;
          mask_name: string;
          mask_manufacturer: string;
          mask_model_number: string;
          shipping_city: string;
          shipping_state: string;
          shipping_zip: string;
          payload: Json;
          email_status: "pending" | "sent" | "failed" | "skipped";
          email_error: string | null;
          email_delivered_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["orders"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["orders"]["Row"]>;
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
      patient_checkin_attempts: {
        Row: {
          id: string;
          journey_id: string;
          patient_id: string;
          day_label: string;
          channel: "email" | "sms" | "voice";
          outcome:
            | "sent"
            | "skipped_no_contact"
            | "skipped_not_configured"
            | "vendor_error";
          vendor_ref: string | null;
          error_code: string | null;
          attempted_at: string;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_checkin_attempts"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_checkin_attempts"]["Row"]>;
        Relationships: [];
      };
      idempotency_keys: {
        Row: {
          user_id: string;
          endpoint: string;
          key: string;
          request_hash: string;
          response_status: number;
          response_body: Json;
          created_at: string;
          expires_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["idempotency_keys"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["idempotency_keys"]["Row"]>;
        Relationships: [];
      };
      admin_users: {
        Row: {
          id: string;
          email_lower: string;
          role:
            | "admin"
            | "supervisor"
            | "csr"
            | "fitter"
            | "fulfillment"
            | "compliance_officer"
            | "agent";
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
          skills: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_lower: string;
          role?:
            | "admin"
            | "supervisor"
            | "csr"
            | "fitter"
            | "fulfillment"
            | "compliance_officer"
            | "agent";
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
          skills?: Json;
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
          archived_at: string | null;
          chain_seq: number | null;
          prev_signature: string | null;
          signature: string | null;
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
          archived_at?: string | null;
          chain_seq?: number | null;
          prev_signature?: string | null;
          signature?: string | null;
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
          required_skills: Json;
          tags: Json;
          snoozed_until: string | null;
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
          substituted_from_sku: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["fulfillments"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["fulfillments"]["Row"]>;
        Relationships: [];
      };
      shop_backorders: {
        Row: {
          id: string;
          sku: string;
          marked_at: string;
          cleared_at: string | null;
          notes: string | null;
          marked_by_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_backorders"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_backorders"]["Row"]>;
        Relationships: [];
      };
      shop_sku_substitutes: {
        Row: {
          id: string;
          primary_sku: string;
          alternative_sku: string;
          priority: number;
          notes: string | null;
          active: boolean;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_sku_substitutes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_sku_substitutes"]["Row"]>;
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
          quarterly_summary_last_sent_at: string | null;
          birthday_email_year_sent: number | null;
          sleep_anniversary_year_sent: number | null;
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
          stripe_session_id: string;
          status: string;
          reason: string;
          reason_note: string | null;
          resolution: string | null;
          refund_cents: number | null;
          stripe_refund_id: string | null;
          exchange_product_id: string | null;
          exchange_price_id: string | null;
          exchange_order_id: string | null;
          return_label_url: string | null;
          return_carrier: string | null;
          return_tracking_number: string | null;
          admin_note: string | null;
          admin_user_id: string | null;
          created_at: string;
          updated_at: string;
          approved_at: string | null;
          rejected_at: string | null;
          shipped_back_at: string | null;
          received_at: string | null;
          resolved_at: string | null;
          closed_at: string | null;
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
          title: string | null;
          body: string | null;
          author_display_name: string | null;
          author_email: string;
          status: string;
          moderation_note: string | null;
          moderated_at: string | null;
          moderated_by: string | null;
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
          filename: string | null;
          content_type: string;
          size_bytes: number;
          reviewed_at: string | null;
          reviewed_by_admin_id: string | null;
          review_note: string | null;
          created_at: string;
          updated_at: string;
          retention_until_at: string | null;
          legal_hold: boolean;
          retention_marked_at: string | null;
          destroyed_at: string | null;
          destroyed_by_admin_id: string | null;
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
      fitter_leads: {
        Row: {
          id: string;
          email: string;
          marketing_opt_in: boolean;
          submitter_ip: string | null;
          user_agent: string | null;
          created_at: string;
          nudged_at: string | null;
          phone_e164: string | null;
          sms_opt_in: boolean;
          source: "consent" | "sleep_apnea_quiz" | "insurance_quote";
          first_day_nudged_at: string | null;
          // Mig 0151 — fitter completion + supply-campaign journey.
          completed_at: string | null;
          recommended_mask_id: string | null;
          recommended_mask_name: string | null;
          recommended_mask_type: string | null;
          journey_stage:
            | "consent"
            | "completed"
            | "campaign_active"
            | "reorder_active"
            | "final_call_pending"
            | "converted"
            | "unsubscribed"
            | "expired";
          campaign_touch_count: number;
          last_campaign_touch_at: string | null;
          next_campaign_touch_at: string | null;
          unsubscribed_at: string | null;
          first_order_id: string | null;
          first_order_placed_at: string | null;
          // Mig 0152 — first-name personalization, captured from
          // public.orders.patient_name on conversion.
          first_name: string | null;
          // Mig 0153 — engagement tracking via tracking-pixel opens.
          engagement_score: number;
          hot_lead_at: string | null;
          // Mig 0154 — click tracking + CSR contact workflow.
          click_count: number;
          csr_contacted_at: string | null;
          csr_contacted_by: string | null;
          // Mig 0155 — per-lead engagement recency.
          last_open_at: string | null;
          last_click_at: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["fitter_leads"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["fitter_leads"]["Row"]>;
        Relationships: [];
      };
      // Mig 0151 — per-send audit log for the multi-touch supply
      // campaign. One row per (lead, touch_index, channel).
      fitter_campaign_touches: {
        Row: {
          id: string;
          lead_id: string;
          touch_index: number;
          channel: "email" | "sms";
          template_key: string;
          status: "sent" | "failed" | "skipped";
          error_message: string | null;
          sent_at: string;
          // Mig 0155 — per-touch open tracking.
          open_count: number;
          first_opened_at: string | null;
          last_opened_at: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["fitter_campaign_touches"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["fitter_campaign_touches"]["Row"]
        >;
        Relationships: [];
      };
      // Mig 0154 — per-click audit log. One row per CTA click.
      fitter_campaign_clicks: {
        Row: {
          id: string;
          lead_id: string;
          touch_index: number;
          link_key: string;
          clicked_at: string;
          submitter_ip: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["fitter_campaign_clicks"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["fitter_campaign_clicks"]["Row"]
        >;
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
      shop_back_in_stock_notifications: {
        Row: {
          id: string;
          product_id: string;
          email: string;
          submitter_ip: string | null;
          user_agent: string | null;
          notified_at: string | null;
          delivered: boolean;
          delivery_error: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_back_in_stock_notifications"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_back_in_stock_notifications"]["Row"]>;
        Relationships: [];
      };
      message_attachments: {
        Row: {
          id: string;
          message_id: string;
          object_key: string;
          filename: string | null;
          content_type: string;
          size_bytes: number;
          twilio_media_sid: string | null;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["message_attachments"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["message_attachments"]["Row"]>;
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
      csr_compliance_alerts: {
        Row: {
          id: string;
          patient_id: string;
          journey_id: string | null;
          alert_type:
            | "low_usage"
            | "no_response"
            | "send_failure"
            | "manual"
            | "prior_auth_expiring"
            | "prior_auth_expired"
            | "pa_mco_sla_at_risk"
            | "pa_mco_sla_missed";
          severity: "info" | "warning" | "critical";
          summary: string;
          metric_snapshot: Record<string, unknown> | null;
          status: "open" | "snoozed" | "resolved";
          snoozed_until: string | null;
          resolved_at: string | null;
          resolved_by_email: string | null;
          resolved_by_user_id: string | null;
          resolution_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["csr_compliance_alerts"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["csr_compliance_alerts"]["Row"]>;
        Relationships: [];
      };
      shop_customer_message_template_overrides: {
        Row: {
          id: string;
          customer_id: string;
          template_key: string;
          channel: string;
          subject: string | null;
          body_html: string | null;
          body_text: string | null;
          is_active: boolean;
          note: string | null;
          created_by: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_customer_message_template_overrides"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_customer_message_template_overrides"]["Row"]>;
        Relationships: [];
      };
      message_templates: {
        Row: {
          id: string;
          template_key: string;
          channel: string;
          subject: string | null;
          body_html: string | null;
          body_text: string;
          allowed_variables: string[];
          is_active: boolean;
          updated_at: string;
          updated_by: string | null;
          created_at: string;
          created_by: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["message_templates"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["message_templates"]["Row"]>;
        Relationships: [];
      };
      patient_integration_snapshots: {
        Row: {
          id: string;
          patient_id: string;
          source: string;
          partner_patient_id: string;
          payload: unknown;
          fetch_status: string;
          fetch_error: string | null;
          fetched_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_integration_snapshots"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_integration_snapshots"]["Row"]>;
        Relationships: [];
      };
      patient_therapy_links: {
        Row: {
          id: string;
          patient_id: string;
          source: string;
          partner_patient_id: string;
          device_serial: string | null;
          status: string;
          last_synced_at: string | null;
          last_sync_status: string | null;
          last_sync_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_therapy_links"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_therapy_links"]["Row"]>;
        Relationships: [];
      };
      patient_therapy_nights: {
        Row: {
          id: string;
          patient_id: string;
          night_date: string;
          source: string;
          source_event_id: string | null;
          usage_minutes: number | null;
          ahi: string | null;
          leak_rate_l_min: string | null;
          pressure_p95_cmh2o: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_therapy_nights"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_therapy_nights"]["Row"]>;
        Relationships: [];
      };
      patient_onboarding_journeys: {
        Row: {
          id: string;
          patient_id: string;
          started_at: string;
          day1_sent_at: string | null;
          day3_sent_at: string | null;
          day7_sent_at: string | null;
          day30_sent_at: string | null;
          day60_sent_at: string | null;
          day90_sent_at: string | null;
          status: "active" | "completed" | "paused";
          enrolled_by_email: string;
          enrolled_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["patient_onboarding_journeys"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["patient_onboarding_journeys"]["Row"]>;
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
          provider_id: string | null;
          item_sku: string;
          hcpcs_code: string | null;
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
      providers: {
        Row: {
          id: string;
          npi: string;
          legal_name: string;
          taxonomy_code: string | null;
          phone_e164: string | null;
          fax_e164: string | null;
          email: string | null;
          practice_address: Json | null;
          practice_name: string | null;
          source: "nppes" | "csr_entry" | "backfill";
          verified_at: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["providers"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["providers"]["Row"]>;
        Relationships: [];
      };
      sleep_studies: {
        Row: {
          id: string;
          patient_id: string;
          study_date: string;
          study_type: "psg" | "hsat" | "split_night" | "re_titration";
          ahi: string;
          rdi: string | null;
          lowest_spo2_pct: number | null;
          sleep_efficiency_pct: number | null;
          diagnosis_icd10: string | null;
          // Provenance of the diagnosis (migration 0139). Distinguishes
          // lab-supplied codes from AI-suggested + CSR-accepted ones.
          diagnosis_source:
            | "lab_report"
            | "csr_entry"
            | "ai_suggested"
            | "ai_accepted"
            | "imported"
            | null;
          diagnosis_ai_confidence: number | null;
          diagnosis_ai_model: string | null;
          diagnosis_ai_suggested_at: string | null;
          interpreting_provider_id: string | null;
          facility_name: string | null;
          source: "external_lab" | "home_test_vendor" | "csr_entry";
          document_id: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["sleep_studies"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["sleep_studies"]["Row"]>;
        Relationships: [];
      };
      insurance_coverages: {
        Row: {
          id: string;
          patient_id: string;
          rank: "primary" | "secondary" | "tertiary";
          payer_name: string;
          plan_name: string | null;
          member_id: string;
          group_number: string | null;
          policyholder_name: string | null;
          policyholder_relationship:
            | "self"
            | "spouse"
            | "child"
            | "other"
            | null;
          effective_date: string | null;
          termination_date: string | null;
          in_network: boolean | null;
          deductible_cents: number | null;
          deductible_met_cents: number | null;
          oop_max_cents: number | null;
          copay_cents: number | null;
          capped_rental_status:
            | "rental_month_1_to_3"
            | "rental_month_4_to_13"
            | "purchased"
            | "not_applicable"
            | null;
          verified_at: string | null;
          verified_by_user_id: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["insurance_coverages"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["insurance_coverages"]["Row"]
        >;
        Relationships: [];
      };
      prior_authorizations: {
        Row: {
          id: string;
          patient_id: string;
          insurance_coverage_id: string | null;
          hcpcs_code: string;
          payer_name: string;
          auth_number: string | null;
          status:
            | "draft"
            | "submitted"
            | "approved"
            | "denied"
            | "appealed"
            | "expired";
          requested_at: string | null;
          submitted_at: string | null;
          decision_at: string | null;
          approved_through: string | null;
          denial_reason: string | null;
          document_id: string | null;
          notes: string | null;
          // PA Medicaid 7-day SLA tracking (migration 0133).
          mco_sla_target_date: string | null;
          mco_sla_status:
            | "on_track"
            | "at_risk"
            | "missed"
            | "decided"
            | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["prior_authorizations"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["prior_authorizations"]["Row"]
        >;
        Relationships: [];
      };
      insurance_claims: {
        Row: {
          id: string;
          patient_id: string;
          insurance_coverage_id: string | null;
          payer_name: string;
          claim_number: string | null;
          date_of_service: string;
          fulfillment_id: string | null;
          status:
            | "draft"
            | "submitted"
            | "accepted"
            | "denied"
            | "paid"
            | "appealed"
            | "closed";
          total_billed_cents: number;
          total_allowed_cents: number;
          total_paid_cents: number;
          patient_responsibility_cents: number;
          submitted_at: string | null;
          decision_at: string | null;
          paid_at: string | null;
          denial_reason: string | null;
          notes: string | null;
          // Soft FK to resupply.payer_profiles (migration 0128). Null on
          // legacy rows captured before the catalog landed; the claim
          // builder requires it before electronic submission.
          payer_profile_id: string | null;
          // Soft FK to resupply.office_ally_submissions (migration 0128).
          // Set when the claim is included in a 837P batch upload.
          office_ally_submission_id: string | null;
          // Heuristic predicted-denial scoring (migration 0133).
          predicted_denial_probability: number | null;
          predicted_denial_factors: Json;
          predicted_denial_scored_at: string | null;
          // Soft FK to resupply.providers (migration 0129). Rendering
          // provider — the entity that actually rendered the service.
          // For DME this is usually our org, but Medicare expects the
          // NPI to be present in 837P loop 2310B.
          rendering_provider_id: string | null;
          // Soft FK to resupply.providers (migration 0129). Referring /
          // ordering / prescribing physician — required by Medicare DME
          // (loop 2310D) and most commercial DME payers.
          referring_provider_id: string | null;
          // Soft FK to resupply.insurance_coverages (migration 0129).
          // Drives the 837P loop 2320/2330 coordination-of-benefits
          // submission when set.
          secondary_coverage_id: string | null;
          // Denormalised AI scrub status (migration 0131). Updated
          // every time an AI scrub completes so the CSR queue can
          // filter on it without joining claim_scrub_results.
          latest_scrub_verdict:
            | "ready"
            | "fixable"
            | "blocking"
            | "errored"
            | null;
          latest_scrub_at: string | null;
          latest_scrub_result_id: string | null;
          // Pointer to the most recent denial analysis (migration 0131).
          latest_denial_analysis_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["insurance_claims"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["insurance_claims"]["Row"]
        >;
        Relationships: [];
      };
      insurance_claim_line_items: {
        Row: {
          id: string;
          claim_id: string;
          hcpcs_code: string;
          modifier: string | null;
          description: string | null;
          quantity: number;
          billed_cents: number;
          allowed_cents: number;
          paid_cents: number;
          status: "pending" | "accepted" | "denied" | "paid";
          denial_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["insurance_claim_line_items"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["insurance_claim_line_items"]["Row"]
        >;
        Relationships: [];
      };
      insurance_claim_events: {
        Row: {
          id: string;
          claim_id: string;
          event_type:
            | "submitted"
            | "accepted"
            | "denied"
            | "partial_pay"
            | "paid"
            | "appealed"
            | "closed"
            | "note";
          amount_cents: number | null;
          payer_ref: string | null;
          document_id: string | null;
          note: string | null;
          actor_email: string;
          occurred_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["insurance_claim_events"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["insurance_claim_events"]["Row"]
        >;
        Relationships: [];
      };
      payer_profiles: {
        Row: {
          id: string;
          slug: string;
          display_name: string;
          payer_legal_name: string;
          parent_org: string | null;
          line_of_business:
            | "commercial"
            | "medicare_advantage"
            | "medicare_part_b"
            | "medicaid_ffs"
            | "medicaid_mco"
            | "federal"
            | "workers_comp"
            | "other";
          region: "pa" | "multi_state" | "national";
          office_ally_payer_id: string | null;
          edi_5010_payer_id: string | null;
          claim_format: "837p" | "837i" | "paper_1500";
          paper_only: boolean;
          requires_prior_auth_dme: boolean;
          prior_auth_phone_e164: string | null;
          claim_status_phone_e164: string | null;
          provider_portal_url: string | null;
          fee_schedule_source: string | null;
          notes: string | null;
          is_active: boolean;
          // Da Vinci PAS endpoint URL (CMS-0057-F). Null when the
          // payer hasn't stood up a FHIR PAS server yet. (Migration 0136)
          davinci_pas_endpoint_url: string | null;
          // Submission-readiness columns added by migration 0149. See
          // 0149_pa_payers_phase2.sql for the per-column rationale —
          // briefly, these are the fields the OA-enrollment CSV
          // exports and the admin edit drawer surfaces so an op can
          // submit a clean claim without grepping `notes`.
          timely_filing_days: number | null;
          claims_address_line1: string | null;
          claims_address_line2: string | null;
          claims_city: string | null;
          claims_state: string | null;
          claims_zip: string | null;
          claims_phone_e164: string | null;
          claims_fax_e164: string | null;
          prior_auth_submission_method:
            | "portal"
            | "fax"
            | "phone"
            | "electronic_278"
            | "paper"
            | "none"
            | null;
          prior_auth_fax_e164: string | null;
          prior_auth_turnaround_business_days: number | null;
          required_claim_modifiers: string[];
          accepts_electronic_secondary: boolean;
          edi_enrollment_status:
            | "enrolled"
            | "pending"
            | "not_enrolled"
            | "not_applicable";
          member_id_format_hint: string | null;
          requirements_last_verified_at: string | null;
          requirements_last_verified_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["payer_profiles"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["payer_profiles"]["Row"]>;
        Relationships: [];
      };
      denial_codes: {
        Row: {
          id: string;
          code_system: "carc" | "rarc" | "custom";
          code: string;
          description: string;
          category:
            | "eligibility"
            | "authorization"
            | "documentation"
            | "medical_necessity"
            | "duplicate"
            | "coverage_limit"
            | "coding"
            | "cob"
            | "patient_liability"
            | "timely_filing"
            | "other";
          recommended_action: string | null;
          is_terminal: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["denial_codes"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["denial_codes"]["Row"]>;
        Relationships: [];
      };
      payer_fee_schedules: {
        Row: {
          id: string;
          payer_profile_id: string;
          hcpcs_code: string;
          modifier: string | null;
          allowed_cents: number;
          effective_from: string;
          effective_through: string | null;
          source: "manual" | "cms_published" | "payer_published" | "observed";
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["payer_fee_schedules"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["payer_fee_schedules"]["Row"]
        >;
        Relationships: [];
      };
      eligibility_checks: {
        Row: {
          id: string;
          insurance_coverage_id: string;
          patient_id: string;
          payer_profile_id: string | null;
          service_hcpcs: string | null;
          isa_control_number: string | null;
          gs_control_number: string | null;
          outbound_file_name: string | null;
          status:
            | "queued"
            | "submitted"
            | "parsed"
            | "rejected"
            | "transport_failed";
          is_active: boolean | null;
          in_network: boolean | null;
          deductible_cents: number | null;
          deductible_met_cents: number | null;
          oop_max_cents: number | null;
          oop_met_cents: number | null;
          copay_cents: number | null;
          coinsurance_pct: number | null;
          requires_prior_auth: boolean | null;
          parsed_response_json: Json | null;
          error_message: string | null;
          requested_at: string;
          responded_at: string | null;
          requested_by_email: string;
          applied_to_inbound_file_id: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["eligibility_checks"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["eligibility_checks"]["Row"]
        >;
        Relationships: [];
      };
      medicare_same_or_similar_checks: {
        Row: {
          id: string;
          patient_id: string;
          hcpcs_code: string;
          last_dispense_on: string | null;
          status: "clear" | "inactive" | "active" | "unknown";
          raw_response_json: Json | null;
          checked_at: string;
          requested_by_email: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["medicare_same_or_similar_checks"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["medicare_same_or_similar_checks"]["Row"]
        >;
        Relationships: [];
      };
      capped_rental_cycles: {
        Row: {
          id: string;
          patient_id: string;
          hcpcs_code: string;
          payer_profile_id: string | null;
          insurance_coverage_id: string | null;
          start_date: string;
          current_month: number;
          max_months: number;
          ownership_transferred_on: string | null;
          status: "active" | "paused" | "transferred" | "cancelled";
          latest_claim_id: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["capped_rental_cycles"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["capped_rental_cycles"]["Row"]
        >;
        Relationships: [];
      };
      dwo_documents: {
        Row: {
          id: string;
          patient_id: string;
          hcpcs_family:
            | "pap"
            | "rad"
            | "oxygen"
            | "hospital_bed"
            | "wheelchair"
            | "other";
          form_type: "dwo" | "cmn_484" | "cmn_843" | "swo";
          signing_provider_id: string | null;
          signed_on: string;
          expires_on: string;
          document_object_key: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["dwo_documents"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["dwo_documents"]["Row"]
        >;
        Relationships: [];
      };
      adherence_predictions: {
        Row: {
          id: string;
          patient_id: string;
          model_version: string;
          days_of_therapy: number;
          probability_compliant: number;
          factors_json: Json;
          actual_compliant: boolean | null;
          outcome_observed_at: string | null;
          scored_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["adherence_predictions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["adherence_predictions"]["Row"]
        >;
        Relationships: [];
      };
      voice_reorder_sessions: {
        Row: {
          id: string;
          twilio_call_sid: string;
          from_e164: string;
          patient_id: string | null;
          shop_customer_id: string | null;
          status:
            | "in_progress"
            | "completed_order"
            | "completed_no_order"
            | "patient_not_identified"
            | "transferred_to_human"
            | "failed";
          outcome_json: Json;
          started_at: string;
          ended_at: string | null;
          shop_order_id: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["voice_reorder_sessions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["voice_reorder_sessions"]["Row"]
        >;
        Relationships: [];
      };
      davinci_pas_submissions: {
        Row: {
          id: string;
          prior_authorization_id: string;
          payer_pas_endpoint: string;
          bundle_id: string;
          claim_identifier: string;
          transport_status:
            | "queued"
            | "submitted"
            | "responded"
            | "rejected"
            | "transport_failed";
          decision: "approved" | "denied" | "pended" | "cancelled" | null;
          auth_number: string | null;
          decision_at: string | null;
          denial_reason: string | null;
          latency_ms: number | null;
          error_message: string | null;
          requested_at: string;
          responded_at: string | null;
          submitted_by_email: string;
          request_bundle_json: Json | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["davinci_pas_submissions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["davinci_pas_submissions"]["Row"]
        >;
        Relationships: [];
      };
      webhook_subscriptions: {
        Row: {
          id: string;
          name: string;
          target_url: string;
          signing_secret: string;
          event_types: string[];
          is_active: boolean;
          max_retries: number;
          last_delivery_at: string | null;
          last_delivery_status: "delivered" | "failed" | "exhausted" | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["webhook_subscriptions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["webhook_subscriptions"]["Row"]
        >;
        Relationships: [];
      };
      webhook_deliveries: {
        Row: {
          id: string;
          subscription_id: string;
          event_type: string;
          event_payload: Json;
          status: "queued" | "delivered" | "failed" | "exhausted";
          attempt_count: number;
          last_http_status: number | null;
          last_error: string | null;
          next_attempt_at: string;
          delivered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["webhook_deliveries"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["webhook_deliveries"]["Row"]
        >;
        Relationships: [];
      };
      patient_billing_statements: {
        Row: {
          id: string;
          patient_id: string;
          line_items_json: Json;
          total_patient_responsibility_cents: number;
          statement_pdf_object_key: string | null;
          delivery_method: "email" | "sms" | "mail" | "in_person" | null;
          delivered_at: string | null;
          generated_by_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_billing_statements"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_billing_statements"]["Row"]
        >;
        Relationships: [];
      };
      claim_appeal_letters: {
        Row: {
          id: string;
          claim_id: string;
          denial_analysis_id: string | null;
          letter_body: string;
          appeal_pdf_object_key: string | null;
          delivery_method:
            | "fax"
            | "mail"
            | "portal_upload"
            | "email"
            | null;
          delivered_at: string | null;
          generated_by_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["claim_appeal_letters"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["claim_appeal_letters"]["Row"]
        >;
        Relationships: [];
      };
      dispense_readiness_reviews: {
        Row: {
          id: string;
          patient_id: string;
          hcpcs_code: string;
          fulfillment_id: string | null;
          payer_profile_id: string | null;
          insurance_coverage_id: string | null;
          ready_to_dispense: boolean;
          overall_verdict:
            | "ready"
            | "gaps_with_fixable"
            | "gaps_with_blocking"
            | "errored";
          estimated_days_to_ready: number | null;
          deterministic_findings_json: Json;
          checks_total: number;
          checks_passed: number;
          checks_warning: number;
          checks_failed: number;
          ai_summary: string | null;
          ai_action_plan_json: Json | null;
          ai_model: string | null;
          ai_prompt_version: string | null;
          ai_confidence: number | null;
          ai_latency_ms: number | null;
          ai_prompt_tokens: number | null;
          ai_completion_tokens: number | null;
          ai_error_message: string | null;
          review_status:
            | "pending"
            | "acknowledged"
            | "remediated"
            | "overridden"
            | "cancelled";
          reviewed_by_email: string | null;
          reviewed_at: string | null;
          created_by_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["dispense_readiness_reviews"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["dispense_readiness_reviews"]["Row"]
        >;
        Relationships: [];
      };
      hipaa_breach_incidents: {
        Row: {
          id: string;
          slug: string;
          title: string;
          description: string;
          status:
            | "under_investigation"
            | "not_a_breach"
            | "confirmed_breach"
            | "resolved";
          kind:
            | "lost_device"
            | "misdirected_fax"
            | "misdirected_email"
            | "unauthorized_access"
            | "phishing"
            | "malware"
            | "business_associate"
            | "mailing_error"
            | "paper_disposal"
            | "other";
          severity: "low" | "moderate" | "high" | "critical";
          individuals_affected: number | null;
          media_notification_required: boolean;
          risk_assessment: string | null;
          mitigation: string | null;
          discovered_at: string;
          individuals_notified_at: string | null;
          hhs_notified_at: string | null;
          media_notified_at: string | null;
          resolved_at: string | null;
          affected_systems: string[];
          owner_email: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["hipaa_breach_incidents"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["hipaa_breach_incidents"]["Row"]
        >;
        Relationships: [];
      };
      patient_payments: {
        Row: {
          id: string;
          patient_id: string;
          stripe_payment_intent_id: string | null;
          amount_cents: number;
          currency: string;
          status:
            | "pending"
            | "requires_action"
            | "succeeded"
            | "failed"
            | "cancelled"
            | "refunded";
          applied_claims_json: Json;
          source: "portal" | "csr" | "mail_in_check" | "external";
          note: string | null;
          failure_reason: string | null;
          succeeded_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_payments"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_payments"]["Row"]
        >;
        Relationships: [];
      };
      inbound_webhooks: {
        Row: {
          id: string;
          source: string;
          source_event_type: string | null;
          payload_json: Json;
          verification_headers_json: Json | null;
          signature_verified: boolean;
          dedupe_key: string;
          status:
            | "received"
            | "processed"
            | "duplicate"
            | "processing_failed"
            | "rejected";
          processing_error: string | null;
          processing_attempts: number;
          received_at: string;
          processed_at: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_webhooks"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_webhooks"]["Row"]
        >;
        Relationships: [];
      };
      inbound_referral_orders: {
        Row: {
          id: string;
          source: string;
          source_order_id: string;
          inbound_webhook_id: string | null;
          patient_match_id: string | null;
          patient_match_kind: string | null;
          provider_match_id: string | null;
          provider_match_kind: string | null;
          payer_name: string | null;
          ordering_npi: string | null;
          hcpcs_items_json: Json;
          icd10_codes_json: Json;
          raw_parsed_json: Json;
          ai_classification_json: Json | null;
          ai_confidence: number | null;
          triage_status:
            | "new"
            | "triaged"
            | "accepted"
            | "rejected"
            | "duplicate"
            | "archived";
          assigned_admin_user_id: string | null;
          triaged_at: string | null;
          triaged_by_user_id: string | null;
          accepted_order_id: string | null;
          accepted_order_kind: string | null;
          accepted_at: string | null;
          accepted_by_user_id: string | null;
          notes: string | null;
          received_at: string;
          created_at: string;
          updated_at: string;
          preflight_completed_at: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_referral_orders"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_referral_orders"]["Row"]
        >;
        Relationships: [];
      };
      inbound_referral_documents: {
        Row: {
          id: string;
          referral_id: string;
          doc_kind: string;
          source_filename: string | null;
          content_type: string | null;
          size_bytes: number | null;
          object_key: string | null;
          source_url: string | null;
          source_document_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_referral_documents"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_referral_documents"]["Row"]
        >;
        Relationships: [];
      };
      inbound_referral_preflight_checks: {
        Row: {
          id: string;
          referral_id: string;
          check_kind: string;
          outcome_json: Json;
          outcome_status: "info" | "ok" | "warn" | "error" | "skipped";
          produced_row_table: string | null;
          produced_row_id: string | null;
          ran_by: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_referral_preflight_checks"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_referral_preflight_checks"]["Row"]
        >;
        Relationships: [];
      };
      ehr_fhir_tenants: {
        Row: {
          id: string;
          slug: string;
          display_name: string;
          jwks_uri: string;
          audience: string;
          expected_issuer: string;
          expected_subject: string;
          is_active: boolean;
          notes: string | null;
          callback_url: string | null;
          outbound_signing_secret: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["ehr_fhir_tenants"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["ehr_fhir_tenants"]["Row"]
        >;
        Relationships: [];
      };
      inbound_referral_status_outbox: {
        Row: {
          id: string;
          referral_id: string;
          target_kind: "parachute" | "ehr_fhir";
          event_type: string;
          payload_json: Json;
          status: "queued" | "delivered" | "failed" | "exhausted";
          attempt_count: number;
          last_http_status: number | null;
          last_error: string | null;
          next_attempt_at: string;
          delivered_at: string | null;
          max_retries: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_referral_status_outbox"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_referral_status_outbox"]["Row"]
        >;
        Relationships: [];
      };
      documentation_packets: {
        Row: {
          id: string;
          patient_id: string;
          kind:
            | "prior_auth_support"
            | "appeal_support"
            | "accreditation_audit"
            | "medical_records_request";
          included_docs_json: Json;
          pdf_object_key: string | null;
          page_count: number | null;
          notes: string | null;
          generated_by_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["documentation_packets"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["documentation_packets"]["Row"]
        >;
        Relationships: [];
      };
      providers_pecos_status: {
        Row: {
          npi: string;
          enrollment_status:
            | "approved"
            | "pending"
            | "denied"
            | "revoked"
            | "opted_out"
            | "unknown";
          enrollment_type: string | null;
          first_approved_date: string | null;
          specialty_description: string | null;
          last_synced_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["providers_pecos_status"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["providers_pecos_status"]["Row"]
        >;
        Relationships: [];
      };
      good_faith_estimates: {
        Row: {
          id: string;
          customer_id: string | null;
          recipient_name: string;
          recipient_email: string;
          items_json: Json;
          total_cents: number;
          expected_service_date: string | null;
          pdf_object_key: string | null;
          disclaimer_text: string;
          generated_by_email: string;
          delivered_at: string | null;
          delivery_method: "email" | "sms" | "in_person" | "mail" | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["good_faith_estimates"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["good_faith_estimates"]["Row"]
        >;
        Relationships: [];
      };
      accreditation_surveys: {
        Row: {
          id: string;
          organization_id: string;
          accreditation_body: "achc" | "boc" | "tjc" | "cap" | "other";
          survey_type:
            | "initial"
            | "renewal"
            | "annual_unannounced"
            | "change_of_ownership"
            | "complaint_driven"
            | "projected";
          scheduled_for: string | null;
          completed_on: string | null;
          outcome:
            | "passed"
            | "passed_with_findings"
            | "failed"
            | "pending"
            | null;
          findings_count: number;
          corrective_action_due_on: string | null;
          corrective_action_completed_on: string | null;
          surveyor_name: string | null;
          report_document_object_key: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["accreditation_surveys"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["accreditation_surveys"]["Row"]
        >;
        Relationships: [];
      };
      accreditation_readiness_runs: {
        Row: {
          id: string;
          organization_id: string;
          started_at: string;
          completed_at: string | null;
          overall_status: "ready" | "gaps" | "blocking" | "errored" | null;
          checks_total: number;
          checks_passed: number;
          checks_warning: number;
          checks_failed: number;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["accreditation_readiness_runs"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["accreditation_readiness_runs"]["Row"]
        >;
        Relationships: [];
      };
      accreditation_readiness_findings: {
        Row: {
          id: string;
          run_id: string;
          check_key: string;
          category:
            | "training"
            | "policy_attestation"
            | "patient_documents"
            | "grievances"
            | "equipment_maintenance"
            | "audit_log"
            | "mfa"
            | "identity"
            | "license_expiry";
          severity: "ok" | "warning" | "error";
          label: string;
          detail: string;
          target_table: string | null;
          target_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["accreditation_readiness_findings"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["accreditation_readiness_findings"]["Row"]
        >;
        Relationships: [];
      };
      dme_organization: {
        Row: {
          id: string;
          singleton: boolean;
          legal_name: string;
          dba_name: string | null;
          tax_id: string;
          organizational_npi: string;
          taxonomy_code: string;
          medicare_ptan: string | null;
          physical_address_line1: string;
          physical_address_line2: string | null;
          physical_city: string;
          physical_state: string;
          physical_zip: string;
          mailing_address_line1: string | null;
          mailing_address_line2: string | null;
          mailing_city: string | null;
          mailing_state: string | null;
          mailing_zip: string | null;
          pay_to_address_line1: string | null;
          pay_to_address_line2: string | null;
          pay_to_city: string | null;
          pay_to_state: string | null;
          pay_to_zip: string | null;
          phone_e164: string;
          fax_e164: string | null;
          billing_email: string;
          general_email: string | null;
          website_url: string | null;
          accreditation_body: "achc" | "boc" | "tjc" | "cap" | "other" | null;
          accreditation_number: string | null;
          accreditation_expires_on: string | null;
          state_license_number: string | null;
          state_license_state: string | null;
          state_license_expires_on: string | null;
          liability_carrier: string | null;
          liability_policy_number: string | null;
          liability_expires_on: string | null;
          surety_bond_carrier: string | null;
          surety_bond_amount_cents: number | null;
          surety_bond_expires_on: string | null;
          authorized_signer_name: string | null;
          authorized_signer_title: string | null;
          authorized_signer_signature_object_key: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["dme_organization"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["dme_organization"]["Row"]
        >;
        Relationships: [];
      };
      dme_organization_contacts: {
        Row: {
          id: string;
          organization_id: string;
          role:
            | "billing_manager"
            | "compliance_officer"
            | "authorized_signer"
            | "medical_director"
            | "office_manager"
            | "edi_contact"
            | "credentialing"
            | "patient_advocate"
            | "other";
          name: string;
          title: string | null;
          email: string | null;
          phone_e164: string | null;
          is_primary: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["dme_organization_contacts"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["dme_organization_contacts"]["Row"]
        >;
        Relationships: [];
      };
      clearinghouse_credentials: {
        Row: {
          id: string;
          slug: string;
          display_name: string;
          usage_indicator: "P" | "T";
          sftp_host: string;
          sftp_port: number;
          sftp_username: string;
          private_key_path: string;
          known_hosts_path: string;
          remote_inbox_dir: string;
          remote_outbound_dir: string;
          remote_archive_dir: string | null;
          etin: string;
          submitter_organization_name: string | null;
          contact_name: string | null;
          contact_phone_e164: string | null;
          is_active: boolean;
          last_polled_at: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["clearinghouse_credentials"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["clearinghouse_credentials"]["Row"]
        >;
        Relationships: [];
      };
      clearinghouse_inbound_files: {
        Row: {
          id: string;
          clearinghouse_id: string;
          remote_path: string;
          file_name: string;
          file_sha256: string;
          file_size_bytes: number;
          file_kind: "999" | "277ca" | "835" | "271" | "unknown";
          parse_summary_json: Json;
          dispatch_status:
            | "pending"
            | "parsed"
            | "dispatched"
            | "dispatch_failed"
            | "skipped";
          applied_to_era_file_id: string | null;
          applied_to_submission_id: string | null;
          error_message: string | null;
          downloaded_at: string;
          dispatched_at: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["clearinghouse_inbound_files"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["clearinghouse_inbound_files"]["Row"]
        >;
        Relationships: [];
      };
      era_files: {
        Row: {
          id: string;
          file_name: string;
          file_sha256: string;
          file_size_bytes: number;
          payer_check_number: string | null;
          payer_paid_date: string | null;
          total_paid_cents: number;
          claims_paid_count: number;
          claims_denied_count: number;
          lines_processed_count: number;
          matched_submission_id: string | null;
          status: "processed" | "parse_failed" | "partial" | "rejected";
          rejection_reason: string | null;
          ingested_by_email: string;
          ingested_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["era_files"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["era_files"]["Row"]>;
        Relationships: [];
      };
      product_hcpcs_map: {
        Row: {
          id: string;
          lookup_kind: "stripe_product_id" | "item_sku";
          lookup_value: string;
          hcpcs_code: string;
          default_modifiers: string | null;
          units_per_dispense: number;
          default_billed_cents: number | null;
          description: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["product_hcpcs_map"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["product_hcpcs_map"]["Row"]
        >;
        Relationships: [];
      };
      payer_modifier_rules: {
        Row: {
          id: string;
          payer_profile_id: string;
          hcpcs_code: string;
          condition:
            | "always"
            | "if_rental_month_le_3"
            | "if_rental_month_ge_4"
            | "if_purchased"
            | "if_compliant_90day"
            | "if_initial_dispense"
            | "if_abn_on_file"
            | "if_pa_approved";
          modifiers_csv: string;
          priority: number;
          rationale: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"]
        >;
        Relationships: [];
      };
      claim_scrub_results: {
        Row: {
          id: string;
          claim_id: string;
          verdict: "ready" | "fixable" | "blocking" | "errored";
          model: string;
          prompt_version: string;
          confidence: number | null;
          findings_json: Json;
          suggested_patches_json: Json;
          review_status: "pending" | "accepted" | "rejected" | "auto_applied";
          reviewed_by_email: string | null;
          reviewed_at: string | null;
          applied_patches_log: Json | null;
          applied_at: string | null;
          latency_ms: number | null;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          error_message: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["claim_scrub_results"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["claim_scrub_results"]["Row"]
        >;
        Relationships: [];
      };
      claim_denial_analyses: {
        Row: {
          id: string;
          claim_id: string;
          era_file_id: string | null;
          model: string;
          prompt_version: string;
          confidence: number | null;
          root_cause_summary: string;
          recommendation:
            | "auto_resubmit"
            | "manual_resubmit"
            | "appeal"
            | "bill_patient"
            | "write_off"
            | "manual_review";
          analysis_json: Json;
          suggested_patches_json: Json;
          can_auto_resubmit: boolean;
          review_status:
            | "pending"
            | "accepted_resubmitted"
            | "accepted_appealed"
            | "accepted_written_off"
            | "rejected"
            | "errored";
          reviewed_by_email: string | null;
          reviewed_at: string | null;
          applied_at: string | null;
          resubmit_office_ally_submission_id: string | null;
          latency_ms: number | null;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          error_message: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["claim_denial_analyses"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["claim_denial_analyses"]["Row"]
        >;
        Relationships: [];
      };
      claim_templates: {
        Row: {
          id: string;
          slug: string;
          display_name: string;
          description: string | null;
          lines_json: { lines: TemplateLine[] };
          default_diagnosis_codes: string[];
          scoped_payer_profile_id: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["claim_templates"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["claim_templates"]["Row"]
        >;
        Relationships: [];
      };
      office_ally_submissions: {
        Row: {
          id: string;
          file_name: string;
          isa_control_number: string;
          gs_control_number: string;
          status:
            | "queued"
            | "uploaded"
            | "accepted_999"
            | "rejected_999"
            | "accepted_277ca"
            | "rejected_277ca"
            | "transport_failed";
          file_size_bytes: number;
          claim_count: number;
          office_ally_session_id: string | null;
          ack_999_file_name: string | null;
          ack_999_received_at: string | null;
          ack_277ca_file_name: string | null;
          ack_277ca_received_at: string | null;
          rejection_reason: string | null;
          submitted_by_email: string;
          submitted_at: string;
          updated_at: string;
          // ── 0150 columns ──
          // Claim IDs the batch *tried* to send. Populated regardless of
          // upload outcome so a failed batch can be resubmitted without
          // rebuilding the list. Empty array on legacy rows.
          attempted_claim_ids: string[];
          // Soft self-FK; non-null on resubmit rows pointing at the
          // submission this one re-attempts.
          parent_submission_id: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["office_ally_submissions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["office_ally_submissions"]["Row"]
        >;
        Relationships: [];
      };
      inbound_faxes: {
        Row: {
          id: string;
          twilio_fax_sid: string;
          from_e164: string | null;
          to_e164: string | null;
          received_at: string;
          num_pages: number | null;
          media_object_key: string | null;
          media_content_type: string | null;
          media_size_bytes: number | null;
          status: "new" | "triaged" | "attached" | "archived";
          attached_patient_id: string | null;
          attached_provider_id: string | null;
          attached_prescription_id: string | null;
          attached_document_type: string | null;
          assigned_admin_user_id: string | null;
          triaged_at: string | null;
          triaged_by_user_id: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["inbound_faxes"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["inbound_faxes"]["Row"]
        >;
        Relationships: [];
      };
      equipment_assets: {
        Row: {
          id: string;
          patient_id: string;
          prescription_id: string | null;
          device_class:
            | "cpap"
            | "auto_cpap"
            | "bipap"
            | "asv"
            | "avaps"
            | "humidifier"
            | "oximeter"
            | "other";
          manufacturer: string;
          model: string;
          serial_number: string;
          pressure_setting: string | null;
          humidifier_setting: string | null;
          status: "active" | "returned" | "recalled" | "retired";
          dispensed_at: string | null;
          dispensing_note: string | null;
          recall_id: string | null;
          metadata: Json | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["equipment_assets"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["equipment_assets"]["Row"]
        >;
        Relationships: [];
      };
      equipment_recalls: {
        Row: {
          id: string;
          recall_reference: string;
          title: string;
          manufacturer: string;
          model_match: string | null;
          serial_match: Json | null;
          severity: "urgent" | "priority" | "advisory";
          status: "active" | "closed";
          issued_at: string | null;
          deadline_at: string | null;
          reference_url: string | null;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["equipment_recalls"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["equipment_recalls"]["Row"]
        >;
        Relationships: [];
      };
      recall_notifications: {
        Row: {
          id: string;
          recall_id: string;
          asset_id: string;
          patient_id: string;
          status: "queued" | "sent" | "failed" | "bounced" | "skipped";
          channel: "email" | "sms" | "letter" | null;
          notified_at: string | null;
          failed_at: string | null;
          failed_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["recall_notifications"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["recall_notifications"]["Row"]
        >;
        Relationships: [];
      };
      recall_remediation_actions: {
        Row: {
          id: string;
          recall_id: string;
          asset_id: string;
          action:
            | "returned_to_manufacturer"
            | "destroyed"
            | "replaced"
            | "patient_declined"
            | "lost"
            | "unreachable";
          evidence_url: string | null;
          notes: string | null;
          performed_by_user_id: string | null;
          performed_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["recall_remediation_actions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["recall_remediation_actions"]["Row"]
        >;
        Relationships: [];
      };
      staff_training_records: {
        Row: {
          id: string;
          staff_user_id: string;
          training_type:
            | "hipaa_privacy"
            | "hipaa_security"
            | "osha_bloodborne"
            | "osha_general"
            | "infection_control"
            | "fit_test"
            | "new_hire_orientation"
            | "dmepos_supplier_stds"
            | "other";
          course_title: string | null;
          completed_at: string;
          expires_at: string | null;
          credit_hours: string | null;
          provider: string | null;
          certificate_reference: string | null;
          evidence_object_key: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["staff_training_records"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["staff_training_records"]["Row"]
        >;
        Relationships: [];
      };
      patient_grievances: {
        Row: {
          id: string;
          patient_id: string;
          equipment_asset_id: string | null;
          kind: "complaint" | "grievance" | "adverse_event";
          severity: "low" | "moderate" | "high";
          source:
            | "phone"
            | "email"
            | "sms"
            | "in_person"
            | "letter"
            | "portal"
            | "other";
          summary: string;
          description: string | null;
          received_at: string;
          status:
            | "open"
            | "acknowledged"
            | "escalated"
            | "resolved"
            | "reopened";
          acknowledged_at: string | null;
          acknowledged_by_user_id: string | null;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by_user_id: string | null;
          reported_to_fda: "yes" | "no" | "not_applicable";
          fda_report_reference: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_grievances"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_grievances"]["Row"]
        >;
        Relationships: [];
      };
      bulk_campaigns: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          audience_kind:
            | "all_active_shop_customers"
            | "all_active_patients"
            | "by_patient_payer"
            | "manual_list";
          audience_payer: string | null;
          channel: "email";
          category: "marketing" | "service" | "compliance";
          compliance_attestation: string | null;
          template_key: string;
          throttle_per_minute: number;
          status:
            | "draft"
            | "sending"
            | "sent"
            | "paused"
            | "cancelled";
          started_at: string | null;
          completed_at: string | null;
          cancelled_at: string | null;
          created_by_user_id: string | null;
          cancelled_by_user_id: string | null;
          total_recipients: number;
          suppressed_count: number;
          sent_count: number;
          failed_count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["bulk_campaigns"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["bulk_campaigns"]["Row"]
        >;
        Relationships: [];
      };
      bulk_campaign_recipients: {
        Row: {
          id: string;
          campaign_id: string;
          recipient_kind: "patient" | "shop_customer";
          recipient_id: string;
          recipient_email: string | null;
          status: "pending" | "suppressed" | "sending" | "sent" | "failed";
          suppression_reason: string | null;
          sent_at: string | null;
          vendor_message_id: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["bulk_campaign_recipients"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["bulk_campaign_recipients"]["Row"]
        >;
        Relationships: [];
      };
      admin_mfa_secrets: {
        Row: {
          id: string;
          staff_user_id: string;
          secret_base32: string;
          verified_at: string | null;
          last_used_at: string | null;
          last_used_counter: number | null;
          device_label: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["admin_mfa_secrets"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["admin_mfa_secrets"]["Row"]
        >;
        Relationships: [];
      };
      admin_mfa_recovery_codes: {
        Row: {
          id: string;
          staff_user_id: string;
          code_hash: string;
          used_at: string | null;
          used_ip: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["admin_mfa_recovery_codes"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["admin_mfa_recovery_codes"]["Row"]
        >;
        Relationships: [];
      };
      accreditation_policies: {
        Row: {
          id: string;
          policy_key: string;
          version: string;
          title: string;
          summary: string | null;
          body_url: string | null;
          category: string;
          active_at: string | null;
          retired_at: string | null;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["accreditation_policies"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["accreditation_policies"]["Row"]
        >;
        Relationships: [];
      };
      admin_policy_attestations: {
        Row: {
          id: string;
          staff_user_id: string;
          policy_id: string;
          attested_at: string;
          signature_method: string;
          acknowledged_text: string;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["admin_policy_attestations"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["admin_policy_attestations"]["Row"]
        >;
        Relationships: [];
      };
      patient_maintenance_log: {
        Row: {
          id: string;
          patient_id: string;
          task_key: string;
          completed_at: string;
          source: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_maintenance_log"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_maintenance_log"]["Row"]
        >;
        Relationships: [];
      };
      patient_maintenance_nudges: {
        Row: {
          id: string;
          patient_id: string;
          sent_at: string;
          channel: "email" | "sms";
          task_keys: Json;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_maintenance_nudges"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_maintenance_nudges"]["Row"]
        >;
        Relationships: [];
      };
      office_closures: {
        Row: {
          id: string;
          label: string;
          starts_at: string;
          ends_at: string;
          auto_reply_message: string;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["office_closures"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["office_closures"]["Row"]
        >;
        Relationships: [];
      };
      csr_shifts: {
        Row: {
          id: string;
          staff_user_id: string;
          starts_at: string;
          ends_at: string;
          status: "scheduled" | "called_off" | "actual";
          notes: string | null;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["csr_shifts"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["csr_shifts"]["Row"]>;
        Relationships: [];
      };
      feature_flags: {
        Row: {
          key: string;
          enabled: boolean;
          description: string;
          category: string;
          updated_by_user_id: string | null;
          updated_by_email: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["feature_flags"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["feature_flags"]["Row"]
        >;
        Relationships: [];
      };
      appointment_requests: {
        Row: {
          id: string;
          requester_email: string;
          requester_name: string | null;
          requester_phone: string | null;
          topic: string;
          preferred_window: string | null;
          notes: string | null;
          status:
            | "new"
            | "contacted"
            | "scheduled"
            | "declined"
            | "cancelled";
          attached_patient_id: string | null;
          assigned_admin_user_id: string | null;
          triaged_at: string | null;
          scheduled_for: string | null;
          meeting_url: string | null;
          meeting_provider: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["appointment_requests"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["appointment_requests"]["Row"]
        >;
        Relationships: [];
      };
      shop_order_loss_claims: {
        Row: {
          id: string;
          order_id: string;
          opened_by_user_id: string | null;
          status:
            | "open"
            | "carrier_filed"
            | "resolved_refunded"
            | "resolved_reshipped"
            | "closed_unresolved";
          carrier_claim_number: string | null;
          resolution_note: string | null;
          opened_at: string;
          carrier_filed_at: string | null;
          resolved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["shop_order_loss_claims"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["shop_order_loss_claims"]["Row"]
        >;
        Relationships: [];
      };
      patient_identity_verifications: {
        Row: {
          id: string;
          patient_id: string;
          method:
            | "dob_last4_ssn"
            | "gov_id_upload"
            | "video_attest"
            | "in_person";
          result: "pass" | "fail" | "skipped";
          notes: string | null;
          verified_by_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_identity_verifications"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_identity_verifications"]["Row"]
        >;
        Relationships: [];
      };
      patient_fit_overrides: {
        Row: {
          patient_id: string;
          recommended_mask_sku: string;
          recommended_mask_size: string | null;
          rationale: string | null;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_fit_overrides"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_fit_overrides"]["Row"]
        >;
        Relationships: [];
      };
      patient_referrals: {
        Row: {
          id: string;
          referrer_patient_id: string;
          code: string;
          referee_email: string | null;
          referee_name: string | null;
          converted_at: string | null;
          converted_order_id: string | null;
          status: "pending" | "converted" | "expired" | "revoked";
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_referrals"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_referrals"]["Row"]
        >;
        Relationships: [];
      };
      patient_form_acknowledgements: {
        Row: {
          id: string;
          patient_id: string;
          form_kind:
            | "hipaa_npp"
            | "aob"
            | "abn"
            | "financial_responsibility"
            | "supplier_standards";
          form_version: string;
          signed_at: string;
          signed_from_ip: string | null;
          source: "patient_portal" | "csr_recorded" | "paper_scan";
          document_id: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_form_acknowledgements"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_form_acknowledgements"]["Row"]
        >;
        Relationships: [];
      };
      office_recurring_closures: {
        Row: {
          id: string;
          label: string;
          day_of_week: number;
          start_time_utc: string;
          end_time_utc: string;
          auto_reply_message: string;
          active: number;
          created_by_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["office_recurring_closures"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["office_recurring_closures"]["Row"]
        >;
        Relationships: [];
      };
      patient_coaching_plans: {
        Row: {
          id: string;
          patient_id: string;
          source_alert_id: string | null;
          opened_by_user_id: string | null;
          status:
            | "open"
            | "outreach_made"
            | "improving"
            | "escalated"
            | "resolved"
            | "abandoned";
          target_compliance_pct: number;
          latest_compliance_pct: string | null;
          target_date: string | null;
          latest_outreach_at: string | null;
          resolution_note: string | null;
          opened_at: string;
          closed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_coaching_plans"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_coaching_plans"]["Row"]
        >;
        Relationships: [];
      };
      patient_address_history: {
        Row: {
          id: string;
          patient_id: string;
          line1: string | null;
          line2: string | null;
          city: string | null;
          state: string | null;
          postal_code: string | null;
          country: string | null;
          reason: string | null;
          changed_by_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_address_history"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_address_history"]["Row"]
        >;
        Relationships: [];
      };
      conversation_coaching_notes: {
        Row: {
          id: string;
          conversation_id: string;
          target_user_id: string;
          author_user_id: string;
          kind: "praise" | "suggestion" | "concern";
          body: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["conversation_coaching_notes"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["conversation_coaching_notes"]["Row"]
        >;
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
          // Cash-pay membership tier (migration 0134).
          membership_tier:
            | "payg"
            | "monthly_unlimited"
            | "quarterly_unlimited"
            | null;
          membership_started_at: string | null;
          membership_renews_at: string | null;
          membership_stripe_subscription_id: string | null;
          default_payment_method_last4: string | null;
          default_payment_method_exp_month: number | null;
          default_payment_method_exp_year: number | null;
          communication_preferences: Json | null;
          cpap_device_json: Json | null;
          physician_info_json: Json | null;
          facial_measurements_json: Json | null;
          auth_user_id: string | null;
          winback_sent_at: string | null;
          deductible_reset_year: number | null;
          caregiver_email: string | null;
          caregiver_name: string | null;
          caregiver_consent_at: string | null;
          caregiver_revoked_at: string | null;
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
          pod_object_key: string | null;
          pod_uploaded_at: string | null;
          pod_signed_name: string | null;
          delivery_followup_sent_at: string | null;
          created_at: string;
          updated_at: string;
          paid_at: string | null;
        };
        Insert: Partial<Database["resupply"]["Tables"]["shop_orders"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["shop_orders"]["Row"]>;
        Relationships: [];
      };
      patient_therapy_milestones: {
        Row: {
          id: string;
          patient_id: string;
          milestone_kind:
            | "100_nights"
            | "365_nights"
            | "first_adherence_month";
          achieved_on: string;
          metric_snapshot: Json | null;
          notified_at: string | null;
          notification_channel: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_therapy_milestones"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_therapy_milestones"]["Row"]
        >;
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
      shop_order_nps_responses: {
        Row: {
          id: string;
          order_id: string;
          score: number;
          comment: string | null;
          submitter_ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["shop_order_nps_responses"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["shop_order_nps_responses"]["Row"]
        >;
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
      inventory_reconciliations: {
        Row: {
          id: string;
          period_label: string;
          status: "draft" | "submitted";
          started_by_email: string;
          started_by_user_id: string | null;
          started_at: string;
          submitted_at: string | null;
          notes: string | null;
          total_lines: number;
          total_variance_units: number;
          applied_to_stripe: boolean;
        };
        Insert: Partial<Database["resupply"]["Tables"]["inventory_reconciliations"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["inventory_reconciliations"]["Row"]>;
        Relationships: [];
      };
      inventory_reconciliation_lines: {
        Row: {
          id: string;
          reconciliation_id: string;
          product_id: string;
          product_name: string;
          system_count: number | null;
          counted_qty: number;
          variance: number;
          applied: boolean;
          created_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["inventory_reconciliation_lines"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["inventory_reconciliation_lines"]["Row"]>;
        Relationships: [];
      };
      low_stock_alert_state: {
        Row: {
          product_id: string;
          last_observed_count: number | null;
          last_threshold: number | null;
          last_alerted_at: string | null;
          last_resolved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["resupply"]["Tables"]["low_stock_alert_state"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["low_stock_alert_state"]["Row"]>;
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
      business_associate_agreements: {
        Row: {
          id: string;
          vendor_slug: string;
          vendor_legal_name: string;
          vendor_kind:
            | "clearinghouse"
            | "cloud_infrastructure"
            | "email_provider"
            | "sms_telecom_provider"
            | "ai_llm_provider"
            | "payment_processor"
            | "storage_provider"
            | "eprescribe"
            | "analytics"
            | "other";
          scope_json: Json;
          agreement_signed_on: string | null;
          agreement_expires_on: string | null;
          agreement_document_object_key: string | null;
          last_safeguard_attestation_on: string | null;
          compliance_certifications: string[];
          vendor_contact_email: string | null;
          vendor_contact_phone_e164: string | null;
          internal_owner_email: string | null;
          status: "active" | "expired" | "terminated" | "pending";
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["business_associate_agreements"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["business_associate_agreements"]["Row"]
        >;
        Relationships: [];
      };
      oig_leie_exclusions: {
        Row: {
          id: string;
          npi: string | null;
          lastname: string;
          firstname: string | null;
          middlename: string | null;
          subject_type: string;
          exclusion_type: string;
          exclusion_date: string;
          waiver_date: string | null;
          reinstate_date: string | null;
          address_state: string | null;
          address_city: string | null;
          loaded_at: string;
          source_file_version: string | null;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["oig_leie_exclusions"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["oig_leie_exclusions"]["Row"]
        >;
        Relationships: [];
      };
      oig_leie_screenings: {
        Row: {
          id: string;
          subject_kind:
            | "admin_user"
            | "provider"
            | "business_associate"
            | "contractor"
            | "owner";
          subject_admin_user_id: string | null;
          subject_provider_id: string | null;
          subject_baa_id: string | null;
          subject_label: string;
          subject_npi: string | null;
          result: "clear" | "hit" | "inconclusive" | "errored";
          matched_exclusion_id: string | null;
          disposition_note: string | null;
          screened_by_email: string;
          screened_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["oig_leie_screenings"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["oig_leie_screenings"]["Row"]
        >;
        Relationships: [];
      };
      patient_rights_requests: {
        Row: {
          id: string;
          patient_id: string;
          request_kind:
            | "access"
            | "amendment"
            | "accounting_of_disclosures"
            | "restriction"
            | "confidential_communications";
          submitted_via:
            | "patient_portal"
            | "phone"
            | "email"
            | "mail"
            | "in_person"
            | "representative";
          request_body: string;
          request_details_json: Json;
          status:
            | "received"
            | "in_review"
            | "extended"
            | "granted"
            | "partially_granted"
            | "denied"
            | "withdrawn"
            | "expired";
          received_at: string;
          extension_granted_at: string | null;
          decision: "granted" | "partially_granted" | "denied" | null;
          decision_rationale: string | null;
          decided_at: string | null;
          decided_by_email: string | null;
          response_document_object_key: string | null;
          delivered_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_rights_requests"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_rights_requests"]["Row"]
        >;
        Relationships: [];
      };
      patient_disclosure_log: {
        Row: {
          id: string;
          patient_id: string;
          recipient_name: string;
          recipient_address: string | null;
          disclosure_purpose:
            | "public_health"
            | "health_oversight"
            | "judicial_administrative"
            | "law_enforcement"
            | "decedents"
            | "cadaveric_organ_eye_tissue"
            | "research"
            | "serious_threat"
            | "specialized_government"
            | "workers_compensation"
            | "reporting_abuse_or_neglect"
            | "fda_product_safety"
            | "other";
          description: string;
          legal_authority: string | null;
          patient_authorized: boolean;
          disclosed_at: string;
          disclosed_by_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["patient_disclosure_log"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["patient_disclosure_log"]["Row"]
        >;
        Relationships: [];
      };
      hipaa_risk_assessments: {
        Row: {
          id: string;
          assessment_year: number;
          methodology: "internal" | "third_party";
          vendor_name: string | null;
          scope_summary: string;
          findings_json: Json;
          remediation_plan: string | null;
          executive_summary: string | null;
          completed_on: string;
          report_document_object_key: string | null;
          owner_email: string;
          approved_by_email: string | null;
          approved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["hipaa_risk_assessments"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["hipaa_risk_assessments"]["Row"]
        >;
        Relationships: [];
      };
      contingency_plan_attestations: {
        Row: {
          id: string;
          plan_version: string;
          plan_document_object_key: string | null;
          attested_by_email: string;
          attested_at: string;
          documented_rto_hours: number;
          documented_rpo_hours: number;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["contingency_plan_attestations"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["contingency_plan_attestations"]["Row"]
        >;
        Relationships: [];
      };
      disaster_preparedness_drills: {
        Row: {
          id: string;
          drill_kind:
            | "tabletop"
            | "partial_failover"
            | "full_failover"
            | "data_restore"
            | "pandemic_response"
            | "cyber_incident_response"
            | "physical_outage"
            | "other";
          scenario: string;
          executed_on: string;
          rto_target_hours: number | null;
          rto_actual_hours: number | null;
          participants_count: number | null;
          outcome_json: Json;
          lead_email: string;
          created_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["disaster_preparedness_drills"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["disaster_preparedness_drills"]["Row"]
        >;
        Relationships: [];
      };
      quality_improvement_initiatives: {
        Row: {
          id: string;
          slug: string;
          title: string;
          description: string;
          category:
            | "patient_safety"
            | "patient_satisfaction"
            | "clinical_outcomes"
            | "billing_accuracy"
            | "service_delivery"
            | "workforce_competency"
            | "infection_control"
            | "equipment_management"
            | "other";
          target_metric: string;
          baseline_metric: string | null;
          owner_email: string;
          started_on: string;
          concluded_on: string | null;
          status: "active" | "on_hold" | "concluded" | "cancelled";
          annual_evaluation_summary: string | null;
          annual_evaluation_completed_on: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["quality_improvement_initiatives"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["quality_improvement_initiatives"]["Row"]
        >;
        Relationships: [];
      };
      quality_improvement_measurements: {
        Row: {
          id: string;
          initiative_id: string;
          period_start: string;
          period_end: string;
          metric_value: string;
          study_findings: string | null;
          act_corrective_actions: string | null;
          recorded_by_email: string;
          recorded_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["quality_improvement_measurements"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["quality_improvement_measurements"]["Row"]
        >;
        Relationships: [];
      };
      dme_ownership_disclosures: {
        Row: {
          id: string;
          organization_id: string;
          person_legal_name: string;
          person_role:
            | "owner"
            | "partner"
            | "officer"
            | "director"
            | "managing_employee"
            | "agent"
            | "authorized_official";
          ownership_pct: number | null;
          related_provider_disclosed: boolean;
          related_provider_description: string | null;
          ssn_last4: string | null;
          tax_id: string | null;
          disclosed_on: string;
          removed_on: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["resupply"]["Tables"]["dme_ownership_disclosures"]["Row"]
        >;
        Update: Partial<
          Database["resupply"]["Tables"]["dme_ownership_disclosures"]["Row"]
        >;
        Relationships: [];
      };
    };
    Views: {
      // Mig 0155 — per-touch aggregate metrics for the admin
      // reporting surface.
      fitter_campaign_touch_metrics: {
        Row: {
          touch_index: number;
          email_sends: number;
          email_failures: number;
          opens: number;
          sms_sends: number;
          sms_failures: number;
          clicks: number;
        };
      };
    };
    Functions: {
      // Mig 0155 — atomic per-touch open-count bump, called by
      // the open-tracking pixel endpoint on every pixel load.
      record_fitter_touch_open: {
        Args: {
          p_lead_id: string;
          p_touch_index: number;
        };
        Returns: void;
      };
      validate_payment_allocations: {
        Args: {
          p_patient_id: string;
          p_claim_ids: string[];
          p_allocations: Array<{
            claim_id: string;
            amount_applied_cents: number;
          }>;
        };
        Returns: Array<{
          id: string;
          patient_id: string;
          patient_responsibility_cents: number;
        }>;
      };
      submit_inventory_reconciliation: {
        Args: {
          p_id: string;
          p_lines: Array<{
            product_id: string;
            product_name: string;
            system_count: number | null;
            counted_qty: number;
            variance: number;
            applied: boolean;
          }>;
          p_applied_to_stripe: boolean;
          p_total_variance_units: number;
        };
        Returns:
          | {
              ok: true;
              total_lines: number;
              total_variance_units: number;
            }
          | {
              ok: false;
              error: "not_found" | "already_submitted" | "duplicate_line";
            };
      };
    };
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

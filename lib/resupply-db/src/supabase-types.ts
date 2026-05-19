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
        };
        Insert: Partial<Database["resupply"]["Tables"]["fitter_leads"]["Row"]>;
        Update: Partial<Database["resupply"]["Tables"]["fitter_leads"]["Row"]>;
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
            | "prior_auth_expired";
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

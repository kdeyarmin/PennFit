CREATE TABLE "resupply"."alert_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "channels" "jsonb" DEFAULT '["email", "sms", "voice"]'::"jsonb" NOT NULL,
    "allowed_variables" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    CONSTRAINT "alert_definitions_description_max_length" CHECK ((("description" IS NULL) OR ("length"("description") <= 2000))),
    CONSTRAINT "alert_definitions_name_max_length" CHECK (("length"("name") <= 200)),
    CONSTRAINT "alert_definitions_severity_enum" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"])))
);
CREATE TABLE "resupply"."alert_message_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "alert_key" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "subject" "text",
    "body_html" "text",
    "body_text" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    CONSTRAINT "alert_message_overrides_body_html_max_length" CHECK ((("body_html" IS NULL) OR ("length"("body_html") <= 200000))),
    CONSTRAINT "alert_message_overrides_body_text_max_length" CHECK ((("body_text" IS NULL) OR ("length"("body_text") <= 50000))),
    CONSTRAINT "alert_message_overrides_channel_enum" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'voice'::"text"]))),
    CONSTRAINT "alert_message_overrides_note_max_length" CHECK ((("note" IS NULL) OR ("length"("note") <= 2000))),
    CONSTRAINT "alert_message_overrides_subject_max_length" CHECK ((("subject" IS NULL) OR ("length"("subject") <= 1000)))
);
CREATE TABLE "resupply"."alert_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alert_key" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "subject" "text",
    "body_html" "text",
    "body_text" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    CONSTRAINT "alert_messages_body_html_max_length" CHECK ((("body_html" IS NULL) OR ("length"("body_html") <= 200000))),
    CONSTRAINT "alert_messages_body_text_max_length" CHECK (("length"("body_text") <= 50000)),
    CONSTRAINT "alert_messages_channel_enum" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'voice'::"text"]))),
    CONSTRAINT "alert_messages_subject_max_length" CHECK ((("subject" IS NULL) OR ("length"("subject") <= 1000)))
);
CREATE TABLE "resupply"."bulk_campaign_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "recipient_kind" "text" NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "recipient_email" character varying(320),
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "suppression_reason" character varying(80),
    "sent_at" timestamp with time zone,
    "vendor_message_id" character varying(200),
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bulk_campaign_recipients_kind_enum" CHECK (("recipient_kind" = ANY (ARRAY['patient'::"text", 'shop_customer'::"text"]))),
    CONSTRAINT "bulk_campaign_recipients_status_enum" CHECK (("status" = ANY (ARRAY['pending'::"text", 'suppressed'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text"]))),
    CONSTRAINT "bulk_campaign_recipients_suppression_reason_check" CHECK (((("status" = 'suppressed'::"text") AND ("suppression_reason" IS NOT NULL) AND (("suppression_reason")::"text" <> ''::"text")) OR (("status" <> 'suppressed'::"text") AND ("suppression_reason" IS NULL))))
);
CREATE TABLE "resupply"."bulk_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "audience_kind" "text" NOT NULL,
    "audience_payer" character varying(120),
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "category" "text" NOT NULL,
    "compliance_attestation" "text",
    "template_key" character varying(120) NOT NULL,
    "throttle_per_minute" integer DEFAULT 120 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "created_by_user_id" "uuid",
    "cancelled_by_user_id" "uuid",
    "total_recipients" integer DEFAULT 0 NOT NULL,
    "suppressed_count" integer DEFAULT 0 NOT NULL,
    "sent_count" integer DEFAULT 0 NOT NULL,
    "failed_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bulk_campaigns_audience_kind_enum" CHECK (("audience_kind" = ANY (ARRAY['all_active_shop_customers'::"text", 'all_active_patients'::"text", 'by_patient_payer'::"text", 'manual_list'::"text"]))),
    CONSTRAINT "bulk_campaigns_category_enum" CHECK (("category" = ANY (ARRAY['marketing'::"text", 'service'::"text", 'compliance'::"text"]))),
    CONSTRAINT "bulk_campaigns_channel_enum" CHECK (("channel" = 'email'::"text")),
    CONSTRAINT "bulk_campaigns_counts_non_negative" CHECK ((("total_recipients" >= 0) AND ("suppressed_count" >= 0) AND ("sent_count" >= 0) AND ("failed_count" >= 0))),
    CONSTRAINT "bulk_campaigns_status_enum" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sending'::"text", 'sent'::"text", 'paused'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "bulk_campaigns_throttle_range" CHECK ((("throttle_per_minute" >= 1) AND ("throttle_per_minute" <= 3600)))
);
CREATE TABLE "resupply"."claim_appeal_letters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "denial_analysis_id" "uuid",
    "letter_body" "text" NOT NULL,
    "appeal_pdf_object_key" "text",
    "delivery_method" "text",
    "delivered_at" timestamp with time zone,
    "generated_by_email" character varying(180) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "claim_appeal_letters_delivery_method_enum" CHECK ((("delivery_method" IS NULL) OR ("delivery_method" = ANY (ARRAY['fax'::"text", 'mail'::"text", 'portal_upload'::"text", 'email'::"text"]))))
);
CREATE TABLE "resupply"."claim_denial_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "era_file_id" "uuid",
    "model" character varying(80) NOT NULL,
    "prompt_version" character varying(20) NOT NULL,
    "confidence" real,
    "root_cause_summary" "text" NOT NULL,
    "recommendation" "text" NOT NULL,
    "analysis_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "suggested_patches_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "can_auto_resubmit" boolean DEFAULT false NOT NULL,
    "review_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by_email" character varying(180),
    "reviewed_at" timestamp with time zone,
    "applied_at" timestamp with time zone,
    "resubmit_office_ally_submission_id" "uuid",
    "latency_ms" integer,
    "prompt_tokens" integer,
    "completion_tokens" integer,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "claim_denial_analyses_recommendation_enum" CHECK (("recommendation" = ANY (ARRAY['auto_resubmit'::"text", 'manual_resubmit'::"text", 'appeal'::"text", 'bill_patient'::"text", 'write_off'::"text", 'manual_review'::"text"]))),
    CONSTRAINT "claim_denial_analyses_review_status_enum" CHECK (("review_status" = ANY (ARRAY['pending'::"text", 'accepted_resubmitted'::"text", 'accepted_appealed'::"text", 'accepted_written_off'::"text", 'rejected'::"text", 'errored'::"text"])))
);
CREATE TABLE "resupply"."claim_scrub_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "verdict" "text" NOT NULL,
    "model" character varying(80) NOT NULL,
    "prompt_version" character varying(20) NOT NULL,
    "confidence" real,
    "findings_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "suggested_patches_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "review_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by_email" character varying(180),
    "reviewed_at" timestamp with time zone,
    "applied_patches_log" "jsonb",
    "applied_at" timestamp with time zone,
    "latency_ms" integer,
    "prompt_tokens" integer,
    "completion_tokens" integer,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "claim_scrub_results_review_status_enum" CHECK (("review_status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'auto_applied'::"text"]))),
    CONSTRAINT "claim_scrub_results_verdict_enum" CHECK (("verdict" = ANY (ARRAY['ready'::"text", 'fixable'::"text", 'blocking'::"text", 'errored'::"text"])))
);
CREATE TABLE "resupply"."claim_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" character varying(80) NOT NULL,
    "display_name" character varying(160) NOT NULL,
    "description" "text",
    "lines_json" "jsonb" NOT NULL,
    "default_diagnosis_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "scoped_payer_profile_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "claim_templates_lines_json_object" CHECK (("jsonb_typeof"("lines_json") = 'object'::"text")),
    CONSTRAINT "claim_templates_slug_format" CHECK ((("slug")::"text" ~ '^[a-z0-9_]+$'::"text"))
);
CREATE TABLE "resupply"."clearinghouse_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" character varying(40) NOT NULL,
    "display_name" character varying(160) NOT NULL,
    "usage_indicator" "text" DEFAULT 'T'::"text" NOT NULL,
    "sftp_host" character varying(160) NOT NULL,
    "sftp_port" smallint DEFAULT 22 NOT NULL,
    "sftp_username" character varying(120) NOT NULL,
    "private_key_path" "text" NOT NULL,
    "known_hosts_path" "text" NOT NULL,
    "remote_inbox_dir" character varying(120) DEFAULT 'inbound'::character varying NOT NULL,
    "remote_outbound_dir" character varying(120) DEFAULT 'outbound'::character varying NOT NULL,
    "remote_archive_dir" character varying(120),
    "etin" character varying(40) NOT NULL,
    "submitter_organization_name" character varying(200),
    "contact_name" character varying(120),
    "contact_phone_e164" character varying(20),
    "is_active" boolean DEFAULT true NOT NULL,
    "last_polled_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clearinghouse_credentials_port_range" CHECK ((("sftp_port" > 0) AND ("sftp_port" <= 32767))),
    CONSTRAINT "clearinghouse_credentials_slug_format" CHECK ((("slug")::"text" ~ '^[a-z0-9_]+$'::"text")),
    CONSTRAINT "clearinghouse_credentials_usage_indicator_enum" CHECK (("usage_indicator" = ANY (ARRAY['P'::"text", 'T'::"text"])))
);
CREATE TABLE "resupply"."clearinghouse_inbound_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clearinghouse_id" "uuid" NOT NULL,
    "remote_path" "text" NOT NULL,
    "file_name" character varying(200) NOT NULL,
    "file_sha256" character varying(64) NOT NULL,
    "file_size_bytes" integer NOT NULL,
    "file_kind" "text" NOT NULL,
    "parse_summary_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "dispatch_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "applied_to_era_file_id" "uuid",
    "applied_to_submission_id" "uuid",
    "error_message" "text",
    "downloaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dispatched_at" timestamp with time zone,
    CONSTRAINT "clearinghouse_inbound_files_dispatch_status_enum" CHECK (("dispatch_status" = ANY (ARRAY['pending'::"text", 'parsed'::"text", 'dispatched'::"text", 'dispatch_failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "clearinghouse_inbound_files_kind_enum" CHECK (("file_kind" = ANY (ARRAY['999'::"text", '277ca'::"text", '835'::"text", '271'::"text", 'unknown'::"text"])))
);
CREATE TABLE "resupply"."clinician_share_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "referral_id" "uuid" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "last_viewed_at" timestamp with time zone,
    "last_viewed_ip" "inet",
    "view_count" integer DEFAULT 0 NOT NULL,
    "created_by_email" character varying(180) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clinician_share_tokens_view_count_nonneg" CHECK (("view_count" >= 0))
);
CREATE TABLE "resupply"."conversation_coaching_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "target_user_id" "text" NOT NULL,
    "author_user_id" "text" NOT NULL,
    "kind" character varying(16) DEFAULT 'suggestion'::character varying NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversation_coaching_notes_kind_enum" CHECK ((("kind")::"text" = ANY ((ARRAY['praise'::character varying, 'suggestion'::character varying, 'concern'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."csr_shifts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "staff_user_id" "text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "status" character varying(16) DEFAULT 'scheduled'::character varying NOT NULL,
    "notes" "text",
    "created_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "csr_shifts_range_valid" CHECK (("ends_at" > "starts_at")),
    CONSTRAINT "csr_shifts_status_enum" CHECK ((("status")::"text" = ANY ((ARRAY['scheduled'::character varying, 'called_off'::character varying, 'actual'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."dispense_readiness_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hcpcs_code" character varying(12) NOT NULL,
    "fulfillment_id" "uuid",
    "payer_profile_id" "uuid",
    "insurance_coverage_id" "uuid",
    "ready_to_dispense" boolean NOT NULL,
    "overall_verdict" "text" NOT NULL,
    "estimated_days_to_ready" integer,
    "deterministic_findings_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "checks_total" integer DEFAULT 0 NOT NULL,
    "checks_passed" integer DEFAULT 0 NOT NULL,
    "checks_warning" integer DEFAULT 0 NOT NULL,
    "checks_failed" integer DEFAULT 0 NOT NULL,
    "ai_summary" "text",
    "ai_action_plan_json" "jsonb",
    "ai_model" character varying(80),
    "ai_prompt_version" character varying(20),
    "ai_confidence" real,
    "ai_latency_ms" integer,
    "ai_prompt_tokens" integer,
    "ai_completion_tokens" integer,
    "ai_error_message" "text",
    "review_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by_email" character varying(180),
    "reviewed_at" timestamp with time zone,
    "created_by_email" character varying(180) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dispense_readiness_confidence_range" CHECK ((("ai_confidence" IS NULL) OR (("ai_confidence" >= (0)::double precision) AND ("ai_confidence" <= (1)::double precision)))),
    CONSTRAINT "dispense_readiness_estimated_days_nonneg" CHECK ((("estimated_days_to_ready" IS NULL) OR ("estimated_days_to_ready" >= 0))),
    CONSTRAINT "dispense_readiness_overall_verdict_enum" CHECK (("overall_verdict" = ANY (ARRAY['ready'::"text", 'gaps_with_fixable'::"text", 'gaps_with_blocking'::"text", 'errored'::"text"]))),
    CONSTRAINT "dispense_readiness_review_status_enum" CHECK (("review_status" = ANY (ARRAY['pending'::"text", 'acknowledged'::"text", 'remediated'::"text", 'overridden'::"text", 'cancelled'::"text"])))
);
CREATE TABLE "resupply"."dme_organization" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "singleton" boolean DEFAULT true NOT NULL,
    "legal_name" character varying(200) NOT NULL,
    "dba_name" character varying(200),
    "tax_id" character varying(9) NOT NULL,
    "organizational_npi" character varying(10) NOT NULL,
    "taxonomy_code" character varying(10) DEFAULT '332B00000X'::character varying NOT NULL,
    "medicare_ptan" character varying(20),
    "physical_address_line1" character varying(120) NOT NULL,
    "physical_address_line2" character varying(120),
    "physical_city" character varying(80) NOT NULL,
    "physical_state" character varying(2) NOT NULL,
    "physical_zip" character varying(10) NOT NULL,
    "mailing_address_line1" character varying(120),
    "mailing_address_line2" character varying(120),
    "mailing_city" character varying(80),
    "mailing_state" character varying(2),
    "mailing_zip" character varying(10),
    "pay_to_address_line1" character varying(120),
    "pay_to_address_line2" character varying(120),
    "pay_to_city" character varying(80),
    "pay_to_state" character varying(2),
    "pay_to_zip" character varying(10),
    "phone_e164" character varying(20) NOT NULL,
    "fax_e164" character varying(20),
    "billing_email" character varying(180) NOT NULL,
    "general_email" character varying(180),
    "website_url" character varying(240),
    "accreditation_body" "text",
    "accreditation_number" character varying(60),
    "accreditation_expires_on" "date",
    "state_license_number" character varying(60),
    "state_license_state" character varying(2),
    "state_license_expires_on" "date",
    "liability_carrier" character varying(160),
    "liability_policy_number" character varying(60),
    "liability_expires_on" "date",
    "surety_bond_carrier" character varying(160),
    "surety_bond_amount_cents" bigint,
    "surety_bond_expires_on" "date",
    "authorized_signer_name" character varying(160),
    "authorized_signer_title" character varying(120),
    "authorized_signer_signature_object_key" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dme_organization_accreditation_body_enum" CHECK ((("accreditation_body" IS NULL) OR ("accreditation_body" = ANY (ARRAY['achc'::"text", 'boc'::"text", 'tjc'::"text", 'cap'::"text", 'other'::"text"])))),
    CONSTRAINT "dme_organization_npi_format" CHECK ((("organizational_npi")::"text" ~ '^\d{10}$'::"text")),
    CONSTRAINT "dme_organization_state_format" CHECK ((("physical_state")::"text" ~ '^[A-Z]{2}$'::"text")),
    CONSTRAINT "dme_organization_surety_bond_nonneg" CHECK ((("surety_bond_amount_cents" IS NULL) OR ("surety_bond_amount_cents" >= 0))),
    CONSTRAINT "dme_organization_tax_id_format" CHECK ((("tax_id")::"text" ~ '^\d{9}$'::"text")),
    CONSTRAINT "dme_organization_zip_format" CHECK ((("physical_zip")::"text" ~ '^\d{5}(-?\d{4})?$'::"text"))
);
CREATE TABLE "resupply"."dme_organization_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "name" character varying(160) NOT NULL,
    "title" character varying(120),
    "email" character varying(180),
    "phone_e164" character varying(20),
    "is_primary" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dme_organization_contacts_role_enum" CHECK (("role" = ANY (ARRAY['billing_manager'::"text", 'compliance_officer'::"text", 'authorized_signer'::"text", 'medical_director'::"text", 'office_manager'::"text", 'edi_contact'::"text", 'credentialing'::"text", 'patient_advocate'::"text", 'other'::"text"])))
);
CREATE TABLE "resupply"."equipment_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "prescription_id" "uuid",
    "device_class" "text" NOT NULL,
    "manufacturer" character varying(80) NOT NULL,
    "model" character varying(120) NOT NULL,
    "serial_number" character varying(80) NOT NULL,
    "pressure_setting" character varying(80),
    "humidifier_setting" character varying(32),
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "dispensed_at" "date",
    "dispensing_note" "text",
    "recall_id" "uuid",
    "metadata" "jsonb",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "equipment_assets_device_class_enum" CHECK (("device_class" = ANY (ARRAY['cpap'::"text", 'auto_cpap'::"text", 'bipap'::"text", 'asv'::"text", 'avaps'::"text", 'humidifier'::"text", 'oximeter'::"text", 'other'::"text"]))),
    CONSTRAINT "equipment_assets_serial_not_empty" CHECK (("length"(TRIM(BOTH FROM "serial_number")) > 0)),
    CONSTRAINT "equipment_assets_status_enum" CHECK (("status" = ANY (ARRAY['active'::"text", 'returned'::"text", 'recalled'::"text", 'retired'::"text"])))
);
CREATE TABLE "resupply"."equipment_recalls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recall_reference" character varying(64) NOT NULL,
    "title" character varying(200) NOT NULL,
    "manufacturer" character varying(80) NOT NULL,
    "model_match" character varying(120),
    "serial_match" "jsonb",
    "severity" "text" DEFAULT 'priority'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "issued_at" "date",
    "deadline_at" "date",
    "reference_url" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "equipment_recalls_reference_not_empty" CHECK (("length"(TRIM(BOTH FROM "recall_reference")) > 0)),
    CONSTRAINT "equipment_recalls_severity_enum" CHECK (("severity" = ANY (ARRAY['urgent'::"text", 'priority'::"text", 'advisory'::"text"]))),
    CONSTRAINT "equipment_recalls_status_enum" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text"])))
);
CREATE TABLE "resupply"."good_faith_estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "recipient_name" character varying(160) NOT NULL,
    "recipient_email" character varying(180) NOT NULL,
    "items_json" "jsonb" NOT NULL,
    "total_cents" bigint NOT NULL,
    "expected_service_date" "date",
    "pdf_object_key" "text",
    "disclaimer_text" "text" NOT NULL,
    "generated_by_email" character varying(180) NOT NULL,
    "delivered_at" timestamp with time zone,
    "delivery_method" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "good_faith_estimates_delivery_method_enum" CHECK ((("delivery_method" IS NULL) OR ("delivery_method" = ANY (ARRAY['email'::"text", 'sms'::"text", 'in_person'::"text", 'mail'::"text"])))),
    CONSTRAINT "good_faith_estimates_total_nonneg" CHECK (("total_cents" >= 0))
);
CREATE TABLE "resupply"."hcpcs_codes" (
    "code" "text" NOT NULL,
    "short_description" "text" NOT NULL,
    "category" "text" NOT NULL,
    "min_interval_days" integer NOT NULL,
    "max_quantity_per_period" integer NOT NULL,
    "period_days" integer NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hcpcs_codes_category_enum" CHECK (("category" = ANY (ARRAY['mask'::"text", 'cushion'::"text", 'pillow'::"text", 'filter'::"text", 'tubing'::"text", 'headgear'::"text", 'chinstrap'::"text", 'chamber'::"text", 'device'::"text", 'other'::"text"]))),
    CONSTRAINT "hcpcs_codes_positive_intervals" CHECK ((("min_interval_days" > 0) AND ("max_quantity_per_period" > 0) AND ("period_days" > 0)))
);
CREATE TABLE "resupply"."inbound_faxes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "twilio_fax_sid" character varying(64) NOT NULL,
    "from_e164" character varying(16),
    "to_e164" character varying(16),
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "num_pages" integer,
    "media_object_key" "text",
    "media_content_type" character varying(120),
    "media_size_bytes" integer,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "attached_patient_id" "uuid",
    "attached_provider_id" "uuid",
    "attached_prescription_id" "uuid",
    "attached_document_type" character varying(64),
    "assigned_admin_user_id" "uuid",
    "triaged_at" timestamp with time zone,
    "triaged_by_user_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inbound_faxes_pages_non_negative" CHECK ((("num_pages" IS NULL) OR ("num_pages" >= 0))),
    CONSTRAINT "inbound_faxes_size_non_negative" CHECK ((("media_size_bytes" IS NULL) OR ("media_size_bytes" >= 0))),
    CONSTRAINT "inbound_faxes_status_enum" CHECK (("status" = ANY (ARRAY['new'::"text", 'triaged'::"text", 'attached'::"text", 'archived'::"text"])))
);
CREATE TABLE "resupply"."inbound_referral_preflight_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "referral_id" "uuid" NOT NULL,
    "check_kind" character varying(40) NOT NULL,
    "outcome_json" "jsonb" NOT NULL,
    "outcome_status" "text" DEFAULT 'info'::"text" NOT NULL,
    "produced_row_table" character varying(80),
    "produced_row_id" "uuid",
    "ran_by" character varying(180) DEFAULT 'system:cron:preflight'::character varying NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inbound_referral_preflight_outcome_status_enum" CHECK (("outcome_status" = ANY (ARRAY['info'::"text", 'ok'::"text", 'warn'::"text", 'error'::"text", 'skipped'::"text"])))
);
CREATE TABLE "resupply"."inbound_referral_status_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "referral_id" "uuid" NOT NULL,
    "target_kind" character varying(40) NOT NULL,
    "event_type" character varying(80) NOT NULL,
    "payload_json" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempt_count" smallint DEFAULT 0 NOT NULL,
    "last_http_status" integer,
    "last_error" "text",
    "next_attempt_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    "max_retries" smallint DEFAULT 5 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inbound_referral_status_outbox_max_retries_range" CHECK ((("max_retries" >= 0) AND ("max_retries" <= 12))),
    CONSTRAINT "inbound_referral_status_outbox_status_enum" CHECK (("status" = ANY (ARRAY['queued'::"text", 'delivered'::"text", 'failed'::"text", 'exhausted'::"text"]))),
    CONSTRAINT "inbound_referral_status_outbox_target_kind_enum" CHECK ((("target_kind")::"text" = ANY ((ARRAY['parachute'::character varying, 'ehr_fhir'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."inventory_reconciliation_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reconciliation_id" "uuid" NOT NULL,
    "product_id" "text" NOT NULL,
    "product_name" "text" NOT NULL,
    "system_count" integer,
    "counted_qty" integer NOT NULL,
    "variance" integer NOT NULL,
    "applied" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_reconciliation_lines_counted_nonneg_chk" CHECK (("counted_qty" >= 0))
);
CREATE TABLE "resupply"."inventory_reconciliations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period_label" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "started_by_email" "text" NOT NULL,
    "started_by_user_id" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submitted_at" timestamp with time zone,
    "notes" "text",
    "total_lines" integer DEFAULT 0 NOT NULL,
    "total_variance_units" integer DEFAULT 0 NOT NULL,
    "applied_to_stripe" boolean DEFAULT false NOT NULL,
    CONSTRAINT "inventory_reconciliations_status_chk" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text"])))
);
CREATE TABLE "resupply"."low_stock_alert_state" (
    "product_id" "text" NOT NULL,
    "last_observed_count" integer,
    "last_threshold" integer,
    "last_alerted_at" timestamp with time zone,
    "last_resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."office_closures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" character varying(200) NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "auto_reply_message" character varying(320) NOT NULL,
    "created_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "office_closures_range_valid" CHECK (("ends_at" > "starts_at"))
);
CREATE TABLE "resupply"."office_recurring_closures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" character varying(200) NOT NULL,
    "day_of_week" integer NOT NULL,
    "start_time_utc" time without time zone NOT NULL,
    "end_time_utc" time without time zone NOT NULL,
    "auto_reply_message" character varying(320) NOT NULL,
    "active" integer DEFAULT 1 NOT NULL,
    "created_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "office_recurring_closures_day_valid" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6)))
);
CREATE TABLE "resupply"."patient_address_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "line1" character varying(200),
    "line2" character varying(200),
    "city" character varying(120),
    "state" character varying(64),
    "postal_code" character varying(32),
    "country" character varying(2),
    "reason" character varying(200),
    "changed_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."patient_coaching_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "source_alert_id" "uuid",
    "opened_by_user_id" "text",
    "status" character varying(32) DEFAULT 'open'::character varying NOT NULL,
    "target_compliance_pct" integer DEFAULT 70 NOT NULL,
    "latest_compliance_pct" numeric(5,2),
    "target_date" timestamp with time zone,
    "latest_outreach_at" timestamp with time zone,
    "resolution_note" "text",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_coaching_plans_pct_range" CHECK ((("target_compliance_pct" >= 0) AND ("target_compliance_pct" <= 100))),
    CONSTRAINT "patient_coaching_plans_status_enum" CHECK ((("status")::"text" = ANY ((ARRAY['open'::character varying, 'outreach_made'::character varying, 'improving'::character varying, 'escalated'::character varying, 'resolved'::character varying, 'abandoned'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."patient_fit_overrides" (
    "patient_id" "uuid" NOT NULL,
    "recommended_mask_sku" character varying(64) NOT NULL,
    "recommended_mask_size" character varying(16),
    "rationale" "text",
    "created_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."patient_form_acknowledgements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "form_kind" character varying(48) NOT NULL,
    "form_version" character varying(24) NOT NULL,
    "signed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signed_from_ip" character varying(64),
    "source" "text" DEFAULT 'patient_portal'::"text" NOT NULL,
    "document_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_form_acks_kind_enum" CHECK ((("form_kind")::"text" = ANY ((ARRAY['hipaa_npp'::character varying, 'aob'::character varying, 'abn'::character varying, 'financial_responsibility'::character varying, 'supplier_standards'::character varying])::"text"[]))),
    CONSTRAINT "patient_form_acks_source_enum" CHECK (("source" = ANY (ARRAY['patient_portal'::"text", 'csr_recorded'::"text", 'paper_scan'::"text"])))
);
CREATE TABLE "resupply"."patient_grievances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "equipment_asset_id" "uuid",
    "kind" "text" NOT NULL,
    "severity" "text" DEFAULT 'low'::"text" NOT NULL,
    "source" "text" NOT NULL,
    "summary" character varying(200) NOT NULL,
    "description" "text",
    "received_at" "date" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "acknowledged_by_user_id" "uuid",
    "resolution" "text",
    "resolved_at" timestamp with time zone,
    "resolved_by_user_id" "uuid",
    "reported_to_fda" "text" DEFAULT 'not_applicable'::"text" NOT NULL,
    "fda_report_reference" character varying(64),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_grievances_kind_enum" CHECK (("kind" = ANY (ARRAY['complaint'::"text", 'grievance'::"text", 'adverse_event'::"text"]))),
    CONSTRAINT "patient_grievances_reported_to_fda_enum" CHECK (("reported_to_fda" = ANY (ARRAY['yes'::"text", 'no'::"text", 'not_applicable'::"text"]))),
    CONSTRAINT "patient_grievances_severity_enum" CHECK (("severity" = ANY (ARRAY['low'::"text", 'moderate'::"text", 'high'::"text"]))),
    CONSTRAINT "patient_grievances_source_enum" CHECK (("source" = ANY (ARRAY['phone'::"text", 'email'::"text", 'sms'::"text", 'in_person'::"text", 'letter'::"text", 'portal'::"text", 'other'::"text"]))),
    CONSTRAINT "patient_grievances_status_enum" CHECK (("status" = ANY (ARRAY['open'::"text", 'acknowledged'::"text", 'escalated'::"text", 'resolved'::"text", 'reopened'::"text"])))
);
CREATE TABLE "resupply"."patient_identity_verifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "method" character varying(32) NOT NULL,
    "result" character varying(16) NOT NULL,
    "notes" "text",
    "verified_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_identity_verifications_method_enum" CHECK ((("method")::"text" = ANY ((ARRAY['dob_last4_ssn'::character varying, 'gov_id_upload'::character varying, 'video_attest'::character varying, 'in_person'::character varying])::"text"[]))),
    CONSTRAINT "patient_identity_verifications_result_enum" CHECK ((("result")::"text" = ANY ((ARRAY['pass'::character varying, 'fail'::character varying, 'skipped'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."patient_maintenance_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "task_key" character varying(64) NOT NULL,
    "completed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'patient_portal'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_maintenance_log_source_enum" CHECK (("source" = ANY (ARRAY['patient_portal'::"text", 'csr_proxy'::"text", 'system'::"text"]))),
    CONSTRAINT "patient_maintenance_log_task_key_shape" CHECK ((("task_key")::"text" ~ '^[a-z0-9_]{1,64}$'::"text"))
);
CREATE TABLE "resupply"."patient_maintenance_nudges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "task_keys" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_maintenance_nudges_channel_enum" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text"])))
);
CREATE TABLE "resupply"."patient_referrals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "referrer_patient_id" "uuid" NOT NULL,
    "code" character varying(16) NOT NULL,
    "referee_email" character varying(200),
    "referee_name" character varying(160),
    "converted_at" timestamp with time zone,
    "converted_order_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_referrals_code_format" CHECK ((("code")::"text" ~ '^[A-Za-z0-9_-]{6,16}$'::"text")),
    CONSTRAINT "patient_referrals_status_enum" CHECK (("status" = ANY (ARRAY['pending'::"text", 'converted'::"text", 'expired'::"text", 'revoked'::"text"])))
);
CREATE TABLE "resupply"."patient_therapy_milestones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "milestone_kind" "text" NOT NULL,
    "achieved_on" "date" NOT NULL,
    "metric_snapshot" "jsonb",
    "notified_at" timestamp with time zone,
    "notification_channel" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_therapy_milestones_kind_enum" CHECK (("milestone_kind" = ANY (ARRAY['100_nights'::"text", '365_nights'::"text", 'first_adherence_month'::"text"])))
);
CREATE TABLE "resupply"."patient_worklist_actions" (
    "patient_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "snooze_until" "date",
    "note" "text",
    "updated_by_email" "text",
    "updated_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_worklist_actions_status_check" CHECK (("status" = ANY (ARRAY['acknowledged'::"text", 'snoozed'::"text", 'contacted'::"text", 'resolved'::"text"])))
);
CREATE TABLE "resupply"."payer_modifier_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payer_profile_id" "uuid" NOT NULL,
    "hcpcs_code" character varying(12) NOT NULL,
    "condition" "text" DEFAULT 'always'::"text" NOT NULL,
    "modifiers_csv" character varying(32) NOT NULL,
    "priority" smallint DEFAULT 100 NOT NULL,
    "rationale" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payer_modifier_rules_condition_enum" CHECK (("condition" = ANY (ARRAY['always'::"text", 'if_rental_month_le_3'::"text", 'if_rental_month_ge_4'::"text", 'if_purchased'::"text", 'if_compliant_90day'::"text", 'if_initial_dispense'::"text", 'if_abn_on_file'::"text", 'if_pa_approved'::"text"]))),
    CONSTRAINT "payer_modifier_rules_modifiers_not_blank" CHECK (("length"(TRIM(BOTH FROM "modifiers_csv")) > 0))
);
CREATE TABLE "resupply"."prescription_request_packets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "source_prescription_id" "uuid",
    "hcpcs_items_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "icd10_codes_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "device_settings_json" "jsonb",
    "length_of_need_months" smallint DEFAULT 99 NOT NULL,
    "return_fax_e164" character varying(20),
    "return_email" character varying(240),
    "clinical_notes" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "valid_through" timestamp with time zone,
    "sent_to_fax_e164" character varying(20),
    "vendor_ref" "text",
    "vendor_name" "text",
    "sent_at" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "failure_reason" "text",
    "signed_at" timestamp with time zone,
    "signed_object_key" "text",
    "created_by_email" character varying(180) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "prescription_request_packets_lon_range" CHECK ((("length_of_need_months" >= 1) AND ("length_of_need_months" <= 99))),
    CONSTRAINT "prescription_request_packets_status_enum" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent_fax'::"text", 'delivered'::"text", 'signed'::"text", 'expired'::"text", 'void'::"text", 'failed'::"text"])))
);
CREATE TABLE "resupply"."product_hcpcs_map" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lookup_kind" "text" NOT NULL,
    "lookup_value" character varying(120) NOT NULL,
    "hcpcs_code" character varying(12) NOT NULL,
    "default_modifiers" character varying(32),
    "units_per_dispense" integer DEFAULT 1 NOT NULL,
    "default_billed_cents" bigint,
    "description" character varying(240),
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_hcpcs_map_billed_nonneg" CHECK ((("default_billed_cents" IS NULL) OR ("default_billed_cents" >= 0))),
    CONSTRAINT "product_hcpcs_map_lookup_kind_enum" CHECK (("lookup_kind" = ANY (ARRAY['stripe_product_id'::"text", 'item_sku'::"text"]))),
    CONSTRAINT "product_hcpcs_map_units_pos" CHECK (("units_per_dispense" > 0))
);
CREATE TABLE "resupply"."providers_pecos_status" (
    "npi" character varying(10) NOT NULL,
    "enrollment_status" "text" NOT NULL,
    "enrollment_type" character varying(80),
    "first_approved_date" "date",
    "specialty_description" character varying(160),
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "providers_pecos_status_enrollment_status_enum" CHECK (("enrollment_status" = ANY (ARRAY['approved'::"text", 'pending'::"text", 'denied'::"text", 'revoked'::"text", 'opted_out'::"text", 'unknown'::"text"]))),
    CONSTRAINT "providers_pecos_status_npi_format" CHECK ((("npi")::"text" ~ '^\d{10}$'::"text"))
);
CREATE TABLE "resupply"."recall_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recall_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "channel" "text",
    "notified_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "failed_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recall_notifications_channel_enum" CHECK ((("channel" IS NULL) OR ("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'letter'::"text"])))),
    CONSTRAINT "recall_notifications_status_enum" CHECK (("status" = ANY (ARRAY['queued'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text", 'bounced'::"text", 'skipped'::"text"])))
);
CREATE TABLE "resupply"."recall_remediation_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recall_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "evidence_url" "text",
    "notes" "text",
    "performed_by_user_id" "text",
    "performed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recall_remediation_actions_action_enum" CHECK (("action" = ANY (ARRAY['returned_to_manufacturer'::"text", 'destroyed'::"text", 'replaced'::"text", 'patient_declined'::"text", 'lost'::"text", 'unreachable'::"text"])))
);
CREATE TABLE "resupply"."report_presets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "format" "text" NOT NULL,
    "range_kind" "text" NOT NULL,
    "range_preset" "text",
    "range_from" "date",
    "range_to" "date",
    "recipient" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "report_presets_format_check" CHECK (("format" = ANY (ARRAY['csv'::"text", 'pdf'::"text", 'iif'::"text", 'qbo.csv'::"text"]))),
    CONSTRAINT "report_presets_name_check" CHECK ((("length"("name") > 0) AND ("length"("name") <= 120))),
    CONSTRAINT "report_presets_range_kind_check" CHECK (("range_kind" = ANY (ARRAY['absolute'::"text", 'preset'::"text"]))),
    CONSTRAINT "report_presets_range_shape" CHECK (((("range_kind" = 'absolute'::"text") AND ("range_from" IS NOT NULL) AND ("range_to" IS NOT NULL) AND ("range_preset" IS NULL)) OR (("range_kind" = 'preset'::"text") AND ("range_preset" IS NOT NULL) AND ("range_from" IS NULL) AND ("range_to" IS NULL))))
);
CREATE TABLE "resupply"."shop_backorders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" character varying(64) NOT NULL,
    "marked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cleared_at" timestamp with time zone,
    "notes" "text",
    "marked_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."shop_order_loss_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "text" NOT NULL,
    "opened_by_user_id" "text",
    "status" character varying(32) DEFAULT 'open'::character varying NOT NULL,
    "carrier_claim_number" character varying(64),
    "resolution_note" "text",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "carrier_filed_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shop_order_loss_claims_status_enum" CHECK ((("status")::"text" = ANY ((ARRAY['open'::character varying, 'carrier_filed'::character varying, 'resolved_refunded'::character varying, 'resolved_reshipped'::character varying, 'closed_unresolved'::character varying])::"text"[])))
);
CREATE TABLE "resupply"."shop_order_nps_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "text" NOT NULL,
    "score" smallint NOT NULL,
    "comment" "text",
    "submitter_ip" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shop_order_nps_responses_comment_length" CHECK ((("comment" IS NULL) OR ("char_length"("comment") <= 2000))),
    CONSTRAINT "shop_order_nps_responses_score_range" CHECK ((("score" >= 0) AND ("score" <= 10)))
);
CREATE TABLE "resupply"."shop_sku_substitutes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "primary_sku" character varying(64) NOT NULL,
    "alternative_sku" character varying(64) NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "notes" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_by_user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."sku_hcpcs_map" (
    "sku_prefix" "text" NOT NULL,
    "hcpcs_code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."therapy_fleet_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "alert_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "outreach_sent_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "resolved_by_email" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "therapy_fleet_alerts_alert_type_check" CHECK (("alert_type" = ANY (ARRAY['compliance_risk'::"text", 'high_ahi'::"text", 'high_leak'::"text", 'usage_decline'::"text", 'no_recent_data'::"text", 'setup_at_risk'::"text"]))),
    CONSTRAINT "therapy_fleet_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "therapy_fleet_alerts_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'resolved'::"text"])))
);
CREATE TABLE "resupply"."therapy_fleet_daily_metrics" (
    "metric_date" "date" NOT NULL,
    "patients_with_data" integer DEFAULT 0 NOT NULL,
    "compliant" integer DEFAULT 0 NOT NULL,
    "at_risk" integer DEFAULT 0 NOT NULL,
    "non_compliant" integer DEFAULT 0 NOT NULL,
    "high_leak" integer DEFAULT 0 NOT NULL,
    "resupply_items_due" integer DEFAULT 0 NOT NULL,
    "setups_in_window" integer DEFAULT 0 NOT NULL,
    "setups_at_risk" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);
CREATE TABLE "resupply"."webhook_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "event_type" character varying(80) NOT NULL,
    "event_payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempt_count" smallint DEFAULT 0 NOT NULL,
    "last_http_status" integer,
    "last_error" "text",
    "next_attempt_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "webhook_deliveries_status_enum" CHECK (("status" = ANY (ARRAY['queued'::"text", 'delivered'::"text", 'failed'::"text", 'exhausted'::"text"])))
);
CREATE TABLE "resupply"."webhook_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(160) NOT NULL,
    "target_url" "text" NOT NULL,
    "signing_secret" "text" NOT NULL,
    "event_types" "text"[] DEFAULT '{*}'::"text"[] NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "max_retries" smallint DEFAULT 5 NOT NULL,
    "last_delivery_at" timestamp with time zone,
    "last_delivery_status" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "webhook_subscriptions_last_status_enum" CHECK ((("last_delivery_status" IS NULL) OR ("last_delivery_status" = ANY (ARRAY['delivered'::"text", 'failed'::"text", 'exhausted'::"text"])))),
    CONSTRAINT "webhook_subscriptions_max_retries_range" CHECK ((("max_retries" >= 0) AND ("max_retries" <= 12)))
);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('b95e9d04-0179-42a7-9648-4b1ee2dbb675', 'resupply_due', 'Resupply due', 'Let a patient know their CPAP supplies are due for reorder.', 'resupply', 'info', '["email", "sms", "voice"]', '["first_name", "practice_name", "item_name", "due_date", "manage_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('b9f3b5f5-ad98-44ac-a135-8bd448cd0b2c', 'order_shipped', 'Order shipped', 'Confirm an order has shipped and share tracking details.', 'orders', 'info', '["email", "sms", "voice"]', '["first_name", "practice_name", "order_number", "carrier", "tracking_number", "tracking_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('ea0f4c0b-32b0-4a17-992a-eb612410ec80', 'order_delivered', 'Order delivered', 'Confirm an order was delivered.', 'orders', 'info', '["email", "sms", "voice"]', '["first_name", "practice_name", "order_number"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('ffb0af46-4581-465a-8de8-b5f5da8c6a91', 'payment_failed', 'Payment failed', 'Alert a patient that a payment did not go through and needs attention.', 'billing', 'warning', '["email", "sms", "voice"]', '["first_name", "practice_name", "amount", "update_payment_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('46ea3494-6beb-4eda-8e5e-c8c820109b81', 'appointment_reminder', 'Appointment reminder', 'Remind a patient of an upcoming appointment.', 'appointments', 'info', '["email", "sms", "voice"]', '["first_name", "practice_name", "appointment_time", "location", "reschedule_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('28607296-3336-4f30-be97-efc41096214a', 'prescription_expiring', 'Prescription expiring', 'Notify a patient that a prescription is about to expire.', 'clinical', 'warning', '["email", "sms", "voice"]', '["first_name", "practice_name", "expires_on", "renew_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('e7849000-1393-4dba-af1e-dbd8af6adb2b', 'equipment_recall', 'Equipment recall notice', 'Notify a patient of a manufacturer recall affecting their device.', 'clinical', 'critical', '["email", "sms", "voice"]', '["first_name", "practice_name", "device_name", "recall_reference"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('8e319009-8ed9-480d-859f-c004297b9005', 'back_in_stock', 'Back in stock', 'Tell a patient a product they wanted is available again.', 'shop', 'info', '["email", "sms", "voice"]', '["first_name", "practice_name", "product_name", "product_url"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_definitions" ("id", "key", "name", "description", "category", "severity", "channels", "allowed_variables", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('0b9ca8fc-79fb-4054-9c80-a1727c2360d3', 'low_usage_checkin', 'Low therapy usage check-in', 'Reach out to a patient whose therapy usage has dropped.', 'clinical', 'warning', '["email", "sms", "voice"]', '["first_name", "practice_name", "nights_used", "coach_phone"]', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('70282787-021d-4699-bbc8-8a46d1db266c', 'resupply_due', 'email', 'Your {{practice_name}} CPAP supplies are due', '<p>Hi {{first_name}},</p><p>Your {{item_name}} is due for resupply on {{due_date}}. Manage your order here: <a href="{{manage_url}}">{{manage_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, your {{item_name}} is due for resupply on {{due_date}}. Manage your order: {{manage_url}} — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('4c29d849-fc10-46b9-8ca6-fe7050a3ef4e', 'resupply_due', 'sms', NULL, NULL, 'Hi {{first_name}}, it is {{practice_name}}. Your {{item_name}} is due for resupply. Reply YES to ship or visit {{manage_url}}. Reply STOP to opt out.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('e3fb4192-1374-4d38-ad6b-13f4084c75ed', 'resupply_due', 'voice', NULL, NULL, 'Hi {{first_name}}, this is a message from {{practice_name}}. Your C-PAP supplies are due for resupply. Please call us back or visit your account to place your order. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('b6e51870-2483-4a9d-b8c0-689414cea600', 'order_shipped', 'email', 'Your {{practice_name}} order has shipped', '<p>Hi {{first_name}},</p><p>Good news — order {{order_number}} has shipped via {{carrier}}. Tracking number {{tracking_number}}. Track it here: <a href="{{tracking_url}}">{{tracking_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, order {{order_number}} has shipped via {{carrier}}. Tracking {{tracking_number}}: {{tracking_url}} — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('4d3aaa5c-9fcb-4294-aa83-4a5616fb174e', 'order_shipped', 'sms', NULL, NULL, 'Hi {{first_name}}, your {{practice_name}} order {{order_number}} shipped via {{carrier}}. Track it: {{tracking_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('53880c57-88d6-4123-a23f-d87c4e20c120', 'order_shipped', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. Good news, your order {{order_number}} has shipped and is on its way. Check your email or text messages for tracking details. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('8f1045f0-0137-47d0-b61c-d3f83b3a7727', 'order_delivered', 'email', 'Your {{practice_name}} order was delivered', '<p>Hi {{first_name}},</p><p>Order {{order_number}} has been delivered. If anything is missing or damaged, just reply and we will help.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, order {{order_number}} has been delivered. Reply if anything is missing or damaged. — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('21604d06-93d2-4569-9629-4d839861f283', 'order_delivered', 'sms', NULL, NULL, 'Hi {{first_name}}, your {{practice_name}} order {{order_number}} was delivered. Reply if anything is missing or damaged.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('7fd11177-adae-45f4-a0f1-7c6c041be12a', 'order_delivered', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. Your order {{order_number}} has been delivered. If anything is missing or damaged, please give us a call. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('7c66bf42-fffa-4434-a9b3-daeb50e02287', 'payment_failed', 'email', 'Action needed: payment issue on your {{practice_name}} account', '<p>Hi {{first_name}},</p><p>We were unable to process your payment of {{amount}}. Please update your payment method to avoid a delay: <a href="{{update_payment_url}}">{{update_payment_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, we could not process your payment of {{amount}}. Update your payment method: {{update_payment_url}} — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('75ffb99b-a5ae-4f9a-8212-08aa37cfd70d', 'payment_failed', 'sms', NULL, NULL, 'Hi {{first_name}}, {{practice_name}} could not process your payment of {{amount}}. Please update it here: {{update_payment_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('b4a699cf-6d79-4b0d-9c98-26f36b9e7afe', 'payment_failed', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. We were unable to process a recent payment on your account. Please call us back or check your email to update your payment method. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('f564dfaa-7ecc-4b57-bf65-5376fe6b8839', 'appointment_reminder', 'email', 'Reminder: your {{practice_name}} appointment', '<p>Hi {{first_name}},</p><p>This is a reminder of your appointment on {{appointment_time}} at {{location}}. Need to reschedule? <a href="{{reschedule_url}}">{{reschedule_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, reminder: your appointment is {{appointment_time}} at {{location}}. Reschedule: {{reschedule_url}} — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('1609a76e-a8da-416a-9de9-ac6a14b6684d', 'appointment_reminder', 'sms', NULL, NULL, 'Hi {{first_name}}, reminder from {{practice_name}}: appointment {{appointment_time}} at {{location}}. Reschedule: {{reschedule_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('50950a8c-2331-4c29-838f-b32ace3d997e', 'appointment_reminder', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}} with a reminder about your upcoming appointment on {{appointment_time}} at {{location}}. If you need to reschedule, please call us back. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('42de3193-5ee1-485e-a4d8-e7c1d4d79520', 'prescription_expiring', 'email', 'Your prescription is expiring soon', '<p>Hi {{first_name}},</p><p>Your prescription on file expires on {{expires_on}}. Renew it now so your therapy is not interrupted: <a href="{{renew_url}}">{{renew_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, your prescription expires on {{expires_on}}. Renew it here: {{renew_url}} — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('f515918a-50fe-422d-982a-505411166858', 'prescription_expiring', 'sms', NULL, NULL, 'Hi {{first_name}}, your {{practice_name}} prescription expires {{expires_on}}. Renew now: {{renew_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('f2a39814-5c1d-48ff-a654-e4a9dc6f4a30', 'prescription_expiring', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. Your prescription on file is expiring soon. Please call us back so we can help you renew it and keep your therapy on track. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('49aca2bb-be1e-44f3-879e-366ef47e02b5', 'equipment_recall', 'email', 'Important recall notice for your device', '<p>Hi {{first_name}},</p><p>This is a manufacturer recall notice from {{practice_name}} regarding your {{device_name}} (reference {{recall_reference}}). Please contact us so we can arrange next steps.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, this is a recall notice from {{practice_name}} for your {{device_name}} (ref {{recall_reference}}). Please contact us for next steps. — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('6b914f3e-1f55-417f-a7b9-147e04276fc3', 'equipment_recall', 'sms', NULL, NULL, 'Important: {{practice_name}} recall notice for your {{device_name}} (ref {{recall_reference}}). Please call us back so we can help with next steps.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('d6bb8dd2-8692-47b3-a458-8f6c75af14aa', 'equipment_recall', 'voice', NULL, NULL, 'Hi {{first_name}}, this is an important recall notice from {{practice_name}} regarding your {{device_name}}. Please call us back at your earliest convenience so we can arrange next steps. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('7f5c9b2e-2202-46c2-a500-3ab4ab6a309f', 'back_in_stock', 'email', '{{product_name}} is back in stock', '<p>Hi {{first_name}},</p><p>The item you asked us to watch, {{product_name}}, is back in stock. Grab one here: <a href="{{product_url}}">{{product_url}}</a>.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, {{product_name}} is back in stock at {{practice_name}}. Grab one: {{product_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('bea4f872-0b4c-49e0-b5d5-916faa2cb5d7', 'back_in_stock', 'sms', NULL, NULL, 'Hi {{first_name}}, {{product_name}} is back in stock at {{practice_name}}: {{product_url}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('5d2bb904-bda9-48f4-8fe5-f03b643eed6a', 'back_in_stock', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. The item you asked us to watch is back in stock. Check your email or visit our store to order. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('f8c4dbc4-8171-4991-a60e-b5b644c4569e', 'low_usage_checkin', 'email', 'Checking in on your therapy', '<p>Hi {{first_name}},</p><p>We noticed your therapy usage has dropped to about {{nights_used}} nights recently. We are here to help — call our coaching line at {{coach_phone}} any time.</p><p>— {{practice_name}}</p>', 'Hi {{first_name}}, we noticed your therapy dropped to about {{nights_used}} nights. We are here to help — call {{coach_phone}}. — {{practice_name}}', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('d6404d16-e002-42b6-a011-d7728995fecf', 'low_usage_checkin', 'sms', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}}. We noticed your therapy usage dropped recently. We are here to help — call {{coach_phone}}.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."alert_messages" ("id", "alert_key", "channel", "subject", "body_html", "body_text", "is_active", "created_at", "created_by", "updated_at", "updated_by") VALUES ('f9688661-a727-4de0-8482-4a5abf4ac59f', 'low_usage_checkin', 'voice', NULL, NULL, 'Hi {{first_name}}, this is {{practice_name}} checking in. We noticed your therapy usage has dropped recently and we would love to help. Please call our coaching line when you have a moment. Thank you.', true, '2026-05-31 16:58:13.071612+00', NULL, '2026-05-31 16:58:13.071612+00', NULL);
INSERT INTO "resupply"."claim_templates" ("id", "slug", "display_name", "description", "lines_json", "default_diagnosis_codes", "scoped_payer_profile_id", "is_active", "created_at", "updated_at") VALUES ('adf0d7fe-e3ea-49a6-99a0-4fd7feea726a', 'monthly_resupply_basic', 'Monthly Resupply — Basic', 'Standard monthly resupply: cushion + tubing + 2 filters.', '{"lines": [{"hcpcs": "A7032", "units": 1, "modifiers": "NU", "description": "Nasal cushion", "billed_cents": 2899}, {"hcpcs": "A7037", "units": 1, "modifiers": "NU", "description": "Standard tubing", "billed_cents": 2499}, {"hcpcs": "A7038", "units": 2, "modifiers": "NU", "description": "Disposable filters", "billed_cents": 1599}]}', '{G47.33}', NULL, true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."claim_templates" ("id", "slug", "display_name", "description", "lines_json", "default_diagnosis_codes", "scoped_payer_profile_id", "is_active", "created_at", "updated_at") VALUES ('5127b923-dd6d-456f-ad92-355ec0d4c887', 'monthly_resupply_full', 'Monthly Resupply — Full', 'Resupply including new mask + headgear.', '{"lines": [{"hcpcs": "A7034", "units": 1, "modifiers": "NU", "description": "Nasal mask", "billed_cents": 9499}, {"hcpcs": "A7035", "units": 1, "modifiers": "NU", "description": "Headgear", "billed_cents": 3199}, {"hcpcs": "A7037", "units": 1, "modifiers": "NU", "description": "Standard tubing", "billed_cents": 2499}, {"hcpcs": "A7038", "units": 2, "modifiers": "NU", "description": "Disposable filters", "billed_cents": 1599}, {"hcpcs": "A7046", "units": 1, "modifiers": "NU", "description": "Humidifier chamber", "billed_cents": 4499}]}', '{G47.33}', NULL, true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."claim_templates" ("id", "slug", "display_name", "description", "lines_json", "default_diagnosis_codes", "scoped_payer_profile_id", "is_active", "created_at", "updated_at") VALUES ('9c438905-3e1c-47a5-a4d5-a42336230088', 'rental_month_1', 'CPAP Rental — Month 1', 'Initial capped-rental month of E0601 + humidifier.', '{"lines": [{"hcpcs": "E0601", "units": 1, "modifiers": "RR,KH", "description": "CPAP device, month 1", "billed_cents": 89500}, {"hcpcs": "E0562", "units": 1, "modifiers": "RR", "description": "Humidifier", "billed_cents": 31900}]}', '{G47.33}', NULL, true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."claim_templates" ("id", "slug", "display_name", "description", "lines_json", "default_diagnosis_codes", "scoped_payer_profile_id", "is_active", "created_at", "updated_at") VALUES ('238f65f7-9be6-41b5-b9de-beabf8097e08', 'rental_month_4_plus', 'CPAP Rental — Month 4+', 'Continuing capped-rental month of E0601 (KI+KX) + humidifier.', '{"lines": [{"hcpcs": "E0601", "units": 1, "modifiers": "RR,KI,KX", "description": "CPAP device, month 4+", "billed_cents": 89500}, {"hcpcs": "E0562", "units": 1, "modifiers": "RR", "description": "Humidifier", "billed_cents": 31900}]}', '{G47.33}', NULL, true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7030', 'Full face mask interface', 'mask', 90, 1, 90, true, 'CMS LCD L33718. One every 3 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7031', 'Full face mask cushion (replacement)', 'cushion', 30, 1, 30, true, 'CMS LCD L33718. One per month.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7032', 'Nasal mask cushion (replacement)', 'cushion', 15, 2, 30, true, 'CMS LCD L33718. Two per month.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7033', 'Nasal pillows (replacement)', 'pillow', 15, 2, 30, true, 'CMS LCD L33718. Two per month.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7034', 'Nasal mask interface', 'mask', 90, 1, 90, true, 'CMS LCD L33718. One every 3 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7035', 'Headgear', 'headgear', 180, 1, 180, true, 'CMS LCD L33718. One every 6 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7036', 'Chinstrap', 'chinstrap', 180, 1, 180, true, 'CMS LCD L33718. One every 6 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7037', 'Tubing', 'tubing', 90, 1, 90, true, 'CMS LCD L33718. One every 3 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7038', 'Disposable filter', 'filter', 15, 2, 30, true, 'CMS LCD L33718. Two per month.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7039', 'Reusable (non-disposable) filter', 'filter', 180, 1, 180, true, 'CMS LCD L33718. One every 6 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7044', 'Oral interface', 'mask', 90, 1, 90, true, 'CMS LCD L33718. One every 3 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A7046', 'Humidifier water chamber', 'chamber', 180, 1, 180, true, 'CMS LCD L33718. One every 6 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('A4604', 'Heated tubing with sensor', 'tubing', 90, 1, 90, true, 'CMS LCD L33718. One every 3 months.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."hcpcs_codes" ("code", "short_description", "category", "min_interval_days", "max_quantity_per_period", "period_days", "active", "notes", "created_at", "updated_at") VALUES ('E0601', 'CPAP device (E0601)', 'device', 1825, 1, 1825, true, 'CMS pays a replacement device every 5 years.', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('fae87421-b652-452b-a6f2-90439da3b56d', '077270ec-49f1-40e3-82b5-02834feee353', 'A7034', 'if_compliant_90day', 'KX', 30, 'Compliant mask resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('c4f8b8d1-2226-46a7-bc2c-1a683cf9e757', '077270ec-49f1-40e3-82b5-02834feee353', 'E0471', 'if_rental_month_le_3', 'KH', 10, 'BPAP-ST capped-rental months 1-3', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('04ad8c93-e673-4fe2-aeeb-b56669f17300', '077270ec-49f1-40e3-82b5-02834feee353', 'A7032', 'if_compliant_90day', 'KX', 30, 'Compliant cushion resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('356326e6-29ac-44a2-a512-60996e4ff893', '077270ec-49f1-40e3-82b5-02834feee353', 'A7035', 'if_compliant_90day', 'KX', 30, 'Compliant headgear resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('9ebb35cf-ffe7-4871-8ca6-5d35df4f8bdb', '077270ec-49f1-40e3-82b5-02834feee353', 'E0601', 'if_purchased', 'NU', 20, 'Outright purchase (rare for DME)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('d71c7e64-0427-4856-aa99-f850cd9e9aad', '077270ec-49f1-40e3-82b5-02834feee353', 'E0470', 'if_rental_month_ge_4', 'KI,KX', 10, 'BPAP capped-rental months 4-13 with compliance proven', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('f8af9417-7803-4e62-b49d-771c927783b3', '077270ec-49f1-40e3-82b5-02834feee353', 'E0601', 'if_rental_month_ge_4', 'KI,KX', 10, 'Medicare capped-rental months 4-13 use KI (continuing) + KX (compliance proven)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('11ea3992-9013-4c2b-a219-129fcda1cbbd', '077270ec-49f1-40e3-82b5-02834feee353', 'A7033', 'if_compliant_90day', 'KX', 30, 'Compliant nasal-pillow cushion resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('7e79ab73-b646-4411-a206-c72fca726870', '077270ec-49f1-40e3-82b5-02834feee353', 'E0470', 'if_rental_month_le_3', 'KH', 10, 'BPAP capped-rental months 1-3', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('dc1cfe6f-20b4-4ab9-8582-16b1e1c2fca1', '077270ec-49f1-40e3-82b5-02834feee353', 'A7046', 'if_compliant_90day', 'KX', 30, 'Compliant humidifier chamber resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('8dd2573a-daec-4367-a63e-50693a636c36', '077270ec-49f1-40e3-82b5-02834feee353', 'E0601', 'if_rental_month_le_3', 'KH', 10, 'Medicare capped-rental months 1-3 use the KH modifier (initial)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('ef0994e2-1145-4e6f-87df-1ea5cf2e1274', '077270ec-49f1-40e3-82b5-02834feee353', 'A7038', 'if_compliant_90day', 'KX', 30, 'Compliant disposable filter resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('32d8b2dd-5a52-4a96-a83e-d5a7bfb63818', '077270ec-49f1-40e3-82b5-02834feee353', 'A7037', 'if_compliant_90day', 'KX', 30, 'Compliant tubing resupply per LCD L33718', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."payer_modifier_rules" ("id", "payer_profile_id", "hcpcs_code", "condition", "modifiers_csv", "priority", "rationale", "is_active", "created_at", "updated_at") VALUES ('fe1abee4-3831-48d6-a2f8-7ad4ee26c5a9', '077270ec-49f1-40e3-82b5-02834feee353', 'E0471', 'if_rental_month_ge_4', 'KI,KX', 10, 'BPAP-ST capped-rental months 4-13 with compliance proven', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('ee5877b4-9be0-4a84-93ac-dde5bd16fdf2', 'item_sku', 'cpap-machine', 'E0601', 'RR', 1, 89500, 'CPAP device — continuous positive airway pressure (rental cadence)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('db863368-b22a-4674-82fa-80900b5f5390', 'item_sku', 'auto-cpap-machine', 'E0601', 'RR', 1, 89500, 'Auto-titrating CPAP — billed identically to E0601 on rental cycle', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('9ac3ac4e-1e96-43dc-8ae6-694dbc45c3c6', 'item_sku', 'bipap-machine', 'E0470', 'RR', 1, 124500, 'Bilevel PAP without backup rate', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('36451be6-38dd-4687-821a-c352bd016282', 'item_sku', 'bipap-st-machine', 'E0471', 'RR', 1, 198500, 'Bilevel PAP with backup rate (ST)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('e09b95b4-8aff-4c5d-aa58-2773478c3b68', 'item_sku', 'humidifier', 'E0562', 'RR', 1, 31900, 'Heated humidifier — separate billing code on rental cycle', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('ce13b70b-734f-4981-bdc2-08ec25852d90', 'item_sku', 'oxygen-concentrator', 'E1390', 'RR', 1, 18000, 'Stationary oxygen concentrator — monthly rental', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('264380fa-b759-4d3f-a0cf-2677ea5e384e', 'item_sku', 'nasal-mask', 'A7034', 'NU', 1, 9499, 'Nasal CPAP mask interface', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('5df57f44-c0cb-4a98-9686-06e169825779', 'item_sku', 'nasal-pillow-mask', 'A7034', 'NU', 1, 9499, 'Nasal pillow CPAP mask interface', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('aed82e03-9b89-4234-91b7-ab161c6f3595', 'item_sku', 'full-face-mask', 'A7030', 'NU', 1, 11899, 'Full-face CPAP mask interface', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('835a26c6-3d96-4101-84d1-296ec786b2fc', 'item_sku', 'mask-cushion-nasal', 'A7032', 'NU', 1, 2899, 'Replacement nasal mask cushion', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('2f21c39e-7078-402f-9014-a374076ca72e', 'item_sku', 'mask-cushion-full-face', 'A7031', 'NU', 1, 3199, 'Replacement full-face mask cushion', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('86eff9b6-5f33-4c51-bd69-d4a9fa02f62e', 'item_sku', 'mask-cushion-pillows', 'A7033', 'NU', 1, 2899, 'Replacement nasal-pillow cushions (pair)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('e7b2524d-8973-4682-b1a4-ae2fdff97c7e', 'item_sku', 'mask-headgear', 'A7035', 'NU', 1, 3199, 'CPAP headgear', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('99a59567-1b08-4e73-8fc9-6c8ca7754dfb', 'item_sku', 'mask-chinstrap', 'A7036', 'NU', 1, 2199, 'CPAP chinstrap', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('529321df-9883-416c-ad0d-5ae081f94db2', 'item_sku', 'tubing-standard', 'A7037', 'NU', 1, 2499, 'CPAP tubing — standard (non-heated)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('5a08b04c-4a95-46c8-a69b-b759cfa10512', 'item_sku', 'tubing-heated', 'A4604', 'NU', 1, 4899, 'CPAP tubing — heated', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('a0e89c4d-7024-45ff-8dfe-6f5889b5f866', 'item_sku', 'filter-disposable', 'A7038', 'NU', 2, 1599, 'Disposable filter (typically dispensed in pairs)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('7c2305e6-e1b8-4d07-9ead-f59065f0c879', 'item_sku', 'filter-reusable', 'A7039', 'NU', 1, 1899, 'Reusable / pollen filter', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('10a30cbb-c745-411f-9361-84062c9d646b', 'item_sku', 'humidifier-chamber', 'A7046', 'NU', 1, 4499, 'Water chamber for heated humidifier', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('c1d15a24-786b-4b02-bcbe-30747ebdacac', 'item_sku', 'oxygen-cannula', 'A4615', 'NU', 1, 599, 'Nasal cannula', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."product_hcpcs_map" ("id", "lookup_kind", "lookup_value", "hcpcs_code", "default_modifiers", "units_per_dispense", "default_billed_cents", "description", "is_active", "created_at", "updated_at") VALUES ('e4750922-4024-45a1-a573-47f28e476735', 'item_sku', 'oxygen-tubing', 'A4616', 'NU', 1, 999, 'Oxygen tubing — per foot (sold in standard 7ft lengths)', true, '2026-05-31 16:58:12.383354+00', '2026-05-31 16:58:12.383354+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('MASK', 'A7034', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('CUSHION', 'A7032', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('PILLOW', 'A7033', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('FILTER-DISP', 'A7038', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('FILTER-REUSE', 'A7039', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('TUBING', 'A7037', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('HEADGEAR', 'A7035', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('CHINSTRAP', 'A7036', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
INSERT INTO "resupply"."sku_hcpcs_map" ("sku_prefix", "hcpcs_code", "created_at", "updated_at") VALUES ('CHAMBER', 'A7046', '2026-05-31 16:58:13.049922+00', '2026-05-31 16:58:13.049922+00');
ALTER TABLE ONLY "resupply"."alert_definitions"
    ADD CONSTRAINT "alert_definitions_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."alert_message_overrides"
    ADD CONSTRAINT "alert_message_overrides_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."alert_messages"
    ADD CONSTRAINT "alert_messages_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."bulk_campaign_recipients"
    ADD CONSTRAINT "bulk_campaign_recipients_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."bulk_campaigns"
    ADD CONSTRAINT "bulk_campaigns_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."claim_appeal_letters"
    ADD CONSTRAINT "claim_appeal_letters_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."claim_denial_analyses"
    ADD CONSTRAINT "claim_denial_analyses_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."claim_scrub_results"
    ADD CONSTRAINT "claim_scrub_results_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."claim_templates"
    ADD CONSTRAINT "claim_templates_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."claim_templates"
    ADD CONSTRAINT "claim_templates_slug_key" UNIQUE ("slug");
ALTER TABLE ONLY "resupply"."clearinghouse_credentials"
    ADD CONSTRAINT "clearinghouse_credentials_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."clearinghouse_inbound_files"
    ADD CONSTRAINT "clearinghouse_inbound_files_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."clinician_share_tokens"
    ADD CONSTRAINT "clinician_share_tokens_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."conversation_coaching_notes"
    ADD CONSTRAINT "conversation_coaching_notes_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."csr_shifts"
    ADD CONSTRAINT "csr_shifts_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."dispense_readiness_reviews"
    ADD CONSTRAINT "dispense_readiness_reviews_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."dme_organization_contacts"
    ADD CONSTRAINT "dme_organization_contacts_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."dme_organization"
    ADD CONSTRAINT "dme_organization_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."equipment_assets"
    ADD CONSTRAINT "equipment_assets_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."equipment_recalls"
    ADD CONSTRAINT "equipment_recalls_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."good_faith_estimates"
    ADD CONSTRAINT "good_faith_estimates_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."hcpcs_codes"
    ADD CONSTRAINT "hcpcs_codes_pkey" PRIMARY KEY ("code");
ALTER TABLE ONLY "resupply"."inbound_faxes"
    ADD CONSTRAINT "inbound_faxes_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."inbound_referral_preflight_checks"
    ADD CONSTRAINT "inbound_referral_preflight_checks_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."inbound_referral_status_outbox"
    ADD CONSTRAINT "inbound_referral_status_outbox_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."inventory_reconciliation_lines"
    ADD CONSTRAINT "inventory_reconciliation_lines_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."inventory_reconciliation_lines"
    ADD CONSTRAINT "inventory_reconciliation_lines_unique_per_recon" UNIQUE ("reconciliation_id", "product_id");
ALTER TABLE ONLY "resupply"."inventory_reconciliations"
    ADD CONSTRAINT "inventory_reconciliations_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."low_stock_alert_state"
    ADD CONSTRAINT "low_stock_alert_state_pkey" PRIMARY KEY ("product_id");
ALTER TABLE ONLY "resupply"."office_closures"
    ADD CONSTRAINT "office_closures_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."office_recurring_closures"
    ADD CONSTRAINT "office_recurring_closures_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_address_history"
    ADD CONSTRAINT "patient_address_history_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_coaching_plans"
    ADD CONSTRAINT "patient_coaching_plans_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_fit_overrides"
    ADD CONSTRAINT "patient_fit_overrides_pkey" PRIMARY KEY ("patient_id");
ALTER TABLE ONLY "resupply"."patient_form_acknowledgements"
    ADD CONSTRAINT "patient_form_acknowledgements_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_grievances"
    ADD CONSTRAINT "patient_grievances_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_identity_verifications"
    ADD CONSTRAINT "patient_identity_verifications_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_maintenance_log"
    ADD CONSTRAINT "patient_maintenance_log_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_maintenance_nudges"
    ADD CONSTRAINT "patient_maintenance_nudges_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_referrals"
    ADD CONSTRAINT "patient_referrals_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_therapy_milestones"
    ADD CONSTRAINT "patient_therapy_milestones_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."patient_worklist_actions"
    ADD CONSTRAINT "patient_worklist_actions_pkey" PRIMARY KEY ("patient_id");
ALTER TABLE ONLY "resupply"."payer_modifier_rules"
    ADD CONSTRAINT "payer_modifier_rules_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."prescription_request_packets"
    ADD CONSTRAINT "prescription_request_packets_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."product_hcpcs_map"
    ADD CONSTRAINT "product_hcpcs_map_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."providers_pecos_status"
    ADD CONSTRAINT "providers_pecos_status_pkey" PRIMARY KEY ("npi");
ALTER TABLE ONLY "resupply"."recall_notifications"
    ADD CONSTRAINT "recall_notifications_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."recall_remediation_actions"
    ADD CONSTRAINT "recall_remediation_actions_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."report_presets"
    ADD CONSTRAINT "report_presets_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."shop_backorders"
    ADD CONSTRAINT "shop_backorders_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."shop_order_loss_claims"
    ADD CONSTRAINT "shop_order_loss_claims_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."shop_order_nps_responses"
    ADD CONSTRAINT "shop_order_nps_responses_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."shop_sku_substitutes"
    ADD CONSTRAINT "shop_sku_substitutes_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."sku_hcpcs_map"
    ADD CONSTRAINT "sku_hcpcs_map_pkey" PRIMARY KEY ("sku_prefix");
ALTER TABLE ONLY "resupply"."therapy_fleet_alerts"
    ADD CONSTRAINT "therapy_fleet_alerts_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."therapy_fleet_daily_metrics"
    ADD CONSTRAINT "therapy_fleet_daily_metrics_pkey" PRIMARY KEY ("metric_date");
ALTER TABLE ONLY "resupply"."webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "resupply"."webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id");
CREATE INDEX "alert_definitions_active_category_idx" ON "resupply"."alert_definitions" USING "btree" ("is_active", "category");
CREATE UNIQUE INDEX "alert_definitions_key_idx" ON "resupply"."alert_definitions" USING "btree" ("key");
CREATE UNIQUE INDEX "alert_message_overrides_unique_idx" ON "resupply"."alert_message_overrides" USING "btree" ("patient_id", "alert_key", "channel");
CREATE INDEX "alert_messages_active_key_idx" ON "resupply"."alert_messages" USING "btree" ("is_active", "alert_key");
CREATE UNIQUE INDEX "alert_messages_key_channel_idx" ON "resupply"."alert_messages" USING "btree" ("alert_key", "channel");
CREATE INDEX "bulk_campaign_recipients_campaign_idx" ON "resupply"."bulk_campaign_recipients" USING "btree" ("campaign_id");
CREATE UNIQUE INDEX "bulk_campaign_recipients_campaign_recipient_unique" ON "resupply"."bulk_campaign_recipients" USING "btree" ("campaign_id", "recipient_kind", "recipient_id");
CREATE INDEX "bulk_campaign_recipients_campaign_status_idx" ON "resupply"."bulk_campaign_recipients" USING "btree" ("campaign_id", "status");
CREATE INDEX "bulk_campaigns_status_created_idx" ON "resupply"."bulk_campaigns" USING "btree" ("status", "created_at");
CREATE INDEX "claim_appeal_letters_claim_idx" ON "resupply"."claim_appeal_letters" USING "btree" ("claim_id", "created_at" DESC);
CREATE INDEX "claim_denial_analyses_claim_idx" ON "resupply"."claim_denial_analyses" USING "btree" ("claim_id", "created_at" DESC);
CREATE INDEX "claim_denial_analyses_pending_idx" ON "resupply"."claim_denial_analyses" USING "btree" ("review_status", "created_at" DESC) WHERE ("review_status" = 'pending'::"text");
CREATE INDEX "claim_scrub_results_claim_idx" ON "resupply"."claim_scrub_results" USING "btree" ("claim_id", "created_at" DESC);
CREATE INDEX "claim_scrub_results_pending_idx" ON "resupply"."claim_scrub_results" USING "btree" ("review_status", "created_at" DESC) WHERE ("review_status" = 'pending'::"text");
CREATE INDEX "claim_templates_active_idx" ON "resupply"."claim_templates" USING "btree" ("is_active") WHERE ("is_active" = true);
CREATE INDEX "clearinghouse_credentials_active_idx" ON "resupply"."clearinghouse_credentials" USING "btree" ("is_active") WHERE ("is_active" = true);
CREATE UNIQUE INDEX "clearinghouse_credentials_slug_env_uq" ON "resupply"."clearinghouse_credentials" USING "btree" ("slug", "usage_indicator");
CREATE INDEX "clearinghouse_inbound_files_downloaded_idx" ON "resupply"."clearinghouse_inbound_files" USING "btree" ("clearinghouse_id", "downloaded_at" DESC);
CREATE INDEX "clearinghouse_inbound_files_pending_idx" ON "resupply"."clearinghouse_inbound_files" USING "btree" ("dispatch_status", "downloaded_at") WHERE ("dispatch_status" = ANY (ARRAY['pending'::"text", 'parsed'::"text", 'dispatch_failed'::"text"]));
CREATE UNIQUE INDEX "clearinghouse_inbound_files_sha_uq" ON "resupply"."clearinghouse_inbound_files" USING "btree" ("clearinghouse_id", "file_sha256");
CREATE INDEX "clinician_share_tokens_active_idx" ON "resupply"."clinician_share_tokens" USING "btree" ("referral_id", "expires_at") WHERE ("revoked_at" IS NULL);
CREATE INDEX "clinician_share_tokens_referral_idx" ON "resupply"."clinician_share_tokens" USING "btree" ("referral_id", "created_at" DESC);
CREATE INDEX "conversation_coaching_notes_conv_idx" ON "resupply"."conversation_coaching_notes" USING "btree" ("conversation_id");
CREATE INDEX "conversation_coaching_notes_target_idx" ON "resupply"."conversation_coaching_notes" USING "btree" ("target_user_id");
CREATE INDEX "csr_shifts_range_idx" ON "resupply"."csr_shifts" USING "btree" ("starts_at", "ends_at");
CREATE INDEX "csr_shifts_staff_idx" ON "resupply"."csr_shifts" USING "btree" ("staff_user_id", "starts_at");
CREATE INDEX "dispense_readiness_patient_idx" ON "resupply"."dispense_readiness_reviews" USING "btree" ("patient_id", "created_at" DESC);
CREATE INDEX "dispense_readiness_pending_idx" ON "resupply"."dispense_readiness_reviews" USING "btree" ("review_status", "created_at" DESC) WHERE ("review_status" = 'pending'::"text");
CREATE INDEX "dispense_readiness_verdict_idx" ON "resupply"."dispense_readiness_reviews" USING "btree" ("overall_verdict", "created_at" DESC) WHERE ("overall_verdict" = ANY (ARRAY['gaps_with_fixable'::"text", 'gaps_with_blocking'::"text"]));
CREATE INDEX "dme_organization_contacts_org_idx" ON "resupply"."dme_organization_contacts" USING "btree" ("organization_id", "role");
CREATE UNIQUE INDEX "dme_organization_singleton_uq" ON "resupply"."dme_organization" USING "btree" ("singleton") WHERE ("singleton" = true);
CREATE INDEX "equipment_assets_manufacturer_model_status_idx" ON "resupply"."equipment_assets" USING "btree" ("manufacturer", "model", "status");
CREATE UNIQUE INDEX "equipment_assets_manufacturer_serial_unique" ON "resupply"."equipment_assets" USING "btree" ("manufacturer", "serial_number");
CREATE INDEX "equipment_assets_patient_idx" ON "resupply"."equipment_assets" USING "btree" ("patient_id");
CREATE UNIQUE INDEX "equipment_recalls_reference_unique" ON "resupply"."equipment_recalls" USING "btree" ("recall_reference");
CREATE INDEX "equipment_recalls_status_idx" ON "resupply"."equipment_recalls" USING "btree" ("status", "severity");
CREATE INDEX "good_faith_estimates_created_idx" ON "resupply"."good_faith_estimates" USING "btree" ("created_at" DESC);
CREATE INDEX "good_faith_estimates_customer_idx" ON "resupply"."good_faith_estimates" USING "btree" ("customer_id", "created_at" DESC) WHERE ("customer_id" IS NOT NULL);
CREATE INDEX "inbound_faxes_attached_patient_idx" ON "resupply"."inbound_faxes" USING "btree" ("attached_patient_id");
CREATE INDEX "inbound_faxes_status_received_at_idx" ON "resupply"."inbound_faxes" USING "btree" ("status", "received_at");
CREATE UNIQUE INDEX "inbound_faxes_twilio_fax_sid_unique" ON "resupply"."inbound_faxes" USING "btree" ("twilio_fax_sid");
CREATE INDEX "inbound_referral_preflight_referral_kind_idx" ON "resupply"."inbound_referral_preflight_checks" USING "btree" ("referral_id", "check_kind", "created_at" DESC);
CREATE INDEX "inbound_referral_status_outbox_due_idx" ON "resupply"."inbound_referral_status_outbox" USING "btree" ("status", "next_attempt_at") WHERE ("status" = 'queued'::"text");
CREATE INDEX "inbound_referral_status_outbox_referral_idx" ON "resupply"."inbound_referral_status_outbox" USING "btree" ("referral_id", "created_at" DESC);
CREATE INDEX "inventory_reconciliation_lines_recon_idx" ON "resupply"."inventory_reconciliation_lines" USING "btree" ("reconciliation_id");
CREATE INDEX "inventory_reconciliations_started_at_idx" ON "resupply"."inventory_reconciliations" USING "btree" ("started_at" DESC);
CREATE INDEX "office_closures_ends_at_idx" ON "resupply"."office_closures" USING "btree" ("ends_at");
CREATE INDEX "office_recurring_closures_day_idx" ON "resupply"."office_recurring_closures" USING "btree" ("day_of_week");
CREATE INDEX "patient_address_history_patient_idx" ON "resupply"."patient_address_history" USING "btree" ("patient_id");
CREATE INDEX "patient_coaching_plans_open_idx" ON "resupply"."patient_coaching_plans" USING "btree" ("opened_at") WHERE ("closed_at" IS NULL);
CREATE INDEX "patient_coaching_plans_patient_idx" ON "resupply"."patient_coaching_plans" USING "btree" ("patient_id");
CREATE INDEX "patient_form_acks_patient_idx" ON "resupply"."patient_form_acknowledgements" USING "btree" ("patient_id");
CREATE UNIQUE INDEX "patient_form_acks_patient_kind_version_unique" ON "resupply"."patient_form_acknowledgements" USING "btree" ("patient_id", "form_kind", "form_version");
CREATE INDEX "patient_grievances_patient_idx" ON "resupply"."patient_grievances" USING "btree" ("patient_id");
CREATE INDEX "patient_grievances_status_severity_received_idx" ON "resupply"."patient_grievances" USING "btree" ("status", "severity", "received_at");
CREATE INDEX "patient_identity_verifications_patient_idx" ON "resupply"."patient_identity_verifications" USING "btree" ("patient_id");
CREATE INDEX "patient_maintenance_log_patient_task_completed_idx" ON "resupply"."patient_maintenance_log" USING "btree" ("patient_id", "task_key", "completed_at");
CREATE INDEX "patient_maintenance_nudges_patient_sent_at_idx" ON "resupply"."patient_maintenance_nudges" USING "btree" ("patient_id", "sent_at");
CREATE UNIQUE INDEX "patient_referrals_code_unique" ON "resupply"."patient_referrals" USING "btree" ("code");
CREATE INDEX "patient_referrals_referrer_idx" ON "resupply"."patient_referrals" USING "btree" ("referrer_patient_id");
CREATE UNIQUE INDEX "patient_therapy_milestones_unique_kind_idx" ON "resupply"."patient_therapy_milestones" USING "btree" ("patient_id", "milestone_kind");
CREATE INDEX "patient_therapy_milestones_unsent_idx" ON "resupply"."patient_therapy_milestones" USING "btree" ("created_at" DESC) WHERE ("notified_at" IS NULL);
CREATE INDEX "patient_worklist_actions_snooze_idx" ON "resupply"."patient_worklist_actions" USING "btree" ("snooze_until") WHERE ("snooze_until" IS NOT NULL);
CREATE INDEX "payer_modifier_rules_payer_hcpcs_idx" ON "resupply"."payer_modifier_rules" USING "btree" ("payer_profile_id", "hcpcs_code", "priority") WHERE ("is_active" = true);
CREATE INDEX "prescription_request_packets_open_idx" ON "resupply"."prescription_request_packets" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['draft'::"text", 'sent_fax'::"text", 'delivered'::"text"]));
CREATE INDEX "prescription_request_packets_patient_idx" ON "resupply"."prescription_request_packets" USING "btree" ("patient_id", "created_at" DESC);
CREATE UNIQUE INDEX "prescription_request_packets_vendor_ref_uq" ON "resupply"."prescription_request_packets" USING "btree" ("vendor_ref") WHERE ("vendor_ref" IS NOT NULL);
CREATE INDEX "product_hcpcs_map_hcpcs_idx" ON "resupply"."product_hcpcs_map" USING "btree" ("hcpcs_code");
CREATE UNIQUE INDEX "product_hcpcs_map_lookup_uq" ON "resupply"."product_hcpcs_map" USING "btree" ("lookup_kind", "lookup_value");
CREATE INDEX "providers_pecos_status_last_synced_idx" ON "resupply"."providers_pecos_status" USING "btree" ("last_synced_at" DESC);
CREATE INDEX "recall_notifications_patient_idx" ON "resupply"."recall_notifications" USING "btree" ("patient_id");
CREATE INDEX "recall_notifications_queued_idx" ON "resupply"."recall_notifications" USING "btree" ("created_at") WHERE ("status" = 'queued'::"text");
CREATE UNIQUE INDEX "recall_notifications_recall_asset_unique" ON "resupply"."recall_notifications" USING "btree" ("recall_id", "asset_id");
CREATE UNIQUE INDEX "recall_remediation_actions_recall_asset_unique" ON "resupply"."recall_remediation_actions" USING "btree" ("recall_id", "asset_id");
CREATE INDEX "recall_remediation_actions_recall_idx" ON "resupply"."recall_remediation_actions" USING "btree" ("recall_id");
CREATE INDEX "report_presets_user_idx" ON "resupply"."report_presets" USING "btree" ("user_id", "created_at" DESC);
CREATE UNIQUE INDEX "shop_backorders_active_sku_idx" ON "resupply"."shop_backorders" USING "btree" ("sku") WHERE ("cleared_at" IS NULL);
CREATE INDEX "shop_order_loss_claims_open_idx" ON "resupply"."shop_order_loss_claims" USING "btree" ("opened_at") WHERE ("resolved_at" IS NULL);
CREATE INDEX "shop_order_loss_claims_order_idx" ON "resupply"."shop_order_loss_claims" USING "btree" ("order_id");
CREATE INDEX "shop_order_nps_responses_created_idx" ON "resupply"."shop_order_nps_responses" USING "btree" ("created_at" DESC);
CREATE INDEX "shop_order_nps_responses_order_idx" ON "resupply"."shop_order_nps_responses" USING "btree" ("order_id", "created_at" DESC);
CREATE UNIQUE INDEX "shop_sku_substitutes_primary_alt_unique" ON "resupply"."shop_sku_substitutes" USING "btree" ("primary_sku", "alternative_sku");
CREATE INDEX "shop_sku_substitutes_primary_sort_idx" ON "resupply"."shop_sku_substitutes" USING "btree" ("primary_sku", "priority");
CREATE INDEX "sku_hcpcs_map_hcpcs_idx" ON "resupply"."sku_hcpcs_map" USING "btree" ("hcpcs_code");
CREATE UNIQUE INDEX "therapy_fleet_alerts_open_unique" ON "resupply"."therapy_fleet_alerts" USING "btree" ("patient_id", "alert_type") WHERE ("status" = 'open'::"text");
CREATE INDEX "therapy_fleet_alerts_status_idx" ON "resupply"."therapy_fleet_alerts" USING "btree" ("status", "created_at" DESC);
CREATE INDEX "webhook_deliveries_due_idx" ON "resupply"."webhook_deliveries" USING "btree" ("status", "next_attempt_at") WHERE ("status" = 'queued'::"text");
CREATE INDEX "webhook_deliveries_subscription_idx" ON "resupply"."webhook_deliveries" USING "btree" ("subscription_id", "created_at" DESC);
CREATE INDEX "webhook_subscriptions_active_idx" ON "resupply"."webhook_subscriptions" USING "btree" ("is_active") WHERE ("is_active" = true);
CREATE TRIGGER "bulk_campaign_recipients_updated_at_trigger" BEFORE UPDATE ON "resupply"."bulk_campaign_recipients" FOR EACH ROW EXECUTE FUNCTION "resupply"."set_bulk_campaign_recipients_updated_at"();
ALTER TABLE ONLY "resupply"."alert_message_overrides"
    ADD CONSTRAINT "alert_message_overrides_alert_key_fk" FOREIGN KEY ("alert_key") REFERENCES "resupply"."alert_definitions"("key") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."alert_message_overrides"
    ADD CONSTRAINT "alert_message_overrides_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."alert_messages"
    ADD CONSTRAINT "alert_messages_alert_key_fk" FOREIGN KEY ("alert_key") REFERENCES "resupply"."alert_definitions"("key") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."bulk_campaign_recipients"
    ADD CONSTRAINT "bulk_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "resupply"."bulk_campaigns"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."claim_appeal_letters"
    ADD CONSTRAINT "claim_appeal_letters_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."claim_appeal_letters"
    ADD CONSTRAINT "claim_appeal_letters_denial_analysis_id_fkey" FOREIGN KEY ("denial_analysis_id") REFERENCES "resupply"."claim_denial_analyses"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."claim_denial_analyses"
    ADD CONSTRAINT "claim_denial_analyses_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."claim_denial_analyses"
    ADD CONSTRAINT "claim_denial_analyses_era_file_id_fkey" FOREIGN KEY ("era_file_id") REFERENCES "resupply"."era_files"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."claim_denial_analyses"
    ADD CONSTRAINT "claim_denial_analyses_resubmit_office_ally_submission_id_fkey" FOREIGN KEY ("resubmit_office_ally_submission_id") REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."claim_scrub_results"
    ADD CONSTRAINT "claim_scrub_results_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."claim_templates"
    ADD CONSTRAINT "claim_templates_scoped_payer_profile_id_fkey" FOREIGN KEY ("scoped_payer_profile_id") REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."clearinghouse_inbound_files"
    ADD CONSTRAINT "clearinghouse_inbound_files_applied_to_era_file_id_fkey" FOREIGN KEY ("applied_to_era_file_id") REFERENCES "resupply"."era_files"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."clearinghouse_inbound_files"
    ADD CONSTRAINT "clearinghouse_inbound_files_applied_to_submission_id_fkey" FOREIGN KEY ("applied_to_submission_id") REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."clearinghouse_inbound_files"
    ADD CONSTRAINT "clearinghouse_inbound_files_clearinghouse_id_fkey" FOREIGN KEY ("clearinghouse_id") REFERENCES "resupply"."clearinghouse_credentials"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."clinician_share_tokens"
    ADD CONSTRAINT "clinician_share_tokens_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."conversation_coaching_notes"
    ADD CONSTRAINT "conversation_coaching_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "resupply"."conversations"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."dispense_readiness_reviews"
    ADD CONSTRAINT "dispense_readiness_reviews_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "resupply"."fulfillments"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."dispense_readiness_reviews"
    ADD CONSTRAINT "dispense_readiness_reviews_insurance_coverage_id_fkey" FOREIGN KEY ("insurance_coverage_id") REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."dispense_readiness_reviews"
    ADD CONSTRAINT "dispense_readiness_reviews_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."dispense_readiness_reviews"
    ADD CONSTRAINT "dispense_readiness_reviews_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."dme_organization_contacts"
    ADD CONSTRAINT "dme_organization_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "resupply"."dme_organization"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."equipment_assets"
    ADD CONSTRAINT "equipment_assets_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."equipment_assets"
    ADD CONSTRAINT "equipment_assets_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."inbound_faxes"
    ADD CONSTRAINT "inbound_faxes_attached_patient_id_fkey" FOREIGN KEY ("attached_patient_id") REFERENCES "resupply"."patients"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."inbound_faxes"
    ADD CONSTRAINT "inbound_faxes_attached_prescription_id_fkey" FOREIGN KEY ("attached_prescription_id") REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."inbound_faxes"
    ADD CONSTRAINT "inbound_faxes_attached_provider_id_fkey" FOREIGN KEY ("attached_provider_id") REFERENCES "resupply"."providers"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."inbound_referral_preflight_checks"
    ADD CONSTRAINT "inbound_referral_preflight_checks_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "resupply"."inbound_referral_orders"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."inventory_reconciliation_lines"
    ADD CONSTRAINT "inventory_reconciliation_lines_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "resupply"."inventory_reconciliations"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_address_history"
    ADD CONSTRAINT "patient_address_history_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_coaching_plans"
    ADD CONSTRAINT "patient_coaching_plans_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_fit_overrides"
    ADD CONSTRAINT "patient_fit_overrides_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_form_acknowledgements"
    ADD CONSTRAINT "patient_form_acknowledgements_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_grievances"
    ADD CONSTRAINT "patient_grievances_equipment_asset_id_fkey" FOREIGN KEY ("equipment_asset_id") REFERENCES "resupply"."equipment_assets"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."patient_grievances"
    ADD CONSTRAINT "patient_grievances_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_identity_verifications"
    ADD CONSTRAINT "patient_identity_verifications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_maintenance_log"
    ADD CONSTRAINT "patient_maintenance_log_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_maintenance_nudges"
    ADD CONSTRAINT "patient_maintenance_nudges_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_referrals"
    ADD CONSTRAINT "patient_referrals_referrer_patient_id_fkey" FOREIGN KEY ("referrer_patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_therapy_milestones"
    ADD CONSTRAINT "patient_therapy_milestones_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."patient_worklist_actions"
    ADD CONSTRAINT "patient_worklist_actions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."payer_modifier_rules"
    ADD CONSTRAINT "payer_modifier_rules_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "resupply"."payer_profiles"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."prescription_request_packets"
    ADD CONSTRAINT "prescription_request_packets_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."prescription_request_packets"
    ADD CONSTRAINT "prescription_request_packets_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "resupply"."providers"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."prescription_request_packets"
    ADD CONSTRAINT "prescription_request_packets_source_prescription_id_fkey" FOREIGN KEY ("source_prescription_id") REFERENCES "resupply"."prescriptions"("id") ON DELETE SET NULL;
ALTER TABLE ONLY "resupply"."recall_notifications"
    ADD CONSTRAINT "recall_notifications_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "resupply"."equipment_assets"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."recall_notifications"
    ADD CONSTRAINT "recall_notifications_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "resupply"."equipment_recalls"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."recall_remediation_actions"
    ADD CONSTRAINT "recall_remediation_actions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "resupply"."equipment_assets"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."recall_remediation_actions"
    ADD CONSTRAINT "recall_remediation_actions_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "resupply"."equipment_recalls"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."shop_order_loss_claims"
    ADD CONSTRAINT "shop_order_loss_claims_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."shop_order_nps_responses"
    ADD CONSTRAINT "shop_order_nps_responses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."sku_hcpcs_map"
    ADD CONSTRAINT "sku_hcpcs_map_hcpcs_code_fkey" FOREIGN KEY ("hcpcs_code") REFERENCES "resupply"."hcpcs_codes"("code") ON DELETE RESTRICT;
ALTER TABLE ONLY "resupply"."therapy_fleet_alerts"
    ADD CONSTRAINT "therapy_fleet_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "resupply"."webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "resupply"."webhook_subscriptions"("id") ON DELETE CASCADE;
ALTER TABLE "resupply"."bulk_campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."bulk_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."claim_appeal_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."claim_denial_analyses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."claim_scrub_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."claim_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."clearinghouse_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."clearinghouse_inbound_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."clinician_share_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."conversation_coaching_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."csr_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."dispense_readiness_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."dme_organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."dme_organization_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."equipment_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."equipment_recalls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."good_faith_estimates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."hcpcs_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."inbound_faxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."inbound_referral_preflight_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."inbound_referral_status_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."inventory_reconciliation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."inventory_reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."low_stock_alert_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."office_closures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."office_recurring_closures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_address_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_coaching_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_fit_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_form_acknowledgements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_grievances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_identity_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_maintenance_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_maintenance_nudges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_referrals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_therapy_milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."patient_worklist_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."payer_modifier_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."prescription_request_packets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."product_hcpcs_map" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."providers_pecos_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."recall_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."recall_remediation_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."report_presets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."shop_backorders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."shop_order_loss_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."shop_order_nps_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."shop_sku_substitutes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."sku_hcpcs_map" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."therapy_fleet_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."therapy_fleet_daily_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resupply"."webhook_subscriptions" ENABLE ROW LEVEL SECURITY;

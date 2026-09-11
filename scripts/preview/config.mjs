#!/usr/bin/env node
// Nonsecret PR 1373 configuration. Never reads the current process's secrets.
// Usage: node scripts/preview/config.mjs --origin=https://<preview>.up.railway.app
// Apply only `variables` to the pinned Railway target, merging the required
// secrets privately. Empty values intentionally shadow inherited credentials.
import { pathToFileURL } from "node:url";
import {
  BREAK_GLASS_VAR,
  BREAK_GLASS_REASON_VAR,
} from "../../lib/resupply-db/scripts/deploy-environment.mjs";

export const PREVIEW_TARGET = Object.freeze({
  railwayProjectId: "30957b23-dfb7-4751-934c-25b212ec49b7",
  railwayServiceId: "b08cfa1c-9af3-417d-b298-6fd4921d2d23",
  railwayEnvironmentId: "1275d316-9b22-4e00-a1fa-7e59f0a95d47",
  supabaseProjectRef: "dfwwhqeebadwpbzjnxuj",
  supabaseBranchId: "4baf93dc-fb0e-4b33-bef5-0b1c2916d8dc",
  supabaseParentProjectRef: "uppdjphagdildcgkvdsz",
  publicOrigin: "https://resupply-api-pennfit-pr-1373.up.railway.app",
});

// Sources: app-config/catalog.ts, messaging/voice/Stripe configs, .env.example,
// billing/identity-resolver.ts, turnstile.ts, and the integration packages.
export const EMPTY_INTEGRATION_VARIABLES = Object.freeze([
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_VOICE_PHONE_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
  "BREATHE_SALES_VOICE_NUMBER",
  "TELNYX_API_KEY",
  "TELNYX_FAX_CONNECTION_ID",
  "TELNYX_FAX_FROM_NUMBER",
  "TELNYX_PUBLIC_KEY",
  "SENDGRID_API_KEY",
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_INBOUND_PARSE_BASIC_AUTH",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "STRIPE_PLATFORM_SECRET_KEY",
  "STRIPE_PLATFORM_WEBHOOK_SIGNING_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SIGNING_SECRET",
  "STRIPE_PUBLISHABLE_KEY",
  "AIRVIEW_CLIENT_ID",
  "AIRVIEW_CLIENT_SECRET",
  "AIRVIEW_API_BASE_URL",
  "AIRVIEW_OAUTH_TOKEN_URL",
  "AIRVIEW_DME_ID",
  "AIRVIEW_WEBHOOK_SECRET",
  "CARE_ORCHESTRATOR_CLIENT_ID",
  "CARE_ORCHESTRATOR_CLIENT_SECRET",
  "CARE_ORCHESTRATOR_API_BASE_URL",
  "CARE_ORCHESTRATOR_OAUTH_TOKEN_URL",
  "CARE_ORCHESTRATOR_PARTNER_ID",
  "CARE_ORCH_WEBHOOK_SECRET",
  "REACT_HEALTH_CLIENT_ID",
  "REACT_HEALTH_CLIENT_SECRET",
  "REACT_HEALTH_API_BASE_URL",
  "REACT_HEALTH_OAUTH_TOKEN_URL",
  "REACT_HEALTH_ACCOUNT_ID",
  "REACT_HEALTH_WEBHOOK_SECRET",
  "OFFICE_ALLY_USERNAME",
  "OFFICE_ALLY_PRIVATE_KEY_PATH",
  "OFFICE_ALLY_KNOWN_HOSTS_PATH",
  "OFFICE_ALLY_REALTIME_API_KEY",
  "OFFICE_ALLY_REALTIME_PASSWORD",
  "OFFICE_ALLY_REALTIME_URL",
  "OFFICE_ALLY_DISCOVERY_URL",
  "OFFICE_ALLY_FILE_OUTBOX_DIR",
  "XPS_SHIP_API_KEY",
  "XPS_SHIP_CUSTOMER_ID",
  "XPS_SHIP_INTEGRATION_ID",
  "XPS_SHIP_API_BASE_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_TEAM_ID",
  "SLACK_ALERTS_CHANNEL",
  "SLACK_DIGESTS_CHANNEL",
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_VAPID_SUBJECT",
  "RESUPPLY_TURN_URLS",
  "RESUPPLY_TURN_USERNAME",
  "RESUPPLY_TURN_CREDENTIAL",
  "CARRIER_WEBHOOK_SECRET",
  "TURNSTILE_SECRET_KEY",
  "VITE_TURNSTILE_SITE_KEY",
  "HUB_SUPABASE_PUBLISHABLE_KEY",
  "CAREMETRIC_ADMIN_IDENTITY_MAP_JSON",
  "OPS_EMAIL",
  "PENN_FULFILLMENT_EMAIL",
  "SHOP_CSR_INBOX_EMAIL",
  "RESUPPLY_ADMIN_ALERTS_EMAIL",
  "INSURANCE_LEAD_NOTIFICATION_EMAIL",
  "RESUPPLY_SUPPLIER_RETURN_EMAIL",
  "RESUPPLY_SUPPLIER_FAX_E164",
  "RESUPPLY_ADMIN_EMAILS",
  "RESUPPLY_AGENT_EMAILS",
  "RESUPPLY_OPERATOR_EMAILS",
]);

export const DISABLED_JOB_VARIABLES = Object.freeze([
  "RESUPPLY_FITTER_REENGAGE_ENABLED",
  "RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED",
  "RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED",
  "RESUPPLY_REFIT_CAMPAIGN_ENABLED",
  "RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED",
  "RESUPPLY_DEMO_DRIP_ENABLED",
  "RESUPPLY_CART_ABANDONMENT_CRON_ENABLED",
  "RESUPPLY_REVIEW_REQUEST_CRON_ENABLED",
  "RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED",
  "RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED",
  "RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH",
  "RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED",
  "RESUPPLY_COACHING_AUTO_ENROLL_ENABLED",
  "RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED",
  "XPS_RESOLVE_STAGED_CRON_ENABLED",
  "OPENAI_REALTIME_DIAGNOSTIC_ENABLED",
]);

export const OPTIONAL_CRON_VARIABLES = Object.freeze([
  "ELIGIBILITY_REVERIFY_CRON",
  "CLAIMS_AUTOSUBMIT_CRON",
  "PRIOR_AUTH_AUTOSUBMIT_CRON",
  "BILL_HOLD_SWEEP_CRON",
  "ADR_ALERT_DIGEST_CRON",
  "REFERRAL_ADHERENCE_REPORT_CRON",
  "CLINICAL_OUTREACH_CRON",
  "RESUPPLY_SLA_ESCALATION_CRON",
]);

export const PREVIEW_ORIGIN_VARIABLES = Object.freeze([
  "PUBLIC_BASE_URL",
  "SHOP_PUBLIC_BASE_URL",
  "REMINDER_PUBLIC_BASE_URL",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "RESUPPLY_VOICE_PUBLIC_BASE_URLS",
  "RESUPPLY_VOICE_STREAM_PUBLIC_BASE_URL",
  "RESUPPLY_DASHBOARD_PUBLIC_BASE_URL",
  "PENN_ADMIN_PUBLIC_BASE_URL",
  "PLATFORM_PUBLIC_BASE_URL",
  "BREATHE_PLATFORM_BASE_URL",
  "RESUPPLY_ALLOWED_ORIGINS",
]);

export function buildPreviewConfig(publicOrigin) {
  let url;
  try {
    url = new URL(publicOrigin);
  } catch {
    throw new Error("A preview HTTPS origin is required.");
  }
  if (
    url.origin !== PREVIEW_TARGET.publicOrigin ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use the PR preview Railway HTTPS origin, without credentials, port, or path.",
    );
  }
  const variables = Object.fromEntries([
    ...EMPTY_INTEGRATION_VARIABLES.map((name) => [name, ""]),
    ...OPTIONAL_CRON_VARIABLES.map((name) => [name, ""]),
    ...DISABLED_JOB_VARIABLES.map((name) => [name, "0"]),
    ...PREVIEW_ORIGIN_VARIABLES.map((name) => [name, url.origin]),
  ]);
  Object.assign(variables, {
    NODE_ENV: "production",
    PORT: "3000",
    BASE_PATH: "/",
    LOG_LEVEL: "info",
    DEPLOY_ENV: "preview",
    DATABASE_ENV: "preview",
    RUN_DB_MIGRATIONS: "true",
    // Same verified production endpoint, explicit :5432 and implicit default port.
    PRODUCTION_DATABASE_FINGERPRINT: "28616a064d1b,9b7fdb5b3be3",
    PRODUCTION_SUPABASE_FINGERPRINT: "47654561c718",
    SUPABASE_URL: `https://${PREVIEW_TARGET.supabaseProjectRef}.supabase.co`,
    SUPABASE_STORAGE_BUCKET_PRIVATE: "attachments",
    SUPABASE_STORAGE_BUCKET_PUBLIC: "public-assets",
    APP_CONFIG_OVERLAY_DISABLED: "1",
    BILLING_PAYWALL_ENFORCED: "false",
    PLATFORM_METERED_OVERAGE_ENABLED: "false",
    CAREMETRIC_ADMIN_ENABLED: "false",
    VITE_CENTRAL_SUPPORT_HUB_ENABLED: "false",
    VITE_APP_ENVIRONMENT: "preview",
    RESUPPLY_PRACTICE_TIMEZONE: "America/New_York",
    SENDGRID_FROM_EMAIL: "preview@example.invalid",
    SENDGRID_FROM_NAME: "CareMetric Preview",
    // This job uses ??, unlike the optional crons. Empty would fail registration;
    // patient_packets.autoremind is disabled separately by disable-outbound.mjs.
    PATIENT_PACKET_REMINDER_CRON: "33 19 * * *",
    MIGRATIONS_BASELINE_THROUGH: "",
    MIGRATIONS_BASELINE_EXCEPT: "",
    [BREAK_GLASS_VAR]: "",
    [BREAK_GLASS_REASON_VAR]: "",
  });
  return {
    target: PREVIEW_TARGET,
    variables,
    requiredSecrets: [
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "RESUPPLY_LINK_HMAC_KEY",
    ],
    instructions: [
      "Apply only after init.mjs verifies the isolated branch and authoritative migration ledger.",
      "Apply variables only to the pinned Railway preview service/environment; preserve Railway-generated identity markers.",
      "Empty values must shadow inherited/shared credentials; verify the effective environment afterward.",
      "The included production fingerprint pins were verified for this preview; retain any additional independently verified production pins.",
      "Add the three required secrets privately from this preview project, never from production.",
      "Run disable-outbound.mjs for the seed org and each synthetic org before starting the app.",
      "The worker still runs internal jobs; outbound delivery requires separate test-provider setup.",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0].startsWith("--origin="))
      throw new Error(
        "Usage: config.mjs --origin=https://<preview>.up.railway.app",
      );
    process.stdout.write(
      JSON.stringify(buildPreviewConfig(args[0].slice(9)), null, 2) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

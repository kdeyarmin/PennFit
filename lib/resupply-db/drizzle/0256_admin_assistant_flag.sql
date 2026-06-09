-- 0256_admin_assistant_flag — Control Center toggle for PennPilot, the
-- in-app admin program-manager / tech-support assistant.
--
-- Adds the `admin.assistant` feature flag. When ENABLED (and an LLM
-- provider key is configured), signed-in staff see the PennPilot helper
-- in the admin console: it answers "how does the app work / where is the
-- page that does X" questions grounded in a complete map of the admin
-- surfaces, and can email a structured feature suggestion to the
-- super-admin(s) via the `suggest_feature` tool (always after the
-- operator confirms). Route: POST /resupply-api/admin/assistant/chat.
--
-- Seeded ENABLED, matching the other AI helper flags (storefront.chatbot,
-- voice.agent): the assistant degrades gracefully to a static "offline"
-- reply when no AI provider key is set, so a missing vendor key never
-- breaks a deploy. Admins can turn it off from Control Center.
-- INSERT … ON CONFLICT DO NOTHING keeps re-runs idempotent and never
-- clobbers an admin's intentional toggle.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('admin.assistant',
   true,
   'PennPilot — the in-app admin tech-support and program-manager assistant. When ON, signed-in staff can ask how the app works and where to find features, and PennPilot can email feature suggestions to the super-admins (after confirming). Claude Sonnet / GPT fallback; degrades to an offline reply when no AI provider key is set.',
   'Voice & AI')
ON CONFLICT (key) DO NOTHING;

-- 0488_app_modules — coarse "parts of the app" switches.
--
-- Why a new family of flags rather than reusing the existing ones:
--   The flags seeded before this migration are BEHAVIOUR flags — they
--   answer "should the dispatcher send?", "should we auto-submit?",
--   "should the voice agent answer?". They are incident switches. None
--   of them answers the question a new tenant actually asks on day one:
--   "I don't do insurance billing / I have no storefront — can I please
--   stop looking at forty pages I will never open?"
--
--   `module.*` answers exactly that. Each key maps to one NAVIGABLE part
--   of the admin console. Turning a module OFF removes its section (or
--   whole group) from the sidebar, and a deep link into it renders a
--   "this part of the app is turned off" notice instead of the page. The
--   server-side permission gates are unchanged — this is a scope/clutter
--   control, not an authorization boundary.
--
-- Seeded ON for every existing org, so this migration changes nothing
-- until an operator deliberately switches a module off. New tenants copy
-- the seed tenant's catalog (provisionTenantFeatureFlags /
-- scripts/tenant-onboard.ts), so they inherit these too.
--
-- DELIBERATELY NOT MODULARIZED (there is no key for them, and there must
-- never be one): Home, Patients, Orders, Settings, Team, Account
-- security, Setup & advanced / Control Center. Those are how an operator
-- runs the business and how they get BACK to the switch that turns a
-- module on again — a module key covering Control Center would let a
-- tenant lock themselves out of their own console with one click.
--
-- Keep in lockstep with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts and with
-- APP_MODULES in artifacts/cpap-fitter/src/lib/admin/app-modules.ts —
-- a key seeded here but missing there is an inert toggle, and a key
-- there but missing here never appears in Control Center.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags
  ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM resupply.organizations o
CROSS JOIN (VALUES
  ('module.front_desk',
   true,
   'Front desk — walk-in capture and counter sales. OFF hides the Front '
     || 'Desk page. Turn off if you have no retail counter.',
   'App Modules'),
  ('module.conversations',
   true,
   'Conversations, cases, and service episodes — the inbound SMS / MMS / '
     || 'email inbox and the tickets built on it. OFF hides the whole '
     || 'Conversations section. Turn off if your team answers patients '
     || 'somewhere else.',
   'App Modules'),
  ('module.schedule',
   true,
   'Scheduling — the shared company calendar, telehealth video visits, '
     || 'and the scheduled-callback queue. OFF hides the whole Schedule '
     || 'section.',
   'App Modules'),
  ('module.outreach',
   true,
   'Outreach — bulk campaigns, the alert library, reminder settings, '
     || 'playbooks, canned replies, and automated message copy. OFF hides '
     || 'the whole Outreach section. Automations you already enabled keep '
     || 'running; this only hides the pages.',
   'App Modules'),
  ('module.documents',
   true,
   'Documents and e-signature — patient documents, document packets, '
     || 'signature tracking, the provider e-signature portal, inbound '
     || 'faxes, and referral review. OFF hides the whole Documents & '
     || 'e-sign section.',
   'App Modules'),
  ('module.therapy',
   true,
   'Therapy monitoring — RT overview, therapy fleet, setup adherence, '
     || 'resupply opportunities, and RT outcomes. Needs a therapy-cloud '
     || 'integration to be useful. OFF hides the whole Therapy '
     || 'monitoring section.',
   'App Modules'),
  ('module.clinical',
   true,
   'Clinical work — encounters, interventions, fit review, mask catalog '
     || 'and formulary, mask-fit feedback, clinical outreach, adherence '
     || 'coaching, and the video library. OFF hides the whole Clinical '
     || 'work section.',
   'App Modules'),
  ('module.providers',
   true,
   'Providers and recalls — the referring-provider directory, equipment '
     || 'recalls, and asset recovery. OFF hides the whole Providers & '
     || 'recalls section.',
   'App Modules'),
  ('module.storefront',
   true,
   'Storefront and leads — shop customers, reviews, product Q&A, '
     || 'abandoned carts, back-in-stock requests, insurance leads, and '
     || 'fitter invites/prospects. OFF hides the whole Storefront & leads '
     || 'section. Orders themselves are never hidden.',
   'App Modules'),
  ('module.inventory',
   true,
   'Inventory — stock levels and reconciliation. OFF hides the Inventory '
     || 'section. Turn off if your warehouse system is the source of '
     || 'truth.',
   'App Modules'),
  ('module.billing',
   true,
   'Billing and claims — every claims dashboard, worklist, and A/R page, '
     || 'plus the clearinghouse/ERA tools. OFF hides the whole Billing '
     || 'group. Turn off if you are cash-pay only. Your own plan and '
     || 'usage stay reachable under Settings > Plan & billing either way.',
   'App Modules'),
  ('module.analytics',
   true,
   'Analytics and reports — every report, financial analysis, team '
     || 'performance and goal page. OFF hides the whole Analytics & '
     || 'Reports group.',
   'App Modules'),
  ('module.automation',
   true,
   'Automation — rules, compliance rules, and the rule tester. OFF hides '
     || 'the whole Automation section. Rules already saved keep running; '
     || 'this only hides the pages.',
   'App Modules'),
  ('module.integrations',
   true,
   'Integrations and data exchange — partner integrations, the PacWare '
     || 'CSV exchange, and webhook deliveries. OFF hides those entries '
     || 'from Operations.',
   'App Modules'),
  ('module.support',
   true,
   'Support tickets — the in-app support request surface. OFF hides the '
     || 'Support entry. Help & Resources (the in-app documentation) is '
     || 'deliberately NOT hidden: it is where an operator looks up how to '
     || 'turn a module back on.',
   'App Modules')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;

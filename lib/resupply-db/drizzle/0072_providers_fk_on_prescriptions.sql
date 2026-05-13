-- prescriptions.provider_id — link a prescription to the central
-- providers registry introduced in 0071.
--
-- Existing prescriptions keep their jsonb `details.prescriberName /
-- prescriberNpi` until the backfill in 0073 stitches them to a
-- provider row. Once that completes, the jsonb fields stay (they
-- preserve "what the doctor wrote on the prescription form") but
-- new code reads provider_id as the authoritative pointer.
--
-- ON DELETE SET NULL: deleting a provider (which we don't do today
-- but might once we add a deactivate flow) leaves the prescription
-- intact with a null FK. The Rx is still a valid clinical record —
-- the prescribing identity just no longer resolves to an active
-- provider row.

ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "provider_id" uuid
  REFERENCES "resupply"."providers"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "prescriptions_provider_id_idx"
  ON "resupply"."prescriptions" ("provider_id");

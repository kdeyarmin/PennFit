-- patient_notes — admin-authored, time-stamped, encrypted notes.
-- See lib/resupply-db/src/schema/patient-notes.ts for the design rationale.
--
-- Encrypted columns are stored as `bytea` at the SQL layer; the
-- encrypt()/decrypt() helpers in `lib/resupply-db/src/encryption.ts`
-- handle the pgcrypto round-trip at query sites.
CREATE TABLE "resupply"."patient_notes" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"patient_id" uuid NOT NULL,
"body" "bytea" NOT NULL,
"author_email" text NOT NULL,
"author_clerk_id" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resupply"."patient_notes" ADD CONSTRAINT "patient_notes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_notes_patient_created_idx" ON "resupply"."patient_notes" USING btree ("patient_id","created_at");

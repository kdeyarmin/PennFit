CREATE TABLE "resupply"."phone_lookup" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"hmac_phone" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resupply"."phone_lookup" ADD CONSTRAINT "phone_lookup_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "resupply"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_lookup_hmac_phone_unique" ON "resupply"."phone_lookup" USING btree ("hmac_phone");
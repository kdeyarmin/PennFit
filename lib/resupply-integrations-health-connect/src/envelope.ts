// Inbound JSON envelope schema for /resupply-api/health-connect/ingest.
//
// We do NOT accept arbitrary device files, raw images, or video.
// Numeric per-night summaries only — keeps the surface within the
// "no PHI image bytes anywhere in the backend" rule.

import { z } from "zod";

import {
  complianceSummarySchema,
  deviceSettingsSchema,
  supplyItemSchema,
  therapyNightSchema,
} from "@workspace/resupply-integrations";

export const healthConnectIngestEnvelopeSchema = z
  .object({
    /** Patient-app device id used for rate-limiting + dedupe. */
    deviceId: z.string().min(1).max(200),
    /** Patient-app local user id. Mapped to PennFit patientId server-side. */
    partnerPatientId: z.string().min(1).max(200),
    /** ISO-8601 timestamp at which the envelope was assembled. */
    capturedAt: z.string().datetime(),
    settings: deviceSettingsSchema.nullable().optional(),
    compliance: complianceSummarySchema.nullable().optional(),
    recentNights: z.array(therapyNightSchema).max(60).default([]),
    supplies: z.array(supplyItemSchema).max(40).default([]),
  })
  .strict();

export type HealthConnectIngestEnvelope = z.infer<
  typeof healthConnectIngestEnvelopeSchema
>;

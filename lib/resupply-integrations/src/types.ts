// Cross-vendor unified types for the therapy-cloud integrations
// surface (ResMed AirView, Philips Care Orchestrator, React Health).
//
// Each vendor speaks a different wire format; the adapter packages
// translate into these types so the admin UI and any downstream
// reporting can render a single consistent shape.
//
// PHI posture: these structures intentionally exclude raw camera /
// image / video bytes (we never log or persist those) and exclude
// free-form vendor response bodies. Everything here is summary
// numerics + short status strings the admin team needs to
// triage a patient — never the patient's full vendor record.

import { z } from "zod";

/** Stable identifier for which therapy-cloud a record came from. */
export const INTEGRATION_SOURCES = [
  "resmed_airview",
  "philips_care",
  // 3B Medical's iCode Connect cloud — backs the Luna G3 line and the
  // Lumin sanitizer ecosystem (consumer-marketed as React Health).
  "react_health",
] as const;

export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

/**
 * Configuration health for a single vendor adapter at runtime.
 * Drives the "is this turned on?" badge in the admin UI without
 * leaking which env var is missing.
 */
export type AdapterAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "stub_mode" }
  | { status: "unavailable"; reason: string };

/** Per-night usage rollup, source-tagged. */
export const therapyNightSchema = z.object({
  nightDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  usageMinutes: z.number().int().nonnegative().nullable(),
  ahi: z.number().nonnegative().nullable(),
  leakRateLMin: z.number().nonnegative().nullable(),
  pressureP95Cmh2o: z.number().nonnegative().nullable(),
});
export type TherapyNight = z.infer<typeof therapyNightSchema>;

/** Compliance summary across a 30-day window. */
export const complianceSummarySchema = z.object({
  windowDays: z.number().int().positive(),
  daysWithData: z.number().int().nonnegative(),
  daysOver4Hours: z.number().int().nonnegative(),
  averageUsageMinutes: z.number().nonnegative().nullable(),
  averageAhi: z.number().nonnegative().nullable(),
  /** True iff CMS 90/30 rule (>= 21 nights of >=4h in any 30-day window) is met. */
  meetsCmsCompliance: z.boolean(),
});
export type ComplianceSummary = z.infer<typeof complianceSummarySchema>;

/** Device + therapy settings as last reported by the partner. */
export const deviceSettingsSchema = z.object({
  deviceModel: z.string().nullable(),
  deviceSerial: z.string().nullable(),
  therapyMode: z.string().nullable(),
  pressureMinCmh2o: z.number().nonnegative().nullable(),
  pressureMaxCmh2o: z.number().nonnegative().nullable(),
  rampMinutes: z.number().int().nonnegative().nullable(),
  humidifierLevel: z.number().int().nonnegative().nullable(),
  maskType: z.string().nullable(),
});
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;

/** A single supply line item the partner currently has on file. */
export const supplyItemSchema = z.object({
  category: z.enum([
    "mask",
    "cushion",
    "headgear",
    "tubing",
    "filter",
    "humidifier_chamber",
    "other",
  ]),
  description: z.string(),
  lastReplacedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  nextEligibleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
export type SupplyItem = z.infer<typeof supplyItemSchema>;

/**
 * Unified per-patient snapshot from one vendor. This is what
 * adapters return and what we cache in patient_integration_snapshots.
 *
 * `fetchedAt` is set by the API layer at write time, not the adapter.
 */
export const integrationSnapshotSchema = z.object({
  source: z.enum(INTEGRATION_SOURCES),
  partnerPatientId: z.string(),
  settings: deviceSettingsSchema.nullable(),
  compliance: complianceSummarySchema.nullable(),
  recentNights: z.array(therapyNightSchema),
  supplies: z.array(supplyItemSchema),
});
export type IntegrationSnapshot = z.infer<typeof integrationSnapshotSchema>;

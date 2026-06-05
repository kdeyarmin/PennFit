// @workspace/resupply-integrations — pure semantic layer for the
// therapy-cloud integrations surface (ResMed AirView, Philips
// Care Orchestrator, React Health).
//
// This package contains:
//   - Cross-vendor unified types (DeviceSettings, ComplianceSummary,
//     SupplyItem, IntegrationSnapshot).
//   - The IntegrationAdapter contract every vendor implementation
//     satisfies.
//   - Zod schemas to validate snapshots at the boundary between
//     adapters and the persistence layer.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db, vendor SDKs, fetch.
// Vendor HTTP clients live in resupply-integrations-{airview,
// care-orchestrator,react-health}.

export {
  INTEGRATION_SOURCES,
  type IntegrationSource,
  type AdapterAvailability,
  type TherapyNight,
  type ComplianceSummary,
  type DeviceSettings,
  type SupplyItem,
  type IntegrationSnapshot,
  therapyNightSchema,
  complianceSummarySchema,
  deviceSettingsSchema,
  supplyItemSchema,
  integrationSnapshotSchema,
} from "./types";

export {
  type IntegrationAdapter,
  type FetchSnapshotInput,
  type FetchSnapshotResult,
  type AdapterError,
} from "./adapter";

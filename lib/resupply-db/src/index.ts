// @workspace/resupply-db
// Drizzle schema + Postgres connection for the CPAP resupply system. Owns the patients, equipment, supplies, orders, consents, suppression, audit, outbound-message, and conversation tables. Field-level encryption for PHI is wired through Drizzle column transforms — see ADR 003 + ADR 007.
//
// Phase 0 — scaffold only. No business logic yet.

export {};

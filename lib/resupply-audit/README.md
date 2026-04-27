# @workspace/resupply-audit

Append-only audit-log helper and Drizzle/middleware shims. Every PHI read or write writes exactly one audit row. AsyncLocalStorage actor propagation is the contract this lib defines. See ADR 006.

## Status

Phase 0 — scaffolding only. No exports yet. See `docs/resupply/adr/` for the
architectural decisions that govern this package.

// /api/provider/patients/* — provider-facing RTM (remote therapeutic
// monitoring) dashboard. Phase 1: a referring provider's read-only view
// of how THEIR OWN patients are doing on therapy.
//
//   GET  /api/provider/patients                       — roster + adherence summary
//   GET  /api/provider/patients/:id                   — one patient's detail snapshot
//   GET  /api/provider/patients/:id/attestation.pdf   — adherence attestation PDF
//
// Isolation primitive (the same one the e-sign portal uses): every read
// is scoped to the patients whose `prescriptions.provider_id` equals the
// signed-in provider's `account.providerId`. A provider sees ONLY their
// own patients. All three routes are MFA-gated (requireProviderMfaEnrolled)
// because they surface PHI (patient names + therapy data).
//
// Tenant scoping: unlike the legacy e-sign portal (which resolves the
// SEED org for its GLOBAL account/MFA tables), the RTM reads touch TENANT
// PHI tables (patients, prescriptions, patient_therapy_nights) which carry
// org_id — so they MUST be scoped to the tenant that owns THIS host.
// `attachProviderOrgId` (in each chain, after requireProvider) resolves
// the org by host and pins it onto req.orgId; we fail CLOSED if it is
// absent rather than widening to all tenants.
//
// PHI posture: the app logger sees provider/patient ids + numeric counts
// only — never patient names, never therapy free-text, never image bytes.

import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { getDocumentSupplierName } from "../../lib/company-info";
import {
  buildTherapySnapshot,
  type SnapshotNight,
} from "../admin/patient-therapy-snapshot";
import {
  findBestAdherenceWindow,
  renderComplianceAttestation,
  type AdherenceNight,
  type AttestationInputs,
} from "../../lib/compliance-attestation";
import { logger } from "../../lib/logger";
import { therapyNightSourceRank } from "../../lib/therapy-night-source-priority";
import {
  requireProvider,
  requireProviderMfaEnrolled,
} from "../../middlewares/requireProvider";
import { attachProviderOrgId, providerPortalRateLimiter } from "./shared";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Max UUIDs per `.in(...)` filter. PostgREST encodes the list into the
 *  request URI, so an unbounded list risks request-URI-too-long; the rest
 *  of the repo chunks roster id-lists at 200 (worker bulk-campaign-tick). */
const ID_CHUNK_SIZE = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const ROSTER_WINDOW_DAYS = 30;
const CMS_COMPLIANCE_RATE_PCT = 70;

interface NightRow {
  night_date: string;
  source: string;
  usage_minutes: number | null;
  ahi: number | null;
  leak_rate_l_min: number | null;
}

/** Dedupe nights by date keeping the source-priority winner. */
function dedupeNights(rows: readonly NightRow[]): NightRow[] {
  const byDate = new Map<string, NightRow>();
  for (const row of rows) {
    const existing = byDate.get(row.night_date);
    if (!existing) {
      byDate.set(row.night_date, row);
      continue;
    }
    const newRank = therapyNightSourceRank(row.source);
    const oldRank = therapyNightSourceRank(existing.source);
    if (newRank < oldRank) byDate.set(row.night_date, row);
  }
  return Array.from(byDate.values());
}

function toSnapshotNight(n: NightRow): SnapshotNight {
  return {
    nightDate: n.night_date,
    usageMinutes: n.usage_minutes == null ? null : Number(n.usage_minutes),
    ahi: n.ahi == null ? null : Number(n.ahi),
    leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
  };
}

/** Resolve the distinct patient ids this provider may see — every
 *  patient who has at least one prescription with provider_id =
 *  providerId in THIS tenant. The org-scoped client appends the org_id
 *  filter on the tenant `prescriptions` table; we add the provider_id
 *  filter (the portal isolation primitive) explicitly. */
async function listProviderPatientIds(
  orgId: string,
  providerId: string,
): Promise<string[]> {
  const db = getOrgScopedClient(orgId);
  const { data, error } = await db
    .from("prescriptions")
    .select("patient_id")
    .eq("provider_id", providerId)
    .limit(20_000);
  if (error) throw error;
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ patient_id: string | null }>) {
    if (row.patient_id) ids.add(row.patient_id);
  }
  return Array.from(ids);
}

interface OwnedPatient {
  id: string;
  legal_first_name: string;
  legal_last_name: string;
  date_of_birth: string;
}

/** Guard: confirm the given patient belongs to this provider (has a
 *  prescription with provider_id = providerId in this tenant). Returns
 *  the patient name snapshot row, or null when the patient is not the
 *  provider's (treated as 404 — never leak that the patient exists). */
async function loadOwnedPatient(
  orgId: string,
  providerId: string,
  patientId: string,
): Promise<OwnedPatient | null> {
  const db = getOrgScopedClient(orgId);
  // The provider→patient link lives on prescriptions; check it first so
  // a provider can never read a patient they don't prescribe for.
  const { data: rx, error: rxErr } = await db
    .from("prescriptions")
    .select("patient_id")
    .eq("provider_id", providerId)
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle();
  if (rxErr) throw rxErr;
  if (!rx) return null;

  const { data: patient, error: pErr } = await db
    .from("patients")
    .select("id, legal_first_name, legal_last_name, date_of_birth")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!patient) return null;
  return patient as OwnedPatient;
}

/** Trim-checked tenant context. Fails closed — never widen to all
 *  tenants on a missing orgId (this is PHI). */
function resolveOrgId(orgId: string | undefined): string | null {
  if (!orgId || !orgId.trim()) return null;
  return orgId;
}

// ── GET /api/provider/patients ────────────────────────────────────
//
// The roster: every patient this provider prescribes for, each with a
// compact recent-adherence summary (last night, avg usage, 30-day
// compliance rate) plus a coarse CMS compliance flag.

const rosterQuery = z.object({
  days: z.coerce.number().int().min(7).max(90).default(ROSTER_WINDOW_DAYS),
});

router.get(
  "/api/provider/patients",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  attachProviderOrgId,
  async (req, res) => {
    const account = req.providerAccount!;
    const parsed = rosterQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const windowDays = parsed.data.days;
    const orgId = resolveOrgId(req.orgId);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const patientIds = await listProviderPatientIds(orgId, account.providerId);
    if (patientIds.length === 0) {
      res.json({ windowDays, patients: [] });
      return;
    }

    const db = getOrgScopedClient(orgId);
    const todayIso = new Date().toISOString().slice(0, 10);
    const startIso = new Date(Date.now() - windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // All three roster reads filter on the provider's patient-id list.
    // That list is unbounded (a large panel), so we MUST chunk the
    // `.in(...)` UUID lists — PostgREST encodes them into the request URI
    // and an oversized list errors (URI-too-long). Aggregating per chunk
    // also removes the previous single global `.limit(20_000)` scan, which
    // silently truncated nights for large panels and corrupted the
    // hasData / setupDate / compliance rollups and "needs attention" sort.
    const idChunks = chunk(patientIds, ID_CHUNK_SIZE);

    // Patient name snapshots — scoped to this tenant AND restricted to
    // the provider's own patient ids.
    const patientRows: Array<{
      id: string;
      legal_first_name: string;
      legal_last_name: string;
      status: string | null;
      created_at: string;
    }> = [];
    // Recent therapy nights for the rollup, per patient.
    const nightsByPatient = new Map<string, NightRow[]>();
    // Earliest therapy night per patient = the therapy-start (setup) date.
    const setupByPatient = new Map<string, string>();

    for (const ids of idChunks) {
      const { data: chunkPatients, error: pErr } = await db
        .from("patients")
        .select("id, legal_first_name, legal_last_name, status, created_at")
        .in("id", ids);
      if (pErr) throw pErr;
      patientRows.push(
        ...((chunkPatients ?? []) as Array<{
          id: string;
          legal_first_name: string;
          legal_last_name: string;
          status: string | null;
          created_at: string;
        }>),
      );

      // The recent-window date filter bounds this read per chunk, so no
      // global cap is needed and no patient's nights are dropped.
      const { data: chunkNights, error: nErr } = await db
        .from("patient_therapy_nights")
        .select(
          "patient_id, night_date, source, usage_minutes, ahi, leak_rate_l_min",
        )
        .in("patient_id", ids)
        .gte("night_date", startIso);
      if (nErr) throw nErr;
      for (const row of (chunkNights ?? []) as Array<
        NightRow & { patient_id: string }
      >) {
        const list = nightsByPatient.get(row.patient_id) ?? [];
        list.push(row);
        nightsByPatient.set(row.patient_id, list);
      }

      const { data: chunkFirstNights, error: fErr } = await db
        .from("patient_therapy_nights")
        .select("patient_id, night_date")
        .in("patient_id", ids)
        .order("night_date", { ascending: true });
      if (fErr) throw fErr;
      for (const row of (chunkFirstNights ?? []) as Array<{
        patient_id: string;
        night_date: string;
      }>) {
        const prior = setupByPatient.get(row.patient_id);
        if (prior == null || row.night_date < prior) {
          setupByPatient.set(row.patient_id, row.night_date);
        }
      }
    }

    const patients = patientRows.map((p) => {
      const deduped = dedupeNights(nightsByPatient.get(p.id) ?? []);
      const snapshot = buildTherapySnapshot(
        deduped.map(toSnapshotNight),
        windowDays,
        todayIso,
      );
      return {
        patientId: p.id,
        patientName: `${p.legal_last_name}, ${p.legal_first_name}`,
        status: p.status ?? "active",
        setupDate: setupByPatient.get(p.id) ?? null,
        hasData: snapshot.hasData,
        lastNightDate: snapshot.lastNightDate,
        staleDays: snapshot.staleDays,
        avgUsageHours: snapshot.avgUsageHours,
        compliantNights: snapshot.compliantNights,
        nightsWithData: snapshot.nightsWithData,
        complianceRatePct: snapshot.complianceRatePct,
        // Coarse CMS signal over the recent window — the per-patient
        // detail read computes the authoritative 90-day-window result.
        cmsCompliant:
          snapshot.complianceRatePct != null &&
          snapshot.complianceRatePct >= CMS_COMPLIANCE_RATE_PCT,
      };
    });

    // Sort: data-bearing first, then most-stale (needs attention) on top.
    patients.sort((a, b) => {
      if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
      const aStale = a.staleDays ?? -1;
      const bStale = b.staleDays ?? -1;
      if (aStale !== bStale) return bStale - aStale;
      return a.patientName.localeCompare(b.patientName);
    });

    req.log?.info(
      {
        event: "provider.rtm.roster",
        provider_id: account.providerId,
        patient_count: patients.length,
        window_days: windowDays,
      },
      "provider.rtm.roster",
    );

    res.json({ windowDays, patients });
  },
);

// ── GET /api/provider/patients/:id ────────────────────────────────
//
// One patient's detail: name snapshot, setup date, the recent-adherence
// rollup, and the authoritative CMS 90-day-window determination.

const idParam = z.object({ id: z.string().uuid() });
const detailQuery = z.object({
  days: z.coerce.number().int().min(7).max(90).default(ROSTER_WINDOW_DAYS),
});

router.get(
  "/api/provider/patients/:id",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  attachProviderOrgId,
  async (req, res) => {
    const account = req.providerAccount!;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsedQuery = detailQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const windowDays = parsedQuery.data.days;
    const orgId = resolveOrgId(req.orgId);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const patient = await loadOwnedPatient(
      orgId,
      account.providerId,
      params.data.id,
    );
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = getOrgScopedClient(orgId);
    const todayIso = new Date().toISOString().slice(0, 10);
    const startIso = new Date(Date.now() - windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // Recent-window nights for the rollup.
    const { data: recentRowsRaw, error: rErr } = await db
      .from("patient_therapy_nights")
      .select("night_date, source, usage_minutes, ahi, leak_rate_l_min")
      .eq("patient_id", patient.id)
      .gte("night_date", startIso)
      .order("night_date", { ascending: false })
      .limit(windowDays * 4);
    if (rErr) throw rErr;

    const recentDeduped = dedupeNights((recentRowsRaw ?? []) as NightRow[]);
    const snapshot = buildTherapySnapshot(
      recentDeduped.map(toSnapshotNight),
      windowDays,
      todayIso,
    );

    // All nights for the authoritative CMS 90-day window determination.
    const { data: allRowsRaw, error: aErr } = await db
      .from("patient_therapy_nights")
      .select("night_date, source, usage_minutes")
      .eq("patient_id", patient.id)
      .order("night_date", { ascending: true })
      .limit(20_000);
    if (aErr) throw aErr;

    const allDeduped = dedupeNights(
      (
        (allRowsRaw ?? []) as Array<{
          night_date: string;
          source: string;
          usage_minutes: number | null;
        }>
      ).map((r) => ({
        night_date: r.night_date,
        source: r.source,
        usage_minutes: r.usage_minutes,
        ahi: null,
        leak_rate_l_min: null,
      })),
    );
    const adherenceNights: AdherenceNight[] = allDeduped
      .map((r) => ({ date: r.night_date, usageMinutes: r.usage_minutes }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const setupDate = adherenceNights[0]?.date ?? null;
    const cms =
      setupDate != null
        ? findBestAdherenceWindow(adherenceNights, setupDate, todayIso)
        : null;

    req.log?.info(
      {
        event: "provider.rtm.patient_detail",
        provider_id: account.providerId,
        patient_id: patient.id,
        nights_with_data: snapshot.nightsWithData,
      },
      "provider.rtm.patient_detail",
    );

    res.json({
      patientId: patient.id,
      patientName: `${patient.legal_last_name}, ${patient.legal_first_name}`,
      setupDate,
      snapshot,
      cms: cms
        ? {
            qualifies: cms.qualifies,
            horizonComplete: cms.horizonComplete,
            window: cms.window
              ? {
                  startDate: cms.window.startDate,
                  endDate: cms.window.endDate,
                  compliantNights: cms.window.compliantNights,
                  ratioPct: Math.round(cms.window.ratio * 100),
                  averageUsageHours: cms.window.averageUsageHoursOnUsedNights,
                }
              : null,
          }
        : null,
    });
  },
);

// ── GET /api/provider/patients/:id/attestation.pdf ────────────────
//
// Streams the Medicare LCD L33718 90-day adherence attestation PDF for
// one of the provider's own patients. Reuses the admin compliance-
// attestation renderer; provider-scoped + MFA-gated.

const attestationQuery = z.object({
  anchor: z.string().regex(ISO_DATE).optional(),
});

router.get(
  "/api/provider/patients/:id/attestation.pdf",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  attachProviderOrgId,
  async (req, res) => {
    const account = req.providerAccount!;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsedQuery = attestationQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = resolveOrgId(req.orgId);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const patient = await loadOwnedPatient(
      orgId,
      account.providerId,
      params.data.id,
    );
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = getOrgScopedClient(orgId);
    const { data: nightRowsRaw, error: nErr } = await db
      .from("patient_therapy_nights")
      .select("night_date, source, usage_minutes")
      .eq("patient_id", patient.id)
      .order("night_date", { ascending: true })
      .limit(20_000);
    if (nErr) throw nErr;

    const nightRows = (nightRowsRaw ?? []) as Array<{
      night_date: string;
      source: string;
      usage_minutes: number | null;
    }>;
    if (nightRows.length === 0) {
      res.status(422).json({
        error: "no_therapy_data",
        message:
          "No therapy-night data on file for this patient yet. Once the device reports nights, the attestation can be generated.",
      });
      return;
    }

    const deduped = dedupeNights(
      nightRows.map((r) => ({
        night_date: r.night_date,
        source: r.source,
        usage_minutes: r.usage_minutes,
        ahi: null,
        leak_rate_l_min: null,
      })),
    );
    const nights: AdherenceNight[] = deduped
      .map((r) => ({ date: r.night_date, usageMinutes: r.usage_minutes }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const anchorDate = parsedQuery.data.anchor ?? nights[0]!.date;
    const asOfDate = new Date().toISOString().slice(0, 10);
    const result = findBestAdherenceWindow(nights, anchorDate, asOfDate);

    const supplierName = await getDocumentSupplierName(orgId);
    const inputs: AttestationInputs = {
      patient: {
        legalFirstName: patient.legal_first_name,
        legalLastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
      },
      anchorDate,
      result,
      generatedOn: new Date(),
      supplierName,
    };

    const doc = new PDFDocument({ margin: 72, size: "LETTER" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="adherence-${patient.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    doc.pipe(res);
    renderComplianceAttestation(doc, inputs);
    doc.end();

    logger.info(
      {
        event: "provider.rtm.attestation",
        provider_id: account.providerId,
        patient_id: patient.id,
        qualifies: result.qualifies,
      },
      "provider.rtm.attestation",
    );
  },
);

export default router;

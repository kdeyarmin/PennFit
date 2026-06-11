// pg-boss job: daily CMS PECOS Order/Referring sync.
//
// CMS publishes the active PECOS Order/Referring provider list at:
//   https://data.cms.gov/provider-characteristics/medicare-provider-supplier-enrollment/order-and-referring
// (downloadable CSV; refreshed weekly by CMS).
//
// We fetch a TARGETED slice — only the NPIs we actually use for
// referring/ordering. Walking the full ~1M-row file every day is
// wasteful when we have <2K active providers.
//
// Strategy:
//   1. Pull every NPI from resupply.providers where we care about
//      PECOS enrollment (any provider that has been used as
//      rendering or referring on a claim, ever).
//   2. Hit the CMS API per-NPI (the CMS public data API supports
//      ?filter[npi]=<npi>) — bounded by ~2K calls/day, rate-limited
//      to 5 req/sec.
//   3. Upsert into providers_pecos_status.
//
// Cron: daily at 03:13 UTC (off-peak; CMS refreshes weekly so daily
// is plenty fresh).
//
// Fallback: if the CMS API is down or returns no records for an
// NPI, we mark the row enrollment_status='unknown' with the current
// last_synced_at. The preflight scorer treats 'unknown' as the same
// risk weight as 'not approved' — conservative bias.

import type PgBoss from "pg-boss";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type EnrollmentStatus =
  Database["resupply"]["Tables"]["providers_pecos_status"]["Row"]["enrollment_status"];

const JOB = "pecos.sync";
const CRON = "13 3 * * *";
const SYSTEM_ACTOR_EMAIL = "system:cron:pecos-sync";

// The CMS public-data API endpoint for the Order & Referring dataset.
// Stable since 2020; the dataset id below is the published one.
const CMS_DATASET_URL =
  "https://data.cms.gov/data-api/v1/dataset/6cb6ca6c-7e63-4f8f-8a3d-1fb74e58a73b/data";
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RATE_LIMIT_MS = 200; // 5 req/sec

export interface SyncStats {
  scanned: number;
  fetched: number;
  upserted: number;
  unknown: number;
  errors: number;
}

export async function runPecosSync(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SyncStats> {
  const supabase = getSupabaseServiceRoleClient();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stats: SyncStats = {
    scanned: 0,
    fetched: 0,
    upserted: 0,
    unknown: 0,
    errors: 0,
  };

  const npis = await collectActiveNpis(supabase);
  stats.scanned = npis.length;

  for (const npi of npis) {
    try {
      const enrolled = await fetchPecosStatus(fetchImpl, npi);
      stats.fetched += 1;
      const status: EnrollmentStatus = enrolled ? "approved" : "unknown";
      if (!enrolled) stats.unknown += 1;
      await upsertStatus(supabase, npi, status, enrolled);
      stats.upserted += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        {
          err,
          npi,
        },
        "pecos.sync: per-NPI fetch failed",
      );
    }
    await sleep(FETCH_RATE_LIMIT_MS);
  }
  return stats;
}

async function collectActiveNpis(supabase: SupabaseClient): Promise<string[]> {
  // Gather distinct NPIs from the providers table. KEYSET-PAGINATED:
  // PostgREST caps a single response at ~1000 rows, so the previous
  // unpaginated read silently truncated there — at the documented <2K
  // provider population that left roughly half the providers never
  // PECOS-checked. Page through by id and bound the distinct-NPI set to
  // MAX_NPIS_PER_RUN so the throttled per-NPI loop (5 req/sec) stays
  // inside the job lease. The
  // whole population fits in one run at current scale; the bound only
  // engages far beyond it (a staleness-ordered rotation keyed on
  // providers_pecos_status.last_synced_at is the follow-up if the
  // population ever approaches the bound).
  const PAGE_SIZE = 1000;
  const MAX_NPIS_PER_RUN = 3000;
  const npis = new Set<string>();
  for (let from = 0; npis.size < MAX_NPIS_PER_RUN; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id, npi")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const p of data) {
      if (/^\d{10}$/.test(p.npi)) npis.add(p.npi);
    }
    if (data.length < PAGE_SIZE) break;
  }
  return [...npis];
}

async function fetchPecosStatus(
  fetchImpl: typeof fetch,
  npi: string,
): Promise<boolean> {
  const url = `${CMS_DATASET_URL}?filter[NPI]=${npi}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // CMS sometimes returns 404 for unknown NPIs — that's a valid
      // "not in PECOS" signal, not an error.
      if (res.status === 404) return false;
      throw new Error(`CMS API status ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    return Array.isArray(data) && data.length > 0;
  } finally {
    clearTimeout(timer);
  }
}

async function upsertStatus(
  supabase: SupabaseClient,
  npi: string,
  status: EnrollmentStatus,
  enrolled: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  // Use insert with on-conflict via the manual update fallback to
  // avoid relying on the supabase upsert(), which has subtle
  // semantics around returning shapes.
  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("providers_pecos_status")
    .upsert(
      {
        npi,
        enrollment_status: status,
        enrollment_type: enrolled ? "physician_or_npp" : null,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "npi" },
    );
  if (insertErr) {
    throw insertErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function registerPecosSyncJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    try {
      const stats = await runPecosSync();
      logger.info(
        { event: "pecos.sync.completed", actor: SYSTEM_ACTOR_EMAIL, ...stats },
        "pecos.sync: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "pecos.sync: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "pecos.sync scheduled");
}

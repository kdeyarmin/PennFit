// pg-boss job: monthly OIG LEIE exclusion-list refresh.
//
// OIG publishes the full LEIE file at
//   https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv
// on the first business day of each month. The file is ~80k rows
// and ~7MB; small enough that a single fetch + parse is fine.
//
// Strategy:
//   1. Fetch the CSV. Bail if the response isn't 200.
//   2. Parse rows via `parseLeieCsvLine`. Bad rows are skipped.
//   3. TRUNCATE + bulk INSERT inside the same job. We're the only
//      writer for this table so a truncate/reload is safe; the
//      per-subject `oig_leie_screenings` history is preserved (it
//      references `oig_leie_exclusions` via SET NULL, not CASCADE).
//   4. Stamp `source_file_version` with the YYYY-MM cycle.
//
// Cron: monthly at 04:07 UTC on the 4th (gives OIG time to publish).
//
// Manual trigger: callable via runOigLeieSync() (export) from the
// admin-tooling routes; the cron path just wraps it.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  LEIE_CSV_EXPECTED_HEADER,
  parseLeieCsvLine,
  type ParsedLeieRow,
} from "../../lib/compliance/oig-leie-screener";
import { logger } from "../../lib/logger";

const JOB = "compliance.oig_leie.sync";
const CRON = "7 4 4 * *";
const SYSTEM_ACTOR_EMAIL = "system:cron:oig-leie-sync";
const LEIE_CSV_URL =
  "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv";
const FETCH_TIMEOUT_MS = 60_000;
const INSERT_BATCH_SIZE = 500;

export interface OigSyncStats {
  fetched: number;
  parsed: number;
  skipped: number;
  inserted: number;
}

export async function runOigLeieSync(
  opts: { fetchImpl?: typeof fetch; sourceUrl?: string } = {},
): Promise<OigSyncStats> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.sourceUrl ?? LEIE_CSV_URL;
  const stats: OigSyncStats = {
    fetched: 0,
    parsed: 0,
    skipped: 0,
    inserted: 0,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let body: string;
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { Accept: "text/csv" },
    });
    if (!res.ok) throw new Error(`LEIE fetch ${res.status}`);
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  stats.fetched = body.length;

  const lines = body.split(/\r?\n/);
  const header = lines[0]
    ?.toUpperCase()
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""));
  if (!header || !arraysEqual(header, LEIE_CSV_EXPECTED_HEADER)) {
    throw new Error(
      `LEIE header mismatch — expected ${LEIE_CSV_EXPECTED_HEADER.join(",")}`,
    );
  }

  const rows: ParsedLeieRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().length === 0) continue;
    const cells = parseCsvLine(line);
    const parsed = parseLeieCsvLine(cells);
    if (!parsed) {
      stats.skipped += 1;
      continue;
    }
    rows.push(parsed);
    stats.parsed += 1;
  }

  if (rows.length === 0) {
    logger.warn({ url }, "oig_leie.sync: parsed zero rows — aborting refresh");
    return stats;
  }

  const now = new Date();
  // Add a millisecond suffix so a same-day re-run doesn't collide
  // with itself — `2026-05` reruns inside one cycle would otherwise
  // wipe the data they just loaded. The screener doesn't filter on
  // source_file_version (only on reinstate_date + name/NPI), so a
  // sub-cycle suffix is fine for the version label.
  const version = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1,
  ).padStart(2, "0")}-${now.getTime()}`;
  const supabase = getSupabaseServiceRoleClient();

  // Shadow-swap (not delete-then-insert). The OLD behaviour was:
  //   1. DELETE every existing row.
  //   2. Bulk-INSERT the new rows in 500-row batches.
  // If any INSERT batch failed (network blip, single bad row,
  // PostgREST 502), the table sat partial OR empty for an entire
  // cycle — and every screenSubject() call during that window
  // silently returned `match: null` for providers who are actually
  // on the LEIE list. That's a HIPAA / FWA control failure: we'd
  // dispense to (and bill Medicare for) excluded providers and
  // have an audit row proving "we checked, nobody home".
  //
  // The shadow swap inserts the NEW version's rows FIRST. Both old
  // and new rows coexist briefly — the screener sees both, which
  // is safe because it doesn't filter on source_file_version. Only
  // after every batch has landed do we DELETE the prior version's
  // rows, so a partial-insert crash leaves the OLD version intact
  // (false-positive risk on freshly reinstated providers, never
  // false-negative).
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const slice = rows.slice(i, i + INSERT_BATCH_SIZE).map((r) => ({
      npi: r.npi,
      lastname: r.lastname,
      firstname: r.firstname,
      middlename: r.middlename,
      subject_type: r.subjectType,
      exclusion_type: r.exclusionType,
      exclusion_date: r.exclusionDate,
      waiver_date: r.waiverDate,
      reinstate_date: r.reinstateDate,
      address_state: r.addressState,
      address_city: r.addressCity,
      source_file_version: version,
    }));
    const { error } = await supabase
      .schema("resupply")
      .from("oig_leie_exclusions")
      .insert(slice);
    if (error) throw error;
    stats.inserted += slice.length;
  }

  // All NEW rows landed. Now retire every row tagged with a prior
  // version. SQL `<>` is NULL-unsafe (NULL <> anything is NULL, not
  // true), so legacy rows whose source_file_version was never set
  // would otherwise survive forever. The OR clause picks up both
  // mismatched values AND NULLs.
  const { error: pruneErr } = await supabase
    .schema("resupply")
    .from("oig_leie_exclusions")
    .delete()
    .or(`source_file_version.is.null,source_file_version.neq.${version}`);
  if (pruneErr) throw pruneErr;

  return stats;
}

function arraysEqual(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        buf += ch;
      }
    } else if (ch === ",") {
      out.push(buf);
      buf = "";
    } else if (ch === '"') {
      inQuote = true;
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

export async function registerOigLeieSyncJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runOigLeieSync();
      logger.info(
        {
          event: "oig_leie.sync.completed",
          actor: SYSTEM_ACTOR_EMAIL,
          ...stats,
        },
        "oig_leie.sync: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "oig_leie.sync: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "oig_leie.sync scheduled");
}

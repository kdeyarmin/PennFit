// deploy-environment.mjs — "which deployment is this, and which database
// is it pointed at?", answered fail-closed.
//
// THE INCIDENT THIS EXISTS TO PREVENT
// -----------------------------------
// A Railway PR-preview environment inherited the production service's
// shared variables — DATABASE_URL among them — and its `preDeployCommand`
// ran the migrator. A schema migration authored on an unmerged branch was
// therefore applied to the PRODUCTION database by a preview deploy. No
// person decided that; nothing in the repo could have stopped it, because
// the only signal the migrator had was "DATABASE_URL is set".
//
// Two facts make that class of accident recurrent rather than a one-off:
//
//   1. Railway's shared/project variables propagate INTO preview
//      environments. Any variable an operator sets to describe the
//      production service is therefore also visible to a preview claiming
//      to be that service. A self-declared identity alone can never be
//      trusted.
//   2. NODE_ENV is not injected by Railway at all (see
//      artifacts/resupply-api/src/lib/deployed-runtime.ts), so the
//      historical "is this production?" test was false on every Railway
//      container, production included.
//
// THE SHAPE OF THE FIX
// --------------------
// Two independent identities, cross-checked:
//
//   DEPLOYMENT identity — what is running.
//     `DEPLOY_ENV` is the explicit declaration, but it is INHERITABLE and
//     therefore not sufficient on its own. It is corroborated against
//     Railway's own per-deployment markers, which are NOT inheritable:
//     `RAILWAY_ENVIRONMENT_NAME` (a PR environment is named after its PR)
//     and `RAILWAY_GIT_BRANCH` (production deploys from the production
//     branch; a preview never does). A declaration of `production` that
//     the non-inheritable markers deny is a CONFLICT, and a conflict is
//     ambiguity, and ambiguity blocks.
//
//   DATABASE identity — what it is pointed at.
//     `PRODUCTION_DATABASE_FINGERPRINT` pins the production database by a
//     salted hash of host:port/dbname. Fingerprinting rather than naming
//     is deliberate: the fingerprint is safe to set on every environment
//     (that is the point — it must reach the preview to be checked there)
//     and it cannot be spoofed by a preview that merely claims to be
//     pointed somewhere else. `DATABASE_ENV` is the operator's
//     declaration and is used when no fingerprint match settles it.
//
// The rule, stated once: A DEPLOYMENT THAT IS NOT PRODUCTION MAY NOT
// MIGRATE A DATABASE THAT IS NOT POSITIVELY NON-PRODUCTION.
//
// WHY A PRODUCTION DEPLOYMENT IS ALLOWED AGAINST AN UNDECLARED DATABASE
// ---------------------------------------------------------------------
// A production deployment whose identity is unambiguous, pointed at a
// database whose tier nobody has declared, is ALLOWED — loudly, with a
// warning naming the variable to set. Blocking it would brick the
// existing production pipeline the moment this file merged, for a case
// that is not the dangerous direction: production migrating production is
// the intended path, and production migrating a preview database is
// harmless. The pressure to declare the fingerprint belongs in
// `preflight:prod` (which fails without it) rather than in a gate that
// can only express itself by stopping a real release.
//
// PHI / SECRETS: this module parses DATABASE_URL to fingerprint it. It
// never returns, logs, or throws the URL, the password, or the username.
// The only derived value that escapes is a 12-hex-character digest.

import crypto from "node:crypto";

/**
 * Fixed, non-secret salt. Its job is to keep the digest from being a
 * bare hash of a guessable hostname, not to be confidential — it ships
 * in the repo on purpose so the same host fingerprints identically for
 * every operator and in CI.
 */
const FINGERPRINT_SALT = "pennfit-db-fingerprint-v1";

/** Deployment/database tiers, most to least privileged. */
export const TIERS = Object.freeze([
  "production",
  "staging",
  "preview",
  "development",
  "test",
]);

/** Spellings accepted for each tier in DEPLOY_ENV / DATABASE_ENV. */
const TIER_ALIASES = new Map(
  Object.entries({
    production: "production",
    prod: "production",
    live: "production",
    staging: "staging",
    stage: "staging",
    preview: "preview",
    pr: "preview",
    ephemeral: "preview",
    development: "development",
    dev: "development",
    local: "development",
    test: "test",
    ci: "test",
    testing: "test",
  }),
);

/**
 * Normalize a declared tier spelling.
 *
 * @param {string | undefined | null} raw
 * @returns {{ tier: string } | { tier: null, invalid: string } | null}
 *   `null` when unset; `{tier}` when recognized; `{tier:null,invalid}`
 *   when set to something we refuse to guess at.
 */
export function normalizeTier(raw) {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  const tier = TIER_ALIASES.get(value);
  if (!tier) return { tier: null, invalid: value };
  return { tier };
}

/** True for the tiers that are allowed to touch a production database. */
export function isProductionTier(tier) {
  return tier === "production";
}

/**
 * Salted, truncated digest of a database's IDENTITY — host, port and
 * database name, lowercased. Credentials and query parameters are
 * excluded so rotating a password does not change the fingerprint and so
 * no secret material reaches the digest input.
 *
 * @param {string | undefined | null} url A postgres:// or https:// URL.
 * @returns {{ fingerprint: string, host: string, database: string } | null}
 *   `null` when the URL is absent or unparseable. `host` is returned for
 *   the caller's own redaction decisions; the migrator prints only the
 *   fingerprint.
 */
export function fingerprintDatabaseUrl(url) {
  const raw = (url ?? "").trim();
  if (raw === "") return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "") return null;
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  // For postgres URLs the pathname is the database name; for a Supabase
  // https URL it is empty and the project ref lives in the hostname.
  const database = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  const identity = `${host}${port}/${database}`;
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${FINGERPRINT_SALT}:${identity}`)
    .digest("hex")
    .slice(0, 12);
  return { fingerprint, host, database };
}

/** Hostnames that can only ever be a developer's own machine. */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "host.docker.internal",
  "postgres",
  "db",
]);

/**
 * Does this Railway environment name describe a pull-request preview?
 * Railway's GitHub integration names them `<project>-pr-<number>`; we
 * also accept a bare `pr-123` and anything containing "preview".
 */
function looksLikePreviewEnvironment(name) {
  const value = name.trim().toLowerCase();
  if (value === "") return false;
  if (value.includes("preview")) return true;
  if (value.includes("ephemeral")) return true;
  return /(^|[-_/])pr[-_]?\d+([-_]|$)/.test(value);
}

/**
 * Infer the deployment tier from signals the platform sets ITSELF, which
 * a shared/inherited variable cannot forge.
 *
 * Returns `null` — "no opinion" — rather than guessing, so a production
 * service that happens to run in a differently-named Railway environment
 * is not mislabelled. Only positive evidence is reported.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ tier: string, signal: string } | null}
 */
export function inferDeploymentTierFromPlatform(env) {
  const productionBranch = (env.PRODUCTION_GIT_BRANCH ?? "main").trim();
  const envName = (
    env.RAILWAY_ENVIRONMENT_NAME ??
    env.RAILWAY_ENVIRONMENT ??
    ""
  ).trim();
  const branch = (env.RAILWAY_GIT_BRANCH ?? "").trim();

  // A PR-shaped environment name is the strongest denial available: it is
  // set by Railway per environment and is exactly what the incident
  // deployment carried.
  if (looksLikePreviewEnvironment(envName)) {
    return { tier: "preview", signal: "RAILWAY_ENVIRONMENT_NAME" };
  }
  // A deploy from a branch other than the production branch is not
  // production, whatever it calls itself.
  if (branch !== "" && branch !== productionBranch) {
    return { tier: "preview", signal: "RAILWAY_GIT_BRANCH" };
  }
  const lowered = envName.toLowerCase();
  if (lowered === "staging" || lowered === "stage") {
    return { tier: "staging", signal: "RAILWAY_ENVIRONMENT_NAME" };
  }
  if (lowered === "production" || lowered === "prod") {
    return { tier: "production", signal: "RAILWAY_ENVIRONMENT_NAME" };
  }
  return null;
}

/** True when any Railway marker is present — i.e. this is a container. */
export function isPlatformDeployment(env) {
  return [
    env.RAILWAY_ENVIRONMENT,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_PROJECT_ID,
    env.RAILWAY_DEPLOYMENT_ID,
    env.RAILWAY_SERVICE_ID,
  ].some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * Resolve WHAT IS RUNNING.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   tier: string | null,
 *   ambiguous: boolean,
 *   reason: string,
 *   declared: string | null,
 *   inferred: string | null,
 *   signal: string | null,
 * }}
 */
export function resolveDeploymentIdentity(env) {
  const declaredRaw = normalizeTier(env.DEPLOY_ENV);
  const inferred = inferDeploymentTierFromPlatform(env);

  if (declaredRaw && declaredRaw.tier === null) {
    return {
      tier: null,
      ambiguous: true,
      reason:
        `DEPLOY_ENV is set to an unrecognized value. Use one of: ` +
        `${TIERS.join(", ")}.`,
      declared: null,
      inferred: inferred?.tier ?? null,
      signal: inferred?.signal ?? null,
    };
  }

  const declared = declaredRaw?.tier ?? null;

  // The load-bearing cross-check. A declaration of production that the
  // platform's own non-inheritable markers deny means the variables are
  // wrong, and we do not know which of the two is describing reality —
  // including which database this actually is.
  if (declared === "production" && inferred && inferred.tier !== "production") {
    return {
      tier: null,
      ambiguous: true,
      reason:
        `DEPLOY_ENV declares "production" but ${inferred.signal} identifies ` +
        `this deployment as "${inferred.tier}". A shared variable has most ` +
        `likely leaked into a non-production environment. Set DEPLOY_ENV on ` +
        `each environment individually.`,
      declared,
      inferred: inferred.tier,
      signal: inferred.signal,
    };
  }

  if (declared) {
    return {
      tier: declared,
      ambiguous: false,
      reason: "DEPLOY_ENV",
      declared,
      inferred: inferred?.tier ?? null,
      signal: inferred?.signal ?? null,
    };
  }

  if (inferred) {
    return {
      tier: inferred.tier,
      ambiguous: false,
      reason: inferred.signal,
      declared: null,
      inferred: inferred.tier,
      signal: inferred.signal,
    };
  }

  // No declaration and no platform opinion. On a platform container that
  // is genuine ambiguity — we are deployed somewhere and cannot say
  // where. Off-platform it is simply a developer's shell.
  if (isPlatformDeployment(env)) {
    return {
      tier: null,
      ambiguous: true,
      reason:
        "Running on a deployment platform with no resolvable environment " +
        "identity. Set DEPLOY_ENV=production|staging|preview on this service.",
      declared: null,
      inferred: null,
      signal: null,
    };
  }

  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  return {
    tier: nodeEnv === "test" ? "test" : "development",
    ambiguous: false,
    reason: "no deployment-platform markers present (local shell)",
    declared: null,
    inferred: null,
    signal: null,
  };
}

/**
 * Resolve WHAT IT IS POINTED AT.
 *
 * Precedence: a fingerprint match against the declared production
 * database is authoritative and beats any DATABASE_ENV claim, because
 * the fingerprint is computed from the connection actually in hand
 * while DATABASE_ENV is just a string somebody set.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string | undefined} [databaseUrl] Defaults to env.DATABASE_URL.
 * @returns {{
 *   tier: string | null,
 *   ambiguous: boolean,
 *   reason: string,
 *   fingerprint: string | null,
 *   declared: string | null,
 * }}
 */
export function resolveDatabaseIdentity(env, databaseUrl) {
  const url = databaseUrl ?? env.DATABASE_URL;
  const fp = fingerprintDatabaseUrl(url);
  const declaredRaw = normalizeTier(env.DATABASE_ENV);

  if (declaredRaw && declaredRaw.tier === null) {
    return {
      tier: null,
      ambiguous: true,
      reason: `DATABASE_ENV is set to an unrecognized value. Use one of: ${TIERS.join(", ")}.`,
      fingerprint: fp?.fingerprint ?? null,
      declared: null,
    };
  }
  const declared = declaredRaw?.tier ?? null;

  if (!fp) {
    return {
      tier: declared,
      ambiguous: declared === null,
      reason: declared
        ? "DATABASE_ENV"
        : "DATABASE_URL is missing or not a parseable URL.",
      fingerprint: null,
      declared,
    };
  }

  const productionFingerprints = new Set(
    (env.PRODUCTION_DATABASE_FINGERPRINT ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== ""),
  );

  if (productionFingerprints.has(fp.fingerprint)) {
    if (declared !== null && declared !== "production") {
      return {
        tier: "production",
        ambiguous: false,
        reason:
          `fingerprint matches PRODUCTION_DATABASE_FINGERPRINT, overriding ` +
          `DATABASE_ENV="${declared}". Treating the database as production.`,
        fingerprint: fp.fingerprint,
        declared,
      };
    }
    return {
      tier: "production",
      ambiguous: false,
      reason: "fingerprint matches PRODUCTION_DATABASE_FINGERPRINT",
      fingerprint: fp.fingerprint,
      declared,
    };
  }

  // A declared production fingerprint exists and this is not it: the
  // database is positively NOT production. That is a real answer, and it
  // is what lets a preview with its own database migrate freely.
  if (productionFingerprints.size > 0 && declared === null) {
    return {
      tier: "preview",
      ambiguous: false,
      reason:
        "fingerprint does not match any PRODUCTION_DATABASE_FINGERPRINT entry",
      fingerprint: fp.fingerprint,
      declared: null,
    };
  }

  if (declared) {
    return {
      tier: declared,
      ambiguous: false,
      reason: "DATABASE_ENV",
      fingerprint: fp.fingerprint,
      declared,
    };
  }

  if (LOOPBACK_HOSTS.has(fp.host)) {
    return {
      tier: "development",
      ambiguous: false,
      reason: "database host is loopback/container-local",
      fingerprint: fp.fingerprint,
      declared: null,
    };
  }

  return {
    tier: null,
    ambiguous: true,
    reason:
      "database tier is undeclared. Set DATABASE_ENV on this service, or " +
      "set PRODUCTION_DATABASE_FINGERPRINT so a non-match proves this is " +
      "not production.",
    fingerprint: fp.fingerprint,
    declared: null,
  };
}

/**
 * The break-glass override. Deliberately awkward: two variables, one an
 * exact confirmation phrase, the other a reason long enough that nobody
 * types it by reflex. Default off; never inferred.
 */
export const BREAK_GLASS_VAR =
  "DANGEROUSLY_ALLOW_PRODUCTION_DB_MIGRATION_FROM_NONPRODUCTION";
export const BREAK_GLASS_PHRASE = "I-UNDERSTAND-THIS-WRITES-TO-PRODUCTION";
export const BREAK_GLASS_REASON_VAR = "MIGRATION_BREAK_GLASS_REASON";
const BREAK_GLASS_REASON_MIN_LENGTH = 20;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ engaged: boolean, reason: string | null, problem: string | null }}
 */
export function readBreakGlass(env) {
  const phrase = (env[BREAK_GLASS_VAR] ?? "").trim();
  const reason = (env[BREAK_GLASS_REASON_VAR] ?? "").trim();
  if (phrase === "" && reason === "") {
    return { engaged: false, reason: null, problem: null };
  }
  if (phrase !== BREAK_GLASS_PHRASE) {
    return {
      engaged: false,
      reason: null,
      problem:
        `${BREAK_GLASS_VAR} is set but does not equal the exact confirmation ` +
        `phrase. Set it to ${BREAK_GLASS_PHRASE} if you truly intend this.`,
    };
  }
  if (reason.length < BREAK_GLASS_REASON_MIN_LENGTH) {
    return {
      engaged: false,
      reason: null,
      problem:
        `${BREAK_GLASS_REASON_VAR} must be set to a specific reason of at ` +
        `least ${BREAK_GLASS_REASON_MIN_LENGTH} characters (an incident id, ` +
        `a ticket, what you are fixing). Break-glass is never anonymous.`,
    };
  }
  return { engaged: true, reason, problem: null };
}

/**
 * THE GATE. Decide whether this process may apply schema migrations.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ databaseUrl?: string }} [options]
 * @returns {{
 *   allowed: boolean,
 *   code: string,
 *   message: string,
 *   warnings: string[],
 *   deployment: ReturnType<typeof resolveDeploymentIdentity>,
 *   database: ReturnType<typeof resolveDatabaseIdentity>,
 *   breakGlass: { engaged: boolean, reason: string | null },
 * }}
 */
export function evaluateMigrationGuard(env, options = {}) {
  const deployment = resolveDeploymentIdentity(env);
  const database = resolveDatabaseIdentity(env, options.databaseUrl);
  const breakGlass = readBreakGlass(env);
  const warnings = [];

  if (breakGlass.problem) warnings.push(breakGlass.problem);

  const summary =
    `deployment=${deployment.tier ?? "ambiguous"} ` +
    `database=${database.tier ?? "ambiguous"}` +
    (database.fingerprint ? ` db-fingerprint=${database.fingerprint}` : "");

  if (deployment.ambiguous) {
    return {
      allowed: false,
      code: "ambiguous_deployment_identity",
      message: `Refusing to migrate: ${deployment.reason} (${summary})`,
      warnings,
      deployment,
      database,
      breakGlass: { engaged: false, reason: null },
    };
  }

  if (database.ambiguous) {
    // A production deployment is the one case where an undeclared
    // database is tolerable — see the header. Everything else stops.
    if (isProductionTier(deployment.tier)) {
      warnings.push(
        `Database tier is undeclared: ${database.reason} A production ` +
          `deployment is allowed to proceed, but set ` +
          `PRODUCTION_DATABASE_FINGERPRINT=${database.fingerprint ?? "<fingerprint>"} ` +
          `so preview deployments can be blocked from this database.`,
      );
      return {
        allowed: true,
        code: "production_deployment_undeclared_database",
        message: `Allowing migration from a production deployment (${summary}).`,
        warnings,
        deployment,
        database,
        breakGlass: { engaged: false, reason: null },
      };
    }
    return {
      allowed: false,
      code: "ambiguous_database_identity",
      message: `Refusing to migrate: ${database.reason} (${summary})`,
      warnings,
      deployment,
      database,
      breakGlass: { engaged: false, reason: null },
    };
  }

  const targetsProduction = isProductionTier(database.tier);
  const isProductionDeployment = isProductionTier(deployment.tier);

  if (targetsProduction && !isProductionDeployment) {
    if (breakGlass.engaged) {
      return {
        allowed: true,
        code: "break_glass_override",
        message:
          `BREAK-GLASS OVERRIDE ENGAGED: a ${deployment.tier} deployment is ` +
          `migrating the PRODUCTION database (${summary}).`,
        warnings,
        deployment,
        database,
        breakGlass: { engaged: true, reason: breakGlass.reason },
      };
    }
    return {
      allowed: false,
      code: "nonproduction_deployment_production_database",
      message:
        `Refusing to migrate: this is a ${deployment.tier} deployment ` +
        `(${deployment.reason}) but DATABASE_URL points at the PRODUCTION ` +
        `database (${database.reason}). ${summary}`,
      warnings,
      deployment,
      database,
      breakGlass: { engaged: false, reason: null },
    };
  }

  return {
    allowed: true,
    code: "allowed",
    message: `Migration allowed (${summary}).`,
    warnings,
    deployment,
    database,
    breakGlass: { engaged: false, reason: null },
  };
}

/**
 * Render the guard result for a deploy log: a human-readable banner plus
 * one machine-parseable JSON line so an alerting pipeline can key on the
 * break-glass event without scraping prose.
 *
 * @param {ReturnType<typeof evaluateMigrationGuard>} result
 * @returns {string}
 */
export function formatGuardReport(result) {
  const lines = [];
  const tag = "[migration-guard]";
  for (const warning of result.warnings) {
    lines.push(`${tag} WARNING: ${warning}`);
  }
  if (result.breakGlass.engaged) {
    lines.push(
      `${tag} ============================================================`,
      `${tag}  BREAK-GLASS OVERRIDE: a non-production deployment is about`,
      `${tag}  to apply schema migrations to the PRODUCTION database.`,
      `${tag}  reason: ${result.breakGlass.reason}`,
      `${tag} ============================================================`,
    );
  }
  lines.push(`${tag} ${result.message}`);
  lines.push(
    JSON.stringify({
      event: result.breakGlass.engaged
        ? "migration.guard.break_glass"
        : result.allowed
          ? "migration.guard.allowed"
          : "migration.guard.blocked",
      code: result.code,
      deploymentTier: result.deployment.tier,
      deploymentSignal: result.deployment.reason,
      databaseTier: result.database.tier,
      databaseFingerprint: result.database.fingerprint,
      breakGlass: result.breakGlass.engaged,
      breakGlassReason: result.breakGlass.reason,
    }),
  );
  return `${lines.join("\n")}\n`;
}

// ── Runtime (boot-time) data-path guard ──────────────────────────────
//
// The migrator is not the only way a preview can reach production data.
// The runtime data path is Supabase (SUPABASE_URL + the service-role
// key), and a preview that inherited those variables would READ AND WRITE
// production patient records without applying a single migration.
//
// WHY THIS IS NARROWER THAN THE MIGRATION GUARD
// ---------------------------------------------
// The migration guard refuses on ambiguity, and that is safe: a refused
// preDeployCommand gates the deploy, so the PREVIOUS release keeps
// serving. A boot refusal has no such fallback shape for an operator who
// simply has not set a new variable yet — production would go dark for a
// missing string. So this guard fires ONLY on a positive, unambiguous
// cross-tier violation: a deployment positively identified as
// non-production, pointed at a data path positively identified as
// production. Everything else warns.

/**
 * Fingerprint the Supabase project URL. Same digest function as the
 * Postgres URL — for `https://abc.supabase.co` the identity reduces to
 * the hostname, which is the project ref.
 *
 * @param {string | undefined | null} url
 */
export function fingerprintSupabaseUrl(url) {
  return fingerprintDatabaseUrl(url);
}

/**
 * Is this specific URL the production data path?
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string | undefined} url
 * @param {string} fingerprintVar Name of the env var holding the pinned
 *   production fingerprint(s).
 * @returns {{ production: boolean, fingerprint: string | null }}
 */
function matchesPinnedProduction(env, url, fingerprintVar) {
  const fp = fingerprintDatabaseUrl(url);
  if (!fp) return { production: false, fingerprint: null };
  const pinned = new Set(
    (env[fingerprintVar] ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== ""),
  );
  return {
    production: pinned.has(fp.fingerprint),
    fingerprint: fp.fingerprint,
  };
}

/**
 * Boot-time cross-tier check for the runtime data path.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   safe: boolean,
 *   code: string,
 *   message: string,
 *   warnings: string[],
 *   deploymentTier: string | null,
 * }}
 */
export function evaluateRuntimeDataPathGuard(env) {
  const deployment = resolveDeploymentIdentity(env);
  const warnings = [];

  // Ambiguity warns; see the header for why it must not refuse.
  if (deployment.ambiguous) {
    return {
      safe: true,
      code: "ambiguous_deployment_identity",
      message: `Deployment identity is ambiguous: ${deployment.reason}`,
      warnings: [
        `Deployment identity is ambiguous (${deployment.reason}) — the ` +
          "runtime cannot verify it is not pointed at production data. Set " +
          "DEPLOY_ENV on this service.",
      ],
      deploymentTier: null,
    };
  }

  if (isProductionTier(deployment.tier)) {
    return {
      safe: true,
      code: "production_deployment",
      message: "Production deployment; data-path check not applicable.",
      warnings,
      deploymentTier: deployment.tier,
    };
  }

  const offenders = [];

  const db = matchesPinnedProduction(
    env,
    env.DATABASE_URL,
    "PRODUCTION_DATABASE_FINGERPRINT",
  );
  if (db.production) offenders.push(`DATABASE_URL (${db.fingerprint})`);

  const supabase = matchesPinnedProduction(
    env,
    env.SUPABASE_URL,
    "PRODUCTION_SUPABASE_FINGERPRINT",
  );
  if (supabase.production) {
    offenders.push(`SUPABASE_URL (${supabase.fingerprint})`);
  }

  // An explicit DATABASE_ENV=production on a non-production deployment is
  // the operator saying it out loud.
  const declaredDb = normalizeTier(env.DATABASE_ENV);
  if (declaredDb && declaredDb.tier === "production") {
    offenders.push("DATABASE_ENV=production");
  }

  if (offenders.length > 0) {
    return {
      safe: false,
      code: "nonproduction_deployment_production_data_path",
      message:
        `This is a ${deployment.tier} deployment (${deployment.reason}) but ` +
        `its runtime data path is PRODUCTION: ${offenders.join(", ")}. ` +
        "Refusing to boot — a preview that writes production patient records " +
        "is worse than a preview that does not start. Point this environment " +
        "at its own database, or unset the production credentials on it.",
      warnings,
      deploymentTier: deployment.tier,
    };
  }

  if (
    !env.PRODUCTION_DATABASE_FINGERPRINT &&
    !env.PRODUCTION_SUPABASE_FINGERPRINT
  ) {
    warnings.push(
      "No PRODUCTION_DATABASE_FINGERPRINT / PRODUCTION_SUPABASE_FINGERPRINT " +
        "is pinned, so this deployment cannot prove it is not pointed at " +
        "production data. See docs/runbooks/migration-environment-guard.md.",
    );
  }

  return {
    safe: true,
    code: "ok",
    message: `${deployment.tier} deployment; data path is not production.`,
    warnings,
    deploymentTier: deployment.tier,
  };
}

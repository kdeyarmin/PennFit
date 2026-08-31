// Type surface for the deployment/database guard. The implementation is
// a plain `.mjs` on purpose: it runs as Railway's `preDeployCommand`,
// BEFORE the workspace is built, so it can carry no compile step. These
// declarations let the API import the same rules rather than keeping a
// second, drifting copy of them in TypeScript.

export declare const TIERS: readonly string[];

export type DeploymentTier =
  | "production"
  | "staging"
  | "preview"
  | "development"
  | "test";

export declare function normalizeTier(
  raw: string | undefined | null,
): { tier: DeploymentTier } | { tier: null; invalid: string } | null;

export declare function isProductionTier(tier: string | null): boolean;

export declare function fingerprintDatabaseUrl(
  url: string | undefined | null,
): { fingerprint: string; host: string; database: string } | null;

export declare function fingerprintSupabaseUrl(
  url: string | undefined | null,
): { fingerprint: string; host: string; database: string } | null;

export declare function inferDeploymentTierFromPlatform(
  env: NodeJS.ProcessEnv,
): { tier: DeploymentTier; signal: string } | null;

export declare function isPlatformDeployment(env: NodeJS.ProcessEnv): boolean;

export interface DeploymentIdentity {
  tier: DeploymentTier | null;
  ambiguous: boolean;
  reason: string;
  declared: DeploymentTier | null;
  inferred: DeploymentTier | null;
  signal: string | null;
}

export declare function resolveDeploymentIdentity(
  env: NodeJS.ProcessEnv,
): DeploymentIdentity;

export interface DatabaseIdentity {
  tier: DeploymentTier | null;
  ambiguous: boolean;
  reason: string;
  fingerprint: string | null;
  declared: DeploymentTier | null;
}

export declare function resolveDatabaseIdentity(
  env: NodeJS.ProcessEnv,
  databaseUrl?: string,
): DatabaseIdentity;

export declare const BREAK_GLASS_VAR: string;
export declare const BREAK_GLASS_PHRASE: string;
export declare const BREAK_GLASS_REASON_VAR: string;

export declare function readBreakGlass(env: NodeJS.ProcessEnv): {
  engaged: boolean;
  reason: string | null;
  problem: string | null;
};

export interface MigrationGuardResult {
  allowed: boolean;
  code: string;
  message: string;
  warnings: string[];
  deployment: DeploymentIdentity;
  database: DatabaseIdentity;
  breakGlass: { engaged: boolean; reason: string | null };
}

export declare function evaluateMigrationGuard(
  env: NodeJS.ProcessEnv,
  options?: { databaseUrl?: string },
): MigrationGuardResult;

export declare function formatGuardReport(result: MigrationGuardResult): string;

export interface RuntimeDataPathGuardResult {
  safe: boolean;
  code: string;
  message: string;
  warnings: string[];
  deploymentTier: DeploymentTier | null;
}

export declare function evaluateRuntimeDataPathGuard(
  env: NodeJS.ProcessEnv,
): RuntimeDataPathGuardResult;

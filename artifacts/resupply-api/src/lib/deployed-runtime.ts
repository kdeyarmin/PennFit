// Deployed-runtime detection — "is this process a real deploy, not a
// dev shell?"
//
// Used by boot-time guards that must fail the deploy (crash before the
// listener binds, so the health check fails and the previous release
// keeps serving) rather than degrade silently. The historical key was
// NODE_ENV === "production", but Railway does not inject NODE_ENV: a
// service that never set it manually runs every "production" check as
// false. That gap is how a dist-less image sailed past the SPA-missing
// guard and went live behind the liveness probe on 2026-06-10 (site
// 404, API fine). Railway DOES always inject its own runtime markers,
// so treat any of them as "deployed" too.

export function isDeployedRuntime(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === "production") return true;
  // An explicit dev/test NODE_ENV wins over Railway markers: `railway
  // run pnpm --filter @workspace/resupply-api dev` injects the linked
  // service's variables (including RAILWAY_*) into a local shell, and
  // the dev script exports NODE_ENV=development without building the
  // SPA. Deployed containers never set these values.
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return false;
  return [
    env.RAILWAY_ENVIRONMENT,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_PROJECT_ID,
    env.RAILWAY_PUBLIC_DOMAIN,
  ].some((v) => typeof v === "string" && v.trim() !== "");
}

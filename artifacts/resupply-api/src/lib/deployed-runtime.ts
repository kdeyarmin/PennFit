// Deployed-runtime detection — "is this process a real deploy, not a
// dev shell?"
//
// Used by boot-time guards that must fail the deploy (crash before the
// listener binds, so the health check fails and the previous release
// keeps serving) rather than degrade silently. The historical key was
// NODE_ENV === "production", but Railway does not inject NODE_ENV: a
// service that never set it manually runs every "production" check as
// false — so on Railway the SPA-missing guard could never fire and a
// dist-less image (had one ever been built) would have gone live behind
// the liveness probe. Railway DOES always inject its own runtime
// markers, so treat any of them as "deployed" too.
//
// (Provenance: added during the 2026-06-10 deploy-stall investigation —
// see docs/railway-deploy-stall-2026-06-10.md. The "site is serving
// without its SPA" readings that motivated it turned out to be a probe
// artifact, not a real dist-less image; the guard stands on its own as
// defense-in-depth.)

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

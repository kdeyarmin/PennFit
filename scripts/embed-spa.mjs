// embed-spa.mjs — copy the built cpap-fitter SPA into resupply-api's
// own dist (artifacts/resupply-api/dist/public).
//
// Why: the deploy runtime provably keeps artifacts/resupply-api/dist
// (the start command runs dist/index.mjs from it) but the 2026-06-10
// outage showed Railway's builder shipping images WITHOUT
// artifacts/cpap-fitter/dist — API up, every storefront/admin path 404.
// Embedding the SPA inside the API's dist makes the SPA ride the one
// layer that demonstrably survives, instead of depending on a sibling
// workspace's build output staying in the image.
//
// Runs as the last step of railway.json's buildCommand (and mirrored by
// CI's "Railway prod build" job). Plain node, zero dependencies. Fails
// LOUD when either side is missing so a bad build fails the deploy
// instead of shipping SPA-less — the boot guard in app.ts
// (isDeployedRuntime) remains the runtime backstop.

import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const src = path.join(repoRoot, "artifacts", "cpap-fitter", "dist", "public");
const apiDist = path.join(repoRoot, "artifacts", "resupply-api", "dist");
const dest = path.join(apiDist, "public");

if (!existsSync(path.join(src, "index.html"))) {
  console.error(
    `embed-spa: FAIL — SPA build output missing at ${src} ` +
      "(expected index.html). Run the workspace builds first " +
      "(pnpm -r --workspace-concurrency=1 --if-present run build).",
  );
  process.exit(1);
}
if (!existsSync(apiDist)) {
  console.error(
    `embed-spa: FAIL — resupply-api dist missing at ${apiDist}. ` +
      "Run the workspace builds first.",
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

if (!existsSync(path.join(dest, "index.html"))) {
  console.error(
    `embed-spa: FAIL — copy completed but ${dest}/index.html is missing.`,
  );
  process.exit(1);
}
console.log(`embed-spa: OK — copied ${src} -> ${dest}`);

// Customer Service Manual attachment for staff invites.
//
// The full operations manual is authored in docs/user-manual/
// (manual.html) and pre-rendered offline by docs/user-manual/render.mjs
// — Chromium is NOT a runtime dependency. The rendered PDF is committed
// at artifacts/resupply-api/assets/user-manual/ rather than docs/
// because BOTH .railwayignore (docs) and .dockerignore
// (docs/user-manual) exclude the docs tree from the Railway build
// context — a PDF under docs/ would exist locally and in CI but never
// reach the deployed container. Staff invites attach it alongside the
// concise getting-started guides so a new hire's welcome email carries
// the actual manual for the console they're joining.
//
// Loading is best-effort and cached. The file is resolved by walking
// upward from this module (then from process.cwd()) until the
// repo-root-relative asset path appears: the module's depth differs
// between dev (src/lib/help-docs/), vitest, and the bundled dist
// output, and cwd differs between local runs and Railway, so no fixed
// relative path works everywhere. A missing file logs once per process
// and yields "no attachment" — an invite must never fail because an
// asset wasn't shipped with the deploy.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EmailAttachment } from "@workspace/resupply-auth";

import { logger } from "../logger";

export const CUSTOMER_SERVICE_MANUAL_FILENAME =
  "PennPaps-Customer-Service-Manual.pdf";
const MANUAL_RELATIVE_PATH = path.join(
  "artifacts",
  "resupply-api",
  "assets",
  "user-manual",
  CUSTOMER_SERVICE_MANUAL_FILENAME,
);

// undefined = not probed yet; null = probed and absent (negative
// result is cached too so a pruned deploy logs once, not per invite).
let cached: EmailAttachment | null | undefined;

/** Walk from `start` toward the fs root looking for the manual. */
async function findManual(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, MANUAL_RELATIVE_PATH);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load the Customer Service Manual as an email attachment, or null
 * when the PDF isn't present on disk. The buffer is cached for the
 * process lifetime — the manual only changes with a deploy.
 */
export async function loadCustomerServiceManual(): Promise<EmailAttachment | null> {
  if (cached !== undefined) return cached;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const found =
    (await findManual(moduleDir)) ?? (await findManual(process.cwd()));
  if (!found) {
    logger.warn(
      { event: "customer_service_manual_missing", file: MANUAL_RELATIVE_PATH },
      "customer service manual PDF not found; staff invites will omit it",
    );
    cached = null;
    return cached;
  }
  cached = {
    content: await fs.readFile(found),
    filename: CUSTOMER_SERVICE_MANUAL_FILENAME,
    contentType: "application/pdf",
  };
  return cached;
}

/** Test seam — clear the cached manual between specs. */
export function __clearManualCache(): void {
  cached = undefined;
}

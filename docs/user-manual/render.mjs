// Resolved from the workspace, not an absolute .pnpm store path pinned to
// one Playwright version — that path went stale on the next dependency
// bump and made this script unrunnable. `@playwright/test` re-exports
// chromium and is the version the repo already pins.
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "manual.html");
// The rendered PDF lives under the resupply-api artifact (not docs/)
// because staff invite emails attach it at runtime: .railwayignore
// excludes docs/ and .dockerignore excludes docs/user-manual from the
// Railway build context, so a PDF left here would never reach the
// deployed container. See artifacts/resupply-api/src/lib/help-docs/manual.ts.
const pdfPath = resolve(
  here,
  "../../artifacts/resupply-api/assets/user-manual/CareMetric-Breathe-Customer-Service-Manual.pdf",
);

// PLAYWRIGHT_BROWSERS_PATH normally locates the browser; PW_CHROMIUM_PATH
// overrides it for images that ship Chromium somewhere else.
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(htmlPath).toString(), {
    waitUntil: "networkidle",
  });
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: pdfPath,
    format: "Letter",
    printBackground: true,
    preferCSSPageSize: true,
  });
  console.log("wrote " + pdfPath);
} finally {
  await browser.close();
}

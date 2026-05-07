import { chromium } from "/home/user/PennFit/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "manual.html");
const pdfPath = resolve(here, "PennPaps-Customer-Service-Manual.pdf");

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
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

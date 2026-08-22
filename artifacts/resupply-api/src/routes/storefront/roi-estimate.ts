// POST /api/roi-estimate — "email me my ROI estimate" from the public Breathe
// ROI calculator (/breathe/roi). Declared here router-relative as
// "/roi-estimate"; mounted under /api in storefront/index.ts.
//
// A visitor enters two numbers (active patients, staff) and asks us to email
// them the modeled estimate. We do two things, both best-effort so the
// visitor is never shown a failure:
//   1. Capture the address to the shared marketing list
//      (newsletter_subscribers, source="breathe-roi") — the lead, captured
//      at peak intent. Same write path as /demo-lead (seed-org-scoped client;
//      the Breathe site is served on the platform apex where no tenant
//      resolves by host).
//   2. Email the visitor their estimate through the shared platform SendGrid
//      client. The breakdown is RECOMPUTED here from the two inputs — never
//      taken from the request body — so the email can only ever contain our
//      own modeled numbers, not attacker-supplied text.
//
// The email goes ONLY to the address the visitor typed (self-service), under
// the platform default From identity (this is platform marketing, not tenant
// mail). When SendGrid isn't configured (preview/dev) the route still returns
// 200 with { emailed: false } — the lead is captured either way.
//
// Shape mirrors /demo-lead: anonymous (no session/CSRF), honeypot field
// `website`, per-IP rate limited at the app level. PHI: none — a volunteered
// marketing address and two aggregate counts, never logged.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger.js";
import {
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
} from "@workspace/resupply-email";

const router: IRouter = Router();

// Mirrors the coefficients in the front-end ROI model
// (artifacts/cpap-fitter/src/pages/breathe.tsx `ROI`). Kept in lockstep by
// hand — these are conservative, stated assumptions, not a live quote.
const ROI = {
  hoursPerStaffWeek: 9,
  loadedHourly: 34,
  rcmPerPatient: 16,
  resupplyPerPatient: 21,
  toolsPerStaff: 1500,
} as const;

function computeRoi(patients: number, staff: number) {
  const labor = Math.round(
    staff * ROI.hoursPerStaffWeek * ROI.loadedHourly * 52,
  );
  const rcm = Math.round(patients * ROI.rcmPerPatient);
  const resupply = Math.round(patients * ROI.resupplyPerPatient);
  const tools = Math.round(staff * ROI.toolsPerStaff);
  return { labor, rcm, resupply, tools, total: labor + rcm + resupply + tools };
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const roiEstimateBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  // Clamp to the same slider ranges the calculator exposes so the emailed
  // estimate always matches a figure the visitor could have produced.
  patients: z.coerce.number().int().min(500).max(25000),
  staff: z.coerce.number().int().min(3).max(60),
});

function renderHtml(
  r: ReturnType<typeof computeRoi>,
  patients: number,
  staff: number,
): string {
  const rows: Array<[string, number]> = [
    ["Staff time automated", r.labor],
    ["Revenue-cycle recovery", r.rcm],
    ["Resupply revenue growth", r.resupply],
    ["Retired software licenses", r.tools],
  ];
  const tableRows = rows
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;font-size:14px;">${k}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#0b1426;font-weight:600;text-align:right;white-space:nowrap;">${money(v)}</td>
        </tr>`,
    )
    .join("");
  // Chrome comes from the shared CareMetric Breathe email design system.
  return renderBrandedEmail({
    brandTagline: "Breathe by CareMetric.ai",
    heading: "Your estimated annual impact",
    preheader: `An estimated ${money(r.total)} a year — about ${money(r.total / 12)} a month.`,
    contentHtml: [
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:38px;font-weight:800;color:${BREATHE_COLORS.ink};letter-spacing:-0.02em;">${escapeHtml(
        money(r.total),
      )}</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${BREATHE_COLORS.muted};margin:4px 0 16px;">≈ ${escapeHtml(
        money(r.total / 12),
      )} every month back in the business</div>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BREATHE_COLORS.hairline};border-radius:8px;">${tableRows}</table>`,
      paragraph(
        `Modeled for <strong>${patients.toLocaleString("en-US")}</strong> active patients and <strong>${staff}</strong> staff, using conservative, stated assumptions: ${ROI.hoursPerStaffWeek} hrs/week saved per staff at ${money(ROI.loadedHourly)}/hr loaded, ${money(ROI.rcmPerPatient)} revenue-cycle recovery and ${money(ROI.resupplyPerPatient)} resupply margin per active patient, and ${money(ROI.toolsPerStaff)}/seat in retired software licenses. Directional, not a quote.`,
      ),
    ].join("\n"),
    button: {
      label: "Create your account",
      url: "https://cmbreathe.com/breathe/signup",
    },
    footerHtml: `Size it again any time at <a href="https://cmbreathe.com/breathe/roi" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">cmbreathe.com/breathe/roi</a>.`,
    footerLines: [
      "You're receiving this because you requested an estimate; reply to unsubscribe.",
    ],
  });
}

function renderText(
  r: ReturnType<typeof computeRoi>,
  patients: number,
  staff: number,
): string {
  return [
    "Your estimated annual impact with Breathe",
    "",
    `${money(r.total)}  (~${money(r.total / 12)}/month back in the business)`,
    "",
    `Staff time automated:        ${money(r.labor)}`,
    `Revenue-cycle recovery:      ${money(r.rcm)}`,
    `Resupply revenue growth:     ${money(r.resupply)}`,
    `Retired software licenses:   ${money(r.tools)}`,
    "",
    `Modeled for ${patients.toLocaleString("en-US")} active patients and ${staff} staff. ` +
      `Conservative, stated assumptions — directional, not a quote.`,
    "",
    "Create your account: https://cmbreathe.com/breathe/signup",
    "Size it again: https://cmbreathe.com/breathe/roi",
  ].join("\n");
}

router.post("/roi-estimate", async (req, res) => {
  // Honeypot must run before zod (zod strip would drop the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)
    ?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.json({ ok: true, emailed: false });
    return;
  }

  const parsed = roiEstimateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check your email and numbers." });
    return;
  }
  const { email, patients, staff } = parsed.data;
  const estimate = computeRoi(patients, staff);

  // 1. Best-effort lead capture — same path/justification as /demo-lead.
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      logger.error(
        { event: "roi_estimate_capture_no_seed_org" },
        "roi estimate: seed org unresolved",
      );
    } else {
      const supabase = getOrgScopedClient(seedOrgId).raw();
      const { error } = await supabase
        .schema("public")
        .from("newsletter_subscribers")
        .upsert(
          {
            email,
            source: "breathe-roi",
            updated_at: new Date().toISOString(),
            unsubscribed_at: null,
          },
          { onConflict: "email" },
        );
      if (error) {
        logger.error(
          { event: "roi_estimate_capture_failed", pgCode: error.code ?? null },
          "roi estimate upsert failed",
        );
      }
    }
  } catch (err) {
    logger.error(
      {
        event: "roi_estimate_capture_error",
        name: (err as Error)?.name ?? null,
      },
      "roi estimate capture threw",
    );
  }

  // 2. Best-effort send of the estimate to the visitor. Platform default From
  //    (marketing, not tenant mail). A missing key / offline provider just
  //    means emailed:false — the lead is already captured.
  let emailed = false;
  try {
    const client = createSendgridClient();
    await client.sendEmail({
      to: email,
      subject: "Your Breathe ROI estimate",
      html: renderHtml(estimate, patients, staff),
      text: renderText(estimate, patients, staff),
      customArgs: { kind: "breathe_roi_estimate_v1" },
    });
    emailed = true;
  } catch (err) {
    if (!(err instanceof EmailConfigError)) {
      const status = err instanceof EmailApiError ? (err.status ?? null) : null;
      logger.error(
        { event: "roi_estimate_email_failed", status },
        "roi estimate email send failed",
      );
    }
  }

  res.json({ ok: true, emailed });
});

export default router;

// reports/email.ts — POST /admin/reports/email: email a generated
// report as a SendGrid attachment. Dispatches to the per-report
// modules in the registry to build the attachment bytes.
//
// Accepts { slug, format, from, to, recipient }, generates the
// requested report server-side, and attaches it to a SendGrid
// message. Returns 202 Accepted on enqueue success; the SendGrid
// call is synchronous (no background worker) so a 200/202 means
// the API has handed the message to SendGrid for delivery.
//
// Permissions: reports.read (same as the GET endpoints).
// Rate limit: bulk preset (the underlying SendGrid call is the
// expensive one; per-admin throttling here is a courtesy, not a
// hard guarantee).
// Audit: every send writes a `report.emailed` row carrying the
// slug, format, range, and recipient — no PHI (slugs/formats/dates
// are operational; the recipient is the admin-supplied email).

import type { IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../../lib/logger";
import { renderQboCsv } from "../../../lib/quickbooks-export";
import { adminRateLimit } from "../../../middlewares/admin-rate-limit";
import { requirePermission } from "../../../middlewares/requireAdmin";
import { REPORT_MODULES } from "./registry";
import {
  MAX_DAYS,
  practiceName,
  rangeLabel,
  rangeSlug,
  renderIifWithAccounts,
  REPORT_FORMATS,
  REPORT_SLUGS,
  type ReportFormat,
  type ReportSlug,
} from "./shared";

const emailReportBody = z
  .object({
    slug: z.enum(REPORT_SLUGS),
    format: z.enum(REPORT_FORMATS),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    recipient: z.string().email(),
    // Optional admin-supplied note — included verbatim in the email
    // body so the operator can prepend context ("for the April
    // close — please file with this month's receipts").
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// Builds the bytes for a given (slug, format) combination. Returns
// the raw report Buffer + MIME type + filename slug, ready to hand
// to SendGrid as an attachment. Dispatches through the registry —
// each report module owns its own CSV/PDF/QB builders.
async function buildReportArtifact(
  slug: ReportSlug,
  format: ReportFormat,
  from: Date,
  to: Date,
): Promise<{ buffer: Buffer; contentType: string; filenameExt: string }> {
  const mod = REPORT_MODULES[slug];

  // CSV path — every slug supports CSV. The modules reuse the
  // existing streaming writers via the buffered-response shim.
  if (format === "csv") {
    return {
      buffer: await mod.buildEmailCsv(from, to),
      contentType: "text/csv; charset=utf-8",
      filenameExt: "csv",
    };
  }

  // PDF — every slug has an email PDF builder. The builders
  // duplicate the GET handlers' shape rather than factor a shared
  // builder because the column widths + summary copy are tuned
  // per-report.
  if (format === "pdf") {
    return {
      buffer: await mod.buildEmailPdf(from, to),
      contentType: "application/pdf",
      filenameExt: "pdf",
    };
  }

  // IIF / QBO-CSV — the orders / returns / insurance-claims /
  // patient-payments / all-financial slugs have QuickBooks exports.
  // Other slugs reject before reaching here (the zod enum allows them
  // but we explicitly 400 below).
  if (format === "iif" || format === "qbo.csv") {
    if (!mod.buildEmailQbRows) {
      throw new ReportEmailValidationError(
        `${slug} does not support QuickBooks export`,
      );
    }
    const rows = await mod.buildEmailQbRows(from, to);
    const fromIso = from.toISOString().slice(0, 10);
    const toIso = to.toISOString().slice(0, 10);
    if (format === "iif") {
      const iif = await renderIifWithAccounts({
        from: fromIso,
        to: toIso,
        practiceName: practiceName(),
        rows,
      });
      return {
        buffer: Buffer.from(iif, "utf8"),
        contentType: "application/octet-stream",
        filenameExt: "iif",
      };
    }
    const csv = renderQboCsv({
      from: fromIso,
      to: toIso,
      practiceName: practiceName(),
      rows,
    });
    return {
      buffer: Buffer.from(csv, "utf8"),
      contentType: "text/csv; charset=utf-8",
      filenameExt: "qbo.csv",
    };
  }

  // Should be unreachable — zod validates format above.
  throw new ReportEmailValidationError(`Unsupported format ${format}`);
}

class ReportEmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportEmailValidationError";
  }
}

export function registerEmailRoute(router: IRouter): void {
  router.post(
    "/admin/reports/email",
    requirePermission("reports.read"),
    adminRateLimit({ name: "reports.email", preset: "bulk" }),
    async (req, res) => {
      const parsed = emailReportBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }
      const { slug, format, recipient, note } = parsed.data;
      const from = new Date(parsed.data.from + "T00:00:00Z");
      const to = new Date(parsed.data.to + "T23:59:59Z");
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        res.status(400).json({ error: "invalid_date" });
        return;
      }
      if (from.getTime() > to.getTime()) {
        res.status(400).json({ error: "from_after_to" });
        return;
      }

      // Cap at MAX_DAYS so a typo of "from=2020" can't fan out to a
      // hundred-day attachment. Matches the GET-side clamp; the
      // operator who needs a longer slice chunks like everywhere
      // else.
      const days = (to.getTime() - from.getTime()) / 86400_000;
      const effectiveTo =
        days > MAX_DAYS ? new Date(from.getTime() + MAX_DAYS * 86400_000) : to;

      let artifact;
      try {
        artifact = await buildReportArtifact(slug, format, from, effectiveTo);
      } catch (err) {
        if (err instanceof ReportEmailValidationError) {
          res.status(400).json({
            error: "format_not_supported",
            message: err.message,
          });
          return;
        }
        throw err;
      }

      let sgClient;
      try {
        sgClient = createSendgridClient();
      } catch (err) {
        if (err instanceof EmailConfigError) {
          res.status(503).json({
            error: "email_not_configured",
            message:
              "Email delivery is not configured on this environment (SENDGRID_API_KEY missing).",
          });
          return;
        }
        throw err;
      }

      const filename = `pennpaps-${slug}-${rangeSlug(from, effectiveTo)}.${artifact.filenameExt}`;
      const subject = `[${practiceName()}] ${slug} report — ${rangeLabel(from, effectiveTo)}`;
      const notePara = note ? `<p>${escapeHtml(note)}</p>` : "";
      const html = [
        `<p>Hi,</p>`,
        `<p>Attached is the <strong>${escapeHtml(slug)}</strong> report for the period <strong>${escapeHtml(rangeLabel(from, effectiveTo))}</strong>, generated as <strong>${escapeHtml(format)}</strong>.</p>`,
        notePara,
        `<p>Requested by ${escapeHtml(req.adminEmail ?? "an admin")}.</p>`,
        `<p>— ${escapeHtml(practiceName())}</p>`,
      ]
        .filter(Boolean)
        .join("\n");
      const text = [
        `Hi,`,
        ``,
        `Attached is the ${slug} report for ${rangeLabel(from, effectiveTo)}, generated as ${format}.`,
        ...(note ? ["", note] : []),
        ``,
        `Requested by ${req.adminEmail ?? "an admin"}.`,
        ``,
        `— ${practiceName()}`,
      ].join("\n");

      try {
        await sgClient.sendEmail({
          to: recipient,
          subject,
          html,
          text,
          attachments: [
            {
              content: artifact.buffer,
              filename,
              contentType: artifact.contentType,
            },
          ],
        });
      } catch (err) {
        if (err instanceof EmailApiError) {
          logger.warn(
            {
              event: "report_email_send_failed",
              slug,
              format,
              recipient,
              sgStatus: err.status ?? null,
            },
            "Report email send failed at SendGrid",
          );
          res.status(502).json({
            error: "email_send_failed",
            message: "SendGrid rejected the message.",
          });
          return;
        }
        throw err;
      }

      await logAudit({
        action: "report.emailed",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "reports",
        targetId: slug,
        metadata: {
          slug,
          format,
          from: parsed.data.from,
          to: parsed.data.to,
          clamped_to: effectiveTo.toISOString().slice(0, 10),
          recipient,
          byteLength: artifact.buffer.length,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "report.emailed audit write failed");
      });

      res.status(202).json({
        status: "queued",
        slug,
        format,
        recipient,
        bytes: artifact.buffer.length,
      });
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

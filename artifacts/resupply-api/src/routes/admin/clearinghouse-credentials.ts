// /admin/clearinghouse-credentials — manage the editable
// clearinghouse routing/credential metadata. The actual key files
// remain on disk; this surface only stores their paths + the
// non-secret config (host, ETIN, contact info, etc).
//
//   GET    /admin/clearinghouse-credentials
//   GET    /admin/clearinghouse-credentials/:id
//   POST   /admin/clearinghouse-credentials              admin-only
//   PATCH  /admin/clearinghouse-credentials/:id          admin-only
//   POST   /admin/clearinghouse-credentials/:id/test     admin-only
//          — list the remote outbound directory using the configured
//            key + known_hosts and return success/failure for the UI's
//            "test connection" button.
//   POST   /admin/office-ally/poll-now                   admin-only
//          — manually fire the inbound-poll worker job.
//   GET    /admin/clearinghouse-inbound-files            — audit list

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { listOutboundFiles } from "@workspace/resupply-integrations-office-ally";

import { runOfficeAllyInboundPoll } from "../../worker/jobs/office-ally-inbound-poll";
import { resolveClearinghouse } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["clearinghouse_credentials"]["Row"];

const E164_RE = /^\+[1-9]\d{1,14}$/;

const upsertBody = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]+$/)
      .min(2)
      .max(40),
    displayName: z.string().trim().min(1).max(160),
    usageIndicator: z.enum(["P", "T"]),
    sftpHost: z.string().trim().min(1).max(160),
    sftpPort: z.number().int().min(1).max(32767).default(22),
    sftpUsername: z.string().trim().min(1).max(120),
    privateKeyPath: z.string().trim().min(1),
    knownHostsPath: z.string().trim().min(1),
    remoteInboxDir: z.string().trim().min(1).max(120).default("inbound"),
    remoteOutboundDir: z.string().trim().min(1).max(120).default("outbound"),
    remoteArchiveDir: z.string().trim().max(120).nullable().optional(),
    etin: z.string().trim().min(1).max(40),
    submitterOrganizationName: z.string().trim().max(200).nullable().optional(),
    contactName: z.string().trim().max(120).nullable().optional(),
    contactPhoneE164: z.string().trim().regex(E164_RE).nullable().optional(),
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(4000).nullable().optional(),
    // Real-time eligibility (270/271) connection. realtimePassword is
    // write-only: it is stored on the row but never echoed back by GET
    // (which exposes only `realtimePasswordSet`); see its field below.
    realtimeEnabled: z.boolean().default(false),
    realtimeUrl: z.string().trim().url().max(500).nullable().optional(),
    realtimeUsername: z.string().trim().max(200).nullable().optional(),
    realtimeSenderId: z.string().trim().max(80).nullable().optional(),
    realtimeReceiverId: z.string().trim().max(80).nullable().optional(),
    realtimeTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .nullable()
      .optional(),
    // Write-only: stored on the row, never echoed back (GET exposes only
    // `realtimePasswordSet`). On PATCH, a blank/omitted value leaves the
    // existing password unchanged.
    realtimePassword: z.string().max(500).nullable().optional(),
  })
  .strict();
const patchBody = upsertBody.partial();
const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    usageIndicator: r.usage_indicator,
    sftpHost: r.sftp_host,
    sftpPort: r.sftp_port,
    sftpUsername: r.sftp_username,
    privateKeyPath: r.private_key_path,
    knownHostsPath: r.known_hosts_path,
    remoteInboxDir: r.remote_inbox_dir,
    remoteOutboundDir: r.remote_outbound_dir,
    remoteArchiveDir: r.remote_archive_dir,
    etin: r.etin,
    submitterOrganizationName: r.submitter_organization_name,
    contactName: r.contact_name,
    contactPhoneE164: r.contact_phone_e164,
    isActive: r.is_active,
    lastPolledAt: r.last_polled_at,
    notes: r.notes,
    realtimeEnabled: r.realtime_enabled,
    realtimeUrl: r.realtime_url,
    realtimeUsername: r.realtime_username,
    realtimeSenderId: r.realtime_sender_id,
    realtimeReceiverId: r.realtime_receiver_id,
    realtimeTimeoutMs: r.realtime_timeout_ms,
    // Never echo the stored password — only whether one is set.
    realtimePasswordSet: Boolean(r.realtime_password),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/clearinghouse-credentials",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .select("*")
      .order("display_name", { ascending: true });
    if (error) throw error;
    res.json({ clearinghouses: (data ?? []).map(rowToApi) });
  },
);

router.get(
  "/admin/clearinghouse-credentials/:id",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .select("*")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ clearinghouse: rowToApi(data) });
  },
);

router.post(
  "/admin/clearinghouse-credentials",
  requireAdminOnly,
  adminRateLimit({
    name: "clearinghouse_credentials.create",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .insert({
        slug: b.slug,
        display_name: b.displayName,
        usage_indicator: b.usageIndicator,
        sftp_host: b.sftpHost,
        sftp_port: b.sftpPort,
        sftp_username: b.sftpUsername,
        private_key_path: b.privateKeyPath,
        known_hosts_path: b.knownHostsPath,
        remote_inbox_dir: b.remoteInboxDir,
        remote_outbound_dir: b.remoteOutboundDir,
        remote_archive_dir: b.remoteArchiveDir ?? null,
        etin: b.etin,
        submitter_organization_name: b.submitterOrganizationName ?? null,
        contact_name: b.contactName ?? null,
        contact_phone_e164: b.contactPhoneE164 ?? null,
        is_active: b.isActive,
        notes: b.notes ?? null,
        realtime_enabled: b.realtimeEnabled,
        realtime_url: b.realtimeUrl ?? null,
        realtime_username: b.realtimeUsername ?? null,
        realtime_sender_id: b.realtimeSenderId ?? null,
        realtime_receiver_id: b.realtimeReceiverId ?? null,
        realtime_timeout_ms: b.realtimeTimeoutMs ?? null,
        realtime_password: b.realtimePassword?.trim() || null,
      })
      .select("id")
      .single();
    if (error) {
      if (typeof error.code === "string" && error.code === "23505") {
        res.status(409).json({ error: "slug_environment_conflict" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "clearinghouse_credentials.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clearinghouse_credentials",
      targetId: data.id,
      metadata: {
        slug: b.slug,
        usage_indicator: b.usageIndicator,
        sftp_host: b.sftpHost,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "clearinghouse_credentials.create audit write failed",
      );
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/clearinghouse-credentials/:id",
  requireAdminOnly,
  adminRateLimit({
    name: "clearinghouse_credentials.update",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["clearinghouse_credentials"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (b.slug !== undefined) update.slug = b.slug;
    if (b.displayName !== undefined) update.display_name = b.displayName;
    if (b.usageIndicator !== undefined)
      update.usage_indicator = b.usageIndicator;
    if (b.sftpHost !== undefined) update.sftp_host = b.sftpHost;
    if (b.sftpPort !== undefined) update.sftp_port = b.sftpPort;
    if (b.sftpUsername !== undefined) update.sftp_username = b.sftpUsername;
    if (b.privateKeyPath !== undefined)
      update.private_key_path = b.privateKeyPath;
    if (b.knownHostsPath !== undefined)
      update.known_hosts_path = b.knownHostsPath;
    if (b.remoteInboxDir !== undefined)
      update.remote_inbox_dir = b.remoteInboxDir;
    if (b.remoteOutboundDir !== undefined)
      update.remote_outbound_dir = b.remoteOutboundDir;
    if (b.remoteArchiveDir !== undefined)
      update.remote_archive_dir = b.remoteArchiveDir;
    if (b.etin !== undefined) update.etin = b.etin;
    if (b.submitterOrganizationName !== undefined)
      update.submitter_organization_name = b.submitterOrganizationName;
    if (b.contactName !== undefined) update.contact_name = b.contactName;
    if (b.contactPhoneE164 !== undefined)
      update.contact_phone_e164 = b.contactPhoneE164;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    if (b.notes !== undefined) update.notes = b.notes;
    if (b.realtimeEnabled !== undefined)
      update.realtime_enabled = b.realtimeEnabled;
    if (b.realtimeUrl !== undefined) update.realtime_url = b.realtimeUrl;
    if (b.realtimeUsername !== undefined)
      update.realtime_username = b.realtimeUsername;
    if (b.realtimeSenderId !== undefined)
      update.realtime_sender_id = b.realtimeSenderId;
    if (b.realtimeReceiverId !== undefined)
      update.realtime_receiver_id = b.realtimeReceiverId;
    if (b.realtimeTimeoutMs !== undefined)
      update.realtime_timeout_ms = b.realtimeTimeoutMs;
    // Only overwrite the password when a non-whitespace value is supplied;
    // a blank/whitespace/omitted field leaves the stored password unchanged
    // (so a stray "   " can't clobber a real credential).
    if (b.realtimePassword?.trim())
      update.realtime_password = b.realtimePassword.trim();
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "clearinghouse_credentials.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clearinghouse_credentials",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "clearinghouse_credentials.update audit write failed",
      );
    });
    res.json({ ok: true });
  },
);

// ── TEST CONNECTION ─────────────────────────────────────────────────
router.post(
  "/admin/clearinghouse-credentials/:id/test",
  requireAdminOnly,
  adminRateLimit({
    name: "clearinghouse_credentials.test",
    preset: "mutation",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row } = await supabase
      .schema("resupply")
      .from("clearinghouse_credentials")
      .select("*")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await listOutboundFiles(
      {
        host: row.sftp_host,
        port: row.sftp_port,
        username: row.sftp_username,
        privateKeyPath: row.private_key_path,
        knownHostsPath: row.known_hosts_path,
        remoteInboxDir: row.remote_inbox_dir,
      },
      row.remote_outbound_dir,
    );
    await logAudit({
      action: "clearinghouse_credentials.test",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clearinghouse_credentials",
      targetId: row.id,
      metadata: {
        ok: result.ok,
        ...(result.ok
          ? { file_count: result.files.length }
          : { kind: result.kind }),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "clearinghouse_credentials.test audit write failed");
    });
    if (!result.ok) {
      res.status(502).json({
        ok: false,
        kind: result.kind,
        message: result.message,
      });
      return;
    }
    res.json({ ok: true, fileCount: result.files.length });
  },
);

// ── MANUAL POLL TRIGGER ────────────────────────────────────────────
router.post(
  "/admin/office-ally/poll-now",
  requireAdminOnly,
  adminRateLimit({ name: "office_ally.poll_now", preset: "bulk" }),
  async (req, res) => {
    // Resolve to make sure we have a target; bail clearly if not.
    const resolved = await resolveClearinghouse();
    if (!resolved.config) {
      res.status(409).json({
        error: "no_clearinghouse_configured",
        message:
          "configure clearinghouse_credentials or OFFICE_ALLY_* env first",
      });
      return;
    }
    const stats = await runOfficeAllyInboundPoll();
    await logAudit({
      action: "office_ally.manual_poll",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clearinghouse_credentials",
      targetId: resolved.row?.id ?? null,
      metadata: { ...stats, source: resolved.source },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_ally.manual_poll audit write failed");
    });
    res.json({ ok: true, stats });
  },
);

// ── INBOUND FILE AUDIT LIST ────────────────────────────────────────
router.get(
  "/admin/clearinghouse-inbound-files",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .select(
        "id, clearinghouse_id, remote_path, file_name, file_sha256, file_size_bytes, file_kind, parse_summary_json, dispatch_status, applied_to_era_file_id, applied_to_submission_id, error_message, downloaded_at, dispatched_at",
      )
      .order("downloaded_at", { ascending: false })
      .limit(200);
    const kind =
      typeof req.query.fileKind === "string" ? req.query.fileKind : undefined;
    if (kind && isFileKind(kind)) {
      query = query.eq("file_kind", kind);
    }
    const status =
      typeof req.query.dispatchStatus === "string"
        ? req.query.dispatchStatus
        : undefined;
    if (status && isDispatchStatus(status)) {
      query = query.eq("dispatch_status", status);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      files: (data ?? []).map((r) => ({
        id: r.id,
        clearinghouseId: r.clearinghouse_id,
        remotePath: r.remote_path,
        fileName: r.file_name,
        fileSha256: r.file_sha256,
        fileSizeBytes: r.file_size_bytes,
        fileKind: r.file_kind,
        parseSummary: r.parse_summary_json,
        dispatchStatus: r.dispatch_status,
        appliedToEraFileId: r.applied_to_era_file_id,
        appliedToSubmissionId: r.applied_to_submission_id,
        errorMessage: r.error_message,
        downloadedAt: r.downloaded_at,
        dispatchedAt: r.dispatched_at,
      })),
    });
  },
);

type FileKind =
  Database["resupply"]["Tables"]["clearinghouse_inbound_files"]["Row"]["file_kind"];
type DispatchStatus =
  Database["resupply"]["Tables"]["clearinghouse_inbound_files"]["Row"]["dispatch_status"];

function isFileKind(v: string): v is FileKind {
  return (["999", "277ca", "835", "unknown"] as readonly string[]).includes(v);
}
function isDispatchStatus(v: string): v is DispatchStatus {
  return (
    [
      "pending",
      "parsed",
      "dispatched",
      "dispatch_failed",
      "skipped",
    ] as readonly string[]
  ).includes(v);
}

export default router;

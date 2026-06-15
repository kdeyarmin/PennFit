// /admin/storefront-branding/* — a tenant admin configures their own
// storefront identity and wires up their custom domain.
//
// Two concerns, one page:
//   1. Brand — the storefront name, tagline, and logo shown on the public
//      site (served to shoppers by GET /api/storefront-branding).
//   2. Custom domain — bind a domain (e.g. shop.acme-dme.com), prove
//      ownership via a DNS TXT challenge, and once verified the host
//      resolves to this tenant's storefront and joins the CORS allowlist.
//
// Everything is scoped to the caller's tenant (`req.orgId`): the writes
// target `organizations` filtered by `id = req.orgId`, so one tenant can
// never edit another's brand or claim a domain on their row.
//
// `organizations` is the tenant DIRECTORY table (keyed by `id`, not
// `org_id`), so this uses the service-role client with an explicit
// `.eq("id", orgId)` rather than getOrgScopedClient (which scopes on the
// `org_id` column that the directory table doesn't carry).

import express, { Router, type IRouter, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  invalidateBrandingCache,
  refreshVerifiedCustomDomains,
} from "../../lib/tenant-branding";
import {
  buildDomainInstructions,
  generateDomainToken,
  normalizeCustomDomain,
  verifyDomainTxt,
} from "../../lib/tenant-domain";
import {
  type CloudflareValidation,
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostname,
  isCloudflareConfigured,
} from "../../lib/cloudflare-hostname";

const router: IRouter = Router();

const ORG_BRANDING_COLUMNS =
  "id, name, storefront_name, tagline, logo_url, logo_object_path, " +
  "custom_domain, custom_domain_status, custom_domain_token, " +
  "custom_domain_verified_at, custom_domain_tls, custom_domain_cf_hostname_id";

type OrgBrandingRow = {
  id: string;
  name: string | null;
  storefront_name: string | null;
  tagline: string | null;
  logo_url: string | null;
  logo_object_path: string | null;
  custom_domain: string | null;
  custom_domain_status: "none" | "pending" | "verified";
  custom_domain_token: string | null;
  custom_domain_verified_at: string | null;
  custom_domain_tls: "none" | "pending" | "active" | "failed";
  custom_domain_cf_hostname_id: string | null;
};

/** Extra TLS state attached to a view, resolved from Cloudflare. */
interface TlsExtra {
  /** Whether the Cloudflare TLS automation is enabled + configured. */
  automation?: boolean;
  /** The validation record the tenant must publish while TLS is pending. */
  validation?: CloudflareValidation | null;
}

/** Shape the admin page consumes (camelCase + DNS instructions). */
function viewOf(row: OrgBrandingRow, tls: TlsExtra = {}) {
  const domain = (row.custom_domain ?? "").trim();
  const token = (row.custom_domain_token ?? "").trim();
  const instructions =
    domain && token ? buildDomainInstructions(domain, token) : null;
  return {
    storefrontName: row.storefront_name ?? "",
    legalName: row.name ?? "",
    tagline: row.tagline ?? "",
    logoUrl: row.logo_url ?? null,
    domain: {
      host: domain || null,
      status: row.custom_domain_status,
      verifiedAt: row.custom_domain_verified_at,
      instructions,
      tls: {
        // Whether automated TLS provisioning is available for this install.
        automation: tls.automation ?? false,
        // none | pending | active | failed
        status: row.custom_domain_tls,
        // The DNS record to publish while a cert is being issued.
        validation: tls.validation ?? null,
      },
    },
  };
}

/** TLS automation is active only when the flag AND the CF env are both on. */
async function tlsAutomationOn(): Promise<boolean> {
  return (
    isCloudflareConfigured() &&
    (await isFeatureEnabled("domains.tls_automation"))
  );
}

async function loadOrgRow(orgId: string): Promise<OrgBrandingRow | null> {
  const supabase = getOrgScopedClient(orgId).raw();
  const { data, error } = await supabase
    .schema("resupply")
    .from("organizations")
    .select(ORG_BRANDING_COLUMNS)
    .eq("id", orgId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as OrgBrandingRow | null) ?? null;
}

/**
 * Reflect the live Cloudflare TLS status onto the row + view. Best-effort
 * and fail-soft: when automation is off, there's no CF hostname yet, or
 * TLS is already `active`, it's a no-op; a Cloudflare error degrades to the
 * stored status. Persists a status change so the next read is cheap.
 */
async function resolveTls(
  row: OrgBrandingRow,
  orgId: string,
): Promise<{ row: OrgBrandingRow; tls: TlsExtra }> {
  const automation = await tlsAutomationOn();
  if (
    !automation ||
    !row.custom_domain_cf_hostname_id ||
    row.custom_domain_tls === "active"
  ) {
    return { row, tls: { automation } };
  }
  try {
    const cf = await getCustomHostname(row.custom_domain_cf_hostname_id);
    if (cf.tls !== row.custom_domain_tls) {
      const supabase = getOrgScopedClient(orgId).raw();
      const { data } = await supabase
        .schema("resupply")
        .from("organizations")
        .update({
          custom_domain_tls: cf.tls,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orgId)
        .select(ORG_BRANDING_COLUMNS)
        .maybeSingle();
      if (data) {
        return {
          row: data as unknown as OrgBrandingRow,
          tls: { automation, validation: cf.validation },
        };
      }
    }
    return { row, tls: { automation, validation: cf.validation } };
  } catch (err) {
    logger.warn(
      {
        event: "cloudflare_hostname_refresh_failed",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "cloudflare custom-hostname status refresh failed; using stored status",
    );
    return { row, tls: { automation } };
  }
}

/**
 * Best-effort release of a prior Cloudflare custom hostname when a domain
 * is unbound or rebound to a different host. Fail-soft: a Cloudflare error
 * is logged, never fatal (same posture as the best-effort logo cleanup).
 */
async function releaseCfHostname(
  prior: OrgBrandingRow | null,
  newDomain: string | null,
): Promise<void> {
  const cfId = (prior?.custom_domain_cf_hostname_id ?? "").trim();
  if (!cfId) return;
  // Keep it if the host is unchanged (rebind to the same domain).
  if (newDomain && prior?.custom_domain === newDomain) return;
  if (!isCloudflareConfigured()) return;
  try {
    await deleteCustomHostname(cfId);
  } catch (err) {
    logger.warn(
      {
        event: "cloudflare_hostname_delete_failed",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "cloudflare custom-hostname delete failed; may need manual cleanup",
    );
  }
}

/** Resolve the caller's tenant, 500ing if (impossibly) absent. */
function requireOrgId(req: { orgId?: string }, res: Response): string | null {
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return null;
  }
  return orgId;
}

// ── GET — current brand + domain config ─────────────────────────────
router.get(
  "/admin/storefront-branding",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 240,
    name: "admin_storefront_branding_read",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const row = await loadOrgRow(orgId);
    if (!row) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    const { row: r2, tls } = await resolveTls(row, orgId);
    res.json(viewOf(r2, tls));
  },
);

// ── PUT — update storefront name + tagline ──────────────────────────
const putBody = z
  .object({
    storefrontName: z.string().trim().max(120),
    tagline: z.string().trim().max(200),
  })
  .strict();

router.put(
  "/admin/storefront-branding",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 60,
    name: "admin_storefront_branding_update",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const parsed = putBody.safeParse(req.body);
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
    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        storefront_name: parsed.data.storefrontName || null,
        tagline: parsed.data.tagline || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    invalidateBrandingCache();
    res.json(viewOf(data as unknown as OrgBrandingRow));
  },
);

// ── POST /logo — upload a logo image to the public bucket ───────────
//
// Same posture as POST /admin/shop/products/image-upload: raw bytes,
// content-type allowlist + magic-byte sniff, 2 MB cap, public bucket,
// 503 when the public bucket isn't configured. (No SVG — an SVG in a
// public bucket is a stored-XSS vector.)
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function sniffImage(buf: Buffer): string | null {
  if (!Buffer.isBuffer(buf)) return null;
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

router.post(
  "/admin/storefront-branding/logo",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 60,
    name: "admin_storefront_logo_upload",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  express.raw({ type: Object.keys(LOGO_EXTENSIONS), limit: LOGO_MAX_BYTES }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const declaredType = (req.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const extension = LOGO_EXTENSIONS[declaredType];
    if (!extension) {
      res.status(415).json({
        error: "unsupported_image_type",
        supported: Object.keys(LOGO_EXTENSIONS),
      });
      return;
    }
    const rawBody: unknown = req.body;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    const bytes: Buffer = Buffer.from(rawBody);
    if (sniffImage(bytes) !== declaredType) {
      res.status(400).json({ error: "image_bytes_mismatch" });
      return;
    }

    const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PUBLIC ?? "").trim();
    if (!bucket) {
      res.status(503).json({ error: "public_storage_not_configured" });
      return;
    }

    const supabase = getOrgScopedClient(orgId).raw();
    const objectPath = `tenant-logos/${orgId}/${randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, bytes, {
        contentType: declaredType,
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadError) {
      req.log?.warn?.(
        { sizeBytes: bytes.length, contentType: declaredType },
        "storefront-branding: logo upload to public bucket failed",
      );
      res.status(502).json({ error: "logo_upload_failed" });
      return;
    }
    const { data: publicUrlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(objectPath);
    const logoUrl = publicUrlData?.publicUrl ?? null;
    if (!logoUrl) {
      res.status(502).json({ error: "logo_upload_failed" });
      return;
    }

    // Persist the new logo, capturing the prior object path so we can
    // best-effort delete it (don't leave orphaned blobs on every replace).
    const prior = await loadOrgRow(orgId);
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        logo_url: logoUrl,
        logo_object_path: objectPath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    const priorPath = (prior?.logo_object_path ?? "").trim();
    if (priorPath && priorPath !== objectPath) {
      await supabase.storage
        .from(bucket)
        .remove([priorPath])
        .catch(() => undefined);
    }
    invalidateBrandingCache();
    res.json(viewOf(data as unknown as OrgBrandingRow));
  },
);

// ── DELETE /logo — revert to the bundled default logo ───────────────
router.delete(
  "/admin/storefront-branding/logo",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 60,
    name: "admin_storefront_logo_delete",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const supabase = getOrgScopedClient(orgId).raw();
    const prior = await loadOrgRow(orgId);
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        logo_url: null,
        logo_object_path: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PUBLIC ?? "").trim();
    const priorPath = (prior?.logo_object_path ?? "").trim();
    if (bucket && priorPath) {
      await supabase.storage
        .from(bucket)
        .remove([priorPath])
        .catch(() => undefined);
    }
    invalidateBrandingCache();
    res.json(viewOf(data as unknown as OrgBrandingRow));
  },
);

// ── POST /domain — bind a custom domain (starts the DNS challenge) ───
const domainBody = z.object({ domain: z.string().trim().max(255) }).strict();

router.post(
  "/admin/storefront-branding/domain",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    name: "admin_storefront_domain_set",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const parsed = domainBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const domain = normalizeCustomDomain(parsed.data.domain);
    if (!domain) {
      res.status(400).json({ error: "invalid_domain" });
      return;
    }

    // Capture the prior CF hostname so we can release it if the domain
    // changes (don't leak custom hostnames / certs on rebind).
    const prior = await loadOrgRow(orgId);

    const supabase = getOrgScopedClient(orgId).raw();
    // Reject a domain already claimed by ANOTHER tenant (the partial
    // UNIQUE index would also reject it, but a clean 409 is friendlier).
    const { data: claimant, error: claimErr } = await supabase
      .schema("resupply")
      .from("organizations")
      .select("id")
      .eq("custom_domain", domain)
      .neq("id", orgId)
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (claimant) {
      res.status(409).json({ error: "domain_taken" });
      return;
    }

    const token = generateDomainToken();
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        custom_domain: domain,
        custom_domain_status: "pending",
        custom_domain_token: token,
        custom_domain_verified_at: null,
        // Rebind resets the (independent) TLS lifecycle.
        custom_domain_tls: "none",
        custom_domain_cf_hostname_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    // Release the prior Cloudflare custom hostname when the domain changed.
    await releaseCfHostname(prior, domain);
    // The previous domain (if any verified one) is no longer routable.
    invalidateBrandingCache();
    await refreshVerifiedCustomDomains();
    res.json(viewOf(data as unknown as OrgBrandingRow, { automation: false }));
  },
);

// ── POST /domain/verify — run the DNS TXT ownership check ────────────
router.post(
  "/admin/storefront-branding/domain/verify",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    name: "admin_storefront_domain_verify",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const row = await loadOrgRow(orgId);
    if (!row) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    const domain = (row.custom_domain ?? "").trim();
    const token = (row.custom_domain_token ?? "").trim();
    if (!domain || !token) {
      res.status(400).json({ error: "no_domain_to_verify" });
      return;
    }

    const ok = await verifyDomainTxt(domain, token);
    if (!ok) {
      // Surface the current (still-pending) view so the UI can re-show
      // the exact records the tenant needs to publish.
      res.status(200).json({ verified: false, ...viewOf(row) });
      return;
    }

    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        custom_domain_status: "verified",
        custom_domain_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    invalidateBrandingCache();
    await refreshVerifiedCustomDomains();

    let current = (data as unknown as OrgBrandingRow) ?? row;
    const tls: TlsExtra = { automation: await tlsAutomationOn() };

    // Automated TLS: register the host as a Cloudflare custom hostname so
    // the cert is issued + auto-renewed. Fail-soft — ownership is proven,
    // so a Cloudflare error never fails the verify; we record `failed` and
    // the tenant/operator can retry (re-verify or the manual path).
    if (tls.automation) {
      try {
        const cf = await createCustomHostname(domain);
        tls.validation = cf.validation;
        const { data: d2 } = await supabase
          .schema("resupply")
          .from("organizations")
          .update({
            custom_domain_cf_hostname_id: cf.id,
            custom_domain_tls: cf.tls,
            updated_at: new Date().toISOString(),
          })
          .eq("id", orgId)
          .select(ORG_BRANDING_COLUMNS)
          .maybeSingle();
        if (d2) current = d2 as unknown as OrgBrandingRow;
      } catch (err) {
        logger.warn(
          {
            event: "cloudflare_hostname_provision_failed",
            err: err instanceof Error ? err : new Error(String(err)),
          },
          "cloudflare custom-hostname provision failed; domain verified, TLS deferred",
        );
        const { data: d3 } = await supabase
          .schema("resupply")
          .from("organizations")
          .update({
            custom_domain_tls: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", orgId)
          .select(ORG_BRANDING_COLUMNS)
          .maybeSingle();
        if (d3) current = d3 as unknown as OrgBrandingRow;
      }
    }

    res.json({ verified: true, ...viewOf(current, tls) });
  },
);

// ── DELETE /domain — unbind the custom domain ───────────────────────
router.delete(
  "/admin/storefront-branding/domain",
  requirePermission("admin.tools.manage"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    name: "admin_storefront_domain_delete",
    keyFn: (req) => req.adminUserId ?? "unknown",
  }),
  async (req, res) => {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const prior = await loadOrgRow(orgId);
    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("organizations")
      .update({
        custom_domain: null,
        custom_domain_status: "none",
        custom_domain_token: null,
        custom_domain_verified_at: null,
        custom_domain_tls: "none",
        custom_domain_cf_hostname_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orgId)
      .select(ORG_BRANDING_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "organization_not_found" });
      return;
    }
    // Release the Cloudflare custom hostname (best-effort).
    await releaseCfHostname(prior, null);
    invalidateBrandingCache();
    await refreshVerifiedCustomDomains();
    res.json(viewOf(data as unknown as OrgBrandingRow, { automation: false }));
  },
);

export default router;

// Typed fetch wrappers for the storefront-branding admin page
// (/admin/storefront-branding). A tenant edits their own storefront name,
// tagline, and logo, and binds + DNS-verifies a custom domain. Everything
// is scoped server-side to the caller's tenant (req.orgId).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export interface DomainDnsInstructions {
  cnameTarget: string;
  txtName: string;
  txtValue: string;
}

export type CustomDomainStatus = "none" | "pending" | "verified";

export interface StorefrontBrandingView {
  storefrontName: string;
  legalName: string;
  tagline: string;
  logoUrl: string | null;
  domain: {
    host: string | null;
    status: CustomDomainStatus;
    verifiedAt: string | null;
    instructions: DomainDnsInstructions | null;
  };
}

export interface VerifyResult extends StorefrontBrandingView {
  verified: boolean;
}

/** Logo upload formats accepted by the server (magic-byte sniffed). */
export const LOGO_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Thrown when the public storage bucket isn't configured (logo upload). */
export class PublicStorageUnavailableError extends Error {
  constructor() {
    super("public_storage_not_configured");
    this.name = "PublicStorageUnavailableError";
  }
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function sendJSON<T>(
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const fetchStorefrontBranding = () =>
  getJSON<StorefrontBrandingView>("/admin/storefront-branding");

export const saveStorefrontBranding = (body: {
  storefrontName: string;
  tagline: string;
}) =>
  sendJSON<StorefrontBrandingView>("PUT", "/admin/storefront-branding", body);

export async function uploadStorefrontLogo(
  file: File,
): Promise<StorefrontBrandingView> {
  const res = await fetch(`${BASE}/admin/storefront-branding/logo`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": file.type,
      ...csrfHeader(),
    },
    body: file,
  });
  if (res.status === 503) {
    throw new PublicStorageUnavailableError();
  }
  if (!res.ok) {
    let detail = `Upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === "unsupported_image_type") {
        detail = "Unsupported image type — use PNG, JPEG, or WebP.";
      } else if (body.error === "image_bytes_mismatch") {
        detail = "That file doesn't look like a valid image.";
      } else if (body.error) {
        detail = body.error;
      }
    } catch {
      // body not JSON
    }
    throw new Error(detail);
  }
  return (await res.json()) as StorefrontBrandingView;
}

export const removeStorefrontLogo = () =>
  sendJSON<StorefrontBrandingView>("DELETE", "/admin/storefront-branding/logo");

export const setCustomDomain = (domain: string) =>
  sendJSON<StorefrontBrandingView>(
    "POST",
    "/admin/storefront-branding/domain",
    {
      domain,
    },
  );

export const verifyCustomDomain = () =>
  sendJSON<VerifyResult>("POST", "/admin/storefront-branding/domain/verify");

export const removeCustomDomain = () =>
  sendJSON<StorefrontBrandingView>(
    "DELETE",
    "/admin/storefront-branding/domain",
  );

// Typed fetch wrappers for the clearinghouse connection config
// (/admin/clearinghouse-credentials). DB-backed SFTP connection +
// submitter identity (ETIN) the identity-resolver prefers over the
// legacy OFFICE_ALLY_* env vars.
//
// SECURITY: this stores only CONNECTION CONFIG and FILE-PATH references
// — `privateKeyPath` / `knownHostsPath` point at files on the server
// (mode 0600); the key BYTES are never stored in the DB or sent here.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export type UsageIndicator = "P" | "T";

/** Flat shape matching the server's `upsertBody`. */
export interface ClearinghouseBody {
  slug: string;
  displayName: string;
  usageIndicator: UsageIndicator;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  privateKeyPath: string;
  knownHostsPath: string;
  remoteInboxDir: string;
  remoteOutboundDir: string;
  remoteArchiveDir: string | null;
  etin: string;
  submitterOrganizationName: string | null;
  contactName: string | null;
  contactPhoneE164: string | null;
  isActive: boolean;
  notes: string | null;
  // Real-time eligibility (270/271) — non-secret config. The password is
  // the OFFICE_ALLY_REALTIME_PASSWORD env secret, never sent here.
  realtimeEnabled: boolean;
  realtimeUrl: string | null;
  realtimeUsername: string | null;
  realtimeSenderId: string | null;
  realtimeReceiverId: string | null;
  realtimeTimeoutMs: number | null;
}

export interface Clearinghouse extends ClearinghouseBody {
  id: string;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
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
      /* non-JSON body */
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function sendJSON<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const fetchClearinghouses = () =>
  getJSON<{ clearinghouses: Clearinghouse[] }>(
    "/admin/clearinghouse-credentials",
  );

export const createClearinghouse = (body: ClearinghouseBody) =>
  sendJSON<{ id: string }>("POST", "/admin/clearinghouse-credentials", body);

export const updateClearinghouse = (id: string, body: ClearinghouseBody) =>
  sendJSON<{ ok: true }>(
    "PATCH",
    `/admin/clearinghouse-credentials/${id}`,
    body,
  );

export const testClearinghouse = (id: string) =>
  sendJSON<{ ok: boolean; fileCount?: number }>(
    "POST",
    `/admin/clearinghouse-credentials/${id}/test`,
    {},
  );

/** Blank form body — sensible Office Ally defaults for a new connection. */
export function emptyClearinghouseBody(): ClearinghouseBody {
  return {
    slug: "office_ally",
    displayName: "Office Ally",
    usageIndicator: "T",
    sftpHost: "sftp10.officeally.com",
    sftpPort: 22,
    sftpUsername: "",
    privateKeyPath: "",
    knownHostsPath: "",
    remoteInboxDir: "inbound",
    remoteOutboundDir: "outbound",
    remoteArchiveDir: null,
    etin: "",
    submitterOrganizationName: null,
    contactName: null,
    contactPhoneE164: null,
    isActive: true,
    notes: null,
    realtimeEnabled: false,
    realtimeUrl: null,
    realtimeUsername: null,
    realtimeSenderId: null,
    realtimeReceiverId: null,
    realtimeTimeoutMs: null,
  };
}

/** Strip server-only fields so the row can seed the editable form body. */
export function clearinghouseToBody(c: Clearinghouse): ClearinghouseBody {
  return {
    slug: c.slug,
    displayName: c.displayName,
    usageIndicator: c.usageIndicator,
    sftpHost: c.sftpHost,
    sftpPort: c.sftpPort,
    sftpUsername: c.sftpUsername,
    privateKeyPath: c.privateKeyPath,
    knownHostsPath: c.knownHostsPath,
    remoteInboxDir: c.remoteInboxDir,
    remoteOutboundDir: c.remoteOutboundDir,
    remoteArchiveDir: c.remoteArchiveDir,
    etin: c.etin,
    submitterOrganizationName: c.submitterOrganizationName,
    contactName: c.contactName,
    contactPhoneE164: c.contactPhoneE164,
    isActive: c.isActive,
    notes: c.notes,
    realtimeEnabled: c.realtimeEnabled,
    realtimeUrl: c.realtimeUrl,
    realtimeUsername: c.realtimeUsername,
    realtimeSenderId: c.realtimeSenderId,
    realtimeReceiverId: c.realtimeReceiverId,
    realtimeTimeoutMs: c.realtimeTimeoutMs,
  };
}

export const CLEARINGHOUSE_REQUIRED: ReadonlyArray<keyof ClearinghouseBody> = [
  "slug",
  "displayName",
  "sftpHost",
  "sftpUsername",
  "privateKeyPath",
  "knownHostsPath",
  "etin",
];

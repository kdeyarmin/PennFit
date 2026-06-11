// HMAC-signed token for telehealth video-visit access.
//
// Two roles share one token shape:
//   * "patient" — embedded in the join link the patient receives by
//     SMS/email (/video-visit?token=<token>). Long-ish TTL because a
//     visit may be scheduled days out.
//   * "staff"   — minted by POST /admin/video-visits/:id/join for the
//     signaling WebSocket (the upgrade request can't ride the admin
//     session middleware). Short TTL; re-minted on every join click.
//
// The token carries the visit row id, the role, a link-version (bumping
// video_visits.link_version revokes outstanding links — cancel does
// this), and an expiry. No DB lookup is needed to reject a tampered or
// expired token; the signaling handler still checks the row for
// status/link_version so cancellation takes effect immediately.
//
// Same signing primitive + shared RESUPPLY_LINK_HMAC_KEY as
// lib/patient-packet-token and its sibling token helpers.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getLinkHmacKey } from "@workspace/resupply-secrets";

export type VideoVisitRole = "patient" | "staff";

interface VideoVisitTokenPayload {
  id: string;
  // role — "p" (patient) | "s" (staff)
  r: "p" | "s";
  // link version — must match video_visits.link_version
  v: number;
  // expiry (Unix seconds)
  e: number;
}

export const PATIENT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const STAFF_TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return null;
  const pad = (4 - (s.length % 4)) % 4;
  const standard = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  try {
    return Buffer.from(standard, "base64");
  } catch {
    return null;
  }
}

function hmacSign(payloadEncoded: string): Buffer {
  return createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
}

export function signVideoVisitToken(
  visitId: string,
  role: VideoVisitRole,
  linkVersion: number,
  ttlSeconds = role === "staff"
    ? STAFF_TOKEN_TTL_SECONDS
    : PATIENT_TOKEN_TTL_SECONDS,
): string {
  const payload: VideoVisitTokenPayload = {
    id: visitId,
    r: role === "staff" ? "s" : "p",
    v: linkVersion,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64urlEncode(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const sig = hmacSign(payloadEncoded);
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

export type VerifyVideoVisitTokenResult =
  | {
      valid: true;
      visitId: string;
      role: VideoVisitRole;
      linkVersion: number;
    }
  | { valid: false };

export function verifyVideoVisitToken(
  token: string,
): VerifyVideoVisitTokenResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return { valid: false };

  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false };

  const expected = hmacSign(payloadEncoded);
  if (sigBuf.length !== expected.length || !timingSafeEqual(sigBuf, expected)) {
    return { valid: false };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { valid: false };
  }
  const p = parsed as VideoVisitTokenPayload;
  if (
    !p ||
    typeof p.id !== "string" ||
    !p.id ||
    (p.r !== "p" && p.r !== "s") ||
    typeof p.v !== "number" ||
    typeof p.e !== "number"
  ) {
    return { valid: false };
  }
  if (p.e <= Math.floor(Date.now() / 1000)) return { valid: false };
  return {
    valid: true,
    visitId: p.id,
    role: p.r === "s" ? "staff" : "patient",
    linkVersion: p.v,
  };
}

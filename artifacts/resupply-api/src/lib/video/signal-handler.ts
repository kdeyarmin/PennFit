// WebSocket signaling handler for telehealth video visits.
//
// The server's only job is to relay opaque WebRTC signaling payloads
// (SDP descriptions + ICE candidates) between the two seats of a
// visit and to stamp lifecycle timestamps on the video_visits row.
// Audio/video flows browser-to-browser over DTLS-SRTP and NEVER
// touches this process.
//
// Wire protocol (JSON text frames, ≤64 KiB):
//   client → server:
//     { type: "signal", data: <opaque> }   relayed verbatim to the peer
//     { type: "end" }                       hang up; from staff this
//                                           also marks the visit completed
//   server → client:
//     { type: "joined", role, peerPresent } post-connect handshake
//     { type: "peer-joined" }               counterpart arrived
//     { type: "peer-left" }                 counterpart disconnected
//     { type: "signal", data: <opaque> }    relayed payload
//     { type: "ended" }                      visit ended by the other side
//
// PHI / log posture: log lines carry visitId / role / event names
// only — never signaling payloads (SDP can embed client IPs) and never
// patient identifiers beyond the visit row id.

import type { WebSocket } from "ws";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import {
  SignalRooms,
  otherRole,
  type SignalPeer,
  type VideoRole,
} from "./signal-rooms";

export interface VideoWsClaims {
  visitId: string;
  role: VideoRole;
  linkVersion: number;
}

// One frame of SDP for a 720p call is ~5-10 KiB; 64 KiB leaves
// generous headroom while keeping a hostile client from buffering
// megabytes through the relay.
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

const rooms = new SignalRooms();

/** Exposed for tests only. */
export function getSignalRoomsForTest(): SignalRooms {
  return rooms;
}

function safeSend(ws: SignalPeer, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* peer already gone — close path handles cleanup */
  }
}

function safeClose(ws: SignalPeer, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

interface VisitRow {
  id: string;
  status: string;
  link_version: number;
  started_at: string | null;
  staff_joined_at: string | null;
  patient_joined_at: string | null;
}

async function loadVisit(visitId: string): Promise<VisitRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("video_visits")
    .select(
      "id, status, link_version, started_at, staff_joined_at, patient_joined_at",
    )
    .eq("id", visitId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Fire-and-forget row update; a DB hiccup must never drop the call. */
function updateVisit(
  visitId: string,
  patch: Record<string, string>,
  event: string,
): void {
  const supabase = getSupabaseServiceRoleClient();
  void supabase
    .schema("resupply")
    .from("video_visits")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", visitId)
    .then(({ error }) => {
      if (error) {
        logger.warn(
          { event, visitId, err: error.message },
          "video visit row update failed",
        );
      }
    });
}

function stampJoin(role: VideoRole, visit: VisitRow): void {
  const now = new Date().toISOString();
  const patch: Record<string, string> = {};
  if (role === "staff") {
    if (!visit.staff_joined_at) patch.staff_joined_at = now;
    if (visit.status === "scheduled") {
      patch.status = "in_progress";
      if (!visit.started_at) patch.started_at = now;
    }
  } else if (!visit.patient_joined_at) {
    patch.patient_joined_at = now;
  }
  if (Object.keys(patch).length > 0) {
    updateVisit(visit.id, patch, "video.visit.join_stamp");
  }
}

export async function handleVideoSignalConnection(
  ws: WebSocket,
  claims: VideoWsClaims,
): Promise<void> {
  if (!(await isFeatureEnabled("telehealth.video"))) {
    safeClose(ws, 4403, "feature-disabled");
    return;
  }

  let visit: VisitRow | null;
  try {
    visit = await loadVisit(claims.visitId);
  } catch (err) {
    logger.warn(
      {
        visitId: claims.visitId,
        err: err instanceof Error ? err.message : String(err),
      },
      "video signal: visit lookup failed",
    );
    safeClose(ws, 1011, "lookup-failed");
    return;
  }
  // The HMAC already proves the token was minted by us; the row check
  // adds revocation (cancel bumps link_version / flips status).
  if (
    !visit ||
    visit.link_version !== claims.linkVersion ||
    visit.status === "cancelled" ||
    visit.status === "completed"
  ) {
    safeClose(ws, 4401, "visit-unavailable");
    return;
  }

  const { visitId, role } = claims;
  const { evicted, counterpart } = rooms.join(visitId, role, ws);
  if (evicted) safeClose(evicted, 4409, "superseded");

  stampJoin(role, visit);
  logger.info(
    { event: "video.signal.joined", visitId, role, peerPresent: !!counterpart },
    "video signal: peer joined",
  );

  safeSend(ws, { type: "joined", role, peerPresent: !!counterpart });
  if (counterpart) safeSend(counterpart, { type: "peer-joined" });

  // Heartbeat: terminate seats whose TCP path silently died so the
  // room frees up for a reconnect.
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // protocol is JSON text frames only
    const text = raw.toString("utf8");
    if (text.length > MAX_MESSAGE_BYTES) {
      safeClose(ws, 1009, "message-too-large");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore malformed frames
    }
    const type =
      typeof msg === "object" && msg !== null && "type" in msg
        ? (msg as { type?: unknown }).type
        : undefined;

    if (type === "signal") {
      const peer = rooms.getPeer(visitId, otherRole(role));
      if (peer) {
        safeSend(peer, {
          type: "signal",
          data: (msg as { data?: unknown }).data,
        });
      }
      return;
    }

    if (type === "end") {
      const peer = rooms.getPeer(visitId, otherRole(role));
      if (peer) safeSend(peer, { type: "ended" });
      if (role === "staff") {
        // Staff hanging up completes the visit (and dead-ends the
        // patient link via the status check above). A patient "end"
        // is just a leave — staff may still be waiting for them to
        // rejoin after a mis-tap.
        updateVisit(
          visitId,
          { status: "completed", ended_at: new Date().toISOString() },
          "video.visit.completed",
        );
        if (peer) safeClose(peer, 1000, "ended");
      }
      safeClose(ws, 1000, "ended");
      return;
    }
    // Unknown types are ignored (forward-compat with newer clients).
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    const { removed, counterpart: remaining } = rooms.leave(visitId, role, ws);
    if (removed && remaining) {
      safeSend(remaining, { type: "peer-left" });
    }
    logger.info(
      { event: "video.signal.left", visitId, role },
      "video signal: peer left",
    );
  });

  ws.on("error", (err) => {
    logger.warn(
      { event: "video.signal.error", visitId, role, err: err.message },
      "video signal: socket error",
    );
  });
}

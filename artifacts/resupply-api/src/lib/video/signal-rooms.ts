// In-memory room registry for video-visit signaling.
//
// One room per visit, at most one socket per role ("staff" /
// "patient"). A second connection for an occupied role EVICTS the
// older socket — that makes a page refresh or a network blip
// self-healing (the stale half-open socket can't pin the seat).
//
// Pure data structure, no `ws` import — the WebSocket handler injects
// anything that satisfies SignalPeer, which keeps this unit-testable
// with plain fakes. Process-local by design: signaling for one visit
// must land on one instance, and the deploy runs a single Railway
// process (same assumption the voice pending-session map already
// makes).

export type VideoRole = "staff" | "patient";

export interface SignalPeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Room {
  peers: Partial<Record<VideoRole, SignalPeer>>;
}

export function otherRole(role: VideoRole): VideoRole {
  return role === "staff" ? "patient" : "staff";
}

export class SignalRooms {
  private rooms = new Map<string, Room>();

  /**
   * Seat `peer` in the visit's room. Returns the socket it displaced
   * (same role, e.g. a stale tab) so the caller can close it, plus the
   * counterpart peer if one is already present.
   */
  join(
    visitId: string,
    role: VideoRole,
    peer: SignalPeer,
  ): { evicted: SignalPeer | null; counterpart: SignalPeer | null } {
    let room = this.rooms.get(visitId);
    if (!room) {
      room = { peers: {} };
      this.rooms.set(visitId, room);
    }
    const evicted = room.peers[role] ?? null;
    room.peers[role] = peer;
    return { evicted, counterpart: room.peers[otherRole(role)] ?? null };
  }

  /**
   * Remove `peer` from its seat — but only if it still holds the seat
   * (an evicted socket's close handler must not unseat its
   * replacement). Returns the counterpart so the caller can notify it.
   */
  leave(
    visitId: string,
    role: VideoRole,
    peer: SignalPeer,
  ): { removed: boolean; counterpart: SignalPeer | null } {
    const room = this.rooms.get(visitId);
    if (!room) return { removed: false, counterpart: null };
    if (room.peers[role] !== peer) {
      return {
        removed: false,
        counterpart: room.peers[otherRole(role)] ?? null,
      };
    }
    delete room.peers[role];
    const counterpart = room.peers[otherRole(role)] ?? null;
    if (!counterpart) this.rooms.delete(visitId);
    return { removed: true, counterpart };
  }

  getPeer(visitId: string, role: VideoRole): SignalPeer | null {
    return this.rooms.get(visitId)?.peers[role] ?? null;
  }

  roomCount(): number {
    return this.rooms.size;
  }
}

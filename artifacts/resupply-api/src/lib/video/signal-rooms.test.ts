import { describe, expect, it } from "vitest";

import { SignalRooms, type SignalPeer } from "./signal-rooms";

function fakePeer(): SignalPeer & { sent: string[]; closed: boolean } {
  const peer = {
    sent: [] as string[],
    closed: false,
    send(data: string) {
      peer.sent.push(data);
    },
    close() {
      peer.closed = true;
    },
  };
  return peer;
}

const VISIT = "visit-1";

describe("SignalRooms", () => {
  it("first join finds an empty room", () => {
    const rooms = new SignalRooms();
    const staff = fakePeer();
    const { evicted, counterpart } = rooms.join(VISIT, "staff", staff);
    expect(evicted).toBeNull();
    expect(counterpart).toBeNull();
    expect(rooms.getPeer(VISIT, "staff")).toBe(staff);
  });

  it("second role joining sees the counterpart", () => {
    const rooms = new SignalRooms();
    const staff = fakePeer();
    const patient = fakePeer();
    rooms.join(VISIT, "staff", staff);
    const { evicted, counterpart } = rooms.join(VISIT, "patient", patient);
    expect(evicted).toBeNull();
    expect(counterpart).toBe(staff);
  });

  it("rejoining a role evicts the stale socket but keeps the counterpart", () => {
    const rooms = new SignalRooms();
    const staleTab = fakePeer();
    const patient = fakePeer();
    const freshTab = fakePeer();
    rooms.join(VISIT, "staff", staleTab);
    rooms.join(VISIT, "patient", patient);
    const { evicted, counterpart } = rooms.join(VISIT, "staff", freshTab);
    expect(evicted).toBe(staleTab);
    expect(counterpart).toBe(patient);
    expect(rooms.getPeer(VISIT, "staff")).toBe(freshTab);
  });

  it("an evicted socket's leave does not unseat its replacement", () => {
    const rooms = new SignalRooms();
    const staleTab = fakePeer();
    const freshTab = fakePeer();
    rooms.join(VISIT, "staff", staleTab);
    rooms.join(VISIT, "staff", freshTab);
    // The evicted socket's close handler fires AFTER the replacement
    // is seated — it must be a no-op.
    const { removed } = rooms.leave(VISIT, "staff", staleTab);
    expect(removed).toBe(false);
    expect(rooms.getPeer(VISIT, "staff")).toBe(freshTab);
  });

  it("leave returns the counterpart so the caller can notify it", () => {
    const rooms = new SignalRooms();
    const staff = fakePeer();
    const patient = fakePeer();
    rooms.join(VISIT, "staff", staff);
    rooms.join(VISIT, "patient", patient);
    const { removed, counterpart } = rooms.leave(VISIT, "patient", patient);
    expect(removed).toBe(true);
    expect(counterpart).toBe(staff);
  });

  it("the room is freed once both seats are empty", () => {
    const rooms = new SignalRooms();
    const staff = fakePeer();
    const patient = fakePeer();
    rooms.join(VISIT, "staff", staff);
    rooms.join(VISIT, "patient", patient);
    expect(rooms.roomCount()).toBe(1);
    rooms.leave(VISIT, "staff", staff);
    expect(rooms.roomCount()).toBe(1);
    rooms.leave(VISIT, "patient", patient);
    expect(rooms.roomCount()).toBe(0);
  });

  it("rooms are isolated per visit", () => {
    const rooms = new SignalRooms();
    const a = fakePeer();
    const b = fakePeer();
    rooms.join("visit-a", "staff", a);
    const { counterpart } = rooms.join("visit-b", "patient", b);
    expect(counterpart).toBeNull();
    expect(rooms.getPeer("visit-a", "patient")).toBeNull();
  });
});

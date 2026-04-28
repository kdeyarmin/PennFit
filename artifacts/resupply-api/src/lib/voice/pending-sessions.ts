// In-memory pending-session registry — short-TTL handoff between
// `POST /voice/place-call` (operator-initiated) and the inbound Twilio
// Media Stream WebSocket.
//
// Why an in-memory Map and not a DB row:
//   * The handoff window is seconds. Twilio dials the patient, the
//     patient picks up, the WS upgrade arrives — all under a minute in
//     the happy path.
//   * Every entry maps 1:1 to a `conversations` row; the DB is the
//     source of truth for everything operationally interesting. The
//     pending entry only carries the binding the WS needs at upgrade
//     time (patientId, episodeId) so the model never has to see those
//     identifiers and the WS handler doesn't have to crack open a
//     Postgres txn during the upgrade handshake.
//   * Single-instance assumption matches the rest of phase 1 (the
//     existing readiness/migration model already assumes a single
//     `resupply-api` process). When we go multi-instance we'll move
//     this to Redis or the existing pg-boss queue tier; ADR 004
//     captures the migration plan.
//
// TTL semantics:
//   * register() → entry expires after `ttlMs` (default 5 minutes).
//     If Twilio's WS handshake hasn't arrived by then the entry is
//     swept and the WS upgrade gets `claim() === null` → 1008 close.
//   * Entries are also swept on every register/peek/claim so a process
//     under no load doesn't accumulate dead entries indefinitely. The
//     periodic interval below catches the idle-process case.

export interface PendingSessionEntry {
  conversationId: string;
  patientId: string;
  episodeId: string;
  /** Captured from Twilio's call-create response, set after dial. */
  twilioCallSid?: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingSessionsOptions {
  /** Default 5 minutes — see file header. */
  ttlMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Periodic sweep interval. Default = ttlMs (so at most one stale
   *  entry per ttl window survives an idle process). 0 disables. */
  sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class PendingSessions {
  private readonly entries = new Map<string, PendingSessionEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: PendingSessionsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    const sweepInterval = opts.sweepIntervalMs ?? this.ttlMs;
    if (sweepInterval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
      // Don't keep the event loop alive just for a registry sweep —
      // the API process has plenty of other long-lived handles
      // (HTTP server, pg pool) and we don't want test runs to hang
      // because this timer is the only handle in the loop.
      if (typeof this.sweepTimer.unref === "function") {
        this.sweepTimer.unref();
      }
    } else {
      this.sweepTimer = null;
    }
  }

  /**
   * Register a new pending session. Overwrites any existing entry for
   * the same conversationId — operators can re-trigger a dial after a
   * busy/no-answer outcome and we don't want the second attempt to
   * collide with a stale entry from the first.
   */
  register(args: {
    conversationId: string;
    patientId: string;
    episodeId: string;
  }): PendingSessionEntry {
    this.sweep();
    const t = this.now();
    const entry: PendingSessionEntry = {
      conversationId: args.conversationId,
      patientId: args.patientId,
      episodeId: args.episodeId,
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.entries.set(args.conversationId, entry);
    return entry;
  }

  /** Read without consuming. Returns null on miss or expired. */
  peek(conversationId: string): PendingSessionEntry | null {
    this.sweep();
    return this.entries.get(conversationId) ?? null;
  }

  /**
   * Read AND consume — the WS upgrade flow uses this so a leaked
   * conversationId can only ride exactly one upgrade attempt.
   */
  claim(conversationId: string): PendingSessionEntry | null {
    this.sweep();
    const entry = this.entries.get(conversationId);
    if (!entry) return null;
    this.entries.delete(conversationId);
    return entry;
  }

  /** Stamp the Twilio CallSid onto an existing entry. */
  attachCallSid(conversationId: string, callSid: string): boolean {
    const entry = this.entries.get(conversationId);
    if (!entry) return false;
    entry.twilioCallSid = callSid;
    return true;
  }

  /** Test-only — current entry count after a sweep. */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Test-only — clears the timer so vitest can exit. */
  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.entries.clear();
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= t) this.entries.delete(k);
    }
  }
}

let singleton: PendingSessions | null = null;

export function getPendingSessions(): PendingSessions {
  if (!singleton) singleton = new PendingSessions();
  return singleton;
}

/**
 * Test-only — drop the singleton so each test file gets a fresh
 * registry without cross-test bleed.
 */
export function __resetPendingSessionsForTests(): void {
  if (singleton) singleton.shutdown();
  singleton = null;
}

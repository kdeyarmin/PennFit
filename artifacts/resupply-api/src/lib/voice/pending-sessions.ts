// Pending-session registry — short-TTL handoff between a voice webhook
// (`POST /voice/place-call`, `/voice/inbound-reorder`,
// `/voice/inbound-breathe-sales`, `/voice/realtime-diagnostic`) and the
// inbound Twilio Media Stream WebSocket upgrade.
//
// Why this is DB-backed (migration 0418) and NOT an in-memory Map:
//   The handoff spans TWO separate connections from Twilio: the webhook POST
//   registers the session, then — moments later — Twilio opens the Media
//   Stream WebSocket. In-memory state does NOT survive the serving process
//   being replaced or restarted in that ~1s gap: a deploy rolling the
//   (single) replica, or a process restart/crash, leaves the fresh process
//   with an empty map, so the WS upgrade can't find the session, rejects it
//   with HTTP 401, and Twilio reports error 31920 (WebSocket handshake
//   error) — the call dies on connect (carrier "line is busy"). That is what
//   intermittently broke every voice flow (including the CareMetric Breathe
//   sales line) around deploys. A shared table makes the handoff durable
//   across restarts/redeploys — and any future multi-replica scaling — since
//   ANY process can claim a session ANY process registered.
//
// Why a table and not the `conversations` row:
//   The diagnostic and platform-sales flows have NO `conversations` row
//   (no patient, no tenant), and even the patient/shop flows carry handoff-
//   only context (greeting, callContext, agentSpeaksFirst) that doesn't
//   belong on the durable conversation. One uniform store covers all four.
//
// TTL semantics:
//   * register() → row expires after `ttlMs` (default 5 minutes). If
//     Twilio's WS handshake hasn't arrived by then, claim() finds nothing
//     and the upgrade is refused.
//   * Expired rows are swept opportunistically (best-effort) on register so
//     the table doesn't accumulate dead rows; peek()/claim() also filter on
//     `expires_at` so a not-yet-swept expired row is never returned.
//
// PHI posture: the opaque conversationId is the only handle that ever rides
// the WS URL. patient/episode/org ids live in the row payload (internal
// uuids, not clinical content) and the row is deleted seconds later on claim.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import type { Json } from "@workspace/resupply-db";

import { logger } from "../logger";

export interface PendingSessionEntry {
  conversationId: string;
  patientId: string;
  episodeId: string;
  /**
   * The tenant this call belongs to. Set by the route that registers the
   * session (place-call, inbound-reorder) so the voice WS bridge persists
   * + sends under the RIGHT tenant — including the tenant's own outbound
   * voice/SMS caller-id (G7). Optional: when unset (or for legacy entries
   * mid-deploy) the ws-handler falls back to the seed org, which is
   * single-tenant-correct.
   */
  orgId?: string;
  /** Captured from Twilio's call-create response, set after dial. */
  twilioCallSid?: string;
  /**
   * Optional non-PHI grounding context passed to buildSystemPrompt.
   * Outbound (place-call) leaves it unset → the ws-handler default
   * ("Outbound CPAP resupply check-in…") applies. The inbound reorder
   * IVR sets an inbound-flavored context so the agent frames the call
   * correctly.
   */
  callContext?: string;
  /**
   * Optional opening line. Outbound leaves it unset → DEFAULT_GREETING.
   * Inbound overrides it so the agent doesn't tell a caller who dialed
   * in that we're calling them.
   */
  greeting?: string;
  /**
   * Caller kind for the voice tool dispatcher + system prompt. Defaults to
   * "patient" when unset (outbound + inbound patient flows). The inbound
   * reorder IVR sets "shop_customer" for a matched storefront caller — in
   * which case `shopCustomerId` is set and `patientId`/`episodeId` are "".
   * "breathe_prospect" is the CareMetric Breathe platform sales line: no
   * patient/episode/customer, no `conversations` row — the sales WS handler
   * runs without the patient transcript/finalize machinery.
   */
  callerKind?: "patient" | "shop_customer" | "breathe_prospect";
  /** Storefront customer id — set only for callerKind "shop_customer". */
  shopCustomerId?: string;
  /**
   * Diagnostic ("connection test") session — no patient, no DB, no tools.
   * Set by the `/voice/realtime-diagnostic` route so the WS upgrade routes
   * to the isolated diagnostic bridge handler instead of the production
   * one. `patientId`/`episodeId` are empty for these.
   */
  diagnostic?: boolean;
  /**
   * The agent should open the conversation (speak the greeting without
   * waiting for the caller). Set by INBOUND flows — a caller who dials
   * in expects "thanks for calling…" immediately, and semantic VAD only
   * creates a response after caller speech, so without this kick an
   * inbound caller is met with dead air. Outbound (place-call) leaves it
   * unset: the callee answers with "Hello?", which is the natural cue.
   */
  agentSpeaksFirst?: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface RegisterPendingSessionArgs {
  conversationId: string;
  patientId: string;
  episodeId: string;
  orgId?: string;
  twilioCallSid?: string;
  callContext?: string;
  greeting?: string;
  diagnostic?: boolean;
  callerKind?: "patient" | "shop_customer" | "breathe_prospect";
  shopCustomerId?: string;
  agentSpeaksFirst?: boolean;
}

/**
 * Storage backend for pending sessions. The production store is
 * Supabase-backed (shared across replicas); tests inject an in-memory
 * implementation so they don't need a live DB.
 */
export interface PendingSessionStore {
  /** Insert or overwrite the entry for its conversationId. */
  upsert(entry: PendingSessionEntry, nowMs: number): Promise<void>;
  /** Read without consuming. Returns null on miss or expiry. */
  peek(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null>;
  /** Read AND consume (atomic) so a leaked id rides exactly one upgrade. */
  claim(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null>;
  /** Stamp the Twilio CallSid onto a live entry. */
  attachCallSid(
    conversationId: string,
    callSid: string,
    nowMs: number,
  ): Promise<boolean>;
  /** Test-only — current live entry count. */
  size?(nowMs: number): Promise<number>;
  /** Test-only — drop all entries. */
  clear?(): void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const PENDING_SESSIONS_TABLE = "voice_pending_sessions";

/**
 * In-memory store. Correct ONLY within a single process — used by tests and
 * single-process local dev. Production uses the Supabase store so the handoff
 * survives across replicas.
 */
export class InMemoryPendingSessionStore implements PendingSessionStore {
  private readonly entries = new Map<string, PendingSessionEntry>();

  upsert(entry: PendingSessionEntry, nowMs: number): Promise<void> {
    this.sweep(nowMs);
    this.entries.set(entry.conversationId, entry);
    return Promise.resolve();
  }

  peek(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null> {
    this.sweep(nowMs);
    return Promise.resolve(this.entries.get(conversationId) ?? null);
  }

  claim(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null> {
    this.sweep(nowMs);
    const entry = this.entries.get(conversationId);
    if (!entry) return Promise.resolve(null);
    this.entries.delete(conversationId);
    return Promise.resolve(entry);
  }

  attachCallSid(
    conversationId: string,
    callSid: string,
    nowMs: number,
  ): Promise<boolean> {
    this.sweep(nowMs);
    const entry = this.entries.get(conversationId);
    if (!entry) return Promise.resolve(false);
    entry.twilioCallSid = callSid;
    return Promise.resolve(true);
  }

  size(nowMs: number): Promise<number> {
    this.sweep(nowMs);
    return Promise.resolve(this.entries.size);
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(nowMs: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= nowMs) this.entries.delete(k);
    }
  }
}

/**
 * Supabase-backed store (migration 0418). Shared across replicas so the WS
 * upgrade can claim a session any replica registered.
 */
export class SupabasePendingSessionStore implements PendingSessionStore {
  // The service-role client is typed to the default `public` schema; every
  // actual query routes through `.schema("resupply")` (see
  // lib/resupply-db/src/supabase-client.ts).
  private table() {
    return getSupabaseServiceRoleClient()
      .schema("resupply")
      .from(PENDING_SESSIONS_TABLE);
  }

  async upsert(entry: PendingSessionEntry, nowMs: number): Promise<void> {
    // Opportunistic, best-effort sweep — never let cleanup latency or
    // failure block registering the live call.
    void this.table()
      .delete()
      .lt("expires_at", new Date(nowMs).toISOString())
      .then(
        () => undefined,
        (err: unknown) => {
          // Pass the error under `err` so the logger's err.* redaction
          // applies (a stringified error could carry row/URL fragments).
          logger.warn(
            { event: "voice_pending_session_sweep_failed", err },
            "voice: pending-session sweep failed (non-fatal)",
          );
        },
      );

    const { error } = await this.table().upsert(
      {
        conversation_id: entry.conversationId,
        payload: entry as unknown as Json,
        created_at: new Date(entry.createdAt).toISOString(),
        expires_at: new Date(entry.expiresAt).toISOString(),
      },
      { onConflict: "conversation_id" },
    );
    if (error) {
      throw new Error(`pending-session upsert failed: ${error.message}`);
    }
  }

  async peek(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null> {
    const { data, error } = await this.table()
      .select("payload")
      .eq("conversation_id", conversationId)
      .gt("expires_at", new Date(nowMs).toISOString())
      .maybeSingle();
    if (error) {
      throw new Error(`pending-session peek failed: ${error.message}`);
    }
    return data ? (data.payload as unknown as PendingSessionEntry) : null;
  }

  async claim(
    conversationId: string,
    nowMs: number,
  ): Promise<PendingSessionEntry | null> {
    // DELETE ... RETURNING in a single statement: atomic, so two racing
    // upgrade attempts for the same id can't both win.
    const { data, error } = await this.table()
      .delete()
      .eq("conversation_id", conversationId)
      .gt("expires_at", new Date(nowMs).toISOString())
      .select("payload")
      .maybeSingle();
    if (error) {
      throw new Error(`pending-session claim failed: ${error.message}`);
    }
    return data ? (data.payload as unknown as PendingSessionEntry) : null;
  }

  async attachCallSid(
    conversationId: string,
    callSid: string,
    nowMs: number,
  ): Promise<boolean> {
    // Read-modify-write the payload's twilioCallSid. Re-check expires_at on
    // the UPDATE and use RETURNING so we report success ONLY when a still-live
    // row was actually stamped — the row may have been claimed or expired
    // between the read and the write. Best-effort: a DB hiccup returns false
    // rather than throwing (this is a post-dial stamp the call path tolerates).
    const nowIso = new Date(nowMs).toISOString();
    const { data: existing, error: readErr } = await this.table()
      .select("payload")
      .eq("conversation_id", conversationId)
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (readErr || !existing) return false;
    const updated: PendingSessionEntry = {
      ...(existing.payload as unknown as PendingSessionEntry),
      twilioCallSid: callSid,
    };
    const { data: written, error: writeErr } = await this.table()
      .update({ payload: updated as unknown as Json })
      .eq("conversation_id", conversationId)
      .gt("expires_at", nowIso)
      .select("conversation_id")
      .maybeSingle();
    return !writeErr && Boolean(written);
  }
}

export interface PendingSessionsOptions {
  /** Default 5 minutes — see file header. */
  ttlMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Storage backend. Defaults to the shared Supabase store. */
  store?: PendingSessionStore;
}

export class PendingSessions {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: PendingSessionStore;

  constructor(opts: PendingSessionsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new SupabasePendingSessionStore();
  }

  /**
   * Register a new pending session. Overwrites any existing entry for the
   * same conversationId — admins can re-trigger a dial after a busy/no-answer
   * outcome and we don't want the second attempt to collide with a stale
   * entry from the first.
   */
  async register(
    args: RegisterPendingSessionArgs,
  ): Promise<PendingSessionEntry> {
    const t = this.now();
    const entry: PendingSessionEntry = {
      conversationId: args.conversationId,
      patientId: args.patientId,
      episodeId: args.episodeId,
      ...(args.orgId ? { orgId: args.orgId } : {}),
      ...(args.twilioCallSid ? { twilioCallSid: args.twilioCallSid } : {}),
      ...(args.callContext ? { callContext: args.callContext } : {}),
      ...(args.greeting ? { greeting: args.greeting } : {}),
      ...(args.diagnostic ? { diagnostic: true } : {}),
      ...(args.callerKind ? { callerKind: args.callerKind } : {}),
      ...(args.shopCustomerId ? { shopCustomerId: args.shopCustomerId } : {}),
      ...(args.agentSpeaksFirst ? { agentSpeaksFirst: true } : {}),
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    await this.store.upsert(entry, t);
    return entry;
  }

  /** Read without consuming. Returns null on miss or expired. */
  peek(conversationId: string): Promise<PendingSessionEntry | null> {
    return this.store.peek(conversationId, this.now());
  }

  /**
   * Read AND consume — the WS upgrade flow uses this so a leaked
   * conversationId can only ride exactly one upgrade attempt.
   */
  claim(conversationId: string): Promise<PendingSessionEntry | null> {
    return this.store.claim(conversationId, this.now());
  }

  /** Stamp the Twilio CallSid onto an existing entry. */
  attachCallSid(conversationId: string, callSid: string): Promise<boolean> {
    return this.store.attachCallSid(conversationId, callSid, this.now());
  }

  /** Test-only — current entry count. */
  async size(): Promise<number> {
    return (await this.store.size?.(this.now())) ?? 0;
  }

  /** Test-only — clears the backing store. */
  shutdown(): void {
    this.store.clear?.();
  }
}

let singleton: PendingSessions | null = null;

export function getPendingSessions(): PendingSessions {
  if (!singleton) singleton = new PendingSessions();
  return singleton;
}

/**
 * Test-only — reset the singleton to a fresh in-memory-backed registry so
 * each test file gets clean state without touching a real DB. (Production
 * uses the Supabase store; tests exercise the same contract in memory.)
 */
export function __resetPendingSessionsForTests(): void {
  if (singleton) singleton.shutdown();
  singleton = new PendingSessions({ store: new InMemoryPendingSessionStore() });
}

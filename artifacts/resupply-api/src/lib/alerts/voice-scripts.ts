// In-memory, short-TTL store for outbound alert voice scripts.
//
// An automated phone-call alert is placed via Twilio with a TwiML
// webhook URL. The spoken text is patient-specific (it contains the
// rendered alert copy), so it must NOT ride in the webhook URL —
// that would leak it into Twilio's request logs. Instead the dispatch
// path renders the script, stashes it here under an opaque random
// `ref`, and dials Twilio pointing at
// `/voice/alert-twiml?ref=<ref>`. When the patient answers, Twilio
// fetches that endpoint, which reads the script back out and returns
// a `<Say>` TwiML document.
//
// Same single-instance / short-TTL posture as
// `lib/voice/pending-sessions.ts`: the handoff window is seconds, the
// entry is consumed once, and stale entries are swept. When we go
// multi-instance this moves to Redis (see ADR 004); until then an
// in-process Map is correct and dependency-free.

export interface AlertVoiceScriptEntry {
  /** The fully-rendered, plain-text transcript Twilio will speak. */
  spokenText: string;
  createdAt: number;
  expiresAt: number;
}

export interface AlertVoiceScriptsOptions {
  /** Default 5 minutes — matches the place-call handoff window. */
  ttlMs?: number;
  /** Test seam. */
  now?: () => number;
  /** Periodic sweep interval. Default = ttlMs. 0 disables. */
  sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class AlertVoiceScripts {
  private readonly entries = new Map<string, AlertVoiceScriptEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: AlertVoiceScriptsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    const sweepInterval = opts.sweepIntervalMs ?? this.ttlMs;
    if (sweepInterval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
      // Don't keep the event loop alive just for a registry sweep.
      if (typeof this.sweepTimer.unref === "function") {
        this.sweepTimer.unref();
      }
    } else {
      this.sweepTimer = null;
    }
  }

  /** Stash a script under `ref`, overwriting any existing entry. */
  register(ref: string, spokenText: string): AlertVoiceScriptEntry {
    this.sweep();
    const t = this.now();
    const entry: AlertVoiceScriptEntry = {
      spokenText,
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.entries.set(ref, entry);
    return entry;
  }

  /** Read without consuming. Null on miss or expired. */
  peek(ref: string): AlertVoiceScriptEntry | null {
    this.sweep();
    return this.entries.get(ref) ?? null;
  }

  /**
   * Read AND consume — the TwiML handler uses this so a leaked ref can
   * only be spoken once. Null on miss or expired.
   */
  claim(ref: string): AlertVoiceScriptEntry | null {
    this.sweep();
    const entry = this.entries.get(ref);
    if (!entry) return null;
    this.entries.delete(ref);
    return entry;
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

let singleton: AlertVoiceScripts | null = null;

export function getAlertVoiceScripts(): AlertVoiceScripts {
  if (!singleton) singleton = new AlertVoiceScripts();
  return singleton;
}

/** Test-only — drop the singleton so each test file starts fresh. */
export function __resetAlertVoiceScriptsForTests(): void {
  if (singleton) singleton.shutdown();
  singleton = null;
}

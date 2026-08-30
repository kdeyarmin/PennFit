/**
 * Eyes-free feedback for the guided capture — sound, vibration, speech.
 *
 * The guided flow asks the patient to turn their head away from the
 * phone, which means the moment the coaching matters most is exactly the
 * moment they cannot read it. This module gives the flow three channels
 * that work with eyes closed:
 *
 *   * a short synthesized CHIME the instant a frame is captured (plus a
 *     longer one when the whole set is done), so "did it take?" never
 *     requires looking back at the screen;
 *   * a VIBRATION pulse alongside the chime, for phones that are muted
 *     (Android; iOS Safari has no vibration API and relies on the chime);
 *   * SPOKEN prompts and coach lines via the built-in speech synthesizer,
 *     so "turn a little further" reaches a patient whose eyes are on the
 *     far wall.
 *
 * Everything here is defensive: WebAudio, `navigator.vibrate`, and
 * `speechSynthesis` are all feature-detected and every call is wrapped,
 * so an old browser, a test runner, or a platform that blocks one channel
 * silently degrades to the others — feedback is an enhancement and must
 * never break the capture itself.
 *
 * Audio playback needs user activation. The SPA reaches the capture page
 * through taps (sticky activation), and the module additionally resumes a
 * suspended AudioContext on the next pointer/key event, so the common
 * paths all sound. When the context stays suspended anyway, chimes are
 * skipped — never queued, never thrown.
 *
 * The AudioContext is a lazy module-level singleton: iOS caps how many a
 * page may create, and the capture page can mount/unmount repeatedly
 * (fallback bounces, retakes) — one shared context sidesteps the leak.
 *
 * PHI: none. This module never sees pixels, landmarks, or measurements —
 * it only ever plays tones and speaks the same coaching copy the screen
 * already shows.
 */

const SOUND_PREF_KEY = "pf.capture-audio";

/** Gap below which a coach line is never re-spoken, however new. */
export const COACH_SPEECH_MIN_GAP_MS = 3_000;
/** Gap after which even the SAME coach line is worth repeating. */
export const COACH_SPEECH_REPEAT_GAP_MS = 9_000;

export interface SpokenCoachLine {
  text: string;
  atMs: number;
}

/**
 * Whether to speak `text` now, given what was last spoken and when.
 *
 * Pure — the throttle that keeps the voice from narrating every 180ms
 * assessment tick. A NEW line waits out the minimum gap (so "hold it" →
 * "turn further" → "hold it" churn doesn't chatter), and the SAME line
 * repeats only after the longer gap (a patient still mid-struggle gets a
 * reminder, not a metronome).
 */
export function shouldSpeakCoachLine(
  last: SpokenCoachLine | null,
  text: string,
  nowMs: number,
  // Optional so the VISUAL coach on the capture page can hold lines for
  // a shorter beat than the spoken one — a line you read tolerates
  // changing sooner than a line you are being told. Defaults are the
  // speech values, so every existing caller is unchanged.
  gaps?: { minGapMs?: number; repeatGapMs?: number },
): boolean {
  const minGap = gaps?.minGapMs ?? COACH_SPEECH_MIN_GAP_MS;
  const repeatGap = gaps?.repeatGapMs ?? COACH_SPEECH_REPEAT_GAP_MS;
  if (!text) return false;
  if (!last) return true;
  const elapsed = nowMs - last.atMs;
  if (elapsed < minGap) return false;
  if (text !== last.text) return true;
  return elapsed >= repeatGap;
}

export interface CaptureFeedback {
  /** Current sound/speech preference (vibration is always on — it is
   *  silent by definition and is the muted-phone fallback). */
  readonly enabled: boolean;
  /** Flip the preference; persisted so a retake keeps the choice. */
  setEnabled(on: boolean): void;
  /**
   * Warm the audio path: create the AudioContext and attempt a resume.
   * Call it from real interaction points (page ready, the sound toggle)
   * so the context is running BEFORE the first timer-driven auto-capture
   * needs it — `resume()` succeeds most reliably inside a gesture.
   */
  prime(): void;
  /** One frame captured — the shutter-confirm chime + a short pulse. */
  frameCaptured(): void;
  /** Every angle captured — the longer "all done" chime + double pulse. */
  allDone(): void;
  /** Speak a prompt/coach line. `interrupt` cuts anything mid-sentence —
   *  use it for step changes; leave it off for passing coach lines. */
  speak(text: string, opts?: { interrupt?: boolean }): void;
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let sharedContext: AudioContext | null = null;
let resumeListenersArmed = false;

function getAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    sharedContext ??= new Ctor();
  } catch {
    return null;
  }
  const ctx = sharedContext;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {
      /* stays suspended until a user gesture */
    });
    if (!resumeListenersArmed) {
      resumeListenersArmed = true;
      // PERSISTENT listeners, not `once`: a single early tap can fire
      // while the browser still refuses the resume, and a once-listener
      // would then be spent — leaving every later chime silently dropped.
      // Re-trying on each interaction costs nothing once running.
      const resume = () => {
        if (ctx.state === "suspended") {
          void ctx.resume().catch(() => {
            /* best-effort */
          });
        }
      };
      window.addEventListener("pointerdown", resume);
      window.addEventListener("keydown", resume);
    }
  }
  return ctx;
}

/** One tone in a chime: frequency, start offset, and length (seconds). */
interface ChimeNote {
  freqHz: number;
  at: number;
  duration: number;
}

function playNotes(notes: ChimeNote[]): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state !== "running") {
    // Auto-captures fire from a timer, outside any user-gesture handler,
    // so the context can still be suspended here even though the patient
    // tapped their way onto this page. `resume()` is asynchronous — on
    // permissive browsers (sticky activation) it resolves almost
    // immediately, so chase it and play a slightly-late chime rather
    // than dropping the confirmation entirely. The deadline keeps a
    // resume that only unblocks on some much-later tap from replaying a
    // stale chime that would read as a phantom capture.
    const requestedAt = Date.now();
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === "running" && Date.now() - requestedAt <= 1_500) {
          scheduleNotes(ctx, notes);
        }
      })
      .catch(() => {
        /* stays suspended — this chime is lost, the next tap re-arms */
      });
    return;
  }
  scheduleNotes(ctx, notes);
}

function scheduleNotes(ctx: AudioContext, notes: ChimeNote[]): void {
  try {
    const now = ctx.currentTime;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freqHz;
      const start = now + note.at;
      const end = start + note.duration;
      // Quick attack, exponential-ish decay — a soft "ding", not a beep.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* audio is an enhancement — never let it break the capture */
  }
}

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    /* unsupported / blocked */
  }
}

function readSoundPref(): boolean {
  try {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "off";
  } catch {
    return true; // storage blocked — default on, the whole point is eyes-free
  }
}

function writeSoundPref(on: boolean): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SOUND_PREF_KEY, on ? "on" : "off");
  } catch {
    /* storage blocked — the in-memory flag still applies this session */
  }
}

function speechAvailable(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function createCaptureFeedback(): CaptureFeedback {
  let enabled = readSoundPref();

  const speak = (text: string, opts?: { interrupt?: boolean }) => {
    if (!enabled || !text) return;
    const synth = speechAvailable();
    if (!synth) return;
    try {
      if (opts?.interrupt) synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      synth.speak(utterance);
    } catch {
      /* speech is an enhancement */
    }
  };

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(on: boolean) {
      enabled = on;
      writeSoundPref(on);
      if (on) {
        // The toggle tap is a guaranteed user gesture — the one moment a
        // suspended context is certain to be allowed to resume.
        void getAudioContext();
      } else {
        try {
          speechAvailable()?.cancel();
        } catch {
          /* best-effort */
        }
      }
    },
    prime() {
      if (enabled) void getAudioContext();
    },
    frameCaptured() {
      // Vibration first: it is silent, so it ignores the sound preference
      // and covers the muted-phone case.
      vibrate(40);
      if (!enabled) return;
      // Two quick ascending notes — unmistakably "it took".
      playNotes([
        { freqHz: 1318.5, at: 0, duration: 0.12 }, // E6
        { freqHz: 1760, at: 0.1, duration: 0.22 }, // A6
      ]);
    },
    allDone() {
      vibrate([40, 80, 40]);
      if (!enabled) return;
      // A little ascending arpeggio — "finished", distinct from the
      // per-frame chime.
      playNotes([
        { freqHz: 1046.5, at: 0, duration: 0.14 }, // C6
        { freqHz: 1318.5, at: 0.12, duration: 0.14 }, // E6
        { freqHz: 1568, at: 0.24, duration: 0.3 }, // G6
      ]);
    },
    speak,
  };
}

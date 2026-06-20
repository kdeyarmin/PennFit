// @workspace/resupply-ai — domain-term pronunciation pass for TTS.
//
// Why this exists:
//   Low-latency TTS models (ElevenLabs `eleven_flash_v2_5`, the voice
//   agent's default) reliably mangle a handful of CPAP/DME brand and
//   clinical terms — most notably they spell "CPAP" out letter-by-letter
//   ("C-P-A-P") instead of saying "see-pap". On a patient call that is an
//   instant "this is a robot" tell. ElevenLabs phoneme dictionaries are
//   NOT supported on the flash/turbo v2.5 models, so the portable fix is a
//   tiny text rewrite applied to the agent's words right before they reach
//   the TTS engine.
//
//   Keep the map SMALL and obviously-correct. This is not a general NLP
//   normalizer — every entry is a fixed brand/clinical term with a single
//   right pronunciation. Add an entry only when you've confirmed (via the
//   bot-playground test call) the voice actually gets it wrong.
//
// PHI: the text passing through here IS patient-facing speech (PHI by
//   definition). This module performs a pure string transform and NEVER
//   logs the text.

/**
 * Ordered list of [pattern, replacement]. Patterns are case-insensitive
 * and word-boundary anchored so we only ever rewrite the standalone term
 * (e.g. "CPAP" but never the "cpap" inside a hypothetical longer token).
 * Replacements use hyphens to coax the model into syllables rather than an
 * initialism spell-out.
 */
const PRONUNCIATION_ENTRIES: ReadonlyArray<readonly [RegExp, string]> = [
  // Therapy-mode initialisms TTS otherwise spells out letter-by-letter.
  [/\bCPAP\b/gi, "see-pap"],
  [/\bBiPAP\b/gi, "bye-pap"],
  [/\bBi-PAP\b/gi, "bye-pap"],
  [/\bAPAP\b/gi, "ay-pap"],
  [/\bBiLevel\b/gi, "bye-level"],
  // ResMed reads as "rez-med"/"rezz-med"; left bare it can come out "rezmed"
  // as one mumbled syllable.
  [/\bResMed\b/gi, "Rezz-med"],
];

/**
 * Apply the domain-term pronunciation rewrites to a COMPLETE chunk of
 * text. Pure and idempotent enough for practical use (replacements don't
 * re-introduce a matched term). Use this on the per-sentence (HTTP) TTS
 * path where the whole sentence is in hand; use {@link createPronunciationStream}
 * on the streaming path where text arrives in partial deltas.
 */
export function applyPronunciation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PRONUNCIATION_ENTRIES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Streaming-safe wrapper around {@link applyPronunciation}.
 *
 * The ElevenLabs stream-input path feeds the model's output text in as it
 * is generated — partial deltas that can split a term across two pushes
 * ("…send a CP" then "AP machine"). Running a word-boundary rewrite on
 * each delta independently would miss the split term. This stateful helper
 * holds back the trailing (possibly-incomplete) word until a whitespace
 * boundary arrives or `flush()` is called, so every rewrite runs on whole
 * words.
 */
export interface PronunciationStream {
  /**
   * Feed the next raw delta. Returns the normalized text that is now safe
   * to forward (everything up to the last whitespace); the trailing
   * partial word is buffered until more text or `flush()` arrives. Returns
   * "" when nothing is safe to emit yet.
   */
  push(text: string): string;
  /** Emit and clear the buffered tail. Call at sentence/turn boundaries. */
  flush(): string;
}

export function createPronunciationStream(): PronunciationStream {
  let buffer = "";
  return {
    push(text: string): string {
      buffer += text;
      // Cut after the LAST whitespace char: everything before it is whole
      // words (safe to rewrite + emit); the remainder is a partial word we
      // keep buffering. \s includes the newline/space the model emits
      // between tokens.
      let cut = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (/\s/.test(buffer[i] as string)) {
          cut = i + 1;
          break;
        }
      }
      if (cut <= 0) return "";
      const emit = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return applyPronunciation(emit);
    },
    flush(): string {
      if (buffer.length === 0) return "";
      const out = applyPronunciation(buffer);
      buffer = "";
      return out;
    },
  };
}

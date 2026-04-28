// @workspace/resupply-messaging — intent enum shared between SMS keyword
// routing and the AI fallback.
//
// Both surfaces produce one of the SAME six intents. Keeping the enum
// in one place means the AI fallback's JSON schema and the keyword
// router's switch statement can never disagree about what the system
// will accept downstream.

export const INTENT_NAMES = [
  "confirm",
  "decline",
  "edit_address",
  "stop",
  "help",
  "unknown",
] as const;

export type Intent = (typeof INTENT_NAMES)[number];

/**
 * Compile-time exhaustiveness helper. Switch statements that branch on
 * `Intent` should call this in their `default` arm; if a future intent
 * is added, every switch site fails to compile until it handles the
 * new value.
 */
export function assertNeverIntent(value: never): never {
  throw new Error(
    `Unhandled intent: ${String(value)} — add a case to the switch.`,
  );
}

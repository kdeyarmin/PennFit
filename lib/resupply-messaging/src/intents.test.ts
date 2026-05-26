import { describe, expect, it } from "vitest";

import { INTENT_NAMES, assertNeverIntent, type Intent } from "./intents";

describe("INTENT_NAMES", () => {
  it("covers exactly the seven known intents in stable order", () => {
    expect(INTENT_NAMES).toEqual([
      "confirm",
      "decline",
      "edit_address",
      "stop",
      "start",
      "help",
      "unknown",
    ]);
  });
});

describe("assertNeverIntent", () => {
  it("throws when called with any value (defensive guard)", () => {
    // Force-cast to `never` to simulate a switch arm reaching default.
    expect(() => assertNeverIntent("badIntent" as never)).toThrow(
      /Unhandled intent/,
    );
  });

  it("compile-time helper: switch covers every Intent", () => {
    const all: Intent[] = [
      "confirm",
      "decline",
      "edit_address",
      "stop",
      "start",
      "help",
      "unknown",
    ];
    for (const intent of all) {
      const handled = (() => {
        switch (intent) {
          case "confirm":
          case "decline":
          case "edit_address":
          case "stop":
          case "start":
          case "help":
          case "unknown":
            return true;
          default:
            return assertNeverIntent(intent);
        }
      })();
      expect(handled).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";

import { parseSmsIntent } from "./keyword-router";

describe("parseSmsIntent", () => {
  describe("STOP family (carrier-mandated, anywhere in body)", () => {
    it.each([
      "STOP",
      "stop",
      "Stop",
      "STOP ALL",
      "stopall",
      "UNSUBSCRIBE",
      "Cancel please",
      "end",
      "QUIT",
      "opt-out now",
      "please stop reminding me",
    ])("classifies %j as stop", (body) => {
      expect(parseSmsIntent(body).intent).toBe("stop");
    });

    it("matches STOP even when it appears mid-sentence with punctuation", () => {
      expect(parseSmsIntent("hi. STOP. thanks.").intent).toBe("stop");
    });

    it("does NOT treat 'revoke' as an opt-out keyword (over-matched real prose)", () => {
      // "revoke" is not a CTIA-reserved keyword and matched anywhere,
      // so "I didn't revoke my prescription, please ship" wrongly paused
      // the patient. It now escalates instead of force-stopping.
      expect(
        parseSmsIntent("I didn't revoke my prescription").intent,
      ).not.toBe("stop");
    });

    it.each([
      "DETENER",
      "detener",
      "Cancelar",
      "ALTO",
      "fin",
      "parar",
    ])("classifies Spanish/Portuguese opt-out %j as stop", (body) => {
      expect(parseSmsIntent(body).intent).toBe("stop");
    });
  });

  describe("HELP family (carrier-mandated, anywhere in body)", () => {
    it.each(["HELP", "help", "Help me", "info", "support please"])(
      "classifies %j as help",
      (body) => {
        expect(parseSmsIntent(body).intent).toBe("help");
      },
    );

    it.each(["AYUDA", "ayuda", "ajuda"])(
      "classifies Spanish/Portuguese %j as help",
      (body) => {
        expect(parseSmsIntent(body).intent).toBe("help");
      },
    );

    it("STOP wins over HELP if both appear (decision priority)", () => {
      expect(parseSmsIntent("help me stop").intent).toBe("stop");
    });
  });

  describe("CONFIRM family (leading word)", () => {
    it.each([
      "YES",
      "yes",
      "Y",
      "y",
      "Yeah",
      "yep",
      "OK",
      "okay",
      "sure",
      "confirm",
      "go",
      "send",
      "ship it",
    ])("classifies %j as confirm", (body) => {
      expect(parseSmsIntent(body).intent).toBe("confirm");
    });

    it("yes-then-comment still confirms", () => {
      expect(parseSmsIntent("yes please send them").intent).toBe("confirm");
      expect(parseSmsIntent("y. thanks").intent).toBe("confirm");
    });

    it("a leading action verb that asks to change the address routes to edit, not confirm", () => {
      // "send it to my new address" must not ship to the stale on-file
      // address. A bare "ship it" / "send them" still confirms.
      expect(parseSmsIntent("send it to my new address").intent).toBe(
        "edit_address",
      );
      expect(parseSmsIntent("ship it").intent).toBe("confirm");
      expect(parseSmsIntent("send them").intent).toBe("confirm");
    });
  });

  describe("START family (carrier opt-in, leading token)", () => {
    it.each(["START", "start", "Start", "UNSTOP", "unstop", "start please"])(
      "classifies %j as start",
      (body) => {
        expect(parseSmsIntent(body).intent).toBe("start");
      },
    );

    it("STOP wins over START when both are present", () => {
      expect(parseSmsIntent("stop, do not start again").intent).toBe("stop");
    });

    it("does NOT hijack a confirm that merely contains 'start' mid-body", () => {
      // Leading-token matching keeps "yes, start shipping" a confirm
      // instead of a spurious re-subscribe.
      expect(parseSmsIntent("yes start shipping").intent).toBe("confirm");
    });
  });

  describe("DECLINE family (leading word)", () => {
    it.each(["NO", "no", "N", "n", "Nope", "nah", "decline", "skip", "pass"])(
      "classifies %j as decline",
      (body) => {
        expect(parseSmsIntent(body).intent).toBe("decline");
      },
    );

    it("no-then-comment still declines", () => {
      expect(parseSmsIntent("no thanks, not now").intent).toBe("decline");
    });
  });

  describe("EDIT family (leading word)", () => {
    it.each([
      "EDIT",
      "edit",
      "change my address",
      "address",
      "moved",
      "update please",
      "wrong address",
      "different address",
    ])("classifies %j as edit_address", (body) => {
      expect(parseSmsIntent(body).intent).toBe("edit_address");
    });
  });

  describe("UNKNOWN (escalate to AI fallback)", () => {
    it.each([
      "what does this mean?",
      "how soon will it ship?",
      "I'm not sure I need this anymore",
      "actually, can you change just the mask?",
      "",
      "   ",
      "?",
      "👍",
    ])("classifies %j as unknown", (body) => {
      const r = parseSmsIntent(body);
      expect(r.intent).toBe("unknown");
    });

    it("does NOT misroute messages where 'yes'/'no' appears mid-sentence", () => {
      // "Did you say yes the last time?" must NOT be confirm.
      expect(parseSmsIntent("did you say yes the last time?").intent).toBe(
        "unknown",
      );
      expect(parseSmsIntent("not really sure").intent).toBe("unknown");
    });
  });

  describe("result shape", () => {
    it("echoes raw + normalized + matched flag", () => {
      const r = parseSmsIntent("  YES please  ");
      expect(r.raw).toBe("  YES please  ");
      expect(r.normalized).toBe("yes please");
      expect(r.matched).toBe("keyword-leading");
    });

    it("matched=keyword-anywhere for STOP/HELP", () => {
      expect(parseSmsIntent("STOP").matched).toBe("keyword-anywhere");
      expect(parseSmsIntent("help").matched).toBe("keyword-anywhere");
    });

    it("matched=unknown for unmatched bodies", () => {
      expect(parseSmsIntent("what's the deal").matched).toBe("unknown");
    });

    it("handles null/undefined body", () => {
      expect(parseSmsIntent(null).intent).toBe("unknown");
      expect(parseSmsIntent(undefined).intent).toBe("unknown");
    });
  });
});

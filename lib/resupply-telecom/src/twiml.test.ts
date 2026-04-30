import { describe, expect, it } from "vitest";
import { buildConnectStreamTwiml, buildHangupTwiml } from "./twiml";

describe("buildConnectStreamTwiml", () => {
  it("emits a well-formed Connect+Stream document with a wss URL", () => {
    const xml = buildConnectStreamTwiml({
      wsUrl: "wss://example.com/resupply-api/voice/stream",
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Response>");
    expect(xml).toContain("<Connect>");
    expect(xml).toContain(
      '<Stream url="wss://example.com/resupply-api/voice/stream">',
    );
    expect(xml).toContain("</Connect>");
    expect(xml).toContain("</Response>");
  });

  it("includes one <Parameter> per customParameters entry", () => {
    const xml = buildConnectStreamTwiml({
      wsUrl: "wss://example.com/voice/stream",
      customParameters: {
        conversationId: "11111111-1111-1111-1111-111111111111",
        promptVersion: "2026-04-28.v1",
      },
    });
    expect(xml).toContain(
      '<Parameter name="conversationId" value="11111111-1111-1111-1111-111111111111"/>',
    );
    expect(xml).toContain(
      '<Parameter name="promptVersion" value="2026-04-28.v1"/>',
    );
  });

  it("XML-escapes characters that would otherwise break the document", () => {
    const xml = buildConnectStreamTwiml({
      wsUrl: "wss://example.com/voice/stream?ok=1&also=2",
      customParameters: { note: 'a"b<c>d&e' },
    });
    // The ampersand in the URL must come out as &amp;
    expect(xml).toMatch(/wss:\/\/example\.com\/voice\/stream\?ok=1&amp;also=2/);
    // The custom parameter must have all special chars escaped
    expect(xml).toContain('value="a&quot;b&lt;c&gt;d&amp;e"');
    // And, importantly, no raw < or " inside attribute values
    const customLine = xml
      .split("\n")
      .find((l) => l.includes('name="note"')) ?? "";
    expect(customLine).not.toMatch(/value="[^"]*</);
  });

  it("rejects a non-ws/wss URL", () => {
    expect(() =>
      buildConnectStreamTwiml({ wsUrl: "https://example.com/voice/stream" }),
    ).toThrow();
  });

  it("rejects a URL with embedded CR/LF (header-injection guard)", () => {
    expect(() =>
      buildConnectStreamTwiml({
        wsUrl: "wss://example.com/voice\r\nFakeHeader: x",
      }),
    ).toThrow();
  });

  it("rejects an invalid customParameters key (must be alnum/_)", () => {
    expect(() =>
      buildConnectStreamTwiml({
        wsUrl: "wss://example.com/voice/stream",
        customParameters: { "bad key!": "x" },
      }),
    ).toThrow();
  });

  it("renders a placeholder comment when no customParameters are supplied", () => {
    const xml = buildConnectStreamTwiml({
      wsUrl: "wss://example.com/voice/stream",
    });
    expect(xml).toContain("<!-- no custom parameters -->");
  });
});

describe("buildHangupTwiml", () => {
  it("emits a well-formed Hangup document with no <Say>", () => {
    const xml = buildHangupTwiml();
    expect(xml).toContain("<Response>");
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Say>");
  });

  it("includes a <Say> when a message is supplied, escaping XML specials", () => {
    const xml = buildHangupTwiml("Cancel & hang up <now>");
    expect(xml).toContain("<Say>");
    // Angle brackets and ampersands MUST be escaped — apostrophes
    // and double-quotes don't need escaping inside element text.
    expect(xml).toContain("Cancel &amp; hang up &lt;now&gt;");
    expect(xml).not.toContain("<now>");
  });
});

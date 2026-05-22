import { describe, expect, it } from "vitest";

import { createAnthropicClient, type AnthropicResponse } from "@workspace/resupply-ai";

import { summarizePostCall, type TurnForSummary } from "./post-call-summary";

const VALID_KEY = "sk-ant-test-fake-key";

function makeClient(replyJson: string) {
  const sample: AnthropicResponse = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: replyJson }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return createAnthropicClient({
    apiKey: VALID_KEY,
    fetchImpl: async () =>
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

function makeErrorClient(status: number) {
  return createAnthropicClient({
    apiKey: VALID_KEY,
    fetchImpl: async () =>
      new Response("error", { status, headers: { "content-type": "text/plain" } }),
  });
}

const SAMPLE_TURNS: TurnForSummary[] = [
  { source: "output", text: "Hi there, this is the resupply line. Is this a good time?" },
  { source: "input", text: "yes" },
  { source: "output", text: "Great, can I grab your date of birth to pull up your account?" },
  { source: "input", text: "January 12th 1952" },
  { source: "output", text: "Got it. Looks like you're due for replacement cushions." },
  { source: "input", text: "Yes please ship them" },
  { source: "output", text: "Done — they'll go out today. Take care!" },
];

describe("summarizePostCall", () => {
  it("returns the parsed JSON shape on a happy-path response", async () => {
    const client = makeClient(
      JSON.stringify({
        outcome: "Patient verified DOB and confirmed cushion shipment.",
        sentiment: "positive",
        concerns: [],
        followUps: [],
        recommendsHandoff: false,
      }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "model-end_call",
    });
    expect(result).not.toBeNull();
    expect(result?.outcome).toContain("cushion shipment");
    expect(result?.sentiment).toBe("positive");
    expect(result?.recommendsHandoff).toBe(false);
    expect(result?.complete).toBe(true);
  });

  it("returns the empty-call sentinel when turns is empty (no model call)", async () => {
    let called = false;
    const client = createAnthropicClient({
      apiKey: VALID_KEY,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const result = await summarizePostCall({
      client,
      turns: [],
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(called).toBe(false);
    expect(result?.outcome).toBe("No meaningful interaction.");
    expect(result?.sentiment).toBe("neutral");
  });

  it("returns null when the model returns a non-2xx response", async () => {
    const client = makeErrorClient(500);
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result).toBeNull();
  });

  it("returns null when the model output is not valid JSON", async () => {
    const client = makeClient("this is not json at all");
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result).toBeNull();
  });

  it("returns null when JSON parses but `outcome` is missing/empty", async () => {
    const client = makeClient(
      JSON.stringify({ outcome: "", sentiment: "neutral" }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result).toBeNull();
  });

  it("defaults sentiment to 'neutral' when the model emits an unknown value, and marks complete=false", async () => {
    const client = makeClient(
      JSON.stringify({
        outcome: "Call ended early.",
        sentiment: "weirdsentiment",
        concerns: [],
        followUps: [],
        recommendsHandoff: false,
      }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result?.sentiment).toBe("neutral");
    expect(result?.complete).toBe(false);
  });

  it("flags recommendsHandoff=true when the model says so", async () => {
    const client = makeClient(
      JSON.stringify({
        outcome: "Patient mentioned chest discomfort during the call.",
        sentiment: "distressed",
        concerns: ["mentioned chest discomfort while wearing CPAP"],
        followUps: ["agent said a teammate would call"],
        recommendsHandoff: true,
      }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "model-handoff",
    });
    expect(result?.recommendsHandoff).toBe(true);
    expect(result?.sentiment).toBe("distressed");
    expect(result?.concerns).toHaveLength(1);
    expect(result?.followUps).toHaveLength(1);
  });

  it("tolerates a stray ```json fence around the JSON payload", async () => {
    const client = makeClient(
      "```json\n" +
        JSON.stringify({
          outcome: "Routine refill confirmed.",
          sentiment: "neutral",
          concerns: [],
          followUps: [],
          recommendsHandoff: false,
        }) +
        "\n```",
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "model-end_call",
    });
    expect(result?.outcome).toBe("Routine refill confirmed.");
  });

  it("caps the concerns + followUps arrays at 20 entries", async () => {
    const longArr = Array.from({ length: 50 }, (_, i) => `concern ${i}`);
    const client = makeClient(
      JSON.stringify({
        outcome: "Long arrays test.",
        sentiment: "neutral",
        concerns: longArr,
        followUps: longArr,
        recommendsHandoff: false,
      }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result?.concerns).toHaveLength(20);
    expect(result?.followUps).toHaveLength(20);
  });

  it("filters non-string entries out of concerns/followUps", async () => {
    const client = makeClient(
      JSON.stringify({
        outcome: "Mixed types test.",
        sentiment: "neutral",
        concerns: ["valid", 123, null, "another valid"],
        followUps: [],
        recommendsHandoff: false,
      }),
    );
    const result = await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "PennPaps",
      endReason: "twilio-stop",
    });
    expect(result?.concerns).toEqual(["valid", "another valid"]);
  });

  it("includes the practice name and end reason in the user message", async () => {
    let capturedBody = "";
    const client = createAnthropicClient({
      apiKey: VALID_KEY,
      fetchImpl: async (_url, init) => {
        capturedBody =
          typeof init?.body === "string" ? init.body : String(init?.body);
        return new Response(
          JSON.stringify({
            id: "msg_x",
            type: "message",
            role: "assistant",
            model: "x",
            content: [
              { type: "text", text: '{"outcome":"ok","sentiment":"neutral","concerns":[],"followUps":[],"recommendsHandoff":false}' },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    });
    await summarizePostCall({
      client,
      turns: SAMPLE_TURNS,
      practiceName: "Penn Home Medical",
      endReason: "twilio-stop",
    });
    expect(capturedBody).toContain("Penn Home Medical");
    expect(capturedBody).toContain("twilio-stop");
    // The role labels appear in the message body too.
    expect(capturedBody).toContain("patient:");
    expect(capturedBody).toContain("agent:");
  });
});

import { describe, expect, it } from "vitest";

import {
  findUnknownVariables,
  renderPlaybookBody,
  stepDueAt,
  validateSteps,
  type PlaybookStepShape,
} from "./outreach-playbooks";

describe("findUnknownVariables", () => {
  it("accepts the allowlisted variables", () => {
    expect(
      findUnknownVariables("Hi {{first_name}}, it's {{practice_name}}."),
    ).toEqual([]);
  });

  it("flags unknown tokens once each", () => {
    expect(
      findUnknownVariables("{{first_nme}} and {{order_id}} and {{first_nme}}"),
    ).toEqual(["first_nme", "order_id"]);
  });

  it("ignores non-token braces", () => {
    expect(findUnknownVariables("{{Not_A_Token}} {plain} {{}}")).toEqual([]);
  });
});

describe("renderPlaybookBody", () => {
  it("substitutes both variables", () => {
    expect(
      renderPlaybookBody("Hi {{first_name}}, from {{practice_name}}!", {
        firstName: "Alice",
        practiceName: "PennPaps",
      }),
    ).toBe("Hi Alice, from PennPaps!");
  });

  it("falls back to 'there' for a missing first name", () => {
    expect(
      renderPlaybookBody("Hi {{first_name}}", {
        firstName: null,
        practiceName: "PennPaps",
      }),
    ).toBe("Hi there");
    expect(
      renderPlaybookBody("Hi {{first_name}}", {
        firstName: "   ",
        practiceName: "PennPaps",
      }),
    ).toBe("Hi there");
  });

  it("leaves unknown tokens literal", () => {
    expect(
      renderPlaybookBody("{{order_id}}", {
        firstName: "A",
        practiceName: "P",
      }),
    ).toBe("{{order_id}}");
  });
});

describe("stepDueAt", () => {
  it("anchors on the start time", () => {
    const start = new Date("2026-06-10T12:00:00.000Z");
    expect(stepDueAt(start, 0).toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(stepDueAt(start, 3).toISOString()).toBe("2026-06-13T12:00:00.000Z");
  });
});

describe("validateSteps", () => {
  const sms = (
    overrides: Partial<PlaybookStepShape> = {},
  ): PlaybookStepShape => ({
    stepIndex: 1,
    dayOffset: 0,
    channel: "sms",
    subject: null,
    body: "Hi {{first_name}}. Reply STOP to opt out.",
    ...overrides,
  });

  it("passes a valid cadence", () => {
    expect(
      validateSteps([
        sms(),
        sms({
          stepIndex: 2,
          dayOffset: 3,
          channel: "email",
          subject: "Hello {{first_name}}",
        }),
        sms({ stepIndex: 3, dayOffset: 10, channel: "call" }),
      ]),
    ).toEqual([]);
  });

  it("rejects an empty step list", () => {
    expect(validateSteps([])).toEqual(["A playbook needs at least one step."]);
  });

  it("requires a subject on email steps and forbids it elsewhere", () => {
    const problems = validateSteps([
      sms({ channel: "email", subject: null }),
      sms({ stepIndex: 2, dayOffset: 1, channel: "sms", subject: "nope" }),
    ]);
    expect(problems.some((p) => p.includes("email steps need a subject"))).toBe(
      true,
    );
    expect(
      problems.some((p) => p.includes("only email steps may have a subject")),
    ).toBe(true);
  });

  it("rejects decreasing day offsets", () => {
    const problems = validateSteps([
      sms({ dayOffset: 5 }),
      sms({ stepIndex: 2, dayOffset: 2 }),
    ]);
    expect(problems.some((p) => p.includes("must not decrease"))).toBe(true);
  });

  it("rejects unknown variables in body and subject", () => {
    const problems = validateSteps([
      sms({ body: "Hi {{first_nme}}" }),
      sms({
        stepIndex: 2,
        dayOffset: 1,
        channel: "email",
        subject: "About {{order_id}}",
        body: "ok",
      }),
    ]);
    expect(problems.some((p) => p.includes("{{first_nme}}"))).toBe(true);
    expect(problems.some((p) => p.includes("{{order_id}}"))).toBe(true);
  });
});

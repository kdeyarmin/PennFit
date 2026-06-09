import { describe, expect, it } from "vitest";
import { z } from "zod";

import { respondInvalidBody, zodIssues } from "./http-validation";

function parseError(schema: z.ZodTypeAny, input: unknown): z.ZodError {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a parse failure");
  return r.error;
}

describe("zodIssues", () => {
  it("flattens issues to { path, message } with a dotted path", () => {
    const schema = z
      .object({ items: z.array(z.object({ quantity: z.number().int() })) })
      .strict();
    const issues = zodIssues(
      parseError(schema, { items: [{ quantity: 1.5 }] }),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.path).toBe("items.0.quantity");
    expect(typeof issues[0]!.message).toBe("string");
  });
});

describe("respondInvalidBody", () => {
  it("sends 400 with the canonical { error: 'invalid_body', details } shape", () => {
    const schema = z.object({ name: z.string() }).strict();
    let statusCode = 0;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as import("express").Response;

    respondInvalidBody(res, parseError(schema, { name: 123 }));

    expect(statusCode).toBe(400);
    expect((body as { error: string }).error).toBe("invalid_body");
    const details = (body as { details: Array<{ path: string }> }).details;
    expect(Array.isArray(details)).toBe(true);
    expect(details[0]!.path).toBe("name");
  });
});

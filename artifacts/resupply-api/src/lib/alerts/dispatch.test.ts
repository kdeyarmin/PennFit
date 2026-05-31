import { describe, it, expect } from "vitest";

import { renderAlertMessage } from "./dispatch";

describe("renderAlertMessage", () => {
  it("substitutes allowed variables in subject + bodies", () => {
    const out = renderAlertMessage({
      subject: "Hi {{first_name}} from {{practice_name}}",
      bodyHtml: "<p>Order {{order_number}} shipped</p>",
      bodyText: "Order {{order_number}} shipped to {{first_name}}",
      allowedVariables: ["first_name", "practice_name", "order_number"],
      variables: {
        first_name: "Sam",
        practice_name: "PennPaps",
        order_number: "A-100",
      },
    });
    expect(out.subject).toBe("Hi Sam from PennPaps");
    expect(out.bodyHtml).toBe("<p>Order A-100 shipped</p>");
    expect(out.bodyText).toBe("Order A-100 shipped to Sam");
  });

  it("leaves a non-allowlisted token literal (QA visibility)", () => {
    const out = renderAlertMessage({
      subject: null,
      bodyHtml: null,
      bodyText: "Hello {{first_name}}, SSN {{ssn}}",
      allowedVariables: ["first_name"],
      variables: { first_name: "Sam", ssn: "leak" },
    });
    expect(out.bodyText).toBe("Hello Sam, SSN {{ssn}}");
  });

  it("HTML-escapes interpolated values in bodyHtml but not _html vars", () => {
    const out = renderAlertMessage({
      subject: null,
      bodyHtml: "<p>{{first_name}} {{block_html}}</p>",
      bodyText: "",
      allowedVariables: ["first_name", "block_html"],
      variables: { first_name: "<b>x</b>", block_html: "<i>ok</i>" },
    });
    expect(out.bodyHtml).toBe("<p>&lt;b&gt;x&lt;/b&gt; <i>ok</i></p>");
  });

  it("keeps a null subject/bodyHtml null (sms/voice rows)", () => {
    const out = renderAlertMessage({
      subject: null,
      bodyHtml: null,
      bodyText: "Hi {{first_name}}",
      allowedVariables: ["first_name"],
      variables: { first_name: "Sam" },
    });
    expect(out.subject).toBeNull();
    expect(out.bodyHtml).toBeNull();
    expect(out.bodyText).toBe("Hi Sam");
  });
});

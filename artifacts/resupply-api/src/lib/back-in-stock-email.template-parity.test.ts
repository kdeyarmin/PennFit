// Parity test for the back-in-stock email's templated render path.
// Mirrors lib/rx-renewal/renderers.template-parity.test.ts: when no
// template row exists (the lookup returns null), `renderMessage`'s
// fallback path must produce the same subject/text/html bytes the
// pre-template-library code produced.
//
// This test pins the safety property so future seed data + admin
// edits can land without changing default behaviour for environments
// that haven't yet seeded their templates.

import { describe, expect, it } from "vitest";

import {
  renderMessage,
  type TemplateLookup,
} from "@workspace/resupply-templates";

import { __forTests } from "./back-in-stock-email";
import type { BackInStockEmailPayload } from "./back-in-stock-email";

const noTemplate: TemplateLookup = async () => null;

const FULL_PAYLOAD: BackInStockEmailPayload = {
  email: "test@example.test",
  productId: "prod_1",
  productName: "Premium Mask Cushion",
  productImageUrl: "https://cdn.example.test/img.png",
  productUrl: "https://pennpaps.com/shop/products/prod_1",
  priceLabel: "$49.99",
};

const MINIMAL_PAYLOAD: BackInStockEmailPayload = {
  email: "test@example.test",
  productId: "prod_2",
  productName: "Basic Mask",
  productImageUrl: null,
  productUrl: "https://pennpaps.com/shop/products/prod_2",
  priceLabel: null,
};

describe("back-in-stock email — template fallback parity", () => {
  for (const [label, payload] of [
    ["full payload (image + price)", FULL_PAYLOAD],
    ["minimal payload (no image, no price)", MINIMAL_PAYLOAD],
  ] as const) {
    it(`${label}: subject fallback parity`, async () => {
      const expected = `Back in stock: ${payload.productName}`;
      const result = await renderMessage(
        {
          templateKey: "shop.back_in_stock.email",
          channel: "email",
          variables: __forTests.buildVariables(payload),
        },
        {
          subject: expected,
          bodyHtml: __forTests.renderHtml(payload),
          bodyText: __forTests.renderText(payload),
        },
        noTemplate,
      );
      expect(result.subject).toBe(expected);
    });

    it(`${label}: text body fallback parity`, async () => {
      const expected = __forTests.renderText(payload);
      const result = await renderMessage(
        {
          templateKey: "shop.back_in_stock.email",
          channel: "email",
          variables: __forTests.buildVariables(payload),
        },
        {
          subject: `Back in stock: ${payload.productName}`,
          bodyHtml: __forTests.renderHtml(payload),
          bodyText: expected,
        },
        noTemplate,
      );
      expect(result.bodyText).toBe(expected);
    });

    it(`${label}: html body fallback parity`, async () => {
      const expected = __forTests.renderHtml(payload);
      const result = await renderMessage(
        {
          templateKey: "shop.back_in_stock.email",
          channel: "email",
          variables: __forTests.buildVariables(payload),
        },
        {
          subject: `Back in stock: ${payload.productName}`,
          bodyHtml: expected,
          bodyText: __forTests.renderText(payload),
        },
        noTemplate,
      );
      expect(result.bodyHtml).toBe(expected);
    });
  }

  it("buildVariables exposes both raw and HTML-escaped product fields", () => {
    const v = __forTests.buildVariables({
      ...FULL_PAYLOAD,
      productName: 'Mask "Pro" & Plus',
      productUrl: "https://x.test/?a=1&b=2",
    });
    // Raw fields stay raw.
    expect(v.product_name).toBe('Mask "Pro" & Plus');
    expect(v.product_url).toBe("https://x.test/?a=1&b=2");
    // HTML-escaped variants escape the same characters renderHtml's
    // inline `escapeHtml` would have escaped (& < > " ').
    expect(v.product_name_html).toBe("Mask &quot;Pro&quot; &amp; Plus");
    expect(v.product_url_html).toBe("https://x.test/?a=1&amp;b=2");
  });

  it("buildVariables produces empty conditional blocks when image / price absent", () => {
    const v = __forTests.buildVariables(MINIMAL_PAYLOAD);
    expect(v.image_block_html).toBe("");
    expect(v.price_block_html).toBe("");
    expect(v.price_label).toBe("");
  });

  it("a degraded lookup (throws) lands on the fallback for the email", async () => {
    const broken: TemplateLookup = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const expectedSubject = `Back in stock: ${FULL_PAYLOAD.productName}`;
    const expectedText = __forTests.renderText(FULL_PAYLOAD);
    const result = await renderMessage(
      {
        templateKey: "shop.back_in_stock.email",
        channel: "email",
        variables: __forTests.buildVariables(FULL_PAYLOAD),
      },
      {
        subject: expectedSubject,
        bodyHtml: __forTests.renderHtml(FULL_PAYLOAD),
        bodyText: expectedText,
      },
      broken,
    );
    expect(result.subject).toBe(expectedSubject);
    expect(result.bodyText).toBe(expectedText);
  });
});

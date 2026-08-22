// Byte-parity for the seeded message-template rows (migration 0502).
//
// The invariant: rendering through a SEEDED template row, with the
// variables its dispatcher actually supplies, must produce exactly the
// bytes the FALLBACK renderer produces. The seeds interpolate
// pre-rendered fragment variables for every conditional clause, so the
// two paths are equal by construction — this test pins that across the
// payload matrix (0/1/N days, present/absent optional fields, brands
// with markup-significant characters).
//
// Sibling tests cover the other leg: *.template-parity.test.ts pins
// fallback-path output when NO row exists, and
// seed-bodies.migration-drift.test.ts pins these bodies to the .sql.

import { describe, expect, it } from "vitest";

import {
  renderMessage,
  type Channel,
  type RenderRequest,
  type RenderResult,
  type TemplateLookup,
} from "@workspace/resupply-templates";

import { __forTests as backInStock } from "../back-in-stock-email";
import type { BackInStockEmailPayload } from "../back-in-stock-email";
import { __forTests as appointment } from "../calendar/appointment-assigned-email";
import type { AppointmentAssignedEmailInput } from "../calendar/appointment-assigned-email";
import {
  buildRxRenewalTemplateVars,
  rxRenewalHtml,
  rxRenewalPushTitle,
  rxRenewalSms,
  rxRenewalSubject,
  rxRenewalText,
} from "../rx-renewal/renderers";
import { MESSAGE_TEMPLATE_SEEDS } from "./seed-bodies";

const noTemplate: TemplateLookup = async () => null;

function seedLookup(templateKey: string, channel: Channel): TemplateLookup {
  const seed = MESSAGE_TEMPLATE_SEEDS.find(
    (s) => s.templateKey === templateKey && s.channel === channel,
  );
  if (!seed) throw new Error(`no seed for ${templateKey}/${channel}`);
  return async (key, ch) =>
    key === seed.templateKey && ch === seed.channel
      ? {
          templateKey: seed.templateKey,
          channel: seed.channel,
          subject: seed.subject,
          bodyHtml: seed.bodyHtml,
          bodyText: seed.bodyText,
          allowedVariables: seed.allowedVariables,
        }
      : null;
}

// renderMessage caches lookup results in a module-level Map keyed by
// (orgId, templateKey, channel, customerId) — the LOOKUP FUNCTION is not
// part of the key. Two calls sharing those values would therefore both
// resolve from whichever lookup ran first, silently comparing one path's
// output with itself. Stamp a UNIQUE orgId on every call so each render
// gets a cold cache and the seeded and fallback paths genuinely both run
// (caught by Codex review on PR #1272).
let cacheBust = 0;

async function bothPaths(
  req: Omit<RenderRequest, "orgId" | "customerId">,
  fallback: RenderResult,
): Promise<{ seeded: RenderResult; fallbackPath: RenderResult }> {
  const seeded = await renderMessage(
    { ...req, customerId: null, orgId: `parity-seeded-${cacheBust++}` },
    fallback,
    seedLookup(req.templateKey, req.channel),
  );
  const fallbackPath = await renderMessage(
    { ...req, customerId: null, orgId: `parity-fallback-${cacheBust++}` },
    fallback,
    noTemplate,
  );
  return { seeded, fallbackPath };
}

// Brands chosen to exercise the two HTML-context transforms: the rx
// renderers STRIP [<>&]; the SendGrid-HTML renderers entity-escape.
// O'Dell is deliberate: an apostrophe survives the rx strip but IS
// entity-escaped by the shared layout, so it is the case that catches a
// seed variable escaped a different number of times than its slot.
const BRANDS = [
  { name: "Penn Home Medical Supply", legal: "Penn Home Medical Supply" },
  { name: "CareMetric Breathe", legal: "CareMetric Breathe" },
  { name: "R&R <Medical>", legal: "R&R <Medical> Supply & Co" },
  { name: "O'Dell Home Care", legal: "O'Dell Home Care, Inc." },
] as const;

describe("rx_renewal.* seeded-template parity", () => {
  const DAYS = [0, 1, 7] as const;
  const NAMES = ["", "Maria"] as const;

  for (const brand of BRANDS) {
    for (const daysUntilExpiry of DAYS) {
      for (const firstName of NAMES) {
        const label = `brand=${brand.name} days=${daysUntilExpiry} name=${firstName || "(none)"}`;
        const greeting = firstName ? `Hi ${firstName}` : "Hi";
        const variables = buildRxRenewalTemplateVars({
          firstName,
          greeting,
          daysUntilExpiry,
          brandName: brand.name,
          brandLegalName: brand.legal,
        });

        it(`email: ${label}`, async () => {
          const { seeded, fallbackPath } = await bothPaths(
            { templateKey: "rx_renewal.email", channel: "email", variables },
            {
              subject: rxRenewalSubject(daysUntilExpiry),
              bodyHtml: rxRenewalHtml(greeting, daysUntilExpiry, brand.legal),
              bodyText: rxRenewalText(greeting, daysUntilExpiry, brand.legal),
            },
          );
          expect(seeded).toEqual(fallbackPath);
        });

        it(`sms: ${label}`, async () => {
          const { seeded, fallbackPath } = await bothPaths(
            { templateKey: "rx_renewal.sms", channel: "sms", variables },
            {
              subject: null,
              bodyHtml: null,
              bodyText: rxRenewalSms(firstName, daysUntilExpiry, brand.name),
            },
          );
          expect(seeded).toEqual(fallbackPath);
        });

        it(`push: ${label}`, async () => {
          const { seeded, fallbackPath } = await bothPaths(
            { templateKey: "rx_renewal.push", channel: "push", variables },
            {
              subject: null,
              bodyHtml: null,
              bodyText: rxRenewalPushTitle(daysUntilExpiry),
            },
          );
          expect(seeded).toEqual(fallbackPath);
        });
      }
    }
  }
});

describe("shop.back_in_stock.email seeded-template parity", () => {
  const PAYLOADS: ReadonlyArray<[string, BackInStockEmailPayload]> = [
    [
      "full (image + price)",
      {
        email: "t@example.test",
        productId: "prod_1",
        productName: "Premium Mask Cushion",
        productImageUrl: "https://cdn.example.test/img.png",
        productUrl: "https://example.test/shop/products/prod_1",
        priceLabel: "$49.99",
      },
    ],
    [
      "minimal (no image, no price)",
      {
        email: "t@example.test",
        productId: "prod_2",
        productName: "Basic Mask <XL> & Co",
        productImageUrl: null,
        productUrl: "https://example.test/shop/products/prod_2?a=1&b=2",
        priceLabel: null,
      },
    ],
  ];

  for (const brand of BRANDS) {
    for (const [label, base] of PAYLOADS) {
      it(`${label} · brand=${brand.name}`, async () => {
        const payload: BackInStockEmailPayload = {
          ...base,
          brandName: brand.name,
        };
        const { seeded, fallbackPath } = await bothPaths(
          {
            templateKey: "shop.back_in_stock.email",
            channel: "email",
            variables: backInStock.buildVariables(payload),
          },
          {
            subject: `Back in stock: ${payload.productName}`,
            bodyHtml: backInStock.renderHtml(payload),
            bodyText: backInStock.renderText(payload),
          },
        );
        expect(seeded).toEqual(fallbackPath);
      });
    }
  }
});

describe("appointment.assigned.email seeded-template parity", () => {
  const INPUTS: ReadonlyArray<[string, AppointmentAssignedEmailInput]> = [
    [
      "all fields",
      {
        toEmail: "t@example.test",
        assigneeName: "Jordan <QA> & Team",
        startsAt: "2026-09-01T14:00:00Z",
        endsAt: "2026-09-01T14:30:00Z",
        eventType: "fitting_virtual",
        location: "Room 2 <annex> & lobby",
        assignedByEmail: "lead@example.test",
        dashboardUrl: "https://example.test/admin/calendar?d=2026-09-01&v=w",
      },
    ],
    [
      "no location / no assigner / no name",
      {
        toEmail: "t@example.test",
        assigneeName: null,
        startsAt: "2026-12-24T13:15:00Z",
        endsAt: "2026-12-24T14:00:00Z",
        eventType: "other",
        location: null,
        assignedByEmail: null,
        dashboardUrl: "https://example.test/admin/calendar",
      },
    ],
  ];

  for (const brand of BRANDS) {
    for (const [label, input] of INPUTS) {
      it(`${label} · brand=${brand.name}`, async () => {
        const { seeded, fallbackPath } = await bothPaths(
          {
            templateKey: "appointment.assigned.email",
            channel: "email",
            variables: appointment.buildTemplateVariables(input, brand.name),
          },
          {
            subject: "An appointment was scheduled for you",
            bodyHtml: appointment.renderHtml(input, brand.name),
            bodyText: appointment.renderText(input, brand.name),
          },
        );
        expect(seeded).toEqual(fallbackPath);
      });
    }
  }
});

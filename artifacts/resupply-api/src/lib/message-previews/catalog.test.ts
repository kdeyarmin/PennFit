// Tests for the patient-message preview catalog.
//
// Two jobs:
//
//  1. The catalog renders — every scenario produces at least one channel,
//     carries the tenant's brand (never a hard-coded one), and meters SMS
//     the way a carrier bills it.
//
//  2. DRIFT — every `"mirrored"` scenario duplicates copy that really
//     lives in a production send path. The fingerprint check greps that
//     source file and fails if the distinctive phrase is gone, so copy
//     cannot quietly change on one side while this page keeps advertising
//     the old wording. `"exact"` scenarios need no fingerprint: they call
//     the production renderer, so they cannot drift by construction.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildMessagePreviews,
  findMessagePreview,
  meterSms,
  MIRRORED_FINGERPRINTS,
  SAMPLE,
  type PreviewBrand,
} from "./catalog";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root — this file sits at artifacts/resupply-api/src/lib/message-previews. */
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const BRAND: PreviewBrand = {
  brandName: "Riverside CPAP",
  // Deliberately DIFFERENT from brandName: a tenant can configure the
  // practice name independently, and the reminder scenarios must use it.
  companyName: "Riverside Home Medical",
  legalName: "Riverside Home Medical LLC",
  supportPhoneDisplay: "(215) 555-0100",
  supportEmail: "care@riverside.example",
  baseUrl: "https://shop.riverside.example",
};

describe("message preview catalog", () => {
  const previews = buildMessagePreviews(BRAND);

  it("covers all four scenario groups", () => {
    const groups = new Set(previews.map((p) => p.group));
    expect(groups).toEqual(
      new Set(["resupply", "orders", "clinical", "billing"]),
    );
  });

  it("gives every scenario at least one channel", () => {
    for (const p of previews) {
      expect(
        p.email ?? p.sms,
        `${p.id} has neither an email nor an SMS`,
      ).toBeTruthy();
    }
  });

  it("uses unique ids", () => {
    const ids = previews.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders the tenant's brand, never a hard-coded one", () => {
    // The seed tenant's brand leaking into another tenant's preview is the
    // exact bug the platform/tenant split exists to prevent.
    for (const p of previews) {
      const blob = `${p.email?.subject ?? ""}\n${p.email?.text ?? ""}\n${p.sms?.body ?? ""}`;
      expect(blob, `${p.id} mentions Penn Home Medical Supply`).not.toContain(
        "Penn Home Medical Supply",
      );
    }
    // And at least some scenarios actually interpolate the brand.
    const branded = previews.filter((p) =>
      `${p.email?.subject ?? ""}${p.email?.text ?? ""}${p.sms?.body ?? ""}`.includes(
        BRAND.brandName,
      ),
    );
    expect(branded.length).toBeGreaterThan(4);
  });

  it("renders only fictional sample data", () => {
    const withPatient = previews.filter((p) =>
      `${p.email?.text ?? ""}${p.sms?.body ?? ""}`.includes(SAMPLE.firstName),
    );
    expect(withPatient.length).toBeGreaterThan(4);
  });

  it("leaves no unsubstituted template variables", () => {
    for (const p of previews) {
      for (const [field, value] of [
        ["subject", p.email?.subject],
        ["text", p.email?.text],
        ["html", p.email?.html],
        ["sms", p.sms?.body],
      ] as const) {
        if (!value) continue;
        expect(
          value,
          `${p.id}.${field} has an unrendered {{variable}}`,
        ).not.toMatch(/\{\{[a-z][a-z0-9_]*\}\}/);
      }
    }
  });

  it("keeps every SMS opt-out-compliant or transactional-with-a-link", () => {
    // Marketing-adjacent reminders must carry STOP. Purely transactional
    // ones (a link the patient asked for) are allowed not to, but must at
    // least name the brand so the recipient knows who is texting.
    for (const p of previews) {
      if (!p.sms) continue;
      const body = p.sms.body;
      const hasStop = /STOP/.test(body);
      const namesBrand = body.includes(BRAND.brandName);
      expect(
        hasStop || namesBrand,
        `${p.id} SMS has neither a STOP footer nor the brand name`,
      ).toBe(true);
    }
  });

  it("finds a preview by id and returns null for an unknown one", () => {
    expect(
      findMessagePreview(BRAND, "resupply.reminder.initial"),
    ).not.toBeNull();
    expect(findMessagePreview(BRAND, "nope.not.real")).toBeNull();
  });
});

describe("SMS metering", () => {
  it("counts a plain ASCII body as one GSM-7 segment", () => {
    const m = meterSms(
      "Hi Jordan, your supplies shipped. Reply STOP to opt out.",
    );
    expect(m.encoding).toBe("GSM-7");
    expect(m.segments).toBe(1);
  });

  it("flips to UCS-2 on a single non-GSM-7 character", () => {
    // An em dash is the classic accident: one character triples the cost.
    const m = meterSms("Hi Jordan — your supplies shipped.");
    expect(m.encoding).toBe("UCS-2");
  });

  it("charges a second segment past the single-segment limit", () => {
    const m = meterSms("a".repeat(161));
    expect(m.encoding).toBe("GSM-7");
    expect(m.segments).toBe(2);
  });

  it("keeps every reminder body in GSM-7", () => {
    // This is the invariant that always holds and matters most: a single
    // non-GSM-7 character would cut the segment from 160 septets to 70 and
    // more than double the cost of a fleet-wide send.
    for (const p of buildMessagePreviews(BRAND)) {
      if (!p.id.startsWith("resupply.reminder.")) continue;
      expect(p.sms?.encoding, `${p.id} left GSM-7`).toBe("GSM-7");
    }
  });

  it("fits a reminder in one segment for a short practice name", () => {
    // The production copy is written to fit one segment "for a typical
    // name/practice" (see defaultReminderSmsBody). Pin that for a short
    // name so an edit to the copy itself is caught.
    const shortBrand = { ...BRAND, companyName: "Acme CPAP" };
    for (const p of buildMessagePreviews(shortBrand)) {
      if (!p.id.startsWith("resupply.reminder.")) continue;
      expect(p.sms?.segments, `${p.id} needs >1 segment`).toBe(1);
    }
  });

  it("spills a reminder into a second segment for a long practice name", () => {
    // NOT a bug, but an operational fact worth being visible: the reminder
    // fits one segment only for shortish practice names. A tenant called
    // "Riverside Home Medical" pays for two segments on every reminder,
    // which is exactly the kind of thing this page exists to surface.
    const longBrand = {
      ...BRAND,
      companyName: "Riverside Home Medical Equipment & Supply",
    };
    const initial = buildMessagePreviews(longBrand).find(
      (p) => p.id === "resupply.reminder.initial",
    );
    expect(initial?.sms?.encoding).toBe("GSM-7");
    expect(initial?.sms?.segments).toBeGreaterThan(1);
  });
});

describe("mirrored-copy drift guard", () => {
  const previews = buildMessagePreviews(BRAND);

  it("has a fingerprint for every mirrored scenario", () => {
    const mirrored = previews
      .filter((p) => p.fidelity === "mirrored")
      .map((p) => p.id);
    const fingerprinted = new Set(MIRRORED_FINGERPRINTS.map((f) => f.id));
    for (const id of mirrored) {
      expect(
        fingerprinted.has(id),
        `${id} is mirrored but has no fingerprint`,
      ).toBe(true);
    }
  });

  it("does not fingerprint scenarios that are exact", () => {
    const exact = new Set(
      previews.filter((p) => p.fidelity === "exact").map((p) => p.id),
    );
    for (const f of MIRRORED_FINGERPRINTS) {
      expect(
        exact.has(f.id),
        `${f.id} is exact — it needs no fingerprint`,
      ).toBe(false);
    }
  });

  it.each(MIRRORED_FINGERPRINTS)(
    "$id: production copy in $source still contains its fingerprint",
    ({ source, fingerprint }) => {
      const abs = path.join(REPO_ROOT, source);
      const src = readFileSync(abs, "utf8");
      expect(
        src.toLowerCase(),
        `"${fingerprint}" is gone from ${source} — the preview now advertises copy the code no longer sends. Update the catalog entry (or make it exact).`,
      ).toContain(fingerprint.toLowerCase());
    },
  );

  it("points every scenario at a source file that exists", () => {
    for (const p of previews) {
      const abs = path.join(REPO_ROOT, p.source);
      expect(
        () => readFileSync(abs, "utf8"),
        `${p.id} -> ${p.source}`,
      ).not.toThrow();
    }
  });
});

describe("exact scenarios call the production renderer", () => {
  it("renders the reminder email from the shared template module", async () => {
    const { renderResupplyReminder } =
      await import("@workspace/resupply-messaging");
    const expected = renderResupplyReminder({
      practiceName: BRAND.companyName,
      firstName: SAMPLE.firstName,
      items: SAMPLE.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      confirmUrl: `${BRAND.baseUrl}/r/c/demo-signed-token`,
      editUrl: `${BRAND.baseUrl}/r/e/demo-signed-token`,
      stopUrl: `${BRAND.baseUrl}/r/s/demo-signed-token`,
      variant: "initial",
    });
    const preview = findMessagePreview(BRAND, "resupply.reminder.initial");
    // Byte-for-byte: this is the whole point of an "exact" scenario.
    expect(preview?.email?.subject).toBe(expected.subject);
    expect(preview?.email?.html).toBe(expected.html);
    expect(preview?.email?.text).toBe(expected.text);
  });

  it("renders the reminder SMS from the shared reminders helper", async () => {
    const { defaultReminderSmsBody } =
      await import("@workspace/resupply-reminders");
    for (const variant of ["initial", "followup", "final"] as const) {
      const preview = findMessagePreview(BRAND, `resupply.reminder.${variant}`);
      expect(preview?.sms?.body).toBe(
        defaultReminderSmsBody(variant, SAMPLE.firstName, BRAND.companyName),
      );
    }
  });

  it("renders the video-visit invite from the extracted pure module", async () => {
    const { renderInviteEmailHtml, renderInviteEmailText } =
      await import("../video-visits/invite-email");
    const link = `${BRAND.baseUrl}/v/demo-signed-token`;
    const preview = findMessagePreview(BRAND, "clinical.video_visit");
    expect(preview?.email?.html).toBe(
      renderInviteEmailHtml(
        SAMPLE.firstName,
        BRAND.brandName,
        SAMPLE.appointmentAt,
        link,
      ),
    );
    expect(preview?.email?.text).toBe(
      renderInviteEmailText(
        SAMPLE.firstName,
        BRAND.brandName,
        SAMPLE.appointmentAt,
        link,
      ),
    );
  });
});

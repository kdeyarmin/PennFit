// Guards the rule that Penn Home Medical Supply's brand stays that
// tenant's data.
//
// "PennPaps" / "Penn Home Medical Supply" appear legitimately in this
// codebase as the in-source PLACEHOLDER that `identityReplacements()`
// rewrites to the requesting tenant's own values at the I/O boundary.
// That mechanism is fine. What is not fine — and what this file catches —
// is a Penn literal used as a *fallback*: `x ?? "Penn Home Medical
// Supply"`, or a platform default constant set to Penn's brand. Those do
// not get rewritten. They are what a brand-new tenant actually receives.
//
// Every pattern below corresponds to a real defect this suite was written
// after: an EDI submitter name that would have transmitted a second
// tenant's 837P claims under Penn's entity, provider-portal invites and
// signature certificates signed as Penn, and a first-admin welcome email
// signed by Penn on every new deployment.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ADMIN_ASSISTANT_NAME,
  DEFAULT_STOREFRONT_ASSISTANT_NAME,
  PLATFORM_NAME,
} from "./company-info";
import { DEFAULT_BRANDING } from "./tenant-branding";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Source trees a brand-new tenant's requests actually run through.
const ROOTS = [
  "artifacts/resupply-api/src",
  "lib/resupply-auth/src",
  "lib/resupply-email/src",
  "lib/resupply-messaging/src",
  "lib/resupply-reminders/src",
  "lib/resupply-templates/src",
  "scripts/src",
];

const PENN = String.raw`Penn ?Home ?Medical ?Supply|PennPaps|PENNPAPS|PennBot|PennPilot`;

// `?? "Penn…"`, `|| "Penn…"`, `: "Penn…"` in a default position — the
// shapes that hand a Penn literal to whoever asked, unrewritten.
const FALLBACK = new RegExp(String.raw`(\?\?|\|\|)\s*["'\`][^"'\`]*(${PENN})`);

// A `placeholder:` / `signatureName:` / `organizationName:`-style default
// whose value is a bare Penn literal.
const DEFAULT_FIELD = new RegExp(
  String.raw`(placeholder|signatureName|organizationName|practiceName|fromName|issuer)\s*:\s*["'\`](${PENN})`,
);

function walk(dir: string, prefix = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    // Specs may name Penn freely — including this one, which must.
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(rel);
  }
  return out;
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function scan(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const rel of walk(join(REPO_ROOT, root))) {
      const abs = join(REPO_ROOT, root, rel);
      readFileSync(abs, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (pattern.test(line)) {
            hits.push(`  ${root}/${rel}:${i + 1}  ${line.trim()}`);
          }
        });
    }
  }
  return hits;
}

describe("Penn tenant brand isolation", () => {
  it("uses no Penn literal as a fallback value", () => {
    const hits = scan(FALLBACK);
    expect(
      hits,
      'A `?? "Penn…"` / `|| "Penn…"` fallback hands one tenant\'s brand to ' +
        "whoever asked — applyCompanyIdentityToText never sees it. Resolve " +
        "the tenant's own value (getCompanyInfo(orgId) / " +
        `resolveBrandingByOrgId(orgId)), or fall back to the platform ` +
        `identity ("${PLATFORM_NAME}"):\n${hits.join("\n")}\n`,
    ).toEqual([]);
  });

  it("uses no Penn literal as a default field value", () => {
    const hits = scan(DEFAULT_FIELD);
    expect(
      hits,
      "A default/placeholder set to the Penn tenant's brand is shown to " +
        `every other tenant. Use the platform identity ("${PLATFORM_NAME}") ` +
        `or resolve per tenant:\n${hits.join("\n")}\n`,
    ).toEqual([]);
  });

  it("keeps the platform defaults tenant-neutral", () => {
    // If any of these ever reads "PennPaps", a brand-new tenant renders,
    // emails, and introduces itself as Penn Home Medical Supply.
    const platformDefaults = {
      PLATFORM_NAME,
      DEFAULT_STOREFRONT_ASSISTANT_NAME,
      DEFAULT_ADMIN_ASSISTANT_NAME,
      "DEFAULT_BRANDING.storefrontName": DEFAULT_BRANDING.storefrontName,
      "DEFAULT_BRANDING.legalName": DEFAULT_BRANDING.legalName,
      "DEFAULT_BRANDING.tagline": DEFAULT_BRANDING.tagline,
    };
    for (const [name, value] of Object.entries(platformDefaults)) {
      expect(value, `${name} must not carry a tenant's brand`).not.toMatch(
        /Penn/i,
      );
    }
    expect(PLATFORM_NAME).toBe("CareMetric Breathe");
  });
});

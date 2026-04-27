import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { episodes } from "@workspace/resupply-db";

type EpisodeInsertValue = PgInsertValue<typeof episodes>;

export interface EpisodeFixtureSpec {
  status:
    | "outreach_pending"
    | "awaiting_response"
    | "confirmed"
    | "declined"
    | "expired"
    | "fulfilled"
    | "canceled";
  dueAt: Date;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

export function makeEpisode(
  args: {
    patientId: string;
    prescriptionId: string;
  } & Partial<EpisodeFixtureSpec>,
): EpisodeInsertValue {
  const { patientId, prescriptionId, status, dueAt, expiresAt, metadata } =
    args;

  // Default to "due now" so eligibility-engine tests can pick the row up
  // without a clock helper. Tests that care about timing pass `dueAt`
  // explicitly.
  const resolvedDueAt = dueAt ?? new Date();

  return {
    patientId,
    prescriptionId,
    status: status ?? "outreach_pending",
    dueAt: resolvedDueAt,
    expiresAt:
      expiresAt === undefined
        ? new Date(resolvedDueAt.getTime() + 14 * 24 * 60 * 60 * 1000)
        : expiresAt,
    metadata: metadata ?? {
      attempts: 0,
      lastChannelTried: null,
      seed: faker.string.alphanumeric(6),
    },
  };
}

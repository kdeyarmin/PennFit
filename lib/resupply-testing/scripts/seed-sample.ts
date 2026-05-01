// Seed sample reminders and check-ins into the resupply schema.
//
// Inserts a curated set of patients (each tagged with a `seed-...`
// pacwareId) plus prescriptions, episodes, conversations, messages,
// and fulfillments arranged into operationally-recognizable scenarios:
//
//   1. Due now, no outreach yet                  (outreach_pending)
//   2. SMS reminder sent, awaiting reply         (awaiting_response)
//   3. Patient confirmed via SMS                 (confirmed + queued fulfillment)
//   4. Patient declined via SMS                  (declined)
//   5. Order shipped, full lifecycle complete    (fulfilled + delivered)
//   6. Voice check-in placed, follow-up needed   (voice channel, awaiting_admin)
//   7. Email reminder + patient reply            (email channel, awaiting_admin)
//   8. Patient paused — no outreach              (status=paused)
//   9. Reminder expired with no reply            (expired)
//  10. Multi-conversation: SMS thread closed,
//      admin opened a follow-up voice call    (two conversations on one episode)
//
// The script is idempotent: any prior `seed-*` patient (and via
// ON DELETE CASCADE everything below it — episodes, conversations,
// messages, fulfillments) is wiped before reseeding, so re-running
// the script produces the same end state instead of piling up
// duplicates.
//
// Why this script lives in `@workspace/resupply-testing` rather than
// inside the API or worker: the factories already live here, and the
// architecture check (Rule 5) forbids production code from importing
// this package, so keeping the seed beside the factories means we
// don't grow a parallel set of fixtures. The `scripts/` folder is
// outside `src/` so it isn't covered by the no-import rule.
//
// Run with:
//   pnpm --filter @workspace/resupply-testing run seed:sample
//
// Required env:
//   DATABASE_URL  — Postgres connection string

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  episodes,
  fulfillments,
  getDbPool,
  messages,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { makeConversation } from "../src/factories/conversation";
import { makeEpisode } from "../src/factories/episode";
import { makeFulfillment } from "../src/factories/fulfillment";
import { makeMessage } from "../src/factories/message";
import { makePatient } from "../src/factories/patient";
import { makePrescription } from "../src/factories/prescription";

const SEED_PREFIX = "seed-";

// Anchor "now" so re-runs produce timestamps that walk back from a
// stable point — operationally that means the inbox always shows
// "today / yesterday / 3 days ago" instead of slowly drifting.
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

interface SeedScenario {
  pacwareSlug: string;
  firstName: string;
  lastName: string;
  status: "active" | "paused" | "closed";
  phone: string | null;
  email: string | null;
  build: (ctx: ScenarioCtx) => Promise<void>;
}

interface ScenarioCtx {
  db: ReturnType<typeof drizzle>;
  patientId: string;
  scenario: SeedScenario;
}

const SCENARIOS: SeedScenario[] = [
  {
    // 1. Due now, nothing sent yet
    pacwareSlug: "anna-reyes",
    firstName: "Anna",
    lastName: "Reyes",
    status: "active",
    phone: "+12155550101",
    email: "anna.reyes@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "MASK-NASAL-MED",
            cadenceDays: 90,
          }),
        )
        .returning({ id: prescriptions.id });
      await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "outreach_pending",
            dueAt: NOW,
          }),
        );
    },
  },
  {
    // 2. SMS sent yesterday, no reply
    pacwareSlug: "brian-chen",
    firstName: "Brian",
    lastName: "Chen",
    status: "active",
    phone: "+12155550102",
    email: "brian.chen@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "TUBING-STD-6FT",
            cadenceDays: 30,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "awaiting_response",
            dueAt: days(2),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "awaiting_patient",
            lastMessageAt: days(1),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values(
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Brian, this is Penn Home Medical. You're due for new CPAP tubing. Reply YES to ship or STOP to pause reminders.",
          sentAt: days(1),
          deliveredAt: days(1),
        }),
      );
    },
  },
  {
    // 3. Patient confirmed -> fulfillment queued
    pacwareSlug: "carla-diaz",
    firstName: "Carla",
    lastName: "Diaz",
    status: "active",
    phone: "+12155550103",
    email: "carla.diaz@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "FILTER-DISP-PK6",
            cadenceDays: 60,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "confirmed",
            dueAt: days(3),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "closed",
            lastMessageAt: days(2),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Carla, you're due for replacement filters. Reply YES to ship a 6-pack.",
          sentAt: days(3),
          deliveredAt: days(3),
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "YES please",
          sentAt: days(2),
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Got it — your filters will ship within 1-2 business days. Tracking will follow by email.",
          sentAt: days(2),
          deliveredAt: days(2),
        }),
      ]);
      await db
        .insert(fulfillments)
        .values(
          makeFulfillment({
            patientId,
            episodeId: ep.id,
            itemSku: "FILTER-DISP-PK6",
            quantity: "1",
            status: "queued",
          }),
        );
    },
  },
  {
    // 4. Patient declined this cycle
    pacwareSlug: "dan-foster",
    firstName: "Dan",
    lastName: "Foster",
    status: "active",
    phone: "+12155550104",
    email: "dan.foster@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "MASK-FULL-LRG",
            cadenceDays: 90,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "declined",
            dueAt: days(5),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "closed",
            lastMessageAt: days(4),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Dan, time for a new full-face mask. Reply YES to ship or NO to skip this cycle.",
          sentAt: days(5),
          deliveredAt: days(5),
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "No thanks, my current mask is still good.",
          sentAt: days(4),
        }),
      ]);
    },
  },
  {
    // 5. Shipped & delivered — happy-path complete
    pacwareSlug: "edith-park",
    firstName: "Edith",
    lastName: "Park",
    status: "active",
    phone: "+12155550105",
    email: "edith.park@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "HUMIDIFIER-CHAMBER",
            cadenceDays: 180,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "fulfilled",
            dueAt: days(14),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "closed",
            lastMessageAt: days(13),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Edith, your humidifier chamber is due for replacement. Reply YES to ship.",
          sentAt: days(14),
          deliveredAt: days(14),
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "Yes ship it",
          sentAt: days(13),
        }),
      ]);
      await db
        .insert(fulfillments)
        .values(
          makeFulfillment({
            patientId,
            episodeId: ep.id,
            itemSku: "HUMIDIFIER-CHAMBER",
            quantity: "1",
            status: "delivered",
            submittedAt: days(13),
            shippedAt: days(11),
            deliveredAt: days(7),
          }),
        );
    },
  },
  {
    // 6. Voice check-in placed, admin follow-up needed
    pacwareSlug: "felipe-rocha",
    firstName: "Felipe",
    lastName: "Rocha",
    status: "active",
    phone: "+12155550106",
    email: "felipe.rocha@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "MASK-NASAL-MED",
            cadenceDays: 90,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "awaiting_response",
            dueAt: days(1),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "voice",
            status: "awaiting_admin",
            lastMessageAt: NOW,
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "system",
          body: "[Voice call placed at +12155550106 — duration 1m42s]",
          sentAt: NOW,
          deliveredAt: NOW,
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "Patient asked to verify mask sizing before reordering — please call back.",
          sentAt: NOW,
        }),
      ]);
    },
  },
  {
    // 7. Email reminder + patient reply, admin follow-up
    pacwareSlug: "gina-sato",
    firstName: "Gina",
    lastName: "Sato",
    status: "active",
    // Email-only patient (no phone on file).
    phone: null,
    email: "gina.sato@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "TUBING-STD-6FT",
            cadenceDays: 30,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "awaiting_response",
            dueAt: days(2),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "email",
            status: "awaiting_admin",
            lastMessageAt: days(1),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Subject: Time for new CPAP tubing\n\nHi Gina, your tubing is due for replacement. Click YES to confirm shipment, or REPLY with questions.",
          sentAt: days(2),
          deliveredAt: days(2),
        }),
        makeMessage({
          conversationId: conv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "Can I switch to heated tubing this time? Insurance changed in March.",
          sentAt: days(1),
        }),
      ]);
    },
  },
  {
    // 8. Paused patient — no outreach
    pacwareSlug: "henry-tate",
    firstName: "Henry",
    lastName: "Tate",
    status: "paused",
    phone: "+12155550108",
    email: "henry.tate@example.com",
    async build({ db, patientId }) {
      await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "MASK-NASAL-MED",
            cadenceDays: 90,
          }),
        );
      // Intentionally no episode — paused patients are excluded from
      // the eligibility scan, so the inbox should remain empty.
    },
  },
  {
    // 9. Reminder expired with no reply
    pacwareSlug: "iris-underwood",
    firstName: "Iris",
    lastName: "Underwood",
    status: "active",
    phone: "+12155550109",
    email: "iris.underwood@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "FILTER-DISP-PK6",
            cadenceDays: 60,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "expired",
            dueAt: days(20),
            expiresAt: days(6),
          }),
        )
        .returning({ id: episodes.id });
      const [conv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "closed",
            lastMessageAt: days(20),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values(
        makeMessage({
          conversationId: conv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Iris, you're due for new filters. Reply YES to ship.",
          sentAt: days(20),
          deliveredAt: days(20),
        }),
      );
    },
  },
  {
    // 10. Multi-conversation: SMS thread closed, voice follow-up
    //     opened on the same episode
    pacwareSlug: "jorge-vargas",
    firstName: "Jorge",
    lastName: "Vargas",
    status: "active",
    phone: "+12155550110",
    email: "jorge.vargas@example.com",
    async build({ db, patientId }) {
      const [rx] = await db
        .insert(prescriptions)
        .values(
          makePrescription({
            patientId,
            itemSku: "MASK-FULL-LRG",
            cadenceDays: 90,
          }),
        )
        .returning({ id: prescriptions.id });
      const [ep] = await db
        .insert(episodes)
        .values(
          makeEpisode({
            patientId,
            prescriptionId: rx.id,
            status: "awaiting_response",
            dueAt: days(8),
          }),
        )
        .returning({ id: episodes.id });
      const [smsConv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "sms",
            status: "closed",
            lastMessageAt: days(7),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values([
        makeMessage({
          conversationId: smsConv.id,
          direction: "outbound",
          senderRole: "agent",
          body: "Hi Jorge, time for a new full-face mask. Reply YES to ship.",
          sentAt: days(8),
          deliveredAt: days(8),
        }),
        makeMessage({
          conversationId: smsConv.id,
          direction: "inbound",
          senderRole: "patient",
          body: "Call me, I have questions",
          sentAt: days(7),
        }),
      ]);
      const [voiceConv] = await db
        .insert(conversations)
        .values(
          makeConversation({
            patientId,
            episodeId: ep.id,
            channel: "voice",
            status: "awaiting_admin",
            lastMessageAt: days(1),
          }),
        )
        .returning({ id: conversations.id });
      await db.insert(messages).values(
        makeMessage({
          conversationId: voiceConv.id,
          direction: "outbound",
          senderRole: "admin",
          body: "[Admin-initiated voice call queued — pending dial]",
          sentAt: days(1),
          deliveredAt: days(1),
        }),
      );
    },
  },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }

  const pool = getDbPool();
  const db = drizzle(pool);

  // Wipe prior seed data. ON DELETE CASCADE on every child table
  // (prescriptions, episodes, conversations, messages, fulfillments)
  // means deleting the patient rows is sufficient. The inbound-SMS
  // routing path now resolves the From number directly against
  // `patients.phone_e164` (indexed btree), so no phone_lookup
  // bookkeeping is needed.
  const deleted = await db
    .delete(patients)
    .where(sql`${patients.pacwareId} like ${SEED_PREFIX + "%"}`)
    .returning({ id: patients.id });
  if (deleted.length > 0) {
    console.log(`Cleared ${deleted.length} prior seed patients (cascaded).`);
  }

  for (const scenario of SCENARIOS) {
    const [patient] = await db
      .insert(patients)
      .values(
        makePatient({
          pacwareId: `${SEED_PREFIX}${scenario.pacwareSlug}`,
          legalFirstName: scenario.firstName,
          legalLastName: scenario.lastName,
          phoneE164: scenario.phone,
          email: scenario.email,
          status: scenario.status,
        }),
      )
      .returning({ id: patients.id });

    await scenario.build({ db, patientId: patient.id, scenario });

    console.log(
      `  ${scenario.pacwareSlug.padEnd(18)} ${scenario.status.padEnd(7)} ${scenario.firstName} ${scenario.lastName}`,
    );
  }

  console.log(
    `\nSeeded ${SCENARIOS.length} sample patients with reminders and check-ins.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

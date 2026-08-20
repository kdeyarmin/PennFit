// Demo-tenant dataset — the fictional people, prescribers and inbox
// threads that `demo:seed` writes, plus the deterministic id scheme that
// makes every write idempotent.
//
// Split out from `seed-demo-tenant.ts` so it can be imported and asserted
// on without running the seeder. The seeder has module-level side effects
// (argument parsing, the write guard, `main()`); this module has NONE, so
// `seed-demo-tenant.data.test.ts` can hold the safety invariants — chiefly
// that no demo patient is ever close enough to their cadence for the
// reminder worker to try to message them.
//
// See `seed-demo-tenant.ts` for the full rationale on why these people
// look real but cannot be reached.

// ── Deterministic ids ────────────────────────────────────────────────
//
// Every demo row is a valid v4-shaped UUID whose first group is the
// literal `0dec0de0`. That makes a demo row identifiable at a glance in
// psql, makes every write an idempotent upsert, and gives `--clean` an
// exact key set to delete rather than a heuristic.

export const DEMO_UUID_PREFIX = "0dec0de0";
export type Kind =
  | "provider"
  | "patient"
  | "rx"
  | "episode"
  | "coverage"
  | "equipment"
  | "fulfillment"
  | "note"
  | "conversation"
  | "message";
export const KIND_GROUP: Record<Kind, string> = {
  provider: "0001",
  patient: "0002",
  rx: "0003",
  episode: "0004",
  coverage: "0005",
  equipment: "0006",
  fulfillment: "0007",
  note: "0008",
  conversation: "0009",
  message: "000a",
};
export function id(kind: Kind, n: number): string {
  const tail = n.toString(16).padStart(12, "0");
  return `${DEMO_UUID_PREFIX}-${KIND_GROUP[kind]}-4000-8000-${tail}`;
}

// ── The dataset ──────────────────────────────────────────────────────
//
// These people are fictional, but they are deliberately NOT labelled
// "(test)" the way seed:sample's rows are. This tenant gets screen-shared
// to prospects, and a console full of "Test Patient 1" undersells the
// product. What keeps it honest instead is the contact information:
// every number is +1 (215) 555-01XX — the range reserved for fiction —
// and every address is on example.com, which RFC 2606 guarantees can
// never be registered. Nothing here can reach a human being.

export interface DemoProvider {
  n: number;
  npi: string;
  legalName: string;
  practiceName: string;
  taxonomyCode: string;
  phone: string;
  fax: string;
  email: string;
  city: string;
  state: string;
  postal: string;
  line1: string;
}

// NPIs are 10 digits (DB CHECK). Real NPPES numbers begin with 1 or 2, so
// the 999… block used here cannot collide with a live provider record.
// NOTE: resupply.providers is a GLOBAL directory — it has no org_id (see
// migration 0342), so these rows are visible to every tenant's provider
// lookup. That is why they are so plainly synthetic, and why --clean
// removes them by NPI.
export const PROVIDERS: DemoProvider[] = [
  {
    n: 1,
    npi: "9990000017",
    legalName: "Marcus Whitfield, MD",
    practiceName: "Delaware Valley Sleep Medicine",
    taxonomyCode: "2085S0010X",
    phone: "+12155550101",
    fax: "+12155550102",
    email: "referrals@example.com",
    line1: "1200 Market Street, Suite 400",
    city: "Philadelphia",
    state: "PA",
    postal: "19107",
  },
  {
    n: 2,
    npi: "9990000025",
    legalName: "Priya Raghunathan, MD",
    practiceName: "Keystone Pulmonary & Critical Care",
    taxonomyCode: "207RP1001X",
    phone: "+12155550103",
    fax: "+12155550104",
    email: "orders@example.com",
    line1: "45 North Broad Street",
    city: "Philadelphia",
    state: "PA",
    postal: "19102",
  },
  {
    n: 3,
    npi: "9990000033",
    legalName: "Daniel Okonkwo, DO",
    practiceName: "Bucks County Family Medicine",
    taxonomyCode: "207Q00000X",
    phone: "+12155550105",
    fax: "+12155550106",
    email: "frontdesk@example.com",
    line1: "880 Easton Road",
    city: "Doylestown",
    state: "PA",
    postal: "18901",
  },
  {
    n: 4,
    npi: "9990000041",
    legalName: "Helen Vasquez, CRNP",
    practiceName: "Main Line Sleep Associates",
    taxonomyCode: "363LA2200X",
    phone: "+12155550107",
    fax: "+12155550108",
    email: "clinical@example.com",
    line1: "610 Lancaster Avenue",
    city: "Bryn Mawr",
    state: "PA",
    postal: "19010",
  },
  {
    n: 5,
    npi: "9990000058",
    legalName: "Samuel Greenberg, MD",
    practiceName: "Jefferson Neurology & Sleep",
    taxonomyCode: "2084S0012X",
    phone: "+12155550109",
    fax: "+12155550110",
    email: "sleeplab@example.com",
    line1: "909 Walnut Street, 3rd Floor",
    city: "Philadelphia",
    state: "PA",
    postal: "19107",
  },
  {
    n: 6,
    npi: "9990000066",
    legalName: "Aisha Bennett, MD",
    practiceName: "Lehigh Valley Respiratory Group",
    taxonomyCode: "207RP1001X",
    phone: "+12155550111",
    fax: "+12155550112",
    email: "intake@example.com",
    line1: "1250 Cedar Crest Boulevard",
    city: "Allentown",
    state: "PA",
    postal: "18103",
  },
];

export type EpisodeStatus =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed"
  | "fulfilled";

export interface DemoPatient {
  n: number;
  first: string;
  last: string;
  dob: string;
  phone: string;
  email: string;
  line1: string;
  city: string;
  state: string;
  postal: string;
  timezone: string;
  payer: string;
  planName: string;
  memberId: string;
  groupNumber: string;
  copayCents: number;
  deductibleCents: number;
  deductibleMetCents: number;
  providerN: number;
  itemSku: string;
  hcpcs: string;
  cadenceDays: number;
  channelPreference: "sms" | "email" | "voice";
  device: {
    deviceClass: "cpap" | "auto_cpap" | "bipap";
    manufacturer: string;
    model: string;
    serial: string;
    pressure: string;
    humidifier: string;
  };
  // Days since the last shipment went out. Drives the reminder baseline —
  // keep it well under cadenceDays for anyone in a live funnel status.
  lastFulfilledDaysAgo: number;
  episodeStatus: EpisodeStatus;
  episodeDueInDays: number;
  note: string | null;
}

export const PATIENTS: DemoPatient[] = [
  {
    n: 1,
    first: "Robert",
    last: "Delgado",
    dob: "1958-03-14",
    phone: "+12155550120",
    email: "robert.delgado@example.com",
    line1: "418 Pine Street",
    city: "Philadelphia",
    state: "PA",
    postal: "19106",
    timezone: "America/New_York",
    payer: "Medicare Part B",
    planName: "Traditional Medicare",
    memberId: "1EG4TE5MK73",
    groupNumber: "—",
    copayCents: 0,
    deductibleCents: 24000,
    deductibleMetCents: 24000,
    providerN: 1,
    itemSku: "MASK-F20-M",
    hcpcs: "A7030",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 11 AutoSet",
      serial: "DEMO-2311-0001",
      pressure: "7–14 cmH2O",
      humidifier: "3",
    },
    lastFulfilledDaysAgo: 12,
    episodeStatus: "awaiting_response",
    episodeDueInDays: 6,
    note: "Prefers texts after 5pm — works day shift at the Navy Yard. Reports mask fits well since switching to the F20 medium.",
  },
  {
    n: 2,
    first: "Angela",
    last: "Foster",
    dob: "1971-11-02",
    phone: "+12155550121",
    email: "angela.foster@example.com",
    line1: "77 Sycamore Lane",
    city: "Media",
    state: "PA",
    postal: "19063",
    timezone: "America/New_York",
    payer: "Independence Blue Cross",
    planName: "Keystone HMO Gold",
    memberId: "QHB884120977",
    groupNumber: "10044821",
    copayCents: 2500,
    deductibleCents: 150000,
    deductibleMetCents: 91000,
    providerN: 2,
    itemSku: "MASK-P10-S",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "email",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 10 AutoSet",
      serial: "DEMO-2208-0042",
      pressure: "6–12 cmH2O",
      humidifier: "Auto",
    },
    lastFulfilledDaysAgo: 34,
    episodeStatus: "confirmed",
    episodeDueInDays: 3,
    note: "Asked about the travel CPAP for a trip in the spring. Follow up in March.",
  },
  {
    n: 3,
    first: "James",
    last: "Whitaker",
    dob: "1949-06-27",
    phone: "+12155550122",
    email: "james.whitaker@example.com",
    line1: "2201 Chestnut Street, Apt 9B",
    city: "Philadelphia",
    state: "PA",
    postal: "19103",
    timezone: "America/New_York",
    payer: "Medicare Part B",
    planName: "Traditional Medicare",
    memberId: "3XQ9RW2TP48",
    groupNumber: "—",
    copayCents: 0,
    deductibleCents: 24000,
    deductibleMetCents: 24000,
    providerN: 5,
    itemSku: "MASK-N30I-M",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "voice",
    device: {
      deviceClass: "bipap",
      manufacturer: "Philips Respironics",
      model: "DreamStation 2 BiPAP",
      serial: "DEMO-2104-0117",
      pressure: "16/11 cmH2O",
      humidifier: "2",
    },
    lastFulfilledDaysAgo: 21,
    episodeStatus: "fulfilled",
    episodeDueInDays: -8,
    note: "Hard of hearing — call the daughter (listed as authorized contact) rather than the mobile.",
  },
  {
    n: 4,
    first: "Denise",
    last: "Carmichael",
    dob: "1965-09-19",
    phone: "+12155550123",
    email: "denise.carmichael@example.com",
    line1: "915 Highland Avenue",
    city: "Abington",
    state: "PA",
    postal: "19001",
    timezone: "America/New_York",
    payer: "Aetna",
    planName: "Choice POS II",
    memberId: "W227410883",
    groupNumber: "0871133",
    copayCents: 4000,
    deductibleCents: 200000,
    deductibleMetCents: 200000,
    providerN: 4,
    itemSku: "MASK-F30I-L",
    hcpcs: "A7030",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 11 AutoSet",
      serial: "DEMO-2312-0088",
      pressure: "8–16 cmH2O",
      humidifier: "4",
    },
    lastFulfilledDaysAgo: 45,
    episodeStatus: "confirmed",
    episodeDueInDays: 1,
    note: null,
  },
  {
    n: 5,
    first: "Thomas",
    last: "Nakamura",
    dob: "1982-01-30",
    phone: "+12155550124",
    email: "thomas.nakamura@example.com",
    line1: "60 Ridge Pike",
    city: "Conshohocken",
    state: "PA",
    postal: "19428",
    timezone: "America/New_York",
    payer: "UnitedHealthcare",
    planName: "Choice Plus PPO",
    memberId: "UHC55810277",
    groupNumber: "744120",
    copayCents: 3000,
    deductibleCents: 300000,
    deductibleMetCents: 42000,
    providerN: 3,
    itemSku: "MASK-P30I-M",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "email",
    device: {
      deviceClass: "cpap",
      manufacturer: "React Health",
      model: "Luna G3",
      serial: "DEMO-2401-0203",
      pressure: "10 cmH2O",
      humidifier: "3",
    },
    lastFulfilledDaysAgo: 8,
    episodeStatus: "outreach_pending",
    episodeDueInDays: 9,
    note: "New setup — first resupply cycle. Compliance at 94% in the first 30 days.",
  },
  {
    n: 6,
    first: "Yolanda",
    last: "Pierce",
    dob: "1954-04-08",
    phone: "+12155550125",
    email: "yolanda.pierce@example.com",
    line1: "3300 Germantown Avenue",
    city: "Philadelphia",
    state: "PA",
    postal: "19140",
    timezone: "America/New_York",
    payer: "Medicare Advantage (Humana)",
    planName: "HumanaChoice PPO",
    memberId: "H55120987A",
    groupNumber: "PA0041",
    copayCents: 1500,
    deductibleCents: 0,
    deductibleMetCents: 0,
    providerN: 1,
    itemSku: "MASK-F20-L",
    hcpcs: "A7030",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 10 AutoSet",
      serial: "DEMO-2205-0311",
      pressure: "9–15 cmH2O",
      humidifier: "3",
    },
    lastFulfilledDaysAgo: 62,
    episodeStatus: "fulfilled",
    episodeDueInDays: -14,
    note: "Cushion replaced twice last cycle — check sizing at next fitting.",
  },
  {
    n: 7,
    first: "Victor",
    last: "Ramirez",
    dob: "1976-12-11",
    phone: "+12155550126",
    email: "victor.ramirez@example.com",
    line1: "144 South 6th Street",
    city: "Reading",
    state: "PA",
    postal: "19602",
    timezone: "America/New_York",
    payer: "Highmark Blue Shield",
    planName: "PPO Blue",
    memberId: "HMK9920475",
    groupNumber: "22087",
    copayCents: 2000,
    deductibleCents: 100000,
    deductibleMetCents: 100000,
    providerN: 6,
    itemSku: "MASK-N20-M",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 11 AutoSet",
      serial: "DEMO-2309-0455",
      pressure: "7–13 cmH2O",
      humidifier: "2",
    },
    lastFulfilledDaysAgo: 27,
    episodeStatus: "confirmed",
    episodeDueInDays: 4,
    note: null,
  },
  {
    n: 8,
    first: "Margaret",
    last: "O'Sullivan",
    dob: "1943-08-22",
    phone: "+12155550127",
    email: "margaret.osullivan@example.com",
    line1: "12 Willow Grove Road",
    city: "Jenkintown",
    state: "PA",
    postal: "19046",
    timezone: "America/New_York",
    payer: "Medicare Part B",
    planName: "Traditional Medicare",
    memberId: "8KT2QM9YR51",
    groupNumber: "—",
    copayCents: 0,
    deductibleCents: 24000,
    deductibleMetCents: 18000,
    providerN: 5,
    itemSku: "MASK-N30I-S",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "voice",
    device: {
      deviceClass: "cpap",
      manufacturer: "Philips Respironics",
      model: "DreamStation 2",
      serial: "DEMO-2110-0522",
      pressure: "11 cmH2O",
      humidifier: "5",
    },
    lastFulfilledDaysAgo: 38,
    episodeStatus: "fulfilled",
    episodeDueInDays: -20,
    note: "Lives alone; prefers a phone call and a mailed statement.",
  },
  {
    n: 9,
    first: "Andre",
    last: "Baptiste",
    dob: "1988-05-05",
    phone: "+12155550128",
    email: "andre.baptiste@example.com",
    line1: "501 North Front Street",
    city: "Philadelphia",
    state: "PA",
    postal: "19123",
    timezone: "America/New_York",
    payer: "Cigna",
    planName: "Open Access Plus",
    memberId: "CG7741209",
    groupNumber: "3300712",
    copayCents: 3500,
    deductibleCents: 250000,
    deductibleMetCents: 0,
    providerN: 2,
    itemSku: "MASK-P10-M",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "email",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirMini AutoSet",
      serial: "DEMO-2403-0610",
      pressure: "6–11 cmH2O",
      humidifier: "N/A (waterless)",
    },
    lastFulfilledDaysAgo: 15,
    episodeStatus: "confirmed",
    episodeDueInDays: 7,
    note: "Travels for work most weeks — AirMini setup, ships to the home address only.",
  },
  {
    n: 10,
    first: "Susan",
    last: "Kowalski",
    dob: "1961-02-16",
    phone: "+12155550129",
    email: "susan.kowalski@example.com",
    line1: "88 Bethlehem Pike",
    city: "Colmar",
    state: "PA",
    postal: "18915",
    timezone: "America/New_York",
    payer: "Independence Blue Cross",
    planName: "Personal Choice PPO",
    memberId: "QHB552018844",
    groupNumber: "10055290",
    copayCents: 2500,
    deductibleCents: 175000,
    deductibleMetCents: 175000,
    providerN: 4,
    itemSku: "MASK-F30-M",
    hcpcs: "A7030",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 11 AutoSet",
      serial: "DEMO-2307-0733",
      pressure: "8–14 cmH2O",
      humidifier: "3",
    },
    lastFulfilledDaysAgo: 51,
    episodeStatus: "fulfilled",
    episodeDueInDays: -5,
    note: null,
  },
  {
    n: 11,
    first: "Elijah",
    last: "Freeman",
    dob: "1969-07-24",
    phone: "+12155550130",
    email: "elijah.freeman@example.com",
    line1: "2740 West Girard Avenue",
    city: "Philadelphia",
    state: "PA",
    postal: "19130",
    timezone: "America/New_York",
    payer: "Medicaid (PA Health & Wellness)",
    planName: "Community HealthChoices",
    memberId: "PA88120044",
    groupNumber: "CHC01",
    copayCents: 0,
    deductibleCents: 0,
    deductibleMetCents: 0,
    providerN: 3,
    itemSku: "MASK-N20-L",
    hcpcs: "A7034",
    cadenceDays: 90,
    channelPreference: "sms",
    device: {
      deviceClass: "cpap",
      manufacturer: "React Health",
      model: "Luna G3",
      serial: "DEMO-2402-0841",
      pressure: "9 cmH2O",
      humidifier: "4",
    },
    lastFulfilledDaysAgo: 19,
    episodeStatus: "confirmed",
    episodeDueInDays: 11,
    note: "Prior auth on file through the end of the plan year.",
  },
  {
    n: 12,
    first: "Carol",
    last: "Lindqvist",
    dob: "1957-10-03",
    phone: "+12155550131",
    email: "carol.lindqvist@example.com",
    line1: "19 Old Lancaster Road",
    city: "Devon",
    state: "PA",
    postal: "19333",
    timezone: "America/New_York",
    payer: "Aetna",
    planName: "Medicare Advantage HMO",
    memberId: "W881204471",
    groupNumber: "0899210",
    copayCents: 1000,
    deductibleCents: 0,
    deductibleMetCents: 0,
    providerN: 6,
    itemSku: "MASK-F20-S",
    hcpcs: "A7030",
    cadenceDays: 90,
    channelPreference: "email",
    device: {
      deviceClass: "auto_cpap",
      manufacturer: "ResMed",
      model: "AirSense 10 AutoSet",
      serial: "DEMO-2206-0954",
      pressure: "7–12 cmH2O",
      humidifier: "Auto",
    },
    lastFulfilledDaysAgo: 41,
    episodeStatus: "fulfilled",
    episodeDueInDays: -11,
    note: "Downsized to the small cushion in June; leak resolved.",
  },
];

// Inbox threads. `conversations_subject_xor_check` requires a patient
// thread to carry BOTH patient_id and episode_id (and no customer_id),
// so each of these hangs off that patient's episode.
export interface DemoThread {
  n: number;
  patientN: number;
  channel: "sms" | "email";
  status: "awaiting_admin" | "awaiting_patient" | "resolved";
  priority: "low" | "normal" | "high";
  lastMessageDaysAgo: number;
  messages: Array<{
    n: number;
    direction: "inbound" | "outbound";
    senderRole: "patient" | "admin" | "system";
    body: string;
    daysAgo: number;
  }>;
}

export const THREADS: DemoThread[] = [
  {
    n: 1,
    patientN: 1,
    channel: "sms",
    status: "awaiting_admin",
    priority: "high",
    lastMessageDaysAgo: 0,
    messages: [
      {
        n: 1,
        direction: "outbound",
        senderRole: "system",
        body: "Hi Robert — it's time to reorder your CPAP supplies. Reply YES to ship your usual mask cushion and filters, or STOP to opt out.",
        daysAgo: 2,
      },
      {
        n: 2,
        direction: "inbound",
        senderRole: "patient",
        body: "Yes please. Can you also add a new headgear? Mine is stretched out.",
        daysAgo: 1,
      },
      {
        n: 3,
        direction: "outbound",
        senderRole: "admin",
        body: "Absolutely — I've added headgear to this shipment. It should go out tomorrow.",
        daysAgo: 1,
      },
      {
        n: 4,
        direction: "inbound",
        senderRole: "patient",
        body: "Thank you! One more thing — does insurance cover a second cushion this cycle?",
        daysAgo: 0,
      },
    ],
  },
  {
    n: 2,
    patientN: 5,
    channel: "email",
    status: "awaiting_patient",
    priority: "normal",
    lastMessageDaysAgo: 1,
    messages: [
      {
        n: 1,
        direction: "inbound",
        senderRole: "patient",
        body: "My machine has been making a rattling noise for the last few nights. Is that something I should be worried about?",
        daysAgo: 3,
      },
      {
        n: 2,
        direction: "outbound",
        senderRole: "admin",
        body: "Thanks for flagging that, Thomas. A rattle is usually the humidifier chamber not seated fully. Could you pop it out and click it back in, then let me know if the noise persists? If it does, we'll arrange a swap under warranty.",
        daysAgo: 1,
      },
    ],
  },
  {
    n: 3,
    patientN: 8,
    channel: "sms",
    status: "resolved",
    priority: "normal",
    lastMessageDaysAgo: 9,
    messages: [
      {
        n: 1,
        direction: "outbound",
        senderRole: "system",
        body: "Hi Margaret — your CPAP resupply is ready. Reply YES to confirm shipping to 12 Willow Grove Road.",
        daysAgo: 11,
      },
      {
        n: 2,
        direction: "inbound",
        senderRole: "patient",
        body: "YES",
        daysAgo: 10,
      },
      {
        n: 3,
        direction: "outbound",
        senderRole: "system",
        body: "Confirmed — your order shipped today and should arrive in 3–5 business days. Tracking: DEMO1Z9994412.",
        daysAgo: 9,
      },
    ],
  },
];

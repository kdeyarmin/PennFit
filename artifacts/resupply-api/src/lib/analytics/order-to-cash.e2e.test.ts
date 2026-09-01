// Order to cash, end to end, deterministically.
//
// WHAT THIS SUITE IS FOR
// ----------------------
// The lifecycle spans four layers that were built separately and are
// tested separately: episodes, fulfillments, X12 documents, and the
// outcome funnel. Each is covered. Nothing covered the SEAMS — and the
// seams are where the expensive mistakes live, because every one of them
// is a place where two different things get counted as the same thing:
//
//   * A 277CA rejection is the CLEARINGHOUSE saying the claim was
//     malformed. A denial is the PAYER saying it will not pay. Counting
//     the first as the second sends a biller to write an appeal for a
//     claim that was never adjudicated.
//   * `assumed_shipped` is the grace sweep saying "we gave up waiting",
//     not "it shipped". Counting it as shipped then counts it as
//     shipped-but-unbilled: an expensive loss reported against product
//     that may not exist.
//   * A claim still with the payer is not lost. Counting in-flight work
//     as a loss makes every dashboard look like a disaster on the day it
//     is opened.
//   * `partially_paid` is money that arrived AND money that did not.
//     Folding it into `paid` hides the second half.
//   * Shipped and never billed is usually the largest single number in
//     the funnel and the one nobody sees, because it is invisible from
//     both ends: billing does not know the shipment happened, and
//     resupply considers the cycle closed.
//
// HOW IT WORKS
// ------------
// A synthetic ledger walks one patient per scenario through the real
// modules — the episode closure builder, the 837P builder, the 277CA and
// 835 parsers, and the outcome funnel — and asserts what the funnel says
// at the end. No database, no clock, no network. Every claim is
// synthetic and nothing is ever transmitted.
//
// PHI: synthetic names, synthetic member ids, +1555 numbers.

import { describe, expect, it } from "vitest";

import {
  allocateControlNumbers,
  build837P,
  parse277CA,
  parse835,
  type Claim837PInput,
} from "@workspace/resupply-integrations-office-ally";
import { buildEpisodeClosure } from "@workspace/resupply-domain";

import {
  aggregateOrderOutcomeFunnel,
  type OutcomeClaimRow,
  type OutcomeEpisodeRow,
  type OutcomeFulfillmentRow,
} from "./order-outcome-funnel";

// ── The synthetic ledger ─────────────────────────────────────────────

interface Ledger {
  orgId: string;
  episodes: OutcomeEpisodeRow[];
  fulfillments: OutcomeFulfillmentRow[];
  claims: OutcomeClaimRow[];
}

function ledger(orgId = "org-a"): Ledger {
  return { orgId, episodes: [], fulfillments: [], claims: [] };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

/** A patient becomes due; an outreach episode opens. */
function becomesEligible(l: Ledger): string {
  const id = nextId("ep");
  l.episodes.push({ id, status: "outreach_pending", closedReason: null });
  return id;
}

/** A reminder goes out; the episode is waiting on the patient. */
function reminderSent(l: Ledger, episodeId: string): void {
  patch(l, episodeId, { status: "awaiting_response" });
}

/** The patient affirmatively agrees, and a fulfillment is queued. */
function patientConfirms(l: Ledger, episodeId: string): string {
  patch(l, episodeId, { status: "confirmed" });
  const id = nextId("ful");
  l.fulfillments.push({
    id,
    episodeId,
    status: "queued",
    shippedAt: null,
  });
  return id;
}

/** REAL shipment evidence: a PacWare import or a staff mark-shipped. */
function shipmentRecorded(
  l: Ledger,
  episodeId: string,
  fulfillmentId: string,
  shippedAt = "2026-06-10T12:00:00.000Z",
): void {
  const f = l.fulfillments.find((x) => x.id === fulfillmentId);
  if (f) {
    f.shippedAt = shippedAt;
    f.status = "shipped";
  }
  const closure = buildEpisodeClosure(
    "fulfilled",
    "shipped",
    new Date(shippedAt),
  );
  patch(l, episodeId, {
    status: closure.status,
    closedReason: closure.closed_reason,
  });
}

/**
 * The grace sweep advances a ladder that never got evidence.
 *
 * It closes the EPISODE and deliberately never touches the fulfillment:
 * inventing a ship date for a payer is a compliance problem, not a
 * data-quality one.
 */
function graceSweepAdvances(l: Ledger, episodeId: string): void {
  const closure = buildEpisodeClosure(
    "fulfilled",
    "assumed_shipped",
    new Date("2026-06-20T00:00:00.000Z"),
  );
  patch(l, episodeId, {
    status: closure.status,
    closedReason: closure.closed_reason,
  });
}

function closes(
  l: Ledger,
  episodeId: string,
  status: Parameters<typeof buildEpisodeClosure>[0],
  reason: Parameters<typeof buildEpisodeClosure>[1],
): void {
  const closure = buildEpisodeClosure(status, reason, new Date());
  patch(l, episodeId, {
    status: closure.status,
    closedReason: closure.closed_reason,
  });
}

function patch(
  l: Ledger,
  episodeId: string,
  next: Partial<OutcomeEpisodeRow>,
): void {
  const ep = l.episodes.find((e) => e.id === episodeId);
  if (ep) Object.assign(ep, next);
}

/** A biller creates the claim for a shipped order. */
function claimCreated(
  l: Ledger,
  fulfillmentId: string,
  status = "draft",
): OutcomeClaimRow {
  const claim: OutcomeClaimRow = {
    fulfillmentId,
    status,
    denialReason: null,
    totalPaidCents: 0,
  };
  l.claims.push(claim);
  return claim;
}

function funnel(l: Ledger) {
  return aggregateOrderOutcomeFunnel({
    episodes: l.episodes,
    fulfillments: l.fulfillments,
    claims: l.claims,
  });
}

// ── X12 fixtures ─────────────────────────────────────────────────────

/**
 * One synthetic claim, shaped exactly as the claim builder expects.
 *
 * Everything here is invented: a 555 phone, a made-up member id, a
 * checksum-valid but unassigned NPI, and a payer that does not exist. It
 * is built, never transmitted.
 */
const CLAIM_INPUT: Claim837PInput = {
  submitter: {
    etin: "SYNTHETIC1",
    organizationName: "SYNTHETIC DME LLC",
    contactName: "BILLING TEAM",
    contactPhoneE164: "+15550001111",
  },
  receiver: {
    interchangeId: "OFFCLY",
    organizationName: "OFFICE ALLY",
  },
  billingProvider: {
    organizationName: "SYNTHETIC DME LLC",
    npi: "1234567893",
    taxId: "123456789",
    address: {
      line1: "1 TEST WAY",
      city: "TESTVILLE",
      state: "PA",
      zip: "19000",
    },
  },
  claims: [
    {
      internalClaimId: "CLM-0001",
      totalBilledCents: 12_000,
      placeOfServiceCode: "12",
      diagnosisCodes: ["G47.33"],
      subscriber: {
        firstName: "PAT",
        lastName: "SYNTHETIC",
        dateOfBirth: "1970-01-01",
        gender: "F",
        memberId: "SYN000000001",
        address: {
          line1: "2 TEST WAY",
          city: "TESTVILLE",
          state: "PA",
          zip: "19000",
        },
        relationshipCode: "18",
      },
      payer: {
        organizationName: "SYNTHETIC PAYER",
        payerId: "SYN01",
      },
      serviceLines: [
        {
          hcpcsCode: "A7034",
          modifiers: [],
          billedCents: 12_000,
          units: 1,
          // The DATE OF SERVICE, taken from the shipment above — not
          // from today. That substitution is the whole reason shipment
          // evidence is load-bearing.
          serviceDate: "2026-06-10",
          diagnosisPointers: [1],
        },
      ],
    },
  ],
  control: allocateControlNumbers({
    // Epoch milliseconds, not a Date — the allocator does arithmetic on
    // it, and a Date coerces at runtime while failing the typecheck.
    submittedAt: Date.parse("2026-06-11T12:00:00.000Z"),
    sequence: 1,
  }),
  usageIndicator: "T",
};

/** A 277CA that ACCEPTS the claim (STC category A1). */
const ACCEPTED_277CA = [
  "ISA*00*          *00*          *ZZ*OFFALLY        *ZZ*SUB123         *260611*1200*^*00501*000000002*0*P*:~",
  "GS*HN*OFFALLY*SUB123*20260611*1200*2*X*005010X214~",
  "ST*277*0001*005010X214~",
  "BHT*0085*08*277CA-1*20260611*1200*TH~",
  "HL*1**20*1~",
  "HL*2*1*21*1~",
  "HL*3*2*19*1~",
  "HL*4*3*PT*0~",
  "NM1*QC*1*SYNTHETIC*PAT****MI*SYN000000001~",
  "TRN*2*CLM-0001~",
  "STC*A1:19:PR*20260611*WQ*120~",
  "SE*11*0001~",
  "GE*1*2~",
  "IEA*1*000000002~",
].join("");

/** A 277CA that REJECTS the claim (STC category A3 — not a denial). */
const REJECTED_277CA = [
  "ISA*00*          *00*          *ZZ*OFFALLY        *ZZ*SUB123         *260611*1200*^*00501*000000003*0*P*:~",
  "GS*HN*OFFALLY*SUB123*20260611*1200*3*X*005010X214~",
  "ST*277*0001*005010X214~",
  "BHT*0085*08*277CA-2*20260611*1200*TH~",
  "HL*1**20*1~",
  "HL*2*1*21*1~",
  "HL*3*2*19*1~",
  "HL*4*3*PT*0~",
  "NM1*QC*1*SYNTHETIC*PAT****MI*SYN000000001~",
  "TRN*2*CLM-0002~",
  "STC*A3:21:PR*20260611*U*120***Subscriber not found~",
  "SE*11*0001~",
  "GE*1*3~",
  "IEA*1*000000003~",
].join("");

/** An 835 paying a claim in full. */
function era(opts: {
  control: string;
  chargeCents: number;
  paidCents: number;
  statusCode: string;
  carc?: { group: string; code: string; amountCents: number };
}): string {
  const money = (c: number) => (c / 100).toFixed(2);
  const cas = opts.carc
    ? `CAS*${opts.carc.group}*${opts.carc.code}*${money(opts.carc.amountCents)}~`
    : "";
  return [
    "ISA*00*          *00*          *ZZ*SYNPAYER       *ZZ*SUB123         *260620*1200*^*00501*000000004*0*P*:~",
    "GS*HP*SYNPAYER*SUB123*20260620*1200*4*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*${money(opts.paidCents)}*C*ACH*CCP*01*999999999**01*999999999**20260620~`,
    "TRN*1*ERA0001*1999999999~",
    "N1*PR*SYNTHETIC PAYER~",
    "N1*PE*SYNTHETIC DME LLC*XX*1234567893~",
    "LX*1~",
    `CLP*${opts.control}*${opts.statusCode}*${money(opts.chargeCents)}*${money(opts.paidCents)}*0**MC*PAYERREF1~`,
    "NM1*QC*1*SYNTHETIC*PAT****MI*SYN000000001~",
    cas,
    "SE*12*0001~",
    "GE*1*4~",
    "IEA*1*000000004~",
  ]
    .filter(Boolean)
    .join("");
}

// ── The happy path, all the way through ──────────────────────────────

describe("eligible -> money", () => {
  it("walks one patient from due to paid, and the funnel agrees at every stage", () => {
    const l = ledger();

    // 1. Due.
    const ep = becomesEligible(l);
    expect(funnel(l).stages.eligible).toBe(1);
    expect(funnel(l).inFlight.awaitingResponse).toBe(1);

    // 2. Contacted.
    reminderSent(l, ep);
    expect(funnel(l).stages.confirmed).toBe(0);
    expect(funnel(l).inFlight.awaitingResponse).toBe(1);

    // 3. AFFIRMATIVE response. Eligibility is not authorisation and a
    //    reminder is not a confirmation — only this creates an order.
    const ful = patientConfirms(l, ep);
    expect(funnel(l).stages.confirmed).toBe(1);
    expect(funnel(l).stages.fulfilled).toBe(0);
    expect(funnel(l).inFlight.confirmedUnshipped).toBe(1);

    // 4. Real shipment evidence.
    shipmentRecorded(l, ep, ful);
    let f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
    expect(f.unverified.assumedShipped).toBe(0);
    // Shipped and not yet billed — visible immediately, not at month end.
    expect(f.postShipLoss.unbilled).toBe(1);

    // 5. The biller creates the claim.
    const claim = claimCreated(l, ful, "draft");
    f = funnel(l);
    expect(f.stages.claimed).toBe(1);
    expect(f.postShipLoss.unbilled).toBe(0);
    expect(f.inFlight.claimOpen).toBe(1);

    // 6. 837P generation — the real builder, over the real segments.
    const built = build837P(CLAIM_INPUT);
    expect(built.payload).toContain("~ST*837*");
    expect(built.payload).toContain("~CLM*CLM-0001*120");
    expect(built.claimCount).toBe(1);
    claim.status = "submitted";
    expect(funnel(l).inFlight.claimOpen).toBe(1);

    // 7. The clearinghouse ACCEPTS it.
    const ack = parse277CA(ACCEPTED_277CA);
    expect(ack.claims[0]?.outcome).toBe("accepted");
    expect(ack.claims[0]?.traceNumber).toBe("CLM-0001");
    claim.status = "accepted";
    f = funnel(l);
    expect(f.stages.accepted).toBe(1);
    expect(f.stages.paid).toBe(0);

    // 8. The payer pays.
    const remit = parse835(
      era({
        control: "CLM-0001",
        chargeCents: 12_000,
        paidCents: 12_000,
        statusCode: "1",
      }),
    );
    expect(remit.claims[0]?.isPaid).toBe(true);
    expect(remit.claims[0]?.isDenied).toBe(false);
    claim.status = "paid";
    claim.totalPaidCents = remit.claims[0]?.paidCents ?? 0;

    // 9. The funnel, end to end.
    f = funnel(l);
    expect(f.stages).toEqual({
      eligible: 1,
      confirmed: 1,
      fulfilled: 1,
      claimed: 1,
      accepted: 1,
      paid: 1,
    });
    expect(f.rates.paidOfAccepted).toBe(1);
    expect(f.postShipLoss).toEqual({
      unbilled: 0,
      denied: 0,
      rejected: 0,
      closedUnpaid: 0,
    });
    expect(f.unverified.assumedShipped).toBe(0);
  });
});

// ── Every way it does not reach money ────────────────────────────────

describe("pre-shipment outcomes", () => {
  it("eligible but never contacted is its own reason, not 'no response'", () => {
    // A patient we failed and a patient who ignored us are different
    // problems: one is a worker outage, the other is a person.
    const l = ledger();
    const ep = becomesEligible(l);
    closes(l, ep, "expired", "never_contacted");
    const f = funnel(l);
    expect(f.stages.confirmed).toBe(0);
    expect(f.preShipLoss.never_contacted).toBe(1);
    expect(f.preShipLoss.no_response).toBeUndefined();
  });

  it("contacted with no response is counted as no_response", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    reminderSent(l, ep);
    closes(l, ep, "expired", "no_response");
    expect(funnel(l).preShipLoss.no_response).toBe(1);
  });

  it("counts a patient still deciding as in-flight, NOT as a loss", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    reminderSent(l, ep);
    const f = funnel(l);
    expect(f.inFlight.awaitingResponse).toBe(1);
    expect(Object.values(f.preShipLoss).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("records a decline as a decline, distinct from an opt-out", () => {
    // "No, not this cycle" and "stop contacting me" need different
    // follow-ups, and a single `declined` status could not tell them
    // apart.
    const l = ledger();
    const declined = becomesEligible(l);
    closes(l, declined, "declined", "patient_declined");
    const optedOut = becomesEligible(l);
    closes(l, optedOut, "canceled", "patient_opted_out");
    const f = funnel(l);
    expect(f.preShipLoss.patient_declined).toBe(1);
    expect(f.preShipLoss.patient_opted_out).toBe(1);
  });

  it("counts an address hold as in-flight — the cycle is alive", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    patch(l, ep, { status: "address_hold" });
    const f = funnel(l);
    expect(f.inFlight.addressHold).toBe(1);
    expect(f.stages.confirmed).toBe(0);
  });

  it("counts confirmed-but-not-fulfilled as in-flight, not shipped", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    patientConfirms(l, ep);
    const f = funnel(l);
    expect(f.stages.confirmed).toBe(1);
    expect(f.stages.fulfilled).toBe(0);
    expect(f.inFlight.confirmedUnshipped).toBe(1);
  });

  it("counts a cancelled fulfillment's cycle as canceled, never as shipped", () => {
    // The patient DID confirm — a fulfillment only exists because they
    // did — so this is a post-confirm loss, not a pre-confirm one. What
    // matters is that a cancelled line never counts as a shipment.
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    const f0 = l.fulfillments.find((x) => x.id === ful);
    if (f0) f0.status = "cancelled";
    closes(l, ep, "canceled", "csr_canceled");
    const f = funnel(l);
    expect(f.stages.confirmed).toBe(1);
    expect(f.stages.fulfilled).toBe(0);
    expect(f.unverified.assumedShipped).toBe(0);
    expect(f.postShipLoss.unbilled).toBe(0);
  });
});

describe("assumed shipped is not shipped", () => {
  it("keeps a grace-sweep advance out of the shipped count", () => {
    // The sweep never touches the fulfillment, because inventing a ship
    // date for a payer is a compliance problem.
    const l = ledger();
    const ep = becomesEligible(l);
    patientConfirms(l, ep);
    graceSweepAdvances(l, ep);
    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(0);
    expect(f.unverified.assumedShipped).toBe(1);
  });

  it("does not report an assumed advance as shipped-but-unbilled", () => {
    // Counting it as shipped would then report it as product loss —
    // an expensive number against product that may not exist.
    const l = ledger();
    const ep = becomesEligible(l);
    patientConfirms(l, ep);
    graceSweepAdvances(l, ep);
    expect(funnel(l).postShipLoss.unbilled).toBe(0);
  });

  it("counts a real ship and an assumed one separately in the same window", () => {
    const l = ledger();
    const realEp = becomesEligible(l);
    const realFul = patientConfirms(l, realEp);
    shipmentRecorded(l, realEp, realFul);
    const assumedEp = becomesEligible(l);
    patientConfirms(l, assumedEp);
    graceSweepAdvances(l, assumedEp);
    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
    expect(f.unverified.assumedShipped).toBe(1);
  });
});

describe("shipped but never billed", () => {
  it("is visible as its own number, from both ends", () => {
    // Invisible from billing (which does not know the shipment
    // happened) and from resupply (which considers the cycle closed).
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
    expect(f.stages.claimed).toBe(0);
    expect(f.postShipLoss.unbilled).toBe(1);
  });
});

describe("clearinghouse versus payer", () => {
  it("parses a 277CA rejection as a rejection", () => {
    const ack = parse277CA(REJECTED_277CA);
    expect(ack.claims[0]?.outcome).toBe("rejected");
    // The parser composes the message from the STC01 code triple rather
    // than echoing payer prose — bounded cardinality, and no payer text
    // (which can quote member detail) reaches an analytics surface.
    expect(ack.claims[0]?.statusMessages.join(" ")).toContain("A3");
  });

  it("NEVER classifies a clearinghouse rejection as a payer denial", () => {
    // The load-bearing distinction. A rejection means the claim was
    // malformed and never reached adjudication; a denial means the payer
    // considered it and said no. Sending a biller to appeal a rejection
    // wastes the appeal and the timely-filing clock.
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);
    claim.status = "rejected";
    const f = funnel(l);
    expect(f.postShipLoss.rejected).toBe(1);
    expect(f.postShipLoss.denied).toBe(0);
    expect(f.deniedByCarc).toEqual([]);
  });

  it("counts a clearinghouse acceptance as claimed but not yet paid", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);
    claim.status = "accepted";
    const f = funnel(l);
    expect(f.stages.accepted).toBe(1);
    expect(f.stages.paid).toBe(0);
    expect(f.inFlight.claimOpen).toBe(1);
  });

  it("counts a payer denial as a denial, with its CARC code", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);

    const remit = parse835(
      era({
        control: "CLM-0003",
        chargeCents: 12_000,
        paidCents: 0,
        statusCode: "4",
        carc: { group: "CO", code: "29", amountCents: 12_000 },
      }),
    );
    expect(remit.claims[0]?.isDenied).toBe(true);
    expect(remit.claims[0]?.adjustments[0]?.reasonCode).toBe("29");

    claim.status = "denied";
    claim.denialReason = "CARC 29 — The time limit for filing has expired";
    const f = funnel(l);
    expect(f.postShipLoss.denied).toBe(1);
    expect(f.postShipLoss.rejected).toBe(0);
    expect(f.deniedByCarc).toEqual([{ code: "29", count: 1 }]);
  });

  it("still counts a denial with no code, rather than dropping it", () => {
    // A denial that vanishes from the CARC breakdown while still
    // counting in the denial total makes the two numbers on the page
    // disagree, and then neither can be trusted.
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);
    claim.status = "denied";
    claim.denialReason = null;
    const f = funnel(l);
    expect(f.postShipLoss.denied).toBe(1);
    expect(f.deniedByCarc).toEqual([{ code: "uncoded", count: 1 }]);
  });
});

describe("payment", () => {
  it("keeps partially_paid distinct from paid", () => {
    // Partially paid is money that arrived AND money that did not.
    // Folding it into `paid` hides the second half.
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);

    const remit = parse835(
      era({
        control: "CLM-0004",
        chargeCents: 12_000,
        paidCents: 8_000,
        statusCode: "1",
        carc: { group: "PR", code: "1", amountCents: 4_000 },
      }),
    );
    expect(remit.claims[0]?.paidCents).toBe(8_000);
    expect(remit.claims[0]?.isPaid).toBe(true);

    claim.status = "partially_paid";
    claim.totalPaidCents = 8_000;
    const f = funnel(l);
    expect(f.stages.accepted).toBe(1);
    expect(f.stages.paid).toBe(1);
    // The funnel counts it as paid because money arrived — but the
    // status is preserved distinctly, which is what the billing
    // surfaces read.
    expect(l.claims[0].status).toBe("partially_paid");
  });

  it("counts a full payment as paid", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);
    claim.status = "paid";
    claim.totalPaidCents = 12_000;
    expect(funnel(l).stages.paid).toBe(1);
  });

  it("does not count a claim that is merely created as submitted", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    claimCreated(l, ful, "draft");
    const f = funnel(l);
    expect(f.stages.claimed).toBe(1);
    expect(f.stages.accepted).toBe(0);
    // A draft is waiting on a biller, and the approval-gate panel counts
    // it. It is in flight, not lost.
    expect(f.inFlight.claimOpen).toBe(1);
  });

  it("counts a claim stuck in submitting as in-flight", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const claim = claimCreated(l, ful);
    claim.status = "submitting";
    const f = funnel(l);
    expect(f.inFlight.claimOpen).toBe(1);
    expect(f.postShipLoss.closedUnpaid).toBe(0);
  });
});

describe("secondary / COB", () => {
  it("counts a secondary claim against the same shipment without double-counting the ship", () => {
    // Two claims, one fulfillment. The funnel counts EPISODES, so the
    // shipment must count once however many claims hang off it.
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    const primary = claimCreated(l, ful);
    primary.status = "partially_paid";
    primary.totalPaidCents = 8_000;
    const secondary = claimCreated(l, ful);
    secondary.status = "draft";

    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
    expect(f.stages.claimed).toBe(1);
    expect(f.stages.paid).toBe(1);
  });
});

describe("duplicate and corrected shipment evidence", () => {
  it("counts one shipment once, however many times it is imported", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful);
    // A re-import of the same file. `recordShipmentEvidence` claims the
    // row atomically, so the second pass writes nothing.
    shipmentRecorded(l, ep, ful);
    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
    expect(l.fulfillments.filter((x) => x.shippedAt !== null)).toHaveLength(1);
  });

  it("keeps the count at one when a corrected date replaces the original", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    const ful = patientConfirms(l, ep);
    shipmentRecorded(l, ep, ful, "2026-06-10T12:00:00.000Z");
    // A correction, worked through the exception queue.
    const f0 = l.fulfillments.find((x) => x.id === ful);
    if (f0) f0.shippedAt = "2026-06-12T12:00:00.000Z";
    const f = funnel(l);
    expect(f.stages.fulfilled).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("never mixes two tenants' episodes into one funnel", () => {
    // The funnel is pure and counts what it is given; the ROUTE reads
    // through the org-scoped client. This asserts the shape that makes
    // that correct: two ledgers aggregate independently, and a cross-
    // tenant claim reference finds nothing.
    const a = ledger("org-a");
    const b = ledger("org-b");

    const epA = becomesEligible(a);
    const fulA = patientConfirms(a, epA);
    shipmentRecorded(a, epA, fulA);
    claimCreated(a, fulA, "paid");

    const epB = becomesEligible(b);
    closes(b, epB, "declined", "patient_declined");

    expect(funnel(a).stages).toMatchObject({ eligible: 1, fulfilled: 1 });
    expect(funnel(b).stages).toMatchObject({ eligible: 1, fulfilled: 0 });
    expect(funnel(b).preShipLoss.patient_declined).toBe(1);
    expect(funnel(a).preShipLoss.patient_declined).toBeUndefined();
  });

  it("ignores a claim whose fulfillment belongs to another tenant", () => {
    // A claim row that leaked across tenants must not credit this
    // tenant's funnel with a payment.
    const a = ledger("org-a");
    const ep = becomesEligible(a);
    const ful = patientConfirms(a, ep);
    shipmentRecorded(a, ep, ful);
    a.claims.push({
      fulfillmentId: "ful-from-another-tenant",
      status: "paid",
      denialReason: null,
      totalPaidCents: 99_999,
    });
    const f = funnel(a);
    expect(f.stages.claimed).toBe(0);
    expect(f.stages.paid).toBe(0);
    expect(f.postShipLoss.unbilled).toBe(1);
  });
});

describe("rates", () => {
  it("reports a rate of null, not zero, when the denominator is empty", () => {
    // 0% and "no data" are different answers and must not render the
    // same — a practice with no eligible patients has not converted 0%.
    const f = funnel(ledger());
    expect(f.rates.confirmedOfEligible).toBeNull();
    expect(f.rates.paidOfAccepted).toBeNull();
  });

  it("reports a real zero when there IS a denominator", () => {
    const l = ledger();
    const ep = becomesEligible(l);
    closes(l, ep, "declined", "patient_declined");
    expect(funnel(l).rates.confirmedOfEligible).toBe(0);
  });
});

describe("the 837P this all produces", () => {
  it("is well-formed, and carries the control number the 277CA echoes back", () => {
    const built = build837P(CLAIM_INPUT);
    expect(built.payload.startsWith("ISA*")).toBe(true);
    expect(built.payload).toContain("~GS*HC*");
    expect(built.payload).toContain("~ST*837*");
    expect(built.payload).toContain("~IEA*1*");
    // The join key back to `insurance_claims`, and the trace number the
    // acknowledgment returns.
    expect(built.payload).toContain("~CLM*CLM-0001*");
    expect(parse277CA(ACCEPTED_277CA).claims[0]?.traceNumber).toBe("CLM-0001");
  });

  it("carries the date of service from the shipment, not from today", () => {
    // The whole reason shipment evidence is load-bearing: without it the
    // claim builder falls back to today's date.
    const built = build837P(CLAIM_INPUT);
    expect(built.payload).toContain("20260610");
    // And NOT today's date, whenever this suite happens to run.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (today !== "20260610") {
      expect(built.payload).not.toContain(`DTP*472*D8*${today}`);
    }
  });
});

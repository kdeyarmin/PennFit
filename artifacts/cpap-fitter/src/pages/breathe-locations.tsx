import { Link } from "wouter";
import {
  BadgeCheck,
  Building2,
  Landmark,
  MapPin,
  Network,
  ShieldCheck,
  ShoppingBag,
  Store,
  UserCog,
  Users,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Multi-location / franchise.
 *
 * The one platform pillar without a dedicated page. Grounded in the shipped
 * multi-location feature (artifacts/resupply-api/src/routes/admin/locations.ts,
 * lib/locations/*, lib/pickup/locations.ts, admin-locations.tsx): each branch
 * is its own location row (name, code, address, phone_e164, NPI, is_primary,
 * is_active); staff are assignable to locations; a counts-only per-location
 * rollup (patient / active-patient / staff counts + an "unassigned" bucket,
 * no PHI) via the org-scoped location_rollup RPC; active locations become
 * in-store pickup choices on the storefront (order confirm validates the choice and
 * the order carries the pickup address); a primary-location resolver drives
 * defaults; everything stays org-isolated per tenant.
 *
 * HONESTY: the rollup is COUNTS ONLY (patients/active/staff) — NOT per-branch
 * P&L / margin. Do not claim location-level financials here; cross-link the
 * analytics page for the numbers. Reuses BreatheShell/PageHead + the .bx-*
 * system incl. the .bx-fleet table (no new CSS); noindex + lazy-loaded.
 */

type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

function CapGrid({ items }: { items: Cap[] }) {
  return (
    <div className="bx-caps">
      {items.map((c) => (
        <article
          className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}
          key={c.title}
        >
          <div className="bx-cap-head">
            <span className="bx-cap-ic">{c.icon}</span>
            <div>
              <h3>{c.title}</h3>
              <p className="bx-cap-summary">{c.summary}</p>
            </div>
          </div>
          <ul className="bx-cap-list">
            {c.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

/* ── A real record for every branch ── */
const BRANCHES: Cap[] = [
  {
    icon: <Building2 size={20} />,
    title: "A record for every branch",
    summary: "Each location is its own — not a line in a spreadsheet.",
    gold: true,
    points: [
      "Name, code, full address, and phone per branch",
      "A primary branch drives defaults; any branch can be set active or inactive",
      "Open a new location without disturbing the others",
    ],
  },
  {
    icon: <UserCog size={20} />,
    title: "Staff organized by branch",
    summary: "Everyone's on the right team.",
    points: [
      "Assign each team member to the location they staff",
      "Role-based permissions govern what each person can do",
      "See each branch's team and headcount at a glance",
    ],
  },
  {
    icon: <Users size={20} />,
    title: "Patients belong to a branch",
    summary: "Everyone rolls up to a home location.",
    points: [
      "Each patient is assigned to a branch",
      "Anyone unassigned shows in a clear bucket — nobody gets lost",
      "Reassign when a patient transfers between locations",
    ],
  },
  {
    icon: <Landmark size={20} />,
    title: "Each branch bills as itself",
    summary: "Its own address, phone, and NPI.",
    points: [
      "A per-location NPI travels with the branch",
      "So claims and documents carry the right identifiers",
      "One tenant, many billable locations",
    ],
  },
];

function Branches() {
  return (
    <section className="bx-section" id="branches">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Building2 size={13} /> Every branch, modeled
          </span>
          <h2 className="bx-h2">
            One organization, <em>many real locations</em>
          </h2>
          <p className="bx-lede">
            Growth shouldn't mean a second system. In Breathe every branch is a
            first-class location — its own address, phone, NPI, and team — all
            under one organization, one patient database, and one set of
            automations.
          </p>
        </div>
        <CapGrid items={BRANCHES} />
      </div>
    </section>
  );
}

/* ── The per-location rollup (counts only) ── */
type RollRow = {
  name: string;
  patients: string;
  active: string;
  staff: string;
  tone: "ok" | "warn" | "info";
  status: string;
};

const ROLLUP: RollRow[] = [
  {
    name: "Downtown (primary)",
    patients: "1,284",
    active: "1,051",
    staff: "9",
    status: "Active",
    tone: "ok",
  },
  {
    name: "Northside",
    patients: "612",
    active: "498",
    staff: "5",
    status: "Active",
    tone: "ok",
  },
  {
    name: "Westgate",
    patients: "433",
    active: "351",
    staff: "4",
    status: "Active",
    tone: "ok",
  },
  {
    name: "Lakeview",
    patients: "—",
    active: "—",
    staff: "2",
    status: "Onboarding",
    tone: "warn",
  },
  {
    name: "Unassigned",
    patients: "37",
    active: "29",
    staff: "0",
    status: "Needs a branch",
    tone: "info",
  },
];

function Rollup() {
  return (
    <section className="bx-section bx-section-tight" id="rollup">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Network size={13} /> One rollup
          </span>
          <h2 className="bx-h2">See every branch side by side</h2>
          <p className="bx-lede">
            A live rollup shows patients, active patients, and staff for each
            location at a glance — plus anyone not yet assigned to a branch, so
            no one slips through the cracks as you grow.
          </p>
        </div>
        <div className="bx-fleet-wrap bx-reveal">
          <table className="bx-fleet">
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Patients</th>
                <th scope="col">Active</th>
                <th scope="col">Staff</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {ROLLUP.map((r) => (
                <tr key={r.name}>
                  <td className="bx-fleet-name">{r.name}</td>
                  <td>{r.patients}</td>
                  <td>{r.active}</td>
                  <td>{r.staff}</td>
                  <td>
                    <span className={`bx-fleet-status is-${r.tone}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="bx-stats-note bx-reveal">
          Counts only — no PHI. Sample data, illustrative. For revenue, margin,
          and the rest of the numbers, the platform&apos;s analytics run on the
          same live data.{" "}
          <Link href="/breathe/analytics">See the analytics →</Link>
        </p>
      </div>
    </section>
  );
}

/* ── In-store pickup per branch ── */
const PICKUP: Cap[] = [
  {
    icon: <Store size={20} />,
    title: "Every active branch is a pickup point",
    summary: "Patients choose in-store pickup when confirming their order.",
    gold: true,
    points: [
      "Your active locations appear as pickup choices, primary first",
      "A patient picks the branch closest to them",
      "Inactive or closed locations never show",
    ],
  },
  {
    icon: <BadgeCheck size={20} />,
    title: "Order confirm keeps it valid",
    summary: "No stale or closed branch slips through.",
    points: [
      "Confirm validates the chosen pickup location is a real, active branch",
      "A deactivated location can't be selected after the fact",
      "The choice is tied to the order, not guessed later",
    ],
  },
  {
    icon: <ShoppingBag size={20} />,
    title: "The order carries the address",
    summary: "Staff and patient both know where to go.",
    points: [
      "The pickup branch and its address ride along on the order",
      "Surfaced on the admin order view and the patient's confirmation",
      "One more fulfillment option without a separate system",
    ],
  },
];

function Pickup() {
  return (
    <section className="bx-section" id="pickup">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShoppingBag size={13} /> In-store pickup
          </span>
          <h2 className="bx-h2">
            Ship it, or let them <em>pick it up</em>
          </h2>
          <p className="bx-lede">
            With more than one location, in-store pickup becomes a real option.
            Your branches show up on the storefront as pickup points, order
            confirm keeps the choice valid, and the order carries the branch
            address all the way through.
          </p>
        </div>
        <CapGrid items={PICKUP} />
      </div>
    </section>
  );
}

/* ── Built for franchises & multi-site ── */
const FRANCHISE: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <Network size={22} />,
    metric: "1",
    metricSub: "login, N branches",
    title: "Grow without re-platforming",
    gold: true,
    body: "Add the second, fifth, or twentieth branch on the same login — one patient database, one brand, and the same resupply, billing, and clinical automations everywhere.",
  },
  {
    icon: <MapPin size={22} />,
    metric: "Local",
    metricSub: "where it counts",
    title: "Each branch keeps its own identity",
    body: "Its own address, phone, NPI, and team — so claims carry the right identifiers and patients see their local location, not a faceless head office.",
  },
  {
    icon: <ShieldCheck size={22} />,
    metric: "Private",
    metricSub: "by tenant",
    title: "Every location under one roof",
    body: "All your branches roll up under one organization that stays cleanly isolated from every other operator on the platform — your data is yours.",
  },
];

function Franchise() {
  return (
    <section className="bx-section" id="franchise">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Building2 size={13} /> Built to scale
          </span>
          <h2 className="bx-h2">Made for franchises and multi-site DMEs</h2>
          <p className="bx-lede">
            Whether you run two storefronts or twenty, Breathe keeps the whole
            operation on one platform — central where it helps, local where it
            matters.
          </p>
        </div>
        <div className="bx-pillars">
          {FRANCHISE.map((p) => (
            <article
              className={`bx-pillar bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-pillar-top">
                <span className="bx-pillar-ic">{p.icon}</span>
                <span className="bx-pillar-metric">
                  <b>{p.metric}</b>
                  <small>{p.metricSub}</small>
                </span>
              </div>
              <h3 className="bx-pillar-title">{p.title}</h3>
              <p className="bx-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>
        <p className="bx-stats-note bx-reveal">
          One platform replaces the pile of point tools at every branch.{" "}
          <Link href="/breathe/compare">See how it compares →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheLocations() {
  useDocumentTitle(
    "Multi-location — Breathe by CareMetric.ai",
    "Run every branch of your DME on one platform: each location its own record (address, phone, NPI), staff scoped to their branch, a live per-location rollup of patients and staff, and in-store pickup per branch — one organization, one patient database, one brand.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Building2}
        eyebrow="Multi-location"
        title={
          <>
            One platform. Every branch.{" "}
            <span className="grad-em">One rollup.</span>
          </>
        }
        sub="Each location gets its own address, phone, NPI, and team — while patients, billing, clinical monitoring, and the storefront all run on one organization. Add branches without adding systems, and see them all side by side."
      />
      <Branches />
      <Rollup />
      <Pickup />
      <Franchise />
      <ClosingCta />
    </BreatheShell>
  );
}

// Customer 360 panel — compact "everything I need to handle this
// in-app conversation" sidebar rendered next to the message thread
// (Phase 11). Mirrors the patient-flow Patient360Panel but surfaces
// shop-customer-shaped data: CPAP device crumb, latest order, recent
// internal notes, and a deep link to the full /admin/shop/customers
// page.
//
// Why two parallel queries instead of one fat endpoint: the customer
// detail and notes endpoints are already used independently by the
// /admin/shop/customers/:userId page; sharing those react-query keys
// here means navigating from the conversation to the customer page
// is a cache hit on both sides — no extra round trip.

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";

import { Card } from "./Card";
import { Spinner } from "./Spinner";
import { Badge } from "./Badge";
import {
  getAdminCustomerDetail,
  AdminCustomerNotFoundError,
  type AdminCustomerCpapDevice,
  type AdminCustomerOrder,
} from "@/lib/admin/customers-api";
import {
  listAdminCustomerNotes,
  type AdminCustomerNote,
} from "@/lib/admin/customer-notes-api";

interface Props {
  customerId: string;
  displayName: string | null;
  email: string | null;
}

const NOTES_PREVIEW = 2;

export function Customer360Panel({ customerId, displayName, email }: Props) {
  const detail = useQuery({
    queryKey: ["admin", "shop", "customers", customerId],
    queryFn: () => getAdminCustomerDetail(customerId),
  });
  const notes = useQuery({
    queryKey: ["admin", "shop", "customers", customerId, "notes"],
    queryFn: () => listAdminCustomerNotes(customerId),
  });

  if (detail.isError) {
    if (detail.error instanceof AdminCustomerNotFoundError) {
      // Defensive: the conversation references a customer that's been
      // hard-deleted (FK CASCADE would normally catch this, but a CSR
      // viewing a stale tab can land here). Render the basics from
      // the conversation row itself rather than a hard error so the
      // thread is still usable.
      return (
        <FallbackPanel
          customerId={customerId}
          displayName={displayName}
          email={email}
        />
      );
    }
    return (
      <Card title="Customer">
        <p className="text-sm" style={{ color: "#b91c1c" }}>
          Couldn&apos;t load customer context.
        </p>
      </Card>
    );
  }

  if (detail.isPending) {
    return (
      <Card title="Customer">
        <Spinner label="Loading customer…" />
      </Card>
    );
  }

  const c = detail.data;
  const profile = c.customer;
  const recentOrder = c.orders[0] ?? null;
  const recentNotes = (notes.data?.notes ?? []).slice(0, NOTES_PREVIEW);
  const totalNotes = notes.data?.notes.length ?? 0;

  return (
    <Card
      title="Customer"
      subtitle={
        <span className="text-xs">
          <Link
            href={`/admin/shop/customers/${encodeURIComponent(customerId)}`}
            className="underline decoration-dotted"
            style={{ color: "hsl(var(--ink-1))" }}
            data-testid="customer-360-deep-link"
          >
            Open full customer view →
          </Link>
        </span>
      }
    >
      <div className="space-y-4 text-sm" data-testid="customer-360-panel">
        <div>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {profile.displayName ?? displayName ?? "Shop customer"}
          </div>
          {(profile.email ?? email) && (
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {profile.email ?? email}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {profile.isGuest && <Badge variant="muted">Guest</Badge>}
            {c.stats.ordersCount > 0 && (
              <Badge variant="info">
                {c.stats.ordersCount} order
                {c.stats.ordersCount === 1 ? "" : "s"}
              </Badge>
            )}
            {c.stats.lifetimeValueCents > 0 && (
              <Badge variant="success">
                LTV {formatCents(c.stats.lifetimeValueCents)}
              </Badge>
            )}
          </div>
        </div>

        <DeviceSection device={profile.clinicalInfo.cpapDevice} />
        <OrderSection order={recentOrder} />
        <NotesSection
          notes={recentNotes}
          total={totalNotes}
          customerId={customerId}
          isPending={notes.isPending}
        />
      </div>
    </Card>
  );
}

function DeviceSection({ device }: { device: AdminCustomerCpapDevice | null }) {
  return (
    <Section title="CPAP machine">
      {device ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
          {device.manufacturer} {device.model}
          {device.pressureSetting && (
            <span style={{ color: "hsl(var(--ink-3))" }}>
              {" "}
              · {device.pressureSetting}
            </span>
          )}
        </p>
      ) : (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No device on file.
        </p>
      )}
    </Section>
  );
}

function OrderSection({ order }: { order: AdminCustomerOrder | null }) {
  if (!order) {
    return (
      <Section title="Latest order">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No orders yet.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Latest order">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs truncate"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <code
            style={{
              background: "#f1f5f9",
              padding: "1px 4px",
              borderRadius: 3,
              fontSize: 10,
            }}
          >
            {order.id.slice(0, 8)}
          </code>{" "}
          · {order.status}
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {order.amountTotalCents != null
            ? formatCents(order.amountTotalCents)
            : "—"}
        </span>
      </div>
      {order.trackingNumber && (
        <p
          className="text-[10px] mt-0.5"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {order.trackingCarrier ?? "tracking"}: {order.trackingNumber}
        </p>
      )}
    </Section>
  );
}

function NotesSection({
  notes,
  total,
  customerId,
  isPending,
}: {
  notes: AdminCustomerNote[];
  total: number;
  customerId: string;
  isPending: boolean;
}) {
  return (
    <Section title="Recent internal notes">
      {isPending ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Loading…
        </p>
      ) : notes.length === 0 ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No notes yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <li
              key={n.id}
              className="rounded px-2 py-1.5"
              style={{
                background: "#fffbe6",
                border: "1px solid hsl(var(--line-1))",
              }}
            >
              <p
                className="text-[10px] mb-0.5"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {n.authorEmail} · {new Date(n.createdAt).toLocaleDateString()}
              </p>
              <p
                className="text-xs whitespace-pre-wrap break-words"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                {truncate(n.body, 140)}
              </p>
            </li>
          ))}
          {total > notes.length && (
            <li className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
              <Link
                href={`/admin/shop/customers/${encodeURIComponent(customerId)}`}
                className="underline decoration-dotted"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                +{total - notes.length} more in customer view →
              </Link>
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}

function FallbackPanel({
  customerId,
  displayName,
  email,
}: {
  customerId: string;
  displayName: string | null;
  email: string | null;
}) {
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="customer-360-fallback">
        <p
          className="text-xs uppercase tracking-wider mb-2"
          style={{ color: "hsl(var(--penn-gold-deep))" }}
        >
          Customer
        </p>
        <h3
          className="text-base font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {displayName ?? email ?? "Shop customer"}
        </h3>
        {email && (
          <p className="text-xs mb-3" style={{ color: "hsl(var(--ink-3))" }}>
            {email}
          </p>
        )}
        <p className="text-xs mb-2" style={{ color: "hsl(var(--ink-3))" }}>
          No customer record found. The account may have been deleted.
        </p>
        <Link
          href={`/admin/shop/customers/${encodeURIComponent(customerId)}`}
          className="text-xs underline decoration-dotted"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          View full customer profile →
        </Link>
      </div>
    </Card>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

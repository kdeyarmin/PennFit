// /admin/shop/customers/:userId — single shop-customer detail view
// for the CSR.
//
// Surfaces everything `GET /admin/shop/customers/:userId` returns:
//   * Profile: name, email, addresses, saved card crumbs
//   * Clinical info (PR #52): CPAP device + prescribing physician
//   * In-app conversation summary (PR #53/#54) with deep-link to the
//     existing /admin/conversations/:id thread + reply composer
//   * Lifetime stats: orders count, lifetime value, avg order value
//   * Recent orders, subscriptions, abandoned cart, reviews
//
// Why read-only for v1:
//   The customer-facing /account page is the source of truth for
//   editing clinical info; CSR edits would race against the customer
//   and need their own audit envelope. We can layer that in later.
//
// Navigation in:
//   * Direct URL (CSR pastes the user id from a Stripe webhook log).
//   * From the conversation detail page, when channel === "in_app"
//     the page renders a "View customer profile" link.
//   * (Future: a /admin/shop/customers list page.)
//
// PHI posture:
//   The page renders the clinical info + physician info in the
//   clear (the requireAdmin gate has already cleared the PHI-access
//   policy check). We do NOT log per-row PHI to the browser console.

import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  HeartPulse,
  Mail,
  MapPin,
  MessageSquare,
  Stethoscope,
  User as UserIcon,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { Badge } from "@/components/admin/Badge";
import {
  AdminCustomerNotFoundError,
  getAdminCustomerDetail,
  type AdminCustomerCpapDevice,
  type AdminCustomerPhysicianInfo,
  type AdminCustomerInAppConversation,
  type AdminCustomerProfile,
  type AdminCustomerStats,
} from "@/lib/admin/customers-api";

interface Props {
  userId: string;
}

export function AdminCustomerDetailPage({ userId }: Props) {
  const [, navigate] = useLocation();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "shop", "customers", userId],
    queryFn: () => getAdminCustomerDetail(userId),
  });

  if (isPending) {
    return (
      <div style={{ padding: 24 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    if (error instanceof AdminCustomerNotFoundError) {
      return (
        <div style={{ padding: 24 }}>
          <BackLink />
          <Card>
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text-muted, #475569)",
              }}
            >
              <AlertCircle
                size={28}
                style={{ marginBottom: 8, color: "#dc2626" }}
              />
              <h2 style={{ marginBottom: 4 }}>Customer not found</h2>
              <p>
                That user id has no shop-customer record and no orders on file.
              </p>
            </div>
          </Card>
        </div>
      );
    }
    return (
      <div style={{ padding: 24 }}>
        <BackLink />
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        display: "grid",
        gap: 16,
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <BackLink onBack={() => navigate("/admin/conversations")} />
      <CustomerHeader profile={data.customer} stats={data.stats} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <div style={{ display: "grid", gap: 16 }}>
          <ClinicalInfoCard
            cpapDevice={data.customer.clinicalInfo.cpapDevice}
            physicianInfo={data.customer.clinicalInfo.physicianInfo}
          />
          <InAppConversationCard
            inApp={data.inAppConversation}
            customerName={data.customer.displayName ?? "this customer"}
          />
          <RecentOrdersCard orders={data.orders} />
        </div>
        <aside style={{ display: "grid", gap: 16 }}>
          <ContactCard profile={data.customer} />
          <SavedCardCard card={data.customer.defaultPaymentMethod} />
          <StatsCard stats={data.stats} />
        </aside>
      </div>
    </div>
  );
}

// ─── Header + back link ─────────────────────────────────────────

function BackLink({ onBack }: { onBack?: () => void } = {}) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: 0,
        color: "var(--text-muted, #475569)",
        cursor: "pointer",
        font: "inherit",
        padding: 0,
      }}
      data-testid="admin-customer-back"
    >
      <ArrowLeft size={14} />
      Back to inbox
    </button>
  );
}

function CustomerHeader({
  profile,
  stats,
}: {
  profile: AdminCustomerProfile;
  stats: AdminCustomerStats;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "var(--surface-2, #e2e8f0)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-hidden="true"
        >
          <UserIcon size={20} />
        </div>
        <div>
          <h1
            style={{ margin: 0, fontSize: 20 }}
            data-testid="admin-customer-name"
          >
            {profile.displayName ?? "Unnamed customer"}
          </h1>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted, #475569)",
              fontFamily: "monospace",
            }}
          >
            {profile.userId}
            {profile.isGuest && (
              <span style={{ marginLeft: 8 }}>
                <Badge variant="muted">Guest</Badge>
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
        <Stat label="Orders" value={String(stats.ordersCount)} />
        <Stat
          label="Lifetime"
          value={formatCents(stats.lifetimeValueCents)}
          highlight
        />
        <Stat label="Avg order" value={formatCents(stats.avgOrderValueCents)} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        background: highlight ? "#f0fdf4" : "transparent",
        border: highlight ? "1px solid #bbf7d0" : "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "6px 10px",
        textAlign: "right",
      }}
      data-testid={`admin-customer-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted, #475569)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// ─── Clinical info card ─────────────────────────────────────────

function ClinicalInfoCard({
  cpapDevice,
  physicianInfo,
}: {
  cpapDevice: AdminCustomerCpapDevice | null;
  physicianInfo: AdminCustomerPhysicianInfo | null;
}) {
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-clinical">
        <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
          Clinical info on file
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}
        >
          <Subsection
            title="CPAP machine"
            Icon={HeartPulse}
            empty={cpapDevice === null}
            emptyHint="No device on file. Customer can add one on their /account page."
          >
            {cpapDevice && (
              <DefList>
                <DefItem label="Manufacturer">
                  {cpapDevice.manufacturer}
                </DefItem>
                <DefItem label="Model">{cpapDevice.model}</DefItem>
                {cpapDevice.serialNumber && (
                  <DefItem label="Serial">{cpapDevice.serialNumber}</DefItem>
                )}
                {cpapDevice.pressureSetting && (
                  <DefItem label="Pressure">
                    {cpapDevice.pressureSetting}
                  </DefItem>
                )}
                {cpapDevice.humidifierSetting && (
                  <DefItem label="Humidifier">
                    {cpapDevice.humidifierSetting}
                  </DefItem>
                )}
                {cpapDevice.notes && (
                  <DefItem label="Notes">{cpapDevice.notes}</DefItem>
                )}
              </DefList>
            )}
          </Subsection>
          <Subsection
            title="Prescribing physician"
            Icon={Stethoscope}
            empty={physicianInfo === null}
            emptyHint="No physician on file."
          >
            {physicianInfo && (
              <DefList>
                <DefItem label="Name">{physicianInfo.name}</DefItem>
                {physicianInfo.practice && (
                  <DefItem label="Practice">{physicianInfo.practice}</DefItem>
                )}
                {physicianInfo.phone && (
                  <DefItem label="Phone">{physicianInfo.phone}</DefItem>
                )}
                {physicianInfo.fax && (
                  <DefItem label="Fax">{physicianInfo.fax}</DefItem>
                )}
                {physicianInfo.email && (
                  <DefItem label="Email">{physicianInfo.email}</DefItem>
                )}
                {physicianInfo.npi && (
                  <DefItem label="NPI">{physicianInfo.npi}</DefItem>
                )}
                {(physicianInfo.addressLine1 || physicianInfo.city) && (
                  <DefItem label="Address">
                    <span style={{ display: "block" }}>
                      {physicianInfo.addressLine1}
                      {physicianInfo.addressLine2
                        ? `, ${physicianInfo.addressLine2}`
                        : ""}
                    </span>
                    <span
                      style={{
                        display: "block",
                        color: "var(--text-muted, #475569)",
                      }}
                    >
                      {[
                        physicianInfo.city,
                        physicianInfo.state,
                        physicianInfo.postalCode,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </DefItem>
                )}
              </DefList>
            )}
          </Subsection>
        </div>
      </div>
    </Card>
  );
}

// ─── In-app conversation card ──────────────────────────────────

function InAppConversationCard({
  inApp,
  customerName,
}: {
  inApp: AdminCustomerInAppConversation | null;
  customerName: string;
}) {
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-in-app">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
            gap: 8,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <MessageSquare size={14} />
            In-account messaging
          </h2>
          {inApp && inApp.unreadFromCustomer > 0 && (
            <Badge variant="warning" data-testid="admin-customer-unread-badge">
              {inApp.unreadFromCustomer} new from customer
            </Badge>
          )}
        </div>
        {!inApp ? (
          <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
            {customerName} hasn&apos;t messaged customer service yet.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div
              style={{
                display: "flex",
                gap: 12,
                fontSize: 13,
                flexWrap: "wrap",
              }}
            >
              <span>
                Status: <strong>{humanizeStatus(inApp.status)}</strong>
              </span>
              <span>
                Messages: <strong>{inApp.messageCount}</strong>
              </span>
              {inApp.lastMessageAt && (
                <span>
                  Last activity:{" "}
                  <strong>
                    {new Date(inApp.lastMessageAt).toLocaleString()}
                  </strong>
                </span>
              )}
            </div>
            <Link href={`/admin/conversations/${inApp.id}`}>
              <a
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: "#1e40af",
                  textDecoration: "none",
                }}
                data-testid="admin-customer-open-thread"
              >
                Open the thread
                <ExternalLink size={12} />
              </a>
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

function humanizeStatus(s: AdminCustomerInAppConversation["status"]): string {
  switch (s) {
    case "awaiting_admin":
      return "Awaiting reply";
    case "awaiting_patient":
      return "Awaiting customer";
    case "open":
      return "Open";
    case "closed":
      return "Closed";
  }
}

// ─── Recent orders / contact / saved card / stats cards ────────

function RecentOrdersCard({
  orders,
}: {
  orders: import("@/lib/admin/customers-api").AdminCustomerOrder[];
}) {
  if (orders.length === 0) {
    return (
      <Card>
        <div style={{ padding: 16 }} data-testid="admin-customer-orders-empty">
          <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
            Recent orders
          </h2>
          <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
            No orders yet.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-orders">
        <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
          Recent orders ({orders.length})
        </h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {orders.slice(0, 8).map((o) => (
            <li
              key={o.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 0",
                borderBottom: "1px solid var(--border, #e2e8f0)",
                fontSize: 13,
              }}
            >
              <span>
                <code
                  style={{
                    background: "#f1f5f9",
                    padding: "1px 4px",
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  {o.id.slice(0, 8)}
                </code>{" "}
                · {o.status} · {o.itemCount} item
                {o.itemCount === 1 ? "" : "s"}
              </span>
              <span style={{ color: "var(--text-muted, #475569)" }}>
                {o.amountTotalCents != null
                  ? formatCents(o.amountTotalCents)
                  : "—"}{" "}
                · {new Date(o.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ContactCard({ profile }: { profile: AdminCustomerProfile }) {
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-contact">
        <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>Contact</h2>
        {profile.email && (
          <p
            style={{
              margin: "4px 0",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Mail size={12} />
            {profile.email}
          </p>
        )}
        {profile.shippingAddress && (
          <p
            style={{
              margin: "4px 0",
              fontSize: 13,
              display: "flex",
              gap: 6,
              alignItems: "flex-start",
            }}
          >
            <MapPin size={12} style={{ marginTop: 3 }} />
            <span>
              {profile.shippingAddress.line1}
              {profile.shippingAddress.line2
                ? `, ${profile.shippingAddress.line2}`
                : ""}
              <br />
              {profile.shippingAddress.city}, {profile.shippingAddress.state}{" "}
              {profile.shippingAddress.postalCode}
            </span>
          </p>
        )}
        {!profile.email && !profile.shippingAddress && (
          <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
            No contact info on file.
          </p>
        )}
      </div>
    </Card>
  );
}

function SavedCardCard({
  card,
}: {
  card: import("@/lib/admin/customers-api").AdminCustomerCard | null;
}) {
  if (!card || !card.brand) {
    return (
      <Card>
        <div style={{ padding: 16 }}>
          <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
            Saved card
          </h2>
          <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
            No card on file.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div style={{ padding: 16 }}>
        <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
          Saved card
        </h2>
        <p style={{ margin: 0, fontSize: 13, fontFamily: "monospace" }}>
          {card.brand.toUpperCase()} •••• {card.last4}
          {card.expMonth != null && card.expYear != null && (
            <span style={{ color: "var(--text-muted, #475569)" }}>
              {" · "}
              expires {String(card.expMonth).padStart(2, "0")}/
              {String(card.expYear).slice(-2)}
            </span>
          )}
        </p>
      </div>
    </Card>
  );
}

function StatsCard({ stats }: { stats: AdminCustomerStats }) {
  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-stats">
        <h2 style={{ margin: 0, fontSize: 14, marginBottom: 12 }}>
          Lifetime stats
        </h2>
        <DefList>
          <DefItem label="Orders">{stats.ordersCount}</DefItem>
          <DefItem label="Lifetime value">
            {formatCents(stats.lifetimeValueCents)}
          </DefItem>
          <DefItem label="Avg order">
            {formatCents(stats.avgOrderValueCents)}
          </DefItem>
          {stats.firstOrderAt && (
            <DefItem label="First order">
              {new Date(stats.firstOrderAt).toLocaleDateString()}
            </DefItem>
          )}
          {stats.lastOrderAt && (
            <DefItem label="Last order">
              {new Date(stats.lastOrderAt).toLocaleDateString()}
            </DefItem>
          )}
          {stats.pendingReviewsCount > 0 && (
            <DefItem label="Pending reviews">
              {stats.pendingReviewsCount}
            </DefItem>
          )}
        </DefList>
      </div>
    </Card>
  );
}

// ─── Tiny shared helpers ───────────────────────────────────────

function Subsection({
  title,
  Icon,
  empty,
  emptyHint,
  children,
}: {
  title: string;
  Icon: React.ComponentType<{ size?: number }>;
  empty: boolean;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3
        style={{
          margin: 0,
          marginBottom: 8,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted, #475569)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon size={12} />
        {title}
      </h3>
      {empty ? (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-muted, #475569)",
          }}
        >
          {emptyHint}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

function DefList({ children }: { children: React.ReactNode }) {
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        rowGap: 6,
        columnGap: 12,
        fontSize: 13,
      }}
    >
      {children}
    </dl>
  );
}

function DefItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt
        style={{
          color: "var(--text-muted, #475569)",
          textTransform: "uppercase",
          fontSize: 10,
          letterSpacing: 0.5,
          alignSelf: "baseline",
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

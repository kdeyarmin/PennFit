import React from "react";

/**
 * Help Center "screenshots".
 *
 * These are hand-drawn, theme-faithful SVG mock-ups of the real PennPaps
 * screens, wrapped in a browser- or phone-chrome frame so a help article
 * can show "here's what this screen looks like" without shipping binary
 * PNG assets into the repo (which would bloat the bundle, can't be diffed,
 * and drift silently from the live UI). Because they're vector + tokenised
 * to the same `--penn-navy` / `--penn-gold` palette as the app, they stay
 * crisp on every display and follow the brand if the theme is retuned.
 *
 * Each mock-up is intentionally a simplified, legible representation — the
 * goal is recognition ("oh, that's the page I'm on"), not pixel-perfect
 * reproduction. Every frame carries an accessible <title> so screen-reader
 * users get the same "what am I looking at" context as sighted users.
 */

// Brand palette, mirrored from the HSL tokens in index.css so the SVG
// presentation attributes (which can't read CSS custom properties
// reliably across all engines) render in-brand.
const C = {
  navy: "#20436f",
  navyDeep: "#1f3a5c",
  navySoft: "#2e5687",
  gold: "#f4b942",
  goldDeep: "#ce7f09",
  goldSoft: "#fcefc9",
  ink: "#1f2937",
  sub: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  bg: "#f6f8fb",
  panel: "#ffffff",
  green: "#16a34a",
  greenSoft: "#dcfce7",
  blueSoft: "#eef4fb",
} as const;

// ── Chrome frames ──────────────────────────────────────────────────────

function BrowserChrome({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 shadow-lg bg-white ring-1 ring-black/[0.02]">
      <div className="flex items-center gap-2 px-3 py-2 bg-[hsl(var(--penn-navy))]/[0.04] border-b border-border/50">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="mx-auto max-w-[78%] truncate rounded-md bg-white border border-border/60 px-2.5 py-1 text-[10px] sm:text-[11px] text-muted-foreground text-center font-mono">
            {url}
          </div>
        </div>
        <span className="w-8 hidden sm:block" aria-hidden="true" />
      </div>
      <div className="bg-[#f6f8fb]">{children}</div>
    </div>
  );
}

function PhoneChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[280px] rounded-[2rem] border-[6px] border-[hsl(var(--penn-navy))]/15 bg-white shadow-xl overflow-hidden">
      <div className="relative bg-[#f6f8fb]">
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 h-4 w-24 rounded-b-2xl bg-[hsl(var(--penn-navy))]/15 z-10"
          aria-hidden="true"
        />
        {children}
      </div>
    </div>
  );
}

/**
 * Caption + frame wrapper. `frame="phone"` for mobile-only surfaces
 * (the on-device fitter capture), otherwise the desktop browser chrome.
 */
export function Screenshot({
  caption,
  url = "pennpaps.com",
  frame = "browser",
  children,
}: {
  caption?: React.ReactNode;
  url?: string;
  frame?: "browser" | "phone";
  children: React.ReactNode;
}) {
  return (
    <figure className="my-1">
      {frame === "phone" ? (
        <PhoneChrome>{children}</PhoneChrome>
      ) : (
        <BrowserChrome url={url}>{children}</BrowserChrome>
      )}
      {caption ? (
        <figcaption className="mt-2.5 flex items-start gap-1.5 text-xs text-muted-foreground leading-relaxed">
          <span
            aria-hidden="true"
            className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[hsl(var(--penn-gold))]"
          />
          <span>{caption}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

// ── Small SVG primitives shared by the mock-ups ───────────────────────

/** The PennPaps top bar drawn inside a screen mock-up. */
function AppHeader({ active }: { active?: string }) {
  const items = ["Fitter", "Masks", "Shop", "Learn", "Help"];
  return (
    <g>
      <rect x="0" y="0" width="800" height="44" fill={C.panel} />
      <rect x="0" y="43.5" width="800" height="1" fill={C.line} />
      <circle cx="26" cy="22" r="9" fill={C.navy} />
      <text x="42" y="26" fontSize="13" fontWeight="700" fill={C.navy}>
        PennPaps
      </text>
      {items.map((label, i) => {
        const x = 470 + i * 62;
        const on = label === active;
        return (
          <g key={label}>
            <text
              x={x}
              y="26"
              fontSize="11"
              fontWeight={on ? 700 : 500}
              fill={on ? C.navy : C.sub}
            >
              {label}
            </text>
            {on ? (
              <rect
                x={x}
                y="32"
                width={label.length * 6.2}
                height="2.5"
                rx="1.25"
                fill={C.gold}
              />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

/** A pill-shaped button. */
function Btn({
  x,
  y,
  w = 120,
  h = 26,
  label,
  variant = "primary",
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  variant?: "primary" | "gold" | "outline";
}) {
  const fill =
    variant === "primary" ? C.navy : variant === "gold" ? C.gold : C.panel;
  const stroke = variant === "outline" ? C.line : "none";
  const text =
    variant === "gold" ? C.navyDeep : variant === "outline" ? C.navy : "#fff";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={h / 2}
        fill={fill}
        stroke={stroke}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 4}
        fontSize="11"
        fontWeight="700"
        fill={text}
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
}

/** A short line of placeholder "text". */
function Line({
  x,
  y,
  w,
  h = 6,
  color = C.line,
  rx = 3,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  color?: string;
  rx?: number;
}) {
  return <rect x={x} y={y} width={w} height={h} rx={rx} fill={color} />;
}

const svgProps = {
  className: "w-full h-auto block",
  preserveAspectRatio: "xMidYMid meet",
} as const;

// ── Screen mock-ups ───────────────────────────────────────────────────

/** Privacy & consent screen that opens the fitter. */
export function ConsentShot() {
  return (
    <svg viewBox="0 0 800 440" role="img" {...svgProps}>
      <title>
        The privacy &amp; consent screen that starts the mask fitter
      </title>
      <rect width="800" height="440" fill={C.bg} />
      <AppHeader active="Fitter" />
      <rect x="180" y="78" width="440" height="320" rx="16" fill={C.panel} />
      <rect
        x="180"
        y="78"
        width="440"
        height="320"
        rx="16"
        fill="none"
        stroke={C.line}
      />
      <circle cx="400" cy="138" r="26" fill={C.goldSoft} />
      <path
        d="M400 122l16 7v11c0 10-7 17-16 20-9-3-16-10-16-20v-11z"
        fill={C.goldDeep}
      />
      <text
        x="400"
        y="190"
        fontSize="17"
        fontWeight="800"
        fill={C.navy}
        textAnchor="middle"
      >
        Your photo never leaves your device
      </text>
      <Line x={250} y={210} w={300} color={C.line} />
      <Line x={280} y={224} w={240} color={C.line} />
      <rect x={230} y={252} width={340} height={36} rx="8" fill={C.blueSoft} />
      <rect x={244} y={262} width={16} height={16} rx="4" fill={C.navy} />
      <Line x={272} y={266} w={250} color="#cdd9e8" />
      <rect x={230} y={296} width={340} height={36} rx="8" fill={C.blueSoft} />
      <rect x={244} y={306} width={16} height={16} rx="4" fill={C.navy} />
      <Line x={272} y={310} w={210} color="#cdd9e8" />
      <Btn
        x={230}
        y={350}
        w={340}
        h={32}
        label="I agree — continue"
        variant="gold"
      />
    </svg>
  );
}

/** On-device face-capture screen (phone). */
export function FitterCaptureShot() {
  return (
    <svg viewBox="0 0 280 460" role="img" {...svgProps}>
      <title>The on-device camera capture screen of the mask fitter</title>
      <rect width="280" height="460" fill={C.navyDeep} />
      <text
        x="140"
        y="34"
        fontSize="12"
        fontWeight="700"
        fill="#fff"
        textAnchor="middle"
      >
        Center your face
      </text>
      {/* camera viewport */}
      <rect x="30" y="52" width="220" height="300" rx="18" fill="#0c1f38" />
      <ellipse
        cx="140"
        cy="196"
        rx="74"
        ry="98"
        fill="none"
        stroke={C.gold}
        strokeWidth="3"
        strokeDasharray="8 7"
      />
      {/* simple face */}
      <circle cx="140" cy="186" r="58" fill="#1b3556" />
      <circle cx="120" cy="176" r="5" fill="#9fb4d0" />
      <circle cx="160" cy="176" r="5" fill="#9fb4d0" />
      <path
        d="M138 188v18"
        stroke="#9fb4d0"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M124 214q16 12 32 0"
        stroke="#9fb4d0"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      {/* landmark dots */}
      {[
        [112, 158],
        [168, 158],
        [140, 224],
        [104, 196],
        [176, 196],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="2.5" fill={C.gold} />
      ))}
      <rect x="30" y="368" width="220" height="26" rx="13" fill="#13294a" />
      <text x="140" y="385" fontSize="10" fill="#bcd0ea" textAnchor="middle">
        Good lighting · hold steady
      </text>
      <circle cx="140" cy="424" r="22" fill="#fff" />
      <circle cx="140" cy="424" r="17" fill={C.gold} />
    </svg>
  );
}

/** Mask recommendation results. */
export function FitterResultsShot() {
  return (
    <svg viewBox="0 0 800 460" role="img" {...svgProps}>
      <title>Your ranked mask recommendations after the fitter completes</title>
      <rect width="800" height="460" fill={C.bg} />
      <AppHeader active="Fitter" />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Your top matches
      </text>
      <Line x={40} y={96} w={300} color={C.line} />
      {[0, 1, 2].map((i) => {
        const x = 40 + i * 245;
        const best = i === 0;
        return (
          <g key={i}>
            <rect
              x={x}
              y={120}
              width={225}
              height={300}
              rx="14"
              fill={C.panel}
              stroke={best ? C.gold : C.line}
              strokeWidth={best ? 2 : 1}
            />
            {best ? (
              <>
                <rect
                  x={x + 14}
                  y={134}
                  width={92}
                  height={20}
                  rx="10"
                  fill={C.gold}
                />
                <text
                  x={x + 60}
                  y={148}
                  fontSize="10"
                  fontWeight="800"
                  fill={C.navyDeep}
                  textAnchor="middle"
                >
                  BEST FIT
                </text>
              </>
            ) : null}
            <rect
              x={x + 50}
              y={166}
              width={125}
              height={92}
              rx="10"
              fill={C.blueSoft}
            />
            <ellipse cx={x + 112} cy={212} rx="42" ry="30" fill="#cdd9e8" />
            <text
              x={x + 16}
              y={286}
              fontSize="13"
              fontWeight="700"
              fill={C.ink}
            >
              Mask model {i + 1}
            </text>
            <Line x={x + 16} y={298} w={150} color={C.line} />
            <text
              x={x + 16}
              y={326}
              fontSize="11"
              fill={C.green}
              fontWeight="700"
            >
              {95 - i * 6}% match
            </text>
            <Line x={x + 16} y={340} w={180} color={C.line} />
            <Line x={x + 16} y={352} w={150} color={C.line} />
            <Btn
              x={x + 16}
              y={374}
              w={193}
              h={30}
              label={best ? "Choose this mask" : "View details"}
              variant={best ? "gold" : "outline"}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** The order form. */
export function OrderFormShot() {
  return (
    <svg viewBox="0 0 800 470" role="img" {...svgProps}>
      <title>
        The order form where you enter shipping, insurance and prescription
        details
      </title>
      <rect width="800" height="470" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Complete your order
      </text>
      {/* left: form */}
      <rect
        x={40}
        y={104}
        width={460}
        height={336}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      {[
        ["Full name", 124],
        ["Shipping address", 178],
        ["Insurance provider & member ID", 232],
        ["Prescription on file?", 286],
      ].map(([label, y]) => (
        <g key={label as string}>
          <text
            x={60}
            y={(y as number) - 6}
            fontSize="11"
            fontWeight="600"
            fill={C.sub}
          >
            {label}
          </text>
          <rect
            x={60}
            y={y as number}
            width={420}
            height={30}
            rx="7"
            fill={C.bg}
            stroke={C.line}
          />
        </g>
      ))}
      <rect
        x={60}
        y={286}
        width={420}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <circle
        cx={78}
        cy={301}
        r="7"
        fill="none"
        stroke={C.navy}
        strokeWidth="2"
      />
      <circle cx={78} cy={301} r="3.5" fill={C.navy} />
      <text x={94} y={305} fontSize="11" fill={C.ink}>
        Yes — PennPaps has it on file
      </text>
      <Btn x={60} y={340} w={420} h={34} label="Submit order" variant="gold" />
      {/* right: summary */}
      <rect x={520} y={104} width={240} height={336} rx="14" fill={C.navy} />
      <text x={540} y={134} fontSize="12" fontWeight="800" fill="#fff">
        Order summary
      </text>
      <rect x={540} y={150} width={200} height={70} rx="10" fill="#2a4d78" />
      <ellipse cx={576} cy={185} rx="22" ry="16" fill="#cdd9e8" />
      <Line x={612} y={170} w={110} color="#5d7aa3" />
      <Line x={612} y={184} w={80} color="#5d7aa3" />
      <Line x={612} y={198} w={95} color="#5d7aa3" />
      <Line x={540} y={252} w={120} color="#3c5e8a" />
      <Line x={540} y={272} w={170} color="#3c5e8a" />
      <Line x={540} y={292} w={140} color="#3c5e8a" />
      <rect x={540} y={326} width={200} height={1} fill="#3c5e8a" />
      <text x={540} y={356} fontSize="11" fill="#bcd0ea">
        Billed to insurance
      </text>
      <text
        x={723}
        y={356}
        fontSize="13"
        fontWeight="800"
        fill={C.gold}
        textAnchor="end"
      >
        $0
      </text>
    </svg>
  );
}

/** The supply shop grid. */
export function ShopShot() {
  return (
    <svg viewBox="0 0 800 460" role="img" {...svgProps}>
      <title>The CPAP supply shop with product cards and a cart icon</title>
      <rect width="800" height="460" fill={C.bg} />
      <AppHeader active="Shop" />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Shop CPAP supplies
      </text>
      <rect
        x={40}
        y={98}
        width={300}
        height={28}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <circle
        cx={58}
        cy={112}
        r="5"
        fill="none"
        stroke={C.sub}
        strokeWidth="2"
      />
      <text x={74} y={116} fontSize="10" fill={C.faint}>
        Search cushions, filters, tubing…
      </text>
      {/* cart pill */}
      <rect x={690} y={98} width={70} height={28} rx="14" fill={C.gold} />
      <text
        x={725}
        y={116}
        fontSize="11"
        fontWeight="800"
        fill={C.navyDeep}
        textAnchor="middle"
      >
        Cart · 2
      </text>
      {[0, 1, 2, 3].map((i) => {
        const col = i % 4;
        const x = 40 + col * 185;
        return (
          <g key={i}>
            <rect
              x={x}
              y={150}
              width={165}
              height={250}
              rx="12"
              fill={C.panel}
              stroke={C.line}
            />
            <rect
              x={x + 14}
              y={166}
              width={137}
              height={110}
              rx="8"
              fill={C.blueSoft}
            />
            <ellipse cx={x + 82} cy={221} rx="44" ry="30" fill="#cdd9e8" />
            <Line x={x + 14} y={292} w={120} color={C.line} />
            <Line x={x + 14} y={306} w={90} color={C.line} />
            <text
              x={x + 14}
              y={342}
              fontSize="13"
              fontWeight="800"
              fill={C.navy}
            >
              ${18 + i * 6}.00
            </text>
            <Btn
              x={x + 14}
              y={356}
              w={137}
              h={28}
              label="Add to cart"
              variant="outline"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** The cart / checkout review. */
export function CartShot() {
  return (
    <svg viewBox="0 0 800 440" role="img" {...svgProps}>
      <title>The shopping cart with line items and a checkout button</title>
      <rect width="800" height="440" fill={C.bg} />
      <AppHeader active="Shop" />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Your cart
      </text>
      <rect
        x={40}
        y={104}
        width={460}
        height={300}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      {[0, 1, 2].map((i) => {
        const y = 124 + i * 88;
        return (
          <g key={i}>
            <rect
              x={58}
              y={y}
              width={70}
              height={56}
              rx="8"
              fill={C.blueSoft}
            />
            <ellipse cx={93} cy={y + 28} rx="22" ry="15" fill="#cdd9e8" />
            <Line x={146} y={y + 12} w={180} color={C.line} />
            <Line x={146} y={y + 28} w={120} color={C.line} />
            {/* qty stepper */}
            <rect
              x={146}
              y={y + 38}
              width={70}
              height={20}
              rx="10"
              fill={C.bg}
              stroke={C.line}
            />
            <text
              x={181}
              y={y + 52}
              fontSize="10"
              fill={C.ink}
              textAnchor="middle"
            >
              − 1 +
            </text>
            <text
              x={482}
              y={y + 30}
              fontSize="13"
              fontWeight="800"
              fill={C.navy}
              textAnchor="end"
            >
              ${(18 + i * 6).toFixed(2)}
            </text>
            {i < 2 ? (
              <rect x={58} y={y + 74} width={424} height={1} fill={C.line} />
            ) : null}
          </g>
        );
      })}
      {/* summary */}
      <rect
        x={520}
        y={104}
        width={240}
        height={300}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <text x={540} y={132} fontSize="12" fontWeight="800" fill={C.navy}>
        Summary
      </text>
      <Line x={540} y={158} w={90} color={C.line} />
      <Line x={690} y={158} w={50} color={C.line} />
      <Line x={540} y={186} w={70} color={C.line} />
      <Line x={700} y={186} w={40} color={C.line} />
      <rect x={540} y={214} width={200} height={1} fill={C.line} />
      <text x={540} y={244} fontSize="12" fontWeight="800" fill={C.ink}>
        Total
      </text>
      <text
        x={740}
        y={244}
        fontSize="14"
        fontWeight="800"
        fill={C.navy}
        textAnchor="end"
      >
        $60.00
      </text>
      <Btn x={540} y={266} w={200} h={34} label="Checkout" variant="gold" />
      <Btn
        x={540}
        y={310}
        w={200}
        h={30}
        label="Continue shopping"
        variant="outline"
      />
    </svg>
  );
}

/** Order confirmation / success. */
export function OrderSuccessShot() {
  return (
    <svg viewBox="0 0 800 400" role="img" {...svgProps}>
      <title>The order confirmation screen with your reference number</title>
      <rect width="800" height="400" fill={C.bg} />
      <AppHeader />
      <rect
        x={210}
        y={86}
        width={380}
        height={280}
        rx="16"
        fill={C.panel}
        stroke={C.line}
      />
      <circle cx="400" cy="150" r="30" fill={C.greenSoft} />
      <path
        d="M387 150l9 9 18-20"
        stroke={C.green}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="400"
        y="206"
        fontSize="17"
        fontWeight="800"
        fill={C.navy}
        textAnchor="middle"
      >
        Order confirmed
      </text>
      <rect x={280} y={224} width={240} height={34} rx="8" fill={C.blueSoft} />
      <text
        x="400"
        y="246"
        fontSize="12"
        fontWeight="700"
        fill={C.navy}
        textAnchor="middle"
      >
        Reference: PEN-4821
      </text>
      <Line x={290} y={278} w={220} color={C.line} />
      <Line x={320} y={292} w={160} color={C.line} />
      <Btn
        x={290}
        y={316}
        w={220}
        h={32}
        label="Track this order"
        variant="primary"
      />
    </svg>
  );
}

/** The track-order lookup form + status. */
export function TrackOrderShot() {
  return (
    <svg viewBox="0 0 800 420" role="img" {...svgProps}>
      <title>
        The order-tracking page showing the delivery status timeline
      </title>
      <rect width="800" height="420" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Track your order
      </text>
      <rect
        x={40}
        y={104}
        width={300}
        height={250}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <text x={60} y={134} fontSize="11" fontWeight="600" fill={C.sub}>
        Order reference
      </text>
      <rect
        x={60}
        y={142}
        width={260}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <text x={70} y={161} fontSize="11" fill={C.ink}>
        PEN-4821
      </text>
      <text x={60} y={196} fontSize="11" fontWeight="600" fill={C.sub}>
        Email
      </text>
      <rect
        x={60}
        y={204}
        width={260}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <text x={70} y={223} fontSize="11" fill={C.faint}>
        you@email.com
      </text>
      <Btn x={60} y={252} w={260} h={32} label="Find my order" variant="gold" />
      {/* status timeline */}
      <rect
        x={360}
        y={104}
        width={400}
        height={250}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <text x={384} y={134} fontSize="12" fontWeight="800" fill={C.navy}>
        Status
      </text>
      {[
        ["Order received", true],
        ["Insurance verified", true],
        ["Shipped", true],
        ["Out for delivery", false],
        ["Delivered", false],
      ].map(([label, done], i) => {
        const cy = 168 + i * 36;
        return (
          <g key={label as string}>
            {i < 4 ? (
              <rect
                x={397}
                y={cy}
                width="2"
                height="36"
                fill={done ? C.green : C.line}
              />
            ) : null}
            <circle
              cx={398}
              cy={cy}
              r="8"
              fill={done ? C.green : C.panel}
              stroke={done ? C.green : C.line}
              strokeWidth="2"
            />
            {done ? (
              <path
                d={`M394 ${cy}l3 3 5-6`}
                stroke="#fff"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            <text
              x={418}
              y={cy + 4}
              fontSize="11"
              fontWeight={done ? 700 : 500}
              fill={done ? C.ink : C.faint}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Sign-in screen. */
export function SignInShot() {
  return (
    <svg viewBox="0 0 800 400" role="img" {...svgProps}>
      <title>The customer sign-in screen</title>
      <rect width="800" height="400" fill={C.bg} />
      <AppHeader />
      <rect
        x={250}
        y={82}
        width={300}
        height={290}
        rx="16"
        fill={C.panel}
        stroke={C.line}
      />
      <circle cx="400" cy="124" r="16" fill={C.navy} />
      <text
        x="400"
        y="166"
        fontSize="15"
        fontWeight="800"
        fill={C.navy}
        textAnchor="middle"
      >
        Welcome back
      </text>
      <text x={272} y={194} fontSize="11" fontWeight="600" fill={C.sub}>
        Email
      </text>
      <rect
        x={272}
        y={202}
        width={256}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <text x={272} y={252} fontSize="11" fontWeight="600" fill={C.sub}>
        Password
      </text>
      <rect
        x={272}
        y={260}
        width={256}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <Btn x={272} y={304} w={256} h={32} label="Sign in" variant="gold" />
      <text x="400" y="358" fontSize="10" fill={C.sub} textAnchor="middle">
        New here? Create an account
      </text>
    </svg>
  );
}

/** Account dashboard. */
export function AccountShot() {
  return (
    <svg viewBox="0 0 800 440" role="img" {...svgProps}>
      <title>Your account dashboard with saved details and order history</title>
      <rect width="800" height="440" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        My account
      </text>
      {/* sidebar */}
      <rect
        x={40}
        y={104}
        width={180}
        height={300}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      {["Profile", "Orders", "Addresses", "Billing", "Reminders"].map(
        (label, i) => {
          const y = 122 + i * 44;
          const on = i === 1;
          return (
            <g key={label}>
              {on ? (
                <rect
                  x={52}
                  y={y}
                  width={156}
                  height={30}
                  rx="8"
                  fill={C.blueSoft}
                />
              ) : null}
              {on ? (
                <rect
                  x={52}
                  y={y}
                  width={3}
                  height={30}
                  rx="1.5"
                  fill={C.gold}
                />
              ) : null}
              <text
                x={66}
                y={y + 20}
                fontSize="11"
                fontWeight={on ? 800 : 500}
                fill={on ? C.navy : C.sub}
              >
                {label}
              </text>
            </g>
          );
        },
      )}
      {/* main: order history */}
      <rect
        x={240}
        y={104}
        width={520}
        height={300}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <text x={262} y={134} fontSize="12" fontWeight="800" fill={C.navy}>
        Order history
      </text>
      {[0, 1, 2].map((i) => {
        const y = 152 + i * 78;
        return (
          <g key={i}>
            <rect
              x={262}
              y={y}
              width={476}
              height={64}
              rx="10"
              fill={C.bg}
              stroke={C.line}
            />
            <rect
              x={276}
              y={y + 12}
              width={48}
              height={40}
              rx="6"
              fill={C.blueSoft}
            />
            <Line x={338} y={y + 16} w={150} color={C.line} />
            <Line x={338} y={y + 32} w={110} color={C.line} />
            <rect
              x={338}
              y={y + 42}
              width={70}
              height={14}
              rx="7"
              fill={C.greenSoft}
            />
            <text
              x={373}
              y={y + 52}
              fontSize="8"
              fontWeight="700"
              fill={C.green}
              textAnchor="middle"
            >
              Delivered
            </text>
            <Btn
              x={620}
              y={y + 18}
              w={104}
              h={28}
              label="Reorder"
              variant="outline"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Resupply reminders setup. */
export function RemindersShot() {
  return (
    <svg viewBox="0 0 800 430" role="img" {...svgProps}>
      <title>
        The resupply reminders screen with channel toggles and a schedule
      </title>
      <rect width="800" height="430" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Resupply reminders
      </text>
      <rect
        x={40}
        y={104}
        width={350}
        height={290}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <text x={60} y={134} fontSize="12" fontWeight="800" fill={C.navy}>
        How should we reach you?
      </text>
      {[
        ["Text message (SMS)", true],
        ["Email", true],
        ["Phone call", false],
      ].map(([label, on], i) => {
        const y = 156 + i * 50;
        return (
          <g key={label as string}>
            <rect
              x={60}
              y={y}
              width={310}
              height={38}
              rx="9"
              fill={C.bg}
              stroke={C.line}
            />
            <text x={78} y={y + 24} fontSize="11" fontWeight="600" fill={C.ink}>
              {label}
            </text>
            <rect
              x={326}
              y={y + 10}
              width={32}
              height={18}
              rx="9"
              fill={on ? C.green : "#cbd5e1"}
            />
            <circle cx={on ? 349 : 335} cy={y + 19} r="7" fill="#fff" />
          </g>
        );
      })}
      <Btn
        x={60}
        y={330}
        w={310}
        h={32}
        label="Save preferences"
        variant="gold"
      />
      {/* schedule preview */}
      <rect x={410} y={104} width={350} height={290} rx="14" fill={C.navy} />
      <text x={432} y={134} fontSize="12" fontWeight="800" fill="#fff">
        Your next replacements
      </text>
      {[
        ["Mask cushion", "in 9 days"],
        ["Headgear", "in 3 weeks"],
        ["Tubing", "in 6 weeks"],
        ["Filters", "in 2 weeks"],
      ].map(([item, when], i) => {
        const y = 156 + i * 52;
        return (
          <g key={item as string}>
            <rect x={432} y={y} width={306} height={40} rx="9" fill="#2a4d78" />
            <circle cx={456} cy={y + 20} r="9" fill={C.gold} />
            <text x={480} y={y + 24} fontSize="11" fontWeight="700" fill="#fff">
              {item}
            </text>
            <text
              x={722}
              y={y + 24}
              fontSize="10"
              fill={C.goldSoft}
              textAnchor="end"
            >
              {when}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Insurance estimate result. */
export function InsuranceEstimateShot() {
  return (
    <svg viewBox="0 0 800 420" role="img" {...svgProps}>
      <title>
        The insurance estimate result showing your projected out-of-pocket cost
      </title>
      <rect width="800" height="420" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Insurance estimate
      </text>
      {/* form */}
      <rect
        x={40}
        y={104}
        width={330}
        height={280}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      {[
        ["Insurance provider", 134],
        ["Plan type", 196],
        ["Deductible met?", 258],
      ].map(([label, y]) => (
        <g key={label as string}>
          <text
            x={60}
            y={(y as number) - 6}
            fontSize="11"
            fontWeight="600"
            fill={C.sub}
          >
            {label}
          </text>
          <rect
            x={60}
            y={y as number}
            width={290}
            height={30}
            rx="7"
            fill={C.bg}
            stroke={C.line}
          />
        </g>
      ))}
      <Btn
        x={60}
        y={320}
        w={290}
        h={32}
        label="Estimate my cost"
        variant="gold"
      />
      {/* result */}
      <rect
        x={390}
        y={104}
        width={370}
        height={280}
        rx="14"
        fill={C.panel}
        stroke={C.gold}
        strokeWidth="2"
      />
      <text x={414} y={136} fontSize="12" fontWeight="800" fill={C.navy}>
        Your estimate
      </text>
      <text
        x="575"
        y="206"
        fontSize="40"
        fontWeight="800"
        fill={C.navy}
        textAnchor="middle"
      >
        $0–$25
      </text>
      <text x="575" y="232" fontSize="11" fill={C.sub} textAnchor="middle">
        estimated out-of-pocket / mask
      </text>
      <rect x={414} y={258} width={322} height={1} fill={C.line} />
      <Line x={414} y={278} w={180} color={C.line} />
      <Line x={680} y={278} w={56} color={C.line} />
      <Line x={414} y={302} w={150} color={C.line} />
      <Line x={690} y={302} w={46} color={C.line} />
      <text x={414} y={350} fontSize="9" fill={C.faint}>
        Estimate only — we confirm exact cost before shipping.
      </text>
    </svg>
  );
}

/** Returns request. */
export function ReturnsShot() {
  return (
    <svg viewBox="0 0 800 400" role="img" {...svgProps}>
      <title>The returns and refunds request screen</title>
      <rect width="800" height="400" fill={C.bg} />
      <AppHeader />
      <text x="40" y="82" fontSize="16" fontWeight="800" fill={C.navy}>
        Returns &amp; refunds
      </text>
      <rect
        x={40}
        y={104}
        width={720}
        height={260}
        rx="14"
        fill={C.panel}
        stroke={C.line}
      />
      <rect x={60} y={124} width={340} height={56} rx="10" fill={C.greenSoft} />
      <circle cx={88} cy={152} r="12" fill="#fff" />
      <path
        d="M82 152l4 4 8-9"
        stroke={C.green}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x={110} y={148} fontSize="11" fontWeight="800" fill={C.green}>
        60-day comfort guarantee
      </text>
      <text x={110} y={166} fontSize="10" fill="#15803d">
        Exchange your mask if the fit isn&apos;t right.
      </text>
      <text x={60} y={210} fontSize="11" fontWeight="600" fill={C.sub}>
        Which order?
      </text>
      <rect
        x={60}
        y={218}
        width={340}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <text x={60} y={272} fontSize="11" fontWeight="600" fill={C.sub}>
        Reason for return
      </text>
      <rect
        x={60}
        y={280}
        width={680}
        height={50}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <Btn
        x={420}
        y={210}
        w={320}
        h={48}
        label="Start a return"
        variant="gold"
      />
    </svg>
  );
}

/** Forgot-password request screen. */
export function PasswordResetShot() {
  return (
    <svg viewBox="0 0 800 400" role="img" {...svgProps}>
      <title>
        The forgot-password screen where you request a secure reset link
      </title>
      <rect width="800" height="400" fill={C.bg} />
      <AppHeader />
      <rect
        x={250}
        y={86}
        width={300}
        height={250}
        rx="16"
        fill={C.panel}
        stroke={C.line}
      />
      <circle cx="400" cy="128" r="18" fill={C.goldSoft} />
      <path
        d="M392 128v-6a8 8 0 0116 0v6"
        fill="none"
        stroke={C.goldDeep}
        strokeWidth="3"
      />
      <rect x={390} y={126} width={20} height={15} rx="2.5" fill={C.goldDeep} />
      <text
        x="400"
        y="178"
        fontSize="15"
        fontWeight="800"
        fill={C.navy}
        textAnchor="middle"
      >
        Reset your password
      </text>
      <text x="400" y="200" fontSize="11" fill={C.sub} textAnchor="middle">
        We&apos;ll email you a secure link.
      </text>
      <text x={272} y={232} fontSize="11" fontWeight="600" fill={C.sub}>
        Email
      </text>
      <rect
        x={272}
        y={240}
        width={256}
        height={30}
        rx="7"
        fill={C.bg}
        stroke={C.line}
      />
      <Btn
        x={272}
        y={286}
        w={256}
        h={32}
        label="Email me a reset link"
        variant="gold"
      />
    </svg>
  );
}

/** Wishlist with saved items and a reorder/add affordance. */
export function WishlistShot() {
  return (
    <svg viewBox="0 0 800 440" role="img" {...svgProps}>
      <title>Your saved wishlist items, each with an add-to-cart button</title>
      <rect width="800" height="440" fill={C.bg} />
      <AppHeader active="Shop" />
      <g>
        <path
          d="M52 78c-4-5-12-5-12 2 0 6 12 12 12 12s12-6 12-12c0-7-8-7-12-2z"
          fill={C.gold}
        />
        <text x="74" y="84" fontSize="16" fontWeight="800" fill={C.navy}>
          Your wishlist
        </text>
      </g>
      {[0, 1, 2].map((i) => {
        const y = 110 + i * 100;
        return (
          <g key={i}>
            <rect
              x={40}
              y={y}
              width={720}
              height={84}
              rx="12"
              fill={C.panel}
              stroke={C.line}
            />
            <rect
              x={56}
              y={y + 14}
              width={72}
              height={56}
              rx="8"
              fill={C.blueSoft}
            />
            <ellipse cx={92} cy={y + 42} rx="24" ry="16" fill="#cdd9e8" />
            <Line x={148} y={y + 24} w={220} color={C.line} />
            <Line x={148} y={y + 42} w={160} color={C.line} />
            <text
              x={148}
              y={y + 66}
              fontSize="13"
              fontWeight="800"
              fill={C.navy}
            >
              ${18 + i * 7}.00
            </text>
            <Btn
              x={560}
              y={y + 28}
              w={180}
              h={30}
              label="Add to cart"
              variant="gold"
            />
            {/* remove (heart) */}
            <path
              d={`M540 ${y + 38}c-3-4-9-4-9 1.5 0 4.5 9 9 9 9s9-4.5 9-9c0-5.5-6-5.5-9-1.5z`}
              fill={C.gold}
            />
          </g>
        );
      })}
    </svg>
  );
}

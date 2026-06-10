#!/usr/bin/env python3
"""Build the PennFit "Platform Feature Guide by Role" PDF.

Generates docs/feature-guide/PennFit-Feature-Guide-by-Role.pdf from the
CONTENT structure below. Brand colors mirror the storefront theme tokens
in artifacts/cpap-fitter/src/index.css.

Usage:  python3 docs/feature-guide/build_feature_guide.py
"""

import colorsys
import os
from datetime import date

from reportlab.lib.colors import Color, white
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "PennFit-Feature-Guide-by-Role.pdf")

# ---------------------------------------------------------------- brand --


def hsl(h, s, l):
    """CSS hsl(h s% l%) -> reportlab Color."""
    r, g, b = colorsys.hls_to_rgb(h / 360.0, l / 100.0, s / 100.0)
    return Color(r, g, b)


ONYX = hsl(215, 60, 10)
NAVY_DEEP = hsl(213, 50, 24)
NAVY = hsl(213, 55, 28)
NAVY_SOFT = hsl(213, 49, 38)
GOLD = hsl(42, 92, 56)
GOLD_DEEP = hsl(36, 92, 42)
GOLD_SOFT = hsl(44, 95, 88)
PLATINUM = hsl(214, 18, 86)
PEARL = hsl(210, 30, 99)
MIST = hsl(213, 30, 95)
STEEL = hsl(210, 50, 42)
INK = hsl(215, 35, 18)
BODY_GRAY = hsl(215, 15, 30)

PAGE_W, PAGE_H = letter
MARGIN_X = 0.85 * inch
MARGIN_TOP = 0.95 * inch
MARGIN_BOTTOM = 0.85 * inch
CONTENT_W = PAGE_W - 2 * MARGIN_X

# --------------------------------------------------------------- styles --

S_BODY = ParagraphStyle(
    "body", fontName="Helvetica", fontSize=9.5, leading=13.5,
    textColor=BODY_GRAY, alignment=TA_LEFT, spaceAfter=6,
)
S_INTRO = ParagraphStyle(
    "intro", parent=S_BODY, fontSize=10, leading=15, textColor=INK,
)
S_FEATURE_NAME = ParagraphStyle(
    "featureName", fontName="Helvetica-Bold", fontSize=9.5, leading=12.5,
    textColor=NAVY_DEEP,
)
S_FEATURE_DESC = ParagraphStyle(
    "featureDesc", fontName="Helvetica", fontSize=9.5, leading=12.5,
    textColor=BODY_GRAY,
)
S_GROUP = ParagraphStyle(
    "group", fontName="Helvetica-Bold", fontSize=11, leading=14,
    textColor=NAVY, spaceBefore=14, spaceAfter=0,
)
S_H1 = ParagraphStyle(
    "h1", fontName="Helvetica-Bold", fontSize=17, leading=21,
    textColor=NAVY_DEEP, spaceAfter=10,
)
S_MISSION = ParagraphStyle(
    "mission", fontName="Helvetica-Oblique", fontSize=10.5, leading=15,
    textColor=BODY_GRAY,
)
S_TOC_ROLE = ParagraphStyle(
    "tocRole", fontName="Helvetica-Bold", fontSize=10.5, leading=14,
    textColor=NAVY_DEEP,
)
S_TOC_DESC = ParagraphStyle(
    "tocDesc", fontName="Helvetica", fontSize=9, leading=12.5,
    textColor=BODY_GRAY,
)


# ------------------------------------------------------------ flowables --


class SectionMarker(Flowable):
    """Invisible flowable that updates the running-header section name."""

    def __init__(self, name):
        super().__init__()
        self.name = name
        self.width = 0
        self.height = 0

    def draw(self):
        self.canv._pennfit_section = self.name


class RoleBanner(Flowable):
    """Full-width navy banner that opens a role section."""

    def __init__(self, kicker, title, mission, accent=GOLD):
        super().__init__()
        self.kicker = kicker
        self.title = title
        self.mission = mission
        self.accent = accent
        self.width = CONTENT_W
        self.height = 1.42 * inch

    def draw(self):
        c = self.canv
        w, h = self.width, self.height
        c.saveState()
        # banner panel
        c.setFillColor(NAVY_DEEP)
        c.roundRect(0, 0, w, h, 6, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.roundRect(0, 0, w, h - 0.16 * inch, 6, stroke=0, fill=1)
        # gold accent bar
        c.setFillColor(self.accent)
        c.rect(0.32 * inch, h - 0.52 * inch, 0.30 * inch, 0.045 * inch, stroke=0, fill=1)
        # kicker
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 8.5)
        c.drawString(0.72 * inch, h - 0.535 * inch, self.kicker.upper())
        # title
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 21)
        c.drawString(0.32 * inch, h - 0.92 * inch, self.title)
        # mission line
        c.setFillColor(GOLD_SOFT)
        c.setFont("Helvetica-Oblique", 9.5)
        c.drawString(0.32 * inch, h - 1.22 * inch, self.mission)
        c.restoreState()


class GroupHeading(Flowable):
    """Gold square + bold heading + hairline, drawn on one baseline."""

    def __init__(self, text):
        super().__init__()
        self.text = text
        self.width = CONTENT_W
        self.height = 26

    def draw(self):
        c = self.canv
        c.saveState()
        baseline = 6
        c.setFillColor(GOLD_DEEP)
        c.rect(0, baseline + 0.5, 6, 6, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(12, baseline, self.text)
        tw = c.stringWidth(self.text, "Helvetica-Bold", 11)
        c.setStrokeColor(PLATINUM)
        c.setLineWidth(0.7)
        c.line(12 + tw + 10, baseline + 3.2, self.width, baseline + 3.2)
        c.restoreState()


def feature_table(features, tint_offset=0, rule_after_last=False):
    """Two-column feature table with alternating row tints."""
    rows = []
    for name, desc in features:
        rows.append([Paragraph(name, S_FEATURE_NAME), Paragraph(desc, S_FEATURE_DESC)])
    t = Table(rows, colWidths=[1.85 * inch, CONTENT_W - 1.85 * inch], hAlign="LEFT")
    rule_end = -1 if rule_after_last else -2
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 8),
        ("RIGHTPADDING", (0, 0), (0, -1), 10),
        ("LEFTPADDING", (1, 0), (1, -1), 4),
        ("RIGHTPADDING", (1, 0), (1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    if len(rows) + (1 if rule_after_last else 0) > 1:
        style.append(("LINEBELOW", (0, 0), (-1, rule_end), 0.5, PLATINUM))
    for i in range(len(rows)):
        if (i + tint_offset) % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), PEARL))
        else:
            style.append(("BACKGROUND", (0, i), (-1, i), MIST))
    t.setStyle(TableStyle(style))
    return t


class Marker(Flowable):
    """Comparison-matrix cell marker: full / half / open circle."""

    R = 3.4

    def __init__(self, kind):
        super().__init__()
        self.kind = kind
        self.width = 12
        self.height = 9
        self.hAlign = "CENTER"

    def draw(self):
        c = self.canv
        x, y, r = self.width / 2.0, self.height / 2.0, self.R
        c.saveState()
        if self.kind == "full":
            c.setFillColor(NAVY)
            c.setStrokeColor(NAVY)
            c.circle(x, y, r, stroke=1, fill=1)
        elif self.kind == "half":
            c.setFillColor(NAVY_SOFT)
            c.wedge(x - r, y - r, x + r, y + r, 90, 180, stroke=0, fill=1)
            c.setStrokeColor(STEEL)
            c.setLineWidth(0.9)
            c.circle(x, y, r, stroke=1, fill=0)
        else:
            c.setStrokeColor(STEEL)
            c.setLineWidth(0.9)
            c.circle(x, y, r, stroke=1, fill=0)
        c.restoreState()


def matrix_legend():
    items = [
        ("full", "Included natively"),
        ("half", "Partial, add-on, or via partner"),
        ("none", "Not offered / not core"),
    ]
    label = ParagraphStyle("legendLabel", fontName="Helvetica", fontSize=8,
                           leading=10, textColor=BODY_GRAY)
    cells, widths = [], []
    for kind, text in items:
        cells.extend([Marker(kind), Paragraph(text, label)])
        widths.extend([0.22 * inch, 1.85 * inch])
    t = Table([cells], colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def pricing_table(headers, rows):
    """Vendor-per-row pricing snapshot with text cells."""
    head_style = ParagraphStyle(
        "prHead", fontName="Helvetica-Bold", fontSize=7.4, leading=9,
        textColor=white)
    vendor_style = ParagraphStyle(
        "prVendor", fontName="Helvetica-Bold", fontSize=8, leading=10,
        textColor=NAVY_DEEP)
    cell_style = ParagraphStyle(
        "prCell", fontName="Helvetica", fontSize=8, leading=10,
        textColor=BODY_GRAY)
    data = [[Paragraph(h, head_style) for h in headers]]
    for vendor, model, price, impl in rows:
        data.append([
            Paragraph(vendor, vendor_style),
            Paragraph(model, cell_style),
            Paragraph(price, cell_style),
            Paragraph(impl, cell_style),
        ])
    t = Table(data, colWidths=[1.30 * inch, 1.85 * inch, 2.30 * inch,
                               CONTENT_W - 5.45 * inch],
              hAlign="LEFT", repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY_DEEP),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, PLATINUM),
    ]
    for i in range(1, len(data)):
        if data[i][0].text.startswith("PennFit"):
            style.append(("BACKGROUND", (0, i), (-1, i), GOLD_SOFT))
        elif i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), MIST))
        else:
            style.append(("BACKGROUND", (0, i), (-1, i), PEARL))
    t.setStyle(TableStyle(style))
    return t


def matrix_table(vendors, groups):
    """Competitive matrix with group bands and a repeating vendor header."""
    feature_w = 2.55 * inch
    vendor_w = (CONTENT_W - feature_w) / len(vendors)
    head_style = ParagraphStyle(
        "mxHead", fontName="Helvetica-Bold", fontSize=7.4, leading=9,
        textColor=white, alignment=TA_CENTER)
    feat_style = ParagraphStyle(
        "mxFeat", fontName="Helvetica", fontSize=8.5, leading=10.5,
        textColor=INK)
    group_style = ParagraphStyle(
        "mxGroup", fontName="Helvetica-Bold", fontSize=8, leading=10,
        textColor=NAVY_DEEP)

    data = [[Paragraph("Feature", ParagraphStyle(
        "mxHeadL", parent=head_style, alignment=TA_LEFT))] +
        [Paragraph(v, head_style) for v in vendors]]
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY_DEEP),
        ("BACKGROUND", (1, 0), (1, 0), GOLD_DEEP),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (0, -1), 8),
        ("RIGHTPADDING", (0, 0), (0, -1), 8),
        ("LEFTPADDING", (1, 0), (-1, -1), 2),
        ("RIGHTPADDING", (1, 0), (-1, -1), 2),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, PLATINUM),
    ]
    r = 1
    body_start = r
    for group_name, rows in groups:
        data.append([Paragraph(group_name.upper(), group_style)] +
                    [""] * len(vendors))
        style.extend([
            ("SPAN", (0, r), (-1, r)),
            ("BACKGROUND", (0, r), (-1, r), PLATINUM),
            ("TOPPADDING", (0, r), (-1, r), 3.5),
            ("BOTTOMPADDING", (0, r), (-1, r), 3.5),
        ])
        r += 1
        for label, marks in rows:
            data.append([Paragraph(label, feat_style)] +
                        [Marker(m) for m in marks])
            if (r - body_start) % 2 == 0:
                style.append(("BACKGROUND", (0, r), (-1, r), PEARL))
            else:
                style.append(("BACKGROUND", (0, r), (-1, r), MIST))
            # PennFit column tint sits on top of the row stripe
            style.append(("BACKGROUND", (1, r), (1, r), GOLD_SOFT))
            r += 1
    t = Table(data, colWidths=[feature_w] + [vendor_w] * len(vendors),
              hAlign="LEFT", repeatRows=1)
    t.setStyle(TableStyle(style))
    return t





def draw_cover(c, doc):
    c.saveState()
    # background
    c.setFillColor(ONYX)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setFillColor(NAVY_DEEP)
    c.rect(0, 0, PAGE_W, PAGE_H * 0.42, stroke=0, fill=1)
    c.setStrokeColor(GOLD)
    c.setLineWidth(1.2)
    c.line(0, PAGE_H * 0.42, PAGE_W, PAGE_H * 0.42)
    # subtle arcs
    c.setStrokeColor(NAVY_SOFT)
    c.setLineWidth(0.8)
    for r in (2.2, 2.9, 3.6):
        c.arc(PAGE_W - r * inch, PAGE_H - r * inch,
              PAGE_W + r * inch, PAGE_H + r * inch, 180, 90)
    # wordmark
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(MARGIN_X, PAGE_H - 1.55 * inch, "PennFit")
    c.setFillColor(GOLD)
    c.rect(MARGIN_X + 1.62 * inch, PAGE_H - 1.50 * inch, 0.10 * inch, 0.10 * inch,
           stroke=0, fill=1)
    c.setFillColor(GOLD_SOFT)
    c.setFont("Helvetica", 10.5)
    c.drawString(MARGIN_X, PAGE_H - 1.86 * inch,
                 "CPAP resupply & sleep-therapy commerce platform")
    # title block
    c.setFillColor(GOLD)
    c.rect(MARGIN_X, PAGE_H - 4.18 * inch, 0.62 * inch, 0.055 * inch, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 38)
    c.drawString(MARGIN_X, PAGE_H - 4.95 * inch, "Platform Feature Guide")
    c.setFillColor(PLATINUM)
    c.setFont("Helvetica", 16)
    c.drawString(MARGIN_X, PAGE_H - 5.38 * inch,
                 "Capabilities organized by operating role")
    # role chips
    chip_y = PAGE_H - 7.05 * inch
    c.setFont("Helvetica-Bold", 10)
    x = MARGIN_X
    for label in ("DME OWNER", "BILLER", "CUSTOMER SERVICE REP",
                  "RESPIRATORY THERAPIST"):
        tw = c.stringWidth(label, "Helvetica-Bold", 10)
        c.setStrokeColor(GOLD)
        c.setLineWidth(1)
        c.setFillColor(NAVY)
        c.roundRect(x, chip_y - 7, tw + 22, 24, 12, stroke=1, fill=1)
        c.setFillColor(GOLD_SOFT)
        c.drawString(x + 11, chip_y, label)
        x += tw + 34
    # footer
    c.setStrokeColor(GOLD)
    c.setLineWidth(1)
    c.line(MARGIN_X, 1.32 * inch, PAGE_W - MARGIN_X, 1.32 * inch)
    c.setFillColor(PLATINUM)
    c.setFont("Helvetica", 9.5)
    c.drawString(MARGIN_X, 1.06 * inch, DOC_DATE)
    c.drawRightString(PAGE_W - MARGIN_X, 1.06 * inch, "Internal training & reference")
    c.restoreState()


def draw_page(c, doc):
    section = getattr(c, "_pennfit_section", "")
    c.saveState()
    # header
    c.setFillColor(NAVY_DEEP)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(MARGIN_X, PAGE_H - 0.55 * inch, "PENNFIT")
    c.setFillColor(GOLD_DEEP)
    c.rect(MARGIN_X + 0.62 * inch, PAGE_H - 0.545 * inch, 4.2, 4.2, stroke=0, fill=1)
    c.setFillColor(STEEL)
    c.setFont("Helvetica", 8.5)
    c.drawString(MARGIN_X + 0.78 * inch, PAGE_H - 0.55 * inch,
                 "Platform Feature Guide")
    if section:
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 8.5)
        c.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 0.55 * inch, section)
    c.setStrokeColor(PLATINUM)
    c.setLineWidth(0.7)
    c.line(MARGIN_X, PAGE_H - 0.66 * inch, PAGE_W - MARGIN_X, PAGE_H - 0.66 * inch)
    # footer
    c.setStrokeColor(PLATINUM)
    c.line(MARGIN_X, 0.62 * inch, PAGE_W - MARGIN_X, 0.62 * inch)
    c.setFillColor(STEEL)
    c.setFont("Helvetica", 8.5)
    c.drawString(MARGIN_X, 0.44 * inch, DOC_DATE)
    c.setFillColor(NAVY_DEEP)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawRightString(PAGE_W - MARGIN_X, 0.44 * inch, f"Page {doc.page}")
    c.restoreState()


# ---------------------------------------------------------------- content --

DOC_DATE = date.today().strftime("%B %Y")

INTRO = (
    "PennFit is the operating platform for a modern CPAP/DME resupply "
    "business: one system that runs the patient storefront, the resupply "
    "program, clinical adherence work, the revenue cycle, and every patient "
    "conversation — voice, text, email, and chat — with AI working alongside "
    "staff at each step. This guide organizes the platform's capabilities "
    "around the four seats in a DME operation. Each section lists the "
    "features that role works in day to day, with a brief description of "
    "what each one does."
)

INTRO_2 = (
    "Access in PennFit is enforced by staff roles and thirty granular "
    "permissions, so each team member sees exactly the tools their job "
    "requires. Features below are listed under the role that uses them "
    "most; many are shared. The guide closes with Platform Foundations — "
    "the capabilities every role relies on — and a competitive matrix "
    "placing PennFit's top features beside the leading DME software."
)

STATS = [
    ("4", "operating roles"),
    ("100+", "admin screens"),
    ("9", "partner integrations"),
    ("24/7", "AI voice, chat &amp; email"),
]

ROLES = [
    {
        "kicker": "Role 01",
        "title": "DME Owner",
        "mission": "Run the business: visibility, performance, and control.",
        "summary": (
            "The owner's seat is about visibility and control: a live "
            "command center for today's business, financial analytics that "
            "show where margin is made and lost, levers for goals and "
            "staffing, and the switches that configure how the entire "
            "platform behaves — no developer required."
        ),
        "access": (
            "Typical access — administrator role: team management, system "
            "configuration, business targets, and cost analytics permissions."
        ),
        "groups": [
            ("Command Center & Business Health", [
                ("Today Dashboard",
                 "A day-at-a-glance home screen: revenue, compliance, and "
                 "contact-rate KPI tiles, today's worklist, team staffing, and "
                 "queue depth — the morning huddle on one page."),
                ("Billing Hub Overview",
                 "Executive revenue-cycle dashboard: A/R aging, days sales "
                 "outstanding, collections forecast, top payers, and denial "
                 "rate at a glance."),
                ("Goals &amp; Targets",
                 "Set KPI targets by period — revenue, orders, compliance — "
                 "and track pace-to-goal against actuals."),
                ("KPI Alerts",
                 "Automatic alerts when a metric such as revenue, denial "
                 "rate, or churn crosses a threshold you define; review the "
                 "alert feed and tune the rules."),
                ("Reports &amp; Exports",
                 "One-click reporting with CSV, PDF, and QuickBooks (IIF/QBO) "
                 "exports, plus saved presets for recurring reports."),
            ]),
            ("Growth & Financial Analytics", [
                ("Margin &amp; COGS",
                 "Gross-margin tracking overall and per product, with cost "
                 "captured at invoice time."),
                ("Revenue by Source",
                 "Order volume and cash by channel — storefront, resupply "
                 "program, or clinical referral."),
                ("LTV &amp; CAC",
                 "Customer lifetime value versus acquisition cost by channel, "
                 "with the ratio that shows where to invest."),
                ("Payer Profitability",
                 "Net yield by payer: billed versus allowed versus collected, "
                 "denial rates, and net-of-cost performance."),
                ("Inventory Turnover",
                 "Turnover per SKU (cost of goods sold against inventory "
                 "value), plus demand lost to stockouts."),
                ("Acquisition Funnel",
                 "Visitor drop-off from mask-fitter start through checkout, "
                 "showing exactly where prospects leave."),
                ("Outreach Attribution",
                 "Which outreach channels actually convert: the percentage of "
                 "contacted patients who went on to order, by channel."),
                ("Channel Engagement",
                 "SMS, email, chat, and phone response rates paired with "
                 "order conversion."),
                ("Customer NPS",
                 "Post-delivery satisfaction scores (1–10) with patient "
                 "comments and trend over time."),
                ("Storefront Analytics",
                 "Web-traffic and revenue analytics for the storefront, "
                 "including funnel events."),
            ]),
            ("Team & Performance", [
                ("Team Management",
                 "Invite staff, assign administrator or agent roles, tailor "
                 "thirty granular permissions per person, enforce MFA, and "
                 "deactivate accounts."),
                ("Team Throughput",
                 "Per-rep productivity: conversations closed, returns "
                 "approved, interventions resolved."),
                ("Live Staffing",
                 "Real-time view of open-conversation load per agent and the "
                 "overall backlog."),
                ("Calendar &amp; Closures",
                 "Shared team schedule, plus holiday and weather closures "
                 "that automatically tell texting patients you're closed."),
                ("Locations",
                 "Manage multiple branches and assign patients to a "
                 "servicing location."),
            ]),
            ("Platform Control & Configuration", [
                ("Control Center",
                 "Master on/off switches for major capabilities — voice "
                 "agent, campaigns, AI billing, email auto-reply — applied "
                 "instantly, with no deploy."),
                ("Settings &amp; Setup",
                 "Practice identity (name, contact, logo, service area) plus "
                 "a guided launch checklist covering every integration "
                 "credential."),
                ("Automation Rules",
                 "Build trigger-to-action rules (inbound keyword, order "
                 "placed, therapy event) and dry-run them in the rule tester "
                 "before going live."),
                ("Operations Health",
                 "Background-job health, queue depth, and connection status "
                 "for every partner integration, including nightly-sync "
                 "results."),
                ("Connection Tests",
                 "Send a real test email, SMS, or phone call to prove "
                 "credentials work before patients are affected."),
                ("Bot Playground",
                 "Rehearse the AI chat and voice agents against scripted "
                 "scenarios with synthetic data to tune behavior safely."),
                ("Webhook Deliveries",
                 "Monitor outbound event feeds to partner systems and "
                 "re-queue failed deliveries."),
            ]),
        ],
    },
    {
        "kicker": "Role 02",
        "title": "Biller",
        "mission": "Keep claims clean and cash flowing.",
        "summary": (
            "PennFit gives the biller a complete revenue-cycle cockpit: "
            "prioritized claim worklists with AI assistance, real-time "
            "eligibility, denial recovery ranked by dollars, full A/R and "
            "collections tooling, and direct connections to Office Ally, "
            "Da Vinci PAS prior authorization, and PacWare."
        ),
        "access": (
            "Typical access — agent role: billing worklists and tools, "
            "reports, and patient-update permissions."
        ),
        "groups": [
            ("Daily Claim Worklists", [
                ("AI Billing Queue",
                 "Claims blocked by the scrubber or flagged by the denial "
                 "analyzer, each with AI-suggested fixes and a one-click "
                 "resubmit."),
                ("Auto-Submit Queue",
                 "Scrubber-clean claims with verified eligibility, ready to "
                 "transmit in batch — approve manually or let the scheduler "
                 "send."),
                ("Bill Hold",
                 "Claims held from transmission until required paperwork "
                 "(signed CMN, prescription) arrives; release the moment "
                 "documents are in."),
                ("CMN / DIF Worklist",
                 "Draft Certificates of Medical Necessity pre-filled from "
                 "patient data; complete, print, and fax for signature."),
                ("Prior Authorizations",
                 "Submit and track prior auths electronically (Da Vinci PAS "
                 "standard), with SLA risk and expiring-authorization "
                 "alerts."),
                ("Denials Worklist",
                 "Open denials ranked by recoverable dollars weighted by win "
                 "probability, so rework starts with the highest-value "
                 "claims."),
            ]),
            ("Eligibility & Verification", [
                ("Real-Time Eligibility",
                 "On-demand 270/271 eligibility checks through Office Ally, "
                 "with rejected or inactive coverage surfaced automatically."),
                ("Coverage Re-Verification",
                 "A standing worklist of coverages due for re-check: never "
                 "verified, terminating soon, or stale."),
                ("Insurance Leads",
                 "Benefit-verification requests submitted by storefront "
                 "shoppers, queued for triage and follow-up."),
                ("Good Faith Estimates",
                 "Generate and send estimates showing the patient's expected "
                 "responsibility before service."),
            ]),
            ("A/R & Collections", [
                ("A/R Aging",
                 "Open claims bucketed at 0/30/60/90 days with payer "
                 "drill-down."),
                ("Filing Deadlines",
                 "Claims ranked by days remaining before each payer's "
                 "timely-filing window closes."),
                ("Secondary Claims",
                 "Coordination of benefits: roll the primary payer's "
                 "leftover balance to the secondary payer."),
                ("Patient Statements",
                 "Send patient-responsibility statements by email or SMS — "
                 "consent- and quiet-hours-aware."),
                ("Payment Plans &amp; Links",
                 "Set up installment plans and send secure payment links for "
                 "patient balances."),
                ("Capped Rentals",
                 "13- and 36-month CMS rental-cycle tracking with automatic "
                 "KH/KI/KX modifier rotation."),
                ("Collections Forecast",
                 "Projected cash from claims in flight, bucketed by expected "
                 "landing date."),
                ("ERA / 835 Posting",
                 "Upload an 835 remittance file and auto-post payer "
                 "adjudications."),
                ("Manual Claim Entry",
                 "Key a corrected, void/replacement, or paper-backup claim "
                 "by hand when needed."),
                ("Denials &amp; DSO Analytics",
                 "Rolling 90-day denial rate and 180-day days-to-pay, per "
                 "payer."),
            ]),
            ("Billing Configuration & Connections", [
                ("Payer Profiles",
                 "Master payer list with contract terms, fee schedules, and "
                 "remittance details."),
                ("Fee Schedules",
                 "Upload allowed amounts per HCPCS/CPT code and payer from "
                 "CSV."),
                ("Modifier Rules",
                 "Automatically apply HCPCS modifiers (GA, GZ, KH, and "
                 "others) by payer and rule."),
                ("Denial Codes",
                 "Denial-reason catalog with win-probability scoring that "
                 "powers worklist ranking."),
                ("Claim Templates",
                 "Per-payer claim formats defining required fields and "
                 "validation rules."),
                ("Clearinghouse",
                 "Office Ally SFTP connection for 837P submission and "
                 "835/277CA retrieval, with credential tests and a safe "
                 "offline mode."),
                ("Organization Profile",
                 "Your DME's NPI, tax ID, and credentials exactly as they "
                 "appear on claims and estimates."),
                ("PacWare Sync",
                 "Two-way CSV exchange with PacWare billing: a fill-only "
                 "patient import that never overwrites existing data, plus "
                 "verified roster and resupply-due exports."),
            ]),
        ],
    },
    {
        "kicker": "Role 03",
        "title": "Customer Service Rep",
        "mission": "Own every patient touchpoint, end to end.",
        "summary": (
            "Everything a CSR needs to own the patient relationship: a "
            "unified inbox across text, email, and phone; complete patient "
            "records; outreach tools that respect consent and quiet hours; "
            "and full command of orders, returns, and the storefront."
        ),
        "access": (
            "Typical access — agent role: conversations, cases, patient "
            "records, returns, and campaign permissions."
        ),
        "groups": [
            ("Unified Inbox & Daily Workspace", [
                ("Conversations",
                 "Every inbound SMS, MMS, and email thread in one triage "
                 "queue — assign to teammates, set priority, and always know "
                 "who is waiting on whom."),
                ("Email Inbox",
                 "Email-specific view with a needs-response bucket, archive, "
                 "and a reply composer with reusable snippets."),
                ("Cases",
                 "Multi-channel tickets that link related conversations, "
                 "orders, and faxes into one case tracked to closure."),
                ("Episodes",
                 "Open service episodes — callback requests, therapy issues, "
                 "pending returns — with due-date tracking."),
                ("Follow-Ups",
                 "Scheduled callbacks and appointments in a today-first "
                 "queue; complete or reschedule in a click."),
                ("Appointment Requests",
                 "Patient-initiated requests to accept, decline, or counter "
                 "with an alternate time."),
                ("Delivery Failures",
                 "Bounced texts and emails plus carrier shipping exceptions, "
                 "queued for follow-up."),
            ]),
            ("Patient Records", [
                ("Patient 360 View",
                 "Searchable roster opening to a complete patient timeline: "
                 "profile, orders, therapy data, messages, documents, and "
                 "notes in tabs."),
                ("Duplicate Review",
                 "Likely duplicate records detected by name, phone, email, "
                 "and date-of-birth similarity, with a guided merge."),
                ("Patient Documents",
                 "File prescriptions, CMNs, and agreements with OCR and "
                 "automatic document-type detection."),
                ("E-Signature Packets",
                 "Queue documents for electronic signature and track every "
                 "packet from sent to signed to filed."),
            ]),
            ("Outreach & Messaging Tools", [
                ("Resupply Reminders",
                 "Scheduled SMS and email resupply reminders per patient; "
                 "trigger a manual send or bulk-import schedules."),
                ("Bulk Campaigns",
                 "Build an audience by filters (adherence, therapy type, "
                 "payer), draft the SMS or email, schedule the send, and "
                 "track delivery and opt-outs."),
                ("Alert Library",
                 "One-off curated alerts to a single patient by text, email, "
                 "or automated phone call."),
                ("Canned Replies",
                 "Reusable snippets for fast, consistent manual replies."),
                ("Message Templates",
                 "System-message templates with variables, plus per-payer or "
                 "per-patient copy overrides."),
                ("Click-to-Dial &amp; Call Review",
                 "Call patients straight from their record, then review AI "
                 "transcripts, summaries, and sentiment from every "
                 "voice-agent call — with human-handoff flags."),
            ]),
            ("Orders, Shop & Fulfillment", [
                ("Orders &amp; Order Detail",
                 "All storefront orders from pending to delivered: line "
                 "items, shipping, refunds, re-sends, notes, and "
                 "proof-of-delivery."),
                ("Subscriptions",
                 "Recurring supply orders: pause, resume, cancel, or change "
                 "items and delivery dates."),
                ("Returns &amp; RMAs",
                 "Return-request queue with approve/deny, refunds, reason "
                 "codes, and restock tracking."),
                ("Backorders &amp; Substitution",
                 "Mark items out of stock and define automatic substitute "
                 "rules so orders keep moving."),
                ("Inventory &amp; Reconciliation",
                 "Product catalog with stock and cost, plus a monthly count "
                 "workflow with variance reporting."),
                ("Reviews &amp; Product Q&amp;A",
                 "Moderate customer product reviews and answer shopper "
                 "questions."),
                ("Cart Recovery &amp; Restock Alerts",
                 "Recover abandoned carts with automatic emails and notify "
                 "subscribers when items come back in stock."),
                ("Fitter Prospects &amp; Invites",
                 "Invite patients to the AI mask fitter, see their scored "
                 "results, and convert supply-campaign leads."),
            ]),
        ],
    },
    {
        "kicker": "Role 04",
        "title": "Respiratory Therapist",
        "mission": "Keep patients adherent, comfortable, and supplied.",
        "summary": (
            "Clinical tools built around adherence: device data flows in "
            "nightly from the major therapy clouds, at-risk patients surface "
            "automatically, and documentation, interventions, coaching, and "
            "provider paperwork all live in one place."
        ),
        "access": (
            "Typical access — agent role: clinical read/write, "
            "interventions, compliance, and patient-record permissions."
        ),
        "groups": [
            ("Therapy Monitoring & Compliance", [
                ("RT Overview Board",
                 "An at-a-glance therapy board surfacing patient alerts — "
                 "low usage, high leak, rising AHI — filterable by "
                 "compliance status."),
                ("Connected Device Data",
                 "Nightly sync from ResMed AirView, Philips Care "
                 "Orchestrator, and React Health: hours of use, AHI, leak, "
                 "and mask fit for every connected patient."),
                ("Setup Adherence (CMS 90-Day)",
                 "Medicare setup-cohort tracking against the 4-nights-per-"
                 "week, 4-hours-per-night rule, flagging at-risk patients "
                 "early."),
                ("Compliance Rules",
                 "Per-payer adherence thresholds that drive flagging and "
                 "worklists."),
                ("Therapy Fleet",
                 "Population-level compliance cohorts for proactive clinical "
                 "outreach."),
                ("Therapy Usage Report",
                 "A provider-ready, print-quality adherence snapshot by "
                 "provider, patient, or manufacturer."),
            ]),
            ("Clinical Workflows", [
                ("Clinical Encounters",
                 "Document patient visits with assessment, interventions, "
                 "and outcomes in structured notes."),
                ("Interventions Worklist",
                 "Non-adherence interventions organized by cause — "
                 "equipment, side effects, travel — with care plans tracked "
                 "to outcome."),
                ("Mask-Fit Feedback",
                 "Patients reporting leak or discomfort, triaged into a "
                 "follow-up queue."),
                ("Adherence Coaching",
                 "Structured outreach plans for patients slipping on "
                 "therapy, with scheduling and message tracking."),
                ("Clinical Outreach",
                 "Supportive check-ins for patients with open interventions "
                 "— consent- and do-not-disturb-aware."),
                ("RT Outcomes",
                 "Per-therapist dashboard: patient load, encounters, "
                 "interventions, and outcomes."),
                ("Equipment Recalls",
                 "Manufacturer recall registry scanned against dispensed "
                 "serial numbers, with patient notification."),
            ]),
            ("Resupply & Prescriptions", [
                ("Resupply Opportunities",
                 "Device-reported supplies due for replacement — masks, "
                 "cushions, filters — driving timely reorders."),
                ("Prescriptions &amp; Renewals",
                 "Track prescriptions and expirations; optionally auto-draft "
                 "renewals from therapy data."),
                ("Patient Clinical Profile",
                 "Diagnosis dates, baseline AHI, comorbidities, and delivery "
                 "notes on every patient record."),
            ]),
            ("Provider Collaboration & Intake", [
                ("Provider Registry",
                 "NPPES-backed physician and nurse-practitioner directory "
                 "tied to prescriptions and orders."),
                ("Provider E-Signature",
                 "Stage documents for provider signature and track the "
                 "signed queue."),
                ("Inbound Fax Triage",
                 "OCR-processed inbound faxes auto-routed by type — sleep "
                 "study, prescription, chart note — into a triage queue."),
                ("Patient Education Library",
                 "Curate the short-video library patients see, from mask "
                 "comfort to troubleshooting."),
                ("AI Clinical Flags",
                 "Every AI voice call ends with a structured summary noting "
                 "clinical concerns, patient sentiment, and recommended "
                 "human follow-up."),
            ]),
        ],
    },
]

FOUNDATIONS_INTRO = (
    "Beneath the four role workspaces sits a shared platform layer. These "
    "capabilities serve patients directly or protect the business as a "
    "whole, and every role benefits from them."
)

FOUNDATIONS = [
    ("Patient Storefront &amp; Portal",
     "A full e-commerce storefront with Stripe checkout, subscriptions, "
     "order tracking, returns, document access, insurance details, and "
     "caregiver access — backed by a self-service patient account portal."),
    ("AI Mask Fitter",
     "Camera-based facial measurement in the patient's browser scores every "
     "available mask for fit. Images never leave the device — only numeric "
     "measurements are transmitted."),
    ("Resupply Reminder Engine",
     "Automated SMS and email reminders with signed one-tap confirm and "
     "decline links, quiet-hours awareness, and unsubscribe handling."),
    ("AI Voice Agent",
     "A natural-voice phone agent that takes reorders, runs reminder and "
     "check-in calls, hands off to staff on request, and writes a "
     "structured summary of every call."),
    ("Chatbot &amp; Sleep Coach",
     "Patient-facing AI chat for shopping help and therapy coaching, with "
     "optional high-confidence email auto-reply; anything uncertain hands "
     "off to staff."),
    ("PennPilot Admin Assistant",
     "An in-app AI helper on every admin page that answers “how do "
     "I” questions about the console and forwards staff feature ideas "
     "to ownership — always confirming before anything is sent."),
    ("Security &amp; Privacy",
     "Hardened sign-in with optional MFA, role-based access with thirty "
     "granular permissions, CSRF and rate-limit protection, and strict PHI "
     "discipline: camera images and order payloads are never logged."),
    ("Always-On by Design",
     "Feature flags flip capabilities instantly, vendor outages degrade "
     "gracefully instead of taking the site down, and background jobs "
     "handle syncs, reminders, and campaigns around the clock."),
]


MATRIX_VENDORS = ["PennFit", "Brightree + ReSupply", "NikoHealth",
                  "TIMS Software"]

MATRIX_INTRO = (
    "The matrix below positions PennFit's marquee features against the "
    "DME/HME platforms a resupply business is most likely to evaluate: "
    "Brightree with its ReSupply module (the established business-"
    "management incumbent), NikoHealth (a modern HME/DME billing and "
    "operations platform), and TIMS Software (a long-standing HME suite). "
    "A pricing snapshot follows the capability matrix."
)

MATRIX_FOOTNOTE = (
    "PennFit entries reflect the shipped platform described in this guide. "
    "Competitor capability and pricing entries are a good-faith summary of "
    "vendor materials and third-party software directories (ITQlick, "
    "SelectHub) as of June 2026. All three vendors sell on custom quotes — "
    "published figures are directory estimates, not vendor list prices — "
    "and offerings change frequently. Verify with each vendor before using "
    "this comparison in customer-facing material."
)

# Mark order follows MATRIX_VENDORS.
MATRIX = [
    ("Patient Experience", [
        ("AI camera-based mask fitting, in-browser and privacy-first",
         ["full", "none", "none", "none"]),
        ("Patient e-commerce storefront, subscriptions, and cash-pay",
         ["full", "half", "half", "half"]),
        ("Automated resupply outreach with one-tap confirm (SMS/email)",
         ["full", "full", "half", "half"]),
        ("Conversational AI voice agent for reorders and check-ins",
         ["full", "half", "none", "none"]),
        ("Patient AI chatbot and sleep coach",
         ["full", "none", "none", "none"]),
    ]),
    ("Clinical & Therapy", [
        ("Therapy-cloud device data sync (ResMed, Philips, React Health)",
         ["full", "full", "half", "half"]),
        ("CMS 90-day setup-adherence tracking",
         ["full", "full", "half", "half"]),
        ("Clinical intervention, coaching, and mask-fit worklists",
         ["full", "half", "none", "none"]),
        ("Inbound fax OCR and document triage",
         ["full", "full", "half", "half"]),
    ]),
    ("Revenue Cycle", [
        ("Clearinghouse claims (837P/835) and real-time eligibility",
         ["full", "full", "full", "full"]),
        ("AI claim scrubbing and denial recovery ranked by win probability",
         ["full", "half", "half", "none"]),
        ("Electronic prior authorization (Da Vinci PAS)",
         ["full", "half", "none", "none"]),
        ("DME A/R suite: capped rentals, secondary claims, timely filing",
         ["full", "full", "full", "full"]),
        ("Patient statements, payment plans, and payment links",
         ["full", "full", "full", "full"]),
    ]),
    ("Operations & Intelligence", [
        ("Unified omnichannel inbox (SMS, MMS, email)",
         ["full", "half", "half", "none"]),
        ("Provider e-signature and e-ordering collaboration",
         ["full", "half", "half", "none"]),
        ("Business analytics: margin, LTV/CAC, payer profitability",
         ["full", "half", "half", "half"]),
        ("In-app AI staff assistant and no-code automation rules",
         ["full", "half", "half", "none"]),
    ]),
]

PRICING_HEADERS = ["Vendor", "Pricing model", "Published starting point",
                   "Implementation (est.)"]

PRICING_ROWS = [
    ("PennFit",
     "Owned in-house platform — no per-user license",
     "No license fee; infrastructure plus usage-based vendor fees "
     "(telecom, email, payments, AI)",
     "Already deployed"),
    ("Brightree + ReSupply",
     "Quote-based SaaS; modules priced separately (ReSupply is an add-on "
     "program)",
     "None published; directory estimates ~$100–$250+ per user/month "
     "(~$1,500/month at 10 users)",
     "~$5K–$30K (estimate)"),
    ("NikoHealth",
     "Quote-based SaaS, sized per organization",
     "None published; custom quote only",
     "Not disclosed"),
    ("TIMS Software",
     "Quote-based SaaS, sized per organization",
     "None published; directory estimates ~$150–$800/month for small "
     "teams, $5,000+/month at enterprise scale",
     "~$5K–$20K (estimate)"),
]


# ------------------------------------------------------------------ build --


def build():
    doc = BaseDocTemplate(
        OUT_PATH, pagesize=letter,
        leftMargin=MARGIN_X, rightMargin=MARGIN_X,
        topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
        title="PennFit Platform Feature Guide by Role",
        author="PennFit",
    )
    cover_frame = Frame(0, 0, PAGE_W, PAGE_H, id="cover")
    body_frame = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W,
                       PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="body")
    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[cover_frame], onPage=draw_cover),
        PageTemplate(id="Body", frames=[body_frame], onPage=draw_page),
    ])

    story = [NextPageTemplate("Body"), SectionMarker("Overview"), PageBreak()]

    # ---- overview page
    story.append(Paragraph("About this guide", S_H1))
    story.append(Paragraph(INTRO, S_INTRO))
    story.append(Paragraph(INTRO_2, S_INTRO))
    story.append(Spacer(1, 12))

    stat_cells = []
    for number, label in STATS:
        stat_cells.append([
            Paragraph(number, ParagraphStyle(
                "statNum", fontName="Helvetica-Bold", fontSize=19,
                leading=22, textColor=NAVY, alignment=TA_CENTER)),
            Paragraph(label.upper(), ParagraphStyle(
                "statLabel", fontName="Helvetica", fontSize=7.2,
                leading=9.5, textColor=STEEL, alignment=TA_CENTER)),
        ])
    stat_tbl = Table(
        [[c[0] for c in stat_cells], [c[1] for c in stat_cells]],
        colWidths=[CONTENT_W / 4.0] * 4, hAlign="LEFT")
    stat_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), MIST),
        ("LINEABOVE", (0, 0), (-1, 0), 2, GOLD),
        ("LINEAFTER", (0, 0), (-2, -1), 0.7, PLATINUM),
        ("TOPPADDING", (0, 0), (-1, 0), 12),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
        ("TOPPADDING", (0, 1), (-1, 1), 1),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 12),
    ]))
    story.append(stat_tbl)
    story.append(Spacer(1, 18))

    story.append(GroupHeading("Inside this guide"))
    story.append(Spacer(1, 2))
    toc_rows = []
    for i, role in enumerate(ROLES, start=1):
        toc_rows.append([
            Paragraph(f"{i:02d}", ParagraphStyle(
                "num", fontName="Helvetica-Bold", fontSize=13,
                textColor=GOLD_DEEP)),
            Paragraph(role["title"], S_TOC_ROLE),
            Paragraph(role["mission"], S_TOC_DESC),
        ])
    toc_rows.append([
        Paragraph("+", ParagraphStyle(
            "numPlus", fontName="Helvetica-Bold", fontSize=13,
            textColor=GOLD_DEEP)),
        Paragraph("Platform Foundations", S_TOC_ROLE),
        Paragraph("The shared engine underneath every role.", S_TOC_DESC),
    ])
    toc_rows.append([
        Paragraph("+", ParagraphStyle(
            "numPlus2", fontName="Helvetica-Bold", fontSize=13,
            textColor=GOLD_DEEP)),
        Paragraph("Competitive Matrix", S_TOC_ROLE),
        Paragraph("PennFit's top features beside the leading DME software.",
                  S_TOC_DESC),
    ])
    toc = Table(toc_rows, colWidths=[0.5 * inch, 1.9 * inch,
                                     CONTENT_W - 2.4 * inch], hAlign="LEFT")
    toc.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, PLATINUM),
    ]))
    story.append(toc)

    # ---- role sections
    for role in ROLES:
        story.append(SectionMarker(role["title"]))
        story.append(PageBreak())
        story.append(RoleBanner(role["kicker"], role["title"], role["mission"]))
        story.append(Spacer(1, 12))
        story.append(Paragraph(role["summary"], S_INTRO))
        story.append(Paragraph(role["access"], ParagraphStyle(
            "access", fontName="Helvetica-Oblique", fontSize=8.5,
            leading=11.5, textColor=STEEL, spaceAfter=2)))
        for group_name, features in role["groups"]:
            head = features[:2]
            tail = features[2:]
            block = [Spacer(1, 8), GroupHeading(group_name), Spacer(1, 2),
                     feature_table(head, rule_after_last=bool(tail))]
            story.append(KeepTogether(block))
            if tail:
                story.append(feature_table(tail, tint_offset=len(head)))

    # ---- platform foundations
    story.append(SectionMarker("Platform Foundations"))
    story.append(PageBreak())
    story.append(RoleBanner("Shared", "Platform Foundations",
                            "The shared engine underneath every role."))
    story.append(Spacer(1, 12))
    story.append(Paragraph(FOUNDATIONS_INTRO, S_INTRO))
    story.append(Spacer(1, 6))
    story.append(feature_table(FOUNDATIONS))

    # ---- competitive matrix
    story.append(SectionMarker("Competitive Matrix"))
    story.append(PageBreak())
    story.append(RoleBanner("Appendix", "Competitive Feature Matrix",
                            "PennFit's top features beside the leading "
                            "DME software."))
    story.append(Spacer(1, 12))
    story.append(Paragraph(MATRIX_INTRO, S_INTRO))
    story.append(matrix_legend())
    story.append(Spacer(1, 10))
    story.append(matrix_table(MATRIX_VENDORS, MATRIX))
    story.append(KeepTogether([
        Spacer(1, 14),
        GroupHeading("Pricing Snapshot"),
        Spacer(1, 2),
        pricing_table(PRICING_HEADERS, PRICING_ROWS),
    ]))
    story.append(Spacer(1, 10))
    story.append(Paragraph(MATRIX_FOOTNOTE, ParagraphStyle(
        "footnote", fontName="Helvetica-Oblique", fontSize=7.8,
        leading=10.5, textColor=STEEL)))

    doc.build(story)
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    build()

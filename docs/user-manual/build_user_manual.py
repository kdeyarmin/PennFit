#!/usr/bin/env python3
"""Build the CareMetric Breathe User Manual PDF.

Generates docs/user-manual/CareMetric-Breathe-User-Manual.pdf from the
CONTENT structures below. The manual is organised by the four operating
roles in a DME/HME PAP practice — Administrator, Biller, Customer Service
Rep, and Respiratory Therapist — and has four parts:

  1. Feature Summary by Role   — a brief one-line description of every
                                 feature, grouped by role.
  2. Comprehensive Feature      — a detailed description of every feature,
     Reference by Role            grouped by role and console area.
  3. Job Aides by Role          — curated, numbered step-by-step
                                 walkthroughs for the highest-value tasks.
  4. Appendix                   — role/permission matrix + glossary.

It opens with a cover, a page-numbered Table of Contents (built with a
deterministic two-pass build — pass 1 captures every heading's page, pass
2 renders the TOC from those captures), and an Introduction. Screenshots
captured from the running app in demo mode (see capture-manual-screens.mjs)
are embedded where they help.

Brand colours mirror the storefront theme tokens in
artifacts/cpap-fitter/src/index.css and the sibling
docs/feature-guide/build_feature_guide.py.

Usage:
    pip install reportlab Pillow
    python3 docs/user-manual/build_user_manual.py
"""

import colorsys
import io
import json
import os
from datetime import date

from reportlab.pdfgen import canvas as _pdfcanvas

from reportlab.lib.colors import Color, white
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    Image as RLImage,
    KeepTogether,
    ListFlowable,
    ListItem,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "CareMetric-Breathe-User-Manual.pdf")
SHOTS = os.path.join(HERE, "screenshots")
ASSETS = os.path.join(HERE, "assets")
EMBLEM = os.path.join(ASSETS, "caremetric-emblem.png")

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
MARGIN_TOP = 1.0 * inch
MARGIN_BOTTOM = 0.85 * inch
CONTENT_W = PAGE_W - 2 * MARGIN_X


def hexc(color):
    return "#%02x%02x%02x" % (
        int(color.red * 255),
        int(color.green * 255),
        int(color.blue * 255),
    )


def lerp(c1, c2, t):
    """Linear blend between two reportlab Colors (t in 0..1)."""
    return Color(
        c1.red + (c2.red - c1.red) * t,
        c1.green + (c2.green - c1.green) * t,
        c1.blue + (c2.blue - c1.blue) * t,
    )


# --------------------------------------------------------------- styles --

S_BODY = ParagraphStyle(
    "body", fontName="Helvetica", fontSize=9.7, leading=14,
    textColor=BODY_GRAY, alignment=TA_LEFT, spaceAfter=7,
)
S_INTRO = ParagraphStyle(
    "intro", parent=S_BODY, fontSize=10.2, leading=15.5, textColor=INK,
)
S_LEAD = ParagraphStyle(
    "lead", parent=S_BODY, fontSize=10.5, leading=15, textColor=NAVY_DEEP,
    spaceAfter=9,
)
S_FEATURE_NAME = ParagraphStyle(
    "featureName", fontName="Helvetica-Bold", fontSize=9.5, leading=12.5,
    textColor=NAVY_DEEP,
)
S_FEATURE_DESC = ParagraphStyle(
    "featureDesc", fontName="Helvetica", fontSize=9.5, leading=12.5,
    textColor=BODY_GRAY,
)
# White header text for tables drawn on the navy header band. A
# Paragraph's own colour overrides a Table's TEXTCOLOR, so header cells
# must carry a light colour themselves or they render dark-on-navy.
S_TH = ParagraphStyle(
    "th", fontName="Helvetica-Bold", fontSize=9.5, leading=12.5,
    textColor=white,
)
S_STEP = ParagraphStyle(
    "step", fontName="Helvetica", fontSize=9.7, leading=13.5,
    textColor=BODY_GRAY,
)
S_TIP = ParagraphStyle(
    "tip", fontName="Helvetica-Oblique", fontSize=9.2, leading=12.8,
    textColor=STEEL,
)
S_GROUP = ParagraphStyle(
    "group", fontName="Helvetica-Bold", fontSize=11, leading=14,
    textColor=NAVY, spaceBefore=12, spaceAfter=2,
)
S_TASK = ParagraphStyle(
    "task", fontName="Helvetica-Bold", fontSize=10.5, leading=13.5,
    textColor=NAVY_DEEP, spaceBefore=10, spaceAfter=3,
)
S_CAPTION = ParagraphStyle(
    "caption", fontName="Helvetica-Oblique", fontSize=8.2, leading=10.5,
    textColor=STEEL, alignment=TA_CENTER, spaceBefore=3, spaceAfter=2,
)

# TOC-tracked heading styles. afterFlowable() keys off the style name.
S_H1 = ParagraphStyle(
    "H1Section", fontName="Helvetica-Bold", fontSize=18, leading=22,
    textColor=NAVY_DEEP, spaceBefore=2, spaceAfter=4,
)
# Same look as S_H1 but NOT tracked into the TOC (used for the TOC's own
# page heading so it doesn't list itself).
S_H1_PLAIN = ParagraphStyle(
    "H1Plain", parent=S_H1,
)
S_H2 = ParagraphStyle(
    "H2Sub", fontName="Helvetica-Bold", fontSize=13, leading=17,
    textColor=NAVY, spaceBefore=14, spaceAfter=4,
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
        self.canv._cmb_section = self.name


class HBar(Flowable):
    """A thin gold rule under an H1 title."""

    def __init__(self, width=CONTENT_W):
        super().__init__()
        self.width = width
        self.height = 6

    def draw(self):
        c = self.canv
        c.setStrokeColor(GOLD)
        c.setLineWidth(2)
        c.line(0, 3, 1.1 * inch, 3)
        c.setStrokeColor(PLATINUM)
        c.setLineWidth(0.7)
        c.line(1.1 * inch, 3, self.width, 3)


class RoleBanner(Flowable):
    """Full-width navy banner that opens a role section."""

    def __init__(self, kicker, title, mission):
        super().__init__()
        self.kicker = kicker
        self.title = title
        self.mission = mission
        self.width = CONTENT_W
        self.height = 1.3 * inch

    def draw(self):
        c = self.canv
        w, h = self.width, self.height
        c.saveState()
        c.setFillColor(NAVY_DEEP)
        c.roundRect(0, 0, w, h, 6, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.roundRect(0, 0.16 * inch, w, h - 0.16 * inch, 6, stroke=0, fill=1)
        c.setFillColor(GOLD)
        c.rect(0.32 * inch, h - 0.5 * inch, 0.30 * inch, 0.045 * inch,
               stroke=0, fill=1)
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 8.5)
        c.drawString(0.72 * inch, h - 0.515 * inch, self.kicker.upper())
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 20)
        c.drawString(0.32 * inch, h - 0.9 * inch, self.title)
        c.setFillColor(GOLD_SOFT)
        c.setFont("Helvetica-Oblique", 9.5)
        c.drawString(0.32 * inch, h - 1.16 * inch, self.mission)
        c.restoreState()


class GroupHeading(Flowable):
    """Gold square + bold heading + hairline, drawn on one baseline."""

    def __init__(self, text):
        super().__init__()
        self.text = text
        self.width = CONTENT_W
        self.height = 24

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


class TocLine(Flowable):
    """One Table-of-Contents line: title (level-indented) · dot leader ·
    page number. Rendered from the captured (level, text, page) entries so
    the page numbers are exact and deterministic."""

    def __init__(self, level, text, page, width=CONTENT_W):
        super().__init__()
        self.level = level
        self.text = text
        self.page = str(page)
        self.width = width
        self.height = 19 if level == 0 else 15.5

    def wrap(self, *_):
        return (self.width, self.height)

    def draw(self):
        c = self.canv
        indent = 0 if self.level == 0 else 18
        font = "Helvetica-Bold" if self.level == 0 else "Helvetica"
        size = 10.5 if self.level == 0 else 9.5
        color = NAVY_DEEP if self.level == 0 else BODY_GRAY
        y = 4
        c.setFont(font, size)
        c.setFillColor(color)
        c.drawString(indent, y, self.text)
        tw = c.stringWidth(self.text, font, size)
        c.setFont("Helvetica", 9.5)
        c.setFillColor(NAVY_DEEP if self.level == 0 else STEEL)
        pw = c.stringWidth(self.page, "Helvetica", 9.5)
        c.drawRightString(self.width, y, self.page)
        dot_start = indent + tw + 5
        dot_end = self.width - pw - 5
        if dot_end > dot_start:
            c.setStrokeColor(PLATINUM)
            c.setLineWidth(0.6)
            c.setDash(0.5, 2.5)
            c.line(dot_start, y + 1.5, dot_end, y + 1.5)
            c.setDash()


def h1(text):
    """A TOC level-0 heading paragraph (+ rule + running header)."""
    return [SectionMarker(text), Paragraph(text, S_H1), HBar(), Spacer(1, 8)]


def h2(text):
    """A TOC level-1 heading paragraph."""
    return Paragraph(text, S_H2)


def feature_table(features, tint_offset=0):
    """Two-column feature table with alternating row tints."""
    rows = []
    for name, desc in features:
        rows.append(
            [Paragraph(name, S_FEATURE_NAME), Paragraph(desc, S_FEATURE_DESC)]
        )
    t = Table(
        rows, colWidths=[1.75 * inch, CONTENT_W - 1.75 * inch], hAlign="LEFT"
    )
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 8),
        ("RIGHTPADDING", (0, 0), (0, -1), 10),
        ("LEFTPADDING", (1, 0), (1, -1), 4),
        ("RIGHTPADDING", (1, 0), (1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.5),
    ]
    for i in range(len(rows)):
        tint = PEARL if (i + tint_offset) % 2 == 0 else MIST
        style.append(("BACKGROUND", (0, i), (-1, i), tint))
    t.setStyle(TableStyle(style))
    # Mark atomic: every feature table here is <= ~10 rows so it always fits
    # on a page. space_before_headings() keeps it whole (and with its heading)
    # so it never straddles a page break. (Plain Table — wrapping happens in
    # one place to avoid nested KeepTogethers, which balloon the layout.)
    t._atomic_table = True
    return t


def steps(items):
    """Numbered step list."""
    return ListFlowable(
        [ListItem(Paragraph(s, S_STEP), leftIndent=18, value=i + 1)
         for i, s in enumerate(items)],
        bulletType="1",
        bulletFontName="Helvetica-Bold",
        bulletColor=GOLD_DEEP,
        leftIndent=8,
    )


def bullets(items):
    # Mirror steps()' working geometry (ListFlowable leftIndent=8, ListItem
    # leftIndent=18) so the bullet sits in the gutter and never overlaps the
    # text. (The previous leftIndent=6/16 + square start drew the marker on
    # top of the words.)
    return ListFlowable(
        [ListItem(Paragraph(s, S_STEP), leftIndent=18) for s in items],
        bulletType="bullet",
        bulletFontName="Helvetica",
        bulletFontSize=7,
        bulletColor=GOLD_DEEP,
        leftIndent=8,
    )


def shot(name, caption, width=5.3 * inch):
    """Framed screenshot with a caption. Returns [] if the file is absent
    so the manual still builds without the screenshot set."""
    path = os.path.join(SHOTS, name + ".png")
    if not os.path.exists(path):
        return []
    # captured at 1440x900 → 16:10
    img = RLImage(path, width=width, height=width * 900.0 / 1440.0)
    img.hAlign = "CENTER"
    box = Table(
        [[img]], colWidths=[width + 10], hAlign="CENTER"
    )
    box.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, PLATINUM),
        ("BACKGROUND", (0, 0), (-1, -1), PEARL),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return [Spacer(1, 4), box, Paragraph(caption, S_CAPTION), Spacer(1, 6)]


def tip(text):
    box = Table(
        [[Paragraph("<b>Tip&nbsp;&nbsp;</b>" + text, S_TIP)]],
        colWidths=[CONTENT_W], hAlign="LEFT",
    )
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GOLD_SOFT),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, GOLD_DEEP),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    return box


# Feature-flag (Control Center toggle) rendering.
S_FLAG_LABEL = ParagraphStyle(
    "flagLabel", fontName="Helvetica-Bold", fontSize=9.3, leading=12,
    textColor=NAVY_DEEP,
)
S_FLAG_KEY = ParagraphStyle(
    "flagKey", fontName="Courier", fontSize=7.6, leading=10, textColor=STEEL,
)
S_FLAG_DESC = ParagraphStyle(
    "flagDesc", fontName="Helvetica", fontSize=8.9, leading=11.8,
    textColor=BODY_GRAY,
)


def _default_badge(default_on):
    on = default_on == "on"
    color = hexc(hsl(150, 45, 32)) if on else hexc(GOLD_DEEP)
    txt = "On by default" if on else "Off by default"
    return Paragraph(
        '<font color="%s" size="7.4"><b>● %s</b></font>' % (color, txt),
        ParagraphStyle("badge", fontName="Helvetica-Bold", fontSize=7.4,
                       leading=10),
    )


def flag_table(flags):
    """One row per Control Center toggle: name+key+default | description."""
    rows = []
    for i, fl in enumerate(flags):
        left = [
            Paragraph(fl["label"], S_FLAG_LABEL),
            Paragraph(fl["key"], S_FLAG_KEY),
            Spacer(1, 1.5),
            _default_badge(fl["default"]),
        ]
        rows.append([left, Paragraph(fl["description"], S_FLAG_DESC)])
    t = Table(rows, colWidths=[1.85 * inch, CONTENT_W - 1.85 * inch],
              hAlign="LEFT", repeatRows=0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (1, 0), (1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    for i in range(len(rows)):
        style.append(("BACKGROUND", (0, i), (-1, i),
                      PEARL if i % 2 == 0 else MIST))
    t.setStyle(TableStyle(style))
    return t


def three_col_table(headers, rows, widths):
    """Header + body table with alternating tints (used by the savings
    tables and the competitive matrix)."""
    hd = [Paragraph(h, S_TH) for h in headers]
    body = [hd]
    for r in rows:
        body.append([Paragraph(c, S_FEATURE_DESC) if isinstance(c, str) else c
                     for c in r])
    t = Table(body, colWidths=widths, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
    ]
    for r in range(1, len(body)):
        style.append(("BACKGROUND", (0, r), (-1, r),
                      PEARL if r % 2 else MIST))
    t.setStyle(TableStyle(style))
    # Atomic: header + body stay together (these are all short enough to fit)
    # so the navy header is never split from its rows. Wrapped once in
    # space_before_headings() to avoid nested KeepTogethers.
    t._atomic_table = True
    return t


def savings_stat_row(stats):
    """Three big-number stat tiles for the ROI roll-up."""
    big_style = ParagraphStyle(
        "bigstat", fontName="Helvetica-Bold", fontSize=20, leading=24,
        alignment=TA_CENTER, textColor=GOLD)
    label_style = ParagraphStyle(
        "biglabel", fontName="Helvetica", fontSize=9, leading=12,
        alignment=TA_CENTER, textColor=white)
    cells = []
    for big, label in stats:
        cells.append([
            Paragraph(big, big_style),
            Paragraph(label, label_style),
        ])
    w = (CONTENT_W - 0.4 * inch) / 3.0
    t = Table([cells], colWidths=[w, w, w], hAlign="CENTER")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, -1), NAVY_DEEP),
        ("TEXTCOLOR", (0, 0), (-1, -1), white),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("LINEAFTER", (0, 0), (0, -1), 0.6, NAVY_SOFT),
        ("LINEAFTER", (1, 0), (1, -1), 0.6, NAVY_SOFT),
    ]))
    return t


class Marker(Flowable):
    """Matrix cell marker drawn as a vector circle — full / half / open.
    (Helvetica lacks the ◐/○ glyphs, which render as boxes, so we draw
    them.) `kind` is "full", "half"/"some", or anything else for open."""

    R = 3.6

    def __init__(self, kind):
        super().__init__()
        self.kind = kind
        self.width = 14
        self.height = 11
        self.hAlign = "CENTER"

    def draw(self):
        c = self.canv
        x, y, r = self.width / 2.0, self.height / 2.0, self.R
        c.saveState()
        if self.kind == "full":
            c.setFillColor(NAVY)
            c.setStrokeColor(NAVY)
            c.circle(x, y, r, stroke=1, fill=1)
        elif self.kind in ("half", "some"):
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


def marker_legend():
    """Inline 'full / partial / none' legend using drawn markers."""
    lab = ParagraphStyle("legend", parent=S_FEATURE_DESC, fontSize=8.5)
    cells = [
        Marker("full"), Paragraph("full", lab),
        Marker("half"), Paragraph("partial / Owner-gated", lab),
        Marker("none"), Paragraph("none", lab),
    ]
    w = [0.2 * inch, 0.55 * inch, 0.2 * inch, 1.5 * inch, 0.2 * inch,
         0.5 * inch]
    t = Table([cells], colWidths=w, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return t


# =====================================================================
# CONTENT
# =====================================================================

TODAY = date.today().strftime("%B %Y")

# ── Roles ────────────────────────────────────────────────────────────
ROLES = [
    (
        "administrator",
        "Administrator",
        "ADMINISTRATOR (OWNER & ADMIN)",
        "Run the whole practice — setup, team, money, and the controls "
        "that govern every other role.",
    ),
    (
        "biller",
        "Biller",
        "BILLER",
        "Own the revenue cycle — eligibility, claims, A/R, and getting "
        "every dollar collected.",
    ),
    (
        "csr",
        "Customer Service Rep",
        "CUSTOMER SERVICE REP (CSR)",
        "The patient's first point of contact — messages, orders, "
        "scheduling, and day-to-day service.",
    ),
    (
        "rt",
        "Respiratory Therapist",
        "RESPIRATORY THERAPIST (RT)",
        "Watch therapy, keep patients adherent, and document the "
        "clinical care that backs every claim.",
    ),
]


# ── Part 1: brief feature summaries, grouped by role ─────────────────
# role_id -> list of (group_label, [(feature, one_liner), ...])
SUMMARY = {
    "administrator": [
        ("Command center", [
            ("Home dashboard", "Today's work, live KPI counters, and quick links into every queue."),
            ("CareMetric Copilot", "Floating in-app assistant that answers “how do I… / where is…” and can email feature ideas to the owner."),
            ("Support", "File a support request and get instant how-to answers from the assistant."),
        ]),
        ("Setup & identity", [
            ("Set Up Your Workspace", "Guided checklist: brand, domain, phone/SMS/fax, email sender, and payments."),
            ("Company Information", "Legal name, addresses, and contacts printed on documents, the storefront, and messages."),
            ("Storefront Branding", "Storefront name, tagline, logo (or a one-click starter monogram), and custom-domain wiring."),
            ("Phone & SMS / Fax / Email", "Provision dedicated voice, SMS, and fax numbers for the practice and set the From email address."),
            ("Locations", "Define service branches (multi-branch practices) and assign them to patients."),
            ("Account Security", "Enroll your own multi-factor authentication (authenticator app)."),
        ]),
        ("Team & control", [
            ("Team", "Invite staff, set their role (Owner, Admin, CSR, Biller, RT), revoke access, and link each teammate's Slack handle."),
            ("Control Center", "On/off switches for major features — voice agent, campaigns, auto-submit, AI billing, chatbots."),
            ("Recommended preset", "One-click “set my feature flags to the bundle for my plan” — adopt or re-baseline the recommended set after picking or switching a plan."),
            ("System Configuration", "Owner-only vault for integration credentials and platform secrets."),
            ("Automation Rules / Rule Tester", "“When X happens, do Y” automations, with a dry-run tester before you go live."),
            ("Compliance Rules", "Per-payer CPAP adherence thresholds (minimum hours / nights)."),
            ("Bot Playground", "Rehearse the chat and voice bots against scripted situations to tune them."),
        ]),
        ("Operations & integrations", [
            ("Operations", "Health of background jobs and pipelines (worker, nightly sync)."),
            ("Integrations", "Therapy-cloud connections (ResMed AirView, Philips Care Orchestrator, 3B React Health) and sync status."),
            ("Slack notifications", "Post real-time CS alerts and operator digests into your team's Slack channel; act on them with Escalate buttons and a slash command."),
            ("PacWare", "CSV import/export bridge to the PacWare billing/warehouse system."),
            ("Outbound Messages / Delivery Failures", "Every SMS & email with its delivery result; retry or resolve bounces."),
            ("Webhook Deliveries", "Outbound event deliveries to partner endpoints; re-queue failed sends."),
        ]),
        ("Analytics & goals", [
            ("Reports", "Exportable CSV/PDF/QuickBooks reports for ops and finance."),
            ("Audit Trail", "Who accessed which patient's information, and when — filter by employee, patient, and time frame (admins only)."),
            ("Financial analytics", "Margin & COGS, LTV:CAC, inventory turnover, revenue by source, outreach attribution."),
            ("Performance & Goals", "Team throughput, live staffing load, KPI targets, and threshold alerts."),
            ("Clinical & customer analytics", "Resupply funnel, reorder reminders, NPS, and storefront traffic."),
        ]),
    ],
    "biller": [
        ("Dashboards", [
            ("Billing Hub", "A/R director view — money in flight, top payers, and an aging summary."),
            ("Denials & DSO", "90-day denial rate and days-to-pay per payer, with trend lines."),
            ("Collections Forecast", "Projected cash from claims in flight, bucketed by expected landing date."),
            ("Chargeback Disputes", "Card chargebacks against storefront charges, ordered by evidence deadline."),
            ("Payer Profitability", "Net yield per payer: billed → allowed → collected, net of cost."),
        ]),
        ("Claim worklists", [
            ("Verify Insurance", "Run a one-off 270/271 eligibility check for any patient."),
            ("Insurance Discovery", "Find active coverage from demographics when the plan is unknown."),
            ("Eligibility", "System-wide 270/271 worklist; rejected and inactive coverage rises to the top."),
            ("Re-verification", "Active coverages due for a re-check (stale, terminating, never checked)."),
            ("Prior Auths", "At-risk SLA, auths expiring soon, and drafts to submit (incl. Da Vinci PAS)."),
            ("CMN / DIF Worklist", "Certificates of Medical Necessity awaiting completion."),
            ("Bill Hold", "Claims held from billing until signed paperwork is back."),
            ("Auto-submit", "Preflight-clean claims ready to transmit — approve a batch or let the cron send."),
            ("AI Queue", "Scrubber-blocked + denial-analyzer worklist with auto-resubmit suggestions."),
            ("Denials Worklist", "Open denials ranked by recoverable dollars × win-probability."),
        ]),
        ("A/R & collections", [
            ("A/R Aging", "Open claims by 0/30/60/90-day bucket and by payer."),
            ("Filing Deadlines", "Open claims ranked by days left before timely-filing closes."),
            ("Secondary Claims", "Coordination of benefits — roll the primary's balance to the secondary payer."),
            ("Statement Send", "Send patient-responsibility statements by email/SMS, consent-aware."),
            ("Collections", "Patient balances on a dunning ladder (statement → reminder → notices → agency) that auto-pauses the moment a balance is paid or on a plan."),
            ("Capped Rentals", "13- and 36-month CMS rental cycle tracker with KH/KI/KX modifier rotation."),
            ("ADR / Audit Response", "Payer/contractor documentation requests ranked by deadline, with a checklist and win-rate outcomes."),
            ("Audit Packet", "Assemble a complete CPAP/PAP documentation packet (SWO, CMN, sleep study, compliance, POD…) as one PDF."),
        ]),
        ("Tools & configuration", [
            ("ERA Files", "Upload an 835 to auto-post payer adjudications."),
            ("Office Ally", "Clearinghouse 837P submissions, acknowledgements, and transmission status."),
            ("Manual Claim", "Key a corrected / void-replacement / paper-backup claim by hand."),
            ("Billing Config", "Payer profiles, fee schedules, modifier rules, denial codes, claim templates."),
            ("Package & Usage", "Your CareMetric subscription plan, add-ons, and monthly usage."),
        ]),
    ],
    "csr": [
        ("Daily workspace", [
            ("Home", "Today's worklist and live counters across every queue."),
            ("Front Desk", "Capture a walk-in and ring up a counter order (cash or bill-to-insurance)."),
            ("Conversations", "Unified SMS/MMS/email inbox — triage, reply, assign, and escalate."),
            ("Email Inbox", "Inbound patient email split into needs-response vs. answered, with AI draft replies."),
            ("Cases", "Multi-channel tickets that link conversations, orders, faxes, and documents."),
            ("Episodes", "Dated follow-up promises and open service episodes."),
        ]),
        ("Schedule & outreach", [
            ("Company Calendar", "Shared team schedule of fittings, setups, follow-ups, and video visits."),
            ("Video Visits", "Telehealth visits with secure join links sent by SMS/email."),
            ("Follow-ups", "Today's callback queue across customers and patients."),
            ("Bulk Campaigns", "Batch SMS/email sends with audience filters and a recipient sanity-check."),
            ("Alert Library / Reminders", "One-off patient alerts and the resupply reminder schedule."),
            ("Playbooks / Canned Replies / Automated Messages", "Reusable outreach cadences, saved reply snippets, and system-message copy."),
        ]),
        ("Patients & paperwork", [
            ("Patients", "Patient roster and the 360° timeline (orders, messages, documents, therapy, billing)."),
            ("Duplicate Review", "Find and merge likely-duplicate patient records."),
            ("Documents & Packets", "Draft CMNs/prescriptions/agreements and send e-signature packets."),
            ("Awaiting Signatures / Inbound Faxes", "Track documents out for signature; triage inbound faxes."),
            ("Referral Reviewer / Sources", "AI-extracted intake from faxed referrals; referring-physician scorecards."),
        ]),
        ("Orders, shop & leads", [
            ("Orders", "Storefront orders — fulfill, refund, track, and look up."),
            ("Shipping Labels", "Print shipping labels with the patient address merged; tracking auto-fills."),
            ("Subscriptions / Returns / Backorders", "Recurring resupply, return/RMA decisions (with optional restock-to-inventory), and out-of-stock handling."),
            ("Customers / Reviews / Q&A", "Shop accounts and cash-pay membership tiers, product reviews (auto-requested after purchase) to moderate, and customer questions to answer."),
            ("Abandoned Carts / Back-in-Stock / Insurance Leads", "Recover carts, notify waitlists, and work benefit-verification requests."),
            ("Fitter Invites & Prospects", "Invite patients to the AI mask fitter and track the conversion funnel."),
        ]),
    ],
    "rt": [
        ("Therapy monitoring", [
            ("RT Overview", "At-a-glance therapy board with alerts, AHI, leak, and usage per patient."),
            ("Therapy Fleet", "Population compliance cohorts and the clinical outreach worklist."),
            ("Setup Adherence", "CMS 90-day adherence tracker for new Medicare setups."),
            ("Resupply Opportunities", "Device-reported supplies due for replacement."),
            ("RT Outcomes", "Per-therapist activity: encounters, patients, and interventions."),
        ]),
        ("Clinical work", [
            ("Clinical Encounters", "Document and review patient clinical encounters (notes, assessment, plan)."),
            ("Interventions", "Non-adherence intervention worklist — cause, plan, and outcome tracking."),
            ("Mask-fit Feedback", "Triage patients reporting a leaking or uncomfortable fit."),
            ("Clinical Outreach", "Send supportive check-ins to patients with an open intervention (consent/DND-aware)."),
            ("Adherence Coaching", "Outreach plans for patients whose CPAP use is slipping."),
            ("Video Library", "Manage the short-video education library shown on the storefront."),
        ]),
        ("Providers, devices & reports", [
            ("Providers", "Central physician/NP registry (NPPES-backed)."),
            ("Recalls", "Manufacturer recall registry scanned against dispensed serials."),
            ("Asset Recovery", "Recover machines from discontinued patients to refurbish and redeploy."),
            ("Therapy Report", "Provider-ready, print-quality adherence snapshot by provider, patient, or device."),
            ("Patient clinical timeline", "The clinical tab of the patient 360° view — therapy data, prescriptions, history."),
        ]),
    ],
}


# ── Part 2: detailed feature reference, grouped by role ──────────────
# role_id -> list of (group_label, intro_or_None, [(feature, paragraph), ...])
DETAIL = {
    "administrator": [
        ("Command center", None, [
            ("Home dashboard", "The landing page after sign-in. It rolls up today's work — conversations awaiting reply, overdue follow-ups, returns to action, appointments — alongside live KPI counters (active conversations, fulfillments this week, paused patients) and one-click links into each queue. Use it as your morning triage board; every tile deep-links to the full list."),
            ("CareMetric Copilot (admin assistant)", "A floating assistant on every admin page. It does two jobs: (1) tech support — it knows the entire console map and answers “how does X work / where is the page that does Y,” returning clickable links; and (2) product feedback — its one action, after you confirm, emails a structured feature idea to the owner(s). It never takes other actions and never echoes patient PHI. The Penn Home Medical Supply tenant brands it “PennPilot.”"),
            ("Support", "A simple form to file a support request, with the assistant on hand to answer how-to questions instantly before you escalate."),
        ]),
        ("Setup & practice identity", "Everything that makes the platform “yours.” Most of this lives under System → Settings.", [
            ("Set Up Your Workspace", "A guided checklist that walks a new practice through the core steps: brand and logo, custom domain, phone/SMS/fax numbers, the email From address, and payment processing. The Home dashboard shows a “finish setting up” banner until the essentials are done."),
            ("Company Information", "Your legal practice name, addresses, NPI/tax identifiers, and contacts. These values are merged onto documents (CMNs, statements), the storefront, and outbound messages, so keep them accurate."),
            ("Storefront Branding", "The patient-facing storefront's name, tagline, logo, and theme, plus custom-domain wiring (e.g. a tenant domain that routes only to your storefront). No logo yet? One click generates a <b>starter monogram</b> tile from your storefront name (entirely in the browser) so the storefront never shows a blank logo while you source artwork."),
            ("Phone & SMS, Fax, Email From Address", "Messaging works from day one: until you provision your own number, patient texts, calls, and faxes go out on a <b>shared platform number</b>, and an inbound reply is routed back to the tenant that owns the patient — so two-way texting works across tenants before anyone has their own line. When you want messages to originate from <b>your practice's own number</b>, dedicated voice, SMS, and fax numbers are <b>provisioned for you through the platform's telephony carrier (Twilio/Telnyx)</b> — you don't bring or port your own line, and there's no separate carrier account to manage. Email uses the platform default From address until you set your own; deliverability then requires your sending domain to be SPF/DKIM-authenticated, and that status is shown here."),
            ("Locations", "For multi-branch practices: define each service branch and assign patients to them. Appears only when multi-location is enabled in Control Center."),
            ("Account Security", "Enroll and manage your own multi-factor authentication (authenticator-app TOTP). Strongly recommended for every admin."),
        ]),
        ("Team & platform control", "Owner-tier governance. Some items are restricted to the Owner role.", [
            ("Team", "Invite staff by email, assign a role — Owner, Admin, Customer Service Rep, Biller, or Respiratory Therapist — and manage access (resend invite, revoke, delete, change role). Invitees receive a sign-up link and must accept before they can log in. The last active Owner cannot be demoted (a safety lock). You can also link each teammate's <b>Slack handle</b> here, so Slack escalations and slash-command actions are attributed to the right person. Owner-only."),
            ("Control Center", "The master on/off panel for major features: the voice agent, SMS/email campaigns, claim auto-submit, AI billing, the storefront chatbot, the admin assistant, multi-location, and more. Toggles take effect immediately."),
            ("Recommended preset", "A one-click card in the Control Center that sets your feature flags to the recommended bundle for your billing plan (Virtual Mask Fitter, Launch, Growth, Scale, or Enterprise). New tenants already land on their plan's preset at onboarding; this lets an existing tenant adopt — or re-baseline to — the recommended set after picking or switching a plan, instead of toggling dozens of flags by hand. It previews the changes first, and you can still fine-tune any individual flag afterward."),
            ("System Configuration", "The Owner-only vault for integration credentials (therapy-cloud, clearinghouse) and platform secrets. Restricted to the Owner role so secrets can never be viewed or entered by a lower role."),
            ("Automation Rules & Rule Tester", "Build “when X, do Y” automations — for example, when an inbound message matches a phrase, send a reply or raise a flag. The Rule Tester dry-runs a rule against sample input before you enable it in production."),
            ("Compliance Rules", "Set per-payer CPAP adherence thresholds (minimum hours per night, minimum nights) that the therapy-monitoring boards measure patients against."),
            ("Bot Playground", "A safe sandbox to rehearse the chat and voice bots against scripted situations with synthetic data and simulated tools — use it to tune prompts before changing what patients experience."),
        ]),
        ("Operations & integrations", "Keep the plumbing healthy and the partner connections flowing.", [
            ("Operations", "The health board for background jobs and pipelines — the in-process worker, the nightly therapy sync, reminder dispatch. Shows what ran, what's queued, and what failed."),
            ("Integrations", "Connect and monitor therapy-cloud vendors (ResMed AirView, Philips Care Orchestrator, 3B Medical React Health). Shows availability and nightly-sync status; credentials are entered under System Configuration."),
            ("Slack team notifications", "Bring the work into your team's Slack. With a Slack bot token + channel set in System Configuration, the platform posts real-time CS alerts — a patient reply that needs a human, a voice post-call hand-off, an SLA breach — plus the operator digests (owner weekly KPIs, metric alerts, stuck-job monitor, low-stock inventory) into your channel. Staff can act right from Slack: an <b>Escalate</b> button and a slash command, every inbound request verified against your Slack signing secret. Messages are deliberately <b>non-PHI</b> — a reference, a status, and a deep link back into the admin console — never message bodies, phone numbers, or clinical detail. Three Control Center toggles govern it (<font name=\"Courier\" size=\"8\">slack.notifications</font>, <font name=\"Courier\" size=\"8\">slack.interactivity</font>, <font name=\"Courier\" size=\"8\">slack.digests</font>); all are inert until the Slack credentials are entered."),
            ("PacWare", "A CSV import/export bridge to the PacWare desktop billing/warehouse system (which has no API). Import fills only blank fields on existing patients (never overwrites); exports (patient roster, resupply-due worklist) include a verify step and formula-injection guards."),
            ("Outbound Messages & Delivery Failures", "Every outbound SMS and email with its delivery result (sent/delivered/failed/bounced). Delivery Failures collects bounces and shipping exceptions to retry or resolve."),
            ("Webhook Deliveries", "Outbound event deliveries to partner endpoints, with the ability to re-queue failed or exhausted sends and test-send events."),
        ]),
        ("Analytics, reports & goals", "The numbers that run the business. Most are finance-gated.", [
            ("Reports", "A catalog of exportable reports (CSV/PDF/QuickBooks) — revenue summary, orders, refunds journal, patient payments, insurance claims, customer activity, and more."),
            ("Patient-Access Audit Trail", "An admins-only report of who accessed which patient's information, and when. Filter by employee, by patient, and by time frame to answer a “who looked at this chart?” question. It is kept out of the CSR and clinician sidebars (it requires the audit-read permission) and the page itself enforces full-admin access."),
            ("Financial analytics", "Captured-cost economics: gross Margin & COGS by product, LTV:CAC by channel, inventory turnover and stockout demand, revenue by source, and outreach attribution."),
            ("Performance & Goals", "Operational management: per-agent Team Throughput, real-time Live Staffing load, KPI Goals & Targets with pace-to-goal, and KPI Alerts that fire when a metric crosses a threshold."),
            ("Clinical & customer analytics", "Resupply funnel and reorder-reminder conversion, post-delivery NPS with comments, and storefront traffic & revenue."),
        ]),
    ],
    "biller": [
        ("How the billing engine works, end to end", "This is what makes CareMetric Breathe's revenue cycle different: the work happens ahead of you. The sections below explain the machinery; the worklists that follow are where you drive it.", [
            ("The claim types it handles", "Every bill is an insurance claim with a payer sequence. <b>Primary</b> claims are built automatically from a fulfillment (the shipped order) or keyed by hand. <b>Secondary / COB</b> claims are coordination-of-benefits bills the system can auto-draft once a primary pays and leaves a balance, snapshotting the primary's paid / contractual / patient-responsibility amounts into the 837P COB loop — they always land in <i>draft</i> for a biller to review, never auto-submit. <b>Capped-rental</b> claims are generated month by month for Medicare CPAP rentals, each seeded with the correct rental-month modifier. <b>Corrected / void-replacement / paper-backup</b> claims are keyed from the Manual Claim screen when an automated path doesn't fit."),
            ("Modifiers, applied by rule", "Modifiers (RR rental, KH/KI/KJ capped-rental months, KX medical-necessity, NU purchase, GA/GZ ABN, LT/RT) are applied automatically from a per-payer rule store. Each rule is keyed to a payer + HCPCS + a condition — “rental month ≤ 3”, “rental month ≥ 4”, “compliant at 90 days”, “initial dispense”, “prior auth approved”, “ABN on file” — and the highest-priority match wins as the claim is built. Capped rentals rotate the month modifier for you: KH for months 1–3, KI from month 4, plus KX once the patient proves CMS compliance (≥4 hours on ≥70% of nights in a 30-day window). Hand-keyed claims pull the same modifiers so manual and automated claims bill identically."),
            ("Eligibility, five ways", "The platform runs the 270/271 eligibility transaction for you in five places: (1) a real-time check that returns a 271 in seconds (or a deferred SFTP round-trip when real-time isn't configured); (2) a <b>quick check</b> you can run with no patient record at all — type a name, DOB, and member ID and read coverage back instantly; (3) the system-wide <b>Eligibility worklist</b> that surfaces rejected and inactive coverage first; (4) scheduled <b>auto-re-verification</b> that fires fresh 270s for the most-urgent active coverages on a cadence; and (5) an automatic <b>pre-submit precheck</b> that re-confirms coverage in the moments before a claim is transmitted and holds back anything inactive or needing prior auth."),
            ("One-click insurance verification, everywhere", "A Verify-Insurance button rides on the patient chart, the patient's billing tab, and the eligibility worklist, plus a standalone cross-patient verifier — so anyone can confirm coverage in one click from wherever they already are, and the 271 result shows inline. No separate payer portal, no phone tree."),
            ("Insurance discovery", "When a patient's plan is unknown — or a coverage on file came back inactive — Insurance Discovery searches the payer network from their demographics (name, DOB, ZIP, optional SSN/member-id) and returns the active coverages it finds, ready to attach. It turns “we don't know who covers them” into a billable claim. (A paid clearinghouse add-on; enable per tenant.)"),
            ("Auto-submit to the clearinghouse", "Submission-ready claims flow through a pipeline: a <b>preflight scrub</b> (required fields, HCPCS/diagnosis match) drops unsalvageable claims; an <b>eligibility gate</b> blocks stale or inactive coverage; the optional <b>AI scrubber</b> flags or fixes the rest; clean claims are <b>batched per payer</b> into 837P files and transmitted to Office Ally over SFTP, with control numbers tracked and 999 / 277CA acknowledgements reconciled automatically. You can drive it two ways — review and approve a staged batch yourself (Auto-submit), or let the scheduled cron transmit clean, eligible claims unattended. A <b>bill-hold</b> gate keeps any claim from going out while required signed paperwork is still outstanding, and lifts the hold the moment the last document is back."),
            ("AI claim scrubbing & denial recovery", "Before submission the AI scrubber reviews each draft for semantic problems — wrong modifier for the rental month, quantity over the LCD limit, HCPCS/diagnosis mismatch, fee-schedule drift, duplicate risk — and returns a verdict (ready / fixable / blocking) with one-click patches. After a denial, the AI denial analyzer reads the CARC/RARC codes, explains the root cause, drafts the corrective steps and an appeal letter, and recommends the next move (resubmit, appeal, bill the patient, write off). When the fix is safe and confidence is high, it offers a one-click auto-resubmit. The <b>AI Queue</b> buckets all of this — blocking, fixable, needs-analysis, and auto-resubmit-ready — so a biller always works the highest-payoff claim first. PHI is minimized before anything reaches the model (names → initials, DOB → year, member IDs fingerprinted)."),
            ("ERA auto-posting", "Upload an 835 remittance and the system matches each claim block to your claims and posts the adjudication automatically — allowed, paid, and patient-responsibility amounts at both the claim and line level, a posted event with the check/EFT reference, and a status flip to paid or denied. Denied lines are handed straight to the denial analyzer. Re-posting the same file is a safe no-op (idempotent), so payer redeliveries never double-count."),
        ]),
        ("Billing dashboards", "Read-first views that tell you where the money is. Open these to know what to work next.", [
            ("Billing Hub", "The A/R director's home base: money in flight, top payers, aging summary, and the day's billing KPIs. Start here, then drop into a worklist."),
            ("Denials & DSO", "Benchmark view of the trailing 90-day denial rate and trailing 180-day days-to-pay (DSO) per payer, with trend lines so you can see which payers are slipping."),
            ("Collections Forecast", "Projected cash from claims already in flight, bucketed by the date you expect each to land — a near-term cash-flow forecast."),
            ("Chargeback Disputes", "Card chargebacks raised against storefront charges, ordered by the evidence-submission deadline so nothing lapses."),
            ("Payer Profitability", "Net yield per payer end to end: billed → allowed → collected, denial rate, and the result net of product cost. Finance-gated."),
        ]),
        ("Claim worklists — the lifecycle", "Worklists are ordered the way a claim moves: verify coverage, secure authorization, gather paperwork, submit, then fix and appeal.", [
            ("Verify Insurance", "Run a one-off 270/271 eligibility transaction for any patient on demand — a quick coverage check that doesn't need an existing patient record."),
            ("Insurance Discovery", "When you don't know a patient's plan, search the payer network from their demographics to find active coverage."),
            ("Eligibility", "The system-wide 270/271 worklist. Rejected and inactive coverage rises to the top so you fix the highest-risk claims first."),
            ("Re-verification", "Active coverages due for a fresh check — never-checked, terminating soon, or stale beyond your interval."),
            ("Prior Auths", "Authorizations missed or at risk of breaching SLA, auths expiring soon, and drafts ready to submit. Supports electronic Da Vinci PAS submission where the payer accepts it."),
            ("CMN / DIF Worklist", "Certificates of Medical Necessity / DME Information Forms still awaiting completion before a claim can go out."),
            ("Bill Hold", "Claims deliberately held from billing until their signed paperwork is back — work this list to release them once documentation lands."),
            ("Auto-submit", "Claims that are preflight-clean and backed by active eligibility, ready to transmit. Approve a batch yourself or let the scheduled cron send them (the cron only fires when both the schedule and the Control Center flag are on)."),
            ("AI Queue", "Claims the scrubber blocked plus a denial-analyzer worklist; the assistant suggests the code or edit and, where safe, an auto-resubmit."),
            ("Denials Worklist", "Open denials ranked by recoverable dollars × win-probability so you spend your time where it pays off most."),
        ]),
        ("A/R & collections", "Work claims and balances to get paid.", [
            ("A/R Aging", "Open claims bucketed 0/30/60/90+ days and broken out by payer — the classic aging worklist."),
            ("Filing Deadlines", "Open claims ranked by days remaining before the payer's timely-filing window closes, so you never lose a claim to the clock."),
            ("Secondary Claims", "Coordination of benefits: roll the primary payer's leftover balance onto the secondary payer's claim."),
            ("Statement Send", "Send patient-responsibility statements by email or SMS. Consent- and quiet-hours-aware so you stay compliant."),
            ("Collections", "Patient balances that have gone unpaid move automatically up a dunning ladder — statement (day 0) → reminder (day 7) → second notice (day 21) → final notice (day 35) → collection agency (day 60). The ladder <b>auto-pauses the instant a balance is paid or put on a payment plan</b>, so you never dun a patient who has already settled up. Batch-print the final-notice letters as one PDF, and export the agency-eligible accounts when you place them with a collections partner. (The dunning ladder is gated behind the <b>collections.dunning</b> flag and agency export behind <b>collections.agency_export</b> in the Control Center.)"),
            ("Capped Rentals", "Track CMS 13- and 36-month capped-rental cycles and rotate the KH/KI/KX modifiers automatically as each cycle advances."),
            ("ADR / Audit Response", "When a payer or contractor sends an Additional Documentation Request, every open ADR lands here ranked by response deadline, with a per-request checklist of what to gather and a record of the win/loss outcome so you can see how the practice fares on audits. Gated behind the <b>billing.adr_queue</b> flag."),
            ("Audit Packet", "Assemble a complete, audit-ready CPAP/PAP documentation packet — the Standard Written Order, CMN, sleep study, compliance summary, proof of delivery, and supporting notes — into a single PDF you can send to the payer in one click, instead of hunting the chart for each page."),
        ]),
        ("Tools & configuration", "The clearinghouse, payment posting, manual entry, and the payer rules behind it all.", [
            ("ERA Files", "Upload an 835 remittance and the system auto-posts the payer's adjudications against the matching claims, flagging denials for the worklist."),
            ("Office Ally", "Your clearinghouse cockpit: 837P submissions, acknowledgements (999/277CA), and live transmission status. (Office Ally has a stub mode for preview environments.)"),
            ("Manual Claim", "Key a corrected, void/replacement, or paper-backup claim by hand when an automated path doesn't fit."),
            ("Billing Config", "The rule store the whole engine reads: payer profiles, fee schedules (with CMS import), modifier rules, denial-code mappings, claim templates, and HCPCS coverage diagnoses."),
            ("Package & Usage", "Your CareMetric Breathe subscription plan, optional add-ons, and the current month's usage — useful when planning spend."),
        ]),
    ],
    "csr": [
        ("How the resupply engine works, end to end", "Resupply is the heart of the business, and it largely runs itself. Here's the machinery behind the reorder cycle.", [
            ("When reminders go out", "An automated job scans hourly for prescriptions that are due and sends a reminder on each patient's cadence — typically the 90- and 30-day reorder windows. The cadence is resolved per patient: an explicit per-patient override wins, then frequency rules matched by product, payer, and how long the patient has been on service, then the prescription's own interval. Device-reported supply schedules from the therapy-cloud sync feed the next-eligible dates, so reminders track real wear, not just the calendar."),
            ("One tap for the patient", "Reminders go by SMS and email (the AI voice agent can call, too). Email carries signed one-tap <b>confirm</b>, <b>edit</b>, and <b>stop</b> links — no login, no account, no phone tree; SMS simply accepts a reply to confirm or decline. A quiet-period guard skips anyone you've already been talking to in the last 48 hours, and one reminder goes out per patient per cycle even if several items are due."),
            ("Why it lifts reorders", "Because outreach fires automatically on the payer-allowed cadence across every channel, eligible patients are reliably reminded instead of forgotten — and a confirmation takes one tap, so more of them say yes. A confirmed reorder flows straight through the funnel — <b>due → reminded → confirmed → shipped</b> — into fulfillment and billing with no re-keying, and you can watch the conversion at each step, per channel, on the Reorder Reminders board."),
            ("Effortless for the customer", "No app to download, no portal to remember: tap to confirm, change, or stop right from the text or email. Patients who'd rather not think about it subscribe once and let auto-ship keep supplies arriving on the cadence their insurance allows."),
        ]),
        ("Paperless paperwork — e-signature, nothing printed", "Everything a patient or provider needs to sign is signed on a screen. No printing, no scanning, no faxing, no lost forms, no delays.", [
            ("Sign on a phone, file automatically", "Staff stage a document or a packet; the patient gets a link and e-signs on their own device with a typed name and explicit ESIGN consent — image-free and ESIGN-Act compliant. The signed PDF files itself to the chart the moment it's done, and any related <b>bill hold</b> lifts automatically so the claim can go out. Nothing is printed, nothing gets lost, and nothing waits on the mail."),
            ("Included document templates", "Ready-to-send templates ship with the system:<br/>• Standard Written Order (SWO) — PAP device &amp; supplies<br/>• PAP Certificate of Medical Necessity (CMN)<br/>• Structured CMN forms — CMS-484 (oxygen), CMS-846 (compression), CMS-848 (TENS)<br/>• DWO / CMN renewal forms by HCPCS family (PAP, RAD, oxygen, …)<br/>• ABN (CMS-R-131) with Options 1–3<br/>• Assignment of Benefits &amp; financial responsibility<br/>• DMEPOS Supplier Standards notice<br/>• Proof of Delivery<br/>• Refill Confirmation<br/>• New-patient setup packet (ABN + Supplier Standards + AOB, sent as one)<br/>Plus free-form manual documents (prescription, agreement, delivery ticket, cover letter) and documentation packets (prior-auth support, appeal support, accreditation audit, medical-records request)."),
        ]),
        ("The provider portal — providers e-sign and see their patients", "A secure portal that ends the fax-and-chase cycle with referring physicians.", [
            ("Providers e-sign — no more faxing", "Invite a referring provider (by NPI, verified against NPPES) into a secure, MFA-protected portal. Stage their CMNs, DWOs, prescription packets, and claims for signature, and the provider signs on their own device — instead of receiving a fax, printing it, signing, and faxing it back (and you chasing what never comes). Every signature is captured in a tamper-evident, hash-chained audit trail with a printable, ESIGN-compliant certificate you can hand a payer."),
            ("Providers see their patients", "In the same portal a provider can view their patients' active orders and prescriptions and read their therapy data and reports (read-only) — so they can confirm adherence and close the loop without a phone call to your office."),
            ("Lifecycle & security", "Each document moves pending → signed → ready-to-print / returned-signed / attached-to-chart / released, so staff always know where it stands. Multi-factor authentication is mandatory for every provider, and the portal is off by default — an Owner enables it per tenant in the Control Center."),
        ]),
        ("Your daily workspace", "Where a CSR lives all day — the inbox, the front desk, and the work queues.", [
            ("Home", "The shared worklist and live counters. As a CSR you'll watch conversations awaiting reply, overdue follow-ups, and returns to action."),
            ("Front Desk", "Capture a walk-in customer and ring up a counter order in real time — cash or bill-to-insurance — without going through the public storefront checkout."),
            ("Conversations", "The unified inbox for inbound SMS, MMS, and email across every patient. Triage threads, claim one for yourself, reply (optionally with a canned reply), tag, snooze, and escalate to a case. Smart routing and required-skills keep threads with the right people."),
            ("Email Inbox", "Inbound patient email split into “needs response” and “already answered.” When the AI email auto-reply feature is on, high-confidence answers can be drafted or sent automatically; anything account-, order-, or clinically-specific falls through to a human."),
            ("Cases", "Multi-channel tickets that bind together the conversations, orders, faxes, and documents belonging to one issue, so a complex problem stays tracked end to end."),
            ("Episodes", "Dated service promises — “we'll call Tuesday,” “awaiting the sleep study” — that keep open commitments from slipping."),
        ]),
        ("Schedule & outreach", "Plan the day and reach patients at scale or one at a time.", [
            ("Company Calendar", "The shared team schedule of patient appointments — fittings, equipment setups, follow-ups, and video visits — with office hours and closures respected."),
            ("Video Visits", "Run telehealth visits for setups and mask troubleshooting; the system generates a secure join link and sends it by SMS/email."),
            ("Follow-ups", "Today's callback queue across customers and patients, with overdue items surfaced so nothing is forgotten."),
            ("Bulk Campaigns", "Build an audience with filters, sanity-check the recipient count, draft the message, and send a batch SMS or email."),
            ("Alert Library & Reminders", "Send a curated one-off alert (SMS/email/call) to an individual patient, and manage the automated resupply reminder schedule."),
            ("Playbooks, Canned Replies & Automated Messages", "Reusable situation-based outreach cadences, saved snippets you drop into manual replies, and the editable copy behind system-sent messages (order confirmations, tracking)."),
        ]),
        ("Patients & paperwork", "The patient record and the documents that surround care.", [
            ("Patients", "Search the roster and open a record for the 360° timeline — every order, message, document, therapy reading, and billing event in one place. Edit demographics and notes."),
            ("Duplicate Review", "Find likely-duplicate patient records and merge them so a patient's history isn't split across two charts."),
            ("Documents & Document Packets", "Draft a CMN, prescription, agreement, or fax cover by hand, then send and track an e-signature packet for new-patient onboarding."),
            ("Awaiting Signatures & Inbound Faxes", "Track documents out for provider signature and scan returned faxes to file them; triage the inbound-fax queue (sleep studies, Rx renewals, chart notes)."),
            ("Referral Reviewer & Sources", "Review AI-extracted intake from faxed/uploaded referral packets and accept them into a new patient record; the Sources scorecard ranks referring physicians by volume and revenue."),
        ]),
        ("Orders, shop & leads", "Fulfillment and the storefront acquisition funnel.", [
            ("Orders", "Work storefront orders — fulfill, refund, look up, and track — from a single queue."),
            ("Shipping Labels", "Print shipping labels with the patient's address merged in; tracking numbers auto-fill back onto the order."),
            ("Subscriptions, Returns & Backorders", "Manage recurring resupply/Subscribe-and-Save subscriptions, decide returns/RMAs and refunds (comfort-guarantee aware), and handle out-of-stock SKUs and substitutions. When a returned item is genuinely resaleable, marking it received can optionally <b>restock</b> it — adding its quantities back to tracked inventory. It's off by default (most DME consumables aren't resaleable), so you opt in per return."),
            ("Customers, Reviews & Product Q&A", "Registered shop accounts (including each customer's cash-pay <b>membership tier</b>) with in-app messaging, product reviews to moderate and reply to, and customer questions to answer or reject. The post-purchase <b>review request</b> can be sent on demand (“Send due”) or, once enabled, goes out automatically on an hourly sweep about two weeks after delivery — one request per order, consent-aware."),
            ("Abandoned Carts, Back-in-Stock & Insurance Leads", "Recover abandoned carts with outreach, notify customers when items restock, and work new benefit-verification requests from the storefront."),
            ("Fitter Invites & Prospects", "Invite a patient to the AI mask fitter and review the returned mask & size recommendation; the Prospects view tracks the fitter conversion funnel."),
        ]),
    ],
    "rt": [
        ("Therapy data from every cloud, one login", "Manage every patient from one screen no matter whose machine they sleep on — no juggling three vendor portals.", [
            ("Three manufacturers, one screen", "A nightly sync pulls device data from <b>ResMed AirView</b>, <b>Philips Respironics Care Orchestrator</b>, and <b>3B Medical React Health</b> (Luna / iCode). Whatever brand a patient uses, their therapy lands in the same boards and the same patient chart — so an RT works one worklist, not three logins."),
            ("What it pulls", "For each linked patient the sync brings back device settings (model, serial, therapy mode, pressure min/max, ramp, humidifier, mask type); a compliance summary (days with data, days ≥ 4 hours, average usage and AHI, and the CMS 90/30 flag); recent nights (usage minutes, AHI, leak rate, P95 pressure); and supply items with last-replaced and next-eligible dates that drive resupply timing."),
            ("How the sync works", "An automated nightly job walks every active therapy link (least-recently-synced first, rate-limited so it's gentle on the vendor APIs), normalizes each vendor's quirks into one common shape, and stores a snapshot. The RT boards read that cache instantly; you can also force a manual refresh for one patient or one source from the patient chart."),
        ]),
        ("Alerts, and how compliance is ensured", "The platform watches therapy for you and surfaces the patients who need a human.", [
            ("Clinical alerts to the RT", "The Therapy Fleet worklist ranks patients by reason so you work the highest risk first: <b>setup-adherence risk</b>, <b>no recent data</b>, <b>high AHI</b>, <b>high leak</b>, and <b>usage decline</b>. Mask-fit feedback and open interventions feed the same queue, and clinical outreach is frequency-capped (a minimum gap between touches) so patients aren't over-contacted."),
            ("Ensuring CMS 90-day compliance", "Setup Adherence tracks every new PAP patient's first 90 days against the Medicare standard — ≥ 4 hours on ≥ 21 nights within any rolling 30-day window — and classifies each as qualified, on-track, or at-risk, with the best rolling count, nights still needed, and days remaining. At-risk patients surface early so you can coach them before the window closes and the rental fails to convert."),
            ("Alerts and messages to the customer", "The Alert Library sends curated one-off email, SMS, or voice alerts to a patient (with safe variable substitution), and resupply reminders nudge them on cadence. Optional enforcement can hold a too-soon or coverage-blocked reorder and route it to a CSR as an alert instead of letting it ship."),
        ]),
        ("Therapy monitoring", "Population boards that surface who needs attention, fed by the therapy-cloud integrations.", [
            ("RT Overview", "The at-a-glance therapy board: per-patient alerts with AHI, mask leak, and usage metrics, so you can spot a struggling patient fast."),
            ("Therapy Fleet", "Population compliance cohorts and the clinical outreach worklist — slice the patient base by how they're doing and act on the cohort that needs you."),
            ("Setup Adherence", "The CMS 90-day adherence tracker for new Medicare setups (the ≥4 hours on ≥70% of nights compliance window), so a setup never quietly fails its window."),
            ("Resupply Opportunities", "Device-reported supplies that are due for replacement, which feed resupply orders."),
            ("RT Outcomes", "Per-therapist activity — encounters logged, patients touched, interventions opened — for visibility into clinical workload and impact."),
        ]),
        ("Clinical work", "Document care and drive non-adherent patients back on track.", [
            ("Clinical Encounters", "The clinical documentation store: record an encounter with reason, assessment, intervention, and plan, or just a free-text note. The patient's clinical timeline is built from these."),
            ("Interventions", "A structured worklist for non-adherent patients — capture the cause, the plan, and the outcome, and track it to resolution."),
            ("Mask-fit Feedback", "Triage patients who report a leaking or uncomfortable fit and route them to a follow-up or refit."),
            ("Clinical Outreach", "Send supportive check-ins to patients with an open intervention. Consent- and do-not-disturb-aware so outreach stays appropriate."),
            ("Adherence Coaching", "Build outreach plans for patients whose CPAP use is slipping, before they fall out of compliance."),
            ("Video Library", "Curate the short education videos shown to patients on the storefront's learn pages."),
        ]),
        ("Providers, devices & reporting", "The registry, equipment safety, and provider-ready output.", [
            ("Providers", "The central physician / nurse-practitioner registry, backed by NPPES lookups, used across prescriptions and referrals."),
            ("Recalls", "The manufacturer recall registry, scanned against your dispensed device serials to flag at-risk patients."),
            ("Asset Recovery", "Recover machines from discontinued patients so they can be refurbished and redeployed."),
            ("Therapy Report", "A provider-ready, print-quality adherence snapshot you can generate by provider, patient, or device manufacturer — ideal for closing the loop with referring physicians."),
            ("Patient clinical timeline", "Inside the patient 360° view, the clinical tab gathers therapy readings, prescriptions, encounters, and resupply history in one chronological story."),
        ]),
    ],
}


# ── Part 3: job aides (curated key workflows) ────────────────────────
# role_id -> list of (task_title, intro, [steps], optional_tip)
JOB_AIDES = {
    "administrator": [
        ("Create your CareMetric Breathe workspace (self-serve sign-up)",
         "How a brand-new practice gets its own workspace and first Owner login.",
         ["Go to the public site <b>/breathe</b> and choose <b>Create your account</b> (<b>/breathe/signup</b>).",
          "Enter your <b>company name</b>, a <b>work email</b>, a <b>password</b> (at least 12 characters), and pick a <b>plan</b> (Virtual Mask Fitter, Launch, Growth, or Scale — Enterprise routes to sales).",
          "Submit. We provision your organization, copy in your plan's feature-flag bundle, and create your first <b>Owner</b> login.",
          "Open the <b>verification email</b> we send and click the link to activate the account (sign-in is blocked until it's verified).",
          "Sign in at <b>/admin/sign-in</b>, confirm payment, then work the setup checklist below."],
         "Only the first Owner self-signs-up; every teammate after that is invited from the Team page. (Operators can also pre-provision a workspace from the command line.)"),
        ("Sign in and turn on multi-factor authentication",
         "Do this first — every admin account should have MFA.",
         ["Go to <b>/admin/sign-in</b> and sign in with your email and password.",
          "Open <b>System → Account Security</b>.",
          "Choose <b>Add authenticator</b> and scan the QR code with your phone's authenticator app (Google Authenticator, Authy, 1Password, etc.).",
          "Enter the 6-digit code to confirm, then save your recovery codes somewhere safe.",
          "Sign out and back in to confirm the code is requested."],
         "If you lose your authenticator, a recovery code or another Owner can restore access — store recovery codes offline."),
        ("Finish the workspace setup checklist",
         "Make the platform run under your own brand, numbers, and payments.",
         ["Open <b>System → Set Up Your Workspace</b> (or click the “finish setting up” banner on Home).",
          "Set your brand and logo under <b>Storefront Branding</b>, and your legal details under <b>Company Information</b>.",
          "Connect your numbers under <b>Phone &amp; SMS</b> and <b>Fax Number</b>, and your sender under <b>Email From Address</b> (authenticate the sending domain for deliverability).",
          "Wire up payments (Stripe) so the storefront and patient statements can collect.",
          "Work down the checklist until every essential step is green."],
         "A NULL/unset From address falls back to the platform default — patient email still sends, but your own authenticated domain lands in the inbox instead of spam."),
        ("Invite a team member and assign a role",
         "Add staff and scope their access to exactly what they need.",
         ["Open <b>System → Team</b> (Owner only).",
          "In the invite card, enter the person's email and pick a role: <b>Owner</b>, <b>Admin</b>, <b>Customer service rep</b>, <b>Biller</b>, or <b>Respiratory Therapist</b>.",
          "Optionally add a display name, a home location, and notes, then send the invite.",
          "The invitee receives a sign-up link by email and sets their own password before first login.",
          "To change someone later, use the role selector on their row, or <b>Revoke</b> to remove access immediately."],
         "Pick <b>Biller</b> for revenue-cycle staff — it unlocks the whole Billing area without exposing CSR tools, clinical notes, or system settings."),
        ("Turn a feature on or off",
         "The Control Center is the master switch panel.",
         ["Open <b>System → Setup &amp; Advanced → Control Center</b>.",
          "Find the feature — voice agent, SMS/email campaigns, claim auto-submit, AI billing, the storefront chatbot, the admin assistant, multi-location, etc.",
          "Flip the toggle; the change takes effect immediately for everyone.",
          "For automation that sends messages (e.g. auto-submit), confirm the matching schedule/credentials are configured too."],
         "Use the Bot Playground to rehearse the chatbots before enabling them for real patients."),
        ("Connect a therapy-cloud integration",
         "Pull device adherence data from ResMed, Philips, or 3B.",
         ["Open <b>System → Setup &amp; Advanced → System Configuration</b> (Owner only) and enter the vendor credentials.",
          "Open <b>System → Operations → Integrations</b> to confirm the connection reports <i>available</i>.",
          "Trigger a sync (or wait for the nightly job) and watch the sync status.",
          "Patient therapy data now flows into the RT Overview and Therapy Fleet boards."],
         "If an integration shows <i>unavailable</i>, a credential is missing — re-check System Configuration; the badge never reveals which secret is unset."),
        ("Send team alerts to Slack",
         "Bring real-time CS alerts and operator digests into your team's Slack.",
         ["In Slack, create an app/bot and note its <b>bot token</b>, <b>signing secret</b>, and the <b>channel</b> for alerts.",
          "Open <b>System → Setup &amp; Advanced → System Configuration</b> (Owner only) and enter those values.",
          "In the <b>Control Center</b>, confirm <font name=\"Courier\" size=\"8\">slack.notifications</font>, <font name=\"Courier\" size=\"8\">slack.interactivity</font>, and <font name=\"Courier\" size=\"8\">slack.digests</font> are on (they ship on but stay inert until the credentials exist).",
          "On the <b>Team</b> page, link each teammate's Slack handle so Escalate actions are attributed correctly.",
          "Post a test event and confirm the alert (with its Escalate button and deep link) lands in your channel."],
         "Slack messages are deliberately non-PHI — a reference, a status, and a link back into the console — never message bodies, phone numbers, or clinical detail."),
        ("Check that the plumbing is healthy",
         "A two-minute daily glance at jobs and message delivery.",
         ["Open <b>System → Operations</b> and confirm the background worker and nightly sync ran without errors.",
          "Open <b>Outbound Messages</b> to scan recent SMS/email delivery results.",
          "Open <b>Delivery Failures</b> and retry or resolve any bounces or shipping exceptions.",
          "If a partner webhook failed, re-queue it from <b>Webhook Deliveries</b>."],
         None),
        ("Set business goals and KPI alerts",
         "Tell the platform what “good” looks like and let it warn you.",
         ["Open <b>Analytics &amp; Reports → Performance &amp; Goals → Goals &amp; Targets</b> and set a target per KPI and period.",
          "Open <b>KPI Alerts</b> and define the thresholds that should trigger a warning (revenue, denial rate, churn).",
          "Watch pace-to-goal on the dashboard and act on alerts as they fire."],
         None),
        ("Ask CareMetric Copilot for help",
         "The fastest way to find a page or learn how something works.",
         ["Click <b>Ask CareMetric Copilot</b> on any admin page.",
          "Type a plain-language question — “where do I turn features on or off?” or “walk me through processing a claim.”",
          "Follow the clickable links it returns straight to the right page.",
          "Have an idea for a missing feature? Tell it — after you confirm, it emails a structured suggestion to the owners."],
         "The assistant only explains the app and (with your OK) forwards ideas. It never changes data or shows patient PHI."),
        ("Get billing ready for go-live",
         "Stand up the revenue cycle before the first claim.",
         ["Enter clearinghouse credentials (Office Ally; and Da Vinci PAS if used) under <b>System Configuration</b>.",
          "Under <b>Billing → Config</b>, add your payer profiles, import the CMS DMEPOS fee schedule, and set modifier + denial-code rules.",
          "Decide automation posture in the Control Center: eligibility pre-check, auto-re-verify, claim auto-submit, AI billing — start manual, then enable as you trust it.",
          "Validate against Office Ally's test (T) cycle before flipping line-level changes like the ordering-provider loop on live claims."],
         "Run claims through the manual staged-approval path first; turn on the auto-submit cron once a few clean batches have gone out."),
        ("Connect PacWare (billing/warehouse) sync",
         "Bridge to a legacy PacWare system without an API.",
         ["Open <b>System → Operations → PacWare</b>.",
          "Import the patient roster CSV — existing patients only have BLANK fields filled, never overwritten.",
          "Export the patient roster or resupply-due worklist with the verify step (preview the count + sample first).",
          "Nothing is ever pushed automatically; the opt-in “ready to sync” notice tells staff when an export is worth running."],
         None),
        ("Run and export a report for the books",
         "Pull the numbers your accountant needs in a couple of clicks.",
         ["Open <b>Analytics &amp; Reports → Reports</b>.",
          "Pick the report — revenue summary, patient payments, insurance claims, refunds journal, or the all-financial bundle.",
          "Set the date range (up to 90 days).",
          "Export as CSV, PDF, or QuickBooks (Desktop .iif or Online .qbo.csv)."],
         "Patient payments and insurance claims are kept separate so cash isn't double-counted across the two."),
        ("See who accessed a patient's record",
         "Answer a “who looked at this chart?” question.",
         ["Open <b>Analytics &amp; Reports → Audit Trail</b> (admins only).",
          "Filter by employee, by patient, and by time frame to narrow the access events.",
          "Read the list of who accessed which patient's information, and when."],
         "The Audit Trail is kept out of the CSR and clinician sidebars; only full admins can open it."),
        ("Invite a provider to the e-sign portal",
         "End the fax-and-chase cycle with a referring physician.",
         ["Confirm the provider exists under <b>Patients &amp; Clinical → Providers &amp; Recalls → Providers</b> (add them by NPI; NPPES verifies).",
          "Make sure the provider portal is enabled in the Control Center.",
          "Invite the provider from the E-signature Portal — they get a set-password link and must enroll MFA.",
          "Stage their documents for signature; they sign on their device and you track each through to released/attached."],
         "Providers can also view their patients' therapy and reports in the portal — read-only, no PHI leaves your control."),
    ],
    "biller": [
        ("Verify a patient's insurance (270/271)",
         "Confirm coverage before you bill.",
         ["Open <b>Billing → Worklists → Verify Insurance</b>.",
          "Enter the patient and plan details (or pick an existing patient).",
          "Run the check; the 271 response shows active/inactive status and plan details.",
          "If coverage is unknown, use <b>Insurance Discovery</b> to find it from demographics instead."],
         "Work the system-wide <b>Eligibility</b> worklist regularly — rejected and inactive coverage floats to the top."),
        ("Submit a prior authorization",
         "Secure the auth before the claim goes out.",
         ["Open <b>Billing → Worklists → Prior Auths</b>.",
          "Pick a draft (or a claim flagged as needing auth) and open the request form.",
          "Complete the clinical justification and attach the supporting documentation.",
          "Submit electronically via Da Vinci PAS where the payer supports it; otherwise follow the payer's channel.",
          "Track the status and watch the “expiring soon” list so an auth never lapses mid-therapy."],
         None),
        ("Submit claims through the clearinghouse",
         "Get clean claims out the door.",
         ["Open <b>Billing → Worklists → Auto-submit</b> to see claims that are preflight-clean with active eligibility.",
          "Review the batch and approve it to transmit — or let the scheduled cron send it automatically.",
          "Open <b>Billing → Tools → Office Ally</b> to watch 837P submissions and acknowledgements (999/277CA).",
          "For a one-off or corrected claim, use <b>Manual Claim</b> instead."],
         "The auto-submit cron only fires when BOTH the schedule and the Control Center flag are on — ask an admin if it's quiet."),
        ("Post an ERA (835 remittance)",
         "Auto-post payer payments and surface denials.",
         ["Open <b>Billing → Tools → ERA Files</b>.",
          "Upload the 835 file from the payer/clearinghouse.",
          "The system matches it to claims and posts the adjudications automatically.",
          "Denied lines flow to the Denials worklist for follow-up."],
         None),
        ("Work denials and file an appeal",
         "Recover the dollars worth chasing first.",
         ["Open <b>Billing → Worklists → Denials Worklist</b> — it's ranked by recoverable dollars × win-probability.",
          "Open the top denial; the AI Queue may already suggest the corrected code or edit.",
          "Fix and resubmit, or start an appeal with the supporting documentation.",
          "Track the appeal to resolution."],
         "Check <b>Denials &amp; DSO</b> periodically to spot a payer whose denial rate is trending up."),
        ("Work A/R aging and timely filing",
         "Don't let claims age out or miss the filing window.",
         ["Open <b>Billing → A/R &amp; collections → A/R Aging</b> and work the oldest buckets and worst payers first.",
          "Open <b>Filing Deadlines</b> and clear anything close to its timely-filing cutoff immediately.",
          "Roll any primary balances to secondary payers from <b>Secondary Claims</b>."],
         None),
        ("Send a patient statement",
         "Collect the patient-responsibility balance.",
         ["Open <b>Billing → A/R &amp; collections → Statement Send</b>.",
          "Review the patient-responsibility amounts due.",
          "Send by email or SMS — the system respects consent and quiet hours automatically.",
          "Use a payment link so the patient can pay online."],
         None),
        ("Configure a payer profile and fee schedule",
         "Set the rules the claim engine reads.",
         ["Open <b>Billing → Tools → Config</b>.",
          "Add or edit the payer profile (IDs, addresses, claim format).",
          "Import or enter the fee schedule (CMS import is available), modifier rules, and denial-code mappings.",
          "Map HCPCS coverage diagnoses so claims build with the right codes."],
         "Fee-schedule and clearinghouse setup is usually a one-time job with an admin — once it's right, the worklists run smoothly."),
        ("Quick-verify a patient's coverage from their chart",
         "The one-click check you'll use most.",
         ["Open the patient (<b>Patients &amp; Clinical → Patients</b>) or their billing tab.",
          "Click <b>Verify insurance</b> in the quick-actions card.",
          "Read the 271 result inline — active/inactive, plan, copay/deductible — or the “queued” note if the payer answers by deferred file.",
          "The result is saved to the patient's eligibility history for the next biller."],
         "Same button lives on the eligibility worklist and a standalone cross-patient verifier (Billing → Verify Insurance) for bulk checks."),
        ("Find unknown coverage with Insurance Discovery",
         "Turn “we don't know who covers them” into a billable claim.",
         ["Open <b>Billing → Worklists → Insurance Discovery</b>.",
          "Enter the patient's demographics (name, DOB, ZIP; optional SSN / member-id hint).",
          "Run the search; review the active coverages the payer network returns.",
          "Attach the right coverage to the patient and proceed to verify/bill."],
         "Insurance Discovery is a paid clearinghouse add-on — if it's greyed out, an Owner enables it in the Control Center for your tenant."),
        ("Work the AI Queue",
         "Let the assistant tee up the highest-payoff claims.",
         ["Open <b>Billing → Worklists → AI Queue</b>.",
          "<b>Blocking</b> drafts need your input — open, fix the flagged issue, re-scrub.",
          "<b>Fixable</b> drafts come with suggested patches — review and apply with one click.",
          "<b>Needs analysis</b> denials — run the denial analyzer to get root cause + fix steps.",
          "<b>Auto-resubmit ready</b> — the fix is safe and high-confidence; approve the one-click resubmit."],
         "The AI never changes a claim without you approving the patch; PHI is minimized before anything reaches the model."),
        ("Advance a capped-rental cycle",
         "Keep Medicare CPAP rentals billing on schedule with the right modifiers.",
         ["Open <b>Billing → A/R &amp; collections → Capped Rentals</b>.",
          "Review the cycles due for their next rental month.",
          "Confirm the auto-generated monthly claim — the modifier is already rotated (KH months 1–3, KI from month 4, plus KX once 90-day compliance is met).",
          "Submit it with the rest of your batch."],
         "Compliance (≥4 hrs on ≥70% of nights) is read from the therapy-cloud sync, so the KX modifier is applied only when the data supports it."),
        ("Generate and submit a secondary (COB) claim",
         "Collect the balance the primary left behind.",
         ["After a primary pays (via ERA), open <b>Billing → A/R &amp; collections → Secondary Claims</b>.",
          "Open the auto-drafted secondary — the COB amounts (paid, contractual, patient responsibility) are already snapshotted from the primary's 835.",
          "Review the secondary payer and line amounts, then submit.",
          "If auto-draft is off for your tenant, use the COB-eligible worklist to create it."],
         "Secondary claims are never auto-submitted — they always wait for a biller to review."),
        ("Clear a bill hold",
         "Release a claim once its paperwork is back.",
         ["A claim with outstanding REQUIRED paperwork (Rx, SWO/DWO, CMN, AOB, ABN, proof of delivery) is held from submission.",
          "Open the claim or <b>Billing → Worklists → Bill Hold</b> to see what's missing.",
          "Mark the requirement satisfied — or it clears itself when the patient e-signs, you upload the doc, or an inbound fax auto-matches it.",
          "The hold lifts automatically when the last requirement is met; the claim joins the next batch."],
         None),
        ("Work the patient collections ladder",
         "Escalate unpaid balances without dunning anyone who has already paid.",
         ["Open <b>Billing → A/R &amp; collections → Collections</b>.",
          "Each unpaid balance sits on a dunning rung — statement → reminder → second notice → final notice → agency — and advances on its cadence automatically.",
          "Batch-print the final-notice letters as one PDF for the accounts that have reached that rung.",
          "For accounts that reach the agency step, export the agency-eligible list (a reviewed, deliberate action) to place with your collections partner."],
         "The ladder pauses the instant a balance is paid or the patient goes on a payment plan, so settled patients are never dunned. Requires the collections.dunning flag (and collections.agency_export for the hand-off) — an Owner enables them in the Control Center."),
        ("Respond to a Medicare ADR (audit request)",
         "Answer an Additional Documentation Request before its deadline.",
         ["Open <b>Billing → A/R &amp; collections → ADR / Audit Response</b> — open requests are ranked by response deadline.",
          "Open the request and work its checklist of the documents the payer/contractor wants.",
          "Use <b>Build audit packet</b> to assemble the SWO, CMN, sleep study, compliance summary, proof of delivery, and notes into one PDF, then submit it.",
          "Record the outcome (won/lost) so your audit win-rate is tracked."],
         "Requires the billing.adr_queue flag (an Owner enables it in the Control Center); a nightly sweep surfaces at-risk and overdue deadlines."),
    ],
    "csr": [
        ("Handle an inbound message",
         "Triage and reply in the unified inbox.",
         ["Open <b>Workspace → Conversations</b> and pick a thread awaiting reply (or claim one for yourself).",
          "Read the patient's history in the side panel for context.",
          "Reply directly, or insert a <b>Canned Reply</b> for a common answer.",
          "Tag or snooze the thread, or promote it to a <b>Case</b> if it spans multiple channels.",
          "If it needs a specialist, assign it or escalate."],
         "Order-, account-, and clinical-specific questions should go to the right person — use Cases so the full history travels with the issue."),
        ("Ring up a walk-in (counter order)",
         "Capture an in-person customer at the front desk.",
         ["Open <b>Workspace → Front Desk</b>.",
          "Look up the customer or create a new record.",
          "Add the products to the order.",
          "Choose cash or bill-to-insurance and complete the sale.",
          "Print a receipt and, if shipping, a label."],
         None),
        ("Look up a patient and read the 360° timeline",
         "Everything about a patient in one place.",
         ["Open <b>Patients &amp; Clinical → Patients</b> and search by name or phone.",
          "Open the record to see the unified timeline — orders, messages, documents, therapy, and billing.",
          "Edit demographics or add a note as needed.",
          "If you find a duplicate, flag it in <b>Duplicate Review</b> to merge the charts."],
         None),
        ("Send a bulk SMS or email campaign",
         "Reach a filtered audience at once.",
         ["Open <b>Workspace → Outreach → Bulk Campaigns</b>.",
          "Build the audience with filters and check the resolved recipient count.",
          "Draft the message (or start from a Playbook).",
          "Review and send; track delivery under <b>Outbound Messages</b>."],
         "Always sanity-check the recipient count before sending — it's the cheapest way to avoid an embarrassing mass message."),
        ("Schedule a follow-up or video visit",
         "Put the next touch on the calendar.",
         ["Open <b>Workspace → Schedule → Company Calendar</b>.",
          "Create an appointment (fitting, setup, follow-up) on the right day, respecting office hours.",
          "For telehealth, create a <b>Video Visit</b> — the join link is sent to the patient by SMS/email.",
          "Track the callback queue under <b>Follow-ups</b>."],
         None),
        ("Process a return or RMA",
         "Decide a return and close it out.",
         ["Open <b>Orders &amp; Shop → Orders → Returns &amp; RMAs</b>.",
          "Open the return request and review the reason and comfort-guarantee window.",
          "Approve or deny; on approval, choose restock and/or refund.",
          "The patient is notified automatically of the decision."],
         None),
        ("Fulfill and ship an order",
         "Get product out the door with tracking.",
         ["Open <b>Orders &amp; Shop → Orders</b> and pick the order to fulfill.",
          "Open <b>Shipping Labels</b> and print the label — the patient address is merged in automatically.",
          "The tracking number flows back onto the order and the patient is notified."],
         None),
        ("Send an e-signature document packet",
         "Get new-patient paperwork signed.",
         ["Open <b>Patients &amp; Clinical → Documents &amp; e-sign → Document Packets</b>.",
          "Choose the patient and the packet template (CMN, prescription, agreement).",
          "Send for e-signature; track progress under <b>Awaiting Signatures</b>.",
          "Returned faxes can be scanned in and filed against the patient."],
         None),
        ("Triage an inbound fax or referral",
         "Turn a faxed referral into a patient.",
         ["Open <b>Patients &amp; Clinical → Documents &amp; e-sign → Inbound Faxes</b> and review the queue.",
          "For a referral packet, open <b>Referral Reviewer</b> — the AI has already extracted the intake fields.",
          "Verify the demographics and insurance, then accept it into a new patient record.",
          "Attribute the referral to its source so the physician scorecard stays accurate."],
         None),
        ("Invite a patient to the AI mask fitter",
         "Let a patient size their mask from a selfie.",
         ["Open <b>Orders &amp; Shop → Storefront &amp; Leads → Fitter Invites</b>.",
          "Enter the patient and send the invite link.",
          "When they finish, review the returned mask and size recommendation.",
          "Convert it to an order, or follow up from the Prospects funnel."],
         None),
        ("Reply to a patient email (with AI assist)",
         "Work the email side of the inbox.",
         ["Open <b>Workspace → Email Inbox</b> and pick a thread in “needs response.”",
          "If AI auto-reply is on, a high-confidence draft may already be proposed — review and send, or edit first.",
          "For anything order-, account-, or clinically-specific, write the reply yourself or escalate to a case.",
          "Sent threads move to “already answered.”"],
         "AI auto-reply only sends on its own above a confidence bar; everything else falls to a human by design."),
        ("Recover an abandoned cart",
         "Win back a shopper who didn't finish checkout.",
         ["Open <b>Orders &amp; Shop → Storefront &amp; Leads → Abandoned Carts</b>.",
          "Review the cart and the customer's contact info.",
          "Send a recovery message (or let the automated cart-abandonment outreach handle it).",
          "Follow up if they re-engage."],
         None),
        ("Moderate a product review or answer a question",
         "Keep the storefront's social proof clean and helpful.",
         ["Open <b>Orders &amp; Shop → Storefront &amp; Leads → Reviews</b> (or Product Q&amp;A).",
          "Read the pending review/question.",
          "Approve, reply, or reject per your policy.",
          "Approved content publishes to the storefront."],
         None),
    ],
    "rt": [
        ("Review the therapy board and spot at-risk patients",
         "Your daily clinical triage.",
         ["Open <b>Patients &amp; Clinical → Therapy Monitoring → RT Overview</b>.",
          "Scan the alerts — high AHI, high mask leak, low usage — sorted by severity.",
          "Open a flagged patient to see their therapy detail.",
          "Use <b>Therapy Fleet</b> to work a whole compliance cohort at once."],
         "Therapy data is only as fresh as the integration sync — if a board looks empty, ask an admin to check Integrations."),
        ("Document a clinical encounter",
         "Capture the care you provided.",
         ["Open the patient's record, or <b>Patients &amp; Clinical → Clinical Work → Clinical Encounters</b>.",
          "Start a new encounter and choose its type (mask fit, troubleshoot, setup education, adherence intervention, phone, other).",
          "Record the reason, assessment, intervention, and plan — or just a free-text note.",
          "Set a follow-up date if one is needed, then save."],
         "Encounters build the patient's clinical timeline and back up the medical necessity behind claims — document while it's fresh."),
        ("Open and work a non-adherence intervention",
         "Get a slipping patient back on therapy.",
         ["Open <b>Patients &amp; Clinical → Clinical Work → Interventions</b>.",
          "Open the patient (or create an intervention from an RT Overview alert).",
          "Record the cause of non-adherence and the plan.",
          "Reach out via <b>Clinical Outreach</b> (consent/DND-aware), then log the outcome.",
          "Track it to resolution."],
         None),
        ("Track CMS 90-day setup adherence",
         "Make sure new Medicare setups clear their compliance window.",
         ["Open <b>Patients &amp; Clinical → Therapy Monitoring → Setup Adherence</b>.",
          "Review each new setup's progress toward ≥4 hours on ≥70% of nights within the 90-day window.",
          "For anyone trending short, open an intervention and coach early.",
          "Confirm passing patients before the window closes."],
         None),
        ("Work the resupply-due worklist",
         "Catch supplies that need replacing.",
         ["Open <b>Patients &amp; Clinical → Therapy Monitoring → Resupply Opportunities</b>.",
          "Review device-reported supplies that are due.",
          "Confirm the patient's needs and hand off to resupply ordering.",
          "Reorder reminders can carry the rest automatically."],
         None),
        ("Triage mask-fit feedback",
         "Fix leaks and discomfort before they cause drop-off.",
         ["Open <b>Patients &amp; Clinical → Clinical Work → Mask-fit Feedback</b>.",
          "Open a patient reporting a leaking or uncomfortable fit.",
          "Decide on a refit or follow-up and act on it.",
          "Document the encounter and outcome."],
         None),
        ("Generate a provider-ready therapy report",
         "Close the loop with the referring physician.",
         ["Open <b>Analytics &amp; Reports → Clinical &amp; Customer → Therapy Report</b>.",
          "Choose the scope — by provider, patient, or device manufacturer.",
          "Generate the print-quality adherence snapshot.",
          "Send or print it for the physician's chart."],
         None),
        ("Check equipment recalls",
         "Protect patients on recalled devices.",
         ["Open <b>Patients &amp; Clinical → Providers &amp; Recalls → Recalls</b>.",
          "Review the manufacturer recall registry.",
          "The system scans recalls against your dispensed serials and flags at-risk patients.",
          "Reach out to affected patients and arrange a remedy."],
         None),
        ("Request or renew a prescription",
         "Keep orders billable with current paperwork.",
         ["From the patient chart or <b>Patients &amp; Clinical → Providers &amp; Recalls → Providers</b>, find the ordering provider.",
          "Start a prescription / renewal request and stage the document.",
          "Send it for the provider's e-signature (or fax it) and track it under Awaiting Signatures.",
          "Once signed, it files to the chart and lifts any related bill hold."],
         None),
        ("Run a population outreach from a compliance cohort",
         "Act on a whole at-risk group at once.",
         ["Open <b>Patients &amp; Clinical → Therapy Monitoring → Therapy Fleet</b>.",
          "Pick the cohort that needs attention (e.g. low-usage, leak, or slipping adherence).",
          "Launch consent/DND-aware Clinical Outreach to the cohort.",
          "Track responses and open interventions for those who need a closer touch."],
         None),
    ],
}


# ── Appendix: permission matrix ──────────────────────────────────────
# A readable summary of what each role can reach. (The exact permission
# keys live in lib/resupply-auth/src/rbac.ts.)
MATRIX_AREAS = [
    "Home & Workspace",
    "Conversations / inbox & cases",
    "Patients (read / edit)",
    "Orders, shop & returns",
    "Billing & revenue cycle",
    "Therapy monitoring & clinical notes",
    "Analytics & financial reports",
    "Team management",
    "System configuration & secrets",
]
# value per (area, role): "full", "some", or "none"
MATRIX = {
    "Home & Workspace":                         ("full", "some", "full", "some"),
    "Conversations / inbox & cases":            ("full", "full", "full", "none"),
    "Patients (read / edit)":                   ("full", "some", "full", "some"),
    "Orders, shop & returns":                   ("full", "none", "full", "none"),
    "Billing & revenue cycle":                  ("full", "full", "none", "none"),
    "Therapy monitoring & clinical notes":      ("full", "none", "some", "full"),
    "Analytics & financial reports":            ("full", "some", "some", "some"),
    "Team management":                          ("some", "none", "none", "none"),
    "System configuration & secrets":           ("some", "none", "none", "none"),
}
MATRIX_NOTE = (
    "<b>Administrator</b> combines the Owner and Admin tiers — Owner-only "
    "items (Team management, System Configuration) are marked partial because "
    "only the Owner role can use them. <b>Biller</b> reaches the whole Billing "
    "area plus patient billing context and the shared inbox (revenue-cycle "
    "staff work patient-balance and benefit threads), but not clinical notes "
    "or settings. A practice can grant any combination by assigning the "
    "matching role on the Team page."
)

GLOSSARY = [
    ("270 / 271", "The electronic eligibility request (270) and the payer's response (271) that confirm a patient's coverage."),
    ("837P", "The electronic professional claim file sent to a payer (via the clearinghouse) to request payment."),
    ("835 / ERA", "The Electronic Remittance Advice — the payer's machine-readable explanation of what it paid, used to auto-post payments."),
    ("999 / 277CA", "Acknowledgements from the clearinghouse/payer confirming a claim file was received and accepted (or rejected)."),
    ("AHI", "Apnea-Hypopnea Index — events per hour of sleep; a core measure of how well therapy is controlling apnea."),
    ("Capped rental", "A Medicare payment model where a device is rented over a capped number of months (13 or 36) rather than purchased outright."),
    ("CMN / DIF", "Certificate of Medical Necessity / DME Information Form — documentation a payer requires to justify the equipment."),
    ("COGS", "Cost of Goods Sold — the product cost used to compute gross margin."),
    ("DSO", "Days Sales Outstanding — the average number of days it takes to collect after billing."),
    ("HCPCS", "The procedure/supply codes used on claims (e.g. the codes for a mask, machine, or filter)."),
    ("LTV : CAC", "Lifetime Value to Customer-Acquisition-Cost ratio — a measure of marketing efficiency."),
    ("MFA", "Multi-Factor Authentication — a second login factor (authenticator-app code) on top of your password."),
    ("NPS", "Net Promoter Score — a post-delivery satisfaction measure from patient survey responses."),
    ("Prior auth (PAS)", "Prior Authorization — payer approval secured before dispensing; Da Vinci PAS is the electronic FHIR standard for it."),
    ("Resupply", "The recurring replacement of CPAP consumables (masks, cushions, filters, tubing) on a cadence."),
]


# ── Setup guide ──────────────────────────────────────────────────────
# Things that must be set up before going live. (group, [(item, why)])
PREREQS = [
    ("Accounts & access", [
        ("Create your workspace", "Sign up at the public site (/breathe → Create your account): enter your company name, work email, a password (12+ characters), and a plan. That provisions your organization and your first Owner login; verify the emailed link, then sign in at /admin/sign-in. (Operators can also pre-provision a workspace from the command line, but self-serve sign-up is the normal path.)"),
        ("Enroll multi-factor authentication", "Each admin should add an authenticator app under System → Account Security before handling patient data."),
        ("Invite your team", "Add staff on the Team page and give each the right role — Owner, Admin, CSR, Biller, or Respiratory Therapist — so they see only what they need."),
        ("Apply your plan's recommended preset", "In the Control Center, one click sets your feature flags to the recommended bundle for your plan. New tenants already start on it; re-apply it after switching plans, then fine-tune individual flags."),
    ]),
    ("Brand & identity", [
        ("Company information", "Enter your legal name, addresses, and identifiers — they print on documents, statements, and the storefront."),
        ("Storefront branding", "Set the storefront name, tagline, logo, and theme. No logo yet? Generate a one-click starter monogram from your storefront name so nothing shows blank while you source artwork."),
        ("Custom domain", "Point your domain at the platform so patients see your brand (the platform fronts custom domains through Cloudflare)."),
    ]),
    ("Communication channels", [
        ("Phone & SMS numbers", "You can start messaging immediately: until you provision your own number, texts and calls go out on a shared platform number, and a patient's reply is routed back to the tenant that owns them. Provision your own dedicated voice and SMS numbers (through the platform's carrier, Twilio/Telnyx — you don't supply or port a line) when you want messages to come from your own number, typically as volume grows. Set this under Phone & SMS."),
        ("Fax number", "Faxes work on the shared platform number too; provision your own for inbound referrals and outbound signed paperwork when you're ready."),
        ("Email From address", "The platform default sender works out of the box; to send from your own address, set it AND authenticate the sending domain (SPF/DKIM) in the email provider — an unauthenticated address still sends but lands in spam."),
    ]),
    ("Money & integrations", [
        ("Payments (Stripe)", "Connect payment processing so the storefront and patient statements can collect; you confirm your subscription payment as you finish setup."),
        ("Clearinghouse & billing config", "Enter Office Ally (and, if used, Da Vinci PAS) credentials under System Configuration, then set up payer profiles and fee schedules under Billing → Config before submitting claims."),
        ("Therapy-cloud integrations", "Add ResMed AirView / Philips Care Orchestrator / 3B React Health credentials so adherence data flows into the RT boards."),
        ("Slack (optional)", "To bring alerts and digests into Slack, add a Slack bot token + channel under System Configuration and link each teammate's Slack handle on the Team page; the Slack toggles ship on but stay inert until the credentials are set."),
    ]),
]

SETUP_INTRO = (
    "Before your practice goes live, a handful of things must be configured "
    "so the platform runs under your own identity. Work the checklist below "
    "(the Home dashboard also shows a “finish setting up” banner until the "
    "essentials are done), then review the Control Center toggles so you "
    "know exactly what is on and off."
)
CONTROL_CENTER_INTRO = (
    "The Control Center (<b>System → Setup &amp; Advanced → Control "
    "Center</b>) is the master switch panel. Every major capability has a "
    "boolean on/off toggle that takes effect immediately — no deploy "
    "needed. Toggles are Owner-controlled and every change is recorded. The "
    "tables below list every toggle, its default, and what it does. A "
    "feature whose key shows after a dot (for example "
    "<font name=\"Courier\" size=\"8\">billing.auto_submit_claims</font>) is "
    "the exact key you will see in the panel. Many automations also require "
    "a matching credential or schedule to actually act — turning the toggle "
    "on without it is safe (it simply stays idle)."
)
FLAG_CATEGORY_ORDER = [
    "Messaging", "Voice & AI", "Storefront", "Billing", "Resupply",
    "Orders", "Documents", "Provider Portal", "Integrations",
    "Operations", "Referrals",
]
with open(os.path.join(HERE, "feature-flags.json"), encoding="utf-8") as _ff:
    FLAGS = json.load(_ff)


# ── What sets the platform apart ─────────────────────────────────────
DIFFERENTIATORS_INTRO = (
    "Most DME operations run on a patchwork: a billing system here, a "
    "resupply vendor there, an e-ordering tool, and spreadsheets between "
    "them. CareMetric Breathe replaces the patchwork with one AI-native "
    "platform built specifically for CPAP/PAP resupply — so the handoffs "
    "that used to mean re-keying, portal-hopping, and phone tag simply "
    "disappear. These are the capabilities that set it apart."
)
DIFFERENTIATORS = [
    ("AI mask fitting, no appointment",
     "Staff send a patient an invite link by text or email; the patient's "
     "phone camera measures their face right in the browser and scores every "
     "available mask for fit. Images never leave the device — only numeric "
     "measurements are sent — and none of the leading DME platforms offer "
     "anything like it. The completed fitting attaches itself to the right "
     "chart. Fewer fitting appointments, fewer wrong-size exchanges."),
    ("A voice agent that takes reorders",
     "Patients call and a natural AI voice confirms identity, takes the "
     "resupply order, and writes a structured summary with sentiment and "
     "clinical flags — 24/7, with no hold queue. It hands off to a human the "
     "moment the caller asks."),
    ("Resupply that runs itself",
     "Device-reported usage and payer replacement schedules trigger SMS and "
     "email reminders with signed one-tap confirm links; confirmed orders "
     "flow straight to fulfillment and billing. The reorder cycle turns "
     "without a CSR dialing a phone."),
    ("Eligibility and claims that work ahead of you",
     "Real-time 270/271 eligibility runs on a schedule and again right "
     "before a claim goes out; claims arrive pre-scrubbed; the AI flags the "
     "fix before submission. Billers stop chasing avoidable rejections."),
    ("Denial recovery ranked by dollars",
     "When a denial does land, the worklist ranks every one by recoverable "
     "value weighted by win-probability, and the AI denial analyzer reads "
     "the CARC/RARC codes, explains the root cause, drafts the fix or appeal, "
     "and — when it is safe — offers a one-click resubmit."),
    ("Every channel, one inbox",
     "SMS, MMS, email, chat, and AI call summaries land in a single triage "
     "queue with assignment, priorities, and consent and quiet-hours "
     "enforced automatically. One inbox replaces five tools."),
    ("Therapy data from all three clouds, one PAP department",
     "Nightly sync from ResMed AirView, Philips Care Orchestrator, and 3B "
     "React Health drives CMS 90-day compliance tracking, clinical "
     "worklists, and resupply timing — and it lives in the SAME system as "
     "the storefront, the customer database, billing, and documentation. No "
     "swivel-chair between systems, no per-module pricing, no integration "
     "projects."),
]

PLATFORM_FOUNDATIONS_INTRO = (
    "Beneath the four role workspaces sits a shared platform layer. These "
    "capabilities serve patients directly or protect the business as a "
    "whole, and every role benefits from them."
)
PLATFORM_FOUNDATIONS = [
    ("Patient storefront & portal", "A full e-commerce storefront with Stripe checkout, subscriptions, order tracking, returns, document access, insurance details, caregiver access, and self-serve cash-pay memberships — backed by a self-service patient account portal."),
    ("AI mask fitter", "Camera-based facial measurement in the patient's browser scores every available mask for fit. Images never leave the device — only numeric measurements are transmitted. The fitter is <b>invitation-only</b>: staff send a signed invite link by SMS or email from <b>Orders &amp; Shop → Fitter Invites</b>, and the completed fitting attaches back to the patient's chart."),
    ("Resupply reminder engine", "Automated SMS and email reminders with signed one-tap confirm/decline links, quiet-hours awareness, and unsubscribe handling."),
    ("AI voice agent", "A natural-voice phone agent that takes reorders, runs reminder and check-in calls, hands off to staff on request, and writes a structured summary of every call."),
    ("Chatbot & sleep coach", "Patient-facing AI chat for shopping help and therapy coaching, with optional high-confidence email auto-reply; anything uncertain hands off to staff."),
    ("CareMetric Copilot (admin assistant)", "An in-app AI helper on every admin page that answers “how do I” questions about the console and forwards staff feature ideas to ownership — always confirming before anything is sent."),
    ("Security & privacy", "Hardened sign-in with optional MFA, role-based access with granular permissions, CSRF and rate-limit protection, and strict PHI discipline: camera images and order payloads are never logged."),
    ("Always-on by design", "Feature flags flip capabilities instantly, vendor outages degrade gracefully instead of taking the site down, and background jobs handle syncs, reminders, and campaigns around the clock."),
]

# ── The storefront & end-to-end fulfillment journey ──────────────────
STOREFRONT_INTRO = (
    "Every tenant gets a complete, ready-to-sell storefront — not a brochure, "
    "a working e-commerce site that takes the patient from “which mask fits "
    "me?” all the way to a box on the doorstep, with the practice billing "
    "either the patient or their insurance. It's the same system that runs "
    "billing, clinical, and resupply, so an order never has to be re-keyed "
    "from one tool into another. Here's the whole journey, end to end."
)
STOREFRONT_JOURNEY = [
    ("1 · AI mask fitting, by invitation", "The mask fitter is <b>invitation-only</b>: a staff member sends the patient a signed link by text or email from <b>Orders &amp; Shop → Fitter Invites</b> (the public storefront's “get fitted” button routes to an invitation-required explainer, not the fitter). The patient opens the link, consents, the phone or laptop camera measures their face right in the browser, they answer a short comfort questionnaire (mouth-breather, side-sleeper, facial hair, glasses…), and the AI ranks the masks that fit best — each with an add-to-cart button. The camera images never leave the device; only numeric measurements are used. The completed fitting attaches itself to the matching chart (or waits in a holding area for staff to attach). No appointment, no guesswork, far fewer wrong-size exchanges."),
    ("2 · Shop and buy in minutes", "From the catalog the patient browses masks, cushions, tubing, filters, and bundles — with reviews, machine compatibility, and search — adds to the cart, and checks out through secure Stripe-hosted payment (card data never touches the platform). They can buy once, or choose <b>Subscribe &amp; Save</b> so supplies auto-ship on a cadence, or pick <b>in-store pickup</b> where it's offered."),
    ("3 · Or bill it to insurance", "Patients who'd rather use their benefits request insurance billing instead of paying cash. That drops a benefit-verification request into a CSR worklist, where staff run a real-time <b>270/271 eligibility</b> check, confirm what's covered and the patient's share, and — when coverage is good — create the order and send a signed payment link for the patient to e-sign and pay any balance. Coverage is confirmed <i>before</i> anything ships, so claims don't bounce later."),
    ("4 · Pick, pack, and a label in a click", "Paid, unshipped orders queue up in the Shipping console with the patient's address already filled in. Staff rate-shop USPS, UPS, and FedEx, create and print the carrier label, and the tracking number is written back onto the order and emailed to the patient automatically — or they can key in a tracking number by hand. Counter and walk-in orders print a receipt and label the same way."),
    ("5 · Delivered — with proof", "When the box arrives, staff capture <b>Proof of Delivery</b> right on the order — a delivery photo and an optional signature name — and the order is marked delivered. The patient can follow the whole way with a public <b>order-tracking</b> page (order number + email, no login)."),
    ("6 · Closing the loop", "After delivery the patient gets a quick satisfaction (NPS) prompt and a one-tap mask-fit check — “great / leaking / uncomfortable.” A problem answer routes straight to a CSR or therapist to fix the fit, and the patient is enrolled in the resupply engine so the next cushion, filter, and tube reorder cycle starts itself. The storefront sale becomes a recurring, self-renewing relationship."),
]

# ── Paperless paperwork: referrals in, faxes out, signatures tracked ──
PAPERLESS_INTRO = (
    "The paperwork around DME — referrals coming in, prescriptions and CMNs "
    "going out, signatures chased by fax — is where days disappear and "
    "claims stall waiting on a page that never came back. CareMetric Breathe "
    "turns that paper chase into a tracked, largely self-driving pipeline: "
    "AI reads an incoming referral and stages a ready-to-accept patient; any "
    "document goes out by eFax carrying a barcode that files itself the "
    "moment it returns signed; and every signature out with a provider is "
    "tracked until it comes home. Most of it is opt-in — turn each piece on "
    "per tenant in the Control Center."
)
PAPERLESS_REFERRAL = [
    ("AI reads the whole packet", "Upload a referral PDF — or let an inbound fax open one automatically — and the AI extracts the entire packet in a single pass: patient demographics, primary and secondary insurance, the ordered equipment with HCPCS codes, the sleep-study results, the referring physician (name, NPI, clinic, fax), and the diagnosis codes. Everything lands in an editable form beside the original page so you can check any field against the source."),
    ("It tells you what's missing", "A completeness check flags exactly what a clean claim will need but the packet doesn't have — no signed physician order, a missing prescriber NPI, no face-to-face note, missing diagnosis codes, or a sleep study that doesn't qualify — so gaps surface at intake instead of at denial."),
    ("Verify coverage before you commit", "One click runs a live 270/271 eligibility check on the extracted payer and member ID and shows active/inactive status, deductible and out-of-pocket remaining, and any prior-auth requirement — a coverage preview before the patient is ever created."),
    ("Accept once — patient, insurance, and chart, all at once", "When it looks right, accept it: the system creates the new patient, saves the insurance coverages, splits the referral into named documents (sleep study, physician order, insurance card, chart notes…) filed straight to the chart, and generates a Referral Review summary. A duplicate-patient check warns you before you ever create a second record for someone already on file."),
    ("Send gaps back to the provider", "If the referral is short something, one action drafts a letter to the referring office listing precisely what's needed; review it on the Documents page and fax it. Find it at <b>Patients &amp; Clinical → Documents &amp; e-sign → Referral reviewer</b>."),
]
PAPERLESS_EFAX = [
    ("Fax anything, from right where you're working", "Prescriptions, CMNs, orders, renewal requests, appeal letters — send any of them out by fax straight from the document, with no fax machine and no separate eFax login. The platform renders the PDF and dispatches it over its fax carrier; a failed fax can be retried in a click, and routine outreach (like a batch of renewal requests) can go automatically."),
    ("Every signature document carries a barcode", "Any document you send out to be signed is stamped with a scannable barcode and a short tracking code, with plain-text filing instructions printed right on it. That barcode becomes the document's identity for the rest of its life."),
    ("It files itself when it comes back", "When the signed copy is faxed back, the system reads the barcode off the page, matches it to the document it came from, copies the signed PDF into that patient's chart, marks the item returned and signed, and releases any bill-hold that was waiting on the paperwork — no manual filing and no “whose page is this?” Anything it can't match still lands in a triage queue for a human. (Automatic filing is an opt-in toggle; staff can also run it on demand.)"),
]
PAPERLESS_SIGN = [
    ("One worklist for everything out for signature", "The Awaiting Signatures dashboard lists every packet and document you've sent a provider to sign, who it went to, and how long it has been outstanding — so nothing vanishes into a fax-machine black hole. Scan or type a returned document's barcode to file it instantly; mark items returned, hand-delivered, or canceled; and re-send the ones that have gone quiet."),
    ("Or skip the fax entirely — providers e-sign online", "Invite a referring provider (by NPI, verified against the national registry) into a secure, MFA-protected portal and stage their CMNs, orders, and packets for signature. They sign on their own device instead of printing and faxing back. Every signature is captured in a tamper-evident, hash-chained audit trail with a printable, ESIGN-compliant certificate you can hand a payer."),
]

SAVINGS_INTRO = (
    "Because CareMetric Breathe is one platform — inventory, billing, the "
    "customer database, clinical care, and documentation together — the "
    "handoffs that used to mean re-keying, portal-hopping, and phone tag "
    "disappear. The estimates below are illustrative for a typical "
    "single-location PAP operation (about 1,500 active resupply patients; a "
    "team of one owner, one biller, two CSRs, and one respiratory "
    "therapist). Tune them to your own volumes."
)
SAVINGS_FEATURE = [
    ("AI mask fitter", "In-person fitting appointments and trial-and-error exchanges", "15–30 min / new setup"),
    ("Reminder engine + voice agent", "Outbound reorder calls and voicemail loops", "6–10 min / resupply order"),
    ("Real-time eligibility", "Payer phone calls and portal checks", "10–15 min / verification"),
    ("AI scrubbing + ranked denials", "Hunting denial causes claim by claim", "~15 min / denial worked"),
    ("Therapy-cloud sync", "Pulling three vendor portals for compliance data", "~10 min / patient / month"),
    ("Unified inbox + patient 360", "Cross-referencing phone logs, email, fax, and billing", "30–60 min / rep / day"),
    ("Fax OCR + e-signature packets", "Manual filing, printing, and signature chasing", "5–10 min / document"),
    ("PacWare sync", "Re-keying patients and orders into the billing system", "3–5 min / record"),
]
SAVINGS_ROLE = [
    ("Administrator (Owner)", "Live dashboards and KPI alerts replace hand-built reports and spreadsheet checks", "~45 min / day"),
    ("Biller", "Eligibility runs itself; claims arrive scrubbed and denials arrive ranked", "~2.0 hrs / day"),
    ("Customer Service Rep (each of 2)", "Reorders confirm themselves by text, link, or the AI phone agent; one inbox replaces five tools", "~2.5 hrs / day"),
    ("Respiratory Therapist", "Compliance data lands nightly and worklists build themselves", "~1.5 hrs / day"),
]
SAVINGS_TOTALS = [
    ("~9.25", "staff-hours back per day"),
    ("~200", "hours back per month"),
    ("~$5,000", "per month (~$60K/yr) at $25/hr"),
]
SAVINGS_CLOSE = (
    "And that is labor alone. Consolidating onto one platform also retires "
    "the rest of the stack — the business-management system, the resupply "
    "add-on, the e-ordering tool, and the spreadsheets between them — along "
    "with the subscriptions and integration upkeep they carry."
)
SAVINGS_FOOTNOTE = (
    "Illustrative planning estimates, not a guarantee. Actual savings depend "
    "on patient volume, payer mix, and current workflows. Per-task figures "
    "reflect the manual workflows each feature replaces; the roll-up assumes "
    "the team mix above, 21.7 workdays per month, and a $25/hour fully "
    "loaded labor rate (9.25 hrs/day × 21.7 days ≈ 200 hrs; 200 hrs × $25 ≈ "
    "$5,000/month, ≈ $60,000/year)."
)

# Competitive matrix (appendix). ● native · ◐ partial / add-on / partner · ○ not core.
MATRIX_VENDORS = ["CMB", "Brightree", "Niko", "TIMS"]
MATRIX_INTRO = (
    "How CareMetric Breathe's (CMB) marquee features line up against the "
    "DME/HME platforms a resupply business is most likely to evaluate. A "
    "full circle = native, half = partial / add-on / via partner, open = "
    "not offered or not core."
)
MATRIX_FOOTNOTE = (
    "CareMetric Breathe entries reflect the shipped platform described in "
    "this manual. Competitor entries summarize publicly available product "
    "information and may be delivered via partners or paid add-ons; verify "
    "with each vendor before relying on this comparison."
)
COMPARE_MATRIX = [
    ("Patient experience", [
        ("AI camera-based mask fitting, in-browser, privacy-first", ["full", "none", "none", "none"]),
        ("Patient e-commerce storefront, subscriptions, cash-pay", ["full", "half", "half", "half"]),
        ("Automated resupply outreach, one-tap confirm (SMS/email)", ["full", "full", "half", "half"]),
        ("Conversational AI voice agent for reorders/check-ins", ["full", "half", "none", "none"]),
        ("Patient AI chatbot and sleep coach", ["full", "none", "none", "none"]),
    ]),
    ("Clinical & therapy", [
        ("Therapy-cloud sync (ResMed, Philips, React Health)", ["full", "full", "half", "half"]),
        ("CMS 90-day setup-adherence tracking", ["full", "full", "half", "half"]),
        ("Clinical intervention, coaching, mask-fit worklists", ["full", "half", "none", "none"]),
        ("Inbound fax OCR and document triage", ["full", "full", "half", "half"]),
    ]),
    ("Revenue cycle", [
        ("Clearinghouse claims (837P/835) + real-time eligibility", ["full", "full", "full", "full"]),
        ("AI claim scrubbing + denial recovery by win-probability", ["full", "half", "half", "none"]),
        ("Electronic prior authorization (Da Vinci PAS)", ["full", "half", "none", "none"]),
        ("DME A/R: capped rentals, secondary/COB, timely filing", ["full", "full", "full", "full"]),
        ("Patient statements, payment plans, payment links", ["full", "full", "full", "full"]),
    ]),
    ("Operations & intelligence", [
        ("Unified omnichannel inbox (SMS, MMS, email, chat)", ["full", "half", "half", "none"]),
        ("Provider e-signature and e-ordering collaboration", ["full", "half", "half", "none"]),
        ("Analytics: margin, LTV/CAC, payer profitability", ["full", "half", "half", "half"]),
        ("In-app AI staff assistant + no-code automation rules", ["full", "half", "half", "none"]),
    ]),
]


# ── The business case: revenue up, labor down ────────────────────────
BUSINESS_CASE_INTRO = (
    "CareMetric Breathe earns its keep two ways at once: it collects more "
    "of the revenue you've already earned, and it does it with less staff "
    "time. The same automation that confirms reorders and scrubs claims "
    "also removes the manual work behind them — so the practice grows "
    "without growing headcount."
)
REVENUE_LEVERS = [
    ("More reorders confirmed", "Automated reminders with one-tap confirm — and the AI voice agent for calls — lift the share of eligible patients who actually reorder on time, instead of supplies (and revenue) slipping."),
    ("More clean claims paid", "AI scrubbing plus the pre-bill eligibility gate raise your first-pass acceptance rate, so more of what you bill is actually paid and less is written off."),
    ("Denials recovered, not lost", "The AI denial analyzer fixes and resubmits denials ranked by recoverable dollars — recapturing money that would otherwise be abandoned."),
    ("Faster cash, lower DSO", "Auto-submit and ERA auto-posting compress the claim-to-cash cycle, so the same revenue arrives sooner and working capital improves."),
    ("Coverage you didn't know about", "Insurance Discovery finds active coverage from a patient's demographics — turning would-be self-pay or uncollected balances into billable claims."),
    ("Every billable cycle captured", "Capped-rental month tracking and automatic secondary / COB drafting make sure no rental month or leftover balance is missed."),
    ("More new patients", "The in-browser AI mask fitter and storefront convert visitors without an appointment, widening the top of the funnel."),
]
BILLER_TRANSFORM_INTRO = (
    "Nowhere is the impact bigger than the biller's seat. The platform "
    "moves the work upstream — verify, scrub, prevent — and automates the "
    "cleanup, so a single biller can carry far more claims, cleanly."
)
BILLER_TRANSFORM = [
    ("Insurance verified before you bill", "Coverage is confirmed by real-time 270/271 on a schedule and again in the seconds before a claim transmits. Inactive or prior-auth-required coverage is held back automatically — so claims don't bounce for eligibility and you stop billing into dead coverage."),
    ("Only clean claims go out", "Every claim is scrubbed — structurally and by AI — before submission: wrong modifier for the rental month, quantity over the LCD limit, HCPCS/diagnosis mismatch, fee-schedule drift. Problems are flagged or fixed first, so your first-pass acceptance rate climbs and rejections fall."),
    ("Denials research and fix themselves", "When a denial lands, the AI reads the CARC/RARC codes, researches the root cause, populates the corrective patch, and — when it's safe and high-confidence — resubmits in one click. The worklist is ranked by recoverable dollars, so the biggest recoveries happen first instead of claims aging into write-offs."),
    ("Paid faster, and audit-ready", "Clean claims plus automatic payment posting mean cash arrives sooner (a lower DSO). And because required paperwork is enforced by bill hold, signed on file via e-signature, and every claim and signature carries a tamper-evident audit trail, you go into any payer audit far less exposed."),
]
BUSINESS_CASE_CLOSE = (
    "The labor estimates below total roughly 200 staff-hours and about "
    "$5,000 a month for a typical single-location practice. The revenue "
    "side compounds on top: even a few points of improvement on first-pass "
    "rate, denial recovery, and reorder confirmation — on the same patient "
    "base — adds materially more collected revenue every month. Together "
    "that is the return: more dollars in, fewer hours spent, on one "
    "platform."
)


# ── The AI assistants (chat + copilot) ───────────────────────────────
ASSISTANTS_INTRO = (
    "Two AI assistants work alongside the business around the clock — one "
    "on the storefront answering patients, one inside the admin console "
    "guiding staff. Both are built in, both fall back gracefully (Claude "
    "first, then OpenAI, then a safe offline reply) if a vendor key is "
    "missing, and both are renamable per tenant — the Penn Home Medical "
    "Supply tenant calls them PennBot and PennPilot."
)
ASSISTANT_CUSTOMER = [
    ("Answers patients 24/7", "A chat assistant on the storefront answers questions about CPAP therapy, masks, resupply, insurance, and your company — instantly, day or night, with no hold queue and no callback. It is the front line for the routine questions that used to ring the phone."),
    ("Knows the patient's account", "For a signed-in patient it is account-aware: it can pull recent orders, order status and tracking, active subscriptions, and device details, and help with returns, refunds, and account changes. So “where's my order?” and “when's my next refill?” answer themselves."),
    ("Knows when to hand off", "Anything it can't resolve — order-specific, clinical, or an action that needs a person — it escalates to a CSR by opening a message thread, with the context attached. It never accepts sensitive data (SSN, card, member ID), it is not a clinician, and it gives no medical advice."),
    ("A sleep coach, too", "In sleep-coach mode it offers supportive, plain-language coaching and troubleshooting for patients adjusting to therapy — the kind of reassurance that keeps new patients adherent."),
    ("The same brain by email", "The optional email auto-reply uses the same knowledge base to answer inbound patient emails automatically — but only when it is highly confident. Anything below the confidence bar (or order/clinical-specific) falls through to a human, exactly like a hand-off in chat."),
]
ASSISTANT_STAFF = [
    ("Every employee's guide to the console", "CareMetric Copilot floats on every admin page. Ask it “how does this work?” or “where's the page that does X?” and it answers from a complete map of the console and returns one-click links straight to the right screen. New hires get productive without interrupting a supervisor, and veterans find the rarely-used corner fast."),
    ("Walks staff through the work", "Beyond finding pages, it explains workflows in plain language — “walk me through processing a claim,” “how do I turn a feature on?” — so the answer to a how-do-I question is a chat away instead of a training ticket."),
    ("Turns ideas into action — safely", "Its one action, after the employee confirms, emails a structured feature suggestion to the owners. It takes no other actions: it never changes data, never sends anything silently, and never echoes patient PHI. It's an on/off toggle in the Control Center."),
]
CALL_DEFLECTION = (
    "Every routine question a patient resolves in chat is a phone call your "
    "team never has to staff. An inbound call ties up a CSR for several "
    "minutes of handle time plus the queue around it; a chat the assistant "
    "answers costs essentially nothing and happens 24/7 — including the "
    "nights and weekends when no one is at the desk. Across a busy resupply "
    "line that is hours of phone time removed every week, shorter holds for "
    "the calls that do need a person, and patients who get an instant "
    "answer instead of waiting for a callback. The Copilot side compounds "
    "it: less time lost to “how do I…?” and faster onboarding for every new "
    "hire."
)
CALL_DEFLECTION_MATH = (
    "Illustrative: at a $25/hour blended rate, a 6-minute call is about "
    "$2.50 of labor. Deflecting even 20–30 routine questions a day to chat "
    "is roughly $50–75/day — about $1,000–1,500 a month — before counting "
    "the after-hours coverage you'd otherwise have to pay for. Directional "
    "planning figures, not a guarantee; tune to your call volume and rate."
)


# ── Owner's playbook: managing the software ──────────────────────────
OWNER_PLAYBOOK_INTRO = (
    "Running the practice from CareMetric Breathe is mostly a matter of "
    "knowing where to look and how often. Everything below is on one "
    "platform, so you monitor the whole business — front desk to clinic to "
    "revenue cycle — without logging into anything else. Set your targets "
    "once, let the alerts find the exceptions, and work from the queues."
)
OWNER_WATCH = [
    ("Every day (5 minutes)", [
        "<b>Home dashboard</b> — conversations awaiting reply, overdue follow-ups, returns to action, fulfillments this week.",
        "<b>Operations</b> — the background worker and nightly sync ran clean; nothing stuck.",
        "<b>Delivery Failures / Outbound Messages</b> — clear any bounced texts/emails or shipping exceptions.",
        "<b>KPI Alerts</b> — anything that crossed a threshold overnight (revenue dip, denial spike, churn).",
        "<b>Live Staffing</b> — open-conversation load per agent so nobody is buried.",
    ]),
    ("Every week (20 minutes)", [
        "<b>Billing Hub + Denials &amp; DSO</b> — money in flight, denial rate, and days-to-pay trend per payer.",
        "<b>A/R Aging + Filing Deadlines</b> — work the oldest buckets and anything near timely-filing.",
        "<b>Therapy Fleet + Setup Adherence</b> — who is at risk of failing their CMS 90-day window.",
        "<b>Team Throughput</b> — per-agent close/approve/resolve counts.",
        "<b>Reorder Reminders funnel</b> — due → reminded → confirmed → shipped conversion.",
    ]),
    ("Every month (45 minutes)", [
        "<b>Financial analytics</b> — Margin &amp; COGS, Payer Profitability, Revenue by Source, LTV:CAC, Inventory Turnover.",
        "<b>Reports</b> — export the revenue summary, patient payments, and insurance-claims reports (CSV / PDF / QuickBooks) for the books.",
        "<b>Goals &amp; Targets</b> — review pace-to-goal and reset targets for the next period.",
        "<b>Customer NPS</b> — post-delivery satisfaction and the comment tail.",
        "<b>Package &amp; Usage</b> — your plan, add-ons, and usage for the month.",
    ]),
]
MONITOR_AREAS = [
    ("Patients & service", "Home, Conversations, Cases, Follow-ups, Live Staffing — every patient touch in one inbox with assignment and SLA visibility."),
    ("Revenue cycle", "Billing Hub, Denials & DSO, A/R Aging, Collections Forecast, Payer Profitability — the whole money picture, claim to cash."),
    ("Clinical & therapy", "RT Overview, Therapy Fleet, Setup Adherence — adherence and clinical risk across every device cloud."),
    ("Storefront & growth", "Storefront Analytics, Acquisition Funnel, Reorder Reminders, Fitter Prospects — where patients come from and convert."),
    ("Operations & delivery", "Operations, Integrations, Outbound Messages, Delivery Failures, Webhook Deliveries — the plumbing, at a glance."),
    ("Goals & exceptions", "Goals & Targets and KPI Alerts — set the number you want; the platform flags the moment you drift from it."),
]
REPORTS_CATALOG = [
    ("Revenue summary", "Per-day revenue, refunds, and net rollup."),
    ("Orders", "Storefront checkout sessions in the date range."),
    ("Patient payments", "Patient-responsibility cash collected (card + mail-in checks), kept separate from insurance to avoid double-counting."),
    ("Insurance claims", "Billing-side claims and payer receipts."),
    ("Refunds journal", "A chronological refund ledger."),
    ("Returns", "Comfort-guarantee returns and RMAs."),
    ("Customer activity", "Aggregated storefront activity per day — signups, returning orders, active count (count-only, no PHI)."),
    ("All-financial", "One-click bundle: orders + refunds + payer receipts + patient payments, unioned chronologically."),
]
REPORTS_NOTE = (
    "Every report exports as CSV, printable PDF, or QuickBooks (Desktop "
    ".iif and Online .qbo.csv). Date range defaults to the last 30 days "
    "(up to 90). PHI is minimized — storefront reports hash customer IDs "
    "and the customer-activity report is counts only."
)
BENCHMARKS_INTRO = (
    "CareMetric Breathe tracks the metrics a DME operation is judged on and "
    "lets you set a target for each, so you always know how you stack up. "
    "The “typical target” column lists commonly-cited industry rules of "
    "thumb — directional, not a guarantee — and the right column is how the "
    "platform helps you beat them."
)
BENCHMARKS = [
    ("Clean-claim / first-pass rate", "≥ 95%", "AI scrubbing + the pre-submit eligibility gate stop avoidable rejections before the 837P leaves."),
    ("Denial rate", "< 5–10%", "Denials & DSO benchmarking by payer plus the AI denial analyzer surface and fix the root cause fast."),
    ("Days sales outstanding (DSO)", "< 30–40 days", "Auto-submit, ERA auto-posting, and the recoverable-dollars denials worklist shorten claim-to-cash."),
    ("Resupply reorder rate", "~30–40% of eligible", "Automated reminders with one-tap confirm + the AI voice agent lift confirmations without staff dialing."),
    ("CMS 90-day adherence (new setups)", "≥ 70% of nights ≥ 4 hrs", "Setup Adherence tracks every new patient's rolling 30-day window and flags at-risk early for coaching."),
    ("Patient satisfaction (NPS)", "Higher is better", "Post-delivery NPS, fast omnichannel response, and the self-service portal keep scores up."),
]
BENCHMARKS_FOOTNOTE = (
    "Target ranges are widely-cited DME/RCM rules of thumb for orientation "
    "only; they are not commitments and vary by payer mix and specialty. "
    "What the platform guarantees is the visibility and automation to "
    "measure and improve each one."
)

# Included e-sign document templates (what ships).
DOC_TEMPLATES = [
    ("Standard Written Order (SWO)", "The PAP device & supplies order with Medicare's 42 CFR 410.38 required elements."),
    ("PAP CMN", "Certificate of Medical Necessity templated to the NCD 240.4 / LCD coverage criteria."),
    ("Structured CMN forms", "CMS-484 (oxygen), CMS-846 (pneumatic compression), CMS-848 (TENS) for payers that still require them."),
    ("DWO / renewal", "Device-With-Options and CMN renewal forms by HCPCS family (PAP, RAD, oxygen, and more)."),
    ("ABN (CMS-R-131)", "Advance Beneficiary Notice with Options 1–3 for expected non-coverage."),
    ("Assignment of Benefits", "AOB + financial-responsibility agreement."),
    ("DMEPOS Supplier Standards", "The abbreviated 42 CFR 424.57(c) standards notice."),
    ("Proof of Delivery", "Medicare direct-delivery POD elements."),
    ("Refill Confirmation", "The current CMS refill-documentation standard."),
    ("New-patient setup packet", "A bundle that sends the ABN + Supplier Standards + AOB together as one e-sign packet."),
]


# ── Pre-loaded payers (ready to bill day one) ────────────────────────
PAYERS_INTRO = (
    "You don't start with an empty payer table. CareMetric Breathe ships with "
    "<b>100+ fully-configured payer profiles</b> — the complete Pennsylvania "
    "DME market plus the national carriers, Medicare, Medicaid, federal, and "
    "workers'-comp / auto programs a PAP business actually bills. Each one "
    "arrives with the electronic IDs, claim format, timely-filing window, "
    "prior-auth rules, and claims address already filled in, so you can submit "
    "clean claims on day one instead of researching payer setup for weeks. "
    "Billing for a different state? Adding a payer takes a minute on the "
    "billing config page — the pre-loaded set is a head start, not a fence."
)
PAYERS_CATEGORIES = [
    ("Pennsylvania Blues & major commercial", "Highmark BCBS (Western & Central PA), Independence Blue Cross, Capital BlueCross, UPMC Health Plan, Geisinger Health Plan."),
    ("National commercial & employer TPAs", "Aetna, Cigna, UnitedHealthcare, Humana, AmeriHealth, Ambetter, Oscar, Surest — plus self-funded administrators (Meritain, UMR, Allied, HealthSmart, Luminare, WebTPA, Imagine360, Nova, MagnaCare, EBMS, Independence Administrators)."),
    ("Medicare (Part B, DME MAC, Railroad)", "Novitas Solutions (PA Part B), Noridian (DME MAC Jurisdiction A), and Palmetto GBA Railroad Medicare."),
    ("Medicare Advantage & D-SNP", "Highmark Freedom Blue, UPMC for Life, Geisinger Gold, Aetna Medicare, Capital Senior Blue, Keystone 65, Personal Choice 65, Cigna, Wellcare, Devoted, Clover, Humana Gold Plus, UnitedHealthcare Dual Complete, and more."),
    ("Medicare Supplement (Medigap)", "AARP/UnitedHealthcare, Mutual of Omaha, Cigna, and Aetna Medigap plans."),
    ("Medicaid, HealthChoices MCOs, CHIP & CHC", "PA Medical Assistance (FFS), Keystone First, UPMC for You, AmeriHealth Caritas PA, Highmark Wholecare, Geisinger Family, PA Health & Wellness, UHC Community Plan, Health Partners Plans; CHIP and Community HealthChoices (LTSS) plans."),
    ("Federal programs", "BCBS Federal Employee Program, GEHA, MHBP, NALC, APWU, Compass Rose, SAMBA (FEHB); TRICARE East, TRICARE For Life, VA Community Care Network, CHAMPVA, and Federal Black Lung."),
    ("Workers' comp & auto no-fault", "SWIF, PMA, Erie, Liberty Mutual, Travelers, The Hartford, plus WC TPAs (Sedgwick, Gallagher Bassett, Broadspire, ESIS) and auto MedPay/PIP (Progressive, Allstate, Nationwide, GEICO, USAA, State Farm). Routed to the right specialty channel, not the standard clearinghouse."),
    ("Rental PPO networks (router rows)", "Anthem/Elevance BlueCard, First Health, and MultiPlan/PHCS — so you bill the plan on the member's card, not the network."),
]
PAYERS_PROFILE_FIELDS = [
    ("Identity", "CSR-friendly display name, the legal name as it appears on EDI enrollment, the parent organization, and a stable internal code."),
    ("Electronic IDs & format", "Office Ally payer ID, 5010 payer ID, and ERA payer ID; the claim format (837P, 837I, or paper CMS-1500); and EDI/ERA enrollment status."),
    ("Submission rules", "Timely-filing window, any required claim modifiers (e.g. Medicare's KX), whether electronic secondary/COB is accepted, whether a referring-provider NPI is required, and a member-ID format hint/pattern."),
    ("Prior authorization", "Whether capped-rental DME needs prior auth, the submission method (portal, fax, phone, electronic 278, or paper), the PA phone/fax, and the expected turnaround."),
    ("Claims routing", "Claims mailing address (and a separate appeals address when different), claims phone/fax, the provider-portal URL, and the fee-schedule source."),
    ("Bookkeeping", "Free-form payer-level notes (PHI-free), an active/inactive flag, and a last-verified date and author so the team can spot stale entries at a glance."),
]
PAYERS_NOTE = (
    "Payer profiles are platform-wide and operator-maintained, so every tenant "
    "inherits the same vetted catalog. Manage them under <b>Billing → Config → "
    "Payers</b>: filter by region or line of business, add or edit a payer in "
    "a drawer (no deploy needed), and export the catalog in Office Ally's "
    "enrollment-review format for quarterly payer-ID updates."
)


# ── FAQ (by domain) ──────────────────────────────────────────────────
FAQ = [
    ("Getting started & signing up", [
        ("How does a new practice sign up?", "Go to the public CareMetric Breathe site (/breathe) and choose Create your account. Enter your company name, work email, a 12-character password, and a plan; that provisions your workspace and your first Owner login. Verify the emailed link, then sign in at /admin/sign-in and finish setup."),
        ("Do my staff each sign up too?", "No — only the practice's first Owner self-signs-up. Everyone else is invited from the Team page and sets their own password from the invite link. Public self-signup is for shoppers (storefront accounts) and new tenants, not staff."),
        ("Why didn't I get an error when I mistyped my email?", "For security the sign-up and sign-in pages never reveal whether an address is on file — they always say “check your email.” If nothing arrives, re-check the address and try again. (Inline checks still catch an obviously malformed email or a password that's too short before you submit.)"),
        ("Can I start texting patients before I have my own phone number?", "Yes — until you provision your own number, texts and calls go out on a shared platform number and a patient's reply routes back to you automatically. Provision your own dedicated number under Phone & SMS when you want messages to come from your own line."),
        ("I don't have a logo yet — what shows on my storefront?", "Generate a one-click starter monogram from your storefront name under Storefront Branding; it's created in your browser so nothing shows blank while you source real artwork. A brand-new, unconfigured tenant otherwise shows neutral CareMetric branding, never another tenant's brand."),
        ("What's the fastest way to turn on the right features for my plan?", "The Control Center has a one-click “Apply recommended preset” that sets your feature flags to the bundle for your billing plan. New tenants already start on it; re-apply it after changing plans, then fine-tune any individual flag."),
    ]),
    ("Customer care", [
        ("Where do patient messages go?", "SMS, MMS, and email — plus AI call summaries — all land in one unified Conversations inbox. CSRs triage, claim a thread, reply (with canned replies), tag, snooze, and escalate to a Case, so nothing is scattered across separate tools."),
        ("What can the chatbot handle without a person?", "The CareMetric Assistant answers therapy, mask, resupply, and insurance questions 24/7, and for signed-in patients it covers order status, tracking, subscriptions, device info, and returns — handing off to a CSR for anything order-specific, clinical, or actionable."),
        ("How do we make sure a promise to a patient isn't forgotten?", "Use Episodes for dated service promises and Follow-ups for the callback queue; overdue items surface on the Home dashboard."),
        ("Can we run telehealth visits?", "Yes — Video Visits generate a secure join link sent by SMS or email for setups and mask troubleshooting."),
        ("How do we message many patients at once?", "Bulk Campaigns — build an audience with filters, sanity-check the recipient count, and send a batch SMS or email. The Alert Library handles curated one-off alerts."),
        ("How does a patient use the AI mask fitter?", "The fitter is invitation-only. Staff send the patient a signed link by text or email from Orders & Shop → Fitter Invites; the patient opens it, runs the camera-based fitting in their browser, and the completed result attaches back to their chart (or waits in a holding area for staff to attach). The public storefront's “get fitted” button routes to an invitation-required explainer rather than the fitter."),
        ("Can patients buy a membership themselves?", "Yes — when membership pricing is configured, patients can join a cash-pay tier (Monthly Unlimited or Quarterly Unlimited) right from their account page; it's a Stripe subscription, and their membership tier is set automatically once the subscription is active. Staff can still set or adjust a tier from the customer record. If no membership pricing is set up, the option simply doesn't appear."),
        ("Do post-purchase review requests go out automatically?", "They can. The review request can always be sent on demand from the Reviews worklist (“Send due”), and once the automatic sweep is enabled it goes out on its own about two weeks after delivery — one request per order, only to customers who haven't opted out."),
        ("Can a returned item go back into inventory?", "Optionally. When you mark a return received you can choose to restock it, which adds the quantities back to tracked stock. It's off by default because most DME consumables (opened masks and supplies) aren't resaleable — so you opt in only for genuinely resaleable items."),
    ]),
    ("Billing & revenue cycle", [
        ("Is insurance checked before we bill?", "Yes. Eligibility runs by real-time 270/271 on a schedule and again in the seconds before a claim transmits; inactive or prior-auth-required coverage is held back so claims don't bounce."),
        ("How are only clean claims submitted?", "Every claim is scrubbed — structurally and by AI — before submission (modifiers for the rental month, quantity vs. LCD limits, HCPCS/diagnosis match, fee-schedule drift). Problems are flagged or fixed first, lifting your first-pass acceptance rate."),
        ("What happens when a claim is denied?", "The AI denial analyzer reads the CARC/RARC codes, finds the root cause, populates the corrective patch, and — when it's safe and high-confidence — resubmits in one click. The worklist is ranked by recoverable dollars."),
        ("How do payer payments get posted?", "Upload the 835 ERA file and the system auto-posts allowed, paid, and patient-responsibility amounts at the claim and line level, flags denials for follow-up, and is idempotent if a file is re-posted."),
        ("Does it handle capped rentals and secondary claims?", "Yes — capped-rental cycles auto-advance each month with the correct KH/KI/KX modifier rotation, and a secondary / COB claim auto-drafts after the primary pays (you review before submitting)."),
        ("What if a patient's insurance is unknown?", "Insurance Discovery searches the payer network from the patient's demographics to find active coverage (a paid clearinghouse add-on)."),
        ("Can we bill on day one?", "Yes — the platform ships with 100+ fully-configured payer profiles (the whole Pennsylvania DME market plus the national carriers, Medicare, Medicaid, federal, and workers'-comp/auto programs), each with electronic IDs, claim format, timely-filing window, prior-auth rules, and claims address pre-filled. Adding a payer for another region takes a minute under Billing → Config → Payers."),
    ]),
    ("Reporting & analytics", [
        ("What reports can I run?", "Revenue summary, orders, patient payments, insurance claims, refunds journal, returns, customer activity, and an all-financial bundle — over any date range up to 90 days."),
        ("Can I export to QuickBooks?", "Yes — CSV and printable PDF, plus QuickBooks Desktop (.iif) and QuickBooks Online (.qbo.csv)."),
        ("How do I know if I'm hitting my numbers?", "Set a target per KPI in Goals & Targets and let KPI Alerts flag any metric that crosses a threshold. Financial analytics (margin & COGS, payer profitability, LTV:CAC) show where money is made and lost."),
        ("Is patient PHI in the reports?", "PHI is minimized — storefront reports hash customer IDs and the customer-activity report is counts only."),
    ]),
    ("Integrations (device clouds)", [
        ("Which manufacturer clouds connect?", "ResMed AirView, Philips Respironics Care Orchestrator, and 3B Medical React Health (Luna / iCode)."),
        ("Do I have to log into each vendor portal?", "No — a nightly sync pulls all three into one view, so you manage every patient from a single login regardless of device brand."),
        ("What data comes back?", "Device settings, a compliance summary (days ≥ 4 hours, average usage and AHI, the CMS 90/30 flag), recent nights (usage, AHI, leak, pressure), and supply eligibility dates that drive resupply timing."),
        ("How current is the data?", "A nightly job refreshes every active link (rate-limited so it's gentle on the vendor APIs); you can also force a manual refresh per patient or per source."),
    ]),
    ("Re-supply", [
        ("How and when do reorder reminders go out?", "An hourly job finds prescriptions due on their cadence — typically the 90- and 30-day windows, tuned per patient and by frequency rules — and sends SMS or email. The AI voice agent can call, too."),
        ("How does the patient confirm a reorder?", "One tap. Email carries signed confirm / edit / stop links (no login needed) and SMS accepts a reply. A confirmed reorder flows straight to fulfillment and billing."),
        ("Does it avoid pestering patients?", "Yes — a quiet-period guard skips anyone you've talked to in the last 48 hours, and only one reminder goes out per patient per cycle even if several items are due."),
        ("Can patients set it and forget it?", "Yes — they subscribe once and auto-ship keeps supplies arriving on the cadence their insurance allows."),
    ]),
    ("In-person / counter orders", [
        ("How do I ring up a walk-in?", "Front Desk — look up or create the customer, add products, choose cash or bill-to-insurance, and complete the sale without going through the public storefront checkout."),
        ("Can I print a receipt and a shipping label?", "Yes — print a receipt and, if you're shipping it, a label with the patient's address merged in and tracking auto-filled back onto the order."),
        ("Who is allowed to take counter orders?", "Anyone with the orders.create permission — front-line CSRs and up."),
    ]),
    ("Respiratory therapy (RT)", [
        ("How do I find at-risk patients?", "RT Overview and Therapy Fleet rank patients by reason — setup-adherence risk, no recent data, high AHI, high leak, usage decline — so you work the highest risk first."),
        ("How is CMS 90-day compliance tracked?", "Setup Adherence measures each new PAP patient against ≥ 4 hours on ≥ 21 nights in any rolling 30-day window and flags at-risk patients early so you can coach them before the window closes."),
        ("Where do I document care?", "Clinical Encounters — capture reason, assessment, intervention, and plan (or a free-text note); it builds the patient's clinical timeline and backs the medical necessity behind claims."),
        ("Can I reach a whole at-risk group at once?", "Yes — launch consent- and do-not-disturb-aware Clinical Outreach to a Therapy Fleet cohort."),
        ("Can I give a referring provider a report?", "Generate a print-quality Therapy Report by provider, patient, or device manufacturer."),
    ]),
    ("Documents, e-signature & provider portal", [
        ("Can the system read a referral for us?", "Yes — the Referral Reviewer reads an uploaded or faxed referral in one AI pass and extracts the patient's demographics, insurance, ordered items (with HCPCS), sleep study, referring provider, and diagnoses. It flags anything a clean claim is missing, lets you verify insurance in one click, and — once you accept — creates the patient, attaches the coverage, and files the split documents to the chart."),
        ("Can we fax straight from the system?", "Yes — send prescriptions, CMNs, orders, renewal requests, and appeal letters by eFax right from the document. No fax machine, no separate eFax login, and a failed fax retries in a click."),
        ("How does a faxed-back signature get filed?", "Every document you send for signature carries a barcode. When the signed page is faxed back, the system reads that barcode, files the document to the right patient's chart, marks it returned and signed, and releases any bill-hold waiting on it — automatically. Anything it can't match goes to a triage queue for a person."),
        ("How do we keep track of signatures we're waiting on?", "The Awaiting Signatures dashboard lists everything out for a provider's signature, who has it, and how long it's been outstanding — re-send the stale ones, mark items hand-delivered, or scan a returned barcode to file it instantly."),
        ("Do patients have to print and mail forms?", "No — they e-sign on their own device (typed name + explicit ESIGN consent) and the signed PDF auto-files to the chart. It's ESIGN-Act compliant — nothing printed, nothing lost, no delay."),
        ("Which document templates are included?", "SWO, PAP CMN, CMS-484/846/848, DWO / renewal forms, ABN (CMS-R-131), Assignment of Benefits, DMEPOS Supplier Standards, Proof of Delivery, Refill Confirmation, and a new-patient setup packet — plus free-form manual documents and documentation packets."),
        ("Can providers sign instead of faxing?", "Yes — the provider portal lets a referring provider e-sign CMNs, DWOs, prescriptions, and claims on their device, captured in a tamper-evident audit trail. No more fax-and-chase."),
        ("Can providers see their patients' therapy?", "Yes — read-only therapy data and reports for their own patients, in the same MFA-protected portal."),
    ]),
    ("Roles, access & setup", [
        ("What staff roles are there?", "Owner, Admin, Customer Service Rep, Biller, and Respiratory Therapist — assigned on the Team page. A page above your role simply doesn't appear in your navigation."),
        ("How do I turn a feature on or off?", "The Control Center has an immediate on/off toggle for every major feature (voice agent, campaigns, auto-submit, AI billing, the chatbots, multi-location, and more)."),
        ("How do I add a teammate?", "Invite them by email on the Team page and pick a role; they set their own password from the link, and admins enroll multi-factor authentication."),
        ("What has to be set up before go-live?", "Brand and domain, phone/SMS/fax numbers, an authenticated email sender, payments, and — for billing — clearinghouse credentials and payer/fee-schedule config. The Setup Guide walks through it."),
        ("Can the team get alerts in Slack?", "Yes — add a Slack bot token + channel under System Configuration and the platform posts real-time CS alerts and operator digests into your channel, with an Escalate button and a slash command to act on them. Messages are non-PHI (a reference, a status, and a deep link back into the console). Link each teammate's Slack handle on the Team page."),
        ("Can I see who looked at a patient's record?", "Yes — the admins-only Audit Trail report (Analytics & Reports → Audit Trail) shows who accessed which patient's information and when, filterable by employee, patient, and time frame."),
    ]),
    ("The AI assistants", [
        ("What's the difference between the Assistant and the Copilot?", "CareMetric Assistant is the customer-facing storefront chatbot; CareMetric Copilot is the staff-facing helper inside the admin console. (The Penn tenant calls them PennBot and PennPilot.)"),
        ("Will the Copilot change my data?", "No — it explains the app and, only after you confirm, forwards a feature idea to the owners. It never changes data and never shows patient PHI."),
        ("What happens if the AI vendor is down?", "Both assistants degrade gracefully — Claude first, then OpenAI, then a safe offline reply — so the app never breaks because a key is missing."),
    ]),
]


# =====================================================================
# DOC TEMPLATE (page-numbered TOC + running header/footer)
# =====================================================================


def _heading_level(flowable):
    """Return the TOC level for a heading flowable, or None."""
    if isinstance(flowable, Paragraph):
        name = flowable.style.name
        if name == "H1Section":
            return 0, flowable.getPlainText()
        if name == "H2Sub":
            return 1, flowable.getPlainText()
    elif isinstance(flowable, RoleBanner):
        return 1, flowable.title
    return None


# A deterministic two-pass build sidesteps reportlab's multiBuild TOC
# convergence (which silently mis-resolved adjacent headings here):
#   * Pass 1 (CaptureDoc): record every heading's (level, text, page).
#   * Pass 2 (ManualDoc): render the TOC (as TocLine flowables) from the
#     captured entries, plus PDF outline bookmarks.
# Both passes reserve the SAME one-page TOC region (heading + PageBreak),
# so the body lands on identical pages in both passes and the captured
# page numbers match the final layout exactly.
class CaptureDoc(BaseDocTemplate):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.captured = []

    def afterFlowable(self, flowable):
        hit = _heading_level(flowable)
        if hit is not None:
            level, text = hit
            self.captured.append((level, text, self.page))


class ManualDoc(BaseDocTemplate):
    def beforeDocument(self):
        self._toc_seq = 0

    def afterFlowable(self, flowable):
        hit = _heading_level(flowable)
        if hit is None:
            return
        level, text = hit
        self._toc_seq = getattr(self, "_toc_seq", 0) + 1
        key = "toc-%d" % self._toc_seq
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level=level, closed=(level > 0))


def _header_footer(canvas, doc):
    canvas.saveState()
    section = getattr(canvas, "_cmb_section", "")
    # header
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(NAVY)
    canvas.drawString(MARGIN_X, PAGE_H - 0.62 * inch, "CAREMETRIC BREATHE")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(STEEL)
    canvas.drawString(MARGIN_X + 1.5 * inch, PAGE_H - 0.62 * inch,
                      "User Manual")
    if section:
        canvas.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 0.62 * inch,
                               section)
    canvas.setStrokeColor(PLATINUM)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN_X, PAGE_H - 0.72 * inch, PAGE_W - MARGIN_X,
                PAGE_H - 0.72 * inch)
    # footer
    canvas.setStrokeColor(PLATINUM)
    canvas.line(MARGIN_X, MARGIN_BOTTOM - 0.16 * inch, PAGE_W - MARGIN_X,
                MARGIN_BOTTOM - 0.16 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(STEEL)
    canvas.drawString(MARGIN_X, MARGIN_BOTTOM - 0.32 * inch,
                      "CareMetric Breathe — %s" % TODAY)
    canvas.drawRightString(PAGE_W - MARGIN_X, MARGIN_BOTTOM - 0.32 * inch,
                           "Page %d" % doc.page)
    canvas.restoreState()


def _tracked(c, cx, y, text, font, size, tracking, color):
    """Draw a horizontally-centered, letter-spaced string (the canvas has no
    setCharSpace in this reportlab build, so use a text object)."""
    w = c.stringWidth(text, font, size) + tracking * max(len(text) - 1, 0)
    t = c.beginText(cx - w / 2.0, y)
    t.setFont(font, size)
    t.setCharSpace(tracking)
    t.setFillColor(color)
    t.textOut(text)
    # Character spacing (Tc) is graphics state and persists past the text
    # object — reset it so later drawString()/drawCentredString() calls
    # don't inherit the tracking and mis-centre.
    t.setCharSpace(0)
    c.drawText(t)


def _cover(canvas, doc):
    """Sophisticated, high-tech title page: deep-navy gradient field, a soft
    glow lifting the CareMetric emblem, fine circuit-trace accents, and a
    gold-framed, centered brand lockup."""
    c = canvas
    c.saveState()
    W, H = PAGE_W, PAGE_H
    cx = W / 2.0

    # 1 — Vertical gradient field (lighter navy high, deep navy low).
    bands = 140
    for i in range(bands):
        t = i / (bands - 1)                 # 0 = bottom, 1 = top
        c.setFillColor(lerp(NAVY_DEEP, NAVY, t))
        c.rect(0, H * i / bands, W, H / bands + 1.0, stroke=0, fill=1)
    # Deepen the very bottom so the footer band reads.
    for i in range(40):
        t = i / 39.0
        c.setFillColor(NAVY_DEEP)
        c.setFillAlpha(0.04 * (1 - t))
        c.rect(0, 1.8 * inch * t, W, 0.05 * inch, stroke=0, fill=1)
    c.setFillAlpha(1)

    # 2 — Fine circuit-trace accents (echo the emblem) — top-right + lower-left.
    def trace(pts, node_at_end=True):
        c.setStrokeColor(GOLD_SOFT)
        c.setStrokeAlpha(0.16)
        c.setLineWidth(0.7)
        c.lines([(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1])
                 for k in range(len(pts) - 1)])
        c.setStrokeAlpha(1)
        if node_at_end:
            ex, ey = pts[-1]
            c.setFillColor(GOLD)
            c.setFillAlpha(0.30)
            c.rect(ex - 1.6, ey - 1.6, 3.2, 3.2, stroke=0, fill=1)
            c.setFillAlpha(1)
    trace([(W - 0.55 * inch, H - 1.7 * inch), (W - 1.9 * inch, H - 1.7 * inch),
           (W - 1.9 * inch, H - 2.5 * inch), (W - 2.7 * inch, H - 2.5 * inch)])
    trace([(W - 0.55 * inch, H - 2.15 * inch), (W - 1.35 * inch, H - 2.15 * inch),
           (W - 1.35 * inch, H - 2.95 * inch)])
    trace([(0.55 * inch, 2.5 * inch), (1.7 * inch, 2.5 * inch),
           (1.7 * inch, 1.85 * inch), (2.6 * inch, 1.85 * inch)])
    trace([(0.55 * inch, 2.05 * inch), (1.15 * inch, 2.05 * inch),
           (1.15 * inch, 1.5 * inch)])

    # 3 — Inset hairline frame (premium framing).
    inset = 0.42 * inch
    c.setStrokeColor(GOLD)
    c.setStrokeAlpha(0.40)
    c.setLineWidth(1.0)
    c.rect(inset, inset, W - 2 * inset, H - 2 * inset, stroke=1, fill=0)
    c.setStrokeAlpha(0.16)
    c.setLineWidth(0.6)
    c.rect(inset + 4, inset + 4, W - 2 * inset - 8, H - 2 * inset - 8,
           stroke=1, fill=0)
    c.setStrokeAlpha(1)

    # 4 — Soft white glow to lift the emblem off the navy field.
    gy = H - 2.55 * inch
    for r, a in [(1.55, 0.05), (1.15, 0.06), (0.85, 0.08), (0.6, 0.10)]:
        c.setFillColor(white)
        c.setFillAlpha(a)
        c.circle(cx, gy, r * inch, stroke=0, fill=1)
    c.setFillAlpha(1)

    # 5 — Emblem (the CareMetric logo mark), centered in the upper third.
    if os.path.exists(EMBLEM):
        ew = 1.55 * inch
        eh = ew * 353.0 / 359.0
        c.drawImage(EMBLEM, cx - ew / 2.0, gy - eh / 2.0, ew, eh,
                    mask="auto")
    else:                                   # graceful fallback: gold "CB" tile
        c.setFillColor(GOLD)
        c.roundRect(cx - 0.5 * inch, gy - 0.5 * inch, 1.0 * inch, 1.0 * inch,
                    10, stroke=0, fill=1)
        c.setFillColor(NAVY_DEEP)
        c.setFont("Helvetica-Bold", 30)
        c.drawCentredString(cx, gy - 0.18 * inch, "CB")

    # 6 — Wordmark + kicker.
    _tracked(c, cx, H - 3.62 * inch, "CAREMETRIC BREATHE",
             "Helvetica-Bold", 17, 3.2, white)
    _tracked(c, cx, H - 3.92 * inch, "INTELLIGENT DME & PAP CARE PLATFORM",
             "Helvetica", 8.2, 2.6, GOLD_SOFT)

    # 7 — Title + centered gold rule.
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 41)
    c.drawCentredString(cx, H - 5.25 * inch, "User Manual")
    rule_w = 1.7 * inch
    c.setFillColor(GOLD)
    c.rect(cx - rule_w / 2.0, H - 5.58 * inch, rule_w, 0.055 * inch,
           stroke=0, fill=1)

    # 8 — Subtitle + role line.
    c.setFillColor(lerp(white, NAVY, 0.10))
    c.setFont("Helvetica", 13)
    c.drawCentredString(cx, H - 6.02 * inch,
                        "The complete guide to running your PAP department")
    c.setFillColor(GOLD_SOFT)
    c.setFont("Helvetica-Oblique", 10.5)
    c.drawCentredString(cx, H - 6.36 * inch,
                        "Organised by role:  Administrator · Biller · "
                        "CSR · Respiratory Therapist")

    # 9 — Capability chips (a quiet signal of breadth) over a hairline.
    chip_y = 2.25 * inch
    c.setStrokeColor(GOLD)
    c.setStrokeAlpha(0.25)
    c.setLineWidth(0.6)
    c.line(cx - 2.6 * inch, chip_y + 0.34 * inch, cx + 2.6 * inch,
           chip_y + 0.34 * inch)
    c.setStrokeAlpha(1)
    _tracked(c, cx, chip_y,
             "STOREFRONT   ·   RESUPPLY   ·   BILLING   ·   CLINICAL   "
             "·   VOICE AI", "Helvetica-Bold", 8.0, 2.0, GOLD_SOFT)

    # 10 — Footer: date / edition. (No tenant branding on the platform cover.)
    c.setFillColor(lerp(white, NAVY, 0.45))
    c.setFont("Helvetica", 9)
    c.drawCentredString(cx, 1.05 * inch,
                        "%s  ·  Platform edition" % TODAY)
    c.restoreState()


def _make_doc(klass, path):
    doc = klass(
        path, pagesize=letter,
        leftMargin=MARGIN_X, rightMargin=MARGIN_X,
        topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
        title="CareMetric Breathe User Manual",
        author="CareMetric Breathe",
    )
    frame = Frame(
        MARGIN_X, MARGIN_BOTTOM, CONTENT_W,
        PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="body",
    )
    cover_frame = Frame(0, 0, PAGE_W, PAGE_H, id="cover")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[cover_frame], onPage=_cover),
        PageTemplate(id="content", frames=[frame], onPage=_header_footer),
    ])
    return doc


def space_before_headings(flowables):
    """Stop sub-headings being orphaned at the foot of a page.

    A heading (an H2 sub-heading, a group/task label, or a drawn
    GroupHeading) must never be the last thing on a page. Two cases:

      * If the heading is immediately followed by an *atomic* block — a
        KeepTogether, which is what the feature/three-column tables and the
        FAQ Q&A blocks return, and which always fits on a page — bundle the
        heading together with it so the table can't jump to the next page and
        leave the heading stranded.
      * Otherwise (prose, bullet lists, or the long Control-Center flag
        tables that legitimately span pages) just insert a CondPageBreak so
        the heading has at least a few lines of room beneath it.

    H1 section headings already force a page break and are skipped. Applied
    identically in both build passes, so the captured TOC page numbers stay
    exact."""
    HEAD_STYLE_NAMES = {"H2Sub", "group", "task"}

    def is_heading(f):
        if isinstance(f, GroupHeading):
            return True
        return isinstance(f, Paragraph) and f.style.name in HEAD_STYLE_NAMES

    def is_atomic(f):
        return isinstance(f, Table) and getattr(f, "_atomic_table", False)

    out = []
    i = 0
    n = len(flowables)
    while i < n:
        f = flowables[i]
        if is_heading(f):
            j = i + 1
            spacer = None
            if j < n and isinstance(flowables[j], Spacer):
                spacer = flowables[j]
                j += 1
            nxt = flowables[j] if j < n else None
            # Bundle the heading with the table that follows it. For a short
            # atomic table the pair stays whole on one page; for a long
            # flag-category table the KeepTogether degrades gracefully —
            # heading + first rows stay together and the rest flows on — so
            # the heading is never stranded at the foot of a page.
            if isinstance(nxt, Table):
                grp = [f] + ([spacer] if spacer else []) + [nxt]
                out.append(KeepTogether(grp))
                i = j + 1
                continue
            out.append(CondPageBreak(0.9 * inch))
            out.append(f)
            i += 1
            continue
        if is_atomic(f):
            out.append(KeepTogether([f]))
            i += 1
            continue
        out.append(f)
        i += 1
    return out


def make_story(toc_entries):
    story = []

    # Cover (its own template) → switch to content for everything else.
    story.append(NextPageTemplate("content"))
    story.append(PageBreak())

    # ---- Table of Contents (one-page region, reserved in BOTH passes so
    # the body paginates identically and captured page numbers match). ----
    story.append(SectionMarker("Contents"))
    story.append(Paragraph("Table of Contents", S_H1_PLAIN))
    story.append(HBar())
    story.append(Spacer(1, 10))
    for level, text, page in toc_entries or []:
        story.append(TocLine(level, text, page))
    story.append(PageBreak())

    # ---- Introduction ----
    story += h1("Introduction")
    story.append(Paragraph(
        "Welcome to <b>CareMetric Breathe</b> — the single platform that "
        "runs a CPAP/DME resupply department end to end: the patient "
        "storefront, the customer database, billing and the revenue cycle, "
        "clinical therapy monitoring, and all the documentation in between. "
        "This manual is your guide to using it.", S_INTRO))
    story.append(Paragraph(
        "<b>Platform vs. tenant.</b> CareMetric Breathe is the software "
        "platform — every practice that runs on it is a separate "
        "<b>tenant</b> with its own brand, web address, phone numbers, "
        "patients, and billing. A new tenant starts with CareMetric "
        "branding and makes it their own from System Configuration; "
        "<b>Penn Home Medical Supply</b> is "
        "simply one example of a tenant operating on the platform. The "
        "screenshots in this manual come from the CareMetric demo "
        "environment, so they show the platform's own branding — your live "
        "console shows whatever brand you configure.", S_BODY))
    story.append(h2("Getting your workspace — self-serve sign-up"))
    story.append(Paragraph(
        "A new practice creates its own workspace from the public CareMetric "
        "Breathe site: open <b>/breathe</b> and choose <b>Create your "
        "account</b> (<b>/breathe/signup</b>). Enter your company name, a work "
        "email, a password (at least 12 characters), and pick a plan — Virtual "
        "Mask Fitter, Launch, Growth, or Scale; Enterprise is custom-quoted, so "
        "it routes to a sales conversation rather than self-signup. Submitting "
        "provisions your organization, copies in the feature-flag bundle for "
        "your plan, and creates your first <b>Owner</b> login.", S_BODY))
    story.append(Paragraph(
        "For security the account starts unverified: we email a verification "
        "link to the address you entered. Click it to activate the account, "
        "then sign in to your new workspace at <b>/admin/sign-in</b> — you "
        "confirm payment as you finish setting up. From there the Owner invites "
        "the rest of the team from the <b>Team</b> page (no one else needs to "
        "self-sign-up). Operators can still pre-provision a workspace from the "
        "command line, but self-serve sign-up is the normal path.", S_BODY))
    story += shot("platform-signup",
                  "Create your account on the public CareMetric Breathe site — "
                  "company, work email, password, and a plan spin up your "
                  "workspace and first Owner login.")
    story.append(h2("Signing in"))
    story.append(Paragraph(
        "Staff sign in at <b>/admin/sign-in</b> with the email your "
        "administrator invited and a password you set from the invite link. "
        "Forgot it? Use <b>/admin/forgot-password</b>; a link to verify a new "
        "email address arrives the same way. To protect against account "
        "enumeration, these pages always confirm “check your email” whether or "
        "not the address was on file. Every admin should "
        "enroll multi-factor authentication under <b>System → Account "
        "Security</b>. After signing in you land on the <b>Home</b> "
        "dashboard.", S_BODY))
    story += shot("admin-home",
                  "The Home dashboard: today's worklist, live counters, and "
                  "the left-hand navigation grouped by area.")
    story.append(h2("The four roles"))
    story.append(Paragraph(
        "Every staff account has a role that decides what they can see and "
        "do. This manual is organised around the four operating roles of a "
        "DME practice:", S_BODY))
    story.append(feature_table([
        ("Administrator", "Owner/admin of the practice — setup, team, controls, integrations, and full oversight of every area. The <b>Owner</b> is the top tier (team management + system secrets); <b>Admin</b> is broad management below that."),
        ("Biller", "Revenue-cycle staff — the entire Billing area (eligibility, claims, A/R, ERA, clearinghouse) plus patient billing context."),
        ("Customer Service Rep", "Front-line patient service — the inbox, front desk, scheduling, patients, orders, shop, and outreach."),
        ("Respiratory Therapist", "Clinical staff — therapy monitoring, clinical documentation, interventions, and provider-ready reports."),
    ]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Access is enforced everywhere: if a page is above your role, its "
        "link simply doesn't appear in your navigation. An Administrator "
        "assigns roles on the <b>Team</b> page — see the appendix for a "
        "role/permission matrix.", S_BODY))
    story.append(h2("Getting help inside the app"))
    story.append(Paragraph(
        "Two AI assistants are built in. <b>CareMetric Copilot</b> (the admin "
        "assistant; “PennPilot” for the Penn tenant) floats on every "
        "admin page — ask it how a feature works or where to find a page "
        "and it answers with clickable links. <b>CareMetric Assistant</b> "
        "(the storefront chatbot; “PennBot” for the Penn tenant) "
        "answers patients on the storefront and can hand off to a CSR. Both "
        "are tenant-renamable and can be toggled in the Control Center.",
        S_BODY))
    story.append(PageBreak())

    # ---- What sets it apart ----
    story += h1("What Sets CareMetric Breathe Apart")
    story.append(Paragraph(DIFFERENTIATORS_INTRO, S_LEAD))
    story.append(h2("Capabilities a spreadsheet stack can't match"))
    story.append(feature_table(DIFFERENTIATORS))
    story.append(Spacer(1, 6))
    story += shot("storefront-home",
                  "The patient storefront — one front door for fitting, "
                  "shopping, and resupply, with the AI assistant one tap away.")

    story.append(h2("The platform underneath every role"))
    story.append(Paragraph(PLATFORM_FOUNDATIONS_INTRO, S_BODY))
    story.append(feature_table(PLATFORM_FOUNDATIONS))
    story.append(PageBreak())

    # ---- The storefront & end-to-end fulfillment journey ----
    story += h1("The Storefront & End-to-End Fulfillment")
    story.append(Paragraph(STOREFRONT_INTRO, S_LEAD))
    story += shot("storefront-how-it-works",
                  "The storefront walks a patient from mask fitting to checkout "
                  "— one front door for fit, shop, and resupply.")
    for name, para in STOREFRONT_JOURNEY:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story += shot("csr-shop-orders",
                  "The order queue — paid orders ready to fulfill, ship, and "
                  "track, all in the same system that bills them.")
    story.append(PageBreak())

    # ---- Paperless paperwork: referrals, eFax, e-signature ----
    story += h1("Paperless Paperwork — Referrals, eFax & E-Signature")
    story.append(Paragraph(PAPERLESS_INTRO, S_LEAD))
    story.append(h2("The referral, read and ready in one pass"))
    for name, para in PAPERLESS_REFERRAL:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story += shot("admin-referral-reviewer",
                  "The Referral Reviewer — AI-extracted intake beside the "
                  "original packet, with a completeness check and one-click "
                  "insurance verification.")
    story.append(h2("eFax with a barcode — send once, file itself"))
    for name, para in PAPERLESS_EFAX:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story.append(h2("Never lose a signature again"))
    for name, para in PAPERLESS_SIGN:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story += shot("admin-signature-tracking",
                  "Awaiting Signatures — every document out for a provider's "
                  "signature, tracked until the barcode comes back.")
    story.append(PageBreak())

    # ---- The business case: revenue up, labor down ----
    story += h1("The Business Case — More Revenue, Less Labor")
    story.append(Paragraph(BUSINESS_CASE_INTRO, S_LEAD))

    story.append(h2("Where the new revenue comes from"))
    story.append(feature_table(REVENUE_LEVERS))

    story.append(h2("The biller's job, transformed"))
    story.append(Paragraph(BILLER_TRANSFORM_INTRO, S_BODY))
    for name, para in BILLER_TRANSFORM:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story += shot("biller-eligibility",
                  "Coverage is verified before billing and re-checked the "
                  "moment before a claim goes out — claims stop bouncing for "
                  "eligibility.")

    story.append(h2("Hours back, every day — and what they cost"))
    story.append(Paragraph(SAVINGS_INTRO, S_BODY))
    story.append(Paragraph("<b>Where the time goes — by feature</b>", S_GROUP))
    story.append(three_col_table(
        ["Feature", "Replaces this manual work", "Time saved"],
        SAVINGS_FEATURE,
        [1.7 * inch, CONTENT_W - 1.7 * inch - 1.5 * inch, 1.5 * inch]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("<b>Rolled up by role</b>", S_GROUP))
    story.append(three_col_table(
        ["Role", "What runs itself", "Per day"],
        SAVINGS_ROLE,
        [1.7 * inch, CONTENT_W - 1.7 * inch - 1.2 * inch, 1.2 * inch]))
    story.append(Spacer(1, 8))
    story.append(savings_stat_row(SAVINGS_TOTALS))
    story.append(Spacer(1, 6))
    story.append(Paragraph(SAVINGS_CLOSE, S_BODY))

    story.append(h2("What it adds up to"))
    story.append(Paragraph(BUSINESS_CASE_CLOSE, S_BODY))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        '<font size="8">%s</font>' % SAVINGS_FOOTNOTE,
        ParagraphStyle("fn", parent=S_TIP, fontName="Helvetica")))
    story.append(PageBreak())

    # ---- The AI assistants (chat + copilot) ----
    story += h1("CareMetric Copilot & the AI Assistants")
    story.append(Paragraph(ASSISTANTS_INTRO, S_LEAD))

    story.append(h2("CareMetric Assistant — the patient's 24/7 answer"))
    story.append(Paragraph(
        "The storefront chatbot (PennBot for the Penn tenant) is the "
        "customer-facing assistant.", S_BODY))
    for name, para in ASSISTANT_CUSTOMER:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))

    story.append(h2("CareMetric Copilot — every employee's guide to the app"))
    story.append(Paragraph(
        "The in-app admin assistant (PennPilot for the Penn tenant) is the "
        "staff-facing helper, on every admin page.", S_BODY))
    for name, para in ASSISTANT_STAFF:
        story.append(Paragraph(
            "<b><font color=\"%s\">%s.</font></b> %s"
            % (hexc(NAVY_DEEP), name, para), S_BODY))
    story += shot("admin-home",
                  "“Ask CareMetric Copilot” sits in the corner of every "
                  "admin page — staff get an answer without leaving the work.")

    story.append(h2("What a deflected call is worth"))
    story.append(Paragraph(CALL_DEFLECTION, S_BODY))
    story.append(Spacer(1, 4))
    story.append(tip(CALL_DEFLECTION_MATH))
    story.append(PageBreak())

    # ---- Running the business (owner's playbook) ----
    story += h1("Running the Business — the Owner's Playbook")
    story.append(Paragraph(OWNER_PLAYBOOK_INTRO, S_LEAD))
    story.append(h2("What to watch, and when"))
    for cadence, items in OWNER_WATCH:
        story.append(Paragraph(cadence, S_GROUP))
        story.append(bullets(items))
        story.append(Spacer(1, 3))

    story.append(h2("Monitor every corner from one screen"))
    story.append(Paragraph(
        "Because it is one platform, you watch the whole business without "
        "leaving it. Where to look, by area:", S_BODY))
    story.append(feature_table([(a, w) for a, w in MONITOR_AREAS]))

    story.append(h2("Reports you can run"))
    story.append(Paragraph(
        "From <b>Analytics &amp; Reports → Reports</b>, run any of these over "
        "a date range and export them:", S_BODY))
    story.append(feature_table(REPORTS_CATALOG))
    story.append(Spacer(1, 4))
    story.append(tip(REPORTS_NOTE))

    story.append(h2("Benchmarks — and staying ahead"))
    story.append(Paragraph(BENCHMARKS_INTRO, S_BODY))
    story.append(three_col_table(
        ["Metric", "Typical target", "How CareMetric Breathe keeps you ahead"],
        BENCHMARKS,
        [1.85 * inch, 1.05 * inch, CONTENT_W - 1.85 * inch - 1.05 * inch]))
    story.append(Spacer(1, 4))
    story.append(Paragraph('<font size="8">%s</font>' % BENCHMARKS_FOOTNOTE,
                           ParagraphStyle("bfn", parent=S_TIP,
                                          fontName="Helvetica")))
    story.append(PageBreak())

    # ---- Setup Guide ----
    story += h1("Setup Guide")
    story.append(Paragraph(SETUP_INTRO, S_LEAD))
    story.append(h2("Before you go live"))
    story += shot("admin-setup",
                  "Set Up Your Workspace — the guided checklist that walks a "
                  "new practice through the essentials.")
    for group, items in PREREQS:
        story.append(Paragraph(group, S_GROUP))
        story.append(feature_table([(name, why) for name, why in items]))
        story.append(Spacer(1, 4))
    story.append(tip(
        "Most of these live under <b>System → Settings</b> and "
        "<b>System → Setup &amp; Advanced</b>. You can launch without the "
        "optional integrations — the platform degrades gracefully when a "
        "credential is unset; the matching feature simply stays idle."))
    story.append(Spacer(1, 8))

    story.append(h2("Ready to bill on day one — the pre-loaded payers"))
    story.append(Paragraph(PAYERS_INTRO, S_BODY))
    story.append(Paragraph("<b>What's in the box</b>", S_GROUP))
    story.append(feature_table(PAYERS_CATEGORIES))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "<b>What every payer profile already knows</b>", S_GROUP))
    story.append(feature_table(PAYERS_PROFILE_FIELDS))
    story.append(Spacer(1, 4))
    story.append(tip(PAYERS_NOTE))
    story.append(Spacer(1, 8))

    story.append(h2("The Control Center — every toggle explained"))
    story.append(Paragraph(CONTROL_CENTER_INTRO, S_BODY))
    story += shot("admin-control-center",
                  "The Control Center — master on/off switches for every "
                  "major feature, grouped by area.")
    by_cat = {}
    for fl in FLAGS:
        by_cat.setdefault(fl["category"], []).append(fl)
    seen = set()
    for cat in FLAG_CATEGORY_ORDER + [c for c in by_cat if c
                                      not in FLAG_CATEGORY_ORDER]:
        if cat in seen or cat not in by_cat:
            continue
        seen.add(cat)
        story.append(GroupHeading(cat))
        story.append(Spacer(1, 3))
        story.append(flag_table(by_cat[cat]))
        story.append(Spacer(1, 5))
    story.append(PageBreak())

    # ---- Part 1: Feature summary by role ----
    story += h1("Part 1 — Feature Summary by Role")
    story.append(Paragraph(
        "A quick reference: every feature with a one-line description, "
        "grouped by the role that uses it most. Part 2 describes each in "
        "depth.", S_LEAD))
    for rid, short, kicker, mission in ROLES:
        block = [RoleBanner(kicker, short, mission), Spacer(1, 8)]
        story.append(KeepTogether(block))
        for group, feats in SUMMARY[rid]:
            story.append(Paragraph(group, S_GROUP))
            story.append(feature_table(feats))
            story.append(Spacer(1, 4))
        story.append(PageBreak())

    # ---- Part 2: detailed reference by role ----
    story += h1("Part 2 — Comprehensive Feature Reference by Role")
    story.append(Paragraph(
        "The full detail on every feature: what it's for and how it fits "
        "your day, grouped by role and by the area of the console where you "
        "find it.", S_LEAD))
    # a representative screenshot per role section opener
    role_shot = {
        "administrator": ("admin-control-center",
                          "Control Center — the master on/off switches for "
                          "major platform features."),
        "biller": ("biller-eligibility",
                   "The Eligibility worklist — system-wide 270/271 status, "
                   "worst coverage first."),
        "csr": ("csr-conversations",
                "Conversations — the unified SMS/MMS/email inbox a CSR "
                "works all day."),
        "rt": ("rt-overview",
               "RT Overview — the therapy board with per-patient AHI, "
               "leak, and usage alerts."),
    }
    for rid, short, kicker, mission in ROLES:
        story.append(RoleBanner(kicker, short, mission))
        story.append(Spacer(1, 8))
        sn, sc = role_shot[rid]
        story += shot(sn, sc)
        for group, intro, feats in DETAIL[rid]:
            story.append(GroupHeading(group))
            story.append(Spacer(1, 3))
            if intro:
                story.append(Paragraph(intro, S_BODY))
            for name, para in feats:
                story.append(Paragraph(
                    "<b><font color=\"%s\">%s.</font></b> %s"
                    % (hexc(NAVY_DEEP), name, para), S_BODY))
            story.append(Spacer(1, 4))
        story.append(PageBreak())

    # ---- Part 3: job aides ----
    story += h1("Part 3 — Job Aides by Role")
    story.append(Paragraph(
        "Step-by-step walkthroughs for the highest-value, most common tasks "
        "in each role. Navigation paths are shown as "
        "<b>Group → Section → Page</b>.", S_LEAD))
    aide_shot = {
        "administrator": ("admin-team",
                          "The Team page — invite staff and assign a role "
                          "(Owner, Admin, CSR, Biller, RT)."),
        "biller": ("biller-prior-auths",
                   "The Prior Auths worklist — at-risk SLAs and auths "
                   "expiring soon."),
        "csr": ("csr-front-desk",
                "Front Desk — ring up a walk-in counter order."),
        "rt": ("rt-clinical",
               "Clinical Encounters — document the care you provided."),
    }
    for rid, short, kicker, mission in ROLES:
        story.append(RoleBanner(kicker, short,
                                "Job aides — " + mission.split(" — ")[0]
                                if " — " in mission else mission))
        story.append(Spacer(1, 8))
        sn, sc = aide_shot[rid]
        story += shot(sn, sc)
        for item in JOB_AIDES[rid]:
            title, intro, step_list = item[0], item[1], item[2]
            tip_text = item[3] if len(item) > 3 else None
            block = [Paragraph(title, S_TASK)]
            if intro:
                block.append(Paragraph(intro, S_BODY))
            block.append(steps(step_list))
            if tip_text:
                block.append(Spacer(1, 4))
                block.append(tip(tip_text))
            block.append(Spacer(1, 6))
            # Keep short aides together; long ones may break across pages.
            story.append(KeepTogether(block) if len(step_list) <= 5
                         else block[0])
            if len(step_list) > 5:
                for fl in block[1:]:
                    story.append(fl)
        story.append(PageBreak())

    # ---- FAQ ----
    story += h1("Frequently Asked Questions")
    story.append(Paragraph(
        "Quick answers, grouped by area. For step-by-step instructions see "
        "the job aides in Part 3; for the full detail see Part 2.", S_LEAD))
    q_style = ParagraphStyle(
        "faqQ", fontName="Helvetica-Bold", fontSize=9.8, leading=13,
        textColor=NAVY_DEEP, spaceBefore=7, spaceAfter=1)
    for domain, qas in FAQ:
        for idx, (q, a) in enumerate(qas):
            qa = [Paragraph("Q&nbsp;&nbsp;" + q, q_style),
                  Paragraph(a, S_BODY)]
            # Bundle the domain heading with its first Q&A so the heading is
            # never orphaned at the foot of a page (flattened — no nesting).
            block = [h2(domain), *qa] if idx == 0 else qa
            story.append(KeepTogether(block))
    story.append(PageBreak())

    # ---- Appendix ----
    story += h1("Appendix")
    story.append(h2("Role & permission matrix"))
    story.append(Paragraph("What each role can reach.", S_BODY))
    story.append(marker_legend())
    story.append(Spacer(1, 5))
    header = ["Area", "Admin", "Biller", "CSR", "RT"]
    rows = [[Paragraph(h, S_TH) for h in header]]
    for area in MATRIX_AREAS:
        vals = MATRIX[area]
        row = [Paragraph(area, S_FEATURE_DESC)]
        for v in vals:
            row.append(Marker(v))
        rows.append(row)
    cw = [CONTENT_W - 4 * 0.78 * inch] + [0.78 * inch] * 4
    t = Table(rows, colWidths=cw, hAlign="LEFT")
    tstyle = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, NAVY),
    ]
    for i in range(len(header)):
        tstyle.append(("TEXTCOLOR", (i, 0), (i, 0), white))
    for r in range(1, len(rows)):
        tstyle.append(("BACKGROUND", (0, r), (-1, r),
                       PEARL if r % 2 else MIST))
    t.setStyle(TableStyle(tstyle))
    t._atomic_table = True
    story.append(t)
    story.append(Spacer(1, 6))
    story.append(Paragraph(MATRIX_NOTE, S_BODY))

    story.append(h2("How it compares"))
    story.append(Paragraph(MATRIX_INTRO, S_BODY))
    story.append(Paragraph(
        "<font size=\"8.5\">CMB = CareMetric Breathe · Brightree = Brightree "
        "with its ReSupply module · Niko = NikoHealth · TIMS = TIMS "
        "Software.</font>", S_TIP))
    story.append(Spacer(1, 4))
    cap_w = 0.86 * inch
    feat_w = CONTENT_W - 4 * cap_w
    center = ParagraphStyle("mc", parent=S_FEATURE_DESC, alignment=TA_CENTER)
    for group, rows in COMPARE_MATRIX:
        story.append(Paragraph(group, S_GROUP))
        body_rows = []
        for label, marks in rows:
            cells = [Paragraph(label, S_FEATURE_DESC)]
            for m in marks:
                cells.append(Marker(m))
            body_rows.append(cells)
        story.append(three_col_table(
            ["Feature"] + MATRIX_VENDORS, body_rows,
            [feat_w, cap_w, cap_w, cap_w, cap_w]))
        story.append(Spacer(1, 4))
    story.append(Paragraph('<font size="8">%s</font>' % MATRIX_FOOTNOTE,
                           ParagraphStyle("mfn", parent=S_TIP,
                                          fontName="Helvetica")))

    story.append(h2("Glossary"))
    story.append(feature_table(GLOSSARY))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>Need more?</b> Ask CareMetric Copilot in the app, or reach your "
        "practice administrator. Owners can find deployment and operator "
        "runbooks in the project documentation.", S_BODY))

    return space_before_headings(story)


def _count_toc_pages(entries):
    """How many pages the rendered Table of Contents occupies, using
    reportlab's real layout (so a multi-page TOC is handled exactly)."""
    cv = _pdfcanvas.Canvas(io.BytesIO(), pagesize=letter)
    avail_h = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
    flow = [Paragraph("Table of Contents", S_H1_PLAIN), HBar(), Spacer(1, 10)]
    flow += [TocLine(lvl, text, page) for (lvl, text, page) in entries]
    pages = 1
    fr = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, avail_h)
    for f in flow:
        if not fr.add(f, cv):
            pages += 1
            fr = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, avail_h)
            fr.add(f, cv)
    return pages


def build():
    # Pass 1 — capture each heading's final page against a one-page TOC
    # placeholder (so the body paginates identically to pass 2).
    cap_path = os.path.join(HERE, ".manual-capture.pdf")
    cap = _make_doc(CaptureDoc, cap_path)
    cap.build(make_story(None))

    # The real TOC may run to more than one page; the placeholder was one
    # page, so every captured body page shifts by (toc_pages - 1). Offset
    # the captured numbers so the rendered TOC is exact.
    toc_pages = _count_toc_pages(cap.captured)
    offset = toc_pages - 1
    entries = [(lvl, text, page + offset) for (lvl, text, page) in cap.captured]

    # Pass 2 — render the real (possibly multi-page) TOC from the
    # offset-corrected entries.
    doc = _make_doc(ManualDoc, OUT_PATH)
    doc.build(make_story(entries))

    try:
        os.remove(cap_path)
    except OSError:
        pass
    print("wrote %s (%d-page TOC)" % (OUT_PATH, toc_pages))


if __name__ == "__main__":
    build()

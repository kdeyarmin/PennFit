#!/usr/bin/env python3
"""Generate the "Set up Slack" operator guide PDF for the in-app help link.

Output: artifacts/cpap-fitter/public/guides/setup-slack.pdf (served at
/guides/setup-slack.pdf by the SPA static host). Re-run after editing to
regenerate. Content is operator/admin-facing setup instructions — no PHI.
"""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = (
    Path(__file__).resolve().parents[1]
    / "artifacts/cpap-fitter/public/guides/setup-slack.pdf"
)

NAVY = colors.HexColor("#0a1f44")
INK = colors.HexColor("#1f2937")
SUBTLE = colors.HexColor("#6b7280")
LINE = colors.HexColor("#e5e7eb")
SURFACE = colors.HexColor("#f8fafc")
GREEN = colors.HexColor("#15803d")

styles = getSampleStyleSheet()


def style(name, **kw):
    base = kw.pop("parent", styles["Normal"])
    return ParagraphStyle(name, parent=base, **kw)


H_TITLE = style("t", parent=styles["Title"], textColor=NAVY, fontSize=26,
                spaceAfter=6, leading=30)
H_SUB = style("st", textColor=SUBTLE, fontSize=12, spaceAfter=2, leading=16)
H1 = style("h1", textColor=NAVY, fontSize=16, spaceBefore=18, spaceAfter=6,
           leading=20, fontName="Helvetica-Bold")
H2 = style("h2", textColor=INK, fontSize=12.5, spaceBefore=10, spaceAfter=4,
           leading=16, fontName="Helvetica-Bold")
BODY = style("body", textColor=INK, fontSize=10.5, leading=15, spaceAfter=6,
             alignment=TA_LEFT)
SMALL = style("small", textColor=SUBTLE, fontSize=9, leading=13)
STEP = style("step", textColor=INK, fontSize=10.5, leading=15)
MONO = style("mono", parent=styles["Code"], textColor=NAVY, fontSize=9.5,
             leading=13, backColor=SURFACE)
CALL = style("call", textColor=INK, fontSize=10, leading=14)


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(t, STEP), leftIndent=6) for t in items],
        bulletType="1", leftIndent=18, bulletColor=NAVY, bulletFontName="Helvetica-Bold",
    )


def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(t, STEP), leftIndent=6) for t in items],
        bulletType="bullet", start="•", leftIndent=18, bulletColor=NAVY,
    )


def callout(title, body, tone=NAVY):
    inner = [Paragraph(f"<b>{title}</b>", CALL)]
    if body:
        inner.append(Paragraph(body, CALL))
    t = Table([[inner]], colWidths=[6.7 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("BOX", (0, 0), (-1, -1), 0.75, tone),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def rule():
    return HRFlowable(width="100%", thickness=0.6, color=LINE,
                      spaceBefore=8, spaceAfter=8)


def kv_table(rows, head):
    data = [[Paragraph(f"<b>{h}</b>", SMALL) for h in head]]
    for r in rows:
        data.append([Paragraph(c, SMALL) for c in r])
    t = Table(data, colWidths=[1.7 * inch, 5.0 * inch], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SURFACE]),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    # restyle header cells white text
    data[0] = [Paragraph(f'<font color="white"><b>{h}</b></font>', SMALL) for h in head]
    return t


def trouble_table(rows):
    head = ["Symptom", "What it means", "Fix"]
    data = [[Paragraph(f'<font color="white"><b>{h}</b></font>', SMALL) for h in head]]
    for r in rows:
        data.append([Paragraph(c, SMALL) for c in r])
    t = Table(data, colWidths=[1.9 * inch, 2.2 * inch, 2.6 * inch], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SURFACE]),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(0.9 * inch, 0.7 * inch, 7.6 * inch, 0.7 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(SUBTLE)
    canvas.drawString(0.9 * inch, 0.55 * inch,
                      "CareMetric Breathe — Slack integration setup guide")
    canvas.drawRightString(7.6 * inch, 0.55 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUT), pagesize=letter,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.9 * inch, bottomMargin=0.9 * inch,
        title="Set up Slack — CareMetric Breathe",
        author="CareMetric Breathe",
        subject="How to connect your Slack workspace for CS alerts",
    )
    s = []

    # ---- Cover ----
    s.append(Paragraph("Set up Slack", H_TITLE))
    s.append(Paragraph(
        "Send your customer-service alerts to the Slack workspace your team "
        "already uses — and act on them right from Slack.", H_SUB))
    s.append(Spacer(1, 10))
    s.append(rule())
    s.append(Paragraph("What you get", H1))
    s.append(Paragraph(
        "Once connected, CareMetric Breathe posts real-time, non-PHI alerts "
        "into a Slack channel your reps watch, each with a deep link into the "
        "admin console:", BODY))
    s.append(bullets([
        "<b>A patient reply needs a human</b> — an SMS/email conversation moved to the queue.",
        "<b>Voice call handoff</b> — the AI summarizer flagged a call (with caller sentiment).",
        "<b>SLA breach</b> — a conversation passed its response deadline.",
        "<b>Reminder ladder exhausted</b> — a patient is unresponsive after every channel.",
        "<b>NPS detractor</b> — a low post-delivery survey score.",
        "<b>Delivery-failure spike</b> — outbound messages are bouncing.",
        "<b>Operator digests</b> — weekly KPIs, metric alerts, stuck jobs, low stock.",
    ]))
    s.append(Paragraph("And your reps can act without leaving Slack:", BODY))
    s.append(bullets([
        "<b>Claim</b> — assign the conversation to yourself.",
        "<b>Escalate</b> — push it to the top of the queue.",
        "<b>Snooze</b> — defer it for a day.",
        "<b>/pennfit queue</b> — see unassigned + SLA-breaching counts on demand.",
    ]))
    s.append(Spacer(1, 6))
    s.append(callout(
        "Privacy",
        "Slack messages are intentionally non-PHI: a reference id, a status, "
        "and a link — never message bodies, names, phone numbers, or clinical "
        "detail. The actual content stays in the admin console.", GREEN))

    s.append(PageBreak())

    # ---- Path A: one-click ----
    s.append(Paragraph("The easy way: one-click “Add to Slack”", H1))
    s.append(Paragraph(
        "If your platform administrator has registered the CareMetric Breathe "
        "Slack app, this is all you need:", BODY))
    s.append(steps([
        "Go to <b>Admin &rarr; System &rarr; System Configuration</b> and find "
        "the <b>Team notifications (Slack)</b> card.",
        "Click <b>Add to Slack</b>.",
        "In Slack’s approval screen, choose the channel your reps watch and "
        "click <b>Allow</b>.",
        "You’re returned to System Configuration with a “Connected” "
        "banner. The bot token, workspace id, and channel are filled in for you.",
        "Click <b>Send test message</b> to confirm a message lands in the channel.",
    ]))
    s.append(callout(
        "Don’t see the “Add to Slack” button working?",
        "It says “one-click connect isn’t set up by the platform yet.” "
        "Use the manual steps on the next page, or ask your platform "
        "administrator to register the Slack app (client id + secret)."))

    s.append(PageBreak())

    # ---- Path B: manual ----
    s.append(Paragraph("The manual way: connect your own Slack app", H1))
    s.append(Paragraph(
        "Use this if you’re bringing your own Slack app. It takes about "
        "10 minutes. You’ll create a Slack app, copy three values into "
        "System Configuration, and verify.", BODY))

    s.append(Paragraph("Step 1 — Create the Slack app", H2))
    s.append(steps([
        "Go to <font color='#0a1f44'>api.slack.com/apps</font> and click "
        "<b>Create New App &rarr; From scratch</b>.",
        "Name it (e.g. “CareMetric Breathe”), pick your workspace, "
        "and click <b>Create App</b>.",
    ]))

    s.append(Paragraph("Step 2 — Add the bot permission", H2))
    s.append(steps([
        "In the left sidebar open <b>OAuth &amp; Permissions</b>.",
        "Under <b>Scopes &rarr; Bot Token Scopes</b>, click <b>Add an OAuth "
        "Scope</b> and add <b>chat:write</b>.",
        "(Optional, for the slash command) also add <b>commands</b>.",
    ]))

    s.append(Paragraph("Step 3 — Install &amp; copy the bot token", H2))
    s.append(steps([
        "At the top of <b>OAuth &amp; Permissions</b>, click <b>Install to "
        "Workspace</b> and approve.",
        "Copy the <b>Bot User OAuth Token</b> — it starts with "
        "<font face='Courier'>xoxb-</font>.",
        "In CareMetric Breathe, paste it into <b>Bot token</b> on the Slack card "
        "and click Save.",
    ]))

    s.append(Paragraph("Step 4 — Pick the channel &amp; invite the bot", H2))
    s.append(steps([
        "In Slack, open the channel your reps watch (e.g. <b>#cs-alerts</b>).",
        "Invite the bot: type <font face='Courier'>/invite @YourAppName</font> "
        "in that channel.",
        "Get the channel id: click the channel name &rarr; scroll to the bottom "
        "of the <b>About</b> tab &rarr; copy the <b>Channel ID</b> "
        "(starts with <font face='Courier'>C</font>).",
        "Paste it into <b>Alerts channel id</b> in CareMetric Breathe and Save.",
    ]))
    s.append(callout(
        "That’s the minimum for alerts.",
        "With just the bot token + channel id saved, click <b>Send test "
        "message</b>. It verifies the token, auto-detects and saves your "
        "workspace id, and posts a confirmation. The buttons + slash command "
        "need two more steps below."))

    s.append(PageBreak())

    s.append(Paragraph("Step 5 — Enable the buttons (Claim / Escalate / Snooze)", H2))
    s.append(steps([
        "In the Slack app, open <b>Basic Information &rarr; App Credentials</b> "
        "and copy the <b>Signing Secret</b>.",
        "Paste it into <b>Signing secret</b> in CareMetric Breathe and Save.",
        "In the Slack app, open <b>Interactivity &amp; Shortcuts</b>, turn "
        "<b>Interactivity</b> on, and set the <b>Request URL</b> to the "
        "Interactivity URL shown on the Slack card (it ends in "
        "<font face='Courier'>/resupply-api/slack/interactivity</font>).",
        "Save in Slack.",
    ]))

    s.append(Paragraph("Step 6 — Enable the /pennfit slash command (optional)", H2))
    s.append(steps([
        "In the Slack app, open <b>Slash Commands &rarr; Create New Command</b>.",
        "Command: <font face='Courier'>/pennfit</font>. Request URL: the Slash "
        "command URL on the Slack card (ends in "
        "<font face='Courier'>/resupply-api/slack/commands</font>).",
        "Short description: “Show the CS queue.” Save.",
        "Reinstall the app if Slack prompts you to (new scope).",
    ]))

    s.append(Paragraph("Step 7 — Send a test message", H2))
    s.append(steps([
        "Back on the Slack card, click <b>Send test message</b>.",
        "You should see “Connected to &lt;your workspace&gt; — test message "
        "sent” and a ✅ message in your channel.",
        "Done. Alerts will now post automatically.",
    ]))

    s.append(PageBreak())

    # ---- Values reference ----
    s.append(Paragraph("Where each value comes from", H1))
    s.append(kv_table([
        ["Bot token", "Slack &rarr; OAuth &amp; Permissions &rarr; Bot User OAuth "
         "Token (<font face='Courier'>xoxb-…</font>)."],
        ["Alerts channel id", "Slack channel &rarr; About tab &rarr; Channel ID "
         "(<font face='Courier'>C…</font>). Invite the bot first."],
        ["Signing secret", "Slack &rarr; Basic Information &rarr; App Credentials. "
         "Only needed for buttons / slash command."],
        ["Workspace (team) id", "Auto-detected and saved when you click "
         "<b>Send test message</b> — you don’t enter it."],
        ["Interactivity / Slash URLs", "Shown on the Slack card; paste into the "
         "Slack app’s Interactivity and Slash Command settings."],
    ], ["Value", "Where to find it"]))

    s.append(Paragraph("Turning features on/off", H1))
    s.append(Paragraph(
        "Three switches under <b>Admin &rarr; System &rarr; Feature Flags</b> "
        "control Slack (all on by default, but inert until you connect):", BODY))
    s.append(bullets([
        "<b>slack.notifications</b> — real-time CS alerts.",
        "<b>slack.digests</b> — the operator digests (set an #ops channel with "
        "the optional <i>Digests channel id</i> to separate them).",
        "<b>slack.interactivity</b> — inbound buttons + the /pennfit command.",
    ]))

    s.append(Paragraph("Make “Claim” assign to the right rep", H1))
    s.append(Paragraph(
        "So a Claim click assigns the conversation to the person who clicked, "
        "link each rep’s Slack account to their admin account:", BODY))
    s.append(steps([
        "In Slack, the rep opens their profile &rarr; <b>More (…) &rarr; "
        "Copy member ID</b> (starts with <font face='Courier'>U</font>).",
        "In CareMetric Breathe, go to <b>Admin &rarr; Team</b>, find the rep, and "
        "paste it into the <b>Slack ID</b> field.",
        "Now their Claim clicks assign to them. Unlinked reps get a friendly "
        "prompt to link their account.",
    ]))

    s.append(PageBreak())

    # ---- Troubleshooting ----
    s.append(Paragraph("Troubleshooting", H1))
    s.append(trouble_table([
        ["Test says <b>not configured</b>",
         "Bot token or channel id is missing.",
         "Add both on the Slack card, then retry."],
        ["Test says <b>invalid_auth</b> / token rejected",
         "The bot token is wrong or the app was uninstalled.",
         "Re-copy the <font face='Courier'>xoxb-</font> token; reinstall the app."],
        ["Test says <b>channel_not_found</b>",
         "The channel id is wrong, or it’s a private channel the bot can’t see.",
         "Re-copy the Channel ID from the About tab; use a channel the bot is in."],
        ["Test says <b>not_in_channel</b>",
         "The bot isn’t a member of the channel.",
         "Run <font face='Courier'>/invite @YourApp</font> in that channel."],
        ["Buttons do nothing",
         "Signing secret missing, or the Interactivity Request URL is wrong.",
         "Paste the signing secret; set the exact Interactivity URL from the card."],
        ["/pennfit not found",
         "The slash command isn’t created or points at the wrong URL.",
         "Create /pennfit with the Slash command URL from the card; reinstall."],
        ["Claim says “account isn’t linked”",
         "The clicking rep has no Slack ID on their Team record.",
         "Add their Slack member id under Admin &rarr; Team."],
        ["No alerts arriving",
         "Connected, but the slack.notifications flag is off.",
         "Enable it under Admin &rarr; System &rarr; Feature Flags."],
    ]))
    s.append(Spacer(1, 10))
    s.append(callout(
        "Still stuck?",
        "Open <b>Admin &rarr; System &rarr; Support</b> and file a ticket — "
        "include what the <b>Send test message</b> button reported."))
    s.append(Spacer(1, 8))
    s.append(Paragraph(
        "CareMetric Breathe connects to the Slack workspace your team already "
        "uses; nothing new for your reps to install.", SMALL))

    doc.build(s, onFirstPage=footer, onLaterPages=footer)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()

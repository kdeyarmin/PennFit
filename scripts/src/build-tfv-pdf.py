"""Generate the Twilio Toll-Free Verification answer-sheet PDF for PennPaps."""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Preformatted,
    PageBreak,
    Table,
    TableStyle,
    KeepTogether,
)
from datetime import date

OUT = "outputs/pennpaps-twilio-tfv-answers.pdf"

NAVY = colors.HexColor("#0a2240")
GOLD = colors.HexColor("#b08d3e")
INK = colors.HexColor("#1f2937")
MUTED = colors.HexColor("#4b5563")
RULE = colors.HexColor("#d1d5db")
CODE_BG = colors.HexColor("#f5f5f4")

styles = getSampleStyleSheet()

H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=20,
    textColor=NAVY, spaceAfter=4, leading=24,
)
SUB = ParagraphStyle(
    "Sub", parent=styles["Normal"], fontName="Helvetica", fontSize=10,
    textColor=MUTED, spaceAfter=14, leading=13,
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13,
    textColor=NAVY, spaceBefore=14, spaceAfter=4, leading=16,
)
LBL = ParagraphStyle(
    "LBL", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=10,
    textColor=GOLD, spaceBefore=10, spaceAfter=2, leading=13,
    textTransform="uppercase",
)
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"], fontName="Helvetica", fontSize=10.5,
    textColor=INK, leading=14.5, spaceAfter=6, alignment=TA_LEFT,
)
NOTE = ParagraphStyle(
    "Note", parent=styles["Normal"], fontName="Helvetica-Oblique", fontSize=9.5,
    textColor=MUTED, leading=13, spaceAfter=8,
)
CODE = ParagraphStyle(
    "Code", parent=styles["Code"], fontName="Courier", fontSize=9.5,
    textColor=INK, leading=12.5, leftIndent=10, rightIndent=10,
    spaceBefore=4, spaceAfter=8, backColor=CODE_BG, borderPadding=8,
    borderColor=RULE, borderWidth=0.5,
)


def field(story, label, value_paras, hint=None):
    story.append(Paragraph(label.upper(), LBL))
    if isinstance(value_paras, str):
        value_paras = [Paragraph(value_paras, BODY)]
    elif isinstance(value_paras[0], str):
        value_paras = [Paragraph(v, BODY) if "\n" not in v else Preformatted(v, CODE) for v in value_paras]
    for v in value_paras:
        story.append(v)
    if hint:
        story.append(Paragraph(hint, NOTE))


def code_block(text):
    return Preformatted(text, CODE)


def hr(story):
    t = Table([[""]], colWidths=[6.5 * inch], rowHeights=[0.4])
    t.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 0.5, RULE)]))
    story.append(Spacer(1, 6))
    story.append(t)
    story.append(Spacer(1, 6))


def header_footer(canvas, doc):
    canvas.saveState()
    # Header band
    canvas.setFillColor(NAVY)
    canvas.rect(0, LETTER[1] - 0.55 * inch, LETTER[0], 0.55 * inch, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.rect(0, LETTER[1] - 0.58 * inch, LETTER[0], 0.03 * inch, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawString(0.6 * inch, LETTER[1] - 0.36 * inch, "PennPaps")
    canvas.setFont("Helvetica", 9)
    canvas.drawString(1.4 * inch, LETTER[1] - 0.36 * inch,
                      "Twilio Toll-Free Verification — Step 2 Answer Sheet")
    canvas.drawRightString(LETTER[0] - 0.6 * inch, LETTER[1] - 0.36 * inch,
                           f"Prepared {date.today().isoformat()}")
    # Footer
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.6 * inch, 0.4 * inch,
                      "info@pennpaps.com  ·  Confidential — for Twilio Trust Hub submission")
    canvas.drawRightString(LETTER[0] - 0.6 * inch, 0.4 * inch,
                           f"Page {doc.page}")
    canvas.restoreState()


doc = SimpleDocTemplate(
    OUT, pagesize=LETTER,
    leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    topMargin=0.85 * inch, bottomMargin=0.65 * inch,
    title="PennPaps — Twilio TFV Step 2 Answer Sheet",
    author="PennPaps",
)

story = []

story.append(Paragraph("Twilio Toll-Free Verification", H1))
story.append(Paragraph("Step 2/2 — Messaging use case · Copy-paste answer sheet", SUB))
story.append(Paragraph(
    "Replace every <b><font color='#b08d3e'>YOUR-DOMAIN</font></b> placeholder with the public "
    "domain that serves your deployed PennPaps site (e.g. <font face='Courier'>pennfit.up.railway.app</font> "
    "or your custom domain). The URLs you submit must be reachable by Twilio reviewers without a login.",
    NOTE,
))

hr(story)

# 1. Estimated monthly volume
field(story, "Estimated monthly volume", "<b>100</b>")

# 2. Opt-in type
field(story, "Opt-in type",
      "<b>Web form</b>",
      "PennPaps captures consent through a labeled checkbox on the order checkout form.")

# 3. Use case categories
field(story, "Messaging use case categories",
      "<b>1. Account Notification</b> &nbsp; (primary)<br/>"
      "<b>2. Customer Care</b> &nbsp; (secondary — covers HELP/STOP replies and inbound questions)",
      "Do not select Marketing, Polling/Voting, or any Higher Risk category — your traffic is "
      "purely transactional and reviewers reject mismatches.")

# 4. Proof of consent URL
field(story, "Proof of consent (opt-in) collected — URL",
      "<font face='Courier'>https://YOUR-DOMAIN/terms</font>",
      "If the form lets you list more than one URL, also include "
      "https://YOUR-DOMAIN/privacy and https://YOUR-DOMAIN/order.")

# 5. Use case description
field(story, "Use case description (paste verbatim)", [code_block(
    "PennPaps is a U.S. durable medical equipment supplier that ships CPAP masks\n"
    "and resupply parts to patients with sleep-apnea prescriptions. Patients place\n"
    "an order through our website (https://YOUR-DOMAIN/order) and check a clearly\n"
    "labeled consent box authorizing PennPaps to contact them by phone, email,\n"
    "and SMS. After opt-in, we send transactional SMS messages from our toll-free\n"
    "number for: order confirmation, shipping updates, insurance verification\n"
    "follow-ups, prescription requests, and resupply reminders when the patient\n"
    "is due for new CPAP supplies (typically every 30 to 90 days, per their\n"
    "insurance benefit). Patients can reply YES/NO/EDIT to confirm or change\n"
    "shipments, HELP for assistance, and STOP to opt out at any time. We do not\n"
    "send marketing or promotional content."
)])

# 6. Sample message
field(story, "Sample message (paste verbatim)", [code_block(
    "Hi John, this is PennPaps. Time to refill your CPAP supplies — reply YES to\n"
    "confirm shipping to the address on file, EDIT to change it, or STOP to opt out."
)])

# 7. Email
field(story, "E-mail for notifications",
      "<font face='Courier'>info@pennpaps.com</font>",
      "Or whichever inbox you actually monitor — Twilio sends approval/rejection here.")

# 8. Opt-in confirmation message
field(story, "Opt-in confirmation message (optional)", [code_block(
    "PennPaps: You're opted in to CPAP resupply reminders for the number on file.\n"
    "Approx 1-2 msgs per refill cycle. Msg & data rates may apply. Reply HELP for\n"
    "help, STOP to cancel."
)])

# 9. Help message sample
field(story, "Help message sample (optional — verbatim what HELP returns)", [code_block(
    "PennPaps — automated CPAP refill reminders. Reply YES to confirm, NO to\n"
    "decline, EDIT to change your address, STOP to opt out. Standard message +\n"
    "data rates may apply."
)])

# 10. Privacy / Terms URLs
field(story, "Privacy policy URL (optional)",
      "<font face='Courier'>https://YOUR-DOMAIN/privacy</font>")
field(story, "Terms &amp; conditions URL (optional)",
      "<font face='Courier'>https://YOUR-DOMAIN/terms</font>")

# 11. Opt-in keywords
field(story, "Opt-in keywords (optional)",
      "<font face='Courier'>START YES JOIN UNSTOP</font>")

# 12. Additional information
field(story, "Additional information (optional, paste verbatim)", [code_block(
    "PennPaps is a HIPAA-aware DME supplier; SMS traffic is strictly transactional\n"
    "to existing customers who have completed an opt-in checkbox on our order form\n"
    "at https://YOUR-DOMAIN/order. The consent text on the form (verbatim) reads:\n"
    "\"I authorize PennPaps to contact me by phone, email, and SMS text message at\n"
    "the number and email above regarding this order, insurance verification,\n"
    "shipping updates, and ongoing CPAP resupply reminders.\" Immediately below\n"
    "the checkbox we disclose: approximately 1-2 messages per resupply cycle,\n"
    "no marketing texts, message and data rates may apply, reply HELP for help\n"
    "and STOP to unsubscribe, with links to the Privacy Policy and Terms of\n"
    "Service. STOP/UNSUBSCRIBE/CANCEL/END/QUIT/OPTOUT are all honored\n"
    "automatically by our SMS handler with the confirmation reply: \"You've been\n"
    "unsubscribed and won't get further messages from us. Reply START to resume.\"\n"
    "We will not share or sell phone numbers or SMS opt-in consent for marketing."
)])

# 13. Age gated
field(story, "Contains age-gated content", "<b>No</b> &nbsp; — leave unchecked.",
      "CPAP resupply is not age-restricted content. The 18+ language in our Terms is "
      "a contracting requirement, not an age gate.")

# 14. Agreements
field(story, "Required agreements — check both",
      "&#9744;&nbsp; I agree to the Terms of Service. &nbsp;<b>(Check)</b><br/>"
      "&#9744;&nbsp; I certify that the associated Business Profile is the originator of "
      "the phone calls and certify that I will participate in traceback efforts. &nbsp;<b>(Check)</b>",
      "Both are accurate — your toll-free number is the originator (you're not relaying for someone else).")

story.append(PageBreak())

# Reference page
story.append(Paragraph("Reference — what the site already says", H1))
story.append(Paragraph(
    "These are the verbatim disclosures Twilio reviewers will see on the public site. "
    "If a reviewer asks where consent or HELP/STOP language lives, point to these.",
    SUB,
))

story.append(Paragraph("Order-form opt-in checkbox label (/order)", H2))
story.append(code_block(
    "I authorize PennPaps to contact me by phone, email, and SMS text\n"
    "message at the number and email above regarding this order,\n"
    "insurance verification, shipping updates, and ongoing CPAP resupply\n"
    "reminders, and to store the order details I've entered above\n"
    "(including my contact, shipping, insurance, and prescription\n"
    "information) in PennPaps's secure system for fulfillment and\n"
    "recordkeeping."
))

story.append(Paragraph("SMS terms shown beneath the checkbox (/order)", H2))
story.append(code_block(
    "SMS terms: By providing your mobile number you consent to receive\n"
    "transactional text messages from PennPaps at that number, including\n"
    "via automated systems. Approximately 1-2 messages per resupply\n"
    "cycle (typically every 30-90 days). No marketing texts. Message\n"
    "and data rates may apply. Reply HELP for help, STOP to unsubscribe\n"
    "at any time. See our Privacy Policy and Terms of Service for full\n"
    "SMS program details."
))

story.append(Paragraph("Privacy policy — Section 05 SMS / Text Messaging Notifications (/privacy)", H2))
story.append(code_block(
    "Frequency: Approximately 1 to 2 messages per resupply cycle, plus\n"
    "transactional confirmations and any follow-ups if you do not\n"
    "respond. You will not receive marketing or promotional texts.\n\n"
    "Help and opt-out: Reply HELP at any time for assistance, or STOP\n"
    "to unsubscribe from all PennPaps text messages. After you reply\n"
    "STOP we will send one final confirmation and then no further\n"
    "texts; reply START to resume.\n\n"
    "Carrier charges: Message and data rates may apply. Carriers are\n"
    "not liable for delayed or undelivered messages.\n\n"
    "No third-party sharing for marketing: PennPaps will not sell,\n"
    "rent, or share your mobile phone number or SMS opt-in consent\n"
    "with any third party for their marketing purposes."
))

story.append(Paragraph("Terms of Service — Section 04 SMS / Text Messaging Program (/terms)", H2))
story.append(Paragraph(
    "Full program disclosure: program name, message types, message frequency, carrier "
    "charges, HELP behavior, STOP/END/CANCEL/UNSUBSCRIBE/QUIT/OPTOUT keywords, eligible "
    "carriers, and the no-third-party-marketing commitment. This is the URL recommended "
    "for the &quot;Proof of consent collected&quot; field.",
    BODY,
))

story.append(PageBreak())

# Pre-submission checklist
story.append(Paragraph("Pre-submission checklist", H1))
story.append(Paragraph(
    "Run through this before clicking Submit. A rejected TFV adds 1–3 weeks of latency.",
    SUB,
))

checklist = [
    ("Replace YOUR-DOMAIN everywhere",
     "Swap each YOUR-DOMAIN placeholder above for your actual published domain. Test each "
     "URL in an incognito window to confirm it loads without authentication."),
    ("Confirm /privacy, /terms, and /order are publicly reachable",
     "Twilio reviewers cannot complete the fitter funnel. /terms is the most important — "
     "it has the full SMS program disclosure in section 04."),
    ("Verify business profile name is exactly \"PennPaps\"",
     "The DBA / business name on your TFV submission must match what the site says. "
     "Site shows \"PennPaps\" everywhere; make sure your Trust Hub Business Profile uses the "
     "same string (not \"Penn Home Medical Supply\" or any other variant)."),
    ("Decide imported-patient policy",
     "Your TFV promises every recipient opted in via the web form. If you import existing "
     "patients via the dashboard CSV importer, those patients did NOT check this checkbox. "
     "Either restrict SMS to web-form opt-ins, or ship a one-time opt-in confirmation SMS "
     "to imports as their first message (with STOP honored before any further sends)."),
    ("Toll-free number ownership",
     "Confirm the toll-free number you're verifying is purchased in YOUR Twilio account "
     "(not pooled / not subaccount-borrowed). The traceback certification only holds if "
     "you are the originator."),
    ("Email inbox is monitored",
     "Use info@pennpaps.com (or whatever real inbox you check). TFV approvals and "
     "rejections arrive by email and can ask follow-up questions with short reply windows."),
]

rows = []
for title, body in checklist:
    rows.append([
        Paragraph(f"&#9744;", BODY),
        Paragraph(f"<b>{title}</b><br/><font color='#4b5563' size='9'>{body}</font>", BODY),
    ])

t = Table(rows, colWidths=[0.35 * inch, 6.15 * inch])
t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
]))
story.append(t)

doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(f"Wrote {OUT}")

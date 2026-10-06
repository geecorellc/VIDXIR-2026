"""Build the Vidxir AI Official JV Doc as a .docx, ready to upload to Google Docs.

Modelled on the Lyrixsa AI JV doc's section order and typography, re-coloured to
the partners page's YouTube red/white rather than Lyrixsa's gold. Tables instead
of prose, no feature essays.

Every price, date, credit figure and model name below comes from this repo —
partners/index.html for the launch offer, src/lib/plans for the tiers,
src/lib/credits/packs.ts for the top-ups, src/lib/providers/video-gen.ts for the
model names. Nothing is quoted from a deployed page, and nothing that is still
unconfirmed is stated as fact: the three open items (JVZoo product IDs, the
partner support inbox, the refund window) are marked TO CONFIRM in the document
itself, exactly as they are marked on the JV page, so an affiliate cannot mail a
figure the launch has not committed to.

    pip install python-docx
    python partners/build-jv-doc.py
"""
import os

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

# The partners page's palette, so the document and the page read as one launch.
# --red / --ink / --gray / --soft in partners/index.html.
RED = RGBColor(0xFF, 0x00, 0x00)
INK = RGBColor(0x0F, 0x0F, 0x0F)
MUTE = RGBColor(0x60, 0x60, 0x60)
HDR_BG = "0F0F0F"
ZEBRA = "F9F9F9"

HERE = os.path.dirname(os.path.abspath(__file__))

doc = Document()

# ---- page + base style -------------------------------------------------
sec = doc.sections[0]
sec.top_margin = sec.bottom_margin = Inches(0.7)
sec.left_margin = sec.right_margin = Inches(0.75)

base = doc.styles["Normal"]
base.font.name = "Calibri"
base.font.size = Pt(10)
base.font.color.rgb = INK
base.paragraph_format.space_after = Pt(5)
base.paragraph_format.line_spacing = 1.1


def _shade(cell, hexfill):
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hexfill)
    cell._tc.get_or_add_tcPr().append(el)


def h1(text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(text)
    r.font.size = Pt(23)
    r.font.bold = True
    r.font.color.rgb = INK
    return p


def h2(text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(15)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text)
    r.font.size = Pt(13.5)
    r.font.bold = True
    r.font.color.rgb = RED
    return p


def para(text, size=10, bold=False, color=INK, italic=False, after=5):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.italic = italic
    r.font.color.rgb = color
    return p


def bullet(text, bold_head=None):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.left_indent = Inches(0.25)
    if bold_head:
        r = p.add_run(bold_head)
        r.font.bold = True
        r.font.size = Pt(10)
    r = p.add_run(text)
    r.font.size = Pt(10)
    return p


def table(headers, rows, widths=None, red_col=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    for i, htxt in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ""
        _shade(c, HDR_BG)
        p = c.paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.space_before = Pt(2)
        r = p.add_run(htxt.upper())
        r.font.bold = True
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for ci, val in enumerate(row):
            c = cells[ci]
            c.text = ""
            if ri % 2 == 1:
                _shade(c, ZEBRA)
            p = c.paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            r = p.add_run(str(val))
            r.font.size = Pt(9)
            if ci == 0 or (red_col is not None and ci == red_col):
                r.font.bold = True
            if red_col is not None and ci == red_col:
                r.font.color.rgb = RED
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(0)
    return t


def callout(title, body, fill="FFF4F4"):
    t = doc.add_table(rows=1, cols=1)
    t.style = "Table Grid"
    c = t.rows[0].cells[0]
    c.text = ""
    _shade(c, fill)
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(1)
    r = p.add_run(title)
    r.font.bold = True
    r.font.size = Pt(9.5)
    r.font.color.rgb = INK
    p2 = c.add_paragraph()
    p2.paragraph_format.space_after = Pt(1)
    r2 = p2.add_run(body)
    r2.font.size = Pt(9)
    r2.font.color.rgb = INK
    doc.add_paragraph().paragraph_format.space_after = Pt(0)
    return t


# ======================= COVER =========================================
# Box art if it exists. There is none in the repo yet, so the cover degrades to
# the title rather than shipping a placeholder image — drop a PNG at this path
# and it appears on the next build.
BOX = os.path.join(HERE, "assets", "img", "boxes", "vidxir-box-single.png")
if os.path.exists(BOX):
    _p = doc.add_paragraph()
    _p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _p.paragraph_format.space_after = Pt(6)
    _p.add_run().add_picture(BOX, height=Inches(2.25))

h1("Vidxir AI — Official JV Doc")
para(
    "Everything you need to promote, on a few pages. Every price, date and rule below is "
    "confirmed unless it is marked TO CONFIRM — quote the confirmed ones freely.",
    size=10.5,
    color=MUTE,
)
para("Launch: Friday 23 October → Wednesday 28 October 2026 (all times US Eastern)",
     size=10.5, bold=True)
para("Cart opens 11:00 AM EDT on the 23rd and shuts 11:59 PM EDT on the 28th — a six-day window.",
     size=10, color=MUTE, after=10)

table(
    ["", "Detail"],
    [
        ["Product", "Vidxir AI — keyword in, finished YouTube video published out"],
        ["Positioning", "The faceless YouTube channel that runs itself — research, script, "
                        "voiceover, visuals, thumbnail and publish, in one dashboard"],
        ["Vendor", "Geecore Limited · sold on JVZoo"],
        ["Commission", "50% flat across the funnel — front end, all four OTOs, and every downsell"],
        ["Front end", "$37 one-time · OTO 1 Unlimited Bundle $497/year"],
        ["Contest", "$5,000 across two leaderboards"],
        ["Back end", "Credit top-up packs keep paying after the cart closes"],
        ["JV manager", "Goodluck Efe — Teams and Facebook links on the JV page"],
        ["Approval", "Manual on both products — request early, not on launch morning"],
    ],
    widths=[1.5, 5.5],
)

# ======================= 1. LINKS ======================================
h2("1. Links")
table(
    ["Resource", "Link"],
    [
        ["JV page", "/partners"],
        ["Join the JV list (launch updates by email)", "/partners/join.html"],
        ["This JV document", "Google Doc — link on the JV page"],
        ["Email swipes (all angles, all days)", "On the JV page, “Your promo desk”"],
        ["Banners, screenshots & demo video", "COMING SOON — announced on the JV page"],
        ["Affiliate link — front end ($37)", "TO CONFIRM — JVZoo product ID"],
        ["Affiliate link — Unlimited Bundle ($497/yr)", "TO CONFIRM — JVZoo product ID"],
        ["Partner support", "TO CONFIRM — inbox not final"],
        ["Vendor / legal", "admin@geecorelimited.com"],
    ],
    widths=[2.5, 4.5],
)
callout(
    "Two approvals, not one",
    "The front end and the Unlimited Bundle are separate JVZoo products with separate "
    "approvals. Request both — the JV page has a button for each. The front-end link carries "
    "all four OTOs and their downsells, so a single front-end sale can still pay you across "
    "the whole funnel.",
)

# ======================= 2. REVIEW ACCESS =============================
h2("2. Review Access")
para(
    "Review access is granted on request — there is no shared public login. Message Goodluck "
    "Efe on Teams or Facebook (links on the JV page) with your JVZoo ID and what you are "
    "producing — review video, webinar, bonus page — and we will set up a hands-on account. "
    "Ask before the 18th if you want it ready for day one.",
)
para("Contact: Goodluck Efe, founder and JV manager — Microsoft Teams and Facebook, both linked "
     "on the JV page.", size=9.5, color=MUTE)

# ======================= 3. AT A GLANCE ===============================
h2("3. Launch At A Glance")
table(
    ["What", "When", "Notes"],
    [
        ["Pre-launch opens", "Sun 18 Oct", "Swipes live — five days to warm your list"],
        ["Cart opens", "Fri 23 Oct · 11:00 AM", "Full funnel live, early-bird pricing. "
                                               "Opening contest starts"],
        ["Mid-launch push", "Sun 25 Oct · 11:00 AM", "Price step-up — switch to the urgency swipes"],
        ["Contest boards switch", "Mon 26 Oct · 11:59 PM", "Opening board ends, closing board "
                                                           "opens at midnight"],
        ["Last call", "Tue 27 Oct · 11:59 PM", "Final full day — your biggest mailing day"],
        ["Cart closes", "Wed 28 Oct · 11:59 PM", "The last minute of the 28th — not the 29th"],
    ],
    widths=[1.7, 1.8, 3.5],
)
callout(
    "The one scheduling mistake to avoid",
    "The cart shuts at 11:59 PM EDT on Wednesday 28 October — the last minute of the 28th. "
    "Anything scheduled for “the 29th” fires into a closed cart. Note also that this window "
    "opens on a Friday and closes midweek: the weekend falls on days 2 and 3, so your "
    "heaviest sends are the Friday open and the Wednesday close, not a Sunday night.",
)

# ======================= 4. WHAT IS IT ================================
h2("4. What Is Vidxir AI?")
para("The 30-second version for your emails:", bold=True, after=3)
para(
    "Your subscriber types a keyword. Vidxir AI researches the niche, writes the script, "
    "generates the voiceover, the visuals, the music and the captions, renders the video, "
    "designs the thumbnail — and publishes it to a real YouTube channel with the title, "
    "description and tags already written. No camera, no microphone, no face on screen, and "
    "no editing timeline. The buyer approves a script and the channel fills itself."
)
para("The two hooks that do the selling:", bold=True, after=3)
bullet(
    "— it does not stop at a video file. It publishes to an actual YouTube channel, which is "
    "the half of the promise most AI video tools never cover.",
    bold_head="It finishes the job ",
)
bullet(
    "— one screen recording is the entire pitch. Keyword in, finished video out. You do not "
    "have to explain the product; you show it.",
    bold_head="The demo sells itself ",
)
para("Quotable feature set:", bold=True, after=3)
para(
    "Niche research that finds the opportunity first · original scripts written for retention · "
    "AI voiceover, b-roll, music and burned-in captions · four video models from 720p to 4K · "
    "thumbnail design with A/B testing · continuity engine for characters that stay consistent "
    "across scenes · auto-publish and scheduling · cross-channel analytics · agency client "
    "workspaces · credit top-up packs."
)
para("The four video models:", bold=True, after=3)
table(
    ["Model", "Role", "Relative generation cost"],
    [
        ["Tal 1.0", "Fast model — drafts and volume", "1×"],
        ["Tal 2.0", "Creators model — the everyday default", "2×"],
        ["Tal 3.0", "Cinematic model", "4×"],
        ["Tal 3.1", "Ultra model — the top tier, up to 4K", "8×"],
    ],
    widths=[1.1, 3.6, 2.3],
)
para(
    "The cost column is the ratio between models, not a dollar figure — it is why the credit "
    "system exists and why the higher models sit in the paid tiers.",
    size=9, color=MUTE,
)
para("Primary audiences:", bold=True, after=3)
para(
    "Faceless YouTube channel builders · content creators and YouTubers · agencies and local "
    "video services · freelancers selling video to clients · software and IM buyers · anyone "
    "who wants a channel without appearing on camera."
)

# ======================= 5. FUNNEL ====================================
h2("5. Funnel & Commissions (50% Across The Board)")
para(
    "Five products plus three downsells. The same flat 50% on every one of them, including the "
    "downsells — nothing is clawed back at OTO level.",
    size=9.5, color=MUTE, after=6,
)
table(
    ["Tier", "Product", "Price", "Your 50%"],
    [
        ["FE", "Vidxir AI Commercial", "$37 one-time", "$18.50"],
        ["OTO 1", "Unlimited Bundle — best value, everything included", "$497 per year",
         "$248.50/yr"],
        ["OTO 2", "Vidxir AI Pro", "$97 one-time", "$48.50"],
        ["OTO 2 DS", "Vidxir AI Pro — downsell", "$67 one-time", "$33.50"],
        ["OTO 3", "Autopilot Engine", "$67 one-time", "$33.50"],
        ["OTO 3 DS", "Autopilot Engine — downsell", "$47 one-time", "$23.50"],
        ["OTO 4", "Agency & Reseller", "$197 one-time", "$98.50"],
        ["OTO 4 DS", "Agency & Reseller — downsell", "$147 one-time", "$73.50"],
    ],
    widths=[0.8, 3.4, 1.4, 1.4],
    red_col=3,
)
para(
    "JVZoo product IDs and the two affiliate request URLs are TO CONFIRM — they go on the JV "
    "page as soon as the products are live. Request the front end and the Bundle separately.",
    size=9.5, color=MUTE,
)

para("What each tier actually unlocks", bold=True, after=3)
table(
    ["Tier", "Channels / videos", "Credits per month", "Models", "The upgrade in one line"],
    [
        ["FE $37", "1 channel · 10 videos / mo", "300", "Tal 1.0 + 2.0, to 1080p",
         "Lifetime access with a commercial licence — sell what you make"],
        ["OTO 1 $497/yr", "Unlimited · unlimited", "10,000, resets monthly", "All four, to 4K",
         "Every OTO on the page included, in one decision"],
        ["OTO 2 $97", "3 channels · unlimited videos", "3,000", "Adds Tal 3.0 + 3.1, 4K",
         "Lifts the limits: 4K, thumbnail A/B testing, continuity engine"],
        ["OTO 3 $67", "—", "—", "—",
         "Full channel automation: auto-publish, scheduling, hands-off daily uploads"],
        ["OTO 4 $197", "10 client workspaces", "Per-client pools", "—",
         "Turns it into a service: client sub-logins, reseller licence, contracts"],
    ],
    widths=[1.0, 1.5, 1.1, 1.3, 2.1],
)

para("How credits work — know this before you mail", bold=True, after=3)
para(
    "Generation is metered in credits, because a cinematic 4K scene costs real provider money "
    "and a 720p one does not. Every tier gets a monthly allowance that resets each month; the "
    "Unlimited Bundle resets at 10,000. “Unlimited” on the Bundle means unlimited channels and "
    "unlimited videos — the generation inside them is still metered, and that is the honest way "
    "to write it. If a buyer burns through the allowance early and will not wait for the reset, "
    "top-up packs are one click away."
)
table(
    ["Top-up pack", "Price"],
    [
        ["100 credits", "$2"],
        ["500 credits", "$9"],
        ["1,000 credits", "$16"],
        ["2,500 credits", "$35"],
    ],
    widths=[2.0, 1.4],
)
callout(
    "Why the credit system matters to you",
    "Top-ups are the back end. A buyer who publishes daily comes back for credits long after "
    "launch week has closed — so the commission on a front-end sale is not the whole of what "
    "that buyer is worth to you. Confirm with us how top-up commission is tracked before you "
    "build a promo around it.",
)
callout(
    "Three things to get right in your promos",
    "1. Lead with the $37 front end. The Unlimited Bundle is presented straight after purchase "
    "and is where most of your commission will come from — $248.50 is the biggest single sale "
    "in this funnel.\n"
    "2. There are two honest paths, and the Bundle is cheaper than neither: $37 → $497 (one "
    "decision, everything unlocked), or $37 → $97 → $67 → $197 stacked individually ($398). "
    "Do not quote a “total funnel value” that adds the Bundle to the OTOs it already contains.\n"
    "3. The Bundle is annual and renews; everything else is one-time. Say so plainly. It is "
    "priced yearly because it resets 10,000 credits every month, and that is a recurring "
    "provider cost — which is also the answer to the objection.",
)

# ======================= 6. CONTEST ===================================
h2("6. JV Contest — $5,000 In Cash")
para("Two leaderboards, back to back. Solo entries only — no team pooling.", after=6)
table(
    ["Board", "Window (EDT)", "1st", "2nd", "3rd"],
    [
        ["Opening · $3,000", "Fri 23 Oct 11:00 AM → Mon 26 Oct 11:59 PM", "$2,000", "$700", "$300"],
        ["Closing · $2,000", "Tue 27 Oct 12:00 AM → Wed 28 Oct 11:59 PM", "$1,000", "$700", "$300"],
    ],
    widths=[1.4, 2.6, 0.9, 0.8, 0.8],
)
callout(
    "How you qualify — read before planning your promo",
    "A prize is capped by what you earn: your commissions must at least equal the prize you are "
    "claiming. Miss the threshold and you drop to the next prize down that you have cleared — "
    "you do not lose everything. Thresholds: $2,000 / $700 / $300 on the opening board, "
    "$1,000 / $700 / $300 on the closing board.\n"
    "Worked example: you finish 1st on the opening board with $1,450 in commissions. First "
    "prize is $2,000 and needs $2,000, so you do not take it in full — you drop to $700, the "
    "next prize you have cleared.",
)
para(
    "Contest cash is paid on top of your commission, never out of it. A send landing late on "
    "the 26th still counts for the opening board; one after midnight counts for the closing "
    "board. If you are near a threshold, that boundary decides it.",
    size=9.5, color=MUTE,
)

# ======================= 7. RECIPROCATION =============================
h2("7. Reciprocation — Our Record")
para(
    "You are being asked to mail for a product that has not launched before, so here is the "
    "record on the other side of that. Goodluck Efe has finished #1 on seven affiliate contest "
    "leaderboards, every one of them on another vendor's launch. Full screenshots of all seven "
    "are on the JV page under “Reciprocation”.",
)
table(
    ["Board", "Result", "Note"],
    [
        ["JVZoo · affiliate contest", "#1 — $3,000 won",
         "$6,227.00 in commissions against a $3,000 first prize. Second place did $4,211.00"],
        ["JVZoo · $1,500 first prize", "#1 of the podium",
         "Top of a $1,500 / $700 / $300 board"],
        ["JVZoo · $1,000 first prize", "#1 — $1,000 won",
         "Top of a $1,000 / $500 / $100 podium, ahead of six named affiliates"],
        ["JVZoo · live on mobile", "#1 — $700 won",
         "$1,612.90 earned. The dashboard as it looked on a phone"],
        ["DomainRack · main contest", "#1 of Top Affiliates",
         "Ahead of the vendor's own house affiliate"],
        ["MarketBooks AI · opening contest", "#1 of the board",
         "Commissions-only, solo entry — no team pooling, so the rank is one person's work"],
        ["Early Superstars · Advance AI", "#1 participant",
         "A contest whose own terms offered 2X reciprocation"],
    ],
    widths=[1.9, 1.3, 3.8],
)
callout(
    "What those boards do and don't commit us to",
    "They show capability, not a promise. Seven #1 finishes on other vendors' launches is "
    "evidence that the list behind this launch performs when it mails — which is the fair "
    "question to ask about a first launch. It is not, by itself, a reciprocation commitment.\n"
    "Reciprocation is agreed per partner, in writing, by date. Message Goodluck with your launch "
    "date and what you need and you get a specific answer — a date we can commit to, or a "
    "straight no — before you commit a send to us. Nothing here is an offer of a reciprocal mail "
    "until you have that reply, and we will never quote you a number.",
)

# ======================= 8. MAILING PLAN ==============================
h2("8. Copy-Paste Mailing Plan")
para("Anchor times are fixed. Everything between them is a recommendation — bend it to your list.",
     size=9.5, color=MUTE, after=6)
table(
    ["When", "What to mail", "Swipe"],
    [
        ["18–19 Oct", "The category — faceless YouTube, no link, no pitch", "Pre-launch 01"],
        ["20–21 Oct", "The problem — why channels stall at editing", "Pre-launch 02"],
        ["22 Oct", "The announcement — tomorrow, 11:00 AM", "Pre-launch 03"],
        ["23 Oct, within 2 hrs of 11 AM", "Cart open — lead with the demo", "Email 01"],
        ["23 Oct evening", "Story / personal send", "Email 02"],
        ["24 Oct", "The “no camera, no mic, no face” angle", "Email 03"],
        ["25 Oct", "Price step-up — the mid-launch push", "Email 04"],
        ["25 Oct evening", "Demo walkthrough — show, do not describe", "Email 05"],
        ["26 Oct", "Bundle value · one payment vs a monthly stack", "Email 06"],
        ["26 Oct, before 11:59 PM", "Opening contest closes — your hardest send of the first half",
         "Resend 06"],
        ["27 Oct", "Objections — answer them straight", "Email 07"],
        ["28 Oct morning", "Close — the cart shuts tonight", "Email 08"],
        ["28 Oct, 3–4 hrs out", "Final hours (optional)", "Email 09"],
    ],
    widths=[1.9, 3.5, 1.2],
)
para("Pre-written swipes for every angle and every launch day are on the JV page under "
     "“Your promo desk”.", size=9.5, color=MUTE)

# ======================= 9. ANGLES ====================================
h2("9. Promo Angles (Rotate Across The Week)")
table(
    ["Angle", "Best for", "The line that sells it"],
    [
        ["Keyword in, video out", "Everyone — the opener",
         "One screen recording is the whole pitch. A keyword goes in; a finished, published "
         "YouTube video comes out."],
        ["No camera, no mic, no face", "Creators who will not go on camera",
         "The biggest reason people never start a channel is being on screen. This removes it "
         "entirely."],
        ["It publishes, it does not just render", "People who have tried AI video tools",
         "Every other tool hands back a file. This one hands back a published video with the "
         "title, description, tags and thumbnail already done."],
        ["The editing bottleneck", "Channel builders who have stalled",
         "Scripting and editing is where channels die. Research, script, voice, visuals and "
         "thumbnail all happen in one pass."],
        ["Sell it as a service", "Agencies, freelancers, local video",
         "Ten client workspaces, separated data, per-client reporting and a reseller licence. "
         "The $197 turns the tool into a business."],
        ["Set it and walk away", "Busy lists, passive-income angle",
         "Autopilot publishes on a cadence you set. The channel keeps filling while the buyer "
         "does nothing."],
    ],
    widths=[1.5, 1.5, 4.0],
)

# ======================= 10. CLAIMS ====================================
h2("10. Claim Rules — Read Before You Write")
para("Confirmed and quotable", bold=True, after=3)
para(
    "The $37 front end and the $497/year Bundle · every OTO and downsell price · the flat 50% "
    "across all of them · the $5,000 prize pool and both boards' thresholds · the six-day "
    "window, 23–28 October · the four video models and the 720p–4K range · the per-tier credit "
    "allowances (300 / 3,000 / 10,000) · the monthly credit reset · the top-up pack prices · "
    "publishing to a real YouTube channel · thumbnail A/B testing · the continuity engine · "
    "agency client workspaces."
)
para("Do not state as fact", bold=True, after=3)
bullet("— this is a first launch, so none exists. Do not invent or estimate one.",
       bold_head="Any EPC, conversion or refund-rate figure ")
bullet("— for buyers or for yourself. The 50% and the $5,000 are confirmed facts; a prediction "
       "of what you will earn from either is still an income claim.",
       bold_head="Any earnings outcome ")
bullet("— the window is not confirmed yet. Leave refunds out of your copy until it is, and then "
       "match the sales page wording exactly.",
       bold_head="A money-back guarantee of any specific length ")
bullet("— the Bundle gives unlimited channels and unlimited videos, and a 10,000-credit monthly "
       "reset. Generation is metered. Writing it as limitless generation is a refund waiting to "
       "happen.", bold_head="“Unlimited everything” on the Bundle ")
bullet("— Vidxir AI publishes to YouTube through the official API. It is not a Google or YouTube "
       "product and is not endorsed by either.",
       bold_head="Any suggestion of a YouTube or Google partnership ")
bullet("— no tool can promise that. Do not imply views, subscribers, watch time or monetisation.",
       bold_head="Guaranteed views, growth or monetisation ")
callout(
    "The wording that is accurate and still sells",
    "“Unlimited channels and unlimited videos, with 10,000 generation credits that reset every "
    "month” — not “unlimited everything”. The first is accurate, sets the buyer's expectation "
    "correctly, and still reads as the biggest offer on the page.",
)

# ======================= 11. BONUS IDEAS ==============================
h2("11. Bonus Ideas For Your Promo")
para("Bonuses that fill gaps rather than duplicate OTO features — overlapping an OTO kills "
     "funnel take rates and your own commissions.", size=9.5, color=MUTE, after=4)
bullet("— your picks, two lines of reasoning each. Thirty minutes of work, reads as insider "
       "intel.", bold_head="“My 10 highest-RPM faceless niches” cheat sheet ")
bullet("— the thing buyers stall on after the videos start working.",
       bold_head="A YouTube monetisation checklist ")
bullet("— the decision buyers freeze on. Huge perceived value, one hour of your time.",
       bold_head="A live “pick your first channel with me” session ")
bullet("— thumbnail and channel-art templates that complement the built-in designer rather "
       "than replacing it.", bold_head="A Canva pack for channel branding ")
bullet("— announce it, then send buyers your weekly numbers. Zero work upfront, and it builds "
       "the proof for your next promo.", bold_head="Your own 30-day channel case study ")
para("Deliver via JVZoo's bonus system so it attaches to your link automatically. Clear your "
     "bonus plan with us before you build it.", size=9.5, color=MUTE)

# ======================= 12. RULES ====================================
h2("12. Rules, Approval & Contact")
bullet("No negative PPC on brand terms. No cookie stuffing. No spam. No buying through your "
       "own link.")
bullet("FTC compliance: disclose your affiliate relationship on every email, post and page.")
bullet("No income claims anywhere — for buyers or for yourself. See section 10.")
bullet("Commissions: 50% flat on the front end, all four OTOs and every downsell, paid on "
       "JVZoo's standard schedule.")
bullet("Contest minimums: your commissions must at least equal the prize you are claiming.")
bullet("Approval is manual on both products. Request the front end and the Bundle separately, "
       "and request early — not on launch morning.")
para("Contact", bold=True, after=3)
para("Goodluck Efe — founder and JV manager. Microsoft Teams and Facebook links are on the JV "
     "page, and both go straight to him.")
para("Vendor: Geecore Limited · admin@geecorelimited.com", size=9.5, color=MUTE)

# ======================= 13. OPEN ITEMS ===============================
h2("13. Still To Be Confirmed")
para(
    "Three items are not final. They are listed here rather than guessed at, because an "
    "affiliate quoting a figure the launch has not committed to is the one mistake this "
    "document exists to prevent.",
    size=9.5, color=MUTE, after=6,
)
table(
    ["Item", "Status"],
    [
        ["JVZoo product IDs and the two affiliate request URLs",
         "Published on the JV page as soon as the products go live"],
        ["Partner support inbox", "Not final — use the Teams or Facebook link meanwhile"],
        ["Refund window", "Not confirmed. Leave it out of your copy until it is"],
    ],
    widths=[2.8, 4.2],
)

# ---- footer disclaimer ------------------------------------------------
doc.add_paragraph()
para(
    "Earnings disclaimer. Nothing in this document is a promise or projection of affiliate "
    "earnings. This is a first launch: no EPC, conversion rate, refund rate or affiliate income "
    "figure is quoted anywhere, because none exists yet. Results depend on your list, your "
    "traffic and your promotion — including earning nothing. Vidxir AI is sold through JVZoo, a "
    "marketplace platform that is not the seller of this product; the contract for any purchase "
    "is between the buyer and Geecore Limited. Vidxir AI is an independent product and is not "
    "affiliated with, sponsored by or endorsed by YouTube, Google or any other platform named "
    "here; YouTube is a trademark of Google LLC.",
    size=7.5,
    color=MUTE,
)
para("© 2026 Vidxir AI · Geecore Limited · Official JV Doc · 23–28 October 2026",
     size=7.5, color=MUTE)

out = os.path.join(HERE, "Vidxir AI - Official JV Doc.docx")
doc.save(out)
print("saved:", out)

# Puts the screenshots from scripts/phone-walkthrough.sh side by side, one
# picture per journey, so a whole flow can be read at a glance. Run after the
# walkthrough: python3 scripts/phone-strips.py
from PIL import Image, ImageDraw, ImageFont
import os

SRC = "phone-screens"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
W = 520           # width of each phone in the strip
GAP = 34
PAD = 36
CAP = 86          # caption band above each phone
INK = (27, 27, 27)
MUTED = (90, 90, 90)
PAPER = (244, 244, 242)
LINE = (210, 210, 206)

groups = [
    ("journey-1-move-airtime", "Moving airtime: MTN to Airtel", [
        ("01-home.png", "1. The page"),
        ("02-quote-form-filled.png", "2. Who it goes to"),
        ("03-what-to-dial.png", "3. What to dial"),
        ("04-airtime-received.png", "4. It landed"),
        ("05-transfer-done.png", "5. Delivered"),
    ]),
    ("journey-2-buy-from-us", "Buying airtime from us", [
        ("06-buy-form.png", "1. Choose"),
        ("07-how-to-pay.png", "2. Pay"),
        ("08-order-delivered.png", "3. Delivered"),
    ]),
    ("journey-3-sell-to-us", "Selling to us, then spending the credit", [
        ("09-sell-rates.png", "1. What we pay"),
        ("10-what-to-send-us.png", "2. Send it to us"),
        ("11-credit-code.png", "3. Your credit code"),
        ("12-paying-with-credit.png", "4. Spending it"),
        ("13-credit-spent.png", "5. Bought with credit"),
    ]),
    ("journey-4-agent-shop", "An agent's shop", [
        ("14-agent-wallet.png", "1. Wallet"),
        ("15-agent-buys-for-many.png", "2. A queue of customers"),
        ("16-agent-list-bought.png", "3. All of them bought"),
        ("17-agent-statement.png", "4. Statement"),
    ]),
    ("journey-5-command-centre", "The command centre, on the same phone", [
        ("18-command-centre.png", "1. Overview"),
        ("19-command-centre-buying-back.png", "2. Buying back"),
    ]),
]

title_font = ImageFont.truetype(FONT, 34)
cap_font = ImageFont.truetype(FONT, 26)
foot_font = ImageFont.truetype(FONT_R, 20)

for name, title, shots in groups:
    images = []
    for file, label in shots:
        im = Image.open(os.path.join(SRC, file)).convert("RGB")
        h = round(im.height * W / im.width)
        images.append((im.resize((W, h), Image.LANCZOS), label))
    tall = max(im.height for im, _ in images)
    width = PAD * 2 + W * len(images) + GAP * (len(images) - 1)
    height = PAD + 54 + CAP + tall + PAD
    canvas = Image.new("RGB", (width, height), PAPER)
    d = ImageDraw.Draw(canvas)
    d.text((PAD, PAD - 4), title, font=title_font, fill=INK)
    d.line([(PAD, PAD + 46), (width - PAD, PAD + 46)], fill=LINE, width=2)
    x = PAD
    for im, label in images:
        y = PAD + 54
        d.text((x, y + 20), label, font=cap_font, fill=MUTED)
        top = y + CAP
        canvas.paste(im, (x, top))
        d.rectangle([x - 1, top - 1, x + W, top + im.height], outline=LINE, width=2)
        x += W + GAP
    canvas.save(os.path.join(SRC, f"{name}.png"))
    print(f"{SRC}/{name}.png  {width}x{height}")

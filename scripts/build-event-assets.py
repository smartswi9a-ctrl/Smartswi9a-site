"""Genere les visuels saisonniers du hero et les cadres transparents.

SOURCES (Bureau Windows, non versionnees) :
    %USERPROFILE%/Desktop/newphoto.webp
    %USERPROFILE%/Desktop/smartswika-hero-events/hero-*.png
    %USERPROFILE%/Desktop/cadres/Cadre*.png

SORTIES (assets/ versionnes, servis par Cloudflare Pages) :
    newphoto.webp
    hero-<event>.webp   2179x722 (ratio exact de newphoto.webp), qualite 85
    frame-<event>.webp  fond blanc rendu transparent, qualite 85

DETOURAGE DES CADRES
    Le blanc est retire par flood fill depuis les 4 coins ET depuis le
    centre : le trou central et l'exterieur deviennent transparents, mais
    les details blancs ILLUSTRES (neige, perles, lampes) sont conserves
    car ils ne sont pas connectes au fond. Un anneau de 2 px est degrade
    pour eviter tout liseré blanc sur les bords.

USAGE
    python scripts/build-event-assets.py
"""

from PIL import Image, ImageChops, ImageDraw, ImageFilter
import os
import shutil
import sys
import time

HOME = os.path.expanduser("~")
DESKTOP = os.path.join(HOME, "Desktop")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
HERO_SRC = os.path.join(DESKTOP, "smartswika-hero-events")
FRAMES_SRC = os.path.join(DESKTOP, "cadres")

TARGET_W, TARGET_H = 2179, 722
# Budget LCP : les heros restent sous 260 Ko (garde-fou du test).
# Les cadres sont livres en qualite 85 % (demande client).
HERO_QUALITY = 75
FRAME_QUALITY = 85
WHITE_THRESHOLD = 238
SOFT_FLOOR = 200

HEROES = {
    "christmas": "hero-christmas.png",
    "winter-sales": "hero-winter-sales.png",
    "ramadan": "hero-ramadan.png",
    "eid-fitr": "hero-eid-fitr.png",
    "eid-adha": "hero-eid-adha.png",
    "summer-sales": "hero-summer-sales.png",
    "back-to-school": "hero-back-to-school.png",
    "black-friday": "hero-black-friday.png",
}

FRAMES = {
    "christmas": "Cadre de No\u00ebl festif aux poinsettias rouges.png",
    "winter-sales": "Cadre hivernal tricot\u00e9 et enneig\u00e9.png",
    "ramadan": "Cadre Ramadan luxueux bleu et or.png",
    "eid-fitr": "Cadre de f\u00eate Eid aux lanternes dor\u00e9es.png",
    "eid-adha": "Cadre d\u2019Eid marocain \u00e9l\u00e9gant.png",
    "summer-sales": "Cadre tropical color\u00e9 pour vacances estivales.png",
    "back-to-school": "Cadre \u00e9ducatif bleu et jaune.png",
    "black-friday": "Cadre promotionnel Black Friday luxueux.png",
}


def min_channel(rgb):
    r, g, b = rgb.split()
    return ImageChops.darker(ImageChops.darker(r, g), b)


def white_to_alpha(src_path):
    """Renvoie un RGBA dont le fond blanc interieur + exterieur est transparent."""
    rgb = Image.open(src_path).convert("RGB")
    w, h = rgb.size
    minc = min_channel(rgb)

    mask = minc.point(lambda v: 255 if v >= WHITE_THRESHOLD else 0, mode="L")
    for seed in [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2), (w // 2, h // 2)]:
        if mask.getpixel(seed) == 255:
            ImageDraw.floodfill(mask, seed, 128, thresh=0)

    core = mask.point(lambda v: 255 if v == 128 else 0, mode="L")
    ring = ImageChops.subtract(core.filter(ImageFilter.MaxFilter(5)), core)

    def ring_alpha(v):
        if v >= WHITE_THRESHOLD:
            return 0
        if v <= SOFT_FLOOR:
            return 255
        return int(round((WHITE_THRESHOLD - v) * 255 / (WHITE_THRESHOLD - SOFT_FLOOR)))

    ring_values = minc.point([ring_alpha(v) for v in range(256)], mode="L")

    alpha = Image.new("L", (w, h), 255)
    alpha.paste(0, mask=core)
    alpha.paste(ring_values, mask=ring)

    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def process_heroes():
    os.makedirs(ASSETS, exist_ok=True)
    for event_id, filename in HEROES.items():
        src = os.path.join(HERO_SRC, filename)
        dst = os.path.join(ASSETS, f"hero-{event_id}.webp")
        t0 = time.time()
        im = Image.open(src).convert("RGB").resize((TARGET_W, TARGET_H), Image.LANCZOS)
        im.save(dst, "WEBP", quality=HERO_QUALITY, method=6)
        print(f"hero-{event_id}.webp  {im.size}  {os.path.getsize(dst) // 1024} Ko  ({time.time() - t0:.1f}s)")


def process_frames():
    os.makedirs(ASSETS, exist_ok=True)
    for event_id, filename in FRAMES.items():
        src = os.path.join(FRAMES_SRC, filename)
        if not os.path.exists(src):
            print("CADRE INTROUVABLE:", src)
            continue
        t0 = time.time()
        frame = white_to_alpha(src)
        dst = os.path.join(ASSETS, f"frame-{event_id}.webp")
        frame.save(dst, "WEBP", quality=FRAME_QUALITY, method=6)
        print(f"frame-{event_id}.webp  {frame.size}  {os.path.getsize(dst) // 1024} Ko  ({time.time() - t0:.1f}s)")


def main():
    newphoto = os.path.join(DESKTOP, "newphoto.webp")
    if os.path.exists(newphoto):
        shutil.copy2(newphoto, os.path.join(ASSETS, "newphoto.webp"))
        print("newphoto.webp copie")
    process_heroes()
    process_frames()


if __name__ == "__main__":
    if not os.path.isdir(HERO_SRC) or not os.path.isdir(FRAMES_SRC):
        sys.exit("Dossiers sources introuvables sur le Bureau Windows.")
    main()

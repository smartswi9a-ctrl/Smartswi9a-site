"""Genere les bannieres saisonnieres encadrees et les cadres transparents.

PRINCIPE (demande client du 2026-11-20)
    La photo ne doit JAMAIS etre recouverte par le cadre. Chaque banniere
    d'evenement est donc un COMPOSITE :
      - fond : version floue/assombrie de la photo (remplit les coins) ;
      - centre : la photo entiere, nette, dans une fenetre rectangulaire ;
      - cadre : le cadre transparent, etire au format panoramique, dont on
        vide la fenetre centrale (aucun pixel du cadre sur la photo).
    Le cadre reste donc strictement a l'exterieur de la photo, dans les
    limites de la banniere : aucun debordement sur le bandeau Koulchi, les
    boutons ou les sections voisines.

SOURCES (Bureau Windows, non versionnees) :
    %USERPROFILE%/Desktop/newphoto.webp
    %USERPROFILE%/Desktop/smartswika-hero-events/*.png
    %USERPROFILE%/Desktop/cadres/Cadre*.png

SORTIES (assets/ versionnes, servis par Cloudflare Pages) :
    newphoto.webp
    hero-<event>.webp   2179x818 : photo + cadre, qualite 80
    frame-<event>.webp  1672x941 : cadre detoure (fond blanc transparent), q85

DETOURAGE DES CADRES
    Le blanc est retire par flood fill depuis les 4 coins ET depuis le
    centre : le trou central et l'exterieur deviennent transparents, mais
    les details blancs ILLUSTRES (neige, perles, lampes) sont conserves
    car ils ne sont pas connectes au fond. Un anneau de 2 px est degrade
    pour eviter tout liseré blanc sur les bords.

USAGE
    python scripts/build-event-assets.py
"""

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter
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

# Banniere encadree : format 2.664 (photo 3:1 + cadre autour).
TARGET_W, TARGET_H = 2179, 818
PHOTO_MARGIN_X = 0.09   # bord gauche/droit du cadre (part de la largeur)
PHOTO_MARGIN_Y = 0.138  # bord haut/bas du cadre (part de la hauteur)
PHOTO_W = int(TARGET_W * (1 - 2 * PHOTO_MARGIN_X))
PHOTO_H = int(TARGET_H * (1 - 2 * PHOTO_MARGIN_Y))
PHOTO_X = (TARGET_W - PHOTO_W) // 2
PHOTO_Y = (TARGET_H - PHOTO_H) // 2

HERO_QUALITY = 80
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
    "salon-marocain-11-11": "Salon marocain connect\u00e9 en promotion.png",
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
    "salon-marocain-11-11": "Cadre promotionnel violet et or 11.11.png",
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

def cover(im, w, h):
    """Redimensionne/recadre pour remplir exactement w x h (fond flou)."""
    scale = max(w / im.width, h / im.height)
    resized = im.resize(
        (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
        Image.LANCZOS,
    )
    x = (resized.width - w) // 2
    y = (resized.height - h) // 2
    return resized.crop((x, y, x + w, y + h))


def contain(im, w, h):
    """Reduit sans jamais recadrer : la photo reste entierement visible."""
    scale = min(w / im.width, h / im.height)
    return im.resize(
        (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
        Image.LANCZOS,
    )


def compose_framed_hero(hero_path, frame_rgba):
    """Photo entiere au centre + cadre uniquement sur les bords."""
    hero = Image.open(hero_path).convert("RGB")

    # Fond : flou sombre de la photo, pour habiller les coins du cadre.
    bg = cover(hero, TARGET_W, TARGET_H).filter(ImageFilter.GaussianBlur(22))
    bg = ImageEnhance.Brightness(bg).enhance(0.62)

    # Photo nette, entiere, centree dans la fenetre.
    photo = contain(hero, PHOTO_W, PHOTO_H)
    px = PHOTO_X + (PHOTO_W - photo.width) // 2
    py = PHOTO_Y + (PHOTO_H - photo.height) // 2
    bg.paste(photo, (px, py))

    # Cadre etire au format de la banniere, puis fenetre centrale vidée :
    # aucun pixel du cadre ne recouvre la photo.
    frame = frame_rgba.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    alpha = frame.getchannel("A")
    ImageDraw.Draw(alpha).rectangle(
        [PHOTO_X, PHOTO_Y, PHOTO_X + PHOTO_W - 1, PHOTO_Y + PHOTO_H - 1],
        fill=0,
    )
    frame.putalpha(alpha)

    out = bg.convert("RGBA")
    out.alpha_composite(frame)
    return out.convert("RGB")

def main():
    os.makedirs(ASSETS, exist_ok=True)

    newphoto = os.path.join(DESKTOP, "newphoto.webp")
    if os.path.exists(newphoto):
        shutil.copy2(newphoto, os.path.join(ASSETS, "newphoto.webp"))
        print("newphoto.webp copie")

    for event_id, hero_name in HEROES.items():
        t0 = time.time()
        frame_src = os.path.join(FRAMES_SRC, FRAMES[event_id])
        hero_src = os.path.join(HERO_SRC, hero_name)
        if not os.path.exists(frame_src):
            print("CADRE INTROUVABLE:", frame_src)
            continue
        if not os.path.exists(hero_src):
            print("HERO INTROUVABLE:", hero_src)
            continue

        frame = white_to_alpha(frame_src)
        frame_dst = os.path.join(ASSETS, f"frame-{event_id}.webp")
        frame.save(frame_dst, "WEBP", quality=FRAME_QUALITY, method=6)

        hero = compose_framed_hero(hero_src, frame)
        hero_dst = os.path.join(ASSETS, f"hero-{event_id}.webp")
        hero.save(hero_dst, "WEBP", quality=HERO_QUALITY, method=6)

        print(
            f"{event_id}: hero {hero.size} {os.path.getsize(hero_dst) // 1024} Ko | "
            f"frame {frame.size} {os.path.getsize(frame_dst) // 1024} Ko ({time.time() - t0:.1f}s)"
        )


if __name__ == "__main__":
    if not os.path.isdir(HERO_SRC) or not os.path.isdir(FRAMES_SRC):
        sys.exit("Dossiers sources introuvables sur le Bureau Windows.")
    main()




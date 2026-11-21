"""Genere les bannieres saisonnieres encadrees et les cadres transparents.

PRINCIPE (demande client du 2026-11-20)
    Rien ne doit etre superpose : la photo et le cadre sont deux objets
    distincts, avec une marge visible entre eux.
      - banniere : ancienne taille de newphoto, 2179x722 ;
      - photo : 60 % de la banniere, entiere, centree ;
      - cadre : 80 % x 90 %, centre autour de la photo ;
      - fenetre de securite : photo + 20 px, videe dans le cadre.
    Le cadre ne recouvre jamais la photo, la photo ne touche jamais le
    cadre, et le tout reste dans les limites de la banniere (aucun
    debordement sur le bandeau Koulchi, les boutons ou les sections).

SOURCES (Bureau Windows, non versionnees) :
    %USERPROFILE%/Desktop/newphoto.webp
    %USERPROFILE%/Desktop/smartswika-hero-events/*.png
    %USERPROFILE%/Desktop/cadres/Cadre*.png

SORTIES (assets/ versionnes, servis par Cloudflare Pages) :
    newphoto.webp
    hero-<event>.webp   2179x722 : photo 60 % + cadre 80 % x 90 %, q80
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

# Banniere : on CONSERVE l'ancienne taille de newphoto (2179x722).
# La photo occupe 60 % de la banniere, le cadre 80 % x 90 %, avec une
# marge visible entre les deux : rien n'est superpose.
TARGET_W, TARGET_H = 2179, 722
PHOTO_SCALE = 0.60
FRAME_SCALE_X = 0.80
FRAME_SCALE_Y = 0.90
MASK_GAP = 20

PHOTO_W = int(TARGET_W * PHOTO_SCALE)
PHOTO_H = int(TARGET_H * PHOTO_SCALE)
PHOTO_X = (TARGET_W - PHOTO_W) // 2
PHOTO_Y = (TARGET_H - PHOTO_H) // 2

FRAME_W = int(TARGET_W * FRAME_SCALE_X)
FRAME_H = int(TARGET_H * FRAME_SCALE_Y)
FRAME_X = (TARGET_W - FRAME_W) // 2
FRAME_Y = (TARGET_H - FRAME_H) // 2

BACKGROUND = (248, 246, 242)  # fond de page Smartswika

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
    """Photo 60 % au centre, cadre 80 % x 90 % autour, marge visible."""
    hero = Image.open(hero_path).convert("RGB")

    # Fond uni Smartswika : ni flou, ni photo derriere le cadre.
    bg = Image.new("RGB", (TARGET_W, TARGET_H), BACKGROUND)

    # Photo entiere, reduite a 60 % de la banniere, centree.
    photo = contain(hero, PHOTO_W, PHOTO_H)
    px = PHOTO_X + (PHOTO_W - photo.width) // 2
    py = PHOTO_Y + (PHOTO_H - photo.height) // 2
    bg.paste(photo, (px, py))

    # Cadre 80 % x 90 %, centre, pose sur un calque transparent.
    layer = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
    frame = frame_rgba.resize((FRAME_W, FRAME_H), Image.LANCZOS)
    layer.paste(frame, (FRAME_X, FRAME_Y))

    # Fenetre de securite = photo + 20 px de marge : le cadre y est vide.
    # La photo ne touche donc jamais le cadre, et le cadre ne la recouvre pas.
    alpha = layer.getchannel("A")
    sx = max(0, px - MASK_GAP)
    sy = max(0, py - MASK_GAP)
    ex = min(TARGET_W - 1, px + photo.width + MASK_GAP - 1)
    ey = min(TARGET_H - 1, py + photo.height + MASK_GAP - 1)
    ImageDraw.Draw(alpha).rectangle([sx, sy, ex, ey], fill=0)
    layer.putalpha(alpha)

    out = bg.convert("RGBA")
    out.alpha_composite(layer)
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




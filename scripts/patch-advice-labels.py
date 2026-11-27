# -*- coding: utf-8 -*-
"""Patch FR/EN/AR labels: WhatsApp ordering -> advice; add checkout login key."""
import io
import sys

FILES_TR = ["translations.js", "translations.72210d87.js"]

TR = [
    ('btnGhost: "Une question ? WhatsApp"', 'btnGhost: "Demander un conseil"'),
    ('btnGhost: "سؤال؟ راسلنا على واتساب"', 'btnGhost: "اطلب نصيحة"'),
    ('btnGhost: "A question? WhatsApp us"', 'btnGhost: "Ask for advice"'),
    (
        'loginRequired: "Connectez-vous d\'abord",',
        'loginRequired: "Connectez-vous d\'abord",\n'
        '      loginRequiredCheckout: "Connectez-vous ou cr\u00e9ez un compte client pour finaliser votre commande.",',
    ),
    (
        'loginRequired: "الرجاء تسجيل الدخول أولاً",',
        'loginRequired: "الرجاء تسجيل الدخول أولاً",\n'
        '      loginRequiredCheckout: "سجّل الدخول أو أنشئ حسابًا لتأكيد طلبك.",',
    ),
    (
        'loginRequired: "Please log in first",',
        'loginRequired: "Please log in first",\n'
        '      loginRequiredCheckout: "Log in or create a customer account to complete your order.",',
    ),
]

SHOP = [
    ('shopWhatsApp: "Commander WhatsApp"', 'shopWhatsApp: "Demander un conseil"'),
    ('shopWhatsApp: "Order on WhatsApp"', 'shopWhatsApp: "Ask for advice"'),
    ('shopWhatsApp: "اطلب عبر واتساب"', 'shopWhatsApp: "اطلب نصيحة"'),
]


def patch(path, pairs):
    with io.open(path, encoding="utf-8") as fh:
        text = fh.read()
    for old, new in pairs:
        count = text.count(old)
        if count != 1:
            print("  !! %s : %d occurrence(s) de %r" % (path, count, old[:40]))
            continue
        text = text.replace(old, new)
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print("  patched", path)


for f in FILES_TR:
    patch(f, TR)
patch("js/shop-i18n.js", SHOP)
print("done")

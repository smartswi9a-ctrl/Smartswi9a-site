# -*- coding: utf-8 -*-
"""Bump cache versions after the 2026-11-27 changes."""
import io
import os
import re

def patch(path, pairs, must=True):
    with io.open(path, encoding="utf-8") as fh:
        text = fh.read()
    changed = 0
    for old, new in pairs:
        n = text.count(old)
        if n:
            text = text.replace(old, new)
            changed += n
        elif must:
            print("  ! absent dans %s : %r" % (path, old[:50]))
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print("  %s : %d remplacement(s)" % (path, changed))

# 1. Service Worker : purge des anciens caches
patch("firebase-messaging-sw.js", [("sw-2026-11-26-v13", "sw-2026-11-27-v14")])

# 2. Tests qui figent les versions
for t in ("tests/ads-automation.test.cjs", "tests/abandoned-cart.test.cjs"):
    if os.path.exists(t):
        patch(t, [("sw-2026-11-26-v13", "sw-2026-11-27-v14"),
                  ("gallery2026c", "gallery2026d")])

# 3. Admin : nouveau hash du module
patch("admin.html", [("v=gallery2026c", "v=gallery2026d")])
patch("tests/ads-attribution.test.cjs", [("gallery2026c", "gallery2026d")])

# 4. Vendeur : CSS sidebar
patch("vendor/dashboard.html", [("vendor-ui.css?v=1", "vendor-ui.css?v=2")])

# 5. Panier : module modifie -> query de version
patch("panier.html", [('/js/panier.js"', '/js/panier.js?v=advice2026"')])

print("done")

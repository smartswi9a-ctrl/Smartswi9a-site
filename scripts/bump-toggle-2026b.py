# -*- coding: utf-8 -*-
"""Unique cache version toggle2026b everywhere (edge cache safe)."""
import io

FILES = [
    "admin.html", "vendor/dashboard.html",
    "tests/abandoned-cart.test.cjs", "tests/ads-attribution.test.cjs",
    "tests/ads-automation.test.cjs", "tests/vendor-ui.test.cjs",
]

for path in FILES:
    with io.open(path, encoding="utf-8") as fh:
        text = fh.read()
    n = text.count("toggle2026")
    if not n:
        print("  ! aucun toggle2026 dans", path)
        continue
    text = text.replace("toggle2026b", "toggle2026")  # idempotence
    text = text.replace("toggle2026", "toggle2026b")
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    print("  %s : %d" % (path, n))
print("done")
